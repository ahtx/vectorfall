"""Problem templates as models: list them, read one (its text inputs, how the problem maps onto them, and the same call
as Console code, CLI, curl and MCP), and solve one with your own changes. The solving is done by the template's own
model (plan.roster, plan.route, sim.budget ...), so the checks against baselines are the same as everywhere else."""
from .. import registry as R
from ..registry import model

G = "problem"
R.group(G, "Problems: templates of everyday problems in the solvers' text formats", "plan")


@model("problem.templates", "Problem templates", G,
       "Everyday problems already written in the solvers' text formats: hospital shifts, team staffing, fair teams, delivery routes, "
       "visit orders where the cost is time, money or risk, job changeovers, budget risk, deadlines, call-centre queues, odds from history. "
       "Start here: pick the closest template, read it with problem_template, change its text to your data, run it with problem_solve.",
       device="cpu", fields=[{"k": "app", "type": "choice", "label": "Only for this app", "choices": ["", "plan", "simulate", "reservoir", "particles"], "default": ""}])
def templates(app=""):
    from .. import problems
    return {"templates": problems.listing(app or None)}


@model("problem.template", "Read a problem template", G,
       "One template: the problem in words, how your problem maps onto its text format, the filled-in parameters, the format "
       "descriptions, and the same call as Console code, CLI, curl and an MCP tools/call.",
       device="cpu", fields=[{"k": "id", "type": "str", "label": "Template id (or part of its title)", "required": True}],
       example={"id": "visit-time"})
def template(id):
    from .. import problems
    try:
        return problems.get(id)
    except KeyError as e:
        raise R.Refused(str(e.args[0]), 404)


@model("problem.formats", "Input formats", G, "Every text format the solvers read (roster people and shifts, route stops and cost tables, "
       "team people and pair rules, budget items, project tasks, history series), with an example of each.", device="cpu")
def formats():
    from .. import problems
    return {"formats": problems.FORMATS}


@model("problem.solve", "Solve a problem from a template", G,
       "Run a template's model with the template's inputs, changed by 'changes' (an object with the same keys as the template's "
       "params, e.g. {\"costs\": \"from,A,B,C\\n...\", \"unit\": \"min\"}). The answer is the model's own result: headline, sentence, "
       "the baseline comparison and explain.",
       long=True, device="mixed", timeout=240,
       fields=[{"k": "id", "type": "str", "label": "Template id", "required": True},
               {"k": "changes", "type": "json", "label": "Parameters to change (JSON object)", "default": {}},
               {"k": "effort", "type": "choice", "label": "Effort (planner problems)", "choices": ["quick", "normal", "thorough"], "default": "quick"}],
       example={"id": "visit-time", "changes": {"round_trip": False}})
def solve(job, id, changes=None, effort="quick"):
    from .. import problems
    try:
        t = problems.get(id)
    except KeyError as e:
        raise R.Refused(str(e.args[0]), 404)
    if changes is not None and not isinstance(changes, dict):
        raise R.Refused("changes must be a JSON object, e.g. {\"budget\": 200000}")
    p = dict(t["params"])
    p.update(changes or {})
    m = R.get(t["model"])
    if any(f["k"] == "effort" for f in m.fields):
        p.setdefault("effort", effort)
    try:
        q = R.coerce(m, p)
    except R.ParamError as e:
        raise R.Refused(str(e))
    res = m.fn(job, **q) if m.long else m.fn(**q)
    if t["model"] == "forecast.queue" and isinstance(res, dict) and not res.get("explain"):
        # staffing: the same day with one server less and one more is the comparison that answers "how many?"
        import math
        s = int(q.get("servers") or 1)
        load = float(q["arrivals"]) * float(q["service"]) / 60.0
        ex = ["The work is {:g} servers' worth (arrivals x service / 60), so at least {} servers are needed to keep up; with fewer the line grows all day.".format(
            load, int(math.floor(load)) + 1)]
        for d in (-1, 1):
            if s + d >= 1:
                o = m.fn(**dict(q, servers=s + d))
                ex.append("With {} server{}: {}".format(s + d, "" if s + d == 1 else "s", o.get("sentence", o.get("headline", ""))))
        res = dict(res, explain=ex)
    if isinstance(res, dict):
        res = dict(res, template=t["id"], model_used=t["model"])
    return res
