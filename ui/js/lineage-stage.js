// The Lineage art stage: one WebGL context for every machine. The lights copy the approved Cray-1 study
// (lineage-art/lib/viewer.js): museum spotlight from the upper left, key light with soft shadows, rim, fill,
// hemisphere, ACES tone mapping. Drag to turn, wheel to zoom, a slow turn when idle. Models are ES modules in
// vendor/lineage-art/<id>/<id>.js (meta + build(THREE, {palette})), loaded only when a machine is shown.
// Thumbnails come from the same context through a render target. Without WebGL the caller gets null.

const ART = "vendor/lineage-art/";
let THREE = null, index = null;

export async function artIndex() {
  if (index) return index;
  try { index = await (await fetch(ART + "index.json", { cache: "no-cache" })).json(); }
  catch (e) { index = { machines: {} }; }
  return index;
}
export const stillUrl = (id) => index && index.machines[id] && index.machines[id].still ? ART + index.machines[id].still : null;
export const hasModel = (id) => !!(index && index.machines[id] && index.machines[id].module);

const mods = new Map();
async function loadModule(id) {
  if (!hasModel(id)) return null;
  if (!mods.has(id)) mods.set(id, import("../" + ART + index.machines[id].module).catch((e) => { console.warn("lineage art", id, e); return null; }));
  return mods.get(id);
}

export function webglOK() {
  try { const c = document.createElement("canvas"); return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl"))); }
  catch (e) { return false; }
}

export async function createStage(host) {
  if (!webglOK()) return null;
  THREE = THREE || await import("../vendor/three/three.module.min.js");
  await artIndex();
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); }
  catch (e) { return null; }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const cv = renderer.domElement; cv.className = "lin-gl"; host.appendChild(cv);
  const pm = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene(); envScene.background = new THREE.Color(0x30323a);
  const lamp = new THREE.Mesh(new THREE.PlaneGeometry(6, 2), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  lamp.position.set(0, 4, -3); lamp.lookAt(0, 0, 0); envScene.add(lamp);
  const envTex = pm.fromScene(envScene, 0.04).texture;

  const scenes = new Map();             // key id|palette -> {scene, cam, model, meta, view}
  async function sceneFor(id, palette) {
    const key = id + "|" + palette;
    if (scenes.has(key)) return scenes.get(key);
    const mod = await loadModule(id);
    if (!mod || !mod.build) return null;
    const meta = mod.meta, v = meta.view || {};
    const [fw, fd] = meta.footprint_m, size = Math.max(fw, fd, meta.height_m);
    const k = v.k ?? Math.max(1, size / 2.84);
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x0b0b0d); scene.environment = envTex;
    const model = mod.build(THREE, { palette }); scene.add(model);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(6 * k, 96), new THREE.MeshStandardMaterial({ color: 0x1b1b1e, roughness: 0.85 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
    scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x2a2220, 0.55));
    const key1 = new THREE.DirectionalLight(0xfff1e0, 1.3); key1.position.set(-2.5 * k, 4.5 * k, -3.5 * k); key1.castShadow = true;
    key1.shadow.mapSize.set(2048, 2048); Object.assign(key1.shadow.camera, { left: -3 * k, right: 3 * k, top: 3 * k, bottom: -3 * k, far: 20 * k }); key1.shadow.bias = -0.0005; scene.add(key1);
    const spot = new THREE.SpotLight(0xfff0e6, 70 * k * k, 12 * k, 0.55, 0.85, 2); spot.position.set(-1.6 * k, 4.6 * k, -2.8 * k); spot.target.position.set(0.2 * k, 0.7, 0);
    spot.castShadow = true; spot.shadow.mapSize.set(2048, 2048); spot.shadow.bias = -0.0004; scene.add(spot, spot.target);
    const rim = new THREE.DirectionalLight(0xffd9cf, 0.7); rim.position.set(3.5 * k, 2.5 * k, 3 * k); scene.add(rim);
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.35); fill.position.set(3 * k, 2 * k, -2 * k); scene.add(fill);
    const inside = new THREE.PointLight(0x9fc0ff, v.inside ?? 0.6, 2.5 * k); inside.position.set(0, Math.min(1.2, meta.height_m * 0.6), 0); scene.add(inside);
    const cam = new THREE.PerspectiveCamera(v.fov ?? 36, 1.6, 0.1, 80 * k);
    const tgt = v.target || [0, Math.min(0.9, meta.height_m * 0.46), 0];
    const s = { scene, cam, model, meta, size, tgt, camY: v.camY ?? tgt[1] + 0.05, exposure: v.exposure ?? 1.05,
      yaw0: (v.yaw ?? 0) * Math.PI / 180, pitch0: (v.pitch ?? 12) * Math.PI / 180, dist0: v.dist ?? size * 1.9 };
    scenes.set(key, s);
    return s;
  }
  function place(s, yaw, pitch, dist) {
    s.cam.position.set(s.tgt[0] + Math.sin(yaw) * Math.cos(pitch) * dist, s.camY + Math.sin(pitch) * dist, s.tgt[2] - Math.cos(yaw) * Math.cos(pitch) * dist);
    s.cam.lookAt(...s.tgt);
  }

  // ---- the live view
  let cur = null, yaw = 0, pitch = 0, dist = 5, drag = null, lastTouch = 0, raf = 0, running = false, t0 = performance.now();
  let want = 0;
  cv.addEventListener("pointerdown", (e) => { drag = [e.clientX, e.clientY, yaw, pitch]; cv.setPointerCapture(e.pointerId); lastTouch = performance.now(); });
  cv.addEventListener("pointerup", () => { drag = null; lastTouch = performance.now(); });
  cv.addEventListener("pointermove", (e) => {
    if (!drag) return;
    yaw = drag[2] - (e.clientX - drag[0]) * 0.006; pitch = Math.max(0, Math.min(1.2, drag[3] + (e.clientY - drag[1]) * 0.004)); lastTouch = performance.now();
  });
  cv.addEventListener("wheel", (e) => {
    if (!cur) return; e.preventDefault();
    dist = Math.max(cur.size * 0.5, Math.min(cur.size * 5, dist * (1 + Math.sign(e.deltaY) * 0.08))); lastTouch = performance.now();
  }, { passive: false });
  cv.addEventListener("dblclick", () => { if (cur) { yaw = cur.yaw0; pitch = cur.pitch0; dist = cur.dist0; } });

  function size() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return false;
    const pr = renderer.getPixelRatio();
    if (cv.width !== Math.round(w * pr) || cv.height !== Math.round(h * pr)) renderer.setSize(w, h, false);
    cv.style.width = w + "px"; cv.style.height = h + "px";
    return true;
  }
  function frame(now) {
    raf = 0;
    if (!running || !cv.isConnected) return;
    if (cur && size()) {
      if (!drag && now - lastTouch > 3500) yaw += 0.0016;            // the slow idle turn
      cur.cam.aspect = host.clientWidth / host.clientHeight; cur.cam.updateProjectionMatrix();
      place(cur, yaw, pitch, dist);
      if (cur.model.userData.tick) cur.model.userData.tick((now - t0) / 1000);
      renderer.toneMappingExposure = cur.exposure;
      renderer.setRenderTarget(null);
      renderer.render(cur.scene, cur.cam);
    }
    raf = requestAnimationFrame(frame);
  }
  const api = {
    canvas: cv,
    async show(id, palette = "vectorfall") {
      const my = ++want;
      const s = await sceneFor(id, palette);
      if (my !== want) return !!s;
      const same = cur && s && cur.meta.id === s.meta.id;
      cur = s;
      if (s && !same) { yaw = s.yaw0; pitch = s.pitch0; dist = s.dist0; }
      cv.style.visibility = s ? "visible" : "hidden";
      return !!s;
    },
    start() { if (!running) { running = true; raf = requestAnimationFrame(frame); } },
    stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; },
    // A still of a machine at its study angle. It is drawn into a corner of the live canvas, copied, and the live
    // view is drawn again in the same task, so the corner never reaches the screen (tone mapping applies only there).
    async thumb(id, w = 320, h = 200, palette = "vectorfall") {
      const s = await sceneFor(id, palette);
      if (!s || !size()) return null;
      const pr = renderer.getPixelRatio(), W = cv.width / pr, H = cv.height / pr;
      const sc = Math.min(1, W / w, H / h), tw = Math.floor(w * sc), th = Math.floor(h * sc);
      if (tw < 80) return null;
      s.cam.aspect = tw / th; s.cam.updateProjectionMatrix();
      place(s, s.yaw0, s.pitch0, s.dist0 * 1.04);
      if (s.model.userData.tick) s.model.userData.tick(1.7);
      renderer.toneMappingExposure = s.exposure;
      renderer.setRenderTarget(null);
      renderer.setScissorTest(true); renderer.setScissor(0, 0, tw, th); renderer.setViewport(0, 0, tw, th);
      renderer.render(s.scene, s.cam);
      const c = document.createElement("canvas"); c.width = Math.round(tw * pr); c.height = Math.round(th * pr);
      c.getContext("2d").drawImage(cv, 0, cv.height - c.height, c.width, c.height, 0, 0, c.width, c.height);
      renderer.setScissorTest(false); renderer.setViewport(0, 0, W, H);
      if (cur) { place(cur, yaw, pitch, dist); cur.cam.aspect = W / H; cur.cam.updateProjectionMatrix(); renderer.toneMappingExposure = cur.exposure; renderer.render(cur.scene, cur.cam); }
      else renderer.clear();
      return c.toDataURL("image/jpeg", 0.86);
    },
    current: () => cur && cur.meta,
  };
  return api;
}

// A quiet stand-in for machines whose model is not ready: cabinets in perspective, sized by the era.
export function silhouette(m) {
  const pre = m.kind === "pre1993", y = m.year || 2000;
  const n = pre ? 1 : Math.min(9, 2 + Math.round((y - 1993) / 4));
  const racks = Array.from({ length: n }, (_, i) => {
    const x = 160 - n * 13 + i * 26, h = pre ? 64 : 58 + (i % 2) * 4;
    return `<rect x="${x}" y="${132 - h}" width="22" height="${h}" rx="1.5"/><path d="M${x + 4} ${138 - h}h14M${x + 4} ${144 - h}h14" class="ln"/>`;
  }).join("");
  const cray = `<path d="M118 132V78a42 14 0 0 1 84 0v54" /><ellipse cx="160" cy="78" rx="42" ry="14" class="top"/><path d="M104 132h112l-8 12H112z" class="bench"/>`;
  return `<svg class="lin-sil" viewBox="0 0 320 170" aria-hidden="true">
    <defs><linearGradient id="silg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#2a2a31"/><stop offset="1" stop-color="#141418"/></linearGradient></defs>
    <ellipse cx="160" cy="146" rx="128" ry="12" class="floor"/>
    <g class="body">${pre && /cray/.test(m.id) && m.id !== "cray-c90" ? cray : racks}</g>
    <text x="160" y="164" text-anchor="middle">model in preparation</text></svg>`;
}
