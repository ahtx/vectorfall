// The connective tissue between apps: one way to pick data from the Data Desk, one "send to" menu, one sheet (modal),
// and one time-series chart. Every tool that reads numbers reads them from Data Desk tables, and every result that is
// a list of things (incidents, detections, a roster) can be saved back as a table — so any output is another input.
import { $, $$, api, esc, fmt, go, icon } from "./core.js";

// ---------------------------------------------------------------- sheet: a pane floating over the workspace
export function sheet({ title = "", body = "", foot = "", wide = false, onClose } = {}) {
  const ov = document.createElement("div");
  ov.className = "vf-sheet";
  ov.innerHTML = `<section class="pane ${wide ? "wide" : ""}"><div class="pane-h"><div class="t">${title}</div><div class="tools"><button class="iconbtn" data-x title="Close (Esc)">${icon("x")}</button></div></div>
    <div class="pane-b">${body}</div>${foot ? `<div class="pane-act sheet-act">${foot}</div>` : ""}</section>`;
  document.body.appendChild(ov);
  const close = () => { ov.remove(); document.removeEventListener("keydown", key, true); if (onClose) onClose(); };
  const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  document.addEventListener("keydown", key, true);
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(); });
  ov.querySelector("[data-x]").onclick = close;
  return { el: ov.querySelector(".pane"), close, $: (s) => ov.querySelector(s) };
}

// ---------------------------------------------------------------- pick columns from a Data Desk table
// pickColumns({ title, multi, hint }) -> Promise<{ tid, table, cols, date_col } | null>
export function pickColumns({ title = "Choose data", multi = false, hint = "", min = 1 } = {}) {
  return new Promise(async (resolve) => {
    let tables = [];
    try { tables = await api.get("/tables"); } catch (e) { tables = []; }
    let done = false, cur = null, picked = [], dates = [];
    const s = sheet({
      title, wide: true,
      body: `<div class="pick">${hint ? `<div class="hint pick-hint">${hint}</div>` : ""}
        <div class="pick-cols"><div><div class="sec-t">Table</div><div class="list pick-t" id="pk-t">${tables.length ? tables.map((t) => `<div class="li" data-t="${t.id}"><div class="ic">${icon("data")}</div><div class="tx"><div class="nm">${esc(t.name)}</div><div class="sub">${fmt.n(t.rows)} rows · ${(t.numeric || []).length} numeric</div></div></div>`).join("") : `<div class="hint">No tables yet — add one in the Data Desk (a file, a ticker or pasted numbers).</div>`}</div></div>
        <div><div class="sec-t">${multi ? "Columns" : "Column"} <span class="x" id="pk-n"></span></div><div class="pick-c" id="pk-c"><div class="hint">Choose a table.</div></div>
          <div class="fld two" style="margin-top:10px"><label>Time column</label><select class="sel sm" id="pk-d"><option value="auto">automatic</option></select></div></div></div></div>`,
      foot: `<div class="tb"><button class="btn ghost sm" id="pk-dd">${icon("data")} Open the Data Desk</button><span class="spacer"></span><button class="btn sm" id="pk-ok" disabled>Use these numbers</button></div>`,
      onClose: () => { if (!done) resolve(null); },
    });
    const sync = () => {
      s.$("#pk-ok").disabled = picked.length < min;
      s.$("#pk-n").textContent = picked.length ? picked.length + " chosen" : "";
    };
    const open = async (tid) => {
      cur = tables.find((t) => t.id === tid); picked = [];
      $$("[data-t]", s.el).forEach((x) => x.classList.toggle("on", x.dataset.t === tid));
      const nums = cur.numeric || [];
      s.$("#pk-c").innerHTML = nums.length ? nums.map((c) => `<label class="pick-col"><input type="${multi ? "checkbox" : "radio"}" name="pkc" value="${esc(c)}"><span>${esc(c)}</span></label>`).join("") : `<div class="hint">This table has no numeric columns.</div>`;
      $$("#pk-c input", s.el).forEach((i) => i.onchange = () => { picked = $$("#pk-c input", s.el).filter((x) => x.checked).map((x) => x.value); sync(); });
      if (nums.length === 1 || (!multi && nums.length)) { const i = s.$("#pk-c input"); i.checked = true; picked = [i.value]; }
      try { dates = (await api.get(`/tables/${tid}/dates`)).date_columns; } catch (e) { dates = []; }
      s.$("#pk-d").innerHTML = `<option value="auto">automatic${dates.length ? " (" + esc(dates[0]) + ")" : " (row order)"}</option><option value="">row order</option>${dates.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join("")}`;
      sync();
    };
    $$("[data-t]", s.el).forEach((x) => x.onclick = () => open(x.dataset.t));
    if (tables.length) open(tables[0].id);
    s.$("#pk-dd").onclick = () => { s.close(); go("data"); };
    s.$("#pk-ok").onclick = () => { done = true; const r = { tid: cur.id, table: cur.name, cols: picked, date_col: s.$("#pk-d").value }; s.close(); resolve(r); };
  });
}

// ---------------------------------------------------------------- "send to": the same menu wherever a result can travel
let menuEl = null;
export function menu(anchor, items) {
  closeMenu();
  const r = anchor.getBoundingClientRect();
  menuEl = document.createElement("div");
  menuEl.className = "vf-menu";
  menuEl.innerHTML = items.map((it, i) => it === "-" ? `<div class="sep"></div>` :
    `<button data-i="${i}" ${it.disabled ? "disabled" : ""}>${icon(it.icon || "bolt")}<span><b>${esc(it.label)}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ""}</span></button>`).join("");
  document.body.appendChild(menuEl);
  const mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
  menuEl.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw)) + "px";
  menuEl.style.top = (r.bottom + mh + 8 < window.innerHeight ? r.bottom + 4 : Math.max(8, r.top - mh - 4)) + "px";
  $$("[data-i]", menuEl).forEach((b) => b.onclick = (e) => { e.stopPropagation(); const it = items[+b.dataset.i]; closeMenu(); it.run(); });
  setTimeout(() => document.addEventListener("mousedown", outside, true), 0);
}
function outside(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }
function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; document.removeEventListener("mousedown", outside, true); } }

// where a numeric column can go next — used by the Data Desk tiles and every tool that produces a table
export function columnTargets(tid, cols) {
  const c = cols.join("|");
  return [
    { icon: "eye", label: "Watch for anomalies", sub: "flag the moments that break the pattern", run: () => go("data", { table: tid, tab: "watch", cols: c }) },
    { icon: "trend", label: "Project it forward", sub: "Simulate: thousands of futures from its own moves", run: () => go("simulate", { engine: "series", table: tid, col: cols[0] }) },
    { icon: "coin", label: "Odds of a total", sub: "Simulate: bootstrap the next periods, backtested", run: () => go("simulate", { engine: "history", table: tid, col: cols[0] }) },
    { icon: "reservoir", label: "Up or down next?", sub: "Reservoir Lab: a forecaster scored on unseen data", run: () => go("reservoir", { forecast: tid, col: cols[0] }) },
  ];
}

// ---------------------------------------------------------------- time-series chart with an expectation and flags
// d: { lo[], hi[], exp[] (optional), score[] (optional), step, n, labels[] (per bucket), marks: [{i, v, on}] (row index,
// value, selected), threshold }. Drag to zoom, double-click to reset. onHover(info|null), onPick(mark).
export function tsChart(canvas, d, { onHover, onPick, color = "#ff2a1a" } = {}) {
  const st = canvas._ts || (canvas._ts = { a: 0, b: d.lo.length });
  if (st.len !== d.lo.length) { st.a = 0; st.b = d.lo.length; st.len = d.lo.length; }
  const draw = (sel) => {
    const box = canvas.parentElement, dpr = window.devicePixelRatio || 1, W = box.clientWidth, H = box.clientHeight;
    if (!W || !H) return;
    canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.height = H + "px";
    const g = canvas.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const lane = d.score ? Math.max(46, H * 0.24) : 0, pl = 58, pr = 12, pt = 10, pb = 22, gap = lane ? 14 : 0;
    const top = H - pb - lane - gap, a = st.a, b = st.b;
    let lo = Infinity, hi = -Infinity;
    for (let i = a; i < b; i++) { lo = Math.min(lo, d.lo[i]); hi = Math.max(hi, d.hi[i]); if (d.exp) { lo = Math.min(lo, d.exp[i]); hi = Math.max(hi, d.exp[i]); } }
    if (!(hi > lo)) { hi = lo + 1; }
    const padv = (hi - lo) * 0.06; lo -= padv; hi += padv;
    const X = (i) => pl + (i - a + 0.5) / (b - a) * (W - pl - pr), Y = (v) => pt + (1 - (v - lo) / (hi - lo)) * (top - pt);
    g.font = "10px 'JetBrains Mono', monospace"; g.strokeStyle = "rgba(255,255,255,.06)"; g.fillStyle = "#6c6d75"; g.lineWidth = 1;
    for (let k = 0; k <= 4; k++) { const v = lo + (hi - lo) * k / 4, y = Y(v); g.beginPath(); g.moveTo(pl, y); g.lineTo(W - pr, y); g.stroke(); g.textAlign = "right"; g.fillText(niceN(v), pl - 6, y + 3); }
    g.textAlign = "center";
    for (let k = 0; k <= 5; k++) { const i = Math.min(b - 1, Math.round(a + (b - a - 1) * k / 5)); const t = d.labels ? d.labels[i] : String(i * d.step + 1); g.fillText(String(t).slice(0, 16), X(i), H - 6); }
    // value envelope
    g.beginPath();
    for (let i = a; i < b; i++) { const x = X(i); i === a ? g.moveTo(x, Y(d.hi[i])) : g.lineTo(x, Y(d.hi[i])); }
    for (let i = b - 1; i >= a; i--) g.lineTo(X(i), Y(d.lo[i]));
    g.closePath(); g.fillStyle = color + "40"; g.fill();
    g.beginPath(); for (let i = a; i < b; i++) { const x = X(i), y = Y((d.lo[i] + d.hi[i]) / 2); i === a ? g.moveTo(x, y) : g.lineTo(x, y); }
    g.strokeStyle = color; g.lineWidth = 1.3; g.stroke();
    if (d.exp) {
      const e0 = Math.max(a, Math.ceil((d.start || 0) / d.step));
      g.beginPath(); for (let i = e0; i < b; i++) { const x = X(i), y = Y(d.exp[i]); i === e0 ? g.moveTo(x, y) : g.lineTo(x, y); }
      g.strokeStyle = "rgba(63,169,245,.85)"; g.setLineDash([4, 3]); g.lineWidth = 1.1; g.stroke(); g.setLineDash([]);
    }
    // the score lane
    if (lane) {
      const y0 = top + gap, y1 = H - pb, mx = Math.max(d.threshold * 1.6, ...d.score.slice(a, b));
      g.fillStyle = "rgba(255,255,255,.025)"; g.fillRect(pl, y0, W - pl - pr, y1 - y0);
      const bw = Math.max(1, (W - pl - pr) / (b - a));
      for (let i = a; i < b; i++) { const s = d.score[i]; if (!s) continue; const hgt = Math.min(1, s / mx) * (y1 - y0); g.fillStyle = s >= d.threshold ? "#ff2a1a" : "rgba(160,162,170,.45)"; g.fillRect(X(i) - bw / 2, y1 - hgt, Math.max(1, bw - (bw > 3 ? 1 : 0)), hgt); }
      const ty = y1 - Math.min(1, d.threshold / mx) * (y1 - y0);
      g.strokeStyle = "#ffd300"; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(pl, ty); g.lineTo(W - pr, ty); g.stroke(); g.setLineDash([]);
      g.fillStyle = "#8a8b93"; g.textAlign = "right"; g.fillText("score", pl - 6, y0 + 9); g.fillStyle = "#ffd300"; g.fillText(d.threshold.toFixed(1) + "×", pl - 6, ty + 3);
    }
    // flags
    for (const m of d.marks || []) {
      const i = Math.floor(m.i / d.step); if (i < a || i >= b) continue;
      const x = X(i), y = Y(m.v);
      g.beginPath(); g.arc(x, y, m.on ? 6.5 : 4.2, 0, 7); g.fillStyle = m.on ? "#ffd300" : "#ff2a1a"; g.fill();
      g.lineWidth = 1.5; g.strokeStyle = "#09090b"; g.stroke();
      if (m.on) { g.strokeStyle = "rgba(255,211,0,.5)"; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(x, pt); g.lineTo(x, H - pb); g.stroke(); g.setLineDash([]); }
    }
    if (sel) { g.fillStyle = "rgba(255,211,0,.10)"; g.fillRect(Math.min(sel[0], sel[1]), pt, Math.abs(sel[1] - sel[0]), H - pb - pt); }
    st.geo = { X, pl, pr, W, a, b };
  };
  const idxAt = (px) => { const G = st.geo; return Math.max(G.a, Math.min(G.b - 1, Math.floor(G.a + (px - G.pl) / (G.W - G.pl - G.pr) * (G.b - G.a)))); };
  let drag = null;
  canvas.onmousedown = (e) => { const r = canvas.getBoundingClientRect(); drag = { x0: e.clientX - r.left, x1: e.clientX - r.left }; };
  canvas.onmousemove = (e) => {
    const r = canvas.getBoundingClientRect(), px = e.clientX - r.left;
    if (drag) { drag.x1 = px; draw([drag.x0, drag.x1]); return; }
    if (!st.geo || !onHover) return;
    const i = idxAt(px);
    onHover({ i, label: d.labels ? d.labels[i] : "row " + (i * d.step + 1), lo: d.lo[i], hi: d.hi[i], exp: d.exp ? d.exp[i] : null, score: d.score ? d.score[i] : null });
  };
  canvas.onmouseleave = () => { if (onHover) onHover(null); };
  canvas.onmouseup = (e) => {
    if (!drag) return;
    const r = canvas.getBoundingClientRect(), px = e.clientX - r.left, moved = Math.abs(drag.x1 - drag.x0) > 6;
    if (moved) { const i0 = idxAt(Math.min(drag.x0, drag.x1)), i1 = idxAt(Math.max(drag.x0, drag.x1)); if (i1 - i0 >= 4) { st.a = i0; st.b = i1 + 1; } }
    else if (onPick && d.marks) {
      const G = st.geo; let best = null;
      for (const m of d.marks) { const i = Math.floor(m.i / d.step); if (i < G.a || i >= G.b) continue; const dx = Math.abs(G.X(i) - px); if (dx < 10 && (!best || dx < best.dx)) best = { m, dx }; }
      if (best) onPick(best.m);
    }
    drag = null; draw();
  };
  canvas.ondblclick = () => { st.a = 0; st.b = d.lo.length; draw(); };
  canvas.focusOn = (row, span = 120) => { const i = Math.floor(row / d.step), half = Math.max(6, Math.round(span / d.step / 2)); st.a = Math.max(0, i - half); st.b = Math.min(d.lo.length, i + half); draw(); };
  draw();
  return canvas;
}
const niceN = (v) => { const a = Math.abs(v); return a >= 1e6 ? (v / 1e6).toFixed(1) + "M" : a >= 1e4 ? (v / 1e3).toFixed(0) + "k" : a >= 100 ? v.toFixed(0) : a >= 1 ? v.toFixed(2) : v.toPrecision(2); };

// ---------------------------------------------------------------- the problems VectorFall solves, and where
export const PROBLEMS = [
  { icon: "eye", q: "Something odd in my numbers?", a: "Anomaly watch flags the moments that break the pattern", go: ["data", { tab: "watch" }],
    sample: { kind: "shop", go: (id) => ["data", { table: id, tab: "watch" }], says: "a year of shop sales with four real incidents" } },
  { icon: "reservoir", q: "Teach it to recognise sounds or pictures", a: "Reservoir Lab: a few examples per class, then test live", go: ["reservoir", {}] },
  { icon: "sound", q: "Find every time a sound happens", a: "Sound Lab: mark one or two, find the rest with timestamps", go: ["sound", { panel: "find" }],
    sample: { kind: "knocks", go: (id) => ["sound", { clip: id, panel: "find" }], says: "a minute of room tone with six knocks" } },
  { icon: "photo", q: "Find a photo, or the duplicates", a: "Photo Lab: search by words or by example, group near-copies", go: ["photo", { panel: "search" }] },
  { icon: "text", q: "Where did this text come from?", a: "Text Engine: every phrase traced to the document it came from", go: ["text", { tab: "sources" }] },
  { icon: "gantt", q: "Build a roster, a route or fair teams", a: "Planner: rules in, schedule out, checked against a greedy plan", go: ["plan", {}] },
  { icon: "coin", q: "What are the odds we go over budget?", a: "Simulate: estimates or history in, odds out", go: ["simulate", { engine: "budget" }] },
  { icon: "orbit", q: "Who grows, merges or fades — and do the rules hold?", a: "Particle Lab: a population as an N-body system, checked against history", go: ["particles", {}] },
  { icon: "trend", q: "Will it be up or down next period?", a: "Reservoir Lab forecaster, scored on data it never saw", go: ["reservoir", {}],
    sample: { kind: "shop", go: (id) => ["reservoir", { forecast: id, col: "sales" }], says: "a year of shop sales" } },
];

// ---------------------------------------------------------------- models: the registry from the browser (the same /v1 the CLI and API use)
// callModel(name, params, {onStep, background}) -> {model, result, timing, blob?} ; blob = {url, type, meta} for images/audio/files
const MODEL_CACHE = {};
export async function describeModel(name) {
  if (!MODEL_CACHE[name]) { const r = await fetch("/v1/models/" + encodeURIComponent(name)); const j = await r.json(); if (!r.ok) throw new Error((j.error || {}).message || r.statusText); MODEL_CACHE[name] = j; }
  return MODEL_CACHE[name];
}
async function v1err(r) { try { const j = await r.json(); return new Error((j.error || {}).message || j.detail || r.statusText); } catch (e) { return new Error(r.status + " " + r.statusText); } }
function b64blob(b) { const bin = atob(b.base64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type: b.media_type }); }
export async function callModel(name, params = {}, { onStep, background } = {}) {
  const m = await describeModel(name);
  const body = JSON.stringify(params);
  if (m.long || background) {
    const r = await fetch(`/v1/models/${encodeURIComponent(name)}?async=1`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    if (!r.ok) throw await v1err(r);
    let j = (await r.json()).job;
    while (j.state === "running") {
      if (onStep) onStep(j);
      await new Promise((ok) => setTimeout(ok, 600));
      const q = await fetch("/v1/jobs/" + j.id); j = await q.json();
    }
    if (onStep) onStep(j);
    if (j.state === "error") throw new Error(j.error || "the job failed");
    const env = j.result;
    if (env && env.result && env.result.base64 && env.result.media_type) { const bl = b64blob(env.result); env.blob = { url: URL.createObjectURL(bl), type: env.result.media_type, meta: env.result.meta, size: bl.size, name: env.result.filename }; }
    return env;
  }
  const r = await fetch("/v1/models/" + encodeURIComponent(name), { method: "POST", headers: { "Content-Type": "application/json", Accept: "*/*" }, body });
  if (!r.ok) throw await v1err(r);
  const ct = r.headers.get("Content-Type") || "";
  if (ct.startsWith("application/json")) return r.json();
  const bl = await r.blob();
  let meta = {}, timing = {};
  try { meta = JSON.parse(r.headers.get("X-VF-Meta") || "{}"); timing = JSON.parse(r.headers.get("X-VF-Timing") || "{}"); } catch (e) { /* headers optional */ }
  const cd = r.headers.get("Content-Disposition") || "", fn = (cd.match(/filename="([^"]+)"/) || [])[1];
  return { model: name, result: null, timing, blob: { url: URL.createObjectURL(bl), type: ct.split(";")[0], meta, size: bl.size, name: fn } };
}

// a model's fields -> the house form controls (.fld rows, sliders, toggles, selects); readModelForm() reads them back
const REF_LIST = { table: ["/tables", (t) => t.name], photo: ["/photos", (p) => p.name], sound: ["/sounds", (s) => s.name], corpus: ["/text/corpora", (c) => c.name], project: ["/reservoir/projects", (p) => `${p.name} (${p.kind})`] };
const niceStep = (span) => Math.pow(10, Math.floor(Math.log10(span / 200)));   // a power of ten, so round defaults sit exactly on a step
export function modelForm(fields, pre = "mf") {
  return fields.map((f) => {
    const id = `${pre}-${f.k}`, lab = `<label for="${id}" title="${esc(f.help || f.k)}">${esc(f.label || f.k)}${f.required ? " *" : ""}</label>`, d = f.default;
    const data = `data-k="${esc(f.k)}" data-t="${f.type}"`;
    if (f.type === "bool") return `<div class="fld bool">${lab}<label class="toggle"><input type="checkbox" id="${id}" ${data} ${d ? "checked" : ""} ${d == null ? 'data-unset="1"' : ""}><i></i></label></div>`;
    if (f.type === "choice") return `<div class="fld two">${lab}<select class="sel sm" id="${id}" ${data}>${d == null ? `<option value="">—</option>` : ""}${f.choices.map((c) => `<option ${c === d ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div>`;
    if (f.type in REF_LIST) return `<div class="fld two">${lab}<select class="sel sm mf-ref" id="${id}" ${data} data-ref="${f.type}"><option value="">${f.required ? "choose…" : "—"}</option></select></div>`;
    if (f.type === "text" || f.type === "json") return `<div class="fld stackd">${lab}<textarea class="in mono" id="${id}" ${data} rows="${f.type === "json" ? 4 : 6}" spellcheck="false" wrap="off">${esc(d == null ? "" : f.type === "json" ? JSON.stringify(d) : d)}</textarea></div>`;
    if (f.type === "file") return `<div class="fld two">${lab}<input type="file" class="in sm" id="${id}" ${data} ${f.accept ? `accept="${esc(f.accept)}"` : ""}></div>`;
    const num = f.type === "int" || f.type === "float" || f.type === "money";
    if (num && f.min != null && f.max != null && f.max - f.min <= 1e7 && f.max > f.min && d != null)
      return `<div class="fld">${lab}<input type="range" id="${id}" ${data} min="${f.min}" max="${f.max}" step="${f.type === "int" ? 1 : niceStep(f.max - f.min)}" value="${d}"><input class="in sm mf-num" data-for="${id}" value="${d}"></div>`;
    if (num) return `<div class="fld two">${lab}<input class="in sm" type="number" id="${id}" ${data} ${f.min != null ? `min="${f.min}"` : ""} ${f.max != null ? `max="${f.max}"` : ""} step="any" value="${d == null ? "" : d}" placeholder="${d == null ? "default" : ""}"></div>`;
    const ph = f.type === "strs" || f.type === "list" ? "comma-separated" : "";
    return `<div class="fld two">${lab}<input class="in sm" id="${id}" ${data} value="${esc(d == null ? "" : Array.isArray(d) ? d.join(", ") : d)}" placeholder="${ph}"></div>`;
  }).join("");
}
export async function wireModelForm(root, fields) {
  $$("input[type=checkbox][data-unset]", root).forEach((c) => c.addEventListener("change", () => { c.dataset.touched = "1"; }));
  $$("input[type=range][data-k]", root).forEach((r) => { const n = $(`[data-for="${r.id}"]`, root); r.addEventListener("input", () => { n.value = r.value; }); n.addEventListener("change", () => { r.value = n.value; }); });
  for (const sel of $$(".mf-ref", root)) {
    const [path, nm] = REF_LIST[sel.dataset.ref];
    try { const items = await api.get(path); sel.insertAdjacentHTML("beforeend", items.map((x) => `<option value="${esc(x.id)}">${esc(nm(x))}</option>`).join("")); if (sel.options.length === 2 && fields.find((f) => f.k === sel.dataset.k).required) sel.selectedIndex = 1; } catch (e) { /* list unavailable */ }
  }
}
export async function readModelForm(root, fields) {
  const out = {};
  for (const f of fields) {
    const el = $(`[data-k="${CSS.escape(f.k)}"]`, root);
    if (!el) continue;
    if (f.type === "bool") { if (!(el.dataset.unset && !el.dataset.touched && !el.checked)) out[f.k] = el.checked; continue; }
    if (f.type === "file") { if (el.files && el.files[0]) { const buf = new Uint8Array(await el.files[0].arrayBuffer()); let s = ""; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode.apply(null, buf.subarray(i, i + 32768)); out[f.k] = btoa(s); const fn = fields.find((x) => x.k === "filename"); if (fn && !out.filename) out.filename = el.files[0].name; } continue; }
    let v = el.value;
    if (v === "" || v == null) continue;
    if (f.type === "int") v = Math.round(+v); else if (f.type === "float" || f.type === "money") v = +v;
    else if (f.type === "json") { try { v = JSON.parse(v); } catch (e) { throw new Error(`${f.label || f.k}: not valid JSON`); } }
    else if (f.type === "strs") v = v.split(",").map((x) => x.trim()).filter(Boolean);
    else if (f.type === "list") v = v.split(/[,;\s]+/).filter(Boolean).map(Number);
    if (f.default != null && JSON.stringify(v) === JSON.stringify(f.default)) continue;      // defaults stay implicit (shorter CLI lines)
    out[f.k] = v;
  }
  return out;
}
