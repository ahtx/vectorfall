"""Force model (Particle Lab): learn one combined force from the past, test it on years it never saw, project it.

Worlds: companies (the S&P 500, monthly, since 2007) and countries (GDP, yearly, since 1960). Each step of the work is
its own model, so the UI, the CLI, /v1 and MCP all run the same thing:
  forces.world    the data: bodies, years, events by type, notes                      (fast, no GPU)
  forces.events   the event ledger, filtered                                          (fast, no GPU)
  forces.learn    learn the weights and the event chances on the training period     (a job, minutes)
  forces.model    the learned model as saved                                         (fast)
  forces.test     run the learned model once on the test period                      (a job)
  forces.project  run futures to a year, with learned events and your scenarios      (a job)
  forces.result   the last saved test or projection, without running it again        (fast)
"""
import math

from .. import engine, forcerun as FR, forcefield as FF, worlds as WD
from ..registry import Refused, model
from .. import registry as _R

G = "forces"
_R.group(G, "Force model — learn the forces, test them on unseen years, project them", "particles")
WORLD = {"k": "world", "type": "choice", "label": "World", "choices": ["companies", "countries"], "default": "countries",
         "help": "companies: the S&P 500 by market cap, month by month. countries: real GDP (constant 2015 US$), year by year."}
FR.GPU = lambda fn, label: engine.run_on_gpu(fn, label, 900)


def _world(name):
    return FR.world(name)


@model("forces.world", "World data", G, "The bodies, the years, the events by type, and notes about the data.", fields=[WORLD], device="cpu")
def world(world):
    W = _world(world)
    s = WD.summary(W)
    s["periods"] = FR.periods(W)
    s["terms"] = [{k: t[k] for k in ("k", "label", "kind", "unit", "help")} for t in FF.terms(world)]
    s["event_words"] = FF.EVENT_WORDS
    s["learned"] = FR.load(world, "model") is not None
    s["tested"] = FR.load(world, "test") is not None
    s["projected"] = FR.load(world, "project") is not None
    import math
    import os
    geo = W.get("geo")
    if geo is not None:
        s["geo"] = {i: [round(float(g[0]), 2), round(float(g[1]), 2)] for i, g in zip(W["ids"], geo) if not math.isnan(float(g[0]))}
    s["saved"] = {k: os.path.getmtime(os.path.join(FF.ROOT, world, k + ".json")) for k in ("model", "test", "project")
                  if os.path.exists(os.path.join(FF.ROOT, world, k + ".json"))}
    return s


@model("forces.futures", "Futures of one body", G,
       "Monte Carlo of one country or company from its growth regimes, its own history blended with bodies like it, with "
       "volatility, persistence, drift and window perturbations on the same random numbers as the baseline.",
       fields=[WORLD, {"k": "id", "type": "str", "label": "Body id (e.g. IDN, AAPL)", "required": True},
               {"k": "horizon", "type": "int", "label": "Steps ahead (years or months)", "default": 0, "min": 0, "max": 120},
               {"k": "own", "type": "float", "label": "Own history weight (0 = bodies like it, 1 = only its own; empty = the backtest's best)", "default": -1, "min": -1, "max": 1},
               {"k": "vol", "type": "float", "label": "Volatility x", "default": 1.0, "min": 0.2, "max": 3},
               {"k": "persist", "type": "float", "label": "Regime persistence (+ = spells last longer)", "default": 0.0, "min": -0.9, "max": 0.9},
               {"k": "drift", "type": "float", "label": "Drift per step (log)", "default": 0.0, "min": -0.3, "max": 0.3},
               {"k": "window", "type": "int", "label": "Learn from the last N steps (0 = all)", "default": 0, "min": 0, "max": 400},
               {"k": "calibrated", "type": "bool", "label": "Widen the bands by the backtest", "default": True},
               {"k": "paths", "type": "int", "label": "Futures", "default": 4000, "min": 200, "max": 20000},
               {"k": "seed", "type": "int", "label": "Seed", "default": 0, "min": 0}], device="cpu")
def futures(world, id, horizon, own, vol, persist, drift, window, calibrated, paths, seed):
    from .. import futures as FU
    return FU.run(world, id, horizon or None, None if own is None or own < 0 else own, vol, persist, drift, window, calibrated, paths, seed)


@model("forces.futures_check", "Backtest the futures method", G,
       "Run the futures method from many past starting points on every body, score it for each blend of own history "
       "(CRPS, 80% band coverage) against no change, and save the best blend and the band widening.",
       fields=[WORLD], device="cpu", mutating=True, long=True, timeout=1800)
def futures_check(world, job=None):
    from .. import futures as FU
    return FU.backtest(world, job=job)


@model("forces.outlook", "What the professionals say", G,
       "Countries: World Bank (Global Economic Prospects) and IMF (World Economic Outlook) growth forecasts, as paths of real "
       "GDP per person from the last data year. Companies: analyst consensus fetched live from Yahoo (never stored), as the "
       "share of the index its 12-month price targets imply if the index is flat; plus rows harvested from public pages.",
       fields=[WORLD, {"k": "id", "type": "str", "label": "Body id", "required": True}], device="cpu")
def outlook(world, id):
    import numpy as np
    from .. import consensus as CN, futures as FU
    W = _world(world)
    if id not in W["ids"]:
        raise Refused("no body {} in {}".format(id, world))
    i = W["ids"].index(id)
    L, what, unit = FU.level(W)
    fin = np.flatnonzero(np.isfinite(L[i]))
    t0 = int(fin[-1])
    v0, y0 = float(L[i, t0]), int(W["dates"][t0][:4])
    lines = []
    if world == "countries":
        o = CN.country(id)
        pop = W["extra"]["pop"][i]
        pf = np.flatnonzero(np.isfinite(pop) & (pop > 0))
        pg = float(np.mean(np.diff(np.log(pop[pf[-6:]])))) if pf.size >= 6 else 0.0
        for k in ("imf", "wb"):
            if k not in o:
                continue
            g = o[k]["growth"]
            v, pts = v0, []
            for y in range(y0 + 1, max(g) + 1 if g else y0):
                if y not in g:
                    break
                r = g[y] / 100.0
                v *= (1 + r) if o[k]["per_person"] else (1 + r) / math.exp(pg)
                pts.append(["{}-12-31".format(y), v])
            if pts:
                lines.append({"key": k, "name": o[k]["name"], "what": o[k]["what"], "points": pts,
                              "note": None if o[k]["per_person"] else "total growth less population growth ({:+.1%} a year, its last 5 years)".format(math.exp(pg) - 1)})
        return {"world": world, "id": id, "lines": lines, "errors": {k: v for k, v in o.items() if k.endswith("_error")}}
    o = CN.company(id)
    lv = o.get("live")
    if lv and lv.get("price") and lv.get("target_mean"):
        d = W["dates"][t0]
        y, m = int(d[:4]), int(d[5:7]) + 12
        when = "{:04d}-{:02d}-28".format(y + (m - 1) // 12, (m - 1) % 12 + 1)
        f = lambda t: v0 * t / lv["price"] if t else None
        lines.append({"key": "analysts", "name": "Analysts' 12-month targets ({} analysts, {})".format(lv.get("analysts"), lv.get("rating")),
                      "what": "the share of the index the price targets imply if the whole index is flat",
                      "at": when, "mean": f(lv["target_mean"]), "low": f(lv.get("target_low")), "high": f(lv.get("target_high")),
                      "upside": lv["target_mean"] / lv["price"] - 1})
    return {"world": world, "id": id, "lines": lines, "live": lv, "harvested": o.get("harvested", []), "errors": {k: v for k, v in o.items() if k.endswith("_error")},
            "terms": "Live consensus is fetched from Yahoo Finance when you open the company; it is not stored or redistributed."}


@model("forces.scenario", "Scenario for a country, a region or the world", G,
       "Joint futures of every member of a target (a body id, group:<region or sector>, or all), with correlated draws, "
       "and a list of changes (growth, vol, stability, shock) over years ahead, against the baseline on the same random numbers.",
       fields=[WORLD, {"k": "target", "type": "str", "label": "Target: a body id, group:<name>, or all", "default": "all"},
               {"k": "changes", "type": "json", "label": "Changes: [{target, kind, from, to, value}]", "default": []},
               {"k": "horizon", "type": "int", "label": "Steps ahead", "default": 0, "min": 0, "max": 60},
               {"k": "paths", "type": "int", "label": "Futures", "default": 1500, "min": 200, "max": 6000},
               {"k": "seed", "type": "int", "label": "Seed", "default": 0, "min": 0}], device="cpu", timeout=300)
def scenario(world, target, changes, horizon, paths, seed):
    from .. import scenario as SC
    return SC.run(world, target or "all", changes or [], horizon or None, None, paths, seed)


@model("forces.predictors", "What predicts growth", G,
       "For each candidate data series (energy per person, investment, working-age share, health, ...), its rank correlation "
       "with the next 5 years of real growth per person, from every start year since 1990, on its own and beyond income.",
       fields=[WORLD, {"k": "refresh", "type": "bool", "label": "Compute again", "default": False}], device="cpu", timeout=600)
def predictors(world, refresh):
    from .. import predictors as PR
    got = None if refresh else FR.load(world, "predictors")
    return got or PR.run(world)


@model("forces.why", "Why a body is forecast to grow", G,
       "Each growth force's part of one body's forecast growth (share points per year) at the start of the test or the "
       "projection, with the force's learned weight and the body's value of what it reacts to.",
       fields=[WORLD, {"k": "id", "type": "str", "label": "Body id", "required": True},
               {"k": "kind", "type": "choice", "label": "Start of", "choices": ["project", "test"], "default": "project"}], device="cpu")
def why(world, id, kind):
    import numpy as np
    W = _world(world)
    if id not in W["ids"]:
        raise Refused("no body {} in {}".format(id, world))
    model = FR.load(world, "model_all" if kind == "project" else "model") or FR.load(world, "model")
    if not model:
        raise Refused("learn the forces first")
    A = FF.real_maps(W)
    if kind == "project":
        t0 = len(W["dates"]) - 1
    else:
        res = FR.load(world, "test")
        t0 = W["dates"].index(res["t0"]) if res and res.get("t0") in W["dates"] else W["dates"].index(model["periods"]["test"][0]) - 1
    snap = FF.snapshot(W, A, t0, model["blend"])
    i = W["ids"].index(id)
    where = np.flatnonzero(snap["ix"] == i)
    if not where.size:
        raise Refused("{} is not in the world at {}".format(W["names"][i], W["dates"][t0][:7]))
    j = int(where[0])
    c = FF.contributions(model["P"], model["names"], snap)
    labels = {t["k"]: t["label"] for t in FF.TERMS}
    parts = sorted(({"k": k, "label": labels.get(k, k), "per_year": float(v[j])} for k, v in c.items()), key=lambda x: -abs(x["per_year"]))
    tot = sum(x["per_year"] for x in parts)
    return {"world": world, "id": id, "name": W["names"][i], "at": W["dates"][t0], "kind": kind, "parts": parts, "total": tot,
            "share": float(np.exp(snap["l"][j])), "dropped": model.get("dropped", []),
            "note": "Growth of its share, per year, from each force at the start. They add up to the forecast's push; the simulation also adds noise and events."}


@model("forces.series", "One body's history", G, "A body's own size over time (GDP in US$ per year, or market cap per month) as a Data Desk table, for Simulate.",
       fields=[WORLD, {"k": "id", "type": "str", "label": "Body id (e.g. IDN, AAPL)", "required": True}], device="cpu", mutating=True)
def body_series(world, id):
    import numpy as np
    from .. import media, sources
    W = _world(world)
    if id not in W["ids"]:
        raise Refused("no body {} in {}".format(id, world))
    i = W["ids"].index(id)
    size = np.asarray(W["size"][i], float)
    rows = [[d, float(v)] for d, v in zip(W["dates"], size) if v == v and v > 0]
    if len(rows) < 5:
        raise Refused("{} has fewer than 5 points of history".format(W["names"][i]))
    col = "real GDP (constant 2015 US$)" if world == "countries" else "market cap (US$)"
    name = "{} - {} ({}).csv".format(W["names"][i], col, "Particle Lab")
    for t in media.table_list():                       # one table per body: refreshed, not duplicated
        if t["name"] == name:
            media.table_delete(t["id"]) if hasattr(media, "table_delete") else None
    m = sources.table_from_rows(name, ["date", col], rows)
    return {"table": m["id"], "col": col, "name": W["names"][i], "points": len(rows), "step": W["step"]}


@model("forces.events", "Event ledger", G, "Every event in a world, with its date, the bodies it touched and its source.",
       fields=[WORLD, {"k": "type", "type": "str", "label": "Type (empty = all)", "default": ""},
               {"k": "id", "type": "str", "label": "Body id (empty = all)", "default": ""},
               {"k": "since", "type": "str", "label": "From date (empty = all)", "default": ""},
               {"k": "limit", "type": "int", "label": "At most", "default": 2000, "min": 1, "max": 20000}], device="cpu")
def events(world, type, id, since, limit):
    W = _world(world)
    out = [e for e in W["events"] if (not type or e["type"] == type) and (not id or e["id"] == id or e.get("by") == id) and (not since or e["date"] >= since)]
    return {"events": out[-limit:], "total": len(out)}


@model("forces.learn", "Learn the forces", G,
       "Learn the weight of each force on the training period, choose the setup on the tuning period, fit the event chances, "
       "then learn again on training plus tuning. Saves the model.", fields=[WORLD], device="gpu", mutating=True, long=True, timeout=7200)
def learn(job, world):
    return FR.learn(world, job=job)


@model("forces.model", "The learned model", G, "The weights, the event chances and the scores from the last time the tool learned.", fields=[WORLD], device="cpu")
def get_model(world):
    m = FR.load(world, "model")
    return m or {"missing": True, "sentence": "There is no model yet. Run forces.learn first."}


@model("forces.test", "Test on unseen years", G,
       "Run the learned model once from the end of the tuning period to the end of the data. Compare it with nothing "
       "changes, momentum only and statistics only.", fields=[WORLD, {"k": "futures", "type": "int", "label": "Futures", "default": 128, "min": 16, "max": 256}],
       device="mixed", long=True, timeout=3600)
def test(job, world, futures):
    if not FR.load(world, "model"):
        raise Refused("no model yet: run forces.learn first", 409)
    return engine.run_on_gpu(lambda: FR.test(world, ens=futures, job=job), "forces: test", 1800)


@model("forces.project", "Project the future", G,
       "Learn once more on all the data, then run futures to a year. Events happen at their learned chances, plus the "
       "scenario events you give.",
       fields=[WORLD, {"k": "to", "type": "int", "label": "To year", "default": 2030, "min": 2026, "max": 2060},
               {"k": "futures", "type": "int", "label": "Futures", "default": 128, "min": 16, "max": 256},
               {"k": "scenarios", "type": "json", "label": "Scenario events: [{type, id, date, value, by}]", "default": []}],
       device="mixed", long=True, timeout=7200)
def project(job, world, to, futures, scenarios):
    if not FR.load(world, "model"):
        raise Refused("no model yet: run forces.learn first", 409)
    return engine.run_on_gpu(lambda: FR.project(world, to_year=to, ens=futures, scenarios=scenarios or [], job=job), "forces: projection", 3600)


@model("forces.result", "Last result", G, "The last saved test or projection. The tool does not run it again.",
       fields=[WORLD, {"k": "kind", "type": "choice", "label": "Kind", "choices": ["test", "project"], "default": "test"}], device="cpu")
def result(world, kind):
    r = FR.load(world, kind)
    return r or {"missing": True, "sentence": "Nothing is saved yet."}
