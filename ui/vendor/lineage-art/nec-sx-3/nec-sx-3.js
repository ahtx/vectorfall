// NEC SX-3 (1990). Measured from the NEC press photo in the IPSJ Computer Museum (study only, see reference/):
// three long, low cabinets standing parallel and staggered: 1.45 m tall, 0.70 m wide (end face 0.48 x its height), 3.8 / 3.6 / 2.4 m long (height 0.38 x length).
// Long sides of cream panels 0.30 m wide with dark grey bands 0.22 m wide after every third panel; a black
// perforated top deck inside a 0.06 m cream rim, its front edge chamfered 0.08 m; the end facing the room is dark
// grey on the first unit (with the SX-3 badge) and red on the second; a dark 0.06 m plinth.
import { makeKit } from "../lib/kit.js";

export const meta = {
  id: "nec-sx-3", name: "NEC SX-3", year: 1990, footprint_m: [3.1, 5.6], height_m: 1.45,
  maker: "NEC", real_count: "1 system (SX-3/44R: 4 processors)",
  sources: ["https://museum.ipsj.or.jp/en/computer/super/0011.html"],
  view: { yaw: -38, pitch: 18, dist: 8.0, target: [0, 0.7, 0] },
};
export const S = { h: 1.45, d: 0.70, plinth: 0.06, panel: 0.30, band: 0.22, rim: 0.06, chamfer: 0.08,
  units: [{ L: 3.8, x: 0.6, z: 0.0, end: "grey", badge: true }, { L: 3.6, x: -0.6, z: 0.4, end: "red" }, { L: 2.4, x: 1.8, z: 2.2, end: "grey" }] };
const PALETTES = { vectorfall: { cream: "#d9d6d0", band: "#2b2c30", red: "#c20a06", end: "#2b2c30" }, museum: { cream: "#d8d1bf", band: "#55575c", red: "#b8262a", end: "#55575c" } };

export function build(THREE, { palette = "vectorfall" } = {}) {
  const K = makeKit(THREE, { palette, palettes: PALETTES }), PAL = K.PAL, g = new THREE.Group(), add = (m) => (g.add(m), m);
  const { h, d } = S, base = K.M.black(0x141416, 0.5);
  const cream = K.M.paint(PAL.cream, { seed: 101, grain: 0.03, roughness: 0.5 }), band = K.M.paint(PAL.band, { seed: 102, roughness: 0.45 });
  const red = K.M.paint(PAL.red, { seed: 103, roughness: 0.4, clearcoat: 0.5 }), endG = K.M.paint(PAL.end, { seed: 104, roughness: 0.45 });
  const deckT = K.canvasTex(256, 256, (c, W, H) => { c.fillStyle = "#121214"; c.fillRect(0, 0, W, H); c.fillStyle = "#2c2d31"; for (let y = 2; y < H; y += 6) for (let x = 2; x < W; x += 6) c.fillRect(x, y, 3, 3); }, { repeat: true });
  deckT.repeat.set(4, 4); const deck = K.M.tex(deckT, { roughness: 0.6, metalness: 0.3 });
  const badge = new THREE.MeshStandardMaterial({ map: K.plateTex([["SX-3", "900 90px Arial Black, Arial", 0.68]], { w: 256, h: 128, bg: "#1b1c20", fg: "#e8e9ec", border: null }), roughness: 0.4 });
  for (const u of S.units) {
    const z0 = u.z - u.L / 2, z1 = u.z + u.L / 2, x = u.x;
    add(K.box(d - 0.04, S.plinth, u.L - 0.04, base, { x, z: u.z }));
    // body: side profile with the chamfered front top edge, extruded across the unit's width (x)
    const prof = [[z0, S.plinth], [z1, S.plinth], [z1, h], [z0 + S.chamfer, h], [z0, h - S.chamfer]];
    add(K.profile(prof.map(([z, y]) => [-z, y]), -d / 2, d / 2, cream, { x, ry: Math.PI / 2 }));
    add(K.box(d - 2 * S.rim, 0.012, u.L - S.chamfer - 2 * S.rim, deck, { x, y: h, z: u.z + S.chamfer / 2 })); // perforated deck
    // dark bands and panel seams on both long sides
    const n = Math.floor(u.L / S.panel);
    for (let k = 1; k < n; k++) {
      const z = z0 + k * S.panel, isBand = k % 4 === 0;
      for (const s of [-1, 1]) add(K.box(0.008, h - S.plinth - (z < z0 + S.chamfer + 0.05 ? S.chamfer : 0.01), isBand ? S.band : 0.006, isBand ? band : base, { x: x + s * (d / 2 + 0.003), y: S.plinth, z }));
    }
    // end facing the room (-z)
    add(K.box(d + 0.01, h - S.plinth - S.chamfer, 0.02, u.end === "red" ? red : endG, { x, y: S.plinth, z: z0 - 0.01 }));
    if (u.badge) add(K.mesh(new THREE.BoxGeometry(0.30, 0.15, 0.006), [base, base, base, base, base, badge], { x, y: h * 0.7, z: z0 - 0.024 }));
  }
  return K.finish(g);
}
