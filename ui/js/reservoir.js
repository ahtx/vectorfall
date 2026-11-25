// Reservoir Lab: teach a fixed random dynamical system (an echo network, or a literal ripple tank) to recognise things.
// Left: projects and real demo datasets. Centre: collect labelled examples (mic, camera, files, numbers) -> Train ->
// Test (one-off or live). Right: the reservoir's settings and the waves it makes, i.e. the small pictures that the
// one trained layer actually reads. Forecast projects predict "up or down over the next N periods" for a series and
// always show the result against simple rules and chance.
import { $, $$, api, esc, fmt, icon, pane, toast, watchJob } from "./core.js";
import { heatmap } from "./charts.js";
import { mic } from "./mic.js";
import { learnFlow, scoreCard, resultsTable, batchBox } from "./learnflow.js";
import { openProblem } from "./tplpanel.js";

const KIND = {
  audio: { t: "Sounds", ic: "sound", hint: "words, sounds, voices — from the mic or audio files" },
  image: { t: "Images", ic: "photo", hint: "pictures — from the camera or image files" },
  numbers: { t: "Sequences", ic: "trend", hint: "number sequences, one per example (a shape: spike, ramp, wobble …)" },
  series: { t: "Forecast", ic: "forecast", hint: "one long series: will it be up or down N periods from now?" },
};
const DEMOS = [
  { id: "digits-spoken", t: "Spoken digits", s: "240 real recordings of 0–9 (FSDD), 3 speakers" },
  { id: "digits-written", t: "Handwritten digits", s: "400 MNIST digits, scanned row by row" },
  { id: "spy", t: "SPY up/down in 5 days", s: "10 years of daily S&P 500 ETF closes" },
];
let projects = [], P = null, mode = "train", label = "", busyTrain = false, lastTest = null, sel = null;
let cam = null, live = false, lastInput = null, imgSrc = "camera";   // lastInput: the last tested input, so a wrong call can be taught
let booting = null, wantOpen = null;      // wantOpen: a project being opened (a deep link must win over the boot default)
let lf = null, stale = false, staged = "", batch = null;   // lf: the Train -> Evaluate -> Infer flow of the open project
let autoRun = (() => { try { return localStorage.getItem("vf.rv.auto") === "1"; } catch (e) { return false; } })();

// another app sent a Data Desk column: a new forecast project on it, trained straight away
async function fromDesk(tid, col) {
  try {
    await booting;
    const p = await api.post("/reservoir/projects", { name: `${col}: up or down`, kind: "series" });
    await api.post(`/reservoir/projects/${p.id}/series`, { table: tid, target: col });
    await refresh(p.id);
    await open(p.id);
    train();
  } catch (e) { toast(e.message, "bad", 7000); }
}

export default {
  id: "reservoir", title: "Reservoir Lab", sub: "teach a random dynamical system to recognise and forecast", icon: "reservoir",
  mount(el) {
    el.innerHTML = `<div class="ws side-lr rv">
      <div class="col">
        ${pane({ t: "Projects", bid: "rv-list", bcls: "flush", cls: "grow", foot: "&nbsp;", id: "rv-l", tools: `<button class="btn xs" id="rv-yours" title="Your own series or recordings as text (or a Data Desk table), from a template: one call, scored against chance and the simple rules">${icon("spark")} Your problem…</button>` })}
        ${pane({ t: "New", bid: "rv-new", cls: "fit" })}
      </div>
      <div class="col rv-mid" id="rv-mid"></div>
      <div class="col">
        <section class="pane fit"><div class="pane-h"><div class="t">Reservoir</div><div class="meta" id="rv-rmeta"></div></div>
          <div class="pane-b" id="rv-res"></div></section>
        <section class="pane grow"><div class="pane-h"><div class="t">Waves</div><div class="meta" id="rv-wmeta">pick an example</div></div>
          <div class="pane-b" id="rv-waves"></div></section>
      </div>
    </div>`;
    $("#rv-new").innerHTML = `<div class="rv-newg">${Object.entries(KIND).map(([k, v]) => `<button class="btn ghost sm" data-new="${k}" title="${esc(v.hint)}">${icon(v.ic)} ${v.t}</button>`).join("")}</div>
      <div class="sec-t" style="margin-top:12px">Real demo data</div>
      ${DEMOS.map((d) => `<div class="li rv-demo" data-demo="${d.id}"><div class="tx"><div class="nm">${esc(d.t)}</div><div class="sub">${esc(d.s)}</div></div><span class="end">load</span></div>`).join("")}`;
    $$("#rv-new [data-new]").forEach((b) => b.onclick = () => newProject(b.dataset.new));
    $("#rv-yours").onclick = () => openProblem("reservoir", (o) => { if (o.project) refresh(o.project); });
    $$("#rv-new [data-demo]").forEach((b) => b.onclick = () => loadDemo(b));
    booting = refresh();
  },
  show(params) {
    if (params && params.forecast) fromDesk(params.forecast, params.col);
    else if (params && params.p) open(params.p);
  },
  hide() { stopMic(); stopCam(); },
};

// ---------------------------------------------------------------- projects
async function refresh(openId) {
  try { projects = await api.get("/reservoir/projects"); } catch (e) { projects = []; }
  $("#rv-list").innerHTML = projects.length ? `<div class="list">${projects.map((p) => `<div class="li ${P && P.id === p.id ? "on" : ""}" data-p="${p.id}">
      <div class="ic">${icon(KIND[p.kind].ic)}</div><div class="tx"><div class="nm">${esc(p.name)}</div>
      <div class="sub">${p.kind === "series" ? "forecast" : `${p.n} examples · ${p.classes.length} labels`}${p.trained ? " · " + esc(p.trained) : ""}</div></div>
      <button class="iconbtn xdel" data-del="${p.id}" title="Delete project">${icon("trash")}</button></div>`).join("")}</div>`
    : `<div class="empty">No projects yet.<br>Start one below, or load a real demo dataset.</div>`;
  $("#rv-l-f").innerHTML = `<span>${projects.length} projects</span><span>~/data/reservoir</span>`;
  $$("#rv-list [data-p]").forEach((b) => b.onclick = (e) => { if (!e.target.closest("[data-del]")) open(b.dataset.p); });
  $$("#rv-list [data-del]").forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    const p = projects.find((x) => x.id === b.dataset.del);
    if (!confirm(`Delete “${p.name}” and its ${p.n} examples?`)) return;
    await api.del("/reservoir/projects/" + p.id); if (P && P.id === p.id) { P = null; $("#rv-mid").innerHTML = ""; }
    refresh();
  });
  if (openId) open(openId);
  else if (!P && !wantOpen && projects.length) open(projects[0].id);
  else if (!projects.length) welcome();
}
function welcome() {
  $("#rv-mid").innerHTML = pane({ t: "Reservoir computing", cls: "grow", body: `<div class="rv-intro">
    <p>A <b>reservoir</b> is a fixed, random dynamical system. Here it is a network of 400 recurrent units, or a real
    <b>ripple tank</b> of simulated water. You put an input into it (a word that you say, a picture, a series of prices), and it rings.
    The Lab never trains the reservoir itself.</p>
    <p>The Lab records how the reservoir rang at some moments and makes these records into small grids. Then it trains <b>one linear layer</b> to
    tell them apart. The card calculates that layer exactly in milliseconds. Thus a small number of examples for each label is sufficient to start.</p>
    <ol><li>Make a project (Sounds, Images, Sequences or Forecast) or load a real demo dataset.</li>
    <li>Collect a few labelled examples: say “hello” five times, then “bye” five times.</li>
    <li>Press <b>Train</b>. You get an honest accuracy. The Lab measures it on examples that it did not train on. It shows it next to chance, and next to the same layer without the reservoir.</li>
    <li>Look at <b>Evaluate</b>: the score on examples that the training did not see, next to chance and a simple baseline.</li>
    <li>Go to <b>Infer</b>: say a word, draw, snap or drop files, and press <b>Run</b>. Drop many files to classify them all and save the results to the Data Desk.</li></ol></div>` });
  renderRes(); $("#rv-waves").innerHTML = "";
}
async function newProject(kind) {
  const name = prompt(`Name for the new ${KIND[kind].t.toLowerCase()} project:`, kind === "series" ? "Up or down" : kind === "audio" ? "Hello vs bye" : "");
  if (name === null) return;
  const p = await api.post("/reservoir/projects", { name, kind });
  refresh(p.id);
}
async function loadDemo(b) {
  b.classList.add("is-busy"); b.querySelector(".end").textContent = "loading…";
  try {
    const { job } = await api.post("/reservoir/demo/" + b.dataset.demo);
    const r = await watchJob({ id: job, state: "running" }, (j) => { b.querySelector(".end").textContent = j.state === "running" ? Math.round((j.progress || 0) * 100) + "%" : ""; });
    toast(`Loaded ${r.n} ${b.dataset.demo === "spy" ? "days" : "examples"}`, "good"); refresh(r.id);
  } catch (e) { toast(e.message, "bad", 7000); }
  b.classList.remove("is-busy"); b.querySelector(".end").textContent = "load";
}
async function open(id) {
  wantOpen = id;
  stopMic(); stopCam(); live = false; lastTest = null; sel = null; strokes = [];
  try { P = await api.get("/reservoir/projects/" + id); } catch (e) { toast(e.message, "bad"); return; }
  imgSrc = P.kind === "image" && (P.examples || []).some((e) => /^MNIST/.test(e.source || "")) ? "draw" : "camera";
  $$("#rv-list [data-p]").forEach((b) => b.classList.toggle("on", b.dataset.p === id));
  if (!label || !(P.classes || []).includes(label)) label = (P.classes || [])[0] || "";
  mode = "train"; staged = ""; batch = null;
  stale = !!(P.trained && P.task !== "forecast" && P.trained.n !== (P.examples || []).length);
  renderRes();
  if (P.task === "forecast") renderForecast(); else renderClassify();
  $("#rv-waves").innerHTML = `<div class="hint">${P.task === "forecast" ? "A forecast pours the whole series through the echo network once, in order. Each period's state of all its units, plus the last few moves, is what the decision layer reads to call up or down." : "Click an example to see the waves it makes in the reservoir, and the snapshots the decision layer reads."}</div>`;
  $("#rv-wmeta").textContent = "pick an example";
}
async function reload() { P = await api.get("/reservoir/projects/" + P.id); }

// ---------------------------------------------------------------- reservoir settings (right)
function renderRes() {
  const box = $("#rv-res");
  if (!P) { box.innerHTML = `<div class="hint">Settings appear when a project is open.</div>`; $("#rv-rmeta").textContent = ""; return; }
  const r = P.reservoir, ripple = r.type === "ripple", fc = P.task === "forecast";
  const sl = (k, l, min, max, step, v, tip) => `<div class="fld" title="${esc(tip)}"><label>${l}</label><input type="range" data-r="${k}" min="${min}" max="${max}" step="${step}" value="${v}"><span class="v" data-v="${k}">${v}</span></div>`;
  const img = P.kind === "image", clipOn = img && P.encoder === "clip";
  const enc = img ? `<div class="sec-t">What the layer reads</div><div class="seg rv-type rv-enc"><button data-enc="reservoir" class="${clipOn ? "" : "on"}" title="the reservoir's snapshots (plus the raw input)">Reservoir</button><button data-enc="clip" class="${clipOn ? "on" : ""}" title="CLIP ViT-B/32 features — a network pretrained on 400 million captioned images (needs the model, from the Photo Lab)">CLIP (pretrained)</button></div>
    ${clipOn ? `<div class="hint rv-reshint">CLIP turns each picture into 512 numbers learned from 400 million captioned images; only the same one linear layer is trained on top. The reservoir settings below aren't used while CLIP is selected.</div>` : ""}` : "";
  box.innerHTML = enc + `${fc ? "" : `<div class="seg rv-type"><button data-t="esn" class="${ripple ? "" : "on"}" title="400 tanh units with random recurrent connections">Echo network</button><button data-t="ripple" class="${ripple ? "on" : ""}" title="A simulated 2-D water surface; each input channel pushes it at its own spot">Ripple tank</button></div>`}
    <div class="fields">
      ${ripple ? sl("ripple_damp", "Damping", 0, 0.2, 0.01, r.ripple_damp, "how fast the ripples stop: less = longer memory")
        + sl("ripple_nl", "Nonlinearity", 0, 2, 0.1, r.ripple_nl, "how much tall waves make the water stiffer. The classes separate only with some of it.")
        + sl("substeps", "Substeps", 1, 6, 1, r.substeps, "wave steps per input frame")
      : `<div class="fld" title="how many recurrent units"><label>Units</label><select class="sel sm" data-r="units">${[144, 256, 400, 625, 900, 1024].map((u) => `<option ${u === r.units ? "selected" : ""}>${u}</option>`).join("")}</select></div>`
        + sl("leak", "Leak", 0.05, 1, 0.05, r.leak, "how fast the units respond: lower = slower, longer memory")
        + sl("radius", "Echo", 0.1, 1.4, 0.05, r.radius, "spectral radius: how long the echoes last. Near 1 is the edge of chaos.")}
      ${sl("input_scale", "Input drive", 0.1, 3, 0.1, r.input_scale, "how hard the input pushes the reservoir")}
      ${fc ? "" : sl("snapshots", "Snapshots", 1, 12, 1, r.snapshots, "how many moments of the ringing the decision layer sees")}
      ${sl("seed", "Seed", 0, 99, 1, r.seed, "which random reservoir: same seed = same reservoir")}
    </div>
    <div class="hint rv-reshint">${ripple ? "A 64×64 tank of simulated water. Each snapshot = the surface height and energy, averaged over a slice of the input, pooled to 16×16."
      : `${r.units} units wired at random (${Math.round(r.density * 100)}% of possible links). Each snapshot = all units' average activity over a slice of the input, drawn as a ${Math.round(Math.sqrt(r.units))}×${Math.round(Math.sqrt(r.units))} grid.`}
      Changing anything here means pressing Train again.</div>`;
  $("#rv-rmeta").textContent = fc ? "echo network" : ripple ? "ripple tank" : "echo network";
  let t = 0;
  const push = () => { clearTimeout(t); t = setTimeout(async () => {
    const body = { reservoir: {} };
    $$("#rv-res [data-r]").forEach((i) => { body.reservoir[i.dataset.r] = +i.value; });
    P = await api.raw("PATCH", "/reservoir/projects/" + P.id, body).then((r2) => r2.json());
    markStale();
  }, 350); };
  $$("#rv-res [data-r]").forEach((i) => {
    i.oninput = () => { const v = $(`#rv-res [data-v="${i.dataset.r}"]`); if (v) v.textContent = i.value; };
    i.onchange = push;
  });
  $$("#rv-res [data-enc]").forEach((b) => b.onclick = async () => {
    try { P = await api.raw("PATCH", "/reservoir/projects/" + P.id, { encoder: b.dataset.enc }).then((r2) => r2.json()); } catch (e) { toast(e.message, "bad"); }
    renderRes(); markStale();
  });
  $$("#rv-res [data-t]").forEach((b) => b.onclick = async () => {
    P = await api.raw("PATCH", "/reservoir/projects/" + P.id, { reservoir: { type: b.dataset.t } }).then((r2) => r2.json());
    renderRes(); markStale();
    if (sel) peek(sel);
  });
}
function markStale() {
  stale = !!(P && P.trained);
  flowState();
  if (sel) peek(sel);
}

// ---------------------------------------------------------------- classification projects (centre)
function renderClassify() {
  $("#rv-mid").innerHTML = `<section class="pane grow rv-flow"><div class="pane-b flush" id="rv-lf"></div></section>`;
  lf = learnFlow($("#rv-lf"), {
    key: "rv", start: P.trained ? "evaluate" : "train",
    steps: { train: { hint: "Collect labelled examples, then train" }, evaluate: { hint: "Score on examples it did not see" },
      infer: { hint: "Classify new inputs, one or many" } },
    onStep: setMode,
  });
  lf.body("train").innerHTML = `<div class="rv-capture" id="rv-capture"></div>
    <div class="sec-t rv-exh">Examples <span class="x" id="rv-exmeta"></span></div><div id="rv-ex"></div>`;
  lf.actions("train", `<button class="btn" id="rv-train" data-primary>${icon("bolt")} Train</button>
    <span class="chip red" id="rv-stale" hidden>examples or settings changed: train again</span><span class="hint" id="rv-trhint"></span>`);
  lf.body("evaluate").innerHTML = `<div class="hint rv-evmeta" id="rv-rmeta2"></div><div id="rv-result"></div>`;
  lf.actions("evaluate", `<button class="btn ghost" id="rv-retrain">${icon("bolt")} Train again</button><button class="btn" id="rv-toinfer">Infer on new inputs ${icon("play")}</button>`);
  lf.body("infer").innerHTML = `<div class="lf-sec"><div class="sec-t">One input</div><div class="rv-capture" id="rv-icap"></div>
      <div class="lf-staged" id="rv-staged" hidden></div><div id="rv-iout"></div></div>
    <div class="lf-sec"><div class="sec-t">Many inputs at once</div><div id="rv-batch"></div><div id="rv-bout"></div></div>`;
  lf.actions("infer", `<button class="btn" id="rv-run" data-primary disabled>${icon("play")} Run</button>
    <label class="hint rv-auto" title="Classify each new recording, snap or drawing as soon as it arrives"><input type="checkbox" id="rv-autorun" ${autoRun ? "checked" : ""}> run on each new input</label>
    <button class="btn ghost" id="rv-runb" disabled>${icon("play")} Run the batch</button>`);
  $("#rv-train").onclick = train;
  $("#rv-retrain").onclick = () => { lf.go("train"); train(); };
  $("#rv-toinfer").onclick = () => lf.go("infer");
  $("#rv-run").onclick = () => runStaged();
  $("#rv-runb").onclick = runBatch;
  $("#rv-autorun").onchange = (e) => { autoRun = e.target.checked; try { localStorage.setItem("vf.rv.auto", autoRun ? "1" : "0"); } catch (er) { /* storage off */ } };
  renderBatch();
  renderExamples(); renderTrained(); flowState();
  setMode(lf.current());
}
// the three steps' states, from the project: examples, a training result, and whether it is out of date
function flowState() {
  if (!lf || !P || P.task === "forecast") return;
  const n = (P.examples || []).length, nl = (P.classes || []).length, t = P.trained;
  const okTrain = nl >= 2;
  const th = $("#rv-trhint"); if (th) th.textContent = okTrain ? `${n} examples · ${nl} labels` : "needs examples of at least 2 labels";
  const tb = $("#rv-train"); if (tb && !lf.busy("train")) tb.disabled = !okTrain;
  const st = $("#rv-stale"); if (st) st.hidden = !(stale && t);
  lf.state("train", t ? (stale ? "stale" : "done") : okTrain ? "ready" : "todo", t ? (stale ? "changed since the last training" : `trained on ${t.n} examples`) : okTrain ? `${n} examples: ready to train` : "collect examples of 2+ labels");
  lf.state("evaluate", t ? (stale ? "stale" : "done") : "off", t ? (t.cv ? `${pct(t.cv.acc)} held-out · chance ${pct(t.chance)}` : "needs 2+ examples per label") : "train first");
  lf.state("infer", t ? "ready" : "off", t ? "classify new inputs" : "train first");
}
function setMode(step) {
  const m = step === "infer" ? "test" : step === "train" ? "train" : "eval";
  if (m !== mode) { live = false; if (mic.isOpen) mic.disarm(); }
  mode = m;
  if (!P || P.task === "forecast") return;
  if (m === "test" && !P.trained) toast("Press Train first. Then Infer classifies new inputs.");
  renderCapture();
}

function labelBar() {
  const cls = P.classes || [];
  return `<div class="rv-labels"><span class="hint">Label</span>${cls.map((c) => `<button class="tok ${c === label ? "on" : ""}" data-lab="${esc(c)}">${esc(c)} <b>${P.counts[c]}</b></button>`).join("")}
    <input class="in sm" id="rv-label" placeholder="${cls.length ? "or a new label…" : "label, for example hello"}" value="${cls.includes(label) ? "" : esc(label)}" maxlength="40"></div>`;
}
function renderCapture() {
  const k = P.kind, test = mode === "test";
  const box = $(test ? "#rv-icap" : "#rv-capture"), other = $(test ? "#rv-capture" : "#rv-icap");
  if (other) other.innerHTML = "";               // one set of capture controls at a time (they share ids)
  if (!box || mode === "eval") return;
  let ctl = "";
  if (k === "audio") ctl = `<div class="rv-mic">
      <div class="rv-row">
        <select class="sel sm rv-dev" id="rv-dev" title="Which microphone to use (remembered in this browser)"><option value="">Default input</option></select>
        <div class="rv-vu" id="rv-vu" title="Live level in dBFS (−60 … 0). Grey tick = the room's noise floor; red tick = where recording starts."><i class="lv"></i><b class="fl"></b><b class="th"></b></div>
        <span class="mono rv-db" id="rv-db">mic off</span>
        <label class="rv-sens" title="How far above the room's noise a sound has to rise before recording starts. Lower = more sensitive.">Starts at
          <input type="range" id="rv-sens" min="4" max="30" step="1" value="${mic.sensitivity}"><span class="mono" id="rv-sensv">floor +${mic.sensitivity} dB</span></label>
        <button class="btn ghost xs" id="rv-micon" title="Open the microphone to watch the level without recording">${mic.isOpen ? "Mic off" : "Mic check"}</button>
      </div>
      <div class="rv-row">
        <button class="btn sm rv-rec" id="rv-rec" title="Waits for you to speak, records until you stop">${icon("sound")} ${test ? "Say something" : "Record one"}</button>
        <button class="btn ghost sm rv-hold" id="rv-hold" title="Records while held down (mouse, touch, or Space) — no voice detection">Hold to record</button>
        <button class="btn ghost sm" id="rv-live" title="Keep listening: every utterance is ${test ? "classified" : "added with the current label"}">${live ? "■ Stop listening" : "● Live"}</button>
        <span class="hint" id="rv-mstate">${mic.isOpen ? "" : "mic off"}</span>
        <span class="sp"></span><button class="btn ghost sm" id="rv-file">${icon("upload")} Audio files…</button></div>
      <div class="rv-mdiag" id="rv-mdiag" hidden></div></div>`;
  if (k === "image") {
    const seg = `<div class="seg rv-isrc">${[["camera", "Camera"], ["draw", "Draw"], ["files", "Files"]].map(([v, l]) => `<button data-isrc="${v}" class="${imgSrc === v ? "on" : ""}">${l}</button>`).join("")}</div>`;
    if (imgSrc === "camera") ctl = `<div class="rv-row">${seg}
      <button class="btn sm" id="rv-cam">${icon("photo")} ${cam ? "Camera off" : "Camera on"}</button>
      <button class="btn ghost sm" id="rv-snap" ${cam ? "" : "disabled"}>${test ? "Snap" : "Snap an example"}</button>
      <button class="btn ghost sm" id="rv-live" ${cam ? "" : "disabled"} title="Snap every second">${live ? "■ Stop" : "● Live"}</button></div>
      <div class="rv-cambox" ${cam ? "" : "hidden"}><video id="rv-video" autoplay playsinline muted></video></div>`;
    else if (imgSrc === "draw") ctl = `<div class="rv-row">${seg}<span class="hint">${test ? "draw, then press Run (or turn on “run on each new input”)" : "draw one example, then click Add"}</span></div>
      <div class="rv-draw"><canvas id="rv-pad" width="280" height="280"></canvas>
        <div class="rv-drawside"><div class="sec-t">what the model reads</div><canvas id="rv-norm" width="28" height="28"></canvas>
          <div class="hint">cropped to the ink, fitted into 20 px and centred by its mass in 28 × 28 — the way MNIST digits were made</div>
          <div class="rv-row"><button class="btn ghost sm" id="rv-undo">${icon("undo")} Undo</button><button class="btn ghost sm" id="rv-clear">${icon("x")} Clear</button>
            ${test ? "" : `<button class="btn sm" id="rv-addd">Add</button>`}</div></div></div>`;
    else ctl = `<div class="rv-row">${seg}<button class="btn sm" id="rv-file">${icon("upload")} Image files…</button><span class="hint">or drop images anywhere in this panel</span></div>`;
  }
  if (k === "numbers") ctl = `<textarea class="in rv-nums" id="rv-nums" rows="3" placeholder="${test ? "one sequence to classify, for example 1 2 3 5 8 13 21" : "one sequence on each line. Each line becomes an example with this label."}"></textarea>
      <div class="rv-row"><button class="btn sm" id="rv-addn">${test ? "Use this sequence" : "Add"}</button><span class="hint">Put spaces or commas between the numbers. The Lab scales each sequence again, so only its shape is important.</span></div>`;
  const filesOn = k === "audio" || (k === "image" && imgSrc === "files");
  box.innerHTML = (test ? "" : labelBar()) + ctl + (filesOn ? `<label class="rv-fromname" ${test ? "hidden" : ""}><input type="checkbox" id="rv-fname"> label files from their folder or the start of their name (for example <span class="mono">7_jackson_0.wav</span> → 7)</label>` : "")
    + (!window.isSecureContext && (k === "audio" || (k === "image" && imgSrc === "camera")) ? `<div class="rv-secure">Browsers only allow the ${k === "audio" ? "microphone" : "camera"} on a secure page. Open <a href="https://${location.hostname}:8493/${location.hash}">https://${esc(location.hostname)}:8493</a> (accept the certificate warning once), or use files.</div>` : "");
  $$("[data-lab]", box).forEach((b) => b.onclick = () => { label = b.dataset.lab; renderCapture(); });
  const li = $("#rv-label"); if (li) li.oninput = () => { label = li.value.trim(); $$("[data-lab]", box).forEach((b) => b.classList.remove("on")); };
  const f = $("#rv-file");
  if (f) {
    const input = document.createElement("input"); input.type = "file"; input.multiple = true; input.accept = k === "audio" ? "audio/*,video/*" : "image/*"; input.hidden = true;
    box.appendChild(input); f.onclick = () => input.click();
    input.onchange = () => { if (input.files.length) files([...input.files]); input.value = ""; };
  }
  if (k === "audio" || k === "image") dropTarget(box);
  if (k === "audio") wireMic();
  if (k === "image") {
    $$("[data-isrc]", box).forEach((b) => b.onclick = () => { imgSrc = b.dataset.isrc; if (imgSrc !== "camera") { stopCam(); } renderCapture(); });
    if (imgSrc === "camera") {
      $("#rv-cam").onclick = () => (cam ? (stopCam(), renderCapture()) : startCam());
      $("#rv-snap").onclick = snap;
      $("#rv-live").onclick = () => { live = !live; renderCapture(); if (live) liveCam(); };
      if (cam) $("#rv-video").srcObject = cam.stream;
    }
    if (imgSrc === "draw") wirePad();
  }
  if (k === "numbers") $("#rv-addn").onclick = numbers;
}
function dropTarget(el) {
  if (el.dataset.drop) return; el.dataset.drop = 1;
  el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("over"); });
  el.addEventListener("dragleave", () => el.classList.remove("over"));
  el.addEventListener("drop", (e) => { e.preventDefault(); el.classList.remove("over"); if (e.dataTransfer.files.length) files([...e.dataTransfer.files]); });
}
const fromName = (f) => {
  const rel = f.webkitRelativePath || ""; const parts = rel.split("/");
  if (parts.length > 1) return parts[parts.length - 2];
  return f.name.replace(/\.[^.]+$/, "").split(/[_\- ]/)[0];
};
function needLabel() {
  if (!label) { toast("Type a label first (the class these examples belong to)", "bad"); const li = $("#rv-label"); if (li) li.focus(); return false; }
  return true;
}
async function files(list) {
  const auto = $("#rv-fname") && $("#rv-fname").checked;
  if (mode === "train" && !auto && !needLabel()) return;
  if (mode === "test") {
    if (list.length > 1) { setBatch(list); toast(`${list.length} files are ready in “Many inputs at once”. Press Run the batch.`, "", 4000); return; }
    return testInput({ file: list[0] }, `file ${list[0].name}`);
  }
  let ok = 0;
  for (let i = 0; i < list.length; i++) {
    $("#rv-exmeta").textContent = `add ${i + 1} of ${list.length}…`;
    const fd = new FormData(); fd.append("file", list[i]); fd.append("label", auto ? fromName(list[i]) : label);
    try { await api.post("/reservoir/projects/" + P.id + "/examples", fd); ok++; } catch (e) { toast(list[i].name + ": " + e.message, "bad", 6000); }
  }
  await afterAdd(ok);
}
async function afterAdd(n) {
  await reload(); if (!label && P.classes.length) label = P.classes[0];
  if (n) toast(`Added ${n} example${n > 1 ? "s" : ""}`, "good", 1600);
  renderExamples(); if (mode === "train") { renderCapture(); }
  markStale(); refresh();
}
async function addJson(body) {
  if (!needLabel()) return false;
  try { await api.post("/reservoir/projects/" + P.id + "/examples/json", { ...body, label }); await afterAdd(1); return true; }
  catch (e) { toast(e.message, "bad", 6000); return false; }
}
async function numbers() {
  const txt = $("#rv-nums").value.trim(); if (!txt) return;
  if (mode === "test") return testInput({ json: { numbers: txt.split(/\n+/)[0] } }, `sequence ${txt.split(/\n+/)[0].slice(0, 40)}`);
  if (!needLabel()) return;
  let ok = 0;
  for (const line of txt.split(/\n+/).filter((l) => l.trim())) {
    try { await api.post("/reservoir/projects/" + P.id + "/examples/json", { numbers: line, label }); ok++; } catch (e) { toast(e.message, "bad", 6000); }
  }
  $("#rv-nums").value = ""; await afterAdd(ok);
}

// ---------------------------------------------------------------- the microphone (js/mic.js does the capture)
// Every button first calls mic.prepare() synchronously, so the AudioContext is made inside the click itself.
async function openMic() {
  if (!window.isSecureContext) { toast("The microphone needs the secure page: https://" + location.hostname + ":8493", "bad", 8000); throw new Error("insecure"); }
  try { await mic.open({ onLevel: meter, onState: micState, onClip: (x, sr) => { x.sr = sr; handleClip(x); } }); }
  catch (e) { if (e.message !== "insecure") toast("Microphone: " + (e.name === "NotAllowedError" ? "the browser did not give permission. Let this site use the microphone (the icon left of the address)." : e.message), "bad", 8000); live = false; micState(); throw e; }
  fillDevices();
}
function stopMic() { mic.close(); live = false; micState(); meter(null); }
async function fillDevices() {
  const sel = $("#rv-dev"); if (!sel) return;
  const ds = await mic.devices(), cur = mic.deviceId;
  sel.innerHTML = `<option value="">Default input${mic.isOpen && !cur ? " — " + esc(mic.label) : ""}</option>` + ds.filter((d) => d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications")
    .map((d, i) => `<option value="${esc(d.deviceId)}" ${d.deviceId === cur ? "selected" : ""}>${esc(d.label || "Input " + (i + 1))}</option>`).join("");
}
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", () => fillDevices());
function meter(v) {
  const vu = $("#rv-vu"), dbt = $("#rv-db"); if (!vu) return;
  const pos = (d) => Math.max(0, Math.min(100, (d + 60) / 60 * 100)) + "%";
  if (!v) { vu.querySelector(".lv").style.width = "0"; vu.classList.remove("hot"); if (dbt) dbt.textContent = mic.isOpen ? "—" : "mic off"; return; }
  vu.querySelector(".lv").style.width = pos(v.level);
  vu.querySelector(".fl").style.left = pos(v.floor);
  vu.querySelector(".th").style.left = pos(v.threshold);
  vu.classList.toggle("hot", v.level > v.threshold || v.mode === "rec" || v.mode === "hold");
  if (dbt) dbt.textContent = `${v.level < -99 ? "−∞" : v.level.toFixed(0)} dB`;
}
function micState() {
  const s = $("#rv-mstate"); if (!s) return;
  const m = mic.mode, test = mode === "test";
  s.textContent = !mic.isOpen ? "mic off" : m === "rec" ? "● recording" : m === "hold" ? "● recording — release to stop" : m === "armed" ? (live ? "live — speak" : "speak now") : pending ? "" : "mic open";
  s.classList.toggle("rec", m === "rec" || m === "hold");
  const lv = $("#rv-live"); if (lv) lv.textContent = live ? "■ Stop listening" : "● Live";
  const on = $("#rv-micon"); if (on) on.textContent = mic.isOpen ? "Mic off" : "Mic check";
  const d = $("#rv-mdiag"); if (d) { d.hidden = !mic.diag; d.textContent = mic.diag; }
  const sel = $("#rv-dev"); if (sel && mic.isOpen && !sel.dataset.filled) { sel.dataset.filled = 1; fillDevices(); }
  showPending();
  void test;
}
function wireMic() {
  const sens = $("#rv-sens");
  sens.oninput = () => { mic.sensitivity = +sens.value; $("#rv-sensv").textContent = `floor +${sens.value} dB`; };
  $("#rv-dev").onchange = async (e) => {
    const was = mic.mode;
    mic.prepare();
    try { await mic.open({ deviceId: e.target.value }); fillDevices(); if (live && was !== "idle") mic.arm({ continuous: true }); } catch (err) { /* reported */ }
  };
  $("#rv-micon").onclick = async () => { if (mic.isOpen) { stopMic(); return; } mic.prepare(); try { await openMic(); } catch (e) { /* reported */ } };
  $("#rv-rec").onclick = async () => {
    if (mode === "train" && !needLabel()) return;
    mic.prepare(); live = false;
    try { await openMic(); } catch (e) { return; }
    mic.arm({ continuous: false });
  };
  $("#rv-live").onclick = async () => {
    if (live) { live = false; mic.disarm(); micState(); return; }
    if (mode === "train" && !needLabel()) return;
    mic.prepare(); live = true;
    try { await openMic(); } catch (e) { return; }
    mic.arm({ continuous: true }); micState();
  };
  const hold = $("#rv-hold");
  let want = false;
  const down = async (e) => {
    if (e) e.preventDefault();
    if (want) return;
    if (mode === "train" && !needLabel()) return;
    want = true; mic.prepare();
    try { await openMic(); } catch (err) { want = false; return; }
    if (want) { mic.holdStart(); hold.classList.add("on"); }
  };
  const up = () => { if (!want) return; want = false; hold.classList.remove("on"); mic.holdEnd(); };
  hold.onpointerdown = (e) => { hold.setPointerCapture(e.pointerId); down(e); };
  hold.onpointerup = hold.onpointercancel = up;
  hold.onkeydown = (e) => { if (e.code === "Space" && !e.repeat) down(e); };
  hold.onkeyup = (e) => { if (e.code === "Space") { e.preventDefault(); up(); } };
  hold.onclick = (e) => e.preventDefault();
  if (mic.isOpen) { fillDevices(); micState(); } else meter(null);
  if (mic.diag) micState();
}
async function to16k(x, sr) {
  const n = Math.round(x.length * 16000 / sr);
  const off = new OfflineAudioContext(1, n, 16000);
  const b = off.createBuffer(1, x.length, sr); b.copyToChannel(x, 0);
  const s = off.createBufferSource(); s.buffer = b; s.connect(off.destination); s.start();
  return (await off.startRendering()).getChannelData(0);
}
function b64(f32) {
  const u8 = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength); let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
let pending = 0;
function showPending() { const s = $("#rv-mstate"); if (s && pending) s.textContent = `${pending} clip${pending > 1 ? "s" : ""} to process…`; }
async function handleClip(clip) {
  if (clip.length / (clip.sr || 48000) < 0.2) return;
  pending++; showPending();
  try { await sendClip(clip); } finally { pending--; micState(); }
}
async function sendClip(clip) {
  const pcm = b64(await to16k(clip, clip.sr || 48000));
  if (mode === "test") return testInput({ json: { pcm16k: pcm, source: "mic" } }, `recording, ${(clip.length / (clip.sr || 48000)).toFixed(1)} s`);
  return addJson({ pcm16k: pcm, source: "mic" });
}

// ---------------------------------------------------------------- the camera
async function startCam() {
  if (!window.isSecureContext) { toast("The camera needs the secure page: https://" + location.hostname + ":8493", "bad", 8000); return; }
  try { cam = { stream: await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } }) }; }
  catch (e) { toast("Camera: " + e.message, "bad", 6000); return; }
  renderCapture();
}
function stopCam() { if (cam) { cam.stream.getTracks().forEach((t) => t.stop()); cam = null; } live = false; }
function frameData() {
  const v = $("#rv-video"); if (!v || !v.videoWidth) return null;
  const c = document.createElement("canvas"); const s = Math.min(v.videoWidth, v.videoHeight);
  c.width = c.height = 128;
  c.getContext("2d").drawImage(v, (v.videoWidth - s) / 2, (v.videoHeight - s) / 2, s, s, 0, 0, 128, 128);
  return c.toDataURL("image/png");
}
async function snap() {
  const d = frameData(); if (!d) return;
  if (mode === "test") return testInput({ json: { image: d, source: "camera" } }, "camera snap");
  return addJson({ image: d, source: "camera" });
}
async function liveCam() { while (live && cam && P) { await snap(); await new Promise((r) => setTimeout(r, 900)); } }

// ---------------------------------------------------------------- the drawing pad
// Strokes are kept as points so the picture can be re-rendered at MNIST's scale: the ink's bounding box is fitted into
// 20 px (longer side), drawn with a pen of PEN px at that scale, and shifted so its centre of mass sits at (14, 14).
const PEN = 2.6;                     // stroke width in the 28 px picture; tuned so the ink covers about what MNIST's does
let strokes = [], drawT = 0, drawSeq = 0;
function wirePad() {
  const cv = $("#rv-pad"), g = cv.getContext("2d");
  let cur = null;
  const at = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * cv.width, (e.clientY - r.top) / r.height * cv.height]; };
  cv.onpointerdown = (e) => { e.preventDefault(); cv.setPointerCapture(e.pointerId); cur = [at(e)]; strokes.push(cur); clearTimeout(drawT); drawSeq++; paint(); };
  cv.onpointermove = (e) => { if (!cur) return; const p = at(e), q = cur[cur.length - 1]; if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 1.5) { cur.push(p); paint(); } };
  cv.onpointerup = cv.onpointercancel = () => { if (!cur) return; cur = null; paint(); if (mode === "test") { clearTimeout(drawT); drawT = setTimeout(classifyDrawn, autoRun ? 300 : 0); } };
  $("#rv-undo").onclick = () => { strokes.pop(); paint(); if (mode === "test" && strokes.length) { clearTimeout(drawT); drawT = setTimeout(classifyDrawn, autoRun ? 300 : 0); } };
  $("#rv-clear").onclick = () => { strokes = []; paint(); };
  const add = $("#rv-addd");
  if (add) add.onclick = async () => { const n = normalise(); if (!n) { toast("Draw something first", "bad"); return; } if (await addJson({ image: n, source: "draw" })) { strokes = []; paint(); } };
  function paint() {
    g.fillStyle = "#000"; g.fillRect(0, 0, cv.width, cv.height);
    g.strokeStyle = g.fillStyle = "#fff"; g.lineWidth = 20; g.lineCap = g.lineJoin = "round";
    for (const s of strokes) {
      if (s.length === 1) { g.beginPath(); g.arc(s[0][0], s[0][1], 10, 0, 7); g.fill(); continue; }
      g.beginPath(); g.moveTo(...s[0]); for (const p of s.slice(1)) g.lineTo(...p); g.stroke();
    }
    normalise(true);
  }
  paint();
}
// -> PNG data URL of the 28 x 28 white-on-black picture, or null when there is no ink; also draws it into #rv-norm
function normalise(previewOnly) {
  const out = $("#rv-norm");
  const pts = strokes.flat();
  if (!pts.length) { if (out) out.getContext("2d").clearRect(0, 0, 28, 28); return null; }
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const R = 4, N = 28 * R, s = (20 - PEN) / Math.max(x1 - x0, y1 - y0, 1e-6) * R;
  const draw = (dx, dy) => {
    const c = document.createElement("canvas"); c.width = c.height = N;
    const g = c.getContext("2d"); g.fillStyle = "#000"; g.fillRect(0, 0, N, N);
    g.strokeStyle = g.fillStyle = "#fff"; g.lineWidth = PEN * R; g.lineCap = g.lineJoin = "round";
    const T = (p) => [(p[0] - (x0 + x1) / 2) * s + N / 2 + dx, (p[1] - (y0 + y1) / 2) * s + N / 2 + dy];
    for (const st of strokes) {
      if (st.length === 1) { const [a, b] = T(st[0]); g.beginPath(); g.arc(a, b, PEN * R / 2, 0, 7); g.fill(); continue; }
      g.beginPath(); g.moveTo(...T(st[0])); for (const p of st.slice(1)) g.lineTo(...T(p)); g.stroke();
    }
    return c;
  };
  let hi = draw(0, 0);
  const d = hi.getContext("2d").getImageData(0, 0, N, N).data;
  let m = 0, mx = 0, my = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const v = d[(y * N + x) * 4]; m += v; mx += v * x; my += v * y; }
  if (m > 0) hi = draw(N / 2 - mx / m, N / 2 - my / m);
  const c = document.createElement("canvas"); c.width = c.height = 28;
  const g = c.getContext("2d"); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high"; g.drawImage(hi, 0, 0, 28, 28);
  if (out) { const o = out.getContext("2d"); o.clearRect(0, 0, 28, 28); o.drawImage(c, 0, 0); }
  return previewOnly ? null : c.toDataURL("image/png");
}
function classifyDrawn() {
  const img = normalise(); if (!img || mode !== "test") return;
  const my = ++drawSeq;
  return testInput({ json: { image: img, source: "draw" } }, "your drawing", () => my === drawSeq);
}

// ---------------------------------------------------------------- examples, training, results
function renderExamples() {
  const box = $("#rv-ex"), ex = P.examples || [];
  $("#rv-exmeta").textContent = ex.length ? `${ex.length} examples · ${P.classes.length} labels` : "";
  if (!ex.length) { box.innerHTML = `<div class="empty">No examples yet. ${P.kind === "audio" ? "Type a label, press <b>Record one</b> and say it — or turn on <b>Live</b> and say it several times." : P.kind === "image" ? "Type a label, then use the camera or drop image files here." : "Type a label and paste sequences, one per line."}</div>`; return; }
  const by = {}; ex.forEach((e) => (by[e.label] = by[e.label] || []).push(e));
  box.innerHTML = Object.keys(by).sort().map((l) => `<div class="rv-grp"><div class="sec-t">${esc(l)} <span class="x">${by[l].length}</span></div><div class="rv-chips">
    ${by[l].map((e) => `<div class="rv-chip ${sel === e.id ? "on" : ""}" data-e="${e.id}" title="${esc(e.source || "")} · ${e.steps} steps">
      ${e.ext === "png" ? `<img src="/api/reservoir/projects/${P.id}/examples/${e.id}/file" loading="lazy">` : e.ext === "wav" ? `<span class="rv-play" data-play="${e.id}">${icon("play")}</span>` : `<span class="mono">${e.steps}</span>`}
      <span class="rv-x" data-x="${e.id}" title="Delete">${icon("x")}</span></div>`).join("")}</div></div>`).join("");
  $$("#rv-ex [data-e]").forEach((c) => c.onclick = (ev) => {
    if (ev.target.closest("[data-x]")) return del(c.dataset.e);
    if (ev.target.closest("[data-play]")) { new Audio(`/api/reservoir/projects/${P.id}/examples/${c.dataset.e}/file`).play(); }
    peek(c.dataset.e);
  });
}
async function del(eid) {
  await api.del(`/reservoir/projects/${P.id}/examples/${eid}`);
  if (sel === eid) sel = null;
  await reload(); renderExamples(); if (mode === "train") renderCapture(); markStale(); refresh();
}
async function peek(eid) {
  sel = eid; $$("#rv-ex [data-e]").forEach((c) => c.classList.toggle("on", c.dataset.e === eid));
  const e = (P.examples || []).find((x) => x.id === eid); if (!e) return;
  $("#rv-wmeta").textContent = `${e.label} · ${e.steps} steps`;
  $("#rv-waves").classList.add("is-busy");
  try { const r = await api.get(`/reservoir/projects/${P.id}/examples/${eid}/peek`); wavesPanel(r, e.label); }
  catch (err) { $("#rv-waves").innerHTML = `<div class="hint">${esc(err.message)}</div>`; }
  $("#rv-waves").classList.remove("is-busy");
}
function wavesPanel(r, title) {
  const ripple = P.reservoir.type === "ripple";
  if (r.encoder === "clip") {
    $("#rv-waves").innerHTML = `<div class="sec-t">the picture you tested</div><img class="rv-img" src="${r.input}" style="height:auto">
      <div class="hint">Read by CLIP (512 numbers), then the one trained layer. Closest training examples: ${r.nearest.map((n) => `<b>${esc(n.label)}</b> ${Math.round(n.sim * 100)}%`).join(", ")}.</div>`;
    return;
  }
  $("#rv-waves").innerHTML = `
    <div class="sec-t">1 · the input, as the reservoir hears it</div>
    <img class="rv-img" src="${r.input}" title="${P.kind === "audio" ? "log-mel spectrogram: 32 frequency bands (rows) × 10 ms frames" : P.kind === "image" ? "the picture scanned as 32 rows then 32 columns: one step per row/column" : "the sequence and its changes"}">
    <div class="hint">${P.kind === "audio" ? "32 frequency bands × time, 10 ms per step" : P.kind === "image" ? "scanned row by row, then column by column: 64 steps" : "value and change, one step per number"}</div>
    <div class="sec-t">2 · ${ripple ? "the water surface while it rings" : "every unit's activity over time"}</div>
    ${r.waves ? `<img class="rv-img" src="${r.waves}">` : ""}
    <div class="hint">${ripple ? "six photographs of the 64×64 tank, from start to end (red = up, blue = down)" : "rows = units, columns = time steps (red = positive, blue = negative)"}</div>
    <div class="sec-t">3 · what the decision layer reads</div>
    <img class="rv-img rv-fp" src="${r.fingerprint}">
    <div class="hint">${P.reservoir.snapshots} snapshots, each the average over one slice of the input. These small grids are all the trained layer sees.</div>`;
}
async function train() {
  if (!P || !lf || lf.busy("train")) return;
  if (P.task !== "forecast" && (P.classes || []).length < 2) { toast("Collect examples of at least two labels first.", "bad"); lf.go("train"); return; }
  const r = await lf.run("train", async ({ signal, progress }) => {
    const { job } = await api.post(`/reservoir/projects/${P.id}/train/job`, {}, { signal });
    return watchJob({ id: job, state: "running" }, (j) => progress(j.progress, j.message), { signal });
  }, { label: "Train on the card" });
  if (!r) { flowState(); return; }
  await reload(); stale = false; refresh();
  if (P.task === "forecast") { showForecast(r); lf.go("evaluate"); return; }
  renderTrained(r); flowState(); lf.go("evaluate");
}
const pct = (v) => (v * 100).toFixed(v >= 0.995 || v < 0.1 ? 0 : 1) + "%";
function renderTrained(r) {
  r = r || P.trained;
  const box = $("#rv-result"); if (!box) return;
  if (!r) { box.innerHTML = `<div class="empty">Nothing to evaluate yet. In step 1, collect examples of at least two labels, then press Train.</div>`; $("#rv-rmeta2").textContent = ""; return; }
  $("#rv-rmeta2").textContent = `${r.n} examples · ${r.features.toLocaleString()} features · ${fmt.ms(r.ms)}`;
  if (!r.cv) { box.innerHTML = scoreCard({ value: r.train_acc, label: "on its own training examples: this is not a real test", good: false,
    note: "Add at least 2 examples for each label (5 or more is better). Then train again to get an honest score on examples that the training did not see." }); return; }
  const resAcc = r.res ? r.res : r.cv, gain = resAcc.acc - r.raw.acc, isClip = r.encoder === "clip";
  const clipBar = r.clip ? `<div class="rv-bar" title="CLIP ViT-B/32 features (pretrained on 400M captioned images) + the same one layer"><span>CLIP features (pretrained)</span><i style="--w:${r.clip.acc * 100}%" class="${isClip ? "red" : ""}"></i><b>${pct(r.clip.acc)}</b></div>` : "";
  const clipHint = r.clip ? (isClip ? " The project uses CLIP features." : r.clip.acc > resAcc.acc + 0.02 ? ` CLIP features would do better here (${pct(r.clip.acc)}) — switch “What the layer reads” to CLIP.` : "") : "";
  const beats = r.cv.acc > Math.max(r.chance, r.raw.acc) + 0.01;
  box.innerHTML = scoreCard({ value: r.cv.acc, good: r.cv.acc > r.chance + 0.05 && r.p_value < 0.05,
      label: `correct on examples that it did not train on (${r.folds}-fold cross-validation${isClip ? ", CLIP features" : ""})`,
      bars: [{ t: "with the reservoir", v: resAcc.acc, kind: isClip ? "base" : "model" },
        { t: "same layer on the raw input", v: r.raw.acc, kind: "base", tip: "the simple baseline: the same one layer, without the reservoir" },
        ...(r.clip ? [{ t: "CLIP features (pretrained)", v: r.clip.acc, kind: isClip ? "model" : "base" }] : []),
        { t: "chance (always guess the biggest label)", v: r.chance, kind: "chance" }],
      verdict: beats ? "Better than chance and better than the simple baseline." : r.cv.acc > r.chance + 0.05 ? "Better than chance, but not better than the simple baseline." : "Not better than chance: add examples or change the settings.",
      note: (gain > 0.01 ? `The reservoir adds ${(gain * 100).toFixed(1)} points to the result from the raw input.` : gain < -0.01 ? `Here the reservoir makes the result <b>worse</b> by ${(-gain * 100).toFixed(1)} points. Try a different leak, echo or snapshots, or add more examples.` : "On this data, the reservoir adds little to the raw input.")
        + (r.p_value < 0.001 ? " Far beyond what luck would give." : r.p_value < 0.05 ? " Unlikely to be luck (p = " + r.p_value.toFixed(3) + ")." : " Could still be luck: add examples.") + clipHint }) + `
    <div class="rv-cols"><div><div class="sec-t">Confusion (rows = truth, columns = guess)</div><canvas id="rv-conf"></canvas></div>
      <div><div class="sec-t">Average snapshots per label</div><div class="rv-fps">${r.classes.map((c) => `<div><span>${esc(c)}</span><img src="${r.fingerprints[c]}"></div>`).join("")}</div>
      ${r.weights ? `<div class="sec-t" style="margin-top:10px">What the layer learned to look for</div><div class="rv-fps">${r.classes.map((c) => `<div><span>${esc(c)}</span><img src="${r.weights[c]}"></div>`).join("")}</div>` : ""}</div></div>`;
  requestAnimationFrame(() => heatmap($("#rv-conf"), { matrix: r.cv.confusion, labels: r.classes, h: Math.min(300, 96 + r.classes.length * 20) }));
}
// An input in Infer is staged first; Run (or "run on each new input", or Live) sends it to the card.
function testInput(inp, desc, current) {
  lastInput = inp; staged = desc;
  const st = $("#rv-staged");
  if (st) { st.hidden = false; st.innerHTML = `${icon("eye")} <span>Ready: <b>${esc(desc)}</b></span>`; }
  const rb = $("#rv-run"); if (rb) rb.disabled = !P.trained;
  if (live || autoRun) return runStaged(current);
}
async function runStaged(current) {
  if (!lastInput) { toast("Give an input first: record, snap, draw, type numbers or drop a file.", "bad"); return; }
  if (!P.trained) { toast("Press Train first.", "bad"); lf.go("train"); return; }
  const inp = lastInput, pid = P.id;
  const send = (o) => inp.file ? (() => { const fd = new FormData(); fd.append("file", inp.file); return api.post(`/reservoir/projects/${pid}/test`, fd, o); })()
    : api.post(`/reservoir/projects/${pid}/test/json`, inp.json, o);
  let r;
  if (live || lf.busy("infer")) {                  // live inputs arrive quickly: no Stop bar, the newest result wins
    $("#rv-iout").classList.add("is-busy");
    try { r = await send(); } catch (e) { toast(e.message, "bad", 6000); }
    $("#rv-iout").classList.remove("is-busy");
  } else r = await lf.run("infer", ({ signal }) => send({ signal }), { label: "Classify on the card" });
  if (r && (!current || current()) && P && P.id === pid) { lastTest = r; showTest(r); $("#rv-iout").scrollIntoView({ block: "nearest", behavior: "smooth" }); }
}
function showTest(r) {
  const out = $("#rv-iout"); if (!out) return;
  const sc = Object.entries(r.scores).sort((a, b) => b[1] - a[1]);
  const mx = Math.max(...sc.map((s) => Math.max(0, s[1])), 1e-6);
  const sure = r.margin > 0.35 ? "confident" : r.margin > 0.12 ? "fairly sure" : "unsure — close to another label";
  out.innerHTML = `<div class="rv-scores"><div class="rv-big rv-pred"><b>${esc(r.label)}</b><span>${sure} · ${r.steps} steps · ${fmt.ms(r.ms)}</span></div>
    <div class="rv-cmp">${sc.slice(0, 8).map(([c, v], i) => `<div class="rv-bar"><span>${esc(c)}</span><i style="--w:${Math.max(0, v) / mx * 100}%" class="${i ? "" : "red"}"></i><b>${v.toFixed(2)}</b></div>`).join("")}
      <div class="hint">Scores from the one trained layer (1 = looks exactly like that label's training examples, 0 = not at all).
        Closest training examples: ${r.nearest.map((n) => `<b>${esc(n.label)}</b>`).join(", ")}.</div></div></div>
    <div class="rv-row rv-fix"><span class="hint">Teach it — keep this input as a training example labelled</span>${(P.classes || []).map((c) => `<button class="tok" data-fix="${esc(c)}">${esc(c)}</button>`).join("")}</div>`;
  wavesPanel(r, r.label);
  $("#rv-wmeta").textContent = "the input you just tested";
  $$("#rv-iout [data-fix]").forEach((b) => b.onclick = () => teach(b.dataset.fix, b));
}

function renderBatch() {
  const el = $("#rv-batch"); if (!el || !P) return;
  const k = P.kind;
  if (k === "numbers") batchBox(el, { placeholder: "one sequence on each line, for example\n1 2 3 5 8 13\n9 7 4 2 1 1", onText: (t) => setBatch(t) });
  else batchBox(el, { accept: k === "audio" ? "audio/*,video/*" : "image/*", filesHint: `Drop ${k === "audio" ? "audio" : "image"} files here (up to 5,000), or click to choose`, onFiles: (fs) => setBatch(fs) });
  setBatch(batch);
}
function setBatch(b) {
  batch = b && (typeof b === "string" ? (b.trim() ? b : null) : b.length ? b : null);
  const n = !batch ? 0 : typeof batch === "string" ? batch.split(/\n+/).filter((x) => x.trim()).length : batch.length;
  const rb = $("#rv-runb"); if (!rb) return;
  rb.disabled = !n || !P.trained;
  rb.innerHTML = `${icon("play")} ${n ? `Run on ${n.toLocaleString()} input${n > 1 ? "s" : ""}` : "Run the batch"}`;
  const d = $("#rv-batch .lf-drop span"); if (d && n && typeof batch !== "string") d.textContent = `${n} file${n > 1 ? "s" : ""} ready: ${batch.slice(0, 3).map((f) => f.name).join(", ")}${n > 3 ? " …" : ""}`;
}
async function runBatch() {
  if (!batch || !P.trained) return;
  const pid = P.id, name = P.name;
  const r = await lf.run("infer", async ({ signal, progress }) => {
    let body;
    if (typeof batch === "string") body = { numbers: batch };
    else { body = new FormData(); batch.forEach((f) => body.append("files", f, f.name)); progress(0, `send ${batch.length} files`); }
    const { job } = await api.post(`/reservoir/projects/${pid}/infer`, body, { signal, timeout: 600000 });
    return watchJob({ id: job, state: "running" }, (j) => progress(j.progress, j.message), { signal });
  }, { label: "Classify the batch on the card" });
  if (!r || !P || P.id !== pid) return;
  const cls = r.classes || [];
  const rows = r.rows.map((x) => ({ ...x, sure: x.margin == null ? "" : x.margin > 0.35 ? "confident" : x.margin > 0.12 ? "fairly sure" : "unsure", _cls: x.error ? "bad" : "" }));
  const cols = [{ t: "input", k: "input" }, { t: "call", k: "label", html: (x) => x.error ? `<span title="${esc(x.error)}">failed: ${esc(x.error.slice(0, 60))}</span>` : `<b>${esc(x.label)}</b>`, csv: (x) => x.error ? "" : x.label },
    { t: "margin", k: "margin", num: true }, { t: "how sure", k: "sure" },
    ...cls.slice(0, 12).map((c) => ({ t: c, num: true, k: "s_" + c, html: (x) => x.scores ? x.scores[c].toFixed(2) : "", csv: (x) => x.scores ? x.scores[c] : "" }))];
  const counts = {}; rows.forEach((x) => { if (x.label) counts[x.label] = (counts[x.label] || 0) + 1; });
  resultsTable($("#rv-bout"), { columns: cols, rows, name: `${name} — predictions`,
    note: `${fmt.ms(r.ms)} · ${Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l, n]) => `${esc(l)} ${n}`).join(", ")}${r.failed ? ` · ${r.failed} failed` : ""}` });
  $("#rv-bout").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// a test result was wrong (or right and worth keeping): store that exact input as a training example
async function teach(lab, btn) {
  if (!lastInput) return;
  btn.disabled = true;
  try {
    if (lastInput.file) { const fd = new FormData(); fd.append("file", lastInput.file); fd.append("label", lab); await api.post("/reservoir/projects/" + P.id + "/examples", fd); }
    else await api.post("/reservoir/projects/" + P.id + "/examples/json", { ...lastInput.json, label: lab });
    await reload(); renderExamples(); markStale(); refresh();
    btn.classList.add("on"); toast(`Added as “${lab}”. Train again (step 1) to learn from it.`, "good", 3500);
  } catch (e) { toast(e.message, "bad"); btn.disabled = false; }
}

// ---------------------------------------------------------------- forecast projects (centre)
function renderForecast() {
  const f = P.forecast, s = P.series;
  $("#rv-mid").innerHTML = `<section class="pane grow rv-flow"><div class="pane-b flush" id="rv-lf"></div></section>`;
  lf = learnFlow($("#rv-lf"), { key: "rvf", start: P.trained ? "evaluate" : "train", onStep: setMode,
    steps: { train: { hint: "The series and the question" }, evaluate: { hint: "Score on the span it never saw" }, infer: { hint: "The call from the latest data" } } });
  lf.body("train").innerHTML = `
    <div class="lf-sec"><div class="sec-t">The series <span class="x">${s ? `${s.n.toLocaleString()} points · ${esc(s.channels.join(", "))}${s.first ? ` · ${esc(s.first)} → ${esc(s.last)}` : ""}` : "none loaded"}</span></div>
      <div><div class="rv-row">
        <input class="in sm" id="rv-tk" placeholder="ticker, for example SPY, AAPL, BTC-USD" style="width:190px"><select class="sel sm" id="rv-yr"><option>2</option><option>5</option><option selected>10</option><option>20</option></select><span class="hint">years</span>
        <label class="hint"><input type="checkbox" id="rv-vol"> volume as an extra input</label><button class="btn sm" id="rv-fetch">Fetch</button>
        <span class="sp"></span><select class="sel sm" id="rv-tbl"><option value="">Data Desk table…</option></select></div>
        <div class="rv-row" id="rv-tblcols" hidden></div>
        <details class="rv-paste"><summary class="hint">or paste numbers</summary><textarea class="in" id="rv-pv" rows="3" placeholder="one value per line or separated by spaces, oldest first"></textarea><button class="btn ghost sm" id="rv-pset">Use these</button></details>
        <div class="chartbox rv-chart"><canvas id="rv-sc"></canvas></div></div></div>
    <div class="lf-sec"><div class="sec-t">Question</div>
      <div><div class="fields rv-q">
        <div class="fld"><label>Horizon</label><input type="range" data-f="horizon" min="1" max="60" value="${f.horizon}"><span class="v" data-fv="horizon">${f.horizon}</span></div>
        <div class="fld"><label>Recent moves</label><input type="range" data-f="lags" min="1" max="40" value="${f.lags}"><span class="v" data-fv="lags">${f.lags}</span></div>
        <div class="fld"><label>Train on first</label><input type="range" data-f="train_frac" min="0.4" max="0.9" step="0.05" value="${f.train_frac}"><span class="v" data-fv="train_frac">${Math.round(f.train_frac * 100)}%</span></div></div>
        <div class="hint" id="rv-qtext"></div></div></div>`;
  lf.actions("train", `<button class="btn" id="rv-train" data-primary ${s ? "" : "disabled"}>${icon("bolt")} Train & test</button><span class="hint">${s ? "learns on the first part, scores on the rest" : "load a series first"}</span>`);
  lf.body("evaluate").innerHTML = `<div class="hint rv-evmeta" id="rv-rmeta2"></div><div id="rv-result"></div>`;
  lf.actions("evaluate", `<button class="btn ghost" id="rv-retrain">${icon("bolt")} Train again</button><button class="btn" id="rv-toinfer">See the call ${icon("play")}</button>`);
  lf.body("infer").innerHTML = `<div id="rv-next"></div><div id="rv-calls"></div>`;
  lf.actions("infer", `<button class="btn" id="rv-rerun" data-primary ${s ? "" : "disabled"}>${icon("play")} Run on the latest data</button><span class="hint">trains again on the series as it is now, then makes the call</span>`);
  $("#rv-retrain").onclick = () => { lf.go("train"); train(); };
  $("#rv-toinfer").onclick = () => lf.go("infer");
  $("#rv-rerun").onclick = train;
  lf.state("train", P.trained ? "done" : s ? "ready" : "todo", P.trained ? P.trained.summary.split(" vs ")[0] : s ? "ready to train" : "load a series");
  lf.state("evaluate", P.trained ? "done" : "off", P.trained ? P.trained.verdict.split(",")[0] : "train first");
  lf.state("infer", P.trained ? "ready" : "off", P.trained ? `next call: ${P.trained.next.call}` : "train first");
  const q = () => { const ff = P.forecast; $("#rv-qtext").innerHTML = `Will the value be <b>higher or lower ${ff.horizon} period${ff.horizon > 1 ? "s" : ""} from now</b>? The reservoir hears every move in order; the layer also sees the last ${ff.lags} moves.
    It learns on the first ${Math.round(ff.train_frac * 100)}% of the history. The Lab scores it only on the rest, which it never saw. This is how you must use a forecast in real life.`; };
  q();
  $$("#rv-mid [data-f]").forEach((i) => {
    i.oninput = () => { $(`[data-fv="${i.dataset.f}"]`).textContent = i.dataset.f === "train_frac" ? Math.round(i.value * 100) + "%" : i.value; };
    i.onchange = async () => { const body = { forecast: {} }; $$("#rv-mid [data-f]").forEach((x) => { body.forecast[x.dataset.f] = +x.value; }); P = await api.raw("PATCH", "/reservoir/projects/" + P.id, body).then((r) => r.json()); q(); if (P.trained) lf.state("train", "stale", "question changed: train again"); };
  });
  $("#rv-fetch").onclick = async () => {
    const t = $("#rv-tk").value.trim(); if (!t) return;
    await setSeries({ ticker: t, years: +$("#rv-yr").value, with_volume: $("#rv-vol").checked });
  };
  $("#rv-pset").onclick = () => setSeries({ numbers: $("#rv-pv").value });
  $("#rv-train").onclick = train;
  api.get("/tables").then((ts) => {
    $("#rv-tbl").innerHTML = `<option value="">Data Desk table…</option>` + ts.map((t) => `<option value="${t.id}">${esc(t.name)} (${(t.rows || 0).toLocaleString()} rows)</option>`).join("");
    $("#rv-tbl").onchange = async () => {
      const id = $("#rv-tbl").value, box = $("#rv-tblcols"); if (!id) { box.hidden = true; return; }
      const sm = await api.get(`/tables/${id}/summary`); const nums = sm.numeric.map((c) => c.name);
      box.hidden = false;
      box.innerHTML = `<span class="hint">predict</span><select class="sel sm" id="rv-tgt">${nums.map((n) => `<option>${esc(n)}</option>`).join("")}</select>
        <span class="hint">also listen to</span>${nums.map((n) => `<label class="hint"><input type="checkbox" data-in="${esc(n)}"> ${esc(n)}</label>`).join("")}<button class="btn sm" id="rv-tuse">Use</button>`;
      $("#rv-tuse").onclick = () => setSeries({ table: id, target: $("#rv-tgt").value, inputs: $$("#rv-tblcols [data-in]").filter((c) => c.checked).map((c) => c.dataset.in) });
    };
  }).catch(() => {});
  drawSeries();
  if (P.trained) showForecast(P.trained);
  else {
    $("#rv-result").innerHTML = `<div class="empty">${s ? "Nothing to evaluate yet. Press Train & test in step 1." : "Load a series in step 1: fetch a ticker, pick a Data Desk column, or paste numbers."}</div>`;
    $("#rv-next").innerHTML = `<div class="empty">Train first. Then this step makes the call for the next periods from the latest data.</div>`;
  }
}
async function setSeries(body) {
  try { P = await api.post(`/reservoir/projects/${P.id}/series`, body); toast(`Loaded ${P.series.n.toLocaleString()} points`, "good"); renderForecast(); refresh(); }
  catch (e) { toast(e.message, "bad", 7000); }
}
let seriesCache = null;
async function drawSeries(r) {
  if (!P.series) return;
  if (!seriesCache || seriesCache.id !== P.id || seriesCache.n !== P.series.n) { const s = await api.get(`/reservoir/projects/${P.id}/series`); seriesCache = { id: P.id, n: P.series.n, ...s }; }
  const c = $("#rv-sc"); if (!c) return;
  const dpr = devicePixelRatio || 1, w = c.parentElement.clientWidth, h = c.parentElement.clientHeight || 150;
  c.width = w * dpr; c.height = h * dpr; c.style.height = h + "px";
  const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const v = seriesCache.values, n = P.series.n, step = seriesCache.step;
  let lo = Infinity, hi = -Infinity; v.forEach((x) => { lo = Math.min(lo, x); hi = Math.max(hi, x); });
  const X = (i) => 6 + i / (n - 1) * (w - 12), Y = (y) => h - 6 - (y - lo) / (hi - lo || 1) * (h - 12);
  if (r) {                                           // the unseen test span, and every call it made there
    const cut = r.chart.cut;
    g.fillStyle = "rgba(63,169,245,.07)"; g.fillRect(X(cut), 0, w - X(cut), h);
    g.fillStyle = "#8a8b93"; g.font = "10px 'JetBrains Mono'"; g.fillText("trained on this", 10, 12); g.fillText("tested on this (never seen)", X(cut) + 6, 12);
    for (const [t, p, a] of r.chart.calls) { g.fillStyle = p === a ? "rgba(47,211,138,.55)" : "rgba(255,59,48,.55)"; g.fillRect(X(t) - 1, p ? h - 10 : h - 5, 2, 4); }
  }
  g.strokeStyle = "#ff2a1a"; g.lineWidth = 1.4; g.beginPath();
  v.forEach((y, i) => { const x = X(i * step); if (i) g.lineTo(x, Y(y)); else g.moveTo(x, Y(y)); }); g.stroke();
}
function showForecast(r) {
  $("#rv-rmeta2").textContent = `${r.train_points.toLocaleString()} training · ${r.test_points.toLocaleString()} test points · ${fmt.ms(r.ms)}`;
  const best = Math.max(r.baselines.always_majority, r.baselines.persistence);
  const edge = r.reservoir.acc - best;
  const row = (l, v, cls, tip) => `<div class="rv-bar" title="${esc(tip || "")}"><span>${l}</span><i style="--w:${v * 100}%" class="${cls || ""}"></i><b>${pct(v)}</b></div>`;
  $("#rv-result").innerHTML = `<div class="rv-scores">
      <div class="rv-big ${edge > 0.01 && r.p_value_independent < 0.05 ? "" : "rv-meh"}"><b>${pct(r.reservoir.acc)}</b><span>right about up/down ${r.horizon} ahead,<br>on ${r.test_points.toLocaleString()} periods it never saw</span></div>
      <div class="rv-cmp">
        ${row("reservoir + recent moves", r.reservoir.acc, "red")}
        ${row(`recent moves only (${r.lags})`, r.raw.acc)}
        ${row(`always “${r.up_rate_test >= 0.5 ? "up" : "down"}”`, r.baselines.always_majority, "dim", "the test period went up this often — the bar to beat")}
        ${row("“same as the last move”", r.baselines.persistence, "dim")}
        <div class="rv-verdict ${edge > 0.01 && r.p_value_independent < 0.05 ? "good" : "bad"}">${esc(r.verdict)}</div>
        <div class="hint">Questions for ${r.horizon} periods that are next to each other overlap. Thus there are really about ${r.independent_tests} independent tests. The chance of this score by luck is ${r.p_value_independent < 0.001 ? "below 0.1%" : (r.p_value_independent * 100).toFixed(1) + "%"}.</div>
      </div></div>
    <div class="hint">In the chart in step 1, blue is the test period. The ticks along the bottom are its calls there (green = correct, red = wrong, upper row = up).</div>`;
  const good = edge > 0.01 && r.p_value_independent < 0.05;
  $("#rv-next").innerHTML = `<div class="lf-score"><div class="lf-big ${good ? "" : "meh"}"><b>${r.next.call.toUpperCase()}</b><span>the call for the next ${r.horizon} period${r.horizon > 1 ? "s" : ""}, from the latest data (score ${r.next.score.toFixed(3)})</span></div>
    <div class="lf-bars"><div class="lf-verdict ${good ? "good" : "bad"}">${good ? "In the test it beat the simple rules, and luck is an unlikely explanation." : "In the test it showed no reliable edge over the simple rules. Do not use this call for decisions."}</div>
    <div class="hint">Test score ${pct(r.reservoir.acc)} vs the best simple rule ${pct(best)}.</div></div></div>`;
  const rows = (r.chart.calls || []).map(([t, p, a]) => ({ period: t + 1, call: p ? "up" : "down", actual: a ? "up" : "down", right: p === a ? "yes" : "no", _cls: p === a ? "" : "bad" }));
  if (rows.length) resultsTable($("#rv-calls"), { columns: [{ t: "period", k: "period", num: true }, { t: "call", k: "call" }, { t: "what happened", k: "actual" }, { t: "right", k: "right" }],
    rows, name: `${P.name} — calls on the test span`, note: "the calls on the span it never saw" + (rows.length < r.test_points ? ` (every ${Math.round(r.test_points / rows.length)}th period)` : "") });
  drawSeries(r);
}
