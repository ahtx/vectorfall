import { $, $$, api, esc, fmt, icon, toast } from "./core.js";
import { createMap } from "./fractal-map.js";
import { createSpace } from "./fractal-space.js";
import { openData } from "./fractal-data.js";

// The centre is tracked in fixed-point BigInt (D fractional digits), not float64, so zoom is limited only by D
// (~1e-78) instead of the ~1e-14 where a double runs out of mantissa and the image breaks into blocks. scale stays
// a Number — its own relative precision never matters, only the centre's absolute precision does. cx/cy go to the
// card as decimal strings, where a high-precision reference orbit (Python Decimal) drives perturbation rendering.
const D = 80n, SCALE = 10n ** D;
function bf(x) {                                        // Number -> BigInt scaled by 10^D
  if (!x) return 0n;
  let s = x.toExponential(16), [m, e] = s.split("e"), exp = parseInt(e, 10);
  const neg = m[0] === "-"; if (neg) m = m.slice(1);
  m = m.replace(".", "");                               // 17 significant digits, implied point after digit 1
  const se = Number(D) + (exp - 16);
  let v = se >= 0 ? BigInt(m) * 10n ** BigInt(se) : BigInt(m) / 10n ** BigInt(-se);
  return neg ? -v : v;
}
function bfParse(str) {                                 // decimal string -> BigInt scaled by 10^D (exact, for links)
  let s = String(str || "0").trim(), neg = s[0] === "-"; if (neg || s[0] === "+") s = s.slice(1);
  if (/e/i.test(s)) return bf(neg ? -parseFloat(s) : parseFloat(s));
  let [i, f = ""] = s.split("."); f = (f + "0".repeat(Number(D))).slice(0, Number(D));
  const v = BigInt((i || "0").replace(/\D/g, "") || "0") * SCALE + BigInt(f.replace(/\D/g, "") || "0");
  return neg ? -v : v;
}
function bfStr(v) {                                     // BigInt scaled by 10^D -> decimal string
  const neg = v < 0n; if (neg) v = -v;
  const s = v.toString().padStart(Number(D) + 1, "0"), n = s.length - Number(D);
  return (neg ? "-" : "") + s.slice(0, n) + "." + s.slice(n);
}

const S = { kind: "mandelbrot", cx: bf(-0.5), cy: 0n, scale: 3.2, palette: "rosso", density: 1, jr: -0.8, ji: 0.156 };
let palettes = {}, MAP = null, lastMeta = {};
const back = [];                                        // earlier views (Backspace / the back button)
const VIEW0 = { mandelbrot: [-0.5, 0, 3.2], julia: [0, 0, 3.4], "burning-ship": [-0.45, -0.5, 3.4], tricorn: [0, 0, 3.6] };
// named places: a first visit can fly to the deep detail that shows what the card does
const PRESETS = [
  ["Whole Mandelbrot set", { kind: "mandelbrot", cx: "-0.5", cy: "0", scale: 3.2 }],
  ["Seahorse valley", { kind: "mandelbrot", cx: "-0.7453", cy: "0.1127", scale: 0.012 }],
  ["Seahorse spiral, 3 billion ×", { kind: "mandelbrot", cx: "-0.743643887037158704752191506114774", cy: "0.131825904205311970493132056385139", scale: 1e-9 }],
  ["Deep dive, 3×10^30 ×", { kind: "mandelbrot", cx: "-0.743643887037158704752191506114774", cy: "0.131825904205311970493132056385139", scale: 1e-30 }],
  ["Julia: Douady rabbit", { kind: "julia", cx: "0", cy: "0", scale: 3.2, jr: -0.123, ji: 0.745 }],
  ["Julia: dendrite", { kind: "julia", cx: "0", cy: "0", scale: 3.2, jr: 0, ji: 1 }],
  ["Burning ship (whole set)", { kind: "burning-ship", cx: "-0.45", cy: "-0.5", scale: 3.4 }],
  ["Burning ship: the ship", { kind: "burning-ship", cx: "-1.762", cy: "-0.035", scale: 0.09 }],
];
function snap() { return { kind: S.kind, cx: S.cx, cy: S.cy, scale: S.scale, jr: S.jr, ji: S.ji }; }
function remember() { back.push(snap()); if (back.length > 60) back.shift(); }
function goBack() { const v = back.pop(); if (!v) { toast("No earlier view"); return; } if (v.kind !== S.kind) { Object.assign(S, v); syncKind(); restyle(); } else MAP.flyTo(v.cx, v.cy, v.scale, 600); }
function syncKind() {
  $$("#fr-kind [data-k]").forEach((x) => x.classList.toggle("on", x.dataset.k === S.kind));
  $("#fr-julia").classList.toggle("hidden", S.kind !== "julia");
  $("#fr-jr").value = S.jr; $("#fr-jrv").textContent = (+S.jr).toFixed(3); $("#fr-ji").value = S.ji; $("#fr-jiv").textContent = (+S.ji).toFixed(3);
}
function linkParams() {
  return { k: S.kind, cx: bfStr(S.cx).replace(/0+$/, "").replace(/\.$/, ""), cy: bfStr(S.cy).replace(/0+$/, "").replace(/\.$/, ""),
           s: S.scale.toExponential(6), p: S.palette, d: S.density, jr: S.jr, ji: S.ji };
}
function writeLink() {                                  // the address bar always holds the current view (no reload, no re-route)
  try { history.replaceState(null, "", "#fractal?" + new URLSearchParams(linkParams()).toString()); } catch (e) { /* file:// */ }
}
function readLink(p) {
  if (!p || p.cx == null) return false;
  if (VIEW0[p.k]) S.kind = p.k;
  S.cx = bfParse(p.cx); S.cy = bfParse(p.cy || "0"); S.scale = Math.max(1e-300, +p.s || 3.2);
  if (p.p) S.palette = p.p; if (p.d) S.density = +p.d; if (p.jr != null) S.jr = +p.jr; if (p.ji != null) S.ji = +p.ji;
  return true;
}
function preset(v) {                                  // a place: fly there (a new family or shape is a jump)
  remember();
  if (v.kind !== S.kind || (v.jr != null && (v.jr !== S.jr || v.ji !== S.ji))) { S.kind = v.kind; S.cx = bfParse(v.cx); S.cy = bfParse(v.cy); S.scale = v.scale; if (v.jr != null) { S.jr = v.jr; S.ji = v.ji; } syncKind(); restyle(); return; }
  MAP.flyTo(bfParse(v.cx), bfParse(v.cy), v.scale);
}
function zoomBy(f) { remember(); MAP.zoomBy(f); }
function restyle() { if (MAP) MAP.restyle(); }

export default {
  id: "fractal", title: "Fractals", sub: "dive into infinity, live", icon: "fractal",
  mount(el) {
    el.innerHTML = `<div class="frac" id="fr">
      <canvas id="fr-cv"></canvas>
      <section class="pane fr-panel" id="fr-panel">
        <div class="pane-h"><div class="t">Fractal</div><div class="tools"><button class="iconbtn" id="fr-fold" title="Collapse panel">${icon("x")}</button></div></div>
        <div class="pane-b">
          <div class="sec-t">Go to</div>
          <select class="sel sm" id="fr-pre"><option value="">Choose a place…</option>${PRESETS.map(([n], i) => `<option value="${i}">${esc(n)}</option>`).join("")}</select>
          <div class="sec-t">Labs</div>
          <div class="fr-labs"><button class="btn sm" data-lab="img" title="Compress a photo with fractals, replay the decoding, see the maps, recombine two photos, compare with JPEG">Image compression</button><button class="btn sm" data-lab="txt" title="Compress a passage by its repeats, replay it piece by piece, recombine the pieces, compare with gzip">Text compression</button>
            <button class="btn ghost sm" data-lab="cgr" title="The corpus as a chaos-game fractal">Text as a fractal</button><button class="btn ghost sm" data-lab="dim" title="The fractal dimension of a photo">Photo dimension</button></div>
          <div class="sec-t fr-pl-h">Your places <span class="dim" id="fr-pl-n"></span></div>
          <div class="fr-pl-act"><button class="btn sm" id="fr-pin" title="Name this view and keep it (on the server: every device sees it)">${icon("plus")} Pin this place</button><button class="btn ghost sm" id="fr-tour" title="Fly from place to place">${icon("play")} Tour</button></div>
          <div class="fr-places" id="fr-places"></div>
          <div class="sec-t">Globe and universe</div>
          <div class="fr-pl-act"><button class="btn ghost sm" id="fr-globe-b" title="Rise from this view to its planet: the set wrapped on a globe like a world map (or just zoom out past the whole set)">Globe</button><button class="btn ghost sm" id="fr-uni-b" title="The solar system of fractal planets; the moons are Julia sets">Universe</button></div>
          <div class="sec-t">Like this place</div>
          <div class="fr-pl-act"><button class="btn ghost sm" id="fr-like" title="Compare this view with your places and the atlas">${icon("search")} Places like this</button>
            <input class="in sm" id="fr-find" placeholder="Find: spiral, lightning…" title="CLIP finds the places whose picture fits the words"></div>
          <div class="fr-like" id="fr-likes"></div>
          <div class="fr-pl-act"><label class="toggle sm" title="Dots where you have looked before (the visit log)"><input type="checkbox" id="fr-visits"><i></i>Where I have been</label>
            <button class="btn ghost xs" id="fr-kfr-out" title="Save this view as a Kalles Fraktaler .kfr file">.kfr out</button><button class="btn ghost xs" id="fr-kfr-in" title="Open a Kalles Fraktaler .kfr file">.kfr in</button><input type="file" id="fr-kfr-file" accept=".kfr,.txt" hidden></div>
          <div class="sec-t">Set</div>
          <div class="fr-kinds" id="fr-kind">${[["mandelbrot", "Mandelbrot"], ["julia", "Julia"], ["burning-ship", "Burning ship"], ["tricorn", "Tricorn"]].map(([k, l], i) => `<button data-k="${k}" class="${i ? "" : "on"}" title="${l}">${l}</button>`).join("")}</div>
          <div class="sec-t">Palette</div>
          <div class="pal" id="fr-pal"></div>
          <div class="fields">
            <div class="fld"><label for="fr-dens">Colour density</label><input type="range" id="fr-dens" min="0.2" max="3" step="0.05" value="1"><span class="v" id="fr-densv">1.00</span></div>
            <div id="fr-julia" class="hidden fields">
              <div class="fld"><label for="fr-jr">Shape · real</label><input type="range" id="fr-jr" min="-1" max="1" step="0.002" value="-0.8"><span class="v" id="fr-jrv">-0.800</span></div>
              <div class="fld"><label for="fr-ji">Shape · imag.</label><input type="range" id="fr-ji" min="-1" max="1" step="0.002" value="0.156"><span class="v" id="fr-jiv">0.156</span></div>
            </div>
          </div>
        </div>
        <div class="pane-act"><div class="fr-btns"><button class="btn ghost sm" id="fr-reset">Reset view</button><button class="btn ghost sm" id="fr-back" title="The view before (Backspace)">Back</button><button class="btn ghost sm" id="fr-out" title="Zoom out 10× (−)">Zoom out</button><button class="btn ghost sm" id="fr-link" title="Copy a link to exactly this view">Copy link</button></div>
          <div class="fr-exp"><select class="sel sm" id="fr-size"><option value="screen">Screen size</option><option value="3840x2160" selected>4K (3840×2160)</option><option value="7680x4320">8K (7680×4320)</option></select><button class="btn sm" id="fr-wall">${icon("down")} Save image</button></div>
          <div class="hint">Like a map: scroll to zoom at the cursor · drag (it glides) · double-click flies that point to the centre and zooms in (shift: out) · pinch on touch · keys + − arrows, 0 home, Backspace back. Black is inside the set: zoom where the edge glows.</div></div>
      </section>
      <button class="btn ghost sm fr-open hidden" id="fr-open">Fractal controls</button>
      <canvas class="fr-mini" id="fr-mini" title="The whole set: click to go there"></canvas>
      <div class="fr-read" id="fr-read"></div>
    </div>`;
    setup();
    // panel chrome only: values beside sliders, collapse/expand, and wheel over the panel scrolls it instead of zooming
    const vs = [["#fr-dens", "#fr-densv", 2], ["#fr-jr", "#fr-jrv", 3], ["#fr-ji", "#fr-jiv", 3]];
    vs.forEach(([i, v, d]) => $(i).addEventListener("input", (e) => { $(v).textContent = (+e.target.value).toFixed(d); }));
    $("#fr-panel").addEventListener("wheel", (e) => e.stopPropagation());
    $("#fr-panel").addEventListener("pointerdown", (e) => e.stopPropagation());
    $("#fr-fold").onclick = () => { $("#fr-panel").classList.add("hidden"); $("#fr-open").classList.remove("hidden"); };
    $("#fr-open").onclick = () => { $("#fr-panel").classList.remove("hidden"); $("#fr-open").classList.add("hidden"); };
  },
  show(p) { if (readLink(p)) { syncKind(); renderPal(); restyle(); } render(); if (p && p.lab) openData($("#fr"), p.lab); },
};

function reset() {
  const [x, y, w] = VIEW0[S.kind] || VIEW0.mandelbrot;
  S.cx = bf(x); S.cy = bf(y); S.scale = w;
}
function setup() {
  api.get("/fractal/palettes").then((p) => { palettes = p; renderPal(); });
  const cv = $("#fr-cv"), wrap = $("#fr");
  $$("#fr-kind [data-k]").forEach((b) => b.onclick = () => { S.kind = b.dataset.k; $$("#fr-kind [data-k]").forEach((x) => x.classList.toggle("on", x === b)); $("#fr-julia").classList.toggle("hidden", S.kind !== "julia"); reset(); restyle(); });
  let st = null; const later = () => { clearTimeout(st); st = setTimeout(restyle, 120); };
  $("#fr-dens").oninput = (e) => { S.density = +e.target.value; later(); };
  $("#fr-jr").oninput = (e) => { S.jr = +e.target.value; later(); };
  $("#fr-ji").oninput = (e) => { S.ji = +e.target.value; later(); };
  $("#fr-reset").onclick = () => { remember(); const [x, y, w] = VIEW0[S.kind] || VIEW0.mandelbrot; MAP.flyTo(bf(x), bf(y), w); };
  $("#fr-wall").onclick = wallpaper;
  $("#fr-back").onclick = goBack;
  $("#fr-out").onclick = () => zoomBy(10);
  $("#fr-pre").onchange = (e) => { const v = PRESETS[+e.target.value]; e.target.value = ""; if (v) preset(v[1]); };
  $("#fr-link").onclick = async () => { writeLink(); try { await navigator.clipboard.writeText(location.href); toast("Link copied: it opens exactly this view"); } catch (e) { toast("Copy this address: " + location.href); } };
  document.addEventListener("keydown", (e) => {
    if (!document.querySelector("#view-fractal.on") || /INPUT|SELECT|TEXTAREA/.test((e.target || {}).tagName || "")) return;
    const k = e.key;
    if (k === "+" || k === "=") zoomBy(0.5); else if (k === "-") zoomBy(2); else if (k === "0") { remember(); const [x, y, w] = VIEW0[S.kind] || VIEW0.mandelbrot; MAP.flyTo(bf(x), bf(y), w); }
    else if (k === "Backspace") { e.preventDefault(); goBack(); }
    else if (k.startsWith("Arrow")) { e.preventDefault(); remember(); MAP.panBy(k === "ArrowLeft" ? -0.15 : k === "ArrowRight" ? 0.15 : 0, k === "ArrowUp" ? -0.15 : k === "ArrowDown" ? 0.15 : 0); }
  });
  S.onBefore = remember;
  S.onSettle = () => { writeLink(); readout(); settled(); };
  MAP = createMap(cv, S, { bf, bfStr, onMeta: (m) => { lastMeta = m; readout(); }, onView: () => { readout(); mini(); }, overlay });
  placesSetup(cv);
  render();
}
function renderPal() {
  $("#fr-pal").innerHTML = Object.entries(palettes).map(([k, cols]) => `<button data-p="${k}" class="${k === S.palette ? "on" : ""}" style="background:linear-gradient(90deg,${cols.join(",")})" title="${k}"></button>`).join("");
  $$("#fr-pal [data-p]").forEach((b) => b.onclick = () => { S.palette = b.dataset.p; $$("#fr-pal button").forEach((x) => x.classList.toggle("on", x === b)); restyle(); });
}

function zoomFmt(z) { if (z < 1e4) return Math.round(z) + "×"; const e = Math.floor(Math.log10(z)); return (z / 10 ** e).toFixed(1) + "e" + e + "×"; }
function render() { if (MAP) MAP.refresh(); }

// ---------------------------------------------------------------- places, pins, visits, scale bar, minimap
let PLACES = [], region = "", VISITS = [], pinHits = [], touring = false, miniImg = null, miniKey = "";
const q = encodeURIComponent;
const view = () => ({ kind: S.kind, cx: bfStr(S.cx).replace(/0+$/, "").replace(/\.$/, ""), cy: bfStr(S.cy).replace(/0+$/, "").replace(/\.$/, ""), scale: S.scale });
async function loadPlaces() { try { PLACES = (await api.get("/fractal/places")).places || []; } catch (e) { PLACES = []; } listPlaces(); render(); }
function depthOf(sc) { return zoomFmt(3.2 / sc); }
function listPlaces() {
  const el = $("#fr-places"); if (!el) return;
  $("#fr-pl-n").textContent = PLACES.length ? `· ${PLACES.length}` : "";
  el.innerHTML = PLACES.length ? PLACES.map((p) => `<div class="fr-pl" data-id="${p.id}" title="${esc(p.region || "")}${p.note ? " — " + esc(p.note) : ""}">
      <img src="/api/fractal/places/${p.id}/thumb" alt="" loading="lazy"><div class="tx"><div class="nm">${esc(p.name)}</div><div class="dim">${esc(p.kind === "mandelbrot" ? "" : p.kind + " · ")}${depthOf(p.scale)}</div></div>
      <button class="iconbtn" data-ren title="Rename">${icon("text")}</button><button class="iconbtn" data-del title="Remove">${icon("x")}</button></div>`).join("")
    : '<div class="hint">No places yet. Find a spot you like and press “Pin this place”.</div>';
  $$("#fr-places .fr-pl").forEach((r) => {
    const pl = PLACES.find((x) => x.id === r.dataset.id);
    r.onclick = (e) => { if (e.target.closest("[data-ren],[data-del]")) return; goPlace(pl); };
    $("[data-ren]", r).onclick = async () => { const n = prompt("A name for this place", pl.name); if (!n) return; await fetch(`/api/fractal/places/${pl.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: n }) }); loadPlaces(); };
    $("[data-del]", r).onclick = async () => { if (!confirm(`Remove “${pl.name}”?`)) return; await fetch(`/api/fractal/places/${pl.id}`, { method: "DELETE" }); loadPlaces(); };
  });
}
function goPlace(pl, ms) {
  remember();
  if (pl.kind !== S.kind || (pl.kind === "julia" && (pl.jr !== S.jr || pl.ji !== S.ji))) {
    Object.assign(S, { kind: pl.kind, cx: bfParse(pl.cx), cy: bfParse(pl.cy), scale: pl.scale, jr: pl.jr, ji: pl.ji }); syncKind(); restyle(); return;
  }
  MAP.flyTo(bfParse(pl.cx), bfParse(pl.cy), pl.scale, ms);
}
async function pin() {
  const v = view();
  let suggest = region; try { suggest = (await api.get(`/fractal/region?kind=${v.kind}&cx=${q(v.cx)}&cy=${q(v.cy)}&scale=${v.scale}`)).name; } catch (e) { /* keep */ }
  const name = prompt("Name this place", suggest); if (name === null) return;
  const r = await fetch("/api/fractal/places", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...v, name, palette: S.palette, density: S.density, jr: S.jr, ji: S.ji }) });
  if (!r.ok) { toast("Could not pin it: " + (await r.text()).slice(0, 120), "bad"); return; }
  toast("Pinned: " + (await r.json()).name); loadPlaces();
}
async function tour() {
  if (touring) { touring = false; $("#fr-tour").innerHTML = `${icon("play")} Tour`; return; }
  const list = PLACES.filter((p) => p.kind === S.kind); if (list.length < 2) { toast("Pin at least two places of this set for a tour"); return; }
  touring = true; $("#fr-tour").innerHTML = `${icon("stop")} Stop`;
  for (let i = 0; touring; i = (i + 1) % list.length) {
    goPlace(list[i]);
    await new Promise((res) => { const t0 = Date.now(); const w = setInterval(() => { const st = MAP.state(); if (!touring || (Date.now() - t0 > 1500 && !st.loading) || Date.now() - t0 > 30000) { clearInterval(w); res(); } }, 300); });
    await new Promise((res) => setTimeout(res, 1800));
  }
}
let lastVisit = "";
async function settled() {
  const v = view();
  try { region = (await api.get(`/fractal/region?kind=${v.kind}&cx=${q(v.cx)}&cy=${q(v.cy)}&scale=${v.scale}`)).name; } catch (e) { /* keep the old one */ }
  readout();
  const key = `${v.kind}|${v.cx.slice(0, 18)}|${v.cy.slice(0, 18)}|${v.scale.toExponential(2)}`;
  if (key !== lastVisit) { lastVisit = key; fetch("/api/fractal/visit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) }).catch(() => {}); }
  if ($("#fr-visits") && $("#fr-visits").checked) { try { VISITS = (await api.get(`/fractal/visits?kind=${v.kind}&cx=${q(v.cx)}&cy=${q(v.cy)}&scale=${v.scale}`)).points || []; } catch (e) { VISITS = []; } render(); }
}
function overlay(g, toScreen, { W, H, k }) {
  // where you have been: small amber dots, brighter when the visit was at about this depth
  if ($("#fr-visits") && $("#fr-visits").checked) {
    for (const [x, y, sc] of VISITS) { const [px, py] = toScreen(bfParse(x), bfParse(y)); if (px < 0 || py < 0 || px > W || py > H) continue; const a = Math.max(0.15, 1 - Math.abs(Math.log10(sc / S.scale)) / 4); g.globalAlpha = a * 0.7; g.fillStyle = "#ffb020"; g.beginPath(); g.arc(px, py, 2.4, 0, 7); g.fill(); }
    g.globalAlpha = 1;
  }
  // pins: every place of this set inside the view, labelled when it is near this depth
  pinHits = [];
  for (const p of PLACES) {
    if (p.kind !== S.kind) continue;
    const [px, py] = toScreen(bfParse(p.cx), bfParse(p.cy)); if (px < -20 || py < -20 || px > W + 20 || py > H + 20) continue;
    const near = Math.abs(Math.log10(p.scale / S.scale)) < 2.5;
    g.globalAlpha = 1; g.fillStyle = "#ffd300"; g.strokeStyle = "#050304"; g.lineWidth = 2;
    g.beginPath(); g.arc(px, py - 9, near ? 6 : 4, 0, 7); g.moveTo(px, py); g.lineTo(px - 4, py - 6); g.lineTo(px + 4, py - 6); g.closePath(); g.stroke(); g.fill();
    if (near) { g.font = "600 12px Inter, sans-serif"; g.textAlign = "left"; g.lineWidth = 3; g.strokeText(p.name, px + 10, py - 5); g.fillStyle = "#fff"; g.fillText(p.name, px + 10, py - 5); }
    pinHits.push([px, py - 9, p]);
  }
  // scale bar: a round length of the complex plane
  const want = 110 / k, e = Math.floor(Math.log10(want)), m = want / 10 ** e, n = m >= 5 ? 5 : m >= 2 ? 2 : 1, L = n * 10 ** e, px = L * k;
  const x0 = 16, y0 = H - 18;
  g.globalAlpha = 0.9; g.strokeStyle = "#fff"; g.lineWidth = 2; g.beginPath(); g.moveTo(x0, y0 - 5); g.lineTo(x0, y0); g.lineTo(x0 + px, y0); g.lineTo(x0 + px, y0 - 5); g.stroke();
  g.font = "11px 'JetBrains Mono', monospace"; g.fillStyle = "#fff"; g.textAlign = "left"; g.fillText(e >= -3 ? String(+L.toPrecision(2)) : `${n}e${e}`, x0 + px + 6, y0 + 3);
  g.globalAlpha = 1;
}
async function likeThis() {
  const v = view(), el = $("#fr-likes"); el.innerHTML = '<div class="hint">reading this view (escape times, roughness, symmetry, CLIP)…</div>';
  try {
    const r = await api.get(`/fractal/similar?kind=${v.kind}&cx=${q(v.cx)}&cy=${q(v.cy)}&scale=${v.scale}&jr=${S.jr}&ji=${S.ji}`);
    const h = r.here;
    el.innerHTML = `<div class="dim fr-here">Here: boundary dimension <b>${h.dimension.toFixed(2)}</b> (fit R² ${h.dimension_r2.toFixed(2)}) · ${Math.round(h.inside * 100)}% inside${h.symmetry_strength > 0.08 ? ` · ${h.symmetry}-fold` : ""}</div>` + likeRows(r.matches, true);
    bindLikes(r.matches);
  } catch (e) { el.innerHTML = `<div class="hint">${esc(e.message)}</div>`; }
}
async function findWords(text) {
  const el = $("#fr-likes"); if (!text) return; el.innerHTML = '<div class="hint">CLIP is reading the words…</div>';
  try { const r = await api.get(`/fractal/search?q=${q(text)}`); el.innerHTML = `<div class="dim fr-here">Closest to “${esc(text)}”:</div>` + likeRows(r.matches, false); bindLikes(r.matches); }
  catch (e) { el.innerHTML = `<div class="hint">${esc(e.message)}</div>`; }
}
function likeRows(ms, why) {
  return ms.map((m, i) => `<div class="fr-lk" data-i="${i}"><span class="sc">${(m.score * (why ? 100 : 100)).toFixed(0)}</span><div class="tx"><div class="nm">${esc(m.name)}${m.atlas ? ' <span class="dim">· atlas</span>' : ""}</div>${why ? `<div class="dim">${esc(m.why)}</div>` : ""}</div></div>`).join("");
}
function bindLikes(ms) { $$("#fr-likes .fr-lk").forEach((r) => r.onclick = () => { const m = ms[+r.dataset.i]; goPlace({ kind: m.kind, cx: m.cx, cy: m.cy, scale: m.scale, jr: m.kind === "julia" ? -0.123 : S.jr, ji: m.kind === "julia" ? 0.745 : S.ji }); }); }
// ---- space: the solar system and the planets' globes, one continuous zoom with the flat map
let SPACE = null;
function palCols() { return palettes[S.palette] || null; }
function spaceSetup() {
  const host = $("#fr");
  SPACE = createSpace(host, { palette: palCols(), onLand: (fam, x, y, scale, jc) => {   // the globe hands over to the map
    remember(); Object.assign(S, { kind: fam, cx: bf(x), cy: bf(y), scale }); if (jc) { S.jr = jc[0]; S.ji = jc[1]; } syncKind(); restyle();
  } });
  const here = () => ({ palette: palCols(), kind: S.kind, cx: Number(S.cx) / 1e80, cy: Number(S.cy) / 1e80, scale: S.scale, jc: [S.jr, S.ji] });
  $("#fr-globe-b").onclick = () => SPACE.open(here());
  $("#fr-uni-b").onclick = () => SPACE.open({ palette: palCols() });
  $$("#fr-panel [data-lab]").forEach((b) => b.onclick = () => openData(host, b.dataset.lab));
  S.onFar = () => SPACE.open(here());                    // zooming the map out past the whole set rises to the globe
}
function placesSetup(cv) {
  spaceSetup();
  $("#fr-like").onclick = likeThis;
  $("#fr-find").onkeydown = (e) => { if (e.key === "Enter") findWords(e.target.value.trim()); };
  $("#fr-pin").onclick = pin;
  $("#fr-tour").onclick = tour;
  $("#fr-visits").onchange = () => { if ($("#fr-visits").checked) settled(); else render(); };
  $("#fr-kfr-out").onclick = () => { const v = view(); location.href = `/api/fractal/kfr?kind=${v.kind}&cx=${q(v.cx)}&cy=${q(v.cy)}&scale=${v.scale}`; };
  $("#fr-kfr-in").onclick = () => $("#fr-kfr-file").click();
  $("#fr-kfr-file").onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return; e.target.value = "";
    try { const r = await fetch("/api/fractal/kfr", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: await f.text() }) }); const j = await r.json(); if (!r.ok) throw new Error(j.detail || r.status); const v = j.result || j;
      goPlace({ kind: "mandelbrot", cx: v.cx, cy: v.cy, scale: v.scale }); toast(`Opened ${f.name}: ${zoomFmt(3.2 / v.scale)} zoom`); } catch (err) { toast("That .kfr could not be read: " + err.message, "bad"); }
  };
  let down = null;
  cv.addEventListener("pointerdown", (e) => { down = [e.clientX, e.clientY]; });
  cv.addEventListener("click", (e) => {                 // a pin: fly to it (a click, not the end of a drag)
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const hit = pinHits.find(([px, py]) => Math.hypot(px - x, py - y) < 10); if (hit) goPlace(hit[2]);
  });
  const mc = $("#fr-mini");
  mc.addEventListener("click", (e) => {                 // the minimap: go to that point of the whole set, at this zoom
    const [x0, y0, w0] = VIEW0[S.kind] || VIEW0.mandelbrot, r = mc.getBoundingClientRect();
    const X = x0 + ((e.clientX - r.left) / r.width - 0.5) * w0, Y = y0 + ((e.clientY - r.top) / r.height - 0.5) * w0 * (r.height / r.width);
    remember(); MAP.flyTo(bf(X), bf(Y), Math.min(S.scale, w0 / 4));
  });
  loadPlaces();
}
function mini() {                                      // the whole set, small, with the current view marked
  const mc = $("#fr-mini"); if (!mc) return;
  const [x0, y0, w0] = VIEW0[S.kind] || VIEW0.mandelbrot, W = 180, H = 120, key = [S.kind, S.palette, S.jr, S.ji].join("|");
  if (mc.width !== W * 2) { mc.width = W * 2; mc.height = H * 2; }
  if (miniKey !== key) { miniKey = key; miniImg = null; const im = new Image(); im.onload = () => { miniImg = im; mini(); };
    im.src = `/api/fractal?kind=${S.kind}&cx=${x0}&cy=${y0}&scale=${w0}&w=${W * 2}&h=${H * 2}&palette=${S.palette}&jr=${S.jr}&ji=${S.ji}&density=${S.density}`; }
  const g = mc.getContext("2d"); g.clearRect(0, 0, mc.width, mc.height);
  if (miniImg) g.drawImage(miniImg, 0, 0, mc.width, mc.height);
  const kx = mc.width / w0, cx = Number(S.cx) / 1e80, cy = Number(S.cy) / 1e80;
  const px = mc.width / 2 + (cx - x0) * kx, py = mc.height / 2 + (cy - y0) * kx, ww = S.scale * kx;
  g.strokeStyle = "#ffd300"; g.lineWidth = 2;
  if (ww > 6) g.strokeRect(px - ww / 2, py - ww * 0.33, ww, ww * 0.66);
  else { g.beginPath(); g.moveTo(px - 9, py); g.lineTo(px + 9, py); g.moveTo(px, py - 9); g.lineTo(px, py + 9); g.stroke(); }
  for (const p of PLACES) if (p.kind === S.kind) { g.fillStyle = "#ffd300"; g.beginPath(); g.arc(mc.width / 2 + (+p.cx - x0) * kx, mc.height / 2 + (+p.cy - y0) * kx, 2.5, 0, 7); g.fill(); }
}
let roT = null;
function readout() {                                   // zoom, depth and precision, at most every 150 ms
  if (roT) return;
  roT = setTimeout(() => {
    roT = null; const el = $("#fr-read"); if (!el || !MAP) return;
    const z = 3.2 / S.scale, st = MAP.state(), dec = Math.max(0, Math.log10(z));
    el.innerHTML = `${region ? `<div class="fr-where">${icon("eye")} ${esc(region)}</div>` : ""}<div class="p">${zoomFmt(z)} zoom</div><div class="dim">${dec.toFixed(1)} decades deep · ${esc(lastMeta.precision || "—")} · ${fmt.n(lastMeta.iters || 0)} iters</div>${st.loading ? `<div class="dim fr-slow">${st.loading} tile${st.loading === 1 ? "" : "s"} rendering${lastMeta.ms > 800 ? " · deep tiles take seconds" : ""}</div>` : `<div class="timing">${fmt.ms(lastMeta.ms || 0)} a tile</div>`}`;
  }, 150);
}

async function wallpaper() {
  const sz = $("#fr-size").value, cv = $("#fr-cv");
  const [w, h] = sz === "screen" ? [Math.round(cv.clientWidth * (window.devicePixelRatio || 1)), Math.round(cv.clientHeight * (window.devicePixelRatio || 1))] : sz.split("x").map(Number);
  const deep = S.scale < 3e-13 && S.kind === "mandelbrot";
  toast(`The card makes a ${w}×${h} image${deep ? " (deep: this can take a few minutes)" : ""}…`);
  const q = encodeURIComponent, btn = $("#fr-wall"); btn.disabled = true;
  const url = `/api/fractal/wallpaper?kind=${S.kind}&cx=${q(bfStr(S.cx))}&cy=${q(bfStr(S.cy))}&scale=${q(S.scale.toExponential(18))}&palette=${S.palette}&jr=${S.jr}&ji=${S.ji}&density=${S.density}&w=${w}&h=${h}`;
  try {
    const r = await fetch(url); if (!r.ok) throw new Error((await r.text()).slice(0, 200) || r.status);
    const u = URL.createObjectURL(await r.blob()), a = document.createElement("a");
    a.href = u; a.download = `vectorfall-${S.kind}-${w}x${h}.jpg`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000);
    toast(`Saved ${w}×${h}`);
  } catch (e) { toast("The image failed: " + e.message, "bad"); } finally { btn.disabled = false; }
}
