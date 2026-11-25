"""Reservoir and Particle Lab problems in one call, from plain text or a Data Desk table (see app/labtpl.py)."""
from .. import registry as R
from ..registry import model


def _lt():
    from .. import labtpl
    return labtpl


@model("reservoir.updown", "Will my series go up or down?", "reservoir",
       "One number per line (oldest first), or date,value lines, or a Data Desk column: at least 120 values. A forecaster learns on "
       "the first 70% and is tested on the rest, in time order, against 'always the commoner move' and 'it keeps going the way it "
       "went'. Answers headline, sentence, compare_text, explain and the call for the next period. keep=true keeps the project.",
       long=True, device="mixed", timeout=600,
       fields=[{"k": "numbers", "type": "text", "label": "The series: one number per line (or date,value)"},
               {"k": "table", "type": "table", "label": "…or a Data Desk table"},
               {"k": "col", "type": "str", "label": "…and its column", "default": ""},
               {"k": "horizon", "type": "int", "label": "Steps ahead", "default": 1, "min": 1, "max": 60},
               {"k": "keep", "type": "bool", "label": "Keep the project in the Reservoir Lab", "default": False},
               {"k": "name", "type": "str", "label": "Project name (when kept)", "default": ""}])
def updown(job, numbers, table, col, horizon, keep, name):
    if not (numbers or "").strip() and not table:
        from .. import problems
        numbers = problems.get("series-updown")["params"]["numbers"]
    return _lt().updown(numbers or "", table, col or "", horizon, keep, name or "", job)


@model("reservoir.classify", "Classify my recordings", "reservoir",
       "One labelled recording per line: 'label, 0.1 0.4 0.9 …' (a sensor trace: any numbers in time order) or 'label, <Sound Lab "
       "clip>[, start s, end s]'. At least 2 labels and 2 recordings of each. Cross-validated against chance and the same readout on the "
       "raw input. 'test' lines (values or clips, no label) are labelled by the trained project.",
       long=True, device="mixed", timeout=900,
       fields=[{"k": "examples", "type": "text", "label": "Labelled recordings, one per line"},
               {"k": "test", "type": "text", "label": "New recordings to label (optional)", "default": ""},
               {"k": "keep", "type": "bool", "label": "Keep the project in the Reservoir Lab", "default": False},
               {"k": "name", "type": "str", "label": "Project name (when kept)", "default": ""}])
def classify(job, examples, test, keep, name):
    if not (examples or "").strip():
        from .. import problems
        p = problems.get("sensor-classify")["params"]
        examples, test = p["examples"], test or p.get("test", "")
    return _lt().classify(examples, test or "", keep, name or "", job)


@model("particles.group", "How will my group change?", "particles",
       "Companies, countries, teams, products: CSV 'date,name,value[,group]' lines (or 'date,A,B,C' columns), or a Data Desk table. "
       "The Particle Lab starts at the latest date whose outcome is known, fits growth carries on / fades / size effect on the window "
       "before, runs an ensemble of futures and scores them against 'nothing changes' and 'growth carries on, no interactions'.",
       long=True, device="mixed", timeout=900,
       fields=[{"k": "text", "type": "text", "label": "CSV: date,name,value[,group] or date,A,B,C"},
               {"k": "table", "type": "table", "label": "…or a Data Desk table (wide: a date column + one column per body)"},
               {"k": "horizon", "type": "int", "label": "Steps to run (0 = a third of the dates)", "default": 0, "min": 0, "max": 240},
               {"k": "fit", "type": "strs", "label": "Rules to fit before the start", "default": ["beta", "kappa", "alpha"]},
               {"k": "ens", "type": "int", "label": "Futures", "default": 128, "min": 8, "max": 512}])
def group(job, text, table, horizon, fit, ens):
    from . import particles as MP
    if not (text or "").strip() and not table:
        from .. import problems
        text = problems.get("group-change")["params"]["text"]
    src = {"source": "table", "table": table} if table else {"source": "text", "text": text}
    P = MP._panel(**src)
    T = len(P["dates"])
    h = int(horizon) or max(2, T // 3)
    if T - 1 - h < h + 2 and fit:
        h = max(2, (T - 3) // 2)                              # leave a fit window as long as the run
    res = MP.run(job, "", h, {}, list(fit or []), ens, **src)
    res["explain"] = _lt().group_explain(res, list(fit or []))
    if res.get("scores"):
        s, b, n = res["scores"]["rules"], res["scores"]["persistence"], res["scores"]["no interactions"]
        res["compare_text"] = "Wrong-group share at the end: rules {:.1%} · nothing changes {:.1%} · no interactions {:.1%}.".format(
            s["sector_l1"], b["sector_l1"], n["sector_l1"])
    for k in ("frames", "real", "dates"):                     # big arrays: the Particle Lab draws them; an agent does not need them
        res.pop(k, None)
    return res


@model("problem.check", "Check lab inputs", "problem",
       "Read the text of a Reservoir or Particle Lab problem (updown, classify, group) as the model will, without running it: what was "
       "understood, or the first error with its line. For roster, route and teams use plan_check.", device="cpu",
       fields=[{"k": "kind", "type": "choice", "label": "Problem", "choices": ["updown", "classify", "group"], "required": True},
               {"k": "text", "type": "text", "label": "The text (series, labelled recordings or CSV)", "required": True},
               {"k": "horizon", "type": "int", "label": "Steps ahead (updown)", "default": 1, "min": 1, "max": 60}],
       example={"kind": "group", "text": "date,A,B,C\n2020,1,2,3\n2021,2,3,4\n2022,3,4,5\n2023,4,5,6"})
def check(kind, text, horizon):
    return _lt().check(kind, text, horizon)
