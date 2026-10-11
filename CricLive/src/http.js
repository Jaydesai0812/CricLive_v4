// =====================================================================
//  Tiny web framework on top of Node's built-in http module
//  (router, JSON bodies, cookie sessions stored in the DB, static files)
// =====================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { HttpError } = require('./util');

class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handlers) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handlers });
  }
  get(p, ...h) { this.add('GET', p, h); }
  post(p, ...h) { this.add('POST', p, h); }
  put(p, ...h) { this.add('PUT', p, h); }
  delete(p, ...h) { this.add('DELETE', p, h); }
  find(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (m) return { handlers: r.handlers, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }
}

function sendJson(res, status, data) {
  if (res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 1e6) { reject(new HttpError(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- sessions
const COOKIE = 'criclive_sid';
const TTL = 7 * 24 * 3600 * 1000;

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function loadSession(req) {
  const sid = parseCookies(req)[COOKIE];
  req.session = {}; req.sid = null;
  if (!sid || !/^[a-f0-9]{48,64}$/.test(sid)) return;
  const row = await db.get('SELECT data, expires_at FROM sessions WHERE sid = ?', [sid]);
  if (row && Number(row.expires_at) > Date.now()) { req.session = JSON.parse(row.data); req.sid = sid; }
}

// HTTPS detection: behind a proxy (X-Forwarded-Proto) or COOKIE_SECURE=true in .env
const isHttps = req => process.env.COOKIE_SECURE === 'true' || (req && (req.socket && req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https'));
const cookieFlags = req => `HttpOnly; Path=/; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`;

// a brand-new random session id at every sign-in (stops session fixation)
async function startSession(req, res, data, ttl = TTL) {
  if (req.sid) await db.run('DELETE FROM sessions WHERE sid = ?', [req.sid]);
  const sid = crypto.randomBytes(32).toString('hex');
  await db.run('INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)', [sid, JSON.stringify(data), Date.now() + ttl]);
  await db.run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
  res.setHeader('Set-Cookie', `${COOKIE}=${sid}; ${cookieFlags(req)}; Max-Age=${Math.round(ttl / 1000)}`);
  req.session = data; req.sid = sid;
}

async function endSession(req, res) {
  if (req.sid) await db.run('DELETE FROM sessions WHERE sid = ?', [req.sid]);
  res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieFlags(req)}; Max-Age=0`);
  req.session = {}; req.sid = null;
}

// ---------------------------------------------------------------- static files
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2',
};

function serveStatic(root, req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root)) return false;
  let target = file;
  if (!fs.existsSync(target) && fs.existsSync(target + '.html')) target += '.html';
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
  if (!fs.existsSync(target)) return false;
  res.writeHead(200, { 'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(target).pipe(res);
  return true;
}

// ---------------------------------------------------------------- app
function createApp(router, publicDir) {
  const root = path.resolve(publicDir);
  return async (req, res) => {
    setSecurityHeaders(res, req);
    req.ip = (req.socket && req.socket.remoteAddress || '').replace('::ffff:', '');
    const url = new URL(req.url, 'http://localhost');
    req.query = Object.fromEntries(url.searchParams);
    const pathname = url.pathname;
    try {
      if (pathname.startsWith('/api/')) {
        const match = router.find(req.method, pathname);
        if (!match) throw new HttpError(404, 'API route not found');
        req.params = match.params;
        if (['POST', 'PUT', 'DELETE'].includes(req.method)) checkSameOrigin(req);
        await loadSession(req);
        req.body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {};
        let result;
        for (const h of match.handlers) { result = await h(req, res); if (res.writableEnded || res.headersSent) return; }
        sendJson(res, 200, result === undefined ? { ok: true } : result);
        return;
      }
      if (req.method === 'GET' && serveStatic(root, req, res, pathname)) return;
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<h1>404 - Page not found</h1><a href="/">Go to CricLive home</a>');
    } catch (e) {
      if (!e.status) console.error(e);
      const status = e.status || (e.code === 'SQLITE_CONSTRAINT' || e.code === 'ER_DUP_ENTRY' || /UNIQUE|FOREIGN KEY|Duplicate|foreign key/i.test(e.message) ? 400 : 500);
      let msg = e.status ? e.message : status === 400 ? friendlyDbError(e.message) : 'Server error: ' + e.message;
      sendJson(res, status, { error: msg });
    }
  };
}

// ---------------------------------------------------------------- security
const CSP = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:", "connect-src 'self'", "frame-ancestors 'self'", "base-uri 'self'", "form-action 'self'",
].join('; ');
function setSecurityHeaders(res, req) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

// CSRF protection: state-changing requests must come from this same website
function checkSameOrigin(req) {
  const src = req.headers.origin || req.headers.referer;
  if (!src) return; // non-browser clients (tests, curl)
  let host;
  try { host = new URL(src).host; } catch { throw new HttpError(403, 'Bad origin'); }
  if (host !== req.headers.host) throw new HttpError(403, 'Cross-site request blocked');
}

function friendlyDbError(m) {
  if (/UNIQUE|Duplicate/i.test(m)) return 'That value already exists (must be unique)';
  if (/FOREIGN KEY|foreign key/i.test(m)) return 'This record is used somewhere else and cannot be changed/deleted';
  return m;
}

module.exports = { Router, createApp, startSession, endSession };
