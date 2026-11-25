// K computer (RIKEN / Fujitsu, 2011, Kobe). Representative section: 2 rows x 8 racks; the first rack of the front
// row stands with its door open. Measured from the one free Commons photo (an open rack at a trade show):
// rack 0.75 m wide, 2.0 m tall (width 0.57 x height including the door frame), depth estimated 1.0 m; door of grey
// perforated sheet in a 2 x 4 grid of framed panels; inside, top 0.30 of the height: 24 system boards with
// copper-sheathed optical cables looping to the right; then a fan block (4 x 3 fans) beside I/O boards; a power
// section; bottom 0.30: the copper-red water-cooling frame. Real machine: 864 racks, 88,128 nodes.
import { makeKit } from "../lib/kit.js";

export const meta = {
  id: "k-computer", name: "K computer", year: 2011, footprint_m: [6.1, 4.0], height_m: 2.0,
  maker: "RIKEN / Fujitsu", real_count: "864 racks, 88,128 nodes (section shows 2 rows x 8)",
  sources: ["https://commons.wikimedia.org/wiki/File:Keisoku-Fujitsu.jpg"],
  view: { yaw: -36, pitch: 12, dist: 9.4, target: [0, 1.0, 0] },
};
export const S = { rows: 2, per: 8, w: 0.75, d: 1.0, h: 2.0, aisle: 2.0 };
const PALETTES = { vectorfall: { frame: "#c20a06", door: "#8d9096" }, museum: { frame: "#a8452a", door: "#8d9096" } };

export function build(THREE, { palette = "vectorfall" } = {}) {
  const K = makeKit(THREE, { palette, palettes: PALETTES }), PAL = K.PAL, g = new THREE.Group(), add = (m) => (g.add(m), m);
  const { w, d, h, per } = S, dark = K.M.black(0x1b1c1f, 0.5), deep = K.M.black(0x0b0b0d, 0.5);
  const doorT = K.canvasTex(192, 512, (c, W, H) => {
    c.fillStyle = PAL.door; c.fillRect(0, 0, W, H);
    c.fillStyle = "rgba(0,0,0,.25)"; for (let y = 0; y < H; y += 3) for (let x = (y / 3) % 2 ? 1.5 : 0; x < W; x += 3) c.fillRect(x, y, 1.2, 1.2);
    c.strokeStyle = "#5d6066"; c.lineWidth = 6;
    for (let i = 0; i <= 2; i++) { c.beginPath(); c.moveTo(i * W / 2, 0); c.lineTo(i * W / 2, H); c.stroke(); }
    for (let j = 0; j <= 4; j++) { c.beginPath(); c.moveTo(0, j * H / 4); c.lineTo(W, j * H / 4); c.stroke(); }
  });
  const inside = K.canvasTex(192, 512, (c, W, H) => {
    c.fillStyle = "#16171a"; c.fillRect(0, 0, W, H);
    for (let i = 0; i < 24; i++) { const y = 8 + i * 6; c.fillStyle = "#c9c6bd"; c.fillRect(12, y, 90, 4); c.fillStyle = "#c27a45"; c.fillRect(102, y, 22, 4); c.strokeStyle = "#2a2a2a"; c.beginPath(); c.moveTo(124, y + 2); c.quadraticCurveTo(170, y + 20, 160, 180); c.stroke(); }
    for (let j = 0; j < 3; j++) for (let k = 0; k < 4; k++) { c.fillStyle = "#8c8f94"; c.fillRect(10 + k * 22, 165 + j * 24, 20, 20); c.strokeStyle = "#333"; c.beginPath(); c.arc(20 + k * 22, 175 + j * 24, 7, 0, 7); c.stroke(); }
    for (let j = 0; j < 8; j++) { c.fillStyle = "#b7b4ab"; c.fillRect(100, 165 + j * 9, 60, 7); }
    c.fillStyle = "#2b2c30"; c.fillRect(10, 245, W - 20, 70);
    c.fillStyle = PAL.frame; c.fillRect(8, 330, W - 16, H - 338); c.fillStyle = "#121212";
    for (let x = 0; x < 6; x++) for (let y = 0; y < 6; y++) c.fillRect(20 + x * 24, 345 + y * 26, 18, 20);
  });
  const doorM = K.M.tex(doorT, { roughness: 0.55, metalness: 0.4 }), inM = K.M.tex(inside, { roughness: 0.5, metalness: 0.3 });
  const side = K.M.paint(PAL.frame, { seed: 51, roughness: 0.45 });
  const L = per * w, Dt = S.rows * d + (S.rows - 1) * S.aisle;
  for (let r = 0; r < S.rows; r++) {
    const z = -Dt / 2 + d / 2 + r * (d + S.aisle);
    for (let i = 0; i < per; i++) {
      const x = L / 2 - (i + 0.5) * w, open = r === 0 && i === 0;
      add(K.box(w - 0.006, h, d, [dark, dark, dark, deep, dark, open ? inM : doorM], { x, z }));
      if (open) add(K.box(0.03, h - 0.04, w - 0.04, [doorM, doorM, dark, dark, dark, dark], { x: x + w / 2 + 0.015, y: 0.02, z: z - d / 2 - (w - 0.04) / 2 })); // the door swung open
    }
    for (const s of [-1, 1]) add(K.box(0.04, h, d, side, { x: s * (L / 2 + 0.02), z })); // end panels in the cooling-frame colour
  }
  return K.finish(g);
}
