// VectorLM (prototype): three tabs.
//   ASK   - a simple question about the corpus on the card -> BM25 passages -> the best sentence and a short answer,
//           with the source passage (text.vectorlm.ask). The corpus LM can continue the answer; that text is marked.
//   GRAPH - the simple graph store: find nodes, see a node and its neighbours, add nodes and edges (graph.* models).
//   API   - how to call VectorLM and the graph from scripts, the CLI, MCP and the OpenAI-style endpoint.
// A warning badge is always in the bar (the same text the server sends with every answer).
import { $, $$, esc, fmt, toast } from "./core.js";
import { callModel } from "./hub.js";

const WARN = "VectorLM is a prototype that is under development. It is not a complete LLM. Do not use it for serious work. The text that it makes is often poor, and its answers are often wrong. Use it as a lab tool, not as a working LLM.";
const ST = { tab: "ask", corpus: null, corpora: [], busy: false, node: null };
const TABS = [["ask", "Ask"], ["graph", "Graph"], ["api", "API"]];
const EXAMPLES = {
  essays: ["When did the February winter storm hit Texas?", "Who wrote the Mad Scientist blog?", "What is a model-driven enterprise?", "Where were the astrolabes made?"],
  novels: ["Who is Mr. Darcy?", "What is the name of Captain Ahab's ship?", "Who wrote to Mina Harker?", "Where does Jane Eyre meet Mr. Rochester?"],
  other: ["What is the main subject of these documents?", "Who is mentioned most often?"],
};

async function vm(name, params = {}) { const env = await callModel(name, params); return env.result; }
const badge = () => `<span class="vq-warn" tabindex="0" title="${esc(WARN)}" aria-label="${esc(WARN)}"><b>!</b> Prototype</span>`;

export default {
  id: "vlm", title: "VectorLM", sub: "simple questions, answered from your documents (prototype)", icon: "vlm",
  mount(el) {
    el.innerHTML = `<div class="ws vq">
      <section class="pane fit"><div class="pane-h"><div class="tabs" id="vq-tabs">${TABS.map(([k, l]) => `<button data-tab="${k}" class="${k === "ask" ? "on" : ""}">${l}</button>`).join("")}</div>
        <div class="meta" id="vq-meta"></div><div class="tools">${badge()}</div></div></section>
      <div class="vq-body" id="vq-body"></div></div>`;
    $$("#vq-tabs [data-tab]").forEach((b) => b.onclick = () => select(b.dataset.tab));
    select("ask");
  },
  show(p = {}) {
    if (p.tab && TABS.some(([k]) => k === p.tab)) select(p.tab);
    if (p.q && ST.tab === "ask" && $("#vq-q")) { $("#vq-q").value = p.q; ask(); }
  },
};

function select(tab) {
  ST.tab = tab;
  $$("#vq-tabs [data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  ({ ask: renderAsk, graph: renderGraph, api: renderApi })[tab]();
}

// ---------------------------------------------------------------- ASK
async function renderAsk() {
  const body = $("#vq-body");
  body.className = "vq-body vq-ask";
  body.innerHTML = `<section class="pane"><div class="pane-h"><div class="t">Ask</div>
      <select class="sel sm" id="vq-corpus" aria-label="Corpus"></select><div class="meta" id="vq-cstat"></div>
      <div class="tools"><label class="vq-opt" title="The corpus LM writes more text after the answer. That text is not checked."><input type="checkbox" id="vq-gen"> Continue with the LM</label></div></div>
    <div class="pane-b"><div class="vq-askrow"><input class="in" id="vq-q" placeholder="Ask a simple question about the documents…" autocomplete="off"><button class="btn sm" id="vq-go" data-primary>Ask</button></div>
      <div class="chips" id="vq-ex"></div>
      <div id="vq-out"><p class="hint">VectorLM finds the passages that match your question (BM25), selects the best sentence and takes a short answer from it. It shows the source, so you can check the answer. ${esc(WARN)}</p></div></div>
    <div class="pane-f"><span id="vq-foot">${badge()}</span><span class="timing" id="vq-time"></span></div></section>`;
  $("#vq-go").onclick = ask;
  $("#vq-q").onkeydown = (e) => { if (e.key === "Enter") ask(); };
  $("#vq-corpus").onchange = () => activate($("#vq-corpus").value);
  await loadCorpora();
}

async function loadCorpora() {
  try { ST.corpora = await fetch("/api/text/corpora").then((r) => r.json()); } catch (e) { ST.corpora = []; }
  const act = ST.corpora.find((c) => c.active);
  ST.corpus = act ? act.id : null;
  const sel = $("#vq-corpus"); if (!sel) return;
  sel.innerHTML = (act ? "" : `<option value="">Select a corpus…</option>`) + ST.corpora.map((c) => `<option value="${c.id}" ${c.active ? "selected" : ""}>${esc(c.name || c.id)}</option>`).join("");
  $("#vq-cstat").textContent = act ? `${act.docs} documents · ${fmt.bytes ? fmt.bytes(act.bytes) : Math.round(act.bytes / 1e6) + " MB"}` : "no corpus on the card";
  const nm = (act && act.name || "").toLowerCase();
  const ex = nm.includes("essay") ? EXAMPLES.essays : nm.includes("novel") ? EXAMPLES.novels : EXAMPLES.other;
  $("#vq-ex").innerHTML = ex.map((x) => `<button class="chip vq-exq">${esc(x)}</button>`).join("");
  $$("#vq-ex .vq-exq").forEach((b) => b.onclick = () => { $("#vq-q").value = b.textContent; ask(); });
}

async function activate(id) {
  if (!id || id === ST.corpus) return;
  const out = $("#vq-out");
  out.innerHTML = `<p class="hint">Loading the corpus onto the card…</p>`;
  try {
    await callModel("text.corpus.activate", { corpus: id }, { onStep: (j) => { out.innerHTML = `<p class="hint">Loading the corpus onto the card… ${Math.round(100 * (j.progress || 0))}% ${esc(j.message || "")}</p>`; } });
    out.innerHTML = `<p class="hint">The corpus is on the card. Ask a question.</p>`;
  } catch (e) { out.innerHTML = `<p class="hint bad">${esc(e.message)}</p>`; }
  loadCorpora();
}

// single line breaks are hard wraps (Gutenberg texts): show them as spaces, keep the blank lines between paragraphs
const unwrap = (t) => (t || "").replace(/\n[ \t]*\n/g, "\u0001").replace(/[ \t]*\n[ \t]*/g, " ").replace(/\u0001/g, "\n\n").replace(/ {2,}/g, " ");
const mark = (s, span) => {
  if (!span) return esc(s);
  const i = s.indexOf(span);
  return i < 0 ? esc(s) : esc(s.slice(0, i)) + `<mark>${esc(span)}</mark>` + esc(s.slice(i + span.length));
};

async function ask() {
  const q = $("#vq-q").value.trim(); if (!q || ST.busy) return;
  if (!ST.corpus) { toast("Select a corpus first.", "warn"); return; }
  ST.busy = true; $("#vq-go").disabled = true;
  const out = $("#vq-out"), t0 = performance.now();
  out.innerHTML = `<p class="hint">Searching the passages…</p>`;
  try {
    const r = await vm("text.vectorlm.ask", { prompt: q, generate: $("#vq-gen").checked, words: 40 });
    const short = r.found && r.span && r.span !== r.sentence;
    out.innerHTML = `<div class="vq-ans ${r.found ? "" : "none"}">
        ${short ? `<div class="vq-short">${esc(r.answer)}</div>` : ""}
        <p class="vq-sent">${r.found ? mark(r.sentence, r.span) : esc(r.sentence)}</p>
        ${r.found ? `<div class="vq-src">Source: <b>${esc(r.doc || "?")}</b> · match ${Math.round(100 * r.confidence)}% of the question terms · question kind: ${esc(r.kind)}</div>` : ""}
        ${r.generated && r.generated.text ? `<div class="vq-gen"><div class="vq-gl">Written by the corpus LM, not checked</div><p>${esc(r.generated.text)}</p></div>` : ""}
        ${r.generated && r.generated.error ? `<div class="vq-gen"><div class="vq-gl">The corpus LM could not continue</div><p class="dim">${esc(r.generated.error)}</p></div>` : ""}
      </div>
      <div class="vq-ph">Passages${r.found ? "" : " (the closest)"}</div>
      ${(r.passages || []).map((p, i) => `<div class="vq-pass ${r.found && i === 0 ? "best" : ""}"><div class="vq-pd">${i + 1}. ${esc(p.doc)} <span class="dim">· BM25 ${p.score}</span></div><p>${r.found && i === 0 ? mark(unwrap(p.text), r.sentence) : esc(unwrap(p.text))}</p></div>`).join("")}`;
    $("#vq-time").textContent = `answered in ${fmt.ms ? fmt.ms(performance.now() - t0) : Math.round(performance.now() - t0) + " ms"} · server ${r.ms} ms`;
  } catch (e) { out.innerHTML = `<p class="hint bad">${esc(e.message)}</p>`; }
  ST.busy = false; $("#vq-go").disabled = false;
}

// ---------------------------------------------------------------- GRAPH
async function renderGraph() {
  const body = $("#vq-body");
  body.className = "vq-body vq-graph";
  body.innerHTML = `<section class="pane"><div class="pane-h"><div class="t">Nodes</div><div class="meta" id="vg-stat"></div></div>
      <div class="pane-b flush"><div class="vg-find"><input class="in sm" id="vg-q" placeholder="Find a node…" autocomplete="off"></div><div class="list" id="vg-list"></div></div>
      <div class="pane-act"><form id="vg-addn" class="vg-form"><input class="in sm" name="label" placeholder="New node label" required><input class="in sm" name="kind" placeholder="Kind (optional)"><button class="btn sm">Add node</button></form></div></section>
    <section class="pane"><div class="pane-h"><div class="t" id="vg-title">Neighbours</div><div class="meta" id="vg-nmeta"></div><div class="tools"><button class="btn ghost xs" id="vg-del" hidden>Delete node</button></div></div>
      <div class="pane-b flush"><svg id="vg-svg" class="vg-svg" viewBox="-300 -200 600 400" role="img" aria-label="The selected node and its neighbours"></svg><div id="vg-edges" class="vg-edges"></div></div>
      <div class="pane-act"><form id="vg-adde" class="vg-form"><input class="in sm" name="src" placeholder="From (label or id)" required><input class="in sm" name="rel" placeholder="Relation" required><input class="in sm" name="dst" placeholder="To (label or id)" required><button class="btn sm">Add edge</button></form>
        <div class="hint">A label that does not exist yet becomes a new node.</div></div></section>`;
  let t = 0;
  $("#vg-q").oninput = () => { clearTimeout(t); t = setTimeout(listNodes, 160); };
  $("#vg-addn").onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target);
    try { const n = await vm("graph.node.add", { label: f.get("label"), kind: f.get("kind") || "" }); e.target.reset(); await listNodes(); openNode(n.id); } catch (er) { toast(er.message, "bad"); } };
  $("#vg-adde").onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target);
    try { const ed = await vm("graph.edge.add", { src: f.get("src"), rel: f.get("rel"), dst: f.get("dst") }); e.target.reset(); await listNodes(); openNode(ed.src); } catch (er) { toast(er.message, "bad"); } };
  $("#vg-del").onclick = async () => { if (!ST.node || !confirm("Delete this node and its edges?")) return;
    await vm("graph.delete", { what: "node", id: ST.node }); ST.node = null; await listNodes(); drawEmpty(); };
  await listNodes();
  if (ST.node) openNode(ST.node); else drawEmpty();
}

async function listNodes() {
  const q = ($("#vg-q") || {}).value || "";
  try {
    const [s, r] = await Promise.all([vm("graph.stats"), vm("graph.nodes", { q, limit: 200 })]);
    $("#vg-stat").textContent = `${s.nodes} nodes · ${s.edges} edges`;
    $("#vg-list").innerHTML = r.nodes.length ? r.nodes.map((n) => `<div class="li ${n.id === ST.node ? "on" : ""}" data-id="${n.id}"><span class="vg-l">${esc(n.label)}</span>${n.kind ? `<span class="dim">${esc(n.kind)}</span>` : ""}<span class="vg-d">${n.degree}</span></div>`).join("")
      : `<div class="empty">${q ? "No node matches." : "The graph is empty. Add a node or an edge below."}</div>`;
    $$("#vg-list .li").forEach((li) => li.onclick = () => openNode(+li.dataset.id));
  } catch (e) { $("#vg-list").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

function drawEmpty() {
  $("#vg-svg").innerHTML = `<text x="0" y="0" text-anchor="middle" class="vg-hint">Select a node to see its neighbours</text>`;
  $("#vg-edges").innerHTML = ""; $("#vg-title").textContent = "Neighbours"; $("#vg-nmeta").textContent = ""; $("#vg-del").hidden = true;
}

async function openNode(id) {
  ST.node = id;
  $$("#vg-list .li").forEach((li) => li.classList.toggle("on", +li.dataset.id === id));
  let r; try { r = await vm("graph.neighbours", { id }); } catch (e) { toast(e.message, "bad"); return; }
  $("#vg-title").textContent = r.node.label; $("#vg-nmeta").textContent = `${r.edges.length} edges`; $("#vg-del").hidden = false;
  const N = r.nodes.slice(0, 24), pos = {}; pos[r.node.id] = [0, 0];
  N.forEach((n, i) => { const a = 2 * Math.PI * i / Math.max(1, N.length) - Math.PI / 2; pos[n.id] = [230 * Math.cos(a), 150 * Math.sin(a)]; });
  const lab = Object.fromEntries([r.node, ...r.nodes].map((n) => [n.id, n.label]));
  const lines = r.edges.filter((e) => pos[e.src] && pos[e.dst]).map((e) => { const [x1, y1] = pos[e.src], [x2, y2] = pos[e.dst];
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="vg-e"/><text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 4}" text-anchor="middle" class="vg-rel">${esc(e.rel)}</text>`; }).join("");
  const dots = [r.node, ...N].map((n) => { const [x, y] = pos[n.id];
    return `<g class="vg-n ${n.id === r.node.id ? "me" : ""}" data-id="${n.id}"><circle cx="${x}" cy="${y}" r="${n.id === r.node.id ? 9 : 6}"/><text x="${x}" y="${y + 20}" text-anchor="middle">${esc(n.label.slice(0, 26))}</text></g>`; }).join("");
  $("#vg-svg").innerHTML = lines + dots;
  $$("#vg-svg .vg-n").forEach((g) => g.onclick = () => openNode(+g.dataset.id));
  $("#vg-edges").innerHTML = r.edges.map((e) => `<div class="vg-row"><span>${esc(lab[e.src] || e.src)}</span> <code>${esc(e.rel)}</code> <span>${esc(lab[e.dst] || e.dst)}</span>${e.source ? ` <span class="dim">· ${esc(e.source)}</span>` : ""}<button class="btn ghost xs vg-x" data-e="${e.id}" title="Delete this edge">×</button></div>`).join("");
  $$("#vg-edges .vg-x").forEach((b) => b.onclick = async () => { await vm("graph.delete", { what: "edge", id: +b.dataset.e }); openNode(id); listNodes(); });
}

// ---------------------------------------------------------------- API
function renderApi() {
  const body = $("#vq-body");
  body.className = "vq-body vq-api";
  const host = location.origin;
  body.innerHTML = `<section class="pane"><div class="pane-h"><div class="t">Use VectorLM from code</div><div class="tools">${badge()}</div></div><div class="pane-b vq-doc">
    <p>${esc(WARN)}</p>
    <h4>REST</h4><pre>curl -s ${esc(host)}/v1/models/text.vectorlm.ask -H 'Content-Type: application/json' \\
  -d '{"prompt": "Who is Mr. Darcy?"}'</pre>
    <h4>Command line</h4><pre>vf run text.vectorlm.ask prompt="Who is Mr. Darcy?"</pre>
    <h4>MCP</h4><p>The tool <code>text_vectorlm_ask</code> is on the MCP endpoint <code>${esc(host)}/mcp</code>. Its description has the same warning.</p>
    <h4>OpenAI-style endpoint</h4><p>Base URL <code>${esc(host)}/openai/v1</code>, model <code>vectorlm</code>. The last user message is the question. The answer comes from the corpus on the card, and the response has the source passage in <code>vectorlm.passage</code>.</p>
    <h4>Graph store</h4><p>Models <code>graph.stats</code>, <code>graph.nodes</code>, <code>graph.edges</code>, <code>graph.neighbours</code>, <code>graph.node.add</code>, <code>graph.edge.add</code> and <code>graph.delete</code>, on the same REST, CLI and MCP paths.</p>
  </div></section>`;
}
