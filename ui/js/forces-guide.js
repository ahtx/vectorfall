// The Particle Lab guide for the force model. Written to ASD-STE100 (see STYLE.md): short sentences, commands for
// instructions, active voice, one term for one thing. Terms: body, world, share, step, force, event, training period,
// tuning period, test period, projection, baseline, the film.

export const LESSONS = [
  {
    id: "what", title: "What this tool does", sum: "four stages: world, learn, test, project",
    body: [
      `<p>This tool learns how a group of bodies grows, moves and changes. A body is one company or one country.</p>
       <p>The work has four stages. Do them in this order:</p>
       <table class="hg-t"><tr><th>stage</th><th>what happens</th></tr>
       <tr><td>1 · World</td><td>You select the companies (the S&amp;P 500) or the countries. The tool shows the data and the events.</td></tr>
       <tr><td>2 · Learn</td><td>The tool learns the forces from the training period. It does not look at the test period.</td></tr>
       <tr><td>3 · Test</td><td>The tool runs once over the test period. It compares its answer with what really happened.</td></tr>
       <tr><td>4 · Project</td><td>The tool runs into the future. You can add events of your own.</td></tr></table>
       <p>Each stage shows its result next to three simple methods. These are the baselines. If the forces do not beat the baselines, the tool tells you.</p>`,
      { acts: [{ act: "stage", args: "world", label: "Go to stage 1 · World", primary: true }] },
    ],
  },
  {
    id: "map", title: "How to read the map", sum: "size, position, colour, discs and rings",
    body: [
      `<table class="hg-t"><tr><th>you see</th><th>it means</th></tr>
       <tr><td>size of a disc</td><td>The share of the whole that the body has. The area of the disc shows the share.</td></tr>
       <tr><td>position</td><td>The co-movement of the body. Bodies that went up and down together are near each other. The tool draws the map from the 36 months (companies) or 15 years (countries) before each step.</td></tr>
       <tr><td>colour</td><td>The sector of a company or the region of a country.</td></tr>
       <tr><td>filled disc</td><td>The simulation: the average of all the futures.</td></tr>
       <tr><td>white ring</td><td>What really happened. You see the rings only in the test period.</td></tr>
       <tr><td>cross</td><td>The body left. It went out of the S&amp;P 500, or another company bought it.</td></tr></table>
       <p>To zoom, turn the mouse wheel. To move the map, drag it. To follow one body, click it.</p>
       <p>The scrubber under the map moves through the steps. Press ▶ to play them. The marks on the scrubber are events.</p>`,
      { note: "Select <b>Orbit</b> to see the S&amp;P 500 as a circle. Big companies are near the centre. A company that falls below the 500th place goes out through the edge.", tone: "tip" },
    ],
  },
  {
    id: "forces", title: "The forces", sum: "one combined force, made of terms that the data weighs",
    body: [
      `<p>Each step, a combined force pushes every body. The force has two parts.</p>
       <p><b>Growth forces</b> change the share of a body:</p>
       <ul><li><a data-ref="momentum">Momentum</a>: a body that grew faster than the whole keeps part of that extra growth. The extra growth becomes smaller with time (the <a data-ref="halflife">half-life</a>).</li>
       <li><a data-ref="size">Size</a>: big bodies grow faster, or small bodies catch up.</li>
       <li><a data-ref="crowding">Crowding</a>: much mass near a body on the map can slow it (competition).</li>
       <li><a data-ref="lead">Lead</a>: a body that is bigger than its neighbours can take share from them.</li>
       <li><a data-ref="contagion">Contagion</a>: a body can grow when its neighbours grow.</li>
       <li><a data-ref="volatility">Volatility</a>: bodies that move much can grow slower.</li>
       <li>Countries only: <a data-ref="catchup">catch-up</a>, <a data-ref="conflict">conflict</a> and <a data-ref="nearconflict">nearby conflict</a>.</li></ul>
       <p><b>Position forces</b> move a body on the map: the <a data-ref="pull">pull of heavy neighbours</a> and the <a data-ref="home">pull toward its group</a>.</p>
       <p>You do not set these forces. The tool learns the weight of each force from the training period. A weight of 0 means that the force has no effect.</p>`,
    ],
  },
  {
    id: "learn", title: "How the tool learns", sum: "training period, tuning period, and the score",
    body: [
      `<p>The data before the test period has two parts:</p>
       <table class="hg-t"><tr><th>period</th><th>companies</th><th>countries</th><th>use</th></tr>
       <tr><td>training</td><td>2011–2021</td><td>1980–2015</td><td>The tool learns the weights here.</td></tr>
       <tr><td>tuning</td><td>2022–2023</td><td>2016–2020</td><td>The tool selects the setup here. It also measures what each force adds.</td></tr>
       <tr><td>test</td><td>2024 → the end of the data</td><td>2021–2025</td><td>The tool runs here only once, at stage 3.</td></tr></table>
       <p>To learn, the tool starts the simulation at many dates in the training period. It runs each start forward for 24 months (companies) or 5 years (countries). Then it compares two things with what really happened:</p>
       <ol><li>Who grew more than the others. This is the <a data-ref="e_size">growth error</a>.</li>
       <li>Where each body went on the map. This is the <a data-ref="e_pos">position error</a>.</li></ol>
       <p>The tool divides each error by the error of “nothing changes”. Thus a score of 1.00 means “no better than nothing changes”. A lower score is better.</p>
       <p>The tool tries many sets of weights at the same time on the GPU (CMA-ES). It keeps the set with the lowest score.</p>`,
      { acts: [{ act: "stage", args: "learn", label: "Go to stage 2 · Learn", primary: true }] },
    ],
  },
  {
    id: "events", title: "Events", sum: "sudden changes, their chances and their effects",
    body: [
      `<p>An event is a sudden change. The tool learns how often each event happens, and what makes it more likely.</p>
       <table class="hg-t"><tr><th>world</th><th>events</th></tr>
       <tr><td>companies</td><td><a data-ref="ev_merger">merger</a> · <a data-ref="ev_exit">exit</a> · <a data-ref="ev_entry">entry</a> · <a data-ref="ev_split">split</a> · <a data-ref="ev_collapse">collapse</a> · <a data-ref="ev_jump">jump</a></td></tr>
       <tr><td>countries</td><td><a data-ref="ev_war">war</a> · <a data-ref="ev_civilwar">civil war</a> · <a data-ref="ev_uprising">uprising</a> · <a data-ref="ev_coup">coup</a> · <a data-ref="ev_currency">currency crash</a> · breakup and union (history only)</td></tr></table>
       <p>For each event, the tool fits a <a data-ref="chance">chance</a> per body per step. The chance depends on facts at that step, for example the size rank of a company, or a war near a country.</p>
       <p>For each event, the tool also measures its <a data-ref="effect">effect</a>: how much the size of the body changed when the event happened.</p>
       <p>In the futures, events happen at their chances. In the S&amp;P 500, a new company takes the place of each company that leaves.</p>`,
      { note: "Do not expect the tool to know which country has the next war. The tool knows how often wars happen, and what a war does to a country. That is all.", tone: "warn" },
    ],
  },
  {
    id: "test", title: "Read the test", sum: "the scorecard and the three baselines",
    body: [
      `<p>The test starts at the end of the tuning period. It runs to the end of the data. The tool never saw these years.</p>
       <p>The scorecard compares four methods:</p>
       <table class="hg-t"><tr><th>method</th><th>what it does</th></tr>
       <tr><td>Forces</td><td>All the learned forces.</td></tr>
       <tr><td>Momentum only</td><td>Only momentum and its half-life, learned in the same way.</td></tr>
       <tr><td>Statistics only</td><td>A plain regression on the same facts, with no simulation.</td></tr>
       <tr><td>Nothing changes</td><td>Every body keeps its share and its place.</td></tr></table>
       <p>The best value in each row is bold. If “Forces” is not the best, then the forces do not help on this test. The tool says this in the verdict.</p>
       <p>The events table shows how many events the futures expected, and how many really happened.</p>`,
      { acts: [{ act: "stage", args: "test", label: "Go to stage 3 · Test", primary: true }] },
    ],
  },
  {
    id: "project", title: "Project the future", sum: "learned events and your own scenarios",
    body: [
      `<p>The projection uses all the data, also the test period. The tool learns the forces again on all of it, then runs 128 futures.</p>
       <p>The map shows the average future. Select <b>One possible future</b> to see one future with its events: mergers, exits, splits, new companies, wars and coups.</p>
       <p>To add your own event:</p>
       <ol><li>Select the type of the event.</li><li>Select the body.</li><li>Type the date.</li><li>If you want, type the size of the effect. If you do not, the tool uses the learned effect.</li><li>Click <b>Add</b>, then click <b>Run the projection</b>.</li></ol>
       <p>A scenario event happens in every future. Compare a run with the event and a run without it.</p>`,
      { note: "The futures get wider with time. Do not trust a single line far ahead. Look at the range (p10 to p90).", tone: "warn" },
      { acts: [{ act: "stage", args: "project", label: "Go to stage 4 · Project", primary: true }] },
    ],
  },
  {
    id: "data", title: "Where the data comes from", sum: "all free sources, and their limits",
    body: [
      `<table class="hg-t"><tr><th>data</th><th>source</th></tr>
       <tr><td>S&amp;P 500 members and changes</td><td>Wikipedia lists. The change log is not complete before about 2011.</td></tr>
       <tr><td>company sizes</td><td>Prices (Yahoo) × shares (SEC XBRL).</td></tr>
       <tr><td>sizes of companies that were bought</td><td>The public float on their 10-K filings (SEC). These sizes are estimates. These companies have no prices, so they stay at the centre of their sector on the map.</td></tr>
       <tr><td>country sizes</td><td>GDP in current US$ (World Bank). The map uses real GDP growth.</td></tr>
       <tr><td>wars, civil wars, uprisings</td><td>UCDP/PRIO Armed Conflict Dataset, version 25.1.</td></tr>
       <tr><td>coups</td><td>Powell &amp; Thyne coup data (CoupCats).</td></tr>
       <tr><td>currency crashes</td><td>World Bank exchange rates: a loss of 30% or more against the US$ in one year.</td></tr></table>`,
    ],
  },
];

const ref = (k, t, d, sig) => ({ k, t, d, sig });
export const REF = [
  ref("momentum", "Momentum", "Each step, a body gets this part of its extra growth. The extra growth is the growth above the whole, per year. The tool measures it over the 12 months (companies) or 5 years (countries) before the start. A value of 0.3 means that 30% of the extra growth continues.", "learned · growth force"),
  ref("halflife", "Momentum half-life", "The time after which half of the extra growth is gone. The tool learns it with momentum.", "learned · years"),
  ref("size", "Size", "The change in growth per year for a body that is one standard deviation bigger than the average. Above 0: the big get bigger. Below 0: the small catch up.", "learned · growth force"),
  ref("crowding", "Crowding", "The change in growth per year for one standard deviation more mass near the body on the map. Below 0 means competition.", "learned · growth force"),
  ref("lead", "Lead over neighbours", "The change in growth per year for a body that is one standard deviation bigger than its neighbours. Above 0: it takes share from them.", "learned · growth force"),
  ref("contagion", "Contagion", "The part of the neighbours' extra growth that a body also gets. Neighbours count more when they are near and big.", "learned · growth force"),
  ref("volatility", "Volatility", "The change in growth per year for a body that moves one standard deviation more than the others.", "learned · growth force"),
  ref("catchup", "Catch-up (countries)", "The change in growth per year for a country with one standard deviation more GDP per person. Below 0: poorer countries grow faster.", "learned · growth force"),
  ref("conflict", "Conflict (countries)", "The change in growth per year while the country has a conflict. A full war counts 1. A civil war counts 2/3. An uprising counts 1/3.", "learned · growth force"),
  ref("nearconflict", "Nearby conflict (countries)", "The change in growth per year when all the neighbours of a country have a full war. Neighbours are near on the map, in geography, or both.", "learned · growth force"),
  ref("pull", "Pull of heavy neighbours", "The part of the distance to the mass near it that a body moves each year on the map.", "learned · position force"),
  ref("home", "Pull toward its group", "The part of the distance to the centre of its sector or region that a body moves each year on the map.", "learned · position force"),
  ref("blend", "Map and geography (countries)", "For countries, the neighbours of a body come from the map, from geography, or from both. The tool tries 100% map, 50/50 and 100% geography. It keeps the one with the best tuning score.", "selected in the tuning period"),
  ref("e_size", "Growth error", "The average error in how much each body grew compared with the others. Bigger bodies count more (the weight is the square root of the share). The tool divides it by the same error for “nothing changes”."),
  ref("e_pos", "Position error", "The average distance between the simulated place and the real place on the map. The tool turns the simulated map to fit the real map first."),
  ref("e_group", "Group error", "The share of the whole that the simulation puts in the wrong sector or region. It is half the sum of the differences."),
  ref("rank", "Rank correlation", "How well the simulation orders the bodies from fastest growth to slowest growth. 1 is perfect. 0 is no skill."),
  ref("contrib", "What a force adds", "The tool sets one force to 0 and measures the tuning score again. If the score gets worse, the force helps."),
  ref("chance", "Chance of an event", "A logistic model on the training period gives the chance per body per step. If there were fewer than 8 events, the tool uses one rate for all bodies."),
  ref("effect", "Effect of an event", "The change in size of the body, relative to the whole, from the step before the event to the step after it. The futures use real effects from the training period."),
  ref("ev_merger", "Merger", "Another company buys the company. In the futures, the buyer is a bigger company, more probably a near one. The buyer gets the size of the company that it buys."),
  ref("ev_exit", "Exit", "The company leaves the S&P 500 for its size or for another reason. It continues to exist outside the film."),
  ref("ev_entry", "Entry", "A new company joins the S&P 500. In the futures, a new company takes the place of each company that leaves."),
  ref("ev_split", "Split", "A company makes a new company from a part of itself (a spin-off)."),
  ref("ev_collapse", "Collapse", "The company goes bankrupt and leaves."),
  ref("ev_jump", "Jump", "The size changes by 5 standard deviations or more in one month."),
  ref("ev_war", "War", "An armed conflict between states with 25 or more deaths in a year (UCDP). Only the main sides count."),
  ref("ev_civilwar", "Civil war", "An armed conflict inside a state with 1,000 or more deaths in a year (UCDP)."),
  ref("ev_uprising", "Uprising", "A new armed conflict inside a state with 25 or more deaths in a year (UCDP)."),
  ref("ev_coup", "Coup", "An attempt to take the government by force, successful or not (Powell & Thyne)."),
  ref("ev_currency", "Currency crash", "The currency loses 30% or more against the US$ in one year, and 10 points more than in the year before."),
  ref("film", "The film", "The S&P 500 is a window on a bigger group of companies. A company that falls out of the window exits. It is not destroyed."),
  ref("orbit", "Orbit view", "Distance from the centre shows the size rank. The angle comes from the map. For companies, the circle is the edge of the S&P 500."),
  ref("sample", "One possible future", "One of the futures, with its events. It shows what can happen. It is not a forecast."),
];
