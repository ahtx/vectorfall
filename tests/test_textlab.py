"""Text Lab unit tests: BPE, the count model, the sampling rules and the pipeline checker (no corpus, no card).

    python3 tests/test_textlab.py          # in the container, from /srv (the module imports the Text Engine)
    python3 -m pytest tests/test_textlab.py
"""
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from app import textlab as tl  # noqa: E402


def test_bpe_learns_the_commonest_pair_first_and_round_trips():
    text = "low lower lowest low low newer newest new " * 50
    b = tl.BPE(text, merges=30)
    assert b.merges[0][:2] in (("l", "o"), ("▁", "l"), ("e", "w"), ("w", "e"))
    toks = b.encode("lowest newer")
    assert tl.BPE.decode(toks) == "lowest newer"
    assert len(toks) < len("lowest newer")            # merges make tokens longer than one character
    final, steps = b.encode_piece(" lowest", trace=True)
    assert steps[0] == list("▁lowest") and final == steps[-1]["pieces"]


def test_count_model_is_a_distribution_and_matches_its_vector_logprob():
    rng = np.random.RandomState(0)
    seq = rng.randint(0, 12, 5000)
    seq[1::3] = (seq[0::3][:seq[1::3].size] + 1) % 12   # some structure to learn
    lm = tl.CountLM(seq, 12, order=3)
    for h in ([], [3], [3, 4], [11, 11]):
        p = lm.dist(list(h))
        assert abs(p.sum() - 1) < 1e-9 and (p > 0).all()
    test = rng.randint(0, 12, 200)
    lp = lm.logprob(test)
    one = [math.log(lm.dist(list(test[max(0, i - 2):i]))[test[i]]) for i in range(test.size)]
    assert np.allclose(lp, one, atol=1e-9)
    uni = np.log(lm.p0[test]).mean()
    assert lm.logprob(seq[:1000]).mean() > uni        # context helps on the training text


def test_sampling_rules():
    p = np.array([0.5, 0.25, 0.15, 0.07, 0.03])
    assert tl.shape(p, 0)[0] == 1.0                                   # temperature 0 = the best word only
    assert (tl.shape(p, 1.0, top_k=2) > 0).sum() == 2
    assert (tl.shape(p, 1.0, top_p=0.7) > 0).sum() == 2               # 0.5 + 0.25 holds 70%
    assert (tl.shape(p, 1.0, min_p=0.25) > 0).sum() == 3              # >= 0.125
    hot, cold = tl.shape(p, 2.0), tl.shape(p, 0.5)
    assert hot[0] < p[0] < cold[0] and abs(hot.sum() - 1) < 1e-12


def test_pipeline_check_fills_defaults_and_names_the_problems():
    p, problems, _w = tl.check({})
    assert not problems and p["tokenizer"] == "word" and p["scorers"][0]["kind"] == "ngram"
    _p, problems, _w = tl.check({"tokenizer": "char", "scorers": [{"kind": "neural", "weight": 1}]})
    assert any("word tokenizer" in x for x in problems) and any("probability scorer" in x for x in problems)
    _p, problems, _w = tl.check({"sampling": {"temperature": 9}})
    assert any("temperature" in x for x in problems)
    _p, problems, _w = tl.check('{"bad json')
    assert problems
    for name, spec in tl.PRESETS.items():
        assert not tl.check(spec)[1], name


def test_resolve_merges_changes_onto_a_preset():
    p = tl.resolve("Kneser-Ney 5-gram", {"sampling": {"temperature": 1.3}})
    assert p["scorers"][0]["order"] == 5 and p["sampling"]["temperature"] == 1.3
    try:
        tl.resolve("no such pipeline at all")
        raise AssertionError("a missing pipeline must be refused")
    except tl.Bad:
        pass


def test_rhyme_key():
    assert tl.rhyme_key("night") == tl.rhyme_key("light") == "ight"
    assert tl.rhyme_key("sea") == tl.rhyme_key("tea")



def test_ban_and_include_on_characters():
    import re
    text = "the cat and the dog saw the whale near the sea and the ship. " * 40
    chars = ["<unk>"] + sorted(set(text))
    ids = {ch: i for i, ch in enumerate(chars)}
    seq = np.array([ids[ch] for ch in text], np.int64)
    lm = tl.CountLM(seq, len(chars), order=4)

    class S:                                       # a scorer set over the count model, as _Sub gives it
        tm = {"names": chars, "enc": lambda t: [ids.get(ch, 0) for ch in t], "dec": lambda q: "".join(chars[i] for i in q if i)}

        @staticmethod
        def dist(h, v=None, parts_out=None):
            q = lm.dist(list(h)).copy()
            q[0] = 0
            return q / q.sum()
    p, problems, _w = tl.check({"tokenizer": "char", "scorers": [{"kind": "ngram", "order": 4, "weight": 1}],
                                "constraints": {"length": 200, "stop": "none", "ban": ["the"], "include": ["ship"]}})
    assert not problems
    for seed in range(3):
        r = tl._sample_sub(S, p, "a ", np.random.RandomState(seed))
        out = r["text"][2:].lower()
        assert not re.search(r"(?<![a-z'])the(?![a-z'])", out[:-4]), out
        assert r["include"] == {"ship": True}, out


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok", t.__name__)
    print(len(tests), "passed")
