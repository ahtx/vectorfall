"""VectorLM and the graph store as Vectorfall models.

VectorLM (app/vectorlm.py) is a prototype: BM25 passage retrieval over the corpus on the card, sentence selection and
answer extraction, and an optional continuation from the corpus LM (app/lm.py). It is not a complete LLM; every
model description and every answer carries vectorlm.WARNING.

The graph store (app/graph.py) keeps nodes and edges; these models are its whole public surface.

Models: text.vectorlm.ask · text.vlm100 (old name, same answer) · graph.stats · graph.nodes · graph.edges ·
        graph.neighbours · graph.node.add · graph.edge.add · graph.delete
"""
from .. import graph as G
from .. import vectorlm as V
from ..registry import model
from .text import _c, CORPUS

_W = " " + V.WARNING


def answer(prompt, corpus=None, top=8, generate=False, words=40, **_ignored):
    """The VectorLM answer path, shared by the models and the OpenAI-compatible endpoint."""
    return V.ask(_c(corpus), prompt, top=top, generate=generate, gen_words=words)


_ASK_FIELDS = [{"k": "prompt", "type": "text", "label": "Question", "required": True,
                "help": "A simple question about the documents in the corpus on the card."},
               CORPUS,
               {"k": "top", "type": "int", "label": "Passages to read", "default": 8, "min": 1, "max": 20},
               {"k": "generate", "type": "bool", "label": "Also continue with the corpus LM", "default": False,
                "help": "Adds text written by the corpus LM after the answer sentence. That text is not checked."},
               {"k": "words", "type": "int", "label": "Words to continue", "default": 40, "min": 5, "max": 200}]


@model("text.vectorlm.ask", "VectorLM: ask the corpus (prototype)", "language",
       "Answers a simple question from the corpus on the card: BM25 passage retrieval, then the best sentence and a "
       "short answer span taken from it, with the source passage." + _W,
       fields=_ASK_FIELDS, device="mixed", example={"prompt": "Who wrote about the fear of AI?"})
def vectorlm_ask(prompt, corpus=None, top=8, generate=False, words=40):
    return answer(prompt, corpus, top, generate, words)


@model("text.vlm100", "VectorLM (old name)", "language",
       "The old name of text.vectorlm.ask, kept for older clients. The 100M model that this name used is not part "
       "of this release." + _W,
       fields=_ASK_FIELDS, device="mixed", example={"prompt": "Who is Elizabeth Bennet?"})
def vlm100(prompt, corpus=None, top=8, generate=False, words=40, **_old):
    return answer(prompt, corpus, top, generate, words)


# ---------------------------------------------------------------- graph store
@model("graph.stats", "Graph: counts", "language", "How many nodes and edges the graph store holds, by kind and relation.",
       device="cpu", example={})
def graph_stats():
    return G.backend().stats()


@model("graph.nodes", "Graph: find nodes", "language", "Nodes whose label contains the text (all nodes when empty).",
       device="cpu",
       fields=[{"k": "q", "type": "str", "label": "Label contains", "default": ""},
               {"k": "kind", "type": "str", "label": "Kind", "default": ""},
               {"k": "limit", "type": "int", "label": "Limit", "default": 100, "min": 1, "max": 1000},
               {"k": "offset", "type": "int", "label": "Offset", "default": 0, "min": 0}],
       example={"q": ""})
def graph_nodes(q="", kind="", limit=100, offset=0):
    return G.backend().list_nodes(q, kind, limit, offset)


@model("graph.edges", "Graph: find edges", "language", "Edges whose relation or end labels contain the text.",
       device="cpu",
       fields=[{"k": "q", "type": "str", "label": "Contains", "default": ""},
               {"k": "limit", "type": "int", "label": "Limit", "default": 100, "min": 1, "max": 1000},
               {"k": "offset", "type": "int", "label": "Offset", "default": 0, "min": 0}],
       example={"q": ""})
def graph_edges(q="", limit=100, offset=0):
    return G.backend().list_edges(q, limit, offset)


@model("graph.neighbours", "Graph: neighbours", "language", "A node, its edges in both directions and the nodes at their other ends.",
       device="cpu", fields=[{"k": "id", "type": "int", "label": "Node id", "required": True}])
def graph_neighbours(id):  # noqa: A002
    return G.backend().neighbours(id)


@model("graph.node.add", "Graph: add a node", "language", "Adds a node (or returns the node with the same label and kind).",
       device="cpu", mutating=True,
       fields=[{"k": "label", "type": "str", "label": "Label", "required": True},
               {"k": "kind", "type": "str", "label": "Kind", "default": ""},
               {"k": "props", "type": "json", "label": "Properties (JSON object)", "default": {}}])
def graph_node_add(label, kind="", props=None):
    return G.backend().add_node(label, kind, _obj(props))


@model("graph.edge.add", "Graph: add an edge", "language",
       "Adds an edge between two nodes. Give node ids, or labels (a label that is not found becomes a new node).",
       device="cpu", mutating=True,
       fields=[{"k": "src", "type": "str", "label": "From (id or label)", "required": True},
               {"k": "rel", "type": "str", "label": "Relation", "required": True},
               {"k": "dst", "type": "str", "label": "To (id or label)", "required": True},
               {"k": "source", "type": "str", "label": "Source (where the fact comes from)", "default": ""},
               {"k": "props", "type": "json", "label": "Properties (JSON object)", "default": {}}])
def graph_edge_add(src, rel, dst, source="", props=None):
    b = G.backend()
    return b.add_edge(_nid(b, src), _nid(b, dst), rel, _obj(props), source)


@model("graph.delete", "Graph: delete", "language", "Deletes a node (with its edges) or one edge.", device="cpu",
       mutating=True,
       fields=[{"k": "what", "type": "choice", "choices": ["node", "edge"], "label": "What", "default": "node"},
               {"k": "id", "type": "int", "label": "Id", "required": True}])
def graph_delete(what, id):  # noqa: A002
    b = G.backend()
    ok = b.delete_node(id) if what == "node" else b.delete_edge(id)
    return {"deleted": bool(ok), "what": what, "id": id}


def _obj(v):
    if v in (None, ""):
        return {}
    if isinstance(v, str):
        import json
        v = json.loads(v)
    if not isinstance(v, dict):
        raise ValueError("properties must be a JSON object")
    return v


def _nid(b, ref):
    s = str(ref).strip()
    if s.isdigit() and b.get_node(int(s)):
        return int(s)
    return b.add_node(s)["id"]
