// Console editor assist (CodeMirror 5): completion as you type, the signature of the call you are in, docs on hover and
// snippets. vf's own functions, their signatures and docs come from the harness source and every model with its
// parameters from the registry (the console.assist model), so the help is never out of date. np / cp: a short list of
// the functions people use most. Nothing here calls an AI model; the hints are exact.

const NP = `array|(object, dtype=None)|An array from a list (or nested lists).
asarray|(a, dtype=None)|An array from a, without a copy when it is one already. cp.asarray copies host data to the card.
asnumpy|(a)|cp only: copy a card array back to the host (NumPy).
zeros|(shape, dtype=float)|An array of zeros.
ones|(shape, dtype=float)|An array of ones.
full|(shape, fill_value, dtype=None)|An array filled with one value.
empty|(shape, dtype=float)|An array with no set values (fast).
zeros_like|(a, dtype=None)|Zeros with the shape of a.
arange|(start, stop=None, step=1, dtype=None)|Evenly spaced values in [start, stop).
linspace|(start, stop, num=50)|num values from start to stop.
meshgrid|(*xi, indexing='xy')|Coordinate grids from 1-D coordinates.
reshape|(a, newshape)|The same data in a new shape.
concatenate|((a1, a2, ...), axis=0)|Join arrays along an axis.
stack|(arrays, axis=0)|Join arrays along a new axis.
where|(condition, x, y)|x where condition is true, else y.
sum|(a, axis=None, dtype=None)|The sum of the elements.
mean|(a, axis=None)|The average.
median|(a, axis=None)|The middle value.
std|(a, axis=None, ddof=0)|The standard deviation.
var|(a, axis=None, ddof=0)|The variance.
min|(a, axis=None)|The smallest value.
max|(a, axis=None)|The largest value.
argmin|(a, axis=None)|Where the smallest value is.
argmax|(a, axis=None)|Where the largest value is.
argsort|(a, axis=-1)|The indices that sort a.
sort|(a, axis=-1)|A sorted copy.
cumsum|(a, axis=None)|Running totals.
percentile|(a, q, axis=None)|The q-th percentile (q in 0..100).
quantile|(a, q, axis=None)|The q-th quantile (q in 0..1).
histogram|(a, bins=10, range=None)|Counts in bins: (counts, edges).
bincount|(x, weights=None, minlength=0)|How often each non-negative integer occurs.
unique|(a, return_counts=False)|The distinct values.
clip|(a, a_min, a_max)|Limit the values to [a_min, a_max].
abs|(x)|The absolute value.
sqrt|(x)|The square root.
exp|(x)|e to the power x.
log|(x)|The natural logarithm.
log1p|(x)|log(1 + x), exact for small x.
sin|(x)|The sine.
cos|(x)|The cosine.
dot|(a, b)|The dot product (matrix product for 2-D).
matmul|(a, b)|The matrix product (the @ operator). Flatten batches to 2-D on Kepler cards: much faster.
outer|(a, b)|The outer product.
einsum|(subscripts, *operands)|Sums of products by index labels, e.g. 'ij,jk->ik'.
isnan|(x)|True where x is NaN.
nan_to_num|(x, nan=0.0)|Replace NaN and infinities.
float32|()|The 32-bit float type: the fast type on the card.
float64|()|The 64-bit float type: slow on most GeForce and Quadro cards.
int32|()|The 32-bit integer type.
random|()|Random numbers: random.random, random.normal, random.RandomState(seed).
linalg|()|Linear algebra: linalg.norm, linalg.solve, linalg.inv, linalg.eigh.
fft|()|Fourier transforms: fft.fft, fft.rfft, fft.fft2, fft.irfft.`;
const NPSUB = {
  random: `random|(size=None)|Uniform values in [0, 1).
random_sample|(size=None)|Uniform values in [0, 1).
normal|(loc=0.0, scale=1.0, size=None)|Normal (Gaussian) values.
uniform|(low=0.0, high=1.0, size=None)|Uniform values in [low, high).
randint|(low, high=None, size=None)|Random integers in [low, high).
choice|(a, size=None, replace=True, p=None)|Random picks from a.
permutation|(x)|A random order.
seed|(seed)|Set the seed of the global generator.
RandomState|(seed=None)|A generator with its own seed: the same numbers each run (common random numbers).`,
  linalg: `norm|(x, ord=None, axis=None)|The length of a vector or the size of a matrix.
solve|(a, b)|x such that a @ x = b.
inv|(a)|The inverse matrix.
eigh|(a)|Eigenvalues and vectors of a symmetric matrix.
svd|(a, full_matrices=True)|The singular value decomposition. Slow for big square matrices on Kepler cards.
qr|(a)|The QR decomposition.`,
  fft: `fft|(a, n=None, axis=-1)|The discrete Fourier transform.
ifft|(a, n=None, axis=-1)|The inverse transform.
rfft|(a, n=None, axis=-1)|The transform of a real signal (half the spectrum).
irfft|(a, n=None, axis=-1)|The inverse of rfft.
rfftfreq|(n, d=1.0)|The frequencies of rfft bins.
fft2|(a)|The 2-D transform.`,
};
const parseList = (s) => s.split("\n").map((l) => { const [n, sig, doc] = l.split("|"); return { n, sig, doc }; });
const LIB = {};
for (const base of ["np", "cp"]) {
  LIB[base] = parseList(NP).filter((x) => base === "cp" || x.n !== "asnumpy");
  for (const [k, v] of Object.entries(NPSUB)) LIB[base + "." + k] = parseList(v);
}
LIB.cp.push({ n: "ElementwiseKernel", sig: "(in_params, out_params, operation, name)", doc: "Your own C expression, run once for each element on the card." },
  { n: "RawKernel", sig: "(code, name)", doc: "A CUDA C kernel from source; call it with (grid, block, args)." },
  { n: "cuda", sig: "()", doc: "The card: cuda.Stream.null.synchronize(), cuda.Device().mem_info." });

let CAT = null, loading = null;
const byPath = {};
export async function catalogue() {
  if (CAT) return CAT;
  if (!loading) loading = fetch("/v1/models/console.assist", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
    .then((r) => r.json()).then((j) => { CAT = j.result; CAT.vf.forEach((m) => { byPath[m.path] = m; }); CAT.modelBy = Object.fromEntries(CAT.models.map((m) => [m.name, m])); return CAT; })
    .catch(() => { loading = null; return null; });
  return loading;
}
function loadHintAddon() {
  if (window.CodeMirror && window.CodeMirror.showHint) return Promise.resolve(true);
  return new Promise((ok) => {
    const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "vendor/codemirror-5.65.16/addon/hint/show-hint.min.css"; document.head.appendChild(l);
    const s = document.createElement("script"); s.src = "vendor/codemirror-5.65.16/addon/hint/show-hint.min.js"; s.onload = () => ok(true); s.onerror = () => ok(false); document.head.appendChild(s);
  });
}
const CSS = `
.CodeMirror-hints.ca,ul.CodeMirror-hints{z-index:60;background:var(--panel-2);border:1px solid var(--line-2);border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.55);font:12px/1.35 var(--mono);padding:3px;max-height:18em}
.CodeMirror-hints li.CodeMirror-hint{color:var(--ink-2);padding:3px 8px;border-radius:5px;white-space:pre;max-width:560px;overflow:hidden;text-overflow:ellipsis}
.CodeMirror-hint .ca-k{color:var(--muted);margin-left:10px;font-family:var(--font)}
.CodeMirror-hints li.CodeMirror-hint-active{background:var(--rosso-soft);color:var(--ink)}
.ca-tip{position:fixed;z-index:59;max-width:560px;background:#0d0d10;border:1px solid var(--line-2);border-radius:8px;padding:7px 10px;font:12px/1.45 var(--font);color:var(--ink-2);box-shadow:0 8px 24px rgba(0,0,0,.5);pointer-events:none}
.ca-tip code{font:12px var(--mono);color:var(--ink)} .ca-tip code b{color:var(--rosso-hi)} .ca-tip .d{margin-top:3px;white-space:pre-wrap} .ca-tip .m{color:var(--muted);font-size:11px;margin-top:3px}`;

// ---------------------------------------------------------------- reading the code around the cursor
// The innermost open call before the cursor: {callee, arg (index), kw (name being typed, if 'k='), first (string literal arg 0), used (kw names)}
export function callAt(text) {
  const st = [];
  let i = 0, q = null;
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === "\\") { i += 2; continue; }
      if (text.startsWith(q, i)) { const top = st[st.length - 1]; if (top && top.arg === 0 && top.strAt != null && top.first == null) top.first = text.slice(top.strAt, i); i += q.length; q = null; continue; }
      i++; continue;
    }
    if (c === "#") { const e = text.indexOf("\n", i); if (e < 0) break; i = e; continue; }
    if (c === '"' || c === "'") {
      q = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      const top = st[st.length - 1]; if (top && top.arg === 0 && top.first == null && !text.slice(top.at, i).trim()) top.strAt = i + q.length;
      i += q.length; continue;
    }
    if (c === "(" || c === "[" || c === "{") { const m = /([A-Za-z_][\w.]*)\s*$/.exec(text.slice(Math.max(0, i - 80), i)); st.push({ ch: c, callee: c === "(" && m ? m[1] : null, arg: 0, at: i + 1, argAt: i + 1, used: [] }); i++; continue; }
    if (c === ")" || c === "]" || c === "}") { st.pop(); i++; continue; }
    if (c === "," && st.length) { const top = st[st.length - 1]; const seg = text.slice(top.argAt, i); const k = /^\s*([A-Za-z_]\w*)\s*=(?!=)/.exec(seg); if (k) top.used.push(k[1]); top.arg++; top.argAt = i + 1; }
    i++;
  }
  for (let k = st.length - 1; k >= 0; k--) if (st[k].ch === "(" && st[k].callee) {
    const t = st[k], seg = text.slice(t.argAt);
    const kw = /^\s*([A-Za-z_]\w*)\s*=(?!=)/.exec(seg);
    return { callee: t.callee, arg: t.arg, kw: kw ? kw[1] : null, typing: /^\s*([A-Za-z_]\w*)?$/.exec(seg) ? seg.trim() : null, first: t.first, used: t.used, inString: q != null && k === st.length - 1 && t.arg === 0 };
  }
  return null;
}
// what a callee takes: [{name, def, label}] plus a title and a doc
export function sigOf(call) {
  if (!call || !CAT) return null;
  const c = call.callee;
  if (c === "vf.run" && call.first && CAT.modelBy[call.first]) {
    const m = CAT.modelBy[call.first];
    return { title: `vf.run("${m.name}", …)`, params: [{ name: "model", def: null, label: "the model name" }, ...m.fields.map(([k, t, d, l]) => ({ name: k, def: d, label: `${t}${l ? " · " + l : ""}` }))], doc: m.summary, kwOnlyAfter: 1 };
  }
  const v = byPath[c];
  if (v && v.kind === "function") {
    const ps = v.sig.slice(1, -1).split(/,\s*(?![^()]*\))/).filter(Boolean).map((p) => { const [n, d] = p.split("="); return { name: n.replace(/^\*+/, ""), def: d ?? null, star: p.startsWith("*") }; });
    return { title: c, params: ps, doc: v.doc };
  }
  const lib = libEntry(c);
  if (lib) return { title: c, params: lib.sig.slice(1, -1).split(/,\s*/).filter(Boolean).map((p) => { const [n, d] = p.split("="); return { name: n, def: d ?? null }; }), doc: lib.doc };
  return null;
}
function libEntry(path) {
  const i = path.lastIndexOf("."); if (i < 0) return null;
  const base = path.slice(0, i), n = path.slice(i + 1);
  return (LIB[base] || []).find((x) => x.n === n) || null;
}
export function docOf(path) {
  if (!CAT) return null;
  const v = byPath[path];
  if (v) return { sig: v.kind === "function" ? path + v.sig : path, doc: v.doc || (v.kind === "module" ? "members: " + CAT.vf.filter((m) => m.path.startsWith(path + ".") && !m.path.slice(path.length + 1).includes(".")).map((m) => m.path.slice(path.length + 1)).join(", ") : "") };
  const lib = libEntry(path);
  if (lib) return { sig: path + lib.sig, doc: lib.doc };
  if (path === "vf") return { sig: "vf", doc: "The VectorFall helpers: " + CAT.vf.filter((m) => !m.path.slice(3).includes(".")).map((m) => m.path.slice(3)).join(", ") };
  if (path === "np") return { sig: "np", doc: "NumPy: arrays on the CPU." };
  if (path === "cp") return { sig: "cp", doc: "CuPy: the same functions as NumPy, on the card." };
  return null;
}

// ---------------------------------------------------------------- completion
function hintAt(cm) {
  const cur = cm.getCursor(), line = cm.getLine(cur.line), pre = line.slice(0, cur.ch);
  const before = cm.getRange({ line: Math.max(0, cur.line - 30), ch: 0 }, cur);
  const call = callAt(before);
  // 1. a model name inside vf.run("…
  if (call && call.callee === "vf.run" && call.arg === 0 && call.inString) {
    const m = /([\w.]*)$/.exec(pre), w = m[1];
    const list = CAT.models.filter((x) => x.name.startsWith(w) || (w.length > 1 && (x.name + " " + x.title).toLowerCase().includes(w.toLowerCase())));
    return { list: list.slice(0, 60).map((x) => ({ text: x.name, displayText: x.name, render: (el) => { el.innerHTML = `${esc(x.name)}<span class="ca-k">${esc(x.title)}</span>`; } })),
      from: { line: cur.line, ch: cur.ch - w.length }, to: cur };
  }
  // 2. a dotted name: vf.solve.ro…, cp.random.no…
  const dm = /([A-Za-z_][\w]*(?:\.[\w]*)+)$/.exec(pre);
  if (dm) {
    const full = dm[1], k = full.lastIndexOf("."), base = full.slice(0, k), w = full.slice(k + 1);
    let items = [];
    if (base === "vf" || base.startsWith("vf.")) items = CAT.vf.filter((m) => m.path.startsWith(base + ".") && !m.path.slice(base.length + 1).includes(".")).map((m) => ({ n: m.path.slice(base.length + 1), sig: m.sig, doc: m.doc, mod: m.kind === "module" }));
    else if (LIB[base]) items = LIB[base].map((x) => ({ n: x.n, sig: x.sig === "()" ? "" : x.sig, doc: x.doc, mod: !!LIB[base + "." + x.n] }));
    items = items.filter((x) => x.n.startsWith(w));
    if (items.length) return { list: items.map((x) => ({ text: x.n, render: (el) => { el.innerHTML = `${esc(x.n)}${x.mod ? "." : esc(shortSig(x.sig))}<span class="ca-k">${esc((x.doc || "").split("\n")[0].slice(0, 70))}</span>`; } })),
      from: { line: cur.line, ch: cur.ch - w.length }, to: cur };
  }
  // 3. a keyword argument of the call we are in
  if (call && call.typing != null && !call.kw) {
    const s = sigOf(call);
    if (s) {
      const w = call.typing, used = new Set(call.used);
      const ps = s.params.filter((p, i) => !p.star && !used.has(p.name) && (s.kwOnlyAfter == null || i >= s.kwOnlyAfter) && p.name.startsWith(w) && p.name !== "self");
      if (ps.length) return { list: ps.map((p) => ({ text: p.name + "=", render: (el) => { el.innerHTML = `${esc(p.name)}=<span class="ca-k">${esc(p.label || (p.def != null ? "default " + p.def : "required"))}</span>`; } })),
        from: { line: cur.line, ch: cur.ch - w.length }, to: cur };
    }
  }
  // 4. a bare word: the names that are always there
  const bw = /(^|[^\w.])([A-Za-z_]\w*)$/.exec(pre);
  if (bw && bw[2].length >= 1) {
    const w = bw[2], names = [["vf", "the VectorFall helpers"], ["np", "NumPy (CPU)"], ["cp", "CuPy (the card)"], ["math", "Python math"], ["time", "Python time"], ["print", "print(…)"]];
    const l = names.filter(([n]) => n.startsWith(w) && n !== w);
    if (l.length) return { list: l.map(([n, d]) => ({ text: n, render: (el) => { el.innerHTML = `${esc(n)}<span class="ca-k">${esc(d)}</span>`; } })), from: { line: cur.line, ch: cur.ch - w.length }, to: cur };
  }
  return null;
}
const shortSig = (s) => !s ? "" : s.length > 48 ? s.slice(0, 46) + "…)" : s;
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------- tooltips
let tip = null;
function showTip(html, x, y, below = true, yBelow = null) {
  if (!tip) { tip = document.createElement("div"); tip.className = "ca-tip"; document.body.appendChild(tip); }
  tip.innerHTML = html; tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.max(6, Math.min(window.innerWidth - w - 6, x)) + "px";
  tip.style.top = (below ? y + 4 : y - h - 4 < 70 && yBelow != null ? yBelow + 4 : Math.max(6, y - h - 4)) + "px";
}
const hideTip = () => { if (tip) tip.hidden = true; };
function sigHTML(s, call) {
  const ps = s.params.map((p, i) => {
    const cur = call.kw ? p.name === call.kw : (s.kwOnlyAfter == null ? i === call.arg : i === 0 && call.arg === 0);
    const t = esc(p.name + (p.def != null ? "=" + p.def : ""));
    return cur ? `<b>${t}</b>` : t;
  });
  const curP = s.params.find((p, i) => call.kw ? p.name === call.kw : i === call.arg);
  const name = s.title.endsWith("…)") ? s.title.slice(0, -2) : s.title + "(";
  return `<code>${esc(name)}${ps.join(", ")})</code>${curP && curP.label ? `<div class="m">${esc(curP.name)}: ${esc(curP.label)}</div>` : ""}${s.doc ? `<div class="d">${esc(s.doc.split("\n").slice(0, 3).join("\n"))}</div>` : ""}`;
}

export async function attach(cm) {
  if (!cm || !cm.on) return;
  const st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
  const [ok] = await Promise.all([loadHintAddon(), catalogue()]);
  if (!CAT) return;
  const complete = (c) => { if (!ok || !c.showHint) return; c.showHint({ hint: (cc) => hintAt(cc), completeSingle: false, closeCharacters: /[\s()\[\]{};>,]/ }); };
  cm.addKeyMap({ "Ctrl-Space": complete, "Cmd-Space": complete, "Ctrl-I": complete });
  cm.on("inputRead", (c, ch) => {
    const t = ch.text.join("");
    if (/^[\w.("',=]$/.test(t) && !(c.state.completionActive)) {
      const cur = c.getCursor(), pre = c.getLine(cur.line).slice(0, cur.ch);
      if (/\.\w*$/.test(pre) || /vf\.run\(\s*["'][\w.]*$/.test(pre) || /[(,]\s*\w*$/.test(pre) || /(^|[^\w.])\w{1,}$/.test(pre)) complete(c);
    }
  });
  // the signature of the call the cursor is in
  let sigT = 0;
  cm.on("cursorActivity", (c) => {
    clearTimeout(sigT);
    sigT = setTimeout(() => {
      const cur = c.getCursor(), call = callAt(c.getRange({ line: Math.max(0, cur.line - 30), ch: 0 }, cur));
      const s = call && sigOf(call);
      if (!s || !c.hasFocus()) { hideTip(); return; }
      const xy = c.cursorCoords(cur, "window");
      showTip(sigHTML(s, call), xy.left, xy.top, false, xy.bottom);
    }, 120);
  });
  cm.on("blur", hideTip);
  cm.on("keydown", (c, e) => { if (e.key === "Escape") hideTip(); });
  // docs on hover
  let hovT = 0;
  const wrap = cm.getWrapperElement();
  wrap.addEventListener("mousemove", (e) => {
    clearTimeout(hovT);
    hovT = setTimeout(() => {
      const pos = cm.coordsChar({ left: e.clientX, top: e.clientY }, "window"), line = cm.getLine(pos.line) || "";
      let a = pos.ch, b = pos.ch;
      while (a > 0 && /[\w.]/.test(line[a - 1])) a--;
      while (b < line.length && /\w/.test(line[b])) b++;
      const path = line.slice(a, b).replace(/^\.+/, "");
      const d = path && docOf(path);
      if (d && !cm.state.completionActive) showTip(`<code>${esc(d.sig)}</code>${d.doc ? `<div class="d">${esc(d.doc.split("\n").slice(0, 4).join("\n"))}</div>` : ""}`, e.clientX + 8, e.clientY + 10);
      else if (!cm.hasFocus()) hideTip();
    }, 350);
  });
  wrap.addEventListener("mouseleave", () => { clearTimeout(hovT); if (!cm.hasFocus()) hideTip(); });
}

// ---------------------------------------------------------------- snippets
const BASE = [
  ["Solve a roster (shifts)", `people = """name,max_shifts,skills,unavailable
Ana,5,nurse,Sun
Ben,5,nurse,
Cara,4,nurse,Sat"""
shifts = """shift,day,start,end,needed,skill
Early,Mon,07:00,15:00,1,nurse
Late,Mon,15:00,23:00,1,nurse
Early,Tue,07:00,15:00,1,nurse"""
r = vf.solve.roster(people, shifts, rest=11)
r.show()`],
  ["Route from a cost table", `costs = """from,Depot,A,B,C
Depot,0,12,7,20
A,14,0,5,9
B,7,6,0,11
C,22,9,10,0"""
r = vf.solve.route(costs=costs, unit="min")
r.show()`],
  ["Fair teams from a Data Desk table", `print(vf.data.list())
r = vf.solve.teams("Staff skills", k=6, pairs="Gray - Blake")   # a table name, or CSV text
r.show()`],
  ["Budget risk", `items = """Design, 18000, 24000, 40000
Build, 60000, 85000, 150000
Risk: vendor slips, 10000, 20000, 60000, 30%"""
for b in (140_000, 160_000, 180_000):
    print(b, vf.solve.budget(items, b, sims=500_000)["headline"])`],
  ["Queue staffing sweep", `for servers in range(8, 12):
    r = vf.solve.queue(arrivals=120, service=4, servers=servers)
    print(servers, r["sentence"])`],
  ["Check inputs before solving", `print(vf.solve.check("route", costs="from,A,B,C\\nA,0,1,2\\nB,1,0,3\\nC,2,3,0"))`],
  ["Any model by name", `print(vf.models("budget"))
print(vf.describe("sim.budget"))
r = vf.run("sim.budget", budget=180000, sims=200000)
print(r)`],
];
export async function snippets() {
  await catalogue();
  const t = (CAT && CAT.templates || []).map((x) => [`Template: ${x.title}`, `# ${x.problem}\n# vf.template("${x.id}") shows the inputs; change any of them here:\nr = vf.solve.template("${x.id}")\nr.show()`]);
  return [...BASE, ...t];
}
