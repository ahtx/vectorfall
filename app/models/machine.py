"""Machine models: the card's live state, benchmarks, occupancy, and the reset."""
import time

from .. import engine, gpu, jobs, registry as R
from ..registry import model


@model("machine.status", "Machine status", "machine", "The card, live: utilisation, memory, temperature, the jobs that run now, the host.", device="cpu")
def status():
    from ..main import machine
    return machine()


@model("machine.benchmark", "Benchmark the card", "machine", "cuBLAS SGEMM, a 1024² FFT, and the text engine's scan kernel — measured now.")
def benchmark():
    import cupy as cp
    from .. import textengine as te

    def job():
        out = {}
        budget = engine.budget_bytes(180)              # pick a GEMM size (and scan length) that fits the free memory
        N = 2048 if budget > 3 * 2048 * 2048 * 4 + 64 * 2**20 else (1024 if budget > 3 * 1024 * 1024 * 4 else 512)
        a = cp.random.random((N, N), cp.float32)
        b = cp.random.random((N, N), cp.float32)
        cp.dot(a, b)
        engine.sync()
        t = time.time()
        for _ in range(6):
            c = cp.dot(a, b)
        engine.sync()
        dt = (time.time() - t) / 6
        out["sgemm_gflops"] = round(2 * N ** 3 / dt / 1e9, 1)
        out["sgemm_n"] = N
        engine.mark_gflops(2 * N ** 3, dt, "cuBLAS SGEMM {}³".format(N))
        del a, b, c
        cp.get_default_memory_pool().free_all_blocks()
        x = cp.random.random((1024, 1024), cp.float32)
        cp.fft.fft2(x)
        engine.sync()
        t = time.time()
        for _ in range(20):
            cp.fft.fft2(x)
        engine.sync()
        out["fft_ms"] = round((time.time() - t) / 20 * 1000, 2)
        del x
        cp.get_default_memory_pool().free_all_blocks()
        scan_n = int(min(80_000_000, engine.budget_bytes(180) // 2 // 8 * 8))
        s = cp.random.randint(0, 65000, scan_n, dtype=cp.int32).astype(cp.uint16)
        k = te.K("findset")
        codes = cp.asarray([1234], cp.uint16)
        cnt = cp.zeros(1, cp.uint64)
        o = cp.empty(1, cp.int64)
        k((96,), (256,), (s, cp.int64(s.size // 8), codes, cp.int32(1), cnt, o, cp.int64(0), cp.int64(0)))
        engine.sync()
        t = time.time()
        for _ in range(5):
            cnt.fill(0)
            k((96,), (256,), (s, cp.int64(s.size // 8), codes, cp.int32(1), cnt, o, cp.int64(0), cp.int64(0)))
        engine.sync()
        dt = time.time() - t
        out["scan_gbs"] = round(s.size * 2 * 5 / dt / 1e9, 1)
        engine.mark_bandwidth(s.size * 2 * 5, dt)
        del s
        return out
    return engine.run_on_gpu(job, "benchmark", 120)


@model("machine.pcie", "PCIe bandwidth", "machine", "Host↔card copy speed with pinned buffers.")
def pcie():
    return engine.measure_pcie()


@model("machine.occupancy", "Occupancy calculator", "machine", "How many warps a kernel keeps resident on one multiprocessor of this card (a formula).",
       device="cpu", fields=[{"k": "threads", "type": "int", "label": "Threads per block", "default": 256, "min": 32, "max": 1024},
                             {"k": "regs", "type": "int", "label": "Registers per thread", "default": 32, "min": 1, "max": 255},
                             {"k": "shared", "type": "int", "label": "Shared memory per block (bytes)", "default": 0, "min": 0, "max": 49152}])
def occupancy(threads, regs, shared):
    return gpu.occupancy(threads, regs, shared)


@model("machine.reset", "Reset the card", "machine", "Stop everything on the GPU and start the service again (about 20 s).", device="cpu",
       mutating=True, local_only=True, fields=[{"k": "reason", "type": "str", "label": "Reason", "default": "reset from the API"}])
def reset(reason):
    from ..main import _activity
    snap = {"worker": engine.worker.status(), "jobs": jobs.active(), "live": {"procs": []}}
    killed = [a["label"] for a in _activity(snap)]
    engine.restart_service(reason or "reset", ", ".join(killed) or None)
    return {"restarting": True, "terminated": killed, "eta_s": 20}


@model("machine.jobs", "Background jobs", "machine", "The jobs that run now, and the recent jobs.", device="cpu")
def job_list():
    return {"running": jobs.active(), "recent": jobs.recent()}


@model("machine.log", "Search the Log", "machine",
       "The kept Log: every run on the card, every background job and the commands typed in the shell, also from before the last "
       "restart (a ring of about 2 MB in the data folder). Filter by words, kind (card, job, err, cmd, client), app and time; newest or oldest first.",
       device="cpu",
       fields=[{"k": "q", "type": "str", "label": "Words (all must match)", "default": ""},
               {"k": "kind", "type": "choice", "label": "Kind", "choices": ["", "card", "job", "err", "cmd", "client"], "default": ""},
               {"k": "app", "type": "str", "label": "App (the kind of a job: plan, text, photo …)", "default": ""},
               {"k": "since", "type": "float", "label": "From (Unix time)", "default": 0},
               {"k": "until", "type": "float", "label": "Until (Unix time)", "default": 0},
               {"k": "order", "type": "choice", "label": "Order", "choices": ["newest", "oldest"], "default": "newest"},
               {"k": "limit", "type": "int", "label": "At most this many lines", "default": 300, "min": 1, "max": 2000}])
def log(q, kind, app, since, until, order, limit):
    from .. import syslog
    return syslog.search(q, kind, app, since, until, order, limit)


def _start_log():
    from .. import syslog
    syslog.start()


_start_log()
