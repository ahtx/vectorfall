"""Data Desk models: tables in (file, ticker, pasted numbers), statistics, PCA + clusters, grouping, anomaly watch."""
import csv
import io

from .. import media, registry as R
from ..registry import Blob, model

TABLE = {"k": "table", "type": "table", "label": "Table", "required": True}


def _cols(cols):
    return [c for c in (cols if isinstance(cols, (list, tuple)) else str(cols or "").split("|")) if c]


@model("data.list", "List tables", "data", "Every Data Desk table: id, name, rows, numeric and text columns.", device="cpu")
def table_list():
    return media.table_list()


@model("data.samples.add", "Add the demo photos and music", "data",
       "Add the bundled photos and CC BY music (see CREDITS.md) that are not in the library now.", device="cpu", mutating=True)
def samples_add():
    from .. import samples
    r = samples.add_demo()
    return {"headline": "{} photos, {} music tracks added".format(r["photos"], r["sounds"]), **r}


@model("data.upload", "Add a table", "data", "A CSV / TSV / Excel file becomes a table every tool can read.", device="cpu", mutating=True,
       fields=[{"k": "file", "type": "file", "label": "CSV, TSV or .xlsx", "required": True},
               {"k": "filename", "type": "str", "label": "Name", "default": "table.csv"}])
def upload(file, filename):
    return media.table_add(filename or "table.csv", file)


@model("data.ticker", "Import a ticker", "data", "Daily closes and volume from Yahoo Finance as a new table (a download — CPU).", device="cpu",
       mutating=True, fields=[{"k": "ticker", "type": "str", "label": "Symbol", "required": True},
                              {"k": "years", "type": "int", "label": "Years", "default": 10, "min": 1, "max": 40}])
def ticker(ticker, years):
    from .. import sources
    try:
        return sources.import_ticker(ticker, years)
    except ValueError:
        raise
    except Exception as e:  # noqa: BLE001  (network)
        raise R.Refused("the download of {} failed: {}".format(ticker, e))


@model("data.paste", "Paste numbers", "data", "Pasted numbers (or a pasted CSV with a header) become a table.", device="cpu", mutating=True,
       fields=[{"k": "text", "type": "text", "label": "Numbers or CSV", "required": True}, {"k": "name", "type": "str", "label": "Name", "default": ""}])
def paste(text, name):
    from .. import sources
    return sources.import_numbers((name or "").strip(), text)


@model("data.extract", "Extract web tables", "data",
       "Enumerate HTML or text-PDF tables and save a selected table with page/source rows and cleaning provenance. The caller supplies bytes; no URL is fetched here. Scanned/image tables require OCR or visual review.",
       device="cpu", mutating=True,
       fields=[{"k": "file", "type": "file", "label": "HTML or text-PDF document", "accept": "text/html,application/pdf", "required": True},
               {"k": "source_url", "type": "str", "label": "Source URL (provenance only)", "default": ""},
               {"k": "table_index", "type": "int", "label": "Table index (-1 = enumerate)", "default": -1, "min": -1, "max": 299},
               {"k": "columns", "type": "strs", "label": "Exact columns or zero-based indices (empty = all)", "default": []},
               {"k": "name", "type": "str", "label": "Table name", "default": "Web table"},
               {"k": "offset", "type": "int", "label": "First catalog table", "default": 0, "min": 0, "max": 299},
               {"k": "limit", "type": "int", "label": "Catalog tables per page", "default": 30, "min": 1, "max": 50}])
def extract(file, source_url, table_index, columns, name, offset, limit):
    from .. import table_extract
    return table_extract.cached_extract(file, source_url, table_index, columns, name, offset, limit)


@model("data.delete", "Delete a table", "data", "", device="cpu", mutating=True, fields=[TABLE])
def delete(table):
    return media.table_delete(table)


@model("data.summary", "Summarise a table", "data", "Every column at once: quantiles, histograms, missing values, the correlation matrix.",
       fields=[TABLE])
def summary(table):
    return media.table_summary(table)


@model("data.pca", "Projection + clusters", "data", "PCA of the numeric columns and k-means clusters, on the card.",
       fields=[TABLE, {"k": "k", "type": "int", "label": "Clusters", "default": 4, "min": 2, "max": 12}])
def pca(table, k):
    return media.table_pca(table, k)


@model("data.rows", "Browse rows", "data", "Sorted and filtered rows (numeric sorts on the card).", device="mixed",
       fields=[TABLE, {"k": "sort", "type": "str", "label": "Sort by column", "default": ""},
               {"k": "desc", "type": "bool", "label": "Descending", "default": True},
               {"k": "col", "type": "str", "label": "Filter column", "default": ""},
               {"k": "op", "type": "choice", "label": "Filter", "choices": ["=", ">", "<", ">=", "<=", "!=", "contains"], "default": "="},
               {"k": "val", "type": "str", "label": "Value", "default": ""},
               {"k": "offset", "type": "int", "label": "Skip", "default": 0, "min": 0},
               {"k": "limit", "type": "int", "label": "Rows", "default": 100, "min": 1, "max": 1000}])
def rows(table, sort, desc, col, op, val, offset, limit):
    where = {"col": col, "op": op, "val": val} if col and val != "" else None
    return media.table_rows(table, sort or None, desc, where, offset, limit)


@model("data.group", "Group by", "data", "Mean, sum or count of a numeric column per value of a text column.",
       fields=[TABLE, {"k": "by", "type": "str", "label": "Group by (text column)", "required": True},
               {"k": "col", "type": "str", "label": "Numeric column (empty = count rows)", "default": ""},
               {"k": "agg", "type": "choice", "label": "Aggregate", "choices": ["mean", "sum", "count"], "default": "mean"}])
def group(table, by, col, agg):
    return media.table_group(table, by, col, agg)


@model("data.dates", "Date columns", "data", "Which columns hold dates (best first).", device="cpu", fields=[TABLE])
def dates(table):
    from .. import sources
    return {"date_columns": sources.date_columns(table)}


@model("data.series", "Columns as series", "data", "Numeric columns as date-sorted, gap-filled lists — what the other tools read.", device="cpu",
       fields=[TABLE, {"k": "cols", "type": "strs", "label": "Columns", "required": True},
               {"k": "date_col", "type": "str", "label": "Date column (auto, a name, or empty for row order)", "default": "auto"}])
def series(table, cols, date_col):
    from .. import sources
    s = sources.series(table, _cols(cols), date_col)
    return {"names": s["names"], "values": s["values"].T.round(8).tolist(), "labels": s["labels"], "date_col": s["date_col"],
            "notes": s["notes"], "table": s["table"]}


@model("data.csv", "Export CSV", "data", "The whole table (up to 100,000 rows) as CSV.", device="cpu", output="text/csv", fields=[TABLE])
def to_csv(table):
    r = media.table_rows(table, None, True, None, 0, 100000)
    b = io.StringIO()
    w = csv.writer(b)
    w.writerow(r["columns"])
    for row in r["rows"]:
        w.writerow(["" if v is None else (int(v) if isinstance(v, float) and v.is_integer() else v) for v in row])
    return Blob(b.getvalue().encode("utf-8"), "text/csv", "{}.csv".format(table))


ANOM = [TABLE, {"k": "cols", "type": "strs", "label": "Columns to watch", "required": True},
        {"k": "date_col", "type": "str", "label": "Date column", "default": "auto"},
        {"k": "label_col", "type": "str", "label": "Known-incident column (optional)", "default": ""},
        {"k": "detector", "type": "choice", "label": "Detector", "choices": ["auto", "rolling", "linear", "pattern"], "default": "auto"},
        {"k": "threshold", "type": "float", "label": "Flag beyond (robust z)", "default": 5, "min": 0.5, "max": 50}]


@model("data.anomalies", "Anomaly watch", "data",
       "Flag the moments that break the pattern. VectorFall scores three detectors on glitches that it puts into a copy, at the same false-alarm rate.",
       timeout=300, fields=ANOM)
def anomalies(table, cols, date_col, label_col, detector, threshold):
    from .. import anomaly
    return anomaly.run(table, _cols(cols), date_col, label_col, detector, threshold)


@model("data.anomalies.save", "Anomalies → table", "data", "Run anomaly watch and save the incidents as a new table.", timeout=300,
       mutating=True, fields=ANOM)
def anomalies_save(table, cols, date_col, label_col, detector, threshold):
    from .. import anomaly
    return anomaly.incidents_table(table, _cols(cols), date_col, label_col, detector, threshold)
