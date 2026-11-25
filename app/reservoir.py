"""Reservoir Lab: reservoir computing on the card, for real classification and forecasting problems.

An input (a sound, an image, a number sequence, a live microphone clip) is turned into a sequence of feature frames u(t)
and poured into a fixed, random dynamical system -- the reservoir -- which is never trained:

  * "esn"    an echo state network: N tanh units with random sparse recurrent weights
             x(t+1) = (1 - a) x(t) + a tanh(W x(t) + Win u(t) + b)
  * "ripple" a literal ripple tank: a damped, slightly nonlinear 2-D wave equation; each input channel pushes the water
             at its own random spot, and we photograph the surface

The reservoir's state is averaged over K equal slices of the input ("snapshots"), giving a small fixed-size picture of
how it rang. Only a single linear layer on top of those snapshots is trained -- ridge regression, solved in closed form
on the card -- so training takes milliseconds and works from a handful of examples per class.

Every result is reported next to chance and next to the same linear layer reading the raw input directly, so you can
see whether the reservoir is actually earning its keep.
"""
import base64
import gzip
import io
import json
import math
import os
import shutil
import subprocess
import threading
import time
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from PIL import Image

import cupy as cp

from . import engine, jobs

router = APIRouter()
ROOT = "/srv/data/reservoir"
os.makedirs(ROOT, exist_ok=True)
LOCK = threading.RLock()

SR = 16000                  # audio is resampled to 16 kHz mono
HOP = 160                   # 10 ms feature frames
WIN = 400                   # 25 ms analysis window
NFFT = 512
MELS = 32
MAX_AUDIO_S = 6.0
IMG = 32                    # images are scanned as 32 x 32: rows, then columns
MAX_STEPS = 600             # longest input sequence fed to the reservoir

KINDS = ("audio", "image", "numbers", "series")
DEFAULT_RES = {"type": "esn", "units": 400, "leak": 0.35, "radius": 0.9, "input_scale": 0.8, "density": 0.1,
               "snapshots": 6, "seed": 7, "ripple_grid": 64, "ripple_damp": 0.02, "ripple_nl": 0.5, "substeps": 3}
UNITS = (144, 256, 400, 625, 900, 1024)
RES_VER = 2                 # bump when the reservoir maths changes, so cached features are recomputed


# ---------------------------------------------------------------- storage
def _pdir(pid):
    if not pid or not all(c in "0123456789abcdef" for c in pid):
        raise KeyError(pid)
    d = os.path.join(ROOT, pid)
    if not os.path.isdir(d):
        raise KeyError(pid)
    return d


def _load(pid):
    with open(os.path.join(_pdir(pid), "meta.json")) as f:
        return json.load(f)


def _save(meta):
    d = os.path.join(ROOT, meta["id"])
    tmp = os.path.join(d, "meta.json.tmp")
    with open(tmp, "w") as f:
        json.dump(meta, f)
    os.replace(tmp, os.path.join(d, "meta.json"))


def create(name, kind, task=None):
    if kind not in KINDS:
        raise ValueError("kind must be one of " + ", ".join(KINDS))
    pid = uuid.uuid4().hex[:10]
    d = os.path.join(ROOT, pid)
    os.makedirs(os.path.join(d, "ex"))
    res = dict(DEFAULT_RES)
    if kind == "series":
        res.update(units=400, leak=0.5, snapshots=1)
    meta = {"id": pid, "name": (name or "").strip() or {"audio": "Sounds", "image": "Images", "numbers": "Sequences",
                                                       "series": "Forecast"}[kind],
            "kind": kind, "task": "forecast" if kind == "series" else "classify", "reservoir": res,
            "examples": [], "created": time.time(), "trained": None,
            "forecast": {"horizon": 5, "lags": 10, "train_frac": 0.7} if kind == "series" else None, "series": None}
    _save(meta)
    return meta


def list_projects():
    out = []
    for pid in sorted(os.listdir(ROOT)):
        try:
            m = _load(pid)
        except Exception:  # noqa: BLE001
            continue
        out.append({"id": m["id"], "name": m["name"], "kind": m["kind"], "task": m["task"], "n": len(m["examples"]),
                    "classes": sorted({e["label"] for e in m["examples"]}), "created": m["created"],
                    "trained": (m["trained"] or {}).get("summary")})
    return sorted(out, key=lambda x: -x["created"])


def delete(pid):
    shutil.rmtree(_pdir(pid))
    return {"deleted": pid}


def public(meta):
    m = dict(meta)
    m["classes"] = sorted({e["label"] for e in meta["examples"]})
    m["counts"] = {c: sum(1 for e in meta["examples"] if e["label"] == c) for c in m["classes"]}
    return m


def update(pid, body):
    with LOCK:
        meta = _load(pid)
        if "name" in body:
            meta["name"] = str(body["name"])[:80] or meta["name"]
        r = body.get("reservoir") or {}
        res = meta["reservoir"]
        for k, lo, hi in (("leak", 0.01, 1.0), ("radius", 0.0, 1.6), ("input_scale", 0.01, 5.0), ("density", 0.01, 1.0),
                          ("ripple_damp", 0.0, 0.3), ("ripple_nl", 0.0, 3.0)):
            if k in r:
                res[k] = float(min(hi, max(lo, float(r[k]))))
        for k, lo, hi in (("snapshots", 1, 16), ("seed", 0, 10 ** 6), ("substeps", 1, 8)):
            if k in r:
                res[k] = int(min(hi, max(lo, int(r[k]))))
        if "units" in r:
            res["units"] = min(UNITS, key=lambda u: abs(u - int(r["units"])))
        if "ripple_grid" in r:
            res["ripple_grid"] = 48 if int(r["ripple_grid"]) < 56 else 64 if int(r["ripple_grid"]) < 80 else 96
        if r.get("type") in ("esn", "ripple"):
            res["type"] = r["type"]
        if body.get("encoder") in ("reservoir", "clip") and meta["kind"] == "image":
            meta["encoder"] = body["encoder"]                     # image projects may read CLIP features instead
        f = body.get("forecast") or {}
        if meta["forecast"] is not None:
            for k, lo, hi in (("horizon", 1, 250), ("lags", 1, 60)):
                if k in f:
                    meta["forecast"][k] = int(min(hi, max(lo, int(f[k]))))
            if "train_frac" in f:
                meta["forecast"]["train_frac"] = float(min(0.9, max(0.3, float(f["train_frac"]))))
        _save(meta)
        return public(meta)


# ---------------------------------------------------------------- input -> feature frames u(t)
def _mel_fb():
    f = np.fft.rfftfreq(NFFT, 1.0 / SR)
    mel = lambda hz: 2595 * np.log10(1 + hz / 700.0)  # noqa: E731
    pts = 700 * (10 ** (np.linspace(mel(60), mel(7600), MELS + 2) / 2595) - 1)
    fb = np.zeros((MELS, f.size), np.float32)
    for i in range(MELS):
        a, c, b = pts[i], pts[i + 1], pts[i + 2]
        fb[i] = np.clip(np.minimum((f - a) / (c - a), (b - f) / (b - c)), 0, None)
    return fb


FB = _mel_fb()


def _wav_fast(data):
    """A plain 16 kHz PCM WAV -> mono float32 without starting ffmpeg (about 0.15 s saved per file); None if not."""
    import wave
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        return None
    try:
        with wave.open(io.BytesIO(data)) as w:
            ch, sw, fr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
            if fr != SR:                                     # other rates: ffmpeg resamples, as for training examples
                return None
            n = min(n, int(fr * MAX_AUDIO_S * 3))
            raw = w.readframes(n)
    except Exception:  # noqa: BLE001  (compressed or unusual WAV: ffmpeg reads it)
        return None
    if sw == 2:
        x = np.frombuffer(raw, "<i2").astype(np.float32) / 32768.0
    elif sw == 1:
        x = (np.frombuffer(raw, np.uint8).astype(np.float32) - 128.0) / 128.0
    elif sw == 4:
        x = np.frombuffer(raw, "<i4").astype(np.float32) / 2147483648.0
    else:
        return None
    if ch > 1:
        x = x[:x.size // ch * ch].reshape(-1, ch).mean(1)
    return np.ascontiguousarray(x, np.float32)


def decode_audio(data):
    """Any file ffmpeg can read -> mono float32 at 16 kHz (CPU: plain WAV directly, everything else ffmpeg)."""
    x = _wav_fast(data)
    if x is not None and x.size:
        return x
    p = subprocess.run(["ffmpeg", "-v", "error", "-i", "pipe:0", "-t", str(MAX_AUDIO_S * 3), "-ac", "1", "-ar", str(SR),
                        "-f", "f32le", "pipe:1"], input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0 or not p.stdout:
        raise ValueError("could not read that audio: " + p.stderr.decode("utf-8", "replace")[-200:])
    return np.frombuffer(p.stdout, np.float32).copy()


def _trim(x):
    """Cut leading/trailing silence (frames more than 35 dB below the loudest), keep 60 ms either side."""
    n = x.size // HOP
    if n < 3:
        return x
    e = 10 * np.log10((x[:n * HOP].reshape(n, HOP) ** 2).mean(1) + 1e-10)
    act = np.flatnonzero(e > e.max() - 35)
    a, b = max(0, act[0] - 6), min(n, act[-1] + 7)
    y = x[a * HOP:b * HOP]
    return y[:int(MAX_AUDIO_S * SR)]


def audio_frames(x):
    """log-mel spectrogram, 32 bands x 10 ms frames, per-band mean removed. GPU: framing, FFT, filterbank."""
    x = _trim(np.asarray(x, np.float32))
    if x.size < WIN + HOP:
        x = np.pad(x, (0, WIN + HOP - x.size))

    def job():
        g = cp.asarray(x)
        n = 1 + (g.size - WIN) // HOP
        idx = cp.arange(WIN, dtype=cp.int32)[None, :] + HOP * cp.arange(n, dtype=cp.int32)[:, None]
        fr = g[idx] * cp.hanning(WIN).astype(cp.float32)[None, :]
        pw = cp.abs(cp.fft.rfft(fr, NFFT, axis=1)) ** 2
        lm = cp.log(pw.astype(cp.float32) @ cp.asarray(FB).T + 1e-6)
        lm = lm - lm.mean(0, keepdims=True)
        lm = lm / (lm.std() + 1e-5)
        return cp.asnumpy(lm.astype(cp.float32))
    return engine.run_on_gpu(job, "reservoir: audio features", 60)


def decode_image(data):
    im = Image.open(io.BytesIO(data))
    im.load()
    return im


def image_frames(im):
    """Grey 32 x 32 (aspect kept, padded), scanned as 32 rows then 32 columns -> 64 steps of 32 values."""
    g = im.convert("L")
    g.thumbnail((IMG, IMG), Image.LANCZOS)
    canvas = Image.new("L", (IMG, IMG), int(np.median(np.asarray(g))))
    canvas.paste(g, ((IMG - g.size[0]) // 2, (IMG - g.size[1]) // 2))
    a = np.asarray(canvas, np.float32) / 255.0
    a = (a - a.mean()) / (a.std() + 1e-5)
    return np.concatenate([a, a.T], 0).astype(np.float32), canvas


def number_frames(vals):
    v = np.asarray([float(x) for x in vals if np.isfinite(float(x))], np.float64)
    if v.size < 4:
        raise ValueError("a sequence needs at least 4 numbers")
    if v.size > MAX_STEPS:
        v = np.interp(np.linspace(0, v.size - 1, MAX_STEPS), np.arange(v.size), v)
    z = (v - v.mean()) / (v.std() + 1e-9)
    d = np.r_[0, np.diff(z)]
    d = d / (d.std() + 1e-9)
    return np.stack([z, d], 1).astype(np.float32)


def parse_numbers(text):
    out = []
    for tok in str(text).replace(",", " ").replace(";", " ").replace("\t", " ").split():
        try:
            out.append(float(tok))
        except ValueError:
            continue
    return out


# ---------------------------------------------------------------- the reservoirs (GPU)
def _key(res, D):
    keys = ["type", "units", "leak", "radius", "input_scale", "density", "snapshots", "seed"]
    if res["type"] == "ripple":
        keys = ["type", "ripple_grid", "ripple_damp", "ripple_nl", "substeps", "input_scale", "snapshots", "seed"]
    return json.dumps([RES_VER] + [res[k] for k in keys] + [D])


def _esn_weights(res, D):
    rs = np.random.RandomState(res["seed"])
    N = res["units"]
    W = rs.standard_normal((N, N)).astype(np.float32) * (rs.random_sample((N, N)) < res["density"])
    W *= res["radius"] / math.sqrt(N * res["density"])          # circular law: spectral radius ~ res["radius"]
    Win = (rs.random_sample((N, D)).astype(np.float32) * 2 - 1) * res["input_scale"]
    b = (rs.random_sample(N).astype(np.float32) * 2 - 1) * 0.2
    return W, Win, b


def _ripple_weights(res, D):
    rs = np.random.RandomState(res["seed"])
    G = res["ripple_grid"]
    yy, xx = np.mgrid[0:G, 0:G].astype(np.float32)
    P = np.zeros((D, G, G), np.float32)
    for d in range(D):                                           # each input channel pushes the water at its own spot
        cy, cx = rs.uniform(G * 0.15, G * 0.85, 2)
        P[d] = np.exp(-((yy - cy) ** 2 + (xx - cx) ** 2) / (2 * 1.6 ** 2))
    P *= res["input_scale"] * 0.6
    return P.reshape(D, G * G)


def _segments(lengths, T, K):
    S = np.full((len(lengths), T), -1, np.int32)
    for i, L in enumerate(lengths):
        t = np.arange(L)
        S[i, :L] = np.minimum(K - 1, (t * K) // max(L, 1))
    return S


def _pool(G, P):
    """average-pool a (B, G, G) field down by P."""
    B, n, _ = G.shape
    return G.reshape(B, n // P, P, n // P, P).mean((2, 4))


def reservoir_features(seqs, res, trace_index=None):
    """seqs: list of (T_i, D) arrays -> (features (B, F_res), raw input summary (B, K*D), trace for one example).
    Must run inside a GPU job. Batched: every example rings through the same reservoir at once."""
    K = res["snapshots"]
    D = seqs[0].shape[1]
    lengths = [min(MAX_STEPS, s.shape[0]) for s in seqs]
    T = max(lengths)
    B = len(seqs)
    U = np.zeros((B, T, D), np.float32)
    for i, s in enumerate(seqs):
        U[i, :lengths[i]] = s[:lengths[i]]
    S = cp.asarray(_segments(lengths, T, K))
    Ug = cp.asarray(U)
    kr = cp.arange(K, dtype=cp.int32)[None, :]
    raw = cp.zeros((B, K, D), cp.float32)
    cnt = cp.zeros((B, K), cp.float32)
    trace = []
    if res["type"] == "esn":
        W, Win, b = (cp.asarray(a) for a in _esn_weights(res, D))
        N = W.shape[0]
        O_all = (S[:, :, None] == kr[None]).astype(cp.float32)          # (B, T, K): which snapshot each step feeds
        raw = cp.matmul(O_all.transpose(0, 2, 1), Ug)                    # (B, K, D) input summary, one batched product
        cnt = O_all.sum(1)
        F, tr_full = _esn_run(W, Win, b, Ug, S, K, res["leak"], trace_index)
        if trace_index is not None:
            trace = [tr_full[t] for t in range(lengths[trace_index])]
        side = int(round(math.sqrt(N)))
    else:
        P = cp.asarray(_ripple_weights(res, D))
        G = res["ripple_grid"]
        O_all = (S[:, :, None] == kr[None]).astype(cp.float32)
        raw = cp.matmul(O_all.transpose(0, 2, 1), Ug)
        cnt = O_all.sum(1)
        F, tr_full = _ripple_run(P, Ug, S, K, G, res, trace_index)
        if trace_index is not None:
            trace = [tr_full[t] for t in range(lengths[trace_index])]
        F = F.reshape(B, K, 2 * 256)
        side = 16
    cnt = cp.maximum(cnt, 1)
    F = F / cnt[:, :, None]
    raw = raw / cnt[:, :, None]
    tr = None
    if trace:
        tr = cp.asnumpy(cp.stack(trace))
    return cp.asnumpy(F.reshape(B, -1)), cp.asnumpy(raw.reshape(B, -1)), tr, side


# The ripple tank, fused the same way: one block per sequence holds its whole water surface (u height, v speed) in
# shared memory and runs a span of input steps, each with its substeps, then adds the 16 x 16 pooled height and
# energy to the snapshot. Identical maths to the old CuPy loop (periodic neighbours, the soft walls, the bounded
# stiffening), without ~15 kernel launches per substep.
_RIPPLE_SRC = r"""
extern "C" __global__ void ripple_span(const float* __restrict__ P, const float* __restrict__ U, float* Ug, float* Vg,
    float* F, const int* __restrict__ S, float* trace, const float* __restrict__ edge, const int trace_b, const int T,
    const int D, const int t0, const int tc, const int G, const int K, const int sub, const float damp, const float nl,
    const float c2, const float dt) {
  extern __shared__ float sh[];
  const int GG = G * G, b = blockIdx.x, tid = threadIdx.x, nt = blockDim.x, pool = G / 16;
  float* u = sh; float* v = sh + GG;
  for (int c = tid; c < GG; c += nt) { u[c] = Ug[(size_t)b * GG + c]; v[c] = Vg[(size_t)b * GG + c]; }
  __syncthreads();
  float push[8];
  for (int s = 0; s < tc; s++) {
    const int t = t0 + s;
    const float* ut = U + ((size_t)b * T + t) * D;
    for (int j = 0, c = tid; c < GG; j++, c += nt) {
      float a = 0.f;
      for (int d = 0; d < D; d++) a += ut[d] * P[(size_t)d * GG + c];
      push[j] = a;
    }
    for (int q = 0; q < sub; q++) {
      float nv[8];
      for (int j = 0, c = tid; c < GG; j++, c += nt) {
        const int y = c / G, x = c - y * G;
        const float uc = u[c];
        const float lap = u[((y + 1) % G) * G + x] + u[((y + G - 1) % G) * G + x] + u[y * G + (x + 1) % G] + u[y * G + (x + G - 1) % G] - 4.f * uc;
        const float uu = uc * uc;
        nv[j] = (v[c] + dt * (c2 * lap - nl * uc * uu / (1.f + uu)) + push[j] / sub) * (1.f - damp) * edge[c];
      }
      __syncthreads();
      for (int j = 0, c = tid; c < GG; j++, c += nt) { v[c] = nv[j]; u[c] = (u[c] + dt * nv[j]) * edge[c]; }
      __syncthreads();
    }
    const int k = S[(size_t)b * T + t];
    if (k >= 0) {
      for (int o = tid; o < 512; o += nt) {
        const int w = o >> 8, py = (o & 255) >> 4, px = o & 15;
        float acc = 0.f;
        for (int yy = 0; yy < pool; yy++) for (int xx = 0; xx < pool; xx++) {
          const float h = u[(py * pool + yy) * G + px * pool + xx];
          acc += w ? h * h : h;
        }
        F[((size_t)b * K + k) * 512 + o] += acc / (pool * pool);
      }
    }
    if (b == trace_b) for (int c = tid; c < GG; c += nt) trace[(size_t)t * GG + c] = u[c];
    __syncthreads();
  }
  for (int c = tid; c < GG; c += nt) { Ug[(size_t)b * GG + c] = u[c]; Vg[(size_t)b * GG + c] = v[c]; }
}
"""
_ripple_kernel = None
RIPPLE_BASE_CELLSTEPS = 1e8     # cell-substeps per launch on the K420 (~0.35 s, scaled from a K1200 run); scaled up on faster cards


def _ripple_run(P, Ug, S, K, G, res, trace_index=None):
    """P (D, G*G) input pushes, Ug (B, T, D), S (B, T) -> F (B, K, 2, 16, 16) sums, trace (T, G, G) of one sequence."""
    global _ripple_kernel
    from . import cards
    if _ripple_kernel is None:
        _ripple_kernel = cp.RawKernel(_RIPPLE_SRC, "ripple_span")
    B, T, D = Ug.shape
    GG = G * G
    if GG > 8 * 1024 or G % 16:
        raise ValueError("the ripple tank grid must be a multiple of 16 and at most 90 cells wide")
    r = cp.arange(G, dtype=cp.float32)
    dist = cp.minimum(cp.minimum(r, G - 1 - r)[None, :], cp.minimum(r, G - 1 - r)[:, None])
    edge = cp.ascontiguousarray((cp.clip(dist / 6.0, 0, 1) ** 0.5).astype(cp.float32))
    u = cp.zeros((B, GG), cp.float32)
    v = cp.zeros((B, GG), cp.float32)
    F = cp.zeros((B, K, 2, 16, 16), cp.float32)
    tb = -1 if trace_index is None else int(trace_index)
    trace = cp.zeros((T if tb >= 0 else 1, G, G), cp.float32)
    Uc = cp.ascontiguousarray(Ug, dtype=cp.float32)
    Sc = cp.ascontiguousarray(S.astype(cp.int32))
    Pc = cp.ascontiguousarray(P, dtype=cp.float32)
    sub = int(res["substeps"])
    span = max(1, int(cards.launch_budget(RIPPLE_BASE_CELLSTEPS) // max(1, B * GG * sub)))
    for t0 in range(0, T, span):
        tc = min(span, T - t0)
        _ripple_kernel((B,), (1024,), (Pc, Uc, u, v, F, Sc, trace, edge, np.int32(tb), np.int32(T), np.int32(D),
                                       np.int32(t0), np.int32(tc), np.int32(G), np.int32(K), np.int32(sub),
                                       np.float32(res["ripple_damp"]), np.float32(res["ripple_nl"]), np.float32(0.2),
                                       np.float32(1.0)), shared_mem=2 * GG * 4)
    return F, (trace if tb >= 0 else None)


def series_states(Uin, res):
    """One long multichannel series through the ESN, one state per time step (forecasting). Inside a GPU job."""
    D = Uin.shape[1]
    W, Win, b = (cp.asarray(a) for a in _esn_weights(dict(res, type="esn"), D))
    T = Uin.shape[0]
    Ug = cp.asarray(Uin.astype(np.float32))[None]
    S = cp.full((1, T), -1, cp.int32)
    _, tr = _esn_run(W, Win, b, Ug, S, 1, res["leak"], 0)
    return cp.asnumpy(tr)


# The echo network, fused: one CUDA block per sequence, one thread per unit, the state in shared memory. Each launch
# runs a span of time steps (x <- (1-a) x + a tanh(W x + Win u + b)) and adds each step's state to its snapshot. The
# old loop launched ~6 small kernels per step; this launches one kernel per span. The span is sized to the card
# (cards.launch_budget) so a launch stays far inside a display watchdog; the state is carried between launches.
_ESN_SRC = r"""
extern "C" __global__ void esn_span(const float* __restrict__ WT, const float* __restrict__ drive, float* X, float* F,
    const int* __restrict__ S, float* trace, const int trace_b, const int T, const int t0, const int tc, const int N,
    const int K, const float a) {
  extern __shared__ float xs[];
  const int b = blockIdx.x, i = threadIdx.x;
  float x = i < N ? X[(size_t)b * N + i] : 0.f;
  for (int s = 0; s < tc; s++) {
    const int t = t0 + s;
    if (i < N) xs[i] = x;
    __syncthreads();
    if (i < N) {
      float acc = drive[((size_t)b * tc + s) * N + i];
      for (int j = 0; j < N; j++) acc += xs[j] * WT[(size_t)j * N + i];
      x = (1.f - a) * x + a * tanhf(acc);
      const int k = S[(size_t)b * T + t];
      if (k >= 0) F[((size_t)b * K + k) * N + i] += x;
      if (b == trace_b) trace[(size_t)t * N + i] = x;
    }
    __syncthreads();
  }
  if (i < N) X[(size_t)b * N + i] = x;
}
"""
_esn_kernel = None
ESN_BASE_MACS = 2e9          # multiply-adds per launch on the K420 (~0.2 s, scaled from a K1200 run); scaled up on faster cards


def _esn_run(W, Win, b, Ug, S, K, leak, trace_index=None):
    """Ug (B, T, D) inputs, S (B, T) snapshot index or -1 -> F (B, K, N) state sums, trace (T, N) of one sequence."""
    global _esn_kernel
    from . import cards
    if _esn_kernel is None:
        _esn_kernel = cp.RawKernel(_ESN_SRC, "esn_span")
    B, T, D = Ug.shape
    N = W.shape[0]
    WT = cp.ascontiguousarray(W.T)
    WinT = cp.ascontiguousarray(Win.T)
    X = cp.zeros((B, N), cp.float32)
    F = cp.zeros((B, K, N), cp.float32)
    tb = -1 if trace_index is None else int(trace_index)
    trace = cp.zeros((T if tb >= 0 else 1, N), cp.float32)
    Sc = cp.ascontiguousarray(S.astype(cp.int32))
    span = max(1, int(cards.launch_budget(ESN_BASE_MACS, bound="memory") // max(1, B * N * N)))
    span = min(span, T, max(1, int(engine.budget_bytes(200) // 3 // max(1, B * N * 4))))   # the drive buffer must fit
    threads = int(min(1024, (N + 31) // 32 * 32))
    for t0 in range(0, T, span):
        tc = min(span, T - t0)
        drive = (Ug[:, t0:t0 + tc].reshape(B * tc, D) @ WinT + b).reshape(B, tc, N)   # 2-D product: fast on CuPy 9.6
        drive = cp.ascontiguousarray(drive, dtype=cp.float32)
        _esn_kernel((B,), (threads,), (WT, drive, X, F, Sc, trace, np.int32(tb), np.int32(T), np.int32(t0),
                                        np.int32(tc), np.int32(N), np.int32(K), np.float32(leak)), shared_mem=N * 4)
    return F, (trace if tb >= 0 else None)


# ---------------------------------------------------------------- the decision layer: ridge regression on the card
def _fit(Phi, Y, lam_rel):
    Z = cp.asarray(Phi)
    mu = Z.mean(0)
    sd = Z.std(0) + 1e-6
    Z = (Z - mu) / sd
    Yg = cp.asarray(Y)
    ym = Yg.mean(0)
    Yc = Yg - ym
    B, F = Z.shape
    lam = lam_rel * F
    if B <= F:                                                      # dual form: a B x B system
        A = Z @ Z.T + lam * cp.eye(B, dtype=cp.float32)
        W = Z.T @ cp.linalg.solve(A, Yc)
    else:
        A = Z.T @ Z + lam * cp.eye(F, dtype=cp.float32)
        W = cp.linalg.solve(A, Z.T @ Yc)
    return mu, sd, W, ym


def _predict(model, Phi):
    mu, sd, W, ym = model
    return ((cp.asarray(Phi) - mu) / sd) @ W + ym


LAMS = (1e-4, 1e-3, 1e-2, 1e-1, 1.0)


def _folds(y, k):
    rs = np.random.RandomState(0)
    fold = np.zeros(len(y), np.int32)
    for c in np.unique(y):
        idx = np.flatnonzero(y == c)
        rs.shuffle(idx)
        fold[idx] = np.arange(idx.size) % k
    return fold


def _cv(Phi, y, C, k):
    """Stratified k-fold accuracy for each ridge strength; returns (best lam, best acc, out-of-fold predictions)."""
    Y = np.eye(C, dtype=np.float32)[y]
    fold = _folds(y, k)
    best = None
    for lam in LAMS:
        pred = np.zeros(len(y), np.int32)
        for f in range(k):
            tr, te = fold != f, fold == f
            m = _fit(Phi[tr], Y[tr], lam)
            pred[te] = cp.asnumpy(_predict(m, Phi[te]).argmax(1))
        acc = float((pred == y).mean())
        if best is None or acc > best[1] + 1e-9:
            best = (lam, acc, pred)
    return best


def _binom_p(k, n, p0):
    """one-sided P(X >= k) for X ~ Binomial(n, p0): how likely this accuracy is by luck."""
    if n == 0:
        return 1.0
    s = 0.0
    lp0, lq0 = math.log(max(p0, 1e-12)), math.log(max(1 - p0, 1e-12))
    for i in range(k, n + 1):
        s += math.exp(math.lgamma(n + 1) - math.lgamma(i + 1) - math.lgamma(n - i + 1) + i * lp0 + (n - i) * lq0)
    return min(1.0, s)


# ---------------------------------------------------------------- pictures
def _png(a, scale=1, cmap="wave"):
    a = np.asarray(a, np.float32)
    lo, hi = np.percentile(a, 1), np.percentile(a, 99)
    if cmap == "wave":                                              # signed: blue below zero, red above
        m = max(abs(lo), abs(hi), 1e-9)
        t = np.clip(a / m, -1, 1)
        pos, neg = np.clip(t, 0, 1), np.clip(-t, 0, 1)
        rgb = np.stack([0.04 + 0.96 * pos + 0.12 * neg, 0.04 + 0.4 * pos ** 2 + 0.45 * neg ** 2, 0.06 + 0.92 * neg], -1)
    else:
        t = np.clip((a - lo) / (hi - lo + 1e-9), 0, 1)
        rgb = np.stack([t, t * 0.35 + t ** 3 * 0.65, t ** 2.2], -1) if cmap == "heat" else np.stack([t, t, t], -1)
    im = Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8))
    if scale != 1:
        im = im.resize((im.size[0] * scale, im.size[1] * scale), Image.NEAREST)
    b = io.BytesIO()
    im.save(b, "PNG")
    return "data:image/png;base64," + base64.b64encode(b.getvalue()).decode()


def _strip(vec, K, side, res_type):
    """A feature vector -> K small pictures side by side: what the decision layer actually sees."""
    if res_type == "ripple":
        f = vec.reshape(K, 2, 16, 16)[:, 0]
    else:
        n = side * side
        v = vec.reshape(K, -1)
        if v.shape[1] < n:
            v = np.pad(v, ((0, 0), (0, n - v.shape[1])))
        f = v[:, :n].reshape(K, side, side)
    gap = np.full((f.shape[1], 1), 0.0, np.float32)
    row = []
    for k in range(K):
        row += [f[k], gap]
    return np.concatenate(row[:-1], 1)


def _trace_png(tr, res_type):
    if tr is None or not len(tr):
        return None
    if res_type == "esn":                                          # units (rows) x time (columns)
        a = tr.T
        if a.shape[1] > 600:
            a = a[:, np.linspace(0, a.shape[1] - 1, 600).astype(int)]
        return _png(a, 1)
    idx = np.linspace(0, len(tr) - 1, 6).astype(int)              # ripple tank: six photographs of the surface
    G = tr.shape[1]
    gap = np.zeros((G, 2), np.float32)
    row = []
    for i in idx:
        row += [tr[i], gap]
    return _png(np.concatenate(row[:-1], 1), 2)


# ---------------------------------------------------------------- examples
def _frames_for(kind, payload):
    """payload: {"audio": float32 16 kHz} | {"image": PIL} | {"numbers": [...]} -> (frames, preview bytes, ext)."""
    if kind == "audio":
        x = payload["audio"]
        u = audio_frames(x)
        y = _trim(x)
        b = io.BytesIO()
        import wave
        with wave.open(b, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes((np.clip(y, -1, 1) * 32767).astype("<i2").tobytes())
        return u, b.getvalue(), "wav"
    if kind == "image":
        u, small = image_frames(payload["image"])
        b = io.BytesIO()
        th = payload["image"].convert("RGB")
        th.thumbnail((96, 96))
        th.save(b, "PNG")
        return u, b.getvalue(), "png"
    if kind == "numbers":
        vals = payload["numbers"]
        return number_frames(vals), json.dumps([float(v) for v in vals][:5000]).encode(), "json"
    raise ValueError("this project takes a series, not examples")


def add_example(pid, label, payload, source=""):
    label = str(label or "").strip()[:40]
    if not label:
        raise ValueError("give the example a label (the class it belongs to)")
    meta = _load(pid)
    u, prev, ext = _frames_for(meta["kind"], payload)
    eid = uuid.uuid4().hex[:10]
    d = _pdir(pid)
    np.save(os.path.join(d, "ex", eid + ".npy"), u)
    with open(os.path.join(d, "ex", eid + "." + ext), "wb") as f:
        f.write(prev)
    with LOCK:
        meta = _load(pid)
        meta["examples"].append({"id": eid, "label": label, "steps": int(u.shape[0]), "ext": ext, "source": source[:120],
                                 "added": time.time()})
        _save(meta)
    return {"id": eid, "label": label, "steps": int(u.shape[0])}


def delete_example(pid, eid):
    with LOCK:
        meta = _load(pid)
        meta["examples"] = [e for e in meta["examples"] if e["id"] != eid]
        _save(meta)
    for f in os.listdir(os.path.join(_pdir(pid), "ex")):
        if f.split(".")[0] == eid:
            os.remove(os.path.join(_pdir(pid), "ex", f))
    return {"deleted": eid}


def relabel(pid, eid, label):
    with LOCK:
        meta = _load(pid)
        for e in meta["examples"]:
            if e["id"] == eid:
                e["label"] = str(label).strip()[:40] or e["label"]
        _save(meta)
    return {"id": eid}


def example_file(pid, eid):
    meta = _load(pid)
    for e in meta["examples"]:
        if e["id"] == eid:
            return os.path.join(_pdir(pid), "ex", eid + "." + e["ext"]), e["ext"]
    raise KeyError(eid)


def _cached_features(pid, meta, job=None):
    """Reservoir features for every example, reusing the ones already computed with the same reservoir.
    job: a jobs.Job for progress and Cancel; each batch is its own GPU call, so other apps get the card in between."""
    d = _pdir(pid)
    exs = meta["examples"]
    if not exs:
        raise ValueError("add some examples first")
    seq0 = np.load(os.path.join(d, "ex", exs[0]["id"] + ".npy"))
    key = _key(meta["reservoir"], seq0.shape[1])
    cpath = os.path.join(d, "features.npz")
    have = {}
    if os.path.exists(cpath):
        z = np.load(cpath, allow_pickle=False)
        if str(z["key"]) == key:
            zF, zR = z["F"], z["R"]                                  # read each array once: z["F"] re-reads the file
            have = {e: (zF[i], zR[i]) for i, e in enumerate(z["ids"].tolist())}
    todo = [e for e in exs if e["id"] not in have]
    side = None
    if todo:
        seqs = [np.load(os.path.join(d, "ex", e["id"] + ".npy")) for e in todo]

        from . import cards
        bs = cards.launch_budget(256, cap=2048, bound="memory")       # bounded batches: memory; bigger on faster cards
        out_f, out_r = [], []
        for i in range(0, len(seqs), bs):
            if job:
                job.step(0.05 + 0.6 * i / len(seqs), "ring {} of {} examples through the reservoir".format(i, len(seqs)))
            F, R, _, side = engine.run_on_gpu(lambda i=i: reservoir_features(seqs[i:i + bs], meta["reservoir"]),
                                              "reservoir: ring {} examples".format(min(bs, len(seqs) - i)), 240)
            out_f.append(F)
            out_r.append(R)
        F, R = np.concatenate(out_f), np.concatenate(out_r)
        for i, e in enumerate(todo):
            have[e["id"]] = (F[i], R[i])
    ids = [e["id"] for e in exs]
    F = np.stack([have[i][0] for i in ids])
    R = np.stack([have[i][1] for i in ids])
    if todo or len(have) != len(ids):                            # write the cache only when it changed
        np.savez(cpath, key=np.array(key), ids=np.array(ids), F=F, R=R)
    if side is None:
        side = 16 if meta["reservoir"]["type"] == "ripple" else int(round(math.sqrt(meta["reservoir"]["units"])))
    return F, R, side


def _clip_ok(meta):
    if meta["kind"] != "image":
        return False
    try:
        from . import clip
        return clip.ready()
    except Exception:  # noqa: BLE001
        return False


def _clip_features(pid, meta):
    """CLIP ViT-B/32 embeddings of every image example (from its stored preview), cached by example id."""
    from . import clip
    d = _pdir(pid)
    cpath = os.path.join(d, "clip.npz")
    have = {}
    if os.path.exists(cpath):
        z = np.load(cpath, allow_pickle=False)
        zE = z["E"]
        have = {e: zE[i] for i, e in enumerate(z["ids"].tolist())}
    todo = [e for e in meta["examples"] if e["id"] not in have]
    if todo:
        ims = [Image.open(os.path.join(d, "ex", e["id"] + ".png")).convert("RGB") for e in todo]
        E = clip.embed_images(ims)
        for e, v in zip(todo, E):
            have[e["id"]] = v
    ids = [e["id"] for e in meta["examples"]]
    E = np.stack([have[i] for i in ids]).astype(np.float32)
    np.savez(cpath, ids=np.array(ids), E=E)
    return E


# ---------------------------------------------------------------- train / test (classification)
def train(pid, job=None):
    t0 = time.time()
    meta = _load(pid)
    if meta["task"] == "forecast":
        return train_forecast(pid, job)
    classes = sorted({e["label"] for e in meta["examples"]})
    if len(classes) < 2:
        raise ValueError("needs examples of at least two different labels")
    y = np.array([classes.index(e["label"]) for e in meta["examples"]], np.int32)
    counts = np.bincount(y, minlength=len(classes))
    F, R, side = _cached_features(pid, meta, job)
    res, K = meta["reservoir"], meta["reservoir"]["snapshots"]
    full = np.concatenate([F, R], 1)
    if job:
        job.step(0.7, "fit the decision layer and test it on held-out examples")
    k = int(min(5, counts.min()))
    E = _clip_features(pid, meta) if _clip_ok(meta) else None
    enc = "clip" if (E is not None and meta.get("encoder") == "clip") else "reservoir"
    feats = {"reservoir": full, "raw": R}
    if E is not None:
        feats["clip"] = E

    def job():
        out = {}
        if k >= 2:
            for name, Phi in feats.items():
                lam, acc, pred = _cv(Phi, y, len(classes), k)
                conf = np.zeros((len(classes), len(classes)), np.int32)
                for a, b in zip(y, pred):
                    conf[a, b] += 1
                out[name] = {"acc": acc, "lam": lam, "confusion": conf.tolist()}
        X = feats["clip"] if enc == "clip" else full
        lam = out[enc]["lam"] if out else 1e-2
        m = _fit(X, np.eye(len(classes), dtype=np.float32)[y], lam)
        train_acc = float((cp.asnumpy(_predict(m, X).argmax(1)) == y).mean())
        return out, tuple(cp.asnumpy(a) for a in m), train_acc
    cv, model, train_acc = engine.run_on_gpu(job, "reservoir: training the decision layer", 180)
    np.savez(os.path.join(_pdir(pid), "model.npz"), mu=model[0], sd=model[1], W=model[2], ym=model[3],
             classes=np.array(classes), key=np.array("clip" if enc == "clip" else _key(res, _dim(pid, meta))), nres=np.array(F.shape[1]))
    chance = float(counts.max() / counts.sum())
    n = int(len(y))
    rep = {"classes": classes, "counts": counts.tolist(), "n": n, "folds": k, "train_acc": train_acc, "chance": chance,
           "ms": round((time.time() - t0) * 1000, 1), "features": int(feats[enc if enc == "clip" else "reservoir"].shape[1]), "at": time.time(),
           "encoder": enc}
    if cv:
        rc = cv[enc]
        rep.update(cv=rc, raw=cv["raw"], p_value=_binom_p(int(round(rc["acc"] * n)), n, chance))
        if "clip" in cv:
            rep["clip"], rep["res"] = cv["clip"], cv["reservoir"]
        rep["summary"] = "{:.0%} cross-validated{} ({} examples, chance {:.0%})".format(rc["acc"], " with CLIP" if enc == "clip" else "", n, chance)
    else:
        rep["summary"] = "trained on {} examples (add 2+ per label for a real accuracy estimate)".format(n)
    # what the decision layer sees: one mean fingerprint per class, and the weights it learned per class
    nres = F.shape[1]
    rep["fingerprints"] = {c: _png(_strip(F[y == i].mean(0), K, side, res["type"]), 3) for i, c in enumerate(classes)}
    if enc == "reservoir":                                       # CLIP's 512 numbers aren't a picture of anything
        rep["weights"] = {c: _png(_strip(model[2][:nres, i] * model[1][:nres] ** -1, K, side, res["type"]), 3)
                          for i, c in enumerate(classes)}
    with LOCK:
        meta = _load(pid)
        meta["trained"] = rep
        _save(meta)
    return rep


def _dim(pid, meta):
    d = _pdir(pid)
    return int(np.load(os.path.join(d, "ex", meta["examples"][0]["id"] + ".npy"), mmap_mode="r").shape[1])


def test(pid, payload):
    t0 = time.time()
    meta = _load(pid)
    mp = os.path.join(_pdir(pid), "model.npz")
    if not os.path.exists(mp) or not meta.get("trained"):
        raise ValueError("press Train first")
    z = np.load(mp, allow_pickle=False)
    if str(z["key"]) == "clip":
        return _test_clip(pid, meta, z, payload, t0)
    u, prev, ext = _frames_for(meta["kind"], payload)
    if str(z["key"]) != _key(meta["reservoir"], u.shape[1]):
        raise ValueError("the reservoir settings changed since training: press Train again")
    res, K = meta["reservoir"], meta["reservoir"]["snapshots"]
    F_all, R_all, side = _cached_features(pid, meta)

    def job():
        F, R, tr, s_ = reservoir_features([u], res, trace_index=0)
        full = np.concatenate([F, R], 1)
        model = tuple(cp.asarray(z[k]) for k in ("mu", "sd", "W", "ym"))
        sc = cp.asnumpy(_predict(model, full))[0]
        A = (full - cp.asnumpy(model[0])) / cp.asnumpy(model[1])          # nearest training examples, for explanation
        Bm = (np.concatenate([F_all, R_all], 1) - cp.asnumpy(model[0])) / cp.asnumpy(model[1])
        sim = (Bm @ A[0]) / (np.linalg.norm(Bm, axis=1) * np.linalg.norm(A[0]) + 1e-9)
        return F[0], sc, tr, sim
    f, sc, tr, sim = engine.run_on_gpu(job, "reservoir: testing", 60)
    classes = [str(c) for c in z["classes"].tolist()]
    order = np.argsort(-sc)
    near = [{"id": meta["examples"][i]["id"], "label": meta["examples"][i]["label"], "sim": round(float(sim[i]), 3)}
            for i in np.argsort(-sim)[:5]]
    margin = float(sc[order[0]] - sc[order[1]]) if len(order) > 1 else 1.0
    return {"label": classes[order[0]], "scores": {classes[i]: round(float(sc[i]), 4) for i in range(len(classes))},
            "margin": round(margin, 4), "fingerprint": _png(_strip(f, K, side, res["type"]), 3), "input": _png(u.T, 2, "heat"),
            "waves": _trace_png(tr, res["type"]), "nearest": near, "steps": int(u.shape[0]),
            "ms": round((time.time() - t0) * 1000, 1)}


def infer_batch(pid, items, job=None):
    """Run the trained layer on many inputs at once. items: [(name, payload)]. Returns one row per input:
    the call, how sure it is, and every label's score. Inputs go through the card in batches (one GPU call each),
    so a big batch shows progress, can be cancelled and never blocks other apps."""
    t0 = time.time()
    meta = _load(pid)
    mp = os.path.join(_pdir(pid), "model.npz")
    if not os.path.exists(mp) or not meta.get("trained") or meta["task"] == "forecast":
        raise ValueError("press Train first")
    z = np.load(mp, allow_pickle=False)
    classes = [str(c) for c in z["classes"].tolist()]
    model_np = tuple(z[k] for k in ("mu", "sd", "W", "ym"))
    clip_mode = str(z["key"]) == "clip"
    rows, ready = [], []
    for i, (name, payload) in enumerate(items):
        if job and i % 16 == 0:
            job.step(0.02 + 0.3 * i / max(1, len(items)), "read {} of {} inputs".format(i, len(items)))
        try:
            if clip_mode:
                ready.append((len(rows), payload["image"].convert("RGB")))
            else:
                u, _, _ = _frames_for(meta["kind"], payload)
                if not ready and str(z["key"]) != _key(meta["reservoir"], u.shape[1]):
                    raise RuntimeError("the reservoir settings changed since training: press Train again")
                ready.append((len(rows), u))
            rows.append({"input": name})
        except (ValueError, KeyError) as e:
            rows.append({"input": name, "error": str(e)[:160]})
    from . import cards
    bs = cards.launch_budget(64, cap=1024, bound="memory")
    for k in range(0, len(ready), bs):
        part = ready[k:k + bs]
        if job:
            job.step(0.35 + 0.6 * k / max(1, len(ready)), "classify {} of {} inputs on the card".format(k, len(ready)))
        if clip_mode:
            from . import clip
            X = clip.embed_images([p for _, p in part])
        else:
            def ring(part=part):
                F, R, _, _ = reservoir_features([u for _, u in part], meta["reservoir"])
                return np.concatenate([F, R], 1)
            X = engine.run_on_gpu(ring, "reservoir: classify {} inputs".format(len(part)), 120)
        sc = engine.run_on_gpu(lambda X=X: cp.asnumpy(_predict(tuple(cp.asarray(a) for a in model_np), X)), "reservoir: classify", 60)
        for (ri, _), s_ in zip(part, sc):
            order = np.argsort(-s_)
            rows[ri].update({"label": classes[order[0]], "margin": round(float(s_[order[0]] - s_[order[1]]) if len(order) > 1 else 1.0, 4),
                             "scores": {classes[c]: round(float(s_[c]), 4) for c in range(len(classes))}})
    return {"classes": classes, "rows": rows, "n": len(rows), "failed": sum(1 for r in rows if "error" in r),
            "ms": round((time.time() - t0) * 1000, 1)}


def _test_clip(pid, meta, z, payload, t0):
    from . import clip
    im = payload["image"].convert("RGB")
    e = clip.embed_images([im])
    E = _clip_features(pid, meta)

    def job():
        model = tuple(cp.asarray(z[k]) for k in ("mu", "sd", "W", "ym"))
        return cp.asnumpy(_predict(model, e))[0]
    sc = engine.run_on_gpu(job, "reservoir: testing (CLIP)", 60)
    classes = [str(c) for c in z["classes"].tolist()]
    order = np.argsort(-sc)
    sim = E @ e[0]
    near = [{"id": meta["examples"][i]["id"], "label": meta["examples"][i]["label"], "sim": round(float(sim[i]), 3)} for i in np.argsort(-sim)[:5]]
    th = im.copy()
    th.thumbnail((256, 256))
    b = io.BytesIO()
    th.save(b, "PNG")
    return {"label": classes[order[0]], "scores": {classes[i]: round(float(sc[i]), 4) for i in range(len(classes))},
            "margin": round(float(sc[order[0]] - sc[order[1]]) if len(order) > 1 else 1.0, 4), "encoder": "clip",
            "input": "data:image/png;base64," + base64.b64encode(b.getvalue()).decode(), "waves": None, "fingerprint": None,
            "nearest": near, "steps": 1, "ms": round((time.time() - t0) * 1000, 1)}


def from_photos(ids, label, pid=None, name=None):
    """Photo Lab photos -> labelled examples in an image project (a new one unless pid is given)."""
    from . import media
    if not ids:
        raise ValueError("no photos given")
    if not pid:
        pid = create(name or "Photos: {}".format(label), "image")["id"]
    elif _load(pid)["kind"] != "image":
        raise ValueError("that project does not take images")
    n = 0
    for p in ids:
        f = media.photo_path(p, "proxy.jpg")
        f = f if os.path.exists(f) else media.photo_path(p, "thumb.jpg")
        if not os.path.exists(f):
            continue
        add_example(pid, label, {"image": Image.open(f)}, source="Photo Lab " + p)
        n += 1
    return {"id": pid, "n": n}


def peek(pid, eid):
    """The waves one stored example makes, and the snapshots the decision layer reads."""
    meta = _load(pid)
    u = np.load(os.path.join(_pdir(pid), "ex", eid + ".npy"))
    res, K = meta["reservoir"], meta["reservoir"]["snapshots"]

    def job():
        F, R, tr, side = reservoir_features([u], res, trace_index=0)
        return F[0], tr, side
    f, tr, side = engine.run_on_gpu(job, "reservoir: one example", 60)
    return {"input": _png(u.T, 2, "heat"), "waves": _trace_png(tr, res["type"]),
            "fingerprint": _png(_strip(f, K, side, res["type"]), 3), "steps": int(u.shape[0])}


# ---------------------------------------------------------------- forecasting a series (up or down over the horizon)
def set_series(pid, values, names=None, source="", dates=None):
    v = np.asarray(values, np.float64)
    if v.ndim == 1:
        v = v[:, None]
    ok = np.isfinite(v).all(1)
    v = v[ok]
    if v.shape[0] < 120:
        raise ValueError("a forecast needs at least 120 points (got {})".format(v.shape[0]))
    v = v[-20000:]
    d = _pdir(pid)
    np.save(os.path.join(d, "series.npy"), v)
    with LOCK:
        meta = _load(pid)
        dl = list(np.asarray(dates, dtype=object)[ok][-20000:]) if dates is not None else None
        meta["series"] = {"n": int(v.shape[0]), "channels": names or ["value"] + ["input {}".format(i) for i in range(1, v.shape[1])],
                          "source": source[:200], "first": dl[0] if dl else None, "last": dl[-1] if dl else None}
        meta["trained"] = None
        _save(meta)
    if dates is not None:
        with open(os.path.join(d, "dates.json"), "w") as f:
            json.dump([str(x) for x in dl], f)
    return public(meta)


def _series_inputs(v):
    """target in column 0, optional extra inputs after it -> per-step inputs (log returns when positive, else diffs)."""
    cols = []
    for j in range(v.shape[1]):
        c = v[:, j]
        r = np.diff(np.log(c)) if (c > 0).all() else np.diff(c)
        r = np.r_[0.0, r]
        cols.append(r)
    X = np.stack(cols, 1)
    return X


def train_forecast(pid, job=None):
    t0 = time.time()
    meta = _load(pid)
    sp = os.path.join(_pdir(pid), "series.npy")
    if not os.path.exists(sp):
        raise ValueError("load a series first")
    v = np.load(sp)
    fc, res = meta["forecast"], meta["reservoir"]
    h, lags, frac = fc["horizon"], fc["lags"], fc["train_frac"]
    X = _series_inputs(v)
    n = X.shape[0]
    cut = int(n * frac)
    sd = X[:cut].std(0) + 1e-12                                  # scale from the training part only (no peeking)
    U = (X / sd).astype(np.float32)
    if job:
        job.step(0.1, "ring the series through the reservoir")
    S = engine.run_on_gpu(lambda: series_states(U, res), "reservoir: ring the series", 240)
    if job:
        job.step(0.5, "fit the forecaster on the training span")
    target = v[:, 0]
    wash = max(50, lags + 1)
    t_idx = np.arange(wash, n - h)
    y = (target[t_idx + h] > target[t_idx]).astype(np.int32)
    lagf = np.stack([U[t_idx - i, 0] for i in range(lags)], 1)
    full = np.concatenate([S[t_idx], lagf], 1)
    tr = t_idx < cut - h                                         # labels of training points must end before the cut
    te = t_idx >= cut

    def job():
        out = {}
        for name, Phi in (("reservoir", full), ("raw", lagf)):
            best = None
            # choose ridge strength on the last 20% of the training span, never on the test span
            trn = np.flatnonzero(tr)
            k = int(len(trn) * 0.8)
            a, b = trn[:k], trn[k:]
            for lam in LAMS + (10.0, 100.0):                      # noisy targets: allow much stronger shrinkage
                m = _fit(Phi[a], np.eye(2, dtype=np.float32)[y[a]], lam)
                acc = float((cp.asnumpy(_predict(m, Phi[b]).argmax(1)) == y[b]).mean())
                if best is None or acc > best[1]:
                    best = (lam, acc)
            m = _fit(Phi[tr], np.eye(2, dtype=np.float32)[y[tr]], best[0])
            sc = cp.asnumpy(_predict(m, Phi))
            out[name] = (best[0], sc, tuple(cp.asnumpy(q) for q in m))
        return out
    out = engine.run_on_gpu(job, "reservoir: fit the forecaster", 180)
    yt = y[te]
    rep = {"n": int(n), "horizon": h, "lags": lags, "train_points": int(tr.sum()), "test_points": int(te.sum()),
           "up_rate_test": float(yt.mean()) if yt.size else None}
    for name in ("reservoir", "raw"):
        lam, sc, _ = out[name]
        pred = sc.argmax(1)
        acc = float((pred[te] == yt).mean())
        rep[name] = {"acc": acc, "lam": lam, "hits": int((pred[te] == yt).sum())}
    maj = max(rep["up_rate_test"], 1 - rep["up_rate_test"])
    last_move = (target[t_idx] > target[t_idx - h]).astype(np.int32)    # "it keeps going the way it just went"
    rep["baselines"] = {"always_majority": maj, "persistence": float((last_move[te] == yt).mean()),
                        "always_up": rep["up_rate_test"]}
    k = rep["reservoir"]["hits"]
    rep["p_value"] = _binom_p(k, int(te.sum()), maj)
    # NB: horizon > 1 makes neighbouring test labels overlap, so the effective number of independent tests is ~n/h
    rep["independent_tests"] = int(te.sum() // max(1, h))
    rep["p_value_independent"] = _binom_p(int(round(rep["reservoir"]["acc"] * rep["independent_tests"])),
                                          rep["independent_tests"], maj)
    # the call for the next period, from the latest state
    lam, sc, model = out["reservoir"]
    lastf = np.concatenate([S[-1:], np.stack([U[n - 1 - i, 0] for i in range(lags)])[None, :]], 1)
    s_last = cp.asnumpy(_predict(tuple(cp.asarray(q) for q in model), lastf))[0]
    rep["next"] = {"call": "up" if s_last[1] > s_last[0] else "down", "score": round(float(s_last[1] - s_last[0]), 4)}
    # chart data: the price, and the test-period calls (thinned to <= 1500 points)
    step = max(1, n // 1500)
    rep["chart"] = {"price": target[::step].round(6).tolist(), "step": step, "cut": cut,
                    "calls": [[int(t), int(p), int(a)] for t, p, a in zip(t_idx[te][::max(1, te.sum() // 600)],
                                                                         sc.argmax(1)[te][::max(1, te.sum() // 600)],
                                                                         yt[::max(1, te.sum() // 600)])]}
    rep["ms"] = round((time.time() - t0) * 1000, 1)
    rep["at"] = time.time()
    beat = rep["reservoir"]["acc"] - max(maj, rep["baselines"]["persistence"])
    rep["summary"] = "{:.1%} on {} unseen periods vs {:.1%} for the best simple rule".format(
        rep["reservoir"]["acc"], int(te.sum()), max(maj, rep["baselines"]["persistence"]))
    rep["verdict"] = ("beats the simple rules, and luck is an unlikely explanation" if beat > 0.01 and rep["p_value_independent"] < 0.05
                      else "no reliable edge over the simple rules — treat the call as a coin flip" if beat <= 0.01
                      else "slightly ahead of the simple rules, but that could easily be luck")
    with LOCK:
        meta = _load(pid)
        meta["trained"] = rep
        _save(meta)
    return rep


def fetch_ticker(symbol, years=10):
    sym = "".join(c for c in symbol.upper() if c.isalnum() or c in ".-^=")[:16]
    url = "https://query1.finance.yahoo.com/v8/finance/chart/{}?range={}y&interval=1d".format(sym, int(years))
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (VectorFall)"})
    d = json.loads(urllib.request.urlopen(req, timeout=30).read().decode())
    r = (d.get("chart") or {}).get("result")
    if not r:
        raise ValueError("no data for " + sym)
    r = r[0]
    adj = (r["indicators"].get("adjclose") or [{}])[0].get("adjclose") or r["indicators"]["quote"][0]["close"]
    vol = r["indicators"]["quote"][0].get("volume")
    ts = r["timestamp"]
    rows = [(time.strftime("%Y-%m-%d", time.gmtime(t)), p, q) for t, p, q in zip(ts, adj, vol or [None] * len(ts))
            if p is not None]
    return sym, rows


# ---------------------------------------------------------------- demo datasets (real data, downloaded once)
CACHE = os.path.join(ROOT, "_cache")


def _get(url):
    os.makedirs(CACHE, exist_ok=True)
    p = os.path.join(CACHE, url.split("/")[-1].split("?")[0])
    if not os.path.exists(p):
        req = urllib.request.Request(url, headers={"User-Agent": "VectorFall/1.0 (homelab)"})
        data = urllib.request.urlopen(req, timeout=60).read()
        with open(p + ".tmp", "wb") as f:
            f.write(data)
        os.replace(p + ".tmp", p)
    with open(p, "rb") as f:
        return f.read()


def demo(which, job=None):
    if which == "digits-spoken":
        meta = create("Spoken digits (FSDD)", "audio")
        base = "https://raw.githubusercontent.com/Jakobovski/free-spoken-digit-dataset/master/recordings/"
        names = ["{}_{}_{}.wav".format(d, s, i) for d in range(10) for s in ("jackson", "nicolas", "theo") for i in range(8)]
        done = [0]

        def one(nm):
            data = _get(base + nm)
            done[0] += 1
            if job and done[0] % 10 == 0:
                job.step(done[0] / len(names) * 0.9, "downloaded {} of {} clips".format(done[0], len(names)))
            return nm, decode_audio(data)
        with ThreadPoolExecutor(8) as ex:
            clips = list(ex.map(one, names))
        for nm, x in clips:
            add_example(meta["id"], nm.split("_")[0], {"audio": x}, source="FSDD " + nm)
        return {"id": meta["id"], "n": len(clips)}
    if which == "digits-written":
        meta = create("Handwritten digits (MNIST)", "image")
        im = np.frombuffer(gzip.decompress(_get("https://storage.googleapis.com/cvdf-datasets/mnist/t10k-images-idx3-ubyte.gz")), np.uint8)[16:].reshape(-1, 28, 28)
        lb = np.frombuffer(gzip.decompress(_get("https://storage.googleapis.com/cvdf-datasets/mnist/t10k-labels-idx1-ubyte.gz")), np.uint8)[8:]
        per = {d: 0 for d in range(10)}
        k = 0
        for i in range(len(lb)):
            d = int(lb[i])
            if per[d] >= 40:
                continue
            per[d] += 1
            add_example(meta["id"], str(d), {"image": Image.fromarray(im[i])}, source="MNIST test #{}".format(i))
            k += 1
            if job and k % 40 == 0:
                job.step(k / 400, "{} of 400 images".format(k))
            if k >= 400:
                break
        return {"id": meta["id"], "n": k}
    if which == "spy":
        meta = create("SPY: up or down in 5 days", "series")
        sym, rows = fetch_ticker("SPY", 10)
        set_series(meta["id"], [[r[1]] for r in rows], ["SPY adjusted close"], "Yahoo Finance daily, 10 years",
                   [r[0] for r in rows])
        return {"id": meta["id"], "n": len(rows)}
    raise ValueError("unknown demo")


# ---------------------------------------------------------------- API
def _http(fn, *a, **k):
    try:
        return fn(*a, **k)
    except KeyError as e:
        raise HTTPException(404, "not found: {}".format(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


def _payload(kind, file=None, body=None):
    body = body or {}
    if kind == "audio":
        if file is not None:
            return {"audio": decode_audio(file)}
        if body.get("pcm16k"):
            x = np.frombuffer(base64.b64decode(body["pcm16k"]), np.float32).copy()
            if x.size < SR * 0.15:
                raise ValueError("that recording is too short")
            return {"audio": x}
    if kind == "image":
        if file is not None:
            return {"image": decode_image(file)}
        if body.get("image"):
            return {"image": decode_image(base64.b64decode(body["image"].split(",", 1)[-1]))}
    if kind == "numbers":
        vals = body.get("numbers")
        if isinstance(vals, str) or vals is None:
            vals = parse_numbers(vals if vals is not None else (file or b"").decode("utf-8", "replace"))
        return {"numbers": vals}
    raise ValueError("no input given")


@router.get("/projects")
def api_list():
    return list_projects()


@router.post("/projects")
def api_create(body: dict):
    return _http(lambda: public(create(body.get("name"), body.get("kind"))))


@router.get("/projects/{pid}")
def api_get(pid: str):
    return _http(lambda: public(_load(pid)))


@router.patch("/projects/{pid}")
def api_update(pid: str, body: dict):
    return _http(update, pid, body)


@router.delete("/projects/{pid}")
def api_delete(pid: str):
    return _http(delete, pid)


@router.post("/projects/{pid}/examples")
async def api_add_file(pid: str, label: str = Form(...), file: UploadFile = File(...)):
    data = await file.read()
    kind = _http(_load, pid)["kind"]
    return await engine_thread(lambda: _http(lambda: add_example(pid, label, _payload(kind, file=data), file.filename or "")))


@router.post("/projects/{pid}/examples/json")
async def api_add_json(pid: str, body: dict):
    kind = _http(_load, pid)["kind"]
    return await engine_thread(lambda: _http(lambda: add_example(pid, body.get("label"), _payload(kind, body=body),
                                                                 body.get("source") or "")))


@router.delete("/projects/{pid}/examples/{eid}")
def api_del_example(pid: str, eid: str):
    return _http(delete_example, pid, eid)


@router.patch("/projects/{pid}/examples/{eid}")
def api_relabel(pid: str, eid: str, body: dict):
    return _http(relabel, pid, eid, body.get("label"))


@router.get("/projects/{pid}/examples/{eid}/file")
def api_example_file(pid: str, eid: str):
    from fastapi.responses import FileResponse
    path, ext = _http(example_file, pid, eid)
    return FileResponse(path, media_type={"wav": "audio/wav", "png": "image/png", "json": "application/json"}[ext])


@router.get("/projects/{pid}/examples/{eid}/peek")
async def api_peek(pid: str, eid: str):
    return await engine_thread(lambda: _http(peek, pid, eid))


@router.post("/projects/{pid}/train")
async def api_train(pid: str):
    return await engine_thread(lambda: _http(train, pid))


@router.post("/projects/{pid}/train/job")
def api_train_job(pid: str):
    """Train as a background job: progress in the job pill, and POST /api/jobs/<id>/cancel stops it."""
    meta = _http(_load, pid)
    j = jobs.start("reservoir", "Reservoir Lab: train " + str(meta.get("name") or ""), lambda job: train(pid, job))
    return {"job": j.id}


@router.post("/projects/{pid}/infer")
async def api_infer(pid: str, request: Request):
    """Batch inference: a multipart upload of files (field "files"), or JSON {"numbers": "one sequence per line"}.
    Runs as a job; the result has one row per input."""
    meta = _http(_load, pid)
    kind = meta["kind"]
    items = []
    if request.headers.get("content-type", "").startswith("multipart/"):
        form = await request.form()
        for k, f in form.multi_items():
            if k == "files" and hasattr(f, "filename"):
                data = await f.read()
                items.append((f.filename or "input", data))
    else:
        body = await request.json()
        lines = [ln for ln in str(body.get("numbers") or "").splitlines() if ln.strip()]
        items = [("line {}".format(i + 1), ln) for i, ln in enumerate(lines)]
    if not items:
        raise HTTPException(400, "no inputs: drop files, or paste one sequence on each line")
    if len(items) > 5000:
        raise HTTPException(413, "at most 5,000 inputs in one batch")

    def run(job):
        parsed, bad = [], []

        def parse(it):
            name, raw = it
            try:
                return name, (_payload(kind, file=raw) if isinstance(raw, bytes) else _payload(kind, body={"numbers": raw})), None
            except Exception as e:  # noqa: BLE001
                return name, None, str(e)[:160]
        with ThreadPoolExecutor(2) as ex:
            for i, (name, pl, err) in enumerate(ex.map(parse, items)):
                if i % 32 == 0:
                    job.step(0.02 * i / len(items), "read {} of {} inputs".format(i, len(items)))
                if err:
                    bad.append({"input": name, "error": err})
                else:
                    parsed.append((name, pl))
        out = infer_batch(pid, parsed, job)
        out["rows"] += bad
        out["n"] += len(bad)
        out["failed"] += len(bad)
        return out
    j = jobs.start("reservoir", "Reservoir Lab: classify {} inputs".format(len(items)), run)
    return {"job": j.id}


@router.post("/projects/{pid}/test")
async def api_test_file(pid: str, file: UploadFile = File(...)):
    data = await file.read()
    kind = _http(_load, pid)["kind"]
    return await engine_thread(lambda: _http(lambda: test(pid, _payload(kind, file=data))))


@router.post("/projects/{pid}/test/json")
async def api_test_json(pid: str, body: dict):
    kind = _http(_load, pid)["kind"]
    return await engine_thread(lambda: _http(lambda: test(pid, _payload(kind, body=body))))


@router.post("/projects/{pid}/series")
async def api_series(pid: str, body: dict):
    def go():
        if body.get("ticker"):
            sym, rows = fetch_ticker(body["ticker"], int(body.get("years") or 10))
            return set_series(pid, [[r[1]] + ([r[2] or 0] if body.get("with_volume") else []) for r in rows],
                              [sym + " adjusted close"] + ([sym + " volume"] if body.get("with_volume") else []),
                              "Yahoo Finance daily, {} years".format(int(body.get("years") or 10)), [r[0] for r in rows])
        if body.get("table"):
            from . import sources                               # date-sorted and gap-filled, like every other tool
            cols = [body["target"]] + [c for c in (body.get("inputs") or []) if c != body["target"]]
            s = sources.series(body["table"], cols, body.get("date_col", "auto"))
            return set_series(pid, s["values"], cols, "Data Desk: " + str(s["table"]), s["labels"])
        vals = parse_numbers(body.get("numbers") or "")
        return set_series(pid, vals, ["value"], "pasted")
    return await engine_thread(lambda: _http(go))


@router.get("/projects/{pid}/series")
def api_series_get(pid: str):
    def go():
        v = np.load(os.path.join(_pdir(pid), "series.npy"))
        step = max(1, v.shape[0] // 1500)
        return {"values": v[::step, 0].round(6).tolist(), "step": step, "n": int(v.shape[0])}
    return _http(go)


@router.post("/from-photos")
async def api_from_photos(body: dict):
    return await engine_thread(lambda: _http(from_photos, list(body.get("ids") or []), str(body.get("label") or "").strip(),
                                             body.get("project") or None, body.get("name") or None))


@router.post("/demo/{which}")
def api_demo(which: str):
    j = jobs.start("reservoir", "Reservoir Lab: load a demo dataset", lambda job: demo(which, job))
    return {"job": j.id}


async def engine_thread(fn):
    import asyncio
    import functools
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, functools.partial(fn))
