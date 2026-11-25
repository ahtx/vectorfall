// State machine diagram for Simulate's "State machine" engine: the chain drawn live from its text, with lint.
// parseMachine() reads the text exactly as app/simulate.py states() does, so the picture is what the card will run:
// comma-separated states (names case-insensitive), lines "From -> To : chance" (same regex), each row scaled to sum
// to 1, a state with no way out made absorbing (it stays put), an unknown start falling back to the first state.
// mountDiagram(el, { onLine, onField }) draws it (canvas, DPR-aware, resizes with the pane) beside a lint list, and
// after a run shows how many paths sit in each state at a chosen step.
import { $, esc } from "./core.js";
import { PALETTE } from "./charts.js";

const RX = /^\s*(.+?)\s*->\s*(.+?)\s*[:=]\s*([\d.]+)\s*$/;
const NUM = /^(\d+\.?\d*|\.\d+)$/;                              // what Python's float() accepts from [\d.]+
export const fmtp = (v) => v >= 0.9995 ? "1" : v < 0.0005 ? (v > 0 ? "<0.001" : "0") : String(+v.toFixed(3));

function lev(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[b.length];
}
function closest(name, labels) {
  const l = name.toLowerCase(); let best = null, bd = 1e9;
  for (const s of labels) { const d = lev(l, s.toLowerCase()); if (d < bd) { bd = d; best = s; } }
  return best && bd <= Math.max(2, Math.ceil(best.length / 3)) ? best : null;
}

export function parseMachine({ states = "", transitions = "", start = "" }) {
  const labels = states.split(",").map((s) => s.trim()).filter(Boolean);
  const lint = [];
  const idx = {};
  labels.forEach((l, i) => { const k = l.toLowerCase(); if (k in idx) lint.push({ sev: "warn", field: "states", text: `“${l}” shows two times. The second one gets the transitions. The first one has no way out.` }); idx[k] = i; });
  const n = labels.length;
  if (n < 2) return { ok: false, labels, n, lint: [{ sev: "err", field: "states", text: "Name at least two states, separated by commas (e.g. Healthy, Sick, Recovered)" }, ...lint] };
  const T = labels.map(() => new Array(n).fill(0)), LINE = labels.map(() => new Array(n).fill(null)), seen = {};
  const rows = transitions.split(/\r\n|\r|\n/);
  let parsed = 0;
  rows.forEach((ln, li) => {
    if (!ln.trim()) return;
    const m = RX.exec(ln);
    if (!m) {
      const why = /%/.test(ln) ? ". Write the chance as a number, for example 0.25, not 25%." : /->/.test(ln) ? ". Put a chance after a colon, for example A -> B : 0.25." : ". Write From -> To : chance.";
      lint.push({ sev: "err", line: li, text: `The simulation cannot read line ${li + 1} and does not use it${why}` }); return;
    }
    const a = m[1].trim(), b = m[2].trim(), al = a.toLowerCase(), bl = b.toLowerCase();
    if (!NUM.test(m[3])) { lint.push({ sev: "err", line: li, text: `Line ${li + 1}: “${m[3]}” is not a number. The run fails until you correct it.` }); return; }
    const bad = [a, b].filter((x) => !(x.toLowerCase() in idx));
    if (bad.length) {
      lint.push({ sev: "err", line: li, text: `Line ${li + 1} names ${bad.map((x) => { const c = closest(x, labels); return `“${x}”${c ? ` (did you mean “${c}”?)` : ""}`; }).join(" and ")}. ${bad.length > 1 ? "These are not states" : "This is not a state"}, so the simulation does not use the line.` });
      return;
    }
    const i = idx[al], j = idx[bl], key = i + ">" + j;
    if (key in seen) lint.push({ sev: "warn", line: li, text: `Line ${li + 1} repeats ${labels[i]} -> ${labels[j]} (line ${seen[key] + 1}). The simulation uses the last value, ${m[3]}.` });
    seen[key] = li; T[i][j] = parseFloat(m[3]); LINE[i][j] = li; parsed++;
  });
  const raw = T.map((r) => r.slice()), absorb = [], loopOnly = [];
  for (let i = 0; i < n; i++) {
    const s = T[i].reduce((x, y) => x + y, 0);
    if (s === 0) { T[i][i] = 1; absorb.push(i); }
    else if (T[i].every((v, j) => j === i || v === 0)) loopOnly.push(i);
  }
  const P = T.map((r) => { const s = r.reduce((x, y) => x + y, 0); return r.map((v) => v / s); });
  const startKey = (start || labels[0]).toLowerCase(), s0 = startKey in idx ? idx[startKey] : 0;
  if (start && !(startKey in idx)) { const c = closest(start, labels); lint.push({ sev: "warn", field: "start", text: `Start “${start}” is not a state, so the paths start in “${labels[0]}”.${c && c !== labels[0] ? ` Did you mean “${c}”?` : ""}` }); }
  for (let i = 0; i < n; i++) {
    const s = raw[i].reduce((x, y) => x + y, 0);
    if (s > 0 && Math.abs(s - 1) > 1e-6) {
      const fl = LINE[i].filter((x) => x != null);
      lint.push({ sev: "warn", line: fl.length ? Math.min(...fl) : undefined, state: i, text: `The chances from ${labels[i]} add up to ${+s.toFixed(4)}, not 1. The simulation scales them to a sum of 1 (${P[i].map((v, j) => v > 0 ? `${labels[j]} ${fmtp(v)}` : "").filter(Boolean).join(", ")})` });
    }
  }
  absorb.forEach((i) => lint.push({ sev: "info", state: i, field: "transitions", text: `${labels[i]} has no way out, so it is absorbing: a path that gets there stays there.` }));
  loopOnly.forEach((i) => lint.push({ sev: "info", state: i, line: LINE[i][i], text: `${labels[i]} goes only back to itself, so it is absorbing.` }));
  // reachability from the start
  const reach = new Array(n).fill(false), q = [s0], dist = new Array(n).fill(-1); reach[s0] = true; dist[s0] = 0;
  while (q.length) { const i = q.shift(); for (let j = 0; j < n; j++) if (P[i][j] > 0 && !reach[j]) { reach[j] = true; dist[j] = dist[i] + 1; q.push(j); } }
  reach.forEach((r, i) => { if (!r) lint.push({ sev: "warn", state: i, text: `No path from ${labels[s0]} gets to ${labels[i]}, so no path will ever be in it.` }); });
  const edges = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (P[i][j] > 0) edges.push({ i, j, p: P[i][j], raw: raw[i][j], line: LINE[i][j], synth: absorb.includes(i) && i === j });
  const order = { err: 0, warn: 1, info: 2 };
  lint.sort((a, b) => order[a.sev] - order[b.sev] || (a.line ?? 1e9) - (b.line ?? 1e9));
  return { ok: true, labels, n, P, raw, edges, start: s0, absorb: new Set([...absorb, ...loopOnly]), reach, dist, lint, parsed, lines: rows.length };
}

// ---------------------------------------------------------------- layout
function layout(m, W, H) {
  const n = m.n, maxd = Math.max(0, ...m.dist);
  const layer = m.dist.map((d) => d < 0 ? maxd + 1 : d);
  const L = Math.max(...layer) + 1, by = Array.from({ length: L }, () => []);
  layer.forEach((l, i) => by[l].push(i));
  const per = Math.max(...by.map((b) => b.length));
  const pos = new Array(n);
  let R, kind;
  if (L <= 6 && per <= 5 && L > 1) {
    kind = "layers";
    const cw = W / L, padY = 34;
    R = Math.max(13, Math.min(28, cw * 0.17, (H - 2 * padY) / per * 0.26));
    const ys = {};
    by.forEach((ids, l) => {
      // order each layer by where its predecessors sit, so edges cross less
      if (l > 0) ids.sort((a, b) => bary(a) - bary(b));
      ids.forEach((i, k) => { pos[i] = [cw * (l + 0.5), padY + (k + 0.5) * (H - 2 * padY) / ids.length]; ys[i] = pos[i][1]; });
    });
    function bary(i) { const pr = m.edges.filter((e) => e.j === i && e.i !== i && ys[e.i] != null).map((e) => ys[e.i]); return pr.length ? pr.reduce((a, b) => a + b, 0) / pr.length : 1e6 + i; }
  } else {
    kind = "circle";
    const ord = [...Array(n).keys()].sort((a, b) => layer[a] - layer[b] || a - b);
    const rad = Math.max(40, Math.min(W, H) / 2 - 52);
    R = Math.max(12, Math.min(26, (2 * Math.PI * rad / n) * 0.2));
    ord.forEach((i, k) => { const a = Math.PI + 2 * Math.PI * k / n; pos[i] = [W / 2 + rad * Math.cos(a) * Math.min(1.5, W / H), H / 2 + rad * Math.sin(a)]; });
    // keep the stretched ellipse inside the canvas
    const xs = pos.map((p) => p[0]), ex = Math.max(W / 2 - Math.min(...xs), Math.max(...xs) - W / 2), lim = W / 2 - R - 50;
    if (ex > lim) pos.forEach((p) => { p[0] = W / 2 + (p[0] - W / 2) * lim / ex; });
  }
  const cx = pos.reduce((a, p) => a + p[0], 0) / n, cy = pos.reduce((a, p) => a + p[1], 0) / n;
  return { pos, R, kind, layer, cx, cy, W, H };
}

const bez = (p0, c, p1, t) => [(1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * c[0] + t * t * p1[0], (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * c[1] + t * t * p1[1]];
const unit = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };

function geometry(m, G) {
  const { pos, R, layer, cx, cy } = G, has = new Set(m.edges.map((e) => e.i + ">" + e.j));
  return m.edges.map((e) => {
    const a = pos[e.i], b = pos[e.j];
    if (e.i === e.j) {                                   // self-loop: up in layers, else away from the middle; never where the start arrow comes in
      let d;
      if (G.kind === "layers") {                       // up, unless a node or the edge of the canvas is in the way; then down; then right
        const free = (s) => (s < 0 ? a[1] - R * 3.2 > 4 : a[1] + R * 3.2 + 16 < G.H) && !pos.some((q, k) => k !== e.i && Math.abs(q[0] - a[0]) < R * 2 && (q[1] - a[1]) * s > 0 && Math.abs(q[1] - a[1]) < R * 4.2);
        d = free(-1) ? [0, -1] : free(1) ? [0, 1] : [1, 0];
      }
      else {
        d = unit([cx, cy], a); if (Math.abs(a[0] - cx) < 1 && Math.abs(a[1] - cy) < 1) d = [0, -1];
        if (e.i === m.start) d = [-d[1], d[0]];
      }
      const ang = Math.atan2(d[1], d[0]), s = 0.55;
      const p0 = [a[0] + R * Math.cos(ang - s), a[1] + R * Math.sin(ang - s)], p1 = [a[0] + R * Math.cos(ang + s), a[1] + R * Math.sin(ang + s)];
      const k = R * 2.6, c1 = [a[0] + k * Math.cos(ang - 0.6), a[1] + k * Math.sin(ang - 0.6)], c2 = [a[0] + k * Math.cos(ang + 0.6), a[1] + k * Math.sin(ang + 0.6)];
      const top = [a[0] + R * 2.15 * d[0], a[1] + R * 2.15 * d[1]];
      return { e, loop: true, p0, p1, c1, c2, lab: top, dir: unit(c2, p1) };
    }
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), nrm = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
    const back = G.kind === "layers" && layer[e.j] <= layer[e.i];
    const bend = (has.has(e.j + ">" + e.i) || back ? 0.2 : 0.06) * len + (back && layer[e.j] === layer[e.i] ? 18 : 0);
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], c = [mid[0] + nrm[0] * bend, mid[1] + nrm[1] * bend];
    const u0 = unit(a, c), u1 = unit(c, b);
    const p0 = [a[0] + u0[0] * (R + 2), a[1] + u0[1] * (R + 2)], p1 = [b[0] - u1[0] * (R + 4), b[1] - u1[1] * (R + 4)];
    return { e, loop: false, p0, c, p1, dir: u1 };
  });
}

// ---------------------------------------------------------------- the view
export function mountDiagram(el, { onLine = () => {}, onField = () => {}, onState = () => {} } = {}) {
  el.innerHTML = `<div class="sd"><div class="sd-stage"><canvas></canvas><div class="sd-tip" hidden></div></div><div class="sd-lint"></div></div>`;
  const stage = $(".sd-stage", el), cv = $("canvas", el), tip = $(".sd-tip", el), lintEl = $(".sd-lint", el);
  let m = null, G = null, geo = [], occ = null, hover = { node: -1, edge: -1 }, labels = [], stale = false;

  function draw() {
    const dpr = window.devicePixelRatio || 1, W = stage.clientWidth, H = stage.clientHeight;
    if (!W || !H) return;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px";
    const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    if (!m || !m.ok) { g.fillStyle = "#6b6b76"; g.font = "13px Inter, sans-serif"; g.textAlign = "center"; g.fillText("Name at least two states to see the machine.", W / 2, H / 2); geo = []; return; }
    G = layout(m, W, H); geo = geometry(m, G);
    const { pos, R } = G, col = (i) => PALETTE[i % PALETTE.length];
    const lit = (gm, k) => hover.edge === k || (hover.node >= 0 && gm.e.i === hover.node);
    const dim = hover.node >= 0 || hover.edge >= 0;
    // edges first, then labels on top
    const rects = pos.map((p) => [p[0] - R - 2, p[1] - R - 2, p[0] + R + 2, p[1] + R + 16]);
    const labs = [];
    geo.forEach((gm, k) => {
      const on = lit(gm, k), w = 1 + 4 * gm.e.p;
      g.strokeStyle = on ? col(gm.e.i) : gm.e.synth ? "rgba(255,255,255,.22)" : "rgba(200,201,206,.55)";
      g.globalAlpha = dim && !on ? 0.22 : 1; g.lineWidth = w; g.setLineDash(gm.e.synth ? [3, 3] : []);
      g.beginPath(); g.moveTo(...gm.p0);
      if (gm.loop) g.bezierCurveTo(...gm.c1, ...gm.c2, ...gm.p1); else g.quadraticCurveTo(...gm.c, ...gm.p1);
      g.stroke(); g.setLineDash([]);
      const s = 5 + w, [dx, dy] = gm.dir, tipP = gm.loop ? gm.p1 : [gm.p1[0] + dx * 2, gm.p1[1] + dy * 2];
      g.fillStyle = g.strokeStyle; g.beginPath(); g.moveTo(...tipP);
      g.lineTo(tipP[0] - dx * s - dy * s * 0.55, tipP[1] - dy * s + dx * s * 0.55); g.lineTo(tipP[0] - dx * s + dy * s * 0.55, tipP[1] - dy * s - dx * s * 0.55); g.closePath(); g.fill();
      // label: the scaled chance, with what was typed when scaling changed it
      const changed = gm.e.raw != null && !gm.e.synth && Math.abs(gm.e.raw - gm.e.p) > 5e-4;
      const txt = fmtp(gm.e.p) + (changed ? ` (${fmtp(gm.e.raw)})` : "");
      g.font = "600 10.5px 'JetBrains Mono', monospace";
      const tw = g.measureText(txt).width + 8;
      let at = gm.loop ? gm.lab : null;
      if (!gm.loop) for (const t of [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74]) {
        const p = bez(gm.p0, gm.c, gm.p1, t), r = [p[0] - tw / 2, p[1] - 8, p[0] + tw / 2, p[1] + 8];
        if (!rects.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1])) { at = p; break; }
      }
      at = at || bez(gm.p0, gm.c, gm.p1, 0.5);
      rects.push([at[0] - tw / 2, at[1] - 8, at[0] + tw / 2, at[1] + 8]);
      labs.push({ at, txt, tw, on, k, dimmed: dim && !on, synth: gm.e.synth });
      gm.labAt = at; gm.tw = tw;
    });
    g.globalAlpha = 1;
    labs.forEach((l) => {
      g.globalAlpha = l.dimmed ? 0.3 : 1;
      g.fillStyle = "#0b0b0e"; g.strokeStyle = l.on ? "rgba(255,255,255,.35)" : "rgba(255,255,255,.1)"; g.lineWidth = 1;
      g.beginPath(); g.roundRect ? g.roundRect(l.at[0] - l.tw / 2, l.at[1] - 8, l.tw, 16, 4) : g.rect(l.at[0] - l.tw / 2, l.at[1] - 8, l.tw, 16); g.fill(); g.stroke();
      g.fillStyle = l.synth ? "#8a8b93" : l.on ? "#fff" : "#d6d6dc"; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(l.txt, l.at[0], l.at[1] + 0.5);
    });
    g.globalAlpha = 1; g.textBaseline = "alphabetic";
    // nodes
    m.labels.forEach((name, i) => {
      const [x, y] = pos[i], c = col(i), share = occ ? occ[i] : null, faded = dim && hover.node !== i && !(hover.edge >= 0 && (geo[hover.edge].e.i === i || geo[hover.edge].e.j === i));
      g.globalAlpha = faded ? 0.45 : 1;
      g.beginPath(); g.arc(x, y, R, 0, 7); g.fillStyle = "#121216"; g.fill();
      if (share != null) {                               // paths in this state: the circle fills from the bottom
        g.save(); g.beginPath(); g.arc(x, y, R, 0, 7); g.clip();
        g.fillStyle = c; g.globalAlpha = (faded ? 0.45 : 1) * 0.78; g.fillRect(x - R, y + R - 2 * R * share, 2 * R, 2 * R * share); g.restore();
        g.globalAlpha = faded ? 0.45 : 1;
      } else { g.fillStyle = c + "26"; g.fill(); }
      g.lineWidth = hover.node === i ? 2.6 : 1.7; g.strokeStyle = c; g.beginPath(); g.arc(x, y, R, 0, 7); g.stroke();
      if (m.absorb.has(i)) { g.lineWidth = 1.2; g.beginPath(); g.arc(x, y, R + 3.5, 0, 7); g.stroke(); }
      if (!m.reach[i]) { g.setLineDash([2, 3]); g.strokeStyle = "#ffb020"; g.lineWidth = 1.2; g.beginPath(); g.arc(x, y, R + 6.5, 0, 7); g.stroke(); g.setLineDash([]); }
      g.textAlign = "center"; g.textBaseline = "middle";
      if (share != null && R >= 15) { g.font = `700 ${R >= 22 ? 12 : 10.5}px 'JetBrains Mono', monospace`; g.fillStyle = "#fff"; g.fillText(Math.round(share * 100) + "%", x, y + 0.5); }
      else if (m.start === i && share == null) { g.font = "700 9px 'Saira Condensed', sans-serif"; g.fillStyle = "#fff"; g.fillText("START", x, y + 0.5); }
      const nm = name.length > 18 ? name.slice(0, 17) + "…" : name, ring = m.absorb.has(i) ? 4 : 0;
      g.font = "600 11.5px Inter, sans-serif"; g.fillStyle = "#e8e8ee";
      if (G.kind === "circle") {                         // loops point outward, so names sit on the inside
        const d = unit([x, y], [G.cx, G.cy]), off = R + ring + 10 + Math.abs(d[0]) * g.measureText(nm).width / 2;
        g.fillText(nm, x + d[0] * off, y + d[1] * (R + ring + 10));
      } else {
        const below = y + R + 13 < stage.clientHeight - 4;
        g.fillText(nm, x, below ? y + R + ring + 12 : y - R - ring - 10);
      }
      g.textBaseline = "alphabetic";
    });
    // the start arrow, coming in from outside
    {
      const [x, y] = pos[m.start]; let d = G.kind === "layers" ? [-1, 0] : unit([G.cx, G.cy], [x, y]);
      if (!isFinite(d[0])) d = [-1, 0];
      const a = [x + d[0] * (R + 26), y + d[1] * (R + 26)], b = [x + d[0] * (R + 5), y + d[1] * (R + 5)];
      g.globalAlpha = 1; g.strokeStyle = "#ffd300"; g.fillStyle = "#ffd300"; g.lineWidth = 2;
      g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke();
      g.beginPath(); g.moveTo(b[0], b[1]); g.lineTo(b[0] + d[0] * 7 - d[1] * 4, b[1] + d[1] * 7 + d[0] * 4); g.lineTo(b[0] + d[0] * 7 + d[1] * 4, b[1] + d[1] * 7 - d[0] * 4); g.closePath(); g.fill();
    }
    g.globalAlpha = 1;
  }

  function lint() {
    if (!m) { lintEl.innerHTML = ""; return; }
    const errs = m.lint.filter((x) => x.sev === "err").length, warns = m.lint.filter((x) => x.sev === "warn").length;
    const head = !m.ok ? "" : `<div class="sd-sum"><b>${m.n}</b> states · <b>${m.edges.filter((e) => !e.synth).length}</b> transitions${m.absorb.size ? ` · <b>${m.absorb.size}</b> absorbing` : ""}
      <span class="${errs ? "bad" : warns ? "warn" : "ok"}">${errs ? `${errs} problem${errs > 1 ? "s" : ""}` : warns ? `${warns} warning${warns > 1 ? "s" : ""}` : "reads cleanly"}</span></div>`;
    const ic = { err: "✕", warn: "!", info: "i" };
    lintEl.innerHTML = head + (m.lint.length ? `<div class="sd-items">${m.lint.map((x, k) => `<div class="sd-it ${x.sev}" data-k="${k}" title="${x.line != null ? "Click to select line " + (x.line + 1) : x.field ? "Click to edit" : ""}"><i>${ic[x.sev]}</i><span>${esc(x.text)}</span>${x.line != null ? `<em>L${x.line + 1}</em>` : ""}</div>`).join("")}</div>`
      : `<div class="sd-ok">The simulation reads each line. Each row adds up to 1. Paths can get to each state.</div>`)
      + (stale ? `<div class="sd-stale">Edited since the last run — ${occ ? "the fill still shows the last run" : "run again to see where the paths go"}.</div>` : "");
    lintEl.querySelectorAll("[data-k]").forEach((d) => {
      const x = m.lint[+d.dataset.k];
      d.onclick = () => { if (x.line != null) onLine(x.line); else if (x.field) onField(x.field); if (x.state != null) { hover = { node: x.state, edge: -1 }; draw(); } };
      d.onmouseenter = () => { if (x.state != null) { hover = { node: x.state, edge: -1 }; draw(); } };
      d.onmouseleave = () => { hover = { node: -1, edge: -1 }; draw(); };
    });
  }

  function hit(x, y) {
    if (!G || !m || !m.ok) return { node: -1, edge: -1 };
    for (let i = 0; i < m.n; i++) if (Math.hypot(G.pos[i][0] - x, G.pos[i][1] - y) <= G.R + 2) return { node: i, edge: -1 };
    let best = -1, bd = 7;
    geo.forEach((gm, k) => {
      if (gm.labAt && Math.abs(gm.labAt[0] - x) <= gm.tw / 2 && Math.abs(gm.labAt[1] - y) <= 8) { bd = 0; best = k; return; }
      for (let t = 0; t <= 1; t += 0.04) {
        const p = gm.loop ? cubic(gm.p0, gm.c1, gm.c2, gm.p1, t) : bez(gm.p0, gm.c, gm.p1, t), d = Math.hypot(p[0] - x, p[1] - y);
        if (d < bd) { bd = d; best = k; }
      }
    });
    return { node: -1, edge: best };
  }
  const cubic = (a, b, c, d, t) => { const u = 1 - t; return [u ** 3 * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t ** 3 * d[0], u ** 3 * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t ** 3 * d[1]]; };

  cv.onmousemove = (ev) => {
    const b = cv.getBoundingClientRect(), x = ev.clientX - b.left, y = ev.clientY - b.top, h = hit(x, y);
    if (h.node !== hover.node || h.edge !== hover.edge) { hover = h; draw(); }
    cv.style.cursor = h.edge >= 0 || h.node >= 0 ? "pointer" : "default";
    if (h.node < 0 && h.edge < 0) { tip.hidden = true; return; }
    let html;
    if (h.node >= 0) {
      const i = h.node, out = m.edges.filter((e) => e.i === i).sort((a, c) => c.p - a.p);
      html = `<b>${esc(m.labels[i])}</b>${m.start === i ? ' <span class="dim">· start</span>' : ""}${occ ? ` <span class="dim">· ${Math.round(occ[i] * 1000) / 10}% of paths</span>` : ""}<br>`
        + (m.absorb.has(i) ? "absorbing — paths stay here" : out.map((e) => `→ ${esc(m.labels[e.j])} <b>${fmtp(e.p)}</b>`).join("<br>"));
    } else {
      const e = geo[h.edge].e;
      html = `${esc(m.labels[e.i])} → ${esc(m.labels[e.j])} <b>${fmtp(e.p)}</b>${e.raw != null && Math.abs(e.raw - e.p) > 5e-4 && !e.synth ? ` <span class="dim">(typed ${fmtp(e.raw)}, scaled)</span>` : ""}<br>`
        + (e.synth ? '<span class="dim">added: this state has no way out</span>' : `<span class="dim">line ${e.line + 1} · click to edit it</span>`);
    }
    tip.innerHTML = html; tip.hidden = false;
    tip.style.left = Math.min(x + 14, stage.clientWidth - 230) + "px"; tip.style.top = Math.min(y + 14, stage.clientHeight - 70) + "px";
  };
  cv.onmouseleave = () => { hover = { node: -1, edge: -1 }; tip.hidden = true; draw(); };
  cv.onclick = (ev) => {
    const b = cv.getBoundingClientRect(), h = hit(ev.clientX - b.left, ev.clientY - b.top);
    if (h.edge >= 0 && geo[h.edge].e.line != null) onLine(geo[h.edge].e.line);
    else if (h.node >= 0) { const ls = m.edges.filter((e) => e.i === h.node && e.line != null).map((e) => e.line); if (ls.length) onLine(Math.min(...ls)); onState(h.node); }
  };
  new ResizeObserver(() => draw()).observe(stage);

  return {
    update(model) { m = model; labels = m.labels; lint(); draw(); },
    setOccupancy(shares, isStale) { occ = shares; stale = !!isStale; lint(); draw(); },
    get model() { return m; },
  };
}
