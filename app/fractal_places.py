"""Fractal places: named pins with their exact centre, kept on the server so every device sees the same atlas, plus a
log of where the explorer has been. A place stores its geometry exactly (centre as decimal strings, the view width)
and its look separately (palette, colour density), so "the same place, another look" stays one place."""
import json
import math
import os
import threading
import time
import uuid

ROOT = os.path.join(os.environ.get("VF_DATA", "/srv/data"), "fractal")
_LOCK = threading.Lock()

# well-known regions of the Mandelbrot set (Mu-ency / MathWorld colloquial names), centre and rough radius
REGIONS = [
    ("Seahorse Valley", -0.745, 0.11, 0.05), ("Seahorse Valley", -0.745, -0.11, 0.05),
    ("Elephant Valley", 0.28, 0.008, 0.035), ("Elephant Valley", 0.28, -0.008, 0.035),
    ("Triple Spiral Valley", -0.088, 0.654, 0.03), ("Triple Spiral Valley", -0.088, -0.654, 0.03),
    ("Scepter Valley", -1.36, 0.0, 0.03), ("the Antenna", -1.85, 0.0, 0.16),
    ("the period-2 bulb", -1.0, 0.0, 0.25), ("the 1/3 bulb", -0.125, 0.745, 0.1), ("the 1/3 bulb", -0.125, -0.745, 0.1),
    ("the main cardioid", -0.1, 0.0, 0.45),
]


def _path(n):
    os.makedirs(ROOT, exist_ok=True)
    return os.path.join(ROOT, n)


def _load():
    p = _path("places.json")
    return json.load(open(p)) if os.path.exists(p) else []


def _save(rows):
    p = _path("places.json")
    with open(p + ".tmp", "w") as f:
        json.dump(rows, f, indent=1)
    os.replace(p + ".tmp", p)


def region_name(kind, cx, cy, scale):
    """A colloquial name for where a view is, and how deep."""
    try:
        x, y, s = float(cx), float(cy), float(scale)
    except ValueError:
        return "somewhere"
    zoom = 3.2 / s
    deep = "" if zoom < 50 else " · {}× deep".format(_zf(zoom))
    if kind != "mandelbrot":
        return "{}{}".format({"julia": "a Julia set", "burning-ship": "the Burning Ship", "tricorn": "the Tricorn"}.get(kind, kind), deep)
    best = None
    for nm, rx, ry, rr in REGIONS:
        d = math.hypot(x - rx, y - ry) / rr
        if d < 1 and (best is None or d < best[0]):
            best = (d, nm)
    return (best[1] if best else "the edge of the set") + deep


def _zf(z):
    if z < 1e4:
        return str(int(round(z)))
    e = int(math.floor(math.log10(z)))
    return "{:.1f}e{}".format(z / 10 ** e, e)


def listing():
    return {"places": _load()}


def add(kind, cx, cy, scale, name="", note="", palette="rosso", density=1.0, jr=-0.8, ji=0.156):
    from . import fractal
    with _LOCK:
        rows = _load()
        pid = uuid.uuid4().hex[:10]
        nm = (name or "").strip()[:80] or region_name(kind, cx, cy, scale)
        row = {"id": pid, "name": nm, "note": (note or "")[:500], "kind": kind, "cx": str(cx)[:200], "cy": str(cy)[:200], "scale": float(scale),
               "palette": palette, "density": float(density), "jr": float(jr), "ji": float(ji), "created": time.strftime("%Y-%m-%d %H:%M"),
               "region": region_name(kind, cx, cy, scale), "depth": round(max(0.0, math.log10(3.2 / float(scale))), 2)}
        rows.append(row)
        _save(rows)
    try:                                               # a small picture of the place, made once
        png, _ = fractal.render(kind, cx, cy, float(scale), 240, 160, 0, palette, jr, ji, density, "jpg")
        open(_path("thumb-" + pid + ".jpg"), "wb").write(png)
    except Exception:  # noqa: BLE001
        pass
    return row


def update(pid, name=None, note=None):
    with _LOCK:
        rows = _load()
        for r in rows:
            if r["id"] == pid:
                if name is not None:
                    r["name"] = name.strip()[:80] or r["name"]
                if note is not None:
                    r["note"] = note[:500]
                _save(rows)
                return r
    raise ValueError("no place " + pid)


def delete(pid):
    with _LOCK:
        rows = [r for r in _load() if r["id"] != pid]
        _save(rows)
    try:
        os.remove(_path("thumb-" + pid + ".jpg"))
    except OSError:
        pass
    return {"deleted": pid}


def thumb(pid):
    p = _path("thumb-" + "".join(c for c in pid if c.isalnum()) + ".jpg")
    return open(p, "rb").read() if os.path.exists(p) else None


def visit(kind, cx, cy, scale):
    """One settled view, appended to the visit log (kept to the last 20,000)."""
    line = json.dumps({"t": int(time.time()), "kind": kind, "cx": str(cx)[:60], "cy": str(cy)[:60], "scale": float(scale)})
    p = _path("visits.jsonl")
    with _LOCK:
        with open(p, "a") as f:
            f.write(line + "\n")
        if os.path.getsize(p) > 4_000_000:
            rows = open(p).read().splitlines()[-20000:]
            open(p, "w").write("\n".join(rows) + "\n")
    return {"ok": True}


def visits(kind, cx, cy, scale, limit=4000):
    """Visits inside (about) the current view: where the explorer has been here, as points with their depth."""
    p = _path("visits.jsonl")
    if not os.path.exists(p):
        return {"points": []}
    x, y, s = float(cx), float(cy), float(scale)
    out = []
    for ln in open(p).read().splitlines()[-20000:]:
        try:
            v = json.loads(ln)
        except ValueError:
            continue
        if v.get("kind") != kind:
            continue
        vx, vy = float(v["cx"]), float(v["cy"])
        if abs(vx - x) < s and abs(vy - y) < s:
            out.append([v["cx"], v["cy"], v["scale"], v["t"]])
    return {"points": out[-limit:]}


def kfr(kind, cx, cy, scale, iters=0):
    """The view as a Kalles Fraktaler parameter file (Zoom here = 4 / view width, so Zoom 1 shows a 4-wide view)."""
    return "Re: {}\r\nIm: {}\r\nZoom: {:.6E}\r\nIterations: {}\r\nRotate: 0\r\nRatio: 360\r\n".format(cx, cy, 4.0 / float(scale), int(iters) or 10000)


def parse_kfr(text):
    vals = {}
    for ln in (text or "").splitlines():
        if ":" in ln:
            k, v = ln.split(":", 1)
            vals[k.strip().lower()] = v.strip()
    if "re" not in vals or "im" not in vals:
        raise ValueError("this is not a .kfr: it needs Re: and Im: lines")
    z = float(vals.get("zoom", "1").replace(",", "."))
    return {"kind": "mandelbrot", "cx": vals["re"], "cy": vals["im"], "scale": 4.0 / max(z, 1e-300),
            "iterations": int(float(vals.get("iterations", "0") or 0))}
