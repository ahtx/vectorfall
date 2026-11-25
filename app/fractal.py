"""Fractal Explorer: Mandelbrot, Julia, Burning Ship and Tricorn, one GPU thread per pixel, smooth colouring and a
palette applied on the card. FP32 until the zoom outruns its precision, then FP64 — the K420's FP64 runs at 1/24th
speed (Cray C90 class), and the UI says so when it switches.
"""
import io
import math
import threading

# which frame each browser tab wants now (sess -> newest gen); an older frame is not worth the shared card
_LATEST = {}
_REQ = threading.local()


class Superseded(Exception):
    """The tab that asked for this frame has asked for a newer one."""


def supersede(sess, gen):
    if sess:
        _LATEST[str(sess)[:40]] = max(_LATEST.get(str(sess)[:40], 0), int(gen))
        if len(_LATEST) > 500:
            _LATEST.clear()
import time

import numpy as np
from PIL import Image

import cupy as cp

from .engine import mark_gflops, run_on_gpu, sync
from . import cards

_SRC = r'''
template<typename T> __device__ void esc(T cr, T ci, T jr, T ji, int type, int maxit, float* out, long long o){
  T zr, zi;
  if (type==1){ zr=cr; zi=ci; cr=jr; ci=ji; } else { zr=0; zi=0; }
  int it=0; T zr2=zr*zr, zi2=zi*zi;
  for (; it<maxit; it++){
    if (zr2+zi2 > (T)256) break;
    T nzi;
    if (type==2) nzi = (T)2*fabs(zr*zi) + ci;            // burning ship
    else if (type==3) nzi = (T)-2*zr*zi + ci;             // tricorn
    else nzi = (T)2*zr*zi + ci;
    zr = zr2 - zi2 + cr; zi = nzi; zr2=zr*zr; zi2=zi*zi; }
  if (it>=maxit) { out[o] = -1.0f; return; }
  float m = (float)(zr2+zi2);
  out[o] = (float)it + 1.0f - log2f(0.5f*logf(m)); }
extern "C" __global__ void frac32(int w, int h, float x0, float y0, float dx, float jr, float ji, int type, int maxit, float* out){
  int x=blockIdx.x*blockDim.x+threadIdx.x, y=blockIdx.y*blockDim.y+threadIdx.y; if (x>=w||y>=h) return;
  esc<float>(x0+x*dx, y0+y*dx, jr, ji, type, maxit, out, (long long)y*w+x); }
extern "C" __global__ void frac64(int w, int h, double x0, double y0, double dx, double jr, double ji, int type, int maxit, float* out){
  int x=blockIdx.x*blockDim.x+threadIdx.x, y=blockIdx.y*blockDim.y+threadIdx.y; if (x>=w||y>=h) return;
  esc<double>(x0+x*dx, y0+y*dx, jr, ji, type, maxit, out, (long long)y*w+x); }
// Perturbation Mandelbrot: a high-precision reference orbit (Zr,Zi) lets each pixel iterate only its small delta in
// FP64, so the zoom depth is limited by the reference's precision (computed on the CPU), not by the raw floats.
// Chunked: each launch advances every still-running pixel by nchunk iterations, carrying its delta (DR,DI) on the
// card between launches. Deep zooms need tens of thousands of iterations; one launch that long trips the K420's
// display watchdog (cudaErrorLaunchTimeout), so the host loops this in short, watchdog-safe bursts. out starts at
// -2 ("running"); an escape writes the smooth count (>=0); whatever is still -2 after the last chunk is interior.
extern "C" __global__ void pert(const double* Zr, const double* Zi, int reflen, int w, int h,
                                double dx, double x0off, double y0off, int n0, int nchunk,
                                double* DR, double* DI, float* out){
  int px=blockIdx.x*blockDim.x+threadIdx.x, py=blockIdx.y*blockDim.y+threadIdx.y; if (px>=w||py>=h) return;
  long long idx=(long long)py*w+px;
  if (out[idx] > -1.5f) return;                          // already escaped in an earlier chunk
  double dcr = x0off + px*dx, dci = y0off + py*dx;       // delta_c = pixel - reference centre (small)
  double dr=DR[idx], di=DI[idx];                         // delta_z carried from the previous chunk
  int end = n0+nchunk; if (end>reflen) end=reflen;
  for (int n=n0; n<end; n++){
    double Zrn=Zr[n], Zin=Zi[n];
    double zr=Zrn+dr, zi=Zin+di;
    double mag=zr*zr+zi*zi;
    if (mag > 4.0){ out[idx] = (float)(n + 1.0 - log2(0.5*log(mag))); return; }
    double ndr = 2.0*(Zrn*dr - Zin*di) + (dr*dr - di*di) + dcr;   // delta_{n+1} = 2 Z_n delta + delta^2 + dc
    double ndi = 2.0*(Zrn*di + Zin*dr) + 2.0*dr*di + dci;
    dr=ndr; di=ndi;
  }
  DR[idx]=dr; DI[idx]=di; }                              // still running: save state for the next chunk
// Tiles: perturbation with rebasing, per-pixel reference index RI and iteration count IT carried between launches.
extern "C" __global__ void pertr(const double* Zr, const double* Zi, int reflen, int w, int h,
                                 double dx, double x0off, double y0off, int nchunk, int maxit,
                                 double* DR, double* DI, int* RI, int* IT, float* out){
  int px=blockIdx.x*blockDim.x+threadIdx.x, py=blockIdx.y*blockDim.y+threadIdx.y; if (px>=w||py>=h) return;
  long long idx=(long long)py*w+px;
  if (out[idx] > -1.5f) return;
  double dcr = x0off + px*dx, dci = y0off + py*dx;
  double dr=DR[idx], di=DI[idx]; int ri=RI[idx], it=IT[idx];
  int end = it + nchunk; if (end > maxit) end = maxit;
  for (; it<end; it++){
    double Zrn=Zr[ri], Zin=Zi[ri];
    double zr=Zrn+dr, zi=Zin+di;
    double mag=zr*zr+zi*zi;
    if (mag > 256.0){ out[idx] = (float)(it + 1.0 - log2(0.5*log(mag))); return; }
    if (mag < dr*dr+di*di || ri >= reflen-1){ dr=zr; di=zi; ri=0; Zrn=0.0; Zin=0.0; }   // rebase onto the start of the reference
    double ndr = 2.0*(Zrn*dr - Zin*di) + (dr*dr - di*di) + dcr;
    double ndi = 2.0*(Zrn*di + Zin*dr) + 2.0*dr*di + dci;
    dr=ndr; di=ndi; ri++;
  }
  DR[idx]=dr; DI[idx]=di; RI[idx]=ri; IT[idx]=it;
  if (it >= maxit) out[idx] = -1.0f; }
extern "C" __global__ void colour(const float* v, int n, const unsigned char* pal, int np, float scale, float shift, unsigned char* rgb){
  int i=blockIdx.x*blockDim.x+threadIdx.x; if (i>=n) return;
  float f=v[i];
  if (f<0){ rgb[3*i]=8; rgb[3*i+1]=6; rgb[3*i+2]=8; return; }
  float t = sqrtf(f)*scale + shift; t = t - floorf(t);
  float pf = t*(np-1); int a=(int)pf; int b=a+1<np?a+1:a; float u=pf-a;
  for (int c=0;c<3;c++) rgb[3*i+c] = (unsigned char)(pal[3*a+c]*(1-u) + pal[3*b+c]*u); }
'''
_MOD = {}
TYPES = {"mandelbrot": 0, "julia": 1, "burning-ship": 2, "tricorn": 3}
PALETTES = {
    "rosso": ["#050304", "#3a0000", "#8e0000", "#d40000", "#ff2a1a", "#ff8a00", "#ffd300", "#fff6d6", "#d40000", "#3a0000"],
    "inferno": ["#000004", "#1b0c41", "#4a0c6b", "#781c6d", "#a52c60", "#cf4446", "#ed6925", "#fb9b06", "#f7d13d", "#fcffa4"],
    "ocean": ["#020812", "#04223f", "#0b4f7c", "#1f8ab8", "#6cc6e6", "#e6f7ff", "#6cc6e6", "#0b4f7c"],
    "electric": ["#000000", "#2d00f7", "#6a00f4", "#8900f2", "#bc00dd", "#e500a4", "#f20089", "#ffd300", "#ffffff"],
    "steel": ["#08090b", "#2b2f36", "#5b6068", "#9aa0a8", "#e8eaed", "#9aa0a8", "#2b2f36"],
    "sunset": ["#0d0221", "#261447", "#6b2d5c", "#ff3864", "#ff8b3d", "#ffd23f", "#fff3b0"],
}


def _mod():
    if "m" not in _MOD:
        _MOD["m"] = cp.RawModule(code=_SRC, options=("--std=c++11",))
    return _MOD["m"]


def _pal(name):
    cols = PALETTES.get(name, PALETTES["rosso"])
    arr = np.array([[int(c[i:i + 2], 16) for i in (1, 3, 5)] for c in cols], np.uint8)
    return arr


def reference_orbit(cx, cy, maxit, prec=None):
    """Iterate the centre point in arbitrary precision (Decimal), returning the FP64 reference orbit Z_n.

    cx, cy may be floats or decimal strings. prec digits default to enough for the zoom. This is a few thousand
    high-precision complex multiplies on the CPU — the only part that must be exact; every pixel then rides deltas."""
    import decimal
    ctx = decimal.Context(prec=prec or 50)
    D = ctx.create_decimal
    cr, ci = D(str(cx)), D(str(cy))
    zr, zi = D(0), D(0)
    Zr = np.empty(maxit, np.float64)
    Zi = np.empty(maxit, np.float64)
    two, four = D(2), D(4)
    n = 0
    while n < maxit:
        Zr[n] = float(zr)
        Zi[n] = float(zi)
        if zr * zr + zi * zi > four:
            n += 1
            break
        zr, zi = ctx.add(ctx.subtract(ctx.multiply(zr, zr), ctx.multiply(zi, zi)), cr), ctx.add(ctx.multiply(two, ctx.multiply(zr, zi)), ci)
        n += 1
    return Zr[:n], Zi[:n]


def deep_iters(depth, cap=100000):
    """Iterations a frame needs at a given zoom depth (log10 of magnification): deep frames go solid black without
    far more iterations — e.g. 1e-14 needs ~10k at the seahorse spiral, 1e-15 ~25k."""
    return int(min(cap, max(250, 200 + 180 * depth + 90 * depth * depth)))


def pert_frame(cx, cy, depth, dx, w, h, iters, out, cancel=None):
    """Chunked perturbation render into `out` (float32 w*h). Call from INSIDE a GPU-worker job. Each launch advances
    every still-running pixel by a short burst, carrying its delta on the card, so no launch nears the K420's
    display watchdog. Returns the reference orbit length."""
    m = _mod()
    Zr, Zi = reference_orbit(cx, cy, iters, int(24 + depth * 1.4))
    reflen = Zr.size
    gZr, gZi = cp.asarray(Zr), cp.asarray(Zi)
    x0off, y0off = -dx * (w / 2.0), -dx * (h / 2.0)
    out.fill(-2.0)
    DR = cp.zeros(w * h, cp.float64)
    DI = cp.zeros(w * h, cp.float64)
    sc = cards.work_scale(bound="fp64")                  # bigger bursts on faster cards: fewer launches, same safety
    chunk = int(max(150, min(3000 * sc, 1.2e9 * sc / (w * h))))
    grid, blk = ((w + 15) // 16, (h + 15) // 16), (16, 16)
    fn = m.get_function("pert")
    n0 = 0
    while n0 < reflen:
        nc = min(chunk, reflen - n0)
        fn(grid, blk, (gZr, gZi, np.int32(reflen), np.int32(w), np.int32(h), np.float64(dx), np.float64(x0off),
                       np.float64(y0off), np.int32(n0), np.int32(nc), DR, DI, out))
        sync()
        n0 += nc
        if cancel is not None and cancel():
            raise Superseded()
        if n0 % (chunk * 4) == 0 and int((out < -1.5).sum()) == 0:
            break
    return reflen


_REF = {}                                          # anchor -> reference orbit (CPU arrays), most recent last
_TILES = {}                                        # tile key -> (png bytes, meta)
TILE = 256
TW0 = 4.0                                          # width of a zoom-0 tile in the complex plane


def _ref(ax, ay, iters, prec):
    k = (ax, ay, iters, prec)
    if k in _REF:
        _REF[k] = _REF.pop(k)
        return _REF[k]
    Zr, Zi = reference_orbit(ax, ay, iters, prec)
    _REF[k] = (Zr, Zi)
    while len(_REF) > 8:
        _REF.pop(next(iter(_REF)))
    return _REF[k]


def tile(kind="mandelbrot", ax="-0.5", ay="0", z=0, tx=0, ty=0, palette="rosso", density=1.0, jr=-0.8, ji=0.156, iters=0):
    """One 256 px tile. ax/ay: the anchor (exact decimal strings); z: zoom level (tile width TW0 / 2^z);
    tx/ty: tile indices from the anchor (the anchor is the top-left corner of tile 0,0). Returns (png, meta)."""
    z = int(z)
    tw = TW0 / (2.0 ** z)
    dx = tw / TILE
    depth = max(0.0, -math.log10(tw * 4 / 3.0))
    iters = int(iters) or deep_iters(depth)
    key = (kind, ax, ay, z, int(tx), int(ty), palette, round(float(density), 3), float(jr), float(ji), iters)
    hit = _TILES.get(key)
    if hit:
        return hit
    t = TYPES.get(kind, 0)
    mode = "FP32"
    if kind == "mandelbrot" and dx < 1e-13:
        mode = "perturbation"
    elif dx < 2e-7:
        mode = "FP64"
    x0off, y0off = (int(tx) * TILE + 0.5) * dx, (int(ty) * TILE + 0.5) * dx
    ref = _ref(ax, ay, iters, int(24 + depth * 1.4)) if mode == "perturbation" else None
    cancel = getattr(_REQ, "cancel", None)

    def job():
        m = _mod()
        n = TILE * TILE
        out = cp.empty(n, cp.float32)
        grid, blk = ((TILE + 15) // 16, (TILE + 15) // 16), (16, 16)
        t0 = time.time()
        if mode == "perturbation":
            gZr, gZi = cp.asarray(ref[0]), cp.asarray(ref[1])
            out.fill(-2.0)
            DR, DI = cp.zeros(n, cp.float64), cp.zeros(n, cp.float64)
            RI, IT = cp.zeros(n, cp.int32), cp.zeros(n, cp.int32)
            chunk = int(3000 * cards.work_scale(bound="fp64"))
            fn = m.get_function("pertr")
            done = 0
            while done < iters:
                fn(grid, blk, (gZr, gZi, np.int32(ref[0].size), np.int32(TILE), np.int32(TILE), np.float64(dx), np.float64(x0off),
                               np.float64(y0off), np.int32(chunk), np.int32(iters), DR, DI, RI, IT, out))
                sync()
                done += chunk
                if cancel is not None and cancel():
                    raise Superseded()
                if done % (chunk * 4) == 0 and int((out < -1.5).sum()) == 0:
                    break
            out[out < -1.5] = -1.0
        else:
            x0, y0 = float(ax) + x0off, float(ay) + y0off
            fn = "frac64" if mode == "FP64" else "frac32"
            cast = np.float64 if mode == "FP64" else np.float32
            m.get_function(fn)(grid, blk, (np.int32(TILE), np.int32(TILE), cast(x0), cast(y0), cast(dx),
                                           cast(jr), cast(ji), np.int32(t), np.int32(iters), out))
        sync()
        dt = time.time() - t0
        pal = cp.asarray(_pal(palette))
        rgb = cp.empty(n * 3, cp.uint8)
        m.get_function("colour")(((n + 255) // 256,), (256,), (out, np.int32(n), pal, np.int32(pal.shape[0]),
                                                               np.float32(0.11 * density), np.float32(0.0), rgb))
        inside = float((out < 0).mean())
        return cp.asnumpy(rgb).reshape(TILE, TILE, 3), dt, inside
    img, dt, inside = run_on_gpu(job, "fractal tile", 60)
    buf = io.BytesIO()
    Image.fromarray(img).save(buf, "PNG", compress_level=1)
    meta = {"ms": round(dt * 1000, 1), "iters": iters, "precision": mode, "z": z, "inside": round(inside, 3)}
    _TILES[key] = (buf.getvalue(), meta)
    while len(_TILES) > 1500:
        _TILES.pop(next(iter(_TILES)))
    return _TILES[key]


def render(kind="mandelbrot", cx=-0.5, cy=0.0, scale=3.0, w=900, h=600, iters=0, palette="rosso", jr=-0.8, ji=0.156,
           density=1.0, fmt="png"):
    """scale = width of the view in the complex plane. cx/cy may be decimal strings for deep zoom."""
    w, h = max(16, min(int(w), 7680)), max(16, min(int(h), 4320))
    scale = float(scale)
    dx = scale / w
    depth = max(0.0, -math.log10(scale / 3.0))
    if not iters:                                      # deeper zoom needs *far* more iterations, or it goes solid black
        iters = deep_iters(depth)
    t = TYPES.get(kind, 0)
    # Mandelbrot deep zoom: perturbation (exact only on the CPU reference orbit) once the floats run short
    mode = "FP32"
    if kind == "mandelbrot" and dx < 1e-13:          # doubles hold to about here; then only perturbation is exact
        mode = "perturbation"
    elif dx < 2e-7:
        mode = "FP64"
    cancel = getattr(_REQ, "cancel", None)           # set by the HTTP route for the tab's newest frame

    def job():
        if cancel is not None and cancel():
            raise Superseded()
        m = _mod()
        out = cp.empty(w * h, cp.float32)
        grid, blk = ((w + 15) // 16, (h + 15) // 16), (16, 16)
        t0 = time.time()
        if mode == "perturbation":
            pert_frame(cx, cy, depth, dx, w, h, iters, out, cancel)
        else:
            fx, fy = float(cx), float(cy)
            x0, y0 = fx - scale / 2, fy - dx * h / 2
            fn = "frac64" if mode == "FP64" else "frac32"
            cast = np.float64 if mode == "FP64" else np.float32
            m.get_function(fn)(grid, blk, (np.int32(w), np.int32(h), cast(x0), cast(y0), cast(dx),
                                           cast(jr), cast(ji), np.int32(t), np.int32(iters), out))
        sync()
        dt = time.time() - t0
        done = out[out >= 0]
        avg = float(done.mean()) if done.size else float(iters)
        inside = float((out < 0).mean())
        work = (avg * (1 - inside) + iters * inside) * w * h
        mark_gflops(work * 9, dt, "fractal " + mode)
        pal = cp.asarray(_pal(palette))
        rgb = cp.empty(w * h * 3, cp.uint8)
        m.get_function("colour")(((w * h + 255) // 256,), (256,), (out, np.int32(w * h), pal, np.int32(pal.shape[0]),
                                                                     np.float32(0.11 * density), np.float32(0.0), rgb))
        return cp.asnumpy(rgb).reshape(h, w, 3), dt, work, inside
    img, dt, work, inside = run_on_gpu(job, "fractal", 120)
    buf = io.BytesIO()
    if fmt == "jpg":
        Image.fromarray(img).save(buf, "JPEG", quality=92)
    else:
        Image.fromarray(img).save(buf, "PNG", compress_level=1)
    return buf.getvalue(), {"ms": round(dt * 1000, 1), "iters": iters, "precision": mode,
                            "gflops": round(work * 9 / dt / 1e9, 1) if dt else 0, "pixels": w * h,
                            "zoom": 3.0 / scale, "inside": round(inside, 3)}
