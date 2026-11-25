// El Capitan (HPE Cray EX255a, 2024, Lawrence Livermore; #1 on the TOP500 from November 2024).
// Representative section: 2 rows x 6 cabinets. Measured from the LLNL row photo (study only, see reference/):
// HPE Cray EX cabinets 1.20 m wide, 1.50 m deep, 2.30 m tall, each front split into three tall doors 0.40 m wide
// with a round latch at 0.55 of the height and a teal status light at the top; a teal light line at the kick plate.
// The row graphic, rendered abstractly: the first 0.35 of the row plain black (sponsor marks left out), then the
// name in white block letters 0.25 of the door height at 0.60 of the height with a thin subtitle line under it,
// over a landscape that runs from dark forest at the left to grey granite cliffs and pale sky at the right.
// The row end carries an arched badge (sky, mountain silhouette, sun) above the name.
// Real machine: 11,136 nodes, each four AMD MI300A APUs, in liquid-cooled EX cabinets.
import { makeKit } from "../lib/kit.js";

export const meta = {
  id: "el-capitan", name: "El Capitan", year: 2024, footprint_m: [7.3, 5.0], height_m: 2.3,
  maker: "HPE Cray / LLNL", real_count: "11,136 nodes, 44,544 MI300A APUs (section shows 2 rows x 6 cabinets)",
  sources: ["https://hpc.llnl.gov/hardware/compute-platforms/el-capitan"],
  view: { yaw: 40, pitch: 12, dist: 11.0, target: [0, 1.15, 0] },
};
export const S = { rows: 2, per: 6, w: 1.20, d: 1.50, h: 2.30, aisle: 2.0, doors: 3 };
const PALETTES = {
  vectorfall: { forest: ["#1a0302", "#5a0603"], rock: ["#8e8f94", "#c20a06"], sky: "#e7c9c4", badgeSky: "#c20a06", led: "#3aa0ff" },
  museum: { forest: ["#141a10", "#3d4a26"], rock: ["#5f5b53", "#aaa392"], sky: "#a9c9e8", badgeSky: "#5d95c9", led: "#20d6b0" },
};

export function build(THREE, { palette = "vectorfall" } = {}) {
  const K = makeKit(THREE, { palette, palettes: PALETTES }), PAL = K.PAL, g = new THREE.Group(), add = (m) => (g.add(m), m);
  const { w, d, h, per } = S, deep = K.M.black(0x0a0a0c, 0.5), black = K.M.carbon(), led = K.M.led(PAL.led, 1.6);
  const rowArt = K.canvasTex(3072, 512, (c, W, H) => {
    c.fillStyle = "#0b0b0d"; c.fillRect(0, 0, W, H); const r = K.rng(12), x0 = W * 0.35;
    const sky = c.createLinearGradient(0, 0, 0, H * 0.6); sky.addColorStop(0, PAL.sky); sky.addColorStop(1, "rgba(255,255,255,0)");
    c.save(); c.beginPath(); c.rect(x0, 0, W - x0, H); c.clip();
    c.fillStyle = sky; c.fillRect(x0, 0, W - x0, H);
    for (let i = 0; i < 26; i++) { // granite cliffs, taller toward the right
      const cx = x0 + (W - x0) * (0.35 + r() * 0.65), top = H * (0.05 + r() * 0.4), wd = 80 + r() * 220;
      const gr = c.createLinearGradient(cx, top, cx + wd, H); gr.addColorStop(0, PAL.rock[1]); gr.addColorStop(1, PAL.rock[0]);
      c.fillStyle = gr; c.beginPath(); c.moveTo(cx - wd, H); c.lineTo(cx - wd * 0.3, top + 40); c.lineTo(cx, top); c.lineTo(cx + wd * 0.4, top + 60); c.lineTo(cx + wd, H); c.fill();
    }
    for (let i = 0; i < 5200; i++) { // forest: small conifer marks, dense at the left of the landscape
      const u = Math.pow(r(), 1.8), x = x0 + u * (W - x0), y = H * (0.25 + r() * 0.75) + u * H * 0.35;
      c.fillStyle = r() < 0.5 ? PAL.forest[0] : PAL.forest[1]; c.globalAlpha = 0.5 + r() * 0.5; c.beginPath(); c.moveTo(x, y - 14 - r() * 18); c.lineTo(x + 3 + r() * 4, y + 6); c.lineTo(x - 3 - r() * 4, y + 6); c.fill(); c.globalAlpha = 1;
    }
    c.restore();
    c.fillStyle = "#f4f5f7"; c.font = "800 128px 'Arial Black', Arial"; c.textBaseline = "middle"; c.letterSpacing = "10px";
    c.fillText("EL CAPITAN", W * 0.36, H * 0.6); c.fillRect(W * 0.36, H * 0.72, 700, 6); c.font = "700 20px Arial"; c.letterSpacing = "6px"; c.fillText("ADVANCED SIMULATION COMPUTING", W * 0.365, H * 0.77);
    for (let k = 1; k < per * S.doors; k++) { const x = k * W / (per * S.doors); c.fillStyle = "rgba(0,0,0,.75)"; c.fillRect(x - 2, 0, 4, H);
      c.fillStyle = "#2c2d31"; c.beginPath(); c.arc(x - 26, H * 0.45, 9, 0, 7); c.fill(); }
  });
  const endArt = K.canvasTex(512, 640, (c, W, H) => {
    c.fillStyle = "#0b0b0d"; c.fillRect(0, 0, W, H);
    c.save(); c.beginPath(); c.moveTo(150, 330); c.lineTo(150, 170); c.arc(256, 170, 106, Math.PI, 0); c.lineTo(362, 330); c.closePath(); c.clip();
    const sk = c.createLinearGradient(0, 64, 0, 330); sk.addColorStop(0, PAL.badgeSky); sk.addColorStop(1, "#e9eef2"); c.fillStyle = sk; c.fillRect(140, 60, 240, 280);
    c.fillStyle = "#f2c86a"; c.beginPath(); c.arc(320, 230, 26, 0, 7); c.fill();
    c.fillStyle = "#24303c"; c.beginPath(); c.moveTo(140, 330); c.lineTo(170, 200); c.lineTo(230, 160); c.lineTo(262, 250); c.lineTo(300, 270); c.lineTo(380, 330); c.fill(); c.restore();
    c.strokeStyle = "#f4f5f7"; c.lineWidth = 6; c.beginPath(); c.moveTo(150, 330); c.lineTo(150, 170); c.arc(256, 170, 106, Math.PI, 0); c.lineTo(362, 330); c.stroke();
    c.fillStyle = "#f4f5f7"; c.font = "800 58px 'Arial Black', Arial"; c.textAlign = "center"; c.fillText("EL CAPITAN", W / 2, 410);
  });
  const endM = new THREE.MeshPhysicalMaterial({ map: endArt, roughness: 0.25, clearcoat: 0.9, clearcoatRoughness: 0.1 });
  const L = per * w, Dt = S.rows * d + (S.rows - 1) * S.aisle;
  for (let r = 0; r < S.rows; r++) {
    const z = -Dt / 2 + d / 2 + r * (d + S.aisle), zf = z - d / 2;
    for (let i = 0; i < per; i++) {
      const x = L / 2 - (i + 0.5) * w, t = rowArt.clone(); t.repeat.set(1 / per, 1); t.offset.set(i / per, 0); t.needsUpdate = true;
      const door = new THREE.MeshPhysicalMaterial({ map: t, roughness: 0.25, clearcoat: 0.9, clearcoatRoughness: 0.1 });
      add(K.box(w - 0.008, 0.08, d - 0.02, deep, { x, z }));
      add(K.box(w - 0.008, h - 0.08, d, [black, black, black, deep, black, door], { x, y: 0.08, z }));
      add(K.box(w - 0.04, 0.012, 0.008, led, { x, y: 0.035, z: zf + 0.006, shadow: false }));
      for (let k = 0; k < S.doors; k++) add(K.box(0.03, 0.01, 0.008, led, { x: x + w / 2 - (k + 0.5) * w / S.doors, y: h - 0.06, z: zf - 0.004, shadow: false }));
    }
    add(K.box(0.05, h, d, [endM, black, black, black, black, black], { x: L / 2 + 0.025, z })); // badge end beside the plain section (+x: left seen from the front)
    add(K.box(0.05, h, d, black, { x: -L / 2 - 0.025, z }));
  }
  return K.finish(g);
}
