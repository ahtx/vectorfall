import { $, $$, api, esc, fail, fmt, go, icon, pane, toast, watchJob } from "./core.js";
import * as ch from "./charts.js";
import { pickColumns } from "./hub.js";
import { guideView, helpDot, onHelp } from "./guide.js";
import { LESSONS, REF } from "./plan-guide.js";
import { ROLES, REFKEY, NONE, check, outgoing } from "./plan-check.js";
import { callMenu } from "./callcopy.js";

// Planner: real scheduling problems from plain tables. Left: the problem and its rules. Middle: the Guide (lessons from a
// tiny example to your own data, and a reference of every column and number), the inputs (CSV you can paste, edit or pull
// from the Data Desk, checked live and mapped to our columns) and the walk-solver model they compile to. Right: the answer, beside the plan
// a simple method would have produced, and buttons to keep it (Data Desk table, CSV, Google Maps).
const KINDS = [
  { id: "roster", icon: "gantt", name: "Roster", sub: "people × shifts → who works what" },
  { id: "route", icon: "walk", name: "Route", sub: "stops → the shortest order to visit them" },
  { id: "teams", icon: "states", name: "Teams", sub: "people → balanced teams, with pair rules" },
];
const INPUTS = {
  roster: [["people", "People", "name, max_shifts, min_shifts, skills (a;b), unavailable (days or shifts), prefers"], ["shifts", "Shifts", "shift, day, start, end, needed, skill"]],
  route: [["stops", "Stops", "name + lat, lon — or x, y — or address (looked up on OpenStreetMap). With a cost table: optional, for the map"],
    ["costs", "Cost table", "any cost (minutes, money, risk): a matrix whose line 1 names the stops, or from,to,cost lines. One-way costs can differ; blank = not allowed"]],
  teams: [["people", "People", "name, a score column (balanced), a category column (spread evenly)"], ["pairs", "Pair rules", "one per line:  Ann + Bo  (together)  ·  Ann - Cy  (apart)"]],
};
const RULES = {
  roster: [["rest", "Rest between shifts (h)", "int", 0, 24, 11], ["one_a_day", "One shift a day", "bool", 0, 1, true], ["fair", "Fairness weight", "float", 0, 5, 1], ["prefer", "Wishes weight", "float", 0, 5, 1]],
  route: [["round_trip", "Return to the start", "bool", 0, 1, true]],
  teams: [["k", "Teams", "int", 2, 20, 4], ["balance", "Balance weight", "float", 0, 5, 1], ["mix", "Mix weight", "float", 0, 5, 1]],
};
const ST = { kind: "roster", inputs: {}, rules: {}, effort: "normal", r: {}, tab: "guide", view: "people", examples: null, edited: {}, maps: {}, tpl: {}, templates: [] };
try { Object.assign(ST, JSON.parse(localStorage.getItem("vf-plan") || "{}"), { r: {} }); } catch (e) { /* fresh */ }
const save = () => { try { localStorage.setItem("vf-plan", JSON.stringify({ kind: ST.kind, inputs: ST.inputs, rules: ST.rules, effort: ST.effort, tab: ST.tab, maps: ST.maps, tpl: ST.tpl, unit: ST.unit })); } catch (e) { /* storage off */ } };
const RULEREF = { rest: "rule.rest", one_a_day: "rule.one_a_day", fair: "rule.fair", prefer: "rule.prefer", round_trip: "rule.round_trip", k: "rule.k", balance: "rule.balance", mix: "rule.mix" };
const FACTREF = { "open slots": "res.open", broken: "res.broken", unfairness: "res.unfair", wishes: "res.wishes", shown: "res.shown", "nearest-nbr": "res.nearest", "+ 2-opt": "res.two_opt",
  walkers: "res.walkers", optimum: "res.optimum", "total spread": "res.spread", "mix error": "res.mixerr" };
const maps = (k, f) => ((ST.maps[k] = ST.maps[k] || {})[f] = ST.maps[k][f] || {});
let G = null, lintT = 0;

export default {
  id: "plan", title: "Planner", sub: "rosters, routes and teams — solved on the card", icon: "gantt",
  mount(el) {
    el.innerHTML = `<div class="ws side-l pn">
      <div class="col">
        ${pane({ t: "Problem", cls: "fit", bcls: "flush", body: `<div class="list" id="pn-kinds">${KINDS.map((k) => `<div class="li" data-k="${k.id}"><div class="ic">${icon(k.icon)}</div><div class="tx"><div class="nm">${k.name}</div><div class="sub">${k.sub}</div></div></div>`).join("")}</div>
          <div class="pn-tplh">Start from a template ${helpDot("tpl")}</div><div class="list pn-tpls" id="pn-tpls"><div class="li"><div class="sub">loading…</div></div></div>` })}
        <section class="pane grow"><div class="pane-h"><div class="t">Rules</div></div>
          <div class="pane-b"><div class="fields" id="pn-rules"></div>
            <div class="hint pn-imply" id="pn-rimp"></div>
            <div class="sec-t" style="margin-top:16px">Effort ${helpDot("effort")}</div><div class="seg pn-eff" id="pn-eff">${["quick", "normal", "thorough"].map((e) => `<button data-e="${e}">${e}</button>`).join("")}</div>
            <div class="hint" style="margin-top:8px" id="pn-effh"></div></div>
          <div class="pane-act"><button class="btn block" id="pn-go">${icon("bolt")} Solve on the card</button><div class="hint" id="pn-time">&nbsp;</div></div></section>
      </div>
      <div class="col">
        <section class="pane fit sm-verdict"><div class="hl" id="pn-hl">—</div><div class="txt"><div class="nm" id="pn-nm">Planner</div><p id="pn-sent">Fill in the tables (or keep the example), set the rules, and solve.</p><p class="dw-check" id="pn-cmp"></p><details class="pn-exp" id="pn-expd" hidden open><summary>Explain my result</summary><ul id="pn-exp"></ul></details></div><div class="facts" id="pn-facts"></div></section>
        <div class="pn-main grow">
          <section class="pane"><div class="pane-h"><div class="tabs" id="pn-tabs"><button data-t="guide">Guide</button><button data-t="inputs">Inputs</button><button data-t="model">Model</button><button data-t="search">Search</button></div>
            <div class="tools"><button class="btn ghost xs" id="pn-ex" title="Put the example back">${icon("undo")} Example</button></div></div>
            <div class="pane-b" id="pn-left"></div></section>
          <section class="pane"><div class="pane-h"><div class="t" id="pn-rt">Result</div><div class="meta" id="pn-rmeta"></div>
            <div class="tools"><div class="seg" id="pn-views"></div><button class="btn ghost xs" id="pn-keep" disabled title="Save the answer as a Data Desk table">${icon("data")} Save as table</button><button class="btn ghost xs" id="pn-csv" disabled>${icon("down")} CSV</button><button class="btn ghost xs" id="pn-as" title="The same problem as Console code, an MCP call for an agent, curl or a vf command">${icon("console")} Copy as…</button></div></div>
            <div class="pane-b" id="pn-res"><div class="empty">The answer appears here.</div></div><div class="pane-f" id="pn-rf">&nbsp;</div></section>
        </div>
      </div>
    </div>`;
    $$("#pn-kinds [data-k]").forEach((b) => b.onclick = () => openKind(b.dataset.k));
    $$("#pn-tabs [data-t]").forEach((b) => b.onclick = () => { ST.tab = b.dataset.t; save(); renderLeft(); });
    onHelp(el, openRef);
    $$("#pn-eff [data-e]").forEach((b) => b.onclick = () => { ST.effort = b.dataset.e; save(); effort(); });
    $("#pn-go").onclick = solve;
    $("#pn-ex").onclick = () => { if (!confirm("Replace these inputs with the example?")) return; delete ST.inputs[ST.kind]; delete ST.rules[ST.kind]; openKind(ST.kind); };
    $("#pn-keep").onclick = keep;
    $("#pn-csv").onclick = csv;
    $("#pn-as").onclick = (e) => callMenu(e.currentTarget, "plan." + ST.kind, body(), true);
    window.addEventListener("resize", () => { if (document.querySelector("#view-plan.on")) drawRes(); });
    boot();
  },
  show(p = {}) { if (p.kind && ST.examples) openKind(p.kind); else if (p.kind) ST.kind = p.kind; else requestAnimationFrame(drawRes); },
};

async function boot() {
  try { ST.examples = await api.get("/plan/examples"); }
  catch (e) { fail(e); setTimeout(boot, 4000); return; }              // the server can be restarting: try again
  openKind(ST.kind);
  try {
    const r = await (await fetch("/v1/models/problem.templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app: "plan" }) })).json();
    ST.templates = r.result.templates;
  } catch (e) { ST.templates = []; }
  renderTpls();
}
function renderTpls() {
  const box = $("#pn-tpls"); if (!box) return;
  box.innerHTML = ST.templates.length ? ST.templates.map((t) => `<div class="li ${ST.tpl[ST.kind] === t.id ? "on" : ""}" data-tpl="${esc(t.id)}" title="${esc(t.problem)}"><div class="tx"><div class="nm">${esc(t.title)}</div><div class="sub">${esc(t.problem)}</div></div></div>`).join("")
    : `<div class="li"><div class="sub">No templates (the server is older than this page).</div></div>`;
  $$("#pn-tpls [data-tpl]").forEach((b) => b.onclick = () => loadTemplate(b.dataset.tpl));
}
// a template fills the inputs and rules of its kind; your own edits of that kind are replaced, after a question
async function loadTemplate(id) {
  let t;
  try { t = (await (await fetch("/v1/models/problem.template", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) })).json()).result; }
  catch (e) { fail(e); return; }
  if (!t || !t.params) { toast("No such template", "bad"); return; }
  const k = t.kind, cur = ST.inputs[k], ex = ST.examples[k];
  const changed = cur && INPUTS[k].some(([f]) => (cur[f] || "") !== (ex[f] || "") && (cur[f] || "") !== ((ST.tplParams || {})[f] || ""));
  if (changed && !confirm(`Replace your ${KINDS.find((x) => x.id === k).name.toLowerCase()} inputs with the template “${t.title}”?`)) return;
  ST.inputs[k] = Object.fromEntries(INPUTS[k].map(([f]) => [f, t.params[f] != null ? String(t.params[f]) : ""]));
  ST.rules[k] = Object.fromEntries(RULES[k].map(([f, , , , , d]) => [f, t.params[f] ?? ex[f] ?? d]));
  if (k === "route") ST.unit = t.params.unit || "";
  ST.tpl[k] = id; ST.tplParams = t.params; ST.tplInfo = t;
  delete ST.edited[k]; delete ST.r[k]; delete ST.maps[k]; ST.tab = "inputs"; save();
  openKind(k);
  toast(`Loaded “${t.title}”: change the text to your own data, then Solve`, "good", 2600);
}
function effort() {
  $$("#pn-eff [data-e]").forEach((b) => b.classList.toggle("on", b.dataset.e === ST.effort));
  $("#pn-effh").textContent = { quick: "1,024 walkers, about 10 s", normal: "2,048 walkers, up to 25 s", thorough: "4,096 walkers, up to 75 s — for big rosters" }[ST.effort];
}
function openKind(k) {
  ST.kind = k; save();
  const ex = ST.examples[k];
  if (!ST.inputs[k]) ST.inputs[k] = Object.fromEntries(INPUTS[k].map(([f]) => [f, ex[f] || ""]));
  if (!ST.rules[k]) ST.rules[k] = Object.fromEntries(RULES[k].map(([f, , , , , d]) => [f, ex[f] ?? d]));
  $$("#pn-kinds [data-k]").forEach((b) => b.classList.toggle("on", b.dataset.k === k));
  $("#pn-nm").textContent = KINDS.find((x) => x.id === k).name;
  $("#pn-rules").innerHTML = RULES[k].map(([f, l, t, lo, hi]) => {
    const v = ST.rules[k][f], h = helpDot(RULEREF[f]);
    if (t === "bool") return `<div class="fld bool"><label>${l}${h}</label><label class="toggle"><input type="checkbox" data-r="${f}" ${v ? "checked" : ""}><i></i></label></div>`;
    return `<div class="fld"><label>${l}${h}</label><input type="range" data-r="${f}" data-t="${t}" min="${lo}" max="${hi}" step="${t === "int" ? 1 : 0.1}" value="${v}"><span class="v" id="pr-${f}">${v}</span></div>`;
  }).join("");
  $$("#pn-rules [data-r]").forEach((i) => i.oninput = i.onchange = () => {
    ST.rules[k][i.dataset.r] = i.type === "checkbox" ? i.checked : +i.value; save();
    const v = $("#pr-" + i.dataset.r); if (v) v.textContent = i.value;
    lint();
  });
  effort();
  G = null;
  renderLeft();
  renderRes();
  renderTpls();
}

// ---------------------------------------------------------------- guide / inputs / model / search
function renderLeft() {
  const k = ST.kind, r = ST.r[k], box = $("#pn-left");
  $$("#pn-tabs [data-t]").forEach((b) => b.classList.toggle("on", b.dataset.t === ST.tab));
  $("#pn-ex").hidden = ST.tab !== "inputs";
  box.classList.toggle("is-guide", ST.tab === "guide");
  if (ST.tab === "guide") {
    box.innerHTML = `<div class="pn-guide" id="pn-guide"></div>`;
    G = guideView($("#pn-guide"), { key: "plan-" + k, lessons: LESSONS[k], ref: REF[k], onAct });
  } else if (ST.tab === "inputs") {
    const ti = ST.tplInfo && ST.tplInfo.kind === k && ST.tpl[k] === ST.tplInfo.id ? ST.tplInfo : null;
    box.innerHTML = (ti ? `<div class="pn-maps"><b>${esc(ti.title)}:</b> ${esc(ti.maps)}</div>` : "") + INPUTS[k].map(([f, l, hint]) => `<div class="pn-in"><div class="pn-inh"><b>${l}</b><span class="hint">${hint}</span><span class="spacer"></span>
        ${f === "costs" ? `<label class="pn-unit">unit <input class="in sm mono" id="pn-unit" value="${esc(ST.unit || "")}" placeholder="min, $, risk" spellcheck="false"></label>` : ""}
        ${f === "pairs" ? `<button class="btn ghost xs" data-ref-open="t.pairs" title="The pair rule syntax">${icon("eye")} Syntax</button>` : `<button class="btn ghost xs" data-dd="${f}" title="Load a Data Desk table into this box">${icon("data")} Data Desk…</button>`}</div>
        <textarea class="in mono pn-ta" data-f="${f}" spellcheck="false" wrap="off" rows="${f === "pairs" ? 5 : f === "stops" && k === "route" && (ST.inputs.route.costs || "").trim() ? 3 : 8}">${esc(ST.inputs[k][f] || "")}</textarea>
        <div class="pn-chk" id="pk-${f}"></div></div>`).join("");
    $$("#pn-left [data-f]").forEach((t) => { t.oninput = () => { ST.inputs[k][t.dataset.f] = t.value; save(); clearTimeout(lintT); lintT = setTimeout(lint, 180); }; });
    $$("#pn-left [data-dd]").forEach((b) => b.onclick = () => fromDesk(b.dataset.dd));
    const un = $("#pn-unit"); if (un) un.oninput = () => { ST.unit = un.value; save(); lint(); };
    $$("#pn-left [data-ref-open]").forEach((b) => b.onclick = () => openRef(b.dataset.refOpen));
    box.onchange = (e) => {
      const s = e.target.closest("[data-map]"); if (!s) return;
      const [f, role] = s.dataset.map.split(":"), m = maps(k, f);
      if (s.value) m[role] = s.value; else delete m[role];
      save(); lint();
    };
  } else if (ST.tab === "model") {
    box.innerHTML = r ? `<div class="hint" style="margin-bottom:8px">This is exactly what the GPU walkers solved — variables, hard rules, a goal (<a href="#" data-ref-open="dsl.var">the model language</a>). Edit it here and Solve again, or open it in Simulate.</div>
      <textarea class="in mono pn-model" id="pn-model" spellcheck="false" wrap="off">${esc(ST.edited[k] || r.model)}</textarea>
      <div class="tb" style="margin-top:8px"><button class="btn ghost xs" id="pn-sim">${icon("walk")} Open in Simulate</button><button class="btn ghost xs" id="pn-reset">${icon("undo")} Regenerate from the inputs</button><span class="hint" id="pn-medit">${ST.edited[k] ? "edited — Solve uses this text" : ""}</span></div>`
      : `<div class="empty">Solve once to see the model the inputs compile to. <a href="#" data-lesson-open="solver">How models work</a></div>`;
    if (r) {
      $("#pn-model").oninput = (e) => { ST.edited[k] = e.target.value; $("#pn-medit").textContent = "edited — Solve uses this text"; };
      $("#pn-sim").onclick = () => { try { sessionStorage.setItem("vf-solve-model", $("#pn-model").value); } catch (e) { /* */ } go("simulate", { engine: "solve", model: "session" }); };
      $("#pn-reset").onclick = () => { delete ST.edited[k]; renderLeft(); };
    }
  } else {
    box.innerHTML = r ? `<div class="hint">How the ${fmt.n(r.solver.walkers)} walkers converged: the best walker (red) and the median walker (blue), ${r.kind === "route" ? "route length" : "energy"} against sweeps.</div><div class="chartbox pn-conv"><canvas id="pn-cv"></canvas></div>
      <div class="kv" style="margin-top:10px"><span>walkers</span><b>${fmt.n(r.solver.walkers)}</b><span>sweeps</span><b>${fmt.n(r.solver.sweeps)}</b><span>time on the card</span><b>${r.solver.secs} s</b><span>answer shown</span><b>${esc(r.used)}</b></div>`
      : `<div class="empty">Solve once to see the search.</div>`;
    if (r) requestAnimationFrame(() => { const c = r.solver.chart, cv = $("#pn-cv"); if (cv) ch.line(cv, { x: c.x, h: cv.parentElement.clientHeight, area: false, series: c.series.map((s, i) => ({ y: s.y, color: ["#ff2a1a", "#3fa9f5"][i] })) }); });
  }
  $$("#pn-left [data-ref-open]").forEach((a) => a.onclick = (e) => { e.preventDefault(); openRef(a.dataset.refOpen); });
  $$("#pn-left [data-lesson-open]").forEach((a) => a.onclick = (e) => { e.preventDefault(); openLesson(a.dataset.lessonOpen); });
  lint();
}
function openRef(key) { ST.tab = "guide"; save(); renderLeft(); G.lookup(key); }
function openLesson(id) { ST.tab = "guide"; save(); renderLeft(); G.show(id); }

// the live check under each table: roles (with the mapping), then what was understood or is wrong
let costT = 0, costSeq = 0;
function lintCosts() {
  const el = $("#pk-costs"), text = (ST.inputs.route || {}).costs || ""; if (!el) return;
  if (!text.trim()) { el.innerHTML = `<div class="pn-lint"><div class="pn-lh">${icon("eye")}<b class="dim">empty</b><span>the stops above set the cost (straight-line distance)</span></div></div>`; return; }
  clearTimeout(costT);
  costT = setTimeout(async () => {
    const seq = ++costSeq;
    try {
      const r = await (await fetch("/v1/models/plan.check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "route", costs: text, unit: ST.unit || "", round_trip: !!(ST.rules.route || {}).round_trip }) })).json();
      if (seq !== costSeq || !$("#pk-costs")) return;
      const c = r.result || { ok: false, error: (r.error || {}).message || "the check failed" };
      $("#pk-costs").innerHTML = `<div class="pn-lint"><div class="pn-lh">${icon(c.ok ? (c.warnings.length ? "eye" : "spark") : "x")}${c.ok ? (c.warnings.length ? `<b class="warn">${c.warnings.length} to look at</b>` : `<b class="good">looks right</b>`) : `<b class="bad">1 problem</b>`}${c.ok ? `<span>${c.facts.map(esc).join(" · ")}</span>` : ""}</div>
        ${c.ok ? c.warnings.map((w) => `<div class="pn-msg info">${esc(w)}</div>`).join("") : `<div class="pn-msg err">${esc(c.error)}</div>`}</div>`;
    } catch (e) { /* the next keystroke tries again */ }
  }, 250);
}
function lint() {
  const k = ST.kind, res = check(k, ST.inputs[k] || {}, ST.rules[k] || {}, ST.maps[k] || {});
  if (k === "route" && ((ST.inputs.route || {}).costs || "").trim()) {           // with a cost table the stops only draw the map
    res.stops = (ST.inputs.route.stops || "").trim() ? { R: null, msgs: [{ lvl: "info", text: "Used only to draw the map: the stops must have the same names as the cost table." }], facts: [] }
      : { R: null, msgs: [], facts: ["not needed: the cost table sets the stops (no map without coordinates)"] };
    res.imply = (ST.rules.route || {}).round_trip ? "round trip: back to the first stop of the cost table" : "one way from the first stop of the cost table";
  }
  const imp = $("#pn-rimp"); if (imp) imp.textContent = res.imply || "";
  if (ST.tab !== "inputs") return;
  for (const [f] of INPUTS[k]) {
    if (f === "costs") { lintCosts(); continue; }
    const el = $("#pk-" + f), c = res[f]; if (!el || !c) continue;
    let roles = "";
    if (c.R && c.R.head.length) {
      const m = (ST.maps[k] || {})[f] || {};
      roles = `<div class="pn-roles">${ROLES[k][f].map(([role, , , req]) => {
        const cur = c.R.roles[role], over = m[role] != null && c.R.head.includes(m[role]) || m[role] === NONE;
        const autoTxt = c.R.auto[role] ? `${c.R.auto[role]} (auto)` : "none (auto)";
        return `<label class="pn-role ${cur ? "set" : ""} ${req && !cur ? "miss" : ""} ${over ? "ovr" : ""}"><span>${role}${req ? "*" : ""}${helpDot(REFKEY[`${k}.${f}.${role}`])}</span>
          <select class="sel sm" data-map="${f}:${role}"><option value="">${esc(autoTxt)}</option>${c.R.head.map((h) => `<option value="${esc(h)}" ${m[role] === h ? "selected" : ""}>${esc(h)}</option>`).join("")}<option value="${NONE}" ${m[role] === NONE ? "selected" : ""}>none</option></select></label>`;
      }).join("")}</div>`;
      if (c.R.ignored.length) c.msgs.push({ lvl: "info", text: `Ignored column${c.R.ignored.length > 1 ? "s" : ""}: ${c.R.ignored.join(", ")}${c.R.mapped ? "" : " — map one above if it means something"}.` });
      if (c.R.mapped) c.msgs.push({ lvl: "info", text: "Your mapping is applied: the table is sent with our column names (your text stays as it is)." });
    }
    const errs = c.msgs.filter((x) => x.lvl === "err").length, warns = c.msgs.filter((x) => x.lvl === "warn").length;
    const head = errs ? `<b class="bad">${errs} problem${errs > 1 ? "s" : ""}</b>` : warns ? `<b class="warn">${warns} to look at</b>` : `<b class="good">looks right</b>`;
    el.innerHTML = roles + `<div class="pn-lint"><div class="pn-lh">${icon(errs ? "x" : warns ? "eye" : "spark")}${head}${c.facts.length ? `<span>${c.facts.map(esc).join(" · ")}</span>` : ""}</div>
      ${c.msgs.map((x) => `<div class="pn-msg ${x.lvl}">${esc(x.text)}</div>`).join("")}</div>`;
  }
}
async function fromDesk(f) {
  const pick = await pickColumns({ title: "Load a Data Desk table", multi: true, min: 0, hint: "The Planner loads the full table as CSV into the box. Do not tick anything. The columns can have any names: map them below the table." });
  if (!pick) return;
  try {
    const r = await api.raw("GET", `/tables/${pick.tid}/csv`);
    ST.inputs[ST.kind][f] = await r.text(); delete (ST.maps[ST.kind] || {})[f]; save(); ST.tab = "inputs"; renderLeft();
    toast(`Loaded “${pick.table}” — check the roles under it`);
  } catch (e) { fail(e); }
}

// what the guide's buttons do
function onAct(act, a, btn) {
  const k = ST.kind;
  if (act === "load") {
    for (const [f, v] of Object.entries(a.inputs || {})) { ST.inputs[k][f] = v; delete (ST.maps[k] || {})[f]; }
    Object.assign(ST.rules[k], a.rules || {});
    delete ST.edited[k]; delete ST.r[k]; save();
    const sc = $("#pn-guide") ? $("#pn-guide").scrollTop : 0;
    openKind(k);
    const g = $("#pn-guide"); if (g) g.scrollTop = sc;
    toast(a.solve ? "Loaded — solving on the card…" : "Loaded into Inputs", "good", 1800);
    if (a.solve) solve();
  } else if (act === "csv") {
    ST.inputs[k][a.field] = a.csv; delete (ST.maps[k] || {})[a.field]; delete ST.edited[k]; save();
    btn.textContent = "Loaded ✓"; toast(`Loaded into ${INPUTS[k].find(([f]) => f === a.field)[1]}`, "good", 1600); lint();
  } else if (act === "tab") { ST.tab = a; save(); renderLeft(); }
  else if (act === "solve") solve();
  else if (act === "ref") G.lookup(a);
}

// ---------------------------------------------------------------- solve
function body() {
  const k = ST.kind, b = { ...ST.inputs[k], ...ST.rules[k], effort: ST.effort };
  for (const [f] of INPUTS[k]) b[f] = outgoing(k, f, ST.inputs[k][f] || "", (ST.maps[k] || {})[f] || {});   // mapped columns renamed to ours
  if (k === "route") { if ((b.costs || "").trim()) b.unit = ST.unit || ""; else delete b.costs; }
  if (ST.edited[k]) b.model = ST.edited[k];
  for (const f of Object.keys(b)) if (b[f] === "") delete b[f];
  return b;
}
async function solve() {
  const k = ST.kind, btn = $("#pn-go");
  const body_ = body();
  btn.disabled = true; $("#pn-res").parentElement.classList.add("is-busy");
  const t0 = performance.now();
  try {
    const j = await api.post("/plan/" + k, body_);
    const r = await watchJob({ id: j.job, state: "running" }, (s) => { $("#pn-time").textContent = `${s.message || "working"} · ${Math.round((performance.now() - t0) / 1000)} s`; });
    ST.r[k] = r;
    $("#pn-time").innerHTML = `solved in <span class="timing">${fmt.ms(r.ms)}</span>`;
    renderRes();
    if (ST.tab === "model" || ST.tab === "search") renderLeft(); else lint();
  } catch (e) { $("#pn-time").textContent = ""; $("#pn-hl").className = "hl bad"; $("#pn-hl").textContent = "—"; $("#pn-sent").textContent = e.message; $("#pn-cmp").textContent = ""; }
  btn.disabled = false; $("#pn-res").parentElement.classList.remove("is-busy");
}

// ---------------------------------------------------------------- results
function renderRes() {
  const k = ST.kind, r = ST.r[k];
  $("#pn-keep").disabled = $("#pn-csv").disabled = !r;
  if (!r) {
    $("#pn-hl").className = "hl"; $("#pn-hl").textContent = "—"; $("#pn-cmp").textContent = ""; $("#pn-facts").innerHTML = "";
    $("#pn-sent").textContent = "Fill in the tables (or keep the example), set the rules, and solve."; $("#pn-expd").hidden = true;
    $("#pn-res").innerHTML = `<div class="empty">The answer appears here.</div>`; $("#pn-views").innerHTML = ""; $("#pn-rmeta").textContent = ""; $("#pn-rf").innerHTML = "&nbsp;";
    return;
  }
  $("#pn-hl").className = "hl " + r.tone; $("#pn-hl").textContent = r.headline;
  $("#pn-sent").textContent = r.sentence; $("#pn-cmp").textContent = r.compare_text;
  $("#pn-expd").hidden = !(r.explain || []).length; $("#pn-exp").innerHTML = (r.explain || []).map((x) => `<li>${esc(x)}</li>`).join("");
  const facts = k === "route" ? [["nearest-nbr", fmt.n(r.compare.nearest, 1)], ["+ 2-opt", fmt.n(r.compare.two_opt, 1)], ["walkers", fmt.n(r.compare.walkers, 1)], ["optimum", r.compare.exact != null ? fmt.n(r.compare.exact, 1) : "n > 13"], ["stops", r.order.length], ["shown", r.used]]
    : k === "roster" ? [["open slots", r.eval.open], ["broken", r.eval.breaks.length], ["unfairness", r.eval.unfair], ["wishes", r.eval.prefs], ["people", r.names.length], ["shown", r.used]]
      : [["teams", r.teams.length], ["total spread", r.eval.spread], ["mix error", r.eval.mix], ["broken", r.eval.breaks.length], ["people", r.table.rows.length], ["shown", r.used]];
  $("#pn-facts").innerHTML = facts.map(([l, v]) => `<div><b>${esc(String(v))}</b><span>${esc(l)}${FACTREF[l] ? helpDot(FACTREF[l]) : ""}</span></div>`).join("");
  const views = { roster: [["people", "By person"], ["shifts", "By shift"]], route: r.pts ? [["map", "Map"], ["list", "Stops"]] : [["list", "Stops"]], teams: [["teams", "Teams"]] }[k];
  if (!views.some(([v]) => v === ST.view)) ST.view = views[0][0];
  $("#pn-views").innerHTML = views.length > 1 ? views.map(([v, l]) => `<button data-v="${v}" class="${v === ST.view ? "on" : ""}">${l}</button>`).join("") : "";
  $$("#pn-views [data-v]").forEach((b) => b.onclick = () => { ST.view = b.dataset.v; renderRes(); });
  if (k === "roster") roster(r); else if (k === "route") route(r); else teams(r);
}
function drawRes() { const r = ST.r[ST.kind]; if (r && ST.kind === "route" && ST.view === "map") drawMap(r); }

function roster(r) {
  $("#pn-rt").textContent = "Roster";
  $("#pn-rmeta").textContent = `${r.names.length} people · ${r.shifts.length} shifts`;
  const issues = [...r.short.map((s) => ["short", s]), ...r.eval.breaks.map((b) => ["break", b])];
  const iss = issues.length ? `<div class="pn-issues">${issues.map(([t, s]) => `<div class="pn-issue ${t}">${icon(t === "short" ? "eye" : "x")}<span>${esc(s)}</span></div>`).join("")}</div>` : "";
  if (ST.view === "people") {
    const max = Math.max(1, ...r.eval.load);
    $("#pn-res").innerHTML = iss + `<div class="pn-scroll"><table class="tbl pn-grid"><thead><tr><th>person</th>${r.days.map((d) => `<th>${esc(d)}</th>`).join("")}<th class="r">shifts</th></tr></thead><tbody>
      ${r.grid.map((p, i) => `<tr><td class="nm">${esc(p.name)}</td>${r.days.map((d) => `<td>${(p.days[d] || []).map((s) => `<span class="pn-chip s-${esc(s.toLowerCase().replace(/[^a-z]/g, ""))}">${esc(s)}</span>`).join("")}</td>`).join("")}
        <td class="r"><span class="pn-load"><i style="width:${r.eval.load[i] / max * 100}%"></i></span><b class="mono">${r.eval.load[i]}</b><span class="dim mono"> / ${r.targets[i]}</span></td></tr>`).join("")}</tbody></table></div>`;
  } else {
    $("#pn-res").innerHTML = iss + `<div class="pn-scroll"><table class="tbl pn-grid"><thead><tr><th>day</th><th>shift</th><th>hours</th><th>who</th></tr></thead><tbody>
      ${r.shifts.map((s) => `<tr><td>${esc(s.day)}</td><td>${esc(s.name)}</td><td class="mono dim">${hh(s.start)}–${hh(s.end)}</td><td>${s.who.map((w) => w ? `<span class="pn-chip">${esc(w)}</span>` : `<span class="pn-chip open">open</span>`).join("")}</td></tr>`).join("")}</tbody></table></div>`;
  }
  $("#pn-rf").innerHTML = `<span><b>${r.eval.open}</b> open</span><span><b>${r.eval.breaks.length}</b> broken</span><span>spread <b>${r.eval.spread}</b></span><span class="timing">${fmt.ms(r.ms)}</span>`;
}
const hh = (h) => `${String(Math.floor(h) % 24).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;

function route(r) {
  $("#pn-rt").textContent = "Route";
  $("#pn-rmeta").textContent = `${r.order.length} stops · ${fmt.n(r.length, 1)} ${r.unit}${r.round_trip ? " round trip" : ""}`;
  const gm = r.pts && (r.pts_unit || r.unit) === "km" ? mapsLinks(r) : [];
  const links = gm.length ? `<div class="pn-links">${gm.map((u, i) => `<a class="btn ghost xs" href="${u}" target="_blank" rel="noopener">${icon("walk")} Google Maps${gm.length > 1 ? " · part " + (i + 1) : ""}</a>`).join("")}<span class="hint">opens the route for turn-by-turn directions</span></div>` : "";
  if (ST.view === "map") {
    $("#pn-res").innerHTML = links + `<div class="chartbox pn-map"><canvas id="pn-map"></canvas></div>`;
    requestAnimationFrame(() => drawMap(r));
  } else {
    $("#pn-res").innerHTML = links + `<table class="tbl pn-grid"><thead><tr><th class="r">#</th><th>stop</th><th class="r">leg</th><th class="r">so far</th></tr></thead><tbody>
      ${r.table.rows.map((row) => `<tr><td class="r mono dim">${row[0]}</td><td>${esc(row[1])}</td><td class="r mono">${fmt.n(row[2], 2)}</td><td class="r mono dim">${fmt.n(row[3], 2)}</td></tr>`).join("")}
      ${r.round_trip ? `<tr><td class="r mono dim">↩</td><td class="dim">back to ${esc(r.names[0])}</td><td class="r mono">${fmt.n(r.legs[r.legs.length - 1], 2)}</td><td class="r mono dim">${fmt.n(r.length, 2)}</td></tr>` : ""}</tbody></table>`;
  }
  $("#pn-rf").innerHTML = `<span>${r.cost_table ? "your costs" : "straight-line"} · ${esc(r.unit)}${r.cost_table && !r.symmetric ? " · one-way" : ""}</span><span>nearest <b>${fmt.n(r.compare.nearest, 1)}</b></span><span>2-opt <b>${fmt.n(r.compare.two_opt, 1)}</b></span><span>walkers <b>${fmt.n(r.compare.walkers, 1)}</b></span><span class="timing">${fmt.ms(r.ms)}</span>`;
}
function mapsLinks(r) {        // Google Maps takes up to ~10 points per link: split long routes into parts
  const pts = r.order.map((i) => r.pts[i]); if (r.round_trip) pts.push(r.pts[r.order[0]]);
  const out = [];
  for (let a = 0; a < pts.length - 1; a += 9) out.push("https://www.google.com/maps/dir/" + pts.slice(a, a + 10).map((p) => p[0].toFixed(5) + "," + p[1].toFixed(5)).join("/"));
  return out;
}
function drawMap(r) {
  const cv = $("#pn-map"); if (!cv) return;
  const box = cv.parentElement, dpr = window.devicePixelRatio || 1, W = box.clientWidth, H = box.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + "px";
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  if (!r.pts) return;
  const geo = (r.pts_unit || r.unit) === "km", P = r.pts.map(([a, b]) => geo ? [b * Math.cos(r.pts[0][0] * Math.PI / 180), a] : [a, b]);
  const xs = P.map((p) => p[0]), ys = P.map((p) => p[1]), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pad = 36, s = Math.min((W - 2 * pad) / ((x1 - x0) || 1), (H - 2 * pad) / ((y1 - y0) || 1));
  const ox = (W - (x1 - x0) * s) / 2, oy = (H - (y1 - y0) * s) / 2;
  const X = (p) => ox + (p[0] - x0) * s, Y = (p) => H - oy - (p[1] - y0) * s;
  g.strokeStyle = "rgba(255,255,255,.05)"; for (let i = 0; i <= 8; i++) { g.beginPath(); g.moveTo(i * W / 8, 0); g.lineTo(i * W / 8, H); g.stroke(); g.beginPath(); g.moveTo(0, i * H / 8); g.lineTo(W, i * H / 8); g.stroke(); }
  const seq = r.order.concat(r.round_trip ? [r.order[0]] : []);
  g.lineWidth = 2.2; g.strokeStyle = "#ff2a1a"; g.beginPath(); seq.forEach((i, k) => k ? g.lineTo(X(P[i]), Y(P[i])) : g.moveTo(X(P[i]), Y(P[i]))); g.stroke();
  for (let k = 0; k < seq.length - 1; k++) {           // direction arrows mid-leg
    const a = P[seq[k]], b = P[seq[k + 1]], mx = (X(a) + X(b)) / 2, my = (Y(a) + Y(b)) / 2, ang = Math.atan2(Y(b) - Y(a), X(b) - X(a));
    g.save(); g.translate(mx, my); g.rotate(ang); g.fillStyle = "#ff8a7a"; g.beginPath(); g.moveTo(5, 0); g.lineTo(-4, -4); g.lineTo(-4, 4); g.closePath(); g.fill(); g.restore();
  }
  g.font = "11px Inter, sans-serif"; g.textBaseline = "middle";
  r.order.forEach((i, k) => {
    const x = X(P[i]), y = Y(P[i]);
    g.beginPath(); g.arc(x, y, k === 0 ? 9 : 8, 0, 7); g.fillStyle = k === 0 ? "#ffd300" : "#18181c"; g.fill(); g.lineWidth = 1.5; g.strokeStyle = k === 0 ? "#ffd300" : "#ff2a1a"; g.stroke();
    g.fillStyle = k === 0 ? "#000" : "#fff"; g.textAlign = "center"; g.font = "600 10px 'JetBrains Mono', monospace"; g.fillText(String(k + 1), x, y + 0.5);
    g.font = "11px Inter, sans-serif"; g.textAlign = x > W * 0.8 ? "right" : "left"; g.fillStyle = "#c8c9ce"; g.fillText(r.names[i], x + (x > W * 0.8 ? -13 : 13), y);
  });
  if (geo) {                                             // scale bar
    const kmPx = s * (1 / 111.32), want = [1, 2, 5, 10, 20, 50, 100, 200, 500].find((v) => v * kmPx > 70) || 1000;
    g.strokeStyle = "#8a8b93"; g.lineWidth = 1.5; g.beginPath(); g.moveTo(16, H - 16); g.lineTo(16 + want * kmPx, H - 16); g.stroke();
    g.fillStyle = "#8a8b93"; g.textAlign = "left"; g.fillText(want + " km", 16, H - 26);
  }
}

function teams(r) {
  $("#pn-rt").textContent = "Teams";
  $("#pn-rmeta").textContent = `${r.teams.length} teams${r.score_col ? " · balanced on " + r.score_col : ""}${r.cat_col ? " · " + r.cat_col + " spread" : ""}`;
  const unk = r.unknown_pairs.length ? `<div class="pn-issues"><div class="pn-issue short">${icon("eye")}<span>Ignored pair rules (name not found): ${esc(r.unknown_pairs.join(" · "))}</span></div></div>` : "";
  const brk = r.eval.breaks.length ? `<div class="pn-issues">${r.eval.breaks.map((b) => `<div class="pn-issue break">${icon("x")}<span>${esc(b)}</span></div>`).join("")}</div>` : "";
  $("#pn-res").innerHTML = unk + brk + `<div class="pn-teams">${r.members.map((ms, j) => {
    const cats = {}; ms.forEach((m) => { if (m.cat) cats[m.cat] = (cats[m.cat] || 0) + 1; });
    return `<div class="pn-team"><div class="pn-th"><b>Team ${j + 1}</b>${r.score_col ? `<span class="mono">${fmt.n(r.eval.totals[j], 1)}</span>` : ""}</div>
      <div class="pn-tl">${ms.map((m) => `<div><span>${esc(m.name)}</span>${r.cat_col ? `<span class="dim">${esc(m.cat)}</span>` : ""}${r.score_col ? `<b class="mono">${fmt.n(m.score, 1)}</b>` : ""}</div>`).join("")}</div>
      ${r.cat_col ? `<div class="pn-tc">${Object.entries(cats).map(([c, n]) => `<span>${esc(c)} ${n}</span>`).join("")}</div>` : ""}</div>`;
  }).join("")}</div>`;
  $("#pn-rf").innerHTML = `<span>spread <b>${r.eval.spread}</b></span><span>mix error <b>${r.eval.mix}</b></span><span>snake draft spread <b>${r.snake_eval.spread}</b></span><span class="timing">${fmt.ms(r.ms)}</span>`;
}

// ---------------------------------------------------------------- keep the answer
async function keep() {
  const r = ST.r[ST.kind]; if (!r) return;
  try { const m = await api.post("/plan/save", { name: `${ST.kind} plan ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, table: r.table }); toast(`Saved as “${m.name}” in the Data Desk`); }
  catch (e) { fail(e); }
}
function csv() {
  const r = ST.r[ST.kind]; if (!r) return;
  const q = (v) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const text = [r.table.header, ...r.table.rows].map((row) => row.map(q).join(",")).join("\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" })); a.download = `${ST.kind}-plan.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
