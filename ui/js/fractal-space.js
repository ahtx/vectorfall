// Fractal space: a solar system of fractal planets you can fly into, the way Google Earth flies from space to a street.
// Every planet's surface IS its fractal map, wrapped on the sphere like a world map in the Mercator projection
// (real part = longitude, imaginary part = Mercator latitude). Mercator is conformal, so shapes stay true at any zoom,
// and the surface is computed per pixel by the browser's GPU, so it sharpens as you descend. Near the surface the view
// hands over to the flat deep-zoom map at the same point and scale; zooming out of the map comes back up here.
// Moons are Julia sets of Mandelbrot points, each its own globe.

const FAM = { sun: -1, mandelbrot: 0, julia: 1, "burning-ship": 2, tricorn: 3, multibrot3: 4, multibrot4: 5, newton3: 6 };
const LANDABLE = { mandelbrot: 1, julia: 1, "burning-ship": 1, tricorn: 1 };
const NB = 12, FOV = 0.9;                               // vertical field of view (radians)
const HAND = 0.7;                                       // hand over to the flat map below this width of the complex plane
export const BODIES = [
  { id: "sun", name: "The sun", fam: "sun", orbit: 0, radius: 0.55 },
  { id: "mandelbrot", name: "Mandelbrot", fam: "mandelbrot", orbit: 2.1, radius: 0.36, speed: 0.05, phase: 0.6, c0: [-0.65, 0], R: 1.25 },
  { id: "burning-ship", name: "Burning Ship", fam: "burning-ship", orbit: 3.2, radius: 0.28, speed: 0.035, phase: 2.4, c0: [-0.45, -0.45], R: 1.15 },
  { id: "tricorn", name: "Tricorn", fam: "tricorn", orbit: 4.0, radius: 0.25, speed: 0.028, phase: 4.1, c0: [-0.2, 0], R: 1.1 },
  { id: "multibrot3", name: "Multibrot z³+c", fam: "multibrot3", orbit: 4.8, radius: 0.26, speed: 0.022, phase: 5.3, c0: [0, 0], R: 1.0 },
  { id: "newton3", name: "Newton z³−1", fam: "newton3", orbit: 5.7, radius: 0.3, speed: 0.018, phase: 1.2, c0: [0, 0], R: 1.0 },
  { id: "multibrot4", name: "Multibrot z⁴+c", fam: "multibrot4", orbit: 6.5, radius: 0.22, speed: 0.015, phase: 3.3, c0: [0, 0], R: 0.95 },
  { id: "rabbit", name: "Julia: Douady rabbit", fam: "julia", parent: "mandelbrot", orbit: 0.62, radius: 0.085, speed: 0.6, phase: 0.2, c0: [0, 0], R: 0.75, jc: [-0.123, 0.745] },
  { id: "dendrite", name: "Julia: dendrite (c = i)", fam: "julia", parent: "mandelbrot", orbit: 0.82, radius: 0.07, speed: 0.45, phase: 2.2, c0: [0, 0], R: 0.75, jc: [0, 1] },
  { id: "seahorse", name: "Julia: seahorse", fam: "julia", parent: "mandelbrot", orbit: 1.0, radius: 0.075, speed: 0.33, phase: 4.4, c0: [0, 0], R: 0.75, jc: [-0.745, 0.113] },
];

const VS = "attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }";
const FS = `precision highp float;
uniform vec2 res; uniform vec3 cam; uniform mat3 camR; uniform float tanf; uniform int maxit; uniform int nb; uniform float lightCam;
uniform vec4 bpos[${NB}]; uniform vec4 bpar[${NB}]; uniform vec4 bjc[${NB}];
uniform vec3 p0; uniform vec3 p1; uniform vec3 p2; uniform vec3 p3; uniform vec3 p4; uniform vec3 p5; uniform vec3 p6; uniform vec3 p7;
vec3 pal(float t){ t = fract(t) * 7.0; float f = fract(t); int i = int(floor(t));
  if (i == 0) return mix(p0, p1, f); if (i == 1) return mix(p1, p2, f); if (i == 2) return mix(p2, p3, f); if (i == 3) return mix(p3, p4, f);
  if (i == 4) return mix(p4, p5, f); if (i == 5) return mix(p5, p6, f); return mix(p6, p7, f); }
vec2 cm(vec2 a, vec2 b){ return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
vec2 cdv(vec2 a, vec2 b){ float d = dot(b, b); return vec2(a.x*b.x + a.y*b.y, a.y*b.x - a.x*b.y) / d; }
vec3 frac(int fam, vec2 c0, vec2 jc){
  if (fam == 6) { vec2 z = c0; float n = 0.0;
    for (int i = 0; i < 80; i++) { vec2 z2 = cm(z, z); vec2 f = cm(z2, z) - vec2(1.0, 0.0); if (dot(f, f) < 1e-10) break; z = z - cdv(f, 3.0 * z2); n += 1.0; }
    float a = atan(z.y, z.x); float k = a > 1.0 ? 1.0 : (a < -1.0 ? 2.0 : 0.0);
    return pal(k / 3.0 + 0.08) * (1.05 - n / 90.0); }
  vec2 z = fam == 1 ? c0 : vec2(0.0); vec2 c = fam == 1 ? jc : c0; float it = 0.0; float m2 = 0.0;
  for (int i = 0; i < 2000; i++) {
    if (i >= maxit) break;
    if (fam == 2) z = vec2(abs(z.x), abs(z.y));
    if (fam == 3) z.y = -z.y;
    vec2 zz = cm(z, z);
    if (fam == 4) zz = cm(zz, z); else if (fam == 5) zz = cm(zz, zz);
    z = zz + c; m2 = dot(z, z); it += 1.0;
    if (m2 > 256.0) break;
  }
  if (m2 <= 256.0) return vec3(0.03, 0.02, 0.035);
  float d = fam == 4 ? 3.0 : (fam == 5 ? 4.0 : 2.0);
  float s = it + 1.0 - log(0.5 * log(m2)) / log(d);
  return pal(sqrt(max(s, 0.0)) * 0.11);
}
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main(){
  vec2 uv = (gl_FragCoord.xy * 2.0 - res) / res.y;
  vec3 rd = normalize(camR * vec3(uv * tanf, -1.0));
  float best = 1e20; int hit = -1; vec3 hp = vec3(0.0);
  for (int i = 0; i < ${NB}; i++) {
    if (i >= nb) break;
    vec3 oc = cam - bpos[i].xyz; float r = bpos[i].w;
    float b = dot(oc, rd), cc = dot(oc, oc) - r * r, h = b * b - cc;
    if (h > 0.0) { float t = -b - sqrt(h); if (t > 0.0 && t < best) { best = t; hit = i; hp = oc + t * rd; } }
  }
  if (hit < 0) {                                          // space: stars and the sun's glow
    float st = step(0.9982, hash(floor(gl_FragCoord.xy)));
    vec3 sc = bpos[0].xyz - cam; float along = max(dot(sc, rd), 0.0); float dist = length(sc - along * rd);
    float glow = exp(-dist * 2.2) * 0.9;
    gl_FragColor = vec4(vec3(st * 0.7) + vec3(1.0, 0.55, 0.15) * glow, 1.0); return;
  }
  vec4 par = vec4(0.0), jc4 = vec4(0.0), pos = vec4(0.0);
  for (int i = 0; i < ${NB}; i++) { if (i == hit) { par = bpar[i]; jc4 = bjc[i]; pos = bpos[i]; } }
  int fam = int(par.x + 0.5) - 1;
  vec3 N = hp / pos.w;
  if (fam < 0) { float l = 0.85 + 0.15 * dot(N, -rd); gl_FragColor = vec4(vec3(1.0, 0.82, 0.45) * l + vec3(0.25, 0.1, 0.0), 1.0); return; }
  float sp = jc4.z, cs = cos(sp), sn = sin(sp);
  vec3 L = vec3(cs * N.x - sn * N.z, N.y, sn * N.x + cs * N.z);      // into the body's own frame (inverse of its spin)
  float lon = atan(L.x, L.z), lat = asin(clamp(L.y, -0.9996, 0.9996));
  vec2 c = vec2(par.z + par.y * lon, par.w - par.y * log(tan(0.785398 + lat * 0.5)));   // Mercator: north = smaller imaginary part
  vec3 col = frac(fam, c, jc4.xy);
  vec3 Ls = normalize(bpos[0].xyz - (pos.xyz)), lightDir = normalize(mix(Ls, -rd, lightCam));
  float lit = 0.5 + 0.5 * max(dot(N, lightDir), 0.0);
  float rim = pow(1.0 - max(dot(N, -rd), 0.0), 3.0);
  gl_FragColor = vec4(col * lit + vec3(0.35, 0.5, 1.0) * rim * 0.25 * (1.0 - lightCam * 0.7), 1.0);
}`;

function hex(c) { return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255); }
const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
const sub = (a, b) => a.map((x, i) => x - b[i]), add = (a, b) => a.map((x, i) => x + b[i]), mul = (a, s) => a.map((x) => x * s);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const rotY = (v, a) => [Math.cos(a) * v[0] + Math.sin(a) * v[2], v[1], -Math.sin(a) * v[0] + Math.cos(a) * v[2]];

export function createSpace(host, { palette, onLand }) {
  host.insertAdjacentHTML("beforeend", `<div class="fr-space" id="fr-space" hidden><canvas id="fr-scv"></canvas><div class="fr-slabels" id="fr-slabels"></div>
    <div class="fr-gbar" id="fr-sbar"></div><div class="fr-gnote" id="fr-snote"></div></div>`);
  const el = host.querySelector("#fr-space"), cv = el.querySelector("#fr-scv");
  const gl = cv.getContext("webgl", { antialias: true });
  const T = { focus: null, lon: 0, lat: 0, h: 1.6, sys: { yaw: 0.3, pitch: 0.42, dist: 11 }, time: 0, anim: null, vel: null, palette, extra: null, on: false };
  if (!gl) { el.querySelector("#fr-snote").textContent = "This browser has no WebGL: the planets cannot be drawn."; return { open() { el.hidden = false; }, close() { el.hidden = true; } }; }
  const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
  const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr); gl.useProgram(pr);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = (n) => gl.getUniformLocation(pr, n);
  const list = () => T.extra ? BODIES.concat([T.extra]) : BODIES;
  const byId = (id) => list().find((b) => b.id === id);
  function posOf(b, t) {                               // where a body is at time t
    if (!b.orbit) return [0, 0, 0];
    const a = (b.phase || 0) + (b.speed || 0) * t, o = [Math.cos(a) * b.orbit, Math.sin(a * 0.7) * b.orbit * 0.04, Math.sin(a) * b.orbit];
    return b.parent ? add(posOf(byId(b.parent), t), o) : o;
  }
  const spinOf = (b) => (b.phase || 0) * 1.7;
  const dirOf = (b, lon, lat) => rotY([Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)], spinOf(b));
  function camera() {                                   // position, and the world-from-camera rotation
    if (T.anim) return T.anim.cam;
    if (T.focus) {
      const b = byId(T.focus), C = posOf(b, T.time), d = dirOf(b, T.lon, T.lat);
      const pos = add(C, mul(d, b.radius * (1 + T.h)));
      const north = rotY([0, 1, 0], spinOf(b));
      return look(pos, C, north);
    }
    const s = T.sys, pos = [Math.cos(s.pitch) * Math.sin(s.yaw) * s.dist, Math.sin(s.pitch) * s.dist, Math.cos(s.pitch) * Math.cos(s.yaw) * s.dist];
    return look(pos, [0, 0, 0], [0, 1, 0]);
  }
  function look(pos, target, up) {
    const f = norm(sub(target, pos)), r = norm(cross(f, up)), u = cross(r, f);
    return { pos, m: [r[0], r[1], r[2], u[0], u[1], u[2], -f[0], -f[1], -f[2]] };   // columns: right, up, back
  }
  function draw() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5), w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
    if (!w || !h) return;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    gl.viewport(0, 0, w, h);
    const C = camera(), B = list();
    gl.uniform2f(U("res"), w, h); gl.uniform3fv(U("cam"), C.pos); gl.uniformMatrix3fv(U("camR"), false, new Float32Array(C.m)); gl.uniform1f(U("tanf"), Math.tan(FOV / 2));
    const focusW = T.focus ? widthNow() : 10;
    gl.uniform1i(U("maxit"), T.focus ? Math.min(1800, Math.round(140 + 160 * Math.max(0, Math.log10(4 / focusW)) * 2.2)) : 140);
    gl.uniform1i(U("nb"), B.length); gl.uniform1f(U("lightCam"), T.focus ? 0.8 : 0.0);
    const P = (T.palette && T.palette.length ? T.palette : ["#050304", "#3a0000", "#8e0000", "#d40000", "#ff2a1a", "#ff8a00", "#ffd300", "#fff6d6"]);
    for (let i = 0; i < 8; i++) gl.uniform3fv(U("p" + i), hex(P[Math.min(P.length - 1, Math.round(i * (P.length - 1) / 7))]));
    const pos = new Float32Array(NB * 4), par = new Float32Array(NB * 4), jc = new Float32Array(NB * 4);
    B.forEach((b, i) => { const p = posOf(b, T.time); pos.set([p[0], p[1], p[2], b.radius], i * 4); par.set([FAM[b.fam] + 1, b.R || 1, (b.c0 || [0, 0])[0], (b.c0 || [0, 0])[1]], i * 4); jc.set([(b.jc || [0, 0])[0], (b.jc || [0, 0])[1], spinOf(b), 0], i * 4); });
    gl.uniform4fv(U("bpos"), pos); gl.uniform4fv(U("bpar"), par); gl.uniform4fv(U("bjc"), jc);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    labels(C);
  }
  // ---- what the view shows of the plane: its centre and its width
  const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + lat / 2));
  function centreNow() { const b = byId(T.focus); return [b.c0[0] + b.R * T.lon, b.c0[1] - b.R * merc(T.lat)]; }
  function widthNow() {                                // the width of the complex plane across the screen, at the centre
    const b = byId(T.focus), aspect = cv.clientWidth / Math.max(1, cv.clientHeight);
    const arc = 2 * Math.tan(FOV / 2) * Math.min(T.h, 3) * aspect;                      // in radii, small-altitude approximation
    return arc * b.R / Math.cos(T.lat);
  }
  function hFor(b, width, lat) { const aspect = cv.clientWidth / Math.max(1, cv.clientHeight); return width * Math.cos(lat) / b.R / (2 * Math.tan(FOV / 2) * aspect); }
  // ---- picking: which body and which surface point is under a screen point
  function rayAt(x, y) {
    const C = camera(), H = cv.clientHeight, W = cv.clientWidth, u = (2 * x - W) / H, v = -(2 * y - H) / H;
    const m = C.m, d = norm([m[0] * u * Math.tan(FOV / 2) + m[3] * v * Math.tan(FOV / 2) - m[6], m[1] * u * Math.tan(FOV / 2) + m[4] * v * Math.tan(FOV / 2) - m[7], m[2] * u * Math.tan(FOV / 2) + m[5] * v * Math.tan(FOV / 2) - m[8]]);
    let best = null;
    list().forEach((b) => { const oc = sub(C.pos, posOf(b, T.time)), bb = dot(oc, d), cc = dot(oc, oc) - b.radius * b.radius, hh = bb * bb - cc; if (hh > 0) { const t = -bb - Math.sqrt(hh); if (t > 0 && (!best || t < best.t)) best = { t, b, p: add(oc, mul(d, t)) }; } });
    if (!best) return null;
    const N = rotY(mul(best.p, 1 / best.b.radius), -spinOf(best.b));
    return { b: best.b, lon: Math.atan2(N[0], N[2]), lat: Math.asin(Math.max(-0.9996, Math.min(0.9996, N[1]))) };
  }
  // ---- labels in the solar system
  function labels(C) {
    const L = el.querySelector("#fr-slabels");
    if (T.focus || T.anim) { L.innerHTML = ""; return; }
    const W = cv.clientWidth, H = cv.clientHeight, m = C.m, tf = Math.tan(FOV / 2);
    L.innerHTML = list().filter((b) => b.fam !== "sun" && (!b.parent || T.sys.dist < 7)).map((b) => {
      const v = sub(posOf(b, T.time), C.pos), x = dot(v, [m[0], m[1], m[2]]), y = dot(v, [m[3], m[4], m[5]]), z = -dot(v, [m[6], m[7], m[8]]);
      if (z <= 0.1) return "";
      const sx = W / 2 + (x / z) / tf * H / 2, sy = H / 2 - (y / z) / tf * H / 2, r = b.radius / z / tf * H / 2;
      return `<div class="fr-slab ${b.parent ? "moon" : ""}" style="left:${sx}px;top:${sy + r + 4}px">${b.name}</div>`;
    }).join("");
  }
  // ---- the HUD
  function bar() {
    const B = el.querySelector("#fr-sbar"), b = T.focus && byId(T.focus);
    if (!b) B.innerHTML = `<b>A universe of fractals</b> <span class="dim">· every planet's surface is its fractal, wrapped like a world map · moons are Julia sets · click or double-click a planet to fly to it · drag to look around · wheel to move</span><button class="iconbtn" id="fr-sx" title="Back to the map (Esc)">✕</button>`;
    else B.innerHTML = `<button class="btn ghost xs" id="fr-sup">‹ Universe</button><b>${b.name}</b><span class="dim">· drag to move · wheel or double-click to zoom at the cursor${LANDABLE[b.fam] ? " · zoom in and the flat map takes over" : " · globe only (no deep map for this family yet)"}</span>${LANDABLE[b.fam] ? '<button class="btn sm" id="fr-sland">Land on the map</button>' : ""}<button class="iconbtn" id="fr-sx" title="Back to the map (Esc)">✕</button>`;
    const x = B.querySelector("#fr-sx"); if (x) x.onclick = close;
    const upb = B.querySelector("#fr-sup"); if (upb) upb.onclick = () => toSystem();
    const ld = B.querySelector("#fr-sland"); if (ld) ld.onclick = () => land();
  }
  function note() {
    const N = el.querySelector("#fr-snote");
    if (!T.focus) { N.textContent = ""; return; }
    const [x, y] = centreNow(), w = widthNow();
    N.textContent = `centre c = ${x.toFixed(5)} ${y >= 0 ? "+" : "−"} ${Math.abs(y).toFixed(5)}i · view ${w < 0.01 ? w.toExponential(2) : w.toFixed(3)} wide`;
  }
  // ---- moving around
  function fly(toCam, ms, done) {                      // a smooth camera move between two framings
    const from = camera(), t0 = performance.now();
    T.anim = { cam: from };
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / ms), e = k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) * (1 - k);
      const to = toCam(), p = add(mul(from.pos, 1 - e), mul(to.pos, e)), m = from.m.map((v, i) => v * (1 - e) + to.m[i] * e);
      const r = norm([m[0], m[1], m[2]]), u0 = [m[3], m[4], m[5]], bk = norm(cross(r, u0)), u = cross(bk, r);   // re-orthonormalise
      T.anim = { cam: { pos: p, m: [r[0], r[1], r[2], u[0], u[1], u[2], bk[0], bk[1], bk[2]] } };
      if (k < 1) requestAnimationFrame(step); else { T.anim = null; done && done(); }
      dirty = true;
    };
    requestAnimationFrame(step);
  }
  function focusOn(id, lon = 0, lat = 0.2, h = 1.8, instant = false) {
    const b = byId(id); if (!b || b.fam === "sun") return;
    const target = () => { const C = posOf(b, T.time), d = dirOf(b, lon, lat); return look(add(C, mul(d, b.radius * (1 + h))), C, rotY([0, 1, 0], spinOf(b))); };
    const go = () => { T.focus = id; T.lon = lon; T.lat = lat; T.h = h; bar(); note(); dirty = true; };
    if (instant) go(); else fly(target, 1400, go);
  }
  function toSystem() {
    const was = T.focus; T.focus = null; bar();
    if (was) { const b = byId(was), C = posOf(b, T.time); T.sys.yaw = Math.atan2(C[0], C[2]); }
    fly(() => { const s = T.sys; return look([Math.cos(s.pitch) * Math.sin(s.yaw) * s.dist, Math.sin(s.pitch) * s.dist, Math.cos(s.pitch) * Math.cos(s.yaw) * s.dist], [0, 0, 0], [0, 1, 0]); }, 1300);
  }
  function land() {                                    // hand over to the flat map at this centre and width
    const b = byId(T.focus); if (!b || !LANDABLE[b.fam]) return;
    const [x, y] = centreNow(), w = widthNow();          // measure before hiding (a hidden canvas has no width)
    close(); onLand && onLand(b.fam, x, y, Math.min(9, Math.max(1e-6, w)), b.jc);
  }
  function zoomAt(px, py, f) {                         // altitude x f, keeping the point under the cursor in view (towards it)
    if (!T.focus) { T.sys.dist = Math.max(3, Math.min(30, T.sys.dist * f)); dirty = true; return; }
    const hit = rayAt(px, py), b = byId(T.focus);
    if (hit && hit.b === b && f < 1) { const k = 1 - f; T.lon += angDiff(hit.lon, T.lon) * k; T.lat += (hit.lat - T.lat) * k; }
    T.h = Math.max(1e-4, Math.min(12, T.h * f));
    T.lat = Math.max(-1.45, Math.min(1.45, T.lat));
    if (T.h > 7) { toSystem(); return; }
    if (LANDABLE[b.fam] && widthNow() < HAND && f < 1) { land(); return; }
    note(); dirty = true;
  }
  const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
  cv.addEventListener("wheel", (e) => { e.preventDefault(); if (T.anim) return; const r = cv.getBoundingClientRect(); const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY; zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(Math.max(-60, Math.min(60, dy)) * 0.0022)); }, { passive: false });
  let drag = null, lastT = 0;
  cv.addEventListener("pointerdown", (e) => { cv.setPointerCapture(e.pointerId); drag = [e.clientX, e.clientY]; T.vel = null; lastT = performance.now(); });
  cv.addEventListener("pointermove", (e) => {
    if (!drag || T.anim) return;
    const dx = e.clientX - drag[0], dy = e.clientY - drag[1], H = cv.clientHeight; drag = [e.clientX, e.clientY];
    if (T.focus) {                                     // grab the surface: one pixel moves by one pixel's worth of ground
      const a = 2 * Math.tan(FOV / 2) * Math.min(T.h, 2.5) / H;
      const dl = -dx * a / Math.cos(T.lat), dt = dy * a;
      T.lon += dl; T.lat = Math.max(-1.45, Math.min(1.45, T.lat + dt));
      const now = performance.now(); T.vel = [dl / Math.max(1, now - lastT), dt / Math.max(1, now - lastT)]; lastT = now;
      note();
    } else { T.sys.yaw -= dx * 0.004; T.sys.pitch = Math.max(-1.2, Math.min(1.35, T.sys.pitch + dy * 0.004)); }
    dirty = true;
  });
  const up = () => { drag = null; if (T.vel && performance.now() - lastT < 80) glide(); };
  cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
  function glide() { let [vl, vt] = T.vel; const step = () => { if (!T.vel || drag) return; T.lon += vl * 16; T.lat = Math.max(-1.45, Math.min(1.45, T.lat + vt * 16)); vl *= 0.9; vt *= 0.9; dirty = true; note(); if (Math.hypot(vl, vt) > 1e-6) requestAnimationFrame(step); }; requestAnimationFrame(step); }
  cv.addEventListener("click", (e) => { if (T.focus || T.anim) return; const r = cv.getBoundingClientRect(), hit = rayAt(e.clientX - r.left, e.clientY - r.top); if (hit && hit.b.fam !== "sun") focusOn(hit.b.id, 0, 0, 1.7); });   // arrive above its home: the set centred
  cv.addEventListener("dblclick", (e) => {
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (!T.focus) return;
    let n = 0; const st = () => { zoomAt(x, y, 0.88); if (++n < 8 && T.focus) requestAnimationFrame(st); }; requestAnimationFrame(st);
  });
  const keyh = (e) => { if (el.hidden) return; if (e.key === "Escape") { e.stopPropagation(); if (T.focus) toSystem(); else close(); } };
  document.addEventListener("keydown", keyh);
  // ---- the frame loop: orbits move in the solar system, and stand still while you are at a planet
  let dirty = true, last = performance.now();
  const loop = () => {
    if (!T.on) return;
    const now = performance.now(), dt = (now - last) / 1000; last = now;
    if (!T.focus && !T.anim) { T.time += dt; dirty = true; }
    if (dirty || T.anim) { dirty = false; draw(); }
    requestAnimationFrame(loop);
  };
  new ResizeObserver(() => { dirty = true; }).observe(cv);
  function open(opts = {}) {                            // opts: { kind, cx, cy, scale, jc } to arrive at that view's planet
    T.palette = opts.palette || T.palette; el.hidden = false; T.on = true; last = performance.now(); requestAnimationFrame(loop);
    let id = opts.kind && BODIES.find((b) => b.fam === opts.kind && (opts.kind !== "julia"))?.id;
    if (opts.kind === "julia") {                        // a Julia set: one of the moons, or a new moon for this c
      const m = BODIES.find((b) => b.jc && Math.abs(b.jc[0] - opts.jc[0]) < 1e-3 && Math.abs(b.jc[1] - opts.jc[1]) < 1e-3);
      if (m) id = m.id; else { T.extra = { id: "yours", name: `Julia: c = ${(+opts.jc[0]).toFixed(3)} ${opts.jc[1] >= 0 ? "+" : "−"} ${Math.abs(opts.jc[1]).toFixed(3)}i`, fam: "julia", parent: "mandelbrot", orbit: 1.2, radius: 0.08, speed: 0.25, phase: 5.6, c0: [0, 0], R: 0.75, jc: opts.jc }; id = "yours"; }
    }
    if (id && opts.cx != null) {                        // arrive above the map's centre, at the map's width
      const b = byId(id), lon = (opts.cx - b.c0[0]) / b.R, lat = 2 * Math.atan(Math.exp((b.c0[1] - opts.cy) / b.R)) - Math.PI / 2;
      focusOn(id, lon, lat, Math.max(hFor(b, HAND * 1.4, lat), hFor(b, opts.scale, lat)), true);
    } else if (id) focusOn(id, 0, 0.15, 1.8, true);
    else { T.focus = null; bar(); }
    bar(); note(); dirty = true;
  }
  function close() { el.hidden = true; T.on = false; }
  return { open, close, isOpen: () => !el.hidden };
}
