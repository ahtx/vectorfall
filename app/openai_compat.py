"""An OpenAI-compatible endpoint for VectorLM (app/vectorlm.py), a PROTOTYPE: retrieval + extraction over the corpus
on the card, not a complete LLM. Base URL: http://<host>:8092/openai/v1

  GET  /models                     vectorlm (the corpus on the card)
  POST /chat/completions           the last user message is the question; stream=true gives SSE (the answer is sent
                                   in pieces when it is final; keep-alive comments are sent while it works)
  POST /completions                legacy: prompt -> text

Extra (non-standard, optional) request fields: corpus (an id), top (passages to read), generate (bool).
The response carries the standard fields plus "vectorlm": {found, answer, sentence, doc, passage, kind, warning}.
Access: the LAN / trusted networks only; when VF_OPENAI_KEY (or /srv/data/vectorlm/openai_key) is set, a matching
"Authorization: Bearer <key>" is required too.
"""
import json
import os
import queue
import threading
import time
import uuid

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

router = APIRouter()
MODELS = {"vectorlm": "corpus"}
DIR = "/srv/data/vectorlm"


SETTINGS = DIR + "/openai_settings.json"
_SET = {"mtime": None, "data": None}
_DEFAULTS = {"enabled": True, "require_key": False, "key": ""}


def settings():
    """The endpoint settings (defaults when the file is missing or broken)."""
    try:
        mt = os.path.getmtime(SETTINGS)
    except OSError:
        return dict(_DEFAULTS)
    if _SET["mtime"] != mt:
        try:
            d = json.load(open(SETTINGS, encoding="utf-8"))
            _SET["data"] = dict(_DEFAULTS, **{k: d[k] for k in _DEFAULTS if k in d})
        except (OSError, ValueError):
            _SET["data"] = dict(_DEFAULTS)
        _SET["mtime"] = mt
    return dict(_SET["data"])


def _save_settings(d):
    os.makedirs(DIR, exist_ok=True)
    tmp = SETTINGS + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(d, fh)
    os.replace(tmp, SETTINGS)


def _key():
    st = settings()
    if st.get("require_key") and st.get("key"):
        return st["key"]
    k = os.environ.get("VF_OPENAI_KEY", "").strip()
    if not k:
        try:
            k = open(DIR + "/openai_key", encoding="utf-8").read().strip()
        except OSError:
            k = ""
    return k


def _deny(request):
    from .main import _local
    if not _local(request):
        return _err(403, "permission_error", "the VectorLM endpoint answers on the LAN / trusted networks only")
    if not settings().get("enabled", True):
        return _err(503, "service_unavailable", "the VectorLM endpoint is turned off in Vectorfall settings")
    k = _key()
    if k:
        h = request.headers.get("authorization", "")
        if h != "Bearer " + k:
            return _err(401, "invalid_api_key", "missing or wrong API key")
    return None


def _err(status, typ, msg):
    return JSONResponse({"error": {"message": msg, "type": typ, "param": None, "code": typ}}, status_code=status)


def _text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") in ("text", None))
    return ""


def _run(body, prompt):
    from . import registry as R
    p = {"prompt": prompt, "top": max(1, min(20, int(body.get("top") or 8))), "generate": bool(body.get("generate", False))}
    if body.get("corpus"):
        p["corpus"] = str(body["corpus"])
    out = R.call("text.vectorlm.ask", p, "openai")["result"]
    text = out.get("sentence") or ""
    if out.get("found") and out.get("span") and out["span"] != text:
        text = out["span"] + "\n\n" + text
    if out.get("found") and out.get("doc"):
        text += "\n\nSource: " + out["doc"]
    out["cleaned"] = text
    return out


def _meta(out):
    return {k: out.get(k) for k in ("found", "answer", "sentence", "kind", "doc", "byte", "passage", "confidence",
                                    "generated", "model", "warning", "ms")}


def _usage(prompt, text, out):
    pt = max(1, len(prompt.split()) * 4 // 3)
    ct = int(out.get("answer_tokens") or 0) or max(1, len(text.split()) * 4 // 3)
    return {"prompt_tokens": pt, "completion_tokens": ct, "total_tokens": pt + ct}


@router.get("/settings")
async def get_settings(request: Request):
    from .main import _local
    if not _local(request):
        return _err(403, "permission_error", "settings are for the LAN only")
    st = settings()
    legacy = bool(os.environ.get("VF_OPENAI_KEY", "").strip() or os.path.exists(DIR + "/openai_key"))
    return {"enabled": bool(st["enabled"]), "require_key": bool(st["require_key"]), "key": st.get("key") or "",
            "legacy_key": legacy}


@router.post("/settings")
async def post_settings(request: Request):
    """{enabled?, require_key?, new_key?: true}. A new key is made when asked, or when a key is required and none
    exists. Returns the new settings."""
    from .main import _local
    if not _local(request):
        return _err(403, "permission_error", "settings are for the LAN only")
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        body = {}
    st = settings()
    if "enabled" in body:
        st["enabled"] = bool(body["enabled"])
    if "require_key" in body:
        st["require_key"] = bool(body["require_key"])
    if body.get("new_key") or (st["require_key"] and not st.get("key")):
        import secrets
        st["key"] = "vlm-" + secrets.token_urlsafe(24)
    _save_settings(st)
    return await get_settings(request)


@router.get("/models")
def models(request: Request):
    d = _deny(request)
    if d:
        return d
    now = int(time.time())
    from .vectorlm import WARNING
    data = [{"id": k, "object": "model", "created": now, "owned_by": "vectorfall", "source_mode": v,
             "description": "VectorLM: answers from the corpus on the card. " + WARNING} for k, v in MODELS.items()]
    return {"object": "list", "data": data}


@router.post("/chat/completions")
async def chat(request: Request):
    d = _deny(request)
    if d:
        return d
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return _err(400, "invalid_request_error", "the body must be JSON")
    msgs = body.get("messages") or []
    users = [m for m in msgs if m.get("role") == "user"]
    if not users:
        return _err(400, "invalid_request_error", "messages must contain a user message")
    prompt = _text(users[-1].get("content")).strip()
    if not prompt:
        return _err(400, "invalid_request_error", "the last user message is empty")
    model = body.get("model") or "vectorlm"
    cid = "chatcmpl-" + uuid.uuid4().hex[:24]
    created = int(time.time())
    if not body.get("stream"):
        import asyncio
        loop = asyncio.get_event_loop()
        try:
            out = await loop.run_in_executor(None, _run, body, prompt)
        except ValueError as e:
            return _err(400, "invalid_request_error", str(e))
        except Exception as e:  # noqa: BLE001
            return _err(500, "server_error", str(e)[:300])
        text = out.get("cleaned") or out.get("answer") or ""
        return {"id": cid, "object": "chat.completion", "created": created, "model": model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                             "finish_reason": "stop"}],
                "usage": _usage(prompt, text, out), "vectorlm": _meta(out)}

    q = queue.Queue()

    def work():
        try:
            q.put(("done", _run(body, prompt)))
        except Exception as e:  # noqa: BLE001
            q.put(("error", str(e)[:300]))
    threading.Thread(target=work, daemon=True).start()

    def chunk(delta, finish=None, extra=None):
        c = {"id": cid, "object": "chat.completion.chunk", "created": created, "model": model,
             "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
        if extra:
            c.update(extra)
        return "data: " + json.dumps(c, ensure_ascii=False) + "\n\n"

    def gen():
        yield chunk({"role": "assistant", "content": ""})
        while True:
            try:
                kind, val = q.get(timeout=5.0)
            except queue.Empty:
                yield ": working\n\n"
                continue
            if kind == "error":
                yield chunk({"content": "[VectorLM error: %s]" % val}, "stop")
                break
            text = val.get("cleaned") or val.get("answer") or ""
            words = text.split(" ")
            for i in range(0, len(words), 6):
                yield chunk({"content": (" " if i else "") + " ".join(words[i:i + 6])})
            yield chunk({}, "stop", {"vectorlm": _meta(val), "usage": _usage(prompt, text, val)})
            break
        yield "data: [DONE]\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/completions")
async def completions(request: Request):
    d = _deny(request)
    if d:
        return d
    body = await request.json()
    prompt = body.get("prompt")
    if isinstance(prompt, list):
        prompt = prompt[0] if prompt else ""
    prompt = (prompt or "").strip()
    if not prompt:
        return _err(400, "invalid_request_error", "prompt is empty")
    import asyncio
    out = await asyncio.get_event_loop().run_in_executor(None, _run, body, prompt)
    text = out.get("cleaned") or out.get("answer") or ""
    return {"id": "cmpl-" + uuid.uuid4().hex[:24], "object": "text_completion", "created": int(time.time()),
            "model": body.get("model") or "vectorlm",
            "choices": [{"index": 0, "text": text, "finish_reason": "stop", "logprobs": None}],
            "usage": _usage(prompt, text, out), "vectorlm": _meta(out)}
