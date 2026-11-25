"""Exact-source text: where did this text come from, and what comes next -- with a source for every word.

Trace   Paste any text. Reading left to right, each stretch is matched against the loaded corpus for as long as it
        keeps matching word for word (a GPU scan finds every place the first word occurs; the following words are
        checked at those places). Stretches of N+ words that appear verbatim are marked with the documents they
        appear in and how many times. The same words in shuffled order are traced too: that is how much would match
        by accident, so "62% traced, 1% for shuffled words" means the text really was copied, not merely similar.

Continue  The infinite-gram idea (Liu et al., 2024): to choose the next word, find the LONGEST ending of the text so
        far that occurs anywhere in the corpus, look at every place it occurs, and pick among the words that came next
        there. No fixed n: a famous phrase continues verbatim, a novel one backs off to a few words. Every word carries
        its source position and the length of the context it was matched on.
"""
import re
import time

import numpy as np

from .textengine import TOKEN_RE, normalise

WORD = re.compile(rb"^[A-Za-z0-9'\x80-\xff]+$")
SCAN_CAP = 3_000_000


def _tokens(c, text, case):
    norm = normalise(text.encode("utf-8"))
    out = []
    for m in TOKEN_RE.finditer(norm):
        t = m.group()
        if t.startswith(b"\n"):
            t = b"\n\n"
        if case:
            g = c.gid_exact(t)
            ids = [g] if g is not None else []
        else:
            ids = c.gids_any_case(t)
        out.append({"span": m.span(), "ids": ids, "word": bool(WORD.match(t))})
    return norm, out


class _Scans:
    """Positions of a token (any of its ids), cached: a long text repeats its common words many times."""

    def __init__(self, c):
        self.c, self.cache, self.n = c, {}, 0

    def get(self, ids):
        k = tuple(sorted(ids))
        if k not in self.cache:
            pos, _ = self.c._scan(list(k), SCAN_CAP)
            self.cache[k] = pos
            self.n += 1
        return self.cache[k]


def _longest_from(c, toks, i, scans):
    """Longest run toks[i:i+L] occurring verbatim in the corpus -> (L, start positions)."""
    if not toks[i]["ids"]:
        return 0, None
    P = scans.get(toks[i]["ids"])
    L = 1
    while i + L < len(toks) and P.size and toks[i + L]["ids"]:
        g = c.gids_at(P + L)
        keep = np.isin(g, np.array(toks[i + L]["ids"], np.int64))
        if not keep.any():
            break
        P = P[keep]
        L += 1
    return L, P


def _coverage(c, toks, min_words, scans, with_sources=False):
    i, spans = 0, []
    covered = np.zeros(len(toks), bool)
    while i < len(toks):
        L, P = _longest_from(c, toks, i, scans)
        words = sum(1 for t in toks[i:i + L] if t["word"])
        if L and words >= min_words:
            covered[i:i + L] = True
            spans.append((i, L, P))
            i += L
        else:
            i += 1
    nwords = sum(1 for t in toks if t["word"])
    cw = sum(1 for t, cv in zip(toks, covered) if t["word"] and cv)
    return spans, covered, (cw / float(nwords) if nwords else 0.0), nwords


def attribute(c, text, min_words=6, case=False):
    t0 = time.time()
    text = (text or "")[:60000]
    norm, toks = _tokens(c, text, case)
    if not toks:
        raise ValueError("paste some text to trace")
    scans = _Scans(c)
    spans, covered, cov, nwords = _coverage(c, toks, min_words, scans)
    # the same words in a random order: what matches by accident
    rs = np.random.RandomState(0)
    sub = toks[:600]
    order = rs.permutation(len(sub))
    shuffled = [sub[k] for k in order]
    _, _, cov_shuf, _ = _coverage(c, shuffled, min_words, scans)
    segs, docs_total = [], {}
    pos_in = 0
    for (i, L, P) in spans:
        k = 0
        while k < L - 1 and not toks[i + k]["word"]:                 # a match that starts on punctuation shows from its first word
            k += 1
        i, L, P = i + k, L - k, P + k
        a, b = toks[i]["span"][0], toks[i + L - 1]["span"][1]
        if a > pos_in:
            segs.append({"t": norm[pos_in:a].decode("utf-8", "replace")})
        sample = P[:200]
        docs, first = {}, {}
        for p in sample:
            sp = c.spans(int(p), 1)
            d = c.doc_at(sp[0][0]) if sp else None
            docs[d or "(corpus)"] = docs.get(d or "(corpus)", 0) + 1
            if sp and (d or "(corpus)") not in first:          # where to open each document: its first copy of the stretch
                e = c.spans(int(p), L)
                first[d or "(corpus)"] = [sp[0][0], e[-1][1] if e else sp[0][1]]
        words = sum(1 for t in toks[i:i + L] if t["word"])
        for d in docs:
            docs_total[d] = docs_total.get(d, 0) + words
        ex = c.kwic([int(P[0])], L, 140)
        segs.append({"t": norm[a:b].decode("utf-8", "replace"), "words": words, "count": int(P.size), "capped": bool(P.size >= SCAN_CAP),
                     "docs": sorted(docs.items(), key=lambda x: -x[1])[:6], "ndocs": len(docs), "pos": int(P[0]), "at": first,
                     "context": ex[0] if ex else None})
        pos_in = b
    if pos_in < len(norm):
        segs.append({"t": norm[pos_in:].decode("utf-8", "replace")})
    longest = max((s for s in segs if "words" in s), key=lambda s: s["words"], default=None)
    top = sorted(docs_total.items(), key=lambda x: -x[1])[:8]
    out = {"segments": segs, "coverage": round(cov, 4), "coverage_shuffled": round(cov_shuf, 4), "words": nwords,
           "spans": len(spans), "min_words": min_words, "longest": longest["words"] if longest else 0,
           "longest_doc": (longest["docs"][0][0] if longest and longest["docs"] else None), "top_docs": top,
           "scans": scans.n, "unknown": sum(1 for t in toks if t["word"] and not t["ids"]), "ms": round((time.time() - t0) * 1000, 1)}
    if spans:
        out["sentence"] = ("{:.0%} of your text appears word for word in the corpus, in {} stretch{} of {}+ words "
                           "(the same words shuffled: {:.0%}). The longest runs {} words{}.").format(
            cov, len(spans), "" if len(spans) == 1 else "es", min_words, cov_shuf, out["longest"],
            " — from " + out["longest_doc"] if out["longest_doc"] else "")
    else:
        out["sentence"] = "No stretch of {}+ words appears verbatim in the corpus — this text is not a copy from it.".format(min_words)
    return out


def _longest_suffix(c, ctx, scans, max_ctx):
    """ctx: list of id-lists. -> (L, positions just after each occurrence of the longest matching ending)."""
    if not ctx or not ctx[-1]:
        return 0, np.zeros(0, np.int64)
    P = scans.get(ctx[-1])
    P = P[P + 1 < c.T]
    L = 1
    while L < min(len(ctx), max_ctx) and P.size > 0 and ctx[-1 - L]:
        g = c.gids_at(P - L)
        keep = np.isin(g, np.array(ctx[-1 - L], np.int64))
        if not keep.any():
            break
        P = P[keep]
        L += 1
    return L, P + 1


def continue_text(c, prompt, n=60, temp=1.0, max_ctx=40, seed=None):
    t0 = time.time()
    rs = np.random.RandomState(seed if seed is not None else int(time.time() * 1000) % (2 ** 31))
    _, toks = _tokens(c, prompt or "", False)
    ctx = [t["ids"] for t in toks]
    scans = _Scans(c)
    if not ctx or not any(ctx):
        dot = c.gid_exact(b".")
        ctx = [[dot]] if dot is not None else []
    out = []
    for _ in range(int(n)):
        L, P = _longest_suffix(c, ctx, scans, max_ctx)
        while P.size == 0 and len(ctx) > 1:                     # the last word is unknown: drop it and back off
            ctx = ctx[:-1]
            L, P = _longest_suffix(c, ctx, scans, max_ctx)
        if P.size == 0:
            src = rs.randint(max(1, c.T))
            g, L, nxt_n, dist = int(c.gids_at([src])[0]), 0, 0, 0
        else:
            if P.size > 400000:
                P = P[rs.choice(P.size, 400000, replace=False)]
            vals = c.gids_at(P)
            ok = vals >= 0
            P, vals = P[ok], vals[ok]
            u, inv, cnt = np.unique(vals, return_inverse=True, return_counts=True)
            w = cnt.astype(np.float64) ** (1.0 / max(0.05, temp))
            j = rs.choice(u.size, p=w / w.sum())
            cand = np.flatnonzero(inv == j)
            src = int(P[cand[rs.randint(cand.size)]])
            g, nxt_n, dist = int(u[j]), int(P.size), int(u.size)
        ctx.append([g])
        out.append({"w": c.word(g), "src": src, "ctx": int(L), "options": dist, "seen": nxt_n})
    from .textengine import detok
    lens = [o["ctx"] for o in out]
    run, best, best_end = 0, 0, 0                                # longest stretch where every word was the only option
    for k, o in enumerate(out):
        run = run + 1 if o["options"] == 1 and o["ctx"] > 0 else 0
        if run > best:
            best, best_end = run, k
    doc = None
    if best:
        sp = c.spans(out[best_end]["src"], 1)
        doc = c.doc_at(sp[0][0]) if sp else None
    return {"text": detok([o["w"] for o in out]), "words": out, "prompt": prompt, "mean_ctx": round(float(np.mean(lens)), 2) if lens else 0,
            "forced": sum(1 for o in out if o["options"] == 1), "copied_run": best, "copied_doc": doc, "scans": scans.n,
            "ms": round((time.time() - t0) * 1000, 1)}
