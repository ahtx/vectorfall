"""Photo Lab develop pipeline as a few fused CUDA kernels (CuPy RawKernel, compiled once per card by NVRTC).

The old pipeline ran each slider as several CuPy array expressions; every expression is one pass over the image in
card memory, and the K420 has only 29 GB/s. Here each run of per-pixel steps is one kernel launch:

  warp   (uint8)     geometry: quarter turns, flip, straighten (rotation) and crop, bilinear, in one gather
  tone   (uint8 in)  auto levels, exposure, white balance, whites, blacks, shadows, highlights (+ local masks)
  clarity            a luminance detail layer: L minus a big blur of L (computed at 1/f scale, see media._blur_big)
  colour             clarity, contrast, split toning, vibrance, saturation (+ local masks)
  blur1d             separable Gaussian (noise reduction and sharpening), clamped at the edges
  finish (uint8 out) black and white, sepia, fade, vignette, grain, clip; optionally the mask overlay

Local adjustments (linear and radial gradients, brush) are not separate passes: tone and colour compute each mask's
weight for the pixel and add the mask's slider values, weighted, to the global ones. Masks live in the coordinates
of the straightened, uncropped photo (the "canvas", 0..1 on each axis), so a new crop does not move them.

Grain is a hash of the pixel's position in the whole render, so it does not flicker between renders and strips of a
tiled export join without seams. Every kernel takes the tile offset and the full render size, so a tile, a 1:1 crop
and a preview come out the same as the whole image would.
"""
import hashlib
import json
import math

import cupy as cp
import numpy as np

MAX_MASKS = 16
MSTRIDE = 16           # per mask: type, a, b, c, d, feather, invert, brush index, then 8 local slider deltas
LOCAL_KEYS = ("exposure", "contrast", "highlights", "shadows", "warmth", "tint", "saturation", "clarity")

_SRC = r"""
__device__ __forceinline__ float lum(float r, float g, float b) { return 0.2126f * r + 0.7152f * g + 0.0722f * b; }
__device__ __forceinline__ float clamp01(float v) { return fminf(1.f, fmaxf(0.f, v)); }
__device__ __forceinline__ float sstep(float a, float b, float x) {
  if (b <= a) return x < a ? 0.f : 1.f;
  float t = clamp01((x - a) / (b - a)); return t * t * (3.f - 2.f * t);
}

// geometry of the render: g[0] cx0, g[1] cy0 (canvas px of the crop's corner), g[2] canvas px per render px,
// g[3] Wq, g[4] Hq (canvas size), g[5] y0, g[6] x0 (this tile's offset in render px), g[7] tile width
__device__ __forceinline__ void canvas_xy(const float* g, int i, float* X, float* Y) {
  int w = (int)g[7];
  *X = g[0] + ((float)(i % w) + g[6] + .5f) * g[2];
  *Y = g[1] + ((float)(i / w) + g[5] + .5f) * g[2];
}

__device__ float maskw(const float* m, float X, float Y, float Wq, float Hq, const float* B, int BH, int BW) {
  float w = 0.f;
  int t = (int)m[0];
  if (t == 1) {                                   // linear: full effect before (a,b), none after (c,d)
    float ax = m[1] * Wq, ay = m[2] * Hq, vx = m[3] * Wq - ax, vy = m[4] * Hq - ay;
    float s = ((X - ax) * vx + (Y - ay) * vy) / fmaxf(vx * vx + vy * vy, 1.f);
    w = 1.f - sstep(0.f, 1.f, s);
  } else if (t == 2) {                            // radial: an ellipse (centre a,b; radii c,d), feathered inside
    float dx = (X - m[1] * Wq) / fmaxf(m[3] * Wq, 1.f), dy = (Y - m[2] * Hq) / fmaxf(m[4] * Hq, 1.f);
    float d = sqrtf(dx * dx + dy * dy);
    w = 1.f - sstep(1.f - fmaxf(m[5], 0.f), 1.f, d);
  } else if (t == 3) {                            // brush: a painted map over the canvas, sampled bilinear
    const float* b = B + (int)m[7] * BH * BW;
    float u = fminf(fmaxf(X / Wq * BW - .5f, 0.f), BW - 1.f), v = fminf(fmaxf(Y / Hq * BH - .5f, 0.f), BH - 1.f);
    int u0 = (int)u, v0 = (int)v, u1 = min(u0 + 1, BW - 1), v1 = min(v0 + 1, BH - 1);
    float fu = u - u0, fv = v - v0;
    w = (b[v0 * BW + u0] * (1 - fu) + b[v0 * BW + u1] * fu) * (1 - fv) + (b[v1 * BW + u0] * (1 - fu) + b[v1 * BW + u1] * fu) * fv;
  }
  return m[6] != 0.f ? 1.f - w : w;
}

// the weighted sum of the masks' slider deltas at this pixel: d[0..7] = LOCAL_KEYS
__device__ void locals(const float* M, int nm, float X, float Y, float Wq, float Hq, const float* B, int BH, int BW, float* d) {
  for (int k = 0; k < 8; k++) d[k] = 0.f;
  for (int j = 0; j < nm; j++) {
    const float* m = M + j * 16;
    float w = maskw(m, X, Y, Wq, Hq, B, BH, BW);
    if (w > 0.f) for (int k = 0; k < 8; k++) d[k] += w * m[8 + k];
  }
}

extern "C" __global__ void warp(const unsigned char* src, unsigned char* out, int oh, int ow, const float* q) {
  // q: 0 ox, 1 oy, 2 canvas px per output px, 3 cx0, 4 cy0, 5 Wq, 6 Hq, 7 cos, 8 sin, 9 turn, 10 flip,
  //    11 W0, 12 H0, 13 source px per original px, 14 Ws, 15 Hs
  int i = blockDim.x * blockIdx.x + threadIdx.x; if (i >= oh * ow) return;
  float X = q[3] + ((i % ow) + q[0] + .5f) * q[2], Y = q[4] + ((i / ow) + q[1] + .5f) * q[2];
  float dx = X - q[5] * .5f, dy = Y - q[6] * .5f;
  float xo = q[5] * .5f + q[7] * dx + q[8] * dy, yo = q[6] * .5f - q[8] * dx + q[7] * dy;    // undo the straighten
  if (q[10] != 0.f) xo = q[5] - xo;
  int t = (int)q[9]; float xs, ys;
  if (t == 1) { xs = yo; ys = q[12] - xo; } else if (t == 2) { xs = q[11] - xo; ys = q[12] - yo; }
  else if (t == 3) { xs = q[11] - yo; ys = xo; } else { xs = xo; ys = yo; }
  float u = xs * q[13] - .5f, v = ys * q[13] - .5f;
  int Ws = (int)q[14], Hs = (int)q[15];
  if (u < -1.f || v < -1.f || u > Ws || v > Hs) { out[3 * i] = out[3 * i + 1] = out[3 * i + 2] = 24; return; }
  u = fminf(fmaxf(u, 0.f), Ws - 1.f); v = fminf(fmaxf(v, 0.f), Hs - 1.f);
  int u0 = (int)u, v0 = (int)v, u1 = min(u0 + 1, Ws - 1), v1 = min(v0 + 1, Hs - 1);
  float fu = u - u0, fv = v - v0;
  for (int c = 0; c < 3; c++) {
    float a = src[(v0 * Ws + u0) * 3 + c] * (1 - fu) + src[(v0 * Ws + u1) * 3 + c] * fu;
    float b = src[(v1 * Ws + u0) * 3 + c] * (1 - fu) + src[(v1 * Ws + u1) * 3 + c] * fu;
    out[3 * i + c] = (unsigned char)(a * (1 - fv) + b * fv + .5f);
  }
}

extern "C" __global__ void tone(const unsigned char* src, float* out, int n, const float* p, const float* g,
                                const float* M, int nm, const float* B, int BH, int BW) {
  // p: 0-2 lo, 3-5 hi, 6 auto, 7 expo_mul, 8 warmth, 9 tint, 10 -, 11 whites, 12 blacks, 13 shadows, 14 highlights
  int i = blockDim.x * blockIdx.x + threadIdx.x; if (i >= n) return;
  float d[8];
  if (nm > 0) { float X, Y; canvas_xy(g, i, &X, &Y); locals(M, nm, X, Y, g[3], g[4], B, BH, BW, d); }
  else for (int k = 0; k < 8; k++) d[k] = 0.f;
  float wa = p[8] + d[4], ti = p[9] + d[5];
  float mul[3] = {1.f + 0.12f * wa, 1.f - 0.1f * ti, 1.f - 0.12f * wa};
  float em = p[7] * (d[0] != 0.f ? exp2f(2.f * d[0]) : 1.f);
  float v[3];
  for (int c = 0; c < 3; c++) {
    float x = src[3 * i + c] * (1.f / 255.f);
    if (p[6] != 0.f) { float st = clamp01((x - p[c]) / fmaxf(p[3 + c] - p[c], 1e-3f)); x += (st - x) * fminf(1.f, p[6]); }
    v[c] = x * em * mul[c];
  }
  if (p[11] != 0.f || p[12] != 0.f) {
    // white and black points move the luminance and keep the hue: whites scale the colour, blacks add grey
    float L = fmaxf(lum(v[0], v[1], v[2]), 0.f), dd = 1.f - fminf(1.f, L);
    float k = L > 1e-4f ? 1.f + p[11] * 0.3f * L * L : 1.f, o = p[12] * 0.25f * dd * dd * dd * dd;
    for (int c = 0; c < 3; c++) v[c] = v[c] * k + o;
  }
  float sh = p[13] + d[3], hl = p[14] + d[2];
  if (sh != 0.f || hl != 0.f) {
    float L = lum(v[0], v[1], v[2]), s3 = (1.f - L) * (1.f - L) * (1.f - L), h3 = L * L * L;
    for (int c = 0; c < 3; c++) v[c] += sh * 0.45f * s3 * (1.f - v[c]) - hl * 0.45f * h3 * v[c];
  }
  out[3 * i] = v[0]; out[3 * i + 1] = v[1]; out[3 * i + 2] = v[2];
}

extern "C" __global__ void luma(const float* x, float* L, int n) {
  int i = blockDim.x * blockIdx.x + threadIdx.x; if (i >= n) return;
  L[i] = lum(x[3 * i], x[3 * i + 1], x[3 * i + 2]);
}

extern "C" __global__ void colour(float* x, const float* L, const float* local, int n, const float* p, const float* g,
                                  const float* M, int nm, const float* B, int BH, int BW, int has_l) {
  // p: 0 clarity, 1 contrast, 2 teal_orange, 3 vibrance, 4 saturation
  int i = blockDim.x * blockIdx.x + threadIdx.x; if (i >= n) return;
  float d[8];
  if (nm > 0) { float X, Y; canvas_xy(g, i, &X, &Y); locals(M, nm, X, Y, g[3], g[4], B, BH, BW, d); }
  else for (int k = 0; k < 8; k++) d[k] = 0.f;
  float r = x[3 * i], gg = x[3 * i + 1], b = x[3 * i + 2];
  float cl = p[0] + d[7], co = p[1] + d[1], sa = p[4] + d[6];
  if (cl != 0.f && has_l) { float dl = cl * 0.8f * (L[i] - local[i]); r += dl; gg += dl; b += dl; }
  if (co != 0.f) { float k = 1.f + co; r = (r - .5f) * k + .5f; gg = (gg - .5f) * k + .5f; b = (b - .5f) * k + .5f; }
  if (p[2] != 0.f) {
    float t = p[2] * 0.12f;
    if (lum(r, gg, b) > .5f) { r += t; gg += t * .35f; b -= t * .6f; } else { r -= t * .6f; gg += t * .1f; b += t * .5f; }
  }
  if (p[3] != 0.f || sa != 0.f) {
    float Y = lum(r, gg, b), s = fmaxf(r, fmaxf(gg, b)) - fminf(r, fminf(gg, b));
    // vibrance raises muted colours most and leaves strong ones (and so most skin) nearly alone
    float k = (1.f + sa) * (1.f + p[3] * clamp01(1.f - 2.f * s));
    r = Y + (r - Y) * k; gg = Y + (gg - Y) * k; b = Y + (b - Y) * k;
  }
  x[3 * i] = r; x[3 * i + 1] = gg; x[3 * i + 2] = b;
}

extern "C" __global__ void blur1d(const float* in, float* out, const float* w, int r, int H, int W, int axis) {
  int i = blockDim.x * blockIdx.x + threadIdx.x; if (i >= H * W * 3) return;
  int c = i % 3, q = i / 3, xx = q % W, yy = q / W; float s = 0.f;
  for (int k = -r; k <= r; k++) {
    int y2 = yy, x2 = xx;
    if (axis == 0) y2 = min(max(yy + k, 0), H - 1); else x2 = min(max(xx + k, 0), W - 1);
    s += w[k + r] * in[(y2 * W + x2) * 3 + c];
  }
  out[i] = s;
}

extern "C" __global__ void mixdetail(float* x, const float* blur, int n, float a) {
  // a > 0: x + a (x - blur) (sharpen);  a < 0: x + |a| (blur - x) (noise reduction)
  int i = blockDim.x * blockIdx.x + threadIdx.x; if (i >= n) return;
  x[i] = a > 0.f ? x[i] + a * (x[i] - blur[i]) : x[i] + (-a) * (blur[i] - x[i]);
}

__device__ __forceinline__ unsigned int hash(unsigned int a) {
  a = (a ^ 61u) ^ (a >> 16); a *= 9u; a ^= a >> 4; a *= 0x27d4eb2du; a ^= a >> 15; return a;
}

extern "C" __global__ void finish(const float* x, unsigned char* out, int h, int w, const float* p, const float* g,
                                  const float* M, const float* B, int BH, int BW) {
  // p: 0 bw, 1 sepia, 2 fade, 3 vignette, 4 grain, 5 y0, 6 x0, 7 RH, 8 RW, 9 mask to show (-1 = none)
  int i = blockDim.x * blockIdx.x + threadIdx.x; if (i >= h * w) return;
  float r = x[3 * i], gg = x[3 * i + 1], b = x[3 * i + 2];
  int gy = i / w + (int)p[5], gx = i % w + (int)p[6];
  if (p[0] != 0.f) { float Y = lum(r, gg, b), a = fminf(1.f, p[0]); r += (Y - r) * a; gg += (Y - gg) * a; b += (Y - b) * a; }
  if (p[1] != 0.f) {
    float Y = lum(r, gg, b), a = fminf(1.f, p[1]);
    float sr = clamp01(Y * 1.07f + .03f), sg = clamp01(Y * .88f + .03f), sb = clamp01(Y * .66f + .03f);
    r += (sr - r) * a; gg += (sg - gg) * a; b += (sb - b) * a;
  }
  if (p[2] != 0.f) { float k = 1.f - p[2] * .5f, o = p[2] * .12f; r = r * k + o; gg = gg * k + o; b = b * k + o; }
  if (p[3] != 0.f) {
    float dx = (gx - p[8] * .5f) / (p[8] * .5f), dy = (gy - p[7] * .5f) / (p[7] * .5f);
    float m = 1.f - p[3] * .55f * powf(fminf(dx * dx + dy * dy, 2.f), 1.3f);
    r *= m; gg *= m; b *= m;
  }
  if (p[4] != 0.f) {
    unsigned int k = hash((unsigned int)gy * 73856093u ^ hash((unsigned int)gx * 19349663u + 1u));
    float u1 = ((k & 0xffffu) + .5f) / 65536.f, u2 = ((k >> 16) + .5f) / 65536.f;
    float nz = sqrtf(-2.f * logf(u1)) * cosf(6.2831853f * u2) * 0.06f * p[4];
    r += nz; gg += nz; b += nz;
  }
  r = clamp01(r); gg = clamp01(gg); b = clamp01(b);
  if (p[9] >= 0.f) {                               // the mask overlay (O): red over the mask's weight
    float X, Y; canvas_xy(g, i, &X, &Y);
    float a = 0.6f * clamp01(maskw(M + (int)p[9] * 16, X, Y, g[3], g[4], B, BH, BW));
    r += (1.f - r) * a; gg -= gg * a * .85f; b -= b * a * .85f;
  }
  out[3 * i] = (unsigned char)(r * 255.f + .5f);
  out[3 * i + 1] = (unsigned char)(gg * 255.f + .5f);
  out[3 * i + 2] = (unsigned char)(b * 255.f + .5f);
}
"""
_MOD = None
TPB = 256


def _k(name):
    global _MOD
    if _MOD is None:
        _MOD = cp.RawModule(code=_SRC)
    return _MOD.get_function(name)


def _launch(name, n, *args):
    _k(name)(((n + TPB - 1) // TPB,), (TPB,), args)


def _gauss(sigma):
    r = max(1, int(math.ceil(3 * sigma)))
    t = np.arange(-r, r + 1, dtype=np.float64)
    w = np.exp(-0.5 * (t / sigma) ** 2)
    return cp.asarray((w / w.sum()).astype(np.float32)), r


def blur(x, sigma):
    """Separable Gaussian of an HxWx3 float32 image (edges clamped)."""
    h, w = x.shape[:2]
    k, r = _gauss(sigma)
    tmp = cp.empty_like(x)
    out = cp.empty_like(x)
    n = h * w * 3
    _launch("blur1d", n, x, tmp, k, np.int32(r), np.int32(h), np.int32(w), np.int32(1))
    _launch("blur1d", n, tmp, out, k, np.int32(r), np.int32(h), np.int32(w), np.int32(0))
    return out


def reach(p, ctx):
    """How many source pixels of context a spatial effect needs around a tile (so strips and crops match)."""
    r = 0.0
    if p.get("clarity") or ctx.get("local_clarity"):
        r = max(r, 3.2 * max(ctx["H"], ctx["W"]) * ctx["s"] / 80.0)
    if p.get("denoise"):
        r = max(r, 3.0 * (0.6 + 2.2 * float(p["denoise"])) + 1)
    if p.get("sharpen"):
        r = max(r, 3.0 * 1.4 + 1)
    return int(math.ceil(r)) + 2


# ---------------------------------------------------------------- masks
BRUSH_LONG = 512                                     # the long side of a brush map over the canvas
_BRUSH = {}


_BRUSH_LAST = {}


def _paint(m, dabs):
    BH, BW = m.shape
    for d in dabs:
        x, y, r = float(d[0]) * BW, float(d[1]) * BH, max(0.5, float(d[2]) * BW)
        f = float(d[3]) if len(d) > 3 else 0.5
        er = len(d) > 4 and bool(d[4])
        x0, x1, y0, y1 = max(0, int(x - r - 1)), min(BW, int(x + r + 2)), max(0, int(y - r - 1)), min(BH, int(y + r + 2))
        if x0 >= x1 or y0 >= y1:
            continue
        yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
        t = np.sqrt((xx + .5 - x) ** 2 + (yy + .5 - y) ** 2) / r
        a = 1 - np.clip((t - (1 - f)) / max(f, 1e-3), 0, 1)
        a = a * a * (3 - 2 * a)
        sub = m[y0:y1, x0:x1]
        m[y0:y1, x0:x1] = sub * (1 - a) if er else np.maximum(sub, a)


def _brush_map(dabs, Wq, Hq):
    """Paint the dabs [x, y, r, feather, erase] (canvas fractions; r is a fraction of the canvas width) into a map.
    While you paint, each render adds a few dabs to the last stroke, so only the new dabs are painted."""
    key = hashlib.sha1(json.dumps([dabs, round(Wq / float(Hq), 4)]).encode()).hexdigest()
    if key in _BRUSH:
        return _BRUSH[key]
    BW = BRUSH_LONG if Wq >= Hq else max(8, int(round(BRUSH_LONG * Wq / float(Hq))))
    BH = BRUSH_LONG if Hq > Wq else max(8, int(round(BRUSH_LONG * Hq / float(Wq))))
    last = _BRUSH_LAST.get((BH, BW))
    if last and len(last[0]) <= len(dabs) and last[0] == dabs[:len(last[0])]:
        m = last[1].copy()
        _paint(m, dabs[len(last[0]):])
    else:
        m = np.zeros((BH, BW), np.float32)
        _paint(m, dabs)
    _BRUSH_LAST[(BH, BW)] = (list(dabs), m)
    if len(_BRUSH) > 32:
        _BRUSH.clear()
    _BRUSH[key] = (m, BH, BW)
    return _BRUSH[key]


def pack_masks(masks, Wq, Hq):
    """The adj's mask list -> (M float32 [n*16] on the card, n, B brush maps on the card, BH, BW)."""
    rows, maps = [], []
    for mk in (masks or [])[:MAX_MASKS]:
        t = mk.get("type")
        adj = mk.get("adj") or {}
        deltas = [float(adj.get(k, 0) or 0) for k in LOCAL_KEYS]
        if not any(deltas) and not mk.get("_show"):
            continue
        if t == "linear":
            geo = [1, mk["x0"], mk["y0"], mk["x1"], mk["y1"], 0]
        elif t == "radial":
            geo = [2, mk["x"], mk["y"], mk["rx"], mk["ry"], mk.get("feather", 0.5)]
        elif t == "brush":
            maps.append(_brush_map(mk.get("dabs") or [], Wq, Hq))
            geo = [3, 0, 0, 0, 0, 0]
        else:
            continue
        rows.append(geo + [1.0 if mk.get("invert") else 0.0, len(maps) - 1 if t == "brush" else 0] + deltas)
    if maps:
        BH, BW = max(m[1] for m in maps), max(m[2] for m in maps)
        B = np.zeros((len(maps), BH, BW), np.float32)
        for j, (m, h, w) in enumerate(maps):
            B[j, :h, :w] = m
    else:
        B, BH, BW = np.zeros((1, 1, 1), np.float32), 1, 1
    M = np.array(rows, np.float32).ravel() if rows else np.zeros(MSTRIDE, np.float32)
    return cp.asarray(M), len(rows), cp.asarray(B), BH, BW


# ---------------------------------------------------------------- geometry
def warp(src_u8, q, oh, ow):
    """Gather an oh x ow output (uint8) from src through the geometry q (see the warp kernel)."""
    out = cp.empty((oh, ow, 3), cp.uint8)
    _launch("warp", oh * ow, cp.ascontiguousarray(src_u8), out, np.int32(oh), np.int32(ow), cp.asarray(np.asarray(q, np.float32)))
    return out


def develop(src_u8, p, ctx, blur_big, masks=None, show=-1):
    """src_u8: HxWx3 uint8 CuPy array (a whole image or a tile). p: the resolved slider values. masks: the adj's
    mask list (canvas coordinates). Returns uint8 HxWx3."""
    g = lambda k: float(p.get(k, 0) or 0)  # noqa: E731
    h, w = src_u8.shape[:2]
    n = h * w
    src = cp.ascontiguousarray(src_u8)
    lo, hi = ctx.get("auto") or (None, None)
    if g("auto") and lo is None:
        flat = src.reshape(-1, 3)[::7].astype(cp.float32) / 255.0
        lo, hi = cp.asnumpy(cp.percentile(flat, 0.5, axis=0)), cp.asnumpy(cp.percentile(flat, 99.5, axis=0))
    lo = np.zeros(3, np.float32) if lo is None else np.asarray(lo, np.float32)
    hi = np.ones(3, np.float32) if hi is None else np.asarray(hi, np.float32)
    Wq, Hq = ctx.get("Wq", ctx["W"]), ctx.get("Hq", ctx["H"])
    geo = cp.asarray(np.array([ctx.get("cx0", 0), ctx.get("cy0", 0), 1.0 / ctx["s"], Wq, Hq, ctx.get("y0", 0), ctx.get("x0", 0), w],
                              np.float32))
    M, nm, B, BH, BW = pack_masks(masks, Wq, Hq)
    mc = (B, np.int32(BH), np.int32(BW))
    pt = np.array(list(lo) + list(hi) + [g("auto"), 2.0 ** (g("exposure") * 2), g("warmth"), g("tint"), 0,
                  g("whites"), g("blacks"), g("shadows"), g("highlights")], np.float32)
    x = cp.empty((h, w, 3), cp.float32)
    _launch("tone", n, src, x, np.int32(n), cp.asarray(pt), geo, M, np.int32(nm), *mc)
    local_cl = any(((mk.get("adj") or {}).get("clarity") or 0) for mk in (masks or []))
    has_l = bool(g("clarity") or local_cl)
    L = local = x                                     # placeholders when clarity is off (the kernel does not read them)
    if has_l:
        L = cp.empty((h, w), cp.float32)
        _launch("luma", n, x, L, np.int32(n))
        local = cp.ascontiguousarray(blur_big(L, max(ctx["H"], ctx["W"]) * ctx["s"] / 80.0).astype(cp.float32))
    pc = np.array([g("clarity"), g("contrast"), g("teal_orange"), g("vibrance"), g("saturation")], np.float32)
    if pc.any() or nm:
        _launch("colour", n, x, L, local, np.int32(n), cp.asarray(pc), geo, M, np.int32(nm), *mc, np.int32(1 if has_l else 0))
    del L, local
    if g("denoise"):
        b = blur(x, 0.6 + 2.2 * g("denoise"))
        _launch("mixdetail", n * 3, x, b, np.int32(n * 3), np.float32(-min(1.0, g("denoise") * 1.2)))
        del b
    if g("sharpen"):
        b = blur(x, 1.4)
        _launch("mixdetail", n * 3, x, b, np.int32(n * 3), np.float32(g("sharpen") * 1.4))
        del b
    out = cp.empty((h, w, 3), cp.uint8)
    if show is not None and show >= 0:
        sm = [dict(mk, _show=True) for mk in (masks or [])]
        M2, _, B, BH, BW = pack_masks(sm[show:show + 1], Wq, Hq)
        show_i = 0
    else:
        M2, show_i = M, -1
    pf = np.array([g("bw"), g("sepia"), g("fade"), g("vignette"), g("grain"), ctx.get("y0", 0), ctx.get("x0", 0),
                   ctx["H"] * ctx["s"], ctx["W"] * ctx["s"], show_i], np.float32)
    _launch("finish", n, x, out, np.int32(h), np.int32(w), cp.asarray(pf), geo, M2, B, np.int32(BH), np.int32(BW))
    return out


def stats(out_u8):
    """Histogram (64 bins per channel) and clipping counts of a uint8 result already on the card."""
    sub = out_u8[::2, ::2]
    hist = [cp.asnumpy(cp.bincount((sub[..., c].ravel() >> 2), minlength=64)).tolist() for c in range(3)]
    n = float(sub.shape[0] * sub.shape[1])
    hi = float((sub.max(axis=2) >= 254).sum()) / n
    lo = float((sub.max(axis=2) <= 2).sum()) / n
    return hist, {"highlights": round(hi * 100, 2), "shadows": round(lo * 100, 2)}


# ---------------------------------------------------------------- auto-straighten
def _edges(u8, long_side=512):
    """Edge maps of the luminance at about long_side px, inside a centred disc (so that a rotation does not change
    which pixels count): |d/dy| (horizontal lines) and |d/dx| (vertical lines), each kept only where it is in the
    strongest 5%, so texture and soft shading do not count."""
    import cupyx.scipy.ndimage as ndi
    x = u8.astype(cp.float32)
    L = x[..., 0] * 0.2126 + x[..., 1] * 0.7152 + x[..., 2] * 0.0722
    f = max(1, int(round(max(L.shape) / float(long_side))))
    if f > 1:
        h, w = L.shape[0] // f * f, L.shape[1] // f * f
        L = L[:h, :w].reshape(h // f, f, w // f, f).mean(axis=(1, 3))
    h, w = L.shape
    yy, xx = cp.ogrid[:h, :w]
    r = min(h, w) / 2.0 - 2
    disc = ((yy - h / 2.0) ** 2 + (xx - w / 2.0) ** 2) <= r * r
    out = []
    for ax in (0, 1):
        e = cp.abs(ndi.sobel(L, axis=ax)) * disc
        t = float(cp.percentile(e[disc], 95))
        out.append(cp.where(e > max(t, 1.0), e, 0).astype(cp.float32))
    return out


def level_scores(u8, angles):
    """How sharp the row profile of the horizontal-edge map and the column profile of the vertical-edge map are after
    a rotation by each angle (degrees). A straight line puts its whole length into one row (or column) only when it is
    level, so the high-passed profile variance peaks at the angle that levels the lines. Returns the variances
    normalised by their mean over all the angles (1 = average)."""
    import cupyx.scipy.ndimage as ndi
    eh, ev = _edges(u8)
    out = []
    for a in angles:
        s = []
        for e, axis in ((eh, 1), (ev, 0)):
            p = ndi.rotate(e, float(a), reshape=False, order=1, mode="constant").sum(axis=axis)
            hp = p - ndi.uniform_filter1d(p, 9)
            s.append(float((hp * hp).mean()))
        out.append(s)
    v = np.array(out)                                  # [angle, (horizontal lines, vertical lines)]
    return v / np.maximum(v.mean(axis=0), 1e-9)
