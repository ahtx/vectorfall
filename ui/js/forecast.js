// Forecast: four everyday questions answered by simulating many futures on the card (retirement savings, a project's
// finish date, a queue, the birthday problem). Left: the questions and their settings. Right: the answer in one
// sentence, the main chart and the second chart. Same pane system as Simulate: no page scroll, nothing hidden.
import { $, $$, api, esc, fail, fmt, icon, pane } from "./core.js";
import * as ch from "./charts.js";

let specs = [], cur = null, last = null, ctl = null;
const ICON = { retirement: "piggy", project: "gantt", queue: "states", birthday: "spark" };
const SIMS = { retirement: "a million", project: "two million", queue: "20,000", birthday: "a million" };

export default {
  id: "forecast", title: "Forecast", sub: "millions of futures, one answer", icon: "forecast",
  mount(el) {
    el.innerHTML = `<div class="ws side-l fc">
      <div class="col">
        ${pane({ t: "Questions", cls: "fit", bcls: "flush", bid: "fc-list" })}
        <section class="pane grow"><div class="pane-h"><div class="t" id="fc-ptitle">Settings</div><div class="tools"><button class="iconbtn" id="fc-reset" title="Back to the example numbers">${icon("undo")}</button></div></div>
          <div class="pane-b"><div class="fields" id="fc-params"></div></div>
          <div class="pane-act"><button class="btn block" id="fc-go" data-primary>${icon("spark")} Run</button><div class="hint" id="fc-time">&nbsp;</div></div></section>
      </div>
      <div class="col">
        <section class="pane fit sm-verdict" id="fc-verdict"><div class="hl" id="fc-hl">—</div><div class="txt"><div class="nm" id="fc-name"></div><p id="fc-sent">Choose a question on the left, set your numbers and press Run.</p></div><div class="facts" id="fc-facts"></div></section>
        ${pane({ id: "fc-main", t: "Futures", meta: "", cls: "grow", body: `<div class="chartbox"><canvas id="fc-c1"></canvas></div>` })}
        ${pane({ id: "fc-second", t: "Detail", meta: "", cls: "fc-second", body: `<div class="chartbox"><canvas id="fc-c2"></canvas></div>` })}
      </div>
    </div>`;
    $("#fc-go").onclick = () => (ctl ? ctl.abort() : run());
    $("#fc-reset").onclick = () => open(cur);
    window.addEventListener("resize", () => { if (last && $("#view-forecast.on")) draw(last); });
    load();
  },
  show(p = {}) { if (p.q && specs.some((s) => s.id === p.q)) open(p.q); else if (last) requestAnimationFrame(() => draw(last)); },
};

async function load() {
  try { specs = await api.get("/forecast"); } catch (e) { fail(e); $("#fc-list").innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  $("#fc-list").innerHTML = `<div class="list">${specs.map((s) => `<div class="li" data-s="${s.id}"><div class="ic">${icon(ICON[s.id] || "forecast")}</div>
    <div class="tx"><div class="nm">${esc(s.name)}</div><div class="sub">${esc(s.blurb)}</div></div></div>`).join("")}</div>`;
  $$("#fc-list [data-s]").forEach((b) => b.onclick = () => open(b.dataset.s));
  open(cur || specs[0].id);
}

function open(sid) {
  cur = sid; last = null;
  const s = specs.find((x) => x.id === sid); if (!s) return;
  $$("#fc-list [data-s]").forEach((b) => b.classList.toggle("on", b.dataset.s === sid));
  $("#fc-ptitle").textContent = s.name;
  $("#fc-params").innerHTML = s.params.map(field).join("");
  $$("#fc-params input[type=range]").forEach((i) => { i.oninput = () => { const v = $("#v-" + i.dataset.k); if (v) v.textContent = fmtParam(i); }; i.oninput(); });
  $("#fc-go").innerHTML = `${icon("spark")} Run ${SIMS[sid] || "many"} futures`;
  $("#fc-time").innerHTML = "&nbsp;";
  $("#fc-hl").className = "hl"; $("#fc-hl").textContent = "—"; $("#fc-name").textContent = s.name;
  $("#fc-sent").textContent = s.blurb + " Set your numbers and press Run.";
  $("#fc-facts").innerHTML = "";
  ["#fc-c1", "#fc-c2"].forEach((c) => { const cv = $(c); cv.getContext("2d").clearRect(0, 0, cv.width, cv.height); });
  $("#fc-main .meta").textContent = ""; $("#fc-second").hidden = true;
  run();                                       // the example numbers give an answer at once
}
// float sliders use step "any": a fixed step snapped the example numbers (2.2 min became 2.30, 50 arrivals 51)
function field(p) {
  const id = `fp-${p.k}`;
  if (p.type === "text") return `<div class="fld col"><label for="${id}">${esc(p.label)}</label><textarea class="in mono fc-text" id="${id}" data-k="${p.k}" rows="7">${esc(p.default)}</textarea></div>`;
  if (p.type === "money") return `<div class="fld two"><label for="${id}">${esc(p.label)}</label><input class="in sm" id="${id}" data-k="${p.k}" data-money="1" inputmode="decimal" value="${Number(p.default).toLocaleString()}"></div>`;
  if (p.type === "int" || p.type === "float") return `<div class="fld"><label for="${id}">${esc(p.label)}</label><input type="range" id="${id}" data-k="${p.k}" data-type="${p.type}" min="${p.min}" max="${p.max}" step="${p.type === "int" ? 1 : "any"}" value="${p.default}"><span class="v" id="v-${p.k}"></span></div>`;
  return `<div class="fld two"><label for="${id}">${esc(p.label)}</label><input class="in sm" id="${id}" data-k="${p.k}" value="${esc(p.default)}"></div>`;
}
function fmtParam(i) { const v = +i.value; return i.dataset.k.match(/money|savings|contrib|spend/) ? fmt.money(v) : (i.dataset.type === "int" ? v : v.toFixed(Math.abs(v) < 10 ? 2 : 1)); }

async function run() {
  if (ctl) return;
  const params = {};
  $$("#fc-params [data-k]").forEach((i) => { params[i.dataset.k] = i.dataset.money ? +i.value.replace(/[^0-9.\-]/g, "") : (i.tagName === "TEXTAREA" ? i.value : (i.type === "range" ? +i.value : i.value)); });
  const sid = cur, btn = $("#fc-go"), label = btn.innerHTML, t0 = performance.now();
  ctl = new AbortController();
  btn.innerHTML = `${icon("stop")} Stop`; btn.classList.add("ghost");
  $("#fc-main").classList.add("is-busy");
  const tick = setInterval(() => { $("#fc-time").textContent = `the card simulates… ${((performance.now() - t0) / 1000).toFixed(1)} s`; }, 200);
  try {
    const r = await api.post("/forecast/" + sid, { params }, { signal: ctl.signal });
    if (sid !== cur) return;
    last = r;
    $("#fc-time").innerHTML = `${fmt.big(r.paths)} futures · <span class="timing">${fmt.ms(r.ms)}</span>`;
    show(r);
  } catch (e) {
    if (sid !== cur) return;
    $("#fc-time").textContent = e.cancelled ? "stopped" : "";
    if (!e.cancelled) { $("#fc-hl").className = "hl bad"; $("#fc-hl").textContent = "—"; $("#fc-sent").textContent = e.message; }
  } finally {
    clearInterval(tick); ctl = null;
    btn.innerHTML = label; btn.classList.remove("ghost");
    $("#fc-main").classList.remove("is-busy");
  }
}

function show(r) {
  $("#fc-hl").className = "hl " + (r.tone || ""); $("#fc-hl").textContent = r.headline;
  $("#fc-sent").textContent = r.sentence;
  $("#fc-facts").innerHTML = (r.facts || []).slice(0, 4).map((f) => `<div><b>${esc(String(f[1]))}</b><span>${esc(f[0])}</span></div>`).join("");
  $("#fc-main .meta").textContent = (r.chart && r.chart.title) || "";
  $("#fc-second").hidden = !r.chart2;
  if (r.chart2) $("#fc-second .meta").textContent = r.chart2.title || "";
  requestAnimationFrame(() => draw(r));
}
function draw(r) { drawChart($("#fc-c1"), r.chart); if (r.chart2) drawChart($("#fc-c2"), r.chart2); }
function drawChart(cv, c) {
  if (!c || !cv) return;
  const h = cv.parentElement.clientHeight || 220;
  if (c.type === "fan") ch.fan(cv, { x: c.x, bands: c.bands, h, unit: c.unit });
  else if (c.type === "hist") ch.hist(cv, { edges: c.edges, y: c.y, h, marker: c.marker, unit: c.unit });
  else if (c.type === "bars") ch.bars(cv, { x: c.x, y: c.y, h });
  else if (c.type === "hbars") ch.hbars(cv, { labels: c.labels, y: c.y, h });
  else if (c.type === "lines") ch.line(cv, { x: c.x, h, area: false, yfmt: (v) => c.unit === "%" ? Math.round(v * 100) + "%" : v, series: c.series.map((s, i) => ({ y: s.y, color: ["#ff2a1a", "#3fa9f5"][i], dash: i ? [5, 4] : [] })) });
}
