"""Live simulations that live on the card: seed once, iterate thousands of steps resident, send a frame + the real
telemetry each tick. No PCIe between steps — this is where a 1990s-Cray-class GPU actually shines, and where you
feel the machine working. Each sim reports a rough FLOP count per step so the compute gauge reads real GFLOP/s.
"""
import base64
import io
import math
import time

import numpy as np
from PIL import Image

import cupy as cp
import cupyx
import cupyx.scipy.ndimage as ndi


def _scatter_add(a, idx, val):
    """cp.add.at doesn't exist in CuPy 9.6; cupyx.scatter_add is the equivalent in-place scatter."""
    cupyx.scatter_add(a, idx, val)

from . import gpu
from .engine import budget_bytes, mark_gflops, run_on_gpu, sync

SIMS = {}


def _zoomfmt(z):
    if z < 1e4: return '{:.0f}×'.format(z)
    if z < 1e15: return '{:.1f}e{}×'.format(z / 10 ** int(math.log10(z)), int(math.log10(z)))
    return '{:.0e}×'.format(z)


def sim(id, name, desc, params=None, flops_hint=""):
    def deco(cls):
        SIMS[id] = {"id": id, "name": name, "desc": desc, "params": params or [], "flops_hint": flops_hint, "cls": cls}
        return cls
    return deco


# ---- colour maps (GPU) ----------------------------------------------------
def _cmap(v, name="inferno"):
    """v: cupy float [0,1] HxW -> uint8 HxWx3. A few baked-in ramps so we need no matplotlib."""
    v = cp.clip(v, 0, 1)
    if name == "gray":
        c = cp.stack([v, v, v], -1)
    elif name == "fire":
        c = cp.stack([cp.clip(v * 1.8, 0, 1), cp.clip(v * 1.8 - 0.6, 0, 1), cp.clip(v * 3 - 2, 0, 1)], -1)
    elif name == "ice":
        c = cp.stack([cp.clip(v * 2 - 1, 0, 1), cp.clip(v * 1.4, 0, 1), cp.clip(0.3 + v * 0.7, 0, 1)], -1)
    elif name == "cray":          # red ramp on dark
        c = cp.stack([cp.clip(0.1 + v * 1.6, 0, 1), cp.clip(v * v * 0.9, 0, 1), cp.clip(v ** 3 * 0.5, 0, 1)], -1)
    else:  # inferno-ish
        c = cp.stack([cp.clip(v * 2.2 - 0.1, 0, 1), cp.clip(v ** 1.6 * 1.3 - 0.2, 0, 1), cp.clip(cp.sin(v * 3.14) * 0.6 + v ** 3, 0, 1)], -1)
    return (c * 255).astype(cp.uint8)


def _png(rgb_uint8):
    a = cp.asnumpy(rgb_uint8)
    buf = io.BytesIO()
    Image.fromarray(a).save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


class Sim:
    def __init__(self, params):
        self.p = params
        self.step_n = 0
        self.setup()

    def setup(self):
        pass

    def step(self, iters):     # advance `iters` steps on the GPU; return flops done
        return 0

    def frame(self):           # -> data url
        return ""

    def metrics(self):
        return {}

    def paint(self, strokes):          # strokes: [{"x": 0..1, "y": 0..1, "r": 0..1}]
        pass

    def _disk(self, n, st):
        yy, xx = cp.ogrid[:n, :n]
        m = cp.zeros((n, n), cp.bool_)
        for s_ in st:
            cx, cy, r = float(s_["x"]) * n, float(s_["y"]) * n, max(1.5, float(s_.get("r", 0.02)) * n)
            m |= (xx - cx) ** 2 + (yy - cy) ** 2 <= r * r
        return m


# ============================================================ Reaction–diffusion (Gray–Scott)
@sim("reaction", "Reaction–diffusion", "Gray–Scott: two chemicals diffuse and react into coral, spots and mazes. A local stencil iterated thousands of times, fully on-card.",
     [{"k": "size", "label": "Grid", "type": "int", "default": 320, "min": 128, "max": 512},
      {"k": "feed", "label": "Feed", "type": "float", "default": 0.039, "min": 0.01, "max": 0.1},
      {"k": "kill", "label": "Kill", "type": "float", "default": 0.058, "min": 0.03, "max": 0.07},
      {"k": "cmap", "label": "Colour", "type": "choice", "choices": ["inferno", "fire", "ice", "cray"], "default": "inferno"}],
     flops_hint="~20 FLOP/cell/step")
class ReactionDiffusion(Sim):
    def setup(self):
        n = int(self.p.get("size", 320))
        n = min(n, int((budget_bytes(80) / 48) ** 0.5))
        self.n = max(96, n)
        n = self.n
        self.U = cp.ones((n, n), cp.float32)
        self.V = cp.zeros((n, n), cp.float32)
        # about a dozen seeds over the whole field, so patterns appear everywhere at once (one centre square took
        # a minute to show anything)
        rng = np.random.RandomState()
        r = max(3, n // 28)
        for _ in range(12):
            cy, cx = rng.randint(r, n - r, 2)
            self.V[cy - r:cy + r, cx - r:cx + r] = 1.0
            self.U[cy - r:cy + r, cx - r:cx + r] = 0.5
        self.V += cp.random.random((n, n), dtype=cp.float32) * 0.02
        self.lap = cp.asarray([[0.05, 0.2, 0.05], [0.2, -1.0, 0.2], [0.05, 0.2, 0.05]], cp.float32)

    def step(self, iters):
        Du, Dv = 0.16, 0.08
        f, k = float(self.p.get("feed", 0.039)), float(self.p.get("kill", 0.058))   # growing mazes: painted strokes persist and spread
        for _ in range(iters):
            Lu = ndi.convolve(self.U, self.lap, mode="wrap")
            Lv = ndi.convolve(self.V, self.lap, mode="wrap")
            uvv = self.U * self.V * self.V
            self.U += Du * Lu - uvv + f * (1 - self.U)
            self.V += Dv * Lv + uvv - (f + k) * self.V
            self.step_n += 1
        return iters * self.n * self.n * 20

    def frame(self):
        return _png(_cmap(self.V, self.p.get("cmap", "inferno")))

    def paint(self, strokes):
        m = self._disk(self.n, strokes)
        self.V[m] = 1.0
        self.U[m] = 0.5

    def metrics(self):
        return {"steps": self.step_n, "grid": f"{self.n}×{self.n}", "cells": self.n * self.n}


# ============================================================ Conway's Game of Life
@sim("life", "Game of Life", "Conway's cellular automaton — one thread per cell, a neighbourhood sum and a rule, millions of cells a second.",
     [{"k": "size", "label": "Grid", "type": "int", "default": 384, "min": 128, "max": 640},
      {"k": "density", "label": "Density", "type": "float", "default": 0.3, "min": 0.05, "max": 0.6}],
     flops_hint="~9 ops/cell/step")
class Life(Sim):
    def setup(self):
        n = int(self.p.get("size", 384))
        n = min(n, int((budget_bytes(80) / 24) ** 0.5))
        self.n = max(96, n)
        n = self.n
        self.g = (cp.random.random((n, n), dtype=cp.float32) < float(self.p.get("density", 0.3))).astype(cp.float32)
        self.k = cp.ones((3, 3), cp.float32)
        self.k[1, 1] = 0

    def step(self, iters):
        for _ in range(iters):
            nb = ndi.convolve(self.g, self.k, mode="wrap")
            self.g = ((nb == 3) | ((self.g == 1) & (nb == 2))).astype(cp.float32)
            self.step_n += 1
        return iters * self.n * self.n * 9

    def frame(self):
        return _png(_cmap(self.g, "cray"))

    def paint(self, strokes):
        m = self._disk(self.n, strokes)
        self.g[m] = (cp.random.random(int(m.sum()), dtype=cp.float32) < 0.5).astype(cp.float32)

    def metrics(self):
        return {"steps": self.step_n, "grid": f"{self.n}×{self.n}", "alive": int(self.g.sum())}


# ============================================================ N-body gravity
@sim("nbody", "N-body gravity", "Direct O(N²) gravity — every body pulls on every other. Pure FP32 compute, where a GPU is at its best. To run a real population (companies, countries, your own table) under rules like these, and check them against history, use the Particle Lab.",
     [{"k": "n", "label": "Bodies", "type": "int", "default": 1000, "min": 200, "max": 6000}],
     flops_hint="~20 FLOP/pair/step")
class NBody(Sim):
    def setup(self):
        n = int(self.p.get("n", 1000))
        n = min(n, int((budget_bytes(80) / 48) ** 0.5))     # O(N^2) temporaries (~48 B/pair) must fit
        self.n = max(64, n)
        n = self.n
        ang = cp.random.random(n, dtype=cp.float32) * 6.283
        rad = cp.sqrt(cp.random.random(n, dtype=cp.float32)) * 0.8
        self.pos = cp.stack([rad * cp.cos(ang), rad * cp.sin(ang)], 1).astype(cp.float32)
        m = cp.random.random(n, dtype=cp.float32) * 0.5 + 0.5
        self.m = (m / m.sum()).astype(cp.float32)          # total mass 1: the disc neither collapses nor flies apart
        order = cp.argsort(rad)
        menc = cp.empty_like(rad)
        menc[order] = cp.cumsum(self.m[order])              # the mass inside each body's radius
        eps = 0.02                                          # the same softening as step()
        v = cp.sqrt(menc * rad ** 2 / (rad ** 2 + eps) ** 1.5)   # the circular speed for that mass: the disc turns
        self.vel = cp.stack([-v * cp.sin(ang), v * cp.cos(ang)], 1).astype(cp.float32)

    def step(self, iters):
        dt, eps = 0.01, 0.02
        for _ in range(iters):
            d = self.pos[None, :, :] - self.pos[:, None, :]
            r2 = (d ** 2).sum(2) + eps
            inv = (self.m[None, :] / (r2 * cp.sqrt(r2)))
            acc = (d * inv[:, :, None]).sum(1)
            self.vel += acc * dt
            self.pos += self.vel * dt
            self.step_n += 1
        return iters * self.n * self.n * 20

    def frame(self):
        n = 400
        img = cp.zeros((n, n), cp.float32)
        xy = cp.clip((self.pos * 0.5 + 0.5) * n, 0, n - 1).astype(cp.int32)
        _scatter_add(img, (xy[:, 1], xy[:, 0]), 1.0)
        img = ndi.gaussian_filter(img, 1.0)
        v = cp.log1p(img * 6)                          # scaled to the frame's own brightest point: a spread-out disc of
        return _png(_cmap(v / max(1e-6, float(v.max())), "ice"))   # stable orbits is as visible as a dense knot

    def metrics(self):
        return {"steps": self.step_n, "bodies": self.n, "pairs": self.n * self.n}


# ============================================================ Mandelbrot zoom
@sim("mandelbrot", "Mandelbrot zoom", "Endless zoom into the Mandelbrot set. Past the limit of the card's floats it switches to perturbation — a high-precision reference orbit on the CPU, tiny deltas per pixel on the GPU — so the detail never runs out.",
     [{"k": "size", "label": "Pixels", "type": "int", "default": 600, "min": 256, "max": 900},
      {"k": "cmap", "label": "Colour", "type": "choice", "choices": ["inferno", "fire", "ice", "cray"], "default": "fire"}],
     flops_hint="perturbation beyond 1e13×")
class Mandelbrot(Sim):
    def setup(self):
        # a point with infinite detail at every scale (a deep spiral); kept to high precision for endless zoom
        self.cx = "-0.743643887037158704752191506114774"
        self.cy = "0.131825904205311970493132056385139"
        self.scale = 3.0
        self.kernel = cp.ElementwiseKernel("float64 cr, float64 ci, int32 maxit", "float32 out", """
            double zr=0, zi=0; int it=0;
            for(; it<maxit; it++){ double zr2=zr*zr-zi*zi+cr; zi=2*zr*zi+ci; zr=zr2; if(zr*zr+zi*zi>4.0) break; }
            out = (it>=maxit) ? -1.0f : (float)(it + 1.0 - log2(0.5*log(zr*zr+zi*zi+1e-30)));""", "mand64")
        self._mod = None

    def _pmod(self):
        from . import fractal
        return fractal._mod()

    def step(self, iters):
        from . import fractal
        self.scale *= 0.88 ** iters
        if self.scale < 1e-250:                         # float64 pixel spacing would underflow: start the dive again
            self.scale = 3.0
        self.step_n += iters
        n = int(self.p.get("size", 600))
        dx = self.scale / n
        depth = max(0.0, -math.log10(self.scale / 3.0))
        mx = fractal.deep_iters(depth, 20000)
        self.out = cp.empty(n * n, cp.float32)
        if dx < 1e-6:                                   # deep: chunked perturbation with a high-precision reference orbit
            fractal.pert_frame(self.cx, self.cy, depth, dx, n, n, mx, self.out)
        else:
            cx0, cy0 = float(self.cx), float(self.cy)
            xs = cp.linspace(cx0 - self.scale / 2, cx0 + self.scale / 2, n, dtype=cp.float64)
            ys = cp.linspace(cy0 - self.scale / 2, cy0 + self.scale / 2, n, dtype=cp.float64)
            cr, ci = cp.meshgrid(xs, ys)
            self.out = self.kernel(cp.ascontiguousarray(cr), cp.ascontiguousarray(ci), mx).reshape(n * n)
        self.n, self.mx = n, mx
        return n * n * mx * 8

    def frame(self):
        n = int(self.p.get("size", 600))
        o = self.out.reshape(n, n)
        ph = cp.sqrt(cp.maximum(o, 0)) * 0.14         # cyclic colouring: works at any zoom depth
        ph = ph - cp.floor(ph)
        ph = cp.where(o < 0, 0.0, ph)                 # the set itself stays black
        return _png(_cmap(ph, self.p.get("cmap", "fire")))

    def metrics(self):
        return {"frame": self.step_n, "zoom": _zoomfmt(3.0 / self.scale), "precision": "perturbation" if self.scale / int(self.p.get("size", 600)) < 1e-6 else "FP64", "iters": self.mx}


# ============================================================ Ising model
@sim("ising", "Ising magnet", "A 2-D lattice of spins that flip by the Metropolis rule on a checkerboard — statistical physics, perfectly parallel.",
     [{"k": "size", "label": "Lattice", "type": "int", "default": 400, "min": 128, "max": 640},
      {"k": "temp", "label": "Temperature", "type": "float", "default": 2.27, "min": 0.5, "max": 5}],
     flops_hint="~10 ops/spin/step")
class Ising(Sim):
    def setup(self):
        n = int(self.p.get("size", 400))
        n = min(n, int((budget_bytes(80) / 40) ** 0.5))
        self.n = max(96, n)
        n = self.n
        self.s = (cp.random.random((n, n), dtype=cp.float32) < 0.5).astype(cp.float32) * 2 - 1
        yy, xx = cp.ogrid[:n, :n]
        self.mask = ((xx + yy) % 2 == 0)

    def step(self, iters):
        T = float(self.p.get("temp", 2.27))
        for _ in range(iters):
            for parity in (self.mask, ~self.mask):
                nb = (cp.roll(self.s, 1, 0) + cp.roll(self.s, -1, 0) + cp.roll(self.s, 1, 1) + cp.roll(self.s, -1, 1))
                dE = 2 * self.s * nb
                flip = (cp.random.random(self.s.shape, dtype=cp.float32) < cp.exp(-dE / T)) & parity
                self.s = cp.where(flip, -self.s, self.s)
            self.step_n += 1
        return iters * self.n * self.n * 10

    def frame(self):
        return _png(_cmap((self.s + 1) / 2, "cray"))

    def paint(self, strokes):
        m = self._disk(self.n, strokes)
        self.s[m] = 1.0

    def metrics(self):
        return {"steps": self.step_n, "lattice": f"{self.n}×{self.n}", "magnetization": round(float(self.s.mean()), 3)}


# ============================================================ Monte Carlo π
@sim("montecarlo", "Monte Carlo π", "Throw millions of random darts per tick (cuRAND) and estimate π from how many land in the circle. Compute-bound, bus-light.",
     [{"k": "batch", "label": "Darts / tick", "type": "int", "default": 20000000, "min": 1000000, "max": 80000000}],
     flops_hint="~6 FLOP/sample")
class MonteCarlo(Sim):
    def setup(self):
        self.inside = 0
        self.total = 0
        self.hist = []

    def step(self, iters):
        b = int(self.p.get("batch", 20000000))
        b = min(b, max(1_000_000, budget_bytes(80) // 40))   # x, y + squared/compare temporaries
        for _ in range(iters):
            x = cp.random.random(b, dtype=cp.float32)
            y = cp.random.random(b, dtype=cp.float32)
            self.inside += int(((x * x + y * y) <= 1).sum())
            self.total += b
            self.step_n += 1
        self.pi = 4 * self.inside / self.total
        self.hist.append(round(self.pi, 5))
        self.hist = self.hist[-120:]
        return iters * b * 6

    def frame(self):
        n = 300
        img = cp.zeros((n, n, 3), cp.uint8)
        s = 40000
        x = cp.random.random(s, dtype=cp.float32)
        y = cp.random.random(s, dtype=cp.float32)
        inside = (x * x + y * y) <= 1
        px = (x * (n - 1)).astype(cp.int32)
        py = ((1 - y) * (n - 1)).astype(cp.int32)
        img[py[inside], px[inside]] = cp.asarray([245, 60, 50], cp.uint8)
        img[py[~inside], px[~inside]] = cp.asarray([60, 66, 76], cp.uint8)
        return _png(img)

    def metrics(self):
        return {"pi": round(self.pi, 6), "error": round(abs(self.pi - np.pi), 6),
                "samples": f"{self.total / 1e6:.0f} M", "history": self.hist}


# ============================================================ Random walks
@sim("walks", "Random walks", "A million Brownian walkers that move at the same time — each tick every walker takes thousands of random steps, and their footprints pile up into a diffusion cloud. Embarrassingly parallel cuRAND.",
     [{"k": "walkers", "label": "Walkers", "type": "int", "default": 1000000, "min": 10000, "max": 4000000},
      {"k": "drift", "label": "Drift", "type": "float", "default": 0.0, "min": -0.02, "max": 0.02},
      {"k": "cmap", "label": "Colour", "type": "choice", "choices": ["cray", "fire", "ice", "inferno"], "default": "cray"}],
     flops_hint="~8 FLOP/walker/step")
class RandomWalks(Sim):
    def setup(self):
        w = int(self.p.get("walkers", 1000000))
        self.w = max(10000, min(w, budget_bytes(120) // 40))   # x, y + per-step noise temporaries
        self.x = cp.zeros(self.w, cp.float32)
        self.y = cp.zeros(self.w, cp.float32)
        self.n = 400
        self.heat = cp.zeros((self.n, self.n), cp.float32)
        self.drift = float(self.p.get("drift", 0.0))

    def step(self, iters):
        s = 0.008
        for _ in range(iters):
            self.x += cp.random.standard_normal(self.w, dtype=cp.float32) * s + self.drift * s
            self.y += cp.random.standard_normal(self.w, dtype=cp.float32) * s
            self.step_n += 1
        n = self.n
        ix = cp.clip((self.x * 0.5 + 0.5) * n, 0, n - 1).astype(cp.int32)
        iy = cp.clip((self.y * 0.5 + 0.5) * n, 0, n - 1).astype(cp.int32)
        self.heat *= 0.97                                   # footprints fade, so the cloud reads as it spreads
        _scatter_add(self.heat, (iy, ix), 1.0)
        return iters * self.w * 8

    def frame(self):
        h = cp.log1p(self.heat)
        return _png(_cmap(h / max(1e-6, float(h.max())), self.p.get("cmap", "cray")))

    def metrics(self):
        r = float(cp.sqrt((self.x ** 2 + self.y ** 2).mean()))
        return {"steps": self.step_n, "walkers": self.w, "rms_distance": round(r, 4),
                "expected": round(0.008 * math.sqrt(2 * self.step_n), 4)}


# ---------------------------------------------------------------- driver
class Runner:
    """Steps a sim on the GPU worker and produces frames with real telemetry. One at a time (1 GB card)."""
    def __init__(self, sim_id, params):
        spec = SIMS[sim_id]
        self.spec = spec
        self.sim = run_on_gpu(lambda: spec["cls"](params), f"init {sim_id}")
        self.sim_id = sim_id

    def paint(self, strokes):
        run_on_gpu(lambda: self.sim.paint(strokes), "paint", 30)

    def tick(self, iters):
        def job():
            t = time.time()
            flops = self.sim.step(iters)
            sync()
            dt = time.time() - t
            mark_gflops(flops, dt, self.spec["name"])
            frame = self.sim.frame()
            return frame, dt, flops
        frame, dt, flops = run_on_gpu(job, f"sim {self.sim_id}", 60)
        return {"frame": frame, "step_ms": round(dt * 1000, 2), "gflops": round(flops / dt / 1e9, 1) if dt else 0,
                "iters_per_s": round(iters / dt) if dt else 0, "metrics": self.sim.metrics(), "telemetry": gpu.poll()}
