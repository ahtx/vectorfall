// Thinking Machines CM-5 (1991), the FROSTBURG machine at the National Cryptologic Museum.
// Measured from Commons photos: four full-height corner towers 0.50 x 0.50 m with horizontal fluting,
// a core recessed 0.08 m at the front and 0.15 m at the back (vertically ribbed rear wall), LED bays with
// two vertical strips of red processor-status LEDs, one bay on the front between the left tower and a
// flat panel, one strip on the right tower's front, and one bay in the far end between its two towers (the near end is plain).
// Overall 3.0 x 1.4 x 2.35 m (length about 1.3 x height in the front view). The LEDs blink at random.
import { makeKit } from "../lib/kit.js";

export const meta = {
  id: "cm-5", name: "Thinking Machines CM-5", year: 1991, footprint_m: [3.0, 1.4], height_m: 2.38,
  maker: "Thinking Machines Corporation", real_count: "FROSTBURG, 1 machine (largest CM-5: 1,024 nodes in many cabinets)",
  sources: [
    "https://commons.wikimedia.org/wiki/File:Connection_Machine_CM-5_(FROSTBERG)_at_National_Cryptologic_Museum_(2).jpg",
    "https://commons.wikimedia.org/wiki/File:Thinking_Machines_Connection_Machine_CM-5_Frostburg_2.jpg",
    "https://commons.wikimedia.org/wiki/File:Connection_Machine_CM-5_(FROSTBERG)_at_National_Cryptologic_Museum.agr.jpg",
    "https://commons.wikimedia.org/wiki/File:Connection_Machine_CM-5_(FROSTBERG)_(back).jpg",
  ],
  view: { yaw: 34, pitch: 10, dist: 7.4, target: [0, 1.1, 0] },
};
export const S = { L: 3.0, D: 1.4, H: 2.35, tw: 0.5, cap: 0.03, frontRecess: 0.08, backRecess: 0.15, bayW: 0.42, strip: 0.13 };
const PALETTES = { vectorfall: { led: "#ff2414", body: "#121214" }, museum: { led: "#ff3a22", body: "#151517" } };

export function build(THREE, { palette = "vectorfall" } = {}) {
  const K = makeKit(THREE, { palette, palettes: PALETTES }), PAL = K.PAL, g = new THREE.Group(), add = (m) => (g.add(m), m);
  const { L, D, H, tw } = S;
  const flute = (vertical) => K.canvasTex(256, 256, (c, w, h) => {
    c.fillStyle = "#1a1a1c"; c.fillRect(0, 0, w, h);
    for (let k = 0; k < 64; k++) { const gr = c.createLinearGradient(...(vertical ? [k * 4, 0, k * 4 + 4, 0] : [0, k * 4, 0, k * 4 + 4]));
      gr.addColorStop(0, "#2c2c30"); gr.addColorStop(0.5, "#141416"); gr.addColorStop(1, "#060607"); c.fillStyle = gr; c.fillRect(...(vertical ? [k * 4, 0, 4, h] : [0, k * 4, w, 4])); }
  }, { repeat: true });
  const fH = flute(false), fV = flute(true); fH.repeat.set(1, 6); fV.repeat.set(4, 1);
  const tower = new THREE.MeshStandardMaterial({ color: 0xffffff, map: fH, bumpMap: fH, bumpScale: 2, roughness: 0.55, metalness: 0.2 });
  const ribbed = new THREE.MeshStandardMaterial({ color: 0xffffff, map: fV, bumpMap: fV, bumpScale: 2, roughness: 0.55, metalness: 0.2 });
  const body = new THREE.MeshPhysicalMaterial({ color: PAL.body, roughness: 0.42, clearcoat: 0.4, clearcoatRoughness: 0.35, sheen: 0.2, sheenColor: new THREE.Color(0x6a5a55) });
  const deep = K.M.black(0x08080a, 0.6);
  // LED field: 32 x 128 cells redrawn at random; each panel samples a different region
  const cv = document.createElement("canvas"); cv.width = 64; cv.height = 256; const cx = cv.getContext("2d");
  const ledTex = new THREE.CanvasTexture(cv); ledTex.colorSpace = THREE.SRGBColorSpace; ledTex.magFilter = THREE.NearestFilter; ledTex.wrapS = ledTex.wrapT = THREE.RepeatWrapping;
  const r = K.rng(77);
  const draw = () => { cx.fillStyle = "#1a0503"; cx.fillRect(0, 0, 64, 256);
    for (let y = 0; y < 128; y++) for (let x = 0; x < 32; x++) if (r() < 0.32) { cx.fillStyle = PAL.led; cx.fillRect(x * 2, y * 2, 1, 1); }
    ledTex.needsUpdate = true; };
  draw();
  const ledMats = [0, 1, 2, 3].map((i) => { const t = ledTex.clone(); t.offset.set(i * 0.25, i * 0.37); t.repeat.set(1.5, 1.7); t.needsUpdate = true;
    return new THREE.MeshStandardMaterial({ color: 0x220806, map: t, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 1.5, roughness: 0.3 }); });
  // core
  add(K.box(L - 0.02, H, D - S.frontRecess - S.backRecess, body, { z: (S.backRecess - S.frontRecess) / 2 * -1 + 0 }));
  // corner towers (horizontal fluting), with a cap
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * (L - tw) / 2, z = sz * (D - tw) / 2;
    add(K.box(tw, H, tw, tower, { x, z })); add(K.box(tw + 0.01, S.cap, tw + 0.01, body, { x, y: H, z }));
  }
  // rear wall between the back towers: vertical ribs
  add(K.box(L - 2 * tw, H - 0.30, 0.02, ribbed, { y: 0.30, z: D / 2 - S.backRecess }));
  add(K.box(L - 2 * tw, 0.30, 0.04, body, { z: D / 2 - S.backRecess - 0.01 }));
  // LED bay: recessed frame with two strips
  const bay = (x, z, ry, w, mi) => {
    const p = new THREE.Group(); p.position.set(x, 0, z); p.rotation.y = ry; g.add(p);
    p.add(K.box(w, H - 0.36, 0.02, deep, { y: 0.24, z: 0.01 }));
    [-1, 1].forEach((s, k) => p.add(K.box(S.strip, H - 0.62, 0.012, ledMats[(mi + k) % 4], { x: s * w / 4.2, y: 0.40, z: -0.004, shadow: false })));
  };
  const zf = -D / 2 + S.frontRecess;
  bay(L / 2 - tw - S.bayW / 2 - 0.02, zf - 0.005, 0, S.bayW, 0);
  // the flat front panel beside the bay (bay on the left as seen from the front: +x), slightly proud
  const fx0 = -L / 2 + tw, fx1 = L / 2 - tw - S.bayW - 0.04;
  add(K.box(fx1 - fx0, H - 0.08, 0.03, body, { x: (fx0 + fx1) / 2, y: 0.04, z: zf - 0.015 }));
  // one strip on the right front tower's face
  add(K.box(tw - 0.02, H - 0.30, 0.02, deep, { x: -(L - tw) / 2, y: 0.18, z: -D / 2 - 0.006 }));
  add(K.box(S.strip, H - 0.62, 0.012, ledMats[2], { x: -(L - tw) / 2 - 0.08, y: 0.34, z: -D / 2 - 0.018, shadow: false }));
  // end bays between the two towers of each end
  bay(-L / 2 + 0.01, 0, Math.PI / 2, D - 2 * tw - 0.02, 1); // the far end only; the end beside the front bay is plain
  // plinth shadow gap
  add(K.box(L - 0.06, 0.04, D - 0.06, deep, { y: -0.0 }));
  let last = -1;
  return K.finish(g, (t) => { const f = Math.floor(t * 5); if (f !== last) { last = f; draw(); ledMats.forEach((m) => (m.map.needsUpdate = true)); } });
}
