// LineShine (National Supercomputing Centre in Shenzhen, 2026; #1 June and November 2026), the first CPU-only
// machine past 2 EFLOP/s. Representative section: 2 rows x 8 cabinets with their row-end housings.
// Measured from the one reliable press photo of the hall (study only, see reference/SOURCES.txt): cabinets 0.80 m
// wide (two door panels each), 2.25 m tall; between cabinets a pink-to-red light strip; the doors carry one
// graphic along the row, rendered abstractly: deep blue sky with a cloud bank, warming to an orange sunrise toward
// the far end, the name 灵晟 / LineShine in gold on the third and fourth door panels. Each row ends in a black
// housing 2.40 m tall, 0.30 m proud of the doors at the top, its front edge leaning back to the floor and its
// lower front cut by a large chamfer; a pink-to-blue light line runs down the leaning edge; a blue glow under the
// plinth; the calligraphic mark high on the end face. Cabinet depth and door construction are generic modern
// liquid-cooled rack details (not measured). Real machine: about 92 compute cabinets, 40,960 LX2 processors.
import { makeKit } from "../lib/kit.js";

export const meta = {
  id: "lineshine", name: "LineShine", year: 2026, footprint_m: [7.5, 5.2], height_m: 2.4,
  maker: "Shenzhen Cloud Computing Center / Sun Yat-sen University", real_count: "about 92 compute cabinets (section shows 2 rows x 8)",
  sources: ["https://www.gigazine.net/gsc_news/en/20260630-lineshine-china-supercomputer"],
  view: { yaw: 42, pitch: 10, dist: 11.0, target: [0, 1.15, 0] },
};
export const S = { rows: 2, per: 8, w: 0.80, d: 1.30, h: 2.25, aisle: 2.0, capL: 0.80, capH: 2.40, over: 0.30, chamfer: 0.55 };
const PALETTES = {
  vectorfall: { sky: ["#2a0302", "#8a0704", "#c20a06"], dawn: "#ff8a5a", strip: ["#ff5a7a", "#c20a06"], gold: "#e8e9ec", glow: 0x3aa0ff },
  museum: { sky: ["#0a1a6a", "#1f4fd0", "#6a9cf0"], dawn: "#ffb040", strip: ["#ff4a8a", "#ff2a3a"], gold: "#f2c23a", glow: 0x4a8aff },
};

export function build(THREE, { palette = "vectorfall" } = {}) {
  const K = makeKit(THREE, { palette, palettes: PALETTES }), PAL = K.PAL, g = new THREE.Group(), add = (m) => (g.add(m), m);
  const { w, d, h, per } = S, black = new THREE.MeshPhysicalMaterial({ color: 0x0e0e10, roughness: 0.35, clearcoat: 0.6 }), deep = K.M.black(0x0a0a0c, 0.5);
  const art = K.canvasTex(2560, 640, (c, W, H) => {
    const [a, b, e] = PAL.sky, v = c.createLinearGradient(0, 0, 0, H); v.addColorStop(0, a); v.addColorStop(0.55, b); v.addColorStop(0.75, e); v.addColorStop(1, a);
    c.fillStyle = v; c.fillRect(0, 0, W, H);
    const dawn = c.createLinearGradient(W * 0.45, 0, W, 0); dawn.addColorStop(0, "rgba(0,0,0,0)"); dawn.addColorStop(1, PAL.dawn); c.globalAlpha = 0.75; c.fillStyle = dawn; c.fillRect(0, H * 0.3, W, H * 0.4); c.globalAlpha = 1;
    const r = K.rng(5); for (let i = 0; i < 160; i++) { c.fillStyle = `rgba(255,255,255,${0.05 + r() * 0.12})`; c.beginPath(); c.ellipse(r() * W, H * (0.6 + r() * 0.12), 40 + r() * 120, 8 + r() * 14, 0, 0, 7); c.fill(); }
    for (let i = 0; i < 7; i++) { const x = W * (0.28 + i * 0.09), y = H * (0.35 + (i % 3) * 0.14); c.strokeStyle = "rgba(255,255,255,.55)"; c.lineWidth = 4; c.beginPath(); c.arc(x, y, 34, 0, 7); c.stroke(); }
    c.fillStyle = PAL.gold; c.font = "900 120px 'Microsoft YaHei', SimHei, sans-serif"; c.fillText("灵晟", W * 0.135, H * 0.30); c.font = "700 54px Arial"; c.fillText("LineShine", W * 0.137, H * 0.40);
    for (let k = 1; k < per * 2; k++) { c.fillStyle = "rgba(0,0,0,.6)"; c.fillRect(k * W / (per * 2) - 2, 0, 4, H); }
  });
  const stripM = K.M.led(PAL.strip[1], 1.4), glow = K.M.led(PAL.glow, 1.2);
  const markT = K.canvasTex(256, 128, (c, W, H) => { c.clearRect(0, 0, W, H); c.fillStyle = PAL.strip[1]; c.font = "italic 700 64px KaiTi, STKaiti, SimSun, serif"; c.fillText("灵晟", 20, 70); c.fillStyle = PAL.gold; c.font = "italic 500 30px Georgia, serif"; c.fillText("LineShine", 90, 108); });
  const mark = new THREE.MeshStandardMaterial({ map: markT, transparent: true, roughness: 0.4 });
  const L = per * w, Dt = S.rows * d + (S.rows - 1) * S.aisle;
  for (let r = 0; r < S.rows; r++) {
    const z = -Dt / 2 + d / 2 + r * (d + S.aisle), zf = z - d / 2;
    for (let i = 0; i < per; i++) {
      const x = L / 2 - (i + 0.5) * w, t = art.clone(); t.repeat.set(1 / per, 1); t.offset.set(i / per, 0); t.needsUpdate = true;
      const door = new THREE.MeshPhysicalMaterial({ map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 0.18, roughness: 0.2, clearcoat: 0.9 });
      add(K.box(w - 0.006, 0.06, d - 0.03, deep, { x, z }));
      add(K.box(w - 0.006, h - 0.06, d, [deep, deep, black, deep, deep, door], { x, y: 0.06, z }));
      add(K.box(0.012, h - 0.1, 0.01, stripM, { x: x - w / 2, y: 0.08, z: zf - 0.006, shadow: false }));
    }
    add(K.box(L, 0.012, 0.01, glow, { y: 0.02, z: zf - 0.01, shadow: false })); // glow along the kick plate
    // row-end housing at the +x end (left seen from the front); the graphic starts beside it and runs to -x
    const xc = L / 2 + S.capL / 2, zb = z + d / 2 + 0.05, zt = zf - S.over, zl = zf + 0.08;
    const prof = [[zl + S.chamfer * 0.5, 0], [zb, 0], [zb, S.capH], [zt, S.capH], [zl, S.chamfer], ]; // (z, y): leaning front, chamfered foot
    add(K.profile(prof.map(([pz, py]) => [-pz, py]), -S.capL / 2, S.capL / 2, black, { x: xc, ry: Math.PI / 2 }));
    const len = Math.hypot(zl - zt, S.capH - S.chamfer), ang = Math.atan2(zl - zt, S.capH - S.chamfer);
    for (const sx of [-1, 1]) add(K.mesh(new THREE.BoxGeometry(0.02, len, 0.02), stripM, { x: xc + sx * (S.capL / 2 + 0.008), y: (S.capH + S.chamfer) / 2, z: (zt + zl) / 2, rx: -ang, shadow: false }));
    add(K.box(S.capL - 0.04, 0.03, d * 0.7, glow, { x: xc, y: 0.0, z: z + 0.1, shadow: false }));
    add(K.mesh(new THREE.BoxGeometry(0.004, 0.25, 0.5), [mark, mark, mark, mark, mark, mark], { x: xc + S.capL / 2 + 0.004, y: S.capH * 0.82, z: z - 0.15, print: false }));
  }
  return K.finish(g);
}
