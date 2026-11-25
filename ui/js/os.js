// VectorFall's shell: two layouts of the same system, switchable at any time, and one command language for both.
//
//   Application mode   the rail on the left (or a dock at the bottom), one app at a time — as it always was.
//   Desktop mode       after Wirth's Oberon (1990): the screen is TILED, never overlapped. A wide user track holds the
//                      app; a narrow system track holds viewers stacked top to bottom — Log, Tool, Machine, Recent.
//                      Every viewer has a title bar of commands; drag a title bar to move the boundary above it.
//
// Commands are text, as in Oberon: "Module.Command arguments". In a Tool any such word runs on click (the rest of
// the line, up to the next command or a ~, is its argument; ^ stands for the text you last selected anywhere).
// The command bar (Ctrl-K) is the same interpreter with suggestions. Nothing here is decoration: the Log is the
// server's own record of every run on the card and every background job, the Machine viewer is the live poll.
import { $, $$, api, esc, fmt, go, route, views, currentView, routeSubs, onMachine, machine, resetCard, toast } from "./core.js";
import { menu, PROBLEMS } from "./hub.js";

// ---------------------------------------------------------------- preferences (per browser; never essential)
const KEY = "vf.shell";
const DEF = { mode: "app", dockApp: "left", dockDesk: "bottom", track: 330, grown: { fractal: 1, life: 1, console: 1, machine: 1 },
  viewers: [{ id: "log", h: 0.42 }, { id: "tool", h: 0.36 }, { id: "machine", h: 0.22 }], vgrow: null, logGpu: true };
let P = DEF;
try { P = Object.assign({}, DEF, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch (e) { P = Object.assign({}, DEF); }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(P)); } catch (e) { /* private window: fine */ } };
const desk = () => P.mode === "desk";
const dock = () => desk() ? P.dockDesk : P.dockApp;

const SVG = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const IC = {
  search: SVG('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>'),
  layout: SVG('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M15 4v16M15 10h6M15 15h6"/>'),
  app: SVG('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M8 4v16"/>'),
  dock: SVG('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 16.5h10"/>'),
  grow: SVG('<path d="M4 9V4h5M20 15v5h-5M4 4l6 6M20 20l-6-6"/>'),
  cmd: SVG('<path d="m5 8 4 4-4 4M11 16h8"/>'),
};

// ---------------------------------------------------------------- layout
function apply() {
  const b = document.body;
  b.dataset.mode = P.mode; b.dataset.dock = dock();
  const v = currentView();
  const open = desk() && !(v && P.grown[v.id]) && window.innerWidth >= 1280;
  b.classList.toggle("track-on", open);
  document.documentElement.style.setProperty("--track", open ? P.track + "px" : "0px");
  const st = $("#systrack");
  if (st) { st.hidden = !open; if (open) layoutTrack(); }
  syncDock();
  const sig = [P.mode, dock(), open ? P.track : 0].join();
  if (sig !== lastSig) { lastSig = sig; window.dispatchEvent(new Event("resize")); }   // canvases and charts re-measure
}
let lastSig = "";
function setMode(m) { P.mode = m === "desk" || m === "desktop" ? "desk" : "app"; save(); apply(); log("client", `Layout: ${desk() ? "desktop (tiled tracks)" : "application"}`); }
function setDock(d) { const k = desk() ? "dockDesk" : "dockApp"; P[k] = d === "bottom" ? "bottom" : "left"; save(); apply(); }
function toggleGrow(id = currentView() && currentView().id, on) {
  if (!id) return;
  const g = on == null ? !P.grown[id] : on;
  if (g) P.grown[id] = 1; else delete P.grown[id];
  save(); apply();
}

// ---------------------------------------------------------------- the rail / dock: which apps are running, which are working
const KIND_APP = { text: "text", photo: "photo", sound: "sound", plan: "plan", reservoir: "reservoir", data: "data", simulate: "simulate", fractal: "fractal", life: "life", machine: "machine", console: "console" };
function syncDock(m = machine.last) {
  const V = views(), busy = {};
  ((m && m.jobs) || []).forEach((j) => { const a = KIND_APP[j.kind]; if (a) busy[a] = Math.max(busy[a] || 0, j.progress || 0.02); });
  $$(".rail a.app").forEach((a) => {
    const id = a.dataset.v;
    a.classList.toggle("run", !!(V[id] && V[id].mounted));
    let jr = a.querySelector(".jr");
    if (busy[id] != null) {
      if (!jr) { jr = document.createElement("i"); jr.className = "jr"; jr.innerHTML = "<b></b>"; a.appendChild(jr); }
      jr.firstChild.style.width = Math.round(busy[id] * 100) + "%";
    } else if (jr) jr.remove();
  });
}
function buildRailExtras() {
  const rail = $(".rail");
  if (!rail || $("#rail-x")) return;
  const x = document.createElement("div");
  x.id = "rail-x"; x.className = "rail-x";
  x.innerHTML = `<button class="rx" id="rx-cmd" title="Command bar (Ctrl K) — every app, table and command">${IC.search}<span class="tip">Command bar · Ctrl K</span></button>
    <button class="rx" id="rx-lay" title="Layout">${IC.layout}<span class="tip">Layout</span></button>`;
  rail.insertBefore(x, rail.querySelector(".foot"));
  $("#rx-cmd").onclick = () => cmdbar();
  $("#rx-lay").onclick = (e) => layoutMenu(e.currentTarget);
}
function layoutMenu(anchor) {
  const v = currentView(), on = (b) => b ? "✓ " : "";
  const items = [
    { icon: "home", label: on(!desk()) + "Application mode", sub: "one app at a time — the classic layout", run: () => setMode("app") },
    { icon: "data", label: on(desk()) + "Desktop mode", sub: "tiled like Oberon: the app plus a system track of Log, Tool and Machine", run: () => setMode("desk") },
    "-",
    { icon: "console", label: on(dock() === "left") + "Rail on the left", sub: desk() ? "for desktop mode" : "for application mode", run: () => setDock("left") },
    { icon: "console", label: on(dock() === "bottom") + "Dock at the bottom", sub: desk() ? "for desktop mode" : "for application mode", run: () => setDock("bottom") },
  ];
  if (desk()) {
    items.push("-", { icon: "fit", label: on(v && P.grown[v.id]) + `Full width for ${v ? v.title : "this app"}`, sub: "hide the system track while this app is open (System.Grow)", run: () => toggleGrow() });
    Object.entries(VIEWERS).forEach(([id, d]) => items.push({ icon: d.icon, label: on(P.viewers.some((x) => x.id === id)) + d.name, sub: d.sub, run: () => toggleViewer(id) }));
  }
  items.push("-", { icon: "bolt", label: "Command bar", sub: "Ctrl K · apps, tables, commands, problems", run: () => cmdbar() });
  menu(anchor, items);
}

// ---------------------------------------------------------------- the ^ parameter: the text last selected anywhere
let SEL = "";
document.addEventListener("selectionchange", () => {
  const a = document.activeElement;
  let t = "";
  if (a && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && a.type === "text")) && a.selectionEnd > a.selectionStart && !a.closest("#vf-cmdbar")) t = a.value.slice(a.selectionStart, a.selectionEnd);
  else { const s = window.getSelection(); t = s ? s.toString() : ""; }
  t = t.trim();
  if (t && !(a && a.id === "sv-tool-ed")) { SEL = t.slice(0, 4000); const m = $("#sv-tool-sel"); if (m) showSel(); }
});
function showSel() {
  const m = $("#sv-tool-sel");
  if (!m) return;
  m.innerHTML = SEL ? `^ = “${esc(SEL.length > 34 ? SEL.slice(0, 34) + "…" : SEL)}” <button class="lnk" id="sv-sel-x" title="Forget the selection">×</button>` : "^ = nothing selected";
  const x = $("#sv-sel-x"); if (x) x.onclick = () => { SEL = ""; showSel(); };
}

// ---------------------------------------------------------------- commands
let TABLES = null;
async function tables(force) { if (!TABLES || force) { try { TABLES = await api.get("/tables"); } catch (e) { TABLES = []; } } return TABLES; }
async function table(q) {
  const ts = await tables(true);
  if (!q) { if (!ts.length) throw new Error("There are no tables in the Data Desk yet"); return ts[0]; }
  const s = q.toLowerCase();
  const t = ts.find((t) => t.id === q) || ts.find((t) => t.name.toLowerCase() === s) || ts.find((t) => t.name.toLowerCase().includes(s));
  if (!t) throw new Error(`No table matches “${q}” — tables: ${ts.slice(0, 6).map((t) => t.name).join(", ") || "none"}`);
  return t;
}
const bestCol = (t, want) => { const n = t.numeric || []; if (want) { const c = n.find((c) => c.toLowerCase() === want.toLowerCase()) || n.find((c) => c.toLowerCase().includes(want.toLowerCase())); if (c) return c; } return n.find((c) => /close|value|total|amount/i.test(c)) || n[0]; };
function appId(q) {
  const V = views(), s = (q || "").toLowerCase().trim();
  if (!s) throw new Error("Which app? For example: System.Open data");
  const id = V[s] ? s : Object.keys(V).find((k) => V[k].title.toLowerCase() === s) || Object.keys(V).find((k) => V[k].title.toLowerCase().includes(s) || k.startsWith(s));
  if (!id) throw new Error(`No app called “${q}” — apps: ${Object.keys(V).join(", ")}`);
  return id;
}
function nav(id, params = {}) {
  const q = new URLSearchParams(params).toString(), h = "#" + id + (q ? "?" + q : "");
  if (location.hash === h) route(); else go(id, params);
}
const need = (a, what) => { if (!a) throw new Error(`Give it ${what}`); return a; };

export const CMDS = {
  "System.Open": { sig: "app", d: "Open an app by name", run: (a) => nav(appId(a)) },
  "System.Mode": { sig: "application | desktop", d: "Switch the layout", run: (a) => setMode(/desk/i.test(a) ? "desk" : /app/i.test(a) ? "app" : desk() ? "app" : "desk") },
  "System.Dock": { sig: "left | bottom", d: "Put the app rail on the left or at the bottom", run: (a) => setDock(/bot/i.test(a) ? "bottom" : /left/i.test(a) ? "left" : dock() === "left" ? "bottom" : "left") },
  "System.Grow": { sig: "", d: "Desktop: give the current app the full width (again to restore the system track)", run: () => { if (!desk()) setMode("desk"); toggleGrow(); } },
  "System.Viewer": { sig: "log | tool | machine | recent", d: "Desktop: show or hide a viewer in the system track", run: (a) => { const id = Object.keys(VIEWERS).find((k) => k.startsWith((a || "").toLowerCase().trim())); need(id, "a viewer: log, tool, machine or recent"); if (!desk()) setMode("desk"); toggleViewer(id, true); } },
  "System.Commands": { sig: "", d: "List every command (opens the command bar)", run: () => cmdbar("") },
  "System.Reset": { sig: "", d: "Reset the card: stop everything on the GPU (asks first)", run: () => resetCard() },
  "Data.Open": { sig: "table", d: "Open a Data Desk table (part of its name is enough)", run: async (a) => { const t = await table(a); nav("data", { table: t.id }); return t.name; } },
  "Data.Ticker": { sig: "SYMBOL [years]", d: "Download daily prices into a new table", run: async (a) => {
    const [sym, yrs] = need(a, "a ticker symbol, for example Data.Ticker SPY 5").split(/\s+/);
    log("client", `Fetching ${sym.toUpperCase()}…`);
    const m = await api.post("/tables/ticker", { ticker: sym, years: +yrs || 5 }); TABLES = null;
    nav("data", { table: m.id }); return `${m.name}: ${fmt.n(m.rows)} days`;
  } },
  "Data.Watch": { sig: "table", d: "Anomaly watch on a table — flag the moments that break the pattern", run: async (a) => { const t = await table(a); nav("data", { table: t.id, tab: "watch" }); return t.name; } },
  "Photo.Search": { sig: "words", d: "Find photos by what is in them (CLIP)", run: (a) => nav("photo", { panel: "search", q: need(a, "words, e.g. Photo.Search a dog") }) },
  "Text.Trace": { sig: "text", d: "Trace text to the exact documents it came from", run: (a) => nav("text", { tab: "sources", trace: need(a, "text — select some and use ^") }) },
  "Text.Continue": { sig: "words", d: "Continue words from the longest exact match in the corpus", run: (a) => nav("text", { tab: "sources", cont: need(a, "a few words to start from") }) },
  "Sound.Find": { sig: "", d: "Mark a sound once or twice, find every other time it happens", run: () => nav("sound", { panel: "find" }) },
  "Plan.Roster": { sig: "", d: "Planner: a roster from people, shifts and rules", run: () => nav("plan", { kind: "roster" }) },
  "Plan.Route": { sig: "", d: "Planner: the shortest round trip through your stops", run: () => nav("plan", { kind: "route" }) },
  "Plan.Teams": { sig: "", d: "Planner: fair teams from scores and pairings", run: () => nav("plan", { kind: "teams" }) },
  "Sim.Budget": { sig: "", d: "Odds of going over budget, from low / likely / high estimates", run: () => nav("simulate", { engine: "budget" }) },
  "Sim.History": { sig: "table [column]", d: "Odds of a total next period, bootstrapped from a table's history", run: async (a) => { const [n, c] = splitLast(a); const t = await table(n); nav("simulate", { engine: "history", table: t.id, col: bestCol(t, c) }); return t.name; } },
  "Model.Run": { sig: "model [--param value …]", d: "Open any registered model (155 of them) with parameters filled in", run: (a) => {
    const [name, ...rest] = need(a, "a model name, e.g. Model.Run sim.budget --budget 200000").split(/\s+/);
    const pre = {}; for (let i = 0; i < rest.length; i++) if (rest[i].startsWith("--")) { pre["p_" + rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : "true"; }
    nav("models", Object.assign({ m: name }, pre));
  } },
  "Reservoir.Forecast": { sig: "table [column]", d: "Up or down next? A forecaster scored on data it never saw", run: async (a) => { const [n, c] = splitLast(a); const t = await table(n); nav("reservoir", { forecast: t.id, col: bestCol(t, c) }); return t.name; } },
};
// "Sim.History SPY close" → table "SPY", column "close"; a single word is the table
function splitLast(a) { const w = (a || "").trim().split(/\s+/); return w.length > 1 && !/\d{4}/.test(w[w.length - 1]) ? [w.slice(0, -1).join(" "), w[w.length - 1]] : [a, ""]; }

export async function run(name, args = "") {
  const c = CMDS[name];
  const a = (args || "").replace(/(^|\s)\^(?=\s|$)/g, (m, s) => s + SEL).trim();
  log("cmd", name + (a ? " " + (a.length > 60 ? a.slice(0, 60) + "…" : a) : ""));
  if (!c) { log("err", `${name}: no such command (System.Commands lists them)`); return; }
  try { const r = await c.run(a); if (typeof r === "string") log("client", r); }
  catch (e) { log("err", `${name}: ${e.message || e}`); toast(e.message || String(e), "bad", 5000); }
}
const CMD_RE = /\b([A-Z][a-z]+\.[A-Z][A-Za-z]+)\b/g;

// ---------------------------------------------------------------- the Log: server record + this browser's commands
// The filter bar: words, kind, app, order; "Kept" adds the server's kept history (older runs, earlier sessions).
const LOG = { client: [], gpu: [], jobs: [], seq: 0, boot: null, reset: null, clearedAt: 0, q: "", kind: "", app: "", order: "oldest", kept: null, keptInfo: null };
function log(kind, text) {
  LOG.client.push({ t: Date.now() / 1000, kind, text });
  if (LOG.client.length > 300) LOG.client.splice(0, 100);
  if (kind === "cmd" || kind === "err") api.post("/system/note", { kind, text }).catch(() => {});      // kept on the server too
  renderLog();
}
let keptT = 0;
async function pullKept() {
  clearTimeout(keptT);
  keptT = setTimeout(async () => {
    try {
      const r = await api.get("/system/history?" + new URLSearchParams({ q: LOG.q, kind: LOG.kind, app: LOG.app, order: "newest", limit: 1000 }));
      LOG.kept = r.rows; LOG.keptInfo = r; renderLog();
    } catch (e) { /* offline */ }
  }, 200);
}
function logBar() {
  const apps = [...new Set(Object.values(KIND_APP))];
  return `<div class="lg-bar"><input class="lg-q" id="lg-q" placeholder="Search the log…" value="${esc(LOG.q)}" spellcheck="false">
    <select id="lg-kind" title="Kind">${[["", "all kinds"], ["card", "card runs"], ["job", "jobs"], ["err", "errors"], ["cmd", "commands"], ["client", "notes"]].map(([v, l]) => `<option value="${v}" ${LOG.kind === v ? "selected" : ""}>${l}</option>`).join("")}</select>
    <select id="lg-app" title="App">${["", ...apps].map((a) => `<option value="${a}" ${LOG.app === a ? "selected" : ""}>${a ? (views()[a] ? views()[a].title : a) : "all apps"}</option>`).join("")}</select>
    <button class="vc" id="lg-ord" title="Sort by time">${LOG.order === "oldest" ? "Oldest first" : "Newest first"}</button>
    <button class="vc ${LOG.kept ? "on" : ""}" id="lg-kept" title="Add the history the server keeps (earlier sessions, before restarts)">Kept</button></div><div class="lg-rows" id="lg-rows"></div>`;
}
function wireLogBar() {
  const q = $("#lg-q"); if (!q) return;
  let t = 0;
  q.oninput = () => { clearTimeout(t); t = setTimeout(() => { LOG.q = q.value.trim(); renderLog(); if (LOG.kept) pullKept(); }, 150); };
  $("#lg-kind").onchange = (e) => { LOG.kind = e.target.value; renderLog(); if (LOG.kept) pullKept(); };
  $("#lg-app").onchange = (e) => { LOG.app = e.target.value; renderLog(); if (LOG.kept) pullKept(); };
  $("#lg-ord").onclick = (e) => { LOG.order = LOG.order === "oldest" ? "newest" : "oldest"; e.target.textContent = LOG.order === "oldest" ? "Oldest first" : "Newest first"; renderLog(true); };
  $("#lg-kept").onclick = (e) => { if (LOG.kept) { LOG.kept = null; LOG.keptInfo = null; e.target.classList.remove("on"); renderLog(); } else { e.target.classList.add("on"); LOG.kept = []; pullKept(); } };
}
async function pullLog() {
  try {
    const r = await api.get("/system/log?since=" + LOG.seq);
    if (r.seq < LOG.seq) LOG.gpu = [];                  // the server restarted
    const by = new Map(LOG.gpu.map((e) => [e.at, e]));
    r.gpu.forEach((e) => by.set(e.at, e));
    LOG.gpu = [...by.values()].sort((a, b) => a.at - b.at).slice(-300);
    LOG.seq = r.seq; LOG.jobs = r.jobs; LOG.boot = r.boot; LOG.reset = r.last_reset;
    renderLog();
  } catch (e) { /* offline */ }
}
const hms = (t) => { const d = new Date(t * 1000), now = new Date(); const s = d.toLocaleTimeString([], { hour12: false }); return d.toDateString() === now.toDateString() ? s : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + s; };
function renderLog(jump) {
  const sv = $("#sv-log-b");
  if (!sv) return;
  if (!$("#lg-rows", sv)) { sv.innerHTML = logBar(); wireLogBar(); }
  const b = $("#lg-rows", sv);
  const rows = [];
  if (LOG.boot) rows.push({ t: LOG.boot, c: "sys", h: `Server started` });
  if (LOG.reset && LOG.reset.at) rows.push({ t: LOG.reset.at, c: "err", h: `Card reset — ${esc(LOG.reset.reason || "")}${LOG.reset.label ? ` (was running “${esc(LOG.reset.label)}”)` : ""}` });
  if (P.logGpu) LOG.gpu.forEach((e) => rows.push({ t: e.at, c: e.err ? "err" : "gpu", h: `<span class="k">card</span> ${esc(e.label || "unnamed")}${e.n > 1 ? ` <span class="dim">×${e.n}</span>` : ""}${e.err ? ` — ${esc(e.err)}` : ""}`, r: fmt.ms(e.ms) }));
  LOG.jobs.forEach((j) => rows.push({ t: j.started, c: j.state === "error" ? "err" : j.state === "running" ? "run" : "job", app: KIND_APP[j.kind],
    h: `<span class="k">${esc(j.kind)}</span> ${esc(j.label)}${j.state === "error" ? ` — ${esc(j.error || "failed")}` : j.state === "running" ? ` <span class="dim">${esc(j.message || "")}</span>` : ""}`,
    r: j.state === "running" ? Math.round(j.progress * 100) + "%" : (j.state === "error" ? "failed " : "") + fmt.ms(j.elapsed * 1000) }));
  LOG.client.forEach((e) => rows.push({ t: e.t, c: e.kind, h: e.kind === "cmd" ? `› ${esc(e.text)}` : esc(e.text) }));
  rows.forEach((r) => { r.kind = r.c === "gpu" ? "card" : r.c === "run" ? "job" : r.c; r.txt = r.h.replace(/<[^>]+>/g, " ").toLowerCase(); });
  if (LOG.kept) {                                         // the server's kept lines that are not on the screen already
    const have = new Set(rows.map((r) => Math.round(r.t)));
    LOG.kept.forEach((k) => { if (have.has(Math.round(k.t))) return; rows.push({ t: k.t, c: k.kind === "card" ? "gpu" : k.kind, kind: k.kind, app: KIND_APP[k.app] || null, kept: true,
      h: `${k.kind === "card" || k.kind === "job" ? `<span class="k">${esc(k.kind === "card" ? "card" : k.app || "job")}</span> ` : k.kind === "cmd" ? "› " : ""}${esc(k.text)}${k.n > 1 ? ` <span class="dim">×${k.n}</span>` : ""}${k.err ? ` — ${esc(k.err)}` : ""}`,
      r: k.ms != null ? fmt.ms(k.ms) : "", txt: `${k.text} ${k.err || ""} ${k.app || ""} ${k.kind}`.toLowerCase() }); });
  }
  const words = LOG.q.toLowerCase().split(/\s+/).filter(Boolean);
  const keep = (r) => r.t >= LOG.clearedAt && (!LOG.kind || r.kind === LOG.kind || (LOG.kind === "err" && r.c === "err")) && (!LOG.app || r.app === LOG.app) && words.every((w) => r.txt.includes(w));
  const filt = rows.filter(keep).sort((a, b) => LOG.order === "oldest" ? a.t - b.t : b.t - a.t);
  const shown = LOG.order === "oldest" ? filt.slice(-(LOG.kept ? 1000 : 250)) : filt.slice(0, LOG.kept ? 1000 : 250);
  const atEnd = LOG.order === "oldest" ? b.scrollTop + b.clientHeight >= b.scrollHeight - 8 : b.scrollTop < 8;
  const info = LOG.keptInfo ? `<div class="hint lg-info">${fmt.n(filt.length)} lines · kept on the server: ${fmt.bytes(LOG.keptInfo.kept_bytes)} of ${fmt.bytes(LOG.keptInfo.max_bytes)}${LOG.keptInfo.oldest ? ", since " + hms(LOG.keptInfo.oldest) : ""}</div>` : (LOG.q || LOG.kind || LOG.app) ? `<div class="hint lg-info">${fmt.n(filt.length)} of ${fmt.n(rows.length)} lines match. Kept adds the older history.</div>` : "";
  b.innerHTML = info + (shown.length ? shown.map((r) => `<div class="lg ${r.c}${r.app ? " link" : ""}${r.kept ? " kept" : ""}"${r.app ? ` data-app="${r.app}" title="Open ${esc(views()[r.app] ? views()[r.app].title : r.app)}"` : ""}><time>${hms(r.t)}</time><span class="m">${r.h}</span>${r.r ? `<span class="r">${r.r}</span>` : ""}</div>`).join("") : `<div class="hint">${rows.length ? "No line matches." : "Nothing yet. Runs on the card, background jobs and your commands appear here."}</div>`);
  $$("[data-app]", b).forEach((x) => x.onclick = () => nav(x.dataset.app));
  if (atEnd || jump) b.scrollTop = LOG.order === "oldest" ? b.scrollHeight : 0;
}

// ---------------------------------------------------------------- viewers of the system track
const DEFAULT_TOOL = `VectorFall.Tool — click any Module.Command to run it.
The rest of the line is its argument (up to the next command or a ~).
^ stands for the text you last selected, anywhere in VectorFall.
Edit this text with Edit above. The server keeps it.

System.Open data     System.Open console     System.Open machine
System.Mode application     System.Dock left     System.Grow

Data.Ticker SPY 5
Data.Open ^      Data.Watch ^
Sim.History ^    Reservoir.Forecast ^

Photo.Search a dog on a beach
Text.Trace ^
Text.Continue it was the
Sound.Find
Plan.Route   Plan.Roster   Plan.Teams   Sim.Budget

System.Commands     System.Viewer recent`;
const TOOL = { text: null, edit: false };
async function loadTool() {
  try { const r = await api.get("/system/tool"); TOOL.text = r.text == null ? DEFAULT_TOOL : r.text; } catch (e) { TOOL.text = DEFAULT_TOOL; }
  renderTool();
}
function renderTool() {
  const b = $("#sv-tool-b");
  if (!b || TOOL.text == null) return;
  const ed = $("#sv-tool-edit");
  if (ed) ed.textContent = TOOL.edit ? "Save" : "Edit";
  if (TOOL.edit) {
    b.innerHTML = `<textarea class="tool-ed" id="sv-tool-ed" spellcheck="false">${esc(TOOL.text)}</textarea>`;
    $("#sv-tool-ed").focus();
    $("#sv-tool-ed").onkeydown = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveTool(); } if (e.key === "Escape") { TOOL.edit = false; renderTool(); } };
    return;
  }
  b.innerHTML = `<pre class="tool">${TOOL.text.split("\n").map(toolLine).join("\n")}</pre>`;
  $$(".cmd", b).forEach((x) => {
    const fire = (e) => { e.preventDefault(); run(x.dataset.c, x.dataset.a); };
    x.onclick = fire;
    x.onauxclick = (e) => { if (e.button === 1) fire(e); };      // the middle button, as in Oberon
  });
}
function toolLine(line) {
  const ms = [...line.matchAll(CMD_RE)];
  if (!ms.length) return esc(line);
  let out = "", pos = 0;
  ms.forEach((m, i) => {
    const end = i + 1 < ms.length ? ms[i + 1].index : line.length;
    let arg = line.slice(m.index + m[0].length, end);
    const tl = arg.indexOf("~"); if (tl >= 0) arg = arg.slice(0, tl);
    out += esc(line.slice(pos, m.index));
    const known = !!CMDS[m[1]];
    out += known ? `<a class="cmd" href="#" data-c="${m[1]}" data-a="${esc(arg.trim())}" title="${esc(CMDS[m[1]].d)}${arg.trim() ? " — " + esc(arg.trim()) : ""}">${m[1]}</a>` : esc(m[1]);
    pos = m.index + m[0].length;
  });
  return out + esc(line.slice(pos));
}
async function saveTool() {
  const t = $("#sv-tool-ed");
  if (t) TOOL.text = t.value;
  try { await api.put("/system/tool", { text: TOOL.text }); TOOL.edit = false; renderTool(); log("client", "Tool saved"); }
  catch (e) { toast(e.message, "bad"); }
}

const SPARK = [];
function renderMachine(m) {
  const b = $("#sv-mach-b");
  if (!b || !m) return;
  const L = m.live || {}, W = m.worker || {}, H = m.host || {}, act = m.activity || [];
  if (!$("#sv-spark", b)) b.innerHTML = `<div class="mv-spark"><canvas id="sv-spark"></canvas><span id="sv-spark-l"></span></div><div class="mv-kv" id="sv-mkv"></div>`;
  const c = $("#sv-spark"), box = c.parentElement, dpr = window.devicePixelRatio || 1, w = box.clientWidth, h = box.clientHeight;
  if (w && h) {
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const n = SPARK.length, X = (i) => w - (n - 1 - i) * (w / 119), Y = (v) => h - 2 - v / 100 * (h - 4);
    g.beginPath(); SPARK.forEach((s, i) => i ? g.lineTo(X(i), Y(s.u)) : g.moveTo(X(i), Y(s.u)));
    g.lineTo(X(n - 1), h); g.lineTo(X(0), h); g.closePath(); g.fillStyle = "rgba(255,42,26,.16)"; g.fill();
    g.beginPath(); SPARK.forEach((s, i) => i ? g.lineTo(X(i), Y(s.u)) : g.moveTo(X(i), Y(s.u))); g.strokeStyle = "#ff2a1a"; g.lineWidth = 1.3; g.stroke();
    g.beginPath(); SPARK.forEach((s, i) => i ? g.lineTo(X(i), Y(s.mem)) : g.moveTo(X(i), Y(s.mem))); g.strokeStyle = "#3fa9f5"; g.lineWidth = 1; g.stroke();
  }
  $("#sv-spark-l").innerHTML = `<b class="red">GPU ${L.util_gpu ?? "—"}%</b> <b class="blue">mem ${L.mem_total ? Math.round(L.mem_used / L.mem_total * 100) : "—"}%</b> <span class="dim">last 3 min</span>`;
  const first = act[0];
  $("#sv-mkv").innerHTML = `<span>Now</span><b>${first ? esc(first.label) + (W.elapsed != null && first.src === "worker" ? ` · ${Math.round(W.elapsed)} s` : "") : "nothing"}</b>
    <span>Queued</span><b>${W.queued || 0}${act.length > 1 ? ` · ${act.length - 1} other on card` : ""}</b>
    <span>Card</span><b>${L.temp != null ? L.temp + "°C" : "—"} · ${L.mem_used != null ? fmt.n(L.mem_used) + " / " + fmt.n(L.mem_total) + " MB" : "—"}${L.power != null ? " · " + Math.round(L.power) + " W" : ""}</b>
    <span>Host</span><b>${H.cpu != null ? Math.round(H.cpu) + "% CPU · " + (H.mem_used_mb / 1024).toFixed(1) + " / " + Math.round(H.mem_total_mb / 1024) + " GB" : "—"}</b>
    ${m.corpus ? `<span>Corpus</span><b>${esc(m.corpus.name || "")}</b>` : ""}`;
}
async function renderRecent() {
  const b = $("#sv-rec-b");
  if (!b) return;
  const ts = await tables(true);
  b.innerHTML = ts.length ? `<div class="list">${ts.slice(0, 12).map((t) => `<div class="li" data-t="${t.id}" title="Data.Open ${esc(t.name)}"><div class="tx"><div class="nm">${esc(t.name)}</div><div class="sub">${fmt.n(t.rows)} rows · ${(t.numeric || []).length} numeric${t.created ? " · " + fmt.ago(t.created) : ""}</div></div></div>`).join("")}</div>`
    : `<div class="hint">No tables yet. Data.Ticker SPY 5 makes one.</div>`;
  $$("[data-t]", b).forEach((x) => x.onclick = () => nav("data", { table: x.dataset.t }));
}

const VIEWERS = {
  log: { name: "Log", icon: "console", sub: "every run on the card, every job, every command",
    tools: () => `<button class="vc" id="sv-log-gpu" title="Show the individual runs on the card, or only jobs and commands">${P.logGpu ? "Jobs only" : "Card runs"}</button><button class="vc" id="sv-log-clr" title="Hide what is there now (the server keeps its record)">Clear</button>`,
    init: () => { $("#sv-log-gpu").onclick = () => { P.logGpu = !P.logGpu; save(); buildTrack(); }; $("#sv-log-clr").onclick = () => { LOG.clearedAt = Date.now() / 1000; renderLog(); }; renderLog(); pullLog(); } },
  tool: { name: "Tool", icon: "bolt", sub: "commands as text — click to run, edit to make your own",
    meta: `<span id="sv-tool-sel"></span>`,
    tools: () => `<button class="vc" id="sv-tool-edit">Edit</button>`,
    init: () => { $("#sv-tool-edit").onclick = () => { if (TOOL.edit) saveTool(); else { TOOL.edit = true; renderTool(); } }; showSel(); if (TOOL.text == null) loadTool(); else renderTool(); } },
  machine: { name: "Machine", icon: "machine", sub: "the card, live: load, memory, the jobs that run now",
    tools: () => `<button class="vc" id="sv-mach-open">Open</button>`,
    init: () => { $("#sv-mach-open").onclick = () => nav("machine"); renderMachine(machine.last); } },
  recent: { name: "Recent", icon: "data", sub: "the newest Data Desk tables",
    tools: () => `<button class="vc" id="sv-rec-r">Refresh</button>`,
    init: () => { $("#sv-rec-r").onclick = renderRecent; renderRecent(); } },
};
function toggleViewer(id, show) {
  const has = P.viewers.some((v) => v.id === id);
  if (show === true && has) return;
  if (has) P.viewers = P.viewers.filter((v) => v.id !== id);
  else P.viewers.push({ id, h: 0.25 });
  if (P.vgrow && !P.viewers.some((v) => v.id === P.vgrow)) P.vgrow = null;
  save(); buildTrack();
}
function buildTrack() {
  let st = $("#systrack");
  if (!st) {
    st = document.createElement("aside");
    st.id = "systrack"; st.className = "systrack";
    document.body.appendChild(st);
  }
  st.innerHTML = `<div class="st-edge" id="st-edge" title="Drag to resize the system track · double-click: full width for this app"></div>` +
    (P.viewers.length ? P.viewers.map((v, i) => { const d = VIEWERS[v.id]; return `<section class="sv${P.vgrow === v.id ? " grown" : P.vgrow ? " folded" : ""}" data-sv="${v.id}" data-i="${i}">
      <div class="sv-h" title="Drag to move this boundary"><b>${d.name}</b><span class="meta">${d.meta || ""}</span><span class="sp"></span>${d.tools()}<button class="vc" data-grow>${P.vgrow === v.id ? "Shrink" : "Grow"}</button><button class="vc" data-close>Close</button></div>
      <div class="sv-b" id="sv-${{ log: "log", tool: "tool", machine: "mach", recent: "rec" }[v.id]}-b"></div></section>`; }).join("")
      : `<div class="hint st-empty">The system track is empty. Layout → add Log, Tool, Machine or Recent.</div>`);
  P.viewers.forEach((v) => VIEWERS[v.id].init());
  $$(".sv [data-close]", st).forEach((b) => b.onclick = () => toggleViewer(b.closest(".sv").dataset.sv));
  $$(".sv [data-grow]", st).forEach((b) => b.onclick = () => { const id = b.closest(".sv").dataset.sv; P.vgrow = P.vgrow === id ? null : id; save(); buildTrack(); });
  $$(".sv-h", st).forEach((h) => h.onmousedown = (e) => dragBoundary(e, +h.parentElement.dataset.i));
  $("#st-edge").onmousedown = dragEdge;
  $("#st-edge").ondblclick = () => toggleGrow();
  layoutTrack();
}
function layoutTrack() {
  $$("#systrack .sv").forEach((el) => {
    const v = P.viewers[+el.dataset.i];
    el.style.flex = P.vgrow ? (P.vgrow === v.id ? "1 1 0" : "none") : `${v.h} 1 0`;
  });
}
// Oberon: drag a viewer's title bar up or down and the boundary above it follows
function dragBoundary(e, i) {
  if (e.button !== 0 || e.target.closest("button") || i === 0 || P.vgrow) return;
  e.preventDefault();
  const els = $$("#systrack .sv"), a = els[i - 1], b = els[i];
  const ha = a.getBoundingClientRect().height, hb = b.getBoundingClientRect().height, tot = P.viewers[i - 1].h + P.viewers[i].h, y0 = e.clientY;
  document.body.classList.add("dragging-y");
  const mv = (ev) => {
    const d = Math.max(-(ha - 60), Math.min(hb - 60, ev.clientY - y0));
    P.viewers[i - 1].h = tot * (ha + d) / (ha + hb); P.viewers[i].h = tot - P.viewers[i - 1].h; layoutTrack();
  };
  const up = () => { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); document.body.classList.remove("dragging-y"); save(); renderMachine(machine.last); };
  document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
}
function dragEdge(e) {
  e.preventDefault();
  const x0 = e.clientX, w0 = P.track;
  document.body.classList.add("dragging-x");
  const mv = (ev) => { P.track = Math.max(240, Math.min(560, w0 + (x0 - ev.clientX))); document.documentElement.style.setProperty("--track", P.track + "px"); };
  const up = () => { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); document.body.classList.remove("dragging-x"); save(); window.dispatchEvent(new Event("resize")); renderMachine(machine.last); };
  document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
}

// ---------------------------------------------------------------- notifications: a finished job you were not watching
const SEEN = new Map();
function watchJobs(m) {
  const now = new Set(((m && m.jobs) || []).map((j) => j.id));
  ((m && m.jobs) || []).forEach((j) => { if (!SEEN.has(j.id)) SEEN.set(j.id, j); });
  [...SEEN.keys()].forEach(async (id) => {
    if (now.has(id)) return;
    const was = SEEN.get(id); SEEN.delete(id);
    let j = null; try { j = await api.get("/jobs/" + id); } catch (e) { return; }
    if (!j || j.state === "running") return;
    if (desk() && P.viewers.some((v) => v.id === "log")) pullLog();
    const app = KIND_APP[j.kind], here = currentView() && currentView().id === app && !document.hidden;
    if (j.elapsed < 4 && j.state !== "error") return;          // short jobs: you were watching
    if (here && j.state !== "error") return;
    note(`${j.label}`, j.state === "error" ? `failed — ${j.error || ""}` : `done in ${fmt.ms(j.elapsed * 1000)}`, j.state === "error" ? "bad" : "good", app);
    void was;
  });
}
function note(title, msg, kind, app) {
  let box = $("#vf-notes");
  if (!box) { box = document.createElement("div"); box.id = "vf-notes"; box.className = "vf-notes"; document.body.appendChild(box); }
  const n = document.createElement("div");
  n.className = "vf-note " + kind;
  n.innerHTML = `<div class="tx"><b>${esc(title)}</b><span>${esc(msg)}</span></div>${app ? `<button class="btn sm">Open</button>` : ""}<button class="iconbtn x" title="Dismiss">×</button>`;
  box.appendChild(n);
  const bye = () => { n.classList.add("out"); setTimeout(() => n.remove(), 250); };
  if (app) n.querySelector(".btn").onclick = () => { nav(app); bye(); };
  n.querySelector(".x").onclick = bye;
  setTimeout(bye, kind === "bad" ? 14000 : 9000);
}

// ---------------------------------------------------------------- the command bar (Ctrl K): the same interpreter, with suggestions
let bar = null;
export async function cmdbar(initial = "") {
  if (bar) { bar.querySelector("input").focus(); return; }
  bar = document.createElement("div");
  bar.id = "vf-cmdbar"; bar.className = "vf-cmdbar";
  bar.innerHTML = `<div class="cb"><div class="cb-in">${IC.search}<input id="cb-q" spellcheck="false" autocomplete="off" placeholder="Open an app, a table, or type a command — Photo.Search a dog"><kbd>Esc</kbd></div><div class="cb-list" id="cb-list"></div>
    <div class="cb-f"><span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>Tab</kbd> complete</span><span><kbd>Enter</kbd> run</span><span class="sp"></span><span>${SEL ? `^ = “${esc(SEL.slice(0, 30))}${SEL.length > 30 ? "…" : ""}”` : "^ = the text you last selected"}</span></div></div>`;
  document.body.appendChild(bar);
  const inp = $("#cb-q"), list = $("#cb-list");
  inp.value = initial;
  let items = [], sel = 0;
  const V = views();
  const base = [
    ...Object.entries(CMDS).map(([k, c]) => ({ k: "command", name: k, sig: c.sig, d: c.d, cmd: k })),
    ...Object.keys(V).map((id) => ({ k: "app", name: V[id].title, d: V[id].sub || "", cmd: "System.Open", arg: id })),
    ...PROBLEMS.map((p) => ({ k: "problem", name: p.q, d: p.a, go: p.go })),
  ];
  const ts = await tables();
  if (!bar) return;
  try { (await (await fetch("/v1/models")).json()).models.forEach((m) => base.push({ k: "model", name: m.name, d: m.title + (m.device === "cpu" ? "" : " · " + m.device), cmd: "Model.Run", arg: m.name })); } catch (e) { /* registry unavailable */ }
  ts.slice(0, 40).forEach((t) => base.push({ k: "table", name: t.name, d: `${fmt.n(t.rows)} rows · Data.Open`, cmd: "Data.Open", arg: t.id }));
  const typed = () => { const v = inp.value.trim(), m = v.match(/^([A-Z][a-z]+\.[A-Z][A-Za-z]+)\b\s*(.*)$/); return m && CMDS[m[1]] ? { cmd: m[1], arg: m[2] } : null; };
  const draw = () => {
    const q = inp.value.trim().toLowerCase(), t = typed();
    const head = q.split(/\s+/)[0];
    items = !q ? base.filter((x) => x.k !== "table" && x.k !== "model") :
      base.map((x) => {
        const n = x.name.toLowerCase(), d = (x.d || "").toLowerCase();
        const s = n === q ? 100 : n.startsWith(q) ? 80 : (x.k === "command" && n.startsWith(head)) ? 70 : n.includes(q) ? 60 : q.split(/\s+/).every((w) => n.includes(w) || d.includes(w)) ? 30 : 0;
        return [s, x];
      }).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).map(([, x]) => x);
    if (t) items = [{ k: "run", name: t.cmd + (t.arg ? " " + t.arg : ""), d: CMDS[t.cmd].d, cmd: t.cmd, arg: t.arg }, ...items.filter((x) => x.cmd !== t.cmd || x.k !== "command")];
    items = items.slice(0, 60);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    const lab = { command: "command", app: "app", problem: "solve", table: "table", run: "run", model: "model" };
    list.innerHTML = items.length ? items.map((x, i) => `<div class="cb-i${i === sel ? " on" : ""}" data-i="${i}"><span class="k ${x.k}">${lab[x.k]}</span><span class="n">${esc(x.name)}${x.k === "command" && x.sig ? ` <i>${esc(x.sig)}</i>` : ""}</span><span class="d">${esc(x.d || "")}</span></div>`).join("")
      : `<div class="hint">Nothing matches. Commands look like Module.Command — System.Commands lists them.</div>`;
    $$(".cb-i", list).forEach((el) => { el.onmousemove = () => { if (sel !== +el.dataset.i) { sel = +el.dataset.i; mark(); } }; el.onclick = () => choose(items[+el.dataset.i]); });
  };
  const mark = () => $$(".cb-i", list).forEach((el, i) => { el.classList.toggle("on", i === sel); if (i === sel) el.scrollIntoView({ block: "nearest" }); });
  const close = () => { if (bar) { bar.remove(); bar = null; document.removeEventListener("keydown", keys, true); } };
  const choose = (x) => {
    if (!x) return;
    if (x.k === "command" && x.sig && !/^\[/.test(x.sig)) { inp.value = x.name + " "; sel = 0; draw(); inp.focus(); return; }   // needs an argument
    close();
    if (x.go) nav(x.go[0], x.go[1]); else run(x.cmd, x.arg || "");
  };
  const keys = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); mark(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); mark(); }
    else if (e.key === "Tab") { e.preventDefault(); const x = items[sel]; if (x && x.cmd && x.k !== "run") { inp.value = (x.k === "command" ? x.name : x.cmd + " " + (x.k === "table" ? x.name : x.arg)) + " "; draw(); } }
    else if (e.key === "Enter") { e.preventDefault(); const t = typed(); if (t && (sel === 0 || !items[sel])) { close(); run(t.cmd, t.arg); } else choose(items[sel]); }
  };
  document.addEventListener("keydown", keys, true);
  inp.oninput = () => { sel = 0; draw(); };
  bar.addEventListener("mousedown", (e) => { if (e.target === bar) close(); });
  draw(); inp.focus();
}

// ---------------------------------------------------------------- start
export function startShell() {
  buildRailExtras();
  buildTrack();
  apply();
  routeSubs.add(() => apply());
  onMachine((m) => {
    syncDock(m); watchJobs(m);
    const L = m.live || {};
    SPARK.push({ u: L.util_gpu || 0, mem: L.mem_total ? L.mem_used / L.mem_total * 100 : 0 }); if (SPARK.length > 120) SPARK.shift();
    if (desk() && !$("#systrack").hidden) renderMachine(m);
  });
  setInterval(() => { if (!document.hidden && desk() && !$("#systrack").hidden && P.viewers.some((v) => v.id === "log")) pullLog(); }, 2500);
  window.addEventListener("resize", () => { const was = document.body.classList.contains("track-on"), now = desk() && window.innerWidth >= 1280 && !(currentView() && P.grown[currentView().id]); if (was !== now) apply(); });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") { e.preventDefault(); cmdbar(); }
  });
}
