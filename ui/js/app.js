import { register, route, shell, icon, views, esc, routeSubs, $, $$ } from "./core.js";
import home from "./home.js";
import text from "./text.js";
import vlm from "./vlm.js?v=1015k";
import photo from "./photo.js?v=rc2q";
import sound from "./sound.js?v=1016s";
import data from "./data.js";
import forecast from "./forecast.js";
import simulate from "./simulate.js";
import plan from "./plan.js";
import reservoir from "./reservoir.js";
import particles from "./particles.js?v=rc6";
import fractal from "./fractal.js";
import life from "./life.js?v=1016l";
import console_ from "./console.js";
import machine from "./machine.js";
import lineage from "./lineage.js";
import models from "./models.js";
import { startShell } from "./os.js";
import { initFold } from "./fold.js";

[home, text, vlm, photo, sound, data, forecast, simulate, plan, reservoir, particles, fractal, life, console_, models, machine, lineage].forEach(register);

// All views, flat, so shell() builds every #main section (and a baseline rail we replace with themed groups below).
const FLAT = ["home", "vlm", "text", "photo", "sound", "data", "plan", "forecast", "simulate", "particles", "reservoir", "fractal", "life", "console", "models", "machine", "lineage"];
shell(FLAT);

// Themed pulldowns: home and machine stay top-level; the rest group under a theme icon that opens a flyout.
const GROUPS = [
  { app: "home" },
  { t: "Language", icon: "vlm", ids: ["vlm", "text"] },
  { t: "Media", icon: "photo", ids: ["photo", "sound"] },
  { t: "Data & Plan", icon: "data", ids: ["data", "plan", "forecast"] },
  { t: "Simulate", icon: "orbit", ids: ["simulate", "particles", "reservoir", "fractal", "life"] },
  { t: "Build", icon: "console", ids: ["console", "models"] },
  { app: "machine" },
  { app: "lineage" },
];
buildGroupedRail();

startShell();
initFold(document.getElementById("main"));
route();

function appLink(id) {
  const v = views()[id];
  if (!v) return "";
  return `<a class="app" href="#${id}" data-v="${id}">${icon(v.icon)}<span class="tip">${esc(v.title)}</span></a>`;
}

function buildGroupedRail() {
  const host = $("#rail-apps");
  if (!host) return;
  host.innerHTML = GROUPS.map((g) => g.app ? appLink(g.app) :
    `<div class="rg"><button class="rgh" type="button">${icon(g.icon)}<span class="tip">${esc(g.t)}</span></button>` +
    `<div class="rgf"><div class="rgf-t">${esc(g.t)}</div>${g.ids.map(appLink).join("")}</div></div>`).join("");
  const close = () => $$("#rail-apps .rg.open").forEach((r) => r.classList.remove("open"));
  $$("#rail-apps .rgh").forEach((h) => h.onclick = (e) => {
    e.stopPropagation();
    const rg = h.parentElement, was = rg.classList.contains("open");
    close();
    rg.classList.toggle("open", !was);
    if (!was) placeFlyout(rg);
  });
  window.addEventListener("resize", close);
  $$("#rail-apps .rgf a.app").forEach((a) => a.addEventListener("click", close));
  document.addEventListener("click", close);
  // keep the theme icon lit when one of its apps is the current view (route() lights the app link itself)
  routeSubs.add((v) => $$("#rail-apps .rg").forEach((rg) =>
    rg.classList.toggle("active", !!rg.querySelector(`a.app[data-v="${v.id}"]`))));
}

// Put an open flyout where it fits: above its dock button (dock or narrow screens) or beside it (rail), kept 8px
// inside the window, and no taller than the space there (it scrolls past that).
function placeFlyout(rg) {
  const f = rg.querySelector(".rgf"), h = rg.querySelector(".rgh");
  if (!f || !h) return;
  const M = 8, GAP = 10;
  f.style.left = f.style.top = f.style.bottom = f.style.transform = f.style.maxHeight = "";
  const below = document.body.dataset.dock === "bottom" || getComputedStyle(h.closest(".rail")).flexDirection === "row";
  const hb = h.getBoundingClientRect();
  // a fixed flyout (phones) is placed in window coordinates; an absolute one relative to its group
  const rb = getComputedStyle(f).position === "fixed" ? { left: 0, top: 0, bottom: window.innerHeight } : rg.getBoundingClientRect();
  f.style.transform = "none";
  if (below) {
    f.style.maxHeight = Math.max(120, hb.top - GAP - M) + "px";
    const fw = f.offsetWidth;
    const x = Math.min(Math.max(M, hb.left + hb.width / 2 - fw / 2), window.innerWidth - fw - M);
    f.style.left = (x - rb.left) + "px";
    f.style.top = "auto";
    f.style.bottom = (rb.bottom - hb.top + GAP) + "px";
  } else {
    f.style.maxHeight = (window.innerHeight - 2 * M) + "px";
    const fh = f.offsetHeight;
    const y = Math.min(Math.max(M, hb.top), window.innerHeight - fh - M);
    f.style.left = (hb.right - rb.left + M) + "px";
    f.style.top = (y - rb.top) + "px";
    f.style.bottom = "auto";
  }
}
