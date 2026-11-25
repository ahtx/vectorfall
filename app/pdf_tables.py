"""Conservative text-PDF table extraction from word geometry; no OCR."""
import re
from collections import Counter


MAX_BYTES = 10_000_000
MAX_PAGES = 200
MAX_ROWS = 5000
MAX_TABLES = 300
REFERENCE = re.compile(r"\[\d+(?:\s*[-–,]\s*\d+)*\]")
NUMBER = re.compile(r"^[\s(+\-–—]*[$€£¥]?\s*\d[\d,]*(?:\.\d+)?\s*%?\)?(?:\s*(?:million|billion|trillion|thousand))?$", re.I)


def _clean(value):
    return re.sub(r"\s+", " ", REFERENCE.sub("", value or "")).strip()


def _lines(page):
    words = [w for w in page.words() if _clean(w[4])]
    words.sort(key=lambda w: (w[1], w[0]))
    grouped = []
    for word in words:
        if not grouped or abs(word[1] - grouped[-1][0][1]) > max(2.0, word[3] - word[1]) * 0.55:
            grouped.append([word])
        else:
            grouped[-1].append(word)
    rows = []
    for number, group in enumerate(grouped, 1):
        group.sort(key=lambda w: w[0])
        height = sorted(w[3] - w[1] for w in group)[len(group) // 2]
        gap_limit = max(9.0, height * 1.2)
        cells = []
        for word in group:
            text = _clean(word[4])
            if cells and word[0] - cells[-1][2] <= gap_limit:
                cells[-1][0].append(text)
                cells[-1][2] = word[2]
            else:
                cells.append([[text], word[0], word[2]])
        if cells:
            rows.append({"source_row": number, "values": [" ".join(c[0]) for c in cells],
                         "x": [c[1] for c in cells]})
    return rows


def _table(run, page):
    count = Counter(len(row["values"]) for row in run).most_common(1)[0][0]
    aligned = [row for row in run if len(row["values"]) == count]
    if len(aligned) < 3:
        return None
    for column in range(count):
        positions = sorted(row["x"][column] for row in aligned)
        middle = positions[len(positions) // 2]
        tolerance = max(7.0, min(22.0, middle * 0.025))
        if sum(abs(row["x"][column] - middle) <= tolerance for row in aligned) < len(aligned) * 0.8:
            return None
    numeric_rows = sum(any(NUMBER.match(value) for value in row["values"][1:]) for row in aligned)
    if numeric_rows < max(1, len(aligned) // 2):
        return None
    return {"caption": "Page {}, aligned text table".format(page), "page": page,
            "rows": [row["values"] for row in aligned],
            "source_rows": [row["source_row"] for row in aligned],
            "source_rows_omitted": len(run) - len(aligned),
            "parser": "pdf-word-geometry-v1", "truncated": False}


def _page_tables(page, page_number, remaining):
    lines = _lines(page)
    runs = []
    for row in lines:
        if len(row["values"]) < 2:
            if runs and runs[-1]:
                runs.append([])
        elif not runs:
            runs.append([row])
        else:
            runs[-1].append(row)
    out = []
    for run in runs:
        if len(run) < 3:
            continue
        table = _table(run, page_number)
        if not table:
            continue
        if len(table["rows"]) > remaining:
            table["rows"] = table["rows"][:remaining]
            table["source_rows"] = table["source_rows"][:remaining]
            table["truncated"] = True
        out.append(table)
        remaining -= len(table["rows"])
        if remaining <= 0 or len(out) >= MAX_TABLES:
            break
    return out, remaining


def parse_pdf(data):
    if len(data) > MAX_BYTES:
        raise ValueError("PDF input is limited to 10 MB")
    try:
        from . import pdftext
    except ImportError as ex:
        raise ValueError("PDF table extraction requires the pdfminer.six parser") from ex
    try:
        tables = []
        has_text = False
        remaining = MAX_ROWS
        for index, page in enumerate(pdftext.pages(data, MAX_PAGES)):
            page_number = index + 1
            has_text = has_text or bool(page.text().strip())
            found, remaining = _page_tables(page, page_number, remaining)
            tables.extend(found)
            if remaining <= 0 or len(tables) >= MAX_TABLES:
                break
    except ValueError:
        raise
    except Exception as ex:
        raise ValueError("the PDF could not be parsed: " + str(ex)[:200]) from ex
    if not tables:
        if not has_text:
            raise ValueError("this appears to be a scanned or image-only PDF; OCR is not implemented")
        raise ValueError("no confidently aligned text tables were found; scanned/figure tables require OCR or visual review")
    return tables
