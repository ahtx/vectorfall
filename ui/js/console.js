// Console IDE: workspace files + examples | editor over terminal | output — resizable gutters, fills the work area.
// Save / Save as / New / Rename / Delete / Run / Stop; Ctrl+S saves, Ctrl+Enter runs. Code executes on the GPU.
import { $, $$, api, esc, fmt, icon, toast } from "./core.js";
import { GUIDE, REF, refLeaves } from "./console-help.js";
import { attach as assist, snippets } from "./console-assist.js";
import { menu } from "./hub.js";

const LEAVES = refLeaves();
let tab = "out", lesson = 0, refId = null, cameFrom = null, harnessSrc = null;
let cm = null, examples = [], running = false, files = [], curFile = null, dirty = false, history = [], hi = 0, runT0 = 0, tick = 0;

export default {
  id: "console", title: "Console", sub: "Python IDE on the card", icon: "console",
  mount(el) {
    el.innerHTML = `
    <div class="ide2" id="ide">
      <section class="pane ide-files">
        <div class="pane-h"><div class="t">Workspace</div><div class="tools">
          <button class="iconbtn" id="ide-new" title="New file">${icon("plus")}</button>
          <button class="iconbtn" id="ide-ren" title="Rename current file (F2)">${icon("text")}</button>
          <button class="iconbtn" id="ide-refresh" title="Refresh">${icon("undo")}</button></div></div>
        <div class="pane-b flush">
          <div class="grp">Files <span class="dim" id="ide-count"></span></div><div id="ide-tree" class="list"></div>
          <div class="grp">Examples</div><div id="ide-ex" class="list"></div>
          <div class="grp">Reference <span class="dim">F1 in the editor</span></div><div id="ide-ref" class="reftree"></div>
        </div>
        <div class="pane-f">~/scripts</div>
      </section>
      <div class="gutter gx" data-g="g1"></div>
      <div class="ide-mid">
        <section class="pane ide-ed">
          <div class="pane-h"><div class="t" id="ide-name">untitled.py</div><div class="meta" id="ide-state"></div><div class="tools">
            <button class="btn ghost xs" id="ide-snip" title="Insert a ready call: solvers, templates, any model (Ctrl+Space completes as you type)">${icon("plus")} Snippets</button>
            <button class="btn ghost xs" id="ide-saveas" title="Save as a new file">Save as</button>
            <button class="btn ghost xs" id="ide-save" title="Ctrl+S">Save</button>
            <span class="tbsep"></span>
            <button class="btn ghost xs" id="ide-stop" disabled>${icon("stop")} Stop</button>
            <button class="btn sm" id="ide-run" title="Ctrl+Enter">${icon("play")} Run</button></div></div>
          <div class="pane-b flush ide-editor"><textarea id="ide-code"></textarea></div>
        </section>
        <div class="gutter gy" data-g="gt"></div>
        <section class="pane ide-term" id="ide-term">
          <div class="pane-h"><div class="t">Terminal</div><div class="meta">bash · ~/scripts · ↑↓ history</div><div class="tools"><button class="btn ghost xs" id="ide-tclear">Clear</button></div></div>
          <pre class="pane-b ide-termout" id="ide-termout"></pre>
          <div class="ide-termin"><span class="prompt">$</span><input id="ide-cmd" spellcheck="false" autocomplete="off" placeholder="ls, pip list, nvidia-smi, python3 file.py …"></div>
        </section>
      </div>
      <div class="gutter gx" data-g="g2"></div>
      <section class="pane ide-out">
        <div class="pane-h"><div class="tabs" id="ide-tabs"><button data-tab="out" class="on">Output</button><button data-tab="guide">Guide</button><button data-tab="ref">Reference</button></div>
          <div class="meta" id="ide-ometa"></div><div class="tools"><button class="btn ghost xs" id="ide-back" hidden></button><button class="btn ghost xs" id="ide-oclear">Clear</button></div></div>
        <div class="pane-b out" id="ide-output">${intro()}</div>
        <div class="pane-b hlp" id="ide-guide" hidden></div>
        <div class="pane-b hlp" id="ide-refv" hidden></div>
        <div class="pane-f" id="ide-of">ready</div>
      </section>
    </div>`;
    load();
  },
  show() { if (cm && cm.refresh) setTimeout(() => cm.refresh(), 0); takeInsert(); },
};
function intro() { return `<div class="empty">Write Python and press <b>Run</b> (Ctrl+Enter). It executes on the GPU (<span data-card="name">this card</span>) in its own process.<br><b>np</b> runs on the CPU, <b>cp</b> on the GPU; <b>vf.show · plot · table · race</b> display results here.<br>New to this? Open the <a href="#" data-goto="guide">Guide</a> — step-by-step lessons you can run. Press <b>F1</b> on any word in the editor to look it up.</div>`; }

async function load() {
  try { examples = await api.get("/console/examples"); } catch (e) { examples = []; }
  $("#ide-ex").innerHTML = examples.map((e) => `<div class="li" data-ex="${esc(e.id)}"><div class="tx"><div class="nm">${esc(e.title)}</div><div class="sub mono">${esc(e.id)}.py</div></div></div>`).join("");
  $$("#ide-ex [data-ex]").forEach((b) => b.onclick = () => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    const ex = examples.find((x) => x.id === b.dataset.ex); curFile = null; setCode(ex.code); setName(ex.id + ".py"); renderTree();
  });
  if (window.CodeMirror) {
    cm = window.CodeMirror.fromTextArea($("#ide-code"), { mode: "python", theme: "vf", lineNumbers: true, indentUnit: 4, autofocus: true, matchBrackets: true,
      extraKeys: { F1: () => lookup(), "Cmd-Enter": run, "Ctrl-Enter": run, "Cmd-S": () => save(), "Ctrl-S": () => save(), F2: () => rename(), Tab: (c) => c.replaceSelection("    ") } });
    cm.on("change", () => { if (!dirty) { dirty = true; setName(); renderTree(); } });
    assist(cm);
  } else {
    const ta = $("#ide-code"); ta.className = "ide-plain";
    cm = { getValue: () => ta.value, setValue: (v) => { ta.value = v; } };
    ta.addEventListener("input", () => { if (!dirty) { dirty = true; setName(); } });
    ta.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); run(); } if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); } });
  }
  if (examples.length) { setCode(examples[0].code); setName("scratch.py"); }
  try { lesson = Math.max(0, Math.min(GUIDE.length - 1, +localStorage.getItem("vf-ide-lesson") || 0)); } catch (e) { /* storage off */ }
  renderRefTree(); renderGuide();
  $$("#ide-tabs [data-tab]").forEach((b) => b.onclick = () => setTab(b.dataset.tab));
  $("#ide").addEventListener("click", helpClick);
  $("#ide-back").onclick = () => { if (cameFrom) setTab(cameFrom); };
  $("#ide-run").onclick = run;
  $("#ide-stop").onclick = () => api.post("/console/stop").catch(() => {});
  $("#ide-save").onclick = () => save();
  $("#ide-saveas").onclick = () => save(true);
  $("#ide-snip").onclick = async (e) => { const b = e.currentTarget, list = await snippets(); menu(b, list.map(([t, code]) => ({ icon: "console", label: t, run: () => insertCode(code) }))); };
  $("#ide-ren").onclick = rename;
  $("#ide-refresh").onclick = refreshFiles;
  $("#ide-new").onclick = newFile;
  $("#ide-oclear").onclick = () => { setTab("out"); $("#ide-output").innerHTML = intro(); $("#ide-ometa").textContent = ""; lastFoot = $("#ide-of").textContent = "ready"; };
  $("#ide-tclear").onclick = () => { $("#ide-termout").textContent = ""; };
  const cmd = $("#ide-cmd");
  cmd.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") { const c = cmd.value.trim(); if (!c) return; cmd.value = ""; history.push(c); hi = history.length; await term(c); }
    else if (e.key === "ArrowUp") { if (hi > 0) cmd.value = history[--hi] || ""; e.preventDefault(); }
    else if (e.key === "ArrowDown") { hi = Math.min(history.length, hi + 1); cmd.value = history[hi] || ""; }
  });
  window.addEventListener("keydown", (e) => {
    if (!document.querySelector("#view-console.on")) return;
    if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); save(); }
  });
  window.addEventListener("beforeunload", (e) => { if (dirty && curFile) { e.preventDefault(); e.returnValue = ""; } });
  splitters();
  refreshFiles();
  takeInsert();
}
// code sent from a lab or the Models page ("Open in the Console"): a new unsaved buffer, so nothing of yours is lost
function takeInsert() {
  let code = null;
  try { code = sessionStorage.getItem("vf-console-insert"); sessionStorage.removeItem("vf-console-insert"); } catch (e) { /* storage off */ }
  if (!code || !cm) return;
  if (dirty && !confirm("Open the call in a new buffer? Your unsaved changes here are discarded.")) { insertCode(code); return; }
  curFile = null; setCode(code); setName("call.py"); renderTree(); dirty = true; setName();
  toast("The call is in the editor: press Run (Ctrl+Enter)", "good", 2400);
}
function insertCode(code) {
  if (!cm) return;
  if (cm.replaceSelection && cm.getCursor) { const c = cm.getCursor(); cm.replaceRange((c.ch ? "\n" : "") + code + "\n", c); cm.focus(); }
  else cm.setValue(cm.getValue() + "\n" + code);
}

function displayName() { return $("#ide-name").dataset.n || "untitled.py"; }
function setName(n) {
  if (n) $("#ide-name").dataset.n = n;
  $("#ide-name").textContent = displayName();
  $("#ide-state").textContent = dirty ? (curFile ? "● modified" : "● unsaved") : (curFile ? "saved" : "not saved to the workspace");
}
function setCode(v) { cm.setValue(v); dirty = false; setName(); }
async function refreshFiles() { try { files = await api.get("/console/files"); } catch (e) { files = []; } renderTree(); }
function renderTree() {
  $("#ide-count").textContent = files.length ? files.length : "";
  $("#ide-tree").innerHTML = files.length ? files.map((f) => `<div class="li ${curFile === f.name ? "on" : ""}" data-f="${esc(f.name)}">
      <div class="tx"><div class="nm mono">${esc(f.name)}${curFile === f.name && dirty ? " ●" : ""}</div><div class="sub">${fmt.bytes(f.size)} · ${fmt.ago(f.modified)}</div></div>
      <button class="iconbtn xdel" data-del="${esc(f.name)}" title="Delete">${icon("trash")}</button></div>`).join("")
    : `<div class="li"><div class="sub">No saved files yet — Save writes to ~/scripts.</div></div>`;
  $$("#ide-tree [data-f]").forEach((b) => b.onclick = async (e) => {
    if (e.target.closest("[data-del]")) return;
    if (dirty && b.dataset.f !== curFile && !confirm("Discard unsaved changes?")) return;
    try { const r = await api.get("/console/file?name=" + encodeURIComponent(b.dataset.f)); curFile = b.dataset.f; setCode(r.content); setName(b.dataset.f); renderTree(); }
    catch (err) { toast(err.message, "bad"); }
  });
  $$("#ide-tree [data-del]").forEach((x) => x.onclick = async (e) => {
    e.stopPropagation(); if (!confirm("Delete " + x.dataset.del + "?")) return;
    await api.del("/console/file?name=" + encodeURIComponent(x.dataset.del));
    if (curFile === x.dataset.del) { curFile = null; dirty = true; setName(); }
    refreshFiles();
  });
}
const exists = (n) => files.some((f) => f.name === n);
const norm = (n) => { n = (n || "").trim(); return n && !/\.(py|txt|md|json|csv)$/.test(n) ? n + ".py" : n; };
async function newFile() {
  if (dirty && !confirm("Discard unsaved changes?")) return;
  const n = norm(prompt("New file name:", "untitled.py")); if (!n) return;
  if (exists(n)) { toast(n + " already exists", "bad"); return; }
  try { const r = await api.put("/console/file", { name: n, content: "" }); curFile = r.name; setCode(""); setName(r.name); refreshFiles(); }
  catch (e) { toast(e.message, "bad"); }
}
async function save(as = false) {
  let name = curFile;
  if (!name || as) {
    name = norm(prompt(as ? "Save as:" : "Save to the workspace as:", displayName())); if (!name) return;
    if (exists(name) && name !== curFile && !confirm(name + " exists — overwrite it?")) return;
  }
  try {
    const r = await api.put("/console/file", { name, content: cm.getValue() });
    curFile = r.name; dirty = false; setName(r.name); toast("Saved " + r.name, "good"); refreshFiles();
  } catch (e) { toast(e.message, "bad"); }
}
async function rename() {
  if (!curFile) { toast("Save the file first, then rename it"); return; }
  const n = norm(prompt("Rename " + curFile + " to:", curFile)); if (!n || n === curFile) return;
  if (exists(n)) { toast(n + " already exists", "bad"); return; }
  try { const r = await api.post("/console/rename", { old: curFile, new: n }); curFile = r.name; setName(r.name); refreshFiles(); toast("Renamed to " + r.name, "good"); }
  catch (e) { toast(e.message, "bad"); }
}

// Run streams: /console/start returns at once, and /console/poll brings each output as it happens (printed text,
// vf.show / plot / table, the progress of vf.solve). Stop kills the process; the last poll then says so.
let RUN = null;
async function run() {
  if (running) return;
  running = true; $("#ide-run").disabled = true; $("#ide-stop").disabled = false;
  runT0 = performance.now();
  setTab("out");
  const out = $("#ide-output");
  out.innerHTML = `<div class="chip red ide-runchip" style="align-self:flex-start">● the card runs your code…</div><div class="ide-prog" id="ide-prog" hidden><span></span><i><b></b></i></div>`;
  $("#ide-ometa").textContent = displayName();
  clearInterval(tick); tick = setInterval(() => { $("#ide-of").innerHTML = `running · ${fmt.ms(performance.now() - runT0)}`; }, 200);
  const st = { failed: false, secs: null, n: 0 };
  try {
    const { run: rid } = await api.post("/console/start", { code: cm.getValue(), timeout: 60, name: displayName() });
    RUN = rid;
    for (;;) {
      const r = await api.get(`/console/poll?run=${encodeURIComponent(rid)}&since=${st.n}`);
      st.n = r.next;
      for (const o of r.outputs) addOut(out, o, st);
      if (r.done) { finish(out, st, r.wall_s); break; }
      await new Promise((ok) => setTimeout(ok, st.n ? 250 : 120));
    }
  } catch (e) { out.insertAdjacentHTML("beforeend", `<pre class="err">${esc(e.message)}</pre>`); lastFoot = $("#ide-of").textContent = "failed"; }
  RUN = null;
  clearInterval(tick);
  running = false; $("#ide-run").disabled = false; $("#ide-stop").disabled = true;
}
function finish(out, st, wall) {
  const chip = $(".ide-runchip", out); if (chip) chip.remove();
  const pg = $("#ide-prog"); if (pg) pg.remove();
  if (!out.querySelector(":scope > :not(.ide-prog)")) out.innerHTML = `<div class="hint">(no output)</div>`;
  lastFoot = $("#ide-of").innerHTML = `${st.failed ? '<span class="red">failed</span>' : '<span class="ok">done</span>'}${st.secs != null ? ` · run ${fmt.ms(st.secs * 1000)}` : ""} · wall ${wall}s`;
}
// one output, appended as it arrives; printed text joins the block before it
function addOut(out, o, st) {
  const chip = $(".ide-runchip", out); if (chip && o.type !== "progress") chip.remove();
  const atEnd = out.scrollTop + out.clientHeight >= out.scrollHeight - 12;
  const last = out.lastElementChild && out.lastElementChild.id === "ide-prog" ? out.lastElementChild.previousElementSibling : out.lastElementChild;
  const put = (html) => { const pg = $("#ide-prog"); if (pg) pg.insertAdjacentHTML("beforebegin", html); else out.insertAdjacentHTML("beforeend", html); };
  if (o.type === "stdout" || o.type === "stderr") {
    const cls = o.type === "stderr" ? "err" : "";
    if (last && last.tagName === "PRE" && last.dataset.k === o.type) last.textContent += o.text;
    else put(`<pre class="${cls}" data-k="${o.type}">${esc(o.text)}</pre>`);
  } else if (o.type === "error") { put(`<pre class="err">${esc(o.text)}</pre>`); st.failed = true; }
  else if (o.type === "image") put(`${o.title ? `<div class="hint">${esc(o.title)}</div>` : ""}<img src="${o.png}">`);
  else if (o.type === "table") put(`<div class="otbl"><table class="tbl">${o.columns ? `<thead><tr>${o.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>` : ""}<tbody>${o.rows.map((row) => `<tr>${row.map((c) => `<td>${esc(typeof c === "number" ? fmt.n(c, 4) : c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
  else if (o.type === "plot") { const id = "pl" + Math.random().toString(36).slice(2); put(`${o.title ? `<div class="hint">${esc(o.title)}</div>` : ""}<canvas class="chart" id="${id}" style="height:220px"></canvas>`); import("./charts.js").then((ch) => { const c = $("#" + id); if (!c) return; if (o.kind === "bar") ch.bars(c, { x: o.x, y: o.y, h: 220 }); else if (o.kind === "scatter") ch.scatter(c, { pts: o.x.map((x, i) => [x, o.y[i]]), h: 220 }); else ch.line(c, { x: o.x, series: [{ y: o.y }], h: 220 }); }); }
  else if (o.type === "race") { const mx = Math.max(o.cpu_ms, o.gpu_ms); put(`<div class="race"><div class="big red">${o.speedup}× faster</div><div class="lane">CPU<div class="bar" style="width:${o.cpu_ms / mx * 100}%;background:#555"></div>${fmt.ms(o.cpu_ms)}</div><div class="lane">Card<div class="bar" style="width:${o.gpu_ms / mx * 100}%;background:var(--rosso)"></div>${fmt.ms(o.gpu_ms)}</div></div>`); }
  else if (o.type === "progress") {
    const pg = $("#ide-prog"); if (!pg) return;
    pg.hidden = !o.text; $("span", pg).textContent = o.text; $("b", pg).style.width = Math.round((o.progress || 0) * 100) + "%";
    out.appendChild(pg);                                   // the live line stays under the newest output
  } else if (o.type === "done") { st.secs = o.secs; if (o.failed) st.failed = true; }
  if (atEnd) out.scrollTop = out.scrollHeight;
}
// the old one-shot result (kept for callers that have a whole result)
function renderOut(r) {
  const out = $("#ide-output"); out.innerHTML = "";
  const st = { failed: false, secs: null };
  for (const o of r.outputs) addOut(out, o, st);
  finish(out, st, r.wall_s);
}

async function term(cmd) {
  const t = $("#ide-termout");
  t.textContent += `$ ${cmd}\n`;
  try {
    const r = await api.post("/console/shell", { cmd });
    const o = (r.out || "").split("\n").filter((l) => !/^mesg: ttyname failed/.test(l)).join("\n");   // login-shell noise
    t.textContent += o + (!o || o.endsWith("\n") ? "" : "\n");
  }
  catch (e) { t.textContent += e.message + "\n"; }
  t.scrollTop = t.scrollHeight;
}

// resizable panes via draggable gutters; sizes persisted per browser
function splitters() {
  const ide = $("#ide");
  const KEY = "vf-ide-sizes";
  let sz = { g1: 250, g2: 540, gt: 200 };
  try { sz = { ...sz, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch (e) { /* storage off */ }
  const apply = () => {
    const W = ide.clientWidth || 1600, H = ide.clientHeight || 800;
    sz.g1 = Math.max(160, Math.min(420, sz.g1)); sz.g2 = Math.max(260, Math.min(W - sz.g1 - 360, sz.g2)); sz.gt = Math.max(90, Math.min(H - 160, sz.gt));
    ide.style.gridTemplateColumns = `${sz.g1}px var(--gap) minmax(0,1fr) var(--gap) ${sz.g2}px`;
    $("#ide-term").style.flexBasis = sz.gt + "px";
    if (cm && cm.refresh) cm.refresh();
  };
  apply();
  window.addEventListener("resize", () => { if (document.querySelector("#view-console.on")) apply(); });
  $$("#ide .gutter").forEach((g) => g.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const id = g.dataset.g, sx = e.clientX, sy = e.clientY, s0 = sz[id];
    g.classList.add("drag"); document.body.style.userSelect = "none";
    const move = (ev) => {
      if (id === "g1") sz.g1 = s0 + (ev.clientX - sx);
      else if (id === "g2") sz.g2 = s0 - (ev.clientX - sx);
      else sz.gt = s0 - (ev.clientY - sy);
      apply();
    };
    const up = () => { g.classList.remove("drag"); document.body.style.userSelect = ""; document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); try { localStorage.setItem(KEY, JSON.stringify(sz)); } catch (e2) { /* storage off */ } };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
  }));
}


// ---------------------------------------------------------------- Guide and Reference
function setTab(t) {
  if (t !== "out") cameFrom = null;
  tab = t;
  $$("#ide-tabs [data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
  $("#ide-output").hidden = t !== "out"; $("#ide-guide").hidden = t !== "guide"; $("#ide-refv").hidden = t !== "ref";
  $("#ide-oclear").hidden = t !== "out";
  const back = $("#ide-back");
  back.hidden = !(t === "out" && cameFrom);
  if (!back.hidden) back.textContent = "← back to " + (cameFrom === "guide" ? "the lesson" : "the reference");
  $("#ide-ometa").textContent = t === "out" ? (back.hidden ? displayName() : "") : "";
  if (t !== "out") $("#ide-of").textContent = t === "guide" ? "lesson " + (lesson + 1) + " of " + GUIDE.length + " · Run on any block puts it in the editor and runs it" : LEAVES.length + " topics · F1 in the editor looks up the word under the cursor";
  else if (lastFoot != null) $("#ide-of").innerHTML = lastFoot;
}
let lastFoot = "ready";

// Python colouring for help blocks, with the editor's own theme
function hl(code) {
  if (!(window.CodeMirror && window.CodeMirror.runMode)) return esc(code);
  let h = "";
  window.CodeMirror.runMode(code, "python", (txt, style) => { h += style ? `<span class="cm-${style.replace(/ +/g, " cm-")}">${esc(txt)}</span>` : esc(txt); });
  return h;
}
function blocks(body, where) {
  return body.map((b, i) => typeof b === "string" ? b
    : `<div class="hcode"><pre class="cm-s-vf">${hl(b.code)}</pre><div class="acts">
        <button class="btn ghost xs" data-hopen="${where}:${i}" title="Put this code in the editor">Open in editor</button>
        <button class="btn xs" data-hrun="${where}:${i}" title="Put it in the editor and run it">${icon("play")} Run</button></div></div>`).join("");
}
function codeAt(ref) {
  const [w, i] = ref.split(":"), [kind, id] = w.split("/");
  const src = kind === "g" ? GUIDE.find((g) => g.id === id) : LEAVES.find((l) => l.id === id);
  return { code: src.body[+i].code, name: (kind === "g" ? "guide-" : "ref-") + id + ".py" };
}

function renderGuide() {
  const g = GUIDE[lesson];
  $("#ide-guide").innerHTML = `
    <div class="hg-steps">${GUIDE.map((x, i) => `<button class="${i === lesson ? "on" : ""}${i < lesson ? " done" : ""}" data-lesson="${i}" title="${esc(x.title)}">${i + 1}</button>`).join("")}</div>
    <div class="hg-doc">
      <div class="hg-kick">Lesson ${lesson + 1} of ${GUIDE.length}</div>
      <h2>${esc(g.title)}</h2><div class="hg-sum">${esc(g.sum)}</div>
      ${blocks(g.body, "g/" + g.id)}
      <div class="hg-nav">
        ${lesson > 0 ? `<button class="btn ghost sm" data-lesson="${lesson - 1}">← ${esc(GUIDE[lesson - 1].title)}</button>` : "<span></span>"}
        ${lesson < GUIDE.length - 1 ? `<button class="btn sm" data-lesson="${lesson + 1}">${esc(GUIDE[lesson + 1].title)} →</button>` : `<span class="dim">That's the whole guide. The Reference tab has everything in one place.</span>`}
      </div>
    </div>`;
  $("#ide-guide").scrollTop = 0;
  if (tab === "guide") setTab("guide");
}

function renderRefTree() {
  const node = (n, depth) => n.kids
    ? `<details class="rt-g" ${n === REF[0] ? "open" : ""}><summary>${esc(n.t)}<span class="dim">${n.kids.length}</span></summary>${n.kids.map((k) => node(k, depth + 1)).join("")}</details>`
    : `<div class="rt-l ${refId === n.id ? "on" : ""}" data-ref="${esc(n.id)}" title="${esc(n.sig || n.t)}">${esc(n.t)}</div>`;
  const tree = $("#ide-ref");
  const open = new Set($$("details.rt-g[open] > summary", tree).map((s) => s.firstChild.textContent));
  tree.innerHTML = REF.map((n) => node(n, 0)).join("");
  if (open.size) $$("details.rt-g", tree).forEach((d) => { d.open = open.has(d.querySelector("summary").firstChild.textContent); });
  const cur = refId && tree.querySelector(`[data-ref="${refId}"]`);
  if (cur) { let p = cur.parentElement; while (p && p !== tree) { if (p.tagName === "DETAILS") p.open = true; p = p.parentElement; } }
}

function renderRef(q = "") {
  const v = $("#ide-refv");
  const head = `<div class="hg-search"><input class="in" id="ide-rq" placeholder="Search the reference… (F1 in the editor looks up the word under the cursor)" value="${esc(q)}"></div>`;
  const leaf = refId && LEAVES.find((l) => l.id === refId);
  let body;
  if (q.trim()) {
    const s = q.trim().toLowerCase();
    const hits = LEAVES.filter((l) => (l.t + " " + (l.sig || "") + " " + (l.keys || []).join(" ") + " " + l.path.join(" ")).toLowerCase().includes(s));
    body = hits.length ? `<div class="hg-hits">${hits.map((l) => `<div class="li" data-ref="${esc(l.id)}"><div class="tx"><div class="nm">${esc(l.t)}</div><div class="sub">${esc(l.path.join(" › "))}${l.sig ? " · " + esc(l.sig) : ""}</div></div></div>`).join("")}</div>`
      : `<div class="empty">Nothing matches “${esc(q)}”.</div>`;
  } else if (leaf) {
    body = `<div class="hg-doc"><div class="hg-kick">${esc(leaf.path.join(" › "))}</div><h2>${esc(leaf.t)}</h2>
      ${leaf.sig ? `<div class="hg-sig">${esc(leaf.sig)}</div>` : ""}${blocks(leaf.body, "r/" + leaf.id)}</div>`;
  } else {
    body = `<div class="hg-doc"><h2>Reference</h2><div class="hg-sum">Everything the Console gives you, and the CuPy you need to drive the card. Pick a topic here or in the tree on the left.</div>
      ${REF.map((g) => `<div class="hg-idx"><b>${esc(g.t)}</b>${g.kids.map((l) => `<a href="#" data-ref="${esc(l.id)}">${esc(l.t)}</a>`).join("")}</div>`).join("")}</div>`;
  }
  v.innerHTML = head + body;
  const inp = $("#ide-rq");
  inp.oninput = () => { const pos = inp.selectionStart; renderRef(inp.value); const n = $("#ide-rq"); n.focus(); n.setSelectionRange(pos, pos); };
  if (harnessSrc && leaf && leaf.id === "env-run") showHarness();
}
function openRef(id) {
  refId = id; renderRefTree(); renderRef(""); setTab("ref"); $("#ide-refv").scrollTop = 0;
}
async function showHarness() {
  const box = $("#ide-refv .hg-harness"); if (!box) return;
  try { if (!harnessSrc) harnessSrc = await api.get("/console/harness"); box.innerHTML = `<div class="hint mono">${esc(harnessSrc.path)}</div><div class="hcode"><pre class="cm-s-vf">${hl(harnessSrc.source)}</pre></div>`; }
  catch (e) { box.textContent = e.message; }
}

function lookup() {
  if (!cm || !cm.getCursor) return;
  const c = cm.getCursor(), line = cm.getLine(c.line);
  let word = "";
  if (line[c.ch] === "@" || line[c.ch - 1] === "@") word = "@";
  else { const r = cm.findWordAt(c); word = cm.getRange(r.anchor, r.head).trim(); }
  if (!word || !/\w|@/.test(word)) { setTab("ref"); renderRef(""); return; }
  const lw = word.toLowerCase();
  const hit = LEAVES.find((l) => (l.keys || []).includes(word)) || LEAVES.find((l) => (l.keys || []).some((k) => k.toLowerCase() === lw));
  if (hit) openRef(hit.id);
  else { refId = null; setTab("ref"); renderRef(word); }
}

function loadCode(ref, andRun) {
  const { code, name } = codeAt(ref);
  if (dirty && cm.getValue() !== code && !confirm("Replace the code in the editor? Your unsaved changes will be lost.")) return;
  curFile = null; setCode(code); setName(name); renderTree();
  if (andRun) { const from = tab; run().then(() => { cameFrom = from; setTab("out"); }); cameFrom = from; setTab("out"); }
  else toast("In the editor — press Run (Ctrl+Enter)");
}

function helpClick(e) {
  const t = e.target.closest("[data-lesson],[data-ref],[data-hopen],[data-hrun],[data-goto],[data-harness]");
  if (!t) return;
  e.preventDefault();
  if (t.dataset.lesson != null) { lesson = +t.dataset.lesson; try { localStorage.setItem("vf-ide-lesson", lesson); } catch (x) { /* storage off */ } renderGuide(); setTab("guide"); }
  else if (t.dataset.ref) openRef(t.dataset.ref);
  else if (t.dataset.hopen) loadCode(t.dataset.hopen, false);
  else if (t.dataset.hrun) loadCode(t.dataset.hrun, true);
  else if (t.dataset.goto) setTab(t.dataset.goto);
  else if (t.dataset.harness != null) showHarness();
}
