"""Monte Carlo on your own numbers -- two engines for Simulate.

budget   A list of line items, each with low / likely / high estimates (and optionally a chance that it happens at
         all, for risks). A million totals are drawn on the card; each item follows a PERT (or triangular / uniform)
         distribution, optionally correlated through one shared factor (when one thing overruns, others tend to).
         Answers: the odds of exceeding the budget, what to budget to be 80/90% sure, and which items drive the
         uncertainty. It also reports how often the plain "sum of the likely values" would have been enough --
         usually far less than half the time, which is the point.

history  A run of past periods (monthly spend, weekly sales, a balance). Future periods are drawn by block bootstrap
         -- whole stretches of real history stitched together, so streaks and seasonality inside a block survive.
         Answers: the range of the next N periods' total (or the level at the end), and the odds of crossing a
         threshold. Then it checks itself: at up to 40 past cut points it pretends the future is unknown, makes the
         same forecast, and counts how often the real outcome landed inside the 80% range. A calibrated forecaster
         lands ~80%; much less means the history is not representative of what came next.

Inverse distribution functions are tabulated on the host (scipy), every draw and reduction runs on the GPU.
"""
import math
import re
import time

import numpy as np

import cupy as cp

from .engine import mark_gflops, run_on_gpu, sync

GRID = 2048


def parse_items(text):
    items = []
    for no, raw in enumerate((text or "").splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        parts = [p.strip() for p in re.split(r"[,\t;]", line)]
        nums, name = [], []
        for p in parts:
            q = p.replace("$", "").replace("%", "").replace(" ", "")
            try:
                nums.append(float(q.replace(",", "")) / (100.0 if p.endswith("%") else 1.0))
            except ValueError:
                if not nums:
                    name.append(p)
        if len(nums) < 3:
            if re.search(r"low|likely|high|min|max", line, re.I) and not items:
                continue                                         # a header row
            raise ValueError("line {}: need a name then low, likely, high (and optionally a chance)".format(no))
        lo, ml, hi = nums[:3]
        if not lo <= ml <= hi:
            lo, ml, hi = sorted((lo, ml, hi))
        ch = nums[3] if len(nums) > 3 else 1.0
        if ch > 1:
            ch = ch / 100.0
        items.append({"name": ", ".join(name) or "item {}".format(len(items) + 1), "lo": lo, "ml": ml, "hi": hi,
                      "chance": float(min(1.0, max(0.0, ch)))})
    if not items:
        raise ValueError("add at least one line: name, low, likely, high")
    if len(items) > 400:
        raise ValueError("at most 400 items")
    return items


def _quantile_table(items, dist):
    """Per-item inverse CDF tabulated on GRID+1 points of u in [0, 1] (host, scipy)."""
    from scipy.special import betaincinv
    u = np.linspace(0, 1, GRID + 1)
    u[0], u[-1] = 1e-7, 1 - 1e-7
    Q = np.zeros((len(items), GRID + 1), np.float64)
    for i, it in enumerate(items):
        a, m, b = it["lo"], it["ml"], it["hi"]
        if b - a < 1e-12:
            Q[i] = m
            continue
        if dist == "uniform":
            Q[i] = a + u * (b - a)
        elif dist == "triangular":
            c = (m - a) / (b - a)
            Q[i] = np.where(u < c, a + np.sqrt(u * (b - a) * (m - a)), b - np.sqrt((1 - u) * (b - a) * (b - m)))
        else:                                                    # PERT: Beta(1 + 4c, 1 + 4(1 - c)) on [a, b]
            c = (m - a) / (b - a)
            Q[i] = a + (b - a) * betaincinv(1 + 4 * c, 1 + 4 * (1 - c), u)
    return Q.astype(np.float32)


def budget(p):
    t0 = time.time()
    items = parse_items(p["items"])
    m = len(items)
    dist = p.get("dist", "pert")
    rho = float(p.get("correlation", 0.0))
    target = float(p.get("budget") or 0)
    S = int(max(10000, min(int(p.get("sims") or 1000000), 4000000)))
    Q = _quantile_table(items, dist)
    chance = np.array([it["chance"] for it in items], np.float32)
    likely_sum = float(sum(it["ml"] * it["chance"] for it in items))
    chunk = int(max(10000, min(200000, 20000000 // max(1, m))))

    def job():
        Qg, Cg = cp.asarray(Q), cp.asarray(chance)
        rows = cp.arange(m, dtype=cp.int32)[None, :]
        totals = []
        cov_acc = cp.zeros(m, cp.float64)
        mean_acc = cp.zeros(m, cp.float64)
        tsum = tsq = 0.0
        done = 0
        rs = cp.random.RandomState(int(p.get("seed") or (int(time.time() * 1000) & 0x7FFFFFFF)))
        while done < S:
            B = min(chunk, S - done)
            e = rs.standard_normal((B, m), dtype=cp.float32)
            if rho > 0:
                f = rs.standard_normal((B, 1), dtype=cp.float32)
                e = math.sqrt(rho) * f + math.sqrt(1 - rho) * e
            uu = 0.5 * (1 + cp.tanh(e * 0.7978845608 * (1 + 0.044715 * e * e)))   # fast normal CDF (|err| < 3e-4)
            pos = cp.clip(uu, 0, 1) * GRID
            i0 = cp.minimum(pos.astype(cp.int32), GRID - 1)
            fr = pos - i0
            x = Qg[rows, i0] * (1 - fr) + Qg[rows, i0 + 1] * fr
            happens = rs.random_sample((B, m), dtype=cp.float32) < Cg[None, :]
            x = x * happens
            tot = x.sum(1, dtype=cp.float64)
            totals.append(tot.astype(cp.float32))
            tc = tot - tot.mean()
            cov_acc += (x - x.mean(0, keepdims=True)).astype(cp.float64).T @ tc
            mean_acc += x.sum(0)
            tsum += float(tot.sum())
            tsq += float((tc * tc).sum())
            done += B
        T = cp.concatenate(totals)
        sync()
        q = cp.asnumpy(cp.percentile(T, cp.asarray([5, 10, 25, 50, 75, 80, 90, 95, 99], cp.float64)))
        lo, hi = (float(v) for v in cp.percentile(T, cp.asarray([0.2, 99.8], cp.float64)))
        over = float((T > target).mean()) if target > 0 else None
        p_likely = float((T <= likely_sum).mean())
        h, edges = cp.histogram(T, 60, range=(lo, hi if hi > lo else lo + 1.0))      # the extreme 0.4% is left off the picture
        share = cp.asnumpy(cov_acc / max(tsq, 1e-12))
        mark_gflops(S * m * 24.0, time.time() - t0, "budget Monte Carlo")
        return q, over, p_likely, cp.asnumpy(h), cp.asnumpy(edges), share, float(T.mean())
    q, over, p_likely, h, edges, share, mean = run_on_gpu(job, "budget Monte Carlo", 120)
    P = dict(zip((5, 10, 25, 50, 75, 80, 90, 95, 99), q))
    order = np.argsort(-share)[:14]
    money = lambda v: "{:,.0f}".format(v)  # noqa: E731
    if target > 0:
        tone = "good" if over < 0.2 else "warn" if over < 0.5 else "bad"
        head = "{:.0%}".format(over)
        sent = ("There is a {:.0%} chance the total goes over {}. To be 80% sure, budget {} ({:+.0%} on the sum of the "
                "likely values, {}); for 90%, {}. The plain sum of likely values is enough only {:.0%} of the time.").format(
            over, money(target), money(P[80]), P[80] / likely_sum - 1 if likely_sum else 0, money(likely_sum), money(P[90]), p_likely)
    else:
        tone, head = "", money(P[50])
        sent = ("Half the futures end below {}; to be 80% sure, budget {} and for 90%, {}. The plain sum of the likely "
                "values ({}) is enough only {:.0%} of the time.").format(money(P[50]), money(P[80]), money(P[90]), money(likely_sum), p_likely)
    drivers = [items[i]["name"] for i in order[:3]]
    sent += " Most of the uncertainty comes from {}.".format(", ".join(drivers))
    return {"headline": head, "sentence": sent, "tone": tone, "paths": S, "ms": round((time.time() - t0) * 1000, 1),
            "chart": {"type": "hist", "edges": [round(float(e), 2) for e in edges], "y": [int(c) for c in h],
                      "marker": target if target > 0 else P[80], "unit": "$", "marker_label": "budget" if target > 0 else "80% budget",
                      "title": "a million possible totals" + (" · line = your budget" if target > 0 else " · line = the 80% budget")},
            "chart2": {"type": "hbars", "labels": [items[i]["name"] for i in order], "y": [round(float(max(0, share[i])), 4) for i in order],
                       "title": "share of the uncertainty, by item"},
            "facts": [["P10", money(P[10])], ["P50", money(P[50])], ["P80", money(P[80])], ["P90", money(P[90])],
                      ["mean", money(mean)], ["sum of likely", money(likely_sum)], ["items", str(len(items))],
                      ["distribution", dist], ["correlation", "{:.2f}".format(rho)], ["seed", str(p.get("seed") or "random")]]}


def _bootstrap(rs, base, S, h, b):
    """S paths of h steps, each stitched from random blocks of length b of `base` (a cupy vector)."""
    n = base.size
    b = int(max(1, min(b, n)))
    k = int(math.ceil(h / float(b)))
    starts = rs.randint(0, n - b + 1, (S, k))
    idx = (starts[:, :, None] + cp.arange(b)[None, None, :]).reshape(S, k * b)[:, :h]
    return base[idx]


def _forecast(rs, hist, h, mode, trend, S, b):
    """-> (S, h) future paths: per-period amounts ('amounts') or levels ('levels')."""
    x = np.asarray(hist, np.float64)
    n = x.size
    if mode == "levels":
        d = np.diff(x)
        base = d if trend == "linear" else d - d.mean()        # without the trend, steps are centred: no drift
        steps = _bootstrap(rs, cp.asarray(base.astype(np.float32)), S, h, b)
        return x[-1] + cp.cumsum(steps, 1)
    t = np.arange(n, dtype=np.float64)
    if trend == "linear" and n >= 6:
        c, cov = np.polyfit(t, x, 1, cov=True)
        resid = x - np.polyval(c, t)
        # the trend itself is uncertain: every future draws its own slope and intercept from the fit's covariance
        L = np.linalg.cholesky(cov + np.eye(2) * 1e-12 * max(1.0, abs(cov).max()))
        coef = cp.asarray(c.astype(np.float32))[None, :] + rs.standard_normal((S, 2), dtype=cp.float32) @ cp.asarray(L.T.astype(np.float32))
        tt = cp.arange(n, n + h, dtype=cp.float32)[None, :]
        return coef[:, :1] * tt + coef[:, 1:] + _bootstrap(rs, cp.asarray(resid.astype(np.float32)), S, h, b)
    return _bootstrap(rs, cp.asarray(x.astype(np.float32)), S, h, b)


def history(p):
    t0 = time.time()
    x = np.asarray(p["series"], np.float64)
    n = x.size
    if n < 8:
        raise ValueError("give at least 8 past periods")
    h = int(p.get("horizon", 12))
    mode = "levels" if p.get("kind", "").startswith("a level") else "amounts"
    trend = "linear" if p.get("trend") else "none"
    b = int(p.get("block") or 0) or int(max(1, min(12, round(n ** (1 / 3.0)))))
    target = float(p.get("threshold") or 0)
    S = int(max(10000, min(int(p.get("sims") or 200000), 2000000)))
    qty = (lambda P: P[:, -1]) if mode == "levels" else (lambda P: P.sum(1))

    def job():
        rs = cp.random.RandomState(int(p.get("seed") or (int(time.time() * 1000) & 0x7FFFFFFF)))
        paths = _forecast(rs, x, h, mode, trend, S, b)
        cum = paths if mode == "levels" else cp.cumsum(paths, 1)
        bands = cp.asnumpy(cp.percentile(cum, cp.asarray([5, 25, 50, 75, 95], cp.float64), axis=0))
        out = qty(paths)
        q = cp.asnumpy(cp.percentile(out, cp.asarray([5, 10, 25, 50, 75, 90, 95], cp.float64)))
        p_over = float((out > target).mean()) if target else None
        hh, edges = cp.histogram(out, 50)
        # backtest: pretend each past cut point is "now" and score the 80% range on what really happened
        cuts = [c for c in range(max(8, n // 3), n - h + 1)]
        if len(cuts) > 40:
            cuts = [cuts[int(i)] for i in np.linspace(0, len(cuts) - 1, 40)]
        inside = above = below = 0
        errs = []
        for c in cuts:
            past = x[:c]
            bb = int(max(1, min(b, past.size // 2)))
            pp = _forecast(rs, past, h, mode, trend, 4000, bb)
            o = qty(pp)
            lo, mid, hi = (float(v) for v in cp.percentile(o, cp.asarray([10, 50, 90], cp.float64)))
            real = float(x[c + h - 1]) if mode == "levels" else float(x[c:c + h].sum())
            inside += lo <= real <= hi
            above += real > hi
            below += real < lo
            errs.append(abs(real - mid) / max(1e-9, abs(real)))
        sync()
        return bands, q, p_over, cp.asnumpy(hh), cp.asnumpy(edges), len(cuts), inside, (float(np.median(errs)) if errs else None), above, below
    bands, q, p_over, hh, edges, ncut, inside, mederr, above, below = run_on_gpu(job, "history bootstrap", 120)
    P = dict(zip((5, 10, 25, 50, 75, 90, 95), q))
    what = "the level after {} periods".format(h) if mode == "levels" else "the total of the next {} periods".format(h)
    f = lambda v: "{:,.4g}".format(v) if abs(v) < 1e4 else "{:,.0f}".format(v)  # noqa: E731
    cov = inside / float(ncut) if ncut else None
    if cov is None:
        check = "There is not sufficient history to test {} periods ahead.".format(h)
        tone = "warn"
    else:
        miss = above + below
        if abs(cov - 0.8) <= 0.12:
            cal = "well calibrated"
        elif cov > 0.92:
            cal = "conservative (wider than needed)"
        elif miss and max(above, below) >= 0.8 * miss:
            cal = "biased — the real outcome was usually {} the range{}".format(
                "above" if above > below else "below", "; try Continue the trend" if trend == "none" else "")
        else:
            cal = "too narrow — the future has been wilder than the past"
        check = ("Backtest: at {} past cut points the 80% range held the real outcome {} times ({:.0%}) — {}; typical miss of the "
                 "middle guess {:.0%}.").format(ncut, inside, cov, cal, mederr or 0)
        tone = "good" if abs(cov - 0.8) <= 0.12 else "warn"
    if target:
        head = "{:.0%}".format(p_over)
        sent = "{:.0%} chance that {} exceeds {}. Middle outcome {}, 80% range {} to {}. {}".format(
            p_over, what, f(target), f(P[50]), f(P[10]), f(P[90]), check)
    else:
        head = f(P[50])
        sent = "For {}: middle outcome {}, 80% range {} to {}. {}".format(what, f(P[50]), f(P[10]), f(P[90]), check)
    keep = int(min(n, max(4 * h, 40)))                          # enough history to see the shape, not so much the fan vanishes
    hx = list(range(-keep + 1, 1))
    return {"headline": head, "sentence": sent, "tone": tone, "paths": S, "ms": round((time.time() - t0) * 1000, 1),
            "history": {"x": hx, "y": [round(float(v), 6) for v in (x if mode == "levels" else np.cumsum(x) - np.sum(x))[-keep:]]},
            "chart": {"type": "fan", "x": list(range(1, h + 1)), "bands": [[round(float(v), 4) for v in col] for col in np.asarray(bands).T],
                      "title": ("level path" if mode == "levels" else "total from now") + " — 5/25/50/75/95% of {:,} futures".format(S)},
            "chart2": {"type": "hist", "edges": [round(float(e), 4) for e in edges], "y": [int(c) for c in hh], "marker": target or None,
                       "marker_label": "threshold", "title": "distribution of " + what},
            "facts": [["P10", f(P[10])], ["P50", f(P[50])], ["P90", f(P[90])], ["backtest 80% range", "{:.0%}".format(cov) if cov is not None else "—"],
                      ["block", "{} periods".format(b)], ["history", "{} periods".format(n)], ["trend", trend],
                      ["seed", str(p.get("seed") or "random")]]}


SPECS = {
    "budget": {"name": "Budget & estimates", "icon": "coin", "group": "yours",
               "blurb": "Line items with low / likely / high costs (and risks with a chance) — the chance that the total is more than the budget, the budget to set, and what causes it.",
               "fields": [{"k": "items", "type": "text", "src": "rows", "label": "Items — name, low, likely, high[, chance]",
                           "default": "Design, 18000, 24000, 40000\nBuild, 60000, 85000, 150000\nTesting, 12000, 15000, 30000\nHardware, 9000, 10000, 12000\nTraining, 4000, 6000, 9000\nRisk: vendor slips, 10000, 20000, 60000, 30%\nRisk: rework after audit, 5000, 15000, 40000, 20%"},
                          {"k": "budget", "type": "money", "label": "Budget", "default": 180000, "min": 0, "max": 2000000},
                          {"k": "dist", "type": "choice", "label": "Shape", "choices": ["pert", "triangular", "uniform"], "default": "pert"},
                          {"k": "correlation", "type": "float", "label": "Overruns move together", "default": 0.3, "min": 0, "max": 0.9},
                          {"k": "sims", "type": "int", "label": "Simulated futures", "default": 1000000, "min": 10000, "max": 4000000},
                          {"k": "seed", "type": "int", "label": "Random seed (0 = new each run)", "default": 0, "min": 0, "max": 2147483647}]},
    "history": {"name": "From history", "icon": "trend", "group": "yours",
                "blurb": "Past periods in, the odds for the next ones out — block bootstrap of your real history, backtested on itself.",
                "fields": [{"k": "series", "type": "text", "src": "column", "label": "Past periods, oldest first (one per line)",
                            "default": "41200\n39800\n44100\n42900\n47300\n45100\n43800\n49200\n51800\n48700\n46900\n52300\n50100\n49400\n53900\n52700\n57600\n55200\n54300\n59800\n62100\n58700\n57200\n63900"},
                           {"k": "kind", "type": "choice", "label": "Each number is", "choices": ["an amount per period", "a level (balance, price)"], "default": "an amount per period"},
                           {"k": "horizon", "type": "int", "label": "Periods ahead", "default": 6, "min": 1, "max": 120},
                           {"k": "threshold", "type": "num", "label": "Threshold (0 = none)", "default": 380000},
                           {"k": "trend", "type": "bool", "label": "Continue the trend", "default": True},
                           {"k": "block", "type": "int", "label": "Block length (0 = auto)", "default": 0, "min": 0, "max": 24},
                           {"k": "sims", "type": "int", "label": "Simulated futures", "default": 200000, "min": 10000, "max": 2000000},
                           {"k": "seed", "type": "int", "label": "Random seed (0 = new each run)", "default": 0, "min": 0, "max": 2147483647}]},
}
RUN = {"budget": budget, "history": history}
