// HPE Cray Frontier (2022, Oak Ridge), the first exascale machine. Representative section: 2 rows x 5 cabinets.
// Measured from Commons photos (OLCF Frontier hall): HPE Cray EX cabinets 1.20 m wide, 1.50 m deep, 2.30 m tall,
// glossy black fronts printed with a star field and the name in white letters 0.30 of the door height spanning
// the row above a glowing horizon arc in the lower third; row-end panels with the name at the top and a round emblem (rendered as an abstract ring and needle);
// the side of each cabinet shows blue cable bundles in eight columns; black coolant hoses rise to yellow trays
// 0.55 m above. Real machine: 74 cabinets (9,408 nodes, each one CPU and four GPUs).
import { makeKit } from "../lib/kit.js";

export const meta = {
  id: "frontier", name: "HPE Cray Frontier", year: 2022, footprint_m: [6.1, 5.0], height_m: 2.93,
  maker: "HPE Cray", real_count: "74 cabinets, 9,408 nodes (section shows 2 rows x 5)",
  sources: [
    "https://commons.wikimedia.org/wiki/File:Frontier_supercomputer_(8).jpg",
    "https://commons.wikimedia.org/wiki/File:Frontier_supercomputer_(10).jpg",
    "https://commons.wikimedia.org/wiki/File:Frontier_Supercomputer_(2).jpg",
    "https://commons.wikimedia.org/wiki/File:Frontier_Supercomputer_(1).jpg",
  ],
  view: { yaw: -40, pitch: 12, dist: 10.5, target: [0, 1.2, 0] },
};
export const S = { rows: 2, per: 5, w: 1.20, d: 1.50, h: 2.30, aisle: 2.0, tray: 0.55 };
const PALETTES = { vectorfall: { accent: "#c20a06", cable: "#3aa0ff", tray: "#c9ccd1" }, museum: { accent: "#d8322a", cable: "#2c5ad8", tray: "#f2c21b" } };

export function build(THREE, { palette = "vectorfall" } = {}) {
  const K = makeKit(THREE, { palette, palettes: PALETTES }), PAL = K.PAL, g = new THREE.Group(), add = (m) => (g.add(m), m);
  const { w, d, h, per } = S, deep = K.M.black(0x0a0a0c, 0.5), black = K.M.carbon();
  const stars = (c, W, H, seed) => { const r = K.rng(seed); for (let i = 0; i < W * H / 900; i++) { c.fillStyle = `rgba(255,255,255,${0.2 + r() * 0.7})`; c.fillRect(r() * W, r() * H, 1 + r() * 1.5, 1 + r() * 1.5); } };
  const rowArt = K.canvasTex(2560, 512, (c, W, H) => {
    const gr = c.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, "#050507"); gr.addColorStop(1, "#15161c"); c.fillStyle = gr; c.fillRect(0, 0, W, H); stars(c, W, H, 4);
    const hz = c.createRadialGradient(W * 0.5, H * 12, H * 11.15, W * 0.5, H * 12, H * 11.45); // a low glowing horizon arc
    hz.addColorStop(0, "rgba(0,0,0,0)"); hz.addColorStop(0.75, "rgba(120,110,200,.55)"); hz.addColorStop(0.8, "rgba(230,230,255,.8)"); hz.addColorStop(1, "rgba(0,0,0,0)"); c.fillStyle = hz; c.fillRect(0, 0, W, H);
    for (let k = 1; k < per * 2; k++) { c.fillStyle = "rgba(0,0,0,.7)"; c.fillRect(k * W / (per * 2) - 2, 0, 4, H); c.fillStyle = "#3a3b40"; c.fillRect(k * W / (per * 2) + (k % 2 ? -14 : 8), H * 0.42, 6, 30); } // door seams, handles
    c.fillStyle = "#f4f5f7"; c.font = "800 150px 'Arial Black', Arial"; c.textBaseline = "middle"; c.letterSpacing = "30px"; c.fillText("FRONTIER", W * 0.17, H * 0.55);
    c.fillStyle = PAL.accent; c.beginPath(); c.moveTo(W * 0.31, H * 0.72); c.lineTo(W * 0.345, H * 0.28); c.lineTo(W * 0.32, H * 0.6); c.fill();
  });
  const endArt = K.canvasTex(512, 512, (c, W, H) => {
    c.fillStyle = "#0a0a0d"; c.fillRect(0, 0, W, H); stars(c, W, H, 9);
    c.fillStyle = "#f4f5f7"; c.font = "800 52px 'Arial Black', Arial"; c.textAlign = "center"; c.fillText("FRONTIER", W / 2, H * 0.2);
    c.strokeStyle = "#f4f5f7"; c.lineWidth = 10; c.beginPath(); c.arc(W / 2, H * 0.5, 70, 0, 7); c.stroke();
    c.fillStyle = PAL.accent; c.beginPath(); c.moveTo(W / 2 + 60, H * 0.32); c.lineTo(W / 2 + 10, H * 0.53); c.lineTo(W / 2 - 10, H * 0.47); c.fill();
    c.fillStyle = "#f4f5f7"; c.beginPath(); c.moveTo(W / 2 - 60, H * 0.68); c.lineTo(W / 2 - 10, H * 0.47); c.lineTo(W / 2 + 10, H * 0.53); c.fill();
  });
  const cables = K.canvasTex(256, 256, (c, W, H) => { c.fillStyle = "#08080a"; c.fillRect(0, 0, W, H); const r = K.rng(2);
    for (let k = 0; k < 8; k++) for (let y = 8; y < H; y += 10) { c.fillStyle = r() < 0.85 ? PAL.cable : "#c7c9cc"; c.beginPath(); c.ellipse(16 + k * 31, y, 12, 4, 0, 0, 7); c.fill(); } });
  const endM = new THREE.MeshPhysicalMaterial({ map: endArt, roughness: 0.25, clearcoat: 0.9, clearcoatRoughness: 0.1 }), sideM = K.M.tex(cables, { roughness: 0.6 });
  const tray = K.M.paint(PAL.tray, { seed: 41, roughness: 0.4, grain: 0.02 }), hose = K.M.black(0x101012, 0.35);
  const L = per * w, Dt = S.rows * d + (S.rows - 1) * S.aisle;
  for (let r = 0; r < S.rows; r++) {
    const z = -Dt / 2 + d / 2 + r * (d + S.aisle);
    for (let i = 0; i < per; i++) {
      const x = L / 2 - (i + 0.5) * w, t = rowArt.clone(); t.repeat.set(1 / per, 1); t.offset.set(i / per, 0); t.needsUpdate = true;
      const door = new THREE.MeshPhysicalMaterial({ map: t, roughness: 0.25, clearcoat: 0.9, clearcoatRoughness: 0.1 });
      add(K.box(w - 0.008, h, d, [sideM, sideM, black, deep, sideM, door], { x, z }));
      for (const s of [-0.3, 0.3]) add(K.cyl(0.03, S.tray, hose, { x: x + s, y: h, z: z + 0.3 }, 12));
    }
    add(K.box(0.05, h, d, [black, endM, black, black, black, black], { x: -L / 2 - 0.025, z }));
    add(K.box(0.05, h, d, black, { x: L / 2 + 0.025, z }));
    const ty = h + S.tray, tz = z + 0.3;
    for (const s of [-1, 1]) add(K.box(L + 0.3, 0.1, 0.03, tray, { y: ty, z: tz + s * 0.25 }));
    for (let k = 0; k <= per * 3; k++) add(K.box(0.03, 0.02, 0.5, tray, { x: -L / 2 - 0.15 + k * (L + 0.3) / (per * 3), y: ty, z: tz }));
    for (const s of [-1, 1]) add(K.box(0.05, S.tray, 0.05, tray, { x: s * (L / 2 - 0.1), y: h, z: tz }));
  }
  return K.finish(g);
}
