// Intel ASCI Red (1997, Sandia), the first teraflop machine. Representative section: 2 rows x 8 cabinets.
// Only one free photo was found (Sandia hall, 330 px): long rows of off-white cabinets with a teal band at the
// top and teal row-end panels, a waist-high console beside them. Measured: cabinet height 1.85 m (about 2.3 x the
// console desk), cabinets 0.60 m wide (door seams), depth 1.2 m estimated; top band 0.10 of the height.
// Detail is limited by the photo. Real machine: 104 cabinets (76 compute), 9,298 Pentium Pro processors.
import { makeKit } from "../lib/kit.js";

export const meta = {
  id: "asci-red", name: "Intel ASCI Red", year: 1997, footprint_m: [4.9, 4.4], height_m: 1.85,
  maker: "Intel / Sandia", real_count: "104 cabinets (section shows 2 rows x 8)",
  sources: ["https://commons.wikimedia.org/wiki/File:Asci_red_-_tflop4m.jpeg"],
  view: { yaw: -40, pitch: 14, dist: 8.6, target: [0, 0.9, 0] },
};
export const S = { rows: 2, per: 8, w: 0.60, d: 1.2, h: 1.85, aisle: 2.0, band: 0.10 };
const PALETTES = { vectorfall: { body: "#e3e1dc", band: "#c20a06" }, museum: { body: "#e6e3da", band: "#2f8a86" } };

export function build(THREE, { palette = "vectorfall" } = {}) {
  const K = makeKit(THREE, { palette, palettes: PALETTES }), PAL = K.PAL, g = new THREE.Group(), add = (m) => (g.add(m), m);
  const { w, d, h, per } = S, body = K.M.paint(PAL.body, { seed: 61, grain: 0.03, roughness: 0.55 }), band = K.M.paint(PAL.band, { seed: 62, roughness: 0.45 });
  const seam = K.M.black(0x9a9892, 0.6), deep = K.M.black(0x2a2a2c, 0.6);
  const L = per * w, Dt = S.rows * d + (S.rows - 1) * S.aisle, hb = h * (1 - S.band);
  for (let r = 0; r < S.rows; r++) {
    const z = -Dt / 2 + d / 2 + r * (d + S.aisle);
    for (let i = 0; i < per; i++) {
      const x = L / 2 - (i + 0.5) * w;
      add(K.box(w - 0.004, 0.05, d - 0.03, deep, { x, z }));
      add(K.box(w - 0.004, hb - 0.05, d, body, { x, y: 0.05, z }));
      add(K.box(w - 0.004, h - hb, d, band, { x, y: hb, z }));
      add(K.box(0.004, hb - 0.15, 0.004, seam, { x: x + w / 2 - 0.003, y: 0.1, z: z - d / 2 - 0.002 }));
      add(K.box(0.012, 0.1, 0.012, seam, { x: x - w / 2 + 0.06, y: 0.95, z: z - d / 2 - 0.006 }));
    }
    for (const s of [-1, 1]) add(K.box(0.05, h, d + 0.02, band, { x: s * (L / 2 + 0.025), z }));
  }
  return K.finish(g);
}
