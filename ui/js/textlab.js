// TEXT LAB — the "How it works" and "Compose" tabs of the Text Engine.
//   How it works: tokens (word / BPE / characters), next word (each n-gram level, the longest match, the neural LM,
//   the blend), sampling (temperature, top-k, top-p, min-p, live in the browser) and embeddings (contexts -> PPMI ->
//   SVD neighbours). Every view shows a score measured on held-out text, next to a simple baseline.
//   Compose: a generation pipeline (tokenizer -> scorers with weights -> sampling rules -> constraints), checked as you
//   type, run, scored, saved, and compared side by side with real held-out text. The same pipelines are models
//   (text.pipeline.*), so agents and the Console use them with one short call.
import { $, $$, api, empty, esc, fail, fmt, icon, toast, watchJob } from "./core.js";

const L = {
  view: "tokens",
  tok: { text: "It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.", merges: 1000, order: 3, last: null, score: null, mlist: null },
  nw: { ctx: "I do not", last: null },
  smp: { src: "blend", temperature: 0.8, top_k: 0, top_p: 0.9, min_p: 0, repetition: 0, measured: null },
  emb: { word: "sea", last: null, test: null },
};
const CP = {
  spec: null, out: null, check: null, cmp: [], cmpRes: null, list: null, seed: "", json: false,
};
const KINDS = { unigram: "Word frequency", ngram: "n-gram", suffix: "Longest match", neural: "Neural LM", topic: "Topic steering", cache: "Context steering" };
const KIND_HELP = {
  unigram: "Only how common each word is. A baseline: no context at all.",
  ngram: "Counts of what followed the last n-1 tokens, with back-off to shorter contexts (Kneser-Ney for words).",
  suffix: "The longest stretch of the corpus that matches the end of the text; copy what came next (infini-gram).",
  neural: "The small neural network trained on the card: word vectors of the last words -> hidden layer -> softmax.",
  topic: "Not a probability: lifts words whose vectors are near the theme words. Weight = strength.",
  cache: "Not a probability: lifts words near the meaning of what the text said so far.",
};
const PROB = new Set(["unigram", "ngram", "suffix", "neural"]);
let ctx = null;            // { stage, tabTools, corpus }
const seqs = {};
const latest = (k) => { const id = (seqs[k] || 0) + 1; seqs[k] = id; return () => seqs[k] === id; };

// ---------------------------------------------------------------- calling models (short ones inline, long ones as jobs)
async function call(name, params = {}) {
  const r = await fetch("/v1/models/" + encodeURIComponent(name), { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(params) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error || {}).message || j.detail || r.statusText);
  return j.result;
}
// a job with a progress line and a Stop button inside `host`
async function job(name, params, host, label) {
  const ctl = new AbortController();
  host.innerHTML = `<div class="tl-job"><div class="tl-job-t">${esc(label)}</div><div class="tl-bar"><i></i></div><div class="tl-job-m mono">starting…</div><button class="btn ghost xs" data-stop>Stop</button></div>`;
  host.querySelector("[data-stop]").onclick = () => ctl.abort();
  const r = await fetch("/v1/models/" + encodeURIComponent(name) + "?async=1", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error || {}).message || j.detail || r.statusText);
  const env = await watchJob(j.job, (x) => { const i = host.querySelector(".tl-bar i"), m = host.querySelector(".tl-job-m"); if (i) i.style.width = Math.max(3, (x.progress || 0) * 100) + "%"; if (m) m.textContent = x.message || ""; }, { signal: ctl.signal });
  return env && env.result !== undefined ? env.result : env;
}
const showErr = (host, e) => { if (host) host.innerHTML = empty(e.cancelled ? "Stopped." : esc(e.message)); };

// ---------------------------------------------------------------- How it works
const VIEWS = [["tokens", "Tokens"], ["next", "Next word"], ["sampling", "Sampling"], ["embed", "Embeddings"]];
export function tLearn(c, view) {
  ctx = c;
  if (view) L.view = view;
  const title = (VIEWS.find(([k]) => k === L.view) || VIEWS[0])[1];
  ctx.stage("learn", `<section class="pane tl" id="tl-p"><div class="pane-h"><div class="t">${title}</div>
      <div class="meta" id="tl-meta"></div><div class="tools" id="tl-tools"></div></div><div class="pane-b tl-b" id="tl-b"></div></section>`);
  renderLearn();
}
function renderLearn() {
  $("#tl-tools").innerHTML = ""; $("#tl-meta").textContent = "";
  ({ tokens: vTokens, next: vNext, sampling: vSampling, embed: vEmbed })[L.view]();
}

// -- tokens
function vTokens() {
  const t = L.tok;
  $("#tl-meta").textContent = "how text becomes numbers";
  $("#tl-b").innerHTML = `<div class="tl-intro">A model cannot read letters. A <b>tokenizer</b> cuts the text into pieces and gives each piece a number (its id). Words make few, long tokens but meet unknown words; characters never meet an unknown token but make long sequences; <b>BPE</b> (byte-pair encoding) starts from characters and merges the most frequent pair again and again, so common words become one token and rare words become a few pieces. The BPE here is trained on <i>your</i> corpus.</div>
    <div class="tl-row"><textarea class="in" id="tk-text" rows="2">${esc(t.text)}</textarea>
      <div class="fld tl-merges"><label>BPE merges</label><input type="range" id="tk-m" min="100" max="4000" step="100" value="${t.merges}"><span class="v" id="tk-m-v">${t.merges}</span></div></div>
    <div id="tk-out">${empty("Type some text.")}</div>
    <div class="tl-grid2"><div class="tl-card" id="tk-score"></div><div class="tl-card" id="tk-merges"></div></div>`;
  const run = () => { clearTimeout(t.timer); t.timer = setTimeout(loadTokens, 280); };
  $("#tk-text").oninput = (e) => { t.text = e.target.value; run(); };
  $("#tk-m").oninput = (e) => { $("#tk-m-v").textContent = e.target.value; };
  $("#tk-m").onchange = (e) => { t.merges = +e.target.value; t.score = null; t.mlist = null; loadTokens(); renderTokScore(); renderMerges(); };
  if (t.last) showTokens(t.last); else loadTokens();
  renderTokScore(); renderMerges();
}
async function loadTokens() {
  const t = L.tok, ok = latest("tok");
  if (!t.text.trim()) { $("#tk-out").innerHTML = empty("Type some text."); return; }
  const host = $("#tk-out");
  try {
    let r;
    if (!t.trained || t.trained !== t.merges) {     // the first call trains BPE: show it as a job
      await job("text.tokens.merges", { merges: t.merges, first: 40 }, host, `Training BPE on the corpus (${t.merges} merges)`).then((m) => { t.mlist = m; renderMerges(); });
      t.trained = t.merges;
    }
    r = await call("text.tokens", { text: t.text, merges: t.merges });
    if (!ok()) return;
    t.last = r; showTokens(r);
  } catch (e) { if (ok()) showErr(host, e); }
}
function chips(list, kind) {
  return list.map((x, i) => {
    const t = kind === "char" && x.t === " " ? "␣" : x.t;
    const unk = x.id < 0 || (kind !== "word" && x.id === 0);
    return `<span class="tl-tok c${i % 6} ${unk ? "unk" : ""}" title="id ${x.id < 0 ? "none (unknown)" : x.id}${x.count != null ? ` · ${fmt.n(x.count)} times in the corpus` : ""}${x.merge != null ? ` · merge #${x.merge + 1}` : ""}">${esc(t)}<sub>${x.id < 0 ? "?" : x.id}</sub></span>`;
  }).join("");
}
function showTokens(r) {
  const row = (k, name) => { const x = r[k]; return `<div class="tl-tk"><div class="tl-tk-h"><b>${name}</b><span>${fmt.n(x.n)} tokens · ${x.chars_per_token} characters per token · vocabulary ${fmt.n(x.vocab)}${k === "word" && x.unknown ? ` · <span class="bad">${x.unknown} unknown</span>` : ""}</span></div>
      <div class="tl-toks">${chips(x.tokens, k)}${k === "char" && x.n > x.tokens.length ? " …" : ""}</div><div class="hint">${esc(x.note)}</div></div>`; };
  const tr = (r.bpe.traces || []).map((t) => `<div class="tl-trace"><b>${esc(t.piece)}</b><span class="tl-st">${t.steps[0].map(esc).join(" ")}</span><span class="tl-arrow">→</span><span class="tl-st fin">${t.final.map(esc).join(" · ")}</span>
      <div class="tl-msteps">${t.steps.slice(1).map((s) => `<span title="after it: ${esc(s.pieces.join(" · "))}"><i>#${s.merge + 1}</i>${esc(s.pair[0])}+${esc(s.pair[1])}</span>`).join("")}</div></div>`).join("");
  $("#tk-out").innerHTML = row("word", "Words") + row("bpe", "BPE") + `<div class="tl-tk"><div class="tl-tk-h"><b>How BPE built the longest words</b><span>each arrow is one learned merge, applied in the order it was learned</span></div>${tr}</div>` + row("char", "Characters");
}
function renderTokScore() {
  const t = L.tok, el = $("#tk-score");
  if (!el) return;
  if (!t.score) {
    el.innerHTML = `<div class="tl-card-h"><b>Which tokenizer predicts best?</b><span class="tools"><select class="sel sm" id="tk-o">${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${n === t.order ? "selected" : ""}>${n}-gram</option>`).join("")}</select><button class="btn sm" id="tk-go">${icon("bolt")} Measure</button></span></div>
      <div class="hint">The same n-gram model, trained on 90% of the corpus with each tokenizer (counted on the card), predicts the held-out 10%. The score is <b>bits per character</b>: the only fair score across tokenizers, because a per-token perplexity depends on how long a token is. Baselines: every character equally likely, character frequencies only, and gzip.</div>`;
    $("#tk-o").onchange = (e) => t.order = +e.target.value;
    $("#tk-go").onclick = async () => { try { t.score = await job("text.tokens.score", { merges: t.merges, order: t.order }, el, "Scoring the three tokenizers"); } catch (e) { if (!e.cancelled) fail(e); } renderTokScore(); };
    return;
  }
  const s = t.score, b = s.baselines;
  const rows = s.rows.map((x) => ({ l: { word: "Words", bpe: "BPE", char: "Characters" }[x.tokenizer], v: x.bpc, kind: "model", tip: `${fmt.n(x.tokens)} tokens · ${x.chars_per_token} chars/token · perplexity ${x.ppl_per_token} per token · ${x.unknown} unknown` }))
    .concat([{ l: "gzip -9", v: b.gzip, kind: "base" }, { l: "Character frequency", v: b.char_unigram, kind: "base" }, { l: "Uniform", v: b.uniform, kind: "chance" }]);
  el.innerHTML = `<div class="tl-card-h"><b>Bits per character, held-out text</b><span class="tools"><button class="btn ghost xs" id="tk-again">Measure again</button></span></div>
    ${bars(rows, { max: b.uniform, lower: true, dec: 2 })}
    <div class="tl-verdict">Best: <b>${{ word: "words", bpe: "BPE", char: "characters" }[s.best]}</b> with a ${s.order}-gram model on ${fmt.n(s.held_chars)} held-out characters. <span class="dim">${fmt.ms(s.secs * 1000)}</span></div><div class="hint">${esc(s.note)}</div>`;
  $("#tk-again").onclick = () => { t.score = null; renderTokScore(); };
}
function renderMerges() {
  const t = L.tok, el = $("#tk-merges");
  if (!el) return;
  if (!t.mlist) { el.innerHTML = `<div class="tl-card-h"><b>The merges BPE learned</b></div>${empty("They show after the first training.")}`; return; }
  const m = t.mlist;
  el.innerHTML = `<div class="tl-card-h"><b>The merges BPE learned</b><span class="dim">${fmt.n(m.total)} merges · ${m.base} characters · ${fmt.n(m.word_types)} word types · ${fmt.ms(m.train_secs * 1000)}</span></div>
    <div class="tl-merge-list">${m.merges.map((x) => `<span title="#${x.rank + 1}: seen ${fmt.n(x.count)} times"><i>${x.rank + 1}</i>${esc(x.a)} + ${esc(x.b)} → <b>${esc(x.new)}</b></span>`).join("")}</div>
    <div class="hint">The first merges join the commonest pairs of letters; later merges join whole words and common endings. Last merges: ${m.last.map((x) => `<b>${esc(x.new)}</b>`).join(" ")}</div>`;
}

// shared horizontal bars: rows [{l, v, kind, tip}], o = {max, lower (lower is better), dec, log}
function bars(rows, o = {}) {
  const vals = rows.map((r) => r.v).filter((v) => v != null);
  const mx = o.max || Math.max(...vals, 1e-9);
  const f = (v) => o.log ? Math.log(Math.max(1, v)) / Math.log(Math.max(2, mx)) : v / mx;
  const best = o.lower ? Math.min(...rows.filter((r) => r.kind === "model" && r.v != null).map((r) => r.v)) : null;
  return `<div class="tl-bars">${rows.map((r) => `<div class="tl-barrow ${r.kind || "model"} ${r.v === best ? "best" : ""}" title="${esc(r.tip || "")}"><span>${esc(r.l)}</span><i style="--w:${Math.max(0.5, Math.min(1, r.v == null ? 0 : f(r.v)) * 100)}%"></i><b>${r.v == null ? "—" : fmt.n(r.v, o.dec ?? 1)}</b></div>`).join("")}</div>`;
}
const wordBars = (list, o = {}) => `<div class="tl-wb">${list.map((x) => `<button class="tl-w" data-w="${esc(x.w)}" title="${x.count != null ? fmt.n(x.count) + " times" : ""}${x.p != null ? ` · p = ${x.p}` : ""}"><span>${esc(x.w === "\n\n" ? "¶" : x.w)}</span><i style="--w:${Math.min(100, (o.of ? (x[o.of] / (o.max || 1)) : x.p / (o.max || 1)) * 100)}%"></i><b>${o.of === "count" ? fmt.n(x.count) : fmt.pct(x.p, x.p < 0.01 ? 2 : 1)}</b></button>`).join("")}</div>`;

// -- next word
function vNext() {
  const n = L.nw;
  $("#tl-meta").textContent = "what the models expect next, and why";
  $("#tl-b").innerHTML = `<div class="tl-intro">A <b>Markov</b> or <b>n-gram</b> model predicts the next word from the last n-1 words, with counts from the corpus. A long context is precise but often never seen, so the model <b>backs off</b>: it mixes in the prediction of a shorter context, with the weight that the longer one leaves free. Click a predicted word to add it to the context: that is generation, one step at a time.</div>
    <div class="tl-row"><input class="in" id="nw-ctx" value="${esc(n.ctx)}" placeholder="Type a context, for example: I do not"><button class="btn ghost sm" id="nw-back" title="Remove the last word">${icon("undo")}</button></div>
    <div id="nw-out">${empty("Type a context.")}</div>`;
  $("#nw-ctx").oninput = (e) => { n.ctx = e.target.value; clearTimeout(n.timer); n.timer = setTimeout(loadNext, 250); };
  $("#nw-back").onclick = () => { n.ctx = n.ctx.trim().split(/\s+/).slice(0, -1).join(" "); $("#nw-ctx").value = n.ctx; loadNext(); };
  if (n.last && n.last.context === n.ctx) showNext(n.last); else loadNext();
}
async function loadNext(into = "#nw-out") {
  const n = L.nw, ok = latest("nw"), host = $(into);
  try {
    // the first call can build the n-gram tables (seconds), so it runs as a job with progress; later calls are instant
    if (!n.warm) {                            // count the n-gram tables first (once per corpus), with progress
      const st = await call("text.lm.status");
      if (!st.model || !st.model.built) await job("text.lm.build", { order: 5 }, host, "Counting the n-gram tables of this corpus on the card (once)");
    }
    const r = await call("text.predict", { context: n.ctx, top: 10 });
    n.warm = true;
    if (!ok()) return;
    n.last = r;
    if (into === "#nw-out") showNext(r); else drawSampling();
  } catch (e) { if (ok()) showErr(host, e); }
}
function showNext(r) {
  const s = r.scores || {};
  const lv = r.levels.map((l) => {
    if (!l.seen) return `<div class="tl-lv off"><div class="tl-lv-h"><b>${l.order}-gram</b><span>${l.context.length ? "“" + esc(l.context.join(" ")) + "”" : ""}</span></div><div class="hint">${esc(l.note || "")}</div>${l.top ? wordBars(l.top.slice(0, 6), { max: l.top[0] ? l.top[0].p : 1 }) : ""}</div>`;
    const mx = Math.max(...(l.counts || l.top).map((x) => l.counts ? x.count : x.p), 1e-9);
    return `<div class="tl-lv"><div class="tl-lv-h"><b>${l.order}-gram</b><span>${l.order === 1 ? "no context" : `“${esc(l.context.join(" "))}” seen ${fmt.n(l.count)} times, ${fmt.n(l.types)} different next words`}</span></div>
      ${l.counts ? `<div class="tl-sub">counted after this context</div>${wordBars(l.counts.slice(0, 6), { of: "count", max: mx })}` : ""}
      <div class="tl-sub">${l.order === 1 ? "a 1-gram model predicts" : `a ${l.order}-gram model predicts`} ${l.backoff != null ? `<span class="dim" title="Kneser-Ney takes a discount from every count here and gives that share to the ${l.order - 1}-gram prediction">(${fmt.pct(l.backoff, 0)} goes to order ${l.order - 1})</span>` : ""}</div>${wordBars(l.top.slice(0, 6), { max: l.top[0] ? l.top[0].p : 1 })}</div>`;
  }).join("");
  const lg = r.longest;
  const card = (t, d, note) => d ? `<div class="tl-lv"><div class="tl-lv-h"><b>${t}</b><span>${note}</span></div>${wordBars(d.top.slice(0, 8), { max: d.top[0] ? d.top[0].p : 1 })}</div>` : "";
  const unk = r.unknown && r.unknown.length ? `<div class="tl-warn">Not in the model's vocabulary (shown as &lt;unk&gt;): ${r.unknown.map(esc).join(", ")}</div>` : "";
  $("#nw-out").innerHTML = `${unk}<div class="tl-levels">${lv}</div>
    <div class="tl-levels">${lg ? `<div class="tl-lv ${lg.used ? "" : "off"}"><div class="tl-lv-h"><b>Longest match</b><span>“${esc(lg.context.join(" "))}”: ${lg.length} word${lg.length > 1 ? "s" : ""}, ${fmt.n(lg.count)} times${lg.used ? "" : " (used from 4 words)"}</span></div>${wordBars(lg.top.slice(0, 8), { max: lg.top[0] ? lg.top[0].p : 1 })}</div>` : ""}
      ${card("Neural LM", r.neural, r.neural ? `last ${r.neural.context} words · uncertainty ${r.neural.entropy} bits` : "")}
      ${card("Blend", r.blend, r.blend ? Object.entries(r.blend.weights).map(([k, v]) => `${{ kn: "n-gram", mlp: "neural", sfx: "match" }[k]} ${fmt.pct(v, 0)}`).join(" + ") : "")}
      ${!r.neural ? `<div class="tl-lv off"><div class="tl-lv-h"><b>Neural LM</b></div><div class="hint">Not trained for this corpus. Generate &gt; VectorLM &gt; Train, or <code>vf run text.lm.train</code>.</div></div>` : ""}</div>
    <div class="tl-card"><div class="tl-card-h"><b>Held-out perplexity</b><span class="dim">${s.eval_tokens ? fmt.n(s.eval_tokens) + " test words" : ""} · lower is better</span></div>
      ${bars([{ l: "Uniform (chance)", v: s.uniform, kind: "chance" }, { l: "Word frequency", v: s.unigram, kind: "base" }, { l: "Bigram", v: s.bigram, kind: "model" }, { l: "Kneser-Ney 5-gram", v: s.kn, kind: "model" }, { l: "Neural LM", v: s.neural, kind: "model" }, { l: "Blend", v: s.blend, kind: "model" }].filter((x) => x.v != null), { log: true, lower: true, max: s.uniform })}
      <div class="hint">${esc(s.note || "")} The bars use a log scale.</div></div>`;
  $$("#nw-out .tl-w").forEach((b) => b.onclick = () => { const w = b.dataset.w; if (w === "<unk>") return; L.nw.ctx = (L.nw.ctx.trim() + " " + (w === "\n\n" ? "" : w)).trim(); $("#nw-ctx").value = L.nw.ctx; loadNext(); });
}

// -- sampling (all in the browser, from the distribution the server sent)
function shapeJS(p, o) {
  let q = p.slice();
  if (o.temperature <= 0.01) { const i = q.indexOf(Math.max(...q)); return q.map((_, j) => j === i ? 1 : 0); }
  q = q.map((x) => x > 0 ? Math.exp(Math.log(x) / o.temperature) : 0);
  let s = q.reduce((a, b) => a + b, 0); q = q.map((x) => x / s);
  const order = q.map((x, i) => [x, i]).sort((a, b) => b[0] - a[0]);
  const keep = new Set();
  let cum = 0;
  for (let r = 0; r < order.length; r++) {
    const [x, i] = order[r];
    if (o.top_k > 0 && r >= o.top_k) break;
    if (o.top_p < 1 && cum >= o.top_p) break;
    if (o.min_p > 0 && x < o.min_p * order[0][0]) break;
    keep.add(i); cum += x;
  }
  q = q.map((x, i) => keep.has(i) ? x : 0);
  s = q.reduce((a, b) => a + b, 0) || 1;
  return q.map((x) => x / s);
}
const H = (q) => -q.reduce((a, x) => a + (x > 0 ? x * Math.log2(x) : 0), 0);
function vSampling() {
  const o = L.smp;
  $("#tl-meta").textContent = "how a word is chosen from the prediction";
  $("#tl-b").innerHTML = `<div class="tl-intro">A model gives a probability to every word. <b>Sampling</b> turns that into one choice. <b>Temperature</b> sharpens (below 1) or flattens (above 1) the distribution. <b>Top-k</b> keeps the k likeliest words, <b>top-p</b> (nucleus) keeps the smallest set that holds p of the probability, and <b>min-p</b> keeps words at least min-p times as likely as the best one. The <b>repetition penalty</b> lowers words that the context already used. Low settings repeat the likeliest text; high settings make word salad. Measure it below.</div>
    <div class="tl-row"><input class="in" id="sm-ctx" value="${esc(L.nw.ctx)}" placeholder="Context"><select class="sel sm" id="sm-src">${["blend", "kn", "neural"].map((k) => `<option value="${k}" ${o.src === k ? "selected" : ""}>${{ blend: "Blend", kn: "Kneser-Ney", neural: "Neural LM" }[k]}</option>`).join("")}</select><button class="btn sm" id="sm-draw">${icon("spark")} Choose one word</button></div>
    <div class="tl-knobs">${knob("temperature", "Temperature", 0, 2.5, 0.05)}${knob("top_k", "Top-k (0 = off)", 0, 200, 1)}${knob("top_p", "Top-p", 0.05, 1, 0.01)}${knob("min_p", "Min-p", 0, 0.5, 0.01)}${knob("repetition", "Repetition penalty", 0, 3, 0.1)}</div>
    <div class="tl-grid2 smp"><div class="tl-card" id="sm-chart"></div><div class="tl-card" id="sm-meas"></div></div>`;
  $$("#tl-b .tl-knob input").forEach((e) => e.oninput = () => { o[e.dataset.k] = +e.value; e.nextElementSibling.textContent = e.value; drawSampling(); });
  $("#sm-src").onchange = (e) => { o.src = e.target.value; drawSampling(); };
  $("#sm-ctx").oninput = (e) => { L.nw.ctx = e.target.value; clearTimeout(o.timer); o.timer = setTimeout(() => loadNext("#sm-chart"), 250); };
  $("#sm-draw").onclick = () => {
    const d = cur(); if (!d) return;
    const q = d.q; let r = Math.random(), i = 0;
    for (; i < q.length - 1; i++) { r -= q[i]; if (r <= 0) break; }
    const w = d.w[i]; if (w === "<unk>") return toast("drew <unk>: draw again");
    L.nw.ctx = (L.nw.ctx.trim() + " " + (w === "\n\n" ? "" : w)).trim(); $("#sm-ctx").value = L.nw.ctx; loadNext("#sm-chart");
  };
  renderMeasure();
  if (L.nw.last && L.nw.last.context === L.nw.ctx) drawSampling(); else loadNext("#sm-chart");
}
const knob = (k, l, mn, mx, st) => `<div class="fld tl-knob"><label>${l}</label><input type="range" data-k="${k}" min="${mn}" max="${mx}" step="${st}" value="${L.smp[k]}"><span class="v">${L.smp[k]}</span></div>`;
function cur() {
  const r = L.nw.last; if (!r || !r.dists) return null;
  const d = r.dists[L.smp.src] || r.dists.blend; if (!d) return null;
  const used = {}; (L.nw.ctx.toLowerCase().match(/[a-z0-9']+/g) || []).forEach((w) => used[w] = (used[w] || 0) + 1);
  let p = d.p.map((x, i) => x / (1 + L.smp.repetition * (used[String(d.w[i]).toLowerCase()] || 0)));
  const s0 = p.reduce((a, b) => a + b, 0); p = p.map((x) => x / s0);
  return { w: d.w, p, q: shapeJS(p, L.smp), rest: d.rest };
}
function drawSampling() {
  const el = $("#sm-chart"); if (!el) return;
  const d = cur(); if (!d) { el.innerHTML = empty("No prediction yet."); return; }
  const n = 24, mx = Math.max(...d.p.slice(0, n), ...d.q.slice(0, n), 1e-9);
  const kept = d.q.filter((x) => x > 0).length;
  el.innerHTML = `<div class="tl-card-h"><b>Next word: before and after the rules</b><span class="dim">top ${n} of ${fmt.n(d.w.length)} shown · ${fmt.pct(d.rest, 1)} of the probability is beyond them</span></div>
    <div class="tl-sbars">${d.w.slice(0, n).map((w, i) => `<div class="tl-sb ${d.q[i] > 0 ? "" : "cut"}" title="model ${fmt.pct(d.p[i], 2)} → sampled ${fmt.pct(d.q[i], 2)}"><span>${esc(w === "\n\n" ? "¶" : w)}</span><i class="a" style="--w:${d.p[i] / mx * 100}%"></i><i class="b" style="--w:${d.q[i] / mx * 100}%"></i><b>${fmt.pct(d.q[i], 1)}</b></div>`).join("")}</div>
    <div class="tl-stats"><span>uncertainty <b>${H(d.p).toFixed(2)}</b> → <b>${H(d.q).toFixed(2)}</b> bits</span><span>about <b>${fmt.n(2 ** H(d.q), 1)}</b> equally likely choices</span><span><b>${fmt.n(kept)}</b> words can be chosen</span></div>`;
}
function renderMeasure() {
  const el = $("#sm-meas"); if (!el) return;
  const o = L.smp, m = o.measured;
  const head = `<div class="tl-card-h"><b>Measure these settings</b><span class="tools"><button class="btn sm" id="sm-go">${icon("bolt")} Write 4 samples and score</button></span></div>`;
  if (!m) { el.innerHTML = head + `<div class="hint">Writes 4 samples of 60 words with this model and these rules, and compares them with real held-out text: <b>distinct-2</b> (different word pairs: low = dull), <b>repeat-4</b> (loops), <b>copied-8</b> (runs of 8+ words copied from the corpus) and the <b>5-gram perplexity</b> (how ordinary the text looks to the corpus's own model). Good settings come close to the real text.</div>`; bindMeasure(); return; }
  el.innerHTML = head + measureTable(m.rows) + `<div class="tl-ex">${esc((m.rows[0] || {}).example || "")}</div>`;
  bindMeasure();
}
function bindMeasure() {
  const b = $("#sm-go"); if (!b) return;
  b.onclick = async () => {
    const o = L.smp, src = { blend: [{ kind: "ngram", order: 5, weight: 0.33 }, { kind: "neural", weight: 0.67 }], kn: [{ kind: "ngram", order: 5, weight: 1 }], neural: [{ kind: "neural", weight: 1 }] }[o.src];
    const spec = { scorers: src, sampling: { temperature: o.temperature, top_k: o.top_k, top_p: o.top_p, min_p: o.min_p, repetition: o.repetition, no_repeat: 0 }, constraints: { length: 60, stop: "none" } };
    const el = $("#sm-meas");
    try { o.measured = await job("text.pipeline.compare", { pipelines: [], specs: { "These settings": spec }, samples: 4, eval_tokens: 250, seed: L.nw.ctx }, el, "Writing and scoring samples"); }
    catch (e) { if (!e.cancelled) fail(e); }
    renderMeasure();
  };
}
function measureTable(rows) {
  const ref = rows.find((r) => r.reference) || {};
  const close = (v, k) => ref[k] == null || v == null ? "" : Math.abs(v - ref[k]) <= Math.abs(ref[k]) * 0.12 + 0.01 ? "near" : "";
  return `<table class="tbl tl-mt"><thead><tr><th>Pipeline</th><th title="held-out perplexity of the model (same tokenizer only)">ppl</th><th title="bits per character (BPE and characters)">bpc</th><th>distinct-2</th><th>repeat-4</th><th>copied-8</th><th title="perplexity of the samples under the corpus's 5-gram model">5-gram ppl</th><th>words/s</th></tr></thead>
    <tbody>${rows.map((r) => r.error ? `<tr><td>${esc(r.name)}</td><td colspan="7" class="bad">${esc(r.error)}</td></tr>` : `<tr class="${r.reference ? "ref" : ""}"><td title="${esc(r.example || "")}">${esc(r.name)}</td><td>${r.ppl == null ? "—" : fmt.n(r.ppl, 1)}</td><td>${r.bpc == null ? "—" : r.bpc}</td>
      <td class="${close(r.distinct2, "distinct2")}">${fmt.pct(r.distinct2, 0)}</td><td class="${close(r.repeat4, "repeat4")}">${fmt.pct(r.repeat4, 0)}</td><td class="${close(r.copied8, "copied8")}">${fmt.pct(r.copied8, 0)}</td><td class="${close(r.kn_ppl, "kn_ppl")}">${fmt.n(r.kn_ppl, 0)}</td><td>${r.tok_s == null ? "—" : fmt.n(r.tok_s, 0)}</td></tr>`).join("")}</tbody></table>
    <div class="hint">Green = within about 12% of real text. Hover a name to read its first sample.</div>`;
}

// -- embeddings
function vEmbed() {
  const e = L.emb;
  $("#tl-meta").textContent = "how a word gets a vector";
  $("#tl-tools").innerHTML = `<button class="btn ghost xs" id="em-map">Open the word map</button>`;
  $("#em-map").onclick = () => ctx.goTab("embed");
  $("#tl-b").innerHTML = `<div class="tl-intro">“You shall know a word by the company it keeps.” An <b>embedding</b> gives each word a list of numbers (a vector) so that words used in similar places get similar vectors. Here it is built in three steps that you can see: count the words near each word, weight the counts by <b>PPMI</b> (how much more often than chance), then compress the table with an <b>SVD</b> to a few dozen numbers per word. Neighbours in that space share contexts, even when they never occur together.</div>
    <div class="tl-row"><input class="in" id="em-w" value="${esc(e.word)}" placeholder="A word, for example: sea"></div>
    <div id="em-out">${empty("Type a word.")}</div><div class="tl-card" id="em-test"></div>`;
  $("#em-w").oninput = (ev) => { e.word = ev.target.value.trim(); clearTimeout(e.timer); e.timer = setTimeout(loadEmb, 300); };
  if (e.last && e.last.word === e.word.toLowerCase()) showEmb(e.last); else loadEmb();
  renderEmbTest();
}
async function loadEmb() {
  const e = L.emb, ok = latest("emb"); if (!e.word) return;
  try { const r = await call("text.embed.explain", { word: e.word, k: 12 }); if (!ok()) return; e.last = r; showEmb(r); } catch (err) { if (ok()) showErr($("#em-out"), err); }
}
function showEmb(r) {
  const col = (t, sub, list, key, d = 0) => { const mx = Math.max(...list.map((x) => x[key]), 1e-9); return `<div class="tl-lv"><div class="tl-lv-h"><b>${t}</b><span>${sub}</span></div><div class="tl-wb">${list.map((x) => `<button class="tl-w" data-w="${esc(x.w)}" title="${x.together != null ? `${x.together} times together · ${fmt.n(x.count)} in all` : ""}"><span>${esc(x.w)}</span><i style="--w:${x[key] / mx * 100}%"></i><b>${fmt.n(x[key], d)}</b></button>`).join("")}</div></div>`; };
  $("#em-out").innerHTML = `<div class="hint" style="margin:0 0 8px">“${esc(r.word)}” occurs ${fmt.n(r.occurrences)} times${r.used < r.occurrences ? ` (the first ${fmt.n(r.used)} are counted here)` : ""}. ${esc(r.method)}</div>
    <div class="tl-levels">${col("1. Counted nearby", `within ${r.window} words`, r.raw, "together")}${col("2. Weighted by PPMI", "seen 5+ times together", r.ppmi, "ppmi", 2)}${r.in_space ? col("3. Nearest vectors", `cosine, ${r.dims} dimensions, ${fmt.n(r.space_words)} words`, r.neighbours.map((x) => ({ w: x.w, sim: x.sim })), "sim", 2) : `<div class="tl-lv off"><div class="tl-lv-h"><b>3. Nearest vectors</b></div><div class="hint">This word is not among the ${fmt.n(r.space_words)} words of the space (the space keeps the commonest content words that pass the filter).</div></div>`}</div>
    <div class="hint">Raw counts favour common words; PPMI favours rare, specific partners and is noisy for them; the SVD smooths both into a few directions, so neighbours share many contexts. Click a word to look it up.</div>`;
  $$("#em-out .tl-w").forEach((b) => b.onclick = () => { L.emb.word = b.dataset.w; $("#em-w").value = L.emb.word; loadEmb(); });
}
function renderEmbTest() {
  const el = $("#em-test"), t = L.emb.test; if (!el) return;
  const head = `<div class="tl-card-h"><b>How far can you trust the space?</b><span class="tools"><button class="btn sm" id="em-go">${icon("bolt")} Run the analogy test</button></span></div>`;
  if (!t) { el.innerHTML = head + `<div class="hint">Analogies from this corpus's own words (do : don't = could : ?, ship : ships = boat : ?) are answered with vector arithmetic (3CosMul) in the relation space (5,000 words, function words kept), and compared with a baseline that only takes the nearest word to c, and with chance.</div>`; }
  else {
    el.innerHTML = head + `<table class="tbl tl-mt"><thead><tr><th>Relation</th><th>Questions</th><th>Vector arithmetic</th><th>Nearest word to c</th><th>Chance</th><th>Examples</th></tr></thead><tbody>${t.relations.map((r) => `<tr><td>${esc(r.relation)}</td><td>${r.questions}</td><td class="${r.accuracy > r.baseline ? "near" : "bad"}">${fmt.pct(r.accuracy, 0)}</td><td>${fmt.pct(r.baseline, 0)}</td><td>${fmt.pct(t.chance, 2)}</td><td class="dim">${r.examples.map(esc).join(", ")}</td></tr>`).join("")}</tbody></table><div class="hint">${fmt.ms(t.ms)} · vocabulary ${fmt.n(t.vocab)}</div>`;
  }
  $("#em-go").onclick = async () => { try { const r = await job("text.embed.explain", { word: L.emb.word || "sea", test: true }, el, "Building the relation space and testing it"); L.emb.test = r.test; } catch (e) { if (!e.cancelled) fail(e); } renderEmbTest(); };
}

// ---------------------------------------------------------------- Compose
const DEF = () => ({ tokenizer: "word", merges: 1000, combine: "mix", scorers: [{ kind: "ngram", order: 5, weight: 1 }],
  sampling: { temperature: 0.8, top_k: 0, top_p: 0.9, min_p: 0, repetition: 0.5, no_repeat: 3 }, constraints: { length: 60, stop: "sentence", ban: [], include: [], rhyme: "" } });
export function tCompose(c) {
  ctx = c;
  if (!CP.spec) CP.spec = DEF();
  ctx.stage("cp", `<section class="pane" id="cp-p"><div class="pane-h"><div class="t">Pipeline</div><div class="meta" id="cp-sum"></div>
        <div class="tools"><select class="sel sm" id="cp-load" title="Start from a built-in or saved pipeline"><option value="">Start from…</option></select><button class="btn ghost xs" id="cp-json" title="Show the pipeline as JSON (for agents and the Console)">JSON</button></div></div>
      <div class="pane-b" id="cp-form"></div>
      <div class="pane-f cp-foot"><div id="cp-check" class="cp-check"></div><div class="cp-btns"><input class="in sm" id="cp-seed" placeholder="Start with… (optional)" value="${esc(CP.seed)}"><button class="btn sm" id="cp-run">${icon("spark")} Generate</button><button class="btn ghost sm" id="cp-add" title="Add this pipeline to the comparison">+ Compare</button><button class="btn ghost sm" id="cp-save">Save…</button></div></div></section>
    <div class="col"><section class="pane grow" id="cp-outp"><div class="pane-h"><div class="t">Output</div><div class="meta" id="cp-outm"></div></div><div class="pane-b" id="cp-out">${empty("Build a pipeline, then Generate. Hover a word to see its probability and the scorer that gave it most.")}</div></section>
      <section class="pane grow" id="cp-cmpp"><div class="pane-h"><div class="t">Compare</div><div class="meta">scored on the same held-out text</div><div class="tools"><button class="btn sm" id="cp-cmp">${icon("bolt")} Compare</button></div></div><div class="pane-b" id="cp-cmpb"></div></section></div>`);
  $("#cp-json").onclick = () => { CP.json = !CP.json; renderForm(); };
  $("#cp-seed").oninput = (e) => CP.seed = e.target.value;
  $("#cp-run").onclick = runPipe; $("#cp-seed").onkeydown = (e) => { if (e.key === "Enter") runPipe(); };
  $("#cp-add").onclick = () => { CP.cmp.push({ name: pipeName(), spec: JSON.parse(JSON.stringify(CP.spec)) }); renderCmp(); };
  $("#cp-save").onclick = savePipe;
  $("#cp-cmp").onclick = runCmp;
  $("#cp-load").onchange = (e) => { const p = (CP.list || []).find((x) => x.name === e.target.value); if (p) { CP.spec = clean(p.pipeline); CP.from = p.name; renderForm(); } e.target.value = ""; };
  loadList(); renderForm(); renderCmp();
  if (CP.out) showOut(CP.out);
}
const clean = (p) => { const o = JSON.parse(JSON.stringify(p)); delete o._saved; return Object.assign(DEF(), o); };
function pipeName() {
  const base = CP.from ? CP.from + (CP.dirty ? " (changed)" : "") : "My pipeline";
  let n = base, i = 2;
  while (CP.cmp.some((c) => c.name === n)) n = `${base} ${i++}`;
  return n;
}
async function loadList() {
  try { CP.list = await call("text.pipeline.list"); } catch (e) { CP.list = []; }
  const s = $("#cp-load"); if (!s) return;
  s.innerHTML = `<option value="">Start from…</option><optgroup label="Built in">${CP.list.filter((p) => p.preset).map((p) => `<option>${esc(p.name)}</option>`).join("")}</optgroup>${CP.list.some((p) => !p.preset) ? `<optgroup label="Saved">${CP.list.filter((p) => !p.preset).map((p) => `<option>${esc(p.name)}</option>`).join("")}</optgroup>` : ""}`;
  if (!CP.cmp.length) { CP.cmp = ["Markov 3-gram", "Kneser-Ney 5-gram", "VectorLM blend"].map((n) => { const p = CP.list.find((x) => x.name === n); return p ? { name: n, spec: clean(p.pipeline) } : null; }).filter(Boolean); renderCmp(); }
}
function renderForm() {
  const p = CP.spec, f = $("#cp-form"); if (!f) return;
  if (CP.json) {
    f.innerHTML = `<textarea class="in mono cp-jsonta" id="cp-ta" spellcheck="false">${esc(JSON.stringify(p, null, 1))}</textarea>
      <div class="hint">Edit the JSON, or copy it for an agent: <code>text.pipeline.run</code> with <code>spec</code> = this object. Saved pipelines need only their name.</div>`;
    $("#cp-ta").oninput = (e) => { try { CP.spec = Object.assign(DEF(), JSON.parse(e.target.value)); CP.dirty = true; check(); } catch (err) { $("#cp-check").innerHTML = `<span class="bad">JSON: ${esc(err.message)}</span>`; } };
    check(); return;
  }
  const sub = p.tokenizer !== "word";
  const sc = p.scorers.map((s, i) => `<div class="cp-sc" data-i="${i}"><select class="sel sm" data-f="kind">${Object.entries(KINDS).map(([k, l]) => `<option value="${k}" ${s.kind === k ? "selected" : ""} ${sub && !["unigram", "ngram"].includes(k) ? "disabled" : ""}>${l}</option>`).join("")}</select>
      ${s.kind === "ngram" ? `<select class="sel sm" data-f="order">${[1, 2, 3, 4, 5, 6].filter((n) => sub || n <= 5).map((n) => `<option value="${n}" ${+s.order === n ? "selected" : ""}>${n}-gram</option>`).join("")}</select>` : ""}
      ${s.kind === "topic" ? `<input class="in sm" data-f="theme" placeholder="theme words" value="${esc(s.theme || "")}">` : ""}
      ${s.kind === "suffix" ? `<label class="dim cp-mini">from <input class="in sm" type="number" min="1" max="11" data-f="min_context" value="${s.min_context || 4}"> words</label>` : ""}
      <label class="cp-wt" title="${PROB.has(s.kind) ? "weight in the combination" : "steering strength"}">${PROB.has(s.kind) ? "weight" : "strength"} <input type="range" min="0" max="${PROB.has(s.kind) ? 2 : 8}" step="0.05" data-f="weight" value="${s.weight}"><span class="v">${s.weight}</span></label>
      <button class="iconbtn" data-del title="Remove">${icon("x")}</button><div class="hint cp-sch">${esc(KIND_HELP[s.kind])}</div></div>`).join("");
  const sm = p.sampling, cs = p.constraints;
  const rng = (o, k, l, mn, mx, st) => `<div class="fld"><label>${l}</label><input type="range" data-o="${o}" data-k="${k}" min="${mn}" max="${mx}" step="${st}" value="${p[o][k]}"><span class="v">${p[o][k]}</span></div>`;
  f.innerHTML = `<div class="cp-step"><div class="cp-n">1</div><div class="cp-c"><div class="cp-t">Tokenizer</div>
      <div class="seg" id="cp-tok">${["word", "bpe", "char"].map((k) => `<button data-t="${k}" class="${p.tokenizer === k ? "on" : ""}">${{ word: "Words", bpe: "BPE", char: "Characters" }[k]}</button>`).join("")}</div>
      ${p.tokenizer === "bpe" ? `<label class="dim cp-mini">merges <input class="in sm" type="number" min="50" max="8000" step="50" id="cp-merges" value="${p.merges}"></label>` : ""}
      <div class="hint">${sub ? "BPE and character pipelines count their n-grams on the card over the whole corpus (bounded by the memory of the card); only the n-gram and word-frequency scorers work with them. Never use and must include work on the spelling." : "Word pipelines use the VectorLM tables on the card: Kneser-Ney, the longest match, the neural LM and the embeddings."}</div></div></div>
    <div class="cp-step"><div class="cp-n">2</div><div class="cp-c"><div class="cp-t">Scorers <span class="seg sm" id="cp-comb"><button data-c="mix" class="${p.combine === "mix" ? "on" : ""}" title="weighted average of the probabilities (interpolation)">Mix</button><button data-c="product" class="${p.combine === "product" ? "on" : ""}" title="weighted sum of the log-probabilities (product of experts): a word must please every scorer">Product</button></span></div>
      ${sc}<button class="btn ghost xs" id="cp-addsc">+ Add a scorer</button></div></div>
    <div class="cp-step"><div class="cp-n">3</div><div class="cp-c"><div class="cp-t">Sampling rules</div><div class="cp-grid">
      ${rng("sampling", "temperature", "Temperature", 0, 2.5, 0.05)}${rng("sampling", "top_k", "Top-k (0 = off)", 0, 200, 1)}${rng("sampling", "top_p", "Top-p", 0.05, 1, 0.01)}${rng("sampling", "min_p", "Min-p", 0, 0.5, 0.01)}${rng("sampling", "repetition", "Repetition penalty", 0, 3, 0.1)}${rng("sampling", "no_repeat", "Block repeated n-grams of", 0, 6, 1)}</div></div></div>
    <div class="cp-step"><div class="cp-n">4</div><div class="cp-c"><div class="cp-t">Constraints</div><div class="cp-grid">
      ${rng("constraints", "length", "Length (tokens)", 5, sub ? 600 : 300, 5)}<div class="fld"><label>Stop</label><select class="sel sm" data-o="constraints" data-k="stop">${["none", "sentence", "paragraph"].map((k) => `<option value="${k}" ${cs.stop === k ? "selected" : ""}>${{ none: "at the length", sentence: "on a full stop", paragraph: "on a paragraph" }[k]}</option>`).join("")}</select></div>
      <div class="fld"><label>Never use</label><input class="in sm" data-o="constraints" data-k="ban" value="${esc((cs.ban || []).join(", "))}" placeholder="words, comma separated"></div>
      <div class="fld"><label>Must include</label><input class="in sm" data-o="constraints" data-k="include" value="${esc((cs.include || []).join(", "))}" placeholder="words"></div>
      <div class="fld"><label>End on a rhyme for</label><input class="in sm" data-o="constraints" data-k="rhyme" value="${esc(cs.rhyme || "")}" placeholder="a word (rhyme by spelling)" ${sub ? "disabled" : ""}></div></div></div></div>`;
  const dirty = () => { CP.dirty = true; check(); };
  $$("#cp-tok [data-t]").forEach((b) => b.onclick = () => { p.tokenizer = b.dataset.t; if (p.tokenizer !== "word") { p.scorers = p.scorers.filter((s) => ["unigram", "ngram"].includes(s.kind)); if (!p.scorers.length) p.scorers = [{ kind: "ngram", order: 4, weight: 1 }]; p.constraints.rhyme = ""; if (p.tokenizer === "char") p.constraints.length = Math.max(p.constraints.length, 240); } renderForm(); dirty(); });
  $$("#cp-comb [data-c]").forEach((b) => b.onclick = () => { p.combine = b.dataset.c; renderForm(); dirty(); });
  const m = $("#cp-merges"); if (m) m.onchange = () => { p.merges = +m.value; dirty(); };
  $("#cp-addsc").onclick = () => { p.scorers.push(sub ? { kind: "unigram", weight: 0.2 } : { kind: "neural", weight: 1 }); renderForm(); dirty(); };
  $$("#cp-form .cp-sc").forEach((row) => {
    const s = p.scorers[+row.dataset.i];
    row.querySelector("[data-del]").onclick = () => { p.scorers.splice(+row.dataset.i, 1); renderForm(); dirty(); };
    $$("[data-f]", row).forEach((e) => {
      const k = e.dataset.f;
      e.oninput = () => { s[k] = e.type === "range" || e.type === "number" || k === "order" ? +e.value : e.value; if (e.type === "range") e.nextElementSibling.textContent = e.value; if (k === "kind") { if (s.kind === "ngram") s.order = sub ? 4 : 5; if (s.kind === "topic" && !s.theme) s.theme = ""; renderForm(); } dirty(); };
      if (e.tagName === "SELECT") e.onchange = e.oninput;
    });
  });
  $$("#cp-form [data-o]").forEach((e) => {
    const o = e.dataset.o, k = e.dataset.k;
    const set = () => { p[o][k] = ["ban", "include"].includes(k) ? e.value.split(/[,\s]+/).filter(Boolean) : e.type === "range" ? +e.value : e.value; if (e.type === "range") e.nextElementSibling.textContent = e.value; dirty(); };
    e.oninput = set; if (e.tagName === "SELECT") e.onchange = set;
  });
  check();
}
async function check() {
  const ok = latest("cpchk");
  clearTimeout(CP.ct);
  CP.ct = setTimeout(async () => {
    try {
      const r = await call("text.pipeline.check", { spec: CP.spec });
      if (!ok()) return; CP.check = r;
      $("#cp-sum").textContent = r.summary || "";
      $("#cp-check").innerHTML = r.problems.length ? r.problems.map((x) => `<div class="bad">✕ ${esc(x)}</div>`).join("") : `<div class="good">✓ ready${r.warnings.length ? "" : " to run"}</div>` + r.warnings.map((x) => `<div class="warn">! ${esc(x)}</div>`).join("");
      $("#cp-run").disabled = !r.ok;
    } catch (e) { if (ok()) $("#cp-check").innerHTML = `<div class="bad">${esc(e.message)}</div>`; }
  }, 200);
}
async function runPipe() {
  const b = $("#cp-run"); b.disabled = true; $("#cp-outp").classList.add("is-busy");
  try {
    let r;
    try { r = await call("text.pipeline.run", { spec: CP.spec, seed: CP.seed }); }
    catch (e) { if (!/not answer|timed out/i.test(e.message)) throw e; r = await job("text.pipeline.run", { spec: CP.spec, seed: CP.seed }, $("#cp-out"), "Preparing the scorers"); }
    CP.out = r; showOut(r);
  } catch (e) { showErr($("#cp-out"), e); }
  b.disabled = false; $("#cp-outp").classList.remove("is-busy");
}
const EXP = { ngram: "o-ng", neural: "o-nn", suffix: "o-sx", unigram: "o-un" };
function showOut(r) {
  const el = $("#cp-out"); if (!el) return;
  const sub = r.pipeline.tokenizer !== "word";
  const toks = r.tokens.map((t) => {
    const w = sub ? t.w.replace(/▁/g, " ") : t.w;
    return `<span class="cp-w ${EXP[t.expert] || ""} ${t.match >= 8 ? "copy" : ""}" title="p = ${t.p} · from ${KINDS[t.expert] || t.expert}${t.match ? ` · matches ${t.match} words of the corpus` : ""}">${esc(w === "\n\n" ? "¶ " : w)}</span>`;
  }).join(sub ? "" : " ");
  const inc = Object.entries(r.include || {});
  el.innerHTML = `<div class="cp-text">${esc(r.text)}</div>
    <details class="cp-det"><summary>Each token, coloured by the scorer that gave it most</summary><div class="cp-toks">${toks}</div>
      <div class="hint"><span class="o-ng">■</span> n-gram <span class="o-nn">■</span> neural <span class="o-sx">■</span> longest match <span class="o-un">■</span> word frequency · underlined = inside a run of 8+ words copied from the corpus</div></details>
    ${inc.length ? `<div class="hint">Must include: ${inc.map(([w, ok]) => `${esc(w)} ${ok ? "✓" : "✕"}`).join(", ")}</div>` : ""}${r.rhymed != null ? `<div class="hint">Rhyme: ${r.rhymed ? "✓" : "✕ no rhyming word was possible"}</div>` : ""}
    ${(r.warnings || []).map((w) => `<div class="warn">! ${esc(w)}</div>`).join("")}`;
  $("#cp-outm").innerHTML = `${fmt.n(r.tokens.length)} tokens · ${fmt.n(r.tok_s, 0)} tokens/s <span class="timing">${fmt.ms(r.ms)}</span>`;
}
function renderCmp() {
  const el = $("#cp-cmpb"); if (!el) return;
  const chipsH = CP.cmp.length ? CP.cmp.map((c, i) => `<span class="chip">${esc(c.name)}<button class="iconbtn xs" data-rm="${i}" title="Remove">${icon("x")}</button></span>`).join("") : `<span class="dim">Add pipelines with “+ Compare”.</span>`;
  el.innerHTML = `<div class="cp-chips">${chipsH}</div><div id="cp-cmpr">${CP.cmpRes ? measureTable(CP.cmpRes.rows) + `<div class="hint">${esc(CP.cmpRes.note)}</div>` : `<div class="hint">Each pipeline: held-out perplexity of its model, then 4 samples scored for diversity, loops, copying and fluency, next to real held-out text.</div>`}</div>`;
  $$("#cp-cmpb [data-rm]").forEach((b) => b.onclick = () => { CP.cmp.splice(+b.dataset.rm, 1); renderCmp(); });
}
async function runCmp() {
  if (!CP.cmp.length) return toast("Add a pipeline first (+ Compare)");
  const specs = {}; CP.cmp.forEach((c) => specs[c.name] = c.spec);
  try { CP.cmpRes = await job("text.pipeline.compare", { pipelines: [], specs, samples: 4, eval_tokens: 1000, seed: CP.seed }, $("#cp-cmpr"), `Scoring ${CP.cmp.length} pipeline(s)`); }
  catch (e) { if (!e.cancelled) fail(e); }
  renderCmp();
}
async function savePipe() {
  const name = prompt("Save this pipeline as:", CP.from && !(CP.list || []).find((x) => x.name === CP.from && x.preset) ? CP.from : "");
  if (!name) return;
  try { await call("text.pipeline.save", { name, spec: CP.spec }); CP.from = name; CP.dirty = false; toast(`Saved. Agents and the Console can now run it: text.pipeline.run --pipeline "${name}"`, "good", 6000); loadList(); } catch (e) { fail(e); }
}
