"""The Console harness: runs one snippet of your Python in its own process with the card ready to use.

Your code starts in ~/scripts (/srv/data/scripts) with these already defined -- nothing else is added:
  np (NumPy, CPU), cp (CuPy = NumPy on the GPU), vf (the helpers below; `import vf` works too), math, time.
Python itself runs on the CPU; only operations on cp arrays (and your own CUDA kernels) run on the card.
  vf.show(x, "title")        image: a PIL image or a 2-D / 3-D array (NumPy or CuPy)
  vf.plot(y) / vf.plot(x, y, kind="line"|"bar"|"scatter", title=...)
  vf.table(rows, columns=None)
  vf.race(fn, *args)         run fn(np, *args) on the CPU and fn(cp, *args) on the GPU; shows the speed-up
  vf.timeit(fn, n=5)         average milliseconds on the GPU (synchronised)
  vf.text.search / near / generate / stats / retrieve    the corpus loaded in the Text Engine
  vf.text.tokens / predict / pipeline / score / compare / pipelines / model    the Text Lab (how generation works)
  vf.data.list() / vf.data.load("name") / vf.data.save("name", {"col": values})   Data Desk tables, both ways
  vf.machine()               live telemetry of the card
  vf.solve.roster / route / teams / budget / project / queue / history / check / template   one-line solvers that take
                             the UI's text formats (or a Data Desk table name); they return a Result (print it)
  vf.run("model.name", **params)   any registered model; vf.models("search"), vf.describe(name), vf.templates()
"""
import base64
import io
import json
import math
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request

import numpy as np

import cupy as cp
from cupy_backends.cuda.api import driver

OUT = open(sys.argv[2], "w")
API = "http://127.0.0.1:8092/api"


def emit(o):
    OUT.write(json.dumps(o, default=lambda x: x.tolist() if hasattr(x, "tolist") else str(x)) + "\n")
    OUT.flush()


class _Out:
    def __init__(self, kind):
        self.kind = kind

    def write(self, s):
        if s:
            emit({"type": self.kind, "text": s})

    def flush(self):
        pass


def _host(a):
    if isinstance(a, cp.ndarray):
        cp.cuda.Stream.null.synchronize()
        return cp.asnumpy(a)
    return np.asarray(a)


def _get(path, **q):
    url = API + path + ("?" + urllib.parse.urlencode(q) if q else "")
    with urllib.request.urlopen(url, timeout=120) as r:
        return json.loads(r.read().decode())


class _Text:
    def search(self, q, case=False, limit=20):
        """Concordance search in the corpus loaded in the Text Engine: every place q occurs, with context."""
        return _get("/text/search", q=q, case=int(case), limit=limit)

    def near(self, q, side="next"):
        """The words that most often come next to q (side='next' or 'prev'), with counts."""
        return _get("/text/near", q=q, side=side)

    def generate(self, seed="", order=2, n=60, temp=1.0):
        """Markov text from the corpus, starting at seed: n words, an order-word context, temperature temp."""
        return _get("/text/generate", seed=seed, order=order, n=n, temp=temp)

    def retrieve(self, q):
        """The corpus passages that best match q (BM25)."""
        return _get("/text/retrieve", q=q)

    def stats(self):
        """Counts for the loaded corpus: documents, words, vocabulary, bytes on the card."""
        return _get("/text/stats")


    # the Text Lab: tokenizers, next-word prediction, and generation pipelines (models text.tokens / predict / pipeline.*)
    def model(self, name, timeout=1800, **params):
        """Run any text model by name and return its result, e.g. vf.text.model("text.embed.explain", word="sea")."""
        req = urllib.request.Request(API[:-4] + "/v1/models/" + name, json.dumps(params).encode(),
                                     {"Content-Type": "application/json", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode())["result"]
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read().decode()).get("error", {}).get("message")
            except Exception:  # noqa: BLE001
                msg = None
            raise RuntimeError(msg or str(e)) from None

    def tokens(self, text, merges=1000):
        return self.model("text.tokens", text=text, merges=merges)

    def predict(self, context, top=10):
        return self.model("text.predict", context=context, top=top)

    def pipelines(self):
        return self.model("text.pipeline.list")

    def pipeline(self, name="", seed="", rs=-1, spec=None, **changes):
        """Generate with a saved or built-in pipeline. Keyword changes go on top of it, for example
        vf.text.pipeline("Kneser-Ney 5-gram", seed="The sea", sampling={"temperature": 1.2})."""
        return self.model("text.pipeline.run", pipeline=name, spec=dict(spec or {}, **changes) or None, seed=seed, rs=rs)

    def score(self, name="", spec=None, samples=4, eval_tokens=1500, **changes):
        return self.model("text.pipeline.score", pipeline=name, spec=dict(spec or {}, **changes) or None,
                          samples=samples, eval_tokens=eval_tokens)

    def compare(self, *names, specs=None, samples=4, eval_tokens=1000):
        return self.model("text.pipeline.compare", pipelines=list(names), specs=specs, samples=samples, eval_tokens=eval_tokens)

    def save_pipeline(self, name, spec):
        return self.model("text.pipeline.save", name=name, spec=spec)


class _Data:
    """Data Desk tables from your code: read any table (a file, a ticker, a tool's result) and save results back,
    where every other tool can pick them up."""

    def list(self):
        """The Data Desk tables: [{id, name, rows, columns}]."""
        return [{"id": t["id"], "name": t["name"], "rows": t["rows"], "columns": t["columns"]} for t in _get("/tables")]

    def _find(self, name):
        ts = _get("/tables")
        for t in ts:
            if t["id"] == name or t["name"] == name:
                return t
        hit = [t for t in ts if str(name).lower() in t["name"].lower()]
        if not hit:
            raise KeyError("no Data Desk table called {!r} (vf.data.list() shows them)".format(name))
        return hit[0]

    def load(self, name):
        """-> {column: values}; numeric columns come back as NumPy float arrays (blank = nan), text as lists."""
        import csv
        t = self._find(name)
        with urllib.request.urlopen(API + "/tables/{}/csv".format(t["id"]), timeout=120) as r:
            rows = list(csv.reader(io.StringIO(r.read().decode("utf-8"))))
        head, body = rows[0], rows[1:]
        out = {}
        for j, h in enumerate(head):
            col = [r_[j] if j < len(r_) else "" for r_ in body]
            if h in t.get("numeric", []):
                out[h] = np.array([float(v) if v not in ("", None) else np.nan for v in col])
            else:
                out[h] = col
        return out

    def save(self, name, columns):
        """{column: values} (equal lengths) -> a new Data Desk table; returns its id."""
        import csv
        import uuid
        cols = {k: (_host(v).tolist() if hasattr(v, "shape") else list(v)) for k, v in columns.items()}
        n = max(len(v) for v in cols.values())
        b = io.StringIO()
        w = csv.writer(b)
        w.writerow(list(cols))
        for i in range(n):
            w.writerow([v[i] if i < len(v) else "" for v in cols.values()])
        bd = uuid.uuid4().hex
        crlf = "\r\n"
        head = ("--" + bd + crlf + 'Content-Disposition: form-data; name="file"; filename="' + str(name) + '.csv"' + crlf
                + "Content-Type: text/csv" + crlf + crlf)
        body = head.encode() + b.getvalue().encode("utf-8") + (crlf + "--" + bd + "--" + crlf).encode()
        req = urllib.request.Request(API + "/tables", body, {"Content-Type": "multipart/form-data; boundary=" + bd})
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode())["id"]


V1 = "http://127.0.0.1:8092/v1"


def _post(url, body, timeout=600):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read().decode())["error"]["message"]
        except Exception:  # noqa: BLE001
            msg = str(e)
        raise RuntimeError(msg) from None


class Result(dict):
    """A model's answer: a dict, printed as its headline, sentence, baseline and explanation."""

    def __repr__(self):
        lines = []
        if self.get("headline") is not None:
            lines.append("{}  {}".format(self.get("headline"), self.get("sentence", "")))
        if self.get("compare_text"):
            lines.append("baseline: " + self["compare_text"])
        lines += ["  - " + x for x in self.get("explain") or []]
        if not lines:
            return dict.__repr__(self)
        return "\n".join(lines)

    __str__ = __repr__

    def show(self):
        """Print the answer and, when there is one, show its table."""
        print(repr(self))
        t = self.get("table")
        if isinstance(t, dict) and t.get("rows"):
            vf_table(t["rows"], t.get("header"))
        return self


def vf_table(rows, columns=None):
    rows = list(rows)[:500]
    if rows and isinstance(rows[0], dict):
        columns = columns or list(rows[0].keys())
        rows = [[r.get(c) for c in columns] for r in rows]
    emit({"type": "table", "columns": columns, "rows": rows})


def run_model(model, params, quiet=False):
    """Run a registered model on the server, as a job (the top bar shows its progress, and it can be cancelled there)."""
    params = {k: v for k, v in params.items() if v is not None}
    j = _post(V1 + "/models/" + model + "?async=1", params)["job"]
    last = None
    while True:
        with urllib.request.urlopen(V1 + "/jobs/" + j["id"], timeout=60) as r:
            j = json.loads(r.read().decode())
        if j["state"] != "running":
            break
        if not quiet:                                    # the Console shows this line live while the job runs
            msg = "{}: {:.0f}% {}".format(model, 100 * (j.get("progress") or 0), j.get("message") or "")
            if msg != last:
                emit({"type": "progress", "text": msg, "progress": j.get("progress") or 0})
                last = msg
        time.sleep(0.3)
    if not quiet and last is not None:
        emit({"type": "progress", "text": "", "progress": 1})
    if j["state"] != "done":
        raise RuntimeError("{}: {}".format(model, j.get("error") or j["state"]))
    out = (j.get("result") or {}).get("result")
    return Result(out) if isinstance(out, dict) else out


def _text_or_table(v, key, p):
    """A string with a line break (or a comma) is the text itself; a short string without one names a Data Desk table."""
    if v is None:
        return
    if isinstance(v, (list, tuple)):
        v = "\n".join(",".join(str(c) for c in row) if isinstance(row, (list, tuple)) else str(row) for row in v)
    if isinstance(v, str) and "\n" not in v and "," not in v and key != "pairs":
        p[key + "_table"] = v
    else:
        p[key] = v


class _Solve:
    """One-line solvers that take the same text formats as the UI. Each text argument can also be a Data Desk table name.
    Every call returns a Result: print it for the answer, the baseline and the explanation; .show() adds the table."""

    def roster(self, people, shifts, rest=10, one_a_day=True, fair=1.0, prefer=1.0, effort="normal"):
        """Who works which shift. people: CSV name,max_shifts,skills,unavailable,prefers. shifts: CSV shift,day,start,end,needed,skill."""
        p = {"rest": rest, "one_a_day": one_a_day, "fair": fair, "prefer": prefer, "effort": effort}
        _text_or_table(people, "people", p)
        _text_or_table(shifts, "shifts", p)
        return run_model("plan.roster", p)

    def route(self, stops=None, costs=None, unit="", round_trip=True, effort="normal"):
        """The cheapest visit order. stops: CSV name,lat,lon (or x,y or address). costs: a matrix or from,to,cost lines, any unit."""
        p = {"unit": unit, "round_trip": round_trip, "effort": effort}
        _text_or_table(stops, "stops", p)
        _text_or_table(costs, "costs", p)
        return run_model("plan.route", p)

    def teams(self, people, k=4, pairs="", balance=1.0, mix=1.0, effort="normal"):
        """Fair teams. people: CSV name, a score column, a category column. pairs: 'A + B' together, 'A - B' apart, one per line."""
        p = {"k": k, "pairs": pairs, "balance": balance, "mix": mix, "effort": effort}
        _text_or_table(people, "people", p)
        return run_model("plan.teams", p)

    def budget(self, items, budget, sims=1000000, correlation=0.3, seed=0):
        """Budget risk. items: one per line 'name, low, likely, high[, chance]'."""
        p = {"budget": budget, "sims": sims, "correlation": correlation, "seed": seed}
        _text_or_table(items, "items", p)
        return run_model("sim.budget", p)

    def project(self, tasks, deadline):
        """Deadline risk. tasks: one per line 'name, best, likely, worst' (days), done one after another."""
        return run_model("forecast.project", {"tasks": tasks, "deadline": deadline})

    def queue(self, arrivals, service, servers, hours=8):
        """A queue: arrivals per hour, minutes per service, the number of servers, the hours open."""
        return run_model("forecast.queue", {"arrivals": arrivals, "service": service, "servers": servers, "hours": hours})

    def history(self, series, horizon=6, threshold=None, col=None):
        """The odds from your history. series: one number per line (or a list), or a Data Desk table name (and col)."""
        p = {"horizon": horizon, "threshold": threshold}
        if isinstance(series, (list, tuple)) or hasattr(series, "tolist"):
            series = "\n".join(str(float(x)) for x in (series.tolist() if hasattr(series, "tolist") else series))
        _text_or_table(series, "series", p)
        if col:
            p["series_col"] = col
        return run_model("sim.history", p)

    def check(self, kind, **inputs):
        """Read roster / route / teams inputs as the solver will, without solving: facts, warnings, the first error."""
        p = {"kind": kind}
        for k, v in inputs.items():
            if k in ("people", "shifts", "stops", "costs"):
                _text_or_table(v, k, p)
            else:
                p[k] = v
        return run_model("plan.check", p, quiet=True)

    def template(self, id, **changes):
        """Solve a problem template with your changes, e.g. vf.solve.template("visit-time", round_trip=False)."""
        return run_model("problem.solve", {"id": id, "changes": changes})


class VF:
    text = _Text()
    data = _Data()
    solve = _Solve()

    def run(self, model, **params):
        """Run any model (vf.models() lists them): vf.run("sim.budget", budget=200000). Returns a Result."""
        return run_model(model, params)

    def models(self, search=""):
        """The models whose name or title contains search: [(name, title)]."""
        with urllib.request.urlopen(V1 + "/models", timeout=60) as r:
            ms = json.loads(r.read().decode())
        ms = ms.get("models", ms) if isinstance(ms, dict) else ms
        s_ = search.lower()
        return [(m["name"], m["title"]) for m in ms if s_ in (m["name"] + " " + m["title"]).lower()]

    def describe(self, model):
        """A model's parameters: {name: (type, default, label)}."""
        with urllib.request.urlopen(V1 + "/models/" + model, timeout=60) as r:
            d = json.loads(r.read().decode())
        return {f["k"]: (f.get("type"), f.get("default"), f.get("label")) for f in d["fields"]}

    def templates(self):
        """The problem templates: [(id, title)]. vf.template(id) reads one; vf.solve.template(id, ...) solves it."""
        return [(t["id"], t["title"]) for t in run_model("problem.templates", {}, quiet=True)["templates"]]

    def template(self, id):
        """One template: problem, maps (how your problem fits the format), params (the filled-in inputs), calls."""
        return dict(run_model("problem.template", {"id": id}, quiet=True))

    def show(self, x, title=None):
        """Show an image here: a PIL image or a 2-D / 3-D array (NumPy or CuPy), scaled to 0..255."""
        from PIL import Image
        if not isinstance(x, Image.Image):
            a = _host(x).astype(np.float64)
            if a.ndim == 3 and a.shape[2] in (3, 4) and a.max() > 1.0:
                a = np.clip(a, 0, 255).astype(np.uint8)
            else:
                lo, hi = float(np.nanmin(a)), float(np.nanmax(a))
                a = ((a - lo) / (hi - lo + 1e-12) * 255).astype(np.uint8)
            x = Image.fromarray(a[..., :3] if a.ndim == 3 else a)
        if max(x.size) > 1600:
            x.thumbnail((1600, 1600))
        b = io.BytesIO()
        x.save(b, "PNG")
        emit({"type": "image", "title": title, "png": "data:image/png;base64," + base64.b64encode(b.getvalue()).decode()})

    def plot(self, *args, kind="line", title=None, labels=None):
        """A chart here: vf.plot(y) or vf.plot(x, y, kind='line' | 'bar' | 'scatter', title=...)."""
        if len(args) == 1:
            y = _host(args[0]).astype(np.float64).ravel()
            x = np.arange(y.size)
        else:
            x, y = _host(args[0]).astype(np.float64).ravel(), _host(args[1]).astype(np.float64).ravel()
        if y.size > 4000:
            step = y.size // 4000
            x, y = x[::step], y[::step]
        emit({"type": "plot", "kind": kind, "title": title, "x": x.tolist(), "y": y.tolist(), "labels": labels})

    def table(self, rows, columns=None):
        """A table here: a list of rows (lists or dicts), with optional column names. At most 500 rows."""
        rows = list(rows)[:500]
        if rows and isinstance(rows[0], dict):
            columns = columns or list(rows[0].keys())
            rows = [[r.get(c) for c in columns] for r in rows]
        emit({"type": "table", "columns": columns, "rows": rows})

    def timeit(self, fn, n=5):
        """The average milliseconds of fn() on the GPU over n runs (synchronised, after one warm-up run)."""
        fn()
        cp.cuda.Stream.null.synchronize()
        t = time.time()
        for _ in range(n):
            fn()
        cp.cuda.Stream.null.synchronize()
        return (time.time() - t) / n * 1000

    def race(self, fn, *args, n=3):
        """Run fn(np, *args) on the CPU and fn(cp, *args) on the GPU; shows both times and the speed-up. Returns the GPU result."""
        def clock(xp):
            fn(xp, *args)
            if xp is cp:
                cp.cuda.Stream.null.synchronize()
            t = time.time()
            for _ in range(n):
                r = fn(xp, *args)
                if xp is cp:
                    cp.cuda.Stream.null.synchronize()
            return (time.time() - t) / n * 1000, r
        cpu, _ = clock(np)
        gpu, r = clock(cp)
        emit({"type": "race", "cpu_ms": round(cpu, 2), "gpu_ms": round(gpu, 2), "speedup": round(cpu / max(gpu, 1e-6), 1),
              "name": getattr(fn, "__name__", "your function")})
        return r

    def machine(self):
        """Live telemetry of the card: memory, temperature, clocks, activity."""
        return _get("/machine")


def main():
    code = open(sys.argv[1], encoding="utf-8").read()
    vf = VF()
    sys.modules["vf"] = vf                      # so `import vf` works in your code, like any module
    ns = {"np": np, "cp": cp, "vf": vf, "math": math, "time": time, "__name__": "__console__"}
    sys.stdout, sys.stderr = _Out("stdout"), _Out("stderr")
    t = time.time()
    try:
        exec(compile(code, "your code", "exec"), ns)
        try:
            driver.ctxGetCurrent()
        except driver.CUDADriverError as e:
            # CUDA_ERROR_NOT_INITIALIZED means this process did not use the card.
            # Synchronizing here would create a CUDA context for a CPU-only script.
            if e.status != 3:
                raise
        else:
            cp.cuda.Stream.null.synchronize()
        emit({"type": "done", "secs": round(time.time() - t, 3)})
    except Exception:  # noqa: BLE001
        tb = traceback.format_exc()
        lines = [ln for ln in tb.splitlines() if 'File "/srv/app/vfh.py"' not in ln]
        emit({"type": "error", "text": "\n".join(lines[-14:])})
        emit({"type": "done", "secs": round(time.time() - t, 3), "failed": True})


if __name__ == "__main__":
    main()
