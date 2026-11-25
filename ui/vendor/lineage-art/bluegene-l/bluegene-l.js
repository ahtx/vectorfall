// IBM Blue Gene/L (2004, LLNL). Representative section: 2 rows x 8 racks.
// Measured from Commons photos (LLNL hall, DOE photo, single open rack): each rack is a charcoal slab whose
// side leans: in the front view the rack is a trapezoid, 0.91 m wide at the floor and 0.66 m at the top,
// so the row reads as a line of leaning slabs with triangular air plenums between them; a thin blue stripe
// runs up the slanted edge; a vent grille fills the top 0.12 of the front; IBM-style badge high on the front.
// Rack 0.91 m deep, 1.98 m tall; racks repeat every 0.95 m. Real machine: 104 racks (106,496 nodes) at LLNL.
import { makeKit } from "../lib/kit.js";

export const meta = {
  id: "bluegene-l", name: "IBM Blue Gene/L", year: 2004, footprint_m: [7.7, 3.7], height_m: 1.98,
  maker: "IBM", real_count: "104 racks at LLNL (section shows 2 rows x 8)",
  sources: [
    "https://commons.wikimedia.org/wiki/File:20080831-R0012506.JPG",
    "https://commons.wikimedia.org/wiki/File:Blue_gene(s).jpg",
    "https://commons.wikimedia.org/wiki/File:U.S._Department_of_Energy_-_Science_-_477_015_010_(9737767578).jpg",
    "https://commons.wikimedia.org/wiki/File:BlueGeneL_cabinet.jpg",
  ],
  view: { yaw: -42, pitch: 14, dist: 10.5, target: [0, 0.95, 0] },
};
export const S = { rows: 2, per: 8, wb: 0.91, wt: 0.66, d: 0.91, h: 1.98, pitch: 0.95, aisle: 1.9, grille: 0.12 };
const PALETTES = { vectorfall: { stripe: "#c20a06", body: "#232428" }, museum: { stripe: "#2f55c8", body: "#2a2b30" } };

export function build(THREE, { palette = "vectorfall" } = {}) {
  const K = makeKit(THREE, { palette, palettes: PALETTES }), PAL = K.PAL, g = new THREE.Group(), add = (m) => (g.add(m), m);
  const { wb, wt, d, h } = S;
  const body = new THREE.MeshPhysicalMaterial({ color: PAL.body, roughness: 0.5, clearcoat: 0.25, clearcoatRoughness: 0.4, sheen: 0.3, sheenColor: new THREE.Color(0x7a8090) });
  const stripe = K.M.paint(PAL.stripe, { seed: 21, roughness: 0.35, clearcoat: 0.6 });
  const grilleTex = K.canvasTex(128, 32, (c, w, hh) => { c.fillStyle = "#0c0c0e"; c.fillRect(0, 0, w, hh); c.fillStyle = "#3a3c42"; for (let x = 0; x < w; x += 4) c.fillRect(x, 0, 2, hh); }, { repeat: true });
  grilleTex.repeat.set(4, 1);
  const grille = K.M.tex(grilleTex, { roughness: 0.6, metalness: 0.4 });
  const badge = new THREE.MeshStandardMaterial({ map: K.plateTex([["BLUE GENE", "800 40px Arial", 0.65]], { w: 256, h: 64, bg: "#1b1c20", fg: "#d4d6da", border: null }), roughness: 0.4 });
  const dark = K.M.black(0x0e0e10, 0.5);
  const L = (S.per - 1) * S.pitch + wb, Dtot = S.rows * d + (S.rows - 1) * S.aisle;
  for (let r = 0; r < S.rows; r++) {
    const z0 = -Dtot / 2 + r * (d + S.aisle);
    for (let i = 0; i < S.per; i++) {
      const x0 = -L / 2 + i * S.pitch; // +x edge vertical; the slant is on the -x edge, which reads on the right seen from the front
      const prof = [[0, 0], [wb, 0], [wb, h], [wb - wt, h]];
      add(K.profile(prof, z0, z0 + d, body, { x: x0 }));
      // stripe along the slanted front edge: a thin slab rotated to the lean
      const len = Math.hypot(wb - wt, h), ang = Math.atan2(wb - wt, h);
      add(K.mesh(new THREE.BoxGeometry(0.03, len, 0.012), stripe, { x: x0 + (wb - wt) / 2 + 0.02, y: h / 2, z: z0 - 0.006, rz: -ang }));
      add(K.box(wt - 0.08, h * S.grille, 0.012, grille, { x: x0 + wb - wt / 2 + 0.02, y: h * (1 - S.grille) - 0.03, z: z0 - 0.006 }));
      add(K.mesh(new THREE.BoxGeometry(0.2, 0.05, 0.006), [dark, dark, dark, dark, dark, badge], { x: x0 + wb - 0.2, y: h * 0.78, z: z0 - 0.003 }));
    }
  }
  return K.finish(g);
}
