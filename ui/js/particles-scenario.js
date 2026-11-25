// Particle Lab: the scenario builder. A target (a country, a region or sector, or everyone), a list of changes over
// the years ahead, and the joint futures of every member against the baseline on the same random numbers.
// Scenarios are named, saved in this browser, forked by saving under a new name, and carried in the page link.
import { $, $$, esc, fail, icon, toast } from "./core.js";
import { callModel } from "./hub.js";

const KEY = "vf.pl.scen";
const KINDS = {
  growth: { t: "Growth shift", unit: "points a year", def: -1, to: (v) => v / 100, from: (v) => v * 100, step: 0.25, hint: "−1 = one point a year slower" },
  shock: { t: "One-time shock", unit: "% of the level", def: -6, to: (v) => v / 100, from: (v) => v * 100, step: 0.5, hint: "−6 ≈ a banking crisis (Cerra & Saxena)" },
  vol: { t: "Volatility ×", unit: "×", def: 1.2, to: (v) => v, from: (v) => v, step: 0.05, hint: "1.2 = 20% more volatile" },
  stability: { t: "Stability", unit: "%", def: 10, to: (v) => v / 100, from: (v) => v * 100, step: 5, hint: "+10 = spells last 10% longer" },
};
const PRESETS = {
  countries: [
    { name: "China slows sharply", target: "group:East Asia & Pacific", changes: [{ target: "CHN", kind: "shock", from: 2, value: -0.08, spill: 0.25 }, { target: "CHN", kind: "growth", from: 2, to: 10, value: -0.015, spill: 0.2 }] },
    { name: "India's reforms add a point", target: "group:South Asia", changes: [{ target: "IND", kind: "growth", from: 1, to: 10, value: 0.01, spill: 0.1 }] },
    { name: "A world recession next year", target: "all", changes: [{ target: "all", kind: "shock", from: 1, value: -0.03 }, { target: "all", kind: "vol", from: 1, to: 3, value: 1.3 }] },
    { name: "A calmer decade for Africa", target: "group:Sub-Saharan Africa", changes: [{ target: "group:Sub-Saharan Africa", kind: "stability", from: 1, to: 10, value: 0.15 }, { target: "group:Sub-Saharan Africa", kind: "vol", from: 1, to: 10, value: 0.85 }] },
  ],
  companies: [
    { name: "AI spending cools", target: "group:Information Technology", changes: [{ target: "group:Information Technology", kind: "growth", from: 1, to: 24, value: -0.01 }] },
    { name: "A rate shock hits utilities and real estate", target: "all", changes: [{ target: "group:Utilities", kind: "shock", from: 3, value: -0.08 }, { target: "group:Real Estate", kind: "shock", from: 3, value: -0.1 }] },
  ],
};
const S = { el: null, world: null, groups: [], bodies: [], target: "all", changes: [], horizon: 0, r: null, t: 0, name: "" };

export function openScenario(host, world, groups, bodies, init = {}) {
  Object.assign(S, { world, groups, bodies, target: init.target || "all", changes: init.changes || [], horizon: init.horizon || (world === "countries" ? 10 : 36), name: init.name || "", r: null });
  let el = $("#pl-scen", host);
  if (!el) { host.insertAdjacentHTML("beforeend", '<div class="pl-fut pl-scen" id="pl-scen"></div>'); el = $("#pl-scen", host); }
  S.el = el; el.hidden = false;
  const y = world === "countries", nm = (id) => (bodies.find((b) => b.id === id) || {}).name || id;
  S.nm = nm;
  const opts = (sel) => `<option value="all"${sel === "all" ? " selected" : ""}>${y ? "the whole world" : "the whole S&P 500"}</option>
    <optgroup label="${y ? "Regions" : "Sectors"}">${groups.map((g) => `<option value="group:${esc(g)}"${sel === "group:" + g ? " selected" : ""}>${esc(g)}</option>`).join("")}</optgroup>
    <optgroup label="${y ? "Countries" : "Companies"}">${[...bodies].sort((a, b) => a.name.localeCompare(b.name)).map((b) => `<option value="${esc(b.id)}"${sel === b.id ? " selected" : ""}>${esc(b.name)}</option>`).join("")}</optgroup>`;
  S.opts = opts;
  el.innerHTML = `<div class="pf-h"><div><div class="pf-t">Scenario builder <span class="dim" id="sc-nm">${esc(S.name || "unsaved")}</span></div>
      <div class="dim pf-what">${y ? "total real GDP (constant 2015 US$)" : "combined share of the S&P 500's value"} of <select class="in xs" id="sc-target">${opts(S.target)}</select>
      over <select class="in xs" id="sc-h">${(y ? [5, 10, 20] : [12, 36, 60]).map((v) => `<option value="${v}"${v === S.horizon ? " selected" : ""}>${y ? v + " years" : v / 12 + (v === 12 ? " year" : " years")}</option>`).join("")}</select></div></div>
      <div class="pf-tools"><button class="btn ghost xs" id="sc-saved">${icon("down")} Saved</button><button class="btn ghost xs" id="sc-save">Save</button><button class="btn ghost xs" id="sc-link" title="Copy a link that opens this scenario">Copy link</button><button class="iconbtn" id="sc-x" title="Back to the map (Esc)">${icon("x")}</button></div></div>
    <p class="pf-sent" id="sc-sent">Running the baseline…</p>
    <div class="pf-chart sc-chart"><canvas id="sc-cv"></canvas></div>
    <div class="pf-leg"><span><i class="fan"></i>baseline: median, 50% and 80% bands</span><span><i style="background:#ffb020"></i>with your changes</span><span class="dim" id="sc-rho"></span></div>
    <div class="sc-body"><div class="sc-ch"><div class="sec-t">Changes <span class="dim">· years ahead${y ? "" : " are months"}</span></div><div id="sc-list"></div>
        <div class="sc-add"><button class="btn ghost xs" id="sc-addb">${icon("plus")} Add a change</button><span class="dim">or start from</span>${(PRESETS[world] || []).map((p, i) => `<button class="chip sc-pre" data-i="${i}">${esc(p.name)}</button>`).join("")}</div>
        <button class="btn sm" id="sc-run" data-primary>${icon("spark")} Run the scenario</button></div>
      <div class="sc-tab"><div class="sec-t">Who it moves most <span class="dim">· median growth a year, baseline → scenario</span></div><div id="sc-table"></div></div></div>`;
  $("#sc-x").onclick = () => { el.hidden = true; };
  $("#sc-target").onchange = (e) => { S.target = e.target.value; run(); };
  $("#sc-h").onchange = (e) => { S.horizon = +e.target.value; run(); };
  $("#sc-addb").onclick = () => { S.changes.push({ target: S.target === "all" ? "all" : S.target, kind: "growth", from: 1, to: S.horizon, value: KINDS.growth.to(KINDS.growth.def), spill: 0 }); list(); };
  $$(".sc-pre", el).forEach((b) => b.onclick = () => { const p = PRESETS[world][+b.dataset.i]; S.target = p.target; $("#sc-target").value = p.target; S.changes = JSON.parse(JSON.stringify(p.changes)); S.name = p.name; $("#sc-nm").textContent = p.name + " (preset)"; list(); run(); });
  $("#sc-run").onclick = run;
  $("#sc-save").onclick = save;
  $("#sc-saved").onclick = savedMenu;
  $("#sc-link").onclick = () => { const u = location.origin + location.pathname + "#particles?" + new URLSearchParams({ w: world, scen: btoa(unescape(encodeURIComponent(JSON.stringify(spec())))) }); navigator.clipboard.writeText(u).then(() => toast("Link copied")).catch(() => toast(u)); };
  if (!S.keys) { S.keys = true; document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.el && !S.el.hidden && !$("#pl-fut:not([hidden])")) { e.stopPropagation(); S.el.hidden = true; } }); }
  new ResizeObserver(() => draw()).observe($(".sc-chart", el));
  list(); run();
}
const spec = () => ({ name: S.name, target: S.target, horizon: S.horizon, changes: S.changes });
function list() {
  const L = $("#sc-list", S.el), y = S.world === "countries";
  if (!S.changes.length) { L.innerHTML = '<div class="hint">No changes yet: the chart shows the baseline. Add a change, or start from a preset.</div>'; return; }
  L.innerHTML = S.changes.map((c, i) => { const K = KINDS[c.kind];
    return `<div class="sc-row" data-i="${i}"><select class="in xs" data-f="target">${S.opts(c.target)}</select>
      <select class="in xs" data-f="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}"${k === c.kind ? " selected" : ""}>${v.t}</option>`).join("")}</select>
      <input class="in xs num" type="number" data-f="value" step="${K.step}" value="${+K.from(c.value).toFixed(3)}" title="${esc(K.hint)}"><span class="dim u">${K.unit}</span>
      <span class="dim">${c.kind === "shock" ? "in" : "from"}</span><input class="in xs num" type="number" data-f="from" min="1" max="${S.horizon}" value="${c.from}">
      ${c.kind === "shock" ? "" : `<span class="dim">to</span><input class="in xs num" type="number" data-f="to" min="1" max="${S.horizon}" value="${c.to || S.horizon}">`}
      ${c.target === "all" ? "" : `<span class="dim" title="An assumption you choose: the same change, this much weaker, for the rest of its ${y ? "region" : "sector"}">spill</span><input class="in xs num" type="number" data-f="spill" min="0" max="100" step="5" value="${Math.round((c.spill || 0) * 100)}"><span class="dim u">%</span>`}
      <button class="iconbtn" data-del title="Remove">${icon("x")}</button></div>`; }).join("");
  $$(".sc-row", L).forEach((r) => {
    const c = S.changes[+r.dataset.i];
    $$("[data-f]", r).forEach((inp) => inp.onchange = () => {
      const f = inp.dataset.f;
      if (f === "kind") { c.kind = inp.value; c.value = KINDS[c.kind].to(KINDS[c.kind].def); list(); }
      else if (f === "target") { c.target = inp.value; list(); }
      else if (f === "value") c.value = KINDS[c.kind].to(+inp.value);
      else if (f === "spill") c.spill = Math.max(0, Math.min(100, +inp.value)) / 100;
      else c[f] = Math.max(1, Math.min(S.horizon, +inp.value));
      later();
    });
    $("[data-del]", r).onclick = () => { S.changes.splice(+r.dataset.i, 1); list(); run(); };
  });
}
function later() { clearTimeout(S.t); S.t = setTimeout(run, 400); }
async function run() {
  const sent = $("#sc-sent"); sent.classList.add("busy");
  try {
    const r = (await callModel("forces.scenario", { world: S.world, target: S.target, changes: S.changes, horizon: S.horizon })).result;
    S.r = r; sent.textContent = r.sentence;
    $("#sc-rho").textContent = `${r.members} ${S.world === "countries" ? "countries" : "companies"} simulated together · their moves correlate ${r.rho.toFixed(2)} in the same ${S.world === "countries" ? "year" : "month"}${r.left_out.length ? ` · left out (no recent data): ${r.left_out.slice(0, 4).join(", ")}${r.left_out.length > 4 ? "…" : ""}` : ""}`;
    draw(); table();
  } catch (e) { fail(e); sent.textContent = e.message; }
  sent.classList.remove("busy");
}
const yr = (d) => +d.slice(0, 4) + (+d.slice(5, 7) - 1) / 12;
function nice(v) { if (S.world !== "countries") return (v * 100).toFixed(1) + "%"; return v >= 1e12 ? "$" + (v / 1e12).toFixed(v >= 1e13 ? 0 : 1) + "T" : "$" + (v / 1e9).toFixed(0) + "B"; }
function draw() {
  const r = S.r, cv = $("#sc-cv", S.el); if (!r || !cv) return;
  const dpr = window.devicePixelRatio || 1, w = cv.parentElement.clientWidth, h = cv.parentElement.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr; cv.style.width = w + "px"; cv.style.height = h + "px";
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const v0 = r.start.value, fx = [yr(r.start.date), ...r.dates.map(yr)], st = [v0, v0, v0, v0, v0];
  const B0 = [st, ...r.baseline], B1 = r.scenario ? [st, ...r.scenario] : null;
  const ys = B0.flat().concat(B1 ? B1.flat() : []);
  let lo = Math.min(...ys), hi = Math.max(...ys); const pd = (hi - lo) * 0.08; lo -= pd; hi += pd;
  const P = { l: 58, r: 14, t: 12, b: 24 }, X = (x) => P.l + (x - fx[0]) / (fx[fx.length - 1] - fx[0]) * (w - P.l - P.r), Y = (v) => h - P.b - (v - lo) / (hi - lo) * (h - P.t - P.b);
  g.font = "11px 'JetBrains Mono', monospace"; g.fillStyle = "#8a8b93"; g.strokeStyle = "rgba(255,255,255,.06)";
  for (let i = 0; i <= 4; i++) { const v = lo + (hi - lo) * i / 4; g.beginPath(); g.moveTo(P.l, Y(v)); g.lineTo(w - P.r, Y(v)); g.stroke(); g.textAlign = "right"; g.fillText(nice(v), P.l - 6, Y(v) + 4); }
  g.textAlign = "center"; const span = fx[fx.length - 1] - fx[0], sp = span > 12 ? 2 : 1; for (let t = Math.ceil(fx[0]); t <= fx[fx.length - 1]; t += sp) g.fillText(String(t), X(t), h - 6);
  const band = (B, a, b, col) => { g.beginPath(); fx.forEach((x, i) => (i ? g.lineTo : g.moveTo).call(g, X(x), Y(B[i][a]))); for (let i = fx.length - 1; i >= 0; i--) g.lineTo(X(fx[i]), Y(B[i][b])); g.closePath(); g.fillStyle = col; g.fill(); };
  const line = (B, col, wd, dash) => { g.beginPath(); fx.forEach((x, i) => (i ? g.lineTo : g.moveTo).call(g, X(x), Y(B[i][2]))); g.strokeStyle = col; g.lineWidth = wd; g.setLineDash(dash || []); g.stroke(); g.setLineDash([]); };
  band(B0, 0, 4, "rgba(232,232,234,.09)"); band(B0, 1, 3, "rgba(232,232,234,.15)");
  if (B1) { band(B1, 0, 4, "rgba(255,176,32,.14)"); band(B1, 1, 3, "rgba(255,176,32,.24)"); }
  line(B0, B1 ? "rgba(232,232,234,.75)" : "#e8e8ea", 2, B1 ? [5, 4] : null); if (B1) line(B1, "#ffb020", 2.4);
  // the years where a change starts
  g.fillStyle = "#ffb020"; S.changes.forEach((c) => { const x = X(fx[0] + (c.from - 1 + 0.5) * (S.world === "countries" ? 1 : 1 / 12)); g.fillRect(x - 1, P.t, 2, 6); });
}
function table() {
  const r = S.r, el = $("#sc-table", S.el); if (!r) return;
  const yrs = S.world === "countries" ? r.horizon : r.horizon / 12, a = (v) => v == null ? "—" : ((Math.exp(v / yrs) - 1) * 100).toFixed(1) + "%";
  el.innerHTML = `<table class="pf-tb sc-t"><tr><th>${S.world === "countries" ? "Country" : "Company"}</th><th>baseline</th><th>scenario</th><th>at the end</th></tr>${r.table.slice(0, 14).map((t) => `<tr><th>${esc(t.name)}</th><td>${a(t.base)}</td><td>${a(t.scen)}</td><td class="${t.delta == null ? "" : t.delta < -0.001 ? "bad" : t.delta > 0.001 ? "good" : ""}">${t.delta == null ? "" : (t.delta >= 0 ? "+" : "") + ((Math.exp(t.delta) - 1) * 100).toFixed(1) + "%"}</td></tr>`).join("")}</table>`;
}
function load() { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (e) { return []; } }
function save() {
  const nm = prompt("Name this scenario (a new name keeps the old one: a fork)", S.name || ""); if (!nm) return;
  S.name = nm; const all = load().filter((x) => !(x.name === nm && x.world === S.world));
  all.unshift({ ...spec(), world: S.world, saved: new Date().toISOString().slice(0, 16) });
  try { localStorage.setItem(KEY, JSON.stringify(all.slice(0, 60))); } catch (e) { toast("This browser would not save it; use Copy link"); return; }
  $("#sc-nm").textContent = nm; toast("Saved");
}
async function savedMenu(e) {
  const { menu } = await import("./hub.js");
  const all = load().filter((x) => x.world === S.world);
  menu(e.currentTarget, all.length ? all.map((x) => ({ label: x.name, sub: `${x.changes.length} change${x.changes.length === 1 ? "" : "s"} · ${x.saved}`, icon: "states", run: () => { Object.assign(S, { name: x.name, target: x.target, horizon: x.horizon, changes: JSON.parse(JSON.stringify(x.changes)) }); $("#sc-target").value = x.target; $("#sc-h").value = x.horizon; $("#sc-nm").textContent = x.name; list(); run(); } }))
    : [{ label: "Nothing saved yet", sub: "Save keeps scenarios in this browser", disabled: true, run: () => {} }]);
}
