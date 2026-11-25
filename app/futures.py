"""Futures for one body: a Monte Carlo of its own growth regimes, partly pooled with bodies like it.

Countries: real GDP per person (constant US$, so currency swings are out). Companies: share of the S&P 500's value.
Each step's move falls into one of five regimes (crisis ... boom, by the pooled quantiles of all moves). The chance of
the next regime comes from a transition table that blends the body's own history with the table of every body in the
same size class ("own history <-> bodies like it", Quah 1993; partial pooling, because one country has only about 65
moves). The move itself is a real past move drawn from that regime. Perturbations:
  vol      each move spread around the mean move (1.1 = 10% more volatile; the trend stays)
  persist  the table mixed toward "stay in the same regime" (+0.1 = spells last longer) or toward "any regime" (-)
  drift    added to every move (log units per step)
  window   learn only from the last N steps
The baseline and the scenario use the same random numbers, so their difference is the scenario, not noise.
The backtest runs the method from many past starting years on every body, scores it (CRPS, 80% band coverage) for each
blend of own history, against "no change", and gives the blend to use and how much to widen the band."""
import math
import time

import numpy as np

from . import forcerun as FR

NB = 5
QB = [0.1, 0.3, 0.7, 0.9]                                 # regime cut points (pooled move quantiles)
REG = {"countries": ["crisis", "slow", "normal", "fast", "boom"],
       "companies": ["falling hard", "slipping", "steady", "gaining", "surging"]}
CLS = {"countries": ["poorest fifth", "lower-middle fifth", "middle fifth", "upper-middle fifth", "richest fifth"],
       "companies": ["smallest fifth", "small", "middle", "large", "largest fifth"]}
H_BT = {"countries": 5, "companies": 12}
WS = [0.0, 0.25, 0.5, 0.75, 1.0]


def level(W):
    """The quantity simulated, its name and unit."""
    if W["world"] == "countries":
        ex = W["extra"]
        with np.errstate(all="ignore"):
            L = ex["real"] / ex["pop"]
        return np.where(L > 0, L, np.nan), "real GDP per person (constant 2015 US$)", "$"
    # share of a chain-linked index: each month's index change is measured on the members present in both months,
    # so a month with missing sizes does not move everyone's share
    size = np.where(W["member"] & (W["size"] > 0), W["size"], np.nan)
    N, T = size.shape
    I = np.zeros(T)
    for t in range(1, T):
        both = np.isfinite(size[:, t]) & np.isfinite(size[:, t - 1])
        I[t] = I[t - 1] + (math.log(size[both, t].sum() / size[both, t - 1].sum()) if both.sum() >= 20 else 0.0)
    tot = math.log(np.nansum(size[:, -1])) - I[-1]          # anchored so the last month is the real share
    with np.errstate(all="ignore"):
        L = np.exp(np.log(size) - I[None, :] - tot)
    return np.where(L > 0, L, np.nan), "share of the S&P 500's total value", "share"


class Tables:
    """Regime tables learned from moves that end at or before step t_hi (and start at or after t_lo)."""

    def __init__(self, lL, t_lo, t_hi):
        N, T = lL.shape
        d = np.diff(lL, axis=1)                            # d[:, t] = move from t to t+1
        use = np.zeros_like(d, bool)
        use[:, max(0, t_lo):max(0, t_hi)] = True
        use &= np.isfinite(d)
        vals = d[use]
        self.edges = np.quantile(vals, QB)
        self.mean_all = float(vals.mean())
        bins = np.full(d.shape, -1, np.int64)
        bins[use] = np.searchsorted(self.edges, d[use])
        # size class of each body at each step: fifths of log level among the bodies present
        cls = np.full(lL.shape, -1, np.int64)
        self.cuts = np.full((T, 4), np.nan)
        for t in range(T):
            x = lL[:, t]
            f = np.isfinite(x)
            if f.sum() >= 10:
                q = np.quantile(x[f], [0.2, 0.4, 0.6, 0.8])
                self.cuts[t] = q
                cls[f, t] = np.searchsorted(q, x[f])
        self.d, self.bins, self.cls, self.use = d, bins, cls, use
        # pooled: transitions (bin at t-1 -> bin at t) by the class at t, and the moves by (class, bin)
        a, b = bins[:, :-1], bins[:, 1:]
        k = cls[:, 1:-1] if cls.shape[1] - 1 > b.shape[1] else cls[:, 1:b.shape[1] + 1]
        ok = (a >= 0) & (b >= 0) & (k >= 0)
        Pc = np.zeros((5, NB, NB))
        np.add.at(Pc, (k[ok], a[ok], b[ok]), 1)
        marg = Pc.sum(1) + 1e-9                             # (class, to)
        self.marg = marg / marg.sum(1, keepdims=True)
        Pall = Pc.sum(0)
        rows = Pc.sum(2, keepdims=True)
        fall = (Pall + 1e-9) / (Pall + 1e-9).sum(1, keepdims=True)
        self.P = np.where(rows >= 3, Pc / np.maximum(rows, 1), np.broadcast_to(fall, Pc.shape))
        self.count = Pc
        mv = [[None] * NB for _ in range(5)]
        dk = cls[:, :d.shape[1]]
        for kk in range(5):
            for bb in range(NB):
                m = use & (bins == bb) & (dk == kk)
                v = d[m]
                if v.size < 5:
                    v = d[use & (bins == bb)]
                mv[kk][bb] = np.sort(v).astype(np.float64)
        self.moves = mv

    def own(self, i):
        """One body's own table and moves (rows it never saw fall back to the pooled row of its class)."""
        a, b = self.bins[i, :-1], self.bins[i, 1:]
        ok = (a >= 0) & (b >= 0)
        C = np.zeros((NB, NB))
        np.add.at(C, (a[ok], b[ok]), 1)
        mv = [np.sort(self.d[i][self.use[i] & (self.bins[i] == bb)]) for bb in range(NB)]
        n = int(ok.sum())
        return C, mv, n


def _sim(tb, starts, H, U, w, vol=1.0, persist=0.0, drift=0.0, gstep=0.0):
    """starts: list of dicts {i, lL0, b0, k0, C, mv, t0}; paths per start = U.shape[1]. Returns log levels (S, paths, H)."""
    S, n = len(starts), U.shape[1]
    out = np.zeros((S, n, H))
    for s, st in enumerate(starts):
        k0, C, mv = st["k0"], st["C"], st["mv"]
        rows = C.sum(1, keepdims=True)
        Pown = np.where(rows > 0, C / np.maximum(rows, 1), tb.P[k0])
        own_has = (rows[:, 0] > 0)
        m_own = np.concatenate([x for x in mv if x.size]) if any(x.size for x in mv) else np.array([tb.mean_all])
        m = w * float(m_own.mean()) + (1 - w) * tb.mean_all   # the mean move: what volatility spreads around
        Pk = tb.P.copy()
        Po = Pown.copy()
        if persist > 0:
            Pk = (1 - persist) * Pk + persist * np.eye(NB)
            Po = (1 - persist) * Po + persist * np.eye(NB)
        elif persist < 0:
            Pk = (1 + persist) * Pk + (-persist) * tb.marg[:, None, :]
            Po = (1 + persist) * Po + (-persist) * tb.marg[k0][None, :]
        cumK, cumO = np.cumsum(Pk, -1), np.cumsum(Po, -1)
        b = np.full(n, st["b0"], np.int64)
        k = np.full(n, k0, np.int64)
        x = np.full(n, st["lL0"], np.float64)
        cut0 = tb.cuts[st["t0"]]
        for h in range(H):
            u0, u1, u2 = U[s, :, h, 0], U[s, :, h, 1], U[s, :, h, 2]
            own = (u0 < w) & own_has[b]
            cum = np.where(own[:, None], cumO[b], cumK[k, b])
            b = np.minimum((u1[:, None] > cum).sum(1), NB - 1)
            mvv = np.empty(n)
            for bb in range(NB):
                sel = b == bb
                if not sel.any():
                    continue
                po, pk = mv[bb], None
                so = sel & own & (po.size > 0)
                if so.any():
                    mvv[so] = po[np.minimum((u2[so] * po.size).astype(int), po.size - 1)]
                sk = sel & ~so
                if sk.any():
                    for kk in np.unique(k[sk]):
                        z = sk & (k == kk)
                        pk = tb.moves[kk][bb]
                        mvv[z] = pk[np.minimum((u2[z] * pk.size).astype(int), pk.size - 1)]
            mvv = m + (mvv - m) * vol + drift
            x = x + mvv
            out[s, :, h] = x
            if np.isfinite(cut0).all():
                k = np.searchsorted(cut0 + gstep * (h + 1), x)
    return out


def _start(tb, lL, i, t0, window):
    C, mv, n = tb.own(i)
    d = tb.d[i]
    b0 = tb.bins[i, t0 - 1] if t0 >= 1 and tb.bins[i, t0 - 1] >= 0 else 2
    k0 = tb.cls[i, t0] if tb.cls[i, t0] >= 0 else 2
    return {"i": i, "lL0": float(lL[i, t0]), "b0": int(b0), "k0": int(k0), "C": C, "mv": mv, "n": n, "t0": t0}


def _crps(X, a):
    """CRPS of samples X (S, n) against outcomes a (S,)."""
    Xs = np.sort(X, 1)
    n = Xs.shape[1]
    e1 = np.abs(Xs - a[:, None]).mean(1)
    i = np.arange(1, n + 1)
    e2 = (2.0 / n ** 2) * ((2 * i - n - 1)[None, :] * Xs).sum(1)
    return e1 - 0.5 * e2


def _gstep(tb, t0, back=10):
    """How fast the size-class cut points move per step (the world grows, so 'richest fifth' moves up)."""
    c = tb.cuts
    a, b = max(0, t0 - back), t0
    if b - a < 2 or not (np.isfinite(c[a]).all() and np.isfinite(c[b]).all()):
        return 0.0
    return float((c[b] - c[a]).mean() / (b - a))


def backtest(world, paths=300, seed=0, job=None):
    W = FR.world(world)
    L, what, unit = level(W)
    lL = np.log(L)
    N, T = lL.shape
    H = H_BT[world]
    if world == "countries":
        origins = [t for t, d in enumerate(W["dates"]) if 1995 <= int(d[:4]) and t + H < T]
    else:
        origins = [t for t, d in enumerate(W["dates"]) if d >= "2013-12-31" and t + H < T][::3]
    rs = np.random.RandomState(seed)
    sc = {w: [] for w in WS}
    cov = {w: [] for w in WS}
    zz = {w: [] for w in WS}
    nochange, trend, rwalk, n_cases = [], [], [], 0
    t0c = time.time()
    for oi, t0 in enumerate(origins):
        tb = Tables(lL, 0, t0)
        g = _gstep(tb, t0)
        ok = np.isfinite(lL[:, t0]) & np.isfinite(lL[:, t0 + H]) & (np.isfinite(tb.d[:, :t0]).sum(1) >= 8)
        ids = np.flatnonzero(ok)
        if not ids.size:
            continue
        starts = [_start(tb, lL, i, t0, 0) for i in ids]
        U = rs.random_sample((len(ids), paths, H, 3))
        a = lL[ids, t0 + H] - lL[ids, t0]
        for w in WS:
            X = _sim(tb, starts, H, U, w, gstep=g)[:, :, -1] - lL[ids, t0][:, None]
            sc[w].append(_crps(X, a))
            lo, med, hi = np.percentile(X, [10, 50, 90], 1)
            cov[w].append((a >= lo) & (a <= hi))
            zz[w].append(np.abs(a - med) / np.maximum((hi - lo) / 2, 1e-9))
        nochange.append(np.abs(a))
        # the fair benchmark: a random walk with the volatility of its size class (iid past moves, no regimes, no drift)
        rw = np.zeros((len(ids), paths))
        for j, st in enumerate(starts):
            pool = np.concatenate([tb.moves[st["k0"]][bb] for bb in range(NB)])
            pool = pool - pool.mean()
            rw[j] = pool[rs.randint(0, pool.size, (paths, H))].sum(1)
        rwalk.append(_crps(rw, a))
        trend.append(np.abs(a - H * tb.mean_all))
        n_cases += ids.size
        if job:
            job.step("backtest {}/{}".format(oi + 1, len(origins)), (oi + 1) / len(origins))
    res = {}
    base = float(np.concatenate(nochange).mean())
    tr = float(np.concatenate(trend).mean())
    rwc = float(np.concatenate(rwalk).mean())
    for w in WS:
        c = float(np.concatenate(sc[w]).mean())
        res[str(w)] = {"crps": round(c, 5), "skill_vs_nochange": round(1 - c / base, 4), "skill_vs_trend": round(1 - c / tr, 4), "skill_vs_randomwalk": round(1 - c / rwc, 4), "cover80": round(float(np.concatenate(cov[w]).mean()), 4)}
    best = min(WS, key=lambda w: res[str(w)]["crps"])
    widen = float(np.quantile(np.concatenate(zz[best]), 0.8))
    out = {"world": world, "what": what, "horizon": H, "step": W["step"], "origins": [W["dates"][t][:7] for t in (origins[0], origins[-1])],
           "cases": n_cases, "paths": paths, "by_own": res, "best_own": best, "nochange_crps": round(base, 5), "trend_crps": round(tr, 5), "randomwalk_crps": round(rwc, 5), "widen80": round(widen, 3),
           "cover80_widened": 0.8, "secs": round(time.time() - t0c, 1)}
    FR._save(world, "futures_cal", out)
    return out


def run(world, id, horizon=None, own=None, vol=1.0, persist=0.0, drift=0.0, window=0, calibrated=True, paths=4000, seed=0):
    W = FR.world(world)
    if id not in W["ids"]:
        raise ValueError("no body {} in {}".format(id, world))
    i = W["ids"].index(id)
    L, what, unit = level(W)
    lL = np.log(L)
    fin = np.flatnonzero(np.isfinite(lL[i]))
    if fin.size < 8:
        raise ValueError("{} has too little history ({} steps)".format(W["names"][i], fin.size))
    t0 = int(fin[-1])
    cal = FR.load(world, "futures_cal")
    if own is None:
        own = cal["best_own"] if cal else 0.25
    H = int(horizon or (10 if world == "countries" else 36))
    lo_t = max(0, t0 - int(window)) if window else 0
    tb = Tables(lL, lo_t, t0)
    st = _start(tb, lL, i, t0, window)
    g = _gstep(tb, t0)
    U = np.random.RandomState(seed).random_sample((1, paths, H, 3))
    base = _sim(tb, [st], H, U, own, gstep=g)[0]
    scen = _sim(tb, [st], H, U, own, vol, persist, drift, gstep=g)[0]
    widen = (cal or {}).get("widen80", 1.0) if calibrated else 1.0

    def bands(X):
        med = np.median(X, 0)
        Y = med + (X - med) * widen
        q = np.percentile(Y, [2.5, 10, 25, 50, 75, 90, 97.5], 0)
        return np.exp(q).T.tolist()
    B0, B1 = bands(base), bands(scen)
    hist_t = fin[fin >= max(0, t0 - (40 if world == "countries" else 120))]
    v0 = float(L[i, t0])
    m0, m1 = B0[-1][3], B1[-1][3]
    yrs = H if world == "countries" else H / 12
    cagr = lambda v: (v / v0) ** (1 / yrs) - 1
    pert = [t for t in ["volatility ×{:g}".format(vol) if vol != 1 else "",
                        "regime spells {} ({:+.0%})".format("longer" if persist > 0 else "shorter", persist) if persist else "",
                        "{:+.1%} per step".format(math.exp(drift) - 1) if drift else "",
                        "learned from the last {} steps".format(window) if window else ""] if t]
    rid = int(st["b0"])
    out = {"world": world, "id": id, "name": W["names"][i], "what": what, "unit": unit, "step": W["step"], "own": own, "horizon": H,
           "start": {"date": W["dates"][t0], "value": v0, "regime": REG[world][rid], "class": CLS[world][st["k0"]]},
           "history": {"dates": [W["dates"][t] for t in hist_t], "y": [float(L[i, t]) for t in hist_t]},
           "dates": [_future(W, t0, h + 1) for h in range(H)],
           "baseline": B0, "scenario": B1 if pert else None, "perturbed": pert,
           "samples": np.exp(scen[:20]).tolist(), "widen": widen,
           "table": {"regimes": REG[world], "own": st["C"].astype(int).tolist(), "own_moves": st["n"],
                     "pooled": np.round(tb.P[st["k0"]], 3).tolist(), "edges": [round(float(e), 4) for e in tb.edges]},
           "calibration": cal}
    s = "From {} in {}, the median path ends near {} ({:+.1%} a year), and 80% of futures land between {} and {}.".format(
        _fmt(v0, unit), W["dates"][t0][:4], _fmt(m0, unit), cagr(m0), _fmt(B0[-1][1], unit), _fmt(B0[-1][5], unit))
    if pert:
        s += " With {}: median {} ({:+.1%} a year), 80% between {} and {}.".format(", ".join(pert), _fmt(m1, unit), cagr(m1), _fmt(B1[-1][1], unit), _fmt(B1[-1][5], unit))
    out["sentence"] = s
    return out


def _fmt(v, unit):
    if unit == "share":
        return "{:.2%}".format(v)
    a = abs(v)
    return "${:,.0f}".format(v) if a < 1e6 else "${:.3g} million".format(v / 1e6)


def _future(W, t0, h):
    d = W["dates"][t0]
    y, m = int(d[:4]), int(d[5:7])
    if W["step"] == "year":
        return "{}-12-31".format(y + h)
    m += h
    y += (m - 1) // 12
    m = (m - 1) % 12 + 1
    return "{:04d}-{:02d}-28".format(y, m)
