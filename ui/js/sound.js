import { $, $$, api, dropZone, esc, fmt, go, icon, toast, watchJob } from "./core.js";
import { PALETTE } from "./charts.js";
import { menu } from "./hub.js";
import { learnFlow, scoreCard } from "./learnflow.js";
import { CMAPS, SCALES, fAt, kSteps, liveAt, readSteps, specAudio, specImage, uOf } from "./sound-dsp.js";

// Sound Lab: a single-track editor, edited IN PLACE (every Apply writes a new version; Undo/Redo walk the stack; the
// original never changes). What it takes from the best-loved editors (see the RC research notes):
//  - an effect RACK: a chain of effects with power buttons, order and presets, heard before it is applied. The
//    preview is the card's own result on the loop window (selection, or 10 s from the playhead), so what you hear
//    is what Apply writes; A/B (B) switches gaplessly to the dry signal, optionally matched in loudness.
//  - a spectrogram drawn from the samples at every zoom (log / mel / linear, colour maps, floor), with box
//    selection in time and frequency (Alt-drag or the Box tool) and one-click band edits.
//  - EBU R128 loudness: integrated, momentary/short-term maxima, range, true peak; live during playback; targets.
//  - markers and labelled regions (M, Ctrl+B) that export as an Audacity label file.
//  - the sound finder: mark a few examples, find every occurrence, each with its evidence against background and
//    the check against chance (the same marks moved to random places).

const GROUPS = [["Level", ["gain", "normalize", "loudness", "fade"]], ["EQ & filter", ["eq", "lowpass", "highpass", "band", "telephone"]],
  ["Space", ["reverb", "echo"]], ["Time & pitch", ["pitch", "tempo", "speed", "reverse"]], ["Repair", ["denoise", "vocals"]],
  ["Character", ["crush"]]];
const SHORT = { gain: "Volume", normalize: "Normalize", loudness: "Loudness", fade: "Fade in/out", eq: "Equalizer", lowpass: "Low-pass", highpass: "High-pass",
  band: "Band gain", telephone: "Telephone", reverb: "Reverb", echo: "Echo", pitch: "Pitch", tempo: "Tempo", speed: "Tape speed", reverse: "Reverse",
  denoise: "De-noise", vocals: "Karaoke", crush: "Bit-crush" };
const PRESETS = [
  { name: "Voice clean-up", sub: "rumble out, hiss down, clearer, podcast level", chain: [{ id: "highpass", params: { hz: 80 } }, { id: "denoise", params: { amount: 0.45 } }, { id: "eq", params: { bass: -2, mid: 1, treble: 3 } }, { id: "loudness", params: { target: -16, ceiling: -1 } }] },
  { name: "Podcast level", sub: "-16 LUFS, peaks under -1 dBTP", chain: [{ id: "loudness", params: { target: -16, ceiling: -1 } }] },
  { name: "Streaming master", sub: "-14 LUFS, peaks under -1 dBTP", chain: [{ id: "loudness", params: { target: -14, ceiling: -1 } }] },
  { name: "Broadcast (EBU R128)", sub: "-23 LUFS, peaks under -1 dBTP", chain: [{ id: "loudness", params: { target: -23, ceiling: -1 } }] },
  { name: "Remove hum and rumble", sub: "high-pass 70 Hz", chain: [{ id: "highpass", params: { hz: 70 } }] },
  { name: "Old radio", sub: "telephone band, 8-bit grit", chain: [{ id: "telephone", params: {} }, { id: "crush", params: { bits: 8 } }] },
  { name: "Concert hall", sub: "a large room, a third wet", chain: [{ id: "reverb", params: { size: 2.6, mix: 0.33 } }] },
];
const HZ = new Set(["hz", "lo", "hi"]);
const SVG = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const I = {
  loop: SVG('<path d="M17 3l3 3-3 3"/><path d="M4 12v-2a4 4 0 0 1 4-4h12"/><path d="M7 21l-3-3 3-3"/><path d="M20 12v2a4 4 0 0 1-4 4H4"/>'),
  zsel: SVG('<path d="M4 4v16M20 4v16"/><path d="M8 12h8M10.5 9.5 8 12l2.5 2.5M13.5 9.5 16 12l-2.5 2.5"/>'),
  power: SVG('<path d="M12 3v8"/><path d="M6.6 6.6a8 8 0 1 0 10.8 0"/>'),
  upk: SVG('<path d="m7 14 5-5 5 5"/>'), dnk: SVG('<path d="m7 10 5 5 5-5"/>'),
  flag: SVG('<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>'),
  box: SVG('<rect x="4" y="6" width="16" height="12" rx="1" stroke-dasharray="3 2"/>'),
  gear: SVG('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>'),
  keys: SVG('<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h1M10 10h1M14 10h1M18 10h0M7 14h10"/>'),
  ok: SVG('<path d="m5 12 4.5 4.5L19 7"/>'), copy: SVG('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
  ear: SVG('<path d="M6 10a6 6 0 1 1 12 0c0 3-2.5 4-3.5 6S13 21 10.5 21 7 19 7 17"/><path d="M10 10a2 2 0 1 1 4 0c0 1.2-1 1.6-1.4 2.4"/>'),
};
const LS = { get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private window */ } } };

const S = { clips: [], cur: null, fx: {}, view: null, pcm: null, t0: 0, span: 1, sel: null, fsel: null, head: 0, hover: null, drag: null,
  mode: LS.get("vf.sound.mode", "wave"), tool: "time", loop: false, busy: false, batching: false, picks: new Set(), last: "", err: "",
  playEnd: null, playFrom: 0, tab: "fx", marks: [], found: null, flabel: "", thr: 0.5, finding: false, markers: [], hear: "out",
  spec: LS.get("vf.sound.spec", { scale: "log", cmap: "heat", floor: -100 }), loud: null, selLoud: null,
  rack: LS.get("vf.sound.rack", []), rsel: 0, wantPlay: false, srcVer: null };
let audio = null, actx = null, raf = 0, dseq = 0, miniCache = null, baseDirty = true, specImg = null, specWant = "", work = null;

export default {
  id: "sound", title: "Sound Lab", sub: "edit, measure and find sounds", icon: "sound",
  mount(el) { el.innerHTML = layout(); setup(); },
  show(p = {}) { if (p.panel) setTab(p.panel === "find" ? "find" : p.panel); if (p.clip && p.clip !== S.cur) reload(p.clip); baseDirty = true; requestAnimationFrame(draw); },
  hide() { pvStop(); if (audio && !audio.paused) { audio.pause(); S.head = audio.currentTime; } },
};

function layout() {
  return `<div class="ws side-lr snd">
  <div class="col">
    <section class="pane grow">
      <div class="pane-h"><div class="t">Clips</div><div class="meta" id="sd-count"></div><div class="tools"><button class="iconbtn" id="sd-add" title="Add audio files">${icon("plus")}</button></div></div>
      <div class="pane-b flush"><div class="drop snd-drop" id="sd-drop"><b>Drop audio or click to add</b><span>mp3 · wav · m4a · flac · ogg — up to 5 min</span></div><div class="list" id="sd-list"></div></div>
      <div class="pane-f"><span id="sd-seln" title="Ticked clips are for the batch: the rack runs on each of them">none ticked for batch</span><button class="btn xs ghost" id="sd-selall" style="margin-left:auto">Tick all</button></div>
    </section>
  </div>
  <div class="col">
    <section class="pane grow" id="sd-trackpane">
      <div class="pane-h"><div class="t">Track</div><div class="meta snd-meta" id="sd-name"></div></div>
      <div class="snd-bar">
        <button class="iconbtn snd-playbtn" id="sd-play" title="Play / pause (Space)">${icon("play")}<span>Play</span></button>
        <button class="iconbtn" id="sd-stop" title="Stop">${icon("stop")}</button>
        <button class="iconbtn" id="sd-loop" title="Loop (L)">${I.loop}</button>
        <button class="btn xs ghost snd-pvbtn" id="sd-pv" title="Preview the rack on the card, looped (Shift+Space)">${I.ear}<span>Preview</span></button>
        <div class="seg snd-hear" id="sd-hear" title="Listen to your edits or to the clip as you uploaded it" hidden><button data-h="out" class="on">Edited</button><button data-h="in">Original</button></div>
        <span class="snd-clock" id="sd-clock" title="Playhead">0:00.000</span>
        <span class="sep"></span>
        <button class="iconbtn" id="sd-undo" title="Undo (Ctrl+Z)">${icon("undo")}</button>
        <button class="iconbtn" id="sd-redo" title="Redo (Ctrl+Shift+Z / Ctrl+Y)">${icon("redo")}</button>
        <span class="sep"></span>
        <button class="iconbtn" id="sd-zout" title="Zoom out (−)">${icon("zoomout")}</button>
        <button class="iconbtn" id="sd-zin" title="Zoom in (+, or the wheel at the pointer)">${icon("zoomin")}</button>
        <button class="iconbtn" id="sd-zsel" title="Zoom to the selection (Z)">${I.zsel}</button>
        <button class="iconbtn" id="sd-fit" title="Fit the whole clip (F)">${icon("fit")}</button>
        <span class="sep"></span>
        <div class="seg" id="sd-mode" title="What the track shows (W cycles)"><button data-m="wave">Wave</button><button data-m="spectrum">Spectrum</button><button data-m="both">Both</button></div>
        <div class="seg snd-tool" id="sd-tool" title="Time selects a stretch; Box selects time and frequency in the spectrum (R; or hold Alt)"><button data-t="time" class="on">Time</button><button data-t="box">${I.box}Box</button></div>
        <button class="iconbtn" id="sd-specset" title="Spectrum settings: scale, colours, floor">${I.gear}</button>
        <span class="sep"></span>
        <button class="iconbtn" id="sd-mark" title="Add a marker at the playhead (M); label the selection (Ctrl+B)">${I.flag}</button>
        <button class="btn ghost xs" id="sd-keep" title="Keep only the selection (crop the clip to it)" disabled>Keep</button>
        <button class="btn ghost xs" id="sd-cut" title="Remove the selection (Delete)" disabled>Cut</button>
        <button class="iconbtn" id="sd-dl" title="Download: WAV or MP3, the whole clip or the selection">${icon("down")}</button>
        <button class="iconbtn" id="sd-help" title="Keys (?)">${I.keys}</button>
      </div>
      <div class="pane-b stage" id="sd-stage">
        <div class="snd-row snd-ruler"><div class="snd-corner">Time</div><canvas id="sd-ruler"></canvas></div>
        <div class="snd-row snd-mkrow"><div class="snd-corner">Markers</div><canvas id="sd-mkl"></canvas></div>
        <div class="snd-row snd-track">
          <div class="snd-ti"><div class="nm" id="sd-tname">—</div><div class="sub">Stereo</div><div class="sub">44.1 kHz</div><div class="sub" id="sd-tlen"></div><div class="sub snd-tcredit" id="sd-tcredit"></div><span class="chip red" id="sd-tver">—</span></div>
          <div class="snd-vr"><canvas id="sd-vr"></canvas></div>
          <div class="snd-lanes"><canvas id="sd-base"></canvas><canvas id="sd-over"></canvas></div>
        </div>
        <div class="snd-row snd-det" id="sd-detrow"><div class="snd-corner" title="The sound finder's score for each window; the line is the sensitivity">Detector</div><canvas id="sd-det"></canvas></div>
        <div class="snd-row snd-mini"><div class="snd-corner">Overview</div><div class="snd-minibox"><canvas id="sd-mini"></canvas></div></div>
        <div class="snd-empty hidden" id="sd-empty"><div class="drop" id="sd-drop2"><b>Drop audio here to edit it</b><span class="hint">or click to choose files: mp3, wav, m4a, flac, ogg</span></div></div>
        <div class="snd-work hidden" id="sd-work"><i></i><span id="sd-busymsg">The card processes the audio…</span><button class="btn ghost xs hidden" id="sd-workstop">Stop</button></div>
      </div>
      <div class="pane-f" id="sd-status"></div>
    </section>
    <section class="pane snd-meter">
      <div class="pane-h"><div class="t">Loudness</div><div class="meta" id="sd-lmeta">EBU R128</div></div>
      <div class="pane-b flush"><div class="snd-lm" id="sd-lm"></div></div>
    </section>
  </div>
  <div class="col">
    <section class="pane snd-side">
      <div class="pane-h"><div class="seg snd-tabs"><button data-tab="fx" class="on">Effects</button><button data-tab="find">Find sounds</button><button data-tab="marks">Markers</button></div><div class="meta" id="sd-tabmeta"></div></div>
      <div class="pane-b flush snd-tabb" data-body="fx"><div id="sd-rack"></div></div>
      <div class="pane-act snd-rackact" data-body="fx" id="sd-rackact"></div>
      <div class="pane-b flush snd-tabb" data-body="find" hidden><div id="sf-lf"></div></div>
      <div class="pane-b flush snd-tabb" data-body="marks" hidden><div id="sd-mks"></div></div>
    </section>
    <section class="pane snd-hist"><div class="pane-h"><div class="t">History</div><div class="meta" id="sd-histmeta"></div></div><div class="pane-b flush" id="sd-hist"></div></section>
  </div>
</div>`;
}

// ---------------------------------------------------------------- helpers
const dur = () => S.pcm ? S.pcm.len / S.pcm.sr : (S.view ? S.view.seconds : (audio && isFinite(audio.duration) ? audio.duration : 0));
const clampT = (t) => Math.max(0, Math.min(dur(), t));
function fmtT(t, d = 3) { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(d).padStart(d ? d + 3 : 2, "0")}`; }
const fHz = (f) => f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)} kHz` : `${Math.round(f)} Hz`;
const fL = (v, u = "LUFS") => v == null ? "—" : `${v.toFixed(1)}${u ? " " + u : ""}`;
function errMsg(e) { const m = (e && e.message) || String(e); try { const j = JSON.parse(m); return j.detail || m; } catch (x) { return m; } }
function geom(cv) {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
  if (cv.width !== W) cv.width = W;
  if (cv.height !== H) cv.height = H;
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h };
}
const stepOf = (p) => ["bits", "semitones", "outside"].includes(p.k) ? 1 : ["target", "ceiling"].includes(p.k) ? 0.1 : p.k === "ms" ? Math.max(1, Math.round((p.max - p.min) / 400)) : +((p.max - p.min) / 200).toPrecision(2);
const fv = (v, st) => st >= 1 ? String(Math.round(v)) : (+v).toFixed(st >= 0.1 ? 1 : st >= 0.01 ? 2 : 3);
// sliders for Hz move on a log scale (0..1000), every other parameter linearly
const toSl = (p, v) => HZ.has(p.k) ? Math.round(1000 * Math.log(v / p.min) / Math.log(p.max / p.min)) : v;
const fromSl = (p, s) => HZ.has(p.k) ? Math.round(p.min * Math.pow(p.max / p.min, s / 1000)) : +s;
const pval = (p, v) => HZ.has(p.k) ? fHz(v) : p.k === "outside" ? (v >= 0.5 ? "outside" : "inside") : fv(v, stepOf(p));
function summary(st) {
  const p = st.params || {}, d = S.fx[st.id];
  if (st.id === "band") return `${fHz(p.lo)}–${fHz(p.hi)} ${p.db > 0 ? "+" : ""}${Math.round(p.db)} dB${p.outside >= 0.5 ? " outside" : ""}`;
  if (st.id === "loudness") return `${(+p.target).toFixed(1)} LUFS · ≤ ${(+p.ceiling).toFixed(1)} dBTP`;
  return d ? (d.params || []).map((q) => `${q.label.replace(/ (dB|Hz|s|ms|×)$/, "")} ${pval(q, p[q.k])}`).join(" · ") : "";
}
// downloads go through a blob: URL — plain http:// file links trip Chrome's insecure-download warning on the LAN
async function save(href, name) {
  try {
    const r = await fetch(href); if (!r.ok) throw new Error(`download failed (${r.status})`);
    const cd = r.headers.get("Content-Disposition") || "", m = /filename="?([^";]+)"?/.exec(cd);
    saveBlob(await r.blob(), name || (m && m[1]) || "vectorfall.wav");
  } catch (e) { showErr(e); }
}
function saveBlob(blob, name) {
  const u = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 4000);
}
function url(dl) {
  const v = S.view, which = v && v.cur === 0 ? "in" : "out";
  return `/api/sounds/${S.cur}/audio?which=${which}&t=${v ? v.cur : 0}-${Date.now()}${dl ? "&download=1" : ""}`;
}
function playUrl() {
  const which = S.hear === "in" ? "in" : "cur", v = S.view;
  return `/api/sounds/${S.cur}/audio?which=${which}&t=${v ? v.cur : "x"}-${Date.now()}`;
}
function streamSrc(keep) {
  if (!S.cur || !audio) return;
  const t = audio.currentTime || S.head || 0, was = !audio.paused;
  if (was) audio.pause();
  audio.src = playUrl(); audio.load();
  if (keep) audio.addEventListener("loadedmetadata", () => { try { audio.currentTime = Math.min(t, audio.duration || t); } catch (e) { /* not seekable yet */ } if (was) { S.wantPlay = true; } }, { once: true });
  transport();
}
// a /v1 model call from the page: JSON in, JSON (or a blob + meta) out
async function v1(name, body, { signal, blob } = {}) {
  const r = await fetch("/v1/models/" + name, { method: "POST", headers: { "Content-Type": "application/json", Accept: "*/*" }, body: JSON.stringify(body), signal });
  if (!r.ok) { let m = r.statusText; try { const j = await r.json(); m = (j.error || {}).message || j.detail || m; } catch (e) { /* not JSON */ } throw new Error(m); }
  if (blob) { let meta = {}; try { meta = JSON.parse(r.headers.get("X-VF-Meta") || "{}"); } catch (e) { /* optional */ } return { data: await r.arrayBuffer(), meta }; }
  return (await r.json()).result;
}
async function v1job(name, body, onStep, signal) {
  const r = await fetch(`/v1/models/${name}?async=1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) { let m = r.statusText; try { m = ((await r.json()).error || {}).message || m; } catch (e) { /* not JSON */ } throw new Error(m); }
  const env = await watchJob((await r.json()).job, onStep, { signal });
  return env && env.result !== undefined ? env.result : env;
}
function ctx() {
  if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 }); } catch (e) { actx = new (window.AudioContext || window.webkitAudioContext)(); } }
  return actx;
}

// ---------------------------------------------------------------- setup
async function setup() {
  audio = new Audio(); audio.preload = "auto";
  audio.addEventListener("ended", () => {
    if (S.loop && !S.sel) { audio.currentTime = 0; audio.play(); return; }
    cancelAnimationFrame(raf); S.head = S.playFrom || 0; transport(); drawOverlay();
  });
  audio.addEventListener("pause", transport); audio.addEventListener("play", transport);
  audio.addEventListener("canplay", () => { if (S.wantPlay) { S.wantPlay = false; playPause(); } else transport(); });
  audio.addEventListener("error", () => { if (S.cur && audio.getAttribute("src")) { S.wantPlay = false; S.err = "the audio could not be loaded"; transport(); status(); } });

  dropZone($("#sd-drop"), upload, "audio/*");
  dropZone($("#sd-drop2"), upload, "audio/*");
  $("#sd-add").onclick = () => $("#sd-drop input[type=file]").click();
  $("#sd-selall").onclick = () => { const all = S.clips.length && S.picks.size < S.clips.length; S.picks = new Set(all ? S.clips.map((c) => c.id) : []); renderList(); };

  $("#sd-play").onclick = playPause; $("#sd-stop").onclick = stopPlay;
  $("#sd-pv").onclick = () => (PV.on ? pvStop() : pvStart());
  $$("#sd-hear button").forEach((b) => b.onclick = () => { if (S.hear === b.dataset.h) return; S.hear = b.dataset.h; streamSrc(true); });
  $("#sd-loop").onclick = () => { S.loop = !S.loop; transport(); };
  $("#sd-undo").onclick = () => step(-1); $("#sd-redo").onclick = () => step(1);
  $("#sd-zin").onclick = () => zoom(0.5); $("#sd-zout").onclick = () => zoom(2);
  $("#sd-fit").onclick = () => setWin(0, dur());
  $("#sd-zsel").onclick = zoomSel;
  $("#sd-dl").onclick = (e) => {
    if (!S.cur) return;
    const sel = S.sel, base = url(true), part = sel ? `&start=${sel[0].toFixed(3)}&end=${sel[1].toFixed(3)}` : "";
    const items = [{ icon: "down", label: "Whole clip · WAV", sub: "lossless", run: () => save(base) },
                   { icon: "down", label: "Whole clip · MP3", sub: "192 kbit/s, about 10× smaller", run: () => save(base + "&fmt=mp3") }];
    if (sel) items.push("-", { icon: "down", label: `Selection ${fmtT(sel[0])}–${fmtT(sel[1])} · WAV`, run: () => save(base + part) },
                        { icon: "down", label: `Selection ${fmtT(sel[0])}–${fmtT(sel[1])} · MP3`, run: () => save(base + "&fmt=mp3" + part) });
    menu(e.currentTarget, items);
  };
  $("#sd-keep").onclick = () => trim("keep");
  $("#sd-cut").onclick = () => trim("cut");
  $$("#sd-mode [data-m]").forEach((b) => b.onclick = () => setMode(b.dataset.m));
  $$("#sd-tool [data-t]").forEach((b) => b.onclick = () => setTool(b.dataset.t));
  $("#sd-specset").onclick = specMenu;
  $("#sd-mark").onclick = (e) => menu(e.currentTarget, [{ icon: "plus", label: "Marker at the playhead", sub: "M · also while it plays", run: addMarker },
    { icon: "plus", label: "Label the selection", sub: "Ctrl+B · a region with a name", run: labelSel }]);
  $("#sd-help").onclick = helpKeys;
  $("#sd-workstop").onclick = () => { if (work) work.abort(); };
  $("#sd-trackpane .snd-bar").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) b.blur(); });
  $$(".snd-tabs [data-tab]").forEach((b) => b.onclick = () => setTab(b.dataset.tab));

  wireTrack();
  wireFind();
  document.addEventListener("keydown", keys);
  new ResizeObserver(() => { baseDirty = true; miniCache = null; draw(); }).observe($("#sd-stage"));
  setMode(S.mode, true);

  try { S.fx = await api.get("/sounds/fx"); } catch (e) { S.err = errMsg(e); }
  S.rack = S.rack.filter((st) => S.fx[st.id]).map((st) => ({ id: st.id, on: st.on !== false, params: { ...defaults(st.id), ...(st.params || {}) } }));
  renderRack(); renderHistory(); renderMarkers(); renderMeter(); transport(); status();
  await reload();
}
const defaults = (id) => { const o = {}; ((S.fx[id] || {}).params || []).forEach((p) => o[p.k] = p.default); return o; };

// ---------------------------------------------------------------- library
async function reload(want) {
  try { S.clips = await api.get("/sounds"); } catch (e) { S.clips = []; S.err = errMsg(e); }
  S.picks = new Set([...S.picks].filter((id) => S.clips.some((c) => c.id === id)));
  renderList();
  const id = want || (S.clips.some((c) => c.id === S.cur) ? S.cur : (S.clips[0] && S.clips[0].id));
  if (id && id !== S.cur) await pick(id);
  else if (!id) { S.cur = null; S.view = null; S.pcm = null; emptyState(true); renderHistory(); transport(); status(); draw(); }
}
function renderList() {
  $("#sd-list").innerHTML = S.clips.map((c) => `<div class="li snd-clip ${c.id === S.cur ? "on" : ""}" data-id="${c.id}">
      <input type="checkbox" data-pick="${c.id}" ${S.picks.has(c.id) ? "checked" : ""} title="Include in the batch (the rack runs on every ticked clip)">
      <div class="tx"><div class="nm" title="${esc(c.name)}">${esc(c.name)}</div><div class="sub">${fmtT(c.seconds, 1)} · ${c.credit ? esc(c.credit.licence) + " · " : ""}added ${fmt.ago(c.added)}</div></div>
      <button class="iconbtn snd-del" data-del="${c.id}" title="Delete clip">${icon("trash")}</button></div>`).join("")
    || `<div class="empty">No clips yet.</div>`;
  $$("#sd-list [data-id]").forEach((r) => r.onclick = (e) => { if (e.target.closest("input,button")) return; pick(r.dataset.id); });
  $$("#sd-list [data-pick]").forEach((c) => c.onchange = () => { c.checked ? S.picks.add(c.dataset.pick) : S.picks.delete(c.dataset.pick); counts(); renderRackAct(); });
  $$("#sd-list [data-del]").forEach((b) => b.onclick = () => del(b.dataset.del));
  $("#sd-count").textContent = S.clips.length ? `${S.clips.length} clip${S.clips.length > 1 ? "s" : ""}` : "";
  counts(); renderRackAct();
}
function counts() {
  const n = S.picks.size;
  $("#sd-seln").textContent = n ? `${n} ticked for batch` : "none ticked for batch";
  $("#sd-selall").textContent = S.clips.length && n === S.clips.length ? "Untick all" : "Tick all";
}
async function upload(files) {
  let last = null, ok = 0;
  for (let i = 0; i < files.length; i++) {
    S.last = `Decode ${i + 1}/${files.length}: ${files[i].name}`; status();
    const fd = new FormData(); fd.append("file", files[i]);
    try {
      const r = await api.raw("POST", "/sounds", fd), m = await r.json(); last = m.id; ok++;
      if (m.truncated) toast(`${files[i].name}: kept the first ${fmtT(m.seconds)} of ${fmtT(m.original_seconds)}. The Sound Lab edits up to 5 minutes at a time: cut the long file into parts first.`, "bad", 9000);
    }
    catch (e) { toast(`${files[i].name}: ${errMsg(e)}`, "bad", 6000); }
  }
  S.last = ""; status();
  if (ok) toast(`Added ${ok} clip${ok > 1 ? "s" : ""}.`, "good");
  await reload(last);
}
async function del(id) {
  const c = S.clips.find((x) => x.id === id);
  if (!c || !confirm(`Delete “${c.name}”? This removes the clip and its whole edit history.`)) return;
  try {
    await api.del("/sounds/" + id);
    S.picks.delete(id);
    if (id === S.cur) { pvStop(); if (audio) audio.pause(); S.cur = null; S.view = null; S.pcm = null; }
    await reload();
  } catch (e) { showErr(e); }
}
async function pick(id) {
  pvStop();
  if (audio && !audio.paused) audio.pause();
  dseq++;
  S.cur = id; S.sel = null; S.fsel = null; S.head = 0; S.view = null; S.pcm = null; S.err = ""; S.last = ""; specImg = null; S.loud = null; S.selLoud = null;
  S.wantPlay = false; S.hear = "out"; S.srcVer = null;
  streamSrc(false);                        // playable in a moment, whatever the GPU is doing
  $$("#sd-list [data-id]").forEach((r) => r.classList.toggle("on", r.dataset.id === id));
  const c = S.clips.find((x) => x.id === id);
  // the Track header: name, then who made it and under which licence (shipped sample music)
  $("#sd-name").innerHTML = c ? `<b title="${esc(c.name)}">${esc(c.name)}</b>${credit(c)}` : "";
  $("#sd-tcredit").innerHTML = c && c.credit ? `<a class="snd-credit" href="${esc(c.credit.source)}" target="_blank" rel="noopener" title="${esc(c.credit.attribution || c.credit.author)}">${esc(c.credit.author)}<br>${esc(c.credit.licence)}</a>` : "";
  $("#sd-tname").textContent = c ? c.name : "—"; $("#sd-tname").title = c ? c.name : "";
  emptyState(false); setBusy(true, "Loading clip…");
  S.marks = []; S.found = null; S.markers = []; if (S.model && !S.clips.some((x) => x.id === S.model)) S.model = null; renderFind(); renderMarkers();
  api.get(`/sounds/${id}/marks`).then((m) => { if (S.cur === id) { S.marks = m; renderFind(); drawOverlay(); } }).catch(() => {});
  v1("sound.markers.get", { sound: id }).then((m) => { if (S.cur === id) { S.markers = m || []; renderMarkers(); drawOverlay(); } }).catch(() => {});
  try { const v = await api.get(`/sounds/${id}/current`); if (S.cur === id) setView(v, true); }
  catch (e) { showErr(e); } finally { setBusy(false); }
}
function emptyState(on) { $("#sd-empty").classList.toggle("hidden", !on); }

// ---------------------------------------------------------------- the current version
function setView(v, fresh) {
  pvStop();
  S.view = v; S.pcm = null; miniCache = null; baseDirty = true; specImg = null;
  const D = v.seconds;
  if (fresh || S.span <= 0 || S.span > D) { S.t0 = 0; S.span = D; }
  S.t0 = Math.max(0, Math.min(S.t0, D - S.span));
  if (S.sel) { const a = Math.min(S.sel[0], D), b = Math.min(S.sel[1], D); S.sel = b - a > 0.0005 ? [a, b] : null; }
  if (!S.sel) S.fsel = null;
  S.head = Math.min(S.head, D);
  $("#sd-tlen").textContent = fmtT(D);
  if (S.srcVer != null && S.srcVer !== v.cur && S.hear !== "in") streamSrc(true);
  S.srcVer = v.cur;
  if (!v.cur) S.hear = "out";
  loadPcm(); loadLoudness();
  renderHistory(); renderRackAct(); transport(); status(); draw();
}
async function loadPcm() {
  const my = ++dseq;
  try {
    const r = await fetch(url(false));
    if (!r.ok) throw new Error(`audio ${r.status}`);
    const buf = await r.arrayBuffer();
    if (my !== dseq) return;
    const ab = await ctx().decodeAudioData(buf);
    if (my !== dseq) return;
    const ch = [ab.getChannelData(0), ab.numberOfChannels > 1 ? ab.getChannelData(1) : ab.getChannelData(0)];
    S.pcm = { sr: ab.sampleRate, len: ab.length, ch, mip: mip(ch) };
    specAudio(ch, ab.sampleRate);
    baseDirty = true; miniCache = null; draw(); status(); renderMeter();
  } catch (e) { if (my === dseq) { S.err = "detail view unavailable: " + errMsg(e); status(); } }
}
function mip(ch) {
  const B = 256, out = { blk: B, min: [], max: [], ss: [] };
  for (const d of ch) {
    const n = Math.ceil(d.length / B), mn = new Float32Array(n), mx = new Float32Array(n), ss = new Float32Array(n);
    for (let b = 0; b < n; b++) {
      let lo = 1e9, hi = -1e9, s = 0; const e = Math.min(d.length, (b + 1) * B);
      for (let i = b * B; i < e; i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; s += v * v; }
      mn[b] = lo; mx[b] = hi; ss[b] = s;
    }
    out.min.push(mn); out.max.push(mx); out.ss.push(ss);
  }
  return out;
}
function envelope(c, t0, t1, W) {
  const mn = new Float32Array(W).fill(1), mx = new Float32Array(W).fill(-1), rms = new Float32Array(W);
  const D = dur(); if (!D || W <= 0) return { mn, mx, rms: null };
  if (S.pcm) {
    const { sr, len, ch, mip: M } = S.pcm, d = ch[c], B = M.blk, spp = (t1 - t0) * sr / W, Mn = M.min[c], Mx = M.max[c], Ss = M.ss[c];
    for (let x = 0; x < W; x++) {
      let a = Math.floor((t0 + (t1 - t0) * x / W) * sr), b = Math.floor((t0 + (t1 - t0) * (x + 1) / W) * sr);
      if (b <= a) b = a + 1; if (a < 0) a = 0; if (b > len) b = len; if (a >= b) continue;
      let lo = 1e9, hi = -1e9, s = 0, n = 0;
      const ia = Math.ceil(a / B), ib = Math.floor(b / B);
      if (spp >= 2 * B && ib > ia) {
        for (let i = a; i < ia * B; i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; s += v * v; n++; }
        for (let k = ia; k < ib; k++) { if (Mn[k] < lo) lo = Mn[k]; if (Mx[k] > hi) hi = Mx[k]; s += Ss[k]; n += B; }
        for (let i = ib * B; i < b; i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; s += v * v; n++; }
      } else for (let i = a; i < b; i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; s += v * v; n++; }
      mn[x] = lo; mx[x] = hi; rms[x] = Math.sqrt(s / Math.max(1, n));
    }
    return { mn, mx, rms };
  }
  const v = S.view; if (!v || !v.wave) return { mn, mx, rms: null };
  const smin = v.wave.min[c] || v.wave.min[0], smax = v.wave.max[c] || v.wave.max[0], n = smin.length;
  for (let x = 0; x < W; x++) {
    const ta = t0 + (t1 - t0) * x / W, tb = t0 + (t1 - t0) * (x + 1) / W;
    if (ta >= D) continue;
    const ia = Math.min(n - 1, Math.floor(ta / D * n)), ib = Math.min(n, Math.max(ia + 1, Math.ceil(tb / D * n)));
    let lo = 1e9, hi = -1e9;
    for (let i = ia; i < ib; i++) { if (smin[i] < lo) lo = smin[i]; if (smax[i] > hi) hi = smax[i]; }
    if (lo <= hi) { mn[x] = lo; mx[x] = hi; }
  }
  return { mn, mx, rms: null };
}

// ---------------------------------------------------------------- drawing
// the track's lanes: the waveform (two channels) and/or the spectrogram, by mode
function lanes(h) {
  if (S.mode === "spectrum") return { spec: [0, h] };
  if (S.mode === "both") { const a = Math.round(h * 0.4); return { wave: [0, a], spec: [a + 1, h - a - 1] }; }
  return { wave: [0, h] };
}
const fmax = () => (S.pcm ? S.pcm.sr : 44100) / 2;
const fToY = (f, L) => L[0] + L[1] * (1 - uOf(f, S.spec.scale, fmax()));
const yToF = (y, L) => fAt(Math.max(0, Math.min(1, 1 - (y - L[0]) / L[1])), S.spec.scale, fmax());
function draw() {
  if (!$("#sd-base") || !$("#sd-base").clientWidth) return;
  if (baseDirty) { drawBase(); drawVR(); baseDirty = false; }
  drawOverlay();
}
function drawBase() {
  const { g, w, h } = geom($("#sd-base"));
  g.fillStyle = "#08080a"; g.fillRect(0, 0, w, h);
  if (!S.cur || !S.view) return;
  const L = lanes(h), D = dur();
  if (L.wave) drawWave(g, w, L.wave[0], L.wave[1]);
  if (L.spec) drawSpec(g, w, L.spec[0], L.spec[1]);
  if (L.wave && L.spec) { g.fillStyle = "#24242b"; g.fillRect(0, L.spec[0] - 1, w, 1); }
  if (S.t0 + S.span > D) { const xe = (D - S.t0) / S.span * w; g.fillStyle = "rgba(0,0,0,.55)"; g.fillRect(xe, 0, w - xe, h); }
}
function drawWave(g, w, Y, H) {
  const t0 = S.t0, t1 = S.t0 + S.span, lh = (H - 1) / 2, spp = S.pcm ? S.span * S.pcm.sr / w : Infinity;
  for (let c = 0; c < 2; c++) {
    const y0 = Y + c * (lh + 1), mid = y0 + lh / 2, amp = lh / 2 - 3;
    g.fillStyle = "#0b0b0e"; g.fillRect(0, y0, w, lh);
    g.fillStyle = "rgba(255,255,255,.07)"; g.fillRect(0, Math.round(mid), w, 1);
    g.fillStyle = "rgba(255,255,255,.03)"; g.fillRect(0, Math.round(mid - amp / 2), w, 1); g.fillRect(0, Math.round(mid + amp / 2), w, 1);
    g.save(); g.beginPath(); g.rect(0, y0, w, lh); g.clip();
    if (S.pcm && spp < 1.5) {                       // sample level: the actual samples, stems once they're far apart
      const { sr, ch } = S.pcm, d = ch[c], a = Math.max(0, Math.floor(t0 * sr) - 1), b = Math.min(d.length - 1, Math.ceil(t1 * sr) + 1);
      const X = (i) => (i / sr - t0) / S.span * w, pxs = 1 / spp;
      if (pxs > 10) { g.strokeStyle = "rgba(255,59,42,.35)"; g.lineWidth = 1; g.beginPath(); for (let i = a; i <= b; i++) { const x = X(i); g.moveTo(x, mid); g.lineTo(x, mid - d[i] * amp); } g.stroke(); }
      g.strokeStyle = "#ff3b2a"; g.lineWidth = 1.4; g.beginPath();
      for (let i = a; i <= b; i++) { const x = X(i), y = mid - d[i] * amp; if (i === a) g.moveTo(x, y); else g.lineTo(x, y); }
      g.stroke();
      if (pxs > 5) { g.fillStyle = "#ffb3a8"; for (let i = a; i <= b; i++) g.fillRect(X(i) - 1.5, mid - d[i] * amp - 1.5, 3, 3); }
    } else {
      const W = Math.max(1, Math.round(w)), e = envelope(c, t0, t1, W);
      g.fillStyle = "#a80000";
      for (let x = 0; x < W; x++) { if (e.mn[x] > e.mx[x]) continue; const ya = mid - e.mx[x] * amp, yb = mid - e.mn[x] * amp; g.fillRect(x, ya, 1, Math.max(1, yb - ya)); }
      if (e.rms) {
        g.fillStyle = "#ff3b2a";
        for (let x = 0; x < W; x++) { if (e.mn[x] > e.mx[x]) continue; const top = mid - Math.min(e.rms[x], e.mx[x]) * amp, bot = mid - Math.max(-e.rms[x], e.mn[x]) * amp; if (bot > top) g.fillRect(x, top, 1, bot - top); }
      }
    }
    g.restore();
    g.fillStyle = "rgba(255,255,255,.4)"; g.font = "600 10px 'JetBrains Mono', monospace"; g.fillText(c ? "R" : "L", 6, y0 + 13);
    if (!c) { g.fillStyle = "#24242b"; g.fillRect(0, y0 + lh, w, 1); }
  }
}
// the spectrogram of the visible window, computed by the worker at this zoom; while a new one is on its way the
// previous picture is stretched into place, so panning and zooming never show a blank lane
function drawSpec(g, w, Y, H) {
  const cols = Math.max(1, Math.round(w)), rows = Math.max(1, Math.round(H)), sp = S.spec;
  const key = [S.cur, S.view.cur, S.t0.toFixed(5), S.span.toFixed(5), cols, rows, sp.scale, sp.floor, sp.cmap, sp.N || 0].join("|");
  if (specImg && specImg.cv && specImg.scale === sp.scale && specImg.rows === rows) {
    const k = specImg, x0 = (k.t0 - S.t0) / S.span * w, xw = k.span / S.span * w;
    g.imageSmoothingEnabled = true; g.drawImage(k.cv, x0, Y, xw, H);
  } else if (!S.pcm) { g.fillStyle = "#55565e"; g.font = "12px Inter, sans-serif"; g.fillText("decoding the samples…", 12, Y + 20); }
  if (S.pcm && (!specImg || specImg.key !== key) && specWant !== key) {
    specWant = key;
    const want = { t0: S.t0, span: S.span, cols, rows, scale: sp.scale, floor: sp.floor, cmap: sp.cmap, N: sp.N || 0 };
    specImage(want).then((r) => {
      if (!r || !r.img) return;
      const cv = document.createElement("canvas"); cv.width = r.cols; cv.height = r.rows;
      cv.getContext("2d").putImageData(new ImageData(r.img, r.cols, r.rows), 0, 0);
      specImg = { ...want, cv, key, N: r.N }; specWant = ""; baseDirty = true; draw();
    });
  }
  g.fillStyle = "rgba(255,255,255,.5)"; g.font = "600 10px 'JetBrains Mono', monospace"; g.fillText(`L+R · ${SCALES[sp.scale]}${specImg && specImg.N ? " · FFT " + specImg.N : ""}`, 6, Y + 13);
}
function drawVR() {
  const { g, w, h } = geom($("#sd-vr"));
  g.clearRect(0, 0, w, h); g.font = "9px 'JetBrains Mono', monospace"; g.textAlign = "right";
  const tick = (y, label, lo = 0, hi = h) => {
    g.fillStyle = "rgba(255,255,255,.2)"; g.fillRect(w - 5, Math.round(y), 5, 1);
    g.fillStyle = "#6e6f77"; g.fillText(label, w - 7, Math.max(lo + 9, Math.min(hi - 2, y + 3)));
  };
  if (!S.view) return;
  const L = lanes(h);
  if (L.spec) {
    const fs = S.spec.scale === "linear" ? [2000, 5000, 10000, 15000, 20000] : [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    let last = -99;
    for (const f of fs) { if (f > fmax()) continue; const y = fToY(f, L.spec); if (Math.abs(y - last) < 13) continue; last = y; tick(y, f >= 1000 ? f / 1000 + "k" : String(f), L.spec[0] + 2, L.spec[0] + L.spec[1]); }
  }
  if (L.wave) {
    const lh = (L.wave[1] - 1) / 2;
    for (let c = 0; c < 2; c++) {
      const top = L.wave[0] + c * (lh + 1), mid = top + lh / 2, amp = lh / 2 - 3;
      for (const v of lh > 70 ? [1, 0.5, 0, -0.5, -1] : [1, 0, -1]) tick(mid - v * amp, v.toFixed(1), top + 2, top + lh - 3);
    }
  }
}
function drawRuler() {
  const cv = $("#sd-ruler"), { g, w, h } = geom(cv);
  g.fillStyle = "#0d0d10"; g.fillRect(0, 0, w, h);
  g.fillStyle = "rgba(255,255,255,.08)"; g.fillRect(0, h - 1, w, 1);
  if (!S.view) return;
  const X = (t) => (t - S.t0) / S.span * w;
  if (S.sel) { g.fillStyle = "rgba(255,255,255,.09)"; g.fillRect(X(S.sel[0]), 0, X(S.sel[1]) - X(S.sel[0]), h); }
  if (PV.on && PV.a != null) { g.fillStyle = "rgba(90,170,255,.22)"; g.fillRect(X(PV.a), h - 5, X(PV.b) - X(PV.a), 4); }
  const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = steps.find((s) => s / S.span * w >= 84) || 300, minor = step / 5, dec = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  g.strokeStyle = "rgba(255,255,255,.22)"; g.fillStyle = "#9a9ba3"; g.font = "10px 'JetBrains Mono', monospace"; g.textAlign = "left"; g.lineWidth = 1;
  g.beginPath();
  for (let k = Math.max(0, Math.floor(S.t0 / minor)); k * minor <= S.t0 + S.span; k++) {
    const x = Math.round(X(k * minor)) + 0.5, major = k % 5 === 0;
    g.moveTo(x, h); g.lineTo(x, major ? h - 11 : h - 5);
    if (major) g.fillText(fmtT(k * minor, dec), x + 3, 11);
  }
  g.stroke();
  const xp = X(S.head);
  if (xp >= -6 && xp <= w + 6) { g.fillStyle = "#ffd300"; g.beginPath(); g.moveTo(xp - 5, h - 10); g.lineTo(xp + 5, h - 10); g.lineTo(xp, h - 1); g.closePath(); g.fill(); }
}
function drawMarkerLane() {
  const cv = $("#sd-mkl"), { g, w, h } = geom(cv);
  g.fillStyle = "#0b0b0e"; g.fillRect(0, 0, w, h);
  if (!S.view) return;
  const X = (t) => (t - S.t0) / S.span * w;
  g.font = "600 10px Inter, sans-serif"; g.textBaseline = "middle";
  for (const m of S.markers) {
    const a = X(m.t);
    if (m.end != null) { const b = X(m.end); if (b < 0 || a > w) continue; g.fillStyle = "rgba(90,170,255,.22)"; g.fillRect(a, 3, Math.max(2, b - a), h - 6); g.fillStyle = "#5aaaff"; g.fillRect(a, 3, 2, h - 6); g.fillRect(b - 2, 3, 2, h - 6); }
    else { if (a < -40 || a > w) continue; g.fillStyle = "#5aaaff"; g.fillRect(Math.round(a), 2, 2, h - 4); g.beginPath(); g.moveTo(a + 2, 2); g.lineTo(a + 9, 6); g.lineTo(a + 2, 10); g.fill(); }
    if (m.label) { g.fillStyle = "#cfe5ff"; g.fillText(m.label, a + 11, h / 2 + 1, 160); }
  }
}
function drawOverlay() {
  const cv = $("#sd-over"); if (!cv || !cv.clientWidth) return;
  const { g, w, h } = geom(cv); g.clearRect(0, 0, w, h);
  if (S.view) {
    const X = (t) => (t - S.t0) / S.span * w, L = lanes(h);
    drawFinds(g, X, w, h);
    g.strokeStyle = "rgba(90,170,255,.28)"; g.setLineDash([2, 4]);
    for (const m of S.markers) for (const t of m.end != null ? [m.t, m.end] : [m.t]) { const x = Math.round(X(t)) + 0.5; if (x < 0 || x > w) continue; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    g.setLineDash([]);
    if (S.sel) {
      const a = X(S.sel[0]), b = X(S.sel[1]);
      if (S.fsel && L.spec) {                                        // a box: time x frequency in the spectrogram
        const y1 = fToY(S.fsel[1], L.spec), y0 = fToY(S.fsel[0], L.spec);
        g.fillStyle = "rgba(0,0,0,.35)"; g.fillRect(0, L.spec[0], w, L.spec[1]);
        g.save(); g.beginPath(); g.rect(a, y1, b - a, y0 - y1); g.clip(); g.clearRect(a, y1, b - a, y0 - y1); g.restore();
        g.strokeStyle = "#fff"; g.lineWidth = 1; g.setLineDash([4, 3]); g.strokeRect(a + 0.5, y1 + 0.5, b - a - 1, y0 - y1 - 1); g.setLineDash([]);
        g.fillStyle = "#fff"; g.font = "600 10px 'JetBrains Mono', monospace"; g.fillText(`${fHz(S.fsel[0])}–${fHz(S.fsel[1])}`, a + 4, Math.max(L.spec[0] + 11, y1 - 4));
        if (L.wave) { g.fillStyle = "rgba(255,255,255,.08)"; g.fillRect(a, L.wave[0], b - a, L.wave[1]); }
      } else {
        g.fillStyle = "rgba(255,255,255,.12)"; g.fillRect(a, 0, b - a, h);
        g.fillStyle = "rgba(255,255,255,.6)"; g.fillRect(Math.round(a), 0, 1, h); g.fillRect(Math.round(b) - 1, 0, 1, h);
      }
    }
    if (S.hover != null && !S.drag) {
      const x = Math.round(X(S.hover)) + 0.5; g.strokeStyle = "rgba(255,255,255,.28)"; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); g.setLineDash([]);
      if (S.hoverF != null) { g.fillStyle = "rgba(0,0,0,.7)"; g.fillRect(x + 6, S.hoverY - 16, 74, 15); g.fillStyle = "#fff"; g.font = "10px 'JetBrains Mono', monospace"; g.fillText(fHz(S.hoverF), x + 9, S.hoverY - 5); }
    }
    const xp = X(S.head);
    if (xp >= 0 && xp <= w) { g.fillStyle = PV.on ? "#5aaaff" : "#ffd300"; g.fillRect(Math.round(xp), 0, 1, h); }
  }
  drawRuler(); drawMarkerLane(); drawDetector(); drawMini();
  $("#sd-clock").textContent = fmtT(S.head);
}
function drawMini() {
  const cv = $("#sd-mini"), { g, w, h } = geom(cv);
  g.clearRect(0, 0, w, h);
  if (!S.view) return;
  const D = dur(); if (!D) return;
  if (!miniCache || miniCache.w !== w || miniCache.h !== h) {
    const dpr = window.devicePixelRatio || 1, c2 = document.createElement("canvas");
    c2.width = Math.max(1, Math.round(w * dpr)); c2.height = Math.max(1, Math.round(h * dpr));
    const g2 = c2.getContext("2d"); g2.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = Math.max(1, Math.round(w)), L = envelope(0, 0, D, W), R = envelope(1, 0, D, W), mid = h / 2, amp = h / 2 - 3;
    g2.fillStyle = "rgba(212,0,0,.7)";
    for (let x = 0; x < W; x++) { const lo = Math.min(L.mn[x], R.mn[x]), hi = Math.max(L.mx[x], R.mx[x]); if (lo > hi) continue; g2.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp)); }
    miniCache = { w, h, c: c2 };
  }
  g.drawImage(miniCache.c, 0, 0, w, h);
  const X = (t) => t / D * w, a = X(S.t0), b = X(S.t0 + S.span);
  g.fillStyle = "#5aaaff"; for (const m of S.markers) g.fillRect(Math.round(X(m.t)), 0, 1, 5);
  g.fillStyle = "rgba(0,0,0,.45)"; g.fillRect(0, 0, a, h); g.fillRect(b, 0, w - b, h);
  if (S.sel) { g.fillStyle = "rgba(255,255,255,.14)"; g.fillRect(X(S.sel[0]), 0, Math.max(1, X(S.sel[1]) - X(S.sel[0])), h); }
  g.strokeStyle = "rgba(255,255,255,.75)"; g.lineWidth = 1; g.strokeRect(Math.round(a) + 0.5, 0.5, Math.max(3, b - a) - 1, h - 1);
  g.fillStyle = "#ffd300"; g.fillRect(Math.round(X(S.head)), 0, 1, h);
}
// the finder's score per window (Sonic Visualiser style layer), with the sensitivity line and the events
function drawDetector() {
  const row = $("#sd-detrow"), r = S.found, has = !!(r && r.curve && r.curve.t.length);
  if (row.classList.contains("on") !== has) { row.classList.toggle("on", has); $("#sd-stage").classList.toggle("withdet", has); baseDirty = true; requestAnimationFrame(draw); }
  if (!has) return;
  const { g, w, h } = geom($("#sd-det")), X = (t) => (t - S.t0) / S.span * w, c = r.curve, top = 1.2;
  g.fillStyle = "#0b0b0e"; g.fillRect(0, 0, w, h);
  const Y = (v) => h - 2 - Math.min(top, v) / top * (h - 4);
  for (const e of r.events) { const a = X(e.a), b = X(e.b); if (b < 0 || a > w) continue; g.fillStyle = colorOf(e.label) + "33"; g.fillRect(a, 0, b - a, h); }
  g.lineWidth = 1.3;
  for (let i = 1; i < c.t.length; i++) {
    const x0 = X(c.t[i - 1]), x1 = X(c.t[i]); if (x1 < 0 || x0 > w) continue;
    g.strokeStyle = c.label[i] > 0 ? colorOf(r.labels[c.label[i] - 1]) : "#55565e";
    g.beginPath(); g.moveTo(x0, Y(c.score[i - 1])); g.lineTo(x1, Y(c.score[i])); g.stroke();
  }
  g.strokeStyle = "rgba(255,211,0,.7)"; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(0, Y(S.thr) + 0.5); g.lineTo(w, Y(S.thr) + 0.5); g.stroke(); g.setLineDash([]);
  const xp = X(S.head); if (xp >= 0 && xp <= w) { g.fillStyle = "#ffd300"; g.fillRect(Math.round(xp), 0, 1, h); }
}

// ---------------------------------------------------------------- view window, modes, mouse
function setWin(t0, span) {
  const D = dur(); if (!D) return;
  span = Math.max(Math.min(0.002, D), Math.min(D, span));
  t0 = Math.max(0, Math.min(D - span, t0));
  if (t0 !== S.t0 || span !== S.span) { S.t0 = t0; S.span = span; baseDirty = true; draw(); status(); }
}
function zoom(f, at) {
  const c = at != null ? at : (S.head >= S.t0 && S.head <= S.t0 + S.span ? S.head : S.t0 + S.span / 2);
  setWin(c - (c - S.t0) * f, S.span * f);
}
function zoomSel() { if (S.sel) { const p = (S.sel[1] - S.sel[0]) * 0.04; setWin(S.sel[0] - p, S.sel[1] - S.sel[0] + 2 * p); } }
function setMode(m, quiet) {
  S.mode = m; LS.set("vf.sound.mode", m);
  $$("#sd-mode [data-m]").forEach((x) => x.classList.toggle("on", x.dataset.m === m));
  $("#sd-stage").classList.toggle("spectral", m !== "wave");
  $("#sd-tool").hidden = $("#sd-specset").hidden = m === "wave";
  if (m === "wave") { setTool("time"); S.fsel = null; }
  baseDirty = true; if (!quiet) draw();
}
function setTool(t) { S.tool = t; $$("#sd-tool [data-t]").forEach((x) => x.classList.toggle("on", x.dataset.t === t)); $("#sd-over").classList.toggle("boxtool", t === "box"); }
function specMenu(e) {
  const sp = S.spec, set = (k, v) => { sp[k] = v; LS.set("vf.sound.spec", sp); specImg = null; baseDirty = true; draw(); };
  menu(e.currentTarget, [
    ...Object.entries(SCALES).map(([k, n]) => ({ icon: sp.scale === k ? "bolt" : "", label: `Frequency: ${n}`, sub: k === "log" ? "octaves equal; best for music" : k === "mel" ? "like the ear; best for speech" : "Hz equal; harmonics evenly spaced", run: () => set("scale", k) })), "-",
    ...Object.entries(CMAPS).map(([k, n]) => ({ icon: sp.cmap === k ? "bolt" : "", label: `Colours: ${n}`, run: () => set("cmap", k) })), "-",
    ...[-80, -100, -120].map((f) => ({ icon: sp.floor === f ? "bolt" : "", label: `Floor ${f} dB`, sub: f === -80 ? "hides quiet noise" : f === -120 ? "shows the faintest detail" : "", run: () => set("floor", f) })), "-",
    ...[0, 512, 2048, 4096].map((n) => ({ icon: (sp.N || 0) === n ? "bolt" : "", label: n ? `FFT ${n}` : "FFT: automatic", sub: n === 4096 ? "fine frequency, blurred time" : n === 512 ? "sharp time, coarse frequency" : n ? "" : "by zoom", run: () => set("N", n) })),
  ]);
}
const tAt = (e, el) => { const r = el.getBoundingClientRect(); return S.t0 + (e.clientX - r.left) / r.width * S.span; };
function setSel(v, f) { const hadBox = !!S.fsel; S.sel = v; S.fsel = v ? (f || null) : null; if (S.tab === "fx" && (hadBox || S.fsel)) renderRack(); else renderRackAct(); transport(); status(); drawOverlay(); markBtn(); selLoudness(); if (PV.on) pvRestart(); }
function seek(t) { S.head = clampT(t); S.playFrom = S.head; if (!audio.paused) { audio.currentTime = S.head; S.playEnd = null; } drawOverlay(); status(); renderLive(); }
// snapping: an edge within 7 px of a marker or a found event goes to it (hold Alt in the waveform to drag freely)
function snap(t, e, el) {
  if (e.altKey) return t;
  const px = S.span / el.getBoundingClientRect().width * 7;
  let best = t, d = px;
  const pts = [];
  S.markers.forEach((m) => { pts.push(m.t); if (m.end != null) pts.push(m.end); });
  (S.found ? S.found.events : []).forEach((x) => pts.push(x.a, x.b));
  for (const p of pts) if (Math.abs(p - t) < d) { d = Math.abs(p - t); best = p; }
  return best;
}
function wireTrack() {
  const ov = $("#sd-over");
  const laneAt = (e) => { const r = ov.getBoundingClientRect(), y = e.clientY - r.top, L = lanes(r.height); return { y, L, spec: !!(L.spec && y >= L.spec[0]) }; };
  ov.addEventListener("pointerdown", (e) => {
    if (!S.view || e.button !== 0) return;
    ov.setPointerCapture(e.pointerId);
    const t = clampT(tAt(e, ov)), la = laneAt(e);
    if (la.spec && (S.tool === "box" || e.altKey)) {                   // a box in time and frequency
      S.drag = { box: true, x: e.clientX, t, f: yToF(la.y, la.L.spec), L: la.L.spec, moved: false };
      return;
    }
    let anchor = snap(t, e, ov);
    if (e.shiftKey) anchor = S.sel ? (Math.abs(t - S.sel[0]) < Math.abs(t - S.sel[1]) ? S.sel[1] : S.sel[0]) : S.head;
    S.drag = { x: e.clientX, anchor, moved: e.shiftKey };
    if (e.shiftKey) S.sel = [Math.min(anchor, t), Math.max(anchor, t)];
    drawOverlay();
  });
  ov.addEventListener("pointermove", (e) => {
    if (!S.view) return;
    const t = clampT(tAt(e, ov)), la = laneAt(e); S.hover = t;
    S.hoverF = la.spec ? yToF(la.y, la.L.spec) : null; S.hoverY = la.y;
    if (S.drag) {
      if (Math.abs(e.clientX - S.drag.x) > 3) S.drag.moved = true;
      if (S.drag.box) {
        if (S.drag.moved) {
          const f = yToF(la.y, S.drag.L);
          S.sel = [Math.min(S.drag.t, t), Math.max(S.drag.t, t)]; S.fsel = [Math.max(20, Math.min(S.drag.f, f)), Math.min(fmax(), Math.max(S.drag.f, f))];
          status();
        }
      } else if (S.drag.moved) { const tt = snap(t, e, ov), a = Math.min(S.drag.anchor, tt), b = Math.max(S.drag.anchor, tt); S.sel = b - a > 0.0005 ? [a, b] : null; S.fsel = null; status(); }
    }
    drawOverlay();
  });
  ov.addEventListener("pointerup", (e) => {
    if (!S.drag) return;
    const d = S.drag; S.drag = null;
    if (!d.moved) { S.sel = null; S.fsel = null; seek(tAt(e, ov)); }
    else if (S.sel) { S.head = S.sel[0]; S.playFrom = S.head; if (!audio.paused) { audio.currentTime = S.sel[0]; S.playEnd = S.sel[1]; } }
    if (d.box && S.fsel && S.fsel[1] / S.fsel[0] < 1.02) S.fsel = null;
    setSel(S.sel, S.fsel);
    if (S.fsel) setTab("fx");
  });
  ov.addEventListener("pointerleave", () => { S.hover = null; S.hoverF = null; drawOverlay(); });
  ov.addEventListener("dblclick", () => { if (S.view) setSel([0, dur()]); });
  $("#sd-ruler").addEventListener("pointerdown", (e) => { if (S.view) seek(tAt(e, $("#sd-ruler"))); });
  $("#sd-mkl").addEventListener("pointerdown", (e) => {
    if (!S.view) return;
    const el = $("#sd-mkl"), t = tAt(e, el), px = S.span / el.clientWidth * 8;
    const m = S.markers.find((x) => Math.abs(x.t - t) < px || (x.end != null && t >= x.t && t <= x.end));
    if (m && m.end != null) { setSel([m.t, m.end]); seek(m.t); } else seek(m ? m.t : t);
  });
  $("#sd-det").addEventListener("pointerdown", (e) => {
    if (!S.found) return;
    const t = tAt(e, $("#sd-det")), ev = S.found.events.find((x) => t >= x.a && t <= x.b);
    if (ev) playRange(ev); else seek(t);
  });
  const mini = $("#sd-mini");
  const miniGo = (e) => { const r = mini.getBoundingClientRect(), t = (e.clientX - r.left) / r.width * dur(); setWin(t - S.span / 2, S.span); };
  mini.addEventListener("pointerdown", (e) => { if (!S.view) return; mini.setPointerCapture(e.pointerId); S.miniDrag = true; miniGo(e); });
  mini.addEventListener("pointermove", (e) => { if (S.miniDrag) miniGo(e); });
  mini.addEventListener("pointerup", () => { S.miniDrag = false; });
  $("#sd-stage").addEventListener("wheel", (e) => {
    if (!S.view) return;
    e.preventDefault();
    const horiz = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
    if (horiz) setWin(S.t0 + (e.deltaX || e.deltaY) / Math.max(1, ov.clientWidth) * S.span, S.span);
    else zoom(e.deltaY < 0 ? 0.8 : 1.25, clampT(tAt(e, ov)));
  }, { passive: false });
}
// move the selection's edges to the nearest zero crossings (no clicks at the cut)
function zeroSnap() {
  if (!S.sel || !S.pcm) return;
  const { sr, ch } = S.pcm, d = ch[0], near = (t) => {
    const i0 = Math.round(t * sr), R = Math.round(sr * 0.01);
    for (let k = 0; k < R; k++) for (const i of [i0 + k, i0 - k]) if (i > 0 && i < d.length && (d[i - 1] <= 0) !== (d[i] <= 0)) return i / sr;
    return t;
  };
  setSel([near(S.sel[0]), near(S.sel[1])]); S.last = "Selection edges moved to zero crossings"; status();
}
const KEYS = [["Space", "play / pause"], ["Shift+Space", "preview the rack on the card (loops the selection or 10 s)"], ["B", "A/B: the dry sound while previewing"],
  ["L", "loop"], ["C", "play around the selection, without it"], ["← →", "move 1 s (Shift: 10 s)"], ["Home / End", "start / end"],
  ["+ − / wheel", "zoom at the pointer (Shift+wheel scrolls)"], ["Z", "zoom to the selection"], ["F", "fit the clip"], ["W", "Wave → Spectrum → Both"],
  ["R", "Box tool (or hold Alt in the spectrum)"], ["Q", "box ↔ full band"], ["X", "selection edges to zero crossings"], ["M", "marker at the playhead"],
  ["Ctrl+B", "label the selection"], ["N / Shift+N", "next / previous found sound (or marker)"], ["Delete", "cut the selection"], ["Ctrl+A", "select all"],
  ["Ctrl+Z / Ctrl+Y", "undo / redo"], ["Esc", "clear the selection, stop the preview"], ["Alt+drag", "no snapping (waveform)"], ["?", "this list"]];
function helpKeys() {
  const d = document.createElement("div"); d.className = "snd-keys";
  d.innerHTML = `<div class="snd-keysbox"><div class="sec-t">Sound Lab keys</div><table>${KEYS.map(([k, v]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(v)}</td></tr>`).join("")}</table><div class="hint">Click anywhere to close.</div></div>`;
  d.onclick = () => d.remove(); document.body.appendChild(d);
}
function keys(e) {
  if (!document.querySelector("#view-sound.on")) return;
  const t = e.target;
  if (t && (t.tagName === "TEXTAREA" || t.tagName === "SELECT" || (t.tagName === "INPUT" && !["checkbox", "range", "button"].includes(t.type)))) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (k === " " && !mod && e.shiftKey) { e.preventDefault(); PV.on ? pvStop() : pvStart(); }
  else if (k === " " && !mod) { e.preventDefault(); if (PV.on) pvStop(); else playPause(); }
  else if (mod && k === "z") { e.preventDefault(); step(e.shiftKey ? 1 : -1); }
  else if (mod && k === "y") { e.preventDefault(); step(1); }
  else if (mod && k === "a") { if (S.view) { e.preventDefault(); setSel([0, dur()]); } }
  else if (mod && k === "b") { e.preventDefault(); labelSel(); }
  else if (mod) return;
  else if (k === "escape") { if (PV.on) pvStop(); setSel(null); }
  else if ((k === "delete" || k === "backspace") && S.sel) { e.preventDefault(); trim("cut"); }
  else if (k === "home") seek(0);
  else if (k === "end") seek(dur());
  else if (k === "arrowright" || k === "arrowleft") { e.preventDefault(); seek(S.head + (k === "arrowright" ? 1 : -1) * (e.shiftKey ? 10 : 1)); }
  else if (k === "=" || k === "+") zoom(0.5);
  else if (k === "-") zoom(2);
  else if (k === "z") zoomSel();
  else if (k === "f") setWin(0, dur());
  else if (k === "l") { S.loop = !S.loop; transport(); }
  else if (k === "b") { if (PV.on) pvBypass(!PV.bypass); }
  else if (k === "c") playAround();
  else if (k === "w") setMode({ wave: "spectrum", spectrum: "both", both: "wave" }[S.mode]);
  else if (k === "r") { if (S.mode === "wave") setMode("both"); setTool(S.tool === "box" ? "time" : "box"); }
  else if (k === "q") { if (S.fsel) { S.prevF = S.fsel; setSel(S.sel); } else if (S.prevF && S.sel) setSel(S.sel, S.prevF); }
  else if (k === "x") zeroSnap();
  else if (k === "m") addMarker();
  else if (k === "n") nextEvent(e.shiftKey ? -1 : 1);
  else if (k === "?" || (k === "/" && e.shiftKey)) helpKeys();
}

// ---------------------------------------------------------------- transport
function playPause() {
  if (!S.cur) return;
  if (PV.on) pvStop();
  if (audio.readyState < 2) { S.wantPlay = !S.wantPlay; transport(); return; }   // still arriving: play the moment it can
  if (!audio.paused) { audio.pause(); S.head = audio.currentTime; cancelAnimationFrame(raf); drawOverlay(); transport(); return; }
  let start = S.head;
  if (S.sel) { start = S.head >= S.sel[0] && S.head < S.sel[1] - 0.01 ? S.head : S.sel[0]; S.playEnd = S.sel[1]; }
  else { S.playEnd = null; if (start >= dur() - 0.02) start = 0; }
  S.playFrom = start; S.skip = null;
  audio.currentTime = start;
  audio.play().then(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); }).catch((err) => toast("Playback failed: " + err.message, "bad"));
  transport();
}
// Audacity's "cut preview": 2 s before the selection, then 2 s after it, so you hear the edit before you make it
function playAround() {
  if (!S.sel || !S.cur || audio.readyState < 2) return;
  if (PV.on) pvStop();
  const [a, b] = S.sel;
  S.skip = [a, b]; S.playFrom = Math.max(0, a - 2); S.playEnd = Math.min(dur(), b + 2);
  audio.currentTime = S.playFrom;
  audio.play().then(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); });
  transport();
}
function stopPlay() {
  S.wantPlay = false;
  if (PV.on) { pvStop(); return; }
  if (!S.cur) return;
  audio.pause(); cancelAnimationFrame(raf);
  S.head = S.playFrom || 0; drawOverlay(); transport(); status();
}
function tick() {
  if (audio.paused) { transport(); return; }
  let t = audio.currentTime;
  if (S.skip && t >= S.skip[0] && t < S.skip[1]) { audio.currentTime = S.skip[1]; t = S.skip[1]; }
  if (S.playEnd != null && t >= S.playEnd) {
    if (S.loop && S.sel && !S.skip) { audio.currentTime = S.sel[0]; t = S.sel[0]; }
    else { audio.pause(); S.head = S.playFrom; S.skip = null; drawOverlay(); transport(); return; }
  }
  S.head = t;
  follow(t);
  drawOverlay(); renderLive();
  raf = requestAnimationFrame(tick);
}
function follow(t) { if (S.span < dur() - 1e-6 && (t > S.t0 + S.span * 0.97 || t < S.t0)) setWin(t - S.span * 0.03, S.span); }   // page-follow
function transport() {
  if (!$("#sd-play")) return;
  const has = !!S.view, playing = (!!audio && !audio.paused) || PV.on, v = S.view;
  const wait = !playing && !!S.wantPlay;
  $("#sd-play").innerHTML = icon(playing && !PV.on ? "pause" : "play") + `<span>${playing && !PV.on ? "Pause" : wait ? "Loading…" : "Play"}</span>`;
  $("#sd-play").classList.toggle("on", playing && !PV.on); $("#sd-play").classList.toggle("wait", wait);
  $("#sd-play").disabled = !S.cur; $("#sd-stop").disabled = !S.cur;
  $("#sd-pv").classList.toggle("on", PV.on); $("#sd-pv").disabled = !has || !S.pcm;
  $("#sd-pv").querySelector("span").textContent = PV.on ? (PV.bypass ? "Preview · dry (B)" : "Preview · on") : "Preview";
  const hr = $("#sd-hear"); if (hr) { hr.hidden = !(has && v.cur > 0); $$("#sd-hear button").forEach((b) => b.classList.toggle("on", b.dataset.h === (S.hear || "out"))); }
  $("#sd-loop").classList.toggle("on", S.loop);
  ["#sd-zin", "#sd-zout", "#sd-fit", "#sd-dl", "#sd-mark"].forEach((s) => $(s).disabled = !has);
  $("#sd-zsel").disabled = !has || !S.sel;
  $("#sd-keep").disabled = $("#sd-cut").disabled = !has || !S.sel || S.busy;
  $("#sd-undo").disabled = !(has && v.can_undo) || S.busy;
  $("#sd-redo").disabled = !(has && v.can_redo) || S.busy;
  $("#sd-tver").textContent = has ? (v.cur ? `version ${v.cur}` : "original") : "—";
}
function status() {
  const el = $("#sd-status"); if (!el) return;
  const err = S.err ? `<span class="snd-err" title="${esc(S.err)}">${esc(S.err)}</span>` : "";
  if (!S.view) { el.innerHTML = err || `<span>${S.clips.length ? "Loading…" : "No clip — drop audio to begin"}</span>${S.last ? `<span>${esc(S.last)}</span>` : ""}`; return; }
  const v = S.view;
  const sel = S.sel ? `<span>Selection <b>${fmtT(S.sel[0])}</b> – <b>${fmtT(S.sel[1])}</b> · ${(S.sel[1] - S.sel[0]).toFixed(3)} s${S.fsel ? ` · <b>${fHz(S.fsel[0])}–${fHz(S.fsel[1])}</b>` : ""}</span>`
    : `<span>No selection · edits apply to the whole clip</span>`;
  el.innerHTML = `<span>Version <b>${v.cur}</b>${v.history.length ? ` / ${v.history.length}` : ""}</span><span>Length <b>${fmtT(dur())}</b></span>${sel}`
    + `<span>View <b>${fmtT(S.t0, 2)}</b> +${S.span >= 1 ? S.span.toFixed(1) : S.span.toFixed(3)} s</span>${S.pcm ? "" : "<span>decoding…</span>"}${err}`
    + (S.last ? `<span class="timing" title="${esc(S.last)}">${esc(S.last)}</span>` : "");
}
function setBusy(on, msg, stoppable) {
  S.busy = on;
  $("#sd-work").classList.toggle("hidden", !on);
  $("#sd-workstop").classList.toggle("hidden", !(on && stoppable));
  if (msg) $("#sd-busymsg").textContent = msg;
  $("#sd-trackpane").classList.toggle("snd-busy", on);
  renderRackAct(); transport();
}
function showErr(e) { S.err = errMsg(e); status(); toast(S.err, "bad", 6500); }

// ---------------------------------------------------------------- editing
async function trim(op) {
  if (!S.cur || S.busy || !S.sel) return;
  pvStop();
  if (!audio.paused) { audio.pause(); S.head = audio.currentTime; }
  const [a, b] = S.sel;
  setBusy(true, op === "keep" ? "Keep the selection…" : "Cut the selection…"); S.err = "";
  try {
    const v = await api.post(`/sounds/${S.cur}/trim`, { op, start: +a.toFixed(4), end: +b.toFixed(4) });
    S.last = v.applied; setSel(null); S.head = op === "keep" ? 0 : a; setView(v, true);
  } catch (e) { showErr(e); } finally { setBusy(false); }
}
// a chain (or one effect) as ONE undoable edit, on the card, with progress and Stop
async function applyChain(chain, whole) {
  if (!S.cur || S.busy) return;
  const on = chain.filter((s) => s.on !== false);
  if (!on.length) { toast("Switch on at least one effect in the rack.", "bad"); return; }
  pvStop();
  if (!audio.paused) { audio.pause(); S.head = audio.currentTime; }
  const range = !whole && S.sel ? S.sel : null, body = { sound: S.cur, chain: on.map((s) => ({ id: s.id, params: s.params })) };
  if (range) { body.start = +range[0].toFixed(4); body.end = +range[1].toFixed(4); }
  const names = on.map((s) => SHORT[s.id] || s.id).join(" → ");
  work = new AbortController();
  setBusy(true, `${names}${range ? " on the selection" : ""} — on the card…`, true); S.err = "";
  try {
    const v = await v1job("sound.chain", body, (j) => { $("#sd-busymsg").textContent = `${j.message && j.message !== "starting" ? j.message : names} · ${Math.round((j.progress || 0) * 100)}%`; }, work.signal);
    S.last = `${v.applied} · ${fmt.ms(v.ms)} · ${v.realtime_x}× real-time`;
    setView(v);
  } catch (e) { if (e.cancelled) { S.last = "Stopped: the clip did not change"; status(); } else showErr(e); }
  finally { work = null; setBusy(false); }
}
async function step(dir) {
  if (!S.cur || S.busy || !S.view) return;
  if (dir < 0 ? !S.view.can_undo : !S.view.can_redo) return;
  const lbl = dir < 0 ? S.view.history[S.view.cur - 1] : S.view.history[S.view.cur];
  setBusy(true, dir < 0 ? "Undoing…" : "Redoing…"); S.err = "";
  try {
    const v = await api.post(`/sounds/${S.cur}/${dir < 0 ? "undo" : "redo"}`);
    S.last = `${dir < 0 ? "Undid" : "Redid"} ${lbl ? lbl.label : "edit"}`;
    setView(v);
  } catch (e) { showErr(e); } finally { setBusy(false); }
}
async function goTo(k) {
  if (!S.view || S.busy) return;
  let d = k - S.view.cur; if (!d) return;
  setBusy(true, d < 0 ? `Undo ${-d} step${d < -1 ? "s" : ""}…` : `Redo ${d} step${d > 1 ? "s" : ""}…`); S.err = "";
  try {
    let v = S.view;
    while (d) { v = await api.post(`/sounds/${S.cur}/${d < 0 ? "undo" : "redo"}`); d += d < 0 ? 1 : -1; }
    S.last = k ? `Jumped to step ${k}: ${v.history[k - 1].label}` : "Back to the original audio";
    setView(v);
  } catch (e) { showErr(e); } finally { setBusy(false); }
}

// ---------------------------------------------------------------- the rack: a chain of effects, heard before it is applied
function saveRack() { LS.set("vf.sound.rack", S.rack); }
function rackChanged(heavy = true) { saveRack(); if (heavy) renderRack(); else renderRackAct(); if (PV.on) pvRender(); }
function addStep(id, params) {
  if (!S.fx[id]) return;
  S.rack.push({ id, on: true, params: { ...defaults(id), ...(params || {}) } }); S.rsel = S.rack.length - 1;
  rackChanged();
}
function renderRack() {
  const el = $("#sd-rack"); if (!el) return;
  const box = S.fsel && S.sel ? `<div class="rk-box"><div><b>Box</b> ${fHz(S.fsel[0])}–${fHz(S.fsel[1])} · ${fmtT(S.sel[0], 2)}–${fmtT(S.sel[1], 2)}</div>
      <div class="rk-boxb"><button class="btn xs" data-bx="-12">Turn down 12 dB</button><button class="btn xs" data-bx="-60">Remove</button><button class="btn xs ghost" data-bx="keep">Keep only this</button><button class="btn xs ghost" data-bx="rack" title="Add a Band gain step with this band to the rack">${icon("plus")} Rack</button></div></div>` : "";
  const rows = S.rack.map((st, i) => {
    const d = S.fx[st.id] || { name: st.id, params: [] }, open = i === S.rsel;
    return `<div class="rk-i ${st.on ? "" : "off"} ${open ? "open" : ""}" data-ri="${i}">
      <div class="rk-h"><button class="iconbtn rk-pw ${st.on ? "on" : ""}" data-pw="${i}" title="${st.on ? "On: click to bypass" : "Bypassed: click to switch on"}">${I.power}</button>
        <span class="rk-n">${i + 1}</span><span class="rk-nm">${esc(SHORT[st.id] || d.name)}</span><span class="rk-sum" title="${esc(summary(st))}">${esc(summary(st))}</span>
        <button class="iconbtn" data-up="${i}" title="Move up" ${i ? "" : "disabled"}>${I.upk}</button><button class="iconbtn" data-dn="${i}" title="Move down" ${i < S.rack.length - 1 ? "" : "disabled"}>${I.dnk}</button>
        <button class="iconbtn" data-rm="${i}" title="Remove">${icon("x")}</button></div>
      ${open ? `<div class="rk-p fields">${(d.params || []).map((p) => { const v = st.params[p.k]; return `<div class="fld"><label for="rkp-${p.k}">${esc(p.label)}</label><input type="range" id="rkp-${p.k}" data-pk="${p.k}" min="${HZ.has(p.k) ? 0 : p.min}" max="${HZ.has(p.k) ? 1000 : p.max}" step="${HZ.has(p.k) ? 1 : stepOf(p)}" value="${toSl(p, v)}"><span class="v" id="rkv-${p.k}">${esc(pval(p, v))}</span></div>`; }).join("") || `<div class="hint">No settings. It runs as it is.</div>`}
        <div class="rk-pa"><button class="btn ghost xs" data-def="${i}">Defaults</button><button class="btn ghost xs" data-one="${i}" title="Apply only this effect, as one edit">Apply only this</button></div></div>` : ""}</div>`;
  }).join("");
  const known = new Set(GROUPS.flatMap((g) => g[1])), other = Object.keys(S.fx).filter((k) => !known.has(k));
  const groups = [...GROUPS.map(([n, ks]) => [n, ks.filter((k) => S.fx[k])]), ["Other", other]].filter((g) => g[1].length);
  el.innerHTML = `${box}<div class="rk-list">${rows || `<div class="rk-empty">The rack is empty. Add effects below, or choose a preset. Press <b>Preview</b> to hear them on the card before you apply them.</div>`}</div>
    <div class="rk-add"><div class="rk-addh"><span>Add an effect</span><button class="btn ghost xs" id="rk-presets">Presets ▾</button></div>
    ${groups.map(([n, ks]) => `<div class="snd-g">${esc(n)}</div><div class="snd-fxg">${ks.map((k) => `<button class="snd-fxb" data-fx="${k}" title="${esc(S.fx[k].name)}: add to the rack">${esc(SHORT[k] || S.fx[k].name)}</button>`).join("")}</div>`).join("")}</div>`;
  $$("#sd-rack [data-fx]").forEach((b) => b.onclick = () => addStep(b.dataset.fx));
  $$("#sd-rack [data-ri] .rk-h").forEach((h) => h.onclick = (e) => { if (e.target.closest("button")) return; const i = +h.parentElement.dataset.ri; S.rsel = S.rsel === i ? -1 : i; renderRack(); });
  $$("#sd-rack [data-pw]").forEach((b) => b.onclick = () => { const s = S.rack[+b.dataset.pw]; s.on = !s.on; rackChanged(); });
  $$("#sd-rack [data-up]").forEach((b) => b.onclick = () => { const i = +b.dataset.up; [S.rack[i - 1], S.rack[i]] = [S.rack[i], S.rack[i - 1]]; S.rsel = i - 1; rackChanged(); });
  $$("#sd-rack [data-dn]").forEach((b) => b.onclick = () => { const i = +b.dataset.dn; [S.rack[i + 1], S.rack[i]] = [S.rack[i], S.rack[i + 1]]; S.rsel = i + 1; rackChanged(); });
  $$("#sd-rack [data-rm]").forEach((b) => b.onclick = () => { S.rack.splice(+b.dataset.rm, 1); S.rsel = Math.min(S.rsel, S.rack.length - 1); rackChanged(); });
  $$("#sd-rack [data-def]").forEach((b) => b.onclick = () => { const s = S.rack[+b.dataset.def]; s.params = defaults(s.id); rackChanged(); });
  $$("#sd-rack [data-one]").forEach((b) => b.onclick = () => applyChain([{ ...S.rack[+b.dataset.one], on: true }]));
  $$("#sd-rack [data-pk]").forEach((inp) => inp.oninput = () => {
    const st = S.rack[S.rsel], p = (S.fx[st.id].params || []).find((q) => q.k === inp.dataset.pk), v = fromSl(p, +inp.value);
    st.params[p.k] = v; $("#rkv-" + p.k).textContent = pval(p, v);
    const sm = inp.closest(".rk-i").querySelector(".rk-sum"); sm.textContent = summary(st); sm.title = summary(st);
    saveRack(); if (PV.on) pvRender(true);
  });
  $$("#sd-rack [data-bx]").forEach((b) => b.onclick = () => boxEdit(b.dataset.bx));
  const pr = $("#rk-presets"); if (pr) pr.onclick = presetMenu;
  $("#sd-tabmeta").textContent = S.tab === "fx" ? (S.rack.length ? `${S.rack.filter((s) => s.on).length} of ${S.rack.length} on` : `${Object.keys(S.fx).length} effects`) : $("#sd-tabmeta").textContent;
  renderRackAct();
}
function boxEdit(how) {
  if (!S.fsel || !S.sel) return;
  const band = { id: "band", on: true, params: { lo: Math.round(S.fsel[0]), hi: Math.round(S.fsel[1]), db: how === "keep" ? -60 : how === "rack" ? -24 : +how, outside: how === "keep" ? 1 : 0 } };
  if (how === "rack") { S.rack.push(band); S.rsel = S.rack.length - 1; rackChanged(); return; }
  applyChain([band]);
}
function presetMenu(e) {
  const mine = LS.get("vf.sound.presets", []);
  const load = (c) => { S.rack = c.map((s) => ({ id: s.id, on: s.on !== false, params: { ...defaults(s.id), ...(s.params || {}) } })).filter((s) => S.fx[s.id]); S.rsel = 0; rackChanged(); };
  menu(e.currentTarget, [...PRESETS.map((p) => ({ icon: "bolt", label: p.name, sub: p.sub, run: () => load(p.chain) })),
    ...(mine.length ? ["-", ...mine.map((p) => ({ icon: "sound", label: p.name, sub: p.chain.map((s) => SHORT[s.id] || s.id).join(" → "), run: () => load(p.chain) }))] : []),
    "-", { icon: "plus", label: "Save the rack as a preset…", run: () => { if (!S.rack.length) return; const n = prompt("Name for this preset:", "My chain"); if (!n) return; LS.set("vf.sound.presets", mine.filter((p) => p.name !== n).concat([{ name: n, chain: S.rack }])); toast(`Saved “${n}”.`, "good"); } },
    ...(mine.length ? [{ icon: "trash", label: "Forget my presets", run: () => LS.set("vf.sound.presets", []) }] : []),
    { icon: "x", label: "Clear the rack", run: () => { S.rack = []; rackChanged(); } }]);
}
function renderRackAct() {
  const el = $("#sd-rackact"); if (!el) return;
  const on = S.rack.filter((s) => s.on), n = S.picks.size, dis = !S.cur || !S.view || S.busy || !on.length;
  const tgt = S.sel ? `to the selection` : `to the whole clip`;
  const pvm = PV.meta;
  el.innerHTML = `<div class="snd-actrow"><button class="btn ${PV.on ? "" : "ghost"} sm" id="rk-pv" ${!S.view || !S.pcm ? "disabled" : ""} title="Shift+Space">${I.ear} ${PV.on ? "Stop preview" : "Preview"}</button>
      <button class="btn ghost sm ${PV.on && PV.bypass ? "on" : ""}" id="rk-ab" ${PV.on ? "" : "disabled"} title="B: switch between the rack and the dry sound, without a gap">A/B ${PV.on ? (PV.bypass ? "· dry" : "· rack") : ""}</button>
      <label class="rk-match" title="During A/B, play the dry sound at the loudness of the processed one, so you compare the sound and not the level"><input type="checkbox" id="rk-match" ${PV.match ? "checked" : ""}> match loudness</label></div>
    <button class="btn block" id="rk-apply" ${dis ? "disabled" : ""} data-primary>${icon("bolt")} Apply ${on.length > 1 ? `${on.length} effects` : on.length ? esc(SHORT[on[0].id] || on[0].id) : "the rack"} ${tgt}</button>
    <div class="snd-actrow">${S.sel ? `<button class="btn ghost xs" id="rk-all" ${dis ? "disabled" : ""}>Whole clip instead</button>` : ""}
      <button class="btn ghost xs" id="rk-batch" ${!n || !on.length || S.batching ? "disabled" : ""} title="Run the rack on every ticked clip's current version; the results come back as one zip">${S.batching ? "Batch running…" : n ? `Batch: ${n} ticked clip${n > 1 ? "s" : ""} → zip` : "Batch: tick clips first"}</button></div>
    <div class="hint" id="rk-hint">${PV.on ? pvHint() : pvm ? esc(pvm.last || "") : S.sel ? `${fmtT(S.sel[0])} – ${fmtT(S.sel[1])} · ${(S.sel[1] - S.sel[0]).toFixed(2)} s selected` : "Drag across the track to work on a part."}</div>`;
  $("#rk-pv").onclick = () => (PV.on ? pvStop() : pvStart());
  $("#rk-ab").onclick = () => pvBypass(!PV.bypass);
  $("#rk-match").onchange = (e) => { PV.match = e.target.checked; pvGains(); renderRackAct(); };
  $("#rk-apply").onclick = () => applyChain(S.rack);
  if ($("#rk-all")) $("#rk-all").onclick = () => applyChain(S.rack, true);
  $("#rk-batch").onclick = runBatch;
}
async function runBatch() {
  const ids = [...S.picks], chain = S.rack.filter((s) => s.on).map((s) => ({ id: s.id, params: s.params }));
  if (!ids.length || !chain.length || S.batching) return;
  S.batching = true; renderRackAct();
  try {
    const j = await api.post("/sounds/batch", { ids, chain });
    const r = await watchJob(j, (x) => { const h = $("#rk-hint"); if (h) h.textContent = `Batch ${Math.round((x.progress || 0) * 100)}% · ${x.message || "working"}`; });
    await save("/api/sounds/download/" + r.zip, r.zip);
    toast(`Processed ${r.count} clip${r.count === 1 ? "" : "s"} on the card.`, "good");
  } catch (e) { showErr(e); } finally { S.batching = false; renderRackAct(); }
}

// ---------------------------------------------------------------- preview: the card renders the loop window, the browser loops it
// dry = the current version's samples; wet = the card's result for the same stretch. Both play in step, and A/B is
// a 15 ms crossfade between them. Each change of the rack renders again (one request at a time; the newest wins).
const PV = { on: false, a: null, b: null, dry: null, wet: null, src: [], gD: null, gW: null, t0: 0, off: 0, seq: 0, busy: false, again: false,
  bypass: false, match: true, meta: null, Idry: null, Iwet: null, ctl: null };
function pvWindow() {
  const D = dur();
  if (S.sel && S.sel[1] - S.sel[0] >= 0.05) return [S.sel[0], Math.min(S.sel[1], S.sel[0] + 30)];
  let a = S.head; if (a > D - 10) a = Math.max(0, D - 10);
  return [a, Math.min(D, a + 10)];
}
function slice(a, b) {
  const { sr, ch } = S.pcm, i = Math.floor(a * sr), j = Math.min(ch[0].length, Math.floor(b * sr)), n = Math.max(1, j - i);
  const buf = ctx().createBuffer(2, n, sr);
  buf.copyToChannel(ch[0].subarray(i, i + n), 0); buf.copyToChannel(ch[1].subarray(i, i + n), 1);
  return buf;
}
const integ = (buf) => readSteps(kSteps([buf.getChannelData(0), buf.getChannelData(1)], buf.sampleRate)).integrated;
async function pvStart() {
  if (!S.view || !S.pcm) return;
  if (!audio.paused) { audio.pause(); cancelAnimationFrame(raf); }
  const c = ctx(); if (c.state === "suspended") await c.resume();
  [PV.a, PV.b] = pvWindow();
  PV.dry = slice(PV.a, PV.b); PV.wet = null; PV.Idry = integ(PV.dry); PV.Iwet = null; PV.on = true; PV.bypass = false;
  if (!PV.gD) { PV.gD = c.createGain(); PV.gW = c.createGain(); PV.gD.connect(c.destination); PV.gW.connect(c.destination); }
  pvPlay(0); pvRender(); transport(); renderRackAct();
  cancelAnimationFrame(raf); raf = requestAnimationFrame(pvTick);
}
function pvRestart() {
  const [a, b] = pvWindow(); if (Math.abs(a - PV.a) < 1e-4 && Math.abs(b - PV.b) < 1e-4) return;
  PV.a = a; PV.b = b; PV.dry = slice(a, b); PV.wet = null; PV.Idry = integ(PV.dry); PV.Iwet = null; pvPlay(0); pvRender();
}
function pvStop() {
  if (!PV.on) return;
  PV.on = false; PV.seq++; if (PV.ctl) PV.ctl.abort();
  PV.src.forEach((s) => { try { s.stop(); } catch (e) { /* already stopped */ } }); PV.src = [];
  cancelAnimationFrame(raf); S.head = PV.a != null ? PV.a : S.head;
  transport(); renderRackAct(); drawOverlay();
}
function mkSrc(buf, gain, at, off) { const s = ctx().createBufferSource(); s.buffer = buf; s.loop = true; s.connect(gain); s.start(at, off % buf.duration); return s; }
function pvPos() { const el = ctx().currentTime - PV.t0 + PV.off; return PV.dry ? (el % PV.dry.duration) / PV.dry.duration : 0; }
function pvPlay(frac) {
  PV.src.forEach((s) => { try { s.stop(); } catch (e) { /* stopped */ } });
  const at = ctx().currentTime + 0.03;
  PV.t0 = at; PV.off = frac * PV.dry.duration;
  PV.src = [mkSrc(PV.dry, PV.gD, at, PV.off)];
  if (PV.wet) PV.src.push(mkSrc(PV.wet, PV.gW, at, frac * PV.wet.duration));
  pvGains(true);
}
function pvGains(now) {
  if (!PV.gD) return;
  const t = ctx().currentTime, wetOn = !!PV.wet && !PV.bypass;
  const m = PV.match && PV.Idry != null && PV.Iwet != null ? Math.pow(10, (PV.Iwet - PV.Idry) / 20) : 1;
  const gd = wetOn ? 0 : (PV.wet ? m : 1), gw = wetOn ? 1 : 0;
  if (now) { PV.gD.gain.setValueAtTime(gd, t); PV.gW.gain.setValueAtTime(gw, t); }
  else { PV.gD.gain.setTargetAtTime(gd, t, 0.005); PV.gW.gain.setTargetAtTime(gw, t, 0.005); }
}
function pvBypass(on) { if (!PV.on) return; PV.bypass = on; pvGains(); transport(); renderRackAct(); }
let pvTimer = 0;
function pvRender(soon) {
  if (!PV.on) return;
  if (soon) { clearTimeout(pvTimer); pvTimer = setTimeout(() => pvRender(), 90); return; }
  if (PV.busy) { PV.again = true; return; }
  const chain = S.rack.filter((s) => s.on).map((s) => ({ id: s.id, params: s.params }));
  const seq = ++PV.seq;
  if (!chain.length) { PV.wet = null; PV.meta = { last: "The rack is empty or bypassed: you hear the dry sound." }; pvSwap(null); renderRackAct(); return; }
  PV.busy = true; PV.ctl = new AbortController(); PV.state = "rendering"; renderHint();
  const t = performance.now();
  v1("sound.preview", { sound: S.cur, chain, start: +PV.a.toFixed(4), end: +PV.b.toFixed(4) }, { blob: true, signal: PV.ctl.signal })
    .then(async ({ data, meta }) => {
      const buf = await ctx().decodeAudioData(data);
      if (seq !== PV.seq || !PV.on) return;
      PV.meta = { ...meta, round: performance.now() - t };
      PV.Iwet = integ(buf); pvSwap(buf); PV.state = "";
    })
    .catch((e) => { if (e.name !== "AbortError" && PV.on) { PV.state = "error"; PV.meta = { last: errMsg(e) }; toast("Preview: " + errMsg(e), "bad", 5000); } })
    .finally(() => { PV.busy = false; renderRackAct(); if (PV.again && PV.on) { PV.again = false; pvRender(); } });
}
function pvSwap(buf) {                                    // a new wet buffer joins at the current position
  const frac = pvPos(), at = ctx().currentTime + 0.02, old = PV.src.slice(1), oldG = PV.gW;
  PV.wet = buf;
  const g = ctx().createGain(); g.connect(ctx().destination); g.gain.setValueAtTime(0, at);
  PV.gW = g;
  PV.src = [PV.src[0]];
  if (buf) PV.src.push(mkSrc(buf, g, at, frac * buf.duration));
  pvGains();
  if (oldG) { oldG.gain.setTargetAtTime(0, at, 0.008); setTimeout(() => { old.forEach((s) => { try { s.stop(); } catch (e) { /* stopped */ } }); oldG.disconnect(); }, 120); }
}
function pvHint() {
  const m = PV.meta || {};
  if (PV.state === "rendering") return `The card renders ${fmtT(PV.a, 1)}–${fmtT(PV.b, 1)}…${m.ms ? "" : " (the first use of an effect compiles its kernels: a few seconds)"}`;
  if (!PV.wet) return esc(m.last || "Dry sound.");
  const lv = PV.Iwet != null && PV.Idry != null ? ` · rack ${PV.Iwet.toFixed(1)} vs dry ${PV.Idry.toFixed(1)} LUFS${PV.match ? " (matched in A/B)" : ""}` : "";
  return `Card: ${fmt.ms(m.ms)} for ${(m.seconds || 0).toFixed(1)} s (${m.realtime_x}× real time), ${fmt.ms(m.round)} round trip${lv}${m.note ? ". " + esc(m.note) : ""}`;
}
function renderHint() { const h = $("#rk-hint"); if (h) h.innerHTML = pvHint(); }
function pvTick() {
  if (!PV.on) return;
  S.head = PV.a + pvPos() * (PV.b - PV.a);
  follow(S.head); drawOverlay(); renderLive();
  raf = requestAnimationFrame(pvTick);
}

// ---------------------------------------------------------------- loudness meter
async function loadLoudness() {
  const id = S.cur, ver = S.view && S.view.cur;
  try {
    const m = await v1("sound.loudness", { sound: id, steps: true });
    if (S.cur !== id || !S.view || S.view.cur !== ver) return;
    S.loud = m; renderMeter(); selLoudness();
  } catch (e) { S.loud = { error: errMsg(e) }; renderMeter(); }
}
let selTimer = 0;
function selLoudness() {                                   // readings of the selection: at once from the steps, true peak from the server
  S.selLoud = null;
  if (S.sel && S.loud && S.loud.steps && S.sel[1] - S.sel[0] >= 0.4) {
    const a = Math.floor(S.sel[0] / 0.1), b = Math.min(S.loud.steps.length, Math.ceil(S.sel[1] / 0.1));
    S.selLoud = { ...readSteps(S.loud.steps, a, b), ...peakRms(S.sel[0], S.sel[1]) };
    clearTimeout(selTimer);
    const sel = S.sel.slice(), id = S.cur;
    selTimer = setTimeout(() => v1("sound.loudness", { sound: id, start: +sel[0].toFixed(3), end: +sel[1].toFixed(3) })
      .then((m) => { if (S.cur === id && S.sel && S.sel[0] === sel[0] && S.sel[1] === sel[1]) { S.selLoud = m; renderMeter(); } }).catch(() => {}), 350);
  }
  renderMeter();
}
function peakRms(a, b) {
  if (!S.pcm) return {};
  const { sr, ch } = S.pcm, i = Math.floor(a * sr), j = Math.min(ch[0].length, Math.floor(b * sr));
  let pk = 0, ss = 0;
  for (const d of ch) for (let k = i; k < j; k++) { const v = d[k], u = v < 0 ? -v : v; if (u > pk) pk = u; ss += v * v; }
  const db = (v) => v > 0 ? 20 * Math.log10(v) : null;
  return { sample_peak_db: db(pk), rms_db: db(Math.sqrt(ss / Math.max(1, 2 * (j - i)))) };
}
function renderMeter() {
  const el = $("#sd-lm"); if (!el) return;
  const m = S.selLoud || S.loud;
  if (!S.view) { el.innerHTML = `<div class="hint snd-lmh">Load a clip to measure it.</div>`; return; }
  if (!m) { el.innerHTML = `<div class="hint snd-lmh">Measuring the loudness…</div>`; return; }
  if (m.error) { el.innerHTML = `<div class="hint snd-lmh">${esc(m.error)}</div>`; return; }
  $("#sd-lmeta").textContent = S.selLoud ? `selection · EBU R128` : `whole clip · EBU R128`;
  const W = S.loud && S.loud.targets ? S.loud.targets : [];
  const cell = (k, v, tip, cls = "") => `<div class="lm-c ${cls}" title="${esc(tip)}"><span>${k}</span><b>${v}</b></div>`;
  const tp = m.true_peak_db;
  el.innerHTML = `<div class="lm-read">
      ${cell("Integrated", fL(m.integrated), "Gated loudness of the whole range (ITU-R BS.1770-4)", "big")}
      ${cell("Short-term max", fL(m.short_term_max), "Loudest 3 s")}${cell("Momentary max", fL(m.momentary_max), "Loudest 0.4 s")}
      ${cell("Range", m.lra == null ? "—" : m.lra.toFixed(1) + " LU", "Loudness range (EBU Tech 3342): how much the level moves")}
      ${cell("True peak", tp == null ? (S.selLoud ? "…" : "—") : tp.toFixed(1) + " dBTP", "Peak between the samples (4× oversampled). Keep it at or under −1 dBTP for streaming", tp != null && tp > -1 ? "warn" : "")}
      ${cell("Peak / RMS", `${m.sample_peak_db == null ? "—" : m.sample_peak_db.toFixed(1)} / ${m.rms_db == null ? "—" : m.rms_db.toFixed(1)} dB`, "Sample peak and RMS level, dBFS")}</div>
    <div class="lm-live"><div class="lm-bars"><i id="lm-l"></i><i id="lm-r"></i></div><div class="lm-now" id="lm-now"><span>M —</span><span>S —</span></div></div>
    <div class="lm-tg">${W.map((t) => `<button class="btn ghost xs" data-tg="${t.lufs}" data-cl="${t.ceiling_dbtp}" title="${t.gain_db == null ? "silent" : `needs ${t.gain_db > 0 ? "+" : ""}${t.gain_db} dB${t.peak_limited ? "; the peak limit stops it short of the target" : ""}`}. Click to add a Loudness step to the rack">${esc(t.name.replace(" (EBU R128)", ""))} ${t.lufs}${t.gain_db == null ? "" : ` <em>${t.gain_db > 0 ? "+" : ""}${t.gain_db.toFixed(1)}</em>`}</button>`).join("")}</div>`;
  $$("#sd-lm [data-tg]").forEach((b) => b.onclick = () => { addStep("loudness", { target: +b.dataset.tg, ceiling: +b.dataset.cl }); setTab("fx"); });
  renderLive();
}
function renderLive() {
  const now = $("#lm-now"); if (!now || !S.pcm) return;
  const { sr, ch } = S.pcm, playing = PV.on || (audio && !audio.paused);
  let src = ch, at = S.head, base = 0;
  if (PV.on) { const b = PV.wet && !PV.bypass ? PV.wet : PV.dry; src = [b.getChannelData(0), b.getChannelData(1)]; base = PV.a; at = pvPos() * b.duration; }
  else at = S.head - base;
  const i = Math.floor(at * sr), n = Math.round(0.05 * sr), lv = [];
  for (const d of src) { let pk = 0; for (let k = Math.max(0, i - n); k < Math.min(d.length, i); k++) { const v = Math.abs(d[k]); if (v > pk) pk = v; } lv.push(pk); }
  const pos = (v) => v > 0 ? Math.max(0, Math.min(1, (20 * Math.log10(v) + 60) / 60)) : 0;
  $("#lm-l").style.setProperty("--v", playing ? pos(lv[0]) : 0); $("#lm-r").style.setProperty("--v", playing ? pos(lv[1]) : 0);
  $("#lm-l").classList.toggle("clip", lv[0] >= 0.999); $("#lm-r").classList.toggle("clip", lv[1] >= 0.999);
  let mm = null, ss = null;
  if (!PV.on && S.loud && S.loud.steps) ({ m: mm, s: ss } = liveAt(S.loud.steps, Math.floor(S.head / 0.1)));
  else if (PV.on) {
    const b = PV.wet && !PV.bypass ? PV.wet : PV.dry;
    if (!b._steps) b._steps = kSteps([b.getChannelData(0), b.getChannelData(1)], b.sampleRate);
    ({ m: mm, s: ss } = liveAt(b._steps, Math.floor(at / 0.1)));
  }
  now.innerHTML = `<span title="Momentary loudness (0.4 s) at the playhead">M ${mm == null ? "—" : mm.toFixed(1)}</span><span title="Short-term loudness (3 s) at the playhead">S ${ss == null ? "—" : ss.toFixed(1)}</span>`;
}

// ---------------------------------------------------------------- history
function renderHistory() {
  const v = S.view, el = $("#sd-hist"); if (!el) return;
  if (!v) { el.innerHTML = `<div class="empty">No clip loaded.</div>`; $("#sd-histmeta").textContent = ""; return; }
  const rows = [{ label: "Original audio", ms: null }, ...v.history];
  el.innerHTML = rows.map((h, i) => {
    const reuse = i && (h.chain || S.fx[h.fx]);
    return `<div class="snd-h ${i === v.cur ? "on" : ""} ${i > v.cur ? "fut" : ""}" data-k="${i}"
      title="${i === v.cur ? "Current state" : i < v.cur ? "Click to undo back to here" : "Click to redo up to here"}"><span class="n">${i}</span><span class="l">${esc(h.label)}</span>${h.ms != null ? `<span class="ms">${fmt.ms(h.ms)}</span>` : ""}${reuse ? `<button class="iconbtn snd-hre" data-re="${i}" title="Put these settings in the rack">${I.copy}</button>` : `<span></span>`}</div>`;
  }).join("");
  $$("#sd-hist [data-k]").forEach((r) => r.onclick = (e) => { if (e.target.closest("[data-re]")) return; goTo(+r.dataset.k); });
  $$("#sd-hist [data-re]").forEach((b) => b.onclick = () => {
    const h = v.history[+b.dataset.re - 1], c = h.chain || [{ id: h.fx, params: h.params }];
    S.rack = c.map((s) => ({ id: s.id, on: true, params: { ...defaults(s.id), ...(s.params || {}) } })); S.rsel = 0; rackChanged(); setTab("fx");
    toast("The rack now holds the settings of that edit.", "good");
  });
  $("#sd-histmeta").textContent = v.history.length ? `step ${v.cur} of ${v.history.length}` : "no edits yet";
  const on = el.querySelector(".on"); if (on) on.scrollIntoView({ block: "nearest" });
}

// ---------------------------------------------------------------- tabs
function setTab(p) {
  if (p === "fx" || p === "find" || p === "marks") S.tab = p; else S.tab = "fx";
  $$(".snd-tabs [data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === S.tab));
  $$(".snd-side [data-body]").forEach((b) => { b.hidden = b.dataset.body !== S.tab; });
  if (S.tab === "fx") renderRack(); else if (S.tab === "marks") renderMarkers(); else renderFind();
  drawOverlay();
}

// ---------------------------------------------------------------- markers (Audacity label track)
async function saveMarkers() {
  try { S.markers = await v1("sound.markers.set", { sound: S.cur, markers: S.markers }); } catch (e) { showErr(e); }
  renderMarkers(); drawOverlay();
}
function addMarker() {
  if (!S.view) return;
  S.markers.push({ t: +S.head.toFixed(4), end: null, label: `Marker ${S.markers.length + 1}` });
  saveMarkers(); S.last = `Marker at ${fmtT(S.head)}`; status();
}
function labelSel() {
  if (!S.view || !S.sel) { toast("Select a stretch first, then label it (Ctrl+B).", ""); return; }
  const n = prompt(`Label for ${fmtT(S.sel[0])}–${fmtT(S.sel[1])}:`, `Region ${S.markers.filter((m) => m.end != null).length + 1}`);
  if (n === null) return;
  S.markers.push({ t: +S.sel[0].toFixed(4), end: +S.sel[1].toFixed(4), label: n });
  saveMarkers(); setTab("marks");
}
function renderMarkers() {
  const el = $("#sd-mks"); if (!el) return;
  const ms = S.markers;
  el.innerHTML = `<div class="mk-tools"><button class="btn xs" id="mk-add">${I.flag} At the playhead <kbd>M</kbd></button><button class="btn xs ghost" id="mk-lab" ${S.sel ? "" : "disabled"}>Label the selection <kbd>Ctrl+B</kbd></button>
      <span class="sp"></span><button class="btn xs ghost" id="mk-io">Import / export ▾</button></div>
    <div class="mk-list">${ms.length ? ms.map((m, i) => `<div class="mk-r" data-mi="${i}"><button class="iconbtn" data-mp="${i}" title="${m.end != null ? "Play the region" : "Go there"}">${icon("play")}</button>
        <span class="mono mk-t">${fmtT(m.t, 2)}${m.end != null ? `<br><span class="dim">–${fmtT(m.end, 2)}</span>` : ""}</span>
        <input class="in sm" data-ml="${i}" value="${esc(m.label)}" placeholder="label">
        <button class="iconbtn" data-md="${i}" title="Remove">${icon("x")}</button></div>`).join("")
      : `<div class="empty">No markers yet. Press <kbd>M</kbd> while it plays to drop one, or select a stretch and press <kbd>Ctrl+B</kbd> to label it. Markers export as an Audacity label file.</div>`}</div>`;
  $("#mk-add").onclick = addMarker; $("#mk-lab").onclick = labelSel;
  $("#mk-io").onclick = (e) => menu(e.currentTarget, [
    { icon: "down", label: "Export Audacity labels (.txt)", sub: "start, end, label; tab-separated", run: () => saveBlob(new Blob([ms.map((m) => `${m.t.toFixed(6)}\t${(m.end != null ? m.end : m.t).toFixed(6)}\t${m.label}`).join("\n") + "\n"], { type: "text/plain" }), "labels.txt") },
    { icon: "down", label: "Export CSV", run: () => saveBlob(new Blob(["start s,end s,label\n" + ms.map((m) => `${m.t},${m.end != null ? m.end : ""},"${String(m.label).replace(/"/g, '""')}"`).join("\n") + "\n"], { type: "text/csv" }), "markers.csv") },
    { icon: "upload", label: "Import Audacity labels…", sub: "adds them to these markers", run: importLabels },
    ...(S.found && S.found.events.length ? [{ icon: "plus", label: `Found sounds → markers (${S.found.events.length})`, run: () => { S.markers.push(...S.found.events.map((x) => ({ t: x.a, end: x.b, label: x.label }))); saveMarkers(); } }] : []),
    ...(ms.length ? ["-", { icon: "trash", label: "Remove every marker", run: () => { if (confirm("Remove every marker of this clip?")) { S.markers = []; saveMarkers(); } } }] : [])]);
  $$("#sd-mks [data-mp]").forEach((b) => b.onclick = () => { const m = ms[+b.dataset.mp]; if (m.end != null) playRange({ a: m.t, b: m.end }); else { seek(m.t); if (m.t < S.t0 || m.t > S.t0 + S.span) setWin(m.t - S.span / 2, S.span); } });
  $$("#sd-mks [data-ml]").forEach((inp) => inp.onchange = () => { ms[+inp.dataset.ml].label = inp.value; saveMarkers(); });
  $$("#sd-mks [data-md]").forEach((b) => b.onclick = () => { ms.splice(+b.dataset.md, 1); saveMarkers(); });
  if (S.tab === "marks") $("#sd-tabmeta").textContent = ms.length ? `${ms.length} marker${ms.length > 1 ? "s" : ""}` : "";
}
function importLabels() {
  const inp = document.createElement("input"); inp.type = "file"; inp.accept = ".txt,.tsv,text/plain";
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    try { const add = await v1("sound.markers.set", { sound: S.cur, tsv: await f.text() }); S.markers = (await v1("sound.markers.set", { sound: S.cur, markers: S.markers.concat(add) })); renderMarkers(); drawOverlay(); toast(`Imported ${add.length} labels.`, "good"); }
    catch (e) { showErr(e); }
  };
  inp.click();
}
function nextEvent(dir) {
  const ev = S.found && S.found.events.length ? S.found.events.map((e) => ({ a: e.a, b: e.b, e })) : S.markers.map((m) => ({ a: m.t, b: m.end, m }));
  if (!ev.length) return;
  const cur = S.head + dir * 0.001, list = ev.slice().sort((x, y) => x.a - y.a);
  const hit = dir > 0 ? list.find((x) => x.a > cur + 0.01) || list[0] : list.slice().reverse().find((x) => x.a < cur - 0.01) || list[list.length - 1];
  if (hit.e) playRange(hit.e); else { seek(hit.a); if (hit.a < S.t0 || hit.a > S.t0 + S.span) setWin(hit.a - S.span / 2, S.span); }
}

// ---------------------------------------------------------------- the sound finder
const colorOf = (label) => { const ls = [...new Set(S.marks.filter((m) => m.label !== "nothing").map((m) => m.label).concat(S.found ? S.found.labels : []))].sort(); return label === "nothing" ? "#8a8b93" : PALETTE[(ls.indexOf(label) + 1) % PALETTE.length]; };
let sfl = null;                     // the sound finder's Train -> Evaluate -> Infer flow
function buildFind() {
  sfl = learnFlow($("#sf-lf"), { key: "sf", compact: true, start: "train",
    steps: { train: { hint: "Mark examples" }, evaluate: { hint: "Hidden-mark check" }, infer: { hint: "Find them" } } });
  sfl.body("train").innerHTML = `<div class="sf-row"><input class="in sm" id="sf-label" placeholder="name the sound, e.g. cough" autocomplete="off"><button class="btn sm" id="sf-mark" disabled>Mark selection</button></div>
    <div class="sf-row"><button class="btn ghost xs" id="sf-not" disabled title="Mark the selection as an example of what is NOT the sound (label: nothing)">Mark as “not this”</button></div>
    <div class="hint" id="sf-hint">Drag across the track to select one occurrence, name it, and press <b>Mark</b>. Two or three examples of each sound are sufficient. All that you do not mark counts as “nothing”; mark a look-alike as <b>not this</b> to teach the difference.</div>
    <div id="sf-marks"></div>
    <div class="fld sf-thr"><label for="sf-thr" title="How sure the layer must be before it calls a window a sound">Sensitivity</label><input type="range" id="sf-thr" min="0.15" max="0.9" step="0.05"><span class="v" id="sf-thrv"></span></div>`;
  sfl.actions("train", `<button class="btn" id="sf-go" data-primary disabled>${icon("eye")} Learn and find</button><span class="hint" id="sf-time"></span>`);
  sfl.body("evaluate").innerHTML = `<div id="sf-eval"><div class="empty">Mark examples and press Learn and find. Then this step shows how many hidden marks the detector finds again, against chance.</div></div>`;
  sfl.actions("evaluate", `<button class="btn" id="sf-toinf">See what it found ${icon("play")}</button>`);
  sfl.body("infer").innerHTML = `<div id="sf-res"><div class="empty">Nothing found yet.</div></div>
    <div class="sec-t" style="margin-top:12px">Find in another clip</div>
    <div class="sf-row"><select class="sel sm" id="sf-other"></select></div>
    <div class="hint">Uses the detector learned from the marks on this clip. The other clip opens with what it found.</div>`;
  sfl.actions("infer", `<button class="btn" id="sf-apply" data-primary disabled>${icon("play")} Run on that clip</button>`);
  $("#sf-toinf").onclick = () => sfl.go("infer");
  $("#sf-apply").onclick = applyOther;
}
function wireFind() {
  buildFind();
  $("#sf-label").oninput = () => { S.flabel = $("#sf-label").value.trim(); markBtn(); };
  $("#sf-label").onkeydown = (e) => { if (e.key === "Enter") addMark(); };
  $("#sf-mark").onclick = () => addMark();
  $("#sf-not").onclick = () => addMark("nothing");
  $("#sf-thr").value = S.thr; $("#sf-thrv").textContent = sens(S.thr);
  $("#sf-thr").oninput = () => { S.thr = +$("#sf-thr").value; $("#sf-thrv").textContent = sens(S.thr); drawOverlay(); };
  $("#sf-go").onclick = findAll;
  renderFind();
}
const sens = (t) => t <= 0.3 ? "loose" : t >= 0.7 ? "strict" : "balanced";
function markBtn() {
  const b = $("#sf-mark"); if (!b) return;
  b.disabled = !S.sel || !S.flabel || !S.cur;
  b.textContent = S.sel ? `Mark ${(S.sel[1] - S.sel[0]).toFixed(2)} s` : "Mark selection";
  $("#sf-not").disabled = !S.sel || !S.cur;
}
async function saveMarks() {
  try { S.marks = await api.put(`/sounds/${S.cur}/marks`, { marks: S.marks }); } catch (e) { showErr(e); }
  renderFind(); drawOverlay();
}
function addMark(label) {
  const lab = label || S.flabel;
  if (!S.sel || !lab || !S.cur) return;
  if (S.sel[1] - S.sel[0] > 8) { toast("Mark one occurrence at a time (8 s at most).", "bad"); return; }
  S.marks.push({ a: +S.sel[0].toFixed(4), b: +S.sel[1].toFixed(4), label: lab });
  setSel(null); saveMarks();
}
function renderFind() {
  const el = $("#sf-marks"); if (!el) return;
  const by = {}; S.marks.forEach((m, i) => (by[m.label] = by[m.label] || []).push([m, i]));
  el.innerHTML = Object.keys(by).length ? Object.entries(by).map(([l, ms]) => `<div class="sf-grp"><div class="sf-gh"><i style="background:${colorOf(l)}"></i><b>${esc(l === "nothing" ? "not this (nothing)" : l)}</b><span class="dim">${ms.length} marked${ms.length < 2 && l !== "nothing" ? " — mark another to measure recall" : ""}</span>${l === "nothing" ? "" : `<button class="btn ghost xs" data-use="${esc(l)}">use name</button>`}</div>
      ${ms.map(([m, i]) => `<div class="sf-m" data-mi="${i}"><button class="iconbtn" data-play="${i}" title="Play">${icon("play")}</button><span class="mono">${fmtT(m.a, 2)} – ${fmtT(m.b, 2)}</span><span class="dim mono">${(m.b - m.a).toFixed(2)} s</span><button class="iconbtn" data-rmm="${i}" title="Remove this mark">${icon("x")}</button></div>`).join("")}</div>`).join("")
    : `<div class="empty sf-empty">No marks on this clip yet.</div>`;
  $$("#sf-marks [data-play]").forEach((b) => b.onclick = () => playRange(S.marks[+b.dataset.play]));
  $$("#sf-marks [data-rmm]").forEach((b) => b.onclick = () => { S.marks.splice(+b.dataset.rmm, 1); saveMarks(); });
  $$("#sf-marks [data-use]").forEach((b) => b.onclick = () => { $("#sf-label").value = b.dataset.use; S.flabel = b.dataset.use; markBtn(); });
  $("#sf-go").disabled = !S.marks.some((m) => m.label !== "nothing") || S.finding || !S.cur;
  if (S.tab === "find") $("#sd-tabmeta").textContent = S.marks.length ? `${S.marks.length} marks · ${Object.keys(by).length} sounds` : "";
  markBtn(); renderFound(); findState();
}
function playRange(m) {
  pvStop();
  if (!audio.paused) audio.pause();
  if (m.a < S.t0 || m.b > S.t0 + S.span) setWin(m.a - S.span * 0.2, S.span);
  S.head = m.a; setSel([m.a, m.b]); playPause();
}
function findState() {
  if (!sfl) return;
  const r = S.found, n = S.marks.length, lbl = new Set(S.marks.map((m) => m.label)).size;
  sfl.state("train", r && !r.applied ? "done" : n ? "ready" : "todo", r && !r.applied ? `learned ${r.marks} marks` : n ? `${n} marks · ${lbl} sound${lbl > 1 ? "s" : ""}` : "mark 2-3 examples");
  const lo = r && r.lomo;
  sfl.state("evaluate", lo && lo.tested ? "done" : "off", lo && lo.tested ? `found ${lo.found} of ${lo.tested} hidden marks${lo.chance != null ? ` · chance ${lo.chance}` : ""}` : r ? "mark 2 of a sound to check" : "learn first");
  sfl.state("infer", r ? "done" : "off", r ? `${r.events.length} events${r.applied ? " (other clip's detector)" : ""}` : "learn first");
  const o = $("#sf-other");
  if (o) {
    const others = S.clips.filter((c) => c.id !== (S.model || S.cur));
    o.innerHTML = others.length ? others.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("") : `<option value="">no other clips: add one in the Clips pane</option>`;
    $("#sf-apply").disabled = !others.length || !(S.model || (r && !r.applied));
  }
}
async function findAll() {
  if (!S.cur || !S.marks.length || !sfl) return;
  S.finding = true; renderFind();
  const id = S.cur;
  const r = await sfl.run("train", async ({ signal, progress }) => {
    const j = await api.post(`/sounds/${id}/find`, { threshold: S.thr }, { signal });
    return watchJob({ id: j.job, state: "running" }, (x) => progress(x.progress, x.message && x.message !== "starting" ? x.message : "the card listens"), { signal });
  }, { label: "Learn the marks and listen" });
  S.finding = false;
  if (r && S.cur === id) {
    S.found = r; S.model = id;
    $("#sf-time").innerHTML = `${fmt.n(r.windows)} windows of ${r.window_s} s · <span class="timing">${fmt.ms(r.ms)}</span>`;
    renderEval(r); sfl.go(r.lomo && r.lomo.tested ? "evaluate" : "infer");
  }
  renderFind(); drawOverlay();
}
function renderEval(r) {
  const el = $("#sf-eval"); if (!el) return;
  const lo = r.lomo || {}, cmp = r.compare || {};
  if (!lo.tested) { el.innerHTML = `<div class="empty">${esc(r.check)}</div>`; return; }
  const ratio = (c) => c && c.tested ? c.found / c.tested : null;
  el.innerHTML = scoreCard({ value: `${lo.found}/${lo.tested}`, good: lo.found / lo.tested >= 0.67 && (lo.chance == null || lo.found > lo.chance + 1),
    label: "hidden marks found again: the check hid each mark in turn, and the detector learned from the others",
    bars: [{ t: "reservoir features", v: ratio(cmp.reservoir), kind: r.features === "reservoir" ? "model" : "base" },
      { t: "raw spectrogram (baseline)", v: ratio(cmp.raw), kind: r.features === "raw" ? "model" : "base" },
      ...(lo.chance != null ? [{ t: "same marks at random places (chance)", v: lo.chance / lo.tested, kind: "base", tip: `mean of ${lo.chance_runs} runs` }] : [])],
    verdict: `${r.false_alarms_per_min == null ? "" : `${r.false_alarms_per_min} false alarms per minute on unmarked audio. `}${r.features === "raw" ? "The raw spectrogram did better here, so the Lab uses it." : "The Lab uses the reservoir features."}`,
    note: esc(r.check) });
}
async function applyOther() {
  const tgt = $("#sf-other").value, model = S.model || S.cur; if (!tgt || !model) return;
  const r = await sfl.run("infer", async ({ signal, progress }) => {
    const j = await api.post(`/sounds/${tgt}/find/apply`, { model, threshold: S.thr }, { signal });
    return watchJob({ id: j.job, state: "running" }, (x) => progress(x.progress, "the card listens to the other clip"), { signal });
  }, { label: "Run the detector on the other clip" });
  if (!r) return;
  await pick(tgt);
  S.found = { ...r, applied: true, marks: 0 }; S.model = model;
  renderFind(); drawOverlay(); sfl.go("infer");
}
const rate = (e) => e.bg_rate == null ? "" : e.bg_hits === 0 ? `0 of ${fmt.n(e.bg_n)}` : `${fmt.n(e.bg_hits)} of ${fmt.n(e.bg_n)}`;
function renderFound() {
  const el = $("#sf-res"), r = S.found; if (!el) return;
  if (!r) { el.innerHTML = `<div class="empty">Nothing found yet. Mark examples in step 1 and press Learn and find.</div>`; return; }
  el.innerHTML = `<div class="sf-verdict"><b>${esc(r.sentence)}</b><span>${esc(r.check || "")}</span></div>
    <div class="sf-tools"><button class="btn ghost xs" id="sf-send">${icon("bolt")} Use these…</button><span class="hint">${r.events.length} events · N steps through them · ✓ and ✗ teach the next run</span></div>
    <div class="sf-list"><div class="sf-e sf-eh"><i></i><span>at</span><b>sound</b><span title="How often unmarked audio, scored by a detector that did not train on it, scores this high">background</span><span>score</span><span></span></div>
    ${r.events.map((e, i) => `<div class="sf-e ${e.marked ? "marked" : ""}" data-ei="${i}"><i style="background:${colorOf(e.label)}"></i><span class="mono">${fmtT(e.a, 2)}</span><b>${esc(e.label)}</b><span class="dim" title="${e.bg_rate == null ? "" : `${e.bg_hits} of ${e.bg_n} unmarked windows (scored by detectors that did not train on them) score this high`}">${e.marked ? "your mark" : esc(rate(e))}</span><span class="mono sf-c">${Math.round(Math.min(1, e.score) * 100)}%</span>
      <span class="sf-fb">${e.marked ? "" : `<button class="iconbtn" data-yes="${i}" title="Right: add it as a mark">${I.ok}</button><button class="iconbtn" data-no="${i}" title="Wrong: add it as “not this”">${icon("x")}</button>`}</span></div>`).join("")}</div>`;
  $$("#sf-res [data-ei]").forEach((d) => d.onclick = (ev) => { if (ev.target.closest("button")) return; playRange(r.events[+d.dataset.ei]); });
  $$("#sf-res [data-yes]").forEach((b) => b.onclick = () => feedback(r.events[+b.dataset.yes], true));
  $$("#sf-res [data-no]").forEach((b) => b.onclick = () => feedback(r.events[+b.dataset.no], false));
  $("#sf-send").onclick = (ev) => menu(ev.currentTarget, [
    { icon: "data", label: "Save as a table", sub: "an event log in the Data Desk: sound, start, end, score, background rate", run: eventsTable },
    { icon: "plus", label: "Make them markers", sub: "labelled regions; export as an Audacity label file", run: () => { S.markers.push(...foundOnly().map((x) => ({ t: x.a, end: x.b, label: x.label }))); saveMarkers(); setTab("marks"); } },
    { icon: "reservoir", label: "Teach the Reservoir Lab", sub: "your marks and the found sounds become a sound project", run: toReservoir },
    "-",
    { icon: "x", label: "Mute every found sound", sub: "one edit — undo brings them back", run: () => muteAll("mute") },
    { icon: "sound", label: "Turn them down 12 dB", sub: "one edit — undo brings them back", run: () => muteAll("duck") },
  ]);
}
function feedback(e, right) {
  S.marks.push({ a: e.a, b: Math.min(e.b, e.a + 8), label: right ? e.label : "nothing" });
  e.marked = true; saveMarks();
  toast(right ? `Added as a “${e.label}” mark. Press Learn and find to use it.` : "Added as “not this”. Press Learn and find to use it.", "good");
}
const foundOnly = () => (S.found ? S.found.events : []);
async function eventsTable() {
  try { const m = await api.post(`/sounds/${S.cur}/events/table`, { events: foundOnly() }); toast(`Saved ${m.rows} events as “${m.name}”`, "good"); }
  catch (e) { showErr(e); }
}
async function toReservoir() {
  const c = S.clips.find((x) => x.id === S.cur);
  const name = prompt("Name for the new Reservoir Lab project:", `Sounds from ${c ? c.name.replace(/\.[^.]+$/, "") : "the Sound Lab"}`);
  if (name === null) return;
  try { const r = await api.post(`/sounds/${S.cur}/events/reservoir`, { name, events: foundOnly().filter((e) => e.score >= 0.6) }); toast(`${r.n} examples sent. The Reservoir Lab opens now.`, "good"); go("reservoir", { p: r.id }); }
  catch (e) { showErr(e); }
}
async function muteAll(how) {
  const ev = foundOnly(); if (!ev.length) return;
  pvStop();
  if (!audio.paused) audio.pause();
  setBusy(true, how === "mute" ? `Mute ${ev.length} sounds…` : `Make ${ev.length} sounds quieter…`);
  try { const v = await api.post(`/sounds/${S.cur}/events/mute`, { events: ev, how }); S.last = v.applied; setView(v); }
  catch (e) { showErr(e); } finally { setBusy(false); }
}
function drawFinds(g, X, w, h) {
  if (S.tab !== "find" && !S.found) return;
  for (const m of S.marks) {                               // marks: a solid band along the top, with the name
    const a = X(m.a), b = X(m.b); if (b < 0 || a > w) continue;
    const c = colorOf(m.label);
    g.fillStyle = c + "26"; g.fillRect(a, 0, b - a, h);
    g.fillStyle = c; g.fillRect(a, 0, b - a, 4);
    g.font = "600 10px Inter, sans-serif"; g.fillText(m.label === "nothing" ? "not this" : m.label, a + 3, 15);
  }
  if (!S.found) return;
  for (const e of S.found.events) {                        // detections: outlined boxes along the bottom
    if (e.marked) continue;
    const a = X(e.a), b = X(e.b); if (b < 0 || a > w) continue;
    const c = colorOf(e.label);
    g.strokeStyle = c; g.lineWidth = 1.5; g.setLineDash([4, 3]); g.strokeRect(a + 0.5, 6.5, Math.max(2, b - a - 1), h - 13); g.setLineDash([]);
    g.fillStyle = c; g.fillRect(a, h - 4, b - a, 4);
    g.font = "600 10px Inter, sans-serif"; g.fillText(`${e.label} ${Math.round(Math.min(1, e.score) * 100)}%`, a + 3, h - 8);
  }
}

// shipped sample music: who made it and under which licence (meta.credit, written by app/samples.py)
function credit(c) {
  const k = c && c.credit; if (!k) return "";
  return `<span class="snd-by"> · <a class="snd-credit" href="${esc(k.source)}" target="_blank" rel="noopener" title="${esc(k.attribution || "")}">${esc(k.author)} · ${esc(k.licence)}</a></span>`;
}
