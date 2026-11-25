"""Particle worlds: any population that grows, competes, merges and dies, run as an N-body system — and an honest
backtest of whether the rules say anything about what really happened next.

Input is a PANEL: N entities x T dates of a size (market cap, revenue, users, population...), with optional groups
(sectors, categories), an optional membership mask (who is "in" at each date) and optional change events. The S&P 500
is one preset (market_panel); table_panel() turns any Data Desk table (a date column + one column per entity) into one.

The picture at a start date T0 (only data up to T0 is used):
  position  classical MDS of the Mantegna distance d = sqrt(2(1 - rho)) between the entities' trailing log changes,
            so things that move together sit together and groups appear as clusters without being told the groups;
  mass      size at T0;
  growth    trailing growth, shrunk toward the whole ("velocity"), relaxing toward the overall rate over time;
  noise     each entity's own trailing volatility (an ensemble of futures runs on the card).
Forces, each switchable so the backtest can ablate it:
  gravity   bodies drift toward heavy neighbours (softened 1/r^2 with friction) — sectors condense;
  takeover  inside a neighbourhood kernel the bigger body gains growth at the smaller ones' expense (G > 0: the big
            eat their sector; G < 0 would mean neighbours mean-revert);
  merger    a small body that comes within the capture radius of one five times its size is absorbed (an acquisition);
  drop      bodies that fall below the floor leave (destroyed);
  entrants  the Oort cloud: new bodies arrive at the rate, size, group mix and growth seen in the years before T0.
Everything is predicted as SHARES of the whole (nobody knows the future level), then compared with what actually
happened at T1, next to two baselines: persistence (T1 = T0) and momentum alone (every interaction off).
"""
import json
import math
import os

import numpy as np

from . import marketdata as MD

try:
    import cupy as cp
except Exception:  # noqa: BLE001
    cp = None

_P = {}


def market_panel():
    """S&P 500 preset. Company-level panel: share classes of one CIK collapse into one body (the largest-cap class)."""
    if "p" in _P:
        return _P["p"]
    P, meta = MD.load()
    info = meta["info"]
    tick = [str(t) for t in P["tickers"]]
    cap, px, inidx = P["cap"], P["px"], P["inidx"]
    groups = {}
    for i, t in enumerate(tick):
        cik = info.get(t, {}).get("cik") or ("t:" + t)
        groups.setdefault(cik, []).append(i)
    rows = []
    for cik, ix in groups.items():
        ix = sorted(ix, key=lambda i: -np.nanmax(np.r_[cap[i], 0]))
        rows.append(ix)
    keep = [ix[0] for ix in rows]
    C = cap[keep]
    X = px[keep]
    M = np.zeros_like(C, bool)
    for r, ix in enumerate(rows):
        M[r] = inidx[ix].any(0)
    tk = [tick[i] for i in keep]
    sec = [(info.get(t, {}).get("sector") or "Unknown") for t in tk]
    nm = [info.get(t, {}).get("name") or t for t in tk]
    _P["p"] = {"cap": C, "px": X, "inidx": M, "dates": [str(d) for d in P["dates"]], "tickers": tk, "sector": sec,
               "name": nm, "changes": meta["changes"], "built": meta.get("built"), "unit": "USD", "what": "market cap",
               "group_name": "sector", "step": "month"}
    return _P["p"]


def table_panel(dates, names, values, groups=None, member=None, what="size", group_name="group"):
    """A panel from any table: dates (T), entity names (N), values (T x N, NaN = absent), optional {name: group}.
    Without groups every entity is its own; without a member mask an entity is "in" whenever it has a value."""
    V = np.asarray(values, np.float64).T                      # N x T
    V = np.where(V > 0, V, np.nan)
    M = np.isfinite(V) if member is None else np.asarray(member, bool).T
    g = [str((groups or {}).get(n) or "-") for n in names]
    return {"cap": V, "px": None, "inidx": M, "dates": [str(d) for d in dates], "tickers": [str(n) for n in names],
            "sector": g, "name": [str(n) for n in names], "changes": [], "built": None, "unit": "", "what": what,
            "group_name": group_name, "step": "step"}


SECTORS = ["Information Technology", "Communication Services", "Consumer Discretionary", "Health Care", "Financials",
           "Industrials", "Consumer Staples", "Energy", "Utilities", "Real Estate", "Materials", "Unknown"]


def _di(p, date):
    ds = p["dates"]
    j = max(i for i, d in enumerate(ds) if d <= date)
    return j


def _mds(R, k=3):
    """Classical MDS of the Mantegna distance between columns of the return matrix R (T x N)."""
    Z = (R - R.mean(0)) / (R.std(0) + 1e-12)
    rho = np.clip(Z.T @ Z / len(Z), -1, 1)
    D2 = 2 * (1 - rho)
    n = len(D2)
    J = np.eye(n) - 1.0 / n
    B = -0.5 * J @ D2 @ J
    w, V = np.linalg.eigh(B)
    o = np.argsort(w)[::-1][:k]
    X = V[:, o] * np.sqrt(np.maximum(w[o], 1e-12))
    X /= np.sqrt((X ** 2).sum(1).mean()) + 1e-12
    return X, rho


def _mds_warm(R, X0, iters=12):
    """The top two MDS axes of R by subspace iteration started from the previous frame's map — the same answer as
    _mds(R, 2) up to rotation, a fraction of the cost, and it moves smoothly from frame to frame."""
    Z = (R - R.mean(0)) / (R.std(0) + 1e-12)
    rho = np.clip(Z.T @ Z / len(Z), -1, 1)
    B = 1 - rho                                              # -0.5 * D2 with D2 = 2(1 - rho), before centring
    B = -(B - B.mean(0) - B.mean(1)[:, None] + B.mean())
    V = np.asarray(X0, np.float64)[:, :2].copy()
    V += 1e-6 * np.random.RandomState(0).standard_normal(V.shape)
    for _ in range(iters):
        V, _ = np.linalg.qr(B @ V)
    lam = np.maximum(np.einsum("ij,ij->j", V, B @ V), 1e-12)
    X = V * np.sqrt(lam)
    return X / (np.sqrt((X ** 2).sum(1).mean()) + 1e-12)


def _knn_purity(X, sec, k=5):
    d = ((X[:, None] - X[None]) ** 2).sum(2)
    np.fill_diagonal(d, np.inf)
    nn = np.argsort(d, 1)[:, :k]
    s = np.array(sec)
    same = (s[nn] == s[:, None]).mean()
    _, cnt = np.unique(s, return_counts=True)
    chance = float(((cnt / cnt.sum()) ** 2).sum())
    return float(same), chance


def state(p, t0, lookback=36):
    """Everything the simulation may know at T0."""
    j0 = _di(p, t0)
    lookback = min(lookback, j0)
    if lookback < 2:
        raise ValueError("start later: the simulation needs at least two earlier steps to learn growth from")
    m = p["inidx"][:, j0] & np.isfinite(p["cap"][:, j0])
    win = slice(j0 - lookback, j0 + 1)
    lp = np.log(p["px"][:, win] if p.get("px") is not None else p["cap"][:, win])
    r = np.diff(lp, axis=1).T                                  # (lookback, N)
    okr = np.isfinite(r).sum(0) >= int(lookback * 0.67)
    ix = np.where(m & okr)[0]
    if len(ix) < 3:
        raise ValueError("fewer than 3 entities have a value at {} and enough history before it".format(p["dates"][j0]))
    R = np.nan_to_num(r[:, ix] - np.nanmean(r[:, ix], 0))
    if lookback >= 6:
        X, rho = _mds(R)
        layout = "co-movement"
    else:                                                      # too short to correlate: groups on a ring, jittered
        gs = sorted(set(p["sector"][i] for i in ix))
        rs_ = np.random.RandomState(1)
        X = np.array([[np.cos(2 * np.pi * gs.index(p["sector"][i]) / len(gs)), np.sin(2 * np.pi * gs.index(p["sector"][i]) / len(gs)), 0]
                      for i in ix]) + rs_.normal(0, 0.15, (len(ix), 3))
        layout = "groups"
    cap0 = p["cap"][ix, j0]
    # growth of cap per month over the lookback (log), and its volatility
    lc = np.log(p["cap"][ix, j0 - lookback:j0 + 1])
    g = (lc[:, -1] - np.where(np.isfinite(lc[:, 0]), lc[:, 0], lc[:, -1])) / lookback
    g = np.where(np.isfinite(lc[:, 0]), g, np.nanmean(r[:, ix], 0))
    vol = np.nan_to_num(np.nanstd(r[:, ix], 0))
    sec = [p["sector"][i] for i in ix]
    purity, chance = _knn_purity(X, sec)
    return {"j0": j0, "t0": p["dates"][j0], "ix": ix, "X": X, "cap": cap0, "g": g, "vol": vol, "sector": sec,
            "tickers": [p["tickers"][i] for i in ix], "name": [p["name"][i] for i in ix], "purity": purity, "chance": chance,
            "entrants": _entrants(p, j0, lookback), "layout": layout, "lookback": lookback}


def _entrants(p, j0, window=60):
    """Rate, relative size, group mix and growth of entrants over the window before T0 (no look-ahead)."""
    ja = max(0, j0 - window)
    new = []
    for i in range(len(p["tickers"])):
        row = p["inidx"][i, ja:j0 + 1]
        if row.any() and not p["inidx"][i, ja] and np.isfinite(p["cap"][i, ja:j0 + 1]).any():
            k = ja + int(np.argmax(row))
            if np.isfinite(p["cap"][i, k]):
                tot = np.nansum(np.where(p["inidx"][:, k], p["cap"][:, k], 0))
                gg = np.nan
                lc = np.log(p["cap"][i, k:j0 + 1])
                if np.isfinite(lc).sum() > 12:
                    f = np.where(np.isfinite(lc))[0]
                    gg = (lc[f[-1]] - lc[f[0]]) / max(1, f[-1] - f[0])
                new.append((p["sector"][i], p["cap"][i, k] / tot, gg))
    if not new:
        return {"per_month": 0, "share": [], "sectors": [], "g": 0.0}
    return {"per_month": len(new) / float(max(1, j0 - ja)), "share": [s for _, s, _ in new], "sectors": [s for s, _, _ in new],
            "g": float(np.nanmedian([x for _, _, x in new])) if any(np.isfinite(x) for _, _, x in new) else 0.0}


DEFAULT = {"beta": 0.5, "kappa": 1 / 24.0, "alpha": 0.0, "G": 0.0, "h": 0.35, "Gx": 0.0, "fric": 0.15, "merge_r": 0.0, "merge_q": 0.2,
           "drop": True, "entrants": True, "noise": True}


def simulate(st, months=60, ens=256, seed=0, **kw):
    """Run the ensemble forward. Returns per-body share distributions at T1, entrants' sector shares, mergers, frames."""
    P = dict(DEFAULT, **kw)
    xp = cp if cp is not None else np
    rs = np.random.RandomState(seed)
    N = len(st["cap"])
    X = np.array(st["X"], np.float64)
    V = np.zeros_like(X)
    gm = float(np.average(st["g"], weights=st["cap"]))          # the market's own trailing growth
    g0 = gm + P["beta"] * (st["g"] - gm)
    lm = xp.asarray(np.tile(np.log(st["cap"] / st["cap"].sum()), (ens, 1)))   # log share, per future
    g = xp.asarray(np.tile(g0, (ens, 1)))
    vol = xp.asarray(np.tile(st["vol"], (ens, 1)))
    alive = np.ones(N, bool)
    alive_e = xp.ones((ens, N), bool)
    floor0 = float(np.log(np.sort(st["cap"])[max(0, int(0.01 * N))] / st["cap"].sum())) - 0.7   # ~half the smallest members
    nn = np.sqrt(np.sort(((X[:, None] - X[None]) ** 2).sum(2), 1)[:, 1]).mean()
    w_start = st["cap"] / st["cap"].sum()
    mergers = []
    frames = [{"month": 0, "x": X[:, :2].round(3).tolist(), "w": _r6(w_start), "lo": _r6(w_start), "hi": _r6(w_start), "ew": []}]
    every = max(1, int(math.ceil(months / float(MAX_FRAMES))))       # every step is a frame, up to MAX_FRAMES of them
    ent = st["entrants"]
    E_l, E_g, E_sec, E_x = [], [], [], []
    cent = {s: X[[i for i, z in enumerate(st["sector"]) if z == s]].mean(0) for s in set(st["sector"])}
    h2 = (P["h"] * 1.0) ** 2
    for t in range(months):
        w = xp.exp(lm) * alive_e
        wbar = np.asarray((w.mean(0).get() if xp is cp else w.mean(0)))
        D2 = ((X[:, None] - X[None]) ** 2).sum(2)
        if P["G"]:
            K = np.exp(-D2 / (2 * h2)) * alive[None] * alive[:, None]
            np.fill_diagonal(K, 0)
            Kx = xp.asarray(K)
            s1 = w @ Kx.T                                    # sum_j K_ij w_j
            s2 = (w * lm) @ Kx.T                             # sum_j K_ij w_j l_j
            boost = P["G"] * (lm * s1 - s2)
        else:
            boost = 0.0
        if P["alpha"]:                                       # size itself: > 0 the rich get richer, < 0 the small catch up
            boost = boost + P["alpha"] * (lm - (lm * alive_e).sum(1, keepdims=True) / alive_e.sum(1, keepdims=True))
        eps = xp.asarray(rs.standard_normal((ens, N))) if P["noise"] else 0.0
        lm = lm + g + boost + (vol * eps if P["noise"] else 0.0) - 0.5 * (vol ** 2 if P["noise"] else 0.0)
        g = g - P["kappa"] * (g - gm)
        # renormalise to shares among the living
        lm = lm - xp.log((xp.exp(lm) * alive_e).sum(1, keepdims=True))
        if P["drop"]:
            alive_e &= lm > floor0
        if P["Gx"]:
            r2 = D2 + (0.15 * nn) ** 2
            inv = (wbar * alive)[None] / (r2 * np.sqrt(r2))
            np.fill_diagonal(inv, 0)
            A = (X[None] - X[:, None]) * inv[:, :, None]
            V = (1 - P["fric"]) * V + P["Gx"] * A.sum(1)
            X = X + V * alive[:, None]
        if P["merge_r"]:
            D = np.sqrt(((X[:, None] - X[None]) ** 2).sum(2))
            np.fill_diagonal(D, np.inf)
            for i in np.argsort(wbar):
                if not alive[i]:
                    continue
                cand = np.where(alive & (D[i] < P["merge_r"] * nn) & (wbar * P["merge_q"] > wbar[i]))[0]
                if len(cand):
                    j = cand[np.argmax(wbar[cand])]
                    alive[i] = False
                    mergers.append({"month": t + 1, "target": st["tickers"][i], "acquirer": st["tickers"][j]})
                    if xp is cp:
                        lm[:, j] = cp.log(cp.exp(lm[:, j]) + cp.exp(lm[:, i]))
                    else:
                        lm[:, j] = np.logaddexp(lm[:, j], lm[:, i])
                    alive_e[:, i] = False
        if P["entrants"] and ent["per_month"]:
            for _ in range(rs.poisson(ent["per_month"])):
                k = rs.randint(len(ent["share"]))
                E_l.append((t, math.log(ent["share"][k])))
                E_sec.append(ent["sectors"][k])
                c = cent.get(ent["sectors"][k], X.mean(0))
                E_x.append(c + rs.standard_normal(3) * 0.3)
                E_g.append(ent["g"])
        if (t + 1) % every == 0 or t == months - 1:
            # the picture after this step, on the same footing as the final answer: entrants so far take their share
            # from everyone, the bodies' ensemble is renormalised among the living, and p10/p90 come from the futures
            ew = _entrant_w(E_l, E_g, gm, t + 1)
            Wt = xp.exp(lm) * alive_e
            Wt = Wt / Wt.sum(1, keepdims=True) * (1 - ew.sum())
            q = xp.percentile(Wt, xp.asarray([10.0, 90.0]), axis=0) if xp is cp else np.percentile(Wt, [10, 90], axis=0)
            q = q.get() if xp is cp else q
            wm = Wt.mean(0)
            wm = wm.get() if xp is cp else wm
            frames.append({"month": t + 1, "x": X[:, :2].round(3).tolist(), "w": _r6(wm), "lo": _r6(q[0]), "hi": _r6(q[1]), "ew": _r6(ew)})
    # entrants grow from arrival at the entrant growth rate relative to the market; their share is taken from everyone
    ent_w = _entrant_w(E_l, E_g, gm, months)
    W = xp.exp(lm) * alive_e
    W = W.get() if xp is cp else W
    W = W / W.sum(1, keepdims=True) * (1 - ent_w.sum())
    return {"W": W, "alive": W > 0, "entrant_w": ent_w, "entrant_t": [t for t, _ in E_l],
            "entrant_sector": E_sec, "entrant_x": [list(map(float, x[:2])) for x in E_x], "mergers": mergers, "frames": frames,
            "params": P}


MAX_FRAMES = 120


def _r6(a):
    return [float("{:.4g}".format(float(v))) for v in a]


def _entrant_w(E_l, E_g, gm, t):
    """Shares of the entrants that have arrived by step t (at most half the whole between them)."""
    w = np.array([math.exp(l + (t - ta) * (gg - gm if np.isfinite(gg) else 0)) for (ta, l), gg in zip(E_l, E_g) if ta < t])
    if not len(w):
        return w
    return w * (min(0.5, w.sum()) / max(w.sum(), 1e-12))


def actual(p, st, t1):
    j1 = _di(p, t1)
    m = p["inidx"][:, j1] & np.isfinite(p["cap"][:, j1])
    tot = p["cap"][m, j1].sum()
    w1 = np.where(m, p["cap"][:, j1], 0) / tot
    # what happened to each T0 body
    surv = m[st["ix"]]
    lc = np.log(p["cap"][st["ix"], j1] / p["cap"][st["ix"], st["j0"]])
    sec_w = {}
    for i in np.where(m)[0]:
        sec_w[p["sector"][i]] = sec_w.get(p["sector"][i], 0) + w1[i]
    new_w = float(w1[np.setdiff1d(np.where(m)[0], st["ix"])].sum())
    top = np.argsort(-w1)[:10]
    return {"t1": p["dates"][j1], "j1": j1, "w_body": w1[st["ix"]], "surv": surv, "logchg": lc, "sector_w": sec_w,
            "new_w": new_w, "top10": [p["tickers"][i] for i in top], "top10_share": float(w1[top].sum())}


def actual_path(p, st, months, X0):
    """What really happened, frame by frame, on the simulation's own footing: each start body's share of the whole at
    every step (0 once it has left), the newcomers' share, and a map that evolves — the same co-movement MDS as the
    start picture, recomputed on the trailing window at each step and aligned to the frame before (orthogonal
    Procrustes), so a body only moves when how it moves with the others really changed. Frames past the data are None."""
    every = max(1, int(math.ceil(months / float(MAX_FRAMES))))
    steps = [0] + [m for m in range(1, months + 1) if m % every == 0 or m == months]
    ix, j0, lb = st["ix"], st["j0"], st["lookback"]
    series = p["px"] if p.get("px") is not None else p["cap"]
    out, Xp = [], np.asarray(X0, np.float64)[:, :2]
    for m in steps:
        j = j0 + m
        if j >= len(p["dates"]):
            out.append(None)
            continue
        mem = p["inidx"][:, j] & np.isfinite(p["cap"][:, j])
        tot = p["cap"][mem, j].sum()
        w = np.where(mem[ix], p["cap"][ix, j], 0.0) / tot
        new = float(1 - w.sum())
        gw = {}                                                  # every member's group share, newcomers included
        for i in np.where(mem)[0]:
            gw[p["sector"][i]] = gw.get(p["sector"][i], 0.0) + float(p["cap"][i, j] / tot)
        X = Xp
        if m and st["layout"] == "co-movement":
            with np.errstate(all="ignore"):
                r = np.diff(np.log(series[ix, j - lb:j + 1]), axis=1).T
                r = np.nan_to_num(r - np.nanmean(r, 0))
            live = np.abs(r).sum(0) > 0
            if live.sum() >= 3:
                Xn = _mds_warm(r, Xp)
                A, B = Xn[live], Xp[live]                            # rotate/reflect onto the previous frame
                U, _, Vt = np.linalg.svd(A.T @ B)
                Xn = Xn @ (U @ Vt)
                Xn *= np.sqrt((B ** 2).sum() / max((Xn[live] ** 2).sum(), 1e-12))
                X = np.where(live[:, None], Xn, Xp)
        out.append({"month": m, "date": p["dates"][j], "w": _r6(w), "new": round(new, 6), "x": np.round(X, 3).tolist(),
                    "g": {k: round(v, 6) for k, v in gw.items()}})
        Xp = X
    return out


def _spearman(a, b):
    ra, rb = np.argsort(np.argsort(a)), np.argsort(np.argsort(b))
    return float(np.corrcoef(ra, rb)[0, 1])


def _auc(score, y):
    y = np.asarray(y, bool)
    if y.all() or (~y).all():
        return float("nan")
    r = np.argsort(np.argsort(score)) + 1
    return float((r[y].sum() - y.sum() * (y.sum() + 1) / 2) / (y.sum() * (~y).sum()))


def score(st, sim, act):
    """Compare a simulated future with what happened."""
    W = sim["W"]
    w_mean = W.mean(0)
    sec_pred = {}
    for i, s in enumerate(st["sector"]):
        sec_pred[s] = sec_pred.get(s, 0) + w_mean[i]
    for s, w in zip(sim["entrant_sector"], sim["entrant_w"]):
        sec_pred[s] = sec_pred.get(s, 0) + w
    allsec = set(sec_pred) | set(act["sector_w"])
    l1 = 0.5 * sum(abs(sec_pred.get(s, 0) - act["sector_w"].get(s, 0)) for s in allsec)
    ok = act["surv"] & np.isfinite(act["logchg"])
    w0 = st["cap"] / st["cap"].sum()
    pred_chg = np.log(np.maximum(w_mean, 1e-12) / w0)
    rho = _spearman(pred_chg[ok], act["logchg"][ok]) if ok.sum() > 10 else float("nan")
    pleave = (W <= 0).mean(0)
    auc = _auc(pleave, ~act["surv"])
    top = [st["tickers"][i] for i in np.argsort(-w_mean)[:10]]
    return {"sector_l1": round(float(l1), 4), "rank_rho": round(rho, 4) if rho == rho else None, "leave_auc": round(auc, 4) if auc == auc else None,
            "top10_hit": len(set(top) & set(act["top10"])), "top10_share_pred": round(float(np.sort(w_mean)[::-1][:10].sum()), 4),
            "top10_share_actual": round(act["top10_share"], 4), "sector_pred": {k: round(float(v), 4) for k, v in sec_pred.items()}}


def persistence(st, act):
    """Baseline: the T0 picture, unchanged."""
    ens = {"W": (st["cap"] / st["cap"].sum())[None] * (1 - 0), "entrant_w": np.array([]), "entrant_sector": []}
    r = score(st, ens, act)
    r["rank_rho"] = None                                     # constant prediction: no ranking
    # leaving: smallest first is the honest baseline for drops
    r["leave_auc"] = round(_auc(-st["cap"], ~act["surv"]), 4)
    return r


def acquisitions(p, t0, t1):
    """Members removed because they were acquired, between T0 and T1 (from the change log's reason text)."""
    out = []
    for e in p["changes"]:
        if t0 < e["date"] <= t1 and e["rem"] and "acqui" in e["reason"].lower():
            out.append({"date": e["date"], "target": e["rem"], "reason": e["reason"]})
    return out


# ---------------------------------------------------------------- fitting and walk-forward validation
FIT_GRID = {"beta": [0.0, 0.5, 1.0], "kappa": [0.0, 1 / 36.0], "alpha": [-0.004, 0.0, 0.004], "G": [-0.25, 0.0, 0.25]}


def loss(s):
    """Lower is better: share of the whole put in the wrong group, minus a quarter of the rank correlation of growth."""
    return s["sector_l1"] - 0.25 * (s["rank_rho"] or 0.0)


def fit(p, t0, t1, rules=("beta", "kappa", "alpha", "G"), base=None, months=None, ens=48):
    """Grid-search the chosen rule strengths on a past window [t0, t1] (both must be in the past of any test)."""
    import itertools
    st = state(p, t0)
    act = actual(p, st, t1)
    months = months or (_di(p, t1) - _di(p, t0))
    keys = [k for k in rules if k in FIT_GRID]
    best = None
    for vals in itertools.product(*[FIT_GRID[k] for k in keys]):
        kw = dict(base or {}, **dict(zip(keys, vals)))
        s = score(st, simulate(st, months=months, ens=ens, **kw), act)
        L = loss(s)
        if best is None or L < best[0]:
            best = (L, kw, s)
    return {"params": best[1], "loss": round(best[0], 4), "score": best[2], "window": [st["t0"], act["t1"]]}


def _shift(date, months):
    y, m = int(date[:4]), int(date[5:7])
    k = y * 12 + (m - 1) + months
    y2, m2 = divmod(k, 12)
    import calendar
    return "{:04d}-{:02d}-{:02d}".format(y2, m2 + 1, calendar.monthrange(y2, m2 + 1)[1])


def walk_forward(p, starts, horizon=60, rules=("beta", "kappa", "alpha", "G"), extra=None, job=None):
    """For each start T0: fit the rules on [T0 - horizon, T0] (the past only), run forward to T0 + horizon, and score
    against persistence, momentum (fitted with interactions off) and the fitted rules."""
    out = []
    for n, t0 in enumerate(starts):
        if job:
            job.step(n / max(1, len(starts)), "window {} of {}: the tool fits on the window before {}".format(n + 1, len(starts), t0[:7]))
        j0 = _di(p, t0)
        if j0 + horizon >= len(p["dates"]) or j0 - horizon < 2:
            continue                                         # the fit needs a full window before T0, the test one after
        tf, t1 = p["dates"][j0 - horizon], p["dates"][j0 + horizon]
        f = fit(p, tf, t0, rules, extra)
        off = dict(extra or {}, alpha=0.0, G=0.0, Gx=0.0, merge_r=0.0)      # the baseline: growth carries on, nothing interacts
        fm = fit(p, tf, t0, [r for r in rules if r in ("beta", "kappa")], off)
        st = state(p, t0)
        act = actual(p, st, t1)
        rows = {"persistence": persistence(st, act),
                "momentum": score(st, simulate(st, months=horizon, ens=128, **dict(off, **fm["params"])), act),
                "rules": score(st, simulate(st, months=horizon, ens=128, **dict(extra or {}, **f["params"])), act)}
        out.append({"t0": st["t0"], "t1": act["t1"], "fit": f["params"], "fit_momentum": fm["params"], "rows": rows,
                    "bodies": len(st["cap"]), "purity": round(st["purity"], 3), "chance": round(st["chance"], 3),
                    "new_share": round(act["new_w"], 3), "top10": act["top10"]})
    # does the fitted rule set beat each baseline, window by window?
    def wins(a, b, k, better):
        return sum(1 for w in out if w["rows"][a][k] is not None and w["rows"][b][k] is not None and better(w["rows"][a][k], w["rows"][b][k]))
    summary = {"windows": len(out),
               "rules_beat_persistence_sector": wins("rules", "persistence", "sector_l1", lambda a, b: a < b),
               "rules_beat_momentum_sector": wins("rules", "momentum", "sector_l1", lambda a, b: a < b),
               "rules_beat_momentum_rank": wins("rules", "momentum", "rank_rho", lambda a, b: a > b),
               "mean": {k: {m: round(float(np.mean([w["rows"][k][m] for w in out if w["rows"][k][m] is not None] or [np.nan])), 4)
                            for m in ("sector_l1", "rank_rho", "leave_auc", "top10_hit")} for k in ("persistence", "momentum", "rules")}}
    return {"windows": out, "summary": summary}


# ---------------------------------------------------------------- more panels
def worldbank_panel(indicator="NY.GDP.MKTP.CD", refresh=False):
    """Countries as bodies: GDP in current US$ by year from the World Bank (no key), grouped by World Bank region."""
    key = "wb_" + indicator
    if key in _P and not refresh:
        return _P[key]
    root = os.path.join(MD.ROOT, "..", "particles")
    os.makedirs(root, exist_ok=True)
    fp = os.path.join(root, indicator + ".json")
    if refresh or not os.path.exists(fp):
        rows, page = [], 1
        while True:
            b = MD._get("https://api.worldbank.org/v2/country/all/indicator/{}?format=json&per_page=20000&date=1970:2030&page={}".format(indicator, page))
            j = json.loads(b)
            rows += j[1] or []
            if page >= j[0]["pages"]:
                break
            page += 1
        cs = json.loads(MD._get("https://api.worldbank.org/v2/country?format=json&per_page=400"))[1]
        json.dump({"rows": rows, "countries": cs}, open(fp, "w"))
    d = json.load(open(fp))
    reg = {c["id"]: c["region"]["value"].strip() for c in d["countries"] if c["region"]["value"].strip() != "Aggregates"}
    names = {c["id"]: c["name"] for c in d["countries"]}
    years = sorted({int(r["date"]) for r in d["rows"]})
    ids = sorted({r["countryiso3code"] for r in d["rows"] if r["countryiso3code"] in reg})
    V = np.full((len(years), len(ids)), np.nan)
    yi, ci = {y: i for i, y in enumerate(years)}, {c: i for i, c in enumerate(ids)}
    for r in d["rows"]:
        c = r["countryiso3code"]
        if c in ci and r["value"]:
            V[yi[int(r["date"])], ci[c]] = float(r["value"])
    last = max(i for i in range(len(years)) if np.isfinite(V[i]).sum() > 0.6 * len(ids))
    P = table_panel(["{}-12-31".format(y) for y in years[:last + 1]], ids, V[:last + 1], reg, what="GDP (current US$)", group_name="region")
    P["name"] = [names.get(c, c) for c in ids]
    P["unit"], P["step"] = "USD", "year"
    _P[key] = P
    return P


def desk_panel(table, layout="wide", date_col="auto", cols=None, entity_col=None, value_col=None, group_col=None, groups_text=""):
    """A Data Desk table as a panel.
    wide: a date column + one numeric column per entity (cols; all numeric columns if empty).
    long: date, entity and value columns (+ an optional group column) — one row per entity per date."""
    from . import media, sources
    meta, X, cat = media._load_table(table)
    if date_col == "auto":
        dc = sources.date_columns(table)
        date_col = dc[0] if dc else None
    raw = cat["values"][cat["names"].index(date_col)] if date_col in cat["names"] else None
    groups = {}
    for line in (groups_text or "").splitlines():
        if ":" in line:
            a, b = line.split(":", 1)
            groups[a.strip()] = b.strip()
    def key(i):
        if raw is None:
            return "{:06d}".format(i)
        d = sources.parse_date(raw[i])
        return d.strftime("%Y-%m-%d") if d else None
    if layout == "long":
        if entity_col not in cat["names"] or value_col not in meta["numeric"]:
            raise ValueError("long tables need an entity (text) column and a value (numeric) column")
        ent = cat["values"][cat["names"].index(entity_col)]
        val = X[:, meta["numeric"].index(value_col)]
        grp = cat["values"][cat["names"].index(group_col)] if group_col in cat["names"] else None
        dates = sorted({k for k in (key(i) for i in range(len(val))) if k})
        names = sorted({e.strip() for e in ent if e.strip()})
        di, ni = {d: i for i, d in enumerate(dates)}, {n: i for i, n in enumerate(names)}
        V = np.full((len(dates), len(names)), np.nan)
        for i in range(len(val)):
            k, e = key(i), ent[i].strip()
            if k and e and np.isfinite(val[i]):
                V[di[k], ni[e]] = val[i]
                if grp is not None and grp[i].strip():
                    groups.setdefault(e, grp[i].strip())
        what = value_col
    else:
        cols = [c for c in (cols or meta["numeric"]) if c in meta["numeric"]]
        if len(cols) < 3:
            raise ValueError("pick at least 3 numeric columns — one per entity")
        rows = [(key(i), i) for i in range(X.shape[0])]
        rows = sorted([(k, i) for k, i in rows if k])
        dates = [k for k, _ in rows]
        V = np.stack([X[[i for _, i in rows], meta["numeric"].index(c)].astype(np.float64) for c in cols], 1)
        names = cols
        what = "value"
    if len(dates) < 4:
        raise ValueError("need at least 4 dates")
    P = table_panel(dates, names, V, groups, what=what, group_name=group_col or "group")
    P["step"] = "step"
    return P
