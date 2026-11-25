"""Console models: run your own CuPy code on the card. Only for callers on your own network (LAN, Tailscale, this host).
Scripts run in their own process with the `vf` harness; they use the card directly, beside the server's GPU queue."""
from .. import console as C
from ..registry import model


@model("console.run", "Run Python on the card", "console",
       "Your code with CuPy (cp), NumPy (np) and the vf harness (vf.plot, vf.show, vf.table, vf.data…); outputs come back as a list.",
       device="gpu", local_only=True, timeout=620, timed=False,
       fields=[{"k": "code", "type": "text", "label": "Code", "required": True},
               {"k": "timeout", "type": "int", "label": "Time limit (s)", "default": 60, "min": 1, "max": 600},
               {"k": "name", "type": "str", "label": "Label (shown in the activity pill)", "default": ""}],
       example={"code": "x = cp.random.random(10**7, dtype=cp.float32)\nprint(float(x.mean()))"})
def run(code, timeout, name):
    return C.run(code or "", timeout, name or "")


@model("console.stop", "Stop every script", "console", "Stop all the Console scripts that run now.", device="cpu", local_only=True)
def stop():
    return {"stopped": C.stop_all()}


@model("console.examples", "Console examples", "console", "The Console's example programs.", device="cpu")
def examples():
    return C.EXAMPLES


def _vf_members():
    """vf's own functions and their signatures, read from the harness source (it cannot be imported in the server)."""
    import ast
    import os
    src = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "vfh.py"), encoding="utf-8").read()
    tree = ast.parse(src)
    classes = {n.name: n for n in tree.body if isinstance(n, ast.ClassDef)}

    def sig(fn):
        a = fn.args
        names = [x.arg for x in a.args][1:]                     # without self
        d = [None] * (len(names) - len(a.defaults)) + list(a.defaults)
        parts = []
        for n, dv in zip(names, d):
            parts.append(n if dv is None else "{}={}".format(n, _lit(dv)))
        if a.vararg:
            parts.append("*" + a.vararg.arg)
        for kw, dv in zip(a.kwonlyargs, a.kw_defaults):
            parts.append(kw.arg if dv is None else "{}={}".format(kw.arg, _lit(dv)))
        if a.kwarg:
            parts.append("**" + a.kwarg.arg)
        return "(" + ", ".join(parts) + ")", names

    out = []

    def walk(cls, path):
        for n in cls.body:
            if isinstance(n, ast.FunctionDef) and not n.name.startswith("_"):
                s, args = sig(n)
                out.append({"path": path + "." + n.name, "kind": "function", "sig": s, "args": args, "doc": (ast.get_docstring(n) or "").strip()})
            elif isinstance(n, ast.Assign) and isinstance(n.value, ast.Call) and getattr(n.value.func, "id", "") in classes:
                sub = classes[n.value.func.id]
                name = n.targets[0].id
                out.append({"path": path + "." + name, "kind": "module", "sig": "", "args": [], "doc": (ast.get_docstring(sub) or "").strip()})
                walk(sub, path + "." + name)
    walk(classes["VF"], "vf")
    return out


def _lit(node):
    try:
        import ast
        return repr(ast.literal_eval(node))
    except Exception:  # noqa: BLE001
        return "…"


@model("console.assist", "Console completions", "console",
       "What the Console editor offers as you type: vf's functions with their signatures and docs (read from the harness), "
       "every model with its parameters (for vf.run), and the problem templates (as snippets).", device="cpu")
def assist():
    from .. import problems, registry as R
    models = [{"name": m.name, "title": m.title, "summary": (m.summary or "")[:240], "long": m.long,
               "fields": [[f["k"], f.get("type", "str"), f.get("default") if not isinstance(f.get("default"), str) or len(f.get("default")) < 60 else "…",
                           f.get("label", "")] for f in m.fields]}
              for m in sorted(R.REGISTRY.values(), key=lambda m: m.name) if not m.local_only]
    tpl = [{"id": t["id"], "title": t["title"], "model": t["model"], "problem": t["problem"]} for t in problems.TEMPLATES]
    return {"vf": _vf_members(), "models": models, "templates": tpl}


@model("console.start", "Start Python on the card", "console",
       "Start your code and return at once with a run id; console.poll reads the outputs while it runs (printed text, vf.show, "
       "vf.plot, vf.table, the progress of vf.solve). console.stop stops it.",
       device="gpu", local_only=True, timeout=10, timed=False,
       fields=[{"k": "code", "type": "text", "label": "Code", "required": True},
               {"k": "timeout", "type": "int", "label": "Time limit (s)", "default": 60, "min": 1, "max": 600},
               {"k": "name", "type": "str", "label": "Label (shown in the activity pill)", "default": ""}],
       example={"code": "print('hello from the card')"})
def start(code, timeout, name):
    return C.start(code or "", timeout, name or "")


@model("console.poll", "Read a running script", "console", "The outputs of a run from index `since` on, and whether it is done.",
       device="cpu", local_only=True,
       fields=[{"k": "run", "type": "str", "label": "Run id", "required": True},
               {"k": "since", "type": "int", "label": "First output to return", "default": 0, "min": 0}])
def poll(run, since):
    from .. import registry as R
    try:
        return C.poll(run, since)
    except KeyError as e:
        raise R.Refused(str(e.args[0]), 404)
