"""S&P 500 history for the Market gravity simulation: who was in the index each month, and what each company was worth.

Sources (all free, no keys):
  - Wikipedia "List of S&P 500 companies" (today's members, GICS sector, CIK) and "Historical components of the S&P 500"
    (every add/remove with its date) -> membership at any month-end, walked back from today.
  - SEC XBRL frames: dei:EntityCommonStockSharesOutstanding for every filer at each quarter-end, as reported then.
  - SEC submissions (SIC code) for former members, mapped to a GICS-like sector.
  - Yahoo Finance monthly chart: split-adjusted close plus the split events, so the as-traded price can be rebuilt.
Market cap(t) = shares reported at the latest quarter <= t  x  as-traded price at t.

Known gaps, reported by coverage(): companies that were acquired or went bankrupt are usually gone from Yahoo, so
their prices are missing; dual-class companies may report one class only on the cover page.
"""
import datetime as dt
import json
import os
import re
import time
import urllib.request

import numpy as np

ROOT = os.environ.get("VF_DATA", "/srv/data") + "/market"
UA_WEB = "Mozilla/5.0 (X11; Linux x86_64) Vectorfall"
# SEC asks automated clients to name a contact; set VF_SEC_CONTACT in .env
UA_SEC = "VectorFall research script " + os.environ.get("VF_SEC_CONTACT", "(contact not set)")
START = 2007


def _iso(x):
    return dt.datetime.strptime(x[:10], "%Y-%m-%d").date()


def _get(url, ua=UA_WEB, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept-Encoding": "identity"})
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            if getattr(e, "code", 0) == 404:
                return None
            time.sleep(1.5 * (i + 1))
    return None


def _cache(name, fetch, refresh=False):
    p = os.path.join(ROOT, "raw", name)
    if not refresh and os.path.exists(p):
        return open(p, "rb").read()
    b = fetch()
    if b is not None:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, "wb").write(b)
    return b


# ---------------------------------------------------------------- membership
def _cells(row):
    out = []
    for line in row.split("\n"):
        line = line.strip()
        if not line.startswith("|") or line.startswith("|-") or line.startswith("|}"):
            continue
        out += [c.strip() for c in re.split(r"\|\|", line.lstrip("|"))]
    return out


def _plain(s):
    s = re.sub(r"<ref[^>]*/>|<ref.*?</ref>", "", s, flags=re.S)
    m = re.search(r"\{\{\s*\w*Symbol\s*\|\s*([^}|]+)", s)
    if m:
        return m.group(1).strip()
    s = re.sub(r"\[\[(?:[^\]|]*\|)?([^\]]*)\]\]", r"\1", s)
    return re.sub(r"\{\{.*?\}\}|'''?", "", s).strip()


def constituents(refresh=False):
    w = _cache("sp500.wiki", lambda: _get("https://en.wikipedia.org/w/index.php?title=List_of_S%26P_500_companies&action=raw"), refresh).decode()
    t = w[w.index('id="constituents"'):]
    t = t[:t.index("\n|}")]
    out = []
    for row in t.split("\n|-")[2:]:
        c = _cells(row)
        if len(c) < 7:
            continue
        out.append({"ticker": _plain(c[0]).upper(), "name": _plain(c[1]), "sector": _plain(c[2]), "sub": _plain(c[3]),
                    "added": _plain(c[5])[:10], "cik": int(re.sub(r"\D", "", c[6]) or 0)})
    return out


def changes(refresh=False):
    w = _cache("hist.wiki", lambda: _get("https://en.wikipedia.org/w/index.php?title=Historical_components_of_the_S%26P_500&action=raw"), refresh).decode()
    t = w[w.index('id="changes"'):]
    t = t[:t.index("\n|}")]
    out = []
    for row in t.split("\n|-")[3:]:
        c = [_plain(x) for x in _cells(row)]
        if len(c) < 5:
            continue
        try:
            d = dt.datetime.strptime(re.sub(r"\s+", " ", c[0]).replace(",", ""), "%B %d %Y").date()
        except ValueError:
            continue
        out.append({"date": d.isoformat(), "add": c[1].upper(), "add_name": c[2], "rem": c[3].upper(), "rem_name": c[4],
                    "reason": c[5] if len(c) > 5 else ""})
    return out


def month_ends(y0=START):
    today = dt.date.today()
    out = []
    for y in range(y0, today.year + 1):
        for m in range(1, 13):
            d = (dt.date(y + (m == 12), m % 12 + 1, 1) - dt.timedelta(days=1))
            if d <= today:
                out.append(d)
    return out


def membership(cons, chg, dates):
    """{date: set(tickers)}: start from today and undo each change, newest first."""
    cur = {c["ticker"] for c in cons}
    ev = sorted(chg, key=lambda e: e["date"], reverse=True)
    out, k = {}, 0
    for d in sorted(dates, reverse=True):
        while k < len(ev) and ev[k]["date"] > d.isoformat():
            e = ev[k]
            if e["add"]:
                cur.discard(e["add"])
            if e["rem"]:
                cur.add(e["rem"])
            k += 1
        out[d] = set(cur)
    return out


# ---------------------------------------------------------------- SEC
def ticker_ciks(refresh=False):
    b = _cache("company_tickers.json", lambda: _get("https://www.sec.gov/files/company_tickers.json", UA_SEC), refresh)
    return {v["ticker"].upper().replace("-", "."): int(v["cik_str"]) for v in json.loads(b).values()}


_NAMES = {}


def _norm(n):
    n = re.sub(r"&", " and ", (n or "").lower())
    n = re.sub(r"[^a-z0-9 ]", " ", n)
    drop = {"inc", "corp", "corporation", "co", "company", "ltd", "plc", "the", "holdings", "holding", "group", "nv", "sa",
            "llc", "lp", "incorporated", "limited", "de", "new", "class", "a", "b", "com"}
    return "".join(w for w in n.split() if w not in drop)          # "ExxonMobil" == "EXXON MOBIL CORP"


def name_ciks(name):
    """Every filer CIK whose name matches (after normalising) — finds pre-reorganisation and delisted registrants."""
    k = _norm(name)
    return sorted(_NAMES.get(k, ())) if k else []


def shares_frames(refresh=False):
    """{cik: [(quarter_end_date, shares)]} from the XBRL frames API (one request per quarter)."""
    out = {}
    today = dt.date.today()
    for y in range(START - 1, today.year + 1):
        for q in range(1, 5):
            qe = dt.date(y, 3 * q, [31, 30, 30, 31][q - 1])
            if qe > today:
                break
            nm = "CY{}Q{}I".format(y, q)
            b = _cache("frames/" + nm + ".json", lambda: (time.sleep(0.15), _get(
                "https://data.sec.gov/api/xbrl/frames/dei/EntityCommonStockSharesOutstanding/shares/{}.json".format(nm), UA_SEC))[1],
                refresh and qe > today - dt.timedelta(days=200))
            if not b:
                continue
            for r in json.loads(b).get("data", []):
                out.setdefault(int(r["cik"]), []).append((qe, float(r["val"])))
                _NAMES.setdefault(_norm(r.get("entityName")), set()).add(int(r["cik"]))
    for v in out.values():
        v.sort()
    return out


SIC_SECTOR = [  # coarse SIC -> GICS sector, for former members that are not on today's list
    ((100, 999), "Consumer Staples"), ((1000, 1299), "Materials"), ((1300, 1399), "Energy"), ((1400, 1499), "Materials"),
    ((1500, 1799), "Industrials"), ((2000, 2199), "Consumer Staples"), ((2200, 2399), "Consumer Discretionary"),
    ((2400, 2699), "Materials"), ((2700, 2799), "Communication Services"), ((2800, 2829), "Materials"),
    ((2830, 2839), "Health Care"), ((2840, 2849), "Consumer Staples"), ((2850, 2899), "Materials"), ((2900, 2999), "Energy"),
    ((3000, 3499), "Materials"), ((3500, 3569), "Industrials"), ((3570, 3579), "Information Technology"),
    ((3580, 3659), "Industrials"), ((3660, 3699), "Information Technology"), ((3700, 3709), "Consumer Discretionary"),
    ((3710, 3719), "Consumer Discretionary"), ((3720, 3799), "Industrials"), ((3800, 3849), "Health Care"),
    ((3850, 3899), "Health Care"), ((3900, 3999), "Consumer Discretionary"), ((4000, 4799), "Industrials"),
    ((4800, 4899), "Communication Services"), ((4900, 4999), "Utilities"), ((5000, 5199), "Industrials"),
    ((5200, 5999), "Consumer Discretionary"), ((6000, 6499), "Financials"), ((6500, 6799), "Real Estate"),
    ((7000, 7369), "Consumer Discretionary"), ((7370, 7379), "Information Technology"), ((7380, 7999), "Industrials"),
    ((8000, 8099), "Health Care"), ((8100, 8999), "Industrials")]


def sic_sector(cik):
    b = _cache("sub/{}.json".format(cik), lambda: (time.sleep(0.15), _get("https://data.sec.gov/submissions/CIK{:010d}.json".format(cik), UA_SEC))[1])
    if not b:
        return None, None
    j = json.loads(b)
    try:
        sic = int(j.get("sic") or 0)
    except ValueError:
        sic = 0
    for (a, z), s in SIC_SECTOR:
        if a <= sic <= z:
            return s, j.get("name")
    return None, j.get("name")


# ---------------------------------------------------------------- prices
def prices(ticker, refresh=False):
    """(monthly [(month_end_date, split-adjusted close)], splits [(date, ratio)]) for a ticker, or (None, [])."""
    y = ticker.replace(".", "-")
    p0 = int(time.mktime(dt.date(START - 1, 12, 1).timetuple()))
    b = _cache("px/{}.json".format(y), lambda: (time.sleep(0.25), _get(
        "https://query1.finance.yahoo.com/v8/finance/chart/{}?period1={}&period2={}&interval=1mo&events=split".format(
            y, p0, int(time.time()))))[1], refresh)
    if not b:
        return None, []
    try:
        r = json.loads(b)["chart"]["result"][0]
        ts, close = r["timestamp"], r["indicators"]["quote"][0]["close"]
    except (KeyError, IndexError, TypeError, ValueError):
        return None, []
    splits = sorted((dt.datetime.utcfromtimestamp(int(x["date"])).date(), x["numerator"] / x["denominator"])
                    for x in (r.get("events", {}).get("splits", {}) or {}).values() if x.get("denominator"))
    out = []
    for t, c in zip(ts, close):
        if c is None:
            continue
        d = dt.datetime.utcfromtimestamp(t).date()
        me = (dt.date(d.year + (d.month == 12), d.month % 12 + 1, 1) - dt.timedelta(days=1))
        out.append((me, c))
    return out, splits


CONCEPTS = ["us-gaap/WeightedAverageNumberOfSharesOutstandingBasic", "dei/EntityCommonStockSharesOutstanding"]


def shares_concepts(cik, refresh=False):
    """[(period_end, value, basis_date)] from the filer's own XBRL facts; basis_date = when it was filed (later filings
    restate old periods on the post-split basis, so the filing date says which splits are already in the number)."""
    out = []
    for c in CONCEPTS:
        b = _cache("cc/{}_{}.json".format(cik, c.split("/")[1][:12]), lambda: (time.sleep(0.12), _get(
            "https://data.sec.gov/api/xbrl/companyconcept/CIK{:010d}/{}.json".format(cik, c), UA_SEC))[1], refresh)
        if not b:
            continue
        try:
            u = json.loads(b)["units"]["shares"]
        except (KeyError, ValueError):
            continue
        for f in u:
            try:
                end = _iso(f["end"])
                filed = _iso(f["filed"])
            except (KeyError, ValueError):
                continue
            if "start" in f:
                days = (end - _iso(f["start"])).days
                if not (75 <= days <= 100 or 350 <= days <= 380):
                    continue
            if f.get("val"):
                out.append((end, float(f["val"]), filed))
    # net income / basic EPS: one number for the whole company, whatever its share classes
    ni, eps = {}, {}
    for c, dst, unit in [("us-gaap/NetIncomeLoss", ni, "USD"), ("us-gaap/EarningsPerShareBasic", eps, "USD/shares")]:
        b = _cache("cc/{}_{}.json".format(cik, c.split("/")[1][:12]), lambda: (time.sleep(0.12), _get(
            "https://data.sec.gov/api/xbrl/companyconcept/CIK{:010d}/{}.json".format(cik, c), UA_SEC))[1], refresh)
        if not b:
            continue
        try:
            u = json.loads(b)["units"][unit]
        except (KeyError, ValueError):
            continue
        for f in u:
            try:
                end, start, filed = _iso(f["end"]), _iso(f["start"]), _iso(f["filed"])
            except (KeyError, ValueError):
                continue
            days = (end - start).days
            if (75 <= days <= 100 or 350 <= days <= 380) and f.get("val") is not None:
                k = (start, end)
                if k not in dst or filed < dst[k][1]:
                    dst[k] = (float(f["val"]), filed)
    for k, (e, fe) in eps.items():
        if k in ni and abs(e) >= 0.05 and abs(ni[k][0]) > 1e7:
            out.append((k[1], ni[k][0] / e, max(fe, ni[k][1])))
    return out


def clean_shares(pts, splits, special=1.0):
    """Split-adjust each point to today's basis, keep the earliest filing per period, then drop points more than
    1.5x away from the median of their neighbours (unit slips, one-class cover pages)."""
    by = {}
    pts = [x for x in pts if x[1] and x[1] > 0]
    for end, v, basis in pts:
        f = 1.0
        for sd, ratio in splits:
            if sd > basis:
                f *= ratio
        k = end
        if k not in by or basis < by[k][1]:
            by[k] = (v * f * special, basis)
    ser = sorted((k, v) for k, (v, _) in by.items())
    if len(ser) >= 5:                                   # whole-series check first: unit slips are 1000x, not 1.5x
        med = np.median(np.log([v for _, v in ser]))
        ser = [x for x in ser if abs(np.log(x[1]) - med) < np.log(4)]
    if len(ser) < 3:
        return ser
    lv = np.log([v for _, v in ser])
    keep = []
    for i in range(len(ser)):
        w = lv[max(0, i - 3):i + 4]
        if abs(lv[i] - np.median(w)) < np.log(1.5):
            keep.append(ser[i])
    return keep


# ---------------------------------------------------------------- build
def build(refresh=False, log=print):
    cons, chg = constituents(refresh), changes(refresh)
    dates = month_ends()
    mem = membership(cons, chg, dates)
    tick = sorted(set().union(*mem.values()))
    t2c = ticker_ciks(refresh)
    info = {c["ticker"]: {"name": c["name"], "sector": c["sector"], "sub": c["sub"], "cik": c["cik"] or t2c.get(c["ticker"], 0)} for c in cons}
    names = {}
    for e in chg:
        if e["rem"]:
            names.setdefault(e["rem"], e["rem_name"])
        if e["add"]:
            names.setdefault(e["add"], e["add_name"])
    log("{} tickers were in the index at some time since {}. Get the SEC share counts.".format(len(tick), START))
    frames = shares_frames(refresh)
    for t in tick:
        if t not in info:
            cik = t2c.get(t, 0)
            sec, nm = sic_sector(cik) if cik else (None, None)
            info[t] = {"name": names.get(t) or nm or t, "sector": sec, "sub": "", "cik": cik}
        if not info[t]["sector"]:                       # former member with no CIK: try the name match for its SIC
            for c2 in name_ciks(info[t]["name"])[:1]:
                info[t]["sector"], _ = sic_sector(c2)
    T, D = len(tick), len(dates)
    cap = np.full((T, D), np.nan, np.float64)
    px = np.full((T, D), np.nan, np.float64)
    di = {d: j for j, d in enumerate(dates)}
    src = {"frames": 0, "facts": 0}
    for i, t in enumerate(tick):
        p, splits = prices(t, refresh)
        if i % 50 == 0:
            log("prices + shares {}/{}".format(i, T))
        if not p:
            continue
        for d, c in p:
            j = di.get(d)
            if j is not None:
                px[i, j] = c
        ciks = sorted(set(([info[t]["cik"]] if info[t]["cik"] else []) + name_ciks(info[t]["name"])))
        if not ciks:
            continue
        info[t]["ciks"] = ciks
        pts = []
        for cik in ciks:
            pts += [(d, v, d) for d, v in frames.get(cik, [])] + shares_concepts(cik, refresh)
        if t == "BRK.B":                    # Berkshire reports Class A-equivalent shares in some places; one A = 1,500 B
            pts = [(d, v * 1500 if v < 1e8 else v, b_) for d, v, b_ in pts]
            pts = [x for x in pts if x[1] > 2.0e9]      # what is left below that mixes the pre-2010 A basis
        q = clean_shares(pts, splits)
        if not q:
            continue
        qi, k = 0, -1
        for j, d in enumerate(dates):
            while qi < len(q) and q[qi][0] <= d:
                k = qi
                qi += 1
            if k >= 0 and (d - q[k][0]).days < 400:
                cap[i, j] = px[i, j] * q[k][1]
    inidx = np.zeros((T, D), bool)
    ti = {t: i for i, t in enumerate(tick)}
    for d, s_ in mem.items():
        for t in s_:
            inidx[ti[t], di[d]] = True
    os.makedirs(ROOT, exist_ok=True)
    np.savez_compressed(os.path.join(ROOT, "panel.npz"), cap=cap, px=px, inidx=inidx,
                        dates=np.array([d.isoformat() for d in dates]), tickers=np.array(tick))
    json.dump({"info": info, "changes": chg, "built": dt.datetime.utcnow().isoformat() + "Z"}, open(os.path.join(ROOT, "meta.json"), "w"))
    return coverage()


def load():
    if not os.path.exists(os.path.join(ROOT, "panel.npz")):
        from .registry import Refused
        raise Refused("The S&P 500 history is not on this machine yet. Download it once with "
                      "`vf run particles.refresh --source sp500` (a few minutes; Wikipedia, SEC and Yahoo). "
                      "The Countries (GDP) world works now.", 409)
    z = np.load(os.path.join(ROOT, "panel.npz"))
    meta = json.load(open(os.path.join(ROOT, "meta.json")))
    return {k: z[k] for k in z.files}, meta


def coverage():
    P, meta = load()
    cap, inidx, dates = P["cap"], P["inidx"], P["dates"]
    rows = []
    for j in range(0, len(dates), 12):
        m = inidx[:, j]
        have = m & np.isfinite(cap[:, j])
        rows.append({"date": dates[j], "members": int(m.sum()), "with_cap": int(have.sum()),
                     "cap_tn": round(float(np.nansum(np.where(have, cap[:, j], 0))) / 1e12, 2)})
    return {"rows": rows, "tickers": len(P["tickers"])}


if __name__ == "__main__":
    import sys
    print(json.dumps(build(refresh="--refresh" in sys.argv), indent=1))
