// Cray-2 (1985). The processor and memory stacks stand in a C-shaped tank of Fluorinert, seen through glass
// windows with rising bubbles; a separate heat-exchanger unit ("waterfall") shows the coolant falling in a glass box.
// Measured from Commons photos (Musee des Arts et Metiers / Bolo collection, Computer History Museum).
// Facts used: 16 equal slots, 15 closed columns (the 16th slot is the access opening at the back);
// cylinder height 0.89 x diameter (diameter 1.30 m, height 1.15 m); lower coloured band 0.37 of the height,
// window band 0.47, black top band 0.09; posts 0.42 of a face width; waterfall unit 1.10 m long with a
// 0.70 m glass coolant box on its ridge and five coloured fins on the end facing the tank.
import { makeKit } from "../lib/kit.js";

export const meta = {
  id: "cray-2", name: "Cray-2", year: 1985, footprint_m: [3.0, 1.3], height_m: 1.82,
  maker: "Cray Research", real_count: "1 machine (27 built)",
  sources: [
    "https://commons.wikimedia.org/wiki/File:Cray-2_IMG_9142.jpg",
    "https://commons.wikimedia.org/wiki/File:CRAY-2_IMG_8915-8913-8912a.jpg",
    "https://commons.wikimedia.org/wiki/File:CRAY-2_IMG_9140.jpg",
    "https://commons.wikimedia.org/wiki/File:Computer_Museum_Cray_2.jpg",
    "https://commons.wikimedia.org/wiki/File:Computer_Museum_Cray-2.jpg",
  ],
  view: { yaw: -24, pitch: 13, dist: 4.4, target: [0, 0.72, 0], k: 1.1 },
};

export const S = {
  slots: 16, columns: 15, R: 0.65, rCore: 0.30, H: 1.15, plinth: 0.05,
  band: 0.37, win: 0.47, post: 0.42, // fractions
  wf: { L: 1.10, D: 0.70, base: 0.30, shoulder: 0.82, ridge: 1.06, lean: 0.24, ridgeW: 0.16, glassW: 0.37, glassD: 0.12, glassH: 0.70, fins: 5, x: -1.45, z: -0.05 },
};
const PALETTES = {
  vectorfall: { a: "#c20a06", b: "#8e0704", fin: ["#c20a06", "#8e0704"], tint: "rgba(40,140,255,.28)" },
  museum: { a: "#a3191b", b: "#e0b21c", fin: ["#a3191b", "#e0b21c"], tint: "rgba(255,210,120,.10)" },
};

export function build(THREE, { palette = "vectorfall" } = {}) {
  const K = makeKit(THREE, { palette, palettes: PALETTES }), PAL = K.PAL;
  const g = new THREE.Group(), add = (m) => (g.add(m), m);
  const black = K.M.carbon(), shell = new THREE.MeshPhysicalMaterial({ color: 0x111113, roughness: 0.6, clearcoat: 0.15, clearcoatRoughness: 0.5 }), deep = K.M.black(0x0c0c0e, 0.45), glass = K.M.glass();
  const moduleTex = K.canvasTex(256, 512, (c, w, h) => { // stacked logic modules seen through the coolant
    c.fillStyle = "#26292b"; c.fillRect(0, 0, w, h); const r = K.rng(21);
    for (let y = 0; y < h; y += 16) {
      c.fillStyle = "#3b3a33"; c.fillRect(0, y, w, 3);
      for (let x = 4; x < w; x += 14) { const v = 120 + r() * 70 | 0; c.fillStyle = `rgb(${v},${v - 10},${v - 40})`; c.fillRect(x, y + 5, 9, 8); }
    }
    c.fillStyle = PAL.tint; c.fillRect(0, 0, w, h);
    const v = c.createLinearGradient(0, 0, 0, h); v.addColorStop(0, "rgba(255,255,255,.08)"); v.addColorStop(1, "rgba(0,0,0,.35)"); c.fillStyle = v; c.fillRect(0, 0, w, h);
  }, { repeat: true });
  const modules = K.M.tex(moduleTex, { roughness: 0.3, metalness: 0.4, emissiveMap: moduleTex, emissive: palette === "museum" ? 0x000000 : 0x2a6cff, emissiveIntensity: 0.18 });

  // ---- the tank
  const { R, rCore, H, slots, columns } = S, step = 2 * Math.PI / slots, pw = step * S.post / 2;
  const yBand = H * S.band, yWin = yBand + H * S.win, start = Math.PI + step / 2; // opening centred at the back (+z)
  const bubbles = [];
  for (let i = 0; i < columns; i++) {
    const a = start + i * step, b = a + step, first = i === 0, last = i === columns - 1;
    add(K.wedge(a, b, rCore, R - 0.035, 0, H, { sideA: first ? modules : null, sideB: last ? modules : null, all: deep }));
    add(K.wedge(a, b, rCore, R - 0.02, 0, S.plinth, { all: deep }));
    add(K.wedge(a + pw, b - pw, R - 0.035, R - 0.006, S.plinth + 0.012, yBand - 0.012, { outer: K.M.paint(i % 2 ? PAL.b : PAL.a, { seed: 3 + i }), all: deep }));
    add(K.wedge(a + pw, b - pw, R - 0.035, R - 0.022, yBand + 0.01, yWin - 0.01, { outer: modules, all: deep }));
    add(K.wedge(a + pw, b - pw, R - 0.012, R - 0.007, yBand + 0.01, yWin - 0.01, { all: glass }, { print: false, shadow: false }));
    add(K.wedge(a, b, R - 0.035, R - 0.004, yWin, H, { all: black })); // top band
    add(K.wedge(a, b, R - 0.035, R - 0.004, yBand - 0.012, yBand + 0.01, { all: black })); // sill between band and window
    for (const e of first ? [a, b] : [b]) add(K.wedge(e - pw, e + pw, R - 0.04, R + 0.006, S.plinth, H, { all: black })); // posts
    add(K.wedge(a, b, 0.06, R + 0.012, H, H + 0.03, { all: black })); // lid
    const r = K.rng(100 + i);
    for (let k = 0; k < 9; k++) { // bubbles in the coolant, in front of the modules
      const ang = a + pw + r() * (step - 2 * pw), rr = R - 0.016;
      const m = add(K.sphere(0.003 + r() * 0.005, K.M.coolant(0xcfe8ff, 0.7), { x: Math.sin(ang) * rr, z: -Math.cos(ang) * rr, print: false, shadow: false }, 8));
      bubbles.push({ m, y0: r(), v: 0.05 + r() * 0.08, lo: yBand + 0.02, hi: yWin - 0.02 });
    }
  }
  add(K.cyl(0.18, 0.02, deep, { y: H + 0.03 }, 40)); // centre hub on the lid

  // ---- the waterfall heat exchanger
  const W = S.wf, x0 = W.x, cool = K.M.coolant(0x3aa0ff, palette === "museum" ? 0.18 : 0.38);
  add(K.box(W.L, W.base, W.D, deep, { x: x0, z: W.z }));
  const half = W.D / 2, rw = W.ridgeW / 2;
  const body = [[-half, W.base], [half, W.base], [half - W.lean, W.shoulder], [rw, W.ridge], [-rw, W.ridge], [-half + W.lean, W.shoulder]];
  add(K.profile(body.map(([z, y]) => [z, y]), -W.L / 2 + 0.12, W.L / 2, shell, { x: x0, z: W.z, ry: Math.PI / 2 }));
  // a raised rib splits each sloped face into two panels
  add(K.profile(body.map(([z, y]) => [z * 1.03, W.base + (y - W.base) * 1.012]), -0.007, 0.007, deep, { x: x0 + 0.12, z: W.z, ry: Math.PI / 2 }));
  // five slats with coloured strips on the front of the end nearest the tank, stepping back in plan
  const fx0 = x0 + W.L / 2 - 0.30;
  add(K.box(0.30, W.shoulder - 0.02, 0.22, black, { x: fx0 + 0.15, z: W.z - half + 0.11 }));
  for (let f = 0; f < W.fins; f++) {
    const x = fx0 + 0.03 + f * 0.06, dz = (W.fins - 1 - f) * 0.018, hgt = W.shoulder - W.base - 0.02;
    add(K.box(0.05, hgt, 0.04, black, { x, y: W.base - 0.01, z: W.z - half - 0.02 - dz }));
    add(K.box(0.026, hgt - 0.22, 0.006, K.M.paint(PAL.fin[f % 2], { seed: 40 + f }), { x, y: W.base + 0.05, z: W.z - half - 0.042 - dz }));
  }
  // glass coolant box on the ridge
  const gy = W.ridge;
  add(K.box(W.glassW + 0.04, 0.03, W.glassD + 0.04, black, { x: x0, y: gy - 0.01, z: W.z }));
  add(K.box(W.glassW, W.glassH, W.glassD, glass, { x: x0, y: gy + 0.02, z: W.z, print: false, shadow: false }));
  const fallTex = K.canvasTex(128, 256, (c, w, h) => { // falling sheets of coolant
    c.fillStyle = "rgba(0,0,0,0)"; c.clearRect(0, 0, w, h); const r = K.rng(7);
    for (let i = 0; i < 70; i++) { const x = r() * w, l = 30 + r() * 90, y = r() * h; c.fillStyle = `rgba(200,230,255,${0.15 + r() * 0.35})`; c.fillRect(x, y, 1 + r() * 2, l); c.fillRect(x, y - h, 1 + r() * 2, l); }
  }, { repeat: true });
  const fall = new THREE.MeshStandardMaterial({ map: fallTex, transparent: true, depthWrite: false, emissive: 0x6fb6ff, emissiveMap: fallTex, emissiveIntensity: 0.5, roughness: 0.2 });
  add(K.box(W.glassW - 0.02, W.glassH * 0.92, W.glassD - 0.03, cool, { x: x0, y: gy + 0.03, z: W.z, print: false, shadow: false }));
  add(K.box(W.glassW - 0.03, W.glassH * 0.95, 0.004, fall, { x: x0, y: gy + 0.03, z: W.z - W.glassD / 2 + 0.02, print: false, shadow: false }));
  add(K.box(W.glassW + 0.03, 0.025, W.glassD + 0.03, black, { x: x0, y: gy + 0.02 + W.glassH, z: W.z })); // cap
  // nameplate on the top band, front
  const plate = new THREE.MeshStandardMaterial({ map: K.plateTex([["CRAY-2", "900 84px Arial Black, Arial", 0.6], ["CRAY RESEARCH, INC.", "700 28px Arial", 0.86]]), roughness: 0.4, metalness: 0.3 });
  { const a = 0, r = R * Math.cos(step / 2) + 0.005; add(K.mesh(new THREE.BoxGeometry(0.2, 0.064, 0.004), [deep, deep, deep, deep, plate, deep], { x: Math.sin(a) * r, y: (yWin + H) / 2, z: -Math.cos(a) * r, ry: Math.PI - a })); }

  return K.finish(g, (t) => {
    for (const b of bubbles) { const u = (b.y0 + t * b.v) % 1; b.m.position.y = b.lo + u * (b.hi - b.lo); }
    fallTex.offset.y = (t * 0.6) % 1;
  });
}
