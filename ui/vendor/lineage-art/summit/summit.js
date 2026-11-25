// IBM Summit (2018, Oak Ridge). Representative section: 2 rows x 8 racks under yellow cable trays.
// Measured from Commons photos (OLCF launch photos): black racks 0.70 m wide, 1.20 m deep, 2.0 m tall with
// perforated doors; on every door blue and white angular shards (rendered abstractly) in the lower 0.7 and a
// green LED column behind the mesh; row ends carry a full panel with the name written vertically (reading
// upward) in white near the outer edge and large blue/white triangles in the lower half; yellow ladder trays 0.45 m above the
// racks with black hoses dropping into each rack. Real machine: 256 compute racks (4,608 nodes).
import { makeKit } from "../lib/kit.js";

export const meta = {
  id: "summit", name: "IBM Summit", year: 2018, footprint_m: [5.7, 4.3], height_m: 2.55,
  maker: "IBM", real_count: "256 compute racks, 4,608 nodes (section shows 2 rows x 8)",
  sources: [
    "https://commons.wikimedia.org/wiki/File:Summit_Supercomputer_2018.jpg",
    "https://commons.wikimedia.org/wiki/File:Summit_(supercomputer).jpg",
    "https://commons.wikimedia.org/wiki/File:ORNL_Launches_Summit_Supercomputer_(31430047007).jpg",
  ],
  view: { yaw: -40, pitch: 12, dist: 9.6, target: [0, 1.1, 0] },
};
export const S = { rows: 2, per: 8, w: 0.70, d: 1.20, h: 2.0, aisle: 1.9, tray: 0.45 };
const PALETTES = { vectorfall: { shard: "#c20a06", shard2: "#e9ecef", tray: "#c9ccd1" }, museum: { shard: "#1f4fbf", shard2: "#e9ecef", tray: "#f2c21b" } };

export function build(THREE, { palette = "vectorfall" } = {}) {
  const K = makeKit(THREE, { palette, palettes: PALETTES }), PAL = K.PAL, g = new THREE.Group(), add = (m) => (g.add(m), m);
  const { w, d, h, per } = S, black = K.M.carbon(), deep = K.M.black(0x0b0b0d, 0.5);
  const doorTex = (seed) => K.canvasTex(128, 384, (c, W, H) => {
    c.fillStyle = "#0c0c0e"; c.fillRect(0, 0, W, H); const r = K.rng(seed);
    for (let y = 30; y < H - 20; y += 7) { c.fillStyle = r() < 0.7 ? "#2dff6e" : "#0b3318"; c.fillRect(W * 0.78, y, 3, 3); }
    c.fillStyle = "rgba(0,0,0,.45)"; for (let y = 0; y < H; y += 3) for (let x = (y / 3) % 2 ? 1.5 : 0; x < W; x += 3) c.fillRect(x, y, 1.5, 1.5);
    for (let k = 0; k < 4; k++) { c.fillStyle = k % 3 === 2 ? PAL.shard2 : PAL.shard; const x = r() * W * 0.6, y = H * (0.3 + r() * 0.6);
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + 10 + r() * 30, y - 40 - r() * 90); c.lineTo(x + 6 + r() * 14, y + 10 + r() * 40); c.fill(); }
  });
  const doors = [1, 2, 3, 4].map((s) => K.M.tex(doorTex(s), { roughness: 0.5, metalness: 0.3, emissiveMap: null }));
  const endTex = K.canvasTex(256, 512, (c, W, H) => {
    c.fillStyle = "#111114"; c.fillRect(0, 0, W, H);
    c.fillStyle = PAL.shard; c.beginPath(); c.moveTo(0, H); c.lineTo(W * 0.75, H); c.lineTo(W * 0.15, H * 0.42); c.fill();
    c.fillStyle = PAL.shard2; c.beginPath(); c.moveTo(W * 0.15, H * 0.42); c.lineTo(W * 0.32, H * 0.95); c.lineTo(W * 0.24, H * 0.6); c.fill();
    c.beginPath(); c.moveTo(W * 0.45, H * 0.72); c.lineTo(W * 0.95, H * 0.97); c.lineTo(W * 0.6, H * 0.8); c.fill();
    c.save(); c.translate(W * 0.2, H * 0.52); c.rotate(-Math.PI / 2); c.fillStyle = "#f2f3f5"; c.font = "700 64px Arial"; c.fillText("summit", 0, 0); c.restore(); // reads upward
  });
  const endM = new THREE.MeshPhysicalMaterial({ map: endTex, roughness: 0.4, clearcoat: 0.5 });
  const tray = K.M.paint(PAL.tray, { seed: 41, roughness: 0.4, grain: 0.02 }), hose = K.M.black(0x101012, 0.35);
  const L = per * w, Dt = S.rows * d + (S.rows - 1) * S.aisle;
  for (let r = 0; r < S.rows; r++) {
    const z = -Dt / 2 + d / 2 + r * (d + S.aisle);
    for (let i = 0; i < per; i++) {
      const x = L / 2 - (i + 0.5) * w;
      add(K.box(w - 0.006, h, d, [black, black, black, deep, black, doors[(i + r) % 4]], { x, z }));
      add(K.cyl(0.025, S.tray, hose, { x: x - 0.15, y: h, z: z + 0.25 }, 12)); add(K.cyl(0.025, S.tray, hose, { x: x + 0.15, y: h, z: z + 0.25 }, 12));
    }
    // end panels with the name
    add(K.box(0.05, h + 0.02, d + 0.02, [black, endM, black, black, black, black], { x: -L / 2 - 0.025, z }));
    add(K.box(0.05, h + 0.02, d + 0.02, black, { x: L / 2 + 0.025, z }));
    // yellow ladder tray over the row, resting on the hose drops and two brackets
    const ty = h + S.tray, tz = z + 0.25;
    for (const s of [-1, 1]) add(K.box(L + 0.2, 0.08, 0.03, tray, { y: ty, z: tz + s * 0.2 }));
    for (let k = 0; k <= per * 2; k++) add(K.box(0.03, 0.02, 0.4, tray, { x: -L / 2 - 0.1 + k * (L + 0.2) / (per * 2), y: ty, z: tz }));
    for (const s of [-1, 1]) add(K.box(0.04, S.tray, 0.04, tray, { x: s * (L / 2 - 0.1), y: h, z: tz }));
  }
  return K.finish(g);
}
