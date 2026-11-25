// Particle Lab: the futures of one country or company, over the map. A fan of Monte Carlo futures from its growth
// regimes (its own history blended with bodies like it), perturbations on the same random numbers as the baseline,
// the World Bank / IMF forecasts (countries) or the analysts' targets (companies), and the method's track record.
import { $, $$, esc, fail, fmt, icon } from "./core.js";
import { callModel } from "./hub.js";

const S = { el: null, world: null, id: null, p: null, r: null, out: null, t: 0, busy: false };
const DEF = { own: -1, vol: 1, persist: 0, drift: 0, window: 0, horizon: 0, calibrated: true };
const COL = { hist: "#3fa9f5", base: "rgba(232,232,234,", scen: "rgba(255,176,32,", imf: "#c084fc", wb: "#2fd38a", an: "#c084fc" };

export function openFutures(host, world, id, name) {
  S.world = world; S.id = id; S.p = { ...DEF }; S.r = null; S.out = null;
  let el = $("#pl-fut", host);
  if (!el) { host.insertAdjacentHTML("beforeend", '<div class="pl-fut" id="pl-fut"></div>'); el = $("#pl-fut", host); }
  S.el = el; el.hidden = false;
  const y = world === "countries";
  el.innerHTML = `<div class="pf-h"><div><div class="pf-t">${esc(name)} <span class="dim">· futures</span></div><div class="dim pf-what" id="pf-what">${y ? "real GDP per person (constant US$)" : "share of the S&P 500's total value"}</div></div>
      <div class="pf-tools"><button class="btn ghost xs" id="pf-reset" title="Back to the learned settings">Reset</button><button class="iconbtn" id="pf-x" title="Back to the map (Esc)">${icon("x")}</button></div></div>
    <p class="pf-sent" id="pf-sent">Running futures…</p>
    <div class="pf-chart"><canvas id="pf-cv"></canvas></div>
    <div class="pf-leg" id="pf-leg"></div>
    <div class="pf-ctl">
      ${sl("own", "Learn from", 0, 1, 0.05, (v) => v <= 0.02 ? `${y ? "countries" : "companies"} like it` : v >= 0.98 ? "only its own past" : `${Math.round(v * 100)}% its own past`)}
      ${sl("vol", "Volatility", 0.5, 2, 0.05, (v) => v === 1 ? "as in the past" : `×${v.toFixed(2)} (${v > 1 ? "+" : ""}${Math.round((v - 1) * 100)}%)`)}
      ${sl("persist", "Stability", -0.5, 0.5, 0.05, (v) => !v ? "as in the past" : v > 0 ? `spells last longer (+${Math.round(v * 100)}%)` : `switches more often (${Math.round(v * 100)}%)`)}
      ${sl("drift", "Growth shift", -0.05, 0.05, 0.0025, (v) => !v ? "none" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(2)} pts a ${y ? "year" : "month"}`)}
      <div class="fld"><label>Learn from the last</label><select class="in xs" id="pf-window">${(y ? [[0, "all years"], [30, "30 years"], [20, "20 years"], [10, "10 years"]] : [[0, "all months"], [120, "10 years"], [60, "5 years"]]).map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select></div>
      <div class="fld"><label>Look ahead</label><select class="in xs" id="pf-horizon">${(y ? [[5, "5 years"], [10, "10 years"], [20, "20 years"]] : [[12, "1 year"], [36, "3 years"], [60, "5 years"]]).map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select></div>
      <label class="toggle pf-cal" title="Scale the bands so the 80% band held 80% of real outcomes in the backtest"><input type="checkbox" id="pf-calib" checked><i></i>bands from the backtest</label>
    </div>
    <details class="pf-more" id="pf-more"><summary>How it works, and how good it was</summary><div id="pf-how"></div></details>`;
  $("#pf-horizon").value = y ? 10 : 36;
  $("#pf-x").onclick = closeFutures;
  $("#pf-reset").onclick = () => { S.p = { ...DEF }; $$(".pf-ctl input[type=range]", el).forEach((i) => { i.value = i.dataset.k === "own" ? (S.r?.calibration?.best_own ?? 0.25) : DEF[i.dataset.k]; i.dispatchEvent(new Event("input")); }); $("#pf-window").value = 0; $("#pf-horizon").value = y ? 10 : 36; $("#pf-calib").checked = true; run(); };
  $$(".pf-ctl input[type=range]", el).forEach((i) => { i.oninput = () => { label(i); S.p[i.dataset.k] = +i.value; later(); }; label(i); });
  $("#pf-window").onchange = (e) => { S.p.window = +e.target.value; run(); };
  $("#pf-horizon").onchange = () => run();
  $("#pf-calib").onchange = (e) => { S.p.calibrated = e.target.checked; run(); };
  if (!S.keys) { S.keys = true; document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.el && !S.el.hidden) { e.stopPropagation(); closeFutures(); } }); }
  new ResizeObserver(() => draw()).observe($(".pf-chart", el));
  callModel("forces.outlook", { world, id }).then((r) => { if (S.id === id) { S.out = r.result; draw(); legend(); how(); } }).catch(() => { S.out = { lines: [], errors: { all: "could not reach the forecasters" } }; legend(); });
  run();
}
export function closeFutures() { if (S.el) S.el.hidden = true; }
const FMT = {};
function sl(k, t, lo, hi, st, f) { FMT[k] = f; return `<div class="fld"><label>${t}</label><input type="range" data-k="${k}" min="${lo}" max="${hi}" step="${st}" value="${k === "own" ? 0.25 : DEF[k]}"><span class="v" data-v="${k}"></span></div>`; }
function label(i) { const v = +i.value, f = FMT[i.dataset.k]; const o = $(`[data-v="${i.dataset.k}"]`, S.el); if (o) o.textContent = f(v); }
function later() { clearTimeout(S.t); S.t = setTimeout(run, 220); }

async function run() {
  const id = S.id, p = { ...S.p, horizon: +$("#pf-horizon").value };
  $("#pf-sent").classList.add("busy");
  try {
    const r = (await callModel("forces.futures", { world: S.world, id, ...p })).result;
    if (S.id !== id) return;
    S.r = r;
    if (S.p.own < 0) { const i = $('.pf-ctl input[data-k="own"]', S.el); i.value = r.own; label(i); }
    $("#pf-sent").textContent = r.sentence;
    draw(); legend(); how();
  } catch (e) { fail(e); $("#pf-sent").textContent = e.message; }
  $("#pf-sent").classList.remove("busy");
}

const yr = (d) => +d.slice(0, 4) + (+d.slice(5, 7) - 1) / 12 + (+d.slice(8, 10)) / 365;
function nice(v, unit) {
  if (unit === "share") return (v * 100).toFixed(v < 0.01 ? 2 : 1) + "%";
  return v >= 1e5 ? "$" + (v / 1e3).toFixed(0) + "k" : v >= 1e4 ? "$" + (v / 1e3).toFixed(1) + "k" : "$" + Math.round(v);
}
function draw() {
  const r = S.r, cv = $("#pf-cv", S.el); if (!r || !cv) return;
  const dpr = window.devicePixelRatio || 1, w = cv.parentElement.clientWidth, h = cv.parentElement.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr; cv.style.width = w + "px"; cv.style.height = h + "px";
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const keep = Math.max(r.horizon * 2, S.world === "countries" ? 15 : 36), hd = r.history.dates.slice(-keep), hy = r.history.y.slice(-keep);
  const hx = hd.map(yr), fx = [yr(r.start.date), ...r.dates.map(yr)];
  const fan = (B) => [[r.start.value, r.start.value, r.start.value, r.start.value, r.start.value, r.start.value, r.start.value], ...B];
  const B0 = fan(r.baseline), B1 = r.scenario ? fan(r.scenario) : null;
  const lines = (S.out && S.out.lines) || [];
  let ys = hy.concat(B0.flatMap((b) => [b[1], b[5]]), B1 ? B1.flatMap((b) => [b[1], b[5]]) : []);
  lines.forEach((l) => { if (l.points) ys = ys.concat(l.points.map((p) => p[1])); if (l.mean) ys.push(l.low || l.mean, l.high || l.mean); });
  let lo = Math.min(...ys), hi = Math.max(...ys); const pad = (hi - lo) * 0.08; lo = Math.max(0, lo - pad); hi += pad;
  const x0 = hx[0], x1 = fx[fx.length - 1], P = { l: 58, r: 14, t: 14, b: 26 };
  const X = (x) => P.l + (x - x0) / (x1 - x0) * (w - P.l - P.r), Y = (y) => h - P.b - (y - lo) / (hi - lo) * (h - P.t - P.b);
  g.font = "11px 'JetBrains Mono', monospace"; g.fillStyle = "#8a8b93"; g.strokeStyle = "rgba(255,255,255,.06)";
  for (let i = 0; i <= 4; i++) { const v = lo + (hi - lo) * i / 4; g.beginPath(); g.moveTo(P.l, Y(v)); g.lineTo(w - P.r, Y(v)); g.stroke(); g.textAlign = "right"; g.fillText(nice(v, r.unit), P.l - 6, Y(v) + 4); }
  const span = x1 - x0, stp = span > 40 ? 10 : span > 16 ? 5 : span > 6 ? 2 : 1;
  g.textAlign = "center"; for (let t = Math.ceil(x0 / stp) * stp; t <= x1; t += stp) g.fillText(String(t), X(t), h - 8);
  g.strokeStyle = "rgba(255,255,255,.18)"; g.setLineDash([3, 4]); g.beginPath(); g.moveTo(X(fx[0]), P.t); g.lineTo(X(fx[0]), h - P.b); g.stroke(); g.setLineDash([]);
  const band = (B, a, b, col) => { g.beginPath(); fx.forEach((x, i) => (i ? g.lineTo : g.moveTo).call(g, X(x), Y(B[i][a]))); for (let i = fx.length - 1; i >= 0; i--) g.lineTo(X(fx[i]), Y(B[i][b])); g.closePath(); g.fillStyle = col; g.fill(); };
  const path = (xs, vs, col, wd, dash) => { g.beginPath(); xs.forEach((x, i) => (i ? g.lineTo : g.moveTo).call(g, X(x), Y(vs[i]))); g.strokeStyle = col; g.lineWidth = wd; g.setLineDash(dash || []); g.stroke(); g.setLineDash([]); };
  band(B0, 1, 5, COL.base + (B1 ? ".07)" : ".10)")); band(B0, 2, 4, COL.base + (B1 ? ".10)" : ".16)"));
  if (B1) { band(B1, 1, 5, COL.scen + ".16)"); band(B1, 2, 4, COL.scen + ".26)"); }
  (r.samples || []).slice(0, 20).forEach((s) => path(fx, [r.start.value, ...s], B1 ? COL.scen + ".22)" : "rgba(232,232,234,.16)", 1));
  path(fx, B0.map((b) => b[3]), B1 ? "rgba(232,232,234,.7)" : "#e8e8ea", 2, B1 ? [5, 4] : null);
  if (B1) path(fx, B1.map((b) => b[3]), "#ffb020", 2.2);
  path(hx, hy, COL.hist, 2);
  lines.forEach((l) => {
    if (l.points) {
      const xs = [fx[0], ...l.points.map((p) => yr(p[0]))], vs = [r.start.value, ...l.points.map((p) => p[1])];
      path(xs, vs, "rgba(0,0,0,.6)", 5); path(xs, vs, COL[l.key] || "#fff", 2.6, [6, 3]);
      const e = xs.length - 1; g.fillStyle = COL[l.key] || "#fff"; g.beginPath(); g.arc(X(xs[e]), Y(vs[e]), 3.5, 0, 7); g.fill();
      g.font = "10.5px Inter, sans-serif"; g.textAlign = "left"; g.fillText(l.key === "imf" ? "IMF" : l.key === "wb" ? "World Bank" : l.key, X(xs[e]) + 6, Y(vs[e]) + 4); g.font = "11px 'JetBrains Mono', monospace";
    }
    if (l.mean) { const x = X(yr(l.at)); g.strokeStyle = COL.an; g.lineWidth = 2; g.beginPath(); g.moveTo(x, Y(l.low || l.mean)); g.lineTo(x, Y(l.high || l.mean)); g.stroke(); g.fillStyle = COL.an; g.beginPath(); g.arc(x, Y(l.mean), 4.5, 0, 7); g.fill(); }
  });
  g.fillStyle = "#8a8b93"; g.textAlign = "left"; g.fillText("history", X(x0) + 4, P.t + 10); g.fillText("futures", X(fx[0]) + 4, P.t + 10);
}
function legend() {
  const r = S.r; if (!r) return;
  const L = (S.out && S.out.lines) || [], err = S.out && S.out.errors && Object.values(S.out.errors)[0];
  $("#pf-leg").innerHTML = `<span><i style="background:${COL.hist}"></i>its history</span>
    <span><i class="fan"></i>${r.scenario ? "plain history (dashed median)" : "futures: median, 50% and 80% bands"}</span>
    ${r.scenario ? `<span><i style="background:#ffb020"></i>your scenario: ${esc(r.perturbed.join(", "))}</span>` : ""}
    ${L.map((l) => `<span title="${esc(l.what + (l.note ? " · " + l.note : ""))}"><i class="${l.mean ? "dot" : "dash"}" style="${l.mean ? "background" : "border-color"}:${COL[l.key] || "#fff"}"></i>${esc(l.name)}${l.upside != null ? ` · target ${l.upside >= 0 ? "+" : ""}${Math.round(l.upside * 100)}% vs today's price` : ""}</span>`).join("")}
    ${S.out && !L.length && S.world === "countries" ? '<span class="dim">no World Bank / IMF forecast for this country</span>' : ""}${err ? `<span class="dim">${esc(err)}</span>` : ""}`;
}
function how() {
  const r = S.r, c = r && r.calibration; if (!r) return;
  const R = r.table.regimes, own = r.table.own, pool = r.table.pooled;
  const by = c ? c.by_own : null, k = (v) => by && (by[String(v)] || by[Number(v).toFixed(1)] || by[String(Number(v))]);
  const best = c && k(c.best_own), only = c && k(1);
  const live = S.out && S.out.live, har = (S.out && S.out.harvested) || [];
  $("#pf-how").innerHTML = `<p>Every ${r.step} of its past is put in one of five regimes (${R.map(esc).join(", ")}), cut at the 10/30/70/90% points of every move by every ${S.world === "countries" ? "country" : "company"}.
    The chance of the next regime comes from <b>its own transition table</b>, blended with <b>the table of ${S.world === "countries" ? "countries" : "companies"} in the same size class</b> (${esc(r.start.class)}). A real past move from that regime is then drawn. ${fmt.n(r.horizon)} steps, ${fmt.n(4000)} futures. It starts in “${esc(r.start.regime)}”.</p>
    ${c ? `<p><b>Track record.</b> Started from every ${c.step === "year" ? "year" : "quarter"} from ${c.origins[0]} to ${c.origins[1]} (${fmt.n(c.cases)} cases, ${c.horizon} ${c.step}s ahead), using only what was known then:
      with the best blend (${Math.round(c.best_own * 100)}% its own past) the 80% band held <b>${Math.round(best.cover80 * 100)}%</b> of what happened; its error (CRPS) was ${Math.round(best.skill_vs_nochange * 100)}% below “no change”${best.skill_vs_trend != null ? `, ${Math.round(Math.abs(best.skill_vs_trend) * 100)}% ${best.skill_vs_trend >= 0 ? "below" : "above"} “grows at the average rate”` : ""}${best.skill_vs_randomwalk != null ? `, and <b>${Math.round(Math.abs(best.skill_vs_randomwalk) * 100)}% ${best.skill_vs_randomwalk >= 0 ? "below" : "above"} a random walk with the same volatility</b> (the fair test: “no change” is a single number, so any honest spread beats it)` : ""}.
      Learning only from its own past held ${Math.round(only.cover80 * 100)}% — one body's history is too short to trust alone (Pritchett & Summers). ${r.widen !== 1 ? `Bands are scaled ×${r.widen} so the 80% band holds 80%.` : ""}</p>` : '<p class="dim">Not backtested yet.</p>'}
    <div class="pf-tabs"><table class="pf-tb"><caption>Its own moves: from this regime (row) to the next (column)</caption><tr><th></th>${R.map((x) => `<th>${esc(x)}</th>`).join("")}</tr>${own.map((row, i) => `<tr><th>${esc(R[i])}</th>${row.map((v) => `<td style="--a:${Math.min(1, v / 6)}">${v || ""}</td>`).join("")}</tr>`).join("")}</table>
    <table class="pf-tb"><caption>Bodies like it: the chance of the next regime</caption><tr><th></th>${R.map((x) => `<th>${esc(x)}</th>`).join("")}</tr>${pool.map((row, i) => `<tr><th>${esc(R[i])}</th>${row.map((v) => `<td style="--a:${v}">${Math.round(v * 100)}%</td>`).join("")}</tr>`).join("")}</table></div>
    ${live ? `<p><b>Analysts (live from Yahoo, ${esc(live.fetched)}, not stored):</b> ${live.analysts} analysts, “${esc(live.rating)}”; price $${live.price} → target $${(live.target_mean || 0).toFixed(2)} (low $${live.target_low}, high $${live.target_high}).
      Votes: ${Object.entries(live.votes || {}).map(([a, b]) => `${a} ${b}`).join(", ")}.${(live.eps || []).map((e) => ` EPS ${e.period === "0y" ? "this year" : "next year"} $${(e.eps || 0).toFixed(2)}.`).join("")}</p>` : ""}
    ${har.length ? `<p><b>From public pages</b> (harvested, each with its quote):</p><div class="pf-har">${har.slice(0, 8).map((h) => `<div><span class="mono dim">${esc(h.as_of || (h.published || "").slice(0, 10) || "undated")}</span> ${h.target_mean ? `target $${h.target_mean}` : ""}${h.rating ? ` · ${esc(h.rating)}` : ""}${h.analysts ? ` · ${h.analysts} analysts` : ""} — <a href="${esc(h.url)}" target="_blank" rel="noopener">${esc((h.title || h.url).slice(0, 60))}</a><div class="dim">“${esc(h.quote.slice(0, 160))}”</div></div>`).join("")}</div>` : ""}`;
}
