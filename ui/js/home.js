import { $, $$, api, esc, fmt, go, icon, machine, onMachine, pane, toast } from "./core.js";
import { PROBLEMS } from "./hub.js";

// Home: what you can solve, first — eight everyday problems, each one click from the tool that answers it, with your own
// data as the input. Then the operations console for the card: gauges with sparklines, a telemetry trace, an activity
// feed built from the machine poll, what is resident on the card, and a dense launcher with live status per app.
const APPS = [
  ["text", "Text Engine", "Search, trace sources, Markov, embeddings"],
  ["photo", "Photo Lab", "Develop photos; search them by their contents"],
  ["sound", "Sound Lab", "Edit audio; find every occurrence of a sound"],
  ["data", "Data Desk", "Tables, tickers, anomalies, statistics"],
  ["plan", "Planner", "Rosters, routes and fair teams"],
  ["simulate", "Simulate", "Odds from your estimates and history"],
  ["particles", "Particle Lab", "Populations as N-body systems, checked against history"],
  ["reservoir", "Reservoir Lab", "Teach it sounds and pictures; forecast"],
  ["console", "Console", "Python IDE that runs on the card"],
  ["fractal", "Fractals", "Deep zoom to 10^75 (Mandelbrot), links and presets"],
  ["life", "Patterns", "N-body, random walks, reaction–diffusion"],
  ["models", "Models", "Every operation as CLI, OpenAPI, RPC, MCP"],
];
const AICON = { text: "text", photo: "photo", sound: "sound", data: "data", simulate: "forecast", fractal: "fractal", life: "life", console: "console", plan: "gantt", reservoir: "reservoir", particles: "orbit", models: "bolt" };
const SPAN = 300;                                       // seconds of telemetry kept (5 minutes)
const KEY = "vf-home-telemetry", FKEY = "vf-home-feed";
let samples = [];                                       // {t, util, mem, temp, gf} — survives reloads (per browser)
let feed = [];
try { samples = JSON.parse(localStorage.getItem(KEY) || "[]"); feed = JSON.parse(localStorage.getItem(FKEY) || "[]"); } catch (e) { samples = []; feed = []; }
let saveAt = 0;
let lastWorker = null, lastKernelAt = null, lastJobs = "", unsub = null, counts = {}, booted = false;

export default {
  id: "home", title: "VectorFall", sub: "Supercomputing Platform", icon: "home", scroll: true,
  mount(el) {
    let welcome = true; try { welcome = !localStorage.getItem("vf.welcome.seen"); } catch (e) { /* storage off */ }
    el.innerHTML = `${welcome ? `<div class="home-welcome" id="home-welcome"><div><b>New here?</b> Pick a problem below — the ones that need data have <b>Try with a sample</b>.
      Press <kbd>Ctrl</kbd> <kbd>K</kbd> to find any app, table or command. <b>Machine</b> shows the card itself, live.</div><button class="btn ghost xs" id="home-welcome-x">Got it</button></div>` : ""}<div class="ws home">
      ${pane({ id: "home-solve", t: "What do you need to solve?", meta: "your data in, an answer out — checked against a simple baseline", bcls: "flush", body: `<div class="hsolve">${PROBLEMS.map((p, i) => `
        <div class="hsv" data-p="${i}" role="button" tabindex="0"><div class="ic">${icon(p.icon)}</div><div class="tx"><b>${esc(p.q)}</b><span>${esc(p.a)}</span>${p.sample ? `<button class="lnk hsv-try" data-try="${i}" title="Open it on ${esc(p.sample.says)}">Try with a sample</button>` : ""}</div></div>`).join("")}</div>` })}
      <div class="hg" id="home-gauges"></div>
      <div class="home-mid">
        ${pane({ id: "home-tel", t: "Telemetry", meta: "last 5 minutes", tools: `<div class="legend" id="home-leg"></div>`, bcls: "flush", body: `<div class="chartbox"><canvas id="home-trace"></canvas></div>`, foot: "&nbsp;" })}
        ${pane({ id: "home-act", t: "Activity", meta: "", bcls: "flush", bid: "home-feed" })}
        ${pane({ id: "home-res", t: "Resident", meta: "on the card and in its stores", bcls: "flush", bid: "home-resb" })}
      </div>
      ${pane({ id: "home-apps", t: "Applications", meta: "", bcls: "flush", body: `<div class="happs">${APPS.map(([id, nm, tg]) => `
        <a class="happ" href="#${id}"><div class="ic">${icon(AICON[id])}</div><div class="tx"><div class="nm">${esc(nm)}</div><div class="tg">${esc(tg)}</div></div>
          <div class="st" data-st="${id}">—</div></a>`).join("")}</div>` })}
    </div>`;
    $("#home-leg").innerHTML = [["#ff2a1a", "GPU"], ["#3fa9f5", "memory"], ["#ffd300", "temp °C"], ["#2fd38a", "GFLOP/s % peak"]]
      .map(([c, l]) => `<span><i style="background:${c}"></i>${l}</span>`).join("");
    $$("#home-solve [data-p]").forEach((b) => { b.onclick = (e) => { if (e.target.closest("[data-try]")) return; const p = PROBLEMS[+b.dataset.p]; go(p.go[0], p.go[1]); };
      b.onkeydown = (e) => { if (e.key === "Enter") b.click(); }; });
    $$("#home-solve [data-try]").forEach((b) => b.onclick = async () => {
      const p = PROBLEMS[+b.dataset.try]; b.textContent = "making the sample…";
      try { const r = await api.post("/samples/" + p.sample.kind); const [v, prm] = p.sample.go(r.id); go(v, prm); }
      catch (e) { toast("The sample failed: " + e.message, "bad"); b.textContent = "Try with a sample"; }
    });
    const wx = $("#home-welcome-x"); if (wx) wx.onclick = () => { try { localStorage.setItem("vf.welcome.seen", "1"); } catch (e) { /* storage off */ } $("#home-welcome").remove(); };
    if (!booted) { booted = true; log("VectorFall console attached", "ok"); }
    unsub = onMachine(paint);
    loadCounts();
    window.addEventListener("resize", () => { if (document.querySelector("#view-home.on")) trace(); });
  },
  show() { loadCounts(); requestAnimationFrame(trace); },           // telemetry keeps recording while other apps are open
};

function sample(rec) {
  samples.push(rec);
  const cut = rec.t - SPAN;
  while (samples.length && samples[0].t < cut) samples.shift();
  if (rec.t - saveAt > 10) { saveAt = rec.t; try { localStorage.setItem(KEY, JSON.stringify(samples)); } catch (e) { /* storage off */ } }
}
// lines with the same key (a kernel being re-measured every poll) coalesce into one row with a count
function log(text, kind = "", key = null) {
  const t = new Date().toTimeString().slice(0, 8), top = feed[0];
  if (key && top && top.key === key) { top.n = (top.n || 1) + 1; top.text = text; top.t = t; }
  else { feed.unshift({ t, text, kind, key }); if (feed.length > 80) feed.pop(); }
  try { localStorage.setItem(FKEY, JSON.stringify(feed)); } catch (e) { /* storage off */ }
  renderFeed();
}
function renderFeed() {
  const el = $("#home-feed"); if (!el) return;
  const w = machine.last && machine.last.worker;
  const idle = !(w && w.busy) ? `<div class="fr idle"><span class="ft">now</span><span class="fx">card idle. The log shows each computation from each app here.</span></div>` : "";
  el.innerHTML = `<div class="feed">${idle}${feed.map((f) => `<div class="fr ${f.kind}"><span class="ft">${f.t}</span><span class="fx">${esc(f.text)}${f.n > 1 ? ` <span class="dim">×${f.n}</span>` : ""}</span></div>`).join("")}</div>`;
  const m = $("#home-act .meta"); if (m) m.textContent = `${feed.length} events`;
}

function paint(m) {
  const c = m.card, L = m.live || {}, meas = m.measured || {}, w = m.worker || {};
  const gfFresh = meas.gflops_at && Date.now() / 1000 - meas.gflops_at < 4;
  sample({ t: Date.now() / 1000, util: L.util_gpu || 0, mem: L.mem_total ? L.mem_used / L.mem_total * 100 : 0, temp: L.temp || 0,
    gf: gfFresh && meas.gflops ? Math.min(100, meas.gflops / c.fp32_gflops * 100) : 0 });

  // activity: worker transitions, jobs, measured kernels
  const cur = w.busy ? (w.current || "computing") : null;
  if (cur !== lastWorker) { if (cur) log("▶ " + cur, "run"); else if (lastWorker) log("■ idle — " + lastWorker + " finished", ""); lastWorker = cur; }
  if (meas.gflops_at && meas.gflops_at !== lastKernelAt) {
    if (lastKernelAt && meas.kernel && meas.gflops >= 0.5) log(`${meas.kernel} · ${fmt.n(meas.gflops, 1)} GFLOP/s`, "k", "k:" + meas.kernel);
    lastKernelAt = meas.gflops_at;
  }
  const js = (m.jobs || []).map((j) => j.label).join("|");
  if (js !== lastJobs) { (m.jobs || []).forEach((j) => { if (!lastJobs.includes(j.label)) log(`job: ${j.label} — ${j.message || "started"}`, "run"); }); lastJobs = js; }

  const memPct = L.mem_total ? L.mem_used / L.mem_total * 100 : 0;
  const g = (k, label, val, sub, pct, cls, series, color) => `<section class="pane hgc ${cls}"><div class="hgl">${label}</div><div class="hgv">${val}</div>
    <canvas class="spark" data-k="${k}" data-c="${color}"></canvas><div class="hgb"><i style="width:${Math.max(0, Math.min(100, pct || 0))}%"></i></div><div class="hgs">${esc(sub || "")}</div></section>`;
  $("#home-gauges").innerHTML =
    g("util", "GPU utilisation", `${L.util_gpu ?? 0}<small>%</small>`, w.busy ? "● " + (w.current || "computing") : `${L.pstate || ""} · idle`, L.util_gpu, "", 0, "#ff2a1a") +
    g("mem", "Memory", `${fmt.n(L.mem_used)}<small> / ${fmt.n(L.mem_total)} MB</small>`, `${fmt.n(L.mem_free)} MB free${c.mem_type ? ` · ${c.mem_type} ${c.mem_bus_bits}-bit` : ""}`, memPct, "blue", 0, "#3fa9f5") +
    g("gf", "Compute", meas.gflops != null && gfFresh ? `${fmt.n(meas.gflops, 1)}<small> GFLOP/s</small>` : `<small class="dim">idle</small>`, `peak ${c.fp32_gflops} FP32 · ${c.fp64_gflops} FP64`, gfFresh ? meas.gflops / c.fp32_gflops * 100 : 0, "green", 0, "#2fd38a") +
    g("temp", "Temperature", `${L.temp ?? "—"}<small>°C</small>`, `fan ${L.fan ?? "—"}% · ${L.pstate || ""}`, (L.temp || 0) / 95 * 100, "heat", 0, "#ffd300") +
    `<section class="pane hgc blue"><div class="hgl">PCIe bus</div><div class="hgv">${meas.pcie_h2d_gbs != null ? `${meas.pcie_h2d_gbs}<small> GB/s ↓</small>` : `gen ${L.pcie_gen ?? "—"}`}</div>
      <div class="hgk"><span>to card</span><b>${meas.pcie_h2d_gbs ?? "—"} GB/s</b><span>from card</span><b>${meas.pcie_d2h_gbs ?? "—"} GB/s</b><span>link</span><b>gen ${L.pcie_gen}/${L.pcie_gen_max} ×${L.pcie_width}</b></div></section>` +
    `<section class="pane hgc"><div class="hgl">Cores</div><div class="hgv">${c.cores}<small> CUDA</small></div>
      <div class="cores" id="home-cores">${Array.from({ length: Math.min(192, c.cores || 192) }, () => "<i></i>").join("")}</div><div class="hgs">${c.name} · ${fmt.n(c.cores)} cores · ${c.smx} ${c.sm_word || "SM"} · ${c.arch} · cc ${c.cc.split(" ")[0]} · ${L.clock_sm ?? "—"} MHz</div></section>`;
  const util = Math.max((L.util_gpu || 0) / 100, w.busy ? 0.55 : 0), nc = $$("#home-cores i").length || 192, lit = Math.round(nc * util), p = Date.now() / 1500 | 0;
  $$("#home-cores i").forEach((e, i) => e.classList.toggle("on", w.busy ? ((i * 37 + p * 11) % nc) < lit : i < lit));
  $$("#home-gauges canvas.spark").forEach((cv) => spark(cv, cv.dataset.k, cv.dataset.c, cv.dataset.k === "temp" ? [30, 95] : [0, 100]));
  const f = $("#home-tel-f");
  if (f) f.innerHTML = `<span>GPU <b>${L.util_gpu ?? 0}%</b></span><span>mem <b>${Math.round(memPct)}%</b></span><span>temp <b>${L.temp ?? "—"}°C</b></span><span>SM <b>${L.clock_sm ?? "—"} MHz</b></span><span>mem clk <b>${L.clock_mem ?? "—"} MHz</b></span><span class="timing" style="margin-left:auto">${w.queued ? w.queued + " queued" : "queue empty"}</span>`;
  trace();
  renderResident(m);
}

function win() {
  const now = Date.now() / 1000, have = samples.length ? now - samples[0].t : 0;
  return { now, span: Math.max(60, Math.min(SPAN, Math.ceil(have / 30) * 30)) };
}
function spark(cv, k, color, [lo, hi]) {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h || samples.length < 2) return;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { now, span } = win();
  const X = (t) => w - (now - t) / span * w, Y = (v) => h - 1 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * (h - 2);
  g.beginPath(); samples.forEach((r, i) => i ? g.lineTo(X(r.t), Y(r[k])) : g.moveTo(X(r.t), Y(r[k])));
  g.strokeStyle = color; g.lineWidth = 1.2; g.stroke();
  g.lineTo(X(samples[samples.length - 1].t), h); g.lineTo(X(samples[0].t), h); g.closePath(); g.globalAlpha = 0.12; g.fillStyle = color; g.fill();
}

function trace() {
  const cv = $("#home-trace"); if (!cv) return;
  const box = cv.parentElement, dpr = window.devicePixelRatio || 1, w = box.clientWidth, h = box.clientHeight;
  if (!w || !h) return;
  cv.width = w * dpr; cv.height = h * dpr; cv.style.height = h + "px";
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const pl = 40, pr = 12, pt = 12, pb = 22, W = w - pl - pr, H = h - pt - pb;
  const { now, span } = win();
  g.font = "10px 'JetBrains Mono', monospace"; g.fillStyle = "#5d5e66"; g.strokeStyle = "rgba(255,255,255,.06)"; g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const y = pt + H * i / 4; g.beginPath(); g.moveTo(pl, y); g.lineTo(pl + W, y); g.stroke(); g.textAlign = "right"; g.fillText((100 - i * 25) + "%", pl - 6, y + 3); }
  g.textAlign = "center";
  for (let i = 0; i <= 5; i++) {
    const x = pl + W * i / 5, ago = span * (5 - i) / 5;
    g.fillText(i === 5 ? "now" : ago >= 60 ? `-${+(ago / 60).toFixed(1)}m` : `-${Math.round(ago)}s`, x, h - 6);
    g.beginPath(); g.moveTo(x, pt); g.lineTo(x, pt + H); g.stroke();
  }
  const m = $("#home-tel .meta"); if (m) m.textContent = "last " + (span >= 60 ? +(span / 60).toFixed(1) + " min" : span + " s");
  if (samples.length < 2) return;
  const X = (t) => pl + W - (now - t) / span * W, Y = (v) => pt + H - Math.max(0, Math.min(100, v)) / 100 * H;
  for (const [k, col] of [["mem", "#3fa9f5"], ["temp", "#ffd300"], ["gf", "#2fd38a"], ["util", "#ff2a1a"]]) {
    g.beginPath(); samples.forEach((r, i) => i ? g.lineTo(X(r.t), Y(r[k])) : g.moveTo(X(r.t), Y(r[k])));
    g.strokeStyle = col; g.lineWidth = k === "util" ? 1.8 : 1.3; g.stroke();
    if (k === "util") { g.lineTo(X(samples[samples.length - 1].t), pt + H); g.lineTo(X(samples[0].t), pt + H); g.closePath(); g.globalAlpha = 0.1; g.fillStyle = col; g.fill(); g.globalAlpha = 1; }
  }
}

function renderResident(m) {
  const el = $("#home-resb"); if (!el) return;
  const L = m.live || {}, c = counts.corpus, meas = m.measured || {};
  const procs = (L.procs || []).map((p) => `<div class="li"><div class="tx"><div class="nm mono">${esc(p.name === "[Not Found]" ? "GPU process" : p.name)}</div><div class="sub">pid ${p.pid}</div></div><div class="end">${p.mem_mb} MB</div></div>`).join("");
  const row = (ic, nm, sub, end, href) => `<a class="li" href="#${href}"><div class="ic">${icon(ic)}</div><div class="tx"><div class="nm">${nm}</div><div class="sub">${sub}</div></div><div class="end">${end}</div></a>`;
  el.innerHTML = `<div class="list">
    ${row("text", c && c.loaded ? esc(c.name) : "No corpus", c && c.loaded ? `${fmt.big(c.words)} words · ${fmt.n(c.unique_words)} unique · ${c.compression}× packed` : "load text in the Text Engine", c && c.loaded ? `${c.on_card_mb} MB` : "—", "text")}
    ${row("photo", "Photos", "developed on the card", counts.photos ?? "—", "photo")}
    ${row("sound", "Sound clips", "edited in place, undo history kept", counts.sounds ?? "—", "sound")}
    ${row("data", "Tables", "CSV / Excel", counts.tables ?? "—", "data")}
    ${row("console", "Scripts", "console workspace", counts.files ?? "—", "console")}
  </div>
  <div class="grp">Card memory · ${fmt.n(L.mem_used)} of ${fmt.n(L.mem_total)} MB</div>
  <div class="memmap">${memmap(m)}</div>
  <div class="list">${procs || '<div class="li"><div class="sub">nothing resident</div></div>'}</div>
  <div class="grp">Measured on this card</div>
  <div class="kv hkv"><span>last kernel</span><b>${esc(meas.kernel || "—")}</b>
    <span>host → card</span><b>${meas.pcie_h2d_gbs ?? "—"} GB/s</b><span>card → host</span><b>${meas.pcie_d2h_gbs ?? "—"} GB/s</b>
    <span>memory scan</span><b>${meas.bandwidth_gbs != null ? meas.bandwidth_gbs + " GB/s" : "run the benchmark"}</b>
    <span>FP32 peak ≈</span><b>${fmt.n(m.card.cray.fp32_in_cray1s)} Cray-1s</b><span>FP64 peak ≈</span><b>${esc(String(m.card.cray.fp64_vs_c90).replace("~= ", ""))}</b></div>`;
}

function memmap(m) {
  const L = m.live || {}, tot = L.mem_total || 1, procs = L.procs || [];
  const worker = procs.reduce((a, p) => a + (p.mem_mb || 0), 0), other = Math.max(0, (L.mem_used || 0) - worker);
  const corpus = Math.min(worker, (counts.corpus && counts.corpus.loaded && counts.corpus.on_card_mb) || 0);
  const seg = (mb, cls, t) => mb > 0 ? `<i class="${cls}" style="width:${mb / tot * 100}%" title="${esc(t)}: ${fmt.n(mb)} MB"></i>` : "";
  return `<div class="mmbar">${seg(corpus, "c", "text corpus")}${seg(worker - corpus, "w", "GPU processes")}${seg(other, "o", "driver / other")}</div>
    <div class="mmleg"><span><i class="c"></i>corpus ${fmt.n(corpus, 1)}</span><span><i class="w"></i>processes ${fmt.n(worker - corpus)}</span><span><i class="o"></i>driver ${fmt.n(other)}</span><span><i></i>free ${fmt.n(L.mem_free)}</span></div>`;
}

async function loadCounts() {
  const set = (id, t) => { const e = document.querySelector(`[data-st="${id}"]`); if (e) e.textContent = t; };
  const n = (a) => Array.isArray(a) ? a.length : 0;
  const [corpus, photos, sounds, tables, files, projects] = await Promise.all(["/text/active", "/photos", "/sounds", "/tables", "/console/files", "/reservoir/projects"].map((p) => api.get(p).catch(() => null)));
  counts = { corpus, photos: n(photos), sounds: n(sounds), tables: n(tables), files: n(files) };
  set("text", corpus && corpus.loaded ? `${fmt.big(corpus.words)} words` : "no corpus");
  set("photo", counts.photos ? `${counts.photos} photos` : "empty");
  set("sound", counts.sounds ? `${counts.sounds} clips` : "empty");
  set("data", counts.tables ? `${counts.tables} tables` : "empty");
  set("simulate", "7 engines");
  set("plan", "3 problems");
  set("reservoir", projects && projects.length ? `${projects.length} projects` : "empty");
  set("particles", "3 worlds");
  set("fractal", "4 sets");
  set("life", "7 sims");
  set("console", counts.files ? `${counts.files} scripts` : "examples");
  const m = $("#home-apps .meta"); if (m) m.textContent = "click to open";
  if (machine.last) renderResident(machine.last);
}
