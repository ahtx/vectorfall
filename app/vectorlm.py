"""VectorLM: answers to simple questions, grounded in the corpus on the card.

The steps, in order:
  1. retrieve  - BM25 over the corpus passages (Corpus.retrieve: GPU term scans, 200-token windows);
  2. select    - split the best passages into sentences and score each one: the question terms it holds (IDF-weighted,
                 with a light stemmer), the score of its passage, and whether it holds the kind of answer the question
                 asks for (a person, a year, a place, a number, a definition);
  3. extract   - take the short answer span of that kind from the best sentence, nearest to the question terms;
  4. generate  - (optional) let the corpus LM (app/lm.py: Kneser-Ney + a small neural LM trained on the card) continue
                 from the answer sentence. That text is labelled as generated: it is not checked against the source.

Every answer carries its source passage, so the user can see where it came from. When the best sentence holds too
little of the question, the answer is "not found" and the passages are shown instead.

VectorLM is a prototype. It is not a complete LLM, and WARNING says so on every surface (UI, REST, MCP, OpenAI-style
endpoint).
"""
import re
import time

from . import textengine as te

WARNING = ("VectorLM is a prototype that is under development. It is not a complete LLM. Do not use it for serious "
           "work. The text that it makes is often poor, and its answers are often wrong. Use it as a lab tool, "
           "not as a working LLM.")
NAME = "VectorLM (retrieval + extraction, prototype)"

QWORDS = set("""who whom whose what which when where why how many much does did do is are was were the a an of in on
at to for by with from about tell me name give list""".split())
MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December"
YEAR_RE = re.compile(r"\b(?:(?:%s)\s+\d{1,2},?\s+)?(1[0-9]{3}|20[0-9]{2})s?\b" % MONTHS)
NUM_RE = re.compile(r"\b(?:\d[\d,.]*\d|\d)(?:\s*(?:%|percent\b|million\b|billion\b|thousand\b|hundred\b|km\b|miles\b|"
                    r"kph\b|mph\b|GBps\b|Gbps\b|Mbps\b|qubits?\b|years?\b|feet\b|meters\b|acres\b))?|\b(?:one|two|three|four|"
                    r"five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|million|billion)\b", re.I)
MEASURE = ("range|length|height|distance|speed|population|cost|price|size|weight|rate|data rate|share|percentage|number|"
           "capacity|age|altitude|budget|value|count")
NAME_RE = re.compile(r"\b(?:(?:Mr|Mrs|Miss|Dr|Sir|Lady|Lord|Captain|Prof|General)\.?\s+)?[A-Z][a-z'’]+(?:\s+(?:de|van|von|of|the)?\s*[A-Z][a-z'’]+)*")
PLACE_RE = re.compile(r"\b(?:in|at|from|to|near|into)\s+((?:the\s+)?[A-Z][\w'’-]+(?:\s+[A-Z][\w'’-]+)*)")
SENT_RE = re.compile(r"(?<=[.!?])[\"”’)]?\s+(?=[\"“‘(]?[A-Z0-9])")
WORD_RE = re.compile(r"[^\W_][\w'’-]*")
ABBR = "Mr|Mrs|Ms|Dr|St|Mt|Sr|Jr|Prof|Gen|Col|Capt|Lt|Rev|vs|etc|No|Co|Inc|Ltd|U\.S|i\.e|e\.g"
TITLES = set("Mr Mrs Miss Ms Dr Sir Lady Lord Captain Prof Professor General Secretary President Deputy Chairman Mme Madame Monsieur M Esq Saint St".split())
COMMON = set("""another look woe why not yes no oh ah well now then there here what who how chapter volume book part god
heaven lord sir madam yes indeed perhaps alas behold good poor dear come go see let pray thank god's english french
father mother king queen mister master uncle aunt brother sister monsieur madame captain doctor""".split())
SENT_START = set("The A An This That These Those It He She They We I You In On At But And Or So As If When While For".split())


def _stem(w):
    w = w.lower().replace("’", "'")
    for suf in ("'s", "ing", "edly", "ed", "es", "s", "ly"):
        if len(w) > len(suf) + 3 and w.endswith(suf):
            return w[:-len(suf)]
    return w


def kind_of(q):
    ql = q.lower().strip()
    if re.match(r"^(who|whom|whose)\b", ql) or re.search(r"\b(which|what) (person|man|woman|author|character|company)\b", ql):
        return "person"
    if re.match(r"^when\b", ql) or re.search(r"\b(what|which) (year|date|decade|century)\b|\bin what year\b", ql):
        return "time"
    if re.match(r"^where\b", ql) or re.search(r"\b(what|which) (city|country|place|town|state|region)\b", ql):
        return "place"
    if re.match(r"^how (many|much|long|far|old|fast|big|high)\b", ql) or re.search(
            r"\bwhat (is |was |are |were )?(the )?(theoretical |maximum |average |total )*(%s)\b" % MEASURE, ql):
        return "number"
    if re.match(r"^(what|who) (is|are|was|were)\b|^define\b|^what does .* mean", ql):
        return "definition"
    return "fact"


def _sentences(text):
    """[(sentence, character offset in text, is_heading)]. A blank line ends a sentence too (single line breaks are
    hard wraps, as in Gutenberg texts), and a piece without an end mark (a title or a by-line) counts as a heading."""
    out = []
    for m in re.finditer(r"(?:[^\n]|\n(?![ \t]*\n))+", text):
        para, base = m.group(0), m.start()
        pieces = []
        for s in SENT_RE.split(para):                      # glue back the splits after "Mr." / "St." / "Dr."
            if pieces and re.search(r"\b(%s)\.[\"”’)]?$" % ABBR, pieces[-1].rstrip()):
                pieces[-1] = pieces[-1] + " " + s
            else:
                pieces.append(s)
        pos = 0
        for s in pieces:
            i = para.find(s.split(" ", 1)[0], pos)
            if i >= 0:
                pos = i + 1
            st = s.strip()
            if len(st) > 2:
                head = not re.search(r"[.!?:;\"”’)]$", st)
                out.append((re.sub(r"\s+", " ", st), base + max(i, 0), head))
    return out


def _spans(kind, sent, qstems):
    """Candidate answer spans of the asked-for kind in a sentence, as (start, end, text)."""
    out = []
    if kind == "time":
        out = [(m.start(), m.end(), m.group(0)) for m in YEAR_RE.finditer(sent)]
    elif kind == "number":
        for m in NUM_RE.finditer(sent):
            a, b = m.start(), m.end()
            if a > 0 and (sent[a - 1].isalpha() or sent[a - 1] in "-/"):      # AKF-98, F-35: part of a name
                continue
            if b < len(sent) and sent[b].isalpha():                          # 5G, 3D: part of a word
                continue
            out.append((a, b, m.group(0).strip()))
    elif kind == "place":
        out = [(m.start(1), m.end(1), m.group(1)) for m in PLACE_RE.finditer(sent)]
    elif kind == "person":
        for m in NAME_RE.finditer(sent):
            t = re.sub(r"['’]s$", "", m.group(0))
            words = t.split()
            a0 = m.start()
            while len(words) > 1 and (words[0].lower() in te.STOP or words[0].lower() in COMMON or words[0] in SENT_START):
                a0 += len(words[0]) + 1                                      # "Before Elizabeth", "At Thornfield Hall"
                words = words[1:]
            t = " ".join(words)
            if len(words) == 1:
                w = words[0]
                if w.lower() in te.STOP or w in SENT_START or w.lower() in COMMON or w.rstrip(".") in TITLES:
                    continue
                if m.start() == 0 or sent[max(0, m.start() - 2):m.start()].strip() in ("\"", "“", "'", "‘"):
                    continue                                                 # a capital only because a sentence starts
            if all(w.rstrip(".") in TITLES or w.lower() in COMMON for w in words):
                continue
            out.append((a0, a0 + len(t), t))
    # spans that only repeat the question are not answers; the words of the question are cut from the ends
    keep = []
    for a, b, t in out:
        st = [_stem(w) for w in WORD_RE.findall(t)]
        if st and all(s in qstems for s in st):
            continue
        if kind == "person":
            ws = t.split()
            while ws and (_stem(ws[0]) in qstems or ws[0].lower() in ("of", "the", "de", "van", "von")
                          or ws[0].rstrip(".") in TITLES and len(ws) > 1 and _stem(ws[1]) in qstems):
                a += len(ws[0]) + 1
                ws = ws[1:]
            t = " ".join(ws)
            if not t:
                continue
        keep.append((a, a + len(t), t))
    return keep


def _qpos(sent, qstems):
    return [m.start() for m in WORD_RE.finditer(sent) if _stem(m.group(0)) in qstems]


def ask(c, question, top=8, generate=False, gen_words=40):
    """Answer a simple question from the corpus c (a loaded textengine.Corpus)."""
    t0 = time.time()
    question = (question or "").strip()
    if not question:
        raise ValueError("ask a question")
    kind = kind_of(question)
    qwords = [w for w in WORD_RE.findall(question) if w.lower() not in QWORDS and w.lower() not in te.STOP]
    qstems = {_stem(w) for w in qwords}
    r = c.retrieve(" ".join(qwords) or question, top=max(1, min(int(top), 20)))
    ps = r.get("passages") or []
    idf = {}
    for t in r.get("terms") or []:
        idf[_stem(t["term"])] = max(idf.get(_stem(t["term"]), 0.0), float(t["idf"]))
    for s in qstems:
        idf.setdefault(s, 1.0)
    mass = sum(idf[s] for s in qstems) or 1.0
    best = None
    cands = []
    smax = max([p["score"] for p in ps] or [1.0]) or 1.0
    typed = kind in ("time", "number", "place", "person")
    for pi, p in enumerate(ps):
        prev = set()
        for si, (s, off, head) in enumerate(_sentences(p["text"])):
            st = {_stem(w) for w in WORD_RE.findall(s)}
            hit = sum(idf[q] for q in qstems if q in st)
            ctx = sum(idf[q] for q in qstems if q in prev and q not in st)   # "these computers" -> the sentence before
            prev = st
            cover = (hit + 0.5 * ctx) / mass
            spans = _spans(kind, s, qstems) if typed else []
            bonus = 0.0
            if typed:
                bonus = 0.25 if spans else -0.15
            elif kind == "definition":
                subj = "|".join(re.escape(w) for w in qwords[:4]) or "^$"
                if re.search(r"\b(%s)\b[^.]{0,40}\b(is|are|was|were|means|refers to)\b" % subj, s, re.I):
                    bonus = 0.25
            n = len(s.split())
            length_pen = 0.1 if n > 60 else (0.15 if n < 5 else 0.0)
            score = cover + 0.25 * (p["score"] / smax) + bonus - length_pen - (0.35 if head else 0.0)
            cands.append((score, cover, pi, si, s, spans, off))
    cands.sort(key=lambda x: -x[0])
    if cands:
        best = cands[0]
    found = bool(best) and best[1] >= 0.45
    answer, sentence, span = "", "", None
    if found:
        _, cover, pi, si, sentence, spans, off = best
        if spans:
            qp = _qpos(sentence, qstems)

            def dist(sp):                       # nearest the question words; a full name beats one word
                return min([abs(sp[0] - x) for x in qp] or [0]) - 25 * (len(sp[2].split()) - 1)
            span = min(spans, key=dist)
            answer = span[2]
        else:
            answer = sentence
    p = ps[best[2]] if found else None
    doc, sbyte = (p["doc"] if p else None), None
    if p:                                       # the document of the sentence itself (a passage can cross documents)
        sbyte = p["byte"] + len(p["text"][:best[6]].encode("utf-8"))
        try:
            doc = c.doc_at(sbyte) or doc
        except Exception:  # noqa: BLE001
            pass
    out = {"question": question, "kind": kind, "found": found, "answer": answer, "sentence": sentence,
           "span": span[2] if span else None, "confidence": round(min(1.0, best[1]), 2) if best else 0.0,
           "doc": doc, "byte": p["byte"] if p else None, "end": p["end"] if p else None, "sentence_byte": sbyte,
           "passage": p["text"] if p else None,
           "passages": [{"doc": x["doc"], "byte": x["byte"], "end": x["end"], "score": x["score"], "text": x["text"][:1200]}
                        for x in ps[:4]],
           "terms": r.get("terms") or [], "model": NAME, "warning": WARNING}
    if not found:
        out["sentence"] = ("The documents in this corpus do not answer that clearly. "
                           "The closest passages are below.") if ps else "Nothing in this corpus matches the question."
    if generate and found:
        from . import lm
        seed = " ".join(sentence.split()[-12:])
        try:
            g = lm.generate_api(c, seed=seed, length=max(5, min(int(gen_words), 200)), temp=0.7, stop_at="paragraph", rs=1)
            out["generated"] = {"seed": seed, "text": g.get("text", ""), "note": "Written by the corpus LM. Not checked against the source."}
        except Exception as e:  # noqa: BLE001
            out["generated"] = {"error": str(e)[:200]}
    out["ms"] = round((time.time() - t0) * 1000, 1)
    return out
