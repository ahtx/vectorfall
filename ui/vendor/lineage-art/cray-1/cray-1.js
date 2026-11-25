// Cray-1 (1976). Geometry measured from museum photographs (Deutsches Museum, EPFL, Computer History Museum)
// and the published height. Units: metres. 12 wedge columns sit in 13.4 equal slots; the free slot is the opening.
import { makeKit } from "../lib/kit.js";

export const meta = {
  id: "cray-1", name: "Cray-1", year: 1976, footprint_m: [2.81, 2.25], height_m: 1.96,
  maker: "Cray Research", real_count: "1 machine (about 80 built)",
  sources: [
    "https://commons.wikimedia.org/wiki/File:Cray-1-deutsches-museum.jpg",
    "https://commons.wikimedia.org/wiki/File:Cray-1A_computer,_1976,_Computer_History_Museum_(1).jpg",
    "https://commons.wikimedia.org/wiki/File:Cray-1-p1010221.jpg",
    "https://commons.wikimedia.org/wiki/File:Cray_1_IMG_9126.jpg",
  ],
  view: { yaw: -30, pitch: 14, dist: 5.7, target: [0, 0.9, -0.147], camY: 0.95, k: 1 },
};

export const S = {
  columns: 12, slots: 13.4, rIn: 0.56, rOut: 0.75, h: 1.96, plinth: 0.50, cap: 0.03,
  benchIn: 0.75, benchOut: 1.42, benchH: 0.50, benchSegs: 5, benchSkip: 1, seam: 0.012,
};
// "vectorfall" = VectorFall's Rosso Corsa red (default); "museum" = the original tan-brown vinyl.
const PALETTES = { vectorfall: { panel: "#c20a06", bench: "#a80805" }, museum: { panel: "#9a4e27", bench: "#93491f" } };

export function build(THREE, { palette = "vectorfall" } = {}) {
  const K = makeKit(THREE, { palette, palettes: PALETTES }), PAL = K.PAL;
  const wireTex = () => K.canvasTex(512, 1024, (g) => { // hand-wired backplane behind glass: blue twisted pairs, yellow tags
    g.fillStyle = "#1a2638"; g.fillRect(0, 0, 512, 1024); const r = K.rng(11);
    for (let i = 0; i < 9000; i++) {
      const x = r() * 512, y = r() * 1024, l = 10 + r() * 40;
      g.strokeStyle = `rgba(${130 + r() * 70 | 0},${160 + r() * 60 | 0},${205 + r() * 45 | 0},${0.25 + r() * 0.55})`; g.lineWidth = 0.6 + r();
      g.beginPath(); g.moveTo(x, y); g.bezierCurveTo(x + (r() - .5) * l, y + (r() - .5) * l, x + (r() - .5) * l, y + (r() - .5) * l, x + (r() - .5) * l, y + (r() - .5) * l); g.stroke();
      if (r() < 0.004) { g.fillStyle = "rgba(220,175,70,.9)"; g.fillRect(x, y, 6, 4); }
    }
    g.fillStyle = "rgba(215,220,226,.55)"; for (const x of [168, 340]) g.fillRect(x, 0, 5, 1024); // door bars
  });
  const M = {
    panel: new THREE.MeshPhysicalMaterial({ color: 0xffffff, map: K.noiseTex(PAL.panel, 0.06, 3), roughness: 0.48, clearcoat: 0.35, clearcoatRoughness: 0.35 }),
    bench: new THREE.MeshPhysicalMaterial({ color: 0xffffff, map: K.noiseTex(PAL.bench, 0.06, 5), roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.4 }),
    plinth: K.M.black(0x141416, 0.5), alu: K.M.alu(),
    wire: new THREE.MeshStandardMaterial({ map: wireTex(), roughness: 0.35, metalness: 0.1 }),
    cable: new THREE.MeshStandardMaterial({ color: 0x8d9095, roughness: 0.5, metalness: 0.3 }),
  };
  const g = new THREE.Group(), add = (m) => (g.add(m), m), P = K.P;
  const strip = (a, r, y0, y1, w = 0.018) => { // aluminium edge trim between two column panels
    const p = P(a, r + w * 0.3, (y0 + y1) / 2); return K.mesh(new THREE.BoxGeometry(w, y1 - y0, w), M.alu, { x: p.x, y: p.y, z: p.z, ry: -a });
  };
  const step = 2 * Math.PI / S.slots, start = step / 2 + (step * (S.slots - S.columns - 1)) / 2;
  for (let i = 0; i < S.columns; i++) {
    const a = start + i * step, b = a + step, first = i === 0, last = i === S.columns - 1;
    add(K.wedge(a, b, S.rIn, S.rOut, 0, S.plinth, { all: M.plinth }));
    add(K.wedge(a, b, S.rIn, S.rOut, S.plinth, S.h - S.cap, { outer: M.panel, all: M.wire }));
    add(K.wedge(a, b, S.rIn - 0.004, S.rOut + 0.006, S.h - S.cap, S.h, { all: M.alu }));
    add(K.wedge(a, b, S.rOut - 0.01, S.rOut + 0.004, S.plinth - 0.012, S.plinth + 0.004, { all: M.alu })); // trim above the plinth
    add(strip(a, S.rOut, S.plinth, S.h - S.cap));
    if (last) add(strip(b, S.rOut, S.plinth, S.h - S.cap));
    if (first || last) add(strip(first ? a : b, S.rIn, S.plinth, S.h - S.cap, 0.014));
    add(K.wedge(a, b, S.rIn - 0.002, S.rIn, S.plinth, S.h - S.cap, { all: M.wire })); // wiring on the inner wall
  }
  { // the nameplate on the column to the right of the opening
    const t = K.plateTex([["CRAY-1", "900 82px Arial Black, Arial", 0.575], ["CRAY RESEARCH, INC.", "700 30px Arial", 0.85]]);
    const face = new THREE.MeshStandardMaterial({ map: t, roughness: 0.4, metalness: 0.3 });
    const a = start + (S.columns - 1) * step + step / 2, r = S.rOut * Math.cos(step / 2) + 0.004;
    add(K.mesh(new THREE.BoxGeometry(0.22, 0.07, 0.004), [M.plinth, M.plinth, M.plinth, M.plinth, face, M.plinth], { x: Math.sin(a) * r, y: S.h - 0.16, z: -Math.cos(a) * r, ry: Math.PI - a }));
  }
  // the bench (the "loveseat" over the power supplies), in segments two columns wide
  const bs = (S.columns - 2 * S.benchSkip) * step / S.benchSegs;
  for (let j = 0; j < S.benchSegs; j++) {
    const a = start + S.benchSkip * step + j * bs + S.seam, b = a + bs - 2 * S.seam;
    add(K.wedge(a, b, S.benchIn, S.benchOut, 0.05, S.benchH, { all: M.bench }));
    add(K.wedge(a, b, S.benchIn, S.benchOut - 0.03, 0, 0.05, { all: M.plinth }));
  }
  { // cables coiled on the floor inside the C
    const r = K.rng(5);
    for (let i = 0; i < 26; i++) {
      const R = 0.05 + r() * 0.12, rx = Math.PI / 2 + (r() - 0.5) * 0.4, x = (r() - 0.5) * 0.45, y = 0.02 + r() * 0.12, z = -0.05 + (r() - 0.5) * 0.4;
      add(K.mesh(new THREE.TorusGeometry(R, 0.009, 6, 28), M.cable, { x, y, z, rx, print: false }));
    }
  }
  return K.finish(g);
}
