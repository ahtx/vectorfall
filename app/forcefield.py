"""The force model: one combined force, learned from the past, tested on a period it never saw, then projected.

Each body has a size l (log of its share of the whole), a momentum m (its recent growth above the whole, per year) and a
position X on the map. The map is the co-movement map: bodies whose changes went up and down together sit together
(classical MDS of sqrt(2(1 - correlation)) over a trailing window, each step rotated onto the step before). The REAL map
at every step is drawn from real data; the simulation moves its own copy with the position forces, and the test
compares the two.

The combined force on a body, per year (every term has a weight that the training period learns):
  size     momentum (its own excess growth, which fades with a half-life) · size (bigger or smaller than the rest) ·
           crowding (how much mass sits near it on the map) · lead (bigger than its neighbours) · contagion (its
           neighbours' momentum) · volatility · [countries] catch-up (GDP per person) · conflict (its own) ·
           nearby conflict
  position pull (toward heavy neighbours) · home (toward its own group's centre)
Neighbours are weighted by a kernel exp(-d^2 / 2h^2) on the map; for countries the distance blends the map with
geography (the blend that does best in the tuning period wins).

Learning: CMA-ES over the weights. Each candidate replays every training window (start, then 6/12/24 months or 1/3/5
years); the score is the error in who grew relative to the others plus the error in where they moved, each divided by
the same error for "nothing changes". Tuning period: choose the blend, measure what each force adds. Then the weights
are learned again on training + tuning, and the test period is run once. Events are separate: their chances come from
logistic regressions on the event ledger (worlds.py), their sizes from what the events did in the training period.
"""
import json
import math
import os
import time

import numpy as np

from . import worlds as WD

try:
    import cupy as cp
except Exception:  # noqa: BLE001
    cp = None

ROOT = os.environ.get("VF_DATA", "/srv/data") + "/forces"
VERSION = 3

CFG = {
    "companies": {"spy": 12, "win": 36, "mom": 12, "fit_h": 24, "checks": [6, 12, 24], "every": 6, "h": 0.35,
                  "train": ("2011-01-31", "2021-12-31"), "tune": ("2022-01-31", "2023-12-31"), "test": ("2024-01-31", None),
                  "project_to": 2030, "blends": [1.0]},
    "countries": {"spy": 1, "win": 15, "mom": 5, "fit_h": 5, "checks": [1, 3, 5], "every": 1, "h": 0.35,
                  "train": ("1980-12-31", "2015-12-31"), "tune": ("2016-12-31", "2020-12-31"), "test": ("2021-12-31", None),
                  "project_to": 2035, "blends": [1.0, 0.5, 0.0]},
}

# The terms of the combined force. kind: size (pushes growth) or position (moves on the map). scale: a typical size of
# the weight, used to start the search and to keep weights small unless the data asks for more.
TERMS = [
    {"k": "momentum", "kind": "size", "scale": 0.3, "init": 0.3, "label": "Momentum",
     "unit": "of the excess growth continues", "help": "A body that grew faster than the whole keeps this part of that extra growth."},
    {"k": "halflife", "kind": "size", "scale": 1.0, "init": 0.0, "label": "Momentum half-life",
     "unit": "years", "help": "After this time, half of the extra growth is gone.", "log": True},
    {"k": "size", "kind": "size", "scale": 0.03, "init": 0.0, "label": "Size",
     "unit": "per year, per standard deviation of size", "help": "Above 0, big bodies grow faster. Below 0, small bodies catch up."},
    {"k": "crowding", "kind": "size", "scale": 0.03, "init": 0.0, "label": "Crowding",
     "unit": "per year, per standard deviation", "help": "Below 0, a body with much mass near it on the map grows slower (competition)."},
    {"k": "lead", "kind": "size", "scale": 0.03, "init": 0.0, "label": "Lead over neighbours",
     "unit": "per year, per standard deviation", "help": "Above 0, a body that is bigger than its neighbours takes share from them."},
    {"k": "contagion", "kind": "size", "scale": 0.3, "init": 0.0, "label": "Contagion",
     "unit": "of the neighbours' excess growth", "help": "Above 0, a body grows when its neighbours grow (a sector or a region moves together)."},
    {"k": "volatility", "kind": "size", "scale": 0.03, "init": 0.0, "label": "Volatility",
     "unit": "per year, per standard deviation", "help": "Below 0, bodies that move a lot grow slower."},
    {"k": "catchup", "kind": "size", "scale": 0.03, "init": 0.0, "label": "Catch-up", "world": "countries",
     "unit": "per year, per standard deviation of GDP per person", "help": "Below 0, poorer countries grow faster than rich ones."},
    {"k": "demography", "kind": "size", "scale": 0.03, "init": 0.0, "opt": True, "label": "Working-age share", "world": "countries",
     "unit": "per year, per standard deviation", "help": "Above 0, countries with more people aged 15-64 grow faster (the demographic dividend). Beyond income it ranked growth in every start year since 1990."},
    {"k": "health", "kind": "size", "scale": 0.03, "init": 0.0, "opt": True, "label": "Life expectancy", "world": "countries",
     "unit": "per year, per standard deviation", "help": "Above 0, healthier countries (for their income) grow faster."},
    {"k": "investment", "kind": "size", "scale": 0.03, "init": 0.0, "opt": True, "label": "Investment", "world": "countries",
     "unit": "per year, per standard deviation", "help": "Above 0, countries that invest more of their GDP grow faster (the one robust growth correlate in Levine & Renelt 1992)."},
    {"k": "conflict", "kind": "size", "scale": 0.05, "init": 0.0, "sign": -1, "label": "Conflict", "world": "countries",
     "unit": "per year, at full war", "help": "The change in growth while the country has a war, a civil war or an uprising."},
    {"k": "nearconflict", "kind": "size", "scale": 0.05, "init": 0.0, "sign": -1, "label": "Nearby conflict", "world": "countries",
     "unit": "per year, when every neighbour is at war", "help": "The change in growth when its neighbours have conflicts."},
    {"k": "pull", "kind": "position", "scale": 0.3, "init": 0.0, "label": "Pull of heavy neighbours",
     "unit": "of the gap closed per year", "help": "Above 0, a body moves on the map toward the mass near it."},
    {"k": "home", "kind": "position", "scale": 0.3, "init": 0.0, "label": "Pull toward its group",
     "unit": "of the gap closed per year", "help": "Above 0, a body moves toward the centre of its own sector or region."},
]


def terms(world):
    # "opt" forces were tested and not adopted: they ranked growth slightly better but raised the error (see
    # docs/PARTICLE-LAB-PLAN.md); VF_DATA_FORCES=1 brings them back
    on = os.environ.get("VF_DATA_FORCES") == "1"
    return [t for t in TERMS if t.get("world") in (None, world) and (on or not t.get("opt"))]


def _xp():
    return cp if cp is not None else np


def _np(a):
    return a.get() if cp is not None and isinstance(a, cp.ndarray) else np.asarray(a)


# ================================================================ the real map, at every step
def _mds_warm(R, X0, iters=12):
    Z = (R - R.mean(0)) / (R.std(0) + 1e-12)
    rho = np.clip(Z.T @ Z / len(Z), -1, 1)
    B = 1 - rho
    B = -(B - B.mean(0) - B.mean(1)[:, None] + B.mean())
    V = np.asarray(X0, np.float64).copy() + 1e-6 * np.random.RandomState(0).standard_normal(X0.shape)
    for _ in range(iters):
        V, _ = np.linalg.qr(B @ V)
    lam = np.maximum(np.einsum("ij,ij->j", V, B @ V), 1e-12)
    X = V * np.sqrt(lam)
    return X / (np.sqrt((X ** 2).sum(1).mean()) + 1e-12)


def _procrustes(A, B):
    """Rotate/reflect A (n x 2) onto B; returns the rotated A."""
    U, _, Vt = np.linalg.svd(A.T @ B)
    return A @ (U @ Vt)


def real_maps(W):
    """A (bodies x steps x 2): the co-movement map drawn from real data at every step (NaN where a body has too little
    history in the window), each step aligned to the one before. Cached on disk per world and data date."""
    cfg = CFG[W["world"]]
    key = "{}_{}_{}_{}".format(W["world"], W["dates"][-1], len(W["ids"]), VERSION)
    fp = os.path.join(ROOT, "cache", key + ".npz")
    if os.path.exists(fp):
        z = np.load(fp)
        return z["A"]
    R, wl = W["ret"], cfg["win"]
    N, T = R.shape
    A = np.full((N, T, 2), np.nan)
    prev = None
    for t in range(wl, T):
        win = R[:, t - wl + 1:t + 1]
        ok = np.isfinite(win).sum(1) >= int(0.75 * wl)
        ok &= np.isfinite(W["size"][:, t])
        if ok.sum() < 5:
            continue
        r = np.where(np.isfinite(win[ok]), win[ok], np.nan)
        with np.errstate(all="ignore"):
            r = np.nan_to_num(r - np.nanmean(r, 1, keepdims=True)).T
        X0 = np.random.RandomState(1).standard_normal((ok.sum(), 2)) if prev is None else np.where(np.isfinite(prev[ok]), prev[ok], 0.0)
        X = _mds_warm(r, X0)
        if prev is not None:
            both = ok & np.isfinite(prev[:, 0])
            if both.sum() >= 3:
                sub = np.isfinite(prev[ok][:, 0])
                X = X @ _rot(X[sub], prev[ok][sub])
        A[ok, t] = X
        prev = A[:, t].copy()
    os.makedirs(os.path.dirname(fp), exist_ok=True)
    np.savez_compressed(fp, A=A)
    return A


def _rot(A, B):
    U, _, Vt = np.linalg.svd(A.T @ B)
    return U @ Vt


def _di(W, date):
    return max(i for i, d in enumerate(W["dates"]) if d <= date)


# ================================================================ the state at a start step
def snapshot(W, A, t, blend=1.0):
    """Everything the simulation may know at step t (data up to t only)."""
    cfg = CFG[W["world"]]
    dt = 1.0 / cfg["spy"]
    size = W["size"][:, t]
    alive = np.isfinite(size) & W["member"][:, t]
    ix = np.where(alive)[0]
    l = np.log(size[ix])
    tot = np.log(np.sum(size[ix]))
    ls = l - tot
    k = cfg["mom"]
    past = W["size"][ix, max(0, t - k)]
    totp = np.log(np.nansum(np.where(W["member"][:, max(0, t - k)] & np.isfinite(W["size"][:, max(0, t - k)]), W["size"][:, max(0, t - k)], 0)))
    with np.errstate(all="ignore"):
        m = ((l - np.log(past)) - (tot - totp)) / (k * dt)
    m = np.where(np.isfinite(m), np.clip(m, -2, 2), 0.0)
    r = W["ret"][ix, max(1, t - cfg["win"] + 1):t + 1]
    with np.errstate(all="ignore"):
        vol = np.nanstd(np.where(np.isfinite(r), r, np.nan), 1)
    grp = [W["groups"][i] for i in ix]
    gv = {}
    for g, v in zip(grp, vol):
        if np.isfinite(v) and v > 0:
            gv.setdefault(g, []).append(v)
    vol = np.array([v if np.isfinite(v) and v > 0 else float(np.median(gv.get(g, [0.05]))) for g, v in zip(grp, vol)])
    X = A[ix, t].copy()
    valid = np.isfinite(X[:, 0])
    cent = {}
    for g in set(grp):
        sel = np.array([gg == g for gg in grp]) & valid
        cent[g] = X[sel].mean(0) if sel.any() else np.zeros(2)
    for n in np.where(~valid)[0]:
        X[n] = cent[grp[n]]
    gid = {g: i for i, g in enumerate(sorted(set(grp)))}
    snap = {"t": t, "ix": ix, "l": ls, "m": m, "vol": vol, "X": X, "valid": valid, "grp": grp, "gi": np.array([gid[g] for g in grp]),
            "cent": np.array([cent[g] for g in sorted(gid)]), "gnames": sorted(gid), "dt": dt, "blend": blend}
    ex = {}
    if W["world"] == "countries":
        with np.errstate(all="ignore"):
            ex["catchup"] = _z(np.log(W["extra"]["gdppc"][ix, t]))
            xe = W["extra"]
            if "workage" in xe:
                ex["demography"] = _z(xe["workage"][ix, t])
                ex["health"] = _z(xe["life"][ix, t])
                ex["investment"] = _z(np.nanmean(xe["invest"][ix, max(0, t - 2):t + 1], 1))
        ex["conflict"] = W["extra"]["conflict"][ix, max(0, t - 1):t + 1].max(1) / 3.0
        geo = W["geo"][ix]
        ok = np.isfinite(geo[:, 0])
        geo = np.where(ok[:, None], geo, 0.0)
        la, lo = np.radians(geo[:, 0]), np.radians(geo[:, 1])
        dla, dlo = la[:, None] - la[None], lo[:, None] - lo[None]
        hav = np.sin(dla / 2) ** 2 + np.cos(la)[:, None] * np.cos(la)[None] * np.sin(dlo / 2) ** 2
        Dg2 = (2 * np.arcsin(np.sqrt(np.clip(hav, 0, 1)))) ** 2
        Dm2 = ((X[:, None] - X[None]) ** 2).sum(2)
        Dg2 *= Dm2.mean() / max(Dg2.mean(), 1e-9)               # the same typical distance as the map
        Dg2[~ok] = Dm2.mean() * 4
        Dg2[:, ~ok] = Dm2.mean() * 4
        np.fill_diagonal(Dg2, 0.0)                              # a body is never its own neighbour, with or without a capital
        snap["Dg2"] = Dg2
    snap["ex"] = ex
    return snap


def _z(x):
    x = np.where(np.isfinite(x), x, np.nan)
    mu, sd = np.nanmean(x), np.nanstd(x)
    return np.nan_to_num((x - mu) / (sd + 1e-9))


def actual(W, A, snap, h):
    """What really happened h steps after the snapshot, for its bodies: relative growth and the real map."""
    t = snap["t"] + h
    ix = snap["ix"]
    s1 = W["size"][ix, t]
    ok = np.isfinite(s1)
    with np.errstate(all="ignore"):
        g = np.log(s1) - (snap["l"] + 0)                       # log size at t+h minus log share at t (a constant shift per window)
    X = A[ix, t]
    return {"g": np.where(ok, g, np.nan), "X": X, "okX": np.isfinite(X[:, 0]) & snap["valid"]}


def contributions(P, names, snap):
    """Each growth force's term in one body's growth (log share per year) at this snapshot: the first step of replay()."""
    p = {k: float(v[0]) for k, v in _params(np.asarray(P, float)[None], names).items()}
    l, m, X = np.asarray(snap["l"], float), np.asarray(snap["m"], float), np.asarray(snap["X"], float)
    N = l.size
    D2 = ((X[:, None] - X[None]) ** 2).sum(2)
    if "Dg2" in snap and snap["blend"] < 1:
        D2 = snap["blend"] * D2 + (1 - snap["blend"]) * snap["Dg2"]
    K = np.exp(-D2 / (2 * CFG_H(snap) ** 2)) - np.eye(N)
    Ksum = K.sum(1) + 1e-12
    w = np.exp(l - l.max())
    w /= w.sum()
    S1 = K @ w + 1e-12
    zr = lambda a: (a - a.mean()) / (a.std() + 1e-9)
    feat = {"momentum": m, "size": zr(l), "crowding": zr(np.log(S1)), "lead": zr((l * S1 - K @ (w * l)) / S1),
            "contagion": (K @ (w * m)) / S1, "volatility": _z(np.log(snap["vol"]))}
    ex = snap["ex"]
    if "catchup" in ex:
        feat["catchup"] = ex["catchup"]
        feat["conflict"] = ex["conflict"]
        feat["nearconflict"] = (K @ ex["conflict"]) / Ksum
        for k in ("demography", "health", "investment"):
            if k in ex:
                feat[k] = ex[k]
    return {k: p[k] * v for k, v in feat.items() if k in p and p[k] != 0.0}


# ================================================================ deterministic replay of C candidate weight sets at once
def _params(P, names):
    """P: C x len(names) array -> dict of C-vectors with the transforms applied (half-life from its log)."""
    out = {}
    for j, k in enumerate(names):
        out[k] = P[:, j]
    if "halflife" in out:
        out["halflife"] = np.exp(np.clip(out["halflife"], math.log(0.1), math.log(30.0)))
    return out


def replay(P, names, snap, steps, checks):
    """Run C candidates (rows of P) forward from one snapshot with no noise. Returns, per check step, the predicted
    log-size change (C x N) and the positions (C x N x 2)."""
    xp = _xp()
    C, N = P.shape[0], len(snap["ix"])
    p = {k: xp.asarray(v, dtype=xp.float32)[:, None] for k, v in _params(P, names).items()}
    dt = snap["dt"]
    l = xp.tile(xp.asarray(snap["l"], dtype=xp.float32), (C, 1))
    l0 = l.copy()
    m = xp.tile(xp.asarray(snap["m"], dtype=xp.float32), (C, 1))
    X = xp.tile(xp.asarray(snap["X"], dtype=xp.float32)[None], (C, 1, 1))
    zvol = xp.asarray(_z(np.log(snap["vol"])), dtype=xp.float32)[None]
    cent = xp.asarray(snap["cent"], dtype=xp.float32)[xp.asarray(snap["gi"])][None]
    h2 = 2 * (CFG_H(snap) ** 2)
    ex = {k: xp.asarray(v, dtype=xp.float32)[None] for k, v in snap["ex"].items()}
    Dg2 = xp.asarray(snap["Dg2"], dtype=xp.float32)[None] if "Dg2" in snap else None
    b = snap["blend"]
    decay = xp.exp(-math.log(2) * dt / p["halflife"]) if "halflife" in p else 1.0
    eye = xp.eye(N, dtype=xp.float32)[None]
    out = {}
    mm = xp.matmul
    kstep = 3 if N > 300 else 1                                # positions move slowly: rebuild the kernel every few steps
    for s in range(1, steps + 1):
        # every neighbour sum is a batched matrix product: no N x N x 2 tensors on the K420
        if (s - 1) % kstep == 0:
            sq = (X * X).sum(2)
            D2 = xp.maximum(sq[:, :, None] + sq[:, None, :] - 2 * mm(X, X.transpose(0, 2, 1)), 0)
            if Dg2 is not None and b < 1:
                D2 = b * D2 + (1 - b) * Dg2
            K = xp.exp(-D2 / h2) - eye
            Ksum = K.sum(2) + 1e-12
        w = xp.exp(l - l.max(1, keepdims=True))
        w = w / w.sum(1, keepdims=True)
        S1 = mm(K, w[:, :, None])[:, :, 0] + 1e-12
        crowd = _zx(xp, xp.log(S1))
        lead = _zx(xp, (l * S1 - mm(K, (w * l)[:, :, None])[:, :, 0]) / S1)
        cont = mm(K, (w * m)[:, :, None])[:, :, 0] / S1
        zl = _zx(xp, l)
        f = p["momentum"] * m + p["size"] * zl + p["crowding"] * crowd + p["lead"] * lead + p["contagion"] * cont + p["volatility"] * zvol
        if "catchup" in p:
            near = mm(K, xp.broadcast_to(ex["conflict"], (C, N))[:, :, None])[:, :, 0] / Ksum
            f = f + p["catchup"] * ex["catchup"] + p["conflict"] * ex["conflict"] + p["nearconflict"] * near
            for k in ("demography", "health", "investment"):
                if k in p and k in ex:
                    f = f + p[k] * ex[k]
        l = l + dt * f
        m = m * decay
        pullv = mm(K, w[:, :, None] * X) / S1[:, :, None] - X
        X = X + dt * (p["pull"][..., None] * pullv + p["home"][..., None] * (cent - X))
        if s in checks:
            out[s] = (l - l0, X.copy())
    return out


def CFG_H(snap):
    return 0.35


def _zx(xp, a):
    mu = a.mean(1, keepdims=True)
    sd = a.std(1, keepdims=True) + 1e-9
    return (a - mu) / sd


# ================================================================ the score of a set of predictions
def _errors(pred_g, pred_X, act, w0):
    """Size: weighted mean |error| in relative growth (both demeaned over the bodies that survived).
    Position: weighted mean distance to the real map after the best rotation. Returns per-candidate arrays."""
    ok = np.isfinite(act["g"])
    g = act["g"][ok]
    wt = np.sqrt(w0[ok])
    wt = wt / wt.sum()
    g = g - (wt * g).sum()
    pg = pred_g[:, ok]
    pg = pg - (pg * wt[None]).sum(1, keepdims=True)
    e_size = (np.abs(pg - g[None]) * wt[None]).sum(1)
    okx = act["okX"]
    if okx.sum() >= 5:
        B = act["X"][okx]
        wx = np.sqrt(w0[okx])
        wx = wx / wx.sum()
        e_pos = []
        for c in range(pred_X.shape[0]):
            Ac = pred_X[c][okx]
            Ac = Ac @ _rot(Ac, B)
            e_pos.append(float((np.sqrt(((Ac - B) ** 2).sum(1)) * wx).sum()))
        e_pos = np.array(e_pos)
    else:
        e_pos = np.zeros(pred_X.shape[0])
    return e_size, e_pos


class Windows:
    """Training (or tuning) windows: snapshots at regular starts and what really happened at each check."""

    def __init__(self, W, A, first, last, blend, by_end=False):
        """by_end=False: windows that start and end inside [first, last] (training).
        by_end=True: windows whose END falls inside [first, last] (tuning): each start uses only data up to it, and
        the outcomes it is scored on come after the training period, so nothing here was used to fit."""
        cfg = CFG[W["world"]]
        self.cfg, self.items = cfg, []
        j0, j1 = _di(W, first), _di(W, last)
        h = cfg["fit_h"]
        if by_end:
            ends = range(max(j0, cfg["win"] + h), j1 + 1, max(1, cfg["every"] // 2))
            starts = [e - h for e in ends]
        else:
            starts = range(max(j0, cfg["win"]), j1 - h + 1, cfg["every"])
        for t in starts:
            snap = snapshot(W, A, t, blend)
            if len(snap["ix"]) < 10:
                continue
            acts = {c: actual(W, A, snap, c) for c in cfg["checks"] if c <= h}
            w0 = np.exp(snap["l"]) / np.exp(snap["l"]).sum()
            # persistence: nothing changes (no growth difference, the start map)
            base = {}
            for c, a in acts.items():
                es, ep = _errors(np.zeros((1, len(w0))), snap["X"][None], a, w0)
                base[c] = (float(es[0]), float(ep[0]))
            self.items.append((snap, acts, w0, base))

    def score(self, P, names, parts=False):
        """Mean over windows and checks of size error / persistence + position error / persistence (C candidates)."""
        C = P.shape[0]
        tot = np.zeros(C)
        ts, tp = np.zeros(C), np.zeros(C)
        n = 0
        h = self.cfg["fit_h"]
        for snap, acts, w0, base in self.items:
            out = replay(P, names, snap, h, list(acts))
            for c, a in acts.items():
                g, X = out[c]
                es, ep = _errors(_np(g), _np(X), a, w0)
                bs, bp = base[c]
                rs = es / max(bs, 1e-9)
                rp = ep / max(bp, 1e-9) if bp > 1e-9 else np.ones(C)
                ts += rs
                tp += rp
                tot += rs + rp
                n += 1
        if parts:
            return tot / max(n, 1), ts / max(n, 1), tp / max(n, 1)
        return tot / max(n, 1)


# ================================================================ CMA-ES over the weights
def cmaes(fn, x0, scale, free, gens=30, lam=16, seed=0, job=None, label="learning", lo=0.0, hi=1.0, ridge=0.02, signs=None):
    """Minimise fn(P) (P: lam x dim -> lam scores) over the free coordinates. Weights are searched in units of their
    scale, with a small ridge penalty so a force stays near 0 unless the data needs it."""
    rs = np.random.RandomState(seed)
    dim = len(x0)
    fi = np.where(free)[0]
    d = len(fi)
    if d == 0:
        return x0.copy(), float(fn(x0[None])[0])
    mu = lam // 2
    wts = np.log(mu + 0.5) - np.log(np.arange(1, mu + 1))
    wts /= wts.sum()
    mueff = 1 / (wts ** 2).sum()
    cs = (mueff + 2) / (d + mueff + 5)
    ds = 1 + 2 * max(0, math.sqrt((mueff - 1) / (d + 1)) - 1) + cs
    cc = (4 + mueff / d) / (d + 4 + 2 * mueff / d)
    c1 = 2 / ((d + 1.3) ** 2 + mueff)
    cmu = min(1 - c1, 2 * (mueff - 2 + 1 / mueff) / ((d + 2) ** 2 + mueff))
    chi = math.sqrt(d) * (1 - 1 / (4 * d) + 1 / (21 * d * d))
    m = np.zeros(d)
    sig = 0.6
    Cm = np.eye(d)
    pc, ps = np.zeros(d), np.zeros(d)
    best = (float("inf"), None)
    z0 = x0.copy()

    def full(Z):
        P = np.tile(z0, (len(Z), 1))
        P[:, fi] = z0[fi] + Z * scale[fi]
        if signs is not None:                             # theory fixes some signs (conflict only slows growth)
            P = np.where(signs[None] < 0, np.minimum(P, 0), np.where(signs[None] > 0, np.maximum(P, 0), P))
        return P

    def cost(P):
        pen = ridge * (((P[:, fi] - z0[fi] * 0) / scale[fi]) ** 2).sum(1) / d
        return fn(P) + pen

    hist = []
    for g in range(gens):
        A = np.linalg.cholesky(Cm + 1e-10 * np.eye(d))
        Z = rs.standard_normal((lam, d))
        Y = Z @ A.T
        Xc = m[None] + sig * Y
        f = cost(full(Xc))
        o = np.argsort(f)
        if f[o[0]] < best[0]:
            best = (float(f[o[0]]), full(Xc[o[:1]])[0].copy())
        hist.append(float(f[o[0]]))
        ysel = Y[o[:mu]]
        yw = (wts[:, None] * ysel).sum(0)
        m = m + sig * yw
        Ainv = np.linalg.inv(A)
        ps = (1 - cs) * ps + math.sqrt(cs * (2 - cs) * mueff) * (Ainv @ yw)
        hs = np.linalg.norm(ps) / math.sqrt(1 - (1 - cs) ** (2 * (g + 1))) < (1.4 + 2 / (d + 1)) * chi
        pc = (1 - cc) * pc + (hs * math.sqrt(cc * (2 - cc) * mueff)) * yw
        Cm = (1 - c1 - cmu) * Cm + c1 * (np.outer(pc, pc) + (not hs) * cc * (2 - cc) * Cm) + cmu * (wts[:, None, None] * np.einsum("ki,kj->kij", ysel, ysel)).sum(0)
        sig *= math.exp((cs / ds) * (np.linalg.norm(ps) / chi - 1))
        sig = min(sig, 3.0)
        if job:
            job.step(lo + (hi - lo) * (g + 1) / gens, "{}: round {} of {} · best score {:.3f}".format(label, g + 1, gens, best[0]))
        if g > 12 and hist[-1] > min(hist[:-10]) - 1e-4 and sig < 0.05:
            break
    return best[1], best[0]


# ================================================================ statistics-only baseline (no forces, no replay)
def stats_baseline(train, names):
    """Ridge regression of each check's relative growth on the same start features. The plain statistical answer the
    forces must beat. Returns a function snapshot -> {check: predicted growth}."""
    rows = {}
    for snap, acts, w0, base in train.items:
        F = _start_features(snap)
        for c, a in acts.items():
            ok = np.isfinite(a["g"])
            g = a["g"][ok] - np.average(a["g"][ok], weights=np.sqrt(w0[ok]))
            rows.setdefault(c, []).append((F[ok], g, np.sqrt(w0[ok])))
    coef = {}
    for c, rr in rows.items():
        Xm = np.concatenate([r[0] for r in rr])
        y = np.concatenate([r[1] for r in rr])
        wt = np.concatenate([r[2] for r in rr])
        Xa = np.c_[np.ones(len(Xm)), Xm]
        Wd = wt / wt.mean()
        lam = 1.0 * len(Xm) / 100
        A = Xa.T @ (Xa * Wd[:, None]) + lam * np.diag([0] + [1] * Xm.shape[1])
        coef[c] = np.linalg.solve(A, Xa.T @ (y * Wd))
    return lambda snap: {c: np.c_[np.ones(len(snap["ix"])), _start_features(snap)] @ coef[c] for c in coef}


def _start_features(snap):
    X = snap["X"]
    D2 = ((X[:, None] - X[None]) ** 2).sum(2)
    K = np.exp(-D2 / (2 * 0.35 ** 2))
    np.fill_diagonal(K, 0)
    w = np.exp(snap["l"]) / np.exp(snap["l"]).sum()
    S1 = K @ w + 1e-12
    cols = [snap["m"], _z(snap["l"]), _z(np.log(S1)), _z((snap["l"] * S1 - K @ (w * snap["l"])) / S1), (K @ (w * snap["m"])) / S1,
            _z(np.log(snap["vol"]))]
    for k in ("catchup", "conflict"):
        if k in snap["ex"]:
            cols.append(snap["ex"][k])
    return np.stack(cols, 1)


# ================================================================ events: chances (logistic) and sizes (what happened)
def logistic(X, y, l2=1.0, iters=30):
    """L2-regularised logistic regression by IRLS. Returns coefficients with the intercept first."""
    Xa = np.c_[np.ones(len(X)), X]
    b = np.zeros(Xa.shape[1])
    pr = max(1e-4, min(0.5, y.mean()))
    b[0] = math.log(pr / (1 - pr))
    R = l2 * np.eye(Xa.shape[1])
    R[0, 0] = 0
    for _ in range(iters):
        eta = np.clip(Xa @ b, -30, 30)
        p = 1 / (1 + np.exp(-eta))
        Wt = p * (1 - p) + 1e-9
        H = Xa.T @ (Xa * Wt[:, None]) + R
        g = Xa.T @ (y - p) - R @ b
        step = np.linalg.solve(H, g)
        b = b + step
        if np.abs(step).max() < 1e-7:
            break
    return b


def _auc(score, y):
    y = np.asarray(y, bool)
    if y.all() or (~y).all():
        return None
    r = np.argsort(np.argsort(score)) + 1
    return float((r[y].sum() - y.sum() * (y.sum() + 1) / 2) / (y.sum() * (~y).sum()))


EVENT_TYPES = {
    "companies": ["exit", "merger", "split", "collapse", "jump"],
    "countries": ["war", "civilwar", "uprising", "coup", "currency"],
}
EVENT_WORDS = {
    "exit": "falls out of the S&P 500", "merger": "is bought by another company", "split": "splits off a new company",
    "collapse": "collapses (bankruptcy)", "jump": "jumps or drops 5 sigma in one month", "entry": "joins the S&P 500",
    "war": "a war between states starts", "civilwar": "a civil war starts", "uprising": "a new armed uprising starts",
    "coup": "somebody tries a coup", "currency": "the currency crashes", "breakup": "the state breaks up", "union": "states unite",
}


def _event_matrix(W, typ):
    """bodies x steps: 1 where an event of this type happened to the body at that step."""
    idx = {c: i for i, c in enumerate(W["ids"])}
    E = np.zeros(W["size"].shape, np.int8)
    for e in W["events"]:
        who = e.get("by") if typ == "split" else e["id"]          # a split happens to the parent
        if e["type"] == typ and e.get("step") is not None and who in idx:
            E[idx[who], e["step"]] = 1
    return E


def _hazard_features(W, A, t, ix, typ):
    """The numbers a chance depends on, for bodies ix at step t (only data up to t)."""
    size = W["size"][ix, t]
    with np.errstate(all="ignore"):
        l = np.log(size)
    k = CFG[W["world"]]["mom"]
    with np.errstate(all="ignore"):
        m = (l - np.log(W["size"][ix, max(0, t - k)])) / k
    m = np.nan_to_num(np.clip(m, -1, 1))
    r = W["ret"][ix, max(1, t - CFG[W["world"]]["win"] + 1):t + 1]
    with np.errstate(all="ignore"):
        vol = np.nanstd(np.where(np.isfinite(r), r, np.nan), 1)
    vol = np.where(np.isfinite(vol) & (vol > 0), vol, np.nanmedian(vol))
    if W["world"] == "companies":
        rank = np.argsort(np.argsort(np.nan_to_num(l, nan=-99))) / max(1, len(ix) - 1)
        # never "size is estimated": a size is estimated because the company's prices vanished later — the future
        cols = {"exit": [rank, m, _z(np.log(vol))], "merger": [_z(l), m, _z(np.log(vol))],
                "split": [_z(l)], "collapse": [_z(l)], "jump": [_z(np.log(vol))]}[typ]
        return np.stack(cols, 1)
    ex = W["extra"]
    lo = max(0, t - 4)
    same = _event_matrix(W, typ)[ix, lo:t + 1].max(1).astype(float)
    conf = ex["conflict"][ix, lo:t + 1].max(1) / 3.0
    coup = (ex["coup"][ix, lo:t + 1].max(1) > 0).astype(float)
    with np.errstate(all="ignore"):
        rich = _z(np.log(ex["gdppc"][ix, t]))
    geo = W["geo"][ix]
    ok = np.isfinite(geo[:, 0])
    g = np.where(ok[:, None], geo, 0)
    la, lo_ = np.radians(g[:, 0]), np.radians(g[:, 1])
    hav = np.sin((la[:, None] - la[None]) / 2) ** 2 + np.cos(la)[:, None] * np.cos(la)[None] * np.sin((lo_[:, None] - lo_[None]) / 2) ** 2
    dkm = 6371 * 2 * np.arcsin(np.sqrt(np.clip(hav, 0, 1)))
    Kg = np.exp(-(dkm / 1500.0) ** 2) * ok[None] * ok[:, None]
    np.fill_diagonal(Kg, 0)
    near = (Kg @ conf) / (Kg.sum(1) + 1e-9)
    return np.stack([same, conf, near, coup, rich, m], 1)


HAZ_COLS = {"exit": ["size rank", "momentum", "volatility"],
            "merger": ["size", "momentum", "volatility"], "split": ["size"], "collapse": ["size"], "jump": ["volatility"],
            "_country": ["same event in the last 5 years", "conflict in the last 5 years", "conflict near it", "a coup in the last 5 years",
                         "GDP per person", "momentum"]}


def fit_events(W, A, first, last):
    """For each event type: the chance per body per step as a logistic model, fitted on [first, last]; the event's
    effect on size (what it did in that period); and the arrival rate of new bodies (companies)."""
    j0, j1 = max(_di(W, first), CFG[W["world"]]["win"]), _di(W, last)
    out = {}
    for typ in EVENT_TYPES[W["world"]]:
        E = _event_matrix(W, typ)
        Xs, ys = [], []
        for t in range(j0, j1):
            ix = np.where(W["member"][:, t] & np.isfinite(W["size"][:, t]))[0]
            if len(ix) < 5:
                continue
            Xs.append(_hazard_features(W, A, t, ix, typ))
            ys.append(E[ix, t + 1].astype(float))
        X, y = np.concatenate(Xs), np.concatenate(ys)
        n = int(y.sum())
        cols = HAZ_COLS.get(typ) or HAZ_COLS["_country"]
        if n >= 8:
            mu, sd = X.mean(0), X.std(0) + 1e-9
            b = logistic((X - mu) / sd, y, l2=2.0)
        else:                                                     # too few to learn from: one base rate
            mu, sd = X.mean(0), X.std(0) + 1e-9
            b = np.zeros(X.shape[1] + 1)
            b[0] = math.log(max(n, 0.5) / len(y) / (1 - max(n, 0.5) / len(y)))
        p = 1 / (1 + np.exp(-np.clip(np.c_[np.ones(len(X)), (X - mu) / sd] @ b, -30, 30)))
        out[typ] = {"b": b.tolist(), "mu": mu.tolist(), "sd": sd.tolist(), "cols": cols, "n": n, "rows": int(len(y)),
                    "rate": n / max(1, len(y)), "auc_train": _auc(p, y), "learned": n >= 8}
    # what an event does to the size of the body it hits (log change over the next step, relative to the whole)
    for typ in EVENT_TYPES[W["world"]]:
        if typ in ("exit", "merger", "collapse"):
            continue
        E = _event_matrix(W, typ)
        eff = []
        for i, t in zip(*np.where(E[:, j0:j1] > 0)):
            t = t + j0
            if t + 1 >= len(W["dates"]):
                continue
            s0, s1 = W["size"][i, t - 1] if t > 0 else np.nan, W["size"][i, t + 1] if t + 1 < len(W["dates"]) else np.nan
            if not (np.isfinite(s0) and np.isfinite(s1)):
                continue
            tot = lambda j: np.nansum(np.where(W["member"][:, j], W["size"][:, j], 0))
            eff.append(math.log(s1 / s0) - math.log(tot(t + 1) / tot(t - 1)))
        eff = np.array(eff)
        out[typ]["effect"] = {"mean": float(eff.mean()) if len(eff) else 0.0, "se": float(eff.std() / math.sqrt(len(eff))) if len(eff) > 1 else None,
                              "n": int(len(eff)), "samples": [round(float(x), 4) for x in eff[:400]]}
    if W["world"] == "companies":
        ent = [e for e in W["events"] if e["type"] in ("entry",) and e.get("step") is not None and j0 <= e["step"] < j1]
        rel, grp = [], []
        idx = {c: i for i, c in enumerate(W["ids"])}
        for e in ent:
            i, t = idx.get(e["id"]), e["step"]
            if i is None or not np.isfinite(W["size"][i, t]):
                continue
            mem = W["member"][:, t] & np.isfinite(W["size"][:, t])
            rel.append(math.log(W["size"][i, t] / np.median(W["size"][mem, t])))
            grp.append(W["groups"][i])
        sp = [e for e in W["events"] if e["type"] == "split" and e.get("by") and e.get("step") is not None and j0 <= e["step"] < j1]
        frac = []
        for e in sp:
            i, k = idx.get(e["id"]), idx.get(e["by"])
            t = e["step"]
            if i is not None and k is not None and np.isfinite(W["size"][i, t]) and np.isfinite(W["size"][k, t]):
                frac.append(W["size"][i, t] / (W["size"][i, t] + W["size"][k, t]))
        out["entry"] = {"per_step": len(ent) / max(1, j1 - j0), "rel_size": rel, "groups": grp,
                        "split_frac": frac or [0.2]}
    return out


def hazard_p(ev, typ, X):
    b, mu, sd = np.array(ev[typ]["b"]), np.array(ev[typ]["mu"]), np.array(ev[typ]["sd"])
    return 1 / (1 + np.exp(-np.clip(np.c_[np.ones(len(X)), (X - mu) / sd] @ b, -30, 30)))
