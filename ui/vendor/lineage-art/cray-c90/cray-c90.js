// Cray C90 (1991). Measured from Commons photos (Computer Museum of America; C90 front panel).
// A rounded tower 2.10 m tall, 1.10 m across (width 0.5 x height): 9 slate-blue columns in 10 equal slots
// around a circle of radius 0.55 m, each curved, alternate columns 18 mm proud so they overlap like petals, separated by 14 mm black seams, the opening slot at the back; one red column at the front (0.36 m wide,
// full height, proud by 0.03 m) carrying the operator display (a grey screen 0.20 x 0.15 m at 0.70 of the height
// in a dark bezel), a keypad below it and three horizontal joints; a red column at the back left; black lid and
// plinth 0.06 m. Real C90s: up to 16 processors in this one tower.
import { makeKit } from "../lib/kit.js";

export const meta = {
  id: "cray-c90", name: "Cray C90", year: 1991, footprint_m: [1.16, 1.16], height_m: 2.12,
  maker: "Cray Research", real_count: "1 machine (one tower, up to 16 CPUs)",
  sources: [
    "https://commons.wikimedia.org/wiki/File:Computer_Museum_of_America_(27).jpg",
    "https://commons.wikimedia.org/wiki/File:Computer_Museum_of_America_(46).jpg",
    "https://commons.wikimedia.org/wiki/File:Cray_C90_Frontpanel_(137062958).jpg",
  ],
  view: { yaw: -22, pitch: 10, dist: 4.6, target: [0, 1.02, 0], k: 1 },
};
export const S = { slots: 10, R: 0.55, rIn: 0.28, H: 2.10, plinth: 0.06, seam: 0.014, redW: 0.36 };
const PALETTES = { vectorfall: { slate: "#25272c", red: "#c20a06" }, museum: { slate: "#16202e", red: "#a3241d" } };

export function build(THREE, { palette = "vectorfall" } = {}) {
  const K = makeKit(THREE, { palette, palettes: PALETTES }), PAL = K.PAL, g = new THREE.Group(), add = (m) => (g.add(m), m);
  const slate = K.M.paint(PAL.slate, { seed: 91, roughness: 0.5, grain: 0.04 }), red = K.M.paint(PAL.red, { seed: 92, roughness: 0.4, clearcoat: 0.5 });
  const black = K.M.black(0x0c0c0e, 0.45), wire = K.M.black(0x1a1c22, 0.6);
  const { R, H, slots } = S, step = 2 * Math.PI / slots, sg = S.seam / R;
  for (let i = 0; i < slots; i++) {
    if (i === Math.floor(slots / 2) + 1) continue; // the opening, at the back
    const a = -step / 2 + i * step, b = a + step, isRed = i === 0 || i === Math.floor(slots / 2) + 2;
    add(K.wedge(a, b, S.rIn, R - 0.02, S.plinth, H, { all: wire }));
    const out = R + (i === 0 ? 0.03 : i % 2 ? 0.018 : 0); // columns overlap like petals: alternate radii
    for (let q = 0; q < 3; q++) { // three facets per column so the panels read as curved
      const qa = a + sg / 2 + q * (step - sg) / 3, qb = qa + (step - sg) / 3;
      add(K.wedge(qa, qb, R - 0.03, out, S.plinth, H - 0.03, { all: isRed ? red : slate }));
    }
    add(K.wedge(a, b, S.rIn, R - 0.01, 0, S.plinth, { all: black }));
    add(K.wedge(a, b, 0.05, R + 0.005, H - 0.03, H + 0.02, { all: black }));
  }
  // operator display, keypad and joints on the front red column (front = -z)
  const zf = -(R + 0.03) * Math.cos(step / 6); // front of the middle facet
  add(K.box(0.26, 0.21, 0.02, black, { y: H * 0.70 - 0.03, z: zf - 0.008 }));
  const scr = new THREE.MeshStandardMaterial({ color: 0x9aa3a6, emissive: 0x4a5558, emissiveIntensity: 0.5, roughness: 0.2 });
  add(K.box(0.20, 0.15, 0.01, scr, { y: H * 0.70, z: zf - 0.02 }));
  for (let k = 0; k < 5; k++) add(K.box(0.03, 0.02, 0.012, black, { x: -0.08 + k * 0.04, y: H * 0.60, z: zf - 0.008 }));
  add(K.box(0.12, 0.03, 0.006, black, { y: H * 0.64, z: zf - 0.004 })); // badge
  for (const y of [0.42, 0.55, 0.80]) add(K.box(S.redW * 0.9, 0.008, 0.006, black, { y: H * y, z: zf - 0.003 }));
  return K.finish(g);
}
