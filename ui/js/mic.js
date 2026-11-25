// Microphone capture for any app: device choice, a live dBFS level with the noise floor and the trigger threshold,
// voice-activity capture (one utterance, or continuous), hold-to-record, and plain-words diagnostics when the browser
// hands over silence. One microphone at a time; everything is reported through the callbacks given to open().
//
//   mic.prepare()                          call synchronously inside the click handler (makes/resumes the AudioContext)
//   await mic.open({ deviceId, onLevel, onState, onClip })
//   mic.arm({ continuous })                voice-activity capture; onClip(Float32Array, sampleRate) per utterance
//   mic.holdStart() / mic.holdEnd()        manual capture, no voice detection
//   mic.disarm(), mic.close(), mic.devices(), mic.sensitivity (dB above the floor)
const KEY = "vf-mic";
const pref = (() => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { return {}; } })();
const savePref = () => { try { localStorage.setItem(KEY, JSON.stringify(pref)); } catch (e) { /* storage off */ } };

const MIN_DB = -55;            // a trigger never sits below this, however quiet the room
const BLOCK = 1024;
const WORKLET = `class VfTap extends AudioWorkletProcessor {
  constructor() { super(); this.b = new Float32Array(${BLOCK}); this.n = 0; }
  process(inputs) {
    const x = inputs[0] && inputs[0][0];
    if (x) for (let i = 0; i < x.length; i++) { this.b[this.n++] = x[i]; if (this.n === ${BLOCK}) { this.port.postMessage(this.b.slice(0)); this.n = 0; } }
    return true;
  }
}
registerProcessor("vf-tap", VfTap);`;

const S = {
  ctx: null, stream: null, src: null, node: null, sink: null, sr: 48000, label: "",
  floor: -70, level: -100, peak: -100, recentPeak: -100, sinceArm: 0, zeroRun: 0,
  mode: "idle",                // idle | armed | rec | hold
  continuous: false, pre: [], cap: [], loud: 0, quiet: 0, waitStart: 0,
  cb: {}, diag: "",
};
const db = (v) => 20 * Math.log10(v + 1e-10);
const now = () => performance.now();

export const mic = {
  get isOpen() { return !!S.stream; },
  get label() { return S.label; },
  get mode() { return S.mode; },
  get floor() { return S.floor ?? -70; },
  get threshold() { return Math.max(MIN_DB, (S.floor ?? -70) + this.sensitivity); },
  get sensitivity() { return pref.sens ?? 12; },
  set sensitivity(v) { pref.sens = +v; savePref(); },
  get deviceId() { return pref.dev || ""; },
  set deviceId(v) { pref.dev = v || ""; savePref(); },
  get diag() { return S.diag; },

  prepare() {
    if (!S.ctx || S.ctx.state === "closed") S.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (S.ctx.state !== "running") S.ctx.resume().catch(() => {});
  },

  async open({ deviceId, onLevel, onState, onClip } = {}) {
    S.cb = { onLevel: onLevel || S.cb.onLevel, onState: onState || S.cb.onState, onClip: onClip || S.cb.onClip };
    if (deviceId !== undefined && deviceId !== pref.dev) { this.deviceId = deviceId; if (S.stream) this.close(true); }
    if (S.stream) return;
    if (!window.isSecureContext) throw new Error("insecure");
    this.prepare();
    const dev = pref.dev;
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1 };
    if (dev) audio.deviceId = { exact: dev };
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio }); }
    catch (e) {
      if (dev && (e.name === "OverconstrainedError" || e.name === "NotFoundError")) { this.deviceId = ""; delete audio.deviceId; stream = await navigator.mediaDevices.getUserMedia({ audio }); }
      else throw e;
    }
    S.stream = stream;
    const tr = stream.getAudioTracks()[0];
    S.label = (tr && tr.label) || "default input";
    if (tr) {
      tr.onmute = () => setDiag(`The browser muted “${S.label}”. Possibly another app uses it, or Windows paused it.`);
      tr.onunmute = () => setDiag("");
      tr.onended = () => { setDiag(`“${S.label}” stopped (unplugged or switched off). Pick another input.`); this.close(); };
    }
    const ctx = S.ctx;
    S.sr = ctx.sampleRate;
    S.src = ctx.createMediaStreamSource(stream);
    S.sink = ctx.createGain(); S.sink.gain.value = 0; S.sink.connect(ctx.destination);
    let node = null;
    if (ctx.audioWorklet && window.AudioWorkletNode) {
      try {
        const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
        await ctx.audioWorklet.addModule(url); URL.revokeObjectURL(url);
        node = new AudioWorkletNode(ctx, "vf-tap", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
        node.port.onmessage = (e) => block(e.data);
      } catch (e) { node = null; }
    }
    if (!node) {
      node = ctx.createScriptProcessor(BLOCK, 1, 1);
      node.onaudioprocess = (e) => block(new Float32Array(e.inputBuffer.getChannelData(0)));
    }
    S.node = node; S.src.connect(node); node.connect(S.sink);
    S.floor = null; S.level = -100; S.recentPeak = -100; S.zeroRun = 0; S.diag = "";
    if (ctx.state !== "running") { try { await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 800))]); } catch (e) { /* reported below */ } }
    if (ctx.state !== "running") setDiag("The browser paused the audio for this page. Click anywhere on the page, then try again.");
    state();
  },

  close(keepCtx) {
    S.mode = "idle"; S.cap = []; S.pre = [];
    try { if (S.node) { S.node.disconnect(); if (S.node.port) S.node.port.onmessage = null; } if (S.src) S.src.disconnect(); if (S.sink) S.sink.disconnect(); } catch (e) { /* gone */ }
    if (S.stream) S.stream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    S.stream = S.src = S.node = S.sink = null;
    if (!keepCtx && S.ctx) { try { S.ctx.close(); } catch (e) { /* closed */ } S.ctx = null; }
    S.level = -100; state();
  },

  async devices() {
    try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput"); } catch (e) { return []; }
  },

  arm({ continuous = false } = {}) {
    S.continuous = continuous; S.mode = "armed"; S.cap = []; S.loud = 0; S.quiet = 0; S.waitStart = now(); S.recentPeak = -100;
    state();
  },
  disarm() { if (S.mode !== "hold") { S.mode = "idle"; S.cap = []; } state(); },
  holdStart() { S.back = S.mode === "armed" || S.mode === "rec" ? "armed" : "idle"; S.cap = [...S.pre]; S.mode = "hold"; state(); },
  holdEnd() {
    if (S.mode !== "hold") return;
    const clip = cat(S.cap); S.cap = []; S.mode = S.back || "idle"; S.waitStart = now(); state();
    emit(clip);
  },
};

function setDiag(t) { if (S.diag !== t) { S.diag = t; state(); } }
function state() { if (S.cb.onState) S.cb.onState({ mode: S.mode, open: !!S.stream, label: S.label, diag: S.diag, continuous: S.continuous }); }
function emit(clip) {
  if (clip.length / S.sr < 0.2 || !S.cb.onClip) return;
  let mx = 0; for (let i = 0; i < clip.length; i++) { const a = Math.abs(clip[i]); if (a > mx) mx = a; }
  if (db(mx) < -70) { setDiag(`That recording was silent (peak ${mx === 0 ? "exactly zero" : db(mx).toFixed(0) + " dBFS"}), so the Lab did not keep it. Check the input above.`); return; }
  if (S.diag.startsWith("That recording was silent")) S.diag = "";
  S.cb.onClip(clip, S.sr);
}
const cat = (chunks) => { const n = chunks.reduce((a, c) => a + c.length, 0), out = new Float32Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out; };

function block(x) {
  if (!S.stream) return;
  let s = 0, mx = 0;
  for (let i = 0; i < x.length; i++) { const v = x[i]; s += v * v; const a = v < 0 ? -v : v; if (a > mx) mx = a; }
  const L = db(Math.sqrt(s / x.length)), dt = x.length / S.sr;
  S.level = L; S.peak = db(mx);
  // digital silence: exact zeros are never a quiet room, they are a muted or blocked device
  S.zeroRun = mx === 0 ? S.zeroRun + dt : 0;
  if (S.zeroRun > 1.5) setDiag(`The browser gives only silence from “${S.label}”. Open Windows Settings → Privacy & security → Microphone, and let the browser use the microphone. Make sure that the input is not muted, or select a different input above.`);
  else if (S.diag.startsWith("The browser gives only silence")) setDiag("");
  // the noise floor follows quiet moments quickly and loud ones slowly (≈ 3 dB/s), so speech doesn't drag it up
  if (S.floor === null) S.floor = L;
  if (S.mode !== "rec" && S.mode !== "hold") S.floor = L < S.floor ? 0.7 * S.floor + 0.3 * L : Math.min(L, S.floor + 3 * dt);
  S.floor = Math.max(-100, Math.min(-20, S.floor));
  const thr = mic.threshold, rel = thr - 4;
  S.pre.push(x); while (S.pre.length * dt > 0.25) S.pre.shift();
  if (S.mode === "armed") {
    S.recentPeak = Math.max(S.recentPeak, L);
    if (L > thr) { if (++S.loud >= 2) { S.mode = "rec"; S.cap = [...S.pre]; S.quiet = 0; state(); } } else S.loud = 0;
    const waited = (now() - S.waitStart) / 1000;
    if (waited > 4 && S.zeroRun === 0 && S.recentPeak < thr) setDiag(`Loudest sound until now: ${S.recentPeak.toFixed(0)} dBFS. Recording starts at ${thr.toFixed(0)} dBFS. ${thr <= MIN_DB + 0.1 ? "That is the lowest trigger. Increase the input volume (Windows Sound settings → Input), or move nearer," : "Lower “Starts at”, or move nearer,"} or use Hold to record.`);
    if (!S.continuous && waited > 10) { S.mode = "idle"; state(); }
  } else if (S.mode === "rec") {
    S.cap.push(x);
    S.quiet = L < rel ? S.quiet + dt : 0;
    if (S.quiet > 0.45 || S.cap.length * dt > 3.0) {
      const clip = cat(S.cap); S.cap = []; S.loud = 0;
      S.mode = S.continuous ? "armed" : "idle"; S.waitStart = now(); S.recentPeak = -100;
      if (S.diag.startsWith("Loudest")) S.diag = "";
      state(); emit(clip);
    }
  } else if (S.mode === "hold") {
    S.cap.push(x);
    if (S.cap.length * dt > 6) mic.holdEnd();
  }
  if (S.cb.onLevel) S.cb.onLevel({ level: L, peak: S.peak, floor: S.floor, threshold: thr, mode: S.mode });
}
