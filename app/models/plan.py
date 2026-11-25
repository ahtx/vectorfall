"""Planner models: rosters, routes and fair teams, each solved by the GPU walk solver and checked against a classic baseline.
CSV inputs can be given as text, a file (@path), or a Data Desk table (--people-table, --shifts-table, --stops-table)."""
from .. import registry as R
from ..registry import model

EFFORT = {"k": "effort", "type": "choice", "label": "Effort", "choices": ["quick", "normal", "thorough"], "default": "normal",
          "help": "quick ≈ 10 s, normal ≈ 25 s, thorough ≈ 75 s on the card"}
MODEL = {"k": "model", "type": "text", "label": "Walk-solver model (replaces the generated one)"}


def _ex(kind, key):
    from .. import planner
    v = (planner.EXAMPLES.get(kind) or {}).get(key)
    return v if isinstance(v, str) else None


def _csv(k, label, kind):
    return [{"k": k, "type": "text", "label": label + " (CSV)", "default": _ex(kind, k)},
            {"k": k + "_table", "type": "table", "label": "…or this Data Desk table"}]


def _table_csv(tid):
    from .. import media
    import csv
    import io
    r = media.table_rows(tid, None, True, None, 0, 100000)
    b = io.StringIO()
    w = csv.writer(b)
    w.writerow(r["columns"])
    for row in r["rows"]:
        w.writerow(["" if v is None else (int(v) if isinstance(v, float) and v.is_integer() else v) for v in row])
    return b.getvalue()


def _solve(job, kind, p, csvs):
    from .. import planner
    body = {k: v for k, v in p.items() if v is not None and not k.endswith("_table")}
    for k in csvs:
        if p.get(k + "_table"):
            body[k] = _table_csv(p[k + "_table"])
    return planner.solve(kind, body, job)


@model("plan.roster", "Build a roster", "plan",
       "Who works which shift: coverage, skills, rest, one shift a day, fairness and wishes, solved on the card and compared with a greedy roster. "
       "people = CSV name,max_shifts,skills (a;b),unavailable,prefers; shifts = CSV shift,day,start,end,needed,skill. Any slot-filling problem "
       "fits: to staff project roles, make each role in each week a shift (shift = role, day = week). The result leads with headline, sentence and explain.",
       long=True, device="mixed", timeout=180,
       fields=_csv("people", "People", "roster") + _csv("shifts", "Shifts", "roster") + [
           {"k": "rest", "type": "float", "label": "Hours of rest between shifts", "default": 10, "min": 0, "max": 24},
           {"k": "one_a_day", "type": "bool", "label": "At most one shift a day", "default": True},
           {"k": "fair", "type": "float", "label": "Weight on fairness", "default": 1.0, "min": 0, "max": 5},
           {"k": "prefer", "type": "float", "label": "Weight on wishes", "default": 1.0, "min": 0, "max": 5}, EFFORT, MODEL],
       example={"effort": "quick"})
def roster(job, **p):
    return _solve(job, "roster", p, ("people", "shifts"))


@model("plan.route", "Plan a route", "plan",
       "The cheapest order to visit your stops, as a round trip or one way from the first stop. The cost is a straight-line distance "
       "(stops with lat,lon or x,y, or addresses) or any cost you give in a cost table (costs: minutes, money, risk; one-way costs may "
       "differ; blank = not allowed). Compared with nearest-neighbour, 2-opt and, for 13 stops or fewer, the proven optimum. "
       "Example: costs 'from,Depot,A,B\\nDepot,0,12,7\\nA,14,0,5\\nB,7,6,0' (\\n is a new line), unit 'min'.",
       long=True, device="mixed", timeout=180,
       fields=_csv("stops", "Stops", "route") + _csv("costs", "Cost table: a matrix (line 1 names the stops) or from,to,cost lines", "route") + [
           {"k": "unit", "type": "str", "label": "What the cost is (min, $, risk points); default km or units", "default": ""},
           {"k": "round_trip", "type": "bool", "label": "Return to the start", "default": True}, EFFORT, MODEL],
       example={"effort": "quick"})
def route(job, **p):
    if p.get("costs") or p.get("costs_table"):
        if not p.get("stops_table") and p.get("stops") == _ex("route", "stops"):
            p = dict(p, stops="")                                # the example stops are not part of a cost-table problem
    return _solve(job, "route", p, ("stops", "costs"))


@model("plan.teams", "Make fair teams", "plan",
       "Split people into k teams with equal total score and mixed categories, with together/apart rules, compared with a snake draft. "
       "people = CSV with a name, a number column (balanced) and a category column (spread); pairs = one rule per line, 'A + B' together, 'A - B' apart.",
       long=True, device="mixed", timeout=180,
       fields=_csv("people", "People", "teams") + [
           {"k": "k", "type": "int", "label": "Teams", "default": 4, "min": 2, "max": 20},
           {"k": "pairs", "type": "text", "label": "Rules, one per line: A + B (together), A - B (apart)", "default": _ex("teams", "pairs") or ""},
           {"k": "balance", "type": "float", "label": "Weight on equal scores", "default": 1.0, "min": 0, "max": 5},
           {"k": "mix", "type": "float", "label": "Weight on the mix of categories", "default": 1.0, "min": 0, "max": 5}, EFFORT, MODEL],
       example={"effort": "quick"})
def teams(job, **p):
    return _solve(job, "teams", p, ("people",))


@model("plan.check", "Check planner inputs", "plan",
       "Read a roster, route or teams problem exactly as the solver will, without solving: what was understood (sizes, columns used) "
       "and the first error with its line. Fast; use it before plan_roster, plan_route or plan_teams.", device="cpu",
       fields=[{"k": "kind", "type": "choice", "label": "Problem", "choices": ["roster", "route", "teams"], "required": True},
               {"k": "people", "type": "text", "label": "People (CSV)"}, {"k": "shifts", "type": "text", "label": "Shifts (CSV)"},
               {"k": "stops", "type": "text", "label": "Stops (CSV)"}, {"k": "costs", "type": "text", "label": "Cost table"},
               {"k": "unit", "type": "str", "label": "Cost unit"}, {"k": "pairs", "type": "text", "label": "Pair rules"},
               {"k": "k", "type": "int", "label": "Teams", "default": 4, "min": 2, "max": 20},
               {"k": "rest", "type": "float", "label": "Rest hours", "default": 10, "min": 0, "max": 24},
               {"k": "one_a_day", "type": "bool", "label": "One shift a day", "default": True},
               {"k": "round_trip", "type": "bool", "label": "Round trip", "default": True},
               {"k": "people_table", "type": "table", "label": "People from a Data Desk table"},
               {"k": "shifts_table", "type": "table", "label": "Shifts from a Data Desk table"},
               {"k": "stops_table", "type": "table", "label": "Stops from a Data Desk table"},
               {"k": "costs_table", "type": "table", "label": "Costs from a Data Desk table"}],
       example={"kind": "route", "costs": "from,Depot,A,B\nDepot,0,12,7\nA,14,0,5\nB,7,6,0", "unit": "min"})
def check(kind, **p):
    from .. import planner
    body = {k: v for k, v in p.items() if v is not None and not k.endswith("_table")}
    for k in ("people", "shifts", "stops", "costs"):
        if p.get(k + "_table"):
            body[k] = _table_csv(p[k + "_table"])
    return planner.check(kind, body)


@model("plan.examples", "Planner examples", "plan", "The example inputs for each kind of problem.", device="cpu")
def examples():
    from .. import planner
    return planner.EXAMPLES


@model("plan.save", "Save a plan as a table", "plan", "A result's table (roster, route order, teams) as a new Data Desk table.", device="cpu",
       mutating=True, fields=[{"k": "name", "type": "str", "label": "Name", "default": "plan"},
                              {"k": "table", "type": "json", "label": "{header, rows}", "required": True}])
def save(name, table):
    from .. import planner
    return planner.save_table(name or "plan", table or {})
