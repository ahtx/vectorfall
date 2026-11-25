// Earth Simulator (NEC, 2002, JAMSTEC Yokohama). Representative section: 2 rows x 6 processor-node cabinets.
// Measured from Commons photos: the preserved interconnection cabinet IN-00-001 (pale blue, two doors, a grey
// vertical band 0.22 of the width carrying a red disc 0.30 of the width in a grey ring at 0.64 of the height,
// dark 0.06 m plinth) and the hall photo (rows of lavender-blue node cabinets whose row ends carry the band
// and disc). Cabinet 1.0 m wide, 1.4 m deep, 2.0 m tall (published node-cabinet size). Real machine:
// 320 node cabinets (640 nodes, 5,120 vector CPUs) and 65 interconnection cabinets in a 50 x 65 m hall.
// (ref1 is the later ES2 hall and is kept only for the row layout.)
import { makeKit } from "../lib/kit.js";

export const meta = {
  id: "earth-simulator", name: "Earth Simulator", year: 2002, footprint_m: [6.4, 4.2], height_m: 2.0,
  maker: "NEC", real_count: "320 node cabinets + 65 interconnection cabinets (section shows 2 rows x 6)",
  sources: [
    "https://commons.wikimedia.org/wiki/File:Earth_Simulator_PB111941.jpg",
    "https://commons.wikimedia.org/wiki/File:Earth_Simulator_PB111943.jpg",
    "https://commons.wikimedia.org/wiki/File:EarthSimulator.jpg",
  ],
  view: { yaw: -38, pitch: 16, dist: 9.5, target: [0, 0.95, 0] },
};
export const S = { rows: 2, per: 6, w: 1.0, d: 1.4, h: 2.0, plinth: 0.06, aisle: 1.4, gap: 0.004, band: 0.22, disc: 0.30, discY: 0.64 };
const PALETTES = {
  vectorfall: { body: "#c20a06", end: "#a80805", band: "brushed", disc: "#16171a" },
  museum: { body: "#6a72a8", end: "#6a72a8", band: "#b9bcc1", disc: "#c8281e" },
};

export function build(THREE, { palette = "vectorfall" } = {}) {
  const K = makeKit(THREE, { palette, palettes: PALETTES }), PAL = K.PAL, g = new THREE.Group(), add = (m) => (g.add(m), m);
  const { w, d, h } = S, base = K.M.black(0x16161a, 0.5), dark = K.M.black(0x101012, 0.4);
  const body = K.M.paint(PAL.body, { seed: 11, roughness: 0.42 }), endC = K.M.paint(PAL.end, { seed: 12, roughness: 0.42 });
  const band = PAL.band === "brushed" ? K.M.brushed("#c3c6cb") : K.M.paint(PAL.band, { seed: 13, grain: 0.03 });
  const disc = new THREE.MeshPhysicalMaterial({ color: PAL.disc, roughness: 0.3, clearcoat: 0.8 }), ring = K.M.alu();
  const L = S.per * w, Dtot = S.rows * d + (S.rows - 1) * S.aisle;
  for (let r = 0; r < S.rows; r++) {
    const z = -Dtot / 2 + d / 2 + r * (d + S.aisle);
    for (let i = 0; i < S.per; i++) {
      const x = -L / 2 + w / 2 + i * w;
      add(K.box(w - S.gap, S.plinth, d - 0.04, base, { x, z }));
      add(K.box(w - S.gap, h - S.plinth, d, body, { x, y: S.plinth, z }));
      // two doors: a seam and a handle
      add(K.box(0.006, h - S.plinth - 0.1, 0.006, dark, { x, y: S.plinth + 0.05, z: z - d / 2 - 0.002 }));
      add(K.box(0.015, 0.12, 0.02, dark, { x: x - 0.04, y: 1.05, z: z - d / 2 - 0.01 }));
    }
    // row end panel (-x end, the one the visitor walks past): band and disc
    const xe = -L / 2 - 0.03;
    add(K.box(0.06, h - S.plinth, d, endC, { x: xe, y: S.plinth, z }));
    add(K.box(0.06, S.plinth, d - 0.04, base, { x: xe, z }));
    add(K.box(0.012, h - S.plinth, d * S.band, band, { x: xe - 0.036, y: S.plinth, z }));
    const discR = d * S.disc / 2;
    add(K.mesh(new THREE.CylinderGeometry(discR * 1.18, discR * 1.18, 0.014, 48), ring, { x: xe - 0.045, y: h * S.discY, z, rz: Math.PI / 2 }));
    add(K.mesh(new THREE.CylinderGeometry(discR, discR, 0.024, 48), disc, { x: xe - 0.05, y: h * S.discY, z, rz: Math.PI / 2 }));
  }
  return K.finish(g);
}
