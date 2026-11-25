// Sound Lab DSP in the browser: loudness from 100 ms steps (the same arithmetic as app/loudness.py, so a selection
// reads at once), K-weighting for preview buffers, and the spectrogram worker that draws the visible window at the
// current zoom (log / mel / linear frequency, colour maps, a dB floor). The card does every edit; the browser draws.

// ---------------------------------------------------------------- loudness (ITU-R BS.1770-4, EBU R128)
const LOG10 = Math.log10 || ((v) => Math.log(v) / Math.LN10);
export const lufs = (e) => -0.691 + 10 * LOG10(Math.max(e, 1e-20));
function windows(e, m, a = 0, b = e.length) {           // the mean of every run of m steps inside [a, b)
  const out = []; if (b - a < m) return out;
  let s = 0; for (let i = a; i < a + m; i++) s += e[i];
  out.push(s / m);
  for (let i = a + m; i < b; i++) { s += e[i] - e[i - m]; out.push(s / m); }
  return out;
}
const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
function pct(sorted, q) {                                  // numpy's linear percentile
  const p = (sorted.length - 1) * q / 100, i = Math.floor(p), f = p - i;
  return i + 1 < sorted.length ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[i];
}
// readings for steps a..b (indices of 100 ms steps); null = silence below the -70 LUFS gate
export function readSteps(e, a = 0, b = e.length) {
  const m = windows(e, 4, a, b), s = windows(e, 30, a, b);
  let I = null;
  const g1 = m.filter((v) => lufs(v) > -70);
  if (g1.length) { const gr = lufs(mean(g1)) - 10, g2 = g1.filter((v) => lufs(v) > gr); if (g2.length) I = lufs(mean(g2)); }
  let lra = null;
  const s1 = s.filter((v) => lufs(v) > -70);
  if (s1.length) {
    const gr = lufs(mean(s1)) - 20, s2 = s1.filter((v) => lufs(v) > gr).map(lufs).sort((x, y) => x - y);
    lra = s2.length < 2 ? 0 : pct(s2, 95) - pct(s2, 10);
  }
  const mm = m.length ? Math.max(...m) : 0, sm = s.length ? Math.max(...s) : 0;
  return { integrated: I, momentary_max: m.length && lufs(mm) > -70 ? lufs(mm) : null, short_term_max: s.length && lufs(sm) > -70 ? lufs(sm) : null, lra };
}
// momentary (400 ms) and short-term (3 s) loudness ending at step i
export function liveAt(e, i) {
  const at = (n) => { if (i + 1 < n || i >= e.length) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += e[k]; return lufs(s / n); };
  return { m: at(4), s: at(30) };
}
// K-weighting coefficients for any rate (the libebur128 design; at 48 kHz the published BS.1770 values)
function kfilters(fs) {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196, K = Math.tan(Math.PI * f0 / fs);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416), a0 = 1 + K / Q + K * K;
  const s1 = { b: [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0], a: [2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0] };
  f0 = 38.13547087602444; Q = 0.5003270373238773; K = Math.tan(Math.PI * f0 / fs);
  const d = 1 + K / Q + K * K;
  return [s1, { b: [1, -2, 1], a: [2 * (K * K - 1) / d, (1 - K / Q + K * K) / d] }];
}
// 100 ms steps of K-weighted energy for an AudioBuffer-like {sr, ch: [Float32Array...]}
export function kSteps(chs, sr) {
  const n = Math.round(0.1 * sr), len = chs[0].length, k = Math.floor(len / n), out = new Float64Array(k), F = kfilters(sr);
  for (const x of chs) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, z1 = 0, z2 = 0;
    const [p, q] = F;
    for (let s = 0; s < k; s++) {
      let acc = 0;
      for (let i = s * n, e = i + n; i < e; i++) {
        const v = x[i];
        const y = p.b[0] * v + p.b[1] * x1 + p.b[2] * x2 - p.a[0] * y1 - p.a[1] * y2; x2 = x1; x1 = v; y2 = y1; y1 = y;
        const z = q.b[0] * y + q.b[1] * u1 + q.b[2] * u2 - q.a[0] * z1 - q.a[1] * z2; u2 = u1; u1 = y; z2 = z1; z1 = z;
        acc += z * z;
      }
      out[s] += acc / n;
    }
  }
  return out;
}

// ---------------------------------------------------------------- spectrogram (Web Worker)
export const SCALES = { log: "Log", mel: "Mel", linear: "Linear" };
export const CMAPS = { heat: "Heat", ice: "Ice", gray: "Gray" };
const FMIN = 30;
const mel = (f) => 2595 * LOG10(1 + f / 700), imel = (m) => 700 * (Math.pow(10, m / 2595) - 1);
// frequency at the fraction u of the height (0 = bottom, 1 = top) and back; shared with the worker (same formulas)
export function fAt(u, scale, fmax) {
  if (scale === "linear") return u * fmax;
  if (scale === "mel") return imel(u * mel(fmax));
  return FMIN * Math.pow(fmax / FMIN, u);
}
export function uOf(f, scale, fmax) {
  if (scale === "linear") return f / fmax;
  if (scale === "mel") return mel(f) / mel(fmax);
  return Math.log(Math.max(f, FMIN) / FMIN) / Math.log(fmax / FMIN);
}
const WORKER = `
const FMIN = ${FMIN};
let pcm = null, sr = 44100;
const mel = (f) => 2595 * Math.log10(1 + f / 700), imel = (m) => 700 * (Math.pow(10, m / 2595) - 1);
function fAt(u, scale, fmax) { if (scale === "linear") return u * fmax; if (scale === "mel") return imel(u * mel(fmax)); return FMIN * Math.pow(fmax / FMIN, u); }
const LUT = {};
function lut(name) {
  if (LUT[name]) return LUT[name];
  const stops = name === "gray" ? [[0,0,0,0],[1,255,255,255]]
    : name === "ice" ? [[0,4,6,12],[.3,10,40,90],[.55,30,110,170],[.8,140,210,235],[1,245,252,255]]
    : [[0,0,0,0],[.3,40,2,8],[.52,150,8,8],[.7,235,60,18],[.86,255,170,45],[1,255,250,225]];
  const t = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const v = i / 255; let k = 0; while (k < stops.length - 2 && v > stops[k + 1][0]) k++;
    const a = stops[k], b = stops[k + 1], f = (v - a[0]) / (b[0] - a[0] || 1);
    for (let c = 0; c < 3; c++) t[i * 3 + c] = Math.round(a[c + 1] + (b[c + 1] - a[c + 1]) * Math.max(0, Math.min(1, f)));
  }
  return LUT[name] = t;
}
const FFT = {};
function plan(N) {
  if (FFT[N]) return FFT[N];
  const rev = new Uint32Array(N), bits = Math.log2(N);
  for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cs = new Float64Array(N / 2), sn = new Float64Array(N / 2), win = new Float64Array(N);
  for (let i = 0; i < N / 2; i++) { cs[i] = Math.cos(2 * Math.PI * i / N); sn[i] = -Math.sin(2 * Math.PI * i / N); }
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  return FFT[N] = { rev, cs, sn, win, re: new Float64Array(N), im: new Float64Array(N) };
}
function power(N, start, out) {          // |FFT|^2 of the Hann-windowed frame at start, scaled so a full-scale sine = 1
  const P = plan(N), re = P.re, im = P.im, L = pcm.length;
  for (let i = 0; i < N; i++) { const j = start + i, v = j >= 0 && j < L ? pcm[j] : 0; re[P.rev[i]] = v * P.win[i]; im[P.rev[i]] = 0; }
  for (let size = 2; size <= N; size <<= 1) {
    const h = size >> 1, step = N / size;
    for (let i = 0; i < N; i += size) for (let j = 0, k = 0; j < h; j++, k += step) {
      const a = i + j, b = a + h, tr = re[b] * P.cs[k] - im[b] * P.sn[k], ti = re[b] * P.sn[k] + im[b] * P.cs[k];
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
  const sc = 16 / (N * N);
  for (let k = 0; k <= N / 2; k++) { const v = (re[k] * re[k] + im[k] * im[k]) * sc; if (v > out[k]) out[k] = v; }
}
onmessage = (ev) => {
  const q = ev.data;
  if (q.type === "pcm") { pcm = q.mono; sr = q.sr; return; }
  if (!pcm) { postMessage({ id: q.id, err: "no audio" }); return; }
  const { cols, rows, t0, span, scale, floor, cmap } = q, fmax = sr / 2, spc = span * sr / cols;
  const N = q.N || (spc < 40 ? 512 : spc < 160 ? 1024 : 2048);
  const per = Math.max(1, Math.min(6, Math.ceil(spc / N)));       // frames per column when zoomed out (the loudest of them
                                                                   // is drawn, so a short click between frames still shows)
  const img = new Uint8ClampedArray(cols * rows * 4), col = new Float64Array(N / 2 + 1), L = lut(cmap || "heat");
  const klo = new Float64Array(rows), khi = new Float64Array(rows), binHz = sr / N;
  for (let r = 0; r < rows; r++) {                                   // row r (0 = top) covers [f(u0), f(u1)]
    const u1 = 1 - r / rows, u0 = 1 - (r + 1) / rows;
    klo[r] = fAt(u0, scale, fmax) / binHz; khi[r] = fAt(u1, scale, fmax) / binHz;
  }
  const rng = -floor;
  for (let c = 0; c < cols; c++) {
    col.fill(0);
    const ta = (t0 + span * c / cols) * sr, tb = (t0 + span * (c + 1) / cols) * sr;
    for (let f = 0; f < per; f++) power(N, Math.round(ta + (tb - ta) * (f + 0.5) / per - N / 2), col);
    for (let r = 0; r < rows; r++) {
      let p;
      const a = klo[r], b = khi[r];
      if (b - a < 1) { const k = Math.min(N / 2 - 1, Math.max(0, (a + b) / 2)), i = Math.floor(k), fr = k - i; p = col[i] * (1 - fr) + col[i + 1] * fr; }
      else { p = 0; for (let k = Math.ceil(a), e = Math.min(N / 2, Math.floor(b)); k <= e; k++) if (col[k] > p) p = col[k]; }
      const dbv = 10 * Math.log10(p + 1e-14);
      const v = Math.max(0, Math.min(255, Math.round((dbv - floor) / rng * 255)));
      const o = (r * cols + c) * 4;
      img[o] = L[v * 3]; img[o + 1] = L[v * 3 + 1]; img[o + 2] = L[v * 3 + 2]; img[o + 3] = 255;
    }
  }
  postMessage({ id: q.id, img, cols, rows, N }, [img.buffer]);
};`;
let worker = null, wseq = 0;
const waiting = new Map();
function w() {
  if (worker) return worker;
  worker = new Worker(URL.createObjectURL(new Blob([WORKER], { type: "text/javascript" })));
  worker.onmessage = (ev) => { const r = waiting.get(ev.data.id); if (r) { waiting.delete(ev.data.id); r(ev.data); } };
  return worker;
}
export function specAudio(ch, sr) {                       // the mono mix the spectrogram reads (L+R)/2
  const a = ch[0], b = ch[1] || ch[0], m = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) m[i] = (a[i] + b[i]) * 0.5;
  w().postMessage({ type: "pcm", mono: m, sr }, [m.buffer]);
}
// -> Promise<{img, cols, rows, N}>. One request at a time: a newer request replaces a waiting one (that resolves
// null), so zooming never builds a queue of stale pictures.
let inflight = false, next = null;
export function specImage(p) {
  return new Promise((ok) => { if (next) next.ok(null); next = { p, ok }; pump(); });
}
function pump() {
  if (inflight || !next) return;
  const { p, ok } = next, id = ++wseq; next = null; inflight = true;
  waiting.set(id, (d) => { inflight = false; ok(d); pump(); });
  w().postMessage({ ...p, id });
}
