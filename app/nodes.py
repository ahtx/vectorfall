"""The transform library: chainable GPU nodes. Each takes an Obj (CuPy array) and returns one, staying resident.
Behind them: cuFFT (cp.fft), cuBLAS (cp.dot/linalg), cuRAND (cp.random), cuSOLVER (cp.linalg.svd) and cupyx's
GPU ndimage. Point = per-element, local = fixed neighbourhood, global = all-to-all (FFT / GEMM / sort).
"""
import base64
import io

import numpy as np
from PIL import Image

import cupy as cp
import cupyx.scipy.ndimage as ndi

from .engine import NODES, Obj, mark_gflops, node  # noqa: F401


# ---------------------------------------------------------------- render helpers (GPU -> browser)
def to_png(obj):
    a = obj.arr
    if a.ndim == 2:
        a = cp.stack([a, a, a], -1)
    a = cp.asnumpy(a)
    if a.dtype != np.uint8:
        lo, hi = float(a.min()), float(a.max())
        a = (a - lo) / (hi - lo + 1e-9) if hi > lo else a * 0
        a = (np.clip(a, 0, 1) * 255).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(a[..., :3]).save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def to_series(arr, n=2048):
    a = cp.asnumpy(arr).astype(np.float32).ravel()
    if a.size > n:
        a = a[:: a.size // n][:n]
    return [round(float(x), 5) for x in a]


def load_image_host(data):
    im = Image.open(io.BytesIO(data)).convert("RGB")
    w, h = im.size
    if max(w, h) > 2048:                 # keep it inside 1 GB with headroom
        s = 2048 / max(w, h)
        im = im.resize((int(w * s), int(h * s)))
    return Obj("image", np.asarray(im, np.float32), {"source": "image", "w": im.size[0], "h": im.size[1]})


def load_audio_host(data):
    import wave
    w = wave.open(io.BytesIO(data))
    n, sr, ch = w.getnframes(), w.getframerate(), w.getnchannels()
    raw = np.frombuffer(w.readframes(n), np.int16).astype(np.float32) / 32768
    if ch > 1:
        raw = raw.reshape(-1, ch).mean(1)
    raw = raw[: sr * 60]                  # cap at 60 s
    return Obj("audio", raw, {"source": "audio", "sr": sr, "seconds": round(len(raw) / sr, 2)})


def load_matrix_host(data):
    txt = data.decode("utf-8", "replace")
    rows = [[float(x) for x in ln.replace(",", " ").split()] for ln in txt.splitlines() if ln.strip() and not ln[0].isalpha()]
    w = min(len(r) for r in rows)
    m = np.array([r[:w] for r in rows], np.float32)
    return Obj("matrix", m, {"source": "matrix", "shape": list(m.shape)})


def _gray(a):
    return a @ cp.asarray([0.299, 0.587, 0.114], cp.float32) if a.ndim == 3 else a


# ============================================================ IMAGE
@node("grayscale", "Grayscale", "image", "image", "image", cls="point")
def n_gray(o, p):
    return Obj("image", _gray(o.arr), o.meta)


@node("invert", "Invert", "image", "image", "image", cls="point")
def n_invert(o, p):
    return Obj("image", 255 - o.arr, o.meta)


@node("gaussian", "Gaussian blur", "image", "image", "image",
      [{"k": "sigma", "label": "Radius", "type": "float", "default": 3, "min": 0.5, "max": 40}], cls="local")
def n_gauss(o, p):
    s = float(p.get("sigma", 3))
    a = o.arr
    sig = (s, s, 0) if a.ndim == 3 else (s, s)
    return Obj("image", ndi.gaussian_filter(a, sig), o.meta)


@node("sharpen", "Sharpen", "image", "image", "image",
      [{"k": "amount", "label": "Amount", "type": "float", "default": 1.5, "min": 0.1, "max": 5}], cls="local")
def n_sharpen(o, p):
    amt = float(p.get("amount", 1.5))
    a = o.arr.astype(cp.float32)
    sig = (1.5, 1.5, 0) if a.ndim == 3 else (1.5, 1.5)
    blur = ndi.gaussian_filter(a, sig)
    return Obj("image", cp.clip(a + amt * (a - blur), 0, 255), o.meta)


@node("sobel", "Edge detect (Sobel)", "image", "image", "image", cls="local")
def n_sobel(o, p):
    g = _gray(o.arr).astype(cp.float32)
    gx = ndi.sobel(g, axis=0)
    gy = ndi.sobel(g, axis=1)
    return Obj("image", cp.hypot(gx, gy), o.meta)


@node("median", "Median denoise", "image", "image", "image",
      [{"k": "size", "label": "Window", "type": "int", "default": 3, "min": 2, "max": 9}], cls="local")
def n_median(o, p):
    s = int(p.get("size", 3))
    a = o.arr
    size = (s, s, 1) if a.ndim == 3 else (s, s)
    return Obj("image", ndi.median_filter(a, size=size), o.meta)


@node("emboss", "Emboss", "image", "image", "image", cls="local")
def n_emboss(o, p):
    g = _gray(o.arr).astype(cp.float32)
    k = cp.asarray([[-2, -1, 0], [-1, 1, 1], [0, 1, 2]], cp.float32)
    return Obj("image", ndi.convolve(g, k) + 128, o.meta)


@node("threshold", "Threshold", "image", "image", "image",
      [{"k": "t", "label": "Level", "type": "float", "default": 128, "min": 0, "max": 255}], cls="point")
def n_thresh(o, p):
    g = _gray(o.arr)
    return Obj("image", (g > float(p.get("t", 128))).astype(cp.float32) * 255, o.meta)


@node("equalize", "Histogram equalize", "image", "image", "image", cls="global")
def n_eq(o, p):
    g = _gray(o.arr).astype(cp.float32)
    hist, bins = cp.histogram(g, 256, (0, 255))
    cdf = cp.cumsum(hist).astype(cp.float32)
    cdf = (cdf - cdf.min()) / (cdf.max() - cdf.min() + 1e-9) * 255
    idx = cp.clip(g, 0, 255).astype(cp.int32)
    return Obj("image", cdf[idx], o.meta)


@node("fft_filter", "FFT frequency filter", "image", "image", "image",
      [{"k": "mode", "label": "Pass", "type": "choice", "choices": ["low", "high"], "default": "low"},
       {"k": "cut", "label": "Cutoff", "type": "float", "default": 0.25, "min": 0.02, "max": 0.9}], cls="global")
def n_fftf(o, p):
    g = _gray(o.arr).astype(cp.float32)
    h, w = g.shape
    F = cp.fft.fftshift(cp.fft.fft2(g))
    yy, xx = cp.ogrid[:h, :w]
    r = cp.sqrt((yy - h / 2) ** 2 + (xx - w / 2) ** 2)
    cut = float(p.get("cut", 0.25)) * min(h, w) / 2
    mask = (r <= cut) if p.get("mode", "low") == "low" else (r > cut)
    img = cp.real(cp.fft.ifft2(cp.fft.ifftshift(F * mask)))
    return Obj("image", img, o.meta)


@node("resize", "Resize", "image", "image", "image",
      [{"k": "scale", "label": "Scale", "type": "float", "default": 0.5, "min": 0.1, "max": 2}], cls="local")
def n_resize(o, p):
    s = float(p.get("scale", 0.5))
    a = o.arr
    zoom = (s, s, 1) if a.ndim == 3 else (s, s)
    return Obj("image", ndi.zoom(a, zoom, order=1), o.meta)


@node("spectrum2d", "2-D spectrum (FFT)", "image", "image", "image", cls="global")
def n_spec2d(o, p):
    g = _gray(o.arr).astype(cp.float32)
    F = cp.fft.fftshift(cp.fft.fft2(g))
    return Obj("image", cp.log1p(cp.abs(F)), o.meta)


# ============================================================ AUDIO
@node("normalize", "Normalize", "audio", "audio", "audio", cls="global")
def n_norm(o, p):
    a = o.arr
    return Obj("audio", a / (cp.abs(a).max() + 1e-9), o.meta)


@node("spectrogram", "Spectrogram (STFT)", "audio", "audio", "image",
      [{"k": "win", "label": "Window", "type": "int", "default": 1024, "min": 256, "max": 4096}], cls="global")
def n_spectro(o, p):
    a = o.arr
    win = int(p.get("win", 1024))
    hop = win // 4
    nfr = max(1, (a.size - win) // hop)
    idx = cp.arange(win)[None, :] + hop * cp.arange(nfr)[:, None]
    frames = a[idx] * cp.hanning(win).astype(cp.float32)
    S = cp.abs(cp.fft.rfft(frames, axis=1)).T
    return Obj("image", cp.log1p(S)[::-1], {**o.meta, "stft": True})


@node("lowpass", "Low-pass (FFT)", "audio", "audio", "audio",
      [{"k": "hz", "label": "Cutoff Hz", "type": "float", "default": 2000, "min": 100, "max": 18000}], cls="global")
def n_lp(o, p):
    a = o.arr
    sr = o.meta.get("sr", 44100)
    F = cp.fft.rfft(a)
    freqs = cp.fft.rfftfreq(a.size, 1 / sr)
    F = F * (freqs <= float(p.get("hz", 2000)))
    return Obj("audio", cp.fft.irfft(F, n=a.size).astype(cp.float32), o.meta)


@node("highpass", "High-pass (FFT)", "audio", "audio", "audio",
      [{"k": "hz", "label": "Cutoff Hz", "type": "float", "default": 500, "min": 20, "max": 8000}], cls="global")
def n_hp(o, p):
    a = o.arr
    sr = o.meta.get("sr", 44100)
    F = cp.fft.rfft(a)
    freqs = cp.fft.rfftfreq(a.size, 1 / sr)
    return Obj("audio", cp.fft.irfft(F * (freqs >= float(p.get("hz", 500))), n=a.size).astype(cp.float32), o.meta)


@node("reverb", "Convolution reverb", "audio", "audio", "audio",
      [{"k": "decay", "label": "Decay s", "type": "float", "default": 0.4, "min": 0.05, "max": 2}], cls="global")
def n_reverb(o, p):
    a = o.arr
    sr = o.meta.get("sr", 44100)
    d = float(p.get("decay", 0.4))
    ir_n = int(sr * d)
    t = cp.arange(ir_n, dtype=cp.float32)
    ir = cp.exp(-t / (sr * d / 4)) * (cp.random.random(ir_n, dtype=cp.float32) * 2 - 1)
    n = a.size + ir_n
    out = cp.fft.irfft(cp.fft.rfft(a, n) * cp.fft.rfft(ir, n), n)[: a.size].astype(cp.float32)
    return Obj("audio", out / (cp.abs(out).max() + 1e-9), o.meta)


@node("autocorr", "Autocorrelation (pitch)", "audio", "audio", "image", cls="global")
def n_ac(o, p):
    a = o.arr
    win = 2048
    nfr = max(1, (a.size - win) // (win // 2))
    idx = cp.arange(win)[None, :] + (win // 2) * cp.arange(nfr)[:, None]
    fr = a[idx]
    F = cp.fft.rfft(fr, axis=1)
    ac = cp.fft.irfft(F * cp.conj(F), axis=1)[:, : win // 2].T
    return Obj("image", cp.abs(ac)[::-1], o.meta)


# ============================================================ MATRIX
@node("standardize", "Standardize", "matrix", "matrix", "matrix", cls="point")
def n_std(o, p):
    a = o.arr
    return Obj("matrix", (a - a.mean(0)) / (a.std(0) + 1e-9), o.meta)


@node("gram", "Gram matrix (AᵀA, cuBLAS)", "matrix", "matrix", "matrix", cls="global")
def n_gram(o, p):
    a = o.arr
    import time
    t = time.time()
    g = a.T @ a
    cp.cuda.Stream.null.synchronize()
    mark_gflops(2 * a.shape[0] * a.shape[1] ** 2, time.time() - t, "cuBLAS SGEMM")
    return Obj("matrix", g, o.meta)


@node("covariance", "Covariance", "matrix", "matrix", "matrix", cls="global")
def n_cov(o, p):
    a = o.arr - o.arr.mean(0)
    return Obj("matrix", (a.T @ a) / max(1, a.shape[0] - 1), o.meta)


@node("pca", "PCA (cuSOLVER SVD)", "matrix", "matrix", "stats",
      [{"k": "k", "label": "Components", "type": "int", "default": 3, "min": 1, "max": 20}], cls="global")
def n_pca(o, p):
    a = o.arr - o.arr.mean(0)
    k = int(p.get("k", 3))
    U, S, Vt = cp.linalg.svd(a, full_matrices=False)
    var = (S ** 2) / (S ** 2).sum()
    return Obj("stats", {"singular_values": to_series(S[:k]), "explained_variance": to_series(var[:k]),
                         "cumulative": round(float(var[:k].sum()), 4)}, o.meta)


@node("fft_cols", "FFT of columns", "matrix", "matrix", "matrix", cls="global")
def n_fftc(o, p):
    return Obj("matrix", cp.abs(cp.fft.fft(o.arr, axis=0)), o.meta)


@node("kmeans", "k-means", "matrix", "matrix", "stats",
      [{"k": "k", "label": "Clusters", "type": "int", "default": 4, "min": 2, "max": 32},
       {"k": "iters", "label": "Iterations", "type": "int", "default": 20, "min": 1, "max": 100}], cls="global")
def n_kmeans(o, p):
    X = o.arr
    k, iters = int(p.get("k", 4)), int(p.get("iters", 20))
    cen = X[cp.random.randint(0, X.shape[0], k)]
    for _ in range(iters):
        d = ((X[:, None, :] - cen[None, :, :]) ** 2).sum(2)
        lab = d.argmin(1)
        for j in range(k):
            m = lab == j
            if int(m.sum()) > 0:
                cen[j] = X[m].mean(0)
    inertia = float(((X - cen[lab]) ** 2).sum())
    _, counts = cp.unique(lab, return_counts=True)
    return Obj("stats", {"clusters": k, "inertia": round(inertia, 2), "sizes": [int(x) for x in cp.asnumpy(counts)]}, o.meta)


@node("stats", "Summary stats", "matrix", "matrix", "stats", cls="global")
def n_stats(o, p):
    a = o.arr
    return Obj("stats", {"shape": list(a.shape), "mean": round(float(a.mean()), 4), "std": round(float(a.std()), 4),
                         "min": round(float(a.min()), 4), "max": round(float(a.max()), 4),
                         "col_means": to_series(a.mean(0)[:32])}, o.meta)


CATALOG_ORDER = ["image", "audio", "matrix"]
