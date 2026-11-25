"""Shared data sources: every tool that works on numbers reads them from the Data Desk.

A ticker download, a pasted list of numbers, an event log found in a recording, a solved roster -- all of them become
ordinary Data Desk tables, so any tool can pick them up again (watch a column for anomalies, project it in Simulate,
forecast it in the Reservoir Lab). This module turns things into tables and tables back into series.
"""
import csv
import datetime
import io
import re

import numpy as np

from . import media

_DATE_FORMATS = ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y/%m/%d", "%m/%d/%Y",
                 "%d/%m/%Y", "%m/%d/%y", "%d/%m/%y", "%d.%m.%Y", "%Y%m%d", "%b %d %Y", "%b %d, %Y", "%d %b %Y", "%d-%b-%Y",
                 "%a %d %b %Y", "%a, %d %b %Y", "%a %b %d %Y", "%A %d %B %Y", "%d %B %Y", "%B %d, %Y", "%Y-%m", "%b-%y", "%B %Y")


_ANNOTATED_YEAR = re.compile(r"^([1-9][0-9]{3})(?:\s*(?:[A-Za-z]|\[[0-9]+\]|\([A-Za-z]\)))?$")


def _year(value):
    match = _ANNOTATED_YEAR.fullmatch((value or "").strip())
    return datetime.datetime.strptime(match.group(1), "%Y") if match else None


def parse_dates(values):
    """A whole column of dates -> (datetimes or None, a note). One format for the column: the one that reads the most
    values; between month/day and day/month, day-first wins when any first field is over 12, and an undecidable column
    is read month/day and said so (a per-value guess re-sorted UK dates silently)."""
    vals = [(v or "").strip() for v in values]
    sample = [v for v in vals if v][:400]
    if not sample:
        return [None] * len(vals), ""
    best, best_n = None, 0
    for f in ("%Y",) + _DATE_FORMATS:
        n = 0
        for v in sample:
            for cand in (v, v[:19], v[:10]):
                if f == "%Y" and _year(cand) is not None:
                    n += 1
                    break
                try:
                    datetime.datetime.strptime(cand, f)
                    n += 1
                    break
                except ValueError:
                    continue
        if n > best_n:
            best, best_n = f, n
    note = ""
    pair = {"%m/%d/%Y": "%d/%m/%Y", "%m/%d/%y": "%d/%m/%y"}
    if best in pair:
        firsts = [int(v.split("/")[0]) for v in sample if v.count("/") >= 2 and v.split("/")[0].isdigit()]
        if any(x > 12 for x in firsts):
            best, note = pair[best], "dates read as day/month"
        elif all(int(v.split("/")[1]) <= 12 for v in sample if v.count("/") >= 2 and v.split("/")[1].isdigit()):
            note = "dates could be month/day or day/month; read as month/day"
    if best is None or best_n < 0.8 * len(sample):
        return [parse_date(v) for v in vals], ""
    out = []
    for v in vals:
        d = None
        for cand in (v, v[:19], v[:10]):
            try:
                d = datetime.datetime.strptime(cand, best)
                break
            except ValueError:
                continue
        out.append(d if d is not None else parse_date(v))
    return out, note


def table_from_rows(name, header, rows):
    """A list of rows -> a new Data Desk table (same path as an uploaded CSV, so it behaves identically)."""
    b = io.StringIO()
    w = csv.writer(b)
    w.writerow(header)
    for r in rows:
        w.writerow(["" if v is None else (repr(v) if isinstance(v, float) and v != int(v) else v) for v in r])
    return media.table_add(name if name.lower().endswith(".csv") else name + ".csv", b.getvalue().encode("utf-8"))


def import_ticker(symbol, years=10):
    from .reservoir import fetch_ticker
    sym, rows = fetch_ticker(symbol, years)
    if len(rows) < 2:
        raise ValueError("no prices for " + sym)
    return table_from_rows("{} daily {}y".format(sym, int(years)), ["Date", sym + " close", sym + " volume"],
                           [[d, p, v] for d, p, v in rows])


def import_numbers(name, text):
    """Pasted numbers: one column per line of numbers, or a pasted CSV with a header (kept as-is)."""
    text = (text or "").strip()
    if not text:
        raise ValueError("paste some numbers first")
    first = text.splitlines()[0]
    if re.search(r"[A-Za-z]", first) and ("," in first or "\t" in first or ";" in first):
        return media.table_add((name or "pasted") + ".csv", text.encode("utf-8"))
    vals = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?", text.replace(",", " ") if text.count(",") > text.count(".") * 2 else text)]
    if len(vals) < 3:
        raise ValueError("found fewer than 3 numbers in what you pasted")
    return table_from_rows(name or "pasted numbers", ["step", "value"], [[i + 1, v] for i, v in enumerate(vals)])


def parse_date(s):
    s = (s or "").strip()
    if not s:
        return None
    annotated = _year(s)
    if annotated is not None:
        return annotated
    for cand in (s, s[:19], s[:10]):                             # "2024-01-05T10:00:00+00:00" falls back to its prefix
        for f in ("%Y",) + _DATE_FORMATS:
            try:
                return datetime.datetime.strptime(cand, f)
            except ValueError:
                continue
    return None


def date_columns(tid):
    """Text dates and explicitly named numeric year columns, best first."""
    meta, X, cat = media._load_table(tid)
    out = []
    for name, vals in zip(cat["names"], cat["values"]):
        sample = [v for v in vals[:400] if v.strip()][:60]
        if len(sample) < 3:
            continue
        ok = sum(parse_date(v) is not None for v in sample)
        if ok >= 0.8 * len(sample):
            out.append(name)
    for j, name in enumerate(meta["numeric"]):
        if not re.search(r"(^|[^a-z])(year|date)([^a-z]|$)", name, re.I):
            continue
        vals = X[:400, j]
        vals = vals[np.isfinite(vals)]
        if len(vals) >= 3 and np.mean((vals == np.floor(vals)) & (vals >= 1000) & (vals <= 9999)) >= .8:
            out.append(name)
    return out


def series(tid, cols, date_col=None, label_col=None):
    """Columns of a table -> (values n x k float64 with gaps filled, names, labels for the x axis, filled mask,
    known-incident flags or None, notes). Rows are kept in file order unless a date column says otherwise."""
    meta, X, cat = media._load_table(tid)
    if not cols:
        raise ValueError("choose at least one numeric column")
    for c in cols:
        if c not in meta["numeric"]:
            raise ValueError("'{}' is not a numeric column".format(c))
    V = np.stack([X[:, meta["numeric"].index(c)].astype(np.float64) for c in cols], 1)
    notes = []
    labels = None
    if date_col == "auto":
        dc = date_columns(tid)
        date_col = dc[0] if dc else None
    if date_col and (date_col in cat["names"] or date_col in meta["numeric"]):
        if date_col in cat["names"]:
            raw = cat["values"][cat["names"].index(date_col)]
        else:
            raw = [str(int(v)) if np.isfinite(v) else "" for v in X[:, meta["numeric"].index(date_col)]]
        dts, dnote = parse_dates(raw)
        if dnote:
            notes.append(dnote)
        good = np.array([d is not None for d in dts])
        if good.mean() >= 0.8:
            order = sorted(np.flatnonzero(good), key=lambda i: dts[i])
            if list(order) != list(np.flatnonzero(good)):
                notes.append("rows sorted by " + date_col)
            if (~good).sum():
                notes.append("{} rows without a readable date dropped".format(int((~good).sum())))
            V = V[order]
            labels = [raw[i] for i in order]
            idx = np.asarray(order)
        else:
            idx = np.arange(V.shape[0])
            date_col = None
    else:
        idx = np.arange(V.shape[0])
        date_col = None
    known = None
    if label_col:
        if label_col in meta["numeric"]:
            k = X[idx, meta["numeric"].index(label_col)]
            known = np.nan_to_num(k) != 0
        elif label_col in cat["names"]:
            k = cat["values"][cat["names"].index(label_col)]
            known = np.array([bool(k[i].strip()) and k[i].strip().lower() not in ("0", "no", "false", "n") for i in idx])
    keep = np.isfinite(V).any(1)
    if (~keep).sum():
        notes.append("{} empty rows skipped".format(int((~keep).sum())))
    V = V[keep]
    if labels is not None:
        labels = [l for l, k_ in zip(labels, keep) if k_]
    if known is not None:
        known = known[keep]
    filled = ~np.isfinite(V)
    if filled.any():
        for j in range(V.shape[1]):                              # carry the last value forward over gaps
            c = V[:, j]
            ok = np.isfinite(c)
            if not ok.any():
                raise ValueError("column '{}' has no numbers".format(cols[j]))
            first = np.flatnonzero(ok)[0]
            c[:first] = c[first]
            last = np.maximum.accumulate(np.where(ok, np.arange(c.size), 0))
            V[:, j] = c[last]
        notes.append("{} blank cells filled with the previous value".format(int(filled.sum())))
    return {"values": V, "names": list(cols), "labels": labels, "date_col": date_col, "filled": filled.any(1),
            "known": known, "notes": notes, "table": meta.get("name")}
