// Shared kit for the Lineage models: textures, house materials and closed-solid primitives.
// Pure ES module: it does not import three.js; every model passes in its THREE.
// Units are metres, y is up, the front of a machine faces -z.

export function makeKit(THREE, { palette = "vectorfall", palettes = {} } = {}) {
  const PAL = palettes[palette] || palettes.vectorfall || {};
  const rng = (seed) => { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; };

  // ---- textures
  function canvasTex(w, h, draw, { srgb = true, repeat = false } = {}) {
    const c = document.createElement("canvas"); c.width = w; c.height = h; draw(c.getContext("2d"), w, h);
    const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; return t;
  }
  // painted panel: fine grain, light from the ceiling (brighter top, deeper toward the floor), side sheen
  function noiseTex(base, grain = 0.06, seed = 3, w = 256, h = 512) {
    return canvasTex(w, h, (g) => {
      g.fillStyle = base; g.fillRect(0, 0, w, h);
      const r = rng(seed);
      for (let i = 0; i < w * h / 6; i++) { g.fillStyle = r() < 0.5 ? `rgba(0,0,0,${grain})` : `rgba(255,235,215,${grain * 0.7})`; g.fillRect(r() * w, r() * h, 1.5, 1.5); }
      const v = g.createLinearGradient(0, 0, 0, h);
      v.addColorStop(0, "rgba(255,225,215,.16)"); v.addColorStop(0.35, "rgba(255,225,215,0)"); v.addColorStop(0.75, "rgba(0,0,0,.18)"); v.addColorStop(1, "rgba(0,0,0,.42)");
      g.fillStyle = v; g.fillRect(0, 0, w, h);
      const hz = g.createLinearGradient(0, 0, w, 0);
      hz.addColorStop(0, "rgba(0,0,0,.18)"); hz.addColorStop(0.3, "rgba(255,230,220,.10)"); hz.addColorStop(0.55, "rgba(255,230,220,0)"); hz.addColorStop(1, "rgba(0,0,0,.12)");
      g.fillStyle = hz; g.fillRect(0, 0, w, h);
    }, { repeat: true });
  }
  function brushedTex(base = "#c9ccd1", seed = 7) { // brushed aluminium: fine horizontal streaks
    return canvasTex(256, 256, (g, w, h) => {
      g.fillStyle = base; g.fillRect(0, 0, w, h); const r = rng(seed);
      for (let i = 0; i < 1400; i++) { const y = r() * h, a = 0.03 + r() * 0.07; g.fillStyle = r() < 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`; g.fillRect(0, y, w, 0.6 + r()); }
    }, { repeat: true });
  }
  function carbonTex(seed = 9) { // dark enamel with a faint weave
    return canvasTex(256, 256, (g, w, h) => {
      g.fillStyle = "#1a1b1e"; g.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) { g.fillStyle = ((x + y) / 2) % 2 ? "rgba(255,255,255,.018)" : "rgba(0,0,0,.04)"; g.fillRect(x, y, 2, 2); }
      const v = g.createLinearGradient(0, 0, 0, h); v.addColorStop(0, "rgba(255,255,255,.05)"); v.addColorStop(1, "rgba(0,0,0,.25)"); g.fillStyle = v; g.fillRect(0, 0, w, h);
    }, { repeat: true });
  }
  // text plate: lines = [[text, font], ...]
  function plateTex(lines, { w = 512, h = 160, bg = "#151517", fg = "#eceef0", border = "#d9dce0" } = {}) {
    return canvasTex(w, h, (g) => {
      g.fillStyle = bg; g.fillRect(0, 0, w, h);
      if (border) { g.strokeStyle = border; g.lineWidth = 8; g.strokeRect(6, 6, w - 12, h - 12); }
      g.fillStyle = fg; g.textAlign = "center"; g.textBaseline = "alphabetic";
      lines.forEach(([t, f, y]) => { g.font = f; g.fillText(t, w / 2, y * h); });
    });
  }

  // ---- materials (cached by key)
  const cache = new Map();
  const once = (k, f) => (cache.has(k) ? cache.get(k) : (cache.set(k, f()), cache.get(k)));
  const M = {
    paint: (color, { seed = 3, grain = 0.06, roughness = 0.48, clearcoat = 0.35, ccr = 0.35, side = THREE.FrontSide } = {}) =>
      once(`paint${color}${seed}${roughness}${side}`, () => new THREE.MeshPhysicalMaterial({ color: 0xffffff, map: noiseTex(color, grain, seed), roughness, clearcoat, clearcoatRoughness: ccr, sheen: 0.25, sheenColor: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.25), side })),
    black: (color = 0x141416, roughness = 0.5) => once(`black${color}${roughness}`, () => new THREE.MeshStandardMaterial({ color, roughness })),
    carbon: () => once("carbon", () => new THREE.MeshPhysicalMaterial({ color: 0xffffff, map: carbonTex(), roughness: 0.42, clearcoat: 0.3, clearcoatRoughness: 0.4, sheen: 0.15, sheenColor: new THREE.Color(0x8a8f99) })),
    alu: () => once("alu", () => new THREE.MeshStandardMaterial({ color: 0xd6d9dd, roughness: 0.22, metalness: 0.55, envMapIntensity: 2.2 })),
    brushed: (base = "#c9ccd1") => once(`brushed${base}`, () => new THREE.MeshStandardMaterial({ color: 0xffffff, map: brushedTex(base), roughness: 0.3, metalness: 0.6, envMapIntensity: 2.0 })),
    glass: () => once("glass", () => new THREE.MeshPhysicalMaterial({ color: 0xdfefff, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.16, clearcoat: 1, depthWrite: false, side: THREE.DoubleSide })),
    coolant: (color = 0x3aa0ff, opacity = 0.42) => once(`cool${color}${opacity}`, () => new THREE.MeshPhysicalMaterial({ color, roughness: 0.1, transparent: true, opacity, emissive: color, emissiveIntensity: 0.12, depthWrite: false })),
    led: (color = 0xff2a1a, intensity = 1.6) => once(`led${color}${intensity}`, () => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness: 0.4 })),
    tex: (map, { roughness = 0.45, metalness = 0.1, emissiveMap = null, emissive = 0x000000, emissiveIntensity = 1 } = {}) =>
      new THREE.MeshStandardMaterial({ map, roughness, metalness, emissiveMap, emissive, emissiveIntensity }),
  };

  // ---- closed solids. Every primitive here is watertight with outward normals.
  function mesh(geo, mat, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, shadow = true, print = true } = {}) {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    m.castShadow = m.receiveShadow = shadow; if (!print) m.userData.noPrint = true; return m;
  }
  // box with its base at y (not its centre); mat may be an array [+x, -x, +y, -y, +z, -z]
  const box = (w, h, d, mat, o = {}) => mesh(new THREE.BoxGeometry(w, h, d), mat, { ...o, y: (o.y || 0) + h / 2 });
  const cyl = (r, h, mat, o = {}, seg = 32, rTop = r) => mesh(new THREE.CylinderGeometry(rTop, r, h, seg), mat, { ...o, y: (o.y || 0) + h / 2 });
  const sphere = (r, mat, o = {}, seg = 16) => mesh(new THREE.SphereGeometry(r, seg, Math.max(6, seg >> 1)), mat, o);
  // polygon footprint [[x, z], ...] extruded from y0 to y1
  function prism(pts, y0, y1, mat, o = {}) {
    const sh = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
    const g = new THREE.ExtrudeGeometry(sh, { depth: y1 - y0, bevelEnabled: false });
    g.rotateX(-Math.PI / 2); g.translate(0, y0, 0); return mesh(g, mat, o);
  }
  // polygon in the x-y plane (side profile) extruded along z from z0 to z1
  function profile(pts, z0, z1, mat, o = {}) {
    const sh = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
    const g = new THREE.ExtrudeGeometry(sh, { depth: z1 - z0, bevelEnabled: false }); g.translate(0, 0, z0); return mesh(g, mat, o);
  }
  // annular sector: angle a..b (0 = -z, increasing toward +x), radii r0..r1, heights y0..y1.
  // mats: {outer, inner, top, bottom, sideA, sideB}; missing faces take mats.all (or outer).
  const P = (a, r, y) => new THREE.Vector3(Math.sin(a) * r, y, -Math.cos(a) * r);
  function wedge(a, b, r0, r1, y0, y1, mats, o = {}) {
    const order = ["outer", "inner", "top", "bottom", "sideA", "sideB"], fb = mats.all || mats.outer || Object.values(mats)[0];
    const list = [], idx = new Map();
    const faces = {
      outer: [P(a, r1, y0), P(b, r1, y0), P(b, r1, y1), P(a, r1, y1)], inner: [P(b, r0, y0), P(a, r0, y0), P(a, r0, y1), P(b, r0, y1)],
      top: [P(a, r1, y1), P(b, r1, y1), P(b, r0, y1), P(a, r0, y1)], bottom: [P(a, r0, y0), P(b, r0, y0), P(b, r1, y0), P(a, r1, y0)],
      sideA: [P(a, r0, y0), P(a, r1, y0), P(a, r1, y1), P(a, r0, y1)], sideB: [P(b, r1, y0), P(b, r0, y0), P(b, r0, y1), P(b, r1, y1)],
    };
    const c = [faces.inner, faces.outer].flat().reduce((s, v) => s.add(v), new THREE.Vector3()).multiplyScalar(1 / 8); // corner average
    const pos = [], uv = [], geo = new THREE.BufferGeometry();
    order.forEach((k, fi) => {
      let q = faces[k]; const n = new THREE.Vector3().subVectors(q[1], q[0]).cross(new THREE.Vector3().subVectors(q[2], q[0]));
      const fc = q.reduce((s, v) => s.add(v), new THREE.Vector3()).multiplyScalar(0.25);
      let quv = [[0, 0], [1, 0], [1, 1], [0, 1]];
      if (n.dot(fc.clone().sub(c)) < 0) { q = [q[1], q[0], q[3], q[2]]; quv = [[1, 0], [0, 0], [0, 1], [1, 1]]; }
      const mat = mats[k] || fb; if (!idx.has(mat)) { idx.set(mat, list.length); list.push(mat); }
      geo.addGroup(fi * 6, 6, idx.get(mat));
      for (const j of [0, 1, 2, 0, 2, 3]) { pos.push(q[j].x, q[j].y, q[j].z); uv.push(...quv[j]); }
    });
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); geo.computeVertexNormals();
    return mesh(geo, list, o);
  }

  // centre the footprint on the origin (x, z) with the base on y = 0; call last in build()
  function finish(g, tick) {
    g.updateMatrixWorld(true); const b = new THREE.Box3().setFromObject(g), c = b.getCenter(new THREE.Vector3());
    for (const ch of g.children) { ch.position.x -= c.x; ch.position.z -= c.z; ch.position.y -= b.min.y; }
    if (tick) g.userData.tick = tick; return g;
  }

  return { finish, THREE, PAL, rng, canvasTex, noiseTex, brushedTex, carbonTex, plateTex, M, mesh, box, cyl, sphere, prism, profile, wedge, P };
}

// Watertight check for a mesh geometry: every edge shared by exactly two triangles in opposite directions,
// and a positive enclosed volume (outward normals). Used by tools/export_stl.html.
export function closedReport(geo) {
  const p = geo.attributes.position, ix = geo.index, n = ix ? ix.count : p.count, key = new Map(), id = [];
  const q = (x) => Math.round(x * 1e5), k = (i) => `${q(p.getX(i))},${q(p.getY(i))},${q(p.getZ(i))}`;
  for (let i = 0; i < p.count; i++) { const s = k(i); if (!key.has(s)) key.set(s, key.size); id.push(key.get(s)); }
  const edges = new Map(); let vol = 0, degenerate = 0;
  for (let t = 0; t < n; t += 3) {
    const v = [0, 1, 2].map((j) => (ix ? ix.getX(t + j) : t + j)), w = v.map((i) => id[i]);
    if (w[0] === w[1] || w[1] === w[2] || w[0] === w[2]) { degenerate++; continue; }
    for (let j = 0; j < 3; j++) { const e = `${w[j]}>${w[(j + 1) % 3]}`; edges.set(e, (edges.get(e) || 0) + 1); }
    const [a, b, c] = v.map((i) => [p.getX(i), p.getY(i), p.getZ(i)]);
    vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  let open = 0, bad = 0;
  for (const [e, c] of edges) { const [x, y] = e.split(">"); const r = edges.get(`${y}>${x}`) || 0; if (c !== 1) bad++; else if (r !== 1) open++; }
  return { closed: open === 0 && bad === 0, open, bad, degenerate, volume: vol };
}
