// Guide: step-by-step lessons plus a searchable reference, for any app (the Console's Guide, generalised).
// guideView(el, { key, lessons, ref, onAct }) renders into el and returns { show(id|index), lookup(key), render() }.
//   lessons: [{ id, title, sum, body: [block, ...] }]
//   ref:     [{ k, t, sig?, d }]  — one entry per term, number or column; d is HTML
// A block is
//   "html"                                   prose
//   { acts: [{ act, label, args, primary }] } a row of buttons; onAct(act, args, button) does the work in the app
//   { csv, title, act?, label? }              a monospace sample with a "Use this" button (act defaults to "csv")
//   { note, tone }                            a callout; tone = "tip" | "warn"
// Inside prose, <a data-ref="key">…</a> jumps to that reference entry, and <a data-lesson="id">…</a> to a lesson.
import { $, $$, esc, icon } from "./core.js";

export function guideView(el, { key, lessons, ref = [], onAct = () => {} }) {
  let mode = "lessons", at = 0, refKey = null, q = "";
  try { const s = JSON.parse(localStorage.getItem("vf-guide-" + key) || "{}"); at = Math.min(lessons.length - 1, Math.max(0, s.at || 0)); } catch (e) { /* fresh */ }
  const keep = () => { try { localStorage.setItem("vf-guide-" + key, JSON.stringify({ at })); } catch (e) { /* storage off */ } };
  el.classList.add("guide");

  const block = (b, i) => {
    if (typeof b === "string") return b;
    if (b.acts) return `<div class="hg-acts">${b.acts.map((a, j) => `<button class="btn ${a.primary ? "" : "ghost"} sm" data-act="${i}:${j}">${a.icon ? icon(a.icon) : ""}${esc(a.label)}</button>`).join("")}</div>`;
    if (b.csv != null) return `<div class="hcode">${b.title ? `<div class="hc-t">${esc(b.title)}</div>` : ""}<pre>${esc(b.csv)}</pre>
      <div class="acts"><button class="btn xs" data-act="${i}:csv">${esc(b.label || "Use this")}</button></div></div>`;
    if (b.note) return `<div class="hg-note ${b.tone || "tip"}">${b.note}</div>`;
    return "";
  };
  function render() {
    const steps = `<div class="hg-steps">${lessons.map((x, i) => `<button class="${mode === "lessons" && i === at ? "on" : ""}${i < at ? " done" : ""}" data-lesson="${i}" title="${esc(x.title)}">${i + 1}</button>`).join("")}
      ${ref.length ? `<span class="sp"></span><button class="hg-refb ${mode === "ref" ? "on" : ""}" data-mode="ref" title="Every term, number and column in one place">${icon("filter")} Reference</button>` : ""}</div>`;
    if (mode === "ref") {
      const hit = (r) => !q || (r.t + " " + r.k + " " + (r.d || "")).toLowerCase().includes(q.toLowerCase());
      el.innerHTML = steps + `<div class="hg-search"><input class="in sm" id="${key}-q" placeholder="Search the reference…" value="${esc(q)}"></div>
        <div class="hg-doc hg-ref">${ref.filter(hit).map((r) => `<div class="hg-entry ${r.k === refKey ? "on" : ""}" data-k="${esc(r.k)}"><h3>${esc(r.t)}</h3>${r.sig ? `<div class="hg-sig">${esc(r.sig)}</div>` : ""}<div>${r.d}</div></div>`).join("") || `<div class="hint">Nothing matches “${esc(q)}”.</div>`}</div>`;
      const qi = $(`#${key}-q`, el);
      qi.oninput = () => { q = qi.value; const pos = qi.selectionStart; render(); const n = $(`#${key}-q`, el); n.focus(); n.setSelectionRange(pos, pos); };
      const cur = refKey && el.querySelector(`.hg-entry[data-k="${CSS.escape(refKey)}"]`);
      if (cur) requestAnimationFrame(() => cur.scrollIntoView({ block: "start" }));
    } else {
      const g = lessons[at];
      el.innerHTML = steps + `<div class="hg-doc">
        <div class="hg-kick">Lesson ${at + 1} of ${lessons.length}</div><h2>${esc(g.title)}</h2>${g.sum ? `<div class="hg-sum">${esc(g.sum)}</div>` : ""}
        ${g.body.map(block).join("")}
        <div class="hg-nav">${at > 0 ? `<button class="btn ghost sm" data-lesson="${at - 1}">← ${esc(lessons[at - 1].title)}</button>` : "<span></span>"}
          ${at < lessons.length - 1 ? `<button class="btn sm" data-lesson="${at + 1}">${esc(lessons[at + 1].title)} →</button>` : `<span class="dim">${ref.length ? "That's the guide — the Reference has every term in one place." : "That's the guide."}</span>`}</div></div>`;
      el.scrollTop = 0;
    }
  }
  el.addEventListener("click", (e) => {
    const t = e.target.closest("[data-lesson],[data-mode],[data-act],[data-ref]"); if (!t || !el.contains(t)) return;
    e.preventDefault();
    if (t.dataset.lesson != null) {
      const i = /^\d+$/.test(t.dataset.lesson) ? +t.dataset.lesson : lessons.findIndex((l) => l.id === t.dataset.lesson);
      if (i >= 0) { mode = "lessons"; at = i; keep(); render(); }
    } else if (t.dataset.mode) { mode = mode === "ref" ? "lessons" : "ref"; render(); }
    else if (t.dataset.ref) api.lookup(t.dataset.ref);
    else if (t.dataset.act) {
      const [i, j] = t.dataset.act.split(":"), b = lessons[at].body[+i];
      if (j === "csv") onAct(b.act || "csv", b, t);
      else { const a = b.acts[+j]; onAct(a.act, a.args, t); }
    }
  });
  const api = {
    render,
    show(id) { const i = typeof id === "number" ? id : lessons.findIndex((l) => l.id === id); if (i >= 0) { mode = "lessons"; at = i; keep(); } render(); },
    lookup(k) { mode = "ref"; refKey = k; q = ""; render(); },
    get lesson() { return lessons[at]; },
  };
  render();
  return api;
}

// A small "?" that opens a guide's reference entry: put helpDot(key) next to a label, then wire with onHelp(root, fn).
export const helpDot = (k) => `<button class="hdot" data-help="${esc(k)}" title="What does this mean?" tabindex="-1">?</button>`;
export function onHelp(root, fn) {
  root.addEventListener("click", (e) => { const b = e.target.closest("[data-help]"); if (b && root.contains(b)) { e.preventDefault(); e.stopPropagation(); fn(b.dataset.help); } });
}
