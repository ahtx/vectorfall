import { $, $$, api, dropZone, esc, fmt, go, icon, pane, toast } from "./core.js";
import { learnFlow, scoreCard } from "./learnflow.js";
import * as ch from "./charts.js";
import { columnTargets, menu, sheet, tsChart } from "./hub.js";

// Data Desk: tables on the left; the selected table fills the rest — a header strip (name, shape, tabs) over one
// workspace per tab. Columns · Rows (grid + row inspector) · Correlations · Projection (PCA) · Group by · Anomalies.
// Tables come from files, a ticker download or pasted numbers; every numeric column can be sent on to the other tools.
// Unusable operations come back as 400s with a reason; those are shown in place, never as a broken pane.
let tables = [], cur = null, S = null, tab = "columns", hideEmpty = true, colFilter = "";
const R = { sort: "", desc: 1, col: "", op: "contains", val: "", offset: 0, limit: 100, sel: null, rows: null };
const G = { by: "", col: "", agg: "count" };
let pcaK = 4, seq = 0;
const TABS = [["columns", "Columns"], ["rows", "Rows"], ["corr", "Correlations"], ["pca", "Projection"], ["group", "Group by"], ["watch", "Anomalies"]];
let want = null;                                         // a deep link waiting for its table: { table, tab, cols }

export default {
  id: "data", title: "Data Desk", sub: "spreadsheets, understood instantly", icon: "data",
  mount(el) {
    el.innerHTML = `<div class="ws side-l dd">
      <div class="col">
        <section class="pane grow"><div class="pane-h"><div class="t">Tables</div><div class="meta" id="dt-count"></div><div class="tools"><button class="btn ghost xs" id="dt-tick" title="Download daily prices from Yahoo Finance as a table">${icon("trend")} Ticker</button><button class="btn ghost xs" id="dt-paste" title="Paste numbers or a CSV">${icon("plus")} Paste</button></div></div>
          <div class="pane-b flush"><div class="drop dd-drop" id="dt-drop">${icon("upload")}<span><b>Add a table</b> — drop or click<br><span class="hint">CSV · TSV · TXT · XLSX</span></span></div><div class="list" id="dt-list"></div></div></section>
      </div>
      <div class="col" id="dt-main">
        <section class="pane fit dd-head"><div class="dd-title"><div class="nm" id="dt-name">No table</div><div class="chips" id="dt-chips"></div><button class="btn ghost xs" id="dt-csv" hidden title="The whole table as a CSV file">Download CSV</button></div>
          <div class="tabs" id="dt-tabs">${TABS.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? "on" : ""}">${l}</button>`).join("")}</div></section>
        <div class="dd-body grow" id="dt-body">${msg("data", "Drop a spreadsheet", "CSV, TSV or Excel. The card calculates the statistics, correlations and clusters.")}</div>
      </div>
    </div>`;
    dropZone($("#dt-drop"), upload, ".csv,.tsv,.txt,.xlsx,.xlsm");
    $("#dt-tick").onclick = tickerSheet;
    $("#dt-paste").onclick = pasteSheet;
    $$("#dt-tabs [data-tab]").forEach((b) => b.onclick = () => { tab = b.dataset.tab; $$("#dt-tabs [data-tab]").forEach((x) => x.classList.toggle("on", x === b)); renderTab(); });
    window.addEventListener("resize", () => { if (S && document.querySelector("#view-data.on")) renderTab(true); });
    reload();
  },
  show(p = {}) {
    if (p.tab && TABS.some(([k]) => k === p.tab)) setTab(p.tab, false);
    if (p.table) { want = p; if (p.table !== cur && tables.length) { if (tables.find((t) => t.id === p.table)) pick(p.table); else reload(p.table); return; } }
    if (p.cols && p.table === cur && S) { A.tid = null; A.want = p.cols.split("|"); }
    if (S) requestAnimationFrame(() => renderTab(!p.tab && !p.cols));
  },
};
function setTab(k, render = true) {
  tab = k; $$("#dt-tabs [data-tab]").forEach((x) => x.classList.toggle("on", x.dataset.tab === k));
  if (render) renderTab();
}

function msg(ic, title, text, cls = "") {
  return `<section class="pane ${cls}" style="height:100%"><div class="pane-b center"><div class="dd-msg">${icon(ic)}<b>${esc(title)}</b><span>${text}</span></div></div></section>`;
}
const cap = (t) => { t = String(t || ""); return t.charAt(0).toUpperCase() + t.slice(1); };
const inlineMsg = (title, text) => `<div class="dd-msg">${icon("data")}<b>${esc(title)}</b><span>${text}</span></div>`;

async function reload(selectId) {
  try { tables = await api.get("/tables"); } catch (e) { $("#dt-list").innerHTML = inlineMsg("Couldn't list tables", esc(e.message)); return; }
  $("#dt-count").textContent = tables.length ? `${tables.length}` : "";
  $("#dt-list").innerHTML = tables.map((t) => `<div class="li ${cur === t.id ? "on" : ""}" data-id="${t.id}" title="${esc(t.name)}">
      <div class="ic">${icon("data")}</div><div class="tx"><div class="nm">${esc(t.name)}</div>
      <div class="sub">${fmt.n(t.rows)} rows · ${(t.columns || []).length} cols · ${fmt.ago(t.added)}</div></div>
      <button class="iconbtn dt-del" data-del="${t.id}" title="Delete this table">${icon("trash")}</button></div>`).join("") ||
    `<div class="hint" style="padding:12px">No tables yet.</div>`;
  $$("#dt-list [data-id]").forEach((b) => b.onclick = () => pick(b.dataset.id));
  $$("#dt-list [data-del]").forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    const t = tables.find((x) => x.id === b.dataset.del);
    if (!confirm(`Delete “${t ? t.name : "this table"}”?`)) return;
    try { await api.del("/tables/" + b.dataset.del); if (cur === b.dataset.del) { cur = null; S = null; } reload(); } catch (err) { toast(err.message, "bad"); }
  });
  // open what this browser chose last; never someone else's newest upload (tables are shared on the server)
  let last = null; try { last = localStorage.getItem("vf.data.last"); } catch (e) { /* storage off */ }
  const target = selectId || (want && tables.some((t) => t.id === want.table) ? want.table : null) || cur || (tables.some((t) => t.id === last) ? last : null);
  if (target && target !== cur) pick(target);
}
async function upload(files) {
  for (const f of files) {
    toast(`${f.name} goes onto the card…`);
    const fd = new FormData(); fd.append("file", f);
    try {
      const r = await api.raw("POST", "/tables", fd);
      const m = await r.json();
      if (m.notes && m.notes.length) toast(`${f.name}: ${m.notes.join(" · ")}`);
      await reload(m.id);
    } catch (e) {
      let t = e.message; try { t = JSON.parse(t).detail || t; } catch (x) { /* plain text */ }
      toast(`${f.name}: ${t}`, "bad", 7000);
    }
  }
}

async function downloadCsv(id, name) {
  try {
    const r = await fetch(`/api/tables/${id}/csv`); if (!r.ok) throw new Error(`download failed (${r.status})`);
    const u = URL.createObjectURL(await r.blob()), a = document.createElement("a");
    a.href = u; a.download = (name || id).replace(/\.(csv|tsv|txt|xlsx?|xlsm)$/i, "") + ".csv"; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 4000);
  } catch (e) { toast(e.message, "bad"); }
}
async function pick(id) {
  try { localStorage.setItem("vf.data.last", id); } catch (e) { /* storage off */ }
  cur = id; S = null; R.sort = ""; R.col = ""; R.val = ""; R.offset = 0; R.sel = null; G.by = ""; G.col = ""; G.agg = "count";
  $$("#dt-list [data-id]").forEach((b) => b.classList.toggle("on", b.dataset.id === id));
  const t = tables.find((x) => x.id === id) || {};
  $("#dt-name").textContent = t.name || "";
  $("#dt-chips").innerHTML = "";
  const dl = $("#dt-csv"); if (dl) { dl.hidden = false; dl.onclick = () => downloadCsv(id, t.name); }
  $("#dt-body").innerHTML = `<section class="pane is-busy" style="height:100%"><div class="pane-b center"><span class="hint">the card examines the table…</span></div></section>`;
  const my = ++seq;
  try { S = await api.get(`/tables/${id}/summary`); } catch (e) { if (my === seq) $("#dt-body").innerHTML = msg("data", "Couldn't read this table", esc(e.message)); return; }
  if (my !== seq) return;
  prep();
  head();
  if (want && want.table === id) { if (want.cols) { A.tid = null; A.want = want.cols.split("|"); } want = null; }
  renderTab();
}

// which columns carry anything: blank columns (common in exported spreadsheets) are hidden by default
function prep() {
  S.num = S.numeric.filter((c) => (c.count || 0) > 0);
  S.emptyNum = S.numeric.filter((c) => !(c.count > 0));
  S.txt = S.categorical.filter((c) => !(c.distinct <= 1 && (!c.top.length || c.top[0][0] === "")));
  S.emptyTxt = S.categorical.filter((c) => !S.txt.includes(c));
  S.empty = new Set([...S.emptyNum, ...S.emptyTxt].map((c) => c.name));
  S.vary = S.num.filter((c) => c.std > 0);
  const groupable = S.txt.filter((c) => c.distinct >= 2 && c.distinct <= 200).sort((a, b) => a.distinct - b.distinct);
  S.groupable = groupable;
}
function head() {
  const m = S.meta;
  $("#dt-name").textContent = m.name;
  $("#dt-chips").innerHTML = `<span class="chip">${fmt.n(m.rows)} rows</span><span class="chip">${S.num.length} numeric</span><span class="chip">${S.txt.length} text</span>${S.empty.size ? `<span class="chip dim" title="columns with no values">${S.empty.size} empty</span>` : ""}<span class="timing">${fmt.ms(S.ms)}</span>`;
}
const visibleCols = (cols) => hideEmpty ? cols.filter((c) => !S.empty.has(c)) : cols;

function renderTab(redrawOnly) {
  if (!S) return;
  if (redrawOnly && tab === "rows") return;
  ({ columns, rows, corr, pca, group, watch })[tab](redrawOnly);
}

// ---------------------------------------------------------------- Columns
function columns() {
  const all = [...S.numeric, ...S.categorical];
  const list = all.filter((c) => (!hideEmpty || !S.empty.has(c.name)) && (!colFilter || c.name.toLowerCase().includes(colFilter.toLowerCase())));
  $("#dt-body").innerHTML = pane({
    id: "dd-cols", t: "Columns", meta: `${list.length} of ${all.length}`,
    tools: `<input class="in sm" id="dd-cf" placeholder="find column" value="${esc(colFilter)}" style="width:150px"><label class="toggle"><input type="checkbox" id="dd-he" ${hideEmpty ? "checked" : ""}><i></i>hide empty</label>`,
    body: list.length ? `<div class="dd-grid">${list.map(colTile).join("")}</div>` : inlineMsg("Nothing to show", S.empty.size ? "Every column here is empty. Turn off <b>hide empty</b> to list them." : "No columns match."),
    foot: `<span><b>${S.num.length}</b> numeric</span><span><b>${S.txt.length}</b> text</span><span>${S.empty.size} empty${hideEmpty && S.empty.size ? " (hidden)" : ""}</span><span class="timing">${fmt.ms(S.ms)}</span>`,
    cls: "", bcls: "",
  });
  $("#dt-body > .pane").style.height = "100%";
  $("#dd-he").onchange = (e) => { hideEmpty = e.target.checked; columns(); };
  const cf = $("#dd-cf"); cf.oninput = () => { colFilter = cf.value; const p = cf.selectionStart; columns(); const n = $("#dd-cf"); n.focus(); n.setSelectionRange(p, p); };
  list.forEach((c) => { if (c.kind === "number" && c.hist) { const cv = $(`#dd-h-${cid(c.name)}`); if (cv) miniHist(cv, c); } });
  $$("#dd-cols [data-send]").forEach((b) => b.onclick = () => menu(b, columnTargets(cur, [b.dataset.send])));
}
// compact histogram for column tiles: bars + min / median / max under it (axis ticks don't fit a 250px tile)
function miniHist(cv, c) {
  const box = cv.parentElement, dpr = window.devicePixelRatio || 1, W = box.clientWidth, H = box.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + "px";
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const y = c.hist, n = y.length, mx = Math.max(1, ...y), bh = H - 16, bw = W / n;
  for (let i = 0; i < n; i++) {
    const h = y[i] / mx * (bh - 2), x = i * bw;
    const gr = g.createLinearGradient(0, bh - h, 0, bh); gr.addColorStop(0, "#ff2a1a"); gr.addColorStop(1, "rgba(212,0,0,.25)");
    g.fillStyle = gr; g.fillRect(x + 0.5, bh - h, Math.max(1, bw - 1), h);
  }
  const med = c.q[2], e0 = c.edges[0], e1 = c.edges[c.edges.length - 1], mxp = e1 > e0 ? (med - e0) / (e1 - e0) * W : W / 2;
  g.strokeStyle = "rgba(255,255,255,.55)"; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(mxp, 0); g.lineTo(mxp, bh); g.stroke(); g.setLineDash([]);
  g.strokeStyle = "rgba(255,255,255,.12)"; g.beginPath(); g.moveTo(0, bh + 0.5); g.lineTo(W, bh + 0.5); g.stroke();
  g.font = "10px 'JetBrains Mono', monospace"; g.fillStyle = "#8a8b93";
  const f = (v) => Math.abs(v) >= 1e4 ? fmt.big(v) : fmt.n(v, Math.abs(v) < 10 ? 2 : 1);
  g.textAlign = "left"; g.fillText(f(e0), 0, H - 2); g.textAlign = "right"; g.fillText(f(e1), W, H - 2);
}
const cid = (s) => String(s).replace(/[^a-z0-9]/gi, "_") + "_" + hash(String(s));
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return (h >>> 0).toString(36); }
function colTile(c) {
  const empty = S.empty.has(c.name);
  if (c.kind === "number") {
    if (empty || !c.count) return `<div class="dd-col empty"><div class="nm"><span title="${esc(c.name)}">${esc(c.name)}</span><span class="chip">empty</span></div><div class="hint">no values in ${fmt.n(S.meta.rows)} rows</div></div>`;
    return `<div class="dd-col"><div class="nm"><span title="${esc(c.name)}">${esc(c.name)}</span><span class="dd-nmr"><span class="chip blue">number</span><button class="iconbtn dd-send" data-send="${esc(c.name)}" title="Use this column in another tool">${icon("bolt")}</button></span></div>
      <div class="dd-hist"><canvas id="dd-h-${cid(c.name)}"></canvas></div>
      <div class="kv"><span>mean</span><b>${fmt.n(c.mean, 3)}</b><span>median</span><b>${fmt.n(c.q[2], 3)}</b><span>min – max</span><b>${fmt.n(c.q[0], 2)} – ${fmt.n(c.q[4], 2)}</b><span>std dev</span><b>${fmt.n(c.std, 3)}</b>${c.missing ? `<span>missing</span><b>${fmt.n(c.missing)}</b>` : ""}</div></div>`;
  }
  const top = (c.top || []).slice(0, 7), mx = Math.max(1, ...top.map((t) => t[1]));
  return `<div class="dd-col ${empty ? "empty" : ""}"><div class="nm"><span title="${esc(c.name)}">${esc(c.name)}</span><span class="chip">${empty ? "empty" : "text"}</span></div>
    <div class="kv"><span>distinct</span><b>${fmt.n(c.distinct)}</b><span>missing</span><b>${fmt.n(c.missing || 0)}</b></div>
    <div class="dd-top">${top.map(([v, n]) => `<div class="barrow" title="${esc(v || "(blank)")}"><i style="width:${n / mx * 100}%"></i><span>${v === "" ? '<span class="dim">(blank)</span>' : esc(v)}</span><b>${fmt.big(n)}</b></div>`).join("")}</div>
    ${c.distinct > top.length ? `<div class="hint">${c.distinct === S.meta.rows || c.distinct > S.meta.rows * 0.9 ? "mostly unique values — free text or an identifier" : `+ ${fmt.n(c.distinct - top.length)} more values`}</div>` : ""}</div>`;
}

// ---------------------------------------------------------------- Rows (grid + inspector)
async function rows() {
  const cols = S.meta.columns;
  $("#dt-body").innerHTML = `<div class="ws side-r dd-rows" style="height:100%">
    <section class="pane"><div class="pane-h"><div class="t">Rows</div><div class="meta" id="dr-meta"></div>
      <div class="tools tb"><select class="sel sm" id="dr-col"><option value="">filter column…</option>${visibleCols(cols).map((c) => `<option ${c === R.col ? "selected" : ""} value="${esc(c)}">${esc(c)}</option>`).join("")}</select>
        <select class="sel sm" id="dr-op">${["contains", "=", "!=", ">", "<", ">=", "<="].map((o) => `<option ${o === R.op ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>
        <input class="in sm" id="dr-val" placeholder="value" value="${esc(R.val)}" style="width:140px">
        <button class="btn sm" id="dr-go">Filter</button><button class="iconbtn" id="dr-clear" title="Clear filter">${icon("x")}</button>
        <span class="sep"></span><label class="toggle"><input type="checkbox" id="dr-he" ${hideEmpty ? "checked" : ""}><i></i>hide empty</label></div></div>
      <div class="pane-b flush" id="dr-grid"></div>
      <div class="pane-f"><span id="dr-total"></span><span class="spacer"></span><button class="btn ghost xs" id="dr-prev">← prev</button><span id="dr-page"></span><button class="btn ghost xs" id="dr-next">next →</button></div></section>
    ${pane({ t: "Row", meta: "", bid: "dr-insp", body: `<div class="hint">Click a row to see every field in full.</div>` })}
  </div>`;
  $("#dr-he").onchange = (e) => { hideEmpty = e.target.checked; rows(); };
  $("#dr-go").onclick = () => { R.col = $("#dr-col").value; R.op = $("#dr-op").value; R.val = $("#dr-val").value; R.offset = 0; loadRows(); };
  $("#dr-val").onkeydown = (e) => { if (e.key === "Enter") $("#dr-go").click(); };
  $("#dr-clear").onclick = () => { R.col = ""; R.val = ""; R.offset = 0; $("#dr-col").value = ""; $("#dr-val").value = ""; loadRows(); };
  $("#dr-prev").onclick = () => { if (R.offset > 0) { R.offset = Math.max(0, R.offset - R.limit); loadRows(); } };
  $("#dr-next").onclick = () => { if (R.rows && R.offset + R.limit < R.rows.total) { R.offset += R.limit; loadRows(); } };
  loadRows();
}
async function loadRows() {
  const q = new URLSearchParams({ sort: R.sort, desc: R.desc, col: R.val !== "" ? R.col : "", op: R.op, val: R.val, offset: R.offset, limit: R.limit });
  const grid = $("#dr-grid"); grid.parentElement.classList.add("is-busy");
  let r;
  try { r = await api.get(`/tables/${cur}/rows?${q}`); } catch (e) { grid.innerHTML = inlineMsg("Filter not applied", esc(e.message) + (R.op.match(/[<>]/) ? "<br>Comparisons need a number column and a numeric value." : "")); grid.parentElement.classList.remove("is-busy"); return; }
  grid.parentElement.classList.remove("is-busy");
  R.rows = r;
  const show = r.columns.map((c, i) => [c, i]).filter(([c]) => !hideEmpty || !S.empty.has(c));
  const isNum = new Set(S.meta.numeric);
  grid.innerHTML = r.rows.length ? `<table class="tbl dd-tbl"><thead><tr><th class="rn">#</th>${show.map(([c]) => `<th data-sort="${esc(c)}" class="${isNum.has(c) ? "r" : ""}" title="${esc(c)} — click to sort">${esc(c)}${R.sort === c ? (R.desc ? " ↓" : " ↑") : ""}</th>`).join("")}</tr></thead>
    <tbody>${r.rows.map((row, k) => `<tr data-k="${k}" class="${R.sel === R.offset + k ? "on" : ""}"><td class="rn">${fmt.n(R.offset + k + 1)}</td>${show.map(([c, i]) => { const v = row[i]; return v == null || v === "" ? `<td class="dim">·</td>` : typeof v === "number" ? `<td class="r mono">${fmt.n(v, 3)}</td>` : `<td title="${esc(v)}">${esc(v)}</td>`; }).join("")}</tr>`).join("")}</tbody></table>`
    : inlineMsg("No rows match", "Clear the filter to see everything.");
  $("#dr-meta").textContent = R.val !== "" && R.col ? `${R.col} ${R.op} ${R.val}` : "";
  $("#dr-total").innerHTML = `<b>${fmt.n(r.total)}</b> ${r.total === S.meta.rows ? "rows" : `of ${fmt.n(S.meta.rows)} rows`} · ${show.length} columns`;
  $("#dr-page").textContent = r.total ? `${fmt.n(R.offset + 1)}–${fmt.n(Math.min(R.offset + R.limit, r.total))}` : "";
  $("#dr-prev").disabled = R.offset <= 0; $("#dr-next").disabled = R.offset + R.limit >= r.total;
  $$("#dr-grid th[data-sort]").forEach((h) => h.onclick = () => { if (R.sort === h.dataset.sort) R.desc = R.desc ? 0 : 1; else { R.sort = h.dataset.sort; R.desc = isNum.has(R.sort) ? 1 : 0; } R.offset = 0; loadRows(); });
  $$("#dr-grid tr[data-k]").forEach((tr) => tr.onclick = () => { $$("#dr-grid tr.on").forEach((x) => x.classList.remove("on")); tr.classList.add("on"); R.sel = R.offset + +tr.dataset.k; inspect(r, +tr.dataset.k); });
  if (R.sel != null && R.sel >= R.offset && R.sel < R.offset + r.rows.length) inspect(r, R.sel - R.offset);
}
function inspect(r, k) {
  const row = r.rows[k];
  const f = r.columns.map((c, i) => [c, row[i]]).filter(([c, v]) => v != null && v !== "");
  $("#dr-insp").previousElementSibling.querySelector(".meta").textContent = `row ${fmt.n(R.offset + k + 1)} · ${f.length} filled`;
  $("#dr-insp").innerHTML = f.length ? `<div class="dd-fields">${f.map(([c, v]) => `<div class="fl"><span>${esc(c)}</span><div class="${typeof v === "number" ? "mono" : ""}">${esc(typeof v === "number" ? String(Number(v.toPrecision(7))) : v)}</div></div>`).join("")}</div>` : `<div class="hint">This row is empty.</div>`;
}

// ---------------------------------------------------------------- Correlations
function corr() {
  const idx = S.numeric.map((c, i) => [c, i]).filter(([c]) => c.count > 1 && c.std > 0);
  if (idx.length < 2 || !S.corr) {
    $("#dt-body").innerHTML = msg("data", "No correlations to compute", `Correlations need at least two number columns whose values vary. This table has ${S.vary.length === 1 ? "one" : S.vary.length || "no"} such column${S.vary.length === 1 ? "" : "s"}${S.txt.length ? ` and ${S.txt.length} text column${S.txt.length === 1 ? "" : "s"} — try <b>Group by</b> or <b>Columns</b>` : ""}.`);
    return;
  }
  const names = idx.map(([c]) => c.name);
  const M = idx.map(([, i]) => idx.map(([, j]) => { const v = S.corr[i] && S.corr[i][j]; return v == null ? 0 : v; }));
  const pairs = [];
  for (let a = 0; a < names.length; a++) for (let b = a + 1; b < names.length; b++) pairs.push([names[a], names[b], M[a][b]]);
  pairs.sort((x, y) => Math.abs(y[2]) - Math.abs(x[2]));
  $("#dt-body").innerHTML = `<div class="ws side-r" style="height:100%">
    ${pane({ id: "dd-cm", t: "Correlation matrix", meta: `${names.length} numeric columns · Pearson r`, body: `<div class="chartbox"><canvas id="dd-corr"></canvas></div>`, foot: `<span id="dd-cell">hover a cell</span><span class="legend"><span><i style="background:#3fa9f5"></i>negative</span><span><i style="background:#ff2a1a"></i>positive</span></span>` })}
    ${pane({ t: "Strongest links", meta: `${pairs.length} pairs`, body: `<div class="dd-pairs">${pairs.slice(0, 60).map(([a, b, v]) => `<div class="barrow" title="${esc(a)} ↔ ${esc(b)}"><i style="width:${Math.abs(v) * 100}%;background:${v >= 0 ? "linear-gradient(90deg,rgba(212,0,0,.45),rgba(212,0,0,.08))" : "linear-gradient(90deg,rgba(63,169,245,.45),rgba(63,169,245,.08))"}"></i><span>${esc(a)} <span class="dim">↔</span> ${esc(b)}</span><b style="color:${v >= 0 ? "#ff8a7a" : "#8ccaff"}">${v >= 0 ? "+" : ""}${v.toFixed(2)}</b></div>`).join("")}</div>` })}
  </div>`;
  requestAnimationFrame(() => corrMap($("#dd-corr"), M, names, (c) => { $("#dd-cell").innerHTML = c ? `${esc(c.a)} ↔ ${esc(c.b)}: <b style="color:${c.v >= 0 ? "#ff8a7a" : "#8ccaff"}">${c.v >= 0 ? "+" : ""}${c.v.toFixed(3)}</b>` : "hover a cell"; }));
}
function corrMap(cv, M, labels, onCell) {
  const box = cv.parentElement, dpr = window.devicePixelRatio || 1;
  const W = box.clientWidth, H = box.clientHeight, n = M.length;
  const g0 = document.createElement("canvas").getContext("2d"); g0.font = "11px Inter, sans-serif";
  const lab = Math.min(150, Math.max(...labels.map((l) => g0.measureText(l).width)) + 12);
  const cell = Math.max(4, Math.min((W - lab - 8) / n, (H - lab - 8) / n));
  cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + "px";
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const ox = lab + Math.max(0, (W - lab - 8 - n * cell) / 2), oy = lab;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const v = M[i][j], a = Math.min(1, Math.abs(v));
    g.fillStyle = i === j ? "#2a2a31" : v >= 0 ? `rgba(230,20,10,${0.08 + a * 0.92})` : `rgba(63,169,245,${0.08 + a * 0.92})`;
    g.fillRect(ox + j * cell, oy + i * cell, cell - 1, cell - 1);
    if (cell >= 30 && i !== j) { g.fillStyle = a > 0.5 ? "#fff" : "#9a9ba3"; g.font = "10px 'JetBrains Mono', monospace"; g.textAlign = "center"; g.fillText(v.toFixed(2), ox + j * cell + cell / 2, oy + i * cell + cell / 2 + 3); }
  }
  g.fillStyle = "#c8c9ce"; g.font = `${cell < 12 ? 9 : 11}px Inter, sans-serif`;
  const clip = (s) => { let t = s; while (t.length > 3 && g.measureText(t).width > lab - 12) t = t.slice(0, -2); return t === s ? s : t + "…"; };
  if (cell >= 8) labels.forEach((l, i) => {
    g.textAlign = "right"; g.fillText(clip(l), ox - 6, oy + i * cell + cell / 2 + 4);
    g.save(); g.translate(ox + i * cell + cell / 2 + 3, oy - 6); g.rotate(-Math.PI / 2.6); g.textAlign = "left"; g.fillText(clip(l), 0, 0); g.restore();
  });
  cv.onmousemove = (e) => {
    const r = cv.getBoundingClientRect(), j = Math.floor((e.clientX - r.left - ox) / cell), i = Math.floor((e.clientY - r.top - oy) / cell);
    onCell(i >= 0 && j >= 0 && i < n && j < n ? { a: labels[i], b: labels[j], v: M[i][j] } : null);
  };
  cv.onmouseleave = () => onCell(null);
}

// ---------------------------------------------------------------- Projection (PCA + k-means)
async function pca(redrawOnly) {
  if (redrawOnly && S.pca && S.pca.k === pcaK) { drawPca(); return; }
  $("#dt-body").innerHTML = `<div class="ws side-r" style="height:100%">
    ${pane({ id: "dd-pc", t: "Every row, placed by similarity", meta: "PCA + k-means on the card", tools: `<div class="tb"><span class="lbl">clusters</span><div class="seg" id="dd-k">${[2, 3, 4, 5, 6, 8].map((k) => `<button data-k="${k}" class="${k === pcaK ? "on" : ""}">${k}</button>`).join("")}</div></div>`, body: `<div class="chartbox"><canvas id="dd-pca"></canvas></div>`, foot: "&nbsp;", cls: "is-busy" })}
    ${pane({ t: "What the axes mean", bid: "dd-axes", body: `<div class="hint">computing…</div>` })}
  </div>`;
  $$("#dd-k [data-k]").forEach((b) => b.onclick = () => { pcaK = +b.dataset.k; S.pca = null; pca(); });
  const my = ++seq;
  try { S.pca = await api.get(`/tables/${cur}/pca?k=${pcaK}`); S.pca.k = pcaK; } catch (e) {
    if (my !== seq) return;
    $("#dt-body").innerHTML = msg("data", "No projection for this table", `${esc(cap(e.message))}.<br>Projection places rows by their number columns; this table has ${S.vary.length === 1 ? "one" : S.vary.length || "no"} numeric column${S.vary.length === 1 ? "" : "s"} that vary${S.txt.length ? ` — <b>Group by</b> and <b>Columns</b> work on its text` : ""}.`);
    return;
  }
  if (my !== seq) return;
  drawPca();
}
function drawPca() {
  const p = S.pca;
  $("#dd-pc").classList.remove("is-busy");
  ch.scatter($("#dd-pca"), { pts: p.points, labels: p.labels, h: $("#dd-pca").parentElement.clientHeight });
  $("#dd-pc-f").innerHTML = `<span><b>${fmt.n(p.points.length)}</b> rows plotted</span><span>${p.names.length} columns</span><span class="timing">${fmt.ms(p.ms)}</span>`;
  const ax = (k) => p.names.map((n, i) => ({ n, w: p.loadings[k][i] })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w)).slice(0, 6);
  const total = p.sizes.reduce((a, b) => a + b, 0) || 1;
  $("#dd-axes").innerHTML = [0, 1].map((k) => `<div class="sec-t">${k ? "Vertical" : "Horizontal"} axis <span class="x">${(p.explained[k] * 100).toFixed(0)}% of variation</span></div>
      <div class="dd-load">${ax(k).map((x) => `<div class="barrow" title="${esc(x.n)}"><i style="width:${Math.abs(x.w) * 100}%;background:${x.w >= 0 ? "rgba(212,0,0,.4)" : "rgba(63,169,245,.4)"}"></i><span>${esc(x.n)}</span><b>${x.w >= 0 ? "+" : ""}${x.w.toFixed(2)}</b></div>`).join("")}</div>`).join("") +
    `<div class="sec-t" style="margin-top:14px">Clusters</div>${p.sizes.map((s, i) => `<div class="barrow"><i style="width:${s / total * 100}%;background:${ch.PALETTE[i % ch.PALETTE.length]}55"></i><span><span class="dd-dot" style="background:${ch.PALETTE[i % ch.PALETTE.length]}"></span>cluster ${i + 1}</span><b>${fmt.n(s)}</b></div>`).join("")}`;
}

// ---------------------------------------------------------------- Group by (+ cross-tab against a second text column)
const X = { other: "", cache: null };
async function group() {
  if (!S.groupable.length) {
    $("#dt-body").innerHTML = msg("data", "Nothing to group by", `To group, you need a text column with 2 to 200 different values. ${S.txt.length ? "The text columns here are free text (almost every value unique)." : "This table has no text columns."}`);
    return;
  }
  if (!G.by || !S.groupable.find((c) => c.name === G.by)) G.by = S.groupable[0].name;
  const others = S.groupable.filter((c) => c.name !== G.by);
  if (!X.other || X.other === G.by || !others.find((c) => c.name === X.other)) X.other = others.length ? others[0].name : "";
  $("#dt-body").innerHTML = `<div class="col" style="height:100%">
    <section class="pane fit dd-gp"><div class="pane-h"><div class="t">Group by</div><div class="meta" id="dg-meta"></div>
    <div class="tools tb"><span class="lbl">group</span><select class="sel sm" id="dg-by">${S.groupable.map((c) => `<option value="${esc(c.name)}" ${c.name === G.by ? "selected" : ""}>${esc(c.name)} (${c.distinct})</option>`).join("")}</select>
      <span class="lbl">measure</span><select class="sel sm" id="dg-col"><option value="">row count</option>${S.vary.map((c) => `<option value="${esc(c.name)}" ${c.name === G.col ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
      <div class="seg" id="dg-agg">${["mean", "sum"].map((a) => `<button data-a="${a}" class="${G.agg === a ? "on" : ""}" ${G.col ? "" : "disabled"}>${a}</button>`).join("")}</div></div></div>
    <div class="pane-b" id="dg-body"></div><div class="pane-f" id="dg-f">&nbsp;</div></section>
    ${others.length ? `<section class="pane grow"><div class="pane-h"><div class="t">Cross-tab</div><div class="meta" id="dx-meta"></div>
      <div class="tools tb"><span class="lbl">against</span><select class="sel sm" id="dx-other">${others.map((c) => `<option value="${esc(c.name)}" ${c.name === X.other ? "selected" : ""}>${esc(c.name)} (${c.distinct})</option>`).join("")}</select></div></div>
      <div class="pane-b flush" id="dx-body"></div><div class="pane-f"><span>click a cell or a bar to open those rows</span></div></section>` : ""}
  </div>`;
  $("#dg-by").onchange = (e) => { G.by = e.target.value; group(); };
  $("#dg-col").onchange = (e) => { G.col = e.target.value; G.agg = G.col ? (G.agg === "count" ? "mean" : G.agg) : "count"; group(); };
  $$("#dg-agg [data-a]").forEach((b) => b.onclick = () => { if (!G.col) return; G.agg = b.dataset.a; $$("#dg-agg [data-a]").forEach((x) => x.classList.toggle("on", x === b)); loadGroup(); });
  if ($("#dx-other")) $("#dx-other").onchange = (e) => { X.other = e.target.value; crosstab(); };
  loadGroup();
  crosstab();
}
function openRows(col, val) {
  R.col = col; R.op = "="; R.val = val; R.offset = 0; R.sel = null; tab = "rows";
  $$("#dt-tabs [data-tab]").forEach((x) => x.classList.toggle("on", x.dataset.tab === "rows"));
  rows();
}
async function loadGroup() {
  const body = $("#dg-body"); body.parentElement.classList.add("is-busy");
  const agg = G.col ? G.agg : "count";
  const t0 = performance.now();
  let r;
  try { r = await api.get(`/tables/${cur}/group?${new URLSearchParams({ by: G.by, col: G.col, agg })}`); } catch (e) { body.innerHTML = inlineMsg("Couldn't group", esc(e.message)); body.parentElement.classList.remove("is-busy"); return; }
  body.parentElement.classList.remove("is-busy");
  const mx = Math.max(1e-12, ...r.groups.map((g) => Math.abs(g.value)));
  const fv = (v) => agg === "count" ? fmt.n(v) : fmt.n(v, Math.abs(v) < 10 ? 3 : 1);
  $("#dg-meta").textContent = agg === "count" ? `rows per ${G.by}` : `${agg} of ${G.col} per ${G.by}`;
  body.innerHTML = `<div class="dd-groups">${r.groups.map((g) => `<div class="barrow" data-key="${esc(g.key)}" title="${esc(g.key || "(blank)")} — open these rows"><i style="width:${Math.abs(g.value) / mx * 100}%"></i><span>${g.key === "" ? '<span class="dim">(blank)</span>' : esc(g.key)}</span><b>${fv(g.value)}${agg !== "count" ? ` <span class="dim">· ${fmt.n(g.n)} rows</span>` : ""}</b></div>`).join("")}</div>`;
  $$("#dg-body [data-key]").forEach((b) => b.onclick = () => { if (b.dataset.key !== "") openRows(G.by, b.dataset.key); });
  $("#dg-f").innerHTML = `<span><b>${r.groups.length}</b> groups${r.groups.length >= 40 ? " (top 40)" : ""}</span><span>${esc(G.by)}</span><span class="timing">${fmt.ms(performance.now() - t0)}</span>`;
}
// the cross-tab is counted in the browser from the rows themselves (capped at 20k rows)
async function allRows() {
  if (X.cache && X.cache.id === cur) return X.cache;
  const out = []; let total = Infinity, off = 0, cols = null;
  while (off < Math.min(total, 20000)) {
    const r = await api.get(`/tables/${cur}/rows?offset=${off}&limit=1000`);
    total = r.total; cols = r.columns; out.push(...r.rows); off += 1000;
    if (!r.rows.length) break;
  }
  X.cache = { id: cur, cols, rows: out, total };
  return X.cache;
}
async function crosstab() {
  const body = $("#dx-body"); if (!body || !X.other) return;
  body.parentElement.classList.add("is-busy");
  let d; try { d = await allRows(); } catch (e) { body.innerHTML = inlineMsg("The cross-tab failed", esc(e.message)); body.parentElement.classList.remove("is-busy"); return; }
  body.parentElement.classList.remove("is-busy");
  const a = d.cols.indexOf(G.by), b = d.cols.indexOf(X.other);
  const SEP = "\u0000";
  const cnt = new Map(), ra = new Map(), rb = new Map();
  for (const row of d.rows) {
    const x = row[a] == null ? "" : String(row[a]), y = row[b] == null ? "" : String(row[b]);
    const k = x + SEP + y; cnt.set(k, (cnt.get(k) || 0) + 1); ra.set(x, (ra.get(x) || 0) + 1); rb.set(y, (rb.get(y) || 0) + 1);
  }
  const A = [...ra.entries()].sort((p, q) => q[1] - p[1]).slice(0, 25).map((p) => p[0]);
  const B = [...rb.entries()].sort((p, q) => q[1] - p[1]).slice(0, 14).map((p) => p[0]);
  const mx = Math.max(1, ...cnt.values());
  const lab = (v) => v === "" ? '<span class="dim">(blank)</span>' : esc(v);
  $("#dx-meta").textContent = `${G.by} × ${X.other}${d.total > d.rows.length ? ` · first ${fmt.n(d.rows.length)} rows` : ""}`;
  body.innerHTML = `<table class="tbl dd-xt"><thead><tr><th>${esc(G.by)} ↓ · ${esc(X.other)} →</th>${B.map((v) => `<th class="r" title="${esc(v || "(blank)")}">${lab(v)}</th>`).join("")}<th class="r">total</th></tr></thead><tbody>
    ${A.map((x) => `<tr><td title="${esc(x || "(blank)")}">${lab(x)}</td>${B.map((y) => { const n = cnt.get(x + SEP + y) || 0; const t = n / mx; return `<td class="r c" data-x="${esc(x)}" style="background:rgba(212,0,0,${n ? (0.1 + t * 0.75).toFixed(2) : 0});color:${n ? (t > 0.4 ? "#fff" : "var(--ink-2)") : "var(--dim)"}">${n || "·"}</td>`; }).join("")}<td class="r mono dim">${fmt.n(ra.get(x))}</td></tr>`).join("")}
  </tbody></table>`;
  $$("#dx-body td.c").forEach((td) => td.onclick = () => { if (td.dataset.x !== "") openRows(G.by, td.dataset.x); });
}

// ---------------------------------------------------------------- new tables: a ticker download, or pasted numbers
function tickerSheet() {
  const s = sheet({
    title: "Daily prices as a table",
    body: `<div class="fields"><div class="hint">Downloads adjusted daily closes and volume from Yahoo Finance into a new table: Date, close, volume. Anything you can look up there works — SPY, AAPL, ^VIX, BTC-USD, EURUSD=X.</div>
      <div class="fld two"><label for="tk-s">Ticker</label><input class="in" id="tk-s" placeholder="e.g. SPY" autocomplete="off"></div>
      <div class="fld two"><label for="tk-y">Years</label><select class="sel" id="tk-y">${[1, 2, 5, 10, 20].map((y) => `<option ${y === 10 ? "selected" : ""}>${y}</option>`).join("")}</select></div></div>`,
    foot: `<button class="btn block" id="tk-go">${icon("down")} Download into the Data Desk</button><div class="hint" id="tk-h">&nbsp;</div>`,
  });
  const go = async () => {
    const t = s.$("#tk-s").value.trim(); if (!t) return;
    s.$("#tk-go").disabled = true; s.$("#tk-h").textContent = "downloading…";
    try { const m = await api.post("/tables/ticker", { ticker: t, years: +s.$("#tk-y").value }); s.close(); toast(`${m.name}: ${fmt.n(m.rows)} days`); await reload(m.id); }
    catch (e) { s.$("#tk-h").textContent = e.message; s.$("#tk-go").disabled = false; }
  };
  s.$("#tk-go").onclick = go; s.$("#tk-s").onkeydown = (e) => { if (e.key === "Enter") go(); };
  s.$("#tk-s").focus();
}
function pasteSheet() {
  const s = sheet({
    title: "Paste numbers",
    body: `<div class="fields"><div class="hint">A list of numbers (one per line, or separated by commas or spaces) becomes a table with one column. If you paste a CSV with a header row, the Data Desk keeps it as it is.</div>
      <div class="fld two"><label for="ps-n">Name</label><input class="in" id="ps-n" placeholder="e.g. monthly spend"></div>
      <textarea class="in mono" id="ps-t" rows="12" placeholder="12.5&#10;13.1&#10;12.9&#10;…"></textarea></div>`,
    foot: `<button class="btn block" id="ps-go">${icon("plus")} Make a table</button><div class="hint" id="ps-h">&nbsp;</div>`,
  });
  s.$("#ps-go").onclick = async () => {
    s.$("#ps-go").disabled = true;
    try { const m = await api.post("/tables/paste", { name: s.$("#ps-n").value.trim(), text: s.$("#ps-t").value }); s.close(); await reload(m.id); }
    catch (e) { s.$("#ps-h").textContent = e.message; s.$("#ps-go").disabled = false; }
  };
  s.$("#ps-t").focus();
}

// ---------------------------------------------------------------- Anomalies: the moments that break the pattern
const A = { tid: null, want: null, cols: [], date: "auto", label: "", det: "auto", thr: 5, r: null, sel: null, view: 0, dates: [], seq: 0, timer: 0 };
const DET = [["auto", "Auto"], ["rolling", "Rolling"], ["linear", "Linear"], ["pattern", "Pattern"]];
async function watch(redrawOnly) {
  if (!S.vary.length) {
    $("#dt-body").innerHTML = msg("eye", "Nothing to watch", "Anomaly watch needs at least one number column whose values change. Add a series — a file, a <b>Ticker</b> or <b>Paste</b> in the Tables pane.");
    return;
  }
  if (redrawOnly && A.r && A.tid === cur && $("#dw-cv")) { drawWatch(); return; }
  if (A.tid !== cur) {
    A.tid = cur; A.r = null; A.sel = null; A.view = 0; A.label = ""; A.date = "auto";
    const ok = (A.want || []).filter((c) => S.vary.some((v) => v.name === c));
    // default: the first column that is not a row number, a year or an id (watching "day" itself finds nothing)
    const idx = (c) => /^(day|date|time|year|month|week|id|index|idx|row|step|n|no|#)$/i.test(c.name.trim()) || /(^|_| )(id|index)$/i.test(c.name);
    A.cols = ok.length ? ok : [(S.vary.find((c) => !idx(c)) || S.vary[0]).name]; A.want = null;
    try { A.dates = (await api.get(`/tables/${cur}/dates`)).date_columns; } catch (e) { A.dates = []; }
  }
  const labelCols = [...S.txt.filter((c) => c.distinct <= 50).map((c) => c.name), ...S.vary.filter((c) => c.q && c.q[0] >= 0 && c.q[4] <= 1).map((c) => c.name)];
  $("#dt-body").innerHTML = `<div class="ws side-r dw" style="height:100%">
    <div class="col">
      <section class="pane fit sm-verdict dw-verdict"><div class="hl" id="dw-hl">—</div><div class="txt"><div class="nm">Anomaly watch</div><p id="dw-sent">Choose the columns to watch on the right, then press Watch.</p><p class="dw-check" id="dw-check"></p></div><div class="facts" id="dw-facts"></div></section>
      ${pane({ id: "dw-chart", t: "Series", meta: "", cls: "grow", tools: `<div class="seg" id="dw-view"></div>`, bcls: "dw-chartb", body: `<div class="chartbox"><canvas id="dw-cv"></canvas></div>`, foot: `<span id="dw-hover">drag to zoom · double-click to reset · click a red dot</span>` })}
      ${pane({ id: "dw-inc", t: "Flagged moments", meta: "", cls: "dw-incp", tools: `<button class="btn ghost xs" id="dw-save" title="Save the flagged moments as a new Data Desk table" disabled>${icon("down")} Save as table</button>`, bcls: "flush", bid: "dw-list", body: `<div class="hint" style="padding:12px">Nothing yet.</div>` })}
    </div>
    <div class="col">
      <section class="pane grow dw-flow"><div class="pane-h"><div class="t">Anomaly watch</div><div class="meta">${esc(S.meta.name)}</div></div>
        <div class="pane-b flush" id="dw-lf"></div></section>
    </div></div>`;
  const lf = A.lf = learnFlow($("#dw-lf"), { key: "dw", compact: true, start: "train",
    steps: { train: { hint: "Columns and detector" }, evaluate: { hint: "Planted-glitch test" }, infer: { hint: "Flagged moments" } } });
  lf.body("train").innerHTML = `<div class="fields">
          <div class="sec-t">Columns to watch <span class="x">${S.vary.length > 1 ? "several at once = one score" : ""}</span></div>
          <div class="dw-cols">${S.vary.map((c) => `<label class="pick-col"><input type="checkbox" value="${esc(c.name)}" ${A.cols.includes(c.name) ? "checked" : ""}><span>${esc(c.name)}</span></label>`).join("")}</div>
          <div class="fld two"><label for="dw-date">Time order</label><select class="sel sm" id="dw-date"><option value="auto">automatic${A.dates.length ? " (" + esc(A.dates[0]) + ")" : " (row order)"}</option><option value="">row order</option>${A.dates.map((d) => `<option value="${esc(d)}" ${A.date === d ? "selected" : ""}>${esc(d)}</option>`).join("")}</select></div>
          <div class="fld two"><label for="dw-label" title="A column that marks incidents that you know about. The Data Desk measures precision and recall against it.">Known incidents</label><select class="sel sm" id="dw-label"><option value="">none</option>${labelCols.map((c) => `<option value="${esc(c)}" ${A.label === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div>
          <div class="sec-t" style="margin-top:6px">Detector</div>
          <div class="seg dw-det" id="dw-det">${DET.map(([k, l]) => `<button data-d="${k}" class="${A.det === k ? "on" : ""}">${l}</button>`).join("")}</div>
          <div class="fld"><label for="dw-thr">Flag at</label><input type="range" id="dw-thr" min="2.5" max="12" step="0.1" value="${A.thr}"><span class="v" id="dw-thrv">${A.thr.toFixed(1)}×</span></div>
          <div class="hint">The detector flags a point when the point is this many typical errors away from the expected value. Higher = fewer flags, with more certainty.</div>
        </div>`;
  lf.actions("train", `<button class="btn" id="dw-go" data-primary>${icon("eye")} Watch</button><span class="hint" id="dw-time"></span>`);
  lf.body("evaluate").innerHTML = `<div id="dw-tests"><div class="empty">After a run, the Lab plants glitches into a copy of the data. It scores each detector on how many it catches at the same false-alarm rate.</div></div>`;
  lf.body("infer").innerHTML = `<div id="dw-inf"><div class="empty">Press Watch in step 1. The flagged moments appear in the table on the left.</div></div>
    <div class="sec-t" style="margin-top:12px">Watch another table</div>
    <select class="sel sm" id="dw-other">${tables.filter((t) => t.id !== cur).map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select>
    <div class="hint">Opens that table with the same columns (where it has them) and runs the watch there.</div>`;
  lf.actions("infer", `<button class="btn ghost" id="dw-save2" disabled>${icon("down")} Save flagged as table</button><button class="btn" id="dw-oth">${icon("play")} Watch that table</button>`);
  $("#dw-save2").onclick = saveWatch;
  $("#dw-oth").onclick = () => { const t = $("#dw-other").value; if (t) go("data", { table: t, tab: "watch", cols: A.cols.join("|") }); };
  $$(".dw-cols input").forEach((i) => i.onchange = () => { A.cols = $$(".dw-cols input").filter((x) => x.checked).map((x) => x.value); });
  $("#dw-date").onchange = (e) => { A.date = e.target.value; };
  $("#dw-label").onchange = (e) => { A.label = e.target.value; };
  $$("#dw-det [data-d]").forEach((b) => b.onclick = () => { A.det = b.dataset.d; $$("#dw-det [data-d]").forEach((x) => x.classList.toggle("on", x === b)); if (A.r) runWatch(true); });
  $("#dw-thr").oninput = (e) => { A.thr = +e.target.value; $("#dw-thrv").textContent = A.thr.toFixed(1) + "×"; clearTimeout(A.timer); if (A.r) A.timer = setTimeout(() => runWatch(true), 160); };
  $("#dw-go").onclick = () => runWatch(false);
  $("#dw-save").onclick = saveWatch;
  if (A.r) showWatch(A.r); else runWatch(false);
}
function watchBody() { return { cols: A.cols, date_col: A.date, label_col: A.label, detector: A.det, threshold: A.thr }; }
async function runWatch(quick) {
  if (!A.cols.length) { toast("Tick at least one column to watch.", "bad"); return; }
  const my = ++A.seq, tid = cur;
  const call = (o) => api.post(`/tables/${tid}/anomalies`, watchBody(), o);
  let r = null;
  if (quick || !A.lf || A.lf.busy("train")) { try { r = await call(); } catch (e) { if (my === A.seq) toast(e.message, "bad"); } }
  else {
    $("#dw-chart").classList.add("is-busy");
    r = await A.lf.run("train", ({ signal }) => call({ signal }), { label: "Plant test glitches and score the detectors on the card",
      onError: (e) => { $("#dw-hl").className = "hl bad"; $("#dw-hl").textContent = "—"; $("#dw-sent").textContent = e.message; $("#dw-check").textContent = ""; return true; } });
    const c = $("#dw-chart"); if (c) c.classList.remove("is-busy");
  }
  if (!r || my !== A.seq || A.tid !== cur) return;
  A.r = r; if (A.view >= r.names.length) A.view = 0;
  if (!quick) A.sel = null;
  showWatch(r);
  $("#dw-time").innerHTML = `${fmt.n(r.n)} points · <span class="timing">${fmt.ms(r.compute_s * 1000)} on the card</span>`;
}
function showWatch(r) {
  $("#dw-hl").className = "hl " + (r.incident_count ? "bad" : "good");
  $("#dw-hl").textContent = r.incident_count ? fmt.n(r.incident_count) : "0";
  $("#dw-sent").textContent = r.sentence;
  $("#dw-check").textContent = r.check + (r.notes.length ? " · " + r.notes.join(" · ") : "");
  $("#dw-facts").innerHTML = [["detector", DET.find(([k]) => k === r.detector)[1] + (A.det === "auto" ? " (best)" : "")], ["points", fmt.n(r.n)],
    ["flagged", fmt.pct(r.flagged / r.n, 2)], ["season", r.period ? r.period + " steps" : "none"], ["lags", r.lags],
    ["known", r.known ? `${r.known.caught}/${r.known.incidents} caught` : "—"]].map(([l, v]) => `<div><b>${esc(String(v))}</b><span>${esc(l)}</span></div>`).join("");
  $("#dw-view").innerHTML = r.names.length > 1 ? r.names.map((n, i) => `<button data-v="${i}" class="${i === A.view ? "on" : ""}">${esc(n)}</button>`).join("") : "";
  $$("#dw-view [data-v]").forEach((b) => b.onclick = () => { A.view = +b.dataset.v; $$("#dw-view [data-v]").forEach((x) => x.classList.toggle("on", x === b)); drawWatch(); });
  $("#dw-chart .meta").textContent = `${r.names[A.view]}${r.date_col ? " by " + r.date_col : ""} · blue = expected`;
  // the planted-glitch test
  const T = r.tests, keys = ["pattern", "linear", "rolling"];
  const bt = T[r.best], rate = bt.found / Math.max(1, bt.planted);
  $("#dw-tests").innerHTML = scoreCard({ value: `${bt.found}/${bt.planted}`, good: rate >= 0.5,
      label: `planted glitches caught by the best detector (${esc(bt.name)}), at 1 false alarm in 100 ordinary points`,
      bars: keys.map((k) => ({ t: T[k].name, v: T[k].found / Math.max(1, T[k].planted), kind: k === r.best ? "model" : "base" }))
        .concat([{ t: "random flags (1 in 100)", v: 0.01, kind: "chance", tip: "flagging 1 point in 100 at random catches about 1 glitch in 100" }]),
      verdict: rate >= 0.5 ? "The detector catches most planted glitches: trust its flags on this data." : "The detector misses many planted glitches here: treat its flags as hints." }) + `<div style="display:none" class="dw-bars">${keys.map((k) => { const t = T[k], p = t.found / Math.max(1, t.planted); return `<div class="vf-bar"><span title="${esc(t.name)}">${esc(t.name)}</span><i class="${k === r.best ? "red" : k === "rolling" ? "dim" : ""}" style="--w:${p * 100}%"></i><b>${t.found}/${t.planted}</b></div>`; }).join("")}</div>
    <div class="hint" style="margin-top:8px">${Object.entries(T[r.best].by_kind).map(([k, v]) => `${k}s ${v[0]}/${v[1]}`).join(" · ")} for the best detector. Planted glitches are about four typical moves in size; each detector may flag 1 in 100 ordinary points.</div>
    ${r.known ? `<div class="sec-t" style="margin-top:12px">Against your known incidents</div><div class="kv"><span>incidents caught</span><b>${r.known.caught} of ${r.known.incidents}</b><span>flags that were real</span><b>${r.known.correct} of ${r.known.flagged}</b></div>` : ""}`;
  // the incidents
  const inc = r.incidents;
  $("#dw-inc .meta").textContent = r.incident_count ? `${fmt.n(r.incident_count)} stretches · ${fmt.n(r.flagged)} points${r.incident_count > inc.length ? " · strongest " + inc.length : ""}` : "none";
  $("#dw-save").disabled = !inc.length;
  if (A.lf) {
    const sv = $("#dw-save2"); if (sv) sv.disabled = !inc.length;
    $("#dw-inf").innerHTML = `<div class="sm-verdict-mini"><b>${fmt.n(r.incident_count)}</b> stretch${r.incident_count === 1 ? "" : "es"} flagged · ${fmt.n(r.flagged)} points of ${fmt.n(r.n)}</div>
      <div class="hint">${esc(r.sentence)}</div><div class="hint">Click a row in Flagged moments to see it on the chart.</div>`;
    A.lf.state("train", "done", `${A.cols.length} column${A.cols.length > 1 ? "s" : ""} · ${DET.find(([k]) => k === r.detector)[1]}`);
    A.lf.state("evaluate", "done", `caught ${bt.found} of ${bt.planted} planted`);
    A.lf.state("infer", "done", `${fmt.n(r.incident_count)} flagged`);
  }
  $("#dw-list").innerHTML = inc.length ? `<table class="tbl dw-tbl"><thead><tr><th>when</th>${r.names.length > 1 ? "<th>column</th>" : ""}<th class="r">value</th><th class="r">expected</th><th class="r">off by</th><th class="r">points</th></tr></thead><tbody>
    ${inc.map((i, k) => `<tr data-k="${k}" class="${A.sel === k ? "on" : ""}"><td>${esc(i.label)}${i.filled ? ` <span class="dim" title="this cell was blank and filled from the previous row">filled</span>` : ""}</td>${r.names.length > 1 ? `<td>${esc(i.column)}</td>` : ""}<td class="r mono">${fmt.n(i.value, 4)}</td><td class="r mono dim">${fmt.n(i.expected, 4)}</td><td class="r mono"><b class="${i.score >= A.thr * 1.6 ? "red" : ""}">${i.score.toFixed(1)}×</b></td><td class="r mono dim">${i.end - i.start + 1}</td></tr>`).join("")}</tbody></table>`
    : `<div class="hint" style="padding:12px">Nothing reaches ${A.thr.toFixed(1)}× — lower the threshold to see the strongest deviations.</div>`;
  $$("#dw-list tr[data-k]").forEach((tr) => tr.onclick = () => selectInc(+tr.dataset.k, true));
  drawWatch();
}
function selectInc(k, focus) {
  A.sel = k;
  $$("#dw-list tr[data-k]").forEach((x) => x.classList.toggle("on", +x.dataset.k === k));
  const i = A.r.incidents[k];
  if (i.col !== A.view && A.r.names.length > 1) { A.view = i.col; $$("#dw-view [data-v]").forEach((x) => x.classList.toggle("on", +x.dataset.v === A.view)); }
  drawWatch();
  if (focus) $("#dw-cv").focusOn(i.peak, Math.max(80, A.r.n / 25));
  const row = $(`#dw-list tr[data-k="${k}"]`); if (row) row.scrollIntoView({ block: "nearest" });
}
function drawWatch() {
  const r = A.r, cv = $("#dw-cv"); if (!r || !cv) return;
  const c = r.chart, j = A.view;
  const marks = r.incidents.map((i, k) => ({ i: i.peak, v: i.value, on: k === A.sel, k, col: i.col })).filter((m) => r.names.length === 1 || m.col === j);
  tsChart(cv, { lo: c.lo[j], hi: c.hi[j], exp: c.exp[j], score: c.score, step: c.step, n: c.n, start: c.start, labels: c.labels, marks, threshold: r.threshold }, {
    onHover: (h) => { const el = $("#dw-hover"); if (!el) return; el.innerHTML = h ? `<b>${esc(String(h.label))}</b> · value ${fmt.n(h.lo, 4)}${h.hi !== h.lo ? "–" + fmt.n(h.hi, 4) : ""} · expected ${fmt.n(h.exp, 4)} · score ${h.score != null ? h.score.toFixed(1) + "×" : "—"}` : "drag to zoom · double-click to reset · click a red dot"; },
    onPick: (m) => selectInc(m.k, false),
  });
}
async function saveWatch() {
  try { const m = await api.post(`/tables/${cur}/anomalies/save`, watchBody()); toast(`Saved ${fmt.n(m.rows)} flagged moments as “${m.name}”`); await reload(cur); }
  catch (e) { toast(e.message, "bad"); }
}
