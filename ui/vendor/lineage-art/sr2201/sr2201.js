// Hitachi SR2201 (1996, University of Tokyo; #1 June 1996). Representative section: 2 rows x 4 cabinet pairs.
// Measured from the Hitachi photo in the IPSJ Computer Museum (study only, see reference/): copper-coloured
// cabinets 0.74 m wide (0.37 x the height), 2.00 m tall, depth 1.0 m (estimated), standing in pairs with a 0.06 m
// dark gap between pairs; a row of 10 vent slots 0.10 m below the top of every front, a small badge under the
// slots on the first cabinet of each pair, rivet dots down the door edges, a black 0.05 m plinth.
// Real machine: 1,024 processing elements.
import { makeKit } from "../lib/kit.js";

export const meta = {
  id: "sr2201", name: "Hitachi SR2201", year: 1996, footprint_m: [6.3, 4.0], height_m: 2.0,
  maker: "Hitachi", real_count: "1,024 processing elements (section shows 2 rows x 4 cabinet pairs)",
  sources: ["https://museum.ipsj.or.jp/en/computer/super/0016.html"],
  view: { yaw: -38, pitch: 10, dist: 9.6, target: [0, 1.0, 0] },
};
export const S = { rows: 2, pairs: 4, w: 0.74, d: 1.0, h: 2.0, gap: 0.06, aisle: 2.0, plinth: 0.05 };
const PALETTES = { vectorfall: { body: "#c20a06" }, museum: { body: "#b9755a" } };

export function build(THREE, { palette = "vectorfall" } = {}) {
  const K = makeKit(THREE, { palette, palettes: PALETTES }), PAL = K.PAL, g = new THREE.Group(), add = (m) => (g.add(m), m);
  const { w, d, h } = S, base = K.M.black(0x111113, 0.5);
  const body = K.M.paint(PAL.body, { seed: 121, roughness: 0.42, grain: 0.05 });
  const doorTex = (badge) => K.canvasTex(256, 640, (c, W, H) => {
    c.fillStyle = "rgba(0,0,0,0)"; c.clearRect(0, 0, W, H);
    for (let k = 0; k < 10; k++) { c.fillStyle = "#1a1210"; c.fillRect(36 + k * 19, 34, 8, 30); }
    if (badge) { c.fillStyle = "#3a2a22"; c.fillRect(100, 80, 60, 10); }
    c.fillStyle = "rgba(40,20,15,.6)"; for (let y = 120; y < H - 20; y += 60) { c.beginPath(); c.arc(14, y, 2.5, 0, 7); c.fill(); c.beginPath(); c.arc(W - 14, y, 2.5, 0, 7); c.fill(); }
  });
  const decal = [doorTex(true), doorTex(false)].map((t) => new THREE.MeshStandardMaterial({ map: t, transparent: true, roughness: 0.5 }));
  const pairW = 2 * w + S.gap, L = S.pairs * pairW, Dt = S.rows * d + (S.rows - 1) * S.aisle;
  for (let r = 0; r < S.rows; r++) {
    const z = -Dt / 2 + d / 2 + r * (d + S.aisle);
    for (let p = 0; p < S.pairs; p++) for (let k = 0; k < 2; k++) {
      const x = L / 2 - S.gap / 2 - p * pairW - (k + 0.5) * w;
      add(K.box(w - 0.004, S.plinth, d - 0.04, base, { x, z }));
      add(K.box(w - 0.004, h - S.plinth, d, body, { x, y: S.plinth, z }));
      add(K.box(w - 0.02, h - S.plinth - 0.02, 0.002, decal[k], { x, y: S.plinth, z: z - d / 2 - 0.002, print: false })); // vents and rivets
    }
    for (let p = 0; p <= S.pairs; p++) add(K.box(S.gap, h - 0.02, d - 0.02, base, { x: L / 2 - p * pairW, z })); // dark gaps between pairs
  }
  return K.finish(g);
}
