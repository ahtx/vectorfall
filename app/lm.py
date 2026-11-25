"""VectorFall LM: a corpus-grounded language model built from fast, alternative parts, all trained on the card.

  1. Interpolated modified Kneser-Ney n-grams (order 5 by default). Every n-gram type in the corpus is counted on the
     GPU by rolling 64-bit hashes + a radix sort, continuation counts come from the (n+1)-gram types, and lookups are
     binary searches over sorted tables, so a full next-word distribution costs well under a millisecond.
  2. A longest-suffix ("infini-gram") expert over contexts of up to 11 words, with a novelty knob that penalises
     long verbatim copies.
  3. A semantic cache: an exponentially decayed context vector of recent content-word embeddings (PPMI-SVD vectors
     from the Text Engine) that boosts on-topic words, plus an optional theme.
  4. A small neural LM (Bengio-style MLP: 6 words of context -> embeddings initialised from PPMI-SVD -> ReLU hidden ->
     softmax) trained on the card with hand-written forward/backward passes and Adam.
  5. A blend whose weights are tuned on one half of a held-out slice and reported on the other half, so every
     improvement is a measured perplexity, not a feeling.

Held-out text (every 50th 2,000-token chunk) is never counted or trained on. The vocabulary is capped (top 8,192
tokens by frequency, the rest -> <unk>); perplexities are over that closed space and coverage is reported.
"""
import json
import math
import os
import re
import threading
import time

import numpy as np
import cupy as cp
import cupyx
from fastapi import APIRouter, HTTPException

from . import engine, jobs
from . import textengine as te

router = APIRouter()

VCAP = 8192                 # capped vocabulary (top tokens by frequency) + <unk>
CHUNK, HOLD_EVERY = 2000, 50
SFX_MAX = 12                # n-gram tables up to this order feed the longest-suffix expert (context <= 11 words)
SFX_MIN = 4                 # the suffix expert speaks only once the matched context is at least this long
TMAX = 40_000_000           # tokens the LM will model (memory bound); bigger corpora use their first TMAX tokens
P = 1099511628211           # hash multiplier (64-bit wrap)
MASK = (1 << 64) - 1
_LOCK = threading.RLock()
_MODELS = {}                # (cid, version) -> Model
_TRAINING = {"job": None}


def _corpus():
    c = te.ACTIVE["c"]
    if not c or not getattr(c, "ready", False):
        raise HTTPException(400, "load a corpus in the Text Engine first")
    return c


def _lmdir(c):
    d = os.path.join(c.dir, "lm")
    os.makedirs(d, exist_ok=True)
    return d


def _ctxhash(seq):
    h = 0
    for x in seq:
        h = (h * P + int(x) + 1) & MASK
    return h


# ---------------------------------------------------------------- n-gram tables (counted on the card)
class Table:
    """All n-gram types of one order, grouped by context. Entries are sorted by (context rank, next word)."""
    __slots__ = ("k", "uctx", "start", "w", "cnt", "cont", "pos", "comb",
                 "tot_raw", "n_raw", "D_raw", "tot_cont", "n_cont", "D_cont")

    def lookup(self, h):
        r = int(np.searchsorted(self.uctx, np.uint64(h)))
        if r < self.uctx.size and int(self.uctx[r]) == h:
            return r
        return -1


def _discounts(counts):
    """Modified Kneser-Ney discounts D1, D2, D3+ from the count-of-counts."""
    c = counts[counts > 0]
    n1, n2, n3, n4 = [float((c == i).sum()) for i in (1, 2, 3, 4)]
    if n1 == 0 or n2 == 0:
        return np.array([0.0, 0.5, 0.75, 0.9])
    Y = n1 / (n1 + 2 * n2)
    D1 = 1 - 2 * Y * n2 / n1
    D2 = 2 - 3 * Y * n3 / n2 if n2 else 1.0
    D3 = 3 - 4 * Y * n4 / n3 if n3 else 1.5
    return np.array([0.0, max(0.05, min(D1, 0.99)), max(0.1, min(D2, 1.99)), max(0.2, min(D3, 2.99))])


def _ctx_stats(rank, counts, U):
    tot = np.bincount(rank, weights=counts, minlength=U)
    n = np.stack([np.bincount(rank, weights=(counts == 1), minlength=U),
                  np.bincount(rank, weights=(counts == 2), minlength=U),
                  np.bincount(rank, weights=(counts >= 3), minlength=U)], 1)
    return tot, n


def _count_tables(train, maxord, job=None):
    """GPU: rolling hashes for every order, radix-sorted, run-length counted. Returns host arrays per order."""
    out = {}

    def hashes():
        t = cp.asarray(train.astype(np.uint64)) + cp.uint64(1)
        hs = [t]
        for k in range(2, maxord + 1):
            hn = cp.zeros_like(t)
            hn[1:] = hs[-1][:-1] * cp.uint64(P) + t[1:]
            hs.append(hn)
        return hs
    st = {}

    def prep():
        st["hs"] = hashes()
        st["t"] = cp.asarray(train.astype(np.int32))
        return True
    engine.run_on_gpu(prep, "LM: hashing n-grams", 120)

    def one(k):
        hs, t = st["hs"], st["t"]
        keys = hs[k - 1][k - 1:]
        o = cp.argsort(keys)
        ks = keys[o]
        flag = cp.concatenate([cp.ones(1, cp.bool_), ks[1:] != ks[:-1]])
        starts = cp.flatnonzero(flag)
        cnt = cp.diff(cp.concatenate([starts, cp.asarray([ks.size])]))
        first = o[starts] + (k - 1)
        ukey = ks[starts]
        ctx = hs[k - 2][first - 1] if k > 1 else cp.zeros(first.size, cp.uint64)
        w = t[first]
        res = {"key": cp.asnumpy(ukey), "ctx": cp.asnumpy(ctx), "w": cp.asnumpy(w).astype(np.int32),
               "cnt": cp.asnumpy(cnt).astype(np.int32), "pos": cp.asnumpy(first).astype(np.int64)}
        if k > 1:                                # suffix key of each k-gram type = its last (k-1) tokens
            res["suf"] = cp.asnumpy(hs[k - 2][first])
        del keys, o, ks, flag, starts, cnt, first, ukey, ctx, w
        return res
    for k in range(1, maxord + 1):
        out[k] = engine.run_on_gpu(lambda k=k: one(k), "LM: count the {}-grams".format(k), 120)
        if job:
            job.step(0.05 + 0.45 * k / maxord, "counted {}-grams: {:,} types".format(k, out[k]["key"].size))

    def free():
        st.clear()
        cp.get_default_memory_pool().free_all_blocks()
    engine.run_on_gpu(free, "LM: free", 60)
    return out


def _make_table(k, raw, cont, Vn, need_comb):
    tb = Table()
    tb.k = k
    uctx, rank = np.unique(raw["ctx"], return_inverse=True)
    U = uctx.size
    comb = rank.astype(np.int64) * (Vn + 1) + raw["w"]
    o = np.argsort(comb, kind="stable")
    rank = rank[o]
    tb.uctx = uctx
    tb.start = np.concatenate([[0], np.cumsum(np.bincount(rank, minlength=U))]).astype(np.int64)
    tb.w = raw["w"][o]
    tb.cnt = raw["cnt"][o]
    tb.pos = raw["pos"][o]
    tb.comb = comb[o] if need_comb else None
    tb.tot_raw, tb.n_raw = _ctx_stats(rank, tb.cnt.astype(np.float64), U)
    tb.D_raw = _discounts(tb.cnt)
    if cont is not None:
        tb.cont = cont[o]
        tb.tot_cont, tb.n_cont = _ctx_stats(rank, tb.cont.astype(np.float64), U)
        tb.D_cont = _discounts(tb.cont)
    else:
        tb.cont = tb.tot_cont = tb.n_cont = tb.D_cont = None
    return tb


# ---------------------------------------------------------------- the model
class Model:
    def __init__(self):
        self.mlp = None             # host numpy weights for generation
        self.mlp_info = None
        self.mix = {"kn": 1.0, "mlp": 0.0, "sfx": 0.0, "beta": 0.0}
        self.ev = {"unigram": None, "bigram": None, "kn": None, "kn_cache": None, "kn_sfx": None, "mlp": None,
                   "hybrid": None, "kn_full_heldout": None, "eval_tokens": 0}
        self.emb_sig = None

    # -- build --------------------------------------------------------------------------------------------
    def build(self, c, order=5, job=None):
        t0 = time.time()
        self.cid, self.version, self.order = c.id, c.version, int(order)
        T = min(c.T, TMAX)
        g = c.gids_at(np.arange(T))
        counts = np.bincount(g[g >= 0], minlength=c.V)
        top = np.argsort(-counts, kind="stable")[:VCAP]
        top = top[counts[top] > 0]
        self.gid = top.astype(np.int64)                         # lm id -> corpus vocab id
        self.Vn = int(top.size)                                 # real words; UNK = Vn
        self.UNK = self.Vn
        lut = np.full(c.V, self.UNK, np.int32)
        lut[top] = np.arange(self.Vn, dtype=np.int32)
        self.lut = lut
        self.words = [c.word(int(x)) for x in top]
        toks = np.where(g >= 0, lut[np.maximum(g, 0)], self.UNK).astype(np.int32)
        self.coverage = float(counts[top].sum() / max(1, counts.sum()))
        hold = ((np.arange(T) // CHUNK) % HOLD_EVERY) == (HOLD_EVERY // 2)
        if not hold.any():
            hold[-max(50, T // 50):] = True
        self.train_pos = np.flatnonzero(~hold)
        self.held_pos = np.flatnonzero(hold)
        self.train = toks[self.train_pos]
        self.held = toks[self.held_pos]
        self.punct = np.array([w in ("\n\n",) or (len(w) == 1 and w in ".,!?;:\"()-") for w in self.words] + [False])
        if job:
            job.step(0.03, "vocabulary: {:,} tokens cover {:.1%}".format(self.Vn, self.coverage))
        maxord = max(SFX_MAX, self.order + 1)
        raw = _count_tables(self.train, maxord, job)
        self.tab = {}
        for k in range(1, maxord + 1):
            cont = None
            if k < maxord and k <= self.order:            # continuation counts: distinct left extensions
                ukey = raw[k]["key"]
                suf = raw[k + 1]["suf"]
                us, sc = np.unique(suf, return_counts=True)
                idx = np.searchsorted(ukey, us)
                ok = (idx < ukey.size)
                ok[ok] = ukey[idx[ok]] == us[ok]
                cont = np.zeros(ukey.size, np.int32)
                cont[idx[ok]] = sc[ok]
            self.tab[k] = _make_table(k, raw[k], cont, self.Vn, need_comb=k <= self.order)
            raw[k].pop("suf", None)
            if job:
                job.step(0.5 + 0.3 * k / maxord, "indexed {}-grams".format(k))
        del raw
        # unigram: continuation-count KN with a uniform floor
        t1 = self.tab[1]
        cont1 = np.zeros(self.Vn + 1)
        cont1[t1.w] = t1.cont
        D = t1.D_cont
        tot = cont1.sum()
        disc = D[np.minimum(cont1, 3).astype(int)]
        gamma = (D[1] * (cont1 == 1).sum() + D[2] * (cont1 == 2).sum() + D[3] * (cont1 >= 3).sum()) / tot
        self.p1 = np.maximum(cont1 - disc, 0) / tot + gamma / (self.Vn + 1)
        raw1 = np.zeros(self.Vn + 1)
        raw1[t1.w] = t1.cnt
        self.p_uni = (raw1 + 0.5) / (raw1.sum() + 0.5 * (self.Vn + 1))
        self.built_secs = round(time.time() - t0, 2)
        self.n_types = {k: int(self.tab[k].w.size) for k in self.tab}
        return self

    # -- distributions ------------------------------------------------------------------------------------
    def kn_dist(self, hist, order=None):
        N = order or self.order
        p = self.p1.copy()
        for k in range(2, N + 1):
            if len(hist) < k - 1:
                break
            tb = self.tab[k]
            r = tb.lookup(_ctxhash(hist[-(k - 1):]))
            if r < 0:
                continue
            s, e = tb.start[r], tb.start[r + 1]
            top = k == N
            cnts = tb.cnt[s:e] if top else tb.cont[s:e]
            tot = tb.tot_raw[r] if top else tb.tot_cont[r]
            if tot <= 0:
                continue
            nn = tb.n_raw[r] if top else tb.n_cont[r]
            D = tb.D_raw if top else tb.D_cont
            gamma = (D[1] * nn[0] + D[2] * nn[1] + D[3] * nn[2]) / tot
            p *= gamma
            p[tb.w[s:e]] += np.maximum(cnts - D[np.minimum(cnts, 3)], 0) / tot   # words are unique per context
        return p

    def longest(self, hist):
        """(context length, table, rank) of the longest suffix of hist seen in training."""
        for k in range(min(SFX_MAX, len(hist) + 1), 1, -1):
            tb = self.tab[k]
            r = tb.lookup(_ctxhash(hist[-(k - 1):]))
            if r >= 0:
                return k - 1, tb, r
        return 0, None, -1

    def sfx_dist(self, tb, r):
        s, e = tb.start[r], tb.start[r + 1]
        p = np.zeros(self.Vn + 1)
        p[tb.w[s:e]] = tb.cnt[s:e]
        return p / max(1.0, p.sum())

    def mlp_dist(self, hist):
        W = self.mlp
        k = W["ctx"]
        ctx = list(hist[-k:])
        ctx = [self.Vn + 1] * (k - len(ctx)) + ctx
        x = W["E"][ctx].reshape(1, -1)
        h = np.maximum(x @ W["W1"] + W["b1"], 0)
        return _mlp_full(W, h, self.Vn + 1, np)[0].astype(np.float64)

    # -- vectorised KN log-probabilities for evaluation ---------------------------------------------------
    def kn_logprob(self, seq, idxs, N):
        y = seq[idxs]
        p = self.p1[y].copy()
        tt = seq.astype(np.uint64) + np.uint64(1)
        H = [None, tt]                                  # H[L][i] = hash of the L tokens ending at i
        with np.errstate(over="ignore"):
            for L in range(2, N):
                hn = np.zeros_like(tt)
                hn[1:] = H[L - 1][:-1] * np.uint64(P) + tt[1:]
                H.append(hn)
        for k in range(2, N + 1):
            L = k - 1
            ci = idxs - 1
            valid = ci >= L - 1
            ctx = H[L][np.maximum(ci, 0)]
            tb = self.tab[k]
            r = np.searchsorted(tb.uctx, ctx)
            rr = np.minimum(r, tb.uctx.size - 1)
            found = valid & (r < tb.uctx.size) & (tb.uctx[rr] == ctx)
            if not found.any():
                continue
            top = k == N
            comb = rr.astype(np.int64) * (self.Vn + 1) + y
            j = np.searchsorted(tb.comb, comb)
            jj = np.minimum(j, tb.comb.size - 1)
            hit = found & (j < tb.comb.size) & (tb.comb[jj] == comb)
            src = tb.cnt if top else tb.cont
            cval = np.where(hit, src[jj], 0).astype(np.float64)
            tot = (tb.tot_raw if top else tb.tot_cont)[rr]
            nn = (tb.n_raw if top else tb.n_cont)[rr]
            D = tb.D_raw if top else tb.D_cont
            gamma = (D[1] * nn[:, 0] + D[2] * nn[:, 1] + D[3] * nn[:, 2]) / np.maximum(tot, 1e-12)
            pk = np.maximum(cval - D[np.minimum(cval, 3).astype(int)], 0) / np.maximum(tot, 1e-12) + gamma * p
            ok = found & (tot > 0)
            p = np.where(ok, pk, p)
        return np.log(np.maximum(p, 1e-12))

    # -- embeddings (semantic cache) ----------------------------------------------------------------------
    def embeddings(self, c):
        try:
            _, words, idx, emb = c._embeddings()
            rows = c._gid_row
        except Exception:  # noqa: BLE001
            return None
        if rows is None:
            return None
        r = rows[self.gid]
        E = np.zeros((self.Vn + 1, emb.shape[1]), np.float32)
        has = r >= 0
        E[:self.Vn][has] = emb[r[has]]
        self.Eemb = E
        self.emb_idx = idx
        self.emb_full = emb
        return E


# ---------------------------------------------------------------- neural LM (trained on the card)
_K = {}


def _kernels():
    """Fused element-wise kernels: one launch per parameter for Adam, an in-place softmax/cross-entropy."""
    if not _K:
        _K["adam"] = cp.ElementwiseKernel(
            "T g, T lr, T b1, T b2, T c1, T c2", "T p, T m, T v",
            """T gg = g > (T)1 ? (T)1 : (g < (T)-1 ? (T)-1 : g);
               m = b1 * m + ((T)1 - b1) * gg; v = b2 * v + ((T)1 - b2) * gg * gg;
               p -= lr * (m / c1) / (sqrt(v / c2) + (T)1e-8);""", "vf_lm_adam")
        _K["expsub"] = cp.ElementwiseKernel("T z, T m", "T y", "y = exp(z - m)", "vf_lm_expsub")
        _K["scale"] = cp.ElementwiseKernel("T z, T s, T k", "T y", "y = z / s * k", "vf_lm_scale")
        _K["relu_b"] = cp.ElementwiseKernel("T a, T b", "T y", "y = max(a + b, (T)0)", "vf_lm_relu_b")
        _K["drelu"] = cp.ElementwiseKernel("T g, T h", "T y", "y = h > (T)0 ? g : (T)0", "vf_lm_drelu")
    return _K

def _classes(V_out):
    """Frequency-ranked words in equal blocks: class = id // M, slot = id % M (lm ids are already frequency-ranked)."""
    M = int(math.ceil(math.sqrt(V_out)))
    C = int(math.ceil(V_out / float(M)))
    mask = np.zeros((C, M), np.float32)
    mask.ravel()[V_out:] = -1e9                    # padding slots never get probability
    return C, M, mask


def _train_mlp(m, epochs=2, hidden=384, ctxn=6, minutes=4.0, job=None, E0=None):
    """Bengio-style MLP LM with a class-factored softmax: P(w) = P(class(w)) * P(w | class(w)).
    The output layer costs ~2*sqrt(V) logits per token instead of V, so training is GEMM-light and fast."""
    Vn = m.Vn
    V_out = Vn + 1                                   # words + <unk> as a target
    V_in = Vn + 2                                    # + <pad> for missing context
    d = 64
    C, M, mask = _classes(V_out)
    free = engine.budget_bytes(150)
    B = 1024 if free > 700 << 20 else (512 if free > 360 << 20 else 256)
    rs = np.random.RandomState(5)
    E = (rs.standard_normal((V_in, d)) * 0.1).astype(np.float32)
    if E0 is not None:
        has = np.abs(E0).sum(1) > 0
        E[:Vn + 1][has] = E0[has]
    W1 = (rs.standard_normal((ctxn * d, hidden)) * math.sqrt(2.0 / (ctxn * d))).astype(np.float32)
    Wc = (rs.standard_normal((hidden, C)) * math.sqrt(1.0 / hidden)).astype(np.float32)
    Ww = (rs.standard_normal((C, M, hidden)) * math.sqrt(1.0 / hidden)).astype(np.float32)
    pu = np.zeros(C * M)
    pu[:V_out] = m.p_uni
    pcls = pu.reshape(C, M).sum(1)
    bc = np.log(np.maximum(pcls, 1e-9)).astype(np.float32)
    bw = (np.log(np.maximum(pu.reshape(C, M), 1e-12)) - np.log(np.maximum(pcls, 1e-12))[:, None]).astype(np.float32)
    bw = np.where(mask < 0, -30.0, bw).astype(np.float32)
    S = {}
    n = m.train.size
    steps_per_epoch = n // B
    total_steps = steps_per_epoch * epochs
    deadline = time.time() + minutes * 60

    def init():
        S["tr"] = cp.asarray(m.train)
        S["held"] = cp.asarray(m.held)
        S["p"] = {"E": cp.asarray(E), "W1": cp.asarray(W1), "b1": cp.zeros(hidden, cp.float32), "Wc": cp.asarray(Wc),
                  "bc": cp.asarray(bc), "Ww": cp.asarray(Ww), "bw": cp.asarray(bw)}
        S["mask"] = cp.asarray(mask)
        S["m"] = {k: cp.zeros_like(v) for k, v in S["p"].items()}
        S["v"] = {k: cp.zeros_like(v) for k, v in S["p"].items()}
        S["ar"] = cp.arange(ctxn, dtype=cp.int64)
        S["Pd"] = cp.zeros((B, C * M), cp.float32)          # dense class-block gradient scratch
        S["slot"] = cp.arange(M, dtype=cp.int64)[None, :]
        S["ev"] = [cp.cuda.Event(block=True, disable_timing=True) for _ in range(2)]
        S["t"] = 0
        return True
    engine.run_on_gpu(init, "LM: init neural net", 60)

    def ctx_of(seq, pos):
        offs = pos[:, None] - ctxn + S["ar"][None, :]
        return cp.where(offs >= 0, seq[cp.maximum(offs, 0)], Vn + 1)

    def hidden_of(p, X):
        K = _kernels()
        x = p["E"][X].reshape(X.shape[0], ctxn * d)
        return x, K["relu_b"](x @ p["W1"], p["b1"])

    def softmax_rows(z):
        K = _kernels()
        mx = z.max(1, keepdims=True)
        K["expsub"](z, mx, z)
        z /= z.sum(1, keepdims=True)
        return z

    def steps(perm, s0, nb, lr0):
        K = _kernels()
        p, mm, vv = S["p"], S["m"], S["v"]
        b1_, b2_ = 0.9, 0.999
        loss_acc = cp.zeros((), cp.float32)
        cnt = 0
        ar = cp.arange(B)
        invB = cp.float32(1.0 / B)
        for b in range(nb):
            sl = perm[s0 + b * B: s0 + (b + 1) * B]
            if sl.size < B:
                break
            X = ctx_of(S["tr"], sl)
            y = S["tr"][sl].astype(cp.int64)
            cy, iy = y // M, y % M
            x, h = hidden_of(p, X)
            pc = softmax_rows(h @ p["Wc"] + p["bc"])
            Wsel = p["Ww"][cy]                                  # (B, M, H): the target class's word vectors
            zw = cp.matmul(Wsel, h[:, :, None])[:, :, 0] + p["bw"][cy] + S["mask"][cy]
            pw = softmax_rows(zw)
            loss_acc += -(cp.log(cp.maximum(pc[ar, cy], 1e-12)) + cp.log(cp.maximum(pw[ar, iy], 1e-12))).mean()
            pc[ar, cy] -= 1.0
            pc *= invB
            pw[ar, iy] -= 1.0
            pw *= invB
            g = {"Wc": h.T @ pc, "bc": pc.sum(0)}
            Pd = S["Pd"]                                        # no atomics: place each row's class block, then
            Pd.fill(0)                                          # one GEMM gives every class's weight gradient
            Pd[ar[:, None], cy[:, None] * M + S["slot"]] = pw
            g["Ww"] = (Pd.T @ h).reshape(C, M, -1)
            g["bw"] = Pd.sum(0).reshape(C, M)
            dh = pc @ p["Wc"].T + cp.matmul(pw[:, None, :], Wsel)[:, 0, :]
            da1 = K["drelu"](dh, h)
            g["W1"] = x.T @ da1
            g["b1"] = da1.sum(0)
            gE = cp.zeros_like(p["E"])
            cupyx.scatter_add(gE, X.reshape(-1), (da1 @ p["W1"].T).reshape(B * ctxn, d))
            g["E"] = gE
            S["t"] += 1
            t = S["t"]
            lr = lr0 * max(0.15, 1.0 - t / max(1, total_steps))
            c1, c2 = 1 - b1_ ** t, 1 - b2_ ** t
            for k in p:
                K["adam"](g[k], cp.float32(lr), cp.float32(b1_), cp.float32(b2_), cp.float32(c1), cp.float32(c2),
                          p[k], mm[k], vv[k])
            cnt += 1
            # keep one step queued on the card and SLEEP until the previous one finishes (blocking-sync event):
            # the host thread never spins, so a 2-core host stays free while the GPU trains
            ev = S["ev"][b % 2]
            ev.record()
            S["ev"][(b + 1) % 2].synchronize()
        for e in S["ev"]:
            e.synchronize()
        return float(loss_acc), cnt

    def full_logp(p, X, targets):
        _, h = hidden_of(p, X)
        pc = softmax_rows(h @ p["Wc"] + p["bc"])
        cy, iy = targets // M, targets % M
        Wsel = p["Ww"][cy]
        pw = softmax_rows(cp.matmul(Wsel, h[:, :, None])[:, :, 0] + p["bw"][cy] + S["mask"][cy])
        ar = cp.arange(targets.size)
        return cp.log(cp.maximum(pc[ar, cy] * pw[ar, iy], 1e-12))

    def held_ppl():
        p = S["p"]
        seq = S["held"]
        nll, nt = 0.0, 0
        for a in range(1, seq.size, 1024):
            pos = cp.arange(a, min(seq.size, a + 1024), dtype=cp.int64)
            lp = full_logp(p, ctx_of(seq, pos), seq[pos].astype(cp.int64)).sum()
            e = S["ev"][0]
            e.record()
            e.synchronize()
            nll -= float(lp)
            nt += int(pos.size)
        return math.exp(nll / max(1, nt))

    hist = []
    t0 = time.time()
    seen = 0
    stopped = False
    for ep in range(epochs):
        perm = engine.run_on_gpu(lambda: cp.random.permutation(n).astype(cp.int64), "LM: shuffle", 60)
        nb_chunk = 40
        el = 0.0
        for s0 in range(0, steps_per_epoch * B, nb_chunk * B):
            tl, cnt = engine.run_on_gpu(lambda s0=s0: steps(perm, s0, nb_chunk, 2e-3), "LM: training", 120)
            seen += cnt * B
            el = tl / max(1, cnt)
            if job:
                frac = (ep * steps_per_epoch * B + s0 + nb_chunk * B) / float(max(1, epochs * steps_per_epoch * B))
                job.step(0.02 + 0.85 * min(1.0, frac), "epoch {}/{} · loss {:.3f} · {:,.0f} tok/s".format(
                    ep + 1, epochs, el, seen / max(1e-6, time.time() - t0)))
            if time.time() > deadline:
                stopped = True
                break
        ppl = engine.run_on_gpu(held_ppl, "LM: held-out perplexity", 120)
        hist.append({"epoch": ep + 1, "loss": round(el, 4), "heldout_ppl": round(ppl, 2)})
        if job:
            job.step(0.02 + 0.85 * (ep + 1) / epochs, "epoch {} held-out perplexity {:.1f}".format(ep + 1, ppl))
        if stopped:
            break

    def export():
        out = {k: cp.asnumpy(v) for k, v in S["p"].items()}
        S.clear()
        cp.get_default_memory_pool().free_all_blocks()
        return out
    W = engine.run_on_gpu(export, "LM: export", 60)
    secs = time.time() - t0
    W["ctx"] = ctxn
    W["M"] = M
    info = {"epochs": len(hist), "history": hist, "hidden": hidden, "ctx": ctxn, "dim": d, "batch": B,
            "softmax": "class-factored {} x {}".format(C, M),
            "train_secs": round(secs, 1), "tokens_per_s": round(seen / max(1e-6, secs)), "stopped_early": stopped,
            "params": int(sum(v.size for k, v in W.items() if k not in ("ctx", "M")))}
    return W, info


def _attach_pad(m):
    C, M = m.mlp["Ww"].shape[0], m.mlp["Ww"].shape[1]
    flat = np.arange(m.Vn + 1, C * M)
    m.mlp["_pad"] = (flat // M, flat % M)


def _mlp_full(W, h, V_out, xp):
    """Full next-word distribution(s) from hidden state(s) h (B, H) under the class-factored softmax."""
    C, M = W["Ww"].shape[0], W["Ww"].shape[1]
    zc = h @ W["Wc"] + W["bc"]
    zc = zc - zc.max(1, keepdims=True)
    pc = xp.exp(zc)
    pc /= pc.sum(1, keepdims=True)
    zw = (h @ W["Ww"].reshape(C * M, -1).T).reshape(h.shape[0], C, M) + W["bw"][None]
    if W["_pad"][0].size:
        zw[:, W["_pad"][0], W["_pad"][1]] = -1e9
    zw = zw - zw.max(2, keepdims=True)
    pw = xp.exp(zw)
    pw /= pw.sum(2, keepdims=True)
    return (pc[:, :, None] * pw).reshape(h.shape[0], C * M)[:, :V_out]


def _mlp_dense(m, seq, idxs):
    """Batched neural-LM distributions on the card for evaluation."""
    W = m.mlp
    k = W["ctx"]

    def job():
        G = {n: cp.asarray(W[n]) for n in ("E", "W1", "b1", "Wc", "bc", "Ww", "bw")}
        G["_pad"] = (cp.asarray(W["_pad"][0]), cp.asarray(W["_pad"][1]))
        s = cp.asarray(seq)
        out = []
        for a in range(0, idxs.size, 256):
            pos = cp.asarray(idxs[a:a + 256].astype(np.int64))
            offs = pos[:, None] - k + cp.arange(k)[None, :]
            X = cp.where(offs >= 0, s[cp.maximum(offs, 0)], m.Vn + 1)
            x = G["E"][X].reshape(X.shape[0], -1)
            h = cp.maximum(x @ G["W1"] + G["b1"], 0)
            out.append(cp.asnumpy(_mlp_full(G, h, m.Vn + 1, cp)))
        return np.concatenate(out)
    return engine.run_on_gpu(job, "LM: neural eval", 120)


# ---------------------------------------------------------------- evaluation & blend tuning
BETAS = [0.0, 0.5, 1.0, 2.0, 3.0, 4.0]


def _evaluate(m, c, job=None):
    t0 = time.time()
    held = m.held
    W = 300
    nwin = int(min(16, max(2, held.size // W)))       # 8 tuning + 8 test windows of 300 words
    starts = np.linspace(0, max(0, held.size - W), nwin).astype(int)
    E = m.embeddings(c)
    stats = {"tune": [], "test": []}
    for wi, s0 in enumerate(starts):
        idxs = np.arange(s0 + 1, min(held.size, s0 + W))
        if not idxs.size:
            continue
        y = held[idxs]
        kn = np.stack([m.kn_dist(list(held[max(0, i - m.order + 1):i])) for i in idxs])
        sfx = np.zeros_like(kn)
        has_sfx = np.zeros(idxs.size, bool)
        for j, i in enumerate(idxs):
            L, tb, r = m.longest(list(held[max(0, i - SFX_MAX + 1):i]))
            if L >= SFX_MIN:
                sfx[j] = m.sfx_dist(tb, r)
                has_sfx[j] = True
        mlp = _mlp_dense(m, held, idxs) if m.mlp is not None else None
        if E is not None:
            v = np.zeros(E.shape[1], np.float32)
            cos = np.zeros((idxs.size, m.Vn + 1), np.float32)
            prev = s0
            for j, i in enumerate(idxs):
                for t in range(prev, i):              # absorb tokens before position i into the cache
                    v = 0.9 * v + E[held[t]]
                prev = i
                nv = np.linalg.norm(v)
                if nv > 0:
                    cos[j] = E @ (v / nv)
        else:
            cos = np.zeros((idxs.size, m.Vn + 1), np.float32)
        rec = {"y_kn": kn[np.arange(idxs.size), y], "y_sfx": sfx[np.arange(idxs.size), y], "has_sfx": has_sfx,
               "y_cos": cos[np.arange(idxs.size), y],
               "y_mlp": mlp[np.arange(idxs.size), y] if mlp is not None else None,
               "S_kn": [], "S_sfx": [], "S_mlp": []}
        for b in BETAS:
            boost = np.exp(b * cos)
            rec["S_kn"].append((kn * boost).sum(1))
            rec["S_sfx"].append((sfx * boost).sum(1))
            if mlp is not None:
                rec["S_mlp"].append((mlp * boost).sum(1))
        rec["uni"] = np.log(m.p_uni[y])
        rec["bi"] = m.kn_logprob(held, idxs, 2)
        rec["knlp"] = m.kn_logprob(held, idxs, m.order)
        stats["tune" if wi % 2 == 0 else "test"].append(rec)
        if job:
            job.step(0.88 + 0.1 * (wi + 1) / nwin, "evaluate on held-out window {}/{}".format(wi + 1, nwin))

    def cat(part, key, bi=None):
        recs = stats[part]
        if bi is None:
            return np.concatenate([r[key] for r in recs]) if recs and recs[0][key] is not None else None
        return np.concatenate([r[key][bi] for r in recs]) if recs and len(recs[0][key]) else None

    def nll(part, a, b, cw, bi):
        ykn, ysfx, ymlp = cat(part, "y_kn"), cat(part, "y_sfx"), cat(part, "y_mlp")
        has = cat(part, "has_sfx")
        ycos = cat(part, "y_cos")
        Skn, Ssfx, Smlp = cat(part, "S_kn", bi), cat(part, "S_sfx", bi), cat(part, "S_mlp", bi)
        cw_eff = np.where(has, cw, 0.0)
        tot = a + b + cw_eff
        num = a * ykn + (b * ymlp if ymlp is not None else 0) + cw_eff * ysfx
        den = a * Skn + (b * Smlp if Smlp is not None else 0) + cw_eff * Ssfx
        pr = (num / tot) * np.exp(BETAS[bi] * ycos) / np.maximum(den / tot, 1e-12)
        return float(-np.log(np.maximum(pr, 1e-12)).mean())

    def best(allow_mlp, allow_sfx, allow_beta):
        bestv, arg = 1e9, None
        grid = np.round(np.arange(0, 1.0001, 0.1), 2)
        for b in (grid if allow_mlp else [0.0]):
            for cw in (grid if allow_sfx else [0.0]):
                a = 1.0 - b - cw
                if a < -1e-9 or a + b <= 1e-9:          # the suffix expert alone can't cover every position
                    continue
                for bi in (range(len(BETAS)) if allow_beta else [0]):
                    v = nll("tune", max(a, 0.0), b, cw, bi)
                    if v < bestv:
                        bestv, arg = v, (max(a, 0.0), b, cw, bi)
        return arg
    ev = {}
    ev["unigram"] = math.exp(-cat("test", "uni").mean())
    ev["bigram"] = math.exp(-cat("test", "bi").mean())
    ev["kn"] = math.exp(-cat("test", "knlp").mean())
    a, b, cw, bi = best(False, False, True)
    ev["kn_cache"] = math.exp(nll("test", a, b, cw, bi))
    ev["kn_cache_beta"] = BETAS[bi]
    a, b, cw, bi = best(False, True, False)
    ev["kn_sfx"] = math.exp(nll("test", a, b, cw, bi))
    if m.mlp is not None:
        ev["mlp"] = math.exp(nll("test", 0.0, 1.0, 0.0, 0))
    else:
        ev["mlp"] = None
    a, b, cw, bi = best(m.mlp is not None, True, True)
    ev["hybrid"] = math.exp(nll("test", a, b, cw, bi))
    m.mix = {"kn": round(a, 2), "mlp": round(b, 2), "sfx": round(cw, 2), "beta": BETAS[bi]}
    ev["eval_tokens"] = int(sum(r["y_kn"].size for r in stats["test"]))
    ev["tune_tokens"] = int(sum(r["y_kn"].size for r in stats["tune"]))
    full = np.arange(1, held.size)
    ev["kn_full_heldout"] = math.exp(-m.kn_logprob(held, full, m.order).mean())
    ev["heldout_tokens"] = int(held.size)
    ev = {k: (round(v, 2) if isinstance(v, float) else v) for k, v in ev.items()}
    ev["secs"] = round(time.time() - t0, 1)
    m.ev = ev
    return ev


# ---------------------------------------------------------------- persistence & lifecycle
def _paths(c):
    d = _lmdir(c)
    return os.path.join(d, "mlp-v{}.npz".format(c.version)), os.path.join(d, "meta-v{}.json".format(c.version))


def _save_meta(c, m):
    _, mp = _paths(c)
    with open(mp, "w") as f:
        json.dump({"ev": m.ev, "mix": m.mix, "mlp_info": m.mlp_info, "order": m.order, "built_secs": m.built_secs,
                   "vocab": m.Vn, "coverage": m.coverage}, f)


SAMPLE_LM = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sample_data", "lm")


def _vocab_sig(m):
    import hashlib
    return hashlib.sha256("|".join(m.words).encode("utf-8", "replace")).hexdigest()


def _sample_weights(c, m):
    """A shipped sample corpus (meta "sample") can use the neural LM trained for it before release, so VectorLM
    works at once on a fresh install. Used only when the vocabulary is exactly the one it was trained on."""
    key = c.meta.get("sample")
    if not key or c.version != 0:
        return None
    d = os.path.join(SAMPLE_LM, key)
    try:
        with open(os.path.join(d, "vocab.json")) as f:
            if json.load(f).get("sig") != _vocab_sig(m):
                return None
        return os.path.join(d, "mlp.npz"), os.path.join(d, "meta.json")
    except (OSError, ValueError):
        return None


def _load_saved(c, m):
    wp, mp = _paths(c)
    if not os.path.exists(wp):
        sw = _sample_weights(c, m)
        if sw:                                    # the shipped weights; this corpus's own evaluation wins if it has one
            wp = sw[0]
            mp = mp if os.path.exists(mp) else sw[1]
    if os.path.exists(wp):
        z = np.load(wp)
        if "Ww" in z.files:                       # older full-softmax weights are ignored
            m.mlp = {k: z[k] for k in z.files if k not in ("ctx", "M")}
            m.mlp["ctx"] = int(z["ctx"])
            _attach_pad(m)
    if os.path.exists(mp):
        try:
            with open(mp) as f:
                meta = json.load(f)
            if meta.get("order") == m.order:
                m.ev.update(meta.get("ev") or {})
                m.mix = meta.get("mix") or m.mix
            m.mlp_info = meta.get("mlp_info")
        except Exception:  # noqa: BLE001
            pass


def get_model(c, order=None, job=None, evaluate=False):
    key = (c.id, c.version)
    with _LOCK:
        m = _MODELS.get(key)
        if m is not None and (order is None or m.order == order):
            return m, 0.0
        t0 = time.time()
        m = Model().build(c, order or 5, job)
        _load_saved(c, m)
        if evaluate or m.ev.get("kn") is None:
            if job:
                job.step(0.86, "evaluate on held-out text")
            _evaluate(m, c, job)
            _save_meta(c, m)
        for k in [k for k in _MODELS if k[0] == c.id]:
            _MODELS.pop(k, None)
        _MODELS[key] = m
        return m, time.time() - t0


def _status(c):
    m = _MODELS.get((c.id, c.version))
    wp, mp = _paths(c)
    meta = {}
    if os.path.exists(mp):
        try:
            with open(mp) as f:
                meta = json.load(f)
        except Exception:  # noqa: BLE001
            meta = {}
    tj = _TRAINING["job"]
    training = tj.info() if tj is not None and tj.state == "running" else None
    info = (m.mlp_info if m else None) or meta.get("mlp_info") or {}
    ev = (m.ev if m else None) or meta.get("ev") or {}
    model = {"built": m is not None, "vocab": m.Vn if m else meta.get("vocab"),
             "coverage": round(m.coverage, 4) if m else meta.get("coverage"),
             "order": m.order if m else meta.get("order"), "suffix_max_context": SFX_MAX - 1,
             "ngram_types": m.n_types if m else None,
             "params": info.get("params"), "epochs": info.get("epochs"), "train_secs": info.get("train_secs"),
             "train_tokens_per_s": info.get("tokens_per_s"), "history": info.get("history"),
             "built_secs": m.built_secs if m else meta.get("built_secs"),
             "mix": (m.mix if m else meta.get("mix"))}
    keys = ("unigram", "bigram", "kn", "kn_cache", "kn_sfx", "mlp", "hybrid")
    return {"trained": os.path.exists(wp) or bool(m is not None and m.mlp is not None), "training": training, "model": model,
            "eval": {k: ev.get(k) for k in keys},
            "eval_detail": {k: ev.get(k) for k in ("kn_full_heldout", "heldout_tokens", "eval_tokens", "tune_tokens",
                                                   "kn_cache_beta", "secs")}}


# ---------------------------------------------------------------- endpoints
# The work behind the endpoints; the registered models (app/models/text.py) call these, and so do the endpoints.
def build_job(c, order, j):
    with _LOCK:
        _MODELS.pop((c.id, c.version), None)
    get_model(c, order, j, evaluate=True)
    return _status(c)


def train_job(c, epochs, hidden, ctxn, minutes, j):
    t = _TRAINING["job"]
    if t is not None and t is not j and getattr(t, "state", None) == "running":
        from .registry import Refused
        raise Refused("a training run is already in progress", 409)
    if getattr(j, "state", None) is not None:
        _TRAINING["job"] = j
    m, _ = get_model(c, None, j)
    E0 = m.embeddings(c)
    j.step(0.02, "training the neural LM on the card")
    W, info = _train_mlp(m, epochs, hidden, ctxn, minutes, j, E0)
    wp, _ = _paths(c)
    np.savez(wp, **W)
    with open(os.path.join(_lmdir(c), "vocab-v{}.json".format(c.version)), "w") as f:
        json.dump({"sig": _vocab_sig(m), "n": m.Vn}, f)
    m.mlp = {k: v for k, v in W.items() if k not in ("ctx", "M")}
    m.mlp["ctx"] = W["ctx"]
    _attach_pad(m)
    m.mlp_info = info
    j.step(0.88, "tune the blend on held-out text")
    _evaluate(m, c, j)
    _save_meta(c, m)
    return _status(c)


def generate_api(c, seed="", length=80, temp=0.7, theme="", novelty=0.5, model="hybrid", stop_at="none", rs=-1, top_p=0.85,
                 repetition=0.6, rerank=1, rep_function_words=False, rank_by="typical", no_repeat=3):
    t_call = time.time()
    m, warm = get_model(c)
    model = model if model in ("hybrid", "kn", "mlp") else "hybrid"
    if model == "mlp" and m.mlp is None:
        raise ValueError("train the neural model first (text.lm.train)")
    length = max(1, min(int(length), 1000))
    temp = max(0.05, min(float(temp), 3.0))
    novelty = max(0.0, min(float(novelty), 1.0))
    rng = np.random.RandomState(rs if rs >= 0 else int(time.time() * 1000) % (2 ** 31))
    tw = time.time()
    # The vocabulary filter's exclusions, junk filter and mention range all apply; its "hide stopwords" switch is a
    # display setting for the analytics views and is not applied here (a language model without "the" can't write).
    gm = c.gen_mask()
    ex = set(c.get_filter().get("exclude") or [])
    allowed = np.zeros(m.Vn + 1, bool)
    allowed[:m.Vn] = gm[m.gid]
    for i, w in enumerate(m.words):
        wl = w.lower()
        if wl in te.STOP and wl not in ex:
            allowed[i] = True
    top_p = max(0.05, min(float(top_p), 1.0))
    repetition = max(0.0, min(float(repetition), 5.0))
    sig = json.dumps(c.get_filter(), sort_keys=True)
    if getattr(m, "Eemb", None) is None or m.emb_sig != sig:   # embeddings follow the vocabulary filter
        m.embeddings(c)
        m.emb_sig = sig
    E = getattr(m, "Eemb", None)
    theme_vec = None
    if theme.strip() and E is not None:
        tv = [m.emb_full[m.emb_idx[w]] for w in re.findall(r"[^\W\d_][\w'\-]*", theme.lower()) if w in m.emb_idx]
        if tv:
            theme_vec = np.mean(tv, 0)
            theme_vec = theme_vec / (np.linalg.norm(theme_vec) + 1e-9)
    mix = dict(m.mix)
    if model == "kn":
        mix = {"kn": 1.0, "mlp": 0.0, "sfx": 0.0, "beta": 0.0}
    elif model == "mlp":
        mix = {"kn": 0.0, "mlp": 1.0, "sfx": 0.0, "beta": 0.0}
    elif m.mlp is None:
        mix["mlp"] = 0.0
    # seed -> lm ids
    hist, seed_words = [], []
    for t in te.TOKEN_RE.findall(te.normalise(seed.encode("utf-8"))):
        g = c.gid_exact(b"\n\n" if t.startswith(b"\n") else t)
        if g is not None:
            hist.append(int(m.lut[g]))
            seed_words.append(c.word(g))
    if not hist:                                 # start like a sentence starts: right after a full stop
        dot = m.words.index(".") if "." in m.words else None
        if dot is not None:
            cand = np.flatnonzero(m.train[:-1] == dot)
            if cand.size:
                p0 = int(cand[rng.randint(cand.size)])
                hist = list(m.train[max(0, p0 - SFX_MAX + 1):p0 + 1])
    nseed = len(hist)
    v = np.zeros(E.shape[1], np.float32) if E is not None else None
    for t in hist:
        if v is not None:
            v = 0.9 * v + E[t]
    warmup_ms = warm * 1000
    t0 = time.time()
    warmup_ms += (t0 - tw) * 1000
    rerank = max(1, min(int(rerank), 16))
    # Repetition penalty on content words only: "the", "of" and punctuation have to repeat for text to be grammatical,
    # and penalising them was a direct cause of broken sentences. (rep_function_words=True restores the old behaviour.)
    exempt = m.punct.copy()
    if not rep_function_words:
        for i, w in enumerate(m.words):
            if w.lower() in te.STOP:
                exempt[i] = True
    rep_w = (~exempt).astype(np.float64)

    def step(hist, v, nprev):
        """One sampled word: (w, p_sampled, p_base, expert, longest match)."""
        parts = {}
        if mix["kn"] > 0:
            parts["kn"] = m.kn_dist(hist)
        if mix["mlp"] > 0:
            parts["mlp"] = m.mlp_dist(hist)
        L, tb, r = m.longest(hist)
        if mix["sfx"] > 0 and L >= SFX_MIN:
            parts["sfx"] = m.sfx_dist(tb, r)
        wsum = sum(mix[k] for k in parts) or 1.0
        base = sum(mix[k] / wsum * parts[k] for k in parts)
        if v is not None and mix["beta"] > 0 and np.linalg.norm(v) > 0:
            base = base * np.exp(mix["beta"] * (E @ (v / np.linalg.norm(v))))
        base = base / base.sum()
        p = base.copy()
        if theme_vec is not None and E is not None:
            p *= np.exp(3.0 * (E @ theme_vec))
        if novelty > 0 and tb is not None:      # discourage extending a long verbatim run
            limit = 3 + (1.0 - novelty) * 10
            if L + 1 > limit:
                s_, e_ = tb.start[r], tb.start[r + 1]
                p[tb.w[s_:e_]] *= math.exp(-novelty * 1.5 * (L + 1 - limit))
        p[m.UNK] = 0.0
        p[~allowed] = 0.0
        if repetition > 0:                       # LLM-style repetition penalty over the recent window
            rec = np.bincount(np.asarray(hist[-32:], np.int64), minlength=m.Vn + 1)[:m.Vn + 1]
            p /= 1.0 + repetition * rec * rep_w
        if nprev >= 2 and m.punct[hist[-1]] and m.punct[hist[-2]]:
            p[m.punct] *= 0.03                   # no runs of bare punctuation (JSON debris in web text)
        if no_repeat >= 2 and nprev >= no_repeat - 1:  # no-repeat n-gram over what this call has written
            n1 = no_repeat - 1
            ctx = tuple(hist[-n1:])
            w0 = max(n1, len(hist) - min(nprev, 150))
            seen_next = [hist[i + n1] for i in range(w0 - n1, len(hist) - n1) if i >= 0 and tuple(hist[i:i + n1]) == ctx]
            for x in seen_next:
                if not m.punct[x]:
                    p[x] *= 0.02
        if p.sum() <= 0:
            p = m.p1 * allowed
        p = p ** (1.0 / temp)
        p = p / p.sum()
        if top_p < 1.0:                          # nucleus sampling: drop the long tail
            o = np.argsort(-p)
            cs = np.cumsum(p[o])
            cut = int(np.searchsorted(cs, top_p)) + 1
            q = np.zeros_like(p)
            q[o[:cut]] = p[o[:cut]]
            p = q / q.sum()
        w = int(rng.choice(p.size, p=p))
        expert = max(parts, key=lambda k: mix[k] * parts[k][w]) if parts else "kn"
        ent = float(-(base[base > 0] * np.log(base[base > 0])).sum()) if rerank > 1 else 0.0
        return w, float(p[w]), float(base[w]), expert, int(L), ent

    def trace(hist, w):
        Lc = min(len(hist), SFX_MAX - 1)
        for k in range(Lc + 1, 0, -1):         # trace the word back to a real position in the corpus
            tbk = m.tab[k]
            rk = tbk.lookup(_ctxhash(hist[-(k - 1):])) if k > 1 else 0
            if rk < 0:
                continue
            s_, e_ = tbk.start[rk], tbk.start[rk + 1]
            hit = np.flatnonzero(tbk.w[s_:e_] == w)
            if hit.size:
                return int(m.train_pos[int(tbk.pos[s_ + hit[0]])])
        return -1

    ends = {".", "!", "?", "\n\n"}
    out, nll, drawn, cand_scores = [], 0.0, 0, []
    while len(out) < length:
        budget = length - len(out)
        best = None
        v0 = None if v is None else v.copy()
        for k in range(rerank if rerank > 1 else 1):
            h, vv, toks = list(hist), (None if v0 is None else v0.copy()), []
            for _ in range(min(budget, 60) if rerank > 1 else 1):
                st = step(h, vv, len(out) + len(toks))
                toks.append(st)
                h.append(st[0])
                if vv is not None:
                    vv = 0.9 * vv + E[st[0]]
                if rerank > 1 and m.words[st[0]] in ends:
                    break
            drawn += len(toks)
            if rerank == 1:
                best = (0.0, toks)
                break
            # fluency: mean log-probability under the unsharpened model; topic: cosine of the candidate's words to the
            # running context; a sentence that never ends inside the window is marked down.
            lp = float(np.mean([math.log(max(t[2], 1e-12)) for t in toks]))
            hm = float(np.mean([t[5] for t in toks]))         # the model's own expected surprise along the way
            coh = 0.0
            if v0 is not None and np.linalg.norm(v0) > 0:
                cv = np.sum([E[t[0]] for t in toks if not exempt[t[0]]] or [np.zeros(E.shape[1], np.float32)], 0)
                nv = np.linalg.norm(cv)
                if nv > 0:
                    coh = float(cv @ v0 / (nv * np.linalg.norm(v0)))
            done = m.words[toks[-1][0]] in ends or len(toks) >= budget
            seen = set(zip(hist[-300:-1], hist[-299:]))
            ids = [hist[-1]] + [t[0] for t in toks]
            dup = sum((ids[i], ids[i + 1]) in seen for i in range(len(toks)) if not exempt[ids[i + 1]]) / max(1, len(toks))
            # "fluency" keeps the likeliest sentence, which on books means headings ("CHAPTER VII."); "typical" keeps the
            # one whose surprise is closest to what the model itself expects (locally typical), so it stays ordinary prose.
            fit = lp if rank_by == "fluency" else -abs(-lp - hm)
            score = fit + 1.5 * coh - 2.0 * dup - (0.0 if done else 1.0) + (0.0 if len(toks) >= 4 or len(toks) >= budget else -0.7)
            if best is None or score > best[0]:
                best = (score, toks)
        if rerank > 1:
            cand_scores.append(round(best[0], 3))
        stop = False
        for (w, pw, bw, expert, L, _ent) in best[1]:
            src = trace(hist, w)
            nll -= math.log(max(bw, 1e-12))
            hist.append(w)
            if v is not None:
                v = 0.9 * v + E[w]
            out.append({"w": m.words[w], "src": src, "p": round(pw, 4), "expert": expert, "match": L})
            wd = m.words[w]
            if stop_at == "sentence" and wd in (".", "!", "?") and len(out) >= length * 0.6:
                stop = True
                break
            if stop_at == "paragraph" and wd == "\n\n" and len(out) >= 11:
                stop = True
                break
            if len(out) >= length:
                break
        if stop:
            break
    dt = time.time() - t0
    total = time.time() - t_call
    seed_text = te.detok(seed_words)
    return {"seed": seed_text, "text": te.detok(seed_words + [o["w"] for o in out]), "words": out,
            "ms": round(dt * 1000, 1), "tok_s": round(len(out) / max(dt, 1e-6), 1), "warmup_ms": round(warmup_ms, 1),
            "server_ms": round(total * 1000, 1), "tok_s_total": round(len(out) / max(total, 1e-6), 1),
            "model": model, "mix": mix, "length": len(out), "top_p": top_p, "repetition": repetition,
            "rerank": rerank, "rank_by": rank_by, "no_repeat": no_repeat, "drawn_tokens": drawn, "rep_function_words": bool(rep_function_words),
            "ppl_of_output": round(math.exp(nll / max(1, len(out))), 2), "theme": theme, "novelty": novelty,
            "nseed": nseed}


# ---------------------------------------------------------------- endpoints (the UI's): the same models as /v1 and the CLI
def _ui(_model, **kw):
    from . import registry as R
    try:
        return R.ui(_model, **kw)
    except R.Refused as e:
        raise HTTPException(400 if e.status == 409 else e.status, str(e))


@router.get("/status")
def lm_status():
    return _ui("text.lm.status")


@router.post("/build")
def lm_build(body: dict = None):
    from . import registry as R
    b = body or {}
    return R.ui_job("text.lm.build", "LM: build n-gram model", order=max(2, min(int(b.get("order") or 5), 6)))


@router.post("/train")
def lm_train(body: dict = None):
    from . import registry as R
    b = body or {}
    t = _TRAINING["job"]
    if t is not None and getattr(t, "state", None) == "running":
        raise HTTPException(409, "a training run is already in progress")
    _corpus()
    return R.ui_job("text.lm.train", "LM: train neural model", epochs=max(1, min(int(b.get("epochs") or 2), 20)),
                    hidden=max(64, min(int(b.get("hidden") or 384), 1024)), ctx=max(2, min(int(b.get("ctx") or 6), 10)),
                    minutes=max(0.2, min(float(b.get("minutes") or 4.0), 60.0)))


@router.get("/generate")
def lm_generate(seed: str = "", length: int = 80, temp: float = 0.7, theme: str = "", novelty: float = 0.5,
                model: str = "hybrid", stop_at: str = "none", rs: int = -1, top_p: float = 0.85, repetition: float = 0.6,
                rerank: int = 1, rep_function_words: bool = False, rank_by: str = "typical", no_repeat: int = 3):
    _corpus()
    try:
        return _ui("text.lm.generate", seed=seed, length=max(1, min(int(length), 1000)), temp=max(0.05, min(float(temp), 3.0)),
                   theme=theme, novelty=max(0.0, min(float(novelty), 1.0)), model=model if model in ("hybrid", "kn", "mlp") else "hybrid",
                   stop_at=stop_at if stop_at in ("none", "sentence", "paragraph") else "none", rs=max(-1, rs),
                   top_p=max(0.05, min(float(top_p), 1.0)), repetition=max(0.0, min(float(repetition), 5.0)),
                   rerank=max(1, min(int(rerank), 16)), rep_function_words=bool(rep_function_words),
                   rank_by=rank_by if rank_by in ("typical", "fluency") else "typical", no_repeat=max(0, min(int(no_repeat), 6)))
    except ValueError as e:
        raise HTTPException(400, str(e))
