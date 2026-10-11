// =====================================================================
//  CricLive automated tests  ->  run with:  npm test
//  Uses Node's built-in test runner and a throw-away SQLite database.
// =====================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'criclive-test-'));
process.env.DB_CLIENT = 'sqlite';
process.env.SQLITE_FILE = path.join(TMP, 'test.db');
process.env.EMAIL_MX_CHECK = 'false';      // no DNS lookups in tests
process.env.SESSION_SECRET = 'test-secret';
process.env.MAIL_LOG = 'false';
delete process.env.SMTP_HOST;              // development mode: codes come back in the response

const db = require('../src/db');
const engine = require('../src/engine');
const state = require('../src/state');
const analytics = require('../src/analytics');
const { hashPassword, now, passwordProblems, checkEmailFormat } = require('../src/util');

let teamA, teamB, A = [], Bp = [];

async function makeTeams() {
  teamA = (await db.run(`INSERT INTO teams (name, short_name, created_at) VALUES ('Test Alpha', 'ALP', ?)`, [now()])).lastId;
  teamB = (await db.run(`INSERT INTO teams (name, short_name, created_at) VALUES ('Test Bravo', 'BRV', ?)`, [now()])).lastId;
  for (let i = 0; i < 11; i++) {
    A.push((await db.run(`INSERT INTO players (first_name, last_name, role, team_id) VALUES (?, 'Alpha', 'Batsman', ?)`, ['A' + i, teamA])).lastId);
    Bp.push((await db.run(`INSERT INTO players (first_name, last_name, role, team_id) VALUES (?, 'Bravo', 'Bowler', ?)`, ['B' + i, teamB])).lastId);
  }
}
async function newMatch(overs = 2, tid = null) {
  return (await db.run(`INSERT INTO matches (tournament_id, team1_id, team2_id, overs, status, match_date, created_at, updated_at) VALUES (?, ?, ?, ?, 'scheduled', ?, ?, ?)`,
    [tid, teamA, teamB, overs, now(), now(), now()])).lastId;
}
const inn = async (m, no) => db.get('SELECT * FROM innings WHERE match_id = ? AND innings_no = ?', [m, no]);

test.before(async () => { await db.connect(); await makeTeams(); });
test.after(async () => { await db.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('extras, strike rotation and end of over', async () => {
  const m = await newMatch();
  await engine.startMatch(m, { toss_winner_id: teamA, toss_decision: 'bat', team1_xi: A, team2_xi: Bp });
  await engine.setBatsmen(m, { striker_id: A[0], non_striker_id: A[1] });
  await engine.setBowler(m, { bowler_id: Bp[10] });
  await engine.recordBall(m, { runs: 1 });                 // A0 1 -> A1 on strike
  let i = await inn(m, 1);
  assert.equal(i.striker_id, A[1]);
  await engine.recordBall(m, { runs: 0, extra: 'wd' });    // wide: +1, not a legal ball
  await engine.recordBall(m, { runs: 4, extra: 'nb' });    // no-ball: +1 +4 to batter, not legal
  await engine.recordBall(m, { runs: 2, extra: 'lb' });    // leg-byes: legal, not charged to bowler
  i = await inn(m, 1);
  assert.equal(i.runs, 1 + 1 + 5 + 2);
  assert.equal(i.legal_balls, 2);
  assert.equal(i.extras, 1 + 1 + 2);
  const bw = await db.get('SELECT * FROM bowling_scores WHERE innings_id = ? AND player_id = ?', [i.id, Bp[10]]);
  assert.equal(bw.runs, 1 + 1 + 5, 'leg-byes are not charged to the bowler');
  const bt = await db.get('SELECT * FROM batting_scores WHERE innings_id = ? AND player_id = ?', [i.id, A[1]]);
  assert.deepEqual([bt.runs, bt.balls, bt.fours], [4, 2, 1], 'wides are not balls faced; no-ball is');
  for (let k = 0; k < 4; k++) await engine.recordBall(m, { runs: 0 });
  i = await inn(m, 1);
  assert.equal(i.legal_balls, 6);
  assert.equal(i.bowler_id, null, 'new bowler needed after 6 legal balls');
  assert.equal(i.striker_id, A[0], 'strike changes at the end of the over');
  await assert.rejects(engine.setBowler(m, { bowler_id: Bp[10] }), /two overs in a row/);
});

test('wickets, innings change, target and result', async () => {
  const m = await newMatch(1);
  const a3 = A.slice(0, 3), b3 = Bp.slice(0, 3);
  await engine.startMatch(m, { toss_winner_id: teamA, toss_decision: 'bat', team1_xi: a3, team2_xi: b3 });
  await engine.setBatsmen(m, { striker_id: a3[0], non_striker_id: a3[1] });
  await engine.setBowler(m, { bowler_id: b3[2] });
  await engine.recordBall(m, { runs: 6 });
  await assert.rejects(engine.recordBall(m, { runs: 0, wicket: { type: 'caught' } }), /fielder/);
  await engine.recordBall(m, { runs: 0, wicket: { type: 'caught', fielder_id: b3[0] } });
  await engine.setBatsmen(m, { striker_id: a3[2] });
  await engine.recordBall(m, { runs: 0, wicket: { type: 'bowled' } }); // 3-man XI -> all out after 2
  const i1 = await inn(m, 1), i2 = await inn(m, 2);
  assert.equal(i1.status, 'completed');
  assert.equal(i2.target, 7);
  await engine.setBatsmen(m, { striker_id: b3[0], non_striker_id: b3[1] });
  await engine.setBowler(m, { bowler_id: a3[2] });
  await engine.recordBall(m, { runs: 4 });
  await engine.recordBall(m, { runs: 3 });
  const mm = await db.get('SELECT * FROM matches WHERE id = ?', [m]);
  assert.equal(mm.status, 'completed');
  assert.equal(mm.winner_team_id, teamB);
  assert.match(mm.result_text, /won by 2 wickets/);
  // undo re-opens the match
  await engine.undoLastBall(m);
  assert.equal((await db.get('SELECT status FROM matches WHERE id = ?', [m])).status, 'live');
  assert.equal((await inn(m, 2)).runs, 4);
});

test('player career stats are updated from every ball', async () => {
  const s = await db.get('SELECT * FROM player_stats WHERE player_id = ?', [A[0]]);
  assert.ok(s.matches >= 2);
  assert.ok(s.runs >= 7);
  const p = await state.playerProfile(A[0]);
  assert.equal(p.batting.runs, s.runs);
});

test('points table: win = 2, abandoned = 1 each, NRR computed', async () => {
  const t = (await db.run(`INSERT INTO tournaments (name, overs) VALUES ('Test Cup', 1)`)).lastId;
  await db.run('INSERT INTO tournament_teams (tournament_id, team_id) VALUES (?, ?), (?, ?)', [t, teamA, t, teamB]);
  const m = await newMatch(1, t);
  await engine.startMatch(m, { toss_winner_id: teamA, toss_decision: 'bat', team1_xi: A, team2_xi: Bp });
  await engine.setBatsmen(m, { striker_id: A[0], non_striker_id: A[1] });
  await engine.setBowler(m, { bowler_id: Bp[0] });
  for (let k = 0; k < 6; k++) await engine.recordBall(m, { runs: 2 });      // 12/0
  await engine.setBatsmen(m, { striker_id: Bp[0], non_striker_id: Bp[1] });
  await engine.setBowler(m, { bowler_id: A[0] });
  for (let k = 0; k < 6; k++) await engine.recordBall(m, { runs: 1 });      // 6/0 -> A wins by 6
  const ab = await newMatch(1, t);
  await db.run(`UPDATE matches SET status = 'abandoned' WHERE id = ?`, [ab]);
  const { table } = await state.pointsTable(t);
  const a = table.find(r => r.team.id === teamA), b = table.find(r => r.team.id === teamB);
  assert.deepEqual([a.played, a.won, a.nr, a.points], [2, 1, 1, 3]);
  assert.deepEqual([b.played, b.lost, b.points], [2, 1, 1]);
  assert.equal(a.nrr, '+6.000');
});

test('K-Means: deterministic and separates clear groups', () => {
  const X = [];
  for (let i = 0; i < 10; i++) X.push([0 + (i % 3) * 0.1, 0]);
  for (let i = 0; i < 10; i++) X.push([5 + (i % 3) * 0.1, 5]);
  const r1 = analytics.kmeans(X, 2), r2 = analytics.kmeans(X, 2);
  assert.deepEqual(r1.labels, r2.labels, 'same seed -> same result');
  assert.equal(new Set(r1.labels.slice(0, 10)).size, 1);
  assert.notEqual(r1.labels[0], r1.labels[10]);
});

// ---------------------------------------------------------------- HTTP / security
let server, base;
async function req(method, p, body, headers = {}) {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* */ }
  return { status: r.status, body: j, cookie: (r.headers.get('set-cookie') || '').split(';')[0], headers: r.headers };
}

// sign in = password, then the 6-digit code (in development mode the code is returned)
async function signIn(kind, who, pw) {
  const r1 = await req('POST', kind === 'admin' ? '/api/auth/admin/login' : '/api/auth/player/login', kind === 'admin' ? { username: who, password: pw } : { email: who, password: pw });
  if (r1.status !== 200) return r1;
  assert.equal(r1.cookie, '', 'no session is created before the code is entered');
  return req('POST', '/api/auth/otp/verify', { challenge: r1.body.otp.challenge, code: r1.body.otp.dev_code });
}

test('HTTP: security headers, RBAC, CSRF, lockout', async () => {
  await db.run('INSERT INTO admins (name, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?)', ['Admin', 'admin', 'admin@club.test', hashPassword('Boundary#Six2026'), 'admin']);
  await db.run('INSERT INTO admins (name, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?)', ['Scorer', 'scorer', 'scorer@club.test', hashPassword('Yorker#Pace2026'), 'scorer']);
  const { createApp } = require('../src/http');
  server = http.createServer(createApp(require('../src/routes'), path.join(__dirname, '..', 'public')));
  await new Promise(r => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port;
  const home = await req('GET', '/api/home');
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(home.headers.get('cross-origin-opener-policy'), 'same-origin');

  assert.equal((await req('POST', '/api/admin/teams', { name: 'X' })).status, 401, 'anonymous blocked');
  const sc = await signIn('admin', 'scorer', 'Yorker#Pace2026');
  assert.equal(sc.status, 200);
  assert.match(sc.headers.get('set-cookie'), /HttpOnly/);
  assert.match(sc.headers.get('set-cookie'), /SameSite=Lax/);
  assert.equal((await req('POST', '/api/admin/teams', { name: 'X' }, { cookie: sc.cookie })).status, 403, 'scorer cannot manage teams');
  const ad = await signIn('admin', 'admin', 'Boundary#Six2026');
  assert.equal((await req('POST', '/api/admin/teams', { name: 'New Team' }, { cookie: ad.cookie })).status, 200, 'admin can');
  assert.equal((await req('POST', '/api/admin/teams', { name: 'Evil' }, { cookie: ad.cookie, origin: 'http://evil.example' })).status, 403, 'cross-site blocked');
  const audit = await req('GET', '/api/admin/audit', null, { cookie: ad.cookie });
  assert.ok(audit.body.some(a => a.action === 'team.create'), 'action is audited');
  assert.ok(audit.body.some(a => a.action === 'login' && /one-time code/.test(a.details)), 'staff sign-in is audited');
  ADMIN_COOKIE = ad.cookie;

  for (let k = 0; k < 5; k++) await req('POST', '/api/auth/admin/login', { username: 'admin', password: 'wrong' });
  assert.equal((await req('POST', '/api/auth/admin/login', { username: 'admin', password: 'Boundary#Six2026' })).status, 429, 'locked after 5 failures');
});
let ADMIN_COOKIE = '';

test('Sign-in codes (OTP): one use, 5 tries, resend wait, stored only as a hash', async () => {
  await db.run('INSERT INTO players (first_name, last_name, email, password_hash, role, team_id) VALUES (?, ?, ?, ?, ?, ?)', ['Olly', 'Code', 'olly@club.test', hashPassword('Cover#Drive2026'), 'Batsman', teamA]);
  const r1 = await req('POST', '/api/auth/player/login', { email: 'olly@club.test', password: 'Cover#Drive2026' });
  const { challenge, dev_code: code, email } = r1.body.otp;
  assert.match(code, /^\d{6}$/);
  assert.equal(email, 'o**y@club.test', 'e-mail is masked');
  const row = await db.get('SELECT * FROM otp_codes WHERE id = ?', [challenge]);
  assert.ok(!JSON.stringify(row).includes(code), 'the plain code is never stored');
  assert.equal(row.code_hash.length, 64);
  const wrong = String((Number(code) + 1) % 1000000).padStart(6, '0');
  const bad1 = await req('POST', '/api/auth/otp/verify', { challenge, code: wrong });
  assert.equal(bad1.status, 400); assert.match(bad1.body.error, /4 tries left/);
  assert.equal((await req('POST', '/api/auth/otp/resend', { challenge })).status, 429, 'must wait 30 s for a new code');
  const good = await req('POST', '/api/auth/otp/verify', { challenge, code });
  assert.equal(good.status, 200); assert.equal(good.body.player.name, 'Olly Code');
  assert.equal((await req('POST', '/api/auth/otp/verify', { challenge, code })).status, 400, 'a code works only once');
  // five wrong codes burn the challenge, even the right code then fails
  const r2 = await req('POST', '/api/auth/player/login', { email: 'olly@club.test', password: 'Cover#Drive2026' });
  for (let k = 0; k < 5; k++) await req('POST', '/api/auth/otp/verify', { challenge: r2.body.otp.challenge, code: '000000' === r2.body.otp.dev_code ? '111111' : '000000' }, { 'x-test': k });
  const late = await req('POST', '/api/auth/otp/verify', { challenge: r2.body.otp.challenge, code: r2.body.otp.dev_code });
  assert.ok([400, 429].includes(late.status), 'burned after 5 wrong codes');
  // expired code
  const r3 = await req('POST', '/api/auth/player/login', { email: 'olly@club.test', password: 'Cover#Drive2026' });
  await db.run('UPDATE otp_codes SET expires_at = ? WHERE id = ?', [Date.now() - 1, r3.body.otp.challenge]);
  const exp = await req('POST', '/api/auth/otp/verify', { challenge: r3.body.otp.challenge, code: r3.body.otp.dev_code });
  assert.ok(exp.status >= 400 && /expired|Too many/.test(exp.body.error));
  assert.equal((await req('POST', '/api/auth/otp/verify', { challenge: 'not-a-real-id', code: '123456' })).status >= 400, true);
});

test('Strong passwords and real e-mail addresses', async () => {
  assert.ok(passwordProblems('admin123').length >= 3);
  assert.deepEqual(passwordProblems('Cover#Drive2026'), []);
  assert.ok(passwordProblems('Password123!').includes('not a common password'));
  assert.ok(passwordProblems('Abcd#12345xyz').includes('no runs like 1234, abcd or aaaa'));
  assert.ok(passwordProblems('Oliverb#2026x', ['oliver.brown@x.com']).includes('not your name, username or email'));
  assert.throws(() => checkEmailFormat('jay@gmial.com'), /Did you mean jay@gmail.com/);
  assert.throws(() => checkEmailFormat('jay@gmail.con'), /Did you mean/);
  assert.throws(() => checkEmailFormat('jay@mailinator.com'), /throw-away/);
  assert.throws(() => checkEmailFormat('not-an-email'), /not a real email/);
  assert.throws(() => checkEmailFormat('a..b@x.com'), /not a real email/);
  assert.equal(checkEmailFormat(' Jay.Patel@Outlook.com '), 'jay.patel@outlook.com');

  const base = { first_name: 'Will', last_name: 'Player', email: 'will.player@club.test' };
  const weak = await req('POST', '/api/auth/player/register', { ...base, password: 'Goodpass1', password2: 'Goodpass1' });
  assert.equal(weak.status, 400); assert.match(weak.body.error, /not strong enough/);
  const mismatch = await req('POST', '/api/auth/player/register', { ...base, password: 'Pitch#Roller88x', password2: 'Pitch#Roller88y' });
  assert.match(mismatch.body.error, /do not match/);
  const typo = await req('POST', '/api/auth/player/register', { ...base, email: 'will@hotmial.com', password: 'Pitch#Roller88x', password2: 'Pitch#Roller88x' });
  assert.match(typo.body.error, /Did you mean will@hotmail.com/);
  const step1 = await req('POST', '/api/auth/player/register', { ...base, password: 'Pitch#Roller88x', password2: 'Pitch#Roller88x' });
  assert.equal(step1.status, 200);
  assert.equal(await db.get('SELECT id FROM players WHERE email = ?', [base.email]), undefined, 'no account until the code is entered');
  const done = await req('POST', '/api/auth/otp/verify', { challenge: step1.body.otp.challenge, code: step1.body.otp.dev_code });
  assert.equal(done.status, 200); assert.equal(done.body.welcome, true);
  const stored = await db.get('SELECT password_hash FROM players WHERE email = ?', [base.email]);
  assert.match(stored.password_hash, /^scrypt2\$32768\$/, 'password is hashed (scrypt), never stored as text');
  assert.equal((await req('POST', '/api/me/follows/' + teamA, {}, { cookie: done.cookie })).status, 200);
  assert.equal((await req('GET', '/api/me/notifications', null, { cookie: done.cookie })).status, 200);
  // changing the password needs the current one
  const me = (await req('GET', '/api/me', null, { cookie: done.cookie })).body;
  const noCur = await req('PUT', '/api/me', { ...me, password: 'Another#Pass77x', password2: 'Another#Pass77x' }, { cookie: done.cookie });
  assert.match(noCur.body.error, /current password/);
  const withCur = await req('PUT', '/api/me', { ...me, current_password: 'Pitch#Roller88x', password: 'Another#Pass77x', password2: 'Another#Pass77x' }, { cookie: done.cookie });
  assert.equal(withCur.status, 200);
});

test('Downloads: CSV (safe for Excel) and reports with charts', async () => {
  const { csvCell } = require('../src/reports');
  assert.equal(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`, 'formula is neutralised');
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell(-0.5), '-0.5', 'real numbers are untouched');
  assert.equal(csvCell('a,b'), '"a,b"');
  const m = await newMatch(1);
  await engine.startMatch(m, { toss_winner_id: teamA, toss_decision: 'bat', team1_xi: A, team2_xi: Bp });
  await engine.setBatsmen(m, { striker_id: A[0], non_striker_id: A[1] });
  await engine.setBowler(m, { bowler_id: Bp[0] });
  for (const r of [4, 6, 0, 1]) await engine.recordBall(m, { runs: r });
  const csv = await fetch(`${base}/api/matches/${m}/download/balls.csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="criclive-match-/);
  const lines = (await csv.text()).trim().split('\r\n');
  assert.equal(lines.length, 5, 'header + one row per ball');
  assert.match(lines[2], /,6,/);
  const rep = await fetch(`${base}/api/matches/${m}/download/report.html`);
  const html = await rep.text();
  assert.match(html, /<svg/); assert.match(html, /What to work on/); assert.match(html, /Test Alpha v Test Bravo/);
  const prep = await (await fetch(`${base}/api/players/${A[0]}/download/report.html`)).text();
  assert.match(prep, /improvement plan/i); assert.match(prep, /<svg/);
  const pcsv = await (await fetch(`${base}/api/players/${A[0]}/download/matches.csv`)).text();
  assert.match(pcsv, /Opponent/); assert.match(pcsv, /Test Bravo/);
  assert.equal((await fetch(`${base}/api/matches/999999/download/report.html`)).status, 404);
});

test('Contact us / bug reports', async () => {
  const ok = await req('POST', '/api/feedback', { kind: 'bug', name: 'Jay', email: 'jay@gmail.com', message: 'The worm chart overlaps on my phone', page: '/match.html' });
  assert.equal(ok.status, 200); assert.match(ok.body.ref, /^CL-\d{4}$/);
  assert.equal((await req('POST', '/api/feedback', { name: 'Jay', email: 'jay@gmial.com', message: 'Hello there team' })).status, 400, 'e-mail typo caught');
  assert.equal((await req('POST', '/api/feedback', { name: 'Jay', email: 'jay@gmail.com', message: 'short' })).status, 400);
  const bot = await req('POST', '/api/feedback', { name: 'Bot', email: 'b@gmail.com', message: 'spam spam spam', website: 'http://spam' });
  assert.equal(bot.status, 200);
  assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM feedback WHERE name = 'Bot'")).n), 0, 'honeypot: robots are silently ignored');
  for (let k = 0; k < 4; k++) await req('POST', '/api/feedback', { name: 'Jay', email: 'jay@gmail.com', message: 'Another message ' + k });
  assert.equal((await req('POST', '/api/feedback', { name: 'Jay', email: 'jay@gmail.com', message: 'One too many messages' })).status, 429, '5 per hour');
  assert.equal((await req('GET', '/api/admin/feedback')).status, 401);
  const list = await req('GET', '/api/admin/feedback', null, { cookie: ADMIN_COOKIE });
  assert.ok(list.body.length >= 5);
  assert.equal((await req('PUT', '/api/admin/feedback/' + list.body[0].id, { status: 'resolved' }, { cookie: ADMIN_COOKIE })).status, 200);
});

test('E-mail: codes are sent through a real SMTP conversation', async () => {
  const net = require('net');
  const got = { auth: '', data: '' };
  const smtp = net.createServer(sock => {
    let mode = 'cmd', buf = '';
    sock.write('220 test SMTP ready\r\n');
    sock.on('data', d => {
      buf += d.toString();
      if (mode === 'data') { if (buf.includes('\r\n.\r\n')) { got.data = buf; buf = ''; mode = 'cmd'; sock.write('250 queued\r\n'); } return; }
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^EHLO/.test(line)) sock.write('250-test\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^AUTH PLAIN/.test(line)) { got.auth = Buffer.from(line.split(' ')[2], 'base64').toString(); sock.write('235 ok\r\n'); }
        else if (/^(MAIL|RCPT)/.test(line)) sock.write('250 ok\r\n');
        else if (line === 'DATA') { mode = 'data'; sock.write('354 go\r\n'); }
        else if (line === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
      }
    });
  });
  await new Promise(r => smtp.listen(0, '127.0.0.1', r));
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port), SMTP_SECURE: 'false', SMTP_USER: 'mailer@club.test', SMTP_PASS: 'app-pass', SMTP_FROM: 'CricLive <mailer@club.test>' });
  try {
    const r = await req('POST', '/api/auth/player/login', { email: 'olly@club.test', password: 'Cover#Drive2026' });
    assert.equal(r.status, 200);
    assert.equal(r.body.otp.dev_code, undefined, 'with e-mail set up, the code is never shown on screen');
    assert.equal(got.auth, '\0mailer@club.test\0app-pass');
    const body = Buffer.from(got.data.split('Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--')[0].replace(/\r\n/g, ''), 'base64').toString();
    const code = body.match(/code is: (\d{6})/)[1];
    const v = await req('POST', '/api/auth/otp/verify', { challenge: r.body.otp.challenge, code });
    assert.equal(v.status, 200, 'the e-mailed code signs in');
  } finally {
    for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']) delete process.env[k];
    smtp.close(); server.close();
  }
});
