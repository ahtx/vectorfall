import { go, toast } from "./core.js";
import { menu } from "./hub.js";

// The call behind a UI action, written out for the other ways in: Console code (vf.run / vf.solve), an MCP tools/call
// for an agent, curl against /v1, and the vf command line. Used by the labs ("Copy as…") and the Models page.
// model -> [vf.solve function, text arguments first, every argument it takes] (mirrors app/vfh.py _Solve)
const SOLVE = {
  "plan.roster": ["roster", ["people", "shifts"], "people shifts rest one_a_day fair prefer effort"],
  "plan.route": ["route", ["stops", "costs"], "stops costs unit round_trip effort"],
  "plan.teams": ["teams", ["people"], "people k pairs balance mix effort"],
  "sim.budget": ["budget", ["items"], "items budget sims correlation seed"],
  "forecast.project": ["project", ["tasks"], "tasks deadline"],
  "forecast.queue": ["queue", [], "arrivals service servers hours"],
  "sim.history": ["history", ["series"], "series horizon threshold"],
};

const clean = (p) => Object.fromEntries(Object.entries(p || {}).filter(([, v]) => v !== null && v !== undefined && v !== ""));
function py(v) {
  if (typeof v === "string") return v.includes("\n") ? `"""${v.replace(/"""/g, '\\"\\"\\"')}"""` : JSON.stringify(v);
  if (typeof v === "boolean") return v ? "True" : "False";
  if (v && typeof v === "object") return JSON.stringify(v).replace(/\btrue\b/g, "True").replace(/\bfalse\b/g, "False").replace(/\bnull\b/g, "None");
  return String(v);
}
const shq = (v) => { const s = typeof v === "string" ? v : Array.isArray(v) ? v.join(",") : JSON.stringify(v); return /^[\w.,:/@%+=-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'"; };

export function consoleCode(model, params) {
  const p = clean(params), s = SOLVE[model];
  if (s && Object.keys(p).every((k) => s[2].split(" ").includes(k))) {
    const [fn, pos] = s;
    const args = [...pos.filter((k) => p[k]).map((k) => `${k}=${py(p[k])}`), ...Object.entries(p).filter(([k]) => !pos.includes(k)).map(([k, v]) => `${k}=${py(v)}`)];
    return `r = vf.solve.${fn}(${args.join(", ")})\nprint(r)`;
  }
  return `r = vf.run(${JSON.stringify(model)}${Object.entries(p).map(([k, v]) => `, ${k}=${py(v)}`).join("")})\nprint(r)`;
}
export function mcpCall(model, params) { return JSON.stringify({ name: model.replace(/\./g, "_"), arguments: clean(params) }, null, 1); }
export function curlCall(model, params, long = true) {
  return `curl -s -X POST ${location.origin}/v1/models/${model}${long ? "?async=1" : ""} \\\n  -H 'Content-Type: application/json' \\\n  -d ${shq(JSON.stringify(clean(params)))}`;
}
export function cliCall(model, params) { return `vf run ${model}${Object.entries(clean(params)).map(([k, v]) => ` --${k} ${shq(v)}`).join("")}`; }

export function copyText(t, what = "Copied") {
  const done = () => toast(what, "good", 1600);
  try { navigator.clipboard.writeText(t).then(done, () => fallback(t, done)); } catch (e) { fallback(t, done); }
}
function fallback(t, done) {
  const ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); done(); } catch (e) { toast("Copy failed", "bad"); }
  ta.remove();
}
// Console picks this up when it opens (console.js show())
export function openInConsole(code) {
  try { sessionStorage.setItem("vf-console-insert", code); } catch (e) { /* storage off */ }
  go("console");
}
export function callMenu(anchor, model, params, long = true) {
  menu(anchor, [
    { icon: "console", label: "Open in the Console", sub: "the one-line call, ready to run and edit", run: () => openInConsole(consoleCode(model, params)) },
    { icon: "console", label: "Copy as Console code", sub: "vf.solve / vf.run", run: () => copyText(consoleCode(model, params), "Console code copied") },
    { icon: "bolt", label: "Copy as an MCP call", sub: "tools/call for an AI agent", run: () => copyText(mcpCall(model, params), "MCP call copied") },
    { icon: "down", label: "Copy as curl", sub: "REST /v1", run: () => copyText(curlCall(model, params, long), "curl copied") },
    { icon: "text", label: "Copy as a vf command", sub: "the command line", run: () => copyText(cliCall(model, params), "vf command copied") },
  ]);
}
