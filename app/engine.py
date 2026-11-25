"""The compute engine. The K420 has 1 GB and one SMX, so there is exactly one GPU worker thread that owns the CuPy
context; every kernel runs there, serially. A pipeline uploads its input once, then each node transforms a CuPy
array in place of a host round-trip, so a chain of transforms amortises the one PCIe upload. Each stage is timed,
and whether it had to touch host memory is recorded, so the UI can draw resident (green) vs host (red) edges.
"""
import os
import queue
import threading
import time
import traceback
from concurrent.futures import Future
from concurrent.futures import TimeoutError as FutureTimeout

import numpy as np

import cupy as cp

from . import gpu, gpulease

NODES = {}        # id -> node spec
GEN = {}          # id -> generator spec (no input)


class GPUMemoryError(Exception):
    """Raised (as a clean 503) when a job would not fit in the card's 1 GB."""


class GPUBusy(Exception):
    """Raised (as a clean 503) when the card can't take the work now: stuck, too deep a queue, or a timeout."""


RUN_DIR = "/srv/data/run"
GRACE_S = 120          # a job this far past its own deadline has no one waiting for it: the worker is stuck
MAX_QUEUE = 32


def free_mb():
    return cp.cuda.runtime.memGetInfo()[0] // 2**20


def budget_bytes(reserve_mb=120):
    """Bytes a job may use on the card right now, leaving headroom for CuPy's own scratch."""
    free = cp.cuda.runtime.memGetInfo()[0]
    pool = cp.get_default_memory_pool()
    lim = pool.get_limit()                       # CUPY_GPU_MEMORY_LIMIT caps the pool below what the card has free
    if lim:
        free = min(free, lim - pool.used_bytes())
    return max(0, free - reserve_mb * 2**20)


def fits(nbytes, reserve_mb=120):
    return nbytes <= budget_bytes(reserve_mb)


def node(id, name, cat, intype, outtype, params=None, note="", cls="local"):
    def deco(fn):
        NODES[id] = {"id": id, "name": name, "cat": cat, "in": intype, "out": outtype,
                     "params": params or [], "note": note, "cls": cls, "fn": fn}
        return fn
    return deco


class Obj:
    """A typed GPU value flowing through a pipeline. type: image|audio|matrix|signal|scalar|stats."""
    __slots__ = ("type", "arr", "meta")

    def __init__(self, type, arr, meta=None):
        self.type = type
        self.arr = arr                 # cupy ndarray (or python scalar for 'stats')
        self.meta = meta or {}

    def nbytes(self):
        return int(self.arr.nbytes) if hasattr(self.arr, "nbytes") else 0


# ---------------------------------------------------------------- lanes
# One card, many callers. Work waits in three lanes: 0 interactive (frames and previews someone is watching),
# 1 normal (model calls), 2 background (loads, training, tests, projections, indexing, exports, benchmarks).
# A job's lane improves by one for each minute it has waited, so background work is late, never starved.
import re as _re
_BG = _re.compile(r"^(vlm load|loading|load |upload corpus|forces|particles fit|learn|train|test|project|CLIP: index|"
                  r"index|photo export|photo batch|batch|pcie|benchmark|warm|reservoir train|text build)", _re.I)
_FG = _re.compile(r"^(sim |init |photo preview|photo levels|photo look|preview|histogram|sound find preview|machine)", _re.I)
AGE_S = 60.0


def lane_of(label):
    lb = label or ""
    return 2 if _BG.search(lb) else 0 if _FG.search(lb) else 1


class _LaneQueue:
    """A blocking queue that hands out the item with the best (lane - minutes waited, arrival order)."""

    def __init__(self):
        self._items, self._cv, self._n = [], threading.Condition(), 0

    def put(self, item):
        with self._cv:
            self._n += 1
            self._items.append((self._n, time.time(), item))
            self._cv.notify()

    def get(self):
        with self._cv:
            while not self._items:
                self._cv.wait()
            now = time.time()
            k = min(range(len(self._items)), key=lambda i: (self._items[i][2][4] - (now - self._items[i][1]) / AGE_S, self._items[i][0]))
            n, t, item = self._items.pop(k)
            return item + (t,)

    def qsize(self):
        with self._cv:
            return len(self._items)

    def snapshot(self, limit=12):
        with self._cv:
            now = time.time()
            rows = sorted(self._items, key=lambda x: (x[2][4] - (now - x[1]) / AGE_S, x[0]))
            return [{"label": it[2] or "", "lane": ["interactive", "normal", "background"][it[4]], "waited": round(now - t, 1)}
                    for n, t, it in rows[:limit] if not it[1].cancelled()]


_CALL = threading.local()       # per calling thread: GPU time and runs of its own work (for the registry's timing)


def call_mark():
    return getattr(_CALL, "gpu_ms", 0.0), getattr(_CALL, "runs", 0), getattr(_CALL, "waited_ms", 0.0)


class _GPUWorker:
    def __init__(self):
        self.q = _LaneQueue()
        self.ready = False
        self.busy = False
        self.current = None
        self.since = self.deadline = None
        self.log, self.seq = [], 0           # System log: every run on the card, folded (see _note)
        self.busy_ms, self.runs = 0.0, 0     # running totals: the registry diffs these to time a model on the card
        self.t = threading.Thread(target=self._run, daemon=True)
        self.t.start()

    def _next(self):
        while True:
            fn, fut, label, timeout, lane, t_sub = self.q.get()
            if fut.set_running_or_notify_cancel():          # skip work whose caller already gave up
                fut.waited_ms = (time.time() - t_sub) * 1000
                return fn, fut, label, timeout

    def _run(self):
        # Learn our own host PID as nvidia-smi sees it (the container can't see host PIDs): diff the GPU process
        # list across our first CUDA allocation. Everything else on the card is then someone else's work.
        global SERVER_PID
        # until the first CUDA context exists (up to ~100 s after a restart) the card is not idle: say so
        self.busy, self.current, self.since, self.deadline = True, "starting the card (CUDA)", time.time(), None
        before = _gpu_pids()
        cp.cuda.Device(0).use()
        _warm = cp.zeros(1, cp.float32)
        cp.cuda.Stream.null.synchronize()
        new = _gpu_pids() - before
        SERVER_PID = next(iter(new)) if len(new) == 1 else None
        del _warm
        self.busy, self.current, self.since = False, None, None
        self.ready = True
        while True:
            fn, fut, label, timeout = self._next()
            self.busy, self.current = True, label
            self.since, self.deadline = time.time(), time.time() + timeout
            err = None
            t_run = time.time()
            try:
                with gpulease.lease(timeout):
                    r = fn()
                fut.gpu_ms = (time.time() - t_run) * 1000
                fut.set_result(r)
            except cp.cuda.memory.OutOfMemoryError as e:
                try:
                    cp.get_default_memory_pool().free_all_blocks()
                except Exception:  # noqa: BLE001
                    pass
                err = "out of memory"
                fut.set_exception(GPUMemoryError(
                    "That was too big for the card's memory ({} MB free for VectorFall). Try smaller numbers, "
                    "or free the card (unload a corpus / stop a simulation).".format(budget_bytes(0) // 2**20)))
            except Exception as e:  # noqa: BLE001
                err = "{}: {}".format(type(e).__name__, e)[:200]
                fut.set_exception(e)
            finally:
                self._note(label, self.since, err)
                self.busy, self.current = False, None
                self.since = self.deadline = None
                try:
                    cp.get_default_memory_pool().free_all_blocks()
                except Exception:  # noqa: BLE001
                    pass

    def _note(self, label, since, err):
        now = time.time()
        ms = (now - since) * 1000 if since else 0
        self.busy_ms += ms; self.runs += 1
        # a burst of the same work (a simulation's frames, a batch of embeddings, previews interleaved with their
        # histograms) is one line with a count: fold into a recent entry with the same label
        for k in range(len(self.log) - 1, max(-1, len(self.log) - 7), -1):
            last = self.log[k]
            if since and since - last["end"] > 5:
                break
            if last["label"] == (label or "") and not err and not last["err"]:
                last["n"] += 1; last["ms"] += ms; last["end"] = now; last["seq"] = self._bump()
                return
        self.log.append({"seq": self._bump(), "label": label or "", "at": since or now, "end": now, "ms": ms, "n": 1, "err": err})
        del self.log[:-300]

    def _bump(self):
        self.seq += 1
        return self.seq

    def submit(self, fn, label="", timeout=120, lane=None):
        fut = Future()
        fut.waited_ms = fut.gpu_ms = 0.0
        self.q.put((fn, fut, label, timeout, lane_of(label) if lane is None else int(lane)))
        return fut

    def typical_s(self, label):
        """The usual time of one run with this label, from the log (None when it never ran)."""
        rows = [e for e in self.log if e["label"] == (label or "") and e["n"]]
        if not rows:
            return None
        return round(sum(e["ms"] for e in rows) / max(1, sum(e["n"] for e in rows)) / 1000, 2)

    def status(self):
        now = time.time()
        since, deadline = self.since, self.deadline
        waiting = self.q.snapshot()
        for w in waiting:
            w["typical_s"] = self.typical_s(w["label"])
        return {"busy": self.busy, "current": self.current, "queued": self.q.qsize(), "ready": self.ready,
                "elapsed": round(now - since, 1) if self.busy and since else None,
                "typical_s": self.typical_s(self.current) if self.busy else None,
                "waiting": waiting,
                "overdue": bool(self.busy and deadline and now > deadline)}


SERVER_PID = None


def _gpu_pids():
    import subprocess
    try:
        out = subprocess.run(["nvidia-smi", "--query-compute-apps=pid", "--format=csv,noheader"], stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, universal_newlines=True, timeout=5).stdout
        return {int(x) for x in out.split() if x.strip().isdigit()}
    except Exception:  # noqa: BLE001
        return set()


def _start_worker():
    if not gpulease.configured():
        return _GPUWorker()
    gpulease.call("gpu_acquire", {"consumer": "vectorfall", "ttl_s": 180})
    try:
        w = _GPUWorker()
        deadline = time.time() + 180
        while not w.ready and w.t.is_alive() and time.time() < deadline:
            time.sleep(0.1)
        if not w.ready:
            raise RuntimeError("CUDA worker did not initialize within its GPU lease")
        return w
    finally:
        gpulease.call("gpu_release", {"consumer": "vectorfall"})


worker = _start_worker()


def run_on_gpu(fn, label="", timeout=120, lane=None):
    st = worker.status()
    if st["overdue"]:
        raise GPUBusy("The card is stuck on “{}” ({:.0f} s). Use Reset card in the top bar — it also "
                      "recovers by itself within two minutes.".format(st["current"], st["elapsed"] or 0))
    if st["queued"] >= MAX_QUEUE:
        raise GPUBusy("The card has {} jobs queued behind “{}”. Try again in a moment.".format(st["queued"], st["current"]))
    if threading.current_thread() is worker.t:          # already on the GPU thread: run inline (never self-deadlock)
        return fn()
    fut = worker.submit(fn, label, timeout, lane)
    try:
        r = fut.result(timeout=timeout)
        _CALL.gpu_ms = getattr(_CALL, "gpu_ms", 0.0) + fut.gpu_ms
        _CALL.waited_ms = getattr(_CALL, "waited_ms", 0.0) + fut.waited_ms
        _CALL.runs = getattr(_CALL, "runs", 0) + 1
        return r
    except FutureTimeout:
        fut.cancel()
        st = worker.status()
        raise GPUBusy("Stopped after {} s: the card did not become free (busy with “{}”, {} in the queue).".format(
            timeout, st["current"] or label, st["queued"]))


def record_reset(reason, label=None):
    import json
    os.makedirs(RUN_DIR, exist_ok=True)
    with open(os.path.join(RUN_DIR, "last_reset.json"), "w") as f:
        json.dump({"reason": reason, "label": label, "at": time.time()}, f)


def last_reset():
    import json
    try:
        with open(os.path.join(RUN_DIR, "last_reset.json")) as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return None


def restart_service(reason, label=None, delay=0.4):
    """Exit the process so Docker (restart: unless-stopped) brings the service straight back with a clean card.
    A Python thread stuck inside native code (BLAS, a driver call) cannot be interrupted any other way."""
    record_reset(reason, label)
    print("VECTORFALL RESET: {} ({})".format(reason, label), flush=True)
    try:
        from . import console
        console.stop_all()
    except Exception:  # noqa: BLE001
        pass
    threading.Timer(delay, lambda: os._exit(70)).start()


def _watchdog():
    while True:
        time.sleep(5)
        d = worker.deadline
        if worker.busy and d and time.time() > d + GRACE_S:
            restart_service("watchdog: GPU job stuck past its deadline", worker.current, delay=0.1)
            return


threading.Thread(target=_watchdog, daemon=True, name="gpu-watchdog").start()


def sync():
    cp.cuda.Stream.null.synchronize()


def mark_gflops(flops, seconds, kernel=None):
    if seconds > 0:
        gpu.measured.update(gflops=round(flops / seconds / 1e9, 1), gflops_at=time.time(), kernel=kernel)


def mark_bandwidth(bytes_, seconds):
    if seconds > 0:
        gpu.measured["bandwidth_gbs"] = round(bytes_ / seconds / 1e9, 1)


# ---------------------------------------------------------------- PCIe self-measurement (Kepler dmon can't)
def measure_pcie():
    def job():
        n = 48 * 2**20
        h = cp.cuda.alloc_pinned_memory(n)
        hv = np.frombuffer(h, np.uint8, n)
        d = cp.empty(n, cp.uint8)
        sync()
        t = time.time()
        for _ in range(8):
            d.set(hv)
        sync()
        h2d = n * 8 / (time.time() - t) / 1e9
        t = time.time()
        for _ in range(8):
            d.get(out=hv)
        sync()
        d2h = n * 8 / (time.time() - t) / 1e9
        return round(h2d, 2), round(d2h, 2)
    try:
        h2d, d2h = run_on_gpu(job, "pcie benchmark", 30)
        gpu.measured.update(pcie_h2d_gbs=h2d, pcie_d2h_gbs=d2h, pcie_at=time.time())
        return {"h2d": h2d, "d2h": d2h}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)[:120]}


# ---------------------------------------------------------------- pipeline runner
def _render(obj):
    """Turn a final Obj into something the browser shows: a PNG (image), stats (dict), a line series, or audio."""
    from .nodes import to_png, to_series
    if obj.type == "image":
        return {"kind": "image", "png": to_png(obj), "meta": obj.meta}
    if obj.type in ("matrix", "signal"):
        a = obj.arr
        meta = {**obj.meta, "shape": list(a.shape), "dtype": str(a.dtype)}
        if a.ndim == 2 and min(a.shape) > 1:
            return {"kind": "image", "png": to_png(Obj("image", cp.abs(a).astype(cp.float32))), "meta": meta}
        return {"kind": "series", "series": to_series(cp.abs(a).ravel()[:4096]), "meta": meta}
    if obj.type == "audio":
        return {"kind": "series", "series": to_series(obj.arr[:8192]), "meta": {**obj.meta, "samples": int(obj.arr.size)}}
    if obj.type == "stats":
        return {"kind": "stats", "stats": obj.arr if isinstance(obj.arr, dict) else {"value": float(obj.arr)}, "meta": obj.meta}
    return {"kind": "stats", "stats": {"type": obj.type}}


def run_pipeline(source, stages, want_frames=False):
    """source: Obj already on host (arr is numpy) or None for a generator-seeded chain. stages: [{id, params}]."""
    def job():
        t0 = time.time()
        timeline = []
        free0 = cp.cuda.runtime.memGetInfo()[0]
        # upload once
        if source is not None and source.arr is not None:
            t = time.time()
            obj = Obj(source.type, cp.asarray(source.arr), dict(source.meta))
            sync()
            up_ms = (time.time() - t) * 1000
            timeline.append({"stage": "upload", "ms": round(up_ms, 2), "resident": False,
                             "bytes": obj.nbytes(), "note": "host -> GPU (PCIe)"})
        else:
            obj = Obj("none", None)
        peak = 0
        for st in stages:
            spec = NODES.get(st["id"])
            if not spec:
                raise ValueError("unknown node " + st["id"])
            t = time.time()
            obj = spec["fn"](obj, st.get("params") or {})
            sync()
            ms = (time.time() - t) * 1000
            used = cp.cuda.runtime.memGetInfo()
            peak = max(peak, free0 - used[0])
            timeline.append({"stage": spec["id"], "name": spec["name"], "ms": round(ms, 2),
                             "resident": True, "cls": spec["cls"], "out": obj.type,
                             "bytes": obj.nbytes(), "shape": list(obj.arr.shape) if hasattr(obj.arr, "shape") else None})
        out = _render(obj)
        out["timeline"] = timeline
        out["total_ms"] = round((time.time() - t0) * 1000, 2)
        out["peak_mb"] = round(max(0, peak) / 2**20, 1)
        out["out_type"] = obj.type
        return out
    label = " -> ".join(s["id"] for s in stages) or "pipeline"
    return run_on_gpu(job, label, 180)
