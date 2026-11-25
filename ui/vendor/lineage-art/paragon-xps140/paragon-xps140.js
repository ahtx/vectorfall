// Intel Paragon XP/S 140 (1994, Sandia; #1 June 1994). Representative section: 2 rows x 8 cabinets.
// Measured from Commons photos (ORNL XP/S 150 hall, Computer History Museum XP/S cabinet, XP/E front):
// black glass fronts 0.80 m wide, 1.95 m tall, depth 1.0 m (estimated); behind the glass each cabinet shows a
// grid of node LEDs drawn as hash frames: 2 columns x 5 rows of 4 x 4 bars; a brushed metal end panel
// (pinkish under the hall lights) with a vertical slot at each row end; black plinth. The LEDs flicker as nodes
// work. Real machine: 3,680 i860 XP processors (1,840 nodes).
import { makeKit } from "../lib/kit.js";

export const meta = {
  id: "paragon-xps140", name: "Intel Paragon XP/S 140", year: 1994, footprint_m: [6.6, 4.0], height_m: 1.95,
  maker: "Intel / Sandia", real_count: "1,840 nodes, 3,680 processors (section shows 2 rows x 8 cabinets)",
  sources: [
    "https://commons.wikimedia.org/wiki/File:ORNL_Intel_Paragon_XP-S-150_ORNL_1994_(23601012678).jpg",
    "https://commons.wikimedia.org/wiki/File:Intel_Paragon_XP-S_(1992)_-_Computer_History_Museum_(2007-11-10_22.57.18_by_Carlo_Nardone).jpg",
    "https://commons.wikimedia.org/wiki/File:Paragon_XP-E_-_front.jpg",
  ],
  view: { yaw: -40, pitch: 10, dist: 10.0, target: [0, 1.0, 0] },
};
export const S = { rows: 2, per: 8, w: 0.80, d: 1.0, h: 1.95, aisle: 2.0, gx: 2, gy: 5 };
const PALETTES = { vectorfall: { led: "#ff5030", end: "#c20a06" }, museum: { led: "#ffd040", end: "brushed" } };

export function build(THREE, { palette = "vectorfall" } = {}) {
  const K = makeKit(THREE, { palette, palettes: PALETTES }), PAL = K.PAL, g = new THREE.Group(), add = (m) => (g.add(m), m);
  const { w, d, h, per } = S, frame = K.M.black(0x0c0c0e, 0.45);
  const cv = document.createElement("canvas"); cv.width = 256; cv.height = 640; const cx = cv.getContext("2d");
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; const r = K.rng(31);
  const draw = () => {
    cx.fillStyle = "#07070a"; cx.fillRect(0, 0, 256, 640);
    for (let i = 0; i < S.gx; i++) for (let j = 0; j < S.gy; j++) {
      const x0 = 28 + i * 118, y0 = 40 + j * 118;
      for (let k = 0; k < 4; k++) { // a frame of LED bars (the node mesh), 4 x 4 lines
        cx.fillStyle = r() < 0.85 ? PAL.led : "#3a2a08"; cx.fillRect(x0, y0 + 10 + k * 26, 84, 4);
        cx.fillStyle = r() < 0.85 ? PAL.led : "#3a2a08"; cx.fillRect(x0 + 6 + k * 24, y0, 4, 96);
      }
    }
    tex.needsUpdate = true;
  };
  draw();
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x181818, map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 1.1, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.05 });
  const end = PAL.end === "brushed" ? new THREE.MeshStandardMaterial({ color: 0xcdb8c2, roughness: 0.25, metalness: 0.6, envMapIntensity: 2 }) : K.M.paint(PAL.end, { seed: 111, roughness: 0.35, clearcoat: 0.6 });
  const L = per * w, Dt = S.rows * d + (S.rows - 1) * S.aisle;
  for (let r2 = 0; r2 < S.rows; r2++) {
    const z = -Dt / 2 + d / 2 + r2 * (d + S.aisle);
    for (let i = 0; i < per; i++) {
      const x = L / 2 - (i + 0.5) * w;
      add(K.box(w - 0.012, 0.07, d - 0.04, frame, { x, z }));
      add(K.box(w - 0.012, h - 0.07, d, [frame, frame, frame, frame, frame, glass], { x, y: 0.07, z }));
    }
    for (const s of [-1, 1]) { // metal end panels with a vertical slot
      add(K.box(0.08, h, d + 0.04, end, { x: s * (L / 2 + 0.04), z }));
      add(K.box(0.01, h * 0.7, 0.05, frame, { x: s * (L / 2 + 0.084), y: h * 0.15, z: z - d * 0.3 }));
    }
  }
  let last = -1;
  return K.finish(g, (t) => { const f = Math.floor(t * 3); if (f !== last) { last = f; draw(); } });
}
