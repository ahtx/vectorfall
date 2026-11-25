"""Worlds for the force model: bodies over time, plus a ledger of the events that happened to them.

A world is a dict:
  ids, names, groups          one entry per body
  dates                       one per step ("YYYY-MM-DD"); step = "month" or "year"
  size                        bodies x steps, the size in US$ (NaN = absent); est = True where the size is an estimate
  ret                         bodies x steps, the log change used to place bodies on the map (NaN = unknown)
  member                      bodies x steps, True while the body is in the film (the S&P 500; every country is always in)
  geo                         bodies x 2 (lat, lon) or None
  extra                       {name: bodies x steps} more numbers per body (countries: GDP per person, FX rate, ...)
  events                      [{date, step, type, id, by, value, text, source}] sorted by date

Event types (one word each, the same in the UI):
  companies  merger (id = the target, by = the acquirer when known) · exit (fell out of the S&P 500 for its size or
             another reason) · entry · split (id = the new company, by = the parent) · collapse (bankruptcy) ·
             jump (a monthly move of 5 sigma or more; value = the log change)
  countries  war (between states) · civilwar (inside a state, 1,000+ deaths a year) · uprising (a new armed conflict
             inside a state, 25+ deaths) · coup (value 1 = it succeeded, 0 = it failed) · currency (the currency lost
             30%+ against the US$ in a year; value = the loss) · breakup / union (state births and deaths, a fixed list)

Sources (all free, no keys): the S&P 500 panel in marketdata.py, SEC XBRL frames (dei:EntityPublicFloat: the public
float on each 10-K cover, for companies whose prices are gone), the World Bank API, UCDP/PRIO Armed Conflict v25.1,
Powell & Thyne coups as kept month by month in github.com/thynec/CoupCats, and the countrycode crosswalk.
"""
import csv
import datetime as dt
import gzip
import io
import json
import math
import os
import re
import time
import zipfile

import numpy as np

from . import marketdata as MD

ROOT = os.environ.get("VF_DATA", "/srv/data") + "/worlds"
_W = {}


def _dl(name, url, ua=MD.UA_WEB, refresh=False):
    p = os.path.join(ROOT, "raw", name)
    if not refresh and os.path.exists(p):
        return open(p, "rb").read()
    b = MD._get(url, ua)
    if b is None:
        raise RuntimeError("could not download {} from {}".format(name, url))
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p + ".tmp", "wb") as f:
        f.write(b)
    os.replace(p + ".tmp", p)
    return b


def _step_after(dates, d):
    """Index of the first step on or after date d: the step in which an event on date d happened."""
    for i, x in enumerate(dates):
        if x >= d:
            return i
    return None


def _step_of(dates, d):
    """Index of the last step on or before date d (None if d is before the first)."""
    j = None
    for i, x in enumerate(dates):
        if x <= d:
            j = i
        else:
            break
    return j


# ================================================================ companies
def float_frames(refresh=False):
    """{cik: [(date, public float US$)]} from the SEC frames API: dei:EntityPublicFloat, every calendar quarter."""
    out = {}
    today = dt.date.today()
    for y in range(MD.START - 1, today.year + 1):
        for q in range(1, 5):
            qe = dt.date(y, 3 * q, [31, 30, 30, 31][q - 1])
            if qe > today:
                break
            nm = "CY{}Q{}I".format(y, q)
            b = MD._cache("float/" + nm + ".json", lambda: (time.sleep(0.15), MD._get(
                "https://data.sec.gov/api/xbrl/frames/dei/EntityPublicFloat/USD/{}.json".format(nm), MD.UA_SEC))[1],
                refresh and qe > today - dt.timedelta(days=200))
            if not b:
                continue
            for r in json.loads(b).get("data", []):
                try:
                    out.setdefault(int(r["cik"]), []).append((r.get("end") or qe.isoformat(), float(r["val"])))
                except (KeyError, ValueError, TypeError):
                    pass
    for v in out.values():
        v.sort()
    return out


def _parse_change(e):
    """One change-log row -> (type of the removal, acquirer name or None, spin-off parent name or None)."""
    r = (e.get("reason") or "").strip()
    low = r.lower()
    by = parent = None
    if "bankrupt" in low or "chapter 11" in low:
        kind = "collapse"
    elif re.search(r"spin.?off|spun off|spinoff", low):
        kind = "split"
        m = re.search(r"(?:spun off from|spin-?off from|spinoff from)\s+(.+?)(?:[.,;]|$)", r, re.I) or \
            re.search(r"^(.+?)\s+(?:completed|completes|announced)?\s*(?:the\s+)?(?:corporate\s+)?spin.?off", r, re.I)
        parent = m.group(1).strip() if m else None
    elif re.search(r"acqui|merg|purchas|bought|takeover|taken over|combin", low):
        kind = "merger"
        m = re.search(r"acquired by\s+(.+?)(?:[.,;(]|\s+in\s+|$)", r, re.I) or re.search(r"merged with\s+(.+?)(?:[.,;(]|$)", r, re.I) \
            or re.search(r"^(.+?)\s+(?:acquired|purchased|bought|completed (?:its |the )?acquisition of)\s", r, re.I)
        by = m.group(1).strip() if m else None
    elif re.search(r"market cap|capitali[sz]ation|size|no longer (?:meets|representative)|float|liquidity", low):
        kind = "exit"
    else:
        kind = "exit"
    return kind, by, parent


def company_world(refresh=False):
    """The S&P 500 since 2007 as a world: one body per company (share classes merged), sizes from prices x shares, and
    for companies whose prices are gone (most acquisitions) sizes estimated from the public float on their 10-Ks."""
    if "companies" in _W and not refresh:
        return _W["companies"]
    from . import particles as PT
    p = PT.market_panel()
    P, meta = MD.load()
    info = meta["info"]
    dates = list(p["dates"])
    ids, names, groups = list(p["tickers"]), list(p["name"]), list(p["sector"])
    size = np.array(p["cap"], np.float64)
    member = np.array(p["inidx"], bool)
    with np.errstate(all="ignore"):
        ret = np.diff(np.log(np.where(np.isfinite(p["px"]), p["px"], np.nan)), axis=1)
    ret = np.concatenate([np.full((len(ids), 1), np.nan), ret], 1)
    N, T = size.shape
    est = np.zeros((N, T), bool)
    # ---- companies whose prices are gone: their 10-K public float, scaled to market cap and filled month by month
    MD.shares_frames()                                         # fills the name index name_ciks() reads
    t2c = MD.ticker_ciks()
    fl = float_frames(refresh)
    ratio = []                                                 # market cap / public float where both exist
    for i, t in enumerate(ids):
        cik = (info.get(t) or {}).get("cik") or t2c.get(t)
        for d, v in fl.get(int(cik), [])[-12:] if cik else []:
            j = _step_of(dates, d)
            if j is not None and np.isfinite(size[i, j]) and v > 0:
                ratio.append(size[i, j] / v)
    scale = float(np.median(ratio)) if ratio else 1.0
    filled = 0
    for i, t in enumerate(ids):
        m = member[i]
        gap = m & ~np.isfinite(size[i])
        if gap.sum() < 3:
            continue
        ciks = set((info.get(t) or {}).get("ciks") or [])
        c0 = (info.get(t) or {}).get("cik") or t2c.get(t)
        if c0:
            ciks.add(int(c0))
        ciks |= set(MD.name_ciks(names[i]))
        pts = sorted(set(x for c in ciks for x in fl.get(int(c), [])))
        # drop filings in the wrong units (QEP reported 1e18, Viacom 1e16) and floats of other companies with the same
        # name: keep US$100M..3T, within x20 of this company's own median, and dated inside the months we have
        pts = [(d, v) for d, v in pts if 1e8 <= v <= 3e12]
        if pts:
            med = float(np.median([math.log(v) for _, v in pts]))
            pts = [(d, v) for d, v in pts if abs(math.log(v) - med) < math.log(20)]
        pts = [(d, v) for d, v in pts if _step_of(dates, d) is not None]
        if not pts:
            continue
        pd = [_step_of(dates, d) for d, _ in pts]
        pv = [math.log(v * scale) for _, v in pts if v > 0]
        pd = [j for j, (_, v) in zip(pd, pts) if v > 0]
        if not pv or all(j is None for j in pd):
            continue
        xs = np.array([j if j is not None else -1 for j in pd], float)
        for j in np.where(gap)[0]:
            if xs.min() - 15 <= j <= xs.max() + 15:              # interpolate between 10-Ks; hold up to 15 months past them
                size[i, j] = math.exp(float(np.interp(j, xs, pv)))
                est[i, j] = True
        filled += 1
    # ---- events from the change log (since 2007), mapped onto bodies by ticker or by name
    by_name = {MD._norm(n): k for k, n in enumerate(names)}
    tick = {t: k for k, t in enumerate(ids)}
    for k, t in enumerate(ids):                                # share classes merged into one body still answer to their tickers
        for t2, v in info.items():
            if v.get("cik") and v.get("cik") == (info.get(t) or {}).get("cik") and t2 not in tick:
                tick[t2] = k
    def find(t=None, nm=None):
        if t and t in tick:
            return tick[t]
        if nm:
            k = by_name.get(MD._norm(nm))
            if k is not None:
                return k
            for key, k in by_name.items():                     # "Paramount Skydance" -> "Paramount Skydance Corporation"
                n2 = MD._norm(nm)
                if len(n2) > 5 and (key.startswith(n2) or n2.startswith(key)) and len(key) > 5:
                    return k
        return None
    ev = []
    for e in meta["changes"]:
        d = e["date"]
        if d < dates[0]:
            continue
        j = _step_after(dates, d)
        kind, by, parent = _parse_change(e)
        if e.get("rem"):
            i = find(e["rem"], e.get("rem_name"))
            typ = kind if kind in ("merger", "collapse") else "exit"
            ev.append({"date": d, "step": j, "type": typ, "id": ids[i] if i is not None else e["rem"], "name": e.get("rem_name") or e["rem"],
                       "by": ids[find(None, by)] if by and find(None, by) is not None else None, "by_name": by,
                       "known": i is not None, "text": e.get("reason") or "", "source": "S&P 500 change log (Wikipedia)"})
        if e.get("add"):
            i = find(e["add"], e.get("add_name"))
            typ = "split" if kind == "split" and parent and MD._norm(parent) != MD._norm(e.get("rem_name") or "") else "entry"
            ev.append({"date": d, "step": j, "type": typ, "id": ids[i] if i is not None else e["add"], "name": e.get("add_name") or e["add"],
                       "by": ids[find(None, parent)] if typ == "split" and find(None, parent) is not None else None, "by_name": parent if typ == "split" else None,
                       "known": i is not None, "text": e.get("reason") or "", "source": "S&P 500 change log (Wikipedia)"})
    # ---- jumps: a monthly move of 5 sigma or more (sigma from the 36 months before), while in the index
    for i in range(N):
        r = ret[i]
        for j in range(37, T):
            if not member[i, j] or not np.isfinite(r[j]):
                continue
            w = r[j - 36:j]
            w = w[np.isfinite(w)]
            if len(w) < 24:
                continue
            sd = float(w.std())
            if sd > 0 and abs(r[j]) >= max(0.25, 5 * sd):
                ev.append({"date": dates[j], "step": j, "type": "jump", "id": ids[i], "name": names[i], "by": None, "value": round(float(r[j]), 4),
                           "known": True, "text": "{} {:+.0%} in one month ({:.1f} sigma)".format(names[i], math.exp(r[j]) - 1, abs(r[j]) / sd),
                           "source": "prices (Yahoo) x shares (SEC)"})
    ev.sort(key=lambda x: (x["date"], x["type"]))
    W = {"world": "companies", "what": "market cap", "unit": "US$", "step": "month", "group_name": "sector",
         "ids": ids, "names": names, "groups": groups, "dates": dates, "size": size, "est": est, "ret": ret,
         "member": member, "geo": None, "extra": {}, "events": ev, "film": True,
         "notes": ["{} companies have some sizes estimated from the public float on their 10-K filings (x {:.2f}, the median ratio "
                   "of market cap to float), because their prices are gone. Without prices they have no co-movement, so they sit at their "
                   "sector's centre.".format(int(est.any(1).sum()), scale),
                   "The S&P 500 change log on Wikipedia is not complete before about 2011."],
         "built": meta.get("built")}
    _W["companies"] = W
    return W


# ================================================================ countries
WB = {"NY.GDP.MKTP.CD": "gdp", "NY.GDP.MKTP.KD": "gdp_real", "PA.NUS.FCRF": "fx", "SP.POP.TOTL": "pop",
      "SP.POP.1564.TO.ZS": "workage", "SP.DYN.LE00.IN": "life", "NE.GDI.TOTL.ZS": "invest"}


def _carry(A, k=3):
    """Carry the last known value forward for up to k steps (the newest years are often not reported yet)."""
    A = A.copy()
    for j in range(1, A.shape[1]):
        miss = ~np.isfinite(A[:, j])
        for b in range(1, k + 1):
            if j - b < 0:
                break
            fill = miss & np.isfinite(A[:, j - b])
            A[fill, j] = A[fill, j - b]
            miss &= ~fill
    return A

# State births and deaths since 1990 (these are history, not a model: too few to learn a rate from)
STATES = [
    ("1990-10-03", "union", "DEU", "German reunification: the GDR joins the Federal Republic"),
    ("1990-05-22", "union", "YEM", "North and South Yemen unite"),
    ("1991-12-26", "breakup", "RUS", "The Soviet Union dissolves into 15 states"),
    ("1991-06-25", "breakup", "SVN", "Slovenia and Croatia leave Yugoslavia"),
    ("1992-03-03", "breakup", "BIH", "Bosnia and Herzegovina leaves Yugoslavia"),
    ("1993-01-01", "breakup", "CZE", "Czechoslovakia splits into Czechia and Slovakia"),
    ("1993-05-24", "breakup", "ERI", "Eritrea becomes independent from Ethiopia"),
    ("2002-05-20", "breakup", "TLS", "Timor-Leste becomes independent from Indonesia"),
    ("2006-06-03", "breakup", "MNE", "Montenegro leaves the union with Serbia"),
    ("2008-02-17", "breakup", "XKX", "Kosovo declares independence from Serbia"),
    ("2011-07-09", "breakup", "SSD", "South Sudan becomes independent from Sudan"),
]
COW_FIX = {"SRB": 345, "XKX": 347, "TLS": 860, "SSD": 626}
GW_FIX = {"YEM": 678, "DEU": 260, "SRB": 340, "XKX": 347}


def _wb(ind, refresh=False):
    rows, page = [], 1
    while True:
        b = _dl("wb/{}_{}.json".format(ind, page), "https://api.worldbank.org/v2/country/all/indicator/{}?format=json&per_page=20000&date=1960:2030&page={}".format(ind, page), refresh=refresh)
        j = json.loads(b)
        rows += j[1] or []
        if page >= j[0]["pages"]:
            break
        page += 1
    return rows


def _codes(refresh=False):
    b = _dl("countrycode.csv", "https://raw.githubusercontent.com/vincentarelbundock/countrycode/main/dictionary/codelist_without_cldr.csv", refresh=refresh)
    cow, gw = {}, {}
    for r in csv.DictReader(io.StringIO(b.decode("utf-8", "replace"))):
        iso = r.get("iso3c")
        if not iso:
            continue
        if r.get("cown"):
            cow[int(float(r["cown"]))] = iso
        if r.get("gwn"):
            gw[int(float(r["gwn"]))] = iso
    for iso, c in COW_FIX.items():
        cow[c] = iso
    for iso, g in GW_FIX.items():
        gw[g] = iso
    return cow, gw


def country_world(refresh=False):
    """Countries as bodies, one step a year: GDP in current US$ (size), real GDP growth (for the map), the exchange
    rate, population, the capital's position, and the events: wars, civil wars, uprisings, coups, currency crashes."""
    if "countries" in _W and not refresh:
        return _W["countries"]
    cs = json.loads(_dl("wb/countries.json", "https://api.worldbank.org/v2/country?format=json&per_page=400", refresh=refresh))[1]
    meta = {c["id"]: c for c in cs if c["region"]["value"].strip() != "Aggregates"}
    series = {k: _wb(ind, refresh) for ind, k in WB.items()}
    years = sorted({int(r["date"]) for r in series["gdp"]})
    ids = sorted({r["countryiso3code"] for r in series["gdp"] if r["countryiso3code"] in meta})
    yi, ci = {y: i for i, y in enumerate(years)}, {c: i for i, c in enumerate(ids)}
    M = {}
    for k, rows in series.items():
        A = np.full((len(ids), len(years)), np.nan)
        for r in rows:
            c = r["countryiso3code"]
            if c in ci and r["value"] is not None and int(r["date"]) in yi:
                A[ci[c], yi[int(r["date"])]] = float(r["value"])
        M[k] = A
    # the last year that most countries have reported
    last = max(i for i in range(len(years)) if np.isfinite(M["gdp"][:, i]).sum() > 0.6 * len(ids))
    years = years[:last + 1]
    for k in M:
        M[k] = M[k][:, :last + 1]
    dates = ["{}-12-31".format(y) for y in years]
    # size = real GDP (constant 2015 US$): the share of the world's real output; current US$ follows exchange rates
    size = np.where(M["gdp_real"] > 0, M["gdp_real"], np.nan)
    with np.errstate(all="ignore"):
        real = np.diff(np.log(np.where(M["gdp_real"] > 0, M["gdp_real"], np.nan)), axis=1)
    ret = np.concatenate([np.full((len(ids), 1), np.nan), real], 1)       # the map uses real growth, not the currency
    geo = np.array([[float(meta[c].get("latitude") or "nan"), float(meta[c].get("longitude") or "nan")] if meta[c].get("latitude") else [np.nan, np.nan]
                    for c in ids])
    N, T = size.shape
    cow, gw = _codes(refresh)
    ev = []
    # ---- UCDP/PRIO armed conflict: wars between states, civil wars, new armed conflicts inside a state
    z = zipfile.ZipFile(io.BytesIO(_dl("ucdp-prio-acd-251.zip", "https://ucdp.uu.se/downloads/ucdpprio/ucdp-prio-acd-251-csv.zip", refresh=refresh)))
    rows = list(csv.DictReader(io.TextIOWrapper(z.open(z.namelist()[0]), encoding="utf-8", errors="replace")))
    war = {}                                                     # (iso, year) -> (type, intensity, name)
    for r in rows:
        y, inten, typ = int(r["year"]), int(r["intensity_level"]), int(r["type_of_conflict"])
        parts = set()
        cols = ("gwno_a", "gwno_b") if typ == 2 else ("gwno_loc",)     # primary sides only: supporters ("_2nd") are not at war
        for col in cols:
            for g in re.split(r"[,\s]+", r.get(col) or ""):
                if g.strip().isdigit() and int(g) in gw:
                    parts.add(gw[int(g)])
        for iso in parts:
            kind = "war" if typ == 2 else ("civilwar" if inten == 2 else "uprising")
            prev = war.get((iso, y))
            rank = {"uprising": 0, "civilwar": 1, "war": 2}
            if not prev or rank[kind] > rank[prev[0]]:
                war[(iso, y)] = (kind, inten, "{} ({})".format(r["side_b"] if typ != 2 else r["side_a"] + " vs " + r["side_b"], r["location"]))
    conflict = np.zeros((N, T), np.int8)                         # 0 none, 1 uprising, 2 civil war, 3 war between states
    for (iso, y), (kind, inten, nm) in war.items():
        if iso in ci and y in yi and yi[y] < T:
            conflict[ci[iso], yi[y]] = {"uprising": 1, "civilwar": 2, "war": 3}[kind]
    for i in range(N):                                           # an event = the first year of a level, after two quieter years
        for j in range(T):
            lv = conflict[i, j]
            if lv and (j < 2 or conflict[i, max(0, j - 2):j].max() < lv):
                kind = {1: "uprising", 2: "civilwar", 3: "war"}[int(lv)]
                nm = war[(ids[i], years[j])][2]
                ev.append({"date": dates[j], "step": j, "type": kind, "id": ids[i], "name": meta[ids[i]]["name"], "by": None, "known": True,
                           "text": "{}: {}".format(meta[ids[i]]["name"], nm), "source": "UCDP/PRIO Armed Conflict v25.1"})
    # ---- coups (Powell & Thyne, month by month in CoupCats)
    b = _dl("coupcats_base.csv.gz", "https://raw.githubusercontent.com/thynec/CoupCats/main/2.a.base_data.csv.gz", refresh=refresh)
    coup = np.zeros((N, T), np.int8)
    for r in csv.DictReader(io.TextIOWrapper(gzip.open(io.BytesIO(b)), encoding="utf-8", errors="replace")):
        if r.get("coup_attempt") != "1":
            continue
        try:
            iso, y, mo = cow.get(int(float(r["ccode"]))), int(r["year"]), int(r["month"])
        except (TypeError, ValueError):
            continue
        ok = r.get("coup_successful") == "1"
        d = "{:04d}-{:02d}-15".format(y, mo)
        j = yi.get(y)
        if iso in ci and j is not None and j < T:
            coup[ci[iso], j] = 2 if ok else max(1, coup[ci[iso], j])
            ev.append({"date": d, "step": j, "type": "coup", "id": iso, "name": meta[iso]["name"], "by": None, "value": 1 if ok else 0, "known": True,
                       "text": "{}: {} coup ({:04d}-{:02d})".format(meta[iso]["name"], "successful" if ok else "failed", y, mo),
                       "source": "Powell & Thyne coups (CoupCats)"})
    # ---- currency crashes: the US$ rate up 30%+ in a year and 10+ points more than the year before (Frankel-Rose style)
    fx = M["fx"]
    with np.errstate(all="ignore"):
        dep = fx[:, 1:] / fx[:, :-1] - 1
    crash = np.zeros((N, T), bool)
    for i in range(N):
        for j in range(1, T):
            dj = dep[i, j - 1]
            if not np.isfinite(dj) or dj < 0.30:
                continue
            before = dep[i, j - 2] if j >= 2 else 0.0
            if np.isfinite(before) and dj - before < 0.10:
                continue
            if crash[i, max(0, j - 2):j].any():
                continue
            crash[i, j] = True
            loss = 1 - 1 / (1 + dj)
            ev.append({"date": dates[j], "step": j, "type": "currency", "id": ids[i], "name": meta[ids[i]]["name"], "by": None, "value": round(float(loss), 3),
                       "known": True, "text": "{}: the currency lost {:.0%} against the US$".format(meta[ids[i]]["name"], loss),
                       "source": "World Bank official exchange rate (PA.NUS.FCRF)"})
    # ---- state births and deaths (a fixed list)
    for d, kind, iso, txt in STATES:
        j = _step_after(dates, d)
        ev.append({"date": d, "step": j, "type": kind, "id": iso, "name": meta.get(iso, {}).get("name", iso), "by": None, "known": iso in ci,
                   "text": txt, "source": "history (fixed list)"})
    ev.sort(key=lambda x: (x["date"], x["type"]))
    with np.errstate(all="ignore"):
        gdppc = np.where(M["pop"] > 0, size / M["pop"], np.nan)
    W = {"world": "countries", "what": "real GDP (constant 2015 US$)", "unit": "US$", "step": "year", "group_name": "region",
         "ids": ids, "names": [meta[c]["name"] for c in ids], "groups": [meta[c]["region"]["value"].strip() for c in ids],
         "dates": dates, "size": size, "est": np.zeros((N, T), bool), "ret": ret, "member": np.isfinite(size), "geo": geo,
         "extra": {"gdppc": gdppc, "fx": fx, "pop": M["pop"], "real": M["gdp_real"],
                   "workage": _carry(M["workage"]), "life": _carry(M["life"]), "invest": _carry(M["invest"]), "conflict": conflict, "coup": coup, "crash": crash},
         "events": ev, "film": False,
         "notes": ["Size is real GDP in constant 2015 US$, so a currency crash does not shrink a country unless its real economy shrinks.",
                   "The map uses real GDP growth (constant US$), so it shows which economies move together, not which currencies.",
                   "Breakups and unions are history only: there are too few of them to learn a rate from."],
         "built": dt.datetime.utcnow().isoformat() + "Z"}
    _W["countries"] = W
    return W


def summary(W):
    """What the UI shows about a world before anything runs: its size, its span, and its events by type."""
    by = {}
    for e in W["events"]:
        by[e["type"]] = by.get(e["type"], 0) + 1
    m = W["member"]
    return {"world": W["world"], "what": W["what"], "step": W["step"], "group_name": W["group_name"],
            "first": W["dates"][0], "last": W["dates"][-1], "steps": len(W["dates"]),
            "bodies": int(m.any(1).sum()), "now": int(m[:, -1].sum()), "estimated": int(W["est"].any(1).sum()),
            "events": by, "notes": W["notes"], "groups": sorted(set(W["groups"]))}
