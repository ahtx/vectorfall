// Intel Touchstone Delta (1991, Caltech). Representative section: 2 rows x 5 cabinets.
// Measured from the Commons photo of the preserved cabinets: smoked-glass fronts, two cabinets per bay, each
// 0.72 m wide (0.38 x its height), 0.90 m deep (estimated), 1.90 m tall; vertical lines split each front into 4
// columns and horizontal lines into 5 bands, with 4 x 11 small amber node LEDs; a black frame and plinth; the name plate sits on a stand above
// the front row. Real machine: a 16 x 33 mesh of 528 i860 numeric nodes plus service and I/O nodes.
import { makeKit } from "../lib/kit.js";

export const meta = {
  id: "touchstone-delta", name: "Intel Touchstone Delta", year: 1991, footprint_m: [3.7, 4.0], height_m: 2.25,
  maker: "Intel / Caltech", real_count: "528 numeric nodes in a 16 x 33 mesh (section shows 2 rows x 5 cabinets)",
  sources: ["https://commons.wikimedia.org/wiki/File:Intel_Touchstone_Delta_prototype.jpg"],
  view: { yaw: -32, pitch: 12, dist: 7.6, target: [0, 1.0, 0] },
};
export const S = { rows: 2, per: 5, w: 0.72, d: 0.90, h: 1.90, aisle: 2.0, cols: 4, cells: 11, bands: 5 };
const PALETTES = { vectorfall: { led: "#ff3a1c", line: "rgba(194,10,6,.55)" }, museum: { led: "#ffb030", line: "rgba(200,200,190,.35)" } };

export function build(THREE, { palette = "vectorfall" } = {}) {
  const K = makeKit(THREE, { palette, palettes: PALETTES }), PAL = K.PAL, g = new THREE.Group(), add = (m) => (g.add(m), m);
  const { w, d, h, per } = S, frame = K.M.black(0x0d0d0f, 0.45);
  const front = K.canvasTex(256, 768, (c, W, H) => {
    const gr = c.createLinearGradient(0, 0, W, H); gr.addColorStop(0, "#2a2620"); gr.addColorStop(0.5, "#14120f"); gr.addColorStop(1, "#1f1c18"); c.fillStyle = gr; c.fillRect(0, 0, W, H);
    c.strokeStyle = PAL.line; c.lineWidth = 2;
    for (let i = 1; i < S.cols; i++) { c.beginPath(); c.moveTo(i * W / S.cols, 0); c.lineTo(i * W / S.cols, H); c.stroke(); }
    for (let j = 1; j < S.bands; j++) { c.beginPath(); c.moveTo(0, j * H / S.bands); c.lineTo(W, j * H / S.bands); c.stroke(); }
    for (let i = 0; i < S.cols; i++) for (let j = 0; j < S.cells; j++) { c.fillStyle = PAL.led; c.beginPath(); c.arc((i + 0.5) * W / S.cols, (j + 0.5) * H / S.cells, 4, 0, 7); c.fill(); }
  });
  const glass = new THREE.MeshPhysicalMaterial({ map: front, emissiveMap: front, emissive: 0xffffff, emissiveIntensity: 0.25, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.05, metalness: 0.2 });
  const sign = new THREE.MeshStandardMaterial({ map: K.plateTex([["touchstone", "italic 700 46px Georgia, serif", 0.5], ["D E L T A", "700 34px Arial", 0.85]], { w: 512, h: 160, bg: "#1a1a1d", fg: "#e9eaec", border: null }), roughness: 0.4 });
  const L = per * w, Dt = S.rows * d + (S.rows - 1) * S.aisle;
  for (let r = 0; r < S.rows; r++) {
    const z = -Dt / 2 + d / 2 + r * (d + S.aisle);
    for (let i = 0; i < per; i++) {
      const x = L / 2 - (i + 0.5) * w;
      add(K.box(w - 0.01, 0.06, d - 0.04, frame, { x, z }));
      add(K.box(w - 0.01, h - 0.06, d, [frame, frame, frame, frame, frame, glass], { x, y: 0.06, z }));
    }
    for (const s of [-1, 1]) add(K.box(0.03, h, d, frame, { x: s * (L / 2 + 0.015), z }));
  }
  // name plate on a post above the middle of the front row
  const zf = -Dt / 2 + d / 2;
  add(K.box(0.04, 0.22, 0.04, frame, { y: h, z: zf }));
  add(K.mesh(new THREE.BoxGeometry(0.62, 0.2, 0.02), [frame, frame, frame, frame, frame, sign], { y: h + 0.3, z: zf }));
  return K.finish(g);
}
