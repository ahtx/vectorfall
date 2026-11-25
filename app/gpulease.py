"""Optional MCP GPU lease used by the engine when it shares a card with another service."""
import json
import os
import threading
import time
import urllib.error
import urllib.request
from contextlib import contextmanager


class LeaseError(RuntimeError):
    pass


def configured():
    return bool(os.environ.get("VF_GPU_LEASE_URL"))


def call(name, args, timeout=30):
    url = os.environ["VF_GPU_LEASE_URL"].rstrip("/")
    token = ""
    path = os.environ.get("VF_GPU_LEASE_TOKEN_FILE")
    if path:
        with open(os.path.expanduser(path)) as f:
            token = f.read().strip()
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    msg = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}}
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=json.dumps(msg).encode(), headers=headers), timeout=timeout) as r:
            out = json.load(r).get("result") or {}
    except urllib.error.HTTPError as ex:
        raise LeaseError(f"GPU broker HTTP {ex.code}") from ex
    except Exception as ex:
        raise LeaseError(f"GPU broker unavailable: {type(ex).__name__}") from ex
    if out.get("isError"):
        raise LeaseError(" ".join(x.get("text", "") for x in out.get("content", [])))
    return out.get("structuredContent") or {}


_lock = threading.Lock()
_state = {"held_until": 0.0, "active": 0, "timer": None}


def _linger():
    return float(os.environ.get("VF_GPU_LEASE_LINGER_S", "20"))


def _release_if_idle():
    with _lock:
        if _state["active"] or not _state["held_until"]:
            return
        _state["held_until"], _state["timer"] = 0.0, None
    try:
        call("gpu_release", {"consumer": "vectorfall"})
    except LeaseError:
        pass


@contextmanager
def lease(timeout=120):
    """Hold the card for this call. The lease is kept for a short idle window afterwards
    (VF_GPU_LEASE_LINGER_S, default 20 s), so a job made of many short GPU calls (one per
    simulation frame) acquires once instead of stopping and restarting the other consumer per call."""
    if not configured():
        yield
        return
    ttl_s = max(30, min(int(timeout) + int(os.environ.get("VF_GPU_LEASE_GRACE_S", "150")), 7200))
    with _lock:
        if _state["timer"]:
            _state["timer"].cancel()
            _state["timer"] = None
        need = _state["held_until"] - time.time() < min(ttl_s, 60)
    if need:
        call("gpu_acquire", {"consumer": "vectorfall", "ttl_s": ttl_s})
        with _lock:
            _state["held_until"] = time.time() + ttl_s
    with _lock:
        _state["active"] += 1
    try:
        yield
    finally:
        with _lock:
            _state["active"] -= 1
            if not _state["active"]:
                t = threading.Timer(_linger(), _release_if_idle)
                t.daemon = True
                _state["timer"] = t
                t.start()
