import { $, $$, api, esc, fmt, icon, machine, onMachine, pane } from "./core.js";

// The Machine: the SMX visualised live (main stage), benchmarks with a run history beneath it, and an inspector of
// the card's real specification, live readings, an occupancy calculator and who holds the memory.
let raf = 0, hover = null, runs = [];
const RKEY = "vf-bench-runs";
try { runs = JSON.parse(localStorage.getItem(RKEY) || "[]"); } catch (e) { runs = []; }

export default {
  id: "machine", title: "The Machine", sub: "the NVIDIA card, live", icon: "machine",
  mount(el) {
    el.innerHTML = `<div class="ws side-r mach2">
      <div class="col">
        ${pane({ id: "mc-stage", t: "Streaming multiprocessor", meta: "", cls: "grow", bcls: "stage", body: `<canvas id="mach-cv"></canvas>
          <div class="mhud"><div class="big" id="mach-util">—</div><div class="sm" id="mach-state">—</div></div>
          <div class="mleg"><span><i style="background:#ff2a1a"></i>active lanes</span><span><i style="background:#3fa9f5"></i>memory · PCIe</span><span><i style="background:#ffd300"></i>heat</span></div>
          <div class="tipbox" id="mach-tip"></div>`, foot: "&nbsp;" })}
        ${pane({ id: "mc-bench", t: "Benchmarks", meta: "timed on the card · sized to the free memory", cls: "fit", bcls: "flush",
          tools: `<a class="btn ghost sm" href="#lineage" title="Compare this card with the TOP500 and the Crays">Compare with history</a><button class="btn ghost sm" id="mach-pcie">Measure PCIe</button><button class="btn sm" id="mach-bench">${icon("bolt")} Run benchmark</button>`, bid: "mach-bres" })}
      </div>
      <div class="col">
        ${pane({ id: "mc-host", t: "Host CPU · memory", meta: "", cls: "fit", bid: "mach-host", body: '<div class="skeleton" style="height:120px"></div>' })}
        ${pane({ t: "Card", meta: "", cls: "grow", bcls: "flush", bid: "mach-spec" })}
        ${pane({ t: "Occupancy", meta: "per multiprocessor, from the launch shape", cls: "fit", bid: "mach-occ" })}
      </div>
    </div>`;
    $("#mach-bench").onclick = bench;
    $("#mach-pcie").onclick = pcie;
    occupancyUI();
    renderBench();
    onMachine(paint);
    start();
  },
  show() { if (!raf) start(); },
  hide() { cancelAnimationFrame(raf); raf = 0; },
};

function start() { const cv = $("#mach-cv"); if (cv) draw(cv); }
function saveRuns() { try { localStorage.setItem(RKEY, JSON.stringify(runs.slice(0, 12))); } catch (e) { /* storage off */ } }

async function bench() {
  const b = $("#mach-bench"); b.disabled = true; $("#mc-bench").classList.add("is-busy");
  $("#mc-bench .meta").textContent = "the card runs SGEMM, FFT and a memory scan…";
  try {
    const r = await api.post("/machine/benchmark");
    runs.unshift({ at: Date.now(), kind: "bench", ...r }); saveRuns();
    $("#mc-bench .meta").textContent = "timed on the card · sized to the free memory";
  } catch (e) { $("#mc-bench .meta").textContent = "benchmark failed: " + e.message; }
  b.disabled = false; $("#mc-bench").classList.remove("is-busy"); renderBench();
}
async function pcie() {
  const b = $("#mach-pcie"); b.disabled = true; $("#mc-bench").classList.add("is-busy");
  try { const r = await api.post("/machine/pcie"); runs.unshift({ at: Date.now(), kind: "pcie", h2d: r.h2d, d2h: r.d2h }); saveRuns(); }
  catch (e) { $("#mc-bench .meta").textContent = "PCIe test failed: " + e.message; }
  b.disabled = false; $("#mc-bench").classList.remove("is-busy"); renderBench();
}
function renderBench() {
  const c = machine.last && machine.last.card;
  const peak = { sgemm: c ? c.fp32_gflops : 336.4, bw: c ? c.mem_bandwidth_gbs : 29, pcie: 8 };
  const lastB = runs.find((r) => r.kind === "bench"), lastP = runs.find((r) => r.kind === "pcie");
  const meas = (machine.last && machine.last.measured) || {};
  const h2d = lastP ? lastP.h2d : meas.pcie_h2d_gbs, d2h = lastP ? lastP.d2h : meas.pcie_d2h_gbs;
  const row = (nm, sub, val, unit, pct, note) => `<tr><td><div class="bn">${nm}</div><div class="bs">${sub}</div></td>
    <td class="r bv">${val == null ? "—" : val}<small> ${unit}</small></td>
    <td class="bbar">${pct == null ? "" : `<div class="hgb"><i style="width:${Math.min(100, pct)}%"></i></div><span>${Math.round(pct)}% of peak</span>`}</td><td class="bnote">${note}</td></tr>`;
  const when = (r) => r ? new Date(r.at).toLocaleTimeString() : "not run yet";
  $("#mach-bres").innerHTML = `<table class="tbl btbl"><tbody>
    ${row("Matrix multiply", lastB ? `cuBLAS SGEMM ${lastB.sgemm_n}×${lastB.sgemm_n}` : "cuBLAS SGEMM", lastB && lastB.sgemm_gflops, "GFLOP/s", lastB ? lastB.sgemm_gflops / peak.sgemm * 100 : null, lastB ? `${when(lastB)} · measured ≈ ${fmt.n(lastB.sgemm_gflops * 1000 / 160)} Cray-1s` : "not run yet")}
    ${row("FFT", "cuFFT 1024×1024 complex", lastB && lastB.fft_ms, "ms", null, when(lastB))}
    ${row("Memory scan", "VectorFall 2-byte token scan", lastB && lastB.scan_gbs, "GB/s", lastB ? lastB.scan_gbs / peak.bw * 100 : null, `${when(lastB)} · ${c && c.mem_type ? c.mem_type + " " : ""}peak ${peak.bw} GB/s`)}
    ${row("PCIe host → card", "pinned copy, gen 2 ×16", h2d, "GB/s", h2d != null ? h2d / peak.pcie * 100 : null, lastP ? when(lastP) : "from the last measurement")}
    ${row("PCIe card → host", "pinned copy", d2h, "GB/s", d2h != null ? d2h / peak.pcie * 100 : null, lastP ? when(lastP) : "")}
  </tbody></table>
  ${runs.filter((r) => r.kind === "bench").length > 1 ? `<div class="bhist">${runs.filter((r) => r.kind === "bench").slice(0, 8).map((r) => `<span title="${new Date(r.at).toLocaleString()}"><b>${r.sgemm_gflops}</b> GF/s · <b>${r.scan_gbs}</b> GB/s</span>`).join("")}</div>` : ""}`;
}

// ---- host CPU / memory: proof that GPU work leaves the CPU alone
const hostHist = [];
function renderHost(H) {
  const el = $("#mach-host"); if (!el || !H) return;
  const vfShare = Math.min(100, H.vectorfall_cpu / Math.max(1, H.n));
  hostHist.push([H.cpu, vfShare]); if (hostHist.length > 120) hostHist.shift();
  $("#mc-host .meta").textContent = `${H.model.replace(/\(R\)|\(TM\)|CPU|@/g, "").replace(/\s+/g, " ").trim()} · ${H.n} cores`;
  const memPct = H.mem_total_mb ? H.mem_used_mb / H.mem_total_mb * 100 : 0;
  if (!el.querySelector(".hc-cores")) el.innerHTML = `<div class="hc-cores"></div>
    <div class="hc-row"><span>Whole CPU</span><div class="hc-bar"><i class="hc-all"></i><i class="hc-vf"></i></div><b class="hc-allv"></b></div>
    <div class="hc-row"><span>VectorFall</span><div class="hc-bar"><i class="hc-vf2"></i></div><b class="hc-vfv"></b></div>
    <div class="hc-row"><span>Memory</span><div class="hc-bar"><i class="hc-mem"></i></div><b class="hc-memv"></b></div>
    <canvas class="hc-hist"></canvas><div class="hc-note"></div>`;
  const cores = el.querySelector(".hc-cores");
  if (cores.children.length !== H.n) cores.innerHTML = H.cores.map((_, i) => `<div class="hc-core"><div class="hc-col"><i></i></div><span>cpu${i}</span><b></b></div>`).join("");
  H.cores.forEach((c, i) => { const d = cores.children[i]; const b = d.querySelector("i"); b.style.height = Math.max(2, c) + "%"; b.className = c > 85 ? "hot" : c > 60 ? "warm" : ""; d.querySelector("b").textContent = Math.round(c) + "%"; });
  el.querySelector(".hc-all").style.width = H.cpu + "%"; el.querySelector(".hc-vf").style.width = vfShare + "%";
  el.querySelector(".hc-allv").textContent = Math.round(H.cpu) + "%";
  el.querySelector(".hc-vf2").style.width = vfShare + "%"; el.querySelector(".hc-vfv").textContent = `${H.vectorfall_cpu}% of a core`;
  el.querySelector(".hc-mem").style.width = memPct + "%"; el.querySelector(".hc-memv").textContent = `${(H.mem_used_mb / 1024).toFixed(1)} / ${Math.round(H.mem_total_mb / 1024)} GB`;
  const other = Math.max(0, H.cpu - vfShare);
  el.querySelector(".hc-note").innerHTML = `load ${H.load.map((x) => x.toFixed(2)).join(" · ")} — ${vfShare < 15 ? `<b class="ok">VectorFall is barely touching the CPU</b>${other > 50 ? "; the load is from other software on this host" : ""}` : `<b class="warn">VectorFall is using ${H.vectorfall_cpu}% of a core</b>`}`;
  const cv = el.querySelector(".hc-hist"), dpr = window.devicePixelRatio || 1, W = cv.clientWidth, Hh = 46;
  cv.width = W * dpr; cv.height = Hh * dpr; const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, Hh);
  const xs = (i) => W - (hostHist.length - 1 - i) * (W / 119), ys = (v) => Hh - 2 - v / 100 * (Hh - 4);
  g.beginPath(); hostHist.forEach((p, i) => { if (i) g.lineTo(xs(i), ys(p[0])); else g.moveTo(xs(i), ys(p[0])); });
  g.lineTo(W, Hh); g.lineTo(xs(0), Hh); g.closePath(); g.fillStyle = "rgba(63,169,245,.2)"; g.fill();
  for (const [k, col] of [[0, "#3fa9f5"], [1, "#ff2a1a"]]) { g.beginPath(); hostHist.forEach((p, i) => { if (i) g.lineTo(xs(i), ys(p[k])); else g.moveTo(xs(i), ys(p[k])); }); g.strokeStyle = col; g.lineWidth = 1.5; g.stroke(); }
}

function paint(m) {
  const c = m.card, L = m.live || {}, meas = m.measured || {}, w = m.worker || {};
  const u = $("#mach-util"); if (!u) return;
  u.innerHTML = `${L.util_gpu ?? 0}<small>%</small>`;
  const act = m.activity || [];
  $("#mach-state").textContent = act.length ? "● " + act.map((a) => a.label).join(" · ") : `${L.pstate || "idle"} · ${L.clock_sm || "—"} MHz · idle`;
  renderHost(m.host);
  $("#mc-stage .t").textContent = `${c.name} · ${c.smx > 1 ? "1 of " + c.smx + " SMs" : c.sm_word || "SM"} · ${c.cores_per_sm || c.cores} CUDA cores`;
  $("#mc-stage .meta").textContent = `${c.arch} · compute ${c.cc} · ${c.warp_schedulers} warp schedulers · ${c.max_threads_smx} threads resident max`;
  const f = $("#mc-stage-f");
  if (f) f.innerHTML = `<span>GPU <b>${L.util_gpu ?? 0}%</b></span><span>memory ctl <b>${L.util_mem ?? 0}%</b></span><span>SM <b>${L.clock_sm ?? "—"} MHz</b></span><span>mem <b>${L.clock_mem ?? "—"} MHz</b></span><span>temp <b>${L.temp ?? "—"}°C</b></span><span>fan <b>${L.fan ?? "—"}%</b></span><span class="timing">${meas.gflops != null ? fmt.n(meas.gflops, 1) + " GFLOP/s · " + esc(meas.kernel || "") : act.length ? "busy · " + esc(act[0].label) + (act[0].src === "external" ? " (not timed by VectorFall)" : "") : (L.util_gpu || 0) > 10 ? "busy · unnamed process" : "idle — no compute in the last 30 s"}</span>`;
  const memPct = L.mem_total ? L.mem_used / L.mem_total * 100 : 0;
  const bar = (pct, cls = "") => `<div class="hgb ${cls}"><i style="width:${Math.max(0, Math.min(100, pct || 0))}%"></i></div>`;
  const procs = (L.procs || []).map((p) => `<span>${esc(p.name === "[Not Found]" ? "GPU process" : p.name)} <span class="dim">${p.pid}</span></span><b>${p.mem_mb} MB</b>`).join("");
  $("#mach-spec").innerHTML = `
    <div class="sec"><div class="sec-t">Live</div>
      <div class="lv"><span>GPU</span><b>${L.util_gpu ?? 0}%</b>${bar(L.util_gpu)}
        <span>Memory</span><b>${fmt.n(L.mem_used)} / ${fmt.n(L.mem_total)} MB</b>${bar(memPct, "blue")}
        <span>Mem. controller</span><b>${L.util_mem ?? 0}%</b>${bar(L.util_mem, "blue")}
        <span>Temperature</span><b>${L.temp ?? "—"}°C</b>${bar((L.temp || 0) / 95 * 100, "heat")}
        <span>SM clock</span><b>${L.clock_sm ?? "—"} / ${c.sm_clock_mhz} MHz</b>${bar((L.clock_sm || 0) / c.sm_clock_mhz * 100)}
        <span>Fan</span><b>${L.fan ?? "—"}%</b>${bar(L.fan, "blue")}</div></div>
    <div class="sec"><div class="sec-t">Specification</div><div class="kv">
      <span>Architecture</span><b>${c.arch} · cc ${c.cc}</b><span>CUDA cores</span><b>${fmt.n(c.cores)} in ${c.smx} ${c.sm_word || "SM"}</b>
      <span>Warps</span><b>${c.warp_size} threads · ${c.max_warps_smx}/${c.sm_word || "SM"}</b><span>Blocks / ${c.sm_word || "SM"}</span><b>${c.max_blocks_smx}</b>
      <span>Registers / block</span><b>${fmt.n(c.regs_per_block)}</b><span>Shared / L2</span><b>${c.shared_kb} KB / ${c.l2_kb} KB</b>
      <span>Memory</span><b>${c.mem_mb} MB ${c.mem_type} · ${c.mem_bus_bits}-bit</b><span>Bandwidth</span><b>${c.mem_bandwidth_gbs} GB/s peak</b>
      <span>Bus</span><b>PCIe ${c.pcie}</b><span>Board power</span><b>${c.tdp_w} W (no sensor)</b>
      <span>FP32 peak</span><b>${c.fp32_gflops} GFLOP/s</b><span>FP64 peak</span><b>${c.fp64_gflops} GFLOP/s (1/${c.fp64_ratio})</b></div></div>
    <div class="sec"><div class="sec-t">Against the Crays</div><div class="kv">
      <span>Cray-1 (1976)</span><b>${c.cray.cray1_mflops} MFLOP/s</b><span>FP32 here ≈</span><b>${fmt.n(c.cray.fp32_in_cray1s)} Cray-1s</b>
      <span>Cray-2 (1985)</span><b>${c.cray.cray2_gflops} GFLOP/s</b><span>FP64 here ≈</span><b>${esc(String(c.cray.fp64_vs_c90).replace("~=", "≈").replace(/^≈s*/, ""))}</b></div></div>
    <div class="sec"><div class="sec-t">Memory holders</div><div class="kv">${procs || '<span class="dim">nothing resident</span><b></b>'}</div></div>`;
  if (!$("#mach-bres .btbl") || !runs.some((r) => r.kind === "pcie")) renderBench();   // PCIe falls back to the card's last measurement
}

function occupancyUI() {
  const el = $("#mach-occ");
  el.innerHTML = `<div class="fields">
    <div class="fld"><label>Threads / block</label><input type="range" id="oc-t" min="32" max="1024" step="32" value="256"><span class="v" id="oc-tv"></span></div>
    <div class="fld"><label>Registers / thread</label><input type="range" id="oc-r" min="8" max="63" step="1" value="32"><span class="v" id="oc-rv"></span></div>
    <div class="fld"><label>Shared / block</label><input type="range" id="oc-s" min="0" max="48" step="1" value="0"><span class="v" id="oc-sv"></span></div></div>
    <div class="occ" id="oc-out"></div>`;
  let tm = 0;
  const go = () => {
    $("#oc-tv").textContent = $("#oc-t").value; $("#oc-rv").textContent = $("#oc-r").value; $("#oc-sv").textContent = $("#oc-s").value + " KB";
    clearTimeout(tm);
    tm = setTimeout(async () => {
      try {
        const r = await api.get(`/machine/occupancy?threads=${$("#oc-t").value}&regs=${$("#oc-r").value}&shared=${$("#oc-s").value * 1024}`);
        $("#oc-out").innerHTML = `<div class="ocv">${Math.round(r.occupancy * 100)}<small>%</small></div><div class="kv"><span>active blocks</span><b>${r.active_blocks}</b><span>active warps</span><b>${r.active_warps} / ${r.max_warps}</b><span>limited by</span><b>${esc(r.limited_by)}</b></div>`;
      } catch (e) { $("#oc-out").textContent = e.message; }
    }, 120);
  };
  $$("#mach-occ input").forEach((i) => i.oninput = go);
  go();
}

// ---- the living visualization: one SM's lanes (all SMs run alike), the memory ring, PCIe pipes and a heat bloom
function draw(cv) {
  const g = cv.getContext("2d");
  const lanes = [];
  const cols = 16;
  let rows = 12, nl = 192, geom = null;
  function layout(w, h) {
    lanes.length = 0;
    const cd = (machine.last && machine.last.card) || {};
    nl = cd.cores_per_sm || 192; rows = Math.max(1, Math.ceil(nl / cols));
    const gw = Math.min(w * 0.5, 560), gh = Math.min(h * 0.66, gw * 0.75), cx = w * 0.44, cy = h * 0.5;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      lanes.push({ x: cx - gw / 2 + (c + 0.5) * gw / cols, y: cy - gh / 2 + (r + 0.5) * gh / rows, i: r * cols + c, ph: Math.random() * 6 });
    }
    return { cx, cy, gw, gh, s: Math.max(6, Math.min(gw / cols, gh / rows) * 0.62) };
  }
  cv.onmousemove = (e) => { const r = cv.getBoundingClientRect(); hover = { x: e.clientX - r.left, y: e.clientY - r.top }; };
  cv.onmouseleave = () => { hover = null; const t = $("#mach-tip"); if (t) t.style.display = "none"; };
  function frame() {
    if (!cv.isConnected) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) { raf = requestAnimationFrame(frame); return; }
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); geom = null; }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!geom) geom = layout(w, h);
    const m = machine.last; const L = (m && m.live) || {}; const busy = m && m.worker && m.worker.busy;
    const util = Math.max((L.util_gpu || 0) / 100, busy ? 0.6 : 0.03);
    const t = Date.now() / 1000;
    const heat = Math.min(1, Math.max(0, ((L.temp || 40) - 35) / 50));
    const rx = w * 0.86, ry = h * 0.5, rr = Math.min(h * 0.32, w * 0.1, 150);
    const memPct = L.mem_total ? L.mem_used / L.mem_total : 0.03;
    g.beginPath(); g.arc(rx, ry, rr, 0, 7); g.strokeStyle = "rgba(63,169,245,.18)"; g.lineWidth = 9; g.stroke();
    g.beginPath(); g.arc(rx, ry, rr, -Math.PI / 2, -Math.PI / 2 + memPct * Math.PI * 2, false); g.strokeStyle = "#3fa9f5"; g.lineWidth = 9; g.lineCap = "round"; g.stroke(); g.lineCap = "butt";
    g.fillStyle = "#cfe9ff"; g.textAlign = "center"; g.font = "600 20px 'JetBrains Mono', monospace";
    g.fillText(`${Math.round(memPct * 100)}%`, rx, ry + 2); g.font = "600 10px 'Saira Condensed', sans-serif"; g.fillStyle = "#8a8b93"; g.fillText(`MEMORY · ${L.mem_used ?? "—"} MB`, rx, ry + 20);
    for (let p = 0; p < 4; p++) {
      const py = h * (0.3 + p * 0.13);
      g.beginPath(); g.moveTo(0, py); g.lineTo(geom.cx - geom.gw / 2 - 10, geom.cy); g.strokeStyle = "rgba(63,169,245,.1)"; g.lineWidth = 2; g.stroke();
      const flow = (t * (0.3 + util) + p * 0.25) % 1;
      const fx = (geom.cx - geom.gw / 2 - 10) * flow, fy = py + (geom.cy - py) * flow;
      g.beginPath(); g.arc(fx, fy, 2.2, 0, 7); g.fillStyle = `rgba(120,190,255,${0.3 + util * 0.5})`; g.fill();
    }
    let hovered = -1, lit = 0;
    const s = geom.s;
    for (const ln of lanes) {
      const on = busy ? ((ln.i * 37 + Math.floor(t * 20) * 13) % nl) / nl < util : ln.i / nl < util;
      const pulse = 0.5 + 0.5 * Math.sin(t * 3 + ln.ph);
      if (on) {
        lit++;
        const a = 0.55 + 0.45 * pulse;
        g.fillStyle = heat > 0.6 && pulse > 0.7 ? `rgba(255,${150 + 80 * pulse | 0},40,${a})` : `rgba(255,${30 + 20 * pulse | 0},26,${a})`;
        g.shadowColor = "#ff2a1a"; g.shadowBlur = 7 * pulse;
      } else { g.fillStyle = "#18181e"; g.shadowBlur = 0; }
      g.fillRect(ln.x - s / 2, ln.y - s / 2, s, s);
      g.shadowBlur = 0;
      if (hover && Math.abs(hover.x - ln.x) < s / 2 + 2 && Math.abs(hover.y - ln.y) < s / 2 + 2) { hovered = ln.i; g.strokeStyle = "#fff"; g.lineWidth = 1; g.strokeRect(ln.x - s / 2 - 1.5, ln.y - s / 2 - 1.5, s + 3, s + 3); }
    }
    if (heat > 0.5) { const bg = g.createRadialGradient(geom.cx, geom.cy, 0, geom.cx, geom.cy, geom.gw); bg.addColorStop(0, `rgba(255,120,30,${(heat - 0.5) * 0.3})`); bg.addColorStop(1, "transparent"); g.fillStyle = bg; g.fillRect(0, 0, w, h); }
    const tip = $("#mach-tip");
    if (tip) {
      if (hover && hovered >= 0) { tip.style.display = "block"; tip.style.left = Math.min(w - 190, hover.x + 14) + "px"; tip.style.top = (hover.y + 14) + "px";
        tip.innerHTML = `CUDA core ${hovered} of ${nl} in this SM<br><span class="dim">warp ${hovered >> 5} · lane ${hovered & 31}</span>`; }
      else tip.style.display = "none";
    }
    g.font = "600 11px 'Saira Condensed', sans-serif"; g.fillStyle = "#c8c9ce"; g.textAlign = "center"; g.letterSpacing = "2px";
    g.fillText(`${(machine.last && machine.last.card.smx) > 1 ? "1 OF " + machine.last.card.smx + " SMs · " : ""}${nl} CUDA CORES · ${lit} ACTIVE · ${nl / 32} WARPS OF 32`, geom.cx, geom.cy + geom.gh / 2 + 24);
    raf = requestAnimationFrame(frame);
  }
  cancelAnimationFrame(raf); frame();
}
