// Fractals from data: compression labs (images: fractal / PIFS against JPEG; text: LZ77 against gzip, bzip2, xz), the
// text corpus as a chaos game, and a photo's fractal dimension. One layout for all four: a control pane on the left
// (source, sizes, numbers) and a stage on the right with its own views. Nothing scrolls but the lists.
import { $, $$, api, esc, fmt, icon, toast } from "./core.js";

const D = { el: null, tab: "img", view: { img: "compare", txt: "pieces" }, photo: null, start: "noise", mix: "", photos: null, r: null,
            doc: 0, offset: 0, own: "", lz: null, suffix: "", play: null };
export function openData(host, tab) {
  if (tab) D.tab = tab;
  let el = $("#fr-data", host);
  if (!el) { host.insertAdjacentHTML("beforeend", '<div class="fr-globe fr-data" id="fr-data"></div>'); el = $("#fr-data", host); }
  D.el = el; el.hidden = false;
  el.innerHTML = `<div class="fd-top"><b>Fractals from data</b><div class="seg sm" id="fd-tabs">
      <button data-t="img">Image compression</button><button data-t="txt">Text compression</button><button data-t="cgr">Text as a fractal</button><button data-t="dim">Dimension of a photo</button></div>
      <button class="iconbtn" id="fd-x" title="Back to the map (Esc)">${icon("x")}</button></div>
    <div class="fd-main"><aside class="fd-ctl pane" id="fd-ctl"></aside><section class="fd-stage pane"><div class="fd-sh" id="fd-sh"></div><div class="fd-sb" id="fd-sb"></div></section></div>`;
  $$("#fd-tabs [data-t]", el).forEach((b) => b.onclick = () => { stop(); D.tab = b.dataset.t; try { history.replaceState(null, "", "#fractal?lab=" + D.tab); } catch (e) { /* file:// */ } show(); });
  $("#fd-x", el).onclick = () => { stop(); el.hidden = true; };
  if (!D.keys) { D.keys = true; document.addEventListener("keydown", (e) => { if (e.key === "Escape" && D.el && !D.el.hidden) { stop(); D.el.hidden = true; } }); }
  show();
}
const ctl = () => $("#fd-ctl", D.el), sh = () => $("#fd-sh", D.el), sb = () => $("#fd-sb", D.el);
function stop() { if (D.play) { clearInterval(D.play); D.play = null; } }
function show() {
  $$("#fd-tabs [data-t]", D.el).forEach((b) => b.classList.toggle("on", b.dataset.t === D.tab));
  ({ img: imgTab, txt: txtTab, cgr: cgrTab, dim: dimTab })[D.tab]();
}
function seg(views, cur, on) {
  sh().innerHTML = `<div class="seg sm">${views.map(([k, t]) => `<button data-v="${k}" class="${k === cur ? "on" : ""}">${t}</button>`).join("")}</div><div class="dim fd-shnote" id="fd-shnote"></div>`;
  $$("[data-v]", sh()).forEach((b) => b.onclick = () => { stop(); on(b.dataset.v); });
}
function bars(rows, unit, best = "low") {               // horizontal bars, each scaled to the largest
  const mx = Math.max(...rows.map((r) => r.v));
  return `<div class="fd-bars">${rows.map((r) => `<div class="fd-bar ${r.cls || ""}"><span class="l">${esc(r.l)}</span><span class="t"><i style="width:${Math.max(1.5, r.v / mx * 100)}%"></i></span><b>${fmt.n(r.v, unit === " dB" ? 1 : 0)}${unit}${r.x ? ` <span class="dim">${r.x}</span>` : ""}</b></div>`).join("")}</div>`;
}
async function photos() {
  if (!D.photos) { try { const j = await api.get("/photos"); D.photos = (Array.isArray(j) ? j : j.photos || []).slice(0, 48); } catch (e) { D.photos = []; } }
  return D.photos;
}
function strip(sel, onPick) {
  return `<div class="fd-strip">${D.photos.map((p) => `<button class="fd-ph ${p.id === sel ? "on" : ""}" data-id="${p.id}" title="${esc(p.name || "")}"><img src="/api/photos/${p.id}/thumb" alt="" loading="lazy"></button>`).join("")}</div>`;
}

// ================================================================ image compression (PIFS against JPEG)
async function imgTab() {
  await photos();
  if (!D.photo && D.photos.length) D.photo = D.photos[0].id;
  const opt = (v) => D.photos.map((p) => `<option value="${p.id}"${v === p.id ? " selected" : ""}>${esc((p.name || p.id).slice(0, 28))}</option>`).join("");
  ctl().innerHTML = `<div class="sec-t">Photo</div>${strip(D.photo)}
    <div class="fd-row"><label>Decode from</label><select class="in xs" id="fd-start"><option value="noise">noise</option><option value="grey">flat grey</option><optgroup label="another photo">${opt(D.start)}</optgroup></select></div>
    <div class="fd-row"><label>Recombine with</label><select class="in xs" id="fd-mix"><option value="">—</option>${opt(D.mix)}</select></div>
    <div id="fd-nums"><div class="hint">encoding…</div></div>
    <p class="hint fd-what">How it works: every 8×8 block is stored as a <b>shrunk, flipped or turned, brightness- and contrast-adjusted copy of a 16×16 block elsewhere in the same picture</b> (Jacquin 1992). The picture itself is never stored, only these maps. Decoding applies all the maps to <i>any</i> picture, again and again; because every map shrinks things, it settles on one picture.</p>`;
  $$(".fd-ph", ctl()).forEach((b) => b.onclick = () => { D.photo = b.dataset.id; imgTab(); });
  $("#fd-start").value = D.start; $("#fd-start").onchange = (e) => { D.start = e.target.value; runImg(); };
  $("#fd-mix").onchange = (e) => { D.mix = e.target.value; if (D.mix) D.view.img = "mix"; runImg(); };
  runImg();
}
async function runImg() {
  sb().innerHTML = '<div class="hint">searching 1 block in thousands for each of about 700 blocks, on the card…</div>';
  try {
    let r = await fetch("/api/fractal/compress", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ photo: D.photo, start: D.start, mix: D.mix }) }).then((x) => x.json());
    r = r.result || r; if (r.detail) throw new Error(r.detail);
    D.r = r;
    const ratioF = r.raw_bytes / r.fractal_bytes, ratioJ = r.raw_bytes / r.jpeg_bytes;
    $("#fd-nums").innerHTML = `<div class="sec-t">Size <span class="dim">· ${r.w}×${r.h} grey</span></div>${bars([
        { l: "the picture", v: r.raw_bytes, cls: "b-raw" }, { l: "fractal", v: r.fractal_bytes, cls: "b-frac", x: `${ratioF.toFixed(0)}× smaller` },
        { l: "JPEG", v: r.jpeg_bytes, cls: "b-jpg", x: `${ratioJ.toFixed(0)}× smaller` }], " B")}
      <div class="sec-t">Quality <span class="dim">· PSNR, higher is better</span></div>${bars([{ l: "fractal", v: r.fractal_psnr, cls: "b-frac" }, { l: "JPEG", v: r.jpeg_psnr, cls: "b-jpg" }], " dB")}
      <p class="fd-verdict">${r.jpeg_psnr >= r.fractal_psnr ? `At the same size JPEG is <b>${(r.jpeg_psnr - r.fractal_psnr).toFixed(1)} dB</b> better, as published comparisons find.` : `Here fractal is ${(r.fractal_psnr - r.jpeg_psnr).toFixed(1)} dB better, which is unusual.`}</p>
      <p class="dim fd-small">${fmt.n(r.ranges)} blocks × (best of ${fmt.n(r.domains)} candidates) · ${fmt.n(r.fractal_bytes * 8 / r.ranges)} bits per block · ${r.encode_s < 0.2 ? "encoding reused from before" : `encoded in ${r.encode_s} s on the card`}</p>`;
    imgView(D.view.img);
  } catch (e) { sb().innerHTML = `<div class="hint">${esc(e.message)}</div>`; }
}
function imgView(v) {
  D.view.img = v; const r = D.r; if (!r) return;
  seg([["compare", "Compare"], ["replay", "Replay"], ["maps", "The maps"], ["mix", "Recombine"], ["big", "Decode at 4×"]], v, imgView);
  const note = $("#fd-shnote");
  if (v === "compare") {
    note.textContent = "the same picture three ways, at the same size on screen";
    sb().innerHTML = `<div class="fd-three">${[["original", "the picture", `${fmt.n(r.raw_bytes)} bytes`], ["decoded", "fractal", `${fmt.n(r.fractal_bytes)} bytes · ${r.fractal_psnr.toFixed(1)} dB`], ["jpeg", "JPEG", `${fmt.n(r.jpeg_bytes)} bytes · ${r.jpeg_psnr.toFixed(1)} dB`]].map(([k, t, s]) => `<figure><img src="${r[k]}" style="aspect-ratio:${r.w}/${r.h}"><figcaption><b>${t}</b> · ${s}</figcaption></figure>`).join("")}</div>`;
  } else if (v === "replay") {
    note.textContent = `decoding from ${r.start === "noise" ? "noise" : r.start === "grey" ? "flat grey" : "another photo"}: the maps alone rebuild the picture`;
    sb().innerHTML = `<div class="fd-replay"><img id="fd-rimg" src="${r.steps[0]}" style="aspect-ratio:${r.w}/${r.h}"><div class="fd-rctl"><button class="btn sm" id="fd-play">${icon("play")} Play</button>
        <input type="range" id="fd-it" min="0" max="${r.steps.length - 1}" value="0"><span class="mono" id="fd-itl"></span></div><canvas id="fd-pc" width="420" height="120"></canvas></div>`;
    const set = (i) => { $("#fd-rimg").src = r.steps[i]; $("#fd-it").value = i; $("#fd-itl").textContent = i ? `pass ${i} · ${r.psnr_by_iteration[i].toFixed(1)} dB` : `the start · ${r.psnr_by_iteration[0].toFixed(1)} dB`; psnrChart(i); };
    $("#fd-it").oninput = (e) => set(+e.target.value);
    $("#fd-play").onclick = () => { stop(); let i = 0; set(0); D.play = setInterval(() => { i++; if (i >= r.steps.length) { stop(); return; } set(i); }, 450); };
    set(0);
  } else if (v === "maps") {
    note.textContent = "move over the picture: each 8×8 block (yellow) is a copy of the 16×16 block (blue)";
    sb().innerHTML = `<div class="fd-maps"><div class="fd-mw"><img id="fd-mimg" src="${r.original}" style="aspect-ratio:${r.w}/${r.h}"><canvas id="fd-mc"></canvas></div><p class="fd-mapsay" id="fd-mapsay">Move over the picture.</p></div>`;
    const img = $("#fd-mimg"), cv = $("#fd-mc");
    const draw = (bx, by) => {
      const W = img.clientWidth, H = img.clientHeight, k = W / r.w; cv.width = W; cv.height = H; const g = cv.getContext("2d");
      if (bx == null) return;
      const cols = r.w / 8, m = r.maps[by * cols + bx], [dy, dx, iso, s, o] = m;
      g.lineWidth = 2; g.strokeStyle = "#3fa9f5"; g.strokeRect(dx * k, dy * k, 16 * k, 16 * k);
      g.strokeStyle = "#ffd300"; g.strokeRect(bx * 8 * k, by * 8 * k, 8 * k, 8 * k);
      g.strokeStyle = "rgba(255,255,255,.6)"; g.setLineDash([4, 4]); g.beginPath(); g.moveTo((dx + 8) * k, (dy + 8) * k); g.lineTo((bx * 8 + 4) * k, (by * 8 + 4) * k); g.stroke(); g.setLineDash([]);
      $("#fd-mapsay").innerHTML = `This <b style="color:#ffd300">8×8 block</b> = <b>${s.toFixed(2)}</b> × (the <b style="color:#3fa9f5">16×16 block</b>, shrunk and ${esc(r.iso_names[iso])}) ${o >= 0 ? "+" : "−"} <b>${Math.abs(o).toFixed(2)}</b> brightness. That is all that is stored for it.`;
    };
    img.onload = () => draw();
    img.parentElement.onmousemove = (e) => { const b = img.getBoundingClientRect(), k = b.width / r.w; draw(Math.min(r.w / 8 - 1, Math.floor((e.clientX - b.left) / k / 8)), Math.min(r.h / 8 - 1, Math.floor((e.clientY - b.top) / k / 8))); };
  } else if (v === "mix") {
    if (!r.mix) { note.textContent = ""; sb().innerHTML = `<div class="hint">Pick a second photo in “Recombine with” (left). The left half of the blocks keep this photo's maps and the right half take the other photo's. The result is neither picture: it is the one picture that both sets of maps agree on.</div>`; return; }
    note.textContent = "left half of the maps from this photo, right half from the other: decoded from noise";
    sb().innerHTML = `<div class="fd-three">${[["original", "this photo"], ["mix_other", "the other photo"], ["mix", "their maps recombined"]].map(([k, t]) => `<figure><img src="${r[k]}" style="aspect-ratio:${r.w}/${r.h}"><figcaption><b>${t}</b></figcaption></figure>`).join("")}</div>
      <div class="fd-mixsteps">${r.mix_steps.map((s, i) => `<figure><img src="${s}" style="aspect-ratio:${r.w}/${r.h}"><figcaption>pass ${i * 3}</figcaption></figure>`).join("")}</div>
      <p class="hint">The right half's blocks point at domain blocks all over the picture, including the left half, so the two photos' structures mix where they reference each other: a collage that exists only as the fixed point of the combined maps.</p>`;
  } else {
    note.textContent = "the same maps applied at 4× the size: the detail is invented, plausible, not true";
    sb().innerHTML = `<div class="fd-big"><img src="${r.big}" style="aspect-ratio:${r.w}/${r.h}"></div>`;
  }
}
function psnrChart(at) {
  const cv = $("#fd-pc"); if (!cv || !D.r) return; const g = cv.getContext("2d"), P = D.r.psnr_by_iteration, W = cv.width, H = cv.height;
  const lo = Math.min(...P) - 1, hi = Math.max(...P, D.r.jpeg_psnr) + 1, X = (i) => 30 + i / (P.length - 1) * (W - 40), Y = (v) => H - 18 - (v - lo) / (hi - lo) * (H - 30);
  g.fillStyle = "#0b0b0e"; g.fillRect(0, 0, W, H); g.font = "10px 'JetBrains Mono'"; g.fillStyle = "#8a8b93"; g.fillText("PSNR (dB) by pass", 32, 11);
  g.strokeStyle = "rgba(255,176,32,.6)"; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(30, Y(D.r.jpeg_psnr)); g.lineTo(W - 10, Y(D.r.jpeg_psnr)); g.stroke(); g.setLineDash([]); g.fillStyle = "#ffb020"; g.fillText("JPEG", W - 40, Y(D.r.jpeg_psnr) - 4);
  g.strokeStyle = "#ffd300"; g.lineWidth = 2; g.beginPath(); P.forEach((v, i) => (i ? g.lineTo : g.moveTo).call(g, X(i), Y(v))); g.stroke();
  g.fillStyle = "#fff"; g.beginPath(); g.arc(X(at), Y(P[at]), 4, 0, 7); g.fill();
}

// ================================================================ text compression (LZ77)
async function txtTab() {
  ctl().innerHTML = '<div class="hint">reading the corpus…</div>';
  await runTxt();
}
async function runTxt() {
  try {
    let r = await fetch("/api/fractal/lz", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(D.doc < 0 ? { doc: -1, text: D.own } : { doc: D.doc, offset: D.offset }) }).then((x) => x.json());
    r = r.result || r; if (r.detail) throw new Error(r.detail);
    if (r.docs) D.docs = r.docs;
    D.lz = r;
    const doc = D.docs && D.docs[D.doc], S = r.sizes;
    ctl().innerHTML = `<div class="sec-t">Text</div>
      <div class="fd-row"><select class="in xs" id="fd-doc">${(D.docs || []).map((d) => `<option value="${d.i}"${d.i === D.doc ? " selected" : ""}>${esc(d.name)}</option>`).join("")}<option value="-1"${D.doc < 0 ? " selected" : ""}>Your own text…</option></select></div>
      ${D.doc >= 0 && doc ? `<div class="fd-row"><label>Start at</label><input type="range" id="fd-off" min="0" max="${Math.max(0, doc.bytes - 16000)}" step="4000" value="${D.offset}"><span class="mono">${fmt.big(D.offset)}</span></div>` : `<textarea class="in fd-own" id="fd-own" rows="5" placeholder="Paste a text and press Ctrl-Enter">${esc(D.own)}</textarea><button class="btn sm" id="fd-ownb" data-primary>Compress it</button>`}
      <div class="sec-t">Size <span class="dim">· ${fmt.n(S.raw)} bytes of text</span></div>${bars([
        { l: "the text", v: S.raw, cls: "b-raw" }, { l: "LZ77 (this)", v: S.lz77, cls: "b-frac", x: `${(S.raw / S.lz77).toFixed(1)}× smaller` },
        { l: "gzip", v: S.gzip, cls: "b-jpg", x: `${(S.raw / S.gzip).toFixed(1)}× smaller` }, { l: "bzip2", v: S.bzip2, cls: "b-jpg", x: `${(S.raw / S.bzip2).toFixed(1)}× smaller` },
        { l: "xz", v: S.xz, cls: "b-jpg", x: `${(S.raw / S.xz).toFixed(1)}× smaller` }], " B")}
      <p><b>${Math.round(r.share_copied * 100)}%</b> of the text is copies of something earlier: ${fmt.n(r.copies)} copies, the rest ${fmt.n(r.literal_bytes)} single characters.</p>
      <div class="sec-t">Longest copies</div><div class="fd-long">${r.longest.slice(0, 5).map((x) => `<div>“${esc(x.text.slice(0, 70))}${x.text.length > 70 ? "…" : ""}” <span class="dim">${x.length} chars, from ${fmt.n(x.distance)} back</span></div>`).join("")}</div>
      <p class="hint fd-what">How it works (LZ77, the core of zip and gzip): read left to right; whenever the next stretch already appeared earlier, write “go back <i>d</i>, copy <i>n</i>” instead. This is the “find repeats and replace them by pointers” idea. It is exact repetition at the same scale, so it is <b>not fractal</b>: text has no shrunk copies of itself. gzip then Huffman-codes the pointers, which is why it is smaller still.</p>`;
    $("#fd-doc").onchange = (e) => { D.doc = +e.target.value; D.offset = 0; runTxt(); };
    const off = $("#fd-off"); if (off) off.onchange = (e) => { D.offset = +e.target.value; runTxt(); };
    const ob = $("#fd-ownb"); if (ob) ob.onclick = () => { D.own = $("#fd-own").value; runTxt(); };
    txtView(D.view.txt);
  } catch (e) { ctl().innerHTML = `<div class="hint">${esc(e.message)}</div>`; }
}
function txtView(v) {
  D.view.txt = v; const r = D.lz; if (!r) return;
  seg([["pieces", "The pieces"], ["replay", "Replay"]], v, txtView);
  const note = $("#fd-shnote");
  if (v === "pieces") {
    note.textContent = "shaded = copied from earlier (darker = longer) · move over a copy for its source · click a phrase on the right to see every use";
    const P = r.dictionary.phrases;
    sb().innerHTML = `<div class="fd-pcols"><div class="fd-text" id="fd-text">${r.tokens.map((t, i) => t[0] === "L" ? `<span>${esc(r.text.slice(t[1], t[2]))}</span>` : `<span class="cp" data-i="${i}" data-s="${t[1]}" style="--a:${Math.min(1, 0.2 + (t[4] / 40))}">${esc(r.text.slice(t[1], t[2]))}</span>`).join("")}</div>
      <div class="fd-side"><div class="sec-t">Pointer map <span class="dim">· every copy: where it lands (across) and how far back it reaches (up)</span></div><canvas id="fd-pmap" width="340" height="170"></canvas>
        <div class="sec-t">The dictionary <span class="dim">· ${fmt.n(r.dictionary.distinct)} distinct phrases reused · how often each occurs · bytes its copies save</span></div>
        <div class="fd-dict">${P.slice(0, 60).map((p, i) => `<div class="fd-dw" data-i="${i}"><span class="ph">“${esc(p.text.replace(/\s+/g, " "))}”</span><b title="occurs ${p.occurs} times in the passage; copied ${p.uses} times">${p.occurs}×</b><span class="dim" title="bytes saved by its copies">${fmt.n(p.saved)} B</span></div>`).join("")}</div></div></div>
      <div class="fd-tip" id="fd-tip" hidden></div>`;
    pointerMap();
    const box = $("#fd-text"), tip = $("#fd-tip");
    box.onmouseover = (e) => {
      const s = e.target.closest(".cp");
      if (!s) { tip.hidden = true; return; }
      const t = r.tokens[+s.dataset.i];
      tip.hidden = false; tip.innerHTML = `copy of <b>${t[4]}</b> characters from <b>${fmt.n(t[5])}</b> back: “${esc(r.text.slice(t[3], t[3] + Math.min(80, t[2] - t[1])))}”`;
      const sr = sb().getBoundingClientRect(), b = s.getBoundingClientRect(); tip.style.left = Math.max(0, Math.min(sr.width - 380, b.left - sr.left)) + "px"; tip.style.top = (b.bottom - sr.top + sb().scrollTop + 6) + "px";
      pointerMap(t);
    };
    $$(".fd-dw", sb()).forEach((d) => d.onclick = () => {             // every use of a phrase, highlighted in the text
      const p = P[+d.dataset.i], at = new Set(p.at.map(String));
      $$(".fd-dw", sb()).forEach((x) => x.classList.toggle("on", x === d));
      let first = null;
      $$("#fd-text .cp").forEach((c) => { const hit = at.has(c.dataset.s); c.classList.toggle("hl", hit); if (hit && !first) first = c; });
      if (first) first.scrollIntoView({ block: "center" });
    });
  } else {
    note.textContent = "four ways to replay a text: exactly from its pointers, or new text by three kinds of choice";
    D.rmode = D.rmode || "exact";
    sb().innerHTML = `<div class="fd-rctl"><div class="seg sm" id="fd-rmode">${[["exact", "Exact (pointers)"], ["sample", "Sample what follows"], ["twins", "Compression twins"], ["guided", "Compression-guided"]].map(([k, t]) => `<button data-m="${k}" class="${k === D.rmode ? "on" : ""}">${t}</button>`).join("")}</div></div>
      <div id="fd-ropts" class="fd-rctl"></div><div id="fd-rout"></div>`;
    $$("#fd-rmode [data-m]").forEach((b) => b.onclick = () => { stop(); D.rmode = b.dataset.m; txtView("replay"); });
    replayMode(D.rmode);
  }
}
function pointerMap(sel) {
  const cv = $("#fd-pmap"), r = D.lz; if (!cv || !r) return;
  const g = cv.getContext("2d"), W = cv.width, H = cv.height, n = r.text.length, C = r.tokens.filter((t) => t[0] === "C");
  const maxd = Math.log10(Math.max(10, ...C.map((t) => t[5]))), X = (p) => 6 + p / n * (W - 12), Y = (d) => H - 14 - Math.log10(Math.max(1, d)) / maxd * (H - 26);
  g.fillStyle = "#0b0b0e"; g.fillRect(0, 0, W, H); g.font = "10px 'JetBrains Mono'"; g.fillStyle = "#8a8b93"; g.fillText("how far back (log) ↑", 8, 11); g.fillText("position in the text →", W - 140, H - 3);
  C.forEach((t) => { g.fillStyle = `rgba(63,169,245,${Math.min(0.9, 0.15 + t[4] / 40)})`; g.fillRect(X(t[1]), Y(t[5]), Math.max(1.5, (t[2] - t[1]) / n * (W - 12)), 2); });
  if (sel) {                                                         // the hovered copy: an arc from where it lands back to its source
    const x1 = X(sel[1]), x0 = X(sel[3]); g.strokeStyle = "#ffd300"; g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(x1, H - 14); g.quadraticCurveTo((x0 + x1) / 2, Y(sel[5]) - 10, x0, H - 14); g.stroke();
    g.fillStyle = "#ffd300"; g.beginPath(); g.arc(x0, H - 14, 3, 0, 7); g.arc(x1, H - 14, 3, 0, 7); g.fill();
  }
}
function replayMode(m) {
  const O = $("#fd-ropts"), R = $("#fd-rout");
  if (m === "exact") {
    O.innerHTML = `<button class="btn sm" id="fd-tplay">${icon("play")} Replay</button><label class="dim">speed</label><input type="range" id="fd-speed" min="1" max="40" value="10"><span class="mono" id="fd-tl"></span>`;
    R.innerHTML = `<p class="hint">Only the compressed form is used: single characters are typed, and each pointer copies from text that is already rebuilt. Nothing is guessed, so it comes back exactly.</p><div class="fd-text fd-rebuild" id="fd-rb"></div>`;
    $("#fd-tplay").onclick = () => replayText();
  } else if (m === "sample") {
    O.innerHTML = `<button class="btn sm" id="fd-go" data-primary>${icon("spark")} Write on</button><label class="dim">longest context</label><input type="range" id="fd-ctx" min="2" max="20" value="8"><span class="mono" id="fd-ctxv">8 words</span>`;
    R.innerHTML = `<p class="hint">Statistical sampling: the next word is drawn from the words that follow the longest ending of the text that occurs anywhere in the books (an infini-gram). Darker = more context, i.e. a longer quotation; light words are where it switched source.</p><div class="fd-text" id="fd-gen"></div>`;
    $("#fd-ctx").oninput = (e) => { $("#fd-ctxv").textContent = e.target.value + " words"; };
    $("#fd-go").onclick = recombine;
  } else if (m === "twins") {
    O.innerHTML = `<button class="btn sm" id="fd-go" data-primary>${icon("spark")} Swap every sentence</button><select class="in xs" id="fd-tm"><option value="exact">nearest by compression distance</option><option value="anchors">nearest in the 64-anchor embedding (faster)</option></select>`;
    R.innerHTML = `<p class="hint">Each sentence is placed in compression space (normalized compression distance, Cilibrasi &amp; Vitányi 2005: how much shorter two texts compress together than apart), then replaced by its nearest sentence elsewhere in the books. Does a text that “compresses alike” stay coherent?</p><div id="fd-gen"></div>`;
    $("#fd-go").onclick = runTwins;
  } else {
    O.innerHTML = `<button class="btn sm" id="fd-go" data-primary>${icon("spark")} Write on</button><select class="in xs" id="fd-aim"><option value="fit">fit the original (cheapest with it as the dictionary)</option><option value="match">match its signature step by step</option><option value="mean">match its average cost</option><option value="min">cheapest after the last N words</option></select><label class="dim">N</label><input class="in xs num" type="number" id="fd-n" value="12" min="3" max="40" style="width:56px">`;
    R.innerHTML = `<p class="hint">Rolling window: for the original, each word's <b>cost</b> d = compressed size of (last N words + this word) − compressed size of (last N words): its compression signature. When writing, the candidates are the words that really follow the context in the books; the one chosen is the one whose cost hits the aim.</p><div id="fd-gen"></div>`;
    $("#fd-go").onclick = runGuided;
  }
}
function replayText() {
  stop(); const r = D.lz, out = $("#fd-rb"); let k = 0, txt = "";
  out.innerHTML = "";
  D.play = setInterval(() => {
    const n = +$("#fd-speed").value;
    for (let q = 0; q < n && k < r.tokens.length; q++, k++) {
      const t = r.tokens[k];
      if (t[0] === "L") { txt += r.text.slice(t[1], t[2]); out.insertAdjacentHTML("beforeend", `<span>${esc(r.text.slice(t[1], t[2]))}</span>`); }
      else { let piece = ""; for (let j = 0; j < t[2] - t[1]; j++) piece += (txt + piece)[t[3] + j]; txt += piece; out.insertAdjacentHTML("beforeend", `<span class="cp new" style="--a:${Math.min(1, 0.2 + t[4] / 40)}">${esc(piece)}</span>`); }
    }
    $("#fd-tl").textContent = `${fmt.n(k)} of ${fmt.n(r.tokens.length)} pieces · ${fmt.n(txt.length)} characters${txt === r.text.slice(0, txt.length) ? " · exact so far" : " · MISMATCH"}`;
    out.scrollTop = out.scrollHeight;
    if (k >= r.tokens.length) stop();
  }, 60);
}
const body = () => (D.doc < 0 ? { doc: -1, text: D.own } : { doc: D.doc, offset: D.offset });
async function recombine() {
  const r = D.lz, o = $("#fd-gen"); o.innerHTML = '<div class="hint">chaining pieces of the corpus…</div>';
  const words = r.text.trim().split(/\s+/).slice(0, 12).join(" ");
  try {
    const c = await api.post("/text/sources/continue", { prompt: words, n: 120, temp: 1.1, max_ctx: +$("#fd-ctx").value });
    const quoted = c.words.filter((w) => w.options === 1).length;
    o.innerHTML = `<div class="fd-cmp"><div><div class="sec-t">The original</div><div class="fd-text">${esc(r.text.slice(0, 900))}…</div></div>
      <div><div class="sec-t">Written on from its first words</div><div class="fd-text"><span class="seed">${esc(c.prompt || words)}</span> ${c.words.map((w, i) => { const nx = c.words[i + 1]?.w || "", sp = /^[\w"'(À-￿]/.test(nx) ? " " : ""; return `<span class="cp" style="--a:${Math.min(1, w.ctx / 12)}" title="${w.ctx} words of context · ${w.options} possible next words">${esc(w.w)}</span>${sp}`; }).join("")}</div>
      <p class="dim">${quoted} of ${c.words.length} words had only one possible next word in the books, so they are quotation; the rest are choices.</p></div></div>`;
  } catch (e) { o.innerHTML = `<div class="hint">${esc(e.message)}</div>`; }
}
async function runTwins() {
  const o = $("#fd-gen"); o.innerHTML = '<div class="hint">placing every sentence in compression space (the first time builds the space: ~15 s)…</div>';
  try {
    let r = await fetch("/api/fractal/twins", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body(), method: $("#fd-tm").value }) }).then((x) => x.json());
    r = r.result || r; if (r.detail) throw new Error(r.detail);
    o.innerHTML = `<p class="dim">${r.pairs.length} sentences, each against ${fmt.n(r.sample)} sentences of the books · compression distance of the whole twin text to the original: <b>${r.ncd_whole}</b> (0 = the same, 1 = unrelated) · ${fmt.ms(r.ms)}</p>
      <div class="fd-cmp"><div><div class="sec-t">The original</div><div class="fd-text">${r.pairs.map((p) => esc(p.original)).join(" ")}</div></div>
      <div><div class="sec-t">Its compression twins</div><div class="fd-text">${r.pairs.map((p) => `<span class="tw" title="distance ${p.ncd} · ${esc(p.doc || "")}">${esc(p.twin)}</span>`).join(" ")}</div></div></div>
      <div class="sec-t" style="margin-top:12px">Sentence by sentence</div><table class="pf-tb fd-pairs"><tr><th>original</th><th>twin</th><th>distance</th></tr>${r.pairs.map((p) => `<tr><td>${esc(p.original)}</td><td>${esc(p.twin)} <span class="dim">· ${esc(p.doc || "")}</span></td><td>${p.ncd}</td></tr>`).join("")}</table>`;
  } catch (e) { o.innerHTML = `<div class="hint">${esc(e.message)}</div>`; }
}
async function runGuided() {
  const o = $("#fd-gen"); o.innerHTML = '<div class="hint">writing word by word, weighing each candidate by its compression cost…</div>';
  try {
    let r = await fetch("/api/fractal/guided", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body(), mode: $("#fd-aim").value, window: +$("#fd-n").value }) }).then((x) => x.json());
    r = r.result || r; if (r.detail) throw new Error(r.detail);
    o.innerHTML = `<p class="dim">cost per word: original <b>${r.mean_original}</b> bytes, written <b>${r.mean_generated}</b> · whole-text compression ratio: original ${r.ratio_original}×, written ${r.ratio_generated}× · ${fmt.ms(r.ms)}</p>
      <canvas id="fd-sig" width="760" height="140"></canvas>
      <div class="fd-cmp"><div><div class="sec-t">The original</div><div class="fd-text">${esc(D.lz.text.slice(0, 700))}…</div></div>
      <div><div class="sec-t">Written on (aim: ${esc(r.mode)})</div><div class="fd-text"><span class="seed">${esc(r.start)}</span> ${r.picks.map((p) => `<span class="cp" style="--a:${Math.min(1, 0.15 + p.delta / 10)}" title="cost ${p.delta}${p.target != null ? ` · aim ${p.target}` : ""} · ${p.options} candidates · context ${p.context} words">${esc(p.w)}</span>`).join(" ")}</div></div></div>`;
    const cv = $("#fd-sig"), g = cv.getContext("2d"), A = r.signature, B = r.trace, n = Math.max(A.length, B.length), mx = Math.max(4, ...A, ...B);
    const X = (i) => 34 + i / Math.max(1, n - 1) * (cv.width - 44), Y = (v) => cv.height - 16 - v / mx * (cv.height - 30);
    g.fillStyle = "#0b0b0e"; g.fillRect(0, 0, cv.width, cv.height); g.font = "10px 'JetBrains Mono'"; g.fillStyle = "#8a8b93"; g.fillText("cost of each next word (bytes) · blue = the original, yellow = written", 36, 11);
    [[A, "#3fa9f5"], [B, "#ffd300"]].forEach(([V, c]) => { g.strokeStyle = c; g.lineWidth = 1.5; g.beginPath(); V.forEach((v, i) => (i ? g.lineTo : g.moveTo).call(g, X(i), Y(v))); g.stroke(); });
  } catch (e) { o.innerHTML = `<div class="hint">${esc(e.message)}</div>`; }
}

// ================================================================ the corpus as a chaos game
async function cgrTab() {
  sh().innerHTML = '<div class="dim fd-shnote">each 32 px square is one character: the one just before the suffix · inside it, the one before that · click to go one character further back</div>';
  ctl().innerHTML = '<div class="hint">playing the chaos game on the corpus…</div>'; sb().innerHTML = "";
  let r;
  try { r = await api.get(`/fractal/cgr?suffix=${encodeURIComponent(D.suffix)}&depth=2`); r = r.result || r; } catch (e) { ctl().innerHTML = `<div class="hint">${esc(e.message)}</div>`; return; }
  const ch = (c) => esc(c === " " ? "␣" : c === "\n" ? "⏎" : c);
  ctl().innerHTML = `<p><b>${esc(r.corpus || "The corpus")}</b>, ${fmt.big(r.bytes)} characters.${D.suffix ? ` “${esc(D.suffix)}” occurs <b>${fmt.n(r.occurrences)}</b> times.` : ""}</p>
    <div class="fd-crumbs">Suffix: <button class="chip fd-crumb" data-i="-1">start</button>${[...D.suffix].map((c, i) => `<button class="chip fd-crumb" data-i="${i}">${ch(c)}</button>`).join("")}</div>
    ${D.suffix ? `<div class="sec-t">Just before it, far more often than chance</div>${tbl(r.over)}<div class="sec-t">Far less often than chance</div>${tbl(r.under)}` : `<div class="sec-t">The most common characters</div>${tbl(r.over, true)}`}
    <p class="hint fd-what">The Chaos Game Representation (Jeffrey 1990): each character is 4 base-4 digits, and the game moves halfway to each digit's corner, so the picture is exactly the count of every two-character history. It is a picture of the statistics, not a compression.</p>`;
  sb().innerHTML = `<div class="fd-cgr"><img id="fd-img" src="${r.image}" alt="chaos game picture"></div>`;
  $$(".fd-crumb", ctl()).forEach((b) => b.onclick = () => { const i = +b.dataset.i; D.suffix = i < 0 ? "" : D.suffix.slice(i); cgrTab(); });
  $("#fd-img").onclick = (e) => {
    const b = e.currentTarget.getBoundingClientRect(), cx = Math.floor((e.clientX - b.left) / b.width * 16), cy = Math.floor((e.clientY - b.top) / b.height * 16);
    let byte = 0; for (let k = 0; k < 4; k++) byte = byte * 4 + ((((cx >> (3 - k)) & 1) | (((cy >> (3 - k)) & 1) << 1)));
    D.suffix = String.fromCharCode(byte) + D.suffix; cgrTab();
  };
}
function tbl(rows, share) {
  if (!rows || !rows.length) return '<div class="dim">—</div>';
  return `<table class="pf-tb fd-t"><tr><th>char</th><th>count</th><th>${share ? "share" : "× chance"}</th></tr>${rows.map((x) => `<tr><th>${esc(x.char)}</th><td>${fmt.n(x.count)}</td><td>${share ? (x.share * 100).toFixed(1) + "%" : x.ratio.toFixed(2)}</td></tr>`).join("")}</table>`;
}

// ================================================================ the dimension of a photo
async function dimTab() {
  await photos(); if (!D.photo && D.photos.length) D.photo = D.photos[0].id;
  sh().innerHTML = '<div class="dim fd-shnote">its edges: the strongest 10% of brightness changes</div>';
  ctl().innerHTML = `<div class="sec-t">Photo</div>${strip(D.photo)}<div id="fd-dnum"><div class="hint">counting boxes…</div></div>`;
  $$(".fd-ph", ctl()).forEach((b) => b.onclick = () => { D.photo = b.dataset.id; dimTab(); });
  sb().innerHTML = "";
  try {
    let r = await api.get(`/fractal/dimension?photo=${D.photo}`); r = r.result || r;
    $("#fd-dnum").innerHTML = `<div class="fd-bign">${r.dimension.toFixed(2)}</div><p>box-counting dimension of its edges (fit R² ${r.r2.toFixed(3)}, boxes ${r.sizes[0]}–${r.sizes[r.sizes.length - 1]} px)</p>
      <p>The same number of edge pixels scattered at random: <b>${r.shuffled_dimension.toFixed(2)}</b>. ${Math.abs(r.dimension - r.shuffled_dimension) < 0.1 ? "Close: at this resolution the number mostly reflects how many edges there are." : "The gap is the shape: real edges are lines and clusters, not dust."}</p>
      <canvas id="fd-fit" width="300" height="170"></canvas><p class="hint">A smooth line measures 1, a filled area 2; coastlines and clouds sit between. A finite photo has a dimension only over a range of scales, so the range and R² matter.</p>`;
    sb().innerHTML = `<div class="fd-cgr"><img src="${r.image}" alt="edges"></div>`;
    const cv = $("#fd-fit"), g = cv.getContext("2d"), X = r.sizes.map((s) => Math.log(1 / s)), Y = r.counts.map(Math.log), Ys = r.shuffled_counts.slice(0, X.length).map(Math.log);
    const x0 = Math.min(...X), x1 = Math.max(...X), y0 = Math.min(...Y, ...Ys), y1 = Math.max(...Y, ...Ys), px = (x) => 26 + (x - x0) / (x1 - x0) * 264, py = (y) => 158 - (y - y0) / (y1 - y0) * 140;
    g.fillStyle = "#0b0b0e"; g.fillRect(0, 0, 300, 170); g.font = "10px 'JetBrains Mono'"; g.fillStyle = "#8a8b93"; g.fillText("log boxes ↑  log(1/size) →  (grey: random)", 28, 12);
    [[Y, "#ffd300"], [Ys, "#8a8b93"]].forEach(([V, c]) => { g.strokeStyle = c; g.fillStyle = c; g.beginPath(); X.forEach((x, i) => (i ? g.lineTo : g.moveTo).call(g, px(x), py(V[i]))); g.stroke(); X.forEach((x, i) => { g.beginPath(); g.arc(px(x), py(V[i]), 3, 0, 7); g.fill(); }); });
  } catch (e) { $("#fd-dnum").innerHTML = `<div class="hint">${esc(e.message)}</div>`; }
}
