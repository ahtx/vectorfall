// VectorFall core: API, router, the live machine strip in the top bar, background-job tracking, toasts, icons.
export const $ = (s, e = document) => e.querySelector(s);
export const $$ = (s, e = document) => [...e.querySelectorAll(s)];
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const enc = encodeURIComponent;

export const fmt = {
  n: (v, d = 0) => v == null || Number.isNaN(v) ? "—" : Number(v).toLocaleString([], { maximumFractionDigits: d, minimumFractionDigits: 0 }),
  big(v) {
    if (v == null) return "—";
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(a >= 1e10 ? 0 : 1) + "B";
    if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "M";
    if (a >= 1e4) return (v / 1e3).toFixed(0) + "k";
    return fmt.n(v);
  },
  bytes(b) {
    if (b == null) return "—";
    const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; let v = b;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)) + " " + u[i];
  },
  ms: (v) => v == null ? "—" : v < 1 ? v.toFixed(2) + " ms" : v < 100 ? v.toFixed(1) + " ms" : v < 10000 ? Math.round(v) + " ms" : (v / 1000).toFixed(1) + " s",
  pct: (v, d = 1) => v == null ? "—" : (v * 100).toFixed(d) + "%",
  money: (v) => v == null ? "—" : "$" + Math.round(v).toLocaleString(),
  ago(ts) {
    if (!ts) return "—";
    const d = Date.now() / 1000 - ts;
    if (d < 60) return "just now"; if (d < 3600) return Math.round(d / 60) + " min ago"; if (d < 86400) return Math.round(d / 3600) + " h ago";
    return Math.round(d / 86400) + " d ago";
  },
};

// ---------------------------------------------------------------- API
// Every request has a time limit (o.timeout ms; 0 = none) and can be stopped with o.signal (an AbortSignal). A
// stopped request throws an Error with .cancelled = true; a request over its limit throws a plain "no answer" Error.
// Long work belongs in a job (POST returns {job}, then watchJob), not in one long request.
const T_GET = 45000, T_SEND = 120000;
async function req(method, path, body, raw, o = {}) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers["Content-Type"] = "application/json"; }
  const ctl = new AbortController(), ms = o.timeout != null ? o.timeout : method === "GET" ? T_GET : T_SEND;
  let late = false;
  const timer = ms ? setTimeout(() => { late = true; ctl.abort(); }, ms) : 0;
  if (o.signal) { if (o.signal.aborted) ctl.abort(); else o.signal.addEventListener("abort", () => ctl.abort(), { once: true }); }
  opts.signal = ctl.signal;
  try {
    const r = await fetch("/api" + path, opts);
    if (raw) { if (!r.ok) throw new Error(await r.text()); return r; }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(typeof data.detail === "string" ? data.detail : `${r.status} ${r.statusText}`);
    return data;
  } catch (e) {
    if (ctl.signal.aborted) {
      const err = new Error(late ? `The server did not answer in ${Math.round(ms / 1000)} s. It can be busy with other work: try again.` : "Stopped");
      err.cancelled = !late; err.timeout = late;
      throw err;
    }
    if (e instanceof TypeError) throw new Error("Cannot reach the VectorFall server. Is it running?");
    throw e;
  } finally { clearTimeout(timer); }
}
export const api = {
  get: (p, o) => req("GET", p, undefined, false, o), post: (p, b = {}, o) => req("POST", p, b, false, o),
  put: (p, b = {}, o) => req("PUT", p, b, false, o), del: (p, o) => req("DELETE", p, undefined, false, o),
  raw: (m, p, b, o) => req(m, p, b, true, o),
};

// ---------------------------------------------------------------- toasts
export function toast(msg, kind = "", ms = 3800) {
  const t = document.createElement("div");
  t.className = "toast " + kind; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; setTimeout(() => t.remove(), 320); }, ms);
}
export const fail = (e) => toast(e.message || String(e), "bad", 6000);

// ---------------------------------------------------------------- icons (one 24px line set)
const IC = {
  vlm: '<path d="M4 6h8M4 10h6M4 14h4"/><circle cx="16.5" cy="9" r="2.6"/><path d="M16.5 11.6V15"/><circle cx="16.5" cy="17" r="1.4" fill="currentColor"/>',
  home: '<circle cx="12" cy="12" r="8.5"/><path d="M12 12 18 6"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/>',
  text: '<path d="M4 6h11M4 10h8M4 14h6M4 18h9"/><circle cx="17" cy="15" r="3.4"/><path d="m19.5 17.5 2.5 2.5"/>',
  photo: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3 16 5-5 4 4 3-3 6 6"/><circle cx="16" cy="9" r="1.6"/>',
  sound: '<path d="M3 12h2M7 7v10M11 4v16M15 8v8M19 10v4M21 12h0"/>',
  data: '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="M3.5 9h17M9 9v11.5"/><path d="M12.5 17v-3M15.5 17v-5M18 17v-2"/>',
  forecast: '<path d="M3 20h18"/><path d="M4 16c4-1 6-6 9-7s5 1 7-3"/><path d="M4 16c4 1 6 2 9 1s5-3 7-2" opacity=".55"/><path d="M4 16c4-3 6-10 9-11s5-1 7-3" opacity=".35"/>',
  fractal: '<path d="M12 12c0-2 2-3 3.5-2S17 13 15 14.5 10 15 9 12.5 10 7 13.5 6.5 19.5 8 19.5 12.5 16 19.5 12 19.5 4.5 17 4.5 12 7.5 4.5 12 4.5"/>',
  life: '<rect x="4" y="4" width="4.5" height="4.5" rx="1"/><rect x="9.75" y="9.75" width="4.5" height="4.5" rx="1" fill="currentColor"/><rect x="15.5" y="4" width="4.5" height="4.5" rx="1" fill="currentColor"/><rect x="4" y="15.5" width="4.5" height="4.5" rx="1" fill="currentColor"/><rect x="15.5" y="15.5" width="4.5" height="4.5" rx="1"/>',
  console: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7 10 3 2.5L7 15M12.5 15.5h4.5"/>',
  machine: '<rect x="5.5" y="5.5" width="13" height="13" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor"/><path d="M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3"/>',
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" stroke="none"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  down: '<path d="M12 4v12M7 11l5 5 5-5M5 20h14"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  upload: '<path d="M12 20V8M7 13l5-5 5 5M5 4h14"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  trend: '<path d="M3 20h18"/><path d="M4 16l4-5 3 3 4-6 5 4"/><circle cx="20" cy="12" r="1.3" fill="currentColor"/>',
  orbit: '<circle cx="12" cy="12" r="3.2" fill="currentColor"/><ellipse cx="12" cy="12" rx="9.5" ry="4.2" transform="rotate(-25 12 12)"/><circle cx="19.6" cy="7.6" r="1.6" fill="currentColor"/><circle cx="5.2" cy="15.6" r="1.1" fill="currentColor"/>',
  states: '<circle cx="6" cy="7" r="2.6"/><circle cx="18" cy="7" r="2.6"/><circle cx="12" cy="18" r="2.6"/><path d="M8.6 7h6.8M7.3 9.3l3.4 6.4M16.7 9.3l-3.4 6.4"/>',
  coin: '<path d="M6 4v16M6 8h-2v7h2M12 6v12M12 9h-2v5h2M18 3v15M18 6h-2v8h2"/>',
  piggy: '<ellipse cx="12" cy="13" rx="7.5" ry="5.5"/><path d="M8 18.5V21M16 18.5V21M19.5 12H21M10 9h4"/><circle cx="15.5" cy="11.5" r=".8" fill="currentColor"/>',
  gantt: '<path d="M4 4v16h16"/><path d="M7 7h6M10 11h7M8 15h5"/>',
  walk: '<path d="M3 12c2-3 3 2 5-1s2-6 4-3 2 5 4 2 3-4 5-1"/>',
  reservoir: '<circle cx="12" cy="12" r="1.8" fill="currentColor"/><path d="M15.5 12a3.5 3.5 0 1 1-3.5-3.5"/><path d="M19 12a7 7 0 1 1-7-7"/><path d="M22 12A10 10 0 1 1 12 2" opacity=".45"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  filter: '<path d="M4 5h16l-6 7v6l-4 2v-8z"/>',
  zoomin: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4M8 11h6M11 8v6"/>',
  zoomout: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4M8 11h6"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
};
export const icon = (n, cls = "") => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${IC[n] || ""}</svg>`;

// ---------------------------------------------------------------- router
const VIEWS = {};
let current = null;
export function register(v) { VIEWS[v.id] = v; }
export const views = () => VIEWS;
export const currentView = () => current;
export const routeSubs = new Set();            // the shell listens here (dock state, per-app track)
export function go(id, params = {}) {
  const q = new URLSearchParams(params).toString();
  location.hash = id + (q ? "?" + q : "");
}
export function route() {
  const h = location.hash.slice(1);
  const [id, q] = h.split("?");
  const v = (VIEWS[id] && document.getElementById("view-" + id)) ? VIEWS[id] : VIEWS.home;   // unknown or section-less ids go home
  const params = Object.fromEntries(new URLSearchParams(q || ""));
  if (current && current !== v && current.hide) current.hide();
  $$(".rail a.app").forEach((a) => a.classList.toggle("on", a.dataset.v === v.id));
  $$(".view").forEach((s) => s.classList.toggle("on", s.id === "view-" + v.id));
  $("#view-" + v.id).classList.toggle("scroll", !!v.scroll);
  $("#ttl").textContent = v.title; $("#sub").textContent = v.sub || "";
  const el = $("#view-" + v.id);
  if (!v.mounted) { v.mounted = true; v.mount(el); }
  current = v;
  v.show && v.show(params);
  document.title = v.id === "home" ? "VectorFall" : `${v.title} · VectorFall`;
  routeSubs.forEach((fn) => { try { fn(v, params); } catch (e) { /* shell */ } });
}
window.addEventListener("hashchange", route);
export function shell(order) {
  $("#rail-apps").innerHTML = order.map((id) => id === "|" ? '<div class="sep"></div>' :
    `<a class="app" href="#${id}" data-v="${id}">${icon(VIEWS[id].icon)}<span class="tip">${esc(VIEWS[id].title)}</span></a>`).join("");
  $("#main").innerHTML = order.filter((x) => x !== "|").map((id) => `<section class="view" id="view-${id}"></section>`).join("");
  const cs = $("#corestrip");
  cs.innerHTML = Array.from({ length: 192 }, () => "<i></i>").join("");
}

// ---------------------------------------------------------------- the machine, live (one poll for every view)
export const machine = { last: null, subs: new Set() };
export function onMachine(fn) { machine.subs.add(fn); if (machine.last) fn(machine.last); return () => machine.subs.delete(fn); }
let pulse = 0;
let polling = false;                     // one status request at a time: piled-up polls fill the browser's 6 connections and stall the apps' own requests
async function pollMachine() {
  if (polling) return;
  polling = true;
  try {
    const m = await api.get("/machine");
    machine.last = m;
    const L = m.live || {}, meas = m.measured || {};
    const busy = m.worker && m.worker.busy;
    const util = Math.max((L.util_gpu || 0) / 100, busy ? 0.55 : 0);
    pulse = (pulse + 1) % 1000;
    const cells = $$("#corestrip i"), n = cells.length, lit = Math.round(n * util);
    if (m.card && m.card.cores && !$("#corestrip").title) $("#corestrip").title = `${m.card.name}: ${fmt.n(m.card.cores)} CUDA cores${m.card.cores > n ? " (one mark = " + Math.round(m.card.cores / n) + " cores)" : ""}`;
    cells.forEach((c, i) => c.classList.toggle("on", busy ? ((i * 37 + pulse * 11) % n) < lit : i < lit));
    $("#s-gf").textContent = meas.gflops != null ? fmt.n(meas.gflops, 0) : "—";
    $("#s-mem").textContent = L.mem_used != null ? `${fmt.n(L.mem_used)} MB` : "—";
    $("#s-vbar").style.width = L.mem_total ? (L.mem_used / L.mem_total * 100) + "%" : "0";
    $("#s-temp").textContent = L.temp != null ? L.temp + "°" : "—";
    // the GPU activity pill is always on: what is running, or idle
    // the pill names VectorFall's own work; programs outside VectorFall count only while the card is actually busy
    // (one that only holds memory leaves the card idle; the tooltip lists it)
    const all = m.activity || [], jp = $("#jobpill"), u = L.util_gpu || 0;
    const ext = all.filter((a) => a.src === "external");
    const act = all.filter((a) => a.src !== "external").concat(u >= 10 ? ext : []);
    const first = act[0];
    jp.classList.toggle("idle", !first && u < 10);
    jp.classList.toggle("ext", !!first && first.src === "external");
    const W = m.worker || {}, stuck = !!W.overdue;
    jp.classList.toggle("stuck", stuck);
    $("#gpu-reset").classList.toggle("hot", stuck);
    const starting = W.ready === false, waitq = W.waiting || [];
    jp.classList.toggle("idle", !first && u < 10 && !starting);
    $("#jp-t").textContent = starting ? (W.current || "starting the card") : first ? (stuck && first.src === "worker" ? "stuck: " + first.label : first.src === "external" ? "other program: " + first.label : first.label) : (u >= 10 ? "GPU busy" : "GPU idle");
    $("#jp-el").textContent = (starting || (first && first.src === "worker")) && W.elapsed != null ? clock(W.elapsed) : "";
    $("#jp-more").textContent = waitq.length ? `${waitq.length} waiting` : act.length > 1 ? `+${act.length - 1}` : (!first && ext.length ? `+ ${ext.length} other program${ext.length > 1 ? "s" : ""}` : "");
    const qline = (w) => `• ${w.label} — ${w.lane}, waited ${clock(w.waited)}${w.typical_s != null ? `, usually ${w.typical_s < 1 ? "<1s" : clock(w.typical_s)}` : ""}`;
    jp.title = starting ? "The card is starting (the first CUDA work after a restart). Work you start now waits until it is ready."
      : (act.length ? act.map((a) => "• " + a.label).join("\n") : (u >= 10 ? "The card is busy, but the driver does not name the program" : "Nothing runs on the GPU now"))
        + (W.typical_s != null && first ? `\n(this usually takes ${W.typical_s < 1 ? "under a second" : clock(W.typical_s)})` : "")
        + (waitq.length ? "\n\nWaiting for the card, in the order it will run:\n" + waitq.map(qline).join("\n") : "")
        + (ext.length ? "\n\nOther programs on this card (outside VectorFall):\n" + ext.map((a) => "\u2022 " + a.label + (a.pid ? ` (host process ${a.pid})` : "")).join("\n")
          + (u < 10 ? "\nThey hold memory but do not compute now." : "") : "");
    pillStop(first && first.src === "job" && first.id ? first.id : null);
    $("#jp-p").style.width = first && first.progress != null ? (first.progress * 100) + "%" : first ? "100%" : "0";
    $("#jp-p").parentElement.style.visibility = first ? "visible" : "hidden";
    $("#jp-u").textContent = u + "%";
    noteReset(m);
    const H = m.host;
    if (H) {
      const hc = $("#h-cores");
      if (hc.children.length !== H.n) hc.innerHTML = H.cores.map(() => "<i><b></b></i>").join("");
      H.cores.forEach((c, i) => { const b = hc.children[i].firstChild; b.style.height = Math.max(4, c) + "%"; b.className = c > 85 ? "hot" : c > 60 ? "warm" : ""; });
      $("#h-cpu").innerHTML = `${Math.round(H.cpu)}%<small> · VF ${H.vectorfall_cpu}%</small>`;
      $("#h-mem").textContent = `${(H.mem_used_mb / 1024).toFixed(1)} / ${Math.round(H.mem_total_mb / 1024)} GB`;
      $("#hoststrip").title = `${H.model} · ${H.n} cores · load ${H.load.join(" ")}\nVectorFall itself (server + Console + jobs): ${H.vectorfall_cpu}% of one core`;
    }
    if (m.card) fillCard(m.card);
    machine.subs.forEach((fn) => { try { fn(m); } catch (e) { /* view handles */ } });
  } catch (e) { /* offline */ } finally { polling = false; }
}
setInterval(() => { if (!document.hidden) pollMachine(); }, 1500);
pollMachine();

// Help text says "this card" in places; these spans and tables show the card that the server found.
export function fillCard(c, root = document) {
  const fp = c.fp64_ratio ? `1/${c.fp64_ratio}` : null;
  const v = { name: c.name, cores: c.cores ? fmt.n(c.cores) : null, mem: c.mem_mb ? `${fmt.n(c.mem_mb / 1024, 1)} GB` : null, fp64: fp,
    sms: c.smx ? `${c.smx} ${c.sm_word || "SM"}${c.smx > 1 ? "s" : ""}` : null,
    watchdog: c.watchdog ? "This card drives a display, so this rule applies." : "This card has no display, so the driver does not stop long kernels. Short launches still keep the other apps responsive." };
  root.querySelectorAll("[data-card]").forEach((el) => { const x = v[el.dataset.card]; if (x && el.textContent !== x) el.textContent = x; });
  root.querySelectorAll(".cardfacts:not([data-done])").forEach((el) => {
    el.dataset.done = "1";
    el.innerHTML = `<table class="tbl hg-t"><tr><td>card</td><td>${esc(c.name)}</td></tr>
      <tr><td>architecture</td><td>${esc(c.arch)}, compute capability ${esc(c.cc)}</td></tr>
      <tr><td>cores</td><td>${fmt.n(c.cores)} CUDA cores on ${c.smx} multiprocessors (${esc(c.sm_word || "SM")})</td></tr>
      <tr><td>memory</td><td>${fmt.n(c.mem_mb / 1024, 1)} GB ${esc(c.mem_type || "")}${c.mem_bandwidth_gbs ? `, about ${fmt.n(c.mem_bandwidth_gbs)} GB/s` : ""}</td></tr>
      <tr><td>float32</td><td>about ${fmt.n(c.fp32_gflops)} GFLOP/s peak. float64 is ${fp || "a fraction"} of that on paper.</td></tr>
      <tr><td>watchdog</td><td>${c.watchdog ? "The card drives a display, so one kernel can run for only about 2 s." : "No display: long kernels are allowed."}</td></tr></table>`;
  });
}

// The job pill's Stop button: shown while it names a background job (training, finding, loading, solving).
function pillStop(id) {
  let b = $("#jp-stop");
  if (!b) {
    b = document.createElement("button");
    b.id = "jp-stop"; b.className = "jp-stop"; b.type = "button"; b.title = "Stop this job";
    b.innerHTML = icon("x");
    b.onclick = async (e) => { e.stopPropagation(); const j = b.dataset.job; if (!j) return; b.disabled = true; await cancelJob(j); toast("Stopping the job…"); };
    const pill = $("#jobpill"); if (!pill) return; pill.appendChild(b);
  }
  if (b.dataset.job !== (id || "")) { b.dataset.job = id || ""; b.disabled = false; }
  b.hidden = !id;
}

const clock = (s) => s < 60 ? Math.round(s) + "s" : Math.floor(s / 60) + ":" + String(Math.round(s % 60)).padStart(2, "0");

// ---------------------------------------------------------------- Reset card (terminate everything on the GPU)
const PAGE_T0 = Date.now() / 1000;
let resetting = false;
export async function resetCard() {
  const act = (machine.last && machine.last.activity) || [];
  const what = act.length ? act.map((a) => "\u2022 " + a.label).join("\n") : "nothing is running right now";
  if (!confirm("Reset the card?\n\nThis terminates everything on the GPU and restarts the GPU service (about 20 s):\n" + what)) return;
  resetting = true;
  const ov = document.createElement("div"); ov.className = "reset-ov";
  ov.innerHTML = '<div class="box"><div class="spin"></div><b>Clearing the card\u2026</b><span>terminating GPU work and restarting the service</span></div>';
  document.body.appendChild(ov);
  try { await api.post("/machine/reset", { reason: "Reset card button" }); } catch (e) { /* the server may already be going down */ }
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 2500));
  while (Date.now() - t0 < 120000) {
    try { const r = await fetch("/api/machine", { cache: "no-store" }); if (r.ok) { location.reload(); return; } } catch (e) { /* still restarting */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  ov.querySelector("span").textContent = "still restarting \u2014 reload the page in a moment";
}
document.addEventListener("click", (e) => { if (e.target.closest && e.target.closest("#gpu-reset")) resetCard(); });
let shownReset = 0;
function noteReset(m) {
  const lr = m.last_reset;
  if (!lr || lr.at < PAGE_T0 - 90 || lr.at === shownReset) return;
  shownReset = lr.at;
  if (lr.reason && lr.reason.indexOf("watchdog") === 0) toast("The card was stuck" + (lr.label ? " on \u201c" + lr.label + "\u201d" : "") + " \u2014 it was reset automatically.", "bad", 9000);
}

// ---------------------------------------------------------------- background jobs
// watchJob(job, onStep, { signal }): follow a job to its end. Short jobs are checked often at first (so a 0.3 s job
// shows its result at once), long ones every 0.5 s. When signal aborts, the job is cancelled on the server and
// watchJob throws an Error with .cancelled = true.
export const cancelJob = (id) => api.post(`/jobs/${id}/cancel`).catch(() => null);
export async function watchJob(job, onStep, o = {}) {
  let j = job, n = 0, asked = false;
  const sig = o.signal;
  while (j.state === "running") {
    if (onStep) onStep(j);
    if (sig && sig.aborted && !asked) { asked = true; cancelJob(j.id); }
    await new Promise((r) => setTimeout(r, n < 8 ? 120 : n < 20 ? 250 : 500));
    n++;
    j = await api.get("/jobs/" + j.id);
  }
  if (onStep) onStep(j);
  if (j.state === "cancelled") { const e = new Error("Stopped"); e.cancelled = true; throw e; }
  if (j.state === "error" || j.state === "interrupted") throw new Error(j.error || "job failed");
  return j.result;
}

// ---------------------------------------------------------------- small helpers
// Every slider in the app keeps --p (the red fill) in step with its value: on input, and whenever sliders are
// created or their value is set from code (a MutationObserver plus a light sweep catches programmatic changes).
export function rangeFill(inp) {
  const lo = +inp.min || 0, hi = inp.max === "" ? 100 : +inp.max;
  inp.style.setProperty("--p", (hi > lo ? (inp.value - lo) / (hi - lo) * 100 : 0) + "%");
}
const fillAll = (root = document) => root.querySelectorAll && root.querySelectorAll('input[type="range"]').forEach(rangeFill);
document.addEventListener("input", (e) => { if (e.target.type === "range") rangeFill(e.target); }, true);
document.addEventListener("change", (e) => { if (e.target.type === "range") rangeFill(e.target); }, true);
new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) { if (n.type === "range") rangeFill(n); else fillAll(n); } })
  .observe(document.documentElement, { childList: true, subtree: true });
setInterval(() => { if (!document.hidden) fillAll(); }, 700);

// ---------------------------------------------------------------- workspace building blocks (see css/system.css)
export function pane({ id = "", t = "", meta = "", tools = "", body = "", foot = "", cls = "", bcls = "", bid = "" } = {}) {
  return `<section class="pane ${cls}"${id ? ` id="${id}"` : ""}>
    ${t || tools || meta ? `<div class="pane-h">${t ? `<div class="t">${t}</div>` : ""}<div class="meta">${meta}</div><div class="tools">${tools}</div></div>` : ""}
    <div class="pane-b ${bcls}"${bid ? ` id="${bid}"` : ""}>${body}</div>
    ${foot !== "" ? `<div class="pane-f"${id ? ` id="${id}-f"` : ""}>${foot}</div>` : ""}</section>`;
}
export function busy(el, on = true) { if (el) el.classList.toggle("is-busy", on); }
export function dropZone(el, onFiles, accept) {
  const input = document.createElement("input");
  input.type = "file"; input.multiple = true; if (accept) input.accept = accept; input.hidden = true;
  el.appendChild(input);
  el.addEventListener("click", (e) => { if (e.target === input) return; input.click(); });
  input.onchange = () => { if (input.files.length) onFiles([...input.files]); input.value = ""; };
  el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("over"); });
  el.addEventListener("dragleave", () => el.classList.remove("over"));
  el.addEventListener("drop", (e) => { e.preventDefault(); el.classList.remove("over"); if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]); });
}
export function empty(msg) { return `<div class="empty">${msg}</div>`; }
export function stat(n, l, cls = "") { return `<div class="stat"><div class="n ${cls}">${n}</div><div class="l">${esc(l)}</div></div>`; }

// Ctrl/Cmd-Enter in any text box sends it: the box's own handler first, else the nearest main button.
(() => {
  let synth = false;
  const fire = (el, ctrl) => { synth = true; const ev = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", ctrlKey: ctrl, metaKey: false, bubbles: true, cancelable: true }); el.dispatchEvent(ev); synth = false; return ev.defaultPrevented; };
  const visible = (b) => b.offsetParent !== null && !b.disabled && !b.closest(".seg, .tabs, [hidden]");
  const mainButton = (el) => {
    if (el.dataset.submit) return document.querySelector(el.dataset.submit);
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const c = [...n.querySelectorAll("[data-primary]")].find(visible) || [...n.querySelectorAll(".btn:not(.ghost)")].find(visible);
      if (c) return c;
    }
    return null;
  };
  document.addEventListener("keydown", (e) => {
    if (synth || e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.isComposing) return;
    const el = e.target;
    const box = el.tagName === "TEXTAREA" || el.isContentEditable || (el.tagName === "INPUT" && !/^(checkbox|radio|range|button|submit|file|color)$/.test(el.type));
    if (!box) return;
    e.preventDefault(); e.stopPropagation();
    if (el.onkeydown) { fire(el, true); return; }                  // its own handler (Enter-only handlers run once)
    if (fire(el, true)) return;                                    // a handler that knows Ctrl-Enter
    if (el.tagName === "INPUT" && fire(el, false)) return;         // a handler that sends on Enter
    const b = mainButton(el); if (b) b.click();
  }, true);
})();
