#!/usr/bin/env python3
"""Vectorfall MCP server — lets an agent (Claude or any MCP client) drive the K420 over the network.

Vectorfall itself runs on Python 3.6 (CUDA 10.2) and can't host a modern MCP server, so this is a thin stdio MCP
proxy you run on any Python 3.10+ machine that can reach the server. It calls Vectorfall's REST API, which does
all the GPU work. Install once:  pip install "mcp[cli]" httpx  — then register it with your MCP client, e.g.:

  {"mcpServers": {"vectorfall": {"command": "python3", "args": ["/path/vectorfall_mcp.py"],
                                 "env": {"VECTORFALL_URL": "http://<vectorfall-host>:8092"}}}}

Tools: sound effects on a file, text search / Markov generation over the loaded corpus, a Monte Carlo on a series,
and running Python on the card. The audio tools answer the user's ask: call an effect on a file and get a file back.
"""
import base64
import os

import httpx
from mcp.server.fastmcp import FastMCP


def _load_env():
    """KEY=VALUE lines from a .env next to this file or in the folder above it; real env vars win."""
    here = os.path.dirname(os.path.abspath(__file__))
    for p in (os.path.join(here, ".env"), os.path.join(os.path.dirname(here), ".env")):
        if os.path.isfile(p):
            for line in open(p, encoding="utf-8"):
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
            return


_load_env()
BASE = os.environ.get("VECTORFALL_URL", "http://localhost:8092").rstrip("/")
mcp = FastMCP("vectorfall")


def _get(path, **q):
    return httpx.get(BASE + path, params=q, timeout=180).json()


def _post(path, body):
    return httpx.post(BASE + path, json=body, timeout=300).json()


@mcp.tool()
def machine() -> dict:
    """Live state of the Quadro K420: utilisation, memory, temperature, measured GFLOP/s."""
    m = _get("/api/machine")
    return {"card": m["card"]["name"], **{k: m["live"].get(k) for k in ("util_gpu", "mem_used", "mem_total", "temp")},
            "measured_gflops": m["measured"].get("gflops")}


@mcp.tool()
def apply_audio_effects(sound_id: str, chain: list, out_path: str = "") -> dict:
    """Apply a chain of effects to an uploaded clip on the GPU and (optionally) save the WAV locally.
    chain is a list like [{"id":"denoise","params":{"amount":0.6}}, {"id":"reverb","params":{"mix":0.3}}].
    Effect ids: gain normalize eq denoise lowpass highpass telephone reverb echo pitch tempo speed vocals reverse fade crush.
    Returns timings; with out_path the processed WAV is written there."""
    r = _post("/api/sounds/{}/render".format(sound_id), {"chain": chain})
    if out_path:
        audio = httpx.get(BASE + "/api/sounds/{}/audio?which=render".format(sound_id), timeout=120).content
        with open(out_path, "wb") as f:
            f.write(audio)
        r["saved"] = out_path
    return r


@mcp.tool()
def list_sounds() -> list:
    """The clips currently loaded in Sound Lab (ids usable with apply_audio_effects)."""
    return _get("/api/sounds")


@mcp.tool()
def sound_effects() -> dict:
    """The available audio effects and their parameters."""
    return _get("/api/sounds/fx")


@mcp.tool()
def upload_sound(path: str) -> dict:
    """Upload a local audio file to Sound Lab; returns its id."""
    with open(path, "rb") as f:
        r = httpx.post(BASE + "/api/sounds", files={"file": (os.path.basename(path), f)}, timeout=180)
    return r.json()


@mcp.tool()
def text_search(query: str, limit: int = 20) -> dict:
    """Search the corpus loaded in the Text Engine (instant, GPU). Returns match count and concordance lines."""
    return _get("/api/text/search", q=query, limit=limit)


@mcp.tool()
def text_generate(seed: str = "", length: int = 80, order: int = 3, theme: str = "") -> dict:
    """Generate text in the loaded corpus's voice (Markov chain on the GPU). theme steers it semantically."""
    return _get("/api/text/generate2", seed=seed, length=length, order=order, theme=theme)


@mcp.tool()
def text_meaning() -> dict:
    """Key terms, collocations and semantic clusters of the loaded corpus (GPU embeddings)."""
    return _get("/api/text/meaning")


@mcp.tool()
def simulate_series(numbers: list, horizon: int = 60, delta: str = "percent") -> dict:
    """Monte-Carlo-project any numeric series on the GPU (delta-binning Markov). Returns the median path and a cone."""
    return _post("/api/simulate/series", {"params": {"series": "\n".join(str(x) for x in numbers), "horizon": horizon, "delta": delta}})


@mcp.tool()
def solve_constraints(model: str, walkers: int = 2048, sweeps: int = 3000) -> dict:
    """Solve a constraint / optimisation problem by GPU random walks (simulated annealing, one walker per thread).
    model is the Walk-solver language, e.g.:
        n = 8
        var q[n] perm
        count(1 for i in range(n) for j in range(i + 1, n) if abs(q[i] - q[j]) == j - i) == 0
    Variables: `var x int lo..hi`, `var x real lo..hi`, `var b[n] bool`, `var t perm n`; constants `name = <number|list>`;
    one constraint per line; optional `minimize: <expr>` / `maximize: <expr>`, `temperature: a .. b`, `sweeps: n`.
    Returns the best assignment (`solution`), whether it satisfies every constraint (`feasible`, re-checked on the CPU)
    and the remaining `violations`."""
    r = _post("/api/simulate/solve", {"params": {"model": model, "walkers": walkers, "sweeps": sweeps, "heat": 1}})
    keep = ("headline", "sentence", "feasible", "solution", "violations", "objective", "walkers", "sweeps", "ms")
    return {k: r.get(k) for k in keep} if isinstance(r, dict) else r


@mcp.tool()
def run_python(code: str) -> dict:
    """Run Python on the card (cp = CuPy = NumPy on the GPU). Returns printed output and any errors."""
    r = _post("/api/console/run", {"code": code, "timeout": 60})
    return {"outputs": [o for o in r["outputs"] if o["type"] in ("stdout", "stderr", "error", "race", "table")], "wall_s": r["wall_s"]}


if __name__ == "__main__":
    mcp.run()
