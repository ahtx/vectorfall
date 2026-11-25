// Study viewer for one Lineage model, with the approved museum lighting (the Cray-1 study set):
// spotlight from the upper left (light-to-shadow gradation), key with soft shadows, rim, fill, hemisphere, ACES.
// Usage in <id>/<id>.html:  import { view } from "../lib/viewer.js"; import * as mod from "./<id>.js"; view(THREE, mod);
// URL / window options: ?palette=museum, YAW, PITCH (degrees), DIST (metres). Drag to turn, wheel to zoom.
export function view(THREE, mod, opts = {}) {
  const q = new URLSearchParams(location.search);
  const palette = q.get("palette") || window.PALETTE || "vectorfall";
  const meta = mod.meta, v = meta.view || {};
  const [fw, fd] = meta.footprint_m, size = Math.max(fw, fd, meta.height_m);
  const k = v.k ?? Math.max(1, size / 2.84); // light rig scale; 1 = the Cray-1 study
  const W = innerWidth, H = innerHeight;
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio)); renderer.setSize(W, H);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = v.exposure ?? 1.05;
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x0b0b0d);
  const cam = new THREE.PerspectiveCamera(v.fov ?? 36, W / H, 0.1, 80 * k);

  const pm = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene(); envScene.background = new THREE.Color(0x30323a);
  const lamp = new THREE.Mesh(new THREE.PlaneGeometry(6, 2), new THREE.MeshBasicMaterial({ color: 0xffffff })); lamp.position.set(0, 4, -3); lamp.lookAt(0, 0, 0); envScene.add(lamp);
  scene.environment = pm.fromScene(envScene, 0.04).texture;

  const model = mod.build(THREE, { palette }); scene.add(model);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(6 * k, 96), new THREE.MeshStandardMaterial({ color: 0x1b1b1e, roughness: 0.85 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);

  scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x2a2220, 0.55));
  const key = new THREE.DirectionalLight(0xfff1e0, 1.3); key.position.set(-2.5 * k, 4.5 * k, -3.5 * k); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048); Object.assign(key.shadow.camera, { left: -3 * k, right: 3 * k, top: 3 * k, bottom: -3 * k, far: 20 * k }); key.shadow.bias = -0.0005; scene.add(key);
  const spot = new THREE.SpotLight(0xfff0e6, 70 * k * k, 12 * k, 0.55, 0.85, 2); spot.position.set(-1.6 * k, 4.6 * k, -2.8 * k); spot.target.position.set(0.2 * k, 0.7, 0);
  spot.castShadow = true; spot.shadow.mapSize.set(2048, 2048); spot.shadow.bias = -0.0004; scene.add(spot, spot.target);
  const rim = new THREE.DirectionalLight(0xffd9cf, 0.7); rim.position.set(3.5 * k, 2.5 * k, 3 * k); scene.add(rim);
  const fill = new THREE.DirectionalLight(0xbfd4ff, 0.35); fill.position.set(3 * k, 2 * k, -2 * k); scene.add(fill);
  const inside = new THREE.PointLight(0x9fc0ff, v.inside ?? 0.6, 2.5 * k); inside.position.set(0, Math.min(1.2, meta.height_m * 0.6), 0); scene.add(inside);

  const tgt = v.target || [0, Math.min(0.9, meta.height_m * 0.46) , 0], camY = v.camY ?? tgt[1] + 0.05;
  let yaw = (window.YAW ?? v.yaw ?? 0) * Math.PI / 180, pitch = (window.PITCH ?? v.pitch ?? 12) * Math.PI / 180;
  let dist = window.DIST ?? v.dist ?? size * 1.9;
  function place() { cam.position.set(tgt[0] + Math.sin(yaw) * Math.cos(pitch) * dist, camY + Math.sin(pitch) * dist, tgt[2] - Math.cos(yaw) * Math.cos(pitch) * dist); cam.lookAt(...tgt); }
  let drag = null;
  addEventListener("pointerdown", (e) => drag = [e.clientX, e.clientY, yaw, pitch]);
  addEventListener("pointerup", () => drag = null);
  addEventListener("pointermove", (e) => { if (!drag) return; yaw = drag[2] - (e.clientX - drag[0]) * 0.006; pitch = Math.max(0, Math.min(1.2, drag[3] + (e.clientY - drag[1]) * 0.004)); });
  addEventListener("wheel", (e) => { dist = Math.max(size * 0.4, Math.min(size * 6, dist * (1 + Math.sign(e.deltaY) * 0.08))); });
  const t0 = performance.now(), tick = model.userData.tick;
  (function loop() { if (tick) tick(window.T ?? (performance.now() - t0) / 1000); place(); renderer.render(scene, cam); requestAnimationFrame(loop); })();
  window.READY = true;
  return { scene, cam, renderer, model };
}
