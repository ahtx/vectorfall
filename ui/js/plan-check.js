// Planner input check: reads the tables exactly as app/planner.py will (csv.Sniffer over , ; tab |, lower-cased headers,
// columns matched by prefix in a fixed order), applies the user's column mapping, and reports what was understood —
// roles, ignored columns, missing or unreadable values, and what the data implies — before anything is solved.
// outgoing() rewrites a mapped table into the column names the server matches, so no backend change is needed.

// ---------------------------------------------------------------- roles: [role, aliases (planner.py _col order), canonical name, required]
export const ROLES = {
  roster: {
    people: [["name", ["name", "person"], "name"], ["max", ["max"], "max_shifts"], ["min", ["min"], "min_shifts"], ["skills", ["skill"], "skills"],
      ["unavailable", ["unavail", "off", "cannot", "can't"], "unavailable"], ["prefers", ["prefer", "like"], "prefers"]],
    shifts: [["shift", ["shift", "name"], "shift"], ["day", ["day", "date"], "day", true], ["start", ["start", "from"], "start", true],
      ["end", ["end", "to", "until"], "end", true], ["needed", ["need", "people", "staff", "count"], "needed"], ["skill", ["skill", "requires"], "skill"]],
  },
  route: { stops: [["name", ["name", "stop", "place"], "name"], ["lat", ["lat"], "lat"], ["lon", ["lon", "lng", "long"], "lon"], ["x", ["x"], "x"], ["y", ["y"], "y"],
    ["address", ["address", "addr", "location", "where"], "address"]] },
  teams: { people: [["name", ["name", "person"], "name"], ["score", null, null], ["category", null, null]] },
};
export const REFKEY = {
  "roster.people.name": "p.name", "roster.people.max": "p.max", "roster.people.min": "p.min", "roster.people.skills": "p.skills", "roster.people.unavailable": "p.unavailable",
  "roster.people.prefers": "p.prefers", "roster.shifts.shift": "s.shift", "roster.shifts.day": "s.day", "roster.shifts.start": "s.start", "roster.shifts.end": "s.end",
  "roster.shifts.needed": "s.needed", "roster.shifts.skill": "s.skill", "route.stops.name": "r.name", "route.stops.lat": "r.latlon", "route.stops.lon": "r.latlon",
  "route.stops.x": "r.xy", "route.stops.y": "r.xy", "route.stops.address": "r.address", "teams.people.name": "t.name", "teams.people.score": "t.score", "teams.people.category": "t.category",
};
export const NONE = "∅";                        // a mapping value meaning "no column for this role"

// ---------------------------------------------------------------- CSV, the way Python reads it
function sniff(text) {
  const lines = text.slice(0, 4000).split(/\r?\n/).filter((l) => l.trim()).slice(0, 30);
  let best = ",", bs = 0;
  for (const d of [",", "\t", ";", "|"]) {                // Python's preferred order breaks ties
    const counts = lines.map((l) => { let n = 0, q = false; for (const c of l) { if (c === '"') q = !q; else if (c === d && !q) n++; } return n; });
    const freq = {}; counts.forEach((c) => { if (c) freq[c] = (freq[c] || 0) + 1; });
    const top = Math.max(0, ...Object.values(freq));
    const s = lines.length ? top / lines.length : 0;
    if (s > bs + 1e-9) { bs = s; best = d; }
  }
  return best;
}
function parseRows(text, d) {
  const out = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"' && f.trim() === "") { q = true; f = ""; }
    else if (c === d) { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); out.push(row); row = []; f = ""; }
    else f += c;
  }
  row.push(f); out.push(row);
  return out.filter((r) => r.some((c) => c.trim()));
}
export function readCSV(text) {
  text = (text || "").trim();
  if (!text) return { head: [], rows: [], raw: [] };
  const raw = parseRows(text, sniff(text));
  if (!raw.length) return { head: [], rows: [], raw: [] };
  const head = raw[0].map((h) => h.trim().toLowerCase());
  const rows = raw.slice(1).map((r) => { const o = {}; head.forEach((h, i) => { o[h] = i < r.length ? r[i].trim() : ""; }); return o; });
  return { head, rows, raw };
}
const col = (head, names) => { for (const n of names) for (const h of head) if (h === n || h.startsWith(n)) return h; return null; };
export const num = (v) => { const s = String(v ?? "").replace(/,/g, "").trim(); if (!s) return null; const x = Number(s); return Number.isFinite(x) ? x : null; };
const tags = (v) => (v || "").split(/[;|/]/).map((t) => t.trim().toLowerCase()).filter(Boolean);
function hm(v) {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/.exec((v || "").toLowerCase());
  if (!m) return null;
  let h = +m[1]; const mi = +(m[2] || 0);
  if (m[3] === "pm" && h < 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  return h + mi / 60;
}
const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function ymd(y, m, d) { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t : null; }
export function parseDate(s) {                       // the formats sources.parse_date accepts (the common ones)
  s = (s || "").trim(); let m;
  if (!s) return null;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/.exec(s))) { const y = m[3].length === 2 ? 2000 + +m[3] - (+m[3] >= 69 ? 100 : 0) : +m[3]; return ymd(y, +m[1], +m[2]) || (m[3].length === 4 ? ymd(y, +m[2], +m[1]) : null); }
  if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s))) return ymd(+m[3], +m[2], +m[1]);
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = /^([a-z]{3})[a-z]*\s+(\d{1,2})\s+(\d{4})$/i.exec(s)) && MON.includes(m[1].toLowerCase())) return ymd(+m[3], MON.indexOf(m[1].toLowerCase()) + 1, +m[2]);
  if ((m = /^(\d{1,2})\s+([a-z]{3})[a-z]*\s+(\d{4})$/i.exec(s)) && MON.includes(m[2].toLowerCase())) return ymd(+m[3], MON.indexOf(m[2].toLowerCase()) + 1, +m[1]);
  return null;
}
const WD = [["sun", "sunday"], ["mon", "monday"], ["tue", "tuesday"], ["wed", "wednesday"], ["thu", "thursday"], ["fri", "friday"], ["sat", "saturday"]];

// ---------------------------------------------------------------- roles: what the server would pick, then the user's mapping
function teamAuto(t, nameCol) {
  const n = t.rows.length;
  const score = t.head.find((h) => h !== nameCol && t.rows.some((r) => (r[h] || "").trim()) && t.rows.every((r) => !(r[h] || "").trim() || num(r[h]) != null)) || null;
  const cat = t.head.find((h) => h !== nameCol && h !== score && (() => { const k = new Set(t.rows.map((r) => r[h] ?? "")).size; return k > 1 && k <= Math.max(2, Math.floor(n / 2)); })()) || null;
  return { score, category: cat };
}
export function resolve(kind, field, text, map = {}) {
  const t = readCSV(text), defs = ROLES[kind][field] || [];
  const auto = {}, roles = {}, notes = [];
  defs.forEach(([r, al]) => { if (al) auto[r] = col(t.head, al); });
  if (kind === "teams") Object.assign(auto, teamAuto(t, auto.name));
  let mapped = false;
  defs.forEach(([r]) => {
    const m = map[r];
    if (m === NONE) { roles[r] = null; mapped = true; }
    else if (m && t.head.includes(m)) { roles[r] = m; if (m !== auto[r]) mapped = true; }
    else { roles[r] = auto[r] ?? null; if (m) notes.push(`your map ${r} → “${m}” is not a column now. The Planner uses ${auto[r] ? "“" + auto[r] + "”" : "nothing"}.`); }
  });
  if (kind === "teams" && !mapped) Object.assign(roles, teamAuto(t, roles.name));
  const used = new Set(Object.values(roles).filter(Boolean));
  return { ...t, auto, roles, mapped, notes, ignored: t.head.filter((h) => !used.has(h)) };
}
const q = (v) => /[",\n\r;|\t]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
// the text the server gets: the user's own text, or — when a mapping changes anything — the same table renamed to our columns
export function outgoing(kind, field, text, map = {}) {
  if (kind === "teams" && field === "pairs") return text;
  const R = resolve(kind, field, text, map);
  if (!R.mapped) return text;
  const defs = ROLES[kind][field];
  let cols;
  if (kind === "teams") {
    const sc = R.roles.score, ca = R.roles.category;
    cols = [];
    if (R.roles.name) cols.push(["name", (r) => r[R.roles.name]]);
    if (sc) cols.push([/^(name|person)/.test(sc) ? "score_" + sc : sc, (r) => r[sc]]);
    if (ca) {
      const numeric = !sc && R.rows.every((r) => !(r[ca] || "").trim() || num(r[ca]) != null);      // would be read as the score: make it text
      cols.push([/^(name|person)/.test(ca) ? "cat_" + ca : ca, (r) => numeric && (r[ca] || "").trim() ? `${ca} ${r[ca]}` : r[ca]]);
    }
  } else cols = defs.filter(([r]) => R.roles[r]).map(([r, , canon]) => [canon, (row) => row[R.roles[r]]]);
  if (!cols.length) return text;
  return [cols.map(([h]) => q(h)).join(","), ...R.rows.map((r) => cols.map(([, f]) => q(f(r) ?? "")).join(","))].join("\n");
}

// ---------------------------------------------------------------- the checks
const M = (lvl, text) => ({ lvl, text });
const list = (a, n = 4) => a.slice(0, n).join(", ") + (a.length > n ? ` and ${a.length - n} more` : "");
const plural = (n, a, b = a + "s") => `${n} ${n === 1 ? a : b}`;

export function check(kind, inputs, rules, maps = {}) {
  const out = {};
  const R = (f) => resolve(kind, f, inputs[f] || "", (maps || {})[f] || {});
  if (kind === "roster") {
    const p = R("people"), s = R("shifts"), pm = [], sm = [], pf = [], sf = [];
    if (!p.rows.length) pm.push(M("err", "No people yet — a header row and at least one person."));
    if (!s.rows.length) sm.push(M("err", "No shifts yet — a header row and at least one shift."));
    const pr = p.roles, sr = s.roles;
    if (p.rows.length && !pr.name) pm.push(M("warn", "There is no name column. The people will show as person 1, 2…"));
    for (const r of ["day", "start", "end"]) if (s.rows.length && !sr[r]) sm.push(M("err", `No ${r} column — shifts need day, start and end. Pick one in the roles above.`));
    const names = p.rows.map((r, i) => (pr.name && r[pr.name]) || `person ${i + 1}`);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    if (dupes.length) pm.push(M("warn", `The same name shows two times: ${list([...new Set(dupes)])}. The Planner keeps them as different people.`));
    const badN = (c, what) => { if (!c) return; const b = p.rows.map((r, i) => [names[i], r[c]]).filter(([, v]) => v && num(v) == null); if (b.length) pm.push(M("warn", `${what} is not a number for ${list(b.map(([n, v]) => `${n} (“${v}”)`))}. The Planner uses ${what === "max" ? "no limit" : "0"}.`)); };
    badN(pr.max, "max"); badN(pr.min, "min");
    // shifts
    const S = [], days = [], badT = [];
    s.rows.forEach((r, i) => {
      const day = sr.day ? r[sr.day] : "";
      if (!days.includes(day)) days.push(day);
      const st = sr.start ? hm(r[sr.start]) : null, en = sr.end ? hm(r[sr.end]) : null;
      if (sr.start && st == null) badT.push(`row ${i + 2} start “${r[sr.start]}”`);
      if (sr.end && en == null) badT.push(`row ${i + 2} end “${r[sr.end]}”`);
      const nd = sr.needed ? num(r[sr.needed]) : 1;
      S.push({ name: (sr.shift && r[sr.shift]) || `shift ${i + 1}`, day, date: parseDate(day), start: st, end: en, need: Math.max(0, Math.trunc(nd == null ? 1 : nd)),
        skill: sr.skill ? (r[sr.skill] || "").trim().toLowerCase() : "", badNeed: sr.needed && r[sr.needed] && nd == null ? r[sr.needed] : null });
    });
    if (badT.length) sm.push(M("err", `The Planner cannot read ${plural(badT.length, "time")}: ${list(badT)}. Use 07:00, 7 or 7pm.`));
    const bn = S.filter((x) => x.badNeed); if (bn.length) sm.push(M("warn", `needed is not a number for ${list(bn.map((x) => `${x.day} ${x.name} (“${x.badNeed}”)`))}. The Planner uses 1.`));
    const ok = S.length && !badT.length && sr.day && sr.start && sr.end;
    const K = S.reduce((a, x) => a + x.need, 0);
    const dated = S.length && S.every((x) => x.date);
    if (S.length) sf.push(`${plural(S.length, "shift")} on ${plural(days.length, "day")}${dated ? " (dates)" : ""} · ${plural(K, "seat")} to fill`);
    if (K > 600) sm.push(M("err", `${K} seats is more than the solver holds (600) — plan a shorter period.`));
    if (S.length && !dated && S.some((x) => x.date)) sm.push(M("warn", "Some days are dates and some are not. Thus the Planner counts the days in the order that they show, not by the calendar."));
    if (!dated && days.length > 1) sf.push(`days in this order: ${list(days, 8)}`);
    // who can work what
    const skills = p.rows.map((r) => new Set(pr.skills ? tags(r[pr.skills]) : []));
    const unav = p.rows.map((r) => pr.unavailable ? tags(r[pr.unavailable]) : []);
    const pref = p.rows.map((r) => pr.prefers ? tags(r[pr.prefers]) : []);
    const keys = S.map((x) => { const k = new Set([x.name.toLowerCase(), x.day.toLowerCase(), `${x.day} ${x.name}`.toLowerCase()]); if (x.date) WD[x.date.getUTCDay()].forEach((w) => k.add(w)); return k; });
    const allKeys = new Set(keys.flatMap((k) => [...k]));
    const stray = [];
    p.rows.forEach((_, i) => { for (const [arr, what] of [[unav[i], "unavailable"], [pref[i], "prefers"]]) for (const t of arr) if (!allKeys.has(t)) stray.push(`${names[i]}: ${what} “${t}”`); });
    if (stray.length && S.length) pm.push(M("warn", `${plural(stray.length, "tag")} ${stray.length === 1 ? "matches" : "match"} no shift, day${dated ? ", weekday" : ""} or “day shift”: ${list(stray)} — a typo, or a slash inside a date?`));
    const OK = p.rows.map((_, i) => S.map((x, j) => (!x.skill || skills[i].has(x.skill)) && !unav[i].some((t) => keys[j].has(t))));
    const elig = S.map((_, j) => OK.filter((row) => row[j]).length);
    const short = S.filter((x, j) => elig[j] < x.need).map((x) => `${x.day} ${x.name} (needs ${x.need}, ${elig[S.indexOf(x)]} eligible)`);
    if (short.length && p.rows.length) sm.push(M("warn", `Not sufficient people for these shifts: ${list(short)}.`));
    const noSkill = [...new Set(S.filter((x) => x.skill && !skills.some((k) => k.has(x.skill))).map((x) => x.skill))];
    if (noSkill.length && p.rows.length) sm.push(M("warn", `Nobody has the skill ${list(noSkill.map((k) => "“" + k + "”"))}.`));
    const idle = names.filter((_, i) => S.length && !OK[i].some(Boolean));
    if (idle.length) pm.push(M("warn", `${list(idle)} cannot work any of these shifts (skills or unavailable days).`));
    if (p.rows.length) pf.push(`${plural(p.rows.length, "person", "people")}${pr.skills ? ` · skills: ${list([...new Set(skills.flatMap((k) => [...k]))], 6) || "none"}` : ""}${pref.some((a) => a.length) ? ` · ${plural(pref.reduce((a, b) => a + b.length, 0), "wish", "wishes")}` : ""}`);
    // clashes: the same pairs planner.py writes into CONF
    let conf = null, capSum = null;
    if (ok && K <= 600) {
      const di = dated ? (() => { const d0 = Math.min(...S.map((x) => x.date.getTime())); return S.map((x) => Math.round((x.date.getTime() - d0) / 864e5)); })() : S.map((x) => days.indexOf(x.day));
      const t0 = S.map((x, j) => di[j] * 24 + x.start), t1 = S.map((x, j) => t0[j] + ((((x.end - x.start) % 24) + 24) % 24 || 24));
      const rest = +rules.rest || 0, one = !!rules.one_a_day;
      const clash = (a, b) => a === b || Math.max(t0[b] - t1[a], t0[a] - t1[b]) < rest || (one && di[a] === di[b]);
      const slot = S.flatMap((x, j) => Array(x.need).fill(j));
      conf = 0;
      for (let i = 0; i < slot.length; i++) for (let k = i + 1; k < slot.length; k++) if (clash(slot[i], slot[k])) conf++;
      if (conf > 20000) sm.push(M("err", `${conf.toLocaleString()} clash pairs of seats are too many for one model. Plan one or two weeks at a time.`));
      const maxs = p.rows.map((r) => { const v = pr.max ? num(r[pr.max]) : null; return v == null ? 1e6 : Math.trunc(v); });
      capSum = p.rows.reduce((a, _, i) => a + Math.min(maxs[i], slot.filter((j) => OK[i][j]).length), 0);
      if (p.rows.length && capSum < K) pm.push(M("warn", `Together these people can take at most ${capSum} of the ${K} seats (max shifts and eligibility) — some will stay open.`));
    }
    out.people = { R: p, msgs: [...p.notes.map((n) => M("info", n)), ...pm], facts: pf };
    out.shifts = { R: s, msgs: [...s.notes.map((n) => M("info", n)), ...sm], facts: sf };
    const big = 50 * (1 + (+rules.fair || 0) + (+rules.prefer || 0));
    out.imply = `${+rules.rest || 0} h rest${rules.one_a_day ? " + one shift a day" : ""} → ${conf == null ? "?" : conf.toLocaleString()} seat pairs that one person cannot both work · an open seat costs ${+big.toFixed(1)}, a broken rule ${+(2 * big).toFixed(1)}`;
  } else if (kind === "route") {
    const s = R("stops"), r = s.roles, m = [], f = [];
    const n = s.rows.length;
    const mode = r.lat && r.lon ? "latlon" : r.x && r.y ? "xy" : r.address ? "address" : null;
    if (!n) m.push(M("err", "No stops yet — a header row and at least 3 stops."));
    else if (n < 3) m.push(M("err", "A route needs at least 3 stops."));
    if (n > 120) m.push(M("err", `${n} stops — at most 120.`));
    if (n && !mode) m.push(M("err", "No way to place the stops: needs lat + lon, x + y, or an address column."));
    if (r.lat && !r.lon || r.lon && !r.lat) m.push(M("warn", "Only one of lat / lon — both are needed for map coordinates."));
    const names = s.rows.map((row, i) => (r.name && row[r.name]) || (r.address && row[r.address]) || `stop ${i + 1}`);
    if (mode === "latlon" || mode === "xy") {
      const [a, b] = mode === "latlon" ? [r.lat, r.lon] : [r.x, r.y];
      const P = s.rows.map((row) => [num(row[a]), num(row[b])]);
      const bad = names.filter((_, i) => P[i][0] == null || P[i][1] == null);
      if (bad.length) m.push(M("err", `The Planner cannot place ${list(bad)}. The values are not numbers.`));
      if (mode === "latlon" && P.some((p) => p[0] != null && Math.abs(p[0]) > 90)) m.push(M("warn", "A latitude is beyond ±90° — are lat and lon swapped?"));
      const ok = P.filter((p) => p[0] != null && p[1] != null);
      let span = 0;
      const d = mode === "latlon" ? (p, q2) => { const R0 = Math.PI / 180, la = p[0] * R0, lb = q2[0] * R0, h = Math.sin((lb - la) / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin((q2[1] - p[1]) * R0 / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(Math.min(1, h))); } : (p, q2) => Math.hypot(p[0] - q2[0], p[1] - q2[1]);
      for (let i = 0; i < ok.length; i++) for (let j = i + 1; j < ok.length; j++) span = Math.max(span, d(ok[i], ok[j]));
      if (n) f.push(`${plural(n, "stop")} by ${mode === "latlon" ? "lat/lon (km)" : "x/y (your units)"} · start: ${names[0]} · widest pair ${span.toFixed(span < 10 ? 2 : 1)} ${mode === "latlon" ? "km" : "units"}`);
    } else if (mode === "address") {
      const blank = names.filter((_, i) => !(s.rows[i][r.address] || "").trim());
      if (blank.length) m.push(M("err", `No address for ${list(blank)}.`));
      if (n) f.push(`${plural(n, "address", "addresses")} to look up on OpenStreetMap · about ${n} s the first time, instant once cached · start: ${names[0]}`);
    }
    const dupes = names.filter((x, i) => names.indexOf(x) !== i);
    if (dupes.length) m.push(M("warn", `Same name twice: ${list([...new Set(dupes)])}.`));
    if (n >= 3) f.push(n <= 13 ? "13 stops or fewer: the proven optimum is computed too" : "more than 13 stops: compared with nearest-neighbour + 2-opt (no exact optimum)");
    out.stops = { R: s, msgs: [...s.notes.map((x) => M("info", x)), ...m], facts: f };
    out.imply = rules.round_trip ? `round trip: back to ${names[0] || "the first stop"} at the end` : `one way from ${names[0] || "the first stop"}, to the end that gives the shortest route`;
  } else {
    const p = R("people"), r = p.roles, m = [], f = [], pm = [], pf = [];
    const n = p.rows.length, k = Math.round(+rules.k || 4);
    const names = p.rows.map((row, i) => (r.name && row[r.name]) || `person ${i + 1}`);
    if (!n) m.push(M("err", "No people yet."));
    else if (n < 2 * k) m.push(M("err", `${n} people cannot make ${k} teams of two or more.`));
    if (n > 400) m.push(M("err", `${n} people — at most 400.`));
    if (n && !r.name) m.push(M("warn", "There is no name column. The people will show as person 1, 2…, and pair rules cannot find anyone. Select the name column in the roles above."));
    if (r.score) {
      const bad = p.rows.filter((row) => (row[r.score] || "").trim() && num(row[r.score]) == null);
      if (bad.length) m.push(M("err", `score “${r.score}” has non-numbers (${list(bad.map((row) => "“" + row[r.score] + "”"))}). The server will not use it.`));
      const v = p.rows.map((row) => num(row[r.score])).filter((x) => x != null);
      if (v.length) f.push(`balance on ${r.score}: ${Math.min(...v)}–${Math.max(...v)}, mean ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)}`);
    } else if (n) f.push("no score column: the Planner does not balance the team totals");
    if (r.category) {
      const cnt = {}; p.rows.forEach((row) => { const c = row[r.category] ?? ""; cnt[c] = (cnt[c] || 0) + 1; });
      const kk = Object.keys(cnt).length, lim = Math.max(2, Math.floor(n / 2));
      if (kk < 2 || kk > lim) m.push(M("err", `category “${r.category}” has ${kk} different values. A category needs 2–${lim} values. The server will not use it.`));
      else f.push(`spread ${r.category}: ${Object.entries(cnt).sort((a, b) => b[1] - a[1]).map(([c, v]) => `${c || "(blank)"} ${v}`).slice(0, 8).join(" · ")}`);
    } else if (n) f.push("no category column: nothing is spread");
    if (n >= 2 * k) f.push(`${n} people → ${k} teams of ${Math.floor(n / k)}${n % k ? "–" + Math.ceil(n / k) : ""} (a hard limit)`);
    // pair rules, parsed like planner.py
    const idx = {}; names.forEach((x, i) => { idx[x.trim().toLowerCase()] = i; });
    const tog = [], apart = [], unknown = [];
    for (let line of (inputs.pairs || "").split("\n")) {
      line = line.split("#")[0].trim(); if (!line) continue;
      const mm = /^(.+?)\s*(\+|-|together with|apart from|with|not with|!=|==)\s*(.+)$/i.exec(line);
      if (!mm) { unknown.push(line); continue; }
      const a = mm[1].trim().toLowerCase(), op = mm[2].toLowerCase(), b = mm[3].trim().toLowerCase();
      if (!(a in idx) || !(b in idx)) { unknown.push(line); continue; }
      (["-", "apart from", "not with", "!="].includes(op) ? apart : tog).push([idx[a], idx[b]]);
    }
    if (unknown.length) pm.push(M("warn", `The Planner does not use these lines (a name is not in the table, or the line has no + / - / with …): ${list(unknown.map((u) => "“" + u + "”"))}.`));
    const par = names.map((_, i) => i), find = (i) => par[i] === i ? i : (par[i] = find(par[i]));
    tog.forEach(([a, b]) => { par[find(a)] = find(b); });
    const contra = apart.filter(([a, b]) => find(a) === find(b)).map(([a, b]) => `${names[a]} / ${names[b]}`);
    if (contra.length) pm.push(M("err", `Must be together and apart at once: ${list(contra)}.`));
    const sizes = {}; names.forEach((_, i) => { const c = find(i); sizes[c] = (sizes[c] || 0) + 1; });
    const hi = Math.ceil(n / Math.max(1, k)), big = Object.entries(sizes).filter(([, v]) => v > hi);
    if (big.length) pm.push(M("err", `A “together” group of ${Math.max(...big.map(([, v]) => v))} is bigger than a team (${hi}).`));
    if (tog.length || apart.length) pf.push(`${plural(tog.length, "together rule")} · ${plural(apart.length, "apart rule")}`);
    out.people = { R: p, msgs: [...p.notes.map((x) => M("info", x)), ...m], facts: f };
    out.pairs = { R: null, msgs: pm, facts: pf };
    out.imply = n ? `${k} teams of ${Math.floor(n / k)}${n % k ? "–" + Math.ceil(n / k) : ""}${r.score ? ` · balance ${r.score} ×${+rules.balance}` : ""}${r.category ? ` · spread ${r.category} ×${+rules.mix}` : ""}` : "";
  }
  return out;
}
