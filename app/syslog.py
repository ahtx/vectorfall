"""The kept Log: what ran on the card, the background jobs and the commands typed in the shell, saved beyond a restart.

The card's log in engine.worker.log is a short in-memory ring (300 lines; bursts of the same work are folded into one
line). A line is written here once it can no longer fold (6 s after its last run), as one JSON line in
/srv/data/run/log.jsonl. Commands and client messages from the browser come in by POST. The file is a ring too: when
it passes MAX_BYTES the older half is dropped. Jobs are not copied: the job database keeps them already, and
search() reads both.
"""
import json
import os
import threading
import time

PATH = os.path.join(os.environ.get("VF_DATA", "/srv/data"), "run", "log.jsonl")
MAX_BYTES = 2 * 1024 * 1024
_LOCK = threading.Lock()
_written = {}            # (at, label) -> end, for the lines of the in-memory window already written
_started = False


def _append(rows):
    if not rows:
        return
    try:
        os.makedirs(os.path.dirname(PATH), exist_ok=True)
        with _LOCK:
            with open(PATH, "a", encoding="utf-8") as f:
                for r in rows:
                    f.write(json.dumps(r, ensure_ascii=False) + "\n")
            if os.path.getsize(PATH) > MAX_BYTES:
                with open(PATH, encoding="utf-8") as f:
                    lines = f.readlines()
                keep = lines[len(lines) // 2:]
                with open(PATH + ".tmp", "w", encoding="utf-8") as f:
                    f.writelines(keep)
                os.replace(PATH + ".tmp", PATH)
    except OSError:
        pass


def flush(now=None):
    """Write the card's log lines that are final (no longer folding) and not written yet."""
    from . import engine
    now = now or time.time()
    out = []
    for e in list(engine.worker.log):
        key = (round(e["at"], 3), e["label"])
        if now - e["end"] < 6 or key in _written:
            continue
        _written[key] = e["end"]
        out.append({"t": round(e["at"], 3), "end": round(e["end"], 3), "kind": "err" if e.get("err") else "card", "text": e["label"] or "unnamed",
                    "n": e["n"], "ms": round(e["ms"], 1), "err": e.get("err") or None})
    if len(_written) > 2000:                                       # forget keys that left the in-memory window
        live = {(round(e["at"], 3), e["label"]) for e in list(engine.worker.log)}
        for k in list(_written):
            if k not in live:
                del _written[k]
    _append(out)
    return len(out)


def note(kind, text, app=None):
    """A line from the browser: a command typed in the shell, an error it showed, a layout change."""
    kind = kind if kind in ("cmd", "err", "client") else "client"
    _append([{"t": round(time.time(), 3), "kind": kind, "text": str(text)[:500], "app": app or None}])


def start():
    global _started
    if _started:
        return
    _started = True

    def loop():
        while True:
            time.sleep(10)
            try:
                flush()
            except Exception:  # noqa: BLE001
                pass
    threading.Thread(target=loop, name="vf-syslog", daemon=True).start()


def _read():
    try:
        with open(PATH, encoding="utf-8") as f:
            for ln in f:
                try:
                    yield json.loads(ln)
                except ValueError:
                    continue
    except OSError:
        return


def search(q="", kind="", app="", since=0.0, until=0.0, order="newest", limit=300):
    """The kept Log with the job database, filtered: q (words, all must match), kind (card, job, err, cmd, client),
    app (the app a job belongs to), a time window, newest or oldest first."""
    from . import jobs
    flush()
    rows = list(_read())
    for j in jobs.recent(500):
        rows.append({"t": round(j["started"], 3), "end": j.get("finished"), "kind": "err" if j["state"] == "error" else "job",
                     "text": j["label"] + (" — " + (j.get("error") or "failed") if j["state"] == "error" else ""),
                     "app": j["kind"], "ms": round(j["elapsed"] * 1000, 1), "state": j["state"]})
    words = [w for w in (q or "").lower().split() if w]
    out = []
    for r in rows:
        if since and r["t"] < since or until and r["t"] > until:
            continue
        if kind and r["kind"] != kind and not (kind == "err" and r.get("err")):
            continue
        if app and (r.get("app") or "") != app:
            continue
        if words:
            hay = (r.get("text", "") + " " + (r.get("err") or "") + " " + (r.get("app") or "") + " " + r["kind"]).lower()
            if not all(w in hay for w in words):
                continue
        out.append(r)
    out.sort(key=lambda r: r["t"], reverse=(order != "oldest"))
    size = os.path.getsize(PATH) if os.path.exists(PATH) else 0
    return {"rows": out[:max(1, min(int(limit or 300), 2000))], "matched": len(out), "kept_bytes": size, "max_bytes": MAX_BYTES,
            "oldest": min((r["t"] for r in rows), default=None)}
