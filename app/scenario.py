"""Scenarios for a country, a region (or sector) or the whole world, on the futures engine.

All members are simulated together. Their regime and move draws are correlated across bodies (a Gaussian copula with
the cross-body correlation measured from the moves themselves), so a bad world year is bad for most of them, as
2009 and 2020 were. The baseline and the scenario use the same random numbers.

A change: {"target": "IDN" | "group:East Asia & Pacific" | "all", "kind": "growth" | "vol" | "stability" | "shock",
           "from": first year (or month) ahead, 1-based, "to": last one (inclusive; shock uses "from" only), "value": ...}
  growth     value = points of growth per step added (0.01 = +1 point a year)
  vol        value = volatility multiplier (1.1 = 10% more)
  stability  value = persistence (+0.1 = spells last 10% longer, - = switch more often)
  shock      value = one-time change of the level (-0.06 = a 6% loss, about a banking crisis in Cerra & Saxena 2008)"""
import math

import numpy as np

from . import forcerun as FR
from . import futures as FU

NB = FU.NB


def _phi(z):
    return 0.5 * (1.0 + _erf(z / math.sqrt(2.0)))


def _erf(x):                                              # Abramowitz-Stegun 7.1.26, |error| < 1.5e-7, vectorised
    s = np.sign(x)
    x = np.abs(x)
    t = 1.0 / (1.0 + 0.3275911 * x)
    y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * np.exp(-x * x)
    return s * y


def _rho(tb, t_lo, t_hi):
    """The average correlation between two bodies' standardised moves in the same step."""
    import warnings
    d = tb.d[:, max(0, t_lo):t_hi]
    with warnings.catch_warnings(), np.errstate(all="ignore"):
        warnings.simplefilter("ignore")
        sd = np.nanstd(d, 1, keepdims=True)
        z = (d - np.nanmean(d, 1, keepdims=True)) / np.where(sd > 0, sd, np.nan)
    ok = np.isfinite(z)
    rs = []
    for t in range(z.shape[1]):
        v = z[ok[:, t], t]
        if v.size >= 20:
            n = v.size
            rs.append((n * v.mean() ** 2 - 1) / (n - 1))
    return float(np.clip(np.mean(rs), 0.0, 0.8)) if rs else 0.0


def members(W, target):
    if target == "all":
        return list(range(len(W["ids"])))
    if target.startswith("group:"):
        g = target[6:]
        return [i for i, x in enumerate(W["groups"]) if x == g]
    return [W["ids"].index(target)] if target in W["ids"] else []


def _sim_many(tb, starts, H, Z0, Z1, U0, Z2, w, vol, drift, persist, hit, gstep, rho):
    """Joint futures. starts: S dicts; Z0, Z1, Z2: common normals (n, H); U0 (S, n, H) own/pool coin;
    vol/drift/persist/hit: (S, H) per body and step. Returns log levels (S, n, H)."""
    S, n = len(starts), Z0.shape[0]
    rng = np.random.RandomState(12345)
    E1 = rng.standard_normal((S, n, H))
    E2 = rng.standard_normal((S, n, H))
    a, c = math.sqrt(rho), math.sqrt(1 - rho)
    U1 = _phi(a * Z1[None] + c * E1)                   # regime draws, correlated across bodies
    U2 = _phi(a * Z2[None] + c * E2)                   # which move inside the regime, correlated too
    k0 = np.array([s["k0"] for s in starts])
    Pown = np.zeros((S, NB, NB))
    has = np.zeros((S, NB), bool)
    m = np.zeros(S)
    for s, st in enumerate(starts):
        C = st["C"]
        rows = C.sum(1, keepdims=True)
        Pown[s] = np.where(rows > 0, C / np.maximum(rows, 1), tb.P[st["k0"]])
        has[s] = rows[:, 0] > 0
        mo = np.concatenate([x for x in st["mv"] if x.size]) if any(x.size for x in st["mv"]) else np.array([tb.mean_all])
        m[s] = w * float(mo.mean()) + (1 - w) * tb.mean_all
    b = np.repeat(np.array([s["b0"] for s in starts])[:, None], n, 1)
    k = np.repeat(k0[:, None], n, 1)
    x = np.repeat(np.array([s["lL0"] for s in starts])[:, None], n, 1).astype(np.float64)
    cut0 = tb.cuts[starts[0]["t0"]]
    out = np.zeros((S, n, H))
    sidx = np.repeat(np.arange(S)[:, None], n, 1)
    eye = np.eye(NB)
    for h in range(H):
        own = (U0[:, :, h] < w) & has[sidx, b]
        row = np.where(own[..., None], Pown[sidx, b], tb.P[k, b])           # (S, n, NB)
        p = persist[:, h][:, None, None]
        row = np.where(p > 0, (1 - p) * row + p * eye[b], (1 + np.minimum(p, 0)) * row + (-np.minimum(p, 0)) * tb.marg[k])
        cum = np.cumsum(row, -1)
        b = np.minimum((U1[:, :, h][..., None] > cum).sum(-1), NB - 1)
        mv = np.empty((S, n))
        u2 = U2[:, :, h]
        for s, st in enumerate(starts):
            for bb in range(NB):
                sel = (b[s] == bb)
                if not sel.any():
                    continue
                po = st["mv"][bb]
                so = sel & own[s] & (po.size > 0)
                if so.any():
                    mv[s, so] = po[np.minimum((u2[s, so] * po.size).astype(int), po.size - 1)]
                sk = sel & ~so
                if sk.any():
                    for kk in np.unique(k[s, sk]):
                        z = sk & (k[s] == kk)
                        pk = tb.moves[kk][bb]
                        mv[s, z] = pk[np.minimum((u2[s, z] * pk.size).astype(int), pk.size - 1)]
        mv = m[:, None] + (mv - m[:, None]) * vol[:, h][:, None] + drift[:, h][:, None] + hit[:, h][:, None]
        x = x + mv
        out[:, :, h] = x
        if np.isfinite(cut0).all():
            k = np.searchsorted(cut0 + gstep * (h + 1), x.ravel()).reshape(S, n)
    return out


def run(world, target, changes=(), horizon=None, own=None, paths=1500, seed=0):
    W = FR.world(world)
    L, what, unit = FU.level(W)
    lL = np.log(L)
    N, T = lL.shape
    t0 = T - 1
    while t0 > 0 and np.isfinite(lL[:, t0]).sum() < 0.6 * np.isfinite(lL[:, t0 - 1]).sum():
        t0 -= 1
    mem = [i for i in members(W, target) if np.isfinite(lL[i, t0]) and np.isfinite(lL[i, :t0]).sum() >= 8]
    if not mem:
        raise ValueError("no body in {} has data for {}".format(target, W["dates"][t0][:7]))
    cal = FR.load(world, "futures_cal") or {}
    own = cal.get("best_own", 0.25) if own is None else own
    H = int(horizon or (10 if world == "countries" else 36))
    tb = FU.Tables(lL, 0, t0)
    g = FU._gstep(tb, t0)
    rho = _rho(tb, max(0, t0 - (30 if world == "countries" else 120)), t0)
    starts = [FU._start(tb, lL, i, t0, 0) for i in mem]
    S = len(mem)
    rs = np.random.RandomState(seed)
    Z0, Z1, Z2 = rs.standard_normal((paths, H)), rs.standard_normal((paths, H)), rs.standard_normal((paths, H))
    U0 = rs.random_sample((S, paths, H))
    one = np.ones((S, H))
    zero = np.zeros((S, H))
    base = _sim_many(tb, starts, H, Z0, Z1, U0, Z2, own, one, zero, zero, zero, g, rho)
    vol, drift, pers, hit = one.copy(), zero.copy(), zero.copy(), zero.copy()
    applied = []
    for c in changes or []:
        tgt = set(members(W, c.get("target") or target))
        rows = [j for j, i in enumerate(mem) if i in tgt]
        if not rows:
            continue
        a = max(1, int(c.get("from") or 1)) - 1
        e = min(H, int(c.get("to") or H)) if c.get("kind") != "shock" else a + 1
        v = float(c.get("value") or 0)
        kind = c.get("kind")
        if kind not in ("growth", "vol", "stability", "shock"):
            continue
        # spill: the same change, scaled, for the rest of the targeted bodies' own groups (an explicit assumption)
        spill = max(0.0, min(1.0, float(c.get("spill") or 0)))
        grp = {W["groups"][mem[j]] for j in rows}
        others = [j for j, i in enumerate(mem) if j not in rows and W["groups"][i] in grp] if spill else []
        for rr, f in ((rows, 1.0), (others, spill)):
            if not rr:
                continue
            if kind == "growth":
                drift[rr, a:e] += math.log1p(v * f)
            elif kind == "vol":
                vol[rr, a:e] *= 1 + (v - 1) * f
            elif kind == "stability":
                pers[rr, a:e] = np.clip(pers[rr, a:e] + v * f, -0.9, 0.9)
            else:
                hit[rr, a] += math.log1p(v * f)
        applied.append(dict(c, bodies=len(rows), spilled_to=len(others)))
    scen = _sim_many(tb, starts, H, Z0, Z1, U0, Z2, own, vol, drift, pers, hit, g, rho) if applied else None
    # aggregate: countries = total real GDP (per person x population, population growing as in its last 5 years);
    # companies = their combined share of the index
    if world == "countries":
        pop = W["extra"]["pop"]
        w0 = np.zeros(S)
        pg = np.zeros(S)
        for j, i in enumerate(mem):
            f = np.flatnonzero(np.isfinite(pop[i, :t0 + 1]) & (pop[i, :t0 + 1] > 0))
            w0[j] = pop[i, f[-1]] if f.size else 0.0
            pg[j] = float(np.mean(np.diff(np.log(pop[i, f[-6:]])))) if f.size >= 6 else 0.0
        mult = w0[:, None] * np.exp(pg[:, None] * np.arange(1, H + 1)[None, :])        # (S, H)
        agg = lambda X: (np.exp(X) * mult[:, None, :]).sum(0)
        v0 = float((np.exp(lL[mem, t0]) * w0).sum())
        agg_what = "total real GDP (constant 2015 US$)"
    else:
        agg = lambda X: np.exp(X).sum(0)
        v0 = float(np.exp(lL[mem, t0]).sum())
        agg_what = "combined share of the S&P 500's value"
    q = lambda A: np.percentile(A, [10, 25, 50, 75, 90], 0).T.tolist()
    A0 = agg(base)
    A1 = agg(scen) if scen is not None else None
    tab = []
    for j, i in enumerate(mem):
        b_ = float(np.median(base[j, :, -1]) - lL[i, t0])
        s_ = float(np.median(scen[j, :, -1]) - lL[i, t0]) if scen is not None else None
        tab.append({"id": W["ids"][i], "name": W["names"][i], "group": W["groups"][i], "base": b_, "scen": s_,
                    "delta": None if s_ is None else s_ - b_})
    tab.sort(key=lambda r: -(abs(r["delta"]) if r["delta"] is not None else abs(r["base"])))
    yrs = H if world == "countries" else H / 12
    cg = lambda v: (v / v0) ** (1 / yrs) - 1
    name = "the world" if target == "all" else target[6:] if target.startswith("group:") else W["names"][mem[0]]
    m0 = float(np.median(A0[:, -1]))
    sent = "{}: {} {} now; the median future grows {:+.1%} a year to {}, and 80% of futures end between {:+.1%} and {:+.1%} a year.".format(
        name, _f(v0, world), agg_what, cg(m0), FU._future(W, t0, H)[:4], cg(float(np.percentile(A0[:, -1], 10))), cg(float(np.percentile(A0[:, -1], 90))))
    if A1 is not None:
        m1 = float(np.median(A1[:, -1]))
        p_worse = float((A1[:, -1] < A0[:, -1]).mean())
        sent += " With the scenario the median grows {:+.1%} a year, {} by the end ({:+.1%}); the scenario ends lower in {:.0%} of the paired futures.".format(
            cg(m1), _f(m1, world), m1 / m0 - 1, p_worse)
    return {"world": world, "target": target, "name": name, "what": agg_what, "unit": "$" if world == "countries" else "share",
            "start": {"date": W["dates"][t0], "value": v0}, "dates": [FU._future(W, t0, h + 1) for h in range(H)], "horizon": H,
            "baseline": q(A0), "scenario": q(A1) if A1 is not None else None, "members": len(mem), "rho": round(rho, 3), "own": own,
            "applied": applied, "table": tab[:40], "sentence": sent,
            "left_out": [W["names"][i] for i in members(W, target) if i not in mem][:30]}


def _f(v, world):
    if world != "countries":
        return "{:.2%}".format(v)
    return "${:.3g} trillion".format(v / 1e12) if v >= 1e12 else "${:.3g} billion".format(v / 1e9)
