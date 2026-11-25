import { $, $$, api, empty, esc, fail, fmt, icon, pane, toast } from "./core.js";
import * as ch from "./charts.js";
import { pickColumns } from "./hub.js";
import { mountDiagram, parseMachine } from "./statediagram.js";
import { callMenu } from "./callcopy.js";

// Simulate: engines on the left (list + parameters + pinned Run), results on the right (verdict strip, main chart
// filling the pane, matrix / second chart beneath). Opening an engine runs it, so the stage is never empty.
// The State machine engine also draws the chain itself beneath the projection, live from the text as it is typed,
// with lint beside it; after a run the diagram and the mix show the paths at the step chosen on its slider.
let data = null, cur = null, last = null, seq = 0;
const SM = { view: null, step: -1, sig: "", ranSig: null, raf: 0 };   // the State machine's diagram and step
const ICON = { series: "trend", states: "states", finance: "coin", solve: "walk", retirement: "piggy", project: "gantt", budget: "coin", history: "trend", queue: "states" };
const ENGINE_OF = { "sim.budget": "budget", "forecast.project": "project", "forecast.queue": "queue", "sim.history": "history", "forecast.retirement": "retirement" };
let templates = [];
let pending = null;                                      // a deep link: { engine, table, col }

export default {
  id: "simulate", title: "Simulate", sub: "Monte Carlo on the card", icon: "forecast",
  mount(el) {
    el.innerHTML = `<div class="ws side-l sim">
      <div class="col">
        ${pane({ t: "Engines", cls: "fit", bcls: "flush", bid: "sm-list" })}
        <section class="pane grow"><div class="pane-h"><div class="t" id="sm-ptitle">Parameters</div><div class="tools"><button class="btn ghost xs" id="sm-as" title="This run as Console code, an MCP call for an agent, curl or a vf command">${icon("console")} Copy as…</button><button class="iconbtn" id="sm-reset" title="Defaults">${icon("undo")}</button></div></div>
          <div class="pane-b"><div class="fields" id="sm-params"></div></div>
          <div class="pane-act"><button class="btn block" id="sm-go">${icon("spark")} Run Monte Carlo</button><div class="hint" id="sm-time">&nbsp;</div></div></section>
      </div>
      <div class="col" id="sm-out">
        <section class="pane fit sm-verdict" id="sm-verdict"><div class="hl" id="sm-hl">—</div><div class="txt"><div class="nm" id="sm-name"></div><p id="sm-sent">Choose an engine on the left.</p></div><div class="facts" id="sm-facts"></div></section>
        ${pane({ id: "sm-main", t: "Projection", meta: "", cls: "grow", bcls: "", body: `<div class="chartbox"><canvas id="sm-c1"></canvas></div>`, foot: "&nbsp;" })}
        <div class="cols2 sm-lower" id="sm-lower" style="display:none"></div>
      </div>
    </div>`;
    $("#sm-go").onclick = run;
    $("#sm-reset").onclick = () => open(cur);
    $("#sm-as").onclick = (e) => { if (cur) callMenu(e.currentTarget, modelOf(cur), readParams(), false); };
    window.addEventListener("resize", () => { if (last && document.querySelector("#view-simulate.on")) draw(last); });
    // State machine: pointing along the projection picks the step the diagram shows
    $("#sm-c1").addEventListener("mousemove", (e) => {
      if (cur !== "states" || !smRun()) return;
      const b = e.currentTarget.getBoundingClientRect(), n = smRun().chart.x.length;
      const t = Math.round((e.clientX - b.left - 52) / Math.max(1, b.width - 66) * (n - 1));
      if (t >= 0 && t <= n - 1 && t !== SM.step) setStep(t);
    });
    load();
  },
  show(p = {}) {
    if (p.engine) { pending = p; if (data) applyLink(); return; }
    if (last) requestAnimationFrame(() => draw(last));
  },
};
// another app sent a table column here: open the engine, fill its numbers from the Data Desk, run
async function applyLink() {
  const p = pending; pending = null;
  if (!spec(p.engine)) return;
  if (p.model === "session") {                           // the Planner (or another tool) handed over a walk-solver model
    let m = ""; try { m = sessionStorage.getItem("vf-solve-model") || ""; } catch (e) { /* */ }
    open(p.engine, false);
    const ta = $("#sp-model"); if (ta && m) ta.value = m;
    run(); return;
  }
  open(p.engine, !p.table);
  if (p.table) await fillFrom(p.engine, { tid: p.table, cols: p.col ? [p.col] : [], date_col: "auto" });
  let set = 0;                                             // other fields given by the link (e.g. horizon=10&delta=log)
  spec(p.engine).fields.forEach((f) => { if (f.k in p && !f.src) { const el = $("#sp-" + f.k); if (el) { if (el.type === "checkbox") el.checked = p[f.k] === "1" || p[f.k] === "true"; else el.value = p[f.k]; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); set++; } } });
  if (p.table && (set || p.run)) run();
}

async function load() {
  try { data = await api.get("/simulate"); } catch (e) { $("#sm-list").innerHTML = empty(esc(e.message)); return; }
  const row = (s) => `<div class="li" data-s="${s.id}"><div class="ic">${icon(ICON[s.id] || "forecast")}</div><div class="tx"><div class="nm">${esc(s.name)}</div><div class="sub" title="${esc(s.blurb)}">${esc(s.blurb)}</div></div></div>`;
  const yours = data.engines.filter((s) => s.group === "yours"), general = data.engines.filter((s) => s.group !== "yours");
  $("#sm-list").innerHTML = `<div class="grp">Your numbers</div><div class="list">${yours.map(row).join("")}</div>
    <div class="grp">General engines</div><div class="list">${general.map(row).join("")}</div>
    <div class="grp">Planning presets</div><div class="list">${data.planning.map(row).join("")}</div>
    <div class="grp">Start from a template</div><div class="list" id="sm-tpls"></div>`;
  $$("#sm-list [data-s]").forEach((b) => b.onclick = () => open(b.dataset.s));
  fetch("/v1/models/problem.templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app: "simulate" }) })
    .then((r) => r.json()).then((j) => {
      templates = (j.result || {}).templates || [];
      $("#sm-tpls").innerHTML = templates.filter((t) => spec(ENGINE_OF[t.model])).map((t) => `<div class="li" data-tpl="${esc(t.id)}"><div class="ic">${icon(ICON[ENGINE_OF[t.model]] || "forecast")}</div><div class="tx"><div class="nm">${esc(t.title)}</div><div class="sub" title="${esc(t.problem)}">${esc(t.problem)}</div></div></div>`).join("");
      $$("#sm-tpls [data-tpl]").forEach((b) => b.onclick = () => loadTemplate(b.dataset.tpl));
    }).catch(() => { /* an older server: no templates */ });
  if (pending) applyLink(); else open(cur || (yours[0] || data.engines[0]).id);
}
const spec = (id) => data.engines.find((x) => x.id === id) || data.planning.find((x) => x.id === id);

function open(id, autorun = true) {
  cur = id;
  const s = spec(id);
  $$("#sm-list [data-s]").forEach((b) => b.classList.toggle("on", b.dataset.s === id));
  $("#sm-ptitle").textContent = s.name;
  $("#sm-params").innerHTML = `<div class="hint" style="margin-bottom:2px">${esc(s.blurb)}</div>` + s.fields.map(field).join("");
  const pf = s.fields.find((f) => f.k === "preset" && f.models);
  if (pf) {                                              // the walk solver: picking a problem loads its model text
    const sel = $("#sp-preset"), ta = $("#sp-model");
    if (sel && ta) { ta.value = pf.models[sel.value] || ta.value; sel.onchange = () => { ta.value = pf.models[sel.value] || ""; run(); }; }
  }
  $$("#sm-params input[type=range]").forEach((i) => { i.oninput = () => { const v = $("#v-" + i.dataset.k); if (v) v.textContent = i.dataset.money ? fmt.money(+i.value) : (i.dataset.t === "int" ? i.value : (+i.value).toFixed(3).replace(/\.?0+$/, "")); }; i.oninput(); });
  $("#sm-out").classList.toggle("is-states", id === "states");
  if (id === "states") {
    SM.ranSig = null; SM.step = -1; last = null;
    statesLower();
    ["states", "transitions", "start", "steps"].forEach((k) => { const f = $("#sp-" + k); if (f) f.addEventListener("input", smChanged); });
  }
  $$("#sm-params [data-src]").forEach((b) => b.onclick = async () => { const pick = await pickColumns(b.dataset.src === "rows"
    ? { title: "Items from a Data Desk table", multi: true, min: 0, hint: "Tick the low, likely and high columns (and a chance column for risks) in that order — or tick none, and Simulate finds them by their names. The first text column names the items." }
    : { title: "Numbers from a Data Desk table", hint: "One column, read in time order (by its date column when there is one)." }); if (pick) fillFrom(cur, pick); });
  if (autorun) run();
}
// fill a source field from a Data Desk table, then run
async function fillFrom(id, pick) {
  const f = spec(id).fields.find((x) => x.src), ta = f && $("#sp-" + f.k); if (!ta) return;
  try {
    if (f.src === "column") {
      let col = pick.cols[0];
      if (!col) { const t = (await api.get("/tables")).find((x) => x.id === pick.tid); col = t && t.numeric[0]; }
      const r = await api.get(`/tables/${pick.tid}/series?${new URLSearchParams({ cols: col, date_col: pick.date_col ?? "auto" })}`);
      ta.value = r.values[0].map((v) => +v.toPrecision(10)).join("\n");
      let how = "";
      const kind = $("#sp-kind"), v = r.values[0];
      if (kind && v.length > 8) {                          // a price or balance wanders slowly; an amount per period jumps around
        const sd = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
        const lvl = sd(v.slice(1).map((x, i) => x - v[i])) < 0.25 * sd(v);
        kind.value = [...kind.options].find((o) => o.value.startsWith(lvl ? "a level" : "an amount")).value;
        how = ` · read as ${lvl ? "a level" : "amounts per period"} (change below if wrong)`;
        const th = $("#sp-threshold"), hz = $("#sp-horizon");
        if (th) {                                          // a threshold that means something for these numbers
          const h = hz ? +hz.value : 6;
          th.value = +(lvl ? v[v.length - 1] : v.slice(-h).reduce((a, b) => a + b, 0)).toPrecision(6);
          how += ` · threshold = ${lvl ? "the latest value" : "the last " + h + " periods' total"}`;
        }
      }
      note(f.k, `from <b>${esc(r.table)}</b> · ${esc(col)} · ${fmt.n(v.length)} values${r.date_col ? " by " + esc(r.date_col) : ""}${how}`);
    } else {
      const rows = await api.get(`/tables/${pick.tid}/rows?limit=1000`), cols = rows.columns, tmeta = (await api.get("/tables")).find((x) => x.id === pick.tid);
      const num = tmeta.numeric, txt = cols.filter((c) => !num.includes(c));
      const find = (rx) => num.find((c) => rx.test(c));
      let use = pick.cols.length >= 3 ? pick.cols : [find(/low|min|best|optim/i), find(/likely|mode|expect|most|base|estimate/i), find(/high|max|worst|pessim/i), find(/chance|prob|risk|%/i)];
      if (!use[0] || !use[1] || !use[2]) use = num.slice(0, 3);
      if (use.filter(Boolean).length < 3) throw new Error("that table needs three numeric columns: low, likely, high");
      const ix = (c) => cols.indexOf(c), name = txt[0];
      ta.value = rows.rows.map((r, k) => [name ? String(r[ix(name)] ?? "").replace(/[,;\t]/g, " ") : "item " + (k + 1), ...use.filter(Boolean).map((c) => r[ix(c)])].join(", ")).join("\n");
      note(f.k, `from <b>${esc(tmeta.name)}</b> · ${use.filter(Boolean).map(esc).join(" / ")}`);
    }
    run();
  } catch (e) { fail(e); }
}
function note(k, html) { const n = $("#sn-" + k); if (n) n.innerHTML = html; }
function field(p) {
  const id = `sp-${p.k}`;
  if (p.type === "text" && p.src) return `<div class="fld stackd"><div class="sm-srch"><label for="${id}">${esc(p.label)}</label><button class="btn ghost xs" data-src="${p.src}" title="Fill from a Data Desk table">${icon("data")} Data Desk…</button></div><textarea class="in mono" id="${id}" data-k="${p.k}" rows="9" spellcheck="false" wrap="off">${esc(Array.isArray(p.default) ? p.default.join("\n") : p.default)}</textarea><div class="hint" id="sn-${p.k}">or paste your own</div></div>`;
  if (p.type === "text") return `<div class="fld stackd"><label for="${id}">${esc(p.label)}</label><textarea class="in mono ${p.k === "model" ? "sm-model" : ""}" id="${id}" data-k="${p.k}" rows="${p.k === "model" ? 16 : 7}" spellcheck="false" wrap="off">${esc(Array.isArray(p.default) ? p.default.join("\n") : p.default)}</textarea></div>`;
  if (p.type === "bool") return `<div class="fld bool"><label>${esc(p.label)}</label><label class="toggle"><input type="checkbox" id="${id}" data-k="${p.k}" ${p.default ? "checked" : ""}><i></i></label></div>`;
  if (p.type === "choice") return `<div class="fld two"><label for="${id}">${esc(p.label)}</label><select class="sel sm" id="${id}" data-k="${p.k}">${p.choices.map((c) => `<option ${c === p.default ? "selected" : ""}>${c}</option>`).join("")}</select></div>`;
  if (p.type === "money") return `<div class="fld"><label for="${id}">${esc(p.label)}</label><input type="range" id="${id}" data-k="${p.k}" data-money="1" min="${p.min || 0}" max="${p.max || 2000000}" step="${(p.max || 2000000) / 400}" value="${p.default}"><span class="v" id="v-${p.k}"></span></div>`;
  if (p.type === "int" || p.type === "float") return `<div class="fld"><label for="${id}">${esc(p.label)}</label><input type="range" id="${id}" data-k="${p.k}" data-t="${p.type}" min="${p.min}" max="${p.max}" step="${p.type === "int" ? 1 : (p.max - p.min) / 200}" value="${p.default}"><span class="v" id="v-${p.k}"></span></div>`;
  return `<div class="fld two"><label for="${id}">${esc(p.label)}</label><input class="in sm" id="${id}" data-k="${p.k}" value="${esc(p.default)}"></div>`;
}

const modelOf = (id) => Object.keys(ENGINE_OF).find((m) => ENGINE_OF[m] === id) || (data.planning.some((x) => x.id === id) ? "forecast." + id : "sim." + id);
function readParams() {
  const params = {};
  $$("#sm-params [data-k]").forEach((i) => {
    if (i.type === "checkbox") params[i.dataset.k] = i.checked;
    else if (i.tagName === "TEXTAREA") params[i.dataset.k] = i.value;
    else if (i.type === "range") params[i.dataset.k] = i.dataset.t === "int" || i.dataset.money ? Math.round(+i.value) : +i.value;
    else params[i.dataset.k] = i.value;
  });
  return params;
}
// a template opens its engine and fills its fields with the template's text and numbers, then runs
async function loadTemplate(id) {
  let t;
  try { t = (await (await fetch("/v1/models/problem.template", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) })).json()).result; } catch (e) { fail(e); return; }
  const eid = t && ENGINE_OF[t.model]; if (!eid || !spec(eid)) return;
  open(eid, false);
  for (const [k, v] of Object.entries(t.params || {})) {
    const el = $("#sp-" + k); if (!el || v == null) continue;
    if (el.type === "checkbox") el.checked = !!v;
    else { if (el.type === "range") { el.max = Math.max(+el.max, +v); el.min = Math.min(+el.min, +v); el.step = "any"; } el.value = v; el.dispatchEvent(new Event("input")); }
  }
  $$("#sm-tpls [data-tpl]").forEach((b) => b.classList.toggle("on", b.dataset.tpl === id));
  const h = $("#sm-params .hint"); if (h) h.innerHTML = `<b>${esc(t.title)}:</b> ${esc(t.maps)}`;
  toast(`Loaded “${t.title}”: change the numbers to yours`, "good", 2200);
  run();
}

async function run() {
  const params = readParams();
  const my = ++seq, btn = $("#sm-go"), sig = cur === "states" ? smSig() : null;
  btn.disabled = true; $("#sm-time").textContent = "simulating on the card…";
  $("#sm-out").classList.add("is-busy");
  try {
    const r = await api.post("/simulate/" + cur, { params });
    if (my !== seq) return;
    $("#sm-time").innerHTML = `${fmt.big(r.paths)} paths · <span class="timing">${fmt.ms(r.ms)}</span>`;
    if (sig != null) { SM.ranSig = sig; SM.step = -1; }
    last = r; render(r);
  } catch (e) {
    if (my !== seq) return;
    console.error(e);
    $("#sm-hl").className = "hl bad"; $("#sm-hl").textContent = "—";
    $("#sm-sent").textContent = e.message; $("#sm-time").textContent = "";
  } finally { if (my === seq) { btn.disabled = false; $("#sm-out").classList.remove("is-busy"); } }
}

function render(r) {
  const s = spec(cur);
  $("#sm-hl").className = "hl " + (r.tone || "");
  $("#sm-hl").textContent = r.headline;
  $("#sm-name").textContent = s.name;
  $("#sm-sent").textContent = r.sentence;
  $("#sm-facts").innerHTML = (r.facts || []).slice(0, 6).map((f) => `<div><b>${esc(String(f[1]))}</b><span>${esc(f[0])}</span></div>`).join("");
  const meta = $("#sm-main .meta"); if (meta) meta.textContent = (r.chart && r.chart.title) || "";
  const mt = $("#sm-main .t"); if (mt) mt.textContent = cur === "solve" ? "Convergence" : "Projection";
  const foot = $("#sm-main-f"); if (foot) foot.innerHTML = `<span><b>${fmt.big(r.paths)}</b> paths</span><span>${esc(s.name)}</span><span class="timing">${fmt.ms(r.ms)}</span>`;
  if (cur === "states") { statesLower(); requestAnimationFrame(() => draw(r)); return; }
  const lower = [];
  if (r.solution && cur === "solve") lower.push(pane({ t: "Solution", meta: solutionKind(r).label, body: `<div class="chartbox"><canvas id="sm-sol"></canvas></div>` }));
  if (r.transition) lower.push(pane({ t: "Transition matrix", meta: "learned from your series — row = this step, column = next", bid: "sm-trans" }));
  if (r.chart2) lower.push(pane({ t: esc(r.chart2.title || "Distribution"), body: `<div class="chartbox"><canvas id="sm-c2"></canvas></div>` }));
  $("#sm-lower").innerHTML = lower.join("");
  $("#sm-lower").style.display = lower.length ? "" : "none";
  $("#sm-lower").style.gridTemplateColumns = lower.length === 1 ? "minmax(0,1fr)" : "";
  requestAnimationFrame(() => draw(r));
}
function draw(r) {
  if (cur === "states") { smDraw(); return; }
  const c1 = $("#sm-c1"); if (c1) plot(c1, r.chart, r.history);
  const c2 = $("#sm-c2"); if (c2 && r.chart2) plot(c2, r.chart2);
  if (r.transition && $("#sm-trans")) matrix($("#sm-trans"), r.transition);
  const sc = $("#sm-sol"); if (sc && r.solution) drawSolution(sc, r);
}

// ---- State machine: the diagram (live from the text), its lint, and the step it shows after a run
const smField = (k) => { const f = $("#sp-" + k); return f ? f.value : ""; };
const smSig = () => JSON.stringify(["states", "transitions", "start", "steps"].map(smField));
const smRun = () => (cur === "states" && last && last.labels && last.chart && last.chart.series ? last : null);
function statesLower() {
  const low = $("#sm-lower");
  if (!$("#sm-sd .sd")) {
    low.innerHTML = pane({ id: "sm-sdp", t: "Diagram", meta: "drawn from the text as you type", bid: "sm-sd", bcls: "flush",
      foot: `<span class="sm-stepl" id="sm-stepl">edit the states and transitions on the left — the picture follows</span><input type="range" id="sm-step" min="0" max="1" value="1" hidden>` })
      + pane({ id: "sm-mixp", t: "State mix", meta: "", body: `<div class="chartbox"><canvas id="sm-c2"></canvas></div><div class="sm-mixhint" id="sm-mixh">Run to see where the paths end up.</div>` });
    SM.view = mountDiagram($("#sm-sd"), {
      onLine: selectLine,
      onField: (k) => { const f = $("#sp-" + k); if (f) { f.focus(); if (f.select && k !== "transitions") f.select(); } },
    });
    $("#sm-step").oninput = (e) => setStep(+e.target.value);
  }
  low.style.display = ""; low.style.gridTemplateColumns = "";
  smChanged(true);
}
function smChanged(now) {
  if (!SM.view) return;
  const go = () => { SM.raf = 0; SM.view.update(parseMachine({ states: smField("states"), transitions: smField("transitions"), start: smField("start") })); smOcc(); };
  if (now === true) go(); else if (!SM.raf) SM.raf = requestAnimationFrame(go);
}
function smShares(r, t) {
  const n = r.chart.x.length;
  return t >= n ? r.chart2.y.slice() : r.chart.series.map((s) => s.y[t]);
}
function smOcc() {
  const r = smRun(), m = SM.view && SM.view.model, sl = $("#sm-step"), lab = $("#sm-stepl");
  if (!SM.view) return;
  if (!r) { SM.view.setOccupancy(null); if (sl) sl.hidden = true; return; }
  const n = r.chart.x.length;
  if (SM.step < 0 || SM.step > n) SM.step = n;
  const same = m && m.ok && m.labels.length === r.labels.length && m.labels.every((l, i) => l === r.labels[i]);
  const stale = SM.ranSig !== smSig();
  SM.view.setOccupancy(same ? smShares(r, SM.step) : null, stale);
  const mm = $("#sm-mixp .meta");
  if (mm) mm.textContent = `${stale ? "last run · " : ""}share of ${fmt.big(r.paths)} paths at step ${SM.step}${SM.step >= n ? " (the end)" : ""}`;
  if (sl) { sl.hidden = false; sl.max = n; sl.value = SM.step; }
  if (lab) {
    const sh = smShares(r, SM.step), top = sh.indexOf(Math.max(...sh));
    lab.innerHTML = `step <b>${SM.step}</b> of ${n}${SM.step === 0 ? " · the start" : SM.step === n ? " · the end" : ""} · most in <b>${esc(r.labels[top])}</b> ${Math.round(sh[top] * 100)}%`;
  }
}
function setStep(t) {
  SM.step = t; smOcc();
  const r = smRun(); if (r) smDraw();
}
function smDraw() {
  const r = smRun(); if (!r) return;
  const n = r.chart.x.length, t = SM.step < 0 || SM.step > n ? n : SM.step;
  const c1 = $("#sm-c1");
  if (c1) {
    plot(c1, r.chart);
    const g = c1.getContext("2d"), w = c1.clientWidth, h = c1.clientHeight, x = 52 + Math.min(1, t / Math.max(1, n - 1)) * (w - 66);
    g.save(); g.strokeStyle = "rgba(255,255,255,.55)"; g.setLineDash([3, 4]); g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, 12); g.lineTo(x, h - 26); g.stroke(); g.setLineDash([]);
    g.fillStyle = "#fff"; g.font = "600 10.5px 'JetBrains Mono', monospace"; g.textAlign = x > w - 70 ? "right" : "left";
    g.fillText(t >= n ? `step ${t} (end)` : `step ${t}`, x + (x > w - 70 ? -6 : 6), 22); g.restore();
  }
  const c2 = $("#sm-c2"), mh = $("#sm-mixh"); if (mh) mh.hidden = true;
  if (c2) ch.hbars(c2, { labels: r.labels, y: smShares(r, t), h: c2.parentElement.clientHeight, fmt: (v) => (v * 100).toFixed(0) + "%" });
}
function selectLine(li) {
  const ta = $("#sp-transitions"); if (!ta) return;
  const rows = ta.value.split("\n");
  let a = 0; for (let i = 0; i < li && i < rows.length; i++) a += rows[i].length + 1;
  const b = a + (rows[li] || "").length;
  ta.focus(); ta.setSelectionRange(a, b);
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
  ta.scrollTop = Math.max(0, li * lh - ta.clientHeight / 3);
}

// ---- walk-solver solutions: recognise common shapes from the model text, else list the values
function modelText() { const t = $("#sp-model"); return t ? t.value : ""; }
function tables(txt) {        // NAME = [(a,b), (c,d), ...]
  const out = {}, rx = /^\s*([A-Za-z_]\w*)\s*=\s*(\[[^\n]*\])\s*$/gm; let m;
  while ((m = rx.exec(txt))) { try { const v = JSON.parse(m[2].replace(/\(/g, "[").replace(/\)/g, "]")); if (Array.isArray(v) && v.length && Array.isArray(v[0]) && v[0].length === 2) out[m[1]] = v; } catch (e) { /* not a table */ } }
  return out;
}
function solutionKind(r) {
  const txt = modelText(), T = tables(txt), vars = Object.entries(r.solution || {});
  const arr = vars.find(([, v]) => Array.isArray(v));
  if (!arr) return { kind: "values", label: "values" };
  const [name, v] = arr, n = v.length, isPerm = new RegExp("var\\s+" + name + "\\b[^\\n]*perm").test(txt);
  const pts = Object.values(T).find((t) => t.length === n && isPerm);
  if (pts) return { kind: "route", label: "the tour", name, v, pts };
  const edges = Object.values(T).find((t) => t.every((e) => e[0] < n && e[1] < n) && t.length >= n / 2);
  if (edges && !isPerm) return { kind: "graph", label: "coloured graph", name, v, edges };
  if (isPerm && /queen/i.test(txt)) return { kind: "board", label: `${n}×${n} board`, name, v };
  const k = Math.round(Math.sqrt(n));
  if (k * k === n && n >= 4) return { kind: "grid", label: `${k}×${k} grid`, name, v, k, plus: /\+\s*1/.test(txt) ? 1 : 0 };
  return { kind: "values", label: "values" };
}
function drawSolution(cv, r) {
  const dpr = window.devicePixelRatio || 1, W = cv.parentElement.clientWidth, H = cv.parentElement.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + "px";
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const K = solutionKind(r), pad = 18, S = Math.min(W, H) - pad * 2, ox = (W - S) / 2, oy = (H - S) / 2;
  g.font = "11px 'JetBrains Mono', monospace"; g.textAlign = "center"; g.textBaseline = "middle";
  if (K.kind === "route") {
    const xs = K.pts.map((p) => p[0]), ys = K.pts.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), sp = Math.max(x1 - x0, y1 - y0) || 1;
    const X = (x) => ox + (x - x0) / sp * S, Y = (y) => oy + S - (y - y0) / sp * S;
    g.strokeStyle = "#ff2a1a"; g.lineWidth = 2; g.beginPath();
    K.v.forEach((c, i) => { const p = K.pts[c]; if (i) g.lineTo(X(p[0]), Y(p[1])); else g.moveTo(X(p[0]), Y(p[1])); });
    g.closePath(); g.stroke();
    K.pts.forEach((p, i) => { g.beginPath(); g.arc(X(p[0]), Y(p[1]), i === K.v[0] ? 6 : 4, 0, 7); g.fillStyle = i === K.v[0] ? "#ffd300" : "#e9e9ec"; g.fill(); });
  } else if (K.kind === "board") {
    const n = K.v.length, c = S / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { g.fillStyle = (i + j) % 2 ? "#1a1a1f" : "#26262c"; g.fillRect(ox + i * c, oy + j * c, c, c); }
    K.v.forEach((row, col) => { g.beginPath(); g.arc(ox + col * c + c / 2, oy + row * c + c / 2, Math.max(2, c * 0.34), 0, 7); g.fillStyle = "#ff2a1a"; g.fill(); });
  } else if (K.kind === "grid") {
    const k = K.k, c = S / k; g.font = `600 ${Math.max(10, Math.min(28, c * 0.36))}px 'JetBrains Mono', monospace`;
    K.v.forEach((val, i) => { const x = ox + (i % k) * c, y = oy + Math.floor(i / k) * c;
      g.fillStyle = "#16161b"; g.fillRect(x + 2, y + 2, c - 4, c - 4); g.strokeStyle = "rgba(255,42,26,.5)"; g.strokeRect(x + 2, y + 2, c - 4, c - 4);
      g.fillStyle = "#fff"; g.fillText(String(val + K.plus), x + c / 2, y + c / 2); });
  } else if (K.kind === "graph") {
    const n = K.v.length, R = S / 2 - 8, cx = W / 2, cy = H / 2, P = K.v.map((_, i) => [cx + R * Math.cos(i / n * 6.283), cy + R * Math.sin(i / n * 6.283)]);
    g.strokeStyle = "rgba(255,255,255,.12)"; g.lineWidth = 1;
    K.edges.forEach(([a, b]) => { g.beginPath(); g.moveTo(...P[a]); g.lineTo(...P[b]); g.strokeStyle = K.v[a] === K.v[b] ? "#ff2a1a" : "rgba(255,255,255,.12)"; g.stroke(); });
    const cols = ["#ff2a1a", "#3fa9f5", "#ffd300", "#2fd38a", "#c084fc", "#ff8a3d", "#5eead4", "#f472b6"];
    P.forEach((p, i) => { g.beginPath(); g.arc(p[0], p[1], 6, 0, 7); g.fillStyle = cols[K.v[i] % cols.length]; g.fill(); });
  } else {
    g.textAlign = "left"; g.textBaseline = "top"; g.fillStyle = "#e8e8ea"; let y = 10;
    for (const [k, v] of Object.entries(r.solution)) { const t = `${k} = ${Array.isArray(v) ? "[" + v.join(", ") + "]" : v}`; for (let i = 0; i < t.length && y < H - 14; i += Math.floor((W - 20) / 7)) { g.fillText(t.slice(i, i + Math.floor((W - 20) / 7)), 10, y); y += 16; } }
  }
}
function plot(cv, c, history) {
  if (!c) return;
  const h = cv.parentElement.clientHeight;
  if (c.type === "fan") {
    if (history) ch.fanHistory(cv, { hx: history.x, hy: history.y, px: c.x, bands: c.bands, h, unit: c.unit });
    else ch.fan(cv, { x: c.x, bands: c.bands, h, unit: c.unit });
  } else if (c.type === "hist") ch.hist(cv, { edges: c.edges, y: c.y, h, marker: c.marker, unit: c.unit, mlabel: c.marker_label });
  else if (c.type === "bars") ch.bars(cv, { x: c.x, y: c.y, h });
  else if (c.type === "hbars") ch.hbars(cv, { labels: c.labels, y: c.y, h, fmt: (v) => (v * 100).toFixed(0) + "%" });
  else if (c.type === "lines") ch.line(cv, { x: c.x, h, area: false, yfmt: (v) => c.unit === "%" ? Math.round(v * 100) + "%" : fmt.big(v), series: c.series.map((s, i) => ({ y: s.y, color: ch.PALETTE[i % ch.PALETTE.length] })) });
}
function matrix(el, t) {
  const lab = (i) => `${t.edges[i] === "-inf" ? "≤" : t.edges[i]} … ${t.edges[i + 1] === "inf" ? "+" : t.edges[i + 1]}`;
  el.innerHTML = `<table class="tbl heat sm-heat"><thead><tr><th>from \\ to</th>${t.matrix.map((_, j) => `<th class="r">b${j}</th>`).join("")}<th class="r">seen</th></tr></thead><tbody>
    ${t.matrix.map((row, i) => `<tr><td class="mono" title="${esc(lab(i))}">b${i} <span class="dim">${esc(lab(i))}</span></td>${row.map((p) => { const a = Math.min(1, p * 2); return `<td style="background:rgba(212,0,0,${a.toFixed(2)});color:${a > 0.4 ? "#fff" : "#55565e"}">${p > 0.005 ? Math.round(p * 100) : ""}</td>`; }).join("")}<td class="dim mono r">${t.counts[i]}</td></tr>`).join("")}
  </tbody></table>`;
}
