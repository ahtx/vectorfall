"""Console: run a snippet of Python (NumPy on the CPU, CuPy on the card) in its own process, so a runaway loop can be
stopped without touching the rest of VectorFall. Results come back as a list of outputs: printed text, images, plots,
tables and CPU-vs-GPU races.
"""
import json
import re
import os
import subprocess
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNING = {}

EXAMPLES = [
    {"id": "hello", "title": "Hello, card", "code": '''# Hello, card: make 10 million random numbers on the GPU and summarise them.
import cupy as cp       # cp = NumPy's functions, but the arrays live on the card (GPU)
import vf               # VectorFall's helpers: show / plot / table / race / timeit

x = cp.random.random(10_000_000, dtype=cp.float32)    # GPU: 40 MB of numbers made on the card
mean, std = float(x.mean()), float(x.std())           # GPU computes; float() copies each answer to the CPU
print("mean", mean, " std", std)                      # CPU: Python prints
ms = vf.timeit(lambda: cp.sort(x))                    # GPU: sort them 5 times, average the time
print("sorted 10 million numbers in", round(ms, 1), "ms")
'''},
    {"id": "race", "title": "CPU vs GPU race", "code": '''# CPU vs GPU race: one function, run once with NumPy (CPU) and once with CuPy (GPU).
import numpy as np      # np = arrays and maths on the CPU
import cupy as cp       # cp = the same functions on the GPU
import vf

def multiply(xp, n):                        # xp is a module: np or cp. Same code works for both.
    a = xp.ones((n, n), dtype=xp.float32)   # an n x n matrix of ones, on whichever side xp is
    return a @ a                            # @ = matrix multiplication (a * a would be element by element)

# vf.race calls multiply(np, 2000) on the CPU, then multiply(cp, 2000) on the card, and times both.
# The CPU side is NumPy on one host core (VectorFall pins NumPy to one thread).
vf.race(multiply, 2000)
'''},
    {"id": "fft", "title": "Hear the maths: a chord's spectrum", "code": '''# Build one second of an A-major chord on the card, then find its notes with an FFT.
import math
import cupy as cp
import vf

sr = 44100                                                  # samples per second
t = cp.arange(sr, dtype=cp.float32) / sr                    # GPU: the time of each sample
chord = sum(cp.sin(2 * math.pi * f * t) for f in (440.0, 554.37, 659.25))   # GPU: three sine waves added
spec = cp.abs(cp.fft.rfft(chord))[:2000]                    # GPU: cuFFT; strength of each frequency 0-2000 Hz
vf.plot(spec, title="Spectrum: three peaks = three notes")  # copies to the CPU and draws
peaks = cp.argsort(spec)[-3:]                               # GPU: the three strongest frequencies
print("notes found at", sorted(int(p) for p in peaks), "Hz")   # int() copies each one back
'''},
    {"id": "art", "title": "Make art: a Julia set", "code": '''# Every pixel is its own little computation, all 1.6 million of them at once.
import cupy as cp
import vf

w, h = 1600, 1000
y, x = cp.mgrid[-1.0:1.0:h * 1j, -1.6:1.6:w * 1j]   # GPU: the coordinates of every pixel
z = (x + 1j * y).astype(cp.complex64)               # one complex number per pixel
c = cp.complex64(-0.8 + 0.156j)
n = cp.zeros(z.shape, cp.float32)                   # how long each pixel stays bounded
for i in range(120):                                # CPU loop: 120 short GPU launches (the 2-second rule)
    z = z * z + c                                   # GPU: every pixel at once
    n += cp.abs(z) < 2
vf.show(cp.sqrt(n), "Julia set, c = -0.8 + 0.156i") # copies the image to the CPU and shows it
'''},
    {"id": "text", "title": "Ask the text", "code": '''# Uses whatever corpus is loaded in the Text Engine. The searching runs in VectorFall's own GPU queue;
# this script just asks the server (over HTTP, on the CPU) and prints the answers.
import vf

r = vf.text.search("love")
print(r["count"], "matches in", r["gpu_ms"], "ms")
nxt = vf.text.near("I love")
vf.table([[i["word"], i["count"], i["p"]] for i in nxt["items"][:10]], ["next word", "count", "probability"])
print(vf.text.generate("I love", order=3, n=40)["text"])
'''},
    {"id": "walk", "title": "A million random walks", "code": '''# One million walkers take 1,000 steps each. How far do they get?
import cupy as cp
import vf

N = 1_000_000
pos = cp.zeros(N, cp.int32)                          # GPU: every walker starts at 0
# All 1,000 x 1,000,000 steps at once would need 1 GB, the whole card, so walk in batches of 25 steps.
for _ in range(40):                                  # CPU loop: 40 batches
    steps = cp.random.random((25, N), dtype=cp.float32) < 0.5     # GPU: 25 coin flips per walker
    pos += steps.sum(axis=0, dtype=cp.int32) * 2 - 25             # GPU: heads = +1, tails = -1
hist, edges = cp.histogram(pos, 80)                  # GPU: count walkers per distance bucket
vf.plot(edges[:-1], hist, kind="bar", title="Where a million walkers end up")
print("average distance from home:", float(cp.abs(pos).mean()))
'''},
    {"id": "image", "title": "Edge-detect a photo", "code": '''# Download a picture (CPU), then find its edges on the card (GPU).
import io
import urllib.request
import cupy as cp
import cupyx.scipy.ndimage as ndi     # SciPy's image routines, running on the GPU
from PIL import Image                 # Pillow: image files, on the CPU
import vf

# Wikimedia only serves its standard thumbnail widths (250, 330, 500, 960, 1280 ...); other sizes return HTTP 400.
url = "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e4/Cray-1-p1010221.jpg/960px-Cray-1-p1010221.jpg"
req = urllib.request.Request(url, headers={"User-Agent": "VectorFall/1.0 (homelab GPU console)"})
try:
    img = Image.open(io.BytesIO(urllib.request.urlopen(req, timeout=30).read())).convert("L")   # CPU
except Exception as e:                      # offline? draw a test card instead so the example still runs
    print("download failed:", e, "- using a generated test image")
    y, x = cp.mgrid[-1:1:600j, -1:1:900j]
    img = Image.fromarray(cp.asnumpy(((cp.sin(12 * cp.hypot(x, y)) > 0) * 200 + 30).astype(cp.uint8)))
g = cp.asarray(img, dtype=cp.float32)                  # copy the pixels CPU -> GPU
edges = cp.hypot(ndi.sobel(g, 0), ndi.sobel(g, 1))     # GPU: horizontal and vertical edge strength
vf.show(img, "a Cray-1")
vf.show(edges, "its edges, computed on the card")
'''},
]


LABELS = {}


def stop_all():
    for p in list(RUNNING.values()):
        try:
            p.kill()
        except Exception:  # noqa: BLE001
            pass


def activity():
    """Console scripts currently running on the card (for the top-bar activity list)."""
    return [{"src": "console", "label": "Console: " + LABELS.get(rid, ("script", 0))[0], "since": LABELS.get(rid, ("", time.time()))[1]}
            for rid in list(RUNNING)]


def _label_of(code, name):
    if name:
        return os.path.basename(name)
    for ln in code.splitlines():
        ln = ln.strip()
        if ln.startswith("#"):
            return ln.lstrip("# ").strip()[:48] or "script"
        if ln:
            break
    return "script"


def _merge(outputs):
    merged = []
    for o in outputs:                                  # join consecutive printed chunks
        if merged and o["type"] in ("stdout", "stderr") and merged[-1]["type"] == o["type"]:
            merged[-1]["text"] += o["text"]
        else:
            merged.append(o)
    return merged


RUNS = {}               # run id -> {"dir", "out", "proc", "t0", "timeout", "done", "killed", "wall", "stray", "seen"}


def start(code, timeout=60, name=""):
    """Start a script and return at once; poll() reads its outputs while it runs. The process and the time limit are
    the same as run(); Stop (stop_all) kills it."""
    import threading
    t0 = time.time()
    d = tempfile.mkdtemp(prefix="vfc-")
    src, out = os.path.join(d, "code.py"), os.path.join(d, "out.jsonl")
    with open(src, "w", encoding="utf-8") as f:
        f.write(code)
    open(out, "w").close()
    env = dict(os.environ, PYTHONUNBUFFERED="1",                 # `import lab` finds ~/scripts/lab.py
               PYTHONPATH=os.pathsep.join(x for x in (WORKSPACE, os.environ.get("PYTHONPATH", "")) if x))
    p = subprocess.Popen(["python3", os.path.join(HERE, "vfh.py"), src, out], cwd=WORKSPACE, env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    rid = str(p.pid)
    RUNNING[rid] = p
    LABELS[rid] = (_label_of(code, name), t0)
    r = {"id": rid, "dir": d, "src": src, "out": out, "proc": p, "t0": t0, "timeout": max(1, min(int(timeout), 600)),
         "done": False, "killed": False, "wall": None, "stray": "", "seen": time.time()}
    RUNS[rid] = r

    def wait():
        try:
            p.wait(timeout=r["timeout"])
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait()
            r["killed"] = True
        finally:
            RUNNING.pop(rid, None)
            LABELS.pop(rid, None)
        try:
            r["stray"] = p.stdout.read().decode("utf-8", "replace") if p.stdout else ""
        except Exception:  # noqa: BLE001
            r["stray"] = ""
        r["wall"] = round(time.time() - t0, 2)
        r["done"] = True
        _sweep()
    threading.Thread(target=wait, name="vfc-wait", daemon=True).start()
    return {"run": rid}


def _read(r):
    outputs = []
    try:
        with open(r["out"], encoding="utf-8") as f:
            data = f.read()
    except OSError:
        return outputs
    lines = data.split("\n")
    if not r["done"]:
        lines = lines[:-1]                              # the last line may still be half written
    for ln in lines:
        if ln.strip():
            try:
                outputs.append(json.loads(ln))
            except ValueError:
                continue
    return outputs


def _finish(r, outputs):
    if r["stray"].strip() and not outputs:
        outputs.append({"type": "stderr", "text": r["stray"][-4000:]})
    if r["killed"]:
        outputs.append({"type": "error", "text": "Stopped after {} s (time limit).".format(r["timeout"])})
    elif r["proc"].returncode not in (0, None) and not any(o.get("type") == "done" for o in outputs):
        outputs.append({"type": "error", "text": "Stopped (the script was killed)."})
    return outputs


def poll(rid, since=0):
    """The outputs of a run from index `since` on (the raw list, progress lines included), and whether it is done."""
    r = RUNS.get(str(rid))
    if not r:
        raise KeyError("no such run (runs are kept 10 minutes after they end)")
    r["seen"] = time.time()
    done = r["done"]
    outputs = _read(r)
    if done:
        outputs = _finish(r, outputs)
    return {"outputs": _merge([dict(o) for o in outputs[int(since):]]), "next": len(outputs), "done": done, "killed": r["killed"],
            "wall_s": r["wall"] if done else round(time.time() - r["t0"], 2)}


def _drop(r):
    for fn in (r["src"], r["out"]):
        try:
            os.remove(fn)
        except OSError:
            pass
    try:
        os.rmdir(r["dir"])
    except OSError:
        pass


def _sweep():
    """Forget finished runs that nobody read for 10 minutes."""
    now = time.time()
    for k, r in list(RUNS.items()):
        if r["done"] and now - r["seen"] > 600:
            RUNS.pop(k, None)
            _drop(r)


def run(code, timeout=60, name=""):
    """Run a script to the end and return every output (the manual, scripts and agents use this; the Console streams)."""
    rid = start(code, timeout, name)["run"]
    r = RUNS[rid]
    while not r["done"]:
        time.sleep(0.05)
    outputs = [o for o in _finish(r, _read(r)) if o.get("type") != "progress"]
    RUNS.pop(rid, None)
    _drop(r)
    return {"outputs": _merge(outputs), "wall_s": r["wall"], "killed": r["killed"]}


def stop_all():
    for p in list(RUNNING.values()):
        p.kill()
    return len(RUNNING)


# ---------------------------------------------------------------- files (the IDE's workspace)
WORKSPACE = "/srv/data/scripts"
os.makedirs(WORKSPACE, exist_ok=True)


def _safe(name):
    name = os.path.basename((name or "").strip()) or "untitled.py"
    if not re.match(r"^[\w .\-]+$", name):
        raise ValueError("bad file name")
    if not name.endswith((".py", ".txt", ".md", ".json", ".csv")):
        name += ".py"
    return name


def list_files():
    out = []
    for n in sorted(os.listdir(WORKSPACE)):
        p = os.path.join(WORKSPACE, n)
        if os.path.isfile(p):
            out.append({"name": n, "size": os.path.getsize(p), "modified": os.path.getmtime(p)})
    return out


def read_file(name):
    p = os.path.join(WORKSPACE, _safe(name))
    if not os.path.exists(p):
        raise KeyError(name)
    return open(p, encoding="utf-8", errors="replace").read()


def write_file(name, content):
    name = _safe(name)
    with open(os.path.join(WORKSPACE, name), "w", encoding="utf-8") as f:
        f.write(content or "")
    return {"name": name, "saved": True}


def delete_file(name):
    p = os.path.join(WORKSPACE, _safe(name))
    if os.path.exists(p):
        os.remove(p)
    return {"deleted": name}


def rename_file(old, new):
    o, n = os.path.join(WORKSPACE, _safe(old)), os.path.join(WORKSPACE, _safe(new))
    if not os.path.exists(o):
        raise ValueError("no file named " + _safe(old))
    if os.path.exists(n) and os.path.abspath(n) != os.path.abspath(o):
        raise ValueError(_safe(new) + " already exists")
    os.makedirs(os.path.dirname(n), exist_ok=True)
    os.rename(o, n)
    return {"name": _safe(new)}


# ---------------------------------------------------------------- the terminal (one shell line at a time)
def shell(cmd, timeout=30):
    """Run one shell command in the workspace. Local-only (gated in the API). This is the user's own container."""
    try:
        p = subprocess.run(["bash", "-lc", cmd], cwd=WORKSPACE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           timeout=max(1, min(int(timeout), 120)))
        out = p.stdout.decode("utf-8", "replace")
        return {"out": out[-20000:], "code": p.returncode}
    except subprocess.TimeoutExpired as e:
        return {"out": (e.stdout.decode("utf-8", "replace") if e.stdout else "") + "\n[timed out]", "code": 124}
    except Exception as e:  # noqa: BLE001
        return {"out": "{}: {}".format(type(e).__name__, e), "code": 1}




