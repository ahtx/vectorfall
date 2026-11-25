// IBM ASCI White (2000, LLNL; #1 November 2000 to 2001). Representative section: 2 rows x 8 RS/6000 SP frames.
// Measured from Commons photos (LLNL hall in black and white, DOE photo with frames open): frames 0.95 m wide,
// 1.30 m deep, 2.00 m tall; a door with rounded vertical front edges (radius 0.07 m), a centre seam and a small
// round badge 0.25 m below the top; the open frames show 8 node drawers with cable looms on the right; a black
// 0.05 m plinth. The first frame of the front row stands open. Real machine: 512 nodes, 8,192 POWER3 processors.
import { makeKit } from "../lib/kit.js";

export const meta = {
  id: "asci-white", name: "IBM ASCI White", year: 2000, footprint_m: [7.8, 4.7], height_m: 2.0,
  maker: "IBM / LLNL", real_count: "512 nodes, 8,192 processors (section shows 2 rows x 8 frames)",
  sources: [
    "https://commons.wikimedia.org/wiki/File:U.S._Department_of_Energy_-_Science_-_477_011_010_(10189827343).jpg",
    "https://commons.wikimedia.org/wiki/File:ASCIWhite01.jpg",
  ],
  view: { yaw: -40, pitch: 12, dist: 11.0, target: [0, 1.0, 0] },
};
export const S = { rows: 2, per: 8, w: 0.95, d: 1.30, h: 2.0, aisle: 2.0, round: 0.07, drawers: 8 };
const PALETTES = { vectorfall: { body: "#c20a06", badge: "#d6d9dd" }, museum: { body: "#1a1b1e", badge: "#9aa0a8" } };

export function build(THREE, { palette = "vectorfall" } = {}) {
  const K = makeKit(THREE, { palette, palettes: PALETTES }), PAL = K.PAL, g = new THREE.Group(), add = (m) => (g.add(m), m);
  const { w, d, h, per } = S, base = K.M.black(0x111113, 0.5), dark = K.M.black(0x141518, 0.5), seam = K.M.black(0x0b0b0d, 0.5);
  const body = K.M.paint(PAL.body, { seed: 141, roughness: 0.45, grain: 0.04 }), badge = K.M.paint(PAL.badge, { seed: 142, roughness: 0.3 });
  const inside = K.canvasTex(256, 512, (c, W, H) => { c.fillStyle = "#101114"; c.fillRect(0, 0, W, H);
    for (let k = 0; k < S.drawers; k++) { const y = 20 + k * 60; c.fillStyle = "#7a7d83"; c.fillRect(14, y, 170, 48); c.fillStyle = "#3a3c41"; for (let x = 20; x < 180; x += 12) c.fillRect(x, y + 6, 6, 36); c.fillStyle = "#c8ccd0"; c.fillRect(150, y + 18, 26, 12); }
    c.strokeStyle = "rgba(200,200,200,.6)"; c.lineWidth = 2; for (let i = 0; i < 30; i++) { c.beginPath(); c.moveTo(186 + (i % 6) * 10, 10); c.lineTo(190 + (i % 6) * 9, H - 10); c.stroke(); } });
  const open = K.M.tex(inside, { roughness: 0.5, metalness: 0.3 });
  const L = per * w, Dt = S.rows * d + (S.rows - 1) * S.aisle;
  for (let r = 0; r < S.rows; r++) {
    const z = -Dt / 2 + d / 2 + r * (d + S.aisle), zf = z - d / 2;
    for (let i = 0; i < per; i++) {
      const x = L / 2 - (i + 0.5) * w, isOpen = r === 0 && i === 0;
      add(K.box(w - 0.02, 0.05, d - 0.04, base, { x, z }));
      add(K.box(w - 0.02, h - 0.05, d - S.round, [dark, dark, dark, dark, dark, isOpen ? open : body], { x, y: 0.05, z: z + S.round / 2 }));
      if (isOpen) { add(K.box(0.03, h - 0.1, w - 0.1, body, { x: x + w / 2 + 0.02, y: 0.06, z: zf - (w - 0.1) / 2 })); continue; } // the door swung open
      add(K.box(w - 0.02 - 2 * S.round, h - 0.05, S.round, body, { x, y: 0.05, z: zf + S.round / 2 })); // door front
      for (const s of [-1, 1]) add(K.cyl(S.round, h - 0.05, body, { x: x + s * (w / 2 - 0.01 - S.round), y: 0.05, z: zf + S.round }, 20)); // rounded edges
      add(K.box(0.006, h - 0.25, 0.006, seam, { x, y: 0.12, z: zf - 0.002 }));
      add(K.mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.01, 24), badge, { x, y: h - 0.25, z: zf - 0.004, rx: Math.PI / 2 }));
    }
  }
  return K.finish(g);
}
