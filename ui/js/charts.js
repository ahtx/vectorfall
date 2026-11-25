// Tiny canvas charts in the VectorFall style: crisp on HiDPI, red for the answer, blue for reference, mono labels.
const C = { red: "#ff2a1a", rosso: "#d40000", blue: "#3fa9f5", yel: "#ffd300", grid: "rgba(255,255,255,.06)", axis: "rgba(255,255,255,.16)", txt: "#8a8b93", ink: "#e8e8ea" };
export const PALETTE = ["#ff2a1a", "#3fa9f5", "#ffd300", "#2fd38a", "#c084fc", "#ff8a3d", "#5eead4", "#f472b6", "#a3e635", "#94a3b8", "#fb7185", "#38bdf8"];

function setup(canvas, h) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 600;
  const hh = h || canvas.clientHeight || 260;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(hh * dpr);
  canvas.style.height = hh + "px";
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, hh);
  g.font = "11px 'JetBrains Mono', monospace";
  return { g, w, h: hh };
}
const nice = (v) => {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1) + "B"; if (a >= 1e6) return (v / 1e6).toFixed(1) + "M"; if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + "k";
  if (a > 0 && a < 0.01) return v.toExponential(0);
  return Number.isInteger(v) ? String(v) : v.toFixed(a < 1 ? 2 : 1);
};
function frame(g, w, h, x0, x1, y0, y1, o = {}) {
  const pad = { l: o.l ?? 52, r: 14, t: 14, b: o.b ?? 26 };
  const X = (x) => pad.l + (x - x0) / ((x1 - x0) || 1) * (w - pad.l - pad.r);
  const Y = (y) => h - pad.b - (y - y0) / ((y1 - y0) || 1) * (h - pad.t - pad.b);
  g.strokeStyle = C.grid; g.lineWidth = 1; g.fillStyle = C.txt;
  for (let i = 0; i <= 4; i++) {
    const v = y0 + (y1 - y0) * i / 4, y = Y(v);
    g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke();
    g.textAlign = "right"; g.fillText((o.yfmt || nice)(v), pad.l - 6, y + 4);
  }
  g.textAlign = "center";
  const ticks = o.xticks || 6;
  for (let i = 0; i <= ticks; i++) {
    const v = x0 + (x1 - x0) * i / ticks;
    g.fillText((o.xfmt || nice)(v), X(v), h - 8);
  }
  return { X, Y, pad };
}
const ext = (arr) => { let lo = Infinity, hi = -Infinity; for (const v of arr) { if (v == null || Number.isNaN(v)) continue; if (v < lo) lo = v; if (v > hi) hi = v; } return [lo, hi]; };

export function line(canvas, { x, series, h, yfmt, xfmt, area = true, ymin }) {
  const { g, w, h: H } = setup(canvas, h);
  x = x || series[0].y.map((_, i) => i);
  const all = series.flatMap((s) => s.y);
  let [lo, hi] = ext(all); if (ymin != null) lo = Math.min(lo, ymin); if (lo === hi) hi = lo + 1;
  const f = frame(g, w, H, x[0], x[x.length - 1], lo, hi, { yfmt, xfmt });
  series.forEach((s, k) => {
    const col = s.color || [C.red, C.blue, C.yel][k % 3];
    g.beginPath();
    s.y.forEach((v, i) => { const px = f.X(x[i]), py = f.Y(v); i ? g.lineTo(px, py) : g.moveTo(px, py); });
    g.strokeStyle = col; g.lineWidth = s.width || 2; g.setLineDash(s.dash || []); g.stroke(); g.setLineDash([]);
    if (area && k === 0) {
      g.lineTo(f.X(x[x.length - 1]), f.Y(lo)); g.lineTo(f.X(x[0]), f.Y(lo)); g.closePath();
      const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, col + "55"); gr.addColorStop(1, col + "00"); g.fillStyle = gr; g.fill();
    }
  });
}

export function fan(canvas, { x, bands, h, unit }) {
  // bands[i] = [p5, p25, p50, p75, p95]
  const { g, w, h: H } = setup(canvas, h);
  const hi = Math.max(...bands.map((b) => b[4])) || 1;
  const f = frame(g, w, H, x[0], x[x.length - 1], 0, hi, { yfmt: (v) => (unit === "$" ? "$" : "") + nice(v) });
  const poly = (a, b, col) => {
    g.beginPath();
    x.forEach((xx, i) => { const p = [f.X(xx), f.Y(bands[i][a])]; i ? g.lineTo(...p) : g.moveTo(...p); });
    for (let i = x.length - 1; i >= 0; i--) g.lineTo(f.X(x[i]), f.Y(bands[i][b]));
    g.closePath(); g.fillStyle = col; g.fill();
  };
  poly(0, 4, "rgba(212,0,0,.16)"); poly(1, 3, "rgba(255,42,26,.30)");
  g.beginPath(); x.forEach((xx, i) => { const p = [f.X(xx), f.Y(bands[i][2])]; i ? g.lineTo(...p) : g.moveTo(...p); });
  g.strokeStyle = "#fff"; g.lineWidth = 2.2; g.stroke();
  g.beginPath(); x.forEach((xx, i) => { const p = [f.X(xx), f.Y(bands[i][0])]; i ? g.lineTo(...p) : g.moveTo(...p); });
  g.strokeStyle = C.red; g.lineWidth = 1; g.setLineDash([4, 4]); g.stroke(); g.setLineDash([]);
}

export function fanHistory(canvas, { hx, hy, px, bands, h, unit }) {
  const { g, w, h: H } = setup(canvas, h);
  const x0 = hx[0], x1 = px[px.length - 1];
  const all = hy.concat(bands.flat());
  let [lo, hi] = ext(all); if (lo === hi) hi = lo + 1;
  lo = Math.min(lo, 0 < lo ? lo : lo); const pad = (hi - lo) * 0.05; lo -= pad; hi += pad;
  const f = frame(g, w, H, x0, x1, lo, hi, { yfmt: (v) => (unit === "$" ? "$" : "") + nice(v) });
  // split line at the "now" boundary
  g.strokeStyle = "rgba(255,255,255,.12)"; g.setLineDash([3, 4]); g.beginPath(); g.moveTo(f.X(px[0]), 12); g.lineTo(f.X(px[0]), H - 26); g.stroke(); g.setLineDash([]);
  const poly = (a, b, col) => {
    g.beginPath();
    px.forEach((xx, i) => { const p = [f.X(xx), f.Y(bands[i][a])]; i ? g.lineTo(...p) : g.moveTo(...p); });
    for (let i = px.length - 1; i >= 0; i--) g.lineTo(f.X(px[i]), f.Y(bands[i][b]));
    g.closePath(); g.fillStyle = col; g.fill();
  };
  poly(0, 4, "rgba(212,0,0,.15)"); poly(1, 3, "rgba(255,42,26,.28)");
  g.beginPath(); px.forEach((xx, i) => { const p = [f.X(xx), f.Y(bands[i][2])]; i ? g.lineTo(...p) : g.moveTo(...p); }); g.strokeStyle = "#fff"; g.lineWidth = 2; g.stroke();
  g.beginPath(); hx.forEach((xx, i) => { const p = [f.X(xx), f.Y(hy[i])]; i ? g.lineTo(...p) : g.moveTo(...p); }); g.strokeStyle = C.blue; g.lineWidth = 2; g.stroke();
  g.fillStyle = C.txt; g.font = "10px 'JetBrains Mono'"; g.textAlign = "left"; g.fillText("history", f.X(x0) + 4, 12); g.fillText("projection", f.X(px[0]) + 4, 12);
}

export function hist(canvas, { edges, y, h, marker, unit, color, mlabel = "deadline" }) {
  const s = setup(canvas, h);
  const x0 = edges[0], x1 = edges[edges.length - 1];
  const f = frame(s.g, s.w, s.h, x0, x1, 0, Math.max(...y) || 1, { xfmt: (v) => nice(v) + (unit && unit !== "%" ? "" : "") });
  y.forEach((v, i) => {
    const a = f.X(edges[i]), b = f.X(edges[i + 1]);
    const top = f.Y(v), base = f.Y(0);
    const gr = s.g.createLinearGradient(0, top, 0, base);
    const over = marker != null && edges[i] >= marker;
    gr.addColorStop(0, over ? "#ffd300" : (color || C.red)); gr.addColorStop(1, over ? "rgba(255,211,0,.15)" : "rgba(212,0,0,.15)");
    s.g.fillStyle = gr; s.g.fillRect(a + 0.5, top, Math.max(1, b - a - 1), base - top);
  });
  if (marker != null) {
    const mx = f.X(marker); s.g.strokeStyle = "#fff"; s.g.setLineDash([5, 4]); s.g.beginPath(); s.g.moveTo(mx, 10); s.g.lineTo(mx, s.h - 26); s.g.stroke(); s.g.setLineDash([]);
    s.g.fillStyle = "#fff"; s.g.textAlign = "left"; s.g.fillText(" " + mlabel, mx, 22);
  }
}

export function bars(canvas, { x, y, h, color }) {
  const s = setup(canvas, h);
  const f = frame(s.g, s.w, s.h, 0, x.length, 0, Math.max(...y, 1), { xfmt: (v) => x[Math.min(x.length - 1, Math.round(v))] ?? "" });
  const bw = (s.w - 66) / x.length;
  y.forEach((v, i) => {
    const px = f.X(i), top = f.Y(v);
    s.g.fillStyle = color || C.red; s.g.fillRect(px + 1, top, Math.max(1, bw - 2), f.Y(0) - top);
  });
}

export function hbars(canvas, { labels, y, h, fmt }) {
  const n = labels.length;
  const s = setup(canvas, h || Math.max(80, n * 26 + 10));
  const mx = Math.max(...y.map(Math.abs), 1e-9);
  const lw = 130;
  labels.forEach((l, i) => {
    const top = 6 + i * 26, wv = (s.w - lw - 70) * Math.abs(y[i]) / mx;
    s.g.fillStyle = C.ink; s.g.textAlign = "right"; s.g.fillText(String(l).slice(0, 18), lw - 8, top + 15);
    const gr = s.g.createLinearGradient(lw, 0, lw + wv, 0); gr.addColorStop(0, "rgba(212,0,0,.5)"); gr.addColorStop(1, C.red);
    s.g.fillStyle = gr; s.g.fillRect(lw, top + 4, wv, 14);
    s.g.fillStyle = C.txt; s.g.textAlign = "left"; s.g.fillText(fmt ? fmt(y[i]) : nice(y[i]), lw + wv + 6, top + 15);
  });
}

export function scatter(canvas, { pts, labels, h }) {
  const s = setup(canvas, h);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const [x0, x1] = ext(xs), [y0, y1] = ext(ys);
  const f = frame(s.g, s.w, s.h, x0, x1, y0, y1, {});
  s.g.globalCompositeOperation = "lighter";
  pts.forEach((p, i) => {
    s.g.fillStyle = (labels ? PALETTE[labels[i] % PALETTE.length] : C.red) + "aa";
    s.g.beginPath(); s.g.arc(f.X(p[0]), f.Y(p[1]), 2.2, 0, 7); s.g.fill();
  });
  s.g.globalCompositeOperation = "source-over";
}

export function heatmap(canvas, { matrix, labels, h, onCell }) {
  const n = matrix.length;
  const lab = 92;
  const s = setup(canvas, h || Math.min(720, lab + n * 18 + 10));
  const cell = Math.min((s.w - lab - 10) / n, (s.h - lab) / n);
  const flat = matrix.flat().filter((v) => v > 0);
  const mx = Math.max(...flat, 1);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const v = matrix[i][j];
    const t = v > 0 ? Math.log1p(v) / Math.log1p(mx) : 0;
    s.g.fillStyle = v > 0 ? `rgba(${Math.round(80 + 175 * t)},${Math.round(20 + 30 * t * t)},${Math.round(16 * (1 - t))},${0.25 + 0.75 * t})` : "#0d0d10";
    s.g.fillRect(lab + j * cell, lab + i * cell, cell - 1, cell - 1);
  }
  s.g.fillStyle = C.ink; s.g.font = "10px Inter, sans-serif";
  labels.forEach((l, i) => {
    s.g.textAlign = "right"; s.g.fillText(l, lab - 6, lab + i * cell + cell * 0.7);
    s.g.save(); s.g.translate(lab + i * cell + cell * 0.65, lab - 6); s.g.rotate(-Math.PI / 3); s.g.textAlign = "left"; s.g.fillText(l, 0, 0); s.g.restore();
  });
  if (onCell) canvas.onmousemove = (e) => {
    const r = canvas.getBoundingClientRect();
    const j = Math.floor((e.clientX - r.left - lab) / cell), i = Math.floor((e.clientY - r.top - lab) / cell);
    onCell(i >= 0 && j >= 0 && i < n && j < n ? { i, j, v: matrix[i][j], from: labels[i], to: labels[j] } : null);
  };
}

export function loglog(canvas, { y, h }) {
  const s = setup(canvas, h);
  const pts = y.map((v, i) => [Math.log10(i + 1), Math.log10(Math.max(v, 1))]);
  const [x0, x1] = ext(pts.map((p) => p[0])), [y0, y1] = ext(pts.map((p) => p[1]));
  const f = frame(s.g, s.w, s.h, x0, x1, y0, y1, { xfmt: (v) => nice(Math.round(10 ** v)), yfmt: (v) => nice(Math.round(10 ** v)) });
  // ideal Zipf line through the first point
  s.g.strokeStyle = "rgba(63,169,245,.6)"; s.g.setLineDash([5, 5]); s.g.beginPath();
  s.g.moveTo(f.X(x0), f.Y(pts[0][1])); s.g.lineTo(f.X(x1), f.Y(pts[0][1] - (x1 - x0))); s.g.stroke(); s.g.setLineDash([]);
  s.g.strokeStyle = C.red; s.g.lineWidth = 2; s.g.beginPath();
  pts.forEach((p, i) => { i ? s.g.lineTo(f.X(p[0]), f.Y(p[1])) : s.g.moveTo(f.X(p[0]), f.Y(p[1])); }); s.g.stroke();
}

export function wave(canvas, peaks, color) {
  const s = setup(canvas, canvas.clientHeight || 110);
  const mid = s.h / 2;
  const gr = s.g.createLinearGradient(0, 0, 0, s.h);
  gr.addColorStop(0, color || C.red); gr.addColorStop(0.5, "#fff"); gr.addColorStop(1, color || C.red);
  s.g.fillStyle = gr;
  const bw = s.w / peaks.length;
  peaks.forEach((p, i) => { const a = Math.max(0.5, p * (s.h / 2 - 6)); s.g.fillRect(i * bw, mid - a, Math.max(1, bw - 0.3), a * 2); });
}
