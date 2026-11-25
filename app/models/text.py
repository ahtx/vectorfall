"""Text Engine models. All analysis runs over the corpus that is on the card; `corpus` (optional, an id or part of a
name) switches the card to another corpus first — for everyone, the UI included — so leave it out to use the loaded one."""
import io
import json
import os
import tempfile
import time

from .. import registry as R, textengine as te
from ..registry import model

CORPUS = {"k": "corpus", "type": "corpus", "label": "Corpus (default: the one on the card)",
          "help": "When you load a different corpus, the card changes to it for all users."}
RECIPES = "/srv/data/recipes.json"
TMP = "/srv/data/uploads"


def _c(corpus=None):
    a = te.ACTIVE["c"]
    if corpus and not (a and a.ready and a.id == corpus):
        te.activate(corpus)
        a = te.ACTIVE["c"]
    if not a or not a.ready:
        raise R.Refused("no text loaded yet — load a corpus (text.corpus.* models) first", 409)
    return a


def _f(*fields):
    return [CORPUS] + list(fields)


# ---------------------------------------------------------------- the corpus library
@model("text.corpus.list", "List corpora", "text", "Every stored corpus: id, name, size, whether it is on the card.", device="cpu")
def corpus_list():
    return te.list_corpora()


@model("text.corpus.active", "The corpus on the card", "text", "Name, size, versions and residency of the loaded corpus.", device="cpu")
def corpus_active():
    a = te.ACTIVE["c"]
    if not a or not a.ready:
        b = te.ACTIVE.get("blank")
        if b:
            try:
                return {"loaded": False, "blank": {"id": b, "name": te.Corpus(b).meta.get("name")}}
            except Exception:  # noqa: BLE001
                pass
        return {"loaded": False}
    st = a.stats()
    return {"loaded": True, "id": a.id, "name": a.meta.get("name"), "version": a.version, "docs": a.meta.get("docs") or [],
            "recipe": a.meta.get("recipe") or [], "versions": a.meta.get("versions") or [], "index": a.meta.get("index"),
            "residency": a.residency(), "bytes": int(a.raw.size), "tokens": a.T, "vocab": a.V,
            "on_card_mb": round((a.T * 2 + a.esc_pos.size * 12) / 2**20, 1), "compression": st["compression"],
            "words": st["words"], "unique_words": st["unique_words"]}


def _create(job, name, parts_fn, cleanup=None):
    try:
        job.step(0.01, "reading")
        parts = parts_fn(job)
        cid = te.create(name, parts, job)
        job.step(0.06, "make the index on the card")
        te.activate(cid, job)
        return {"id": cid}
    finally:
        if cleanup:
            cleanup()


@model("text.corpus.paste", "Load pasted text", "text", "Make a corpus from text and index it on the card.", long=True, mutating=True,
       fields=[{"k": "text", "type": "text", "label": "Text", "required": True}, {"k": "name", "type": "str", "label": "Name", "default": "Pasted text"}],
       example={"text": "the quick brown fox jumps over the lazy dog. the dog sleeps.", "name": "Pasted text"})
def corpus_paste(job, text, name):
    data = (text or "").encode("utf-8")
    if not data.strip():
        raise R.Refused("nothing pasted")
    return _create(job, name or "Pasted text", lambda j: [("pasted", lambda: io.BytesIO(data))])


@model("text.corpus.url", "Load a web page or file", "text", "Fetch a URL (HTML, PDF, plain text…) and index it on the card.", long=True, mutating=True,
       device="mixed", fields=[{"k": "url", "type": "str", "label": "URL", "required": True}, {"k": "name", "type": "str", "label": "Name"}])
def corpus_url(job, url, name):
    if not str(url).startswith(("http://", "https://")):
        raise R.Refused("give an http(s) URL")

    def parts(j):
        import urllib.request
        req = urllib.request.Request(url, headers={"User-Agent": "vectorfall/1.0"})
        with urllib.request.urlopen(req, timeout=120) as r:
            data = r.read()
            ctype = r.headers.get("content-type", "")
        nm = url.rstrip("/").split("/")[-1] or url
        if "html" in ctype and not nm.endswith((".html", ".htm")):
            nm += ".html"
        return te.sources(nm, data=data)
    return _create(job, name or url.split("//")[-1][:60], parts)


@model("text.corpus.file", "Load a document", "text", "Index a file (text, .gz/.zip, HTML, PDF, DOCX, PPTX, XLSX, EPUB…) on the card.",
       long=True, mutating=True, device="mixed",
       fields=[{"k": "file", "type": "file", "label": "File", "required": True},
               {"k": "filename", "type": "str", "label": "File name (it sets how VectorFall reads the file)", "default": "upload.txt"},
               {"k": "name", "type": "str", "label": "Name"}])
def corpus_file(job, file, filename, name):
    d = tempfile.mkdtemp(dir=TMP)
    path = os.path.join(d, os.path.basename(filename or "upload.txt"))
    with open(path, "wb") as f:
        f.write(file)
    import shutil
    return _create(job, name or filename, lambda j: te.sources(filename, path=path), lambda: shutil.rmtree(d, ignore_errors=True))


def _gutenberg_parts(b):
    def parts(j):
        out = []
        for i, gid in enumerate(b["ids"]):
            j.step(0.02 + 0.03 * i / len(b["ids"]), "download book {} of {}".format(i + 1, len(b["ids"])))
            try:
                title, data = te.fetch_gutenberg(gid)
                out.append((title, (lambda d=data: io.BytesIO(d))))
            except Exception:  # noqa: BLE001
                continue
        if not out:
            raise RuntimeError("VectorFall cannot connect to Project Gutenberg")
        return out
    return parts


@model("text.corpus.gutenberg", "Load books from Project Gutenberg", "text", "Download a bundle of public-domain books and index them.",
       long=True, mutating=True, device="mixed",
       fields=[{"k": "bundle", "type": "choice", "label": "Bundle", "choices": list(te.BUNDLES), "default": list(te.BUNDLES)[0]}])
def corpus_gutenberg(job, bundle):
    b = te.BUNDLES[bundle]
    return _create(job, b["name"], _gutenberg_parts(b))


@model("text.corpus.activate", "Put a corpus on the card", "text", "Load a stored corpus onto the card (and make its index again, if necessary).",
       long=True, mutating=True, fields=[{"k": "corpus", "type": "corpus", "label": "Corpus", "required": True}])
def corpus_activate(job, corpus):
    te.activate(corpus, job)
    return {"id": corpus}


@model("text.corpus.blank", "Start a blank corpus", "text", "Create an empty, named corpus and select it; text added afterwards goes into it.",
       device="cpu", mutating=True, fields=[{"k": "name", "type": "str", "label": "Name", "default": "Untitled corpus"}],
       example={"name": "My notes"})
def corpus_blank(name):
    cid = te.create_blank(name or "Untitled corpus")
    return {"id": cid, "name": name or "Untitled corpus", "blank": True}


@model("text.corpus.add", "Add text to a corpus", "text",
       "Append pasted text, a web page or a file to a stored corpus (default: the selected one). Into a blank corpus it becomes "
       "the text; otherwise it is a new version you can undo.", long=True, mutating=True, device="mixed",
       fields=[{"k": "corpus", "type": "corpus", "label": "Corpus (default: the selected one)"},
               {"k": "text", "type": "text", "label": "Text"},
               {"k": "url", "type": "str", "label": "...or a URL"},
               {"k": "file", "type": "file", "label": "...or a file"},
               {"k": "filename", "type": "str", "label": "File name (it sets how VectorFall reads the file)", "default": "upload.txt"},
               {"k": "name", "type": "str", "label": "Document name", "default": ""}])
def corpus_add(job, corpus=None, text=None, url=None, file=None, filename="upload.txt", name=""):
    cid = corpus or (te.ACTIVE["c"].id if te.ACTIVE["c"] else te.ACTIVE.get("blank"))
    if not cid:
        raise R.Refused("no corpus selected: pick one or start a blank corpus", 409)
    job.step(0.01, "reading")
    if text and str(text).strip():
        data = str(text).encode("utf-8")
        parts = [(name or "pasted", lambda: io.BytesIO(data))]
    elif url:
        if not str(url).startswith(("http://", "https://")):
            raise R.Refused("give an http(s) URL")
        import urllib.request
        req = urllib.request.Request(url, headers={"User-Agent": "vectorfall/1.0"})
        with urllib.request.urlopen(req, timeout=120) as r:
            data, ctype = r.read(), r.headers.get("content-type", "")
        nm = url.rstrip("/").split("/")[-1] or url
        if "html" in ctype and not nm.endswith((".html", ".htm")):
            nm += ".html"
        parts = te.sources(nm, data=data)
    elif file:
        parts = te.sources(filename or "upload.txt", data=file)
    else:
        raise R.Refused("nothing to add: give text, a URL or a file")
    job.step(0.06, "add the files and make the index again on the card")
    return te.add_parts(cid, parts, job)


@model("text.corpus.delete", "Delete a corpus", "text", "Remove a stored corpus (and release it from the card).", device="cpu", mutating=True,
       fields=[{"k": "corpus", "type": "corpus", "label": "Corpus", "required": True}])
def corpus_delete(corpus):
    te.delete(corpus)
    return {"deleted": corpus}


# ---------------------------------------------------------------- search & lookup
@model("text.search", "Search", "text", "Every occurrence of a word or phrase, found by a scan of the whole corpus on the card.", device="mixed",
       fields=_f({"k": "q", "type": "str", "label": "Words", "required": True},
                 {"k": "case", "type": "bool", "label": "Match case", "default": False},
                 {"k": "limit", "type": "int", "label": "Hits to return", "default": 60, "min": 1, "max": 500},
                 {"k": "offset", "type": "int", "label": "Skip", "default": 0, "min": 0}),
       example={"q": "the"})
def search(q, case, limit, offset, corpus=None):
    return _c(corpus).search(q, case, limit, offset)


@model("text.near", "What comes next / before", "text", "The words that follow (or precede) a word or phrase, counted on the card.", device="mixed",
       fields=_f({"k": "q", "type": "str", "label": "Words", "required": True},
                 {"k": "side", "type": "choice", "label": "Side", "choices": ["next", "prev"], "default": "next"},
                 {"k": "case", "type": "bool", "label": "Match case", "default": False},
                 {"k": "top", "type": "int", "label": "Words to list", "default": 24, "min": 1, "max": 200},
                 {"k": "show_off", "type": "bool", "label": "Include words the vocabulary filter hides", "default": False}),
       example={"q": "the"})
def near(q, side, case, top, show_off, corpus=None):
    return _c(corpus).neighbours(q, side, top, case, show_off)


@model("text.source", "Context of a position", "text", "The text around one token position, and its document.", device="cpu",
       fields=_f({"k": "pos", "type": "int", "label": "Token position", "required": True, "min": 0}), example={"pos": 0})
def source(pos, corpus=None):
    return _c(corpus).source(pos)


@model("text.read", "Read a document at a place", "text", "The document around a byte offset, cut at paragraph breaks, with the found stretch marked.",
       device="cpu", fields=_f({"k": "at", "type": "int", "label": "Byte offset", "required": True, "min": 0},
                               {"k": "hl", "type": "int", "label": "Bytes to mark", "default": 0, "min": 0},
                               {"k": "before", "type": "int", "label": "Bytes before", "default": 2500, "min": 0, "max": 40000},
                               {"k": "after", "type": "int", "label": "Bytes after", "default": 4000, "min": 0, "max": 40000}), example={"at": 0})
def read(at, hl, before, after, corpus=None):
    return _c(corpus).read(at, hl, before, after)


@model("text.retrieve", "Find passages (BM25)", "text", "The passages that best match a question, ranked by BM25 over GPU term scans.", device="mixed",
       fields=_f({"k": "q", "type": "str", "label": "Question or keywords", "required": True},
                 {"k": "top", "type": "int", "label": "Passages", "default": 8, "min": 1, "max": 30}), example={"q": "the"})
def retrieve(q, top, corpus=None):
    return _c(corpus).retrieve(q, top)


@model("text.trace", "Trace a text to its sources", "text",
       "Which stretches of a text appear word for word in the corpus, and in which documents — against the same words shuffled.",
       device="mixed",
       fields=_f({"k": "text", "type": "text", "label": "Text to trace", "required": True},
                 {"k": "min_words", "type": "int", "label": "Count a match from (words)", "default": 6, "min": 1, "max": 50},
                 {"k": "case", "type": "bool", "label": "Match case", "default": False}),
       example={"text": "it was the best of times, it was the worst of times"})
def trace(text, min_words, case, corpus=None):
    from .. import infgram
    return infgram.attribute(_c(corpus), str(text or ""), min_words, case)


@model("text.continue", "Continue a text (∞-gram)", "text",
       "The next word comes from the place in the corpus where the longest end of the text occurs. Each word keeps its source.",
       device="mixed",
       fields=_f({"k": "prompt", "type": "str", "label": "Start", "default": ""},
                 {"k": "n", "type": "int", "label": "Words", "default": 60, "min": 5, "max": 400},
                 {"k": "temp", "type": "float", "label": "Wildness", "default": 1.0, "min": 0.05, "max": 5},
                 {"k": "max_ctx", "type": "int", "label": "Longest context", "default": 40, "min": 1, "max": 200}),
       example={"prompt": "it was the", "n": 30})
def cont(prompt, n, temp, max_ctx, corpus=None):
    from .. import infgram
    return infgram.continue_text(_c(corpus), str(prompt or ""), n, temp, max_ctx)


# ---------------------------------------------------------------- statistics, vocabulary, filter
@model("text.stats", "Statistics", "text", "Size, readability, Zipf curve, top words, punctuation, compression.", device="cpu", fields=_f())
def stats(corpus=None):
    return _c(corpus).stats()


@model("text.vocab", "Vocabulary by prefix", "text", "The most frequent words that start with a prefix.", device="cpu",
       fields=_f({"k": "prefix", "type": "str", "label": "Prefix", "default": ""},
                 {"k": "top", "type": "int", "label": "Words", "default": 200, "min": 1, "max": 2000}))
def vocab(prefix, top, corpus=None):
    return _c(corpus).vocab(prefix, top)


@model("text.vocab.analysis", "Vocabulary explorer", "text", "Filter and sort the vocabulary by count, stopwords, contents.", device="cpu",
       fields=_f({"k": "contains", "type": "str", "label": "Contains", "default": ""},
                 {"k": "min_count", "type": "int", "label": "At least", "default": 0, "min": 0},
                 {"k": "max_count", "type": "int", "label": "At most (0 = no limit)", "default": 0, "min": 0},
                 {"k": "drop_stop", "type": "bool", "label": "Drop filler words", "default": False},
                 {"k": "words_only", "type": "bool", "label": "Words only", "default": True},
                 {"k": "sort", "type": "choice", "label": "Sort", "choices": ["freq", "rare", "vocab"], "default": "freq"},
                 {"k": "top", "type": "int", "label": "Rows", "default": 400, "min": 1, "max": 2000},
                 {"k": "show_off", "type": "bool", "label": "Include filtered-out words", "default": False}))
def vocab_analysis(contains, min_count, max_count, drop_stop, words_only, sort, top, show_off, corpus=None):
    return _c(corpus).vocab_analysis(contains, min_count, max_count, drop_stop, words_only, sort, top, show_off)


@model("text.filter.get", "Vocabulary filter", "text", "The corpus's vocabulary filter (crossed-out words, stopwords, counts).", device="cpu", fields=_f())
def filter_get(corpus=None):
    return _c(corpus).filter_info()


@model("text.filter.set", "Change the vocabulary filter", "text", "Set any of: crossed-out words, hide filler words, hide web debris, count range.",
       device="cpu", mutating=True,
       fields=_f({"k": "exclude", "type": "strs", "label": "Crossed-out words (replaces the list; empty = none)"},
                 {"k": "stop", "type": "bool", "label": "Hide filler words"},
                 {"k": "junk", "type": "bool", "label": "Hide web & markup debris"},
                 {"k": "min", "type": "int", "label": "At least N mentions", "min": 0},
                 {"k": "max", "type": "int", "label": "At most N mentions (0 = no limit)", "min": 0}))
def filter_set(exclude, stop, junk, min, max, corpus=None):  # noqa: A002
    return _c(corpus).set_filter(exclude=exclude, stop=stop, junk=junk, min=min, max=max)


@model("text.filter.toggle", "Cross out a word (or restore it)", "text", "Hide one word from every view and generator, or bring it back.",
       device="cpu", mutating=True,
       fields=_f({"k": "word", "type": "str", "label": "Word", "required": True},
                 {"k": "off", "type": "bool", "label": "Hide it (default: flip)"}))
def filter_toggle(word, off, corpus=None):
    w = (word or "").strip()
    if not w:
        raise R.Refused("which word?")
    return _c(corpus).toggle_word(w, off)


# ---------------------------------------------------------------- transitions & meaning (GPU)
@model("text.pairs", "Word-pair matrix", "text", "How often each of the top N words follows each other one (a histogram kernel on the card).",
       fields=_f({"k": "n", "type": "int", "label": "Words", "default": 30, "min": 4, "max": 80}))
def pairs(n, corpus=None):
    return _c(corpus).pairs(n)


@model("text.table", "Transition table", "text", "Counts and probabilities of next words for the top N words.",
       fields=_f({"k": "n", "type": "int", "label": "Words", "default": 20, "min": 4, "max": 40}))
def table(n, corpus=None):
    return _c(corpus).transition_table(n)


@model("text.bigrams", "Top bigrams", "text", "The most frequent word pairs among the top 2000 words.",
       fields=_f({"k": "top", "type": "int", "label": "Pairs", "default": 60, "min": 1, "max": 400}))
def bigrams(top, corpus=None):
    return _c(corpus).bigrams(top)


@model("text.similar", "Similar words", "text", "Nearest words by meaning (co-occurrence embeddings built on the card).",
       fields=_f({"k": "word", "type": "str", "label": "Word", "required": True},
                 {"k": "k", "type": "int", "label": "Words", "default": 24, "min": 1, "max": 60}), example={"word": "time"})
def similar(word, k, corpus=None):
    return _c(corpus).similar_words(word, k)


# ---- relations: analogies and word arithmetic in a 5,000-word space that keeps function words
def _w(k, label):
    return {"k": k, "type": "str", "label": label, "required": True}


@model("text.rel.analogy", "Analogy: a is to b as c is to ?", "text",
       "3CosMul (or 3CosAdd) in the relation space; reports the nearest-neighbour-of-c baseline and each answer's offset match.",
       fields=_f(_w("a", "a"), _w("b", "is to b"), _w("c", "as c is to ?"),
                 {"k": "k", "type": "int", "label": "Answers", "default": 15, "min": 1, "max": 50},
                 {"k": "method", "type": "choice", "label": "Method", "choices": ["3cosmul", "3cosadd"], "default": "3cosmul"}),
       example={"a": "do", "b": "don't", "c": "could"})
def rel_analogy(a, b, c, k, method, corpus=None):
    return _c(corpus).rel_analogy(a, b, c, k, method)


@model("text.rel.pairs", "Pairs with the same relation as a : b", "text",
       "Every pair (x, y) whose difference vector points like b - a, scored by cosine, against a random-neighbour-pair control (99th percentile).",
       fields=_f(_w("a", "a"), _w("b", "b"), {"k": "k", "type": "int", "label": "Pairs", "default": 30, "min": 1, "max": 100},
                 {"k": "neighbours", "type": "int", "label": "Search the nearest", "default": 25, "min": 5, "max": 100},
                 {"k": "closeness", "type": "float", "label": "Weight on how similar x and y are", "default": 0.5, "min": 0, "max": 5}),
       example={"a": "do", "b": "don't"})
def rel_pairs(a, b, k, neighbours, closeness, corpus=None):
    return _c(corpus).rel_pairs(a, b, k, neighbours, closeness)


@model("text.rel.arith", "Word arithmetic", "text", "The nearest words to a sum of word vectors, for example king - man + woman.",
       fields=_f({"k": "expr", "type": "str", "label": "Expression", "required": True},
                 {"k": "k", "type": "int", "label": "Answers", "default": 15, "min": 1, "max": 50}), example={"expr": "king - man + woman"})
def rel_arith(expr, k, corpus=None):
    return _c(corpus).rel_arith(expr, k)


@model("text.rel.axis", "Words along a scale a to b", "text", "Project every word on the direction from a to b; list both ends.",
       fields=_f(_w("a", "a"), _w("b", "b"), {"k": "k", "type": "int", "label": "Words per end", "default": 20, "min": 1, "max": 60}),
       example={"a": "poor", "b": "rich"})
def rel_axis(a, b, k, corpus=None):
    return _c(corpus).rel_axis(a, b, k)


@model("text.rel.between", "Words between a and b", "text", "Words similar to both a and b.",
       fields=_f(_w("a", "a"), _w("b", "b"), {"k": "k", "type": "int", "label": "Words", "default": 15, "min": 1, "max": 50}),
       example={"a": "love", "b": "money"})
def rel_between(a, b, k, corpus=None):
    return _c(corpus).rel_between(a, b, k)


@model("text.rel.odd", "Odd one out", "text", "The word least like the others.",
       fields=_f({"k": "words", "type": "str", "label": "Words (3 or more)", "required": True}), example={"words": "father mother sister table"})
def rel_odd(words, corpus=None):
    return _c(corpus).rel_odd(words)


@model("text.rel.test", "How trustworthy is the relation space?", "text",
       "Analogy accuracy on relations found in this corpus (negation, plural, -ing, -ed, -ly) vs the nearest-neighbour baseline.",
       fields=_f({"k": "max_per", "type": "int", "label": "Pairs per relation", "default": 40, "min": 5, "max": 200}))
def rel_test(max_per, corpus=None):
    return _c(corpus).rel_test(max_per)


@model("text.meaning", "Keywords, collocations, clusters", "text", "What the corpus is about: keywords, PMI collocations, word clusters (k-means).",
       fields=_f({"k": "clusters", "type": "int", "label": "Clusters", "default": 10, "min": 2, "max": 20},
                 {"k": "keywords", "type": "int", "label": "Keywords", "default": 40, "min": 1, "max": 80},
                 {"k": "collocations", "type": "int", "label": "Collocations", "default": 30, "min": 1, "max": 60}))
def meaning(clusters, keywords, collocations, corpus=None):
    return _c(corpus).meaning(clusters, keywords, collocations)


@model("text.topics", "Topics and their order", "text", "Topic clusters of the vocabulary and how the text moves between them.",
       fields=_f({"k": "topics", "type": "int", "label": "Topics", "default": 16, "min": 2, "max": 40}))
def topics(topics, corpus=None):
    return _c(corpus).topics_info(topics)


@model("text.embedmap", "Word map (t-SNE)", "text", "A 2-D map of the top words by meaning: embeddings + exact t-SNE on the card.",
       fields=_f({"k": "n", "type": "int", "label": "Words", "default": 500, "min": 50, "max": 1200},
                 {"k": "topics", "type": "int", "label": "Topic colours", "default": 12, "min": 2, "max": 30}))
def embedmap(n, topics, corpus=None):
    return _c(corpus).embed_map(n, topics)


# ---------------------------------------------------------------- generation
@model("text.generate", "Markov text (simple)", "text", "Markov-chain text from GPU phrase scans.", device="mixed",
       fields=_f({"k": "seed", "type": "str", "label": "Start", "default": ""},
                 {"k": "order", "type": "int", "label": "Order", "default": 2, "min": 1, "max": 6},
                 {"k": "n", "type": "int", "label": "Words", "default": 80, "min": 1, "max": 600},
                 {"k": "temp", "type": "float", "label": "Wildness", "default": 1.0, "min": 0.05, "max": 5}))
def generate(seed, order, n, temp, corpus=None):
    return _c(corpus).generate(seed, order, n, temp)


@model("text.generate2", "Generate text", "text", "Markov or topic-guided Markov generation, with theme, stop rule and filler control.", device="mixed",
       fields=_f({"k": "seed", "type": "str", "label": "Start", "default": ""},
                 {"k": "order", "type": "int", "label": "Order", "default": 3, "min": 1, "max": 6},
                 {"k": "length", "type": "int", "label": "Words", "default": 90, "min": 5, "max": 600},
                 {"k": "temp", "type": "float", "label": "Wildness", "default": 1.0, "min": 0.05, "max": 5},
                 {"k": "stop_at", "type": "choice", "label": "Stop at", "choices": ["none", "sentence", "paragraph"], "default": "none"},
                 {"k": "avoid_stop", "type": "bool", "label": "Avoid filler words", "default": False},
                 {"k": "theme", "type": "str", "label": "Theme word", "default": ""},
                 {"k": "mode", "type": "choice", "label": "Mode", "choices": ["markov", "topics"], "default": "markov"},
                 {"k": "topics", "type": "int", "label": "Topics (topic mode)", "default": 16, "min": 2, "max": 40}))
def generate2(seed, order, length, temp, stop_at, avoid_stop, theme, mode, topics, corpus=None):
    return _c(corpus).generate2(seed, order, length, temp, stop_at, avoid_stop, theme, mode=mode, topics=topics)


# ---------------------------------------------------------------- extract & transform
@model("text.extract", "Extract entities", "text", "Every email, URL, year, number, date, name, hashtag or amount of money, counted.", device="cpu",
       fields=_f({"k": "kind", "type": "choice", "label": "What", "choices": list(te.EXTRACT), "default": "years"}))
def extract(kind, corpus=None):
    return te.extract(_c(corpus), kind)


def _tparams():
    keys = []
    for t in te.TRANSFORMS.values():
        for p in t.get("params") or []:
            k = p if isinstance(p, str) else p.get("k")
            if k and k not in keys:
                keys.append(k)
    return keys


_TP = {"find": "str", "replace": "str", "pattern": "str", "case": "bool", "whole": "bool", "reverse": "bool"}
TRANSFORM_FIELDS = [{"k": "op", "type": "choice", "label": "Transform", "choices": list(te.TRANSFORMS), "required": True}] + \
    [{"k": k, "type": _TP.get(k, "str"), "label": k.capitalize()} for k in (_tparams() or list(_TP))]


def _op_params(**kw):
    return {k: v for k, v in kw.items() if v is not None}


@model("text.transform", "Transform the corpus", "text", "A versioned, undoable rewrite (replace, regex, case, de-duplicate, clean markup…), re-indexed on the card.",
       long=True, mutating=True, device="mixed", fields=_f(*TRANSFORM_FIELDS))
def transform(job, op, corpus=None, **kw):
    a = _c(corpus)
    return te.transform(a.id, op, _op_params(**kw), job)


@model("text.transform.preview", "Preview a transform", "text", "Before and after, on the first characters. The corpus does not change.", device="mixed",
       fields=_f(*(TRANSFORM_FIELDS + [{"k": "n", "type": "int", "label": "Characters", "default": 1400, "min": 50, "max": 20000}])),
       example={"op": "upper"})
def transform_preview(op, n, corpus=None, **kw):
    import numpy as np
    a = _c(corpus)
    head = bytes(a.raw[:n * 3])

    class Tiny:
        raw = np.frombuffer(head, np.uint8)
    tmp = tempfile.mktemp(dir=TMP)
    try:
        te.apply_transform(Tiny, op, _op_params(**kw), tmp)
        after = open(tmp, "rb").read()
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return {"before": head.decode("utf-8", "replace")[:n], "after": after.decode("utf-8", "replace")[:n]}


@model("text.undo", "Undo the last transform", "text", "Go back one corpus version.", long=True, mutating=True, fields=_f())
def undo(job, corpus=None):
    return te.undo(_c(corpus).id, job)


def _recipes():
    try:
        with open(RECIPES) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


@model("text.recipe.list", "Saved recipes", "text", "Transform sequences saved for reuse.", device="cpu")
def recipe_list():
    return _recipes()


@model("text.recipe.save", "Save the corpus's transforms as a recipe", "text", "Store the transforms applied so far under a name.", device="cpu",
       mutating=True, fields=_f({"k": "name", "type": "str", "label": "Name"}))
def recipe_save(name, corpus=None):
    a = _c(corpus)
    steps = [{"op": s["op"], "params": s.get("params") or {}, "name": s.get("name")} for s in a.meta.get("recipe") or []
             if s["op"] in te.TRANSFORMS]
    if not steps:
        raise R.Refused("nothing to save yet: apply some transforms first")
    r = _recipes()
    r[name or "Recipe {}".format(len(r) + 1)] = {"steps": steps, "saved": time.time()}
    with open(RECIPES, "w") as f:
        json.dump(r, f)
    return r


@model("text.recipe.delete", "Delete a recipe", "text", "", device="cpu", mutating=True,
       fields=[{"k": "name", "type": "str", "label": "Recipe", "required": True}])
def recipe_delete(name):
    r = _recipes()
    r.pop(name, None)
    with open(RECIPES, "w") as f:
        json.dump(r, f)
    return r


@model("text.recipe.run", "Run a recipe", "text", "Apply a saved sequence of transforms to the corpus.", long=True, mutating=True, device="mixed",
       fields=_f({"k": "name", "type": "str", "label": "Recipe", "required": True}))
def recipe_run(job, name, corpus=None):
    a = _c(corpus)
    r = _recipes().get(name)
    if not r:
        raise R.Refused("no such recipe", 404)
    for i, s in enumerate(r["steps"]):
        job.step(i / len(r["steps"]), "step {} of {}: {}".format(i + 1, len(r["steps"]), s.get("name") or s["op"]))
        te.transform(a.id, s["op"], s["params"])
    return {"steps": len(r["steps"])}


# ---------------------------------------------------------------- the Vectorfall LM (the VectorLM generator)
_VLM_WARN = " VectorLM is a prototype that is under development. It is not a complete LLM. Do not use it for serious work."
def _lm():
    from .. import lm
    return lm


@model("text.lm.status", "Language model status", "text", "VectorLM generator: " + "If the LM of the corpus is built and trained, and its held-out perplexities." + _VLM_WARN,
       device="cpu", fields=_f())
def lm_status(corpus=None):
    return _lm()._status(_c(corpus))


@model("text.lm.build", "Build the n-gram LM", "text", "VectorLM generator: " + "Count Kneser-Ney n-gram tables on the card and evaluate them." + _VLM_WARN, long=True, mutating=True,
       fields=_f({"k": "order", "type": "int", "label": "Order", "default": 5, "min": 2, "max": 6}))
def lm_build(job, order, corpus=None):
    return _lm().build_job(_c(corpus), order, job)


@model("text.lm.train", "Train the neural LM", "text", "VectorLM generator: " + "Train an MLP language model on the card (Adam), then mix it with the n-gram model." + _VLM_WARN,
       long=True, mutating=True, timeout=3600,
       fields=_f({"k": "epochs", "type": "int", "label": "Epochs", "default": 2, "min": 1, "max": 20},
                 {"k": "hidden", "type": "int", "label": "Hidden units", "default": 384, "min": 64, "max": 1024},
                 {"k": "ctx", "type": "int", "label": "Context words", "default": 6, "min": 2, "max": 10},
                 {"k": "minutes", "type": "float", "label": "Time budget (minutes)", "default": 4.0, "min": 0.2, "max": 60}))
def lm_train(job, epochs, hidden, ctx, minutes, corpus=None):
    return _lm().train_job(_c(corpus), epochs, hidden, ctx, minutes, job)


@model("text.lm.generate", "Generate with the LM", "text", "VectorLM generator: " + "Sample from the hybrid (n-gram + neural) model; reports the output's perplexity." + _VLM_WARN,
       device="mixed",
       fields=_f({"k": "seed", "type": "str", "label": "Start", "default": ""},
                 {"k": "length", "type": "int", "label": "Words", "default": 80, "min": 1, "max": 1000},
                 {"k": "temp", "type": "float", "label": "Temperature", "default": 0.7, "min": 0.05, "max": 3},
                 {"k": "theme", "type": "str", "label": "Theme word", "default": ""},
                 {"k": "novelty", "type": "float", "label": "Novelty", "default": 0.5, "min": 0, "max": 1},
                 {"k": "model", "type": "choice", "label": "Model", "choices": ["hybrid", "kn", "mlp"], "default": "hybrid"},
                 {"k": "stop_at", "type": "choice", "label": "Stop at", "choices": ["none", "sentence", "paragraph"], "default": "none"},
                 {"k": "rs", "type": "int", "label": "Random seed (-1 = random)", "default": -1, "min": -1},
                 {"k": "top_p", "type": "float", "label": "Top-p", "default": 0.85, "min": 0.05, "max": 1},
                 {"k": "repetition", "type": "float", "label": "Repetition penalty", "default": 0.6, "min": 0, "max": 5},
                 {"k": "rerank", "type": "int", "label": "Candidates per sentence", "default": 1, "min": 1, "max": 16,
                  "help": "Draw this many candidate sentences and keep the most typical one on the topic (1 = plain samples). "
                          "In a blind test with a judge, it was not better than plain samples at temperature 0.7, and the cost was 6x."},
                 {"k": "rep_function_words", "type": "bool", "label": "Penalise repeated function words too", "default": False,
                  "help": "Off: the repetition penalty spares the, of, and, punctuation (they must repeat to make grammar)."},
                 {"k": "rank_by", "type": "choice", "label": "Keep the candidate that is", "choices": ["typical", "fluency"],
                  "default": "typical", "help": "typical: surprise closest to the model's own expectation; fluency: the likeliest (drifts to headings)."},
                 {"k": "no_repeat", "type": "int", "label": "Block repeated n-grams of", "default": 3, "min": 0, "max": 6,
                  "help": "Lowers the chance of a word that repeats an n-word sequence in the text (0 = off). Stops loops."}))
def lm_generate(seed, length, temp, theme, novelty, model, stop_at, rs, top_p, repetition, rerank=1, rep_function_words=False,
                rank_by="typical", no_repeat=3, corpus=None):
    return _lm().generate_api(_c(corpus), seed, length, temp, theme, novelty, model, stop_at, rs, top_p, repetition,
                              rerank, rep_function_words, rank_by, no_repeat)


# ---------------------------------------------------------------- Text Lab: the ideas behind generation, and pipelines
def _tl():
    from .. import textlab
    return textlab


def _bad(fn):
    """Text Lab input errors are the caller's to fix: a 400 with the message, not a 500."""
    import functools

    @functools.wraps(fn)
    def w(*a, **k):
        tl = _tl()
        try:
            return fn(*a, **k)
        except tl.Bad as e:
            raise R.Refused(str(e), 400)
    return w


_MERGES = {"k": "merges", "type": "int", "label": "BPE merges", "default": 1000, "min": 50, "max": 8000,
           "help": "How many merges the BPE trainer learns on this corpus (more merges = longer tokens, bigger vocabulary)."}
_PIPE = ({"k": "pipeline", "type": "str", "label": "Pipeline (a saved or built-in name)", "default": "",
          "help": "For example 'Kneser-Ney 5-gram'. text.pipeline.list shows them all."},
         {"k": "spec", "type": "json", "label": "Pipeline JSON (or changes to the named one)", "default": None,
          "help": "Keys: tokenizer (word|bpe|char), combine (mix|product), scorers [{kind: unigram|ngram|suffix|neural|topic|cache, "
                  "weight, order, theme}], sampling {temperature, top_k, top_p, min_p, repetition, no_repeat}, "
                  "constraints {length, stop, ban, include, rhyme}."})


@model("text.tokens", "Tokenize: words, BPE, characters", "text",
       "The same text under three tokenizers, with the token ids, the BPE merges that built each piece, and characters per token.",
       device="mixed", fields=_f({"k": "text", "type": "text", "label": "Text", "required": True}, _MERGES),
       example={"text": "It is a truth universally acknowledged."})
@_bad
def tokens(text, merges, corpus=None):
    return _tl().tokenize(_c(corpus), text, merges)


@model("text.tokens.merges", "The BPE merges learned on the corpus", "text",
       "Train byte-pair encoding on a sample of the corpus and list its first merges (the most frequent pairs).",
       long=True, device="cpu", fields=_f(_MERGES, {"k": "first", "type": "int", "label": "Merges to list", "default": 60, "min": 1, "max": 2000}))
@_bad
def tokens_merges(job, merges, first, corpus=None):
    return _tl().bpe_merges(_c(corpus), merges, first, job)


@model("text.tokens.score", "Which tokenizer predicts best?", "text",
       "Bits per character of held-out text under the same n-gram model with word, BPE and character tokens, against "
       "uniform, a character unigram and gzip.", long=True, device="cpu",
       fields=_f(_MERGES, {"k": "order", "type": "int", "label": "n-gram order", "default": 3, "min": 1, "max": 6}))
@_bad
def tokens_score(job, merges, order, corpus=None):
    return _tl().tokenizer_score(_c(corpus), merges, order, job)


@model("text.predict", "Next word: how the models decide", "text",
       "For a context: every n-gram level (count, back-off weight, distribution), the longest match, the neural LM and "
       "the blend, with their held-out perplexities.", device="mixed",
       fields=_f({"k": "context", "type": "str", "label": "Context", "default": "", "required": True},
                 {"k": "top", "type": "int", "label": "Words per list", "default": 10, "min": 1, "max": 50}),
       example={"context": "I do not"})
@_bad
def predict(context, top, corpus=None):
    return _tl().predict(_c(corpus), context, top)


@model("text.embed.explain", "How a word gets its vector", "text",
       "The words near it (raw counts, then PPMI), its neighbours after the SVD and, on request, the analogy test of the space.",
       device="mixed", fields=_f({"k": "word", "type": "str", "label": "Word", "required": True},
                                 {"k": "k", "type": "int", "label": "Words per list", "default": 12, "min": 3, "max": 50},
                                 {"k": "test", "type": "bool", "label": "Run the analogy test too", "default": False}),
       example={"word": "sea"})
@_bad
def embed_explain(word, k, test, corpus=None):
    return _tl().embed_explain(_c(corpus), word, k, test=test)


@model("text.pipeline.list", "Generation pipelines", "text", "The built-in and saved pipelines (tokenizer, scorers, sampling, constraints).",
       device="cpu")
def pipeline_list():
    return _tl().pipelines()


@model("text.pipeline.check", "Check a pipeline", "text", "Fill in the defaults and list what is wrong, before a run.",
       device="cpu", fields=_f(*_PIPE))
@_bad
def pipeline_check(pipeline, spec, corpus=None):
    tl = _tl()
    a = te.ACTIVE["c"]
    p, problems, warns = tl.check(tl.resolve(pipeline, spec), a if a and a.ready else None)
    return {"pipeline": p, "ok": not problems, "problems": problems, "warnings": warns, "summary": tl.summary(p) if p else ""}


@model("text.pipeline.run", "Generate with a pipeline", "text",
       "Write text with a pipeline: its tokenizer, scorers (with weights), sampling rules and constraints. "
       "Each word reports its probability and the scorer that gave it most.", device="mixed",
       fields=_f(*_PIPE, {"k": "seed", "type": "str", "label": "Start", "default": ""},
                 {"k": "rs", "type": "int", "label": "Random seed (-1 = random)", "default": -1, "min": -1}),
       example={"pipeline": "Kneser-Ney 5-gram", "seed": "The sea"})
@_bad
def pipeline_run(pipeline, spec, seed, rs, corpus=None):
    tl = _tl()
    return tl.run(_c(corpus), tl.resolve(pipeline, spec), seed, rs)


@model("text.pipeline.score", "Score a pipeline", "text",
       "Held-out perplexity of its model, and the diversity, loops, copying and fluency of its samples.", long=True,
       device="mixed", timeout=600,
       fields=_f(*_PIPE, {"k": "samples", "type": "int", "label": "Samples", "default": 4, "min": 1, "max": 16},
                 {"k": "eval_tokens", "type": "int", "label": "Held-out tokens", "default": 1500, "min": 250, "max": 6000},
                 {"k": "seed", "type": "str", "label": "Start", "default": ""}))
@_bad
def pipeline_score(job, pipeline, spec, samples, eval_tokens, seed, corpus=None):
    tl = _tl()
    return tl.score(_c(corpus), tl.resolve(pipeline, spec), samples, eval_tokens, seed, job)


@model("text.pipeline.compare", "Compare pipelines side by side", "text",
       "Score several pipelines on the same held-out text and samples, next to real held-out text.", long=True,
       device="mixed", timeout=1800,
       fields=_f({"k": "pipelines", "type": "strs", "label": "Pipelines (names)", "default": ["Markov 3-gram", "Kneser-Ney 5-gram", "VectorLM blend"]},
                 {"k": "specs", "type": "json", "label": "More pipelines as {name: JSON}", "default": None},
                 {"k": "samples", "type": "int", "label": "Samples each", "default": 4, "min": 1, "max": 16},
                 {"k": "eval_tokens", "type": "int", "label": "Held-out tokens", "default": 1000, "min": 250, "max": 6000},
                 {"k": "seed", "type": "str", "label": "Start", "default": ""}))
@_bad
def pipeline_compare(job, pipelines, specs, samples, eval_tokens, seed, corpus=None):
    tl = _tl()
    items = [(n, tl.resolve(n)) for n in (pipelines or [])]
    if isinstance(specs, dict):
        items += [(str(k), tl.resolve("", v)) for k, v in specs.items()]
    if not items:
        raise tl.Bad("name at least one pipeline")
    return tl.compare(_c(corpus), items[:8], samples, eval_tokens, seed, job)


@model("text.pipeline.save", "Save a pipeline", "text", "Store a pipeline (JSON, or a named one with changes) under a name, for the UI, agents and the Console.",
       device="cpu", mutating=True, fields=[{"k": "name", "type": "str", "label": "Name", "required": True}] + list(_PIPE))
@_bad
def pipeline_save(name, pipeline, spec):
    tl = _tl()
    return tl.save(name, tl.resolve(pipeline, spec) if pipeline else (spec or {}))


@model("text.pipeline.delete", "Delete a saved pipeline", "text", "", device="cpu", mutating=True,
       fields=[{"k": "name", "type": "str", "label": "Name", "required": True}])
@_bad
def pipeline_delete(name):
    return _tl().delete(name)
