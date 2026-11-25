// Cray Y-MP (1988). Measured from Commons photos (NASA Goddard installation, Computer History Museum).
// The mainframe is a tall charcoal tower 2.00 m high, 1.30 m wide, 1.20 m deep: two red columns (0.30 m each,
// split by a 12 mm seam) at its left-front corner with a red return on the left side, a charcoal column to their
// right, then charcoal blocks stepping down to 1.62 m and 1.20 m; a low red bench (0.50 m high, two segments with
// a curved front, 0.75 m deep) wrapping the left-front corner; the I/O subsystem cabinet beside it (1.70 m, red upper panel over charcoal
// with three horizontal joints) and a red/charcoal SSD cabinet behind. Charcoal side panels carry diagonal seams.
import { makeKit } from "../lib/kit.js";

export const meta = {
  id: "cray-y-mp", name: "Cray Y-MP", year: 1988, footprint_m: [4.2, 2.6], height_m: 2.0,
  maker: "Cray Research", real_count: "1 machine (mainframe, I/O subsystem and SSD cabinets)",
  sources: [
    "https://commons.wikimedia.org/wiki/File:Cray_Y-MP_GSFC.jpg",
    "https://commons.wikimedia.org/wiki/File:Cray_Y-MP_(1988)_-_Computer_History_Museum_(2007-11-10_22.59.11_by_Carlo_Nardone).jpg",
    "https://commons.wikimedia.org/wiki/File:Cray_Y-MP_(1988)_-_Computer_History_Museum_(2007-11-10_23.01.07_by_Carlo_Nardone).jpg",
  ],
  view: { yaw: 34, pitch: 12, dist: 7.6, target: [0, 0.95, 0] },
};
export const S = { H: 2.0, W: 1.30, D: 1.20, red: 0.30, corner: 0.24, step1: 1.62, step2: 1.20, benchH: 0.46, benchOut: 0.62, ios: { w: 0.9, d: 1.0, h: 1.70, x: -1.75, z: 0.25 }, ssd: { w: 1.1, d: 0.8, h: 1.6, x: 2.6, z: 1.5 } };
const PALETTES = { vectorfall: { red: "#c20a06", grey: "#2a2b2f" }, museum: { red: "#d6331c", grey: "#4a4c52" } };

export function build(THREE, { palette = "vectorfall" } = {}) {
  const K = makeKit(THREE, { palette, palettes: PALETTES }), PAL = K.PAL, g = new THREE.Group(), add = (m) => (g.add(m), m);
  const red = K.M.paint(PAL.red, { seed: 81, roughness: 0.4, clearcoat: 0.45 }), seam = K.M.black(0x0e0e10, 0.45);
  const sideTex = K.canvasTex(256, 512, (c, W, H) => { c.fillStyle = PAL.grey; c.fillRect(0, 0, W, H); c.strokeStyle = "rgba(0,0,0,.55)"; c.lineWidth = 3;
    for (let k = -2; k < 4; k++) { c.beginPath(); c.moveTo(0, H * (0.25 * k + 0.5)); c.lineTo(W, H * (0.25 * k)); c.stroke(); }
    const v = c.createLinearGradient(0, 0, 0, H); v.addColorStop(0, "rgba(255,255,255,.08)"); v.addColorStop(1, "rgba(0,0,0,.3)"); c.fillStyle = v; c.fillRect(0, 0, W, H); });
  const grey = new THREE.MeshPhysicalMaterial({ map: sideTex, roughness: 0.5, clearcoat: 0.2, sheen: 0.2, sheenColor: new THREE.Color(0x888888) });
  const { H, W, D } = S, zf = -D / 2;
  // tower: the two red columns stand at its left-front corner (+x is left seen from the front), a tall charcoal
  // column on the right, then charcoal blocks stepping down to the right
  add(K.box(W, H, D, grey));
  const xr = W / 2 - S.red / 2 - 0.02;
  for (const k of [0, 1]) add(K.box(S.red, H - 0.04, 0.06, red, { x: xr - k * (S.red + 0.012), y: 0.02, z: zf - 0.03 }));
  add(K.box(0.012, H - 0.04, 0.05, seam, { x: xr - S.red / 2 - 0.006, y: 0.02, z: zf - 0.025 }));
  add(K.box(0.06, H - 0.04, D * 0.7, red, { x: W / 2 + 0.03, y: 0.02, z: zf + D * 0.35 })); // red return on the left side
  add(K.box(0.2, 0.05, 0.004, seam, { x: xr - S.red - 0.17, y: H * 0.8, z: zf - 0.002 })); // name badge on the charcoal column
  for (const [k, hh] of [[1, S.step1], [2, S.step2]]) {
    const x = -W / 2 - (k - 0.5) * S.corner * 1.6;
    add(K.box(S.corner * 1.6, hh, D * (1 - 0.08 * k), grey, { x, z: 0.04 * k }));
    for (const y of [0.55, 1.1]) if (y < hh) add(K.box(S.corner * 1.6 + 0.004, 0.01, D * (1 - 0.08 * k) + 0.004, seam, { x, y, z: 0.04 * k }));
  }
  // bench: two segments wrapping the tower's left-front corner, curved outer face
  const bx = W / 2 - 0.35, bz = zf + 0.35, r0 = 0.35, r1 = 0.35 + S.benchOut;
  for (const [a, b] of [[-0.25, 0.62], [0.64, 1.5]]) {
    const w1 = add(K.wedge(a, b, r0, r1, 0.04, S.benchH, { all: red })); w1.position.set(bx, 0, bz);
    const w2 = add(K.wedge(a, b, r0, r1 - 0.03, 0, 0.04, { all: seam })); w2.position.set(bx, 0, bz);
  }
  // charcoal wing cabinet to the left of the tower, behind the bench, with a thin red top edge
  add(K.box(0.75, 1.72, 1.0, grey, { x: W / 2 + 0.75, z: 0.65 })); add(K.box(0.77, 0.03, 1.02, red, { x: W / 2 + 0.75, y: 1.72, z: 0.65 }));
  // I/O subsystem cabinet (right seen from the front: -x)
  { const c = S.ios; add(K.box(c.w, c.h * 0.55, c.d, grey, { x: c.x, z: c.z })); add(K.box(c.w, c.h * 0.45, c.d, grey, { x: c.x, y: c.h * 0.55, z: c.z }));
    add(K.box(c.w * 0.62, c.h * 0.42, 0.04, red, { x: c.x - c.w * 0.12, y: c.h * 0.56, z: c.z - c.d / 2 - 0.02 }));
    for (const y of [0.4, 0.75, 1.1]) add(K.box(c.w + 0.004, 0.01, c.d + 0.004, seam, { x: c.x, y, z: c.z })); }
  // SSD cabinet behind, red with charcoal joints
  { const c = S.ssd; add(K.box(c.w, c.h, c.d, red, { x: c.x, z: c.z })); add(K.box(0.05, c.h, c.d + 0.01, grey, { x: c.x, z: c.z }));
    add(K.box(c.w + 0.01, 0.03, c.d + 0.01, grey, { x: c.x, y: c.h * 0.48, z: c.z })); }
  return K.finish(g);
}
