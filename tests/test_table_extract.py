import os
import tempfile
import unittest

from app import media, registry as R, sources, table_extract
from app.models import data  # noqa: F401


HTML = b"""<html><body><table><caption>Annual indicators</caption>
<tr><th>Year</th><th>Gross product</th><th>Population</th></tr>
<tr><td>2024</td><td>120[1]</td><td>1,200</td></tr>
<tr><td>2023</td><td>105</td><td>1,150</td></tr>
<tr><td>2022</td><td>100</td><td>1,100</td></tr>
<tr><td></td><td></td><td></td></tr>
<tr><th>Year</th><th>Gross product</th><th>Population</th></tr>
</table></body></html>"""


class ExtractionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_root = media.ROOT
        media.ROOT = self.tmp.name
        os.makedirs(os.path.join(media.ROOT, "tables"))
        table_extract._CACHE.clear()

    def tearDown(self):
        media.ROOT = self.old_root
        self.tmp.cleanup()

    def test_enumerate_extract_and_simulation_input(self):
        found = R.call("data.extract", {"file": HTML, "source_url": "https://example.com/indicators"})["result"]
        self.assertEqual(found["table_count"], 1)
        self.assertEqual(found["tables"][0]["caption"], "Annual indicators")
        self.assertNotIn("table", found)
        result = R.call("data.extract", {"file": HTML, "source_url": "https://example.com/indicators",
                                        "table_index": 0, "columns": ["Year", "Gross product"]})["result"]
        meta = result["table"]
        self.assertNotIn("tables", result)
        self.assertEqual(result["selected_summary"]["index"], 0)
        self.assertEqual(meta["numeric"], ["Year", "Gross product"])
        self.assertEqual(result["preview"][0], {"source_row": 2, "values": ["2024", "120"]})
        self.assertEqual(meta["provenance"]["source_rows"], [2, 3, 4])
        self.assertEqual(meta["provenance"]["header_source_row"], 1)
        self.assertEqual(result["series_input"]["series_table"], meta["id"])
        self.assertEqual(result["series_input"]["series_col"], "Gross product")
        series = sources.series(meta["id"], ["Gross product"], "auto")
        self.assertEqual(series["values"][:, 0].tolist(), [100, 105, 120])
        self.assertEqual(series["labels"], ["2022", "2023", "2024"])
        self.assertEqual(series["date_col"], "Year")
        from app import simulate
        from app.models import sim as sim_models
        fed = sim_models._from_table("column", meta["id"], "Gross product")
        self.assertEqual(simulate.parse_series(fed), [100, 105, 120])
        self.assertEqual(simulate.parse_series("3.929e+06"), [3929000])
        self.assertTrue(any("1 blank rows dropped" in note for note in result["cleaning"]))
        self.assertTrue(any("1 repeated header rows dropped" in note for note in result["cleaning"]))

    def test_column_indices_spans_and_cache(self):
        html = b"<table><tr><th rowspan='2'>Year</th><th colspan='2'>Indicators</th></tr><tr><th>Value</th><th>Count</th></tr><tr><td>2024</td><td>12</td><td>3</td></tr></table>"
        tables = table_extract.parse_tables(html)
        self.assertEqual(tables[0]["rows"][0], ["Year", "Indicators", "Indicators"])
        self.assertEqual(tables[0]["rows"][1], ["Year", "Value", "Count"])
        args = {"file": HTML, "source_url": "https://example.com/indicators", "table_index": 0,
                "columns": ["0", "2"], "name": "Selected indicators"}
        first = R.call("data.extract", args)["result"]
        second = R.call("data.extract", args)["result"]
        self.assertEqual(first["table"]["id"], second["table"]["id"])
        self.assertFalse(first["cached"])
        self.assertTrue(second["cached"])
        self.assertEqual(second["columns"], ["Year", "Population"])

    def test_invalid_selection_and_missing_table_fail(self):
        with self.assertRaises(ValueError):
            table_extract.extract(b"<p>No tables</p>")
        with self.assertRaises(ValueError):
            table_extract.extract(HTML, table=4)
        with self.assertRaises(ValueError):
            table_extract.extract(HTML, table=0, columns=["Unknown"])


    def test_catalog_is_paginated(self):
        first = R.call("data.extract", {"file": HTML + HTML, "table_index": -1, "limit": 1})["result"]
        second = R.call("data.extract", {"file": HTML + HTML, "table_index": -1, "offset": 1, "limit": 1})["result"]
        self.assertEqual(first["table_count"], 2)
        self.assertTrue(first["has_more"])
        self.assertEqual([t["index"] for t in first["tables"]], [0])
        self.assertEqual([t["index"] for t in second["tables"]], [1])
        self.assertFalse(second["has_more"])

    def test_pdf_table_has_page_provenance_and_scanned_pdf_is_not_ocr(self):
        try:
            import pdfminer  # noqa: F401
        except ImportError:
            self.skipTest("pdfminer.six is not installed")
        texts = []
        for y, values in ((60, ("Year", "Gross product", "Population")),
                          (85, ("2028 a", "120", "1,200")), (110, ("2027e", "105", "1,150")), (135, ("2026 [1]", "100", "1,100"))):
            for x, value in zip((60, 200, 340), values):
                texts.append((x, 300 - y, value))
        pdf = _pdf(texts)
        found = table_extract.extract(pdf, "https://example.com/report.pdf")
        self.assertEqual(found["table_count"], 1)
        self.assertEqual(found["tables"][0]["page"], 1)
        self.assertEqual(found["tables"][0]["parser"], "pdf-word-geometry-v1")
        result = table_extract.extract(pdf, "https://example.com/report.pdf", table=0, columns=["Year", "Gross product"])
        self.assertEqual(result["table"]["provenance"]["page"], 1)
        self.assertEqual(result["series_input"]["series_col"], "Gross product")
        self.assertEqual(result["preview"][0]["values"], ["2028 a", "120"])
        series = sources.series(result["table"]["id"], ["Gross product"], "auto")
        self.assertEqual(series["values"][:, 0].tolist(), [100, 105, 120])
        self.assertEqual(series["labels"], ["2026", "2027e", "2028 a"])
        self.assertIsNotNone(sources.parse_date("2026 [1]"))
        self.assertIsNone(sources.parse_date("report 2028"))
        with self.assertRaisesRegex(ValueError, "OCR is not implemented"):
            table_extract.extract(_pdf([]))


def _pdf(texts, width=500, height=300):
    """A minimal one-page PDF: (x, y, text) with y from the bottom, Helvetica 10 pt."""
    def esc(t):
        return t.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    ops = "".join("BT /F1 10 Tf {} {} Td ({}) Tj ET\n".format(x, y, esc(t)) for x, y, t in texts).encode("latin-1")
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            ("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] /Contents 4 0 R "
             "/Resources << /Font << /F1 5 0 R >> >> >>" % (width, height)).encode(),
            b"<< /Length " + str(len(ops)).encode() + b" >>\nstream\n" + ops + b"endstream",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, offs = bytearray(b"%PDF-1.4\n"), []
    for i, o in enumerate(objs, 1):
        offs.append(len(out))
        out += ("%d 0 obj\n" % i).encode() + o + b"\nendobj\n"
    xref = len(out)
    out += ("xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)).encode()
    out += b"".join(("%010d 00000 n \n" % o).encode() for o in offs)
    out += ("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)).encode()
    return bytes(out)


if __name__ == "__main__":
    unittest.main()
