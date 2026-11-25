"""The library lists of every media lab, each with at least one item present, against a running server.

An empty library hides bugs in the per-item code (2026-11-23: a block for photos was pasted into the sound and table
lists and raised NameError only when a sound or a table existed). So this test adds one photo, one sound and one
table, lists every library through the UI routes and through /v1, and removes what it added.

    VF_URL=http://localhost:8092 python3 tests/test_media_lists.py        # standard library only
"""
import io
import json
import math
import os
import struct
import sys
import urllib.request
import uuid
import wave
import zlib

URL = os.environ.get("VF_URL", "http://localhost:8092").rstrip("/")


def req(method, path, body=None, ctype=None):
    h = {"Content-Type": ctype} if ctype else {}
    r = urllib.request.Request(URL + path, data=body, method=method, headers=h)
    with urllib.request.urlopen(r, timeout=120) as f:
        return json.loads(f.read() or b"null")


def upload(path, field, name, data, mime):
    bd = uuid.uuid4().hex
    body = ("--{0}\r\nContent-Disposition: form-data; name=\"{1}\"; filename=\"{2}\"\r\nContent-Type: {3}\r\n\r\n"
            .format(bd, field, name, mime).encode() + data + "\r\n--{0}--\r\n".format(bd).encode())
    return req("POST", path, body, "multipart/form-data; boundary=" + bd)


def tiny_png(w=64, h=48):
    raw = b"".join(b"\x00" + b"".join(bytes((x * 4 % 256, y * 5 % 256, 128)) for x in range(w)) for y in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) +
            chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def tiny_wav(seconds=1.0, sr=22050):
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / sr))) for i in range(int(sr * seconds))))
    return b.getvalue()


def main():
    tag = uuid.uuid4().hex[:6]
    made, bad = [], 0
    try:
        p = upload("/api/photos", "files", "lists-{}.png".format(tag), tiny_png(), "image/png")[0]
        made.append(("/api/photos/" + p["id"], "photo"))
        s = upload("/api/sounds", "file", "lists-{}.wav".format(tag), tiny_wav(), "audio/wav")
        sid = s.get("id") or (s.get("sound") or {}).get("id")
        made.append(("/api/sounds/" + sid, "sound"))
        t = upload("/api/tables", "file", "lists-{}.csv".format(tag), b"a,b\n1,2\n3,4\n5,6\n", "text/csv")
        tid = t.get("id") or (t.get("table") or {}).get("id")
        made.append(("/api/tables/" + tid, "table"))
        for path, model, want in (("/api/photos", "photo.list", p["id"]), ("/api/sounds", "sound.list", sid),
                                  ("/api/tables", "data.list", tid)):
            for how in ("ui", "v1"):
                try:
                    if how == "ui":
                        rows = req("GET", path)
                    else:
                        rows = req("POST", "/v1/models/" + model, b"{}", "application/json")["result"]
                    ids = [r.get("id") for r in rows]
                    assert want in ids, "{} is not in the list".format(want)
                    print("  PASS  {:<12} via {:<3} {} items".format(model, how, len(rows)))
                except Exception as e:  # noqa: BLE001
                    bad += 1
                    print("  FAIL  {:<12} via {:<3} {}".format(model, how, e))
    finally:
        for path, _ in made:
            try:
                req("DELETE", path)
            except Exception as e:  # noqa: BLE001
                print("  (could not remove {}: {})".format(path, e))
    print("{} failed".format(bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
