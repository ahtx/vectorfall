// Sunway TaihuLight (NRCPC, 2016, Wuxi). Representative section: 2 rows x 5 cabinets.
// Measured from the Commons hall photo: black cabinets 1.0 m wide, 1.4 m deep, 2.0 m tall with a blue LED line
// 0.10 m below the top; each row ends in a panel 0.05 m proud, 0.73 x its height wide, divided by a diagonal from
// the top at 0.45 of the width to the bottom at 0.30: the left part black with the name 神威 in gold written
// vertically (characters 0.13 of the height) and 太湖之光 smaller beside it; the right part deep blue with a field
// of small white-blue lights. Only one free photo was found, so depth and the cabinet front are estimated.
// Real machine: 40 compute cabinets, 40,960 SW26010 nodes.
import { makeKit } from "../lib/kit.js";

export const meta = {
  id: "taihulight", name: "Sunway TaihuLight", year: 2016, footprint_m: [5.1, 4.8], height_m: 2.02,
  maker: "NRCPC", real_count: "40 compute cabinets, 40,960 nodes (section shows 2 rows x 5)",
  sources: ["https://commons.wikimedia.org/wiki/File:Sunway_TaihuLight.jpg"],
  view: { yaw: -55, pitch: 12, dist: 9.0, target: [0, 1.0, 0] },
};
export const S = { rows: 2, per: 5, w: 1.0, d: 1.4, h: 2.0, aisle: 2.0 };
const PALETTES = { vectorfall: { gold: "#e6e8ec", field: "#5a0302", dots: "#ff8a70", led: "#c20a06" }, museum: { gold: "#d8a838", field: "#0a1640", dots: "#9ec4ff", led: "#3a6dff" } };

export function build(THREE, { palette = "vectorfall" } = {}) {
  const K = makeKit(THREE, { palette, palettes: PALETTES }), PAL = K.PAL, g = new THREE.Group(), add = (m) => (g.add(m), m);
  const { w, d, h, per } = S, black = K.M.carbon(), deep = K.M.black(0x0b0b0d, 0.5), led = K.M.led(PAL.led, 1.8);
  const front = K.canvasTex(128, 256, (c, W, H) => { c.fillStyle = "#101013"; c.fillRect(0, 0, W, H); c.fillStyle = "rgba(255,255,255,.04)"; for (let x = 6; x < W; x += 8) c.fillRect(x, 20, 3, H - 30); c.fillStyle = "#222"; c.fillRect(W / 2 - 1, 0, 2, H); });
  const door = K.M.tex(front, { roughness: 0.45, metalness: 0.3 });
  const end = K.canvasTex(512, 700, (c, W, H) => {
    c.fillStyle = PAL.field; c.fillRect(0, 0, W, H); const r = K.rng(8);
    for (let i = 0; i < 260; i++) { c.fillStyle = PAL.dots; c.globalAlpha = 0.4 + r() * 0.6; c.beginPath(); c.arc(W * (0.3 + r() * 0.7), r() * H, 1.5 + r() * 2.5, 0, 7); c.fill(); }
    c.globalAlpha = 1; c.fillStyle = "#0e0e11"; c.beginPath(); c.moveTo(0, 0); c.lineTo(W * 0.45, 0); c.lineTo(W * 0.3, H); c.lineTo(0, H); c.fill();
    c.fillStyle = PAL.gold; c.font = "700 96px KaiTi, STKaiti, SimSun, 'Microsoft YaHei', serif"; c.textAlign = "center";
    c.fillText("神", W * 0.17, H * 0.3); c.fillText("威", W * 0.17, H * 0.47);
    c.font = "600 34px KaiTi, SimSun, 'Microsoft YaHei', serif"; ["太", "湖", "之", "光"].forEach((ch, i) => c.fillText(ch, W * 0.33, H * (0.36 + i * 0.06)));
  });
  const endM = new THREE.MeshPhysicalMaterial({ map: end, roughness: 0.35, clearcoat: 0.6, emissiveMap: end, emissive: 0xffffff, emissiveIntensity: 0.12 });
  const L = per * w, Dt = S.rows * d + (S.rows - 1) * S.aisle;
  for (let r = 0; r < S.rows; r++) {
    const z = -Dt / 2 + d / 2 + r * (d + S.aisle);
    for (let i = 0; i < per; i++) {
      const x = L / 2 - (i + 0.5) * w;
      add(K.box(w - 0.006, h, d, [black, black, black, deep, black, door], { x, z }));
      add(K.box(w - 0.04, 0.012, 0.008, led, { x, y: h - 0.10, z: z - d / 2 - 0.004, shadow: false }));
    }
    add(K.box(0.05, h + 0.02, d + 0.06, [black, endM, black, black, black, black], { x: -L / 2 - 0.025, z }));
    add(K.box(0.05, h + 0.02, d + 0.06, black, { x: L / 2 + 0.025, z }));
  }
  return K.finish(g);
}
