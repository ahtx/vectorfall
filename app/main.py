"""VectorFall — a personal Cray you can actually use. One FastAPI process on the host owns the K420 (one GPU worker
thread; the card has one SMX and 1 GB) and serves the apps: Text Engine, Photo Lab, Sound Lab, Data Desk, Forecast,
Fractals, Life, the Console, and the Machine itself. The Console runs your code in its own process.
"""
import asyncio
import functools
import io
import ipaddress
import json
import os
import subprocess
import shutil
import tempfile
import time

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import console, engine, forecast, fractal, gpu, jobs, media, nodes, simulate, sims, textengine as te  # noqa: F401
from . import registry as R

from fastapi.responses import JSONResponse as _JSONResponse


def _jsonable(o):
    """NaN/inf -> null and numpy scalars -> Python, recursively. Real spreadsheets are full of blank numeric cells;
    the stock JSON encoder refuses NaN and turns the whole response into a 500."""
    if isinstance(o, float):
        return o if o == o and o not in (float("inf"), float("-inf")) else None
    if isinstance(o, dict):
        return {k: _jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_jsonable(v) for v in o]
    if type(o).__module__ == "numpy":
        try:
            return _jsonable(o.item()) if hasattr(o, "item") and getattr(o, "ndim", 0) == 0 else _jsonable(o.tolist())
        except Exception:  # noqa: BLE001
            return str(o)
    return o


class SafeJSON(_JSONResponse):
    def render(self, content):
        return json.dumps(_jsonable(content), ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")


import faulthandler as _fh  # noqa: E402
import signal as _signal  # noqa: E402
import sys as _sys  # noqa: E402
import traceback as _tb  # noqa: E402
if hasattr(_fh, "register"):                          # Unix only; on Windows/docker-less hosts skip the USR1 dump hook
    _fh.register(_signal.SIGUSR1, all_threads=True)  # `docker kill -s USR1 vectorfall` -> every thread's stack in the log


app = FastAPI(title="VectorFall", docs_url="/api/docs", openapi_url="/api/openapi.json", default_response_class=SafeJSON)


@app.middleware("http")
async def _ui_revalidate(request, call_next):
    """UI files are always revalidated (their ETag makes an unchanged file a 304), so a change to the UI is in the
    next page load for everyone, without per-file version tags; core.js must keep one URL for all its importers."""
    resp = await call_next(request)
    p = request.url.path
    if (p == "/" or p.endswith((".js", ".css", ".html", ".svg"))) and "cache-control" not in resp.headers:
        resp.headers["Cache-Control"] = "no-cache"
    return resp
TMP = "/srv/data/uploads"
BOOT_T = time.time()
os.makedirs(TMP, exist_ok=True)


@app.exception_handler(engine.GPUBusy)
async def _gpu_busy(request, exc):
    from fastapi.responses import JSONResponse
    return JSONResponse({"detail": str(exc)}, status_code=503)


@app.exception_handler(R.ParamError)
async def _param_error(request, exc):
    return SafeJSON({"detail": str(exc)}, status_code=422)


@app.exception_handler(R.Refused)
async def _refused(request, exc):
    return SafeJSON({"detail": str(exc)}, status_code=exc.status)


@app.exception_handler(R.UnknownModel)
async def _unknown_model(request, exc):
    return SafeJSON({"detail": str(exc).strip("'\"")}, status_code=404)


@app.exception_handler(ValueError)
async def _value_error(request, exc):
    # a model said the input can't be used (Refused and ParamError have their own handlers above)
    return SafeJSON({"detail": str(exc)}, status_code=400)


def _m(_model, **params):
    """A UI route's whole body: the registered model, with the same checks every other caller gets."""
    return R.ui(_model, **params)


def _blob(b, header="X-Meta", download=False, extra=None):
    h = {header: json.dumps(b.meta), "Cache-Control": "no-store"}
    if download and b.filename:
        h["Content-Disposition"] = 'attachment; filename="{}"'.format(b.filename)
    h.update(extra or {})
    return Response(b.data, media_type=b.media_type, headers=h)


@app.exception_handler(engine.GPUMemoryError)
async def _oom(request, exc):
    from fastapi.responses import JSONResponse
    return JSONResponse({"detail": str(exc)}, status_code=503)


async def _thread(fn, *a, **kw):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, functools.partial(fn, *a, **kw))


def _bad(e, code=400):
    raise HTTPException(code, str(e)[:400])


def _local(request):
    """The Console runs code: only from the LAN, this machine or a network listed in VF_TRUSTED_NETS."""
    try:
        ip = ipaddress.ip_address(request.client.host)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback or any(ip in n for n in _TRUSTED_NETS)


# extra networks (comma-separated CIDRs, e.g. a VPN range) that may use the Console, from the environment
_TRUSTED_NETS = [ipaddress.ip_network(s.strip(), strict=False)
                 for s in os.environ.get("VF_TRUSTED_NETS", "").split(",") if s.strip()]


@app.on_event("startup")
async def _startup():
    from . import tls
    asyncio.ensure_future(tls.start())
    async def warm():
        await asyncio.sleep(2)
        await _thread(engine.measure_pcie)
        while True:
            await asyncio.sleep(120)
            await _thread(engine.measure_pcie)
    asyncio.ensure_future(warm())
    from . import samples

    def first_steps(j):
        samples.seed(j)                              # the shipped demo set, once (app/samples.py)
        act = [c for c in te.list_corpora() if c["index"]]
        cid = act[0]["id"] if act else samples.first_run_corpus()
        if cid:                                      # bring the most recent indexed corpus (or the sample essays) onto the card
            te.activate(cid, j)
    jobs.start("text", "starting: samples and the last corpus", first_steps)


# ================================================================ machine
def _activity(snap):
    """Everything using the card right now, named: the GPU worker's job, background jobs, Console scripts, and any
    other process nvidia-smi shows (labelled honestly as external, with its memory)."""
    out = []
    w = snap.get("worker") or {}
    if w.get("busy"):
        out.append({"src": "worker", "label": w.get("current") or "computing", "queued": w.get("queued", 0)})
    for j in snap.get("jobs") or []:
        out.append({"src": "job", "id": j.get("id"), "label": "{}: {}".format(j.get("label"), j.get("message") or "").strip(": "),
                    "progress": j.get("progress"), "elapsed": j.get("elapsed")})
    con = console.activity()
    out.extend(con)
    procs = ((snap.get("live") or {}).get("procs")) or []
    others = [p for p in procs if p.get("pid") != engine.SERVER_PID] if engine.SERVER_PID else procs[1:]
    others = others[len(con):]                       # Console scripts account for that many of the extra processes
    for p in others:
        nm = str(p.get("name") or "")
        nm = "" if not nm or "Not Found" in nm or "N/A" in nm else os.path.basename(nm)
        out.append({"src": "external", "label": "{} · {} MB".format(nm or "another program", p.get("mem_mb")),
                    "name": nm or None, "pid": p.get("pid"), "mem_mb": p.get("mem_mb")})
    return out


@app.get("/api/debug/stacks")
async def debug_stacks():
    """Every thread's Python stack. async on purpose: it runs on the event loop, so it still answers when every
    worker thread in the pool is stuck."""
    names = {t.ident: t.name for t in __import__("threading").enumerate()}
    out = {}
    for tid, fr in _sys._current_frames().items():
        out["{} ({})".format(names.get(tid, "?"), tid)] = "".join(_tb.format_stack(fr)[-14:])
    return out


@app.post("/api/machine/reset")
def machine_reset(body: dict = None):
    """Terminate everything on the card (the running job, the queue, Console scripts) and restart the GPU service."""
    return _m("machine.reset", reason=(body or {}).get("reason") or "reset from the UI")


@app.get("/api/machine")
def machine():
    snap = gpu.snapshot()
    snap["worker"] = engine.worker.status()
    snap["jobs"] = jobs.active()
    snap["activity"] = _activity(snap)
    snap["host"] = gpu.host()
    snap["last_reset"] = engine.last_reset()
    a = te.ACTIVE["c"]
    snap["corpus"] = dict(name=a.meta.get("name"), **a.residency()) if a and a.ready else None
    return snap


@app.get("/api/machine/occupancy")
def occ(threads: int = 256, regs: int = 32, shared: int = 0):
    return _m("machine.occupancy", threads=max(32, min(threads, 1024)), regs=max(1, min(regs, 255)), shared=max(0, min(shared, 49152)))


@app.post("/api/machine/pcie")
def pcie():
    return _m("machine.pcie")


@app.post("/api/machine/benchmark")
def benchmark():
    return _m("machine.benchmark")


# ================================================================ jobs
@app.get("/api/jobs")
def jobs_list():
    return jobs.active()


@app.get("/api/system/log")
def system_log(since: int = 0):
    w = engine.worker
    return {"gpu": [dict(e) for e in list(w.log) if e["seq"] > since], "seq": w.seq, "jobs": jobs.recent(),
            "boot": BOOT_T, "now": time.time(), "last_reset": engine.last_reset()}


@app.get("/api/system/history")
def system_history(q: str = "", kind: str = "", app_: str = Query("", alias="app"), since: float = 0, until: float = 0, order: str = "newest", limit: int = 300):
    return R.ui("machine.log", q=q, kind=kind, app=app_, since=since, until=until, order=order, limit=limit)


@app.post("/api/system/note")
def system_note(body: dict):
    from . import syslog
    syslog.note(str(body.get("kind") or "client"), str(body.get("text") or ""), body.get("app"))
    return {"ok": True}


TOOL = "/srv/data/shell/tool.txt"


@app.get("/api/system/tool")
def tool_get():
    try:
        with open(TOOL, encoding="utf-8") as f:
            return {"text": f.read(), "saved": os.path.getmtime(TOOL)}
    except FileNotFoundError:
        return {"text": None, "saved": None}


@app.put("/api/system/tool")
def tool_put(body: dict):
    t = str(body.get("text", ""))
    if len(t) > 200000:
        raise HTTPException(413, "the maximum size of the tool text is 200 kB")
    os.makedirs(os.path.dirname(TOOL), exist_ok=True)
    with open(TOOL + ".tmp", "w", encoding="utf-8") as f:
        f.write(t)
    os.replace(TOOL + ".tmp", TOOL)
    return {"saved": os.path.getmtime(TOOL)}


@app.post("/api/jobs/{jid}/cancel")
def job_cancel(jid: str):
    j = jobs.cancel(jid)
    if not j:
        raise HTTPException(404, "no such job")
    return j


@app.get("/api/jobs/{jid}")
def job_get(jid: str):
    j = jobs.get(jid)
    if not j:
        raise HTTPException(404, "no such job")
    return j


# ================================================================ text engine
@app.get("/api/text/corpora")
def text_corpora():
    return _m("text.corpus.list")


@app.get("/api/text/bundles")
def text_bundles():
    return [{"id": k, "name": v["name"], "books": len(v["ids"])} for k, v in te.BUNDLES.items()]


@app.post("/api/text/corpora")
async def text_upload(files: list = File(...), name: str = Form("")):
    """Several files become one corpus. (/v1's text.corpus.file takes one file; the multi-file upload stays here.)"""
    from .models import text as mt
    d = tempfile.mkdtemp(dir=TMP)
    saved = []
    for f in files:
        path = os.path.join(d, os.path.basename(f.filename or "upload.txt"))
        with open(path, "wb") as out:
            while True:
                chunk = await f.read(8 << 20)
                if not chunk:
                    break
                out.write(chunk)
        saved.append((f.filename or "upload.txt", path))
    label = name or (saved[0][0] if len(saved) == 1 else "{} files".format(len(saved)))

    def parts(j):
        out = []
        for fn, path in saved:
            out += te.sources(fn, path=path)
        return out
    return jobs.start("text", "loading " + label, lambda j: mt._create(j, label, parts, lambda: shutil.rmtree(d, ignore_errors=True))).info()


@app.post("/api/text/corpora/gutenberg")
def text_gutenberg(body: dict):
    b = te.BUNDLES.get(body.get("bundle"))
    if not b:
        raise HTTPException(404, "no such bundle")
    return R.ui_job("text.corpus.gutenberg", "loading " + b["name"], bundle=body.get("bundle"))


@app.post("/api/text/corpora/paste")
def text_paste(body: dict):
    if not (body.get("text") or "").strip():
        raise HTTPException(400, "nothing pasted")
    nm = body.get("name") or "Pasted text"
    return R.ui_job("text.corpus.paste", "loading " + nm, text=body.get("text"), name=nm)


@app.post("/api/text/corpora/url")
def text_url(body: dict):
    url = body.get("url") or ""
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "give an http(s) URL")
    return R.ui_job("text.corpus.url", "loading " + (body.get("name") or url.split("//")[-1][:60]), url=url, name=body.get("name") or None)


@app.post("/api/text/corpora/blank")
def text_blank(body: dict = None):
    return _m("text.corpus.blank", name=((body or {}).get("name") or "Untitled corpus").strip()[:120])


@app.post("/api/text/corpora/add")
async def text_add(request: Request):
    """Add to the selected corpus: JSON {text | url, name} or a multipart upload of files."""
    from .models import text as mt
    ctype = request.headers.get("content-type", "")
    if ctype.startswith("multipart/"):
        form = await request.form()
        files = [f for k, f in form.multi_items() if k == "files" and hasattr(f, "filename")]
        if not files:
            raise HTTPException(400, "no files")
        d = tempfile.mkdtemp(dir=TMP)
        saved = []
        for f in files:
            path = os.path.join(d, os.path.basename(f.filename or "upload.txt"))
            with open(path, "wb") as out:
                while True:
                    chunk = await f.read(8 << 20)
                    if not chunk:
                        break
                    out.write(chunk)
            saved.append((f.filename or "upload.txt", path))
        cid = te.ACTIVE["c"].id if te.ACTIVE["c"] else te.ACTIVE.get("blank")
        if not cid:
            raise HTTPException(409, "no corpus selected: pick one or start a blank corpus")

        def run(j):
            try:
                parts = []
                for fn, path in saved:
                    parts += te.sources(fn, path=path)
                j.step(0.06, "add the files and make the index again on the card")
                return te.add_parts(cid, parts, j)
            finally:
                shutil.rmtree(d, ignore_errors=True)
        return jobs.start("text", "add {} file(s)".format(len(saved)), run).info()
    body = await request.json()
    if not ((body.get("text") or "").strip() or body.get("url")):
        raise HTTPException(400, "nothing to add")
    return R.ui_job("text.corpus.add", "adding text", text=body.get("text") or None, url=body.get("url") or None,
                    name=body.get("name") or "")


@app.get("/api/text/rel/{kind}")
def text_rel(kind: str, a: str = "", b: str = "", c: str = "", expr: str = "", words: str = "", k: int = 15,
             method: str = "3cosmul", neighbours: int = 25):
    k = max(1, min(int(k), 100))
    try:
        if kind == "analogy":
            return _m("text.rel.analogy", a=a, b=b, c=c, k=min(k, 50), method=method if method in ("3cosmul", "3cosadd") else "3cosmul")
        if kind == "pairs":
            return _m("text.rel.pairs", a=a, b=b, k=k, neighbours=max(5, min(int(neighbours), 100)))
        if kind == "arith":
            return _m("text.rel.arith", expr=expr, k=min(k, 50))
        if kind == "axis":
            return _m("text.rel.axis", a=a, b=b, k=min(k, 60))
        if kind == "between":
            return _m("text.rel.between", a=a, b=b, k=min(k, 50))
        if kind == "odd":
            return _m("text.rel.odd", words=words)
        if kind == "test":
            return _m("text.rel.test", max_per=40)
    except ValueError as e:
        raise HTTPException(400, str(e))
    raise HTTPException(404, "unknown relation query")


@app.post("/api/text/corpora/{cid}/activate")
def text_activate(cid: str):
    return R.ui_job("text.corpus.activate", "loading", corpus=cid)


@app.delete("/api/text/corpora/{cid}")
def text_delete(cid: str):
    return _m("text.corpus.delete", corpus=cid)


@app.get("/api/text/active")
def text_active():
    return _m("text.corpus.active")


@app.get("/api/text/search")
def text_search(q: str, case: int = 0, limit: int = 60, offset: int = 0):
    return _m("text.search", q=q, case=bool(case), limit=max(1, min(limit, 500)), offset=max(0, offset))


@app.get("/api/text/near")
def text_near(q: str, side: str = "next", case: int = 0, top: int = 24, show_off: int = 0):
    return _m("text.near", q=q, side="next" if side == "next" else "prev", case=bool(case), top=max(1, min(top, 200)), show_off=bool(show_off))


@app.get("/api/text/filter")
def text_filter_get():
    return _m("text.filter.get")


@app.post("/api/text/filter")
def text_filter_set(body: dict):
    return _m("text.filter.set", **{k: body.get(k) for k in ("exclude", "stop", "junk", "min", "max")})


@app.post("/api/text/filter/toggle")
def text_filter_toggle(body: dict):
    return _m("text.filter.toggle", word=(body.get("word") or "").strip() or None, off=body.get("off"))


@app.get("/api/text/embedmap")
def text_embedmap(n: int = 500, topics: int = 12):
    return _m("text.embedmap", n=max(50, min(n, 1200)), topics=max(2, min(topics, 30)))


@app.get("/api/text/topics")
def text_topics(topics: int = 16):
    return _m("text.topics", topics=max(2, min(topics, 40)))


@app.get("/api/text/generate")
def text_generate(seed: str = "", order: int = 2, n: int = 80, temp: float = 1.0):
    return _m("text.generate", seed=seed, order=max(1, min(order, 6)), n=max(1, min(n, 600)), temp=max(0.05, min(temp, 5)))


@app.get("/api/text/source")
def text_source(pos: int):
    return _m("text.source", pos=max(0, pos))


@app.get("/api/text/read")
def text_read(at: int, hl: int = 0, before: int = 2500, after: int = 4000):
    return _m("text.read", at=max(0, at), hl=max(0, hl), before=max(0, min(before, 40000)), after=max(0, min(after, 40000)))


@app.get("/api/text/retrieve")
def text_retrieve(q: str, top: int = 8):
    return _m("text.retrieve", q=q, top=max(1, min(top, 30)))


@app.post("/api/text/sources/trace")
def text_trace(body: dict):
    return _m("text.trace", text=str(body.get("text") or "") or None, min_words=max(1, min(50, int(body.get("min_words") or 6))),
              case=bool(body.get("case")))


@app.post("/api/text/sources/continue")
def text_continue(body: dict):
    return _m("text.continue", prompt=str(body.get("prompt") or ""), n=max(5, min(400, int(body.get("n") or 60))),
              temp=max(0.05, min(5, float(body.get("temp") or 1.0))), max_ctx=max(1, min(200, int(body.get("max_ctx") or 40))))


@app.get("/api/text/stats")
def text_stats():
    return _m("text.stats")


@app.get("/api/text/pairs")
def text_pairs(n: int = 30):
    return _m("text.pairs", n=max(4, min(n, 80)))


@app.get("/api/text/bigrams")
def text_bigrams(top: int = 60):
    return _m("text.bigrams", top=max(1, min(top, 400)))


@app.get("/api/text/vocab")
def text_vocab(prefix: str = "", top: int = 200):
    return _m("text.vocab", prefix=prefix, top=max(1, min(top, 2000)))


@app.get("/api/text/vocab/analysis")
def text_vocab_analysis(contains: str = "", min_count: int = 0, max_count: int = 0, drop_stop: int = 0,
                        words_only: int = 1, sort: str = "freq", top: int = 400, show_off: int = 0):
    return _m("text.vocab.analysis", contains=contains, min_count=max(0, min_count), max_count=max(0, max_count), drop_stop=bool(drop_stop),
              words_only=bool(words_only), sort=sort if sort in ("freq", "rare") else "vocab", top=max(1, min(top, 2000)), show_off=bool(show_off))


@app.get("/api/text/table")
def text_table(n: int = 20):
    return _m("text.table", n=max(4, min(n, 40)))


@app.get("/api/text/similar")
def text_similar(word: str, k: int = 24):
    return _m("text.similar", word=word, k=max(1, min(k, 60)))


@app.get("/api/text/meaning")
def text_meaning(clusters: int = 10, keywords: int = 40, collocations: int = 30):
    return _m("text.meaning", clusters=max(2, min(clusters, 20)), keywords=max(1, min(keywords, 80)), collocations=max(1, min(collocations, 60)))


@app.get("/api/text/generate2")
def text_generate2(seed: str = "", order: int = 3, length: int = 90, temp: float = 1.0, stop_at: str = "none",
                   avoid_stop: int = 0, theme: str = "", mode: str = "markov", topics: int = 16):
    return _m("text.generate2", seed=seed, order=max(1, min(order, 6)), length=max(5, min(length, 600)), temp=max(0.05, min(temp, 5)),
              stop_at=stop_at if stop_at in ("none", "sentence", "paragraph") else "none", avoid_stop=bool(avoid_stop), theme=theme,
              mode="topics" if mode == "topics" else "markov", topics=max(2, min(topics, 40)))


@app.get("/api/text/extract")
def text_extract(kind: str):
    if kind not in te.EXTRACT:
        raise HTTPException(400, "kind must be one of " + ", ".join(te.EXTRACT))
    return _m("text.extract", kind=kind)


@app.get("/api/text/transforms")
def text_transforms():
    return te.TRANSFORMS


def _tparams(params):
    from .models.text import TRANSFORM_FIELDS
    keys = {f["k"] for f in TRANSFORM_FIELDS}
    return {k: v for k, v in (params or {}).items() if k in keys and k != "op"}


@app.post("/api/text/transform")
def text_transform(body: dict):
    op = body.get("op")
    if op not in te.TRANSFORMS:
        raise HTTPException(400, "unknown transform")
    if not (te.ACTIVE["c"] and te.ACTIVE["c"].ready):
        raise HTTPException(409, "no text loaded yet")
    return R.ui_job("text.transform", te.TRANSFORMS[op]["name"], op=op, **_tparams(body.get("params")))


@app.post("/api/text/undo")
def text_undo():
    if not (te.ACTIVE["c"] and te.ACTIVE["c"].ready):
        raise HTTPException(409, "no text loaded yet")
    return R.ui_job("text.undo", "undo")


@app.get("/api/text/preview")
def text_preview(op: str, params: str = "{}", n: int = 1400):
    """Before/after of the first n characters, computed on a small slice (instant)."""
    if op not in te.TRANSFORMS:
        raise HTTPException(400, "unknown transform")
    try:
        p = json.loads(params)
    except ValueError:
        raise HTTPException(400, "params must be JSON")
    return _m("text.transform.preview", op=op, n=max(50, min(n, 20000)), **_tparams(p))


@app.get("/api/text/download")
def text_download(v: int = -1):
    a = te.ACTIVE["c"]
    if not a or not a.ready:
        raise HTTPException(409, "no text loaded yet")
    ver = a.version if v < 0 else v
    return FileResponse(a.vpath(ver), media_type="text/plain; charset=utf-8",
                        filename="{}-v{}.txt".format((a.meta.get("name") or "corpus").replace(" ", "_")[:40], ver))


@app.get("/api/text/recipes")
def text_recipes():
    return _m("text.recipe.list")


@app.post("/api/text/recipes")
def text_recipe_save(body: dict):
    return _m("text.recipe.save", name=body.get("name") or None)


@app.delete("/api/text/recipes/{name}")
def text_recipe_delete(name: str):
    return _m("text.recipe.delete", name=name)


@app.post("/api/text/recipes/run")
def text_recipe_run(body: dict):
    from .models import text as mt
    name = body.get("name")
    if not mt._recipes().get(name):
        raise HTTPException(404, "no such recipe")
    return R.ui_job("text.recipe.run", "recipe " + str(name), name=name)


# ================================================================ forecast
def _engine_model(eid):
    from .models import sim as ms
    return ms.NAMES.get(eid, "forecast." + eid) if eid in forecast.SCENARIOS else "sim." + eid


def _engine_params(eid, params):
    spec = simulate.ENGINES[eid]["fields"] if eid in simulate.ENGINES else forecast.SCENARIOS[eid]["params"]
    keys = {f["k"] for f in spec}
    return {k: v for k, v in (params or {}).items() if k in keys and v is not None and v != ""}


@app.get("/api/forecast")
def fc_list():
    return [dict(id=k, **v) for k, v in forecast.SCENARIOS.items()]


@app.post("/api/forecast/{sid}")
def fc_run(sid: str, body: dict):
    if sid not in forecast.SCENARIOS:
        raise HTTPException(404, "no such scenario")
    try:
        return _m(_engine_model(sid), **_engine_params(sid, body.get("params")))
    except (R.ParamError, R.Refused):
        raise
    except ValueError as e:
        _bad(e)


# ---------------------------------------------------------------- general simulation
@app.get("/api/simulate")
def sim_engines():
    return _m("sim.engines")


@app.post("/api/simulate/{eid}")
def sim_run(eid: str, body: dict):
    if eid not in simulate.ENGINES and eid not in forecast.SCENARIOS:
        raise HTTPException(404, "no such engine")
    try:
        return _m(_engine_model(eid), **_engine_params(eid, body.get("params")))
    except (R.ParamError, R.Refused):
        raise
    except ValueError as e:
        _bad(e)


# ================================================================ fractals
@app.post("/api/samples/{kind}")
def sample_make(kind: str):
    """A ready-made table or clip (made once), so a first step works without your own files."""
    from . import samples
    try:
        return samples.ensure(kind)
    except ValueError as e:
        raise HTTPException(404, str(e))


@app.post("/api/fractal/supersede")
def fractal_supersede(sess: str = "", gen: int = 0):
    """The tab's view moved on: its older frames stop at their next chunk."""
    fractal.supersede(sess, gen)
    return {"ok": True}


@app.get("/api/fractal")
def fractal_img(kind: str = "mandelbrot", cx: str = "-0.5", cy: str = "0.0", scale: float = 3.2, w: int = 960, h: int = 640,
                iters: int = 0, palette: str = "rosso", jr: float = -0.8, ji: float = 0.156, density: float = 1.0,
                sess: str = "", gen: int = 0):
    if sess:
        fractal.supersede(sess, gen)
        key = str(sess)[:40]
        fractal._REQ.cancel = lambda: fractal._LATEST.get(key, 0) > gen
    try:
        return _fractal_frame(kind, cx, cy, scale, w, h, iters, palette, jr, ji, density)
    except fractal.Superseded:
        return Response(status_code=409, content=b"superseded by a newer view", headers={"Cache-Control": "no-store"})
    finally:
        fractal._REQ.cancel = None


def _fractal_frame(kind, cx, cy, scale, w, h, iters, palette, jr, ji, density):
    b = _m("fractal.render", kind=kind if kind in ("mandelbrot", "julia", "burning-ship", "tricorn") else "mandelbrot", cx=cx, cy=cy,
           scale=max(1e-300, min(scale, 10)), w=max(16, min(w, 7680)), h=max(16, min(h, 4320)), iters=max(0, min(iters, 100000)),
           palette=palette if palette in fractal.PALETTES else "rosso", jr=jr, ji=ji, density=max(0.05, min(density, 20)))
    return _blob(b, "X-Fractal")


@app.get("/api/fractal/tile")
def fractal_tile(kind: str = "mandelbrot", ax: str = "-0.5", ay: str = "0", z: int = 0, x: int = 0, y: int = 0, palette: str = "rosso",
                 density: float = 1.0, jr: float = -0.8, ji: float = 0.156, sess: str = "", gen: int = 0):
    """A 256 px tile (z/x/y from an exact anchor). Old tiles of a tab whose view has moved on are stopped (409)."""
    import json as _json
    if sess:
        key = str(sess)[:40]
        fractal._REQ.cancel = lambda: fractal._LATEST.get(key, 0) > gen + 3   # a few views of slack: tiles stay useful
    try:
        png, meta = fractal.tile(kind if kind in fractal.TYPES else "mandelbrot", ax[:200], ay[:200], max(0, min(z, 1000)), x, y,
                                 palette if palette in fractal.PALETTES else "rosso", max(0.05, min(density, 20)), jr, ji)
    except fractal.Superseded:
        return Response(status_code=409, content=b"superseded", headers={"Cache-Control": "no-store"})
    finally:
        fractal._REQ.cancel = None
    return Response(content=png, media_type="image/png", headers={"X-Fractal": _json.dumps(meta), "Cache-Control": "private, max-age=86400",
                                                                   "Access-Control-Expose-Headers": "X-Fractal"})


@app.get("/api/fractal/wallpaper")
def fractal_wall(kind: str = "mandelbrot", cx: str = "-0.5", cy: str = "0.0", scale: float = 3.2, palette: str = "rosso",
                 jr: float = -0.8, ji: float = 0.156, density: float = 1.0, w: int = 3840, h: int = 2160):
    b = _m("fractal.wallpaper", kind=kind if kind in ("mandelbrot", "julia", "burning-ship", "tricorn") else "mandelbrot", cx=cx, cy=cy,
           scale=max(1e-300, min(scale, 10)), palette=palette if palette in fractal.PALETTES else "rosso", jr=jr, ji=ji,
           density=max(0.05, min(density, 20)), w=max(16, min(w, 7680)), h=max(16, min(h, 4320)))
    return _blob(b, "X-Fractal", download=True)


@app.get("/api/fractal/places")
def fractal_places():
    return _m("fractal.places")


@app.post("/api/fractal/places")
def fractal_place_add(body: dict):
    return _m("fractal.place.add", **{k: body.get(k) for k in ("kind", "cx", "cy", "scale", "palette", "jr", "ji", "density", "name", "note") if body.get(k) is not None})


@app.patch("/api/fractal/places/{pid}")
def fractal_place_edit(pid: str, body: dict):
    return _m("fractal.place.edit", id=pid, name=body.get("name") or "", note=body.get("note") or "")


@app.delete("/api/fractal/places/{pid}")
def fractal_place_delete(pid: str):
    return _m("fractal.place.delete", id=pid)


@app.get("/api/fractal/places/{pid}/thumb")
def fractal_place_thumb(pid: str):
    from . import fractal_places as FP
    b = FP.thumb(pid)
    if not b:
        raise HTTPException(404, "no picture")
    return Response(content=b, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


@app.get("/api/fractal/region")
def fractal_region(kind: str = "mandelbrot", cx: str = "-0.5", cy: str = "0", scale: float = 3.2):
    return _m("fractal.region", kind=kind, cx=cx, cy=cy, scale=max(1e-300, min(scale, 10)))


@app.post("/api/fractal/visit")
def fractal_visit(body: dict):
    return _m("fractal.visit", kind=body.get("kind") or "mandelbrot", cx=str(body.get("cx") or "0"), cy=str(body.get("cy") or "0"),
              scale=max(1e-300, min(float(body.get("scale") or 3.2), 10)))


@app.get("/api/fractal/visits")
def fractal_visits(kind: str = "mandelbrot", cx: str = "-0.5", cy: str = "0", scale: float = 3.2):
    return _m("fractal.visits", kind=kind, cx=cx, cy=cy, scale=max(1e-300, min(scale, 10)))


@app.get("/api/fractal/kfr")
def fractal_kfr(kind: str = "mandelbrot", cx: str = "-0.5", cy: str = "0", scale: float = 3.2):
    r = _m("fractal.kfr", kind=kind, cx=cx, cy=cy, scale=max(1e-300, min(scale, 10)))
    txt = r["kfr"] if isinstance(r, dict) else r.result["kfr"]
    return Response(content=txt, media_type="text/plain", headers={"Content-Disposition": 'attachment; filename="vectorfall-place.kfr"'})


@app.post("/api/fractal/kfr")
def fractal_kfr_read(body: dict):
    return _m("fractal.kfr.read", text=str(body.get("text") or ""))


@app.get("/api/fractal/similar")
def fractal_similar(kind: str = "mandelbrot", cx: str = "-0.5", cy: str = "0", scale: float = 3.2, jr: float = -0.8, ji: float = 0.156):
    return _m("fractal.similar", kind=kind, cx=cx, cy=cy, scale=max(1e-300, min(scale, 10)), jr=jr, ji=ji)


@app.get("/api/fractal/search")
def fractal_search(q: str):
    return _m("fractal.search", q=q[:200])


@app.get("/api/fractal/cgr")
def fractal_cgr(suffix: str = "", depth: int = 2):
    return _m("fractal.cgr", suffix=suffix[:40], depth=max(1, min(depth, 2)))


@app.get("/api/fractal/dimension")
def fractal_dimension(photo: str):
    return _m("fractal.dimension", photo=photo)


@app.post("/api/fractal/compress")
def fractal_compress(body: dict):
    return _m("fractal.compress", photo=str(body.get("photo") or ""), start=str(body.get("start") or "noise"), mix=str(body.get("mix") or ""))


@app.post("/api/fractal/twins")
def fractal_twins(body: dict):
    return _m("fractal.twins", doc=int(body.get("doc", 0)), offset=max(0, int(body.get("offset") or 0)), text=str(body.get("text") or "")[:40000],
              k=max(1, min(10, int(body.get("k") or 1))), method="anchors" if body.get("method") == "anchors" else "exact")


@app.post("/api/fractal/guided")
def fractal_guided(body: dict):
    return _m("fractal.guided", doc=int(body.get("doc", 0)), offset=max(0, int(body.get("offset") or 0)), text=str(body.get("text") or "")[:40000],
              mode=body.get("mode") if body.get("mode") in ("fit", "match", "mean", "min") else "fit", window=max(3, min(40, int(body.get("window") or 12))),
              n=max(10, min(200, int(body.get("n") or 80))), seed=max(0, int(body.get("seed") or 0)))


@app.post("/api/fractal/lz")
def fractal_lz(body: dict):
    return _m("fractal.lz", doc=int(body.get("doc", 0)), offset=max(0, int(body.get("offset") or 0)), text=str(body.get("text") or "")[:40000])


@app.get("/api/fractal/palettes")
def fractal_palettes():
    return fractal.PALETTES


# ================================================================ console
@app.get("/api/console/harness")
def console_harness():
    """The source of the Console's harness, so the IDE can show exactly what Run adds around your code."""
    with open(os.path.join(os.path.dirname(console.__file__), "vfh.py"), encoding="utf-8") as f:
        return {"path": "/srv/app/vfh.py", "source": f.read()}


@app.get("/api/console/examples")
def console_examples():
    return console.EXAMPLES


@app.post("/api/console/run")
async def console_run(body: dict, request: Request):
    if not _local(request):
        raise HTTPException(403, "the Console only runs code for your own network")
    return await _thread(_m, "console.run", code=body.get("code") or "", timeout=max(1, min(600, int(body.get("timeout") or 60))),
                         name=body.get("name") or "")


@app.post("/api/console/start")
def console_start(body: dict, request: Request):
    if not _local(request):
        raise HTTPException(403, "the Console only runs code for your own network")
    return _m("console.start", code=body.get("code") or "", timeout=max(1, min(600, int(body.get("timeout") or 60))), name=body.get("name") or "")


@app.get("/api/console/poll")
def console_poll(run: str, since: int = 0):
    return _m("console.poll", run=run, since=since)


@app.post("/api/console/stop")
def console_stop():
    return _m("console.stop")


@app.get("/api/console/files")
def console_files():
    return console.list_files()


@app.get("/api/console/file")
def console_file_read(name: str):
    try:
        return {"name": name, "content": console.read_file(name)}
    except KeyError:
        raise HTTPException(404, "no such file")


@app.put("/api/console/file")
def console_file_write(body: dict):
    try:
        return console.write_file(body.get("name"), body.get("content"))
    except ValueError as e:
        _bad(e)


@app.delete("/api/console/file")
def console_file_delete(name: str):
    return console.delete_file(name)


@app.post("/api/console/rename")
def console_file_rename(body: dict):
    try:
        return console.rename_file(body.get("old"), body.get("new"))
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e))


@app.post("/api/console/shell")
async def console_shell(body: dict, request: Request):
    if not _local(request):
        raise HTTPException(403, "the terminal only runs for your own network")
    return await _thread(console.shell, body.get("cmd") or "", int(body.get("timeout") or 30))


# ================================================================ photo lab
@app.get("/api/photos")
def photos():
    return _m("photo.list")


@app.get("/api/photos/looks")
def photo_looks():
    return _m("photo.looks")


@app.post("/api/photos")
async def photo_upload(files: list = File(...)):
    out = []
    for f in files:
        data = await f.read()
        try:
            out.append(await _thread(_m, "photo.upload", file=data, filename=f.filename or "photo"))
        except Exception as e:  # noqa: BLE001
            out.append({"error": "{}: {}".format(f.filename, e)})
    return out


@app.get("/api/photos/clip/status")
def clip_status():
    return _m("photo.clip.status")


@app.post("/api/photos/clip/install")
def clip_install():
    return {"job": R.ui_job("photo.clip.install", "Photo Lab: get the CLIP model")["id"]}


@app.post("/api/photos/clip/index")
def clip_index():
    return {"job": R.ui_job("photo.clip.index", "Photo Lab: examine each photo")["id"]}


@app.post("/api/photos/clip/selftest")
def clip_selftest():
    return _m("photo.clip.selftest")


@app.get("/api/photos/clip/search")
def clip_search(q: str, top: int = 60):
    return _m("photo.clip.search", q=q, top=max(1, min(top, 300)))


@app.get("/api/photos/clip/like/{pid}")
def clip_like(pid: str, top: int = 60):
    return _m("photo.clip.like", photo=pid, top=max(1, min(top, 300)))


@app.get("/api/photos/clip/dupes")
def clip_dupes(threshold: float = 0.93):
    return _m("photo.clip.dupes", threshold=max(0.8, min(0.995, threshold)))


@app.get("/api/photos/{pid}/thumb")
def photo_thumb(pid: str):
    return FileResponse(media.photo_path(pid, "thumb.jpg"), media_type="image/jpeg")


def _photo_args(adj):
    """The UI's adj object -> the model's fields (look, amount, the sliders, crop)."""
    from .models.photo import photo_args
    return photo_args(adj)


# the Photo Lab's JSON models (edit, history, flags, Auto, looks, paste): one route, the same checks as /v1
_PHOTO_UI = {"edit", "edit.set", "edit.undo", "edit.redo", "edit.go", "edit.paste", "rate", "auto", "look.list", "look.save", "look.delete", "straighten"}


@app.post("/api/photos/m/{name}")
def photo_model(name: str, body: dict):
    if name not in _PHOTO_UI:
        raise HTTPException(404, "no Photo Lab model {}".format(name))
    try:
        return _m("photo." + name, **(body or {}))
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(400, str(e))


@app.post("/api/photos/{pid}/render")
def photo_render(pid: str, body: dict):
    full = bool(body.get("full"))
    b = _m("photo.develop", photo=pid, full=full, max=max(16, min(8000, int(body.get("max") or 1400))), saved=bool(body.get("saved")),
           draft=bool(body.get("draft")), **_photo_args(body.get("adj")))
    return _blob(b, "X-Photo", download=full, extra={} if not full else {"Content-Disposition": 'attachment; filename="vectorfall-{}.jpg"'.format(pid)})


@app.post("/api/photos/batch")
def photo_batch(body: dict):
    ids = body.get("ids") or []
    return R.ui_job("photo.batch", "export {} photos".format(len(ids) or body.get("only") or "all"), photos=ids,
                    only=body.get("only") or "all", saved=bool(body.get("saved")), **_photo_args(body.get("adj")))


@app.get("/api/photos/download/{name}")
def photo_zip(name: str):
    return FileResponse(os.path.join("/srv/data/photos", os.path.basename(name)), media_type="application/zip", filename=name)


@app.post("/api/photos/similar")
def photo_similar(body: dict):
    return _m("photo.similar", photos=body.get("ids") or [])


@app.delete("/api/photos/{pid}")
def photo_delete(pid: str):
    return _m("photo.delete", photo=pid)


# ================================================================ sound lab
@app.get("/api/sounds")
def sounds():
    return _m("sound.list")


@app.get("/api/sounds/fx")
def sound_fx():
    return _m("sound.effects")


@app.post("/api/sounds")
async def sound_upload(file: UploadFile = File(...)):
    data = await file.read()
    try:
        return await _thread(_m, "sound.upload", file=data, filename=file.filename or "sound")
    except (R.ParamError, R.Refused):
        raise
    except ValueError as e:
        _bad(e)


@app.get("/api/sounds/{sid}/view")
def sound_view(sid: str):
    return _m("sound.original", sound=sid)


@app.post("/api/sounds/{sid}/render")
def sound_render(sid: str, body: dict):
    return _m("sound.render", sound=sid, chain=body.get("chain") or [])


@app.get("/api/sounds/{sid}/current")
def sound_current(sid: str):
    return _m("sound.view", sound=sid)


@app.post("/api/sounds/{sid}/trim")
def sound_trim(sid: str, body: dict):
    return _m("sound.trim", sound=sid, op=body.get("op"), start=body.get("start"), end=body.get("end"))


@app.post("/api/sounds/{sid}/apply")
def sound_apply(sid: str, body: dict):
    if body.get("fx") not in media.FX:
        raise HTTPException(400, "unknown effect " + str(body.get("fx")))
    return _m("sound.apply", sound=sid, fx=body.get("fx"), params=body.get("params") or {}, start=body.get("start"), end=body.get("end"))


@app.get("/api/sounds/{sid}/marks")
def sound_marks(sid: str):
    return _m("sound.marks.get", sound=sid)


@app.put("/api/sounds/{sid}/marks")
def sound_marks_set(sid: str, body: dict):
    return _m("sound.marks.set", sound=sid, marks=body.get("marks") or [])


@app.post("/api/sounds/{sid}/find")
def sound_find(sid: str, body: dict):
    th = max(0.05, min(0.95, float(body.get("threshold", 0.5))))
    return {"job": R.ui_job("sound.find", "Sound Lab: find the sounds", sound=sid, threshold=th)["id"]}


@app.post("/api/sounds/{sid}/find/apply")
def sound_find_apply(sid: str, body: dict):
    th = max(0.05, min(0.95, float(body.get("threshold", 0.5))))
    return {"job": R.ui_job("sound.find.apply", "Sound Lab: find the sounds in another clip", model=str(body.get("model") or ""), sound=sid, threshold=th)["id"]}


@app.post("/api/sounds/{sid}/events/table")
def sound_events_table(sid: str, body: dict):
    return _m("sound.events.table", sound=sid, events=body.get("events") or [])


@app.post("/api/sounds/{sid}/events/reservoir")
def sound_events_reservoir(sid: str, body: dict):
    return _m("sound.events.reservoir", sound=sid, name=str(body.get("name") or ""), events=body.get("events") or [])


@app.post("/api/sounds/{sid}/events/mute")
def sound_events_mute(sid: str, body: dict):
    if not body.get("events"):
        _bad("no events to change")
    return _m("sound.events.mute", sound=sid, events=body["events"], how="mute" if (body.get("how") or "mute") == "mute" else "duck")


@app.post("/api/sounds/{sid}/undo")
def sound_undo(sid: str):
    return _m("sound.undo", sound=sid)


@app.post("/api/sounds/{sid}/redo")
def sound_redo(sid: str):
    return _m("sound.redo", sound=sid)


@app.delete("/api/sounds/{sid}")
def sound_delete(sid: str):
    return _m("sound.delete", sound=sid)


@app.post("/api/sounds/batch")
def sound_batch(body: dict):
    ids = body.get("ids") or []
    return R.ui_job("sound.batch", "process {} clips".format(len(ids)), sounds=ids, chain=body.get("chain") or [])


@app.get("/api/sounds/download/{name}")
def sound_zip(name: str):
    return FileResponse(os.path.join("/srv/data/sounds", os.path.basename(name)), media_type="application/zip", filename=name)


def _ranged_file(request, path, media_type, headers):
    """A file with HTTP Range support (206), so an <audio> element can stream and seek without the whole download."""
    size = os.path.getsize(path)
    hdr = dict(headers or {})
    hdr["Accept-Ranges"] = "bytes"
    rng = request.headers.get("range", "")
    if rng.startswith("bytes="):
        a, _, b = rng[6:].split(",")[0].strip().partition("-")
        try:
            if a == "":
                start, end = max(0, size - int(b)), size - 1
            else:
                start, end = int(a), (int(b) if b else size - 1)
        except ValueError:
            start = end = None
        if start is not None:
            end = min(end, size - 1)
            if start > end or start >= size:
                return Response(status_code=416, headers={"Content-Range": "bytes */%d" % size, "Accept-Ranges": "bytes"})

            def chunks(s=start, n=end - start + 1):
                with open(path, "rb") as f:
                    f.seek(s)
                    while n > 0:
                        c = f.read(min(1 << 16, n))
                        if not c:
                            break
                        n -= len(c)
                        yield c
            hdr.update({"Content-Range": "bytes %d-%d/%d" % (start, end, size), "Content-Length": str(end - start + 1)})
            return StreamingResponse(chunks(), status_code=206, media_type=media_type, headers=hdr)
    return FileResponse(path, media_type=media_type, headers=hdr)


@app.get("/api/sounds/{sid}/audio")
def sound_audio(sid: str, request: Request, which: str = "out", download: int = 0, fmt: str = "wav", start: float = None, end: float = None):
    """Served from disk with range support for the player (sound.audio is the same file for API callers)."""
    d = os.path.join("/srv/data/sounds", os.path.basename(sid))
    if which == "render":
        p = os.path.join(d, "render.wav")
        if not os.path.exists(p):
            raise HTTPException(404, "render this clip first")
        return _ranged_file(request, p, "audio/wav", {"Cache-Control": "no-store"})
    if which == "cur":                     # the current version, decided here, so the player never waits for the view
        try:
            which = "in" if json.load(open(os.path.join(d, "state.json"))).get("cur", 0) == 0 else "out"
        except Exception:  # noqa: BLE001
            which = "out"
    if which == "in" and not os.path.exists(os.path.join(d, "in.wav")):
        media.sound_write_in(sid)
    if which != "in" and not os.path.exists(os.path.join(d, "out.wav")):
        media.sound_current(sid)
    hdr = {"Cache-Control": "no-store"}
    if download:
        try:
            nm = json.load(open(os.path.join(d, "meta.json")))["name"].rsplit(".", 1)[0]
        except Exception:  # noqa: BLE001
            nm = "sound"
        hdr["Content-Disposition"] = 'attachment; filename="{}-edited.wav"'.format(nm.replace('"', ""))
    path = os.path.join(d, "in.wav" if which == "in" else "out.wav")
    if download and (fmt == "mp3" or start is not None):          # MP3 and/or just the selection, encoded on request
        args = ["ffmpeg", "-v", "error"] + (["-ss", "{:.3f}".format(max(0.0, start))] if start is not None else []) + ["-i", path]
        if start is not None and end is not None and end > start:
            args += ["-t", "{:.3f}".format(end - start)]
        args += (["-c:a", "libmp3lame", "-b:a", "192k", "-f", "mp3"] if fmt == "mp3" else ["-f", "wav"]) + ["-"]
        p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
        if p.returncode or not p.stdout:
            raise HTTPException(500, "encoding failed: " + p.stderr.decode("utf-8", "replace")[-200:])
        ext = "mp3" if fmt == "mp3" else "wav"
        if "Content-Disposition" in hdr:
            hdr["Content-Disposition"] = hdr["Content-Disposition"].replace(".wav\"", "{}.{}\"".format("-part" if start is not None else "", ext))
        return Response(p.stdout, media_type="audio/mpeg" if fmt == "mp3" else "audio/wav", headers=hdr)
    return _ranged_file(request, path, "audio/wav", hdr)


# ================================================================ data desk
@app.get("/api/tables")
def tables():
    return _m("data.list")


@app.post("/api/tables")
async def table_upload(file: UploadFile = File(...)):
    data = await file.read()
    try:
        return await _thread(_m, "data.upload", file=data, filename=file.filename or "table.csv")
    except (R.ParamError, R.Refused):
        raise
    except ValueError as e:
        _bad(e)


@app.delete("/api/tables/{tid}")
def table_delete(tid: str):
    try:
        return _m("data.delete", table=tid)
    except ValueError as e:
        raise HTTPException(404, str(e))


def _data(_model, **kw):
    try:
        return _m(_model, **kw)
    except (R.ParamError, R.Refused):
        raise
    except (ValueError, KeyError) as e:
        _bad(e)


@app.get("/api/tables/{tid}/summary")
def table_summary(tid: str):
    return _data("data.summary", table=tid)


@app.get("/api/tables/{tid}/pca")
def table_pca(tid: str, k: int = 4):
    return _data("data.pca", table=tid, k=max(2, min(k, 12)))


@app.get("/api/tables/{tid}/rows")
def table_rows(tid: str, sort: str = "", desc: int = 1, col: str = "", op: str = "=", val: str = "", offset: int = 0,
               limit: int = 100):
    return _data("data.rows", table=tid, sort=sort, desc=bool(desc), col=col, op=op if op in ("=", ">", "<", ">=", "<=", "!=", "contains") else "=",
                 val=val, offset=max(0, offset), limit=max(1, min(limit, 1000)))


@app.post("/api/tables/ticker")
def table_ticker(body: dict):
    return _data("data.ticker", ticker=str(body.get("ticker") or "") or None, years=max(1, min(40, int(body.get("years") or 10))))


@app.post("/api/tables/paste")
def table_paste(body: dict):
    return _data("data.paste", name=str(body.get("name") or "").strip(), text=str(body.get("text") or "") or None)


@app.get("/api/tables/{tid}/dates")
def table_dates(tid: str):
    return _data("data.dates", table=tid)


@app.get("/api/tables/{tid}/series")
def table_series(tid: str, cols: str, date_col: str = "auto"):
    """One or more numeric columns as plain lists (date-sorted when there is a date column) -- what Simulate and
    the Reservoir Lab read when you pick a Data Desk table as their input."""
    return _data("data.series", table=tid, cols=[c for c in cols.split("|") if c], date_col=date_col)


@app.get("/api/tables/{tid}/csv")
def table_csv(tid: str):
    """The whole table as CSV text (what the Planner's inputs read when you pick a Data Desk table)."""
    try:
        b = _m("data.csv", table=tid)
    except (R.ParamError, R.Refused):
        raise
    except (ValueError, KeyError, FileNotFoundError) as e:
        raise HTTPException(404, str(e))
    return Response(b.data, media_type="text/csv")


def _anom(body):
    return dict(cols=list(body.get("cols") or []), date_col=body.get("date_col") or "auto", label_col=body.get("label_col") or "",
                detector=body.get("detector") if body.get("detector") in ("rolling", "linear", "pattern") else "auto",
                threshold=max(0.5, min(50, float(body.get("threshold") or 5))))


@app.post("/api/tables/{tid}/anomalies")
def table_anomalies(tid: str, body: dict):
    return _data("data.anomalies", table=tid, **_anom(body))


@app.post("/api/tables/{tid}/anomalies/save")
def table_anomalies_save(tid: str, body: dict):
    return _data("data.anomalies.save", table=tid, **_anom(body))


@app.get("/api/tables/{tid}/group")
def table_group(tid: str, by: str, col: str = "", agg: str = "mean"):
    return _data("data.group", table=tid, by=by, col=col, agg=agg if agg in ("mean", "sum") else "count")


# ================================================================ planner (rosters, routes, teams -> the walk solver)
@app.get("/api/plan/examples")
def plan_examples():
    return _m("plan.examples")


@app.post("/api/plan/save")
def plan_save(body: dict):
    try:
        return _m("plan.save", name=str(body.get("name") or "plan"), table=body.get("table") or {})
    except (R.ParamError, R.Refused):
        raise
    except (ValueError, KeyError) as e:
        _bad(e)


@app.post("/api/plan/{kind}")
def plan_solve(kind: str, body: dict):
    if kind not in ("roster", "route", "teams"):
        raise HTTPException(404, "no such problem")
    m = R.get("plan." + kind)
    keys = {f["k"] for f in m.fields}
    return {"job": R.ui_job("plan." + kind, "Planner: " + kind, **{k: v for k, v in body.items() if k in keys})["id"]}


# ================================================================ life & patterns (live simulations), workbench nodes
@app.get("/api/nodes")
def catalog():
    cats = {}
    for n in engine.NODES.values():
        cats.setdefault(n["cat"], []).append({k: n[k] for k in ("id", "name", "in", "out", "params", "note", "cls")})
    return {"categories": cats}


@app.get("/api/sims")
def sim_list():
    return [{k: s[k] for k in ("id", "name", "desc", "params", "flops_hint")} for s in sims.SIMS.values()]


@app.websocket("/api/sim/{sid}")
async def sim_ws(ws: WebSocket, sid: str):
    await ws.accept()
    if sid not in sims.SIMS:
        await ws.send_json({"error": "unknown simulation"})
        await ws.close()
        return
    state = {"running": True, "iters": 1, "paint": []}
    try:
        init = await asyncio.wait_for(ws.receive_json(), 10)
        state["iters"] = int(init.get("iters", 1))
        runner = await _thread(sims.Runner, sid, init.get("params", {}))

        async def control():
            try:
                while True:
                    m = await ws.receive_json()
                    if "iters" in m:
                        state["iters"] = max(1, int(m["iters"]))
                    if m.get("paint"):
                        state["paint"].append(m["paint"])
                    if m.get("stop"):
                        state["running"] = False
            except Exception:  # noqa: BLE001  (client went away: end the loop quietly)
                state["running"] = False
        ctrl = asyncio.ensure_future(control())
        while state["running"]:
            if state["paint"]:
                strokes = state["paint"][:]
                del state["paint"][:]
                await _thread(runner.paint, strokes)
            out = await _thread(runner.tick, state["iters"])
            await ws.send_json(out)
            await asyncio.sleep(0.005)
        ctrl.cancel()
    except (WebSocketDisconnect, asyncio.TimeoutError, RuntimeError):
        pass
    except Exception as e:  # noqa: BLE001
        try:
            await ws.send_json({"error": str(e)[:200]})
        except Exception:  # noqa: BLE001
            pass


from . import lm as _lm  # noqa: E402
app.include_router(_lm.router, prefix="/api/text/lm")
from . import reservoir as _res  # noqa: E402
app.include_router(_res.router, prefix="/api/reservoir")
from . import lineage as _lin  # noqa: E402
app.include_router(_lin.router, prefix="/api/lineage")


from . import models as _models  # noqa: E402,F401   (registers every model)
from . import api_v1 as _v1  # noqa: E402
app.include_router(_v1.router)
from . import openai_compat as _oai  # noqa: E402   (the whole VectorLM as an OpenAI-compatible API)
app.include_router(_oai.router, prefix="/openai/v1")

app.mount("/", StaticFiles(directory="ui", html=True), name="ui")
