// IBM Sequoia (Blue Gene/Q, 2012, LLNL; #1 June 2012). Representative section: 2 rows x 6 racks.
// Measured from Commons photos (LLNL hall, DOE photos): warm grey racks 1.22 m apart, 2.08 m tall, 1.22 m deep.
// Along a row each rack front is a grey slab narrow at the floor (0.82 m) and full width at the top, the
// triangle between slabs filled with a dark perforated air plenum (wide at the floor), like a leaning domino.
// Row ends are flat panels of four vertical boards with hairline joints, the machine's round tree emblem at
// 0.58 of the height, the maker's mark at the top and the series name written vertically at the right.
// Real machine: 96 racks, 98,304 nodes, 1,572,864 cores.
import { makeKit } from "../lib/kit.js";

export const meta = {
  id: "sequoia", name: "IBM Sequoia", year: 2012, footprint_m: [7.4, 4.5], height_m: 2.08,
  maker: "IBM / LLNL", real_count: "96 racks, 98,304 nodes (section shows 2 rows x 6 racks)",
  sources: [
    "https://commons.wikimedia.org/wiki/File:IBM_BlueGene_Q_(Sequoia_supercomputer)(1).jpg",
    "https://commons.wikimedia.org/wiki/File:U.S._Department_of_Energy_-_Science_-_477_024_010_(16285637331).jpg",
    "https://commons.wikimedia.org/wiki/File:U.S._Department_of_Energy_-_Science_-_477_025_010_(16099887468).jpg",
  ],
  view: { yaw: -52, pitch: 10, dist: 10.5, target: [0, 1.05, 0] },
};
export const S = { rows: 2, per: 6, pitch: 1.22, bottom: 0.82, d: 1.22, h: 2.08, aisle: 2.0 };
const PALETTES = { vectorfall: { body: "#3a3b3f", emblem: "#c20a06", endBody: "#c20a06" }, museum: { body: "#4a4844", emblem: "#2f8f3a", endBody: "#4a4844" } };

export function build(THREE, { palette = "vectorfall" } = {}) {
  const K = makeKit(THREE, { palette, palettes: PALETTES }), PAL = K.PAL, g = new THREE.Group(), add = (m) => (g.add(m), m);
  const { pitch, d, h, per } = S, base = K.M.black(0x121214, 0.5);
  const body = K.M.paint(PAL.body, { seed: 151, roughness: 0.5, grain: 0.03 });
  const meshT = K.canvasTex(128, 128, (c, W, H) => { c.fillStyle = "#1c1d20"; c.fillRect(0, 0, W, H); c.fillStyle = "#050506"; for (let y = 1; y < H; y += 4) for (let x = (y >> 2) % 2 ? 3 : 1; x < W; x += 4) c.fillRect(x, y, 2, 2); }, { repeat: true });
  meshT.repeat.set(6, 6); const plenum = K.M.tex(meshT, { roughness: 0.7, metalness: 0.3 });
  const endT = K.canvasTex(512, 820, (c, W, H) => {
    c.fillStyle = PAL.endBody; c.fillRect(0, 0, W, H); c.fillStyle = "rgba(0,0,0,.45)"; for (let k = 1; k < 4; k++) c.fillRect(k * W / 4 - 1, 0, 3, H);
    const cx = W * 0.55, cy = H * 0.42; c.strokeStyle = PAL.emblem; c.lineWidth = 6; c.beginPath(); c.ellipse(cx, cy, 70, 82, 0, 0, 7); c.stroke();
    c.fillStyle = PAL.emblem; for (let k = 0; k < 6; k++) { const y = cy - 60 + k * 16, s = 10 + k * 8; c.beginPath(); c.moveTo(cx, y - 14); c.lineTo(cx + s, y + 10); c.lineTo(cx - s, y + 10); c.fill(); }
    c.fillRect(cx - 5, cy + 36, 10, 20); c.font = "700 30px Georgia, serif"; c.textAlign = "center"; c.fillStyle = "#e8eaec"; c.fillText("SEQUOIA", cx, cy + 50);
    c.fillStyle = "#e8eaec"; c.font = "800 40px Arial"; c.textAlign = "left"; c.fillText("IBM", 70, 70);
    c.save(); c.translate(W * 0.86, H * 0.85); c.rotate(-Math.PI / 2); c.font = "500 30px Georgia, serif"; c.fillStyle = "rgba(230,232,236,.85)"; c.fillText("Blue Gene/Q supercomputer", 0, 0); c.restore();
  });
  const endM = new THREE.MeshPhysicalMaterial({ map: endT, roughness: 0.45, clearcoat: 0.3 });
  const L = per * pitch, Dt = S.rows * d + (S.rows - 1) * S.aisle;
  for (let r = 0; r < S.rows; r++) {
    const z0 = -Dt / 2 + r * (d + S.aisle);
    for (let i = 0; i < per; i++) {
      const x0 = L / 2 - (i + 1) * pitch; // rack spans x0 .. x0 + pitch; +x is left seen from the front
      add(K.profile([[pitch - S.bottom, 0], [pitch, 0], [pitch, h], [0, h]], z0, z0 + d, body, { x: x0 })); // grey slab, narrow at the floor
      add(K.profile([[0, 0], [pitch - S.bottom, 0], [0, h]], z0 + 0.03, z0 + d - 0.03, plenum, { x: x0 })); // plenum triangle
    }
    add(K.box(0.05, h, d, [base, endM, base, base, base, base], { x: -L / 2 - 0.025, z: z0 + d / 2 })); // row end facing the visitor
    add(K.box(0.05, h, d, body, { x: L / 2 + 0.025, z: z0 + d / 2 }));
  }
  return K.finish(g);
}
