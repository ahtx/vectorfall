# Vectorfall models

Every Vectorfall operation is a **model**: one Python function plus a declaration of its parameters, registered in
`app/models/<app>.py`. That one declaration is the source of five entry points, and all five run the same code:

| Ingress | How | Notes |
|---|---|---|
| UI | the apps' own routes (`/api/…`) call `registry.ui()` / `registry.ui_job()` | the Models app calls `/v1` directly |
| CLI | `vf run <model> --<param> <value> …` | `app/vf_cli.py`, one stdlib file, Python 3.6+ |
| REST + OpenAPI 3.1 | `POST /v1/models/<model>` with the parameters as a JSON object | `/v1/openapi.json`, `/v1/docs` |
| JSON-RPC 2.0 + OpenRPC | `POST /v1/rpc`, `method` = model name, named params; batches | `rpc.discover`, `/v1/openrpc.json` |
| MCP | `POST /mcp` (streamable HTTP, JSON replies); every model is a tool | tool name = model name with `_` for `.` |

One function (`registry.coerce`) checks and converts all parameters. Thus a bad value gets the same message
everywhere: 422 over REST, `-32602` over JSON-RPC, `isError` over MCP, and an error line from the CLI.

## Adding a GPU application

```python
# app/models/mine.py   (and add `mine` to the import list in app/models/__init__.py)
import cupy as cp
from .. import engine
from ..registry import model, Blob

@model("mine.heat", "Heat equation", "sim",                      # name, title, group
       "Explicit finite differences on an N×N plate, on the card.",
       fields=[{"k": "n", "type": "int", "label": "Grid", "default": 512, "min": 64, "max": 4096},
               {"k": "steps", "type": "int", "label": "Steps", "default": 2000, "min": 1, "max": 10**6},
               {"k": "alpha", "type": "float", "label": "Diffusivity", "default": 0.2, "min": 0.01, "max": 0.25}],
       example={"n": 256, "steps": 500})
def heat(n, steps, alpha):
    def job():                                   # everything inside job() runs on the single GPU worker
        u = cp.zeros((n, n), cp.float32); u[n // 2 - 8:n // 2 + 8, n // 2 - 8:n // 2 + 8] = 1
        for _ in range(steps):
            u[1:-1, 1:-1] += alpha * (u[2:, 1:-1] + u[:-2, 1:-1] + u[1:-1, 2:] + u[1:-1, :-2] - 4 * u[1:-1, 1:-1])
        return float(u.sum()), float(u.max())
    total, peak = engine.run_on_gpu(job, "heat equation", 60)
    return {"headline": "{:.3f}".format(peak), "sentence": "Peak temperature after {} steps.".format(steps),
            "total": total, "peak": peak}
```

After a restart it is on all five entry points:
`vf run mine.heat --n 1024 --steps 5000`, `POST /v1/models/mine.heat`, the Models app, MCP tool `mine_heat`.

Rules that keep the card healthy:
- **Do the GPU work inside `engine.run_on_gpu(fn, label, timeout)`.** It is the one queue for the card. It runs
  one job at a time, frees GPU memory, writes the Log and the GPU times, and recovers a stuck card.
- **The K420's display watchdog kills any single kernel that runs longer than about 2 s.** Chunk long loops into short
  launches that carry state between them.
- **The card has 1 GB.** Check `engine.budget_bytes()` and size the problem to it.
- **Return a dict.** The CLI and the UI show `headline`, `sentence` and `check` first. Return `Blob(bytes,
  media_type, filename, meta)` for images, audio or files. The registry converts numpy values and NaN to JSON.
- **Raise `ValueError`** for bad input and `registry.Refused(msg, status)` for "not possible right now"
  (409 = needs state, 404 = no such thing).
- **Set `long=True` if the work takes more than a few seconds.** The function then receives `job` first and should
  call `job.step(progress, message)`. Callers get a job id (REST `?async=1`, RPC `vf.start`); the CLI waits with
  `vf job <id> --wait`. The UI always runs it as a job.
- **Say where the work runs:** `device="gpu"`, `"mixed"` (a GPU kernel plus real CPU work) or `"cpu"`. `vf test` flags
  a model declared `gpu` that never touched the card.
- **Flag models that change data.** Use `mutating=True` for a model that changes stored data. Use `local_only=True`
  for a model that only your own network can use, for example code execution or a card reset.

## Field types

| type | JSON | CLI | UI control |
|---|---|---|---|
| `int` `float` `money` | number | `--k 3` | slider with min/max, else number box |
| `bool` | boolean | `--k`, `--no-k`, `--k false` | toggle |
| `choice` | string from `choices` | `--k value` | select |
| `str` | string | `--k 'some text'` | input |
| `text` | string | `--k @file.txt`, `--k -` (stdin), `\n` escapes | textarea |
| `strs` / `list` | array of strings / numbers | comma-separated | input |
| `json` | object or array | `--k '{"a":1}'` | textarea |
| `file` | base64 string | `--k @path` (read and encoded by the CLI) | file picker |
| `table` `photo` `sound` `corpus` `project` | id string | `--k <id or part of the name>`, `--k @file` uploads | select of what the server holds |

Other field keys:
- `required`: the caller must give the parameter.
- `soft`: min/max are only a suggested range (shown in the schema as `x-vf-range`), not a limit.
- `help`: a longer description.

## Testing

`vf test` runs every model that does not change data, with its `example` parameters through the public API. For a required reference,
the test uses the first table, photo, clip, corpus or project on the server. It prints wall time, GPU time and the
number of GPU runs for each model. To test a model that changes data, give its name: `vf test data.paste`.
