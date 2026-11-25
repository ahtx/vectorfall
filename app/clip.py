"""CLIP on the K420: search your photos by what's in them, in plain words, or by another photo.

OpenAI's CLIP ViT-B/32 (the public weights) is run here in CuPy -- no PyTorch on this machine. A photo and a sentence
are each turned into 512 numbers; photos of a thing and sentences about it land close together. That gives:

  * search by words   "receipt", "dog on a beach", "whiteboard with a diagram" -> the closest photos
  * search by photo   "more like this one"
  * duplicates        near-identical frames (bursts, re-saves, crops) grouped, with the sharpest suggested as keeper

The weights (605 MB, downloaded once from Hugging Face) are unpacked from PyTorch's zip format by a small reader below
and kept as float16 on disk; each tower is uploaded to the card for the job and released afterwards (vision 176 MB,
text 126 MB in float16, multiplied out in float32). Self-test: OpenAI's own example -- CLIP.png scored against
"a diagram", "a dog", "a cat" -- must come out ~0.993 / 0.004 / 0.003 as published; the result is shown in the app.
"""
import gzip
import html
import io
import json
import math
import os
import pickle
import re
import threading
import time
import urllib.request
import zipfile
from functools import lru_cache

import numpy as np
from PIL import Image

import cupy as cp

from . import engine, media

DIR = "/srv/data/models/clip-vit-b32"
HF = "https://huggingface.co/openai/clip-vit-base-patch32/resolve/main/"
MEAN = np.array([0.48145466, 0.4578275, 0.40821073], np.float32)
STD = np.array([0.26862954, 0.26130258, 0.27577711], np.float32)
LOCK = threading.Lock()
EMB = "clip.npy"


# ================================================================ weights: PyTorch zip -> numpy, without PyTorch
class _Storage:
    def __init__(self, kind):
        self.kind = kind


class _Unpickler(pickle.Unpickler):
    def __init__(self, f, zf, prefix):
        super().__init__(f)
        self.zf, self.prefix = zf, prefix

    def find_class(self, module, name):
        if module == "torch._utils" and name == "_rebuild_tensor_v2":
            return self._rebuild
        if module == "torch" and name.endswith("Storage"):
            return _Storage(name)
        if module == "collections" and name == "OrderedDict":
            import collections
            return collections.OrderedDict
        if module == "torch" and name in ("float32", "float16"):
            return name
        raise pickle.UnpicklingError("unexpected {}.{} in the checkpoint".format(module, name))

    def persistent_load(self, pid):
        _, st, key, _loc, _n = pid
        dt = {"FloatStorage": np.float32, "HalfStorage": np.float16, "LongStorage": np.int64, "IntStorage": np.int32}[st.kind]
        return np.frombuffer(self.zf.read("{}/data/{}".format(self.prefix, key)), dt)

    @staticmethod
    def _rebuild(storage, offset, size, stride, *_):
        if not size:
            return storage[offset:offset + 1].reshape(())
        n = 1 + sum((s - 1) * st for s, st in zip(size, stride))
        return np.lib.stride_tricks.as_strided(storage[offset:offset + n], size, [st * storage.itemsize for st in stride]).copy()


def _convert(path):
    zf = zipfile.ZipFile(path)
    pkl = next(n for n in zf.namelist() if n.endswith("data.pkl"))
    prefix = pkl.rsplit("/", 1)[0]
    sd = _Unpickler(io.BytesIO(zf.read(pkl)), zf, prefix).load()
    vis = {k: v.astype(np.float16) for k, v in sd.items() if k.startswith(("vision_model.", "visual_projection"))}
    txt = {k: v.astype(np.float16) for k, v in sd.items() if k.startswith(("text_model.", "text_projection"))}
    np.savez(os.path.join(DIR, "vision.npz"), **vis)
    np.savez(os.path.join(DIR, "text.npz"), **txt)
    with open(os.path.join(DIR, "scale.json"), "w") as f:
        json.dump({"logit_scale": float(np.exp(sd["logit_scale"]))}, f)


def ready():
    return all(os.path.exists(os.path.join(DIR, f)) for f in ("vision.npz", "text.npz", "vocab.json", "merges.txt", "scale.json"))


def install(job=None):
    os.makedirs(DIR, exist_ok=True)
    for f in ("vocab.json", "merges.txt"):
        p = os.path.join(DIR, f)
        if not os.path.exists(p):
            urllib.request.urlretrieve(HF + f, p + ".tmp")
            os.replace(p + ".tmp", p)
    if not (os.path.exists(os.path.join(DIR, "vision.npz")) and os.path.exists(os.path.join(DIR, "text.npz"))):
        tmp = os.path.join(DIR, "pytorch_model.bin")
        req = urllib.request.Request(HF + "pytorch_model.bin", headers={"User-Agent": "VectorFall/1.0"})
        with urllib.request.urlopen(req, timeout=60) as r, open(tmp + ".part", "wb") as f:
            total = int(r.headers.get("Content-Length") or 605247071)
            got = 0
            while True:
                b = r.read(1 << 20)
                if not b:
                    break
                f.write(b)
                got += len(b)
                if job:
                    job.step(got / float(total) * 0.9, "download of the CLIP weights: {:.0f} / {:.0f} MB".format(got / 2**20, total / 2**20))
        os.replace(tmp + ".part", tmp)
        if job:
            job.step(0.92, "unpack the weights (PyTorch is not necessary)")
        _convert(tmp)
        os.remove(tmp)
    _W.clear()
    return {"ready": ready()}


_W = {}


def _weights(which):
    if which not in _W:
        z = np.load(os.path.join(DIR, which + ".npz"))
        _W[which] = {k: z[k] for k in z.files}
    return _W[which]


# ================================================================ tokenizer (CLIP's byte-level BPE)
@lru_cache()
def _b2u():
    bs = list(range(ord("!"), ord("~") + 1)) + list(range(ord("¡"), ord("¬") + 1)) + list(range(ord("®"), ord("ÿ") + 1))
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return dict(zip(bs, [chr(c) for c in cs]))


class _Tok:
    PAT = re.compile(r"<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[^\W\d_]+|\d|(?:[^\s\w]|_)+", re.IGNORECASE)

    def __init__(self):
        with open(os.path.join(DIR, "vocab.json"), encoding="utf-8") as f:
            self.enc = json.load(f)
        with open(os.path.join(DIR, "merges.txt"), encoding="utf-8") as f:
            merges = [tuple(l.split()) for l in f.read().split("\n")[1:] if l.strip()]
        self.ranks = {m: i for i, m in enumerate(merges)}
        self.cache = {}
        self.sot, self.eot = self.enc["<|startoftext|>"], self.enc["<|endoftext|>"]

    def bpe(self, token):
        if token in self.cache:
            return self.cache[token]
        word = list(token[:-1]) + [token[-1] + "</w>"]
        while len(word) > 1:
            pairs = {(word[i], word[i + 1]) for i in range(len(word) - 1)}
            best = min(pairs, key=lambda p: self.ranks.get(p, 1e18))
            if best not in self.ranks:
                break
            a, b = best
            out, i = [], 0
            while i < len(word):
                if i < len(word) - 1 and word[i] == a and word[i + 1] == b:
                    out.append(a + b)
                    i += 2
                else:
                    out.append(word[i])
                    i += 1
            word = out
        self.cache[token] = word
        return word

    def __call__(self, text, n=77):
        text = re.sub(r"\s+", " ", html.unescape(html.unescape(text))).strip().lower()
        b2u = _b2u()
        ids = [self.sot]
        for t in self.PAT.findall(text):
            t = "".join(b2u[b] for b in t.encode("utf-8"))
            ids += [self.enc[p] for p in self.bpe(t) if p in self.enc]
        ids = ids[:n - 1] + [self.eot]
        return ids + [0] * (n - len(ids))


_TOK = []


def tokenize(texts):
    if not _TOK:
        _TOK.append(_Tok())
    return np.array([_TOK[0](t) for t in texts], np.int64)


# ================================================================ the transformer, in CuPy
def _ln(x, w, b, eps=1e-5):
    mu = x.mean(-1, keepdims=True)
    var = ((x - mu) ** 2).mean(-1, keepdims=True)
    return (x - mu) / cp.sqrt(var + eps) * w + b


def _lin(x, W, b=None):
    # flatten to 2-D first: CuPy 9.6 runs (B, T, D) @ (D, E) as a slow batched product (15 vs 115 GFLOP/s here)
    y = (x.reshape(-1, x.shape[-1]) @ W.astype(cp.float32).T).reshape(x.shape[:-1] + (W.shape[0],))
    return y + b.astype(cp.float32) if b is not None else y


def _encoder(x, G, pre, layers, heads, causal):
    B, T, D = x.shape
    hd = D // heads
    mask = None
    if causal:
        mask = cp.triu(cp.full((T, T), -1e9, cp.float32), 1)
    f32 = lambda k: G[k].astype(cp.float32)  # noqa: E731
    for i in range(layers):
        p = "{}.encoder.layers.{}.".format(pre, i)
        h = _ln(x, f32(p + "layer_norm1.weight"), f32(p + "layer_norm1.bias"))
        q = _lin(h, G[p + "self_attn.q_proj.weight"], G[p + "self_attn.q_proj.bias"]) * (hd ** -0.5)
        k = _lin(h, G[p + "self_attn.k_proj.weight"], G[p + "self_attn.k_proj.bias"])
        v = _lin(h, G[p + "self_attn.v_proj.weight"], G[p + "self_attn.v_proj.bias"])
        q, k, v = (t.reshape(B, T, heads, hd).transpose(0, 2, 1, 3) for t in (q, k, v))
        a = q @ k.transpose(0, 1, 3, 2)
        if mask is not None:
            a = a + mask
        a = cp.exp(a - a.max(-1, keepdims=True))
        a = a / a.sum(-1, keepdims=True)
        o = (a @ v).transpose(0, 2, 1, 3).reshape(B, T, D)
        x = x + _lin(o, G[p + "self_attn.out_proj.weight"], G[p + "self_attn.out_proj.bias"])
        h = _ln(x, f32(p + "layer_norm2.weight"), f32(p + "layer_norm2.bias"))
        h = _lin(h, G[p + "mlp.fc1.weight"], G[p + "mlp.fc1.bias"])
        h = h * (1.0 / (1.0 + cp.exp(-1.702 * h)))                 # quick GELU, as CLIP was trained
        x = x + _lin(h, G[p + "mlp.fc2.weight"], G[p + "mlp.fc2.bias"])
    return x


def _upload(which):
    return {k: cp.asarray(v) for k, v in _weights(which).items()}


def _images(G, px):
    """px: (B, 3, 224, 224) float32 normalised -> (B, 512) unit vectors. Inside a GPU job, weights uploaded."""
    B = px.shape[0]
    x = cp.asarray(px).reshape(B, 3, 7, 32, 7, 32).transpose(0, 2, 4, 1, 3, 5).reshape(B, 49, 3 * 32 * 32)
    W = G["vision_model.embeddings.patch_embedding.weight"].astype(cp.float32).reshape(768, -1)
    x = (x.reshape(B * 49, -1) @ W.T).reshape(B, 49, 768)
    cls = G["vision_model.embeddings.class_embedding"].astype(cp.float32)
    x = cp.concatenate([cp.broadcast_to(cls, (B, 1, 768)), x], 1) + G["vision_model.embeddings.position_embedding.weight"].astype(cp.float32)[None]
    x = _ln(x, G["vision_model.pre_layrnorm.weight"].astype(cp.float32), G["vision_model.pre_layrnorm.bias"].astype(cp.float32))
    x = _encoder(x, G, "vision_model", 12, 12, False)
    pooled = _ln(x[:, 0], G["vision_model.post_layernorm.weight"].astype(cp.float32), G["vision_model.post_layernorm.bias"].astype(cp.float32))
    e = _lin(pooled, G["visual_projection.weight"])
    return e / cp.linalg.norm(e, axis=1, keepdims=True)


def _texts(G, ids):
    B, T = ids.shape
    tok = cp.asarray(ids)
    x = G["text_model.embeddings.token_embedding.weight"][tok].astype(cp.float32) + G["text_model.embeddings.position_embedding.weight"].astype(cp.float32)[None, :T]
    x = _encoder(x, G, "text_model", 12, 8, True)
    x = _ln(x, G["text_model.final_layer_norm.weight"].astype(cp.float32), G["text_model.final_layer_norm.bias"].astype(cp.float32))
    pooled = x[cp.arange(B), cp.asarray(ids.argmax(1))]
    e = _lin(pooled, G["text_projection.weight"])
    return e / cp.linalg.norm(e, axis=1, keepdims=True)


def preprocess(im):
    im = im.convert("RGB")
    w, h = im.size
    s = 224.0 / min(w, h)
    im = im.resize((max(224, int(round(w * s))), max(224, int(round(h * s)))), Image.BICUBIC)
    w, h = im.size
    l, t = (w - 224) // 2, (h - 224) // 2
    a = np.asarray(im.crop((l, t, l + 224, t + 224)), np.float32) / 255.0
    return ((a - MEAN) / STD).transpose(2, 0, 1)


def embed_texts(texts):
    ids = tokenize(texts)

    def job():
        G = _upload("text")
        out = cp.asnumpy(_texts(G, ids))
        del G
        cp.get_default_memory_pool().free_all_blocks()
        return out
    return engine.run_on_gpu(job, "CLIP: reading words", 120)


def embed_images(ims, batch=32, job=None):
    out = []

    def run(chunk):
        G = _upload("vision")
        res = []
        for i in range(0, len(chunk), batch):
            px = np.stack([preprocess(im) for im in chunk[i:i + batch]])
            res.append(cp.asnumpy(_images(G, px)))
        del G
        cp.get_default_memory_pool().free_all_blocks()
        return np.concatenate(res, 0)
    for i in range(0, len(ims), 128):                         # each GPU job: weights up, up to 128 photos, weights down
        out.append(engine.run_on_gpu(lambda c=ims[i:i + 128]: run(c), "CLIP: examine the photos", 300))
        if job:
            job.step(min(0.99, (i + 128) / float(len(ims))), "{} of {} photos".format(min(len(ims), i + 128), len(ims)))
    return np.concatenate(out, 0) if out else np.zeros((0, 512), np.float32)


# ================================================================ the photo library
def _emb_path(pid):
    return media.photo_path(pid, EMB)


def index(job=None):
    if not ready():
        install(job)
    todo = [p for p in media.photo_list() if not os.path.exists(_emb_path(p["id"]))]
    for i in range(0, len(todo), 64):
        part = todo[i:i + 64]
        ims = []
        for p in part:
            try:
                ims.append(Image.open(media.photo_path(p["id"], "proxy.jpg") if os.path.exists(media.photo_path(p["id"], "proxy.jpg")) else media.photo_path(p["id"], "thumb.jpg")))
            except Exception:  # noqa: BLE001
                ims.append(Image.new("RGB", (224, 224)))
        E = embed_images(ims)
        for p, e in zip(part, E):
            np.save(_emb_path(p["id"]), e.astype(np.float16))
        if job:
            job.step((i + len(part)) / float(max(1, len(todo))), "{} of {} photos seen".format(i + len(part), len(todo)))
    return status()


def _library():
    ids, vecs = [], []
    for p in media.photo_list():
        f = _emb_path(p["id"])
        if os.path.exists(f):
            ids.append(p["id"])
            vecs.append(np.load(f).astype(np.float32))
    return ids, (np.stack(vecs) if vecs else np.zeros((0, 512), np.float32))


def status():
    n = len(media.photo_list())
    k = sum(1 for p in media.photo_list() if os.path.exists(_emb_path(p["id"])))
    st = {"model": ready(), "photos": n, "indexed": k}
    p = os.path.join(DIR, "selftest.json")
    if os.path.exists(p):
        with open(p) as f:
            st["selftest"] = json.load(f)
    return st


def search_text(q, top=60):
    if not ready():
        raise ValueError("the CLIP model is not installed. First, press “Get the model”")
    ids, V = _library()
    if not ids:
        raise ValueError("there is no photo in the index yet")
    prompts = [q, "a photo of " + q] + CONTROLS
    E = embed_texts(prompts)
    T = E[:2].mean(0)
    T = T / np.linalg.norm(T)
    C = E[2:] / np.linalg.norm(E[2:], axis=1, keepdims=True)
    s = V @ T
    ctrl = (V @ C.T).max(axis=1)                     # each photo's best score for a caption that says nothing
    o = np.argsort(-s)[:top]
    # evidence, not a fixed threshold: a real match beats the neutral captions for the same photo (lift > 0), and
    # stands out from the library (z = SDs above the library's mean score for this query)
    mu, sd = float(s.mean()), float(s.std() + 1e-6)
    lift = s - ctrl
    res = [{"id": ids[i], "score": round(float(s[i]), 4), "control": round(float(ctrl[i]), 4), "lift": round(float(lift[i]), 4),
            "z": round((float(s[i]) - mu) / sd, 2), "match": bool(lift[i] > LIFT_MIN)} for i in o]
    n = int((lift > LIFT_MIN).sum())
    return {"query": q, "results": res, "of": len(ids), "matches": n, "controls": CONTROLS, "lift_min": LIFT_MIN,
            "sentence": "{} of {} photos match “{}” better than a caption that says nothing (lift > {}).".format(n, len(ids), q, LIFT_MIN)}


# neutral captions: a photo that scores as well for these as for the query is not about the query
CONTROLS = ["a photo", "a picture of something", "an image"]
LIFT_MIN = 0.01


def search_photo(pid, top=60):
    ids, V = _library()
    if pid not in ids:
        raise ValueError("that photo is not in the index yet")
    s = V @ V[ids.index(pid)]
    o = [i for i in np.argsort(-s) if ids[i] != pid][:top]
    return {"like": pid, "results": [{"id": ids[i], "score": round(float(s[i]), 4)} for i in o], "of": len(ids)}


def _sharpness(pid):
    im = Image.open(media.photo_path(pid, "thumb.jpg")).convert("L")
    a = np.asarray(im, np.float32)
    lap = a[1:-1, 1:-1] * 4 - a[:-2, 1:-1] - a[2:, 1:-1] - a[1:-1, :-2] - a[1:-1, 2:]
    return float(lap.var())


def duplicates(threshold=0.93):
    """Groups of near-identical photos (CLIP cosine >= threshold, all pairs at once on the card), keeper first."""
    ids, V = _library()
    if len(ids) < 2:
        return {"groups": [], "of": len(ids)}

    def job():
        G = cp.asarray(V)
        S = G @ G.T
        return cp.asnumpy(S >= threshold)
    A = engine.run_on_gpu(job, "CLIP: compare each pair", 60)
    seen, groups = set(), []
    metas = {p["id"]: p for p in media.photo_list()}
    for i in range(len(ids)):
        if i in seen:
            continue
        stack, comp = [i], []
        while stack:
            k = stack.pop()
            if k in seen:
                continue
            seen.add(k)
            comp.append(k)
            stack += [int(j) for j in np.flatnonzero(A[k]) if j not in seen]
        if len(comp) > 1:
            members = []
            for k in comp:
                m = metas.get(ids[k], {})
                members.append({"id": ids[k], "name": m.get("name"), "w": m.get("w"), "h": m.get("h"), "sharp": round(_sharpness(ids[k]), 1)})
            members.sort(key=lambda m: (-(m["w"] or 0) * (m["h"] or 0), -m["sharp"]))     # keeper: the biggest, then the sharpest
            # CLIP says "shows the same kind of thing"; only the pixels can say "is a copy". A member is offered for
            # removal only when its difference hash is within 32 of 256 bits of the keeper's (measured: a half-size JPEG
            # q40 re-save of a photo differs by 15, a brighter copy by 13, a different photo of a similar scene by 246).
            try:
                h0 = media.photo_dhash(members[0]["id"])
                for m in members[1:]:
                    d = int(np.count_nonzero(media.photo_dhash(m["id"]) != h0))
                    m["dhash"], m["copy"] = d, d <= 32
            except Exception:  # noqa: BLE001  (a missing thumbnail: nothing is offered for removal)
                for m in members[1:]:
                    m["dhash"], m["copy"] = None, False
            members[0]["copy"] = None
            groups.append({"members": members, "sim": round(float(min(V[a] @ V[b] for a in comp for b in comp)), 3),
                           "copies": sum(1 for m in members[1:] if m.get("copy"))})
    groups.sort(key=lambda g: -len(g["members"]))
    return {"groups": groups, "of": len(ids), "threshold": threshold, "extra": sum(g["copies"] for g in groups)}


def selftest():
    """OpenAI's README example: CLIP.png vs ["a diagram", "a dog", "a cat"] -> [0.9927937, 0.0042107, 0.0029957]."""
    url = "https://raw.githubusercontent.com/openai/CLIP/main/CLIP.png"
    data = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "VectorFall/1.0"}), timeout=30).read()
    im = Image.open(io.BytesIO(data))
    I = embed_images([im])[0]
    T = embed_texts(["a diagram", "a dog", "a cat"])
    with open(os.path.join(DIR, "scale.json")) as f:
        scale = json.load(f)["logit_scale"]
    lg = scale * (T @ I)
    p = np.exp(lg - lg.max())
    p = p / p.sum()
    ref = [0.9927937, 0.00421068, 0.00299572]
    out = {"probs": [round(float(x), 5) for x in p], "reference": ref, "max_abs_err": round(float(np.abs(p - ref).max()), 5),
           "passed": bool(np.abs(p - ref).max() < 0.01), "at": time.time()}
    with open(os.path.join(DIR, "selftest.json"), "w") as f:
        json.dump(out, f)
    return out
