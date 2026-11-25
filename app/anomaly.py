"""Anomaly watch: find the moments in a series (or several at once) that break its own pattern.

Three detectors score every time step, each as "how many typical errors away from what was expected":

  * rolling   the simple rule -- the median of the last 30 points is the expectation
  * linear    a ridge regression on the last few values (and the value one season ago, when there is a season)
  * pattern   the same regression reading an echo-state reservoir that has listened to the whole series (the Reservoir
              Lab's network), so it can expect patterns longer and stranger than a few lags

Predictions are cross-fitted: the series is cut into four blocks and each block is predicted by a model that never saw
it. The typical error is a trailing robust spread (median absolute deviation), so a calm period and a volatile period
are each judged against themselves.

Which detector to trust is measured, not assumed: glitches (spikes, dips and level shifts about four typical moves in
size) are planted into a copy of the series, and each detector is scored on how many it catches at the same alarm rate
(1 in 100 ordinary points). If the table has a column marking known incidents, precision and recall against it are
reported too. Everything numerical runs on the card; parsing and bookkeeping run on the host.
"""
import math
import time

import numpy as np

import cupy as cp

from . import engine, sources
from .reservoir import DEFAULT_RES, LAMS, _fit, _predict, series_states

MAX_N = 20000
DETECTORS = {"rolling": "Rolling median", "linear": "Linear model", "pattern": "Pattern model (reservoir)"}
_CACHE = {}


def _period(z):
    """Dominant season from the autocorrelation of the detrended series (FFT on the card); None if there isn't one.
    A peak counts only if it rises well above the trough before it -- a random walk's slowly decaying autocorrelation
    has no such peak, so prices don't get an imaginary season."""
    n = z.size
    if n < 24:
        return None
    t = np.arange(n, dtype=np.float64)
    d = z - np.polyval(np.polyfit(t, z, 1), t)
    g = cp.asarray(d - d.mean())
    f = cp.fft.rfft(g, 2 * n)
    ac = cp.asnumpy(cp.fft.irfft(f * cp.conj(f))[:n]).real
    if ac[0] <= 0:
        return None
    ac = ac / ac[0]
    hi = min(n // 3, 400)
    peaks = [k for k in range(3, hi) if ac[k] > 0.3 and ac[k] >= ac[k - 1] and ac[k] >= ac[k + 1] and ac[k] - ac[1:k].min() > 0.25]
    if not peaks:
        return None
    top = max(ac[k] for k in peaks)
    return next(k for k in peaks if ac[k] >= 0.8 * top)      # the shortest strong peak, not a multiple of it


def _windows(x, w):
    """(n,) -> (n, w) trailing windows x[t-w .. t-1] (edge-padded at the start). GPU."""
    n = x.shape[0]
    idx = cp.arange(n)[:, None] - w + cp.arange(w)[None, :]
    return x[cp.clip(idx, 0, n - 1)]


def _scale(r, start):
    """Trailing robust spread of residuals r (n, k) -> (n, k), floored so a perfectly flat stretch can't divide by ~0."""
    n, k = r.shape
    out = cp.empty_like(r)
    w = int(max(30, min(250, n // 4)))
    for j in range(k):
        c = r[:, j]
        valid = c[start:]
        g = 1.4826 * cp.median(cp.abs(valid - cp.median(valid))) + 1e-9
        win = _windows(c, w)
        loc = 1.4826 * cp.median(cp.abs(win - cp.median(win, 1, keepdims=True)), 1)
        loc[:start + w] = g
        out[:, j] = cp.maximum(loc, 0.5 * g)
    return out


def _crossfit(Phi, Y, valid, blocks=4):
    """Blocked cross-fitting: every block is predicted by a ridge model trained on the other blocks. The ridge strength
    is picked by the median absolute error (so the anomalies themselves can't steer it). GPU."""
    rows = np.flatnonzero(valid)
    parts = np.array_split(rows, blocks)
    best = None
    for lam in LAMS + (10.0,):
        pred = np.zeros_like(Y)
        for b in parts:
            tr = valid.copy()
            tr[max(0, b[0] - 10):b[-1] + 11] = False
            m = _fit(Phi[tr], Y[tr], lam)
            pred[b] = cp.asnumpy(_predict(m, Phi[b]))
        err = float(np.median(np.abs(pred[valid] - Y[valid])))
        if best is None or err < best[0]:
            best = (err, lam, pred)
    return best[2]


def _lagged(Z, L, p):
    n, k = Z.shape
    cols = [np.roll(Z, i, 0) for i in range(1, L + 1)]
    if p:
        cols += [np.roll(Z, p, 0), np.roll(Z, p, 0) - np.roll(Z, p + 1, 0)]
    return np.concatenate(cols, 1).astype(np.float32)


def _detect(Z, L, p, start, which):
    """Z (n, k) standardised series -> {detector: (score (n,), driver (n,), expected Z (n, k))}."""
    n, k = Z.shape
    valid = np.zeros(n, bool)
    valid[start:] = True
    out = {}
    lagf = _lagged(Z, L, p)
    if "pattern" in which:
        U = np.concatenate([Z, np.r_[np.zeros((1, k)), np.diff(Z, axis=0)]], 1).astype(np.float32)
        res = dict(DEFAULT_RES, units=300, leak=0.5, input_scale=0.6)
        S = series_states(U, res)                               # state after seeing step t
        S = np.roll(S, 1, 0)                                    # predict step t from the state after t-1
        S[0] = 0

    def score(pred):
        r = cp.asarray((Z - pred).astype(np.float32))
        sc = cp.abs(r) / _scale(r, start)
        sc[:start] = 0
        drv = cp.argmax(sc, 1)
        return cp.asnumpy(sc.max(1)), cp.asnumpy(drv).astype(np.int16), pred

    if "rolling" in which:
        w = 30
        med = cp.stack([cp.median(_windows(cp.asarray(Z[:, j]), w), 1) for j in range(k)], 1)
        out["rolling"] = score(cp.asnumpy(med))
    if "linear" in which:
        out["linear"] = score(_crossfit(lagf, Z.astype(np.float32), valid))
    if "pattern" in which:
        out["pattern"] = score(_crossfit(np.concatenate([S, lagf], 1), Z.astype(np.float32), valid))
    return out


def _plant(Z, start, L, rs, p=0):
    """Copy of Z with glitches planted: spikes, 3-point dips and 6-point level shifts, ~4 typical moves in size.
    A typical move is the change from one period earlier when the series has a period (p), else from one step
    earlier: on weekly data the day-to-day jumps (Friday to Saturday) are the pattern, not the noise."""
    n, k = Z.shape
    m = int(np.clip(n // 150, 8, 60))
    D = (Z[p:] - Z[:-p]) if p and n > 2 * p else np.diff(Z, axis=0)
    step = 1.4826 * np.median(np.abs(D - np.median(D, 0)), 0) + 1e-6
    Zp = Z.copy()
    cand = np.arange(start + 2, n - 8)
    rs.shuffle(cand)
    used = np.zeros(n, bool)
    spans = []
    for t in cand:
        if len(spans) >= m:
            break
        if used[max(0, t - 2 * L - 4):t + 2 * L + 10].any():
            continue
        j = rs.randint(k)
        kind = len(spans) % 3
        size = 4.0 * step[j] * (1 if rs.rand() < 0.5 else -1)
        ln = (1, 3, 6)[kind]
        Zp[t:t + ln, j] += size
        used[t:t + ln] = True
        spans.append((t, t + ln - 1, ("spike", "dip", "level shift")[kind]))
    return Zp, spans


def _recall_at(score, spans, start, rate=0.01):
    """Recall on planted glitches at the threshold that flags `rate` of the ordinary (un-planted) points."""
    n = score.size
    planted = np.zeros(n, bool)
    for a, b, _ in spans:
        planted[a:min(n, b + 2)] = True                          # a glitch also disturbs the next prediction
    bg = score[start:][~planted[start:]]
    thr = float(np.quantile(bg, 1 - rate)) if bg.size else 0.0
    found = sum(1 for a, b, _ in spans if score[a:min(n, b + 2)].max() > thr)
    return found, thr


def run(tid, cols, date_col="auto", label_col="", detector="auto", threshold=5.0):
    key = (tid, tuple(cols), date_col, label_col)
    t0 = time.time()
    hit = _CACHE.get(key)
    if hit is None:
        src = sources.series(tid, cols, date_col, label_col or None)
        V = src["values"]
        notes = list(src["notes"])
        labels = src["labels"]
        known = src["known"]
        if V.shape[0] > MAX_N:
            notes.append("the watch uses only the latest {:,} of {:,} rows".format(MAX_N, V.shape[0]))
            cut = V.shape[0] - MAX_N
            V = V[cut:]
            labels = labels[cut:] if labels else None
            known = known[cut:] if known is not None else None
        n, k = V.shape
        if n < 40:
            raise ValueError("anomaly watch needs at least 40 rows (this has {})".format(n))
        med = np.median(V, 0)
        sd = 1.4826 * np.median(np.abs(V - med), 0)
        sd = np.where(sd > 1e-12, sd, V.std(0) + 1e-9)
        Z = (V - med) / sd
        L = int(min(8, max(2, n // 60)))

        def job():
            p = _period(Z[:, 0])
            if p and p > n // 4:
                p = None
            start = max(30, L + 1, (p + 2) if p else 0)
            start = min(start, n // 3)
            clean = _detect(Z, L, p, start, DETECTORS)
            rs = np.random.RandomState(1)
            Zp, spans = _plant(Z, start, L, rs, p)
            dirty = _detect(Zp, L, p, start, DETECTORS)
            return p, start, clean, spans, dirty
        p, start, clean, spans, dirty = engine.run_on_gpu(job, "anomaly watch", 240)
        tests = {}
        for d in DETECTORS:
            found, _ = _recall_at(dirty[d][0], spans, start)
            kinds = {}
            for (a, b, kind) in spans:
                kinds.setdefault(kind, [0, 0])
                kinds[kind][1] += 1
            thr_bg = _recall_at(dirty[d][0], spans, start)[1]
            for (a, b, kind) in spans:
                if dirty[d][0][a:min(n, b + 2)].max() > thr_bg:
                    kinds[kind][0] += 1
            tests[d] = {"name": DETECTORS[d], "found": int(found), "planted": len(spans), "by_kind": kinds}
        order = sorted(DETECTORS, key=lambda d: (-tests[d]["found"], ["rolling", "linear", "pattern"].index(d)))
        if p:   # a period was found: the moving median cannot know that Saturday is a big day, so a near tie goes seasonal
            seas = max((d for d in DETECTORS if d != "rolling"), key=lambda d: tests[d]["found"])
            if tests[seas]["found"] >= tests[order[0]]["found"] - 1:
                order = [seas] + [d for d in order if d != seas]
        hit = {"V": V, "med": med, "sd": sd, "labels": labels, "known": known, "notes": notes, "period": p,
               "start": start, "clean": clean, "tests": tests, "best": order[0], "names": list(cols), "lags": L,
               "table": src["table"], "date_col": src["date_col"], "filled": src["filled"], "secs": time.time() - t0}
        _CACHE[key] = hit
        while len(_CACHE) > 8:
            _CACHE.pop(next(iter(_CACHE)))
    return _report(hit, detector, float(threshold), time.time() - t0)


def _report(h, detector, thr, secs):
    V, labels, names = h["V"], h["labels"], h["names"]
    n, k = V.shape
    det = h["best"] if detector not in DETECTORS else detector
    score, drv, Ez = h["clean"][det]
    E = Ez * h["sd"] + h["med"]
    flag = score >= thr
    # echoes: the seasonal models predict from one period earlier, so an incident at t also flags t + p, the other way
    echoes = 0
    P = int(h.get("period") or 0)
    if P and det != "rolling":
        resid = (V - E).sum(1)
        for t_ in np.flatnonzero(flag):
            if t_ - P >= 0 and flag[t_ - P] and np.sign(resid[t_]) == -np.sign(resid[t_ - P]) and score[t_] <= score[t_ - P] * 1.5:
                flag[t_] = False
                echoes += 1
    inc = []
    t = h["start"]
    idx = np.flatnonzero(flag)
    if idx.size:
        runs = np.split(idx, np.flatnonzero(np.diff(idx) > 3) + 1)
        for r in runs:
            a, b = int(r[0]), int(r[-1])
            pk = a + int(np.argmax(score[a:b + 1]))
            j = int(drv[pk])
            inc.append({"start": a, "end": b, "peak": pk, "col": j, "column": names[j], "score": round(float(score[pk]), 2),
                        "value": float(V[pk, j]), "expected": float(E[pk, j]),
                        "label": labels[pk] if labels else "row {}".format(pk + 1), "filled": bool(h["filled"][pk])})
    known = None
    if h["known"] is not None and h["known"].any():
        kn = h["known"]
        kr = np.split(np.flatnonzero(kn), np.flatnonzero(np.diff(np.flatnonzero(kn)) > 1) + 1)
        caught = sum(1 for r in kr if any(i["start"] - 2 <= r[-1] and r[0] <= i["end"] + 2 for i in inc))
        right = sum(1 for i in inc if kn[max(0, i["start"] - 2):i["end"] + 3].any())
        known = {"incidents": len(kr), "caught": caught, "flagged": len(inc), "correct": right}
    # chart: <= 2400 buckets, value as min/max envelope, expectation as the mean, score as the bucket max
    step = int(max(1, math.ceil(n / 2400.0)))
    nb = int(math.ceil(n / float(step)))
    pad = nb * step - n

    def red(a, f):
        a = np.r_[a, np.repeat(a[-1:], pad, 0)] if pad else a
        return f(a.reshape(nb, step) if a.ndim == 1 else a.reshape(nb, step, -1), axis=1)
    chart = {"step": step, "n": n, "start": h["start"],
             "lo": [np.round(red(V[:, j], np.min), 6).tolist() for j in range(k)],
             "hi": [np.round(red(V[:, j], np.max), 6).tolist() for j in range(k)],
             "exp": [np.round(red(E[:, j], np.mean), 6).tolist() for j in range(k)],
             "score": np.round(red(score, np.max), 2).tolist(),
             "labels": [labels[min(n - 1, i * step)] for i in range(nb)] if labels else None}
    flagged = int(flag.sum())
    best = h["tests"][h["best"]]
    roll = h["tests"]["rolling"]
    missed = known is not None and known["caught"] < known["incidents"]
    if not inc and not missed:
        head = "Nothing unusual"
        sent = "No point in {} is {:g}+ typical errors from what the {} expected.".format(
            " / ".join(names), thr, DETECTORS[det].lower())
    elif not inc:
        head = "Missed {} known incident{}".format(known["incidents"], "" if known["incidents"] == 1 else "s")
        sent = ("Your table marks {} incident{}, but no point is {:g}+ typical errors from what the {} expected. Try a lower "
                "threshold or another method.").format(known["incidents"], "" if known["incidents"] == 1 else "s", thr, DETECTORS[det].lower())
    else:
        top = max(inc, key=lambda i: i["score"])
        head = "{} unusual moment{}".format(len(inc), "" if len(inc) == 1 else "s")
        sent = ("{} stretch{} of {} break the pattern ({:,} points, {:.2%} of the data). The strongest is at {}: {} was "
                "{:.4g}, but the expected value was about {:.4g} ({:.1f}x the typical error).").format(
            len(inc), "" if len(inc) == 1 else "es", " / ".join(names), flagged, flagged / float(n), top["label"],
            top["column"], top["value"], top["expected"], top["score"])
    check = ("On planted glitches the {} caught {} of {} at a 1-in-100 alarm rate{}.").format(
        best["name"].lower(), best["found"], best["planted"],
        "" if h["best"] == "rolling" else " (the moving median found {})".format(roll["found"]))
    if echoes:
        sent += " {} echo{} one period after an incident (the {} looks back one period) {} not counted.".format(
            echoes, "" if echoes == 1 else "es", DETECTORS[det].lower(), "is" if echoes == 1 else "are")
    if missed and inc:
        sent += " {} of your {} known incidents were caught.".format(known["caught"], known["incidents"])
    return {"headline": head, "sentence": sent, "check": check, "echoes": echoes, "detector": det, "best": h["best"], "tests": h["tests"],
            "threshold": thr, "incidents": sorted(inc, key=lambda i: -i["score"])[:400], "incident_count": len(inc),
            "flagged": flagged, "n": n, "names": names, "period": h["period"], "lags": h["lags"], "notes": h["notes"],
            "known": known, "chart": chart, "table": h["table"], "date_col": h["date_col"],
            "ms": round(secs * 1000, 1), "compute_s": round(h["secs"], 2)}


def incidents_table(tid, cols, date_col, label_col, detector, threshold):
    r = run(tid, cols, date_col, label_col, detector, threshold)
    rows = [[i["label"], i["column"], i["value"], i["expected"], i["score"], i["end"] - i["start"] + 1, i["start"] + 1]
            for i in sorted(r["incidents"], key=lambda i: i["start"])]
    if not rows:
        raise ValueError("there are no flagged moments to save")
    return sources.table_from_rows("anomalies in {}".format(r["table"]), ["when", "column", "value", "expected",
                                                                         "typical errors off", "points", "row"], rows)
