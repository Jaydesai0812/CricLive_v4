const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = msg => new HttpError(400, msg);

function pad(n) { return String(n).padStart(2, '0'); }
function now() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const overs = balls => `${Math.floor(balls / 6)}.${balls % 6}`;
const rate = (runs, balls) => (balls ? (runs * 6 / balls).toFixed(2) : '0.00');
const sr = (runs, balls) => (balls ? (runs * 100 / balls).toFixed(1) : '0.0');

// ---- passwords (scrypt, built into Node - no packages needed) ----
// stored as  scrypt2$<cost>$<salt>$<hash>   (older  scrypt$<salt>$<hash>  still works)
const SCRYPT_N = 32768;
const scrypt = (pw, salt, N) => crypto.scryptSync(String(pw), salt, 32, { N, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt2$${SCRYPT_N}$${salt}$${scrypt(pw, salt, SCRYPT_N).toString('hex')}`;
}
const DUMMY = hashPassword('timing-equaliser');
function checkPassword(pw, stored) {
  // an unknown account still runs one hash, so response time does not reveal which accounts exist
  if (!stored) { checkPassword(pw, DUMMY); return false; }
  let N = 16384, salt, hash;
  if (stored.startsWith('scrypt2$')) [, N, salt, hash] = stored.split('$');
  else if (stored.startsWith('scrypt$')) [, salt, hash] = stored.split('$');
  else return false;
  const test = scrypt(pw, salt, Number(N));
  const want = Buffer.from(hash, 'hex');
  return want.length === test.length && crypto.timingSafeEqual(test, want);
}

// ---- input helpers ----
function str(v, { max = 100, required = false, name = 'Field' } = {}) {
  const s = v == null ? '' : String(v).trim();
  if (required && !s) throw bad(`${name} is required`);
  if (s.length > max) throw bad(`${name} is too long (max ${max})`);
  return s || null;
}
function int(v, { min = -Infinity, max = Infinity, required = false, name = 'Value' } = {}) {
  if (v === '' || v == null) { if (required) throw bad(`${name} is required`); return null; }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} must be a whole number${min > -Infinity ? ` from ${min}` : ''}${max < Infinity ? ` to ${max}` : ''}`);
  return n;
}
function date(v, name = 'Date') {
  if (!v) return null;
  const s = String(v).trim().replace('T', ' ');
  if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(s)) throw bad(`${name} is not a valid date`);
  return s.length === 16 ? s + ':00' : s;
}

// ---- strong password policy (the same rules are shown live on the sign-up page) ----
const COMMON = new Set(['password', 'passw0rd', 'qwerty', 'qwertyuiop', 'asdfgh', 'zxcvbn', 'letmein', 'welcome', 'admin', 'administrator',
  'iloveyou', 'monkey', 'dragon', 'football', 'baseball', 'cricket', 'sunshine', 'princess', 'master', 'shadow', 'superman', 'batman',
  'trustno', 'secret', 'login', 'abc', 'abcdef', 'changeme', 'default', 'test', 'guest', 'user', 'pass', 'criclive', 'summer', 'winter',
  'london', 'freedom', 'whatever', 'starwars', 'pokemon', 'liverpool', 'arsenal', 'chelsea', 'manutd', 'india', 'pakistan', 'england']);
function passwordProblems(pw, personal = []) {
  const s = String(pw || '');
  const p = [];
  if (s.length < 10) p.push('at least 10 characters');
  if (s.length > 128) p.push('no more than 128 characters');
  if (!/[a-z]/.test(s)) p.push('a lowercase letter');
  if (!/[A-Z]/.test(s)) p.push('a capital letter');
  if (!/[0-9]/.test(s)) p.push('a number');
  if (!/[^A-Za-z0-9]/.test(s)) p.push('a symbol such as ! # @ ?');
  const low = s.toLowerCase();
  if (COMMON.has(low.replace(/[^a-z]/g, '')) || /^(.)\1+$/.test(s)) p.push('not a common password');
  if (/(.)\1\1\1/.test(s) || /(0123|1234|2345|3456|4567|5678|6789|abcd|bcde|qwer|asdf)/.test(low)) p.push('no runs like 1234, abcd or aaaa');
  const parts = personal.flatMap(w => String(w || '').toLowerCase().split('@')[0].split(/[^a-z0-9]+/)).filter(w => w.length >= 3);
  if (parts.some(w => low.includes(w))) p.push('not your name, username or email');
  return p;
}
function checkPolicy(pw, personal = []) {
  const p = passwordProblems(pw, personal);
  if (p.length) throw bad('Password is not strong enough. It needs ' + p.join(', ') + '.');
  return String(pw);
}

// ---- email checks: real format, common typos, throw-away services, and a working mail domain ----
const POPULAR = ['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com',
  'live.co.uk', 'icloud.com', 'me.com', 'aol.com', 'btinternet.com', 'sky.com', 'protonmail.com', 'proton.me', 'msn.com', 'ymail.com'];
const DISPOSABLE = new Set(['mailinator.com', '10minutemail.com', 'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com', 'yopmail.com',
  'temp-mail.org', 'tempmail.com', 'trashmail.com', 'getnada.com', 'dispostable.com', 'throwawaymail.com', 'maildrop.cc', 'fakeinbox.com',
  'mintemail.com', 'mohmal.com', 'emailondeck.com', 'tempail.com', 'mailnesia.com', 'spamgourmet.com']);
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const EMAIL_RE = /^(?!\.)(?!.*\.\.)[a-z0-9._%+-]{1,64}(?<!\.)@(?=.{4,190}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
function checkEmailFormat(v) {
  const e = String(v || '').trim().toLowerCase();
  if (!e) throw bad('Email is required');
  if (!EMAIL_RE.test(e)) throw bad('That is not a real email address. Please enter your real email, for example name@example.com');
  const [local, domain] = e.split('@');
  if (DISPOSABLE.has(domain)) throw bad('Temporary or throw-away email addresses are not allowed. Please use your real email.');
  if (!POPULAR.includes(domain)) {
    const near = POPULAR.find(d => distance(domain, d) <= 2 && Math.abs(domain.length - d.length) <= 2);
    if (near) throw bad(`Did you mean ${local}@${near}? Please check your email address.`);
    if (/\.(con|cmo|ocm|comm|co\.ukk|cpm)$/.test(domain)) throw bad(`"${domain}" looks mistyped. Please check your email address.`);
  }
  return e;
}
// asks DNS whether the domain accepts mail (MX record). Offline -> skipped, never blocks.
async function checkEmailDomain(email) {
  if (String(process.env.EMAIL_MX_CHECK || 'true').toLowerCase() === 'false') return true;
  const domain = email.split('@')[1];
  const dns = require('dns').promises;
  const timeout = new Promise(r => setTimeout(() => r('timeout'), 3000));
  const look = dns.resolveMx(domain).then(m => (m && m.length ? 'ok' : 'none'))
    .catch(e => (['ENOTFOUND', 'ENODATA', 'ESERVFAIL'].includes(e.code) ? 'none' : 'unknown'));
  const r = await Promise.race([look, timeout]);
  if (r === 'none') throw bad(`The email domain "${domain}" does not exist or cannot receive email. Please enter your real email address.`);
  return true;
}

module.exports = { checkPolicy, passwordProblems, checkEmailFormat, checkEmailDomain, HttpError, bad, now, overs, rate, sr, hashPassword, checkPassword, str, int, date };
