// =====================================================================
//  Match alerts & notifications
//   - live alerts  : pushed instantly to every open browser (wicket,
//                    fifty, hundred, 3-fors, match start, innings break, result)
//   - notifications: saved in the DB for logged-in players who follow a
//                    team (fixture added, match start, innings, result, milestones)
// =====================================================================
const db = require('./db');
const live = require('./live');
const { now } = require('./util');

const PERSIST = ['fixture', 'start', 'innings', 'result', 'milestone', 'abandoned'];

// Compare the match before and after a scoring action and describe what happened
function deriveAlerts(prev, next) {
  if (!prev || !next) return [];
  const alerts = [];
  const vs = `${next.team1.short_name} v ${next.team2.short_name}`;
  const teams = [next.team1.id, next.team2.id];
  const base = { match_id: next.id, team_ids: teams, link: `/match.html?id=${next.id}` };

  if (prev.status === 'scheduled' && next.status === 'live') {
    alerts.push({ ...base, kind: 'start', title: `Match started: ${next.team1.name} v ${next.team2.name}`, body: next.status_text });
  }
  const prevTop = prev.commentary.length ? prev.commentary[0].seq : 0;
  const fresh = next.commentary.filter(c => c.seq > prevTop);
  for (const c of fresh.reverse()) {
    if (c.kind === 'wicket') {
      const inn = next.innings.find(i => i.innings_no === c.innings_no);
      alerts.push({ ...base, kind: 'wicket', title: `WICKET! ${vs}`, body: `${c.text} (${inn ? inn.runs + '/' + inn.wickets : ''})` });
    }
  }
  for (const inn of next.innings) {
    const before = prev.innings.find(i => i.innings_no === inn.innings_no);
    for (const b of inn.batting) {
      const old = before ? before.batting.find(x => x.id === b.id) : null;
      const was = old ? old.runs : 0;
      for (const mark of [100, 50]) {
        if (b.runs >= mark && was < mark) {
          alerts.push({ ...base, kind: 'milestone', player_id: b.id, title: `${mark === 100 ? 'HUNDRED' : 'FIFTY'} for ${b.name}!`, body: `${b.name} reaches ${b.runs} off ${b.balls} balls for ${inn.batting_team.name} (${vs})` });
          break;
        }
      }
    }
    for (const bw of inn.bowling) {
      const old = before ? before.bowling.find(x => x.id === bw.id) : null;
      const was = old ? old.wickets : 0;
      for (const mark of [5, 3]) {
        if (bw.wickets >= mark && was < mark) {
          alerts.push({ ...base, kind: 'milestone', player_id: bw.id, title: `${mark}-wicket haul for ${bw.name}!`, body: `${bw.name}: ${bw.wickets}/${bw.runs} in ${bw.overs} overs (${vs})` });
          break;
        }
      }
    }
  }
  const p1 = prev.innings.find(i => i.innings_no === 1), n1 = next.innings.find(i => i.innings_no === 1);
  if (p1 && n1 && p1.status === 'in_progress' && n1.status === 'completed' && next.status === 'live') {
    alerts.push({ ...base, kind: 'innings', title: `Innings break: ${vs}`, body: `${n1.batting_team.name} ${n1.runs}/${n1.wickets} (${n1.overs} ov). ${n1.bowling_team.name} need ${n1.runs + 1} to win.` });
  }
  if (prev.status !== 'completed' && next.status === 'completed') {
    alerts.push({ ...base, kind: 'result', title: `Result: ${next.team1.name} v ${next.team2.name}`, body: next.result_text });
  }
  return alerts;
}

async function followersOf(teamIds) {
  if (!teamIds.length) return [];
  const rows = await db.all(`SELECT DISTINCT player_id FROM follows WHERE team_id IN (${teamIds.map(() => '?').join(',')})`, teamIds);
  return rows.map(r => r.player_id);
}

async function save(recipients, a) {
  const t = now();
  for (const pid of [...new Set(recipients)]) {
    await db.run(`INSERT INTO notifications (recipient_type, recipient_id, kind, title, body, link, created_at) VALUES ('player', ?, ?, ?, ?, ?, ?)`,
      [pid, a.kind, a.title.slice(0, 120), (a.body || '').slice(0, 255), a.link || null, t]);
  }
}

// send alerts live + store the important ones for followers
async function dispatch(alerts) {
  for (const a of alerts) {
    live.publishAlert(a);
    if (!PERSIST.includes(a.kind)) continue;
    const to = await followersOf(a.team_ids || []);
    if (a.player_id) to.push(a.player_id);
    await save(to, a);
  }
}

async function fixtureAdded(matchId) {
  const m = await db.get(`SELECT m.*, a.name AS t1, b.name AS t2 FROM matches m JOIN teams a ON a.id = m.team1_id JOIN teams b ON b.id = m.team2_id WHERE m.id = ?`, [matchId]);
  if (!m) return;
  const when = m.match_date ? new Date(String(m.match_date).replace(' ', 'T')).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'date to be confirmed';
  await dispatch([{ kind: 'fixture', match_id: m.id, team_ids: [m.team1_id, m.team2_id], link: `/match.html?id=${m.id}`,
    title: `New fixture: ${m.t1} v ${m.t2}`, body: `${when}${m.venue ? ' at ' + m.venue : ''}` }]);
}

async function follow(playerId, teamId) {
  const exists = await db.get('SELECT 1 AS x FROM follows WHERE player_id = ? AND team_id = ?', [playerId, teamId]);
  if (!exists) await db.run('INSERT INTO follows (player_id, team_id, created_at) VALUES (?, ?, ?)', [playerId, teamId, now()]);
}

module.exports = { deriveAlerts, dispatch, fixtureAdded, follow };
