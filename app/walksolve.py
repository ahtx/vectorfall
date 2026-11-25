"""Walk solver: encode a problem as variables + constraints (+ an optional objective) in a small Python-like
language; thousands of GPU walkers random-walk the variables (Metropolis / simulated annealing) until every
constraint holds. One thread = one walker. The model is compiled to CUDA (never eval'd) through a strict AST
whitelist; the winning assignment is then re-checked on the CPU by an independent interpreter of the same model.

    n = 32                                   # constants: numbers, lists, lists of tuples
    var q[n] perm                            # int lo..hi | real lo..hi | bool | perm (a permutation of 0..n-1)
    var a, b, c int 1..999                   # scalars, several at once
    count(1 for i in range(n) for j in range(i + 1, n) if abs(q[i] - q[j]) == j - i) == 0
    all(c[u] != c[v] for (u, v) in E)        # comprehensions over range() or constant tables
    minimize: <expr>                         # or maximize:
    temperature: 2 .. 0.05                   # optional; also penalty: <w>, tolerance: <t>, sweeps: <n>

Energy = penalty x (sum of constraint violations) + objective. A violation is how far a constraint is from true:
|a-b| for ==, max(0, a-b) for <=, +1 for strict integer <, 1 for a false boolean; `and` adds, `or` takes the
minimum, all() sums, any() takes the minimum, alldiff() counts equal pairs.
"""
import ast
import hashlib
import math
import re
import time

import numpy as np

import cupy as cp

from . import engine
from .engine import run_on_gpu, sync

IMAX = 2147483647
MAX_ELEMS = 2048            # decision variables per walker (they live in each thread's local memory)
TIME_LIMIT = 45.0           # seconds of wall time per run
_MODS = {}


class ModelError(ValueError):
    pass


# ================================================================ parsing
_CMP = {ast.Eq: "==", ast.NotEq: "!=", ast.Lt: "<", ast.LtE: "<=", ast.Gt: ">", ast.GtE: ">="}
_NEG = {ast.Eq: ast.NotEq, ast.NotEq: ast.Eq, ast.Lt: ast.GtE, ast.LtE: ast.Gt, ast.Gt: ast.LtE, ast.GtE: ast.Lt}
_F1 = {"sqrt": "sqrtf", "exp": "expf", "log": "logf", "sin": "sinf", "cos": "cosf", "tan": "tanf",
       "floor": "floorf", "ceil": "ceilf", "round": "rintf"}
_AGG = ("sum", "count", "all", "any", "min", "max")


def _num(node):
    """Literal number from an AST node across Python 3.6 (Num/NameConstant) and 3.8+ (Constant)."""
    if isinstance(node, ast.Num):
        return node.n
    if isinstance(node, ast.NameConstant) and isinstance(node.value, bool):
        return int(node.value)
    if type(node).__name__ == "Constant" and isinstance(getattr(node, "value", None), (int, float, bool)):
        return int(node.value) if isinstance(node.value, bool) else node.value
    return None


def _slices(node):
    """a[i][j] / a[i, j] -> (base node, [index nodes])."""
    idx = []
    while isinstance(node, ast.Subscript):
        sl = node.slice
        if type(sl).__name__ == "Index":
            sl = sl.value
        if isinstance(sl, ast.Slice) or type(sl).__name__ == "ExtSlice":
            raise ModelError("slices (a[i:j]) are not available. Index one element at a time")
        idx[:0] = list(sl.elts) if isinstance(sl, ast.Tuple) else [sl]
        node = node.value
    return node, idx


class Model:
    def __init__(self, text):
        self.text = text
        self.consts = {}          # scalar constants
        self.arrays = {}          # name -> {"c": C identifier, "data": flat list, "dims": tuple, "isint": bool}
        self.vars = {}            # name -> {"kind", "n" (None = scalar), "off", "store" X|R, "lo", "hi"}
        self.order = []
        self.cons = []            # (line number, source, node)
        self.obj = None           # (sense, source, node)
        self.temp = None
        self.penalty = None
        self.tol = None
        self.sweeps = None
        self.ni = 0
        self.nf = 0
        self._parse()

    # -- constant expressions ------------------------------------------------
    def ceval(self, node):
        v = _num(node)
        if v is not None:
            return v
        if isinstance(node, ast.Name):
            if node.id in self.consts:
                return self.consts[node.id]
            if node.id in self.arrays:
                a = self.arrays[node.id]
                return np.array(a["data"]).reshape(a["dims"]).tolist()
            raise ModelError("'{}' is not a constant that the model defines above".format(node.id))
        if isinstance(node, (ast.List, ast.Tuple)):
            return [self.ceval(e) for e in node.elts]
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
            v = self.ceval(node.operand)
            return -v if isinstance(node.op, ast.USub) else v
        if isinstance(node, ast.BinOp):
            a, b = self.ceval(node.left), self.ceval(node.right)
            if isinstance(a, list) or isinstance(b, list):
                raise ModelError("constants cannot do arithmetic on full lists")
            op = node.op
            try:
                if isinstance(op, ast.Add): return a + b
                if isinstance(op, ast.Sub): return a - b
                if isinstance(op, ast.Mult): return a * b
                if isinstance(op, ast.Div): return a / b
                if isinstance(op, ast.FloorDiv): return a // b
                if isinstance(op, ast.Mod): return a % b
                if isinstance(op, ast.Pow):
                    if abs(b) > 64:
                        raise ModelError("exponent too large in a constant")
                    return a ** b
            except ZeroDivisionError:
                raise ModelError("division by zero in a constant")
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and not node.keywords:
            f = node.func.id
            args = [self.ceval(a) for a in node.args]
            if f == "len" and len(args) == 1 and isinstance(args[0], list):
                return len(args[0])
            if f in ("abs", "min", "max", "int", "float", "round") and args:
                return {"abs": abs, "min": min, "max": max, "int": int, "float": float, "round": round}[f](*args)
        if isinstance(node, ast.Subscript):
            base, idx = _slices(node)
            v = self.ceval(base)
            for i in idx:
                v = v[int(self.ceval(i))]
            return v
        raise ModelError("not a constant expression: " + _src(node))

    def _cexpr(self, s, what):
        try:
            return self.ceval(ast.parse(s.strip(), mode="eval").body)
        except SyntaxError as e:
            raise ModelError("bad {}: {}".format(what, e.msg))

    # -- the model text -------------------------------------------------------
    def _parse(self):
        lines = self.text.splitlines()
        if len(self.text) > 200000:
            raise ModelError("model is too long (200 kB max)")
        for no, raw in enumerate(lines, 1):
            line = raw.split("#", 1)[0].strip()
            if not line:
                continue
            try:
                self._line(line)
            except ModelError as e:
                raise ModelError("line {}: {}".format(no, e))
            except (IndexError, TypeError, ValueError, OverflowError) as e:
                raise ModelError("line {}: {}".format(no, e))
            if self.cons and self.cons[-1][0] is None:
                self.cons[-1] = (no,) + self.cons[-1][1:]
        if not self.order:
            raise ModelError("declare at least one variable, for example  var x int 0..9")
        if not self.cons and not self.obj:
            raise ModelError("add at least one constraint (or a minimize:/maximize: objective)")
        if self.ni + self.nf > MAX_ELEMS:
            raise ModelError("too many decision variables ({} > {})".format(self.ni + self.nf, MAX_ELEMS))
        if not any((v["kind"] != "perm" or v["n"] >= 2) for v in self.vars.values()):
            raise ModelError("nothing to walk: no variable can change")

    def _line(self, line):
        m = re.match(r"^var\s+(.+?)\s+(int|real|bool|perm)\b\s*(.*)$", line)
        if m:
            return self._var(m.group(1), m.group(2), m.group(3).strip())
        if line.startswith("var "):
            raise ModelError("variable declarations look like  var x int 0..9  /  var q[8] perm  /  var b[5] bool  /  var r real -1..1")
        m = re.match(r"^(minimize|maximize)\s*:\s*(.+)$", line)
        if m:
            if self.obj:
                raise ModelError("only one objective")
            self.obj = (m.group(1), m.group(2), self._expr(m.group(2)))
            return
        m = re.match(r"^(temperature|penalty|tolerance|sweeps)\s*:\s*(.+)$", line)
        if m:
            k, v = m.group(1), m.group(2)
            if k == "temperature":
                parts = v.split("..")
                if len(parts) != 2:
                    raise ModelError("temperature: <start> .. <end>")
                t0, t1 = float(self._cexpr(parts[0], k)), float(self._cexpr(parts[1], k))
                if not (t0 > 0 and t1 > 0):
                    raise ModelError("temperatures must be positive")
                self.temp = (t0, t1)
            elif k == "sweeps":
                self.sweeps = int(self._cexpr(v, k))
                if self.sweeps < 1:
                    raise ModelError("sweeps must be at least 1")
            elif k == "penalty":
                self.penalty = float(self._cexpr(v, k))
            else:
                self.tol = float(self._cexpr(v, k))
            return
        m = re.match(r"^([A-Za-z_]\w*)\s*=(?!=)\s*(.+)$", line)
        if m:
            name = m.group(1)
            if name in self.vars:
                raise ModelError("'{}' is a variable — write == to constrain it".format(name))
            self._check_name(name)
            val = self._cexpr(m.group(2), "constant")
            if isinstance(val, list):
                arr = np.array(val, dtype=np.float64)
                if arr.dtype == object or arr.ndim == 0:
                    raise ModelError("tables must be rectangular (every row the same length)")
                if arr.size > 200000:
                    raise ModelError("table too large")
                isint = bool(np.all(np.mod(arr, 1) == 0) and np.all(np.abs(arr) < IMAX))
                self.arrays[name] = {"c": "C_" + name, "data": arr.ravel().tolist(), "dims": arr.shape, "isint": isint}
            else:
                if isinstance(val, float) and val.is_integer() and abs(val) < IMAX and "." not in m.group(2) and "/" not in m.group(2):
                    val = int(val)
                self.consts[name] = val
            return
        self.cons.append((None, line, self._expr(line)))

    def _check_name(self, name):
        if name in self.vars or name in self.consts or name in self.arrays:
            raise ModelError("'{}' is already defined".format(name))
        if name in _F1 or name in _AGG or name in ("abs", "pow", "len", "alldiff", "range", "int", "float", "var",
                                                      "minimize", "maximize", "True", "False", "temperature", "penalty", "tolerance", "sweeps"):
            raise ModelError("'{}' is a reserved name".format(name))

    def _var(self, names, kind, rest):
        lo = hi = None
        if kind in ("int", "real"):
            parts = rest.split("..")
            if len(parts) != 2:
                raise ModelError("{} variables need a range, for example  var x {} 0..10".format(kind, kind))
            lo, hi = self._cexpr(parts[0], "lower bound"), self._cexpr(parts[1], "upper bound")
            if kind == "int":
                if float(lo) != int(lo) or float(hi) != int(hi):
                    raise ModelError("int bounds must be whole numbers")
                lo, hi = int(lo), int(hi)
                if not (-IMAX // 2 < lo <= hi < IMAX // 2):
                    raise ModelError("int range is empty or too large")
            else:
                lo, hi = float(lo), float(hi)
                if not lo < hi:
                    raise ModelError("real range is empty")
        elif kind == "perm" and rest:
            n = self._cexpr(rest, "perm size")
            if "[" in names:
                raise ModelError("give a perm its size once: var t perm 30  or  var t[30] perm")
            names = "{}[{}]".format(names.strip(), n)
        elif rest:
            raise ModelError("unexpected '{}' after {}".format(rest, kind))
        for part in [p.strip() for p in names.split(",")]:
            mm = re.match(r"^([A-Za-z_]\w*)\s*(?:\[(.+)\])?$", part)
            if not mm:
                raise ModelError("bad variable name '{}'".format(part))
            name = mm.group(1)
            self._check_name(name)
            n = None
            if mm.group(2) is not None:
                n = self._cexpr(mm.group(2), "array size")
                if float(n) != int(n) or int(n) < 1:
                    raise ModelError("array size must be a positive whole number")
                n = int(n)
            if kind == "perm" and n is None:
                raise ModelError("a perm needs a size: var t perm 30")
            store = "R" if kind == "real" else "X"
            off = self.nf if store == "R" else self.ni
            cnt = n or 1
            if store == "R":
                self.nf += cnt
            else:
                self.ni += cnt
            if kind == "perm":
                lo, hi = 0, n - 1
            if kind == "bool":
                lo, hi = 0, 1
            self.vars[name] = {"kind": kind, "n": n, "off": off, "store": store, "lo": lo, "hi": hi}
            self.order.append(name)

    def _expr(self, s):
        try:
            node = ast.parse(s, mode="eval").body
        except SyntaxError as e:
            raise ModelError("syntax error: {}".format(e.msg))
        for sub in ast.walk(node):
            if isinstance(sub, (ast.Lambda, ast.Dict, ast.Set, ast.DictComp, ast.SetComp, ast.Attribute, ast.Starred)) \
                    or type(sub).__name__ in ("Await", "Yield", "YieldFrom", "NamedExpr", "JoinedStr", "FormattedValue", "Str", "Bytes"):
                raise ModelError("'{}' is not permitted in a model".format(type(sub).__name__.lower()))
            if type(sub).__name__ == "Constant" and not isinstance(getattr(sub, "value", 0), (int, float, bool)):
                raise ModelError("a literal can only be a number")
            if isinstance(sub, ast.Call) and (not isinstance(sub.func, ast.Name) or sub.keywords):
                raise ModelError("call plain functions, for example abs(x), sum(...)")
        return node


def _src(node):
    try:
        return ast.dump(node)[:80]
    except Exception:  # noqa: BLE001
        return "?"


# ================================================================ CUDA code generation
def _flit(v):
    v = float(v)
    if math.isinf(v) or math.isnan(v):
        raise ModelError("infinite / NaN constant")
    s = repr(v)
    if "." not in s and "e" not in s:
        s += ".0"
    return "(" + s + "f)"


class Gen:
    """AST -> CUDA statements. val() returns (C expression, is_int); viol() returns a float C expression >= 0.
    Sub-expressions that need loops (aggregates) emit statements first and are referenced through temporaries."""

    def __init__(self, model):
        self.m = model
        self.lines = []
        self.ind = 1
        self.n = 0
        self.env = [{}]

    def t(self, p="t"):
        self.n += 1
        return "{}{}".format(p, self.n)

    def emit(self, s):
        self.lines.append("  " * self.ind + s)

    def look(self, name):
        for sc in reversed(self.env):
            if name in sc:
                return sc[name]
        return None

    def bind(self, kind_c, isint):
        return ("elem", kind_c, isint)

    @staticmethod
    def truthy(c, isint):
        return "({})".format(c) if isint else "(({}) != 0.0f)".format(c)

    def tmp(self, c, isint):
        t = self.t()
        self.emit("{} {} = {};".format("int" if isint else "float", t, c))
        return t

    def idx(self, node):
        c, isint = self.val(node)
        return c if isint else "__float2int_rn({})".format(c)

    def const_len(self, node):
        """Compile-time length of a range()/table loop for alldiff buffers; None if not static."""
        try:
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "range":
                args = [int(self.m.ceval(a)) for a in node.args]
                return len(range(*args))
            if isinstance(node, ast.Name):
                if node.id in self.m.arrays:
                    return self.m.arrays[node.id]["dims"][0]
                if node.id in self.m.vars and self.m.vars[node.id]["n"]:
                    return self.m.vars[node.id]["n"]
                b = self.look(node.id)
                if b and b[0] == "row":
                    return b[1]["dims"][1]
        except ModelError:
            return None
        except Exception:  # noqa: BLE001
            return None
        return None

    # -- values --------------------------------------------------------------
    def val(self, node):
        v = _num(node)
        if v is not None:
            if isinstance(v, int) and abs(v) < IMAX:
                return str(v), True
            return _flit(v), False
        if isinstance(node, ast.Name):
            b = self.look(node.id)
            if b:
                if b[0] == "loop":
                    return b[1], True
                if b[0] == "elem":
                    return b[1], b[2]
                raise ModelError("'{}' is a table row. Index it, for example {}[0]".format(node.id, node.id))
            if node.id in self.m.vars:
                v = self.m.vars[node.id]
                if v["n"] is not None:
                    raise ModelError("'{}' is an array. Index it, for example {}[0]".format(node.id, node.id))
                return ("X[{}]".format(v["off"]), True) if v["store"] == "X" else ("R[{}]".format(v["off"]), False)
            if node.id in self.m.consts:
                c = self.m.consts[node.id]
                return (str(c), True) if isinstance(c, int) else (_flit(c), False)
            if node.id in self.m.arrays:
                raise ModelError("'{}' is a table; index it".format(node.id))
            raise ModelError("unknown name '{}'".format(node.id))
        if isinstance(node, ast.Subscript):
            return self.subscript(node)
        if isinstance(node, ast.BinOp):
            return self.binop(node)
        if isinstance(node, ast.UnaryOp):
            c, isint = self.val(node.operand)
            if isinstance(node.op, ast.USub):
                return "(-{})".format(c), isint
            if isinstance(node.op, ast.UAdd):
                return c, isint
            if isinstance(node.op, ast.Not):
                return "(!{})".format(self.truthy(c, isint)), True
            raise ModelError("unsupported operator ~")
        if isinstance(node, ast.Compare):
            prev_t, prev_i = self._cmp_operand(node.left)
            parts = []
            for op, rhs in zip(node.ops, node.comparators):
                if type(op) not in _CMP:
                    raise ModelError("unsupported comparison ({})".format(type(op).__name__))
                r_t, r_i = self._cmp_operand(rhs)
                parts.append("({} {} {})".format(prev_t, _CMP[type(op)], r_t))
                prev_t, prev_i = r_t, r_i
            return "({})".format(" && ".join(parts)), True
        if isinstance(node, ast.BoolOp):
            parts = [self.truthy(*self.val(v)) for v in node.values]
            return "({})".format((" && " if isinstance(node.op, ast.And) else " || ").join(parts)), True
        if isinstance(node, ast.IfExp):
            c = self.truthy(*self.val(node.test))
            a, ai = self.val(node.body)
            b, bi = self.val(node.orelse)
            if ai and bi:
                return "({} ? {} : {})".format(c, a, b), True
            return "({} ? (float)({}) : (float)({}))".format(c, a, b), False
        if isinstance(node, ast.Call):
            return self.call(node)
        if isinstance(node, (ast.GeneratorExp, ast.ListComp)):
            raise ModelError("a comprehension must be inside sum(), count(), all(), any(), min(), max() or alldiff()")
        raise ModelError("unsupported expression: {}".format(type(node).__name__))

    def _cmp_operand(self, node):
        c, isint = self.val(node)
        return self.tmp(c, isint), isint

    def subscript(self, node):
        base, idx = _slices(node)
        if not isinstance(base, ast.Name):
            raise ModelError("index a named variable or table")
        b = self.look(base.id)
        if b and b[0] == "row":
            arr, row = b[1], b[2]
            if len(idx) != 1:
                raise ModelError("a table row takes one index")
            cols = arr["dims"][1]
            return "{}[({}) * {} + iclamp({}, {})]".format(arr["c"], row, cols, self.idx(idx[0]), cols), arr["isint"]
        if b:
            raise ModelError("you cannot index '{}'".format(base.id))
        if base.id in self.m.vars:
            v = self.m.vars[base.id]
            if v["n"] is None:
                raise ModelError("'{}' is a scalar".format(base.id))
            if len(idx) != 1:
                raise ModelError("variable arrays take one index (use i*cols + j for grids)")
            c = "{}[{} + iclamp({}, {})]".format(v["store"], v["off"], self.idx(idx[0]), v["n"])
            return c, v["store"] == "X"
        if base.id in self.m.arrays:
            a = self.m.arrays[base.id]
            dims = a["dims"]
            if len(idx) != len(dims):
                raise ModelError("'{}' has {} dimension(s); index all of them".format(base.id, len(dims)))
            flat, stride = [], 1
            for k in range(len(dims) - 1, -1, -1):
                flat.append("iclamp({}, {}) * {}".format(self.idx(idx[k]), dims[k], stride))
                stride *= dims[k]
            return "{}[{}]".format(a["c"], " + ".join(flat)), a["isint"]
        raise ModelError("unknown name '{}'".format(base.id))

    def binop(self, node):
        op = node.op
        if isinstance(op, ast.Pow):
            e = _num(node.right)
            if e in (2, 3) and isinstance(e, int):
                c, isint = self.val(node.left)
                t = self.tmp(c, isint)
                return "({})".format(" * ".join([t] * e)), isint
            a, _ = self.val(node.left)
            b, _ = self.val(node.right)
            return "powf((float)({}), (float)({}))".format(a, b), False
        a, ai = self.val(node.left)
        b, bi = self.val(node.right)
        both = ai and bi
        if isinstance(op, (ast.Add, ast.Sub, ast.Mult)):
            s = {ast.Add: "+", ast.Sub: "-", ast.Mult: "*"}[type(op)]
            if both:
                return "({} {} {})".format(a, s, b), True
            return "((float)({}) {} (float)({}))".format(a, s, b), False
        if isinstance(op, ast.Div):
            return "fdivs((float)({}), (float)({}))".format(a, b), False
        if isinstance(op, ast.FloorDiv):
            if both:
                return "ifdiv({}, {})".format(a, b), True
            return "floorf(fdivs((float)({}), (float)({})))".format(a, b), False
        if isinstance(op, ast.Mod):
            if both:
                return "imod({}, {})".format(a, b), True
            return "fmodpy((float)({}), (float)({}))".format(a, b), False
        raise ModelError("unsupported operator {}".format(type(op).__name__))

    def call(self, node):
        f = node.func.id
        args = node.args
        if f in _AGG and len(args) == 1 and isinstance(args[0], (ast.GeneratorExp, ast.ListComp)):
            return self.agg_val(f, args[0])
        if f == "alldiff":
            return "({} == 0)".format(self.alldiff(args)), True
        if f == "len":
            if len(args) != 1:
                raise ModelError("len() takes one argument")
            n = self.const_len(args[0])
            if n is None:
                raise ModelError("len() works on variable arrays, tables and table rows")
            return str(n), True
        if f == "abs" and len(args) == 1:
            c, isint = self.val(args[0])
            return ("abs({})".format(c), True) if isint else ("fabsf({})".format(c), False)
        if f in ("min", "max") and len(args) >= 2:
            vals = [self.val(a) for a in args]
            allint = all(i for _, i in vals)
            fn = f if allint else ("fminf" if f == "min" else "fmaxf")
            acc = vals[0][0] if allint else "(float)({})".format(vals[0][0])
            for c, _ in vals[1:]:
                acc = "{}({}, {})".format(fn, acc, c if allint else "(float)({})".format(c))
            return acc, allint
        if f in _F1 and len(args) == 1:
            c, _ = self.val(args[0])
            return "{}((float)({}))".format(_F1[f], c), False
        if f == "pow" and len(args) == 2:
            a, _ = self.val(args[0])
            b, _ = self.val(args[1])
            return "powf((float)({}), (float)({}))".format(a, b), False
        if f == "int" and len(args) == 1:
            c, isint = self.val(args[0])
            return (c, True) if isint else ("((int)({}))".format(c), True)
        if f == "float" and len(args) == 1:
            c, _ = self.val(args[0])
            return "((float)({}))".format(c), False
        if f in _AGG:
            raise ModelError("{}() takes a comprehension, for example {}(x[i] for i in range(n))".format(f, f))
        raise ModelError("unknown function '{}'".format(f))

    # -- comprehension loops -------------------------------------------------
    def open_loops(self, gens):
        """Emit for/if headers for a comprehension; returns the number of braces to close."""
        braces = 0
        for comp in gens:
            sc = {}
            self.env.append(sc)
            it, tgt = comp.iter, comp.target
            if isinstance(it, ast.Call) and isinstance(it.func, ast.Name) and it.func.id == "range":
                if not 1 <= len(it.args) <= 3:
                    raise ModelError("range() takes 1 to 3 arguments")
                if not isinstance(tgt, ast.Name):
                    raise ModelError("range() loops bind one name")
                a = [self.idx(x) for x in it.args]
                lo, hi = ("0", a[0]) if len(a) == 1 else (a[0], a[1])
                step = 1
                if len(a) == 3:
                    step = int(self.m.ceval(it.args[2]))
                    if step == 0:
                        raise ModelError("the step of range() cannot be 0")
                v = self.t("i")
                hv = self.tmp(hi, True)
                self.emit("for (int {v} = {lo}; {v} {cmp} {hi}; {v} += {st}) {{".format(
                    v=v, lo=lo, cmp="<" if step > 0 else ">", hi=hv, st=step))
                sc[tgt.id] = ("loop", v)
            elif isinstance(it, ast.Name):
                b = self.look(it.id)
                r = self.t("i")
                if b and b[0] == "row":
                    arr, row = b[1], b[2]
                    cols = arr["dims"][1]
                    self.emit("for (int {r} = 0; {r} < {n}; {r}++) {{".format(r=r, n=cols))
                    self._bind_target(sc, tgt, ("elem", "{}[({}) * {} + {}]".format(arr["c"], row, cols, r), arr["isint"]))
                elif it.id in self.m.arrays:
                    arr = self.m.arrays[it.id]
                    dims = arr["dims"]
                    self.emit("for (int {r} = 0; {r} < {n}; {r}++) {{".format(r=r, n=dims[0]))
                    if len(dims) == 1:
                        self._bind_target(sc, tgt, ("elem", "{}[{}]".format(arr["c"], r), arr["isint"]))
                    elif len(dims) == 2:
                        if isinstance(tgt, ast.Name):
                            sc[tgt.id] = ("row", arr, r)
                        elif isinstance(tgt, (ast.Tuple, ast.List)):
                            if len(tgt.elts) != dims[1]:
                                raise ModelError("'{}' rows have {} values; unpack all of them".format(it.id, dims[1]))
                            for k, e in enumerate(tgt.elts):
                                if not isinstance(e, ast.Name):
                                    raise ModelError("unpack into plain names")
                                sc[e.id] = ("elem", "{}[{} * {} + {}]".format(arr["c"], r, dims[1], k), arr["isint"])
                        else:
                            raise ModelError("bad loop target")
                    else:
                        raise ModelError("loop over tables of at most 2 dimensions")
                elif it.id in self.m.vars and self.m.vars[it.id]["n"]:
                    v = self.m.vars[it.id]
                    self.emit("for (int {r} = 0; {r} < {n}; {r}++) {{".format(r=r, n=v["n"]))
                    self._bind_target(sc, tgt, ("elem", "{}[{} + {}]".format(v["store"], v["off"], r), v["store"] == "X"))
                else:
                    raise ModelError("cannot loop over '{}' (use range(), a table or a variable array)".format(it.id))
            else:
                raise ModelError("loop over range(...), a table or a variable array")
            self.ind += 1
            braces += 1
            for cond in comp.ifs:
                self.emit("if {} {{".format(self.truthy(*self.val(cond))))
                self.ind += 1
                braces += 1
        return braces

    @staticmethod
    def _bind_target(sc, tgt, b):
        if not isinstance(tgt, ast.Name):
            raise ModelError("to unpack, you need a table with rows")
        sc[tgt.id] = b

    def close_loops(self, braces, ngen):
        for _ in range(braces):
            self.ind -= 1
            self.emit("}")
        for _ in range(ngen):
            self.env.pop()

    def _agg(self, gen, init_of, body_of, result_of):
        acc = self.t("a")
        self.lines.append(None)
        pidx, ind0 = len(self.lines) - 1, self.ind
        braces = self.open_loops(gen.generators)
        ctype = body_of(acc)
        self.close_loops(braces, len(gen.generators))
        self.lines[pidx] = "  " * ind0 + "{} {} = {};".format(ctype, acc, init_of(ctype))
        return result_of(acc)

    def agg_val(self, f, gen):
        info = {}

        def body(acc):
            if f in ("count", "all", "any"):
                c = self.truthy(*self.val(gen.elt))
                self.emit({"count": "{a} += {c} ? 1 : 0;", "all": "{a} = {a} && {c};", "any": "{a} = {a} || {c};"}[f].format(a=acc, c=c))
                info["int"] = True
                return "int"
            c, isint = self.val(gen.elt)
            info["int"] = isint
            if f == "sum":
                self.emit("{} += {};".format(acc, c))
            else:
                fn = f if isint else ("fminf" if f == "min" else "fmaxf")
                self.emit("{a} = {fn}({a}, {c});".format(a=acc, fn=fn, c=c))
            return "int" if isint else "float"

        def init(ctype):
            if f in ("sum", "count", "any"):
                return "0" if ctype == "int" else "0.0f"
            if f == "all":
                return "1"
            big = str(IMAX) if ctype == "int" else "3.0e38f"
            return big if f == "min" else "-" + big
        r = self._agg(gen, init, body, lambda a: a)
        return r, info["int"]

    def alldiff(self, args):
        """Number of equal pairs among the given values (0 = all different)."""
        cnt = self.t("d")
        if len(args) == 1 and isinstance(args[0], ast.Name) and args[0].id in self.m.vars and self.m.vars[args[0].id]["n"]:
            v = self.m.vars[args[0].id]
            a, b = self.t("i"), self.t("i")
            self.emit("int {} = 0;".format(cnt))
            self.emit("for (int {a} = 0; {a} < {n}; {a}++) for (int {b} = {a} + 1; {b} < {n}; {b}++) {c} += ({s}[{o} + {a}] == {s}[{o} + {b}]);".format(
                a=a, b=b, n=v["n"], c=cnt, s=v["store"], o=v["off"]))
            return cnt
        if len(args) == 1 and isinstance(args[0], (ast.GeneratorExp, ast.ListComp)):
            gen = args[0]
            cap = 1
            for comp in gen.generators:
                n = self.const_len(comp.iter)
                if n is None:
                    raise ModelError("alldiff over a comprehension needs fixed-size loops (range of constants / tables)")
                cap *= max(1, n)
            if cap > 4096:
                raise ModelError("alldiff over more than 4096 values")
            buf, k = self.t("b"), self.t("k")
            # element type is only known after emitting; use float storage (exact for integers < 2^24)
            self.emit("float {}[{}]; int {} = 0;".format(buf, cap, k))
            braces = self.open_loops(gen.generators)
            c, _ = self.val(gen.elt)
            self.emit("if ({k} < {cap}) {buf}[{k}++] = (float)({c});".format(k=k, cap=cap, buf=buf, c=c))
            self.close_loops(braces, len(gen.generators))
            a, b = self.t("i"), self.t("i")
            self.emit("int {} = 0;".format(cnt))
            self.emit("for (int {a} = 0; {a} < {k}; {a}++) for (int {b} = {a} + 1; {b} < {k}; {b}++) {c} += ({buf}[{a}] == {buf}[{b}]);".format(
                a=a, b=b, k=k, c=cnt, buf=buf))
            return cnt
        if len(args) < 2:
            raise ModelError("alldiff(array), alldiff(x, y, z) or alldiff(expr for i in range(n))")
        ts = [self.tmp(*self.val(a)) for a in args]
        pairs = ["({} == {})".format(ts[i], ts[j]) for i in range(len(ts)) for j in range(i + 1, len(ts))]
        self.emit("int {} = {};".format(cnt, " + ".join(pairs)))
        return cnt

    # -- violations ----------------------------------------------------------
    def viol(self, node, neg=False):
        if isinstance(node, ast.Compare):
            ops = [_NEG[type(o)] if neg else type(o) for o in node.ops]
            for o in node.ops:
                if type(o) not in _CMP:
                    raise ModelError("unsupported comparison ({})".format(type(o).__name__))
            ts = [self._cmp_operand(node.left)] + [self._cmp_operand(c) for c in node.comparators]
            parts = []
            for k, op in enumerate(ops):
                (a, ai), (b, bi) = ts[k], ts[k + 1]
                if ai and bi:
                    p = {ast.Eq: "(float)abs({a} - {b})", ast.NotEq: "(({a} == {b}) ? 1.0f : 0.0f)",
                         ast.Lt: "(float)max(0, {a} - {b} + 1)", ast.LtE: "(float)max(0, {a} - {b})",
                         ast.Gt: "(float)max(0, {b} - {a} + 1)", ast.GtE: "(float)max(0, {b} - {a})"}[op]
                else:
                    a, b = "(float)({})".format(a), "(float)({})".format(b)
                    p = {ast.Eq: "fabsf({a} - {b})", ast.NotEq: "(({a} == {b}) ? 1.0f : 0.0f)",
                         ast.Lt: "fmaxf(0.0f, {a} - {b})", ast.LtE: "fmaxf(0.0f, {a} - {b})",
                         ast.Gt: "fmaxf(0.0f, {b} - {a})", ast.GtE: "fmaxf(0.0f, {b} - {a})"}[op]
                parts.append(p.format(a=a, b=b))
            if len(parts) == 1:
                return parts[0]
            if neg:                                     # not (a < b < c) == (a >= b) or (b >= c)
                return self._fold_min(parts)
            return "({})".format(" + ".join(parts))
        if isinstance(node, ast.BoolOp):
            conj = isinstance(node.op, ast.And) != neg
            parts = [self.tmp(self.viol(v, neg), False) for v in node.values]
            return "({})".format(" + ".join(parts)) if conj else self._fold_min(parts)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            return self.viol(node.operand, not neg)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            f = node.func.id
            if f in ("all", "any") and len(node.args) == 1 and isinstance(node.args[0], (ast.GeneratorExp, ast.ListComp)):
                gen = node.args[0]
                summed = (f == "all") != neg
                if summed:
                    def body(acc):
                        self.emit("{} += {};".format(acc, self.viol(gen.elt, neg)))
                        return "float"
                    return self._agg(gen, lambda c: "0.0f", body, lambda a: a)

                def body2(acc):
                    self.emit("{a} = fminf({a}, {v});".format(a=acc, v=self.viol(gen.elt, neg)))
                    return "float"
                return self._agg(gen, lambda c: "3.0e38f", body2, lambda a: "({a} > 1.0e38f ? 1.0f : {a})".format(a=a))
            if f == "alldiff":
                c = self.alldiff(node.args)
                return "(({c} > 0) ? 1.0f : 0.0f)".format(c=c) if neg else "(float)({})".format(c)
        c = self.truthy(*self.val(node))
        return "({} ? 1.0f : 0.0f)".format(c) if neg else "({} ? 0.0f : 1.0f)".format(c)

    @staticmethod
    def _fold_min(parts):
        acc = parts[0]
        for p in parts[1:]:
            acc = "fminf({}, {})".format(acc, p)
        return acc


_KERNEL = r'''
#define NI @@NI@@
#define NF @@NF@@
#define HASOBJ @@HASOBJ@@
__device__ __forceinline__ unsigned int xr(unsigned int &s){ s ^= s << 13; s ^= s >> 17; s ^= s << 5; return s; }
__device__ __forceinline__ float uf(unsigned int &s){ return (float)(xr(s) >> 8) * (1.0f / 16777216.0f); }
__device__ __forceinline__ int imod(int a, int b){ if (b == 0) return 0; int r = a % b; if (r != 0 && ((r < 0) != (b < 0))) r += b; return r; }
__device__ __forceinline__ int ifdiv(int a, int b){ if (b == 0) return 0; int q = a / b; if ((a % b != 0) && ((a < 0) != (b < 0))) q--; return q; }
__device__ __forceinline__ float fdivs(float a, float b){ return b == 0.0f ? 0.0f : a / b; }
__device__ __forceinline__ float fmodpy(float a, float b){ return b == 0.0f ? 0.0f : a - b * floorf(a / b); }
__device__ __forceinline__ int iclamp(int i, int n){ return i < 0 ? 0 : (i >= n ? n - 1 : i); }
@@CONSTS@@
__device__ float VIOL(const int* X, const float* R){
  float V = 0.0f;
@@VIOL@@
  return V;
}
__device__ float OBJ(const int* X, const float* R){
@@OBJ@@
}
extern "C" __global__ void winit(int W, int* XI, float* XF, unsigned int* S, unsigned int seed){
  int w = blockIdx.x * blockDim.x + threadIdx.x; if (w >= W) return;
  unsigned int s = seed ^ (0x9E3779B9u * (unsigned int)(w + 1)); if (s == 0u) s = 0x1234567u;
  for (int k = 0; k < 8; k++) xr(s);
  int X[NI]; float R[NF];
  for (int k = 0; k < NI; k++) X[k] = 0;
  for (int k = 0; k < NF; k++) R[k] = 0.0f;
@@INIT@@
  for (int k = 0; k < NI; k++) XI[(long long)w * NI + k] = X[k];
  for (int k = 0; k < NF; k++) XF[(long long)w * NF + k] = R[k];
  S[w] = s;
}
extern "C" __global__ void wenergy(int W, const int* XI, const float* XF, float pen, float* CE, float* CV){
  int w = blockIdx.x * blockDim.x + threadIdx.x; if (w >= W) return;
  int X[NI]; float R[NF];
  for (int k = 0; k < NI; k++) X[k] = XI[(long long)w * NI + k];
  for (int k = 0; k < NF; k++) R[k] = XF[(long long)w * NF + k];
  float v = VIOL(X, R); CV[w] = v; CE[w] = pen * v + OBJ(X, R);
}
extern "C" __global__ void wstep(int W, int steps, long long base, long long total, float T0, float T1, float pen, float tol,
    int stopfound, int* XI, float* XF, unsigned int* S, float* BE, float* BV, int* BXI, float* BXF, float* CE, float* CV, int* found, int* foundat){
  int w = blockIdx.x * blockDim.x + threadIdx.x; if (w >= W) return;
  int X[NI]; float R[NF];
  for (int k = 0; k < NI; k++) X[k] = XI[(long long)w * NI + k];
  for (int k = 0; k < NF; k++) R[k] = XF[(long long)w * NF + k];
  unsigned int s = S[w];
  float v = VIOL(X, R); float e = pen * v + OBJ(X, R);
  float be = BE[w];
  if (e < be) {
    be = e; BE[w] = e; BV[w] = v;
    for (int k = 0; k < NI; k++) BXI[(long long)w * NI + k] = X[k];
    for (int k = 0; k < NF; k++) BXF[(long long)w * NF + k] = R[k];
    if (!HASOBJ && v <= tol) { atomicExch(found, 1); atomicMin(foundat, (int)(base / @@TOTW@@)); }
  }
  float lr = logf(T1 / T0);
  for (int st = 0; st < steps; st++) {
    if ((st & 31) == 0 && stopfound && *((volatile int*)found)) break;
    float T = T0 * __expf(lr * (float)((double)(base + st) / (double)total));
    int kind = -1, a = 0, b = 0, oldi = 0; float oldf = 0.0f;
    unsigned int r = xr(s) % @@TOTW@@u;
@@MOVES@@
    float v2 = VIOL(X, R); float e2 = pen * v2 + OBJ(X, R);
    float d = e2 - e;
    if (d <= 0.0f || uf(s) < __expf(-d / T)) {
      v = v2; e = e2;
      if (e < be) {
        be = e; BE[w] = e; BV[w] = v;
        for (int k = 0; k < NI; k++) BXI[(long long)w * NI + k] = X[k];
        for (int k = 0; k < NF; k++) BXF[(long long)w * NF + k] = R[k];
        if (!HASOBJ && v <= tol) { atomicExch(found, 1); atomicMin(foundat, (int)((base + st) / @@TOTW@@)); }
      }
    } else {
      if (kind == 0) X[a] = oldi;
      else if (kind == 1) { int t = X[a]; X[a] = X[b]; X[b] = t; }
      else if (kind == 2) { for (int i = a, j = b; i < j; i++, j--) { int t = X[i]; X[i] = X[j]; X[j] = t; } }
      else if (kind == 3) R[a] = oldf;
    }
  }
  for (int k = 0; k < NI; k++) XI[(long long)w * NI + k] = X[k];
  for (int k = 0; k < NF; k++) XF[(long long)w * NF + k] = R[k];
  S[w] = s; CE[w] = e; CV[w] = v;
}
'''


def compile_model(m):
    """Model -> (CUDA source, total move weight)."""
    consts = []
    for name, a in m.arrays.items():
        if a["isint"]:
            body = ", ".join(str(int(x)) for x in a["data"])
            consts.append("__device__ const int {}[{}] = {{{}}};".format(a["c"], len(a["data"]), body))
        else:
            body = ", ".join(_flit(x)[1:-1] for x in a["data"])
            consts.append("__device__ const float {}[{}] = {{{}}};".format(a["c"], len(a["data"]), body))
    g = Gen(m)
    for no, src, node in m.cons:
        g.emit("{{ // line {}".format(no))
        g.ind += 1
        try:
            v = g.viol(node)
        except ModelError as e:
            raise ModelError("line {}: {}".format(no, e))
        g.emit("V += {};".format(v))
        g.ind -= 1
        g.emit("}")
    viol = "\n".join(l for l in g.lines if l is not None)
    if m.obj:
        go = Gen(m)
        try:
            c, _ = go.val(m.obj[2])
        except ModelError as e:
            raise ModelError("objective: {}".format(e))
        go.emit("return {}(float)({});".format("-" if m.obj[0] == "maximize" else "", c))
        obj = "\n".join(l for l in go.lines if l is not None)
    else:
        obj = "  return 0.0f;"
    init, moves, cum = [], [], 0
    for name in m.order:
        v = m.vars[name]
        n, off, lo, hi = v["n"] or 1, v["off"], v["lo"], v["hi"]
        if v["kind"] == "perm":
            init.append("  for (int k = 0; k < {n}; k++) X[{o} + k] = k;\n"
                        "  for (int k = {n} - 1; k > 0; k--) {{ int j = (int)(xr(s) % (unsigned int)(k + 1)); int t = X[{o} + k]; X[{o} + k] = X[{o} + j]; X[{o} + j] = t; }}".format(n=n, o=off))
        elif v["kind"] == "real":
            init.append("  for (int k = 0; k < {n}; k++) R[{o} + k] = {lo} + ({hi} - {lo}) * uf(s);".format(n=n, o=off, lo=_flit(lo), hi=_flit(hi)))
        else:
            init.append("  for (int k = 0; k < {n}; k++) X[{o} + k] = {lo} + (int)(xr(s) % {sp}u);".format(n=n, o=off, lo=lo, sp=hi - lo + 1))
        if v["kind"] == "perm" and n < 2:
            continue
        cum += n
        if v["kind"] == "perm":
            mv = ("{{ int i = (int)(xr(s) % {n}u), j = (int)(xr(s) % {n}u); if (i == j) j = (i + 1) % {n}; if (i > j) {{ int t = i; i = j; j = t; }}\n"
                  "      a = {o} + i; b = {o} + j;\n"
                  "      if (uf(s) < 0.5f) {{ kind = 1; int t = X[a]; X[a] = X[b]; X[b] = t; }}\n"
                  "      else {{ kind = 2; for (int p = a, q = b; p < q; p++, q--) {{ int t = X[p]; X[p] = X[q]; X[q] = t; }} }} }}").format(n=n, o=off)
        elif v["kind"] == "bool":
            mv = "{{ kind = 0; a = {o} + (int)(xr(s) % {n}u); oldi = X[a]; X[a] = 1 - oldi; }}".format(n=n, o=off)
        elif v["kind"] == "int":
            mv = ("{{ kind = 0; a = {o} + (int)(xr(s) % {n}u); oldi = X[a]; int nv;\n"
                  "      if (uf(s) < 0.3f) nv = {lo} + (int)(xr(s) % {sp}u);\n"
                  "      else {{ int jump = (int)__expf(uf(s) * {lsp}); if (jump < 1) jump = 1; nv = oldi + ((xr(s) & 1u) ? jump : -jump); nv = nv < {lo} ? {lo} : (nv > {hi} ? {hi} : nv); }}\n"
                  "      if (nv == oldi) nv = (oldi == {hi}) ? oldi - 1 : oldi + 1;\n"
                  "      if ({hi} > {lo}) X[a] = nv; }}").format(n=n, o=off, lo=lo, hi=hi, sp=hi - lo + 1,
                                                                 lsp=_flit(math.log(max(2, hi - lo + 1)))[1:-1])
        else:
            mv = ("{{ kind = 3; a = {o} + (int)(xr(s) % {n}u); oldf = R[a]; float nv;\n"
                  "      if (uf(s) < 0.05f) nv = {lo} + ({hi} - {lo}) * uf(s);\n"
                  "      else {{ float mag = ({hi} - {lo}) * __expf(-13.8f * uf(s)); nv = oldf + mag * (2.0f * uf(s) - 1.0f); }}\n"
                  "      nv = fminf(fmaxf(nv, {lo}), {hi}); R[a] = nv; }}").format(n=n, o=off, lo=_flit(lo), hi=_flit(hi))
        moves.append("    {}if (r < {}u) {}".format("else " if moves else "", cum, mv))
    src = (_KERNEL.replace("@@NI@@", str(max(1, m.ni))).replace("@@NF@@", str(max(1, m.nf)))
           .replace("@@HASOBJ@@", "1" if m.obj else "0").replace("@@CONSTS@@", "\n".join(consts))
           .replace("@@VIOL@@", viol).replace("@@OBJ@@", obj).replace("@@INIT@@", "\n".join(init))
           .replace("@@MOVES@@", "\n".join(moves)).replace("@@TOTW@@", str(cum)))
    return src, cum


def _module(src):
    key = hashlib.sha1(src.encode()).hexdigest()
    if key not in _MODS:
        mod = cp.RawModule(code=src, options=("--std=c++11",))
        try:
            mod.get_function("wstep")
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            errs = [l for l in msg.splitlines() if "error" in l]
            raise ModelError("the model compiled to invalid CUDA: " + (" | ".join(errs[:3]) or msg[:300]))
        if len(_MODS) > 24:
            _MODS.clear()
        _MODS[key] = mod
    return _MODS[key]


# ================================================================ independent CPU check
class CPUCheck:
    """Re-evaluates the model in plain Python on one assignment — same semantics, separate implementation."""

    def __init__(self, m, X, R):
        self.m, self.X, self.R = m, X, R
        self.env = [{}]

    def look(self, n):
        for sc in reversed(self.env):
            if n in sc:
                return sc[n]
        return None

    def table(self, name):
        a = self.m.arrays[name]
        arr = np.array(a["data"]).reshape(a["dims"])
        return arr.astype(np.int64) if a["isint"] else arr

    @staticmethod
    def _py(x):
        return int(x) if isinstance(x, (np.integer,)) else (float(x) if isinstance(x, np.floating) else x)

    def val(self, node):
        v = _num(node)
        if v is not None:
            return v
        if isinstance(node, ast.Name):
            b = self.look(node.id)
            if b is not None:
                return b
            if node.id in self.m.vars:
                v = self.m.vars[node.id]
                return self.X[v["off"]] if v["store"] == "X" else self.R[v["off"]]
            return self.m.consts[node.id]
        if isinstance(node, ast.Subscript):
            base, idx = _slices(node)
            ix = [int(round(self.val(i))) if isinstance(self.val(i), float) else int(self.val(i)) for i in idx]
            b = self.look(base.id)
            if b is not None:                            # a table row (numpy array)
                return self._py(b[min(max(ix[0], 0), len(b) - 1)])
            if base.id in self.m.vars:
                v = self.m.vars[base.id]
                k = v["off"] + min(max(ix[0], 0), v["n"] - 1)
                return self.X[k] if v["store"] == "X" else self.R[k]
            arr = self.table(base.id)
            for i in ix:
                arr = arr[min(max(i, 0), len(arr) - 1)]
            return self._py(arr)
        if isinstance(node, ast.BinOp):
            op = node.op
            if isinstance(op, ast.Pow):
                e = _num(node.right)
                a = self.val(node.left)
                if e in (2, 3) and isinstance(e, int):
                    return a ** e
                return float(a) ** float(self.val(node.right))
            a, b = self.val(node.left), self.val(node.right)
            both = isinstance(a, int) and isinstance(b, int)
            if isinstance(op, ast.Add): return a + b
            if isinstance(op, ast.Sub): return a - b
            if isinstance(op, ast.Mult): return a * b
            if isinstance(op, ast.Div): return 0.0 if b == 0 else a / b
            if isinstance(op, ast.FloorDiv): return 0 if b == 0 else (a // b if both else math.floor(a / b))
            if isinstance(op, ast.Mod): return 0 if b == 0 else (a % b if both else a - b * math.floor(a / b))
        if isinstance(node, ast.UnaryOp):
            a = self.val(node.operand)
            if isinstance(node.op, ast.USub): return -a
            if isinstance(node.op, ast.UAdd): return a
            if isinstance(node.op, ast.Not): return int(not a)
        if isinstance(node, ast.Compare):
            vals = [self.val(node.left)] + [self.val(c) for c in node.comparators]
            ok = True
            for k, op in enumerate(node.ops):
                a, b = vals[k], vals[k + 1]
                ok = ok and {ast.Eq: a == b, ast.NotEq: a != b, ast.Lt: a < b, ast.LtE: a <= b, ast.Gt: a > b, ast.GtE: a >= b}[type(op)]
            return int(ok)
        if isinstance(node, ast.BoolOp):
            vs = [bool(self.val(v)) for v in node.values]
            return int(all(vs) if isinstance(node.op, ast.And) else any(vs))
        if isinstance(node, ast.IfExp):
            return self.val(node.body) if self.val(node.test) else self.val(node.orelse)
        if isinstance(node, ast.Call):
            f, args = node.func.id, node.args
            if f in _AGG and len(args) == 1 and isinstance(args[0], (ast.GeneratorExp, ast.ListComp)):
                items = list(self.iterate(args[0], lambda: self.val(args[0].elt)))
                if f == "sum": return sum(items) if items else 0
                if f == "count": return sum(1 for x in items if x)
                if f == "all": return int(all(items))
                if f == "any": return int(any(items))
                if f == "min": return min(items) if items else IMAX
                if f == "max": return max(items) if items else -IMAX
            if f == "alldiff": return int(self.alldiff(args) == 0)
            if f == "len":
                a = args[0]
                if a.id in self.m.vars: return self.m.vars[a.id]["n"]
                if a.id in self.m.arrays: return self.m.arrays[a.id]["dims"][0]
                return len(self.look(a.id))
            vs = [self.val(a) for a in args]
            if f == "abs": return abs(vs[0])
            if f == "min": return min(vs)
            if f == "max": return max(vs)
            if f == "pow": return float(vs[0]) ** float(vs[1])
            if f == "int": return int(vs[0])
            if f == "float": return float(vs[0])
            if f == "round": return float(round(vs[0]))
            return getattr(math, f)(vs[0])
        raise ModelError("cpu check: unsupported node")

    def iterate(self, gen, produce, k=0):
        if k == len(gen.generators):
            yield produce()
            return
        comp = gen.generators[k]
        it, tgt = comp.iter, comp.target
        if isinstance(it, ast.Call):
            rng = range(*[int(self.val(a)) for a in it.args])
            seq = list(rng)
        else:
            b = self.look(it.id)
            if b is not None:
                seq = [self._py(x) for x in b]
            elif it.id in self.m.arrays:
                t = self.table(it.id)
                seq = list(t) if t.ndim == 2 else [self._py(x) for x in t]
            else:
                v = self.m.vars[it.id]
                src = self.X if v["store"] == "X" else self.R
                seq = src[v["off"]:v["off"] + v["n"]]
        for item in seq:
            sc = {}
            if isinstance(tgt, ast.Name):
                sc[tgt.id] = item
            else:
                for e, x in zip(tgt.elts, item):
                    sc[e.id] = self._py(x)
            self.env.append(sc)
            try:
                if all(self.val(c) for c in comp.ifs):
                    for y in self.iterate(gen, produce, k + 1):
                        yield y
            finally:
                self.env.pop()

    def alldiff(self, args):
        if len(args) == 1 and isinstance(args[0], ast.Name):
            v = self.m.vars[args[0].id]
            src = self.X if v["store"] == "X" else self.R
            vals = src[v["off"]:v["off"] + v["n"]]
        elif len(args) == 1:
            vals = list(self.iterate(args[0], lambda: self.val(args[0].elt)))
        else:
            vals = [self.val(a) for a in args]
        return sum(1 for i in range(len(vals)) for j in range(i + 1, len(vals)) if vals[i] == vals[j])

    def viol(self, node, neg=False):
        if isinstance(node, ast.Compare):
            vals = [self.val(node.left)] + [self.val(c) for c in node.comparators]
            parts = []
            for k, o in enumerate(node.ops):
                op = _NEG[type(o)] if neg else type(o)
                a, b = vals[k], vals[k + 1]
                ints = isinstance(a, int) and isinstance(b, int)
                if op is ast.Eq: p = abs(a - b)
                elif op is ast.NotEq: p = 1.0 if a == b else 0.0
                elif op is ast.Lt: p = max(0, a - b + 1) if ints else max(0.0, a - b)
                elif op is ast.LtE: p = max(0, a - b)
                elif op is ast.Gt: p = max(0, b - a + 1) if ints else max(0.0, b - a)
                else: p = max(0, b - a)
                parts.append(float(p))
            return min(parts) if (neg and len(parts) > 1) else sum(parts)
        if isinstance(node, ast.BoolOp):
            conj = isinstance(node.op, ast.And) != neg
            ps = [self.viol(v, neg) for v in node.values]
            return sum(ps) if conj else min(ps)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            return self.viol(node.operand, not neg)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            f = node.func.id
            if f in ("all", "any") and len(node.args) == 1 and isinstance(node.args[0], (ast.GeneratorExp, ast.ListComp)):
                gen = node.args[0]
                ps = list(self.iterate(gen, lambda: self.viol(gen.elt, neg)))
                if (f == "all") != neg:
                    return sum(ps)
                return min(ps) if ps else 1.0
            if f == "alldiff":
                c = self.alldiff(node.args)
                return (1.0 if c > 0 else 0.0) if neg else float(c)
        t = bool(self.val(node))
        return (1.0 if t else 0.0) if neg else (0.0 if t else 1.0)

    def check(self):
        per = [(no, src, self.viol(node)) for no, src, node in self.m.cons]
        obj = None
        if self.m.obj:
            obj = float(self.val(self.m.obj[2]))
        return per, obj


# ================================================================ presets
def _preset_queens():
    return """# N-Queens: place 32 queens on a 32x32 board so that no two attack each other.
# q is a permutation (queen in column i sits on row q[i]), so rows and columns can never clash;
# the walkers only have to remove diagonal attacks.
n = 32
var q[n] perm
count(1 for i in range(n) for j in range(i + 1, n) if abs(q[i] - q[j]) == j - i) == 0
temperature: 1.5 .. 0.05
"""


def _preset_colour():
    rs = np.random.RandomState(11)
    n, k = 40, 4
    hidden = rs.randint(0, k, n)
    E = [(i, j) for i in range(n) for j in range(i + 1, n) if hidden[i] != hidden[j] and rs.rand() < 0.3]
    return """# Graph colouring: give each of 40 nodes one of 4 colours so no edge joins two nodes of the same colour.
# {m} edges (a random graph built to be 4-colourable).
E = {E}
var c[40] int 0..3
all(c[u] != c[v] for (u, v) in E)
temperature: 2 .. 0.05
""".format(m=len(E), E=repr(E).replace(" ", ""))


def _preset_magic():
    return """# Magic square: place 1..16 so that every row, column and both diagonals sum to 34.
var m[16] perm             # m holds 0..15; the square shows m + 1
s = 34
all(sum(m[4 * r + c] + 1 for c in range(4)) == s for r in range(4))
all(sum(m[4 * r + c] + 1 for r in range(4)) == s for c in range(4))
sum(m[5 * i] + 1 for i in range(4)) == s
sum(m[3 * i + 3] + 1 for i in range(4)) == s
temperature: 3 .. 0.05
"""


def _preset_subset():
    rs = np.random.RandomState(5)
    W = rs.randint(100, 1000, 30).tolist()
    pick = rs.rand(30) < 0.5
    target = int(np.array(W)[pick].sum())
    return """# Subset sum: choose some of these 30 numbers so they add up exactly to the target.
W = {W}
target = {t}
var pick[30] bool
sum(W[i] * pick[i] for i in range(30)) == target
""".format(W=repr(W).replace(" ", ""), t=target)


def _preset_sat():
    rs = np.random.RandomState(3)
    n, m = 60, 250
    hidden = rs.rand(n) < 0.5
    C = []
    while len(C) < m:
        vs = rs.choice(n, 3, replace=False)
        sg = rs.rand(3) < 0.5
        if any(hidden[v] == s for v, s in zip(vs, sg)):          # planted: the hidden assignment satisfies it
            C.append(tuple(int(v + 1) if s else -int(v + 1) for v, s in zip(vs, sg)))
    return """# 3-SAT: 60 boolean variables, 250 clauses of three literals each; every clause needs at least one true literal.
# A literal +k means x[k-1] is true, -k means it is false.
C = {C}
var x[60] bool
all((x[abs(a) - 1] == (a > 0)) or (x[abs(b) - 1] == (b > 0)) or (x[abs(c) - 1] == (c > 0)) for (a, b, c) in C)
temperature: 2 .. 0.05
""".format(C=repr(C).replace(" ", ""))


def _preset_tsp():
    rs = np.random.RandomState(8)
    P = [(int(x), int(y)) for x, y in rs.randint(0, 100, (30, 2))]
    return """# Travelling salesman: visit all 30 cities once and return home by the shortest route.
P = {P}
var t perm 30
minimize: sum(sqrt((P[t[i]][0] - P[t[(i + 1) % 30]][0]) ** 2 + (P[t[i]][1] - P[t[(i + 1) % 30]][1]) ** 2) for i in range(30))
""".format(P=repr(P).replace(" ", ""))


def _preset_pyth():
    return """# Integer equations: the Pythagorean triple a < b < c whose sides add up to 1000.
var a, b, c int 1..999
a ** 2 + b ** 2 == c ** 2
a + b + c == 1000
a < b < c
sweeps: 200000             # 3 variables = 3 moves per sweep; give the walk room to escape traps like (1, 500, 500)
"""


def _preset_reals():
    return """# Nonlinear equations over the reals: find x, y with x^2 + y^2 = 25 and x*y = 12 (to 1e-4).
var x, y real -10..10
x * x + y * y == 25
x * y == 12
tolerance: 0.0001
"""


PRESETS = [("N-Queens (32)", _preset_queens), ("Graph colouring (40 nodes, 4 colours)", _preset_colour),
           ("Magic square 4x4", _preset_magic), ("Subset sum (30 numbers)", _preset_subset),
           ("3-SAT (60 vars, 250 clauses)", _preset_sat), ("Travelling salesman (30 cities)", _preset_tsp),
           ("Integer equations (Pythagorean, sum 1000)", _preset_pyth), ("Real equations (x²+y²=25, xy=12)", _preset_reals)]
MODELS = {k: f() for k, f in PRESETS}
NAMES = [k for k, _ in PRESETS]

FIELDS = [{"k": "preset", "type": "choice", "label": "Problem", "choices": NAMES, "default": NAMES[0], "models": MODELS},
          {"k": "model", "type": "text", "label": "Model (edit freely — vars, constraints, optional minimize:)",
           "default": MODELS[NAMES[0]]},
          {"k": "walkers", "type": "int", "label": "Walkers", "default": 2048, "min": 128, "max": 16384},
          {"k": "sweeps", "type": "int", "label": "Sweeps (max)", "default": 3000, "min": 50, "max": 50000},
          {"k": "heat", "type": "float", "label": "Temperature ×", "default": 1.0, "min": 0.1, "max": 5.0},
          {"k": "time_limit", "type": "float", "label": "Time limit (s)", "default": 45, "min": 1, "max": 600}]
SPEC = {"name": "Walk solver", "icon": "walk",
        "blurb": "Encode a problem as variables and constraints; thousands of GPU walkers random-walk them until every constraint holds.",
        "fields": FIELDS}


def _norm(s):
    return re.sub(r"\s+", " ", (s or "").strip())


_PRESET_NORMS = {_norm(v) for v in MODELS.values()}


# ================================================================ run
def _fmt_val(x, real):
    return "{:.6g}".format(x) if real else str(int(x))


def _assignment(m, X, R):
    out, text = {}, []
    for name in m.order:
        v = m.vars[name]
        src = X if v["store"] == "X" else R
        real = v["store"] == "R"
        if v["n"] is None:
            val = float(src[v["off"]]) if real else int(src[v["off"]])
            out[name] = val
            text.append("{} = {}".format(name, _fmt_val(val, real)))
        else:
            vals = [float(x) if real else int(x) for x in src[v["off"]:v["off"] + v["n"]]]
            out[name] = vals
            shown = ", ".join(_fmt_val(x, real) for x in vals[:64]) + (", …" if len(vals) > 64 else "")
            text.append("{} = [{}]".format(name, shown))
    return out, "; ".join(text)


def run(p):
    t_start = time.time()
    preset = p.get("preset") if p.get("preset") in MODELS else NAMES[0]
    text = p.get("model") or ""
    if not text.strip() or _norm(text) in _PRESET_NORMS:   # untouched preset text follows the Problem picker
        text = MODELS[preset]
    m = Model(text)
    src, totw = compile_model(m)
    W = int(max(128, min(int(p.get("walkers") or 2048), 16384)))
    per_walker = (m.ni + m.nf) * 8 + 40
    W = int(max(32, min(W, engine.budget_bytes(150) // max(1, per_walker))))
    sweeps = int(max(1, min(int(p.get("sweeps") or 3000), 50000)))
    heat = float(p.get("heat") or 1.0)
    has_reals = m.nf > 0
    tol = m.tol if m.tol is not None else (1e-3 if has_reals else 1e-6)
    pen = m.penalty if m.penalty is not None else (10.0 if m.obj else 1.0)
    if m.sweeps:
        sweeps = int(max(1, min(m.sweeps, 1000000)))
    total = sweeps * totw                             # proposals per walker
    if totw < 16:
        total = max(total, 200000)                    # a sweep of a 3-variable model is 3 moves: give tiny models a real anneal
    NI, NF = max(1, m.ni), max(1, m.nf)
    grid, blk = ((W + 127) // 128,), (128,)
    st = {}

    def setup():
        mod = _module(src)
        st["mod"] = mod
        st["XI"] = cp.zeros(W * NI, cp.int32)
        st["XF"] = cp.zeros(W * NF, cp.float32)
        st["S"] = cp.zeros(W, cp.uint32)
        st["BE"] = cp.full(W, 3.0e38, cp.float32)
        st["BV"] = cp.full(W, 3.0e38, cp.float32)
        st["BXI"] = cp.zeros(W * NI, cp.int32)
        st["BXF"] = cp.zeros(W * NF, cp.float32)
        st["CE"] = cp.zeros(W, cp.float32)
        st["CV"] = cp.zeros(W, cp.float32)
        st["found"] = cp.zeros(1, cp.int32)
        st["foundat"] = cp.full(1, 2147483647, cp.int32)
        mod.get_function("winit")(grid, blk, (np.int32(W), st["XI"], st["XF"], st["S"], np.uint32(int(time.time() * 1000) & 0x7FFFFFFF)))
        mod.get_function("wenergy")(grid, blk, (np.int32(W), st["XI"], st["XF"], np.float32(pen), st["CE"], st["CV"]))
        sync()
        ce = cp.asnumpy(st["CE"])
        return float(np.std(ce)), float(np.median(cp.asnumpy(st["CV"]))), float(np.median(ce))
    try:
        e_std, v0, e0 = run_on_gpu(setup, "walk solver: compile", 120)
    except ModelError:
        raise
    except engine.GPUMemoryError:
        raise
    except Exception as e:  # noqa: BLE001
        raise ModelError("the solver build failed: {}".format(str(e)[:300]))
    if m.temp:
        T0, T1 = m.temp
    else:
        T0 = max(0.5, 0.5 * e_std)
        T1 = T0 * 1e-3 if m.obj else min(0.05, T0 * 0.01)
        if has_reals and not m.obj:
            T1 = max(tol * 0.1, 1e-6)
    T0, T1 = T0 * heat, T1 * heat
    if T1 >= T0:
        T1 = T0 * 0.5
    stopfound = 0 if m.obj else 1
    hist_x, hist_best, hist_med = [0.0], [], []
    hist_best.append(v0 if not m.obj else e0)
    hist_med.append(v0 if not m.obj else e0)
    from . import cards
    # first launch sized to the card; then each launch aims at `target` seconds (longer when no display watchdog applies)
    done, steps, found, stopped = 0, int(16 * cards.work_scale()), False, None
    target = 0.35 if cards.gpu_card().get("watchdog", True) else 1.0

    def chunk(steps, base):
        t = time.time()
        st["mod"].get_function("wstep")(grid, blk, (
            np.int32(W), np.int32(steps), np.int64(base), np.int64(total), np.float32(T0), np.float32(T1), np.float32(pen),
            np.float32(tol), np.int32(stopfound), st["XI"], st["XF"], st["S"], st["BE"], st["BV"], st["BXI"], st["BXF"],
            st["CE"], st["CV"], st["found"], st["foundat"]))
        sync()
        dt = time.time() - t
        f = int(st["found"].get()[0])
        if m.obj:
            best, med = float(st["BE"].min()), float(cp.sort(st["CE"])[W // 2])
        else:
            best, med = float(st["BV"].min()), float(cp.sort(st["CV"])[W // 2])
        return dt, f, best, med
    while done < total:
        n = int(min(steps, total - done))
        dt, f, best, med = run_on_gpu(lambda: chunk(n, done), "walk solver", 60)
        done += n
        hist_x.append(round(done / float(totw), 2))
        hist_best.append(best)
        hist_med.append(med)
        if f:
            found = True
            break
        if time.time() - t_start > float(p.get("time_limit") or TIME_LIMIT):
            stopped = "time"
            break
        steps = int(max(8, min(steps * 8, steps * target / max(dt, 1e-4), 2000000)))

    def collect():
        BE, BV = cp.asnumpy(st["BE"]), cp.asnumpy(st["BV"])
        key = np.where(BV <= tol, BE, BE + 1.0e30) if m.obj else BV
        w = int(np.argmin(key))
        fa = int(st["foundat"].get()[0])
        X = cp.asnumpy(st["BXI"][w * NI:(w + 1) * NI]).tolist()
        R = cp.asnumpy(st["BXF"][w * NF:(w + 1) * NF]).tolist()
        for k in list(st):
            st.pop(k)
        cp.get_default_memory_pool().free_all_blocks()
        return w, BE, BV, X, R, fa
    w, BE, BV, X, R, fa = run_on_gpu(collect, "walk solver", 60)
    secs = time.time() - t_start
    X = [int(x) for x in X]
    R = [float(x) for x in R]
    sol, sol_text = _assignment(m, X, R)
    per, obj_cpu = CPUCheck(m, X, R).check()
    v_cpu = sum(p_[2] for p_ in per)
    feasible = v_cpu <= max(tol * 10, 1e-6)
    solved_n = int((BV <= tol).sum())
    if found and fa < 2147483647:
        done = min(done, (fa + 1) * totw)            # the launch stopped early: count only the sweeps actually walked
    swept = round(done / float(totw), 1)
    hist_x[-1] = swept
    moves = done * W
    vio = [(no, s_, round(v_, 4)) for no, s_, v_ in per if v_ > max(tol * 10, 1e-6)]

    if m.obj:
        objv = obj_cpu
        headline = "{:.6g}".format(objv) if feasible else "infeasible"
        tone = "good" if feasible else "bad"
        sentence = ("Best {} {} found by walker #{} of {} after {} sweeps ({} moves in {:.1f} s){}. {}".format(
            "minimum" if m.obj[0] == "minimize" else "maximum", "{:.6g}".format(objv), w, W, "{:,}".format(swept), _big(moves), secs,
            "" if feasible else " — but it still breaks a constraint", sol_text))
    elif feasible:
        headline, tone = "SOLVED", "good"
        sentence = "{} — walker #{} of {} got there after {:,} sweeps ({} moves in {:.1f} s). {}".format(
            "The constraint holds" if len(m.cons) == 1 else "All {} constraints hold".format(len(m.cons)),
            w, W, swept, _big(moves), secs, sol_text)
    else:
        headline, tone = "E = {:.4g}".format(v_cpu), "warn"
        why = "the time limit" if stopped == "time" else "the sweep budget"
        sentence = ("Not solved within {}: the best walker still misses by {:.4g} (line{} {}). "
                    "Try more sweeps, more walkers or a different temperature. Best so far: {}").format(
            why, v_cpu, "" if len(vio) == 1 else "s", ", ".join(str(no) for no, _, _ in vio[:6]), sol_text)
    final = BE if m.obj else BV
    fin = final[np.isfinite(final) & (final < 1e37)]
    if fin.size:
        lo, hi = float(fin.min()), float(fin.max())
        if hi <= lo:
            hi = lo + 1.0
        cnt, edges = np.histogram(fin, bins=24, range=(lo, hi))
    else:
        cnt, edges = np.zeros(1), np.array([0.0, 1.0])
    unit = ""
    facts = [["Walkers", "{:,}".format(W)], ["Sweeps", "{:,}".format(swept)], ["Moves", _big(moves)],
             ["Walkers solved" if not m.obj else "Feasible walkers", "{:,}".format(solved_n)],
             ["Best energy", "{:.4g}".format(float(np.min(final)) if final.size else 0.0)],
             ["CPU re-check", "passed" if feasible else "failed"],
             ["Variables", "{:,}".format(m.ni + m.nf)], ["Temperature", "{:.3g} → {:.3g}".format(T0, T1)],
             ["Moves / s", _big(moves / max(secs, 1e-6))]]
    return {"headline": headline, "sentence": sentence, "tone": tone, "paths": int(W * max(1, swept)), "ms": round(secs * 1000, 1),
            "chart": {"type": "lines", "x": hist_x,
                      "series": [{"y": [round(float(v), 4) for v in hist_best]}, {"y": [round(float(v), 4) for v in hist_med]}],
                      "title": ("best objective (red) and median walker (blue) vs sweeps" if m.obj
                                else "constraint violation: best walker (red) and median walker (blue) vs sweeps"), "unit": unit},
            "chart2": {"type": "hist", "edges": [round(float(e), 4) for e in edges], "y": [int(c) for c in cnt],
                       "title": "final best {} across walkers".format("energy" if m.obj else "violation")},
            "facts": facts, "solution": sol, "feasible": bool(feasible), "violations": [{"line": no, "src": s_, "by": v_} for no, s_, v_ in vio],
            "objective": obj_cpu, "walkers": W, "sweeps": swept, "model": text}


def _big(v):
    v = float(v)
    for d, s in ((1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "k")):
        if v >= d:
            return "{:.1f}{}".format(v / d, s)
    return "{:.0f}".format(v)
