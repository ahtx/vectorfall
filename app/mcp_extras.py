"""MCP prompts and resources, beside the tools (every model) that api_v1 serves.

  prompts     user-chosen recipes for the main problem types. Each one tells the agent which tools to call in which
              order, the text format of the inputs (with a filled example), and how to report the answer against its
              baseline. Small local models do best when they can copy an example, so every prompt carries one.
  resources   read-only context: the problem templates, the input formats, a short guide for agents, and each Data Desk
              table as CSV (vectorfall://table/{name}).
  outputSchema  for the solver tools, so a client can read headline / sentence / explain without parsing text.
"""
import json

from . import problems

_SOLVER_OUT = {
    "type": "object",
    "properties": {
        "result": {"type": "object", "properties": {
            "headline": {"type": "string", "description": "the answer in a few characters"},
            "sentence": {"type": "string", "description": "the answer in one or two sentences"},
            "compare_text": {"type": "string", "description": "the comparison with the simple baseline"},
            "explain": {"type": "array", "items": {"type": "string"}, "description": "why: what was used, the baseline, the limits that bind"},
            "table": {"type": "object", "description": "{header, rows}: the plan as a table (plan_save keeps it in the Data Desk)"},
        }},
        "timing": {"type": "object"},
    },
    "required": ["result"],
}
OUTPUT_SCHEMAS = {"plan.roster": _SOLVER_OUT, "plan.route": _SOLVER_OUT, "plan.teams": _SOLVER_OUT, "problem.solve": _SOLVER_OUT,
                  "reservoir.updown": _SOLVER_OUT, "reservoir.classify": _SOLVER_OUT, "particles.group": _SOLVER_OUT,
                  "problem.check": None, "plan.check": {"type": "object", "properties": {"result": {"type": "object", "properties": {
                      "ok": {"type": "boolean"}, "error": {"type": "string"}, "facts": {"type": "array", "items": {"type": "string"}},
                      "warnings": {"type": "array", "items": {"type": "string"}}}}, "timing": {"type": "object"}}, "required": ["result"]}}

_REPORT = ("Report the headline and sentence, then the baseline comparison (compare_text) and the explain lines. "
           "Say plainly if the GPU result did not beat the baseline. Offer to save the plan as a Data Desk table with plan_save.")


OUTPUT_SCHEMAS["problem.check"] = OUTPUT_SCHEMAS["plan.check"]


def _ex(tid, key):
    return problems.get(tid)["params"].get(key)


def _prompts():
    return [
        {"name": "solve-from-template", "title": "Solve my problem from a template",
         "description": "Describe a problem in words; the agent finds the closest VectorFall template, fills in your data and solves it.",
         "arguments": [{"name": "problem", "description": "your problem in plain words, with your data if you have it", "required": True}]},
        {"name": "roster", "title": "Roster or staffing",
         "description": "Who works which shift, or who fills which role each week (hospital shifts, team staffing).",
         "arguments": [{"name": "people", "description": "people as CSV (name,max_shifts,skills,unavailable,prefers) or a Data Desk table name"},
                       {"name": "shifts", "description": "shifts or roles as CSV (shift,day,start,end,needed,skill) or a Data Desk table name"},
                       {"name": "rules", "description": "rules in words, e.g. 11 hours rest, one shift a day"}]},
        {"name": "route", "title": "Visit order (distance, time, money or risk)",
         "description": "The cheapest order to visit stops. The cost can be distance from coordinates, or any cost table: minutes, money, risk, changeover time.",
         "arguments": [{"name": "stops", "description": "stops as CSV with lat,lon or x,y, or addresses"},
                       {"name": "costs", "description": "a cost table: matrix (line 1 names the stops) or from,to,cost lines"},
                       {"name": "unit", "description": "what the cost is: km, min, $, risk points"},
                       {"name": "round_trip", "description": "yes to come back to the start, no for one way"}]},
        {"name": "teams", "title": "Fair teams",
         "description": "Split people into balanced teams with a mix of categories and together/apart rules.",
         "arguments": [{"name": "people", "description": "CSV with name, a score column and a category column, or a Data Desk table name"},
                       {"name": "k", "description": "how many teams"}, {"name": "rules", "description": "one per line: A + B together, A - B apart"}]},
        {"name": "budget-risk", "title": "Budget risk",
         "description": "The chance that a project costs more than its budget, and the budget for 80% or 90% confidence.",
         "arguments": [{"name": "items", "description": "one per line: name, low, likely, high[, chance for a risk]"},
                       {"name": "budget", "description": "the budget to test"}]},
        {"name": "series-updown", "title": "Will my series go up or down?",
         "description": "Forecast the direction of a series (sales, visitors, a price, a reading) and test the forecast on unseen data against the simple rules.",
         "arguments": [{"name": "series", "description": "one number per line, or a Data Desk table and column"},
                       {"name": "horizon", "description": "how many steps ahead (default 1)"}]},
        {"name": "classify-recordings", "title": "Classify my sound or sensor recordings",
         "description": "Learn labels from labelled recordings (sensor traces or Sound Lab clips), score it against chance, and label new ones.",
         "arguments": [{"name": "examples", "description": "one per line: label, values (or label, clip, start, end)"},
                       {"name": "new", "description": "recordings to label (optional)"}]},
        {"name": "group-change", "title": "How will my group change?",
         "description": "Companies, countries, teams or products over time: who grows, who fades, which group gains share; scored against 'nothing changes'.",
         "arguments": [{"name": "data", "description": "CSV date,name,value[,group], or a Data Desk table"}]},
        {"name": "queue-staffing", "title": "Queue or call-centre staffing",
         "description": "How long people wait for a given number of servers (agents, tills, beds), and the smallest number that keeps the wait short.",
         "arguments": [{"name": "arrivals", "description": "arrivals per hour"}, {"name": "service", "description": "minutes per service"},
                       {"name": "target", "description": "the longest average wait that is acceptable, in minutes"}]},
    ]


def _get_prompt(name, a):
    a = {k: (str(v) if v is not None else "") for k, v in (a or {}).items()}
    if name == "solve-from-template":
        text = ("Solve this problem with VectorFall: {p}\n\nSteps:\n"
                "1. Call problem_templates and choose the template closest to the problem (read its 'problem' text).\n"
                "2. Call problem_template with that id. Read 'maps' (how a problem maps onto the format), 'params' (a filled example) and 'format_docs'.\n"
                "3. Write the user's data in the same text format. Keep the header lines. If the data is in the Data Desk, call data_list and pass the table name in the *_table parameter instead.\n"
                "4. For roster, route and teams, call plan_check with kind and the same inputs. If ok is false, fix the line it names and check again.\n"
                "5. Call problem_solve with the id and changes = an object holding only the parameters you changed (or call the template's own model tool directly).\n"
                "6. " + _REPORT).format(p=a.get("problem") or "(the user will describe it)")
    elif name == "roster":
        text = ("Make a roster with VectorFall.\nPeople: {pe}\nShifts or roles: {sh}\nRules: {ru}\n\n"
                "Format (CSV, header row first):\npeople:\n{ex_p}\nshifts:\n{ex_s}\n"
                "For staffing roles over weeks, make each role in each week a shift: shift = role, day = week, start 09:00, end 17:00, rest 0.\n"
                "Steps: plan_check (kind roster) until ok, then plan_roster with people, shifts, rest, one_a_day and effort normal "
                "(or people_table / shifts_table with Data Desk table names). " + _REPORT).format(
            pe=a.get("people") or "(ask the user, or use a Data Desk table)", sh=a.get("shifts") or "(ask the user)", ru=a.get("rules") or "rest 10 hours, one shift a day",
            ex_p=problems.FORMATS["roster.people"]["example"], ex_s=problems.FORMATS["roster.shifts"]["example"])
    elif name == "route":
        text = ("Find the best visit order with VectorFall.\nStops: {st}\nCost table: {co}\nUnit: {un}\nRound trip: {rt}\n\n"
                "If the cost is a distance between map points, give stops as CSV:\n{ex_s}\n"
                "If the cost is anything else (minutes, money, risk, changeover time), give costs as a matrix:\n{ex_c}\n"
                "or as from,to,cost lines (a pair given one way costs the same both ways; a missing pair is not allowed):\nfrom,to,usd\nAustin,Denver,129\nDenver,Boston,212\n"
                "Steps: plan_check (kind route) until ok, then plan_route with stops or costs, unit, round_trip and effort normal. " + _REPORT).format(
            st=a.get("stops") or "(none)", co=a.get("costs") or "(none)", un=a.get("unit") or "km for map points, else ask", rt=a.get("round_trip") or "yes",
            ex_s=problems.FORMATS["route.stops"]["example"], ex_c=problems.FORMATS["route.costs"]["example"])
    elif name == "teams":
        text = ("Make fair teams with VectorFall.\nPeople: {pe}\nTeams: {k}\nRules: {ru}\n\nFormat:\npeople:\n{ex}\npairs (one per line):\nAvery - Kai\nBlake + Indy\n"
                "Steps: plan_check (kind teams) until ok, then plan_teams with people (or people_table), k, pairs and effort normal. " + _REPORT).format(
            pe=a.get("people") or "(ask the user, or use a Data Desk table)", k=a.get("k") or "4", ru=a.get("rules") or "(none)", ex=problems.FORMATS["teams.people"]["example"])
    elif name == "budget-risk":
        text = ("Find the budget risk with VectorFall.\nItems: {it}\nBudget: {b}\n\nFormat, one item per line (a fifth value = a risk with that chance):\n{ex}\n"
                "Steps: call sim_budget with items, budget and sims 1000000. Report the chance of going over, the budgets for 80% and 90% confidence, "
                "and how often the plain sum of the likely values is enough (the baseline).").format(
            it=a.get("items") or "(ask the user)", b=a.get("budget") or "(ask the user)", ex=problems.FORMATS["budget.items"]["example"])
    elif name == "series-updown":
        text = ("Forecast the direction of a series with VectorFall.\nSeries: {se}\nSteps ahead: {h}\n\n"
                "Format: one number per line, oldest first (a header line is fine), at least 120 values:\nvisitors\n812\n790\n845\n"
                "Steps: problem_check with kind updown and the text until ok (or give table and col instead of numbers), then reservoir_updown "
                "with numbers (or table, col) and horizon. Report the headline, the sentence and compare_text: the forecaster against 'always the "
                "commoner move' and 'it keeps going the way it went', on the last 30% that it never saw. If the verdict says no edge, say so plainly.").format(
            se=a.get("series") or "(ask the user, or use a Data Desk table)", h=a.get("horizon") or "1")
    elif name == "classify-recordings":
        text = ("Classify recordings with VectorFall.\nExamples: {ex}\nNew recordings: {nw}\n\n"
                "Format, one recording per line: label, then the values in time order separated by spaces (at least 4):\n"
                "normal, 0.3 -1.2 0.8 0.1 -0.4\nbearing, 0.2 4.1 -0.3 0.1 3.9\n"
                "For sounds, the label and a Sound Lab clip with a start and an end in seconds: knock, kitchen.wav, 7.0, 7.6 (sound_list names the clips).\n"
                "Give at least 2 labels and 2 recordings of each. Steps: problem_check with kind classify until ok, then reservoir_classify with "
                "examples and test (the new recordings, one per line, no label). Report the cross-validated accuracy against chance and against the "
                "same readout on the raw input, the commonest mistake, and the labels of the new recordings.").format(
            ex=a.get("examples") or "(ask the user)", nw=a.get("new") or "(none)")
    elif name == "group-change":
        text = ("Model how a group changes with VectorFall's Particle Lab.\nData: {d}\n\n"
                "Format: CSV, one line for each body at each date: date,name,value[,group], values above 0, at least 3 bodies and 4 dates:\n"
                "date,shop,revenue,market\n2024-Q1,Alder,41.2,home\n2024-Q1,Dune,77.0,fashion\n"
                "Steps: problem_check with kind group until ok, then particles_group with text (or table). It starts at the latest date whose "
                "outcome is known, fits the rules on the window before, and scores the run. Report compare_text (rules against 'nothing changes' and "
                "'no interactions') and the explain lines; say plainly when the rules do not beat 'nothing changes'.").format(
            d=a.get("data") or "(ask the user, or use a Data Desk table)")
    elif name == "queue-staffing":
        text = ("Size a queue with VectorFall.\nArrivals per hour: {ar}\nMinutes per service: {sv}\nAcceptable average wait: {tg} min\n\n"
                "Steps: the work is arrivals x service / 60 servers' worth; the team must be larger than that, or the line grows all day. Call forecast_queue with "
                "arrivals, service, hours 8 and servers = the next whole number above it, then one more at a time, until the average wait is at or below the target. "
                "Report the wait and the busy share for each number of servers you tried, and the smallest number that meets the target.").format(
            ar=a.get("arrivals") or "(ask)", sv=a.get("service") or "(ask)", tg=a.get("target") or "2")
    else:
        return None
    return {"description": next(p["description"] for p in _prompts() if p["name"] == name),
            "messages": [{"role": "user", "content": {"type": "text", "text": text}}]}


GUIDE = """VectorFall for agents

Every VectorFall operation is a tool (model name with _ for .). The tools for your own problems:
  problem_templates -> problem_template(id) -> plan_check -> problem_solve(id, changes)   start from a template
  plan_roster, plan_route, plan_teams                                                    the solvers (text inputs)
  sim_budget, forecast_project, forecast_queue, sim_history                              simulations
  reservoir_updown, reservoir_classify, particles_group, problem_check                   the labs (text inputs)
  data_list, data_upload, plan_save                                                      Data Desk tables in and out
Inputs are short text formats (resources vectorfall://format/{key}). Any parameter that ends in _table takes a Data Desk
table by id or part of its name. Every answer comes with a baseline (greedy roster, nearest-neighbour route, snake draft,
the sum of likely values, a backtest): report it. Long tools take 10-75 s; vf_start + vf_job run them in the background.
"""


def _resources():
    out = [{"uri": "vectorfall://guide/agents", "name": "agent-guide", "title": "How to use VectorFall's tools", "mimeType": "text/plain"},
           {"uri": "vectorfall://templates", "name": "templates", "title": "Problem templates (list)", "mimeType": "application/json"}]
    out += [{"uri": "vectorfall://template/" + t["id"], "name": "template-" + t["id"], "title": "Template: " + t["title"],
             "description": t["problem"], "mimeType": "application/json"} for t in problems.TEMPLATES]
    out += [{"uri": "vectorfall://format/" + k, "name": "format-" + k, "title": "Format: " + f["title"], "mimeType": "text/plain"}
            for k, f in problems.FORMATS.items()]
    return out


def _templates():
    return [{"uriTemplate": "vectorfall://template/{id}", "name": "template", "title": "A problem template", "mimeType": "application/json"},
            {"uriTemplate": "vectorfall://format/{key}", "name": "format", "title": "An input format", "mimeType": "text/plain"},
            {"uriTemplate": "vectorfall://table/{name}", "name": "table", "title": "A Data Desk table as CSV (id or part of the name)", "mimeType": "text/csv"}]


def _read(uri):
    if uri == "vectorfall://guide/agents":
        return "text/plain", GUIDE
    if uri == "vectorfall://templates":
        return "application/json", json.dumps({"templates": problems.listing()}, ensure_ascii=False, indent=1)
    if uri.startswith("vectorfall://template/"):
        return "application/json", json.dumps(problems.get(uri.split("/", 3)[3]), ensure_ascii=False, indent=1)
    if uri.startswith("vectorfall://format/"):
        k = uri.split("/", 3)[3]
        f = problems.FORMATS.get(k)
        if not f:
            raise KeyError("no format {!r} (there are: {})".format(k, ", ".join(problems.FORMATS)))
        return "text/plain", "{}\nUsed by {} --{}\n\n{}\n\nExample:\n{}\n".format(f["title"], f["model"], f["field"], f["text"], f["example"])
    if uri.startswith("vectorfall://table/"):
        import urllib.parse
        from . import registry as R
        from .models.plan import _table_csv
        tid = R._resolve("table", urllib.parse.unquote(uri.split("/", 3)[3]))
        return "text/csv", _table_csv(tid)
    raise KeyError("unknown resource {}".format(uri))


def handle(meth, p):
    """-> a result object, or None when meth is not a prompts/resources method. Raises KeyError for an unknown name."""
    if meth == "prompts/list":
        return {"prompts": _prompts()}
    if meth == "prompts/get":
        r = _get_prompt(p.get("name", ""), p.get("arguments"))
        if r is None:
            raise KeyError("no prompt {!r} (there are: {})".format(p.get("name"), ", ".join(x["name"] for x in _prompts())))
        return r
    if meth == "resources/list":
        return {"resources": _resources()}
    if meth == "resources/templates/list":
        return {"resourceTemplates": _templates()}
    if meth == "resources/read":
        uri = p.get("uri", "")
        mime, text = _read(uri)
        return {"contents": [{"uri": uri, "mimeType": mime, "text": text}]}
    return None
