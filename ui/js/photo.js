import { $, $$, api, dropZone, esc, fail, fmt, go, icon, toast, watchJob } from "./core.js";
import { menu } from "./hub.js";

// Photo Lab — library | stage | develop.
// Edits are non-destructive and live on the server (photo.edit*): the original never changes, every committed change
// is a named history step (undo / redo / go to any step), and the same edit is seen by every browser, the CLI and an
// agent over MCP. While a slider moves, the stage asks the card for a draft at half size (fast); when it stops, the
// full preview follows. Rendering is a single-flight, latest-wins scheduler: one request to the card at a time, and
// whatever the controls say *now* is what gets rendered next; a result for a photo you have left is thrown away; the
// image on screen is swapped only after the new one has decoded, so the stage is never blank.
// "Smart" tools show their evidence: Auto lists each slider it set and why, with its distance to fixed targets next to
// the original and a plain levels stretch; search shows each match's lift over a caption that says nothing.
const GROUPS = [
  ["light", "Light", [["exposure", "Exposure", -1, 1], ["contrast", "Contrast", -1, 1], ["highlights", "Highlights", -1, 1], ["shadows", "Shadows", -1, 1],
    ["whites", "Whites", -1, 1], ["blacks", "Blacks", -1, 1]]],
  ["colour", "Colour", [["warmth", "Temperature", -1, 1], ["tint", "Tint", -1, 1], ["vibrance", "Vibrance", -1, 1], ["saturation", "Saturation", -1, 1]]],
  ["detail", "Detail", [["clarity", "Clarity", 0, 1], ["sharpen", "Sharpen", 0, 2], ["denoise", "Noise reduction", 0, 1]]],
  ["effects", "Effects", [["vignette", "Vignette", 0, 1], ["grain", "Grain", 0, 1], ["fade", "Fade", 0, 0.6]]],
];
const LABEL = Object.fromEntries(GROUPS.flatMap(([, , rows]) => rows.map(([k, l]) => [k, l])));
const LOOK_NAME = (k) => (k === "none" ? "Original" : k.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" "));
const KEYS = [["\\", "Show the original (press again to go back)"], ["Hold the mouse on the photo", "Show the original while held"],
  ["Y", "Side by side"], ["W", "Wipe: drag the line"], ["Z", "Fit / actual pixels"], ["J", "Show clipped pixels"],
  ["← →", "Previous / next photo"], ["P · X · U", "Pick · reject · no flag"], ["0 – 5", "Stars"], ["Shift+A", "Auto"],
  ["R", "Crop and straighten (Enter: done, Esc: cancel; Ctrl-drag: draw a level line)"], ["M", "Masks: local changes"],
  ["O", "Show the selected mask in red"], ["[ · ]", "Smaller · larger brush (Alt paints the erase)"], ["Ctrl+Z · Ctrl+Shift+Z", "Undo · redo"], ["Ctrl+Shift+C · V", "Copy · paste the settings"], ["Double-click", "A slider or a group name resets it"]];
const pm = (name, body = {}) => api.post("/photos/m/" + name, body);

const S = { photos: [], looks: {}, builtin: [], user: [], cur: null, adj: {}, edit: null, view: "result", before: false, zoom: "fit",
  center: null, q: "", results: null, like: null, clip: null, filter: "all", drag: false, clipOn: false, wipe: 50, copied: null, auto: null,
  mode: null, crop: [0, 0, 1, 1], aspect: null, leveling: false, levelLine: null, msel: -1, overlay: false, brush: { r: 0.05, f: 0.5, erase: false }, brushAt: null };
const shown = { after: null, before: null };              // { url, key } currently on screen
const lookThumbs = new Map();                              // pid|look -> object URL
let inflight = false, panning = null, mounted = false, holdT = 0, tSent = 0;
const SHUT = (() => { try { return JSON.parse(localStorage.getItem("vf.photo.shut") || "{}"); } catch (e) { return {}; } })();

export default {
  id: "photo", title: "Photo Lab", sub: "develop on the card", icon: "photo",
  mount(el) {
    el.innerHTML = `<div class="ws side-lr pl">
      <div class="col">
        <section class="pane grow pl-lib"><div class="pane-h"><div class="t">Library</div><div class="meta" id="pl-count"></div>
          <div class="tools"><button class="iconbtn" id="pl-add" title="Add photos">${icon("plus")}</button><button class="btn ghost xs" id="pl-folder" title="Add every photo in a folder (and its sub-folders)">Folder</button></div></div>
          <div class="pl-libtop">
            <div class="pl-search"><input class="in sm" id="pl-q" placeholder="Find photos of… “receipt”, “dog on a beach”" autocomplete="off"><button class="iconbtn" id="pl-qx" title="Clear the search" hidden>${icon("x")}</button></div>
            <div class="pl-clip" id="pl-clip"></div>
            <div class="seg pl-filter" id="pl-filter" title="Show only some photos (P pick, X reject, 1-5 stars)">
              <button data-f="all" class="on">All</button><button data-f="picks">Picks</button><button data-f="rated">★ 1+</button><button data-f="edited">Edited</button><button data-f="rejected">Rejected</button></div>
          </div>
          <div class="pane-b"><div class="drop pl-drop" id="pl-drop"><b>Drop photos</b> or click · JPEG, PNG, WebP, TIFF · or add a whole <b>Folder</b></div><div class="pl-grid" id="pl-grid"></div></div></section>
        <section class="pane fit pl-dupes"><div class="pane-h"><div class="t">Duplicates</div><div class="tools"><button class="btn ghost xs" id="pl-dupe">Find</button></div></div>
          <div class="pane-b" id="pl-dupe-out"><div class="hint">Near-identical photos (bursts, re-saves, crops) grouped by what they show. The biggest and sharpest is suggested as the keeper; nothing is removed until you say so.</div></div></section>
      </div>
      <section class="pane pl-stgpane"><div class="pane-h"><div class="t" id="pl-name">Stage</div><div class="meta" id="pl-dims"></div>
          <div class="tools">
            <div class="seg" id="pl-view"><button data-v="result" class="on" title="The result. Hold the mouse on the photo, or press \\, to see the original">Result</button><button data-v="wipe" title="Wipe (W): drag the line between the original and the result">Wipe</button><button data-v="side" title="Side by side (Y)">Side by side</button></div>
            <div class="seg" id="pl-zoom"><button data-z="fit" class="on" title="Fit to the stage (Z)">Fit</button><button data-z="1" title="Actual pixels (Z): drag to pan">1:1</button></div>
            <button class="btn ghost xs" id="pl-clipb" title="Show clipped pixels (J): red = pure white, blue = pure black">Clipping</button>
            <button class="btn ghost xs" id="pl-like" title="Photos that show something similar (CLIP)">${icon("eye")} Similar</button>
            <button class="iconbtn" id="pl-keys" title="Keyboard shortcuts">?</button>
          </div></div>
        <div class="pane-b stage pl-stg result" id="pl-stg">
          <figure class="pl-frame" id="pl-f-before"><div class="pl-box"><img id="pl-before" alt="" draggable="false"><figcaption>Original</figcaption></div></figure>
          <figure class="pl-frame" id="pl-f-after"><div class="pl-box"><img id="pl-after" alt="" draggable="false"><img id="pl-wb" alt="" draggable="false"><canvas id="pl-clipcv"></canvas><div id="pl-tools"></div>
            <div class="pl-wipe" id="pl-wipe"><i></i></div><figcaption id="pl-cap-a">Result</figcaption><figcaption class="l" id="pl-cap-b">Original</figcaption></div></figure>
          <div class="pl-empty" id="pl-empty">Drop a photo into the library to start.</div>
          <div class="pl-credit" id="pl-credit" hidden></div>
        </div>
        <div class="pane-f" id="pl-foot"><span class="pl-rate" id="pl-rate"></span><span id="pl-f-dim">—</span><span id="pl-f-look"></span><span id="pl-f-state"></span><span class="timing" id="pl-f-ms"></span></div></section>
      <div class="col">
        <section class="pane grow pl-devpane"><div class="pane-h"><div class="t">Develop</div>
          <div class="tools">
            <button class="btn xs pl-axb" id="pl-ax" title="Auto (Shift+A): measure this photo and set the light and colour sliders. Shows why, and the score.">${icon("spark")} Auto</button>
            <button class="iconbtn" id="pl-undo" title="Undo (Ctrl+Z)">${icon("undo")}</button><button class="iconbtn" id="pl-redo" title="Redo (Ctrl+Shift+Z)">${icon("redo")}</button>
            <button class="btn ghost xs" id="pl-copy" title="Copy and paste settings (Ctrl+Shift+C / V), or paste them to many photos">Copy…</button>
            <button class="btn ghost xs" id="pl-reset" title="Back to the original (a history step: Undo brings the edit back)">Reset</button></div></div>
          <div class="pane-b pl-dev">
            <div class="pl-histw"><canvas id="pl-hist" class="pl-hist"></canvas>
              <button class="pl-ci lo" id="pl-ci-lo" title="Pure black pixels: click to show them (J)"></button><button class="pl-ci hi" id="pl-ci-hi" title="Pure white pixels: click to show them (J)"></button></div>
            <div id="pl-axbox"></div>
            <div class="pl-sec" data-sec="geometry"><div class="pl-st"><span>Crop &amp; straighten</span><span class="pl-sv" id="pl-geov"></span><i class="chev"></i></div>
              <div class="pl-sb"><div class="pl-crow"><button class="btn xs" id="pl-crop-go" title="Crop (R): drag the corners on the photo">Crop</button>
                  <button class="iconbtn" id="pl-rotl" title="Rotate left">↺</button><button class="iconbtn" id="pl-rotr" title="Rotate right">↻</button><button class="iconbtn" id="pl-flip" title="Mirror left to right">⇋</button>
                  <button class="btn ghost xs" id="pl-crop-reset" title="No crop, no rotation">Reset</button></div>
                <div class="seg pl-asp" id="pl-aspects" title="The shape of the crop"></div>
                <div class="fld pl-amt"><label for="pl-s-angle">Straighten</label><input type="range" class="bi" id="pl-s-angle" min="-45" max="45" step="0.05" value="0" title="Double-click to reset"><input class="pl-num" id="pl-v-angle" value="0°"></div>
                <div class="pl-crow"><button class="btn ghost xs" id="pl-autostr" title="Find the tilt from the horizon and the vertical lines, and show the evidence">Auto straighten</button>
                  <button class="btn ghost xs" id="pl-level" title="Draw a line along something that must be level (or Ctrl-drag in Crop)">Level</button></div>
                <div class="hint pl-strv" id="pl-strv"></div>
                <div class="pl-crow" id="pl-cropact" hidden><button class="btn xs" id="pl-crop-done">Done (Enter)</button><button class="btn ghost xs" id="pl-crop-x">Cancel (Esc)</button></div></div></div>
            <div class="pl-sec" data-sec="masks"><div class="pl-st"><span>Masks</span><span class="pl-sv" id="pl-mcount"></span><i class="chev"></i></div>
              <div class="pl-sb"><div class="pl-crow"><button class="btn xs" id="pl-m-add" title="Masks (M): change only a part of the photo">+ Mask…</button>
                  <button class="btn ghost xs" id="pl-m-ov" title="Show the selected mask in red (O)">Overlay</button><button class="btn ghost xs" id="pl-m-done">Done</button></div>
                <div id="pl-mlist"></div><div class="pl-mname" id="pl-mname"></div><div id="pl-mlocal"></div></div></div>
            <div class="pl-sec" data-sec="looks"><div class="pl-st"><span>Looks</span><span class="pl-sv" id="pl-lookv"></span><i class="chev"></i></div>
              <div class="pl-sb"><div class="pl-lookgrid" id="pl-looks"></div>
                <div class="fld pl-amt" id="pl-amtrow"><label for="pl-amount">Amount</label><input type="range" id="pl-amount" min="0" max="2" step="0.01" value="1" title="How strongly the look applies (double-click: 100%)"><input class="pl-num" id="pl-amount-v" value="100%"></div>
                <div class="pl-lookact"><button class="btn ghost xs" id="pl-savelook" title="Save the current settings as a look you can use on any photo">Save as look…</button></div></div></div>
            <div id="pl-sliders"></div>
            <div class="pl-sec" data-sec="history"><div class="pl-st"><span>History</span><span class="pl-sv" id="pl-histn"></span><i class="chev"></i></div>
              <div class="pl-sb"><div class="pl-steps" id="pl-steps"></div></div></div>
          </div>
          <div class="pane-act"><div class="pl-exp"><button class="btn block" id="pl-save">${icon("down")} Export full resolution</button><button class="btn ghost" id="pl-more" title="Export many photos in a zip">…</button></div>
            <div class="hint" id="pl-act-hint">&nbsp;</div></div></section>
      </div>
    </div>`;
    setup();
    mounted = true;
    applyQ();
  },
  show(p = {}) { if (p.q) pendingQ = p.q; if (mounted) requestAnimationFrame(() => { layout(); pump(); applyQ(); if (p.panel === "search") $("#pl-q").focus(); }); },
};

// ---------------------------------------------------------------- setup
async function setup() {
  $("#pl-sliders").innerHTML = GROUPS.map(([gk, grp, rows]) => `<div class="pl-sec" data-sec="${gk}"><div class="pl-st" title="Double-click: reset the ${grp.toLowerCase()} sliders"><span>${grp}</span><span class="pl-sv" id="pl-gv-${gk}"></span><i class="chev"></i></div>
    <div class="pl-sb"><div class="fields pl-fields">${rows.map(([k, l, lo, hi]) =>
    `<div class="fld"><label for="pl-s-${k}" title="Double-click to reset">${l}</label><input type="range" class="${lo < 0 ? "bi" : ""}" id="pl-s-${k}" data-adj="${k}" min="${lo}" max="${hi}" step="0.01" value="0" title="Double-click to reset"><input class="pl-num" id="pl-v-${k}" data-num="${k}" value="0" title="Type a value, then Enter"></div>`).join("")}</div></div></div>`).join("");
  $$("#pl-sliders [data-adj]").forEach((i) => {
    i.addEventListener("pointerdown", () => { S.drag = true; });
    i.oninput = () => { S.drag = true; setAdj(i.dataset.adj, +i.value); };
    i.onchange = () => { S.drag = false; commit(`${LABEL[i.dataset.adj]} ${fmtv(+i.value)}`); };
    i.ondblclick = () => resetKeys([i.dataset.adj], `${LABEL[i.dataset.adj]} reset`);
  });
  $$("#pl-sliders label").forEach((l) => l.ondblclick = () => { const k = l.htmlFor.replace("pl-s-", ""); resetKeys([k], `${LABEL[k]} reset`); });
  $$("#pl-sliders [data-num]").forEach((n) => {
    n.onfocus = () => n.select();
    n.onkeydown = (e) => { if (e.key === "Enter") n.blur(); if (e.key === "Escape") { n.value = fmtv(S.adj[n.dataset.num] || 0); n.blur(); } };
    n.onchange = () => { const v = parseFloat(n.value.replace(",", ".")); if (isNaN(v)) { n.value = fmtv(S.adj[n.dataset.num] || 0); return; } setAdj(n.dataset.num, v); syncControls(); commit(`${LABEL[n.dataset.num]} ${fmtv(v)}`); };
  });
  $$(".pl-dev .pl-sec").forEach((s) => {
    const k = s.dataset.sec; s.classList.toggle("shut", !!SHUT[k]);
    const h = $(".pl-st", s);
    h.onclick = (e) => { if (e.detail > 1) return; s.classList.toggle("shut"); SHUT[k] = s.classList.contains("shut"); try { localStorage.setItem("vf.photo.shut", JSON.stringify(SHUT)); } catch (x) { /* storage off */ } };
    const g = GROUPS.find((x) => x[0] === k);
    if (g) h.ondblclick = (e) => { e.preventDefault(); s.classList.remove("shut"); resetKeys(g[2].map((r) => r[0]), `${g[1]} reset`); };
  });
  const amt = $("#pl-amount");
  amt.addEventListener("pointerdown", () => { S.drag = true; });
  amt.oninput = () => { S.drag = true; setAmount(+amt.value); };
  amt.onchange = () => { S.drag = false; commit(`${LOOK_NAME(S.adj.look || "none")} ${Math.round((S.adj.amount ?? 1) * 100)}%`); };
  amt.ondblclick = () => { setAmount(1); syncControls(); commit(`${LOOK_NAME(S.adj.look || "none")} 100%`); };
  $("#pl-amount-v").onkeydown = (e) => { if (e.key === "Enter") e.target.blur(); };
  $("#pl-amount-v").onchange = (e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) { setAmount(v / 100); syncControls(); commit(`${LOOK_NAME(S.adj.look || "none")} ${Math.round(v)}%`); } };
  $("#pl-savelook").onclick = saveLook;
  $("#pl-reset").onclick = () => { if (Object.keys(S.adj).length) { S.adj = {}; syncControls(); commit("Reset to the original"); } };
  $("#pl-undo").onclick = () => step(-1);
  $("#pl-redo").onclick = () => step(1);
  $("#pl-ax").onclick = auto;
  $("#pl-copy").onclick = (e) => copyMenu(e.currentTarget);
  $$("#pl-view [data-v]").forEach((b) => b.onclick = () => setView(b.dataset.v));
  $$("#pl-zoom [data-z]").forEach((b) => b.onclick = () => setZoom(b.dataset.z));
  $$("#pl-filter [data-f]").forEach((b) => b.onclick = () => setFilter(b.dataset.f));
  $("#pl-clipb").onclick = $("#pl-ci-lo").onclick = $("#pl-ci-hi").onclick = () => setClip(!S.clipOn);
  $("#pl-keys").onclick = (e) => menu(e.currentTarget, KEYS.map(([k, d]) => ({ icon: "bolt", label: k, sub: d, run: () => {} })));
  $("#pl-save").onclick = save;
  $("#pl-more").onclick = (e) => exportMenu(e.currentTarget);
  $("#pl-dupe").onclick = dupes;
  $("#pl-q").oninput = () => { clearTimeout(S.qt); S.qt = setTimeout(() => searchWords($("#pl-q").value.trim()), 350); };
  $("#pl-q").onkeydown = (e) => { if (e.key === "Enter") { clearTimeout(S.qt); searchWords($("#pl-q").value.trim()); } };
  $("#pl-qx").onclick = () => { $("#pl-q").value = ""; S.results = null; S.like = null; S.q = ""; renderGrid(); };
  $("#pl-like").onclick = () => { if (S.cur) searchLike(S.cur); };
  clipStatus();
  dropZone($("#pl-drop"), upload, "image/*");
  $("#pl-add").onclick = () => $("#pl-drop input[type=file]").click();
  $("#pl-folder").onclick = pickFolder;
  toolsSetup();
  document.addEventListener("keydown", keys);
  document.addEventListener("pointerup", () => { if (S.drag) { S.drag = false; pump(); } });   // a click on a slider that did not move it
  stagePointer();
  new ResizeObserver(() => { layout(); pump(); }).observe($("#pl-stg"));
  await loadLooks();
  await reload();
}

function keys(e) {
  if (!document.querySelector("#view-photo.on") || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.querySelector(".vf-menu")) return;
  const k = e.key, ctl = e.ctrlKey || e.metaKey;
  let done = true;
  if (ctl && !e.shiftKey && k.toLowerCase() === "z") step(-1);
  else if (ctl && (e.shiftKey && k.toLowerCase() === "z" || k.toLowerCase() === "y")) step(1);
  else if (ctl && e.shiftKey && k.toLowerCase() === "c") copySettings();
  else if (ctl && e.shiftKey && k.toLowerCase() === "v") pasteHere();
  else if (ctl || e.altKey) done = false;
  else if (k === "Escape" && S.mode) { if (S.mode === "crop") cropDone(false); else setMode(null); }
  else if (k === "Enter" && S.mode === "crop") cropDone(true);
  else if (k === "r" || k === "R") setMode(S.mode === "crop" ? null : "crop");
  else if (k === "m" || k === "M") setMode(S.mode === "mask" ? null : "mask");
  else if (k === "o" || k === "O") setOverlay(!S.overlay);
  else if ((k === "[" || k === "]") && S.mode === "mask") { S.brush.r = clamp(S.brush.r * (k === "]" ? 1.25 : 0.8), 0.005, 0.25); $("#pl-ml-size").value = S.brush.r; $("#pl-mv-size").value = Math.round(S.brush.r * 100) + "%"; drawTools(); }
  else if (S.mode && (k === "y" || k === "Y" || k === "w" || k === "W" || k === "z" || k === "Z" || k === "\\")) done = false;
  else if (k === "\\") setBefore(!S.before);
  else if (k === "y" || k === "Y") setView(S.view === "side" ? "result" : "side");
  else if (k === "w" || k === "W") setView(S.view === "wipe" ? "result" : "wipe");
  else if (k === "z" || k === "Z") setZoom(S.zoom === "1" ? "fit" : "1");
  else if (k === "j" || k === "J") setClip(!S.clipOn);
  else if (k === "A" && e.shiftKey) auto();
  else if (k === "p" || k === "P") rate({ flag: "pick" }, true);
  else if (k === "x" || k === "X") rate({ flag: "reject" }, true);
  else if (k === "u" || k === "U") rate({ flag: "none" });
  else if (/^[0-5]$/.test(k)) rate({ stars: +k });
  else if (k === "ArrowRight" || k === "ArrowLeft") nav(k === "ArrowRight" ? 1 : -1);
  else done = false;
  if (done) e.preventDefault();
}

// ---------------------------------------------------------------- the edit: working copy, commit, history
function setAdj(k, v) {
  if (Math.abs(v) < 1e-9) delete S.adj[k]; else S.adj[k] = Math.round(v * 1000) / 1000;
  const o = $("#pl-v-" + k); if (o && document.activeElement !== o) o.value = fmtv(v);
  changed();
}
function setAmount(v) {
  v = Math.max(0, Math.min(2, v));
  if (Math.abs(v - 1) < 1e-9) delete S.adj.amount; else S.adj.amount = Math.round(v * 100) / 100;
  if (document.activeElement !== $("#pl-amount-v")) $("#pl-amount-v").value = Math.round(v * 100) + "%";
  changed();
}
const fmtv = (v) => (v > 0 ? "+" : "") + (+v).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
function syncControls() {
  $$("#pl-sliders [data-adj]").forEach((i) => { const v = S.adj[i.dataset.adj] || 0; i.value = v; $("#pl-v-" + i.dataset.adj).value = fmtv(v); });
  const look = S.adj.look || "none", a = S.adj.amount ?? 1;
  $$("#pl-looks [data-look]").forEach((b) => b.classList.toggle("on", b.dataset.look === look));
  $("#pl-amount").value = a; $("#pl-amount-v").value = Math.round(a * 100) + "%";
  $("#pl-amtrow").classList.toggle("off", look === "none");
  $("#pl-lookv").textContent = look === "none" ? "" : `${LOOK_NAME(look)} ${Math.round(a * 100)}%`;
  for (const [gk, , rows] of GROUPS) { const n = rows.filter(([k]) => S.adj[k]).length; $("#pl-gv-" + gk).textContent = n ? `${n} set` : ""; }
  syncGeo(); renderMasks();
}
function changed() {
  $("#pl-f-look").textContent = LOOK_NAME(S.adj.look || "none") + (Object.keys(S.adj).some((k) => k !== "look" && k !== "amount") ? " + adjustments" : "");
  syncLookLabel(); layout(); pump();
}
function syncLookLabel() { const look = S.adj.look || "none"; $("#pl-lookv").textContent = look === "none" ? "" : `${LOOK_NAME(look)} ${Math.round((S.adj.amount ?? 1) * 100)}%`; }
function resetKeys(ks, label) {
  if (!ks.some((k) => S.adj[k])) return;
  ks.forEach((k) => delete S.adj[k]); syncControls(); changed(); commit(label);
}
// a committed change is one history step on the server; the stage has already rendered it
let commitQ = Promise.resolve();
function commit(label) {
  const pid = S.cur, adj = { ...S.adj };
  if (!pid) return;
  commitQ = commitQ.then(async () => {
    try { const v = await pm("edit.set", { photo: pid, adj, label }); if (pid === S.cur) showEdit(v, false); markEdited(pid, v); }
    catch (e) { fail(e); }
  });
}
async function step(by) {
  const pid = S.cur; if (!pid || !S.edit) return;
  if (by < 0 ? !S.edit.can_undo : !S.edit.can_redo) return;
  await commitQ;
  try { const v = await pm(by < 0 ? "edit.undo" : "edit.redo", { photo: pid }); if (pid === S.cur) showEdit(v, true); markEdited(pid, v); state(by < 0 ? `undo: ${S.edit.history[v.pos + 1].label}` : `redo: ${v.history[v.pos].label}`); }
  catch (e) { fail(e); }
}
async function goStep(pos) {
  const pid = S.cur; await commitQ;
  try { const v = await pm("edit.go", { photo: pid, pos }); if (pid === S.cur) showEdit(v, true); markEdited(pid, v); } catch (e) { fail(e); }
}
function showEdit(v, apply) {
  S.edit = v;
  if (apply) { S.adj = { ...v.adj }; syncControls(); changed(); }
  $("#pl-undo").disabled = !v.can_undo; $("#pl-redo").disabled = !v.can_redo;
  $("#pl-histn").textContent = v.steps > 1 ? `${v.pos} of ${v.steps - 1}` : "";
  const h = v.history;
  $("#pl-steps").innerHTML = h.map((s, i) => `<button class="pl-stp ${i === v.pos ? "on" : ""} ${i > v.pos ? "ahead" : ""}" data-pos="${i}"><span>${esc(s.label)}</span><small>${s.t ? fmt.ago(s.t) : ""}</small></button>`).reverse().join("");
  $$("#pl-steps [data-pos]").forEach((b) => b.onclick = () => goStep(+b.dataset.pos));
  renderRate();
}
function markEdited(pid, v) {
  const p = S.photos.find((x) => x.id === pid); if (!p) return;
  p.edited = v.edited; p.flag = v.flag; p.stars = v.stars;
  const t = $(`#pl-grid [data-id="${pid}"]`); if (t) t.outerHTML = thumb(p, (S.results || []).find((r) => r.id === pid)), bindGrid();
}

// ---------------------------------------------------------------- culling: flags and stars
async function rate(ch, advance) {
  const pid = S.cur; if (!pid) return;
  try {
    const v = await pm("rate", { photo: pid, ...ch });
    if (pid === S.cur) { S.edit = { ...S.edit, flag: v.flag, stars: v.stars }; renderRate(); }
    markEdited(pid, v);
    state(ch.flag ? { pick: "picked", reject: "rejected", none: "no flag" }[ch.flag] : `${ch.stars} star${ch.stars === 1 ? "" : "s"}`);
    if (advance) nav(1);
  } catch (e) { fail(e); }
}
function renderRate() {
  const e = S.edit || {}, el = $("#pl-rate"); if (!el) return;
  el.innerHTML = `${[1, 2, 3, 4, 5].map((n) => `<button data-st="${n}" class="${n <= (e.stars || 0) ? "on" : ""}" title="${n} star${n > 1 ? "s" : ""} (${n})">★</button>`).join("")}
    <button data-fl="pick" class="fl ${e.flag === 1 ? "pick" : ""}" title="Pick (P)">Pick</button><button data-fl="reject" class="fl ${e.flag === -1 ? "rej" : ""}" title="Reject (X): hidden from exports of picks; nothing is deleted">Reject</button>`;
  $$("#pl-rate [data-st]").forEach((b) => b.onclick = () => rate({ stars: +b.dataset.st === e.stars ? 0 : +b.dataset.st }));
  $$("#pl-rate [data-fl]").forEach((b) => b.onclick = () => rate({ flag: (b.dataset.fl === "pick" ? e.flag === 1 : e.flag === -1) ? "none" : b.dataset.fl }));
}
function visible() {
  const byId = new Map(S.photos.map((p) => [p.id, p]));
  const base = S.results ? S.results.map((r) => byId.get(r.id)).filter(Boolean) : S.photos;
  const f = { all: () => true, picks: (p) => p.flag === 1, rated: (p) => (p.stars || 0) > 0, edited: (p) => p.edited, rejected: (p) => p.flag === -1 }[S.filter];
  return base.filter(f);
}
function nav(by) {
  const list = visible(), i = list.findIndex((p) => p.id === S.cur);
  const n = list[Math.max(0, Math.min(list.length - 1, i + by))];
  if (n && n.id !== S.cur) { pick(n.id); const t = $(`#pl-grid [data-id="${n.id}"]`); if (t) t.scrollIntoView({ block: "nearest" }); }
}
function setFilter(f) { S.filter = f; $$("#pl-filter [data-f]").forEach((b) => b.classList.toggle("on", b.dataset.f === f)); renderGrid(); }

// ---------------------------------------------------------------- library
async function reload(selectId) {
  try { S.photos = await api.get("/photos"); } catch (e) { fail(e); return; }
  $("#pl-count").textContent = S.photos.length ? `${S.photos.length} photo${S.photos.length > 1 ? "s" : ""}` : "";
  renderGrid();
  const want = selectId || (S.photos.find((p) => p.id === S.cur) ? S.cur : (S.photos[0] && S.photos[0].id));
  if (want && want !== S.cur) pick(want);
  else if (!want) { S.cur = null; photoCredit(null); $("#pl-empty").style.display = ""; $("#pl-name").textContent = "Stage"; $("#pl-dims").textContent = ""; }
}
async function upload(files) {
  files = [...files].filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|tiff?|bmp|gif|heic|heif|avif|dng|cr2|nef|arw)$/i.test(f.name));
  if (!files.length) { toast("No photos in that selection", "bad"); return; }
  const ok = [], bad = [], notes = [], t0 = performance.now();
  for (let i = 0; i < files.length; i++) {                 // one photo per request: progress, and one bad file never sinks the rest
    const f = files[i], left = i ? Math.round((performance.now() - t0) / i * (files.length - i) / 1000) : null;
    toast(`Upload ${i + 1} of ${files.length}: ${f.name}${left != null && files.length > 3 ? ` · about ${left < 60 ? left + " s" : Math.round(left / 60) + " min"} left` : ""}`);
    const fd = new FormData(); fd.append("files", f);
    try {
      const r = await (await api.raw("POST", "/photos", fd)).json();
      r.forEach((x) => { if (x.error) bad.push(x.error); else { ok.push(x); if (x.note) notes.push(`${x.name}: ${x.note}`); } });
    } catch (e) { bad.push(`${f.name}: ${e.message}`); }
  }
  if (bad.length) toast(bad.slice(0, 4).join(" · ") + (bad.length > 4 ? ` · and ${bad.length - 4} more` : ""), "bad", 9000);
  if (notes.length) toast(notes.slice(0, 2).join(" · "), "", 7000);
  toast(`${ok.length} of ${files.length} photo${files.length > 1 ? "s" : ""} added in ${Math.round((performance.now() - t0) / 1000)} s`, ok.length ? "good" : "bad");
  await reload(ok.length ? ok[0].id : undefined);
  if (ok.length && S.clip && S.clip.model) indexAll();
}
function pickFolder() {
  const i = document.createElement("input"); i.type = "file"; i.multiple = true; i.webkitdirectory = true;
  i.onchange = () => upload(i.files); i.click();
}
async function remove(id) {
  const p = S.photos.find((x) => x.id === id);
  if (!confirm(`Remove “${p ? p.name : id}” from the library? It goes to the photo trash on the server (data/photos/.trash) and can be put back.`)) return;
  try { await api.del("/photos/" + id); } catch (e) { fail(e); return; }
  if (S.cur === id) { S.cur = null; clearShown(); }
  await reload();
}
async function pick(id) {
  if (S.cur === id) return;
  S.cur = id; S.center = null; S.auto = null; $("#pl-axbox").innerHTML = "";
  if (S.mode) { S.mode = null; $("#pl-stg").classList.remove("tool-crop", "tool-mask"); $("#pl-cropact").hidden = true; $("#pl-crop-go").classList.remove("on"); }
  S.msel = -1; $("#pl-strv").textContent = "";
  S.adj = {}; S.edit = null; S.loading = true; syncControls();
  $$("#pl-grid .pl-th").forEach((t) => t.classList.toggle("on", t.dataset.id === id));
  const p = cur();
  $("#pl-name").textContent = p ? p.name : "Stage";
  $("#pl-dims").textContent = p ? `${p.w} × ${p.h} · ${(p.w * p.h / 1e6).toFixed(1)} MP` : "";
  photoCredit(p);
  $("#pl-empty").style.display = "none";
  // a different photo must never masquerade as this one: show its thumbnail at once, then the real preview
  clearShown(); layout();
  for (const s of ["#pl-after", "#pl-before", "#pl-wb"]) $(s).src = `/api/photos/${id}/thumb`;
  drawClip();
  renderLooks();
  try {
    let v = await pm("edit", { photo: id });
    const old = legacyEdit(id);                                // edits kept by this browser before they moved to the server
    if (!v.edited && v.steps === 1 && old) v = await pm("edit.set", { photo: id, adj: old, label: "Edit kept by this browser" });
    if (id !== S.cur) return;
    S.loading = false; showEdit(v, true);
  } catch (e) { S.loading = false; fail(e); changed(); }
}
function legacyEdit(id) {
  try { const all = JSON.parse(localStorage.getItem("vf.photo.edits") || "{}"), a = all[id]; if (!a) return null; delete all[id]; localStorage.setItem("vf.photo.edits", JSON.stringify(all)); const b = { ...a }; if (b.look === "none") delete b.look; return Object.keys(b).length ? b : null; }
  catch (e) { return null; }
}
const cur = () => S.photos.find((x) => x.id === S.cur);

// ---------------------------------------------------------------- looks (live thumbnails of this photo) + amount
async function loadLooks() {
  try { const r = await pm("look.list"); S.looks = r.values; S.builtin = r.builtin; S.user = r.user; } catch (e) { S.looks = { none: {} }; S.builtin = ["none"]; S.user = []; }
  renderLooks();
}
function renderLooks() {
  const keys = [...S.builtin, ...S.user];
  $("#pl-looks").innerHTML = keys.map((k) => {
    const u = S.cur && lookThumbs.get(S.cur + "|" + k), vals = S.looks[k] || {};
    const tip = k === "none" ? "No look" : Object.entries(vals).map(([s, v]) => `${LABEL[s] || s} ${fmtv(v)}`).join(", ");
    return `<button class="pl-look ${k === (S.adj.look || "none") ? "on" : ""} ${S.user.includes(k) ? "mine" : ""}" data-look="${k}" title="${esc(tip)}${S.user.includes(k) ? " · your look (right-click to delete)" : ""}"><span class="sw">${u ? `<img src="${u}" alt="">` : ""}</span><span class="ln">${esc(LOOK_NAME(k))}</span></button>`;
  }).join("");
  $$("#pl-looks [data-look]").forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.look;
      if (k === (S.adj.look || "none")) return;
      if (k === "none") { delete S.adj.look; delete S.adj.amount; } else { S.adj.look = k; delete S.adj.amount; }
      syncControls(); changed(); commit(k === "none" ? "No look" : `Look: ${LOOK_NAME(k)}`);
    };
    if (S.user.includes(b.dataset.look)) b.oncontextmenu = async (e) => {
      e.preventDefault();
      if (!confirm(`Delete your look “${LOOK_NAME(b.dataset.look)}”? Photos that use it keep their other settings.`)) return;
      try { await pm("look.delete", { name: b.dataset.look }); await loadLooks(); } catch (x) { fail(x); }
    };
  });
}
async function saveLook() {
  if (!S.cur) return;
  const name = prompt("Name for this look (it saves the current settings, so you can use them on any photo):", "");
  if (!name) return;
  try { const r = await pm("look.save", { name, photo: S.cur }); toast(`Look “${LOOK_NAME(r.look)}” saved: ${Object.keys(r.values).length} settings`, "good"); await loadLooks(); }
  catch (e) { fail(e); }
}

// ---------------------------------------------------------------- Auto, with its evidence and score
async function auto() {
  const pid = S.cur; if (!pid) return;
  const b = $("#pl-ax"); b.disabled = true; state("the card measures the photo…");
  await commitQ;
  try {
    const r = await pm("auto", { photo: pid, apply: true });
    if (pid !== S.cur) return;
    S.auto = r; showEdit(r.edit, true); renderAuto();
    state("");
  } catch (e) { fail(e); state(""); }
  b.disabled = false;
}
function renderAuto() {
  const r = S.auto, el = $("#pl-axbox"); if (!r) { el.innerHTML = ""; return; }
  const e = r.error, best = Math.max(e.original.total, e.auto.total, e.levels_stretch.total) || 1;
  const bar = (k, l) => `<div class="pl-ab"><span>${l}</span><i style="width:${Math.max(2, e[k].total / best * 100)}%"></i><b>${e[k].total.toFixed(3)}</b></div>`;
  el.innerHTML = `<div class="pl-ax"><div class="pl-ah"><b>Auto</b> set ${r.why.filter((w) => w.slider).length} slider${r.why.length === 1 ? "" : "s"} <button class="iconbtn" id="pl-axx" title="Close">${icon("x")}</button></div>
    <ul>${r.why.map((w) => `<li>${w.slider ? `<b>${esc(LABEL[w.slider] || w.slider)} ${fmtv(w.value)}</b> · ` : ""}${esc(w.because)}</li>`).join("")}</ul>
    <div class="pl-asc"><div class="pl-ast">Distance to the targets (lower is closer)</div>${bar("original", "Original")}${bar("levels_stretch", "Levels stretch")}${bar("auto", "Auto")}</div>
    <div class="hint">Targets: black point ${r.targets.p1}, white point ${r.targets.p99}, median brightness ${r.targets.median_lo}–${r.targets.median_hi}, no colour cast in grey areas. They are rules, not taste: compare with the original (\\) and undo if you prefer it.</div></div>`;
  $("#pl-axx").onclick = () => { S.auto = null; renderAuto(); };
}

// ---------------------------------------------------------------- copy / paste / sync
function copySettings() { if (!S.cur) return; S.copied = { from: S.cur, adj: { ...S.adj } }; toast(`Settings copied (${Object.keys(S.adj).length} values)`, "good"); }
async function pasteHere(groups) {
  if (!S.copied || !S.cur) { toast("Copy settings first (Ctrl+Shift+C)", "bad"); return; }
  if (S.copied.from === S.cur && !groups) return;
  try {
    await commitQ;
    const r = await pm("edit.paste", { source: S.copied.from, photos: [S.cur], groups: groups || [] });
    if (r.pasted) { const v = await pm("edit", { photo: S.cur }); showEdit(v, true); markEdited(S.cur, v); }
  } catch (e) { fail(e); }
}
async function pasteMany(ids, what) {
  if (!S.copied) { copySettings(); }
  const src = S.copied.from, to = ids.filter((x) => x !== src);
  if (!to.length) { toast("No other photos to paste to", "bad"); return; }
  if (!confirm(`Paste these settings to ${to.length} ${what}? Each gets a “Pasted” history step, so Undo on that photo brings back its own edit.`)) return;
  try { await commitQ; const r = await pm("edit.paste", { source: src, photos: to }); toast(`Pasted to ${r.pasted} photos`, "good"); await reload(); } catch (e) { fail(e); }
}
function copyMenu(anchor) {
  const picks = S.photos.filter((p) => p.flag === 1).map((p) => p.id), res = (S.results || []).map((r) => r.id);
  const grp = (g, l) => ({ icon: "filter", label: `Paste only ${l}`, sub: S.copied ? `from ${(S.photos.find((p) => p.id === S.copied.from) || {}).name || "the copied photo"}` : "copy first", disabled: !S.copied, run: () => pasteHere([g]) });
  menu(anchor, [
    { icon: "plus", label: "Copy settings", sub: "Ctrl+Shift+C", run: copySettings },
    { icon: "down", label: "Paste settings", sub: S.copied ? "Ctrl+Shift+V · all but the crop and masks" : "copy first", disabled: !S.copied, run: () => pasteHere() },
    grp("light", "light"), grp("colour", "colour"), grp("look", "the look"), grp("geometry", "the crop and rotation"), grp("masks", "the masks"), "-",
    { icon: "photo", label: `Paste this photo's settings to the picks (${picks.length})`, sub: "flag photos with P first", disabled: !picks.length, run: () => { copySettings(); pasteMany(picks, "picked photos"); } },
    { icon: "eye", label: `… to the search results (${res.length})`, disabled: !res.length, run: () => { copySettings(); pasteMany(res, "photos in the search results"); } },
    { icon: "photo", label: `… to every photo (${S.photos.length})`, run: () => { copySettings(); pasteMany(S.photos.map((p) => p.id), "photos"); } },
  ]);
}

// ---------------------------------------------------------------- views / zoom / pan / hold / wipe
function setView(v) {
  S.view = v;
  $$("#pl-view [data-v]").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  const st = $("#pl-stg"); st.classList.remove("result", "side", "wipe"); st.classList.add(v);
  if (v === "side") setBefore(false);
  layout(); pump();
}
function setBefore(on) { S.before = on; $("#pl-stg").classList.toggle("orig", on); state(on ? "showing the original (\\ to go back)" : ""); }
function setZoom(z) {
  S.zoom = z;
  $$("#pl-zoom [data-z]").forEach((b) => b.classList.toggle("on", b.dataset.z === z));
  $("#pl-stg").classList.toggle("one", z === "1");
  const f = fdim(); if (f && !S.center) S.center = { x: f.w / 2, y: f.h / 2 };
  clearShown(); layout(); pump();
}
function setClip(on) { S.clipOn = on; $("#pl-clipb").classList.toggle("on", on); $("#pl-stg").classList.toggle("clipon", on); drawClip(); }
function setWipe(x) { S.wipe = clamp(x, 0, 100); $("#pl-f-after .pl-box").style.setProperty("--wipe", S.wipe + "%"); }
function frames() { return S.view === "side" ? ["before", "after"] : S.view === "wipe" ? ["after", "before"] : ["after"]; }
// Geometry is computed, not left to CSS: each frame's box is the photo contain-fitted to its cell (never upscaled past
// native pixels); side by side picks columns or rows, whichever shows the photo larger on this stage.
const fitIn = (w, h, a) => (w / h > a ? { w: h * a, h } : { w, h: w / a });
function geom() {
  const st = $("#pl-stg"), p = cur(), pad = 14, gap = 10;
  const W = Math.max(50, st.clientWidth - pad * 2), H = Math.max(50, st.clientHeight - pad * 2);
  const f = fdim(), a = f ? f.w / f.h : 1.5;
  if (S.view !== "side") return { stack: false, fw: W, fh: H, a };
  const side = fitIn((W - gap) / 2, H, a), stk = fitIn(W, (H - gap) / 2, a);
  return side.w * side.h >= stk.w * stk.h ? { stack: false, fw: (W - gap) / 2, fh: H, a } : { stack: true, fw: W, fh: (H - gap) / 2, a };
}
let BOX = { w: 1, h: 1 };
function layout() {
  const p = cur(), st = $("#pl-stg"); if (!p || !st.clientWidth) return;
  const g = geom(), dpr = Math.min(window.devicePixelRatio || 1, 2), f = fdim();
  st.classList.toggle("stack", g.stack);
  let box;
  if (S.zoom === "1") box = { w: Math.min(g.fw, f.w / dpr), h: Math.min(g.fh, f.h / dpr) };
  else { box = fitIn(g.fw, g.fh, g.a); const k = Math.min(1, (f.w / dpr) / box.w); box = { w: box.w * k, h: box.h * k }; }
  BOX = box;
  $$("#pl-stg .pl-box").forEach((b) => { b.style.width = Math.floor(box.w) + "px"; b.style.height = Math.floor(box.h) + "px"; });
  setWipe(S.wipe);
  drawTools();
}
function stagePointer() {
  const st = $("#pl-stg");
  st.addEventListener("pointerdown", (e) => {
    if (!S.cur || e.button !== 0 || e.target.closest("#pl-tools")) return;
    const box = e.target.closest(".pl-box"); if (!box) return;
    if (S.view === "wipe" && S.zoom !== "1") {             // drag the wipe line (anywhere on the photo)
      const r = box.getBoundingClientRect(); setWipe((e.clientX - r.left) / r.width * 100);
      panning = { wipe: r }; st.setPointerCapture(e.pointerId); return;
    }
    if (S.zoom === "1") { panning = { x: e.clientX, y: e.clientY, cx: S.center.x, cy: S.center.y }; st.setPointerCapture(e.pointerId); st.classList.add("grabbing"); return; }
    if (S.view === "result") { holdT = setTimeout(() => st.classList.add("holding"), 120); st.setPointerCapture(e.pointerId); }
  });
  st.addEventListener("pointermove", (e) => {
    if (!panning) return;
    if (panning.wipe) { setWipe((e.clientX - panning.wipe.left) / panning.wipe.width * 100); return; }
    const dx = e.clientX - panning.x, dy = e.clientY - panning.y;
    $$("#pl-stg .pl-box > img, #pl-clipcv").forEach((im) => im.style.transform = `translate(${dx}px, ${dy}px)`);
    panning.dx = dx; panning.dy = dy;
  });
  const end = () => {
    clearTimeout(holdT); st.classList.remove("holding");
    if (!panning) return;
    if (!panning.wipe) {
      const f = fdim(), dpr = window.devicePixelRatio || 1;
      S.center = { x: clamp(panning.cx - (panning.dx || 0) * dpr, 0, f.w), y: clamp(panning.cy - (panning.dy || 0) * dpr, 0, f.h) };
      st.classList.remove("grabbing");
    }
    panning = null; pump();
  };
  st.addEventListener("pointerup", end); st.addEventListener("pointercancel", end);
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------------------------------------------------------------- the render scheduler
function request(which) {
  const p = cur(); if (!p) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2), box = BOX;
  const adj = viewAdj(which);
  const draft = S.drag && which !== "before", f = fdim();
  let body;
  if (S.zoom === "1") {
    const cw = Math.min(f.w, Math.round(box.w * dpr)), ch = Math.min(f.h, Math.round(box.h * dpr));
    const c = S.center || { x: f.w / 2, y: f.h / 2 };
    body = { adj: { ...adj, _crop: [Math.round(c.x - cw / 2), Math.round(c.y - ch / 2), cw, ch] }, max: 0 };
  } else {
    const a = f.w / f.h, dispW = Math.min(box.w, box.h * a), dispH = dispW / a;
    let side = Math.ceil(Math.max(dispW, dispH) * dpr / 256) * 256;
    side = clamp(side, 512, 2560);
    if (draft) side = clamp(Math.round(side / 2 / 128) * 128, 384, 1024);   // while a slider moves: half size, fast
    side = Math.min(side, Math.max(f.w, f.h));                        // small photos: native size, no upscaling
    body = { adj, max: side };
    if (draft) body.draft = true;
  }
  return { pid: p.id, which, draft, key: p.id + "|" + which + "|" + JSON.stringify(body), body };
}
function nextTask() {
  if (!S.cur || S.loading) return null;
  for (const w of frames()) { const r = request(w); if (r && (!shown[w] || shown[w].key !== r.key)) return r; }
  if (S.drag) return null;
  const r = S.mode ? null : request("before"); if (r && (!shown.before || shown.before.key !== r.key)) return { ...r, prefetch: true };
  for (const k of [...S.builtin, ...S.user]) if (!lookThumbs.has(S.cur + "|" + k)) return { pid: S.cur, which: "look", look: k, key: S.cur + "|look|" + k, body: { adj: { look: k }, max: 240, draft: true } };
  return null;
}
async function pump() {
  if (inflight || (panning && !panning.wipe)) return;
  const t = nextTask(); if (!t) { if (!S.before) state(""); return; }
  inflight = true;
  if (t.which !== "look" && !t.prefetch) { state(t.draft ? "draft…" : "the card makes the image…"); $("#pl-stg").classList.add("is-busy"); }
  tSent = performance.now();
  try {
    const r = await api.raw("POST", `/photos/${t.pid}/render`, t.body);
    const meta = JSON.parse(r.headers.get("X-Photo") || "{}");
    const url = URL.createObjectURL(await r.blob());
    if (t.which === "look") { lookThumbs.set(t.key.replace("|look|", "|"), url); if (t.pid === S.cur) renderLooks(); }
    else if (t.pid !== S.cur) URL.revokeObjectURL(url);                        // the user has moved on: discard
    else {
      const probe = new Image(); probe.src = url;
      try { await probe.decode(); } catch (e) { /* decode() unsupported or failed: the src swap still works */ }
      if (t.pid !== S.cur) { URL.revokeObjectURL(url); }
      else {
        const old = shown[t.which];
        (t.which === "before" ? ["#pl-before", "#pl-wb"] : ["#pl-after"]).forEach((s) => { const im = $(s); im.src = url; im.style.transform = ""; });
        $("#pl-clipcv").style.transform = "";
        shown[t.which] = { url, key: t.key };
        if (old && old.url) setTimeout(() => URL.revokeObjectURL(old.url), 1500);  // after the swap has painted
        if (t.which === "after") { foot(meta, t.draft, performance.now() - tSent); hist(meta); drawClip(); }
      }
    }
  } catch (e) {
    if (t.which !== "look") { state("render failed — " + (e.message || e).toString().slice(0, 120)); toast(e.message || String(e), "bad", 6000); }
    else lookThumbs.set(t.key.replace("|look|", "|"), "");                     // don't retry thumbnails forever
    inflight = false; $("#pl-stg").classList.remove("is-busy");
    return;                                                                   // keep the last good image on screen
  }
  inflight = false; $("#pl-stg").classList.remove("is-busy");
  pump();
}
function clearShown() {
  for (const k of ["after", "before"]) { if (shown[k] && shown[k].url) { const u = shown[k].url; setTimeout(() => URL.revokeObjectURL(u), 1500); } shown[k] = null; }
}
function state(s) { $("#pl-f-state").textContent = s; }
function foot(m, draft, rt) {
  const p = cur();
  $("#pl-f-dim").innerHTML = m.crop ? `<b>1:1</b> ${m.crop[2]}×${m.crop[3]} at ${m.crop[0]},${m.crop[1]} of ${m.src_w}×${m.src_h}` : `${draft ? "draft" : "preview"} <b>${m.w}×${m.h}</b> of ${m.geom ? m.geom.frame.join("×") : p ? p.w + "×" + p.h : ""}${m.geom && (m.geom.frame[0] !== m.src_w || m.geom.frame[1] !== m.src_h) ? ` (cropped from ${m.src_w}×${m.src_h})` : ""}`;
  $("#pl-f-ms").textContent = `card ${fmt.ms(m.ms)} · on screen ${fmt.ms(rt)}`;
  $("#pl-f-ms").title = `GPU work ${m.ms} ms, JPEG encode ${m.encode_ms} ms, request to decoded picture ${Math.round(rt)} ms`;
}
function hist(m) {
  const h = m.hist, cv = $("#pl-hist"); if (!cv || !h) return;
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, H = cv.clientHeight;
  cv.width = w * dpr; cv.height = H * dpr;
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, H);
  const mx = Math.max(1, ...h.flat().slice(1, -1)) * 1.05;
  g.globalCompositeOperation = "lighter";
  ["rgba(255,60,50,.75)", "rgba(60,220,110,.6)", "rgba(70,140,255,.7)"].forEach((col, c) => {
    g.beginPath(); g.moveTo(0, H);
    h[c].forEach((v, i) => g.lineTo(i / (h[c].length - 1) * w, H - Math.min(1, v / mx) * (H - 2)));
    g.lineTo(w, H); g.closePath(); g.fillStyle = col; g.fill();
  });
  g.globalCompositeOperation = "source-over";
  const c = m.clip || {}, lo = $("#pl-ci-lo"), hi = $("#pl-ci-hi");
  lo.textContent = `${(c.shadows || 0).toFixed(1)}%`; hi.textContent = `${(c.highlights || 0).toFixed(1)}%`;
  lo.classList.toggle("warn", (c.shadows || 0) >= 0.5); hi.classList.toggle("warn", (c.highlights || 0) >= 0.5);
}
// clipped pixels on the result: red where a channel is pure white, blue where the pixel is pure black
function drawClip() {
  const cv = $("#pl-clipcv"), im = $("#pl-after");
  if (!S.clipOn || !im.complete || !im.naturalWidth) { cv.width = cv.height = 0; return; }
  const w = im.naturalWidth, h = im.naturalHeight, o = document.createElement("canvas"); o.width = w; o.height = h;
  const g = o.getContext("2d"); g.drawImage(im, 0, 0);
  const d = g.getImageData(0, 0, w, h), px = d.data;
  for (let i = 0; i < px.length; i += 4) {
    const mx = Math.max(px[i], px[i + 1], px[i + 2]);
    if (mx >= 254) { px[i] = 255; px[i + 1] = 30; px[i + 2] = 30; px[i + 3] = 255; }
    else if (mx <= 2) { px[i] = 40; px[i + 1] = 110; px[i + 2] = 255; px[i + 3] = 255; }
    else px[i + 3] = 0;
  }
  cv.width = w; cv.height = h; cv.getContext("2d").putImageData(d, 0, 0);
}

// ---------------------------------------------------------------- export / batch / duplicates
async function save() {
  const p = cur(); if (!p) return;
  const btn = $("#pl-save"); btn.disabled = true;
  $("#pl-act-hint").textContent = `the card exports ${p.w}×${p.h}…`;
  try {
    await commitQ;
    const r = await api.raw("POST", `/photos/${p.id}/render`, { adj: S.adj, full: true });
    const meta = JSON.parse(r.headers.get("X-Photo") || "{}");
    const blob = await r.blob(), a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = p.name.replace(/\.[^.]+$/, "") + "-vectorfall.jpg"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    $("#pl-act-hint").innerHTML = `${meta.w}×${meta.h} · ${fmt.bytes(blob.size)} · <span class="timing">${fmt.ms(meta.ms)}</span>`;
  } catch (e) { $("#pl-act-hint").textContent = "export failed"; fail(e); }
  btn.disabled = false;
}
function exportMenu(anchor) {
  const n = (f) => S.photos.filter(f).length, res = (S.results || []).map((r) => r.id);
  menu(anchor, [
    { icon: "photo", label: `Picks, each with its own edit (${n((p) => p.flag === 1)})`, sub: "flag photos with P", disabled: !n((p) => p.flag === 1), run: () => batch({ only: "picks", saved: true }, "picked photos") },
    { icon: "photo", label: `Edited photos, each with its own edit (${n((p) => p.edited)})`, disabled: !n((p) => p.edited), run: () => batch({ only: "edited", saved: true }, "edited photos") },
    { icon: "photo", label: `All but the rejects, each with its own edit (${n((p) => p.flag !== -1)})`, run: () => batch({ only: "unrejected", saved: true }, "photos") },
    { icon: "eye", label: `The search results, each with its own edit (${res.length})`, disabled: !res.length, run: () => batch({ ids: res, saved: true }, "photos in the search results") }, "-",
    { icon: "bolt", label: `All photos with these settings (${S.photos.length})`, sub: "the same look and sliders on every photo", run: () => { const a = { ...S.adj }; [...GEO, "masks"].forEach((k) => delete a[k]); batch({ only: "all", adj: a }, "photos with these settings (not the crop or masks)"); } },
  ]);
}
async function batch(o, what) {
  if (!confirm(`Export ${what} at full resolution and download a zip?`)) return;
  const btn = $("#pl-more"), hint = $("#pl-act-hint"), ctl = new AbortController();
  btn.disabled = true;
  try {
    await commitQ;
    const j = await api.post("/photos/batch", o);
    hint.innerHTML = `exporting… <button class="btn ghost xs" id="pl-stopb">${icon("stop")} Stop</button>`;
    $("#pl-stopb").onclick = () => ctl.abort();
    const r = await watchJob(j, (s) => { const m = hint.querySelector("span") || hint.insertBefore(document.createElement("span"), hint.firstChild); m.textContent = `exporting ${s.message || ""} `; }, { signal: ctl.signal });
    const a = document.createElement("a"); a.href = "/api/photos/download/" + r.zip; a.download = r.zip; a.click();
    hint.textContent = `${r.count} exported${r.failed && r.failed.length ? ` · ${r.failed.length} failed` : ""}`;
    if (r.failed && r.failed.length) toast(r.failed.join(" · "), "bad", 8000);
  } catch (e) { hint.textContent = e.cancelled ? "export stopped" : "export failed"; if (!e.cancelled) fail(e); }
  btn.disabled = false;
}
async function dupes() {
  if (S.clip && S.clip.model) return dupesClip();
  const out = $("#pl-dupe-out"); out.innerHTML = `<div class="hint">the card calculates a hash of ${S.photos.length} photos…</div>`;
  try {
    const r = await api.post("/photos/similar", {});
    out.innerHTML = r.length ? `<div class="hint" style="margin-bottom:6px">Perceptual hash: 256 bits per photo; 0 = the same picture, about 128 = unrelated.</div><div class="list">${r.slice(0, 30).map((p) => `<div class="li pl-pair" data-a="${p.a}"><img src="/api/photos/${p.a}/thumb" alt=""><img src="/api/photos/${p.b}/thumb" alt=""><div class="tx"><div class="nm">${esc(p.verdict)}</div><div class="sub">${p.distance} of 256 bits differ</div></div></div>`).join("")}</div>`
      : `<div class="hint">No duplicates or near-copies among ${S.photos.length} photos.</div>`;
    $$("#pl-dupe-out [data-a]").forEach((x) => x.onclick = () => pick(x.dataset.a));
  } catch (e) { out.innerHTML = `<div class="hint">${esc(e.message)}</div>`; }
}

// ---------------------------------------------------------------- the grid; search by content (CLIP on the card)
function thumb(p, r) {
  const stars = p.stars ? `<span class="pl-stars">${"★".repeat(p.stars)}</span>` : "";
  const flag = p.flag === 1 ? `<span class="pl-flag pick" title="Pick">P</span>` : p.flag === -1 ? `<span class="pl-flag rej" title="Rejected">X</span>` : "";
  const tip = r ? (r.lift != null ? ` · similarity ${r.score} · a neutral caption ${r.control} · lift ${r.lift >= 0 ? "+" : ""}${r.lift} · ${r.z} SD above the library` : ` · similarity ${r.score}`) : "";
  return `<div class="pl-th ${S.cur === p.id ? "on" : ""} ${r && r.match === false ? "weak" : ""} ${p.flag === -1 ? "rej" : ""}" data-id="${p.id}" title="${esc(p.name)}${tip}">
      <div class="im"><img src="/api/photos/${p.id}/thumb" loading="lazy" alt="">${flag}${p.edited ? `<span class="pl-ed" title="Edited">●</span>` : ""}${r && r.lift != null ? `<span class="pl-score"><i style="width:${Math.max(3, Math.min(100, (r.lift + 0.02) / 0.08 * 100))}%"></i></span>` : r ? `<span class="pl-score"><i style="width:${Math.max(3, Math.min(100, (r.score - 0.5) * 200))}%"></i></span>` : ""}</div>
      <div class="cap"><span class="nm">${esc(p.name)}</span><span class="dm">${p.w}×${p.h}${stars}</span></div>
      <button class="del" data-del="${p.id}" title="Remove from library">${icon("x")}</button></div>`;
}
function renderGrid() {
  const byId = new Map(S.photos.map((p) => [p.id, p])), rmap = new Map((S.results || []).map((r) => [r.id, r]));
  const list = visible();
  $("#pl-qx").hidden = !S.results;
  const m = S.results && !S.like ? S.results.filter((r) => r.match).length : 0;
  const verdict = S.results && !S.like ? (m ? ` · <b>${S.res.matches}</b> of ${S.res.of} photos beat a caption that says nothing` : ` · <b class="pl-none">probably none of your photos shows this</b> (no photo beats a caption that says nothing)`) : "";
  const head = S.results ? `<div class="pl-rhead"><span>${S.like ? `Most like <b>${esc((byId.get(S.like) || {}).name || "this photo")}</b>` : `Best matches for <b>“${esc(S.q)}”</b>`}${verdict}</span><button class="btn ghost xs" id="pl-teach" title="Use the top matches as labelled examples in the Reservoir Lab">${icon("reservoir")} Teach…</button></div>` : "";
  const none = !list.length && S.photos.length ? `<div class="pl-rhead"><span class="dim">No photos here (${S.filter}). P picks, X rejects, 1-5 rates.</span></div>` : "";
  $("#pl-grid").innerHTML = head + none + list.map((p) => thumb(p, rmap.get(p.id))).join("");
  bindGrid();
  if ($("#pl-teach")) $("#pl-teach").onclick = (e) => teachMenu(e.currentTarget, list);
}
function bindGrid() {
  $$("#pl-grid [data-id]").forEach((t) => t.onclick = (e) => { if (!e.target.closest("[data-del]")) pick(t.dataset.id); });
  $$("#pl-grid [data-del]").forEach((b) => b.onclick = () => remove(b.dataset.del));
}
// the top matches become labelled examples of an image classifier: search "receipt", teach, search "person", teach…
async function teachMenu(anchor, list) {
  let projects = [];
  try { projects = (await api.get("/reservoir/projects")).filter((p) => p.kind === "image"); } catch (e) { /* none */ }
  const send = async (pid) => {
    const n = +prompt("How many of the top matches are real examples? (The Lab adds them in this order.)", String(Math.min(12, list.length)));
    if (!n) return;
    const label = prompt("Label for these photos:", S.q || "");
    if (!label) return;
    try {
      const r = await api.post("/reservoir/from-photos", { ids: list.slice(0, n).map((p) => p.id), label, project: pid || null, name: pid ? null : `Photos: ${label}` });
      toast(`${r.n} photos added as “${label}”`, "good");
      if (confirm("Open the Reservoir Lab project now? (If you want to teach more from here, first add another label.)")) go("reservoir", { p: r.id });
    } catch (e) { fail(e); }
  };
  menu(anchor, [...projects.map((p) => ({ icon: "reservoir", label: p.name, sub: `${p.n} examples · ${p.classes.length} labels — add these to it`, run: () => send(p.id) })),
    ...(projects.length ? ["-"] : []), { icon: "plus", label: "New image project", sub: "start a classifier with these photos as the first label", run: () => send(null) }]);
}
async function clipStatus() {
  try { S.clip = await api.get("/photos/clip/status"); } catch (e) { S.clip = null; }
  const c = S.clip, el = $("#pl-clip"); if (!el) return;
  if (!c) { el.innerHTML = ""; return; }
  if (!c.model) { el.innerHTML = `<span>Search by what is in the photos needs the CLIP model (605 MB, once).</span><button class="btn ghost xs" id="pl-getm">Get the model</button>`; $("#pl-getm").onclick = getModel; return; }
  const st = c.selftest ? (c.selftest.passed ? `<span class="ok" title="OpenAI's example: CLIP.png → “a diagram” ${c.selftest.probs[0]} (published ${c.selftest.reference[0]})">self-test ✓</span>` : `<span class="red">self-test failed</span>`) : "";
  el.innerHTML = c.indexed < c.photos ? `<span>${c.indexed} of ${c.photos} photos searchable</span>${st}<button class="btn ghost xs" id="pl-idx">Look at the rest</button>` : `<span>${c.photos} photos searchable by content</span>${st}`;
  if ($("#pl-idx")) $("#pl-idx").onclick = indexAll;
}
async function getModel() {
  const el = $("#pl-clip"), ctl = new AbortController();
  try {
    const j = await api.post("/photos/clip/install");
    await watchJob({ id: j.job, state: "running" }, (x) => { el.innerHTML = `<span>${esc(x.message || "downloading…")}</span><button class="btn ghost xs" id="pl-getx">${icon("stop")} Stop</button>`; $("#pl-getx").onclick = () => ctl.abort(); }, { signal: ctl.signal });
    el.innerHTML = "<span>the card checks the model against the example that OpenAI published…</span>";
    const t = await api.post("/photos/clip/selftest");
    toast(t.passed ? `CLIP self-test passed: “a diagram” ${t.probs[0]} vs published ${t.reference[0]}` : "CLIP self-test failed", t.passed ? "good" : "bad", 7000);
    await indexAll();
  } catch (e) { if (!e.cancelled) fail(e); clipStatus(); }
}
async function indexAll() {
  const el = $("#pl-clip"), ctl = new AbortController();
  try {
    const j = await api.post("/photos/clip/index");
    await watchJob({ id: j.job, state: "running" }, (x) => { el.innerHTML = `<span>the card examines the photos… ${esc(x.message || "")}</span><button class="btn ghost xs" id="pl-idxx">${icon("stop")} Stop</button>`; $("#pl-idxx").onclick = () => ctl.abort(); }, { signal: ctl.signal });
  } catch (e) { if (!e.cancelled) fail(e); }
  clipStatus();
}
// a search handed in by a link or a command (Photo.Search …)
let pendingQ = null;
function applyQ() { if (pendingQ == null || !$("#pl-q")) return; const q = pendingQ; pendingQ = null; $("#pl-q").value = q; searchWords(q); }
async function searchWords(q) {
  if (!q) { S.results = null; S.q = ""; S.like = null; renderGrid(); return; }
  if (S.clip && S.clip.indexed < S.clip.photos) await indexAll();
  try { const r = await api.get(`/photos/clip/search?q=${encodeURIComponent(q)}&top=60`); S.q = q; S.like = null; S.res = r; S.results = r.results; renderGrid(); }
  catch (e) { fail(e); }
}
async function searchLike(pid) {
  if (S.clip && S.clip.indexed < S.clip.photos) await indexAll();
  try { const r = await api.get(`/photos/clip/like/${pid}?top=60`); S.like = pid; S.q = ""; S.results = [{ id: pid, score: 1 }, ...r.results]; renderGrid(); $("#pl-q").value = ""; }
  catch (e) { fail(e); }
}

async function dupesClip() {
  const out = $("#pl-dupe-out");
  if (S.clip.indexed < S.clip.photos) await indexAll();
  out.innerHTML = `<div class="hint">the card compares each pair of the ${S.photos.length} photos…</div>`;
  try {
    const r = await api.get("/photos/clip/dupes?threshold=0.93");
    out.innerHTML = r.groups.length ? `<div class="hint" style="margin-bottom:6px">${r.groups.length} group${r.groups.length > 1 ? "s" : ""} · ${r.extra} extra cop${r.extra === 1 ? "y" : "ies"}. Alike = CLIP similarity ≥ ${r.threshold}; copy = also the same picture by perceptual hash. Keeper = biggest, then sharpest.</div>` + r.groups.map((g, gi) => `<div class="pl-dg">
        <div class="pl-dgr">${g.members.map((m, k) => `<div class="pl-dm ${k === 0 ? "keep" : m.copy ? "copy" : "alike"}" data-id="${m.id}" title="${esc(m.name)} · ${m.w}×${m.h} · sharpness ${m.sharp}${k ? (m.copy ? " · a copy of the keeper" : " · looks alike but is a different photo: kept") : ""}"><img src="/api/photos/${m.id}/thumb" alt="">${k === 0 ? "<b>keep</b>" : m.copy ? "<b>copy</b>" : "<b class=\"alike\">alike</b>"}</div>`).join("")}</div>
        <div class="pl-dgf"><span class="dim">${g.members.length} photos · ≥${Math.round(g.sim * 100)}% alike · ${g.copies ? `${g.copies} ${g.copies === 1 ? "is a copy" : "are copies"}` : "no copies, only look-alikes"}</span>${g.copies ? `<button class="btn ghost xs" data-rm="${gi}">Remove ${g.copies} cop${g.copies === 1 ? "y" : "ies"}</button>` : ""}</div></div>`).join("")
      : `<div class="hint">No near-duplicates among ${r.of} photos.</div>`;
    $$("#pl-dupe-out [data-id]").forEach((x) => x.onclick = () => pick(x.dataset.id));
    $$("#pl-dupe-out [data-rm]").forEach((b) => b.onclick = async () => {
      const g = r.groups[+b.dataset.rm], drop = g.members.slice(1).filter((m) => m.copy);
      if (!drop.length) return;
      if (!confirm(`Remove ${drop.length} cop${drop.length > 1 ? "ies" : "y"} of “${g.members[0].name}” from the library?\n\n${drop.map((m) => "• " + m.name).join("\n")}\n\nThey go to the photo trash on the server (data/photos/.trash) and can be put back.`)) return;
      for (const m of drop) { try { await api.del("/photos/" + m.id); } catch (e) { fail(e); } }
      await reload(); clipStatus(); dupesClip();
    });
  } catch (e) { out.innerHTML = `<div class="hint">${esc(e.message)}</div>`; }
}

// shipped sample photos: title, author, licence and source (meta.credit, written by app/samples.py)
function photoCredit(p) {
  const el = $("#pl-credit"); if (!el) return;
  const k = p && p.credit;
  el.hidden = !k;
  el.innerHTML = k ? `<b>${esc(k.title)}</b> · ${esc(k.author || "unknown author")} · <a href="${esc(k.licence_url || k.source)}" target="_blank" rel="noopener">${esc(k.licence)}</a> · <a href="${esc(k.source)}" target="_blank" rel="noopener">source</a>` : "";
}

// ---------------------------------------------------------------- crop, rotate, straighten; masks (local adjustments)
// Geometry mirrors media.geometry() so the layout never waits for the server: the canvas is the photo after the
// quarter turns and the flip; crop_box is a rectangle on it in fractions; with a straighten angle, the crop shrinks
// about its centre until no corner leaves the photo. The server does the same and renders; this only draws.
const GEO = ["crop_box", "angle", "turn", "flip"];
const LOCAL = [["exposure", "Exposure"], ["contrast", "Contrast"], ["highlights", "Highlights"], ["shadows", "Shadows"],
  ["warmth", "Temperature"], ["tint", "Tint"], ["saturation", "Saturation"], ["clarity", "Clarity"]];
const ASPECTS = [["free", "Free", 0], ["orig", "Original", -1], ["1:1", "1:1", 1], ["4:5", "4:5", 4 / 5], ["3:2", "3:2", 3 / 2], ["16:9", "16:9", 16 / 9]];
function frameOf(adj, nocrop) {
  const p = cur(); if (!p) return null;
  const turn = (adj.turn || 0) % 4, Wq = turn % 2 ? p.h : p.w, Hq = turn % 2 ? p.w : p.h;
  const r = (adj.angle || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const inside = (x, y) => { const dx = x - Wq / 2, dy = y - Hq / 2, xo = Wq / 2 + c * dx + s * dy, yo = Hq / 2 - s * dx + c * dy; return xo >= -0.5 && xo <= Wq + 0.5 && yo >= -0.5 && yo <= Hq + 0.5; };
  const cb = nocrop ? [0, 0, 1, 1] : (adj.crop_box || [0, 0, 1, 1]);
  let box = [cb[0] * Wq, cb[1] * Hq, cb[2] * Wq, cb[3] * Hq], fitted = false;
  if (!nocrop) {
    let cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
    const hw = (box[2] - box[0]) / 2, hh = (box[3] - box[1]) / 2;
    const ok = (k) => [-1, 1].every((sx) => [-1, 1].every((sy) => inside(cx + sx * hw * k, cy + sy * hh * k)));
    if (!ok(1)) {
      if (!inside(cx, cy)) { cx = Wq / 2; cy = Hq / 2; }
      let lo = 0, hi = 1;
      for (let i = 0; i < 30; i++) { const k = (lo + hi) / 2; if (ok(k)) lo = k; else hi = k; }
      box = [cx - hw * lo, cy - hh * lo, cx + hw * lo, cy + hh * lo]; fitted = true;
    }
  }
  return { Wq, Hq, box, fitted, w: Math.max(1, Math.round(box[2] - box[0])), h: Math.max(1, Math.round(box[3] - box[1])) };
}
const fdim = () => frameOf(S.adj, S.mode === "crop");
function viewAdj(which) {
  const geo = {}; for (const k of GEO) if (S.adj[k] != null) geo[k] = S.adj[k];
  if (S.mode === "crop") { const a = which === "before" ? geo : { ...S.adj }; delete a.crop_box; a._nocrop = true; return a; }
  if (which === "before") return geo;                          // the original's colours, in the same frame
  const a = { ...S.adj };
  if (S.mode === "mask" && S.overlay && (S.adj.masks || [])[S.msel]) a._mask_view = S.msel;
  return a;
}
// canvas fractions <-> pixels on the stage box (the whole canvas in crop mode, the cropped frame otherwise)
function toPx(u, v) {
  const f = fdim(); if (!f) return [0, 0];
  return [(u * f.Wq - f.box[0]) / (f.box[2] - f.box[0]) * BOX.w, (v * f.Hq - f.box[1]) / (f.box[3] - f.box[1]) * BOX.h];
}
function fromPx(x, y) {
  const f = fdim();
  return [(f.box[0] + x / BOX.w * (f.box[2] - f.box[0])) / f.Wq, (f.box[1] + y / BOX.h * (f.box[3] - f.box[1])) / f.Hq];
}
const fmtd = (v) => (v > 0 ? "+" : "") + (+v).toFixed(2).replace(/\.?0+$/, "") + "°";

function toolsSetup() {
  // crop section
  $("#pl-crop-go").onclick = () => setMode(S.mode === "crop" ? null : "crop");
  $("#pl-crop-done").onclick = () => cropDone(true);
  $("#pl-crop-x").onclick = () => cropDone(false);
  $("#pl-aspects").innerHTML = ASPECTS.map(([k, l]) => `<button data-asp="${k}" class="${k === "free" ? "on" : ""}">${l}</button>`).join("") + `<button data-asp="swap" title="Portrait / landscape">⇄</button>`;
  $$("#pl-aspects [data-asp]").forEach((b) => b.onclick = () => setAspect(b.dataset.asp));
  const an = $("#pl-s-angle");
  an.addEventListener("pointerdown", () => { S.drag = true; });
  an.oninput = () => { S.drag = true; setAngle(+an.value, false); };
  an.onchange = () => { S.drag = false; commit(`Straighten ${fmtd(+an.value)}`); };
  an.ondblclick = () => { setAngle(0, false); commit("Straighten 0°"); };
  $("#pl-v-angle").onkeydown = (e) => { if (e.key === "Enter") e.target.blur(); };
  $("#pl-v-angle").onchange = (e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) { setAngle(v, false); commit(`Straighten ${fmtd(v)}`); } };
  $("#pl-autostr").onclick = autoStraighten;
  $("#pl-level").onclick = () => { S.leveling = !S.leveling; $("#pl-level").classList.toggle("on", S.leveling); if (S.leveling && S.mode !== "crop") setMode("crop"); };
  $("#pl-rotl").onclick = () => turn(-1);
  $("#pl-rotr").onclick = () => turn(1);
  $("#pl-flip").onclick = flip;
  $("#pl-crop-reset").onclick = () => { S.crop = [0, 0, 1, 1]; const had = GEO.some((k) => S.adj[k] != null); GEO.forEach((k) => delete S.adj[k]); syncGeo(); changed(); if (had && S.mode !== "crop") commit("Reset crop and rotation"); };
  // masks section
  $("#pl-m-add").onclick = (e) => menu(e.currentTarget, [
    { icon: "trend", label: "Linear gradient", sub: "full effect at the first line, none at the second (a sky, a foreground)", run: () => addMask("linear") },
    { icon: "eye", label: "Radial gradient", sub: "an ellipse, feathered (a face, a subject; invert for a vignette)", run: () => addMask("radial") },
    { icon: "spark", label: "Brush", sub: "paint where the change goes; Alt paints the erase", run: () => addMask("brush") }]);
  $("#pl-m-done").onclick = () => setMode(null);
  $("#pl-m-ov").onclick = () => setOverlay(!S.overlay);
  $("#pl-mlocal").innerHTML = `<div class="fields pl-fields">${LOCAL.map(([k, l]) => `<div class="fld"><label for="pl-ml-${k}">${l}</label><input type="range" class="bi" id="pl-ml-${k}" data-ml="${k}" min="-1" max="1" step="0.01" value="0" title="Double-click to reset"><input class="pl-num" id="pl-mv-${k}" data-mlv="${k}" value="0"></div>`).join("")}
    <div class="fld pl-mrad"><label for="pl-ml-feather">Feather</label><input type="range" id="pl-ml-feather" min="0" max="1" step="0.01" value="0.5"><input class="pl-num" id="pl-mv-feather" value="50%" readonly></div>
    <div class="fld pl-mbr"><label for="pl-ml-size">Brush size</label><input type="range" id="pl-ml-size" min="0.005" max="0.25" step="0.005" value="0.05" title="[ and ] change it"><input class="pl-num" id="pl-mv-size" value="5%" readonly></div>
    <div class="fld pl-mbr"><label for="pl-ml-bf">Brush feather</label><input type="range" id="pl-ml-bf" min="0" max="1" step="0.05" value="0.5"><input class="pl-num" id="pl-mv-bf" value="50%" readonly></div>
    <div class="pl-mbr pl-mbrm"><div class="seg" id="pl-brmode"><button data-br="paint" class="on">Paint</button><button data-br="erase" title="Or hold Alt while you paint">Erase</button></div></div></div>`;
  $$("#pl-mlocal [data-ml]").forEach((i) => {
    i.addEventListener("pointerdown", () => { S.drag = true; });
    i.oninput = () => { S.drag = true; setLocal(i.dataset.ml, +i.value); };
    i.onchange = () => { S.drag = false; renderMasks(); const m = selMask(); if (m) commit(`${m.name}: ${LOCAL.find((x) => x[0] === i.dataset.ml)[1]} ${fmtv(+i.value)}`); };
    i.ondblclick = () => { setLocal(i.dataset.ml, 0); syncMask(); const m = selMask(); if (m) commit(`${m.name}: ${i.dataset.ml} reset`); };
  });
  $$("#pl-mlocal [data-mlv]").forEach((n) => {
    n.onkeydown = (e) => { if (e.key === "Enter") n.blur(); };
    n.onchange = () => { const v = parseFloat(n.value); const m = selMask(); if (!isNaN(v) && m) { setLocal(n.dataset.mlv, v); renderMasks(); commit(`${m.name}: ${n.dataset.mlv} ${fmtv(v)}`); } };
  });
  const fe = $("#pl-ml-feather");
  fe.addEventListener("pointerdown", () => { S.drag = true; });
  fe.oninput = () => { const m = selMask(); if (!m) return; S.drag = true; m.feather = +fe.value; $("#pl-mv-feather").value = Math.round(fe.value * 100) + "%"; changed(); };
  fe.onchange = () => { S.drag = false; const m = selMask(); if (m) commit(`${m.name}: feather ${Math.round(fe.value * 100)}%`); };
  $("#pl-ml-size").oninput = (e) => { S.brush.r = +e.target.value; $("#pl-mv-size").value = Math.round(S.brush.r * 100) + "%"; };
  $("#pl-ml-bf").oninput = (e) => { S.brush.f = +e.target.value; $("#pl-mv-bf").value = Math.round(S.brush.f * 100) + "%"; };
  $$("#pl-brmode [data-br]").forEach((b) => b.onclick = () => { S.brush.erase = b.dataset.br === "erase"; $$("#pl-brmode [data-br]").forEach((x) => x.classList.toggle("on", x === b)); });
  toolPointer();
}
function setMode(m) {
  if (S.mode === "crop" && m !== "crop") cropDone(true, true);
  S.mode = m;
  if (m) { setView("result"); setBefore(false); if (S.zoom === "1") setZoom("fit"); }
  if (m === "crop") { S.crop = (S.adj.crop_box || [0, 0, 1, 1]).slice(); openSec("geometry"); }
  if (m === "mask") openSec("masks");
  if (m !== "crop") { S.leveling = false; $("#pl-level").classList.remove("on"); }
  $("#pl-stg").classList.toggle("tool-crop", m === "crop"); $("#pl-stg").classList.toggle("tool-mask", m === "mask");
  $("#pl-crop-go").classList.toggle("on", m === "crop");
  $("#pl-cropact").hidden = m !== "crop";
  state(m === "crop" ? "crop: drag the corners · Ctrl-drag or Level to draw a level line · Enter to finish" : m === "mask" ? "masks: drag the handles · O shows the mask" : "");
  clearShown(); layout(); pump(); syncMask();
}
function openSec(k) { const s = $(`.pl-dev .pl-sec[data-sec="${k}"]`); if (s) s.classList.remove("shut"); }
function cropDone(keep, quiet) {
  if (S.mode !== "crop") return;
  const old = JSON.stringify(S.adj.crop_box || [0, 0, 1, 1]), box = S.crop.map((v) => Math.round(v * 10000) / 10000);
  if (keep && JSON.stringify(box) !== old) {
    if (box[0] <= 0 && box[1] <= 0 && box[2] >= 1 && box[3] >= 1) delete S.adj.crop_box; else S.adj.crop_box = box;
    commit("Crop");
  }
  if (!quiet) { S.mode = null; setMode(null); }
}
function setAngle(v, doCommit) {
  v = clamp(Math.round(v * 100) / 100, -45, 45);
  if (!v) delete S.adj.angle; else S.adj.angle = v;
  syncGeo(); changed();
  if (doCommit) commit(`Straighten ${fmtd(v)}`);
}
function syncGeo() {
  const a = S.adj.angle || 0;
  $("#pl-s-angle").value = a; if (document.activeElement !== $("#pl-v-angle")) $("#pl-v-angle").value = fmtd(a);
  const f = frameOf(S.adj, false);
  $("#pl-geov").textContent = f && (S.adj.crop_box || S.adj.angle || S.adj.turn || S.adj.flip) ? `${f.w}×${f.h}${S.adj.angle ? " · " + fmtd(a) : ""}` : "";
}
// a quarter turn or a mirror moves the crop and the masks with the photo
function mapPoint(fn) {
  const tx = (m) => {
    const o = { ...m };
    if (m.type === "linear") { [o.x0, o.y0] = fn(m.x0, m.y0); [o.x1, o.y1] = fn(m.x1, m.y1); }
    else if (m.type === "radial") { [o.x, o.y] = fn(m.x, m.y); if (fn.swap) [o.rx, o.ry] = [m.ry, m.rx]; }
    else o.dabs = (m.dabs || []).map((d) => { const [x, y] = fn(d[0], d[1]); return [x, y, d[2], d[3], d[4]]; });
    return o;
  };
  if (S.adj.masks) S.adj.masks = S.adj.masks.map(tx);
  const b = S.adj.crop_box;
  if (b) { const [a0, a1] = fn(b[0], b[1]), [c0, c1] = fn(b[2], b[3]); S.adj.crop_box = [Math.min(a0, c0), Math.min(a1, c1), Math.max(a0, c0), Math.max(a1, c1)]; }
}
function turn(dir) {
  const fn = dir > 0 ? (x, y) => [1 - y, x] : (x, y) => [y, 1 - x]; fn.swap = true;
  mapPoint(fn);
  const t = ((S.adj.turn || 0) + (dir > 0 ? 1 : 3)) % 4; if (t) S.adj.turn = t; else delete S.adj.turn;
  if (S.mode === "crop") S.crop = (S.adj.crop_box || [0, 0, 1, 1]).slice();
  syncGeo(); clearShown(); layout(); changed(); commit(dir > 0 ? "Rotate right" : "Rotate left");
}
function flip() {
  mapPoint((x, y) => [1 - x, y]);
  if (S.adj.flip) delete S.adj.flip; else S.adj.flip = true;
  if (S.adj.angle) S.adj.angle = -S.adj.angle;
  if (S.mode === "crop") S.crop = (S.adj.crop_box || [0, 0, 1, 1]).slice();
  syncGeo(); changed(); commit("Flip");
}
function setAspect(k) {
  const f = frameOf(S.adj, true); if (!f) return;
  if (k === "swap") { if (!S.aspect) return; S.aspect = 1 / S.aspect; } else {
    const a = ASPECTS.find((x) => x[0] === k)[2];
    S.aspect = a === -1 ? cur().w / cur().h : a || null;
    if (a === -1 && (S.adj.turn || 0) % 2) S.aspect = 1 / S.aspect;
    if (S.aspect && f.Wq < f.Hq && S.aspect > 1 && a !== -1) S.aspect = 1 / S.aspect;   // portrait photo: portrait crop
  }
  $$("#pl-aspects [data-asp]").forEach((b) => b.classList.toggle("on", b.dataset.asp === k || (k === "swap" && b.classList.contains("on") && b.dataset.asp !== "swap")));
  if (S.mode !== "crop") setMode("crop");
  if (!S.aspect) return;
  const [x0, y0, x1, y1] = S.crop, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let w = (x1 - x0) * f.Wq, h = w / S.aspect;                       // keep the width, set the height ...
  if (h > (y1 - y0) * f.Hq) { h = (y1 - y0) * f.Hq; w = h * S.aspect; }  // ... unless it no longer fits
  const hw = w / f.Wq / 2, hh = h / f.Hq / 2;
  S.crop = [clamp(cx - hw, 0, 1 - 2 * hw), clamp(cy - hh, 0, 1 - 2 * hh), 0, 0];
  S.crop[2] = S.crop[0] + 2 * hw; S.crop[3] = S.crop[1] + 2 * hh;
  drawTools();
}
async function autoStraighten() {
  const pid = S.cur; if (!pid) return;
  const out = $("#pl-strv"); out.textContent = "the card looks for straight lines…";
  await commitQ;
  try {
    const r = await pm("straighten", { photo: pid, apply: true });
    if (pid !== S.cur) return;
    out.innerHTML = `<b>${r.clear && r.angle ? fmtd(r.angle) : "No change"}</b> · ${esc(r.sentence)}`;
    if (r.edit) showEdit(r.edit, true);
  } catch (e) { out.textContent = ""; fail(e); }
}

// masks
const selMask = () => (S.adj.masks || [])[S.msel];
function addMask(type) {
  const f = frameOf(S.adj, false); if (!f) return;
  const fx = (x) => (f.box[0] + x * (f.box[2] - f.box[0])) / f.Wq, fy = (y) => (f.box[1] + y * (f.box[3] - f.box[1])) / f.Hq;
  const n = (S.adj.masks || []).length + 1;
  const m = type === "linear" ? { type, name: `Linear ${n}`, x0: fx(0.5), y0: fy(0.2), x1: fx(0.5), y1: fy(0.55), adj: {} }
    : type === "radial" ? { type, name: `Radial ${n}`, x: fx(0.5), y: fy(0.5), rx: 0.25 * (f.box[2] - f.box[0]) / f.Wq, ry: 0.25 * (f.box[3] - f.box[1]) / f.Hq, feather: 0.5, adj: {} }
      : { type, name: `Brush ${n}`, dabs: [], adj: {} };
  S.adj.masks = [...(S.adj.masks || []), m]; S.msel = S.adj.masks.length - 1;
  setMode("mask"); setOverlay(true); renderMasks(); commit(`Add ${m.name}`);
}
function setLocal(k, v) {
  const m = selMask(); if (!m) return;
  m.adj = { ...(m.adj || {}) }; if (Math.abs(v) < 1e-9) delete m.adj[k]; else m.adj[k] = Math.round(v * 1000) / 1000;
  const o = $("#pl-mv-" + k); if (o && document.activeElement !== o) o.value = fmtv(v);
  changed();
}
function setOverlay(on) { S.overlay = on; $("#pl-m-ov").classList.toggle("on", on); if (on && S.mode !== "mask" && (S.adj.masks || []).length) setMode("mask"); else pump(); }
function renderMasks() {
  const ms = S.adj.masks || [];
  if (S.msel >= ms.length) S.msel = ms.length - 1;
  if (S.msel < 0 && ms.length) S.msel = 0;
  $("#pl-mcount").textContent = ms.length ? `${ms.length}` : "";
  $("#pl-mlist").innerHTML = ms.length ? ms.map((m, i) => `<div class="pl-mi ${i === S.msel ? "on" : ""}" data-mi="${i}"><span class="ty">${m.type === "linear" ? "▤" : m.type === "radial" ? "◎" : "✎"}</span><span class="nm">${esc(m.name)}</span>
      <small>${Object.entries(m.adj || {}).map(([k, v]) => `${k.slice(0, 4)} ${fmtv(v)}`).join(" · ") || "no change yet"}</small>
      <button class="iconbtn ${m.invert ? "on" : ""}" data-minv="${i}" title="Invert: change everything outside">⇄</button><button class="iconbtn" data-mdel="${i}" title="Delete this mask">${icon("x")}</button></div>`).join("")
    : `<div class="hint">No masks. A mask changes part of the photo: a gradient for the sky, an ellipse for a face, or a brush.</div>`;
  $$("#pl-mlist [data-mi]").forEach((r) => r.onclick = (e) => { if (e.target.closest("button")) return; S.msel = +r.dataset.mi; if (S.mode !== "mask") setMode("mask"); renderMasks(); syncMask(); pump(); drawTools(); });
  $$("#pl-mlist [data-minv]").forEach((b) => b.onclick = () => { const m = S.adj.masks[+b.dataset.minv]; S.adj.masks = S.adj.masks.map((x) => x === m ? { ...x, invert: !x.invert } : x); if (!S.adj.masks[+b.dataset.minv].invert) delete S.adj.masks[+b.dataset.minv].invert; renderMasks(); changed(); commit(`${m.name}: invert`); });
  $$("#pl-mlist [data-mdel]").forEach((b) => b.onclick = () => { const i = +b.dataset.mdel, m = S.adj.masks[i]; S.adj.masks = S.adj.masks.filter((_, j) => j !== i); if (!S.adj.masks.length) delete S.adj.masks; S.msel = Math.min(S.msel, (S.adj.masks || []).length - 1); renderMasks(); syncMask(); changed(); commit(`Delete ${m.name}`); });
  syncMask();
}
function syncMask() {
  const m = selMask(), box = $("#pl-mlocal");
  box.hidden = !m;
  if (m) {
    $("#pl-mname").textContent = m.name;
    for (const [k] of LOCAL) { const v = (m.adj || {})[k] || 0; $("#pl-ml-" + k).value = v; if (document.activeElement !== $("#pl-mv-" + k)) $("#pl-mv-" + k).value = fmtv(v); }
    $$(".pl-mrad").forEach((x) => x.hidden = m.type !== "radial");
    $$(".pl-mbr").forEach((x) => x.hidden = m.type !== "brush");
    if (m.type === "radial") { $("#pl-ml-feather").value = m.feather ?? 0.5; $("#pl-mv-feather").value = Math.round((m.feather ?? 0.5) * 100) + "%"; }
  } else $("#pl-mname").textContent = "";
  drawTools();
}

// the stage overlay: the crop rectangle with its thirds, or the selected mask's handles, or the brush
function drawTools() {
  const el = $("#pl-tools"); if (!el) return;
  if (!S.cur || !S.mode) { el.innerHTML = ""; el.className = ""; return; }
  el.className = "on " + S.mode;
  const W = BOX.w, H = BOX.h;
  if (S.mode === "crop") {
    const [x0, y0, x1, y1] = S.crop, L = x0 * W, T = y0 * H, w = (x1 - x0) * W, h = (y1 - y0) * H;
    const fit = frameOf({ ...S.adj, crop_box: S.crop }, false), b = fit.box;
    const fitted = fit.fitted ? `<div class="pl-cfit" style="left:${b[0] / fit.Wq * W}px;top:${b[1] / fit.Hq * H}px;width:${(b[2] - b[0]) / fit.Wq * W}px;height:${(b[3] - b[1]) / fit.Hq * H}px" title="After the straighten, this part stays inside the photo"></div>` : "";
    el.innerHTML = `<div class="pl-crect" style="left:${L}px;top:${T}px;width:${w}px;height:${h}px" data-h="move">
      <i class="g v1"></i><i class="g v2"></i><i class="g h1"></i><i class="g h2"></i>
      ${["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((k) => `<b class="hd ${k}" data-h="${k}"></b>`).join("")}
      <span class="pl-cdim">${fit.w} × ${fit.h}${fit.fitted ? " (inside the photo)" : ""}</span></div>${fitted}${S.levelLine ? `<svg class="pl-lvl"><line x1="${S.levelLine[0]}" y1="${S.levelLine[1]}" x2="${S.levelLine[2]}" y2="${S.levelLine[3]}"/></svg>` : ""}`;
    return;
  }
  const m = selMask(); if (!m) { el.innerHTML = ""; return; }
  let svg = "";
  if (m.type === "linear") {
    const A = toPx(m.x0, m.y0), B = toPx(m.x1, m.y1), dx = B[0] - A[0], dy = B[1] - A[1], n = Math.hypot(dx, dy) || 1, px = -dy / n * 3000, py = dx / n * 3000;
    const ln = (P, cls) => `<line class="${cls}" x1="${P[0] - px}" y1="${P[1] - py}" x2="${P[0] + px}" y2="${P[1] + py}"/>`;
    const C = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    svg = `${ln(A, "full")}${ln(B, "none")}<line class="axis" x1="${A[0]}" y1="${A[1]}" x2="${B[0]}" y2="${B[1]}"/>
      <circle class="hd" data-h="a" cx="${A[0]}" cy="${A[1]}" r="7"/><circle class="hd" data-h="b" cx="${B[0]}" cy="${B[1]}" r="7"/><circle class="hd c" data-h="move" cx="${C[0]}" cy="${C[1]}" r="8"/>`;
  } else if (m.type === "radial") {
    const C = toPx(m.x, m.y), R = toPx(m.x + m.rx, m.y), D = toPx(m.x, m.y + m.ry), rx = Math.abs(R[0] - C[0]), ry = Math.abs(D[1] - C[1]), f = m.feather ?? 0.5;
    svg = `<ellipse class="full" cx="${C[0]}" cy="${C[1]}" rx="${rx}" ry="${ry}" data-h="move"/><ellipse class="none" cx="${C[0]}" cy="${C[1]}" rx="${rx * (1 - f)}" ry="${ry * (1 - f)}"/>
      <circle class="hd c" data-h="move" cx="${C[0]}" cy="${C[1]}" r="8"/><circle class="hd" data-h="rx" cx="${C[0] + rx}" cy="${C[1]}" r="7"/><circle class="hd" data-h="ry" cx="${C[0]}" cy="${C[1] + ry}" r="7"/>`;
  } else {
    const f = fdim(), r = S.brush.r * f.Wq / (f.box[2] - f.box[0]) * W;
    svg = S.brushAt ? `<circle class="brush" cx="${S.brushAt[0]}" cy="${S.brushAt[1]}" r="${r}"/><circle class="brush in" cx="${S.brushAt[0]}" cy="${S.brushAt[1]}" r="${r * (1 - S.brush.f)}"/>` : "";
  }
  el.innerHTML = `<svg width="${W}" height="${H}">${svg}</svg>`;
}
function toolPointer() {
  const el = $("#pl-tools");
  let drag = null;
  const local = (e) => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !S.mode) return;
    e.preventDefault(); e.stopPropagation();
    const [x, y] = local(e), h = (e.target.dataset && e.target.dataset.h) || null;
    el.setPointerCapture(e.pointerId);
    if (S.mode === "crop") {
      if (S.leveling || e.ctrlKey || !h) { drag = { level: [x, y] }; S.levelLine = [x, y, x, y]; drawTools(); return; }
      drag = { crop: h, x, y, c0: S.crop.slice() }; return;
    }
    const m = selMask(); if (!m) return;
    if (m.type === "brush") { drag = { brush: true, erase: S.brush.erase || e.altKey, last: null }; S.drag = true; paint(x, y, drag); return; }
    drag = { mask: h || "move", x, y, m0: JSON.parse(JSON.stringify(m)) }; S.drag = true;
  });
  el.addEventListener("pointermove", (e) => {
    const [x, y] = local(e);
    if (S.mode === "mask" && selMask() && selMask().type === "brush") { S.brushAt = [x, y]; if (!drag) drawTools(); }
    if (!drag) return;
    if (drag.level) { S.levelLine[2] = x; S.levelLine[3] = y; drawTools(); return; }
    if (drag.crop) { cropDrag(drag, x, y); drawTools(); return; }
    if (drag.brush) { paint(x, y, drag); return; }
    maskDrag(drag, x, y); drawTools(); changed();
  });
  const end = () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.level) {
      const [x1, y1, x2, y2] = S.levelLine; S.levelLine = null;
      if (Math.hypot(x2 - x1, y2 - y1) > 20) {
        let phi = Math.atan2(-(y2 - y1), x2 - x1) * 180 / Math.PI;      // the drawn line's tilt, counter-clockwise
        phi = ((phi + 45) % 90 + 90) % 90 - 45;                          // horizontal or vertical: the nearer one
        setAngle((S.adj.angle || 0) + phi, true);
      }
      drawTools(); return;
    }
    if (d.crop) return;
    S.drag = false;
    const m = selMask();
    if (m) commit(d.brush ? `${m.name}: ${d.erase ? "erase" : "paint"}` : `${m.name}: move`);
    pump();
  };
  el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end);
  el.addEventListener("pointerleave", () => { S.brushAt = null; if (!drag) drawTools(); });
}
function cropDrag(d, x, y) {
  const f = frameOf(S.adj, true), dx = (x - d.x) / BOX.w, dy = (y - d.y) / BOX.h;
  let [x0, y0, x1, y1] = d.c0;
  const min = 0.04;
  if (d.crop === "move") {
    const w = x1 - x0, h = y1 - y0;
    x0 = clamp(x0 + dx, 0, 1 - w); y0 = clamp(y0 + dy, 0, 1 - h); x1 = x0 + w; y1 = y0 + h;
  } else {
    if (d.crop.includes("w")) x0 = clamp(x0 + dx, 0, x1 - min);
    if (d.crop.includes("e")) x1 = clamp(x1 + dx, x0 + min, 1);
    if (d.crop.includes("n")) y0 = clamp(y0 + dy, 0, y1 - min);
    if (d.crop.includes("s")) y1 = clamp(y1 + dy, y0 + min, 1);
    if (S.aspect) {                                              // keep the shape: the dragged side leads
      const wpx = (x1 - x0) * f.Wq, hpx = (y1 - y0) * f.Hq;
      if (d.crop === "n" || d.crop === "s") { const w = hpx * S.aspect / f.Wq, cx = (x0 + x1) / 2; x0 = clamp(cx - w / 2, 0, 1 - w); x1 = x0 + w; }
      else {
        const h = wpx / S.aspect / f.Hq;
        if (d.crop.includes("n")) y0 = y1 - h; else if (d.crop.includes("s") || d.crop === "e" || d.crop === "w") y1 = y0 + h;
        if (y0 < 0 || y1 > 1) { const k = d.crop.includes("n") ? y1 / (y1 - y0) : (1 - y0) / (y1 - y0); const nh = (y1 - y0) * Math.min(1, k);
          if (d.crop.includes("n")) y0 = y1 - nh; else y1 = y0 + nh; const nw = nh * f.Hq * S.aspect / f.Wq; if (d.crop.includes("w")) x0 = x1 - nw; else x1 = x0 + nw; }
      }
    }
  }
  S.crop = [x0, y0, x1, y1];
}
function maskDrag(d, x, y) {
  const m = selMask(), [u, v] = fromPx(x, y), [u0, v0] = fromPx(d.x, d.y), du = u - u0, dv = v - v0, o = d.m0;
  if (m.type === "linear") {
    if (d.mask === "a") { m.x0 = o.x0 + du; m.y0 = o.y0 + dv; } else if (d.mask === "b") { m.x1 = o.x1 + du; m.y1 = o.y1 + dv; }
    else { m.x0 = o.x0 + du; m.y0 = o.y0 + dv; m.x1 = o.x1 + du; m.y1 = o.y1 + dv; }
  } else if (m.type === "radial") {
    if (d.mask === "rx") m.rx = Math.max(0.005, Math.abs(u - o.x)); else if (d.mask === "ry") m.ry = Math.max(0.005, Math.abs(v - o.y));
    else { m.x = o.x + du; m.y = o.y + dv; }
  }
  S.adj.masks = [...S.adj.masks];
}
function paint(x, y, d) {
  const m = selMask(), [u, v] = fromPx(x, y), f = fdim();
  const step = S.brush.r * 0.3 * f.Wq / f.Hq;
  if (d.last && Math.hypot(u - d.last[0], (v - d.last[1]) * f.Hq / f.Wq) < S.brush.r * 0.3) return;
  m.dabs = [...(m.dabs || []), [Math.round(u * 1e4) / 1e4, Math.round(v * 1e4) / 1e4, S.brush.r, S.brush.f, d.erase ? 1 : 0]];
  d.last = [u, v]; S.brushAt = [x, y]; void step;
  S.adj.masks = [...S.adj.masks]; drawTools(); changed();
}
