"""Find the NVIDIA card and describe it. The machine view, the core strip and the honest Cray comparison use this.

The CUDA driver API gives the facts (name, compute capability, SM count, clocks, memory bus, cache, PCIe) without a
CUDA context, so this module never competes with the GPU worker. A table per architecture adds what the driver does
not report: cores per SM, the FP64 rate, the warp-scheduler count and the memory type. Boards with a special FP64
rate (Tesla, Titan, Quadro GP100/GV100) are listed by name.
"""
import ctypes
import os

# compute capability (major, minor) -> architecture facts
ARCH = {
    (3, 0): ("Kepler", 192, 24, 4, 2048, 16, 64), (3, 2): ("Kepler", 192, 24, 4, 2048, 16, 64),
    (3, 5): ("Kepler", 192, 24, 4, 2048, 16, 64), (3, 7): ("Kepler", 192, 3, 4, 2048, 16, 64),
    (5, 0): ("Maxwell", 128, 32, 4, 2048, 32, 64), (5, 2): ("Maxwell", 128, 32, 4, 2048, 32, 64),
    (5, 3): ("Maxwell", 128, 32, 4, 2048, 32, 64),
    (6, 0): ("Pascal", 64, 2, 2, 2048, 32, 64), (6, 1): ("Pascal", 128, 32, 4, 2048, 32, 64),
    (6, 2): ("Pascal", 128, 32, 4, 2048, 32, 64),
    (7, 0): ("Volta", 64, 2, 4, 2048, 32, 64), (7, 2): ("Volta", 64, 2, 4, 2048, 32, 64),
    (7, 5): ("Turing", 64, 32, 4, 1024, 16, 32),
    (8, 0): ("Ampere", 64, 2, 4, 2048, 32, 64), (8, 6): ("Ampere", 128, 64, 4, 1536, 16, 48),
    (8, 7): ("Ampere", 128, 64, 4, 2048, 16, 64), (8, 9): ("Ada Lovelace", 128, 64, 4, 1536, 24, 48),
    (9, 0): ("Hopper", 128, 2, 4, 2048, 32, 64),
    (10, 0): ("Blackwell", 128, 2, 4, 2048, 32, 64), (12, 0): ("Blackwell", 128, 64, 4, 1536, 24, 48),
}
# boards whose FP64 rate differs from the rest of their architecture
FP64_BY_NAME = {"TITAN BLACK": 3, "TITAN Z": 3, "GTX TITAN": 3, "K20": 3, "K40": 3, "K6000": 3,
                "TITAN V": 2, "QUADRO GP100": 2, "QUADRO GV100": 2, "TESLA P100": 2, "TESLA V100": 2}
# a few boards whose watts the driver cannot read (Kepler has no power sensor)
TDP_BY_NAME = {"K420": 41, "K620": 45, "K1200": 45, "K2200": 68, "K4200": 108, "M4000": 120, "GTX 1080": 180}

# Cray reference points (peak, public figures)
CRAY1_MFLOPS, CRAY2_GFLOPS, C90_GFLOPS = 160, 1.9, 16.0

_A = {"MAX_THREADS_PER_BLOCK": 1, "MAX_SHARED_MEMORY_PER_BLOCK": 8, "WARP_SIZE": 10, "MAX_REGISTERS_PER_BLOCK": 12,
      "CLOCK_RATE": 13, "MULTIPROCESSOR_COUNT": 16, "KERNEL_EXEC_TIMEOUT": 17, "MEMORY_CLOCK_RATE": 36,
      "GLOBAL_MEMORY_BUS_WIDTH": 37, "L2_CACHE_SIZE": 38, "PCI_BUS_ID": 33, "COMPUTE_CAPABILITY_MAJOR": 75,
      "COMPUTE_CAPABILITY_MINOR": 76}


def _driver_facts(ordinal=0):
    lib = ctypes.CDLL("libcuda.so.1")
    if lib.cuInit(0) != 0:
        raise RuntimeError("cuInit failed: no usable NVIDIA driver")
    dev = ctypes.c_int()
    if lib.cuDeviceGet(ctypes.byref(dev), ordinal) != 0:
        raise RuntimeError("no NVIDIA GPU is visible to this container")
    name = ctypes.create_string_buffer(256)
    lib.cuDeviceGetName(name, 256, dev)
    mem = ctypes.c_size_t()
    lib.cuDeviceTotalMem_v2(ctypes.byref(mem), dev)
    out = {"name": name.value.decode(errors="replace"), "mem_bytes": mem.value}
    for k, code in _A.items():
        v = ctypes.c_int()
        lib.cuDeviceGetAttribute(ctypes.byref(v), code, dev)
        out[k] = v.value
    return out


def _mem_type(arch, name, bus):
    n = name.upper()
    if "K420" in n or "K600" in n:
        return "GDDR3"
    if arch in ("Volta", "Hopper") or "P100" in n or "GP100" in n or (arch == "Ampere" and bus >= 4096):
        return "HBM2"
    if arch == "Blackwell":
        return "GDDR7"
    if "1080" in n or "TITAN X" in n or arch == "Ampere" and ("3080" in n or "3090" in n):
        return "GDDR5X" if arch == "Pascal" else "GDDR6X"
    return "GDDR6" if arch in ("Turing", "Ampere", "Ada Lovelace") else "GDDR5"


def _pcie():
    """Link generation and width from nvidia-smi (the driver API does not give them)."""
    import subprocess
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=pcie.link.gen.max,pcie.link.width.max",
                              "--format=csv,noheader,nounits", "-i", os.environ.get("VF_GPU_INDEX", "0")],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=5).stdout
        g, w = [x.strip() for x in out.strip().splitlines()[0].split(",")]
        return "%s.0 x%s" % (g, w)
    except Exception:  # noqa: BLE001
        return "unknown"


def _cray(fp32, fp64):
    if fp64 >= C90_GFLOPS * 4:
        c90 = "~= %d Cray C90s (1991)" % round(fp64 / C90_GFLOPS)
    elif fp64 >= C90_GFLOPS * 0.75:
        c90 = "~= a 16-processor Cray C90 (1991)"
    else:
        c90 = "~= %d Cray-2s (1985)" % max(1, round(fp64 / CRAY2_GFLOPS))
    return {"cray1_mflops": CRAY1_MFLOPS, "cray2_gflops": CRAY2_GFLOPS, "c90_gflops": C90_GFLOPS,
            "fp32_in_cray1s": round(fp32 * 1000 / CRAY1_MFLOPS), "fp64_vs_c90": c90}


def describe(ordinal=0):
    f = _driver_facts(ordinal)
    cc = (f["COMPUTE_CAPABILITY_MAJOR"], f["COMPUTE_CAPABILITY_MINOR"])
    arch, cps, fp64r, sched, thr_sm, blk_sm, warps_sm = ARCH.get(cc) or ARCH[max(k for k in ARCH if k <= cc)]
    name, up = f["name"], f["name"].upper()
    fp64r = next((r for k, r in FP64_BY_NAME.items() if k in up), fp64r)
    sms, clk = f["MULTIPROCESSOR_COUNT"], f["CLOCK_RATE"] / 1000.0
    cores = sms * cps
    fp32 = round(cores * 2 * clk / 1000.0, 1)
    fp64 = round(fp32 / fp64r, 1)
    bus = f["GLOBAL_MEMORY_BUS_WIDTH"]
    mtype = _mem_type(arch, name, bus)
    # the driver reports half the effective data rate (kHz), so x2 for bytes per second on every memory type
    bw = round(f["MEMORY_CLOCK_RATE"] * 1000.0 * 2 * bus / 8 / 1e9, 1) if bus else None
    mem_mb = round(f["mem_bytes"] / 2 ** 20)
    sm_word = "SMX" if arch == "Kepler" else "SM"
    return {
        "name": name.replace("NVIDIA ", "").replace("GeForce ", "GeForce "), "arch": arch,
        "cc": "%d.%d (sm_%d%d)" % (cc[0], cc[1], cc[0], cc[1]), "cc_tuple": list(cc),
        "cores": cores, "smx": sms, "sm_word": sm_word, "cores_per_sm": cps,
        "sm_clock_mhz": round(clk), "mem_mb": mem_mb, "mem_type": mtype, "mem_bus_bits": bus,
        "mem_bandwidth_gbs": bw, "l2_kb": f["L2_CACHE_SIZE"] // 1024,
        "shared_kb": f["MAX_SHARED_MEMORY_PER_BLOCK"] // 1024, "pcie": _pcie(),
        "tdp_w": next((w for k, w in TDP_BY_NAME.items() if k in up), None),
        "fp32_gflops": fp32, "fp64_gflops": fp64, "fp64_ratio": fp64r,
        "max_threads_smx": thr_sm, "max_blocks_smx": blk_sm, "max_warps_smx": warps_sm,
        "warp_size": f["WARP_SIZE"] or 32, "regs_per_block": f["MAX_REGISTERS_PER_BLOCK"], "warp_schedulers": sched,
        # a display is attached: the driver stops any single kernel that runs longer than ~2 s
        "watchdog": bool(f["KERNEL_EXEC_TIMEOUT"]),
        "cray": _cray(fp32, fp64),
    }


# the K420 nameplate, used only when no driver is reachable (UI development without a GPU)
FALLBACK = {
    "name": "no GPU found", "arch": "unknown", "cc": "-", "cc_tuple": [0, 0], "cores": 0, "smx": 0, "sm_word": "SM",
    "cores_per_sm": 0, "sm_clock_mhz": 0, "mem_mb": 0, "mem_type": "-", "mem_bus_bits": 0, "mem_bandwidth_gbs": None,
    "l2_kb": 0, "shared_kb": 48, "pcie": "-", "tdp_w": None, "fp32_gflops": 0, "fp64_gflops": 0, "fp64_ratio": 1,
    "max_threads_smx": 2048, "max_blocks_smx": 16, "max_warps_smx": 64, "warp_size": 32, "regs_per_block": 65536,
    "warp_schedulers": 4, "watchdog": True, "cray": _cray(0, 0),
}


def detect():
    try:
        return describe(0)
    except Exception as e:  # noqa: BLE001
        d = dict(FALLBACK)
        d["error"] = str(e)[:200]
        return d


# ---------------------------------------------------------------- how much GPU work one kernel launch may carry
# Long GPU work runs as a chain of short launches that carry their state on the card. The base sizes in the code were
# tuned on the Quadro K420 (336 GFLOP/s FP32, display watchdog ~2 s). A faster card does the same work in less time,
# so it can take proportionally bigger launches and still stay far inside the watchdog; a card with no watchdog
# (no display attached) can take bigger ones again. Fewer launches = less Python and launch overhead.
K420_FP32_GFLOPS, K420_BANDWIDTH_GBS = 336.0, 28.8


def work_scale(card=None, bound="compute"):
    """How many times the K420's per-launch work this card may take: 1.0 on a K420, more on faster cards.
    bound="memory" scales by memory bandwidth instead of FP32 rate (for kernels that stream arrays)."""
    c = card
    if c is None:
        from . import gpu
        c = gpu.CARD
    s = max(1.0, float(c.get("fp32_gflops") or 0) / K420_FP32_GFLOPS)
    if bound == "memory":
        s = min(s, max(1.0, float(c.get("mem_bandwidth_gbs") or 0) / K420_BANDWIDTH_GBS))
    elif bound == "fp64":
        s = max(1.0, float(c.get("fp64_gflops") or 0) / (K420_FP32_GFLOPS / 24.0))
    if not c.get("watchdog", True):
        s *= 4.0
    return min(s, 256.0)


def launch_budget(base, card=None, cap=None, bound="compute"):
    """Scale a per-launch work size (iterations, steps, items) tuned on the K420 to this card."""
    v = base * work_scale(card, bound)
    return int(min(v, cap) if cap else v)


def gpu_card():
    from . import gpu
    return gpu.CARD
