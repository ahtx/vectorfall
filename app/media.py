"""Photo Lab, Sound Lab and Data Desk: everyday work, done on the card.

Photo: exposure, white balance, contrast, highlights/shadows, saturation, sharpen, denoise, vignette, grain, looks —
       one fused pass per adjustment on a float image resident on the GPU; previews at screen size, exports at full size.
Sound: anything ffmpeg can read, up to 5 minutes; EQ, filters, spectral denoise, reverb, echo, pitch and tempo
       (phase vocoder), all FFT work on the card. Returns a WAV, a waveform and a spectrogram.
Data:  a CSV becomes a GPU matrix: column statistics, histograms, correlations, PCA + k-means, sorting and filtering.
"""
import base64
import csv
import io
import json
import math
import os
import re
import subprocess
import time
import uuid
import wave
import zipfile

import numpy as np
from PIL import Image

import cupy as cp
import cupyx.scipy.ndimage as ndi

from .engine import mark_gflops, run_on_gpu, sync

ROOT = "/srv/data"
for d in ("photos", "sounds", "tables"):
    os.makedirs(os.path.join(ROOT, d), exist_ok=True)


def _png(arr_u8):
    b = io.BytesIO()
    Image.fromarray(arr_u8).save(b, "PNG", compress_level=1)
    return "data:image/png;base64," + base64.b64encode(b.getvalue()).decode()


# ================================================================ PHOTO LAB
LOOKS = {
    "none": {},
    "vivid": {"contrast": 0.18, "saturation": 0.35, "sharpen": 0.6, "auto": 0.6},
    "film": {"contrast": -0.08, "saturation": -0.15, "warmth": 0.25, "grain": 0.35, "shadows": 0.25, "fade": 0.12},
    "noir": {"bw": 1, "contrast": 0.35, "vignette": 0.45, "grain": 0.25},
    "cinema": {"teal_orange": 0.6, "contrast": 0.15, "vignette": 0.25, "saturation": 0.1},
    "warm": {"warmth": 0.45, "exposure": 0.1, "saturation": 0.1},
    "cool": {"warmth": -0.4, "tint": 0.05, "contrast": 0.05},
    "faded": {"fade": 0.25, "contrast": -0.15, "saturation": -0.3, "warmth": 0.1},
    "sepia": {"sepia": 1, "contrast": 0.05, "vignette": 0.3},
    "punch": {"auto": 1.0, "contrast": 0.25, "saturation": 0.25, "sharpen": 0.9, "clarity": 0.5},
}


def photo_add(name, data):
    pid = uuid.uuid4().hex[:10]
    d = os.path.join(ROOT, "photos", pid)
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
    except Exception:  # noqa: BLE001
        ext = os.path.splitext(name)[1].lower()
        if ext in (".heic", ".heif", ".avif", ".cr2", ".cr3", ".nef", ".arw", ".dng", ".raf", ".orf", ".rw2"):
            raise ValueError("{} photos cannot be read yet. Export them as JPEG first.".format(ext[1:].upper()))
        raise ValueError("this is not a picture VectorFall can read (JPEG, PNG, WebP, TIFF, BMP, GIF)")
    exif = im.info.get("exif")                          # the camera's date, model, GPS: put back into full-size exports
    try:
        from PIL import ImageOps
        im = ImageOps.exif_transpose(im)
    except Exception:  # noqa: BLE001
        pass
    im = im.convert("RGB")
    note = ""
    if max(im.size) > 6000:
        note = "stored at most 6000 px on the long side (it was {}×{})".format(im.size[0], im.size[1])
        im.thumbnail((6000, 6000), Image.LANCZOS)
    os.makedirs(d)
    im.save(os.path.join(d, "orig.png"), compress_level=1)     # level 6 (the default) cost 12.7 s per 12 MP photo
    if exif:
        with open(os.path.join(d, "exif.bin"), "wb") as f:
            f.write(exif)
    _write_proxy(d, im)
    th = im.copy()
    th.thumbnail((360, 360))
    b = io.BytesIO()
    th.save(b, "JPEG", quality=82)
    meta = {"id": pid, "name": name, "w": im.size[0], "h": im.size[1], "added": time.time()}
    if note:
        meta["note"] = note
    with open(os.path.join(d, "meta.json"), "w") as f:
        json.dump(meta, f)
    with open(os.path.join(d, "thumb.jpg"), "wb") as f:
        f.write(b.getvalue())
    return meta


def photo_list():
    out = []
    base = os.path.join(ROOT, "photos")
    for pid in os.listdir(base):
        if pid.startswith("."):          # .trash and other housekeeping folders are not photos
            continue
        mp = os.path.join(base, pid, "meta.json")
        if os.path.exists(mp):
            with open(mp) as f:
                m = json.load(f)
            ep = os.path.join(base, pid, "edit.json")
            if os.path.exists(ep):                   # the culling marks and whether there is an edit
                try:
                    with open(ep) as f:
                        e = json.load(f)
                    m["flag"], m["stars"] = e.get("flag", 0), e.get("stars", 0)
                    m["edited"] = bool(e["history"][e.get("pos", len(e["history"]) - 1)]["adj"])
                except (OSError, ValueError, KeyError, IndexError):
                    pass
            out.append(m)
    return sorted(out, key=lambda m: -m["added"])


def photo_path(pid, what="orig.png"):
    return os.path.join(ROOT, "photos", os.path.basename(pid), what)


def photo_delete(pid):
    """Removes a photo from the library by moving it to photos/.trash (recoverable: move the folder back)."""
    import shutil
    _cache_drop(pid)
    src = os.path.join(ROOT, "photos", os.path.basename(pid))
    if not os.path.isdir(src):
        return
    trash = os.path.join(ROOT, "photos", ".trash")
    os.makedirs(trash, exist_ok=True)
    shutil.move(src, os.path.join(trash, "{}-{}".format(os.path.basename(pid), time.strftime("%Y%m%d-%H%M%S"))))


def photo_dhash(pid):
    """64+64-bit difference hash of the thumbnail (rows and columns), as a 0/1 array; CPU, about 1 ms."""
    im = np.asarray(Image.open(photo_path(pid, "thumb.jpg")).convert("L").resize((17, 17)), np.float32)
    return np.concatenate([(im[:16, 1:] > im[:16, :-1]).ravel(), (im[1:, :16] > im[:-1, :16]).ravel()]).astype(np.uint8)


# ---- preview proxy + decoded-array cache. Decoding a 24 MP PNG costs ~1.4 s on this CPU; doing that on every
# slider move is what made edits feel like they "didn't happen". Previews come from a 2560 px proxy instead, and
# the last few decoded/resized arrays stay in RAM, so a preview render is GPU time plus a JPEG encode.
PROXY = 2560
_ARR = {}            # (pid, key) -> np.uint8 HxWx3 ; insertion-ordered LRU
_ARR_MAX = 10
_AUTO = {}           # pid -> (lo, hi) per-channel auto-levels from the proxy


def _write_proxy(d, im):
    px = im.copy()
    if max(px.size) > PROXY:
        px.thumbnail((PROXY, PROXY), Image.LANCZOS)
    px.save(os.path.join(d, "proxy.jpg"), "JPEG", quality=95)


def _cache_get(key, make):
    if key in _ARR:
        v = _ARR.pop(key)
        _ARR[key] = v
        return v
    v = make()
    _ARR[key] = v
    while len(_ARR) > _ARR_MAX:
        _ARR.pop(next(iter(_ARR)))
    return v


def _cache_drop(pid):
    for k in [k for k in _ARR if k[0] == pid]:
        _ARR.pop(k, None)
    _AUTO.pop(pid, None)


def _meta(pid):
    with open(photo_path(pid, "meta.json")) as f:
        return json.load(f)


def _orig(pid):
    return _cache_get((pid, "orig"), lambda: np.asarray(Image.open(photo_path(pid)).convert("RGB"), np.uint8))


def _preview(pid, max_side):
    """Downsized original for previews, built from the proxy (or the original when asked for more than it holds)."""
    max_side = int(max_side)

    def make():
        pp = photo_path(pid, "proxy.jpg")
        if not os.path.exists(pp):
            _write_proxy(os.path.dirname(pp), Image.open(photo_path(pid)).convert("RGB"))
        im = Image.open(pp).convert("RGB")
        if max_side > max(im.size):
            m = _meta(pid)
            if max(m["w"], m["h"]) > max(im.size):             # proxy too small for this request: use the original
                im = Image.fromarray(_orig(pid))
        if max(im.size) > max_side:
            im = im.copy()
            im.thumbnail((max_side, max_side), Image.LANCZOS)
        return np.asarray(im, np.uint8)
    return _cache_get((pid, max_side), make)


def _auto_levels(pid):
    """0.5 / 99.5 percentile per channel from a 256-bin histogram of the proxy (once per photo, cached)."""
    if pid not in _AUTO:
        arr = _preview(pid, 1024)

        def job():
            x = cp.asarray(arr)
            lo, hi = [], []
            for c in range(3):
                h = cp.bincount(x[..., c].ravel(), minlength=256).astype(cp.float64)
                cdf = cp.asnumpy(cp.cumsum(h) / float(h.sum()))          # 256 values: search on the host
                lo.append(float(np.searchsorted(cdf, 0.005)) / 255.0)
                hi.append(float(np.searchsorted(cdf, 0.995)) / 255.0)
            return np.array(lo, np.float32), np.array(hi, np.float32)
        _AUTO[pid] = run_on_gpu(job, "photo levels", 30)
    return _AUTO[pid]


def _lum(x):
    return x[..., 0] * 0.2126 + x[..., 1] * 0.7152 + x[..., 2] * 0.0722


def _blur_big(L, sigma):
    """Gaussian blur of a 2-D map for large sigma: block-average down by f, blur at sigma/f, bilinear back up.
    A sigma-75 blur at full resolution is a 601-tap filter over 24 MP (tens of seconds on the K420); the result is
    pure low frequency, so computing it at 1/f scale is visually identical and ~f^2 cheaper."""
    f = int(sigma // 4)
    if f < 2:
        return ndi.gaussian_filter(L, sigma)
    h, w = L.shape
    H, W = -(-h // f) * f, -(-w // f) * f
    Lp = cp.pad(L, ((0, H - h), (0, W - w)), mode="edge") if (H, W) != (h, w) else L
    low = ndi.gaussian_filter(Lp.reshape(H // f, f, W // f, f).mean(axis=(1, 3)), sigma / f)

    def axis(n, m):
        t = (cp.arange(n, dtype=cp.float32) + 0.5) / f - 0.5
        i0 = cp.floor(t)
        wgt = cp.clip(t - i0, 0, 1)
        i0 = i0.astype(cp.int32)
        return cp.clip(i0, 0, m - 1), cp.clip(i0 + 1, 0, m - 1), wgt
    y0, y1, wy = axis(h, low.shape[0])
    x0, x1, wx = axis(w, low.shape[1])
    tmp = low[y0] * (1 - wy)[:, None] + low[y1] * wy[:, None]
    return tmp[:, x0] * (1 - wx)[None, :] + tmp[:, x1] * wx[None, :]


SLIDER_KEYS = ("exposure", "contrast", "highlights", "shadows", "whites", "blacks", "warmth", "tint", "vibrance", "saturation",
               "clarity", "sharpen", "denoise", "vignette", "grain", "fade", "auto", "teal_orange", "bw", "sepia")
MIXES = ("bw", "sepia")                  # these replace the look's value; every other slider adds to it


def _params(a):
    """The UI's adjustment dict -> the resolved slider values: the look's values times its amount, plus the sliders."""
    name = a.get("look") or "none"
    looks = all_looks()
    if name not in looks:
        raise ValueError("there is no look called “{}” (looks: {})".format(name, ", ".join(sorted(looks))))
    try:
        amt = float(a.get("amount", 1) if a.get("amount") not in (None, "") else 1)
    except (TypeError, ValueError):
        amt = 1.0
    amt = max(0.0, min(2.0, amt))
    p = {k: float(v) * amt for k, v in looks[name].items() if k in SLIDER_KEYS}
    for k, v in a.items():
        if k not in SLIDER_KEYS or v in (None, ""):
            continue
        try:
            fv = float(v)
        except (TypeError, ValueError):
            continue
        p[k] = fv if k in MIXES else p.get(k, 0) + fv
    return p


def _reach(p, ctx):
    from . import photo_fx
    return photo_fx.reach(p, ctx)


def _develop_gpu(src_u8, p, ctx, masks=None, show=-1):
    """uint8 host or card array -> uint8 result on the card (the fused kernels in photo_fx)."""
    from . import photo_fx
    x = src_u8 if isinstance(src_u8, cp.ndarray) else cp.asarray(src_u8)
    return photo_fx.develop(x, p, ctx, _blur_big, masks, show)


def _adjust(x, a, ctx=None):
    """Compatibility: float 0..1 HxWx3 on the card -> float 0..1 result (used by older callers and tests)."""
    h, w = x.shape[:2]
    ctx = ctx or {"H": h, "W": w, "s": 1.0, "y0": 0, "x0": 0, "auto": None}
    u8 = (cp.clip(x, 0, 1) * 255 + 0.5).astype(cp.uint8)
    return _develop_gpu(u8, _params(a), ctx).astype(cp.float32) / 255.0


# ---- geometry: quarter turns, flip, straighten and crop. The "canvas" is the photo after the turn and the flip, at
# full resolution (Wq x Hq), rotated by `angle` about its centre; crop_box is a rectangle on it in fractions (0..1).
# With a rotation, the crop is shrunk about its centre until no corner leaves the photo (as other editors do).
GEO_KEYS = ("crop_box", "angle", "turn", "flip")


def _inside(px, py, G):
    dx, dy = px - G["Wq"] / 2.0, py - G["Hq"] / 2.0
    xo = G["Wq"] / 2.0 + G["cos"] * dx + G["sin"] * dy
    yo = G["Hq"] / 2.0 - G["sin"] * dx + G["cos"] * dy
    return -0.5 <= xo <= G["Wq"] + 0.5 and -0.5 <= yo <= G["Hq"] + 0.5


def _fit(box, G):
    x0, y0, x1, y1 = box
    cx, cy, hw, hh = (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2
    ok = lambda k: all(_inside(cx + sx * hw * k, cy + sy * hh * k, G) for sx in (-1, 1) for sy in (-1, 1))  # noqa: E731
    if ok(1.0):
        return box, False
    if not _inside(cx, cy, G):
        cx, cy = G["Wq"] / 2.0, G["Hq"] / 2.0
    lo, hi = 0.0, 1.0
    for _ in range(30):
        k = (lo + hi) / 2
        lo, hi = (k, hi) if ok(k) else (lo, k)
    return [cx - hw * lo, cy - hh * lo, cx + hw * lo, cy + hh * lo], True


def geometry(W0, H0, adj):
    """The render frame for an edit: canvas size, the (fitted) crop box in canvas pixels, the frame size."""
    adj = adj or {}
    turn = int(adj.get("turn") or 0) % 4
    flip = bool(adj.get("flip"))
    ang = float(adj.get("angle") or 0)
    Wq, Hq = (W0, H0) if turn % 2 == 0 else (H0, W0)
    r = math.radians(ang)
    G = {"turn": turn, "flip": flip, "angle": ang, "Wq": Wq, "Hq": Hq, "cos": math.cos(r), "sin": math.sin(r), "W0": W0, "H0": H0}
    cb = adj.get("crop_box") or [0, 0, 1, 1]
    if adj.get("_nocrop"):
        box, fitted = [0.0, 0.0, float(Wq), float(Hq)], False
    else:
        box, fitted = _fit([cb[0] * Wq, cb[1] * Hq, cb[2] * Wq, cb[3] * Hq], G)
    G.update(box=box, fitted=fitted, fw=max(1, int(round(box[2] - box[0]))), fh=max(1, int(round(box[3] - box[1]))))
    G["identity"] = turn == 0 and not flip and ang == 0 and G["fw"] == W0 and G["fh"] == H0 and box[0] < 0.5 and box[1] < 0.5
    return G


def geometry_view(G):
    return {"canvas": [G["Wq"], G["Hq"]], "box": [round(v / d, 5) for v, d in zip(G["box"], (G["Wq"], G["Hq"], G["Wq"], G["Hq"]))],
            "frame": [G["fw"], G["fh"]], "fitted": G["fitted"], "angle": G["angle"], "turn": G["turn"], "flip": G["flip"]}


def _wq(G, s, ox, oy, src_w, src_h):
    """The warp kernel's parameters for output pixels (ox, oy)+ at s render px per canvas px, from a source array
    of src_w x src_h (the original or a downsized preview)."""
    return [ox, oy, 1.0 / s, G["box"][0], G["box"][1], G["Wq"], G["Hq"], G["cos"], G["sin"], G["turn"], 1.0 if G["flip"] else 0.0,
            G["W0"], G["H0"], src_w / float(G["W0"]), src_w, src_h]


def _ctx(G, s, auto, y0=0, x0=0):
    return {"H": G["fh"], "W": G["fw"], "s": s, "y0": y0, "x0": x0, "auto": auto, "Wq": G["Wq"], "Hq": G["Hq"],
            "cx0": G["box"][0], "cy0": G["box"][1]}


def _src_for(pid, G, s):
    """A source array with at least s of the original's resolution (the proxy when it is enough)."""
    W0, H0 = G["W0"], G["H0"]
    need = int(math.ceil(max(W0, H0) * s / 256.0) * 256)
    return _orig(pid) if need >= max(W0, H0) else _preview(pid, need)


def _warp_host(pid, G, s=1.0):
    """The whole geometry frame at s, uint8 on the host (warped on the card in strips)."""
    from . import photo_fx
    src = _src_for(pid, G, s)
    ow, oh = max(1, int(round(G["fw"] * s))), max(1, int(round(G["fh"] * s)))
    out = np.empty((oh, ow, 3), np.uint8)

    def job():
        S = cp.asarray(src)
        rows = max(64, int(64e6 // max(1, ow * 3)))
        for y in range(0, oh, rows):
            n = min(rows, oh - y)
            out[y:y + n] = cp.asnumpy(photo_fx.warp(S, _wq(G, s, 0, y, src.shape[1], src.shape[0]), n, ow))
        del S
        return True
    run_on_gpu(job, "photo geometry", 120)
    return out


def _render_tiled(arr, adj, ctx):
    """Adjust a whole uint8 image in horizontal strips sized to the card's free memory, each strip carrying enough
    overlap for the spatial effects, so a 24 MP export fits on a 1 GB card. Returns uint8 HxWx3 on the host."""
    from .engine import budget_bytes
    H, W = arr.shape[:2]
    p = _params(adj)
    masks = adj.get("masks")
    ctx = dict(ctx, local_clarity=any(((m.get("adj") or {}).get("clarity") for m in (masks or []))))
    pad = -(-_reach(p, ctx) // 32) * 32
    out = np.empty_like(arr)

    def job():
        cp.get_default_memory_pool().free_all_blocks()
        per_row = W * 3 * 4 * 5                       # float32 image + blur temporaries + uint8 in/out
        rows = int(max(64, min(H, budget_bytes(160) // per_row - 2 * pad)))
        q = 32                                         # multiple of any _blur_big factor up to 32: seamless strips
        rows = max(q, rows // q * q)
        t0 = time.time()
        y = 0
        while y < H:
            a0, a1 = max(0, y - pad), min(H, y + rows + pad)
            r = _develop_gpu(np.ascontiguousarray(arr[a0:a1]), p, dict(ctx, y0=ctx.get("y0", 0) + a0), masks)
            n = min(rows, H - y)
            out[y:y + n] = cp.asnumpy(r[y - a0:y - a0 + n])
            del r
            cp.get_default_memory_pool().free_all_blocks()
            y += rows
        sync()
        return time.time() - t0
    dt = run_on_gpu(job, "photo export", 600)
    return out, dt


def _hist(img_u8):
    from . import photo_fx

    def job():
        return photo_fx.stats(cp.asarray(img_u8))
    return run_on_gpu(job, "photo hist", 30)


def photo_render(pid, adj, max_side=1400, fmt="JPEG", quality=None):
    """Preview (max_side px), full-resolution export (max_side=0), or a native-resolution window for 1:1 viewing
    (adj["_crop"] = [x0, y0, w, h] in pixels of the frame, that is after crop and rotation). Returns the encoded image
    and its meta (times, histogram, clipped share of pixels, the geometry)."""
    from . import photo_fx
    adj = dict(adj or {})
    view = adj.pop("_crop", None)
    show = adj.pop("_mask_view", None)
    show = -1 if show is None or show == "" else int(show)
    masks = adj.get("masks") or None
    m = _meta(pid)
    W0, H0 = int(m["w"]), int(m["h"])
    p = _params(adj)
    G = geometry(W0, H0, adj)
    auto = _auto_levels(pid) if p.get("auto") else None
    lcl = any(((mk.get("adj") or {}).get("clarity") for mk in (masks or [])))
    stats = None
    FW, FH = G["fw"], G["fh"]
    if view:
        cx, cy, cw, ch = [int(round(float(v))) for v in view]
        cw, ch = min(FW, max(16, min(cw, 4096))), min(FH, max(16, min(ch, 4096)))
        cx, cy = max(0, min(cx, FW - cw)), max(0, min(cy, FH - ch))
        ctx = _ctx(G, 1.0, auto)
        ctx["local_clarity"] = lcl
        pad = _reach(p, ctx)
        a0, a1 = max(0, cy - pad), min(FH, cy + ch + pad)
        b0, b1 = max(0, cx - pad), min(FW, cx + cw + pad)
        src = _orig(pid)
        if G["identity"]:
            tile = np.ascontiguousarray(src[a0:a1, b0:b1])
        ctx.update(y0=a0, x0=b0)

        def job():
            t0 = time.time()
            t = cp.asarray(tile) if G["identity"] else photo_fx.warp(cp.asarray(src), _wq(G, 1.0, b0, a0, W0, H0), a1 - a0, b1 - b0)
            r = cp.ascontiguousarray(_develop_gpu(t, p, ctx, masks, show)[cy - a0:cy - a0 + ch, cx - b0:cx - b0 + cw])
            st = photo_fx.stats(r)
            o = cp.asnumpy(r)
            sync()
            return o, st, time.time() - t0
        out, stats, dt = run_on_gpu(job, "photo 1:1", 120)
        extra = {"crop": [cx, cy, cw, ch]}
    elif not max_side or max_side >= max(FW, FH):
        arr = _orig(pid) if G["identity"] else _warp_host(pid, G, 1.0)
        out, dt = _render_tiled(arr, dict(adj, masks=masks), _ctx(G, 1.0, auto))
        extra = {}
    else:
        s = max_side / float(max(FW, FH))
        if G["identity"]:
            arr = _preview(pid, max_side)
            s = arr.shape[1] / float(W0)
        else:
            arr = _src_for(pid, G, s)
        ow, oh = max(1, int(round(FW * s))), max(1, int(round(FH * s)))
        ctx = _ctx(G, s, auto)

        def job():
            t0 = time.time()
            x = cp.asarray(arr)
            if not G["identity"]:
                x = photo_fx.warp(x, _wq(G, s, 0, 0, arr.shape[1], arr.shape[0]), oh, ow)
            r = _develop_gpu(x, p, ctx, masks, show)
            st = photo_fx.stats(r)
            o = cp.asnumpy(r)
            sync()
            return o, st, time.time() - t0
        out, stats, dt = run_on_gpu(job, "photo", 120)
        extra = {}
    hist, clip = stats if stats else _hist(out[::2, ::2] if max(out.shape[:2]) > 3000 else out)
    t1 = time.time()
    b = io.BytesIO()
    if fmt == "JPEG":
        kw = {}
        xp = photo_path(pid, "exif.bin")
        if not max_side and os.path.exists(xp):           # a full-size export keeps the camera's EXIF, upright
            try:
                ex = Image.Exif()
                ex.load(open(xp, "rb").read())
                ex[274] = 1                               # orientation: the pixels are already turned
                kw["exif"] = ex.tobytes()
            except Exception:  # noqa: BLE001
                pass
        Image.fromarray(out).save(b, "JPEG", quality=int(quality or (93 if max_side else 95)), **kw)
    else:
        Image.fromarray(out).save(b, fmt)
    meta = {"ms": round(dt * 1000, 1), "encode_ms": round((time.time() - t1) * 1000, 1), "w": int(out.shape[1]),
            "h": int(out.shape[0]), "src_w": W0, "src_h": H0, "look": adj.get("look") or "none", "hist": hist, "clip": clip,
            "geom": geometry_view(G)}
    meta.update(extra)
    return b.getvalue(), meta


def _frame_preview(pid, adj, max_side):
    """The geometry frame of an edit at about max_side px (uint8, host) and its develop context."""
    m = _meta(pid)
    G = geometry(int(m["w"]), int(m["h"]), adj)
    if G["identity"]:
        arr = _preview(pid, max_side)
        return arr, _ctx(G, arr.shape[1] / float(G["W0"]), None)
    s = min(1.0, max_side / float(max(G["fw"], G["fh"])))
    return _warp_host(pid, G, s), _ctx(G, s, None)


def photo_straighten(pid, adj=None):
    """Find the tilt from the photo's own straight lines (horizon, walls, poles): rotate the edge map through
    -15..+15 degrees and keep the angle where the row and column profiles are sharpest. The evidence is that
    sharpness at the chosen angle and at 0 degrees, against the average over all the angles tried (1.0 = chance)."""
    from . import photo_fx
    base = {k: v for k, v in (adj or {}).items() if k in ("turn", "flip")}
    base["_nocrop"] = True
    arr, _ = _frame_preview(pid, base, 1024)
    coarse = np.arange(-15.0, 15.01, 0.25)

    def job():
        x = cp.asarray(arr)
        c = photo_fx.level_scores(x, coarse)
        b = float(coarse[int(np.argmax(c.sum(axis=1)))])
        fine = np.arange(b - 0.3, b + 0.301, 0.02)
        f = photo_fx.level_scores(x, list(fine) + [0.0])
        return c, fine, f
    c, fine, f = run_on_gpu(job, "photo straighten", 60)
    # each family of lines on its own: a real tilt of the camera turns horizontals and verticals by the same angle,
    # while perspective (a box seen from the side, a road) turns only one family
    fam = []
    for j, name in ((0, "horizontal"), (1, "vertical")):
        cj = c[:, j]
        i = int(np.argmax(cj))
        rest = [v for a, v in zip(coarse, cj) if abs(a - coarse[i]) > 2]
        fam.append({"lines": name, "angle": float(coarse[i]), "peak": round(float(cj[i]), 2),
                    "next_best": round(float(max(rest)), 2), "as_is": round(float(cj[int(np.argmin(np.abs(coarse)))]), 2)})
        fam[-1]["clear"] = fam[-1]["peak"] >= 2.5 and fam[-1]["peak"] >= 1.3 * fam[-1]["next_best"]
    clear_f = [x for x in fam if x["clear"]]
    tot = c.sum(axis=1)
    k = int(np.argmax(f[:-1].sum(axis=1)))
    rot = float(fine[k])
    why = ""
    if len(clear_f) == 2 and abs(clear_f[0]["angle"] - clear_f[1]["angle"]) > 0.75:
        clear, why = False, "the horizontal lines say {:+.2f}° and the vertical lines {:+.2f}°: perspective, not a tilt".format(
            -clear_f[0]["angle"], -clear_f[1]["angle"])
    elif not clear_f:
        clear, why = False, "no clear horizon or vertical lines (best {:.1f}× and {:.1f}× the average; needs 2.5×)".format(fam[0]["peak"], fam[1]["peak"])
    elif len(clear_f) == 1 and abs(rot) > 3:
        clear, why = False, "only the {} lines are clear, and they ask for {:+.2f}°: too far to trust one family of lines".format(clear_f[0]["lines"], -rot)
    else:
        clear = True
    if clear:                                         # refine on the family (or families) that are clear
        sel = [0 if x["lines"] == "horizontal" else 1 for x in clear_f]
        k = int(np.argmax(f[:-1][:, sel].sum(axis=1)))
        rot = float(fine[k])
    # the edge map turned by rot is level, so the photo must turn by the same amount in the other sense
    angle = round(-rot, 2) if clear and abs(rot) >= 0.05 else 0.0
    best, at0 = float(tot.max() / 2), float(tot[int(np.argmin(np.abs(coarse)))] / 2)
    if not clear:
        verdict = why + ": left alone"
    elif angle == 0:
        verdict = "already level ({} lines)".format(" and ".join(x["lines"] for x in clear_f))
    else:
        verdict = "rotate {:+.2f}°: the {} lines are sharpest there ({}; 1.0 = the average angle)".format(
            angle, " and ".join(x["lines"] for x in clear_f), ", ".join("{:.1f}× vs {:.1f}× as it is".format(x["peak"], x["as_is"]) for x in clear_f))
    return {"photo": pid, "angle": angle, "clear": clear, "headline": "{:+.2f}°".format(angle), "sentence": verdict,
            "families": fam, "chance": 1.0,
            "profile": {"angles": [round(float(a), 2) for a in coarse], "horizontal": [round(float(v), 3) for v in c[:, 0]],
                        "vertical": [round(float(v), 3) for v in c[:, 1]]}}


def photo_batch(ids, adj, job=None, saved=False):
    """Full-resolution exports in a zip: the same settings for every photo, or (saved=True) each photo's own edit."""
    buf = io.BytesIO()
    done, failed = 0, []
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        for i, pid in enumerate(ids):
            try:
                data, _ = photo_render(pid, edit_get(pid)["adj"] if saved else adj, max_side=0)
                name = _meta(pid)["name"].rsplit(".", 1)[0]
                z.writestr("{}-vectorfall.jpg".format(name), data)
                done += 1
            except Exception as e:  # noqa: BLE001
                failed.append("{}: {}".format(pid, str(e)[:80]))
            finally:
                _ARR.pop((pid, "orig"), None)          # exports are one-shot; don't keep 70 MB arrays around
            if job:
                job.step((i + 1) / max(1, len(ids)), "{} of {}".format(i + 1, len(ids)))
    path = os.path.join(ROOT, "photos", "batch-{}.zip".format(uuid.uuid4().hex[:8]))
    with open(path, "wb") as f:
        f.write(buf.getvalue())
    return {"zip": os.path.basename(path), "count": done, "failed": failed, "own_edits": bool(saved)}


# ---- the edit record: photos/<id>/edit.json. The original pixels never change; an edit is a list of slider values
# with a history of named steps (undo/redo to any step), a flag (pick/reject) and a star rating. It lives on the
# server, so every browser, the CLI and an agent over MCP see the same edit.
import threading as _threading                                     # noqa: E402
_EDIT_LOCK = _threading.Lock()
HISTORY_MAX = 200
GROUPS = {"light": ("exposure", "contrast", "highlights", "shadows", "whites", "blacks"),
          "colour": ("warmth", "tint", "vibrance", "saturation"),
          "detail": ("clarity", "sharpen", "denoise"),
          "effects": ("vignette", "grain", "fade"),
          "look": ("look", "amount"),
          "geometry": ("crop_box", "angle", "turn", "flip"),
          "masks": ("masks",)}
NOT_PASTED = ("crop_box", "angle", "turn", "flip", "masks")      # pasted only when asked for (as other editors do)
MASK_TYPES = ("linear", "radial", "brush")


def _f(v, lo, hi, nd=4):
    return round(max(lo, min(hi, float(v))), nd)


def _clean_masks(ms):
    from .photo_fx import LOCAL_KEYS, MAX_MASKS
    if not isinstance(ms, list):
        raise ValueError("masks must be a list")
    out = []
    for i, m in enumerate(ms[:MAX_MASKS]):
        t = m.get("type")
        if t not in MASK_TYPES:
            raise ValueError("mask {}: type must be one of {}".format(i + 1, ", ".join(MASK_TYPES)))
        c = {"type": t, "name": str(m.get("name") or "{} {}".format(t.capitalize(), i + 1))[:40]}
        if t == "linear":
            for k, d in (("x0", 0.5), ("y0", 0.3), ("x1", 0.5), ("y1", 0.7)):
                c[k] = _f(m.get(k, d), -1, 2)
        elif t == "radial":
            for k, d in (("x", 0.5), ("y", 0.5)):
                c[k] = _f(m.get(k, d), -1, 2)
            for k in ("rx", "ry"):
                c[k] = _f(m.get(k, 0.25), 0.005, 3)
            c["feather"] = _f(m.get("feather", 0.5), 0, 1, 3)
        else:
            dabs = m.get("dabs") or []
            if len(dabs) > 6000:
                raise ValueError("mask {}: at most 6000 brush dabs".format(i + 1))
            c["dabs"] = [[_f(d[0], -0.5, 1.5), _f(d[1], -0.5, 1.5), _f(d[2], 0.001, 1), _f(d[3] if len(d) > 3 else 0.5, 0, 1, 3),
                          1 if len(d) > 4 and d[4] else 0] for d in dabs]
        if m.get("invert"):
            c["invert"] = True
        a = {}
        for k, v in (m.get("adj") or {}).items():
            if k not in LOCAL_KEYS:
                raise ValueError("mask {}: {} is not a local slider (local sliders: {})".format(i + 1, k, ", ".join(LOCAL_KEYS)))
            fv = _f(v, -2, 2, 3)
            if fv:
                a[k] = fv
        c["adj"] = a
        out.append(c)
    return out


def _clean_adj(adj):
    a = {}
    for k, v in (adj or {}).items():
        if k == "look":
            if v and v != "none":
                a["look"] = str(v)
        elif k == "amount":
            try:
                fv = round(max(0.0, min(2.0, float(v))), 3)
            except (TypeError, ValueError):
                continue
            if fv != 1:
                a["amount"] = fv
        elif k in SLIDER_KEYS:
            try:
                fv = round(float(v), 3)
            except (TypeError, ValueError):
                continue
            if fv:
                a[k] = fv
        elif k == "crop_box" and v:
            b = [_f(x, 0, 1) for x in list(v)[:4]]
            if len(b) != 4:
                raise ValueError("crop_box is [x0, y0, x1, y1] in fractions of the photo")
            x0, x1, y0, y1 = min(b[0], b[2]), max(b[0], b[2]), min(b[1], b[3]), max(b[1], b[3])
            if x1 - x0 < 0.02 or y1 - y0 < 0.02:
                raise ValueError("the crop is too small")
            if [x0, y0, x1, y1] != [0, 0, 1, 1]:
                a["crop_box"] = [x0, y0, x1, y1]
        elif k == "angle":
            fv = _f(v, -45, 45, 2)
            if fv:
                a["angle"] = fv
        elif k == "turn":
            if int(v) % 4:
                a["turn"] = int(v) % 4
        elif k == "flip":
            if v:
                a["flip"] = True
        elif k == "masks" and v:
            ms = _clean_masks(v)
            if ms:
                a["masks"] = ms
    if "look" not in a:
        a.pop("amount", None)
    return a


def _edit_path(pid):
    if not os.path.exists(photo_path(pid, "meta.json")):
        raise FileNotFoundError("no photo with id {}".format(pid))
    return photo_path(pid, "edit.json")


def _edit_load(pid):
    p = _edit_path(pid)
    if os.path.exists(p):
        try:
            with open(p) as f:
                e = json.load(f)
            e.setdefault("history", [{"adj": {}, "label": "Original", "t": 0}])
            e.setdefault("pos", len(e["history"]) - 1)
            e.setdefault("flag", 0)
            e.setdefault("stars", 0)
            return e
        except (OSError, ValueError):
            pass
    return {"history": [{"adj": {}, "label": "Original", "t": 0}], "pos": 0, "flag": 0, "stars": 0}


def _edit_save(pid, e):
    p = _edit_path(pid)
    tmp = p + ".tmp"
    with open(tmp, "w") as f:
        json.dump(e, f)
    os.replace(tmp, p)                                  # atomic: a crash never leaves half an edit


def _edit_view(pid, e):
    h = e["history"]
    return {"photo": pid, "adj": dict(h[e["pos"]]["adj"]), "pos": e["pos"], "steps": len(h),
            "history": [{"label": s["label"], "t": s.get("t", 0)} for s in h],
            "can_undo": e["pos"] > 0, "can_redo": e["pos"] < len(h) - 1, "flag": e["flag"], "stars": e["stars"],
            "edited": bool(h[e["pos"]]["adj"]), "geom": _geom_of(pid, h[e["pos"]]["adj"])}


def _geom_of(pid, adj):
    try:
        m = _meta(pid)
        return geometry_view(geometry(int(m["w"]), int(m["h"]), adj))
    except (OSError, ValueError, KeyError):
        return None


def edit_get(pid):
    with _EDIT_LOCK:
        return _edit_view(pid, _edit_load(pid))


def edit_set(pid, adj, label="Edit", merge=False):
    """Make adj the photo's current edit as a new history step (the redo steps after the current one are dropped).
    merge=True changes only the keys given (and a value of 0 removes a key)."""
    _params(adj or {})                                  # validates the look name
    with _EDIT_LOCK:
        e = _edit_load(pid)
        h = e["history"][:e["pos"] + 1]
        cur = dict(h[-1]["adj"])
        new = _clean_adj(dict(cur, **(adj or {})) if merge else adj)
        if new != cur:
            h.append({"adj": new, "label": str(label or "Edit")[:60], "t": time.time()})
            if len(h) > HISTORY_MAX:
                h = h[:1] + h[-(HISTORY_MAX - 1):]
            e["history"], e["pos"] = h, len(h) - 1
            _edit_save(pid, e)
        return _edit_view(pid, e)


def edit_go(pid, pos=None, by=None):
    """Move to a history step: an index, or by=-1 (undo) / +1 (redo). The other steps stay."""
    with _EDIT_LOCK:
        e = _edit_load(pid)
        n = len(e["history"])
        to = e["pos"] + int(by) if by is not None else int(pos)
        e["pos"] = max(0, min(n - 1, to))
        _edit_save(pid, e)
        return _edit_view(pid, e)


def edit_rate(pid, flag=None, stars=None):
    with _EDIT_LOCK:
        e = _edit_load(pid)
        if flag is not None:
            e["flag"] = int(flag)
        if stars is not None:
            e["stars"] = max(0, min(5, int(stars)))
        _edit_save(pid, e)
        return _edit_view(pid, e)


def edit_paste(src, ids, groups=None):
    """Copy src's current edit to other photos (each gets a 'Pasted' history step). groups limits it to some of
    light / colour / detail / effects / look; the rest of each target's edit stays."""
    a = edit_get(src)["adj"]
    keys = None
    if groups:
        bad = [g for g in groups if g not in GROUPS]
        if bad:
            raise ValueError("unknown group {} (groups: {})".format(", ".join(bad), ", ".join(GROUPS)))
        keys = set(k for g in groups for k in GROUPS[g])
    out = []
    for pid in ids:
        if pid == src:
            continue
        if keys is None:                                # everything except the crop, rotation and masks
            new = {k: v for k, v in edit_get(pid)["adj"].items() if k in NOT_PASTED}
            new.update({k: v for k, v in a.items() if k not in NOT_PASTED})
        else:
            new = {k: v for k, v in edit_get(pid)["adj"].items() if k not in keys}
            new.update({k: v for k, v in a.items() if k in keys})
        out.append(edit_set(pid, new, "Pasted from {}".format(_meta(src)["name"][:40])))
    return out


# ---- user looks: photos/looks.json. A saved look is a set of slider values, used like the built-in ones.
def _user_looks_path():
    return os.path.join(ROOT, "photos", "looks.json")


def user_looks():
    try:
        with open(_user_looks_path()) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def all_looks():
    d = dict(LOOKS)
    d.update(user_looks())
    return d


def look_save(name, adj):
    key = re.sub(r"[^a-z0-9]+", "-", (name or "").strip().lower()).strip("-")[:32]
    if not key or key == "none":
        raise ValueError("give the look a name")
    if key in LOOKS:
        raise ValueError("“{}” is a built-in look; choose a different name".format(key))
    p = _params(adj or {})                              # the look's values times its amount, plus the sliders
    vals = {k: round(v, 3) for k, v in p.items() if v and k != "auto"} if p else {}
    if p.get("auto"):
        vals["auto"] = round(p["auto"], 3)
    if not vals:
        raise ValueError("the settings are all zero; move a slider or choose a look first")
    d = user_looks()
    d[key] = vals
    with open(_user_looks_path(), "w") as f:
        json.dump(d, f, indent=1)
    return {"look": key, "values": vals}


def look_delete(name):
    d = user_looks()
    if name not in d:
        raise ValueError("there is no saved look called “{}”".format(name))
    d.pop(name)
    with open(_user_looks_path(), "w") as f:
        json.dump(d, f, indent=1)
    return {"deleted": name}


# ---- Auto: suggests ordinary slider values from measurements of this photo, and scores the result against
# the original and against a plain levels stretch (the simple baseline), on the same targets.
AUTO_TARGETS = {"p1": 0.02, "p99": 0.97, "median_lo": 0.30, "median_hi": 0.65, "cast": 0.0}


def _measure(u8):
    """Light and colour measurements of a uint8 image on the card (a 1024 px preview). The white point is the
    brightest 1% of each pixel's strongest channel, so a blue sky counts as bright before it clips. The colour cast
    is measured only on near-grey mid-tone pixels (a white-patch idea): a red wall is not a cast."""
    x = u8.astype(cp.float32) / 255.0
    flat = x.reshape(-1, 3)
    L = _lum(flat)
    V = flat.max(axis=1)
    s = V - flat.min(axis=1)
    q = cp.asnumpy(cp.percentile(L, cp.asarray([1, 5, 50, 95], cp.float32)))
    v99 = float(cp.percentile(V, 99))
    grey = (L > 0.15) & (L < 0.9) & (s < 0.12)
    ng = int(grey.sum())
    if ng > 0.01 * L.size:
        mean = cp.asnumpy(flat[grey].mean(axis=0))
        crb, cg = float(mean[0] - mean[2]), float(mean[1] - (mean[0] + mean[2]) / 2)
    else:
        mean, crb, cg = None, 0.0, 0.0
    return {"p1": float(q[0]), "p5": float(q[1]), "median": float(q[2]), "p95": float(q[3]), "p99": v99,
            "spread": float(q[3] - q[1]), "grey_share": round(ng / float(L.size), 4),
            "r": float(mean[0]) if mean is not None else None, "g": float(mean[1]) if mean is not None else None,
            "b": float(mean[2]) if mean is not None else None, "cast_rb": crb, "cast_g": cg,
            "chroma": float(s.mean()), "clip_hi": float((V >= 0.996).mean() * 100), "clip_lo": float((V <= 0.008).mean() * 100)}


def _auto_error(m):
    """Distance to the Auto targets, term by term (lower = closer): black and white points, brightness kept inside
    a normal range (a bright beach may stay bright), colour cast in the mid-tones, clipped pixels."""
    t = {"range": abs(m["p1"] - AUTO_TARGETS["p1"]) + abs(m["p99"] - AUTO_TARGETS["p99"]),
         "brightness": max(0.0, AUTO_TARGETS["median_lo"] - m["median"]) + max(0.0, m["median"] - AUTO_TARGETS["median_hi"]),
         "cast": (abs(m["cast_rb"]) + abs(m["cast_g"])) * 2,
         "clipping": 0.02 * (max(0.0, m["clip_hi"] - 0.5) + max(0.0, m["clip_lo"] - 0.5))}
    t = {k: round(v, 4) for k, v in t.items()}
    t["total"] = round(sum(t.values()), 4)
    return t


def _whites_for(p99, want=0.97):
    return max(-0.6, min(0.8, (want - p99) / (0.3 * max(p99, 0.3) ** 3)))


def _blacks_for(p1, want=0.02):
    return max(-1.0, min(0.5, (want - p1) / (0.25 * max(1 - p1, 0.5) ** 4)))


def photo_auto(pid, adj=None):
    """Measure the photo, choose exposure / whites / blacks / highlights / shadows / contrast / temperature / tint /
    vibrance, measure the result and correct the black and white points twice. Returns the slider values, the reason
    for each, and the scores of the original, the Auto result and a plain levels stretch (the simple baseline)."""
    from . import photo_fx
    arr, ctx = _frame_preview(pid, {k: v for k, v in (adj or {}).items() if k in GEO_KEYS}, 1024)   # measure what is in the crop

    def job():
        x = cp.asarray(arr)
        b = _measure(x)
        a, why = {}, {}
        # exposure: half way to a mid-grey median, but never so far that the brightest 1% clips or drops below 0.88
        if b["median"] > 0.01 and b["p99"] > 0.01:
            e_med = math.log(0.45 / b["median"], 2) / 2 * 0.5
            e = max(math.log(0.88 / b["p99"], 2) / 2, min(max(0.0, math.log(1.0 / b["p99"], 2) / 2), e_med))
            if abs(e) >= 0.03:
                a["exposure"] = round(e, 2)
                why["exposure"] = "median brightness {:.2f}, brightest 1% {:.2f}: half way to mid-grey without clipping".format(b["median"], b["p99"])
        g2 = 2.0 ** (a.get("exposure", 0) * 2)
        p99, p1 = b["p99"] * g2, b["p1"] * g2
        if b["clip_hi"] > 0.5 or p99 > 0.995:
            a["highlights"] = round(max(0.1, min(0.7, b["clip_hi"] * 0.08 + (p99 - 0.95) * 2)), 2)
            why["highlights"] = "{:.1f}% of pixels are clipped white: pull the highlights down".format(b["clip_hi"])
        else:
            a["whites"] = round(_whites_for(p99), 2)
            why["whites"] = "brightest 1% at {:.2f}: move the white point to {:.2f}".format(p99, AUTO_TARGETS["p99"])
        if p1 < 0.008 and b["median"] < 0.35:
            a["shadows"] = round(max(0.1, min(0.5, 0.2 + (0.35 - b["median"]))), 2)
            why["shadows"] = "a dark photo with crushed blacks (darkest 1% at {:.3f}): lift the shadows".format(p1)
        else:
            a["blacks"] = round(_blacks_for(p1), 2)
            why["blacks"] = "darkest 1% at {:.3f}: move the black point to {:.2f}".format(p1, AUTO_TARGETS["p1"])
        # white balance: a grey-world estimate on the mid-tones, corrected half way (a sunset should stay warm)
        r, g, bl = b["r"], b["g"], b["b"]
        if r is None:
            why["_wb"] = "too few near-grey pixels ({:.1%}) to judge the white balance: left alone".format(b["grey_share"])
        elif r + bl > 0.02:
            w = max(-0.5, min(0.5, (bl - r) / (0.12 * (r + bl)) * 0.5))
            if abs(w) >= 0.05:
                a["warmth"] = round(w, 2)
                why["warmth"] = "near-grey pixels ({:.0%} of the photo) are red {:.3f}, blue {:.3f}: half corrected".format(b["grey_share"], r, bl)
        if r is not None and g > 0.02:
            t = max(-0.4, min(0.4, (g - (r + bl) / 2) / (0.1 * g) * 0.5))
            if abs(t) >= 0.05:
                a["tint"] = round(t, 2)
                why["tint"] = "near-grey pixels are green {:.3f}, magenta {:.3f}: half corrected".format(g, (r + bl) / 2)
        if b["chroma"] < 0.12:
            a["vibrance"] = 0.25
            why["vibrance"] = "muted colours (mean chroma {:.2f})".format(b["chroma"])
        # measure, then correct the end points twice with the real result (the sliders are not linear)
        for _ in range(2):
            mm = _measure(photo_fx.develop(x, _params(a), ctx, _blur_big))
            if "whites" in a:
                a["whites"] = round(max(-0.6, min(0.8, a["whites"] + 0.6 * _whites_for(mm["p99"]))), 2)
            if "blacks" in a:
                a["blacks"] = round(max(-1.0, min(0.5, a["blacks"] + 0.6 * _blacks_for(mm["p1"]))), 2)
        a = {k: v for k, v in a.items() if abs(v) >= 0.02}
        after = _measure(photo_fx.develop(x, _params(a), ctx, _blur_big))
        levels = _measure(photo_fx.develop(x, {"auto": 1.0}, dict(ctx, auto=_auto_levels_job(x)), _blur_big))
        return a, why, b, after, levels
    a, why, before, after, levels = run_on_gpu(job, "photo auto", 60)
    rnd = lambda d: {k: round(v, 4) for k, v in d.items()}  # noqa: E731
    eb, ea, el = _auto_error(before), _auto_error(after), _auto_error(levels)
    verdict = ("closer to the targets than the original and than a plain levels stretch" if ea["total"] < min(eb["total"], el["total"]) else
               "closer than the original, but a plain levels stretch is closer still" if ea["total"] < eb["total"] else
               "no closer than the original: the photo was already near the targets")
    return {"photo": pid, "adj": a, "why": [{"slider": k, "value": a[k], "because": why[k]} for k in a if k in why] +
                   ([{"slider": None, "value": None, "because": why["_wb"]}] if "_wb" in why else []),
            "targets": AUTO_TARGETS, "measured": {"original": rnd(before), "auto": rnd(after), "levels_stretch": rnd(levels)},
            "error": {"original": eb, "auto": ea, "levels_stretch": el}, "better": ea["total"] < eb["total"],
            "headline": "{} slider{}".format(len(a), "" if len(a) == 1 else "s"),
            "sentence": "Auto sets {}; distance to the targets {:.3f} → {:.3f} (levels stretch {:.3f}): {}.".format(
                ", ".join("{} {:+.2f}".format(k, v) for k, v in a.items()) or "nothing", eb["total"], ea["total"], el["total"], verdict)}


def _auto_levels_job(x):
    """The levels-stretch baseline's per-channel 0.5 / 99.5 percentiles, inside a GPU job."""
    lo, hi = [], []
    for c in range(3):
        h = cp.bincount(x[..., c].ravel(), minlength=256).astype(cp.float64)
        cdf = cp.asnumpy(cp.cumsum(h) / float(h.sum()))
        lo.append(float(np.searchsorted(cdf, 0.005)) / 255.0)
        hi.append(float(np.searchsorted(cdf, 0.995)) / 255.0)
    return np.array(lo, np.float32), np.array(hi, np.float32)


def photo_similar(ids):
    """Perceptual difference-hashes on the card, then every pair compared at once (Hamming distance)."""
    smalls = []
    for pid in ids:
        im = Image.open(photo_path(pid, "thumb.jpg")).convert("L").resize((17, 16))
        smalls.append(np.asarray(im, np.float32))

    def job():
        a = cp.asarray(np.stack(smalls))
        bits = (a[:, :, 1:] > a[:, :, :-1]).reshape(len(ids), -1).astype(cp.float32)
        dist = bits.shape[1] - (bits @ bits.T + (1 - bits) @ (1 - bits).T)
        return cp.asnumpy(dist).astype(int)
    d = run_on_gpu(job, "photo hashes", 60)
    pairs = []
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            if d[i, j] <= 40:
                pairs.append({"a": ids[i], "b": ids[j], "distance": int(d[i, j]),
                              "verdict": "duplicate" if d[i, j] <= 12 else "very similar" if d[i, j] <= 26 else "similar"})
    return sorted(pairs, key=lambda x: x["distance"])


# ================================================================ SOUND LAB
SR = 44100
MAX_S = 300


def sound_add(name, data):
    sid = uuid.uuid4().hex[:10]
    d = os.path.join(ROOT, "sounds", sid)
    os.makedirs(d)
    src = os.path.join(d, "in")
    with open(src, "wb") as f:
        f.write(data)
    total = None
    try:                                                 # how long the file really is (only the first MAX_S s are kept)
        q = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        total = float(q.stdout.decode().strip() or "nan")
    except Exception:  # noqa: BLE001
        total = None
    p = subprocess.run(["ffmpeg", "-v", "error", "-i", src, "-t", str(MAX_S), "-ac", "2", "-ar", str(SR), "-f", "f32le", "-"],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    os.remove(src)
    if p.returncode != 0 or not p.stdout:
        raise ValueError("could not read that audio: " + p.stderr.decode("utf-8", "replace")[-200:])
    x = np.frombuffer(p.stdout, np.float32).reshape(-1, 2).T.copy()
    np.save(os.path.join(d, "audio.npy"), x)
    meta = {"id": sid, "name": name, "seconds": round(x.shape[1] / SR, 2), "added": time.time()}
    if total and total == total and total > MAX_S + 0.5:
        meta.update({"original_seconds": round(total, 1), "truncated": True})
    with open(os.path.join(d, "meta.json"), "w") as f:
        json.dump(meta, f)
    return meta


def sound_list():
    out = []
    base = os.path.join(ROOT, "sounds")
    for sid in os.listdir(base):
        mp = os.path.join(base, sid, "meta.json")
        if os.path.exists(mp):
            with open(mp) as f:
                m = json.load(f)
            out.append(m)
    return sorted(out, key=lambda m: -m["added"])


def _stft(x, n=2048, hop=512):
    w = cp.hanning(n).astype(cp.float32)
    pad = cp.concatenate([cp.zeros(n, cp.float32), x, cp.zeros(n, cp.float32)])
    nf = (pad.size - n) // hop + 1
    idx = cp.arange(n, dtype=cp.int32)[None, :] + hop * cp.arange(nf, dtype=cp.int32)[:, None]
    return cp.fft.rfft(pad[idx] * w, axis=1), w


def _istft(S, w, length, n=2048, hop=512):
    frames = cp.fft.irfft(S, n=n, axis=1).astype(cp.float32) * w
    nf = frames.shape[0]
    out = cp.zeros(n + hop * (nf - 1), cp.float32)
    norm = cp.zeros_like(out)
    for k in range(0, n, hop):                       # overlap-add in n/hop vectorised passes
        sl = frames[:, k:k + hop]
        out[k:k + hop * nf].reshape(nf, hop)[:] += sl
        norm[k:k + hop * nf].reshape(nf, hop)[:] += (w[k:k + hop] ** 2)[None, :]
    out = out / cp.maximum(norm, 1e-6)
    return out[n:n + length]


def _vocoder(x, rate, n=2048, hop=512):
    """Time-stretch by `rate` (>1 = faster) keeping pitch (phase vocoder)."""
    S, w = _stft(x, n, hop)
    nf = S.shape[0]
    steps = cp.arange(0, nf - 1, rate, dtype=cp.float32)
    i0 = steps.astype(cp.int32)
    frac = (steps - i0)[:, None]
    mag = (1 - frac) * cp.abs(S[i0]) + frac * cp.abs(S[i0 + 1])
    omega = 2 * math.pi * hop * cp.arange(S.shape[1], dtype=cp.float32) / n
    dphi = cp.angle(S[i0 + 1]) - cp.angle(S[i0]) - omega
    dphi = dphi - 2 * math.pi * cp.round(dphi / (2 * math.pi))
    phase = cp.cumsum(omega + dphi, axis=0) + cp.angle(S[0])[None, :]
    Y = mag * cp.exp(1j * phase)
    return _istft(Y.astype(cp.complex64), w, int(x.size / rate), n, hop)


def _resample(x, ratio):
    n = int(x.size / ratio)
    pos = cp.arange(n, dtype=cp.float32) * ratio
    i = cp.minimum(pos.astype(cp.int32), x.size - 2)
    f = pos - i
    return x[i] * (1 - f) + x[i + 1] * f


def _fftconv(sig, ir):
    """Overlap-add convolution with a fixed power-of-two FFT, so memory is a few MB whatever the clip length and
    cuFFT reuses one plan (full-length FFTs at odd sizes need a fresh plan + workspace per length and run the card
    out of memory on long clips)."""
    L = ir.size
    nfft = 1 << int(math.ceil(math.log2(L + 65536)))
    blk = nfft - L + 1
    H = cp.fft.rfft(ir, nfft)
    out = cp.zeros(sig.size + L - 1, cp.float32)
    for i in range(0, sig.size, blk):
        seg = sig[i:i + blk]
        y = cp.fft.irfft(cp.fft.rfft(seg, nfft) * H, nfft)[:seg.size + L - 1].astype(cp.float32)
        out[i:i + y.size] += y
    return out[:sig.size]


def _filter(x, H_of_f):
    """Zero-phase frequency-domain filter, one channel at a time to halve the peak memory."""
    f = cp.fft.rfftfreq(x.shape[1], 1 / SR).astype(cp.float32)
    H = H_of_f(f)
    return cp.stack([cp.fft.irfft(cp.fft.rfft(ch) * H, n=x.shape[1]).astype(cp.float32) for ch in x])


FX = {
    "gain": {"name": "Volume", "params": [{"k": "db", "label": "dB", "default": 3, "min": -24, "max": 24}]},
    "normalize": {"name": "Normalize", "params": []},
    "eq": {"name": "Equalizer", "params": [{"k": "bass", "label": "Bass dB", "default": 4, "min": -15, "max": 15},
                                           {"k": "mid", "label": "Mid dB", "default": 0, "min": -15, "max": 15},
                                           {"k": "treble", "label": "Treble dB", "default": 2, "min": -15, "max": 15}]},
    "denoise": {"name": "Remove hiss & hum", "params": [{"k": "amount", "label": "Strength", "default": 0.6, "min": 0, "max": 1}]},
    "lowpass": {"name": "Low-pass", "params": [{"k": "hz", "label": "Cutoff Hz", "default": 3000, "min": 200, "max": 18000}]},
    "highpass": {"name": "High-pass", "params": [{"k": "hz", "label": "Cutoff Hz", "default": 120, "min": 20, "max": 4000}]},
    "telephone": {"name": "Telephone", "params": []},
    "reverb": {"name": "Reverb", "params": [{"k": "size", "label": "Room size s", "default": 1.6, "min": 0.2, "max": 6},
                                            {"k": "mix", "label": "Wet", "default": 0.3, "min": 0, "max": 1}]},
    "echo": {"name": "Echo", "params": [{"k": "ms", "label": "Delay ms", "default": 320, "min": 30, "max": 2000},
                                        {"k": "feedback", "label": "Feedback", "default": 0.45, "min": 0, "max": 0.9}]},
    "pitch": {"name": "Pitch shift", "params": [{"k": "semitones", "label": "Semitones", "default": 3, "min": -12, "max": 12}]},
    "tempo": {"name": "Tempo (keep pitch)", "params": [{"k": "rate", "label": "Speed ×", "default": 1.15, "min": 0.5, "max": 2}]},
    "speed": {"name": "Tape speed", "params": [{"k": "rate", "label": "Speed ×", "default": 1.25, "min": 0.5, "max": 2}]},
    "vocals": {"name": "Remove vocals (karaoke)", "params": []},
    "reverse": {"name": "Reverse", "params": []},
    "fade": {"name": "Fade in/out", "params": [{"k": "in", "label": "In s", "default": 1, "min": 0, "max": 20},
                                               {"k": "out", "label": "Out s", "default": 2, "min": 0, "max": 20}]},
    "crush": {"name": "Bit-crusher", "params": [{"k": "bits", "label": "Bits", "default": 6, "min": 2, "max": 12}]},
    "loudness": {"name": "Loudness (LUFS)", "params": [{"k": "target", "label": "Target LUFS", "default": -16, "min": -36, "max": -6},
                                                       {"k": "ceiling", "label": "Peak limit dBTP", "default": -1, "min": -6, "max": 0}]},
    "band": {"name": "Band gain (spectral)", "params": [{"k": "lo", "label": "From Hz", "default": 2000, "min": 20, "max": 20000},
                                                       {"k": "hi", "label": "To Hz", "default": 6000, "min": 20, "max": 20000},
                                                       {"k": "db", "label": "Gain dB", "default": -24, "min": -60, "max": 12},
                                                       {"k": "outside", "label": "Outside the band (0 or 1)", "default": 0, "min": 0, "max": 1}]},
}
# effects whose result depends on the level of the whole range they get (a preview of a short window measures only it)
LEVEL_FX = ("normalize", "loudness", "reverb", "vocals")


CHUNKED = ("denoise", "tempo", "pitch", "eq", "lowpass", "highpass", "telephone", "band")


def _chunked(x, fn, seg=None, ov=None):
    """Run a spectral effect over a long clip in overlapping segments and crossfade the seams, so peak memory is
    set by the segment (~20 s), not the clip. Works for length-changing effects (tempo) by scaling the seams."""
    seg = seg or 20 * SR
    ov = ov or SR // 4
    N = x.shape[1]
    if N <= seg + 2 * ov:
        return fn(x)
    pieces, tail = [], None
    for s0 in range(0, N, seg):
        a, b = max(0, s0 - ov), min(N, s0 + seg + ov)
        y = fn(x[:, a:b])
        r = y.shape[1] / float(b - a)
        lo, hi = int(round((s0 - a) * r)), int(round((min(N, s0 + seg) - a) * r))
        core = y[:, lo:hi].copy()
        if tail is not None:
            n = min(tail.shape[1], core.shape[1])
            if n:
                w = cp.linspace(0, 1, n, dtype=cp.float32)[None, :]
                core[:, :n] = tail[:, :n] * (1 - w) + core[:, :n] * w
        tail = y[:, hi:hi + int(ov * r)].copy()
        pieces.append(cp.asnumpy(core))                 # park finished pieces in host RAM
        del y, core
    return cp.asarray(np.concatenate(pieces, 1))


def _fx(x, fx, p, _inner=False):
    """x: 2 x N float32 on the GPU."""
    if fx in CHUNKED and not _inner:
        return _chunked(x, lambda part: _fx(part, fx, p, True))
    g = lambda k: float(p.get(k, [q["default"] for q in FX[fx]["params"] if q["k"] == k][0]))  # noqa: E731
    if fx == "gain":
        return x * (10 ** (g("db") / 20))
    if fx == "normalize":
        return x * (0.89 / max(1e-6, float(cp.abs(x).max())))
    if fx in ("eq", "lowpass", "highpass", "telephone"):
        def H(f):
            if fx == "eq":
                lf = cp.log2(cp.maximum(f, 1))
                gain = (g("bass") / (1 + cp.exp((lf - math.log2(180)) * 3)) +
                        g("treble") / (1 + cp.exp(-(lf - math.log2(4500)) * 3)) +
                        g("mid") * cp.exp(-((lf - math.log2(1200)) ** 2) / 1.5))
                return 10 ** (gain / 20)
            if fx == "lowpass":
                return 1 / cp.sqrt(1 + (f / g("hz")) ** 8)
            if fx == "highpass":
                return 1 / cp.sqrt(1 + (g("hz") / cp.maximum(f, 1)) ** 8)
            return (1 / cp.sqrt(1 + (f / 3400) ** 8)) * (1 / cp.sqrt(1 + (300 / cp.maximum(f, 1)) ** 8))
        return _filter(x, H)
    if fx == "denoise":
        out = []
        for ch in x:
            S, w = _stft(ch)
            mag = cp.abs(S)
            noise = cp.percentile(mag, 12, axis=0)[None, :]
            k = 1 + 3 * g("amount")
            mask = cp.clip((mag - k * noise) / cp.maximum(mag, 1e-9), 0, 1) ** 0.7
            mask = ndi.uniform_filter(mask, (3, 3))
            out.append(_istft((S * mask).astype(cp.complex64), w, ch.size))
        return cp.stack(out)
    if fx == "reverb":
        L = int(SR * g("size"))
        t = cp.arange(L, dtype=cp.float32) / SR
        env = cp.exp(-6.9 * t / g("size"))
        wet = cp.stack([_fftconv(x[c], (cp.random.normal(0, 1, L).astype(cp.float32) * env) / math.sqrt(L / 2))
                        for c in range(2)])
        wet = wet / max(1e-6, float(cp.abs(wet).max())) * max(1e-6, float(cp.abs(x).max()))
        return ((1 - g("mix")) * x + g("mix") * wet).astype(cp.float32)
    if fx == "echo":
        d = int(SR * g("ms") / 1000)
        y = x.copy()
        fb = g("feedback")
        for k in range(1, 8):
            if k * d >= x.shape[1] or fb ** k < 0.01:
                break
            y[:, k * d:] += (fb ** k) * x[:, :-k * d]
        return y
    if fx == "pitch":
        r = 2 ** (g("semitones") / 12)
        return cp.stack([_resample(_vocoder(ch, 1 / r), r)[:ch.size] for ch in x])
    if fx == "tempo":
        return cp.stack([_vocoder(ch, g("rate")) for ch in x])
    if fx == "speed":
        return cp.stack([_resample(ch, g("rate")) for ch in x])
    if fx == "vocals":
        if float(cp.abs(x[0] - x[1]).mean()) < 1e-4:     # already mono / centre-removed: nothing more to take out
            return x
        side = (x[0] - x[1]) * 0.5
        side = side / (float(cp.abs(side).max()) + 1e-9) * (float(cp.abs(x).max()) + 1e-9)
        return cp.stack([side, side])
    if fx == "reverse":
        return x[:, ::-1].copy()
    if fx == "fade":
        n = x.shape[1]
        env = cp.ones(n, cp.float32)
        a, b = int(g("in") * SR), int(g("out") * SR)
        if a:
            env[:a] = cp.linspace(0, 1, a, dtype=cp.float32)
        if b:
            env[n - b:] *= cp.linspace(1, 0, b, dtype=cp.float32)
        return x * env[None, :]
    if fx == "crush":
        q = 2 ** int(g("bits"))
        return cp.round(x * q) / q
    if fx == "loudness":
        from . import loudness
        m = loudness.measure(cp.asnumpy(x), SR)
        gdb, _ = loudness.gain_to(m, g("target"), g("ceiling"))
        return x if gdb is None else x * (10 ** (gdb / 20))
    if fx == "band":
        lo, hi = sorted((g("lo"), g("hi")))
        out = []
        for ch in x:
            S, w = _stft(ch)
            lf = cp.log2(cp.maximum(cp.arange(S.shape[1], dtype=cp.float32) * (SR / 2048.0), 1.0))
            edge = 1 / 6.0                                   # a sixth of an octave raised-cosine edge on each side
            u = cp.clip(cp.minimum((lf - math.log2(lo)) / edge + 0.5, (math.log2(hi) - lf) / edge + 0.5), 0, 1)
            inb = 0.5 - 0.5 * cp.cos(math.pi * u)
            if g("outside") >= 0.5:
                inb = 1 - inb
            gain = 1 + (10 ** (g("db") / 20) - 1) * inb
            out.append(_istft((S * gain[None, :]).astype(cp.complex64), w, ch.size))
        return cp.stack(out)
    raise ValueError("unknown effect " + fx)


def _on(chain):
    """The steps of a chain that are switched on (a step with "on": false is bypassed)."""
    out = []
    for st in chain or []:
        if st.get("on", True) is False:
            continue
        if st.get("id") not in FX:
            raise ValueError("unknown effect " + str(st.get("id")))
        out.append(st)
    return out


def chain_label(chain, a=None, b=None):
    label = " → ".join(FX[st["id"]]["name"] for st in _on(chain)) or "No effect"
    if a is not None:
        label += " ({:.2f}–{:.2f}s)".format(a, b)
    return label


def _spectro(x, width=900, height=220):
    m = x.mean(0)
    S, _ = _stft(m, 2048, max(256, m.size // width))
    mag = cp.log1p(cp.abs(S[:, :700]).T * 10)[::-1]
    mag = mag / max(1e-6, float(mag.max()))
    v = cp.clip(mag, 0, 1)
    rgb = cp.stack([cp.clip(v * 2.2 - 0.2, 0, 1), cp.clip(v ** 2 * 1.4 - 0.25, 0, 1), cp.clip(v ** 4 * 1.2, 0, 1)], -1)
    img = cp.asnumpy((rgb * 255).astype(cp.uint8))
    return _png(np.asarray(Image.fromarray(img).resize((width, height))))


def _peaks(x, n=1200):
    m = cp.abs(x).max(0)
    k = max(1, m.size // n)
    return [round(float(v), 3) for v in cp.asnumpy(m[:k * (m.size // k)].reshape(-1, k).max(1))]


def sound_render(sid, chain, current=False):
    """A chain of effects as a preview (render.wav): on the original upload, or on the current edited version."""
    x0 = np.load(_vpath(sid, _state(sid)["cur"]) if current else os.path.join(ROOT, "sounds", sid, "audio.npy"))

    def job():
        t0 = time.time()
        x = cp.asarray(x0)
        timings = []
        for st in _on(chain):
            t = time.time()
            x = _fx(x, st["id"], st.get("params") or {}).astype(cp.float32)
            sync()
            timings.append({"fx": FX[st["id"]]["name"], "ms": round((time.time() - t) * 1000, 1)})
        peak = float(cp.abs(x).max())
        if peak > 0.999:
            x = x * (0.999 / peak)
        pcm = cp.asnumpy((cp.clip(x, -1, 1) * 32767).astype(cp.int16).T.copy())
        res = (pcm, _peaks(x), _spectro(x), timings, time.time() - t0, float(x.shape[1]) / SR)
        _release()
        return res
    pcm, peaks, spec, timings, dt, secs = run_on_gpu(job, "sound", 300)
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    out = os.path.join(ROOT, "sounds", sid, "render.wav")      # chain previews / MCP; never the editor's out.wav
    with open(out, "wb") as f:
        f.write(b.getvalue())
    return {"peaks": peaks, "spectrogram": spec, "timings": timings, "ms": round(dt * 1000, 1), "seconds": round(secs, 2),
            "realtime_x": round(secs / max(dt, 1e-6), 1)}


def sound_original(sid):
    x0 = np.load(os.path.join(ROOT, "sounds", sid, "audio.npy"))
    return run_on_gpu(lambda: {"peaks": _peaks(cp.asarray(x0)), "spectrogram": _spectro(cp.asarray(x0))}, "sound view", 120)


def _apply_chain(x0, chain):
    def job():
        x = cp.asarray(x0)
        for st in _on(chain):
            x = _fx(x, st["id"], st.get("params") or {}).astype(cp.float32)
        peak = float(cp.abs(x).max())
        if peak > 0.999:
            x = x * (0.999 / peak)
        out = cp.asnumpy((cp.clip(x, -1, 1) * 32767).astype(cp.int16).T.copy())
        _release()
        return out
    return run_on_gpu(job, "batch fx", 300)


def sound_batch(ids, chain, job=None):
    """Apply one effects chain to many clips on the card and write every result into an output zip."""
    import zipfile
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        for i, sid in enumerate(ids):
            try:
                x0 = np.load(_vpath(sid, _state(sid)["cur"]))
                with open(os.path.join(ROOT, "sounds", sid, "meta.json")) as f:
                    name = json.load(f)["name"].rsplit(".", 1)[0]
                pcm = _apply_chain(x0, chain)
                wbuf = io.BytesIO()
                with wave.open(wbuf, "wb") as w:
                    w.setnchannels(2)
                    w.setsampwidth(2)
                    w.setframerate(SR)
                    w.writeframes(pcm.tobytes())
                z.writestr("{}-vectorfall.wav".format(name), wbuf.getvalue())
            except Exception:  # noqa: BLE001
                pass
            if job:
                job.step((i + 1) / max(1, len(ids)), "{} of {}".format(i + 1, len(ids)))
    path = os.path.join(ROOT, "sounds", "batch-{}.zip".format(uuid.uuid4().hex[:8]))
    with open(path, "wb") as f:
        f.write(buf.getvalue())
    return {"zip": os.path.basename(path), "count": len(ids)}


# ================================================================ DATA DESK
def _read_xlsx(data, limit=200000):
    """First worksheet that actually has data (chart sheets and blank tabs skipped). Dates become ISO strings,
    whole floats lose their .0, and rows stop at `limit` so a giant export can't exhaust memory."""
    import datetime
    import openpyxl
    if data[:8] == bytes.fromhex("d0cf11e0a1b11ae1"):     # OLE2 header = legacy .xls
        raise ValueError("that is an old .xls (Excel 97-2003) file. Save it again as .xlsx or CSV")
    wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)

    def cell(v):
        if v is None:
            return ""
        if isinstance(v, (datetime.datetime, datetime.date)):
            return v.isoformat()
        if isinstance(v, float) and v.is_integer():
            return str(int(v))
        return str(v)
    for ws in wb.worksheets:
        if not hasattr(ws, "iter_rows"):
            continue
        rows = []
        for row in ws.iter_rows(values_only=True):
            r = [cell(v) for v in row]
            while r and not r[-1].strip():
                r.pop()
            if any(c.strip() for c in r):
                rows.append(r)
            if len(rows) >= limit:
                break
        if len(rows) >= 2:
            return rows
    raise ValueError("no worksheet in that file has a header and at least one row")


def _isnum(c):
    try:
        float(c.replace(",", "").strip("$%"))
        return True
    except ValueError:
        return False


def _header_row(rows):
    """The first of the top 10 rows that looks like a header: wide enough, distinct labels, mostly not numbers."""
    width = max(len([c for c in r if str(c).strip()]) for r in rows[:50])
    for i, r in enumerate(rows[:10]):
        filled = [str(c).strip() for c in r if str(c).strip()]
        if len(filled) >= max(2, 0.6 * width) and len(set(filled)) == len(filled) and sum(_isnum(c) for c in filled) <= len(filled) * 0.2:
            return i
    return 0


def table_delete(tid):
    import shutil
    d = os.path.join(ROOT, "tables", os.path.basename(tid))
    if not os.path.isdir(d):
        raise ValueError("no such table")
    shutil.rmtree(d)
    return {"deleted": tid}


def table_add(name, data):
    tid = uuid.uuid4().hex[:10]
    d = os.path.join(ROOT, "tables", tid)
    os.makedirs(d)
    if name.lower().endswith((".xlsx", ".xlsm", ".xls")) or data[:4] == b"PK":
        try:
            rows = _read_xlsx(data)
        except Exception as e:  # noqa: BLE001
            raise ValueError("could not read that spreadsheet: {}".format(e))
    else:
        text = data.decode("utf-8-sig", "replace").replace("\x00", "")
        try:
            dialect = csv.Sniffer().sniff(text[:20000], delimiters=",;\t|")
        except csv.Error:
            dialect = csv.excel
        try:
            rows = list(csv.reader(io.StringIO(text), dialect))
        except csv.Error:
            rows = [ln.split(dialect.delimiter if hasattr(dialect, "delimiter") else ",") for ln in text.splitlines()]
    rows = [r for r in rows if r]
    if len(rows) < 2:
        raise ValueError("that file has no rows")
    h = _header_row(rows)                               # exports often carry a title or blank line above the header
    rows = rows[h:]
    if len(rows) < 2:
        raise ValueError("that file has no rows under its header")
    width = max(len(r) for r in rows)
    header = [(h.strip() if i < len(rows[0]) else "") or "col{}".format(i + 1) for i, h in enumerate(rows[0] + [""] * (width - len(rows[0])))]
    seen = {}
    for i, h in enumerate(header):                      # duplicate headers would collide downstream
        if h in seen:
            seen[h] += 1
            header[i] = "{} ({})".format(h, seen[h])
        else:
            seen[h] = 1
    body = [(r + [""] * (width - len(r)))[:width] for r in rows[1:] if any(c.strip() for c in r)]
    cols = list(zip(*body)) if body else [[] for _ in header]
    num, numnames, cat, catnames, notes = [], [], [], [], []
    for h, c in zip(header, cols):
        vals, bad, note = _clean_column(h, c)
        if vals is not None and bad <= len(c) * 0.1 and any(v == v for v in vals):      # all-blank columns aren't numeric
            num.append(vals)
            numnames.append(h)
            if note:
                notes.append("{}: {}".format(h, note))
        else:
            cat.append([v.strip() for v in c])
            catnames.append(h)
            if note and vals is None:
                notes.append("{}: {}".format(h, note))
    np.save(os.path.join(d, "num.npy"), np.array(num, np.float32).T if num else np.zeros((len(body), 0), np.float32))
    with open(os.path.join(d, "cat.json"), "w") as f:
        json.dump({"names": catnames, "values": cat}, f)
    meta = {"id": tid, "name": name, "rows": len(body), "numeric": numnames, "categorical": catnames, "added": time.time(),
            "columns": header, "notes": notes}
    with open(os.path.join(d, "meta.json"), "w") as f:
        json.dump(meta, f)
    return meta


_NA = ("", "na", "n/a", "null", "nan", "none", "-", "—")
_ID_NAME = re.compile(r"(^|[^a-z])(id|zip|zipcode|postcode|postal|code|phone|tel|sku|ean|upc|account|acct)([^a-z]|$)", re.I)
_EURO = re.compile(r"^-?\d{1,3}(\.\d{3})+,\d+$|^-?\d+,\d{1,2}$")       # 1.234,56 or 12,5
_US = re.compile(r"^-?\d{1,3}(,\d{3})+(\.\d+)?$")                        # 1,234 or 1,234.56


def _clean_column(name, cells):
    """One column of an import -> (floats or None for a text column, cells that failed, a note for the user).
    Money ($1,234.50, (120.50), -$5, 12 %), the column's own decimal mark and ID-like columns are handled."""
    raw = [str(v).strip() for v in cells]
    vals_txt = [v for v in raw if v.lower() not in _NA]
    if not vals_txt:
        return [np.nan] * len(raw), 0, ""
    zeros = sum(1 for v in vals_txt if len(v) > 1 and v[0] == "0" and v[1].isdigit())
    bare = all(v.isdigit() for v in vals_txt[:400])                # only whole digit strings can be IDs ("Account balance" is money)
    if (_ID_NAME.search(name) and bare) or (zeros > 0.3 * len(vals_txt) and bare):     # 02134, 007, account numbers: names, not amounts
        return None, len(raw), "kept as text (looks like an ID or code)" if any(c.isdigit() for c in "".join(vals_txt[:20])) else ""
    money = any(ch in v for v in vals_txt[:200] for ch in "$€£¥")

    def strip(v):
        neg = v.startswith("(") and v.endswith(")")
        v = v.strip("()").replace("\u00a0", "").replace(" ", "")
        for ch in "$€£¥%":
            v = v.replace(ch, "")
        if v.startswith("-") or v.endswith("-"):
            neg, v = (not neg), v.strip("-")
        return neg, v
    sample = [strip(v)[1] for v in vals_txt[:400]]
    euro = sum(1 for v in sample if _EURO.match(v)) > max(0, sum(1 for v in sample if _US.match(v)))
    vals, bad = [], 0
    for v in raw:
        if v.lower() in _NA:
            vals.append(np.nan)
            continue
        neg, s = strip(v)
        s = s.replace(".", "").replace(",", ".") if euro else s.replace(",", "")
        try:
            x = float(s)
            vals.append(-x if neg else x)
        except ValueError:
            bad += 1
            vals.append(np.nan)
    note = ", ".join(n for n in ["read as money" if money else "", "decimal comma (1.234,56)" if euro else ""] if n)
    return vals, bad, note


def table_list():
    out = []
    base = os.path.join(ROOT, "tables")
    for tid in os.listdir(base):
        mp = os.path.join(base, tid, "meta.json")
        if os.path.exists(mp):
            with open(mp) as f:
                m = json.load(f)
            out.append(m)
    return sorted(out, key=lambda m: -m["added"])


def _load_table(tid):
    d = os.path.join(ROOT, "tables", tid)
    with open(os.path.join(d, "meta.json")) as f:
        meta = json.load(f)
    with open(os.path.join(d, "cat.json")) as f:
        cat = json.load(f)
    return meta, np.load(os.path.join(d, "num.npy")), cat


def table_summary(tid):
    meta, X, cat = _load_table(tid)

    def job():
        t0 = time.time()
        G = cp.asarray(X)
        out = []
        for j, name in enumerate(meta["numeric"]):
            c = G[:, j]
            ok = c[~cp.isnan(c)]
            if ok.size == 0:
                out.append({"name": name, "kind": "number", "missing": int(c.size)})
                continue
            q = cp.asnumpy(cp.percentile(ok, cp.asarray([0, 25, 50, 75, 100], cp.float64))).tolist()
            h, e = cp.histogram(ok, 30)
            out.append({"name": name, "kind": "number", "count": int(ok.size), "missing": int(c.size - ok.size),
                        "mean": float(ok.mean()), "std": float(ok.std()), "q": q,
                        "hist": cp.asnumpy(h).tolist(), "edges": cp.asnumpy(e).tolist()})
        corr = None
        if X.shape[1] >= 2:
            M = cp.where(cp.isnan(G), cp.nanmean(G, axis=0)[None, :], G)
            M = (M - M.mean(0)) / cp.maximum(M.std(0), 1e-9)
            corr = cp.asnumpy((M.T @ M) / max(1, M.shape[0])).round(3).tolist()
        sync()
        return out, corr, time.time() - t0
    cols, corr, dt = run_on_gpu(job, "table summary", 120)
    cats = []
    for name, vals in zip(cat["names"], cat["values"]):
        cnt = {}
        for v in vals:
            cnt[v] = cnt.get(v, 0) + 1
        top = sorted(cnt.items(), key=lambda x: -x[1])[:12]
        cats.append({"name": name, "kind": "text", "distinct": len(cnt), "top": top, "missing": cnt.get("", 0)})
    return {"meta": meta, "numeric": cols, "categorical": cats, "corr": corr, "ms": round(dt * 1000, 1)}


def table_pca(tid, k=4):
    meta, X, cat = _load_table(tid)
    names = list(meta["numeric"])
    if X.shape[1]:                                      # blank or constant columns make the SVD singular -> cuSOLVER fails
        with np.errstate(all="ignore"):
            keep = [j for j in range(X.shape[1]) if np.isfinite(X[:, j]).sum() >= 2 and np.nanstd(X[:, j]) > 0]
        X, names = X[:, keep], [names[j] for j in keep]
    if X.shape[1] < 2 or X.shape[0] < 3:
        raise ValueError("needs at least two numeric columns that actually vary")

    def job():
        t0 = time.time()
        G = cp.asarray(X)
        G = cp.where(cp.isnan(G), cp.nanmean(G, axis=0)[None, :], G)
        Z = (G - G.mean(0)) / cp.maximum(G.std(0), 1e-9)
        U, S, Vt = cp.linalg.svd(Z, full_matrices=False)
        P = Z @ Vt[:2].T
        var = (S ** 2) / (S ** 2).sum()
        cen = Z[cp.random.permutation(Z.shape[0])[:k]]
        for _ in range(30):
            dist = ((Z[:, None, :] - cen[None]) ** 2).sum(2)
            lab = dist.argmin(1)
            for j in range(k):
                m = lab == j
                if int(m.sum()):
                    cen[j] = Z[m].mean(0)
        n = Z.shape[0]
        pick = cp.random.permutation(n)[:6000] if n > 6000 else cp.arange(n)
        sync()
        return (cp.asnumpy(P[pick]).round(4).tolist(), cp.asnumpy(lab[pick]).tolist(), cp.asnumpy(var[:6]).round(4).tolist(),
                cp.asnumpy(Vt[:2]).round(3).tolist(), cp.asnumpy(cp.bincount(lab, minlength=k)).tolist(), time.time() - t0)
    try:
        pts, lab, var, load, sizes, dt = run_on_gpu(job, "table pca", 120)
    except Exception as e:  # noqa: BLE001
        if "CUSOLVER" in str(e) or "cuSOLVER" in str(e) or "CUSOLVER" in type(e).__name__:
            raise ValueError("those columns are too degenerate to project (constant or near-duplicate)")
        raise
    return {"points": pts, "labels": lab, "explained": var, "loadings": load, "names": names, "sizes": sizes,
            "ms": round(dt * 1000, 1)}


def table_rows(tid, sort=None, desc=True, where=None, offset=0, limit=100):
    meta, X, cat = _load_table(tid)
    n = X.shape[0]
    idx = np.arange(n)
    if where:
        col, op, val = where.get("col"), where.get("op", "="), where.get("val", "")
        if col in meta["numeric"]:
            c = X[:, meta["numeric"].index(col)]
            v = float(val)
            m = {"=": c == v, ">": c > v, "<": c < v, ">=": c >= v, "<=": c <= v, "!=": c != v}[op]
        else:
            c = np.array(cat["values"][cat["names"].index(col)])
            m = np.char.find(np.char.lower(c.astype(str)), str(val).lower()) >= 0 if op == "contains" else (c == val)
        idx = idx[m]
    if sort and sort in meta["numeric"]:
        c = X[idx, meta["numeric"].index(sort)]

        def job():
            g = cp.asarray(np.where(np.isnan(c), -np.inf if desc else np.inf, c))
            return cp.asnumpy(cp.argsort(-g if desc else g))
        idx = idx[run_on_gpu(job, "sort", 60)]
    elif sort and sort in cat["names"]:
        c = np.array(cat["values"][cat["names"].index(sort)])[idx]
        o = np.argsort(c, kind="mergesort")
        idx = idx[o[::-1] if desc else o]
    page = idx[offset:offset + limit]
    rows = []
    for i in page:
        r = {}
        for j, h in enumerate(meta["numeric"]):
            v = X[i, j]
            r[h] = None if np.isnan(v) else float(v)
        for h, vals in zip(cat["names"], cat["values"]):
            r[h] = vals[i]
        rows.append([r.get(h) for h in meta["columns"]])
    return {"columns": meta["columns"], "rows": rows, "total": int(idx.size)}


def table_group(tid, by, col, agg="mean"):
    meta, X, cat = _load_table(tid)
    keys = cat["values"][cat["names"].index(by)]
    uniq = sorted(set(keys))
    code = np.array([uniq.index(k) for k in keys]) if len(uniq) < 5000 else None
    if code is None:
        raise ValueError("too many groups")
    vals = X[:, meta["numeric"].index(col)] if col in meta["numeric"] else np.ones(len(keys), np.float32)

    def job():
        c = cp.asarray(code)
        v = cp.asarray(vals)
        ok = ~cp.isnan(v)
        s = cp.bincount(c[ok], weights=v[ok], minlength=len(uniq))
        k = cp.bincount(c[ok], minlength=len(uniq))
        res = s / cp.maximum(k, 1) if agg == "mean" else (s if agg == "sum" else k.astype(cp.float64))
        return cp.asnumpy(res), cp.asnumpy(k)
    res, cnt = run_on_gpu(job, "group by", 60)
    order = np.argsort(-res)[:40]
    return {"groups": [{"key": uniq[i], "value": float(res[i]), "n": int(cnt[i])} for i in order], "agg": agg, "by": by, "col": col}




# ---------------------------------------------------------------- in-place editing with undo (Audacity model)
MAX_UNDO = 40


def _sdir(sid):
    return os.path.join(ROOT, "sounds", os.path.basename(sid))


def _state(sid):
    p = os.path.join(_sdir(sid), "state.json")
    if os.path.exists(p):
        with open(p) as f:
            return json.load(f)
    return {"cur": 0, "top": 0, "history": []}


def _save_state(sid, st):
    with open(os.path.join(_sdir(sid), "state.json"), "w") as f:
        json.dump(st, f)


def _vpath(sid, v):
    return os.path.join(_sdir(sid), "audio.npy" if v == 0 else os.path.join("versions", "{}.npy".format(v)))


def _release():
    try:
        cp.fft.config.get_plan_cache().clear()
    except Exception:  # noqa: BLE001
        pass
    cp.get_default_memory_pool().free_all_blocks()


def _wave_peaks(x, n=2000):
    """Per-channel min/max envelope (what a waveform editor actually draws)."""
    N = x.shape[1]
    k = max(1, N // n)
    m = (N // k) * k
    seg = x[:, :m].reshape(2, -1, k)
    return {"min": cp.asnumpy(seg.min(2)).round(3).tolist(), "max": cp.asnumpy(seg.max(2)).round(3).tolist()}


def _view_np(x0):
    """The same waveform envelope and spectrogram as the card makes (_wave_peaks, _spectro), with numpy: used when
    the card is busy, so opening a clip never waits in the GPU queue (a 5-minute clip takes well under a second)."""
    x = np.asarray(x0, np.float32)
    N = x.shape[1]
    k = max(1, N // 2000)
    seg = x[:, :(N // k) * k].reshape(2, -1, k)
    wave = {"min": seg.min(2).round(3).tolist(), "max": seg.max(2).round(3).tolist()}
    m, n = x.mean(0), 2048
    hop = max(256, m.size // 900)
    w = np.hanning(n).astype(np.float32)
    pad = np.concatenate([np.zeros(n, np.float32), m, np.zeros(n, np.float32)])
    nf = (pad.size - n) // hop + 1
    S = np.empty((nf, n // 2 + 1), np.complex64)
    for a in range(0, nf, 256):                       # in blocks, so memory stays small for long clips
        b = min(nf, a + 256)
        idx = np.arange(n)[None, :] + hop * np.arange(a, b)[:, None]
        S[a:b] = np.fft.rfft(pad[idx] * w, axis=1)
    mag = np.log1p(np.abs(S[:, :700]).T * 10)[::-1]
    mag = mag / max(1e-6, float(mag.max()))
    v = np.clip(mag, 0, 1)
    rgb = np.stack([np.clip(v * 2.2 - 0.2, 0, 1), np.clip(v ** 2 * 1.4 - 0.25, 0, 1), np.clip(v ** 4 * 1.2, 0, 1)], -1)
    img = (rgb * 255).astype(np.uint8)
    spec = _png(np.asarray(Image.fromarray(img).resize((900, 220))))
    return {"wave": wave, "spectrogram": spec, "seconds": round(N / SR, 3)}


def _view_key(x0):
    """A cheap fingerprint of a version's samples (shape + every 1009th value): different audio, different key."""
    import hashlib
    x = np.asarray(x0)
    return "%s-%s" % (x.shape, hashlib.md5(np.ascontiguousarray(x.reshape(-1)[::1009]).tobytes()).hexdigest()[:16])


def _view(sid, x0, extra=None):
    cache = os.path.join(_sdir(sid), "view-cache.json")
    key = _view_key(x0)
    v = None
    try:
        with open(cache) as f:
            c = json.load(f)
        if c.get("key") == key:
            v = c["v"]
    except Exception:  # noqa: BLE001
        v = None
    if v is None:
        # measured on a 5-minute clip: numpy 0.34 s vs the card 0.78 s (the copy to the card dominates), with identical
        # pictures; so the viewer never takes a GPU slot and never waits behind other work
        v = _view_np(x0)
        try:
            tmp = cache + ".tmp"
            with open(tmp, "w") as f:
                json.dump({"key": key, "v": v}, f)
            os.replace(tmp, cache)
        except Exception:  # noqa: BLE001
            pass
    v = dict(v)
    st = _state(sid)
    v.update({"version": st["cur"], "can_undo": st["cur"] > 0, "can_redo": st["cur"] < st["top"],
              "history": st["history"][:st["top"]], "cur": st["cur"]})
    if extra:
        v.update(extra)
    return v


def _write_out(sid, x):
    pcm = (np.clip(x, -1, 1) * 32767).astype(np.int16).T.copy()
    with wave.open(os.path.join(_sdir(sid), "out.wav"), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def sound_current(sid):
    st = _state(sid)
    x = np.load(_vpath(sid, st["cur"]))
    if not os.path.exists(os.path.join(_sdir(sid), "out.wav")):
        _write_out(sid, x)
    return _view(sid, x)


def _new_version(sid, x, entry):
    """x becomes the next version on the undo stack (the redo branch is dropped; the oldest edit falls off past
    MAX_UNDO). Returns the new version number."""
    st = _state(sid)
    os.makedirs(os.path.join(_sdir(sid), "versions"), exist_ok=True)
    for v in range(st["cur"] + 1, st["top"] + 1):
        try:
            os.remove(_vpath(sid, v))
        except OSError:
            pass
    hist = st["history"][:st["cur"]] + [entry]
    cur = st["cur"] + 1
    np.save(_vpath(sid, cur), np.asarray(x, np.float32))
    if cur > MAX_UNDO:
        os.remove(_vpath(sid, 1))
        for v in range(2, cur + 1):
            os.rename(_vpath(sid, v), _vpath(sid, v - 1))
        cur -= 1
        hist = hist[1:]
    _save_state(sid, {"cur": cur, "top": cur, "history": hist})
    _write_out(sid, x)
    return cur


def _range(N, start, end):
    a = 0 if start is None else max(0, min(N, int(float(start) * SR)))
    b = N if end is None else max(0, min(N, int(float(end) * SR)))
    return (0, N) if b - a < SR // 50 else (a, b)       # a click, not a selection: whole clip


def _run_chain(seg, chain, job=None):
    """Inside a GPU job: the chain's switched-on steps on seg (2 x n numpy), peak kept under 0 dBFS. With a job, each
    step reports progress, and a Stop between steps ends the work before anything is written."""
    on = _on(chain)
    try:
        y = cp.asarray(seg)
        for i, st in enumerate(on):
            if job:
                job.step(i / float(len(on)), "{} ({} of {})".format(FX[st["id"]]["name"], i + 1, len(on)))
            y = _fx(y, st["id"], st.get("params") or {}).astype(cp.float32)
        sync()
        peak = float(cp.abs(y).max()) if y.size else 0.0
        if peak > 0.999:
            y = y * (0.999 / peak)
        return cp.asnumpy(y)
    finally:
        _release()


def sound_apply(sid, fx, params=None, start=None, end=None):
    if fx not in FX:
        raise ValueError("unknown effect " + str(fx))
    return sound_apply_chain(sid, [{"id": fx, "params": params or {}}], start, end)


def sound_apply_chain(sid, chain, start=None, end=None, job=None):
    """A whole effect chain, in order, as ONE undoable edit of the clip (or of the range [start, end])."""
    on = _on(chain)
    if not on:
        raise ValueError("the chain is empty or every step is bypassed")
    st = _state(sid)
    x0 = np.load(_vpath(sid, st["cur"]))
    N = x0.shape[1]
    a, b = _range(N, start, end)

    def work():
        t = time.time()
        return _run_chain(x0[:, a:b], on, job), time.time() - t
    y, dt = run_on_gpu(work, "sound fx", 300)
    x = np.concatenate([x0[:, :a], y, x0[:, b:]], 1).astype(np.float32) if (a, b) != (0, N) else y
    label = chain_label(on, *((None, None) if (a, b) == (0, N) else (a / SR, b / SR)))
    one = len(on) == 1
    entry = {"fx": on[0]["id"] if one else "chain", "label": label, "params": dict(on[0].get("params") or {}) if one else {},
             "ms": round(dt * 1000, 1)}
    if not one:
        entry["chain"] = [{"id": s_["id"], "params": dict(s_.get("params") or {})} for s_ in on]
    if (a, b) != (0, N):
        entry["range"] = [round(a / SR, 3), round(b / SR, 3)]
    _new_version(sid, x, entry)
    return _view(sid, x, {"ms": round(dt * 1000, 1), "realtime_x": round((b - a) / SR / max(dt, 1e-6), 1),
                          "applied": label})


PREVIEW_MAX_S = 30


def sound_preview(sid, chain, start=None, end=None):
    """The chain on a short stretch of the current version, as a WAV, for listening before an edit: exactly the
    numbers an Apply would write (except for level effects, which measure only this stretch). The clip is unchanged."""
    st = _state(sid)
    x0 = np.load(_vpath(sid, st["cur"]), mmap_mode="r")
    N = x0.shape[1]
    a = 0 if start is None else max(0, min(N, int(float(start) * SR)))
    b = min(N, a + 10 * SR) if end is None else max(0, min(N, int(float(end) * SR)))
    if b - a < SR // 50:
        raise ValueError("choose at least 20 ms to preview")
    b = min(b, a + PREVIEW_MAX_S * SR)
    seg = np.array(x0[:, a:b], np.float32)

    def job():
        t = time.time()
        return _run_chain(seg, chain), time.time() - t
    y, dt = run_on_gpu(job, "sound preview", 60)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(y, -1, 1) * 32767).astype(np.int16).T.copy().tobytes())
    level = [s_["id"] for s_ in _on(chain) if s_["id"] in LEVEL_FX]
    meta = {"start": round(a / SR, 3), "end": round(b / SR, 3), "seconds": round(y.shape[1] / SR, 3), "ms": round(dt * 1000, 1),
            "realtime_x": round((b - a) / SR / max(dt, 1e-6), 1), "label": chain_label(chain),
            "note": ("{}: measured on this stretch only; Apply measures the whole range".format(", ".join(FX[k]["name"] for k in level))
                     if level else "")}
    return buf.getvalue(), meta


def sound_loudness(sid, start=None, end=None, with_steps=False, which="cur"):
    """BS.1770 / EBU R128 readings of the current version (or the original), whole clip or a range."""
    from . import loudness
    st = _state(sid)
    x0 = np.load(_vpath(sid, 0 if which == "in" else st["cur"]), mmap_mode="r")
    N = x0.shape[1]
    a = 0 if start is None else max(0, min(N, int(float(start) * SR)))
    b = N if end is None else max(0, min(N, int(float(end) * SR)))
    if b - a < int(0.4 * SR):
        raise ValueError("loudness needs at least 0.4 s of audio")
    m = loudness.measure(np.array(x0[:, a:b], np.float32), SR, with_steps)
    m["start"], m["end"], m["version"] = round(a / SR, 3), round(b / SR, 3), 0 if which == "in" else st["cur"]
    m["targets"] = []
    for name, tgt, ceil in loudness.TARGETS:
        gdb, lim = loudness.gain_to(m, tgt, ceil)
        m["targets"].append({"name": name, "lufs": tgt, "ceiling_dbtp": ceil, "gain_db": gdb, "peak_limited": lim})
    return m


def _markers_path(sid):
    return os.path.join(_sdir(sid), "markers.json")


def sound_markers(sid):
    try:
        with open(_markers_path(sid)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return []


def sound_markers_set(sid, markers):
    """Points (t) and regions (t, end), each with a label: an Audacity label track."""
    if not os.path.isdir(_sdir(sid)):
        raise ValueError("no such clip")
    clean = []
    for m in markers or []:
        t = float(m.get("t", m.get("a", 0)))
        e = m.get("end", m.get("b"))
        e = None if e is None or float(e) - t < 0.001 else round(float(e), 4)
        clean.append({"t": round(max(0.0, t), 4), "end": e, "label": str(m.get("label") or "")[:80]})
    clean.sort(key=lambda m: m["t"])
    with open(_markers_path(sid), "w") as f:
        json.dump(clean, f)
    return clean


def markers_tsv(markers):
    """An Audacity label file: start, end, label, tab-separated, one per line (a point has end = start)."""
    return "".join("{:.6f}\t{:.6f}\t{}\n".format(m["t"], m["end"] if m.get("end") is not None else m["t"],
                                                  str(m.get("label") or "").replace("\t", " ").replace("\n", " ")) for m in markers)


def parse_tsv(text):
    out = []
    for line in str(text or "").splitlines():
        p = line.split("\t")
        if len(p) < 2 or p[0].strip().startswith("\\"):          # Audacity writes spectral bounds on "\" lines
            continue
        try:
            a, b = float(p[0]), float(p[1])
        except ValueError:
            continue
        out.append({"t": a, "end": b if b > a else None, "label": p[2].strip() if len(p) > 2 else ""})
    return out


def sound_write_in(sid):
    """in.wav: the original upload as 16-bit WAV (made on first request)."""
    d = _sdir(sid)
    x = np.load(os.path.join(d, "audio.npy"))
    with wave.open(os.path.join(d, "in.wav"), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).T.copy().tobytes())


def sound_commit(sid, x, label, ms=0.0):
    """A finished whole-clip edit made elsewhere (e.g. the sound finder muting its detections) -> a new version on the
    same undo stack as the effects."""
    x = np.asarray(x, np.float32)
    _new_version(sid, x, {"fx": "edit", "label": label, "params": {}, "ms": round(ms, 1)})
    return _view(sid, x, {"applied": label})


def sound_trim(sid, op, start, end):
    """Keep only [start, end] (op "keep") or remove it (op "cut"): a new, undoable version of a new length."""
    if op not in ("keep", "cut"):
        raise ValueError("op is keep or cut")
    st = _state(sid)
    x0 = np.load(_vpath(sid, st["cur"]))
    N = x0.shape[1]
    a = max(0, min(N, int(float(start) * SR)))
    b = max(0, min(N, int(float(end) * SR)))
    if b - a < SR // 50:
        raise ValueError("select at least 20 ms first")
    if op == "keep":
        x = x0[:, a:b].copy()
        label = "Keep {:.2f}–{:.2f}s".format(a / SR, b / SR)
    else:
        if N - (b - a) < SR // 50:
            raise ValueError("that would remove the whole clip")
        x = np.concatenate([x0[:, :a], x0[:, b:]], 1)
        label = "Cut {:.2f}–{:.2f}s".format(a / SR, b / SR)
    _new_version(sid, x, {"fx": op, "label": label, "params": {"start": round(a / SR, 3), "end": round(b / SR, 3)}, "ms": 0})
    return _view(sid, x, {"ms": 0, "realtime_x": 0, "applied": "{} · now {:.2f} s long".format(label, x.shape[1] / SR)})


def sound_step(sid, delta):
    st = _state(sid)
    cur = max(0, min(st["top"], st["cur"] + delta))
    st["cur"] = cur
    _save_state(sid, st)
    x = np.load(_vpath(sid, cur))
    _write_out(sid, x)
    return _view(sid, x)


def sound_delete(sid):
    import shutil
    shutil.rmtree(_sdir(sid), ignore_errors=True)
    return {"ok": True}
