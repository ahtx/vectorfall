"""General Monte Carlo on the card. Three generic engines, not toys:

1. series  — give it any progression of numbers. It measures the step-to-step changes, bins them, learns how one
   bin leads to the next (a Markov chain over bins), then projects thousands of futures by sampling that chain.
   Works on stock prices, sensor logs, metrics, anything that moves.
2. states  — define labelled states and the chances of moving between them; it Monte-Carlos the chain and reports
   where you end up, how long you spend in each state, and absorption / first-passage.
3. finance — the series engine applied to prices (log-returns), with a cone, Value-at-Risk, probability of a target
   and the distribution of the worst drawdown; plus correlations across several series.

Everything heavy runs on the GPU via cuRAND and a few vectorised passes over `paths` at once.
"""
import math
import re
import time

import numpy as np

import cupy as cp

from . import engine
from .engine import run_on_gpu, sync


def parse_series(text):
    nums = re.findall(r"-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?", text or "")
    return [float(x) for x in nums]


def _bin_edges(d, bins, mode):
    if mode == "quantile":
        qs = np.linspace(0, 100, bins + 1)
        e = np.percentile(d, qs)
        e[0], e[-1] = -np.inf, np.inf
        e = np.unique(e)
        return e
    lo, hi = float(d.min()), float(d.max())
    pad = (hi - lo) * 0.001 + 1e-9
    e = np.linspace(lo - pad, hi + pad, bins + 1)
    e[0], e[-1] = -np.inf, np.inf
    return e


def series(p):
    s_all = np.asarray(p["series"], np.float64)
    if s_all.size < 5:
        raise ValueError("give at least 5 numbers (one per line, or comma-separated)")
    win = int(p.get("window", 0) or 0)                  # learn the moves only from the last `win` steps (0 = all)
    s = s_all[-(win + 1):] if win and win + 1 < s_all.size else s_all
    if s.size < 5:
        s = s_all[-5:]
    delta = p.get("delta", "absolute")
    if delta == "percent":
        d = np.diff(s) / np.maximum(np.abs(s[:-1]), 1e-9)
    elif delta == "log":
        d = np.diff(np.log(np.maximum(s, 1e-9)))
    else:
        d = np.diff(s)
    bins = int(p.get("bins", 7))
    edges = _bin_edges(d, bins, p.get("binby", "quantile"))
    B = len(edges) - 1
    b = np.clip(np.digitize(d, edges) - 1, 0, B - 1)
    # transition counts between consecutive bins (Markov over bins), or marginal if iid
    conditional = bool(p.get("conditional", True))
    T = np.zeros((B, B), np.float64)
    for i in range(len(b) - 1):
        T[b[i], b[i + 1]] += 1
    marg = np.bincount(b, minlength=B).astype(np.float64)
    if conditional:
        rowsum = T.sum(1, keepdims=True)
        P = np.where(rowsum > 0, T / np.maximum(rowsum, 1), marg / marg.sum())
    else:
        P = np.tile(marg / marg.sum(), (B, 1))
    # perturbations of the learned history: persistence blends toward "stay in the same bin" (+) or toward "any bin"
    persist = float(p.get("persist", 0) or 0)
    if persist > 0:
        P = (1 - persist) * P + persist * np.eye(B)
    elif persist < 0:
        P = (1 + persist) * P + (-persist) * np.tile(marg / marg.sum(), (B, 1))
    vol = float(p.get("vol", 1) or 1)
    drift = float(p.get("drift", 0) or 0)
    # empirical pool of deltas per bin (preserves the real shape of the moves)
    order = np.argsort(b)
    bs = b[order]
    pool = d[order].astype(np.float32)
    off = np.r_[0, np.cumsum(np.bincount(bs, minlength=B))].astype(np.int64)
    length = np.diff(off).astype(np.int64)
    for j in range(B):                                 # bins with no samples fall back to all deltas
        if length[j] == 0:
            pool = np.r_[pool, d.astype(np.float32)]
            off = np.r_[off[:-1], off[-1], off[-1] + d.size].astype(np.int64)
    if vol != 1 or drift:                              # each move scaled around the average move (the trend stays), then shifted
        m = float(d.mean())
        pool = (m + (pool - m) * vol + drift).astype(np.float32)
    horizon = int(p.get("horizon", 60))
    paths = int(min(200000, max(2000, engine.budget_bytes(120) // (horizon * 4 + 64))))
    v0 = float(s_all[-1])
    b0 = int(b[-1])

    def job():
        t0 = time.time()
        cumP = cp.asarray(np.cumsum(P, axis=1).astype(np.float32))
        gpool = cp.asarray(pool)
        goff = cp.asarray(off)
        glen = cp.asarray(length.astype(np.int64))
        cur = cp.full(paths, b0, cp.int32)
        val = cp.full(paths, v0, cp.float64)
        bands = []
        rng = cp.random.random
        for _ in range(horizon):
            r = rng(paths, dtype=cp.float32)
            nb = (cumP[cur] < r[:, None]).sum(axis=1).astype(cp.int32)
            nb = cp.clip(nb, 0, B - 1)
            ln = cp.maximum(glen[nb], 1)
            idx = goff[nb] + (rng(paths, dtype=cp.float32) * ln.astype(cp.float32)).astype(cp.int64)
            dd = gpool[cp.clip(idx, 0, gpool.size - 1)].astype(cp.float64)
            if delta == "percent" or delta == "log":
                val = val * cp.exp(dd) if delta == "log" else val * (1 + dd)
            else:
                val = val + dd
            cur = nb
            q = cp.percentile(val, cp.asarray([5, 25, 50, 75, 95], cp.float64))
            bands.append([float(x) for x in cp.asnumpy(q)])
        final = cp.asnumpy(val)
        sync()
        return bands, final, time.time() - t0
    bands, final, dt = run_on_gpu(job, "series Monte Carlo", 120)
    x = list(range(len(s_all), len(s_all) + horizon))
    q = np.percentile(final, [5, 25, 50, 75, 95])
    trend = "rising" if q[2] > v0 else "falling"
    def H(v):                                          # 1.45 trillion, not 1.446e+12
        a = abs(v)
        for n, w in ((1e12, "trillion"), (1e9, "billion"), (1e6, "million")):
            if a >= n:
                return "{:.3g} {}".format(v / n, w)
        return "{:.4g}".format(v)
    sentence = ("From {}, the median path ends near {} after {} steps ({}). The middle 90% of futures land "
                "between {} and {}.").format(H(v0), H(q[2]), horizon, trend, H(q[0]), H(q[4]))
    pert = [t for t in ["volatility ×{:g}".format(vol) if vol != 1 else "",
                        "regime spells {} ({:+.0%})".format("longer" if persist > 0 else "shorter", persist) if persist else "",
                        "drift {:+g} per step".format(drift) if drift else "",
                        "moves learned from the last {} steps".format(len(s) - 1) if s is not s_all else ""] if t]
    if pert:
        sentence += " Changed from the history: " + ", ".join(pert) + "."
    hist, hedges = np.histogram(final, 50)
    return {"headline": H(q[2]).replace(" trillion", "T").replace(" billion", "B").replace(" million", "M"), "sentence": sentence, "tone": "good",
            "chart": {"type": "fan", "x": [len(s) - 1] + x, "bands": [[v0] * 5] + bands, "unit": ""},
            "history": {"x": list(range(len(s_all))), "y": [float(v) for v in s_all]},
            "chart2": {"type": "hist", "edges": hedges.tolist(), "y": hist.tolist(), "title": "Where it ends up"},
            "transition": {"edges": [round(float(e), 4) if np.isfinite(e) else ("-inf" if e < 0 else "inf") for e in edges],
                           "matrix": np.round(P, 3).tolist(), "counts": marg.astype(int).tolist()},
            "facts": [["paths", "{:,}".format(paths)], ["bins", B], ["steps", horizon],
                      ["model", "Markov on bins" if conditional else "independent draws"]],
            "paths": paths, "ms": round(dt * 1000, 1)}


def states(p):
    labels = [s.strip() for s in (p.get("states") or "").split(",") if s.strip()]
    if len(labels) < 2:
        raise ValueError("define at least two states, for example states = Healthy, Sick, Recovered")
    idx = {l.lower(): i for i, l in enumerate(labels)}
    n = len(labels)
    T = np.zeros((n, n), np.float64)
    for ln in (p.get("transitions") or "").splitlines():
        m = re.match(r"\s*(.+?)\s*->\s*(.+?)\s*[:=]\s*([\d.]+)\s*$", ln)
        if m and m.group(1).strip().lower() in idx and m.group(2).strip().lower() in idx:
            T[idx[m.group(1).strip().lower()], idx[m.group(2).strip().lower()]] = float(m.group(3))
    for i in range(n):                                  # a state with no outgoing links stays put (absorbing)
        if T[i].sum() == 0:
            T[i, i] = 1.0
    P = T / T.sum(1, keepdims=True)
    start = idx.get((p.get("start") or labels[0]).lower(), 0)
    steps = int(p.get("steps", 40))
    paths = int(min(500000, max(5000, engine.budget_bytes(120) // (steps + 64))))

    def job():
        t0 = time.time()
        cumP = cp.asarray(np.cumsum(P, axis=1).astype(np.float32))
        cur = cp.full(paths, start, cp.int32)
        dist = []
        time_in = cp.zeros(n, cp.float64)
        first_hit = cp.full((paths, n), -1, cp.int32)
        for t in range(steps):
            oh = cp.zeros((n,), cp.float64)
            counts = cp.bincount(cur, minlength=n).astype(cp.float64)
            dist.append([float(x) for x in cp.asnumpy(counts / paths)])
            time_in += counts
            for s_ in range(n):
                mask = (cur == s_) & (first_hit[:, s_] < 0)
                first_hit[mask, s_] = t
            r = cp.random.random(paths, dtype=cp.float32)
            cur = cp.clip((cumP[cur] < r[:, None]).sum(axis=1).astype(cp.int32), 0, n - 1)
            _ = oh
        final = cp.asnumpy(cp.bincount(cur, minlength=n).astype(cp.float64) / paths)
        avg_time = cp.asnumpy(time_in / paths)
        fh = cp.asnumpy(cp.where(first_hit < 0, steps + 1, first_hit).astype(cp.float64).mean(0))
        sync()
        return dist, final, avg_time, fh, time.time() - t0
    dist, final, avg_time, fh, dt = run_on_gpu(job, "state machine", 120)
    end = int(np.argmax(final))
    sentence = "After {} steps, most paths are in “{}” ({:.0f}%). On average a path spends {:.1f} steps in “{}”.".format(
        steps, labels[end], final[end] * 100, max(avg_time), labels[int(np.argmax(avg_time))])
    return {"headline": labels[end], "sentence": sentence, "tone": "good",
            "chart": {"type": "lines", "x": list(range(steps)), "unit": "%",
                      "series": [{"name": labels[i], "y": [d[i] for d in dist]} for i in range(n)]},
            "chart2": {"type": "hbars", "labels": labels, "y": [float(x) for x in final], "title": "Final state mix"},
            "facts": [["paths", "{:,}".format(paths)], ["states", n], ["steps", steps]] +
                     [["avg steps in {}".format(labels[i]), round(float(avg_time[i]), 1)] for i in range(min(n, 4))],
            "paths": paths, "ms": round(dt * 1000, 1), "labels": labels}


def finance(p):
    s = np.asarray(p["series"], np.float64)
    if s.size < 10:
        raise ValueError("give at least 10 prices")
    r = np.diff(np.log(np.maximum(s, 1e-9)))            # log returns
    horizon = int(p.get("horizon", 60))
    paths = int(min(300000, max(5000, engine.budget_bytes(120) // (horizon * 4 + 64))))
    v0 = float(s[-1])
    model = p.get("model", "bootstrap")
    mu, sd = float(r.mean()), float(r.std())

    def job():
        t0 = time.time()
        if model == "gbm":
            steps = cp.random.normal(mu, sd, (paths, horizon)).astype(cp.float32)
        else:                                          # empirical bootstrap of real returns (keeps fat tails)
            pool = cp.asarray(r.astype(cp.float32))
            idx = cp.random.randint(0, pool.size, (paths, horizon))
            steps = pool[idx]
        logpath = cp.cumsum(steps, axis=1)
        vals = v0 * cp.exp(logpath)
        running_max = cp.full(vals.shape[0], v0, cp.float32)
        worst = cp.zeros(vals.shape[0], cp.float32)
        for t in range(vals.shape[1]):                 # cumulative max (no ufunc.accumulate in CuPy 9.6)
            running_max = cp.maximum(running_max, vals[:, t])
            worst = cp.minimum(worst, (vals[:, t] - running_max) / running_max)
        drawdown = worst
        final = vals[:, -1]
        bands = [[float(x) for x in cp.asnumpy(cp.percentile(vals[:, t], cp.asarray([5, 25, 50, 75, 95], cp.float64)))]
                 for t in range(horizon)]
        fin = cp.asnumpy(final)
        dd = cp.asnumpy(drawdown)
        sync()
        return bands, fin, dd, time.time() - t0
    bands, final, dd, dt = run_on_gpu(job, "financial Monte Carlo", 120)
    q = np.percentile(final, [5, 25, 50, 75, 95])
    ret = (q[2] / v0 - 1) * 100
    var95 = (np.percentile(final, 5) / v0 - 1) * 100
    target = float(p.get("target", 0))
    phit = float((final >= target).mean()) if target else None
    sentence = ("Median outcome {:.4g} ({:+.1f}%) after {} steps. There is a 5% chance of a loss of {:.1f}% or more "
                "(Value-at-Risk). Typical worst drawdown along the way: {:.1f}%.").format(
        q[2], ret, horizon, abs(var95), abs(np.median(dd) * 100))
    if target:
        sentence += " Chance to get to {:.4g}: {:.0f}%.".format(target, phit * 100)
    hist, hedges = np.histogram(final, 50)
    return {"headline": "{:+.1f}%".format(ret), "sentence": sentence, "tone": "good" if ret >= 0 else "warn",
            "chart": {"type": "fan", "x": [len(s) - 1] + list(range(len(s), len(s) + horizon)), "bands": [[v0] * 5] + bands, "unit": "$"},
            "history": {"x": list(range(len(s))), "y": [float(v) for v in s]},
            "chart2": {"type": "hist", "edges": hedges.tolist(), "y": hist.tolist(), "marker": target or None, "title": "Final price distribution"},
            "facts": [["paths", "{:,}".format(paths)], ["model", "empirical bootstrap" if model == "bootstrap" else "lognormal (GBM)"],
                      ["drift/step", "{:+.3%}".format(mu)], ["volatility/step", "{:.2%}".format(sd)],
                      ["VaR 95%", "{:.1f}%".format(var95)], ["worst drawdown (median)", "{:.1f}%".format(np.median(dd) * 100)]],
            "paths": paths, "ms": round(dt * 1000, 1)}


ENGINES = {
    "series": {"name": "Project a series", "icon": "trend",
               "blurb": "Give it a series of numbers. It learns the moves from step to step as a Markov chain over bins, and projects thousands of futures.",
               "fields": [{"k": "series", "type": "text", "label": "Your numbers (one per line or comma-separated)", "src": "column",
                           "default": "100\n102\n101\n105\n108\n106\n110\n115\n113\n118\n120\n117\n122\n128\n125\n130"},
                          {"k": "delta", "type": "choice", "label": "Measure change as", "choices": ["absolute", "percent", "log"], "default": "percent"},
                          {"k": "bins", "type": "int", "label": "Bins", "default": 7, "min": 3, "max": 20},
                          {"k": "binby", "type": "choice", "label": "Bin by", "choices": ["quantile", "equal"], "default": "quantile"},
                          {"k": "conditional", "type": "bool", "label": "Markov (bin depends on the last)", "default": True},
                          {"k": "horizon", "type": "int", "label": "Project steps", "default": 60, "min": 5, "max": 500},
                          {"k": "vol", "type": "float", "label": "Volatility × (1.1 = 10% more)", "default": 1.0, "min": 0.5, "max": 2.5},
                          {"k": "persist", "type": "float", "label": "Regime persistence (+0.1 = spells last longer)", "default": 0.0, "min": -1.0, "max": 1.0},
                          {"k": "drift", "type": "float", "label": "Drift shift per step (in the change unit)", "default": 0.0, "min": -0.5, "max": 0.5},
                          {"k": "window", "type": "int", "label": "Learn from the last N steps (0 = all)", "default": 0, "min": 0, "max": 5000}]},
    "states": {"name": "State machine", "icon": "states",
               "blurb": "Define labelled states and the chance to move between them. Then run a Monte Carlo simulation of the chain.",
               "fields": [{"k": "states", "type": "str", "label": "States (comma-separated)", "default": "Healthy, Sick, Recovered, Deceased"},
                          {"k": "transitions", "type": "text", "label": "Transitions — one per line: From -> To : chance",
                           "default": "Healthy -> Sick : 0.05\nHealthy -> Healthy : 0.95\nSick -> Recovered : 0.4\nSick -> Sick : 0.55\nSick -> Deceased : 0.05\nRecovered -> Recovered : 1"},
                          {"k": "start", "type": "str", "label": "Start in", "default": "Healthy"},
                          {"k": "steps", "type": "int", "label": "Steps", "default": 40, "min": 2, "max": 400}]},
    "finance": {"name": "Stock / financial", "icon": "coin",
                "blurb": "Project a price with empirical Monte Carlo: a cone of outcomes, Value-at-Risk, drawdowns and the chance of a target.",
                "fields": [{"k": "series", "type": "text", "label": "Prices (one per line)",
                            "default": "100\n101\n99\n103\n105\n102\n108\n110\n107\n112\n115\n111\n118\n120\n116\n122\n125\n121\n128\n130"},
                           {"k": "model", "type": "choice", "label": "Model", "choices": ["bootstrap", "gbm"], "default": "bootstrap"},
                           {"k": "horizon", "type": "int", "label": "Days ahead", "default": 60, "min": 5, "max": 500},
                           {"k": "target", "type": "float", "label": "Target price (0 = none)", "default": 0, "min": 0, "max": 100000}]},
}
RUN = {"series": series, "states": states, "finance": finance}

# the general-purpose random-walk constraint solver (app/walksolve.py)
from . import walksolve  # noqa: E402
ENGINES["solve"] = walksolve.SPEC
RUN["solve"] = walksolve.run

# Monte Carlo on your own numbers: budgets from estimates, the next periods from history (app/montecarlo.py)
from . import montecarlo  # noqa: E402
ENGINES.update(montecarlo.SPECS)
RUN.update(montecarlo.RUN)


def run(eid, params):
    spec = ENGINES[eid]
    p = {}
    for f in spec["fields"]:
        v = params.get(f["k"], f["default"])
        if f["type"] == "text" and f["k"] in ("series",):
            v = parse_series(v if isinstance(v, str) else "")
            if not v:
                v = parse_series(f["default"])
        elif f["type"] == "text":
            v = v if isinstance(v, str) else f["default"]
        elif f["type"] == "bool":
            v = bool(v)
        elif f["type"] == "int":
            v = int(float(v))
        elif f["type"] == "float":
            v = float(v)
        p[f["k"]] = v
    return RUN[eid](p)
