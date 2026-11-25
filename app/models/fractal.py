"""Fractal models: escape-time sets rendered on the card (FP32 → FP64 → perturbation as you zoom)."""
from .. import fractal as F
from ..registry import Blob, model

VIEW = [{"k": "kind", "type": "choice", "label": "Set", "choices": ["mandelbrot", "julia", "burning-ship", "tricorn"], "default": "mandelbrot"},
        {"k": "cx", "type": "str", "label": "Centre, real (a decimal string keeps deep-zoom precision)", "default": "-0.5"},
        {"k": "cy", "type": "str", "label": "Centre, imaginary", "default": "0.0"},
        {"k": "scale", "type": "float", "label": "Width of the view", "default": 3.2, "min": 1e-300, "max": 10},
        {"k": "palette", "type": "choice", "label": "Palette", "choices": list(F.PALETTES), "default": "rosso"},
        {"k": "jr", "type": "float", "label": "Julia c, real", "default": -0.8},
        {"k": "ji", "type": "float", "label": "Julia c, imaginary", "default": 0.156},
        {"k": "density", "type": "float", "label": "Colour density", "default": 1.0, "min": 0.05, "max": 20}]


@model("fractal.render", "Render a fractal", "fractal", "One frame as PNG; the X-Fractal metadata says which precision and how many GFLOP/s.",
       output="image/png",
       fields=VIEW + [{"k": "w", "type": "int", "label": "Width (px)", "default": 960, "min": 16, "max": 7680},
                      {"k": "h", "type": "int", "label": "Height (px)", "default": 640, "min": 16, "max": 4320},
                      {"k": "iters", "type": "int", "label": "Iterations (0 = automatic)", "default": 0, "min": 0, "max": 100000}],
       example={"w": 480, "h": 320})
def render(kind, cx, cy, scale, palette, jr, ji, density, w, h, iters):
    img, meta = F.render(kind, cx, cy, scale, w, h, iters, palette, jr, ji, density)
    return Blob(img, "image/png", "vectorfall-{}.png".format(kind), meta)


@model("fractal.wallpaper", "4K wallpaper", "fractal", "The same view at wallpaper size as JPEG.", output="image/jpeg",
       fields=VIEW + [{"k": "w", "type": "int", "label": "Width (px)", "default": 3840, "min": 16, "max": 7680},
                      {"k": "h", "type": "int", "label": "Height (px)", "default": 2160, "min": 16, "max": 4320}])
def wallpaper(kind, cx, cy, scale, palette, jr, ji, density, w, h):
    img, meta = F.render(kind, cx, cy, scale, w, h, 0, palette, jr, ji, density, "jpg")
    return Blob(img, "image/jpeg", "vectorfall-{}-{}x{}.jpg".format(kind, w, h), meta)


@model("fractal.palettes", "Palettes", "fractal", "", device="cpu")
def palettes():
    return F.PALETTES


# ---- places: named pins kept on the server, and where the explorer has been
from .. import fractal_places as FP  # noqa: E402

PLACE = VIEW + [{"k": "name", "type": "str", "label": "Name (empty: a name from the region)", "default": ""},
                {"k": "note", "type": "str", "label": "Note", "default": ""}]


@model("fractal.places", "Places", "fractal", "The named places (pins), with their exact centres.", device="cpu")
def places():
    return FP.listing()


@model("fractal.place.add", "Pin a place", "fractal", "Name the current view and keep it (with a small picture).", fields=PLACE, mutating=True)
def place_add(kind, cx, cy, scale, palette, jr, ji, density, name, note):
    return FP.add(kind, cx, cy, scale, name, note, palette, density, jr, ji)


@model("fractal.place.edit", "Rename a place", "fractal", "", fields=[{"k": "id", "type": "str", "label": "Place id", "required": True},
       {"k": "name", "type": "str", "label": "Name", "default": ""}, {"k": "note", "type": "str", "label": "Note", "default": ""}], device="cpu", mutating=True)
def place_edit(id, name, note):
    return FP.update(id, name or None, note if note else None)


@model("fractal.place.delete", "Remove a place", "fractal", "", fields=[{"k": "id", "type": "str", "label": "Place id", "required": True}], device="cpu", mutating=True)
def place_delete(id):
    return FP.delete(id)


@model("fractal.region", "Where is this?", "fractal", "A colloquial name for a view (Seahorse Valley, the Antenna...) and its depth.",
       fields=VIEW[:4], device="cpu")
def region(kind, cx, cy, scale):
    return {"name": FP.region_name(kind, cx, cy, scale)}


@model("fractal.visit", "Log a visit", "fractal", "Remember that this view was seen (for the where-you-have-been layer).", fields=VIEW[:4], device="cpu", mutating=True)
def visit(kind, cx, cy, scale):
    return FP.visit(kind, cx, cy, scale)


@model("fractal.visits", "Where you have been", "fractal", "Logged views inside (about) this view.", fields=VIEW[:4], device="cpu")
def visits(kind, cx, cy, scale):
    return FP.visits(kind, cx, cy, scale)


@model("fractal.kfr", "As a .kfr file", "fractal", "The view as a Kalles Fraktaler parameter file.", fields=VIEW[:4], device="cpu")
def kfr(kind, cx, cy, scale):
    return {"kfr": FP.kfr(kind, cx, cy, scale)}


@model("fractal.kfr.read", "Read a .kfr file", "fractal", "A view from a Kalles Fraktaler parameter file (Re, Im, Zoom).",
       fields=[{"k": "text", "type": "text", "label": ".kfr text", "required": True}], device="cpu")
def kfr_read(text):
    return FP.parse_kfr(text)


# ---- similarity: what a view looks like in numbers, and which places are like it
@model("fractal.similar", "Places like this one", "fractal",
       "Signature of the view (escape-time histogram, share inside, boundary dimension, symmetry, CLIP of a grey picture) "
       "and the closest of your places and the atlas, with why.", fields=VIEW[:4] + VIEW[5:7], timeout=300)
def similar(kind, cx, cy, scale, jr, ji):
    from .. import fractal_sim as FS
    return FS.similar(kind, cx, cy, scale, jr, ji)


@model("fractal.search", "Find places by words", "fractal", "CLIP: the places whose picture is closest to the words (spiral, lightning, feathers...).",
       fields=[{"k": "q", "type": "str", "label": "Words", "required": True}], timeout=300)
def search(q):
    from .. import fractal_sim as FS
    return FS.search(q)


# ---- fractals from data: CGR of the text corpus, the dimension of a photo, the PIFS compression lab
def _b64(b):
    import base64
    return "data:image/{};base64,".format("jpeg" if b[:2] == b"\xff\xd8" else "png") + base64.b64encode(b).decode()


@model("fractal.cgr", "Text as a fractal (chaos game)", "fractal",
       "The Chaos Game Representation of the loaded text corpus below a suffix: each level of 16 x 16 cells is one more "
       "character back, with the characters that come before it far more (or less) often than chance.",
       fields=[{"k": "suffix", "type": "str", "label": "Suffix already zoomed into (oldest first)", "default": ""},
               {"k": "depth", "type": "int", "label": "Characters shown", "default": 2, "min": 1, "max": 2}], device="cpu", timeout=120)
def cgr(suffix, depth):
    from .. import fractal_data as FD
    from . import text as T
    c = T._c()
    raw = bytes(c.raw[:6_000_000])
    png, meta = FD.cgr_text(raw, (suffix or "").encode("latin-1", "replace")[-40:], depth)
    meta["corpus"] = getattr(c, "name", None) or c.meta.get("name") if hasattr(c, "meta") else None
    meta["image"] = _b64(png)
    return meta


@model("fractal.dimension", "Fractal dimension of a photo", "fractal",
       "Box counting on the photo's edges, with the fit's R^2 and a shuffled control.",
       fields=[{"k": "photo", "type": "str", "label": "Photo id", "required": True}], device="cpu", timeout=120)
def dimension(photo):
    from PIL import Image
    from .. import fractal_data as FD, media
    im = Image.open(media.photo_path(photo))
    png, meta = FD.dimension(im)
    meta["image"] = _b64(png)
    return meta


@model("fractal.compress", "Fractal compression lab", "fractal",
       "Encode a photo as a partitioned iterated function system (keeping its proportions), decode it from noise, flat grey "
       "or another photo, at 4x, and against JPEG at the same size; optionally recombine half its maps with another photo's.",
       fields=[{"k": "photo", "type": "str", "label": "Photo id", "required": True},
               {"k": "start", "type": "str", "label": "Decode from: noise, grey, or a photo id", "default": "noise"},
               {"k": "mix", "type": "str", "label": "Recombine with this photo id (right half of the maps)", "default": ""}], timeout=600)
def compress(photo, start, mix):
    from PIL import Image
    from .. import fractal_data as FD, media
    st = start if start in ("noise", "grey") else "photo"
    r = FD.pifs_lab(Image.open(media.photo_path(photo)), photo, st, Image.open(media.photo_path(start)) if st == "photo" else None,
                    Image.open(media.photo_path(mix)) if mix else None, mix or None)
    out = dict(r["meta"])
    for k in ("original", "decoded", "big", "jpeg", "mix", "mix_other"):
        if k in r:
            out[k] = _b64(r[k])
    out["steps"] = [_b64(x) for x in r["steps"]]
    if "mix_steps" in r:
        out["mix_steps"] = [_b64(x) for x in r["mix_steps"]]
    return out


@model("fractal.lz", "Text compression lab (LZ77)", "fractal",
       "A passage of the loaded corpus (or your text) compressed by replacing repeats with pointers back: the pieces, the "
       "sizes next to gzip, bzip2 and xz, and everything needed to replay it.",
       fields=[{"k": "doc", "type": "int", "label": "Document number in the corpus (-1 = your text)", "default": 0, "min": -1},
               {"k": "offset", "type": "int", "label": "Start (bytes into the document)", "default": 0, "min": 0},
               {"k": "text", "type": "text", "label": "Your text (when doc is -1)", "default": ""}], device="cpu", timeout=120)
def lz(doc, offset, text):
    from .. import fractal_data as FD
    from . import text as T
    if doc < 0:
        return FD.lz_lab(text or "")
    c, p = _passage(doc, offset, "")
    docs = c.meta.get("docs") or [{"name": c.meta.get("name"), "start": 0}]
    doc = max(0, min(doc, len(docs) - 1))
    r = FD.lz_lab(p)
    r["doc"] = docs[doc]["name"]
    r["docs"] = [{"i": i, "name": d["name"], "bytes": (docs[i + 1]["start"] if i + 1 < len(docs) else len(c.raw)) - d["start"]} for i, d in enumerate(docs)]
    return r




def _passage(doc, offset, text):
    from . import text as T
    c = T._c()
    if doc < 0:
        return c, text or ""
    docs = c.meta.get("docs") or [{"name": c.meta.get("name"), "start": 0}]
    doc = max(0, min(doc, len(docs) - 1))
    a = docs[doc]["start"] + offset
    b = docs[doc + 1]["start"] if doc + 1 < len(docs) else len(c.raw)
    p = bytes(c.raw[a:min(b, a + 20000)]).decode("utf-8", "ignore")
    if offset:                                                    # start at a sentence, not in the middle of a word
        import re
        m = re.search(r"[.!?\n]\s+(?=[A-Z\"\u201c(])", p[:600])
        if m:
            p = p[m.end():]
    return c, p


PASSAGE = [{"k": "doc", "type": "int", "label": "Document number (-1 = your text)", "default": 0, "min": -1},
           {"k": "offset", "type": "int", "label": "Start (bytes into the document)", "default": 0, "min": 0},
           {"k": "text", "type": "text", "label": "Your text (when doc is -1)", "default": ""}]


@model("fractal.twins", "Compression twins", "fractal",
       "Each sentence of a passage replaced by its nearest corpus sentence in compression space (normalized compression "
       "distance, exactly or through 64 anchor sentences).",
       fields=PASSAGE + [{"k": "k", "type": "int", "label": "Take the k-th nearest", "default": 1, "min": 1, "max": 10},
                         {"k": "method", "type": "choice", "label": "Nearest by", "choices": ["exact", "anchors"], "default": "exact"}],
       device="cpu", timeout=300)
def twins(doc, offset, text, k, method):
    from .. import fractal_data as FD
    c, p = _passage(doc, offset, text)
    return FD.twins(c, p, k, 25, method)


@model("fractal.guided", "Compression-guided writing", "fractal",
       "Write on from a passage, each next word chosen among the words that follow the context in the corpus by its "
       "compression cost: matching the original's signature, its average, or the cheapest.",
       fields=PASSAGE + [{"k": "mode", "type": "choice", "label": "Aim", "choices": ["fit", "match", "mean", "min"], "default": "fit"},
                         {"k": "window", "type": "int", "label": "Last N words", "default": 12, "min": 3, "max": 40},
                         {"k": "n", "type": "int", "label": "Words to write", "default": 80, "min": 10, "max": 200},
                         {"k": "seed", "type": "int", "label": "Seed", "default": 0, "min": 0}], timeout=300)
def guided(doc, offset, text, mode, window, n, seed):
    from .. import fractal_data as FD
    c, p = _passage(doc, offset, text)
    return FD.guided(c, p, n, window, mode, seed)
