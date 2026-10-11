// =====================================================================
//  Scoring engine - all cricket rules live here.
//
//  The `balls` table is the single source of truth. After every ball (or
//  undo) the innings totals, batting card, bowling card and the career
//  stats of the players involved are recalculated and saved to the DB.
// =====================================================================
const db = require('./db');
const { bad, now } = require('./util');

const WICKET_TYPES = ['bowled', 'caught', 'caught_bowled', 'lbw', 'stumped', 'run_out', 'hit_wicket'];
const BOWLER_WICKETS = ['bowled', 'caught', 'caught_bowled', 'lbw', 'stumped', 'hit_wicket'];
const EXTRAS = ['wd', 'nb', 'b', 'lb'];

// ---------------------------------------------------------------- helpers
const getMatch = (q, id) => q.get('SELECT * FROM matches WHERE id = ?', [id]);
const getInnings = (q, matchId, no) => q.get('SELECT * FROM innings WHERE match_id = ? AND innings_no = ?', [matchId, no]);

async function liveInnings(q, matchId) {
  const m = await getMatch(q, matchId);
  if (!m) throw bad('Match not found');
  if (m.status !== 'live') throw bad(m.status === 'scheduled' ? 'Match has not started yet' : 'Match is already completed');
  const inn = await getInnings(q, matchId, m.current_innings);
  if (!inn || inn.status !== 'in_progress') throw bad('No innings in progress');
  return { m, inn };
}

async function xiOf(q, matchId, teamId) {
  const rows = await q.all('SELECT player_id FROM match_players WHERE match_id = ? AND team_id = ?', [matchId, teamId]);
  return rows.map(r => r.player_id);
}

async function nameOf(q, id) {
  if (!id) return '';
  const p = await q.get('SELECT first_name, last_name FROM players WHERE id = ?', [id]);
  return p ? `${p.first_name} ${p.last_name}` : 'Unknown';
}

async function touchMatch(q, id) { await q.run('UPDATE matches SET updated_at = ? WHERE id = ?', [now(), id]); }

// ---------------------------------------------------------------- start match
async function startMatch(q, matchId, { toss_winner_id, toss_decision, team1_xi, team2_xi }) {
  const m = await getMatch(q, matchId);
  if (!m) throw bad('Match not found');
  if (m.status !== 'scheduled') throw bad('Match already started');
  toss_winner_id = Number(toss_winner_id);
  if (![m.team1_id, m.team2_id].includes(toss_winner_id)) throw bad('Choose which team won the toss');
  if (!['bat', 'bowl'].includes(toss_decision)) throw bad('Choose bat or bowl');

  const xis = [[m.team1_id, team1_xi], [m.team2_id, team2_xi]];
  for (const [teamId, list] of xis) {
    const ids = [...new Set((list || []).map(Number))];
    if (ids.length < 2) throw bad('Each team needs at least 2 players in the playing XI');
    if (ids.length > 15) throw bad('A playing XI can have at most 15 players');
    const squad = (await q.all('SELECT id FROM players WHERE team_id = ?', [teamId])).map(r => r.id);
    for (const pid of ids) {
      if (!squad.includes(pid)) throw bad('Player ' + pid + ' is not in the team squad');
      await q.run('INSERT INTO match_players (match_id, team_id, player_id) VALUES (?, ?, ?)', [matchId, teamId, pid]);
    }
  }
  const other = toss_winner_id === m.team1_id ? m.team2_id : m.team1_id;
  const battingFirst = toss_decision === 'bat' ? toss_winner_id : other;
  const bowlingFirst = battingFirst === m.team1_id ? m.team2_id : m.team1_id;

  await q.run('INSERT INTO innings (match_id, innings_no, batting_team_id, bowling_team_id) VALUES (?, 1, ?, ?)',
    [matchId, battingFirst, bowlingFirst]);
  await q.run(`UPDATE matches SET toss_winner_id = ?, toss_decision = ?, status = 'live', current_innings = 1, updated_at = ? WHERE id = ?`,
    [toss_winner_id, toss_decision, now(), matchId]);

  const all = (await q.all('SELECT player_id FROM match_players WHERE match_id = ?', [matchId])).map(r => r.player_id);
  await refreshPlayerStats(q, all);
  return all;
}

// ---------------------------------------------------------------- crease
async function setBatsmen(q, matchId, { striker_id, non_striker_id }) {
  const { inn } = await liveInnings(q, matchId);
  const xi = await xiOf(q, matchId, inn.batting_team_id);
  const out = (await q.all('SELECT player_id FROM batting_scores WHERE innings_id = ? AND is_out = 1', [inn.id])).map(r => r.player_id);
  let s = inn.striker_id, ns = inn.non_striker_id;
  const wanted = [];
  if (!s && striker_id) { s = Number(striker_id); wanted.push(s); }
  if (!ns && non_striker_id) { ns = Number(non_striker_id); wanted.push(ns); }
  if (!wanted.length) throw bad('Select the batsman to come in');
  if (s && s === ns) throw bad('Striker and non-striker must be different players');
  for (const pid of wanted) {
    if (!xi.includes(pid)) throw bad('That player is not in the batting XI');
    if (out.includes(pid)) throw bad('That batsman is already out');
    if (pid === inn.striker_id || pid === inn.non_striker_id) throw bad('That batsman is already at the crease');
    const exists = await q.get('SELECT id FROM batting_scores WHERE innings_id = ? AND player_id = ?', [inn.id, pid]);
    if (!exists) {
      const c = await q.get('SELECT COUNT(*) AS n FROM batting_scores WHERE innings_id = ?', [inn.id]);
      await q.run('INSERT INTO batting_scores (innings_id, match_id, player_id, team_id, bat_order) VALUES (?, ?, ?, ?, ?)',
        [inn.id, matchId, pid, inn.batting_team_id, Number(c.n) + 1]);
    }
  }
  await q.run('UPDATE innings SET striker_id = ?, non_striker_id = ? WHERE id = ?', [s, ns, inn.id]);
  await touchMatch(q, matchId);
}

async function setBowler(q, matchId, { bowler_id }) {
  const { inn } = await liveInnings(q, matchId);
  const pid = Number(bowler_id);
  const xi = await xiOf(q, matchId, inn.bowling_team_id);
  if (!xi.includes(pid)) throw bad('That player is not in the bowling XI');
  if (pid === inn.last_over_bowler_id) throw bad('A bowler cannot bowl two overs in a row');
  const overNo = Math.floor(inn.legal_balls / 6);
  const inOver = await q.get('SELECT COUNT(*) AS n FROM balls WHERE innings_id = ? AND over_no = ?', [inn.id, overNo]);
  if (inn.bowler_id && Number(inOver.n) > 0) throw bad('Over in progress - bowler can only be changed at the start of an over');
  const exists = await q.get('SELECT id FROM bowling_scores WHERE innings_id = ? AND player_id = ?', [inn.id, pid]);
  if (!exists) {
    const c = await q.get('SELECT COUNT(*) AS n FROM bowling_scores WHERE innings_id = ?', [inn.id]);
    await q.run('INSERT INTO bowling_scores (innings_id, match_id, player_id, team_id, bowl_order) VALUES (?, ?, ?, ?, ?)',
      [inn.id, matchId, pid, inn.bowling_team_id, Number(c.n) + 1]);
  }
  await q.run('UPDATE innings SET bowler_id = ? WHERE id = ?', [pid, inn.id]);
  await touchMatch(q, matchId);
}

async function swapStrike(q, matchId) {
  const { inn } = await liveInnings(q, matchId);
  await q.run('UPDATE innings SET striker_id = ?, non_striker_id = ? WHERE id = ?', [inn.non_striker_id, inn.striker_id, inn.id]);
  await touchMatch(q, matchId);
}

// ---------------------------------------------------------------- record a ball
//  input: { runs, extra: null|'wd'|'nb'|'b'|'lb', wicket: { type, player_out_id, fielder_id } }
//  runs = runs off the bat (normal / no-ball) or runs taken (wide / bye / leg-bye)
async function recordBall(q, matchId, input) {
  const { m, inn } = await liveInnings(q, matchId);
  if (!inn.striker_id || !inn.non_striker_id) throw bad('Select both batsmen first');
  if (!inn.bowler_id) throw bad('Select the bowler for this over first');

  const runs = Number(input.runs || 0);
  if (!Number.isInteger(runs) || runs < 0 || runs > 7) throw bad('Runs must be between 0 and 7');
  const extra = input.extra || null;
  if (extra && !EXTRAS.includes(extra)) throw bad('Unknown extra type');
  if ((extra === 'b' || extra === 'lb') && runs === 0 && !(input.wicket && input.wicket.type)) throw bad('Byes / leg-byes need at least 1 run');

  let runs_bat = 0, extra_runs = 0;
  if (!extra) runs_bat = runs;
  else if (extra === 'wd') extra_runs = 1 + runs;
  else if (extra === 'nb') { extra_runs = 1; runs_bat = runs; }
  else extra_runs = runs;
  const is_legal = extra === 'wd' || extra === 'nb' ? 0 : 1;

  // ---- wicket validation
  let w = null;
  if (input.wicket && input.wicket.type) {
    const type = input.wicket.type;
    if (!WICKET_TYPES.includes(type)) throw bad('Unknown wicket type');
    if (extra === 'nb' && type !== 'run_out') throw bad('On a no-ball the batsman can only be run out');
    if (extra === 'wd' && !['stumped', 'run_out', 'hit_wicket'].includes(type)) throw bad('On a wide only stumped, run out or hit wicket is possible');
    const outId = Number(input.wicket.player_out_id || inn.striker_id);
    if (![inn.striker_id, inn.non_striker_id].includes(outId)) throw bad('The dismissed player must be one of the batsmen at the crease');
    if (outId !== inn.striker_id && type !== 'run_out') throw bad('Only the striker can be out ' + type.replace('_', ' '));
    let fielder = input.wicket.fielder_id ? Number(input.wicket.fielder_id) : null;
    if (type === 'caught_bowled') fielder = inn.bowler_id;
    if ((type === 'caught' || type === 'stumped') && !fielder) throw bad('Select the fielder / wicket-keeper');
    if (fielder) {
      const bxi = await xiOf(q, matchId, inn.bowling_team_id);
      if (!bxi.includes(fielder)) throw bad('Fielder must be from the bowling team');
    }
    if (!BOWLER_WICKETS.includes(type) && type !== 'run_out') fielder = null;
    if (['bowled', 'lbw', 'hit_wicket'].includes(type)) fielder = null;
    w = { type, outId, fielder };
  }

  const over_no = Math.floor(inn.legal_balls / 6);
  const ball_in_over = (inn.legal_balls % 6) + 1;
  const last = await q.get('SELECT MAX(seq) AS s FROM balls WHERE match_id = ?', [matchId]);
  const seq = Number(last && last.s ? last.s : 0) + 1;
  const total = runs_bat + extra_runs;

  const commentary = await buildCommentary(q, {
    bowler: inn.bowler_id, batsman: inn.striker_id, runs, runs_bat, extra, extra_runs, w,
  });

  await q.run(`INSERT INTO balls (match_id, innings_id, seq, over_no, ball_in_over, batsman_id, non_striker_id, bowler_id,
      runs_bat, extra_type, extra_runs, total_runs, is_legal, is_wicket, wicket_type, player_out_id, fielder_id, commentary,
      prev_striker_id, prev_non_striker_id, prev_bowler_id, prev_last_over_bowler_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [matchId, inn.id, seq, over_no, ball_in_over, inn.striker_id, inn.non_striker_id, inn.bowler_id,
      runs_bat, extra, extra_runs, total, is_legal, w ? 1 : 0, w ? w.type : null, w ? w.outId : null, w ? w.fielder : null, commentary,
      inn.striker_id, inn.non_striker_id, inn.bowler_id, inn.last_over_bowler_id, now()]);

  // ---- who is on strike now?
  let s = inn.striker_id, ns = inn.non_striker_id;
  if (runs % 2 === 1) [s, ns] = [ns, s];          // odd runs -> batsmen crossed
  if (w) { if (w.outId === s) s = null; else ns = null; } // empty slot = new batsman needed
  let bowler = inn.bowler_id, lastOver = inn.last_over_bowler_id;
  const legalAfter = inn.legal_balls + is_legal;
  if (is_legal && legalAfter % 6 === 0) {          // over complete
    [s, ns] = [ns, s];
    lastOver = bowler;
    bowler = null;
  }
  await q.run('UPDATE innings SET striker_id = ?, non_striker_id = ?, bowler_id = ?, last_over_bowler_id = ? WHERE id = ?',
    [s, ns, bowler, lastOver, inn.id]);

  await recomputeInnings(q, inn.id);
  await checkInningsEnd(q, m, inn.id);
  await touchMatch(q, matchId);

  const affected = [inn.striker_id, inn.non_striker_id, inn.bowler_id, w && w.fielder].filter(Boolean);
  await refreshPlayerStats(q, affected);
  return affected;
}

async function buildCommentary(q, { bowler, batsman, runs, runs_bat, extra, extra_runs, w }) {
  const bw = await nameOf(q, bowler), bt = await nameOf(q, batsman);
  let txt = `${bw} to ${bt}, `;
  if (extra === 'wd') txt += extra_runs > 1 ? `wide, ${extra_runs - 1} run(s) taken` : 'wide';
  else if (extra === 'nb') txt += runs_bat ? `no-ball, ${runs_bat} run(s) off the bat` : 'no-ball';
  else if (extra === 'b') txt += `${runs} bye(s)`;
  else if (extra === 'lb') txt += `${runs} leg-bye(s)`;
  else if (runs_bat === 0) txt += 'no run';
  else if (runs_bat === 4) txt += 'FOUR! Cracking shot to the boundary';
  else if (runs_bat === 6) txt += 'SIX! That is out of the park';
  else txt += `${runs_bat} run${runs_bat > 1 ? 's' : ''}`;
  if (w) {
    const out = await nameOf(q, w.outId), f = await nameOf(q, w.fielder);
    const how = {
      bowled: 'BOWLED!', caught: `caught by ${f}!`, caught_bowled: 'caught & bowled!', lbw: 'LBW!',
      stumped: `stumped by ${f}!`, run_out: `run out${f ? ' by ' + f : ''}!`, hit_wicket: 'hit wicket!',
    }[w.type];
    txt += ` - OUT! ${out} ${how}`;
  }
  return txt.slice(0, 255);
}

// ---------------------------------------------------------------- recalculation
async function recomputeInnings(q, inningsId) {
  const balls = await q.all('SELECT * FROM balls WHERE innings_id = ? ORDER BY seq', [inningsId]);
  const t = { runs: 0, wickets: 0, legal: 0, extras: 0, wd: 0, nb: 0, b: 0, lb: 0 };
  const bat = new Map(), bowl = new Map();
  const B = id => { if (!bat.has(id)) bat.set(id, { runs: 0, balls: 0, fours: 0, sixes: 0, is_out: 0, wicket_type: null, bowler_id: null, fielder_id: null }); return bat.get(id); };
  const W = id => { if (!bowl.has(id)) bowl.set(id, { legal_balls: 0, runs: 0, wickets: 0, maidens: 0, wides: 0, noballs: 0, dots: 0 }); return bowl.get(id); };
  const overRuns = new Map(); // "over|bowler" -> {legal, conceded}

  for (const b of balls) {
    t.runs += b.total_runs; t.extras += b.extra_runs; t.legal += b.is_legal;
    if (b.extra_type) t[b.extra_type] += b.extra_runs;
    const bt = B(b.batsman_id);
    if (b.extra_type !== 'wd') bt.balls += 1;
    bt.runs += b.runs_bat;
    if (b.runs_bat === 4) bt.fours++;
    if (b.runs_bat === 6) bt.sixes++;
    const bw = W(b.bowler_id);
    const conceded = b.runs_bat + (b.extra_type === 'wd' || b.extra_type === 'nb' ? b.extra_runs : 0);
    bw.runs += conceded; bw.legal_balls += b.is_legal;
    if (b.extra_type === 'wd') bw.wides += b.extra_runs;
    if (b.extra_type === 'nb') bw.noballs += 1;
    if (b.is_legal && conceded === 0) bw.dots++;
    const k = b.over_no + '|' + b.bowler_id;
    const o = overRuns.get(k) || { legal: 0, conceded: 0 };
    o.legal += b.is_legal; o.conceded += conceded; overRuns.set(k, o);
    if (b.is_wicket) {
      t.wickets++;
      const out = B(b.player_out_id);
      out.is_out = 1; out.wicket_type = b.wicket_type;
      out.bowler_id = b.wicket_type === 'run_out' ? null : b.bowler_id;
      out.fielder_id = b.fielder_id;
      if (BOWLER_WICKETS.includes(b.wicket_type)) bw.wickets++;
    }
  }
  for (const [k, o] of overRuns) if (o.legal === 6 && o.conceded === 0) W(Number(k.split('|')[1])).maidens++;

  const inn = await q.get('SELECT * FROM innings WHERE id = ?', [inningsId]);
  await q.run(`UPDATE innings SET runs = ?, wickets = ?, legal_balls = ?, extras = ?, wides = ?, noballs = ?, byes = ?, legbyes = ? WHERE id = ?`,
    [t.runs, t.wickets, t.legal, t.extras, t.wd, t.nb, t.b, t.lb, inningsId]);

  // batting card: keep entry order, drop batsmen who never faced and are not at the crease (after an undo)
  const batRows = await q.all('SELECT * FROM batting_scores WHERE innings_id = ?', [inningsId]);
  const appeared = new Set(balls.flatMap(b => [b.batsman_id, b.non_striker_id]));
  for (const r of batRows) {
    const s = bat.get(r.player_id);
    const atCrease = r.player_id === inn.striker_id || r.player_id === inn.non_striker_id;
    if (!s && !atCrease && !appeared.has(r.player_id)) { await q.run('DELETE FROM batting_scores WHERE id = ?', [r.id]); continue; }
    const v = s || B(r.player_id);
    await q.run(`UPDATE batting_scores SET runs = ?, balls = ?, fours = ?, sixes = ?, is_out = ?, wicket_type = ?, bowler_id = ?, fielder_id = ? WHERE id = ?`,
      [v.runs, v.balls, v.fours, v.sixes, v.is_out, v.wicket_type, v.bowler_id, v.fielder_id, r.id]);
  }
  const bowlRows = await q.all('SELECT * FROM bowling_scores WHERE innings_id = ?', [inningsId]);
  for (const r of bowlRows) {
    const v = bowl.get(r.player_id);
    if (!v && r.player_id !== inn.bowler_id) { await q.run('DELETE FROM bowling_scores WHERE id = ?', [r.id]); continue; }
    const s = v || W(r.player_id);
    await q.run(`UPDATE bowling_scores SET legal_balls = ?, runs = ?, wickets = ?, maidens = ?, wides = ?, noballs = ?, dots = ? WHERE id = ?`,
      [s.legal_balls, s.runs, s.wickets, s.maidens, s.wides, s.noballs, s.dots, r.id]);
  }
}

async function checkInningsEnd(q, m, inningsId) {
  const inn = await q.get('SELECT * FROM innings WHERE id = ?', [inningsId]);
  const xi = await xiOf(q, m.id, inn.batting_team_id);
  const allOut = inn.wickets >= Math.max(1, xi.length - 1);
  const oversDone = inn.legal_balls >= m.overs * 6;
  const chased = inn.innings_no === 2 && inn.runs >= inn.target;
  if (allOut || oversDone || chased) await completeInnings(q, m, inn);
}

async function completeInnings(q, m, inn) {
  await q.run(`UPDATE innings SET status = 'completed', striker_id = NULL, non_striker_id = NULL, bowler_id = NULL WHERE id = ?`, [inn.id]);
  if (inn.innings_no === 1) {
    const fresh = await q.get('SELECT runs FROM innings WHERE id = ?', [inn.id]);
    await q.run('INSERT INTO innings (match_id, innings_no, batting_team_id, bowling_team_id, target) VALUES (?, 2, ?, ?, ?)',
      [m.id, inn.bowling_team_id, inn.batting_team_id, fresh.runs + 1]);
    await q.run('UPDATE matches SET current_innings = 2, updated_at = ? WHERE id = ?', [now(), m.id]);
    return;
  }
  // ---- match result
  const i2 = await q.get('SELECT * FROM innings WHERE id = ?', [inn.id]);
  const xi = await xiOf(q, m.id, i2.batting_team_id);
  const teamName = async id => (await q.get('SELECT name FROM teams WHERE id = ?', [id])).name;
  let winner = null, text;
  if (i2.runs >= i2.target) {
    winner = i2.batting_team_id;
    const left = Math.max(1, xi.length - 1) - i2.wickets;
    const ballsLeft = m.overs * 6 - i2.legal_balls;
    text = `${await teamName(winner)} won by ${left} wicket${left === 1 ? '' : 's'}` + (ballsLeft > 0 ? ` (${ballsLeft} ball${ballsLeft === 1 ? '' : 's'} left)` : '');
  } else if (i2.runs === i2.target - 1) {
    text = 'Match tied';
  } else {
    winner = i2.bowling_team_id;
    const by = i2.target - 1 - i2.runs;
    text = `${await teamName(winner)} won by ${by} run${by === 1 ? '' : 's'}`;
  }
  await q.run(`UPDATE matches SET status = 'completed', winner_team_id = ?, result_text = ?, updated_at = ? WHERE id = ?`,
    [winner, text, now(), m.id]);
}

async function endInnings(q, matchId) {
  const { m, inn } = await liveInnings(q, matchId);
  await completeInnings(q, m, inn);
}

// ---------------------------------------------------------------- undo
async function undoLastBall(q, matchId) {
  const m = await getMatch(q, matchId);
  if (!m || m.status === 'scheduled') throw bad('Nothing to undo');
  const b = await q.get('SELECT * FROM balls WHERE match_id = ? ORDER BY seq DESC LIMIT 1', [matchId]);
  if (!b) throw bad('No balls bowled yet');
  const inn = await q.get('SELECT * FROM innings WHERE id = ?', [b.innings_id]);
  if (inn.innings_no < m.current_innings) {
    // the last ball ended innings 1 -> remove the (empty) innings 2
    await q.run('DELETE FROM innings WHERE match_id = ? AND innings_no > ?', [matchId, inn.innings_no]);
  }
  await q.run('DELETE FROM balls WHERE id = ?', [b.id]);
  await q.run(`UPDATE innings SET status = 'in_progress', striker_id = ?, non_striker_id = ?, bowler_id = ?, last_over_bowler_id = ? WHERE id = ?`,
    [b.prev_striker_id, b.prev_non_striker_id, b.prev_bowler_id, b.prev_last_over_bowler_id, inn.id]);
  await q.run(`UPDATE matches SET status = 'live', current_innings = ?, winner_team_id = NULL, result_text = NULL, updated_at = ? WHERE id = ?`,
    [inn.innings_no, now(), matchId]);
  await recomputeInnings(q, inn.id);
  const affected = [b.batsman_id, b.non_striker_id, b.bowler_id, b.player_out_id, b.fielder_id].filter(Boolean);
  await refreshPlayerStats(q, affected);
  return affected;
}

// ---------------------------------------------------------------- career stats
async function refreshPlayerStats(q, playerIds) {
  for (const pid of [...new Set(playerIds.map(Number))]) {
    const mRow = await q.get(`SELECT COUNT(*) AS n FROM match_players mp JOIN matches m ON m.id = mp.match_id
                              WHERE mp.player_id = ? AND m.status <> 'scheduled'`, [pid]);
    const bats = await q.all('SELECT runs, balls, fours, sixes, is_out FROM batting_scores WHERE player_id = ?', [pid]);
    const bowls = await q.all('SELECT legal_balls, runs, wickets, maidens FROM bowling_scores WHERE player_id = ? AND legal_balls > 0', [pid]);
    const field = await q.all(`SELECT wicket_type, fielder_id, bowler_id FROM balls
                               WHERE is_wicket = 1 AND (fielder_id = ? OR (wicket_type = 'caught_bowled' AND bowler_id = ?))`, [pid, pid]);
    const s = {
      matches: Number(mRow.n), bat_innings: bats.length, not_outs: 0, runs: 0, balls_faced: 0, fours: 0, sixes: 0,
      highest: 0, highest_not_out: 0, fifties: 0, hundreds: 0, ducks: 0,
      bowl_innings: bowls.length, balls_bowled: 0, runs_conceded: 0, wickets: 0, maidens: 0, best_wickets: 0, best_runs: 0,
      catches: 0, stumpings: 0, run_outs: 0,
    };
    for (const r of bats) {
      s.runs += r.runs; s.balls_faced += r.balls; s.fours += r.fours; s.sixes += r.sixes;
      if (!r.is_out) s.not_outs++;
      if (r.runs > s.highest || (r.runs === s.highest && !r.is_out)) { s.highest = r.runs; s.highest_not_out = r.is_out ? 0 : 1; }
      if (r.runs >= 100) s.hundreds++; else if (r.runs >= 50) s.fifties++;
      if (r.runs === 0 && r.is_out) s.ducks++;
    }
    let hasBest = false;
    for (const r of bowls) {
      s.balls_bowled += r.legal_balls; s.runs_conceded += r.runs; s.wickets += r.wickets; s.maidens += r.maidens;
      if (!hasBest || r.wickets > s.best_wickets || (r.wickets === s.best_wickets && r.runs < s.best_runs)) {
        s.best_wickets = r.wickets; s.best_runs = r.runs; hasBest = true;
      }
    }
    for (const f of field) {
      if (f.wicket_type === 'caught' || f.wicket_type === 'caught_bowled') s.catches++;
      else if (f.wicket_type === 'stumped') s.stumpings++;
      else if (f.wicket_type === 'run_out') s.run_outs++;
    }
    const cols = Object.keys(s);
    await q.run('DELETE FROM player_stats WHERE player_id = ?', [pid]);
    await q.run(`INSERT INTO player_stats (player_id, ${cols.join(', ')}, updated_at) VALUES (?, ${cols.map(() => '?').join(', ')}, ?)`,
      [pid, ...cols.map(c => s[c]), now()]);
  }
}

// wrap every action in a transaction
const inTx = fn => (matchId, data) => db.tx(q => fn(q, matchId, data || {}));

module.exports = {
  WICKET_TYPES,
  startMatch: inTx(startMatch),
  setBatsmen: inTx(setBatsmen),
  setBowler: inTx(setBowler),
  swapStrike: inTx(swapStrike),
  recordBall: inTx(recordBall),
  undoLastBall: inTx(undoLastBall),
  endInnings: inTx(endInnings),
  refreshPlayerStats: ids => db.tx(q => refreshPlayerStats(q, ids)),
};
