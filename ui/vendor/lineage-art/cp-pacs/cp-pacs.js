// CP-PACS (Hitachi and the University of Tsukuba, 1996; #1 November 1996). Representative section: two parallel
// rows of 10 cabinets. Measured from the photo in the IPSJ Computer Museum (study only, see reference/): slate-blue
// cabinets 0.70 m wide, 1.95 m tall, depth 1.0 m (estimated), set in pairs with a dark recessed joint 0.05 m wide
// between pairs; flat doors with a hairline seam; a small name plate low on the row end; an aisle 1.6 m wide.
// Real machine: 2,048 processing units (later 2,172 with I/O units).
import { makeKit } from "../lib/kit.js";

export const meta = {
  id: "cp-pacs", name: "CP-PACS", year: 1996, footprint_m: [7.5, 3.6], height_m: 1.95,
  maker: "Hitachi / University of Tsukuba", real_count: "2,048 processing units (section shows 2 rows x 10 cabinets)",
  sources: ["https://museum.ipsj.or.jp/en/computer/super/0021.html"],
  view: { yaw: -48, pitch: 14, dist: 10.5, target: [0, 1.0, 0] },
};
export const S = { rows: 2, per: 10, w: 0.70, d: 1.0, h: 1.95, joint: 0.05, aisle: 1.6 };
const PALETTES = { vectorfall: { body: "#c20a06", joint: "#16171a" }, museum: { body: "#333d55", joint: "#141824" } };

export function build(THREE, { palette = "vectorfall" } = {}) {
  const K = makeKit(THREE, { palette, palettes: PALETTES }), PAL = K.PAL, g = new THREE.Group(), add = (m) => (g.add(m), m);
  const { w, d, h, per } = S, base = K.M.black(0x111113, 0.5), joint = K.M.black(PAL.joint, 0.5), seam = K.M.black(0x15171c, 0.5);
  const body = K.M.paint(PAL.body, { seed: 131, roughness: 0.45, grain: 0.04 });
  const plate = new THREE.MeshStandardMaterial({ map: K.plateTex([["CP-PACS", "800 54px Arial", 0.68]], { w: 256, h: 96, bg: "#d8dade", fg: "#20242c", border: null }), roughness: 0.4 });
  const nJ = per / 2 - 1, L = per * w + nJ * S.joint, Dt = S.rows * d + (S.rows - 1) * S.aisle;
  for (let r = 0; r < S.rows; r++) {
    const z = -Dt / 2 + d / 2 + r * (d + S.aisle);
    let x = L / 2;
    for (let i = 0; i < per; i++) {
      const cx = x - w / 2;
      add(K.box(w - 0.004, 0.05, d - 0.04, base, { x: cx, z }));
      add(K.box(w - 0.004, h - 0.05, d, body, { x: cx, y: 0.05, z }));
      add(K.box(0.004, h - 0.2, 0.004, seam, { x: cx, y: 0.1, z: z - d / 2 - 0.002 }));
      x -= w;
      if (i % 2 === 1 && i < per - 1) { add(K.box(S.joint, h - 0.03, d - 0.06, joint, { x: x - S.joint / 2, z })); x -= S.joint; }
    }
    add(K.mesh(new THREE.BoxGeometry(0.004, 0.08, 0.22), [plate, plate, plate, plate, plate, plate], { x: -L / 2 - 0.004, y: 0.45, z: z - d * 0.25 }));
  }
  return K.finish(g);
}
