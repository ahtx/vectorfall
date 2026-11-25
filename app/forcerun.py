"""Learn → test → project for the force model (forcefield.py), and the futures with events that the map shows.

learn(world)    fits the combined force on the training period, chooses the blend and measures each force on the tuning
                period, fits the event chances, then learns everything again on training + tuning. Saves model.json.
test(world)     runs the model once over the test period it never saw: who grew, where bodies moved, which groups gained,
                which events came — next to "nothing changes", "momentum only" and "statistics only".
project(world)  learns once more on all the data, then runs futures to a chosen year, with events drawn at their learned
                chances plus the scenario events you add.
"""
import json
import math
import os
import time

import numpy as np

from . import forcefield as FF
from . import worlds as WD

try:
    import cupy as cp
except Exception:  # noqa: BLE001
    cp = None


def world(name, refresh=False):
    return WD.company_world(refresh) if name == "companies" else WD.country_world(refresh)


def _dir(name):
    d = os.path.join(FF.ROOT, name)
    os.makedirs(d, exist_ok=True)
    return d


def _save(name, kind, obj):
    fp = os.path.join(_dir(name), kind + ".json")
    with open(fp + ".tmp", "w") as f:
        json.dump(obj, f)
    os.replace(fp + ".tmp", fp)


def load(name, kind):
    fp = os.path.join(_dir(name), kind + ".json")
    return json.load(open(fp)) if os.path.exists(fp) else None


def periods(W):
    cfg = FF.CFG[W["world"]]
    last = W["dates"][-1]
    return {"train": list(cfg["train"]), "tune": list(cfg["tune"]), "test": [cfg["test"][0], last]}


# ================================================================ learning
GPU = lambda fn, label: fn()                                  # the models layer sets this to engine.run_on_gpu


def _fit(W, A, first, last, blend, names, free, job=None, lo=0.0, hi=1.0, label="learning", gens=30, off=()):
    win = FF.Windows(W, A, first, last, blend)
    x0 = np.array([0.0 if t["k"] in off else t["init"] for t in FF.terms(W["world"])])     # dropped forces stay at 0
    scale = np.array([t["scale"] for t in FF.terms(W["world"])])
    # one GPU turn per round, so other apps can use the card between rounds
    signs = np.array([t.get("sign", 0) for t in FF.terms(W["world"])], float)
    best, score = FF.cmaes(lambda P: GPU(lambda: win.score(P, names), "forces: " + label), x0, scale, free, gens=gens, job=job, lo=lo, hi=hi, label=label, signs=signs)
    return best, score, win


def learn(name, job=None):
    t0 = time.time()
    W = world(name)
    cfg = FF.CFG[name]
    A = FF.real_maps(W)
    pr = periods(W)
    T = FF.terms(name)
    names = [t["k"] for t in T]
    free = np.ones(len(T), bool)
    if job:
        job.step(0.02, "drawing the real map at every step")
    # 1) training period → tuning period, for each blend of map and geography
    tries = []
    nb = len(cfg["blends"])
    for k, b in enumerate(cfg["blends"]):
        lo, hi = 0.04 + 0.5 * k / nb, 0.04 + 0.5 * (k + 1) / nb
        P, s, _ = _fit(W, A, pr["train"][0], pr["train"][1], b, names, free, job, lo, hi,
                       "training period" + (" · blend {:.0%} map".format(b) if nb > 1 else ""))
        tune = FF.Windows(W, A, pr["tune"][0], pr["tune"][1], b, by_end=True)
        if not tune.items:
            raise ValueError("the tuning period has no windows to score")
        tot, ts, tp = GPU(lambda: tune.score(P[None], names, parts=True), "forces: tuning period")
        tries.append({"blend": b, "P": P, "train": s, "tune": float(tot[0]), "tune_size": float(ts[0]), "tune_pos": float(tp[0]), "win": tune})
    pick = min(tries, key=lambda x: x["tune"])
    # 2) what each force adds in the tuning period: set it to 0 (half-life: no momentum) and measure
    P, tune = pick["P"], pick["win"]
    contrib = {}
    for j, t in enumerate(T):
        if t["k"] == "halflife":
            continue
        Q = P.copy()
        Q[j] = 0.0
        tot, ts, tp = GPU(lambda: tune.score(Q[None], names, parts=True), "forces: what each force adds")
        contrib[t["k"]] = {"without": float(tot[0]), "delta": float(tot[0]) - pick["tune"]}
    # forces whose removal lowers the tuning error are dropped: they stay at 0 in the final fit (momentum takes its
    # half-life with it)
    off = {k for k, c in contrib.items() if c["delta"] < -0.002}
    if "momentum" in off:
        off.add("halflife")
    free_f = np.array([t["k"] not in off for t in T])
    # momentum only (the baseline), learned the same way
    mfree = np.array([t["k"] in ("momentum", "halflife") for t in T])
    if job:
        job.step(0.58, "momentum only: the tool learns the baseline")
    Pm, _, _ = _fit(W, A, pr["train"][0], pr["train"][1], pick["blend"], names, mfree, None, gens=12)
    # 3) events, on the training period
    if job:
        job.step(0.66, "event chances: logistic models on the training period")
    ev_train = FF.fit_events(W, A, pr["train"][0], pr["train"][1])
    # 4) learn again on training + tuning: these are the weights the test uses
    Pf, sf, winf = _fit(W, A, pr["train"][0], pr["tune"][1], pick["blend"], names, free_f, job, 0.70, 0.95, "training + tuning", off=off)
    Pmf, _, _ = _fit(W, A, pr["train"][0], pr["tune"][1], pick["blend"], names, mfree, None, gens=12)
    ev = FF.fit_events(W, A, pr["train"][0], pr["tune"][1])
    resid = GPU(lambda: _residual_scale(W, A, pr["train"][0], pr["tune"][1], pick["blend"], names, Pf), "forces: noise")
    model = {"world": name, "version": FF.VERSION, "periods": pr, "blend": pick["blend"], "names": names, "P": Pf.tolist(), "P_momentum": Pmf.tolist(),
             "P_train": P.tolist(), "blends": [{"blend": x["blend"], "train": x["train"], "tune": x["tune"], "tune_size": x["tune_size"], "tune_pos": x["tune_pos"]}
                                               for x in tries],
             "tune": {"score": pick["tune"], "size": pick["tune_size"], "pos": pick["tune_pos"]}, "contrib": contrib, "dropped": sorted(off),
             "events": ev, "events_train": {k: {kk: v[kk] for kk in ("n", "rate", "auc_train")} for k, v in ev_train.items() if "n" in v},
             "noise": resid, "windows": len(winf.items), "data": W["dates"][-1], "secs": round(time.time() - t0, 1),
             "terms": _describe(T, Pf, contrib, W, off)}
    _save(name, "model", model)
    return model


def _describe(T, P, contrib, W, off=()):
    """Each force in words: its learned value in its own units, and whether it helped in the tuning period."""
    out = []
    for j, t in enumerate(T):
        v = float(P[j])
        if t["k"] == "halflife":
            v = float(np.exp(np.clip(v, math.log(0.1), math.log(30))))
        c = contrib.get(t["k"])
        helps = None if c is None else ("helps" if c["delta"] > 0.005 else "hurts" if c["delta"] < -0.005 else "no effect")
        if t["k"] in off:
            helps = "dropped"
        out.append({"k": t["k"], "label": t["label"], "kind": t["kind"], "value": round(v, 4), "unit": t["unit"], "help": t["help"],
                    "verdict": helps, "delta": None if c is None else round(c["delta"], 4)})
    return out


def _residual_scale(W, A, first, last, blend, names, P):
    """How far bodies move each step beyond what the forces explain: the noise of the futures (size and position)."""
    j0, j1 = max(FF._di(W, first), FF.CFG[W["world"]]["win"]), FF._di(W, last)
    rs, ps, gs = [], [], []
    for t in range(j0, j1 - 1, max(1, (j1 - j0) // 30)):
        snap = FF.snapshot(W, A, t, blend)
        out = FF.replay(P[None], names, snap, 1, [1])
        g, X = out[1]
        g, X = FF._np(g)[0], FF._np(X)[0]
        a = FF.actual(W, A, snap, 1)
        ok = np.isfinite(a["g"])
        d = a["g"][ok] - g[ok]
        d = d - np.median(d)
        rs.append(np.median(np.abs(d)) * 1.4826)
        okx = a["okX"]
        if okx.sum() > 5:
            B = a["X"][okx]
            Xr = X[okx] @ FF._rot(X[okx], B)
            ps.append(float(np.sqrt(((Xr - B) ** 2).sum(1)).mean()))
            # the shared shock along the map: how much growth lines up with position
            Xc = snap["X"][ok]
            coef, *_ = np.linalg.lstsq(np.c_[np.ones(ok.sum()), Xc], d, rcond=None)
            gs.append(coef[1:])
    gs = np.array(gs) if gs else np.zeros((1, 2))
    return {"size": float(np.median(rs)) if rs else 0.05, "pos": float(np.median(ps)) if ps else 0.05,
            "shock": [float(x) for x in gs.std(0)]}


# ================================================================ futures with events (stochastic)
def simulate(W, A, model, t0, steps, ens=128, scenarios=(), seed=0, sample_events=True, job=None):
    """Run `ens` futures from step t0. Bodies keep their identity; new companies fill pooled slots by sector. Returns
    frames for the map (mean share, p10/p90, the chance to still be in the film), one sample future with its events, and
    the event counts per step."""
    xp = cp if cp is not None else np
    rs = np.random.RandomState(seed)
    name = W["world"]
    names, P = model["names"], np.array(model["P"])
    p = FF._params(P[None], names)
    p = {k: float(v[0]) for k, v in p.items()}
    snap = FF.snapshot(W, A, t0, model["blend"])
    ix = snap["ix"]
    N = len(ix)
    dt = snap["dt"]
    ev = model["events"]
    noise = model["noise"]
    film = W["film"]
    # pooled slots for arrivals (companies): by sector, in proportion to past arrivals
    pool, pool_g = 0, []
    if film:
        rate = ev["entry"]["per_step"]
        expect = rate * steps
        G = ev["entry"]["groups"] or snap["gnames"]
        for g in snap["gnames"]:
            k = int(math.ceil(2.5 * expect * max(G.count(g), 1) / max(len(G), 1))) + 2
            pool_g += [g] * k
        pool = len(pool_g)
    S = N + pool
    gname = list(snap["grp"]) + pool_g
    gi = np.array([snap["gnames"].index(g) if g in snap["gnames"] else 0 for g in gname])
    X = np.zeros((S, 2))
    X[:N] = snap["X"]
    for k in range(pool):
        X[N + k] = snap["cent"][gi[N + k]] + rs.standard_normal(2) * 0.25
    vol = np.r_[snap["vol"], [float(np.median(snap["vol"][snap["gi"] == gi[N + k]])) if (snap["gi"] == gi[N + k]).any() else float(np.median(snap["vol"]))
                              for k in range(pool)]]
    l = np.full((ens, S), -50.0)
    l[:, :N] = snap["l"][None]
    m = np.zeros((ens, S))
    m[:, :N] = snap["m"][None]
    alive = np.zeros((ens, S), bool)
    alive[:, :N] = True
    used = np.zeros((ens, len(snap["gnames"])), int)       # pool slots taken, per sector
    slot0 = {g: N + pool_g.index(g) for g in set(pool_g)}
    slotn = {g: pool_g.count(g) for g in set(pool_g)}
    ex = {k: np.r_[v, np.zeros(pool)] for k, v in snap["ex"].items()}
    conf = np.tile(ex.get("conflict", np.zeros(S)), (ens, 1)) if name == "countries" else None
    boost = np.zeros((ens, S))                              # extra noise after an event, fading
    zvol = FF._z(np.log(vol))
    cent = snap["cent"][gi]
    decay = math.exp(-math.log(2) * dt / p["halflife"])
    # countries: geography for nearby conflict and the blended kernel
    Dg2 = None
    if "Dg2" in snap:
        Dg2 = snap["Dg2"]
    sc = {}
    for s_ in scenarios or []:
        sc.setdefault(int(s_["step"]), []).append(s_)
    if name == "countries":
        since = {}
        for typ in FF.EVENT_TYPES["countries"]:
            E = FF._event_matrix(W, typ)[ix, :t0 + 1]
            last = np.array([t0 - np.where(r)[0].max() if r.any() else 99 for r in E], float)
            since[typ] = np.tile(last, (ens, 1))
        snap["since"] = since
    frames, counts, sample = [], [], []
    w0 = np.exp(snap["l"]) / np.exp(snap["l"]).sum()
    q = lambda a: np.percentile(a, [10, 90], axis=0)

    def record(s, w, inf):
        lo, hi = q(w[:, :N])
        newc = w[:, N:].sum(1)
        gs = np.zeros((ens, len(snap["gnames"])))
        for g in range(len(snap["gnames"])):
            gs[:, g] = (w * (gi == g)[None]).sum(1)
        frames.append({"step": s, "w": _r(w[:, :N].mean(0)), "lo": _r(lo), "hi": _r(hi), "in": _r(inf[:, :N].mean(0), 3),
                       "x": np.round(X[:N], 3).tolist(), "new": round(float(newc.mean()), 5),
                       "g": _r(gs.mean(0)), "g_lo": _r(np.percentile(gs, 10, 0)), "g_hi": _r(np.percentile(gs, 90, 0)),
                       "s_w": _r(w[0, :N]), "s_new": [[int(k), round(float(w[0, N + k]), 6)] for k in range(pool) if alive[0, N + k] and w[0, N + k] > 0]})

    def shares():
        lw = np.where(alive, l, -np.inf)
        mx = lw.max(1, keepdims=True)
        w = np.exp(lw - mx)
        w = np.where(alive, w, 0)
        return w / w.sum(1, keepdims=True)

    w = shares()
    record(0, w, alive.astype(float))
    pos = np.array([[0.0, 0.0]])
    for s in range(1, steps + 1):
        D2 = ((X[:, None] - X[None]) ** 2).sum(2)
        if Dg2 is not None and model["blend"] < 1:
            Dfull = np.full((S, S), D2.mean() * 4)
            Dfull[:N, :N] = Dg2
            np.fill_diagonal(Dfull, 0.0)
            D2 = model["blend"] * D2 + (1 - model["blend"]) * Dfull
        K = np.exp(-D2 / (2 * 0.35 ** 2))
        np.fill_diagonal(K, 0)
        Kx = xp.asarray(K)
        wx, lx, mx_ = xp.asarray(w), xp.asarray(np.where(alive, l, 0)), xp.asarray(m)
        S1 = FF._np(wx @ Kx.T) + 1e-12
        lead_raw = (np.where(alive, l, 0) * S1 - FF._np((wx * lx) @ Kx.T)) / S1
        cont = FF._np((wx * mx_) @ Kx.T) / S1

        def zr(a):
            a = np.where(alive, a, np.nan)
            mu, sd = np.nanmean(a, 1, keepdims=True), np.nanstd(a, 1, keepdims=True) + 1e-9
            return np.nan_to_num((a - mu) / sd)
        f = p["momentum"] * m + p["size"] * zr(l) + p["crowding"] * zr(np.log(S1)) + p["lead"] * zr(lead_raw) + p["contagion"] * cont + p["volatility"] * zvol[None]
        if name == "countries":
            Kn = K / (K.sum(1, keepdims=True) + 1e-12)
            f = f + p["catchup"] * ex["catchup"][None] + p["conflict"] * conf + p["nearconflict"] * (conf @ Kn.T)
            for k in ("demography", "health", "investment"):
                if k in p and k in ex:
                    f = f + p[k] * ex[k][None]
        shock = rs.standard_normal((ens, 2)) * np.array(noise["shock"])[None]
        eps = rs.standard_normal((ens, S)) * (vol[None] * math.sqrt(1.0) * (1 + boost))
        l = l + dt * f + eps * 0.9 + shock @ X.T * 0.5
        m = m * decay
        boost *= 0.6
        evs = []
        if sample_events:
            evs = _events_step(W, model, s, l, m, alive, w, K, X, gi, N, pool, slot0, slotn, used, snap, ex, conf, boost, rs, ens, vol)
        for e in sc.get(s, []):                                 # scenario events: forced in every future
            evs += _apply_scenario(W, model, e, l, alive, conf, boost, snap, N, ens, w, K)
        w = shares()
        # positions: the position forces on the average future (shared by all futures)
        wm = w.mean(0)
        S1m = K @ wm + 1e-12
        pullv = (K * wm[None]) @ X / S1m[:, None] - X
        X = X + dt * (p["pull"] * pullv + p["home"] * (cent - X))
        counts.append(_count(evs, ens))
        sample.append([e for e in evs if e.get("ens") == 0])
        record(s, w, alive.astype(float))
        if job and s % max(1, steps // 10) == 0:
            job.step(0.1 + 0.85 * s / steps, "futures: step {} of {}".format(s, steps))
    ids = [W["ids"][i] for i in ix]
    for evl in sample:
        for e in evl:
            e["id"] = ids[e["i"]] if e["i"] < N else None
            if e.get("j") is not None:
                e["by"] = ids[e["j"]] if e["j"] < N else None
    return {"ix": ix, "frames": frames, "counts": counts, "sample_events": sample, "pool": [{"group": g, "x": [round(float(v), 3) for v in X[N + k]]} for k, g in enumerate(pool_g)],
            "w0": w0}


def _r(a, d=4):
    return [float("{:.{}g}".format(float(v), d)) for v in a]


def _count(evs, ens):
    c = {}
    for e in evs:
        c[e["type"]] = c.get(e["type"], 0) + 1.0 / ens
    return {k: round(v, 4) for k, v in c.items()}


def _events_step(W, model, s, l, m, alive, w, K, X, gi, N, pool, slot0, slotn, used, snap, ex, conf, boost, rs, ens, vol):
    """Draw this step's events in every future, from the learned chances. Mutates the state. Returns the events."""
    ev = model["events"]
    out = []
    name = W["world"]
    S = l.shape[1]
    if name == "companies":
        film = alive
        for e in range(ens):
            live = np.where(film[e])[0]
            if len(live) < 10:
                continue
            le = l[e, live]
            rank = np.argsort(np.argsort(le)) / max(1, len(live) - 1)
            mm = np.clip(m[e, live] / 12.0, -1, 1)                 # the chances were learned on growth per month
            zl = FF._z(le)
            zv = FF._z(np.log(vol[live]))
            pe = FF.hazard_p(ev, "exit", np.stack([rank, mm, zv], 1))
            pm = FF.hazard_p(ev, "merger", np.stack([zl, mm, zv], 1))
            ps = FF.hazard_p(ev, "split", zl[:, None])
            pc = FF.hazard_p(ev, "collapse", zl[:, None])
            pj = FF.hazard_p(ev, "jump", zv[:, None])
            u = rs.random_sample((5, len(live)))
            gone = 0
            for k in np.where(u[1] < pm)[0]:                   # mergers: absorbed by a bigger neighbour
                i = live[k]
                if not alive[e, i]:
                    continue
                cand = np.where(alive[e] & (l[e] > l[e, i] + math.log(2)))[0]
                if not len(cand):
                    continue
                wt = K[i, cand] * np.exp(l[e, cand] - l[e, cand].max()) + 1e-12
                j = int(cand[rs.choice(len(cand), p=wt / wt.sum())])
                l[e, j] = np.logaddexp(l[e, j], l[e, i])
                alive[e, i] = False
                gone += 1
                out.append({"ens": e, "step": s, "type": "merger", "i": int(i), "j": j})
            for k in np.where(u[0] < pe)[0]:
                i = live[k]
                if alive[e, i]:
                    alive[e, i] = False
                    gone += 1
                    out.append({"ens": e, "step": s, "type": "exit", "i": int(i)})
            for k in np.where(u[3] < pc)[0]:
                i = live[k]
                if alive[e, i]:
                    alive[e, i] = False
                    gone += 1
                    out.append({"ens": e, "step": s, "type": "collapse", "i": int(i)})
            for k in np.where(u[4] < pj)[0]:
                i = live[k]
                if alive[e, i]:
                    jump = rs.choice([-1, 1]) * abs(rs.normal(0.35, 0.12))
                    l[e, i] += jump
                    boost[e, i] += 0.5
                    out.append({"ens": e, "step": s, "type": "jump", "i": int(i), "value": round(float(jump), 3)})
            for k in np.where(u[2] < ps)[0]:                   # a split: a new company takes a part of the parent
                i = live[k]
                slot = _take(e, gi[i], snap, slot0, slotn, used, N)
                if slot is None or not alive[e, i]:
                    continue
                fr = float(rs.choice(ev["entry"]["split_frac"]))
                l[e, slot] = l[e, i] + math.log(fr)
                l[e, i] += math.log(1 - fr)
                m[e, slot] = m[e, i]
                alive[e, slot] = True
                gone -= 1
                out.append({"ens": e, "step": s, "type": "split", "i": int(slot), "j": int(i)})
            # the S&P 500 keeps 500: every body that left is replaced by a new one (size from past arrivals)
            for _ in range(max(0, gone)):
                g = rs.choice(ev["entry"]["groups"]) if ev["entry"]["groups"] else snap["gnames"][0]
                gidx = snap["gnames"].index(g) if g in snap["gnames"] else 0
                slot = _take(e, gidx, snap, slot0, slotn, used, N)
                if slot is None:
                    continue
                rel = float(rs.choice(ev["entry"]["rel_size"])) if ev["entry"]["rel_size"] else 0.0
                l[e, slot] = float(np.median(l[e, alive[e]])) + rel
                m[e, slot] = 0.0
                alive[e, slot] = True
                out.append({"ens": e, "step": s, "type": "entry", "i": int(slot)})
    else:
        since = snap["since"]                                   # steps since each event type last hit each body, per future
        for typ in ("war", "civilwar", "uprising", "coup", "currency"):
            same = (since[typ] < 5).astype(float)
            coup5 = (since["coup"] < 5).astype(float)
            Kg = K / (K.sum(1, keepdims=True) + 1e-12)
            near = conf @ Kg.T
            rich = ex.get("catchup", np.zeros(S))
            Xh = np.stack([same, conf, near, coup5, np.broadcast_to(rich, (ens, S)), np.clip(m, -1, 1)], 2).reshape(ens * S, 6)
            pr = FF.hazard_p(ev, typ, Xh).reshape(ens, S)
            hit = rs.random_sample((ens, S)) < pr
            hit &= alive
            eff = ev[typ].get("effect", {})
            samp = eff.get("samples") or [eff.get("mean", 0.0)]
            for e, i in zip(*np.where(hit)):
                d = float(rs.choice(samp))
                l[e, i] += d
                boost[e, i] += 1.0
                if typ in ("war", "civilwar", "uprising"):
                    conf[e, i] = max(conf[e, i], {"uprising": 1 / 3, "civilwar": 2 / 3, "war": 1.0}[typ])
                since[typ][e, i] = 0
                out.append({"ens": int(e), "step": s, "type": typ, "i": int(i), "value": round(d, 3)})
        for v in since.values():
            v += 1
        conf *= 0.8                                              # conflicts fade unless they start again
    return out


def _take(e, g, snap, slot0, slotn, used, N):
    gname = snap["gnames"][g]
    if gname not in slot0 or used[e, g] >= slotn[gname]:
        return None
    k = slot0[gname] + used[e, g]
    used[e, g] += 1
    return k


def _apply_scenario(W, model, sce, l, alive, conf, boost, snap, N, ens, w, K):
    """A scenario event you added: it happens in every future, with the size you gave (or the learned average)."""
    ids = [W["ids"][i] for i in snap["ix"]]
    if sce["id"] not in ids:
        return []
    i = ids.index(sce["id"])
    typ = sce["type"]
    out = []
    eff = model["events"].get(typ, {}).get("effect", {})
    d = sce.get("value")
    if d is None:
        d = eff.get("mean", 0.0)
    if typ in ("exit", "collapse"):
        alive[:, i] = False
    elif typ == "merger" and sce.get("by") in ids:
        j = ids.index(sce["by"])
        l[:, j] = np.logaddexp(l[:, j], l[:, i])
        alive[:, i] = False
    else:
        l[:, i] += float(d)
        boost[:, i] += 1.0
        if conf is not None and typ in ("war", "civilwar", "uprising"):
            conf[:, i] = np.maximum(conf[:, i], {"uprising": 1 / 3, "civilwar": 2 / 3, "war": 1.0}[typ])
    for e in range(ens):
        out.append({"ens": e, "step": sce["step"], "type": typ, "i": i, "value": d, "scenario": True,
                    "j": ids.index(sce["by"]) if sce.get("by") in ids else None})
    return out


# ================================================================ test: once, on the period the model never saw
def test(name, ens=128, job=None):
    model = load(name, "model")
    if not model:
        raise ValueError("learn the forces first")
    W = world(name)
    A = FF.real_maps(W)
    cfg = FF.CFG[name]
    t0 = FF._di(W, model["periods"]["tune"][1])
    steps = len(W["dates"]) - 1 - t0
    names = model["names"]
    snap = FF.snapshot(W, A, t0, model["blend"])
    checks = sorted(set([c for c in cfg["checks"] if c <= steps] + [steps]))
    acts = {c: FF.actual(W, A, snap, c) for c in checks}
    w0 = np.exp(snap["l"]) / np.exp(snap["l"]).sum()
    P = np.array(model["P"])[None]
    Pm = np.array(model["P_momentum"])[None]
    out = FF.replay(np.r_[P, Pm], names, snap, steps, checks)
    train = FF.Windows(W, A, model["periods"]["train"][0], model["periods"]["tune"][1], model["blend"])
    stats = FF.stats_baseline(train, names)(snap)
    rows = []
    for c in checks:
        g, X = out[c]
        g, X = FF._np(g), FF._np(X)
        es, ep = FF._errors(g, X, acts[c], w0)
        bs, bp = FF._errors(np.zeros((1, len(w0))), snap["X"][None], acts[c], w0)
        sc_ = stats[c] if c in stats else stats[max(stats)] * (c / float(max(stats)))     # growth gaps widen about linearly
        ss, _ = FF._errors(sc_[None], snap["X"][None], acts[c], w0)
        ok = np.isfinite(acts[c]["g"])
        rho = lambda pred: _spearman(pred[ok], acts[c]["g"][ok])
        rows.append({"step": c, "date": W["dates"][t0 + c],
                     "size": {"forces": float(es[0]), "momentum": float(es[1]), "statistics": float(ss[0]), "nothing": float(bs[0])},
                     "pos": {"forces": float(ep[0]), "momentum": float(ep[1]), "nothing": float(bp[0])},
                     "rank": {"forces": rho(g[0]), "momentum": rho(g[1]), "statistics": rho(sc_)}})
    if job:
        job.step(0.3, "futures over the test period, with events")
    sim = simulate(W, A, model, t0, steps, ens=ens, job=job)
    real = _real_path(W, A, snap, steps)
    evcmp = _events_vs_real(W, model, sim, t0, steps, snap)
    groups = _group_scores(W, snap, sim, real)
    res = {"world": name, "t0": W["dates"][t0], "t1": W["dates"][-1], "steps": steps, "rows": rows, "events": evcmp, "groups": groups,
           "frames": _frames_out(W, sim, real, t0), "bodies": _bodies(W, snap, sim, real), "group_names": snap["gnames"],
           "sample_events": sim["sample_events"], "pool": sim["pool"], "verdict": _verdict(rows, groups, name)}
    _save(name, "test", res)
    return res


def _spearman(a, b):
    if len(a) < 10:
        return None
    ra, rb = np.argsort(np.argsort(a)), np.argsort(np.argsort(b))
    return round(float(np.corrcoef(ra, rb)[0, 1]), 4)


def _real_path(W, A, snap, steps):
    ix = snap["ix"]
    t0 = snap["t"]
    out = []
    for s in range(steps + 1):
        t = t0 + s
        mem = W["member"][:, t] & np.isfinite(W["size"][:, t])
        tot = W["size"][mem, t].sum()
        w = np.where(mem[ix] & np.isfinite(W["size"][ix, t]), W["size"][ix, t], 0.0) / tot
        known = np.isfinite(W["size"][ix, t]) | W["film"]           # a country that has not reported yet is unknown, not gone
        g = {}
        for i in np.where(mem)[0]:
            g[W["groups"][i]] = g.get(W["groups"][i], 0) + float(W["size"][i, t] / tot)
        X = A[ix, t]
        out.append({"w": [v if k else None for v, k in zip(_r(w), known)], "x": [[round(float(a), 3), round(float(b), 3)] if np.isfinite(a) else None for a, b in X],
                    "in": [int(v) for v in mem[ix]], "g": {k: round(v, 5) for k, v in g.items()}, "new": round(float(1 - w.sum()), 5)})
    return out


def _events_vs_real(W, model, sim, t0, steps, snap):
    """For each event type: how many the futures expected over the test period, how many really happened, and how well
    the chances ranked the bodies they really hit."""
    real = {}
    ids = set(W["ids"][i] for i in snap["ix"])
    for e in W["events"]:
        if e.get("step") is not None and t0 < e["step"] <= t0 + steps:
            real.setdefault(e["type"], []).append(e)
    exp = {}
    for c in sim["counts"]:
        for k, v in c.items():
            exp[k] = exp.get(k, 0) + v
    out = []
    for typ in FF.EVENT_TYPES[W["world"]] + (["entry"] if W["film"] else []):
        r = real.get(typ, [])
        out.append({"type": typ, "words": FF.EVENT_WORDS.get(typ, typ), "expected": round(exp.get(typ, 0.0), 1), "real": len(r),
                    "learned": model["events"].get(typ, {}).get("learned", True),
                    "list": [{"date": e["date"], "id": e["id"], "name": e.get("name"), "by": e.get("by"), "text": e.get("text")} for e in r[:80]]})
    return out


def _group_scores(W, snap, sim, real):
    """Wrong-group share at the end. Countries: only over the bodies that have a size at both ends (a country that has
    not reported its last year is left out on all sides, so its share does not count as moved). Companies: the film."""
    last = sim["frames"][-1]
    gn = snap["gnames"]
    if W["film"]:
        rg, g0 = real[-1]["g"], real[0]["g"]
        l1 = 0.5 * sum(abs(last["g"][k] - rg.get(g, 0)) for k, g in enumerate(gn))
        p1 = 0.5 * sum(abs(g0.get(g, 0) - rg.get(g, 0)) for g in gn)
        return {"forces": round(l1, 4), "nothing": round(p1, 4)}
    gi = snap["gi"]
    rw = np.array([v if v is not None else np.nan for v in real[-1]["w"]], float)
    ok = np.isfinite(rw) & (rw > 0)

    def gs(w):
        w = np.where(ok, np.nan_to_num(np.asarray(w, float)), 0.0)
        w = w / max(w.sum(), 1e-12)
        return np.array([w[gi == k].sum() for k in range(len(gn))])
    a, b, c = gs(last["w"]), gs(rw), gs([v if v is not None else np.nan for v in real[0]["w"]])
    return {"forces": round(float(0.5 * np.abs(a - b).sum()), 4), "nothing": round(float(0.5 * np.abs(c - b).sum()), 4), "bodies": int(ok.sum())}


def _frames_out(W, sim, real, t0):
    out = []
    for k, f in enumerate(sim["frames"]):
        r = real[k] if real and k < len(real) else None
        t = t0 + f["step"]
        out.append({"step": f["step"], "date": W["dates"][t] if t < len(W["dates"]) else _future_date(W, t),
                    "w": f["w"], "lo": f["lo"], "hi": f["hi"], "in": f["in"], "x": f["x"], "g": f["g"], "g_lo": f["g_lo"], "g_hi": f["g_hi"],
                    "new": f["new"], "s_w": f["s_w"], "s_new": f["s_new"],
                    "rw": r["w"] if r else None, "rx": r["x"] if r else None, "rin": r["in"] if r else None, "rg": r["g"] if r else None,
                    "rnew": r["new"] if r else None})
    return out


def _future_date(W, t):
    last = W["dates"][-1]
    extra = t - (len(W["dates"]) - 1)
    if W["step"] == "year":
        return "{:04d}{}".format(int(last[:4]) + extra, last[4:])
    y, mo = int(last[:4]), int(last[5:7])
    k = y * 12 + mo - 1 + extra
    import calendar
    y2, m2 = divmod(k, 12)
    return "{:04d}-{:02d}-{:02d}".format(y2, m2 + 1, calendar.monthrange(y2, m2 + 1)[1])


def _bodies(W, snap, sim, real):
    ix = snap["ix"]
    last = sim["frames"][-1]
    out = []
    for k, i in enumerate(ix):
        b = {"id": W["ids"][i], "name": W["names"][i], "group": W["groups"][i], "w0": round(float(sim["w0"][k]), 6), "w": last["w"][k],
             "lo": last["lo"][k], "hi": last["hi"][k], "stay": last["in"][k], "est": bool(W["est"][i, snap["t"]])}
        if real:
            b["rw"] = real[-1]["w"][k]
            b["rin"] = real[-1]["in"][k]
        out.append(b)
    return out


def _verdict(rows, groups, name):
    r = rows[-1]
    s, p = r["size"], r["pos"]
    base = {k: v for k, v in s.items() if k != "forces"}
    best = min(base, key=base.get)
    beat = s["forces"] < base[best] - 1e-6
    words = {"momentum": "momentum only", "statistics": "statistics only", "nothing": "nothing changes"}
    if beat:
        txt = "The forces predicted who grew better than every baseline (the best baseline was {}).".format(words[best])
    elif abs(s["forces"] - base[best]) < 1e-6:
        txt = "The forces gave the same answer as {}. The other forces add nothing on this test.".format(words[best])
    else:
        txt = "The forces did not beat {} on who grew.".format(words[best])
    txt += " Position error: forces {:.3f}, nothing changes {:.3f}.".format(p["forces"], p["nothing"])
    txt += " Groups: forces put {:.1%} of the whole in the wrong group; nothing changes {:.1%}.".format(groups["forces"], groups["nothing"])
    return {"beat": bool(beat), "best": "forces" if beat else best, "text": txt}


# ================================================================ projection
def project(name, to_year=None, ens=128, scenarios=(), job=None):
    model = load(name, "model")
    if not model:
        raise ValueError("learn the forces first")
    W = world(name)
    A = FF.real_maps(W)
    cfg = FF.CFG[name]
    full = load(name, "model_all")
    stamp = [round(float(v), 6) for v in model["P"]] + [model.get("secs")]          # which learned model it came from
    if not full or full.get("data") != W["dates"][-1] or full.get("version") != FF.VERSION or full.get("from_model") != stamp:
        if job:
            job.step(0.05, "the tool learns once more on all the data (for the projection)")
        T = FF.terms(name)
        names = [t["k"] for t in T]
        off = set(model.get("dropped") or [])
        Pf, _, _ = _fit(W, A, model["periods"]["train"][0], W["dates"][-1 - cfg["fit_h"]], model["blend"], names, np.array([t["k"] not in off for t in T]), job, 0.05, 0.5,
                        "all the data", off=off)
        evs = FF.fit_events(W, A, model["periods"]["train"][0], W["dates"][-2])
        full = dict(model, P=Pf.tolist(), events=evs, data=W["dates"][-1], terms=_describe(T, Pf, model["contrib"], W, off), from_model=stamp)
        full["noise"] = GPU(lambda: _residual_scale(W, A, model["periods"]["train"][0], W["dates"][-2], model["blend"], names, Pf), "forces: noise")
        _save(name, "model_all", full)
    t0 = len(W["dates"]) - 1
    to_year = int(to_year or cfg["project_to"])
    steps = max(1, (to_year - int(W["dates"][-1][:4])) * cfg["spy"] + (12 - int(W["dates"][-1][5:7]) if cfg["spy"] == 12 else 0))
    sim = simulate(W, A, full, t0, steps, ens=ens, scenarios=_scen_steps(W, scenarios, t0), job=job)
    snap = FF.snapshot(W, A, t0, full["blend"])
    res = {"world": name, "t0": W["dates"][t0], "to": _future_date(W, t0 + steps), "steps": steps, "frames": _frames_out(W, sim, None, t0),
           "bodies": _bodies(W, snap, sim, None), "group_names": snap["gnames"], "sample_events": sim["sample_events"], "pool": sim["pool"],
           "events": _event_odds(W, full, sim, snap), "terms": full["terms"], "scenarios": list(scenarios or [])}
    _save(name, "project", res)
    return res


def _scen_steps(W, scenarios, t0):
    out = []
    for s in scenarios or []:
        y = int(str(s.get("date", ""))[:4] or 0)
        if not y:
            continue
        if W["step"] == "year":
            step = y - int(W["dates"][-1][:4])
        else:
            mo = int(str(s.get("date", ""))[5:7] or 6)
            step = (y - int(W["dates"][-1][:4])) * 12 + mo - int(W["dates"][-1][5:7])
        if step >= 1:
            out.append(dict(s, step=step))
    return out


def _event_odds(W, model, sim, snap):
    """Over the projection: the expected number of each event, and the bodies most likely to be hit."""
    ens = len(sim["frames"][0]["w"]) and 1
    tot = {}
    for c in sim["counts"]:
        for k, v in c.items():
            tot[k] = tot.get(k, 0) + v
    return [{"type": t, "words": FF.EVENT_WORDS.get(t, t), "expected": round(tot.get(t, 0.0), 1),
             "rate": model["events"].get(t, {}).get("rate"), "learned": model["events"].get(t, {}).get("learned", True)}
            for t in FF.EVENT_TYPES[W["world"]] + (["entry"] if W["film"] else [])]


def refit_events(name):
    """Fit the event chances again on the saved model's periods (the forces stay as they are)."""
    model = load(name, "model")
    if not model:
        raise ValueError("learn the forces first")
    W = world(name)
    A = FF.real_maps(W)
    model["events"] = FF.fit_events(W, A, model["periods"]["train"][0], model["periods"]["tune"][1])
    ev_train = FF.fit_events(W, A, model["periods"]["train"][0], model["periods"]["train"][1])
    model["events_train"] = {k: {kk: v[kk] for kk in ("n", "rate", "auc_train")} for k, v in ev_train.items() if "n" in v}
    _save(name, "model", model)
    full = load(name, "model_all")
    if full:
        os.remove(os.path.join(_dir(name), "model_all.json"))
    return {k: (v.get("n"), v.get("auc_train")) for k, v in model["events"].items() if "n" in v}
