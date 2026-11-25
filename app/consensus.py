"""What the professionals say, to compare with the Particle Lab's futures.

Countries: the World Bank's Global Economic Prospects (real GDP growth forecasts, WDI API source 27) and the IMF World
Economic Outlook (real GDP growth, DataMapper NGDP_RPCH; both made per person with recent population growth). Both are public and keyless; they are cached
for a day under data/worlds/raw.
Companies: analyst consensus fetched live from Yahoo Finance when a company is opened. It is held in memory for ten
minutes and never written to disk or passed on (Yahoo's terms do not allow redistribution). Rows harvested from public
search results by tools/consensus_harvest.py (each with its URL and a verbatim quote) are read from data/consensus."""
import glob
import http.cookiejar
import json
import os
import time
import urllib.request

ROOT = os.environ.get("VF_DATA", "/srv/data")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
_MEM = {}


def _get(url, timeout=25, opener=None, accept="*/*", ua=UA):
    r = urllib.request.Request(url, headers={"User-Agent": ua, "Accept": accept})
    with (opener.open(r, timeout=timeout) if opener else urllib.request.urlopen(r, timeout=timeout)) as f:
        return f.read().decode("utf-8", "replace")


def _cached(name, url, max_age=86400, ua=UA):
    p = os.path.join(ROOT, "worlds", "raw", name)
    if os.path.exists(p) and time.time() - os.path.getmtime(p) < max_age:
        return open(p, encoding="utf-8").read()
    try:
        s = _get(url, 60, ua=ua)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p + ".tmp", "w", encoding="utf-8").write(s)
        os.replace(p + ".tmp", p)
        return s
    except Exception:  # noqa: BLE001
        if os.path.exists(p):
            return open(p, encoding="utf-8").read()
        raise


def country(iso):
    """{source: {year: growth %}} for one country."""
    out = {}
    try:
        rows = json.loads(_cached("gep_NYGDPMKTPKDZ.json", "https://api.worldbank.org/v2/country/all/indicator/NYGDPMKTPKDZ?source=27&format=json&per_page=20000&date=2020:2030"))[1] or []
        g = {int(r["date"]): float(r["value"]) for r in rows if r.get("countryiso3code") == iso and r.get("value") is not None}
        if g:
            out["wb"] = {"name": "World Bank, Global Economic Prospects", "what": "real GDP growth (total, not per person)", "per_person": False,
                         "growth": g, "updated": (json.loads(_cached("gep_NYGDPMKTPKDZ.json", ""))[0] or {}).get("lastupdated")}
    except Exception as e:  # noqa: BLE001
        out["wb_error"] = str(e)
    try:
        d = json.loads(_cached("imf_NGDP_RPCH.json", "https://www.imf.org/external/datamapper/api/v1/NGDP_RPCH", ua="curl/8.5.0"))   # its CDN refuses browser-like agents from servers
        g = {int(y): float(v) for y, v in ((d.get("values") or {}).get("NGDP_RPCH") or {}).get(iso, {}).items() if v is not None}
        if g:
            out["imf"] = {"name": "IMF, World Economic Outlook", "what": "real GDP growth (total, not per person)", "per_person": False, "growth": g}
    except Exception as e:  # noqa: BLE001
        out["imf_error"] = str(e)
    return out


def _yahoo(sym):
    hit = _MEM.get(sym)
    if hit and time.time() - hit[0] < 600:
        return hit[1]
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    _get("https://finance.yahoo.com/quote/{}/".format(sym), 20, op, "text/html")
    crumb = _get("https://query2.finance.yahoo.com/v1/test/getcrumb", 20, op)
    r = json.loads(_get("https://query2.finance.yahoo.com/v10/finance/quoteSummary/{}?modules=financialData,recommendationTrend,earningsTrend,price&crumb={}".format(sym.replace(".", "-"), crumb), 20, op))
    x = r["quoteSummary"]["result"][0]
    fd = x.get("financialData") or {}
    raw = lambda o, k: (o.get(k) or {}).get("raw") if isinstance(o.get(k), dict) else o.get(k)
    tr = ((x.get("recommendationTrend") or {}).get("trend") or [{}])[0]
    pr = x.get("price") or {}
    out = {"source": "Yahoo Finance (live, not stored)", "fetched": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()),
           "price": raw(fd, "currentPrice"), "market_cap": raw(pr, "marketCap"), "target_mean": raw(fd, "targetMeanPrice"),
           "target_median": raw(fd, "targetMedianPrice"), "target_high": raw(fd, "targetHighPrice"), "target_low": raw(fd, "targetLowPrice"),
           "analysts": raw(fd, "numberOfAnalystOpinions"), "rating": (fd.get("recommendationKey") or "").replace("_", " ") or None,
           "votes": {k: tr.get(k) for k in ("strongBuy", "buy", "hold", "sell", "strongSell")},
           "eps": [{"period": t.get("period"), "eps": raw(t.get("earningsEstimate") or {}, "avg"), "revenue": raw(t.get("revenueEstimate") or {}, "avg")}
                   for t in (x.get("earningsTrend") or {}).get("trend", []) if t.get("period") in ("0y", "+1y")]}
    _MEM[sym] = (time.time(), out)
    return out


def company(sym):
    out = {}
    try:
        out["live"] = _yahoo(sym)
    except Exception as e:  # noqa: BLE001
        out["live_error"] = "Yahoo did not answer ({})".format(str(e)[:80])
    rows = []
    for fp in sorted(glob.glob(os.path.join(ROOT, "consensus", "harvest-*", sym + ".jsonl"))):
        rows += [json.loads(l) for l in open(fp) if l.strip()]
    seen, uniq = set(), []
    for r in rows:                                     # the same page is often found by several searches
        k = (r.get("url"), r.get("target_mean"), r.get("rating"), r.get("as_of"))
        if k not in seen:
            seen.add(k)
            uniq.append(r)
    out["harvested"] = sorted(uniq, key=lambda r: (r.get("as_of") or r.get("published") or ""), reverse=True)[:40]
    return out
