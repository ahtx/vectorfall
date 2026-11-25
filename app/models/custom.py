"""Declarative custom projections through the existing series and state engines."""
import time

import numpy as np

from .. import formula as scenario, simulate
from ..registry import model


@model("sim.custom", "Custom projection", "sim",
       "Choose series/Markov or state-chain Monte Carlo, with sourced inputs, units, perturbations and a seed.",
       fields=[
           {"k": "model", "type": "choice", "label": "Model", "choices": ["series", "states"], "default": "series", "required": True},
           {"k": "series", "type": "text", "label": "Numeric series (series model)", "default": ""},
           {"k": "states", "type": "str", "label": "States (state model)", "default": ""},
           {"k": "transitions", "type": "text", "label": "Transitions: From -> To : chance", "default": ""},
           {"k": "start", "type": "str", "label": "Start state", "default": ""},
           {"k": "horizon", "type": "int", "label": "Steps ahead", "default": 60, "min": 1, "max": 500},
           {"k": "delta", "type": "choice", "label": "Measure change as", "choices": ["absolute", "percent", "log"], "default": "percent"},
           {"k": "bins", "type": "int", "label": "Bins", "default": 7, "min": 3, "max": 20},
           {"k": "conditional", "type": "bool", "label": "Markov (bin depends on last)", "default": True},
           {"k": "vol", "type": "float", "label": "Volatility multiplier", "default": 1.0, "min": 0.5, "max": 2.5},
           {"k": "persist", "type": "float", "label": "Regime persistence", "default": 0.0, "min": -1.0, "max": 1.0},
           {"k": "drift", "type": "float", "label": "Drift per step", "default": 0.0, "min": -0.5, "max": 0.5},
           {"k": "window", "type": "int", "label": "Learn from last N observations (0 = all)", "default": 0, "min": 0, "max": 5000},
           {"k": "unit", "type": "str", "label": "Unit", "default": ""},
           {"k": "seed", "type": "int", "label": "Random seed (0 = new each run)", "default": 0, "min": 0, "max": 2147483647},
       ])
def custom(model, series, states, transitions, start, horizon, delta, bins, conditional, vol, persist, drift, window, unit, seed):
    if seed:
        import cupy as cp
        cp.random.seed(seed)
    params = {"horizon": horizon, "unit": unit}
    if model == "series":
        if not series.strip():
            raise ValueError("a numeric series is required")
        params.update(series=simulate.parse_series(series), delta=delta, bins=bins, conditional=conditional, vol=vol, persist=persist, drift=drift, window=window)
        result = simulate.series(params)
    elif model == "states":
        if not states.strip() or not transitions.strip():
            raise ValueError("states and transitions are required")
        params.update(states=states, transitions=transitions, start=start, steps=horizon)
        result = simulate.states(params)
    else:
        raise ValueError("unknown model family")
    if isinstance(result.get("chart"), dict):
        result["chart"]["unit"] = unit
    result["custom"] = {"model": model, "unit": unit, "seed": seed, "horizon": horizon}
    return result


@model("sim.counts", "Count scenarios", "sim",
       "Monte Carlo of a count under explicit inflow/outflow rate assumptions. Use for illustrative procurement, production, retirement, adoption or decline scenarios without inventing a historical series.",
       fields=[
           {"k": "start", "type": "float", "label": "Initial count", "required": True, "min": 0, "max": 1e15},
           {"k": "inflow_low", "type": "float", "label": "Minimum inflow per step", "required": True, "min": 0, "max": 1e12},
           {"k": "inflow_high", "type": "float", "label": "Maximum inflow per step", "required": True, "min": 0, "max": 1e12},
           {"k": "outflow_low", "type": "float", "label": "Minimum outflow per step", "required": True, "min": 0, "max": 1e12},
           {"k": "outflow_high", "type": "float", "label": "Maximum outflow per step", "required": True, "min": 0, "max": 1e12},
           {"k": "basis", "type": "str", "label": "Source or explicit scenario rationale", "required": True},
           {"k": "horizon", "type": "int", "label": "Steps ahead", "default": 10, "min": 1, "max": 500},
           {"k": "distribution", "type": "choice", "label": "Rate distribution", "choices": ["uniform", "triangular"], "default": "triangular"},
           {"k": "unit", "type": "str", "label": "Count unit", "default": "units"},
           {"k": "paths", "type": "int", "label": "Simulated paths", "default": 10000, "min": 100, "max": 50000},
           {"k": "seed", "type": "int", "label": "Random seed (0 = new each run)", "default": 0, "min": 0, "max": 2147483647},
       ])
def counts(start, inflow_low, inflow_high, outflow_low, outflow_high, basis, horizon, distribution, unit, paths, seed):
    import cupy as cp
    if inflow_low > inflow_high or outflow_low > outflow_high:
        raise ValueError("each minimum rate must be no greater than its maximum")
    if max(inflow_low, inflow_high, outflow_low, outflow_high) == 0:
        raise ValueError("a count scenario needs a nonzero inflow or outflow; use sim_formula for growth-rate or ratio equations")
    if not basis.strip():
        raise ValueError("state the source or explicit rationale for these rate assumptions")
    if paths * horizon > 10_000_000:
        raise ValueError("paths × horizon is limited to 10 million cells; reduce one of them")
    if seed:
        cp.random.seed(seed)
    t0 = time.time()
    shape = (paths, horizon)
    if distribution == "uniform":
        incoming = cp.random.uniform(inflow_low, inflow_high, shape)
        outgoing = cp.random.uniform(outflow_low, outflow_high, shape)
    else:
        incoming = cp.random.triangular(inflow_low, (inflow_low + inflow_high) / 2, inflow_high, shape)
        outgoing = cp.random.triangular(outflow_low, (outflow_low + outflow_high) / 2, outflow_high, shape)
    trajectory = cp.empty((paths, horizon + 1), cp.float64)
    trajectory[:, 0] = start
    trajectory[:, 1:] = cp.maximum(0, start + cp.cumsum(incoming - outgoing, axis=1))
    values = cp.asnumpy(trajectory)
    bands = np.percentile(values, [5, 25, 50, 75, 95], axis=0).T.tolist()
    final = values[:, -1]
    median, low, high = (float(x) for x in np.percentile(final, [50, 5, 95]))
    fmt = lambda value: "{:.4g}".format(value)
    sentence = ("An illustrative scenario, not a forecast: from {}, the median count after {} steps is {} {} "
                "(5–95% range {}–{}). Inflow/outflow rates were sampled independently from the stated {} ranges; counts cannot fall below zero. "
                "Basis: {}").format(fmt(start), horizon, fmt(median), unit, fmt(low), fmt(high), distribution, basis.strip())
    return {"headline": fmt(median) + " " + unit, "sentence": sentence, "tone": "good",
            "chart": {"type": "fan", "x": list(range(horizon + 1)), "bands": bands, "unit": unit, "title": "Explicit count scenario"},
            "chart2": {"type": "hist", "edges": np.histogram(final, 40)[1].tolist(), "y": np.histogram(final, 40)[0].tolist(), "title": "Final count distribution"},
            "facts": [["initial", fmt(start)], ["inflow/step", "{}–{}".format(fmt(inflow_low), fmt(inflow_high))],
                      ["outflow/step", "{}–{}".format(fmt(outflow_low), fmt(outflow_high))], ["distribution", distribution],
                      ["basis", basis.strip()], ["seed", seed or "random"]],
            "paths": paths, "ms": round((time.time() - t0) * 1000, 1),
            "scenario": {"kind": "count", "start": start, "inflow": [inflow_low, inflow_high],
                         "outflow": [outflow_low, outflow_high], "distribution": distribution,
                         "basis": basis.strip(), "horizon": horizon, "seed": seed}}


@model("sim.formula", "Declarative scenario", "sim",
       "Evaluate a bounded JSON scenario: initial variables, sampled rates, ordered numerical equations and outputs. Approved functions: min, max, abs, sqrt, exp, log, pow, clip, where, floor, ceil, round, and_, or_, not_, uniform, normal, triangular, choice. Use choice(a,b,...) for an equal-weight ensemble of up to 12 published alternatives, not a time series or calibrated probabilities. Use static:true for a rate sampled once per path.",
       fields=[
           {"k": "initial", "type": "json", "label": "Initial variables", "required": True},
           {"k": "rates", "type": "json", "label": "Sampled variables and distributions", "default": {}},
           {"k": "equations", "type": "json", "label": "Ordered per-step formulas", "required": True},
           {"k": "outputs", "type": "strs", "label": "Output variables", "required": True},
           {"k": "basis", "type": "str", "label": "Source or explicit scenario rationale", "required": True},
           {"k": "horizon", "type": "int", "label": "Steps ahead", "default": 10, "min": 1, "max": 500},
           {"k": "unit", "type": "str", "label": "Primary output unit", "default": "units"},
           {"k": "paths", "type": "int", "label": "Simulated paths", "default": 10000, "min": 100, "max": 50000},
           {"k": "seed", "type": "int", "label": "Random seed (0 = new each run)", "default": 0, "min": 0, "max": 2147483647},
       ])
def formula(initial, rates, equations, outputs, basis, horizon, unit, paths, seed):
    return scenario.run(initial, rates, equations, outputs, basis, horizon, paths, unit, seed)
