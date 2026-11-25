"""Planner: real scheduling and routing problems, solved by the walk solver on the card.

Three problems people actually have, each read from plain tables (pasted CSV or Data Desk tables):

  roster  people (max/min shifts, skills, days they can't work, shifts they'd like) x shifts (day, start, end, how many
          people, required skill) + rules (hours of rest between shifts, one shift a day) -> who works what.
  route   stops (lat/lon, x/y, or street addresses looked up on OpenStreetMap) -> the shortest order to visit them,
          as a round trip or one way from the first stop.
  teams   people with an optional score and category -> k balanced teams, honouring "together" and "apart" pairs.

Nothing is hidden: each problem is compiled into an ordinary walk-solver model (variables, constraints, an objective
-- readable, and openable in Simulate), and solved there by thousands of GPU walkers. Every answer is then
re-checked here by an independent evaluator and set beside a simple baseline anyone could do by hand (a greedy
roster, nearest-neighbour + 2-opt routes, a snake draft), so you can see whether the card earned its keep.
"""
import csv
import io
import itertools
import json
import math
import os
import re
import time
import urllib.parse
import urllib.request

import numpy as np

from . import sources, walksolve

GEO_CACHE = "/srv/data/geocache.json"


# ================================================================ tables in, tables out
def read_csv(text):
    text = (text or "").strip()
    if not text:
        return [], []
    try:
        dialect = csv.Sniffer().sniff(text[:4000], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    rows = [r for r in csv.reader(io.StringIO(text), dialect) if any(c.strip() for c in r)]
    if not rows:
        return [], []
    head = [h.strip().lower() for h in rows[0]]
    out = []
    for r in rows[1:]:
        out.append({h: (r[i].strip() if i < len(r) else "") for i, h in enumerate(head)})
    return head, out


def _col(head, *names):
    for n in names:
        for h in head:
            if h == n or h.startswith(n):
                return h
    return None


def _num(v, default=None):
    try:
        return float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return default


def _tags(v):
    return [t.strip().lower() for t in re.split(r"[;|/]", v or "") if t.strip()]


def _hm(v):
    m = re.match(r"^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$", (v or "").lower())
    if not m:
        raise ValueError("cannot read the time '{}' (use 07:00 or 7pm)".format(v))
    h, mi = int(m.group(1)), int(m.group(2) or 0)
    if m.group(3) == "pm" and h < 12:
        h += 12
    if m.group(3) == "am" and h == 12:
        h = 0
    return h + mi / 60.0


# ================================================================ roster
def _roster(people_csv, shifts_csv, rest=10.0, one_a_day=True, fair=1.0, prefer=1.0):
    ph, people = read_csv(people_csv)
    sh, shifts = read_csv(shifts_csv)
    if not people or not shifts:
        raise ValueError("add at least one person and one shift")
    c_name, c_max, c_min = _col(ph, "name", "person"), _col(ph, "max"), _col(ph, "min")
    c_sk, c_un, c_pr = _col(ph, "skill"), _col(ph, "unavail", "off", "cannot", "can't"), _col(ph, "prefer", "like")
    s_name, s_day, s_start = _col(sh, "shift", "name"), _col(sh, "day", "date"), _col(sh, "start", "from")
    s_end, s_need, s_sk = _col(sh, "end", "to", "until"), _col(sh, "need", "people", "staff", "count"), _col(sh, "skill", "requires")
    if not (s_day and s_start and s_end):
        raise ValueError("shifts need day, start and end columns")
    P = len(people)
    names = [(p.get(c_name) or "person {}".format(i + 1)) for i, p in enumerate(people)]
    maxs = [int(_num(p.get(c_max), 1e6)) if c_max else 10 ** 6 for p in people]
    mins = [int(_num(p.get(c_min), 0)) if c_min else 0 for p in people]
    skills = [set(_tags(p.get(c_sk))) for p in people]
    unav = [set(_tags(p.get(c_un))) for p in people]
    prefs = [set(_tags(p.get(c_pr))) for p in people]
    days = []
    S = []
    for i, s in enumerate(shifts):
        d = s.get(s_day, "")
        if d not in days:
            days.append(d)
        dt = sources.parse_date(d)
        S.append({"name": s.get(s_name) or "shift {}".format(i + 1), "day": d, "date": dt, "start": _hm(s.get(s_start)),
                  "end": _hm(s.get(s_end)), "need": int(_num(s.get(s_need), 1)) if s_need else 1,
                  "skill": (s.get(s_sk) or "").strip().lower() if s_sk else ""})
    dated = all(x["date"] for x in S)
    if dated:
        d0 = min(x["date"] for x in S)
        for x in S:
            x["di"] = (x["date"] - d0).days
    else:
        for x in S:
            x["di"] = days.index(x["day"])
    for x in S:
        x["t0"] = x["di"] * 24 + x["start"]
        x["t1"] = x["t0"] + ((x["end"] - x["start"]) % 24 or 24)
    nS = len(S)
    OK = np.zeros((P + 1, nS), np.int32)
    PR = np.zeros((P + 1, nS), np.int32)
    why = {}
    for p in range(P):
        for j, x in enumerate(S):
            keys = {x["name"].lower(), x["day"].lower(), "{} {}".format(x["day"], x["name"]).lower()}
            if x["date"]:
                keys.add(x["date"].strftime("%a").lower())
                keys.add(x["date"].strftime("%A").lower())
            if x["skill"] and x["skill"] not in skills[p]:
                why[(p, j)] = "lacks " + x["skill"]
                continue
            if keys & unav[p]:
                why[(p, j)] = "unavailable"
                continue
            OK[p, j] = 1
            PR[p, j] = 1 if keys & prefs[p] else 0
    OK[P, :] = 1                                                 # "nobody": an open slot (allowed, but expensive)
    slot_shift = [j for j, x in enumerate(S) for _ in range(max(0, x["need"]))]
    K = len(slot_shift)
    if K == 0:
        raise ValueError("no shift needs anybody")
    if K > 600:
        raise ValueError("{} slots is more than the solver holds per walker (600)".format(K))
    clash = np.zeros((nS, nS), bool)
    for a in range(nS):
        for b in range(nS):
            if a == b:
                clash[a, b] = True
                continue
            gap = max(S[b]["t0"] - S[a]["t1"], S[a]["t0"] - S[b]["t1"])
            if gap < rest or (one_a_day and S[a]["di"] == S[b]["di"]):
                clash[a, b] = True
    CONF = [(i, k) for i in range(K) for k in range(i + 1, K) if clash[slot_shift[i], slot_shift[k]]]
    if len(CONF) > 20000:
        raise ValueError("{:,} clash pairs of slots are too many for one model. Plan one or two weeks at a time".format(len(CONF)))
    # fair share: equal load, capped by each person's max and by how many slots they could work at all
    cap = np.array([min(maxs[p], int(OK[p, slot_shift].sum())) for p in range(P)], np.float64)
    lo, hi = 0.0, float(K)
    for _ in range(60):
        mid = (lo + hi) / 2
        if np.minimum(cap, mid).sum() < K:
            lo = mid
        else:
            hi = mid
    tgt = np.maximum(np.minimum(cap, hi), mins)
    # diagnosis before solving: shifts that can't possibly be covered
    short = []
    for j, x in enumerate(S):
        el = int(OK[:P, j].sum())
        if el < x["need"]:
            short.append("{} {} needs {} but only {} {} eligible".format(x["day"], x["name"], x["need"], el, "is" if el == 1 else "are"))
    big = 50.0 * (1 + fair + prefer)
    model = "\n".join([
        "# Roster: {} people, {} shifts, {} slots to fill. Generated from your tables by the Planner — edit freely.".format(P, nS, K),
        "# x[k] = who works slot k (0..{} are people; {} means that the slot stays open. This is permitted, but it costs {:g}).".format(P - 1, P, big),
        "P = {}".format(P), "K = {}".format(K),
        "SHIFT = {}".format(json.dumps(slot_shift).replace(" ", "")),
        "OK = {}          # OK[person][shift] = 1 if they have the skill and are available".format(json.dumps(OK.tolist()).replace(" ", "")),
        "PREF = {}        # PREF[person][shift] = 1 if they asked for it".format(json.dumps(PR.tolist()).replace(" ", "")),
        "MAXS = {}".format(json.dumps([int(min(m, K)) for m in maxs])), "MINS = {}".format(json.dumps(mins)),
        "TGT = {}         # fair share for each person".format(json.dumps([round(float(t), 2) for t in tgt])),
        "CONF = {}        # slot pairs that one person cannot both work (same shift, overlap, < {:g} h rest{})".format(
            json.dumps(CONF).replace(" ", "") if CONF else "[(0,0)]", rest, ", one a day" if one_a_day else ""),
        "var x[K] int 0..P",
        "all(OK[x[k]][SHIFT[k]] == 1 for k in range(K))",
        "all(x[a] != x[b] or x[a] == P for (a, b) in CONF)" if CONF else "",
        "all(count(1 for k in range(K) if x[k] == p) <= MAXS[p] for p in range(P))",
        "all(count(1 for k in range(K) if x[k] == p) >= MINS[p] for p in range(P))" if any(mins) else "",
        "minimize: {:g} * count(1 for k in range(K) if x[k] == P) + {:g} * sum((count(1 for k in range(K) if x[k] == p) - TGT[p]) ** 2 for p in range(P)) - {:g} * sum(PREF[x[k]][SHIFT[k]] for k in range(K))".format(big, fair, prefer),
        "penalty: {:g}".format(big * 2),
    ])
    ctx = {"names": names, "S": S, "slot_shift": slot_shift, "OK": OK, "PR": PR, "maxs": maxs, "mins": mins, "tgt": tgt,
           "clash": clash, "why": why, "P": P, "days": days if not dated else sorted({x["day"] for x in S}, key=lambda d: sources.parse_date(d)),
           "short": short}
    return model, ctx


def _roster_eval(x, c):
    P, S, ss = c["P"], c["S"], c["slot_shift"]
    breaks, open_ = [], 0
    load = np.zeros(P, int)
    for k, p in enumerate(x):
        if p < 0 or p >= P:
            open_ += 1
            continue
        load[p] += 1
        if not c["OK"][p, ss[k]]:
            breaks.append("{} on {} {} ({})".format(c["names"][p], S[ss[k]]["day"], S[ss[k]]["name"], c["why"].get((p, ss[k]), "not allowed")))
    for a in range(len(x)):
        for b in range(a + 1, len(x)):
            if 0 <= x[a] < P and x[a] == x[b] and c["clash"][ss[a], ss[b]]:
                sa, sb = S[ss[a]], S[ss[b]]
                breaks.append("{} works {} {} and {} {} (too close)".format(c["names"][x[a]], sa["day"], sa["name"], sb["day"], sb["name"]))
    for p in range(P):
        if load[p] > c["maxs"][p]:
            breaks.append("{} has {} shifts (max {})".format(c["names"][p], load[p], c["maxs"][p]))
        if load[p] < c["mins"][p]:
            breaks.append("{} has {} shifts (min {})".format(c["names"][p], load[p], c["mins"][p]))
    pref = sum(1 for k, p in enumerate(x) if 0 <= p < P and c["PR"][p, ss[k]])
    want = int(sum(c["PR"][p, ss[k]] for k in range(len(x)) for p in range(P)) > 0)
    return {"open": open_, "breaks": breaks, "load": load.tolist(), "spread": int(load.max() - load.min()) if P else 0,
            "unfair": round(float(((load - c["tgt"]) ** 2).sum()), 2), "prefs": pref, "has_prefs": bool(want)}


def _roster_greedy(c):
    P, ss = c["P"], c["slot_shift"]
    K = len(ss)
    x = [-1] * K
    load = np.zeros(P, int)
    elig = [int(c["OK"][:P, ss[k]].sum()) for k in range(K)]
    for k in sorted(range(K), key=lambda k: (elig[k], c["S"][ss[k]]["t0"])):
        best = None
        for p in range(P):
            if not c["OK"][p, ss[k]] or load[p] >= c["maxs"][p]:
                continue
            if any(x[q] == p and c["clash"][ss[k], ss[q]] for q in range(K)):
                continue
            key = (load[p] - c["tgt"][p], -int(c["PR"][p, ss[k]]), p)
            if best is None or key < best[0]:
                best = (key, p)
        if best:
            x[k] = best[1]
            load[best[1]] += 1
    return x


def _roster_out(x, c):
    S, ss, names = c["S"], c["slot_shift"], c["names"]
    by = {}
    for k, p in enumerate(x):
        by.setdefault(ss[k], []).append(names[p] if 0 <= p < c["P"] else None)
    grid = []
    for p in range(c["P"]):
        row = {}
        for k, q in enumerate(x):
            if q == p:
                s = S[ss[k]]
                row.setdefault(s["day"], []).append(s["name"])
        grid.append({"name": names[p], "days": row})
    shifts = [{"day": s["day"], "name": s["name"], "start": s["start"], "end": s["end"], "need": s["need"],
               "who": by.get(j, [])} for j, s in enumerate(S)]
    rows = [[s["day"], s["name"], _fmt_h(s["start"]), _fmt_h(s["end"]), w or "(open)"] for s in shifts for w in (s["who"] or [None])]
    return {"grid": grid, "days": c["days"], "shifts": shifts, "table": {"header": ["day", "shift", "start", "end", "person"], "rows": rows}}


def _fmt_h(h):
    return "{:02d}:{:02d}".format(int(h) % 24, int(round((h % 1) * 60)))


# ================================================================ route
def geocode(addresses, job=None):
    cache = {}
    if os.path.exists(GEO_CACHE):
        try:
            with open(GEO_CACHE) as f:
                cache = json.load(f)
        except Exception:  # noqa: BLE001
            cache = {}
    out = []
    for i, a in enumerate(addresses):
        key = a.strip().lower()
        if key not in cache:
            url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + urllib.parse.quote(a)
            req = urllib.request.Request(url, headers={"User-Agent": "VectorFall/1.0 (homelab route planner)"})
            try:
                d = json.loads(urllib.request.urlopen(req, timeout=20).read().decode())
                cache[key] = [float(d[0]["lat"]), float(d[0]["lon"]), d[0].get("display_name", "")] if d else None
            except Exception:  # noqa: BLE001
                cache[key] = None
            time.sleep(1.05)                                     # OpenStreetMap's usage policy: one lookup a second
            if job:
                job.step((i + 1) / len(addresses) * 0.6, "looked up {} of {} addresses".format(i + 1, len(addresses)))
        out.append(cache[key])
    try:
        with open(GEO_CACHE + ".tmp", "w") as f:
            json.dump(cache, f)
        os.replace(GEO_CACHE + ".tmp", GEO_CACHE)
    except OSError:
        pass
    return out


def read_costs(text):
    """A cost table in either of two shapes, any unit (km, minutes, dollars, risk points), one-way costs allowed:

      matrix      the first row names the stops, then one row per stop:  from,Depot,A,B / Depot,0,12,7 / A,11,0,5 / ...
                  the cell in row R, column C is the cost of going from R to C; blank, "-" or "x" = not allowed
      edge list   columns from,to,cost (the third column can be called time, minutes, price, risk ...); a pair that is
                  given in one direction only costs the same both ways; a pair that is not given is not allowed

    Returns (names, D with NaN for "not allowed", notes). Errors name the line (line 1 is the header)."""
    lines = [(i + 1, ln) for i, ln in enumerate((text or "").replace("\r", "").split("\n")) if ln.strip() and not ln.lstrip().startswith("#")]
    if not lines:
        raise ValueError("the cost table is empty")
    try:
        dialect = csv.Sniffer().sniff("\n".join(ln for _, ln in lines[:20]), delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    rows = [(no, [c.strip() for c in next(csv.reader([ln], dialect))]) for no, ln in lines]
    head = [h.lower() for h in rows[0][1]]
    blank = ("", "-", "x", "none", "n/a", "na", "inf")
    notes = []
    if len(head) >= 3 and head[0].startswith(("from", "origin", "source")) and head[1].startswith(("to", "dest", "target")):
        names, idx, E = [], {}, {}
        for no, r in rows[1:]:
            if len(r) < 3:
                raise ValueError("line {}: needs from, to and a cost (got {!r})".format(no, ",".join(r)))
            a, b, v = r[0], r[1], r[2]
            if not a or not b:
                raise ValueError("line {}: a stop name is blank".format(no))
            if a == b:
                raise ValueError("line {}: from and to are the same stop ({})".format(no, a))
            for nm in (a, b):
                if nm not in idx:
                    idx[nm] = len(names)
                    names.append(nm)
            if v.lower() in blank:
                E[(idx[a], idx[b])] = float("nan")
                continue
            c = _num(v)
            if c is None:
                raise ValueError("line {}: the cost {!r} is not a number".format(no, v))
            if c < 0:
                raise ValueError("line {}: the cost {} is below zero".format(no, v))
            E[(idx[a], idx[b])] = c
        n = len(names)
        D = np.full((n, n), np.nan)
        np.fill_diagonal(D, 0.0)
        mirrored = 0
        for (a, b), c in E.items():
            D[a, b] = c
        for (a, b), c in E.items():
            if (b, a) not in E:
                D[b, a] = c
                mirrored += 1
        if mirrored:
            notes.append("{} pair{} given one way only: the same cost is used both ways".format(mirrored, "" if mirrored == 1 else "s"))
        return names, D, notes
    # matrix: the header's first cell is a label (or blank); the row names must be the column names
    cols = rows[0][1][1:]
    if len(cols) < 2:
        raise ValueError("line 1: a cost matrix needs a header row that names the stops (from,A,B,C), or use from,to,cost lines")
    n = len(cols)
    if len(set(cols)) != n:
        raise ValueError("line 1: the same stop name is there two times")
    D = np.full((n, n), np.nan)
    seen = {}
    for no, r in rows[1:]:
        nm = r[0]
        if nm not in cols:
            raise ValueError("line {}: the row name {!r} is not one of the stops in line 1 ({})".format(
                no, nm, ", ".join(cols[:6]) + (" …" if n > 6 else "")))
        if nm in seen:
            raise ValueError("line {}: {} has a row already (line {})".format(no, nm, seen[nm]))
        seen[nm] = no
        vals = r[1:]
        if len(vals) != n:
            raise ValueError("line {}: {} values, but line 1 names {} stops".format(no, len(vals), n))
        i = cols.index(nm)
        for j, v in enumerate(vals):
            if i == j:
                D[i, j] = 0.0
                continue
            if v.lower() in blank:
                continue
            c = _num(v)
            if c is None:
                raise ValueError("line {}, column {} ({}): {!r} is not a number".format(no, j + 2, cols[j], v))
            if c < 0:
                raise ValueError("line {}, column {} ({}): the cost {} is below zero".format(no, j + 2, cols[j], v))
            D[i, j] = c
    missing = [c for c in cols if c not in seen]
    if missing:
        raise ValueError("no row for {} (each stop in line 1 needs its own row)".format(", ".join(missing[:6])))
    return list(cols), D, notes


def _stop_points(stops_csv, names):
    """Coordinates for a cost-table route, from a stops table with the same names (for the map). None when absent."""
    if not (stops_csv or "").strip():
        return None, None
    try:
        h, rows = read_csv(stops_csv)
        cn, cla, clo, cx, cy = _col(h, "name", "stop", "place"), _col(h, "lat"), _col(h, "lon", "lng", "long"), _col(h, "x"), _col(h, "y")
        a, b, unit = (cla, clo, "km") if cla and clo else (cx, cy, "units")
        if not (cn and a and b):
            return None, None
        where = {r.get(cn): (_num(r.get(a)), _num(r.get(b))) for r in rows}
        if all(where.get(nm, (None, None))[0] is not None and where[nm][1] is not None for nm in names):
            return [list(where[nm]) for nm in names], unit
    except Exception:  # noqa: BLE001
        pass
    return None, None


def _route(stops_csv, round_trip=True, job=None, costs="", unit=""):
    notes, forbid = [], None
    if (costs or "").strip():
        names, D, notes = read_costs(costs)
        n = len(names)
        if n < 3:
            raise ValueError("a route needs at least 3 stops")
        if n > 120:
            raise ValueError("at most 120 stops")
        forbid = np.isnan(D)
        np.fill_diagonal(forbid, False)
        fin = D[~np.isnan(D)]
        big = round(float(max(1.0, fin.max() if fin.size else 1.0)) * n * 10, 3)
        D = np.where(np.isnan(D), big, D)
        geo = (unit or "").strip() or "cost"
        sym = bool(np.allclose(D, D.T))
        if forbid.any():
            notes.append("{} leg{} not allowed (a leg that is used anyway costs {:g})".format(int(forbid.sum()), "" if forbid.sum() == 1 else "s", big))
        model_note = "D[a][b] is the cost from stop a to stop b, in {}{}".format(geo, "" if sym else " (one-way costs differ)")
        pts, pts_unit = _stop_points(stops_csv, names)
    else:
        head, rows = read_csv(stops_csv)
        if len(rows) < 3:
            raise ValueError("a route needs at least 3 stops")
        if len(rows) > 120:
            raise ValueError("at most 120 stops")
        c_name = _col(head, "name", "stop", "place")
        c_lat, c_lon = _col(head, "lat"), _col(head, "lon", "lng", "long")
        c_x, c_y = _col(head, "x"), _col(head, "y")
        c_addr = _col(head, "address", "addr", "location", "where")
        names = [(r.get(c_name) or r.get(c_addr) or "stop {}".format(i + 1)) for i, r in enumerate(rows)]
        geo = "km"
        missing = []
        if c_lat and c_lon:
            pts = [(_num(r.get(c_lat)), _num(r.get(c_lon))) for r in rows]
        elif c_x and c_y:
            pts = [(_num(r.get(c_x)), _num(r.get(c_y))) for r in rows]
            geo = "units"
        elif c_addr:
            g = geocode([r.get(c_addr) or "" for r in rows], job)
            pts = [(v[0], v[1]) if v else (None, None) for v in g]
            missing = [names[i] for i, v in enumerate(g) if not v]
        else:
            raise ValueError("stops need lat & lon columns, x & y columns, or an address column; or give a cost table (costs)")
        bad = [names[i] for i, p in enumerate(pts) if p[0] is None or p[1] is None]
        if bad:
            raise ValueError("couldn't place: " + ", ".join(bad[:8]) + ("" if not missing else " (address not found on OpenStreetMap)"))
        A = np.array(pts, np.float64)
        n = len(A)
        if geo == "km":
            la, lo = np.radians(A[:, 0]), np.radians(A[:, 1])
            dla, dlo = la[:, None] - la[None, :], lo[:, None] - lo[None, :]
            h = np.sin(dla / 2) ** 2 + np.cos(la)[:, None] * np.cos(la)[None, :] * np.sin(dlo / 2) ** 2
            D = 2 * 6371.0 * np.arcsin(np.sqrt(np.clip(h, 0, 1)))
        else:
            D = np.sqrt(((A[:, None, :] - A[None, :, :]) ** 2).sum(-1))
        sym = True
        model_note = "D is the straight-line distance in {}".format(geo)
        pts, pts_unit = A.tolist(), geo
    N = n - 1
    close = " + D[t[N - 1] + 1][0]" if round_trip else ""
    model = "\n".join([
        "# Route: {} stops, {} from the first one. Generated by the Planner — edit freely.".format(n, "round trip" if round_trip else "one way"),
        "# t is the order of the visits to stops 1..{} (stop 0 is the start). {}.".format(N, model_note),
        "N = {}".format(N),
        "D = {}".format(json.dumps(np.round(D, 3).tolist()).replace(" ", "")),
        "var t perm N",
        "minimize: D[0][t[0] + 1] + sum(D[t[i] + 1][t[i + 1] + 1] for i in range(N - 1)){}".format(close),
    ])
    return model, {"names": names, "pts": pts, "pts_unit": pts_unit, "D": D, "round": round_trip, "unit": geo,
                   "matrix": forbid is not None, "sym": sym, "forbid": forbid, "notes": notes}


def _tour_len(order, D, rt):
    L = sum(D[order[i], order[i + 1]] for i in range(len(order) - 1))
    return float(L + (D[order[-1], order[0]] if rt else 0.0))


def _nn(D):
    n = len(D)
    order, left = [0], set(range(1, n))
    while left:
        j = min(left, key=lambda k: D[order[-1], k])
        order.append(j)
        left.discard(j)
    return order


def _two_opt(order, D, rt):
    if not np.allclose(D, D.T):
        return _two_opt_asym(order, D, rt)
    o = list(order)
    n = len(o)
    improved = True
    while improved:
        improved = False
        for i in range(1, n - 1):
            for j in range(i + 1, n if rt else n - 1):
                a, b = o[i - 1], o[i]
                c, d = o[j], o[(j + 1) % n] if (rt or j + 1 < n) else None
                if d is None:
                    continue
                if D[a, c] + D[b, d] < D[a, b] + D[c, d] - 1e-9:
                    o[i:j + 1] = reversed(o[i:j + 1])
                    improved = True
        if not rt:                                               # open path: also try reversing the tail
            for i in range(1, n - 1):
                if D[o[i - 1], o[-1]] < D[o[i - 1], o[i]] - 1e-9:
                    o[i:] = reversed(o[i:])
                    improved = True
    return o


def _two_opt_asym(order, D, rt, rounds=400):
    """Local search for one-way costs: segment reversals costed in their new direction (prefix sums of the forward
    and the backward legs, so each move is exact) and moves of one stop to another place. Stop 0 stays first."""
    o = list(order)
    n = len(o)
    for _ in range(rounds):
        seq = o + [o[0]] if rt else list(o)
        m = len(seq)
        fw = np.concatenate([[0.0], np.cumsum([D[seq[k], seq[k + 1]] for k in range(m - 1)])])
        bw = np.concatenate([[0.0], np.cumsum([D[seq[k + 1], seq[k]] for k in range(m - 1)])])
        best, mv = -1e-9, None
        for i in range(1, n):
            a = seq[i - 1]
            for j in range(i + 1, n):
                b, c = seq[i], seq[j]
                d = seq[j + 1] if j + 1 < m else None
                old = D[a, b] + (fw[j] - fw[i]) + (D[c, d] if d is not None else 0.0)
                new = D[a, c] + (bw[j] - bw[i]) + (D[b, d] if d is not None else 0.0)
                if new - old < best:
                    best, mv = new - old, ("rev", i, j)
        for i in range(1, n):                                    # move one stop elsewhere (exact O(1) deltas)
            p, x = seq[i - 1], seq[i]
            q = seq[i + 1] if i + 1 < m else None
            gain = D[p, x] + (D[x, q] - D[p, q] if q is not None else 0.0)
            for j in range(0, m - 1 if rt else m):
                u = seq[j]
                v = seq[j + 1] if j + 1 < m else None
                if u == x or v == x:
                    continue
                add = D[u, x] + (D[x, v] - D[u, v] if v is not None else 0.0)
                if add - gain < best:
                    best, mv = add - gain, ("mov", i, j)
        if mv is None:
            break
        if mv[0] == "rev":
            o[mv[1]:mv[2] + 1] = reversed(o[mv[1]:mv[2] + 1])
        else:
            i, j = mv[1], mv[2]
            x = o[i]
            u = seq[j]
            o.pop(i)
            o.insert(o.index(u) + 1, x)           # after u (u is never x)
    return o


def _held_karp(D, rt):
    n = len(D)
    if n > 13:
        return None
    best = {(1 << k, k): (D[0, k], 0) for k in range(1, n)}
    for size in range(2, n):
        for sub in itertools.combinations(range(1, n), size):
            bits = sum(1 << k for k in sub)
            for k in sub:
                prev = bits & ~(1 << k)
                best[(bits, k)] = min((best[(prev, m)][0] + D[m, k], m) for m in sub if m != k)
    full = (1 << n) - 2
    L, last = min((best[(full, k)][0] + (D[k, 0] if rt else 0), k) for k in range(1, n))
    order, bits = [], full
    while last:
        order.append(last)
        bits, last = bits & ~(1 << last), best[(bits, last)][1]
    return [0] + order[::-1], float(L)


# ================================================================ teams
def _teams(people_csv, k=4, pairs_csv="", balance=1.0, mix=1.0):
    head, rows = read_csv(people_csv)
    n = len(rows)
    if n < 2 * k:
        raise ValueError("{} people cannot make {} teams of two or more".format(n, k))
    if n > 400:
        raise ValueError("at most 400 people")
    c_name = _col(head, "name", "person")
    c_score = next((h for h in head if h != c_name and all(_num(r.get(h)) is not None for r in rows if r.get(h, "").strip())
                    and any(r.get(h, "").strip() for r in rows)), None)
    c_cat = next((h for h in head if h not in (c_name, c_score) and 1 < len({r.get(h) for r in rows}) <= max(2, n // 2)), None)
    names = [(r.get(c_name) or "person {}".format(i + 1)) for i, r in enumerate(rows)]
    score = np.array([_num(r.get(c_score), 0.0) if c_score else 1.0 for r in rows], np.float64)
    cats = [r.get(c_cat, "") if c_cat else "" for r in rows]
    cat_list = sorted(set(cats)) if c_cat else []
    C = [cat_list.index(c) if c_cat else 0 for c in cats]
    idx = {nm.strip().lower(): i for i, nm in enumerate(names)}
    together, apart, unknown = [], [], []
    for line in (pairs_csv or "").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        m = re.match(r"^(.+?)\s*(\+|-|together with|apart from|with|not with|!=|==)\s*(.+)$", line, re.I)
        if not m:
            unknown.append(line)
            continue
        a, op, b = m.group(1).strip().lower(), m.group(2).lower(), m.group(3).strip().lower()
        if a not in idx or b not in idx:
            unknown.append(line)
            continue
        (apart if op in ("-", "apart from", "not with", "!=") else together).append((idx[a], idx[b]))
    lo, hi = n // k, -(-n // k)
    mean = float(score.sum() / k)
    sc = (score - score.mean()) / (score.std() + 1e-9) if c_score else np.zeros(n)
    exp = [cats.count(c) / float(k) for c in cat_list]
    lines = [
        "# Teams: {} people into {} teams of {}{}. Generated by the Planner — edit freely.".format(n, k, lo, "" if lo == hi else "–{}".format(hi)),
        "# g[i] = the team of person i.{}{}".format(" S = standardised '{}' (balance the totals).".format(c_score) if c_score else "",
                                                   " C = '{}' category (spread it evenly).".format(c_cat) if c_cat else ""),
        "n = {}".format(n), "k = {}".format(k),
        "S = {}".format(json.dumps([round(float(v), 4) for v in sc])),
        "C = {}".format(json.dumps(C)),
        "var g[n] int 0..k-1",
        "all(count(1 for i in range(n) if g[i] == j) >= {} for j in range(k))".format(lo),
        "all(count(1 for i in range(n) if g[i] == j) <= {} for j in range(k))".format(hi),
    ]
    if together:
        lines += ["T = {}".format(json.dumps(together).replace(" ", "")), "all(g[a] == g[b] for (a, b) in T)"]
    if apart:
        lines += ["A = {}".format(json.dumps(apart).replace(" ", "")), "all(g[a] != g[b] for (a, b) in A)"]
    obj = []
    if c_score:
        obj.append("{:g} * sum(sum(S[i] for i in range(n) if g[i] == j) ** 2 for j in range(k))".format(balance))
    if c_cat:
        lines.append("E = {}".format(json.dumps([round(e, 4) for e in exp])))
        obj.append("{:g} * sum((count(1 for i in range(n) if g[i] == j and C[i] == c) - E[c]) ** 2 for j in range(k) for c in range({}))".format(mix, len(cat_list)))
    if obj:
        lines += ["minimize: " + " + ".join(obj), "penalty: 50"]
    return "\n".join(lines), {"names": names, "score": score, "cats": cats, "cat_list": cat_list, "k": k, "together": together,
                              "apart": apart, "unknown": unknown, "c_score": c_score, "c_cat": c_cat, "lo": lo, "hi": hi}


def _teams_eval(g, c):
    k, n = c["k"], len(g)
    tot = [float(sum(c["score"][i] for i in range(n) if g[i] == j)) for j in range(k)]
    size = [sum(1 for i in range(n) if g[i] == j) for j in range(k)]
    breaks = []
    for a, b in c["together"]:
        if g[a] != g[b]:
            breaks.append("{} and {} should be together".format(c["names"][a], c["names"][b]))
    for a, b in c["apart"]:
        if g[a] == g[b]:
            breaks.append("{} and {} should be apart".format(c["names"][a], c["names"][b]))
    for j in range(k):
        if not c["lo"] <= size[j] <= c["hi"]:
            breaks.append("team {} has {} people".format(j + 1, size[j]))
    mixdev = 0.0
    if c["cat_list"]:
        for j in range(k):
            for ci, cname in enumerate(c["cat_list"]):
                cnt = sum(1 for i in range(n) if g[i] == j and c["cats"][i] == cname)
                mixdev += (cnt - c["cats"].count(cname) / float(k)) ** 2
    return {"breaks": breaks, "totals": [round(t, 3) for t in tot], "sizes": size,
            "spread": round(max(tot) - min(tot), 3) if c["c_score"] else 0.0, "mix": round(mixdev, 2)}


def _teams_snake(c):
    n, k = len(c["names"]), c["k"]
    order = np.argsort(-c["score"], kind="stable") if c["c_score"] else np.arange(n)
    g = [0] * n
    for r, i in enumerate(order):
        rnd, pos = divmod(r, k)
        g[int(i)] = pos if rnd % 2 == 0 else k - 1 - pos
    return g


# ================================================================ solve
def compile_problem(kind, body, job=None, geocode_ok=True):
    """The tables and rules -> (walk-solver model, context). Raises ValueError with a message that names the problem."""
    if kind == "roster":
        return _roster(body.get("people", ""), body.get("shifts", ""), float(body.get("rest", 10)), bool(body.get("one_a_day", True)),
                       float(body.get("fair", 1.0)), float(body.get("prefer", 1.0)))
    if kind == "route":
        if not geocode_ok and not (body.get("costs") or "").strip():
            head, rows = read_csv(body.get("stops", ""))
            if _col(head, "address", "addr", "location", "where") and not (_col(head, "lat") or _col(head, "x")):
                return None, {"names": [r.get(_col(head, "name", "stop", "place") or "", "") for r in rows], "geocode": len(rows)}
        return _route(body.get("stops", ""), bool(body.get("round_trip", True)), job, body.get("costs", "") or "", body.get("unit", "") or "")
    if kind == "teams":
        return _teams(body.get("people", ""), int(body.get("k", 4)), body.get("pairs", ""), float(body.get("balance", 1.0)),
                      float(body.get("mix", 1.0)))
    raise ValueError("unknown problem {!r} (roster, route or teams)".format(kind))


def check(kind, body):
    """Read the inputs exactly as solve() does, without solving: what was understood, or the first error (with its line)."""
    try:
        model, c = compile_problem(kind, body, geocode_ok=False)
    except ValueError as e:
        return {"ok": False, "kind": kind, "error": str(e), "facts": [], "warnings": []}
    facts, warn = [], []
    if kind == "roster":
        facts.append("{} people, {} shifts, {} slots to fill".format(c["P"], len(c["S"]), len(c["slot_shift"])))
        warn += ["not sufficient people: " + x for x in c["short"]]
        idle = [c["names"][p] for p in range(c["P"]) if c["tgt"][p] <= 0]
        if idle:
            warn.append("cannot work any shift: " + ", ".join(idle[:8]))
    elif kind == "route":
        if model is None:
            facts.append("{} addresses to look up on OpenStreetMap (about one a second, then cached)".format(c["geocode"]))
        else:
            n = len(c["names"])
            facts.append("{} stops, {}, costs in {}{}".format(n, "round trip" if c["round"] else "one way", c["unit"],
                                                          "" if c["sym"] else ", one-way costs differ"))
            facts.append("the exact optimum is computed too (13 stops or fewer)" if n <= 13 else "compared with nearest-neighbour + 2-opt")
            warn += c.get("notes", [])
    else:
        facts.append("{} people into {} teams of {}{}".format(len(c["names"]), c["k"], c["lo"], "" if c["lo"] == c["hi"] else "-{}".format(c["hi"])))
        facts.append("balance: {}".format(c["c_score"] or "nothing (no number column)"))
        facts.append("mix: {}".format(c["c_cat"] or "nothing (no category column)"))
        if c["unknown"]:
            warn.append("pair rules not used (a name is not in the table, or no + / -): " + "; ".join(c["unknown"][:6]))
    return {"ok": True, "kind": kind, "facts": facts, "warnings": warn, "model_lines": len((model or "").splitlines())}


def _pct(a, b):
    """a against the baseline b (smaller is better), as words."""
    if b <= 0:
        return "the same as"
    d = (b - a) / b * 100
    return "{:.1f}% better than".format(d) if d > 0.05 else ("{:.1f}% worse than".format(-d) if d < -0.05 else "the same as")


def solve(kind, body, job=None):
    t0 = time.time()
    effort = body.get("effort", "normal")
    walkers, sweeps, limit = {"quick": (1024, 1500, 10), "normal": (2048, 4000, 25), "thorough": (4096, 20000, 75)}.get(effort, (2048, 4000, 30))
    model, c = compile_problem(kind, body, job)
    if body.get("model"):
        model = body["model"]                                    # the user edited the generated model
    if job:
        job.step(0.62, "the walkers search on the card")
    r = walksolve.run({"model": model, "walkers": walkers, "sweeps": sweeps, "time_limit": limit})
    sol = r.get("solution") or {}
    out = {"kind": kind, "model": model, "solver": {"feasible": r["feasible"], "walkers": r["walkers"], "sweeps": r["sweeps"],
                                                    "secs": round(r["ms"] / 1000.0, 2), "chart": r["chart"]}}
    if kind == "roster":
        x = [int(v) for v in sol.get("x", [])]
        P = c["P"]
        x = [v if v < P else -1 for v in x]
        g = _roster_greedy(c)
        ev, gv = _roster_eval(x, c), _roster_eval(g, c)
        better = (len(ev["breaks"]), ev["open"], ev["unfair"], -ev["prefs"]) <= (len(gv["breaks"]), gv["open"], gv["unfair"], -gv["prefs"])
        use = x if better else g
        ue = ev if better else gv
        out.update(_roster_out(use, c))
        out.update({"names": c["names"], "eval": ue, "solver_eval": ev, "greedy_eval": gv, "used": "walkers" if better else "greedy",
                    "short": c["short"], "targets": [round(float(t), 2) for t in c["tgt"]]})
        nb, no = len(ue["breaks"]), ue["open"]
        head = "{} open".format(no) if no else ("{} broken".format(nb) if nb else "All covered")
        tone = "good" if not (nb or no) else "warn"
        who = "The GPU walkers" if better else "The quick step-by-step (greedy) plan"
        sent = ("{} fill{} each slot, and each rule is true{}. ".format(
                    who, "" if better else "s", "" if better else " (the GPU search did not do better this time)") if not (nb or no) else
                "{} slot{} left open{}. ".format(no, "" if no == 1 else "s", " and {} rule{} broken".format(nb, "" if nb == 1 else "s") if nb else "")
                if no else "{} rule{} had to bend. ".format(nb, "" if nb == 1 else "s"))
        can = [p for p in range(P) if c["tgt"][p] > 0]
        idle = [c["names"][p] for p in range(P) if c["tgt"][p] <= 0]
        if can:
            sent += "Shifts per person range from {} to {} (fair share {}–{}).".format(
                min(ue["load"][p] for p in can), max(ue["load"][p] for p in can),
                round(float(min(c["tgt"][p] for p in can)), 1), round(float(max(c["tgt"][p] for p in can)), 1))
        if idle:
            sent += " {} cannot work any of these shifts.".format(", ".join(idle[:6]) + (" …" if len(idle) > 6 else ""))
        if ue["has_prefs"]:
            sent += " {} requested shifts granted.".format(ue["prefs"])
        kw = (len(ev["breaks"]), ev["open"], ev["unfair"], -ev["prefs"])
        kg = (len(gv["breaks"]), gv["open"], gv["unfair"], -gv["prefs"])
        cmpw = ("GPU walkers: {} open, {} broken, unfairness {:g}, {} wishes granted · greedy plan: {} open, {} broken, unfairness {:g}, {} wishes — "
                "the walkers {}.").format(ev["open"], len(ev["breaks"]), ev["unfair"], ev["prefs"], gv["open"], len(gv["breaks"]), gv["unfair"],
                                         gv["prefs"], "won" if kw < kg else "tied" if kw == kg else "lost, so the greedy plan is shown")
        if c["short"]:
            sent = "Not sufficient people for these shifts: " + "; ".join(c["short"][:3]) + ". " + sent
        explain = ["The roster shown comes from {}.".format("the GPU walkers" if better else "the greedy plan (fill the hardest slot first with the person who has the fewest shifts); the walkers did no better"),
                   "Against the greedy plan: open slots {} vs {}, broken rules {} vs {}, unfairness {:g} vs {:g} (the sum of squared differences from each fair share){}.".format(
                       ev["open"], gv["open"], len(ev["breaks"]), len(gv["breaks"]), ev["unfair"], gv["unfair"],
                       ", wishes granted {} vs {}".format(ev["prefs"], gv["prefs"]) if ue["has_prefs"] else "")]
        at_max = [c["names"][p] for p in range(P) if ue["load"][p] >= c["maxs"][p] and c["maxs"][p] < 10 ** 6]
        if at_max:
            explain.append("At their maximum number of shifts: {}. More shifts for them is not possible.".format(", ".join(at_max[:8]) + (" and {} more".format(len(at_max) - 8) if len(at_max) > 8 else "")))
        if c["short"]:
            explain.append("Some shifts cannot be covered by anyone: add people with the skill, remove an unavailable day, or lower the number needed.")
        elif no:
            explain.append("{} open slot{}: the people who can work them are at their maximum or need rest. Raise a maximum, lower the rest hours, or add a person.".format(no, "" if no == 1 else "s"))
    elif kind == "route":
        D, rt = c["D"], c["round"]
        t = [int(v) for v in sol.get("t", [])]
        walk = [0] + [v + 1 for v in t]
        Lw = _tour_len(walk, D, rt)
        nn = _nn(D)
        Ln = _tour_len(nn, D, rt)
        opt2 = _two_opt(nn, D, rt)
        L2 = _tour_len(opt2, D, rt)
        hk = _held_karp(D, rt)
        best = min([("walkers", walk, Lw), ("2-opt", opt2, L2)] + ([("exact", hk[0], hk[1])] if hk else []), key=lambda z: z[2] + (1e-9 if z[0] != "walkers" else 0))
        order = best[1]
        seq = order + ([order[0]] if rt else [])
        legs = [float(D[seq[i], seq[i + 1]]) for i in range(len(seq) - 1)]
        bad_legs = []
        if c.get("forbid") is not None:
            bad_legs = ["{} -> {}".format(c["names"][seq[i]], c["names"][seq[i + 1]]) for i in range(len(seq) - 1) if c["forbid"][seq[i], seq[i + 1]]]
        u = c["unit"]
        what = "straight-line distances" if not c["matrix"] else "your costs"
        out.update({"order": order, "names": c["names"], "pts": c["pts"], "pts_unit": c.get("pts_unit"), "legs": [round(v, 3) for v in legs], "unit": u,
                    "round_trip": rt, "length": round(best[2], 3), "used": best[0], "cost_table": bool(c["matrix"]), "symmetric": bool(c["sym"]),
                    "not_allowed_used": bad_legs, "notes": c.get("notes", []),
                    "compare": {"nearest": round(Ln, 3), "two_opt": round(L2, 3), "walkers": round(Lw, 3), "exact": round(hk[1], 3) if hk else None},
                    "table": {"header": ["order", "stop", "leg " + u, "total " + u],
                              "rows": [[i + 1, c["names"][s_], round(([0.0] + legs)[i], 3), round(sum(legs[:i]), 3)] for i, s_ in enumerate(seq)]}})
        head = "{:.1f} {}".format(best[2], u) if not bad_legs else "{} blocked".format(len(bad_legs))
        tone = "good" if not bad_legs else "warn"
        sent = "Visit the {} stops in this order: {:.1f} {} {} ({}).".format(len(order), best[2], u, "there and back" if rt else "one way", what)
        if bad_legs:
            sent += " No order avoids every leg that is not allowed: this one uses " + ", ".join(bad_legs[:4]) + "."
        cmpw = "Nearest-neighbour {:.1f} {u} · plus 2-opt {:.1f} {u} · GPU walkers {:.1f} {u}{}.".format(
            Ln, L2, Lw, " · proven optimum {:.1f} {}".format(hk[1], u) if hk else "", u=u)
        cmpw += " The walkers {} the classic heuristics.".format("beat" if Lw < L2 - 1e-6 else "matched" if abs(Lw - L2) < 1e-6 else "lost to")
        explain = ["The order shown comes from {}.".format({"walkers": "the GPU walkers", "2-opt": "nearest-neighbour + 2-opt (the walkers did no better)",
                                                             "exact": "the exact search (Held-Karp), so no order costs less"}[best[0]]),
                   "It is {} the nearest-neighbour route (always go to the closest stop not yet visited: {:.1f} {}{}).".format(
                       _pct(best[2], Ln), Ln, u, "" if c.get("forbid") is None or not any(c["forbid"][x, y] for x, y in zip(nn, nn[1:] + ([nn[0]] if rt else [])))
                       else ", which had to use legs that are not allowed")]
        if hk:
            explain.append("The proven optimum is {:.1f} {}. The order shown is {}.".format(
                hk[1], u, "optimal" if best[2] <= hk[1] + 1e-6 else "{:.1f}% above it".format((best[2] - hk[1]) / max(hk[1], 1e-9) * 100)))
        else:
            explain.append("With more than 13 stops the exact optimum is not computed. Nearest-neighbour + 2-opt ({:.1f} {}) is the baseline to beat.".format(L2, u))
        if legs:
            k = int(np.argmax(legs))
            explain.append("The longest leg is {} -> {} ({:.1f} {}, {:.0f}% of the total).".format(
                c["names"][seq[k]], c["names"][seq[k + 1]], legs[k], u, legs[k] / max(best[2], 1e-9) * 100))
        if c["matrix"] and not c["sym"]:
            rev = _tour_len([order[0]] + order[1:][::-1], D, rt)
            explain.append("One-way costs differ: the same stops in reverse order cost {:.1f} {}.".format(rev, u))
        explain += c.get("notes", [])
    else:
        g = [int(v) for v in sol.get("g", [])]
        snake = _teams_snake(c)
        ev, sv = _teams_eval(g, c), _teams_eval(snake, c)
        better = (len(ev["breaks"]), ev["spread"] + ev["mix"]) <= (len(sv["breaks"]), sv["spread"] + sv["mix"])
        use = g if better else snake
        ue = ev if better else sv
        teams = [[c["names"][i] for i in range(len(use)) if use[i] == j] for j in range(c["k"])]
        members = [[{"name": c["names"][i], "score": float(c["score"][i]), "cat": c["cats"][i]} for i in range(len(use)) if use[i] == j] for j in range(c["k"])]
        out.update({"teams": teams, "members": members, "eval": ue, "solver_eval": ev, "snake_eval": sv, "used": "walkers" if better else "snake draft",
                    "score_col": c["c_score"], "cat_col": c["c_cat"], "unknown_pairs": c["unknown"],
                    "table": {"header": ["team", "person"] + ([c["c_score"]] if c["c_score"] else []) + ([c["c_cat"]] if c["c_cat"] else []),
                              "rows": [[j + 1, m["name"]] + ([m["score"]] if c["c_score"] else []) + ([m["cat"]] if c["c_cat"] else [])
                                       for j, ms in enumerate(members) for m in ms]}})
        nb = len(ue["breaks"])
        head = "{} teams".format(c["k"]) if not nb else "{} broken".format(nb)
        tone = "good" if not nb else "warn"
        sent = "{} teams of {}{}.".format(c["k"], c["lo"], "" if c["lo"] == c["hi"] else "–{}".format(c["hi"]))
        if c["c_score"]:
            sent += " Team totals of {} differ by {:g} at most.".format(c["c_score"], ue["spread"])
        if c["c_cat"]:
            sent += " {} is spread as evenly as the numbers allow.".format(c["c_cat"])
        if c["together"] or c["apart"]:
            sent += " {} of {} pair rules hold.".format(len(c["together"]) + len(c["apart"]) - sum(1 for b in ue["breaks"] if "should" in b),
                                                        len(c["together"]) + len(c["apart"]))
        cmpw = "Snake draft: total spread {:g}, mix error {:g}, {} broken · GPU walkers: spread {:g}, mix error {:g}, {} broken.".format(
            sv["spread"], sv["mix"], len(sv["breaks"]), ev["spread"], ev["mix"], len(ev["breaks"]))
        explain = ["The teams shown come from {}.".format("the GPU walkers" if better else "the snake draft (sort by score, deal 1..k then k..1); the walkers did no better")]
        if c["c_score"]:
            explain.append("Balance of {}: the team totals differ by {:g} (snake draft {:g}). Totals: {}.".format(
                c["c_score"], ue["spread"], sv["spread"], ", ".join("{:g}".format(t) for t in ue["totals"])))
        if c["c_cat"]:
            explain.append("Mix of {}: error {:g} (snake draft {:g}; 0 means each team has its exact share of each value).".format(c["c_cat"], ue["mix"], sv["mix"]))
        if c["together"] or c["apart"]:
            explain.append("Pair rules: {} of {} hold (snake draft {} of {}).".format(
                len(c["together"]) + len(c["apart"]) - sum(1 for b in ue["breaks"] if "should" in b), len(c["together"]) + len(c["apart"]),
                len(c["together"]) + len(c["apart"]) - sum(1 for b in sv["breaks"] if "should" in b), len(c["together"]) + len(c["apart"])))
        if c["unknown"]:
            explain.append("Not used (name not in the table): " + "; ".join(c["unknown"][:4]) + ".")
    out.update({"headline": head, "tone": tone, "sentence": sent, "compare_text": cmpw, "explain": explain, "ms": round((time.time() - t0) * 1000, 1)})
    return out


def save_table(name, table):
    return sources.table_from_rows(name, table["header"], table["rows"])


# ================================================================ examples (realistic, small)
EXAMPLES = {
    "roster": {
        "people": "name,max_shifts,skills,unavailable,prefers\nAna,5,nurse;senior,Sun,Early\nBen,5,nurse,,Night\nCara,4,nurse;senior,Sat;Sun,\nDev,5,nurse,Wed,Late\nEli,3,aide,,Early\nFay,5,nurse,Mon,\nGus,5,aide;nurse,,Night\nHana,4,nurse;senior,Fri,Late\nIvo,5,aide,Tue,\nJo,5,nurse,,Early",
        "shifts": "\n".join(["shift,day,start,end,needed,skill"] + ["{},{},{},{},{},{}".format(s, d, a, b, n, sk) for d in ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
                                                                         for s, a, b, n, sk in (("Early", "07:00", "15:00", 2, "nurse"), ("Late", "15:00", "23:00", 2, "nurse"), ("Night", "23:00", "07:00", 1, "nurse"))]),
        "rest": 11, "one_a_day": True},
    "route": {
        "stops": "name,lat,lon\nDepot (Domain),30.4021,-97.7253\nZilker Park,30.2669,-97.7729\nUT Tower,30.2862,-97.7394\nCapitol,30.2747,-97.7404\nMueller Lake,30.2988,-97.7050\nBarton Springs,30.2640,-97.7713\nSouth Congress,30.2449,-97.7509\nMount Bonnell,30.3207,-97.7735\nArboretum,30.3926,-97.7487\nAirport (AUS),30.1975,-97.6664\nPflugerville,30.4394,-97.6200\nCedar Park,30.5052,-97.8203\nWestlake,30.2840,-97.8170\nEast Riverside,30.2350,-97.7200\nCircuit of the Americas,30.1328,-97.6411\nRound Rock,30.5083,-97.6789",
        "round_trip": True},
    "teams": {
        "people": "name,rating,dept\n" + "\n".join("{},{},{}".format(n, r, d) for n, r, d in zip(
            ["Avery", "Blake", "Casey", "Drew", "Emery", "Finley", "Gray", "Harper", "Indy", "Jules", "Kai", "Logan", "Morgan", "Noel", "Oakley", "Parker",
             "Quinn", "Reese", "Sage", "Taylor", "Uma", "Vale", "Wren", "Xen"],
            [9, 4, 7, 6, 8, 3, 5, 7, 6, 2, 9, 5, 4, 8, 6, 7, 3, 5, 6, 8, 4, 7, 5, 6],
            ["Eng", "Sales", "Eng", "Ops", "Design", "Sales", "Ops", "Eng", "Design", "Sales", "Eng", "Ops", "Design", "Eng", "Sales", "Ops",
             "Design", "Eng", "Sales", "Ops", "Eng", "Design", "Sales", "Ops"])),
        "pairs": "Avery - Kai\nBlake + Indy\nHarper - Noel", "k": 4},
}
