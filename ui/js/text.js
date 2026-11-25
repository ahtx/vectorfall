import { $, $$, api, dropZone, empty, enc, esc, fail, fmt, icon, pane, toast, watchJob } from "./core.js";
import * as ch from "./charts.js";
import { menu } from "./hub.js";
import { reveal } from "./fold.js";
import { tLearn, tCompose } from "./textlab.js";

// TEXT ENGINE — one workspace:
//   left   corpus + the vocabulary filter (every view respects it: stopwords, web debris, N–M mentions, crossed-out words)
//   centre the tools (search, Markov, generate, embedding space, meaning, vocabulary, insights, transform)
//   right  the inspector for whichever word was clicked last (follows / precedes / similar meaning / contexts)
// Gestures: a checkbox or a token click crosses a word out (struck through, still listed — click again to bring it back);
// clicking a word's name, a graph node or a map point inspects it.

let C = null, B = null, F = null, tab = "ask", sel = "", libMode = false, addMode = false, fv = 0;
// Two rows: five groups, then the tabs of the open group. Tab keys stay the deep-link names (?tab=sources, ...);
// a group key (?tab=learn) opens the group at the tab used last. Arrow keys move along a row, Home/End to its ends.
const GROUPS = [["find", "Find", [["ask", "Ask"], ["search", "Search"], ["sources", "Sources"]]],
  ["write", "Write", [["markov", "Markov"], ["generate", "Generate"], ["compose", "Compose"]]],
  ["learn", "How it works", [["tokens", "Tokens"], ["next", "Next word"], ["sampling", "Sampling"], ["explain", "Embeddings"]]],
  ["meaning", "Meaning", [["embed", "Word map"], ["relations", "Relations"], ["meaning", "Meaning"]]],
  ["corpus", "Corpus", [["vocab", "Vocabulary"], ["insights", "Insights"], ["transform", "Transform"]]]];
const TABS = GROUPS.flatMap(([, , t]) => t);
const LAST = Object.fromEntries(GROUPS.map(([g, , t]) => [g, t[0][0]]));
const groupOf = (k) => (GROUPS.find(([, , t]) => t.some(([x]) => x === k)) || GROUPS[0])[0];
function resolveTab(k) {                       // a tab key or a group key -> a tab key
  if (TABS.some(([x]) => x === k)) return k;
  const g = GROUPS.find(([x]) => x === k);
  return g ? LAST[g[0]] : null;
}
const S = {
  wl: { q: "" }, mk: { view: "graph", n: 24 },
  gen: { model: "markov", seed: "", theme: "", order: 3, length: 120, temp: 1, lmTemp: 0.7, stop: "sentence", nofill: false, novelty: 0.5, lmModel: "hybrid", topics: 16, last: null },
  map: { n: 500, topics: 12, labels: true, data: null, view: { s: 1, tx: 0, ty: 0 }, hover: -1, focus: -1, prevTopics: null },
  vc: { q: "", sort: "freq", off: true },
  src: { mode: "trace", text: "", prompt: "", min: 6, n: 80, temp: 1, ctx: 40, last: null, sel: -1 },
  rel: { kind: "pairs", a: "do", b: "don't", c: "could", expr: "king - man + woman", words: "father mother sister table", last: null, test: null, space: null },
};
const topicColor = (t, a = 1) => t < 0 ? `rgba(140,140,150,${a})` : `hsla(${(t * 137.508 + 2) % 360},74%,60%,${a})`;
const offSet = () => new Set((F && F.filter.exclude) || []);
let inflight = {};
const latest = (key) => { const id = (inflight[key] || 0) + 1; inflight[key] = id; return () => inflight[key] === id; };

export default {
  id: "text", title: "Text Engine", sub: "gigabytes of text, instant answers", icon: "text",
  mount(el) {
    el.innerHTML = `<div class="ws side-lr te">
      <div class="col">
        <section class="pane fit" id="te-corpus"></section>
        <section class="pane grow" id="te-filter">
          <div class="pane-h"><div class="t">Vocabulary filter</div><div class="meta" id="tf-count"></div>
            <div class="tools"><button class="iconbtn" id="tf-reset" title="Reset the filter">${icon("undo")}</button></div></div>
          <div class="sec fields" id="tf-ctl">
            <div class="fld bool"><label for="tf-stop">Hide filler words <span class="dim">the, of, and…</span></label><label class="toggle"><input type="checkbox" id="tf-stop"><i></i></label></div>
            <div class="fld bool"><label for="tf-junk">Hide web &amp; markup debris <span class="dim">quot, https, ids…</span></label><label class="toggle"><input type="checkbox" id="tf-junk"><i></i></label></div>
            <div class="fld"><label for="tf-min">At least</label><input type="range" id="tf-min" min="0" max="100" step="1" value="0"><span class="v" id="tf-min-v">0</span></div>
            <div class="fld"><label for="tf-max">At most</label><input type="range" id="tf-max" min="0" max="100" step="1" value="100"><span class="v" id="tf-max-v">∞</span></div>
          </div>
          <div class="sec tf-find"><input class="in sm" id="tf-q" placeholder="Find a word… (untick to cross it out)" autocomplete="off"></div>
          <div class="pane-b flush" id="tf-list"></div>
          <div class="tf-ex" id="tf-ex"></div>
        </section>
      </div>
      <div class="col te-center">
        <section class="pane fit te-tabbar"><div class="pane-h"><div class="tabs" id="te-groups" role="tablist" aria-label="Text Engine groups">${GROUPS.map(([g, l]) => `<button role="tab" data-group="${g}">${l}</button>`).join("")}</div></div>
          <div class="pane-h te-subbar"><div class="seg" id="te-tabs" role="tablist" aria-label="Tabs"></div><div class="meta" id="te-tabmeta"></div><div class="tools" id="te-tabtools"></div></div></section>
        <div class="te-stage" id="te-stage"></div>
      </div>
      <section class="pane" id="te-insp"><div class="pane-h"><div class="t">Inspector</div><div class="meta" id="ti-meta"></div><div class="tools" id="ti-tools"></div></div>
        <div class="pane-b" id="ti-body">${empty("Click any word — in a list, the graph or the map — to see what follows it, what it means here, and where it appears.")}</div></section>
    </div>`;
    $$("#te-groups [data-group]").forEach((b) => b.onclick = () => { libMode = false; tab = LAST[b.dataset.group]; renderStage(); });
    const arrows = (row, attr) => row.addEventListener("keydown", (e) => {
      const bs = $$(`[data-${attr}]`, row), i = bs.indexOf(document.activeElement);
      const j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: bs.length - 1 }[e.key];
      if (i < 0 || j == null) return;
      e.preventDefault();
      const v = bs[(j + bs.length) % bs.length].dataset[attr];
      bs[(j + bs.length) % bs.length].click();
      const nb = $(`[data-${attr}="${v}"]`, row); if (nb) nb.focus();
    });
    arrows($("#te-groups"), "group"); arrows($("#te-tabs"), "tab");
    $("#tf-stop").onchange = () => setFilter({ stop: $("#tf-stop").checked });
    $("#tf-junk").onchange = () => setFilter({ junk: $("#tf-junk").checked });
    const rng = (id, inf) => { const e = $(id); e.oninput = () => { $(id + "-v").textContent = fmtCount(sliderToCount(+e.value), inf); }; e.onchange = () => setFilter({ min: sliderToCount(+$("#tf-min").value), max: +$("#tf-max").value >= 100 ? 0 : sliderToCount(+$("#tf-max").value) }); };
    rng("#tf-min", false); rng("#tf-max", true);
    $("#tf-reset").onclick = () => setFilter({ exclude: [], stop: true, junk: true, min: 0, max: 0 });
    $("#tf-q").oninput = () => { clearTimeout(S.wl.t); S.wl.t = setTimeout(() => { S.wl.q = $("#tf-q").value.trim(); loadWordList(); }, 160); };
    window.addEventListener("resize", () => { if (document.querySelector("#view-text.on")) onResize(); });
    refresh();
  },
  show(p = {}) {
    const pt = p.tab === "learn" && p.view ? p.view : p.tab;   // ?tab=learn&view=sampling also works
    if (pt && resolveTab(pt)) { tab = resolveTab(pt); libMode = false; }
    // Text.Trace / Text.Continue hand in the words; run as soon as the Sources tab is on screen
    const g = S.src, run = p.trace != null || p.cont != null;
    if (p.trace != null) { g.mode = "trace"; g.text = p.trace; }
    if (p.cont != null) { g.mode = "continue"; g.prompt = p.cont; }
    if (run) { g.last = null; g.sel = -1; }
    refresh().then(async () => {
      if (!run || !C) return;
      for (let i = 0; i < 40 && !$("#ts-go"); i++) await new Promise((r) => setTimeout(r, 75));
      if ($("#ts-go")) { tSources(); runSources(); }
    });
  },
};

// ---------------------------------------------------------------- state & filter
async function refresh() {
  try { const a = await api.get("/text/active"); C = a.loaded ? a : null; B = a.loaded ? null : (a.blank || null); } catch (e) { C = null; B = null; }
  if (B) { libMode = true; addMode = true; }
  renderCorpus();
  if (C) { try { F = await api.get("/text/filter"); } catch (e) { F = null; } renderFilter(); loadWordList(); }
  else { $("#tf-list").innerHTML = ""; $("#tf-count").textContent = ""; $("#tf-ex").innerHTML = ""; }
  renderStage();
}
async function setFilter(patch) {
  try { F = await api.post("/text/filter", patch); onFilter(); } catch (e) { fail(e); }
}
async function setOff(word, off) {
  try { F = await api.post("/text/filter/toggle", { word, off }); onFilter(word, off); } catch (e) { fail(e); }
}
function onFilter() {
  fv++; renderFilter(); loadWordList(); refreshTab(); if (sel) inspect(sel, true);
}
const sliderToCount = (s) => { const mx = Math.max(10, (F && F.max_count) || 1000); return s <= 0 ? 0 : Math.max(1, Math.round(Math.exp(s / 100 * Math.log(mx)))); };
const countToSlider = (c) => { const mx = Math.max(10, (F && F.max_count) || 1000); return c <= 0 ? 0 : Math.round(Math.log(c) / Math.log(mx) * 100); };
const fmtCount = (c, inf) => (inf && !c) ? "∞" : fmt.big(c);
function renderFilter() {
  if (!F) return;
  const f = F.filter;
  $("#tf-stop").checked = f.stop; $("#tf-junk").checked = f.junk;
  $("#tf-min").value = countToSlider(f.min); $("#tf-min-v").textContent = fmtCount(f.min, false);
  $("#tf-max").value = f.max ? countToSlider(f.max) : 100; $("#tf-max-v").textContent = fmtCount(f.max, true);
  $("#tf-count").innerHTML = `${fmt.n(F.allowed)} / ${fmt.n(F.words)} words`;
  const ex = f.exclude;
  $("#tf-ex").innerHTML = ex.length ? `<div class="sec-t">Crossed out <span class="dim">${ex.length}</span><a class="x" href="#" id="tf-clear">bring all back</a></div>
    <div class="toks">${ex.map((w) => `<span class="tok off" data-on="${esc(w)}" title="click to bring back">${esc(w)}</span>`).join("")}</div>` : "";
  $$("#tf-ex [data-on]").forEach((t) => t.onclick = () => setOff(t.dataset.on, false));
  const cl = $("#tf-clear"); if (cl) cl.onclick = (e) => { e.preventDefault(); setFilter({ exclude: [] }); };
}
async function loadWordList() {
  if (!C) return;
  const ok = latest("wl");
  try {
    const r = await api.get(`/text/vocab/analysis?contains=${enc(S.wl.q)}&top=300&show_off=1`);
    if (!ok()) return;
    const mx = r.items.reduce((m, x) => Math.max(m, x.c), 1);
    $("#tf-list").innerHTML = r.items.length ? r.items.map((it) => `<div class="wl ${it.off ? "off" : ""}" data-w="${esc(it.w)}">
      <input type="checkbox" ${it.off ? "" : "checked"} title="${it.off ? "bring back" : "cross out"}"><span class="w">${esc(it.w)}</span><i style="width:${(Math.log(it.c + 1) / Math.log(mx + 1) * 100).toFixed(1)}%"></i><b>${fmt.big(it.c)}</b></div>`).join("")
      : empty(S.wl.q ? "No words match." : "Nothing passes the filter.");
    $$("#tf-list .wl").forEach((row) => {
      row.querySelector("input").onchange = (e) => setOff(row.dataset.w, !e.target.checked);
      row.querySelector(".w").onclick = () => inspect(row.dataset.w);
    });
  } catch (e) { $("#tf-list").innerHTML = empty(esc(e.message)); }
}

// ---------------------------------------------------------------- corpus pane & library
// the corpus name is a switcher: every stored corpus, a new blank one, add text, the library
async function corpusMenu(anchor) {
  let list = [];
  try { list = await api.get("/text/corpora"); } catch (e) { fail(e); return; }
  const cur = C ? C.id : B ? B.id : null;
  menu(anchor, [
    ...list.slice(0, 14).map((c) => ({ icon: c.id === cur ? "eye" : "text", label: (c.id === cur ? "✓ " : "") + (c.name || "untitled"),
      sub: c.bytes ? `${fmt.bytes(c.bytes)} · ${c.docs} doc${c.docs === 1 ? "" : "s"}` : "empty — add text",
      run: () => { if (c.id !== cur) runJob(api.post(`/text/corpora/${c.id}/activate`), "Loading onto the card"); } })),
    ...(list.length > 14 ? [{ icon: "text", label: `All ${list.length} corpora…`, sub: "open the library", run: () => { libMode = true; addMode = false; renderStage(); } }] : []),
    "-",
    { icon: "plus", label: "New blank corpus…", sub: "an empty corpus to add text into", run: newBlank },
    ...(cur ? [{ icon: "upload", label: "Add text to this corpus…", sub: "files, paste or a URL — undoable", run: () => { libMode = true; addMode = true; renderStage(); } }] : []),
    { icon: "upload", label: "Library…", sub: "load new text, Gutenberg bundles", run: () => { libMode = true; addMode = false; renderStage(); } },
  ]);
}
async function newBlank() {
  const name = prompt("Name for the new corpus", "Untitled corpus");
  if (name == null) return;
  try { await api.post("/text/corpora/blank", { name: name.trim() || "Untitled corpus" }); S.map.data = null; S.gen.last = null; libMode = true; addMode = true; await refresh(); toast(`You selected “${name}”. Add text to fill it.`, "good"); }
  catch (e) { fail(e); }
}
function renderCorpus() {
  const el = $("#te-corpus");
  const pick = (nm) => `<button class="meta te-cpick" id="tc-pick" title="Switch corpus, start a blank one, or add text">${esc(nm)} <span class="caret">▾</span></button>`;
  if (!C && B) {
    el.innerHTML = `<div class="pane-h"><div class="t">Corpus</div>${pick(B.name || "Untitled corpus")}</div>
      <div class="pane-b">${empty("Empty corpus. Drop files, paste text or fetch a URL to fill it.")}<button class="btn sm block" id="tc-add">${icon("upload")} Add text</button></div>`;
    $("#tc-pick").onclick = (e) => corpusMenu(e.currentTarget);
    $("#tc-add").onclick = () => { libMode = true; addMode = true; renderStage(); };
    return;
  }
  if (!C) { el.innerHTML = `<div class="pane-h"><div class="t">Corpus</div>${pick("none loaded")}</div><div class="pane-b">${empty("No text loaded — pick or drop some in the library.")}</div>`; $("#tc-pick").onclick = (e) => corpusMenu(e.currentTarget); return; }
  el.innerHTML = `<div class="pane-h"><div class="t">Corpus</div>${pick(C.name)}
      <div class="tools"><button class="iconbtn" id="tc-lib" title="Library — load or switch text">${icon("upload")}</button><a class="iconbtn" href="/api/text/download" download title="Download current version">${icon("down")}</a></div></div>
    <div class="sec"><div class="kv">
      <span>Words</span><b>${fmt.n(C.words)}</b><span>Unique</span><b>${fmt.n(C.unique_words)}</b>
      <span>Documents</span><b>${fmt.n(C.docs.length)}</b><span>On the card</span><b>${fmt.bytes(C.bytes)} → ${fmt.n(C.on_card_mb)} MB · ${C.compression}×</b>
      <span>Version</span><b>v${C.version}${C.recipe.length ? ` · ${C.recipe.length} edit${C.recipe.length > 1 ? "s" : ""}` : ""}</b></div>
      <div class="tb" style="margin-top:10px"><button class="btn sm" id="tc-clean" title="Decode entities. Remove tags, scripts, URLs, ids and JSON structure. Keep the prose. This makes a new version that you can undo.">${icon("spark")} Clean web markup</button>
      ${C.version ? `<button class="btn ghost sm" id="tc-undo">${icon("undo")} Undo edit</button>` : ""}</div></div>`;
  $("#tc-lib").onclick = () => { libMode = true; addMode = false; renderStage(); };
  $("#tc-pick").onclick = (e) => corpusMenu(e.currentTarget);
  $("#tc-clean").onclick = () => runJob(api.post("/text/transform", { op: "clean", params: {} }), "Cleaning web markup");
  const u = $("#tc-undo"); if (u) u.onclick = () => runJob(api.post("/text/undo"), "Undo the last edit");
}
async function runJob(p, label) {
  const bar = jobBar(label);
  try {
    const job = await p;
    await watchJob(job, (j) => bar.update(j.message, j.progress));
    bar.done(); S.map.data = null; S.gen.last = null; S.rel.space = null;
    await refresh();
    return true;
  } catch (e) { bar.done(); fail(e); return false; }
}
function jobBar(label) {
  const t = document.createElement("div"); t.className = "toast"; t.style.minWidth = "320px";
  t.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${esc(label)}</div><div style="height:4px;background:rgba(255,255,255,.12);border-radius:3px"><i style="display:block;height:100%;width:4%;background:var(--rosso-hi);border-radius:3px;transition:width .4s"></i></div><div class="dim mono" style="font-size:11px;margin-top:5px">starting…</div>`;
  document.body.appendChild(t);
  return { update: (m, p) => { t.querySelector("i").style.width = Math.max(4, (p || 0) * 100) + "%"; t.querySelector(".mono").textContent = m || ""; }, done: () => t.remove() };
}
async function renderLibrary() {
  const target = C || B;                                  // the selected corpus, if any (B = blank, not on the card)
  if (!target) addMode = false;
  const into = addMode && target;
  const modeSeg = target ? `<div class="seg" id="tl-mode"><button data-m="new" class="${into ? "" : "on"}">New corpus</button><button data-m="add" class="${into ? "on" : ""}" title="Append to ${esc(target.name || "")} as a new version you can undo">Add to ${esc(target.name || "this corpus")}</button></div>` : "";
  stage("lib", pane({ t: into ? `Add text to ${esc(target.name || "")}` : "Load text", tools: modeSeg, body: `<div class="drop" id="tl-drop"><b>Drop files or a folder</b><br><span class="hint">PDF · DOCX · PPTX · XLSX · EPUB · TXT · MD · HTML · ZIP · GZ${into ? " · added to the selected corpus" : ""}</span></div>
      <div class="tb" style="margin-top:10px"><input class="in sm" id="tl-url" placeholder="…or a URL" style="flex:1"><button class="btn sm" id="tl-url-go">Fetch</button></div>
      <textarea class="in" id="tl-paste" rows="5" placeholder="…or paste text here" style="margin-top:10px"></textarea><button class="btn ghost sm block" id="tl-paste-go" style="margin-top:6px">Index pasted text</button>` })
    + pane({ t: "Instant corpora", meta: "Project Gutenberg", bcls: "flush", bid: "tl-bundles" })
    + pane({ t: "Your corpora", bcls: "flush", bid: "tl-recent", tools: C ? `<button class="btn ghost xs" id="tl-back">Back to ${esc(C.name)}</button>` : "" }));
  $$("#tl-mode [data-m]").forEach((b) => b.onclick = () => { addMode = b.dataset.m === "add"; renderLibrary(); });
  const done = (ok) => { if (ok) { addMode = false; libMode = false; renderStage(); } };
  dropZone($("#tl-drop"), async (files) => { const fd = new FormData(); for (const f of files) fd.append("files", f);
    if (into) { runJob(api.post("/text/corpora/add", fd), `Add ${files.length} file(s) to ${target.name || "the corpus"}`).then(done); return; }
    runJob(api.post("/text/corpora", fd), `Index ${files.length} file(s)`); });
  $("#tl-url-go").onclick = () => { const u = $("#tl-url").value.trim(); if (!u) return;
    runJob(api.post(into ? "/text/corpora/add" : "/text/corpora/url", { url: u }), into ? "Fetching & adding" : "Fetching & indexing").then(into ? done : null); };
  $("#tl-paste-go").onclick = () => { const t = $("#tl-paste").value; if (!t.trim()) return;
    runJob(api.post(into ? "/text/corpora/add" : "/text/corpora/paste", { text: t }), into ? "Adding" : "Indexing").then(into ? done : null); };
  if (into) $("#tl-paste-go").textContent = "Add pasted text";
  const back = $("#tl-back"); if (back) back.onclick = () => { libMode = false; renderStage(); };
  const [bundles, list] = await Promise.all([api.get("/text/bundles").catch(() => []), api.get("/text/corpora").catch(() => [])]);
  if (!$("#tl-bundles")) return;                          // the view moved on while the lists loaded
  $("#tl-bundles").innerHTML = `<div class="list">${bundles.map((b) => `<div class="li" data-bundle="${b.id}"><div class="tx"><div class="nm">${esc(b.name)}</div><div class="sub">${b.books} book${b.books > 1 ? "s" : ""}</div></div></div>`).join("")}</div>`;
  $$("#tl-bundles [data-bundle]").forEach((b) => b.onclick = () => runJob(api.post("/text/corpora/gutenberg", { bundle: b.dataset.bundle }), "Downloading & indexing"));
  $("#tl-recent").innerHTML = list.length ? `<div class="list">${list.map((c) => `<div class="li ${C && C.id === c.id ? "on" : ""}" data-open="${c.id}"><div class="tx"><div class="nm">${esc(c.name || "untitled")}</div><div class="sub">${c.index ? fmt.bytes(c.bytes) : "not indexed"}</div></div><button class="iconbtn" data-del="${c.id}" title="Delete">${icon("trash")}</button></div>`).join("")}</div>` : empty("Nothing yet.");
  $$("#tl-recent [data-open]").forEach((b) => b.onclick = () => runJob(api.post(`/text/corpora/${b.dataset.open}/activate`), "Loading onto the card"));
  $$("#tl-recent [data-del]").forEach((b) => b.onclick = async (e) => { e.stopPropagation(); if (!confirm("Delete this corpus?")) return; await api.del("/text/corpora/" + b.dataset.del); refresh(); });
}

// ---------------------------------------------------------------- stage
const LAB = { stage: (l, h) => stage(l, h), tabTools: (m, t) => tabTools(m, t), goTab: (k) => { tab = resolveTab(k) || tab; renderStage(); } };
function stage(layout, html) { const s = $("#te-stage"); s.className = "te-stage L-" + layout; s.innerHTML = html; }
function tabTools(meta = "", tools = "") { $("#te-tabmeta").innerHTML = meta; $("#te-tabtools").innerHTML = tools; }
function renderStage() {
  const g = groupOf(tab), sub = GROUPS.find(([x]) => x === g)[2];
  LAST[g] = tab;
  $$("#te-groups [data-group]").forEach((b) => { const on = !libMode && b.dataset.group === g; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); b.tabIndex = b.dataset.group === g ? 0 : -1; });
  $("#te-tabs").innerHTML = sub.map(([k, l]) => `<button role="tab" data-tab="${k}" class="${!libMode && k === tab ? "on" : ""}" aria-selected="${!libMode && k === tab}" tabindex="${k === tab ? 0 : -1}">${l}</button>`).join("");
  $$("#te-tabs [data-tab]").forEach((b) => b.onclick = () => { libMode = false; tab = b.dataset.tab; renderStage(); });
  tabTools();
  if (libMode || !C) { libMode = !C || libMode; renderLibrary(); return; }
  ({ ask: tAsk, search: tSearch, sources: tSources, markov: tMarkov, generate: tGenerate, tokens: () => tLearn(LAB, "tokens"), next: () => tLearn(LAB, "next"), sampling: () => tLearn(LAB, "sampling"), explain: () => tLearn(LAB, "embed"), compose: () => tCompose(LAB), embed: tEmbed, relations: tRelations, meaning: tMeaning, vocab: tVocab, insights: tInsights, transform: tTransform }[tab])();
}
function refreshTab() {
  if (libMode || !C) return;
  if (tab === "embed") { clearTimeout(S.map.t); S.map.t = setTimeout(() => loadMap(true), 700); return; }
  if (tab === "generate") { S.map.data = null; const n = $("#tg-note"); if (n) n.textContent = "filter changed — generate again to use it"; loadGenMap(); return; }
  if (["markov", "meaning", "vocab", "insights"].includes(tab)) renderStage();
}
function onResize() {
  if (tab === "embed" && S.map.data) drawMap();
  if (tab === "generate") drawGenMap();
  if (tab === "markov" && S.mk.data && S.mk.view === "graph") drawGraph(S.mk.data);
}

// ---- SEARCH -----------------------------------------------------------
// ---------------------------------------------------------------- Ask your documents
// the VectorLM prototype warning (the same text as app/vectorlm.py WARNING); style .vq-warn is in css/app-vlm.css
const VLM_WARN = "VectorLM is a prototype that is under development. It is not a complete LLM. Do not use it for serious work. The text that it makes is often poor, and its answers are often wrong. Use it as a lab tool, not as a working LLM.";
const VLM_BADGE = `<span class="vq-warn" tabindex="0" title="${VLM_WARN}" aria-label="${VLM_WARN}"><b>!</b> Prototype</span>`;
const ASK_EX = ["Who is Mr. Darcy?", "What happened to the Texas power grid in the winter storm?", "What do the essays say about drone swarms?"];
const STOP = new Set("a an the of to in on at for and or is are was were be what who how why when where which do does did say said about this that these those with by from it its as into than then there their they he she we you i".split(" "));
const qterms = (q) => (q.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) || []).filter((w) => !STOP.has(w) && w.length > 1);
const isQuote = (q) => /^["“'‘]/.test(q.trim()) || q.trim().split(/\s+/).length >= 12;
function bestSentence(text, terms) {
  const ss = text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z0-9“"])/).filter((x) => x.length > 30);
  let best = ss[0] || text, bs = -1;
  for (const x of ss) { const lx = x.toLowerCase(); const sc = terms.reduce((a, t) => a + (lx.includes(t) ? 1 : 0), 0) + (/\b(is|was|means|describes?|called)\b/.test(lx) ? 0.5 : 0); if (sc > bs) { bs = sc; best = x; } }
  return best.trim();
}
function mark(text, terms) {
  let h = esc(String(text).replace(/[ \t\r]+/g, " "));
  for (const t of terms) h = h.replace(new RegExp(`\\b(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>");
  return h;
}
// ---- READER: every find opens its document at the place it was found ----------------------------------------
const RD = { a: 0, b: 0, start: 0, end: 0, doc: "", list: null, i: -1, terms: [] };
export function openReader(at, end, opts = {}) {
  RD.list = opts.list || null; RD.i = opts.i ?? -1; RD.terms = opts.terms || []; RD.focus = opts.focus || "";
  let box = $("#te-reader");
  if (!box) {
    document.body.insertAdjacentHTML("beforeend", `<div class="te-reader" id="te-reader" role="dialog" aria-label="Document"><div class="rd-h">
      <div class="rd-t"><div class="nm" id="rd-doc">—</div><div class="dim" id="rd-pos"></div></div>
      <div class="rd-tools"><button class="btn ghost xs" id="rd-prev" title="The previous result (←)">‹ Prev</button><span class="mono dim" id="rd-n"></span><button class="btn ghost xs" id="rd-next" title="The next result (→)">Next ›</button>
      <button class="btn ghost xs" id="rd-cite" title="Copy the marked text with its document">Copy citation</button><button class="iconbtn" id="rd-x" title="Close (Esc)">${icon("x")}</button></div></div>
      <div class="rd-b" id="rd-b"></div></div>`);
    box = $("#te-reader");
    $("#rd-x").onclick = closeReader;
    $("#rd-prev").onclick = () => step(-1); $("#rd-next").onclick = () => step(1);
    $("#rd-cite").onclick = () => { const m = $("#rd-hit"); if (m) cite(m.textContent, RD.doc); };
    document.addEventListener("keydown", (e) => {
      if (!$("#te-reader") || $("#te-reader").hidden) return;
      if (e.key === "Escape") { e.stopPropagation(); closeReader(); }
      else if (!/INPUT|TEXTAREA/.test(document.activeElement?.tagName || "") && (e.key === "ArrowRight" || e.key === "ArrowLeft")) step(e.key === "ArrowRight" ? 1 : -1);
    });
  }
  box.hidden = false;
  load(at, end);
}
function closeReader() { const b = $("#te-reader"); if (b) b.hidden = true; }
function step(d) {
  if (!RD.list || !RD.list.length) return;
  RD.i = (RD.i + d + RD.list.length) % RD.list.length;
  const h = RD.list[RD.i]; load(h.byte, h.end);
}
async function load(at, end) {
  const body = $("#rd-b"); body.innerHTML = '<div class="hint">opening the document…</div>';
  const n = RD.list && RD.list.length > 1;
  $("#rd-prev").style.display = $("#rd-next").style.display = n ? "" : "none"; $("#rd-n").textContent = n ? `${RD.i + 1} of ${RD.list.length}` : "";
  try {
    const r = await api.get(`/text/read?at=${at}&hl=${Math.max(0, (end || at) - at)}`);
    Object.assign(RD, { a: r.a, b: r.b, start: r.doc_start, end: r.doc_end, doc: r.doc || C.name || "the corpus" });
    $("#rd-doc").textContent = RD.doc;
    $("#rd-pos").textContent = `${Math.round(r.pct * 100)}% of the way through · ${fmt.bytes(r.doc_bytes)}`;
    body.innerHTML = `<button class="btn ghost xs rd-more" id="rd-up" ${r.a <= r.doc_start ? "hidden" : ""}>Earlier text</button>
      <div class="rd-text" id="rd-text">${para(r.pre)}${hitHtml(r.match)}${para(r.post)}</div>
      <button class="btn ghost xs rd-more" id="rd-down" ${r.b >= r.doc_end ? "hidden" : ""}>Later text</button>
      ${r.a <= r.doc_start ? "" : ""}${r.b >= r.doc_end ? '<div class="dim rd-end">end of the document</div>' : ""}`;
    const hit = $("#rd-hit"); if (hit) hit.scrollIntoView({ block: "center" });
    $("#rd-up").onclick = () => more(-1); $("#rd-down").onclick = () => more(1);
  } catch (e) { body.innerHTML = empty(esc(e.message)); }
}
async function more(dir) {
  const r = await api.get(dir < 0 ? `/text/read?at=${RD.a}&before=8000&after=0` : `/text/read?at=${RD.b}&before=0&after=8000`);
  const t = $("#rd-text"), b = $("#rd-b");
  if (dir < 0) { const h0 = b.scrollHeight; RD.a = r.a; t.insertAdjacentHTML("afterbegin", para(r.pre)); b.scrollTop += b.scrollHeight - h0; $("#rd-up").hidden = r.a <= RD.start; }
  else { RD.b = r.b; t.insertAdjacentHTML("beforeend", para(r.post)); $("#rd-down").hidden = r.b >= RD.end; }
}
function hitHtml(m) {            // a passage: shade it, and mark its best sentence as the hit
  const f = RD.focus && RD.focus.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  const k = f ? m.search(new RegExp(f)) : -1;
  if (k < 0) return `<mark id="rd-hit">${esc(m)}</mark>`;
  const L = m.slice(k).match(new RegExp(f))[0].length;
  return `<span class="rd-pass">${para(m.slice(0, k))}<mark id="rd-hit">${esc(m.slice(k, k + L))}</mark>${para(m.slice(k + L))}</span>`;
}
function para(s) { return mark(s, RD.terms).replace(/\n{2,}/g, "<br><br>"); }
function openBtn(byte, end, label = "Open in document", focus = "") { return byte == null ? "" : `<button class="btn ghost xs rd-open" data-at="${byte}" data-end="${end ?? byte}"${focus ? ` data-focus="${esc(focus)}"` : ""}>${icon("text")} ${label}</button>`; }
function bindOpen(root, terms) { $$(".rd-open", root).forEach((b) => b.onclick = (e) => { e.stopPropagation(); openReader(+b.dataset.at, +b.dataset.end, { terms, focus: b.dataset.focus || "" }); }); }
function cite(text, doc) { const c = `“${text.replace(/\s+/g, " ").trim()}” — ${doc}`; navigator.clipboard.writeText(c).then(() => toast("Citation copied")).catch(() => toast(c)); }
function tAsk() {
  stage("one", `<section class="pane"><div class="pane-h te-searchh"><input class="in" id="ak-q" placeholder="Ask a question about ${esc(C.name || "these documents")}, or paste a quote to find where it came from…" autocomplete="off">
      <button class="btn sm" id="ak-go">Ask</button><div class="meta" id="ak-stat"></div></div>
    <div class="pane-b" id="ak-out"><div class="ak-start"><p class="hint">Answers come from the documents in <b>${esc(C.name || "this corpus")}</b>, with the passage and its document. Paste 12 or more words (or text in quotes) to find where a quote came from.</p>
      <div class="chips">${ASK_EX.map((x) => `<button class="chip ak-ex">${esc(x)}</button>`).join("")}<button class="chip ak-ex" data-q="“It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife”">Where is this quote from?</button></div></div></div></section>`);
  const q = $("#ak-q"); q.focus();
  const run = () => ask(q.value.trim());
  $("#ak-go").onclick = run; q.onkeydown = (e) => { if (e.key === "Enter") run(); };
  $$("#ak-out .ak-ex").forEach((b) => b.onclick = () => { q.value = b.dataset.q || b.textContent; run(); });
}
async function ask(text) {
  const out = $("#ak-out"); if (!text || !out) return;
  const ok = latest("ak"), t0 = performance.now();
  out.innerHTML = `<div class="hint">the card reads ${fmt.big(C.words)} words…</div>`;
  try {
    if (isQuote(text)) {
      const body = text.replace(/^["“'‘]|["”'’]$/g, "");
      const r = await api.post("/text/sources/trace", { text: body, min_words: 6 });
      if (!ok()) return;
      const seg = (r.segments || []).filter((g) => g.count > 0);
      const words = body.split(/\s+/).length, copied = seg.reduce((a, g) => a + g.words, 0);
      if (!seg.length) { out.innerHTML = `<div class="ak-ans"><b>No stretch of 6 or more words of this text is in the documents.</b><p class="hint">So it was not copied from them word for word. The closest passages follow.</p></div>`; return askPassages(text, out, ok, true); }
      const docs = {}; seg.forEach((g) => (g.docs || []).forEach(([d, n]) => { docs[d] = (docs[d] || 0) + g.words; }));
      const main = Object.entries(docs).sort((a, b) => b[1] - a[1]);
      out.innerHTML = `<div class="ak-ans"><div class="ak-lead">${Math.round(100 * Math.min(1, copied / words))}% of this text comes from <b>${esc(main[0][0])}</b>${main.length > 1 ? ` (and ${main.length - 1} other document${main.length > 2 ? "s" : ""})` : ""}.</div>
        ${seg.map((g) => `<div class="ak-pass"><div class="ak-doc">${esc(((g.docs || [])[0] || ["?"])[0])} · ${g.words} words${g.count > 1 ? ` · ${g.count} places` : ""}</div>
          <p>${g.context ? `<span class="dim">…${esc(g.context.left.slice(-160))}</span><mark>${esc(g.context.match)}</mark><span class="dim">${esc(g.context.right.slice(0, 160))}…</span>` : esc(g.t)}</p>
          <div class="ak-acts">${g.context ? openBtn(g.context.byte, g.context.end) : ""}<button class="btn ghost xs ak-cite" data-t="${esc(g.t)}" data-d="${esc(((g.docs || [])[0] || ["?"])[0])}">Copy citation</button>
          ${(g.docs || []).length > 1 ? `<span class="dim">also in</span> ${(g.docs || []).slice(1, 5).map(([d]) => g.at && g.at[d] ? `<button class="btn ghost xs rd-open" data-at="${g.at[d][0]}" data-end="${g.at[d][1]}">${esc(d)}</button>` : `<span class="dim">${esc(d)}</span>`).join(" ")}` : ""}</div></div>`).join("")}</div>`;
      $("#ak-stat").textContent = `traced in ${fmt.ms(performance.now() - t0)}`;
    } else {
      await askPassages(text, out, ok, false);
      $("#ak-stat").textContent = `answered in ${fmt.ms(performance.now() - t0)}`;
    }
    $$("#ak-out .ak-cite").forEach((b) => b.onclick = () => cite(b.dataset.t, b.dataset.d));
    bindOpen(out, qterms(text));
  } catch (e) { if (ok()) out.innerHTML = `<div class="hint">${esc(e.message)}</div>`; }
}
async function askPassages(text, out, ok, append) {
  const r = await api.get(`/text/retrieve?q=${enc(text)}&top=6`);
  if (!ok()) return;
  const ps = r.passages || [], terms = qterms(text);
  const html = !ps.length ? `<div class="ak-ans"><b>Nothing in the documents matches “${esc(text)}”.</b><p class="hint">Try other words, or add documents in the Library.</p></div>`
    : (append ? "" : `<div class="ak-ans"><div class="ak-lead">${mark(bestSentence(ps[0].text, terms), terms)}</div><div class="ak-doc">— ${esc(ps[0].doc)} ${openBtn(ps[0].byte, ps[0].end, "Open in document", bestSentence(ps[0].text, terms))}</div>
        <p class="hint">${ps[0].score < 2 ? "A weak match: the words of the question are rare in these documents. Read the passages to judge." : "The best-matching sentence of the best passage. The passages follow."}</p></div>`)
      + ps.map((x, i) => `<div class="ak-pass"><div class="ak-doc">${i + 1}. ${esc(x.doc)} <span class="dim">· match ${x.score.toFixed(1)}</span></div><p>${mark(x.text.slice(0, 900), terms)}${x.text.length > 900 ? "…" : ""}</p>
        <div class="ak-acts">${openBtn(x.byte, x.end, "Open in document", bestSentence(x.text, terms))}<button class="btn ghost xs ak-cite" data-t="${esc(bestSentence(x.text, terms))}" data-d="${esc(x.doc)}">Copy citation</button></div></div>`).join("");
  out.insertAdjacentHTML(append ? "beforeend" : "afterbegin", "");
  if (append) out.insertAdjacentHTML("beforeend", html); else out.innerHTML = html;
  $$("#ak-out .ak-cite").forEach((b) => b.onclick = () => cite(b.dataset.t, b.dataset.d));
  bindOpen(out, terms);
}

function tSearch() {
  stage("one", `<section class="pane"><div class="pane-h te-searchh"><input class="in" id="se-q" placeholder="Search ${fmt.big(C.words)} words — a word, a name, a phrase…" autocomplete="off">
      <label class="toggle" title="Match case"><input type="checkbox" id="se-case"><i></i>Aa</label><div class="meta" id="se-stat"></div></div>
    <div class="pane-b" id="se-out">${empty("Every match, found by a scan of the whole text on the card.")}</div><div class="pane-f" id="se-f">&nbsp;</div></section>`);
  const q = $("#se-q"); q.focus();
  let offset = 0;
  const run = async (more) => {
    const text = q.value.trim(); if (!text) { $("#se-out").innerHTML = empty("Every match, found by a scan of the whole text on the card."); $("#se-stat").textContent = ""; return; }
    if (!more) offset = 0;
    const ok = latest("se");
    try {
      const r = await api.get(`/text/search?q=${enc(text)}&case=${$("#se-case").checked ? 1 : 0}&limit=60&offset=${offset}`);
      if (!ok()) return;
      $("#se-stat").innerHTML = `${fmt.n(r.count)} matches · ${r.per_million}/M`;
      if (!r.count && text.split(/\s+/).length >= 4) {             // a question typed into Search: show the closest passages
        const o = $("#se-out"); o.innerHTML = `<div class="hint">No exact phrase. The closest passages:</div>`;
        const box = document.createElement("div"); box.id = "ak-out"; o.appendChild(box);
        await askPassages(text, box, ok, true); return;
      }
      $("#se-f").innerHTML = `<span><b>${fmt.n(r.count)}</b> matches</span><span>${Math.min(r.count, offset + r.hits.length)} shown</span><span class="timing">${fmt.ms(r.gpu_ms)}</span>`;
      S.hits = more ? (S.hits || []).concat(r.hits) : r.hits.slice();
      const base = more ? S.hits.length - r.hits.length : 0;
      const rows = r.hits.map((h, k) => `<div class="hit" data-m="${esc(h.match)}" data-k="${base + k}" title="Click to read it in its document"><div class="l"><span>${esc(h.left)}</span></div><div class="m">${esc(h.match)}</div><div class="r">${esc(h.right)}</div>${h.doc ? `<div class="d">${esc(h.doc)}</div>` : ""}</div>`).join("");
      const head = r.unknown.length ? `<div class="hint" style="color:var(--warn);margin-bottom:6px">not in this text: ${r.unknown.map(esc).join(", ")}</div>` : "";
      if (more) $("#se-hits").insertAdjacentHTML("beforeend", rows);
      else $("#se-out").innerHTML = `${head}<div id="se-hits" class="hits">${rows || empty("No matches.")}</div>`;
      const old = $("#se-more"); if (old) old.remove();
      if (r.count > offset + 60) { $("#se-out").insertAdjacentHTML("beforeend", '<button class="btn ghost sm" id="se-more" style="margin:10px auto;display:flex">Show more</button>'); $("#se-more").onclick = () => { offset += 60; run(true); }; }
      $$("#se-hits .hit .m").forEach((m) => m.onclick = (e) => { e.stopPropagation(); inspect(m.textContent.split(/\s+/)[0]); });
      $$("#se-hits .hit").forEach((el) => el.onclick = () => { const k = +el.dataset.k, h = S.hits[k]; openReader(h.byte, h.end, { list: S.hits, i: k, terms: qterms(text) }); });
    } catch (e) { $("#se-out").innerHTML = empty(esc(e.message)); }
  };
  q.oninput = () => { clearTimeout(q._t); q._t = setTimeout(() => run(), 150); };
  $("#se-case").onchange = () => run();
}

// ---- MARKOV -----------------------------------------------------------
async function tMarkov() {
  stage("21", `<section class="pane" id="mk-p"><div class="pane-h"><div class="t">Word transitions</div><div class="meta">top content words · counted on the card</div>
      <div class="tools"><select class="sel sm" id="mk-n">${[12, 16, 24, 32, 40].map((n) => `<option ${n === S.mk.n ? "selected" : ""}>${n}</option>`).join("")}</select>
      <div class="seg" id="mk-view"><button data-v="graph">Graph</button><button data-v="table">Table</button></div></div></div>
      <div class="pane-b" id="mk-body"><div class="skeleton" style="height:100%"></div></div><div class="pane-f" id="mk-f">&nbsp;</div></section>`
    + `<section class="pane"><div class="pane-h"><div class="t">Strongest pairs</div><div class="meta">click a pair to inspect</div></div><div class="pane-b" id="mk-pairs"><div class="skeleton"></div></div><div class="pane-f" id="mk-pf">&nbsp;</div></section>`);
  $$("#mk-view [data-v]").forEach((b) => { b.classList.toggle("on", b.dataset.v === S.mk.view); b.onclick = () => { S.mk.view = b.dataset.v; tMarkov(); }; });
  $("#mk-n").onchange = (e) => { S.mk.n = +e.target.value; tMarkov(); };
  const ok = latest("mk");
  try {
    if (S.mk.view === "graph") {
      const p = await api.get(`/text/pairs?n=${S.mk.n}`); if (!ok()) return;
      S.mk.data = p; drawGraph(p);
      $("#mk-f").innerHTML = `<span>${p.words.length} words</span><span>arrows: likeliest next word</span><span class="timing">${fmt.ms(p.ms)}</span>`;
    } else {
      const t = await api.get(`/text/table?n=${S.mk.n}`); if (!ok()) return;
      $("#mk-body").innerHTML = `<table class="tbl heat te-heat"><thead><tr><th></th>${t.words.map((w) => `<th><span>${esc(w)}</span></th>`).join("")}<th class="r">n</th></tr></thead><tbody>
        ${t.words.map((w, i) => `<tr><td class="rw" data-w="${esc(w)}">${esc(w)}</td>${t.prob[i].map((pr, j) => { const a = Math.min(1, pr * 3); return `<td title="${esc(w)} → ${esc(t.words[j])}: ${(pr * 100).toFixed(1)}% (${t.counts[i][j]})" style="background:rgba(212,0,0,${a.toFixed(2)});color:${a > 0.35 ? "#fff" : "#55565e"}">${pr > 0.005 ? Math.round(pr * 100) : ""}</td>`; }).join("")}<td class="r dim mono">${fmt.big(t.row_totals[i])}</td></tr>`).join("")}
      </tbody></table>`;
      $$("#mk-body .rw").forEach((td) => td.onclick = () => inspect(td.dataset.w));
      $("#mk-f").innerHTML = `<span>P(column follows row) %</span><span class="timing">${fmt.ms(t.ms)}</span>`;
    }
  } catch (e) { const el = $("#mk-body"); if (el) el.innerHTML = empty(esc(e.message)); }
  try {
    const bg = await api.get("/text/bigrams?top=40"); if (!ok()) return;
    const mx = bg.items[0]?.c || 1;
    $("#mk-pairs").innerHTML = bg.items.map((it) => `<div class="barrow" data-w="${esc(it.a)}"><i style="width:${it.c / mx * 100}%"></i><span>${esc(it.a)} <span class="dim">→</span> ${esc(it.b)}</span><b>${fmt.big(it.c)}</b></div>`).join("") || empty("No pairs pass the filter.");
    $$("#mk-pairs .barrow").forEach((r) => r.onclick = () => inspect(r.dataset.w));
    $("#mk-pf").innerHTML = `<span>${bg.items.length} pairs</span><span class="timing">${fmt.ms(bg.ms)}</span>`;
  } catch (e) { const el = $("#mk-pairs"); if (el) el.innerHTML = empty(esc(e.message)); }
}
function drawGraph(p) {
  const body = $("#mk-body"); if (!body) return;
  const W = Math.max(300, body.clientWidth - 24), H = Math.max(260, body.clientHeight - 24);
  const n = p.words.length, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 34;
  const pos = p.words.map((w, i) => { const a = i / n * Math.PI * 2 - Math.PI / 2; return { w, x: cx + R * Math.cos(a), y: cy + R * Math.sin(a), a }; });
  const rowMax = p.matrix.map((r) => Math.max(...r, 1));
  const edges = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j && p.matrix[i][j] > rowMax[i] * 0.33) edges.push([i, j, p.matrix[i][j] / rowMax[i]]);
  body.innerHTML = `<svg class="mk-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><defs><marker id="ah" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="rgba(255,42,26,.55)"/></marker></defs>
    ${edges.map(([i, j, w]) => { const a = pos[i], b = pos[j]; const mx = (a.x + b.x) / 2 + (b.y - a.y) * 0.12, my = (a.y + b.y) / 2 - (b.x - a.x) * 0.12;
      return `<path d="M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}" fill="none" stroke="rgba(255,42,26,${(0.1 + w * 0.5).toFixed(2)})" stroke-width="${(0.6 + w * 2.4).toFixed(1)}" marker-end="url(#ah)"/>`; }).join("")}
    ${pos.map((q, i) => { const out = Math.cos(q.a) >= 0; const lx = q.x + Math.cos(q.a) * 10, ly = q.y + Math.sin(q.a) * 10 + 4;
      return `<g class="node" data-i="${i}"><circle cx="${q.x}" cy="${q.y}" r="4.5"/><text x="${lx}" y="${ly}" text-anchor="${Math.abs(Math.cos(q.a)) < 0.2 ? "middle" : out ? "start" : "end"}">${esc(q.w)}</text></g>`; }).join("")}</svg>`;
  $$("#mk-body .node").forEach((g) => g.onclick = () => inspect(p.words[+g.dataset.i]));
}

// ---- GENERATE ----------------------------------------------------------
function tGenerate() {
  const g = S.gen;
  stage("21", `<section class="pane" id="tg-p"><div class="pane-h"><div class="t">Generate</div>
      <div class="seg" id="tg-model"><button data-m="markov" title="n-gram walk over the real text">Markov</button><button data-m="topics" title="Markov over embedding topics: the topic chain steers word choice">Topic Markov</button><button data-m="lm" title="VectorLM generator (prototype): Kneser–Ney + neural LM trained on the card, blended">VectorLM</button></div>
      <div class="meta" id="tg-note"></div><div class="tools"><button class="btn sm" id="tg-go">${icon("spark")} Generate</button></div></div>
      <div class="sec tg-ctl">
        <div class="tg-row"><input class="in sm" id="tg-seed" placeholder="Start with a few words (optional)" value="${esc(g.seed)}"><input class="in sm" id="tg-theme" placeholder="Steer toward a theme, e.g. “security privacy”" value="${esc(g.theme)}"></div>
        <div class="tg-row tg-knobs">
          <div class="fld tg-mem"><label>Memory</label><select class="sel sm" id="tg-order">${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${n === g.order ? "selected" : ""}>${n} word${n > 1 ? "s" : ""}</option>`).join("")}</select></div>
          <div class="fld"><label>Length</label><input type="range" id="tg-len" min="20" max="500" step="10" value="${g.length}"><span class="v" id="tg-len-v">${g.length}</span></div>
          <div class="fld"><label>Wildness</label><input type="range" id="tg-temp" min="0.3" max="2" step="0.05" value="${g.temp}"><span class="v" id="tg-temp-v">${g.temp}</span></div>
          <div class="fld tg-lmonly"><label>Novelty</label><input type="range" id="tg-nov" min="0" max="1" step="0.05" value="${g.novelty}"><span class="v" id="tg-nov-v">${g.novelty}</span></div>
          <div class="fld tg-end"><label>End</label><select class="sel sm" id="tg-stop"><option value="none">at length</option><option value="sentence">on a full stop</option><option value="paragraph">on a paragraph</option></select></div>
          <label class="toggle tg-nolm" title="Drop the, of, and… from the output"><input type="checkbox" id="tg-nofill" ${g.nofill ? "checked" : ""}><i></i>No filler</label>
        </div></div>
      <div class="pane-b"><div class="gen te-gen" id="tg-out">${empty("Press Generate. Every Markov word is real text — hover a word to see the passage it came from. To combine models, sampling rules and constraints, and to score them, use <b>Compose</b>.")}</div></div>
      <div class="prov te-prov" id="tg-prov">Hover a word to trace it to its source.</div>
      <div class="pane-f" id="tg-f">&nbsp;</div></section>`
    + `<div class="col"><section class="pane grow" id="tg-mapp"><div class="pane-h"><div class="t">Path through the embedding space</div><div class="meta" id="tg-mapmeta"></div></div>
        <div class="pane-b stage"><canvas id="tg-map"></canvas></div></section>
      <section class="pane fit" id="tg-info"><div class="pane-h"><div class="t" id="tg-info-t">Model</div><div class="tools" id="tg-info-tools"></div></div><div class="pane-b" id="tg-info-b"></div></section></div>`);
  $("#tg-stop").value = g.stop;
  $$("#tg-model [data-m]").forEach((b) => b.onclick = () => { g.model = b.dataset.m; syncModel(); });
  const sl = (id, k, d = 0) => { const e = $(id); e.oninput = () => { g[k] = +e.value; $(id + "-v").textContent = d ? (+e.value).toFixed(d) : e.value; }; };
  sl("#tg-len", "length"); sl("#tg-nov", "novelty", 2);
  $("#tg-temp").oninput = (e) => { g[g.model === "lm" ? "lmTemp" : "temp"] = +e.target.value; $("#tg-temp-v").textContent = (+e.target.value).toFixed(2); };
  $("#tg-order").onchange = (e) => g.order = +e.target.value;
  $("#tg-stop").onchange = (e) => g.stop = e.target.value;
  $("#tg-nofill").onchange = (e) => g.nofill = e.target.checked;
  $("#tg-seed").oninput = (e) => g.seed = e.target.value; $("#tg-theme").oninput = (e) => g.theme = e.target.value;
  $("#tg-go").onclick = generate; $("#tg-seed").onkeydown = (e) => { if (e.key === "Enter") generate(); };
  syncModel();
  if (g.last) showGen(g.last);
  loadGenMap();
}
function syncModel() {
  const g = S.gen;
  $$("#tg-model [data-m]").forEach((b) => b.classList.toggle("on", b.dataset.m === g.model));
  $("#tg-p").classList.toggle("is-lm", g.model === "lm");
  const tv = g.model === "lm" ? g.lmTemp : g.temp, ts = $("#tg-temp");      // the LM keeps its own (cooler) setting
  if (ts) { ts.value = tv; $("#tg-temp-v").textContent = (+tv).toFixed(2); }
  renderModelInfo();
}
async function renderModelInfo() {
  const g = S.gen, b = $("#tg-info-b"); if (!b) return;
  $("#tg-info-tools").innerHTML = "";
  if (g.model === "markov") {
    $("#tg-info-t").textContent = "Markov chain";
    b.innerHTML = `<div class="hint">An n-gram walk. The card finds the last <b>${g.order}</b> word(s) in the full text. Then it draws the next word from the words that really came after them. It never selects words outside your filter. The colour shows how much memory the walk used: <span class="o0c">■</span> fallback <span class="o1c">■</span> 1 <span class="o2c">■</span> 2 <span class="o3c">■</span> 3+.</div>`;
  } else if (g.model === "topics") {
    $("#tg-info-t").textContent = "Topic chain";
    $("#tg-info-tools").innerHTML = `<select class="sel sm" id="tg-k">${[8, 12, 16, 24].map((k) => `<option ${k === g.topics ? "selected" : ""}>${k}</option>`).join("")}</select>`;
    $("#tg-k").onchange = (e) => { g.topics = +e.target.value; renderModelInfo(); };
    b.innerHTML = '<div class="skeleton" style="height:90px"></div>';
    try {
      const t = await api.get(`/text/topics?topics=${g.topics}`);
      b.innerHTML = `<div class="hint" style="margin-bottom:8px">The card puts the words into ${t.topics.length} topics in embedding space. It counts the chain from topic to topic, and this chain controls each selection. Click a word to cross it out.</div>
        <div class="tg-topics">${t.topics.map((tp) => `<div class="tg-tp"><i style="background:${topicColor(tp.id)}"></i><div class="toks">${tp.words.map((w) => tokHtml(w)).join("")}</div></div>`).join("")}</div>`;
      bindToks(b);
    } catch (e) { b.innerHTML = empty(esc(e.message)); }
  } else {
    $("#tg-info-t").innerHTML = `VectorLM generator ${VLM_BADGE}`;
    b.innerHTML = '<div class="skeleton" style="height:90px"></div>';
    let s;
    try { s = await api.get("/text/lm/status"); } catch (e) { b.innerHTML = `<div class="hint">The language model module is not available now (${esc(e.message)}). Markov and Topic Markov work now.</div>`; return; }
    const ev = s.eval || {}, row = (k, l) => ev[k] != null ? `<span>${l}</span><b>${fmt.n(ev[k], 1)}</b>` : "";
    $("#tg-info-tools").innerHTML = `<select class="sel sm" id="tg-lmm">${["hybrid", "kn", "mlp"].map((m) => `<option ${m === g.lmModel ? "selected" : ""}>${m}</option>`).join("")}</select>
      <button class="btn ghost xs" id="tg-build">Build</button><button class="btn ghost xs" id="tg-train">Train</button>`;
    $("#tg-lmm").onchange = (e) => g.lmModel = e.target.value;
    $("#tg-build").onclick = () => lmJob("/text/lm/build", "Building n-gram model");
    $("#tg-train").onclick = () => lmJob("/text/lm/train", "Training the neural LM on the card");
    const m = s.model || {};
    b.innerHTML = `<div class="hint" style="margin-bottom:8px">Kneser–Ney n-grams + longest-match + embedding cache + a neural LM trained on the card, blended. Lower perplexity (held-out text) = better.</div>
      <div class="kv">${row("unigram", "Unigram ppl")}${row("bigram", "Bigram ppl")}${row("kn", "Kneser–Ney ppl")}${row("kn_cache", "KN + embedding cache")}${row("kn_sfx", "KN + longest match")}${row("mlp", "Neural LM ppl")}${row("hybrid", "Hybrid ppl")}
        ${m.vocab ? `<span>Vocabulary</span><b>${fmt.n(m.vocab)}${m.coverage ? ` · ${fmt.pct(m.coverage, 0)} cover` : ""}</b>` : ""}${m.params ? `<span>Neural params</span><b>${fmt.big(m.params)}</b>` : ""}</div>
      ${s.training ? `<div class="hint" style="margin-top:8px">training: ${esc(s.training.message || "")}</div>` : ""}${!s.trained && ev.kn == null ? '<div class="hint" style="margin-top:8px">Press <b>Build</b> (seconds), then <b>Train</b> (a few minutes). Or click Generate: it builds the model the first time.</div>' : ""}`;
  }
}
async function lmJob(path, label) {
  try { const j = await api.post(path, {}); const bar = jobBar(label); try { await watchJob(j, (x) => bar.update(x.message, x.progress)); } finally { bar.done(); } renderModelInfo(); } catch (e) { fail(e); }
}
async function generate() {
  const g = S.gen, btn = $("#tg-go"); btn.disabled = true; $("#tg-note").textContent = "";
  $("#tg-p").classList.add("is-busy");
  const t0 = performance.now();
  try {
    let r;
    if (g.model === "lm") {
      const q = new URLSearchParams({ seed: g.seed, length: g.length, temp: g.lmTemp, top_p: 0.85, theme: g.theme, novelty: g.novelty, model: g.lmModel, stop_at: g.stop });
      r = await api.get(`/text/lm/generate?${q}`); r.mode = "lm";
    } else {
      const q = new URLSearchParams({ seed: g.seed, order: g.order, length: g.length, temp: g.temp, stop_at: g.stop, avoid_stop: g.nofill ? 1 : 0, theme: g.theme, mode: g.model, topics: g.topics });
      r = await api.get(`/text/generate2?${q}`);
    }
    r.clickT0 = t0; g.last = r; showGen(r);
  } catch (e) { $("#tg-out").innerHTML = empty(esc(e.message)); $("#tg-f").innerHTML = "&nbsp;"; }
  btn.disabled = false; $("#tg-p").classList.remove("is-busy");
}
// Opening or closing for each straight quote, read from its neighbours (the same rule as the server's detok):
// generated text drops quotes, so plain alternation drifts out of step.
function quoteDirs(ws) {
  const out = {}, END = new Set([".", ",", "!", "?", ";", "-"]);
  let open = false;
  ws.forEach((w, i) => {
    if (w !== '"') return;
    let p = null; for (let j = i - 1; j >= 0; j--) if (ws[j] !== '"') { p = ws[j]; break; }
    const n = ws[i + 1] ?? null;
    let d;
    if (p == null || p === "\n\n" || p === ":" || p === "(") d = true;
    else if (n == null || n === "\n\n" || [".", ",", "!", "?", ";", ")"].includes(n)) d = false;
    else if (END.has(p) && /^[a-z]/.test(n)) d = false;
    else if (!END.has(p) && /^[A-Z]/.test(n) && !open) d = true;
    else d = !open;
    out[i] = d; open = d;
  });
  return out;
}
function showGen(r) {
  const out = $("#tg-out"); if (!out) return;
  const words = r.words || [];
  const cls = (w) => r.mode === "lm" ? `w lm ${w.src >= 0 ? "" : "untr"}` : `w o${Math.min(3, w.order || 0)}`;
  const style = (w) => r.mode === "topics" && w.t >= 0 ? ` style="color:${topicColor(w.t)}"` : "";
  const qd = quoteDirs(words.map((w) => w.w));
  out.innerHTML = (r.seed ? `<span class="seed">${esc(r.seed)}</span> ` : "") + words.map((w, i) => {
    if (w.w === "\n\n") return "<br><br>";
    const nx = words[i + 1]?.w || "";
    let sp = /^[\w"'(À-￿]/.test(nx) && !["(", "-", "“"].includes(w.w) ? " " : "";
    if (nx === '"') sp = qd[i + 1] && !["(", "-"].includes(w.w) ? " " : "";     // no space before a closing quote
    if (w.w === '"') sp = qd[i] ? "" : (/^[\w(À-￿]/.test(nx) ? " " : "");     // none after an opening one
    return `<span class="${cls(w)}"${style(w)} data-src="${w.src ?? -1}"${w.p != null ? ` title="p=${(+w.p).toFixed(3)}${w.expert ? " · " + esc(w.expert) : ""}"` : ""}>${esc(w.w)}</span>${sp}`;
  }).join("");
  const toks = words.length;
  // tok/s is tokens over the whole wait: click -> request -> model warm-up -> generation -> text on screen.
  // The first LM run after a restart builds its n-gram tables (tens of seconds); that counts.
  if (r.clickT0 != null && r.wallMs == null) r.wallMs = performance.now() - r.clickT0;
  const wall = r.wallMs ?? r.server_ms ?? r.ms;
  const parts = [r.warmup_ms > 50 ? `warm-up ${fmt.ms(r.warmup_ms)}` : null, `generation ${fmt.ms(r.ms)}`,
    r.server_ms != null ? `server total ${fmt.ms(r.server_ms)}` : null, r.wallMs != null ? `click to screen ${fmt.ms(r.wallMs)}` : null,
    r.tok_s != null ? `${fmt.n(r.tok_s, 0)} tok/s during generation` : null].filter(Boolean).join(" · ");
  $("#tg-f").innerHTML = `<span><b>${fmt.n(toks)}</b> tokens</span><span title="${esc(parts)}"><b class="tg-toks">${fmt.n(toks / Math.max(1e-3, wall / 1000), 0)}</b> tok/s</span>
    ${r.scans != null ? `<span>${r.scans} GPU scans</span>` : ""}<span>${r.mode === "lm" ? `${VLM_BADGE} VectorLM · ${esc(r.model || "")}` : r.mode === "topics" ? "topic Markov" : `Markov · ${r.order}-word memory`}</span>${r.theme ? `<span>theme “${esc(r.theme)}”</span>` : ""}${r.warmup_ms > 1000 ? `<span class="warn" title="first use after a restart builds the model">incl. ${fmt.ms(r.warmup_ms)} warm-up</span>` : ""}<span class="timing" title="${esc(parts)}">${fmt.ms(wall)}</span>`;
  $$("#tg-out .w").forEach((w) => w.onmouseenter = async () => {
    const src = +w.dataset.src;
    if (src < 0) { $("#tg-prov").innerHTML = `<span class="dim">The model made “${esc(w.textContent)}”. It did not copy it from one place.</span>`; return; }
    try { const s = await api.get("/text/source?pos=" + src);
      $("#tg-prov").innerHTML = s.match ? `…${esc(s.left)}<b>${esc(s.match)}</b>${esc(s.right)}… ${s.doc ? `<span class="dim">— ${esc(s.doc)}</span>` : ""}` : "source not found";
    } catch (e) { /* ignore */ }
  });
  $$("#tg-out .w").forEach((w) => w.onclick = () => inspect(w.textContent));
  drawGenMap();
}
async function loadGenMap() {
  if (S.map.data) { drawGenMap(); return; }
  const ok = latest("genmap");
  try { const d = await api.get(`/text/embedmap?n=${S.map.n}&topics=${S.map.topics}`); if (!ok()) return; S.map.data = d; drawGenMap(); }
  catch (e) { const m = $("#tg-mapmeta"); if (m) m.textContent = e.message; }
}
function drawGenMap() {
  const cv = $("#tg-map"), d = S.map.data; if (!cv || !d) return;
  const path = ((S.gen.last && S.gen.last.words) || []).map((w) => w.w.toLowerCase());
  const n = mapPlot(cv, d, { path, labels: "few", view: { s: 1, tx: 0, ty: 0 } });
  $("#tg-mapmeta").textContent = S.gen.last ? `${n} of the generated words are on the map` : `${d.items.length} words · ${d.topics.length} topics`;
}

// ---- EMBEDDINGS ---------------------------------------------------------
function tEmbed() {
  const m = S.map;
  stage("31", `<section class="pane" id="em-p"><div class="pane-h"><div class="t">Embedding space</div><div class="meta" id="em-meta">t-SNE on the card</div>
      <div class="tools"><select class="sel sm" id="em-n" title="Words on the map">${[200, 350, 500, 800, 1200].map((n) => `<option value="${n}" ${n === m.n ? "selected" : ""}>${n} words</option>`).join("")}</select>
      <select class="sel sm" id="em-k" title="Topics">${[6, 8, 12, 16, 20, 24].map((k) => `<option value="${k}" ${k === m.topics ? "selected" : ""}>${k} topics</option>`).join("")}</select>
      <button class="iconbtn ${m.labels ? "on" : ""}" id="em-lab" title="Labels">${icon("text")}</button><button class="iconbtn" id="em-fit" title="Fit">${icon("fit")}</button></div></div>
      <div class="pane-b stage"><canvas id="em-cv"></canvas><div class="em-tip" id="em-tip"></div></div>
      <div class="pane-f" id="em-f">scroll to zoom · drag to pan · click a word to inspect it</div></section>
    <section class="pane"><div class="pane-h"><div class="t">Topics</div><div class="meta">click a word to cross it out</div></div><div class="pane-b" id="em-topics"><div class="skeleton"></div></div></section>`);
  $("#em-n").onchange = (e) => { m.n = +e.target.value; m.data = null; loadMap(); };
  $("#em-k").onchange = (e) => { m.topics = +e.target.value; m.data = null; loadMap(); };
  $("#em-lab").onclick = () => { m.labels = !m.labels; $("#em-lab").classList.toggle("on", m.labels); drawMap(); };
  $("#em-fit").onclick = () => { m.view = { s: 1, tx: 0, ty: 0 }; drawMap(); };
  bindMapEvents();
  if (m.data) { drawMap(); renderTopics(); } else loadMap();
}
async function loadMap(keep) {
  const m = S.map, ok = latest("map");
  $("#em-p")?.classList.add("is-busy");
  try {
    const d = await api.get(`/text/embedmap?n=${m.n}&topics=${m.topics}`); if (!ok()) return;
    if (m.data) m.prevTopics = m.data.topics;
    m.data = d; m.focus = -1; if (!keep) m.view = { s: 1, tx: 0, ty: 0 };
    if (tab === "embed") { drawMap(); renderTopics(); $("#em-meta").textContent = `${d.items.length} words · ${d.topics.length} topics · vocabulary ${fmt.n(d.vocab)}`; $("#em-f").innerHTML = `scroll to zoom · drag to pan · click a word to inspect it <span class="timing">${fmt.ms(d.ms)}</span>`; }
  } catch (e) { const t = $("#em-topics"); if (t) t.innerHTML = empty(esc(e.message)); }
  $("#em-p")?.classList.remove("is-busy");
}
function renderTopics() {
  const d = S.map.data, el = $("#em-topics"); if (!d || !el) return;
  const off = offSet();
  // crossed-out words stay listed (struck) in the topic they came from, so a second click brings them back
  const carry = {};
  if (S.map.prevTopics) for (const pt of S.map.prevTopics) for (const w of pt.words) if (off.has(w.toLowerCase())) {
    let best = 0, bi = -1; d.topics.forEach((t, i) => { const o = t.words.filter((x) => pt.words.includes(x)).length; if (o > best) { best = o; bi = i; } });
    (carry[bi < 0 ? 0 : bi] = carry[bi < 0 ? 0 : bi] || []).push(w);
  }
  el.innerHTML = d.topics.map((t, i) => `<div class="em-tp ${S.map.focus === t.id ? "on" : ""}" data-t="${t.id}"><div class="em-tph"><i style="background:${topicColor(t.id)}"></i><b>Topic ${t.id + 1}</b><span class="dim">${fmt.n(t.size)} words</span></div>
    <div class="toks">${[...t.words, ...(carry[i] || []).filter((w) => !t.words.includes(w))].map((w) => tokHtml(w)).join("")}${mapWords(t.id).map((w) => tokHtml(w)).join("")}</div></div>`).join("");
  bindToks(el);
  $$("#em-topics .em-tph").forEach((h) => h.onclick = () => { const t = +h.parentElement.dataset.t; S.map.focus = S.map.focus === t ? -1 : t; renderTopics(); drawMap(); });
}
function mapWords(t) { // more members from the map itself (beyond the 5 names), most frequent first
  const d = S.map.data; const names = new Set(d.topics[t].words);
  return d.items.filter((x) => x.t === t && !names.has(x.w)).slice(0, 10).map((x) => x.w);
}
function drawMap() { const cv = $("#em-cv"); if (!cv || !S.map.data) return; mapPlot(cv, S.map.data, { labels: S.map.labels ? "zoom" : "none", view: S.map.view, focus: S.map.focus, hover: S.map.hover, sel: sel }); }
function bindMapEvents() {
  const cv = $("#em-cv"), m = S.map; let drag = null;
  cv.addEventListener("wheel", (e) => { e.preventDefault(); const r = cv.getBoundingClientRect(); const f = e.deltaY < 0 ? 1.18 : 1 / 1.18;
    const px = e.clientX - r.left - r.width / 2, py = e.clientY - r.top - r.height / 2;
    m.view.tx = px - (px - m.view.tx) * f; m.view.ty = py - (py - m.view.ty) * f; m.view.s *= f; drawMap(); }, { passive: false });
  cv.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, tx: m.view.tx, ty: m.view.ty, moved: false }; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener("pointermove", (e) => {
    if (drag) { const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true; m.view.tx = drag.tx + dx; m.view.ty = drag.ty + dy; drawMap(); return; }
    const i = hitTest(cv, e); if (i !== m.hover) { m.hover = i; drawMap(); }
    const tip = $("#em-tip");
    if (i >= 0) { const it = m.data.items[i]; tip.style.display = "block"; tip.style.left = (e.offsetX + 14) + "px"; tip.style.top = (e.offsetY + 10) + "px"; tip.innerHTML = `<b>${esc(it.w)}</b> · ${fmt.big(it.c)} · topic ${it.t + 1}`; }
    else tip.style.display = "none";
  });
  cv.addEventListener("pointerup", (e) => { const was = drag; drag = null; if (was && !was.moved) { const i = hitTest(cv, e); if (i >= 0) inspect(m.data.items[i].w); } });
  cv.addEventListener("pointerleave", () => { m.hover = -1; const t = $("#em-tip"); if (t) t.style.display = "none"; drawMap(); });
}
function hitTest(cv, e) {
  const pts = cv._pts || []; let best = -1, bd = 12 * 12;
  for (let k = 0; k < pts.length; k++) { const p = pts[k]; const dx = p.x - e.offsetX, dy = p.y - e.offsetY, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = p.i; } }
  return best;
}
// shared map renderer (Embeddings tab and the Generate path); returns how many path words were on the map
function mapPlot(cv, d, o) {
  const dpr = window.devicePixelRatio || 1, W = cv.parentElement.clientWidth, H = cv.parentElement.clientHeight;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = W + "px"; cv.style.height = H + "px";
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const v = o.view || { s: 1, tx: 0, ty: 0 }, pad = 26, sc = Math.min(W, H) / 2 - pad;
  const X = (x) => W / 2 + v.tx + x * sc * v.s * (W / Math.min(W, H) * 0.92), Y = (y) => H / 2 + v.ty + y * sc * v.s;
  const cmax = Math.log(d.items[0] ? d.items.reduce((m, x) => Math.max(m, x.c), 1) : 1);
  const pts = [];
  g.font = "11px Inter, system-ui, sans-serif";
  d.items.forEach((it, i) => {
    const x = X(it.x), y = Y(it.y); if (x < -20 || y < -20 || x > W + 20 || y > H + 20) return;
    const dim = o.focus != null && o.focus >= 0 && it.t !== o.focus;
    const r = 1.6 + 3.2 * Math.log(it.c + 1) / Math.max(1, cmax);
    g.beginPath(); g.arc(x, y, r, 0, 7); g.fillStyle = topicColor(it.t, dim ? 0.12 : 0.8); g.fill();
    pts.push({ x, y, i });
  });
  // labels: biggest words first, skip overlaps; more appear as you zoom in
  if (o.labels !== "none") {
    const boxes = [], lim = o.labels === "few" ? 26 : Math.round(40 * Math.max(1, v.s * v.s));
    let shown = 0;
    for (const p of pts.slice().sort((a, b) => d.items[b.i].c - d.items[a.i].c)) {
      if (shown >= lim) break;
      const it = d.items[p.i]; if (o.focus >= 0 && it.t !== o.focus) continue;
      const w = g.measureText(it.w).width, bx = p.x + 5, by = p.y - 6, bw = w + 2, bh = 12;
      if (boxes.some((b) => bx < b[0] + b[2] && bx + bw > b[0] && by < b[1] + b[3] && by + bh > b[1])) continue;
      boxes.push([bx, by, bw, bh]); shown++;
      g.fillStyle = "rgba(232,232,236,.82)"; g.fillText(it.w, bx, by + 9);
    }
  }
  let onMap = 0;
  if (o.path && o.path.length) {
    const idx = new Map(d.items.map((it, i) => [it.w.toLowerCase(), i]));
    const seq = o.path.map((w) => idx.get(w)).filter((i) => i != null);
    onMap = seq.length;
    if (seq.length) {
      g.lineWidth = 1.4; g.strokeStyle = "rgba(255,255,255,.55)"; g.beginPath();
      seq.forEach((i, k) => { const x = X(d.items[i].x), y = Y(d.items[i].y); if (k) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke();
      seq.forEach((i, k) => { const it = d.items[i], x = X(it.x), y = Y(it.y);
        g.beginPath(); g.arc(x, y, 4, 0, 7); g.fillStyle = k === 0 ? "#fff" : "#ff2a1a"; g.fill();
        g.fillStyle = "#fff"; g.font = "600 11px Inter, system-ui"; g.fillText(it.w, x + 6, y - 5); });
    }
  }
  const hl = (i, col) => { if (i == null || i < 0) return; const it = d.items[i]; const x = X(it.x), y = Y(it.y); g.beginPath(); g.arc(x, y, 7, 0, 7); g.strokeStyle = col; g.lineWidth = 2; g.stroke(); g.fillStyle = "#fff"; g.font = "700 12px Inter, system-ui"; g.fillText(it.w, x + 9, y - 7); };
  if (o.sel) hl(d.items.findIndex((it) => it.w.toLowerCase() === String(o.sel).toLowerCase()), "#ffd300");
  if (o.hover != null) hl(o.hover, "#ffffff");
  cv._pts = pts;
  return onMap;
}

// ---- RELATIONS: analogies & word arithmetic in a 5,000-word space that keeps function words -------------
const REL_KINDS = [
  ["pairs", "Pairs like a : b", "Each pair with a difference in the same direction: do : don't → could : couldn't…"],
  ["analogy", "a : b :: c : ?", "a is to b as c is to …"],
  ["arith", "Word arithmetic", "king - man + woman"],
  ["axis", "Scale a ↔ b", "every word placed on the line from a to b"],
  ["between", "Between a and b", "words like both"],
  ["odd", "Odd one out", "the word that does not belong"],
];
function tRelations() {
  const g = S.rel;
  const kind = REL_KINDS.find((k) => k[0] === g.kind) || REL_KINDS[0];
  const inp = (id, v, ph, w = "") => `<input class="in sm" id="${id}" value="${esc(v)}" placeholder="${esc(ph)}"${w ? ` style="width:${w}"` : ""}>`;
  const form = {
    pairs: `${inp("rl-a", g.a, "do", "110px")}<span class="rl-op">:</span>${inp("rl-b", g.b, "don't", "110px")}`,
    analogy: `${inp("rl-a", g.a, "man", "100px")}<span class="rl-op">:</span>${inp("rl-b", g.b, "woman", "100px")}<span class="rl-op">::</span>${inp("rl-c", g.c, "father", "100px")}<span class="rl-op">: ?</span>`,
    arith: inp("rl-expr", g.expr, "king - man + woman", "320px"),
    axis: `${inp("rl-a", g.a, "poor", "110px")}<span class="rl-op">↔</span>${inp("rl-b", g.b, "rich", "110px")}`,
    between: `${inp("rl-a", g.a, "love", "110px")}<span class="rl-op">&amp;</span>${inp("rl-b", g.b, "money", "110px")}`,
    odd: inp("rl-words", g.words, "father mother sister table", "320px"),
  }[kind[0]];
  stage("21", `<section class="pane" id="rl-p"><div class="pane-h"><div class="t">Relations</div><div class="meta">word vectors from this corpus</div></div>
      <div class="sec rl-q"><div class="seg" id="rl-kind">${REL_KINDS.map(([k, l, t]) => `<button data-k="${k}" class="${k === kind[0] ? "on" : ""}" title="${esc(t)}">${esc(l)}</button>`).join("")}</div>
      <div class="rl-form">${form}<button class="btn sm" id="rl-go">${icon("spark")} Find</button></div><div class="hint" id="rl-hint">${esc(kind[2])}</div></div>
      <div class="pane-b" id="rl-out">${empty("Ask a question of the word vectors. Click any word to inspect it.")}</div>
      <div class="pane-f" id="rl-f">&nbsp;</div></section>
    <section class="pane" id="rl-tp"><div class="pane-h"><div class="t">How far to trust it</div><div class="tools"><button class="btn ghost xs" id="rl-test">Test the space</button></div></div>
      <div class="pane-b" id="rl-test-b"><div class="hint">These vectors come only from your corpus. The card counts co-occurrences in a window and keeps the words on the left and on the right apart. Then it does PPMI and an SVD. They include function words (“do”, “don't”, “is”, “isn't”). The topic map does not include these words. Small corpora give noisy relations, so <b>Test the space</b> measures analogy accuracy on relations found in this corpus's own vocabulary, against the nearest-word baseline.</div></div></section>`);
  $$("#rl-kind [data-k]").forEach((b) => b.onclick = () => { save(); g.kind = b.dataset.k; g.last = null; tRelations(); });
  const save = () => { for (const [id, k] of [["#rl-a", "a"], ["#rl-b", "b"], ["#rl-c", "c"], ["#rl-expr", "expr"], ["#rl-words", "words"]]) { const e = $(id); if (e) g[k] = e.value.trim(); } };
  $("#rl-go").onclick = () => { save(); runRel(); };
  $$("#rl-p .rl-form input").forEach((e) => e.onkeydown = (ev) => { if (ev.key === "Enter") { save(); runRel(); } });
  $("#rl-test").onclick = runRelTest;
  if (g.last && g.last.kind === kind[0]) showRel(g.last);
  if (g.test) showRelTest(g.test);
}
async function runRel() {
  const g = S.rel, btn = $("#rl-go"); btn.disabled = true; $("#rl-p").classList.add("is-busy");
  const t0 = performance.now(), ok = latest("rel");
  try {
    const q = new URLSearchParams({ a: g.a, b: g.b, c: g.c, expr: g.expr, words: g.words, k: g.kind === "pairs" ? 30 : g.kind === "axis" ? 18 : 15 });
    const r = await api.get(`/text/rel/${g.kind}?${q}`); if (!ok()) return;
    r.kind = g.kind; r.wall = performance.now() - t0; g.last = r; showRel(r);
  } catch (e) { $("#rl-out").innerHTML = empty(esc(e.message)); $("#rl-f").innerHTML = "&nbsp;"; }
  btn.disabled = false; $("#rl-p").classList.remove("is-busy");
}
function showRel(r) {
  const out = $("#rl-out"); if (!out) return;
  const w = (x) => `<span class="tok rl-w" data-w="${esc(x)}">${esc(x)}</span>`;
  const bar = (v, mx = 1) => `<i class="rl-bar" style="width:${Math.max(2, Math.min(100, v / mx * 100)).toFixed(0)}%"></i>`;
  let html = "", foot = "";
  if (r.kind === "pairs") {
    const mx = Math.max(...r.items.map((x) => x.score), 1e-6);
    html = `<div class="hint" style="margin-bottom:8px">Pairs whose difference points like <b>${esc(r.a)} → ${esc(r.b)}</b>. The table marks scores above the chance line <b>${r.control_p99}</b> (the 99th percentile of random pairs of neighbours). Each word shows only one time.</div>
      <div class="rl-list">${r.items.map((x) => `<div class="rl-row ${x.above_chance ? "" : "dim"}">${w(x.x)}<span class="rl-arrow">→</span>${w(x.y)}<span class="rl-s">${bar(x.score, mx)}<b>${x.score.toFixed(2)}</b>${x.above_chance ? "" : " <span class=\"dim\">chance</span>"}</span></div>`).join("")}</div>`;
    foot = `<span><b>${r.above_chance}</b> pairs above chance</span><span>${fmt.n(r.vocab)} words</span>`;
  } else if (r.kind === "analogy") {
    html = `<div class="hint" style="margin-bottom:8px"><b>${esc(r.a)}</b> is to <b>${esc(r.b)}</b> as <b>${esc(r.c)}</b> is to … (${r.method === "3cosadd" ? "3CosAdd" : "3CosMul"}). Without the relation, the nearest word to <b>${esc(r.c)}</b> is ${w(r.baseline_nearest_c)}${r.items[0] && r.items[0].w === r.baseline_nearest_c ? " — the same as the top answer, so the relation added little" : ""}.</div>
      <div class="rl-list">${r.items.map((x, i) => `<div class="rl-row"><span class="rl-rank">${i + 1}</span>${w(x.w)}<span class="rl-s" title="cosine of (answer − ${esc(r.c)}) with (${esc(r.b)} − ${esc(r.a)})">offset match <b>${x.offset_cos.toFixed(2)}</b></span></div>`).join("")}</div>`;
  } else if (r.kind === "arith") {
    html = `<div class="hint" style="margin-bottom:8px">Nearest words to <b>${esc(r.expr)}</b>.</div><div class="rl-list">${r.items.map((x, i) => `<div class="rl-row"><span class="rl-rank">${i + 1}</span>${w(x.w)}<span class="rl-s">${bar(x.score)}<b>${x.score.toFixed(2)}</b></span></div>`).join("")}</div>`;
  } else if (r.kind === "axis") {
    const col = (t, items) => `<div><div class="sec-t">${t}</div><div class="rl-list">${items.map((x) => `<div class="rl-row">${w(x.w)}<span class="rl-s"><b>${x.score.toFixed(2)}</b></span></div>`).join("")}</div></div>`;
    html = `<div class="hint" style="margin-bottom:8px">Every word projected on the direction from <b>${esc(r.a)}</b> to <b>${esc(r.b)}</b>.</div><div class="rl-two">${col("toward " + esc(r.a), r.toward_a)}${col("toward " + esc(r.b), r.toward_b)}</div>`;
  } else if (r.kind === "between") {
    html = `<div class="hint" style="margin-bottom:8px">Words similar to both <b>${esc(r.a)}</b> and <b>${esc(r.b)}</b> (the two are ${r.similarity_ab.toFixed(2)} alike).</div><div class="rl-list">${r.items.map((x, i) => `<div class="rl-row"><span class="rl-rank">${i + 1}</span>${w(x.w)}<span class="rl-s">${bar(x.score)}<b>${x.score.toFixed(2)}</b></span></div>`).join("")}</div>`;
  } else if (r.kind === "odd") {
    html = `<div class="hint" style="margin-bottom:8px">The odd one out is ${w(r.odd)}. Mean similarity of each word to the others:</div><div class="rl-list">${r.items.map((x) => `<div class="rl-row">${w(x.w)}<span class="rl-s">${bar(Math.max(0, x.mean_sim))}<b>${x.mean_sim.toFixed(2)}</b></span></div>`).join("")}</div>`;
  }
  out.innerHTML = html;
  $$("#rl-out .rl-w").forEach((e) => e.onclick = () => inspect(e.dataset.w));
  $("#rl-f").innerHTML = `${foot}<span class="timing" title="click to answer, server ${fmt.ms(r.ms)}">${fmt.ms(r.wall)}</span>`;
}
async function runRelTest() {
  const b = $("#rl-test"); b.disabled = true; $("#rl-tp").classList.add("is-busy");
  try { const r = await api.get("/text/rel/test"); S.rel.test = r; showRelTest(r); } catch (e) { $("#rl-test-b").innerHTML = empty(esc(e.message)); }
  b.disabled = false; $("#rl-tp").classList.remove("is-busy");
}
function showRelTest(r) {
  const el = $("#rl-test-b"); if (!el) return;
  el.innerHTML = `<div class="hint" style="margin-bottom:8px">Top-1 analogy accuracy (3CosMul) on word pairs mined from this corpus's ${fmt.n(r.vocab)}-word vocabulary. Baseline: the nearest word to c. Chance: ${(r.chance * 100).toFixed(2)}%. Some of the found pairs are false (her : hers, will : willing). Thus, read these values as lower limits.</div>
    <table class="tbl rl-tt"><thead><tr><th>Relation</th><th class="r">Right</th><th class="r" title="nearest word to c">Base</th><th class="r" title="analogy questions">n</th></tr></thead><tbody>${r.relations.map((x) => `<tr><td>${esc(x.relation)}<div class="dim" style="font-size:11px">${esc(x.examples.join(" · "))}</div></td><td class="r"><b>${(x.accuracy * 100).toFixed(1)}%</b></td><td class="r">${(x.baseline * 100).toFixed(1)}%</td><td class="r">${fmt.n(x.questions)}</td></tr>`).join("")}</tbody></table>
    <div class="hint" style="margin-top:8px">${fmt.ms(r.ms)} · the server keeps the space until the text or the filter changes.</div>`;
}

// ---- MEANING -------------------------------------------------------------
async function tMeaning() {
  stage("22", pane({ t: "Key terms", meta: "what this text is most about · click to cross out", bid: "mn-kw", body: '<div class="skeleton"></div>' })
    + pane({ t: "Collocations", meta: "pairs that belong together (PMI)", bid: "mn-coll", body: '<div class="skeleton"></div>' })
    + pane({ t: "Topic flow", meta: "which topic tends to follow which (counted on the card)", bid: "mn-flow", body: '<div class="skeleton"></div>' })
    + pane({ t: "Zipf's law", meta: "rank vs frequency, log–log", body: '<div class="chartbox"><canvas id="mn-zipf"></canvas></div>' }));
  const ok = latest("mn");
  try {
    const [m, t, s] = await Promise.all([api.get("/text/meaning?clusters=10&keywords=60&collocations=40"), api.get("/text/topics?topics=12"), api.get("/text/stats")]);
    if (!ok()) return;
    const mx = m.keywords[0]?.score || 1;
    $("#mn-kw").innerHTML = `<div class="toks big">${m.keywords.map((k) => tokHtml(k.w, `font-size:${(0.85 + k.score / mx * 0.75).toFixed(2)}em`)).join("")}</div>`;
    bindToks($("#mn-kw"));
    $("#mn-coll").innerHTML = m.collocations.map((c) => `<div class="barrow" data-w="${esc(c.a)}"><i style="width:${Math.min(100, c.pmi / (m.collocations[0]?.pmi || 1) * 100)}%"></i><span>${esc(c.a)} ${esc(c.b)}</span><b>${fmt.big(c.c)}× · ${c.pmi}</b></div>`).join("") || empty("No strong pairs.");
    $$("#mn-coll .barrow").forEach((r) => r.onclick = () => inspect(r.dataset.w));
    const K = t.topics.length;
    $("#mn-flow").innerHTML = `<table class="tbl heat te-heat te-flow"><thead><tr><th></th>${t.topics.map((tp) => `<th title="${esc(tp.words.join(", "))}"><span style="color:${topicColor(tp.id)}">${esc(tp.words[0] || "")}</span></th>`).join("")}</tr></thead><tbody>
      ${t.transitions.map((row, i) => `<tr><td class="rw" style="color:${topicColor(i)}" title="${esc(t.topics[i].words.join(", "))}">${esc(t.topics[i].words.slice(0, 2).join(" · "))}</td>${row.map((p) => { const a = Math.min(1, p * K / 3); return `<td style="background:rgba(212,0,0,${a.toFixed(2)});color:${a > 0.4 ? "#fff" : "#55565e"}">${p > 0.02 ? Math.round(p * 100) : ""}</td>`; }).join("")}</tr>`).join("")}</tbody></table>`;
    requestAnimationFrame(() => { const cv = $("#mn-zipf"); if (cv) ch.loglog(cv, { y: s.zipf, h: cv.parentElement.clientHeight }); });
  } catch (e) { $("#mn-kw").innerHTML = empty(esc(e.message)); }
}

// ---- VOCABULARY ------------------------------------------------------------
async function tVocab() {
  const v = S.vc;
  stage("21", `<section class="pane"><div class="pane-h"><div class="t">Vocabulary</div><div class="meta" id="vc-stat"></div>
      <div class="tools"><input class="in sm" id="vc-q" placeholder="contains…" value="${esc(v.q)}" style="width:150px">
      <select class="sel sm" id="vc-sort"><option value="freq">most common</option><option value="rare">rarest</option></select>
      <label class="toggle" title="Also list crossed-out words"><input type="checkbox" id="vc-off" ${v.off ? "checked" : ""}><i></i>crossed out</label></div></div>
      <div class="pane-b flush"><table class="tbl te-vocab"><thead><tr><th style="width:34px"></th><th>Word</th><th class="r">Mentions</th><th style="width:40%"></th><th class="r">Rank</th><th class="r">Per million</th></tr></thead><tbody id="vc-rows"></tbody></table></div>
      <div class="pane-f" id="vc-f">&nbsp;</div></section>`
    + pane({ t: "Frequency profile", meta: "your N–M mentions range shaded", body: '<div class="chartbox"><canvas id="vc-zipf"></canvas></div>', foot: "&nbsp;", id: "vc-z" }));
  $("#vc-sort").value = v.sort;
  $("#vc-q").oninput = (e) => { v.q = e.target.value; clearTimeout(v.t); v.t = setTimeout(loadVocabRows, 200); };
  $("#vc-sort").onchange = (e) => { v.sort = e.target.value; loadVocabRows(); };
  $("#vc-off").onchange = (e) => { v.off = e.target.checked; loadVocabRows(); };
  loadVocabRows();
  try {
    const s = await api.get("/text/stats");
    const cv = $("#vc-zipf"); if (!cv) return;
    ch.loglog(cv, { y: s.zipf, h: cv.parentElement.clientHeight });
    const f = F.filter;
    $("#vc-z-f").innerHTML = `<span>${fmt.n(F.allowed)} words in play</span><span>${fmt.pct(F.allowed_mentions / Math.max(1, F.mentions), 0)} of mentions</span><span>range ${fmtCount(f.min, false)}–${fmtCount(f.max, true)}</span>`;
  } catch (e) { /* chart optional */ }
}
async function loadVocabRows() {
  const v = S.vc, ok = latest("vc");
  try {
    const r = await api.get(`/text/vocab/analysis?contains=${enc(v.q)}&sort=${v.sort}&top=1000&show_off=${v.off ? 1 : 0}`);
    if (!ok()) return;
    const mx = r.items.reduce((m, x) => Math.max(m, x.c), 1), tot = F ? F.mentions : 1;
    $("#vc-rows").innerHTML = r.items.map((it, i) => `<tr class="${it.off ? "off" : ""}" data-w="${esc(it.w)}"><td><input type="checkbox" ${it.off ? "" : "checked"}></td><td class="w">${esc(it.w)}</td><td class="r mono">${fmt.n(it.c)}</td>
      <td class="bar-cell"><i style="width:${(Math.log(it.c + 1) / Math.log(mx + 1) * 100).toFixed(1)}%"></i></td><td class="r dim mono">${i + 1}</td><td class="r dim mono">${fmt.n(it.c / tot * 1e6, 0)}</td></tr>`).join("");
    $$("#vc-rows tr").forEach((tr) => { tr.querySelector("input").onchange = (e) => setOff(tr.dataset.w, !e.target.checked); tr.querySelector(".w").onclick = () => inspect(tr.dataset.w); });
    $("#vc-stat").textContent = `${fmt.n(r.total_matching)} match · ${fmt.n(r.allowed)} in play`;
    $("#vc-f").innerHTML = `<span>${fmt.n(r.shown)} shown</span><span>clear the tick to cross a word out everywhere</span>`;
  } catch (e) { $("#vc-rows").innerHTML = `<tr><td colspan="6">${empty(esc(e.message))}</td></tr>`; }
}

// ---- INSIGHTS ---------------------------------------------------------------
async function tInsights() {
  stage("ins", `<section class="pane fit"><div class="pane-b" id="in-stats"><div class="skeleton" style="height:60px"></div></div></section>
    ${pane({ t: "The vocabulary", meta: "bigger = more common · respects the filter", bid: "in-cloud", body: "" })}
    ${pane({ t: "Find things", meta: "scanned on the card", tools: `<div class="seg" id="in-ex">${["names", "years", "numbers", "emails", "urls", "money", "dates"].map((k, i) => `<button data-ex="${k}" class="${i ? "" : "on"}">${k}</button>`).join("")}</div>`, bid: "in-ex-out", body: "" })}
    ${pane({ t: "Word lengths", body: '<div class="chartbox"><canvas id="in-len"></canvas></div>' })}`);
  let s; try { s = await api.get("/text/stats"); } catch (e) { $("#in-stats").innerHTML = empty(esc(e.message)); return; }
  const st = (n, l) => `<div class="stat"><div class="n">${n}</div><div class="l">${esc(l)}</div></div>`;
  $("#in-stats").innerHTML = `<div class="stats in-strip">${st(fmt.big(s.words), "words")}${st(fmt.big(s.unique_words), "unique")}${st(fmt.big(s.sentences), "sentences")}${st(s.words_per_sentence, "words / sentence")}${st(s.reading_ease, "reading ease")}${st("Grade " + s.grade_level, "reading level")}${st(fmt.big(s.hapax), "said once")}${st(s.reading_minutes > 60 ? (s.reading_minutes / 60).toFixed(0) + " h" : s.reading_minutes + " min", "to read aloud")}</div>`;
  const mx = s.top_content[0]?.c || 1;
  $("#in-cloud").innerHTML = `<div class="wordcloud">${s.top_content.slice(0, 80).map((w) => `<span style="font-size:${(0.8 + w.c / mx * 1.9).toFixed(2)}em;color:hsl(${8 - w.c / mx * 8} ${60 + w.c / mx * 30}% ${55 + w.c / mx * 15}%)" data-w="${esc(w.w)}">${esc(w.w)}</span>`).join("")}</div>`;
  $$("#in-cloud [data-w]").forEach((sp) => sp.onclick = () => inspect(sp.dataset.w));
  requestAnimationFrame(() => { const cv = $("#in-len"); if (cv) ch.bars(cv, { x: s.word_lengths.map((_, i) => i), y: s.word_lengths, h: cv.parentElement.clientHeight }); });
  const exRun = async (k) => { $("#in-ex-out").innerHTML = '<div class="skeleton"></div>'; try { const r = await api.get("/text/extract?kind=" + k);
    $("#in-ex-out").innerHTML = `<div class="hint" style="margin-bottom:8px">${fmt.n(r.distinct)} distinct · ${fmt.n(r.total)} total <span class="timing">${fmt.ms(r.ms)}</span></div><div class="toks">${r.items.slice(0, 80).map((it) => `<span class="tok">${esc(it.v)} <span class="n">${fmt.big(it.c)}</span></span>`).join("")}</div>`;
  } catch (e) { $("#in-ex-out").innerHTML = empty(esc(e.message)); } };
  $$("#in-ex [data-ex]").forEach((b) => b.onclick = () => { $$("#in-ex button").forEach((x) => x.classList.toggle("on", x === b)); exRun(b.dataset.ex); });
  exRun("names");
}

// ---- TRANSFORM ----------------------------------------------------------------
async function tTransform() {
  let T; try { T = await api.get("/text/transforms"); } catch (e) { stage("one", pane({ t: "Transform", body: empty(esc(e.message)) })); return; }
  const groups = [["Clean up", ["clean", "html", "spaces", "dedupe", "nopunct", "nodigits"]], ["Find & replace", ["replace", "regex"]], ["Change case", ["lower", "upper", "title", "sentence"]], ["Lines", ["sortlines", "keep", "drop"]]];
  stage("12", `<section class="pane"><div class="pane-h"><div class="t">Transforms</div><div class="meta">each makes a new, undoable version</div></div><div class="pane-b flush">
      ${groups.map(([g, ops]) => `<div class="grp">${g}</div><div class="list">${ops.filter((o) => T[o]).map((o) => `<div class="li" data-op="${o}"><div class="tx"><div class="nm">${esc(T[o].name)}</div><div class="sub">${T[o].engine === "GPU" ? "runs on the card" : "CPU"}</div></div></div>`).join("")}</div>`).join("")}</div></section>
    <section class="pane" id="tr-p"><div class="pane-h"><div class="t" id="tr-t">Pick a transform</div><div class="tools" id="tr-tools"></div></div><div class="pane-b" id="tr-body">${empty("Everything runs on the whole text. <b>Clean web markup</b> is the one to use on saved web pages and JSON exports.")}</div></section>`);
  $$("#te-stage [data-op]").forEach((b) => b.onclick = () => { $$("#te-stage [data-op]").forEach((x) => x.classList.toggle("on", x === b)); trConfig(b.dataset.op, T[b.dataset.op]); });
  const first = $('#te-stage [data-op="clean"]'); if (first) first.click();
}
function trConfig(op, spec) {
  const fields = {
    replace: `<div class="fld two"><label>Find</label><input class="in sm" id="p-find"></div><div class="fld two"><label>Replace with</label><input class="in sm" id="p-replace"></div><div class="tb"><label class="toggle"><input type="checkbox" id="p-case"><i></i>Match case</label><label class="toggle"><input type="checkbox" id="p-whole" checked><i></i>Whole words</label></div>`,
    regex: `<div class="fld two"><label>Pattern</label><input class="in sm mono" id="p-pattern"></div><div class="fld two"><label>Replace with</label><input class="in sm mono" id="p-replace" placeholder="\\1 for groups"></div>`,
    sortlines: `<label class="toggle"><input type="checkbox" id="p-reverse"><i></i>Reverse (Z→A)</label>`,
    keep: `<div class="fld two"><label>Keep lines with</label><input class="in sm" id="p-pattern"></div>`,
    drop: `<div class="fld two"><label>Drop lines with</label><input class="in sm" id="p-pattern"></div>`,
    clean: `<div class="hint">Decodes HTML entities (&amp;quot; → "), removes tags, scripts, styles, URLs, e-mail addresses and long hex ids, and reduces JSON or markup lines to their human-readable strings. Use Preview to check the result before you apply it.</div>`,
  }[op] || `<div class="hint">No options — applies to the whole text.</div>`;
  $("#tr-t").textContent = spec.name;
  $("#tr-tools").innerHTML = `<button class="btn ghost sm" id="tr-prev">Preview</button><button class="btn sm" id="tr-apply">${icon("bolt")} Apply to all ${fmt.big(C.words)} words</button>`;
  $("#tr-body").innerHTML = `<div class="fields" style="max-width:560px">${fields}</div><div id="tr-preview" style="margin-top:14px"></div>`;
  const params = () => { const g = (id) => { const e = $("#p-" + id); return e ? (e.type === "checkbox" ? e.checked : e.value) : undefined; };
    return { find: g("find"), replace: g("replace"), pattern: g("pattern"), case: g("case"), whole: g("whole"), reverse: g("reverse") }; };
  $("#tr-prev").onclick = async () => {
    $("#tr-preview").innerHTML = '<div class="skeleton"></div>';
    try { const r = await api.get(`/text/preview?op=${op}&params=${enc(JSON.stringify(params()))}`);
      $("#tr-preview").innerHTML = `<div class="diff"><div><div class="sec-t">Before</div><pre>${esc(r.before)}</pre></div><div><div class="sec-t">After</div><pre>${esc(r.after)}</pre></div></div>`;
    } catch (e) { $("#tr-preview").innerHTML = empty(esc(e.message)); }
  };
  $("#tr-apply").onclick = () => runJob(api.post("/text/transform", { op, params: params() }), spec.name);
}

// ---------------------------------------------------------------- tokens & inspector
function tokHtml(w, style = "") { const off = offSet().has(String(w).toLowerCase()); return `<span class="tok ${off ? "off" : ""}" data-tok="${esc(w)}"${style ? ` style="${style}"` : ""} title="${off ? "click to bring back" : "click to cross out · double-click to inspect"}">${esc(w)}</span>`; }
function bindToks(root) {
  root.querySelectorAll("[data-tok]").forEach((t) => {
    t.onclick = () => { const off = !t.classList.contains("off"); t.classList.toggle("off", off); setOff(t.dataset.tok, off); };
    t.ondblclick = (e) => { e.preventDefault(); inspect(t.dataset.tok); };
  });
}
async function inspect(word, quiet) {
  word = String(word || "").trim(); if (!word) return;
  sel = word;
  if (tab === "embed") drawMap();
  const body = $("#ti-body"), my = latest("insp");
  if (!quiet) reveal(body);
  if (!quiet) body.innerHTML = '<div class="skeleton" style="height:80px"></div>';
  const off = offSet().has(word.toLowerCase());
  $("#ti-tools").innerHTML = `<button class="btn ${off ? "" : "ghost"} xs" id="ti-toggle">${off ? "Bring back" : "Cross out"}</button>`;
  $("#ti-toggle").onclick = () => setOff(word, !off);
  try {
    const [nx, pv, sim, ctx] = await Promise.all([api.get(`/text/near?q=${enc(word)}&side=next&top=10`), api.get(`/text/near?q=${enc(word)}&side=prev&top=10`),
      api.get(`/text/similar?word=${enc(word)}&k=24`).catch(() => ({ items: [] })), api.get(`/text/search?q=${enc(word)}&limit=6&sample=1`).catch(() => ({ hits: [] }))]);
    if (!my()) return;
    $("#ti-meta").textContent = `${fmt.n(nx.count)} mentions`;
    const bars = (r) => { if (!r.items.length) return '<div class="hint">nothing passes the filter</div>'; const mx = r.items[0].count; return r.items.map((it) => `<div class="barrow" data-w="${esc(it.word)}"><i style="width:${it.count / mx * 100}%"></i><span>${esc(it.word)}</span><b>${fmt.pct(it.p, 1)}</b></div>`).join(""); };
    body.innerHTML = `<div class="ti-word ${off ? "off" : ""}">${esc(word)}</div><div class="hint" style="margin:-2px 0 10px">${off ? "crossed out — hidden from every view" : `${nx.distinct} different words follow it · ${nx.entropy_bits} bits of surprise`}</div>
      <div class="sec-t">Follows →</div>${bars(nx)}
      <div class="sec-t" style="margin-top:12px">← Precedes</div>${bars(pv)}
      <div class="sec-t" style="margin-top:12px">Similar meaning <span class="x dim">embedding neighbours</span></div>${sim.items && sim.items.length ? `<div class="toks">${sim.items.map((it) => tokHtml(it.w, `background:rgba(212,0,0,${Math.max(0, it.sim * 0.45).toFixed(2)})`)).join("")}</div>` : `<div class="hint">${sim.known === false ? "not common enough to embed" : "—"}</div>`}
      <div class="sec-t" style="margin-top:12px">In context</div>${(ctx.hits || []).map((h) => `<div class="ti-ctx">…${esc(h.left.slice(-60))} <b>${esc(h.match)}</b> ${esc(h.right.slice(0, 60))}…${h.doc ? `<div class="d">${esc(h.doc)}</div>` : ""}</div>`).join("") || '<div class="hint">—</div>'}`;
    $$("#ti-body .barrow").forEach((r) => r.onclick = () => inspect(r.dataset.w));
    bindToks(body);
  } catch (e) { if (my()) body.innerHTML = empty(esc(e.message)); }
}


// ---- SOURCES (exact-match tracing and infinite-gram continuation) --------
function tSources() {
  const g = S.src;
  stage("21", `<section class="pane" id="ts-p"><div class="pane-h"><div class="seg" id="ts-mode"><button data-m="trace" title="Which parts of a text appear word for word in the corpus, and where">Trace a text</button><button data-m="continue" title="Continue from the longest exact match — every word with its source">Continue a text</button></div>
      <div class="meta" id="ts-meta"></div><div class="tools"><button class="btn sm" id="ts-go">${icon("eye")} Trace</button></div></div>
      <div class="sec ts-ctl" id="ts-ctl"></div>
      <div class="pane-b"><div class="gen te-gen ts-out" id="ts-out"></div></div>
      <div class="pane-f" id="ts-f">&nbsp;</div></section>`
    + `<div class="col"><section class="pane fit sm-verdict ts-verdict"><div class="hl" id="ts-hl">—</div><div class="txt"><div class="nm" id="ts-nm">Exact sources</div><p id="ts-sent"></p></div></section>
      <section class="pane grow"><div class="pane-h"><div class="t" id="ts-rt">Where it comes from</div><div class="meta" id="ts-rmeta"></div></div><div class="pane-b" id="ts-right"></div></section></div>`);
  $$("#ts-mode [data-m]").forEach((b) => b.onclick = () => { g.mode = b.dataset.m; g.last = null; g.sel = -1; tSources(); });
  $$("#ts-mode [data-m]").forEach((b) => b.classList.toggle("on", b.dataset.m === g.mode));
  if (g.mode === "trace") {
    $("#ts-ctl").innerHTML = `<textarea class="in ts-in" id="ts-text" rows="7" placeholder="Paste a paragraph, an essay, an email… Each stretch that appears word for word in “${esc(C.name)}” is traced to its documents.">${esc(g.text)}</textarea>
      <div class="tg-row"><div class="fld"><label>Count a match from</label><input type="range" id="ts-min" min="3" max="20" value="${g.min}"><span class="v" id="ts-min-v">${g.min} words</span></div><span class="hint">shorter stretches match by accident more often — the shuffled control shows how much</span></div>`;
    $("#ts-text").oninput = (e) => { g.text = e.target.value; };
    $("#ts-min").oninput = (e) => { g.min = +e.target.value; $("#ts-min-v").textContent = g.min + " words"; };
    $("#ts-go").innerHTML = `${icon("eye")} Trace`;
  } else {
    $("#ts-ctl").innerHTML = `<input class="in" id="ts-prompt" placeholder="Start with a few words — e.g. a phrase you remember from the corpus" value="${esc(g.prompt)}">
      <div class="tg-row tg-knobs"><div class="fld"><label>Length</label><input type="range" id="ts-n" min="20" max="300" step="10" value="${g.n}"><span class="v" id="ts-n-v">${g.n}</span></div>
        <div class="fld"><label>Longest context</label><input type="range" id="ts-ctx" min="1" max="60" value="${g.ctx}"><span class="v" id="ts-ctx-v">${g.ctx}</span></div>
        <div class="fld"><label>Wildness</label><input type="range" id="ts-temp" min="0.3" max="2" step="0.05" value="${g.temp}"><span class="v" id="ts-temp-v">${g.temp}</span></div></div>`;
    $("#ts-prompt").oninput = (e) => { g.prompt = e.target.value; };
    $("#ts-prompt").onkeydown = (e) => { if (e.key === "Enter") runSources(); };
    [["#ts-n", "n"], ["#ts-ctx", "ctx"], ["#ts-temp", "temp"]].forEach(([id, k]) => { $(id).oninput = (e) => { g[k] = +e.target.value; $(id + "-v").textContent = e.target.value; }; });
    $("#ts-go").innerHTML = `${icon("spark")} Continue`;
  }
  $("#ts-go").onclick = runSources;
  if (g.last) showSources(g.last);
  else {
    $("#ts-out").innerHTML = empty(g.mode === "trace" ? "Paste text above and press Trace. Copied stretches light up; click one to see every document it appears in." : "Give it a start and press Continue. The colour of each word shows how long a stretch of exact context chose it.");
    $("#ts-sent").textContent = g.mode === "trace" ? "Finds the passages of a text that appear verbatim in the corpus — a plagiarism, quote and provenance check — and compares against the same words shuffled." : "Infinite-gram continuation: the next word comes from wherever the longest ending of the text so far occurs in the corpus.";
    $("#ts-right").innerHTML = ""; $("#ts-hl").textContent = "—";
  }
}
async function runSources() {
  const g = S.src, btn = $("#ts-go"); btn.disabled = true; $("#ts-p").classList.add("is-busy");
  try {
    g.last = g.mode === "trace" ? await api.post("/text/sources/trace", { text: g.text, min_words: g.min })
      : await api.post("/text/sources/continue", { prompt: g.prompt, n: g.n, temp: g.temp, max_ctx: g.ctx });
    g.last.mode = g.mode; g.sel = -1; showSources(g.last);
  } catch (e) { $("#ts-out").innerHTML = empty(esc(e.message)); }
  btn.disabled = false; $("#ts-p").classList.remove("is-busy");
}
function showSources(r) {
  const g = S.src;
  if (r.mode === "trace") {
    $("#ts-hl").className = "hl " + (r.coverage > 0.5 ? "bad" : r.coverage > 0.1 ? "warn" : "good");
    $("#ts-hl").textContent = Math.round(r.coverage * 100) + "%";
    $("#ts-nm").textContent = "traced to the corpus";
    $("#ts-sent").textContent = r.sentence;
    const segs = r.segments;
    $("#ts-out").innerHTML = segs.map((s, i) => s.words ? `<span class="ts-m ${g.sel === i ? "on" : ""}" data-i="${i}" style="--a:${Math.min(1, 0.25 + s.words / 40).toFixed(2)}" title="${s.words} words · ${fmt.n(s.count)}× in ${s.ndocs} document${s.ndocs > 1 ? "s" : ""}">${esc(s.t)}</span>` : `<span class="ts-own">${esc(s.t)}</span>`).join("");
    $$("#ts-out [data-i]").forEach((el) => el.onclick = () => { g.sel = +el.dataset.i; $$("#ts-out [data-i]").forEach((x) => x.classList.toggle("on", x === el)); traceDetail(r); });
    $("#ts-f").innerHTML = `<span><b>${fmt.n(r.words)}</b> words</span><span><b>${r.spans}</b> copied stretches</span><span>shuffled control <b>${Math.round(r.coverage_shuffled * 100)}%</b></span><span>${r.scans} GPU scans</span>${r.unknown ? `<span>${r.unknown} words not in the corpus</span>` : ""}<span class="timing">${fmt.ms(r.ms)}</span>`;
    $("#ts-meta").textContent = `stretches of ${r.min_words}+ words`;
    traceDetail(r);
  } else {
    const words = r.words;
    $("#ts-hl").className = "hl " + (r.copied_run >= 20 ? "bad" : r.copied_run >= 8 ? "warn" : "good");
    $("#ts-hl").textContent = r.mean_ctx.toFixed(1);
    $("#ts-nm").textContent = "words of context, on average";
    $("#ts-sent").textContent = r.copied_run >= 8 ? `${r.copied_run} words in a row had only one possible continuation — that part is a quotation${r.copied_doc ? " of " + r.copied_doc : ""}. ${r.forced} of ${words.length} words had no alternative. Shorten “Longest context” or increase Wildness to mix the sources.`
      : `${r.forced} of ${words.length} words had only one possible continuation; the longest forced run is ${r.copied_run} words, so this blends several sources.`;
    $("#ts-out").innerHTML = (r.prompt ? `<span class="seed">${esc(r.prompt)}</span> ` : "") + words.map((w, i) => {
      const nx = words[i + 1]?.w || "", sp = /^[\w"'(À-￿]/.test(nx) ? " " : "";
      return `<span class="w ts-w" data-i="${i}" style="--a:${Math.min(1, w.ctx / 16).toFixed(2)}" title="${w.ctx} words of context · ${w.options} possible next word${w.options === 1 ? "" : "s"}">${esc(w.w)}</span>${sp}`;
    }).join("");
    $$("#ts-out .ts-w").forEach((el) => el.onclick = () => contDetail(r, +el.dataset.i));
    $("#ts-f").innerHTML = `<span><b>${words.length}</b> words</span><span>mean context <b>${r.mean_ctx}</b></span><span>forced <b>${r.forced}</b></span><span>${r.scans} GPU scans</span><span class="timing">${fmt.ms(r.ms)}</span>`;
    $("#ts-meta").textContent = "darker = longer exact context";
    contDetail(r, 0);
  }
}
function traceDetail(r) {
  const g = S.src, s = r.segments[g.sel];
  if (!s || !s.words) {
    $("#ts-rt").textContent = "Top sources"; $("#ts-rmeta").textContent = r.top_docs.length ? "copied words per document" : "";
    const mx = Math.max(1, ...r.top_docs.map((d) => d[1]));
    $("#ts-right").innerHTML = r.top_docs.length ? `<div class="hint" style="margin-bottom:8px">Click a highlighted stretch to see its context and every document it appears in.</div>${r.top_docs.map(([d, n]) => `<div class="barrow" title="${esc(d)}"><i style="width:${n / mx * 100}%"></i><span>${esc(d)}</span><b>${n}</b></div>`).join("")}`
      : empty("Nothing traced.");
    return;
  }
  $("#ts-rt").textContent = "This stretch"; $("#ts-rmeta").textContent = `${s.words} words · ${fmt.n(s.count)}${s.capped ? "+" : ""}× · ${s.ndocs} document${s.ndocs > 1 ? "s" : ""}`;
  const c = s.context;
  $("#ts-right").innerHTML = `${c ? `<div class="prov">…${esc(c.left)}<b>${esc(c.match)}</b>${esc(c.right)}…${c.doc ? `<div class="dim" style="margin-top:6px">${esc(c.doc)}</div>` : ""}</div>` : ""}
    ${c ? openBtn(c.byte, c.end) : ""}
    <div class="sec-t" style="margin-top:14px">Appears in <span class="dim">· click to open</span></div>${s.docs.map(([d, n]) => `<div class="barrow ${s.at && s.at[d] ? "rd-open link" : ""}" ${s.at && s.at[d] ? `data-at="${s.at[d][0]}" data-end="${s.at[d][1]}" title="Open ${esc(d)} at this stretch"` : ""}><i style="width:${n / s.docs[0][1] * 100}%"></i><span>${esc(d)}</span><b>${n}×</b></div>`).join("")}
    <button class="btn ghost xs" id="ts-find" style="margin-top:10px">${icon("search")} Every place it appears</button>`;
  bindOpen($("#ts-right"), []);
  $("#ts-find").onclick = () => { tab = "search"; renderStage(); const q = $("#se-q"); if (q) { q.value = s.t.split(/\s+/).slice(0, 8).join(" "); q.dispatchEvent(new Event("input")); } };
}
async function contDetail(r, i) {
  const w = r.words[i]; if (!w) return;
  $$("#ts-out .ts-w").forEach((x) => x.classList.toggle("on", +x.dataset.i === i));
  $("#ts-rt").textContent = `“${w.w}”`; $("#ts-rmeta").textContent = `${w.ctx} words of context · ${fmt.n(w.seen)} occurrences · ${w.options} option${w.options === 1 ? "" : "s"}`;
  try {
    const s = await api.get("/text/source?pos=" + w.src);
    $("#ts-right").innerHTML = `<div class="hint" style="margin-bottom:8px">${w.options === 1 ? "In the corpus, only one word ever comes after this context. Thus this word had no alternative." : `${w.options} different words follow this context in the corpus; this one was drawn in proportion to how often.`}</div>
      <div class="prov">…${esc(s.left)}<b>${esc(s.match)}</b>${esc(s.right)}…${s.doc ? `<div class="dim" style="margin-top:6px">${esc(s.doc)}</div>` : ""}</div>${openBtn(s.byte, s.end)}`;
    bindOpen($("#ts-right"), []);
  } catch (e) { $("#ts-right").innerHTML = empty(esc(e.message)); }
}
