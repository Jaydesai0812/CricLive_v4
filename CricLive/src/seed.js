// =====================================================================
//  Demo data
//    npm run seed   -> wipes the database and loads the demo data
//    npm run reset  -> wipes the database, keeps only the staff logins
//
//  6 city clubs, 13 players each, 2 tournaments.
//  Every match is played ball-by-ball through the REAL scoring engine,
//  so scorecards, player stats, charts and AI segments are consistent.
// =====================================================================
const path = require('path');
const fs = require('fs');
if (require.main === module) {
  const envFile = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
}
const db = require('./db');
const engine = require('./engine');
const notify = require('./notify');
const { now, hashPassword } = require('./util');

// deterministic random numbers -> same demo data every time
let seedState = 20260604;
const rnd = () => ((seedState = (seedState * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = arr => arr[Math.floor(rnd() * arr.length)];

const TEAMS = [
  { name: 'Leeds Lynx', short: 'LYN', city: 'Leeds', region: 'West Yorkshire', color: '#2a78d6', ground: 'Roundhay Park, Leeds' },
  { name: 'Manchester Mavericks', short: 'MAV', city: 'Manchester', region: 'Greater Manchester', color: '#d4561f', ground: 'Platt Fields Park, Manchester' },
  { name: 'Bristol Buccaneers', short: 'BUC', city: 'Bristol', region: 'Bristol', color: '#0e8a5f', ground: 'Clifton Downs, Bristol' },
  { name: 'Nottingham Nomads', short: 'NOM', city: 'Nottingham', region: 'Nottinghamshire', color: '#4a3aa7', ground: 'Wollaton Park, Nottingham' },
  { name: 'Cardiff Comets', short: 'COM', city: 'Cardiff', region: 'Glamorgan', color: '#c43d3c', ground: 'Bute Park, Cardiff' },
  { name: 'Glasgow Griffins', short: 'GRF', city: 'Glasgow', region: 'Lanarkshire', color: '#9a6a00', ground: 'Glasgow Green, Glasgow' },
];

const FIRST = ['Oliver', 'Harry', 'George', 'Arjun', 'Kwame', 'Thomas', 'Imran', 'Callum', 'Zain', 'Freddie', 'Marcus', 'Rohan', 'Theo',
  'Jack', 'Kabir', 'Charlie', 'Hamza', 'Nathaniel', 'Ravi', 'Alfie', 'Jerome', 'Connor', 'Bilal', 'Henry', 'Tobi', 'Lucas',
  'Archie', 'Nikhil', 'Reuben', 'Ethan', 'Yusuf', 'Finn', 'Chidi', 'Samuel', 'Tariq', 'Oscar', 'Declan', 'Varun', 'Isaac',
  'Malik', 'William', 'Haseeb', 'Rory', 'Elliot', 'Jayden', 'Felix', 'Saqib', 'Dominic', 'Hugo', 'Karthik', 'Aidan', 'Noah',
  'Ibrahim', 'Sebastian', 'Patrick', 'Adil', 'Luke', 'Rafael', 'Kieran', 'Joshua', 'Mateo', 'Ryan', 'Daniel', 'Max', 'Ollie',
  'Dev', 'Elijah', 'Benedict', 'Aaron', 'Cameron', 'Tyrone', 'Leo', 'Ashton', 'Gabriel', 'Jonah', 'Rahul', 'Edward', 'Ahmed'];
const LAST = ['Bennett', 'Hughes', 'Patel', 'Brown', 'Mensah', 'Clarke', 'Khan', 'Fletcher', 'Ahmed', 'Wright', 'Campbell', 'Shah',
  'Pemberton', 'Okafor', 'Singh', 'Ashworth', 'Hussain', 'Grant', 'Mistry', 'Evans', 'Osei', 'Murphy', 'Iqbal', 'Hargreaves',
  'Adeyemi', 'Fraser', 'Rahman', 'Walker', 'Chaudhry', 'Taylor', 'Costa', 'Thompson', 'Novak', 'Edwards', 'Kowalski', 'Green',
  'Harris', 'Silva', "O'Brien", 'White', 'Hall', 'Roberts', 'Wilson', 'Kaur', 'Johnson'];
const AVOID = ['Jamie Smith', 'Ollie Robinson', 'Ben Stokes', 'Joe Root', 'Mark Wood', 'Adil Rashid', 'Rehan Ahmed', 'Will Jacks'];

// squad template: role, batting style, bowling type (hidden skill used only by the simulation)
const SQUAD = [
  ['Batsman', 'anchor', null], ['Batsman', 'power', null], ['Wicket-keeper', 'power', null], ['Batsman', 'anchor', null],
  ['Batsman', 'power', null], ['All-rounder', 'power', 'econ'], ['All-rounder', 'anchor', 'strike'], ['Bowler', 'tail', 'strike'],
  ['Bowler', 'tail', 'econ'], ['Bowler', 'tail', 'strike'], ['Bowler', 'tail', 'econ'], ['Batsman', 'anchor', null], ['Bowler', 'tail', 'strike'],
];
const PACE = ['Right-arm fast', 'Right-arm fast-medium', 'Left-arm fast-medium'];
const SPIN = ['Right-arm off-break', 'Slow left-arm orthodox', 'Right-arm leg-break'];
// demo passwords - strong enough to pass the password policy
const DEMO = { admin: 'Boundary#Six2026', scorer: 'Yorker#Pace2026', player: 'Cover#Drive2026' };
const skill = new Map(); // player id -> { bat, bowl, k }

function dateOffset(days, hour = 13) {
  const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:00:00`;
}

// ------------------------------------------------------------ ball simulation
function outcome(bat, bowl, death) {
  const w = { 0: 36, 1: 30, 2: 8, 3: 1, 4: 10, 6: 4, W: 4.5, wd: 3, nb: 1, lb: 2 };
  const mul = (k, f) => { w[k] *= f; };
  if (bat.bat === 'power') { mul(4, 1.45); mul(6, 2.3); mul(0, 0.85); mul(1, 0.85); mul('W', 1.3); }
  if (bat.bat === 'anchor') { mul(1, 1.3); mul(2, 1.25); mul(4, 0.85); mul(6, 0.45); mul('W', 0.65); }
  if (bat.bat === 'tail') { mul(0, 1.35); mul(4, 0.6); mul(6, 0.5); mul('W', 2.3); }
  if (bowl.bowl === 'strike') { mul('W', 1.45); mul(4, 1.1); }
  if (bowl.bowl === 'econ') { mul(0, 1.25); mul('W', 0.85); mul(4, 0.75); mul(6, 0.65); mul('wd', 0.6); }
  if (death) { mul(4, 1.2); mul(6, 1.6); mul('W', 1.3); mul(0, 0.85); }
  mul(4, bat.k); mul(6, bat.k); mul('W', 1 / bat.k); mul('W', bowl.k);
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  let x = rnd() * total;
  for (const [k, v] of Object.entries(w)) { if ((x -= v) <= 0) return k; }
  return '0';
}

async function playMatch(matchId, { stopAfterBalls = Infinity } = {}) {
  const m = await db.get('SELECT * FROM matches WHERE id = ?', [matchId]);
  const xi = async t => (await db.all('SELECT id FROM players WHERE team_id = ? ORDER BY id LIMIT 11', [t])).map(r => r.id);
  const xis = { [m.team1_id]: await xi(m.team1_id), [m.team2_id]: await xi(m.team2_id) };
  await engine.startMatch(matchId, {
    toss_winner_id: rnd() < 0.5 ? m.team1_id : m.team2_id, toss_decision: rnd() < 0.55 ? 'bat' : 'bowl',
    team1_xi: xis[m.team1_id], team2_xi: xis[m.team2_id],
  });
  const quota = Math.max(1, Math.ceil(m.overs / 5));
  let bowled = 0;
  for (let guard = 0; guard < 5000 && bowled < stopAfterBalls; guard++) {
    const mm = await db.get('SELECT status, current_innings FROM matches WHERE id = ?', [matchId]);
    if (mm.status !== 'live') break;
    const inn = await db.get('SELECT * FROM innings WHERE match_id = ? AND innings_no = ?', [matchId, mm.current_innings]);
    if (!inn.striker_id || !inn.non_striker_id) {
      const used = (await db.all('SELECT player_id FROM batting_scores WHERE innings_id = ?', [inn.id])).map(r => r.player_id);
      const yet = xis[inn.batting_team_id].filter(p => !used.includes(p));
      await engine.setBatsmen(matchId, { striker_id: inn.striker_id ? null : yet.shift(), non_striker_id: inn.non_striker_id ? null : yet.shift() });
      continue;
    }
    if (!inn.bowler_id) {
      const figs = new Map((await db.all('SELECT player_id, legal_balls FROM bowling_scores WHERE innings_id = ?', [inn.id])).map(r => [r.player_id, r.legal_balls]));
      const pool = xis[inn.bowling_team_id].filter(p => skill.get(p).bowl && p !== inn.last_over_bowler_id && (figs.get(p) || 0) < quota * 6);
      pool.sort((a, b) => (figs.get(a) || 0) - (figs.get(b) || 0) + (rnd() - 0.5));
      await engine.setBowler(matchId, { bowler_id: pool[0] || xis[inn.bowling_team_id].find(p => p !== inn.last_over_bowler_id) });
      continue;
    }
    const death = Math.floor(inn.legal_balls / 6) >= m.overs - Math.ceil(m.overs * 0.25);
    const o = outcome(skill.get(inn.striker_id), skill.get(inn.bowler_id), death);
    let ball;
    if (o === 'W') {
      const type = pick(['caught', 'caught', 'caught', 'caught', 'bowled', 'bowled', 'lbw', 'run_out', 'stumped', 'caught_bowled']);
      const field = xis[inn.bowling_team_id];
      const keeper = field[2];
      const fielder = type === 'stumped' ? keeper : pick(field.filter(p => p !== inn.bowler_id));
      ball = { runs: type === 'run_out' ? pick([0, 1]) : 0, wicket: { type, fielder_id: ['caught', 'run_out', 'stumped'].includes(type) ? fielder : null } };
    } else if (o === 'wd') ball = { runs: rnd() < 0.85 ? 0 : 1, extra: 'wd' };
    else if (o === 'nb') ball = { runs: pick([0, 1, 4]), extra: 'nb' };
    else if (o === 'lb') ball = { runs: 1, extra: rnd() < 0.7 ? 'lb' : 'b' };
    else ball = { runs: Number(o) };
    await engine.recordBall(matchId, ball);
    bowled++;
  }
}

// circle method: everyone plays everyone once, 3 matches per round
function roundRobin(ids) {
  const list = ids.slice(), rounds = [];
  for (let r = 0; r < list.length - 1; r++) {
    for (let i = 0; i < list.length / 2; i++) rounds.push(r % 2 ? [list[list.length - 1 - i], list[i]] : [list[i], list[list.length - 1 - i]]);
    list.splice(1, 0, list.pop());
  }
  return rounds;
}

async function seed({ demo = true, keepConnection = false, wipe = false } = {}) {
  await db.connect();
  if (wipe) await db.dropAll();
  await db.run('INSERT INTO admins (name, username, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)', ['League Administrator', 'admin', 'admin@criclive.test', hashPassword(DEMO.admin), 'admin', now()]);
  await db.run('INSERT INTO admins (name, username, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)', ['Match Scorer', 'scorer', 'scorer@criclive.test', hashPassword(DEMO.scorer), 'scorer', now()]);
  if (!demo) { console.log(`[seed] Empty database ready. Logins: admin / ${DEMO.admin}, scorer / ${DEMO.scorer}`); if (!keepConnection) await db.close(); return; }

  const t0 = Date.now();
  const teamIds = [];
  const usedNames = new Set();
  let n = 0, demoEmail = '';
  for (const t of TEAMS) {
    const { lastId: tid } = await db.run('INSERT INTO teams (name, short_name, city, color, created_at) VALUES (?, ?, ?, ?, ?)', [t.name, t.short, t.city, t.color, now()]);
    teamIds.push(tid);
    const shirts = new Set();
    for (const [role, bat, bowl] of SQUAD) {
      let first = FIRST[n], last = LAST[(n * 7 + 3) % LAST.length], tries = 0;
      while ((AVOID.includes(`${first} ${last}`) || usedNames.has(`${first} ${last}`)) && tries < 50) { last = LAST[(n * 7 + 3 + ++tries) % LAST.length]; }
      usedNames.add(`${first} ${last}`);
      let shirt; do { shirt = 1 + Math.floor(rnd() * 99); } while (shirts.has(shirt)); shirts.add(shirt);
      const email = `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '') + '@criclive.test';
      if (n === 0) demoEmail = email;
      const bowlStyle = bowl ? (rnd() < 0.6 ? pick(PACE) : pick(SPIN)) : null;
      const { lastId: pid } = await db.run(`INSERT INTO players (first_name, last_name, email, phone, password_hash, city, state, dob, role, batting_style, bowling_style, jersey_no, team_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [first, last, email, '07700 900' + String(100 + n).padStart(3, '0'), n === 0 ? hashPassword(DEMO.player) : null, t.city, t.region,
          `${1990 + (n % 15)}-${String(1 + (n % 12)).padStart(2, '0')}-${String(1 + (n * 3) % 28).padStart(2, '0')}`,
          role, rnd() < 0.72 ? 'Right-hand bat' : 'Left-hand bat', bowlStyle, shirt, tid, now()]);
      skill.set(pid, { bat, bowl, k: 0.8 + rnd() * 0.45 });
      await notify.follow(pid, tid);
      n++;
    }
  }

  // ---- Tournament 1: completed winter T10 cup (4 teams)
  const { lastId: cup } = await db.run(`INSERT INTO tournaments (name, organizer, venue, start_date, end_date, overs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['Club T10 Spring Cup 2026', 'CricLive Club Cricket Association', 'Roundhay Park, Leeds', dateOffset(-60).slice(0, 10), dateOffset(-50).slice(0, 10), 10, now()]);
  const cupTeams = teamIds.slice(0, 4);
  for (const t of cupTeams) await db.run('INSERT INTO tournament_teams (tournament_id, team_id) VALUES (?, ?)', [cup, t]);
  let day = -60;
  for (const [a, b] of roundRobin(cupTeams)) {
    const { lastId } = await db.run(`INSERT INTO matches (tournament_id, team1_id, team2_id, venue, match_date, overs, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
      [cup, a, b, TEAMS[teamIds.indexOf(a)].ground, dateOffset(day, 11), 10, now(), now()]);
    await playMatch(lastId);
    day += 2;
  }

  // ---- Tournament 2: current T20 league (6 teams, 15 fixtures)
  const { lastId: league } = await db.run(`INSERT INTO tournaments (name, organizer, venue, start_date, end_date, overs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['National Club League 2026', 'CricLive Club Cricket Association', 'Club grounds', dateOffset(-18).slice(0, 10), dateOffset(10).slice(0, 10), 20, now()]);
  for (const t of teamIds) await db.run('INSERT INTO tournament_teams (tournament_id, team_id) VALUES (?, ?)', [league, t]);
  const fixtures = roundRobin(teamIds);
  const offsets = [-18, -16, -14, -12, -10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10];
  const ids = [];
  for (let i = 0; i < fixtures.length; i++) {
    const [a, b] = fixtures[i];
    const { lastId } = await db.run(`INSERT INTO matches (tournament_id, team1_id, team2_id, venue, match_date, overs, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
      [league, a, b, TEAMS[teamIds.indexOf(a)].ground, dateOffset(offsets[i], 13), 20, now(), now()]);
    ids.push(lastId);
  }
  console.log('[seed] Playing demo matches ball-by-ball through the scoring engine (takes a few seconds)...');
  for (let i = 0; i < 9; i++) {
    if (i === 4) { // one rain-off to show "no result" in the table
      await db.run(`UPDATE matches SET status = 'abandoned', result_text = 'Match abandoned (rain) - no result', updated_at = ? WHERE id = ?`, [now(), ids[i]]);
      continue;
    }
    await playMatch(ids[i]);
    const m = await db.get('SELECT m.*, a.name AS t1, b.name AS t2 FROM matches m JOIN teams a ON a.id = m.team1_id JOIN teams b ON b.id = m.team2_id WHERE m.id = ?', [ids[i]]);
    await notify.dispatch([{ kind: 'result', match_id: m.id, team_ids: [m.team1_id, m.team2_id], link: `/match.html?id=${m.id}`, title: `Result: ${m.t1} v ${m.t2}`, body: m.result_text }]);
  }
  await playMatch(ids[9], { stopAfterBalls: 172 }); // LIVE: second innings under way
  for (let i = 10; i < ids.length; i++) await notify.fixtureAdded(ids[i]);
  // keep "updated_at" in fixture order so lists look natural
  await db.run(`UPDATE matches SET updated_at = match_date WHERE status <> 'live'`);
  await db.run(`UPDATE notifications SET is_read = 1 WHERE kind = 'result'`);

  console.log(`[seed] Demo loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s: 6 teams, 78 players, 2 tournaments (21 matches: 14 completed, 1 abandoned, 1 live, 5 upcoming)`);
  console.log(`[seed] Admin  login : admin / ${DEMO.admin}      Scorer login: scorer / ${DEMO.scorer}`);
  console.log(`[seed] Player login: ${demoEmail} / ${DEMO.player}`);
  if (!keepConnection) await db.close();
}

module.exports = { seed, DEMO };

if (require.main === module) {
  const empty = process.argv.includes('--empty');
  seed({ demo: !empty, wipe: true }).catch(e => { console.error(e); process.exit(1); });
}
