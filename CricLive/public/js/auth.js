// =====================================================================
//  Sign in / create account with a one-time e-mail code (OTP)
//    Auth.mountSignIn(el, { onDone })     password -> 6-digit code
//    Auth.mountRegister(el, { onDone })   details -> 6-digit code -> account
//  Live checks: password strength (same rules as the server) and
//  real-email checks (format, typos like gmial.com, mail domain exists).
// =====================================================================
(function () {
  const POPULAR = ['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com',
    'live.co.uk', 'icloud.com', 'me.com', 'aol.com', 'btinternet.com', 'sky.com', 'protonmail.com', 'proton.me', 'msn.com', 'ymail.com'];
  const EMAIL_RE = /^(?!\.)(?!.*\.\.)[a-z0-9._%+-]{1,64}(?<!\.)@(?=.{4,190}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
  const COMMON = ['password', 'passw0rd', 'qwerty', 'qwertyuiop', 'letmein', 'welcome', 'admin', 'iloveyou', 'monkey', 'dragon', 'football',
    'cricket', 'sunshine', 'princess', 'master', 'secret', 'login', 'changeme', 'criclive', 'summer', 'winter', 'freedom', 'whatever'];

  function dist(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  // quick check in the browser; the server repeats it and also checks the mail domain exists
  function emailHint(v) {
    const e = String(v || '').trim().toLowerCase();
    if (!e) return null;
    if (!EMAIL_RE.test(e)) return { bad: 'That is not a real email address. Please enter your real email, like name@example.com' };
    const [local, domain] = e.split('@');
    if (!POPULAR.includes(domain)) {
      const near = POPULAR.find(d => dist(domain, d) <= 2 && Math.abs(domain.length - d.length) <= 2);
      if (near) return { bad: `Did you mean ${local}@${near}?`, fix: `${local}@${near}` };
    }
    return { ok: true };
  }

  const RULES = [
    ['len', 'At least 10 characters', s => s.length >= 10],
    ['low', 'A lowercase letter', s => /[a-z]/.test(s)],
    ['up', 'A capital letter', s => /[A-Z]/.test(s)],
    ['num', 'A number', s => /[0-9]/.test(s)],
    ['sym', 'A symbol such as ! # @ ?', s => /[^A-Za-z0-9]/.test(s)],
    ['seq', 'No runs like 1234, abcd or aaaa', s => s && !/(.)\1\1\1/.test(s) && !/(0123|1234|2345|3456|4567|5678|6789|abcd|bcde|qwer|asdf)/i.test(s)],
    ['common', 'Not a common password', s => s && !COMMON.includes(s.toLowerCase().replace(/[^a-z]/g, ''))],
    ['personal', 'Not your name or email', (s, p) => !p.some(w => w.length >= 3 && s.toLowerCase().includes(w))],
  ];
  function strength(s, personal) {
    const passed = RULES.filter(r => r[2](s, personal)).length;
    let score = Math.round((passed / RULES.length) * 70) + Math.min(30, Math.max(0, (s.length - 10) * 3));
    if (passed < RULES.length) score = Math.min(score, 60);
    return Math.max(0, Math.min(100, s ? score : 0));
  }

  function passwordMeter(input, personalFn) {
    const box = document.createElement('div');
    box.className = 'pw-meter';
    box.innerHTML = `<div class="pw-bar"><i></i></div><div class="pw-label"></div><ul class="pw-rules">${RULES.map(r => `<li data-r="${r[0]}">${r[1]}</li>`).join('')}</ul>`;
    input.closest('.field').appendChild(box);
    const paint = () => {
      const s = input.value, p = personalFn();
      RULES.forEach(r => box.querySelector(`[data-r="${r[0]}"]`).classList.toggle('ok', !!r[2](s, p)));
      const sc = strength(s, p);
      box.querySelector('i').style.width = sc + '%';
      box.dataset.level = sc >= 85 ? 'great' : sc >= 70 ? 'good' : sc >= 40 ? 'fair' : 'weak';
      box.querySelector('.pw-label').textContent = !s ? 'Choose a strong password' : sc >= 85 ? 'Excellent password' : sc >= 70 ? 'Strong password' : sc >= 40 ? 'Getting there' : 'Too weak';
    };
    input.addEventListener('input', paint); paint();
    return () => RULES.every(r => r[2](input.value, personalFn()));
  }

  function eyeToggle(input) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'eye'; b.setAttribute('aria-label', 'Show password'); b.innerHTML = '<span>Show</span>';
    b.onclick = () => { const show = input.type === 'password'; input.type = show ? 'text' : 'password'; b.firstChild.textContent = show ? 'Hide' : 'Show'; b.setAttribute('aria-label', show ? 'Hide password' : 'Show password'); };
    input.parentElement.classList.add('has-eye'); input.parentElement.appendChild(b);
  }

  function emailField(input, { server = false } = {}) {
    const hint = document.createElement('div');
    hint.className = 'field-hint';
    input.closest('.field').appendChild(hint);
    let state = 'empty';
    const show = (cls, html) => { hint.className = 'field-hint ' + cls; hint.innerHTML = html; input.setAttribute('aria-invalid', cls === 'bad'); };
    const check = async () => {
      const h = emailHint(input.value);
      if (!h) { show('', ''); state = 'empty'; return; }
      if (h.bad) {
        show('bad', esc(h.bad) + (h.fix ? ` <button type="button" class="linkish">Use ${esc(h.fix)}</button>` : ''));
        const fb = hint.querySelector('button'); if (fb) fb.onclick = () => { input.value = h.fix; check(); };
        state = 'bad'; return;
      }
      if (!server) { show('ok', 'Looks good'); state = 'ok'; return; }
      show('wait', 'Checking this email can receive mail…');
      try { const r = await api('/api/auth/check-email', { method: 'POST', body: { email: input.value } }); show(r.ok ? 'ok' : 'bad', esc(r.message)); state = r.ok ? 'ok' : 'bad'; }
      catch (e) { show('bad', esc(e.message)); state = 'bad'; }
    };
    input.addEventListener('blur', check);
    input.addEventListener('input', () => { if (state === 'bad') { const h = emailHint(input.value); if (h && h.ok) show('', ''); } });
    return { check, ok: () => state === 'ok' };
  }

  // ---------------------------------------------------------------- the 6-digit code step
  function otpStep(host, reply, { title, onDone, onBack }) {
    host.innerHTML = `<div class="otp-step step-in">
      <div class="otp-icon" aria-hidden="true"><svg viewBox="0 0 64 64"><rect x="6" y="14" width="52" height="36" rx="6"/><path d="M8 18l24 18 24-18"/></svg></div>
      <h2>${esc(title || 'Check your email')}</h2>
      <p class="muted">We sent a 6-digit code to <b>${esc(reply.email)}</b>. Enter it below. It works once and expires in <b class="otp-timer">5:00</b>.</p>
      ${reply.dev_code ? `<div class="dev-code"><b>Development mode</b><span>Your code is <code>${esc(reply.dev_code)}</code></span><small>${esc(reply.dev_note || '')}</small></div>` : ''}
      <div class="otp-boxes" role="group" aria-label="6-digit code">${[0, 1, 2, 3, 4, 5].map(i => `<input inputmode="numeric" autocomplete="${i ? 'off' : 'one-time-code'}" maxlength="1" aria-label="Digit ${i + 1}">`).join('')}</div>
      <div class="otp-msg" aria-live="polite"></div>
      <button class="btn primary wide otp-go" disabled>Verify code</button>
      <div class="otp-foot"><button type="button" class="linkish otp-resend" disabled>Send a new code</button><button type="button" class="linkish otp-back">Go back</button></div></div>`;
    const boxes = [...host.querySelectorAll('.otp-boxes input')];
    const msg = host.querySelector('.otp-msg'), go = host.querySelector('.otp-go'), resend = host.querySelector('.otp-resend');
    let challenge = reply.challenge, expires = Date.now() + reply.expires_in * 1000, canResend = Date.now() + reply.resend_in * 1000, busy = false;
    const code = () => boxes.map(b => b.value).join('');
    const tick = setInterval(() => {
      if (!host.isConnected) return clearInterval(tick);
      const left = Math.max(0, Math.round((expires - Date.now()) / 1000));
      host.querySelector('.otp-timer').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      const r = Math.ceil((canResend - Date.now()) / 1000);
      resend.disabled = r > 0; resend.textContent = r > 0 ? `Send a new code (${r}s)` : 'Send a new code';
      if (!left) { msg.className = 'otp-msg bad'; msg.textContent = 'This code has expired. Send a new code.'; }
    }, 500);
    const fill = digits => { digits.split('').slice(0, 6).forEach((d, i) => (boxes[i].value = d)); boxes[Math.min(5, digits.length)].focus(); update(); };
    function update() { go.disabled = code().length !== 6 || busy; if (code().length === 6 && !busy) submit(); }
    boxes.forEach((b, i) => {
      b.addEventListener('input', () => { b.value = b.value.replace(/\D/g, '').slice(-1); if (b.value && i < 5) boxes[i + 1].focus(); b.classList.toggle('filled', !!b.value); update(); });
      b.addEventListener('keydown', e => { if (e.key === 'Backspace' && !b.value && i) { boxes[i - 1].focus(); boxes[i - 1].value = ''; boxes[i - 1].classList.remove('filled'); } if (e.key === 'ArrowLeft' && i) boxes[i - 1].focus(); if (e.key === 'ArrowRight' && i < 5) boxes[i + 1].focus(); });
      b.addEventListener('paste', e => { const t = (e.clipboardData.getData('text') || '').replace(/\D/g, ''); if (t) { e.preventDefault(); fill(t); boxes.forEach(x => x.classList.toggle('filled', !!x.value)); } });
    });
    setTimeout(() => boxes[0].focus(), 50);
    async function submit() {
      busy = true; go.disabled = true; go.classList.add('loading'); msg.className = 'otp-msg'; msg.textContent = 'Checking…';
      try {
        const r = await api('/api/auth/otp/verify', { method: 'POST', body: { challenge, code: code() } });
        msg.className = 'otp-msg ok'; msg.textContent = 'Verified';
        host.querySelector('.otp-boxes').classList.add('done');
        clearInterval(tick);
        setTimeout(() => onDone(r), 450);
      } catch (e) {
        msg.className = 'otp-msg bad'; msg.textContent = e.message;
        const g = host.querySelector('.otp-boxes'); g.classList.remove('shake'); void g.offsetWidth; g.classList.add('shake');
        boxes.forEach(b => { b.value = ''; b.classList.remove('filled'); }); boxes[0].focus();
        if (/start again|finished/i.test(e.message)) setTimeout(() => onBack(), 1600);
      } finally { busy = false; go.classList.remove('loading'); }
    }
    go.onclick = () => submit();
    resend.onclick = async () => {
      try {
        const r = (await api('/api/auth/otp/resend', { method: 'POST', body: { challenge } })).otp;
        expires = Date.now() + r.expires_in * 1000; canResend = Date.now() + r.resend_in * 1000;
        msg.className = 'otp-msg ok'; msg.textContent = 'A new code is on its way.';
        const dc = host.querySelector('.dev-code code'); if (dc && r.dev_code) dc.textContent = r.dev_code;
      } catch (e) { msg.className = 'otp-msg bad'; msg.textContent = e.message; }
    };
    host.querySelector('.otp-back').onclick = () => { clearInterval(tick); onBack(); };
  }

  function welcome(r) {
    const name = (r.player || r.admin || {}).name || '';
    toast(r.welcome ? `Welcome to CricLive, ${name.split(' ')[0]}!` : `Welcome back, ${name.split(' ')[0]}`, 'ok');
    if (window.CricFX && r.welcome) CricFX.milestone({ title: 'Welcome!', sub: name });
  }
  const go = (r, next) => { welcome(r); setTimeout(() => (location.href = next || r.next || '/'), r.welcome ? 1300 : 700); };

  // ---------------------------------------------------------------- sign in
  function mountSignIn(host, opts = {}) {
    const draw = (who = 'player') => {
      host.innerHTML = `<form class="auth-form step-in" novalidate>
        <div class="seg" role="tablist"><button type="button" data-who="player" class="${who === 'player' ? 'on' : ''}">Player</button><button type="button" data-who="staff" class="${who === 'staff' ? 'on' : ''}">Admin or scorer</button></div>
        ${who === 'player'
          ? `<div class="field"><label for="si-email">Email</label><input id="si-email" name="email" type="email" autocomplete="email" required></div>`
          : `<div class="field"><label for="si-user">Username</label><input id="si-user" name="username" autocomplete="username" required></div>`}
        <div class="field"><label for="si-pw">Password</label><div class="pw-wrap"><input id="si-pw" name="password" type="password" autocomplete="current-password" required></div></div>
        <button class="btn primary wide">Continue</button>
        <p class="small muted center">We'll email you a 6-digit code to finish signing in.</p>
        ${opts.registerLink !== false ? `<p class="small center">New here? <a href="/register.html" data-switch="register">Create an account</a></p>` : ''}
      </form>`;
      const f = host.querySelector('form');
      eyeToggle(f.querySelector('#si-pw'));
      host.querySelectorAll('[data-who]').forEach(b => (b.onclick = () => draw(b.dataset.who)));
      const sw = host.querySelector('[data-switch]'); if (sw && opts.onSwitch) sw.onclick = e => { e.preventDefault(); opts.onSwitch('register'); };
      f.onsubmit = async e => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(f));
        if (!Object.values(data).every(v => String(v).trim())) return toast('Please fill in both fields', 'error');
        const btn = f.querySelector('.btn.primary'); btn.classList.add('loading'); btn.disabled = true;
        try {
          const r = await api(who === 'player' ? '/api/auth/player/login' : '/api/auth/admin/login', { method: 'POST', body: data });
          otpStep(host, r.otp, { title: 'Enter your sign-in code', onDone: res => go(res, opts.next), onBack: () => draw(who) });
        } catch (err) {
          toast(err.message, 'error');
          f.classList.remove('shake'); void f.offsetWidth; f.classList.add('shake');
        } finally { btn.classList.remove('loading'); btn.disabled = false; }
      };
      setTimeout(() => { const i = f.querySelector('input'); if (i && !opts.noFocus) i.focus(); }, 60);
    };
    draw(opts.who || 'player');
  }

  // ---------------------------------------------------------------- create account
  function mountRegister(host, opts = {}) {
    const draw = (keep = {}) => {
      host.innerHTML = `<form class="auth-form step-in" novalidate>
        <div class="two"><div class="field"><label for="r-first">First name</label><input id="r-first" name="first_name" maxlength="40" required autocomplete="given-name"></div>
        <div class="field"><label for="r-last">Last name</label><input id="r-last" name="last_name" maxlength="40" required autocomplete="family-name"></div></div>
        <div class="field"><label for="r-email">Email</label><input id="r-email" name="email" type="email" maxlength="100" required autocomplete="email"></div>
        <div class="field"><label for="r-pw">Password</label><div class="pw-wrap"><input id="r-pw" name="password" type="password" maxlength="128" required autocomplete="new-password"></div></div>
        <div class="field"><label for="r-pw2">Type the password again</label><div class="pw-wrap"><input id="r-pw2" name="password2" type="password" maxlength="128" required autocomplete="new-password"></div><div class="field-hint" id="r-match"></div></div>
        <details class="more"><summary>Cricket details (optional)</summary><div class="two">
          <div class="field"><label>Role</label><select name="role"><option>Batsman</option><option>Bowler</option><option>All-rounder</option><option>Wicket-keeper</option></select></div>
          <div class="field"><label>Batting</label><select name="batting_style"><option>Right-hand bat</option><option>Left-hand bat</option></select></div>
          <div class="field"><label>Bowling</label><select name="bowling_style"><option value="">Does not bowl</option><option>Right-arm fast</option><option>Right-arm fast-medium</option><option>Right-arm medium</option><option>Left-arm fast</option><option>Left-arm fast-medium</option><option>Left-arm medium</option><option>Right-arm off-break</option><option>Right-arm leg-break</option><option>Slow left-arm orthodox</option><option>Left-arm orthodox</option><option>Left-arm chinaman</option></select></div>
          <div class="field"><label>Mobile</label><input name="phone" maxlength="15" inputmode="tel" autocomplete="tel"></div>
          <div class="field"><label>City</label><input name="city" maxlength="60" autocomplete="address-level2"></div>
          <div class="field"><label>Date of birth</label><input name="dob" type="date"></div></div></details>
        <button class="btn primary wide">Create account</button>
        <p class="small muted center">We'll email you a code to prove the address is yours.</p>
        ${opts.signInLink !== false ? `<p class="small center">Already registered? <a href="/login.html" data-switch="signin">Sign in</a></p>` : ''}
      </form>`;
      const f = host.querySelector('form');
      for (const [k, v] of Object.entries(keep)) { const i = f.elements[k]; if (i && k !== 'password' && k !== 'password2') i.value = v; }
      const pw = f.querySelector('#r-pw'), pw2 = f.querySelector('#r-pw2');
      eyeToggle(pw); eyeToggle(pw2);
      const personal = () => [f.first_name.value, f.last_name.value, ...f.email.value.split('@')[0].split(/[^a-z0-9]+/i)].map(s => String(s).toLowerCase()).filter(Boolean);
      const strong = passwordMeter(pw, personal);
      const em = emailField(f.querySelector('#r-email'), { server: true });
      const match = () => { const h = f.querySelector('#r-match'); if (!pw2.value) { h.className = 'field-hint'; h.textContent = ''; return false; } const ok = pw.value === pw2.value; h.className = 'field-hint ' + (ok ? 'ok' : 'bad'); h.textContent = ok ? 'Passwords match' : 'The passwords do not match'; return ok; };
      pw.addEventListener('input', match); pw2.addEventListener('input', match);
      const sw = host.querySelector('[data-switch]'); if (sw && opts.onSwitch) sw.onclick = e => { e.preventDefault(); opts.onSwitch('signin'); };
      f.onsubmit = async e => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(f));
        const fail = m => { toast(m, 'error'); f.classList.remove('shake'); void f.offsetWidth; f.classList.add('shake'); };
        if (!data.first_name.trim() || !data.last_name.trim()) return fail('Please enter your first and last name');
        const h = emailHint(data.email); if (!h || h.bad) { em.check(); return fail(h ? h.bad : 'Please enter your email'); }
        if (!strong()) return fail('Please choose a stronger password - see the checklist');
        if (!match()) return fail('The two passwords do not match');
        const btn = f.querySelector('.btn.primary'); btn.classList.add('loading'); btn.disabled = true;
        try {
          const r = await api('/api/auth/player/register', { method: 'POST', body: data });
          otpStep(host, r.otp, { title: 'Confirm your email', onDone: res => go(res, opts.next), onBack: () => draw(data) });
        } catch (err) { fail(err.message); }
        finally { btn.classList.remove('loading'); btn.disabled = false; }
      };
      setTimeout(() => { if (!opts.noFocus) f.querySelector('input').focus(); }, 60);
    };
    draw();
  }

  // a small animated pitch: the ball loops over the stumps (used beside the forms)
  const artScene = () => `<svg class="art-scene" viewBox="-200 -100 400 200" aria-hidden="true">
    <ellipse class="turf" cx="0" cy="84" rx="196" ry="20"/>
    <path class="strip" d="M-175 76 L175 76 L158 92 L-158 92 Z"/>
    <line class="crease" x1="96" y1="76" x2="90" y2="92"/><line class="crease" x1="-96" y1="76" x2="-90" y2="92"/>
    <rect class="stump" x="112" y="2" width="6" height="80" rx="3"/><rect class="stump" x="121" y="2" width="6" height="80" rx="3"/><rect class="stump" x="130" y="2" width="6" height="80" rx="3"/>
    <rect class="bail" x="111" y="-3" width="13" height="5" rx="2.5"/><rect class="bail r" x="124" y="-3" width="13" height="5" rx="2.5"/>
    <ellipse class="ashadow" cx="0" cy="86" rx="9" ry="3"/>
    <g class="aball"><circle r="8"/><path d="M-3 -6 Q1 0 -3 6 M3 -6 Q-1 0 3 6" stroke="#fff" stroke-width="1" fill="none" stroke-dasharray="1.6 1.6"/></g></svg>`;

  window.Auth = { artScene, mountSignIn, mountRegister, passwordMeter, emailField, eyeToggle, emailHint };
})();
