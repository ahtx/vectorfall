"""/v1 — the registry over the wire, in the formats other programs already speak.

  GET  /v1/models                    every model (name, title, group, device, …)        ?group=sim
  GET  /v1/models/{name}             one model: fields, JSON Schema, an example, the CLI line
  POST /v1/models/{name}             run it; the body is the parameters as a JSON object
                                       ?async=1 → a job ({id}); poll GET /v1/jobs/{id}
                                       a binary result (image, audio) comes back as bytes; ?json=1 → base64 in JSON
  GET  /v1/jobs/{id}                 a job's state, progress and (when done) its result
  POST /v1/rpc                       JSON-RPC 2.0: method = model name, params = the same object; batches allowed;
                                       rpc.discover → the OpenRPC document; vf.start / vf.job for background jobs
  POST /mcp                          Model Context Protocol (streamable HTTP, JSON replies): every model is a tool
  GET  /v1/openapi.json  /v1/openrpc.json  /v1/docs  /v1/cli (the `vf` command-line client, one file)
  GET  /api/version                  the release, the image revision, the card and the uptime (vfctl and the installer
                                       use it as the health check)

The routes the UI uses (/api/…) call the same registry functions, so all of these run identical code.
"""
import json
import os
import re

from fastapi import APIRouter, HTTPException, Request
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import JSONResponse, Response

from . import engine, jobs, mcp_extras, registry as R

router = APIRouter()
VERSION = "1.0"                          # the API contract (/v1, /v1/rpc, /mcp); the release is APP_VERSION
_STARTED = __import__("time").time()


def _app_version():
    """The release: the VERSION file at the source root (/srv/VERSION in the image), else $VF_VERSION, else "dev"."""
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for p in (os.path.join(here, "VERSION"), "/srv/VERSION"):
        try:
            with open(p) as f:
                v = f.read().strip()
            if v:
                return v
        except OSError:
            pass
    return os.environ.get("VF_VERSION") or "dev"


APP_VERSION = _app_version()
CLI_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vf_cli.py")


def _json(obj, status=200, headers=None):
    from .main import SafeJSON
    return SafeJSON(obj, status_code=status, headers=headers)


def _err(status, kind, msg, **extra):
    return _json({"error": dict(kind=kind, message=msg, **extra)}, status)


def _envelope(out, want_json):
    """A Blob goes out as bytes unless the caller asked for JSON."""
    res = out["result"]
    t = out["timing"]
    if isinstance(res, R.Blob):
        if not want_json:
            h = {"X-VF-Timing": json.dumps(t), "X-VF-Model": out["model"], "X-VF-Meta": json.dumps(res.meta)[:4000]}
            if res.filename:
                h["Content-Disposition"] = 'inline; filename="{}"'.format(res.filename)
            return Response(res.data, media_type=res.media_type, headers=h)
        out = dict(out, result=res.as_json())
    return _json(out)


def _local(request):
    from .main import _local as ok
    return ok(request)


def _guard(name, local):
    m = R.get(name)
    if m.local_only and not local:
        raise R.Refused("{} only runs for callers on your own network (LAN, Tailscale, this host)".format(name), 403)
    return m


def _classify(e):
    """(http status, kind, json-rpc code) for an exception from a model."""
    if isinstance(e, R.UnknownModel):
        return 404, "unknown_model", -32601
    if isinstance(e, R.ParamError):
        return 422, "bad_params", -32602
    if isinstance(e, R.Refused):
        return e.status, "refused", -32000
    if isinstance(e, (engine.GPUBusy, engine.GPUMemoryError)):
        return 503, "gpu_busy", -32003
    if isinstance(e, ValueError):
        return 400, "bad_input", -32001
    return 500, "internal", -32603


def _msg(e):
    t = str(e).strip("'\"")
    return t if not isinstance(e, Exception) or _classify(e)[0] != 500 else "{}: {}".format(type(e).__name__, t)[:500]


def _run(name, params, source, want_json=True, background=False, local=True):
    try:
        _guard(name, local)
        if background:
            return _json({"job": R.start(name, params, source)}, 202)
        return _envelope(R.call(name, params, source), want_json)
    except Exception as e:  # noqa: BLE001
        st, kind, _ = _classify(e)
        if st == 500:
            import traceback
            traceback.print_exc()
        return _err(st, kind, _msg(e), **({"schema": "/v1/models/" + name} if kind == "bad_params" else {}))


# ---------------------------------------------------------------- REST
@router.get("/api/version")
def version():
    import time
    from . import gpu
    c = gpu.CARD or {}
    return {"name": "VectorFall", "version": APP_VERSION, "api": VERSION,
            "revision": os.environ.get("VF_REVISION") or "unknown",
            "card": {"name": c.get("name"), "arch": c.get("arch"), "cc": c.get("cc"), "mem_mb": c.get("mem_mb"),
                     "error": c.get("error")},
            "uptime_s": round(time.time() - _STARTED, 1), "models": len(R.REGISTRY), "jobs": len(jobs.active() or [])}


@router.get("/v1")
def index():
    return {"name": "Vectorfall", "version": VERSION, "release": APP_VERSION, "models": len(R.REGISTRY),
            "links": {"models": "/v1/models", "openapi": "/v1/openapi.json", "openrpc": "/v1/openrpc.json", "rpc": "/v1/rpc",
                      "mcp": "/mcp", "docs": "/v1/docs", "cli": "/v1/cli"}}


@router.get("/v1/models")
def models(group: str = None):
    ms = [m for m in R.REGISTRY.values() if not group or m.group == group or m.name.startswith(group + ".")]
    return {"models": [m.describe(full=False) for m in sorted(ms, key=lambda m: m.name)],
            "groups": R.GROUPS}


@router.get("/v1/models/{name}")
def describe(name: str):
    try:
        return R.get(name).describe()
    except R.UnknownModel as e:
        return _err(404, "unknown_model", _msg(e))


@router.post("/v1/models/{name}")
async def run(name: str, request: Request):
    raw = await request.body()
    try:
        params = json.loads(raw) if raw.strip() else {}
    except ValueError:
        return _err(400, "bad_json", "the body must be a JSON object of parameters")
    if not isinstance(params, dict):
        return _err(400, "bad_json", "the body must be a JSON object of parameters")
    q = request.query_params
    bg = q.get("async") in ("1", "true", "yes")
    want_json = q.get("json") in ("1", "true", "yes") or "application/json" in request.headers.get("accept", "") and "*/*" not in request.headers.get("accept", "")
    from starlette.concurrency import run_in_threadpool
    return await run_in_threadpool(_run, name, params, "rest", want_json, bg, _local(request))


@router.get("/v1/jobs/{jid}")
def job(jid: str):
    j = jobs.get(jid)
    if not j:
        return _err(404, "unknown_job", "no such job (the server keeps jobs in memory, and a restart removes them)")
    if isinstance(j.get("result"), dict) and isinstance(j["result"].get("result"), R.Blob):
        j["result"]["result"] = j["result"]["result"].as_json()
    return j


@router.get("/v1/cli")
def cli():
    with open(CLI_PATH, "rb") as f:
        return Response(f.read().replace(b"\r\n", b"\n"), media_type="text/x-python", headers={"Content-Disposition": 'attachment; filename="vf"'})


# ---------------------------------------------------------------- OpenAPI 3.1 (one path per model, so generated clients get typed methods)
def _op_id(name):
    return re.sub(r"[^A-Za-z0-9]", "_", name)


@router.get("/v1/openapi.json")
def openapi(request: Request):
    paths, schemas = {}, {"Error": {"type": "object", "properties": {"error": {"type": "object", "properties": {
        "kind": {"type": "string"}, "message": {"type": "string"}}}}},
        "Timing": {"type": "object", "properties": {"wall_ms": {"type": "number"}, "gpu_ms": {"type": "number"}, "gpu_runs": {"type": "integer"}}},
        "Job": {"type": "object", "properties": {"id": {"type": "string"}, "state": {"type": "string", "enum": ["running", "done", "error"]},
                                                 "progress": {"type": "number"}, "message": {"type": "string"}, "result": {}}}}
    for m in sorted(R.REGISTRY.values(), key=lambda m: m.name):
        oid = _op_id(m.name)
        schemas[oid + "_params"] = R.input_schema(m)
        ok = {"application/json": {"schema": {"type": "object", "properties": {
            "model": {"type": "string"}, "result": {}, "timing": {"$ref": "#/components/schemas/Timing"}}}}}
        if m.output != "json":
            ok[m.output] = {"schema": {"type": "string", "format": "binary"}}
        paths["/v1/models/" + m.name] = {"post": {
            "operationId": oid, "summary": m.title, "description": m.summary + "\n\nRuns on: {}.{}".format(m.device, " Changes stored data." if m.mutating else ""),
            "tags": [m.group],
            "parameters": [{"name": "async", "in": "query", "schema": {"type": "boolean"}, "description": "run as a background job"},
                           {"name": "json", "in": "query", "schema": {"type": "boolean"}, "description": "binary results as base64 JSON"}],
            "requestBody": {"required": False, "content": {"application/json": {"schema": {"$ref": "#/components/schemas/" + oid + "_params"},
                                                                               "example": m.example}}},
            "responses": {"200": {"description": "the result", "content": ok},
                          "202": {"description": "a background job", "content": {"application/json": {"schema": {"type": "object", "properties": {"job": {"$ref": "#/components/schemas/Job"}}}}}},
                          "404": {"description": "no such model", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Error"}}}},
                          "422": {"description": "bad parameters", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Error"}}}},
                          "503": {"description": "the card is busy or stuck", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Error"}}}}}}}
    paths["/v1/jobs/{id}"] = {"get": {"operationId": "job", "summary": "A background job", "tags": ["system"],
                                      "parameters": [{"name": "id", "in": "path", "required": True, "schema": {"type": "string"}}],
                                      "responses": {"200": {"description": "the job", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Job"}}}}}}}
    base = str(request.base_url).rstrip("/")
    return {"openapi": "3.1.0", "info": {"title": "Vectorfall models", "version": VERSION,
                                         "description": "Every Vectorfall operation as a model. One call per model; the body is its parameters."},
            "servers": [{"url": base}], "paths": paths, "components": {"schemas": schemas},
            "tags": [{"name": g, "description": v["title"]} for g, v in R.GROUPS.items()]}


@router.get("/v1/docs")
def docs():
    return get_swagger_ui_html(openapi_url="/v1/openapi.json", title="Vectorfall models")


# ---------------------------------------------------------------- JSON-RPC 2.0 + OpenRPC
def openrpc_doc():
    methods = []
    for m in sorted(R.REGISTRY.values(), key=lambda m: m.name):
        s = R.input_schema(m)
        methods.append({"name": m.name, "summary": m.title, "description": m.summary, "tags": [{"name": m.group}],
                        "paramStructure": "by-name",
                        "params": [{"name": k, "schema": v, "required": k in s.get("required", [])} for k, v in s["properties"].items()],
                        "result": {"name": "result", "schema": {}},
                        "examples": [{"name": "example", "params": [{"name": k, "value": v} for k, v in m.example.items()],
                                      "result": {"name": "result", "value": None}}] if m.example else []})
    methods.append({"name": "vf.start", "summary": "Run any model as a background job", "paramStructure": "by-name",
                    "params": [{"name": "model", "schema": {"type": "string"}, "required": True}, {"name": "params", "schema": {"type": "object"}}],
                    "result": {"name": "job", "schema": {"type": "object"}}})
    methods.append({"name": "vf.job", "summary": "A background job's state and result", "paramStructure": "by-name",
                    "params": [{"name": "id", "schema": {"type": "string"}, "required": True}], "result": {"name": "job", "schema": {"type": "object"}}})
    return {"openrpc": "1.3.2", "info": {"title": "Vectorfall models", "version": VERSION}, "methods": methods}


@router.get("/v1/openrpc.json")
def openrpc():
    return openrpc_doc()


def _rpc_one(msg, local=True):
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0" or not isinstance(msg.get("method"), str):
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}}
    mid, meth, params = msg.get("id"), msg["method"], msg.get("params") or {}
    note = "id" not in msg

    def ok(res):
        return None if note else {"jsonrpc": "2.0", "id": mid, "result": res}

    def bad(code, text, data=None):
        e = {"code": code, "message": text}
        if data is not None:
            e["data"] = data
        return None if note else {"jsonrpc": "2.0", "id": mid, "error": e}
    if isinstance(params, list):
        return bad(-32602, "Vectorfall methods take named parameters (an object), not a list")
    try:
        if meth == "rpc.discover":
            return ok(openrpc_doc())
        if meth == "vf.start":
            _guard(params.get("model", ""), local)
            return ok(R.start(params.get("model", ""), params.get("params") or {}, "rpc"))
        if meth == "vf.job":
            j = job(params.get("id", ""))
            return ok(j) if isinstance(j, dict) else bad(-32004, "no such job")
        _guard(meth, local)
        out = R.call(meth, params, "rpc")
        if isinstance(out["result"], R.Blob):
            out["result"] = out["result"].as_json()
        return ok(out)
    except Exception as e:  # noqa: BLE001
        st, kind, code = _classify(e)
        names = {-32601: "Method not found", -32602: "Invalid params", -32003: "GPU busy", -32603: "Internal error"}
        return bad(code, names.get(code, "Refused" if kind == "refused" else "Bad input"), _msg(e))


@router.post("/v1/rpc")
async def rpc(request: Request):
    from starlette.concurrency import run_in_threadpool
    try:
        msg = json.loads(await request.body())
    except ValueError:
        return _json({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
    if isinstance(msg, list):
        if not msg:
            return _json({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}})
        loc = _local(request)
        out = [r for r in [await run_in_threadpool(_rpc_one, x, loc) for x in msg] if r is not None]
        return _json(out) if out else Response(status_code=204)
    r = await run_in_threadpool(_rpc_one, msg, _local(request))
    return _json(r) if r is not None else Response(status_code=204)


# ---------------------------------------------------------------- MCP (tools, prompts, resources; streamable HTTP answered with plain JSON)
MCP_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")


def _tool_name(name):
    return name.replace(".", "_")        # many clients only accept [A-Za-z0-9_-] in tool names


def _tool_set(spec):
    """'?tools=plan,problem,sound.find' on the MCP URL: only these models are listed (a group name, a model name or a
    prefix with *). An agent that reads 8 tools instead of 268 saves about 60K tokens of tool descriptions."""
    if not spec:
        return None
    return [t.strip() for t in spec.split(",") if t.strip()]


def _in_set(name, pats):
    if pats is None or pats in (["find"], ["discover"]) or name in ("vf_start", "vf_job"):
        return True
    import fnmatch
    tn = _tool_name(name)
    model = R.REGISTRY.get(name)
    return (model is not None and model.group in pats) or any(
               n == p or n.startswith(p + sep) or fnmatch.fnmatchcase(n, p)
               for p in pats for n, sep in ((name, "."), (tn, "_")))


def _compact_schema(sc):
    """The input schema an agent needs: types, descriptions (the form label when there is none), enums, ranges,
    required, and defaults that are short. Form labels, widget hints and long sample defaults stay in ?full=1."""
    props = {}
    for k, v in (sc.get("properties") or {}).items():
        q = {}
        for f in ("type", "enum", "items", "minimum", "maximum", "contentEncoding"):
            if f in v:
                q[f] = v[f]
        d = v.get("description") or v.get("title")
        if d and d.lower() != k.replace("_", " "):
            q["description"] = d
        if "default" in v and len(json.dumps(v["default"])) <= 40:
            q["default"] = v["default"]
        props[k] = q
    out = {"type": "object", "properties": props}
    if sc.get("required"):
        out["required"] = sc["required"]
    return out


def _tool_def(m, full=False):
    ro = not (m.mutating or m.local_only)
    d = m.summary or m.title
    if full:
        t = {"name": _tool_name(m.name), "title": m.title,
             "description": "{} (runs on: {}{})".format(d, m.device, "; changes stored data" if m.mutating else ""),
             "inputSchema": R.input_schema(m),
             "annotations": {"title": m.title, "readOnlyHint": ro, "destructiveHint": not ro, "openWorldHint": False}}
    else:   # MCP defaults: readOnlyHint false, destructiveHint true, so only a read-only tool needs a hint
        t = {"name": _tool_name(m.name), "description": d + (" (GPU)" if m.device == "gpu" else ""),
             "inputSchema": _compact_schema(R.input_schema(m))}
        if ro:
            t["annotations"] = {"readOnlyHint": True}
    if m.name in mcp_extras.OUTPUT_SCHEMAS:
        t["outputSchema"] = mcp_extras.OUTPUT_SCHEMAS[m.name]
    return t


_RO = {"readOnlyHint": True}
_DISCOVER_TOOLS = [
    {"name": "vf_groups", "description": "Step 1. The kinds of VectorFall tools (planning, simulation, forecasting, text, sound, "
     "photo, data, fractals ...): each group with a one-line title and its number of tools.",
     "inputSchema": {"type": "object", "properties": {}}, "annotations": _RO},
    {"name": "vf_tools", "description": "Step 2. The tools of one or more groups: name and one line each, no schemas.",
     "inputSchema": {"type": "object", "properties": {"group": {"type": "string", "description": "a group from vf_groups, or several joined by commas"}},
                     "required": ["group"]}, "annotations": _RO},
    {"name": "vf_find", "description": "Or search all tools by words; returns names and one line each. Example query: 'visit order route'.",
     "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}, "limit": {"type": "integer", "default": 8}},
                     "required": ["query"]}, "annotations": _RO},
    {"name": "vf_describe", "description": "Step 3. The input schemas of the tools you chose (up to 8 names).",
     "inputSchema": {"type": "object", "properties": {"tools": {"type": "array", "items": {"type": "string"}}},
                     "required": ["tools"]}, "annotations": _RO},
    {"name": "vf_run", "description": "Step 4. Run one tool with its arguments. A wrong argument returns the error and the tool's schema.",
     "inputSchema": {"type": "object", "properties": {"tool": {"type": "string"}, "arguments": {"type": "object"}}, "required": ["tool"]}},
]
_DISCOVER_NAMES = {t["name"] for t in _DISCOVER_TOOLS}
_FIND_TOOLS = [
    {"name": "vf_find", "description": "Search VectorFall tools by words and return matching input schemas.",
     "inputSchema": {"type": "object", "properties": {"query": {"type": "string"},
                     "limit": {"type": "integer", "default": 6}}, "required": ["query"]}, "annotations": _RO},
    _DISCOVER_TOOLS[-1],
]


def _model_of(tool):
    tool = str(tool or "").strip()
    return R.REGISTRY.get(tool) or next((m for k, m in R.REGISTRY.items() if _tool_name(k) == tool), None)


def _brief(m):
    return {"name": _tool_name(m.name), "about": (m.summary or m.title).split(". ")[0][:160]}


def _discover(tname, args, find_with_schema=False):
    if tname == "vf_groups":
        n = {}
        for m in R.REGISTRY.values():
            n[m.group] = n.get(m.group, 0) + 1
        return {"groups": [{"group": g, "title": GT["title"], "tools": n[g]} for g, GT in sorted(R.GROUPS.items()) if n.get(g)],
                "next": "vf_tools(group), or vf_find(query)"}
    if tname == "vf_tools":
        want = [g.strip() for g in str(args.get("group", "")).split(",") if g.strip()]
        bad = [g for g in want if g not in R.GROUPS]
        if bad or not want:
            raise R.Refused("unknown group {}; the groups are: {}".format(", ".join(bad) or "(none)", ", ".join(sorted(R.GROUPS))))
        return {"tools": [_brief(m) for m in sorted(R.REGISTRY.values(), key=lambda m: m.name) if m.group in want],
                "next": "vf_describe(tools) for the schemas"}
    if tname == "vf_find":
        words = [w for w in re.findall(r"[a-z0-9]+", str(args.get("query", "")).lower()) if len(w) > 1]
        scored = []
        for m in R.REGISTRY.values():
            search_terms = [m.name.replace(".", " "), m.title, m.summary or ""]
            if not find_with_schema:
                search_terms.append(m.group)
            hay = " ".join(search_terms).lower()
            sc = sum((3 if w in m.name.lower() else 0) + (2 if w in m.title.lower() else 0) + (1 if w in hay else 0) for w in words)
            if sc:
                scored.append((-sc, m.name, m))
        scored.sort(key=lambda x: (x[0], x[1]))
        lim = max(1, min(int(args.get("limit") or (6 if find_with_schema else 8)), 20))
        if find_with_schema:
            return {"tools": [_tool_def(m) for _, _, m in scored[:lim]]}
        return {"tools": [_brief(m) for _, _, m in scored[:lim]], "next": "vf_describe(tools) for the schemas"}
    if tname == "vf_describe":
        names = args.get("tools") or []
        if isinstance(names, str):
            names = [x for x in names.split(",")]
        out, missing = [], []
        for t in names[:8]:
            m = _model_of(t)
            (out.append(_tool_def(m)) if m else missing.append(str(t)))
        res = {"tools": out, "next": "vf_run(tool, arguments)"}
        if missing:
            res["unknown"] = missing
        return res
    raise KeyError(tname)


def _mcp_tools(pats=None, full=False):
    if pats == ["find"]:
        return list(_FIND_TOOLS) + _JOB_TOOLS
    if pats == ["discover"]:
        return list(_DISCOVER_TOOLS) + _JOB_TOOLS
    out = [_tool_def(m, full) for m in sorted(R.REGISTRY.values(), key=lambda m: m.name) if _in_set(m.name, pats)]
    return out + _JOB_TOOLS


_JOB_TOOLS = [
    {"name": "vf_start", "description": "Start any registered model asynchronously and return a durable job id.",
     "inputSchema": {"type": "object", "properties": {"model": {"type": "string"}, "params": {"type": "object"}},
                     "required": ["model"]}},
    {"name": "vf_job", "description": "Read a background job's state, measured progress, result, or error.",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]},
     "annotations": {"readOnlyHint": True}},
]


def _card_text():
    try:
        from . import gpu
        c = gpu.CARD or {}
        return "an NVIDIA {} ({} MB)".format(c["name"], c["mem_mb"]) if c.get("mem_mb") else "one NVIDIA card"
    except Exception:  # noqa: BLE001
        return "one NVIDIA card"


_AGENT_DROP = ("provenance", "chart")          # for people's eyes; the full result keeps them


def _for_agent(x, depth=0):
    """The text an agent reads: the same result, without the bulk a small local model can't hold in its context.
    Long number series become a one-line summary, provenance and charts are dropped, generated model code is left
    out, a template's calls keep only the MCP one, and long lists of records keep only their short fields.
    structuredContent always carries the full result."""
    if isinstance(x, dict):
        out = {}
        for k, v in x.items():
            if k in _AGENT_DROP or v is None or (isinstance(v, (list, dict)) and not v and depth > 0):
                continue
            if k == "model" and isinstance(v, str) and "\n" in v:
                continue                        # the generated solver model (code): the Planner shows it, agents don't need it
            if k == "calls" and isinstance(v, dict) and "mcp" in v:
                out[k] = {"mcp": v["mcp"]}
                continue
            out[k] = _for_agent(v, depth + 1)
        return out
    if isinstance(x, list):
        if len(x) > 24 and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in x):
            return "{} numbers from {:.4g} to {:.4g} (the full list is in structuredContent)".format(len(x), min(x), max(x))
        if len(x) > 25 and all(isinstance(v, dict) for v in x):
            short = [{k: v for k, v in d.items() if isinstance(v, (int, float, bool)) or v is None
                      or (isinstance(v, str) and len(v) <= 120)} for d in x]
            return short
        return [_for_agent(v, depth + 1) for v in x]
    return x


def _mcp_one(msg, local=True, pats=None, full=False):
    if not isinstance(msg, dict):
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}}
    mid, meth, p = msg.get("id"), msg.get("method"), msg.get("params") or {}
    if "id" not in msg:
        return None                                     # notifications (initialized, cancelled): nothing to say
    if meth == "initialize":
        v = p.get("protocolVersion")
        return {"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": v if v in MCP_VERSIONS else MCP_VERSIONS[0],
                "capabilities": {"tools": {"listChanged": False}, "prompts": {"listChanged": False}, "resources": {"listChanged": False}},
                "serverInfo": {"name": "vectorfall", "title": "Vectorfall", "version": APP_VERSION},
                "instructions": "Each tool is one Vectorfall model that runs on {} (one GPU queue). ".format(_card_text())+
                                "References (tables, photos, sounds, corpora, projects) accept an id or part of a name. "
                                "For your own problem, start with the prompts or problem_templates (resource vectorfall://guide/agents). "
                                "To list fewer tools add ?tools=<groups> to this URL (e.g. /mcp?tools=plan,problem), or ?tools=discover to list only "
                                "the discovery tools (vf_groups -> vf_tools or vf_find -> vf_describe -> vf_run). ?full=1 adds the form labels and UI hints to the schemas."}}
    if meth == "ping":
        return {"jsonrpc": "2.0", "id": mid, "result": {}}
    if meth == "tools/list":
        return {"jsonrpc": "2.0", "id": mid, "result": {"tools": _mcp_tools(pats, full)}}
    if meth.startswith(("prompts/", "resources/")):
        try:
            res = mcp_extras.handle(meth, p)
        except (KeyError, ValueError) as e:
            return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": _msg(e)}}
        if res is not None:
            return {"jsonrpc": "2.0", "id": mid, "result": res}
    if meth == "tools/call":
        tname = p.get("name", "")
        args = p.get("arguments") or {}
        if not isinstance(args, dict):
            return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": "arguments must be an object"}}
        via_run = tname == "vf_run"
        if tname in _DISCOVER_NAMES and not via_run:
            legacy_find = tname == "vf_find" and pats in (None, ["find"])
            if not legacy_find and pats != ["discover"]:
                return _outside_tool_set(mid, tname)
            try:
                out = _discover(tname, args, find_with_schema=legacy_find)
            except Exception as e:  # noqa: BLE001
                return {"jsonrpc": "2.0", "id": mid, "result": {"isError": True, "content": [{"type": "text", "text": _msg(e)}]}}
            return {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": json.dumps(out, ensure_ascii=False)}],
                    "structuredContent": out}}
        if via_run:
            tname, args = str(args.get("tool", "")), args.get("arguments") or {}
            p = {"name": tname, "arguments": args}
        if tname in ("vf_start", "vf_job"):
            try:
                if tname == "vf_start":
                    requested = args.get("model", "")
                    model = next((k for k in R.REGISTRY if _tool_name(k) == requested), requested)
                    if not _in_set(model, pats):
                        return _outside_tool_set(mid, requested)
                    _guard(model, local)
                    out = R.start(model, args.get("params") or {}, "mcp")
                else:
                    out = jobs.get(args.get("id", ""))
                    if not out:
                        raise R.Refused("no such job", 404)
                from .main import _jsonable
                out = _jsonable(out)
                return {"jsonrpc": "2.0", "id": mid, "result": {
                    "content": [{"type": "text", "text": json.dumps(out, ensure_ascii=False)}], "structuredContent": out}}
            except Exception as e:
                return {"jsonrpc": "2.0", "id": mid, "result": {"isError": True, "content": [{"type": "text", "text": _msg(e)}]}}
        name = next((k for k in R.REGISTRY if _tool_name(k) == tname), tname)
        if not _in_set(name, pats):
            return _outside_tool_set(mid, tname)
        try:
            _guard(name, local)
            out = R.call(name, p.get("arguments") or {}, "mcp")
        except Exception as e:  # noqa: BLE001
            text = _msg(e)
            if via_run:
                m = _model_of(name)
                text += (" | schema: " + json.dumps(_tool_def(m)["inputSchema"], ensure_ascii=False)) if m else \
                    " | no such tool; use vf_find or vf_tools"
            return {"jsonrpc": "2.0", "id": mid, "result": {"isError": True, "content": [{"type": "text", "text": text}]}}
        res = out["result"]
        if isinstance(res, R.Blob):
            b = res.as_json()
            content = [{"type": "image", "data": b["base64"], "mimeType": res.media_type}] if res.media_type.startswith("image/") else \
                [{"type": "resource", "resource": {"uri": "vectorfall:///{}/{}".format(name, res.filename or "result"), "mimeType": res.media_type, "blob": b["base64"]}}]
            content.append({"type": "text", "text": json.dumps({"timing": out["timing"], "meta": res.meta})})
            return {"jsonrpc": "2.0", "id": mid, "result": {"content": content}}
        from .main import _jsonable
        sc = _jsonable({"result": res, "timing": out["timing"]})
        text = json.dumps(_for_agent(sc), ensure_ascii=False)
        if len(text) > 60000:
            text = text[:60000] + " … (truncated; the full result is in structuredContent)"
        return {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": text}], "structuredContent": sc}}
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "Method not found: {}".format(meth)}}


def _outside_tool_set(mid, name):
    return {"jsonrpc": "2.0", "id": mid, "result": {"isError": True, "content": [{
        "type": "text", "text": "{} is not in this tool set (?tools= on the MCP URL)".format(name)}]}}


@router.post("/mcp")
async def mcp(request: Request):
    from starlette.concurrency import run_in_threadpool
    try:
        msg = json.loads(await request.body())
    except ValueError:
        return _json({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
    pats = _tool_set(request.query_params.get("tools"))
    full = request.query_params.get("full") in ("1", "true", "yes")
    if isinstance(msg, list):
        loc = _local(request)
        out = [r for r in [await run_in_threadpool(_mcp_one, x, loc, pats, full) for x in msg] if r is not None]
        return _json(out) if out else Response(status_code=202)
    r = await run_in_threadpool(_mcp_one, msg, _local(request), pats, full)
    return _json(r) if r is not None else Response(status_code=202)


@router.get("/mcp")
def mcp_get():
    return Response(status_code=405, headers={"Allow": "POST"})
