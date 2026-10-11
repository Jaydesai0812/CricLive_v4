// =====================================================================
//  All API routes
//    /api/...             public: anyone can watch scores, stats, charts
//    /api/auth/...        login / register / logout
//    /api/me/...          logged-in player (profile, follows, notifications)
//    /api/admin/...       staff only - role based access control:
//                           admin  -> everything
//                           scorer -> live scoring of matches only
// =====================================================================
const db = require('./db');
const engine = require('./engine');
const state = require('./state');
const live = require('./live');
const notify = require('./notify');
const analytics = require('./analytics');
const { Router, startSession, endSession } = require('./http');
const { HttpError, bad, now, hashPassword, checkPassword, checkPolicy, checkEmailFormat, checkEmailDomain, str, int, date } = require('./util');
const otp = require('./otp');
const reports = require('./reports');
const mailer = require('./mailer');

const r = new Router();
const id = req => int(req.params.id, { min: 1, required: true, name: 'id' });

// ---------------------------------------------------------------- access control
const ROLES = ['admin', 'scorer'];
const requireStaff = req => { if (!req.session.admin) throw new HttpError(401, 'Staff login required'); };
const requireAdmin = req => {
  requireStaff(req);
  if (req.session.admin.role !== 'admin') throw new HttpError(403, 'Only an admin can do this (your role: ' + req.session.admin.role + ')');
};
const requirePlayer = req => { if (!req.session.player) throw new HttpError(401, 'Player login required'); };

async function audit(req, action, details = '') {
  const a = req.session.admin;
  await db.run('INSERT INTO audit_log (actor, role, action, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [a ? a.username : 'system', a ? a.role : null, action, String(details).slice(0, 255), req.ip || null, now()]);
}

// ---------------------------------------------------------------- brute-force protection
const failures = new Map(); // key -> { count, until }
const LOCK_AFTER = 5, LOCK_MS = 5 * 60 * 1000;
function checkLock(key) {
  const f = failures.get(key);
  if (f && f.until > Date.now()) throw new HttpError(429, `Too many failed logins. Try again in ${Math.ceil((f.until - Date.now()) / 60000)} minute(s).`);
}
function loginFailed(key, limit = LOCK_AFTER) {
  const f = failures.get(key) || { count: 0, until: 0 };
  f.count++;
  if (f.count >= limit) { f.until = Date.now() + LOCK_MS; f.count = 0; }
  failures.set(key, f);
}

// ---------------------------------------------------------------- live stream
r.get('/api/live', (req, res) => live.subscribe(req, res));

async function broadcast(matchId, playerIds, prevState) {
  const s = await state.matchState(matchId);
  const m = await db.get('SELECT m.*, t.name AS tournament_name FROM matches m LEFT JOIN tournaments t ON t.id = m.tournament_id WHERE m.id = ?', [matchId]);
  const sum = await state.summarise(m);
  // the last ball and the winner let every page play the right celebration (FOUR / SIX / WICKET / WIN)
  if (s.commentary[0]) sum.last = { seq: s.commentary[0].seq, kind: s.commentary[0].kind, text: s.commentary[0].text };
  sum.winner_team_id = m.winner_team_id || null;
  live.publishMatch(s, sum);
  live.publishStats(playerIds || []);
  if (prevState) await notify.dispatch(notify.deriveAlerts(prevState, s));
  return s;
}

// ---------------------------------------------------------------- public
r.get('/api/home', async () => ({
  live: await state.matchSummaries({ status: 'live' }),
  upcoming: await state.matchSummaries({ status: 'scheduled', limit: 10 }),
  results: await state.matchSummaries({ status: 'completed', limit: 10 }),
  leaders: await state.leaders(5),
}));

r.get('/api/matches', async req => state.matchSummaries({
  status: req.query.status || null, tournamentId: int(req.query.tournament), teamId: int(req.query.team),
  limit: int(req.query.limit, { min: 1, max: 500 }) || 50,
}));

r.get('/api/matches/:id', async req => {
  const s = await state.matchState(id(req));
  if (!s) throw new HttpError(404, 'Match not found');
  return s;
});
r.get('/api/matches/:id/charts', async req => {
  const c = await analytics.matchCharts(id(req));
  if (!c) throw new HttpError(404, 'Match not found');
  return c;
});

r.get('/api/teams', async () => db.all(`SELECT t.*, (SELECT COUNT(*) FROM players p WHERE p.team_id = t.id) AS players FROM teams t ORDER BY t.name`));

r.get('/api/teams/:id', async req => {
  const t = await db.get('SELECT * FROM teams WHERE id = ?', [id(req)]);
  if (!t) throw new HttpError(404, 'Team not found');
  t.players = await db.all(`SELECT p.id, p.first_name, p.last_name, p.role, p.batting_style, p.bowling_style, p.jersey_no,
        COALESCE(s.matches,0) AS matches, COALESCE(s.runs,0) AS runs, COALESCE(s.wickets,0) AS wickets
      FROM players p LEFT JOIN player_stats s ON s.player_id = p.id WHERE p.team_id = ? ORDER BY p.id`, [t.id]);
  t.matches = await state.matchSummaries({ teamId: t.id, limit: 30 });
  return t;
});
r.get('/api/teams/:id/charts', async req => analytics.teamCharts(id(req)));

r.get('/api/players', async req => {
  const qtxt = (req.query.q || '').trim();
  const params = [];
  let where = '';
  if (qtxt) { where = `WHERE (p.first_name LIKE ? OR p.last_name LIKE ? OR t.name LIKE ?)`; params.push(`%${qtxt}%`, `%${qtxt}%`, `%${qtxt}%`); }
  if (req.query.team) { where += (where ? ' AND ' : 'WHERE ') + 'p.team_id = ?'; params.push(int(req.query.team)); }
  return db.all(`SELECT p.id, p.first_name, p.last_name, p.role, p.team_id, t.name AS team_name, t.short_name, t.color,
        COALESCE(s.matches,0) AS matches, COALESCE(s.runs,0) AS runs, COALESCE(s.wickets,0) AS wickets
      FROM players p LEFT JOIN teams t ON t.id = p.team_id LEFT JOIN player_stats s ON s.player_id = p.id
      ${where} ORDER BY p.first_name, p.last_name LIMIT 500`, params);
});

r.get('/api/players/:id', async req => {
  const p = await state.playerProfile(id(req));
  if (!p) throw new HttpError(404, 'Player not found');
  return p;
});
r.get('/api/players/:id/charts', async req => analytics.playerCharts(id(req)));

r.get('/api/tournaments', async () => db.all(`SELECT t.*, (SELECT COUNT(*) FROM tournament_teams tt WHERE tt.tournament_id = t.id) AS teams,
    (SELECT COUNT(*) FROM matches m WHERE m.tournament_id = t.id) AS matches FROM tournaments t ORDER BY t.start_date DESC, t.id DESC`));

r.get('/api/tournaments/:id', async req => {
  const pt = await state.pointsTable(id(req));
  if (!pt.tournament) throw new HttpError(404, 'Tournament not found');
  return { ...pt.tournament, points_table: pt.table, matches: await state.matchSummaries({ tournamentId: pt.tournament.id, limit: 300 }) };
});
r.get('/api/tournaments/:id/charts', async req => analytics.tournamentCharts(id(req)));

r.get('/api/leaders', async () => state.leaders(10));

// ---------------------------------------------------------------- downloads (CSV + reports with charts)
function download(res, file, type) {
  if (!file) throw new HttpError(404, 'Not found');
  const name = file.filename.replace(/[^A-Za-z0-9._-]/g, '_');
  res.writeHead(200, { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
  res.end(file.body);
}
const CSV = 'text/csv; charset=utf-8', HTML = 'text/html; charset=utf-8';
r.get('/api/matches/:id/download/balls.csv', async (req, res) => download(res, await reports.matchBallsCsv(id(req)), CSV));
r.get('/api/matches/:id/download/scorecard.csv', async (req, res) => download(res, await reports.matchScorecardCsv(id(req)), CSV));
r.get('/api/matches/:id/download/report.html', async (req, res) => download(res, await reports.matchReport(id(req)), HTML));
r.get('/api/players/:id/download/matches.csv', async (req, res) => download(res, await reports.playerCsv(id(req)), CSV));
r.get('/api/players/:id/download/report.html', async (req, res) => download(res, await reports.playerReport(id(req)), HTML));

// ---------------------------------------------------------------- contact us / report a bug
const fbHits = new Map(); // ip -> [timestamps]
r.post('/api/feedback', async req => {
  if (req.body.website) return { ok: true }; // hidden "honeypot" field: only robots fill it in
  const recent = (fbHits.get(req.ip) || []).filter(t => t > Date.now() - 3600 * 1000);
  if (recent.length >= 5) throw new HttpError(429, 'You have sent 5 messages in the last hour. Please try again later.');
  const kind = ['bug', 'question', 'idea'].includes(req.body.kind) ? req.body.kind : 'bug';
  const name = str(req.body.name, { max: 80, required: true, name: 'Name' });
  const email = checkEmailFormat(req.body.email);
  const message = str(req.body.message, { max: 3000, required: true, name: 'Message' });
  if (message.length < 10) throw bad('Please describe it in a little more detail (at least 10 characters)');
  const { lastId } = await db.run('INSERT INTO feedback (kind, name, email, page, message, device, status, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [kind, name, email, str(req.body.page, { max: 120 }), message, str(req.body.device, { max: 200 }), 'new', req.ip, now()]);
  recent.push(Date.now()); fbHits.set(req.ip, recent);
  return { ok: true, ref: 'CL-' + String(lastId).padStart(4, '0') };
});
r.get('/api/admin/feedback', requireAdmin, async () => db.all('SELECT * FROM feedback ORDER BY id DESC LIMIT 300'));
r.put('/api/admin/feedback/:id', requireAdmin, async req => {
  const status = ['new', 'in_progress', 'resolved'].includes(req.body.status) ? req.body.status : 'new';
  await db.run('UPDATE feedback SET status = ? WHERE id = ?', [status, id(req)]);
  await audit(req, 'feedback.' + status, `#${id(req)}`);
});
r.delete('/api/admin/feedback/:id', requireAdmin, async req => {
  await db.run('DELETE FROM feedback WHERE id = ?', [id(req)]);
  await audit(req, 'feedback.delete', `#${id(req)}`);
});
r.get('/api/analytics', async () => analytics.segmentation());

// ---------------------------------------------------------------- auth
r.get('/api/auth/me', async req => {
  let unread = 0;
  if (req.session.player) unread = Number((await db.get(`SELECT COUNT(*) AS n FROM notifications WHERE recipient_type = 'player' AND recipient_id = ? AND is_read = 0`, [req.session.player.id])).n);
  return { admin: req.session.admin || null, player: req.session.player || null, unread };
});

// Sign-in is two steps:  1) password  ->  2) 6-digit code sent by e-mail (OTP)
r.post('/api/auth/admin/login', async req => {
  const username = str(req.body.username, { required: true, name: 'Username' });
  const key = 'a:' + username.toLowerCase() + '|' + req.ip;
  checkLock(key);
  const a = await db.get('SELECT * FROM admins WHERE username = ?', [username]);
  if (!checkPassword(req.body.password || '', a && a.password_hash) || !a) { loginFailed(key); throw bad('Wrong username or password'); }
  failures.delete(key);
  let email = a.email;
  if (!email) {
    if (!mailer.devMode()) throw bad('This staff account has no e-mail address for sign-in codes. Ask an admin to add one in Staff & roles.');
    email = `${a.username}@staff.local`;
  }
  return { otp: await otp.create({ purpose: 'login', account: 'admin', accountId: a.id, email, name: a.name, ip: req.ip }) };
});

r.post('/api/auth/player/login', async req => {
  const email = str(req.body.email, { required: true, name: 'Email' }).toLowerCase();
  const key = 'p:' + email + '|' + req.ip;
  checkLock(key);
  const p = await db.get('SELECT * FROM players WHERE email = ?', [email]);
  if (!checkPassword(req.body.password || '', p && p.password_hash) || !p) { loginFailed(key); throw bad('Wrong email or password'); }
  failures.delete(key);
  return { otp: await otp.create({ purpose: 'login', account: 'player', accountId: p.id, email, name: p.first_name, ip: req.ip }) };
});

// step 2 for sign-in AND sign-up: check the code, then start the session
r.post('/api/auth/otp/verify', async (req, res) => {
  const key = 'otp|' + req.ip;
  checkLock(key);
  let row;
  try { row = await otp.verify(req.body.challenge, req.body.code); }
  catch (e) { loginFailed(key, 20); throw e; } // each code allows 5 tries; one network gets 20 wrong codes before a 5-minute pause
  if (row.purpose === 'register') {
    const f = row.payload;
    if (await db.get('SELECT id FROM players WHERE email = ?', [f.email])) throw bad('This email is already registered');
    const cols = Object.keys(f).filter(c => c !== 'password_hash');
    const { lastId } = await db.run(`INSERT INTO players (${cols.join(', ')}, password_hash, created_at) VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`,
      [...cols.map(c => f[c]), f.password_hash, now()]);
    await startSession(req, res, { player: { id: lastId, name: `${f.first_name} ${f.last_name}` } });
    return { player: req.session.player, next: '/me.html', welcome: true };
  }
  if (row.account === 'admin') {
    const a = await db.get('SELECT * FROM admins WHERE id = ?', [row.account_id]);
    if (!a) throw bad('This account no longer exists');
    await startSession(req, res, { admin: { id: a.id, name: a.name, username: a.username, role: a.role || 'admin' } }, 12 * 3600 * 1000);
    await audit(req, 'login', 'password + one-time code');
    return { admin: req.session.admin, next: '/admin/' };
  }
  const p = await db.get('SELECT id, first_name, last_name FROM players WHERE id = ?', [row.account_id]);
  if (!p) throw bad('This account no longer exists');
  await startSession(req, res, { player: { id: p.id, name: `${p.first_name} ${p.last_name}` } });
  return { player: req.session.player, next: '/player.html?id=' + p.id };
});

r.post('/api/auth/otp/resend', async req => ({ otp: await otp.resend(req.body.challenge) }));

// live checks used by the sign-up form while typing
r.post('/api/auth/check-email', async req => {
  const email = checkEmailFormat(req.body.email);
  await checkEmailDomain(email);
  const taken = !!(await db.get('SELECT id FROM players WHERE email = ?', [email]));
  return { ok: !taken, email, message: taken ? 'This email is already registered - sign in instead.' : 'Looks good' };
});

function playerFields(b, { forRegister = false } = {}) {
  const roles = ['Batsman', 'Bowler', 'All-rounder', 'Wicket-keeper'];
  const role = b.role || 'Batsman';
  if (!roles.includes(role)) throw bad('Role must be one of: ' + roles.join(', '));
  const email = str(b.email, { max: 100, required: forRegister, name: 'Email' });
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Email is not valid');
  const phone = str(b.phone, { max: 15, name: 'Phone' });
  if (phone && !/^[0-9+\- ]{7,15}$/.test(phone)) throw bad('Phone number is not valid');
  return {
    first_name: str(b.first_name, { max: 40, required: true, name: 'First name' }),
    last_name: str(b.last_name, { max: 40, required: true, name: 'Last name' }),
    email: email ? email.toLowerCase() : null, phone,
    city: str(b.city, { max: 60 }), state: str(b.state, { max: 60 }), dob: date(b.dob, 'Date of birth'),
    role, batting_style: str(b.batting_style, { max: 30 }), bowling_style: str(b.bowling_style, { max: 40 }),
    jersey_no: int(b.jersey_no, { min: 0, max: 999, name: 'Shirt number' }),
  };
}

// sign-up step 1: check everything, e-mail a code. The account is only created after the code is entered.
r.post('/api/auth/player/register', async req => {
  const f = playerFields(req.body, { forRegister: true });
  f.email = checkEmailFormat(f.email);
  checkPolicy(req.body.password, [f.email, f.first_name, f.last_name]);
  if (req.body.password !== req.body.password2) throw bad('The two passwords do not match');
  await checkEmailDomain(f.email);
  if (await db.get('SELECT id FROM players WHERE email = ?', [f.email])) throw bad('This email is already registered');
  return { otp: await otp.create({ purpose: 'register', email: f.email, name: f.first_name, ip: req.ip, payload: { ...f, password_hash: hashPassword(req.body.password) } }) };
});

r.post('/api/auth/logout', async (req, res) => { await endSession(req, res); return { ok: true }; });

// ---------------------------------------------------------------- logged-in player
r.get('/api/me', requirePlayer, async req => {
  const p = await db.get(`SELECT id, first_name, last_name, email, phone, city, state, dob, role, batting_style, bowling_style, jersey_no, team_id FROM players WHERE id = ?`, [req.session.player.id]);
  if (p && p.dob) p.dob = String(p.dob).slice(0, 10);
  return p;
});

r.put('/api/me', requirePlayer, async req => {
  const f = playerFields(req.body, { forRegister: true });
  f.email = checkEmailFormat(f.email);
  const me = await db.get('SELECT email, password_hash FROM players WHERE id = ?', [req.session.player.id]);
  const sensitive = f.email !== me.email || req.body.password;
  // changing e-mail or password needs the current password (protects a left-open laptop)
  if (sensitive && !checkPassword(req.body.current_password || '', me.password_hash)) throw bad('Enter your current password to change your e-mail or password');
  if (f.email !== me.email) await checkEmailDomain(f.email);
  const clash = await db.get('SELECT id FROM players WHERE email = ? AND id <> ?', [f.email, req.session.player.id]);
  if (clash) throw bad('This email is used by another player');
  const cols = Object.keys(f);
  await db.run(`UPDATE players SET ${cols.map(c => c + ' = ?').join(', ')} WHERE id = ?`, [...cols.map(c => f[c]), req.session.player.id]);
  if (req.body.password) {
    if (req.body.password !== req.body.password2) throw bad('The two new passwords do not match');
    await db.run('UPDATE players SET password_hash = ? WHERE id = ?', [hashPassword(checkPolicy(req.body.password, [f.email, f.first_name, f.last_name])), req.session.player.id]);
  }
  return { ok: true };
});

r.get('/api/me/follows', requirePlayer, async req =>
  (await db.all('SELECT team_id FROM follows WHERE player_id = ?', [req.session.player.id])).map(x => x.team_id));
r.post('/api/me/follows/:id', requirePlayer, async req => { await notify.follow(req.session.player.id, id(req)); });
r.delete('/api/me/follows/:id', requirePlayer, async req => { await db.run('DELETE FROM follows WHERE player_id = ? AND team_id = ?', [req.session.player.id, id(req)]); });

r.get('/api/me/notifications', requirePlayer, async req => {
  const pid = req.session.player.id;
  const list = await db.all(`SELECT * FROM notifications WHERE recipient_type = 'player' AND recipient_id = ? ORDER BY id DESC LIMIT 100`, [pid]);
  const follows = (await db.all('SELECT team_id FROM follows WHERE player_id = ?', [pid])).map(x => x.team_id);
  let upcoming = [];
  if (follows.length) {
    const ms = await state.matchSummaries({ status: 'scheduled', limit: 100 });
    upcoming = ms.filter(m => follows.includes(m.team1.id) || follows.includes(m.team2.id)).slice(0, 10);
  }
  return { notifications: list, upcoming, follows };
});
r.post('/api/me/notifications/read', requirePlayer, async req => {
  await db.run(`UPDATE notifications SET is_read = 1 WHERE recipient_type = 'player' AND recipient_id = ?`, [req.session.player.id]);
});

// ---------------------------------------------------------------- admin: teams
function teamBody(b, needShort) {
  const name = str(b.name, { max: 60, required: true, name: 'Team name' });
  const short = (str(b.short_name, { max: 6, required: needShort, name: 'Short name' }) || name.replace(/[^A-Za-z]/g, '').slice(0, 3)).toUpperCase();
  const color = /^#[0-9a-fA-F]{6}$/.test(b.color || '') ? b.color : '#1f7a4d';
  return { name, short, color, city: str(b.city, { max: 60 }) };
}
r.post('/api/admin/teams', requireAdmin, async req => {
  const t = teamBody(req.body);
  const { lastId } = await db.run('INSERT INTO teams (name, short_name, city, color, created_at) VALUES (?, ?, ?, ?, ?)', [t.name, t.short, t.city, t.color, now()]);
  await audit(req, 'team.create', t.name);
  return { id: lastId };
});
r.put('/api/admin/teams/:id', requireAdmin, async req => {
  const t = teamBody(req.body, true);
  await db.run('UPDATE teams SET name = ?, short_name = ?, city = ?, color = ? WHERE id = ?', [t.name, t.short, t.city, t.color, id(req)]);
  await audit(req, 'team.update', `#${id(req)} ${t.name}`);
});
r.delete('/api/admin/teams/:id', requireAdmin, async req => {
  const used = await db.get('SELECT COUNT(*) AS n FROM matches WHERE team1_id = ? OR team2_id = ?', [id(req), id(req)]);
  if (Number(used.n)) throw bad('This team has matches - delete its matches first');
  await db.run('UPDATE players SET team_id = NULL WHERE team_id = ?', [id(req)]);
  await db.run('DELETE FROM teams WHERE id = ?', [id(req)]);
  await audit(req, 'team.delete', `#${id(req)}`);
});

// ---------------------------------------------------------------- admin: players
r.get('/api/admin/players', requireAdmin, async () => db.all(`SELECT p.id, p.first_name, p.last_name, p.email, p.phone, p.city, p.state, p.dob,
    p.role, p.batting_style, p.bowling_style, p.jersey_no, p.team_id, t.name AS team_name FROM players p LEFT JOIN teams t ON t.id = p.team_id ORDER BY p.id DESC`));

r.post('/api/admin/players', requireAdmin, async req => {
  const f = playerFields(req.body);
  f.team_id = int(req.body.team_id, { min: 1 });
  if (f.email && await db.get('SELECT id FROM players WHERE email = ?', [f.email])) throw bad('This email is already registered');
  const cols = Object.keys(f);
  if (f.email) f.email = checkEmailFormat(f.email);
  const pw = req.body.password ? hashPassword(checkPolicy(req.body.password, [f.email, f.first_name, f.last_name])) : null;
  const { lastId } = await db.run(`INSERT INTO players (${cols.join(', ')}, password_hash, created_at) VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`,
    [...cols.map(c => f[c]), pw, now()]);
  if (f.team_id) await notify.follow(lastId, f.team_id);
  await audit(req, 'player.create', `${f.first_name} ${f.last_name}`);
  return { id: lastId };
});
r.put('/api/admin/players/:id', requireAdmin, async req => {
  const f = playerFields(req.body);
  f.team_id = int(req.body.team_id, { min: 1 });
  const cols = Object.keys(f);
  await db.run(`UPDATE players SET ${cols.map(c => c + ' = ?').join(', ')} WHERE id = ?`, [...cols.map(c => f[c]), id(req)]);
  if (f.team_id) await notify.follow(id(req), f.team_id);
  await audit(req, 'player.update', `#${id(req)} ${f.first_name} ${f.last_name}`);
});
r.delete('/api/admin/players/:id', requireAdmin, async req => {
  const used = await db.get('SELECT COUNT(*) AS n FROM match_players WHERE player_id = ?', [id(req)]);
  if (Number(used.n)) throw bad('This player has played matches - remove them from the team instead');
  await db.run('DELETE FROM players WHERE id = ?', [id(req)]);
  await audit(req, 'player.delete', `#${id(req)}`);
});

// ---------------------------------------------------------------- admin: tournaments
function tourBody(b) {
  const start = date(b.start_date, 'Start date'), end = date(b.end_date, 'End date');
  if (start && end && end < start) throw bad('End date must be after the start date');
  return [str(b.name, { max: 80, required: true, name: 'Tournament name' }), str(b.organizer, { max: 80 }), str(b.venue, { max: 80 }),
    start, end, int(b.overs, { min: 1, max: 50, required: true, name: 'Overs' })];
}
async function setTournamentTeams(tid, teamIds) {
  if (!Array.isArray(teamIds)) return;
  await db.run('DELETE FROM tournament_teams WHERE tournament_id = ?', [tid]);
  for (const t of [...new Set(teamIds.map(Number))]) await db.run('INSERT INTO tournament_teams (tournament_id, team_id) VALUES (?, ?)', [tid, t]);
}
r.post('/api/admin/tournaments', requireAdmin, async req => {
  const v = tourBody(req.body);
  const { lastId } = await db.run(`INSERT INTO tournaments (name, organizer, venue, start_date, end_date, overs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [...v, now()]);
  await setTournamentTeams(lastId, req.body.team_ids);
  await audit(req, 'tournament.create', v[0]);
  return { id: lastId };
});
r.put('/api/admin/tournaments/:id', requireAdmin, async req => {
  const v = tourBody(req.body);
  await db.run(`UPDATE tournaments SET name = ?, organizer = ?, venue = ?, start_date = ?, end_date = ?, overs = ? WHERE id = ?`, [...v, id(req)]);
  await setTournamentTeams(id(req), req.body.team_ids);
  await audit(req, 'tournament.update', `#${id(req)} ${v[0]}`);
});
r.get('/api/admin/tournaments/:id/teams', requireAdmin, async req =>
  (await db.all('SELECT team_id FROM tournament_teams WHERE tournament_id = ?', [id(req)])).map(x => x.team_id));
r.delete('/api/admin/tournaments/:id', requireAdmin, async req => {
  await db.run('DELETE FROM tournaments WHERE id = ?', [id(req)]);
  await audit(req, 'tournament.delete', `#${id(req)}`);
});

// round-robin fixtures: every team plays every other team once, one match per day
r.post('/api/admin/tournaments/:id/fixtures', requireAdmin, async req => {
  const t = await db.get('SELECT * FROM tournaments WHERE id = ?', [id(req)]);
  if (!t) throw new HttpError(404, 'Tournament not found');
  const teams = (await db.all('SELECT team_id FROM tournament_teams WHERE tournament_id = ? ORDER BY team_id', [t.id])).map(x => x.team_id);
  if (teams.length < 2) throw bad('Add at least 2 teams to the tournament first');
  const existing = await db.all('SELECT team1_id, team2_id FROM matches WHERE tournament_id = ?', [t.id]);
  const has = (a, b) => existing.some(e => (e.team1_id === a && e.team2_id === b) || (e.team1_id === b && e.team2_id === a));
  let created = 0;
  const start = t.start_date ? new Date(String(t.start_date).slice(0, 10) + 'T13:00:00') : new Date();
  for (let i = 0; i < teams.length; i++) for (let j = i + 1; j < teams.length; j++) {
    if (has(teams[i], teams[j])) continue;
    const d = new Date(start.getTime() + created * 24 * 3600 * 1000);
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 13:00:00`;
    const { lastId } = await db.run(`INSERT INTO matches (tournament_id, team1_id, team2_id, venue, match_date, overs, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
      [t.id, teams[i], teams[j], t.venue, ds, t.overs, now(), now()]);
    await notify.fixtureAdded(lastId);
    created++;
  }
  await audit(req, 'fixtures.generate', `${t.name}: ${created} matches`);
  return { created };
});

// ---------------------------------------------------------------- admin: matches / fixtures
function matchBody(b) {
  const t1 = int(b.team1_id, { min: 1, required: true, name: 'Team 1' }), t2 = int(b.team2_id, { min: 1, required: true, name: 'Team 2' });
  if (t1 === t2) throw bad('Choose two different teams');
  return { t1, t2, tid: int(b.tournament_id, { min: 1 }), overs: int(b.overs, { min: 1, max: 50, name: 'Overs' }), venue: str(b.venue, { max: 80 }), date: date(b.match_date, 'Match date') };
}
r.post('/api/admin/matches', requireAdmin, async req => {
  const v = matchBody(req.body);
  if (!v.overs && v.tid) v.overs = (await db.get('SELECT overs FROM tournaments WHERE id = ?', [v.tid]) || {}).overs;
  const { lastId } = await db.run(`INSERT INTO matches (tournament_id, team1_id, team2_id, venue, match_date, overs, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
    [v.tid, v.t1, v.t2, v.venue, v.date || now(), v.overs || 20, now(), now()]);
  await notify.fixtureAdded(lastId);
  await audit(req, 'match.create', `#${lastId}`);
  return { id: lastId };
});

// edit / reschedule a fixture (teams and overs only before it starts)
r.put('/api/admin/matches/:id', requireAdmin, async req => {
  const m = await db.get('SELECT * FROM matches WHERE id = ?', [id(req)]);
  if (!m) throw new HttpError(404, 'Match not found');
  // fields that are not sent keep their current value
  const v = matchBody({ team1_id: m.team1_id, team2_id: m.team2_id, tournament_id: m.tournament_id, venue: m.venue, overs: m.overs, ...req.body });
  if (m.status !== 'scheduled' && (v.t1 !== m.team1_id || v.t2 !== m.team2_id || (v.overs && v.overs !== m.overs))) throw bad('Teams and overs can only be changed before the match starts');
  await db.run('UPDATE matches SET tournament_id = ?, team1_id = ?, team2_id = ?, venue = ?, match_date = ?, overs = ?, updated_at = ? WHERE id = ?',
    [v.tid, v.t1, v.t2, v.venue, v.date || m.match_date, v.overs || m.overs, now(), m.id]);
  if (v.date && String(v.date) !== String(m.match_date)) {
    await notify.dispatch([{ kind: 'fixture', match_id: m.id, team_ids: [v.t1, v.t2], link: `/match.html?id=${m.id}`, title: 'Fixture rescheduled', body: `New date/time: ${v.date.slice(0, 16)}${v.venue ? ' at ' + v.venue : ''}` }]);
  }
  await audit(req, 'match.update', `#${m.id}`);
  return broadcast(m.id, []);
});

// abandon (rain / bad light): no result, 1 point each
r.post('/api/admin/matches/:id/abandon', requireAdmin, async req => {
  const m = await db.get('SELECT * FROM matches WHERE id = ?', [id(req)]);
  if (!m) throw new HttpError(404, 'Match not found');
  if (!['scheduled', 'live'].includes(m.status)) throw bad('Only scheduled or live matches can be abandoned');
  const reason = str(req.body.reason, { max: 60 }) || 'rain';
  await db.run(`UPDATE matches SET status = 'abandoned', result_text = ?, winner_team_id = NULL, updated_at = ? WHERE id = ?`, [`Match abandoned (${reason}) - no result`, now(), m.id]);
  await db.run(`UPDATE innings SET status = 'completed', striker_id = NULL, non_striker_id = NULL, bowler_id = NULL WHERE match_id = ?`, [m.id]);
  await audit(req, 'match.abandon', `#${m.id} ${reason}`);
  const s = await broadcast(m.id, []);
  await notify.dispatch([{ kind: 'abandoned', match_id: m.id, team_ids: [m.team1_id, m.team2_id], link: `/match.html?id=${m.id}`, title: `Abandoned: ${s.team1.name} v ${s.team2.name}`, body: s.result_text }]);
  return s;
});

r.delete('/api/admin/matches/:id', requireAdmin, async req => {
  const m = await db.get('SELECT * FROM matches WHERE id = ?', [id(req)]);
  if (!m) throw new HttpError(404, 'Match not found');
  const players = (await db.all('SELECT player_id FROM match_players WHERE match_id = ?', [m.id])).map(x => x.player_id);
  await db.run('DELETE FROM matches WHERE id = ?', [m.id]);
  if (players.length) { await engine.refreshPlayerStats(players); live.publishStats(players); }
  await audit(req, 'match.delete', `#${m.id}`);
});

// ---- live scoring (admin AND scorer) - pushed to all viewers instantly
const action = (fn, name, alerts = true) => async req => {
  const matchId = id(req);
  const prev = alerts ? await state.matchState(matchId) : null;
  const affected = await fn(matchId, req.body);
  if (name !== 'ball') await audit(req, 'score.' + name, `match #${matchId}`);
  return broadcast(matchId, Array.isArray(affected) ? affected : [], prev);
};
r.post('/api/admin/matches/:id/start', requireStaff, action(engine.startMatch, 'start'));
r.post('/api/admin/matches/:id/batsmen', requireStaff, action(engine.setBatsmen, 'batsmen', false));
r.post('/api/admin/matches/:id/bowler', requireStaff, action(engine.setBowler, 'bowler', false));
r.post('/api/admin/matches/:id/ball', requireStaff, action(engine.recordBall, 'ball'));
r.post('/api/admin/matches/:id/undo', requireStaff, action(engine.undoLastBall, 'undo', false));
r.post('/api/admin/matches/:id/swap', requireStaff, action(engine.swapStrike, 'swap', false));
r.post('/api/admin/matches/:id/end-innings', requireStaff, action(engine.endInnings, 'end-innings'));

// ---------------------------------------------------------------- admin: staff accounts + audit
r.get('/api/admin/admins', requireAdmin, async () => db.all('SELECT id, name, username, email, role, created_at FROM admins ORDER BY id'));
r.post('/api/admin/admins', requireAdmin, async req => {
  const role = ROLES.includes(req.body.role) ? req.body.role : 'scorer';
  const name = str(req.body.name, { max: 100, required: true, name: 'Name' }), username = str(req.body.username, { max: 50, required: true, name: 'Username' });
  if (!/^[A-Za-z0-9_.-]{3,50}$/.test(username)) throw bad('Username: 3-50 letters, numbers, dot, dash or underscore');
  const email = checkEmailFormat(req.body.email);
  const pw = checkPolicy(req.body.password, [username, email, name]);
  const { lastId } = await db.run('INSERT INTO admins (name, username, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)', [name, username, email, hashPassword(pw), role, now()]);
  await audit(req, 'staff.create', `${username} (${role})`);
  return { id: lastId };
});
r.put('/api/admin/admins/:id', requireAdmin, async req => {
  const email = checkEmailFormat(req.body.email);
  await db.run('UPDATE admins SET email = ? WHERE id = ?', [email, id(req)]);
  await audit(req, 'staff.email', `#${id(req)}`);
});
r.delete('/api/admin/admins/:id', requireAdmin, async req => {
  if (id(req) === req.session.admin.id) throw bad('You cannot delete yourself');
  await db.run('DELETE FROM admins WHERE id = ?', [id(req)]);
  await db.run('DELETE FROM sessions WHERE data LIKE ?', [`%"admin":{"id":${id(req)},%`]);
  await audit(req, 'staff.delete', `#${id(req)}`);
});
r.get('/api/admin/audit', requireAdmin, async () => db.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200'));

module.exports = r;
