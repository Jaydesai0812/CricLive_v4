// =====================================================================
//  Sends e-mail (one-time sign-in codes) with a tiny built-in SMTP client.
//  No packages needed - uses Node's own net / tls modules.
//
//  .env settings (leave SMTP_HOST empty for development mode):
//    SMTP_HOST=smtp.gmail.com   SMTP_PORT=465   SMTP_USER=you@gmail.com
//    SMTP_PASS=<app password>   SMTP_FROM="CricLive <you@gmail.com>"
//  Port 465 = TLS from the start; 587 / 25 = upgraded with STARTTLS.
//
//  Development mode (no SMTP_HOST): the e-mail is printed in the server
//  terminal and the code is also shown on the sign-in screen, so the
//  system can be tried without an e-mail account.
// =====================================================================
const net = require('net');
const tls = require('tls');
const os = require('os');
const crypto = require('crypto');

const cfg = () => ({
  host: (process.env.SMTP_HOST || '').trim(),
  port: Number(process.env.SMTP_PORT || 465),
  user: (process.env.SMTP_USER || '').trim(),
  pass: process.env.SMTP_PASS || '',
  from: (process.env.SMTP_FROM || process.env.SMTP_USER || 'CricLive <no-reply@criclive.local>').trim(),
  secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : Number(process.env.SMTP_PORT || 465) === 465,
  tlsReject: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== 'false',
});
const devMode = () => !cfg().host;

// read one (possibly multi-line) SMTP reply like "250-SIZE\r\n250 OK"
function reader(sock) {
  let buf = '', waiting = null;
  const tryResolve = () => {
    if (!waiting) return;
    const lines = buf.split('\r\n');
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i])) {
        const text = lines.slice(0, i + 1).join('\n');
        buf = lines.slice(i + 1).join('\r\n');
        const w = waiting; waiting = null;
        w.resolve({ code: Number(lines[i].slice(0, 3)), text });
        return;
      }
    }
  };
  const onData = d => { buf += d.toString('utf8'); tryResolve(); };
  sock.on('data', onData);
  return {
    next: () => new Promise((resolve, reject) => { waiting = { resolve, reject }; tryResolve(); }),
    detach: () => sock.removeListener('data', onData),
    fail: e => { if (waiting) { const w = waiting; waiting = null; w.reject(e); } },
  };
}

function connect(c) {
  return new Promise((resolve, reject) => {
    const opts = { host: c.host, port: c.port, servername: c.host, rejectUnauthorized: c.tlsReject };
    const sock = c.secure ? tls.connect(opts, () => resolve(sock)) : net.connect(opts, () => resolve(sock));
    sock.once('error', reject);
    sock.setTimeout(15000, () => sock.destroy(new Error('SMTP server did not answer in time')));
  });
}

const enc = s => '=?UTF-8?B?' + Buffer.from(s).toString('base64') + '?=';
const addr = s => (String(s).match(/<([^>]+)>/) || [null, String(s)])[1].trim();

function buildMessage(c, { to, subject, text, html }) {
  const boundary = 'cl_' + crypto.randomBytes(12).toString('hex');
  const b64 = s => Buffer.from(s).toString('base64').replace(/.{76}/g, '$&\r\n');
  const fromName = (String(c.from).match(/^\s*"?([^"<]+)"?\s*</) || [null, 'CricLive'])[1].trim();
  return [
    `From: ${enc(fromName)} <${addr(c.from)}>`, `To: <${to}>`, `Subject: ${enc(subject)}`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@${addr(c.from).split('@')[1] || 'criclive.local'}>`,
    'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(text),
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(html),
    `--${boundary}--`, '',
  ].join('\r\n');
}

async function smtpSend(mail) {
  const c = cfg();
  let sock = await connect(c);
  let r = reader(sock);
  sock.on('error', e => r.fail(e));
  const expect = async (want, what) => {
    const res = await r.next();
    if (!want.includes(res.code)) throw new Error(`SMTP ${what} failed: ${res.text.split('\n').pop()}`);
    return res;
  };
  const cmd = async (line, want, what) => { sock.write(line + '\r\n'); return expect(want, what || line.split(' ')[0]); };
  try {
    await expect([220], 'greeting');
    const me = os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
    let ehlo = await cmd('EHLO ' + me, [250], 'EHLO');
    if (!c.secure && /STARTTLS/i.test(ehlo.text)) {
      await cmd('STARTTLS', [220]);
      r.detach();
      sock = await new Promise((resolve, reject) => {
        const s = tls.connect({ socket: sock, servername: c.host, rejectUnauthorized: c.tlsReject }, () => resolve(s));
        s.once('error', reject);
      });
      r = reader(sock);
      sock.on('error', e => r.fail(e));
      ehlo = await cmd('EHLO ' + me, [250], 'EHLO');
    }
    if (c.user) {
      if (/AUTH[ =][^\n]*PLAIN/i.test(ehlo.text)) {
        await cmd('AUTH PLAIN ' + Buffer.from(`\0${c.user}\0${c.pass}`).toString('base64'), [235], 'login (AUTH PLAIN)');
      } else {
        await cmd('AUTH LOGIN', [334]);
        await cmd(Buffer.from(c.user).toString('base64'), [334], 'login (username)');
        await cmd(Buffer.from(c.pass).toString('base64'), [235], 'login (password)');
      }
    }
    await cmd(`MAIL FROM:<${addr(c.from)}>`, [250]);
    await cmd(`RCPT TO:<${mail.to}>`, [250, 251]);
    await cmd('DATA', [354]);
    const body = buildMessage(c, mail).split('\r\n').map(l => (l.startsWith('.') ? '.' + l : l)).join('\r\n');
    await cmd(body + '\r\n.', [250], 'sending message');
    sock.write('QUIT\r\n');
  } finally {
    setTimeout(() => sock.destroy(), 200);
  }
}

// public: send an e-mail. Returns { dev: true } when no SMTP server is set up.
async function send(mail) {
  if (devMode()) {
    if (process.env.MAIL_LOG === 'false') return { dev: true };
    const line = '-'.repeat(60);
    console.log(`\n${line}\n  [E-MAIL - development mode, not really sent]\n  To:      ${mail.to}\n  Subject: ${mail.subject}\n\n${mail.text.split('\n').map(l => '  ' + l).join('\n')}\n${line}\n`);
    return { dev: true };
  }
  await smtpSend(mail);
  return { dev: false };
}

function otpEmail(code, purpose, name) {
  const what = purpose === 'register' ? 'finish creating your CricLive account' : 'sign in to CricLive';
  const text = `Hi ${name || 'there'},\n\nYour CricLive code is: ${code}\n\nEnter it to ${what}. It works once and expires in 5 minutes.\nIf you did not ask for this code, you can ignore this e-mail - nobody can sign in without it.\n\nCricLive`;
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:460px;margin:auto;padding:24px;color:#15201b">
  <div style="font-size:20px;font-weight:800">Cric<span style="color:#c99300">Live</span></div>
  <p>Hi ${String(name || 'there').replace(/[<>&"]/g, '')},</p>
  <p>Use this code to ${what}:</p>
  <div style="font-size:34px;font-weight:800;letter-spacing:10px;background:#eef4f0;border-radius:12px;padding:16px;text-align:center">${code}</div>
  <p style="color:#5c6b63;font-size:13px">It works once and expires in 5 minutes. If you did not ask for this code, ignore this e-mail - nobody can sign in without it.</p></div>`;
  return { subject: `${code} is your CricLive code`, text, html };
}

module.exports = { send, devMode, otpEmail };
