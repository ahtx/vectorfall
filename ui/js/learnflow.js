// Learn flow: the one Train -> Evaluate -> Infer component for every app that learns from the user's data
// (Reservoir Lab, Sound finder, Anomaly watch, Forces, Planner ...). It gives each app the same three numbered
// steps, each with a visible state, a body the app fills, and an action bar with progress and a Stop button.
//
//   const lf = learnFlow(host, { key, steps: { train: { t, hint }, evaluate: {...}, infer: {...} }, onStep });
//   lf.body("train")              the element the app fills for that step
//   lf.actions("train", html)     the step's buttons (the first .btn without .ghost is the main one)
//   lf.state("train", "done", "88% on held-out examples")   todo | ready | running | done | stale | off
//   lf.go("evaluate")             show a step
//   await lf.run("train", async ({ signal, progress }) => ...)   progress bar + Stop; resolves to the result,
//                                  or null when stopped or failed (failures show a toast and the step's note)
// Helpers for the steps:
//   scoreCard({ value, label, verdict, good, bars: [{ t, v, kind }], note })   the score vs chance and baselines
//   resultsTable(el, { columns, rows, name })   a results table with Save to Data Desk and Download CSV
//   batchBox(el, { accept, placeholder, onFiles, onText })   drop files or paste lines for a batch
import { $, $$, api, esc, icon, toast, go } from "./core.js";

const ORDER = ["train", "evaluate", "infer"];
const DEFAULT = {
  train: { t: "Train", hint: "Your data and settings" },
  evaluate: { t: "Evaluate", hint: "Score on data it did not see" },
  infer: { t: "Infer", hint: "Run it on new inputs" },
};
const STATE_TXT = { todo: "to do", ready: "ready", running: "running", done: "done", stale: "out of date", off: "not yet" };

export function learnFlow(host, { key = "", steps = {}, onStep = () => {}, start = "train", compact = false } = {}) {
  const S = {};
  ORDER.forEach((k) => { S[k] = { ...DEFAULT[k], ...(steps[k] || {}), state: k === "train" ? "ready" : "off", note: "" }; });
  host.classList.add("lf");
  host.classList.toggle("lf-compact", compact);           // narrow side panes: numbers and names only
  host.innerHTML = `<div class="lf-steps" role="tablist">${ORDER.map((k, i) => `<button class="lf-step" type="button" role="tab" data-lf="${k}">
      <span class="lf-n">${i + 1}</span><span class="lf-tx"><b>${esc(S[k].t)}</b><small class="lf-note">${esc(S[k].hint)}</small></span>
      <span class="lf-st" data-st="${k}"></span></button>${i < 2 ? `<span class="lf-arrow">${icon("down")}</span>` : ""}`).join("")}</div>
    ${ORDER.map((k) => `<div class="lf-panel" data-lfp="${k}" hidden><div class="lf-body" data-body="${k}"></div>
      <div class="lf-act"><div class="lf-btns" data-btns="${k}"></div>
        <div class="lf-prog" data-prog="${k}" hidden><div class="lf-bar"><i></i></div><span class="lf-msg"></span>
          <button class="btn ghost xs lf-stop" type="button">${icon("stop")} Stop</button></div></div></div>`).join("")}`;
  let cur = null;
  const ctl = {};
  const paint = (k) => {
    const b = host.querySelector(`.lf-step[data-lf="${k}"]`), s = S[k];
    b.dataset.state = s.state;
    b.querySelector(".lf-st").textContent = STATE_TXT[s.state] || "";
    b.querySelector(".lf-note").textContent = s.note || s.hint;
    b.title = `${s.t}: ${s.note || s.hint}`;
  };
  const api_ = {
    el: host,
    body: (k) => host.querySelector(`[data-body="${k}"]`),
    actions(k, html) { const el = host.querySelector(`[data-btns="${k}"]`); el.innerHTML = html; return el; },
    state(k, state, note) { if (state) S[k].state = state; if (note !== undefined) S[k].note = note; paint(k); },
    get: (k) => S[k],
    current: () => cur,
    go(k) {
      if (!S[k]) return;
      cur = k;
      $$(".lf-step", host).forEach((b) => b.classList.toggle("on", b.dataset.lf === k));
      $$(".lf-panel", host).forEach((p) => { p.hidden = p.dataset.lfp !== k; });
      try { if (key) localStorage.setItem("vf.lf." + key, k); } catch (e) { /* storage off */ }
      onStep(k);
    },
    busy: (k) => !!ctl[k],
    stop(k) { if (ctl[k]) ctl[k].abort(); },
    async run(k, fn, { label = "Working", onError = null } = {}) {
      if (ctl[k]) return null;
      const ac = new AbortController(); ctl[k] = ac;
      const prog = host.querySelector(`[data-prog="${k}"]`), bar = prog.querySelector("i"), msg = prog.querySelector(".lf-msg");
      const btns = host.querySelector(`[data-btns="${k}"]`);
      const was = S[k].state, t0 = performance.now();
      prog.hidden = false; bar.style.width = "0%"; bar.classList.add("indet"); msg.textContent = label + "…";
      btns.querySelectorAll("button").forEach((b) => { b.dataset.lfDis = b.disabled ? "1" : ""; b.disabled = true; });
      prog.querySelector(".lf-stop").onclick = () => { ac.abort(); msg.textContent = "Stopping…"; };
      const tick = setInterval(() => { if (!ctl[k]) return; const s = (performance.now() - t0) / 1000; if (s > 0.4) msg.dataset.t = s.toFixed(s < 10 ? 1 : 0) + " s"; }, 200);
      api_.state(k, "running");
      const progress = (p, m) => {
        if (p != null) { bar.classList.remove("indet"); bar.style.width = Math.max(2, Math.min(100, p * 100)) + "%"; }
        if (m) msg.textContent = m;
      };
      let out = null;
      try {
        out = await fn({ signal: ac.signal, progress });
      } catch (e) {
        if (e && e.cancelled) { toast("Stopped.", "", 2000); api_.state(k, was === "running" ? "ready" : was); }
        else {
          if (!(onError && onError(e))) toast(e.message || String(e), "bad", 7000);
          api_.state(k, was === "running" ? "ready" : was, "failed: " + String(e.message || e).slice(0, 80));
        }
        out = null;
      } finally {
        clearInterval(tick); delete msg.dataset.t;
        delete ctl[k]; prog.hidden = true; bar.classList.remove("indet");
        btns.querySelectorAll("button").forEach((b) => { b.disabled = b.dataset.lfDis === "1"; delete b.dataset.lfDis; });
      }
      if (out !== null && S[k].state === "running") api_.state(k, "done");
      return out;
    },
  };
  $$(".lf-step", host).forEach((b) => b.onclick = () => api_.go(b.dataset.lf));
  ORDER.forEach(paint);
  let first = start;
  try { const s = key && localStorage.getItem("vf.lf." + key); if (s && S[s]) first = s; } catch (e) { /* storage off */ }
  api_.go(first);
  return api_;
}

// ---------------------------------------------------------------- the score, against chance and simple baselines
// bars: [{ t: "label", v: 0..1, kind: "model" | "base" | "chance", tip }]; value is shown big (a string or 0..1)
export function scoreCard({ value, label = "", verdict = "", good = null, bars = [], note = "", fmtv = pct } = {}) {
  const big = typeof value === "number" ? fmtv(value) : esc(value ?? "—");
  return `<div class="lf-score">
    <div class="lf-big ${good === false ? "meh" : ""}"><b>${big}</b><span>${label}</span></div>
    <div class="lf-bars">${bars.map((b) => `<div class="lf-barrow ${b.kind || "base"}" title="${esc(b.tip || "")}"><span>${esc(b.t)}</span>
        <i style="--w:${Math.max(0, Math.min(1, b.v || 0)) * 100}%"></i><b>${b.v == null ? "—" : fmtv(b.v)}</b></div>`).join("")}
      ${verdict ? `<div class="lf-verdict ${good === true ? "good" : good === false ? "bad" : ""}">${verdict}</div>` : ""}
      ${note ? `<div class="hint">${note}</div>` : ""}</div></div>`;
}
export const pct = (v) => v == null ? "—" : (v * 100).toFixed(v >= 0.995 || v < 0.1 ? 0 : 1) + "%";

// ---------------------------------------------------------------- results table: save to the Data Desk, download
const csvCell = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const toCSV = (columns, rows) => [columns.map((c) => csvCell(c.t)).join(",")].concat(rows.map((r) => columns.map((c) => csvCell(c.csv ? c.csv(r) : r[c.k])).join(","))).join("\n");

export async function saveTable(name, columns, rows) {
  const t = await api.post("/tables/paste", { name, text: toCSV(columns, rows) });
  const tid = t.id || (t.table && t.table.id);
  toast(`Saved ${rows.length} rows to the Data Desk as “${t.name || name}”.`, "good", 5000);
  return tid;
}

export function resultsTable(el, { columns, rows, name = "results", max = 500, note = "" }) {
  const shown = rows.slice(0, max);
  el.innerHTML = `<div class="lf-rt-h"><span class="hint">${rows.length.toLocaleString()} row${rows.length === 1 ? "" : "s"}${rows.length > max ? ` · the table shows the first ${max}; Save and Download keep all` : ""}${note ? " · " + note : ""}</span>
      <span class="sp"></span><button class="btn ghost xs" data-lf-dl>${icon("down")} Download CSV</button><button class="btn xs" data-lf-save>${icon("data")} Save to Data Desk</button></div>
    <div class="lf-rt"><table class="tbl"><thead><tr>${columns.map((c) => `<th class="${c.num ? "num" : ""}">${esc(c.t)}</th>`).join("")}</tr></thead>
      <tbody>${shown.map((r) => `<tr class="${r._cls || ""}">${columns.map((c) => `<td class="${c.num ? "num" : ""}">${c.html ? c.html(r) : esc(r[c.k] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  el.querySelector("[data-lf-dl]").onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([toCSV(columns, rows)], { type: "text/csv" }));
    a.download = name.replace(/[^\w.-]+/g, "_") + ".csv"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  el.querySelector("[data-lf-save]").onclick = async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try { const tid = await saveTable(name, columns, rows); b.innerHTML = `${icon("data")} Open in Data Desk`; b.disabled = false; b.onclick = () => go("data", tid ? { table: tid } : {}); }
    catch (err) { toast(err.message, "bad"); b.disabled = false; }
  };
}

// ---------------------------------------------------------------- batch input: drop files or paste lines
export function batchBox(el, { accept = "", placeholder = "", onFiles = null, onText = null, filesHint = "Drop files here, or click to choose" }) {
  el.innerHTML = `${onFiles ? `<div class="lf-drop" tabindex="0">${icon("upload")}<span>${esc(filesHint)}</span><input type="file" multiple ${accept ? `accept="${esc(accept)}"` : ""} hidden></div>` : ""}
    ${onText ? `<textarea class="in lf-paste" rows="4" placeholder="${esc(placeholder)}"></textarea>` : ""}`;
  if (onFiles) {
    const d = el.querySelector(".lf-drop"), inp = d.querySelector("input");
    d.onclick = () => inp.click();
    d.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inp.click(); } };
    inp.onchange = () => { if (inp.files.length) onFiles([...inp.files]); inp.value = ""; };
    d.ondragover = (e) => { e.preventDefault(); d.classList.add("over"); };
    d.ondragleave = () => d.classList.remove("over");
    d.ondrop = (e) => { e.preventDefault(); d.classList.remove("over"); if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]); };
  }
  if (onText) el.querySelector(".lf-paste").oninput = (e) => onText(e.target.value);
  return el;
}
