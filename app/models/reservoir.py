"""Reservoir Lab models: projects of labelled examples (sounds, images, sequences) or a series to forecast; train and
test on the card, always scored against chance and the same readout on the raw input."""
import base64

from .. import registry as R
from ..registry import model

PROJECT = {"k": "project", "type": "project", "label": "Project", "required": True}


def _rv():
    from .. import reservoir
    return reservoir


def _guard(fn, *a):
    try:
        return fn(*a)
    except KeyError as e:
        raise R.Refused("no such project or example: {}".format(e), 404)


def _payload(project, file=None, numbers=None, pcm16k=None):
    rv = _rv()
    kind = _guard(rv._load, project)["kind"]
    if file is not None:
        return rv._payload(kind, file=file)
    body = {}
    if numbers is not None:
        body["numbers"] = numbers
    if pcm16k is not None:
        body["pcm16k"] = pcm16k
    return rv._payload(kind, body=body)


INPUT = [{"k": "file", "type": "file", "label": "A sound or image file (audio/image projects)"},
         {"k": "numbers", "type": "str", "label": "A sequence of numbers (sequence projects)"},
         {"k": "pcm16k", "type": "str", "label": "Raw audio: base64 float32 at 16 kHz"}]


@model("reservoir.list", "List projects", "reservoir", "Every Reservoir Lab project: kind, labels, examples, last training.", device="cpu")
def plist():
    return _rv().list_projects()


@model("reservoir.get", "A project", "reservoir", "One project's settings, examples and training record.", device="cpu", fields=[PROJECT])
def pget(project):
    rv = _rv()
    return _guard(lambda: rv.public(rv._load(project)))


@model("reservoir.create", "New project", "reservoir", "Start a project: audio, image or numbers (classify), or series (forecast).", device="cpu",
       mutating=True, fields=[{"k": "kind", "type": "choice", "label": "Kind", "choices": ["audio", "image", "numbers", "series"], "required": True},
                              {"k": "name", "type": "str", "label": "Name", "default": ""}])
def create(kind, name):
    rv = _rv()
    return rv.public(rv.create(name, kind))


@model("reservoir.update", "Change settings", "reservoir", "Reservoir settings (type, units, leak, radius…), the encoder, forecast settings.",
       device="cpu", mutating=True,
       fields=[PROJECT, {"k": "name", "type": "str", "label": "Name"},
               {"k": "type", "type": "choice", "label": "Reservoir", "choices": ["esn", "ripple"]},
               {"k": "units", "type": "int", "label": "Units (144–1024)"}, {"k": "leak", "type": "float", "label": "Leak (0.01–1)"},
               {"k": "radius", "type": "float", "label": "Echo / spectral radius (0–1.6)"}, {"k": "input_scale", "type": "float", "label": "Input drive (0.01–5)"},
               {"k": "density", "type": "float", "label": "Wiring density (0.01–1)"}, {"k": "snapshots", "type": "int", "label": "Snapshots (1–16)"},
               {"k": "seed", "type": "int", "label": "Seed"}, {"k": "ripple_grid", "type": "int", "label": "Ripple grid (48/64/96)"},
               {"k": "ripple_damp", "type": "float", "label": "Ripple damping (0–0.3)"}, {"k": "ripple_nl", "type": "float", "label": "Ripple non-linearity (0–3)"},
               {"k": "substeps", "type": "int", "label": "Ripple substeps (1–8)"},
               {"k": "encoder", "type": "choice", "label": "Image encoder", "choices": ["reservoir", "clip"]},
               {"k": "horizon", "type": "int", "label": "Forecast horizon (1–250)"}, {"k": "lags", "type": "int", "label": "Forecast lags (1–60)"},
               {"k": "train_frac", "type": "float", "label": "Training share (0.3–0.9)"}])
def update(project, name=None, encoder=None, horizon=None, lags=None, train_frac=None, **res):
    body = {"reservoir": {k: v for k, v in res.items() if v is not None},
            "forecast": {k: v for k, v in (("horizon", horizon), ("lags", lags), ("train_frac", train_frac)) if v is not None}}
    if name is not None:
        body["name"] = name
    if encoder is not None:
        body["encoder"] = encoder
    return _guard(_rv().update, project, body)


@model("reservoir.delete", "Delete a project", "reservoir", "", device="cpu", mutating=True, fields=[PROJECT])
def delete(project):
    return _guard(_rv().delete, project)


@model("reservoir.example.add", "Add an example", "reservoir", "One labelled example: a sound, an image, or a sequence.", device="mixed",
       mutating=True, fields=[PROJECT, {"k": "label", "type": "str", "label": "Label", "required": True}] + INPUT +
       [{"k": "source", "type": "str", "label": "Where it came from", "default": ""}])
def add_example(project, label, source, file=None, numbers=None, pcm16k=None):
    return _guard(_rv().add_example, project, label, _payload(project, file, numbers, pcm16k), source)


@model("reservoir.example.delete", "Delete an example", "reservoir", "", device="cpu", mutating=True,
       fields=[PROJECT, {"k": "example", "type": "str", "label": "Example id", "required": True}])
def del_example(project, example):
    return _guard(_rv().delete_example, project, example)


@model("reservoir.example.relabel", "Relabel an example", "reservoir", "", device="cpu", mutating=True,
       fields=[PROJECT, {"k": "example", "type": "str", "label": "Example id", "required": True},
               {"k": "label", "type": "str", "label": "New label", "required": True}])
def relabel(project, example, label):
    return _guard(_rv().relabel, project, example, label)


@model("reservoir.example.peek", "Look inside an example", "reservoir", "The input, the reservoir's waves and the fingerprint the readout sees.",
       fields=[PROJECT, {"k": "example", "type": "str", "label": "Example id", "required": True}])
def peek(project, example):
    return _guard(_rv().peek, project, example)


@model("reservoir.train", "Train", "reservoir",
       "Run every example through the reservoir on the card and fit the readout; cross-validated, against chance and the raw input.",
       mutating=True, timeout=600, fields=[PROJECT])
def train(project):
    return _guard(_rv().train, project)


@model("reservoir.test", "Test one input", "reservoir", "Classify a new sound, image or sequence with the trained project.",
       fields=[PROJECT] + INPUT)
def test(project, file=None, numbers=None, pcm16k=None):
    return _guard(_rv().test, project, _payload(project, file, numbers, pcm16k))


@model("reservoir.series.set", "Give a forecast project its series", "reservoir",
       "From a ticker, a Data Desk column (plus optional input columns), or pasted numbers. Needs at least 120 points.",
       device="cpu", mutating=True,
       fields=[PROJECT, {"k": "ticker", "type": "str", "label": "Ticker"}, {"k": "years", "type": "int", "label": "Years", "default": 10, "min": 1, "max": 40},
               {"k": "with_volume", "type": "bool", "label": "Include volume as an input", "default": False},
               {"k": "table", "type": "table", "label": "…or a Data Desk table"}, {"k": "target", "type": "str", "label": "Column to forecast"},
               {"k": "inputs", "type": "strs", "label": "Extra input columns"}, {"k": "date_col", "type": "str", "label": "Date column", "default": "auto"},
               {"k": "numbers", "type": "text", "label": "…or pasted numbers"}])
def set_series(project, ticker, years, with_volume, table, target, inputs, date_col, numbers):
    rv = _rv()

    def go():
        if ticker:
            sym, rows = rv.fetch_ticker(ticker, years)
            return rv.set_series(project, [[r[1]] + ([r[2] or 0] if with_volume else []) for r in rows],
                                 [sym + " adjusted close"] + ([sym + " volume"] if with_volume else []),
                                 "Yahoo Finance daily, {} years".format(years), [r[0] for r in rows])
        if table:
            from .. import media, sources
            tgt = target or next((c for c in (next((t for t in media.table_list() if t["id"] == table), {}).get("numeric") or [])), None)
            cols = [tgt] + [c for c in (inputs or []) if c != tgt]
            s = sources.series(table, cols, date_col or "auto")
            return rv.set_series(project, s["values"], cols, "Data Desk: " + str(s["table"]), s["labels"])
        return rv.set_series(project, rv.parse_numbers(numbers or ""), ["value"], "pasted")
    return _guard(go)


@model("reservoir.series.get", "A forecast project's series", "reservoir", "", device="cpu", fields=[PROJECT])
def get_series(project):
    import os
    import numpy as np
    rv = _rv()
    p = os.path.join(_guard(rv._pdir, project), "series.npy")
    if not os.path.exists(p):
        raise R.Refused("this project has no series yet (reservoir.series.set)", 404)
    v = np.load(p)
    step = max(1, v.shape[0] // 1500)
    return {"values": v[::step, 0].round(6).tolist(), "step": step, "n": int(v.shape[0])}


@model("reservoir.forecast", "Up or down next? (one step)", "reservoir",
       "Make a forecast project from a Data Desk column or a ticker. Give it the series, train it, and report the honest test score.",
       mutating=True, timeout=600,
       fields=[{"k": "table", "type": "table", "label": "Data Desk table"}, {"k": "col", "type": "str", "label": "Column"},
               {"k": "ticker", "type": "str", "label": "…or a ticker"}, {"k": "years", "type": "int", "label": "Years (ticker)", "default": 10},
               {"k": "horizon", "type": "int", "label": "Days ahead", "default": 5, "min": 1, "max": 250},
               {"k": "name", "type": "str", "label": "Project name", "default": ""}])
def forecast(table, col, ticker, years, horizon, name):
    rv = _rv()
    if not table and not ticker:
        raise R.Refused("give a table (and column) or a ticker")
    p = rv.create(name or "{}: up or down".format(col or ticker or "series"), "series")
    try:
        rv.update(p["id"], {"forecast": {"horizon": horizon}})
        set_series(p["id"], ticker, years, False, table, col, [], "auto", None)
        return dict(_rv().train(p["id"]), project=p["id"])
    except Exception:
        rv.delete(p["id"])
        raise


@model("reservoir.from_photos", "Photos → examples", "reservoir", "Add Photo Lab photos to an image project under one label.", device="cpu",
       mutating=True, fields=[{"k": "photos", "type": "strs", "label": "Photo ids", "required": True},
                              {"k": "label", "type": "str", "label": "Label", "required": True},
                              {"k": "project", "type": "project", "label": "Project (empty = a new image project)"},
                              {"k": "name", "type": "str", "label": "New project's name"}])
def from_photos(photos, label, project, name):
    return _guard(_rv().from_photos, list(photos), label.strip(), project or None, name or None)


@model("reservoir.demo", "Load a demo dataset", "reservoir", "Spoken digits (FSDD), handwritten digits (MNIST) or SPY up/down.", long=True,
       mutating=True, device="mixed", timeout=900,
       fields=[{"k": "which", "type": "choice", "label": "Dataset", "choices": ["digits-spoken", "digits-written", "spy"], "required": True}])
def demo(job, which):
    return _rv().demo(which, job)


def b64(data):
    return base64.b64encode(data).decode("ascii")
