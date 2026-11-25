"""Simulate and Forecast models, generated from the engines' own field declarations (simulate.ENGINES, forecast.SCENARIOS).
Each engine is one model; its fields are exactly the ones the Simulate app shows. A field that can be filled from a Data
Desk table in the UI (a column, or rows of items) can be filled the same way here: --<field>-table and --<field>-col."""
from .. import forecast, registry as R, simulate
from ..registry import model

NAMES = {"retirement": "forecast.retirement", "project": "forecast.project", "queue": "forecast.queue", "birthday": "forecast.birthday"}
_TYPES = {"int": "int", "float": "float", "money": "money", "num": "float", "bool": "bool", "choice": "choice", "str": "str", "text": "text"}


def _fields(spec_fields):
    out = []
    for f in spec_fields:
        g = {"k": f["k"], "type": _TYPES.get(f.get("type"), "str"), "label": f.get("label", f["k"]), "default": f.get("default")}
        if f.get("choices"):
            g["choices"] = list(f["choices"])
        for x in ("min", "max"):
            if x in f:
                g[x] = f[x]
        g["soft"] = True                       # the engines have always treated these as UI hints, not limits
        if f.get("src"):
            g["help"] = "can come from a Data Desk table: --{0}-table <table> --{0}-col <column>".format(f["k"])
        out.append(g)
        if f.get("src"):
            out.append({"k": f["k"] + "_table", "type": "table", "label": "…or from this Data Desk table"})
            out.append({"k": f["k"] + "_col", "type": "str", "label": "…that column (or, for item rows, the name column)", "default": ""})
    return out


def _from_table(src, tid, col):
    """The same fill the Simulate UI does: a column -> one number per line; rows -> 'name, low, likely, high[, chance]' lines."""
    from .. import media, sources
    if src == "column":
        meta = next((t for t in media.table_list() if t["id"] == tid), None)
        col = col or ((meta or {}).get("numeric") or [None])[0]
        s = sources.series(tid, [col], "auto")
        return "\n".join("{:.17g}".format(v) for v in s["values"][:, 0])
    r = media.table_rows(tid, None, True, None, 0, 1000)
    cols = [c.lower() for c in r["columns"]]

    def pick(*names):
        for n in names:
            for i, c in enumerate(cols):
                if c.startswith(n):
                    return i
        return None
    iname = pick(col.lower()) if col else pick("name", "item", "task", "line")
    ilo, ilk, ihi, ich = pick("low", "min", "best", "optim"), pick("likely", "mode", "most", "expected"), pick("high", "max", "worst", "pessim"), pick("chance", "prob", "risk")
    if None in (ilo, ilk, ihi):
        raise R.Refused("the table needs low, likely and high columns")
    lines = []
    for row in r["rows"]:
        nm = row[iname] if iname is not None else "item {}".format(len(lines) + 1)
        parts = [str(nm), str(row[ilo]), str(row[ilk]), str(row[ihi])] + ([str(row[ich])] if ich is not None and row[ich] not in (None, "") else [])
        lines.append(", ".join(parts))
    return "\n".join(lines)


def _register(mid, spec, runner, group, src_fields):
    fields = _fields(spec)

    def run(**p):
        params = {}
        for f in spec:
            k = f["k"]
            if f.get("src") and p.get(k + "_table"):
                params[k] = _from_table(f["src"], p[k + "_table"], p.get(k + "_col") or "")
            elif p.get(k) is not None:
                params[k] = p[k]
        return runner(params)
    return model(mid, spec_title(mid), group, spec_blurb(mid), fields=fields, timeout=240)(run)


_META = {}


def spec_title(mid):
    return _META[mid][0]


def spec_blurb(mid):
    return _META[mid][1]


for _eid, _e in simulate.ENGINES.items():
    _mid = "sim." + _eid
    _META[_mid] = (_e["name"], _e.get("blurb", ""))
    _register(_mid, _e["fields"], (lambda eid: lambda params: simulate.run(eid, params))(_eid), "sim", True)

for _sid, _s in forecast.SCENARIOS.items():
    _mid = NAMES.get(_sid, "forecast." + _sid)
    _META[_mid] = (_s["name"], _s.get("blurb", ""))
    _register(_mid, _s["params"], (lambda sid: lambda params: forecast.run(sid, params))(_sid), "forecast", False)


@model("sim.engines", "Simulation engines", "sim", "Each engine and each planning scenario, with its fields (the list in the Simulate app).", device="cpu")
def engines():
    eng = [dict(id=k, kind="general", group=v.get("group", "general"), **{x: v[x] for x in ("name", "icon", "blurb", "fields")})
           for k, v in simulate.ENGINES.items()]
    plans = [dict(id=k, kind="planning", name=v["name"], icon=v.get("icon", "forecast"), blurb=v["blurb"], fields=v["params"])
             for k, v in forecast.SCENARIOS.items() if k in ("retirement", "project", "queue")]
    return {"engines": eng, "planning": plans}
