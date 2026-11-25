import { $, $$, api, esc, fmt, icon, pane, toast, watchJob } from "./core.js";
import { artIndex, createStage, hasModel, silhouette, stillUrl } from "./lineage-stage.js";

// Lineage: this card against history's fastest computers. A measured LINPACK (FP64 and FP32) places the card on
// the TOP500 timeline; the Hall shows each #1 machine as 3D art with what it solved; "How many Crays?" stacks
// Cray-1s until they equal the card. All numbers are LINPACK figures from the TOP500 and Dongarra's report.

let S = { st: null, sel: null, prec: "fp64", cray: "cray-1", palette: "vectorfall", tab: "machine", job: null };
let stage = null, stageTried = false, visible = false, anim = 0, crayAnim = 0;
const thumbs = new Map();
const MONTH = { "06": "June", "11": "November" };
const listName = (d) => d ? `${MONTH[d.slice(5)] || d.slice(5)} ${d.slice(0, 4)}` : "";
const listX = (d) => +d.slice(0, 4) + (d.slice(5) === "06" ? 0.45 : 0.87);
const gfmt = (g) => g == null ? "—" : g >= 1e6 ? fmt.n(g / 1e6, g >= 1e7 ? 0 : 2) + " PFLOP/s" : g >= 1e3 ? fmt.n(g / 1e3, g >= 1e4 ? 0 : 2) + " TFLOP/s" : g >= 1 ? fmt.n(g, 1) + " GFLOP/s" : fmt.n(g * 1e3, 0) + " MFLOP/s";
const short = (m) => m.name.replace(/^Thinking Machines /, "").replace(/^Intel /, "");

export default {
  id: "lineage", title: "Lineage", sub: "this card against history's supercomputers", icon: "trend", scroll: true,
  mount(el) {
    el.innerHTML = `<div class="ws side-l lin">
      <div class="col">
        ${pane({ id: "lin-card", t: "Your card", cls: "fit", bid: "lin-cardb", body: '<div class="skeleton" style="height:210px"></div>' })}
        ${pane({ id: "lin-cray", t: "How many Crays?", cls: "grow", bcls: "flush", bid: "lin-crayb",
          tools: `<button class="btn ghost xs" id="lin-share" title="Save a picture of the result">${icon("down")} Share</button>` })}
      </div>
      <div class="col">
        ${pane({ id: "lin-hall", t: "The Hall", meta: "", cls: "grow", bcls: "flush", bid: "lin-hallb",
          tools: `<div class="seg" id="lin-pal"><button data-p="vectorfall" class="on">VectorFall red</button><button data-p="museum">Museum</button></div>
                  <button class="btn ghost xs" id="lin-prev" title="Earlier machine">‹</button><button class="btn ghost xs" id="lin-next" title="Later machine">›</button>`,
          body: `<div class="lin-hall"><div class="lin-stage" id="lin-stage"><div class="lin-fallback" id="lin-fb"></div>
            <div class="lin-cap" id="lin-cap"></div><div class="lin-hint">drag to turn · wheel to zoom · double-click to reset</div></div>
            <div class="lin-info" id="lin-info"></div></div>` })}
        ${pane({ id: "lin-time", t: "TOP500 #1, 1976 to now", meta: "LINPACK, GFLOP/s, log scale", cls: "fit", bcls: "flush", bid: "lin-timeb",
          tools: `<div class="seg" id="lin-prec"><button data-p="fp64" class="on">FP64</button><button data-p="fp32">FP32</button></div>`,
          body: `<div class="lin-chart"><canvas id="lin-cv"></canvas><div class="lin-tip" id="lin-tip"></div></div><div class="lin-strip" id="lin-strip"></div>` })}
      </div></div>`;
    $$("#lin-prec button").forEach((b) => b.onclick = () => { S.prec = b.dataset.p; segOn("#lin-prec", S.prec); renderAll(true); });
    $$("#lin-pal button").forEach((b) => b.onclick = () => { S.palette = b.dataset.p; segOn("#lin-pal", S.palette); showArt(); });
    $("#lin-prev").onclick = () => step(-1);
    $("#lin-next").onclick = () => step(1);
    $("#lin-share").onclick = share;
    el.addEventListener("keydown", (e) => { if (e.target.closest("input,select,textarea")) return; if (e.key === "ArrowLeft") step(-1); if (e.key === "ArrowRight") step(1); });
    chartEvents();
    window.addEventListener("resize", () => { if (visible) { drawChart(); drawCrays(false); } });
    load();
  },
  show(p) {
    visible = true;
    if (p && p.m) S.sel = p.m;
    if (S.st) { renderHall(); drawChart(); }
    if (stage) stage.start(); else initStage();
  },
  hide() { visible = false; if (stage) stage.stop(); },
};

const segOn = (sel, v) => $$(sel + " button").forEach((b) => b.classList.toggle("on", (b.dataset.p || b.dataset.c) === v));
const machines = () => S.st ? S.st.machines.slice().sort((a, b) => (a.year - b.year) || ((a.lists_at_1[0] || "") < (b.lists_at_1[0] || "") ? -1 : 1)) : [];
const byId = (id) => S.st && S.st.machines.find((m) => m.id === id);
const cmp = () => S.st && S.st.compare;
const placeOf = (p = S.prec) => cmp() && cmp()[p];

async function load() {
  try {
    S.st = await api.get("/lineage");
  } catch (e) { $("#lin-cardb").innerHTML = `<div class="empty">The history did not load: ${esc(e.message)}</div>`; return; }
  await artIndex();
  if (!S.sel) { const p = placeOf("fp64") || placeOf("fp32"); S.sel = (p && p.beats) || "cray-1"; }
  renderAll(true);
}

function renderAll(animate) {
  renderCard(); renderHall(); renderStrip(); drawChart(animate); drawCrays(animate);
}

// ---------------------------------------------------------------- the card and its LINPACK
function renderCard() {
  const st = S.st, c = st.card || {}, sv = st.saved || {};
  const m64 = sv.fp64, m32 = sv.fp32;
  const num = (rec, peak, lbl) => `<div class="lin-num"><span class="k">${lbl}</span>
      <b>${rec ? gfmt(rec.gflops) : "—"}</b>
      <span class="s">${rec ? `n = ${fmt.n(rec.n)} · ${rec.seconds.toFixed(1)} s · ${Math.round(rec.gflops / peak * 100)}% of peak` : `not measured · peak ${gfmt(peak)}`}</span></div>`;
  const busy = !!S.job;
  $("#lin-cardb").innerHTML = `<div class="lin-plate"><div class="nm">${esc(c.name || "GPU")}</div>
      <div class="sp">${esc(c.arch || "")} · ${fmt.n(c.cores)} CUDA cores · ${fmt.n(c.mem_mb)} MB · ${c.tdp_w ? c.tdp_w + " W" : "power not known"}</div></div>
    <div class="lin-nums">${num(m64, c.fp64_gflops, "FP64 LINPACK")}${num(m32, c.fp32_gflops, "FP32 LINPACK")}</div>
    <div class="lin-run">
      <button class="btn sm" id="lin-go" ${busy ? "disabled" : ""}>${icon("bolt")} ${m64 ? "Run again" : "Run LINPACK"}</button>
      <select class="sel" id="lin-size" title="Problem size"><option value="auto">full size</option><option value="quick">quick test</option></select>
      ${busy ? `<button class="btn ghost sm" id="lin-stop">${icon("stop")} Stop</button>` : ""}
    </div>
    <div class="lin-prog ${busy ? "" : "off"}"><div class="hgb"><i id="lin-pbar" style="width:0"></i></div><span id="lin-pmsg">${busy ? "starting" : ""}</span></div>
    <div class="lin-verdict">${verdict()}</div>`;
  $("#lin-go").onclick = run;
  if ($("#lin-stop")) $("#lin-stop").onclick = () => api.post("/lineage/cancel").catch(() => {});
}

function verdict() {
  const p64 = placeOf("fp64"), p32 = placeOf("fp32"), out = [];
  const line = (p, lbl) => {
    if (!p) return "";
    let s = `<b>${lbl}:</b> `;
    if (p.top500) {
      const t = p.top500;
      s += `#1 on every TOP500 list from June 1993 to ${listName(t.list)}.${t.until ? ` ${esc(byId(t.overtaken_by).name)} passed it in ${listName(t.until)}.` : " It is still #1."}`;
    } else if (p.pre1993) {
      const q = p.pre1993, o = byId(q.overtaken_by);
      s += `faster than the ${esc(q.name)} (${q.year}).${o ? ` The ${esc(o.name)} passed it in ${o.year}.` : ""}`;
      if (p.best_rank) s += ` On the first TOP500 list it is about #${p.best_rank}.`;
    } else s += "slower than the Cray-1.";
    if (p.last_on_list) s += ` It stays on the TOP500 until ${listName(p.last_on_list)}.`;
    return `<p>${s}</p>`;
  };
  out.push(line(p64, "FP64"));
  if (p32) out.push(line(p32, "FP32") + `<p class="dim">The TOP500 counts only FP64 results. The FP32 line shows the same test in 32-bit numbers.</p>`);
  if (!p64 && !p32) out.push(`<p class="dim">Run LINPACK to put this card on the timeline. The full size test fills the free memory and takes up to about 1.5 min.</p>`);
  return out.join("");
}

async function run() {
  const size = $("#lin-size").value;
  try {
    const job = await api.post("/lineage/run", { precision: "both", size });
    S.job = job; renderCard();
    const res = await watchJob(job, (j) => {
      const b = $("#lin-pbar"), m = $("#lin-pmsg");
      if (b) b.style.width = Math.round((j.progress || 0) * 100) + "%";
      if (m) m.textContent = j.message || "";
    });
    S.job = null;
    if (size === "quick") {
      toast(`Quick test: ${res.sentence}. The full size test gives the saved result.`, "", 9000);
      renderCard();
      return;
    }
    S.st = await api.get("/lineage");
    const p = placeOf("fp64") || placeOf("fp32");
    if (p && p.beats) S.sel = p.beats;
    toast(res.sentence, res.check ? "" : "bad", 9000);
    renderAll(true);
  } catch (e) { S.job = null; renderCard(); toast(e.message, "bad", 7000); }
}

// ---------------------------------------------------------------- the Hall: art + story
async function initStage() {
  if (stageTried) return;
  stageTried = true;
  try { stage = await createStage($("#lin-stage")); } catch (e) { console.warn("lineage stage", e); stage = null; }
  if (stage && visible) stage.start();
  showArt();
  renderStrip();
}

async function showArt() {
  const m = byId(S.sel);
  if (!m) return;
  const fb = $("#lin-fb");
  const ok = stage && hasModel(m.id) ? await stage.show(m.id, S.palette) : false;
  if (stage && !ok) await stage.show(null);
  if (ok) fb.innerHTML = "";
  else if (!stage && stillUrl(m.id)) fb.innerHTML = `<img src="${stillUrl(m.id)}" alt="${esc(m.name)}">`;
  else fb.innerHTML = silhouette(m);
  fb.classList.toggle("on", !ok);
}

function renderHall() {
  const m = byId(S.sel);
  if (!m) return;
  const list = machines(), i = list.indexOf(m);
  $("#lin-hall .meta").textContent = `${i + 1} of ${list.length} · ${m.kind === "pre1993" ? "before the TOP500" : "TOP500 #1"}`;
  $("#lin-cap").innerHTML = `<div class="y">${m.year}</div><div class="n">${esc(m.name)}</div><div class="r">${gfmt(m.rmax_gflops)}</div>`;
  const g = (placeOf() || {}).gflops, ratio = g ? g / m.rmax_gflops : null, cn = S.st.card.name || "this card";
  const vs = ratio == null ? "" : ratio >= 1 ? `<b>${esc(cn)}</b> solves LINPACK <b>${ratio >= 100 ? fmt.n(ratio, 0) : fmt.n(ratio, 1)}×</b> faster (${S.prec.toUpperCase()})`
    : `The ${esc(short(m))} was <b>${1 / ratio >= 100 ? fmt.n(1 / ratio, 0) : fmt.n(1 / ratio, 1)}×</b> faster than <b>${esc(cn)}</b> (${S.prec.toUpperCase()})`;
  const kv = (k, v) => v == null || v === "" ? "" : `<span>${k}</span><b>${v}</b>`;
  const tabs = `<div class="seg lin-tabs"><button data-p="machine" class="${S.tab === "machine" ? "on" : ""}">This machine</button><button data-p="list" class="${S.tab === "list" ? "on" : ""}">The TOP500 list</button></div>`;
  const body = S.tab === "list" ? listStory() : `
    <div class="lin-h"><div class="nm">${esc(m.name)}</div><div class="sy">${esc(m.system || "")}</div></div>
    ${vs ? `<div class="lin-vs">${vs}</div>` : ""}
    <div class="kv">${kv("Year", m.year)}${kv("Site", esc(m.site || ""))}${kv("Country", esc(m.country || ""))}${kv("Maker", esc(m.vendor || ""))}
      ${kv("LINPACK", gfmt(m.rmax_gflops))}${kv("Peak", gfmt(m.rpeak_gflops))}${kv("Processors", m.processors ? fmt.n(m.processors) : null)}
      ${kv("Power", m.power_kw ? fmt.n(m.power_kw) + " kW" : null)}${kv("Cost", m.cost ? esc(m.cost) : null)}
      ${kv("#1 on", m.lists_at_1.length ? m.lists_at_1.map(listName).join(", ") : null)}</div>
    <div class="lin-story"><div class="sec-t">What it solved</div><p>${esc(m.story)}</p></div>
    <div class="lin-src"><div class="sec-t">Sources</div>${(m.sources || []).map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60))}</a>`).join("")}
      <div class="dim">${esc(m.linpack_kind || "")}</div>${m.uncertain && m.uncertain.length ? `<div class="lin-unc" title="${esc(m.uncertain.join("\n"))}">${m.uncertain.length} detail${m.uncertain.length > 1 ? "s" : ""} not confirmed by a source</div>` : ""}</div>`;
  $("#lin-info").innerHTML = tabs + `<div class="lin-ib">${body}</div>`;
  $$("#lin-info .lin-tabs button").forEach((b) => b.onclick = () => { S.tab = b.dataset.p; renderHall(); });
  $$("#lin-strip .lin-tile").forEach((t) => t.classList.toggle("on", t.dataset.id === S.sel));
  showArt();
}

function listStory() {
  const L = S.st.lists, a = L[0], z = L[L.length - 1];
  const nums = [...new Set(L.map((l) => l.n1))].length;
  const grow = z.n1_rmax_gflops / a.n1_rmax_gflops, grow500 = z.n500_rmax_gflops / a.n500_rmax_gflops;
  return `<div class="lin-h"><div class="nm">The TOP500 list</div><div class="sy">twice a year since June 1993</div></div>
    <div class="lin-story">
      <p>Hans Meuer, Erich Strohmaier and Jack Dongarra started the TOP500 in June 1993. A new list comes out each June and each November.</p>
      <p>Each list ranks the 500 fastest computers that their owners report. The test is LINPACK (HPL): it solves one large, dense system of linear equations in 64-bit numbers. The score is Rmax, the speed that the machine measures in that solve.</p>
      <p>There are ${L.length} lists from ${listName(a.date)} to ${listName(z.date)}. ${nums} different machines were #1. The #1 speed went from ${gfmt(a.n1_rmax_gflops)} to ${gfmt(z.n1_rmax_gflops)}: about ${fmt.n(grow / 1e6, 0)} million times. The #500 speed grew ${fmt.n(grow500 / 1e6, 1)} million times.</p>
      <p>Before 1993, Jack Dongarra's LINPACK report compared machines with the same test. The Hall uses those figures for the Cray machines and the others before the list.</p>
      <p>Your card runs the same kind of test here: a blocked LU solve with partial pivoting and the HPL residual check. Its score uses the HPL formula (2/3 n³ + 3/2 n²) / t.</p></div>
    <div class="lin-src"><div class="sec-t">Sources</div><a href="https://www.top500.org/" target="_blank" rel="noopener">top500.org</a><a href="https://www.netlib.org/benchmark/performance.pdf" target="_blank" rel="noopener">netlib.org/benchmark/performance.pdf</a></div>`;
}

function step(d) {
  const list = machines(), i = list.findIndex((m) => m.id === S.sel);
  const j = Math.max(0, Math.min(list.length - 1, i + d));
  if (j !== i) select(list[j].id);
}
function select(id) {
  S.sel = id; S.tab = "machine"; renderHall(); drawChart();
  const t = $(`#lin-strip .lin-tile[data-id="${id}"]`);
  if (t) t.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
}

// ---------------------------------------------------------------- the strip of machines
function renderStrip() {
  if (!S.st) return;
  const list = machines(), p = placeOf(), cn = S.st.card.name || "Your card";
  // the card goes just before the machine that passed it (or at the end when nothing has passed it)
  const over = p && (p.top500 ? p.top500.overtaken_by : p.pre1993 ? p.pre1993.overtaken_by : list[0].id);
  const overIdx = p ? (over ? list.findIndex((m) => m.id === over) : list.length) : -1;
  const tiles = [];
  const you = () => `<div class="lin-tile you"><div class="im"><div class="glow"></div><b>${esc(cn)}</b></div>
      <div class="t">${S.prec.toUpperCase()} · you are here</div><div class="r">${gfmt(p.gflops)}</div></div>`;
  list.forEach((m, i) => {
    if (i === overIdx) tiles.push(you());
    const th = thumbs.get(m.id + "|" + S.palette);
    tiles.push(`<button class="lin-tile ${m.id === S.sel ? "on" : ""}" data-id="${m.id}" title="${esc(m.name)}, ${m.year}">
      <div class="im">${th ? `<img src="${th}" alt="">` : stillUrl(m.id) && !stage ? `<img src="${stillUrl(m.id)}" alt="">` : silhouette(m)}</div>
      <div class="t"><span class="y">${m.year}</span> ${esc(short(m))}</div><div class="r">${gfmt(m.rmax_gflops)}</div></button>`);
  });
  if (overIdx === list.length) tiles.push(you());
  $("#lin-strip").innerHTML = tiles.join("");
  $$("#lin-strip .lin-tile[data-id]").forEach((t) => t.onclick = () => select(t.dataset.id));
  const yt = $("#lin-strip .you"), sb = $("#lin-strip");
  if (yt) sb.scrollLeft = Math.max(0, yt.offsetLeft - sb.clientWidth / 2 + yt.offsetWidth / 2);
  makeThumbs(list);
}
let thumbing = false;
async function makeThumbs(list) {
  if (!stage || thumbing) return;
  thumbing = true;
  try {
    for (const m of list) {
      const key = m.id + "|" + S.palette;
      if (thumbs.has(key) || !hasModel(m.id)) continue;
      const url = await stage.thumb(m.id, 240, 150, S.palette);
      if (!url) break;
      thumbs.set(key, url);
      const im = $(`#lin-strip .lin-tile[data-id="${m.id}"] .im`);
      if (im) im.innerHTML = `<img src="${url}" alt="">`;
      await new Promise((r) => setTimeout(r, 30));
    }
  } finally { thumbing = false; }
}

// ---------------------------------------------------------------- the timeline chart
let geo = null, hoverX = null;
function series() {
  const st = S.st, recs = [];
  let best = 0;
  for (const m of st.machines.filter((x) => x.kind === "pre1993").sort((a, b) => a.year - b.year || a.rmax_gflops - b.rmax_gflops)) {
    if (m.rmax_gflops > best) { best = m.rmax_gflops; recs.push({ x: m.year + 0.5, y: m.rmax_gflops, id: m.id }); }
  }
  const n1 = st.lists.map((l) => ({ x: listX(l.date), y: l.n1_rmax_gflops, id: l.n1, date: l.date }));
  const n500 = st.lists.map((l) => ({ x: listX(l.date), y: l.n500_rmax_gflops, date: l.date }));
  return { recs, n1, n500 };
}
function drawChart(animate) {
  const cv = $("#lin-cv");
  if (!cv || !S.st) return;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  const dpr = window.devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { recs, n1, n500 } = series();
  const zEnd = +S.st.lists[S.st.lists.length - 1].date.slice(0, 4) + 1.2;
  const L = 46, R = 14, T = 12, B = 22, x0 = 1975.5, lo = Math.log10(0.05), hi = Math.log10(5e9);
  const X = (x) => L + (x - x0) / (zEnd - x0) * (W - L - R), Y = (v) => T + (hi - Math.log10(v)) / (hi - lo) * (H - T - B);
  geo = { X, Y, x0, zEnd, L, R, n1, recs };
  g.clearRect(0, 0, W, H);
  g.font = "500 10px 'JetBrains Mono', monospace"; g.textAlign = "right"; g.textBaseline = "middle";
  const units = [[0.1, "100 M"], [1, "1 G"], [1e3, "1 T"], [1e6, "1 P"], [1e9, "1 E"]];
  for (let e = -1; e <= 9; e++) {
    const v = 10 ** e, y = Y(v);
    g.strokeStyle = e % 3 === 0 ? "rgba(255,255,255,.09)" : "rgba(255,255,255,.035)"; g.lineWidth = 1;
    g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke();
    const u = units.find((q) => q[0] === v); if (u) { g.fillStyle = "#6d6e76"; g.fillText(u[1], L - 6, y); }
  }
  g.textAlign = "center"; g.textBaseline = "top";
  for (let yr = 1980; yr <= zEnd; yr += 5) { const x = X(yr); g.fillStyle = "#6d6e76"; g.fillText(yr, x, H - B + 6); g.strokeStyle = "rgba(255,255,255,.04)"; g.beginPath(); g.moveTo(x, T); g.lineTo(x, H - B); g.stroke(); }
  // the TOP500 era
  g.fillStyle = "rgba(212,0,0,.045)"; g.fillRect(X(1993.4), T, W - R - X(1993.4), H - T - B);
  g.fillStyle = "#8a8b93"; g.textAlign = "left"; g.fillText("TOP500 LISTS →", X(1993.4) + 6, T + 4);
  g.fillText("← DONGARRA'S LINPACK REPORT", L + 6, T + 4);
  const stepLine = (pts, col, w, dash) => {
    g.strokeStyle = col; g.lineWidth = w; g.setLineDash(dash || []); g.beginPath();
    pts.forEach((p, i) => { if (!i) g.moveTo(X(p.x), Y(p.y)); else { g.lineTo(X(p.x), Y(pts[i - 1].y)); g.lineTo(X(p.x), Y(p.y)); } });
    g.lineTo(X(zEnd), Y(pts[pts.length - 1].y)); g.stroke(); g.setLineDash([]);
  };
  stepLine(n500, "rgba(63,169,245,.55)", 1.2);
  stepLine(recs.concat(n1), "#e8e8ea", 1.6);
  g.fillStyle = "rgba(63,169,245,.8)"; g.textAlign = "left"; g.textBaseline = "bottom";
  g.fillText("#500", X(n500[n500.length - 1].x) - 34, Y(n500[n500.length - 1].y) - 3);
  // machine dots
  const seen = new Set();
  for (const p of recs.concat(n1)) {
    if (seen.has(p.id)) continue; seen.add(p.id);
    const on = p.id === S.sel, m = byId(p.id);
    g.beginPath(); g.arc(X(p.x), Y(p.y), on ? 5 : 3, 0, 7);
    g.fillStyle = on ? "#ff2a1a" : "#c8c9ce"; g.fill();
    if (on && m) { g.fillStyle = "#fff"; g.font = "600 11px 'Saira Condensed', sans-serif"; g.textAlign = X(p.x) > W - 140 ? "right" : "left"; g.textBaseline = "bottom"; g.fillText(`${short(m).toUpperCase()} · ${m.year}`, X(p.x) + (g.textAlign === "left" ? 7 : -7), Y(p.y) - 5); g.font = "500 10px 'JetBrains Mono', monospace"; }
  }
  // the card: a level line per precision and a glowing marker that slides to where it stops being #1
  cancelAnimationFrame(anim);
  const lines = ["fp64", "fp32"].map((k) => ({ k, p: placeOf(k) })).filter((q) => q.p);
  const target = (p) => {
    if (p.top500) return p.top500.until ? listX(p.top500.until) : zEnd - 0.2;
    if (p.pre1993 && p.pre1993.overtaken_year) return p.pre1993.overtaken_year + 0.5;
    return x0 + 0.3;
  };
  const base = g.getImageData(0, 0, cv.width, cv.height);
  const t0 = performance.now(), dur = animate ? 1800 : 0;
  const frame = (now) => {
    const f = dur ? Math.min(1, (now - t0) / dur) : 1, e = 1 - Math.pow(1 - f, 3);
    g.putImageData(base, 0, 0);
    for (const { k, p } of lines) {
      const active = k === S.prec, y = Y(p.gflops), xt = X(target(p)), xm = X(x0) + (xt - X(x0)) * e;
      g.strokeStyle = active ? "rgba(255,42,26,.85)" : "rgba(255,176,32,.55)"; g.lineWidth = active ? 1.5 : 1; g.setLineDash(k === "fp32" ? [5, 4] : []);
      g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke(); g.setLineDash([]);
      g.fillStyle = active ? "#ff6a5a" : "#ffb020"; g.font = "600 10px 'JetBrains Mono', monospace"; g.textAlign = "right"; g.textBaseline = k === "fp32" ? "bottom" : "top";
      g.fillText(`${(S.st.card.name || "card").toUpperCase()} ${k.toUpperCase()} ${gfmt(p.gflops)}`, W - R - 4, k === "fp32" ? y - 3 : y + 3);
      const rg = g.createRadialGradient(xm, y, 0, xm, y, active ? 16 : 10);
      rg.addColorStop(0, active ? "rgba(255,80,60,.95)" : "rgba(255,176,32,.8)"); rg.addColorStop(1, "rgba(255,42,26,0)");
      g.fillStyle = rg; g.beginPath(); g.arc(xm, y, active ? 16 : 10, 0, 7); g.fill();
      g.fillStyle = "#fff"; g.beginPath(); g.arc(xm, y, active ? 3.5 : 2.5, 0, 7); g.fill();
    }
    if (hoverX != null) hoverLine(g, W, H, T, B);
    if (f < 1) anim = requestAnimationFrame(frame);
  };
  anim = requestAnimationFrame(frame);
}
function hoverLine(g, W, H, T, B) {
  g.strokeStyle = "rgba(255,255,255,.3)"; g.lineWidth = 1; g.beginPath(); g.moveTo(hoverX, T); g.lineTo(hoverX, H - B); g.stroke();
}
function chartEvents() {
  const cv = $("#lin-cv"), tip = $("#lin-tip");
  const near = (e) => {
    if (!geo) return null;
    const r = cv.getBoundingClientRect(), mx = e.clientX - r.left;
    const yr = geo.x0 + (mx - geo.L) / (r.width - geo.L - geo.R) * (geo.zEnd - geo.x0);
    const all = geo.recs.map((p) => ({ ...p, date: null })).concat(geo.n1);
    let best = null;
    for (const p of all) if (p.x <= yr + 0.3 && (!best || p.x > best.x)) best = p;
    return { mx, best, yr };
  };
  cv.onmousemove = (e) => {
    const h = near(e); if (!h || !h.best) { tip.style.display = "none"; return; }
    const m = byId(h.best.id), l = h.best.date && S.st.lists.find((x) => x.date === h.best.date);
    const p = placeOf(), rk = p && l ? (p.ranks.find((r) => r.date === l.date) || {}).rank : null;
    tip.style.display = "block";
    tip.style.left = Math.min(cv.clientWidth - 230, h.mx + 12) + "px";
    tip.innerHTML = `<b>${l ? listName(l.date) : m.year}</b> · #1 ${esc(m.name)} ${gfmt(h.best.y)}${l ? `<br>#500 ${gfmt(l.n500_rmax_gflops)}` : ""}${p ? `<br>${esc(S.st.card.name || "card")} ${S.prec.toUpperCase()}: ${l ? (rk ? (rk === 1 ? "#1" : "about #" + rk) : "not on the list") : (p.gflops >= h.best.y ? "faster" : "slower")}` : ""}`;
  };
  cv.onmouseleave = () => { tip.style.display = "none"; };
  cv.onclick = (e) => { const h = near(e); if (h && h.best) select(h.best.id); };
}

// ---------------------------------------------------------------- How many Crays?
function drawCrays(animate) {
  const host = $("#lin-crayb");
  if (!host || !S.st) return;
  const p = placeOf(), cr = cmp() && cmp().crays[S.prec], c = cr && cr[S.cray];
  const tdp = S.st.card.tdp_w;
  if (!host.querySelector(".lin-cr")) {
    host.innerHTML = `<div class="lin-cr"><div class="tb"><div class="seg" id="lin-crs">${["cray-1", "cray-2", "cray-c90"].map((k) => `<button data-c="${k}">${esc((byId(k) || {}).name || k)}</button>`).join("")}</div></div>
      <div class="lin-crn" id="lin-crn"></div><canvas id="lin-crcv"></canvas><div class="lin-crx" id="lin-crx"></div></div>`;
    $$("#lin-crs button").forEach((b) => b.onclick = () => { S.cray = b.dataset.c; drawCrays(true); });
  }
  segOn("#lin-crs", S.cray);
  const cv = $("#lin-crcv");
  if (!c) {
    $("#lin-crn").innerHTML = `<div class="dim">Run LINPACK to fill the stack.</div>`;
    $("#lin-crx").innerHTML = ""; const g = cv.getContext("2d"); g.clearRect(0, 0, cv.width, cv.height); return;
  }
  const count = c.count, m = byId(S.cray);
  let unit = 1; while (count / unit > 360) unit *= 10;
  const marks = count / unit, full = Math.floor(marks), part = marks - full;
  $("#lin-crn").innerHTML = `<div class="big">${count >= 10 ? fmt.n(count, 0) : fmt.n(count, 2)}<small> × ${esc(m.name)}</small></div>
    <div class="s">${S.prec.toUpperCase()} ${gfmt(p.gflops)} ÷ ${gfmt(c.linpack_gflops)} LINPACK each${unit > 1 ? ` · one mark = ${fmt.n(unit)} machines` : ""}</div>`;
  const kw = c.power_kw ? count * c.power_kw : null;
  const cost = m.cost_usd ? count * m.cost_usd : null;
  $("#lin-crx").innerHTML = `<div class="kv">
    ${kw ? `<span>Their power</span><b>${kw >= 1000 ? fmt.n(kw / 1000, 1) + " MW" : fmt.n(kw, 0) + " kW"}</b><span>This card</span><b>${tdp ? tdp + " W board power" : "not known"}</b>
      ${tdp ? `<span>Power ratio</span><b>${fmt.n(kw * 1000 / tdp, 0)} : 1</b>` : ""}` : `<span>Their power</span><b>no published figure</b>`}
    ${cost ? `<span>Their price</span><b>US$${cost >= 1e9 ? fmt.n(cost / 1e9, 1) + " billion" : fmt.n(cost / 1e6, 0) + " million"} (${m.cost_year} dollars)</b>` : ""}</div>
    <div class="dim">${esc(m.name)}: ${esc(m.linpack_kind || "")}.${c.power_kw ? ` ${fmt.n(c.power_kw)} kW each, the computer only.` : ""}</div>`;
  // the stack: C-shaped marks fall into a grid, one per machine (or per group of machines)
  const W = cv.clientWidth, H = cv.clientHeight, dpr = window.devicePixelRatio || 1;
  if (!W || !H) return;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const n = Math.max(1, Math.ceil(marks));
  let cols = Math.max(1, Math.ceil(Math.sqrt(n * W / H))), rows = Math.ceil(n / cols);
  const cell = Math.min(W / cols, H / rows, 34);
  cols = Math.max(1, Math.floor(W / cell)); rows = Math.ceil(n / cols);
  const ox = (W - cols * cell) / 2, oy = H - rows * cell;
  const t0 = performance.now(), dur = animate ? Math.min(2600, 600 + n * 9) : 0;
  cancelAnimationFrame(crayAnim);
  const glyph = (x, y, r, frac) => {
    g.save(); g.translate(x, y);
    g.fillStyle = "#c20a06"; g.strokeStyle = "rgba(255,90,70,.6)"; g.lineWidth = 0.6;
    const gap = 0.47, a0 = -Math.PI / 2 + gap / 2, a1 = a0 + (2 * Math.PI - gap) * frac;
    g.beginPath(); g.arc(0, 0, r, a0, a1); g.arc(0, 0, r * 0.58, a1, a0, true); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = "#3fa9f5"; g.globalAlpha = 0.7; g.beginPath(); g.arc(0, 0, r * 0.22, 0, 7); g.fill();
    g.restore();
  };
  const frame = (now) => {
    g.clearRect(0, 0, W, H);
    const tt = dur ? (now - t0) / dur : 2;
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / cols), col = i % cols;
      const tx = ox + (col + 0.5) * cell, ty = oy + (rows - 1 - row + 0.5) * cell;
      const start = i / n * 0.75, f = Math.max(0, Math.min(1, (tt - start) / 0.25));
      if (f <= 0) continue;
      const y = -cell + (ty + cell) * (f * f);
      glyph(tx, y, cell * 0.42, i === n - 1 && part > 0 ? part : 1);
    }
    if (tt < 1.01) crayAnim = requestAnimationFrame(frame);
  };
  crayAnim = requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- the share picture
async function share() {
  const p = placeOf("fp64") || placeOf("fp32");
  if (!p) { toast("Run LINPACK first."); return; }
  const prec = placeOf("fp64") ? "fp64" : "fp32";
  const c1 = cmp().crays[prec]["cray-1"];
  const cn = S.st.card.name || "GPU";
  const W = 1200, H = 630, cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const g = cv.getContext("2d");
  const bg = g.createLinearGradient(0, 0, W, H); bg.addColorStop(0, "#0b0b0d"); bg.addColorStop(1, "#16090a");
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  // the art: the machine it beats, or the latest beaten machine that has a model
  const beaten = machines().filter((m) => m.rmax_gflops <= p.gflops && (hasModel(m.id) || stillUrl(m.id)));
  const am = hasModel(p.beats) || stillUrl(p.beats) ? byId(p.beats) : beaten[beaten.length - 1];
  const art = am ? (stage && hasModel(am.id) ? await stage.thumb(am.id, 560, 420, S.palette) : stillUrl(am.id)) : null;
  if (art) {
    const im = await loadImg(art);
    if (im) { g.drawImage(im, 40, 105, 560, 420); g.font = "600 18px 'JetBrains Mono', monospace"; g.fillStyle = "#8a8b93"; g.fillText(`${am.name}, ${am.year}`, 40, 555); }
  }
  g.fillStyle = "#d40000"; g.fillRect(0, 0, W, 8);
  const fit = (font, t, sz, max) => { let z = sz; do { g.font = font(z); } while (g.measureText(t).width > max && --z > 10); };
  const head = (t, x, y, sz, col = "#f4f4f5", wt = 800) => { fit((z) => `${wt} ${z}px 'Saira Condensed', sans-serif`, t, sz, W - x - 40); g.fillStyle = col; g.fillText(t, x, y); };
  const mono = (t, x, y, sz, col) => { fit((z) => `500 ${z}px 'JetBrains Mono', monospace`, t, sz, W - x - 40); g.fillStyle = col; g.fillText(t, x, y); };
  g.textBaseline = "alphabetic"; g.textAlign = "left";
  head("MY " + cn.toUpperCase(), 640, 150, 54);
  head(`= ${fmt.n(c1.count, 0)} CRAY-1s`, 640, 240, 76, "#ff2a1a");
  let line = "";
  if (p.top500) line = `#1 ON THE TOP500 IN ${listName(p.top500.list).toUpperCase()}`;
  else if (p.pre1993) line = `THE FASTEST COMPUTER IN ${p.year}`;
  head(line, 640, 310, 40, "#f4f4f5", 700);
  const bm = byId(p.beats);
  mono(`${prec.toUpperCase()} LINPACK ${gfmt(p.gflops)}`, 640, 370, 22, "#c8c9ce");
  if (bm) mono(`faster than the ${bm.name} (${bm.year})`, 640, 404, 22, "#c8c9ce");
  if (p.last_on_list) mono(`on the TOP500 until ${listName(p.last_on_list)}`, 640, 438, 22, "#c8c9ce");
  mono("measured on the card · HPL residual check passed", 640, 555, 16, "#8a8b93");
  head("VECTORFALL", 40, 80, 30, "#ff2a1a", 800);
  const a = document.createElement("a");
  a.download = `${cn.replace(/[^A-Za-z0-9]+/g, "-")}-lineage.png`;
  a.href = cv.toDataURL("image/png");
  a.click();
}
const loadImg = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = src; });
