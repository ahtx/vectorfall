import { $, $$, api, esc, fail, icon } from "./core.js";
import { PALETTE } from "./charts.js";
import { callModel } from "./hub.js";
import { guideView, helpDot, onHelp } from "./guide.js";
import { LESSONS, REF, sampleTable } from "./particles-guide.js";

// Particle Lab: a population that grows, competes, merges and dies, run as an N-body system on the card.
// Left: the world (a built-in one or any Data Desk table) and the rules, each an overlay you switch on, set, or fit
// from the window before the start. Middle: the map — every step of the run, simulated (discs) against what really
// happened (rings), zoomable — and the groups' shares following the scrubber. Right: Score (against two baselines, over
// time and across history), Bodies (and the one you picked), Guide. Positions come from co-movement, so groups appear
// as clusters; mass is share of the whole; velocity is trailing growth.
const CATS = [
  ["momentum", "Growth carries on", "Velocity: the growth before the start continues, then goes back to the average.", "beta"],
  ["size", "Size effect", "The big get bigger — or the small catch up.", "alpha"],
  ["takeover", "Neighbourhood takeover", "Close neighbours on the map compete for the same share.", "G"],
  ["gravity", "Gravity drift", "Bodies move toward heavy neighbours. Groups come closer together.", "Gx"],
  ["merge", "Mergers", "A small body that moves into a big one joins it. Not checked: free price data has no companies that another company bought.", "merge_r"],
  ["life", "Birth and death", "New arrivals (the Oort cloud), drops below the floor, and each body's own noise.", "entrants"],
];
const WORLDS = [["sp500", "S&P 500"], ["gdp", "Countries"], ["table", "Your table"]];
const S = {
  sources: [], rules: [], src: "sp500", t0: "", horizon: 60, rv: {}, on: { momentum: true, size: false, takeover: false, gravity: true, merge: false, life: true },
  fit: new Set(), table: "", layout: "wide", cols: "", entity_col: "", value_col: "", group_col: "", groups: "", tables: [],
  res: null, bt: null, err: "", stale: false, auto: true, busy: false, again: false,
  layer: "both", maplay: "start", colour: "group", tab: "guide", sort: "gain",
  u: 0, playing: false, hover: -1, pick: null, focus: null, view: { k: 1, ox: 0, oy: 0 },
};
const KEEP = ["src", "t0", "horizon", "rv", "on", "table", "layout", "cols", "entity_col", "value_col", "group_col", "groups", "auto", "layer", "maplay", "colour", "tab"];
let firstVisit = true;
try {
  const j = JSON.parse(localStorage.getItem("vf-particles2") || "null");
  if (j) { firstVisit = false; for (const k of KEEP) if (k in j) S[k] = j[k]; S.fit = new Set(j.fit || []); }
} catch (e) { /* fresh */ }
const save = () => { try { localStorage.setItem("vf-particles2", JSON.stringify({ ...Object.fromEntries(KEEP.map((k) => [k, S[k]])), fit: [...S.fit] })); } catch (e) { /* storage off */ } };
const pct = (x, d = 1) => x == null ? "—" : x > 0 && x * 100 < Math.pow(10, -d) ? (x * 100).toPrecision(2) + "%" : (x * 100).toFixed(d) + "%";
const SIM = "#ff2a1a", REAL = "#3fa9f5";
let grpColor = {};
const colorOf = (g) => { if (!(g in grpColor)) grpColor[g] = PALETTE[Object.keys(grpColor).length % PALETTE.length]; return grpColor[g]; };
let G = null;                                            // the guide

// "Rules by hand": the first Particle Lab, kept as a mode of the new one (particles.js mounts it into its own box).
export default {
  id: "particles-hand", title: "Particle Lab", sub: "rules by hand", icon: "orbit",
  mount(el) {
    el.innerHTML = `<div class="ws side-lr pl">
      <div class="col">
        <section class="pane fit" id="pl-world"><div class="pane-h"><div class="t">World</div><div class="meta" id="pl-wmeta"></div></div>
          <div class="pane-b" id="pl-wbody"></div></section>
        <section class="pane grow" id="pl-rules"><div class="pane-h"><div class="t">Rules</div><div class="meta">overlays · tick “fit” to learn a number from the past</div></div>
          <div class="pane-b flush" id="pl-rbody"></div>
          <div class="pane-act"><button class="btn block" id="pl-go">${icon("bolt")} Run on the card</button>
            <button class="btn ghost block" id="pl-bt" title="At some past start dates: fit the ticked rules on the window before, run forward, and compare with what happened">Test on past dates</button>
            <div class="pl-auto"><label class="toggle"><input type="checkbox" id="pl-auto" ${S.auto ? "checked" : ""}><i></i></label><span>rerun when anything changes</span><span class="chip red" id="pl-stale" hidden>not run yet</span></div>
            <div class="hint" id="pl-time">&nbsp;</div></div></section>
      </div>
      <div class="col">
        <section class="pane fit sm-verdict" id="pl-verdict"><div class="hl" id="pl-hl">—</div><div class="txt"><div class="nm" id="pl-nm">Particle Lab</div><p id="pl-sent">Select a world, set rules on, and run. Each run starts from a past date. The tool compares it with what really happened next.</p></div><div class="facts" id="pl-facts"></div></section>
        <section class="pane grow" id="pl-mapp"><div class="pane-h"><div class="t">Map</div>
            <div class="seg" id="pl-layer"><button data-v="sim" title="Discs: the average simulated share">Simulated</button><button data-v="real" title="The real share at the same step">What happened</button><button data-v="both" title="Disc = simulated, ring = what happened">Both</button></div>
            <div class="meta" id="pl-mmeta"></div><button class="iconbtn" data-help-g="layer" title="How to read the map">?</button></div>
          <div class="pane-b stage" id="pl-stage"><canvas id="pl-map" tabindex="0"></canvas>
            <div class="pl-ov tl"><div class="seg xs" id="pl-maplay"><button data-v="start" title="The co-movement map at the start">Start map</button><button data-v="evolved" title="Drawn again at each step from the real data in the window before it">As it evolved</button></div>
              <div class="seg xs" id="pl-colour"><button data-v="group">Colour: group</button><button data-v="growth">growth</button></div></div>
            <div class="pl-ov tr"><button class="iconbtn" id="pl-zin" title="Zoom in">${icon("zoomin")}</button><button class="iconbtn" id="pl-zout" title="Zoom out">${icon("zoomout")}</button><button class="iconbtn" id="pl-zfit" title="Show all (double-click the map to zoom in)">${icon("fit")}</button></div>
            <div class="pl-ov bl" id="pl-legend"></div>
            <div class="pl-msg" id="pl-msg" hidden></div>
            <div class="pl-tip" id="pl-tip" hidden></div></div>
          <div class="pane-f pl-time"><button class="iconbtn" id="pl-play" title="Play the run (space)">${icon("play")}</button><input type="range" id="pl-scrub" min="0" max="0" step="any" value="0"><span id="pl-fr" class="mono">—</span></div></section>
        <section class="pane fit" id="pl-gp"><div class="pane-h"><div class="t" id="pl-gt">Groups</div><div class="meta" id="pl-gmeta">share of the whole · start → simulated · what happened, at the scrubber</div></div>
          <div class="pane-b" id="pl-groups"><div class="hint">Run to see each group's share.</div></div></section>
      </div>
      <div class="col">
        <section class="pane grow" id="pl-side"><div class="pane-h"><div class="tabs" id="pl-tabs"><button data-t="score">Score</button><button data-t="bodies">Bodies</button><button data-t="guide">Guide</button></div><div class="meta" id="pl-smeta"></div></div>
          <div class="pane-b" id="pl-score"></div><div class="pane-b flush" id="pl-bodies"></div><div class="pane-b" id="pl-guide"></div></section>
      </div>
    </div>`;
    seg("#pl-layer", "layer", () => draw());
    seg("#pl-maplay", "maplay", () => { fitView(); draw(); });
    seg("#pl-colour", "colour", () => draw());
    $$("#pl-tabs [data-t]").forEach((b) => b.onclick = () => tab(b.dataset.t));
    $("#pl-go").onclick = () => run();
    $("#pl-bt").onclick = backtest;
    $("#pl-auto").onchange = (e) => { S.auto = e.target.checked; save(); };
    const sc = $("#pl-scrub");
    sc.oninput = () => { S.u = +sc.value; S.playing = false; frameChanged(); };
    $("#pl-play").onclick = play;
    $("#pl-zin").onclick = () => zoomBy(1.6); $("#pl-zout").onclick = () => zoomBy(1 / 1.6); $("#pl-zfit").onclick = () => { S.focus = null; fitView(); draw(); legend(); };
    $("[data-help-g=layer]").onclick = () => { tab("guide"); G.show("time"); };
    mapInput($("#pl-map"));
    new ResizeObserver(() => { draw(); groups(); errChart(); bodyChart(); }).observe($("#pl-stage"));
    G = guideView($("#pl-guide"), { key: "particles", lessons: LESSONS, ref: REF, onAct: guideAct });
    onHelp(el, (k) => { tab("guide"); G.lookup(k); });
    tab(firstVisit ? "guide" : S.tab);
    boot();
  },
  show() { draw(); },
  hide() { S.playing = false; },
};
function seg(sel, key, after) {
  const paint = () => $$(sel + " [data-v]").forEach((b) => b.classList.toggle("on", b.dataset.v === S[key]));
  $$(sel + " [data-v]").forEach((b) => b.onclick = () => { if (b.disabled) return; S[key] = b.dataset.v; save(); paint(); after(); });
  paint();
}
function tab(t) {
  S.tab = t; save();
  $$("#pl-tabs [data-t]").forEach((b) => b.classList.toggle("on", b.dataset.t === t));
  ["score", "bodies", "guide"].forEach((k) => { $("#pl-" + k).hidden = k !== t; });
  $("#pl-smeta").textContent = t === "guide" ? "how it works" : t === "bodies" ? (S.res ? `${S.res.bodies.length} bodies` : "") : "";
  if (t === "score") { scores(); } else if (t === "bodies") bodies();
}

async function boot() {
  try {
    const [r, s, t] = await Promise.all([callModel("particles.rules"), callModel("particles.sources"), api.get("/tables").catch(() => [])]);
    S.rules = r.result.rules; S.sources = s.result.sources; S.tables = t;
    S.rules.forEach((x) => { if (!(x.k in S.rv)) S.rv[x.k] = x.default; });
    clampHorizon(); world(); rulesUI(); scores(); bodies();
    run();                                               // the stage is never empty: the last world runs on arrival
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- world
const srcOf = () => S.sources.find((x) => x.id === S.src);
function stepLimits() {
  const src = srcOf();
  if (S.src === "gdp" || (src && src.step === "year")) return { max: 30, def: 10 };
  if (S.src === "sp500") return { max: 120, def: 60 };
  return { max: 60, def: 12 };
}
function clampHorizon() { const { max } = stepLimits(); S.horizon = Math.max(2, Math.min(max, S.horizon || 0)); }
function world() {
  const src = srcOf();
  let body = `<div class="seg pl-src">${WORLDS.map(([k, l]) => `<button data-src="${k}" class="${S.src === k ? "on" : ""}">${l}</button>`).join("")}</div>`;
  if (S.src === "table") {
    const tb = S.tables.find((x) => x.id === S.table);
    const opt = (list, v) => `<option value="">—</option>` + (list || []).map((c) => `<option ${c === v ? "selected" : ""}>${esc(c)}</option>`).join("");
    body += `<div class="fields" style="margin-top:10px">
      <div class="fld two"><label>Table</label><select class="sel sm" id="pl-tab"><option value="">choose…</option>${S.tables.map((t) => `<option value="${esc(t.id)}" ${t.id === S.table ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></div>
      <div class="fld two"><label>Shape</label><select class="sel sm" id="pl-lay"><option value="wide" ${S.layout === "wide" ? "selected" : ""}>wide — a column per entity</option><option value="long" ${S.layout === "long" ? "selected" : ""}>long — date, entity, value</option></select></div>
      ${S.layout === "long" ? `<div class="fld two"><label>Entity</label><select class="sel sm" id="pl-ent">${opt(tb && tb.categorical, S.entity_col)}</select></div>
        <div class="fld two"><label>Value (size)</label><select class="sel sm" id="pl-val">${opt(tb && tb.numeric, S.value_col)}</select></div>
        <div class="fld two"><label>Group</label><select class="sel sm" id="pl-grp">${opt(tb && tb.categorical, S.group_col)}</select></div>`
        : `<div class="fld stackd"><label>Entity columns <span class="dim">(empty = every numeric column)</span></label><input class="in sm" id="pl-cols" value="${esc(S.cols)}" placeholder="comma-separated"></div>
        <div class="fld stackd"><label>Groups <span class="dim">one “entity: group” per line</span></label><textarea class="in mono" id="pl-gtxt" rows="3">${esc(S.groups)}</textarea></div>`}
      </div><div class="hint">Shapes and an example: <a href="#" data-lesson-g="own">Your own data</a>.</div>`;
  }
  const dates = src && src.dates ? src.dates : [];
  const { max } = stepLimits();
  body += `<div class="fields" style="margin-top:10px">
    <div class="fld two"><label>Start ${helpDot("t0")}</label>${dates.length ? `<select class="sel sm" id="pl-t0"><option value="">latest with an outcome</option>${dates.filter((d) => src.step !== "month" || d.slice(5, 7) === "12").map((d) => d.slice(0, src.step === "year" ? 4 : 7)).map((l) => `<option ${l === S.t0 ? "selected" : ""}>${l}</option>`).join("")}</select>` : `<input class="in sm" id="pl-t0" value="${esc(S.t0)}" placeholder="a date in the table, or empty">`}</div>
    <div class="fld"><label>Steps to run ${helpDot("horizon")}</label><input type="range" id="pl-h" min="2" max="${max}" step="1" value="${S.horizon}"><span class="v" id="pl-hv">${S.horizon}</span></div></div>
    <div class="hint" style="margin-top:6px">${src ? (src.error ? esc(src.error) : `${esc(src.what)} · ${src.bodies} bodies · by ${esc(src.group_name)} · one step = a ${esc(src.step)}`) : "You can use any table: the rows are dates and the numbers are sizes."}</div>`;
  $("#pl-wbody").innerHTML = body;
  $("#pl-wmeta").textContent = src && src.step ? `steps: ${src.step}s` : "";
  $$("#pl-wbody [data-src]").forEach((b) => b.onclick = () => {
    if (S.src === b.dataset.src) return;
    S.src = b.dataset.src; S.t0 = ""; S.horizon = stepLimits().def; S.res = null; S.bt = null; S.pick = null; S.focus = null; grpColor = {};
    save(); world(); changed();
  });
  const on = (id, k, ev = "onchange", re = false) => { const e = $(id); if (e) e[ev] = () => { S[k] = e.value; save(); if (re) world(); changed(); }; };
  on("#pl-tab", "table", "onchange", true); on("#pl-lay", "layout", "onchange", true); on("#pl-ent", "entity_col"); on("#pl-val", "value_col"); on("#pl-grp", "group_col");
  on("#pl-cols", "cols"); on("#pl-gtxt", "groups"); on("#pl-t0", "t0");
  const h = $("#pl-h"); h.oninput = () => { S.horizon = +h.value; $("#pl-hv").textContent = h.value; save(); }; h.onchange = changed;
  const lg = $("[data-lesson-g]"); if (lg) lg.onclick = (e) => { e.preventDefault(); tab("guide"); G.show(lg.dataset.lessonG); };
  implied();
}

// ---------------------------------------------------------------- rules
function rulesUI() {
  const byCat = (c) => S.rules.filter((r) => r.rule === c);
  $("#pl-rbody").innerHTML = CATS.map(([c, name, help, hk]) => {
    const rs = byCat(c);
    return `<div class="pl-rule ${S.on[c] ? "on" : ""}" data-c="${c}">
      <div class="pl-rh"><label class="toggle"><input type="checkbox" data-cat="${c}" ${S.on[c] ? "checked" : ""}><i></i></label><div><div class="nm">${esc(name)}${helpDot(hk)}</div><div class="sub">${esc(help)}</div></div></div>
      <div class="pl-rb">${rs.map((r) => r.type === "bool"
        ? `<div class="fld bool"><label title="${esc(r.help)}">${esc(r.label)}${helpDot(r.k)}</label><label class="toggle"><input type="checkbox" data-k="${r.k}" ${S.rv[r.k] ? "checked" : ""}><i></i></label></div>`
        : `<div class="fld pl-fld"><label title="${esc(r.help)}">${esc(r.label)} <span class="dim mono">${esc(r.k)}</span>${helpDot(r.k)}</label><input type="range" data-k="${r.k}" min="${r.min}" max="${r.max}" step="${(r.max - r.min) / 200}" value="${S.rv[r.k]}"><span class="v" data-v="${r.k}">${fmtv(S.rv[r.k])}</span>${r.fit ? `<label class="pl-fit" title="Learn this number from the window before the start"><input type="checkbox" data-fit="${r.k}" ${S.fit.has(r.k) ? "checked" : ""}> fit</label>` : ""}</div>`).join("")}
        ${c === "momentum" ? `<div class="hint pl-imply" id="pl-hl-kappa"></div>` : ""}</div></div>`;
  }).join("");
  $$("#pl-rbody [data-cat]").forEach((c) => c.onchange = () => {
    S.on[c.dataset.cat] = c.checked; c.closest(".pl-rule").classList.toggle("on", c.checked);
    // a rule switched on with its numbers at 0 would change nothing: learn them from the window before the start
    let fitted = false;
    if (c.checked) S.rules.forEach((r) => { if (r.rule === c.dataset.cat && r.fit && !+S.rv[r.k] && !S.fit.has(r.k)) { S.fit.add(r.k); fitted = true; } });
    save(); if (fitted) rulesUI(); changed();
  });
  $$("#pl-rbody input[type=range][data-k]").forEach((r) => {
    r.oninput = () => { S.rv[r.dataset.k] = +r.value; $(`[data-v="${r.dataset.k}"]`).textContent = fmtv(+r.value); implied(); save(); };
    r.onchange = changed;
  });
  $$("#pl-rbody input[type=checkbox][data-k]").forEach((r) => r.onchange = () => { S.rv[r.dataset.k] = r.checked; save(); changed(); });
  $$("#pl-rbody [data-fit]").forEach((r) => r.onchange = () => { if (r.checked) S.fit.add(r.dataset.fit); else S.fit.delete(r.dataset.fit); save(); changed(); });
  implied();
}
// the momentum numbers in plain words: how much of the excess growth starts, and how long it lasts
function implied() {
  const e = $("#pl-hl-kappa"); if (!e) return;
  const b = +S.rv.beta, k = +S.rv.kappa, unit = (srcOf() || {}).step || "step";
  const half = k > 0 ? Math.log(2) / -Math.log(1 - k) : Infinity;
  e.textContent = `Each body keeps ${Math.round(b * 100)}% of its extra growth at the start.${k > 0 ? ` Half of it is gone after ${half < 10 ? half.toFixed(1) : Math.round(half)} ${unit}s.` : " It never becomes smaller."}`;
}
const fmtv = (v) => typeof v === "boolean" ? (v ? "on" : "off") : Math.abs(v) >= 1 ? (+v).toFixed(2) : Math.abs(v) >= 0.01 ? (+v).toFixed(3) : (+v).toFixed(4);

function ruleParams() {
  const out = { ...S.rv };
  const off = { momentum: { beta: 0, kappa: 0 }, size: { alpha: 0 }, takeover: { G: 0 }, gravity: { Gx: 0 }, merge: { merge_r: 0 }, life: { drop: false, entrants: false, noise: false } };
  for (const [c, vals] of Object.entries(off)) if (!S.on[c]) Object.assign(out, vals);
  const fit = [...S.fit].filter((k) => { const r = S.rules.find((x) => x.k === k); return r && S.on[r.rule]; });
  return { rules: out, fit };
}
function srcParams() {
  const p = { source: S.src };
  if (S.src === "table") Object.assign(p, { table: S.table, layout: S.layout, cols: S.cols ? S.cols.split(",").map((s) => s.trim()).filter(Boolean) : [], entity_col: S.entity_col, value_col: S.value_col, group_col: S.group_col, groups: S.groups });
  return p;
}

// ---------------------------------------------------------------- run
let tChange = 0;
function changed() {
  S.stale = true; $("#pl-stale").hidden = false; $("#pl-stale").textContent = "settings changed";
  if (!S.auto) return;
  clearTimeout(tChange); tChange = setTimeout(() => run(), 700);
}
async function run(opts = {}) {
  if (S.busy) { S.again = true; return; }
  if (S.src === "table" && !S.table) { msg("Select a Data Desk table under World. Or load the example in the Guide (Your own data)."); return; }
  S.busy = true; S.stale = false; $("#pl-stale").hidden = true;
  const btn = $("#pl-go"); btn.disabled = true; $("#pl-mapp").classList.add("is-busy");
  const t0 = performance.now();
  try {
    const { rules, fit } = opts.rules ? { rules: opts.rules, fit: [] } : ruleParams();
    const src = srcOf();
    let t = opts.t0 || S.t0;
    if (t && src && src.dates) t = src.dates.find((d) => d.startsWith(t)) || t;
    const env = await callModel("particles.run", { ...srcParams(), t0: t, horizon: S.horizon, rules, fit, ens: 128 },
      { onStep: (j) => { $("#pl-time").textContent = j.message || "running…"; } });
    const keepPick = S.res && S.pick && env.result.bodies.some((b) => b.id === S.pick);
    S.res = env.result; S.err = ""; prep(S.res);
    if (!keepPick) S.pick = null;
    S.u = 0; S.playing = false;
    setTimeout(() => { if (S.res && !S.playing) play(); }, 400);     // show the change, from the start
    if (!S.res.real || !S.res.real[0]) S.layer = "sim";
    $("#pl-time").textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s click → screen · ${S.res.frames.length - 1} steps`;
    msg("");
    if (S.res.fitted) { Object.assign(S.rv, S.res.fitted.params); rulesUI(); }
    if (opts.fromWindow) $("#pl-time").textContent += ` · past-date window ${S.res.t0.slice(0, 7)}`;
    const vk = [S.src, S.table, S.res.t0, S.horizon].join("|");     // keep the zoom while only the rules change
    if (vk !== S.viewKey) { S.viewKey = vk; S.focus = null; fitView(); }
    verdict(); legend(); frameChanged(); scores(); bodies();
  } catch (e) {
    S.err = e.message; msg(e.message); $("#pl-time").textContent = "";
    $("#pl-hl").className = "hl bad"; $("#pl-hl").textContent = "—"; $("#pl-sent").textContent = e.message;
  }
  btn.disabled = false; $("#pl-mapp").classList.remove("is-busy"); S.busy = false;
  if (S.again) { S.again = false; run(); }
}
function msg(t) { const m = $("#pl-msg"); m.hidden = !t; m.textContent = t || ""; if (t) draw(); }

// derived per-result data: group shares per frame (simulated, real, start), the frame of reference, colours
function prep(r) {
  const nF = r.frames.length, gs = r.groups.map((g) => g.group);
  r.groups.forEach((g) => colorOf(g.group));
  const gi = Object.fromEntries(gs.map((g, i) => [g, i]));
  const bg = r.bodies.map((b) => gi[b.group]);
  const ent = r.entrants.map((e) => gi[e.group]);
  r.gSim = []; r.gReal = []; r.err = []; r.errP = [];
  const g0 = new Array(gs.length).fill(0); r.bodies.forEach((b, i) => { g0[bg[i]] += b.w0; });
  r.g0 = g0;
  for (let f = 0; f < nF; f++) {
    const s = new Array(gs.length).fill(0), F = r.frames[f];
    F.w.forEach((w, i) => { s[bg[i]] += w; });
    (F.ew || []).forEach((w, k) => { if (ent[k] != null) s[ent[k]] += w; });
    r.gSim.push(s);
    const R = r.real && r.real[f];
    if (R) {
      const q = gs.map((g) => R.g[g] || 0);
      r.gReal.push(q);
      const l1 = (a) => 0.5 * a.reduce((t, v, i) => t + Math.abs(v - q[i]), 0) + 0.5 * Object.entries(R.g).filter(([g]) => !(g in gi)).reduce((t, [, v]) => t + v, 0);
      r.err.push(l1(s)); r.errP.push(l1(g0));
    } else { r.gReal.push(null); r.err.push(null); r.errP.push(null); }
  }
  r.hasReal = !!(r.real && r.real[0]);
  r.lastReal = r.hasReal ? Math.max(...r.real.map((x, i) => x ? i : -1)) : -1;
  r.mw = Math.max(...r.bodies.map((b) => b.w0), 1e-9);
  r.bigShare = Math.max(1, ...r.frames.map((F) => Math.max(...F.w) / r.mw));      // the biggest disc ever drawn, relative to the start's
  // the frame of reference: every position in either layout, so nothing jumps when you switch
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
  const extent = (frames, extra) => {
    const xs = [], ys = [], add = (p) => { xs.push(p[0]); ys.push(p[1]); };
    frames.forEach((F) => F && F.x.forEach(add)); extra.forEach(add);
    const lo = xs.length > 400 ? 0.003 : 0, hi = 1 - lo;                // a few far outliers don't shrink a big map
    return [q(xs, lo), q(xs, hi), q(ys, lo), q(ys, hi)];
  };
  r.extStart = extent(r.frames, r.entrants.map((e) => e.x));
  r.extEvolved = r.hasReal ? extent(r.real, []) : r.extStart;
}

// ---------------------------------------------------------------- verdict, legend
function verdict() {
  const r = S.res, hl = $("#pl-hl");
  hl.textContent = r.headline; hl.className = "hl " + (r.check === "beats persistence" ? "good" : r.t1 ? "warn" : "");
  $("#pl-nm").textContent = `${r.what} · ${r.t0.slice(0, 7)} → ${r.t1 ? r.t1.slice(0, 7) : "+" + r.horizon + " " + r.step + "s"}`;
  $("#pl-sent").textContent = r.sentence;
  const f = [[r.layout === "co-movement" ? `${pct(r.purity, 0)}` : "ring", r.layout === "co-movement" ? `same-${r.group_name} neighbours` : "groups on a ring (short history)", "purity"],
    [pct(r.chance, 0), "chance", "purity"], [r.bodies.length, "bodies"], [r.entrants.length, "arrivals", "entrants"]];
  if (r.fitted) f.push([r.fitted.window.map((d) => d.slice(0, 7)).join(" → "), "fitted on", "loss"]);
  $("#pl-facts").innerHTML = f.map(([v, l, k]) => `<div class="stat" ${k ? `data-help="${k}" title="What does this mean?"` : ""}><div class="n">${esc(String(v))}</div><div class="l">${esc(l)}</div></div>`).join("");
}
function legend() {
  const r = S.res, el = $("#pl-legend");
  if (!r) { el.innerHTML = ""; return; }
  el.innerHTML = `${S.focus ? `<div class="pl-lg"><button class="on" data-g="${esc(S.focus)}" title="Show every group again"><b style="background:${colorOf(S.focus)}"></b>${esc(S.focus)} ✕</button></div>` : ""}
    <div class="pl-key"><span><i class="disc"></i>simulated</span>${r.hasReal ? `<span><i class="ring"></i>what happened</span><span>✕ left</span>` : ""}${r.entrants.length ? `<span><i class="dash"></i>arrival</span>` : ""}</div>`;
  $$("[data-g]", el).forEach((b) => b.onclick = () => { S.focus = S.focus === b.dataset.g ? null : b.dataset.g; if (S.focus) zoomToGroup(S.focus); else fitView(); legend(); draw(); });
}

// ---------------------------------------------------------------- the frame: positions and sizes at the scrubber
const lerp = (a, b, t) => a + (b - a) * t;
function at(u) {
  const r = S.res, nF = r.frames.length, i = Math.max(0, Math.min(nF - 1, Math.floor(u))), j = Math.min(nF - 1, i + 1), t = Math.min(1, Math.max(0, u - i));
  const A = r.frames[i], B = r.frames[j];
  const ws = A.w.map((w, k) => lerp(w, B.w[k], t));
  const ri = r.real && r.real[i], rj = r.real && (r.real[j] || ri);
  const wr = ri ? ri.w.map((w, k) => lerp(w, rj.w[k], t)) : null;
  let xs;
  if (S.maplay === "evolved" && r.hasReal) {
    const li = r.real[Math.min(i, r.lastReal)], lj = r.real[Math.min(j, r.lastReal)];
    xs = li.x.map((p, k) => [lerp(p[0], lj.x[k][0], t), lerp(p[1], lj.x[k][1], t)]);
  } else xs = A.x.map((p, k) => [lerp(p[0], B.x[k][0], t), lerp(p[1], B.x[k][1], t)]);
  const ew = (A.ew || []).map((w, k) => lerp(w, (B.ew || [])[k] ?? w, t));
  return { i: t > 0.5 ? j : i, ws, wr, xs, ew, lo: (t > 0.5 ? B : A).lo, hi: (t > 0.5 ? B : A).hi };
}

// ---------------------------------------------------------------- map: zoom, pan, pick
let geo = null, base = null;
function baseXf(W, H) {
  const [x0, x1, y0, y1] = S.maplay === "evolved" && S.res.hasReal ? S.res.extEvolved : S.res.extStart;
  const pad = Math.max(34, Math.min(W, H) * 0.085 * Math.sqrt(S.res.bigShare) + 10);   // room for the biggest disc at the edge
  const s = Math.min((W - 2 * pad) / (x1 - x0 || 1), (H - 2 * pad) / (y1 - y0 || 1));
  const ox = (W - (x1 - x0) * s) / 2 - x0 * s, oy = (H - (y1 - y0) * s) / 2 - y0 * s;
  return { s, ox, oy };
}
function fitView(soft) { if (soft && S.focus) return; S.view = { k: 1, ox: 0, oy: 0 }; }
function zoomBy(f, mx, my) {
  const st = $("#pl-stage"); mx = mx ?? st.clientWidth / 2; my = my ?? st.clientHeight / 2;
  const v = S.view, k2 = Math.max(0.6, Math.min(60, v.k * f)), g = k2 / v.k;
  S.view = { k: k2, ox: mx - (mx - v.ox) * g, oy: my - (my - v.oy) * g }; draw();
}
function zoomToGroup(gname) {
  const r = S.res, st = $("#pl-stage"), W = st.clientWidth, H = st.clientHeight, b = baseXf(W, H), F = at(S.u);
  const pts = r.bodies.map((x, i) => [x, F.xs[i]]).filter(([x]) => x.group === gname).map(([, p]) => [p[0] * b.s + b.ox, p[1] * b.s + b.oy]);
  if (!pts.length) return;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const k = Math.max(1, Math.min(12, 0.75 * Math.min(W / Math.max(40, x1 - x0), H / Math.max(40, y1 - y0))));
  S.view = { k, ox: W / 2 - k * (x0 + x1) / 2, oy: H / 2 - k * (y0 + y1) / 2 };
}
function mapInput(cv) {
  let drag = null;
  cv.addEventListener("wheel", (e) => { if (!S.res) return; e.preventDefault(); const b = cv.getBoundingClientRect(); zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - b.left, e.clientY - b.top); }, { passive: false });
  cv.addEventListener("pointerdown", (e) => { if (!S.res) return; cv.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, ox: S.view.ox, oy: S.view.oy, moved: false }; });
  cv.addEventListener("pointermove", (e) => {
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.moved) { S.view.ox = drag.ox + dx; S.view.oy = drag.oy + dy; $("#pl-tip").hidden = true; draw(); return; }
    }
    hover(e);
  });
  cv.addEventListener("pointerup", (e) => {
    const d = drag; drag = null;
    if (d && !d.moved) { if (S.hover >= 0) { S.pick = S.res.bodies[S.hover].id; tab("bodies"); } else if (S.pick) { S.pick = null; bodies(); } draw(); }
  });
  cv.addEventListener("pointerleave", () => { if (!drag) { S.hover = -1; $("#pl-tip").hidden = true; draw(); } });
  cv.addEventListener("dblclick", (e) => { const b = cv.getBoundingClientRect(); zoomBy(2, e.clientX - b.left, e.clientY - b.top); });
  cv.addEventListener("keydown", (e) => {
    if (!S.res) return;
    if (e.key === " ") { e.preventDefault(); play(); }
    else if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); S.playing = false; S.u = Math.max(0, Math.min(S.res.frames.length - 1, Math.round(S.u) + (e.key === "ArrowRight" ? 1 : -1))); frameChanged(); }
    else if (e.key === "+" || e.key === "=") zoomBy(1.4); else if (e.key === "-") zoomBy(1 / 1.4); else if (e.key === "0") { fitView(); draw(); }
  });
}
function growthColor(ratio) {               // log share ratio → red (shrank) · grey · green (grew)
  const t = Math.max(-1, Math.min(1, ratio / Math.log(2)));
  const a = [138, 139, 147], g = [47, 211, 138], r = [255, 59, 48], c = t >= 0 ? g : r, s = Math.abs(t);
  return `rgb(${a.map((v, i) => Math.round(v + (c[i] - v) * s)).join(",")})`;
}
function draw() {
  const cv = $("#pl-map"), st = $("#pl-stage"); if (!cv || !st || !st.clientWidth) return;
  const dpr = window.devicePixelRatio || 1, W = st.clientWidth, H = st.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px"; }
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const r = S.res;
  $$("#pl-layer [data-v]").forEach((b) => { b.disabled = b.dataset.v !== "sim" && !(r && r.hasReal); b.classList.toggle("on", b.dataset.v === S.layer); });
  $$("#pl-maplay [data-v]").forEach((b) => { b.disabled = b.dataset.v === "evolved" && !(r && r.hasReal && r.layout === "co-movement"); b.classList.toggle("on", b.dataset.v === S.maplay); });
  if (!r) { geo = null; return; }
  const F = at(S.u), b = baseXf(W, H), v = S.view, zr = Math.sqrt(v.k);
  const px = (p) => [(p[0] * b.s + b.ox) * v.k + v.ox, (p[1] * b.s + b.oy) * v.k + v.oy];
  const R0 = Math.min(W, H) * 0.085, rad = (w) => w > 0 ? Math.max(1.6, R0 * Math.sqrt(w / r.mw) * zr) : 0;
  const layer = r.hasReal && F.wr ? S.layer : "sim";        // past the end of the data only the simulation exists
  const wMain = layer === "real" ? F.wr : F.ws;
  const pts = F.xs.map(px), rs = wMain.map(rad);
  geo = { pts, rs };
  const order = wMain.map((w, i) => i).sort((a, c) => wMain[c] - wMain[a]);
  const dimOf = (i) => S.focus && r.bodies[i].group !== S.focus;
  // arrivals so far (simulated): dashed rings by group
  if (layer !== "real" && F.ew.length) {
    g.setLineDash([3, 3]);
    F.ew.forEach((w, k) => { const e = r.entrants[k]; if (!e || (S.focus && e.group !== S.focus)) return; const [x, y] = px(e.x); g.strokeStyle = colorOf(e.group); g.globalAlpha = 0.75; g.beginPath(); g.arc(x, y, rad(w), 0, 7); g.stroke(); });
    g.setLineDash([]);
  }
  for (const i of order) {
    const bd = r.bodies[i], [x, y] = pts[i], rr = rs[i], dim = dimOf(i);
    const w0 = bd.w0, wl = wMain[i];
    const fillC = S.colour === "growth" ? growthColor(Math.log(Math.max(wl, 1e-12) / w0)) : colorOf(bd.group);
    if (!rr) {                                             // gone in this layer
      g.globalAlpha = dim ? 0.12 : 0.45; g.strokeStyle = "#c8c9ce"; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x - 3, y - 3); g.lineTo(x + 3, y + 3); g.moveTo(x + 3, y - 3); g.lineTo(x - 3, y + 3); g.stroke();
    } else {
      g.globalAlpha = dim ? 0.1 : i === S.hover || bd.id === S.pick ? 0.95 : 0.6;
      g.fillStyle = fillC; g.beginPath(); g.arc(x, y, rr, 0, 7); g.fill();
    }
    if (layer === "both" && F.wr) {                      // the real share as a ring around the same body
      const r2 = rad(F.wr[i]);
      g.globalAlpha = dim ? 0.1 : 0.85; g.lineWidth = 1.25; g.strokeStyle = "#f2f2f5";
      if (r2) { g.beginPath(); g.arc(x, y, r2, 0, 7); g.stroke(); }
      else if (rr) { g.beginPath(); g.moveTo(x - rr * 0.7, y - rr * 0.7); g.lineTo(x + rr * 0.7, y + rr * 0.7); g.moveTo(x + rr * 0.7, y - rr * 0.7); g.lineTo(x - rr * 0.7, y + rr * 0.7); g.stroke(); }
    }
    if (bd.id === S.pick) { g.globalAlpha = 1; g.strokeStyle = "#ffd300"; g.lineWidth = 2; g.beginPath(); g.arc(x, y, Math.max(rr, rad(F.wr ? F.wr[i] : 0)) + 4, 0, 7); g.stroke(); }
    g.lineWidth = 1;
  }
  // labels: biggest first, skipped where they would collide
  g.globalAlpha = 1; g.textAlign = "center"; g.textBaseline = "middle";
  const boxes = [], lab = (i) => { const b2 = r.bodies[i]; return rs[i] > 26 && b2.name.length < 22 && b2.name !== b2.id ? b2.name : b2.id; };
  let n = 0;
  for (const i of order) {
    if (n > 80) break;
    const rr = Math.max(rs[i], 0), bd = r.bodies[i];
    if ((rr < 8 && bd.id !== S.pick && i !== S.hover) || dimOf(i)) continue;
    const t = lab(i); g.font = `600 ${rr > 26 ? 12 : 11}px Inter, sans-serif`;
    const w = g.measureText(t).width + 6, [x, y] = pts[i], ly = rr >= 14 ? y : y - rr - 8;
    const bx = [x - w / 2, ly - 7, x + w / 2, ly + 7];
    if (boxes.some((q) => bx[0] < q[2] && bx[2] > q[0] && bx[1] < q[3] && bx[3] > q[1])) continue;
    boxes.push(bx); n++;
    g.fillStyle = rr >= 14 ? "#fff" : "#d6d7dc"; g.shadowColor = "rgba(0,0,0,.8)"; g.shadowBlur = 3; g.fillText(t, x, ly); g.shadowBlur = 0;
  }
  const date = (r.frame_dates[F.i] || "").slice(0, r.step === "year" ? 4 : 7);
  $("#pl-fr").textContent = `${date} · step ${F.i} of ${r.frames.length - 1}${F.i > r.lastReal && r.hasReal ? " · past the data" : ""}`;
  $("#pl-mmeta").textContent = `size = share of ${r.what} · ${S.maplay === "evolved" ? "map as co-movement evolved" : "map = co-movement before the start"}${v.k > 1.05 ? ` · ×${v.k.toFixed(1)}` : ""}`;
}
function hover(e) {
  if (!geo || !S.res) return;
  const b = e.currentTarget.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
  let best = -1, bd = 1e9;
  geo.pts.forEach(([px, py], i) => { const d = Math.hypot(px - x, py - y) - Math.max(geo.rs[i], 3); if (d < bd && d < 6) { bd = d; best = i; } });
  if (best !== S.hover) { S.hover = best; draw(); }
  const tip = $("#pl-tip");
  if (best < 0) { tip.hidden = true; return; }
  const q = S.res.bodies[best], F = at(S.u), real = F.wr ? F.wr[best] : null;
  tip.hidden = false; tip.style.left = Math.min(x + 14, b.width - 250) + "px"; tip.style.top = Math.min(y + 14, b.height - 110) + "px";
  tip.innerHTML = `<b>${esc(q.name)}</b> <span class="dim">${esc(q.id)} · ${esc(q.group)}</span>
    <div class="kv"><span>start</span><b>${pct(q.w0, 2)}</b><span>simulated</span><b class="red">${pct(F.ws[best], 2)}</b><span class="dim">${pct(F.lo[best], 2)}–${pct(F.hi[best], 2)}</span>
    ${real != null ? `<span>really</span><b class="blue">${real > 0 ? pct(real, 2) : "left"}</b><span></span>` : ""}</div><div class="dim">click to follow it</div>`;
}

// ---------------------------------------------------------------- time
function frameChanged() {
  const r = S.res; if (!r) return;
  const sc = $("#pl-scrub"); sc.max = r.frames.length - 1; sc.value = S.u;
  sc.style.setProperty("--real", r.hasReal ? `${(Math.max(0, r.lastReal) / Math.max(1, r.frames.length - 1)) * 100}%` : "0%");
  draw(); groups(); errChart(); bodyChart(); bodyNums();
}
function play() {
  const r = S.res; if (!r) return;
  if (S.playing) { S.playing = false; $("#pl-play").innerHTML = icon("play"); return; }
  if (S.u >= r.frames.length - 1.001) S.u = 0;
  S.playing = true; $("#pl-play").innerHTML = icon("pause");
  const sps = Math.max(1.5, Math.min(12, (r.frames.length - 1) / 8));       // a whole run plays in about 8 seconds
  let last = performance.now();
  const tick = (now) => {
    if (!S.playing || S.res !== r) { $("#pl-play").innerHTML = icon("play"); return; }
    S.u = Math.min(r.frames.length - 1, S.u + (now - last) / 1000 * sps); last = now;
    frameChanged();
    if (S.u >= r.frames.length - 1) { S.playing = false; $("#pl-play").innerHTML = icon("play"); return; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- groups: shares at the scrubber, and their paths
function groups() {
  const r = S.res; if (!r) return;
  $("#pl-gt").textContent = r.group_name.charAt(0).toUpperCase() + r.group_name.slice(1) + "s";
  const fi = Math.round(S.u), gs = r.groups.slice(0, 12), sim = r.gSim[fi], real = r.gReal[fi];
  const mx = Math.max(...gs.map((g, k) => Math.max(r.g0[k], ...r.gSim.map((s) => s[k]), ...r.gReal.filter(Boolean).map((s) => s[k]))), 1e-9);
  const bar = (v, cls) => `<i class="${cls}" style="width:${(100 * v / mx).toFixed(1)}%"></i>`;
  const box = $("#pl-groups");
  if (box.dataset.for !== r.t0 + r.what + r.frames.length) {
    box.dataset.for = r.t0 + r.what + r.frames.length;
    box.innerHTML = `<div class="pl-glist">${gs.map((g, k) => `<div class="pl-g ${S.focus === g.group ? "on" : ""}" data-gk="${k}"><span class="nm" title="${esc(g.group)}"><b style="background:${colorOf(g.group)}"></b>${esc(g.group)}</span>
      <span class="bars" id="pl-gb${k}"></span><canvas class="spark" id="pl-gs${k}"></canvas><span class="v" id="pl-gv${k}"></span></div>`).join("")}</div>
      <div class="pl-leg"><span><i class="a"></i>start</span><span><i class="b"></i>simulated</span>${r.hasReal ? '<span><i class="c"></i>what happened</span><span class="dim">· a green number = the simulation is closer to what happened than “nothing changes” is</span>' : ""}</div>`;
    $$("#pl-groups [data-gk]").forEach((e) => e.onclick = () => { const gname = gs[+e.dataset.gk].group; S.focus = S.focus === gname ? null : gname; if (S.focus) zoomToGroup(S.focus); else fitView(); legend(); draw(); groupsFocus(); });
  }
  gs.forEach((g, k) => {
    $("#pl-gb" + k).innerHTML = bar(r.g0[k], "a") + bar(sim[k], "b") + (real ? bar(real[k], "c") : "");
    $("#pl-gv" + k).innerHTML = `${pct(r.g0[k])} → <b>${pct(sim[k])}</b>${real ? ` · <span class="${Math.abs(sim[k] - real[k]) < Math.abs(r.g0[k] - real[k]) ? "good" : "bad"}">${pct(real[k])}</span>` : ""}`;
    spark($("#pl-gs" + k), r.gSim.map((s) => s[k]), r.gReal.map((s) => s ? s[k] : null), fi, r.g0[k]);
  });
  groupsFocus();
}
function groupsFocus() { $$("#pl-groups [data-gk]").forEach((e) => e.classList.toggle("on", S.res && S.res.groups[+e.dataset.gk] && S.res.groups[+e.dataset.gk].group === S.focus)); }
// a tiny two-line chart over the run's steps: simulated (red), real (blue), the start level (grey), the scrubber (white)
function spark(cv, a, b, cur, ref, band) {
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight; if (!W || !H) return;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const vals = [...a, ...b.filter((v) => v != null), ref, ...(band ? [...band[0], ...band[1]] : [])].filter((v) => v != null && isFinite(v));
  let lo = Math.min(...vals), hi = Math.max(...vals); if (hi - lo < 1e-12) { hi += 1e-6; lo -= 1e-6; }
  const pad = 3, n = a.length, X = (i) => pad + (n > 1 ? i / (n - 1) : 0) * (W - 2 * pad), Y = (v) => H - pad - (v - lo) / (hi - lo) * (H - 2 * pad);
  g.strokeStyle = "rgba(255,255,255,.18)"; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(pad, Y(ref)); g.lineTo(W - pad, Y(ref)); g.stroke(); g.setLineDash([]);
  if (band) { g.fillStyle = "rgba(255,42,26,.16)"; g.beginPath(); band[1].forEach((v, i) => i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))); for (let i = n - 1; i >= 0; i--) g.lineTo(X(i), Y(band[0][i])); g.closePath(); g.fill(); }
  const line = (arr, c) => { g.strokeStyle = c; g.lineWidth = 1.5; g.beginPath(); let on = false; arr.forEach((v, i) => { if (v == null) { on = false; return; } if (on) g.lineTo(X(i), Y(v)); else { g.moveTo(X(i), Y(v)); on = true; } }); g.stroke(); };
  line(b, REAL); line(a, SIM);
  g.strokeStyle = "rgba(255,255,255,.6)"; g.lineWidth = 1; g.beginPath(); g.moveTo(X(cur), 0); g.lineTo(X(cur), H); g.stroke();
}

// ---------------------------------------------------------------- score tab
function scores() {
  const r = S.res, el = $("#pl-score");
  if (S.tab !== "score") return;
  if (!r) { el.innerHTML = `<div class="hint">${S.err ? esc(S.err) : "Run a world. Then the tool scores it."}</div>`; return; }
  let html = "";
  if (r.scores) {
    const rows = [["rules", "Your rules", ""], ["no interactions", "No interactions", "nointeract"], ["persistence", "Nothing changes", "persistence"]];
    const best = (k, lower) => { const v = rows.map(([id]) => r.scores[id][k]).filter((x) => x != null); return lower ? Math.min(...v) : Math.max(...v); };
    const cell = (id, k, f, lower) => { const v = r.scores[id][k]; return `<td class="${v != null && v === best(k, lower) ? "best" : ""}">${v == null ? "—" : f(v)}</td>`; };
    html += `<div class="sec-t">At the end · ${esc(r.t1.slice(0, 7))}</div><table class="tbl pl-tbl"><thead><tr><th></th><th>Wrong ${esc(r.group_name)}${helpDot("sector_l1")}</th><th>Who grew${helpDot("rank_rho")}</th><th>Who left${helpDot("leave_auc")}</th><th>Top 10${helpDot("top10")}</th></tr></thead><tbody>
      ${rows.map(([id, nm, hk]) => `<tr><th>${nm}${hk ? helpDot(hk) : ""}</th>${cell(id, "sector_l1", (v) => pct(v), true)}${cell(id, "rank_rho", (v) => (v >= 0 ? "+" : "") + v.toFixed(2))}${cell(id, "leave_auc", (v) => v.toFixed(2))}${cell(id, "top10_hit", (v) => v + "/10")}</tr>`).join("")}</tbody></table>
      <div class="hint" style="margin-top:8px">Top-10 share of the whole: simulated <b>${pct(r.scores.rules.top10_share_pred)}</b>, really <b>${pct(r.scores.rules.top10_share_actual)}</b>. Newcomers (not in the start picture) ended with <b>${pct(r.actual.new_share)}</b>.</div>`;
  } else html += `<div class="hint">This run ends after the data. Thus there is nothing to compare it with. To check it, start earlier.</div>`;
  if (r.hasReal) html += `<div class="sec-t" style="margin-top:14px">Wrong ${esc(r.group_name)}, step by step</div><div class="pl-errc"><canvas id="pl-errc"></canvas></div>
    <div class="pl-leg"><span><i class="b"></i>your rules</span><span><i class="a"></i>nothing changes</span><span class="dim">lower is better · white line = the scrubber</span></div>`;
  html += S.bt ? btHtml(S.bt) : `<div class="sec-t" style="margin-top:14px">Past dates</div><div class="hint">One window can be luck. <a href="#" id="pl-bt2">Test on past dates</a> fits and scores the rules at some past start dates.</div>`;
  el.innerHTML = html;
  const b2 = $("#pl-bt2"); if (b2) b2.onclick = (e) => { e.preventDefault(); backtest(); };
  $$("#pl-score [data-win]").forEach((tr) => tr.onclick = () => loadWindow(+tr.dataset.win));
  errChart();
}
function errChart() {
  const r = S.res, cv = $("#pl-errc"); if (!r || !cv || !r.hasReal) return;
  const a = r.err, b = r.errP, cur = Math.round(S.u);
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight; if (!W) return;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const v = [...a, ...b].filter((x) => x != null), hi = Math.max(...v, 0.01) * 1.1, n = a.length, pl = 34, pb = 16;
  const X = (i) => pl + i / Math.max(1, n - 1) * (W - pl - 6), Y = (y) => 6 + (1 - y / hi) * (H - 6 - pb);
  g.font = "10px 'JetBrains Mono', monospace"; g.fillStyle = "#6b6b76"; g.textAlign = "right"; g.textBaseline = "middle";
  [0, hi / 2, hi].forEach((t) => { g.fillText(pct(t, 0), pl - 4, Y(t)); g.strokeStyle = "rgba(255,255,255,.05)"; g.beginPath(); g.moveTo(pl, Y(t)); g.lineTo(W - 6, Y(t)); g.stroke(); });
  g.textAlign = "left"; g.fillText((r.frame_dates[0] || "").slice(0, 7), pl, H - 6); g.textAlign = "right"; g.fillText((r.frame_dates[r.lastReal] || "").slice(0, 7), X(r.lastReal), H - 6);
  const line = (arr, c, w) => { g.strokeStyle = c; g.lineWidth = w; g.beginPath(); let on = false; arr.forEach((y, i) => { if (y == null) return; if (on) g.lineTo(X(i), Y(y)); else { g.moveTo(X(i), Y(y)); on = true; } }); g.stroke(); };
  g.setLineDash([4, 3]); line(b, "#c8c9ce", 1.4); g.setLineDash([]); line(a, SIM, 1.8);
  g.strokeStyle = "rgba(255,255,255,.7)"; g.lineWidth = 1; g.beginPath(); g.moveTo(X(cur), 4); g.lineTo(X(cur), H - pb); g.stroke();
}

// ---------------------------------------------------------------- backtest
async function backtest() {
  const btn = $("#pl-bt"); btn.disabled = true;
  const t0 = performance.now();
  tab("score");
  $("#pl-score").insertAdjacentHTML("beforeend", `<div class="hint is-busy" id="pl-btwait" style="margin-top:12px">The tool tests the rules on past dates. It fits them at each start date…</div>`);
  try {
    const { rules, fit } = ruleParams();
    const env = await callModel("particles.backtest", { ...srcParams(), horizon: S.horizon, starts: 5, rules, fit: fit.length ? fit : ["beta", "kappa", "alpha", "G"] },
      { onStep: (j) => { $("#pl-time").textContent = j.message || "the test runs…"; const w = $("#pl-btwait"); if (w) w.textContent = j.message || "the test runs…"; } });
    S.bt = { ...env.result, rules };
    $("#pl-time").textContent = `test on past dates: ${((performance.now() - t0) / 1000).toFixed(0)} s · click a window to load it`;
    scores();
    if (!S.res) loadWindow(S.bt.windows.length - 1);
  } catch (e) { fail(e); $("#pl-time").textContent = e.message; const w = $("#pl-btwait"); if (w) w.remove(); }
  btn.disabled = false;
}
// one of the history windows, on the map: its start date and the rules as fitted there (fitted only on the past)
function loadWindow(k) {
  const w = S.bt && S.bt.windows[k]; if (!w) return;
  const src = srcOf();
  S.t0 = w.t0.slice(0, src && src.step === "year" ? 4 : 7);
  const rules = { ...S.bt.rules, ...w.fit };
  Object.assign(S.rv, w.fit); save(); world(); rulesUI();
  run({ t0: w.t0, rules, fromWindow: true });
}
function btHtml(b) {
  const w = b.windows, m = b.summary.mean;
  const f = (x) => x == null || x !== x ? "—" : typeof x === "number" ? (x >= 0 ? "+" : "") + x.toFixed(2) : x;
  return `<div class="sec-t" style="margin-top:16px">Past dates <span class="x">${b.summary.windows} windows · fitted: ${esc(b.fit_rules.join(", "))}</span></div>
    <p class="pl-btv">${esc(b.sentence)}</p>
    <table class="tbl pl-tbl pl-bt"><thead><tr><th>Window</th><th>Wrong ${esc(b.group_name)}<br><span class="dim">rules · none · momentum</span></th><th>Who grew<br><span class="dim">rules · momentum</span></th></tr></thead><tbody>
    ${w.map((x, k) => `<tr data-win="${k}" class="${S.res && S.res.t0 === x.t0 ? "on" : ""}" title="Load this window into the map, with the rules that the tool fitted there"><th>${x.t0.slice(0, 7)} → ${x.t1.slice(0, 7)}</th><td><b class="${x.rows.rules.sector_l1 < x.rows.persistence.sector_l1 ? "good" : "bad"}">${pct(x.rows.rules.sector_l1)}</b> · ${pct(x.rows.persistence.sector_l1)} · ${pct(x.rows.momentum.sector_l1)}</td>
      <td><b class="${(x.rows.rules.rank_rho || 0) > (x.rows.momentum.rank_rho || 0) ? "good" : "bad"}">${f(x.rows.rules.rank_rho)}</b> · ${f(x.rows.momentum.rank_rho)}</td></tr>`).join("")}
    <tr class="mean"><th>Mean</th><td>${pct(m.rules.sector_l1)} · ${pct(m.persistence.sector_l1)} · ${pct(m.momentum.sector_l1)}</td><td>${f(m.rules.rank_rho)} · ${f(m.momentum.rank_rho)}</td></tr></tbody></table>
    <div class="hint" style="margin-top:6px">Fitted per window: ${w.map((x) => `${x.t0.slice(0, 4)}: ${Object.entries(x.fit).filter(([k]) => b.fit_rules.includes(k)).map(([k, v]) => `${k} ${(+v).toFixed(3)}`).join(", ")}`).join(" · ")}. Click a row to load it.</div>`;
}

// ---------------------------------------------------------------- bodies tab
function bodies() {
  const el = $("#pl-bodies"), r = S.res;
  if (S.tab !== "bodies") return;
  if (!r) { el.innerHTML = '<div class="empty">Run a world. Then the bodies show here.</div>'; return; }
  const pi = S.pick ? r.bodies.findIndex((b) => b.id === S.pick) : -1;
  const rows = r.bodies.map((b, i) => ({ ...b, i, chg: (b.w1 != null ? b.w1 : b.w) - b.w0, schg: b.w - b.w0 }));
  const by = { gain: (a, b) => b.schg - a.schg, loss: (a, b) => a.schg - b.schg, big: (a, b) => b.w - a.w, rgain: (a, b) => b.chg - a.chg, miss: (a, b) => Math.abs(b.w - (b.w1 ?? b.w)) - Math.abs(a.w - (a.w1 ?? a.w)) }[S.sort] || ((a, b) => b.w - a.w);
  rows.sort(by);
  el.innerHTML = `${pi >= 0 ? `<div class="pl-det" id="pl-det"></div>` : `<div class="hint pl-pickhint">To follow a body through the run, click it on the map or below.</div>`}
    <div class="pl-sorts"><div class="seg xs" id="pl-sort">${[["gain", "Simulated gainers"], ["loss", "losers"], ["big", "biggest"], ...(r.hasReal ? [["rgain", "real gainers"], ["miss", "biggest misses"]] : [])].map(([k, l]) => `<button data-s="${k}" class="${S.sort === k ? "on" : ""}">${l}</button>`).join("")}</div></div>
    <div class="list">${rows.slice(0, 80).map((b) => `<div class="li pl-b ${b.id === S.pick ? "on" : ""}" data-i="${b.i}">
    <b class="dot" style="background:${colorOf(b.group)}"></b><div class="tx"><div class="nm">${esc(b.name)} <span class="dim">${esc(b.id)}</span></div>
    <div class="sub">${pct(b.w0, 2)} → <b class="red">${pct(b.w, 2)}</b> <span class="dim">(${pct(b.p10, 2)}–${pct(b.p90, 2)})</span>${b.w1 != null ? ` · really ${b.left ? '<span class="bad">left</span>' : `<b class="blue">${pct(b.w1, 2)}</b>`}` : ""}${b.p_leave > 0.05 ? ` · ${pct(b.p_leave, 0)} drop` : ""}</div></div></div>`).join("")}</div>`;
  $$("#pl-sort [data-s]").forEach((x) => x.onclick = () => { S.sort = x.dataset.s; bodies(); });
  $$("#pl-bodies [data-i]").forEach((e) => e.onclick = () => { S.pick = r.bodies[+e.dataset.i].id; centreOn(+e.dataset.i); bodies(); draw(); });
  if (pi >= 0) detail(pi);
}
function centreOn(i) {
  const st = $("#pl-stage"), W = st.clientWidth, H = st.clientHeight, b = baseXf(W, H), p = at(S.u).xs[i];
  const k = Math.max(S.view.k, 2.5), sx = p[0] * b.s + b.ox, sy = p[1] * b.s + b.oy;
  S.view = { k, ox: W / 2 - k * sx, oy: H / 2 - k * sy };
}
function detail(i) {
  const r = S.res, b = r.bodies[i];
  $("#pl-det").innerHTML = `<div class="pl-dh"><b style="background:${colorOf(b.group)}"></b><div><div class="nm">${esc(b.name)}</div><div class="dim">${esc(b.id)} · ${esc(b.group)}</div></div>
      <button class="iconbtn" id="pl-unpick" title="Stop following">${icon("x")}</button></div>
    <div class="pl-detc"><canvas id="pl-bc"></canvas></div>
    <div class="pl-leg"><span><i class="b"></i>simulated (p10–p90 shaded)</span>${r.hasReal ? '<span><i class="c"></i>what happened</span>' : ""}</div>
    <div class="kv pl-dkv" id="pl-dkv"></div>`;
  $("#pl-unpick").onclick = () => { S.pick = null; bodies(); draw(); };
  bodyChart(); bodyNums();
}
function bodyChart() {
  const r = S.res, cv = $("#pl-bc"); if (!r || !cv || !S.pick) return;
  const i = r.bodies.findIndex((b) => b.id === S.pick); if (i < 0) return;
  spark(cv, r.frames.map((F) => F.w[i]), (r.real || []).map((R) => R ? R.w[i] : null), Math.round(S.u), r.bodies[i].w0,
    [r.frames.map((F) => F.lo[i]), r.frames.map((F) => F.hi[i])]);
}
function bodyNums() {
  const r = S.res, el = $("#pl-dkv"); if (!r || !el || !S.pick) return;
  const i = r.bodies.findIndex((b) => b.id === S.pick); if (i < 0) return;
  const f = Math.round(S.u), F = r.frames[f], R = r.real && r.real[f], b = r.bodies[i];
  el.innerHTML = `<span>at</span><b>${esc((r.frame_dates[f] || "").slice(0, 7))}</b><span>start</span><b>${pct(b.w0, 2)}</b>
    <span>simulated</span><b class="red">${pct(F.w[i], 2)} <span class="dim">${pct(F.lo[i], 2)}–${pct(F.hi[i], 2)}</span></b>
    ${R ? `<span>really</span><b class="blue">${R.w[i] > 0 ? pct(R.w[i], 2) : "left"}</b>` : ""}
    <span>chance it drops</span><b>${pct(b.p_leave, 0)}</b>`;
}

// ---------------------------------------------------------------- guide actions
async function guideAct(act, args) {
  if (act === "world") { if (S.src !== args) { $(`#pl-wbody [data-src="${args}"]`).click(); if (!S.auto) run(); } else run(); }
  else if (act === "layer") { S.layer = args; save(); seg("#pl-layer", "layer", () => draw()); draw(); }
  else if (act === "layout") { S.maplay = args; save(); seg("#pl-maplay", "maplay", () => { fitView(); draw(); }); draw(); }
  else if (act === "play") { if (S.res) { S.u = 0; S.playing = false; play(); } }
  else if (act === "tab") tab(args);
  else if (act === "backtest") backtest();
  else if (act === "sample") {
    try {
      const smp = sampleTable(), NAME = "Particle example (made-up numbers)";
      S.tables = await api.get("/tables").catch(() => S.tables);
      let t = S.tables.find((x) => x.name.startsWith(NAME));           // one copy, however often the button is pressed
      if (!t) { t = await api.post("/tables/paste", { name: NAME, text: smp.csv }); S.tables = await api.get("/tables").catch(() => S.tables); }
      Object.assign(S, { src: "table", table: t.id, layout: "wide", cols: "", groups: smp.groups, t0: "", horizon: 12, res: null, bt: null, pick: null, focus: null });
      grpColor = {}; save(); world(); run();
    } catch (e) { fail(e); }
  }
}
