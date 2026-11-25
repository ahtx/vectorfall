// Numerical Wind Tunnel (Fujitsu and the National Aerospace Laboratory of Japan, 1993; #1 on the TOP500 1993-1995).
// Representative section: 2 rows x 7 processing-element cabinets with their row-end housings.
// Measured from the hall photo in the IPSJ Computer Museum (photo courtesy JAXA; study only, see reference/):
// dark grey cabinets 0.75 m wide (two doors with a seam and a small handle at 0.6 of the height), 1.0 m deep,
// 1.90 m tall, on a black 0.06 m plinth. Each row ends in a lighter grey housing 0.60 m wide whose front edge
// leans: flush with the doors under the header, 0.28 m proud of them at the floor. A black header box 0.26 m
// tall carries the NWT mark and "NUMERICAL SIMULATOR". The end face has a louvred grille (17 slats) in its lower
// half, 0.48 of the face wide and 0.36 of the height tall. Real machine: 140 processing elements (166 from 1995).
import { makeKit } from "../lib/kit.js";

export const meta = {
  id: "nwt", name: "Numerical Wind Tunnel", year: 1993, footprint_m: [6.0, 4.6], height_m: 1.96,
  maker: "Fujitsu / National Aerospace Laboratory of Japan", real_count: "140 processing elements (166 from 1995); section shows 2 rows x 7 cabinets",
  sources: ["https://museum.ipsj.or.jp/en/computer/super/0020.html"],
  view: { yaw: -42, pitch: 12, dist: 9.4, target: [0, 0.95, 0] },
};
export const S = { rows: 2, per: 7, w: 0.75, d: 1.0, h: 1.90, plinth: 0.06, aisle: 2.0, endW: 0.60, lean: 0.28, header: 0.26, slats: 17 };
const PALETTES = {
  vectorfall: { door: "#c20a06", end: "brushed" },
  museum: { door: "#2b2f33", end: "#7d8186" },
};

export function build(THREE, { palette = "vectorfall" } = {}) {
  const K = makeKit(THREE, { palette, palettes: PALETTES }), PAL = K.PAL, g = new THREE.Group(), add = (m) => (g.add(m), m);
  const { w, d, h, per } = S, base = K.M.black(0x111113, 0.5), seam = K.M.black(0x0d0d0f, 0.45), slat = K.M.black(0x1a1b1e, 0.5);
  const door = K.M.paint(PAL.door, { seed: 71, roughness: 0.45, grain: 0.04 });
  const end = PAL.end === "brushed" ? K.M.alu() : K.M.paint(PAL.end, { seed: 72, roughness: 0.4, grain: 0.03 });
  const head = new THREE.MeshPhysicalMaterial({ color: 0x0c0c0e, roughness: 0.25, clearcoat: 0.8 });
  const logo = new THREE.MeshStandardMaterial({ map: K.canvasTex(512, 160, (c, W, H) => {
    c.fillStyle = "#0c0c0e"; c.fillRect(0, 0, W, H); c.strokeStyle = "#f2f3f5"; c.lineWidth = 9; c.lineCap = "round";
    c.beginPath(); c.moveTo(150, 120); c.lineTo(185, 40); c.lineTo(205, 100); c.lineTo(250, 35); c.stroke(); // the NWT wing mark
    c.beginPath(); c.moveTo(205, 100); c.quadraticCurveTo(240, 110, 262, 72); c.stroke();
    c.fillStyle = "#f2f3f5"; c.font = "700 22px Arial"; c.fillText("NUMERICAL", 270, 98); c.fillText("SIMULATOR", 270, 122);
  }), roughness: 0.3 });
  const L = per * w, Dt = S.rows * d + (S.rows - 1) * S.aisle, yh = h - S.header;
  for (let r = 0; r < S.rows; r++) {
    const z = -Dt / 2 + d / 2 + r * (d + S.aisle), zf = z - d / 2;
    for (let i = 0; i < per; i++) {
      const x = L / 2 - (i + 0.5) * w;
      add(K.box(w - 0.006, S.plinth, d - 0.04, base, { x, z }));
      add(K.box(w - 0.006, h - S.plinth, d, door, { x, y: S.plinth, z }));
      add(K.box(0.006, h - S.plinth - 0.12, 0.006, seam, { x, y: S.plinth + 0.06, z: zf - 0.002 }));
      add(K.box(0.012, 0.08, 0.012, seam, { x: x - 0.05, y: h * 0.6, z: zf - 0.006 }));
    }
    // row-end housing at the -x end (the end that faces the visitor): a side profile with a leaning front edge
    const xe = -L / 2 - S.endW / 2, zb = z + d / 2;
    const prof = [[zf - S.lean, 0], [zb, 0], [zb, yh], [zf, yh]]; // (z, y) points, front leans out toward the floor
    add(K.profile(prof.map(([pz, py]) => [-pz, py]), -S.endW / 2, S.endW / 2, end, { x: xe, ry: Math.PI / 2 }));
    add(K.box(S.endW + 0.02, S.header, d + 0.06, [head, logo, head, head, head, head], { x: xe, y: yh, z: z - 0.03 }));
    add(K.box(S.endW + 0.02, S.plinth, d + S.lean - 0.04, base, { x: xe, z: z - S.lean / 2 }));
    // louvred grille on the end face (-x face), lower half
    const gw = (d + S.lean) * 0.48, gh = h * 0.36, gz = z - S.lean / 2 + 0.05;
    add(K.box(0.02, gh + 0.03, gw + 0.03, slat, { x: xe - S.endW / 2 - 0.004, y: 0.22, z: gz }));
    for (let k = 0; k < S.slats; k++) add(K.mesh(new THREE.BoxGeometry(0.03, 0.008, gw), end, { x: xe - S.endW / 2 - 0.016, y: 0.235 + k * gh / S.slats, z: gz, rz: 0.5 }));
  }
  return K.finish(g);
}
