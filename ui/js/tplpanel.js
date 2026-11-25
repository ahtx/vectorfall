import { $, $$, api, esc, fail, icon, toast, watchJob, cancelJob } from "./core.js";
import { pickColumns } from "./hub.js";
import { callMenu } from "./callcopy.js";

// "Your problem" for the labs whose own screens are built around projects and worlds (Reservoir, Particle Lab):
// a dialog with the templates of that lab, the text boxes of the chosen one (checked by problem.check as you type,
// naming the line), Data Desk loading, Solve as a background job with progress and Stop, the answer with its
// baseline and the explanation, and Copy as… (Console, MCP, curl, vf).
const TEXT = { numbers: "The series", examples: "Labelled recordings", test: "New recordings to label (optional)", text: "The group: CSV" };
const CHECK = { "reservoir.updown": ["updown", "numbers"], "reservoir.classify": ["classify", "examples"], "particles.group": ["group", "text"] };
const NUMS = { horizon: ["Steps ahead", 1, 60] };
let D = null, ctl = null;

const post = async (path, body) => { const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }); const j = await r.json(); if (!r.ok) throw new Error((j.error || {}).message || r.statusText); return j; };

function css() {
  if (document.querySelector('link[href="css/tplpanel.css"]')) return;
  const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "css/tplpanel.css"; document.head.appendChild(l);
}
export async function openProblem(app, onDone) {
  close(); css();
  D = document.createElement("div");
  D.className = "tp-ovl";
  D.innerHTML = `<div class="tp-box pane"><div class="pane-h"><div class="t">Your problem</div><div class="meta">${app === "reservoir" ? "Reservoir Lab" : "Particle Lab"} · from text or a Data Desk table</div>
      <div class="tools"><button class="btn ghost xs" id="tp-as" disabled>${icon("console")} Copy as…</button><button class="iconbtn" id="tp-x" title="Close (Esc)">${icon("x")}</button></div></div>
    <div class="tp-body"><div class="list tp-list" id="tp-list"><div class="li"><div class="sub">loading…</div></div></div>
      <div class="tp-main" id="tp-main"><div class="empty">Pick a template on the left.</div></div></div></div>`;
  document.body.appendChild(D);
  $("#tp-x").onclick = close;
  D.addEventListener("mousedown", (e) => { if (e.target === D) close(); });
  document.addEventListener("keydown", esc_);
  try {
    const r = await post("/v1/models/problem.templates", { app });
    const ts = r.result.templates;
    $("#tp-list").innerHTML = ts.map((t) => `<div class="li" data-t="${esc(t.id)}"><div class="tx"><div class="nm">${esc(t.title)}</div><div class="sub">${esc(t.problem)}</div></div></div>`).join("");
    $$("#tp-list [data-t]").forEach((b) => b.onclick = () => load(b.dataset.t, onDone));
    if (ts[0]) load(ts[0].id, onDone);
  } catch (e) { fail(e); }
}
function esc_(e) { if (e.key === "Escape") close(); }
function close() { if (D) { D.remove(); D = null; document.removeEventListener("keydown", esc_); } }

let T = null, chkT = 0;
async function load(id, onDone) {
  let t;
  try { t = (await post("/v1/models/problem.template", { id })).result; } catch (e) { fail(e); return; }
  T = t;
  $$("#tp-list [data-t]").forEach((b) => b.classList.toggle("on", b.dataset.t === id));
  const texts = Object.keys(t.params).filter((k) => TEXT[k]), nums = Object.keys(t.params).filter((k) => NUMS[k]);
  $("#tp-main").innerHTML = `<div class="tp-maps"><b>${esc(t.title)}:</b> ${esc(t.maps)}</div>
    ${texts.map((k) => `<div class="tp-in"><div class="tp-inh"><b>${esc(TEXT[k])}</b><span class="spacer"></span>${k !== "test" ? `<button class="btn ghost xs" data-dd="${k}" title="Load a Data Desk table into this box">${icon("data")} Data Desk…</button>` : ""}</div>
      <textarea class="in mono" data-k="${k}" spellcheck="false" wrap="off" rows="${k === "test" ? 3 : 9}">${esc(t.params[k])}</textarea>${CHECK[t.model] && CHECK[t.model][1] === k ? `<div class="tp-chk" id="tp-chk"></div>` : ""}</div>`).join("")}
    <div class="tp-row">${nums.map((k) => `<label class="tp-num">${esc(NUMS[k][0])} <input class="in sm mono" type="number" data-n="${k}" min="${NUMS[k][1]}" max="${NUMS[k][2]}" value="${esc(t.params[k])}"></label>`).join("")}
      ${t.model.startsWith("reservoir.") ? `<label class="tp-num"><input type="checkbox" id="tp-keep"> keep the project in the lab</label>` : ""}
      <span class="spacer"></span><span class="hint" id="tp-time"></span><button class="btn ghost sm" id="tp-stop" hidden>${icon("stop")} Stop</button><button class="btn sm" id="tp-go">${icon("bolt")} Solve on the card</button></div>
    <div class="tp-res" id="tp-res"></div>`;
  $$("#tp-main textarea").forEach((ta) => ta.oninput = () => { clearTimeout(chkT); chkT = setTimeout(check, 250); });
  $$("#tp-main [data-dd]").forEach((b) => b.onclick = () => fromDesk(b.dataset.dd));
  $("#tp-go").onclick = () => solve(onDone);
  $("#tp-as").disabled = false;
  $("#tp-as").onclick = (e) => callMenu(e.currentTarget, T.model, body(), true);
  check();
}
function body() {
  const b = {};
  $$("#tp-main textarea").forEach((ta) => { if (ta.value.trim()) b[ta.dataset.k] = ta.value; });
  $$("#tp-main [data-n]").forEach((i) => { b[i.dataset.n] = +i.value; });
  const kp = $("#tp-keep"); if (kp && kp.checked) b.keep = true;
  return b;
}
async function check() {
  const c = CHECK[T.model], el = $("#tp-chk"); if (!c || !el) return;
  const ta = $(`#tp-main textarea[data-k="${c[1]}"]`), hz = $('#tp-main [data-n="horizon"]');
  try {
    const r = (await post("/v1/models/problem.check", { kind: c[0], text: ta.value, horizon: hz ? +hz.value : 1 })).result;
    el.innerHTML = r.ok ? `<div class="tp-ok">${icon(r.warnings.length ? "eye" : "spark")}<b class="${r.warnings.length ? "warn" : "good"}">${r.warnings.length ? "look at this" : "looks right"}</b> <span>${r.facts.map(esc).join(" · ")}</span></div>${r.warnings.map((w) => `<div class="tp-msg">${esc(w)}</div>`).join("")}`
      : `<div class="tp-ok">${icon("x")}<b class="bad">1 problem</b></div><div class="tp-msg err">${esc(r.error)}</div>`;
  } catch (e) { el.textContent = e.message; }
}
async function fromDesk(k) {
  const pick = await pickColumns({ title: "Load a Data Desk table", multi: true, min: 0, hint: k === "numbers" ? "Tick one column: its numbers go into the box, one per line." : "The whole table goes into the box as CSV." });
  if (!pick) return;
  try {
    const ta = $(`#tp-main textarea[data-k="${k}"]`);
    if (k === "numbers") {
      const t = (await api.get("/tables")).find((x) => x.id === pick.tid), col = pick.cols[0] || (t && t.numeric[0]);
      const r = await api.get(`/tables/${pick.tid}/series?${new URLSearchParams({ cols: col, date_col: "auto" })}`);
      ta.value = col + "\n" + r.values[0].map((v) => +v.toPrecision(10)).join("\n");
    } else ta.value = await (await api.raw("GET", `/tables/${pick.tid}/csv`)).text();
    check(); toast(`Loaded “${pick.table}”`, "good", 1600);
  } catch (e) { fail(e); }
}
async function solve(onDone) {
  const go = $("#tp-go"), stop = $("#tp-stop"), tm = $("#tp-time"), res = $("#tp-res"), t0 = performance.now();
  go.disabled = true; stop.hidden = false; res.classList.add("is-busy");
  ctl = new AbortController();
  stop.onclick = () => ctl.abort();
  try {
    const j = await post(`/v1/models/${T.model}?async=1`, body());
    const r = await watchJob(j.job, (s) => { tm.textContent = `${Math.round((s.progress || 0) * 100)}% ${s.message || ""} · ${Math.round((performance.now() - t0) / 1000)} s`; }, { signal: ctl.signal });
    const o = r.result || r;
    tm.textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s`;
    res.innerHTML = `<section class="sm-verdict tp-verdict"><div class="hl ${esc(o.tone || "")}">${esc(o.headline || "")}</div><div class="txt"><p>${esc(o.sentence || "")}</p>
        ${o.compare_text ? `<p class="dw-check">${esc(o.compare_text)}</p>` : ""}</div></section>
      ${(o.explain || []).length ? `<details open class="tp-exp"><summary>Explain my result</summary><ul>${o.explain.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>` : ""}
      ${o.project ? `<div class="hint">Kept as a project in the Reservoir Lab.</div>` : ""}`;
    if (onDone) onDone(o, T);
  } catch (e) { res.innerHTML = `<div class="tp-msg err">${esc(e.cancelled ? "Stopped." : e.message)}</div>`; tm.textContent = ""; }
  go.disabled = false; stop.hidden = true; res.classList.remove("is-busy"); ctl = null;
}
export { cancelJob };
