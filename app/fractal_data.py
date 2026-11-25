"""Fractals from data, the honest kinds.

1. Chaos Game Representation (Jeffrey 1990) of text. Each character is written as 4 base-4 digits; the chaos game
   moves halfway to the corner of each digit, so the picture at depth L is exactly the count of every L-digit history.
   Aligned to characters, one level of 16 x 16 cells is one character: the top level is the last character, the
   next level the one before it, and so on. Zooming into a cell keeps only the places where that suffix occurs, and
   shows what comes before it. Patterns are scored against "characters independent" (observed / expected).
2. Box-counting dimension of a photo's edges, with the fit range, R^2, and the same number of edge pixels scattered at
   random as a control (a pattern with no structure fills the plane: about 2).
3. A fractal (PIFS, Jacquin 1992) compression lab: each 8 x 8 range block is a contracted, flipped, brightness- and
   contrast-adjusted 16 x 16 domain block of the same picture. Decoding iterates the maps from any start (noise) and
   converges; decoding at 4x invents detail (plausible, not true). Its size and PSNR are reported next to JPEG at the
   same size: fractal compression does not beat JPEG (Raittinen & Kaski 1995), and the lab shows the numbers."""
import io
import math
import time

import numpy as np
from PIL import Image

from . import fractal as F


# ================================================================ 1. chaos game representation of text
def _digits(raw):
    b = np.frombuffer(raw, np.uint8)
    return np.stack([(b >> 6) & 3, (b >> 4) & 3, (b >> 2) & 3, b & 3], 1).reshape(-1), b


def _cell(byte):
    """The 16 x 16 cell (x, y) of one character: its 4 digits as 2 bits of x and 2 bits of y."""
    d = [(byte >> 6) & 3, (byte >> 4) & 3, (byte >> 2) & 3, byte & 3]
    x = y = 0
    for k, v in enumerate(d):                    # the first digit is the most significant (the biggest quadrant)
        x |= (v & 1) << (3 - k)
        y |= (v >> 1) << (3 - k)
    return x, y


def cgr_text(raw, suffix=b"", depth=2, palette="inferno"):
    """The CGR picture of a byte stream below a suffix (the characters already zoomed into, oldest first), showing
    `depth` more characters back (16^depth x 16^depth cells, at most 256 x 256 pixels: depth 2)."""
    b = np.frombuffer(raw, np.uint8)
    n = b.size
    depth = max(1, min(2, int(depth)))
    m = len(suffix)
    # positions t (the character at t ends the window) whose last m characters are the suffix
    t = np.arange(m + depth - 1, n)
    ok = np.ones(t.size, bool)
    for i, ch in enumerate(reversed(suffix)):    # suffix[-1] is the most recent
        ok &= b[t - i] == ch
    t = t[ok]
    side = 16 ** depth
    X = np.zeros(t.size, np.int64)
    Y = np.zeros(t.size, np.int64)
    for j in range(depth):                       # level 1 (most significant) = the character just before the suffix
        ch = b[t - m - j]
        x, y = np.zeros(ch.size, np.int64), np.zeros(ch.size, np.int64)
        for k, sh in enumerate((6, 4, 2, 0)):
            v = (ch >> sh) & 3
            x |= (v & 1).astype(np.int64) << (3 - k)
            y |= (v >> 1).astype(np.int64) << (3 - k)
        X = X * 16 + x
        Y = Y * 16 + y
    H = np.bincount(Y * side + X, minlength=side * side).reshape(side, side).astype(np.float64)
    # picture: log counts through the palette, upscaled to 512
    v = np.log1p(H)
    v = v / max(v.max(), 1e-9)
    pal = F._pal(palette).astype(np.float64)
    idx = v * (len(pal) - 1)
    lo = np.floor(idx).astype(int)
    hi = np.minimum(lo + 1, len(pal) - 1)
    f = (idx - lo)[..., None]
    rgb = (pal[lo] * (1 - f) + pal[hi] * f).astype(np.uint8)
    rgb[H == 0] = (6, 4, 8)
    im = Image.fromarray(rgb).resize((512, 512), Image.NEAREST)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    # patterns at the first level below the suffix: which character comes just before, observed vs independent
    freq = np.bincount(b, minlength=256).astype(np.float64) / max(n, 1)
    prev = b[t - m] if t.size else np.zeros(0, np.uint8)
    cnt = np.bincount(prev, minlength=256).astype(np.float64)
    tot = cnt.sum()
    rows = []
    for c in np.flatnonzero(cnt >= 5):
        exp = tot * freq[c]
        rows.append({"char": _show(c), "byte": int(c), "count": int(cnt[c]), "share": round(cnt[c] / tot, 4),
                     "ratio": round(float(cnt[c] / max(exp, 1e-9)), 2), "cell": _cell(int(c))})
    over = sorted(rows, key=lambda r: -r["ratio"])[:10] if suffix else sorted(rows, key=lambda r: -r["count"])[:10]
    under = sorted([r for r in rows if freq[r["byte"]] > 0.002], key=lambda r: r["ratio"])[:6]
    absent = [_show(c) for c in np.argsort(-freq)[:40] if freq[c] > 0.005 and cnt[c] == 0][:8]
    return buf.getvalue(), {"suffix": suffix.decode("latin-1"), "occurrences": int(t.size), "bytes": int(n), "depth": depth,
                            "over": over, "under": under, "never_before": absent}


def _show(c):
    c = int(c)
    return {32: "␣", 10: "⏎", 9: "⇥"}.get(c, chr(c) if 33 <= c < 127 else "\\x%02x" % c)


# ================================================================ 2. box-counting dimension of a photo
def dimension(img, max_side=768, seed=0):
    g = np.asarray(img.convert("L").resize(_fit(img.size, max_side)), np.float64)
    gy, gx = np.gradient(g)
    mag = np.hypot(gx, gy)
    edges = mag > np.percentile(mag, 90)
    n = min(edges.shape)
    E = edges[:n, :n]

    def fit(B):
        sizes, counts = [], []
        s = 2
        while s <= n // 4:
            m = n // s
            c = int(B[:m * s, :m * s].reshape(m, s, m, s).any((1, 3)).sum())
            if c:
                sizes.append(s)
                counts.append(c)
            s *= 2 if s < 8 else 1.5
            s = int(round(s))
        X, Y = np.log(1 / np.array(sizes, float)), np.log(np.array(counts, float))
        A = np.c_[X, np.ones_like(X)]
        coef = np.linalg.lstsq(A, Y, rcond=None)[0]
        pred = A @ coef
        r2 = 1 - ((Y - pred) ** 2).sum() / max(((Y - Y.mean()) ** 2).sum(), 1e-12)
        return float(coef[0]), float(r2), sizes, counts
    d, r2, sizes, counts = fit(E)
    rs = np.random.RandomState(seed)
    shuf = rs.permutation(E.ravel()).reshape(E.shape)
    ds, r2s, _, cs = fit(shuf)
    vis = Image.fromarray((E * 255).astype(np.uint8))
    buf = io.BytesIO()
    vis.convert("RGB").save(buf, "PNG")
    return buf.getvalue(), {"dimension": round(d, 3), "r2": round(r2, 3), "sizes": sizes, "counts": counts, "edge_share": round(float(E.mean()), 3),
                            "shuffled_dimension": round(ds, 3), "shuffled_r2": round(r2s, 3), "shuffled_counts": cs, "pixels": int(n),
                            "note": "Edges = the strongest 10% of brightness changes. The control scatters the same number of edge pixels at random."}


def _fit(size, m):
    w, h = size
    s = min(1.0, m / max(w, h))
    return max(16, int(w * s)), max(16, int(h * s))


# ================================================================ 3. the PIFS compression lab
ISO = [lambda a: a, lambda a: a[:, ::-1], lambda a: a[::-1], lambda a: a[::-1, ::-1],
       lambda a: a.T, lambda a: a.T[:, ::-1], lambda a: a.T[::-1], lambda a: a.T[::-1, ::-1]]
ISO_NAME = ["as is", "mirrored", "flipped", "turned 180°", "transposed", "turned 90°", "turned 270°", "anti-transposed"]
_ENC = {}                                                         # (photo, w, h) -> (grey image, maps): encoding is the slow part


def grid_size(img, longest=256, rb=8):
    """Keep the photo's proportions: the longest side 256, both sides multiples of 2 x range block."""
    w, h = img.size
    s = longest / max(w, h)
    q = 2 * rb
    return max(q * 2, int(round(w * s / q)) * q), max(q * 2, int(round(h * s / q)) * q)


def pifs_encode(g, rb=8):
    """g: float image (H x W, both multiples of 2*rb). Maps per range block: (domain y, x, isometry, s, o)."""
    import cupy as cp
    from .engine import run_on_gpu
    H, W = g.shape
    db = 2 * rb
    doms, where = [], []
    for y in range(0, H - db + 1, rb):                            # domain pool: every 16 x 16 block on an 8 px grid,
        for x in range(0, W - db + 1, rb):                        # averaged down to 8 x 8, in 8 orientations
            d = g[y:y + db, x:x + db].reshape(rb, 2, rb, 2).mean((1, 3))
            for k, f in enumerate(ISO):
                doms.append(f(d).ravel())
                where.append((y, x, k))
    D = np.array(doms, np.float32)
    R = np.array([g[y:y + rb, x:x + rb].ravel() for y in range(0, H, rb) for x in range(0, W, rb)], np.float32)

    def job():
        Dg, Rg = cp.asarray(D), cp.asarray(R)
        P = rb * rb
        sd, sd2 = Dg.sum(1), (Dg * Dg).sum(1)
        out = []
        for i in range(0, Rg.shape[0], 256):
            r = Rg[i:i + 256]
            sr, sr2 = r.sum(1), (r * r).sum(1)
            sdr = r @ Dg.T
            den = P * sd2[None] - sd[None] ** 2
            s = cp.where(cp.abs(den) > 1e-9, (P * sdr - sr[:, None] * sd[None]) / den, 0.0)
            s = cp.clip(s, -1.0, 1.0)
            o = (sr[:, None] - s * sd[None]) / P
            err = sr2[:, None] + s * (s * sd2[None] - 2 * sdr + 2 * o * sd[None]) + o * (P * o - 2 * sr[:, None])
            j = cp.argmin(err, 1)
            rr = cp.arange(r.shape[0])
            out.append(cp.asnumpy(cp.stack([j.astype(cp.float32), s[rr, j], o[rr, j]], 1)))
        return np.concatenate(out, 0)
    res = run_on_gpu(job, "fractal: compress", 300)
    maps = []
    for (j, s, o) in res:
        y, x, k = where[int(j)]
        q = round((s + 1) / 2 * 31) / 31 * 2 - 1                  # quantised as stored: s in 5 bits, o in 7
        maps.append((y, x, k, q, round(o * 127) / 127))
    return maps, len(where)


def pifs_decode(maps, H, W, rb=8, scale=1, iters=12, start=None, seed=1):
    """Apply every map to the whole picture, again and again, from `start` (default: noise)."""
    h, w, r = H * scale, W * scale, rb * scale
    db = 2 * r
    img = np.random.RandomState(seed).rand(h, w) if start is None else np.array(start, np.float64)
    steps = [img.copy()]
    for _ in range(iters):
        new = np.empty_like(img)
        k = 0
        for y in range(0, h, r):
            for x in range(0, w, r):
                dy, dx, iso, s, o = maps[k]
                d = img[dy * scale:dy * scale + db, dx * scale:dx * scale + db].reshape(r, 2, r, 2).mean((1, 3))
                new[y:y + r, x:x + r] = np.clip(s * ISO[iso](d) + o, 0, 1)
                k += 1
        img = new
        steps.append(img.copy())
    return img, steps


def _png(a):
    buf = io.BytesIO()
    Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8)).save(buf, "PNG")
    return buf.getvalue()


def _psnr(a, b):
    mse = float(((a - b) ** 2).mean())
    return 99.0 if mse < 1e-12 else round(10 * math.log10(1.0 / mse), 2)


def _grey(img, W, H):
    return np.asarray(img.convert("L").resize((W, H), Image.LANCZOS), np.float64) / 255.0


def _encoded(key, img, W, H, rb):
    if key not in _ENC:
        g = _grey(img, W, H)
        maps, nd = pifs_encode(g, rb)
        _ENC[key] = (g, maps, nd)
        while len(_ENC) > 8:
            _ENC.pop(next(iter(_ENC)))
    return _ENC[key]


def pifs_lab(img, key="a", start="noise", start_img=None, mix_img=None, mix_key=None, rb=8):
    """Encode (cached), decode from a start (noise, flat grey, or another picture), compare with JPEG, and optionally
    recombine: the left half of the range blocks keeps this photo's maps, the right half takes the other photo's."""
    t0 = time.time()
    W, H = grid_size(img, 256, rb)
    g, maps, nd = _encoded((key, W, H), img, W, H, rb)
    t_enc = time.time() - t0
    s0 = None if start == "noise" else np.full((H, W), 0.5) if start == "grey" else _grey(start_img, W, H) if start_img is not None else None
    dec, steps = pifs_decode(maps, H, W, rb, 1, 12, s0)
    big, _ = pifs_decode(maps, H, W, rb, 4, 10, seed=2)
    bits = len(maps) * (math.ceil(math.log2(nd)) + 5 + 7)        # domain + orientation (one index), s 5 bits, o 7 bits
    nbytes = int(math.ceil(bits / 8))
    best = None
    for qv in range(95, 1, -2):                                   # JPEG of the same grey picture, the largest not above it
        buf = io.BytesIO()
        Image.fromarray((g * 255).astype(np.uint8)).save(buf, "JPEG", quality=qv)
        if buf.tell() <= nbytes or qv <= 3:
            jg = np.asarray(Image.open(io.BytesIO(buf.getvalue())), np.float64) / 255.0
            best = {"quality": qv, "bytes": buf.tell(), "psnr": _psnr(g, jg), "png": buf.getvalue()}
            break
    out = {"original": _png(g), "decoded": _png(dec), "steps": [_png(x) for x in steps], "big": _png(big), "jpeg": best["png"],
           "meta": {"w": W, "h": H, "ranges": len(maps), "range_block": rb, "domains": nd, "raw_bytes": W * H, "fractal_bytes": nbytes,
                    "fractal_psnr": _psnr(g, dec), "jpeg_bytes": best["bytes"], "jpeg_quality": best["quality"], "jpeg_psnr": best["psnr"],
                    "psnr_by_iteration": [_psnr(g, x) for x in steps], "encode_s": round(t_enc, 1), "start": start,
                    "maps": [[int(y), int(x), int(k), round(float(s), 3), round(float(o), 3)] for (y, x, k, s, o) in maps],
                    "iso_names": ISO_NAME}}
    if mix_img is not None:
        gb, mb, _ = _encoded((mix_key, W, H), mix_img, W, H, rb)
        cols = W // rb
        mixed = [mb[i] if (i % cols) >= cols // 2 else maps[i] for i in range(len(maps))]   # right half from the other photo
        hyb, hsteps = pifs_decode(mixed, H, W, rb, 1, 12)
        out["mix"] = _png(hyb)
        out["mix_steps"] = [_png(x) for x in hsteps[::3]]
        out["mix_other"] = _png(gb)
    return out


# ================================================================ 4. text compression: LZ77, the honest "replace repeats"
def lz77(data, window=32768, min_len=4, max_len=258, chain=96):
    """Greedy LZ77 with hash chains: each step either copies the longest earlier match (distance, length) or emits one
    literal byte. Returns tokens: ("L", start, end) literal runs and ("C", start, length, distance)."""
    n = len(data)
    head, prev = {}, [-1] * n
    tokens, i, lit = [], 0, 0
    while i < n:
        best_len, best_d = 0, 0
        if i + min_len <= n:
            h = data[i:i + 3]
            j = head.get(h, -1)
            tries = 0
            while j >= 0 and i - j <= window and tries < chain:
                if data[j + best_len:j + best_len + 1] == data[i + best_len:i + best_len + 1]:
                    k = 0
                    while k < max_len and i + k < n and data[j + k] == data[i + k]:
                        k += 1
                    if k > best_len:
                        best_len, best_d = k, i - j
                        if k >= max_len:
                            break
                j = prev[j]
                tries += 1
        if best_len >= min_len:
            if lit < i:
                tokens.append(("L", lit, i))
            tokens.append(("C", i, best_len, best_d))
            end = i + best_len
        else:
            end = i + 1
        for p in range(i, min(end, n - 2)):                       # index every position we pass (a chain per 3-byte prefix)
            h = data[p:p + 3]
            prev[p] = head.get(h, -1)
            head[h] = p
        if best_len >= min_len:
            i = end
            lit = i
        else:
            i += 1
    if lit < n:
        tokens.append(("L", lit, n))
    return tokens


def lz_lab(text, max_bytes=16000):
    import bz2
    import lzma
    import zlib
    raw = text.encode("utf-8", "replace")[:max_bytes]
    raw = raw[:len(raw.decode("utf-8", "ignore").encode("utf-8"))]   # never cut inside a character
    t0 = time.time()
    toks = lz77(raw)
    lits = sum(t[2] - t[1] for t in toks if t[0] == "L")
    copies = [t for t in toks if t[0] == "C"]
    copied = sum(t[2] for t in copies)
    bits = lits * 9 + len(copies) * (1 + 15 + 8)                 # a literal: flag + byte; a copy: flag + distance + length
    sizes = {"raw": len(raw), "lz77": int(math.ceil(bits / 8)), "gzip": len(zlib.compress(raw, 9)), "bzip2": len(bz2.compress(raw, 9)),
             "xz": len(lzma.compress(raw, preset=9))}
    # tokens as character offsets for the browser (it works on the decoded string)
    s = raw.decode("utf-8")
    arr = np.frombuffer(raw, np.uint8)
    pos = np.concatenate([[0], np.cumsum((arr & 0xC0) != 0x80)]).astype(int).tolist()   # byte offset -> characters before it
    out = []
    for t in toks:
        if t[0] == "L":
            out.append(["L", pos[t[1]], pos[t[2]]])
        else:
            a, ln, d = t[1], t[2], t[3]
            out.append(["C", pos[a], pos[a + ln], pos[a - d], ln, d])
    longest = sorted(copies, key=lambda t: -t[2])[:8]
    dic = dictionary(s, out)
    return {"text": s, "tokens": out, "dictionary": dic, "sizes": sizes, "literal_bytes": lits, "copied_bytes": copied, "copies": len(copies),
            "share_copied": round(copied / max(1, len(raw)), 4), "ms": round((time.time() - t0) * 1000, 1),
            "longest": [{"text": raw[t[1]:t[1] + t[2]].decode("utf-8", "replace")[:160], "length": t[2], "distance": t[3]} for t in longest],
            "note": "Each copy is stored as (how far back, how long) in 24 bits; each literal as 9 bits. gzip adds Huffman coding on top "
                    "of the same idea; bzip2 and xz use other models. None of this is fractal: text has no shrunk copies of itself."}


# ================================================================ 5. compression as a space: dictionary, twins, guided writing
def dictionary(text, tokens, top=80):
    """The phrases LZ77 reused: each distinct copied string, how often it was copied, and where."""
    d = {}
    for t in tokens:
        if t[0] != "C":
            continue
        s = text[t[1]:t[2]]
        key = " ".join(s.split())                                  # variants that differ only by spaces are one phrase
        if len(key) < 3:
            continue
        e = d.setdefault(key, {"text": key, "uses": 0, "at": [], "saved": 0})
        e["uses"] += 1
        e["at"].append(t[1])
        e["saved"] += max(0, len(s.encode("utf-8")) - 3)              # 24 bits instead of the characters
    for e in d.values():                                          # how often the phrase occurs in the whole passage
        e["occurs"] = text.count(e["text"])
    rows = sorted(d.values(), key=lambda e: -(e["occurs"] * max(1, len(e["text"]) - 3) ** 1.5))   # long and frequent first
    return {"phrases": rows[:top], "distinct": len(d)}


def _C(b):
    import zlib
    return len(zlib.compress(b, 9))


def ncd(x, y, cx=None, cy=None):
    """Normalized compression distance (Cilibrasi & Vitanyi 2005): ~0 = one says nothing new about the other, ~1 = unrelated."""
    cx = cx or _C(x)
    cy = cy or _C(y)
    return (_C(x + b" " + y) - min(cx, cy)) / max(cx, cy)


_SPACE = {}


def _sentences(c, limit=6000, seed=0):
    """A sample of the corpus's sentences (40..300 characters), with their documents."""
    import re
    key = (id(c), len(c.raw))
    if key in _SPACE:
        return _SPACE[key]
    raw = bytes(c.raw[:8_000_000]).decode("utf-8", "ignore")
    sents, pos = [], 0
    for m in re.finditer(r"[^.!?\n]{40,300}[.!?]", raw):
        sents.append((m.group(0).strip(), m.start()))
    rs = np.random.RandomState(seed)
    if len(sents) > limit:
        pick = np.sort(rs.choice(len(sents), limit, replace=False))
        sents = [sents[i] for i in pick]
    texts = [s.encode("utf-8") for s, _ in sents]
    anchors = [texts[i] for i in rs.choice(len(texts), 64, replace=False)]
    ca = [_C(a) for a in anchors]
    emb = np.zeros((len(texts), 64), np.float32)
    cs = [_C(t) for t in texts]
    for i, t in enumerate(texts):                                  # the compression embedding: distance to 64 anchors
        emb[i] = [ncd(t, a, cs[i], ca[j]) for j, a in enumerate(anchors)]
    nrm = emb - emb.mean(0)
    nrm /= np.linalg.norm(nrm, axis=1, keepdims=True) + 1e-9
    import bisect
    dm = c.meta.get("docs") or []                                 # document starts, in characters of `raw`
    starts = [len(bytes(c.raw[:d["start"]]).decode("utf-8", "ignore")) for d in dm]
    names = [d["name"] for d in dm]
    docs = [names[bisect.bisect_right(starts, p) - 1] if starts and bisect.bisect_right(starts, p) else None for _, p in sents]
    _SPACE[key] = {"texts": [s for s, _ in sents], "bytes": texts, "c": cs, "emb": nrm, "anchors": anchors, "ca": ca, "mean": emb.mean(0), "docs": docs}
    while len(_SPACE) > 3:
        _SPACE.pop(next(iter(_SPACE)))
    return _SPACE[key]


def twins(c, passage, k=1, limit=25, method="exact"):
    """Each sentence of the passage, replaced by its nearest neighbour among the corpus's sentences in compression space."""
    import re
    t0 = time.time()
    S = _sentences(c)
    out = []
    for m in list(re.finditer(r"[^.!?\n]{12,400}[.!?]", passage))[:limit]:
        s = m.group(0).strip()
        b = s.encode("utf-8")
        cb = _C(b)
        if method == "exact":                                     # nearest by NCD itself (Jiang et al. 2023's gzip kNN)
            sim = -np.array([ncd(b, t, cb, S["c"][i]) for i, t in enumerate(S["bytes"])], np.float32)
        else:                                                     # nearest in the 64-anchor compression embedding
            v = np.array([ncd(b, a, cb, S["ca"][j]) for j, a in enumerate(S["anchors"])], np.float32) - S["mean"]
            v /= np.linalg.norm(v) + 1e-9
            sim = S["emb"] @ v
        order = np.argsort(-sim)
        got = []
        for i in order[:40]:                                      # skip the sentence itself and near-copies of it
            if S["texts"][i] == s or ncd(b, S["bytes"][i], cb, S["c"][i]) < 0.25:
                continue
            got.append(i)
            if len(got) >= k:
                break
        if not got:
            continue
        i = got[-1]
        out.append({"original": s, "twin": S["texts"][i], "similarity": round(float(sim[i]), 3),
                    "ncd": round(ncd(b, S["bytes"][i], cb, S["c"][i]), 3), "doc": S["docs"][i]})
    joined = " ".join(o["twin"] for o in out).encode("utf-8")
    orig = " ".join(o["original"] for o in out).encode("utf-8")
    return {"pairs": out, "sample": len(S["texts"]), "anchors": 64, "method": method, "ms": round((time.time() - t0) * 1000),
            "ratio_original": round(len(orig) / max(1, _C(orig)), 3), "ratio_twins": round(len(joined) / max(1, _C(joined)), 3),
            "ncd_whole": round(ncd(orig, joined), 3),
            "note": "Each sentence is placed in compression space by how well it compresses together with 64 anchor sentences "
                    "(normalized compression distance); its twin is the corpus sentence nearest to it there, skipping copies of itself."}


_PUNCT = set(".,;:!?)]}'\"”’")


def _join(words):
    s = ""
    for w in words:
        s += (w if (w and w[0] in _PUNCT) or not s else " " + w)
    return s


def guided(c, passage, n=80, window=12, mode="match", seed=0):
    """Write on from the passage's first words, choosing each next word among the words that really follow the context in
    the corpus, by its compression cost: delta = C(last N words + next) - C(last N words).
    mode match: approach the original's delta at the same step (its signature); mean: its average delta; min: cheapest."""
    import re
    rs = np.random.RandomState(seed)
    words = re.findall(r"\w[\w'’-]*|[^\w\s]", passage)
    if len(words) < window + 4:
        raise ValueError("the passage is too short")

    def delta(ctx, w):
        a = _join(ctx[-window:]).encode("utf-8")
        return _C(_join(ctx[-window:] + [w]).encode("utf-8")) - _C(a)
    sig = [delta(words[:i], words[i]) for i in range(window, min(len(words), window + n))]
    mean_sig = float(np.mean(sig))
    out = list(words[:window])
    trace, picks = [], []
    t0 = time.time()
    for step in range(n):
        cand = []
        for k in (6, 5, 4, 3, 2, 1):                              # what follows the longest ending of the text in the corpus
            q = _join(out[-k:])
            try:
                r = c.neighbours(q, "next", 30, False, True)
            except Exception:  # noqa: BLE001
                r = {"items": []}
            cand = [it["word"] for it in r.get("items", []) if it["word"].strip()]
            if len(cand) >= 3:
                break
        if not cand:
            break
        if mode == "fit":                                         # cost with the whole original passage as the dictionary
            base = (passage + " " + _join(out[window:])).encode("utf-8")
            cb0 = _C(base)
            ds = [_C(base + (b"" if w[0] in _PUNCT else b" ") + w.encode("utf-8")) - cb0 for w in cand]
        else:
            ds = [delta(out, w) for w in cand]
        target = sig[step] if mode == "match" and step < len(sig) else mean_sig if mode in ("match", "mean") else -1e9
        cost = [d if mode in ("min", "fit") else abs(d - target) for d in ds]
        best = sorted(range(len(cand)), key=lambda i: (cost[i], rs.rand()))[:3]   # a little chance among the closest three
        i = best[min(len(best) - 1, int(rs.rand() ** 2 * len(best)))]
        out.append(cand[i])
        trace.append(ds[i])
        picks.append({"w": cand[i], "delta": ds[i], "target": None if mode in ("min", "fit") else round(float(target), 2), "options": len(cand), "context": k})
    gen = _join(out[window:]).encode("utf-8")
    org = _join(words[window:window + len(trace)]).encode("utf-8")
    return {"start": _join(words[:window]), "text": _join(out[window:]), "picks": picks, "signature": sig[:len(trace)], "trace": trace,
            "mode": mode, "window": window, "ms": round((time.time() - t0) * 1000),
            "ratio_original": round(len(org) / max(1, _C(org)), 3), "ratio_generated": round(len(gen) / max(1, _C(gen)), 3),
            "mean_original": round(mean_sig, 2), "mean_generated": round(float(np.mean(trace)) if trace else 0, 2),
            "note": "delta = extra compressed bytes the next word costs after the last N words (zlib). Small = predictable here."}
