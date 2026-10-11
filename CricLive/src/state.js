// =====================================================================
//  Read models - builds the JSON the website shows (scoreboard,
//  scorecard, commentary, player profiles, points table ...)
// =====================================================================
const db = require('./db');
const { overs, rate, sr } = require('./util');

const fullName = p => (p ? `${p.first_name} ${p.last_name}` : '');

async function playerMap(ids) {
  const list = [...new Set(ids.filter(Boolean).map(Number))];
  const map = new Map();
  if (!list.length) return map;
  const rows = await db.all(`SELECT id, first_name, last_name, role, team_id FROM players WHERE id IN (${list.map(() => '?').join(',')})`, list);
  for (const r of rows) map.set(r.id, { id: r.id, name: fullName(r), role: r.role, team_id: r.team_id });
  return map;
}

function dismissalText(r, names) {
  const n = id => (names.get(id) || {}).name || '?';
  if (!r.is_out) return 'not out';
  switch (r.wicket_type) {
    case 'bowled': return `b ${n(r.bowler_id)}`;
    case 'caught': return `c ${n(r.fielder_id)} b ${n(r.bowler_id)}`;
    case 'caught_bowled': return `c & b ${n(r.bowler_id)}`;
    case 'lbw': return `lbw b ${n(r.bowler_id)}`;
    case 'stumped': return `st ${n(r.fielder_id)} b ${n(r.bowler_id)}`;
    case 'run_out': return r.fielder_id ? `run out (${n(r.fielder_id)})` : 'run out';
    case 'hit_wicket': return `hit wicket b ${n(r.bowler_id)}`;
    default: return 'out';
  }
}

const ballLabel = b => {
  if (b.is_wicket) return 'W' + (b.total_runs ? '+' + b.total_runs : '');
  if (b.extra_type === 'wd') return b.extra_runs > 1 ? `${b.extra_runs - 1}wd` : 'wd';
  if (b.extra_type === 'nb') return b.runs_bat ? `${b.runs_bat}nb` : 'nb';
  if (b.extra_type === 'b') return `${b.extra_runs}b`;
  if (b.extra_type === 'lb') return `${b.extra_runs}lb`;
  return String(b.runs_bat);
};
const ballKind = b => (b.is_wicket ? 'wicket' : b.runs_bat === 6 ? 'six' : b.runs_bat === 4 ? 'four' : b.extra_type ? 'extra' : b.total_runs === 0 ? 'dot' : 'run');

async function teamsById(ids) {
  const list = [...new Set(ids.filter(Boolean))];
  const map = new Map();
  if (!list.length) return map;
  const rows = await db.all(`SELECT id, name, short_name, color FROM teams WHERE id IN (${list.map(() => '?').join(',')})`, list);
  for (const r of rows) map.set(r.id, r);
  return map;
}

// ------------------------------------------------------------ list cards
async function matchSummaries({ status, tournamentId, teamId, limit = 50 } = {}) {
  const where = [], params = [];
  if (status) { where.push('m.status = ?'); params.push(status); }
  if (tournamentId) { where.push('m.tournament_id = ?'); params.push(tournamentId); }
  if (teamId) { where.push('(m.team1_id = ? OR m.team2_id = ?)'); params.push(teamId, teamId); }
  const order = status === 'scheduled' ? 'm.match_date ASC, m.id ASC' : 'm.updated_at DESC, m.id DESC';
  const rows = await db.all(`SELECT m.*, t.name AS tournament_name FROM matches m LEFT JOIN tournaments t ON t.id = m.tournament_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ${Number(limit)}`, params);
  return Promise.all(rows.map(summarise));
}

async function summarise(m) {
  const teams = await teamsById([m.team1_id, m.team2_id]);
  const inns = await db.all('SELECT * FROM innings WHERE match_id = ? ORDER BY innings_no', [m.id]);
  const score = {};
  for (const i of inns) {
    if (i.innings_no === 2 && i.legal_balls === 0 && i.runs === 0 && m.status === 'live' && i.status === 'in_progress') {
      score[i.batting_team_id] = { yetToBat: true };
      continue;
    }
    score[i.batting_team_id] = { runs: i.runs, wickets: i.wickets, overs: overs(i.legal_balls), batting: i.status === 'in_progress' };
  }
  return {
    id: m.id, status: m.status, overs: m.overs, venue: m.venue, match_date: m.match_date,
    tournament_id: m.tournament_id, tournament_name: m.tournament_name || null,
    team1: { ...teams.get(m.team1_id), score: score[m.team1_id] || null },
    team2: { ...teams.get(m.team2_id), score: score[m.team2_id] || null },
    status_text: statusText(m, inns, teams),
  };
}

function statusText(m, inns, teams) {
  const tn = id => (teams.get(id) || {}).name || '';
  if (m.status === 'completed') return m.result_text || 'Match completed';
  if (m.status === 'abandoned') return m.result_text || 'Match abandoned - no result';
  if (m.status === 'scheduled') return 'Match yet to begin';
  const cur = inns.find(i => i.innings_no === m.current_innings);
  const toss = m.toss_winner_id ? `${tn(m.toss_winner_id)} won the toss and chose to ${m.toss_decision}` : '';
  if (!cur) return toss;
  if (cur.innings_no === 1) return cur.legal_balls === 0 ? toss : `${tn(cur.batting_team_id)} batting - CRR ${rate(cur.runs, cur.legal_balls)}`;
  if (cur.legal_balls === 0 && cur.runs === 0) return `Innings break - ${tn(cur.batting_team_id)} need ${cur.target} to win`;
  const need = cur.target - cur.runs, left = m.overs * 6 - cur.legal_balls;
  return `${tn(cur.batting_team_id)} need ${need} run${need === 1 ? '' : 's'} in ${left} ball${left === 1 ? '' : 's'}`;
}

// ------------------------------------------------------------ full match state
async function matchState(matchId) {
  const m = await db.get(`SELECT m.*, t.name AS tournament_name FROM matches m LEFT JOIN tournaments t ON t.id = m.tournament_id WHERE m.id = ?`, [matchId]);
  if (!m) return null;
  const teams = await teamsById([m.team1_id, m.team2_id]);
  const inns = await db.all('SELECT * FROM innings WHERE match_id = ? ORDER BY innings_no', [matchId]);
  const xiRows = await db.all('SELECT team_id, player_id FROM match_players WHERE match_id = ?', [matchId]);
  const squads = await db.all('SELECT id, first_name, last_name, role, team_id FROM players WHERE team_id IN (?, ?) ORDER BY id', [m.team1_id, m.team2_id]);
  const balls = await db.all('SELECT * FROM balls WHERE match_id = ? ORDER BY seq', [matchId]);
  const names = await playerMap([...xiRows.map(r => r.player_id), ...squads.map(s => s.id)]);
  const n = id => (names.get(id) || { name: '' }).name;

  const xi = { [m.team1_id]: [], [m.team2_id]: [] };
  for (const r of xiRows) (xi[r.team_id] = xi[r.team_id] || []).push({ id: r.player_id, name: n(r.player_id), role: (names.get(r.player_id) || {}).role });

  const innings = [];
  for (const i of inns) {
    const bat = await db.all('SELECT * FROM batting_scores WHERE innings_id = ? ORDER BY bat_order', [i.id]);
    const bowl = await db.all('SELECT * FROM bowling_scores WHERE innings_id = ? ORDER BY bowl_order', [i.id]);
    const ib = balls.filter(b => b.innings_id === i.id);
    const inProgress = i.status === 'in_progress';
    const batting = bat.map(r => ({
      id: r.player_id, name: n(r.player_id), runs: r.runs, balls: r.balls, fours: r.fours, sixes: r.sixes,
      sr: sr(r.runs, r.balls), is_out: !!r.is_out,
      dismissal: r.is_out ? dismissalText(r, names) : (inProgress && (r.player_id === i.striker_id || r.player_id === i.non_striker_id) ? 'batting' : 'not out'),
      on_strike: inProgress && r.player_id === i.striker_id,
    }));
    const batted = new Set(bat.map(r => r.player_id));
    const yetToBat = (xi[i.batting_team_id] || []).filter(p => !batted.has(p.id));
    const bowling = bowl.filter(r => r.legal_balls > 0 || r.runs > 0 || r.player_id === i.bowler_id).map(r => ({
      id: r.player_id, name: n(r.player_id), overs: overs(r.legal_balls), maidens: r.maidens, runs: r.runs, wickets: r.wickets,
      econ: rate(r.runs, r.legal_balls), wides: r.wides, noballs: r.noballs, dots: r.dots, bowling: inProgress && r.player_id === i.bowler_id,
    }));
    // fall of wickets + partnership
    let run = 0, legal = 0, partRuns = 0, partBalls = 0;
    const fow = [];
    for (const b of ib) {
      run += b.total_runs; legal += b.is_legal; partRuns += b.total_runs; if (b.extra_type !== 'wd') partBalls++;
      if (b.is_wicket) { fow.push({ wicket: fow.length + 1, runs: run, over: overs(legal), player: n(b.player_out_id) }); partRuns = 0; partBalls = 0; }
    }
    // current / last over balls
    let overBalls = [];
    if (ib.length) {
      const lastOver = ib[ib.length - 1].over_no;
      const showOver = inProgress && i.legal_balls % 6 === 0 && i.legal_balls > 0 && !i.bowler_id ? lastOver : (inProgress ? Math.floor(i.legal_balls / 6) : lastOver);
      overBalls = ib.filter(b => b.over_no === showOver).map(b => ({ label: ballLabel(b), kind: ballKind(b) }));
    }
    const ballsLeft = m.overs * 6 - i.legal_balls;
    innings.push({
      id: i.id, innings_no: i.innings_no, status: i.status,
      batting_team: teams.get(i.batting_team_id), bowling_team: teams.get(i.bowling_team_id),
      runs: i.runs, wickets: i.wickets, overs: overs(i.legal_balls), legal_balls: i.legal_balls,
      extras: { total: i.extras, wides: i.wides, noballs: i.noballs, byes: i.byes, legbyes: i.legbyes },
      target: i.target, crr: rate(i.runs, i.legal_balls),
      rrr: i.target && ballsLeft > 0 ? rate(Math.max(0, i.target - i.runs), ballsLeft) : null,
      need: i.target ? Math.max(0, i.target - i.runs) : null, balls_left: ballsLeft,
      batting, bowling, yet_to_bat: yetToBat, fall_of_wickets: fow,
      partnership: inProgress ? { runs: partRuns, balls: partBalls } : null,
      this_over: overBalls,
      striker_id: i.striker_id, non_striker_id: i.non_striker_id, bowler_id: i.bowler_id, last_over_bowler_id: i.last_over_bowler_id,
    });
  }

  const cur = innings.find(i => i.innings_no === m.current_innings && i.status === 'in_progress') || null;
  const commentary = balls.slice(-40).reverse().map(b => {
    const inn = inns.find(i => i.id === b.innings_id);
    return { seq: b.seq, innings_no: inn ? inn.innings_no : 0, over: `${b.over_no}.${b.ball_in_over}`, label: ballLabel(b), kind: ballKind(b), text: b.commentary };
  });

  // what the scorer has to do next
  let needs = null;
  if (m.status === 'scheduled') needs = 'start';
  else if (cur) {
    if (!cur.striker_id || !cur.non_striker_id) needs = 'batsmen';
    else if (!cur.bowler_id) needs = 'bowler';
    else needs = 'ball';
  }

  return {
    id: m.id, status: m.status, overs: m.overs, venue: m.venue, match_date: m.match_date,
    tournament_id: m.tournament_id, tournament_name: m.tournament_name,
    team1: teams.get(m.team1_id), team2: teams.get(m.team2_id),
    toss_winner_id: m.toss_winner_id, toss_decision: m.toss_decision,
    winner_team_id: m.winner_team_id, result_text: m.result_text,
    status_text: statusText(m, inns, teams),
    current_innings: m.current_innings, innings, current: cur ? cur.innings_no : null,
    commentary, needs, xi,
    squads: {
      [m.team1_id]: squads.filter(s => s.team_id === m.team1_id).map(s => ({ id: s.id, name: fullName(s), role: s.role })),
      [m.team2_id]: squads.filter(s => s.team_id === m.team2_id).map(s => ({ id: s.id, name: fullName(s), role: s.role })),
    },
    updated_at: m.updated_at,
  };
}

// ------------------------------------------------------------ player profile
async function playerProfile(id) {
  const p = await db.get(`SELECT p.*, t.name AS team_name, t.short_name AS team_short, t.color AS team_color
                          FROM players p LEFT JOIN teams t ON t.id = p.team_id WHERE p.id = ?`, [id]);
  if (!p) return null;
  const s = await db.get('SELECT * FROM player_stats WHERE player_id = ?', [id]) || {};
  const recentBat = await db.all(`SELECT bs.*, m.id AS match_id, m.match_date, m.team1_id, m.team2_id
       FROM batting_scores bs JOIN matches m ON m.id = bs.match_id WHERE bs.player_id = ? ORDER BY m.match_date DESC, bs.id DESC LIMIT 10`, [id]);
  const recentBowl = await db.all(`SELECT bw.*, m.id AS match_id, m.match_date, m.team1_id, m.team2_id
       FROM bowling_scores bw JOIN matches m ON m.id = bw.match_id WHERE bw.player_id = ? AND bw.legal_balls > 0 ORDER BY m.match_date DESC, bw.id DESC LIMIT 10`, [id]);
  const teams = await teamsById([...recentBat, ...recentBowl].flatMap(r => [r.team1_id, r.team2_id]));
  const vs = r => { const opp = r.team1_id === r.team_id ? r.team2_id : r.team1_id; return (teams.get(opp) || {}).name || ''; };
  const names = await playerMap(recentBat.flatMap(r => [r.bowler_id, r.fielder_id]));
  const outs = (s.bat_innings || 0) - (s.not_outs || 0);
  return {
    id: p.id, name: fullName(p), first_name: p.first_name, last_name: p.last_name, role: p.role,
    batting_style: p.batting_style, bowling_style: p.bowling_style, city: p.city, state: p.state, dob: p.dob, jersey_no: p.jersey_no,
    team: p.team_id ? { id: p.team_id, name: p.team_name, short_name: p.team_short, color: p.team_color } : null,
    batting: {
      matches: s.matches || 0, innings: s.bat_innings || 0, not_outs: s.not_outs || 0, runs: s.runs || 0, balls: s.balls_faced || 0,
      highest: (s.highest || 0) + (s.highest_not_out ? '*' : ''), average: outs ? (s.runs / outs).toFixed(2) : (s.runs ? '-' : '0.00'),
      strike_rate: sr(s.runs || 0, s.balls_faced || 0), fours: s.fours || 0, sixes: s.sixes || 0,
      fifties: s.fifties || 0, hundreds: s.hundreds || 0, ducks: s.ducks || 0,
    },
    bowling: {
      matches: s.matches || 0, innings: s.bowl_innings || 0, overs: overs(s.balls_bowled || 0), runs: s.runs_conceded || 0,
      wickets: s.wickets || 0, maidens: s.maidens || 0,
      best: s.bowl_innings ? `${s.best_wickets}/${s.best_runs}` : '-',
      average: s.wickets ? (s.runs_conceded / s.wickets).toFixed(2) : '-',
      economy: rate(s.runs_conceded || 0, s.balls_bowled || 0),
    },
    fielding: { catches: s.catches || 0, stumpings: s.stumpings || 0, run_outs: s.run_outs || 0 },
    recent_batting: recentBat.map(r => ({ match_id: r.match_id, date: r.match_date, vs: vs(r), runs: r.runs, balls: r.balls, fours: r.fours, sixes: r.sixes, not_out: !r.is_out, dismissal: dismissalText(r, names) })),
    recent_bowling: recentBowl.map(r => ({ match_id: r.match_id, date: r.match_date, vs: vs(r), overs: overs(r.legal_balls), runs: r.runs, wickets: r.wickets, econ: rate(r.runs, r.legal_balls) })),
    updated_at: s.updated_at || null,
  };
}

// ------------------------------------------------------------ points table
async function pointsTable(tournamentId) {
  const t = await db.get('SELECT * FROM tournaments WHERE id = ?', [tournamentId]);
  const teams = await db.all(`SELECT tm.id, tm.name, tm.short_name, tm.color FROM tournament_teams tt JOIN teams tm ON tm.id = tt.team_id WHERE tt.tournament_id = ? ORDER BY tm.name`, [tournamentId]);
  const rows = new Map(teams.map(tm => [tm.id, { team: tm, played: 0, won: 0, lost: 0, tied: 0, nr: 0, points: 0, rf: 0, bf: 0, ra: 0, ba: 0, form: [] }]));
  const matches = await db.all(`SELECT * FROM matches WHERE tournament_id = ? AND status IN ('completed', 'abandoned') ORDER BY match_date, id`, [tournamentId]);
  for (const m of matches) {
    if (m.status === 'abandoned') {   // no result: 1 point each, not counted in NRR
      for (const id of [m.team1_id, m.team2_id]) { const r = rows.get(id); if (r) { r.played++; r.nr++; r.points += 1; r.form.push('N'); } }
      continue;
    }
    const inns = await db.all('SELECT * FROM innings WHERE match_id = ?', [m.id]);
    for (const id of [m.team1_id, m.team2_id]) {
      const r = rows.get(id); if (!r) continue;
      r.played++;
      if (!m.winner_team_id) { r.tied++; r.points += 1; r.form.push('T'); }
      else if (m.winner_team_id === id) { r.won++; r.points += 2; r.form.push('W'); }
      else { r.lost++; r.form.push('L'); }
    }
    for (const i of inns) {
      const xi = await db.get('SELECT COUNT(*) AS n FROM match_players WHERE match_id = ? AND team_id = ?', [m.id, i.batting_team_id]);
      const allOut = i.wickets >= Math.max(1, Number(xi.n) - 1);
      const ballsUsed = allOut ? m.overs * 6 : i.legal_balls; // all out = full quota counts for NRR
      const bat = rows.get(i.batting_team_id), bowl = rows.get(i.bowling_team_id);
      if (bat) { bat.rf += i.runs; bat.bf += ballsUsed; }
      if (bowl) { bowl.ra += i.runs; bowl.ba += ballsUsed; }
    }
  }
  const list = [...rows.values()].map(r => {
    const nrr = (r.bf ? r.rf * 6 / r.bf : 0) - (r.ba ? r.ra * 6 / r.ba : 0);
    return { team: r.team, played: r.played, won: r.won, lost: r.lost, tied: r.tied, nr: r.nr, points: r.points, nrr: (nrr >= 0 ? '+' : '') + nrr.toFixed(3), form: r.form.slice(-5), _nrr: nrr };
  });
  list.sort((a, b) => b.points - a.points || b._nrr - a._nrr || a.team.name.localeCompare(b.team.name));
  return { tournament: t, table: list.map(({ _nrr, ...r }) => r) };
}

async function leaders(limit = 5) {
  const bat = await db.all(`SELECT p.id, p.first_name, p.last_name, t.short_name, s.runs, s.bat_innings, s.balls_faced FROM player_stats s
      JOIN players p ON p.id = s.player_id LEFT JOIN teams t ON t.id = p.team_id WHERE s.runs > 0 ORDER BY s.runs DESC, s.balls_faced ASC LIMIT ${Number(limit)}`);
  const bowl = await db.all(`SELECT p.id, p.first_name, p.last_name, t.short_name, s.wickets, s.runs_conceded, s.balls_bowled FROM player_stats s
      JOIN players p ON p.id = s.player_id LEFT JOIN teams t ON t.id = p.team_id WHERE s.wickets > 0 ORDER BY s.wickets DESC, s.runs_conceded ASC LIMIT ${Number(limit)}`);
  return {
    runs: bat.map(r => ({ id: r.id, name: fullName(r), team: r.short_name, runs: r.runs, innings: r.bat_innings, sr: sr(r.runs, r.balls_faced) })),
    wickets: bowl.map(r => ({ id: r.id, name: fullName(r), team: r.short_name, wickets: r.wickets, econ: rate(r.runs_conceded, r.balls_bowled) })),
  };
}

module.exports = { matchState, matchSummaries, summarise, playerProfile, pointsTable, leaders, fullName };
