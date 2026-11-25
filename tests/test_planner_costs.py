"""Routes from cost tables (app/planner.py): the two text shapes, the line numbers in errors, one-way costs, and the
local search against the exact optimum. CPU only.  python3 tests/test_planner_costs.py  (or pytest)"""
import itertools
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app import planner as P  # noqa: E402


def test_matrix_and_edges():
    names, D, notes = P.read_costs("from,A,B,C\nA,0,1,2\nB,1,0,x\nC,2,3,0")
    assert names == ["A", "B", "C"] and D[0, 2] == 2 and np.isnan(D[1, 2]) and D[2, 1] == 3
    names, D, notes = P.read_costs("from,to,min\nA,B,4\nB,C,5\nC,A,6\nA,C,9")
    assert D[0, 1] == D[1, 0] == 4 and D[2, 0] == 6 and D[0, 2] == 9 and notes


def test_errors_name_the_line():
    for text, start in (("from,A,B\nA,0,1\nZ,1,0", "line 3"), ("from,A,B,C\nA,0,1\nB,1,0,2\nC,1,2,0", "line 2"),
                        ("from,to,cost\nA,B,abc", "line 2"), ("from,A,B\nA,0,-1\nB,1,0", "line 2, column 3")):
        try:
            P.read_costs(text)
        except ValueError as e:
            assert str(e).startswith(start), (text, str(e))
        else:
            raise AssertionError("no error for " + text)


def test_local_search_and_exact():
    rs = np.random.RandomState(3)
    for _ in range(25):
        n = rs.randint(4, 9)
        D = rs.randint(1, 60, (n, n)).astype(float)
        np.fill_diagonal(D, 0)
        for rt in (True, False):
            o = P._two_opt(P._nn(D), D, rt)
            assert o[0] == 0 and sorted(o) == list(range(n))
            L = P._tour_len(o, D, rt)
            hk = P._held_karp(D, rt)
            bf = min(P._tour_len([0] + list(p), D, rt) for p in itertools.permutations(range(1, n)))
            assert abs(hk[1] - bf) < 1e-9 and L >= bf - 1e-9 and L <= P._tour_len(P._nn(D), D, rt) + 1e-9


def test_check():
    ok = P.check("route", {"costs": "from,A,B,C,D\nA,0,1,2,3\nB,1,0,3,2\nC,2,3,0,1\nD,3,2,9,0", "unit": "min"})
    assert ok["ok"] and "one-way" in ok["facts"][0]
    bad = P.check("teams", {"people": "name,score\nA,1", "k": 4})
    assert not bad["ok"] and "teams" in bad["error"]


if __name__ == "__main__":
    for n, f in sorted(globals().items()):
        if n.startswith("test_"):
            f()
            print("PASS", n)
