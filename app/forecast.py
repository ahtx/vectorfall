"""Forecast: what-if planning with millions of simulated futures. Each scenario runs on the card (random numbers and
reductions stay on the GPU), then answers in one sentence with the chart that explains it.
"""
import math
import time

import numpy as np

import cupy as cp

from . import engine
from .engine import mark_gflops, run_on_gpu, sync

SCENARIOS = {
    "retirement": {
        "name": "Will my savings last?", "icon": "nest",
        "blurb": "A million possible market histories for your savings, from today to the end of the plan.",
        "params": [
            {"k": "age", "label": "Your age", "type": "int", "default": 45, "min": 18, "max": 90},
            {"k": "retire", "label": "Stop working at", "type": "int", "default": 65, "min": 30, "max": 90},
            {"k": "until", "label": "Plan until age", "type": "int", "default": 95, "min": 60, "max": 110},
            {"k": "savings", "label": "Savings today ($)", "type": "money", "default": 500000},
            {"k": "contrib", "label": "Added each year until retirement ($)", "type": "money", "default": 25000},
            {"k": "spend", "label": "Spent each year after retirement ($, today's money)", "type": "money", "default": 80000},
            {"k": "ret", "label": "Average return (%/yr)", "type": "float", "default": 6.5, "min": -5, "max": 20},
            {"k": "vol", "label": "Volatility (%/yr)", "type": "float", "default": 15, "min": 0, "max": 60},
            {"k": "infl", "label": "Inflation (%/yr)", "type": "float", "default": 2.8, "min": 0, "max": 15}]},
    "project": {
        "name": "When will the project finish?", "icon": "gantt",
        "blurb": "Give each task a best, likely and worst case. See the real chance that you finish by your date.",
        "params": [
            {"k": "tasks", "label": "Tasks (name, best, likely, worst days per line)", "type": "text",
             "default": "Design, 3, 5, 10\nBuild, 8, 12, 25\nTest, 3, 4, 9\nFix, 1, 3, 10\nLaunch, 1, 1, 3"},
            {"k": "deadline", "label": "Deadline (days from start)", "type": "int", "default": 30, "min": 1, "max": 2000}]},
    "queue": {
        "name": "How long is the wait?", "icon": "queue",
        "blurb": "People arrive at random, and each service takes a random time. How long does the line get, and who waits longest?",
        "params": [
            {"k": "arrivals", "label": "People who arrive each hour", "type": "float", "default": 50, "min": 1, "max": 2000},
            {"k": "service", "label": "Minutes to serve one person", "type": "float", "default": 2.2, "min": 0.1, "max": 120},
            {"k": "servers", "label": "Number of counters", "type": "int", "default": 2, "min": 1, "max": 20},
            {"k": "hours", "label": "Hours open", "type": "float", "default": 4, "min": 0.5, "max": 24}]},
    "birthday": {
        "name": "The birthday surprise", "icon": "cake",
        "blurb": "How many people does it take before two share a birthday? Fewer than you think.",
        "params": [{"k": "max", "label": "Largest group", "type": "int", "default": 80, "min": 10, "max": 100}]},
}


def _pct(a, qs=(5, 25, 50, 75, 95)):
    return [float(x) for x in cp.asnumpy(cp.percentile(a, cp.asarray(qs, cp.float64)))]


def retirement(p):
    age, retire, until = int(p["age"]), int(p["retire"]), int(p["until"])
    years = max(1, until - age)
    n = 1_000_000

    def job():
        t0 = time.time()
        bal = cp.full(n, float(p["savings"]), cp.float32)
        alive = cp.ones(n, cp.bool_)
        broke_age = cp.full(n, 0, cp.int16)
        mu, sd, infl = float(p["ret"]) / 100, float(p["vol"]) / 100, float(p["infl"]) / 100
        bands, ages = [], []
        price = 1.0
        for y in range(years):
            r = cp.random.normal(mu, sd, n).astype(cp.float32)
            a = age + y
            if a < retire:
                bal = bal * (1 + r) + float(p["contrib"]) * price
            else:
                bal = bal * (1 + r) - float(p["spend"]) * price
            now_broke = alive & (bal <= 0)
            broke_age = cp.where(now_broke, a, broke_age)
            alive &= bal > 0
            bal = cp.maximum(bal, 0)
            price *= 1 + infl
            bands.append([round(v / price) for v in _pct(bal)])
            ages.append(a + 1)
        sync()
        dt = time.time() - t0
        mark_gflops(n * years * 12.0, dt, "Monte Carlo (cuRAND)")
        ok = float(alive.mean())
        b = cp.asnumpy(broke_age[broke_age > 0])
        hist = np.bincount(b - age, minlength=years)[:years].tolist() if b.size else [0] * years
        return ok, bands, ages, hist, dt
    ok, bands, ages, hist, dt = run_on_gpu(job, "forecast: retirement", 120)
    pct = round(ok * 100, 1)
    median_end = bands[-1][2]
    first_fail = next((ages[i] - 1 for i, h in enumerate(hist) if h > 0), None)
    sentence = ("In {}% of a million simulated futures your money lasts until {}. ".format(pct, until) +
                ("In the median future you still have ${:,} (today's money) at the end.".format(median_end) if median_end > 0
                 else "In the median future it runs out before then."))
    return {"headline": "{}%".format(pct), "sentence": sentence, "tone": "good" if pct >= 85 else "warn" if pct >= 60 else "bad",
            "chart": {"type": "fan", "x": ages, "bands": bands, "labels": ["5%", "25%", "median", "75%", "95%"], "unit": "$"},
            "chart2": {"type": "bars", "x": [age + i + 1 for i in range(len(hist))], "y": hist, "title": "Age when money runs out (failed futures)"},
            "facts": [["futures simulated", "1,000,000"], ["years each", years], ["first failures at", first_fail or "never"]],
            "paths": 1_000_000, "ms": round(dt * 1000, 1)}


def project(p):
    rows = []
    for ln in str(p["tasks"]).splitlines():
        parts = [x.strip() for x in ln.split(",")]
        if len(parts) >= 4:
            try:
                rows.append((parts[0], float(parts[1]), float(parts[2]), float(parts[3])))
            except ValueError:
                continue
    if not rows:
        raise ValueError("give each task as: name, best, likely, worst")
    n = 2_000_000
    deadline = float(p["deadline"])

    def job():
        t0 = time.time()
        total = cp.zeros(n, cp.float32)
        share = []
        for name, a, m, b in rows:              # PERT-beta per task
            a, b = min(a, b), max(a, b)
            m = min(max(m, a), b)
            if b - a < 1e-9:
                d = cp.full(n, a, cp.float32)
            else:
                al = 1 + 4 * (m - a) / (b - a)
                be = 1 + 4 * (b - m) / (b - a)
                d = (a + cp.random.beta(al, be, n) * (b - a)).astype(cp.float32)
            total += d
            share.append(d)
        on_time = float((total <= deadline).mean())
        crit = [float(cp.corrcoef(cp.stack([d, total]))[0, 1]) for d in share]
        hist, edges = cp.histogram(total, 60)
        sync()
        dt = time.time() - t0
        return on_time, _pct(total, (10, 50, 80, 95)), cp.asnumpy(hist).tolist(), cp.asnumpy(edges).tolist(), crit, dt
    on_time, q, hist, edges, crit, dt = run_on_gpu(job, "forecast: project", 120)
    pct = round(on_time * 100, 1)
    risk = sorted(zip([r[0] for r in rows], crit), key=lambda x: -x[1])
    sentence = ("There is a {}% chance that the project is complete in {:.0f} days or less. Half the time it takes {:.0f} days or less; "
                "to be 80% sure, plan for {:.0f}. The task that drives the uncertainty most is {}.").format(pct, deadline, q[1], q[2], risk[0][0])
    return {"headline": "{}%".format(pct), "sentence": sentence, "tone": "good" if pct >= 80 else "warn" if pct >= 50 else "bad",
            "chart": {"type": "hist", "edges": edges, "y": hist, "marker": deadline, "unit": "days", "title": "Finish time across 2 million plans"},
            "chart2": {"type": "hbars", "labels": [r[0] for r in risk], "y": [round(r[1], 3) for r in risk], "title": "How much each task drives the finish date"},
            "facts": [["plans simulated", "2,000,000"], ["10% / 50% / 80% / 95%", " / ".join("{:.0f}".format(x) for x in q)]],
            "paths": 2_000_000, "ms": round(dt * 1000, 1)}


def queue(p):
    lam = float(p["arrivals"]) / 60.0            # per minute
    mu_t = float(p["service"])
    c = int(p["servers"])
    minutes = float(p["hours"]) * 60
    k = int(lam * minutes * 1.4) + 20              # arrivals needed to cover the day
    runs = int(max(2000, min(20000, engine.budget_bytes() // (k * 4 * 6))))   # scale runs so the arrays fit

    chunk = int(max(500, min(runs, engine.budget_bytes(100) // (k * 4 * 7))))

    def job():
        t0 = time.time()
        wsum, wn, over, wmax, worst_all = 0.0, 0, 0, 0.0, []
        hist = cp.zeros(60, cp.int64)
        wq = []
        done = 0
        while done < runs:
            r = int(min(chunk, runs - done))
            gaps = cp.random.exponential(1.0 / lam, (r, k)).astype(cp.float32)
            arr = cp.cumsum(gaps, axis=1)
            svc = cp.random.exponential(mu_t, (r, k)).astype(cp.float32)
            free = cp.zeros((r, c), cp.float32)
            waits = cp.zeros((r, k), cp.float32)
            valid = arr <= minutes
            ar = cp.arange(r)
            for i in range(k):
                j = cp.argmin(free, axis=1)
                f = free[ar, j]
                start = cp.maximum(f, arr[:, i])
                waits[:, i] = start - arr[:, i]
                free[ar, j] = start + svc[:, i]
            w = waits[valid]
            wsum += float(w.sum()); wn += int(w.size); over += int((w > 10).sum())
            hist += cp.histogram(cp.minimum(w, 60), 60, (0, 60))[0]
            worst_all.append(cp.asnumpy(cp.max(cp.where(valid, waits, 0), axis=1)))
            if len(wq) < 3:
                wq.append(cp.asnumpy(w[:200000]))
            del gaps, arr, svc, free, waits, valid, w
            cp.get_default_memory_pool().free_all_blocks()
            done += r
        wall = np.concatenate(wq) if wq else np.zeros(1)
        worst = np.concatenate(worst_all)
        import numpy as _np
        return (wsum / max(1, wn), [float(x) for x in _np.percentile(wall, [50, 90, 99])], over / max(1, wn),
                [float(x) for x in _np.percentile(worst, [50, 95])], cp.asnumpy(hist).tolist(),
                cp.asnumpy(cp.histogram(cp.zeros(1), 60, (0, 60))[1]).tolist(), time.time() - t0)
    mean, q, over10, worst, hist, edges, dt = run_on_gpu(job, "forecast: queue", 180)
    util = lam * mu_t / c
    sentence = ("On average people wait {:.1f} minutes; 1 in 10 waits more than {:.1f}. The counters are busy {:.0f}% of the time{}").format(
        mean, q[1], min(100, util * 100), " — that is more than the capacity, so the line continues to get longer." if util >= 1 else ".")
    return {"headline": "{:.1f} min".format(mean), "sentence": sentence, "tone": "good" if q[1] < 5 else "warn" if q[1] < 15 else "bad",
            "chart": {"type": "hist", "edges": edges, "y": hist, "unit": "min", "title": "How long people wait"},
            "facts": [["days simulated", "{:,}".format(runs)], ["median / 90% / 99% wait", " / ".join("{:.1f}".format(x) for x in q)],
                      ["longest wait in a typical day", "{:.0f} min".format(worst[0])], ["waits over 10 min", "{:.1f}%".format(over10 * 100)]],
            "paths": runs, "ms": round(dt * 1000, 1)}


def birthday(p):
    top = min(100, int(p["max"]))
    trials = 300_000

    def job():
        t0 = time.time()
        # chunk the trials so (chunk*365 bool + chunk*top int32) stays well under the budget
        per = max(20000, min(trials, engine.budget_bytes() // (365 + top * 4 + 8) // 2))
        counts = cp.zeros(top + 2, cp.float64)
        done = 0
        while done < trials:
            c = int(min(per, trials - done))
            b = cp.random.randint(0, 365, (c, top), dtype=cp.int32)
            seen = cp.zeros((c, 365), cp.bool_)
            first = cp.full(c, top + 1, cp.int32)
            rows = cp.arange(c)
            for k in range(top):
                d = b[:, k]
                hit = seen[rows, d] & (first > top)
                first = cp.where(hit, k + 1, first)
                seen[rows, d] = True
            counts += cp.bincount(cp.minimum(first, top + 1), minlength=top + 2).astype(cp.float64)
            del b, seen, first, rows
            cp.get_default_memory_pool().free_all_blocks()
            done += c
        cum = cp.cumsum(counts)[2:top + 1] / trials
        sync()
        return [float(x) for x in cp.asnumpy(cum)], time.time() - t0
    sim, dt = run_on_gpu(job, "forecast: birthday", 180)
    exact = []
    q = 1.0
    for nppl in range(2, top + 1):
        q *= (365 - (nppl - 1)) / 365
        exact.append(1 - q)
    n50 = next(i + 2 for i, v in enumerate(sim) if v >= 0.5)
    sentence = "With only {} people in a room, it is more probable than not that two have the same birthday.".format(n50)
    return {"headline": "{} people".format(n50), "sentence": sentence, "tone": "good",
            "chart": {"type": "lines", "x": list(range(2, top + 1)), "series": [{"name": "simulated", "y": sim}, {"name": "exact maths", "y": exact}],
                      "unit": "%", "title": "Chance two people share a birthday"},
            "facts": [["rooms simulated", "1,000,000"], ["total rooms", "{:,}".format(trials * (top - 1))]],
            "paths": trials * (top - 1), "ms": round(dt * 1000, 1)}


RUN = {"retirement": retirement, "project": project, "queue": queue, "birthday": birthday}


def run(sid, params):
    spec = SCENARIOS[sid]
    p = {x["k"]: x["default"] for x in spec["params"]}
    p.update({k: v for k, v in (params or {}).items() if v is not None and v != ""})
    return RUN[sid](p)


