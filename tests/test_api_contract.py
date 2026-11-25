"""API and MCP contract test, run against a live VectorFall server.

    VF_URL=http://localhost:8092 python3 tests/test_api_contract.py        # standard library only
    VF_URL=http://localhost:8092 python3 -m pytest tests/test_api_contract.py

It checks the four ways in to the model registry: REST /v1 (with the OpenAPI document), JSON-RPC 2.0 /v1/rpc (with
OpenRPC), MCP /mcp (streamable HTTP) and the `vf` command-line client (downloaded from /v1/cli). It only runs models
that do not change stored data.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

URL = os.environ.get("VF_URL", "http://localhost:8092").rstrip("/")
# small models with example parameters: one CPU model, two GPU models (JSON results) and one binary (PNG) result
CPU_MODEL, GPU_MODELS, PNG_MODEL = "machine.occupancy", ("forecast.birthday", "sim.finance"), "life.monte_carlo_pi"


def http(method, path, body=None, headers=None, raw=None, timeout=300):
    h = {"Content-Type": "application/json"}
    h.update(headers or {})
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(URL + path, data=data, method=method, headers=h)
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def jget(path):
    st, _, b = http("GET", path)
    assert st == 200, (path, st, b[:300])
    return json.loads(b.decode())


def jpost(path, body, **kw):
    st, h, b = http("POST", path, body, **kw)
    return st, h, (json.loads(b.decode()) if b and h.get("Content-Type", "").startswith("application/json") else b)


_MODELS = None


def models():
    global _MODELS
    if _MODELS is None:
        _MODELS = jget("/v1/models")["models"]
    return _MODELS


# ---------------------------------------------------------------- REST
def test_version():
    v = jget("/api/version")
    assert re.match(r"^\d+\.\d+\.\d+", v["version"]) or v["version"] == "dev", v
    assert v["api"] and v["models"] == len(models())
    assert "card" in v and "uptime_s" in v


def test_index_links():
    d = jget("/v1")
    for k in ("models", "openapi", "openrpc", "rpc", "mcp", "docs", "cli"):
        assert k in d["links"], k
    assert d["models"] == len(models())


def test_model_list_and_describe():
    ms = models()
    assert len(ms) > 50
    names = [m["name"] for m in ms]
    assert len(names) == len(set(names)), "duplicate model names"
    for m in ms:
        for k in ("name", "title", "group", "device", "mutating", "output"):
            assert k in m, (m.get("name"), k)
    g = jget("/v1/models?group=sim")["models"]
    assert g and all(m["name"].startswith("sim.") or m["group"] == "sim" for m in g)
    for n in (CPU_MODEL, PNG_MODEL) + GPU_MODELS:
        d = jget("/v1/models/" + n)
        assert d["name"] == n and "fields" in d and "example" in d, n
    st, _, b = http("GET", "/v1/models/no.such.model")
    assert st == 404 and json.loads(b)["error"]["kind"] == "unknown_model"


def _refs(o, out):
    if isinstance(o, dict):
        for k, v in o.items():
            if k == "$ref":
                out.add(v)
            else:
                _refs(v, out)
    elif isinstance(o, list):
        for v in o:
            _refs(v, out)
    return out


def test_openapi():
    d = jget("/v1/openapi.json")
    assert d["openapi"].startswith("3.1")
    model_paths = [p for p in d["paths"] if p.startswith("/v1/models/")]
    assert len(model_paths) == len(models())
    ops = [op["operationId"] for p in d["paths"].values() for op in p.values()]
    assert len(ops) == len(set(ops)), "operationId must be unique"
    schemas = d["components"]["schemas"]
    for ref in _refs(d, set()):
        assert ref.startswith("#/components/schemas/") and ref.split("/")[-1] in schemas, ref
    st, h, b = http("GET", "/v1/docs")
    assert st == 200 and b"swagger" in b.lower()


def test_rest_calls():
    st, _, r = jpost("/v1/models/" + CPU_MODEL, {"threads": 256})
    assert st == 200 and r["model"] == CPU_MODEL and "timing" in r, r
    for n in GPU_MODELS:
        st, _, r = jpost("/v1/models/" + n, {})
        assert st == 200, (n, st, r)
        assert r["model"] == n and r["result"] is not None and "wall_ms" in r["timing"], (n, r)
    # binary result: PNG bytes by default, base64 JSON with ?json=1
    st, h, b = http("POST", "/v1/models/" + PNG_MODEL, {"ticks": 3})
    assert st == 200 and h["Content-Type"].startswith("image/png") and b[:8] == b"\x89PNG\r\n\x1a\n", (st, h.get("Content-Type"))
    assert "X-VF-Timing" in h
    st, _, r = jpost("/v1/models/" + PNG_MODEL + "?json=1", {"ticks": 3})
    assert st == 200 and r["result"].get("base64"), st


def test_rest_errors():
    st, _, r = jpost("/v1/models/no.such.model", {})
    assert st == 404 and r["error"]["kind"] == "unknown_model"
    st, _, r = jpost("/v1/models/" + CPU_MODEL, {"threads": "many"})
    assert st == 422 and r["error"]["kind"] == "bad_params", (st, r)
    st, _, b = http("POST", "/v1/models/" + CPU_MODEL, raw=b"{not json")
    assert st == 400 and json.loads(b)["error"]["kind"] == "bad_json"
    st, _, b = http("POST", "/v1/models/" + CPU_MODEL, raw=b"[1,2]")
    assert st == 400


def test_rest_async_job():
    st, _, r = jpost("/v1/models/" + GPU_MODELS[0] + "?async=1", {})
    assert st == 202 and r["job"]["id"], (st, r)
    jid = r["job"]["id"]
    t0 = time.time()
    while time.time() - t0 < 120:
        j = jget("/v1/jobs/" + jid)
        if j["state"] != "running":
            break
        time.sleep(0.5)
    assert j["state"] == "done", j
    st, _, b = http("GET", "/v1/jobs/no-such-job")
    assert st == 404


# ---------------------------------------------------------------- JSON-RPC 2.0
def rpc(body):
    st, h, r = jpost("/v1/rpc", body)
    return st, r


def test_rpc_discover():
    st, r = rpc({"jsonrpc": "2.0", "id": 1, "method": "rpc.discover"})
    assert st == 200 and r["id"] == 1
    doc = r["result"]
    assert doc["openrpc"].startswith("1.") and len(doc["methods"]) == len(models()) + 2
    assert jget("/v1/openrpc.json")["methods"][0]["name"] == doc["methods"][0]["name"]


def test_rpc_calls_and_errors():
    st, r = rpc({"jsonrpc": "2.0", "id": "a", "method": GPU_MODELS[1], "params": {}})
    assert st == 200 and r["id"] == "a" and r["result"]["model"] == GPU_MODELS[1], r
    st, r = rpc({"jsonrpc": "2.0", "id": 2, "method": "no.such.model"})
    assert r["error"]["code"] == -32601
    st, r = rpc({"jsonrpc": "2.0", "id": 3, "method": CPU_MODEL, "params": [1]})
    assert r["error"]["code"] == -32602
    st, r = rpc({"jsonrpc": "2.0", "id": 4, "method": CPU_MODEL, "params": {"threads": "many"}})
    assert r["error"]["code"] == -32602
    st, r = rpc({"id": 5, "method": CPU_MODEL})
    assert r["error"]["code"] == -32600
    st, _, b = http("POST", "/v1/rpc", raw=b"{oops")
    assert json.loads(b)["error"]["code"] == -32700
    # a batch: the notification (no id) gets no answer
    st, r = rpc([{"jsonrpc": "2.0", "id": 10, "method": CPU_MODEL, "params": {}},
                 {"jsonrpc": "2.0", "method": CPU_MODEL, "params": {}},
                 {"jsonrpc": "2.0", "id": 11, "method": "no.such.model"}])
    assert st == 200 and sorted(x["id"] for x in r) == [10, 11]
    st, _, b = http("POST", "/v1/rpc", {"jsonrpc": "2.0", "method": CPU_MODEL, "params": {}})
    assert st == 204 and not b
    st, r = rpc({"jsonrpc": "2.0", "id": 12, "method": "vf.start", "params": {"model": CPU_MODEL, "params": {}}})
    jid = r["result"]["id"]
    st, r = rpc({"jsonrpc": "2.0", "id": 13, "method": "vf.job", "params": {"id": jid}})
    assert r["result"]["id"] == jid


# ---------------------------------------------------------------- MCP (streamable HTTP)
MCP_H = {"Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18"}


def mcp(body, q=""):
    st, h, b = http("POST", "/mcp" + q, body, headers=MCP_H)
    ct = h.get("Content-Type", "")
    if ct.startswith("text/event-stream"):          # a server may answer with SSE; take the last data line
        b = [l[5:] for l in b.decode().splitlines() if l.startswith("data:")][-1].encode()
    return st, (json.loads(b.decode()) if b else None)


def test_mcp_session():
    st, r = mcp({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "contract-test", "version": "1"}}})
    assert st == 200 and r["result"]["protocolVersion"] == "2025-06-18", r
    assert r["result"]["serverInfo"]["name"] and "tools" in r["result"]["capabilities"]
    st, r = mcp({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "1999-01-01"}})
    assert r["result"]["protocolVersion"] != "1999-01-01"        # the server offers a version it supports
    st, r = mcp({"jsonrpc": "2.0", "method": "notifications/initialized"})
    assert st == 202 and r is None
    st, r = mcp({"jsonrpc": "2.0", "id": 2, "method": "ping"})
    assert r["result"] == {}
    st, r = mcp({"jsonrpc": "2.0", "id": 3, "method": "no/such"})
    assert r["error"]["code"] == -32601
    st, _, _ = http("GET", "/mcp", headers={"Accept": "text/event-stream"})
    assert st == 405


def test_mcp_tools():
    st, r = mcp({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    tools = r["result"]["tools"]
    assert len(tools) == len(models()) + 2
    for t in tools:
        assert re.match(r"^[A-Za-z0-9_-]{1,128}$", t["name"]), t["name"]
        assert t["inputSchema"]["type"] == "object" and t.get("description")
    names = {t["name"] for t in tools}
    assert len(names) == len(tools), "duplicate tool names"
    tool = GPU_MODELS[0].replace(".", "_")
    st, r = mcp({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": tool, "arguments": {}}})
    res = r["result"]
    assert not res.get("isError") and res["content"][0]["type"] == "text", res
    assert json.loads(res["content"][0]["text"])["result"] is not None and "structuredContent" in res
    st, r = mcp({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": PNG_MODEL.replace(".", "_"), "arguments": {"ticks": 3}}})
    assert r["result"]["content"][0]["type"] == "image" and r["result"]["content"][0]["mimeType"] == "image/png"
    st, r = mcp({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "no_such_tool", "arguments": {}}})
    assert r["result"]["isError"] is True
    st, r = mcp({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "vf_start", "arguments": {"model": CPU_MODEL.replace(".", "_")}}})
    jid = r["result"]["structuredContent"]["id"]
    st, r = mcp({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "vf_job", "arguments": {"id": jid}}})
    assert r["result"]["structuredContent"]["id"] == jid
    st, r = mcp([{"jsonrpc": "2.0", "id": 7, "method": "ping"}, {"jsonrpc": "2.0", "method": "notifications/initialized"}, 5])
    assert isinstance(r, list) and [x.get("id") for x in r] == [7, None]


# ---------------------------------------------------------------- the vf command-line client
def test_mcp_prompts_resources():
    st, r = mcp({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}}})
    caps = r["result"]["capabilities"]
    assert "prompts" in caps and "resources" in caps, caps
    st, r = mcp({"jsonrpc": "2.0", "id": 2, "method": "prompts/list"})
    prompts = r["result"]["prompts"]
    assert prompts and all(p["name"] and p.get("description") for p in prompts)
    for p in prompts:
        st, g = mcp({"jsonrpc": "2.0", "id": 3, "method": "prompts/get", "params": {"name": p["name"], "arguments": {}}})
        m = g["result"]["messages"]
        assert m and m[0]["role"] == "user" and m[0]["content"]["type"] == "text" and len(m[0]["content"]["text"]) > 40, g
    st, r = mcp({"jsonrpc": "2.0", "id": 4, "method": "prompts/get", "params": {"name": "no-such-prompt"}})
    assert r["error"]["code"] == -32602
    st, r = mcp({"jsonrpc": "2.0", "id": 5, "method": "resources/list"})
    res = r["result"]["resources"]
    assert res and all(x["uri"].startswith("vectorfall://") and x["name"] for x in res)
    st, r = mcp({"jsonrpc": "2.0", "id": 6, "method": "resources/templates/list"})
    assert any("{" in t["uriTemplate"] for t in r["result"]["resourceTemplates"])
    for uri in (res[0]["uri"], next(x["uri"] for x in res if "/template/" in x["uri"]), next(x["uri"] for x in res if "/format/" in x["uri"])):
        st, rr = mcp({"jsonrpc": "2.0", "id": 7, "method": "resources/read", "params": {"uri": uri}})
        c = rr["result"]["contents"][0]
        assert c["uri"] == uri and c["text"], rr
    st, r = mcp({"jsonrpc": "2.0", "id": 8, "method": "resources/read", "params": {"uri": "vectorfall://nothing"}})
    assert r["error"]["code"] == -32602


def test_mcp_solver_tools():
    st, r = mcp({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    tools = {t["name"]: t for t in r["result"]["tools"]}
    for n in ("plan_route", "plan_check", "problem_solve"):
        assert tools[n].get("outputSchema", {}).get("type") == "object", n
    bad = "from,A,B,C\nA,0,1\nB,1,0,2\nC,1,2,0"
    st, r = mcp({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "plan_check", "arguments": {"kind": "route", "costs": bad}}})
    sc = r["result"]["structuredContent"]["result"]
    assert sc["ok"] is False and sc["error"].startswith("line 2"), sc
    good = "from,Depot,A,B,C\nDepot,0,12,7,20\nA,14,0,5,9\nB,7,6,0,11\nC,22,9,10,0"
    st, r = mcp({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "plan_route", "arguments": {"costs": good, "unit": "min", "effort": "quick"}}})
    out = r["result"]["structuredContent"]["result"]
    assert out["headline"] and out["explain"] and out["compare"]["exact"] is not None and out["length"] <= out["compare"]["nearest"] + 1e-9, out
    assert abs(out["length"] - out["compare"]["exact"]) < 1e-6        # 5 stops: the exact optimum is known
    st, r = mcp({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "problem_templates", "arguments": {}}})
    assert len(r["result"]["structuredContent"]["result"]["templates"]) >= 8


def test_mcp_tool_sets():
    st, r = mcp({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, "?tools=plan,problem_solve")
    names = {t["name"] for t in r["result"]["tools"]}
    assert "plan_route" in names and "problem_solve" in names and "vf_job" in names, names
    assert not any(n.startswith(("sound_", "text_", "problem_templates")) for n in names), names
    st, r = mcp({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "machine_occupancy", "arguments": {}}}, "?tools=plan")
    assert r["result"].get("isError") and "tool set" in r["result"]["content"][0]["text"], r
    for call in (
        {"name": "vf_start", "arguments": {"model": "machine_occupancy"}},
        {"name": "vf_run", "arguments": {"tool": "machine_occupancy"}},
        {"name": "vf_find", "arguments": {"query": "occupancy"}},
    ):
        _, r = mcp({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": call}, "?tools=plan")
        assert r["result"].get("isError") and "tool set" in r["result"]["content"][0]["text"], r
    st, r = mcp({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "plan_route", "arguments": {
        "costs": "from,Depot,A,B\nDepot,0,5,7\nA,5,0,3\nB,7,3,0", "effort": "quick"}}}, "?tools=plan")
    text = json.loads(r["result"]["content"][0]["text"])["result"]
    assert "chart" not in json.dumps(text) and r["result"]["structuredContent"]["result"]["length"] == text["length"], text
    # compact schemas by default, the form labels with ?full=1
    st, small = mcp({"jsonrpc": "2.0", "id": 4, "method": "tools/list"})
    st, big = mcp({"jsonrpc": "2.0", "id": 5, "method": "tools/list"}, "?full=1")
    assert len(json.dumps(small)) < 0.85 * len(json.dumps(big)), (len(json.dumps(small)), len(json.dumps(big)))
    assert big["result"]["tools"][0].get("title") and len(small["result"]["tools"]) == len(big["result"]["tools"])
    # ?tools=discover: groups -> tools of a group (or a search) -> schemas -> run
    D = "?tools=discover"
    st, r = mcp({"jsonrpc": "2.0", "id": 6, "method": "tools/list"}, D)
    assert {t["name"] for t in r["result"]["tools"]} == {"vf_groups", "vf_tools", "vf_find", "vf_describe", "vf_run", "vf_start", "vf_job"}
    st, r = mcp({"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": "vf_groups", "arguments": {}}}, D)
    groups = {g["group"]: g["tools"] for g in r["result"]["structuredContent"]["groups"]}
    assert sum(groups.values()) == len(models()) and "plan" in groups, groups
    st, r = mcp({"jsonrpc": "2.0", "id": 10, "method": "tools/call", "params": {"name": "vf_tools", "arguments": {"group": "plan"}}}, D)
    assert "plan_route" in [t["name"] for t in r["result"]["structuredContent"]["tools"]], r
    st, r = mcp({"jsonrpc": "2.0", "id": 11, "method": "tools/call", "params": {"name": "vf_tools", "arguments": {"group": "nope"}}}, D)
    assert r["result"]["isError"] and "plan" in r["result"]["content"][0]["text"], r
    st, r = mcp({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "vf_find", "arguments": {"query": "visit order route"}}}, "?tools=find")
    matches = {t["name"]: t for t in r["result"]["structuredContent"]["tools"]}
    assert matches["plan_route"]["inputSchema"]["properties"].get("costs"), r
    _, r = mcp({"jsonrpc": "2.0", "id": 7, "method": "tools/list"}, "?tools=find")
    assert {t["name"] for t in r["result"]["tools"]} == {"vf_find", "vf_run", "vf_start", "vf_job"}
    _, r = mcp({"jsonrpc": "2.0", "id": 7, "method": "tools/call",
                "params": {"name": "vf_find", "arguments": {"query": "visit order route"}}}, D)
    matches = {t["name"]: t for t in r["result"]["structuredContent"]["tools"]}
    assert set(matches["plan_route"]) == {"name", "about"}, r
    st, r = mcp({"jsonrpc": "2.0", "id": 12, "method": "tools/call", "params": {"name": "vf_describe", "arguments": {"tools": ["plan_route", "nope"]}}}, D)
    sc = r["result"]["structuredContent"]
    assert sc["tools"][0]["inputSchema"]["properties"].get("costs") and sc["unknown"] == ["nope"], sc
    st, r = mcp({"jsonrpc": "2.0", "id": 13, "method": "tools/call", "params": {"name": "vf_run", "arguments": {"tool": "plan_route", "arguments": {"effort": "bogus"}}}}, D)
    assert r["result"]["isError"] and "schema:" in r["result"]["content"][0]["text"], r
    st, r = mcp({"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {"name": "vf_run", "arguments": {"tool": "plan_route", "arguments": {
        "costs": "from,Depot,A,B\nDepot,0,5,7\nA,5,0,3\nB,7,3,0", "effort": "quick"}}}}, "?tools=find")
    assert r["result"]["structuredContent"]["result"]["length"] == 15, r


def test_lab_problems():
    st, r = mcp({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "problem_check", "arguments": {
        "kind": "group", "text": "date,A,B,C\n2020,1,2,3\n2021,1,x,3\n2022,1,2,3\n2023,1,2,3"}}})
    c = r["result"]["structuredContent"]["result"]
    assert c["ok"] is False and c["error"].startswith("line 3"), c
    st, r = mcp({"jsonrpc": "2.0", "id": 2, "method": "prompts/list"})
    names = {p["name"] for p in r["result"]["prompts"]}
    assert {"series-updown", "classify-recordings", "group-change"} <= names, names
    st, r = mcp({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "reservoir_classify", "arguments": {}}})
    out = r["result"]["structuredContent"]["result"]
    assert out["headline"] and out["compare_text"] and out["explain"] and out["project"] is None, out
    assert len(out["labelled"]) == 3


def test_console_stream():
    st, h, b = http("POST", "/v1/models/console.start", {"code": "import time\nfor i in range(3):\n    print(i)\n    time.sleep(0.6)"})
    if st == 403:
        return                                        # the Console runs only for callers on the server's own network
    rid = json.loads(b.decode())["result"]["run"]
    seen, early, n = [], None, 0
    for _ in range(80):
        r = jget("/api/console/poll?run={}&since={}".format(rid, n))
        n = r["next"]
        seen += [o["text"] for o in r["outputs"] if o["type"] == "stdout"]
        if early is None and seen and not r["done"]:
            early = True                              # output arrived while the script was still running
        if r["done"]:
            break
        time.sleep(0.25)
    assert r["done"] and "".join(seen).split() == ["0", "1", "2"] and early, (seen, r)


def test_vf_cli():
    st, h, b = http("GET", "/v1/cli")
    assert st == 200 and b.startswith(b"#!/usr/bin/env python3\n") and b"\r\n" not in b
    with tempfile.TemporaryDirectory() as d:
        vf = os.path.join(d, "vf")
        with open(vf, "wb") as f:
            f.write(b)
        env = dict(os.environ, VF_URL=URL)

        def run(*args, timeout=300):
            p = subprocess.run([sys.executable, vf] + list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               universal_newlines=True, env=env, timeout=timeout)
            return p.returncode, p.stdout, p.stderr
        code, out, err = run("list", "sim")
        assert code == 0 and "sim.finance" in out, err
        code, out, err = run("describe", CPU_MODEL)
        assert code == 0 and "threads" in out, err
        code, out, err = run("run", CPU_MODEL, "--threads", "128", "--json")
        assert code == 0 and json.loads(out)["model"] == CPU_MODEL, (out, err)
        code, out, err = run("run", GPU_MODELS[1], "--rpc", "--json")
        assert code == 0 and json.loads(out)["model"] == GPU_MODELS[1], (out, err)
        png = os.path.join(d, "pi.png")
        code, out, err = run("run", PNG_MODEL, "--ticks", "3", "--out", png)
        assert code == 0 and open(png, "rb").read(4) == b"\x89PNG", err
        code, out, err = run("test", CPU_MODEL, GPU_MODELS[0])
        assert code == 0 and "2 ok" in out, out + err
        code, out, err = run("run", "no.such.model")
        assert code != 0 and err.startswith("vf:")


def main():
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    print("VectorFall API contract test against", URL)
    for n, f in tests:
        t0 = time.time()
        try:
            f()
            print("  PASS  {:<28} {:6.1f} s".format(n, time.time() - t0))
        except Exception as e:  # noqa: BLE001
            failed += 1
            print("  FAIL  {:<28} {:6.1f} s  {}: {}".format(n, time.time() - t0, type(e).__name__, str(e)[:300]))
        sys.stdout.flush()
    print("{} passed, {} failed".format(len(tests) - failed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
