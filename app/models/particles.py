"""Particle Lab models: a population that grows, competes, merges and dies, run as an N-body system on the card,
with the rules as overlays you switch on, set or fit from history — and every run checked against what really happened
and against two baselines (nothing changes; growth carries on with no interactions)."""
import numpy as np

from .. import engine, particles as PT
from ..registry import model

R_GROUP = "particles"
from .. import registry as _R  # noqa: E402
_R.group(R_GROUP, "Particle Lab — populations as N-body systems, tested on past dates", "particles")

# Each rule: key, label, what it means, control range, default, and whether it can be fitted from the past.
RULES = [
    {"k": "beta", "label": "Growth carries on", "rule": "momentum", "min": 0, "max": 1.5, "default": 0.5, "fit": True,
     "help": "Velocity. The part of the extra growth of each body (above or below the whole, before the start) that continues. 0 = all bodies grow at the same rate."},
    {"k": "kappa", "label": "Growth fades", "rule": "momentum", "min": 0, "max": 0.2, "default": 1 / 36.0, "fit": True,
     "help": "How fast the growth of each body goes back to the rate of the whole, per step."},
    {"k": "alpha", "label": "Size effect", "rule": "size", "min": -0.01, "max": 0.01, "default": 0.0, "fit": True,
     "help": "Above 0, the big get bigger (preferential attachment). Below 0, the small catch up (convergence)."},
    {"k": "G", "label": "Neighbourhood takeover", "rule": "takeover", "min": -2, "max": 2, "default": 0.0, "fit": True,
     "help": "Inside each neighbourhood: above 0, the bigger body grows and its neighbours lose. Below 0, the neighbours come nearer in size."},
    {"k": "h", "label": "Neighbourhood size", "rule": "takeover", "min": 0.05, "max": 1.5, "default": 0.35, "fit": False,
     "help": "How far the takeover effect of a body reaches, in map units."},
    {"k": "Gx", "label": "Gravity drift", "rule": "gravity", "min": 0, "max": 0.01, "default": 0.002, "fit": False,
     "help": "Bodies move toward heavy neighbours (a soft 1/r² pull). Thus groups come closer together on the map."},
    {"k": "fric", "label": "Friction", "rule": "gravity", "min": 0, "max": 0.6, "default": 0.15, "fit": False,
     "help": "The part of the speed of each body that it loses per step."},
    {"k": "merge_r", "label": "Capture radius", "rule": "merge", "min": 0, "max": 1.5, "default": 0.2, "fit": False,
     "help": "A body nearer than this distance (× the usual spacing) to a much bigger body joins it. 0 = no mergers."},
    {"k": "merge_q", "label": "Size ratio for a merger", "rule": "merge", "min": 0.02, "max": 0.6, "default": 0.2, "fit": False,
     "help": "Only bodies smaller than this fraction of their neighbour can join it."},
    {"k": "drop", "label": "Drop below the floor", "rule": "life", "type": "bool", "default": True,
     "help": "A body leaves (it dies) when its share falls below about half the smallest share at the start."},
    {"k": "entrants", "label": "New arrivals", "rule": "life", "type": "bool", "default": True,
     "help": "The Oort cloud: new bodies arrive with the rate, size, group mix and growth of the arrivals before the start."},
    {"k": "noise", "label": "Each body's own noise", "rule": "life", "type": "bool", "default": True,
     "help": "Random shocks at the past volatility of each body. The ensemble of futures gives the ranges."},
]
FITTABLE = [r["k"] for r in RULES if r.get("fit")]
INTERACTIONS = {"alpha": 0.0, "G": 0.0, "Gx": 0.0, "merge_r": 0.0}

SRC = [{"k": "source", "type": "choice", "label": "World", "choices": ["sp500", "gdp", "table", "text"], "default": "sp500",
        "help": "sp500: S&P 500 companies by market cap (monthly). gdp: countries by GDP (yearly, World Bank). table: a Data Desk table. text: CSV in the text field."},
       {"k": "text", "type": "text", "label": "CSV (when World = text): date,name,value[,group] lines, or date,A,B,C"},
       {"k": "table", "type": "table", "label": "Table (when World = table)"},
       {"k": "layout", "type": "choice", "label": "Table shape", "choices": ["wide", "long"], "default": "wide",
        "help": "wide: a date column + one numeric column per entity. long: date, entity, value (+ group) columns."},
       {"k": "cols", "type": "strs", "label": "Entity columns (wide; empty = all numeric)"},
       {"k": "entity_col", "type": "str", "label": "Entity column (long)"},
       {"k": "value_col", "type": "str", "label": "Value column (long)"},
       {"k": "group_col", "type": "str", "label": "Group column (long, optional)"},
       {"k": "groups", "type": "text", "label": "Groups (wide, optional): one 'entity: group' per line"}]


def _panel(source, table=None, layout="wide", cols=None, entity_col=None, value_col=None, group_col=None, groups="", text=""):
    if source == "text":
        from .. import labtpl
        return labtpl.read_group(text)
    if source == "sp500":
        try:
            return PT.market_panel()
        except FileNotFoundError:
            from ..registry import Refused
            raise Refused("the S&P 500 data does not exist yet: run particles.refresh", 409)
    if source == "gdp":
        return PT.worldbank_panel()
    if not table:
        raise ValueError("select a Data Desk table")
    return PT.desk_panel(table, layout, "auto", cols, entity_col, value_col, group_col, groups)


def _src(kw):
    return {k: kw.pop(k, None) for k in [f["k"] for f in SRC]}


def _rules(rules):
    out = {}
    for r in RULES:
        v = (rules or {}).get(r["k"], r["default"])
        if r.get("type") == "bool":
            out[r["k"]] = bool(v)
        else:
            out[r["k"]] = float(min(max(float(v), r["min"]), r["max"]))
    return out


@model("particles.rules", "Particle rules", R_GROUP, "Each rule that you can put on a particle world, with its range and meaning.",
       device="cpu")
def rules():
    return {"rules": RULES, "fittable": FITTABLE}


@model("particles.sources", "Particle worlds", R_GROUP, "The built-in worlds and their date ranges.", device="cpu")
def sources():
    out = []
    for sid, nm in [("sp500", "S&P 500 companies"), ("gdp", "Countries by GDP")]:
        try:
            p = _panel(sid)
            n = p["inidx"].sum(0)
            first = int(np.argmax(np.isfinite(np.where(p["inidx"], p["cap"], np.nan)).sum(0) > 0.6 * n.max()))
            out.append({"id": sid, "name": nm, "what": p["what"], "group_name": p["group_name"], "step": p["step"],
                        "dates": p["dates"][first:], "bodies": int(n.max()), "built": p.get("built")})
        except Exception as e:  # noqa: BLE001
            out.append({"id": sid, "name": nm, "error": str(e)})
    return {"sources": out}


def _body_rows(st, sim, act=None):
    W = sim["W"]
    mean = W.mean(0)
    lo, hi = np.percentile(W, 10, 0), np.percentile(W, 90, 0)
    w0 = st["cap"] / st["cap"].sum()
    x = sim["frames"][-1]["x"]
    rows = []
    for i in range(len(w0)):
        r = {"id": st["tickers"][i], "name": st["name"][i], "group": st["sector"][i], "x": x[i], "x0": sim["frames"][0]["x"][i],
             "w0": float(w0[i]), "w": float(mean[i]), "p10": float(lo[i]), "p90": float(hi[i]), "p_leave": float((W[:, i] <= 0).mean())}
        if act is not None:
            r["w1"] = float(act["w_body"][i]) if act["surv"][i] else 0.0
            r["left"] = not bool(act["surv"][i])
        rows.append(r)
    return rows


def _groups(st, sim, act=None):
    g = {}
    w0 = st["cap"] / st["cap"].sum()
    mean = sim["W"].mean(0)
    for i, s in enumerate(st["sector"]):
        d = g.setdefault(s, {"group": s, "w0": 0.0, "w": 0.0, "w1": None})
        d["w0"] += float(w0[i])
        d["w"] += float(mean[i])
    for s, w in zip(sim["entrant_sector"], sim["entrant_w"]):
        g.setdefault(s, {"group": s, "w0": 0.0, "w": 0.0, "w1": None})["w"] += float(w)
    if act is not None:
        for d in g.values():
            d["w1"] = 0.0
        for s, w in act["sector_w"].items():
            g.setdefault(s, {"group": s, "w0": 0.0, "w": 0.0, "w1": 0.0})["w1"] = float(w)
    return sorted(g.values(), key=lambda d: -max(d["w0"], d["w"], d["w1"] or 0))


_PATHS = {}


def _label(p, j0, m):
    """The date of step m after the start: from the data while it lasts, extrapolated past its end."""
    ds = p["dates"]
    if j0 + m < len(ds):
        return ds[j0 + m]
    extra = j0 + m - (len(ds) - 1)
    last = ds[-1]
    if p["step"] == "month":
        return PT._shift(last, extra)
    if p["step"] == "year":
        return "{:04d}{}".format(int(last[:4]) + extra, last[4:])
    return "{} +{}".format(last, extra)


@model("particles.run", "Run a particle world", R_GROUP,
       "Start from a date and apply your rules (set them, or fit them on the window before the start). Run an ensemble of "
       "futures on the card. If the end date is in the data, compare the run with what happened and with two baselines. "
       "The result has each step as a frame (mean share, p10/p90 per body, arrivals until then). It also has the real path at "
       "the same steps (shares, group shares and the co-movement map as it evolved) and the date of each step.",
       fields=SRC + [
           {"k": "t0", "type": "str", "label": "Start date (empty = the latest start with a known outcome)"},
           {"k": "horizon", "type": "int", "label": "Steps to run", "default": 60, "min": 2, "max": 240},
           {"k": "rules", "type": "json", "label": "Rules (keys from particles.rules)", "default": {}},
           {"k": "fit", "type": "strs", "label": "Rules to fit from the window before the start", "default": []},
           {"k": "ens", "type": "int", "label": "Futures in the ensemble", "default": 128, "min": 8, "max": 512}],
       device="mixed", long=True, timeout=900, example={"source": "gdp", "t0": "2010-12-31", "horizon": 10})
def run(job, t0, horizon, rules, fit, ens, **kw):
    source = kw.get("source")
    p = _panel(**_src(kw))
    ds = p["dates"]
    if not t0:
        t0 = ds[max(0, len(ds) - 1 - horizon)]
    j0 = PT._di(p, t0)
    P = _rules(rules)
    fitted = None
    fit = [k for k in (fit or []) if k in FITTABLE]
    if fit:
        if j0 - horizon < 2:
            raise ValueError("a fit needs {} steps before the start: start later or run fewer steps".format(horizon))
        job.step(0.05, "the tool fits {} on {} → {}".format(", ".join(fit), ds[j0 - horizon][:10], t0[:10]))
        fitted = engine.run_on_gpu(lambda: PT.fit(p, ds[j0 - horizon], ds[j0], fit, base=P), "particles fit", 600)
        P.update(fitted["params"])
    job.step(0.6, "the card runs {} futures".format(ens))
    has_end = j0 + horizon < len(ds)

    def go():
        st = PT.state(p, ds[j0])
        sim = PT.simulate(st, months=horizon, ens=ens, **P)
        # what happened doesn't depend on the rules, so rule-only reruns of a built-in world reuse it (tables are rebuilt each call)
        key = (source, len(p["dates"]), p["dates"][-1], len(p["tickers"]), st["j0"], horizon) if source in ("sp500", "gdp") else None
        path = _PATHS.get(key) if key else None
        if path is None:
            path = PT.actual_path(p, st, horizon, sim["frames"][0]["x"])
            if key:
                _PATHS[key] = path
            while len(_PATHS) > 12:
                _PATHS.pop(next(iter(_PATHS)))
        out = {"st": st, "sim": sim, "path": path}
        if has_end:
            act = PT.actual(p, st, ds[j0 + horizon])
            base_kw = dict(P, **INTERACTIONS)
            out.update(act=act, rows={"rules": PT.score(st, sim, act), "persistence": PT.persistence(st, act),
                                      "no interactions": PT.score(st, PT.simulate(st, months=horizon, ens=ens, **base_kw), act)})
        return out
    r = engine.run_on_gpu(go, "particles run", 300)
    st, sim, act = r["st"], r["sim"], r.get("act")
    res = {"t0": st["t0"], "t1": act["t1"] if act else None, "horizon": horizon, "step": p["step"], "what": p["what"],
           "group_name": p["group_name"], "rules": P, "fitted": fitted and {"params": fitted["params"], "window": fitted["window"]},
           "layout": st["layout"], "purity": round(st["purity"], 3), "chance": round(st["chance"], 3),
           "bodies": _body_rows(st, sim, act), "groups": _groups(st, sim, act), "frames": sim["frames"],
           "entrants": [{"group": s, "w": float(w), "x": x, "t": t} for s, w, x, t in
                        zip(sim["entrant_sector"], sim["entrant_w"], sim["entrant_x"], sim["entrant_t"])],
           "mergers": sim["mergers"][:200], "dates": ds,
           "frame_dates": [_label(p, j0, f["month"]) for f in sim["frames"]], "real": r["path"],
           "lookback": st["lookback"]}
    if act:
        res["scores"] = r["rows"]
        res["actual"] = {"top10": act["top10"], "top10_share": act["top10_share"], "new_share": act["new_w"]}
        s, b, n = r["rows"]["rules"], r["rows"]["persistence"], r["rows"]["no interactions"]
        beat = s["sector_l1"] < b["sector_l1"] - 0.005
        tie = abs(s["sector_l1"] - b["sector_l1"]) <= 0.005
        res["headline"] = "{:.0%}".format(s["sector_l1"])
        res["sentence"] = ("Your rules put {:.0%} of the whole in the wrong {} by {}. That is {} “nothing changes” ({:.0%}).{}"
                           .format(s["sector_l1"], p["group_name"], act["t1"][:7], "about the same as" if tie else "better than" if beat else "worse than", b["sector_l1"],
                                   " Too few bodies stayed to rank who grew." if s["rank_rho"] is None else " Who grew fastest: rank correlation {:+.2f} (no interactions {:+.2f}).".format(
                                       s["rank_rho"], n["rank_rho"] or 0)))
        res["check"] = "beats persistence" if beat else "ties persistence" if tie else "does not beat persistence"
    else:
        res["headline"] = "→ " + "{}+{}".format(st["t0"][:7], horizon)
        res["sentence"] = "This is a projection after the end of the data. There is nothing to compare it with yet."
    return res


@model("particles.backtest", "Test rules on past dates", R_GROUP,
       "Walk-forward test: at each start date, fit the selected rules on the window before it, and run forward. Then compare "
       "with what happened, with persistence, and with growth-carries-on alone. This is the honest test of the rules.",
       fields=SRC + [
           {"k": "horizon", "type": "int", "label": "Steps ahead", "default": 60, "min": 2, "max": 240},
           {"k": "starts", "type": "int", "label": "Start dates to test", "default": 5, "min": 1, "max": 12},
           {"k": "rules", "type": "json", "label": "Fixed rules (keys from particles.rules)", "default": {}},
           {"k": "fit", "type": "strs", "label": "Rules to fit each time", "default": ["beta", "kappa", "alpha", "G"]}],
       device="mixed", long=True, timeout=3600, example={"source": "gdp", "horizon": 10, "starts": 2})
def backtest(job, horizon, starts, rules, fit, **kw):
    p = _panel(**_src(kw))
    ds = p["dates"]
    first = horizon + 2 + min(36, horizon)
    last = len(ds) - 1 - horizon
    if last < first:
        raise ValueError("too little history: one {1}-step test with a fit window needs {0} steps".format(first + horizon + 1, horizon))
    js = [int(round(x)) for x in np.linspace(first, last, starts)]
    if p["step"] == "month":                                 # year-end starts read better and compare like with like
        js = [j - int(ds[j][5:7]) % 12 if j - int(ds[j][5:7]) % 12 >= first else j + (12 - int(ds[j][5:7]) % 12) % 12 for j in js]
        js = [j for j in js if j <= last]
    js = sorted(set(js))
    fit = [k for k in (fit or []) if k in FITTABLE] or ["beta", "kappa"]
    P = _rules(rules)
    extra = {k: v for k, v in P.items() if k not in fit}
    r = engine.run_on_gpu(lambda: PT.walk_forward(p, [ds[j] for j in js], horizon, fit, extra, job), "particles backtest", 3500)
    sm = r["summary"]
    n = sm["windows"]
    r["headline"] = "{}/{}".format(sm["rules_beat_persistence_sector"], n)
    r["sentence"] = ("The tool fitted your rules only on the past. They were better than “nothing changes” in {} of {} windows "
                     "on the {} picture (mean error {:.1%} against {:.1%}). They ranked who grew better than growth-carries-on alone "
                     "in {} of {} windows.").format(
        sm["rules_beat_persistence_sector"], n, p["group_name"], sm["mean"]["rules"]["sector_l1"], sm["mean"]["persistence"]["sector_l1"],
        sm["rules_beat_momentum_rank"], n)
    r["what"], r["group_name"], r["step"], r["fit_rules"] = p["what"], p["group_name"], p["step"], fit
    return r


@model("particles.refresh", "Refresh world data", R_GROUP, "Download the S&P 500 history (Wikipedia, SEC, Yahoo) or the World Bank GDP table again.",
       fields=[{"k": "source", "type": "choice", "label": "World", "choices": ["sp500", "gdp"], "default": "gdp"}],
       device="cpu", mutating=True, long=True, timeout=3600)
def refresh(job, source):
    from .. import marketdata as MD
    if source == "gdp":
        PT.worldbank_panel(refresh=True)
        return {"sentence": "The tool downloaded the World Bank GDP table again."}
    PT._P.pop("p", None)
    cov = MD.build(refresh=True, log=lambda m: job.step(0.5, m))
    PT._P.pop("p", None)
    last = cov["rows"][-1]
    return {"headline": "{} / {}".format(last["with_cap"], last["members"]), "sentence": "The tool built the S&P 500 data again: {} of {} members have a market cap on {}.".format(
        last["with_cap"], last["members"], last["date"]), "coverage": cov}
