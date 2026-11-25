// Cray Jaguar (XT5, 2009) / Titan (XK7, 2012), Oak Ridge. Same cabinet rows, upgraded; each era had its own
// full-height door graphics spanning a whole row. Representative section: 2 rows x 8 cabinets; the front row
// carries the TITAN-era graphic, the back row the JAGUAR-era graphic, both rendered abstractly (machine name
// lettering, colour field and pattern; no other imagery).
// Measured from Commons photos (OLCF Jaguar and Titan rows): cabinet 0.57 m wide, 1.44 m deep, 2.0 m tall
// (published XT/XK cabinet), a black top plenum 0.11 of the height, a black 0.05 m kick plate, hairline gaps
// between doors; the name letters fill 0.75 of the door height and span about 6 cabinets;
// XK7 rows carry silver coolant pipes along the top.
// Real machine: 200 cabinets (Titan: 18,688 nodes, each a CPU plus a GPU).
import { makeKit } from "../lib/kit.js";

export const meta = {
  id: "jaguar-titan", name: "Cray Jaguar / Titan", year: 2009, footprint_m: [4.6, 4.8], height_m: 2.0,
  maker: "Cray", real_count: "200 cabinets (section shows 2 rows x 8)",
  sources: [
    "https://commons.wikimedia.org/wiki/File:Jaguar_Supercomputer_(3592579288).jpg",
    "https://commons.wikimedia.org/wiki/File:Jaguar_Supercomputer_(4101197106).jpg",
    "https://commons.wikimedia.org/wiki/File:Titan,_2013_(49912802521).jpg",
    "https://commons.wikimedia.org/wiki/File:Titan_supercomputer_(12507365975).jpg",
  ],
  view: { yaw: -30, pitch: 12, dist: 9.0, target: [0, 1.0, 0] },
};
export const S = { rows: 2, per: 8, w: 0.57, d: 1.44, h: 2.0, top: 0.11, kick: 0.05, aisle: 1.9, gap: 0.004 };
const PALETTES = {
  vectorfall: { titan: ["#2a0302", "#c20a06", "#ff5a3c"], titanText: "#e6e8ec", jaguar: ["#1a0202", "#8a0704", "#c20a06"], jaguarText: "#d6d9de" },
  museum: { titan: ["#03141c", "#0aa6d6", "#8ff0ff"], titanText: "#0b1a22", jaguar: ["#0b1d18", "#3f8a78", "#b9e3d4"], jaguarText: "#8a3a12" },
};

export function build(THREE, { palette = "vectorfall" } = {}) {
  const K = makeKit(THREE, { palette, palettes: PALETTES }), PAL = K.PAL, g = new THREE.Group(), add = (m) => (g.add(m), m);
  const { w, d, h, per } = S, black = K.M.carbon(), deep = K.M.black(0x0c0c0e, 0.5), side = K.M.black(0x1a1b1e, 0.45);
  const art = (name, [c0, c1, c2], text, pattern) => K.canvasTex(2048, 512, (c, W, H) => {
    const gr = c.createLinearGradient(0, H, W, 0); gr.addColorStop(0, c0); gr.addColorStop(0.5, c1); gr.addColorStop(1, c0); c.fillStyle = gr; c.fillRect(0, 0, W, H);
    const r = K.rng(name.length * 31);
    if (pattern === "streaks") for (let i = 0; i < 260; i++) { c.strokeStyle = `${c2}${(20 + r() * 60 | 0).toString(16)}`; c.lineWidth = 1 + r() * 4; const x = r() * W; c.beginPath(); c.moveTo(x, H); c.bezierCurveTo(x + 60, H * 0.6, x - 80, H * 0.3, x + r() * 200 - 100, 0); c.stroke(); }
    else for (let i = 0; i < 900; i++) { c.fillStyle = `rgba(10,12,10,${0.2 + r() * 0.5})`; const x = W * (0.55 + r() * 0.45), y = r() * H, s = 3 + r() * 10; c.beginPath(); c.ellipse(x, y, s, s * 0.7, r() * 3, 0, 7); c.fill(); }
    const v = c.createLinearGradient(0, 0, 0, H); v.addColorStop(0, "rgba(255,255,255,.10)"); v.addColorStop(0.6, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,.35)"); c.fillStyle = v; c.fillRect(0, 0, W, H);
    c.font = "900 400px Georgia, 'Times New Roman', serif"; c.textBaseline = "middle"; c.fillStyle = text; c.strokeStyle = "rgba(0,0,0,.35)"; c.lineWidth = 6;
    c.letterSpacing = "60px"; c.strokeText(name, 40, H * 0.5); c.fillText(name, 40, H * 0.5);
  });
  const arts = [art("TITAN", PAL.titan, PAL.titanText, "streaks"), art("JAGUAR", PAL.jaguar, PAL.jaguarText, "spots")];
  const L = per * w, Dt = S.rows * d + (S.rows - 1) * S.aisle;
  for (let r = 0; r < S.rows; r++) {
    const z = -Dt / 2 + d / 2 + r * (d + S.aisle), base = arts[r];
    for (let i = 0; i < per; i++) {
      const x = L / 2 - (i + 0.5) * w; // cabinet 0 at the left as seen from the front (-z)
      const t = base.clone(); t.repeat.set(1 / per, 1); t.offset.set(i / per, 0); t.needsUpdate = true;
      const door = new THREE.MeshPhysicalMaterial({ map: t, roughness: 0.35, clearcoat: 0.6, clearcoatRoughness: 0.2 });
      const hd = h * (1 - S.top) - S.kick;
      add(K.box(w - S.gap, S.kick, d - 0.02, deep, { x, z }));
      add(K.box(w - S.gap, hd, d, [side, side, side, side, side, door], { x, y: S.kick, z }));
      add(K.box(w - S.gap, h * S.top, d, black, { x, y: S.kick + hd, z }));
    }
    for (const py of [0.03, 0.08]) for (const pz of [-0.45, 0.45]) // coolant pipes along the top of the row
      add(K.mesh(new THREE.CylinderGeometry(0.025, 0.025, L + 0.1, 20), K.M.alu(), { x: 0, y: h + py, z: z + pz * d / 1.44, rz: Math.PI / 2 }));
    // end panels on each row
    for (const s of [-1, 1]) add(K.box(0.04, h, d, black, { x: s * (L / 2 + 0.02), z }));
  }
  return K.finish(g);
}
