#!/usr/bin/env python3
"""vf — run any Vectorfall model from the command line, as a load on the GPU.

  vf list [group]                       every model (or one group: text, photo, sound, data, sim, plan, …)
  vf describe <model>                   its parameters, types, defaults, ranges, and an example line
  vf run <model> [--param value …]      run it and print the result
        --param @file                   read a text value from a file (or upload it, for photo/sound/table inputs)
        --params-json '{…}' | @p.json   all parameters at once
        --out PATH                      write a binary result (image, audio) or the JSON result to a file
        --async                         start it as a background job and print the job id
        --json                          print the full JSON envelope (result + timing) instead of a summary
        --rpc                           send it as JSON-RPC 2.0 instead of REST (same result)
  vf job <id> [--wait]                  a background job's state (and result once done)
  vf test [model …] [--group g]         run each model with its example parameters; report GPU time per model
  vf openapi | vf openrpc               print the machine-readable API description

The server is $VF_URL (default http://localhost:8092). Every parameter is the same one the UI shows; the
server checks and converts them in one place, so the CLI, the UI, REST, JSON-RPC and MCP all run the same code.
Standard library only; works on Python 3.6+.
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

URL = os.environ.get("VF_URL", "http://localhost:8092").rstrip("/")


def http(method, path, body=None, raw=False, headers=None, timeout=900):
    data = None
    h = dict(headers or {})
    if body is not None and not isinstance(body, bytes):
        data = json.dumps(body).encode("utf-8")
        h.setdefault("Content-Type", "application/json")
    elif isinstance(body, bytes):
        data = body
    req = urllib.request.Request(URL + path, data=data, method=method, headers=h)
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        payload, ctype, hdrs = r.read(), r.headers.get("Content-Type", ""), r.headers
    except urllib.error.HTTPError as e:
        payload, ctype, hdrs = e.read(), e.headers.get("Content-Type", ""), e.headers
        try:
            err = json.loads(payload.decode("utf-8"))
            msg = err.get("error", {}).get("message") or err.get("detail") or payload[:300]
        except Exception:  # noqa: BLE001
            msg = payload[:300].decode("utf-8", "replace")
        die("{} ({} {})".format(msg, e.code, e.reason))
    except urllib.error.URLError as e:
        die("cannot reach {} ({}). Set VF_URL.".format(URL, e.reason))
    if raw:
        return payload, ctype, hdrs
    return json.loads(payload.decode("utf-8")) if payload else None


def die(msg, code=1):
    sys.stderr.write("vf: {}\n".format(msg))
    sys.exit(code)


def describe(name):
    return http("GET", "/v1/models/" + name)


# ---------------------------------------------------------------- parameters from the command line
UPLOAD = {"photo": ("/api/photos", "files"), "sound": ("/api/sounds", "file"), "table": ("/api/tables", "file")}


def upload(kind, path):
    """--photo @img.jpg: put the file on the server first, then pass its id."""
    route, field = UPLOAD[kind]
    with open(path, "rb") as f:
        data = f.read()
    bd = uuid.uuid4().hex
    crlf = "\r\n"
    head = ("--" + bd + crlf + 'Content-Disposition: form-data; name="' + field + '"; filename="' + os.path.basename(path) + '"' + crlf
            + "Content-Type: application/octet-stream" + crlf + crlf)
    body = head.encode("utf-8") + data + (crlf + "--" + bd + "--" + crlf).encode("utf-8")
    r = http("POST", route, body, headers={"Content-Type": "multipart/form-data; boundary=" + bd})
    r = r[0] if isinstance(r, list) else r
    if not isinstance(r, dict) or not r.get("id"):
        die("upload of {} failed: {}".format(path, r))
    sys.stderr.write("vf: uploaded {} as {} {}\n".format(path, kind, r["id"]))
    return r["id"]


def parse(m, argv):
    fields = {f["k"]: f for f in m["fields"]}
    params, opts, i = {}, {"out": None, "async": False, "json": False, "rpc": False}, 0
    while i < len(argv):
        a = argv[i]
        if a in ("--async", "--json", "--rpc"):
            opts[a[2:]] = True
            i += 1
            continue
        if a == "--out":
            opts["out"] = argv[i + 1]
            i += 2
            continue
        if a == "--params-json":
            v = argv[i + 1]
            params.update(json.loads(open(v[1:]).read() if v.startswith("@") else v))
            i += 2
            continue
        if not a.startswith("--"):
            die("unexpected {!r} — parameters are --name value (vf describe {})".format(a, m["name"]))
        k = a[2:]
        if "=" in k:
            k, v = k.split("=", 1)
            i += 1
        elif k.startswith("no-") and k[3:] in fields and fields[k[3:]].get("type") == "bool":
            params[k[3:]] = False
            i += 1
            continue
        elif k in fields and fields[k].get("type") == "bool" and (i + 1 >= len(argv) or argv[i + 1].startswith("--")):
            params[k] = True
            i += 1
            continue
        else:
            if i + 1 >= len(argv):
                die("--{} needs a value".format(k))
            v = argv[i + 1]
            i += 2
        k = k.replace("-", "_") if k not in fields and k.replace("-", "_") in fields else k
        if k not in fields:
            die("{} has no --{} (it takes: {})".format(m["name"], k, ", ".join("--" + x for x in fields) or "nothing"))
        t = fields[k].get("type")
        if v.startswith("@") and len(v) > 1:
            if t in UPLOAD:
                v = upload(t, v[1:])
            elif t == "file":
                v = base64.b64encode(open(v[1:], "rb").read()).decode("ascii")
            else:
                v = open(v[1:], encoding="utf-8").read()
        elif (t in UPLOAD or t == "file") and os.path.isfile(v):
            die("--{0} takes an id, or @path to send a file: --{0} @{1}".format(k, v))
        elif v == "-" and t in ("text", "str"):
            v = sys.stdin.read()
        elif t == "text":
            v = v.replace("\\n", "\n")
        params[k] = v
    return params, opts


# ---------------------------------------------------------------- printing results
def summary(env):
    r = env.get("result")
    t = env.get("timing") or {}
    lines = []
    if isinstance(r, dict):
        for k in ("headline", "sentence", "check", "verdict"):
            if isinstance(r.get(k), str) and r[k]:
                lines.append(r[k])
        small = {k: v for k, v in r.items() if k not in ("headline", "sentence", "check", "verdict") and _small(v)}
        for k, v in list(small.items())[:24]:
            lines.append("  {}: {}".format(k, v if not isinstance(v, float) else round(v, 6)))
        big = [k for k, v in r.items() if not _small(v) and k not in ("headline", "sentence", "check", "verdict")]
        if big:
            lines.append("  (also: {} — use --json or --out to see them)".format(", ".join(big)))
    elif isinstance(r, list):
        lines.append("{} items".format(len(r)))
        for x in r[:10]:
            lines.append("  " + json.dumps(x, ensure_ascii=False)[:160])
    else:
        lines.append(json.dumps(r, ensure_ascii=False)[:2000])
    lines.append("[{}: {} ms wall · {} ms on the GPU in {} runs]".format(env.get("model"), t.get("wall_ms"), t.get("gpu_ms"), t.get("gpu_runs")))
    return "\n".join(lines)


def _small(v):
    if isinstance(v, (int, float, bool, str)) or v is None:
        return len(str(v)) < 120
    if isinstance(v, list):
        return len(v) <= 8 and all(isinstance(x, (int, float, str)) for x in v)
    return False


def run(name, argv):
    m = describe(name)
    params, o = parse(m, argv)
    if o["async"]:
        r = http("POST", "/v1/models/{}?async=1".format(name), params)
        print(r["job"]["id"])
        return
    if o["rpc"]:
        r = http("POST", "/v1/rpc", {"jsonrpc": "2.0", "id": 1, "method": name, "params": params})
        if "error" in r:
            die("{}: {}".format(r["error"]["message"], r["error"].get("data", "")))
        env = r["result"]
    else:
        payload, ctype, hdrs = http("POST", "/v1/models/" + name, params, raw=True)
        if not ctype.startswith("application/json"):
            out = o["out"] or (hdrs.get("Content-Disposition", "").split('filename="')[-1].rstrip('"') if "filename=" in hdrs.get("Content-Disposition", "") else None) \
                or "{}.{}".format(name, ctype.split("/")[-1].split(";")[0])
            with open(out, "wb") as f:
                f.write(payload)
            t = json.loads(hdrs.get("X-VF-Timing") or "{}")
            print("wrote {} ({} bytes, {}) [{} ms wall · {} ms on the GPU]".format(out, len(payload), ctype, t.get("wall_ms"), t.get("gpu_ms")))
            meta = hdrs.get("X-VF-Meta")
            if meta and meta != "{}":
                print(meta)
            return
        env = json.loads(payload.decode("utf-8"))
    if o["out"]:
        res = env.get("result")
        if isinstance(res, dict) and "base64" in res and "media_type" in res:
            with open(o["out"], "wb") as f:
                f.write(base64.b64decode(res["base64"]))
        else:
            with open(o["out"], "w", encoding="utf-8") as f:
                json.dump(env, f, ensure_ascii=False, indent=1)
        print("wrote " + o["out"])
    print(json.dumps(env, ensure_ascii=False, indent=1) if o["json"] else summary(env))


def cmd_list(group=None):
    r = http("GET", "/v1/models" + ("?group=" + group if group else ""))
    cur = None
    for m in r["models"]:
        if m["group"] != cur:
            cur = m["group"]
            print("\n{} — {}".format(cur, r["groups"].get(cur, {}).get("title", "")))
        flag = (" [{}]".format(m["device"]) if m["device"] != "gpu" else "") + (" [changes data]" if m["mutating"] else "") + (" [job]" if m["long"] else "")
        print("  {:<30} {}{}".format(m["name"], m["title"], flag))
    print("\n{} models. vf describe <model> for its parameters.".format(len(r["models"])))


def cmd_describe(name):
    m = describe(name)
    print("{} — {}\n{}\nruns on: {}{}{}\n".format(m["name"], m["title"], m["summary"], m["device"],
                                                  " · changes stored data" if m["mutating"] else "", " · runs as a background job" if m["long"] else ""))
    for f in m["fields"]:
        t = f.get("type", "str")
        rng = " [{}..{}]".format(f.get("min", ""), f.get("max", "")) if "min" in f or "max" in f else ""
        ch = " {" + "|".join(map(str, f["choices"])) + "}" if f.get("choices") else ""
        d = f.get("default")
        ds = "" if d is None else " (default: {})".format(json.dumps(d) if not isinstance(d, str) else (d if len(d) < 50 and "\n" not in d else repr(d[:47] + "…")))
        req = " REQUIRED" if f.get("required") else ""
        print("  --{:<18} {}{}{}{}{}  {}".format(f["k"], t, ch, rng, ds, req, f.get("label", "")))
    print("\nexample:\n  " + m["cli"])


def cmd_job(jid, wait=False):
    while True:
        j = http("GET", "/v1/jobs/" + jid)
        if not wait or j["state"] != "running":
            break
        sys.stderr.write("\r{:>5.1f}%  {}".format(j["progress"] * 100, (j.get("message") or "")[:70].ljust(70)))
        time.sleep(1)
    if wait:
        sys.stderr.write("\n")
    if j["state"] == "done" and isinstance(j.get("result"), dict) and "model" in j["result"]:
        print(summary(j["result"]))
    else:
        print(json.dumps(j, ensure_ascii=False, indent=1))


def cmd_test(names, group=None):
    r = http("GET", "/v1/models" + ("?group=" + group if group else ""))
    todo = [m for m in r["models"] if (not names or m["name"] in names)]
    ok = bad = refused = 0
    print("{:<30} {:>6} {:>10} {:>10} {:>5}  {}".format("model", "result", "wall ms", "gpu ms", "runs", "note"))
    for m in todo:
        d = describe(m["name"])
        if d["mutating"] and not names:
            print("{:<30} {:>6}  (changes stored data — name it explicitly to test)".format(m["name"], "skip"))
            continue
        params = dict(d["example"])
        missing = []
        for f in d["fields"]:
            if f.get("required") and f["k"] not in params:
                if f["type"] in REFS and first_of(f["type"]):
                    params[f["k"]] = first_of(f["type"])
                else:
                    missing.append(f["k"])
        if missing:
            print("{:<30} {:>6}  (needs your input: --{})".format(m["name"], "skip", " --".join(missing)))
            continue
        t0 = time.time()
        req = urllib.request.Request(URL + "/v1/models/" + m["name"], data=json.dumps(params).encode("utf-8"), method="POST",
                                     headers={"Content-Type": "application/json"})
        try:
            r = urllib.request.urlopen(req, timeout=900)
            payload, ctype, hdrs = r.read(), r.headers.get("Content-Type", ""), r.headers
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read().decode("utf-8"))["error"]["message"]
            except Exception:  # noqa: BLE001
                msg = e.reason
            if e.code < 500:              # the model answered: these inputs don't suit it (no marks, no numeric columns…)
                refused += 1
                print("{:<30} {:>6} {:>10.0f}  {}".format(m["name"], "refuse", (time.time() - t0) * 1000, str(msg)[:90]))
            else:
                bad += 1
                print("{:<30} {:>6} {:>10.0f}  {}".format(m["name"], "FAIL", (time.time() - t0) * 1000, str(msg)[:90]))
            sys.stdout.flush()
            continue
        t = json.loads(hdrs.get("X-VF-Timing") or "{}") if not ctype.startswith("application/json") else json.loads(payload.decode("utf-8"))["timing"]
        note = ctype.split(";")[0] if not ctype.startswith("application/json") else ""
        if d["device"] == "gpu" and not t.get("gpu_runs"):
            note = (note + (" GPU work in its own process (not timed here)" if not d.get("gpu_timed", True)
                            else " no GPU run this call (cached result?)")).strip()
        print("{:<30} {:>6} {:>10} {:>10} {:>5}  {}".format(m["name"], "ok", t.get("wall_ms"), t.get("gpu_ms"), t.get("gpu_runs"), note))
        sys.stdout.flush()
        ok += 1
    print("\n{} ok, {} refused their test inputs, {} failed".format(ok, refused, bad))
    sys.exit(1 if bad else 0)


def main(argv):
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(__doc__)
        return
    c, rest = argv[0], argv[1:]
    if c == "list":
        cmd_list(rest[0] if rest else None)
    elif c == "describe" and rest:
        cmd_describe(rest[0])
    elif c == "run" and rest:
        if len(rest) > 1 and rest[1] in ("-h", "--help"):
            cmd_describe(rest[0])
        else:
            run(rest[0], rest[1:])
    elif c == "job" and rest:
        cmd_job(rest[0], "--wait" in rest)
    elif c == "test":
        g = rest[rest.index("--group") + 1] if "--group" in rest else None
        cmd_test([x for x in rest if not x.startswith("--") and x != g], g)
    elif c == "openapi":
        print(json.dumps(http("GET", "/v1/openapi.json"), indent=1))
    elif c == "openrpc":
        print(json.dumps(http("GET", "/v1/openrpc.json"), indent=1))
    elif "." in c:                                   # `vf sim.budget --budget 1` works too
        run(c, rest)
    else:
        die("unknown command {!r} (vf help)".format(c))


REFS = {"table": "data.list", "photo": "photo.list", "sound": "sound.list", "corpus": "text.corpus.list", "project": "reservoir.list"}
_FIRST = {}


def first_of(kind):
    """vf test fills a required reference with the first one the server has (the newest table, photo, clip…)."""
    if kind not in _FIRST:
        r = http("POST", "/v1/models/" + REFS[kind], {})["result"]
        _FIRST[kind] = (r[0]["id"] if r else None)
    return _FIRST[kind]


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except BrokenPipeError:
        sys.stderr.close()
    except KeyboardInterrupt:
        sys.exit(130)
