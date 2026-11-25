"""Host-side GPU ownership broker. Only explicitly configured containers may be stopped or started."""
import hashlib
import hmac
import json
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Busy(RuntimeError):
    pass


class Broker:
    def __init__(self, cfg, runner=None):
        self.cfg = cfg
        self.consumers = cfg["consumers"]
        self.default = cfg.get("default", "kindi")
        self.path = os.path.expanduser(cfg["state_file"])
        self.lock = threading.Lock()
        self.runner = runner or self._docker
        try:
            self.state = json.load(open(self.path))
        except (OSError, ValueError):
            self.state = {"owner": None, "expires": 0}

    def _docker(self, *args):
        p = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=30)
        if p.returncode:
            raise RuntimeError(p.stderr.strip()[-300:] or "docker command failed")
        return p.stdout.strip()

    def save(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.state, f)
        os.replace(tmp, self.path)

    def running(self, name):
        return self.runner("inspect", "-f", "{{.State.Running}}", self.consumers[name]["container"]) == "true"

    def wait_headroom(self):
        if not self.cfg.get("min_free_mb"):
            return
        deadline = time.time() + 30
        while True:
            out = subprocess.run(["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
                                 capture_output=True, text=True, timeout=5)
            free = int(out.stdout.splitlines()[self.cfg.get("gpu_index", 0)])
            if free >= self.cfg["min_free_mb"]:
                return
            if time.time() >= deadline:
                raise Busy(f"only {free} MiB is free; {self.cfg['min_free_mb']} MiB is required")
            time.sleep(0.2)

    def record(self, event, consumer):
        events = self.state.setdefault("events", [])
        events.append({"t": time.time(), "event": event, "consumer": consumer})
        del events[:-100]

    def clear(self, event, consumer):
        self.state.update(owner=None, expires=0)
        self.state.pop("transition", None)
        self.record(event, consumer)
        self.save()

    def start_default(self):
        if self.default and not self.running(self.default):
            self.runner("start", self.consumers[self.default]["container"])
            self.record("default_started", self.default)
            self.save()

    def tick(self):
        if not self.lock.acquire(blocking=False):
            return self.public()
        try:
            if self.state.get("owner") and self.state.get("expires", 0) <= time.time():
                self.clear("expired", self.state["owner"])
                self.start_default()
            return self.public()
        finally:
            self.lock.release()

    def public(self):
        state = dict(self.state)
        return {"owner": state.get("owner"), "transition": state.get("transition"), "expires": state.get("expires", 0),
                "events": state.get("events", [])[-20:],
                "consumers": {name: {"running": self.running(name)} for name in self.consumers}}

    def acquire(self, consumer, ttl_s):
        if consumer not in self.consumers:
            raise ValueError("unknown GPU consumer")
        with self.lock:
            if self.state.get("owner") and self.state["expires"] <= time.time():
                self.clear("expired", self.state["owner"])
                self.start_default()
            owner = self.state.get("owner")
            if owner and owner != consumer:
                raise Busy(f"GPU is leased to {owner}; retry after {max(1, round(self.state['expires'] - time.time()))}s")
            if owner != consumer:
                self.state["transition"] = consumer
                self.record("acquiring", consumer)
                self.save()
                try:
                    for name in self.consumers:
                        if name != consumer and self.running(name):
                            self.runner("stop", self.consumers[name]["container"])
                    self.wait_headroom()
                except Exception:
                    self.clear("acquire_failed", consumer)
                    self.start_default()
                    raise
                self.state.update(owner=consumer, expires=time.time() + ttl_s)
                self.state.pop("transition", None)
                self.record("acquired", consumer)
                self.save()
            else:
                self.state["expires"] = time.time() + ttl_s
                self.save()
            if consumer == self.default and not self.running(consumer):
                self.runner("start", self.consumers[consumer]["container"])
            return {"leased": True, "consumer": consumer, "expires": self.state["expires"]}

    def release(self, consumer):
        with self.lock:
            if self.state.get("owner") not in (None, consumer):
                raise Busy(f"GPU is leased to {self.state['owner']}")
            self.clear("released", consumer)
            self.start_default()
            return {"leased": False, "consumer": consumer}


def build(broker):
    def handle(msg):
        mid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
        if "id" not in msg:
            return None
        if method == "initialize":
            result = {"protocolVersion": params.get("protocolVersion", "2025-06-18"), "capabilities": {"tools": {}},
                      "serverInfo": {"name": "gpu-broker", "version": "1"}}
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": [
                {"name": "gpu_acquire", "description": "Lease the GPU for an allowed consumer", "inputSchema": {"type": "object", "required": ["consumer"], "properties": {"consumer": {"type": "string"}, "ttl_s": {"type": "integer"}}}},
                {"name": "gpu_release", "description": "Release a consumer's GPU lease", "inputSchema": {"type": "object", "required": ["consumer"], "properties": {"consumer": {"type": "string"}}}},
                {"name": "gpu_status", "description": "Current GPU owner and allowed consumers", "inputSchema": {"type": "object", "properties": {}}},
            ]}
        elif method == "tools/call":
            name, args = params.get("name", ""), params.get("arguments") or {}
            try:
                if name == "gpu_acquire":
                    out = broker.acquire(str(args.get("consumer")), max(1, min(int(args.get("ttl_s", 120)), 3600)))
                elif name == "gpu_release":
                    out = broker.release(str(args.get("consumer")))
                elif name == "gpu_status":
                    out = broker.tick()
                else:
                    return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "unknown tool"}}
                result = {"content": [{"type": "text", "text": json.dumps(out)}], "structuredContent": out}
            except Exception as ex:
                result = {"isError": True, "content": [{"type": "text", "text": str(ex)}]}
        else:
            return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "unknown method"}}
        return {"jsonrpc": "2.0", "id": mid, "result": result}
    return handle


def main():
    path = os.environ.get("VF_GPU_BROKER_CONFIG", "deploy/gpu-broker.json")
    with open(path) as f:
        cfg = json.load(f)
    broker = Broker(cfg)
    token = open(os.path.expanduser(cfg["token_file"])).read().strip()
    expected = hashlib.sha256(token.encode()).digest()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            supplied = self.headers.get("Authorization", "")
            if not supplied.startswith("Bearer ") or not hmac.compare_digest(hashlib.sha256(supplied[7:].strip().encode()).digest(), expected):
                self.send_response(401)
                self.end_headers()
                return
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                out = build(broker)(body)
                raw = json.dumps(out).encode() if out is not None else b""
                self.send_response(200 if out is not None else 202)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
            except Exception as ex:
                raw = json.dumps({"error": str(ex)}).encode()
                self.send_response(400)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        def log_message(self, *args):
            pass

    ThreadingHTTPServer((cfg.get("bind", "0.0.0.0"), int(cfg.get("port", 8790))), Handler).serve_forever()


if __name__ == "__main__":
    main()
