"""The live simulations (Life & patterns) as batch models: run N ticks on the card, get the last frame and the metrics.
The Life app streams the same sims (sims.Runner) over a websocket; this is the same code, run to a fixed length."""
import base64
import time

from .. import sims
from ..registry import Blob, model

NAMES = {"reaction": "reaction_diffusion", "life": "game_of_life", "nbody": "nbody", "mandelbrot": "mandelbrot_zoom",
         "ising": "ising", "montecarlo": "monte_carlo_pi", "walks": "random_walks"}
_T = {"int": "int", "float": "float", "choice": "choice", "bool": "bool"}


def _register(sid, spec):
    fields = []
    for p in spec["params"]:
        f = {"k": p["k"], "type": _T.get(p.get("type"), "float"), "label": p.get("label", p["k"]), "default": p.get("default"), "soft": True}
        for x in ("min", "max"):
            if x in p:
                f[x] = p[x]
        if p.get("choices"):
            f["choices"] = list(p["choices"])
        fields.append(f)
    fields += [{"k": "ticks", "type": "int", "label": "Frames to run", "default": 30, "min": 1, "max": 100000},
               {"k": "iters", "type": "int", "label": "Steps per frame", "default": 1, "min": 1, "max": 100000},
               {"k": "seconds", "type": "float", "label": "…or stop after this many seconds (0 = run all frames)", "default": 0, "min": 0, "max": 3600}]

    def run(ticks, iters, seconds, **params):
        t0 = time.time()
        r = sims.Runner(sid, params)
        last, n, ms, gf = None, 0, 0.0, []
        for _ in range(ticks):
            last = r.tick(iters)
            n += 1
            ms += last["step_ms"]
            gf.append(last["gflops"])
            if seconds and time.time() - t0 > seconds:
                break
        png = base64.b64decode(last["frame"].split(",", 1)[1])
        meta = {"frames": n, "steps": n * iters, "compute_ms": round(ms, 1), "wall_s": round(time.time() - t0, 2),
                "gflops_mean": round(sum(gf) / len(gf), 1) if gf else 0, "gflops_peak": max(gf) if gf else 0, "metrics": last["metrics"]}
        return Blob(png, "image/png", "vectorfall-{}.png".format(sid), meta)
    model("life." + NAMES.get(sid, sid), spec["name"], "life", spec["desc"], output="image/png", fields=fields, timeout=3600,
          example={"ticks": 5})(run)


for _sid, _spec in sims.SIMS.items():
    _register(_sid, _spec)


@model("life.list", "Simulations", "life", "Every live simulation and its parameters.", device="cpu")
def sim_list():
    return [{k: s[k] for k in ("id", "name", "desc", "params", "flops_hint")} for s in sims.SIMS.values()]
