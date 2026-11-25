// Cray X-MP (1982). Measured from Commons photos (Musee des Arts et Metiers, Barcelona Supercomputing Center,
// National Cryptologic Museum). The Cray-1 chassis grown taller and slimmer: 12 columns in 13.4 slots
// (the opening is one slot; its flank is a flat grey end of three stacked panels), black 15 mm seams between
// columns, a grey band under the panels, and a bench ring of 12 segments with rounded top edges around 10 columns.
// Proportions from the BSC photo: bench 0.50 m, tower above the bench 1.45 m, tower diameter 1.40 m,
// bench outer diameter 1.7 x tower diameter (Paris front view). Columns alternate two colours.
import { makeKit } from "../lib/kit.js";

export const meta = {
  id: "cray-xmp", name: "Cray X-MP", year: 1982, footprint_m: [2.6, 2.0], height_m: 1.95,
  maker: "Cray Research", real_count: "1 machine (about 190 X-MP systems built)",
  sources: [
    "https://commons.wikimedia.org/wiki/File:CRAY_X-MP_IMG_9135.jpg",
    "https://commons.wikimedia.org/wiki/File:BSC-CRAY-X-MP-EA-A.JPG",
    "https://commons.wikimedia.org/wiki/File:Cray_X-MP_at_the_National_Cryptologic_Museum.jpg",
    "https://commons.wikimedia.org/wiki/File:Cray_X-MP.jpg",
  ],
  view: { yaw: -28, pitch: 13, dist: 5.8, target: [0, 0.92, 0], k: 1 },
};
export const S = { columns: 12, slots: 13.4, rIn: 0.50, rOut: 0.70, benchH: 0.50, band: 0.08, h: 1.95, cap: 0.025, seam: 0.0075, benchOut: 1.20, benchSegs: 12, benchSkip: 1 };
const PALETTES = {
  vectorfall: { a: "#c20a06", b: "#7f0603", bench: "#a80805" },
  museum: { a: "#2c4fa8", b: "#e4bd1b", bench: "#2a4da3" }, // Paris machine: blue and yellow, blue bench
};

export function build(THREE, { palette = "vectorfall" } = {}) {
  const K = makeKit(THREE, { palette, palettes: PALETTES }), PAL = K.PAL, g = new THREE.Group(), add = (m) => (g.add(m), m);
  const grey = K.M.black(0x3a3d42, 0.5), seam = K.M.black(0x0e0e10, 0.45), alu = K.M.alu();
  const wireTex = K.canvasTex(256, 512, (c, w, h) => { c.fillStyle = "#20252c"; c.fillRect(0, 0, w, h); const r = K.rng(4);
    for (let y = 0; y < h; y += 6) { c.fillStyle = `rgba(190,190,180,${0.2 + r() * 0.3})`; c.fillRect(10, y, w - 20, 2); }
    for (let i = 0; i < 900; i++) { c.fillStyle = r() < 0.5 ? "rgba(200,60,50,.7)" : "rgba(220,220,220,.5)"; c.fillRect(r() * w, r() * h, 3, 2); } });
  const wire = K.M.tex(wireTex, { roughness: 0.4, metalness: 0.3 });
  const { rIn, rOut } = S, step = 2 * Math.PI / S.slots, start = Math.PI + step / 2 + (step * (S.slots - S.columns - 1)) / 2; // opening at the back
  const yb = S.benchH + S.band, yt = S.h - S.cap;
  for (let i = 0; i < S.columns; i++) {
    const a = start + i * step, b = a + step, first = i === 0, last = i === S.columns - 1;
    add(K.wedge(a, b, rIn, rOut - 0.01, 0, yb, { all: grey }));
    add(K.wedge(a + S.seam / rOut, b - S.seam / rOut, rIn, rOut, yb, yt, { outer: K.M.paint(i % 2 ? PAL.b : PAL.a, { seed: 3 + (i % 2) }), all: wire }));
    add(K.wedge(b - S.seam / rOut, b + S.seam / rOut, rIn + 0.01, rOut - 0.004, yb, yt, { all: seam }));
    if (first) add(K.wedge(a - S.seam / rOut, a + S.seam / rOut, rIn + 0.01, rOut - 0.004, yb, yt, { all: seam }));
    add(K.wedge(a, b, rIn - 0.004, rOut + 0.004, yt, S.h, { all: seam }));
    if (first || last) { // flat grey end of the C at the opening: three stacked panels
      const e = first ? a : b, s = first ? -1 : 1;
      for (let k = 0; k < 3; k++) add(K.wedge(e + s * 0.002, e + s * 0.012, rIn, rOut, yb + k * (yt - yb) / 3 + 0.006, yb + (k + 1) * (yt - yb) / 3 - 0.006, { all: grey }));
    }
  }
  // bench ring with rounded top edge (a chamfer step), seams between segments
  const bs = (S.columns - 2 * S.benchSkip) * step / S.benchSegs, bench = K.M.paint(PAL.bench, { seed: 5, roughness: 0.4, clearcoat: 0.5 });
  for (let j = 0; j < S.benchSegs; j++) {
    const a = start + S.benchSkip * step + j * bs + 0.006, b = a + bs - 0.012;
    add(K.wedge(a, b, rOut, S.benchOut, 0.05, S.benchH - 0.04, { all: bench }));
    add(K.wedge(a + 0.004, b - 0.004, rOut, S.benchOut - 0.025, S.benchH - 0.04, S.benchH, { all: bench }));
    add(K.wedge(a - 0.006, a + 0.006, rOut, S.benchOut - 0.01, 0.0, S.benchH - 0.01, { all: seam }));
    add(K.wedge(a, b, rOut, S.benchOut - 0.03, 0, 0.05, { all: seam }));
  }
  { const e = start + S.benchSkip * step + S.benchSegs * bs; add(K.wedge(e - 0.006, e, rOut, S.benchOut - 0.01, 0, S.benchH - 0.01, { all: seam })); }
  { // nameplate high on the column beside the opening
    const face = new THREE.MeshStandardMaterial({ map: K.plateTex([["CRAY X-MP", "900 70px Arial Black, Arial", 0.58], ["CRAY RESEARCH, INC.", "700 28px Arial", 0.85]]), roughness: 0.4, metalness: 0.3 });
    const a = start + (S.columns - 1) * step + step / 2, r = rOut * Math.cos(step / 2) + 0.004;
    add(K.mesh(new THREE.BoxGeometry(0.22, 0.07, 0.004), [seam, seam, seam, seam, face, seam], { x: Math.sin(a) * r, y: S.h - 0.14, z: -Math.cos(a) * r, ry: Math.PI - a }));
  }
  return K.finish(g);
}
