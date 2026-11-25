// Planner guide content: per-problem lessons (from a tiny example to your own data), a shared walk-solver lesson, and
// the Reference — every column, rule number, result number and model keyword, described exactly as app/planner.py
// and app/walksolve.py behave. Rendered by guide.js; the act names are handled by plan.js (onAct):
//   load {inputs, rules, solve}  ·  tab "inputs"|"model"|"search"  ·  solve  ·  example  ·  ref <key>  ·  csv (a {csv, field} block)

// ---------------------------------------------------------------- sample data: other domains, same three problems
export const SAMPLES = {
  tinyRoster: {
    people: "name\nAna\nBen\nCara",
    shifts: "shift,day,start,end\nEarly,Mon,07:00,15:00\nLate,Mon,15:00,23:00",
  },
  cafe: {
    people: "name,max_shifts,min_shifts,skills,unavailable,prefers\nMaya,3,1,barista;open,Sun,Sat Open\nLeo,3,,barista,,Close\nPriya,2,,barista;till,Sat,\nTom,4,2,till,,Open\nSam,2,,barista;till,Sun Close,\nZoe,3,,till;open,Sat Close,\nAna,3,,barista,,",
    shifts: "shift,day,start,end,needed,skill\nOpen,Sat,06:30,12:00,1,open\nBar AM,Sat,07:00,13:00,2,barista\nTill,Sat,10:00,16:00,1,till\nClose,Sat,13:00,19:00,2,barista\nOpen,Sun,06:30,12:00,1,open\nBar AM,Sun,07:00,13:00,2,barista\nTill,Sun,10:00,16:00,1,till\nClose,Sun,13:00,19:00,2,barista",
    rules: { rest: 11, one_a_day: true, fair: 1, prefer: 1 },
  },
  callcentre: {
    people: "name,max_shifts,skills,unavailable,prefers\nAlex,5,spanish,Fri,Morning\nBea,4,,2026-11-04,\nCruz,5,spanish,,Evening\nDana,5,,Mon,Morning\nEvan,3,,,\nFlor,5,spanish,2026-11-02 Morning,\nGabe,5,,Thu,Evening\nHui,4,,,Morning",
    shifts: "shift,day,start,end,needed,skill\n" + ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"].map((d) =>
      `Morning,${d},08:00,14:00,2,\nEvening,${d},14:00,20:00,1,\nEvening ES,${d},14:00,20:00,1,spanish`).join("\n"),
    rules: { rest: 10, one_a_day: true, fair: 1, prefer: 0.5 },
  },
  tinyRoute: { stops: "name,x,y\nHome,0,0\nShop,4,0\nGym,4,3\nPark,0,3" },
  warehouse: {
    stops: "name,x,y\nDock,0,0\nA-03,4,12\nA-11,4,44\nB-02,12,8\nB-09,12,36\nC-05,20,20\nC-14,20,56\nD-01,28,4\nD-07,28,28\nE-04,36,16\nE-12,36,48\nPacking,40,0",
    rules: { round_trip: true },
  },
  sales: {
    stops: "name,address\nOffice,Texas State Capitol Austin\nAirport client,Austin-Bergstrom International Airport\nCampus,University of Texas at Austin\nZilker,Zilker Park Austin\nDomain,The Domain Austin\nMueller,Mueller Lake Park Austin",
    rules: { round_trip: false },
  },
  tinyTeams: { people: "name,score\nAna,9\nBen,7\nCy,6\nDee,4\nEd,3\nFlo,1", pairs: "" },
  classroom: {
    people: "name,reading_level,gender\n" + [["Ava", 7, "F"], ["Ben", 4, "M"], ["Cleo", 9, "F"], ["Dan", 5, "M"], ["Eve", 6, "F"], ["Finn", 3, "M"], ["Gia", 8, "F"], ["Hugo", 6, "M"],
      ["Isla", 5, "F"], ["Jack", 7, "M"], ["Kira", 4, "F"], ["Liam", 8, "M"], ["Mia", 6, "F"], ["Noah", 2, "M"], ["Olive", 7, "F"], ["Pete", 5, "M"], ["Quin", 9, "F"],
      ["Ravi", 6, "M"], ["Sara", 3, "F"], ["Theo", 7, "M"], ["Uma", 5, "F"], ["Vic", 4, "M"], ["Wren", 8, "F"], ["Xav", 6, "M"], ["Yara", 5, "F"], ["Zed", 7, "M"],
      ["Abby", 6, "F"], ["Cole", 3, "M"], ["Dina", 8, "F"], ["Eli", 5, "M"]].map((r) => r.join(",")).join("\n"),
    pairs: "Ben - Finn        # they distract each other\nNoah + Ravi       # Ravi helps Noah read\nCleo - Quin       # the two strongest readers lead different groups",
    rules: { k: 6, balance: 1, mix: 1 },
  },
  league: {
    people: "player,skill,position\n" + [["Arlo", 8, "GK"], ["Bram", 5, "GK"], ["Cato", 6, "GK"], ["Dex", 7, "GK"], ["Emil", 9, "DEF"], ["Ford", 4, "DEF"], ["Gil", 6, "DEF"], ["Hal", 7, "DEF"],
      ["Ike", 5, "MID"], ["Jon", 8, "MID"], ["Kit", 6, "MID"], ["Lou", 3, "MID"], ["Max", 9, "FWD"], ["Ned", 5, "FWD"], ["Oz", 7, "FWD"], ["Pip", 4, "FWD"],
      ["Rex", 6, "MID"], ["Sol", 7, "DEF"], ["Tad", 5, "FWD"], ["Vin", 6, "MID"]].map((r) => r.join(",")).join("\n"),
    pairs: "Jon + Kit   # they car-share\nMax - Emil  # last season's captains",
    rules: { k: 4, balance: 1, mix: 2 },
  },
};

const load = (label, s, extra = {}) => ({ act: "load", label, args: { inputs: Object.fromEntries(Object.entries(s).filter(([k]) => k !== "rules")), rules: s.rules || {}, ...extra }, primary: extra.solve });


// ---------------------------------------------------------------- the walk solver (shared by all three)
const SOLVER = {
  id: "solver", title: "How the card solves it", sum: "a model of variables, rules and a goal; thousands of walkers search it",
  body: [
    `<p>The Planner changes each problem into the same thing: a small <b>model</b> in the language of the walk solver. After a solve, open the <b>Model</b> tab to read the model that your tables made.
    The model is plain text. If you change it, Solve uses your changes.</p>
    <table class="hg-t"><tr><th>line</th><th>meaning</th></tr>
    <tr><td><code>N = 15</code>, <code>D = [[…]]</code></td><td>constants: your data, as numbers and tables</td></tr>
    <tr><td><code>var x[K] int 0..P</code></td><td>the <a data-ref="dsl.var">decisions</a>: here, K whole numbers, each from 0 to P</td></tr>
    <tr><td><code>var t perm N</code></td><td>a <a data-ref="dsl.perm">permutation</a>: an order of 0…N-1 (for routes)</td></tr>
    <tr><td><code>all(… for k in range(K))</code></td><td>a <b>hard rule</b>: it must be true for each k (<a data-ref="dsl.all">all</a>, <a data-ref="dsl.count">count</a>, <a data-ref="dsl.sum">sum</a>)</td></tr>
    <tr><td><code>minimize: …</code></td><td>the <b>goal</b>: a lower value is better (<a data-ref="dsl.minimize">minimize</a>)</td></tr>
    <tr><td><code>penalty: 300</code></td><td>the cost of one unit of a broken rule, in the units of the goal (<a data-ref="penalty">penalty</a>)</td></tr></table>
    <p>Then the card runs thousands of <b>walkers</b> at the same time, one walker on each GPU thread. Each walker starts from a random answer and makes many small changes.
    It keeps most changes that lower its <a data-ref="dsl.energy">energy</a> (penalty × the size of the rule violations + the goal).
    It also keeps some changes that increase the energy, and this part becomes smaller with time (simulated annealing). The best walker wins.</p>`,
    { note: "A hard rule is not absolute. If no better answer exists, a walker can break a rule, and the answer then shows it as “broken”. This is intentional: an answer with one clash is more useful than no answer. A separate check on the CPU then examines each answer. The Planner also shows a simple method that a person can do by hand, for comparison." },
    `<p><a data-ref="effort">Effort</a> sets the number of walkers and how long they search. If an answer has open slots or broken rules that look unnecessary, try <b>thorough</b> before you change the data.</p>`,
    { acts: [{ act: "tab", args: "model", label: "Open the Model tab" }, { act: "tab", args: "search", label: "See how the walkers converged" }, { act: "ref", args: "dsl.var", label: "Model language reference" }] },
  ],
};

// ---------------------------------------------------------------- roster
const ROSTER = [
  {
    id: "r-tables", title: "Two tables: people and shifts", sum: "a row is one person, or one shift that needs people",
    body: [
      `<p>A roster comes from two tables. <b>People</b>: one row for each person who can work. <b>Shifts</b>: one row for each shift on one day. The same shift on Monday and on Tuesday is two rows.
      The answer tells <b>who works in which seat</b>. A shift that needs 2 people has 2 seats (“slots”).</p>
      <p>The smallest roster that works has three names and two shifts. Only <code>day</code>, <code>start</code> and <code>end</code> are necessary. All the other columns have a default.</p>`,
      { csv: SAMPLES.tinyRoster.people, title: "people", field: "people", label: "Use as People" },
      { csv: SAMPLES.tinyRoster.shifts, title: "shifts", field: "shifts", label: "Use as Shifts" },
      { acts: [load("Load both and solve", SAMPLES.tinyRoster, { solve: true }), { act: "tab", args: "inputs", label: "Look at the Inputs tab" }] },
      `<p>When “one shift a day” is on, one person cannot work the two Mon shifts. Thus two of the three people work one shift each.
      Before you solve, the <b>check</b> below each table on the Inputs tab tells you how the Planner reads the table.</p>`,
    ],
  },
  {
    id: "r-cols", title: "Each column, and the values it accepts", sum: "the Planner finds a column by the start of its name; values have simple formats",
    body: [
      `<p>Column names can use capitals or not. The Planner finds a column by the <b>start</b> of its name: <code>max_shifts</code>, <code>Max</code> and <code>maximum per week</code> are all <a data-ref="p.max">max</a>.
      If two columns agree, the first one wins. If your names are different, do not rename the column. Select it in the role selector below the table.</p>
      <table class="hg-t"><tr><th>people</th><th>name starts with</th><th>value</th><th>if absent</th></tr>
      <tr><td><a data-ref="p.name">name</a></td><td>name…, person…</td><td>text</td><td>person 1, 2…</td></tr>
      <tr><td><a data-ref="p.max">max</a></td><td>max…</td><td>a whole number</td><td>no limit</td></tr>
      <tr><td><a data-ref="p.min">min</a></td><td>min…</td><td>a whole number</td><td>0</td></tr>
      <tr><td><a data-ref="p.skills">skills</a></td><td>skill…</td><td>tags: <code>nurse;senior</code></td><td>no skills</td></tr>
      <tr><td><a data-ref="p.unavailable">unavailable</a></td><td>unavail…, off…, cannot…, can't…</td><td>tags: <code>Sun;Mon Early</code></td><td>always free</td></tr>
      <tr><td><a data-ref="p.prefers">prefers</a></td><td>prefer…, like…</td><td>tags, the same as unavailable</td><td>no wishes</td></tr></table>
      <table class="hg-t"><tr><th>shifts</th><th>name starts with</th><th>value</th><th>if absent</th></tr>
      <tr><td><a data-ref="s.shift">shift</a></td><td>shift…, name…</td><td>text</td><td>shift 1, 2…</td></tr>
      <tr><td><a data-ref="s.day">day</a> *</td><td>day…, date…</td><td><code>Mon</code> or a date <code>2026-11-02</code></td><td>necessary</td></tr>
      <tr><td><a data-ref="s.start">start</a> *</td><td>start…, from…</td><td><code>07:00</code>, <code>7</code>, <code>7pm</code></td><td>necessary</td></tr>
      <tr><td><a data-ref="s.end">end</a> *</td><td>end…, to…, until…</td><td>the same; earlier than the start = overnight</td><td>necessary</td></tr>
      <tr><td><a data-ref="s.needed">needed</a></td><td>need…, people…, staff…, count…</td><td>a whole number</td><td>1</td></tr>
      <tr><td><a data-ref="s.skill">skill</a></td><td>skill…, requires…</td><td>one tag</td><td>anyone</td></tr></table>`,
      { note: "Put ; | or / between tags. A tag in unavailable or prefers agrees with the name of a shift (Early), its day (Mon or 2026-11-04), or both (Mon Early). When the days are dates, it also agrees with the weekday (Fri, Friday). The / character separates tags. Thus, in these two columns, write dates as 2026-11-04. Do not write 11/04/2026.", tone: "warn" },
      `<p>An overnight shift continues into the next day. <code>23:00</code> to <code>07:00</code> is 8 hours, and it ends the next morning. A shift with the same start and end continues for 24 hours.</p>`,
      { acts: [{ act: "tab", args: "inputs", label: "Check my tables" }, { act: "ref", args: "p.unavailable", label: "unavailable, in detail" }] },
    ],
  },
  {
    id: "r-rules", title: "Hard rules and soft goals", sum: "what must be true, and what the walkers balance",
    body: [
      `<p>The model has two types of statement. <b>Hard rules</b> must be true. Each unit of a broken rule costs the <a data-ref="penalty">penalty</a>.
      <b>Soft goals</b> add up into one score that the walkers make as low as possible. Each soft goal has a weight that you set.</p>
      <table class="hg-t"><tr><th>hard rule</th><th>comes from</th></tr>
      <tr><td>only people who can work the shift</td><td>the skill of the shift, and the unavailable tags → the table <code>OK[person][shift]</code></td></tr>
      <tr><td>no clashes</td><td>pairs of seats that one person cannot both fill: the same shift, shifts that overlap, shifts less than <a data-ref="rule.rest">rest</a> hours apart, or shifts on the same day with <a data-ref="rule.one_a_day">one shift a day</a> → <code>CONF</code></td></tr>
      <tr><td>not more than max</td><td>the <a data-ref="p.max">max</a> column → <code>MAXS</code></td></tr>
      <tr><td>not less than min</td><td>the <a data-ref="p.min">min</a> column → <code>MINS</code> (only if a person has a min)</td></tr></table>
      <table class="hg-t"><tr><th>soft goal</th><th>term in <code>minimize:</code></th></tr>
      <tr><td>fill all the seats</td><td><a data-ref="open_cost">open-slot cost</a> × the number of open seats</td></tr>
      <tr><td>share the work equally</td><td><a data-ref="rule.fair">fairness weight</a> × Σ (shifts − <a data-ref="fair_share">fair share</a>)²</td></tr>
      <tr><td>give people their wishes</td><td>− <a data-ref="rule.prefer">wishes weight</a> × the number of wishes given</td></tr></table>
      <p>An open seat is always permitted. It keeps a roster solvable when there are not sufficient people.
      But its cost is much higher than the soft goals. Thus the walkers leave a seat open only when no other answer works.</p>`,
    ],
  },
  {
    id: "r-numbers", title: "What each number really does", sum: "rest, fairness, wishes, effort — in the units of the model",
    body: [
      `<ul>
      <li><a data-ref="rule.rest"><b>Rest between shifts</b></a> (hours): if one shift ends less than this time before the next starts, one person cannot work the two. This rule only adds clash pairs. At 0, only shifts that overlap clash.</li>
      <li><a data-ref="rule.one_a_day"><b>One shift a day</b></a>: two shifts on the same day clash, also when they are far apart.</li>
      <li><a data-ref="rule.fair"><b>Fairness weight</b></a>: each person has a fair share of seats. Each shift above or below that share costs weight × (difference)².
      At 1, a person 2 shifts away from the fair share costs 4. At 0, the walkers do not consider fairness.</li>
      <li><a data-ref="rule.prefer"><b>Wishes weight</b></a>: each wish that a person gets lowers the score by this value.
      At 1, one wish has the same value as one step toward the fair share (from 1 shift away to 0).</li>
      <li><a data-ref="open_cost"><b>Open-slot cost</b></a> = 50 × (1 + fairness + wishes). Thus a higher weight never makes an empty seat look cheap. The <a data-ref="penalty">penalty</a> for a broken hard rule is two times that cost.</li>
      <li><a data-ref="effort"><b>Effort</b></a>: quick = 1,024 walkers × 1,500 sweeps (10 s at most), normal = 2,048 × 4,000 (25 s at most), thorough = 4,096 × 20,000 (75 s at most).</li></ul>`,
      { note: "The line below Rules tells you what your numbers do before you solve. For example, it shows how many seat pairs the rest rule changes into clashes." },
    ],
  },
  {
    id: "r-answer", title: "Read the answer", sum: "open, broken, unfairness, wishes — and the greedy plan for comparison",
    body: [
      `<p>A separate check examines each answer. It gives four scores, in this order of importance:</p>
      <ol><li><a data-ref="res.broken">broken</a>: the hard rules that the answer breaks, each with its name.</li>
      <li><a data-ref="res.open">open</a>: the seats that nobody fills.</li>
      <li><a data-ref="res.unfair">unfairness</a>: Σ (shifts − fair share)².</li>
      <li><a data-ref="res.wishes">wishes</a>: the requests that people get.</li></ol>
      <p>For comparison, the Planner also makes a <a data-ref="res.greedy">greedy plan</a>, as a careful person does by hand. It fills the most difficult seats first.
      It gives each seat to the person who is furthest below the fair share.
      If the greedy plan has better scores on that list, <b>the Planner shows the greedy plan</b>, and “shown” says greedy. The card must earn its place.</p>
      <p>The verdict “Not sufficient people for these shifts” comes <i>before</i> the solve. It means that a shift needs more people than the number who can work it.
      No search can repair this. You must change the data.</p>`,
      { acts: [{ act: "solve", label: "Solve the current tables", primary: true }, { act: "ref", args: "res.greedy", label: "the greedy plan, exactly" }] },
    ],
  },
  {
    id: "r-own", title: "Your own data: a café and a call centre", sum: "the same tables fit any rota",
    body: [
      `<p><b>A café weekend.</b> It has different shifts, a min for people who need hours, skills to open the café and to work the till, and wishes.
      See <code>Sat Open</code> as a wish (day + shift). See <code>Sun Close</code> as one shift that a person cannot work.</p>`,
      { csv: SAMPLES.cafe.people, title: "people — café", field: "people", label: "Use as People" },
      { csv: SAMPLES.cafe.shifts, title: "shifts — café", field: "shifts", label: "Use as Shifts" },
      { acts: [load("Load the café and solve", SAMPLES.cafe, { solve: true })] },
      `<p><b>A call centre with real dates.</b> When each day is a date, the Planner measures rest across the real calendar.
      A person can be off by weekday (<code>Fri</code>), by date (<code>2026-11-04</code>) or by date and shift (<code>2026-11-02 Morning</code>). The Spanish line is a separate shift with a skill.</p>`,
      { csv: SAMPLES.callcentre.people, title: "people — call centre", field: "people", label: "Use as People" },
      { csv: SAMPLES.callcentre.shifts, title: "shifts — call centre", field: "shifts", label: "Use as Shifts" },
      { acts: [load("Load the call centre and solve", SAMPLES.callcentre, { solve: true })] },
      `<p>If your data is in a different place, click <b>Data Desk…</b> above a table. It loads a table as CSV. The column names do not have to be ours.
      Map the columns in the role selector below the table. The Planner remembers how you map the columns.</p>`,
    ],
  },
  {
    id: "r-model", title: "Change the model itself", sum: "when the tables cannot say it",
    body: [
      `<p>Some rules have no column, for example “Ana and Ben never on the same shift” or “not more than two nights in sequence”.
      Solve one time, open the <b>Model</b> tab, and add a line. Seat <code>k</code> is part of shift <code>SHIFT[k]</code>.
      <code>x[k]</code> is the person, with numbers from 0 in the order of the table. <code>P</code> means open.</p>
      <div class="hcode"><pre># Ana (0) and Ben (1) never share a shift
all(not (x[a] == 0 and x[b] == 1) and not (x[a] == 1 and x[b] == 0) for a in range(K) for b in range(K) if SHIFT[a] == SHIFT[b])</pre></div>
      <p>Then Solve uses your text, and “edited” shows next to it. <b>Regenerate from the inputs</b> removes your changes.
      The check examines only the rules that the Planner knows. Thus, examine a rule that you wrote yourself in the result.</p>`,
      { acts: [{ act: "tab", args: "model", label: "Open the Model tab" }] },
    ],
  },
];

// ---------------------------------------------------------------- route
const ROUTE = [
  {
    id: "o-table", title: "One table: the stops", sum: "a row is a place; the first row is where you start",
    body: [
      `<p>A route is one table of <b>stops</b>. The answer is the order of the visits. The <b>first row is the start</b>, for example the depot, your home or the office. It stays first.</p>
      <p>You can give the places in three ways. The Planner uses the first way that the table has:</p>
      <table class="hg-t"><tr><th>columns</th><th>distance</th></tr>
      <tr><td><a data-ref="r.latlon">lat + lon</a> (lon…, lng…, long…)</td><td>great-circle kilometres</td></tr>
      <tr><td><a data-ref="r.xy">x + y</a></td><td>straight lines in your own units (metres in a warehouse, grid squares)</td></tr>
      <tr><td><a data-ref="r.address">address</a> (addr…, location…, where…)</td><td>found on OpenStreetMap, then kilometres</td></tr></table>`,
      { csv: SAMPLES.tinyRoute.stops, title: "stops — four corners", field: "stops", label: "Use as Stops" },
      { acts: [load("Load and solve", SAMPLES.tinyRoute, { solve: true })] },
      { note: "The distances are straight lines, not roads. In a city, the order of routes by straight lines is usually the same as by road. But rivers, motorways and one-way streets can make the real drive different.", tone: "warn" },
    ],
  },
  {
    id: "o-rules", title: "Round trip or one way", sum: "the one rule, and the limits",
    body: [
      `<p>When <a data-ref="rule.round_trip"><b>Return to the start</b></a> is on, the route ends where it started, and the last part to the start counts.
      When it is off, the route starts at the first row and ends at the stop that gives the shortest total. Use this when the day ends at home, not at the depot.</p>
      <p>The model is a <a data-ref="dsl.perm">permutation</a> of the other stops: <code>var t perm N</code>. The goal is the total length of the legs in that order.
      There are no hard rules to break, so a route is always complete. The only question is how short it is.</p>
      <ul><li>3 to 120 stops.</li><li>The Planner finds one address each second (the OpenStreetMap rule) and keeps the result. Thus the first run with 30 new addresses takes about 30 s. Later runs are immediate.</li></ul>`,
    ],
  },
  {
    id: "o-answer", title: "Read the answer", sum: "three baselines, and a proof when the route is small",
    body: [
      `<p>For comparison with the route of the walkers, the Planner calculates:</p>
      <ul><li><a data-ref="res.nearest">nearest neighbour</a>: always go to the nearest stop that is not visited.</li>
      <li><a data-ref="res.two_opt">+ 2-opt</a>: then reverse parts of the route while this makes it shorter. This is a strong, well-known method.</li>
      <li><a data-ref="res.optimum">optimum</a>: for 13 stops or fewer, the exact shortest route (Held–Karp). It shows if a shorter route was possible.</li></ul>
      <p>The Planner shows the shortest of the walkers, 2-opt and the exact answer (“shown”). <b>Google Maps</b> opens the route for directions.
      It divides the route into parts of ten points, because one link holds only ten points.</p>`,
      { acts: [{ act: "solve", label: "Solve the current stops", primary: true }] },
    ],
  },
  {
    id: "o-own", title: "Your own data: a pick list and sales calls", sum: "x/y in a building, or plain addresses",
    body: [
      `<p><b>A warehouse pick list</b> in metres from the dock. It has 12 stops, so the Planner also calculates the exact optimum.</p>`,
      { csv: SAMPLES.warehouse.stops, title: "stops — warehouse (metres)", field: "stops", label: "Use as Stops" },
      { acts: [load("Load the pick list and solve", SAMPLES.warehouse, { solve: true })] },
      `<p><b>Sales calls by address</b>, one way from the office. The first run finds each address (about one second for each).</p>`,
      { csv: SAMPLES.sales.stops, title: "stops — addresses", field: "stops", label: "Use as Stops" },
      { acts: [load("Load the calls and solve", SAMPLES.sales, { solve: true })] },
      `<p>A table with other column names, for example <code>Customer, Latitude, Longitude</code>, works without changes, because the Planner reads the start of each name.
      For other names, map the columns in the role selector below the table.</p>`,
    ],
  },
  {
    id: "o-costs", title: "Any cost: time, money, risk", sum: "a cost table instead of map points; one-way costs are allowed",
    body: [
      `<p>Distance is only one kind of cost. When the cost of going from one stop to the next is <b>time</b>, <b>money</b>, <b>risk</b> or a <b>changeover</b>
      (cleaning a machine between two jobs), give a <a data-ref="r.costs">cost table</a> in the second box. The Planner then ignores the coordinates and
      finds the order with the lowest total cost, against the same baselines.</p>
      <p>A matrix: line 1 names the stops; then one line for each stop, with the cost from that stop to each stop of line 1. The first stop is the start.
      The cost from A to B can differ from B to A. A blank cell means that the leg is not allowed.</p>`,
      { csv: "from,Depot,Clinic,School,Mill\nDepot,0,14,22,31\nClinic,12,0,11,24\nSchool,25,13,0,15\nMill,34,26,14,0", title: "drive minutes (one-way costs differ)", field: "costs", label: "Use as Cost table" },
      { acts: [load("Load and solve", { stops: "", costs: "from,Depot,Clinic,School,Mill\nDepot,0,14,22,31\nClinic,12,0,11,24\nSchool,25,13,0,15\nMill,34,26,14,0" }, { solve: true })] },
      `<p>Or one line for each pair: <code>from,to,cost</code>. A pair that is given in one direction costs the same in the other. A pair that is not given is not allowed.
      Set <b>unit</b> next to the box (min, $, risk points) so that the answer names it. The templates on the left (visit time, money, risk, job changeover) are complete examples.</p>`,
    ],
  },
];

// ---------------------------------------------------------------- teams
const TEAMS = [
  {
    id: "t-table", title: "People, and what to balance", sum: "a row is a person; a number to balance, a label to spread",
    body: [
      `<p>Teams need one table of <b>people</b>. Two optional columns make the problem more useful:</p>
      <ul><li>a <a data-ref="t.score"><b>score</b></a> (rating, level, years). The Planner makes the team totals as equal as possible.</li>
      <li>a <a data-ref="t.category"><b>category</b></a> (department, position, gender). Each team gets its fair share of each value.</li></ul>
      <p>The Planner finds these columns by their contents, not by their names.
      The score is the <b>first column after the name with only numbers</b>. The category is the <b>first other column with 2 to n/2 different values</b>.
      The check below the table tells you which columns it selected. You can select different columns there.</p>`,
      { csv: SAMPLES.tinyTeams.people, title: "people — six players", field: "people", label: "Use as People" },
      { acts: [load("Load and solve (2 teams)", { ...SAMPLES.tinyTeams, rules: { k: 2 } }, { solve: true })] },
    ],
  },
  {
    id: "t-rules", title: "Pair rules and sizes", sum: "together, apart, and teams of equal size",
    body: [
      `<p>Write one <a data-ref="t.pairs">pair rule</a> on each line. Write the names as in the table (capitals are not important). The text after <code>#</code> is a comment.</p>
      <table class="hg-t"><tr><th>together</th><th>apart</th></tr>
      <tr><td><code>Ann + Bo</code> · <code>Ann with Bo</code> · <code>Ann together with Bo</code> · <code>Ann == Bo</code></td>
      <td><code>Ann - Cy</code> · <code>Ann not with Cy</code> · <code>Ann apart from Cy</code> · <code>Ann != Cy</code></td></tr></table>`,
      { note: "The Planner reads a hyphen in a name (Mary-Jane) as “apart”. For such a name, write the rule as Mary-Jane apart from Bo. The check below Pair rules shows each line with names that are not in the table. The Planner does not use those lines.", tone: "warn" },
      `<p><a data-ref="res.sizes">Team sizes</a> are hard limits. With n people and k teams, each team has from ⌊n/k⌋ to ⌈n/k⌉ people. Pair rules are also hard rules.</p>`,
    ],
  },
  {
    id: "t-numbers", title: "What the weights mean", sum: "balance and mix, in the units of the model",
    body: [
      `<ul><li><a data-ref="rule.k"><b>Teams</b></a>: k, from 2 to 20. Each team must have at least 2 people.</li>
      <li><a data-ref="rule.balance"><b>Balance weight</b></a>: the Planner standardises the scores (mean 0, one standard deviation = 1).
      The goal adds weight × Σ over teams of (the standardised total of the team)². Equal totals give 0.</li>
      <li><a data-ref="rule.mix"><b>Mix weight</b></a>: for each team and each category value, the goal adds weight × (the count in the team − the fair share)².
      The fair share is the count of that value ÷ k.</li></ul>
      <p>If the two weights conflict, increase the weight that is more important to you.
      In the league below, mix 2 makes “one keeper on each team” more important than a slightly better balance of skill.</p>`,
    ],
  },
  {
    id: "t-answer", title: "Read the answer", sum: "spread, mix error, and the snake draft",
    body: [
      `<p><a data-ref="res.spread">spread</a> is the difference between the highest and the lowest team total, in the units of your score.
      <a data-ref="res.mixerr">mix error</a> is the sum of the squared category differences. <a data-ref="res.broken">broken</a> shows the pair rules or size rules that are not true.</p>
      <p>The baseline is a <a data-ref="res.snake">snake draft</a>: the best player goes to team 1, the next to team 2, and so on, then back in the opposite direction.
      Most people select teams by hand in this way. The Planner shows the answer of the walkers only if it is equal or better (fewer broken rules, then a smaller spread + mix error).</p>`,
      { acts: [{ act: "solve", label: "Solve the current people", primary: true }] },
    ],
  },
  {
    id: "t-own", title: "Your own data: a classroom and a league", sum: "groups that are fair in two ways at the same time",
    body: [
      `<p><b>A class of 30</b> in 6 reading groups. The groups have a balance of reading level and a mix of gender. The teacher adds three rules.</p>`,
      { csv: SAMPLES.classroom.people, title: "people — class", field: "people", label: "Use as People" },
      { csv: SAMPLES.classroom.pairs, title: "pair rules", field: "pairs", label: "Use as Pair rules" },
      { acts: [load("Load the class and solve", SAMPLES.classroom, { solve: true })] },
      `<p><b>A 5-a-side league</b>: 20 players, 4 teams, with the keepers on different teams. The name column is <code>player</code>, which is not a name that the Planner knows.
      Thus, open the Inputs tab and set <b>name → player</b> in the role selector. If you do not, the names show as person 1, 2…</p>`,
      { csv: SAMPLES.league.people, title: "people — league", field: "people", label: "Use as People" },
      { acts: [load("Load the league", SAMPLES.league), { act: "tab", args: "inputs", label: "Map the columns" }] },
    ],
  },
];

export const LESSONS = { roster: [...ROSTER, SOLVER], route: [...ROUTE, SOLVER], teams: [...TEAMS, SOLVER] };

// ---------------------------------------------------------------- reference
const R = (k, t, d, sig) => ({ k, t, d, sig });
const SHARED = [
  R("effort", "Effort", `How much work the card does to search. <b>quick</b>: 1,024 walkers × up to 1,500 sweeps, stopped at 10 s. <b>normal</b>: 2,048 × 4,000, 25 s. <b>thorough</b>: 4,096 × 20,000, 75 s.
    A sweep tries one change for each decision variable. More effort helps only when the answer still has open slots, broken rules or a gap to the baseline.`),
  R("tpl", "Templates", `Everyday problems, already in the Planner's text format: hospital shifts, team staffing (a role in a week is a shift), fair teams, a delivery route, and visit orders where the cost is time, money, risk or a changeover.
    A template fills the boxes; change the text to your own data. An agent gets the same templates over MCP (problem_templates), and the Console as <code>vf.solve.template(id)</code>.`),
  R("penalty", "Penalty", `The value that one unit of a broken hard rule adds to the energy of a walker, in the units of the goal.
    The Planner sets it much higher than each soft goal (roster: 2 × the open-slot cost; teams: 50). Thus walkers break a rule only when no other answer works.`, "penalty: <number>"),
  R("res.shown", "shown", `The answer on the screen: <b>walkers</b> (the card), or the baseline (greedy / 2-opt / exact / snake draft) if the baseline has better scores on the checks of the problem.`),
  R("res.broken", "broken", `The hard rules that the shown answer breaks, each in a list. For rosters: a person who cannot work the shift, a clash, more than max or less than min. For teams: a pair rule or a team size.`),
  R("dsl.var", "var", `Declares decision variables. <code>var x[K] int 0..P</code> = K whole numbers from 0 to P. <code>var a, b int 1..9</code> = scalars. Also <code>real lo..hi</code>, <code>bool</code> and <code>perm</code>.`, "var name[n] int lo..hi | real lo..hi | bool | perm"),
  R("dsl.perm", "perm", `<code>var t perm N</code>: t is an order of 0…N-1, with each value one time. A walker changes it when it exchanges two positions. Thus it is always a correct order.`, "var t perm N"),
  R("dsl.all", "all( … )", `A hard rule that must be true for each item: <code>all(OK[x[k]][SHIFT[k]] == 1 for k in range(K))</code>. Its violation is the sum of the violations of the items.`, "all(<condition> for i in range(n) [if …])"),
  R("dsl.count", "count( … )", `The number of items that agree with a condition: <code>count(1 for k in range(K) if x[k] == p)</code> = the seats that person p works.`, "count(1 for i in range(n) if <condition>)"),
  R("dsl.sum", "sum( … )", `Adds an expression over items: <code>sum(D[t[i]+1][t[i+1]+1] for i in range(N - 1))</code> = the length of the route.`, "sum(<expr> for i in range(n) [if …])"),
  R("dsl.minimize", "minimize:", `The goal. After the hard rules, the walkers make it as low as possible. Write it on one line. <code>maximize:</code> also works.`, "minimize: <expr>"),
  R("dsl.energy", "energy", `The value that a walker lowers: penalty × (the total violation of the hard rules) + the goal.
    A violation is the distance of a rule from true: |a−b| for ==, the amount over the limit for <=, and 1 for a false yes/no. <code>and</code> adds the violations. <code>or</code> takes the smaller one.`),
];
const ROSTER_REF = [
  R("p.name", "people · name", `The first column with a name that starts with <code>name</code> or <code>person</code>. If it is empty or absent: “person N”. The answer uses it. Pair rules that you write into the model use the position (from 0).`),
  R("p.max", "people · max", `A column that starts with <code>max…</code>. The maximum number of seats for this person (a hard rule). If it is empty or not a number: no limit.`),
  R("p.min", "people · min", `A column that starts with <code>min…</code>. The minimum number of seats (a hard rule; the Planner adds it only if a person has one). If it is empty: 0.
    If the person cannot get to the min, the answer shows it as broken.`),
  R("p.skills", "people · skills", `A column that starts with <code>skill…</code>. Put ; | or / between the tags. A shift with a skill can go only to a person with that exact tag (capitals are not important).`),
  R("p.unavailable", "people · unavailable", `A column that starts with <code>unavail…</code>, <code>off…</code>, <code>cannot…</code> or <code>can't…</code>. Tags. Each tag blocks each shift whose name, day, or “day name” is the same.
    When the days are dates, it also blocks the weekday (<code>fri</code> / <code>friday</code>). The check shows the tags that agree with nothing. Usually, such a tag has a typo.`),
  R("p.prefers", "people · prefers", `A column that starts with <code>prefer…</code> or <code>like…</code>. The same tags as unavailable. Each seat on a shift that agrees lowers the goal by the wishes weight.`),
  R("s.shift", "shifts · shift", `A column that starts with <code>shift…</code> or <code>name…</code>. The name of the shift (Early, Night). If it is empty: “shift N”. The unavailable and prefers tags use these names.`),
  R("s.day", "shifts · day (necessary)", `A column that starts with <code>day…</code> or <code>date…</code>. Any label (Mon) or a date.
    If <b>each</b> day is a date (2026-11-02, 11/02/2026, 2 Nov 2026 …), the Planner measures rest on the calendar.
    If not, it uses the days in the order in which they first show, one day apart. Thus, write them in order.`),
  R("s.start", "shifts · start (necessary)", `A column that starts with <code>start…</code> or <code>from…</code>. <code>07:00</code>, <code>7</code>, <code>7:30pm</code>, <code>12am</code>. Other text gives an error.`),
  R("s.end", "shifts · end (necessary)", `A column that starts with <code>end…</code>, <code>to…</code> or <code>until…</code>. The same format. An end at or before the start continues after midnight (23:00–07:00 = 8 h). An equal end = 24 h.`),
  R("s.needed", "shifts · needed", `A column that starts with <code>need…</code>, <code>people…</code>, <code>staff…</code> or <code>count…</code>. The number of seats on that shift. If it is empty: 1. The maximum is 600 seats in total.`),
  R("s.skill", "shifts · skill", `A column that starts with <code>skill…</code> or <code>requires…</code>. One tag that each person on the shift must have. If it is empty: anyone.`),
  R("rule.rest", "Rest between shifts (h)", `If one shift ends less than this number of hours before another starts, one person cannot work the two. Each such pair of seats becomes a clash in <code>CONF</code> (a hard rule).
    Shifts that overlap always clash. The Planner refuses more than 20,000 clash pairs. If this occurs, plan one or two weeks at a time.`),
  R("rule.one_a_day", "One shift a day", `On: two shifts on the same day clash, also when they are far apart.`),
  R("rule.fair", "Fairness weight", `Multiplies Σ over people of (seats − fair share)² in the goal. 0 = the walkers do not consider fairness. The “unfairness” in the verdict is that sum, without the weight.`),
  R("rule.prefer", "Wishes weight", `Each wish that a person gets (a seat on a shift that the person prefers) subtracts this value from the goal.`),
  R("fair_share", "fair share", `The target number of seats for each person. Each person gets the same amount L, but never more than the max or the number of seats that the person can work.
    The Planner selects L so that the targets add up to the number of seats. Then it increases each target to the min. The answer shows it as “/ n” next to the count of each person.`),
  R("open_cost", "open-slot cost", `An open seat costs 50 × (1 + fairness weight + wishes weight) in the goal. Thus it is always more than a trade between fairness and wishes. It is a part of the goal, not a broken rule.`),
  R("res.open", "open", `The seats that nobody fills in the shown answer.`),
  R("res.unfair", "unfairness", `Σ (seats − fair share)² over people. 0 = each person has exactly the fair share.`),
  R("res.wishes", "wishes", `The seats that go to a person on a shift that the person prefers.`),
  R("res.greedy", "greedy plan (baseline)", `The plan takes the seats in order of how few people can work them (then by start time).
    Each seat goes to the person who can work it, has no clash, is below max, and is furthest below the fair share. If two people are equal, a wish decides.
    The comparison uses (broken, open, unfairness, −wishes) in that order. If the greedy plan is better, the Planner shows it, not the walkers.`),
  R("res.spread", "spread", `The most seats that one person works, minus the fewest.`),
];
const ROUTE_REF = [
  R("r.name", "stops · name", `A column that starts with <code>name…</code>, <code>stop…</code> or <code>place…</code>. If there is none: the address. If there is no address: “stop N”. The first row is the start.`),
  R("r.latlon", "stops · lat + lon", `The two are necessary: <code>lat…</code> and <code>lon…</code> / <code>lng…</code> / <code>long…</code>, in decimal degrees. The distances are great-circle km. The Planner uses them before x/y and address.`),
  R("r.xy", "stops · x + y", `<code>x…</code> and <code>y…</code> in any unit. The distance is a straight line in that unit (“units”). The Planner uses them when there are no lat/lon columns.`),
  R("r.address", "stops · address", `<code>address…</code>, <code>addr…</code>, <code>location…</code> or <code>where…</code>. The server finds each address on OpenStreetMap Nominatim, one each second, and keeps the result.
    If it cannot find an address, the solve stops and shows its name.`),
  R("r.costs", "cost table", `Any cost between stops, in any unit: a matrix (line 1 names the stops, then one line for each stop) or <code>from,to,cost</code> lines.
    One-way costs can differ. A blank, <code>-</code> or <code>x</code> means that the leg is not allowed; a pair missing from the from,to list is not allowed, and a pair given one way costs the same both ways.
    With a cost table the stops box is optional: stops with the same names and lat/lon draw the map. The server checks the table as you type and names the line of an error.`),
  R("rule.round_trip", "Return to the start", `On: the last part, back to the first row, counts. Off: one way, and the route ends at the stop that gives the shortest total.`),
  R("res.length", "length", `The total of the legs in the shown order (and the way back on a round trip), as straight lines.`),
  R("res.nearest", "nearest-nbr", `Baseline: from the start, always go to the nearest stop that is not visited.`),
  R("res.two_opt", "+ 2-opt", `Baseline: the nearest-neighbour route. Then the method reverses each part that makes the route shorter, until no such part remains.`),
  R("res.walkers", "walkers", `The best route that the GPU walkers found.`),
  R("res.optimum", "optimum", `The proven shortest route from Held–Karp dynamic programming. The Planner calculates it for 13 stops or fewer. If there are more, it shows “n > 13”.`),
];
const TEAMS_REF = [
  R("t.name", "people · name", `A column that starts with <code>name…</code> or <code>person…</code>. If there is none: “person N”. Pair rules use these names.`),
  R("t.score", "people · score (found by contents)", `The first column after the name in which all the cells that are not empty are numbers. The Planner balances its standardised value across teams.
    If there is no such column, balance is off. Select a different column, or none, in the role selector.`),
  R("t.category", "people · category (found by contents)", `The first of the other columns with 2 to max(2, n/2) different values (an empty cell counts as a value). Each team gets about count ÷ k of each value.
    A column with more values is not a category.`),
  R("t.pairs", "Pair rules", `One rule on each line. Same team: <code>A + B</code>, <code>A with B</code>, <code>A together with B</code>, <code>A == B</code>. Different teams: <code>A - B</code>, <code>A not with B</code>, <code>A apart from B</code>, <code>A != B</code>.
    The names must agree with the table (capitals are not important). <code>#</code> starts a comment. If a name is unknown, the Planner does not use the line and shows it in a list.`),
  R("rule.k", "Teams", `k, from 2 to 20. It needs at least 2k people. The maximum is 400 people.`),
  R("rule.balance", "Balance weight", `× Σ over teams of (the sum of the standardised scores in the team)². Only when there is a score.`),
  R("rule.mix", "Mix weight", `× Σ over teams and category values of (count − the total of the value ÷ k)². Only when there is a category.`),
  R("res.sizes", "team sizes", `Hard limits: from ⌊n/k⌋ to ⌈n/k⌉ people on each team.`),
  R("res.spread", "total spread", `The highest team total minus the lowest, in the units of the score.`),
  R("res.mixerr", "mix error", `Σ (count − fair count)² over teams and category values. 0 = the mix is exactly equal.`),
  R("res.snake", "snake draft (baseline)", `The players in order of score go to teams 1, 2 … k, then k … 1, and so on. The comparison uses (broken, spread + mix error). If the snake draft is better, the Planner shows it.`),
];
export const REF = { roster: [...ROSTER_REF, ...SHARED], route: [...ROUTE_REF, ...SHARED], teams: [...TEAMS_REF, ...SHARED] };
