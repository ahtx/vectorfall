// Tianhe-2 (NUDT, 2013, National Supercomputer Center in Guangzhou). Representative section: two facing rows of 8
// cabinets with their aisle-end housings. Measured from the Commons hall photo: black cabinets 0.60 m wide,
// 1.20 m deep, 2.0 m tall with a blue LED line 0.12 m from the top and a red/blue LED line at the kick plate;
// each row ends in a large black housing 2.35 m tall, 0.42 m wider than the row on each side (end face 2.04 m wide, height 1.15 x width), whose end face
// is an irregular octagon (top corners cut 0.12 m, bottom corners cut 0.18 m), with the name 天河 in gold at
// 0.84 of its height on the outer half. Aisle 1.4 m. Real machine: 125 compute cabinets (162 with
// communication and storage), 16,000 nodes.
import { makeKit } from "../lib/kit.js";

export const meta = {
  id: "tianhe-2", name: "Tianhe-2", year: 2013, footprint_m: [5.5, 4.4], height_m: 2.35,
  maker: "NUDT", real_count: "125 compute cabinets, 162 in all (section shows 2 rows x 8)",
  sources: ["https://commons.wikimedia.org/wiki/File:Tianhe-2_in_National_Supercomputer_Center_in_Guangzhou.jpg"],
  view: { yaw: -62, pitch: 12, dist: 9.0, target: [0, 1.05, 0] },
};
export const S = { per: 8, w: 0.60, d: 1.20, h: 2.0, aisle: 1.4, capH: 2.35, capOver: 0.42, capL: 0.70, cutTop: 0.12, cutBot: 0.18 };
const PALETTES = { vectorfall: { name: "#d8dbe0", ledTop: "#3aa0ff", ledBot: "#c20a06" }, museum: { name: "#d4a640", ledTop: "#3a6dff", ledBot: "#ff3030" } };

export function build(THREE, { palette = "vectorfall" } = {}) {
  const K = makeKit(THREE, { palette, palettes: PALETTES }), PAL = K.PAL, g = new THREE.Group(), add = (m) => (g.add(m), m);
  const { w, d, h, per } = S, black = K.M.carbon(), deep = K.M.black(0x0a0a0c, 0.5);
  const shell = new THREE.MeshPhysicalMaterial({ color: 0x1e1e21, roughness: 0.45, clearcoat: 0.35, clearcoatRoughness: 0.35, sheen: 0.2, sheenColor: new THREE.Color(0x777777) });
  const ledT = K.M.led(PAL.ledTop, 1.8), ledB = K.M.led(PAL.ledBot, 1.8);
  const doorTex = K.canvasTex(128, 512, (c, W, H) => { c.fillStyle = "#121215"; c.fillRect(0, 0, W, H); c.fillStyle = "rgba(0,0,0,.5)"; for (let y = 60; y < H - 40; y += 3) c.fillRect(8, y, W - 16, 1); c.fillStyle = "#2a2b30"; c.fillRect(W - 14, H * 0.45, 4, 40); });
  const door = K.M.tex(doorTex, { roughness: 0.5, metalness: 0.3 });
  const name = K.canvasTex(256, 128, (c, W, H) => { c.clearRect(0, 0, W, H); c.fillStyle = PAL.name; c.font = "700 92px 'KaiTi', 'STKaiti', 'SimSun', 'Microsoft YaHei', serif"; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText("天河", W / 2, H / 2 + 4); });
  const nameM = new THREE.MeshStandardMaterial({ map: name, transparent: true, roughness: 0.35, metalness: 0.5 });
  const L = per * w;
  for (const side of [-1, 1]) { // two rows facing each other across the aisle (z = 0)
    const z = side * (S.aisle / 2 + d / 2), front = side < 0 ? 4 : 5; // the face toward the aisle
    for (let i = 0; i < per; i++) {
      const x = L / 2 - (i + 0.5) * w, mats = [black, black, black, deep, black, black]; mats[front] = door;
      add(K.box(w - 0.006, h, d, mats, { x, z }));
      const zf = z - side * (d / 2 + 0.004);
      add(K.box(w - 0.02, 0.012, 0.008, ledT, { x, y: h - 0.12, z: zf, shadow: false }));
      add(K.box(w - 0.02, 0.012, 0.008, ledB, { x, y: 0.06, z: zf, shadow: false }));
    }
    // aisle-end housing at the -x end of the row (the end the visitor faces)
    const W2 = d / 2 + S.capOver, ct = S.cutTop, cb = S.cutBot, H2 = S.capH;
    const prof = [[-W2 + cb, 0], [W2 - cb, 0], [W2, cb], [W2, H2 - ct], [W2 - ct, H2], [-W2 + ct, H2], [-W2, H2 - ct], [-W2, cb]];
    const xc = -L / 2 - S.capL / 2;
    add(K.profile(prof, -S.capL / 2, S.capL / 2, shell, { x: xc, z, ry: Math.PI / 2 }));
    add(K.mesh(new THREE.BoxGeometry(0.002, 0.18, 0.36), [nameM, nameM, nameM, nameM, nameM, nameM], { x: xc - S.capL / 2 - 0.002, y: H2 * 0.84, z: z + side * W2 * 0.45 }));
    add(K.box(0.01, 0.012, 2 * W2 - 0.3, ledT, { x: xc - S.capL / 2 - 0.004, y: 0.05, z, shadow: false }));
  }
  return K.finish(g);
}
