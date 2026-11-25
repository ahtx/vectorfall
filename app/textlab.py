"""Text Lab: how text generation works, shown on your own corpus, and a composer that combines the techniques.

Every view is scored on held-out text, against simple baselines:
  - tokenizers (words, BPE trained on this corpus, characters): tokens, ids and merges; bits per character of the
    same n-gram model under each tokenizer (the only fair cross-tokenizer score), against uniform, a character
    unigram and gzip;
  - next-word prediction: the n-gram levels one by one (count, back-off weight, distribution), the longest match,
    the neural LM and the blend, each with its held-out perplexity;
  - embeddings: the contexts of a word (counts, PPMI), its neighbours after the SVD, and the analogy test;
  - pipelines: a tokenizer, one or more scorers with weights, sampling rules and constraints. A pipeline is scored by
    held-out perplexity (the model) and by measures of its samples (diversity, loops, copying, fluency), next to the
    same measures for real held-out text and for random words.

The word-level scorers reuse the VectorLM tables (app/lm.py: Kneser-Ney counted on the card, the suffix expert, the
neural LM). BPE and character pipelines use a small count model built here on a sample of the corpus (CPU).
"""
import gzip
import heapq
import json
import math
import os
import re
import threading
import time
from collections import Counter, defaultdict

import numpy as np

from . import textengine as te

ROOT = "/srv/data/textlab"
PIPES = os.path.join(ROOT, "pipelines.json")
_LOCK = threading.RLock()
_CACHE = {}                      # small in-memory caches keyed by (corpus id, version, ...)
SP = "▁"                    # the BPE mark for "a space comes before this piece" (SentencePiece style)
PIECE_RE = re.compile(r" ?[^\W\d_]+| ?\d| ?[^\w\s]+")
WORD_RE = re.compile(r"[A-Za-z0-9'\u0080-￿]+|[^\sA-Za-z0-9]")
P = 1099511628211
MASK = (1 << 64) - 1


class Bad(ValueError):
    """A pipeline or input the user can fix; the message says how."""


def _key(c, *more):
    return (c.id, c.version) + tuple(more)


def _cached(key, make):
    with _LOCK:
        if key in _CACHE:
            return _CACHE[key]
    v = make()
    with _LOCK:
        if len(_CACHE) > 24:
            _CACHE.pop(next(iter(_CACHE)))
        _CACHE[key] = v
    return v


def _step(job, f, msg):
    if job is not None:
        job.step(f, msg)


# ---------------------------------------------------------------- a sample of the corpus (train / held-out)
FULL_TRAIN, FULL_HELD = 64_000_000, 1_500_000   # the card's count models: (up to) the whole training side


def sample(c, train_bytes=FULL_TRAIN, held_bytes=FULL_HELD):
    """Train and held-out text, from blocks spread over the whole corpus; every 10th block is held out.
    Whitespace runs become one space, so all three tokenizers code exactly the same characters."""
    def make():
        n = int(c.raw.size)
        nb = max(20, min(4000, n // 32768))
        bs = max(1, n // nb)
        held_ix = [i for i in range(nb) if i % 10 == 5]
        train_ix = [i for i in range(nb) if i % 10 != 5]
        take_t = max(1, int(train_bytes // bs))
        take_h = max(1, int(held_bytes // bs))
        train_ix = train_ix[::max(1, len(train_ix) // take_t)][:take_t]
        held_ix = held_ix[::max(1, len(held_ix) // take_h)][:take_h]

        def text(ix):
            parts = [bytes(c.raw[i * bs:(i + 1) * bs]).decode("utf-8", "ignore") for i in ix]
            return re.sub(r"\s+", " ", " ".join(parts)).strip()
        return {"train": text(train_ix), "held": text(held_ix)}
    return _cached(_key(c, "sample", train_bytes, held_bytes), make)


# ---------------------------------------------------------------- BPE, trained on the corpus
class BPE:
    """Byte-pair encoding over characters: start from single characters, then merge the most frequent adjacent pair,
    again and again. Pieces never cross a word start (a space belongs to the piece after it, shown as ▁)."""

    def __init__(self, text, merges=1000, max_types=60000, job=None):
        t0 = time.time()
        freq = Counter(PIECE_RE.findall(text))
        types = freq.most_common(max_types)
        words = [list(w.replace(" ", SP)) for w, _ in types]
        counts = [f for _, f in types]
        chars = Counter()
        for w, f in zip(words, counts):
            for ch in w:
                chars[ch] += f
        self.base = ["<unk>"] + [ch for ch, _ in chars.most_common()]
        pairs = defaultdict(int)
        where = defaultdict(set)
        for i, w in enumerate(words):
            for a, b in zip(w, w[1:]):
                pairs[(a, b)] += counts[i]
                where[(a, b)].add(i)
        heap = [(-n, pr) for pr, n in pairs.items()]
        heapq.heapify(heap)
        self.merges = []                       # [(a, b, count)]
        while len(self.merges) < merges and heap:
            n, pr = heapq.heappop(heap)
            if pairs.get(pr, 0) != -n or -n < 2:
                continue
            a, b = pr
            ab = a + b
            self.merges.append((a, b, -n))
            touched = {}
            for i in list(where[pr]):
                w = words[i]
                f = counts[i]
                for x, y in zip(w, w[1:]):             # take the word's old pairs out
                    pairs[(x, y)] -= f
                    where[(x, y)].discard(i)
                    touched[(x, y)] = 1
                j, nw = 0, []
                while j < len(w):
                    if j + 1 < len(w) and w[j] == a and w[j + 1] == b:
                        nw.append(ab)
                        j += 2
                    else:
                        nw.append(w[j])
                        j += 1
                words[i] = nw
                for x, y in zip(nw, nw[1:]):           # and its new pairs in
                    pairs[(x, y)] += f
                    where[(x, y)].add(i)
                    touched[(x, y)] = 1
            for t in touched:
                v = pairs.get(t, 0)
                if v <= 0:
                    pairs.pop(t, None)
                    where.pop(t, None)
                else:
                    heapq.heappush(heap, (-v, t))
            if job is not None and len(self.merges) % 100 == 0:
                job.step(0.05 + 0.4 * len(self.merges) / merges, "BPE: {:,} merges".format(len(self.merges)))
        self.rank = {(a, b): r for r, (a, b, _n) in enumerate(self.merges)}
        self.vocab = self.base + [a + b for a, b, _n in self.merges]
        self.ids = {}
        for i, s in enumerate(self.vocab):
            self.ids.setdefault(s, i)
        self._enc = {}
        self.secs = round(time.time() - t0, 2)
        self.types = len(types)

    def encode_piece(self, piece, trace=False):
        if not trace and piece in self._enc:
            return self._enc[piece]
        w = [ch if ch in self.ids else "<unk>" for ch in piece.replace(" ", SP)]
        steps = [list(w)] if trace else None
        while len(w) > 1:
            best, bi = None, -1
            for j in range(len(w) - 1):
                r = self.rank.get((w[j], w[j + 1]))
                if r is not None and (best is None or r < best):
                    best, bi = r, j
            if best is None:
                break
            w = w[:bi] + [w[bi] + w[bi + 1]] + w[bi + 2:]
            if trace:
                steps.append({"merge": best, "pair": [self.merges[best][0], self.merges[best][1]], "pieces": list(w)})
        if trace:
            return w, steps
        if len(self._enc) < 200000:
            self._enc[piece] = w
        return w

    def encode(self, text):
        out = []
        for piece in PIECE_RE.findall(text):
            out.extend(self.encode_piece(piece))
        return out

    def ids_of(self, toks):
        return np.array([self.ids.get(t, 0) for t in toks], np.int64)

    @staticmethod
    def decode(toks):
        return "".join(toks).replace(SP, " ").strip()


def get_bpe(c, merges=1000, job=None):
    merges = int(max(50, min(int(merges), 8000)))
    return _cached(_key(c, "bpe", merges), lambda: BPE(sample(c)["train"], merges, job=job))


# ---------------------------------------------------------------- a count model for any token ids
def _hashes(seq, order):
    t = seq.astype(np.uint64) + np.uint64(1)
    hs = [None, t]
    with np.errstate(over="ignore"):  # noqa: SIM117
        for k in range(2, order + 1):
            hn = np.zeros_like(t)
            hn[1:] = hs[-1][:-1] * np.uint64(P) + t[1:]
            hs.append(hn)
    return hs


def _ctxhash(seq):
    h = 0
    for x in seq:
        h = (h * P + int(x) + 1) & MASK
    return h


class CountLM:
    """Interpolated absolute discounting (D = 0.75) over orders 1..N, the simple cousin of Kneser-Ney:
    p_k(w | ctx) = max(c(ctx w) - D, 0) / c(ctx) + D * types(ctx) / c(ctx) * p_(k-1)(w | shorter ctx)."""
    D = 0.75

    def __init__(self, seq, V, order=3):
        self.V, self.order = int(V), int(order)
        seq = np.asarray(seq, np.int64)
        cnt = np.bincount(seq, minlength=self.V).astype(np.float64)
        self.p0 = (cnt + 0.5) / (cnt.sum() + 0.5 * self.V)
        hs = _hashes(seq, self.order)
        self.tab = {}
        for k in range(2, self.order + 1):
            keys = hs[k][k - 1:]
            ctx = hs[k - 1][k - 2:-1]
            w = seq[k - 1:]
            ukey, first, kc = np.unique(keys, return_index=True, return_counts=True)
            uctx_all, w_u = ctx[first], w[first]
            o = np.lexsort((w_u, uctx_all))
            cs, ws, ns = uctx_all[o], w_u[o], kc[o].astype(np.float64)
            uctx, start = np.unique(cs, return_index=True)
            start = np.concatenate([start, [cs.size]]).astype(np.int64)
            tot = np.add.reduceat(ns, start[:-1]) if cs.size else np.zeros(0)
            self.tab[k] = {"ukey": ukey, "kcnt": kc.astype(np.float64), "uctx": uctx, "start": start, "w": ws,
                           "n": ns, "tot": tot, "types": np.diff(start).astype(np.float64)}

    def _find(self, tb, h):
        r = int(np.searchsorted(tb["uctx"], np.uint64(h)))
        return r if r < tb["uctx"].size and int(tb["uctx"][r]) == h else -1

    def dist(self, hist, order=None):
        p = self.p0.copy()
        for k in range(2, (order or self.order) + 1):
            if len(hist) < k - 1:
                break
            tb = self.tab[k]
            r = self._find(tb, _ctxhash(hist[-(k - 1):]))
            if r < 0:
                continue
            s, e = tb["start"][r], tb["start"][r + 1]
            tot = tb["tot"][r]
            p *= self.D * tb["types"][r] / tot
            p[tb["w"][s:e]] += np.maximum(tb["n"][s:e] - self.D, 0) / tot
        return p

    @classmethod
    def on_card(cls, seq, V, order=3):
        """The same tables, counted on the card: rolling 64-bit hashes, a radix sort per order, run-length counts.
        Only the unique n-grams come back to the host. The training side is cut to what fits in the card's memory."""
        from . import engine
        import cupy as cp
        self = cls.__new__(cls)
        self.V, self.order = int(V), int(order)
        seq = np.asarray(seq, np.int32)
        cnt = np.bincount(seq, minlength=self.V).astype(np.float64)
        self.p0 = (cnt + 0.5) / (cnt.sum() + 0.5 * self.V)
        self.tab, st = {}, {}

        def prep():
            free = cp.cuda.runtime.memGetInfo()[0]
            n = int(min(seq.size, max(100000, free // 48)))        # ~5 arrays of 8 bytes per token at the peak
            st["n"] = n
            st["t"] = cp.asarray(seq[:n])
            st["h"] = st["t"].astype(cp.uint64) + cp.uint64(1)      # hash of the 1-gram ending at i
            return n

        def one(k):
            t, h = st["t"], st["h"]
            hn = cp.zeros_like(h)
            hn[1:] = h[:-1] * cp.uint64(P) + (t[1:].astype(cp.uint64) + cp.uint64(1))
            keys, ctx, w = hn[k - 1:], h[k - 2:-1], t[k - 1:]
            o = cp.argsort(keys)
            ks = keys[o]
            flag = cp.concatenate([cp.ones(1, cp.bool_), ks[1:] != ks[:-1]])
            starts = cp.flatnonzero(flag)
            kc = cp.diff(cp.concatenate([starts, cp.asarray([ks.size])]))
            first = o[starts]
            ukey, uc, uw = ks[starts], ctx[first], w[first]
            del o, ks, flag, starts, first
            st["h"] = hn
            g = cp.argsort(uc)                                      # group the n-gram types by their context
            cs, ws, ns = uc[g], uw[g], kc[g].astype(cp.float64)
            gf = cp.concatenate([cp.ones(1, cp.bool_), cs[1:] != cs[:-1]])
            gs = cp.flatnonzero(gf)
            start = cp.concatenate([gs, cp.asarray([cs.size])])
            csum = cp.concatenate([cp.zeros(1, cp.float64), cp.cumsum(ns)])
            tot = csum[start[1:]] - csum[start[:-1]]
            return {"ukey": cp.asnumpy(ukey), "kcnt": cp.asnumpy(kc).astype(np.float64), "uctx": cp.asnumpy(cs[gs]),
                    "start": cp.asnumpy(start).astype(np.int64), "w": cp.asnumpy(ws).astype(np.int64), "n": cp.asnumpy(ns),
                    "tot": cp.asnumpy(tot), "types": cp.asnumpy(cp.diff(start)).astype(np.float64)}

        def free():
            st.clear()
            cp.get_default_memory_pool().free_all_blocks()
        t0 = time.time()
        try:
            self.n_counted = engine.run_on_gpu(prep, "Text Lab: tokens to the card", 60)
            for k in range(2, self.order + 1):
                self.tab[k] = engine.run_on_gpu(lambda k=k: one(k), "Text Lab: count the {}-grams".format(k), 120)
        finally:
            engine.run_on_gpu(free, "Text Lab: free", 30)
        self.count_secs = round(time.time() - t0, 3)
        return self

    def logprob(self, seq, order=None, gpu=False):
        """log p of every token of seq given what came before it (natural log), vectorised; on the card if gpu."""
        order = min(order or self.order, self.order)
        seq = np.asarray(seq, np.int64)

        def calc(xp):
            s_ = xp.asarray(seq)
            t = s_.astype(xp.uint64) + xp.uint64(1)
            h = t.copy()
            lp = xp.asarray(self.p0)[s_]
            for k in range(2, order + 1):
                tb = self.tab[k]
                hn = xp.zeros_like(h)
                hn[1:] = h[:-1] * xp.uint64(P) + t[1:]
                i = xp.arange(k - 1, seq.size)
                ctx, kk = h[i - 1], hn[i]
                h = hn
                if tb["uctx"].size == 0:
                    continue
                uctx, ukey = xp.asarray(tb["uctx"]), xp.asarray(tb["ukey"])
                r = xp.minimum(xp.searchsorted(uctx, ctx), uctx.size - 1)
                hit = uctx[r] == ctx
                q = xp.minimum(xp.searchsorted(ukey, kk), ukey.size - 1)
                kc = xp.where(ukey[q] == kk, xp.asarray(tb["kcnt"])[q], 0.0)
                tot = xp.where(hit, xp.asarray(tb["tot"])[r], 1.0)
                ty = xp.where(hit, xp.asarray(tb["types"])[r], 0.0)
                new = (xp.maximum(kc - self.D, 0) + self.D * ty * lp[i]) / tot
                lp[i] = xp.where(hit, new, lp[i])
            out = xp.log(xp.maximum(lp, 1e-300))
            return out if xp is np else xp.asnumpy(out)
        if not gpu:
            with np.errstate(over="ignore"):
                return calc(np)
        from . import engine
        import cupy as cp
        return engine.run_on_gpu(lambda: calc(cp), "Text Lab: score held-out text", 120)


# ---------------------------------------------------------------- tokenizers side by side
def _word_tokens(text):
    return WORD_RE.findall(text)


def _char_unigram(train):
    cc = Counter(train)
    tot = sum(cc.values())
    V = len(cc) + 1
    return lambda ch: (cc.get(ch, 0) + 0.5) / (tot + 0.5 * V)


def tokenize(c, text, merges=1000):
    """The same text under three tokenizers: the Text Engine's word tokenizer (ids are the corpus's vocabulary ids,
    ranked by frequency), BPE trained on this corpus (ids: characters first, then the merges in order), characters."""
    text = (text or "").strip()
    if not text:
        raise Bad("type some text to tokenize")
    text = text[:4000]
    norm = re.sub(r"\s+", " ", text)
    out = {"text": text, "chars": len(norm)}
    words = []
    for t in te.TOKEN_RE.findall(te.normalise(text.encode("utf-8"))):
        tb = b"\n\n" if t.startswith(b"\n") else t
        g = c.gid_exact(tb)
        words.append({"t": tb.decode("utf-8", "replace"), "id": -1 if g is None else int(g),
                      "count": None if g is None else int(c.vcount[g])})
    out["word"] = {"tokens": words, "n": len(words), "vocab": int(c.V), "unknown": sum(1 for w in words if w["id"] < 0),
                   "note": "Words, numbers and single punctuation marks; spaces are not tokens. The id is the word's "
                           "rank in this corpus's vocabulary (0 = the most frequent). A word the corpus never had has no id."}
    bpe = get_bpe(c, merges)
    toks = bpe.encode(norm)
    ids = bpe.ids_of(toks)
    out["bpe"] = {"tokens": [{"t": t, "id": int(i), "merge": int(i) - len(bpe.base) if i >= len(bpe.base) else None}
                             for t, i in zip(toks, ids)],
                  "n": len(toks), "vocab": len(bpe.vocab), "base": len(bpe.base), "merges": len(bpe.merges),
                  "note": "▁ marks a space before the piece. Ids below {} are single characters; each id above "
                          "is a merge, numbered in the order the trainer learned it.".format(len(bpe.base))}
    traces = []
    for piece in sorted(set(PIECE_RE.findall(norm)), key=lambda s: -len(s))[:3]:
        final, steps = bpe.encode_piece(piece, trace=True)
        traces.append({"piece": piece.replace(" ", SP), "steps": steps, "final": final})
    out["bpe"]["traces"] = traces
    chars = list(norm)
    cmap = {ch: i + 1 for i, ch in enumerate(bpe.base[1:])}
    cmap[" "] = cmap.get(SP, 0)
    out["char"] = {"tokens": [{"t": ch, "id": cmap.get(ch, 0)} for ch in chars[:2000]], "n": len(chars),
                   "vocab": len(bpe.base), "note": "One token per character, the space included."}
    for k in ("word", "bpe", "char"):
        out[k]["chars_per_token"] = round(len(norm) / max(1, out[k]["n"]), 2)
    return out


def bpe_merges(c, merges=1000, first=60, job=None):
    bpe = get_bpe(c, merges, job)
    tr = re.sub(r"\s+", " ", sample(c)["train"][:200000])
    return {"merges": [{"rank": r, "a": a, "b": b, "new": a + b, "count": int(n)} for r, (a, b, n) in enumerate(bpe.merges[:first])],
            "last": [{"rank": r, "a": a, "b": b, "new": a + b, "count": int(n)}
                     for r, (a, b, n) in list(enumerate(bpe.merges))[-12:]],
            "total": len(bpe.merges), "base": len(bpe.base), "vocab": len(bpe.vocab), "train_secs": bpe.secs,
            "word_types": bpe.types, "chars_per_token": round(len(tr) / max(1, len(bpe.encode(tr))), 2),
            "sample_chars": len(sample(c)["train"])}


def _tok_model(c, kind, merges, order, job=None):
    """(encode(text) -> ids, V, CountLM, spell-cost(token list) for unknowns) for one tokenizer, built on the sample."""
    def make():
        s = sample(c)
        cu = _char_unigram(s["train"])
        if kind == "word":
            toks = _word_tokens(s["train"])
            cnt = Counter(toks)
            vocab = ["<unk>"] + [w for w, n in cnt.most_common() if n >= 2]
            ids = {w: i for i, w in enumerate(vocab)}
            enc = lambda text: [ids.get(t, 0) for t in _word_tokens(text)]
            unk_text = lambda text: [t for t in _word_tokens(text) if t not in ids]
            V = len(vocab)
            dec = lambda seq: te.detok([vocab[i] for i in seq])
            names = vocab
        elif kind == "bpe":
            bpe = get_bpe(c, merges, job)
            enc = lambda text: list(bpe.ids_of(bpe.encode(text)))
            unk_text = lambda text: [ch for ch in text.replace(" ", SP) if ch not in bpe.ids]
            V = len(bpe.vocab)
            dec = lambda seq: BPE.decode([bpe.vocab[i] for i in seq])
            names = bpe.vocab
        else:
            chars = ["<unk>"] + [ch for ch, _ in Counter(s["train"]).most_common()]
            ids = {ch: i for i, ch in enumerate(chars)}
            cps = np.array([ord(ch) for ch in chars[1:]], np.int64)
            o_ = np.argsort(cps)

            def enc(text):                                   # code points -> ids, vectorised (millions of characters)
                u = np.frombuffer(text.encode("utf-32-le"), np.uint32).astype(np.int64)
                j = np.minimum(np.searchsorted(cps[o_], u), cps.size - 1)
                return np.where(cps[o_][j] == u, o_[j] + 1, 0)
            unk_text = lambda text: [ch for ch in text if ch not in ids]
            V = len(chars)
            dec = lambda seq: "".join(chars[i] for i in seq if i)
            names = chars
        t0 = time.time()
        _step(job, 0.3, "{}: tokenizing {:,} characters".format(kind, len(s["train"])))
        seq = np.asarray(enc(s["train"]), np.int64)
        t1 = time.time()
        _step(job, 0.5, "{}: counting {}-grams on the card".format(kind, order))
        lm_ = CountLM.on_card(seq, V, order)
        return {"enc": enc, "V": V, "lm": lm_, "unk_text": unk_text, "cu": cu, "dec": dec, "names": names,
                "train_tokens": int(lm_.n_counted), "tokenize_secs": round(t1 - t0, 2), "count_secs": lm_.count_secs}
    return _cached(_key(c, "tokm", kind, int(merges) if kind == "bpe" else 0, int(order)), make)


def tokenizer_score(c, merges=1000, order=3, job=None):
    """Bits per character on held-out text, the same n-gram model under each tokenizer. Lower is better."""
    t0 = time.time()
    order = int(max(1, min(int(order), 6)))
    s = sample(c)
    held = s["held"]
    n_chars = len(held)
    cu = _char_unigram(s["train"])
    rows = []
    for i, kind in enumerate(("word", "bpe", "char")):
        _step(job, 0.1 + 0.28 * i, "scoring the {} tokenizer".format(kind))
        tm = _tok_model(c, kind, merges, order, job)
        seq = np.asarray(tm["enc"](held), np.int64)
        lp = tm["lm"].logprob(seq, gpu=True)
        bits = float(-lp.sum() / math.log(2))
        unk = tm["unk_text"](held)                   # unknown tokens are spelled out, character by character
        spell = sum(-math.log2(cu(ch)) for t in unk for ch in t) + (len(unk) * math.log2(1 / 0.02) if kind == "word" else 0)
        rows.append({"tokenizer": kind, "vocab": tm["V"], "tokens": int(seq.size), "chars_per_token": round(n_chars / max(1, seq.size), 2),
                     "ppl_per_token": round(math.exp(-lp.mean()), 2), "bpc": round((bits + spell) / n_chars, 3),
                     "unknown": len(unk), "train_tokens": tm["train_tokens"], "count_secs": tm["count_secs"],
                     "tokenize_secs": tm["tokenize_secs"]})
    held_b = held.encode("utf-8")
    gz = len(gzip.compress(held_b, 9)) * 8 / n_chars
    alphabet = len(set(s["train"])) + 1
    uni = sum(-math.log2(cu(ch)) for ch in held) / n_chars
    best = min(rows, key=lambda r: r["bpc"])
    return {"rows": rows, "order": order, "merges": int(merges), "held_chars": n_chars, "train_chars": len(s["train"]),
            "baselines": {"uniform": round(math.log2(alphabet), 3), "char_unigram": round(uni, 3), "gzip": round(gz, 3)},
            "best": best["tokenizer"], "secs": round(time.time() - t0, 2),
            "note": "Bits per character of held-out text under the same {}-gram model (absolute discounting). Only bits per "
                    "character compare tokenizers fairly: a perplexity per token depends on how long a token is. Unknown "
                    "tokens are charged their spelling, character by character. The word tokenizer does not code the "
                    "spaces, which gives it a small advantage.".format(order)}


# ---------------------------------------------------------------- next-word prediction, level by level (word LM)
def _lm():
    from . import lm
    return lm


def _model(c, job=None):
    m, _ = _lm().get_model(c, job=job)
    return m


def hist_ids(c, m, text):
    """Text -> LM ids, tokenised like the corpus. Unknown words are kept as <unk> (and listed)."""
    ids, words, unknown = [], [], []
    for t in te.TOKEN_RE.findall(te.normalise((text or "").encode("utf-8"))):
        tb = b"\n\n" if t.startswith(b"\n") else t
        g = c.gid_exact(tb)
        if g is None:
            gl = c.gids_any_case(tb)
            g = gl[0] if gl else None
        w = tb.decode("utf-8", "replace")
        if g is None or m.lut[g] == m.UNK:
            ids.append(m.UNK)
            unknown.append(w)
        else:
            ids.append(int(m.lut[g]))
        words.append(w)
    return ids, words, unknown


def _top(m, p, k, counts=None):
    o = np.argsort(-p)[:k]
    return [{"w": m.words[i] if i < m.Vn else "<unk>", "p": round(float(p[i]), 5)} for i in o if p[i] > 0]


def _entropy(p):
    q = p[p > 0]
    return float(-(q * np.log2(q)).sum())


def predict(c, context="", top=10, dist_n=300, job=None):
    lm = _lm()
    m = _model(c, job)
    hist, words, unknown = hist_ids(c, m, context)
    levels = []
    levels.append({"order": 1, "context": [], "seen": True, "count": None, "types": int(m.Vn),
                   "note": "No context: only how common each word is.", "top": _top(m, m.p_uni, top)})
    for k in range(2, m.order + 1):
        ctx = hist[-(k - 1):] if len(hist) >= k - 1 else None
        lev = {"order": k, "context": [m.words[i] if i < m.Vn else "<unk>" for i in (ctx or [])]}
        if ctx is None:
            lev.update(seen=False, note="the context is shorter than {} words".format(k - 1))
            levels.append(lev)
            continue
        tb = m.tab[k]
        r = tb.lookup(lm._ctxhash(ctx))
        if r < 0:
            lev.update(seen=False, note="never seen in the training text: a {}-gram model backs off to order {}".format(k, k - 1),
                       top=_top(m, m.kn_dist(hist, order=k), top))
            levels.append(lev)
            continue
        s, e = int(tb.start[r]), int(tb.start[r + 1])
        raw = tb.cnt[s:e]
        tot = float(tb.tot_raw[r])
        o = np.argsort(-raw)[:top]
        nn, D = tb.n_raw[r], tb.D_raw
        lev.update(seen=True, count=int(tot), types=int(e - s),
                   counts=[{"w": m.words[int(tb.w[s + j])] if tb.w[s + j] < m.Vn else "<unk>", "count": int(raw[j]),
                            "ml": round(float(raw[j]) / max(1.0, tot), 4)} for j in o],
                   backoff=round(float((D[1] * nn[0] + D[2] * nn[1] + D[3] * nn[2]) / max(1.0, tot)), 4),
                   top=_top(m, m.kn_dist(hist, order=k), top))
        levels.append(lev)
    p = m.kn_dist(hist)
    kn = p / p.sum()
    out = {"context": context, "words": words, "unknown": unknown, "levels": levels, "vocab": int(m.Vn + 1)}
    L, tb, r = m.longest(hist)
    sfx = None
    if tb is not None and L >= 1:
        s, e = int(tb.start[r]), int(tb.start[r + 1])
        sp = m.sfx_dist(tb, r)
        sfx = sp
        out["longest"] = {"length": int(L), "context": [m.words[i] if i < m.Vn else "<unk>" for i in hist[-L:]],
                          "continuations": int(e - s), "count": int(tb.tot_raw[r]), "top": _top(m, sp, top),
                          "used": L >= lm.SFX_MIN}
    mlp = m.mlp_dist(hist) if m.mlp is not None else None
    parts = {"kn": kn}
    if mlp is not None:
        out["neural"] = {"top": _top(m, mlp, top), "entropy": round(_entropy(mlp), 2), "context": int(m.mlp["ctx"])}
        parts["mlp"] = mlp
    if sfx is not None and L >= lm.SFX_MIN:
        parts["sfx"] = sfx
    mix = {k: m.mix.get(k, 0.0) for k in parts}
    if not any(mix.values()):
        mix = {"kn": 1.0}
    ws = sum(mix.values())
    blend = sum(mix[k] / ws * parts[k] for k in parts)
    blend = blend / blend.sum()
    out["kn"] = {"top": _top(m, kn, top), "entropy": round(_entropy(kn), 2)}
    out["blend"] = {"top": _top(m, blend, top), "weights": {k: round(v / ws, 2) for k, v in mix.items()},
                    "entropy": round(_entropy(blend), 2),
                    "note": "The VectorLM blend without its topic cache; the weights were tuned on held-out text."}
    src = {"blend": blend, "kn": kn, "neural": mlp}
    out["dists"] = {}
    for name, d in src.items():
        if d is None:
            continue
        o = np.argsort(-d)[:dist_n]
        out["dists"][name] = {"w": [m.words[i] if i < m.Vn else "<unk>" for i in o], "p": [round(float(d[i]), 6) for i in o],
                              "rest": round(float(1 - d[o].sum()), 6)}
    ev = m.ev or {}
    out["scores"] = {"uniform": int(m.Vn + 1), "unigram": ev.get("unigram"), "bigram": ev.get("bigram"), "kn": ev.get("kn"),
                     "kn_sfx": ev.get("kn_sfx"), "neural": ev.get("mlp"), "blend": ev.get("hybrid"),
                     "eval_tokens": ev.get("eval_tokens"),
                     "note": "Held-out perplexity: how many equally likely words the model is choosing between, on "
                             "text it never saw. Lower is better. Uniform = every word equally likely."}
    return out


# ---------------------------------------------------------------- sampling rules
def shape(p, temperature=1.0, top_k=0, top_p=1.0, min_p=0.0):
    """Temperature, then the truncation rules (top-k, top-p, min-p); returns a normalised copy."""
    p = np.asarray(p, np.float64)
    if temperature <= 0.01:
        q = np.zeros_like(p)
        q[int(np.argmax(p))] = 1.0
        return q
    q = np.where(p > 0, np.exp(np.log(np.maximum(p, 1e-300)) / temperature), 0.0)
    q /= q.sum()
    if top_k and top_k > 0 and top_k < q.size:
        cut = np.partition(q, -top_k)[-top_k]
        q = np.where(q >= cut, q, 0.0)
    if top_p < 1.0:
        o = np.argsort(-q)
        cs = np.cumsum(q[o])
        keep = int(np.searchsorted(cs, top_p * cs[-1])) + 1
        z = np.zeros_like(q)
        z[o[:keep]] = q[o[:keep]]
        q = z
    if min_p > 0:
        q = np.where(q >= min_p * q.max(), q, 0.0)
    return q / q.sum()


# ---------------------------------------------------------------- embeddings explained
def embed_explain(c, word, k=12, window=5, test=False, job=None):
    """A word's contexts (raw counts within +-window words, then PPMI), its neighbours after the SVD, and, if asked,
    the analogy test of the relation space."""
    w = (word or "").strip().lower()
    if not w:
        raise Bad("type a word")
    _, words, idx, emb = c._embeddings()
    gids = c.gids_any_case(w.encode("utf-8"))
    if not gids:
        raise Bad("the corpus does not have the word {!r}".format(word))
    pos, total = c._scan([int(g) for g in gids], cap=4000)
    pos = np.asarray(pos, np.int64)
    ctx = Counter()
    if pos.size:
        offs = np.concatenate([np.arange(-window, 0), np.arange(1, window + 1)])
        P_ = (pos[:, None] + offs[None, :]).ravel()
        P_ = P_[(P_ >= 0) & (P_ < c.T)]
        g = c.gids_at(P_)
        for x, n in zip(*np.unique(g[g >= 0], return_counts=True)):
            ctx[int(x)] += int(n)
    gsum, _rep = c._groups()
    tot_tokens = float(c.T)
    rows = []
    for g, n in ctx.most_common(400):
        cw = c.word(g).lower()
        if cw in te.STOP or len(cw) < 2 or not re.match(r"[^\W\d_]", cw):
            continue
        cnt = float(gsum[c.lgroup[g]]) if hasattr(c, "lgroup") else 1.0
        pmi = math.log((n * tot_tokens) / (max(1.0, pos.size * 2 * window) * max(1.0, cnt)))
        rows.append({"w": cw, "together": n, "count": int(cnt), "ppmi": round(max(0.0, pmi), 3)})
    raw_top = sorted(rows, key=lambda r: -r["together"])[:k]
    ppmi_top = sorted(rows, key=lambda r: -r["ppmi"] * (r["together"] >= 5))[:k]
    sim = c.similar_words(w, k)
    out = {"word": w, "occurrences": int(total), "used": int(pos.size), "window": window, "raw": raw_top, "ppmi": ppmi_top,
           "neighbours": sim.get("items", []), "in_space": w in idx, "space_words": len(words), "dims": int(emb.shape[1]),
           "method": "Count the words within {} places of each word (on the card), weight each count by PPMI "
                     "(how much more often the pair occurs than chance), then keep the strongest {} directions of that "
                     "matrix with a randomized SVD. Words with similar contexts get similar vectors.".format(window, int(emb.shape[1]))}
    if test:
        _step(job, 0.3, "analogy test of the relation space")
        out["test"] = c.rel_test()
    return out


# ---------------------------------------------------------------- pipelines
SCORER_KINDS = {
    "unigram": "word frequency only (a baseline)",
    "ngram": "n-gram counts with back-off (Kneser-Ney for words; absolute discounting for BPE and characters)",
    "suffix": "the longest match in the corpus (infini-gram style): copy what followed the longest matching context",
    "neural": "the small neural LM trained on the card",
    "topic": "steering: lift words whose embedding is near the theme words",
    "cache": "steering: lift words near the meaning of the text written so far",
}
PROB_KINDS = ("unigram", "ngram", "suffix", "neural")
WORD_ONLY = ("suffix", "neural", "topic", "cache")
DEFAULT = {
    "tokenizer": "word", "merges": 1000, "combine": "mix",
    "scorers": [{"kind": "ngram", "order": 5, "weight": 1.0}],
    "sampling": {"temperature": 0.8, "top_k": 0, "top_p": 0.9, "min_p": 0.0, "repetition": 0.5, "no_repeat": 3},
    "constraints": {"length": 60, "stop": "sentence", "ban": [], "include": [], "rhyme": ""},
}
PRESETS = {
    "Markov 3-gram": {"scorers": [{"kind": "ngram", "order": 3, "weight": 1}],
                      "sampling": {"temperature": 1.0, "top_p": 1.0, "repetition": 0, "no_repeat": 0}},
    "Kneser-Ney 5-gram": {"scorers": [{"kind": "ngram", "order": 5, "weight": 1}]},
    "Neural LM": {"scorers": [{"kind": "neural", "weight": 1}]},
    "VectorLM blend": {"scorers": [{"kind": "ngram", "order": 5, "weight": 0.3}, {"kind": "neural", "weight": 0.6},
                                   {"kind": "suffix", "weight": 0.1}, {"kind": "cache", "weight": 0.5}]},
    "Sea story (topic)": {"scorers": [{"kind": "ngram", "order": 5, "weight": 0.4}, {"kind": "neural", "weight": 0.6},
                                      {"kind": "topic", "theme": "sea ship whale storm", "weight": 3}],
                          "constraints": {"length": 60, "stop": "sentence", "include": ["sea"]}},
    "Product of experts": {"combine": "product", "scorers": [{"kind": "ngram", "order": 5, "weight": 0.5},
                                                             {"kind": "neural", "weight": 0.5}]},
    "BPE 4-gram": {"tokenizer": "bpe", "scorers": [{"kind": "ngram", "order": 4, "weight": 1}],
                   "constraints": {"length": 120, "stop": "sentence"}},
    "Characters 6-gram": {"tokenizer": "char", "scorers": [{"kind": "ngram", "order": 6, "weight": 1}],
                          "constraints": {"length": 300, "stop": "sentence"}},
    "Random words (baseline)": {"scorers": [{"kind": "unigram", "weight": 1}],
                                "sampling": {"temperature": 1.0, "top_p": 1.0, "repetition": 0, "no_repeat": 0}},
}


def _merge(base, over):
    out = json.loads(json.dumps(base))
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k].update(v)
        else:
            out[k] = v
    return out


def _f(v, lo, hi, name, problems, default):
    try:
        x = float(v)
    except (TypeError, ValueError):
        problems.append("{} must be a number".format(name))
        return default
    if not (lo <= x <= hi):
        problems.append("{} must be from {} to {}".format(name, lo, hi))
        return min(hi, max(lo, x))
    return x


def _words_list(v):
    if isinstance(v, str):
        v = re.split(r"[,\s]+", v)
    return [str(x).strip().lower() for x in (v or []) if str(x).strip()][:50]


def check(spec, c=None):
    """Fill in the defaults and check a pipeline. Returns (pipeline, problems, warnings); problems stop a run."""
    if isinstance(spec, str):
        spec = spec.strip()
        if spec.startswith("{"):
            try:
                spec = json.loads(spec)
            except ValueError as e:
                return None, ["the pipeline is not valid JSON: {}".format(e)], []
        else:
            spec = {}
    if not isinstance(spec, dict):
        return None, ["a pipeline is a JSON object"], []
    p = _merge(DEFAULT, spec)
    problems, warns = [], []
    tok = p.get("tokenizer", "word")
    if tok not in ("word", "bpe", "char"):
        problems.append("tokenizer must be word, bpe or char")
        tok = p["tokenizer"] = "word"
    p["merges"] = int(_f(p.get("merges", 1000), 50, 8000, "merges", problems, 1000))
    if p.get("combine") not in ("mix", "product"):
        problems.append("combine must be mix (a weighted average) or product (weighted log-probabilities added)")
        p["combine"] = "mix"
    sc = []
    for i, s in enumerate(p.get("scorers") or []):
        if not isinstance(s, dict) or s.get("kind") not in SCORER_KINDS:
            problems.append("scorer {}: kind must be one of {}".format(i + 1, ", ".join(SCORER_KINDS)))
            continue
        s = dict(s)
        s["weight"] = _f(s.get("weight", 1.0), 0, 20, "scorer {} weight".format(i + 1), problems, 1.0)
        if s["kind"] == "ngram":
            s["order"] = int(_f(s.get("order", 5 if tok == "word" else 4), 1, 6 if tok != "word" else 5,
                                "scorer {} order".format(i + 1), problems, 3))
        if s["kind"] == "suffix":
            s["min_context"] = int(_f(s.get("min_context", 4), 1, 11, "suffix min_context", problems, 4))
        if s["kind"] == "topic":
            s["theme"] = str(s.get("theme", "")).strip()
            if not s["theme"]:
                problems.append("the topic scorer needs theme words")
        if tok != "word" and s["kind"] in WORD_ONLY:
            problems.append("the {} scorer works only with the word tokenizer".format(s["kind"]))
        sc.append(s)
    p["scorers"] = sc
    usable = PROB_KINDS if tok == "word" else ("unigram", "ngram")
    if not any(s["kind"] in usable and s["weight"] > 0 for s in sc):
        problems.append("add at least one probability scorer ({}) with a weight above 0".format(", ".join(usable)))
    if sc and all(s["kind"] == "suffix" for s in sc if s["kind"] in PROB_KINDS):
        warns.append("the suffix scorer alone cannot predict after a context the corpus never had; it falls back to unigram")
    sm = p["sampling"]
    sm["temperature"] = _f(sm.get("temperature", 0.8), 0, 3, "temperature", problems, 0.8)
    sm["top_k"] = int(_f(sm.get("top_k", 0), 0, 100000, "top_k", problems, 0))
    sm["top_p"] = _f(sm.get("top_p", 1.0), 0.01, 1, "top_p", problems, 1.0)
    sm["min_p"] = _f(sm.get("min_p", 0.0), 0, 1, "min_p", problems, 0.0)
    sm["repetition"] = _f(sm.get("repetition", 0.0), 0, 5, "repetition", problems, 0.0)
    sm["no_repeat"] = int(_f(sm.get("no_repeat", 0), 0, 6, "no_repeat", problems, 0))
    cs = p["constraints"]
    cs["length"] = int(_f(cs.get("length", 60), 1, 1500, "length", problems, 60))
    if cs.get("stop") not in ("none", "sentence", "paragraph"):
        problems.append("stop must be none, sentence or paragraph")
        cs["stop"] = "sentence"
    cs["ban"] = _words_list(cs.get("ban"))
    cs["include"] = _words_list(cs.get("include"))
    cs["rhyme"] = str(cs.get("rhyme") or "").strip().lower()
    if tok != "word" and cs["rhyme"]:
        problems.append("rhyme works only with the word tokenizer")
    if c is not None and tok == "word":
        m = _lm()._MODELS.get((c.id, c.version))
        if m is not None:
            if m.mlp is None and any(s["kind"] == "neural" for s in sc):
                problems.append("the neural scorer needs a trained neural LM (Generate > VectorLM > Train, or text.lm.train)")
            low = _lower(m)
            for wd in cs["include"] + ([cs["rhyme"]] if cs["rhyme"] else []):
                if wd not in low:
                    warns.append("{!r} is not in the model's vocabulary of {:,} words".format(wd, m.Vn))
    if sm["temperature"] > 1.6 and sm["top_p"] >= 1 and not sm["min_p"] and not sm["top_k"]:
        warns.append("a high temperature without top-p, top-k or min-p reaches deep into the tail: expect word salad")
    return p, problems, warns


def _lower(m):
    if getattr(m, "_lower_ids", None) is None:
        d = defaultdict(list)
        for i, w in enumerate(m.words):
            d[w.lower()].append(i)
        m._lower_ids = dict(d)
    return m._lower_ids


def rhyme_key(w):
    w = re.sub(r"[^a-z]", "", w.lower())
    m_ = re.search(r"[aeiouy]+[^aeiouy]*$", w)
    if not m_:
        return w
    return m_.group(0)                                # the last vowels and what follows: night/light -> ight


class _Word:
    """Word-level scorer set over the VectorLM tables."""

    def __init__(self, c, p, job=None):
        lm = _lm()
        self.lm, self.c, self.p = lm, c, p
        self.m = m = _model(c, job)
        sig = json.dumps(c.get_filter(), sort_keys=True)
        if getattr(m, "Eemb", None) is None or m.emb_sig != sig:
            m.embeddings(c)
            m.emb_sig = sig
        self.E = getattr(m, "Eemb", None)
        self.sc = [s for s in p["scorers"] if s["weight"] > 0]
        self.theme = []
        for s in self.sc:
            if s["kind"] == "topic":
                tv = [m.emb_full[m.emb_idx[w]] for w in re.findall(r"[^\W\d_][\w'\-]*", s["theme"].lower()) if w in m.emb_idx]
                if not tv:
                    raise Bad("none of the theme words {!r} is in the embedding space; try more common words".format(s["theme"]))
                v = np.mean(tv, 0)
                self.theme.append((s["weight"], self.E @ (v / (np.linalg.norm(v) + 1e-9))))
        self.cache_w = sum(s["weight"] for s in self.sc if s["kind"] == "cache")
        if self.E is None and (self.theme or self.cache_w):
            raise Bad("the embeddings are not available, so topic and cache steering cannot run")

    def dist(self, hist, v=None, parts_out=None):
        m = self.m
        parts = []
        for s in self.sc:
            k = s["kind"]
            if k == "unigram":
                parts.append((s, m.p_uni))
            elif k == "ngram":
                parts.append((s, m.kn_dist(hist, order=min(s["order"], m.order))))
            elif k == "neural":
                if m.mlp is None:
                    raise Bad("the neural scorer needs a trained neural LM (text.lm.train)")
                parts.append((s, m.mlp_dist(hist)))
            elif k == "suffix":
                L, tb, r = m.longest(hist)
                if tb is not None and L >= s["min_context"]:
                    parts.append((s, m.sfx_dist(tb, r)))
        if not parts:
            parts = [({"kind": "unigram", "weight": 1.0}, m.p_uni)]
        if self.p["combine"] == "product":
            lp = sum(s["weight"] * np.log(np.maximum(d, 1e-12)) for s, d in parts)
            q = np.exp(lp - lp.max())
        else:
            ws = sum(s["weight"] for s, _ in parts)
            q = sum(s["weight"] / ws * d for s, d in parts)
        for w, cos in self.theme:
            q = q * np.exp(w * cos)
        if self.cache_w and v is not None:
            nv = np.linalg.norm(v)
            if nv > 0:
                q = q * np.exp(self.cache_w * (self.E @ (v / nv)))
        if parts_out is not None:
            parts_out.extend(parts)
        return q / q.sum()

    def heldout(self, n_eval=1500, job=None):
        """Held-out perplexity of the pipeline's model (sampling rules do not change the model)."""
        m = self.m
        held = m.held
        W = 250
        nwin = max(1, min(12, n_eval // W, (held.size - 2) // W))
        starts = np.linspace(0, max(0, held.size - W - 1), nwin).astype(int)
        nll, n, uni = 0.0, 0, 0.0
        for wi, s0 in enumerate(starts):
            v = np.zeros(self.E.shape[1], np.float32) if self.E is not None else None
            for i in range(s0 + 1, s0 + W):
                h = list(held[max(0, i - 12):i])
                if v is not None:
                    v = 0.9 * v + self.E[held[i - 1]]
                q = self.dist(h, v)
                y = held[i]
                nll -= math.log(max(float(q[y]), 1e-12))
                uni -= math.log(float(m.p_uni[y]))
                n += 1
            _step(job, 0.05 + 0.45 * (wi + 1) / nwin, "held-out perplexity: window {}/{}".format(wi + 1, nwin))
        return {"ppl": round(math.exp(nll / n), 2), "unigram": round(math.exp(uni / n), 2), "uniform": int(m.Vn + 1),
                "tokens": n, "bpc": None}


class _Sub:
    """BPE or character scorer set over a CountLM built on the corpus sample."""

    def __init__(self, c, p, job=None):
        self.c, self.p = c, p
        orders = [s.get("order", 4) for s in p["scorers"] if s["kind"] == "ngram"] or [1]
        self.tm = _tok_model(c, p["tokenizer"], p["merges"], max(orders), job)
        self.sc = [s for s in p["scorers"] if s["weight"] > 0]

    def dist(self, hist, v=None, parts_out=None):
        lm_ = self.tm["lm"]
        parts = []
        for s in self.sc:
            if s["kind"] == "unigram":
                parts.append((s, lm_.p0))
            elif s["kind"] == "ngram":
                parts.append((s, lm_.dist(hist, s["order"])))
        if self.p["combine"] == "product":
            lp = sum(s["weight"] * np.log(np.maximum(d, 1e-12)) for s, d in parts)
            q = np.exp(lp - lp.max())
        else:
            ws = sum(s["weight"] for s, _ in parts)
            q = sum(s["weight"] / ws * d for s, d in parts)
        q = q.copy()
        q[0] = 0.0
        return q / q.sum()

    def heldout(self, n_eval=1500, job=None):
        """Perplexity and bits per character on the held-out text. A mix is scored on all of it, on the card; a product
        needs every distribution normalised, so it is scored token by token on the first n_eval tokens."""
        held = sample(self.c)["held"]
        lm_ = self.tm["lm"]
        if self.p["combine"] == "mix":
            seq = np.asarray(self.tm["enc"](held), np.int64)
            ws = sum(s["weight"] for s in self.sc)
            pm = np.zeros(seq.size)
            for s in self.sc:
                lp = np.log(lm_.p0[seq]) if s["kind"] == "unigram" else lm_.logprob(seq, s.get("order"), gpu=True)
                pm += s["weight"] / ws * np.exp(lp)
            pm = 0.999 * pm + 0.001 / lm_.V                     # <unk> keeps a little mass for the score
            nll = float(-np.log(pm[1:]).sum())
            uni = float(-np.log(lm_.p0[seq[1:]]).sum())
            chars = len(held)
        else:
            seq = np.asarray(self.tm["enc"](held[:max(2000, n_eval * 4)]), np.int64)[:max(200, n_eval)]
            nll, uni = 0.0, 0.0
            for i in range(1, seq.size):
                q = self.dist(list(seq[max(0, i - 8):i]))
                q = q * 0.999 + 0.001 / q.size
                nll -= math.log(float(q[seq[i]]))
                uni -= math.log(float(lm_.p0[seq[i]]))
            chars = len(self.tm["dec"](list(seq)))
        n = seq.size - 1
        _step(job, 0.5, "held-out perplexity")
        return {"ppl": round(math.exp(nll / n), 2), "unigram": round(math.exp(uni / n), 2), "uniform": int(self.tm["V"]),
                "tokens": int(n), "bpc": round(nll / math.log(2) / max(1, chars), 3),
                "train_tokens": self.tm["train_tokens"], "count_secs": self.tm["count_secs"]}


def _scorer(c, p, job=None):
    return _Word(c, p, job) if p["tokenizer"] == "word" else _Sub(c, p, job)


def _sample_word(S, p, seed, rng):
    m, c = S.m, S.c
    sm, cs = p["sampling"], p["constraints"]
    hist, seed_words, _unk = hist_ids(c, m, seed)
    hist = [h for h in hist if h != m.UNK]
    seed_words = [m.words[h] for h in hist]
    if not hist:
        dot = m.words.index(".") if "." in m.words else None
        if dot is not None:
            cand = np.flatnonzero(m.train[:-1] == dot)
            if cand.size:
                p0 = int(cand[rng.randint(cand.size)])
                hist = [int(x) for x in m.train[max(0, p0 - 11):p0 + 1]]
    nseed = len(hist)
    gm = c.gen_mask()
    allowed = np.zeros(m.Vn + 1, bool)
    allowed[:m.Vn] = gm[m.gid]
    ex = set(c.get_filter().get("exclude") or [])
    for i, w in enumerate(m.words):
        if w.lower() in te.STOP and w.lower() not in ex:
            allowed[i] = True
    low = _lower(m)
    for wd in cs["ban"]:
        for i in low.get(wd, []):
            allowed[i] = False
    include = {wd: low.get(wd, []) for wd in cs["include"] if wd in low}
    rk = rhyme_key(cs["rhyme"]) if cs["rhyme"] else ""
    exempt = m.punct.copy()
    for i, w in enumerate(m.words):
        if w.lower() in te.STOP:
            exempt[i] = True
    rep_w = (~exempt).astype(np.float64)
    E = S.E
    v = np.zeros(E.shape[1], np.float32) if E is not None else None
    if v is not None:
        for t in hist:
            v = 0.9 * v + E[t]
    out, length = [], cs["length"]
    ends = (".", "!", "?")
    used = set()
    rhymed = None
    while len(out) < length:
        parts = []
        base = S.dist(hist, v, parts)
        q = base.copy()
        q[m.UNK] = 0.0
        q[~allowed] = 0.0
        if not out and not seed_words:                        # with no start text, begin on a word, not on a quote
            q[m.punct[:q.size]] = 0.0
        if sm["repetition"] > 0:
            rec = np.bincount(np.asarray(hist[-32:], np.int64), minlength=m.Vn + 1)[:m.Vn + 1]
            q /= 1.0 + sm["repetition"] * rec * rep_w
        nr = sm["no_repeat"]
        if nr >= 2 and len(out) >= nr - 1:
            n1 = nr - 1
            ctx = tuple(hist[-n1:])
            w0 = max(n1, len(hist) - min(len(out), 150))
            for i in range(w0 - n1, len(hist) - n1):
                if i >= 0 and tuple(hist[i:i + n1]) == ctx and not m.punct[hist[i + n1]]:
                    q[hist[i + n1]] *= 0.02
        left = length - len(out)
        frac = len(out) / max(1, length)
        for wd, ids in include.items():                       # must-include: a growing lift, forced at the end
            if wd not in used:
                q[ids] *= 1.0 + 60.0 * frac ** 2
        need = [wd for wd in include if wd not in used]
        if need and left <= len(need) + 1:
            z = np.zeros_like(q)
            z[include[need[0]]] = 1.0
            q = z
        last_word = rk and left == 1
        if last_word:                                         # the last word must rhyme (by spelling)
            mask = np.array([rhyme_key(w) == rk and w.lower() != cs["rhyme"] for w in m.words] + [False])
            if (q * mask).sum() > 0:
                q = q * mask
                rhymed = True
            elif (base * mask).sum() > 0:
                q = base * mask * allowed
                rhymed = True
            else:
                rhymed = False
        if q.sum() <= 0:
            q = m.p1 * allowed
        q = q / q.sum()
        q = shape(q, sm["temperature"], sm["top_k"], sm["top_p"], sm["min_p"])
        w = int(rng.choice(q.size, p=q))
        expert = max(parts, key=lambda sd: sd[0]["weight"] * sd[1][w])[0]["kind"] if parts else "unigram"
        L, _tb, _r = m.longest(hist + [w])
        out.append({"w": m.words[w], "p": round(float(base[w]), 5), "expert": expert, "match": int(L)})
        hist.append(w)
        if v is not None:
            v = 0.9 * v + E[w]
        wl = m.words[w].lower()
        for wd in include:
            if wl == wd:
                used.add(wd)
        if cs["stop"] == "sentence" and m.words[w] in ends and len(out) >= length * 0.6 and not rk:
            break
        if cs["stop"] == "paragraph" and m.words[w] == "\n\n" and len(out) >= 11 and not rk:
            break
    words = [o["w"] for o in out]
    if rk and words and words[-1] not in ends:
        words.append(".")
    return {"seed": te.detok(seed_words), "text": te.detok(seed_words + words), "tokens": out, "nseed": nseed,
            "include": {wd: (wd in used) for wd in cs["include"]}, "rhymed": rhymed,
            "ids": hist[nseed:]}


LETTERS = re.compile(r"[A-Za-z']*")


def _spell_index(tm):
    """Per token of a BPE or character vocabulary: (starts with a space, its leading letters, ends a word). Maps from
    the leading letters to the token ids let ban / include work on spellings without a loop over the vocabulary."""
    if "spell" in tm:
        return tm["spell"]
    lead_sp, lead_in, end_sp, end_in = defaultdict(list), defaultdict(list), defaultdict(list), defaultdict(list)
    for i, nm in enumerate(tm["names"]):
        if i == 0:
            continue
        t = nm.replace(SP, " ")
        sp = t.startswith(" ")
        body = t[1:] if sp else t
        ld = LETTERS.match(body).group(0).lower()
        ends = sp or len(ld) < len(body)                  # a space before it, or something after its letters
        (lead_sp if sp else lead_in)[ld].append(i)
        if len(ld) < len(body):
            (end_sp if sp else end_in)[ld].append(i)
    tm["spell"] = (lead_sp, lead_in, end_sp, end_in)
    return tm["spell"]


def _sample_sub(S, p, seed, rng):
    """Sampling over BPE pieces or characters. Never use: when a piece finishes a banned word, the word is taken back
    and its first piece is blocked at that place. Must include: pieces that spell the word on are lifted, more and more
    strongly, and from half the length they are forced; the full-stop rule waits until every word is in."""
    tm = S.tm
    sm, cs = p["sampling"], p["constraints"]
    hist = [int(x) for x in tm["enc"](re.sub(r"\s+", " ", seed or ""))]
    nseed = len(hist)
    if not hist:
        hist = [int(x) for x in tm["enc"](". ")]
    n0 = len(hist)
    names = tm["names"]
    texts = [nm.replace(SP, " ") for nm in names]
    lead_sp, lead_in, _end_sp, _end_in = _spell_index(tm)
    ban, include = set(cs["ban"]), cs["include"]
    base_text = tm["dec"](hist) if nseed else ""
    out, parts, starts = [], [], []           # sampled tokens, their text, the index where the current word began
    blocked = defaultdict(set)                # position -> first pieces of banned words, not to draw there again
    used, rewinds = set(), 0
    length = cs["length"]

    def state():
        w = base_text + "".join(parts)
        m_ = re.search(r"[A-Za-z']*$", w[-60:])
        return w, (m_.group(0).lower() if m_ else "")
    written, cur = state()
    while len(out) < length:
        base = S.dist(hist)
        q = base.copy()
        if sm["repetition"] > 0:
            rec = np.bincount(np.asarray(hist[-32:], np.int64), minlength=q.size)[:q.size]
            q /= 1.0 + sm["repetition"] * 0.2 * rec
        if blocked.get(len(out)):
            q[list(blocked[len(out)])] = 0.0
        need = [w for w in include if w not in used]
        for w in need[:1]:                    # lift the pieces that spell the next missing word on from here
            if cur == w:                      # spelled: now end the word (a space or punctuation next)
                ends = [i for i in range(1, q.size) if texts[i][:1] == " " or (texts[i][:1] and not LETTERS.match(texts[i]).group(0))]
                if q[ends].sum() > 0:
                    z = np.zeros_like(q)
                    z[ends] = q[ends]
                    q = z
                break
            if cur and w.startswith(cur) and len(cur) < len(w):
                rest, mp, mid = w[len(cur):], lead_in, True
            else:
                rest, mp, mid = w, lead_sp, False
            ids = sorted({i for k in range(1, len(rest) + 1) for i in mp.get(rest[:k], [])})
            if ids:
                frac = len(out) / max(1, length)
                if frac >= 0.5 or mid:        # force: from half the length, or once the word is under way
                    z = np.zeros_like(q)
                    z[ids] = q[ids] + 1e-9
                    q = z
                else:
                    q[ids] *= 1.0 + 60.0 * frac ** 2
        if q.sum() <= 0:
            q = base.copy()
        q = shape(q / q.sum(), sm["temperature"], sm["top_k"], sm["top_p"], sm["min_p"])
        w = int(rng.choice(q.size, p=q))
        t = texts[w]
        body = t[1:] if t.startswith(" ") else t
        ld = LETTERS.match(body).group(0).lower() if not t.startswith(" ") else ""
        boundary = t.startswith(" ") or len(ld) < len(body)
        done = (cur + ld) if boundary else None                   # the word that this piece finishes, if any
        if done and done in ban and rewinds < 200:
            k = starts[-1] if starts else len(out)                # take the word back, block its first piece there
            if k < len(out):
                blocked[k].add(hist[n0 + k])
                del out[k:], parts[k:], hist[n0 + k:]
                starts = [s_ for s_ in starts if s_ < k]
            else:
                blocked[len(out)].add(w)
            rewinds += 1
            written, cur = state()
            continue
        out.append({"w": names[w], "p": round(float(base[w]), 5), "expert": "ngram", "match": 0})
        hist.append(w)
        parts.append(t)
        prev_cur = cur
        written, cur = state()
        if not prev_cur or boundary:                              # a new word starts in this piece
            if cur:
                starts.append(len(out) - 1 if (t.startswith(" ") or not prev_cur) else len(out) - 1)
        for word in include:
            if word not in used and re.search(r"(?<![A-Za-z'])" + re.escape(word) + r"(?![A-Za-z'])", written[-80:].lower()) and cur != word:
                used.add(word)
        if cs["stop"] == "sentence" and len(out) >= length * 0.6 and t.rstrip().endswith((".", "!", "?")) \
                and all(x in used for x in include):
            break
    text = tm["dec"](hist if nseed else hist[n0:])
    return {"seed": seed, "text": text, "tokens": out, "nseed": nseed, "include": {w: (w in used) for w in include},
            "rhymed": None, "ids": None, "rewinds": rewinds}


def run(c, spec, seed="", rs=-1, job=None):
    p, problems, warns = check(spec, c)
    if problems:
        raise Bad("; ".join(problems))
    t0 = time.time()
    S = _scorer(c, p, job)
    rng = np.random.RandomState(rs if rs is not None and rs >= 0 else int(time.time() * 1000) % (2 ** 31))
    t1 = time.time()
    r = (_sample_word if p["tokenizer"] == "word" else _sample_sub)(S, p, seed, rng)
    dt = time.time() - t1
    r.pop("ids", None)
    r.update(pipeline=p, warnings=warns, ms=round(dt * 1000, 1), tok_s=round(len(r["tokens"]) / max(dt, 1e-6), 1),
             setup_ms=round((t1 - t0) * 1000, 1))
    return r


# ---------------------------------------------------------------- measures of samples (the same judge for every pipeline)
def _judge_ids(c, m, text):
    ids, _w, _u = hist_ids(c, m, text)
    return ids


def measures(c, texts=None, id_lists=None):
    """distinct-1/2 over all samples, repeated 4-grams inside a sample, the share of words inside a verbatim run of 8+
    corpus words, and the perplexity of the text under the corpus's own 5-gram model (lower = reads more like the
    corpus; copying lowers it too, so read it with the copy share)."""
    m = _model(c)
    if id_lists is None:
        id_lists = [_judge_ids(c, m, t) for t in texts]
    d1, d2, rep, copied, nll, n = set(), set(), [], 0, 0.0, 0
    tot1 = tot2 = 0
    for ids in id_lists:
        ids = [int(i) for i in ids]
        words = [m.words[i].lower() if i < m.Vn else "<unk>" for i in ids]
        d1.update(words)
        tot1 += len(words)
        bg = list(zip(words, words[1:]))
        d2.update(bg)
        tot2 += len(bg)
        g4 = list(zip(words, words[1:], words[2:], words[3:]))
        if g4:
            seen, dup = set(), 0
            for g in g4:
                dup += g in seen
                seen.add(g)
            rep.append(dup / len(g4))
        run_ = np.zeros(len(ids), bool)
        for i in range(len(ids)):
            L, _tb, _r = m.longest(ids[max(0, i - 11):i + 1])
            if L >= 8:
                run_[max(0, i - L + 1):i + 1] = True
        copied += int(run_.sum())
        if len(ids) > 1:
            arr = np.array(ids, np.int64)
            lp = m.kn_logprob(arr, np.arange(1, arr.size), m.order)
            nll -= float(lp.sum())
            n += arr.size - 1
    return {"distinct1": round(len(d1) / max(1, tot1), 3), "distinct2": round(len(d2) / max(1, tot2), 3),
            "repeat4": round(float(np.mean(rep)) if rep else 0.0, 3), "copied8": round(copied / max(1, tot1), 3),
            "kn_ppl": round(math.exp(nll / max(1, n)), 1), "words": tot1}


def _reference(c, n_samples, length):
    """The same measures for real held-out text, cut into pieces of the same length."""
    m = _model(c)
    held = m.held
    starts = np.linspace(0, max(0, held.size - length - 1), n_samples).astype(int)
    pieces = [held[s:s + length] for s in starts]
    ex = te.detok([m.words[i] if i < m.Vn else "<unk>" for i in pieces[0]])
    return measures(c, id_lists=pieces), ex


def score(c, spec, samples=4, n_eval=1500, seed="", job=None):
    t0 = time.time()
    p, problems, warns = check(spec, c)
    if problems:
        raise Bad("; ".join(problems))
    S = _scorer(c, p, job)
    ho = S.heldout(n_eval, job)
    texts, rate = [], []
    for i in range(int(max(1, min(samples, 16)))):
        _step(job, 0.55 + 0.4 * i / samples, "sample {}/{}".format(i + 1, samples))
        rng = np.random.RandomState(1000 + i)
        t1 = time.time()
        r = (_sample_word if p["tokenizer"] == "word" else _sample_sub)(S, p, seed, rng)
        rate.append(len(r["tokens"]) / max(1e-6, time.time() - t1))
        texts.append(r["text"][len(r["seed"]):].strip() if r["seed"] else r["text"])
    ms = measures(c, texts)
    return {"pipeline": p, "warnings": warns, "heldout": ho, "samples": ms, "example": texts[0], "tok_s": round(float(np.mean(rate)), 1),
            "secs": round(time.time() - t0, 1)}


def compare(c, specs, samples=4, n_eval=1000, seed="", job=None):
    rows = []
    n = len(specs)
    for i, (name, spec) in enumerate(specs):
        class _J:
            def step(self, f, msg=None):
                _step(job, (i + f) / (n + 1), "{}: {}".format(name, msg or ""))
        try:
            r = score(c, spec, samples, n_eval, seed, _J())
            rows.append({"name": name, "tokenizer": r["pipeline"]["tokenizer"], "ppl": r["heldout"]["ppl"],
                         "unigram_ppl": r["heldout"]["unigram"], "bpc": r["heldout"]["bpc"], "tok_s": r["tok_s"],
                         **r["samples"], "example": r["example"][:400], "warnings": r["warnings"]})
        except Exception as e:  # noqa: BLE001  a bad pipeline gets a row with its error, the others still run
            if e.__class__.__name__ == "Cancelled":
                raise
            rows.append({"name": name, "error": str(e)})
    _step(job, n / (n + 1), "real held-out text (the reference)")
    length = 60
    for _nm, sp in specs:
        pp, _pr, _w = check(sp)
        if pp:
            length = pp["constraints"]["length"] if pp["tokenizer"] == "word" else max(20, pp["constraints"]["length"] // 4)
            break
    ref, ex = _reference(c, samples, length)
    rows.append({"name": "Real held-out text (reference)", "tokenizer": "-", "ppl": None, "bpc": None, "tok_s": None,
                 **ref, "example": ex[:400], "reference": True})
    return {"rows": rows, "samples": samples, "eval_tokens": n_eval,
            "note": "Held-out perplexity scores the model (lower is better; compare it only between pipelines with the "
                    "same tokenizer, or use bits per character). The sample measures score what the sampling rules "
                    "write: aim for the values of real text. distinct-2 = share of different word pairs; repeat-4 = share "
                    "of 4-word sequences that repeat in a sample (loops); copied-8 = share of words inside a run of 8+ "
                    "words that also occurs in the corpus; 5-gram ppl = how ordinary the text looks to the corpus's own "
                    "5-gram model."}


# ---------------------------------------------------------------- saved pipelines
def _load():
    try:
        with open(PIPES) as f:
            d = json.load(f)
            return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def pipelines():
    saved = _load()
    out = [{"name": k, "preset": True, "pipeline": check(v)[0], "summary": summary(check(v)[0])} for k, v in PRESETS.items()]
    out += [{"name": k, "preset": False, "pipeline": v, "summary": summary(v), "saved": v.get("_saved")} for k, v in saved.items()]
    return out


def summary(p):
    if not p:
        return ""
    sc = " + ".join("{}{}{}".format(s["kind"], " " + str(s["order"]) if s["kind"] == "ngram" else "",
                                    " x" + ("%g" % s["weight"]) if len(p["scorers"]) > 1 else "") for s in p["scorers"])
    sm = p["sampling"]
    rules = ["T {:g}".format(sm["temperature"])]
    if sm["top_k"]:
        rules.append("top-k {}".format(sm["top_k"]))
    if sm["top_p"] < 1:
        rules.append("top-p {:g}".format(sm["top_p"]))
    if sm["min_p"]:
        rules.append("min-p {:g}".format(sm["min_p"]))
    return "{} | {} ({}) | {}".format(p["tokenizer"], sc, p["combine"], ", ".join(rules))


def resolve(name="", spec=None):
    """A pipeline from a saved or preset name, with optional overrides (a partial JSON object) on top."""
    base = {}
    if name:
        saved = _load()
        hit = saved.get(name) or PRESETS.get(name)
        if hit is None:
            low = name.lower()
            cand = [k for k in list(saved) + list(PRESETS) if low in k.lower()]
            if not cand:
                raise Bad("no pipeline called {!r}; text.pipeline.list shows them".format(name))
            hit = saved.get(cand[0]) or PRESETS.get(cand[0])
        base = {k: v for k, v in hit.items() if not k.startswith("_")}
    if isinstance(spec, str) and spec.strip():
        try:
            spec = json.loads(spec)
        except ValueError as e:
            raise Bad("the spec is not valid JSON: {}".format(e))
    if spec and not isinstance(spec, dict):
        raise Bad("the spec must be a JSON object")
    return _merge(base, spec or {}) if base else (spec or {})


def save(name, spec):
    name = (name or "").strip()[:60]
    if not name:
        raise Bad("give the pipeline a name")
    if name in PRESETS:
        raise Bad("{!r} is a built-in pipeline; save under another name".format(name))
    p, problems, _w = check(spec)
    if problems:
        raise Bad("; ".join(problems))
    p["_saved"] = time.time()
    d = _load()
    d[name] = p
    os.makedirs(ROOT, exist_ok=True)
    tmp = PIPES + ".tmp"
    with open(tmp, "w", newline="\n") as f:
        json.dump(d, f, indent=1)
    os.replace(tmp, PIPES)
    return {"name": name, "pipeline": p, "summary": summary(p)}


def delete(name):
    d = _load()
    if name not in d:
        raise Bad("no saved pipeline called {!r}".format(name))
    d.pop(name)
    with open(PIPES, "w", newline="\n") as f:
        json.dump(d, f, indent=1)
    return {"deleted": name}
