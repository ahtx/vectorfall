"""Live telemetry for the NVIDIA card, honestly. What the card really exposes through NVML / nvidia-smi:
utilisation, memory, clocks, temperature, PCIe link gen/width. No power sensor, no per-SM counters, no dmon PCIe
throughput on Kepler. So the "living machine" view mixes measured values with things we compute ourselves: the
PCIe rate and GFLOP/s from our own timed kernels, and the theoretical occupancy from a launched kernel's shape.
"""
import os
import subprocess
import time

# The machine's nameplate, read from the card at start-up (see cards.py): name, cores, peaks, Cray comparison.
from . import cards
CARD = cards.detect()

_QUERY = ("utilization.gpu,utilization.memory,memory.used,memory.total,memory.free,"
          "clocks.sm,clocks.mem,clocks.gr,temperature.gpu,pstate,"
          "pcie.link.gen.current,pcie.link.gen.max,pcie.link.width.current,fan.speed,power.draw")
_last = {"at": 0.0, "data": {}}
# measured-by-us gauges, updated by the engine as it runs work
measured = {"gflops": None, "gflops_at": 0.0, "pcie_h2d_gbs": None, "pcie_d2h_gbs": None, "pcie_at": 0.0,
            "occupancy": None, "kernel": None, "bandwidth_gbs": None}


def _num(v):
    v = v.strip()
    if v in ("[N/A]", "N/A", "", "[Not Supported]"):
        return None
    try:
        return float(v) if "." in v else int(v)
    except ValueError:
        return v


def poll(force=False):
    if not force and time.time() - _last["at"] < 0.8:
        return _last["data"]
    try:
        out = subprocess.run(["nvidia-smi", f"--query-gpu={_QUERY}", "--format=csv,noheader,nounits"],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=5).stdout.strip()
        f = [x.strip() for x in out.split(",")]
        d = {"util_gpu": _num(f[0]), "util_mem": _num(f[1]), "mem_used": _num(f[2]), "mem_total": _num(f[3]),
             "mem_free": _num(f[4]), "clock_sm": _num(f[5]), "clock_mem": _num(f[6]), "clock_gr": _num(f[7]),
             "temp": _num(f[8]), "pstate": f[9], "pcie_gen": _num(f[10]), "pcie_gen_max": _num(f[11]),
             "pcie_width": _num(f[12]), "fan": _num(f[13]), "power": _num(f[14]), "ok": True}
    except Exception as e:  # noqa: BLE001
        d = {"ok": False, "error": str(e)[:150]}
    d["procs"] = _procs()
    _last.update(at=time.time(), data=d)
    return d


def _procs():
    try:
        out = subprocess.run(["nvidia-smi", "--query-compute-apps=pid,process_name,used_memory",
                              "--format=csv,noheader,nounits"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=5).stdout.strip()
        rows = []
        for line in out.splitlines():
            p = [x.strip() for x in line.split(",")]
            if len(p) >= 3:
                rows.append({"pid": _num(p[0]), "name": p[1].split("/")[-1], "mem_mb": _num(p[2])})
        return rows
    except Exception:  # noqa: BLE001
        return []


def occupancy(threads_per_block, regs_per_thread=32, shared_per_block=0):
    """Theoretical SMX occupancy for a launch shape (what the CUDA occupancy calculator does). Honest: this is
    computed from the kernel's shape, not a per-core measurement — there is no per-core telemetry on any GPU."""
    c = CARD
    warps_block = -(-threads_per_block // c["warp_size"])
    lim_threads = c["max_threads_smx"] // threads_per_block
    lim_blocks = c["max_blocks_smx"]
    lim_warps = c["max_warps_smx"] // warps_block
    lim_regs = (c["regs_per_block"] // max(1, regs_per_thread * threads_per_block)) if regs_per_thread else 99
    lim_shared = (c["shared_kb"] * 1024 // shared_per_block) if shared_per_block else 99
    active_blocks = max(0, min(lim_threads, lim_blocks, lim_warps, lim_regs, lim_shared))
    active_warps = active_blocks * warps_block
    return {"active_blocks": active_blocks, "active_warps": active_warps, "max_warps": c["max_warps_smx"],
            "occupancy": round(active_warps / c["max_warps_smx"], 3),
            "limited_by": min([("threads", lim_threads), ("blocks", lim_blocks), ("warps", lim_warps),
                               ("registers", lim_regs), ("shared", lim_shared)], key=lambda x: x[1])[0]}


def snapshot():
    d = poll()
    m = dict(measured)
    if m["gflops_at"] and time.time() - m["gflops_at"] > 30:
        m["gflops"] = None               # stale: only show a compute number while work is recent
    return {"card": CARD, "live": d, "measured": m, "ts": time.time()}


# ---------------------------------------------------------------- the host CPU / memory (to prove GPU work leaves it alone)
_HOST = {"t": 0.0, "cores": None, "self": None, "out": None}


def _cpu_times():
    cores = []
    with open("/proc/stat") as f:
        for ln in f:
            if ln.startswith("cpu") and ln[3:4].isdigit():
                v = [int(x) for x in ln.split()[1:9]]
                idle = v[3] + v[4]
                cores.append((sum(v), idle))
    return cores


def _self_ticks():
    """CPU ticks used by the VectorFall server and every process it started (Console scripts, jobs)."""
    tot = 0
    me = os.getpid()
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open("/proc/{}/stat".format(pid)) as f:
                v = f.read().rsplit(")", 1)[1].split()
            tot += int(v[11]) + int(v[12])            # utime + stime
        except Exception:  # noqa: BLE001
            pass
    return tot, me


def host(force=False):
    now = time.time()
    if not force and _HOST["out"] and now - _HOST["t"] < 1.0:
        return _HOST["out"]
    cores = _cpu_times()
    st, _ = _self_ticks()
    prev, pself, pt = _HOST["cores"], _HOST["self"], _HOST["t"]
    pct = []
    if prev and len(prev) == len(cores):
        for (t1, i1), (t0, i0) in zip(cores, prev):
            dt = max(1, t1 - t0)
            pct.append(round(100.0 * (1 - (i1 - i0) / dt), 1))
    else:
        pct = [0.0] * len(cores)
    hz = os.sysconf("SC_CLK_TCK")
    self_pct = round(100.0 * (st - pself) / hz / max(1e-3, now - pt), 1) if pself is not None else 0.0
    mem = {}
    with open("/proc/meminfo") as f:
        for ln in f:
            k, v = ln.split(":", 1)
            mem[k] = int(v.split()[0])
    with open("/proc/loadavg") as f:
        la = [float(x) for x in f.read().split()[:3]]
    model = ""
    try:
        with open("/proc/cpuinfo") as f:
            for ln in f:
                if ln.startswith("model name"):
                    model = ln.split(":", 1)[1].strip()
                    break
    except Exception:  # noqa: BLE001
        pass
    out = {"cores": pct, "cpu": round(sum(pct) / max(1, len(pct)), 1), "n": len(pct), "model": model, "load": la,
           "mem_total_mb": mem.get("MemTotal", 0) // 1024, "mem_used_mb": (mem.get("MemTotal", 0) - mem.get("MemAvailable", 0)) // 1024,
           "swap_used_mb": (mem.get("SwapTotal", 0) - mem.get("SwapFree", 0)) // 1024,
           "vectorfall_cpu": self_pct}               # % of ONE core used by VectorFall + its children
    _HOST.update(t=now, cores=cores, self=st, out=out)
    return out
