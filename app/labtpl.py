"""Your own problem in the Reservoir and Particle labs, from plain text (or a Data Desk table), in one call.

  updown    "Will my series go up or down?"   one number per line (or date,value lines)     -> a forecast project, trained,
            scored on the unseen last 30% against "always the commoner move" and "it keeps going the way it went"
  classify  "Classify my recordings"          one labelled example per line: `label, 1.2 3.4 …` (a sensor trace) or
            `label, <Sound Lab clip>[, start s, end s]`                                     -> a classify project, cross-
            validated against chance and the same readout on the raw input; optional new lines to label
  group     "How will my group change?"       CSV: date,name,value[,group] (long) or date,A,B,C (wide)
                                                                                           -> a Particle Lab run from the
            latest start with a known outcome, against "nothing changes" and "growth carries on, no interactions"

Each parser names the line of a mistake. check() reads the text without running anything. The results lead with
headline, sentence, compare_text and explain, like the Planner.
"""
import csv
import io
import re

import numpy as np

from . import registry as R


def _lines(text):
    return [(i + 1, ln) for i, ln in enumerate((text or "").replace("\r", "").split("\n")) if ln.strip() and not ln.lstrip().startswith("#")]


def _num(v):
    try:
        x = float(str(v).replace(",", "").strip())
        return x if np.isfinite(x) else None
    except ValueError:
        return None


# ---------------------------------------------------------------- series
def read_series(text):
    """One number per line, or lines like 2024-01-31,412 (the last number on the line counts). A header line is skipped."""
    vals = []
    rows = _lines(text)
    for k, (no, ln) in enumerate(rows):
        parts = [p.strip() for p in re.split(r"[,;\t]", ln) if p.strip()]
        v = _num(parts[-1]) if parts else None
        if v is None:
            if k == 0 and not any(_num(p) is not None for p in parts):
                continue                                         # a header line such as "date,visitors"
            raise ValueError("line {}: {!r} is not a number".format(no, parts[-1] if parts else ln))
        vals.append(v)
    if len(vals) < 120:
        raise ValueError("{} numbers: a forecast needs at least 120 (it learns on the first 70% and is tested on the rest)".format(len(vals)))
    return vals


def _rv():
    from . import reservoir
    return reservoir


def updown(numbers="", table=None, col="", horizon=1, keep=False, name="", job=None):
    rv = _rv()
    if table:
        from . import media, sources
        meta = next((t for t in media.table_list() if t["id"] == table), {})
        col = col or ((meta.get("numeric") or [None])[0])
        if not col:
            raise R.Refused("that table has no number column")
        s = sources.series(table, [col], "auto")
        vals, src = [float(v) for v in s["values"][:, 0]], "Data Desk: {} · {}".format(s["table"], col)
        if len(vals) < 120:
            raise R.Refused("{} values in {}: a forecast needs at least 120".format(len(vals), col))
    else:
        vals, src = read_series(numbers), "pasted"
    p = rv.create(name or "Up or down: {}".format(col or "my series"), "series")
    try:
        rv.update(p["id"], {"forecast": {"horizon": int(horizon)}})
        rv.set_series(p["id"], [[v] for v in vals], [col or "value"], src)
        rep = rv.train(p["id"], job)
    except Exception:
        rv.delete(p["id"])
        raise
    if not keep:
        rv.delete(p["id"])
    b = rep["baselines"]
    best = max(b["always_majority"], b["persistence"])
    acc = rep["reservoir"]["acc"]
    nt = rep["test_points"]
    h = "{:.0%}".format(acc)
    tone = "good" if "beats" in rep["verdict"] else "warn"
    sent = "On the {} periods it never saw, the forecaster called the move {} step{} ahead right {:.1%} of the time; the best simple rule got {:.1%}. Verdict: {}.".format(
        nt, horizon, "" if horizon == 1 else "s", acc, best, rep["verdict"])
    cmp_ = "Always the commoner move {:.1%} · keeps going the way it went {:.1%} · same readout on the raw numbers {:.1%} · reservoir {:.1%}.".format(
        b["always_majority"], b["persistence"], rep["raw"]["acc"], acc)
    ex = ["It learned on the first {} periods and was tested on the last {} (in time order: no peeking at the future).".format(rep["train_points"], nt),
          "In the test span the series went up {:.0%} of the time, so 'always say {}' is right {:.1%}.".format(
              rep["up_rate_test"], "up" if rep["up_rate_test"] >= 0.5 else "down", b["always_majority"]),
          "The same readout on the last {} raw values gets {:.1%}: the reservoir {} it.".format(
              rep["lags"], rep["raw"]["acc"], "beats" if acc > rep["raw"]["acc"] + 0.005 else "ties" if abs(acc - rep["raw"]["acc"]) <= 0.005 else "loses to"),
          "Chance of a score this good by luck: p = {:.3g} ({} independent tests).".format(rep["p_value_independent"], rep["independent_tests"]),
          "The call for the next {}: {}.".format("period" if horizon == 1 else "{} periods".format(horizon), rep["next"]["call"])]
    out = {"headline": h, "tone": tone, "sentence": sent, "compare_text": cmp_, "explain": ex, "next": rep["next"],
           "report": {k: rep[k] for k in ("n", "horizon", "train_points", "test_points", "reservoir", "raw", "baselines", "p_value_independent", "verdict")},
           "project": p["id"] if keep else None}
    return out


# ---------------------------------------------------------------- classify
def read_labelled(text, need_labels=True):
    """-> ("numbers" | "audio", [(line, label, payload)]). A line: `label, 1 2 3 …` or `label, clip name[, start, end]`."""
    rows = []
    kinds = set()
    for no, ln in _lines(text):
        m = re.match(r"^\s*([^,:;\t]+?)\s*[,:;\t]\s*(.+)$", ln)
        if not m:
            raise ValueError("line {}: write `label, values` (or `label, sound clip`)".format(no))
        label, rest = m.group(1).strip(), m.group(2).strip()
        toks = [t for t in re.split(r"[\s,;]+", rest) if t]
        nums = [_num(t) for t in toks]
        if toks and all(x is not None for x in nums):
            if len(nums) < 4:
                raise ValueError("line {}: {} values; a recording needs at least 4".format(no, len(nums)))
            rows.append((no, label, {"numbers": nums}))
            kinds.add("numbers")
        else:
            bad = [t for t, x in zip(toks, nums) if x is None]
            if len(toks) >= 4 and len(bad) <= len(toks) // 2:
                raise ValueError("line {}: {!r} is not a number".format(no, bad[0]))
            parts = [p.strip() for p in rest.split(",")]
            clip, a, b = parts[0], None, None
            if len(parts) >= 3 and _num(parts[1]) is not None and _num(parts[2]) is not None:
                a, b = _num(parts[1]), _num(parts[2])
                if b <= a:
                    raise ValueError("line {}: the end ({}) must come after the start ({})".format(no, b, a))
            elif len(parts) > 1:
                raise ValueError("line {}: after the clip name give a start and an end in seconds, or nothing".format(no))
            rows.append((no, label, {"clip": clip, "start": a, "end": b}))
            kinds.add("audio")
    if not rows:
        raise ValueError("no examples: one line for each recording, `label, values`")
    if len(kinds) > 1:
        first = rows[0][2]
        odd = next(no for no, _, it in rows if ("clip" in it) != ("clip" in first))
        raise ValueError("line {}: a {} among {}: one project takes one kind".format(
            odd, "sound clip" if "clip" not in first else "number trace", "number traces" if "clip" not in first else "sound clips"))
    if need_labels:
        counts = {}
        for _, lb, _ in rows:
            counts[lb] = counts.get(lb, 0) + 1
        if len(counts) < 2:
            raise ValueError("only one label ({}): give examples of at least two".format(next(iter(counts))))
        few = [lb for lb, c in counts.items() if c < 2]
        if few:
            raise ValueError("give at least 2 examples of each label for an honest test; too few: {}".format(", ".join(few)))
    return kinds.pop(), rows


def _clip_audio(ref, a=None, b=None):
    """A Sound Lab clip (id or part of its name) as float32 at 16 kHz, cut to [a, b] seconds."""
    import os
    from . import media
    sid = R._resolve("sound", ref)
    x = np.load(os.path.join(media.ROOT, "sounds", sid, "audio.npy")).astype(np.float32)
    if x.ndim > 1:
        x = x.mean(1) if x.shape[1] <= 8 else x.mean(0)
    sr = media.SR
    if a is not None:
        x = x[int(a * sr):int(b * sr)]
    if x.size < sr // 20:
        raise ValueError("the clip {!r} is too short there".format(ref))
    n = int(round(x.size * 16000 / sr))
    return np.interp(np.linspace(0, x.size - 1, n), np.arange(x.size), x).astype(np.float32)


def _payload(kind, item):
    if kind == "numbers":
        return {"numbers": item["numbers"]}
    return {"audio": _clip_audio(item["clip"], item["start"], item["end"])}


def classify(examples, test="", keep=False, name="", job=None):
    rv = _rv()
    kind, rows = read_labelled(examples)
    tests = []
    if (test or "").strip():
        tk, trows = read_labelled("\n".join(ln if re.match(r"^[^,:;\t]+[,:;\t]", ln) else "?, " + ln for ln in (test or "").splitlines() if ln.strip()), need_labels=False)
        if tk != kind:
            raise ValueError("the new recordings are a different kind from the examples")
        tests = trows
    p = rv.create(name or "Classify: my recordings", kind)
    try:
        for i, (no, label, item) in enumerate(rows):
            try:
                rv.add_example(p["id"], label, _payload(kind, item), "line {}".format(no))
            except (ValueError, KeyError, R.ParamError) as e:
                raise ValueError("line {}: {}".format(no, e))
            if job:
                job.step(0.4 * (i + 1) / len(rows), "example {} of {}".format(i + 1, len(rows)))
        rep = rv.train(p["id"], job)
        labelled = []
        for no, _, item in tests:
            r = rv.test(p["id"], _payload(kind, item))
            labelled.append({"line": no, "label": r.get("label") or r.get("best"), "scores": r.get("scores") or r.get("probs")})
    except Exception:
        rv.delete(p["id"])
        raise
    if not keep:
        rv.delete(p["id"])
    cv, raw = rep.get("cv") or {}, rep.get("raw") or {}
    acc, chance, racc = cv.get("acc"), rep["chance"], raw.get("acc")
    beat = acc is not None and acc > max(chance, racc or 0) + 0.02 and (rep.get("p_value") or 1) < 0.05
    sent = ("Held out in turn, {:.0%} of the {} recordings got the right label ({} labels). Chance (always the commonest label) is {:.0%}."
            .format(acc, rep["n"], len(rep["classes"]), chance) if acc is not None else rep["summary"])
    cmp_ = "Chance {:.0%} · the same readout on the raw recordings {} · reservoir {}.".format(
        chance, "{:.0%}".format(racc) if racc is not None else "-", "{:.0%}".format(acc) if acc is not None else "-")
    ex = ["Each recording was hidden in turn ({}-fold cross-validation) and labelled by a readout trained on the others.".format(rep["folds"]),
          "The baseline 'always the commonest label' is right {:.0%}; the same readout on the raw input, without the reservoir, {}.".format(
              chance, "{:.0%}".format(racc) if racc is not None else "was not measured")]
    if rep.get("p_value") is not None:
        ex.append("Chance of a score this good by luck: p = {:.3g}.".format(rep["p_value"]))
    if cv.get("confusion"):
        C = np.array(cv["confusion"])
        off = [(C[i, j], rep["classes"][i], rep["classes"][j]) for i in range(len(C)) for j in range(len(C)) if i != j and C[i, j]]
        if off:
            n_, a, b = max(off)
            ex.append("The commonest mistake: {} recording{} of '{}' called '{}'.".format(n_, "" if n_ == 1 else "s", a, b))
    for t in labelled:
        ex.append("New recording on line {}: {}.".format(t["line"], t["label"]))
    return {"headline": "{:.0%}".format(acc) if acc is not None else "trained", "tone": "good" if beat else "warn", "sentence": sent,
            "compare_text": cmp_, "explain": ex, "classes": rep["classes"], "counts": rep["counts"], "confusion": cv.get("confusion"),
            "labelled": labelled, "project": p["id"] if keep else None, "kind": kind}


# ---------------------------------------------------------------- groups (Particle Lab)
def read_group(text):
    """CSV: date,name,value[,group] (one row per body per date) or date,A,B,C (one column per body). -> a panel."""
    from . import particles as PT, sources
    rows = _lines(text)
    if len(rows) < 2:
        raise ValueError("a header line and at least 4 dates")
    try:
        dialect = csv.Sniffer().sniff("\n".join(ln for _, ln in rows[:20]), delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    parsed = [(no, [c.strip() for c in next(csv.reader([ln], dialect))]) for no, ln in rows]
    head = [h.lower() for h in parsed[0][1]]
    body = parsed[1:]

    def date_key(v, no):
        d = sources.parse_date(v)
        if d:
            return d.strftime("%Y-%m-%d")
        if re.match(r"^\d{4}$", v.strip()):
            return v.strip() + "-12-31"
        if re.match(r"^\d{4}[- ]?q[1-4]$", v.strip().lower()):
            y, q = v.strip()[:4], int(v.strip()[-1])
            return "{}-{:02d}-28".format(y, 3 * q)
        raise ValueError("line {}: {!r} is not a date (2024-03-31, 03/31/2024, 2024, 2024-Q1)".format(no, v))
    long_ = len(head) in (3, 4) and body and _num(body[0][1][1]) is None and _num(body[0][1][2]) is not None
    groups = {}
    if long_:
        cells = {}
        for no, r in body:
            if len(r) < 3:
                raise ValueError("line {}: needs date, name and value".format(no))
            v = _num(r[2])
            if v is None:
                raise ValueError("line {}: the value {!r} is not a number".format(no, r[2]))
            k = date_key(r[0], no)
            cells[(k, r[1])] = v
            if len(r) > 3 and r[3]:
                groups.setdefault(r[1], r[3])
        dates = sorted({k for k, _ in cells})
        names = sorted({n for _, n in cells})
        V = np.full((len(dates), len(names)), np.nan)
        di, ni = {d: i for i, d in enumerate(dates)}, {n: i for i, n in enumerate(names)}
        for (k, n), v in cells.items():
            V[di[k], ni[n]] = v
        what = head[2]
    else:
        names = parsed[0][1][1:]
        if len(names) < 3:
            raise ValueError("line 1: a wide table needs a date column and at least 3 bodies (date,A,B,C); or use date,name,value lines")
        rowsv = []
        for no, r in body:
            if len(r) != len(names) + 1:
                raise ValueError("line {}: {} values, but line 1 names {} bodies".format(no, len(r) - 1, len(names)))
            vals = []
            for j, c in enumerate(r[1:]):
                v = _num(c) if c else None
                if c and v is None:
                    raise ValueError("line {}, column {} ({}): {!r} is not a number".format(no, j + 2, names[j], c))
                vals.append(np.nan if v is None else v)
            rowsv.append((date_key(r[0], no), vals))
        rowsv.sort()
        dates = [d for d, _ in rowsv]
        V = np.array([v for _, v in rowsv], np.float64)
        what = "value"
    if len(dates) < 4:
        raise ValueError("{} dates: a group needs at least 4".format(len(dates)))
    if len(names) < 3:
        raise ValueError("{} bodies: a group needs at least 3".format(len(names)))
    P = PT.table_panel(dates, names, V, groups or None, what=what, group_name="group")
    P["step"] = "step"
    return P


def group_explain(res, fit=()):
    """Plain-word lines for a particles.run result on your table."""
    if not res.get("scores"):
        return ["The run starts at the end of your data, so there is nothing to compare it with yet."]
    s, b, n = res["scores"]["rules"], res["scores"]["persistence"], res["scores"]["no interactions"]
    ex = ["The run started at {} with what was known then, and ran to {} (the last date of your data), so it can be scored.".format(res["t0"][:10], (res["t1"] or "")[:10]),
          "Share in the wrong group at the end: rules {:.1%}, 'nothing changes' {:.1%}, 'growth carries on, no interactions' {:.1%}.".format(
              s["sector_l1"], b["sector_l1"], n["sector_l1"])]
    if s.get("rank_rho") is not None:
        ex.append("Who grew fastest, rank correlation with what happened: rules {:+.2f}, no interactions {:+.2f} (0 = no better than a guess).".format(
            s["rank_rho"], n["rank_rho"] or 0))
    if res.get("fitted"):
        names = {"beta": "growth carries on", "kappa": "growth fades", "alpha": "size effect", "G": "neighbourhood takeover"}
        ex.append("Rules fitted on the window before the start: " + ", ".join("{} {:.3g}".format(names.get(k, k), v) for k, v in res["fitted"]["params"].items()
                                                                              if not fit or k in fit) + ".")
    top = sorted(res["bodies"], key=lambda r: -(r["w"] - r["w0"]))[:3]
    ex.append("Biggest gains in the run: " + ", ".join("{} {:+.1%}".format(r["name"], r["w"] - r["w0"]) for r in top) + ".")
    return ex


# ---------------------------------------------------------------- the check (no run)
def check(kind, text="", horizon=1):
    try:
        if kind == "updown":
            v = read_series(text)
            return {"ok": True, "facts": ["{} numbers: learns on the first {}, tested on the last {}".format(len(v), int(len(v) * 0.7), len(v) - int(len(v) * 0.7)),
                                          "horizon {} step{} ahead".format(horizon, "" if horizon == 1 else "s")], "warnings": []}
        if kind == "classify":
            k, rows = read_labelled(text)
            counts = {}
            for _, lb, _ in rows:
                counts[lb] = counts.get(lb, 0) + 1
            warn = []
            if max(counts.values()) > 3 * min(counts.values()):
                warn.append("the labels are unbalanced: 'always the commonest label' is a strong baseline here")
            return {"ok": True, "facts": ["{} recordings ({}), {} labels: {}".format(len(rows), "sound clips" if k == "audio" else "number traces",
                                                                                   len(counts), ", ".join("{} {}".format(a, b) for a, b in counts.items()))], "warnings": warn}
        if kind == "group":
            P = read_group(text)
            return {"ok": True, "facts": ["{} bodies over {} dates ({} to {})".format(len(P["name"]), len(P["dates"]), P["dates"][0], P["dates"][-1]),
                                          "groups: {}".format(len(set(P["sector"])) if any(g != "-" for g in P["sector"]) else "none (each body is its own)")], "warnings": []}
    except ValueError as e:
        return {"ok": False, "error": str(e), "facts": [], "warnings": []}
    raise R.Refused("kind must be updown, classify or group")
