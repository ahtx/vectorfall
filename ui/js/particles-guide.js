// Particle Lab guide: what the picture means, what every rule's number does (exactly as app/particles.py computes it),
// how runs are scored, what has been found so far, and how to bring your own data. Rendered by guide.js.
// Written to ASD-STE100 (see STYLE.md).

// A made-up wide table to show the shape of "your own data" (labelled as made-up wherever it is offered).
export function sampleTable() {
  let s = 7;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const names = ["North", "South", "East", "West", "Harbour", "Hills"], grp = ["coast", "inland", "coast", "inland", "coast", "inland"];
  const v = [120, 95, 80, 60, 40, 22];
  const rows = ["month," + names.join(",")];
  for (let m = 0; m < 48; m++) {
    const shock = { coast: (rnd() - 0.5) * 0.06, inland: (rnd() - 0.5) * 0.06 };
    for (let i = 0; i < v.length; i++) v[i] *= Math.exp(0.004 + (i === 4 ? 0.012 : 0) + shock[grp[i]] + (rnd() - 0.5) * 0.04);
    const y = 2021 + Math.floor(m / 12), mo = String((m % 12) + 1).padStart(2, "0");
    rows.push(`${y}-${mo}-28,` + v.map((x) => x.toFixed(1)).join(","));
  }
  return { csv: rows.join("\n"), groups: names.map((n, i) => `${n}: ${grp[i]}`).join("\n") };
}

export const LESSONS = [
  {
    id: "look", title: "What the map shows", sum: "bodies, size, position and colour",
    body: [
      `<p>A <b>world</b> is a group of bodies that grow, compete and change over time. There are two built-in worlds:</p>
       <ul><li><b>S&amp;P 500</b>: the companies, with their market cap month by month.</li>
       <li><b>Countries</b>: GDP in current US$, year by year, from the World Bank.</li></ul>
       <p>Each member of a world is a <b>body</b> on the map.</p>
       <table class="hg-t"><tr><th>you see</th><th>it means</th></tr>
       <tr><td>size</td><td>The <b>share of the whole</b> that the body has at that time. The area of the disc shows the share. The tool predicts shares only, because nobody knows the future level of the market or of the world economy.</td></tr>
       <tr><td>position</td><td>The <b>co-movement</b> of the body. Bodies that went up and down together before the start are near each other. The distance is √(2(1 − correlation)) of their monthly (or yearly) changes, made flat in 2-D. The tool does not tell the map the groups. Sectors or regions become clusters by themselves. The fact <a data-ref="purity">“same-sector neighbours”</a> tells how strong the clusters are, next to chance.</td></tr>
       <tr><td>colour</td><td>The group of the body (sector or region). With <a data-ref="colour">Colour: growth</a>, the colour shows how much its share grew (green) or became smaller (red) since the start.</td></tr></table>`,
      { acts: [{ act: "world", args: "sp500", label: "Run the S&P 500", primary: true }, { act: "world", args: "gdp", label: "Run the countries" }] },
      `<p>To zoom, turn the mouse wheel or click the + and − buttons. To move the map, drag it. To zoom in on a point, double-click it. To go to the cluster of a group, click the group in the legend.</p>
       <p>To follow a body, click it. Its data shows in the <b>Bodies</b> tab.</p>`,
    ],
  },
  {
    id: "time", title: "Time: start, simulated, what happened", sum: "the scrubber, the two layers, and the map as it changed",
    body: [
      `<p>A run starts at a past date, <b>T0</b>. The run uses only the data up to T0.</p>
       <p>From T0, the run goes forward a number of <b>steps</b>. A step is one month for the S&amp;P 500 and one year for countries.
       The card runs <b>128 possible futures</b> at the same time.</p>
       <p>The tool keeps every step. The scrubber under the map moves through the full run. Click ▶ to play it.</p>
       <table class="hg-t"><tr><th>layer</th><th>what you see</th></tr>
       <tr><td>Simulated</td><td>A filled disc: the average share over the 128 futures at that step.</td></tr>
       <tr><td>What happened</td><td>The real share at the same step, from the data.</td></tr>
       <tr><td>Both</td><td>The disc is the simulation. The ring is the real share. A ring outside its disc means that the body grew more than the simulation. A ring inside means that it grew less. A cross shows a body that left.</td></tr></table>
       <p>The map has two layouts:</p>
       <ul><li><b>Start map</b> keeps the co-movement map of T0. Bodies move only if <a data-ref="Gx">gravity</a> is on.</li>
       <li><b>As it evolved</b> draws the co-movement map again at each step, from the real data in the window before that step. The tool turns each new map to fit the one before. Thus you can see clusters form and break up. For example, in a crash all bodies move together.</li></ul>`,
      { acts: [{ act: "layer", args: "both", label: "Show both layers", primary: true }, { act: "layout", args: "evolved", label: "Map as it evolved" }, { act: "play", label: "Play the run", icon: "play" }] },
      `<p>The <b>Groups</b> strip under the map follows the scrubber. For each group, it shows the share at the start, the simulated share and the real share. A small chart shows the full path.</p>
       <p>The <b>Score</b> tab shows the error at each step, next to “nothing changes”. Use it to find the step where the rules start to go wrong.</p>`,
    ],
  },
  {
    id: "rules", title: "Rules are forces: what each number does", sum: "each slider, in its own units",
    body: [
      `<p>Each rule is an overlay. You can set it on or off. When a rule is off, the tool sends its neutral value (for example, 0 for the size effect).</p>
       <p>All the rules change the <b>log share</b> of a body, one time per step. Thus small numbers are important: +0.01 per step is about +12% per year on monthly data.</p>
       <table class="hg-t"><tr><th>rule</th><th>number</th><th>what it does at each step</th></tr>
       <tr><td>Growth carries on</td><td><a data-ref="beta">β</a> 0…1.5</td><td>Each body starts with the growth of the market plus β × its own extra growth before T0. 0 = all bodies grow at the same rate. 1 = each body keeps all of its extra growth.</td></tr>
       <tr><td></td><td><a data-ref="kappa">κ</a> 0…0.2</td><td>The extra growth becomes smaller by the fraction κ per step. The half-life is about 0.69/κ steps (κ = 0.028 → about 25 steps).</td></tr>
       <tr><td>Size effect</td><td><a data-ref="alpha">α</a> −0.01…0.01</td><td>Adds α × (its log share − the average log share). Above 0, the big get bigger. Below 0, the small catch up.</td></tr>
       <tr><td>Neighbourhood takeover</td><td><a data-ref="G">G</a>, <a data-ref="h">h</a></td><td>A body gets G × Σ<sub>neighbours</sub> kernel × their share × (how much bigger it is, in log share). The kernel reaches about h map units.</td></tr>
       <tr><td>Gravity drift</td><td><a data-ref="Gx">Gx</a>, <a data-ref="fric">friction</a></td><td>Moves bodies on the map toward heavy neighbours (a soft 1/r² pull). Friction removes speed. Gravity changes positions only. Sizes do not change, unless takeover or mergers use the new distances.</td></tr>
       <tr><td>Mergers</td><td><a data-ref="merge_r">radius</a>, <a data-ref="merge_q">ratio</a></td><td>A body joins a bigger body in two conditions. It is nearer than radius × the usual distance between bodies. The bigger body is more than 1/ratio times its size. The bigger body gets its share.</td></tr>
       <tr><td>Birth and death</td><td><a data-ref="drop">drop</a>, <a data-ref="entrants">arrivals</a>, <a data-ref="noise">noise</a></td><td>A body that falls below about half the smallest start share leaves. New bodies arrive at the rate before T0. Each body gets random shocks at its own past volatility.</td></tr></table>`,
      { note: "Each rule label has a <b>?</b>. It opens the exact definition in the Reference. When you change a rule, the world runs again. To stop this, set the switch under the Run button to off.", tone: "tip" },
    ],
  },
  {
    id: "fit", title: "Fit a rule from the past", sum: "the “fit” boxes, and why the window is the one before the start",
    body: [
      `<p>Tick <b>fit</b> next to a number. Then the run first <b>learns</b> that number:</p>
       <ol><li>It tries a small grid of values on the window that ends at T0. The window has the same length as the run. For example, a 60-step run learns from the 60 steps before T0.</li>
       <li>It compares each value with what then really happened.</li>
       <li>It keeps the best value.</li></ol>
       <p>The run uses no data after T0. Thus the fitted value is honest.</p>
       <table class="hg-t"><tr><th>number</th><th>values tried</th></tr>
       <tr><td>β</td><td>0, 0.5, 1</td></tr><tr><td>κ</td><td>0, 1/36</td></tr><tr><td>α</td><td>−0.004, 0, +0.004</td></tr><tr><td>G</td><td>−0.25, 0, +0.25</td></tr></table>
       <p>“Best” means the lowest <a data-ref="loss">loss</a>: the share in the wrong group − ¼ × the rank correlation of who grew. The tool puts the fitted values into the sliders.</p>`,
    ],
  },
  {
    id: "score", title: "How good is it? The scores", sum: "three questions, two baselines, and the test on past dates",
    body: [
      `<p>When the end of a run is in the data, the tool compares the run with what really happened:</p>
       <table class="hg-t"><tr><th>score</th><th>meaning</th><th>no skill</th></tr>
       <tr><td><a data-ref="sector_l1">Wrong group</a></td><td>The share of the whole that the run puts in the wrong sector or region (half the sum of |simulated − real| group shares).</td><td>—</td></tr>
       <tr><td><a data-ref="rank_rho">Who grew</a></td><td>The rank correlation of simulated and real growth, for the bodies that stayed.</td><td>0</td></tr>
       <tr><td><a data-ref="leave_auc">Who left</a></td><td>How well the chance to leave finds the bodies that really left.</td><td>0.5</td></tr>
       <tr><td><a data-ref="top10">Top 10</a></td><td>How many of the real ten biggest bodies it found.</td><td>—</td></tr></table>
       <p>The tool always shows two baselines next to the score:</p>
       <ul><li><b>Nothing changes</b>: the start picture, with no change.</li>
       <li><b>No interactions</b>: the same growth rules, with size, takeover, gravity and mergers off.</li></ul>
       <p>A rule is useful only if it is better than both baselines.</p>
       <p>One window can be luck. <b>Test on past dates</b> does the full work again at some past start dates. Each time, it fits only on the window before that start. Then it tells how often the rules won. To load a run into the map, click its window in the table.</p>`,
      { acts: [{ act: "tab", args: "score", label: "Open the Score tab" }, { act: "backtest", label: "Test on past dates" }] },
    ],
  },
  {
    id: "found", title: "What it found until now", sum: "honest results from the tests on past dates",
    body: [
      `<p>These results come from the tests on past dates. Each fit used only the past:</p>
       <ul><li><b>S&amp;P 500, five windows 2016→2025:</b> momentum ranks who grew at +0.15, +0.26, +0.28 and +0.17, and at −0.18 in the last window.
       The fit never selected takeover (G). Nothing was better than “nothing changes” on sector shares (1 window of 5). No rule saw the
       growth of the biggest companies before it came (top-10 share 25% → 40%).</li>
       <li><b>The size effect changes with the period</b>: −0.26 in 2011–16, about 0 in 2019–24.</li>
       <li><b>You cannot check mergers</b> with free data. Companies that another company bought are not in the price history. Only 0–4 of 26–66 acquisitions per window are in the simulation.</li>
       <li><b>Countries:</b> catch-up (α &lt; 0, the small grow faster) ranks country growth at +0.17 to +0.24. But it makes the regional shares worse.</li></ul>
       <p>Thus momentum is a real signal, but it is small and it changes. The interaction rules are ideas to test. They are not known forces.</p>`,
    ],
  },
  {
    id: "own", title: "Your own data", sum: "any table of sizes over time",
    body: [
      `<p>Select <b>Your table</b> under World. You can use a Data Desk table if each row is a date and the numbers are sizes (revenue, users, population, sales).</p>
       <table class="hg-t"><tr><th>shape</th><th>columns</th></tr>
       <tr><td>wide</td><td>A date column + one numeric column per entity (select the columns, or use all). Groups: one <code>entity: group</code> per line.</td></tr>
       <tr><td>long</td><td>Date, entity and value columns, with one row per entity per date. A group column is optional.</td></tr></table>
       <p>The table must have at least 3 entities and 4 dates, with sizes above 0. A blank cell means that the entity is absent on that date.</p>
       <p>If there are fewer than 6 steps before the start, there is too little history for a correlation. Then the tool puts the bodies on a ring, by group.</p>`,
      { note: "The example below has <b>made-up numbers</b>. It only shows the shape: the monthly sales of six towns in two groups. One town (Harbour) grows faster.", tone: "warn" },
      { csv: sampleTable().csv, title: "wide · made-up numbers", act: "sample", label: "Load as a Data Desk table and run" },
    ],
  },
];

const ref = (k, t, d, sig) => ({ k, t, d, sig });
export const REF = [
  ref("beta", "β — growth carries on", "The start growth of each body per step = g<sub>m</sub> + β × (g<sub>i</sub> − g<sub>m</sub>). Here g<sub>i</sub> is its log growth per step over the lookback (up to 36 steps before T0). g<sub>m</sub> is the average, where bigger bodies count more. 0 = all bodies grow at the average. 1 = each body keeps its own rate.", "0 … 1.5 · default 0.5 · you can fit it"),
  ref("kappa", "κ — growth fades", "At each step: g ← g − κ (g − g<sub>m</sub>). The extra growth becomes smaller by the same fraction at each step. The half-life is ln 2 / −ln(1 − κ) ≈ 0.69/κ steps. 0 = it never becomes smaller.", "0 … 0.2 · default 1/36 · you can fit it"),
  ref("alpha", "α — size effect", "At each step, the log share of each body that stays gets α × (its log share − the mean log share of the bodies that stay). With α = 0.004, a body e times (2.7×) above the geometric mean gets 0.4% more share per step. Above 0: the rich get richer. Below 0: the bodies come nearer in size.", "−0.01 … 0.01 · default 0 · you can fit it"),
  ref("G", "G — neighbourhood takeover", "At each step, body i gets G × Σ<sub>j</sub> K<sub>ij</sub> w<sub>j</sub> (ℓ<sub>i</sub> − ℓ<sub>j</sub>). Here ℓ = log share, w = share and K<sub>ij</sub> = exp(−d<sub>ij</sub>² / 2h²). Above 0, the bigger body grows and its neighbours lose. Below 0, the neighbours come nearer in size.", "−2 … 2 · default 0 · you can fit it"),
  ref("h", "h — neighbourhood size", "How far the takeover kernel reaches, in map units. The tool scales the map so that the usual body is about 1 unit from the centre.", "0.05 … 1.5 · default 0.35"),
  ref("Gx", "Gx — gravity drift", "At each step, the velocity of a body gets Gx × Σ<sub>j</sub> w<sub>j</sub> (x<sub>j</sub> − x<sub>i</sub>) / (d² + s²)<sup>3/2</sup>. Here s = 0.15 × the mean distance to the nearest neighbour (this makes the pull soft). Gravity moves positions only.", "0 … 0.01 · default 0"),
  ref("fric", "Friction", "At each step: velocity ← (1 − friction) × velocity + the gravity pull.", "0 … 0.6 · default 0.15"),
  ref("merge_r", "Capture radius", "A body joins a bigger body when two things are true. The distance is less than radius × the mean distance to the nearest neighbour. The share of the bigger body × ratio is more than the share of the body. 0 = no mergers.", "0 … 1.5 · default 0"),
  ref("merge_q", "Size ratio for a merger", "Only bodies smaller than ratio × the share of the buyer can join it (0.2 = a fifth of its size or less).", "0.02 … 0.6 · default 0.2"),
  ref("drop", "Drop below the floor", "A body leaves in a future if its log share falls below log(the start share at about the 1st percentile) − 0.7. That is about half the smallest member. The “Who left” score uses how often the body left in the futures."),
  ref("entrants", "New arrivals (the Oort cloud)", "Arrivals per step = the rate in the lookback before T0 (up to 36 steps, Poisson). Each new body copies the relative size and group of a real past entrant. It grows at the median growth of past entrants, relative to the whole. It starts near the centre of its group. All new bodies together hold half the whole or less."),
  ref("noise", "The noise of each body", "At each step: log share += σ<sub>i</sub> ε − σ<sub>i</sub>²/2. Here σ<sub>i</sub> is the volatility of the body before T0, and ε is a new normal value in each future. The 128 futures give the p10–p90 ranges."),
  ref("loss", "Loss for the fit", "The wrong-group share − 0.25 × the rank correlation of who grew, on the window before T0. Lower is better."),
  ref("sector_l1", "Wrong group", "½ Σ<sub>groups</sub> |simulated share − real share|. New bodies count on both sides. 0 = the share of each group is correct."),
  ref("rank_rho", "Who grew", "The Spearman rank correlation between the simulated and the real change in share, for the start bodies that are there at the end. 0 = no skill. “Nothing changes” has no ranking, so it shows —."),
  ref("leave_auc", "Who left", "The area under the ROC curve of the chance of each body to leave, against what really happened. The chance is the share of futures in which it left. 0.5 = chance. The “nothing changes” row puts the smallest bodies first."),
  ref("top10", "Top 10", "How many of the ten biggest bodies at the end are in its own top ten."),
  ref("purity", "Same-group neighbours", "For each body, the share of its 5 nearest neighbours on the start map that are in its own group. “Chance” is the value for random positions (Σ group share²). A value far above chance means that the co-movement map really separates the groups."),
  ref("persistence", "Nothing changes", "Baseline: the start picture, with no change. The tool scores it in the same way."),
  ref("nointeract", "No interactions", "Baseline: your growth rules (β, κ, noise, birth and death), with size, takeover, gravity and mergers off. It shows if the interactions add something."),
  ref("layer", "Layers", "Simulated = the average share over the futures (a disc). What happened = the real share at the same step. Both = the disc and a ring."),
  ref("layout", "Start map / As it evolved", "Start map: the co-movement map at T0. Only gravity moves it. As it evolved: the tool draws the map again at each step. It uses the real data in the window before that step (the same length as before T0). It turns each map to fit the one before. Thus a body moves only when its co-movement changed."),
  ref("colour", "Colour: group / growth", "Group = sector or region. Growth = log(the share now ÷ the share at the start), on the layer that you see. Green = it grew. Red = it became smaller. Grey = about the same."),
  ref("horizon", "Steps to run", "How far the run goes. If the end is in the data, the tool scores the run. After the end of the data, the run is a projection, and there is nothing to compare it with."),
  ref("t0", "Start", "The run uses only the data up to this date. “Latest with an outcome” = the last start whose end is in the data."),
];
