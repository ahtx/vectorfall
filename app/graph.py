"""The graph store: a simple database of nodes and edges (things and the relations between them).

What it does, and no more: store nodes and edges, list and search them, give the neighbours of a node, delete. The
default backend is SQLite in /srv/data/graph/graph.db (one file, no server, safe for the server's threads).

Backend interface (for developers)
----------------------------------
All callers go through the module functions below, which call the active backend. A backend is any object with the
methods of `GraphBackend`. To use another engine, set `VF_GRAPH_BACKEND=package.module:ClassName`; the class is
created once with no arguments. A commercial graph engine (Astrolabe) is expected to plug in here, with richer
queries behind the same small interface. Keep the interface small: the UI, the REST/MCP models (app/models/graph.py)
and the VectorLM only use these methods.

Node:  {"id": int, "label": str, "kind": str, "props": dict, "created": float}
Edge:  {"id": int, "src": int, "dst": int, "rel": str, "props": dict, "source": str, "created": float}
"""
import importlib
import json
import os
import sqlite3
import threading
import time

DATA = os.environ.get("VF_DATA", "/srv/data")


class GraphBackend:
    """The interface. Every method returns plain JSON-able values."""

    def add_node(self, label, kind="", props=None):
        """Create a node, or return the existing node with the same label and kind."""
        raise NotImplementedError

    def get_node(self, nid):
        raise NotImplementedError

    def add_edge(self, src, dst, rel, props=None, source=""):
        """Create an edge between two existing node ids (a duplicate src/rel/dst returns the existing edge)."""
        raise NotImplementedError

    def delete_node(self, nid):
        """Delete a node and its edges. Returns True when something was deleted."""
        raise NotImplementedError

    def delete_edge(self, eid):
        raise NotImplementedError

    def list_nodes(self, q="", kind="", limit=100, offset=0):
        """Nodes whose label contains q (case-insensitive), newest first, with their edge counts."""
        raise NotImplementedError

    def list_edges(self, q="", limit=100, offset=0):
        """Edges whose relation or end labels contain q."""
        raise NotImplementedError

    def neighbours(self, nid, limit=200):
        """The node, its edges (both directions) and the nodes at their other ends."""
        raise NotImplementedError

    def stats(self):
        """{"nodes": n, "edges": m, "kinds": {...}, "relations": {...}, "backend": name}"""
        raise NotImplementedError


class SQLiteBackend(GraphBackend):
    name = "sqlite"

    def __init__(self, path=None):
        self.path = path or os.path.join(DATA, "graph", "graph.db")
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.lock = threading.Lock()
        self.db = sqlite3.connect(self.path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        with self.lock:
            self.db.executescript("""
            CREATE TABLE IF NOT EXISTS nodes (id INTEGER PRIMARY KEY, label TEXT NOT NULL, kind TEXT NOT NULL DEFAULT '',
                props TEXT NOT NULL DEFAULT '{}', created REAL NOT NULL);
            CREATE UNIQUE INDEX IF NOT EXISTS nodes_lk ON nodes(label COLLATE NOCASE, kind);
            CREATE TABLE IF NOT EXISTS edges (id INTEGER PRIMARY KEY, src INTEGER NOT NULL, dst INTEGER NOT NULL,
                rel TEXT NOT NULL, props TEXT NOT NULL DEFAULT '{}', source TEXT NOT NULL DEFAULT '', created REAL NOT NULL);
            CREATE UNIQUE INDEX IF NOT EXISTS edges_srd ON edges(src, rel, dst);
            CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst);
            """)
            self.db.commit()

    @staticmethod
    def _node(r):
        return {"id": r["id"], "label": r["label"], "kind": r["kind"], "props": json.loads(r["props"] or "{}"),
                "created": r["created"]}

    @staticmethod
    def _edge(r):
        return {"id": r["id"], "src": r["src"], "dst": r["dst"], "rel": r["rel"], "props": json.loads(r["props"] or "{}"),
                "source": r["source"], "created": r["created"]}

    def add_node(self, label, kind="", props=None):
        label, kind = (label or "").strip(), (kind or "").strip()
        if not label:
            raise ValueError("a node needs a label")
        with self.lock:
            r = self.db.execute("SELECT * FROM nodes WHERE label = ? COLLATE NOCASE AND kind = ?", (label, kind)).fetchone()
            if r:
                return dict(self._node(r), new=False)
            cur = self.db.execute("INSERT INTO nodes (label, kind, props, created) VALUES (?, ?, ?, ?)",
                                  (label, kind, json.dumps(props or {}), time.time()))
            self.db.commit()
            r = self.db.execute("SELECT * FROM nodes WHERE id = ?", (cur.lastrowid,)).fetchone()
        return dict(self._node(r), new=True)

    def get_node(self, nid):
        with self.lock:
            r = self.db.execute("SELECT * FROM nodes WHERE id = ?", (int(nid),)).fetchone()
        return self._node(r) if r else None

    def add_edge(self, src, dst, rel, props=None, source=""):
        rel = (rel or "").strip()
        if not rel:
            raise ValueError("an edge needs a relation")
        src, dst = int(src), int(dst)
        if not self.get_node(src) or not self.get_node(dst):
            raise ValueError("both ends of an edge must be existing nodes")
        with self.lock:
            r = self.db.execute("SELECT * FROM edges WHERE src = ? AND rel = ? AND dst = ?", (src, rel, dst)).fetchone()
            if r:
                return dict(self._edge(r), new=False)
            cur = self.db.execute("INSERT INTO edges (src, dst, rel, props, source, created) VALUES (?, ?, ?, ?, ?, ?)",
                                  (src, dst, rel, json.dumps(props or {}), source or "", time.time()))
            self.db.commit()
            r = self.db.execute("SELECT * FROM edges WHERE id = ?", (cur.lastrowid,)).fetchone()
        return dict(self._edge(r), new=True)

    def delete_node(self, nid):
        with self.lock:
            self.db.execute("DELETE FROM edges WHERE src = ? OR dst = ?", (int(nid), int(nid)))
            n = self.db.execute("DELETE FROM nodes WHERE id = ?", (int(nid),)).rowcount
            self.db.commit()
        return n > 0

    def delete_edge(self, eid):
        with self.lock:
            n = self.db.execute("DELETE FROM edges WHERE id = ?", (int(eid),)).rowcount
            self.db.commit()
        return n > 0

    def list_nodes(self, q="", kind="", limit=100, offset=0):
        sql = ("SELECT n.*, (SELECT COUNT(*) FROM edges e WHERE e.src = n.id OR e.dst = n.id) AS deg FROM nodes n "
               "WHERE n.label LIKE ? ESCAPE '\\'")
        args = ["%" + (q or "").replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"]
        if kind:
            sql += " AND n.kind = ?"
            args.append(kind)
        sql += " ORDER BY deg DESC, n.id DESC LIMIT ? OFFSET ?"
        args += [max(1, min(int(limit), 1000)), max(0, int(offset))]
        with self.lock:
            rows = self.db.execute(sql, args).fetchall()
            total = self.db.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
        return {"nodes": [dict(self._node(r), degree=r["deg"]) for r in rows], "total": total}

    def list_edges(self, q="", limit=100, offset=0):
        like = "%" + (q or "") + "%"
        with self.lock:
            rows = self.db.execute(
                "SELECT e.*, a.label AS sl, b.label AS dl FROM edges e JOIN nodes a ON a.id = e.src JOIN nodes b ON b.id = e.dst "
                "WHERE e.rel LIKE ? OR a.label LIKE ? OR b.label LIKE ? ORDER BY e.id DESC LIMIT ? OFFSET ?",
                (like, like, like, max(1, min(int(limit), 1000)), max(0, int(offset)))).fetchall()
        return {"edges": [dict(self._edge(r), src_label=r["sl"], dst_label=r["dl"]) for r in rows]}

    def neighbours(self, nid, limit=200):
        node = self.get_node(nid)
        if not node:
            raise ValueError("no node with id {}".format(nid))
        with self.lock:
            rows = self.db.execute("SELECT * FROM edges WHERE src = ? OR dst = ? ORDER BY id LIMIT ?",
                                   (int(nid), int(nid), max(1, min(int(limit), 2000)))).fetchall()
        edges = [self._edge(r) for r in rows]
        ids = sorted(({e["src"] for e in edges} | {e["dst"] for e in edges}) - {node["id"]})
        nodes = [self.get_node(i) for i in ids]
        return {"node": node, "edges": edges, "nodes": [n for n in nodes if n]}

    def stats(self):
        with self.lock:
            n = self.db.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
            m = self.db.execute("SELECT COUNT(*) FROM edges").fetchone()[0]
            kinds = {r[0] or "(none)": r[1] for r in self.db.execute("SELECT kind, COUNT(*) FROM nodes GROUP BY kind ORDER BY 2 DESC LIMIT 20")}
            rels = {r[0]: r[1] for r in self.db.execute("SELECT rel, COUNT(*) FROM edges GROUP BY rel ORDER BY 2 DESC LIMIT 20")}
        return {"nodes": n, "edges": m, "kinds": kinds, "relations": rels, "backend": self.name}


_B = {"b": None}
_BL = threading.Lock()


def backend():
    with _BL:
        if _B["b"] is None:
            spec = os.environ.get("VF_GRAPH_BACKEND", "").strip()
            if spec:
                mod, _, cls = spec.partition(":")
                _B["b"] = getattr(importlib.import_module(mod), cls)()
            else:
                _B["b"] = SQLiteBackend()
        return _B["b"]


def set_backend(b):
    """Replace the backend (tests, or an engine that is set up in code)."""
    with _BL:
        _B["b"] = b
