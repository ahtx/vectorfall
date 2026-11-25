"""Loudness meter (app/loudness.py) against the EBU test signals (Tech 3341 / 3342) and BS.1770's published filter.

    python3 -m pytest tests/test_loudness.py          # numpy + scipy, no GPU
"""
import importlib.util
import os

import numpy as np

_spec = importlib.util.spec_from_file_location("loudness", os.path.join(os.path.dirname(__file__), "..", "app", "loudness.py"))
L = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(L)


def sine(db, seconds, fs=48000, f=1000.0):
    t = np.arange(int(seconds * fs)) / float(fs)
    x = 10 ** (db / 20.0) * np.sin(2 * np.pi * f * t)
    return np.stack([x, x]).astype(np.float32)


def test_k_filter_matches_bs1770_at_48k():
    (b1, a1), (b2, a2) = L._kfilters(48000)
    assert np.allclose(b1, [1.53512485958697, -2.69169618940638, 1.19839281085285], atol=1e-8)
    assert np.allclose(a1, [1.0, -1.69065929318241, 0.73248077421585], atol=1e-8)
    assert np.allclose(b2, [1.0, -2.0, 1.0]) and np.allclose(a2, [1.0, -1.99004745483398, 0.99007225036621], atol=1e-8)


def test_ebu_3341_case_1_and_2():                      # stereo 1 kHz sine at -23 and -33 dBFS -> -23 / -33 LUFS (+-0.1)
    for fs in (48000, 44100):
        for lv in (-23.0, -33.0):
            m = L.measure(sine(lv, 20, fs), fs)
            for k in ("integrated", "momentary_max", "short_term_max"):
                assert abs(m[k] - lv) <= 0.1, (fs, lv, k, m[k])


def test_ebu_3341_case_3_relative_gate():              # -36 / -23 / -36 dBFS for 10 / 60 / 10 s -> -23 LUFS
    x = np.concatenate([sine(-36, 10), sine(-23, 60), sine(-36, 10)], 1)
    assert abs(L.measure(x, 48000)["integrated"] + 23.0) <= 0.1


def test_ebu_3341_case_5_absolute_gate():              # -26 / -20 / -26 dBFS for 20 / 20.1 / 20 s -> -23 LUFS
    x = np.concatenate([sine(-26, 20), sine(-20, 20.1), sine(-26, 20)], 1)
    assert abs(L.measure(x, 48000)["integrated"] + 23.0) <= 0.1


def test_ebu_3342_lra():                               # 20 s at -20 then 20 s at -30 dBFS -> LRA 10 LU (+-1)
    x = np.concatenate([sine(-20, 20), sine(-30, 20)], 1)
    assert abs(L.measure(x, 48000)["lra"] - 10.0) <= 1.0


def test_silence_and_true_peak():
    m = L.measure(np.zeros((2, 48000), np.float32), 48000)
    assert m["integrated"] is None and m["true_peak_db"] is None
    fs = 48000                                         # fs/4 sine at 45 degrees: samples at -3 dB, true peak 0 dB of its amplitude
    t = np.arange(fs) / float(fs)
    x = 0.5 * np.sin(2 * np.pi * fs / 4 * t + np.pi / 4)
    m = L.measure(np.stack([x, x]).astype(np.float32), fs)
    assert abs(m["sample_peak_db"] - (-9.03)) < 0.05 and abs(m["true_peak_db"] - (-6.02)) < 0.4


def test_gain_to_target_respects_the_peak_ceiling():
    m = {"integrated": -30.0, "true_peak_db": -3.0}
    assert L.gain_to(m, -16, -1) == (2.0, True)
    assert L.gain_to({"integrated": -20.0, "true_peak_db": -10.0}, -16, -1) == (4.0, False)
