"""Sample data, made on request, so every first step works without the user's own files.

  shop     a year of daily shop sales with a weekly pattern, a December bump, a promotion week and four marked
           incidents (till failure, double entry, holiday closure, burst pipe): for anomaly watch, Simulate, forecasts
  knocks   one minute of room tone with six knocks: for "find every time a sound happens"
  hiss     a short melody under steady hiss: for de-noise and the effects

Each sample is created once and found again by its name (asking twice returns the same table or clip)."""
import datetime
import io
import wave

import numpy as np

from . import media, sources

NAMES = {"shop": "Sample - shop daily sales.csv", "knocks": "Sample - six knocks.wav", "hiss": "Sample - melody with hiss.wav"}
INCIDENTS = {"2026-01-20": (0.40, "burst pipe: shop half closed"), "2026-03-14": (0.15, "till failure"),
             "2026-05-06": (2.00, "double entry"), "2026-07-04": (0.00, "holiday closure")}


def _shop_rows():
    rs = np.random.RandomState(7)
    week = [0.85, 0.90, 0.90, 1.00, 1.15, 1.45, 1.00]          # Monday .. Sunday
    d0, rows = datetime.date(2025, 10, 1), []
    for i in range(365):
        d = d0 + datetime.timedelta(days=i)
        v = 2000.0 * week[d.weekday()] * (1 + 0.06 * rs.randn())
        if d.month == 12:
            v *= 1.35
        if datetime.date(2026, 8, 10) <= d <= datetime.date(2026, 8, 16):
            v *= 1.40                                          # a planned promotion, not an incident
        note = ""
        k = d.isoformat()
        if k in INCIDENTS:
            v *= INCIDENTS[k][0]
            note = INCIDENTS[k][1]
        elif datetime.date(2026, 8, 10) <= d <= datetime.date(2026, 8, 16):
            note = "promotion week"
        cust = max(0, int(round(v / 25.0 * (1 + 0.05 * rs.randn()))))
        rows.append([k, round(v, 2), cust, note])
    return ["date", "sales", "customers", "note"], rows


def _wav(x, sr):
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())
    return b.getvalue()


def _knocks():
    sr, n = 44100, 44100 * 60
    rs = np.random.RandomState(3)
    room = np.cumsum(rs.randn(n)) * 0.0004
    room = (room - np.convolve(room, np.ones(4410) / 4410, "same")) + rs.randn(n) * 0.004   # a soft room hum and hiss
    x = room.astype(np.float64)
    t = np.arange(int(sr * 0.25)) / sr
    knock = (np.sin(2 * np.pi * 180 * t) * 0.6 + np.sin(2 * np.pi * 420 * t) * 0.3 + rs.randn(t.size) * 0.15) * np.exp(-t * 28)
    for s in (7.0, 15.5, 23.0, 31.2, 44.0, 52.7):                 # six knocks: two to mark, four to find
        a = int(s * sr)
        x[a:a + knock.size] += knock * (0.55 + 0.1 * rs.rand())
    return _wav(x, sr)


def _hiss():
    sr, secs = 44100, 20
    t = np.arange(sr * secs) / sr
    notes = [262, 294, 330, 349, 392, 349, 330, 294]
    x = np.zeros_like(t)
    for i, f in enumerate(notes * 3):
        a, b = int(i * 0.8 * sr), int((i * 0.8 + 0.75) * sr)
        if a >= t.size:
            break
        tt = t[a:min(b, t.size)] - t[a]
        x[a:a + tt.size] += 0.35 * np.sin(2 * np.pi * f * tt) * np.minimum(1, tt * 20) * np.exp(-tt * 2.5)
    x += np.random.RandomState(5).randn(t.size) * 0.05              # the steady hiss to remove
    return _wav(x, sr)


def ensure(kind):
    """The sample's table or clip, made once: {"kind": "table" | "sound", "id", "name", "new": bool}."""
    if kind not in NAMES:
        raise ValueError("samples: " + ", ".join(NAMES))
    name = NAMES[kind]
    if kind == "shop":
        for t in media.table_list():
            if t["name"] == name:
                return {"kind": "table", "id": t["id"], "name": name, "new": False}
        header, rows = _shop_rows()
        m = sources.table_from_rows(name, header, rows)
        return {"kind": "table", "id": m["id"], "name": name, "new": True}
    for c in media.sound_list():
        if c["name"] == name:
            return {"kind": "sound", "id": c["id"], "name": name, "new": False}
    m = media.sound_add(name, _knocks() if kind == "knocks" else _hiss())
    return {"kind": "sound", "id": m["id"], "name": name, "new": True}


# ---------------------------------------------------------------- the shipped demo set (seeded once, on first run)
# Assets live in app/sample_data/ (inside the image): two text corpora as folders of .txt files (one document each), demo
# photos and music, each folder with a credits.json (title, author, licence, source) that the Photo and Sound Labs
# show. Seeding is recorded in /srv/data/samples/seeded.json, one key per item, so it runs once: an item the user
# deletes is not put back, and nothing the user owns is changed. Photos and music are only added to a library that
# is empty when the seed runs (an existing install keeps its library as it is; data.samples.add adds them later).
import json as _json
import re as _re
import os as _os
import threading as _threading
import time as _time

ASSETS = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "sample_data")
STATE = _os.path.join(media.ROOT, "samples", "seeded.json")
CORPORA = [  # key, corpus name, folder of .txt files
    ("forbes", "Essays by Amir Husain (Forbes)", "forbes"),
    ("classics", "Twenty classic novels", "classics"),
]
_SEED_LOCK = _threading.Lock()


def _state():
    try:
        with open(STATE) as f:
            return _json.load(f)
    except (OSError, ValueError):
        return {}


def _save_state(st):
    _os.makedirs(_os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        _json.dump(st, f, indent=1)
    _os.replace(tmp, STATE)


def _credits(sub):
    try:
        with open(_os.path.join(ASSETS, sub, "credits.json"), encoding="utf-8") as f:
            return _json.load(f)
    except (OSError, ValueError):
        return []


def _dir_parts(path):
    """One document per .txt file, in file-name order; a leading "NN " (the order) is dropped from the name."""
    names = sorted(n for n in _os.listdir(path) if n.endswith(".txt"))
    return [(_re.sub(r"^[0-9]+ ", "", n[:-4]), (lambda n=n: open(_os.path.join(path, n), "rb"))) for n in names]


def _set_meta(path, extra):
    mp = _os.path.join(path, "meta.json")
    with open(mp) as f:
        m = _json.load(f)
    m.update(extra)
    with open(mp, "w") as f:
        _json.dump(m, f)
    return m


def seed_corpus(key, st, job=None):
    from . import textengine as te
    name, fn = next((n, f) for k, n, f in CORPORA if k == key)
    have = [c for c in te.list_corpora() if c.get("name") == name]
    if have:                                   # already there (seeded before, or the user made one with this name)
        st["corpus:" + key] = {"id": have[0]["id"], "at": _time.time(), "found": True}
        return have[0]["id"]
    path = _os.path.join(ASSETS, "third_party", fn)
    if not _os.path.isdir(path):
        return None
    cid = te.create(name, _dir_parts(path), job)
    _set_meta(_os.path.join(te.ROOT, cid), {"sample": key})
    st["corpus:" + key] = {"id": cid, "at": _time.time()}
    return cid


def seed_photos(st, force=False):
    have = {p["name"] for p in media.photo_list()}
    if have and not force:
        return 0
    n = 0
    for c in _credits("photos"):
        k = "photo:" + c["file"]
        nm = c.get("name") or c["title"]
        if (k in st and not force) or nm in have:
            continue
        with open(_os.path.join(ASSETS, "photos", c["file"]), "rb") as f:
            m = media.photo_add(nm, f.read())
        _set_meta(_os.path.join(media.ROOT, "photos", m["id"]), {"credit": _credit(c), "sample": True})
        st[k] = {"id": m["id"], "at": _time.time()}
        n += 1
    return n


def seed_sounds(st, force=False):
    have = {s["name"] for s in media.sound_list()}
    if have - set(NAMES.values()) and not force:          # the user has clips of their own: leave the library alone
        return 0
    n = 0
    for c in _credits("sounds"):
        k = "sound:" + c["file"]
        nm = c.get("name") or c["title"]
        if (k in st and not force) or nm in have:
            continue
        with open(_os.path.join(ASSETS, "sounds", c["file"]), "rb") as f:
            m = media.sound_add(nm, f.read())
        _set_meta(_os.path.join(media.ROOT, "sounds", m["id"]), {"credit": _credit(c), "sample": True})
        st[k] = {"id": m["id"], "at": _time.time()}
        n += 1
    return n


def _credit(c):
    return {k: c.get(k, "") for k in ("title", "author", "licence", "licence_url", "source", "category", "file", "attribution", "changes")}


def seed(job=None, force=False):
    """First-run seeding: the two corpora, the demo photos and the demo music. Returns what it added."""
    with _SEED_LOCK:
        st = _state()
        first = not st
        out = {"corpora": [], "photos": 0, "sounds": 0, "first_run": first}
        for i, (key, _n, _f) in enumerate(CORPORA):
            if force or "corpus:" + key not in st:
                if job:
                    job.step(0.05 + 0.3 * i / len(CORPORA), "sample text: " + _n)
                cid = seed_corpus(key, st, None)
                if cid:
                    out["corpora"].append(cid)
                _save_state(st)
        if force or not any(k.startswith("photo:") for k in st) and "photos" not in st:
            if job:
                job.step(0.4, "sample photos")
            out["photos"] = seed_photos(st, force)
            st["photos"] = {"at": _time.time(), "added": out["photos"]}
            _save_state(st)
        if force or not any(k.startswith("sound:") for k in st) and "sounds" not in st:
            if job:
                job.step(0.7, "sample music")
            out["sounds"] = seed_sounds(st, force)
            st["sounds"] = {"at": _time.time(), "added": out["sounds"]}
            _save_state(st)
        return out


def add_demo():
    """On request: add the demo photos and music that are not in the library now (matched by name), even if the
    library has items of its own or the user deleted the samples before."""
    with _SEED_LOCK:
        st = _state()
        out = {"photos": seed_photos(st, force=True), "sounds": seed_sounds(st, force=True)}
        _save_state(st)
        return out


def first_run_corpus():
    """The corpus to put on the card when nothing is indexed yet: the essays (small, quick to index)."""
    st = _state()
    return (st.get("corpus:forbes") or {}).get("id")
