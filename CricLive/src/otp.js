// =====================================================================
//  One-time passcodes (OTP) - the second step of sign-in and sign-up.
//
//  - 6-digit code from a cryptographically secure random generator
//  - only a salted SHA-256 hash of the code is stored
//  - works once, expires after 5 minutes, 5 wrong tries burn it
//  - new code at most every 30 s, max 3 resends, max 5 codes / 15 min per e-mail
// =====================================================================
const crypto = require('crypto');
const db = require('./db');
const mailer = require('./mailer');
const { HttpError, bad, now } = require('./util');

const TTL = 5 * 60 * 1000;
const RESEND_AFTER = 30 * 1000;
const MAX_TRIES = 5;
const MAX_RESENDS = 3;
const PER_EMAIL_WINDOW = 15 * 60 * 1000;
const PER_EMAIL_MAX = 5;

const secret = () => process.env.SESSION_SECRET || 'criclive';
const hash = (id, code) => crypto.createHash('sha256').update(`${id}:${code}:${secret()}`).digest('hex');
const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const mask = e => { const [l, d] = e.split('@'); return (l.length <= 2 ? l[0] + '*' : l[0] + '*'.repeat(Math.min(6, l.length - 2)) + l.slice(-1)) + '@' + d; };
// development mode shows the code on screen (no e-mail server). OTP_SHOW_CODE=false hides it always.
const showCode = () => mailer.devMode() && String(process.env.OTP_SHOW_CODE || 'true').toLowerCase() !== 'false';

async function deliver(email, code, purpose, name) {
  try { await mailer.send({ to: email, ...mailer.otpEmail(code, purpose, name) }); }
  catch (e) {
    console.error('[mail] could not send code:', e.message);
    throw new HttpError(502, 'We could not send the code e-mail. Please try again in a minute.');
  }
}
const reply = (row, code) => ({
  challenge: row.id, email: mask(row.email), expires_in: Math.round(TTL / 1000), resend_in: Math.round(RESEND_AFTER / 1000),
  ...(showCode() ? { dev_code: code, dev_note: 'Development mode: no e-mail server is set up, so the code is shown here. Add SMTP settings to .env to send real e-mails.' } : {}),
});

async function create({ purpose, account = null, accountId = null, email, payload = null, name = '', ip = '' }) {
  const since = Date.now() - PER_EMAIL_WINDOW;
  const recent = await db.get('SELECT COUNT(*) AS n FROM otp_codes WHERE email = ? AND last_sent > ?', [email, since]);
  if (Number(recent.n) >= PER_EMAIL_MAX) throw new HttpError(429, 'Too many codes were requested for this e-mail. Please wait 15 minutes and try again.');
  const id = crypto.randomBytes(24).toString('hex');
  const code = newCode();
  const t = Date.now();
  await db.run(`INSERT INTO otp_codes (id, purpose, account, account_id, email, code_hash, payload, attempts, resends, last_sent, expires_at, used, ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0, ?, ?)`, [id, purpose, account, accountId, email, hash(id, code), payload ? JSON.stringify(payload) : null, t, t + TTL, ip, now()]);
  await db.run('DELETE FROM otp_codes WHERE expires_at < ?', [t - 24 * 3600 * 1000]);
  await deliver(email, code, purpose, name);
  return reply({ id, email }, code);
}

async function load(id) {
  const row = id && /^[a-f0-9]{48}$/.test(String(id)) ? await db.get('SELECT * FROM otp_codes WHERE id = ?', [String(id)]) : null;
  if (!row || Number(row.used)) throw bad('This sign-in step has finished. Please start again.');
  if (Number(row.expires_at) < Date.now()) throw bad('This code has expired. Press "Send a new code".');
  if (Number(row.attempts) >= MAX_TRIES) throw bad('Too many wrong codes. Please start again.');
  return row;
}

// returns the challenge row (with parsed payload) when the code is right
async function verify(id, code) {
  const row = await load(id);
  const c = String(code || '').replace(/\D/g, '');
  const ok = c.length === 6 && crypto.timingSafeEqual(Buffer.from(hash(row.id, c)), Buffer.from(row.code_hash));
  if (!ok) {
    await db.run('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', [row.id]);
    const left = MAX_TRIES - Number(row.attempts) - 1;
    throw bad(left > 0 ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong codes. Please start again.');
  }
  const r = await db.run('UPDATE otp_codes SET used = 1 WHERE id = ? AND used = 0', [row.id]);
  if (!r.changes) throw bad('This code was already used. Please start again.');
  return { ...row, payload: row.payload ? JSON.parse(row.payload) : null };
}

async function resend(id) {
  const row = await load(id);
  const wait = Number(row.last_sent) + RESEND_AFTER - Date.now();
  if (wait > 0) throw new HttpError(429, `Please wait ${Math.ceil(wait / 1000)} seconds before asking for a new code.`);
  if (Number(row.resends) >= MAX_RESENDS) throw new HttpError(429, 'No more new codes for this attempt. Please start again.');
  const code = newCode(), t = Date.now();
  await db.run('UPDATE otp_codes SET code_hash = ?, attempts = 0, resends = resends + 1, last_sent = ?, expires_at = ? WHERE id = ?',
    [hash(row.id, code), t, t + TTL, row.id]);
  const name = row.payload ? (JSON.parse(row.payload).first_name || '') : '';
  await deliver(row.email, code, row.purpose, name);
  return reply(row, code);
}

module.exports = { create, verify, resend, mask };
