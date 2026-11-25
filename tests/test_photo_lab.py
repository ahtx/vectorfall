"""Photo Lab against a running server: the saved edit and its history, culling marks, paste, saved looks, Auto's
evidence, and that a tiled full-resolution export matches a 1:1 crop of the same pixels (no seams).

    VF_URL=http://localhost:8092 python3 tests/test_photo_lab.py        # needs Pillow (the image has it)
"""
import io
import json
import os
import sys
import time
import urllib.request
import uuid

from PIL import Image, ImageDraw

URL = os.environ.get("VF_URL", "http://localhost:8092").rstrip("/")


def call(path, body=None, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(URL + path, data=data, method="POST" if data is not None else "GET",
                                 headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(req, timeout=300) as r:
        return (r.read(), {k.lower(): v for k, v in r.headers.items()}) if raw else json.loads(r.read())


def m(_model, **p):
    return call("/api/photos/m/" + _model, p)


def upload(im, name):
    b = io.BytesIO()
    im.save(b, "JPEG", quality=92)
    bd = uuid.uuid4().hex
    body = ("--{0}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"{1}\"\r\nContent-Type: image/jpeg\r\n\r\n"
            .format(bd, name).encode() + b.getvalue() + "\r\n--{0}--\r\n".format(bd).encode())
    req = urllib.request.Request(URL + "/api/photos", data=body, method="POST",
                                 headers={"Content-Type": "multipart/form-data; boundary=" + bd})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())[0]["id"]


def delete(pid):
    urllib.request.urlopen(urllib.request.Request(URL + "/api/photos/" + pid, method="DELETE"), timeout=60).read()


def test_image(w=2400, h=1600):
    """A dull, slightly blue test photo with detail: gradients, shapes and text-like strokes."""
    im = Image.new("RGB", (w, h))
    px = im.load()
    for y in range(0, h, 4):
        for x in range(0, w, 4):
            v = int(70 + 60 * x / w + 30 * y / h)
            for dy in range(4):
                for dx in range(4):
                    px[x + dx, y + dy] = (v - 8, v, v + 14)
    d = ImageDraw.Draw(im)
    for i in range(40):
        d.ellipse([i * 57 % w, i * 91 % h, i * 57 % w + 120, i * 91 % h + 120], outline=(180, 170, 160), width=3)
        d.line([0, i * 40, w, h - i * 40], fill=(40, 45, 60), width=2)
    return im


def test_edit_history_and_marks(pid):
    e = m("edit", photo=pid)
    assert e["steps"] == 1 and not e["edited"] and e["adj"] == {}, e
    m("edit.set", photo=pid, adj={"exposure": 0.2}, label="Brighter")
    e = m("edit.set", photo=pid, adj={"look": "film", "amount": 0.5}, merge=True, label="Film 50%")
    assert e["adj"] == {"exposure": 0.2, "look": "film", "amount": 0.5} and e["pos"] == 2, e
    e = m("edit.undo", photo=pid)
    assert e["adj"] == {"exposure": 0.2} and e["can_redo"], e
    e = m("edit.redo", photo=pid)
    assert e["adj"]["look"] == "film", e
    e = m("edit.go", photo=pid, pos=0)
    assert e["adj"] == {} and e["steps"] == 3, e
    e = m("edit.set", photo=pid, adj={"contrast": 0.1}, label="New branch")      # drops the redo steps
    assert e["steps"] == 2 and [s["label"] for s in e["history"]] == ["Original", "New branch"], e
    e = m("edit.set", photo=pid, adj={"contrast": 0}, merge=True, label="Zero removes")
    assert e["adj"] == {}, e
    e = m("rate", photo=pid, flag="pick", stars=4)
    assert e["flag"] == 1 and e["stars"] == 4, e
    row = [p for p in call("/api/photos") if p["id"] == pid][0]
    assert row["flag"] == 1 and row["stars"] == 4, row
    e = m("rate", photo=pid, flag="none")
    assert e["flag"] == 0 and e["stars"] == 4, e
    try:
        m("edit.set", photo=pid, adj={"look": "no-such-look"})
        raise AssertionError("an unknown look must be refused")
    except urllib.error.HTTPError as x:
        assert x.code in (400, 422), x.code


def test_paste_groups(pid, pid2):
    m("edit.set", photo=pid, adj={"exposure": 0.3, "warmth": 0.2, "vignette": 0.4, "look": "cool"}, label="source")
    m("edit.set", photo=pid2, adj={"grain": 0.5, "exposure": -0.5}, label="target")
    r = m("edit.paste", source=pid, photos=[pid2], groups=["light"])
    assert r["pasted"] == 1
    a = m("edit", photo=pid2)["adj"]
    assert a == {"grain": 0.5, "exposure": 0.3}, a                              # light replaced, effects kept
    m("edit.undo", photo=pid2)
    assert m("edit", photo=pid2)["adj"] == {"grain": 0.5, "exposure": -0.5}


def test_saved_look(pid):
    r = m("look.save", name="Test Look {}".format(pid[:4]), adj={"warmth": 0.3, "vibrance": 0.2})
    name = r["look"]
    assert name in m("look.list")["user"]
    m("edit.set", photo=pid, adj={"look": name, "amount": 0.5}, label="use it")
    img, h = call("/api/photos/{}/render".format(pid), {"saved": True, "max": 256}, raw=True)
    assert json.loads(h["x-photo"])["w"] == 256
    m("look.delete", name=name)
    assert name not in m("look.list")["user"]


def test_auto(pid):
    r = m("auto", photo=pid)
    assert r["adj"] and r["why"], r
    for w in r["why"]:
        assert w["because"], w
    e = r["error"]
    assert e["auto"]["total"] < e["original"]["total"], e                      # a dull photo gets closer to the targets
    assert set(r["measured"]) == {"original", "auto", "levels_stretch"}
    r2 = m("auto", photo=pid, apply=True)
    assert r2["edit"]["history"][-1]["label"] == "Auto"


def _crop_diff(pid, adj, x0=1100, y0=700, w=300, h=200, border=0):  # noqa: E302
    full, _ = call("/api/photos/{}/render".format(pid), {"adj": adj, "full": True}, raw=True)
    a = Image.open(io.BytesIO(full)).convert("RGB")
    crop, _ = call("/api/photos/{}/render".format(pid), {"adj": dict(adj, _crop=[x0, y0, w, h]), "full": True}, raw=True)
    b = Image.open(io.BytesIO(crop)).convert("RGB")
    k = border
    pa = a.crop((x0 + k, y0 + k, x0 + w - k, y0 + h - k)).tobytes()
    pb = b.crop((k, k, w - k, h - k)).tobytes()
    return sum(abs(p - q) for p, q in zip(pa, pb)) / float(len(pa))


def test_tiles_match_crop(pid):
    """The export runs in strips and the 1:1 view in a padded tile; both must give the pixels of the whole image.
    The two JPEGs differ by their own compression even with no edit, so that is the baseline."""
    base = _crop_diff(pid, {})
    diff = _crop_diff(pid, {"clarity": 0.6, "vignette": 0.5, "sharpen": 0.8, "denoise": 0.3, "warmth": 0.2, "shadows": 0.3})
    assert diff < base + 0.4, "a 1:1 crop differs from the full export by {:.2f} (JPEG alone: {:.2f})".format(diff, base)


def test_grain_is_stable(pid):
    body = {"adj": {"grain": 0.6, "look": "noir"}, "max": 512}
    a, _ = call("/api/photos/{}/render".format(pid), body, raw=True)
    b, _ = call("/api/photos/{}/render".format(pid), body, raw=True)
    assert a == b, "two renders of the same settings differ (grain must not flicker)"


def _render(pid, adj, **o):
    data, h = call("/api/photos/{}/render".format(pid), dict({"adj": adj}, **o), raw=True)
    return Image.open(io.BytesIO(data)).convert("RGB"), json.loads(h["x-photo"])


def _mean(im, box):
    px = list(im.crop(box).convert("RGB").tobytes())
    return sum(px) / float(len(px))


def test_crop_turn_flip(pid):
    """A crop is the same pixels as the original's region; a quarter turn swaps the sides; flip mirrors."""
    orig, _ = _render(pid, {}, full=True)
    a, m = _render(pid, {"crop_box": [0.25, 0.25, 0.75, 0.75]}, full=True)
    assert a.size == (1200, 800) and m["geom"]["frame"] == [1200, 800], (a.size, m["geom"])
    base = _crop_diff(pid, {})
    d = sum(abs(p - q) for p, q in zip(a.tobytes(), orig.crop((600, 400, 1800, 1200)).tobytes())) / float(len(a.tobytes()))
    assert d < base + 0.6, "a crop differs from the original's region by {:.2f} (JPEG alone {:.2f})".format(d, base)
    b, m = _render(pid, {"turn": 1}, full=True)
    assert b.size == (1600, 2400), b.size
    c, _ = _render(pid, {"flip": True}, max=600)
    o6, _ = _render(pid, {}, max=600)
    assert abs(_mean(c, (0, 0, 60, 400)) - _mean(o6, (540, 0, 600, 400))) < 3


def test_straighten_and_fit(pid_tilt):
    """A horizon turned 4° counter-clockwise: Auto-straighten finds +4°, the crop shrinks to stay inside, and the
    result is level (straighten on the result says so)."""
    r = m("straighten", photo=pid_tilt)
    assert r["clear"] and abs(r["angle"] - 4.0) < 0.15, r["sentence"]
    img, meta = _render(pid_tilt, {"angle": r["angle"]}, full=True)
    g = meta["geom"]
    assert g["fitted"] and g["frame"][0] < 1600 and abs(g["frame"][0] / g["frame"][1] - 1.6) < 0.01, g
    p2 = upload(img, "test-photo-lab-level.jpg")
    try:
        r2 = m("straighten", photo=p2)
        assert r2["angle"] == 0 and r2["clear"], r2["sentence"]
    finally:
        delete(p2)
    flat = upload(Image.new("RGB", (800, 600), (128, 128, 128)), "test-photo-lab-flat.jpg")
    try:
        assert not m("straighten", photo=flat)["clear"]                  # no lines: no claim
    finally:
        delete(flat)


def test_masks(pid):
    """Local exposure: a radial mask brightens its centre only; invert does the opposite; a linear mask fades from
    full to none between its two points; a brush paints where it was painted; the O view paints the mask red."""
    o, _ = _render(pid, {}, max=600)
    W, H = o.size
    ctr, cor = (W // 2 - 20, H // 2 - 20, W // 2 + 20, H // 2 + 20), (0, 0, 40, 40)
    rad = {"type": "radial", "x": 0.5, "y": 0.5, "rx": 0.2, "ry": 0.2, "feather": 0.3, "adj": {"exposure": 0.8}}
    a, _ = _render(pid, {"masks": [rad]}, max=600)
    assert _mean(a, ctr) > _mean(o, ctr) + 20 and abs(_mean(a, cor) - _mean(o, cor)) < 2
    b, _ = _render(pid, {"masks": [dict(rad, invert=True)]}, max=600)
    assert abs(_mean(b, ctr) - _mean(o, ctr)) < 2 and _mean(b, cor) > _mean(o, cor) + 20
    lin = {"type": "linear", "x0": 0.5, "y0": 0.0, "x1": 0.5, "y1": 0.5, "adj": {"exposure": -0.8}}
    c, _ = _render(pid, {"masks": [lin]}, max=600)
    top, bot = (0, 0, W, 10), (0, H - 10, W, H)
    assert _mean(c, top) < _mean(o, top) - 15 and abs(_mean(c, bot) - _mean(o, bot)) < 2
    br = {"type": "brush", "dabs": [[0.1, 0.9, 0.05, 0.3, 0], [0.12, 0.9, 0.05, 0.3, 0]], "adj": {"exposure": 1.0}}
    d, _ = _render(pid, {"masks": [br]}, max=600)
    spot = (int(W * 0.1) - 5, int(H * 0.9) - 5, int(W * 0.1) + 5, int(H * 0.9) + 5)
    assert _mean(d, spot) > _mean(o, spot) + 20 and abs(_mean(d, ctr) - _mean(o, ctr)) < 2
    e, _ = _render(pid, {"masks": [rad], "_mask_view": 0}, max=600)
    r, g, bb = e.crop(ctr).resize((1, 1)).getpixel((0, 0))
    assert r > g + 60 and r > bb + 60, (r, g, bb)
    v = m("edit.set", photo=pid, adj={"masks": [rad, lin]}, label="two masks")
    assert len(v["adj"]["masks"]) == 2 and v["adj"]["masks"][0]["adj"] == {"exposure": 0.8}
    try:
        m("edit.set", photo=pid, adj={"masks": [dict(rad, adj={"vignette": 1})]})
        raise AssertionError("a slider that masks do not have must be refused")
    except urllib.error.HTTPError as x:
        assert x.code == 400, x.code
    m("edit.set", photo=pid, adj={}, label="clear")


def test_geometry_tiles_match(pid):
    """With a rotation, a crop and a mask, a 1:1 window and the same pixels of the tiled export still agree."""
    adj = {"angle": 3.0, "crop_box": [0.1, 0.1, 0.9, 0.9], "clarity": 0.5, "sharpen": 0.6,
           "masks": [{"type": "radial", "x": 0.5, "y": 0.5, "rx": 0.3, "ry": 0.3, "feather": 0.5, "adj": {"exposure": 0.5, "clarity": 0.4}}]}
    # a window on the 16-pixel JPEG grid of the export: then the two JPEGs code the same blocks, and only real
    # differences remain (measured: the pixels are identical before JPEG)
    diff = _crop_diff(pid, adj, 608, 400, 304, 208, border=16)
    assert diff < 0.3, "rotated 1:1 window vs export {:.2f}".format(diff)


def tilted_image(w=1600, h=1000, deg=4):
    """A horizon with furrows and a few posts, turned deg degrees counter-clockwise (made larger, then cut out, so
    the turned borders do not show)."""
    W, H = w * 3 // 2, h * 3 // 2
    im = Image.new("RGB", (W, H), (120, 150, 190))
    d = ImageDraw.Draw(im)
    d.rectangle([0, H // 2, W, H], fill=(90, 80, 60))
    for i in range(12):
        d.line([0, H // 2 + 40 + i * 45, W, H // 2 + 40 + i * 45], fill=(40, 35, 30), width=4)
    for i in range(14):
        d.line([100 + i * 170, H // 6, 100 + i * 170, H * 5 // 6], fill=(50, 40, 30), width=6)
    im = im.rotate(deg, resample=Image.BICUBIC)
    return im.crop(((W - w) // 2, (H - h) // 2, (W - w) // 2 + w, (H - h) // 2 + h))


def test_speed(pid):
    ms = []
    for i in range(5):
        _, h = call("/api/photos/{}/render".format(pid), {"adj": {"exposure": 0.01 * i, "contrast": 0.1}, "max": 1024}, raw=True)
        ms.append(json.loads(h["x-photo"])["ms"])
    med = sorted(ms)[2]
    assert med < 150, "a 1024 px preview took {} ms of card time".format(med)
    print("    preview 1024 px: card {} ms (median of 5)".format(med))


def main():
    pid = upload(test_image(), "test-photo-lab.jpg")
    pid2 = upload(test_image(800, 600), "test-photo-lab-2.jpg")
    pid3 = upload(tilted_image(), "test-photo-lab-tilt.jpg")
    ok = bad = 0
    try:
        for name, fn, args in [("edit_history_and_marks", test_edit_history_and_marks, (pid,)), ("paste_groups", test_paste_groups, (pid, pid2)),
                               ("saved_look", test_saved_look, (pid,)), ("auto", test_auto, (pid2,)),
                               ("tiles_match_crop", test_tiles_match_crop, (pid,)),
                               ("grain_is_stable", test_grain_is_stable, (pid,)), ("crop_turn_flip", test_crop_turn_flip, (pid,)),
                               ("straighten_and_fit", test_straighten_and_fit, (pid3,)), ("masks", test_masks, (pid,)),
                               ("geometry_tiles_match", test_geometry_tiles_match, (pid,)), ("speed", test_speed, (pid,))]:
            t0 = time.time()
            try:
                fn(*args)
                ok += 1
                print("  PASS  {:<28} {:.1f} s".format(name, time.time() - t0))
            except Exception as e:  # noqa: BLE001
                bad += 1
                print("  FAIL  {:<28} {}".format(name, e))
    finally:
        delete(pid)
        delete(pid2)
        delete(pid3)
    print("{} passed, {} failed".format(ok, bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
