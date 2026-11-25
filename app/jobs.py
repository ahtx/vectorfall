"""Durable background jobs with progress; completed work survives a VectorFall restart."""
import json
import os
import sqlite3
import threading
import time
import traceback
import uuid

JOBS = {}


class Cancelled(Exception):
    """Raised inside a job (at its next step) after someone pressed Cancel."""


LOCK = threading.RLock()
DATA = os.path.expanduser(os.environ.get("VF_DATA", "/srv/data"))
os.makedirs(DATA, exist_ok=True)
DB = sqlite3.connect(os.environ.get("VF_JOBS_DB", os.path.join(DATA, "jobs.db")), check_same_thread=False)
DB.execute("""CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, kind TEXT, label TEXT, state TEXT,
progress REAL, message TEXT, result TEXT, error TEXT, started REAL, finished REAL, events TEXT, events_dropped INTEGER)""")
DB.commit()


def _dump(value):
    return json.dumps(value, ensure_ascii=False, default=str)


def _save(j):
    with LOCK:
        DB.execute("INSERT OR REPLACE INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                   (j.id, j.kind, j.label, j.state, j.progress, j.message, _dump(j.result), j.error,
                    j.started, j.finished, _dump(j.events), getattr(j, "events_dropped", 0)))
        DB.commit()


class Job:
    def __init__(self, kind, label):
        self.id = uuid.uuid4().hex[:10]
        self.kind, self.label = kind, label
        self.state, self.progress, self.message = "running", 0.0, "starting"
        self.result, self.error = None, None
        self.started, self.finished = time.time(), None
        self.events = []
        self.events_dropped = 0
        self.saved = 0.0
        self.cancel_requested = False

    def check(self):
        """Stop here if the job was cancelled (long loops call this, or step(), between pieces of work)."""
        if self.cancel_requested:
            raise Cancelled("cancelled")

    def step(self, progress, message=None):
        self.check()
        self.progress = max(0.0, min(1.0, progress))
        if message:
            self.message = message
            if "\x1f" in message[:8]:
                self.events.append(message)
                if len(self.events) > 400:
                    del self.events[:100]
                    self.events_dropped += 100
        now = time.time()
        if now - self.saved >= .25:
            self.saved = now
            _save(self)

    def info(self):
        return {"id": self.id, "kind": self.kind, "label": self.label, "state": self.state,
                "progress": round(self.progress, 4), "message": self.message, "error": self.error,
                "result": self.result, "elapsed": round((self.finished or time.time()) - self.started, 2),
                "started": self.started, "finished": self.finished,
                "events": self.events[-60:], "nevents": len(self.events) + self.events_dropped,
                "cancelling": self.cancel_requested and self.state == "running"}


def _restore(row):
    j = Job(row[1], row[2])
    (j.id, _kind, _label, j.state, j.progress, j.message, result, j.error,
     j.started, j.finished, events, j.events_dropped) = row
    j.result = json.loads(result) if result else None
    j.events = json.loads(events or "[]")
    if j.state == "running":
        j.state = "interrupted"
        j.message = "interrupted by a VectorFall restart; retry is required"
        j.error = j.message
        j.finished = time.time()
    return j


def _load():
    with LOCK:
        rows = DB.execute("SELECT * FROM jobs ORDER BY started DESC LIMIT 2000").fetchall()
        for row in rows:
            j = _restore(row)
            JOBS[j.id] = j
            if row[3] == "running":
                _save(j)


def start(kind, label, fn):
    """fn(job) runs in its own thread and may call job.step(); its return value becomes job.result."""
    j = Job(kind, label)
    with LOCK:
        JOBS[j.id] = j
        _save(j)

    def run():
        try:
            j.result = fn(j)
            j.state, j.progress, j.message = "done", 1.0, "done"
        except Cancelled:
            j.state, j.error, j.message = "cancelled", "cancelled", "cancelled"
        except Exception as e:  # noqa: BLE001
            j.state, j.error = "error", "{}: {}".format(type(e).__name__, e)[:500]
            traceback.print_exc()
        finally:
            j.finished = time.time()
            _save(j)
    threading.Thread(target=run, daemon=True).start()
    return j


def cancel(jid):
    """Ask a running job to stop at its next step. Returns its info, or None when there is no such job."""
    with LOCK:
        j = JOBS.get(jid)
        if not j:
            return None
        if j.state == "running":
            j.cancel_requested = True
            j.message = "cancelling"
        return j.info()


def get(jid):
    with LOCK:
        j = JOBS.get(jid)
        if not j:
            row = DB.execute("SELECT * FROM jobs WHERE id=?", (jid,)).fetchone()
            j = _restore(row) if row else None
            if j:
                JOBS[jid] = j
        return j.info() if j else None


def recent(n=60):
    with LOCK:
        rows = DB.execute("SELECT * FROM jobs ORDER BY started DESC LIMIT ?", (min(500, n),)).fetchall()
        out = []
        for row in rows:
            j = _restore(row)
            d = j.info()
            d.pop("result", None)
            out.append(d)
        return out


def active():
    return [j.info() for j in list(JOBS.values()) if j.state == "running"]


_load()
