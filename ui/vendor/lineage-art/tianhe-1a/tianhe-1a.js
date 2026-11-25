// Tianhe-1A (NUDT, 2010, National Supercomputer Center in Tianjin; #1 November 2010). Section: 2 rows x 8 racks.
// Measured from the Commons hall photo (640 px, so detail is limited): black racks 0.60 m wide, 2.00 m tall,
// depth 1.2 m (estimated); glass-door racks alternate with plain black ones; behind the glass four blade chassis,
// each a stack of 12 horizontal white blades with blue ends; a small green status display at the upper right of every door; black frames, plinth and top.
// Real machine: 112 compute cabinets, 7,168 nodes (each two Xeon CPUs and one Tesla M2050 GPU).
import { makeKit } from "../lib/kit.js";

export const meta = {
  id: "tianhe-1a", name: "Tianhe-1A", year: 2010, footprint_m: [5.0, 4.4], height_m: 2.0,
  maker: "NUDT", real_count: "112 compute cabinets, 7,168 nodes (section shows 2 rows x 8 racks)",
  sources: ["https://commons.wikimedia.org/wiki/File:Tianhe-1_supercomputer.jpg"],
  view: { yaw: -40, pitch: 10, dist: 9.0, target: [0, 1.0, 0] },
};
export const S = { rows: 2, per: 8, w: 0.60, d: 1.2, h: 2.0, aisle: 2.0, chassis: 4 };
const PALETTES = { vectorfall: { edge: "#c20a06", disp: "#3aa0ff" }, museum: { edge: "#3a7ad8", disp: "#3cff7a" } };

export function build(THREE, { palette = "vectorfall" } = {}) {
  const K = makeKit(THREE, { palette, palettes: PALETTES }), PAL = K.PAL, g = new THREE.Group(), add = (m) => (g.add(m), m);
  const { w, d, h, per } = S, frame = K.M.carbon(), deep = K.M.black(0x0b0b0d, 0.5);
  const front = K.canvasTex(192, 640, (c, W, H) => {
    c.fillStyle = "#0b0c0e"; c.fillRect(0, 0, W, H);
    for (let k = 0; k < S.chassis; k++) {
      const y0 = 60 + k * 140;
      for (let b = 0; b < 12; b++) { const y = y0 + b * 10; c.fillStyle = "#e6e9ee"; c.fillRect(34, y, W - 68, 8); c.fillStyle = PAL.edge; c.fillRect(34, y, 10, 8); c.fillRect(W - 44, y, 10, 8); }
    }
    const v = c.createLinearGradient(0, 0, W, H); v.addColorStop(0, "rgba(255,255,255,.10)"); v.addColorStop(0.4, "rgba(255,255,255,0)"); v.addColorStop(1, "rgba(0,0,0,.25)"); c.fillStyle = v; c.fillRect(0, 0, W, H);
  });
  const door = new THREE.MeshPhysicalMaterial({ map: front, emissiveMap: front, emissive: 0xffffff, emissiveIntensity: 0.3, roughness: 0.1, clearcoat: 1, clearcoatRoughness: 0.05 });
  const disp = K.M.led(PAL.disp, 1.4);
  const L = per * w, Dt = S.rows * d + (S.rows - 1) * S.aisle;
  for (let r = 0; r < S.rows; r++) {
    const z = -Dt / 2 + d / 2 + r * (d + S.aisle);
    for (let i = 0; i < per; i++) {
      const x = L / 2 - (i + 0.5) * w;
      const glassy = i % 2 === 0; // glass-door racks alternate with plain black ones
      add(K.box(w - 0.008, h, d, [frame, frame, frame, deep, frame, glassy ? door : frame], { x, z }));
      if (!glassy) add(K.box(0.02, 0.3, 0.02, deep, { x: x + w / 2 - 0.08, y: 0.9, z: z - d / 2 - 0.01 }));
      add(K.box(0.10, 0.04, 0.01, disp, { x: x - w / 2 + 0.12, y: h - 0.14, z: z - d / 2 - 0.005, shadow: false }));
    }
    for (const s of [-1, 1]) add(K.box(0.04, h, d + 0.02, frame, { x: s * (L / 2 + 0.02), z }));
  }
  return K.finish(g);
}
