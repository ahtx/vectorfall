"""What predicts a country's growth? Each candidate series is tested the honest way before it may become a force.

From every start year (1990 to five years before the data ends), countries are ranked by the series that year and by
their real GDP growth per person over the next five years. The rank correlation is taken per start year; the table
gives its mean, a t value across start years (with overlapping windows, so read t as rough) and the share of start
years with the same sign. "Beyond income" repeats it after removing what log income per person already explains:
most of these series mostly measure being poor, and catch-up is already a force.
Sources: the World Bank WDI API (CC BY 4.0), keyless."""
import math

import numpy as np

from . import forcerun as FR
from . import worlds as WD

SERIES = [
    ("EG.USE.PCAP.KG.OE", "Energy use per person", "kg of oil equivalent", True),
    ("NE.GDI.TOTL.ZS", "Investment", "% of GDP", False),
    ("SP.POP.1564.TO.ZS", "Working-age share", "% of people aged 15-64", False),
    ("FP.CPI.TOTL.ZG", "Inflation", "% a year", False),
    ("NE.TRD.GNFS.ZS", "Trade openness", "exports + imports, % of GDP", True),
    ("SP.DYN.LE00.IN", "Life expectancy", "years", False),
    ("SP.DYN.IMRT.IN", "Infant mortality", "per 1,000 births", True),
    ("NY.GDP.TOTL.RT.ZS", "Natural-resource rents", "% of GDP", False),
    ("SP.URB.TOTL.IN.ZS", "Urban share", "% of people", False),
]
H = 5


def _rank(x):
    o = np.argsort(x)
    r = np.empty(len(x))
    r[o] = np.arange(len(x))
    return r


def _spearman(a, b):
    if len(a) < 15:
        return None
    ra, rb = _rank(a), _rank(b)
    return float(np.corrcoef(ra, rb)[0, 1])


def _matrix(W, ind):
    rows = WD._wb(ind)
    ci = {c: i for i, c in enumerate(W["ids"])}
    yi = {int(d[:4]): j for j, d in enumerate(W["dates"])}
    A = np.full((len(W["ids"]), len(W["dates"])), np.nan)
    for r in rows:
        c, v = r.get("countryiso3code"), r.get("value")
        if c in ci and v is not None and int(r["date"]) in yi:
            A[ci[c], yi[int(r["date"])]] = float(v)
    return A


def run(world="countries"):
    if world != "countries":
        raise ValueError("the predictor table is for countries (company fundamentals come from SEC filings, not yet loaded)")
    W = FR.world("countries")
    ex = W["extra"]
    with np.errstate(all="ignore"):
        pc = np.log(np.where((ex["real"] > 0) & (ex["pop"] > 0), ex["real"] / ex["pop"], np.nan))
    T = pc.shape[1]
    years = [int(d[:4]) for d in W["dates"]]
    origins = [t for t in range(T - H) if years[t] >= 1990]
    out = []
    base = [("__income", "Income per person (log, real)", "the catch-up variable itself", False)] + SERIES
    for ind, name, unit, logit in base:
        try:
            X = pc if ind == "__income" else _matrix(W, ind)
        except Exception as e:  # noqa: BLE001
            out.append({"code": ind, "name": name, "error": str(e)[:80]})
            continue
        if logit:
            with np.errstate(all="ignore"):
                X = np.log(np.where(X > 0, X, np.nan))
        r_raw, r_part, n_all = [], [], []
        for t in origins:
            x = X[:, t] if ind == "__income" else np.nanmean(X[:, max(0, t - 2):t + 1], 1)   # the last 3 years known
            g = (pc[:, t + H] - pc[:, t]) / H
            inc = pc[:, t]
            ok = np.isfinite(x) & np.isfinite(g) & np.isfinite(inc)
            if ok.sum() < 30:
                continue
            r = _spearman(x[ok], g[ok])
            if r is None:
                continue
            r_raw.append(r)
            n_all.append(int(ok.sum()))
            if ind != "__income":                       # beyond income: residuals of both on log income
                A = np.c_[np.ones(ok.sum()), inc[ok]]
                rx = x[ok] - A @ np.linalg.lstsq(A, x[ok], rcond=None)[0]
                rg = g[ok] - A @ np.linalg.lstsq(A, g[ok], rcond=None)[0]
                r_part.append(_spearman(rx, rg))
        if not r_raw:
            out.append({"code": ind, "name": name, "unit": unit, "error": "too little data"})
            continue
        def summ(v):
            v = np.array([x for x in v if x is not None])
            if v.size < 3:
                return None
            m = float(v.mean())
            return {"mean": round(m, 3), "t": round(m / (v.std(ddof=1) / math.sqrt(v.size)), 1), "same_sign": round(float((np.sign(v) == np.sign(m)).mean()), 2), "starts": int(v.size)}
        out.append({"code": ind, "name": name, "unit": unit, "raw": summ(r_raw), "beyond_income": summ(r_part) if r_part else None,
                    "countries": int(np.median(n_all)), "first": years[origins[0]], "last": years[origins[-1]]})
    def strength(r):
        b = r.get("beyond_income") or r.get("raw") or {}
        return -abs(b.get("mean") or 0)
    out.sort(key=strength)
    res = {"world": world, "horizon": H, "target": "real GDP growth per person over the next {} years".format(H), "series": out,
           "note": "Rank correlations across countries, one per start year; t treats start years as independent (they overlap), so read it as rough. "
                   "|r| of 0.1 is weak, 0.3 is strong for growth (Pritchett & Summers find decade growth hard to predict)."}
    FR._save(world, "predictors", res)
    return res
