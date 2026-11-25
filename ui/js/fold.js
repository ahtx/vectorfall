// Folding panes, for every app at once. Any titled pane in a workspace gets a fold button (or a double-click on its
// header). How it folds depends on where it sits:
//   - stacked in a .col, or sharing its grid column with others  → it shrinks to its header (vertical fold);
//   - alone in a grid column                                        → it becomes a 38px strip with its title turned
//     on its side (horizontal fold), and the other columns take the space.
// A .col whose panes are all folded becomes a strip too. Grid tracks are rewritten from the measured natural layout
// (each open track keeps its share as an fr weight), and again whenever the grid changes size, so the per-app
// container-query layouts still apply. Folds are remembered per browser, per app and pane.
const KEY = "vf.fold";
const STRIP = 38;
let saved = {};
try { saved = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (e) { saved = {}; }
const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) { /* private window */ } };

const BTN = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const isGrid = (el) => !!el && getComputedStyle(el).display.includes("grid");
const viewOf = (p) => (p.closest(".view") || {}).id || "";
function keyOf(p) {
  const t = p.querySelector(":scope > .pane-h > .t");
  return viewOf(p) + ":" + (p.id || (t ? t.textContent.trim().toLowerCase() : ""));
}
const foldable = (p) => !!p.querySelector(":scope > .pane-h > .t") && !p.closest(".vf-sheet") && !p.closest(".sv") && !p.dataset.nofold
  && !(p.closest(".ws") && p.closest(".ws").querySelectorAll(".pane").length < 2);      // never the only pane of an app
const folded = (p) => p.classList.contains("is-fold-v") || p.classList.contains("is-fold-h");

function decorate(p) {
  if (!foldable(p)) return;
  const h = p.querySelector(":scope > .pane-h");
  if (h.querySelector(":scope > .fold-b")) return;        // apps re-render headers in place: decorate each new one
  const first = !p.dataset.fold;
  p.dataset.fold = "1";
  const b = document.createElement("button");
  b.className = "fold-b"; b.type = "button"; b.innerHTML = BTN; b.title = "Fold this panel (or double-click its header)";
  b.onclick = (e) => { e.stopPropagation(); toggle(p); };
  h.appendChild(b);
  h.addEventListener("dblclick", (e) => { if (!e.target.closest("button, input, select, textarea, a, .seg, .tabs")) toggle(p); });
  if (!first) { if (folded(p)) apply(p, true); return; }
  p.addEventListener("click", (e) => { if ((p.classList.contains("is-fold-h") || p.classList.contains("fold-strip")) && !e.target.closest(".fold-b")) { e.preventDefault(); e.stopPropagation(); toggle(p, false); } }, true);
  if (saved[keyOf(p)]) { p.classList.add("is-fold-v"); p.dataset.foldAxis = "v"; restore.add(p); schedule(p.closest(".ws") || p.parentElement); }
}
const restore = new Set();          // remembered folds: their axis is measured in flush(), once stale tracks are cleared

// which way this pane should fold, from the measured layout
function axis(p) {
  const par = p.parentElement;
  if (!isGrid(par)) return "v";
  const r = p.getBoundingClientRect();
  const sib = [...par.children].filter((c) => c !== p && c.offsetParent !== null).map((c) => c.getBoundingClientRect());
  const sharesColumn = sib.some((q) => q.left < r.right - 2 && q.right > r.left + 2);
  const beside = sib.some((q) => q.top < r.bottom - 2 && q.bottom > r.top + 2);      // something to give the width to
  return !sharesColumn && beside ? "h" : "v";
}

function apply(p, on) {
  p.classList.remove("is-fold-v", "is-fold-h");
  if (on) {
    const par = p.parentElement;
    const ax = isGrid(par) ? (p.dataset.foldAxis || axis(p)) : "v";
    p.dataset.foldAxis = ax;
    p.classList.add("is-fold-" + ax);
  }
  const b = p.querySelector(":scope > .pane-h > .fold-b");
  if (b) b.title = on ? "Unfold this panel" : "Fold this panel (or double-click its header)";
  const col = p.parentElement && p.parentElement.classList.contains("col") ? p.parentElement : null;
  if (col) refreshCol(col);
  schedule(p.closest(".ws") || p.parentElement);
}

export function toggle(p, on) {
  const now = on === undefined ? !folded(p) : on;
  if (now) delete p.dataset.foldAxis;
  apply(p, now);
  const k = keyOf(p);
  if (now) saved[k] = 1; else delete saved[k];
  persist();
}
// Unfold the pane that holds el (an app showing a result there calls this).
export function reveal(el) {
  const p = el && el.closest(".pane");
  if (p && folded(p)) toggle(p, false);
  const col = p && p.parentElement && p.parentElement.classList.contains("is-fold-col") ? p.parentElement : null;
  if (col) refreshCol(col);
}

function refreshCol(col) {
  const panes = [...col.children].filter((c) => c.classList.contains("pane"));
  const others = [...col.children].filter((c) => !c.classList.contains("pane"));
  const all = panes.length > 0 && others.length === 0 && panes.every(folded) && isGrid(col.parentElement) && axis(col) === "h";
  col.classList.toggle("is-fold-col", all);
  panes.forEach((c) => c.classList.toggle("fold-strip", all));
  // a column of only fixed-height panes plus folds would leave a void under them: the last open pane takes it
  panes.forEach((c) => c.classList.remove("fold-fill"));
  const open = panes.filter((c) => !folded(c));
  if (!all && !others.length && panes.some(folded) && open.length && open.every((c) => c.classList.contains("fit") || getComputedStyle(c).flexGrow === "0")) open[open.length - 1].classList.add("fold-fill");
}

// ---------------------------------------------------------------- grid tracks
const pending = new Set();
let raf = 0;
function schedule(root) {
  if (!root) return;
  pending.add(root);
  if (!raf) raf = requestAnimationFrame(flush);
}
function flush() {
  raf = 0;
  const roots = [...pending]; pending.clear();
  const grids = new Set();
  roots.forEach((r) => { if (isGrid(r)) grids.add(r); r.querySelectorAll && r.querySelectorAll(".ws, .te-stage, .cols2, .rows").forEach((g) => grids.add(g));
    r.querySelectorAll && r.querySelectorAll(".is-fold-h, .is-fold-v, .is-fold-col, [data-fold-grid]").forEach((c) => {
      if (c.dataset.foldGrid) grids.add(c); else if (isGrid(c.parentElement)) grids.add(c.parentElement); }); });
  // outer grids first, so inner ones measure inside their final size
  restore.forEach((p) => { const col = p.parentElement; if (col && col.classList.contains("col")) refreshCol(col); });
  restore.clear();
  [...grids].sort((a, b) => (a.contains(b) ? -1 : b.contains(a) ? 1 : 0)).forEach(layout);
}

function tracks(str) { return str.split(" ").filter(Boolean).map(parseFloat); }
function spans(list, gap, a, b, origin) {
  // indices of tracks that [a, b] (relative to the grid's content box) overlaps
  const out = []; let x = origin;
  list.forEach((w, i) => { if (a < x + w - 1 && b > x + 1) out.push(i); x += w + gap; });
  return out;
}
function layout(g) {
  if (!g.isConnected || g.offsetParent === null && getComputedStyle(g).position !== "fixed") return;
  const items = [...g.children].filter((c) => c.offsetParent !== null);
  const anyFold = items.some((c) => folded(c) || c.classList.contains("is-fold-col"));
  if (!anyFold && !g.dataset.foldGrid) return;
  g.style.gridTemplateColumns = ""; g.style.gridTemplateRows = "";
  delete g.dataset.foldGrid;
  if (!anyFold) return;
  // the axis follows the layout: a side pane that drops below the others at a narrow width folds the other way
  items.forEach((c) => { if (c.classList.contains("pane") && folded(c)) {
    const ax = axis(c); c.dataset.foldAxis = ax; c.classList.remove("is-fold-v", "is-fold-h"); c.classList.add("is-fold-" + ax); }
    else if (c.classList.contains("col")) refreshCol(c); });
  const cs = getComputedStyle(g), cols = tracks(cs.gridTemplateColumns), rows = tracks(cs.gridTemplateRows);
  const cg = parseFloat(cs.columnGap) || 0, rg = parseFloat(cs.rowGap) || 0;
  const gr = g.getBoundingClientRect(), ox = gr.left + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.borderLeftWidth) || 0),
    oy = gr.top + (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.borderTopWidth) || 0);
  // measure where every item sits with folding switched off (folding only changes track sizes, not placement)
  g.classList.add("fold-measure");
  const place = items.map((c) => {
    const r = c.getBoundingClientRect();
    const h = c.classList.contains("is-fold-h") || c.classList.contains("is-fold-col");
    const v = c.classList.contains("is-fold-v");
    return { h, v, cols: spans(cols, cg, r.left - ox, r.right - ox, 0), rows: spans(rows, rg, r.top - oy, r.bottom - oy, 0) };
  });
  g.classList.remove("fold-measure");
  const colFold = cols.map((_, i) => { const on = place.filter((p) => p.cols.includes(i)); return on.length > 0 && on.every((p) => p.h && p.cols.length === 1); });
  const rowFold = rows.map((_, i) => { const on = place.filter((p) => p.rows.includes(i)); return on.length > 0 && on.every((p) => p.v && p.rows.length === 1); });
  const tpl = (list, fold, size) => list.map((w, i) => fold[i] ? size : `minmax(0, ${Math.max(1, Math.round(w))}fr)`).join(" ");
  if (cols.length > 1 && colFold.some(Boolean) && !colFold.every(Boolean)) { g.style.gridTemplateColumns = tpl(cols, colFold, STRIP + "px"); g.dataset.foldGrid = "1"; }
  if (rows.length > 1 && rowFold.some(Boolean) && !rowFold.every(Boolean)) { g.style.gridTemplateRows = tpl(rows, rowFold, "auto"); g.dataset.foldGrid = "1"; }
}

// ---------------------------------------------------------------- wiring
const ro = new ResizeObserver((es) => es.forEach((e) => { const t = e.target; if (t.querySelector(".is-fold-v, .is-fold-h") || t.dataset.foldGrid) schedule(t); }));
function scan(root) {
  if (!(root instanceof Element)) return;
  const own = root.closest(".pane");
  const panes = [...(own ? [own] : []), ...root.querySelectorAll(".pane")];
  panes.forEach(decorate);
  const ws = root.matches(".ws") ? [root] : [...root.querySelectorAll(".ws")];
  ws.forEach((w) => { if (!w.dataset.foldRo) { w.dataset.foldRo = "1"; ro.observe(w); } });
  // new content in a grid that carries fold tracks (a tab switch re-renders a stage): re-measure it
  const g = root.closest("[data-fold-grid]") || (root.parentElement && root.parentElement.closest("[data-fold-grid]"));
  if (g || root.querySelector("[data-fold-grid]")) schedule(root.closest(".ws") || g || root);
}
export function initFold(main) {
  scan(main);
  new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach(scan))).observe(main, { childList: true, subtree: true });
}
