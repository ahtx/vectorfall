// Fugaku (RIKEN / Fujitsu, 2020, Kobe). Representative section: 2 rows x 8 racks.
// Measured from Commons photos (R-CCS hall, visitor photo, SC19 display rack): black racks 0.80 m wide, 1.40 m
// deep, 2.0 m tall, mesh fronts showing the board stack with green LED columns at the left of each board slot;
// every row ends in a full-height panel 0.06 m proud of the rack line, painted as a sky gradient (pale at 0.6
// of the height, deep blue at the floor, a lighter band of cloud at 0.45) with the name small at the lower left;
// a 0.06 m aluminium-grey kick plate. The SC19 display rack shows the glossy red side used in the house palette.
// Real machine: 432 racks, 158,976 A64FX nodes.
import { makeKit } from "../lib/kit.js";

export const meta = {
  id: "fugaku", name: "Fugaku", year: 2020, footprint_m: [6.5, 4.8], height_m: 2.02,
  maker: "RIKEN / Fujitsu", real_count: "432 racks, 158,976 nodes (section shows 2 rows x 8)",
  sources: [
    "https://commons.wikimedia.org/wiki/File:RIKEN_R-CCS_Fugaku.jpg",
    "https://commons.wikimedia.org/wiki/File:Visit_of_Henna_Virkkunen,_to_Japan_(P-066533-00-28).jpg",
    "https://commons.wikimedia.org/wiki/File:FugakuSupercomputerSC19.jpg",
  ],
  view: { yaw: -48, pitch: 12, dist: 10.5, target: [0, 1.0, 0] },
};
export const S = { rows: 2, per: 8, w: 0.80, d: 1.40, h: 2.0, aisle: 2.0, kick: 0.06 };
const PALETTES = {
  vectorfall: { sky: ["#f1d9d6", "#c20a06", "#3a0201"], cloud: "rgba(255,235,230,.15)", text: "#ffffff" },
  museum: { sky: ["#e9f1f8", "#5d8fc9", "#0d3a8a"], cloud: "rgba(255,255,255,.18)", text: "#ffffff" },
};

export function build(THREE, { palette = "vectorfall" } = {}) {
  const K = makeKit(THREE, { palette, palettes: PALETTES }), PAL = K.PAL, g = new THREE.Group(), add = (m) => (g.add(m), m);
  const { w, d, h, per } = S, black = K.M.carbon(), deep = K.M.black(0x0b0b0d, 0.5), grey = K.M.brushed("#9ea2a8");
  const front = K.canvasTex(160, 400, (c, W, H) => {
    c.fillStyle = "#0a0b0c"; c.fillRect(0, 0, W, H); const r = K.rng(5);
    for (let y = 16; y < H - 16; y += 12) { c.fillStyle = "#1b1d20"; c.fillRect(10, y, W - 20, 9); for (let x = 14; x < 40; x += 6) { c.fillStyle = r() < 0.6 ? "#3dff7a" : "#0c3a1c"; c.fillRect(x, y + 3, 3, 3); } }
    c.fillStyle = "rgba(0,0,0,.4)"; for (let y = 0; y < H; y += 3) c.fillRect(0, y, W, 1);
  });
  const door = new THREE.MeshStandardMaterial({ map: front, emissiveMap: front, emissive: 0xffffff, emissiveIntensity: 0.4, roughness: 0.55, metalness: 0.3 });
  const sky = K.canvasTex(512, 512, (c, W, H) => {
    const [a, b, e] = PAL.sky, gr = c.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, b); gr.addColorStop(0.4, a); gr.addColorStop(0.55, b); gr.addColorStop(1, e);
    c.fillStyle = gr; c.fillRect(0, 0, W, H); const r = K.rng(3);
    for (let i = 0; i < 14; i++) { c.fillStyle = PAL.cloud; c.beginPath(); c.ellipse(r() * W, H * (0.42 + r() * 0.1), 30 + r() * 80, 6 + r() * 10, 0, 0, 7); c.fill(); }
    c.fillStyle = PAL.text; c.font = "italic 600 26px Georgia, serif"; c.fillText("Fugaku", 40, H * 0.93);
  });
  const skyM = new THREE.MeshPhysicalMaterial({ map: sky, roughness: 0.3, clearcoat: 0.7, clearcoatRoughness: 0.15 });
  const L = per * w, Dt = S.rows * d + (S.rows - 1) * S.aisle;
  for (let r = 0; r < S.rows; r++) {
    const z = -Dt / 2 + d / 2 + r * (d + S.aisle);
    for (let i = 0; i < per; i++) {
      const x = L / 2 - (i + 0.5) * w;
      add(K.box(w - 0.006, h - S.kick, d, [black, black, black, deep, black, door], { x, y: S.kick, z }));
      add(K.box(w - 0.006, S.kick, d - 0.01, grey, { x, z }));
    }
    for (const s of [-1, 1]) { // sky panels on both row ends (the -x one faces the visitor)
      const mats = [black, black, black, black, skyM, skyM]; mats[s < 0 ? 1 : 0] = skyM;
      add(K.box(0.06, h + 0.02, d + 0.12, mats, { x: s * (L / 2 + 0.03), z }));
    }
  }
  return K.finish(g);
}
