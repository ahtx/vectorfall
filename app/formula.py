"""A bounded declarative scenario IR evaluated on the GPU without generated Python."""
import ast
import re
import time

import cupy as cp
import numpy as np


MAX_VARIABLES = 50
MAX_AST_NODES = 240
MAX_WORK = 10_000_000


class ScenarioError(ValueError):
    pass


def _sample(spec, shape):
    if not isinstance(spec, dict):
        raise ScenarioError("every sampled variable needs an object")
    distribution = spec.get("distribution", "triangular")
    if "value" in spec:
        return cp.full(shape, float(spec["value"]), cp.float64)
    if distribution == "normal":
        if "mean" not in spec:
            raise ScenarioError("normal variables need a mean")
        mean, sd = float(spec["mean"]), float(spec.get("sd", 0))
        if sd < 0:
            raise ScenarioError("normal standard deviation cannot be negative")
        values = cp.random.normal(mean, sd, shape)
        if "low" in spec or "high" in spec:
            values = cp.clip(values, float(spec.get("low", -1e150)), float(spec.get("high", 1e150)))
        return values
    if "low" not in spec or "high" not in spec:
        raise ScenarioError("uniform and triangular variables need low and high bounds")
    low, high = float(spec["low"]), float(spec["high"])
    if low > high:
        raise ScenarioError("a sampled minimum exceeds its maximum")
    if distribution == "uniform":
        return cp.random.uniform(low, high, shape)
    if distribution == "triangular":
        mode = float(spec.get("mode", (low + high) / 2))
        if not low <= mode <= high:
            raise ScenarioError("triangular mode must be between its bounds")
        return cp.random.triangular(low, mode, high, shape)
    raise ScenarioError("unknown distribution: " + str(distribution))


def _functions(paths=None):
    def sample(function, args, vector):
        if paths is not None and vector:
            return function(*args, size=paths)
        return function(*args)

    def choice(*values):
        if len(values) < 2:
            raise ScenarioError("choice needs at least two alternatives")
        shape = (paths,) if paths is not None else ()
        options = cp.stack([cp.broadcast_to(cp.asarray(value, dtype=cp.float64), shape) for value in values])
        return cp.choose(cp.random.randint(0, len(options), size=shape), options)

    return {
        "min": cp.minimum, "max": cp.maximum, "abs": cp.abs, "sqrt": cp.sqrt, "exp": cp.exp, "log": cp.log,
        "pow": cp.power, "clip": cp.clip, "where": cp.where, "floor": cp.floor, "ceil": cp.ceil,
        "round": cp.round, "and_": cp.logical_and, "or_": cp.logical_or, "not_": cp.logical_not,
        "uniform": lambda *args: sample(cp.random.uniform, args, len(args) < 3),
        "normal": lambda *args: sample(cp.random.normal, args, len(args) < 3),
        "triangular": lambda *args: sample(cp.random.triangular, args, True),
        "choice": choice,
    }


def _evaluate(node, env, functions, depth=0):
    if depth > 16:
        raise ScenarioError("formula nesting is too deep")
    if isinstance(node, ast.Expression):
        return _evaluate(node.body, env, functions, depth + 1)
    if isinstance(node, ast.Num):
        return float(node.n)
    if isinstance(node, ast.NameConstant):
        if isinstance(node.value, bool):
            return node.value
        if isinstance(node.value, (int, float)):
            return float(node.value)
        raise ScenarioError("formula constants must be numeric")
    if isinstance(node, ast.Constant):
        if isinstance(node.value, bool):
            return node.value
        if isinstance(node.value, (int, float)):
            return float(node.value)
        raise ScenarioError("formula constants must be numeric")
    if isinstance(node, ast.Name):
        if node.id not in env:
            raise ScenarioError("unknown variable in formula: " + node.id)
        return env[node.id]
    if isinstance(node, ast.BinOp):
        operations = {ast.Add: lambda a, b: a + b, ast.Sub: lambda a, b: a - b, ast.Mult: lambda a, b: a * b,
                      ast.Div: lambda a, b: a / b, ast.Pow: lambda a, b: a ** b, ast.Mod: lambda a, b: a % b}
        operation = operations.get(type(node.op))
        if operation is None:
            raise ScenarioError("unsupported formula operator")
        return operation(_evaluate(node.left, env, functions, depth + 1), _evaluate(node.right, env, functions, depth + 1))
    if isinstance(node, ast.UnaryOp):
        value = _evaluate(node.operand, env, functions, depth + 1)
        if isinstance(node.op, ast.USub):
            return -value
        if isinstance(node.op, ast.UAdd):
            return value
        if isinstance(node.op, ast.Not):
            return cp.logical_not(value)
        raise ScenarioError("unsupported unary operator")
    if isinstance(node, ast.BoolOp):
        values = [_evaluate(value, env, functions, depth + 1) for value in node.values]
        operation = cp.logical_and if isinstance(node.op, ast.And) else cp.logical_or
        result = values[0]
        for value in values[1:]:
            result = operation(result, value)
        return result
    if isinstance(node, ast.Compare):
        operations = {ast.Lt: lambda a, b: a < b, ast.LtE: lambda a, b: a <= b, ast.Gt: lambda a, b: a > b,
                      ast.GtE: lambda a, b: a >= b, ast.Eq: lambda a, b: a == b, ast.NotEq: lambda a, b: a != b}
        if len(node.ops) != 1 or type(node.ops[0]) not in operations:
            raise ScenarioError("formula comparisons must be binary and use a supported operator")
        return operations[type(node.ops[0])](_evaluate(node.left, env, functions, depth + 1),
                                             _evaluate(node.comparators[0], env, functions, depth + 1))
    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name) or node.func.id not in functions or node.keywords:
            raise ScenarioError("only positional calls to approved numerical functions are allowed")
        args = [_evaluate(arg, env, functions, depth + 1) for arg in node.args]
        if len(args) > (12 if node.func.id == "choice" else 3):
            raise ScenarioError("choice accepts at most twelve alternatives; other numerical functions accept at most three arguments")
        return functions[node.func.id](*args)
    raise ScenarioError("formula contains a disallowed construct")


def _numeric_object(value, name, maximum):
    if not isinstance(value, dict) or not value or len(value) > maximum:
        raise ScenarioError(name + " must be a non-empty bounded object")
    for key in value:
        if not isinstance(key, str) or not key.isidentifier():
            raise ScenarioError("variable names must be valid identifiers")


def run(initial, rates, equations, outputs, basis, horizon, paths, unit, seed):
    if isinstance(equations, list):
        converted = {}
        for item in equations:
            if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not isinstance(item.get("formula"), str):
                raise ScenarioError("equation lists need {name, formula} objects")
            if item["name"] in converted:
                raise ScenarioError("duplicate equation name: " + item["name"])
            formula = item["formula"].strip()
            assignment = re.fullmatch(r"([A-Za-z_]\w*)\s*=\s*(.+)", formula, re.S)
            if assignment:
                if assignment.group(1) != item["name"]:
                    raise ScenarioError("assignment target must match equation name")
                formula = assignment.group(2)
            converted[item["name"]] = formula
        equations = converted
    _numeric_object(initial, "initial", MAX_VARIABLES)
    _numeric_object(equations, "equations", MAX_VARIABLES)
    if not isinstance(rates, dict) or len(rates) > MAX_VARIABLES:
        raise ScenarioError("rates must be a bounded object")
    if not isinstance(outputs, list) or not outputs or len(outputs) > 12 or not all(isinstance(x, str) for x in outputs):
        raise ScenarioError("outputs must name between one and twelve variables")
    if paths * horizon * len(outputs) > MAX_WORK:
        raise ScenarioError("paths × horizon × outputs exceeds the scenario limit")
    if not basis.strip():
        raise ScenarioError("state the source or explicit rationale for the scenario")
    if set(rates) & (set(initial) | set(equations)):
        raise ScenarioError("sampled rates must use different names from stocks and computed variables")
    if len(set(initial) | set(rates) | set(equations)) > MAX_VARIABLES:
        raise ScenarioError("too many scenario variables")
    functions = _functions(paths)
    if set(functions) & (set(initial) | set(rates) | set(equations)):
        raise ScenarioError("a variable conflicts with an approved function name")
    if any(name not in set(initial) | set(equations) for name in outputs):
        raise ScenarioError("every output must be initialized or computed")
    for name in initial:
        if isinstance(initial[name], bool) or not isinstance(initial[name], (int, float)):
            raise ScenarioError("initial values must be numeric")
    compiled = {}
    for name, formula in equations.items():
        if not isinstance(formula, str) or len(formula) > 4000:
            raise ScenarioError("each formula must be a short expression string")
        try:
            tree = ast.parse(formula, mode="eval")
        except SyntaxError as ex:
            raise ScenarioError("invalid formula for {}: {}".format(name, ex))
        if sum(1 for _ in ast.walk(tree)) > MAX_AST_NODES:
            raise ScenarioError("formula is too large")
        compiled[name] = tree
    needed = set(outputs)
    for name in reversed(list(compiled)):
        if name in needed:
            needed.update(node.id for node in ast.walk(compiled[name]) if isinstance(node, ast.Name))
    unused = (set(rates) | set(compiled)) - needed
    if unused:
        raise ScenarioError("variables do not affect any requested output: " + ", ".join(sorted(unused)))
    stochastic = any("value" not in spec and ((spec.get("distribution", "triangular") == "normal" and float(spec.get("sd", 0)) > 0) or
                     (spec.get("distribution", "triangular") != "normal" and float(spec.get("low", 0)) < float(spec.get("high", 0))))
                     for spec in rates.values())
    stochastic = stochastic or any(isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and
                                   node.func.id in ("uniform", "normal", "triangular", "choice") for tree in compiled.values() for node in ast.walk(tree))
    if seed:
        cp.random.seed(seed)
    started = time.time()
    static = {name: _sample(spec, (paths,)) for name, spec in rates.items() if spec.get("static")}
    env = {name: cp.full((paths,), float(value), cp.float64) for name, value in initial.items()}
    for name in static:
        env[name] = static[name]
    for name, spec in rates.items():
        if name not in static:
            env[name] = _sample(spec, (paths,))
    for name, tree in compiled.items():
        if name not in initial:
            env[name] = cp.broadcast_to(cp.asarray(_evaluate(tree, env, functions), dtype=cp.float64), (paths,))
    history = []
    for _step in range(horizon + 1):
        history.append({name: cp.asnumpy(env[name]) for name in outputs})
        if _step == horizon:
            break
        for name, spec in rates.items():
            if name not in static:
                env[name] = _sample(spec, (paths,))
        for name, tree in compiled.items():
            env[name] = cp.broadcast_to(cp.asarray(_evaluate(tree, env, functions), dtype=cp.float64), (paths,))
            if env[name].shape != (paths,):
                raise ScenarioError("formula {} did not produce one value per path".format(name))
    if not all(np.isfinite(values).all() for row in history for values in row.values()):
        raise ScenarioError("the scenario produced a non-finite result; adjust its equations or ranges")
    bands = {name: np.percentile(np.stack([row[name] for row in history], axis=0), [5, 25, 50, 75, 95], axis=1).T.tolist()
             for name in outputs}
    final = {name: history[-1][name] for name in outputs}
    fmt = lambda value: "{:.4g}".format(value)
    effective_uncertainty = stochastic and any(np.percentile(final[name], 95) > np.percentile(final[name], 5) for name in outputs)
    if stochastic and not effective_uncertainty:
        sentence = ("Sampling was requested, but every requested output is constant across paths. Check clipping and ranges; these are not uncertainty estimates. "
                    + "; ".join("{}: {}".format(name, fmt(final[name][0])) for name in outputs) + ". Basis: " + basis.strip())
    elif stochastic:
        summaries = ["{}: median {}, 5–95% {}–{}".format(name, fmt(np.percentile(final[name], 50)),
                     fmt(np.percentile(final[name], 5)), fmt(np.percentile(final[name], 95))) for name in outputs]
        sentence = ("An explicit sampled scenario, not a calibrated forecast. Rates are sampled independently per path and step unless marked static. "
                    + "; ".join(summaries) + ". Basis: " + basis.strip())
    else:
        sentence = ("A deterministic sensitivity calculation, not an uncertainty estimate. " +
                    "; ".join("{}: {}".format(name, fmt(final[name][0])) for name in outputs) + ". Basis: " + basis.strip())
    primary = outputs[0]
    chart2 = {"type": "lines", "x": list(range(horizon + 1)), "unit": unit,
              "series": [{"name": name, "y": [float(np.median(row[name])) for row in history]} for name in outputs],
              "title": "Scenario medians" if effective_uncertainty else "Deterministic scenario paths"} if len(outputs) > 1 else {
        "type": "hist", "edges": np.histogram(final[primary], 40)[1].tolist(),
        "y": np.histogram(final[primary], 40)[0].tolist(), "title": "Final " + primary}
    chart = {"type": "fan", "x": list(range(horizon + 1)), "bands": bands[primary], "unit": unit,
             "title": primary + " scenario"} if effective_uncertainty else {
        "type": "lines", "x": list(range(horizon + 1)), "unit": unit,
        "series": [{"name": primary, "y": [float(row[primary][0]) for row in history]}],
        "title": primary + (" sampled scenario" if stochastic else " deterministic scenario")}
    return {"headline": fmt(np.percentile(final[primary], 50)) + " " + unit,
            "sentence": sentence, "tone": "good", "chart": chart, "chart2": chart2,
            "facts": [["basis", basis.strip()], ["outputs", ", ".join(outputs)], ["paths", paths], ["steps", horizon],
                      ["uncertainty", "sampled" if effective_uncertainty else "degenerate" if stochastic else "deterministic"],
                      ["seed", seed or "random"], ["equations", len(equations)]],
            "paths": paths, "ms": round((time.time() - started) * 1000, 1),
            "scenario": {"kind": "formula", "initial": initial, "rates": rates, "equations": equations,
                         "outputs": outputs, "basis": basis.strip(), "horizon": horizon, "seed": seed,
                         "stochastic": stochastic, "effective_uncertainty": effective_uncertainty}}
