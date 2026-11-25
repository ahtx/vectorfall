"""The simple graph store (app/graph.py): SQLite backend and the backend interface. CPU only."""
import os
import tempfile
import unittest

from app import graph as G


class GraphStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.b = G.SQLiteBackend(os.path.join(self.tmp.name, "g.db"))

    def tearDown(self):
        self.b.db.close()
        self.tmp.cleanup()

    def test_nodes_edges_neighbours(self):
        a = self.b.add_node("Lahore", "city")
        self.assertTrue(a["new"])
        self.assertFalse(self.b.add_node("lahore", "city")["new"])        # same label (any case) and kind
        p = self.b.add_node("Pakistan", "country")
        e = self.b.add_edge(a["id"], p["id"], "is in", source="test")
        self.assertTrue(e["new"])
        self.assertFalse(self.b.add_edge(a["id"], p["id"], "is in")["new"])
        n = self.b.neighbours(a["id"])
        self.assertEqual([x["label"] for x in n["nodes"]], ["Pakistan"])
        self.assertEqual(n["edges"][0]["rel"], "is in")
        self.assertEqual(self.b.list_nodes("lah")["nodes"][0]["degree"], 1)
        self.assertEqual(self.b.list_edges("is in")["edges"][0]["dst_label"], "Pakistan")
        s = self.b.stats()
        self.assertEqual((s["nodes"], s["edges"], s["backend"]), (2, 1, "sqlite"))

    def test_delete_and_errors(self):
        a = self.b.add_node("A")
        c = self.b.add_node("C")
        self.b.add_edge(a["id"], c["id"], "r")
        self.assertTrue(self.b.delete_node(a["id"]))
        self.assertEqual(self.b.stats()["edges"], 0)
        with self.assertRaises(ValueError):
            self.b.add_edge(a["id"], c["id"], "r")                        # a deleted end
        with self.assertRaises(ValueError):
            self.b.add_node("  ")
        self.assertEqual(self.b.list_nodes("100%_")["nodes"], [])         # LIKE wildcards are literal

    def test_backend_is_pluggable(self):
        class Fake(G.GraphBackend):
            def stats(self):
                return {"nodes": 0, "edges": 0, "kinds": {}, "relations": {}, "backend": "fake"}
        old = G._B["b"]
        try:
            G.set_backend(Fake())
            self.assertEqual(G.backend().stats()["backend"], "fake")
        finally:
            G.set_backend(old)


if __name__ == "__main__":
    unittest.main()
