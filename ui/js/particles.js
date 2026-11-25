import { $, $$, esc, fail, icon, toast } from "./core.js";
import { PALETTE } from "./charts.js";
import { callModel, menu } from "./hub.js";
import { openFutures } from "./particles-futures.js";
import { openScenario } from "./particles-scenario.js";
import { go } from "./core.js";
import { guideView, helpDot, onHelp } from "./guide.js";
import { LESSONS, REF } from "./forces-guide.js";
import { openProblem } from "./tplpanel.js";

// Particle Lab, "Learn from history": four stages in order — 1 World, 2 Learn, 3 Test, 4 Project.
// Left: the stage you are on, with its one main button. Middle: the map and the groups, for the test or the projection.
// Right: Bodies, Events, Guide. The server does the work (app/forcerun.py through the forces.* models).
// "Rules by hand" (the first Particle Lab, particles-hand.js) is the other mode; it also takes your own tables.
// Every visible sentence follows ASD-STE100 (STYLE.md).
const STAGES = [["world", "1", "World"], ["learn", "2", "Learn"], ["test", "3", "Test"], ["project", "4", "Project"]];
const WORLDS = [["companies", "Companies (S&P 500)"], ["countries", "Countries"]];
const EV_ICON = { merger: "◆", exit: "↗", entry: "↘", split: "✦", collapse: "✕", jump: "▲", war: "⚔", civilwar: "◼", uprising: "▲", coup: "♛", currency: "$", breakup: "✂", union: "∪" };
const EV_COL = { merger: "#c084fc", exit: "#ffb020", entry: "#2fd38a", split: "#5eead4", collapse: "#ff3b30", jump: "#3fa9f5", war: "#ff3b30", civilwar: "#ff8a3d",
  uprising: "#ffb020", coup: "#c084fc", currency: "#3fa9f5", breakup: "#5eead4", union: "#2fd38a" };
const EV_NAME = { merger: "Merger", exit: "Exit", entry: "Entry", split: "Split", collapse: "Collapse", jump: "Jump", war: "War", civilwar: "Civil war", uprising: "Uprising",
  coup: "Coup", currency: "Currency crash", breakup: "Breakup", union: "Union" };
const SCEN_TYPES = { companies: ["merger", "exit", "collapse", "jump"], countries: ["war", "civilwar", "uprising", "coup", "currency"] };

const F = {
  mode: "learn", world: "countries", stage: "world", info: {}, model: {}, res: {}, show: "test", busy: false, loadError: null,
  layer: "avg", layout: "growth", colour: "growth", hideOthers: false, u: 0, playing: false, hover: -1, pick: null, focus: null, view: { k: 1, ox: 0, oy: 0 },
  tab: "guide", to: { companies: 2030, countries: 2035 }, scen: { companies: [], countries: [] }, evfilter: "",
};
const KEEP = ["mode", "world", "stage", "layer", "layout", "colour", "tab", "to", "scen"];
let first = true;
try { const j = JSON.parse(localStorage.getItem("vf-forces3") || "null"); if (j) { first = false; KEEP.forEach((k) => { if (k in j) F[k] = j[k]; }); } } catch (e) { /* fresh */ }
const save = () => { try { localStorage.setItem("vf-forces3", JSON.stringify(Object.fromEntries(KEEP.map((k) => [k, F[k]])))); } catch (e) { /* storage off */ } };
const pct = (x, d = 1) => x == null ? "—" : x > 0 && x * 100 < Math.pow(10, -d) ? (x * 100).toPrecision(2) + "%" : (x * 100).toFixed(d) + "%";
const num = (x, d = 3) => x == null || x !== x ? "—" : (+x).toFixed(d);
const SIM = "#ffb020", REAL = "#3fa9f5";             // forecast = amber, real = blue, everywhere; red/green only mean lost/gained share
// group colours without red or green (they are taken by "lost share" / "gained share")
const GROUP_PAL = ["#3fa9f5", "#ffd300", "#c084fc", "#ff8a3d", "#5eead4", "#f472b6", "#94a3b8", "#38bdf8", "#e9c46a", "#a78bfa", "#fda4af", "#7dd3fc", "#d6d3d1"];
let grpColor = {};
const colorOf = (g) => { if (!(g in grpColor)) grpColor[g] = GROUP_PAL[Object.keys(grpColor).length % GROUP_PAL.length]; return grpColor[g]; };
let G = null, hand = null;

export default {
  id: "particles", title: "Particle Lab", sub: "learn the forces from history, test them, project them", icon: "orbit",
  mount(el) {
    el.innerHTML = `<div class="fxv">
      <div class="fx-top">
        <div class="seg fx-mode" id="fx-mode"><button data-m="learn" title="Learn the forces from history, test them on years the tool did not see, then project">Learn from history</button><button data-m="hand" title="Set the rules yourself, also on your own tables">Rules by hand</button></div>
        <div class="fx-steps" id="fx-steps"></div>
        <button class="btn xs fx-yours" id="fx-yours" title="Your own group (companies, countries, teams, products) as CSV text or a Data Desk table, from a template: one run, scored against nothing changes">${icon("spark")} Your group…</button>
        <div class="fx-world seg" id="fx-world">${WORLDS.map(([k, l]) => `<button data-w="${k}">${l}</button>`).join("")}</div>
      </div>
      <div class="ws side-lr fx" id="fx-learn">
        <div class="col"><section class="pane grow" id="fx-stage"><div class="pane-h"><div class="t" id="fx-st">Stage</div><div class="meta" id="fx-sm"></div></div>
          <div class="pane-b" id="fx-sb"></div>
          <div class="pane-act"><button class="btn block" id="fx-go"></button><div class="fx-prog" id="fx-prog" hidden><i></i></div><div class="hint" id="fx-time">&nbsp;</div></div></section></div>
        <div class="col">
          <section class="pane fit sm-verdict" id="fx-verdict"><div class="hl" id="fx-hl">—</div><div class="txt"><div class="nm" id="fx-nm">Particle Lab</div><p id="fx-sent"></p></div></section>
          <section class="pane grow" id="fx-mapp"><div class="pane-h"><div class="t">Map</div>
              <div class="seg" id="fx-layer"></div><div class="meta" id="fx-mmeta"></div></div>
            <div class="pane-b stage" id="fx-stagebox"><canvas id="fx-map" tabindex="0"></canvas>
              <div class="pl-ov tl"><div class="seg xs" id="fx-layout"><button data-v="growth" title="Across: size at the start. Up: share gained. A ring at the same place across is the real value, so the gap up or down is the error">Growth vs size</button><button data-v="world" title="Each country at its capital">World</button><button data-v="map" title="Co-movement: bodies that move together are near each other">Co-movement</button><button data-v="orbit" title="Distance from the centre = size rank; the circle is the edge of the S&amp;P 500">Orbit</button></div>
                <select class="sel xs" id="fx-region" title="Show one region or sector (the others are hidden)"><option value="">All</option></select>
                <button class="btn ghost xs" id="fx-scen" title="What if: change growth, volatility, stability or add a shock for a country, a region or everyone, and see the futures">${icon("spark")} Scenario</button>
                <input class="in xs" id="fx-find" list="fx-findl" placeholder="Find…" autocomplete="off"><datalist id="fx-findl"></datalist>
                <div class="seg xs" id="fx-colour"><button data-v="group">Colour: group</button><button data-v="growth">growth</button></div></div>
              <div class="pl-ov tr"><button class="iconbtn" id="fx-zin" title="Zoom in">${icon("zoomin")}</button><button class="iconbtn" id="fx-zout" title="Zoom out">${icon("zoomout")}</button><button class="iconbtn" id="fx-zfit" title="Show all">${icon("fit")}</button></div>
              <div class="pl-ov bl" id="fx-key"></div>
              <div class="pl-ask" id="fx-ask" hidden></div>
              <div class="pl-msg fx-msg" id="fx-msg" hidden></div><div class="pl-tip" id="fx-tip" hidden></div></div>
            <div class="pane-f fx-time"><button class="iconbtn" id="fx-play" title="Play (space)">${icon("play")}</button>
              <div class="fx-track"><canvas id="fx-tl"></canvas><input type="range" id="fx-scrub" min="0" max="0" step="any" value="0"></div><span id="fx-fr" class="mono">—</span></div></section>

        </div>
        <div class="col"><section class="pane grow" id="fx-side"><div class="pane-h"><div class="tabs" id="fx-tabs"><button data-t="bodies">Bodies</button><button data-t="groups" id="fx-gt">Regions</button><button data-t="good" title="How good the forecast was on the test years">How good</button><button data-t="events">Events</button><button data-t="pred" title="Which data predict growth, tested before they may become forces">Predictors</button><button data-t="guide">Guide</button></div><div class="meta" id="fx-tm"></div></div>
          <div class="pane-b flush" id="fx-bodies"></div><div class="pane-b" id="fx-groups" hidden></div><div class="pane-b" id="fx-good" hidden></div><div class="pane-b flush" id="fx-events"></div><div class="pane-b" id="fx-pred" hidden></div><div class="pane-b" id="fx-guide"></div></section></div>
      </div>
      <div class="fx-hand" id="fx-hand" hidden></div>
    </div>`;
    $$("#fx-mode [data-m]").forEach((b) => b.onclick = () => mode(b.dataset.m));
    $("#fx-yours").onclick = () => openProblem("particles");
    $$("#fx-world [data-w]").forEach((b) => b.onclick = () => setWorld(b.dataset.w));
    $$("#fx-tabs [data-t]").forEach((b) => b.onclick = () => tab(b.dataset.t));
    seg("#fx-layout", "layout", () => { fitView(); key(); draw(); });
    $("#fx-sent").onclick = () => $("#fx-sent").classList.toggle("open");
    $("#fx-region").onchange = (e) => { F.focus = e.target.value || null; F.hideOthers = !!F.focus; fitView(); if (F.focus) zoomToGroup(F.focus); key(); draw(); };
    $("#fx-find").onchange = (e) => { const r = R(); if (!r) return; const q = e.target.value.trim().toLowerCase(); const i = r.bodies.findIndex((b) => b.name.toLowerCase() === q || b.id.toLowerCase() === q) >= 0 ? r.bodies.findIndex((b) => b.name.toLowerCase() === q || b.id.toLowerCase() === q) : r.bodies.findIndex((b) => b.name.toLowerCase().includes(q));
      if (i < 0) { toast("No body named " + e.target.value); return; } pickBody(r.bodies[i].id, true); e.target.value = ""; };
    seg("#fx-colour", "colour", () => { key(); draw(); bodies(); });
    $("#fx-go").onclick = () => F.loadError ? setWorld(F.world) : action();
    $("#fx-scen").onclick = () => scenarioFor(F.focus ? "group:" + F.focus : "all");
    const sc = $("#fx-scrub"); sc.oninput = () => { F.u = +sc.value; F.playing = false; frame(); };
    $("#fx-play").onclick = play;
    $("#fx-zin").onclick = () => zoomBy(1.6); $("#fx-zout").onclick = () => zoomBy(1 / 1.6); $("#fx-zfit").onclick = () => { F.focus = null; fitView(); draw(); };
    mapInput($("#fx-map"));
    $("#fx-tl").onclick = tlClick;
    new ResizeObserver(() => { draw(); timeline(); groups(); bodyChart(); }).observe($("#fx-stagebox"));
    G = guideView($("#fx-guide"), { key: "forces", lessons: LESSONS, ref: REF, onAct: (a, args) => { if (a === "stage") stage(args); } });
    onHelp(el, (k) => { tab("guide"); G.lookup(k); });
    mode(F.mode, true);
    tab(first ? "guide" : F.tab);
    setWorld(F.world);
  },
  show(p) { if (F.mode === "hand" && hand) hand.show && hand.show(); else draw(); if (p && (p.w || p.id)) deepLink(p); },
  hide() { F.playing = false; if (hand && hand.hide) hand.hide(); },
};
function seg(sel, key, after) {
  const paint = () => $$(sel + " [data-v]").forEach((b) => b.classList.toggle("on", b.dataset.v === F[key]));
  $$(sel + " [data-v]").forEach((b) => b.onclick = () => { if (b.disabled) return; F[key] = b.dataset.v; save(); paint(); after(); });
  paint();
}
async function mode(m, quiet) {
  F.mode = m; save();
  $$("#fx-mode [data-m]").forEach((b) => b.classList.toggle("on", b.dataset.m === m));
  $("#fx-learn").hidden = m !== "learn"; $("#fx-hand").hidden = m !== "hand";
  $("#fx-steps").hidden = $("#fx-world").hidden = m !== "learn";
  if (m === "hand" && !hand) {
    const mod = await import("./particles-hand.js?v=1016l");
    hand = mod.default; hand.mount($("#fx-hand"));
  } else if (m === "hand" && hand && hand.show) hand.show();
  if (m === "learn" && !quiet) draw();
}
function tab(t) {
  F.tab = t; save();
  $$("#fx-tabs [data-t]").forEach((b) => b.classList.toggle("on", b.dataset.t === t));
  ["bodies", "events", "guide", "groups", "good", "pred"].forEach((k) => { $("#fx-" + k).hidden = k !== t; });
  $("#fx-tm").textContent = t === "guide" ? "how it works" : t === "groups" ? "share of the whole · start → forecast · real" : t === "good" ? "the test years" : "";
  if (t === "bodies") bodies(); else if (t === "events") events(); else if (t === "groups") groups(); else if (t === "good") good(); else if (t === "pred") predictors();
}

// ---------------------------------------------------------------- world and stages
async function setWorld(w) {
  F.world = w; F.loadError = null; save(); grpColor = {}; F.pick = null; F.focus = null;
  $$("#fx-world [data-w]").forEach((b) => b.classList.toggle("on", b.dataset.w === w));
  stepper(); stagePane();
  try {
    const [info, model, test, proj] = await Promise.all([callModel("forces.world", { world: w }), callModel("forces.model", { world: w }).catch(() => null),
      callModel("forces.result", { world: w, kind: "test" }).catch(() => null), callModel("forces.result", { world: w, kind: "project" }).catch(() => null)]);
    if (F.world !== w) return;
    const got = (r) => r && r.result && !r.result.missing ? r.result : null;          // "missing" = nothing saved yet
    F.info[w] = info.result; F.model[w] = got(model); F.res[w] = { test: got(test), project: got(proj) };
    (F.info[w].groups || []).forEach(colorOf);
    setTimeout(askCard, 0);
    if (F.stage !== "world" && !can(F.stage)) F.stage = "world";
    F.show = F.stage === "project" && F.res[w].project ? "project" : F.res[w].test ? "test" : F.res[w].project ? "project" : "test";
    stepper(); stagePane(); loadResult(); events();
  } catch (e) {
    if (F.world !== w) return;
    F.loadError = e.message;
    stagePane();
  }
}
const can = (s) => s === "world" || s === "learn" || (s === "test" && F.model[F.world]) || (s === "project" && F.model[F.world]);
function stage(s) {
  if (!can(s)) { $("#fx-time").textContent = "Learn the forces first (stage 2)."; return; }
  F.stage = s; save();
  if (s === "test" && F.res[F.world] && F.res[F.world].test) { F.show = "test"; loadResult(); }
  if (s === "project" && F.res[F.world] && F.res[F.world].project) { F.show = "project"; loadResult(); }
  stepper(); stagePane();
}
function stepper() {
  const w = F.world, m = F.model[w], r = F.res[w] || {};
  const done = { world: !!F.info[w], learn: !!m, test: !!r.test, project: !!r.project };
  const sub = { world: F.info[w] ? `${F.info[w].bodies} bodies` : "", learn: m ? `score ${num(m.tune.score, 2)}` : "not done", test: r.test ? (r.test.verdict.beat ? "forces win" : "forces lose") : "not done",
    project: r.project ? `to ${r.project.to.slice(0, 4)}` : "not done" };
  $("#fx-steps").innerHTML = STAGES.map(([k, n, l], i) => `${i ? '<i class="fx-arrow">›</i>' : ""}<button class="fx-step ${F.stage === k ? "on" : ""} ${done[k] ? "done" : ""}" data-s="${k}" ${can(k) ? "" : "disabled"}
      title="${can(k) ? "" : "Learn the forces first"}"><b>${n}</b><span><em>${l}</em><small>${esc(sub[k])}</small></span></button>`).join("");
  $$("#fx-steps [data-s]").forEach((b) => b.onclick = () => stage(b.dataset.s));
}
function stagePane() {
  const w = F.world, info = F.info[w], m = F.model[w], r = F.res[w] || {};
  const st = { world: "1 · World", learn: "2 · Learn the forces", test: "3 · Test on unseen years", project: "4 · Project the future" }[F.stage];
  $("#fx-st").textContent = st;
  const go = $("#fx-go");
  let html = "";
  if (F.loadError) {
    $("#fx-sm").textContent = "";
    $("#fx-sb").innerHTML = `<p class="fx-lead" role="status">${esc(F.loadError)}</p>`;
    go.textContent = "Try again";
    go.hidden = go.disabled = false;
    return;
  }
  if (!info) { $("#fx-sb").innerHTML = `<div class="hint">Loading the data…</div>`; go.hidden = true; return; }
  go.hidden = false;
  if (F.stage === "world") {
    $("#fx-sm").textContent = `${info.first.slice(0, 4)}–${info.last.slice(0, 7)}`;
    const ev = Object.entries(info.events).sort((a, b) => b[1] - a[1]);
    html = `<p class="fx-lead">${w === "companies" ? "The companies in the S&amp;P 500, month by month. The size of a company is its market cap." : "The countries of the world, year by year. The size of a country is its GDP in US$."}</p>
      <div class="fx-facts"><div><b>${info.bodies}</b><span>bodies</span></div><div><b>${info.steps}</b><span>${info.step}s</span></div><div><b>${info.groups.length}</b><span>${esc(info.group_name)}s</span></div>${info.estimated ? `<div><b>${info.estimated}</b><span>sizes estimated</span></div>` : ""}</div>
      <div class="sec-t">Events in the data</div>
      <div class="fx-evs">${ev.map(([k, n]) => `<button class="fx-ev" data-evf="${k}" title="Show them in the Events tab"><i style="color:${EV_COL[k] || "#888"}">${EV_ICON[k] || "•"}</i><span>${EV_NAME[k] || k}</span><b>${n}</b>${helpDot("ev_" + k)}</button>`).join("")}</div>
      <div class="sec-t">Periods</div>${periodsBar(info.periods, info)}
      <div class="sec-t">Notes on the data</div><ul class="fx-notes">${info.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`;
    go.innerHTML = `${icon("bolt")} Next: learn the forces`; go.disabled = false;
  } else if (F.stage === "learn") {
    $("#fx-sm").textContent = m ? `learned ${m.windows} starts · ${Math.round(m.secs)} s` : "";
    html = periodsBar(info.periods, info);
    if (!m) html += `<p class="fx-lead">Click <b>Learn the forces</b>. The tool learns the weight of each force from the training period, then checks the setup on the tuning period. This takes some minutes. You can use other apps at the same time.</p>
      <div class="sec-t">The forces it will weigh</div><div class="fx-terms">${info.terms.map((t) => `<div class="fx-term"><div class="nm">${esc(t.label)}${helpDot(t.k)}</div><div class="sub">${esc(t.help)}</div></div>`).join("")}</div>`;
    else html += learnedHtml(m, info);
    go.innerHTML = `${icon("bolt")} ${m ? "Learn again" : "Learn the forces"}`; go.disabled = F.busy;
  } else if (F.stage === "test") {
    $("#fx-sm").textContent = r.test ? `${r.test.t0.slice(0, 7)} → ${r.test.t1.slice(0, 7)}` : "";
    html = r.test ? testHtml(r.test) : `<p class="fx-lead">Click <b>Run the test</b>. The tool starts at the end of the tuning period (${esc(info.periods.tune[1].slice(0, 7))}) and runs to the end of the data (${esc(info.last.slice(0, 7))}). It never saw these ${info.step}s. Then it compares its answer with what really happened.</p>`;
    go.innerHTML = `${icon("bolt")} ${r.test ? "Run the test again" : "Run the test"}`; go.disabled = F.busy;
  } else {
    $("#fx-sm").textContent = r.project ? `${r.project.t0.slice(0, 7)} → ${r.project.to.slice(0, 7)}` : "";
    html = projectHtml(info, r.project);
    go.innerHTML = `${icon("bolt")} Run the projection`; go.disabled = F.busy;
  }
  $("#fx-sb").innerHTML = html;
  $$("#fx-sb [data-evf]").forEach((b) => b.onclick = (e) => { if (e.target.closest("[data-help]")) return; F.evfilter = b.dataset.evf; tab("events"); events(true); });
  if (F.stage === "project") wireScenarios(info);
  $$("#fx-sb [data-tstep]").forEach((b) => b.onclick = () => { F.show = b.dataset.tstep; loadResult(); });
}
function periodsBar(p, info) {
  const a = +info.first.slice(0, 4), z = +info.last.slice(0, 4) + 1, span = z - a, x = (d) => ((+d.slice(0, 4) + (+d.slice(5, 7) || 12) / 12 - a) / span * 100).toFixed(2);
  const seg = (k, d0, d1, l) => `<i class="${k}" style="left:${x(d0)}%;width:${(x(d1) - x(d0)).toFixed(2)}%" title="${l}: ${d0.slice(0, 7)} → ${d1.slice(0, 7)}"></i>`;
  return `<div class="fx-per"><div class="bar">${seg("tr", p.train[0], p.train[1], "training")}${seg("tu", p.tune[0], p.tune[1], "tuning")}${seg("te", p.test[0], p.test[1], "test")}</div>
    <div class="lab"><span>${a}</span><span>${z - 1}</span></div>
    <div class="pl-leg"><span><i class="tr"></i>training ${p.train[0].slice(0, 4)}–${p.train[1].slice(0, 4)}</span><span><i class="tu"></i>tuning ${p.tune[0].slice(0, 4)}–${p.tune[1].slice(0, 4)}</span><span><i class="te"></i>test ${p.test[0].slice(0, 4)}–${p.test[1].slice(0, 7)}</span></div></div>`;
}
function learnedHtml(m, info) {
  const chip = (v) => v === "dropped" ? `<span class="fx-chip bad" title="Without it the tuning years were forecast better, so it is turned off (0) in the model the test uses">off · it hurt</span>` : v ? `<span class="fx-chip ${v === "helps" ? "good" : v === "hurts" ? "bad" : ""}">${v}</span>` : "";
  const grow = m.terms.filter((t) => t.kind === "size"), move = m.terms.filter((t) => t.kind === "position");
  const row = (t) => `<tr><td>${esc(t.label)}${helpDot(t.k)}</td><td class="mono r">${t.k === "halflife" ? num(t.value, 1) + " y" : (t.value >= 0 ? "+" : "") + num(t.value, 3)}</td><td>${chip(t.verdict)}</td></tr>`;
  const spy = info.step === "month" ? 12 : 1;
  const evs = Object.entries(m.events).filter(([k, v]) => v && v.n != null);
  return `<div class="fx-score"><div><b>${num(m.tune.score, 2)}</b><span>tuning score${helpDot("e_size")}</span></div><div><b>${num(m.tune.size, 2)}</b><span>growth</span></div><div><b>${num(m.tune.pos, 2)}</b><span>position</span></div></div>
    <p class="hint">1.00 = the same as “nothing changes” (growth + position, so 2.00 in total). Lower is better. ${m.blends.length > 1 ? `Neighbours: ${Math.round(m.blend * 100)}% map, ${Math.round((1 - m.blend) * 100)}% geography (the best of ${m.blends.length} setups)${helpDot("blend")}.` : ""}</p>
    <div class="sec-t">Growth forces</div><table class="tbl fx-tbl"><thead><tr><th>force</th><th class="r">weight</th><th>in tuning${helpDot("contrib")}</th></tr></thead><tbody>${grow.map(row).join("")}</tbody></table>
    <div class="sec-t">Position forces</div><table class="tbl fx-tbl"><tbody>${move.map(row).join("")}</tbody></table>
    <div class="sec-t">Events${helpDot("chance")}</div><table class="tbl fx-tbl"><thead><tr><th>event</th><th class="r">per body, per year</th><th class="r">effect${helpDot("effect")}</th></tr></thead><tbody>
      ${evs.map(([k, v]) => `<tr><td><i class="fx-ei" style="color:${EV_COL[k]}">${EV_ICON[k] || "•"}</i>${EV_NAME[k] || k}${v.learned ? "" : ' <span class="dim">(one rate)</span>'}</td><td class="mono r">${pct(1 - Math.pow(1 - v.rate, spy), 2)}</td>
        <td class="mono r">${v.effect && v.effect.n ? (v.effect.mean >= 0 ? "+" : "") + pct(Math.exp(v.effect.mean) - 1, 0) : k === "merger" ? "absorbed" : k === "exit" ? "leaves" : k === "collapse" ? "leaves" : "—"}</td></tr>`).join("")}</tbody></table>
    <p class="hint">Click <b>3 · Test</b> above to run the forces on the test period.</p>`;
}
function testHtml(t) {
  const last = t.rows[t.rows.length - 1];
  const cell = (row, k, lower = true) => { const v = row[k]; const vals = Object.values(row).filter((x) => x != null); const best = lower ? Math.min(...vals) : Math.max(...vals); return `<td class="mono r ${v != null && v === best ? "best" : ""}">${v == null ? "—" : num(v, 3)}</td>`; };
  const g = t.groups, grp = { forces: g.forces, nothing: g.nothing };
  const M = [["forces", "Forces"], ["momentum", "Momentum only"], ["statistics", "Statistics only"], ["nothing", "Nothing changes"]];
  const col = (row, k, lower, f = (v) => num(v, 3)) => { if (!(k in row) || row[k] == null) return `<td class="r dim">—</td>`; const vals = Object.values(row).filter((x) => x != null); const best = lower ? Math.min(...vals) : Math.max(...vals); return `<td class="mono r ${row[k] === best ? "best" : ""}">${f(row[k])}</td>`; };
  return `<div class="fx-verd ${t.verdict.beat ? "good" : "bad"}">${esc(t.verdict.text)}</div>
    <div class="sec-t">At the end of the test · ${esc(last.date.slice(0, 7))}</div>
    <table class="tbl fx-tbl fx-card"><thead><tr><th>method</th><th class="r">growth${helpDot("e_size")}</th><th class="r">rank${helpDot("rank")}</th><th class="r">position${helpDot("e_pos")}</th><th class="r">group${helpDot("e_group")}</th></tr></thead><tbody>
      ${M.map(([k, l]) => `<tr><td>${l}</td>${col(last.size, k, true)}${col(last.rank, k, false, (v) => (v >= 0 ? "+" : "") + num(v, 2))}${col(last.pos, k, true)}${col(grp, k, true, (v) => pct(v))}</tr>`).join("")}</tbody></table>
    <p class="hint">Errors: lower is better. Rank correlation: higher is better (0 = no skill). The best value in each row is bold.</p>
    <div class="sec-t">Steps of the test</div><table class="tbl fx-tbl"><thead><tr><th>after</th><th class="r">forces</th><th class="r">momentum</th><th class="r">statistics</th><th class="r">nothing</th></tr></thead>
      <tbody>${t.rows.map((r) => `<tr><td>${r.step} ${F.info[F.world].step}${r.step > 1 ? "s" : ""}</td>${["forces", "momentum", "statistics", "nothing"].map((c) => cell(r.size, c)).join("")}</tr>`).join("")}</tbody></table>
    <p class="hint">Growth error at each step of the test.</p>
    <div class="sec-t">Events in the test period</div><table class="tbl fx-tbl"><thead><tr><th>event</th><th class="r">expected</th><th class="r">real</th></tr></thead><tbody>
      ${t.events.map((e) => `<tr><td><i class="fx-ei" style="color:${EV_COL[e.type]}">${EV_ICON[e.type] || "•"}</i>${EV_NAME[e.type] || e.type}</td><td class="mono r">${num(e.expected, 1)}</td><td class="mono r">${e.real}</td></tr>`).join("")}</tbody></table>
    <p class="hint">Expected = the average count over the futures. The Events tab lists each real event.</p>`;
}
function projectHtml(info, p) {
  const w = F.world, sc = F.scen[w];
  const ids = (F.res[w] && (F.res[w].test || F.res[w].project) || {}).bodies || [];
  const opts = ids.slice().sort((a, b) => b.w0 - a.w0).map((b) => `<option value="${esc(b.id)}">${esc(b.name)} (${esc(b.id)})</option>`).join("");
  return `<p class="fx-lead">The tool learns the forces again on all the data, then runs 128 futures from ${esc(info.last.slice(0, 7))}. Events happen at their learned chances. Your scenario events happen in every future.</p>
    <div class="fields"><div class="fld"><label>Run to the year</label><input type="range" id="fx-to" min="${+info.last.slice(0, 4) + 1}" max="${+info.last.slice(0, 4) + 25}" step="1" value="${F.to[w]}"><span class="v" id="fx-tov">${F.to[w]}</span></div></div>
    <div class="sec-t">Scenario events <span class="x">${sc.length}</span></div>
    ${sc.length ? `<div class="fx-scl">${sc.map((s, i) => `<div class="fx-sc"><i style="color:${EV_COL[s.type]}">${EV_ICON[s.type]}</i><span><b>${EV_NAME[s.type]}</b> · ${esc(s.id)}${s.by ? " → " + esc(s.by) : ""} · ${esc(s.date)}${s.value != null ? ` · ${s.value >= 0 ? "+" : ""}${pct(Math.exp(s.value) - 1, 0)}` : ""}</span><button class="iconbtn" data-del="${i}" title="Remove">${icon("x")}</button></div>`).join("")}</div>` : `<div class="hint">No scenario events. The futures use only the learned chances.</div>`}
    <div class="fx-add"><div class="fields">
      <div class="fld two"><label>Type</label><select class="sel sm" id="fx-st-type">${SCEN_TYPES[w].map((t) => `<option value="${t}">${EV_NAME[t]}</option>`).join("")}</select></div>
      <div class="fld two"><label>Body</label><select class="sel sm" id="fx-st-id">${opts || '<option value="">run the test first</option>'}</select></div>
      <div class="fld two" id="fx-st-byrow" hidden><label>Buyer</label><select class="sel sm" id="fx-st-by">${opts}</select></div>
      <div class="fld two"><label>Date</label><input class="in sm" id="fx-st-date" value="${+info.last.slice(0, 4) + 1}-06" placeholder="YYYY or YYYY-MM"></div>
      <div class="fld two"><label>Effect on size</label><input class="in sm" id="fx-st-val" placeholder="empty = learned, or −30%"></div></div>
      <button class="btn ghost sm" id="fx-st-add">${icon("plus")} Add the event</button></div>
    ${p ? `<div class="sec-t">Events in the futures (to ${esc(p.to.slice(0, 4))})</div><table class="tbl fx-tbl"><thead><tr><th>event</th><th class="r">expected count</th></tr></thead>
      <tbody>${p.events.map((e) => `<tr><td><i class="fx-ei" style="color:${EV_COL[e.type]}">${EV_ICON[e.type] || "•"}</i>${EV_NAME[e.type] || e.type}</td><td class="mono r">${num(e.expected, 1)}</td></tr>`).join("")}</tbody></table>
      <p class="hint">${p.scenarios.length ? `This run has ${p.scenarios.length} scenario event${p.scenarios.length > 1 ? "s" : ""}.` : "This run has no scenario events."} Select <b>One possible future</b> on the map to see the events of one future.</p>` : ""}`;
}
function wireScenarios(info) {
  const w = F.world, to = $("#fx-to");
  if (to) to.oninput = () => { F.to[w] = +to.value; $("#fx-tov").textContent = to.value; save(); };
  const ty = $("#fx-st-type"), byr = $("#fx-st-byrow");
  if (ty) ty.onchange = () => { byr.hidden = ty.value !== "merger"; };
  $$("#fx-sb [data-del]").forEach((b) => b.onclick = () => { F.scen[w].splice(+b.dataset.del, 1); save(); stagePane(); });
  const add = $("#fx-st-add");
  if (add) add.onclick = () => {
    const id = $("#fx-st-id").value, date = $("#fx-st-date").value.trim(), raw = $("#fx-st-val").value.trim();
    if (!id || !/^\d{4}(-\d{2})?$/.test(date)) { $("#fx-time").textContent = "Select a body and type a date as YYYY or YYYY-MM."; return; }
    let value = null;
    if (raw) { const v = parseFloat(raw.replace("%", "").replace("−", "-")); if (isFinite(v)) value = Math.log(Math.max(0.01, 1 + v / 100)); }
    const s = { type: ty.value, id, date, value };
    if (ty.value === "merger") s.by = $("#fx-st-by").value;
    F.scen[w].push(s); save(); stagePane();
  };
}

// ---------------------------------------------------------------- the main button
async function action() {
  if (F.stage === "world") { stage("learn"); return; }
  if (F.busy) return;
  const w = F.world, go = $("#fx-go"), t0 = performance.now();
  F.busy = true; go.disabled = true; prog(0, "starting");
  try {
    if (F.stage === "learn") {
      const r = await callModel("forces.learn", { world: w }, { onStep: (j) => prog(j.progress, j.message) });
      F.model[w] = r.result;
      $("#fx-time").textContent = `learned in ${Math.round((performance.now() - t0) / 1000)} s · next: 3 · Test`;
    } else if (F.stage === "test") {
      const r = await callModel("forces.test", { world: w, futures: 128 }, { onStep: (j) => prog(j.progress, j.message) });
      F.res[w].test = r.result; F.show = "test"; loadResult();
      $("#fx-time").textContent = `tested in ${Math.round((performance.now() - t0) / 1000)} s`;
    } else {
      const r = await callModel("forces.project", { world: w, to: F.to[w], futures: 128, scenarios: F.scen[w] }, { onStep: (j) => prog(j.progress, j.message) });
      F.res[w].project = r.result; F.show = "project"; loadResult();
      $("#fx-time").textContent = `projected in ${Math.round((performance.now() - t0) / 1000)} s`;
    }
  } catch (e) { fail(e); $("#fx-time").textContent = e.message; }
  F.busy = false; prog(null); stepper(); stagePane();
}
function prog(p, msg) {
  const b = $("#fx-prog");
  if (p == null) { b.hidden = true; return; }
  b.hidden = false; b.firstElementChild.style.width = Math.round((p || 0) * 100) + "%";
  if (msg) $("#fx-time").textContent = msg;
}

// ---------------------------------------------------------------- the result on the map (test or projection)
const R = () => (F.res[F.world] || {})[F.show];
// plain words for each world (STYLE.md: short sentences, common words)
const WORDS = {
  companies: { one: "company", many: "companies", of: "of the total value of the S&P 500", whole: "the S&P 500",
               near: "went up and down together in the 3 years before", colour: "sector", left: "left the S&P 500" },
  countries: { one: "country", many: "countries", of: "of world real GDP (constant US$)", whole: "the world economy",
               near: "had the same good and bad years in the 15 years before", colour: "region", left: "has no data any more" },
};
const W = () => WORDS[F.world] || WORDS.companies;
const legendMin = () => { try { return localStorage.getItem("vf-forces-legend") === "min"; } catch (e) { return false; } };
function loadResult() {
  const r = R();
  const lay = $("#fx-layer");
  if (!r) {
    lay.innerHTML = ""; msg(F.model[F.world] ? "Run the test (stage 3) or the projection (stage 4) to see the map." : "Learn the forces (stage 2), then run the test (stage 3) to see the map.");
    verdict(); groups(); bodies(); timeline(); draw(); return;
  }
  msg("");
  const isTest = F.show === "test";
  const layers = isTest ? [["avg", "Simulated"], ["real", "What happened"], ["both", "Both"], ["sample", "One possible future"]] : [["avg", "Average future"], ["sample", "One possible future"]];
  if (!layers.some(([k]) => k === F.layer)) F.layer = isTest ? "both" : "avg";
  lay.innerHTML = layers.map(([k, l]) => `<button data-v="${k}">${l}</button>`).join("");
  seg("#fx-layer", "layer", () => { key(); draw(); });
  r.groups_idx = Object.fromEntries(r.group_names.map((g, i) => [g, i]));
  r.group_names.forEach(colorOf);
  r.mw = Math.max(...r.bodies.map((b) => b.w0), 1e-9);
  r.gax = null; r.wpts = null;
  const wb = $("#fx-layout [data-v=world]"); if (wb) wb.hidden = F.world !== "countries";
  if (F.layout === "world" && F.world !== "countries") F.layout = "growth";
  $$("#fx-layout [data-v]").forEach((x) => x.classList.toggle("on", x.dataset.v === F.layout));
  $("#fx-region").innerHTML = `<option value="">All ${F.world === "countries" ? "regions" : "sectors"}</option>` + r.group_names.map((g) => `<option ${g === F.focus ? "selected" : ""}>${esc(g)}</option>`).join("");
  $("#fx-findl").innerHTML = r.bodies.map((b) => `<option value="${esc(b.name)}">`).join("");
  r.evByStep = {};
  (r.sample_events || []).forEach((list, k) => list.forEach((e) => { (r.evByStep[k + 1] = r.evByStep[k + 1] || []).push(e); }));
  r.realEv = isTest && F.events_real ? F.events_real : null;
  F.u = 0; F.playing = false;
  extent(r); fitView(); verdict(); key(); frame(); bodies(); events();
  if (!F._played) { F._played = true; setTimeout(() => { if (R() === r && !F.playing) play(); }, 600); }
}
function msg(t) { const m = $("#fx-msg"); m.hidden = !t; m.textContent = t || ""; }
function verdict() {
  const r = R(), hl = $("#fx-hl");
  if (!r) { hl.textContent = "—"; hl.className = "hl"; $("#fx-nm").textContent = F.info[F.world] ? F.info[F.world].what : "Particle Lab"; $("#fx-sent").textContent = "Follow the stages at the top: 1 World, 2 Learn, 3 Test, 4 Project."; return; }
  if (F.show === "test") {
    const last = r.rows[r.rows.length - 1], w = W();
    const ratio = last.size.forces != null && last.size.nothing ? last.size.forces / last.size.nothing : null;
    hl.textContent = r.verdict.beat ? "Yes" : "No";
    hl.className = "hl " + (r.verdict.beat ? "good" : "warn");
    $("#fx-nm").textContent = `The question: can simple rules from the past tell which ${w.many} will gain share ${w.of}?`;
    const sv = (F.info[F.world] || {}).saved || {};
    const stale = sv.model && sv.test && sv.model > sv.test + 60 ? `<b class="pl-stale">This test used an older model: the model was learned again on ${new Date(sv.model * 1000).toISOString().slice(0, 10)}. Run the test again (stage 3).</b> ` : "";
    $("#fx-sent").innerHTML = stale + `${r.verdict.beat
      ? `Answer: yes. From ${r.t0.slice(0, 7)} to ${r.t1.slice(0, 7)} (years the rules did not see), the rules did better than “nothing changes”.`
      : `Answer: no. From ${r.t0.slice(0, 7)} to ${r.t1.slice(0, 7)} (years the rules did not see), the rules did ${ratio && ratio < 1.1 ? "a little " : ""}worse than “nothing changes”, which says every share stays the same.`}`
      + (ratio ? ` <span class="dim">Error of the rules ÷ error of “nothing changes” = ${num(ratio, 2)} (below 1 is better).</span>` : "")
      + `<br><span class="dim">${esc(r.verdict.text)}</span>`;
  } else {
    hl.textContent = r.to.slice(0, 4); hl.className = "hl";
    $("#fx-nm").textContent = `What the rules expect from ${r.t0.slice(0, 7)} to ${r.to.slice(0, 7)} (128 possible futures)`;
    const n = r.scenarios.length;
    $("#fx-sent").textContent = `The map shows the average of the futures. The shaded bands show p10 to p90.${n ? ` ${n} scenario event${n > 1 ? "s happen" : " happens"} in every future.` : ""} Do not trust one line far ahead.`;
  }
}
function key() {
  const r = R(), el = $("#fx-key"); if (!r) { el.innerHTML = ""; return; }
  const w = W(), isTest = F.show === "test";
  const lines = [
    `Each dot is one ${w.one}. Its size is its share ${w.of}.`,
    ({ growth: "Across: the size at the start (log scale). Up: share gained since the start; down: share lost. The bright line is no change.",
       world: `Each ${w.one} sits at its capital. Discs are moved apart a little so that none covers another.`,
       orbit: "Distance from the centre: the size rank (the biggest are in the middle)." }[F.layout]
      || `${w.many[0].toUpperCase() + w.many.slice(1)} near each other ${w.near}. The place has no other meaning.`),
    F.colour === "growth" ? `Green gained share, red lost share, grey changed little. Full colour = a change of ±${Math.round((Math.exp(F.gscale || Math.log(2)) - 1) * 100)}% or more.`
      : `The colour is the ${w.colour} (no red or green: those mean lost or gained share in “growth” colour).`,
    F.layer === "sample" ? "This is one future the tool drew at random. Its events are random too: a war has no named other side, and the tool picks the buyer in a merger."
      : isTest && F.layer !== "avg" ? (F.layout === "growth" ? "A filled dot is the forecast. The white ring above or below it is what really happened: the line between them is the miss."
        : F.layout === "world" ? "A filled dot is the forecast share. The white ring around it is the real share: a ring bigger than the dot means it really grew more."
        : "A filled dot is the forecast. A white ring is what really happened. A line joins them: a long line is a big miss.")
      : isTest ? "A filled dot is the forecast. Choose “Both” to also see what really happened." : "A filled dot is the average of the futures.",
    `A cross shows a ${w.one} that ${w.left}.`,
  ];
  const parts = F.layer === "sample" ? ['<span><i class="disc"></i>one future</span>', '<span><i class="dash"></i>new body</span>', ...["merger", "exit", "split", "war", "coup"].filter((k) => SCEN_TYPES[F.world].includes(k) || k === "split" && F.world === "companies").map((k) => `<span style="color:${EV_COL[k]}">${EV_ICON[k]} ${EV_NAME[k].toLowerCase()}</span>`)]
    : ['<span><i class="disc"></i>simulated</span>', ...(F.show === "test" && F.layer !== "avg" ? ['<span><i class="ring"></i>what happened</span>', '<span>— gap to the real place</span>'] : []), '<span>✕ left</span>'];
  el.innerHTML = `${F.focus ? `<div class="pl-lg"><button class="on" data-g="1">${esc(F.focus)} ✕</button></div>` : ""}<div class="pl-legend ${legendMin() ? "min" : ""}"><button class="pl-lgt" type="button" title="Show or hide what the map shows">${legendMin() ? "What the map shows ▸" : "What the map shows ▾"}</button>${legendMin() ? "" : lines.map((l) => `<div>${esc(l)}</div>`).join("")}${!legendMin() && F.colour === "growth" ? '<div class="pl-gbar"><span>lost</span><i></i><span>gained</span></div>' : ""}</div>${legendMin() ? "" : `<div class="pl-key">${parts.join("")}</div>`}`;
  const b = $("[data-g]", el); if (b) b.onclick = () => { F.focus = null; fitView(); key(); draw(); };
  const t = $(".pl-lgt", el); if (t) t.onclick = () => { try { localStorage.setItem("vf-forces-legend", legendMin() ? "open" : "min"); } catch (e) { /* storage off */ } key(); };
}

// positions at the scrubber (with tweening), in the map or the orbit layout
const lerp = (a, b, t) => a + (b - a) * t;
function at(u) {
  const r = R(), n = r.frames.length, i = Math.max(0, Math.min(n - 1, Math.floor(u))), j = Math.min(n - 1, i + 1), t = Math.min(1, Math.max(0, u - i));
  const A = r.frames[i], B = r.frames[j], L = (a, b) => a.map((v, k) => lerp(v, b[k], t));
  const pick = (k) => A[k] && B[k] ? L(A[k], B[k]) : A[k];
  const xs = A.x.map((p, k) => [lerp(p[0], B.x[k][0], t), lerp(p[1], B.x[k][1], t)]);
  const rx = A.rx ? A.rx.map((p, k) => p && B.rx && B.rx[k] ? [lerp(p[0], B.rx[k][0], t), lerp(p[1], B.rx[k][1], t)] : p) : null;
  return { i: t > 0.5 ? j : i, f: t > 0.5 ? B : A, w: pick("w"), lo: (t > 0.5 ? B : A).lo, hi: (t > 0.5 ? B : A).hi, stay: pick("in"), xs, rx, rw: A.rw ? pick("rw") : null, rin: (t > 0.5 ? B : A).rin, sw: pick("s_w") };
}
function extent(r) {
  const xs = [], ys = [];
  r.frames.forEach((f) => { f.x.forEach((p) => { xs.push(p[0]); ys.push(p[1]); }); (f.rx || []).forEach((p) => { if (p) { xs.push(p[0]); ys.push(p[1]); } }); });
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
  r.ext = [q(xs, 0.004), q(xs, 0.996), q(ys, 0.004), q(ys, 0.996)];
  r.cx = (r.ext[0] + r.ext[1]) / 2; r.cy = (r.ext[2] + r.ext[3]) / 2;
}
function baseXf(W, H) {
  const r = R(), pad = Math.max(34, Math.min(W, H) * 0.09);
  if (F.layout === "orbit") { const s = Math.min(W, H) / 2 - pad; return { orbit: true, s, cx: W / 2, cy: H / 2 }; }
  const [x0, x1, y0, y1] = r.ext, s = Math.min((W - 2 * pad) / (x1 - x0 || 1), (H - 2 * pad) / (y1 - y0 || 1));
  return { s, ox: (W - (x1 - x0) * s) / 2 - x0 * s, oy: (H - (y1 - y0) * s) / 2 - y0 * s };
}
// orbit: radius from the size rank (the 500th company sits on the circle), angle from the map
function orbitPts(r, F_, wsel, b) {
  const film = F.world === "companies" ? 500 : r.bodies.length;
  const order = wsel.map((w, i) => i).sort((a, c) => wsel[c] - wsel[a]);
  const rank = new Array(wsel.length); order.forEach((i, k) => { rank[i] = wsel[i] > 0 ? k : wsel.length + 50; });
  return F_.xs.map((p, i) => { const ang = Math.atan2(p[1] - r.cy, p[0] - r.cx), rr = Math.sqrt((rank[i] + 0.5) / film) * b.s; return [b.cx + rr * Math.cos(ang), b.cy + rr * Math.sin(ang)]; });
}
function fitView() { F.view = { k: 1, ox: 0, oy: 0 }; }
async function deepLink(p) {
  if (p.w && p.w !== F.world && (p.w === "countries" || p.w === "companies")) await setWorld(p.w);
  if (p.id) { const r = R(); if (r && r.bodies.some((b) => b.id === p.id)) pickBody(p.id, true); }
  if (p.scen) { try { const s = JSON.parse(decodeURIComponent(escape(atob(p.scen)))); scenarioFor(s.target || "all", s); } catch (e) { toast("That scenario link could not be read"); } }
}
function pickBody(id, centre) {
  F.pick = id; tab("bodies");
  try { history.replaceState(null, "", `#particles?w=${F.world}&id=${encodeURIComponent(id)}`); } catch (e) { /* file:// */ }
  draw(); if (centre) { const r = R(), i = r.bodies.findIndex((b) => b.id === id); if (i >= 0) { centreOn(i); draw(); } } bodies();
}
function drawTrail(g, r, pi, layer, toPx, W, H) {
  const key = [F.world, F.layout, layer, F.pick, W, H, F.show].join("|");
  if (!F.trail || F.trail.key !== key) {
    const pts = [];
    for (let f = 0; f < r.frames.length; f++) {
      const Fr = at(f), w = layer === "real" ? Fr.rw : layer === "sample" ? Fr.sw : Fr.w;
      if (!w || !(w[pi] > 0)) { pts.push(null); continue; }
      if (F.layout === "growth" || F.layout === "world") pts.push(planePts(r, Fr, w, W, H).pts[pi]);
      else pts.push(Fr.xs[pi] || null);                   // map positions: toPx applies the map transform
    }
    F.trail = { key, pts };
  }
  const n = Math.floor(F.u) + 1, P = F.trail.pts.slice(0, n).map((p) => p && toPx(p));
  g.save(); g.strokeStyle = "rgba(255,211,0,.75)"; g.fillStyle = "#ffd300"; g.lineWidth = 1.6; g.beginPath();
  let started = false;
  P.forEach((p) => { if (!p) { started = false; return; } if (!started) { g.moveTo(p[0], p[1]); started = true; } else g.lineTo(p[0], p[1]); });
  g.stroke();
  P.forEach((p, k) => { if (!p) return; g.globalAlpha = 0.35 + 0.65 * (k + 1) / P.length; g.beginPath(); g.arc(p[0], p[1], 2.2, 0, 7); g.fill(); });
  const first = P.findIndex((p) => p);
  if (first >= 0 && n > 1) { g.globalAlpha = 0.9; g.font = "10px 'JetBrains Mono', monospace"; g.textAlign = "left"; g.fillText((r.frames[first].date || "").slice(0, 4), P[first][0] + 5, P[first][1] - 5); }
  g.restore();
}
// "Growth vs size" and "World": positions that mean something. Returns screen points before the zoom/pan transform.
function planePts(r, Fr, wMain, W, H) {
  const pad = 46;
  if (F.layout === "world") {
    const geo = (F.info[F.world] || {}).geo || {};
    if (!r.wpts || r.wptsW !== W || r.wptsH !== H) {
      const lon0 = -170, lon1 = 190, lat0 = -58, lat1 = 80, s = Math.min((W - 2 * pad) / (lon1 - lon0), (H - 2 * pad) / (lat1 - lat0));
      const ox = (W - (lon1 - lon0) * s) / 2, oy = (H - (lat1 - lat0) * s) / 2;
      let miss = 0;
      const Pp = r.bodies.map((b) => { const q = geo[b.id]; if (!q) { miss++; return [pad + miss * 9, H - 14]; } let lon = q[1]; if (lon < lon0) lon += 360; return [ox + (lon - lon0) * s, oy + (lat1 - q[0]) * s]; });
      const R1 = Math.min(W, H) * 0.07, rad0 = r.bodies.map((b) => Math.max(2, R1 * Math.sqrt(Math.max(b.w0, 0) / r.mw)));
      for (let it = 0; it < 60; it++) {                 // spread discs that overlap (capitals of small neighbours sit close)
        let moved = 0;
        for (let i = 0; i < Pp.length; i++) for (let j = i + 1; j < Pp.length; j++) {
          const dx = Pp[j][0] - Pp[i][0], dy = Pp[j][1] - Pp[i][1], d = Math.hypot(dx, dy) || 0.01, m = rad0[i] + rad0[j] + 0.8;
          if (d < m) { const push = (m - d) / 2, ux = dx / d, uy = dy / d, a = rad0[j] / (rad0[i] + rad0[j]); Pp[i][0] -= ux * push * 2 * a; Pp[i][1] -= uy * push * 2 * a; Pp[j][0] += ux * push * 2 * (1 - a); Pp[j][1] += uy * push * 2 * (1 - a); moved++; }
        }
        if (!moved) break;
      }
      r.wpts = Pp; r.wptsW = W; r.wptsH = H; r.wR1 = R1; r.wxf = { s, ox, oy, lon0, lat1 };
    }
    return { pts: r.wpts.map((p) => [p[0], p[1]]), rpts: r.wpts.map((p) => [p[0], p[1]]), R1: r.wR1, kind: "world" };
  }
  if (!r.gax) {                                     // the axes of "Growth vs size", fixed for this result
    const xs = r.bodies.filter((b) => b.w0 > 0).map((b) => Math.log10(b.w0)).sort((a, b) => a - b), ls = [];
    r.frames.forEach((f) => r.bodies.forEach((b, i) => { if (b.w0 > 0) { if (f.w[i] > 0) ls.push(Math.abs(Math.log(f.w[i] / b.w0))); if (f.rw && f.rw[i] > 0) ls.push(Math.abs(Math.log(f.rw[i] / b.w0))); } }));
    ls.sort((a, b) => a - b);
    r.gax = { x0: xs[Math.floor(xs.length * 0.01)] - 0.15, x1: xs[xs.length - 1] + 0.15, Y: Math.max(0.05, ls[Math.floor(ls.length * 0.98)] || 0.5) };
  }
  const { x0, x1, Y } = r.gax, X = (w0) => pad + (Math.log10(Math.max(w0, Math.pow(10, x0))) - x0) / (x1 - x0 || 1) * (W - 2 * pad);
  const Yp = (l) => H / 2 - Math.max(-1, Math.min(1, l / Y)) * (H / 2 - pad * 0.7);
  return { pts: r.bodies.map((b, i) => [X(b.w0), Yp(wMain[i] > 0 && b.w0 > 0 ? Math.log(wMain[i] / b.w0) : -Y)]),
           rpts: r.bodies.map((b, i) => Fr.rw && Fr.rw[i] > 0 && b.w0 > 0 ? [X(b.w0), Yp(Math.log(Fr.rw[i] / b.w0))] : null),
           R1: Math.min(W, H) * 0.035, kind: "growth", X, Yp, x0, x1, Y };
}
function drawAxes(g, L, T, W, H) {
  g.save(); g.globalAlpha = 1; g.font = "500 10.5px Inter, sans-serif"; g.fillStyle = "#8b8c94"; g.strokeStyle = "rgba(255,255,255,.08)"; g.lineWidth = 1;
  if (L.kind === "growth") {
    const ticks = [-0.75, -0.5, -0.25, -0.1, 0, 0.1, 0.25, 0.5, 1, 2, 4].filter((t) => Math.abs(Math.log(1 + t)) <= L.Y * 1.001);
    g.textAlign = "left"; g.textBaseline = "middle";
    ticks.forEach((t) => { const [, y] = T([0, L.Yp(Math.log(1 + t))]); g.strokeStyle = t === 0 ? "rgba(255,255,255,.35)" : "rgba(255,255,255,.07)"; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); g.fillText((t > 0 ? "+" : "") + Math.round(t * 100) + "%", 4, y - 7); });
    g.textAlign = "center"; g.textBaseline = "bottom";
    for (let e = Math.ceil(L.x0); e <= Math.floor(L.x1); e++) { const [x] = T([L.X(Math.pow(10, e)), 0]); g.strokeStyle = "rgba(255,255,255,.06)"; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.fillText(e >= -2 ? (Math.pow(10, e + 2)).toFixed(Math.max(0, -e - 2)) + "%" : (Math.pow(10, e + 2)).toPrecision(1) + "%", x, H - 3); }
    g.textAlign = "right"; g.fillStyle = "#b9bac2"; g.fillText("size at the start (share of the whole, log) →", W - 8, H - 16);
    g.save(); g.translate(14, 60); g.rotate(-Math.PI / 2); g.textAlign = "right"; g.fillText("share gained or lost →", 0, 0); g.restore();
  } else if (L.kind === "world" && R().wxf) {
    const q = R().wxf;
    for (let lat = -30; lat <= 60; lat += 30) { const [, y] = T([0, q.oy + (q.lat1 - lat) * q.s]); g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    for (let lon = -150; lon <= 180; lon += 30) { const [x] = T([q.ox + (lon - q.lon0) * q.s, 0]); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    const [, ye] = T([0, q.oy + q.lat1 * q.s]); g.strokeStyle = "rgba(255,255,255,.16)"; g.beginPath(); g.moveTo(0, ye); g.lineTo(W, ye); g.stroke();
  }
  g.restore();
}
function zoomToGroup(name) {
  if (!geo || !geo.pts) return;
  const r = R(), v = F.view, raw = geo.pts.map((p) => [(p[0] - v.ox) / v.k, (p[1] - v.oy) / v.k]);
  const idx = r.bodies.map((b, i) => b.group === name ? i : -1).filter((i) => i >= 0); if (!idx.length) return;
  const xs = idx.map((i) => raw[i][0]), ys = idx.map((i) => raw[i][1]), st = $("#fx-stagebox"), W = st.clientWidth, H = st.clientHeight;
  const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys), pad = 60;
  const k = Math.max(1, Math.min(8, (W - 2 * pad) / Math.max(1, bx1 - bx0), (H - 2 * pad) / Math.max(1, by1 - by0)));
  F.view = { k, ox: W / 2 - k * (bx0 + bx1) / 2, oy: H / 2 - k * (by0 + by1) / 2 };
}
function zoomBy(f, mx, my) {
  const st = $("#fx-stagebox"); mx = mx ?? st.clientWidth / 2; my = my ?? st.clientHeight / 2;
  const v = F.view, k2 = Math.max(0.6, Math.min(60, v.k * f)), g = k2 / v.k;
  F.view = { k: k2, ox: mx - (mx - v.ox) * g, oy: my - (my - v.oy) * g }; draw();
}
function mapInput(cv) {
  let drag = null;
  cv.addEventListener("wheel", (e) => { if (!R()) return; e.preventDefault(); const b = cv.getBoundingClientRect(); zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - b.left, e.clientY - b.top); }, { passive: false });
  cv.addEventListener("pointerdown", (e) => { if (!R()) return; cv.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, ox: F.view.ox, oy: F.view.oy, moved: false }; });
  cv.addEventListener("pointermove", (e) => {
    if (drag) { const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true; if (drag.moved) { F.view.ox = drag.ox + dx; F.view.oy = drag.oy + dy; $("#fx-tip").hidden = true; draw(); return; } }
    hover(e);
  });
  cv.addEventListener("pointerup", () => { const d = drag; drag = null; if (d && !d.moved) { if (F.hover >= 0) pickBody(R().bodies[F.hover].id, false); else { F.pick = null; bodies(); draw(); } } });
  cv.addEventListener("pointerleave", () => { if (!drag) { F.hover = -1; $("#fx-tip").hidden = true; draw(); } });
  cv.addEventListener("contextmenu", (e) => { const r = R(); if (r && F.hover >= 0) bodyMenu(e, r.bodies[F.hover]); });
  cv.addEventListener("dblclick", (e) => { const b = cv.getBoundingClientRect(); zoomBy(2, e.clientX - b.left, e.clientY - b.top); });
  cv.addEventListener("keydown", (e) => {
    const r = R(); if (!r) return;
    if (e.key === " ") { e.preventDefault(); play(); }
    else if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); F.playing = false; F.u = Math.max(0, Math.min(r.frames.length - 1, Math.round(F.u) + (e.key === "ArrowRight" ? 1 : -1))); frame(); }
  });
}
// log share change -> red (lost) . grey . green (gained); full colour at `scale` (this run's 90th percentile of |change|)
const growthColor = (ratio, scale = F.gscale || Math.log(2)) => { const t = Math.max(-1, Math.min(1, ratio / scale)), a = [150, 151, 160], c = t >= 0 ? [47, 211, 138] : [255, 59, 48], s = Math.sqrt(Math.abs(t)); return `rgb(${a.map((v, i) => Math.round(v + (c[i] - v) * s)).join(",")})`; };
function growthScale(w, w0) {                       // the change that gets full colour: the 90th percentile of |log change|
  const a = []; for (let i = 0; i < w.length; i++) if (w[i] > 0 && w0[i] > 0) a.push(Math.abs(Math.log(w[i] / w0[i])));
  if (!a.length) return Math.log(2); a.sort((x, y) => x - y); return Math.max(0.02, a[Math.floor(a.length * 0.9)] || 0.02);
}
let geo = null;
function draw() {
  const cv = $("#fx-map"), st = $("#fx-stagebox"); if (!cv || !st || !st.clientWidth || F.mode !== "learn") return;
  const dpr = window.devicePixelRatio || 1, W = st.clientWidth, H = st.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px"; }
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const r = R(); if (!r) { geo = null; return; }
  const Fr = at(F.u), b = baseXf(W, H), v = F.view, zr = Math.sqrt(v.k);
  const layer = F.layer === "real" && !Fr.rw ? "avg" : F.layer;
  const wMain = layer === "real" ? Fr.rw : layer === "sample" ? Fr.sw : Fr.w;
  const T = (p) => [p[0] * v.k + v.ox, p[1] * v.k + v.oy];
  const mapPx = (p) => T([p[0] * b.s + b.ox, p[1] * b.s + b.oy]);
  let pts, rpts = null, L = null;
  if (F.layout === "growth" || F.layout === "world") {
    L = planePts(r, Fr, wMain, W, H);
    pts = L.pts.map(T);
    if (layer === "both" && Fr.rw) rpts = L.rpts.map((p) => p ? T(p) : null);
    drawAxes(g, L, T, W, H);
  } else if (b.orbit) {
    pts = orbitPts(r, Fr, wMain, b).map(T);
    if (Fr.rw && layer !== "sample") rpts = orbitPts(r, Fr, Fr.rw, b).map(T);
    if (F.world === "companies") {                          // the edge of the film
      const [cx, cy] = T([b.cx, b.cy]);
      g.strokeStyle = "rgba(255,176,32,.55)"; g.setLineDash([5, 5]); g.lineWidth = 1.2; g.beginPath(); g.arc(cx, cy, b.s * v.k, 0, 7); g.stroke(); g.setLineDash([]);
      g.fillStyle = "rgba(255,176,32,.8)"; g.font = "600 10.5px Inter, sans-serif"; g.textAlign = "left"; g.fillText("edge of the S&P 500 (rank 500)", cx + b.s * v.k * 0.71 + 6, cy - b.s * v.k * 0.71);
    }
  } else {
    pts = (layer === "real" && Fr.rx ? Fr.rx.map((p, i) => p || Fr.xs[i]) : Fr.xs).map(mapPx);
    if (Fr.rx && layer === "both") rpts = Fr.rx.map((p, i) => p ? mapPx(p) : null);
  }
  const R0 = L ? L.R1 : Math.min(W, H) * 0.08, rad = (w) => w > 0 ? Math.max(L ? 2.2 : 1.5, R0 * Math.sqrt(w / r.mw) * zr) : 0;
  const unknown = (arr, i) => arr && arr[i] == null;            // no data yet (a country that has not reported): no ring, no cross
  const rs = wMain.map(rad);
  geo = { pts, rs };
  const order = wMain.map((w, i) => i).sort((a, c) => wMain[c] - wMain[a]);
  if (F.colour === "growth") { const sc = growthScale(wMain, r.bodies.map((q) => q.w0)); if (Math.abs(sc - (F.gscale || 0)) > 1e-4) { F.gscale = sc; key(); } }
  const dim = (i) => F.focus && r.bodies[i].group !== F.focus;
  const hidden = (i) => F.hideOthers && dim(i);
  const pi = F.pick ? r.bodies.findIndex((q) => q.id === F.pick) : -1;
  const pdim = (i) => pi >= 0 && i !== pi;                // a picked body: the others step back
  if (pi >= 0 && !b.orbit) drawTrail(g, r, pi, layer, L ? (P) => T(P) : mapPx, W, H);
  // arrivals in one possible future
  if (layer === "sample" && Fr.f.s_new && r.pool) {
    g.setLineDash([3, 3]);
    Fr.f.s_new.forEach(([k, w]) => { const pl = r.pool[k]; if (!pl) return; const [x, y] = b.orbit ? [0, 0] : mapPx(pl.x); if (b.orbit) return; g.strokeStyle = colorOf(pl.group); g.globalAlpha = 0.8; g.beginPath(); g.arc(x, y, rad(w), 0, 7); g.stroke(); });
    g.setLineDash([]);
  }
  for (const i of order) {
    if (hidden(i)) continue;
    const bd = r.bodies[i], [x, y] = pts[i], rr = rs[i], dm = dim(i);
    const fill = F.colour === "growth" ? growthColor(Math.log(Math.max(wMain[i], 1e-12) / bd.w0)) : colorOf(bd.group);
    const stay = layer === "avg" || layer === "both" ? (Fr.stay ? Fr.stay[i] : 1) : 1;
    if (!rr) { g.globalAlpha = dm ? 0.1 : 0.45; g.strokeStyle = "#c8c9ce"; g.lineWidth = 1; g.beginPath(); g.moveTo(x - 3, y - 3); g.lineTo(x + 3, y + 3); g.moveTo(x + 3, y - 3); g.lineTo(x - 3, y + 3); g.stroke(); }
    else {
      g.globalAlpha = dm ? 0.08 : (i === F.hover || bd.id === F.pick ? 0.95 : (F.colour === "growth" ? 0.85 : 0.35 + 0.45 * stay) * (pdim(i) ? 0.3 : 1)); g.fillStyle = fill; g.beginPath(); g.arc(x, y, rr, 0, 7); g.fill();
      if (stay < 0.5 && !dm) {                     // likely to leave: dashed outline and a cross (it was only a fainter disc)
        g.globalAlpha = 0.9; g.strokeStyle = "#f2f2f5"; g.lineWidth = 1.2; g.setLineDash([3, 3]); g.beginPath(); g.arc(x, y, Math.max(rr, 4) + 2, 0, 7); g.stroke(); g.setLineDash([]);
        const c = Math.max(3, rr * 0.6); g.beginPath(); g.moveTo(x - c, y - c); g.lineTo(x + c, y + c); g.moveTo(x + c, y - c); g.lineTo(x - c, y + c); g.stroke();
      }
    }
    if (rpts && Fr.rw) {
      const rp = rpts[i], r2 = rad(Fr.rw[i]);
      if (!rp && Fr.rw[i] === 0 && !dm) {          // really left, and its last real place is unknown: cross at the forecast place
        g.globalAlpha = 0.95; g.strokeStyle = "#f2f2f5"; g.lineWidth = 1.6; const c = Math.max(4, rr * 0.7);
        g.beginPath(); g.moveTo(x - c, y - c); g.lineTo(x + c, y + c); g.moveTo(x + c, y - c); g.lineTo(x - c, y + c); g.stroke();
      }
      if (rp && !unknown(Fr.rw, i)) {
        if ((L || !b.orbit) && Math.hypot(rp[0] - x, rp[1] - y) > 3) { g.globalAlpha = dm ? 0.05 : 0.35; g.strokeStyle = "#f2f2f5"; g.lineWidth = 1; g.beginPath(); g.moveTo(x, y); g.lineTo(rp[0], rp[1]); g.stroke(); }
        g.globalAlpha = dm ? 0.08 : 0.85; g.lineWidth = 1.25; g.strokeStyle = "#f2f2f5";
        if (r2) { g.beginPath(); g.arc(rp[0], rp[1], r2, 0, 7); g.stroke(); }
        else { g.beginPath(); g.moveTo(rp[0] - 4, rp[1] - 4); g.lineTo(rp[0] + 4, rp[1] + 4); g.moveTo(rp[0] + 4, rp[1] - 4); g.lineTo(rp[0] - 4, rp[1] + 4); g.stroke(); }
      }
    }
    if (bd.id === F.pick) { g.globalAlpha = 1; g.strokeStyle = "#ffd300"; g.lineWidth = 2; g.beginPath(); g.arc(x, y, Math.max(rr, 4) + 4, 0, 7); g.stroke(); }
    g.lineWidth = 1;
  }
  // events of one possible future at this step: a mark on the body
  if (layer === "sample") {
    const evs = r.evByStep[Math.round(F.u)] || [];
    g.globalAlpha = 1; g.font = "700 13px Inter, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    evs.forEach((e) => {
      const i = r.bodies.findIndex((x) => x.id === e.id); if (i < 0) return;
      const [x, y] = pts[i]; g.fillStyle = EV_COL[e.type] || "#fff"; g.fillText(EV_ICON[e.type] || "•", x, y - Math.max(rs[i], 4) - 8);
      if (e.type === "merger" && e.by) { const j = r.bodies.findIndex((q) => q.id === e.by); if (j >= 0) { g.strokeStyle = EV_COL.merger; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, y); g.lineTo(pts[j][0], pts[j][1]); g.stroke(); } }
    });
  }
  // labels: biggest first, no overlaps
  g.globalAlpha = 1; g.textAlign = "center"; g.textBaseline = "middle";
  const boxes = []; let n = 0, rank = 0;
  for (const i of order) {
    if (n > 70) break;
    const rr = rs[i], bd = r.bodies[i]; rank++;
    if ((rr < 8 && rank > 15 && bd.id !== F.pick && i !== F.hover) || dim(i)) continue;
    const t = rr > 26 && bd.name.length < 22 ? bd.name : bd.id; g.font = `600 ${rr > 26 ? 12 : 11}px Inter, sans-serif`;
    const tw = g.measureText(t).width + 6, [x, y] = pts[i], ly = rr >= 14 ? y : y - rr - 8, bx = [x - tw / 2, ly - 7, x + tw / 2, ly + 7];
    if (boxes.some((q) => bx[0] < q[2] && bx[2] > q[0] && bx[1] < q[3] && bx[3] > q[1])) continue;
    boxes.push(bx); n++;
    g.fillStyle = rr >= 14 ? "#fff" : "#d6d7dc"; g.shadowColor = "rgba(0,0,0,.8)"; g.shadowBlur = 3; g.fillText(t, x, ly); g.shadowBlur = 0;
  }
  const f = Fr.f, date = (f.date || "").slice(0, F.info[F.world].step === "year" ? 4 : 7);
  $("#fx-fr").textContent = `${date} · step ${Fr.i} of ${r.frames.length - 1}`;
  $("#fx-mmeta").textContent = `${{ growth: "across = size at the start · up = share gained", world: "each country at its capital", orbit: "orbit: distance = size rank", map: "co-movement" }[F.layout] || ""} · disc = share${v.k > 1.05 ? ` · ×${v.k.toFixed(1)}` : ""}`;
}
function hover(e) {
  const r = R(); if (!geo || !r) return;
  const b = e.currentTarget.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
  let best = -1, bd = 1e9;
  geo.pts.forEach(([px, py], i) => { const d = Math.hypot(px - x, py - y) - Math.max(geo.rs[i], 3); if (d < bd && d < 6) { bd = d; best = i; } });
  if (best !== F.hover) { F.hover = best; draw(); }
  const tip = $("#fx-tip");
  if (best < 0) { tip.hidden = true; return; }
  const q = r.bodies[best], Fr = at(F.u);
  tip.hidden = false; tip.style.left = Math.min(x + 14, b.width - 260) + "px"; tip.style.top = Math.min(y + 14, b.height - 120) + "px";
  const real = Fr.rw ? Fr.rw[best] : null, fc = Fr.w[best];
  const say = [`${esc(q.name)} had ${pct(q.w0, 2)} ${esc(W().of)} at the start.`, `The forecast here is ${pct(fc, 2)}.`]
    .concat(real == null ? [] : real > 0 ? [`It really had ${pct(real, 2)}: ${Math.abs(real - fc) < 0.1 * Math.max(real, fc) ? "close to the forecast" : real > fc ? "more than the forecast" : "less than the forecast"}.`] : [`It really ${esc(W().left)}.`]);
  tip.innerHTML = `<b>${esc(q.name)}</b> <span class="dim">${esc(q.id)} · ${esc(q.group)}${q.est ? " · size estimated" : ""}</span>
    <p class="pl-say">${say.join(" ")}</p>
    <div class="kv"><span>start</span><b>${pct(q.w0, 2)}</b><span></span><span>simulated</span><b class="amber">${pct(Fr.w[best], 2)}</b><span class="dim">${pct(Fr.lo[best], 2)}–${pct(Fr.hi[best], 2)}</span>
    ${Fr.stay ? `<span>chance to stay</span><b>${pct(Fr.stay[best], 0)}</b><span></span>` : ""}${Fr.rw ? `<span>really</span><b class="blue">${Fr.rw[best] == null ? "no data yet" : Fr.rw[best] > 0 ? pct(Fr.rw[best], 2) : "left"}</b><span></span>` : ""}</div><div class="dim">Click to follow it.</div>`;
}

// ---------------------------------------------------------------- time
function frame() {
  const r = R(); if (!r) return;
  const sc = $("#fx-scrub"); sc.max = r.frames.length - 1; sc.value = F.u;
  if (F.playing && F.pick && F.layout !== "world") { draw(); const i = r.bodies.findIndex((b) => b.id === F.pick); if (i >= 0) centreOn(i); }   // follow it
  draw(); groups(); timeline(); bodyChart(); bodyNums();
}
function play() {
  const r = R(); if (!r) return;
  if (F.playing) { F.playing = false; $("#fx-play").innerHTML = icon("play"); return; }
  if (F.u >= r.frames.length - 1.001) F.u = 0;
  F.playing = true; $("#fx-play").innerHTML = icon("pause");
  const sps = Math.max(1.5, Math.min(12, (r.frames.length - 1) / 8)); let last = performance.now();
  const tick = (now) => {
    if (!F.playing || R() !== r) { $("#fx-play").innerHTML = icon("play"); return; }
    F.u = Math.min(r.frames.length - 1, F.u + (now - last) / 1000 * sps); last = now; frame();
    if (F.u >= r.frames.length - 1) { F.playing = false; $("#fx-play").innerHTML = icon("play"); return; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
// the track above the scrubber: real events (top row, test only) and the events of one possible future (bottom row)
let tlMarks = [];
function timeline() {
  const cv = $("#fx-tl"), r = R(); if (!cv) return;
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight; if (!W) return;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H); tlMarks = [];
  if (!r) return;
  const n = r.frames.length - 1, X = (s) => 8 + (n ? s / n : 0) * (W - 16);
  g.fillStyle = F.show === "test" ? "rgba(63,169,245,.10)" : "rgba(255,176,32,.08)"; g.fillRect(0, 0, W, H);
  const put = (s, typ, row, ev) => { const x = X(s), y = row ? H - 4 : 5; g.fillStyle = EV_COL[typ] || "#aaa"; g.fillRect(x - 1, y - 3, 2, 6); tlMarks.push({ x, y, s, ev }); };
  if (F.show === "test" && r.events) r.events.forEach((e) => e.list.forEach((x) => { const s = r.frames.findIndex((f) => f.date >= x.date); if (s >= 0) put(s, e.type, 0, { ...x, type: e.type, real: true }); }));
  Object.entries(r.evByStep).forEach(([s, list]) => list.forEach((e) => { if (e.type !== "entry") put(+s, e.type, 1, e); }));
}
function tlClick(e) {
  const b = e.currentTarget.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
  let best = null, bd = 9;
  tlMarks.forEach((m) => { const d = Math.hypot(m.x - x, m.y - y); if (d < bd) { bd = d; best = m; } });
  if (!best) return;
  F.u = best.s; F.playing = false;
  if (!best.ev.real) { F.layer = "sample"; seg("#fx-layer", "layer", () => { key(); draw(); }); key(); }
  const i = R().bodies.findIndex((q) => q.id === best.ev.id);
  if (i >= 0) { F.pick = best.ev.id; centreOn(i); tab("bodies"); }
  frame();
}

// ---------------------------------------------------------------- groups
function groups() {
  const r = R(), box = $("#fx-groups");
  if (!r) { box.innerHTML = `<div class="hint">The groups appear after a test or a projection.</div>`; return; }
  $("#fx-gt").textContent = F.info[F.world].group_name.charAt(0).toUpperCase() + F.info[F.world].group_name.slice(1) + "s";
  const fi = Math.round(F.u), f = r.frames[fi], gn = r.group_names, g0 = r.frames[0].g;
  const real = f.rg ? gn.map((g) => f.rg[g] || 0) : null;
  const order = gn.map((g, k) => k).sort((a, b) => g0[b] - g0[a]).slice(0, 12);
  const mx = Math.max(...order.map((k) => Math.max(g0[k], ...r.frames.map((q) => q.g_hi[k]), ...r.frames.map((q) => q.rg ? q.rg[gn[k]] || 0 : 0))), 1e-9);
  const bar = (v, cls) => `<i class="${cls}" style="width:${(100 * v / mx).toFixed(1)}%"></i>`;
  const key_ = r.t0 + F.show + r.frames.length;
  if (box.dataset.for !== key_) {
    box.dataset.for = key_;
    box.innerHTML = `<div class="pl-glist">${order.map((k) => `<div class="pl-g" data-gk="${k}"><span class="nm" title="${esc(gn[k])}"><b style="background:${colorOf(gn[k])}"></b>${esc(gn[k])}</span>
      <span class="bars" id="fx-gb${k}"></span><canvas class="spark" id="fx-gs${k}"></canvas><span class="v" id="fx-gv${k}"></span></div>`).join("")}</div>`;
    $$("#fx-groups [data-gk]").forEach((e) => e.onclick = () => { const gname = gn[+e.dataset.gk]; F.focus = F.focus === gname ? null : gname; key(); draw(); });
  }
  order.forEach((k) => {
    $("#fx-gb" + k).innerHTML = bar(g0[k], "a") + bar(f.g[k], "b") + (real ? bar(real[k], "c") : "");
    $("#fx-gv" + k).innerHTML = `${pct(g0[k])} → <b>${pct(f.g[k])}</b>${real ? ` · <span class="${Math.abs(f.g[k] - real[k]) < Math.abs(g0[k] - real[k]) ? "good" : "bad"}">${pct(real[k])}</span>` : ""}`;
    spark($("#fx-gs" + k), r.frames.map((q) => q.g[k]), r.frames.map((q) => q.rg ? q.rg[gn[k]] || 0 : null), fi, g0[k], [r.frames.map((q) => q.g_lo[k]), r.frames.map((q) => q.g_hi[k])]);
  });
}
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

// ---------------------------------------------------------------- bodies
function centreOn(i) {
  const st = $("#fx-stagebox"), W = st.clientWidth, H = st.clientHeight;
  if (!geo || !geo.pts || !geo.pts[i]) return;
  const v = F.view, sx = (geo.pts[i][0] - v.ox) / v.k, sy = (geo.pts[i][1] - v.oy) / v.k, k = Math.max(v.k, 2.5);
  F.view = { k, ox: W / 2 - k * sx, oy: H / 2 - k * sy };
}
async function predictors() {
  const el = $("#fx-pred");
  if (F.world !== "countries") { el.innerHTML = '<div class="hint">The predictor table is for countries for now. Company fundamentals (revenue, margins, debt) come from SEC filings and are not loaded yet.</div>'; return; }
  if (!F.pred) { el.innerHTML = '<div class="hint">testing every series from every start year…</div>'; try { F.pred = (await callModel("forces.predictors", { world: "countries" })).result; } catch (e) { el.innerHTML = `<div class="hint">${esc(e.message)}</div>`; return; } }
  const P = F.pred, used = { "SP.POP.1564.TO.ZS": "demography", "SP.DYN.LE00.IN": "health", "NE.GDI.TOTL.ZS": "investment", "__income": "catchup" };
  const m = F.model.countries, verdict = (k) => { const t = m && m.terms.find((x) => x.k === k); return t ? t.verdict : null; };
  const bar = (s) => { if (!s) return '<span class="dim">—</span>'; const v = s.mean, w = Math.min(100, Math.abs(v) / 0.3 * 100);
    return `<div class="pr-bar" title="t ${s.t}, same sign in ${Math.round(s.same_sign * 100)}% of ${s.starts} start years"><i class="${v < 0 ? "neg" : "pos"}" style="width:${w / 2}%;${v < 0 ? `right:50%` : `left:50%`}"></i></div><span class="mono">${v >= 0 ? "+" : ""}${v.toFixed(2)}</span>`; };
  el.innerHTML = `<p class="hint">Does a country's value of each series rank its <b>${esc(P.target)}</b>? One rank correlation per start year (${P.series[0].first}–${P.series[0].last}). <b>Beyond income</b> removes what income per person already explains (catch-up is already a force). The three strongest beyond income (working-age share, life expectancy, investment) were tested as forces: they ranked the unseen years a little better (+0.35 against +0.30) but raised the forecast error at 1, 3 and 5 years, so the model does not use them. Energy per person tracks how rich a country is, not how fast it will grow.</p>
    <table class="pf-tb pr-t"><tr><th>Series</th><th>on its own</th><th>beyond income</th><th>force</th></tr>
    ${P.series.map((s) => { const k = used[s.code], v = k ? verdict(k) : null;
      return `<tr><th title="${esc(s.unit || "")} · World Bank ${esc(s.code)}">${esc(s.name)}</th><td>${bar(s.raw)}</td><td>${bar(s.beyond_income)}</td><td>${k && !v && k !== "catchup" ? '<span class="fx-chip" title="Tested as a force on 2026-10-17: it ranked growth a little better but raised the forecast error at 1, 3 and 5 years, so it is not in the model">tested · not adopted</span>' : k ? `<span class="fx-chip ${v === "helps" ? "good" : v === "dropped" ? "bad" : ""}">${v === "dropped" ? "off · it hurt" : v || "in the model"}</span>` : '<span class="dim">not used</span>'}</td></tr>`; }).join("")}</table>
    <p class="hint">${esc(P.note)}</p>`;
}
function good() {
  const el = $("#fx-good"); if (F.tab !== "good") return;
  const r = (F.res[F.world] || {}).test, w = W();
  if (!r) { el.innerHTML = '<div class="empty">Run the test (stage 3) to see how good the forecast was.</div>'; return; }
  const f = r.frames[r.frames.length - 1], B = r.bodies;
  let inb = 0, tot = 0, inw = 0, totw = 0, ok = 0, dn = 0, above = 0, below = 0; const pts = [], miss = [];
  B.forEach((b, i) => {
    const rw = f.rw ? f.rw[i] : null; if (rw == null || !(rw > 0) || !(b.w0 > 0)) return;
    tot++; totw += b.w0;
    if (rw >= f.lo[i] && rw <= f.hi[i]) { inb++; inw += b.w0; } else if (rw > f.hi[i]) above++; else below++;
    const df = f.w[i] / b.w0 - 1, dr = rw / b.w0 - 1;
    if (Math.abs(dr) > 1e-9 && Math.abs(df) > 1e-9) { dn++; if (Math.sign(df) === Math.sign(dr)) ok++; }
    pts.push([dr, df, i]); miss.push({ i, d: f.w[i] - rw });
  });
  const steps = r.frames.slice(1).map((fr) => { let a = 0, n = 0; B.forEach((b, i) => { const rw = fr.rw ? fr.rw[i] : null; if (rw > 0) { n++; if (rw >= fr.lo[i] && rw <= fr.hi[i]) a++; } }); return [(fr.date || "").slice(0, 7), n ? a / n : null]; });
  miss.sort((a, c) => Math.abs(c.d) - Math.abs(a.d));
  el.innerHTML = `<div class="pl-good">
    <p><b>${Math.round(100 * inb / Math.max(1, tot))}%</b> of ${w.many} ended inside the forecast band (p10–p90). A well-calibrated band holds <b>80%</b>.
      Weighted by size: ${Math.round(100 * inw / Math.max(1e-12, totw))}%. ${above > below * 1.5 ? `Most misses were <b>above</b> the band (${above} vs ${below}): the forecast was too low for the ${w.many} that grew.` : below > above * 1.5 ? `Most misses were <b>below</b> the band (${below} vs ${above}): the forecast was too high.` : ""}</p>
    <p>The forecast got the <b>direction</b> of the change right for <b>${Math.round(100 * ok / Math.max(1, dn))}%</b> of ${w.many} (a coin gets 50%).</p>
    <div class="sec-t">Forecast vs what happened · share change, ${esc(r.t0.slice(0, 7))} → ${esc(r.t1.slice(0, 7))}</div>
    <canvas id="fx-goodc" width="300" height="230"></canvas>
    <div class="hint">One dot per ${w.one}. On the diagonal = a perfect forecast. Right of centre = it really grew.</div>
    <div class="sec-t">Inside the band, by step</div><div class="pl-cov">${steps.map(([d, c]) => `<span title="${d}"><i style="height:${Math.round((c || 0) * 100)}%"></i><b>${c == null ? "—" : Math.round(c * 100) + "%"}</b><small>${d}</small></span>`).join("")}</div>
    <div class="sec-t">Biggest misses (share points)</div>
    <div class="list">${miss.slice(0, 10).map(({ i, d }) => `<div class="li pl-b" data-i="${i}"><div class="tx"><div class="nm">${esc(B[i].name)}</div><div class="sub">forecast <b class="amber">${pct(f.w[i], 2)}</b> · real <b class="blue">${pct(f.rw[i], 2)}</b> · ${d > 0 ? "too high" : "too low"} by ${pct(Math.abs(d), 2)}</div></div></div>`).join("")}</div></div>`;
  $$("#fx-good [data-i]").forEach((x) => x.onclick = () => pickBody(B[+x.dataset.i].id, true));
  const cv = $("#fx-goodc"), g = cv.getContext("2d"), Wc = cv.width, Hc = cv.height, lim = Math.max(0.1, ...pts.map((p) => Math.min(2, Math.max(Math.abs(p[0]), Math.abs(p[1]))))) * 1.05;
  const sx = (v) => Wc / 2 + Math.max(-1, Math.min(1, v / lim)) * (Wc / 2 - 14), sy = (v) => Hc / 2 - Math.max(-1, Math.min(1, v / lim)) * (Hc / 2 - 14);
  g.fillStyle = "#0c0c0f"; g.fillRect(0, 0, Wc, Hc); g.strokeStyle = "rgba(255,255,255,.12)"; g.beginPath(); g.moveTo(sx(-lim), sy(0)); g.lineTo(sx(lim), sy(0)); g.moveTo(sx(0), sy(-lim)); g.lineTo(sx(0), sy(lim)); g.stroke();
  g.strokeStyle = "rgba(47,211,138,.6)"; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(sx(-lim), sy(-lim)); g.lineTo(sx(lim), sy(lim)); g.stroke(); g.setLineDash([]);
  pts.forEach(([dr, df, i]) => { g.fillStyle = colorOf(B[i].group); g.globalAlpha = 0.8; g.beginPath(); g.arc(sx(dr), sy(df), 2 + 6 * Math.sqrt(B[i].w0 / r.mw), 0, 7); g.fill(); });
  g.globalAlpha = 1; g.fillStyle = "#9a9ba3"; g.font = "10px Inter, sans-serif"; g.textAlign = "right"; g.fillText("real change →", Wc - 4, Hc / 2 - 4); g.textAlign = "left"; g.fillText("forecast change ↑", sx(0) + 4, 11);
}
function bodies() {
  const el = $("#fx-bodies"), r = R(); if (F.tab !== "bodies") return;
  if (!r) { el.innerHTML = '<div class="empty">The bodies appear after a test or a projection.</div>'; return; }
  const pi = F.pick ? r.bodies.findIndex((b) => b.id === F.pick) : -1;
  const q = (F.bq || "").toLowerCase();
  const rows = r.bodies.map((b, i) => ({ ...b, i })).filter((b) => !q || b.name.toLowerCase().includes(q) || b.id.toLowerCase().includes(q)).sort((a, b) => b.w0 - a.w0);
  el.innerHTML = `${pi >= 0 ? `<div class="pl-det" id="fx-det"></div>` : `<div class="hint pl-pickhint">Click a body on the map, or below, to follow it.</div>`}
    <div class="pl-sorts"><input class="in sm" id="fx-bq" placeholder="Find a body…" value="${esc(F.bq || "")}"></div>
    <div class="list">${rows.slice(0, 120).map((b) => `<div class="li pl-b ${b.id === F.pick ? "on" : ""}" data-i="${b.i}"><b class="dot" style="background:${F.colour === "growth" && b.w0 > 0 && b.w > 0 ? growthColor(Math.log(b.w / b.w0)) : colorOf(b.group)}"></b><div class="tx"><div class="nm">${esc(b.name)} <span class="dim">${esc(b.id)}</span></div>
      <div class="sub">${pct(b.w0, 2)} → <b class="amber">${pct(b.w, 2)}</b> <span class="dim">(${pct(b.lo, 2)}–${pct(b.hi, 2)})</span>${"rw" in b ? ` · really ${b.rw == null ? '<span class="dim">no data yet</span>' : b.rw > 0 ? `<b class="blue">${pct(b.rw, 2)}</b>` : '<span class="bad">left</span>'}` : ""}${b.stay < 0.95 ? ` · ${pct(1 - b.stay, 0)} leave` : ""}</div></div></div>`).join("")}</div>`;
  const bq = $("#fx-bq"); bq.oninput = () => { F.bq = bq.value; const pos = bq.selectionStart; bodies(); const n = $("#fx-bq"); n.focus(); n.setSelectionRange(pos, pos); };
  $$("#fx-bodies [data-i]").forEach((e) => { e.onclick = () => { F.pick = r.bodies[+e.dataset.i].id; centreOn(+e.dataset.i); bodies(); draw(); }; e.oncontextmenu = (ev) => bodyMenu(ev, r.bodies[+e.dataset.i]); });
  if (pi >= 0) {
    const b = r.bodies[pi];
    $("#fx-det").innerHTML = `<div class="pl-dh"><b style="background:${colorOf(b.group)}"></b><div><div class="nm">${esc(b.name)}</div><div class="dim">${esc(b.id)} · ${esc(b.group)}${b.est ? " · size estimated" : ""}</div></div><button class="iconbtn" id="fx-unpick" title="Stop">${icon("x")}</button></div>
      <div class="pl-detc"><canvas id="fx-bc"></canvas></div><div class="pl-leg"><span><i class="b"></i>simulated (p10–p90 shaded)</span>${F.show === "test" ? '<span><i class="c"></i>what happened</span>' : ""}</div>
      <div class="kv pl-dkv" id="fx-dkv"></div>
      <div class="pl-why" id="fx-why"></div>
      <button class="btn sm block" id="fx-fut" data-primary title="Thousands of futures from its growth regimes, blended with ${W().many} like it; then try more volatility or stability, and compare with the ${F.world === "countries" ? "World Bank and IMF" : "analysts"}">${icon("spark")} Simulate its future</button>
      <button class="btn ghost xs block" id="fx-mc" title="Its size history as a Data Desk table, in the general Simulate app">Open its history in Simulate</button>${bodyEvents(b)}`;
    $("#fx-unpick").onclick = () => { F.pick = null; bodies(); draw(); };
    $("#fx-fut").onclick = () => futuresOf(b);
    $("#fx-mc").onclick = async () => {
      const bt = $("#fx-mc"); bt.disabled = true; bt.textContent = "making its history table…";
      try { const r = await callModel("forces.series", { world: F.world, id: b.id }); go("simulate", { engine: "series", table: r.result.table, col: r.result.col, delta: "log", horizon: r.result.step === "year" ? 10 : 36 }); }
      catch (e) { fail(e); bt.disabled = false; bt.textContent = "Open its history in Simulate"; }
    };
    bodyChart(); bodyNums(); whyOf(b);
  }
}
const ASKS = {
  countries: [
    { q: "Which countries will gain share of the world economy by 2030?", a: "the learned forces, run forward to the end", go: () => { stage("project"); setTimeout(() => { const r = R(); if (r) { F.u = r.frames.length - 1; const sc = $("#fx-scrub"); if (sc) sc.value = F.u; frame(); } }, 600); F.layout = "growth"; F.colour = "growth"; save(); seg("#fx-layout", "layout", () => { fitView(); key(); draw(); }); seg("#fx-colour", "colour", () => { key(); draw(); bodies(); }); fitView(); key(); draw(); } },
    { q: "How sure can anyone be about Indonesia's future?", a: "4,000 futures, next to the IMF and the World Bank", go: () => { const r = R(); const b = r && r.bodies.find((x) => x.id === "IDN"); if (b) { pickBody("IDN", true); futuresOf(b); } } },
    { q: "What if China slows sharply? Who else gets hurt?", a: "a scenario for East Asia, with spillover you choose", go: () => scenarioFor("group:East Asia & Pacific", { name: "China slows sharply", changes: [{ target: "CHN", kind: "shock", from: 2, value: -0.08, spill: 0.25 }, { target: "CHN", kind: "growth", from: 2, to: 10, value: -0.015, spill: 0.2 }] }) },
  ],
  companies: [
    { q: "Which companies were forecast to gain share, and were they right?", a: "the test on months the forces never saw", go: () => { stage("test"); F.layer = "both"; save(); draw(); tab("good"); } },
    { q: "Where could Nvidia's share be in three years, and what do analysts say?", a: "futures from its own past and companies like it, with live analyst targets", go: () => { const r = R(); const b = r && r.bodies.find((x) => x.id === "NVDA"); if (b) { pickBody("NVDA", true); futuresOf(b); } } },
    { q: "What if AI spending cools?", a: "a scenario for Information Technology", go: () => scenarioFor("group:Information Technology", { name: "AI spending cools", changes: [{ target: "group:Information Technology", kind: "growth", from: 1, to: 36, value: -0.01 }] }) },
  ],
};
function askCard() {
  const el = $("#fx-ask"); if (!el) return;
  let off = false; try { off = localStorage.getItem("vf.pl.ask") === "off"; } catch (e) { /* private window */ }
  const L = ASKS[F.world] || [];
  el.hidden = false;
  el.classList.toggle("folded", off);
  el.innerHTML = off ? `<button class="btn ghost xs" id="fx-ask-open">${icon("spark")} Start with a question</button>`
    : `<div class="pl-ask-h"><b>Start with a question</b><button class="iconbtn" id="fx-ask-x" title="Fold">${icon("x")}</button></div>
      ${L.map((x, i) => `<button class="pl-ask-q" data-i="${i}"><span>${esc(x.q)}</span><small>${esc(x.a)}</small></button>`).join("")}`;
  const set = (v) => { try { localStorage.setItem("vf.pl.ask", v); } catch (e) { /* ignore */ } askCard(); };
  if (off) $("#fx-ask-open").onclick = () => set("on");
  else { $("#fx-ask-x").onclick = () => set("off"); $$(".pl-ask-q", el).forEach((b) => b.onclick = () => { set("off"); L[+b.dataset.i].go(); }); }
}
function futuresOf(b) { openFutures($("#fx-stagebox"), F.world, b.id, b.name); }
function scenarioFor(target, init = {}) {
  const info = F.info[F.world] || {}, r = R();
  const bodies = r ? r.bodies.map((b) => ({ id: b.id, name: b.name, group: b.group })) : [];
  openScenario($("#fx-stagebox"), F.world, info.groups || [], bodies, { target, ...init });
}
function bodyMenu(e, b) {                              // right-click: the same actions as the card, as a shortcut
  e.preventDefault();
  const at = { getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX + 1, top: e.clientY, bottom: e.clientY }) };
  menu(at, [{ label: "Simulate its future", sub: `futures from its own past and ${W().many} like it`, icon: "spark", run: () => { pickBody(b.id, false); futuresOf(b); } },
    { label: F.world === "countries" ? "Compare with the World Bank and IMF" : "Compare with the analysts", sub: F.world === "countries" ? "their growth forecasts on its futures" : "live consensus targets on its futures", icon: "trend", run: () => { pickBody(b.id, false); futuresOf(b); setTimeout(() => { const d = document.getElementById("pf-more"); if (d) d.open = true; }, 50); } },
    { label: "Build a scenario around it", sub: `a change for ${b.name}, its effect on its ${F.world === "countries" ? "region" : "sector"}`, icon: "states", run: () => scenarioFor("group:" + b.group, { changes: [{ target: b.id, kind: "growth", from: 1, to: F.world === "countries" ? 10 : 36, value: -0.01, spill: 0 }] }) },
    { label: "Follow " + b.name, sub: "centre it and keep it centred while playing", icon: "eye", run: () => pickBody(b.id, true) },
    { label: "Its events", sub: "wars, coups, crashes, deals in the data", icon: "bolt", run: () => { pickBody(b.id, false); tab("bodies"); } }]);
}
async function whyOf(b) {                              // which forces push this body, and how hard (the Democracy-style "why")
  const el = $("#fx-why"); if (!el) return;
  const kind = F.show === "test" ? "test" : "project", key = F.world + "|" + b.id + "|" + kind;
  if (!F.whyc) F.whyc = {};
  let r = F.whyc[key];
  if (!r) { el.innerHTML = '<div class="dim">why: working it out…</div>'; try { r = F.whyc[key] = (await callModel("forces.why", { world: F.world, id: b.id, kind })).result; } catch (e) { el.innerHTML = ""; return; } }
  if (!$("#fx-why") || F.pick !== b.id) return;
  const mx = Math.max(0.002, ...r.parts.map((p) => Math.abs(p.per_year))), pts = (v) => (v >= 0 ? "+" : "") + (v * 100).toFixed(2);
  el.innerHTML = `<div class="sec-t">Why it is forecast to ${r.total >= 0 ? "gain" : "lose"} share <span class="dim">· at ${esc(r.at.slice(0, 7))}, points a year</span></div>
    ${r.parts.filter((p) => Math.abs(p.per_year) >= 0.0002).slice(0, 7).map((p) => `<div class="why-r" title="${esc(helpText(p.k))}"><span>${esc(p.label)}</span><i class="${p.per_year < 0 ? "neg" : "pos"}" style="width:${Math.abs(p.per_year) / mx * 45}%;${p.per_year < 0 ? "right:50%" : "left:50%"}"></i><b>${pts(p.per_year)}</b></div>`).join("")}
    <div class="why-r tot"><span>All forces together</span><b>${pts(r.total)}</b></div>`;
}
function helpText(k) { const t = (F.info[F.world] && F.info[F.world].terms || []).find((x) => x.k === k); return t ? t.help : ""; }
function bodyEvents(b) {
  const list = (F.ledger || []).filter((e) => e.id === b.id || e.by === b.id).slice(-12);
  return list.length ? `<div class="sec-t" style="margin-top:10px">Events in the data</div><div class="fx-elist">${list.map((e) => `<div><i style="color:${EV_COL[e.type]}">${EV_ICON[e.type] || "•"}</i><span class="mono dim">${esc(e.date.slice(0, 7))}</span> ${esc(e.text || EV_NAME[e.type])}</div>`).join("")}</div>` : "";
}
function bodyChart() {
  const r = R(), cv = $("#fx-bc"); if (!r || !cv || !F.pick) return;
  const i = r.bodies.findIndex((b) => b.id === F.pick); if (i < 0) return;
  spark(cv, r.frames.map((f) => f.w[i]), r.frames.map((f) => f.rw ? f.rw[i] : null), Math.round(F.u), r.bodies[i].w0, [r.frames.map((f) => f.lo[i]), r.frames.map((f) => f.hi[i])]);
}
function bodyNums() {
  const r = R(), el = $("#fx-dkv"); if (!r || !el || !F.pick) return;
  const i = r.bodies.findIndex((b) => b.id === F.pick); if (i < 0) return;
  const f = r.frames[Math.round(F.u)];
  el.innerHTML = `<span>at</span><b>${esc((f.date || "").slice(0, 7))}</b><span>start</span><b>${pct(r.bodies[i].w0, 2)}</b><span>simulated</span><b class="amber">${pct(f.w[i], 2)} <span class="dim">${pct(f.lo[i], 2)}–${pct(f.hi[i], 2)}</span></b>
    ${f.in ? `<span>chance to stay</span><b>${pct(f.in[i], 0)}</b>` : ""}${f.rw ? `<span>really</span><b class="blue">${f.rw[i] == null ? "no data yet" : f.rw[i] > 0 ? pct(f.rw[i], 2) : "left"}</b>` : ""}`;
}

// ---------------------------------------------------------------- events tab: the ledger of the world, filtered
async function events(force) {
  const el = $("#fx-events"); if (!el || (F.tab !== "events" && !force)) { if (!F.ledger || F.ledgerFor !== F.world) loadLedger(); return; }
  if (!F.ledger || F.ledgerFor !== F.world) { el.innerHTML = '<div class="hint pl-pickhint">Loading the events…</div>'; await loadLedger(); }
  const types = [...new Set(F.ledger.map((e) => e.type))];
  const list = F.ledger.filter((e) => !F.evfilter || e.type === F.evfilter).slice().reverse();
  el.innerHTML = `<div class="pl-sorts"><div class="seg xs fx-evf">${[["", "All"], ...types.map((t) => [t, EV_NAME[t] || t])].map(([k, l]) => `<button data-f="${k}" class="${F.evfilter === k ? "on" : ""}">${l}</button>`).join("")}</div></div>
    <div class="hint pl-pickhint">${list.length} event${list.length === 1 ? "" : "s"}${F.evfilter ? ` of the type “${EV_NAME[F.evfilter] || F.evfilter}”` : ""}. Click one to find the body on the map.</div>
    <div class="list">${list.slice(0, 300).map((e) => `<div class="li fx-evrow" data-id="${esc(e.id)}" data-date="${esc(e.date)}"><i class="fx-ei" style="color:${EV_COL[e.type]}">${EV_ICON[e.type] || "•"}</i><div class="tx"><div class="nm">${esc(e.name || e.id)} <span class="dim mono">${esc(e.date.slice(0, 7))}</span></div><div class="sub">${esc(e.text || EV_NAME[e.type])}</div></div></div>`).join("")}</div>`;
  $$("#fx-events [data-f]").forEach((b) => b.onclick = () => { F.evfilter = b.dataset.f; events(true); });
  $$("#fx-events [data-id]").forEach((row) => row.onclick = () => {
    const r = R(); if (!r) return;
    const i = r.bodies.findIndex((b) => b.id === row.dataset.id);
    const s = r.frames.findIndex((f) => f.date >= row.dataset.date);
    if (s >= 0) F.u = s;
    if (i >= 0) { F.pick = r.bodies[i].id; centreOn(i); }
    frame();
  });
}
async function loadLedger() {
  try { const r = await callModel("forces.events", { world: F.world, limit: 20000 }); F.ledger = r.result.events; F.ledgerFor = F.world; } catch (e) { F.ledger = []; }
}
