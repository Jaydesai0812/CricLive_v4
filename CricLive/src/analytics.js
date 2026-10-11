// =====================================================================
//  Analytics + AI player segmentation
//
//  Segmentation follows the same method as the customer-segmentation
//  notebook (RFM + K-Means), applied to cricketers:
//    1. build one feature row per player from the database
//    2. log1p transform (reduce skew)   3. standard-scale (z-scores)
//    4. K-Means for k = 2..8 -> inertia  (elbow method)
//    5. final K-Means with k = 4 (best of 10 seeded runs)
//    6. profile each cluster, give it a cricket name + a recommendation
// =====================================================================
const db = require('./db');
const { overs, rate, sr } = require('./util');

const BOWLER_WICKETS = ['bowled', 'caught', 'caught_bowled', 'lbw', 'stumped', 'hit_wicket'];
const fullName = p => `${p.first_name} ${p.last_name}`;
const r1 = n => Math.round(n * 10) / 10;
const r2 = n => Math.round(n * 100) / 100;
const shortDate = d => d ? new Date(String(d).replace(' ', 'T')).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';

// ------------------------------------------------------------ K-Means (no libraries)
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const dist2 = (a, b) => a.reduce((t, v, i) => t + (v - b[i]) ** 2, 0);

function kmeansOnce(X, k, rand, maxIter = 100) {
  // k-means++ initialisation
  const C = [X[Math.floor(rand() * X.length)].slice()];
  while (C.length < k) {
    const d = X.map(x => Math.min(...C.map(c => dist2(x, c))));
    const total = d.reduce((a, b) => a + b, 0);
    let r = rand() * total, i = 0;
    while (i < d.length - 1 && (r -= d[i]) > 0) i++;
    C.push(X[i].slice());
  }
  let labels = new Array(X.length).fill(-1);
  for (let it = 0; it < maxIter; it++) {
    let moved = false;
    labels = labels.map((old, i) => {
      let best = 0, bd = Infinity;
      C.forEach((c, j) => { const d = dist2(X[i], c); if (d < bd) { bd = d; best = j; } });
      if (best !== old) moved = true;
      return best;
    });
    for (let j = 0; j < k; j++) {
      const members = X.filter((_, i) => labels[i] === j);
      if (members.length) C[j] = members[0].map((_, f) => members.reduce((t, m) => t + m[f], 0) / members.length);
    }
    if (!moved) break;
  }
  const inertia = X.reduce((t, x, i) => t + dist2(x, C[labels[i]]), 0);
  return { labels, centroids: C, inertia };
}

function kmeans(X, k, nInit = 10, seed = 42) {
  const rand = rng(seed);
  let best = null;
  for (let n = 0; n < nInit; n++) {
    const r = kmeansOnce(X, k, rand);
    if (!best || r.inertia < best.inertia) best = r;
  }
  return best;
}

// ------------------------------------------------------------ segmentation
const PRIOR = 15; // balls
const FEATURES = [
  { key: 'runs_per_match', label: 'Runs per match' },
  { key: 'strike_rate', label: 'Batting strike rate' },
  { key: 'boundary_pct', label: 'Boundary %' },
  { key: 'wickets_per_match', label: 'Wickets per match' },
  { key: 'balls_bowled_per_match', label: 'Balls bowled per match' },
];

const SEGMENTS = {
  'Power Hitters': {
    score: z => z.strike_rate + z.boundary_pct + 0.5 * z.runs_per_match - 0.5 * z.balls_bowled_per_match,
    description: 'Fast scorers who hit a high share of boundaries.',
    recommendation: 'Use in the powerplay and death overs. Work on shot selection and running between wickets to cut cheap dismissals.',
  },
  'Anchor Batters': {
    score: z => 1.5 * z.runs_per_match - 0.3 * z.strike_rate - z.balls_bowled_per_match,
    description: 'Consistent run makers who build the innings.',
    recommendation: 'Bat in the top order to hold the innings together. Practise rotating strike to lift the strike rate in the middle overs.',
  },
  'Strike Bowlers': {
    score: z => 1.5 * z.wickets_per_match + z.balls_bowled_per_match - 0.5 * z.runs_per_match,
    description: 'Front-line bowlers who take wickets regularly.',
    recommendation: 'Give the new ball and the death overs. Build batting basics so they can add useful lower-order runs.',
  },
  'All-round Contributors': {
    score: z => z.runs_per_match + z.wickets_per_match + 0.5 * z.balls_bowled_per_match,
    description: 'Players who contribute with both bat and ball.',
    recommendation: 'Pick in every XI for balance. Develop a specialist role (death bowling or finishing) to increase match impact.',
  },
  'Developing Players': {
    score: z => -(z.runs_per_match + z.wickets_per_match + z.strike_rate),
    description: 'Players with limited impact so far.',
    recommendation: 'Give more net sessions and match time in lower-pressure games. Set small targets (strike rotation, accurate lines) and track progress.',
  },
};

async function playerFeatureRows() {
  const rows = await db.all(`SELECT p.id, p.first_name, p.last_name, p.role, p.team_id, t.short_name, t.name AS team_name, s.*
      FROM player_stats s JOIN players p ON p.id = s.player_id LEFT JOIN teams t ON t.id = p.team_id
      WHERE s.matches > 0`);
  return rows.filter(r => r.bat_innings >= 2 || r.balls_bowled >= 12).map(r => ({
    id: r.id, name: fullName(r), role: r.role, team: r.short_name, team_name: r.team_name, team_id: r.team_id, matches: r.matches,
    runs: r.runs, wickets: r.wickets,
    batting_average: r.bat_innings - r.not_outs > 0 ? r2(r.runs / (r.bat_innings - r.not_outs)) : r.runs,
    economy: r.balls_bowled ? r2(r.runs_conceded * 6 / r.balls_bowled) : null,
    // strike rate and boundary % are "shrunk" towards a neutral value when a player
    // has faced few balls, so one lucky hit does not make a tail-ender a power hitter
    f: {
      runs_per_match: r.runs / r.matches,
      strike_rate: (r.runs + 0.9 * PRIOR) * 100 / (r.balls_faced + PRIOR),
      boundary_pct: ((r.fours + r.sixes) + 0.08 * PRIOR) * 100 / (r.balls_faced + PRIOR),
      wickets_per_match: r.wickets / r.matches,
      balls_bowled_per_match: r.balls_bowled / r.matches,
    },
  }));
}

let cache = { key: null, value: null };

async function segmentation() {
  const stamp = await db.get('SELECT MAX(updated_at) AS u, COUNT(*) AS n FROM player_stats');
  const key = `${stamp.u}|${stamp.n}`;
  if (cache.key === key) return cache.value;

  const players = await playerFeatureRows();
  const K = Number(process.env.SEGMENTS_K) || 4; // chosen with the elbow method, as in the notebook
  if (players.length < K * 3) {
    cache = { key, value: { ready: false, message: 'Not enough match data yet - play a few more matches to unlock player segmentation.', players: [], segments: [], elbow: [] } };
    return cache.value;
  }
  // 1-3: log transform + standard scaling
  const logged = players.map(p => FEATURES.map(f => Math.log1p(Math.max(0, p.f[f.key]))));
  const mean = FEATURES.map((_, j) => logged.reduce((t, r) => t + r[j], 0) / logged.length);
  const std = FEATURES.map((_, j) => Math.sqrt(logged.reduce((t, r) => t + (r[j] - mean[j]) ** 2, 0) / logged.length) || 1);
  const X = logged.map(r => r.map((v, j) => (v - mean[j]) / std[j]));

  // 4: elbow method
  const elbow = [];
  for (let k = 2; k <= Math.min(8, players.length - 1); k++) elbow.push({ k, inertia: r2(kmeans(X, k).inertia) });

  // 5: final model
  const model = kmeans(X, K);

  // 6: profile clusters (z-score of each cluster's average) and name them
  const clusters = [...Array(K)].map((_, c) => {
    const idx = model.labels.map((l, i) => (l === c ? i : -1)).filter(i => i >= 0);
    const z = {}, avg = {};
    FEATURES.forEach((f, j) => {
      z[f.key] = idx.reduce((t, i) => t + X[i][j], 0) / (idx.length || 1);
      avg[f.key] = idx.reduce((t, i) => t + players[i].f[f.key], 0) / (idx.length || 1);
    });
    return { c, idx, z, avg };
  });
  const names = Object.keys(SEGMENTS);
  const pairs = [];
  for (const cl of clusters) for (const n of names) pairs.push({ c: cl.c, n, s: SEGMENTS[n].score(cl.z) });
  pairs.sort((a, b) => b.s - a.s);
  const nameOf = {}, used = new Set();
  for (const p of pairs) if (nameOf[p.c] === undefined && !used.has(p.n)) { nameOf[p.c] = p.n; used.add(p.n); }

  const order = names.filter(n => used.has(n));
  const segments = order.map(n => {
    const cl = clusters.find(x => nameOf[x.c] === n);
    return {
      name: n, description: SEGMENTS[n].description, recommendation: SEGMENTS[n].recommendation,
      count: cl.idx.length, percentage: r1(cl.idx.length * 100 / players.length),
      avg: Object.fromEntries(FEATURES.map(f => [f.key, r2(cl.avg[f.key])])),
      top: cl.idx.map(i => players[i]).sort((a, b) => (b.runs + b.wickets * 20) - (a.runs + a.wickets * 20)).slice(0, 5).map(p => ({ id: p.id, name: p.name, team: p.team })),
    };
  });
  const out = players.map((p, i) => ({
    id: p.id, name: p.name, team: p.team, team_id: p.team_id, role: p.role, matches: p.matches, runs: p.runs, wickets: p.wickets,
    batting_average: p.batting_average, economy: p.economy, segment: nameOf[model.labels[i]],
    ...Object.fromEntries(FEATURES.map(f => [f.key, r2(p.f[f.key])])),
  }));
  cache = { key, value: { ready: true, k: K, features: FEATURES, elbow, segments, players: out, total: players.length } };
  return cache.value;
}

async function segmentOf(playerId) {
  const s = await segmentation();
  if (!s.ready) return null;
  const p = s.players.find(x => x.id === Number(playerId));
  if (!p) return null;
  const seg = s.segments.find(x => x.name === p.segment);
  return { name: seg.name, description: seg.description, recommendation: seg.recommendation };
}

// ------------------------------------------------------------ player charts
async function playerCharts(pid) {
  const inns = await db.all(`SELECT bs.runs, bs.balls, bs.is_out, bs.wicket_type, bs.team_id, m.id AS match_id, m.match_date, m.team1_id, m.team2_id
      FROM batting_scores bs JOIN matches m ON m.id = bs.match_id WHERE bs.player_id = ? ORDER BY m.match_date, m.id`, [pid]);
  const bowl = await db.all(`SELECT bw.legal_balls, bw.runs, bw.wickets, bw.team_id, m.id AS match_id, m.match_date, m.team1_id, m.team2_id
      FROM bowling_scores bw JOIN matches m ON m.id = bw.match_id WHERE bw.player_id = ? AND bw.legal_balls > 0 ORDER BY m.match_date, m.id`, [pid]);
  const teams = new Map((await db.all('SELECT id, short_name FROM teams')).map(t => [t.id, t.short_name]));
  const opp = r => teams.get(r.team1_id === r.team_id ? r.team2_id : r.team1_id) || '?';

  let cum = 0;
  const innings = inns.map((r, i) => { cum += r.runs; return { n: i + 1, label: `v ${opp(r)} ${shortDate(r.match_date)}`, runs: r.runs, balls: r.balls, not_out: !r.is_out, cumulative: cum, match_id: r.match_id }; });

  const shots = await db.all(`SELECT runs_bat, COUNT(*) AS n FROM balls WHERE batsman_id = ? AND (extra_type IS NULL OR extra_type IN ('nb','b','lb')) GROUP BY runs_bat`, [pid]);
  const shotMap = Object.fromEntries(shots.map(s => [s.runs_bat, Number(s.n)]));
  const scoring = [['Dots', 0], ['1s', 1], ['2s', 2], ['3s', 3], ['4s', 4], ['6s', 6]].map(([label, r]) => ({ label, value: shotMap[r] || 0 }));

  const howOut = {};
  for (const r of inns) if (r.is_out) howOut[r.wicket_type] = (howOut[r.wicket_type] || 0) + 1;
  const pretty = { bowled: 'Bowled', caught: 'Caught', caught_bowled: 'Caught & bowled', lbw: 'LBW', stumped: 'Stumped', run_out: 'Run out', hit_wicket: 'Hit wicket' };
  const dismissals = Object.entries(howOut).map(([k, v]) => ({ label: pretty[k] || k, value: v })).sort((a, b) => b.value - a.value);

  const bowling = bowl.map(r => ({ label: `v ${opp(r)} ${shortDate(r.match_date)}`, wickets: r.wickets, runs: r.runs, overs: overs(r.legal_balls), economy: Number(rate(r.runs, r.legal_balls)), match_id: r.match_id }));
  const wk = await db.all(`SELECT wicket_type, COUNT(*) AS n FROM balls WHERE bowler_id = ? AND is_wicket = 1 GROUP BY wicket_type`, [pid]);
  const wicketTypes = wk.filter(w => BOWLER_WICKETS.includes(w.wicket_type)).map(w => ({ label: pretty[w.wicket_type], value: Number(w.n) })).sort((a, b) => b.value - a.value);

  return { innings, scoring, dismissals, bowling, wicket_types: wicketTypes, segment: await segmentOf(pid) };
}

// ------------------------------------------------------------ team charts
function phaseOf(overNo, total) {
  const pp = Math.max(1, Math.ceil(total * 0.3)), death = Math.max(1, Math.ceil(total * 0.25));
  return overNo < pp ? 'Powerplay' : overNo >= total - death ? 'Death overs' : 'Middle overs';
}

async function teamCharts(tid) {
  const ms = await db.all(`SELECT * FROM matches WHERE (team1_id = ? OR team2_id = ?) AND status IN ('completed','abandoned') ORDER BY match_date, id`, [tid, tid]);
  const teams = new Map((await db.all('SELECT id, short_name, name FROM teams')).map(t => [t.id, t]));
  const summary = { played: 0, won: 0, lost: 0, tied: 0, nr: 0 };
  const perMatch = [];
  for (const m of ms) {
    summary.played++;
    const result = m.status === 'abandoned' ? 'NR' : !m.winner_team_id ? 'T' : m.winner_team_id === tid ? 'W' : 'L';
    summary[{ W: 'won', L: 'lost', T: 'tied', NR: 'nr' }[result]]++;
    if (m.status === 'abandoned') continue;
    const mine = await db.get('SELECT runs, wickets, legal_balls FROM innings WHERE match_id = ? AND batting_team_id = ?', [m.id, tid]);
    const theirs = await db.get('SELECT runs, wickets, legal_balls FROM innings WHERE match_id = ? AND bowling_team_id = ?', [m.id, tid]);
    const o = teams.get(m.team1_id === tid ? m.team2_id : m.team1_id);
    perMatch.push({ label: `v ${o ? o.short_name : '?'} ${shortDate(m.match_date)}`, match_id: m.id, result,
      scored: mine ? mine.runs : 0, conceded: theirs ? theirs.runs : 0, score: mine ? `${mine.runs}/${mine.wickets}` : '-' });
  }
  summary.win_pct = summary.played - summary.nr ? r1(summary.won * 100 / (summary.played - summary.nr)) : 0;

  const topBat = await db.all(`SELECT p.id, p.first_name, p.last_name, SUM(bs.runs) AS runs, SUM(bs.balls) AS balls FROM batting_scores bs JOIN players p ON p.id = bs.player_id
      WHERE bs.team_id = ? GROUP BY p.id, p.first_name, p.last_name ORDER BY runs DESC LIMIT 8`, [tid]);
  const topBowl = await db.all(`SELECT p.id, p.first_name, p.last_name, SUM(bw.wickets) AS wickets, SUM(bw.runs) AS runs, SUM(bw.legal_balls) AS balls FROM bowling_scores bw JOIN players p ON p.id = bw.player_id
      WHERE bw.team_id = ? GROUP BY p.id, p.first_name, p.last_name HAVING SUM(bw.legal_balls) > 0 ORDER BY wickets DESC, runs ASC LIMIT 8`, [tid]);

  // run rate by phase, batting vs bowling
  const balls = await db.all(`SELECT b.over_no, b.total_runs, b.is_legal, i.batting_team_id, m.overs FROM balls b JOIN innings i ON i.id = b.innings_id JOIN matches m ON m.id = b.match_id
      WHERE i.batting_team_id = ? OR i.bowling_team_id = ?`, [tid, tid]);
  const ph = {};
  for (const name of ['Powerplay', 'Middle overs', 'Death overs']) ph[name] = { br: 0, bb: 0, cr: 0, cb: 0 };
  for (const b of balls) {
    const p = ph[phaseOf(b.over_no, b.overs)];
    if (b.batting_team_id === tid) { p.br += b.total_runs; p.bb += b.is_legal; } else { p.cr += b.total_runs; p.cb += b.is_legal; }
  }
  const phases = Object.entries(ph).map(([label, p]) => ({ label, batting: Number(rate(p.br, p.bb)), bowling: Number(rate(p.cr, p.cb)) }));

  return {
    summary, matches: perMatch, phases,
    top_batters: topBat.map(r => ({ id: r.id, label: fullName(r), value: Number(r.runs), sr: sr(Number(r.runs), Number(r.balls)) })),
    top_bowlers: topBowl.map(r => ({ id: r.id, label: fullName(r), value: Number(r.wickets), econ: rate(Number(r.runs), Number(r.balls)) })),
    suggested_xi: await suggestedXI(tid),
  };
}

// AI suggestion: a balanced XI from the squad using career stats + segments
async function suggestedXI(tid) {
  const squad = await db.all(`SELECT p.id, p.first_name, p.last_name, p.role, s.runs, s.balls_faced, s.bat_innings, s.not_outs, s.wickets, s.runs_conceded, s.balls_bowled, s.matches
      FROM players p LEFT JOIN player_stats s ON s.player_id = p.id WHERE p.team_id = ?`, [tid]);
  if (squad.length < 11) return [];
  const bat = p => (p.runs || 0) / Math.max(1, (p.bat_innings || 0) - (p.not_outs || 0)) * 0.6 + (p.balls_faced ? p.runs * 100 / p.balls_faced : 0) * 0.15;
  const bowlS = p => (p.wickets || 0) * 12 / Math.max(1, p.matches || 1) - (p.balls_bowled ? p.runs_conceded * 6 / p.balls_bowled : 12);
  const picked = new Map();
  const add = (p, why) => { if (!picked.has(p.id) && picked.size < 11) picked.set(p.id, { id: p.id, name: fullName(p), role: p.role, reason: why }); };
  const keeper = squad.filter(p => p.role === 'Wicket-keeper').sort((a, b) => bat(b) - bat(a))[0];
  if (keeper) add(keeper, 'Wicket-keeper');
  squad.filter(p => (p.balls_bowled || 0) > 0).sort((a, b) => bowlS(b) - bowlS(a)).slice(0, 5).forEach(p => add(p, `${p.wickets || 0} wkts, econ ${rate(p.runs_conceded || 0, p.balls_bowled || 0)}`));
  squad.sort((a, b) => bat(b) - bat(a)).forEach(p => add(p, `${p.runs || 0} runs, SR ${sr(p.runs || 0, p.balls_faced || 0)}`));
  return [...picked.values()];
}

// ------------------------------------------------------------ tournament charts
async function tournamentCharts(tid) {
  const teams = await db.all(`SELECT tm.id, tm.name, tm.short_name, tm.color FROM tournament_teams tt JOIN teams tm ON tm.id = tt.team_id WHERE tt.tournament_id = ? ORDER BY tm.name`, [tid]);
  const inns = await db.all(`SELECT i.* FROM innings i JOIN matches m ON m.id = i.match_id WHERE m.tournament_id = ? AND m.status IN ('completed','live')`, [tid]);
  const t = new Map(teams.map(x => [x.id, { ...x, runs: 0, balls: 0, conceded: 0, bowled: 0, fours: 0, sixes: 0, wkts: 0 }]));
  for (const i of inns) {
    const b = t.get(i.batting_team_id), w = t.get(i.bowling_team_id);
    if (b) { b.runs += i.runs; b.balls += i.legal_balls; }
    if (w) { w.conceded += i.runs; w.bowled += i.legal_balls; w.wkts += i.wickets; }
  }
  const bnd = await db.all(`SELECT bs.team_id, SUM(bs.fours) AS f, SUM(bs.sixes) AS s FROM batting_scores bs JOIN matches m ON m.id = bs.match_id WHERE m.tournament_id = ? GROUP BY bs.team_id`, [tid]);
  for (const r of bnd) { const x = t.get(r.team_id); if (x) { x.fours = Number(r.f); x.sixes = Number(r.s); } }
  const list = [...t.values()];

  const topBat = await db.all(`SELECT p.id, p.first_name, p.last_name, tm.short_name, SUM(bs.runs) AS runs, SUM(bs.balls) AS balls FROM batting_scores bs
      JOIN matches m ON m.id = bs.match_id JOIN players p ON p.id = bs.player_id LEFT JOIN teams tm ON tm.id = bs.team_id
      WHERE m.tournament_id = ? GROUP BY p.id, p.first_name, p.last_name, tm.short_name ORDER BY runs DESC LIMIT 10`, [tid]);
  const topBowl = await db.all(`SELECT p.id, p.first_name, p.last_name, tm.short_name, SUM(bw.wickets) AS wickets, SUM(bw.runs) AS runs, SUM(bw.legal_balls) AS balls FROM bowling_scores bw
      JOIN matches m ON m.id = bw.match_id JOIN players p ON p.id = bw.player_id LEFT JOIN teams tm ON tm.id = bw.team_id
      WHERE m.tournament_id = ? GROUP BY p.id, p.first_name, p.last_name, tm.short_name HAVING SUM(bw.legal_balls) > 0 ORDER BY wickets DESC, runs ASC LIMIT 10`, [tid]);
  const scores = await db.all(`SELECT bs.runs FROM batting_scores bs JOIN matches m ON m.id = bs.match_id WHERE m.tournament_id = ? AND (bs.balls > 0 OR bs.is_out = 1)`, [tid]);
  const bins = [['0-9', 0, 9], ['10-19', 10, 19], ['20-29', 20, 29], ['30-39', 30, 39], ['40-49', 40, 49], ['50+', 50, 9999]];
  const hist = bins.map(([label, lo, hi]) => ({ label, value: scores.filter(s => s.runs >= lo && s.runs <= hi).length }));
  const totals = inns.filter(i => i.status === 'completed').map(i => ({ team: (t.get(i.batting_team_id) || {}).short_name, runs: i.runs, wickets: i.wickets, overs: overs(i.legal_balls), match_id: i.match_id }))
    .sort((a, b) => b.runs - a.runs).slice(0, 5);

  return {
    team_runs: list.map(x => ({ id: x.id, label: x.name, value: x.runs })).sort((a, b) => b.value - a.value),
    run_rates: list.map(x => ({ label: x.short_name, batting: Number(rate(x.runs, x.balls)), bowling: Number(rate(x.conceded, x.bowled)) })),
    boundaries: list.map(x => ({ label: x.short_name, fours: x.fours, sixes: x.sixes })),
    top_batters: topBat.map(r => ({ id: r.id, label: `${fullName(r)} (${r.short_name || ''})`, value: Number(r.runs), sr: sr(Number(r.runs), Number(r.balls)) })),
    top_bowlers: topBowl.map(r => ({ id: r.id, label: `${fullName(r)} (${r.short_name || ''})`, value: Number(r.wickets), econ: rate(Number(r.runs), Number(r.balls)) })),
    score_distribution: hist,
    highest_totals: totals,
    summary: {
      matches: (await db.get(`SELECT COUNT(*) AS n FROM matches WHERE tournament_id = ? AND status = 'completed'`, [tid])).n,
      runs: list.reduce((a, x) => a + x.runs, 0), wickets: list.reduce((a, x) => a + x.wkts, 0),
      sixes: list.reduce((a, x) => a + x.sixes, 0), fours: list.reduce((a, x) => a + x.fours, 0),
      fifties: scores.filter(s => s.runs >= 50).length,
    },
  };
}

// ------------------------------------------------------------ match charts (Manhattan, worm, partnerships)
async function matchCharts(mid) {
  const m = await db.get('SELECT * FROM matches WHERE id = ?', [mid]);
  if (!m) return null;
  const inns = await db.all('SELECT * FROM innings WHERE match_id = ? ORDER BY innings_no', [mid]);
  const teams = new Map((await db.all('SELECT id, name, short_name FROM teams WHERE id IN (?, ?)', [m.team1_id, m.team2_id])).map(t => [t.id, t]));
  const names = new Map((await db.all('SELECT p.id, p.first_name, p.last_name FROM players p JOIN match_players mp ON mp.player_id = p.id WHERE mp.match_id = ?', [mid])).map(p => [p.id, fullName(p)]));
  const out = [];
  for (const i of inns) {
    const balls = await db.all('SELECT * FROM balls WHERE innings_id = ? ORDER BY seq', [i.id]);
    const perOver = [...Array(m.overs)].map((_, o) => ({ over: o + 1, runs: 0, wickets: 0, bowled: false }));
    const parts = [];
    let cur = null, a = null, b = null;
    for (const x of balls) {
      const o = perOver[x.over_no]; if (!o) continue;
      o.runs += x.total_runs; o.wickets += x.is_wicket; o.bowled = true;
      const pair = [x.batsman_id, x.non_striker_id].sort().join('-');
      if (!cur || cur.key !== pair) { cur = { key: pair, a: x.batsman_id, b: x.non_striker_id, runs: 0, balls: 0 }; parts.push(cur); }
      cur.runs += x.total_runs; if (x.extra_type !== 'wd') cur.balls++;
    }
    let cum = 0;
    const worm = perOver.filter(o => o.bowled).map(o => { cum += o.runs; return { over: o.over, runs: cum, wickets: o.wickets }; });
    out.push({
      innings_no: i.innings_no, team: teams.get(i.batting_team_id),
      per_over: perOver.filter(o => o.bowled), worm,
      partnerships: parts.map((p, n) => ({ wicket: n + 1, label: `${names.get(p.a) || '?'} & ${names.get(p.b) || '?'}`, runs: p.runs, balls: p.balls })),
    });
  }
  return { overs: m.overs, innings: out };
}

module.exports = { segmentation, segmentOf, playerCharts, teamCharts, tournamentCharts, matchCharts, kmeans, phaseOf };
