"""Fractal similarity: what a view looks like, in numbers, and which places are like it.

A signature is computed from the raw escape-time field of a 192 px render (no palette):
  histogram   the shape of the escape-time distribution (log of iterations above the view's minimum)
  inside      the share of the view inside the set
  dimension   box-counting dimension of the boundary at this scale (with the fit's R^2): ~1 smooth, ~2 space-filling
  symmetry    the strongest k-fold rotational order of the edges around the centre (deep minibrots show 2^k arms)
  clip        CLIP ViT-B/32 of a neutral grey picture, so colour does not drive the match
Matches combine them (weights below) and say which part drove each one. Places are compared with your pins and a
small built-in atlas of well-known locations (approximate coordinates)."""
import json
import math
import os
import threading

import numpy as np
from PIL import Image

from . import fractal as F
from . import fractal_places as FP

N = 192
W = {"clip": 0.5, "histogram": 0.2, "dimension": 0.15, "symmetry": 0.1, "inside": 0.05}
_LOCK = threading.Lock()
ATLAS = [
    ("Seahorse spiral", "mandelbrot", "-0.743643887037158704752191506114774", "0.131825904205311970493132056385139", 1e-6),
    ("Elephant Valley", "mandelbrot", "0.2849", "0.0102", 0.012),
    ("Triple Spiral Valley", "mandelbrot", "-0.0880", "0.6540", 0.02),
    ("Scepter Valley", "mandelbrot", "-1.3600", "0.0050", 0.02),
    ("The period-3 minibrot on the antenna", "mandelbrot", "-1.754877666", "0", 0.012),
    ("Feigenbaum point (the edge of chaos)", "mandelbrot", "-1.401155189092", "0", 0.0008),
    ("Misiurewicz point c = i (a dendrite tip)", "mandelbrot", "0", "1", 0.01),
    ("Tip of the antenna, c = -2", "mandelbrot", "-2", "0", 0.01),
    ("A spiral at -0.7616, -0.0848", "mandelbrot", "-0.761574", "-0.0847596", 0.004),
    ("Burning Ship: the ship", "burning-ship", "-1.762", "-0.035", 0.09),
    ("Julia: Douady rabbit", "julia", "0", "0", 3.2),
]


def field(kind, cx, cy, scale, jr=-0.8, ji=0.156, n=N):
    """The raw escape-time field (n x n float32; -1 = inside)."""
    import cupy as cp
    from .engine import run_on_gpu, sync
    scale = float(scale)
    dx = scale / n
    depth = max(0.0, -math.log10(scale / 3.0))
    iters = F.deep_iters(depth)
    t = F.TYPES.get(kind, 0)
    mode = "perturbation" if kind == "mandelbrot" and dx < 1e-13 else "FP64" if dx < 2e-7 else "FP32"

    def job():
        m = F._mod()
        out = cp.empty(n * n, cp.float32)
        if mode == "perturbation":
            F.pert_frame(cx, cy, depth, dx, n, n, iters, out)
            out[out < -1.5] = -1.0
        else:
            x0, y0 = float(cx) - scale / 2, float(cy) - dx * n / 2
            fn, cast = ("frac64", np.float64) if mode == "FP64" else ("frac32", np.float32)
            m.get_function(fn)(((n + 15) // 16, (n + 15) // 16), (16, 16), (np.int32(n), np.int32(n), cast(x0), cast(y0), cast(dx),
                                                                         cast(jr), cast(ji), np.int32(t), np.int32(iters), out))
        sync()
        return cp.asnumpy(out).reshape(n, n)
    return run_on_gpu(job, "fractal: signature", 120)


def _hist(v):
    e = v[v >= 0]
    if e.size < 10:
        return np.zeros(24)
    x = np.log1p(e - e.min())
    h, _ = np.histogram(x / max(x.max(), 1e-9), 24, (0, 1))
    return h / h.sum()


def _boundary(v):
    inside = v < 0
    vv = np.where(inside, np.nan, np.log1p(np.maximum(v, 0)))
    gy, gx = np.gradient(np.nan_to_num(vv, nan=np.nanmax(vv) if np.isfinite(vv).any() else 0))
    g = np.hypot(gx, gy)
    edge = np.zeros_like(inside)
    edge[:-1] |= inside[:-1] != inside[1:]
    edge[:, :-1] |= inside[:, :-1] != inside[:, 1:]
    thr = np.percentile(g[~inside], 85) if (~inside).sum() > 50 else np.inf
    return edge | (g > thr), g


def _dimension(b):
    n = b.shape[0]
    sizes, counts = [], []
    for s in (2, 3, 4, 6, 8, 12, 16, 24, 32):
        m = n // s
        if m < 2:
            continue
        c = b[:m * s, :m * s].reshape(m, s, m, s).any((1, 3)).sum()
        if c > 0:
            sizes.append(s)
            counts.append(c)
    if len(sizes) < 3:
        return 0.0, 0.0
    X, Y = np.log(1.0 / np.array(sizes)), np.log(np.array(counts, float))
    A = np.c_[X, np.ones_like(X)]
    coef, res, *_ = np.linalg.lstsq(A, Y, rcond=None)
    pred = A @ coef
    r2 = 1 - ((Y - pred) ** 2).sum() / max(((Y - Y.mean()) ** 2).sum(), 1e-12)
    return float(coef[0]), float(r2)


def _symmetry(b, g):
    n = b.shape[0]
    yy, xx = np.mgrid[0:n, 0:n] - (n - 1) / 2.0
    r = np.hypot(xx, yy)
    sel = b & (r > n * 0.06) & (r < n * 0.48)
    if sel.sum() < 40:
        return 0, 0.0
    th = np.arctan2(yy[sel], xx[sel])
    h, _ = np.histogram(th, 96, (-math.pi, math.pi), weights=1 + g[sel] / (g[sel].mean() + 1e-9))
    f = np.abs(np.fft.rfft(h - h.mean()))
    k = int(np.argmax(f[2:13]) + 2)
    return k, float(f[k] / (f[1:].sum() + 1e-9))


def _neutral(v):
    a = np.where(v < 0, 0.0, 0.5 + 0.5 * np.cos(np.sqrt(np.maximum(v, 0)) * 0.7))
    return Image.fromarray((a * 255).astype(np.uint8)).convert("RGB")


def signature(kind, cx, cy, scale, jr=-0.8, ji=0.156, with_clip=True):
    v = field(kind, cx, cy, scale, jr, ji)
    b, g = _boundary(v)
    d, r2 = _dimension(b)
    k, ks = _symmetry(b, g)
    sig = {"histogram": _hist(v).round(4).tolist(), "inside": round(float((v < 0).mean()), 4), "dimension": round(d, 3), "dimension_r2": round(r2, 3),
           "symmetry": k, "symmetry_strength": round(ks, 3)}
    if with_clip:
        from . import clip
        if clip.ready():
            e = clip.embed_images([_neutral(v)])[0]
            sig["clip"] = (e / (np.linalg.norm(e) + 1e-9)).astype(np.float32).round(5).tolist()
    return sig


def _sigs():
    p = FP._path("sigs.json")
    return json.load(open(p)) if os.path.exists(p) else {}


def _save_sigs(d):
    p = FP._path("sigs.json")
    with open(p + ".tmp", "w") as f:
        json.dump(d, f)
    os.replace(p + ".tmp", p)


def _candidates():
    out = [{"id": "atlas-%d" % i, "name": nm, "kind": k, "cx": x, "cy": y, "scale": s, "jr": -0.123 if k == "julia" else -0.8, "ji": 0.745 if k == "julia" else 0.156,
            "atlas": True} for i, (nm, k, x, y, s) in enumerate(ATLAS)]
    return out + [dict(p, atlas=False) for p in FP._load()]


def _ensure(cands):
    with _LOCK:
        S = _sigs()
        changed = False
        for c in cands:
            key = c["id"] + "|" + c["cx"][:30] + "|" + c["cy"][:30] + "|" + "%.4g" % c["scale"]
            if key not in S:
                S[key] = signature(c["kind"], c["cx"], c["cy"], c["scale"], c.get("jr", -0.8), c.get("ji", 0.156))
                changed = True
            c["sig"] = S[key]
        if changed:
            _save_sigs(S)
    return cands


def _compare(a, b):
    parts = {}
    if a.get("clip") and b.get("clip"):
        parts["clip"] = max(0.0, (float(np.dot(a["clip"], b["clip"])) - 0.5) / 0.5)      # CLIP cosines of pictures sit in 0.5..1
    p, q = np.array(a["histogram"]) + 1e-6, np.array(b["histogram"]) + 1e-6
    m = (p + q) / 2
    js = 0.5 * (p * np.log(p / m)).sum() + 0.5 * (q * np.log(q / m)).sum()
    parts["histogram"] = float(max(0.0, 1 - js / math.log(2)))
    parts["dimension"] = math.exp(-abs(a["dimension"] - b["dimension"]) / 0.15)
    parts["symmetry"] = 1.0 if a["symmetry"] == b["symmetry"] else 0.4 if min(a["symmetry"], b["symmetry"]) and max(a["symmetry"], b["symmetry"]) % min(a["symmetry"], b["symmetry"]) == 0 else 0.0
    parts["inside"] = 1 - abs(a["inside"] - b["inside"])
    w = {k: W[k] for k in parts}
    tot = sum(w.values())
    score = sum(w[k] * parts[k] for k in parts) / tot
    top2 = sorted((k for k in parts if k != "inside"), key=lambda k: -parts[k])[:2]   # the two strongest signals
    return score, parts, top2


WHY = {"clip": "looks alike (CLIP)", "histogram": "same mix of escape times", "dimension": "same roughness (dimension)",
       "symmetry": "same symmetry", "inside": "same share inside the set"}


def similar(kind, cx, cy, scale, jr=-0.8, ji=0.156, top=6):
    here = signature(kind, cx, cy, scale, jr, ji)
    cands = _ensure(_candidates())
    rows = []
    for c in cands:
        if c["cx"] == str(cx) and c["cy"] == str(cy) and abs(c["scale"] - float(scale)) < 1e-12:
            continue
        s, parts, why = _compare(here, c["sig"])
        rows.append({"id": c["id"], "name": c["name"], "kind": c["kind"], "cx": c["cx"], "cy": c["cy"], "scale": c["scale"], "atlas": c["atlas"],
                     "score": round(s, 3), "why": " · ".join("{} {:.2f}".format(WHY[k], parts[k]) for k in why), "parts": {k: round(v, 3) for k, v in parts.items()}})
    rows.sort(key=lambda r: -r["score"])
    return {"here": {k: here[k] for k in ("inside", "dimension", "dimension_r2", "symmetry", "symmetry_strength")}, "matches": rows[:top],
            "weights": W, "compared": len(rows)}


def search(text, top=8):
    """Places whose neutral picture CLIP finds closest to the words."""
    from . import clip
    if not clip.ready():
        raise ValueError("CLIP is not installed on the card yet (Photo Lab installs it)")
    cands = _ensure(_candidates())
    t = clip.embed_texts(["a picture of " + text])[0]
    t = t / (np.linalg.norm(t) + 1e-9)
    rows = []
    for c in cands:
        e = c["sig"].get("clip")
        if e:
            rows.append({"id": c["id"], "name": c["name"], "kind": c["kind"], "cx": c["cx"], "cy": c["cy"], "scale": c["scale"], "atlas": c["atlas"],
                         "score": round(float(np.dot(t, e)), 4)})
    rows.sort(key=lambda r: -r["score"])
    return {"query": text, "matches": rows[:top]}
