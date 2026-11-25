"""The text formats of the Reservoir and Particle Lab problems (app/labtpl.py): what they read, and that each mistake
names its line. CPU only.  python3 tests/test_labtpl.py  (or pytest)"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app import labtpl as L  # noqa: E402


def _err(fn, *a):
    try:
        fn(*a)
    except ValueError as e:
        return str(e)
    raise AssertionError("no error")


def test_series():
    v = L.read_series("visitors\n" + "\n".join(str(i % 7) for i in range(150)))
    assert len(v) == 150
    v = L.read_series("\n".join("2024-01-%02d,%d" % (1 + i % 28, i) for i in range(130)))
    assert v[-1] == 129
    assert _err(L.read_series, "a\n1\n2\nx\n").startswith("line 4")
    assert "at least 120" in _err(L.read_series, "1\n2\n3")


def test_labelled():
    kind, rows = L.read_labelled("a, 1 2 3 4\na, 2 3 4 5\nb, 9 8 7 6\nb, 1 1 2 2")
    assert kind == "numbers" and len(rows) == 4
    kind, rows = L.read_labelled("knock, kitchen.wav, 7.0, 7.6\nknock, kitchen.wav, 15.5, 16\nquiet, kitchen.wav, 1, 2\nquiet, kitchen.wav, 3, 4")
    assert kind == "audio" and rows[0][2]["start"] == 7.0
    assert _err(L.read_labelled, "a, 1 2 3 4\na, 1 2 x 4\nb, 1 2 3 4\nb, 1 2 3 4").startswith("line 2")
    assert _err(L.read_labelled, "a, 1 2 3 4\na, 1 2 3 4\nb, clip.wav\nb, 1 2 3 4").startswith("line 3")
    assert "at least two" in _err(L.read_labelled, "a, 1 2 3 4\na, 2 3 4 5")
    assert "too few: b" in _err(L.read_labelled, "a, 1 2 3 4\na, 2 3 4 5\nb, 1 2 3 4")


def test_group():
    long_ = "date,team,points,league\n" + "\n".join("%d,%s,%d,%s" % (y, t, 10 + y - 2018 + i, "N" if i < 2 else "S")
                                                     for y in range(2018, 2024) for i, t in enumerate("ABCD"))
    P = L.read_group(long_)
    assert len(P["name"]) == 4 and len(P["dates"]) == 6 and set(P["sector"]) == {"N", "S"}
    P = L.read_group("date,A,B,C\n2020,1,2,3\n2021,2,3,4\n2022,3,4,5\n2023,4,5,6")
    assert P["name"] == ["A", "B", "C"]
    assert _err(L.read_group, "date,A,B,C\n2020,1,2,3\n2021,1,x,3\n2022,1,2,3\n2023,1,2,3").startswith("line 3, column 3")
    assert _err(L.read_group, "date,A,B,C\nyesterday,1,2,3\n2021,1,2,3\n2022,1,2,3\n2023,1,2,3").startswith("line 2")


def test_check():
    assert L.check("group", "date,A,B\n2020,1,2")["ok"] is False
    assert L.check("updown", "\n".join(str(i % 5) for i in range(200)))["ok"]


if __name__ == "__main__":
    for n, f in sorted(globals().items()):
        if n.startswith("test_"):
            f()
            print("PASS", n)
