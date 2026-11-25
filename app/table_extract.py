"""Bounded HTML and text-PDF table extraction with source and cleaning provenance."""
import copy
import hashlib
import html
import json
import os
import re
import threading
from collections import OrderedDict
from html.parser import HTMLParser
from urllib.parse import urlparse

from . import media, sources


MAX_BYTES = 10_000_000
MAX_ROWS = 5000
MAX_TABLES = 300
SKIP = {"script", "style", "noscript", "svg"}
REFERENCE = re.compile(r"\[\d+(?:\s*[-–,]\s*\d+)*\]")


class TableParser(HTMLParser):
    def __init__(self):
        HTMLParser.__init__(self, convert_charrefs=True)
        self.stack, self.tables, self.skip = [], [], 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        reference = tag == "sup" and ({"reference", "mw-ref"} & set(attrs.get("class", "").split()))
        if tag in SKIP or reference:
            self.skip += 1
            return
        if self.skip:
            return
        if tag == "table":
            self.stack.append({"caption": [], "rows": [], "row": None, "cell": None,
                               "in_caption": False, "truncated": False})
            return
        if not self.stack:
            return
        table = self.stack[-1]
        if tag == "caption":
            table["in_caption"] = True
        elif tag == "tr":
            self._end_row(table)
            if len(table["rows"]) < MAX_ROWS:
                table["row"] = {"number": len(table["rows"]) + 1, "cells": []}
            else:
                table["truncated"] = True
        elif tag in ("td", "th") and table["row"] is not None:
            self._end_cell(table)
            table["cell"] = {"text": [], "rowspan": _span(attrs.get("rowspan")),
                             "colspan": _span(attrs.get("colspan"))}
        elif tag == "br" and table["cell"] is not None:
            table["cell"]["text"].append(" ")

    def handle_endtag(self, tag):
        if self.skip:
            if tag in SKIP or tag == "sup":
                self.skip -= 1
            return
        if not self.stack:
            return
        table = self.stack[-1]
        if tag == "caption":
            table["in_caption"] = False
        elif tag in ("td", "th"):
            self._end_cell(table)
        elif tag == "tr":
            self._end_row(table)
        elif tag == "table":
            self._end_cell(table)
            self._end_row(table)
            self.tables.append(_grid(table))
            if len(self.tables) > MAX_TABLES:
                raise ValueError("the page has more than {} tables; extract a smaller document".format(MAX_TABLES))
            self.stack.pop()

    def handle_data(self, data):
        if self.skip or not self.stack:
            return
        table = self.stack[-1]
        if table["cell"] is not None:
            table["cell"]["text"].append(data)
        elif table["in_caption"]:
            table["caption"].append(data)

    @staticmethod
    def _end_cell(table):
        cell = table["cell"]
        if cell is not None and table["row"] is not None:
            cell["text"] = _clean("".join(cell["text"]))
            table["row"]["cells"].append(cell)
        table["cell"] = None

    @staticmethod
    def _end_row(table):
        TableParser._end_cell(table)
        if table["row"] is not None:
            table["rows"].append(table["row"])
        table["row"] = None

    def finish(self):
        while self.stack:
            self.handle_endtag("table")
        return self.tables


def _span(value):
    try:
        return min(500, max(1, int(value)))
    except (TypeError, ValueError):
        return 1


def _clean(value):
    return re.sub(r"\s+", " ", REFERENCE.sub("", html.unescape(value or ""))).strip()


def _grid(table):
    rows, numbers, carry = [], [], {}
    for source_row in table["rows"]:
        grid = {col: value for col, (value, _remaining) in carry.items()}
        old = set(carry)
        col = 0
        for cell in source_row["cells"]:
            for _ in range(cell["colspan"]):
                while col in grid:
                    col += 1
                grid[col] = cell["text"]
                if cell["rowspan"] > 1:
                    carry[col] = (cell["text"], cell["rowspan"] - 1)
                col += 1
        for key in old:
            value, remaining = carry[key]
            if remaining > 1:
                carry[key] = (value, remaining - 1)
            else:
                carry.pop(key, None)
        width = max(grid) + 1 if grid else 0
        rows.append([grid.get(i, "") for i in range(width)])
        numbers.append(source_row["number"])
    width = max([len(row) for row in rows] or [0])
    rows = [(row + [""] * width)[:width] for row in rows]
    return {"caption": _clean("".join(table["caption"])), "rows": rows, "source_rows": numbers,
            "truncated": table["truncated"]}


def parse_tables(data):
    if data.lstrip().startswith(b"%PDF-"):
        from . import pdf_tables
        return pdf_tables.parse_pdf(data)
    if len(data) > MAX_BYTES:
        raise ValueError("HTML input is limited to 10 MB")
    head = data[:4096].decode("ascii", "ignore")
    match = re.search(r"charset=[\"']?([A-Za-z0-9_-]+)", head, re.I)
    encoding = match.group(1) if match else "utf-8"
    try:
        text = data.decode(encoding, "replace")
    except LookupError:
        text = data.decode("utf-8", "replace")
    parser = TableParser()
    parser.feed(text)
    parser.close()
    tables = parser.finish()
    for table in tables:
        table["rows"] = [[_clean(cell) for cell in row] for row in table["rows"]]
    return tables


def _summary(table, index):
    header = media._header_row(table["rows"][:50]) if table["rows"] else 0
    return {"index": index, "caption": table["caption"], "rows": len(table["rows"]),
            "columns": max([len(row) for row in table["rows"]] or [0]), "header_row": header + 1,
            "preview": [{"source_row": n, "values": row[:12]} for n, row in
                        list(zip(table["source_rows"], table["rows"]))[:3]], "truncated": table["truncated"],
            "page": table.get("page"), "parser": table.get("parser", "html")}


def _columns(table, header, selected):
    if not selected:
        return list(range(len(header)))
    out = []
    for value in selected:
        value = str(value).strip()
        if value.isdigit():
            index = int(value)
            if index >= len(header):
                raise ValueError("column index {} is outside this table".format(index))
        else:
            matches = [i for i, name in enumerate(header) if name == value]
            if len(matches) != 1:
                raise ValueError("choose an unambiguous column name from the extraction preview or use its zero-based index")
            index = matches[0]
        if index in out:
            raise ValueError("a selected column appears more than once")
        out.append(index)
    return out


def extract(data, source_url="", table=-1, columns=(), name="Web table", offset=0, limit=30):
    parsed = urlparse(source_url)
    if source_url and (parsed.scheme not in ("http", "https") or not parsed.hostname):
        raise ValueError("source_url must be a public HTTP(S) URL used only as provenance")
    tables = parse_tables(data)
    if not tables:
        raise ValueError("no HTML tables were found in the page")
    if table < 0:
        return {"source_url": source_url, "table_count": len(tables), "table_offset": offset,
                "tables": [_summary(tables[i], i) for i in range(offset, min(len(tables), offset + limit))],
                "has_more": offset + limit < len(tables),
                "next": "Select a table index and columns, or request the next offset. Source values stay in VectorFall."}
    if table >= len(tables):
        raise ValueError("table index {} is not present; choose 0 through {}".format(table, len(tables) - 1))
    chosen = tables[table]
    base = {"source_url": source_url, "table_count": len(tables), "selected_summary": _summary(chosen, table)}
    if len(chosen["rows"]) < 2:
        raise ValueError("the selected table needs a header and at least one data row")
    header_index = media._header_row(chosen["rows"][:50])
    header = chosen["rows"][header_index]
    selected = _columns(chosen, header, columns)
    body, row_numbers = [], []
    dropped_empty = dropped_headers = 0
    for n, row in zip(chosen["source_rows"][header_index + 1:], chosen["rows"][header_index + 1:]):
        if not any(cell.strip() for cell in row):
            dropped_empty += 1
            continue
        if row == header:
            dropped_headers += 1
            continue
        body.append([row[i] for i in selected])
        row_numbers.append(n)
    if not body:
        raise ValueError("the selected table has no usable rows beneath its header")
    header = [header[i] or "Column {}".format(i + 1) for i in selected]
    title = (name or "Web table").strip()[:160]
    if chosen["caption"] and chosen["caption"].lower() not in title.lower():
        title = (title + " - " + chosen["caption"])[:160]
    meta = sources.table_from_rows(title, header, body)
    cleaning = list(meta.get("notes") or [])
    if dropped_empty:
        cleaning.append("{} blank rows dropped".format(dropped_empty))
    if dropped_headers:
        cleaning.append("{} repeated header rows dropped".format(dropped_headers))
    if chosen["truncated"]:
        cleaning.append("Extraction stopped at {} source rows".format(MAX_ROWS))
    if chosen.get("source_rows_omitted"):
        cleaning.append("{} irregular rows left unextracted".format(chosen["source_rows_omitted"]))
    provenance = {"source_url": source_url, "table_index": table, "caption": chosen["caption"],
                  "page": chosen.get("page"), "parser": chosen.get("parser", "html"),
                  "header_source_row": chosen["source_rows"][header_index], "source_rows": row_numbers,
                  "selected_source_columns": selected, "cleaning": cleaning}
    meta["provenance"] = provenance
    with open(os.path.join(media.ROOT, "tables", meta["id"], "meta.json"), "w") as handle:
        json.dump(meta, handle)
    date_columns = sources.date_columns(meta["id"])
    numeric = [column for column in meta["numeric"] if column not in date_columns] or meta["numeric"]
    return {**base, "table": meta, "selected_table": table, "columns": meta["columns"],
            "preview": [{"source_row": n, "values": row} for n, row in list(zip(row_numbers, body))[:12]],
            "cleaning": cleaning,
            "series_input": {"series_table": meta["id"], "series_col": (numeric or [None])[0], "date_col": "auto",
                             "time_col": date_columns[0] if date_columns else None}}


_CACHE = OrderedDict()
_CACHE_LOCK = threading.Lock()


def cached_extract(data, source_url="", table=-1, columns=(), name="Web table", offset=0, limit=30):
    key = hashlib.sha256(data).hexdigest() + "\0" + json.dumps([source_url, table, list(columns), name, offset, limit], sort_keys=True)
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
        if hit is not None:
            _CACHE.move_to_end(key)
            return {**copy.deepcopy(hit), "cached": True}
    result = extract(data, source_url, table, columns, name, offset, limit)
    with _CACHE_LOCK:
        _CACHE[key] = copy.deepcopy(result)
        _CACHE.move_to_end(key)
        while len(_CACHE) > 32:
            _CACHE.popitem(last=False)
    return {**result, "cached": False}
