import { $, $$, esc, fail, fmt, go, icon, pane, toast } from "./core.js";
import { callModel, describeModel, modelForm, readModelForm, wireModelForm } from "./hub.js";
import { consoleCode, openInConsole } from "./callcopy.js";

// Models: every VectorFall operation as a model you can run here, from the command line (vf run …), over REST/OpenAPI,
// JSON-RPC 2.0 or MCP — one registry on the server, so all five run the same code. Left: the catalogue. Middle: the
// model's own form (generated from its fields) and the result. Right: the same call, ready to paste elsewhere.
const ST = { list: null, groups: {}, cur: null, m: null, q: "", how: "vf", last: null, params: {} };
const DEV = { gpu: "GPU", mixed: "GPU + CPU", cpu: "CPU" };

export default {
  id: "models", title: "Models", sub: "every operation — CLI, OpenAPI, JSON-RPC, MCP", icon: "bolt",
  mount(el) {
    el.innerHTML = `<div class="ws side-lr md">
      <div class="col">
        <section class="pane grow"><div class="pane-h"><div class="t">Models</div><div class="meta" id="md-n"></div></div>
          <div class="sec"><input class="in sm" id="md-q" placeholder="Find a model… (name, title, what it does)" autocomplete="off"></div>
          <div class="pane-b flush" id="md-list"></div>
          <div class="pane-f" id="md-dev"></div></section>
      </div>
      <div class="col">
        <section class="pane fit md-head"><div class="md-ttl"><div class="nm" id="md-name">—</div><h2 id="md-title">Choose a model</h2><p id="md-sum"></p></div>
          <div class="md-tags" id="md-tags"></div></section>
        <div class="md-main grow">
          <section class="pane"><div class="pane-h"><div class="t">Parameters</div><div class="meta" id="md-pm"></div>
            <div class="tools"><button class="btn ghost xs" id="md-reset" title="Back to the defaults">${icon("undo")} Defaults</button><button class="btn ghost xs" id="md-app" hidden>${icon("eye")} Open app</button></div></div>
            <div class="pane-b"><div class="fields" id="md-form"><div class="empty">Pick a model on the left.</div></div></div>
            <div class="pane-act"><button class="btn block" id="md-go" disabled>${icon("bolt")} Run on the card</button><div class="hint" id="md-time">&nbsp;</div></div></section>
          <section class="pane"><div class="pane-h"><div class="t">Result</div><div class="meta" id="md-rm"></div>
            <div class="tools"><button class="btn ghost xs" id="md-dl" hidden>${icon("down")} Save</button><button class="btn ghost xs" id="md-copy" hidden>Copy JSON</button></div></div>
            <div class="pane-b" id="md-res"><div class="empty">The result appears here — with how long it took and how much of that was on the GPU.</div></div></section>
        </div>
      </div>
      <div class="col">
        <section class="pane grow"><div class="pane-h"><div class="t">Call it from</div></div>
          <div class="sec"><div class="seg md-how" id="md-how">${[["vf", "Console"], ["cli", "CLI"], ["curl", "REST"], ["rpc", "JSON-RPC"], ["py", "Python"], ["mcp", "MCP"]].map(([k, n]) => `<button data-h="${k}">${n}</button>`).join("")}</div></div>
          <div class="pane-b"><pre class="md-code" id="md-code"></pre><div class="hint" id="md-howh"></div></div>
          <div class="pane-act"><button class="btn ghost sm block" id="md-cc">Copy</button><button class="btn ghost sm block" id="md-oc" title="The Console call in a new editor buffer, ready to run">${icon("console")} Open in the Console</button>
            <div class="md-links"><a href="/v1/docs" target="_blank">OpenAPI docs</a> · <a href="/v1/openapi.json" target="_blank">openapi.json</a> · <a href="/v1/openrpc.json" target="_blank">openrpc.json</a> · <a href="/v1/cli" download="vf">vf (CLI)</a></div></div></section>
      </div>
    </div>`;
    $("#md-q").oninput = () => { ST.q = $("#md-q").value.trim().toLowerCase(); renderList(); };
    $("#md-go").onclick = run;
    $("#md-reset").onclick = () => openModel(ST.cur, {});
    $("#md-app").onclick = () => ST.m && ST.m.app && go(ST.m.app);
    $$("#md-how [data-h]").forEach((b) => b.onclick = () => { ST.how = b.dataset.h; snippet(); });
    $("#md-cc").onclick = () => copy($("#md-code").textContent);
    $("#md-oc").onclick = async () => { if (!ST.m) return; const p = await params(); if (p._error) { toast(p._error, "bad"); return; } openInConsole(consoleCode(ST.m.name, p)); };
    $("#md-copy").onclick = () => copy(JSON.stringify(ST.last && ST.last.result, null, 1));
    $("#md-form").addEventListener("input", () => { clearTimeout(ST.t); ST.t = setTimeout(snippet, 200); });
    $("#md-form").addEventListener("change", () => snippet());
    boot();
  },
  show(p = {}) { if (p.m) { const pre = {}; Object.keys(p).forEach((k) => { if (k.startsWith("p_")) pre[k.slice(2)] = p[k]; }); if (ST.list) openModel(p.m, pre); else ST.want = [p.m, pre]; } },
};

async function boot() {
  try { const r = await (await fetch("/v1/models")).json(); ST.list = r.models; ST.groups = r.groups; } catch (e) { fail(e); return; }
  const n = ST.list.length, by = (d) => ST.list.filter((m) => m.device === d).length;
  $("#md-n").textContent = n + " models";
  $("#md-dev").innerHTML = `<span><b>${by("gpu")}</b> GPU</span><span><b>${by("mixed")}</b> GPU + CPU</span><span><b>${by("cpu")}</b> CPU (lists, files, downloads)</span>`;
  renderList();
  const w = ST.want || [ST.cur || "sim.budget", {}];
  ST.want = null;
  openModel(w[0], w[1]);
}

function renderList() {
  const q = ST.q, groups = {};
  ST.list.filter((m) => !q || (m.name + " " + m.title + " " + m.summary).toLowerCase().includes(q)).forEach((m) => (groups[m.group] = groups[m.group] || []).push(m));
  $("#md-list").innerHTML = Object.keys(groups).length ? Object.entries(groups).map(([g, ms]) => `<div class="md-g">${esc((ST.groups[g] || {}).title || g)}</div>` +
    ms.map((m) => `<div class="li${m.name === ST.cur ? " on" : ""}" data-m="${esc(m.name)}"><div class="tx"><div class="nm">${esc(m.title)}</div><div class="sub mono">${esc(m.name)}</div></div><span class="md-dev ${m.device}">${DEV[m.device]}</span></div>`).join("")).join("")
    : `<div class="empty">No model matches “${esc(q)}”.</div>`;
  $$("#md-list [data-m]").forEach((x) => x.onclick = () => openModel(x.dataset.m, {}));
}

async function openModel(name, preset = {}) {
  let m;
  try { m = await describeModel(name); } catch (e) { toast(e.message, "bad"); return; }
  ST.cur = name; ST.m = m; ST.last = null;
  $$("#md-list [data-m]").forEach((x) => x.classList.toggle("on", x.dataset.m === name));
  const on = $(`#md-list [data-m="${CSS.escape(name)}"]`); if (on) on.scrollIntoView({ block: "nearest" });
  $("#md-name").textContent = m.name;
  $("#md-title").textContent = m.title;
  $("#md-sum").textContent = m.summary || "";
  $("#md-tags").innerHTML = [`<span class="md-dev ${m.device}">${DEV[m.device]}</span>`, m.long ? `<span class="tag">background job</span>` : "", m.mutating ? `<span class="tag warn">changes stored data</span>` : "", m.output !== "json" ? `<span class="tag">returns ${esc(m.output)}</span>` : ""].join("");
  $("#md-pm").textContent = m.fields.length ? m.fields.length + " fields" : "no parameters";
  const fields = m.fields.map((f) => preset[f.k] != null ? Object.assign({}, f, { default: f.type === "int" || f.type === "float" ? +preset[f.k] : preset[f.k] }) : f);
  $("#md-form").innerHTML = fields.length ? modelForm(fields) : `<div class="hint">This model takes no parameters.</div>`;
  await wireModelForm($("#md-form"), m.fields);
  $("#md-app").hidden = !m.app;
  $("#md-go").disabled = false;
  $("#md-go").innerHTML = `${icon("bolt")} ${m.device === "cpu" ? "Run" : "Run on the card"}`;
  $("#md-res").innerHTML = `<div class="empty">The result appears here — with how long it took and how much of that was on the GPU.</div>`;
  $("#md-rm").textContent = ""; $("#md-time").innerHTML = "&nbsp;"; $("#md-dl").hidden = $("#md-copy").hidden = true;
  snippet();
}

async function params() {
  try { return await readModelForm($("#md-form"), ST.m.fields); } catch (e) { return { _error: e.message }; }
}

// ---------------------------------------------------------------- run, through /v1 like any other client
async function run() {
  const m = ST.m, p = await params();
  if (p._error) { toast(p._error, "bad"); return; }
  if (m.mutating && !confirm(`${m.title} changes stored data. Run it?`)) return;
  const btn = $("#md-go"), t0 = performance.now();
  btn.disabled = true; $("#md-res").classList.add("is-busy"); $("#md-time").textContent = m.long ? "starting a background job…" : "running…";
  try {
    const r = await callModel(m.name, p, { onStep: (j) => { $("#md-time").textContent = `${Math.round((j.progress || 0) * 100)}% · ${j.message || ""}`; } });
    ST.last = r;
    show(r, performance.now() - t0);
  } catch (e) {
    $("#md-res").innerHTML = `<div class="md-err"><b>${esc(m.name)} refused</b><p>${esc(e.message)}</p></div>`;
    $("#md-time").textContent = "";
  } finally { btn.disabled = false; $("#md-res").classList.remove("is-busy"); }
}

function show(r, ms) {
  const t = r.timing || {}, res = r.result, b = r.blob;
  $("#md-time").innerHTML = `<span class="timing">${fmt.ms(t.wall_ms != null ? t.wall_ms : ms)}</span> · ${fmt.ms(t.gpu_ms)} on the GPU in ${t.gpu_runs || 0} run${t.gpu_runs === 1 ? "" : "s"}`;
  $("#md-rm").textContent = b ? `${b.type} · ${fmt.bytes(b.size)}` : Array.isArray(res) ? res.length + " items" : "";
  let h = "";
  if (res && typeof res === "object" && !Array.isArray(res) && (res.headline || res.sentence)) {
    h += `<section class="sm-verdict md-verdict"><div class="hl ${esc(res.tone || "")}">${esc(res.headline || "")}</div><div class="txt"><p>${esc(res.sentence || "")}</p>${res.check ? `<p class="dw-check">${esc(res.check)}</p>` : ""}</div></section>`;
  }
  if (b) {
    if (b.type.startsWith("image/")) h += `<div class="md-img"><img src="${b.url}" alt="result"></div>`;
    else if (b.type.startsWith("audio/")) h += `<audio controls src="${b.url}" class="md-audio"></audio>`;
    else h += `<div class="hint">${esc(b.type)} — use Save.</div>`;
    if (b.meta && Object.keys(b.meta).length) h += `<pre class="md-json">${jsonView(b.meta)}</pre>`;
  }
  const pics = [];
  if (res != null) {
    h += `<pre class="md-json">${jsonView(res, pics)}</pre>`;
  }
  if (pics.length) h = `<div class="md-pics">${pics.slice(0, 8).map((u) => `<img src="${u}">`).join("")}</div>` + h;
  $("#md-res").innerHTML = h || `<div class="hint">Done (no output).</div>`;
  $("#md-dl").hidden = !b; $("#md-copy").hidden = res == null;
  if (b) $("#md-dl").onclick = () => { const a = document.createElement("a"); a.href = b.url; a.download = b.name || ST.cur.replace(/\./g, "-") + "." + (b.type.split("/")[1] || "bin"); a.click(); };
}

// compact JSON: long arrays and data-URLs folded (pictures inside the result are shown above it instead)
function jsonView(v, pics = [], depth = 0) {
  const pad = "  ".repeat(depth);
  if (v == null) return `<span class="n">null</span>`;
  if (typeof v === "string") {
    if (v.startsWith("data:image/")) { pics.push(v); return `<span class="s">"[picture ${pics.length}]"</span>`; }
    const s = v.length > 300 ? v.slice(0, 300) + "… (" + v.length + " chars)" : v;
    return `<span class="s">${esc(JSON.stringify(s))}</span>`;
  }
  if (typeof v === "number") return `<span class="d">${Number.isInteger(v) ? v : +v.toPrecision(6)}</span>`;
  if (typeof v === "boolean") return `<span class="d">${v}</span>`;
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    if (v.every((x) => typeof x === "number")) return `[${v.slice(0, 24).map((x) => jsonView(x)).join(", ")}${v.length > 24 ? `, <span class="c">… ${v.length - 24} more</span>` : ""}]`;
    const shown = v.slice(0, depth > 1 ? 4 : 12);
    return `[\n${shown.map((x) => pad + "  " + jsonView(x, pics, depth + 1)).join(",\n")}${v.length > shown.length ? `,\n${pad}  <span class="c">… ${v.length - shown.length} more</span>` : ""}\n${pad}]`;
  }
  const ks = Object.keys(v);
  if (!ks.length) return "{}";
  if (depth > 4) return `<span class="c">{…}</span>`;
  return `{\n${ks.map((k) => `${pad}  <span class="k">${esc(JSON.stringify(k))}</span>: ${jsonView(v[k], pics, depth + 1)}`).join(",\n")}\n${pad}}`;
}

// ---------------------------------------------------------------- the same call, elsewhere
async function snippet() {
  if (!ST.m) return;
  $$("#md-how [data-h]").forEach((b) => b.classList.toggle("on", b.dataset.h === ST.how));
  const m = ST.m, p = await params();
  if (p._error) { $("#md-code").textContent = p._error; return; }
  const host = location.origin, shq = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return /^[\w.,:/@%+=-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'"; };
  const files = m.fields.filter((f) => f.type === "file" && p[f.k]).map((f) => f.k);
  const pj = JSON.stringify(Object.fromEntries(Object.entries(p).map(([k, v]) => [k, files.includes(k) ? "<base64 of the file>" : v])));
  const bin = m.output !== "json", tool = m.name.replace(/\./g, "_");
  const code = {
    vf: consoleCode(m.name, p),
    cli: `vf run ${m.name}${Object.entries(p).map(([k, v]) => files.includes(k) ? ` --${k} @path/to/file` : ` --${k} ${shq(Array.isArray(v) ? v.join(",") : v)}`).join("")}${bin ? " --out result." + m.output.split("/")[1] : ""}`,
    curl: `curl -X POST ${host}/v1/models/${m.name}${m.long ? "?async=1" : ""} \\\n  -H 'Content-Type: application/json' \\\n  -d ${shq(pj)}${bin && !m.long ? " -o result." + m.output.split("/")[1] : ""}`,
    rpc: `POST ${host}/v1/rpc\n${JSON.stringify({ jsonrpc: "2.0", id: 1, method: m.long ? "vf.start" : m.name, params: m.long ? { model: m.name, params: JSON.parse(pj) } : JSON.parse(pj) }, null, 1)}`,
    py: `import json, urllib.request\nreq = urllib.request.Request("${host}/v1/models/${m.name}${m.long ? "?async=1" : bin ? "?json=1" : ""}",\n    data=json.dumps(${pj}).encode(), headers={"Content-Type": "application/json"})\nout = json.load(urllib.request.urlopen(req))\nprint(out${m.long ? '["job"]["id"]   # then GET /v1/jobs/<id>' : '["result"], out["timing"]'})`,
    mcp: `MCP server: ${host}/mcp   (streamable HTTP)\ntools/call\n${JSON.stringify({ name: tool, arguments: JSON.parse(pj) }, null, 1)}`,
  }[ST.how];
  $("#md-code").textContent = code;
  $("#md-howh").textContent = {
    vf: "In the Console: vf.run (any model) or vf.solve (the solvers, which take the same text as the labs). Ctrl+Space completes names and parameters.",
    cli: "The vf command: download it below (one Python file, no packages). Set VF_URL to this server. vf describe " + m.name + " lists every parameter.",
    curl: m.long ? "A background job: poll GET /v1/jobs/<id> until the state is done." : bin ? "The response body is the " + m.output + " itself; timing is in the X-VF-Timing header." : "The response is {model, result, timing}.",
    rpc: "JSON-RPC 2.0 by name; batches work too. rpc.discover returns the OpenRPC document for all models.",
    py: "Standard library only. ?json=1 returns binary results as base64 inside the JSON.",
    mcp: "Add " + host + "/mcp to an MCP client (Claude Desktop, Claude Code or any other): every model is a tool, named with _ instead of dots.",
  }[ST.how];
}

function copy(t) {
  try { navigator.clipboard.writeText(t); toast("Copied"); } catch (e) { toast("Copy failed — select the text instead", "bad"); }
}
