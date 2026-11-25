"""Find every occurrence of a sound in a recording, from one or two marked examples.

You select a stretch of the track in the Sound Lab and mark it ("cough", "dog", "door"). Everything you haven't
marked is taken to be "nothing in particular". The whole recording is cut into overlapping windows as long as a
typical mark; each window is turned into a log-mel spectrogram (GPU), rung through the Reservoir Lab's echo network
(GPU, every window at once), and a single ridge layer (GPU) learns marks vs. nothing. Windows that score as a sound
are merged into events with start and end times.

Two honest checks come with every run:
  * leave-one-mark-out: each mark is hidden in turn, the detector is trained without it, and we see whether it
    still finds it -- the closest thing to "will it find the ones I didn't mark?"
  * false alarms per minute, measured the same way on stretches with no marks (cross-validated).
Unmarked occurrences of a sound in the training background would teach the layer that they are "nothing"; one
self-training pass removes background windows that already look strongly like a mark before the final fit.
"""
import json
import math
import os
import time

import numpy as np

import cupy as cp

from . import engine, media
from .reservoir import DEFAULT_RES, FB, HOP, LAMS, NFFT, SR, WIN, _fit, _predict, reservoir_features

MAX_WINDOWS = 2400


def _mdir(sid):
    return os.path.join(media.ROOT, "sounds", os.path.basename(sid))


def get_marks(sid):
    p = os.path.join(_mdir(sid), "marks.json")
    if os.path.exists(p):
        with open(p) as f:
            return json.load(f)
    return []


def set_marks(sid, marks):
    clean = []
    for m in marks or []:
        a, b = float(m["a"]), float(m["b"])
        lab = str(m.get("label") or "").strip()[:40]
        if b - a >= 0.05 and lab:
            clean.append({"a": round(min(a, b), 4), "b": round(max(a, b), 4), "label": lab})
    with open(os.path.join(_mdir(sid), "marks.json"), "w") as f:
        json.dump(clean, f)
    return clean


def _mono16k(sid):
    st = media._state(sid)
    x = np.load(media._vpath(sid, st["cur"]))
    m = x.mean(0).astype(np.float32)
    from scipy.signal import resample_poly
    return resample_poly(m, 160, 441).astype(np.float32)            # 44.1 kHz -> 16 kHz (host, polyphase)


def _logmel(x):
    """Whole recording -> (T, 32) log-mel frames, each band standardised over the recording. Inside a GPU job."""
    g = cp.asarray(x)
    n = 1 + (g.size - WIN) // HOP
    out = []
    win = cp.hanning(WIN).astype(cp.float32)[None, :]
    fb = cp.asarray(FB).T
    for s in range(0, n, 20000):                                     # 200 s of frames per block keeps memory small
        e = min(n, s + 20000)
        idx = cp.arange(WIN, dtype=cp.int32)[None, :] + HOP * cp.arange(s, e, dtype=cp.int32)[:, None]
        pw = cp.abs(cp.fft.rfft(g[idx] * win, NFFT, axis=1)) ** 2
        out.append(cp.log(pw.astype(cp.float32) @ fb + 1e-6))
    lm = cp.concatenate(out, 0)
    energy = lm.mean(1)
    lm = (lm - lm.mean(0, keepdims=True)) / (lm.std(0, keepdims=True) + 1e-5)
    return lm, energy


def _window_features(x, W):
    """Cut a 16 kHz recording into windows of W frames (hop W/4, coarser for very long clips) and ring every window
    through the echo network. Returns (Phi = reservoir + raw + energy, Raw = raw + energy, starts, hop)."""
    hop = max(2, W // 4)
    res = dict(DEFAULT_RES, units=400)

    def job():
        lm, energy = _logmel(x)
        T = lm.shape[0]
        if T < W:
            raise ValueError("the recording is shorter than the marks")
        starts = np.arange(0, T - W + 1, hop)
        h = hop
        if starts.size > MAX_WINDOWS:                                 # very long clips: coarser hop, same window
            h = int(math.ceil((T - W) / float(MAX_WINDOWS - 1)))
            starts = np.arange(0, T - W + 1, h)
        lmh = cp.asnumpy(lm)
        en = cp.asnumpy(energy)
        seqs = [lmh[s_:s_ + W] - lmh[s_:s_ + W].mean(0, keepdims=True) for s_ in starts]   # per-window CMVN
        feats, raws = [], []
        from . import cards
        bs = cards.launch_budget(600, cap=MAX_WINDOWS, bound="memory")   # batches of windows; bigger on faster cards
        for i in range(0, len(seqs), bs):
            F, R, _, _ = reservoir_features(seqs[i:i + bs], res)
            feats.append(F)
            raws.append(R)
        F = np.concatenate(feats, 0)
        R = np.concatenate(raws, 0)
        E = np.stack([en[s_:s_ + W].mean() for s_ in starts])[:, None]
        En = (E - E.mean()) / (E.std() + 1e-6)
        Phi = np.concatenate([F, R, En], 1).astype(np.float32)
        Raw = np.concatenate([R, En], 1).astype(np.float32)          # the baseline: the same layer without the reservoir
        return Phi, Raw, starts, h
    return engine.run_on_gpu(job, "sound finder: listening", 240)


def _merge_events(ws, we, sc, threshold, names, marks, W):
    """Window scores -> events: runs of windows called the same sound, merged when close, with the peak score."""
    nW = len(ws)
    best = sc.argmax(1)
    margin = sc[np.arange(nW), best] - sc[:, 0]
    hit = (best > 0) & (margin > threshold)
    events = []
    i = 0
    while i < nW:
        if not hit[i]:
            i += 1
            continue
        j = i
        while j + 1 < nW and hit[j + 1] and best[j + 1] == best[i]:
            j += 1
        pk = i + int(np.argmax(margin[i:j + 1]))
        a, b = float(ws[i]), float(we[j])
        events.append({"a": round(a, 3), "b": round(b, 3), "peak": round(float((ws[pk] + we[pk]) / 2), 3), "label": names[best[i]],
                       "score": round(float(margin[pk]), 3),
                       "marked": any(min(b, m["b"]) - max(a, m["a"]) > 0.3 * (m["b"] - m["a"]) for m in marks)})
        i = j + 1
    merged = []                                                      # one sound often lights up two nearby runs of windows
    for e in events:
        if merged and merged[-1]["label"] == e["label"] and e["a"] - merged[-1]["b"] < 0.5 * W * HOP / float(SR):
            p_ = merged[-1]
            if e["score"] > p_["score"]:
                p_["score"], p_["peak"] = e["score"], e["peak"]
            p_["b"] = max(p_["b"], e["b"])
            p_["marked"] = p_["marked"] or e["marked"]
        else:
            merged.append(e)
    return merged, best, margin


NOTHING = "nothing"            # a mark with this label is a "not this" example: explicit background
CHANCE_REPEATS = 3


def _evidence(events, null):
    """Each event's score against the background: how often an unmarked window (scored by a detector that did not
    train on it) scores as high. A small rate is strong evidence; 1 in 2 is chance."""
    null = np.sort(np.asarray(null, np.float64))
    n = null.size
    for e in events:
        if not n:
            e["bg_rate"], e["bg_hits"], e["bg_n"] = None, None, 0
            continue
        k = n - int(np.searchsorted(null, e["score"], side="left"))
        e["bg_rate"] = round((k + 1.0) / (n + 1.0), 5)          # (k + 1) / (n + 1): never zero from a finite sample
        e["bg_hits"], e["bg_n"] = k, n
    return events


def apply(model_sid, sid, threshold=None):
    """Use the detector learned on one clip (its marks) to find the same sounds in another clip."""
    t0 = time.time()
    p = os.path.join(_mdir(model_sid), "finder.npz")
    if not os.path.exists(p):
        raise ValueError("learn the marks first: press Learn and find on the clip that has the marks")
    z = np.load(p, allow_pickle=False)
    labels = [str(v) for v in z["labels"].tolist()]
    W, feats = int(z["W"]), str(z["feats"])
    th = float(z["threshold"]) if threshold is None else float(threshold)
    null = z["null"] if "null" in z.files else np.zeros(0)
    x = _mono16k(sid)
    Phi, Raw, starts, hop = _window_features(x, W)
    X = Phi if feats == "reservoir" else Raw
    model = (z["mu"], z["sd"], z["W_"], z["ym"])
    sc = engine.run_on_gpu(lambda: cp.asnumpy(_predict(tuple(cp.asarray(a) for a in model), X)), "sound finder: scoring", 60)
    ws = starts * HOP / float(SR)
    we = ws + W * HOP / float(SR)
    names = ["nothing"] + labels
    events, best, margin = _merge_events(ws, we, sc, th, names, [], W)
    _evidence(events, null)
    counts = {l: sum(1 for e in events if e["label"] == l) for l in labels}
    parts = ", ".join("{} {}".format(n, l) for l, n in counts.items())
    return {"events": events, "labels": labels, "counts": counts, "windows": int(len(starts)), "window_s": round(W * HOP / float(SR), 3),
            "threshold": th, "features": feats, "seconds": round(x.size / float(SR), 2), "ms": round((time.time() - t0) * 1000, 1),
            "sentence": ("Found {} event{} ({}) in this clip with the detector from the marked clip.".format(len(events), "" if len(events) == 1 else "s", parts)
                         if events else "Nothing in this clip looks enough like the marked sounds at this sensitivity."),
            "check": "The background rates come from the marked clip: other recordings can differ, so listen to a few events.",
            "curve": {"t": [round(float((a + b) / 2), 3) for a, b in zip(ws, we)], "score": [round(float(max(0.0, v)), 3) for v in margin],
                      "label": [int(v) for v in best]}}


def _window_labels(marks, labels, ws, we):
    """Each window's class: the mark covering most of it (>= 50% of the window or of the mark), else 0 ("nothing").
    owner = the index of that mark; near = partly covered by a mark (neither label is right, so not used)."""
    nW = ws.size
    y = np.zeros(nW, np.int32)
    owner = np.full(nW, -1, np.int32)
    near = np.zeros(nW, bool)
    neg = np.zeros(nW, bool)
    for mi, m in enumerate(marks):
        ov = np.clip(np.minimum(we, m["b"]) - np.maximum(ws, m["a"]), 0, None)
        hit = (ov >= 0.5 * (we - ws)) | (ov >= 0.5 * (m["b"] - m["a"]))
        if m["label"].lower() == NOTHING:
            neg |= hit
            continue
        y[hit] = labels.index(m["label"]) + 1
        owner[hit] = mi
        near |= ov > 0
    near &= ~(y > 0)
    return y, owner, near, neg


def _random_marks(marks, dur, rng):
    """The same marks (lengths and labels) moved to random places that overlap no real mark: a detector trained on
    these has learned nothing, so its hidden-mark score is the level of chance."""
    pos = [m for m in marks if m["label"].lower() != NOTHING]
    taken = [(m["a"] - 0.5, m["b"] + 0.5) for m in marks]
    out = []
    for m in pos:
        L = m["b"] - m["a"]
        for _ in range(200):
            a = float(rng.uniform(0, max(1e-3, dur - L)))
            if all(a + L < lo or a > hi for lo, hi in taken):
                out.append({"a": a, "b": a + L, "label": m["label"]})
                taken.append((a - 0.5, a + L + 0.5))
                break
    return out


def find(sid, threshold=0.5):
    t0 = time.time()
    marks = get_marks(sid)
    pos = [m for m in marks if m["label"].lower() != NOTHING]
    labels = sorted({m["label"] for m in pos})
    if not pos:
        raise ValueError("mark at least one example first: select a stretch of the track and press Mark")
    x = _mono16k(sid)
    dur = x.size / float(SR)
    lens = np.array([m["b"] - m["a"] for m in pos])
    W = int(np.clip(np.median(lens) * SR / HOP, 15, 300))           # window length in 10 ms frames
    Phi, Raw, starts, hop = _window_features(x, W)
    FEATS = {"reservoir": Phi, "raw": Raw}
    ws = starts * HOP / float(SR)
    we = ws + W * HOP / float(SR)
    nW = len(starts)
    C = len(labels) + 1
    y, owner, near, neg = _window_labels(marks, labels, ws, we)
    use = (y > 0) | ~near
    names = ["nothing"] + labels

    def fit_predict(y_, train_mask, predict_idx, lam, feats="reservoir"):
        X = FEATS[feats]
        # a few marked windows against hundreds of "nothing" ones: repeat each sound's windows until every sound
        # carries as much weight as the background, or the layer learns that "nothing" is always the safe answer
        rows = np.flatnonzero(train_mask)
        nb = max(1, int((y_[rows] == 0).sum()))
        parts = [rows[y_[rows] == 0]]
        for k in range(1, C):
            rk = rows[y_[rows] == k]
            if rk.size:
                parts.append(np.tile(rk, int(max(1, round(nb / float(rk.size))))))
        rows = np.concatenate(parts)
        m = _fit(X[rows], np.eye(C, dtype=np.float32)[y_[rows]], lam)
        return cp.asnumpy(_predict(m, X[predict_idx])), m

    def lomo(ms, y_, owner_, train, lam, feats):
        """Leave-one-mark-out: hide each mark (and 0.5 s around it), train on the rest, see if it is found."""
        res = []
        for mi, m in enumerate(ms):
            if m["label"].lower() == NOTHING:
                continue
            k = labels.index(m["label"]) + 1
            hide = (we > m["a"] - 0.5) & (ws < m["b"] + 0.5)
            tr = train & ~hide
            mine = np.flatnonzero(owner_ == mi)
            if (y_[tr] == k).sum() == 0 or mine.size == 0:
                res.append(None)                                     # the only example of its kind: nothing to learn from
                continue
            s2, _ = fit_predict(y_, tr, mine, lam, feats)
            res.append(bool(((s2.argmax(1) == k) & (s2[:, k] - s2[:, 0] > threshold)).any()))
        return res

    def false_alarms(train, lam, feats):
        """4 folds of the recording: windows with no mark, scored by a detector that did not train on them."""
        fa, bgn, null = 0, 0, []
        for ch in np.array_split(np.arange(nW), 4):
            tr = train.copy()
            tr[ch] = False
            bg = ch[(y[ch] == 0) & ~near[ch] & train[ch]]
            if bg.size == 0 or not (y[tr] > 0).any():
                continue
            s2, _ = fit_predict(y, tr, bg, lam, feats)
            mg = s2[:, 1:].max(1) - s2[:, 0]
            fa += int(((s2.argmax(1) > 0) & (mg > threshold)).sum())
            bgn += bg.size
            null.append(mg)
        return fa, bgn, (np.concatenate(null) if null else np.zeros(0))

    def job2():
        # ridge strength (and reservoir vs. raw features): chosen by what matters -- finding marks it hasn't seen,
        # without raising false alarms. Overlapping windows of one mark would leak across ordinary random folds and
        # reward memorising, so the folds are whole marks.
        tried = {}
        for feats in ("reservoir", "raw"):
            for lam in LAMS + (10.0, 100.0):
                lo_ = lomo(marks, y, owner, use, lam, feats)
                fa, bgn, _ = false_alarms(use, lam, feats)
                t = [v for v in lo_ if v is not None]
                score = (sum(t) / float(len(t)) if t else 0.0) - 4.0 * fa / max(1, bgn)
                if feats not in tried or score > tried[feats][0] + 1e-9:
                    tried[feats] = (score, lam, sum(t), len(t), fa, bgn)
        feats = "reservoir" if tried["reservoir"][0] >= tried["raw"][0] - 1e-9 else "raw"
        lam = tried[feats][1]
        # self-training: background windows that already look strongly like a mark are probably unmarked occurrences
        # (never the ones you marked as "nothing")
        sc_all, _ = fit_predict(y, use, np.arange(nW), lam, feats)
        marg = sc_all[:, 1:].max(1) - sc_all[:, 0]
        suspect = (y == 0) & use & ~neg & (marg > max(0.4, threshold))
        train = use & ~suspect
        sc, mdl = fit_predict(y, train, np.arange(nW), lam, feats)
        lo_ = lomo(marks, y, owner, train, lam, feats)
        fa_w, bg_n, null = false_alarms(train, lam, feats)
        # chance: the same marks at random places, the same layer and checks
        rng = np.random.RandomState(7)
        chance = []
        for _ in range(CHANCE_REPEATS):
            rm = _random_marks(marks, dur, rng) + [m for m in marks if m["label"].lower() == NOTHING]
            yr, orr, nr, _ = _window_labels(rm, labels, ws, we)
            t = [v for v in lomo(rm, yr, orr, (yr > 0) | ~nr, lam, feats) if v is not None]
            if t:
                chance.append(sum(t) / float(len(t)))
        return lam, sc, suspect, lo_, fa_w, bg_n, feats, tried, tuple(cp.asnumpy(a) for a in mdl), null, chance
    lam, sc, suspect, lo_, fa_w, bg_n, feats, tried, mdl, null, chance = engine.run_on_gpu(job2, "sound finder: training", 240)
    np.savez(os.path.join(_mdir(sid), "finder.npz"), mu=mdl[0], sd=mdl[1], W_=mdl[2], ym=mdl[3], labels=np.array(labels),
             W=np.array(W), feats=np.array(feats), threshold=np.array(threshold), null=np.asarray(null, np.float32))
    events, best, margin = _merge_events(ws, we, sc, threshold, names, pos, W)
    _evidence(events, null)
    tested = [v for v in lo_ if v is not None]
    bg_minutes = bg_n * hop * HOP / float(SR) / 60.0
    per_label = {l: sum(1 for e in events if e["label"] == l) for l in labels}
    ch = round(float(np.mean(chance)) * len(tested), 2) if chance and tested else None
    out = {"events": events, "labels": labels, "counts": per_label, "marks": len(pos), "negatives": len(marks) - len(pos),
           "window_s": round(W * HOP / float(SR), 3), "hop_s": round(hop * HOP / float(SR), 3), "windows": int(nW), "lambda": lam,
           "suspects": int(suspect.sum()),
           "lomo": {"tested": len(tested), "found": int(sum(tested)), "untestable": len(lo_) - len(tested), "per_mark": lo_,
                    "chance": ch, "chance_runs": len(chance)},
           "false_alarms_per_min": round(fa_w / bg_minutes, 2) if bg_minutes > 0 else None, "seconds": round(dur, 2),
           "background_windows": int(len(null)), "threshold": threshold, "ms": round((time.time() - t0) * 1000, 1), "features": feats,
           "compare": {k: {"found": v[2], "tested": v[3], "false_alarm_windows": v[4], "background_windows": v[5], "lambda": v[1]} for k, v in tried.items()},
           "curve": {"t": [round(float((a + b) / 2), 3) for a, b in zip(ws, we)], "score": [round(float(max(0.0, v)), 3) for v in margin],
                     "label": [int(v) for v in best]}}
    found_new = sum(1 for e in events if not e["marked"])
    parts = ", ".join("{} {}".format(n, l) for l, n in per_label.items())
    out["sentence"] = ("Found {} event{} ({}) — {} beyond the ones you marked.".format(len(events), "" if len(events) == 1 else "s", parts or "none", found_new)
                       if events else "Nothing in the recording looks enough like your marks at this sensitivity.")
    if tested:
        out["check"] = "The check hid each mark in turn. The detector found {} of {} again".format(out["lomo"]["found"], len(tested))
        if ch is not None:
            out["check"] += "; the same marks at random places found {:.1f} (chance)".format(ch)
        out["check"] += "."
        if out["false_alarms_per_min"] is not None:
            out["check"] += " It raised {:.1f} false alarm{} per minute on unmarked audio.".format(
                out["false_alarms_per_min"], "" if out["false_alarms_per_min"] == 1 else "s")
        r_, w_ = tried["reservoir"], tried["raw"]
        out["check"] += " Reservoir features {}/{} vs the same layer on the raw spectrogram {}/{}{}.".format(
            r_[2], r_[3], w_[2], w_[3], "" if feats == "reservoir" else " — the raw spectrogram was better here ({}), so the Lab uses it".format(
                "more found" if w_[2] > r_[2] else "fewer false alarms"))
    else:
        out["check"] = "Mark at least two examples of a sound. Then the Lab can measure how reliably it finds the sound."
    return out


def events_table(sid, events):
    from . import sources
    name = next((c["name"] for c in media.sound_list() if c["id"] == sid), sid)
    rows = [[e["label"], e["a"], e["b"], round(e["b"] - e["a"], 3), e["score"], e.get("bg_rate"), "yes" if e.get("marked") else ""] for e in events]
    if not rows:
        raise ValueError("no events to save")
    return sources.table_from_rows("events in {}".format(name.rsplit(".", 1)[0]), ["sound", "start s", "end s", "length s", "score", "background rate", "marked"], rows)


def to_reservoir(sid, name, events=None):
    """Every mark (and, optionally, confident detections) -> a new Reservoir Lab sound project."""
    from . import reservoir
    marks = get_marks(sid)
    if not marks:
        raise ValueError("no marks to send")
    x = _mono16k(sid)
    meta = reservoir.create(name or "From the Sound Lab", "audio")
    n = 0
    for m in marks + [e for e in (events or []) if not e.get("marked")]:
        a, b = int(m["a"] * SR), int(m["b"] * SR)
        if b - a < SR * 0.15:
            continue
        reservoir.add_example(meta["id"], m["label"], {"audio": x[a:b]}, source="Sound Lab {:.2f}-{:.2f}s".format(m["a"], m["b"]))
        n += 1
    return {"id": meta["id"], "n": n}


def mute(sid, events, how="mute"):
    """Silence (or turn down) every event in one undoable edit."""
    st = media._state(sid)
    x = np.load(media._vpath(sid, st["cur"])).copy()
    N = x.shape[1]
    g = np.ones(N, np.float32)
    fade = int(0.01 * media.SR)
    level = 0.0 if how == "mute" else 10 ** (-12 / 20.0)
    for e in events:
        a, b = max(0, int(e["a"] * media.SR)), min(N, int(e["b"] * media.SR))
        if b <= a:
            continue
        seg = np.full(b - a, level, np.float32)
        r = np.linspace(1, level, min(fade, (b - a) // 2), dtype=np.float32)
        seg[:r.size] = r
        seg[seg.size - r.size:] = r[::-1]
        g[a:b] = np.minimum(g[a:b], seg)
    label = "{} {} found sound{}".format("Muted" if how == "mute" else "Turned down", len(events), "" if len(events) == 1 else "s")
    return media.sound_commit(sid, x * g[None, :], label)
