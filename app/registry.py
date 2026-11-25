"""The model registry: every VectorFall operation, declared once, callable four ways.

A model is a function plus a declaration of its parameters in the house field format the UI already renders
(`{"k", "type", "label", "default", "min", "max", "choices", ...}`). From that one declaration come:
  * the JSON Schema for its input (OpenAPI 3.1 and JSON-RPC/OpenRPC and MCP all speak JSON Schema),
  * the command-line flags of `vf run <model> --<k> <value>`,
  * the form in the UI's Models app,
  * validation and coercion — the same for every caller.
Every ingress (the UI's own routes, /v1 REST, JSON-RPC, MCP, the CLI) ends in `call()`, so there is one body of code.

Field types:  int float money str text bool choice list(of numbers) strs(list of strings) json(structured)  ·  references to things the server holds:
table photo sound corpus project (an id; part of a name also resolves)  ·  file (the CLI uploads @path first).
"""
import base64
import json
import threading
import time

from . import engine, jobs

REGISTRY = {}
GROUPS = {}          # group -> {"title", "app"} (the UI app that owns it)


class Blob:
    """A binary result (an image, an audio file). REST sends the bytes; JSON callers get base64; the CLI writes a file."""
    def __init__(self, data, media_type, filename=None, meta=None):
        self.data, self.media_type, self.filename, self.meta = data, media_type, filename, meta or {}

    def as_json(self):
        return {"media_type": self.media_type, "filename": self.filename, "bytes": len(self.data),
                "base64": base64.b64encode(self.data).decode("ascii"), "meta": self.meta}


class UnknownModel(KeyError):
    pass


class Refused(ValueError):
    """A model declining for a reason the caller can fix (no corpus loaded, no such project): carries an HTTP status."""
    def __init__(self, msg, status=400):
        ValueError.__init__(self, msg)
        self.status = status


class Model:
    def __init__(self, name, fn, title, group, summary, fields, device, mutating, long, timeout, output, example, app, kind,
                 local_only=False):
        self.local_only = local_only
        self.name, self.fn, self.title, self.group, self.summary = name, fn, title, group, summary
        self.fields, self.device, self.mutating, self.long = fields, device, mutating, long
        self.timeout, self.output, self.example, self.app, self.kind = timeout, output, example or {}, app, kind

    def describe(self, full=True):
        d = {"name": self.name, "title": self.title, "group": self.group, "summary": self.summary,
             "device": self.device, "mutating": self.mutating, "long": self.long, "output": self.output,
             "app": self.app or GROUPS.get(self.group, {}).get("app"), "local_only": self.local_only,
             "gpu_timed": getattr(self, "timed", True)}
        if full:
            d.update(fields=self.fields, input_schema=input_schema(self), example=self.example, timeout=self.timeout,
                     cli="vf run {}{}".format(self.name, "".join(" --{} {}".format(k, _shell(v)) for k, v in self.example.items())))
        return d


def model(name, title, group, summary="", fields=(), device="gpu", mutating=False, long=False, timeout=120,
          output="json", example=None, app=None, kind=None, local_only=False, timed=True):
    """Register fn as a model. fn(**params) -> dict | Blob. With long=True fn(job, **params) runs as a background job.
    device: what does the work — "gpu", "mixed" (GPU plus real CPU work), or "cpu" (said honestly, e.g. a download)."""
    def deco(fn):
        REGISTRY[name] = Model(name, fn, title, group, summary, [dict(f) for f in fields], device, mutating, long,
                               timeout, output, example, app, kind or (GROUPS.get(group, {}).get("kind") or group), local_only)
        REGISTRY[name].timed = timed           # False: the GPU work happens outside the server's queue (the Console's own process)
        return fn
    return deco


def group(name, title, app, kind=None):
    GROUPS[name] = {"title": title, "app": app, "kind": kind or app}


# ---------------------------------------------------------------- schema
_REF = {"table": "a Data Desk table", "photo": "a Photo Lab photo", "sound": "a Sound Lab clip",
        "corpus": "a Text Engine corpus", "project": "a Reservoir Lab project"}


def field_schema(f):
    t = f.get("type", "str")
    s = {"title": f.get("label") or f["k"]}
    if f.get("help"):
        s["description"] = f["help"]
    if t in ("int",):
        s["type"] = "integer"
    elif t in ("float", "money"):
        s["type"] = "number"
    elif t == "bool":
        s["type"] = "boolean"
    elif t == "choice":
        s["type"] = "string"
        s["enum"] = list(f["choices"])
    elif t == "list":
        s["type"] = "array"
        s["items"] = {"type": "number"}
    elif t == "strs":
        s["type"] = "array"
        s["items"] = {"type": "string"}
    elif t == "json":
        s["type"] = ["object", "array"]
    elif t in _REF:
        s["type"] = "string"
        s["x-vf-ref"] = t
        s["description"] = (s.get("description", "") + " Id or part of the name of " + _REF[t] + ".").strip()
    elif t == "file":
        s["type"] = "string"
        s["contentEncoding"] = "base64"
        s["x-vf-file"] = f.get("accept", "*/*")
    else:
        s["type"] = "string"
    if t == "text":
        s["x-vf-widget"] = "textarea"
    if f.get("soft"):                    # a suggested range (the UI's slider), not a limit the server enforces
        if "min" in f or "max" in f:
            s["x-vf-range"] = [f.get("min"), f.get("max")]
    else:
        if "min" in f and s["type"] in ("integer", "number"):
            s["minimum"] = f["min"]
        if "max" in f and s["type"] in ("integer", "number"):
            s["maximum"] = f["max"]
    if f.get("default") is not None:
        s["default"] = f["default"]
    return s


def input_schema(m):
    props = {f["k"]: field_schema(f) for f in m.fields}
    req = [f["k"] for f in m.fields if f.get("required")]
    s = {"type": "object", "properties": props, "additionalProperties": False}
    if req:
        s["required"] = req
    return s


# ---------------------------------------------------------------- validation (one place, every caller)
class ParamError(ValueError):
    pass


def _resolve(kind, v):
    """References accept an id, an exact name or part of a name."""
    from . import media, reservoir, textengine as te
    v = str(v).strip()
    if not v:
        raise ParamError("give {} (an id or part of its name)".format(_REF[kind]))
    if kind == "table":
        items = [(t["id"], t["name"]) for t in media.table_list()]
    elif kind == "photo":
        items = [(p["id"], p.get("name", "")) for p in media.photo_list()]
    elif kind == "sound":
        items = [(s["id"], s.get("name", "")) for s in media.sound_list()]
    elif kind == "corpus":
        items = [(c["id"], c.get("name", "")) for c in te.list_corpora()]
    elif kind == "project":
        items = [(p["id"], p.get("name", "")) for p in reservoir.list_projects()]
    else:
        return v
    lo = v.lower()
    for test in (lambda i, n: i == v, lambda i, n: n.lower() == lo, lambda i, n: lo in n.lower()):
        hit = [i for i, n in items if test(i, n)]
        if hit:
            return hit[0]
    raise ParamError("no {} matches “{}” (there are {}: {})".format(_REF[kind].split(" ", 1)[1], v, len(items),
                                                                     ", ".join(n for _, n in items[:6]) or "none"))


def coerce(m, params):
    params = dict(params or {})
    known = {f["k"] for f in m.fields}
    extra = [k for k in params if k not in known]
    if extra:
        raise ParamError("{} has no parameter {} (it takes: {})".format(m.name, ", ".join(extra), ", ".join(sorted(known)) or "nothing"))
    out = {}
    for f in m.fields:
        k, t = f["k"], f.get("type", "str")
        v = params.get(k, f.get("default"))
        if v is None:
            if f.get("required"):
                raise ParamError("{}: --{} is necessary ({})".format(m.name, k, f.get("label", k)))
            out[k] = None
            continue
        try:
            if t == "int":
                v = int(float(v))
            elif t in ("float", "money"):
                v = float(v)
            elif t == "bool":
                v = v if isinstance(v, bool) else str(v).strip().lower() in ("1", "true", "yes", "on", "y")
            elif t == "list":
                v = [float(x) for x in (v if isinstance(v, (list, tuple)) else str(v).replace(";", ",").split(",")) if str(x).strip()]
            elif t == "strs":
                v = [str(x).strip() for x in (v if isinstance(v, (list, tuple)) else str(v).split(",")) if str(x).strip()]
            elif t == "json":
                v = json.loads(v) if isinstance(v, str) else v
            elif t == "file":
                v = v if isinstance(v, (bytes, bytearray)) else base64.b64decode(v)
            elif t in _REF:
                v = _resolve(t, v)
            else:
                v = str(v)
        except ParamError:
            raise
        except Exception:  # noqa: BLE001
            raise ParamError("{}: --{} must be {} (got {!r})".format(m.name, k, t, str(v)[:40]))
        if t == "choice" and v not in f["choices"]:
            raise ParamError("{}: --{} must be one of {} (got {!r})".format(m.name, k, ", ".join(map(str, f["choices"])), v))
        if t in ("int", "float", "money") and not f.get("soft"):
            if "min" in f and v < f["min"] or "max" in f and v > f["max"]:
                raise ParamError("{}: --{} must be between {} and {} (got {})".format(m.name, k, f.get("min", "-inf"), f.get("max", "inf"), v))
        out[k] = v
    return out


# ---------------------------------------------------------------- calling
_LOCAL = threading.local()


def _gpu_mark():
    g, r, _w = engine.call_mark()          # this thread's own work on the card (other callers do not count)
    return g, r


def call(name, params=None, source="api"):
    """Run a model and return {"result", "timing"}. Long models run inline here; use start() for a job."""
    m = get(name)
    p = coerce(m, params)
    g0, r0, t0 = _gpu_mark() + (time.time(),)
    if m.long:
        res = m.fn(_InlineJob(), **p)
    else:
        res = m.fn(**p)
    g1, r1 = _gpu_mark()
    timing = {"wall_ms": round((time.time() - t0) * 1000, 1), "gpu_ms": round(g1 - g0, 1), "gpu_runs": r1 - r0}
    return {"model": name, "result": res, "timing": timing, "source": source}


def start(name, params=None, source="api", bare=False, label=None):
    """Run a model as a background job (long ones always; any one on request). Returns the job's info.
    bare=True: the job's result is the model's own return value (what the UI's routes have always delivered);
    otherwise it is the same envelope a synchronous call returns."""
    m = get(name)
    p = coerce(m, params)

    def run(job):
        g0, r0, t0 = _gpu_mark() + (time.time(),)
        res = m.fn(job, **p) if m.long else m.fn(**p)
        g1, r1 = _gpu_mark()
        if isinstance(res, Blob):
            res = res.as_json()
        if bare:
            return res
        return {"model": name, "result": res, "timing": {"wall_ms": round((time.time() - t0) * 1000, 1), "gpu_ms": round(g1 - g0, 1), "gpu_runs": r1 - r0}}
    return jobs.start(m.kind, label or ("{} ({})".format(m.title, source) if source != "ui" else m.title), run).info()


class _InlineJob:
    """What a long model sees when it is called synchronously (the CLI's --wait, a test): progress goes nowhere."""
    id, kind = None, "inline"

    def step(self, progress, message=None):
        pass


def get(name):
    m = REGISTRY.get(name)
    if not m:
        close = [k for k in REGISTRY if name.split(".")[0] in k][:8]
        raise UnknownModel("no model {!r}{}".format(name, " — did you mean " + ", ".join(close) + "?" if close else ""))
    return m


def ui(_model, **params):
    """The UI's own routes call this: the same coercion and code path as /v1, returning the bare result.
    Parameters left as None take the model's default. (_model, not name: models have "name" fields.)"""
    return call(_model, {k: v for k, v in params.items() if v is not None}, "ui")["result"]


def ui_job(_model, _label=None, **params):
    return start(_model, {k: v for k, v in params.items() if v is not None}, "ui", bare=True, label=_label)


def _shell(v):
    s = str(v).replace("\n", "\\n")
    return "'" + s.replace("'", "'\\''") + "'" if any(c in s for c in " \"'$\\;&|<>(){}*?!#") or s == "" else s
