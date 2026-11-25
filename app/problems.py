"""Problem templates: everyday problems written in the text formats the solvers read, so a person (in the UI), an
agent (over MCP) or a script (vf.solve) starts from a filled-in example of *their kind* of problem and edits it.

A template is data only. It names the model that solves it (an ordinary registered model), the parameters (the same
text boxes the UI shows) and, in plain words, how the problem maps onto the format. FORMATS describes each text
format once; the UI, the MCP resources and the Console help all read it from here.
"""

FORMATS = {
    "roster.people": {
        "title": "Roster: people", "model": "plan.roster", "field": "people",
        "text": "CSV with a header row. Columns (any order, matched by the start of the name): name; max_shifts; min_shifts; "
                "skills (a;b); unavailable (days, dates or shift names, a;b); prefers (days or shift names they would like).",
        "example": "name,max_shifts,skills,unavailable,prefers\nAna,5,nurse;senior,Sun,Early\nBen,5,nurse,,Night",
    },
    "roster.shifts": {
        "title": "Roster: shifts", "model": "plan.roster", "field": "shifts",
        "text": "CSV with a header row. Columns: shift (its name); day (a label such as Mon or Week 1, or a date); start and end "
                "(07:00, 7 or 7pm; an end before the start runs past midnight); needed (how many people); skill (one skill that each person must have).",
        "example": "shift,day,start,end,needed,skill\nEarly,Mon,07:00,15:00,2,nurse\nNight,Mon,23:00,07:00,1,nurse",
    },
    "route.stops": {
        "title": "Route: stops", "model": "plan.route", "field": "stops",
        "text": "CSV with a header row: name plus lat and lon (straight-line km), or x and y (your units), or address "
                "(looked up on OpenStreetMap). The first stop is the start.",
        "example": "name,lat,lon\nDepot,30.4021,-97.7253\nCapitol,30.2747,-97.7404\nAirport,30.1975,-97.6664",
    },
    "route.costs": {
        "title": "Route: a cost table (time, money, risk, any cost)", "model": "plan.route", "field": "costs",
        "text": "Either a matrix (line 1 names the stops; then one line per stop: its name, then the cost to each stop in the "
                "order of line 1) or from,to,cost lines. One-way costs may differ (A to B need not equal B to A). A blank, - or x "
                "means that leg is not allowed. In from,to,cost lines a pair given one way only costs the same both ways, and a pair "
                "not given is not allowed. The first stop is the start. Set unit to say what the cost is (min, $, risk points).",
        "example": "from,Depot,A,B,C\nDepot,0,12,7,20\nA,14,0,5,9\nB,7,6,0,11\nC,22,9,10,0",
    },
    "teams.people": {
        "title": "Teams: people", "model": "plan.teams", "field": "people",
        "text": "CSV with a header row: name; the first number column is the score to balance; the first text column with "
                "2 to n/2 different values is the category to spread.",
        "example": "name,rating,dept\nAvery,9,Eng\nBlake,4,Sales\nCasey,7,Eng\nDrew,6,Ops",
    },
    "teams.pairs": {
        "title": "Teams: pair rules", "model": "plan.teams", "field": "pairs",
        "text": "One rule per line: A + B (together) or A - B (apart). Words also work: A with B, A not with B. # starts a comment.",
        "example": "Avery - Kai\nBlake + Indy",
    },
    "budget.items": {
        "title": "Budget: line items", "model": "sim.budget", "field": "items",
        "text": "One item per line: name, low, likely, high. A fifth value makes it a risk that happens with that chance (30% or 0.3).",
        "example": "Design, 18000, 24000, 40000\nBuild, 60000, 85000, 150000\nRisk: vendor slips, 10000, 20000, 60000, 30%",
    },
    "project.tasks": {
        "title": "Project: tasks", "model": "forecast.project", "field": "tasks",
        "text": "One task per line, done one after another: name, best, likely, worst (days).",
        "example": "Design, 3, 5, 10\nBuild, 8, 12, 25\nTest, 3, 4, 9",
    },
    "reservoir.series": {
        "title": "Reservoir: a series to forecast", "model": "reservoir.updown", "field": "numbers",
        "text": "One number per line, oldest first, or date,value lines (the last number on a line counts; a header line is skipped). At least 120.",
        "example": "visitors\n812\n790\n845\n1204",
    },
    "reservoir.labelled": {
        "title": "Reservoir: labelled recordings", "model": "reservoir.classify", "field": "examples",
        "text": "One recording per line: label, then the values in time order separated by spaces (at least 4), or label, Sound Lab clip[, start s, end s]. "
                "At least 2 labels and 2 recordings of each. One project takes one kind: all traces or all clips.",
        "example": "still, 1.01 0.99 1.00 1.02 0.98\nwalking, 1.2 0.8 1.25 0.75 1.2\nknock, kitchen.wav, 7.0, 7.6",
    },
    "particles.group": {
        "title": "Particle Lab: a group over time", "model": "particles.group", "field": "text",
        "text": "CSV. Long: date,name,value[,group], one line for each body at each date. Wide: date,A,B,C, one column for each body. "
                "Dates: 2024-03-31, 03/31/2024, 2024 or 2024-Q1. At least 3 bodies and 4 dates; values above 0.",
        "example": "date,shop,revenue,market\n2024-Q1,Alder,41.2,home\n2024-Q1,Dune,77.0,fashion",
    },
    "history.series": {
        "title": "History: past periods", "model": "sim.history", "field": "series",
        "text": "One number per line, oldest first (an amount per period, or a level such as a price). Or a Data Desk table and column.",
        "example": "41200\n39800\n44100\n42900\n47300",
    },
}

_ROSTER_PEOPLE = ("name,max_shifts,skills,unavailable,prefers\nAna,5,nurse;senior,Sun,Early\nBen,5,nurse,,Night\nCara,4,nurse;senior,Sat;Sun,\n"
                  "Dev,5,nurse,Wed,Late\nEli,3,aide,,Early\nFay,5,nurse,Mon,\nGus,5,aide;nurse,,Night\nHana,4,nurse;senior,Fri,Late\nIvo,5,aide,Tue,\nJo,5,nurse,,Early")
_ROSTER_SHIFTS = "\n".join(["shift,day,start,end,needed,skill"] + ["{},{},{},{},{},{}".format(s, d, a, b, n, sk)
                                                                     for d in ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
                                                                     for s, a, b, n, sk in (("Early", "07:00", "15:00", 2, "nurse"), ("Late", "15:00", "23:00", 2, "nurse"),
                                                                                            ("Night", "23:00", "07:00", 1, "nurse"))])

_STAFF_PEOPLE = ("name,max_shifts,skills,unavailable,prefers\nAisha,4,backend;lead,,Lead\nBruno,4,backend;data,Week 3,\nChen,4,frontend;design,,Frontend\n"
                 "Dana,3,frontend,,\nEmeka,4,qa;backend,Week 1,QA\nFrida,4,qa,,\nGiulia,4,data;backend,,Data\nHiro,2,lead;frontend,,Lead\nIrene,4,design;frontend,Week 4,Design")
_STAFF_ROLES = "\n".join(["shift,day,start,end,needed,skill"] + ["{},{},09:00,17:00,{},{}".format(r, w, n, sk)
                                                                 for w in ("Week 1", "Week 2", "Week 3", "Week 4")
                                                                 for r, n, sk in (("Lead", 1, "lead"), ("Backend", 2, "backend"), ("Frontend", 1, "frontend"),
                                                                                  ("QA", 1, "qa"), ("Data", 1, "data"), ("Design", 1, "design"))])

_DRIVE_MIN = """from,Depot,Clinic,School,Mill,Harbour,Market,Airport,Ridge
Depot,0,14,22,31,27,12,35,40
Clinic,12,0,11,24,25,9,30,33
School,25,13,0,15,28,17,26,21
Mill,34,26,14,0,19,29,22,12
Harbour,22,22,26,21,0,16,18,30
Market,11,8,18,30,19,0,27,35
Airport,30,26,24,20,15,24,0,24
Ridge,44,36,22,13,33,39,28,0"""

_FARES = """from,to,usd
Austin,Denver,129
Austin,Chicago,158
Austin,Atlanta,141
Austin,Seattle,-
Denver,Seattle,118
Denver,Chicago,99
Denver,Boston,212
Chicago,Boston,104
Chicago,Atlanta,92
Chicago,Seattle,171
Atlanta,Boston,119
Seattle,Boston,245
Atlanta,Denver,151"""

_CHANGEOVER = """from,White,Cream,Yellow,Orange,Red,Blue,Black
White,0,10,15,20,25,25,30
Cream,25,0,10,15,20,25,30
Yellow,40,35,0,10,15,30,30
Orange,50,45,35,0,10,30,25
Red,60,55,50,35,0,25,20
Blue,60,60,55,50,40,0,15
Black,90,90,85,80,70,60,0"""

_HAZMAT = """from,to,risk
Plant,Ring road,2
Plant,Town centre,9
Plant,River bridge,5
Ring road,Depot North,3
Ring road,Depot South,4
Ring road,Town centre,6
Town centre,Depot North,4
Town centre,Depot South,3
Town centre,River bridge,7
River bridge,Depot South,2
River bridge,Depot East,3
Depot North,Depot East,6
Depot South,Depot East,4
Ring road,Depot East,5
Depot North,Depot South,5"""



def _gen_series():
    """Two years of daily museum visitors: a weekly rhythm (busy weekends), a slow rise and noise. Invented."""
    import numpy as np
    rs = np.random.RandomState(7)
    d = np.arange(730)
    week = np.array([0.82, 0.78, 0.8, 0.86, 1.0, 1.42, 1.32])[d % 7]
    v = (900 + 0.35 * d) * week * (1 + 0.05 * np.sin(2 * np.pi * d / 365.0)) * np.exp(rs.normal(0, 0.06, d.size))
    return "visitors\n" + "\n".join(str(int(round(x))) for x in v)


def _gen_sensor():
    """Pump vibration, 64 samples a turn-and-a-half: normal (broadband), imbalance (a clean once-a-turn wave), a bearing
    fault (sharp knocks at the ball-pass rate). Invented, but the three shapes are the classic ones."""
    import numpy as np
    rs = np.random.RandomState(3)
    t = np.arange(64) / 42.0                                  # in turns of the shaft

    def trace(kind):
        x = rs.normal(0, 1, t.size)
        if kind == "imbalance":
            x = 0.4 * x + 2.5 * np.sin(2 * np.pi * t + rs.uniform(0, 6))
        elif kind == "bearing":
            ph = rs.uniform(0, 1)
            x = 0.6 * x + 4 * (((t * 5.3 + ph) % 1) < 0.05)
        return " ".join("{:.2f}".format(v) for v in x)
    ex = "\n".join("{}, {}".format(k, trace(k)) for k in ("normal", "imbalance", "bearing") for _ in range(8))
    test = "\n".join(trace(k) for k in ("bearing", "normal", "imbalance"))
    return ex, test


def _gen_group():
    """Nine online shops, revenue per quarter (millions), 2019-Q1 to 2025-Q4, in three markets. Invented."""
    import numpy as np
    rs = np.random.RandomState(11)
    shops = [("Alder", "home"), ("Birch", "home"), ("Cedar", "home"), ("Dune", "fashion"), ("Ember", "fashion"),
             ("Fjord", "fashion"), ("Grove", "food"), ("Heath", "food"), ("Isle", "food")]
    g = rs.uniform(-0.01, 0.05, len(shops))
    size = rs.uniform(20, 120, len(shops))
    lines = ["date,shop,revenue,market"]
    for y in range(2019, 2026):
        for q in range(1, 5):
            for i, (nm, mk) in enumerate(shops):
                lines.append("{}-Q{},{},{:.1f},{}".format(y, q, nm, size[i], mk))
            g = 0.85 * g + 0.15 * 0.015 + rs.normal(0, 0.01, len(shops))
            size = size * np.exp(g + rs.normal(0, 0.03, len(shops)))
    return "\n".join(lines)


_SENSOR = _gen_sensor()

TEMPLATES = [
    {"id": "hospital-shifts", "title": "Hospital shifts", "app": "plan", "kind": "roster", "model": "plan.roster",
     "problem": "Nurses and aides on early, late and night shifts for a week: skills, days off, wishes, rest between shifts.",
     "maps": "Each shift on each day is a row in Shifts; each person is a row in People. A required qualification is the shift's skill; "
             "days a person cannot work go in unavailable; the shifts they like go in prefers.",
     "params": {"people": _ROSTER_PEOPLE, "shifts": _ROSTER_SHIFTS, "rest": 11, "one_a_day": True},
     "formats": ["roster.people", "roster.shifts"]},
    {"id": "team-staffing", "title": "Team design and staffing", "app": "plan", "kind": "roster", "model": "plan.roster",
     "problem": "Staff the roles of a project for four weeks (lead, backend, frontend, QA, data, design) from people with different skills.",
     "maps": "A role in a week is a 'shift': shift = the role, day = the week, needed = how many people the role needs, skill = what the role "
             "requires. max_shifts = how many weeks a person can give; unavailable = weeks away (holiday, other project); prefers = roles they want.",
     "params": {"people": _STAFF_PEOPLE, "shifts": _STAFF_ROLES, "rest": 0, "one_a_day": True},
     "formats": ["roster.people", "roster.shifts"]},
    {"id": "fair-teams", "title": "Fair teams or workshop groups", "app": "plan", "kind": "teams", "model": "plan.teams",
     "problem": "Split 24 people into 4 teams with equal total rating and a mix of departments; two pairs apart, one pair together.",
     "maps": "One row per person; the score column is what each team should have equal totals of; the category is what each team should mix.",
     "params": {"people": None, "pairs": "Avery - Kai\nBlake + Indy\nHarper - Noel", "k": 4},
     "formats": ["teams.people", "teams.pairs"]},
    {"id": "delivery-route", "title": "Delivery route (map points)", "app": "plan", "kind": "route", "model": "plan.route",
     "problem": "One van leaves the depot, visits 15 drop-offs and comes back, by the shortest straight-line distance.",
     "maps": "One row per stop with lat and lon; the first row is the depot.",
     "params": {"stops": None, "round_trip": True},
     "formats": ["route.stops"]},
    {"id": "visit-time", "title": "Visit order, cost = travel time", "app": "plan", "kind": "route", "model": "plan.route",
     "problem": "A service engineer visits seven sites. The drive times in minutes differ by direction (one-way streets, rush hour).",
     "maps": "A matrix: row = from, column = to, cell = minutes. Any cost works: put the times from your map app or your own records.",
     "params": {"costs": _DRIVE_MIN, "unit": "min", "round_trip": True},
     "formats": ["route.costs"]},
    {"id": "visit-money", "title": "Visit order, cost = money", "app": "plan", "kind": "route", "model": "plan.route",
     "problem": "A sales trip from Austin to five cities and back, on the cheapest fares. Some city pairs have no direct flight.",
     "maps": "from,to,cost lines with the fare. A fare given one way is used both ways; '-' or a pair that is not listed means no flight.",
     "params": {"costs": _FARES, "unit": "$", "round_trip": True},
     "formats": ["route.costs"]},
    {"id": "visit-risk", "title": "Visit order, cost = risk", "app": "plan", "kind": "route", "model": "plan.route",
     "problem": "A tanker of hazardous goods leaves the plant and serves four depots and two transit points. Each leg has a risk score (people near the road, bridges).",
     "maps": "from,to,risk lines. The route with the lowest total risk is not the shortest one. Legs that are not listed are not allowed.",
     "params": {"costs": _HAZMAT, "unit": "risk points", "round_trip": True},
     "formats": ["route.costs"]},
    {"id": "job-changeover", "title": "Job order, cost = changeover time", "app": "plan", "kind": "route", "model": "plan.route",
     "problem": "A paint line makes seven colours in one run. Cleaning between colours takes longer from dark to light than from light to dark.",
     "maps": "The 'stops' are jobs and the cost is the changeover time from one job to the next. One way (no return), starting with the first job.",
     "params": {"costs": _CHANGEOVER, "unit": "min cleaning", "round_trip": False},
     "formats": ["route.costs"]},
    {"id": "project-budget", "title": "Project budget risk", "app": "simulate", "kind": "budget", "model": "sim.budget",
     "problem": "What is the chance that the project costs more than 180,000, and which budget gives 80% or 90% confidence?",
     "maps": "One line per cost item with low, likely and high values; a risk has a fifth value, its chance.",
     "params": {"items": None, "budget": 180000, "sims": 1000000, "seed": 1},
     "formats": ["budget.items"]},
    {"id": "project-deadline", "title": "Project deadline", "app": "simulate", "kind": "project", "model": "forecast.project",
     "problem": "Tasks with best, likely and worst durations, one after another: what is the chance to finish in 30 days?",
     "maps": "One line per task; the durations are in days.",
     "params": {"tasks": None, "deadline": 30},
     "formats": ["project.tasks"]},
    {"id": "call-centre", "title": "Queue or call-centre staffing", "app": "simulate", "kind": "queue", "model": "forecast.queue",
     "problem": "120 calls an hour, 4 minutes a call: how long do people wait with 9 agents? Change servers to find the smallest team that keeps the wait short.",
     "maps": "arrivals = calls (or customers) per hour; service = minutes for one; servers = agents (or tills, or beds); hours = the length of the day.",
     "params": {"arrivals": 120, "service": 4, "servers": 9, "hours": 8},
     "formats": []},
    {"id": "sales-history", "title": "Odds from your own history", "app": "simulate", "kind": "history", "model": "sim.history",
     "problem": "Two years of monthly sales: what is the chance that the next six months sell more than 380,000 in total?",
     "maps": "One number per period, oldest first, or a Data Desk table and column. The model resamples blocks of your past and tests itself on it.",
     "params": {"series": None, "horizon": 6, "threshold": 380000},
     "formats": ["history.series"]},
    {"id": "series-updown", "title": "Will my series go up or down?", "app": "reservoir", "kind": "updown", "model": "reservoir.updown",
     "problem": "Two years of daily visitors: is tomorrow busier or quieter than today? Tested on the last 30% against the simple rules.",
     "maps": "One number per line, oldest first (a header line is fine), or date,value lines, or a Data Desk column. At least 120 values. "
             "Sales, visitors, a price, a reading: anything measured at regular steps. horizon = how many steps ahead.",
     "params": {"numbers": _gen_series(), "horizon": 1},
     "formats": ["reservoir.series"]},
    {"id": "sensor-classify", "title": "Classify my sound or sensor recordings", "app": "reservoir", "kind": "classify", "model": "reservoir.classify",
     "problem": "Vibration traces of a pump: normal, imbalance or a bearing fault? Learn from 24 labelled traces, label 3 new ones.",
     "maps": "One recording per line: the label, then the values in time order (any sensor: vibration, temperature, pressure, a heart rate). "
             "For sounds, write the label and the name of a Sound Lab clip, with a start and an end in seconds: 'knock, kitchen.wav, 7.0, 7.6'.",
     "params": {"examples": _SENSOR[0], "test": _SENSOR[1]},
     "formats": ["reservoir.labelled"]},
    {"id": "group-change", "title": "How will my group change?", "app": "particles", "kind": "group", "model": "particles.group",
     "problem": "Nine online shops in three markets, revenue per quarter for seven years: who grows, who fades, and which market gains share?",
     "maps": "date,name,value[,group] lines: companies by revenue, countries by GDP, teams by points, products by sales. The value is a size "
             "(above 0). A group (market, region, league) is optional. Or one column per body: date,A,B,C.",
     "params": {"text": _gen_group()},
     "formats": ["particles.group"]},
]

def _fill(t):
    """Templates with None take the model's own example value (one copy of each example, kept in the model)."""
    from . import registry as R
    m = R.get(t["model"])
    defaults = {f["k"]: f.get("default") for f in m.fields}
    p = {k: (defaults.get(k) if v is None else v) for k, v in t["params"].items()}
    return dict(t, params=p)


def listing(app=None):
    return [{k: t[k] for k in ("id", "title", "app", "kind", "model", "problem")} for t in TEMPLATES if not app or t["app"] == app]


def get(tid):
    t = next((x for x in TEMPLATES if x["id"] == tid), None)
    if not t:
        t = next((x for x in TEMPLATES if tid and tid.lower() in (x["id"] + " " + x["title"]).lower()), None)
    if not t:
        raise KeyError("no template {!r} (there are: {})".format(tid, ", ".join(x["id"] for x in TEMPLATES)))
    t = _fill(t)
    t["format_docs"] = {k: FORMATS[k] for k in t["formats"]}
    t["calls"] = calls(t["model"], t["params"])
    return t


def calls(model, params):
    """The same call, written four ways: Console (vf.run), CLI, curl and an MCP tools/call body."""
    import json

    def py(v):
        if isinstance(v, str) and "\n" in v:
            return '"""' + v.replace('"""', '\\"\\"\\"') + '"""'
        return repr(v)
    args = ", ".join("{}={}".format(k, py(v)) for k, v in params.items() if v is not None)
    from .registry import _shell
    cli = "vf run {}{}".format(model, "".join(" --{} {}".format(k, _shell(v)) for k, v in params.items() if v is not None))
    body = json.dumps({k: v for k, v in params.items() if v is not None}, ensure_ascii=False)
    return {"console": "r = vf.run({!r}, {})\nprint(r['sentence'])".format(model, args),
            "cli": cli,
            "curl": "curl -s -X POST $VF/v1/models/{} -H 'Content-Type: application/json' -d '{}'".format(model, body.replace("'", "'\\''")),
            "mcp": {"name": model.replace(".", "_"), "arguments": {k: v for k, v in params.items() if v is not None}}}
