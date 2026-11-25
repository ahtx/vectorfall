import { $, $$, api, esc, fmt, icon, pane } from "./core.js";

// Patterns: live simulations resident on the card, streamed over a websocket (one frame + telemetry per tick).
// Left: the simulations. Centre: the live stage (paint into it where the sim supports it). Right: parameters,
// speed, start/stop, and live telemetry with a history trace. Errors (e.g. out of memory) land in the stage as a
// readable message with a way back, never as a raw exception.
const ICON = { reaction: "spark", life: "life", nbody: "states", mandelbrot: "fractal", ising: "data", montecarlo: "bolt", walks: "walk" };
const PAINT = new Set(["reaction", "life", "ising"]);
// steps per frame that make each one visibly evolve without starving the frame rate (O(N²) n-body: 1)
const ITERS = { reaction: 40, life: 2, nbody: 2, mandelbrot: 1, montecarlo: 1, ising: 4, walks: 6 };
let sims = [], cur = null, params = {}, ws = null, userStop = false, dirty = false, painting = false;
let trace = [], traceLabel = "", frames = 0, lastFrame = null, t0 = 0;

export default {
  id: "life", title: "Patterns", sub: "live simulations on the card", icon: "life",
  mount(el) {
    el.innerHTML = `<div class="ws side-lr lf">
      ${pane({ t: "Simulations", bcls: "flush", bid: "lf-list", foot: "&nbsp;", id: "lf-l" })}
      <section class="pane"><div class="pane-h"><div class="t" id="lf-title">—</div><div class="meta" id="lf-state">idle</div>
        <div class="tools"><button class="iconbtn" id="lf-snap" title="Save this frame as PNG">${icon("down")}</button><button class="iconbtn" id="lf-reset" title="Restart from scratch">${icon("undo")}</button><button class="btn sm" id="lf-play">${icon("play")} Start</button></div></div>
        <div class="pane-b stage lf-stage" id="lf-view"></div>
        <div class="pane-f" id="lf-foot">&nbsp;</div></section>
      <div class="col">
        <section class="pane fit"><div class="pane-h"><div class="t">Parameters</div><div class="tools"><button class="btn ghost xs hidden" id="lf-apply">Restart to apply</button></div></div>
          <div class="pane-b"><div class="hint lf-desc" id="lf-desc"></div><div class="fields" id="lf-params"></div>
            <div class="fields" style="margin-top:10px"><div class="fld"><label for="lf-iters">Steps / frame</label><input type="range" id="lf-iters" min="1" max="40" value="4"><span class="v" id="lf-iv">4</span></div></div></div></section>
        <section class="pane grow"><div class="pane-h"><div class="t">Telemetry</div><div class="meta" id="lf-tl"></div></div>
          <div class="pane-b"><div class="kv lf-kv" id="lf-metrics"></div><div class="lf-trace"><div class="sec-t" id="lf-trl">&nbsp;</div><div class="chartbox"><canvas id="lf-spark"></canvas></div></div></div></section>
      </div>
    </div>`;
    $("#lf-play").onclick = () => (ws ? stop(true) : start());
    $("#lf-reset").onclick = () => { stop(true); start(); };
    $("#lf-apply").onclick = () => { stop(true); start(); };
    $("#lf-snap").onclick = snap;
    $("#lf-iters").oninput = (e) => { $("#lf-iv").textContent = e.target.value; if (ws && ws.readyState === 1) ws.send(JSON.stringify({ iters: +e.target.value })); };
    const view = $("#lf-view");
    const paintAt = (e) => {
      if (!cur || !PAINT.has(cur.id)) return;
      if (!ws) { start(); return; }
      if (ws.readyState !== 1) return;
      const img = view.querySelector("img"); if (!img) return;
      const r = fitRect(img);
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      if (x < 0 || y < 0 || x > 1 || y > 1) return;
      ws.send(JSON.stringify({ paint: { x, y, r: 0.035 } }));
    };
    view.addEventListener("pointerdown", (e) => { if (e.target.closest("button")) return; painting = true; paintAt(e); });
    view.addEventListener("pointermove", (e) => { if (painting) paintAt(e); });
    window.addEventListener("pointerup", () => { painting = false; });
    window.addEventListener("resize", () => { if (document.querySelector("#view-life.on")) drawTrace(); });
    load();
  },
  show() { requestAnimationFrame(drawTrace); },
  hide() { stop(true); },
};

// the image is object-fit: contain — map pointer coordinates onto the drawn square, not the element box
function fitRect(img) {
  const b = img.getBoundingClientRect(), iw = img.naturalWidth || 1, ih = img.naturalHeight || 1;
  const s = Math.min(b.width / iw, b.height / ih), w = iw * s, h = ih * s;
  return { left: b.left + (b.width - w) / 2, top: b.top + (b.height - h) / 2, width: w, height: h };
}

async function load() {
  try { sims = await api.get("/sims"); } catch (e) { $("#lf-list").innerHTML = `<div class="hint" style="padding:12px">${esc(e.message)}</div>`; return; }
  $("#lf-list").innerHTML = `<div class="list">${sims.map((s) => `<div class="li" data-s="${s.id}" title="${esc(s.desc)}"><div class="ic">${icon(ICON[s.id] || "life")}</div>
    <div class="tx"><div class="nm">${esc(s.name)}</div><div class="sub">${esc(s.flops_hint || "")}${PAINT.has(s.id) ? " · paintable" : ""}</div></div></div>`).join("")}</div>`;
  $("#lf-l-f").innerHTML = `<span>${sims.length} simulations</span><span>one runs at a time</span>`;
  $$("#lf-list [data-s]").forEach((b) => b.onclick = () => pick(b.dataset.s));
  pick(sims[0].id);
}

function pick(id) {
  stop(true);
  cur = sims.find((s) => s.id === id);
  $$("#lf-list [data-s]").forEach((b) => b.classList.toggle("on", b.dataset.s === id));
  $("#lf-title").textContent = cur.name;
  $("#lf-desc").textContent = cur.desc;
  const it = ITERS[id] || 4; $("#lf-iters").value = it; $("#lf-iv").textContent = it;
  params = {};
  $("#lf-params").innerHTML = cur.params.map((p) => {
    params[p.k] = p.default;
    if (p.type === "choice") return `<div class="fld two"><label>${esc(p.label)}</label><select class="sel sm" data-p="${p.k}">${p.choices.map((c) => `<option ${c === p.default ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div>`;
    const step = p.type === "int" ? Math.max(1, Math.round((p.max - p.min) / 200)) : (p.max - p.min) / 200;
    return `<div class="fld"><label>${esc(p.label)}</label><input type="range" data-p="${p.k}" data-t="${p.type}" min="${p.min}" max="${p.max}" step="${step}" value="${p.default}"><span class="v" id="lv-${p.k}">${pval(p.default, p.type)}</span></div>`;
  }).join("");
  $$("#lf-params [data-p]").forEach((i) => i.oninput = () => {
    params[i.dataset.p] = i.type === "range" ? +i.value : i.value;
    const v = $("#lv-" + i.dataset.p); if (v) v.textContent = pval(+i.value, i.dataset.t);
    if (ws) { dirty = true; $("#lf-apply").classList.remove("hidden"); }
  });
  $$("#lf-params select[data-p]").forEach((i) => i.onchange = i.oninput);
  idle(`<b>${esc(cur.name)}</b><span>${PAINT.has(cur.id) ? "Press Start, or paint into the stage." : "Press Start to run it on the card."}</span>`);
  $("#lf-metrics").innerHTML = ""; $("#lf-tl").textContent = ""; trace = []; drawTrace();
  $("#lf-foot").innerHTML = PAINT.has(cur.id) ? `<span>click and drag on the stage to seed it</span>` : `<span>${esc(cur.flops_hint || "")}</span>`;
  setTimeout(() => { if (cur && cur.id === id && !ws) start(); }, 300);     // pick = run: something moves at once
}
function pval(v, t) { if (t === "int") return v >= 1e6 ? fmt.big(v) : fmt.n(v); const a = Math.abs(v); return a && a < 0.1 ? (+v).toFixed(4) : (+v).toFixed(2); }

function idle(html, cls = "") { $("#lf-view").innerHTML = `<div class="lf-msg ${cls}">${html}</div>`; }

function start() {
  if (!cur) return;
  stop(true);
  userStop = false; dirty = false; $("#lf-apply").classList.add("hidden");
  trace = []; frames = 0; lastFrame = null; t0 = performance.now();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const sock = new WebSocket(`${proto}://${location.host}/api/sim/${cur.id}`);
  ws = sock;
  setRunning(true, "starting…");
  idle(`<span>The card prepares ${esc(cur.name)}…</span>`, "busy");
  sock.onopen = () => sock.send(JSON.stringify({ params, iters: +$("#lf-iters").value }));
  sock.onmessage = (e) => {
    if (sock !== ws) return;
    let m; try { m = JSON.parse(e.data); } catch (x) { return; }
    if (m.error) { fail(m.error); return; }
    frame(m);
  };
  sock.onerror = () => { if (sock === ws && !userStop) fail("Lost the connection to the card."); };
  sock.onclose = () => {
    if (sock !== ws) return;
    ws = null;
    if (!userStop && frames === 0 && !$("#lf-view .lf-msg.err")) fail("The simulation stopped before its first frame.");
    setRunning(false);
  };
}
function stop(user) {
  userStop = !!user;
  const s = ws; ws = null;
  if (s) { try { if (s.readyState === 1) s.send(JSON.stringify({ stop: true })); } catch (e) { /* closing */ } try { s.close(); } catch (e) { /* closed */ } }
  setRunning(false);
}
function fail(text) {
  const s = ws; ws = null; userStop = true;
  if (s) { try { s.close(); } catch (e) { /* closed */ } }
  setRunning(false, "stopped");
  const oom = /memory|too big/i.test(text);
  idle(`${icon("x")}<b>${oom ? "Too big for the card" : "Simulation stopped"}</b><span>${esc(text)}</span>
    ${oom ? `<span class="hint">Lower the size or count on the right and start again.</span>` : ""}<button class="btn sm" id="lf-retry">${icon("play")} Try again</button>`, "err");
  const r = $("#lf-retry"); if (r) r.onclick = start;
}
function setRunning(on, label) {
  const b = $("#lf-play"); if (!b) return;
  b.innerHTML = on ? `${icon("stop")} Stop` : `${icon("play")} Start`;
  b.classList.toggle("ghost", on);
  $("#lf-state").textContent = label || (on ? "running" : (frames ? "paused" : "idle"));
  $("#lf-state").classList.toggle("live", on);
}

function frame(m) {
  frames++;
  const view = $("#lf-view");
  let img = view.querySelector("img");
  if (!img) { view.innerHTML = ""; img = document.createElement("img"); img.draggable = false; img.alt = ""; view.appendChild(img); if (PAINT.has(cur.id)) view.classList.add("paint"); else view.classList.remove("paint"); }
  img.src = m.frame; lastFrame = m.frame;
  const fps = frames / Math.max(0.001, (performance.now() - t0) / 1000);
  $("#lf-state").textContent = `running · ${fmt.n(m.gflops, 1)} GFLOP/s`;
  const met = m.metrics || {}, tel = m.telemetry || {};
  const rows = [["GFLOP/s", fmt.n(m.gflops, 1)], ["steps / s", fmt.big(m.iters_per_s)], ["ms / step", fmt.n(m.step_ms, 2)], ["frames / s", fmt.n(fps, 1)]];
  Object.entries(met).filter(([k]) => k !== "history").forEach(([k, v]) => rows.push([k.replace(/_/g, " "), typeof v === "number" ? (Math.abs(v) >= 1e4 ? fmt.big(v) : fmt.n(v, Math.abs(v) < 1 ? 4 : 2)) : String(v)]));
  if (tel.temp != null) rows.push(["GPU temp", tel.temp + "°C"]);
  if (tel.util_gpu != null) rows.push(["GPU busy", tel.util_gpu + "%"]);
  if (tel.mem_used != null) rows.push(["card memory", `${fmt.n(tel.mem_used)} MB`]);
  $("#lf-metrics").innerHTML = rows.map(([k, v]) => `<span>${esc(k)}</span><b>${esc(v)}</b>`).join("");
  $("#lf-tl").textContent = `frame ${fmt.n(frames)}`;
  // trace: the sim's own history if it has one (π estimate), the walk spread vs theory, else achieved GFLOP/s
  if (Array.isArray(met.history)) { trace = met.history.slice(); traceLabel = "π estimate (target dashed)"; }
  else if (met.rms_distance != null) { trace.push([met.rms_distance, met.expected]); trace = trace.slice(-240); traceLabel = "rms distance vs √(2·D·t) theory"; }
  else { trace.push(m.gflops); trace = trace.slice(-240); traceLabel = "GFLOP/s achieved"; }
  $("#lf-foot").innerHTML = `${PAINT.has(cur.id) ? "<span>drag to paint</span>" : ""}<span>step <b>${fmt.n(met.steps ?? met.frame ?? frames)}</b></span><span>${fmt.n(m.step_ms, 1)} ms/step</span><span class="timing">${fmt.n(m.gflops, 1)} GFLOP/s</span>`;
  drawTrace();
}

function drawTrace() {
  const cv = $("#lf-spark"); if (!cv) return;
  $("#lf-trl").textContent = trace.length ? traceLabel : " ";
  const box = cv.parentElement, dpr = window.devicePixelRatio || 1, W = box.clientWidth, H = box.clientHeight;
  if (!W || !H) return;
  cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + "px";
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  if (trace.length < 2) return;
  const pair = Array.isArray(trace[0]);
  const a = pair ? trace.map((p) => p[0]) : trace, b = pair ? trace.map((p) => p[1]) : null;
  let lo = Math.min(...a, ...(b || [])), hi = Math.max(...a, ...(b || []));
  if (traceLabel.startsWith("π")) { lo = Math.min(lo, Math.PI); hi = Math.max(hi, Math.PI); }
  const r = hi - lo || Math.abs(hi) * 0.1 || 1; lo -= r * 0.08; hi += r * 0.08;
  const L = 44, X = (i) => L + i / (a.length - 1) * (W - L - 6), Y = (v) => H - 14 - (v - lo) / (hi - lo) * (H - 22);
  g.strokeStyle = "rgba(255,255,255,.06)"; g.fillStyle = "#8a8b93"; g.font = "10px 'JetBrains Mono', monospace"; g.textAlign = "right";
  for (let k = 0; k <= 3; k++) { const v = lo + (hi - lo) * k / 3, y = Y(v); g.beginPath(); g.moveTo(L, y); g.lineTo(W - 6, y); g.stroke(); g.fillText(Math.abs(v) >= 100 ? v.toFixed(0) : v.toPrecision(3), L - 5, y + 3); }
  const line = (arr, col, dash) => { g.strokeStyle = col; g.lineWidth = 1.5; g.setLineDash(dash || []); g.beginPath(); arr.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)))); g.stroke(); g.setLineDash([]); };
  if (traceLabel.startsWith("π")) { g.strokeStyle = "rgba(255,211,0,.6)"; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(L, Y(Math.PI)); g.lineTo(W - 6, Y(Math.PI)); g.stroke(); g.setLineDash([]); }
  if (b) line(b, "rgba(63,169,245,.8)", [4, 3]);
  line(a, "#ff2a1a");
}

function snap() {
  if (!lastFrame) return;
  const a = document.createElement("a"); a.href = lastFrame; a.download = `vectorfall-${cur ? cur.id : "pattern"}.png`; a.click();
}
