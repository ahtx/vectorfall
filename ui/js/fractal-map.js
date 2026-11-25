// The fractal as a real map: 256 px tiles on a z/x/y pyramid, rendered by the card, drawn with every control a map
// has. Wheel zoom at the cursor (smooth), double-click flies that point to the centre while zooming in (shift: out),
// drag with inertia, pinch, and placeholders: while a tile renders, its parent (scaled up) or the last frame stands in.
// The exact centre is S.cx/S.cy (BigInt, 10^-80 units); tiles are addressed from an anchor that moves as you dive,
// so no coordinate here ever needs more than a double's precision (a floating origin).
const TILE = 256, TW0 = 4.0, D80 = 1e80, MAXQ = 4;

export function createMap(cv, S, { bf, bfStr, onView, onMeta, overlay }) {
  const M = { anchor: null, tiles: new Map(), queue: [], live: 0, gen: 0, sess: Math.random().toString(36).slice(2, 10), anim: null, back: null, dirty: true };
  const g = cv.getContext("2d");
  const size = () => ({ W: cv.clientWidth || 1, H: cv.clientHeight || 1, dpr: Math.min(window.devicePixelRatio || 1, 2) });
  const level = (W, dpr) => Math.max(0, Math.ceil(Math.log2(TW0 * (W / S.scale) * dpr / TILE) - 0.15));
  const tw = (z) => TW0 / 2 ** z;
  const big = (v) => Number(v) / D80;                              // a BigInt difference -> a Number (the difference is small)
  const trim = (v) => bfStr(v).replace(/0+$/, "").replace(/\.$/, "");
  function anchorFor(z) {
    const A = M.anchor;
    if (A && A.kind === S.kind) {                       // valid at any depth while the view stays near it
      const u = big(S.cx - A.cx) / tw(z), v = big(S.cy - A.cy) / tw(z);
      if (Math.abs(u) < 1e6 && Math.abs(v) < 1e6) return A;
    }
    // a new anchor: the current centre, exact (the tiles of the old one stay as the backdrop until replaced)
    return setAnchor(S.cx, S.cy, z);
  }
  function setAnchor(cx, cy, z) { M.anchor = { cx, cy, z, kind: S.kind, id: Math.random().toString(36).slice(2, 8), ax: trim(cx), ay: trim(cy) }; return M.anchor; }
  const style = () => [S.kind, S.palette, S.density, S.kind === "julia" ? S.jr + "," + S.ji : ""].join("|");
  const keyOf = (A, z, x, y) => `${A.id}|${style()}|${z}|${x}|${y}`;
  function want(A, z, x, y, pri) {
    const k = keyOf(A, z, x, y), t = M.tiles.get(k);
    if (t) { t.used = performance.now(); return t; }
    const n = { k, A, z, x, y, img: null, state: "queued", pri, used: performance.now() };
    M.tiles.set(k, n); M.queue.push(n);
    return n;
  }
  function pump() {
    M.queue.sort((a, b) => a.pri - b.pri);
    while (M.live < MAXQ && M.queue.length) {
      const t = M.queue.shift(); if (t.state !== "queued") continue;
      t.state = "loading"; M.live++;
      const q = encodeURIComponent;
      fetch(`/api/fractal/tile?kind=${S.kind}&ax=${q(t.A.ax)}&ay=${q(t.A.ay)}&z=${t.z}&x=${t.x}&y=${t.y}&palette=${S.palette}&density=${S.density}&jr=${S.jr}&ji=${S.ji}&sess=${M.sess}&gen=${M.gen}`)
        .then((r) => { if (r.status === 409) throw Object.assign(new Error("superseded"), { again: true }); if (!r.ok) throw new Error(r.status); const m = r.headers.get("X-Fractal"); if (m && onMeta) try { onMeta(JSON.parse(m)); } catch (e) { /* ignore */ } return r.blob(); })
        .then((b) => createImageBitmap(b)).then((img) => { t.img = img; t.state = "done"; M.dirty = true; })
        .catch((e) => { t.state = e.again ? "queued" : "failed"; if (e.again) M.tiles.delete(t.k); })
        .finally(() => { M.live--; pump(); });
    }
  }
  function prune() {                                    // keep the cache to ~600 tiles, least recently used out first
    if (M.tiles.size < 700) return;
    [...M.tiles.values()].filter((t) => t.state === "done").sort((a, b) => a.used - b.used).slice(0, M.tiles.size - 600).forEach((t) => { if (t.img && t.img.close) t.img.close(); M.tiles.delete(t.k); });
  }
  function draw() {
    const { W, H, dpr } = size();
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.imageSmoothingEnabled = true;
    g.fillStyle = "#050304"; g.fillRect(0, 0, W, H);
    const k = W / S.scale;                               // CSS px per unit of the complex plane
    // 1) the last full frame, moved to where it belongs now (instant feedback while tiles come in)
    if (M.back && M.back.kind === style()) {
      const b = M.back, f = b.scale / S.scale, ox = big(b.cx - S.cx) * k, oy = big(b.cy - S.cy) * k;
      g.globalAlpha = 1; g.drawImage(b.canvas, W / 2 + ox - (b.W * f) / 2, H / 2 + oy - (b.H * f) / 2, b.W * f, b.H * f);
    }
    // 2) the tiles of the right level, with an ancestor standing in for each missing one
    const z = level(W, dpr), A = anchorFor(z), T = tw(z), ts = T * k;
    const cu = big(S.cx - A.cx) / T, cvv = big(S.cy - A.cy) / T;   // the centre, in tiles from the anchor
    const x0 = Math.floor(cu - W / 2 / ts), x1 = Math.floor(cu + W / 2 / ts), y0 = Math.floor(cvv - H / 2 / ts), y1 = Math.floor(cvv + H / 2 / ts);
    let missing = 0;
    // coarse first: the tiles 3 levels up (16x fewer, cheap) are asked for before the sharp ones and stand in for them
    const zc = Math.max(0, z - 3), Tc = tw(zc), cuc = big(S.cx - A.cx) / Tc, cvc = big(S.cy - A.cy) / Tc, tsc = Tc * k;
    const inC = (t) => t.z === zc && t.x >= Math.floor(cuc - W / 2 / tsc) && t.x <= Math.floor(cuc + W / 2 / tsc) && t.y >= Math.floor(cvc - H / 2 / tsc) && t.y <= Math.floor(cvc + H / 2 / tsc);
    M.queue = M.queue.filter((t) => t.A === A && ((M.flying && t.pre) || inC(t) || (!M.flying && t.z === z && t.x >= x0 - 1 && t.x <= x1 + 1 && t.y >= y0 - 1 && t.y <= y1 + 1)) || (M.tiles.delete(t.k), false));
    if (zc < z) for (let y = Math.floor(cvc - H / 2 / tsc); y <= Math.floor(cvc + H / 2 / tsc); y++) for (let x = Math.floor(cuc - W / 2 / tsc); x <= Math.floor(cuc + W / 2 / tsc); x++) want(A, zc, x, y, -10 + Math.hypot(x + 0.5 - cuc, y + 0.5 - cvc));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const sx = W / 2 + (x - cu) * ts, sy = H / 2 + (y - cvv) * ts;
      const t = M.flying && zc < z ? M.tiles.get(keyOf(A, z, x, y)) : want(A, z, x, y, Math.hypot(x + 0.5 - cu, y + 0.5 - cvv));
      if (t && t.img) { t.used = performance.now(); g.drawImage(t.img, sx, sy, ts + 0.5, ts + 0.5); continue; }
      missing++;
      for (let up = 1; up <= 8 && z - up >= 0; up++) {               // a parent tile, cropped and scaled up
        const px = Math.floor(x / 2 ** up), py = Math.floor(y / 2 ** up), p = M.tiles.get(keyOf(A, z - up, px, py));
        if (p && p.img) { const n = 2 ** up, s = TILE / n; g.drawImage(p.img, (x - px * n) * s, (y - py * n) * s, s, s, sx, sy, ts + 0.5, ts + 0.5); break; }
      }
    }
    pump(); prune();
    if (!missing && !M.flying) M.back = { canvas: snapshot(W, H, dpr), cx: S.cx, cy: S.cy, scale: S.scale, W, H, kind: style() };
    M.loading = missing;
    if (overlay) overlay(g, (bx, by) => [W / 2 + big(bx - S.cx) * k, H / 2 + big(by - S.cy) * k], { W, H, k });   // pins, scale bar, visits
    if (onView) onView({ z, missing, A });
  }
  function snapshot(W, H, dpr) { const c = M.back && M.back.canvas && M.back.canvas.width === cv.width ? M.back.canvas : document.createElement("canvas"); c.width = cv.width; c.height = cv.height; c.getContext("2d").drawImage(cv, 0, 0); return c; }
  function loop() { if (M.dirty) { M.dirty = false; draw(); } if (M.anim && !M.anim()) M.anim = null; if (M.anim) M.dirty = true; requestAnimationFrame(loop); }
  requestAnimationFrame(loop);
  const refresh = () => { M.dirty = true; };
  // ---- navigation
  function zoomAbout(px, py, f) {                       // keep the plane point under (px, py) fixed
    const { W, H } = size(), k = W / S.scale, nk = k / f;
    const ox = px - W / 2, oy = py - H / 2;
    S.cx += bf(ox / k - ox / nk); S.cy += bf(oy / k - oy / nk); S.scale = Math.min(9, S.scale * f); refresh();
    if (S.scale > 4.8 && f > 1 && S.onFar && !M.far) { M.far = true; M.anim = null; wheelAcc = 0; M.wheeling = false; S.onFar(); }   // up to the globe
    if (S.scale < 3.6) M.far = false;
  }
  function animate(ms, step, done) {                   // step(t in 0..1, dt) per frame
    const t0 = performance.now(); let last = 0;
    M.anim = () => { const t = Math.min(1, (performance.now() - t0) / ms), e = 1 - (1 - t) ** 3; step(e, e - last); last = e; if (t >= 1) { done && done(); return false; } return true; };
    refresh();
  }
  let wheelAcc = 0, wheelAt = null;
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = cv.getBoundingClientRect(), dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    wheelAcc += dy; wheelAt = [e.clientX - r.left, e.clientY - r.top];
    if (!M.wheeling) { M.wheeling = true;
      M.anim = () => { const s = wheelAcc * 0.25; wheelAcc -= s; zoomAbout(wheelAt[0], wheelAt[1], Math.exp(s * 0.0022)); if (Math.abs(wheelAcc) < 0.5) { wheelAcc = 0; M.wheeling = false; settle(); return false; } return true; };
      refresh(); }
  }, { passive: false });
  cv.addEventListener("dblclick", (e) => {              // fly the clicked point to the centre while zooming in (shift: out)
    const r = cv.getBoundingClientRect(), { W, H } = size(), k = W / S.scale;
    const ox = (e.clientX - r.left - W / 2) / k, oy = (e.clientY - r.top - H / 2) / k, F = e.shiftKey ? 2.5 : 0.4;
    if (S.onBefore) S.onBefore();
    const c0x = S.cx, c0y = S.cy, s0 = S.scale;
    animate(420, (t) => { S.cx = c0x + bf(ox * t); S.cy = c0y + bf(oy * t); S.scale = s0 * F ** t; }, settle);
  });
  const ptrs = new Map(); let drag = null, vel = [0, 0], lastMove = 0, pinch = null;
  cv.addEventListener("pointerdown", (e) => {
    cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]); M.anim = null; M.flying = false;
    if (ptrs.size === 1) { if (S.onBefore) S.onBefore(); drag = { x: e.clientX, y: e.clientY }; vel = [0, 0]; lastMove = performance.now(); }
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) }; drag = null; }
  });
  cv.addEventListener("pointermove", (e) => {
    if (!ptrs.has(e.pointerId)) return; ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    const r = cv.getBoundingClientRect(), { W } = size(), k = W / S.scale;
    if (pinch && ptrs.size === 2) { const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); zoomAbout((a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top, pinch.d / d); pinch.d = d; return; }
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y, now = performance.now(), dt = Math.max(1, now - lastMove);
    vel = [0.8 * vel[0] + 0.2 * dx / dt, 0.8 * vel[1] + 0.2 * dy / dt]; lastMove = now;
    S.cx -= bf(dx / k); S.cy -= bf(dy / k); drag.x = e.clientX; drag.y = e.clientY; refresh();
  });
  const up = (e) => {
    ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null;
    if (drag && ptrs.size === 0) {
      drag = null;
      if (performance.now() - lastMove < 80 && Math.hypot(vel[0], vel[1]) > 0.05) {      // inertia: glide and slow down
        let [vx, vy] = vel;
        M.anim = () => { const { W } = size(), k = W / S.scale; S.cx -= bf(vx * 16 / k); S.cy -= bf(vy * 16 / k); vx *= 0.92; vy *= 0.92; refresh(); if (Math.hypot(vx, vy) < 0.02) { settle(); return false; } return true; };
      } else settle();
    }
  };
  cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
  cv.style.touchAction = "none";
  let settleT = null;
  function settle() { clearTimeout(settleT); settleT = setTimeout(() => { M.gen++; if (S.onSettle) S.onSettle(); }, 250); }
  if (window.ResizeObserver) new ResizeObserver(refresh).observe(cv);
  return {
    refresh,
    restyle() { M.gen++; fetch(`/api/fractal/supersede?sess=${M.sess}&gen=${M.gen}`, { method: "POST" }).catch(() => {}); refresh(); },
    zoomBy(f) { const { W, H } = size(); const s0 = S.scale; animate(300, (t, dt) => { zoomAbout(W / 2, H / 2, (s0 * f ** t) / S.scale); }, settle); },
    panBy(fx, fy) { const c0x = S.cx, c0y = S.cy, w = S.scale; animate(250, (t) => { S.cx = c0x + bf(fx * w * t); S.cy = c0y + bf(fy * w * t); }, settle); },
    flyTo(cx, cy, scale, ms) {                          // van Wijk & Nuij (2003): the optimal zoom-out, pan, zoom-in path
      const c0x = S.cx, c0y = S.cy, w0 = S.scale, w1 = scale, dx = big(cx - c0x), dy = big(cy - c0y), d1 = Math.hypot(dx, dy), rho = 1.4;
      let path, Sl;
      if (d1 < 1e-300 || d1 < Math.min(w0, w1) * 1e-9) { Sl = Math.log(w1 / w0) / rho; path = (t) => [0, w0 * Math.exp(rho * t * Sl)]; }
      else {
        const b0 = (w1 * w1 - w0 * w0 + rho ** 4 * d1 * d1) / (2 * w0 * rho * rho * d1), b1 = (w1 * w1 - w0 * w0 - rho ** 4 * d1 * d1) / (2 * w1 * rho * rho * d1);
        const r0 = -Math.asinh(b0), r1 = -Math.asinh(b1);       // = log(sqrt(b^2+1) - b), without the cancellation at deep zooms
        Sl = (r1 - r0) / rho;
        // u = w0/(rho^2 d1) (cosh r0 tanh(rho s + r0) - sinh r0), w = w0 cosh r0 / cosh(rho s + r0), in forms that do not overflow
        const lcosh = (x) => Math.abs(x) + Math.log1p(Math.exp(-2 * Math.abs(x))) - Math.LN2;
        path = (t) => {
          const s = t * Sl, a = rho * s + r0;
          const u = w0 / (rho * rho * d1) * Math.exp(lcosh(r0)) * (Math.tanh(a) - Math.tanh(r0));
          return [Math.min(1, Math.max(0, u)), w0 * Math.exp(lcosh(r0) - lcosh(a))];
        };
      }
      const T = ms || Math.max(500, Math.min(9000, 260 * Math.abs(Sl)));
      const { W, H, dpr } = size(), A = setAnchor(cx, cy, level(W, dpr));   // the anchor waits at the destination
      M.flying = true;
      for (let i = 1; i <= 12; i++) {                    // the coarse tiles along the path, asked for in the order they are needed
        const [u, sc] = path(i / 12), ox = (u - 1) * dx, oy = (u - 1) * dy;
        const zc = Math.max(0, Math.ceil(Math.log2(TW0 * (W / sc) * dpr / TILE) - 0.15) - (i < 12 ? 3 : 0)), T2 = tw(zc), ts2 = T2 * (W / sc), cu2 = ox / T2, cv2 = oy / T2;
        for (let y = Math.floor(cv2 - H / 2 / ts2); y <= Math.floor(cv2 + H / 2 / ts2); y++) for (let x = Math.floor(cu2 - W / 2 / ts2); x <= Math.floor(cu2 + W / 2 / ts2); x++) { const t = want(A, zc, x, y, -200 + i * 12 + Math.hypot(x + 0.5 - cu2, y + 0.5 - cv2)); t.pre = true; }
      }
      pump();
      const t0 = performance.now();
      M.anim = () => {
        const t = Math.min(1, (performance.now() - t0) / T), e = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);   // ease in and out
        const [u, sc] = path(e);
        S.cx = c0x + bf(dx * u); S.cy = c0y + bf(dy * u); S.scale = sc;
        if (t >= 1) { S.cx = cx; S.cy = cy; S.scale = scale; M.flying = false; refresh(); settle(); return false; }
        return true;
      };
      refresh();
    },
    state: () => ({ loading: M.loading || 0, anchor: M.anchor, level: M.anchor && M.anchor.z, back: M.back ? { scale: M.back.scale, kind: M.back.kind, now: style(), dx: big(M.back.cx - S.cx) / S.scale, dy: big(M.back.cy - S.cy) / S.scale } : null, flying: !!M.flying, queue: M.queue.length, live: M.live }),
  };
}
