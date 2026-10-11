// =====================================================================
//  Shared helpers for every page: API calls, header + menu, live stream,
//  match cards, follow buttons, live alerts, page animations.
// =====================================================================
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const qs = name => new URLSearchParams(location.search).get(name);
const reducedMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

function toast(msg, type = '') {
  let box = $('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('role', 'status'); document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.innerHTML = `<span class="ti" aria-hidden="true">${type === 'error' ? '!' : '&#10003;'}</span><span>${esc(msg)}</span>`;
  box.appendChild(t);
  setTimeout(() => t.classList.add('out'), type === 'error' ? 4800 : 2600);
  setTimeout(() => t.remove(), type === 'error' ? 5200 : 3000);
}

function fmtDate(s, withTime = true) {
  if (!s) return '';
  const d = new Date(String(s).replace(' ', 'T'));
  if (isNaN(d)) return s;
  const opts = { weekday: withTime ? 'short' : undefined, day: 'numeric', month: 'short', year: 'numeric' };
  if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString('en-GB', opts);
}

const initials = name => String(name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
const teamLogo = t => t ? `<span class="team-logo" style="background:${esc(t.color || '#1f7a4d')}">${esc(t.short_name)}</span>` : '';
const teamDot = t => t ? `<span class="team-dot" style="background:${esc(t.color || '#1f7a4d')}"></span>` : '';
const statusBadge = s => s === 'live' ? '<span class="badge live">Live</span>' : s === 'completed' ? '<span class="badge done">Result</span>' : s === 'abandoned' ? '<span class="badge">No result</span>' : '<span class="badge">Upcoming</span>';
const loader = (text = 'Loading') => `<div class="loader" role="status"><span class="spin-ball" aria-hidden="true"></span><span>${esc(text)}…</span></div>`;

// ---------- header / navigation ----------
let ME = { admin: null, player: null, unread: 0 };
const LOGO = `<span class="ball" aria-hidden="true"></span><span>Cric<b>Live</b></span>`;
async function renderHeader(active) {
  try { ME = await api('/api/auth/me'); } catch { /* offline */ }
  const links = [['/', 'Home', 'home'], ['/tournaments.html', 'Tournaments', 'tournaments'], ['/teams.html', 'Teams', 'teams'],
    ['/players.html', 'Players', 'players'], ['/analytics.html', 'AI Analytics', 'analytics']];
  if (ME.admin) links.push(['/admin/', ME.admin.role === 'admin' ? 'Admin Panel' : 'Scoring', 'admin']);
  links.push(['/contact.html', 'Contact', 'contact']);
  const bell = `<a class="bell" href="/notifications.html" title="Match alerts" aria-label="Match alerts${ME.unread ? `, ${ME.unread} unread` : ''}">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a6 6 0 0 0-6 6v3.6L4.3 15.4A1 1 0 0 0 5.2 17h13.6a1 1 0 0 0 .9-1.6L18 12.6V9a6 6 0 0 0-6-6zm0 18a2.6 2.6 0 0 0 2.5-2h-5A2.6 2.6 0 0 0 12 21z"/></svg>${ME.unread ? `<span class="count">${ME.unread > 99 ? '99+' : ME.unread}</span>` : ''}</a>`;
  let user = `${bell}<a class="btn sm ghost" href="/login.html">Sign in</a><a class="btn sm gold" href="/register.html">Join</a>`;
  if (ME.admin) user = `${bell}<span class="who"><span class="avatar-sm">${esc(initials(ME.admin.name))}</span><span class="nm">${esc(ME.admin.name)}</span><span class="role">${esc(ME.admin.role)}</span></span><button class="btn sm ghost" id="logoutBtn">Sign out</button>`;
  else if (ME.player) user = `${bell}<a class="who" href="/me.html"><span class="avatar-sm">${esc(initials(ME.player.name))}</span><span class="nm">${esc(ME.player.name)}</span></a><button class="btn sm ghost" id="logoutBtn">Sign out</button>`;
  const h = document.createElement('header');
  h.className = 'site-header';
  h.innerHTML = `<div class="wrap">
      <a class="logo" href="/" aria-label="CricLive home">${LOGO}</a>
      <button class="menu-btn" aria-label="Open menu" aria-expanded="false" aria-controls="mainNav"><span></span><span></span><span></span></button>
      <nav class="nav" id="mainNav">${links.map(([href, label, key]) => `<a href="${href}" class="${key === active ? 'active' : ''}" ${key === active ? 'aria-current="page"' : ''}>${label}</a>`).join('')}
        <div class="nav-user">${user}</div></nav>
    </div>`;
  document.body.prepend(h);
  const mb = $('.menu-btn', h);
  mb.onclick = () => { const open = !h.classList.contains('open'); h.classList.toggle('open', open); mb.setAttribute('aria-expanded', open); document.body.classList.toggle('menu-open', open); };
  addEventListener('keydown', e => { if (e.key === 'Escape' && h.classList.contains('open')) mb.click(); });
  addEventListener('scroll', () => h.classList.toggle('scrolled', scrollY > 8), { passive: true });
  const lo = $('#logoutBtn');
  if (lo) lo.onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); try { sessionStorage.removeItem('cl_guest'); } catch { /* */ } location.href = '/'; };
  const f = document.createElement('footer');
  f.className = 'site-footer';
  f.innerHTML = `<div class="wrap foot"><div><a class="logo" href="/">${LOGO}</a><p>Ball-by-ball club cricket. Scores, stats and alerts, live.</p></div>
    <nav aria-label="Footer"><a href="/tournaments.html">Tournaments</a><a href="/players.html">Players</a><a href="/notifications.html">Match alerts</a>
    <a href="/contact.html">Contact us</a><a href="/contact.html?type=bug" class="bug-link">Report a bug</a></nav></div>`;
  document.body.appendChild(f);
  startAlerts();
  return ME;
}

// ---------- live connection (Server-Sent Events) ----------
function liveStream(matchId, handlers) {
  const es = new EventSource('/api/live' + (matchId ? '?match=' + matchId : ''));
  for (const [ev, fn] of Object.entries(handlers)) es.addEventListener(ev, e => fn(JSON.parse(e.data)));
  return es;
}

// ---------- follow teams / matches (saved in this browser; players also on the server) ----------
const FOLLOW_KEY = 'criclive_follow';
function follows() {
  try { return JSON.parse(localStorage.getItem(FOLLOW_KEY)) || { teams: [], matches: [] }; } catch { return { teams: [], matches: [] }; }
}
function saveFollows(f) { try { localStorage.setItem(FOLLOW_KEY, JSON.stringify(f)); } catch { /* private mode */ } }
function isFollowing(kind, id) { return follows()[kind].includes(Number(id)); }
async function toggleFollow(kind, id) {
  const f = follows(), list = f[kind], n = Number(id);
  const on = !list.includes(n);
  f[kind] = on ? [...list, n] : list.filter(x => x !== n);
  saveFollows(f);
  if (kind === 'teams' && ME.player) {
    try { await api('/api/me/follows/' + n, { method: on ? 'POST' : 'DELETE' }); } catch { /* ignore */ }
  }
  if (on && 'Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch { /* ignore */ } }
  toast(on ? 'Following - you will get match alerts' : 'Unfollowed');
  return on;
}
function followButton(kind, id, label) {
  const b = document.createElement('button');
  b.className = 'btn sm pill-btn';
  const paint = () => { const on = isFollowing(kind, id); b.innerHTML = on ? `&#10003; Following` : `&#128276; Follow ${esc(label || '')}`; b.classList.toggle('primary', on); b.setAttribute('aria-pressed', on); };
  b.onclick = async () => { await toggleFollow(kind, id); paint(); b.classList.remove('pulse'); void b.offsetWidth; b.classList.add('pulse'); };
  paint();
  return b;
}

// ---------- live alerts: wickets, fifties, results ... ----------
let alertBox = null;
async function startAlerts() {
  if (ME.player) {
    try { const server = await api('/api/me/follows'); const f = follows(); f.teams = [...new Set([...f.teams, ...server])]; saveFollows(f); } catch { /* ignore */ }
  }
  liveStream(null, { alert: showAlert });
}
function showAlert(a) {
  const f = follows();
  const onThisMatch = location.pathname.endsWith('/match.html') && Number(qs('id')) === a.match_id;
  const followed = f.matches.includes(a.match_id) || (a.team_ids || []).some(t => f.teams.includes(t));
  if (onThisMatch && a.kind === 'milestone' && window.CricFX) CricFX.milestone({ title: a.title.split(' for ')[0], sub: a.body });
  if (!followed && !onThisMatch) return;
  if (onThisMatch && ['wicket', 'result', 'milestone'].includes(a.kind)) return; // the match page plays its own animation
  if (!alertBox) { alertBox = document.createElement('div'); alertBox.className = 'alert-pop'; document.body.appendChild(alertBox); }
  const el = document.createElement('a');
  el.className = 'a ' + a.kind; el.href = a.link || '#';
  el.innerHTML = `<b>${esc(a.title)}</b><span class="small muted">${esc(a.body || '')}</span>`;
  alertBox.prepend(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, 8000);
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try { const n = new Notification(a.title, { body: a.body || '', tag: a.kind + a.match_id }); n.onclick = () => { window.focus(); location.href = a.link; }; } catch { /* ignore */ }
  }
  if (ME.player && ['start', 'innings', 'result', 'milestone'].includes(a.kind)) {
    const bell = $('.bell'); if (bell) { let c = $('.count', bell); if (!c) { c = document.createElement('span'); c.className = 'count'; c.textContent = '0'; bell.appendChild(c); } c.textContent = String(Number(c.textContent) + 1); bell.classList.remove('ring'); void bell.offsetWidth; bell.classList.add('ring'); }
  }
}

// ---------- match card used on home / team / tournament pages ----------
function scoreText(sc) {
  if (!sc) return '<small>-</small>';
  if (sc.yetToBat) return '<small>Yet to bat</small>';
  return `${sc.runs}/${sc.wickets} <small>(${sc.overs})</small>`;
}
function matchCard(m) {
  const row = t => `<div class="row ${t.score && t.score.batting ? 'batting' : ''}"><span>${teamDot(t)}${esc(t.name)}</span><span class="sc">${scoreText(t.score)}</span></div>`;
  return `<a class="card match-card ${m.status}" href="/match.html?id=${m.id}" data-match="${m.id}">
    <div class="top"><span>${esc(m.tournament_name || 'Friendly')}, ${m.overs} ov</span>${statusBadge(m.status)}</div>
    ${row(m.team1)}${row(m.team2)}
    <div class="status">${esc(m.status_text)}</div>
    <div class="small muted">${esc(m.venue || '')}${m.venue ? ', ' : ''}${fmtDate(m.match_date)}</div></a>`;
}

// chart card helper: <div class="card"><div id=...></div></div>
function chartCard(id, wide) { return `<div class="card" ${wide ? 'style="grid-column:1/-1"' : ''}><div id="${id}"></div></div>`; }

// ---------- page animations ----------
// 1) cards, tiles and charts rise into view as you scroll (once)
const revealIO = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); revealIO.unobserve(e.target); countUp(e.target); }
}, { rootMargin: '0px 0px -6% 0px' }) : null;
const REVEAL = '.card, .match-card, .tile, .scoreboard, .section-title, .seg-card, .team-card';
const bornAt = Date.now();
function reveal(root = document) {
  const els = $$(REVEAL, root).filter(el => !el.dataset.rv);
  els.forEach((el, i) => {
    el.dataset.rv = 1;
    // content that updates live (new balls) appears at once; only the first render animates in
    if (!revealIO || reducedMotion() || (Date.now() - bornAt > 2500 && !el.closest('[data-animate]'))) { el.classList.add('in'); return; }
    el.classList.add('reveal');
    el.style.setProperty('--d', Math.min(i, 12) * 45 + 'ms');
    revealIO.observe(el);
  });
}
// safety net: anything on screen that is still waiting gets shown (e.g. content inside a tab that was hidden)
function revealVisible() {
  for (const el of $$('.reveal:not(.in)')) {
    const r = el.getBoundingClientRect();
    if (r.height && r.bottom > 0 && r.top < innerHeight) { el.classList.add('in'); if (revealIO) revealIO.unobserve(el); countUp(el); }
  }
}
setInterval(revealVisible, 700);
addEventListener('click', () => setTimeout(revealVisible, 60));
// 2) numbers in stat tiles count up
function countUp(el) {
  if (reducedMotion()) return;
  $$('.tile .v, .count-up', el.matches('.tile') ? el.parentElement : el).forEach(v => {
    if (v.dataset.cu) return; v.dataset.cu = 1;
    const m = String(v.textContent).trim().match(/^(-?\d+(?:\.\d+)?)(.*)$/);
    if (!m || v.children.length) return;
    const end = Number(m[1]), dec = (m[1].split('.')[1] || '').length, tail = m[2], t0 = performance.now(), dur = 700;
    const step = t => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); v.textContent = (end * e).toFixed(dec) + tail; if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
}
// 3) watch for content rendered later
if ('MutationObserver' in window) {
  const mo = new MutationObserver(muts => { if (muts.some(m => m.addedNodes.length)) reveal(); });
  addEventListener('DOMContentLoaded', () => { reveal(); mo.observe(document.body, { childList: true, subtree: true }); });
}
// 4) smooth hand-over between pages: View Transitions where supported, otherwise a quick fade
const crossDocVT = 'onpagereveal' in window;
addEventListener('click', e => {
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target || a.hasAttribute('download')) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || (url.pathname === location.pathname && url.hash)) return;
  document.documentElement.classList.add('nav-busy');
  if (crossDocVT || reducedMotion()) return;
  e.preventDefault();
  document.documentElement.classList.add('page-leave');
  setTimeout(() => (location.href = url.href), 160);
});
addEventListener('pageshow', () => document.documentElement.classList.remove('nav-busy', 'page-leave'));
