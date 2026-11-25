"""Lineage: this card against history's fastest computers.

Two parts:
- an HPL-style LINPACK on the card (FP64 and FP32): a dense random system Ax = b, a blocked right-looking LU with
  partial pivoting written over cuBLAS GEMM and a few small kernels, a blocked triangular solve, and the HPL residual
  check. GFLOP/s = (2/3 n^3 + 3/2 n^2) / t, the formula HPL reports. No cuSOLVER: its dense factorizations are
  very slow on Kepler. Every GEMM is cut into launches short enough for a display watchdog.
- the history data (app/lineage_data.json: every TOP500 #1 since June 1993, the #500 entry of every list, and the
  pre-1993 record holders with published LINPACK figures) and the comparison: the last list where this card would
  have been #1, its estimated rank on each list, and the last list it would still have made.
"""
import json
import math
import os
import re
import threading
import time

from fastapi import APIRouter

from . import engine, gpu
from . import registry as R

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(HERE, "lineage_data.json")
CACHE_DIR = os.path.join(os.path.expanduser(os.environ.get("VF_DATA", "/srv/data")), "lineage")
EPS = {"fp64": 2.0 ** -53, "fp32": 2.0 ** -24}           # unit round-off, as HPL uses it
ITEM = {"fp64": 8, "fp32": 4}
WATCHDOG_S = 0.25        # the longest single GEMM launch on a card with a display watchdog
MAX_RUN_S = {"auto": 45.0, "quick": 4.0}

_DATA = None
_CANCEL = threading.Event()


def data():
    global _DATA
    if _DATA is None:
        with open(DATA_FILE, encoding="utf-8") as f:
            _DATA = json.load(f)
    return _DATA


# ================================================================ the benchmark
_KSRC = r"""
typedef %(T)s T;
extern "C" __global__ void pivswap(T* A, const long long n, const long long j, int* piv, int* bad) {
  // one block: find the largest |A[i, j]| for i >= j, then swap rows j and p across the whole matrix
  __shared__ T sv[1024];
  __shared__ long long si[1024];
  const int t = threadIdx.x;
  T best = -1; long long bi = j;
  for (long long i = j + t; i < n; i += blockDim.x) { T v = fabs(A[i * n + j]); if (v > best) { best = v; bi = i; } }
  sv[t] = best; si[t] = bi;
  __syncthreads();
  for (int s = blockDim.x / 2; s > 0; s >>= 1) {
    if (t < s && (sv[t + s] > sv[t] || (sv[t + s] == sv[t] && si[t + s] < si[t]))) { sv[t] = sv[t + s]; si[t] = si[t + s]; }
    __syncthreads();
  }
  const long long p = si[0];
  if (t == 0) { piv[j] = (int)p; if (sv[0] == 0) *bad = 1; }
  if (p != j) for (long long c = t; c < n; c += blockDim.x) { T a = A[j * n + c]; A[j * n + c] = A[p * n + c]; A[p * n + c] = a; }
}
extern "C" __global__ void colupd(T* A, const long long n, const long long j, const long long cend,
                                  volatile T* bmax, volatile long long* bidx, unsigned int* counter, int* piv, int* bad) {
  // Block (32, 8): one warp per row i > j; lane x handles column j + x (cend - j <= 32). Then the pivot search of
  // column j + 1 rides along: each block keeps its largest |A[i, j+1]|, and the last block to finish (a fenced
  // counter) picks the pivot and swaps the rows. That saves one launch per column.
  // Each block walks many rows (a grid-stride loop), so the reduction below costs little per row.
  const long long c = j + threadIdx.x;
  const int t = threadIdx.y * 32 + threadIdx.x;
  __shared__ T sv[256];
  __shared__ long long si[256];
  __shared__ int last;
  const T d = A[j * n + j];
  const T uj = c < cend ? A[j * n + c] : (T)0;
  T v = -1; long long vi = j + 1;
  for (long long i = j + 1 + (long long)blockIdx.x * blockDim.y + threadIdx.y; i < n; i += (long long)gridDim.x * blockDim.y) {
    const T l = A[i * n + j] / d;
    __syncwarp();
    if (c < cend) {
      if (c == j) A[i * n + j] = l;
      else { const T a = A[i * n + c] - l * uj; A[i * n + c] = a; if (threadIdx.x == 1 && fabs(a) > v) { v = fabs(a); vi = i; } }
    }
  }
  if (j + 1 >= cend) return;                          // the last column of this panel: no pivot to find here
  sv[t] = v; si[t] = vi;
  __threadfence();
  __syncthreads();
  for (int s = 128; s > 0; s >>= 1) {
    if (t < s && (sv[t + s] > sv[t] || (sv[t + s] == sv[t] && si[t + s] < si[t]))) { sv[t] = sv[t + s]; si[t] = si[t + s]; }
    __syncthreads();
  }
  if (t == 0) {
    bmax[blockIdx.x] = sv[0]; bidx[blockIdx.x] = si[0];
    __threadfence();
    last = (atomicInc(counter, gridDim.x - 1) == gridDim.x - 1);
  }
  __syncthreads();
  if (!last) return;
  T best = -1; long long bi = j + 1;
  for (int b = t; b < gridDim.x; b += 256) { const T x = bmax[b]; const long long xi = bidx[b]; if (x > best || (x == best && xi < bi)) { best = x; bi = xi; } }
  sv[t] = best; si[t] = bi;
  __syncthreads();
  for (int s = 128; s > 0; s >>= 1) {
    if (t < s && (sv[t + s] > sv[t] || (sv[t + s] == sv[t] && si[t + s] < si[t]))) { sv[t] = sv[t + s]; si[t] = si[t + s]; }
    __syncthreads();
  }
  const long long p = si[0], r = j + 1;
  if (t == 0) { piv[r] = (int)p; if (sv[0] == 0) *bad = 1; }
  if (p != r) for (long long cc = t; cc < n; cc += 256) { volatile T* Av = A; const T a = Av[r * n + cc]; Av[r * n + cc] = Av[p * n + cc]; Av[p * n + cc] = a; }
}
extern "C" __global__ void trinv32(const T* A, const long long n, const long long k0, const int bs, T* X) {
  // X = inverse of the unit lower triangle A[k0:k0+bs, k0:k0+bs] (bs <= 32); thread c makes column c
  __shared__ T L[32][33];
  __shared__ T Xs[32][33];
  const int c = threadIdx.x;
  for (int r = 0; r < bs; r++) if (c < bs) L[r][c] = A[(k0 + r) * n + k0 + c];
  __syncthreads();
  if (c < bs) {
    for (int r = 0; r < bs; r++) Xs[r][c] = (r == c) ? (T)1 : (T)0;
    for (int r = c + 1; r < bs; r++) { T s = 0; for (int k = c; k < r; k++) s -= L[r][k] * Xs[k][c]; Xs[r][c] = s; }
  }
  __syncthreads();
  for (int r = 0; r < bs; r++) if (c < bs) X[r * bs + c] = Xs[r][c];
}
extern "C" __global__ void gen(T* out, const long long r0, const long long rows, const long long n,
                               const unsigned long long seed) {
  // element (r, c) of the random matrix, uniform in [-0.5, 0.5): a hash, so any block can be made again later
  const long long total = rows * n;
  for (long long k = (long long)blockIdx.x * blockDim.x + threadIdx.x; k < total; k += (long long)gridDim.x * blockDim.x) {
    unsigned long long z = (unsigned long long)(r0 * n + k) + seed * 0x9E3779B97F4A7C15ULL;
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL; z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL; z ^= z >> 31;
    out[k] = (T)((double)(z >> 11) * (1.0 / 9007199254740992.0) - 0.5);
  }
}
"""
_KERNELS = {}
LEAF = 32


def _kernels(prec):
    import cupy as cp
    if prec not in _KERNELS:
        mod = cp.RawModule(code=_KSRC % {"T": "double" if prec == "fp64" else "float"})
        _KERNELS[prec] = {k: mod.get_function(k) for k in ("pivswap", "colupd", "trinv32", "gen")}
    return _KERNELS[prec]


class _Gemm:
    """C = alpha * A @ B + beta * C on row-major views (any row stride), in place, through cuBLAS directly.
    Row-major C = A B is column-major C^T = B^T A^T, so the operands go in swapped. Falls back to CuPy matmul."""

    def __init__(self, prec):
        import numpy as np
        self.np, self.prec = np, prec
        self.dt = np.float64 if prec == "fp64" else np.float32
        try:
            from cupy.cuda import cublas, device
            self.cublas, self.handle = cublas, device.get_cublas_handle()
            self.fn = cublas.dgemm if prec == "fp64" else cublas.sgemm
        except Exception:  # noqa: BLE001
            self.fn = None

    def __call__(self, C, A, B, alpha, beta):
        m, k = A.shape
        n = B.shape[1]
        if m == 0 or n == 0 or k == 0:
            return
        if self.fn is not None:
            it = C.itemsize
            for x in (A, B, C):
                if x.strides[1] != it:
                    raise ValueError("gemm needs unit column stride")
            al = self.np.array([alpha], self.dt)
            be = self.np.array([beta], self.dt)
            self.fn(self.handle, 0, 0, n, m, k, al.ctypes.data, B.data.ptr, B.strides[0] // it,
                    A.data.ptr, A.strides[0] // it, be.ctypes.data, C.data.ptr, C.strides[0] // it)
        else:
            P = A @ B
            if beta == 0:
                C[...] = alpha * P
            else:
                C *= beta
                C += alpha * P


def _host_solve(block, rhs, lower):
    """Solve a small triangular block on the host (unit lower, or upper)."""
    import scipy.linalg as sl
    return sl.solve_triangular(block, rhs, lower=lower, unit_diagonal=lower, check_finite=False)


def _inv_unit_lower(K, A, n, k0, bs, gemm, dt):
    """Inverse of the unit lower triangle A[k0:k0+bs, k0:k0+bs], on the card: 32 x 32 blocks by a kernel, larger
    ones by halves, inv([[P, 0], [C, Q]]) = [[Pi, 0], [-Qi C Pi, Qi]]."""
    import cupy as cp
    if bs <= 32:
        X = cp.empty((bs, bs), dt)
        K["trinv32"]((1,), (32,), (A, cp.int64(n), cp.int64(k0), cp.int32(bs), X))
        return X
    h = (bs // 2 + 31) // 32 * 32
    X = cp.zeros((bs, bs), dt)
    X[:h, :h] = _inv_unit_lower(K, A, n, k0, h, gemm, dt)
    X[h:, h:] = _inv_unit_lower(K, A, n, k0 + h, bs - h, gemm, dt)
    T = cp.empty((bs - h, h), dt)
    gemm(T, A[k0 + h:k0 + bs, k0:k0 + h], X[:h, :h], 1.0, 0.0)          # C Pi
    gemm(X[h:, :h], X[h:, h:], T, -1.0, 0.0)                             # -Qi (C Pi)
    return X


class Cancelled(Exception):
    pass


def _lu_solve(prec, n, nb, rate, progress):
    """Factor the random n x n matrix in place, solve for the random b, check the residual. Returns the record."""
    import cupy as cp
    K = _kernels(prec)
    dt = cp.float64 if prec == "fp64" else cp.float32
    gemm = _Gemm(prec)
    seed_a, seed_b = 1, 2
    A = cp.empty((n, n), dt)
    blocks = max(1, min(4096, (n * n + 255) // 256))
    K["gen"]((blocks,), (256,), (A, cp.int64(0), cp.int64(n), cp.int64(n), cp.uint64(seed_a)))
    b = cp.empty(n, dt)
    K["gen"]((max(1, (n + 255) // 256),), (256,), (b, cp.int64(0), cp.int64(1), cp.int64(n), cp.uint64(seed_b)))
    piv = cp.zeros(n, cp.int32)
    bad = cp.zeros(1, cp.int32)
    bmax = cp.zeros((n + 7) // 8 + 1, dt)
    bidx = cp.zeros((n + 7) // 8 + 1, cp.int64)
    counter = cp.zeros(1, cp.uint32)
    watchdog = bool(gpu.CARD.get("watchdog", True))
    limit_s = WATCHDOG_S if watchdog else 2.0
    stats = {"launches": 0}
    grid = 8 * int(gpu.CARD.get("smx") or 16)              # 8 blocks of 256 threads fill one SM

    def gemm_chunked(C, Am, Bm, alpha, beta):
        m, k = Am.shape
        w_all = Bm.shape[1]
        if m == 0 or w_all == 0:
            return
        w = max(32, int(limit_s * rate / max(1.0, 2.0 * m * k)))
        for c0 in range(0, w_all, w):
            c1 = min(w_all, c0 + w)
            gemm(C[:, c0:c1], Am, Bm[:, c0:c1], alpha, beta)
            stats["launches"] += 1

    def leaf(c0, c1):
        K["pivswap"]((1,), (1024,), (A, cp.int64(n), cp.int64(c0), piv, bad))    # later columns: colupd pivots
        for j in range(c0, c1):
            rows = n - j - 1
            if rows > 0:
                K["colupd"]((min((rows + 7) // 8, grid),), (32, 8), (A, cp.int64(n), cp.int64(j), cp.int64(c1), bmax, bidx, counter, piv, bad))
        stats["launches"] += 1 + (c1 - c0)

    def factor(c0, c1, bs):
        if c1 - c0 <= LEAF:
            leaf(c0, c1)
            return
        inner = LEAF if bs > LEAF else None
        for k in range(c0, c1, bs):
            ke = min(k + bs, c1)
            if inner:
                factor(k, ke, inner)
            else:
                leaf(k, ke)
            if ke < c1:
                Linv = _inv_unit_lower(K, A, n, k, ke - k, gemm, dt)
                T = A[k:ke, ke:c1].copy()
                gemm_chunked(A[k:ke, ke:c1], Linv, T, 1.0, 0.0)
                del T
                gemm_chunked(A[ke:n, ke:c1], A[ke:n, k:ke], A[k:ke, ke:c1], -1.0, 1.0)
            if bs == nb:                                    # top level: report and allow a stop between panels
                engine.sync()
                if _CANCEL.is_set():
                    raise Cancelled()
                done = 1.0 - (1.0 - ke / n) ** 3
                progress(done, ke)

    engine.sync()
    t0 = time.time()
    factor(0, n, nb)
    # apply the row swaps to b, then L y = P b and U x = y, block by block
    pv = cp.asnumpy(piv)
    bh = cp.asnumpy(b)
    for j in range(n):
        p = pv[j]
        if p != j:
            bh[j], bh[p] = bh[p], bh[j]
    y = cp.asarray(bh)
    for k in range(0, n, nb):
        ke = min(k + nb, n)
        if k:
            y[k:ke] -= A[k:ke, :k] @ y[:k]
        y[k:ke] = cp.asarray(_host_solve(cp.asnumpy(A[k:ke, k:ke]), cp.asnumpy(y[k:ke]), True))
    x = y
    for k in reversed(range(0, n, nb)):
        ke = min(k + nb, n)
        if ke < n:
            x[k:ke] -= A[k:ke, ke:] @ x[ke:]
        x[k:ke] = cp.asarray(_host_solve(cp.asnumpy(A[k:ke, k:ke]), cp.asnumpy(x[k:ke]), False))
    engine.sync()
    secs = time.time() - t0
    singular = bool(int(bad[0]))
    A = None                                            # free the matrix before the residual check
    cp.get_default_memory_pool().free_all_blocks()
    # residual: make A again in row blocks (the generator is a hash) and compare A x with b
    rb = max(1, min(n, int(64 * 2 ** 20 // (n * ITEM[prec]))))
    blk = cp.empty((rb, n), dt)
    rmax = anorm = 0.0
    xd = x.astype(dt)
    for r0 in range(0, n, rb):
        r1 = min(n, r0 + rb)
        Ab = blk[:r1 - r0]
        K["gen"]((max(1, min(4096, ((r1 - r0) * n + 255) // 256)),), (256,), (Ab, cp.int64(r0), cp.int64(r1 - r0), cp.int64(n), cp.uint64(seed_a)))
        r = Ab @ xd - b[r0:r1]
        rmax = max(rmax, float(cp.abs(r).max()))
        anorm = max(anorm, float(cp.abs(Ab).sum(axis=1).max()))
    xnorm, bnorm = float(cp.abs(x).max()), float(cp.abs(b).max())
    scaled = rmax / (EPS[prec] * (anorm * xnorm + bnorm) * n)
    del blk, b, x, y, xd
    cp.get_default_memory_pool().free_all_blocks()
    flops = 2.0 / 3.0 * n ** 3 + 1.5 * n ** 2
    gf = flops / secs / 1e9
    engine.mark_gflops(flops, secs, "LINPACK {} n={}".format(prec.upper(), n))
    return {"precision": prec, "n": n, "nb": nb, "seconds": round(secs, 3), "gflops": round(gf, 2),
            "residual": round(scaled, 4), "passed": bool(scaled < 16.0 and not singular and math.isfinite(scaled)),
            "launches": stats["launches"]}


def _pool_room():
    """Bytes this run may allocate: free card memory, and the CuPy pool limit when one is set."""
    import cupy as cp
    room = engine.budget_bytes(160)
    pool = cp.get_default_memory_pool()
    try:
        lim = pool.get_limit()
    except Exception:  # noqa: BLE001
        lim = 0
    if lim:
        room = min(room, lim - pool.used_bytes() - 96 * 2 ** 20)
    return max(0, room)


def _gemm_rate(prec):
    """A short GEMM to size the problem and the watchdog chunks (FLOP/s)."""
    import cupy as cp
    dt = cp.float64 if prec == "fp64" else cp.float32
    gemm = _Gemm(prec)
    m = 1024
    a = cp.ones((m, 256), dt)
    b = cp.ones((256, m), dt)
    c = cp.zeros((m, m), dt)
    gemm(c, a, b, 1.0, 0.0)
    engine.sync()
    t, reps = time.time(), 0
    while time.time() - t < 0.15 and reps < 50:
        gemm(c, a, b, -1.0, 1.0)
        engine.sync()
        reps += 1
    rate = 2.0 * m * m * 256 * reps / max(1e-6, time.time() - t)
    del a, b, c
    cp.get_default_memory_pool().free_all_blocks()
    return rate


def run_one(prec, size, progress):
    """One precision, on the GPU worker. size: 'auto' (fills free memory, up to about 45 s) or 'quick' (a few s)."""
    def job():
        rate = _gemm_rate(prec)
        room = _pool_room()
        n_mem = int(math.sqrt(0.82 * room / ITEM[prec]))
        n_time = int((MAX_RUN_S[size] * 0.6 * rate * 1.5) ** (1.0 / 3.0))
        n = max(256, min(n_mem, n_time, 40000))
        n -= n % 32
        nb = 256 if n >= 4096 else 128
        progress(0.0, 0, n)
        rec = _lu_solve(prec, n, nb, rate, lambda f, k: progress(f, k, n))
        rec["gemm_gflops"] = round(rate / 1e9, 1)
        rec["limited_by"] = "memory" if n == n_mem - n_mem % 32 else "time"
        return rec
    est = MAX_RUN_S[size] * 2 + 60
    return engine.run_on_gpu(job, "LINPACK " + prec.upper(), est)


# ================================================================ cache per card
def card_key():
    c = gpu.CARD
    return re.sub(r"[^a-z0-9]+", "-", "{}-{}".format(c.get("name", "gpu"), c.get("cc", "")).lower()).strip("-")[:80]


def _cache_path():
    return os.path.join(CACHE_DIR, "linpack-{}.json".format(card_key()))


def cached():
    try:
        with open(_cache_path(), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save(rec):
    c = cached()
    c.setdefault("runs", []).insert(0, rec)
    c["runs"] = c["runs"][:12]
    best = c.get(rec["precision"])
    if rec["passed"] and (not best or rec["gflops"] > best["gflops"]):
        c[rec["precision"]] = rec
    c["card"] = gpu.CARD.get("name")
    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp = _cache_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(c, f, indent=1)
    os.replace(tmp, _cache_path())
    return c


def cancel():
    _CANCEL.set()


def linpack(job, precision="both", size="auto"):
    precs = ["fp64", "fp32"] if precision == "both" else [precision]
    _CANCEL.clear()
    out = {}
    for i, p in enumerate(precs):
        def prog(f, k, n, i=i, p=p):
            job.step((i + f) / len(precs), "{} LU: column {:,} of {:,}".format(p.upper(), k, n))
        try:
            rec = run_one(p, size, prog)
        except Cancelled:
            raise R.Refused("LINPACK stopped by the user", 409)
        rec["at"] = time.time()
        rec["size"] = size
        if size == "auto":
            save(rec)
        out[p] = rec
    res = compare(out.get("fp64", {}).get("gflops"), out.get("fp32", {}).get("gflops"))
    res["runs"] = out
    first = out[precs[0]]
    res["headline"] = "{:,.1f} GFLOP/s {}".format(first["gflops"], first["precision"].upper())
    res["sentence"] = "; ".join("{} n={:,}: {:,.1f} GFLOP/s in {:.1f} s, residual {:.3g} ({})".format(
        r["precision"].upper(), r["n"], r["gflops"], r["seconds"], r["residual"], "passed" if r["passed"] else "FAILED")
        for r in out.values())
    res["check"] = all(r["passed"] for r in out.values())
    return res


# ================================================================ the comparison with history
def _rank_points(lst):
    curve = data().get("rank_curve", {}).get(lst["date"])
    if curve:
        return [(r, v) for r, v in curve if v]
    pts = [(1, lst.get("n1_rmax_gflops")), (10, lst.get("n10_rmax_gflops")), (100, lst.get("n100_rmax_gflops")),
           (500, lst.get("n500_rmax_gflops"))]
    return [(r, v) for r, v in pts if v]


def estimate_rank(lst, g):
    """Rank this speed would have had on one list: log-log interpolation between known ranks (an estimate)."""
    pts = _rank_points(lst)
    if g >= pts[0][1]:
        return 1
    if g < pts[-1][1]:
        return None
    for (r0, v0), (r1, v1) in zip(pts, pts[1:]):
        if v1 <= g <= v0:
            if v0 == v1:
                return r0
            f = (math.log(v0) - math.log(g)) / (math.log(v0) - math.log(v1))
            return max(1, int(round(math.exp(math.log(r0) + f * (math.log(r1) - math.log(r0))))))
    return None


def _records():
    """Pre-1993 machines that set a new LINPACK record, in time order."""
    best, out = 0.0, []
    for m in sorted((m for m in data()["machines"] if m["kind"] == "pre1993"), key=lambda m: (m["year"], m["rmax_gflops"])):
        if m["rmax_gflops"] > best:
            best = m["rmax_gflops"]
            out.append(m)
    return out


def place(g):
    """Where a speed of g GFLOP/s sits in history."""
    if not g:
        return None
    D = data()
    lists = D["lists"]
    M = {m["id"]: m for m in D["machines"]}
    top = [l for l in lists if l["n1_rmax_gflops"] <= g]
    ranks = [{"date": l["date"], "rank": estimate_rank(l, g)} for l in lists]
    made = [r for r in ranks if r["rank"]]
    out = {"gflops": g, "ranks": ranks,
           "last_on_list": made[-1]["date"] if made else None,
           "best_rank": min((r["rank"] for r in made), default=None)}
    if top:
        last = top[-1]
        nxt = next((l for l in lists if l["n1_rmax_gflops"] > g), None)
        out["top500"] = {"list": last["date"], "machine": last["n1"], "name": M[last["n1"]]["name"],
                         "n1_rmax_gflops": last["n1_rmax_gflops"], "until": nxt["date"] if nxt else None,
                         "overtaken_by": nxt["n1"] if nxt else None}
        out["year"] = int(last["date"][:4])
        out["beats"] = last["n1"]
    recs = _records()
    beaten = [m for m in recs if m["rmax_gflops"] <= g]
    if beaten:
        later = next((m for m in recs if m["rmax_gflops"] > g), None)
        if later is None and lists:
            later = M.get(lists[0]["n1"])
        out["pre1993"] = {"machine": beaten[-1]["id"], "name": beaten[-1]["name"], "year": beaten[-1]["year"],
                          "rmax_gflops": beaten[-1]["rmax_gflops"],
                          "overtaken_by": later["id"] if later else None,
                          "overtaken_year": later["year"] if later else None}
        if not top:
            out["beats"] = beaten[-1]["id"]
            out["year"] = later["year"] - 1 if later else beaten[-1]["year"]
    return out


CRAYS = ("cray-1", "cray-2", "cray-c90")


def crays(g):
    M = {m["id"]: m for m in data()["machines"]}
    out = {}
    for cid in CRAYS:
        m = M.get(cid)
        if m and g:
            out[cid] = {"name": m["name"], "linpack_gflops": m["rmax_gflops"], "peak_gflops": m.get("rpeak_gflops"),
                        "count": g / m["rmax_gflops"], "power_kw": m.get("power_kw"), "cost": m.get("cost")}
    return out


def compare(fp64=None, fp32=None):
    """Card vs history for the given speeds; missing ones come from this card's saved LINPACK runs."""
    c = cached()
    src = {}
    if fp64 is None and c.get("fp64"):
        fp64, src["fp64"] = c["fp64"]["gflops"], "measured"
    elif fp64 is not None:
        src["fp64"] = "given"
    if fp32 is None and c.get("fp32"):
        fp32, src["fp32"] = c["fp32"]["gflops"], "measured"
    elif fp32 is not None:
        src["fp32"] = "given"
    card = gpu.CARD
    out = {"card": {"name": card.get("name"), "arch": card.get("arch"), "tdp_w": card.get("tdp_w"),
                    "fp64_peak": card.get("fp64_gflops"), "fp32_peak": card.get("fp32_gflops")},
           "fp64": place(fp64), "fp32": place(fp32), "source": src,
           "crays": {"fp64": crays(fp64), "fp32": crays(fp32)}}
    p = out["fp64"] or out["fp32"]
    if p:
        if p.get("top500"):
            out["headline"] = "#1 on the TOP500 until {}".format(p["top500"]["until"] or "now")
        elif p.get("pre1993"):
            out["headline"] = "the fastest computer in {}".format(p["year"])
    return out


def state():
    """What the page needs to open: the card, saved runs, the comparison, and the history."""
    D = data()
    return {"card": gpu.CARD, "key": card_key(), "saved": cached(), "compare": compare(),
            "lists": D["lists"], "machines": D["machines"], "rank_curve": D.get("rank_curve", {}),
            "notes": D.get("notes")}


# ================================================================ the UI's routes
router = APIRouter()


@router.get("")
def r_state():
    return R.ui("lineage.state")


@router.post("/run")
def r_run(body: dict = None):
    b = body or {}
    return R.ui_job("lineage.linpack", "LINPACK on the card", precision=b.get("precision"), size=b.get("size"))


@router.post("/cancel")
def r_cancel():
    cancel()
    return {"cancelled": True}


@router.get("/compare")
def r_compare(fp64: float = None, fp32: float = None):
    return R.ui("lineage.compare", fp64=fp64, fp32=fp32)
