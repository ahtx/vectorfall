"""Loudness to ITU-R BS.1770-4 / EBU R128 (Tech 3341, 3342): K-weighting, gated integrated loudness, momentary and
short-term maxima, loudness range, sample and true peak. Pure numpy + scipy (an IIR filter is sequential work, so it
runs on the host: a 5-minute stereo clip measures in about 0.3 s).

The measurement keeps one number per 100 ms step (the K-weighted mean square, summed over the channels). Every
reading is built from those steps: a 400 ms momentary block is the mean of 4 steps, a 3 s short-term block the mean
of 30. The Sound Lab sends the steps to the browser, so the meter can read any selection at once with the same
arithmetic as this file.
"""
import math

import numpy as np

STEP = 0.1                     # s per sub-block
ABS_GATE = -70.0               # LUFS
REL_GATE = -10.0               # LU below the abs-gated mean (integrated)
LRA_GATE = -20.0               # LU below the abs-gated mean (loudness range)


def _kfilters(fs):
    """The two K-weighting stages for any sample rate, from the analog prototype of BS.1770 (the same design as
    libebur128): a +4 dB high shelf (the head) and a 38 Hz high-pass (RLB). At 48 kHz they give the standard's
    published coefficients."""
    f0, G, Q = 1681.974450955533, 3.999843853973347, 0.7071752369554196
    K = math.tan(math.pi * f0 / fs)
    Vh = 10 ** (G / 20.0)
    Vb = Vh ** 0.4996667741545416
    a0 = 1 + K / Q + K * K
    b1 = np.array([(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0])
    a1 = np.array([1.0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0])
    f0, Q = 38.13547087602444, 0.5003270373238773
    K = math.tan(math.pi * f0 / fs)
    d = 1 + K / Q + K * K
    b2 = np.array([1.0, -2.0, 1.0])
    a2 = np.array([1.0, 2 * (K * K - 1) / d, (1 - K / Q + K * K) / d])
    return (b1, a1), (b2, a2)


def kweight(x, fs):
    """x: (C, N) -> the K-weighted signal."""
    from scipy.signal import sosfilt
    (b1, a1), (b2, a2) = _kfilters(fs)
    return sosfilt(np.array([np.r_[b1, a1], np.r_[b2, a2]]), np.asarray(x, np.float64), axis=-1)


def steps(x, fs):
    """K-weighted mean square per 100 ms step, summed over channels (BS.1770 channel weights 1 for L and R)."""
    y = kweight(x, fs)
    n = int(round(STEP * fs))
    k = y.shape[-1] // n
    if k == 0:
        return np.zeros(0)
    return (y[:, :k * n] ** 2).reshape(y.shape[0], k, n).mean(-1).sum(0)


def lufs(e):
    e = np.asarray(e, np.float64)
    with np.errstate(divide="ignore"):
        return -0.691 + 10 * np.log10(np.maximum(e, 1e-20))


def _windows(e, m):
    """Mean of every run of m consecutive steps (the 400 ms or 3 s blocks, 100 ms apart)."""
    if e.size < m:
        return np.zeros(0)
    c = np.concatenate([[0.0], np.cumsum(e)])
    return (c[m:] - c[:-m]) / m


def integrated(e):
    b = _windows(e, 4)
    b = b[lufs(b) > ABS_GATE]
    if not b.size:
        return None
    g = lufs(b.mean()) + REL_GATE
    b = b[lufs(b) > g]
    return float(lufs(b.mean())) if b.size else None


def loudness_range(e):
    s = _windows(e, 30)
    s = s[lufs(s) > ABS_GATE]
    if not s.size:
        return None
    s = s[lufs(s) > lufs(s.mean()) + LRA_GATE]
    if s.size < 2:
        return 0.0
    L = lufs(s)
    return float(np.percentile(L, 95) - np.percentile(L, 10))


TP_MARGIN_DB = 3.0


def true_peak(x, fs):
    """Peak of the signal upsampled 4x (BS.1770 Annex 2). Only the 100 ms steps whose sample peak is within
    TP_MARGIN_DB of the loudest sample are upsampled. A step can only set the true peak if its own true peak passes
    the loudest sample, and between samples real music and speech rise well under 3 dB, so the result is the same
    as upsampling everything, for a fraction of the work (dense masters still upsample most steps)."""
    from scipy.signal import resample_poly
    x = np.asarray(x, np.float32)
    N, n, pad = x.shape[-1], int(round(STEP * fs)), 64
    if N == 0:
        return 0.0
    k = -(-N // n)
    sp = np.zeros(k, np.float32)
    full = (N // n) * n
    if full:
        sp[:N // n] = np.abs(x[:, :full]).reshape(x.shape[0], -1, n).max(-1).max(0)
    if full < N:
        sp[-1] = np.abs(x[:, full:]).max()
    best = float(sp.max())
    if best <= 0:
        return 0.0
    for i in np.flatnonzero(sp >= best * 10 ** (-TP_MARGIN_DB / 20)):
        lo, hi = max(0, i * n - pad), min(N, (i + 1) * n + pad)
        y = resample_poly(x[:, lo:hi], 4, 1, axis=-1)[:, (i * n - lo) * 4:(min(N, (i + 1) * n) - lo) * 4]
        if y.size:
            best = max(best, float(np.abs(y).max()))
    return best


def db(v):
    return round(20 * math.log10(v), 2) if v > 0 else None


def measure(x, fs, with_steps=False):
    """Every reading for x (C, N). LUFS values are None for silence (below the -70 LUFS gate)."""
    from concurrent.futures import ThreadPoolExecutor
    x = np.asarray(x, np.float32)
    with ThreadPoolExecutor(x.shape[0] + 1) as ex:          # scipy's filters free the GIL: channels and true peak in parallel
        parts = [ex.submit(steps, x[c:c + 1], fs) for c in range(x.shape[0])]
        tpf = ex.submit(true_peak, x, fs)
        e = sum(p.result() for p in parts) if parts else np.zeros(0)
        tp = tpf.result()
    m, s = _windows(e, 4), _windows(e, 30)
    I = integrated(e)
    lra = loudness_range(e)
    sp = float(np.abs(x).max()) if x.size else 0.0
    out = {"integrated": None if I is None else round(I, 2),
           "momentary_max": round(float(lufs(m.max())), 2) if m.size and lufs(m.max()) > ABS_GATE else None,
           "short_term_max": round(float(lufs(s.max())), 2) if s.size and lufs(s.max()) > ABS_GATE else None,
           "lra": None if lra is None else round(lra, 2),
           "sample_peak_db": db(sp), "true_peak_db": db(tp),
           "rms_db": db(float(np.sqrt(sum(float(np.dot(c, c)) for c in x) / x.size))) if x.size else None,
           "clipped": int((np.abs(x) >= 0.9999).sum()), "seconds": round(x.shape[-1] / float(fs), 3)}
    if with_steps:
        n = int(round(STEP * fs))
        k = x.shape[-1] // n
        out["step_s"] = STEP
        out["steps"] = [float("%.4g" % v) for v in e]
        out["step_peak"] = [round(float(v), 4) for v in np.abs(x[:, :k * n]).reshape(x.shape[0], k, n).max(-1).max(0)] if k else []
    return out


TARGETS = [("Streaming", -14.0, -1.0), ("Podcast", -16.0, -1.0), ("Broadcast (EBU R128)", -23.0, -1.0)]


def gain_to(m, target, ceiling):
    """The gain (dB) that brings integrated loudness to target, reduced when the true peak would pass the ceiling."""
    if m.get("integrated") is None:
        return None, False
    g = target - m["integrated"]
    tp = m.get("true_peak_db")
    if tp is not None and tp + g > ceiling:
        return round(ceiling - tp, 2), True
    return round(g, 2), False
