"""Photo Lab models: develop (looks with an amount, every slider), the saved edit (history, undo, flags, stars),
Auto with its evidence, user looks, batch export, duplicates, CLIP search."""
from .. import media, registry as R
from ..registry import Blob, model

PHOTO = {"k": "photo", "type": "photo", "label": "Photo", "required": True}
# the develop sliders (ranges are the UI's; the maths accepts any value, so they are suggestions)
SLIDERS = [("exposure", -1, 1), ("contrast", -1, 1), ("highlights", -1, 1), ("shadows", -1, 1), ("whites", -1, 1), ("blacks", -1, 1),
           ("warmth", -1, 1), ("tint", -1, 1), ("vibrance", -1, 1), ("saturation", -1, 1), ("clarity", 0, 1), ("sharpen", 0, 2),
           ("denoise", 0, 1), ("vignette", 0, 1), ("grain", 0, 1), ("fade", 0, 0.6), ("auto", 0, 1), ("teal_orange", 0, 1),
           ("bw", 0, 1), ("sepia", 0, 1)]
LOOK = {"k": "look", "type": "str", "label": "Look", "default": "none",
        "help": "a built-in look ({}) or one you saved".format(", ".join(media.LOOKS))}
AMOUNT = {"k": "amount", "type": "float", "label": "Look amount", "default": 1, "min": 0, "max": 2,
          "help": "how strongly the look applies: 0 = none, 1 = as designed, 2 = double"}
ADJ = [LOOK, AMOUNT] + \
    [{"k": k, "type": "float", "label": k.replace("_", "-").capitalize(), "default": 0, "min": lo, "max": hi, "soft": True,
      "help": "added to the look's own value" if k not in media.MIXES else "replaces the look's value"} for k, lo, hi in SLIDERS]
GEO = [{"k": "crop_box", "type": "list", "label": "Crop [x0, y0, x1, y1] in fractions of the turned photo (0..1)"},
       {"k": "angle", "type": "float", "label": "Straighten (degrees)", "default": 0, "min": -45, "max": 45},
       {"k": "turn", "type": "int", "label": "Quarter turns clockwise", "default": 0, "min": 0, "max": 3},
       {"k": "flip", "type": "bool", "label": "Mirror left to right", "default": False},
       {"k": "masks", "type": "json", "label": "Local adjustments",
        "help": "a list of masks: {type: linear (x0,y0 full effect, x1,y1 none) | radial (x, y, rx, ry, feather) | "
                "brush (dabs [[x, y, r, feather, erase]]), invert, adj: {exposure, contrast, highlights, shadows, warmth, "
                "tint, saturation, clarity}}; coordinates are fractions of the straightened, uncropped photo"}]
ADJ = ADJ + GEO
CROP = {"k": "crop", "type": "list", "label": "1:1 window x0,y0,w,h in pixels of the frame (after crop and rotation)"}
GROUPS = list(media.GROUPS)
GEO_KEYS = ("crop_box", "angle", "turn", "flip", "masks")


def _adj(look, crop=None, amount=1, mask_view=-1, nocrop=False, **sl):
    a = {k: v for k, v in sl.items() if v and k not in GEO_KEYS}
    for k in GEO_KEYS:
        if sl.get(k):
            a[k] = sl[k]
    if look and look != "none":
        a["look"] = look
        if amount is not None and float(amount) != 1:
            a["amount"] = float(amount)
    if crop:
        a["_crop"] = [int(x) for x in crop]
    if mask_view is not None and mask_view >= 0:
        a["_mask_view"] = int(mask_view)
    if nocrop:
        a["_nocrop"] = True
    return a


def photo_args(adj):
    """The UI's adj object -> this module's fields (look, amount, the sliders, geometry, masks, view options)."""
    a = dict(adj or {})
    out = {"look": str(a.get("look") or "none")}
    try:
        out["amount"] = float(a["amount"]) if a.get("amount") not in (None, "") else 1.0
    except (TypeError, ValueError):
        out["amount"] = 1.0
    for k, _, _ in SLIDERS:
        try:
            v = float(a.get(k) or 0)
        except (TypeError, ValueError):
            v = 0.0
        if v:
            out[k] = v
    for k in GEO_KEYS:
        if a.get(k):
            out[k] = a[k]
    if a.get("_crop"):
        out["crop"] = list(a["_crop"])
    if a.get("_mask_view") is not None:
        out["mask_view"] = int(a["_mask_view"])
    if a.get("_nocrop"):
        out["nocrop"] = True
    return out


def _first():
    ps = media.photo_list()
    return ps[0]["id"] if ps else None


def _exists(pid):
    try:
        return media.edit_get(pid)
    except FileNotFoundError:
        raise R.Refused("there is no photo with id {}".format(pid), 404)


@model("photo.list", "List photos", "photo", "Every photo in the Photo Lab: id, name, size, flag (1 pick, -1 reject), stars, edited.",
       device="cpu")
def photo_list():
    return media.photo_list()


@model("photo.looks", "Looks", "photo", "The looks (built-in and saved) and the slider values each one sets.", device="cpu")
def looks():
    return media.all_looks()


@model("photo.look.list", "Looks by kind", "photo", "The built-in looks, the looks you saved, and the values of each.", device="cpu")
def look_list():
    return {"builtin": list(media.LOOKS), "user": sorted(media.user_looks()), "values": media.all_looks()}


@model("photo.look.save", "Save a look", "photo",
       "Save settings as a look you can use on any photo: the given sliders, or the current edit of a photo.",
       device="cpu", mutating=True,
       fields=[{"k": "name", "type": "str", "label": "Name", "required": True},
               {"k": "photo", "type": "photo", "label": "Take the current edit of this photo"},
               {"k": "adj", "type": "json", "label": "Or these settings (look, amount, sliders)"}],
       example={"name": "my-warm", "adj": {"warmth": 0.3, "vibrance": 0.2}})
def look_save(name, photo=None, adj=None):
    if photo:
        adj = _exists(photo)["adj"]
    return media.look_save(name, adj or {})


@model("photo.look.delete", "Delete a saved look", "photo", "", device="cpu", mutating=True,
       fields=[{"k": "name", "type": "str", "label": "Name", "required": True}])
def look_delete(name):
    return media.look_delete(name)


@model("photo.upload", "Add a photo", "photo", "Store a photo (EXIF-rotated, up to 6000 px) with its preview and thumbnail.",
       device="cpu", mutating=True,
       fields=[{"k": "file", "type": "file", "label": "Image file", "required": True, "accept": "image/*"},
               {"k": "filename", "type": "str", "label": "Name", "default": "photo.jpg"}])
def upload(file, filename):
    return media.photo_add(filename or "photo", file)


@model("photo.develop", "Develop a photo", "photo",
       "Apply a look and any sliders on the card and get the JPEG back (a preview size, or full resolution in tiles). "
       "saved=true uses the photo's saved edit instead of the sliders given here.",
       output="image/jpeg",
       fields=[PHOTO] + ADJ + [{"k": "max", "type": "int", "label": "Longest side (px)", "default": 1400, "min": 16, "max": 8000},
                               {"k": "full", "type": "bool", "label": "Full resolution (tiled)", "default": False},
                               {"k": "saved", "type": "bool", "label": "Use the photo's saved edit", "default": False},
                               {"k": "draft", "type": "bool", "label": "Draft quality (while a slider moves)", "default": False},
                               {"k": "mask_view", "type": "int", "label": "Show this mask in red (0 = the first; -1 = none)", "default": -1, "min": -1, "max": 15},
                               {"k": "nocrop", "type": "bool", "label": "Show the whole straightened photo (for cropping)", "default": False},
                               CROP],
       example={"look": "vivid", "max": 512})
def develop(photo, look, max, full, saved=False, draft=False, crop=None, amount=1, mask_view=-1, nocrop=False, **sl):  # noqa: A002
    if saved:
        a = dict(_exists(photo)["adj"])
        if crop:
            a["_crop"] = [int(x) for x in crop]
        if mask_view is not None and mask_view >= 0:
            a["_mask_view"] = mask_view
    else:
        a = _adj(look, crop, amount, mask_view, nocrop, **sl)
    data, meta = media.photo_render(photo, a, 0 if full else max, quality=80 if draft and not full else None)
    return Blob(data, "image/jpeg", "vectorfall-{}.jpg".format(photo), meta)


# ---------------------------------------------------------------- the saved edit (non-destructive, with history)
@model("photo.edit", "Get a photo's edit", "photo",
       "The photo's current settings, its history of named steps, undo/redo state, flag and stars.", device="cpu", fields=[PHOTO])
def edit(photo):
    return _exists(photo)


@model("photo.edit.set", "Change a photo's edit", "photo",
       "Make these settings the photo's edit, as a new named history step. merge=true changes only the keys given "
       "(a 0 removes a slider). The original pixels never change.", device="cpu", mutating=True,
       fields=[PHOTO, {"k": "adj", "type": "json", "label": "Settings (look, amount, sliders)", "required": True},
               {"k": "label", "type": "str", "label": "Step name", "default": "Edit"},
               {"k": "merge", "type": "bool", "label": "Change only these keys", "default": False}],
       example={"adj": {"exposure": 0.2, "look": "film", "amount": 0.6}, "label": "Brighter film"})
def edit_set(photo, adj, label, merge):
    _exists(photo)
    if not isinstance(adj, dict):
        raise ValueError("adj must be an object such as {\"exposure\": 0.2}")
    return media.edit_set(photo, adj, label, merge)


@model("photo.edit.undo", "Undo", "photo", "Go back one history step.", device="cpu", mutating=True, fields=[PHOTO])
def edit_undo(photo):
    _exists(photo)
    return media.edit_go(photo, by=-1)


@model("photo.edit.redo", "Redo", "photo", "Go forward one history step.", device="cpu", mutating=True, fields=[PHOTO])
def edit_redo(photo):
    _exists(photo)
    return media.edit_go(photo, by=1)


@model("photo.edit.go", "Go to a history step", "photo", "Make a history step current (0 = the original). Later steps stay.",
       device="cpu", mutating=True, fields=[PHOTO, {"k": "pos", "type": "int", "label": "Step", "required": True, "min": 0}])
def edit_go(photo, pos):
    _exists(photo)
    return media.edit_go(photo, pos=pos)


@model("photo.edit.paste", "Copy an edit to other photos", "photo",
       "Copy one photo's edit to other photos (all of it, or some groups: light, colour, detail, effects, look). "
       "Each target gets a 'Pasted' history step, so it can be undone.", device="cpu", mutating=True,
       fields=[{"k": "source", "type": "photo", "label": "From photo", "required": True},
               {"k": "photos", "type": "strs", "label": "To photos", "required": True},
               {"k": "groups", "type": "strs", "label": "Only these groups (empty = everything)"}])
def edit_paste(source, photos, groups=None):
    _exists(source)
    for p in photos:
        _exists(p)
    out = media.edit_paste(source, photos, groups or None)
    return {"pasted": len(out), "photos": [o["photo"] for o in out], "adj": media.edit_get(source)["adj"]}


@model("photo.rate", "Flag or rate a photo", "photo",
       "Culling marks: flag pick / reject / none, and 0-5 stars. They change nothing in the photo.", device="cpu", mutating=True,
       fields=[PHOTO, {"k": "flag", "type": "choice", "label": "Flag", "choices": ["same", "pick", "reject", "none"], "default": "same"},
               {"k": "stars", "type": "int", "label": "Stars (-1 = same)", "default": -1, "min": -1, "max": 5}],
       example={"flag": "pick", "stars": 4})
def rate(photo, flag, stars):
    _exists(photo)
    f = {"same": None, "pick": 1, "reject": -1, "none": 0}[flag]
    return media.edit_rate(photo, f, None if stars < 0 else stars)


@model("photo.auto", "Auto settings", "photo",
       "Measure the photo (brightness, spread, black and white points, colour cast), choose ordinary slider values, "
       "and score the result against the original and a plain levels stretch. apply=true saves them as an 'Auto' step.",
       fields=[PHOTO, {"k": "apply", "type": "bool", "label": "Save as the photo's edit", "default": False}])
def auto(photo, apply):
    cur = _exists(photo)
    r = media.photo_auto(photo, cur["adj"])
    if apply:
        # Auto replaces the light and colour sliders; the look, detail and effects the user set stay
        keep = {k: v for k, v in cur["adj"].items() if k not in media.GROUPS["light"] + media.GROUPS["colour"]}
        r["edit"] = media.edit_set(photo, dict(keep, **r["adj"]), "Auto")
    return r


@model("photo.straighten", "Auto-straighten", "photo",
       "Find the tilt from the photo's straight lines (horizon, walls, poles) and score it: the share of edge strength "
       "that is level before and after, against chance. apply=true saves the angle as a 'Straighten' step.",
       fields=[PHOTO, {"k": "apply", "type": "bool", "label": "Save the angle as the photo's straighten", "default": False}])
def straighten(photo, apply):
    cur = _exists(photo)
    r = media.photo_straighten(photo, cur["adj"])
    if apply and r["clear"]:
        r["edit"] = media.edit_set(photo, {"angle": r["angle"]}, "Straighten {:+.2f}°".format(r["angle"]), merge=True)
    return r


@model("photo.batch", "Export many photos", "photo",
       "Develop many photos at full resolution; returns a zip. Either the same settings for all, or saved=true for each "
       "photo's own edit. With no ids, 'only' chooses: all, picks, unrejected, edited, or rated (1+ stars).",
       long=True, fields=[{"k": "photos", "type": "strs", "label": "Photo ids (empty = see 'only')"},
                          {"k": "only", "type": "choice", "label": "Which photos", "choices": ["all", "picks", "unrejected", "edited", "rated"],
                           "default": "all"},
                          {"k": "saved", "type": "bool", "label": "Each photo's own edit", "default": False}] + ADJ)
def batch(job, photos, look, only="all", saved=False, amount=1, **sl):
    if photos:
        ids = photos
    else:
        keep = {"all": lambda p: True, "picks": lambda p: p.get("flag") == 1, "unrejected": lambda p: p.get("flag") != -1,
                "edited": lambda p: p.get("edited"), "rated": lambda p: (p.get("stars") or 0) > 0}[only]
        ids = [p["id"] for p in media.photo_list() if keep(p)]
    if not ids:
        raise ValueError("no photos match ({})".format(only))
    return media.photo_batch(ids, _adj(look, None, amount, **sl), job, saved=saved)


@model("photo.similar", "Near-duplicates (perceptual hash)", "photo", "All pairs of photos whose 256-bit dHash is close, compared on the card.",
       fields=[{"k": "photos", "type": "strs", "label": "Photo ids (empty = all)"}])
def similar(photos):
    return media.photo_similar(photos or [p["id"] for p in media.photo_list()])


@model("photo.delete", "Delete a photo", "photo", "", device="cpu", mutating=True, fields=[PHOTO])
def delete(photo):
    media.photo_delete(photo)
    return {"deleted": photo}


# ---------------------------------------------------------------- CLIP (search by content)
def _clip():
    from .. import clip
    return clip


@model("photo.clip.status", "CLIP status", "photo", "If the CLIP model is available, the number of photos in the index, and the self-test.", device="cpu")
def clip_status():
    return _clip().status()


@model("photo.clip.install", "Install CLIP", "photo", "Download OpenAI's CLIP ViT-B/32 (605 MB, once) and convert it for the card.",
       long=True, mutating=True, device="cpu", timeout=3600)
def clip_install(job):
    return _clip().install(job)


@model("photo.clip.index", "Index photos for search", "photo", "Embed every photo not yet indexed with CLIP's image tower on the card.",
       long=True, mutating=True, timeout=3600)
def clip_index(job):
    return _clip().index(job)


@model("photo.clip.selftest", "CLIP self-test", "photo", "Run OpenAI's reference image and captions; compare with the published probabilities.")
def clip_selftest():
    try:
        return _clip().selftest()
    except FileNotFoundError:
        raise R.Refused("The CLIP weights are not on this machine. Install it first (photo.clip.install).", 409)


@model("photo.clip.search", "Find photos by words", "photo",
       "Rank photos by how well they match a description (CLIP text tower on the card). Each result has its similarity, "
       "its lift over a neutral control caption, and a z-score against the library.",
       fields=[{"k": "q", "type": "str", "label": "Description", "required": True},
               {"k": "top", "type": "int", "label": "Results", "default": 60, "min": 1, "max": 300}], example={"q": "a dog"})
def clip_search(q, top):
    return _clip().search_text(q, top)


@model("photo.clip.like", "More like this photo", "photo", "Photos nearest to one photo in CLIP space.", device="cpu",
       fields=[PHOTO, {"k": "top", "type": "int", "label": "Results", "default": 60, "min": 1, "max": 300}])
def clip_like(photo, top):
    return _clip().search_photo(photo, top)


@model("photo.clip.dupes", "Duplicate groups (CLIP)", "photo", "Groups of near-identical photos (bursts, re-saves, crops) and a suggested keeper.",
       fields=[{"k": "threshold", "type": "float", "label": "Similarity", "default": 0.93, "min": 0.8, "max": 0.995}])
def clip_dupes(threshold):
    return _clip().duplicates(threshold)


def first_photo():
    return _first()
