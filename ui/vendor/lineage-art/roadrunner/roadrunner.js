// IBM Roadrunner (2008, Los Alamos), the first sustained petaflop machine. Representative section: 2 rows x 8 racks.
// Measured from Commons photos (LANL hall, DOE photos, Poughkeepsie system test): black 42U racks 0.60 m wide,
// 1.10 m deep, 2.0 m tall with a perforated black front door; behind it four BladeCenter H chassis per rack
// (each 0.40 m tall: blade slots with blue status LEDs on the left, a pair of large fan grilles on the right),
// a 1U switch row of green LEDs between chassis pairs; black top fascia; red and grey cable bundles at the sides.
// Real machine: 296 racks (17 connected units, 6,480 Opteron + 12,960 PowerXCell 8i processors).
import { makeKit } from "../lib/kit.js";

export const meta = {
  id: "roadrunner", name: "IBM Roadrunner", year: 2008, footprint_m: [4.8, 4.1], height_m: 2.0,
  maker: "IBM", real_count: "296 racks (section shows 2 rows x 8)",
  sources: [
    "https://commons.wikimedia.org/wiki/File:Roadrunner_supercomputer_HiRes.jpg",
    "https://commons.wikimedia.org/wiki/File:U.S._Department_of_Energy_-_Science_-_393_006_005_(9631392606).jpg",
    "https://commons.wikimedia.org/wiki/File:Roadrunner_undergoing_system_test_in_Poughkeepsie_in_June_2008_Image_1.jpg",
    "https://commons.wikimedia.org/wiki/File:U.S._Department_of_Energy_-_Science_-_393_005_005_(9631392404).jpg",
  ],
  view: { yaw: -32, pitch: 12, dist: 8.6, target: [0, 1.0, 0] },
};
export const S = { rows: 2, per: 8, w: 0.60, d: 1.10, h: 2.0, aisle: 1.9, chassis: 4, chH: 0.40 };
const PALETTES = { vectorfall: { led: "#5ab4ff", accent: "#c20a06" }, museum: { led: "#3d7dff", accent: "#151518" } };

export function build(THREE, { palette = "vectorfall" } = {}) {
  const K = makeKit(THREE, { palette, palettes: PALETTES }), PAL = K.PAL, g = new THREE.Group(), add = (m) => (g.add(m), m);
  const { w, d, h, per } = S, black = K.M.carbon(), deep = K.M.black(0x0b0b0d, 0.5);
  const front = K.canvasTex(256, 1024, (c, W, H) => { // rack front seen through the perforated door
    c.fillStyle = "#08080a"; c.fillRect(0, 0, W, H); const r = K.rng(9);
    const y0 = 90, ch = 190;
    for (let k = 0; k < S.chassis; k++) {
      const y = y0 + k * (ch + 14) + (k >= 2 ? 26 : 0);
      c.fillStyle = "#1c1d21"; c.fillRect(10, y, W - 20, ch);
      for (let s = 0; s < 8; s++) { const x = 16 + s * 15; c.fillStyle = "#2c2e33"; c.fillRect(x, y + 6, 12, ch - 12); c.fillStyle = r() < 0.8 ? PAL.led : "#ffb030"; c.fillRect(x + 4, y + 10, 4, 4); }
      for (const fx of [140, 196]) { c.fillStyle = "#2a2b2f"; c.fillRect(fx, y + 20, 50, ch - 40); c.strokeStyle = "#0a0a0b"; c.lineWidth = 2; // a pair of fan grilles
        for (let q = 4; q < 24; q += 5) { c.beginPath(); c.arc(fx + 25, y + ch / 2, q, 0, 7); c.stroke(); } }
      if (k === 1) { c.fillStyle = "#16171a"; c.fillRect(10, y + ch + 4, W - 20, 18); for (let x = 20; x < W - 20; x += 9) { c.fillStyle = r() < 0.5 ? "#35ff6a" : "#0d3a18"; c.fillRect(x, y + ch + 10, 3, 3); } }
    }
    c.fillStyle = "rgba(0,0,0,.38)"; for (let y = 0; y < H; y += 4) for (let x = (y / 4) % 2 ? 2 : 0; x < W; x += 4) c.fillRect(x, y, 2, 2); // perforation
  });
  const door = new THREE.MeshStandardMaterial({ map: front, emissiveMap: front, emissive: 0xffffff, emissiveIntensity: 0.55, roughness: 0.6, metalness: 0.3 });
  const accent = K.M.paint(PAL.accent, { seed: 31, roughness: 0.4 });
  const L = per * w, Dt = S.rows * d + (S.rows - 1) * S.aisle;
  for (let r = 0; r < S.rows; r++) {
    const z = -Dt / 2 + d / 2 + r * (d + S.aisle);
    for (let i = 0; i < per; i++) {
      const x = L / 2 - (i + 0.5) * w;
      add(K.box(w - 0.006, h, d, [black, black, black, deep, black, door], { x, z }));
      add(K.box(w - 0.03, 0.03, 0.02, deep, { x, y: h - 0.10, z: z - d / 2 - 0.01 })); // top fascia lip
    }
    for (const s of [-1, 1]) add(K.box(0.05, h, d + 0.04, accent, { x: s * (L / 2 + 0.025), z })); // row end panels
  }
  return K.finish(g);
}
