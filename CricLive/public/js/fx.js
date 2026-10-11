// =====================================================================
//  CricFX - match celebrations (no libraries)
//    CricFX.four({ sub })        sparkles + boundary ring
//    CricFX.six({ sub })         ball flies out of the ground + fireworks
//    CricFX.wicket({ sub })      stumps shatter, bails fly, red flash
//    CricFX.win({ team, sub, color })   trophy + confetti rain
//    CricFX.milestone({ title, sub })   gold stars (fifty, hundred, 3-for)
//    CricFX.mini(element, kind)  small burst on a card ('four'|'six'|'wicket')
//  Options: { small: true } for a lighter version (scoring console).
//  People who ask their device for reduced motion get a simple banner.
// =====================================================================
(function () {
  const reduced = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const GOLD = ['#ffd34d', '#ffb800', '#fff3b0', '#ffffff'];
  const BLUE = ['#5aa9ff', '#2a78d6', '#cfe6ff', '#ffd34d'];
  const PURPLE = ['#b98cff', '#7b3fe4', '#ffd34d', '#ff7ac0', '#7fe3ff'];
  const WOOD = ['#e9d3a6', '#c99b5b', '#f5e6c4', '#8a5a2b'];

  let layer, canvas, ctx, parts = [], raf = 0, queue = [], busy = false, W = 0, H = 0;

  function ensure() {
    if (layer) return;
    layer = document.createElement('div');
    layer.className = 'fx-layer';
    layer.setAttribute('aria-live', 'polite');
    canvas = document.createElement('canvas');
    layer.appendChild(canvas);
    document.body.appendChild(layer);
    ctx = canvas.getContext('2d');
    size();
    addEventListener('resize', size);
  }
  function size() {
    const d = Math.min(2, devicePixelRatio || 1);
    W = innerWidth; H = innerHeight;
    canvas.width = W * d; canvas.height = H * d;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(d, 0, 0, d, 0, 0);
  }
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = a => a[Math.floor(Math.random() * a.length)];

  // ---------------- particles
  function add(p) { parts.push(Object.assign({ life: 0, max: 60, size: 3, g: 0.12, drag: 0.985, rot: 0, vr: 0, shape: 'spark', alpha: 1 }, p)); loop(); }
  function burst(x, y, n, colors, o = {}) {
    for (let i = 0; i < n; i++) {
      const a = rnd(0, Math.PI * 2), s = rnd(o.min || 2, o.max || 9);
      add({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - (o.lift || 0), color: pick(colors), size: rnd(o.smin || 1.5, o.smax || 4),
        max: rnd(o.lmin || 40, o.lmax || 80), g: o.g ?? 0.1, shape: o.shape || pick(['spark', 'star', 'circle']), vr: rnd(-0.3, 0.3) });
    }
  }
  function star(c, r) {
    c.beginPath();
    for (let i = 0; i < 10; i++) { const rr = i % 2 ? r * 0.45 : r, a = (i * Math.PI) / 5 - Math.PI / 2; c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
    c.closePath(); c.fill();
  }
  function draw() {
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.life++; p.vx *= p.drag; p.vy = p.vy * p.drag + p.g; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      const t = p.life / p.max, a = Math.max(0, 1 - t) * p.alpha;
      ctx.save(); ctx.globalAlpha = a; ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.color;
      if (p.shape === 'star') star(ctx, p.size * 1.8);
      else if (p.shape === 'confetti') { ctx.scale(1, Math.sin(p.life * 0.2 + p.size)); ctx.fillRect(-p.size, -p.size * 0.5, p.size * 2, p.size); }
      else if (p.shape === 'chip') ctx.fillRect(-p.size, -p.size * 0.3, p.size * 2, p.size * 0.6);
      else if (p.shape === 'spark') { ctx.shadowColor = p.color; ctx.shadowBlur = 8; ctx.fillRect(-p.size * 1.6, -0.8, p.size * 3.2, 1.6); ctx.rotate(Math.PI / 2); ctx.fillRect(-p.size * 1.6, -0.8, p.size * 3.2, 1.6); }
      else if (p.shape === 'ring') { ctx.strokeStyle = p.color; ctx.lineWidth = 4 * (1 - t); ctx.beginPath(); ctx.arc(0, 0, p.size + t * p.grow, 0, Math.PI * 2); ctx.stroke(); }
      else if (p.shape === 'ball') { ctx.fillStyle = '#c8102e'; ctx.beginPath(); ctx.arc(0, 0, p.size, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1.5; ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.arc(0, 0, p.size * 0.6, -1.2, 1.2); ctx.stroke(); ctx.setLineDash([]); }
      else { ctx.beginPath(); ctx.arc(0, 0, p.size, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
      if (p.trail && p.life % 2 === 0) add({ x: p.x, y: p.y, vx: rnd(-0.4, 0.4), vy: rnd(-0.4, 0.4), g: 0, color: pick(GOLD), size: rnd(1, 2.5), max: 26, shape: 'circle' });
      if (p.onLife && p.life === p.onLifeAt) p.onLife(p);
    }
    parts = parts.filter(p => p.life < p.max && p.y < H + 60 && p.x > -80 && p.x < W + 80);
  }
  function loop() {
    if (raf) return;
    const step = () => { draw(); raf = parts.length ? requestAnimationFrame(step) : 0; if (!raf) ctx.clearRect(0, 0, W, H); };
    raf = requestAnimationFrame(step);
  }

  // ---------------- banner (the big word in the middle)
  function banner(kind, html, ms) {
    const b = document.createElement('div');
    b.className = `fx-banner fx-${kind}`;
    b.innerHTML = html;
    layer.appendChild(b);
    setTimeout(() => b.classList.add('out'), ms - 450);
    setTimeout(() => b.remove(), ms);
    return b;
  }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sub = o => (o.sub ? `<div class="fx-sub">${esc(o.sub)}</div>` : '');

  // ---------------- queue so effects never pile on top of each other
  function play(fn, o = {}) {
    ensure();
    if (busy) { queue.push([fn, o]); if (queue.length > 2) queue.shift(); return; }
    busy = true;
    layer.classList.toggle('small', !!o.small);
    const ms = reduced() ? 1600 : fn(o);
    if (reduced()) fn.quiet(o);
    setTimeout(() => { busy = false; const n = queue.shift(); if (n) play(n[0], n[1]); }, Math.max(900, ms - 300));
  }
  const cx = () => W / 2, cy = () => H * 0.42;

  function four(o) {
    const s = o.small ? 0.6 : 1;
    banner('four', `<div class="fx-big">4</div><div class="fx-word">FOUR</div>${sub(o)}`, 1900);
    add({ x: cx(), y: cy(), vx: 0, vy: 0, g: 0, shape: 'ring', color: '#ffd34d', size: 20, grow: Math.max(W, H) * 0.45 * s, max: 45, drag: 1 });
    add({ x: cx(), y: cy(), vx: 0, vy: 0, g: 0, shape: 'ring', color: '#5aa9ff', size: 10, grow: Math.max(W, H) * 0.32 * s, max: 55, drag: 1 });
    burst(cx(), cy(), 70 * s, BLUE.concat(GOLD), { min: 3, max: 12 * s, g: 0.06, lmax: 70 });
    setTimeout(() => burst(cx(), cy(), 40 * s, GOLD, { min: 1, max: 6, g: 0.02, shape: 'star', lmin: 50, lmax: 90 }), 180);
    return 1900;
  }
  four.quiet = o => banner('four', `<div class="fx-word">FOUR</div>${sub(o)}`, 1500);

  function six(o) {
    const s = o.small ? 0.6 : 1;
    banner('six', `<div class="fx-big">6</div><div class="fx-word">SIX!</div>${sub(o)}`, 2600);
    // the ball is hit from the bottom-left out over the top of the ground
    add({ x: W * 0.15, y: H + 10, vx: W * 0.0105, vy: -Math.max(15, H * 0.032), g: 0.24, drag: 1, shape: 'ball', size: 9 * s + 3, max: 110, trail: true, color: '#c8102e' });
    const fire = (x, y, d) => setTimeout(() => {
      burst(x, y, 70 * s, PURPLE, { min: 2, max: 9, g: 0.07, lmin: 50, lmax: 95 });
      add({ x, y, vx: 0, vy: 0, g: 0, shape: 'ring', color: pick(PURPLE), size: 6, grow: 140 * s, max: 40, drag: 1 });
    }, d);
    fire(W * 0.72, H * 0.22, 650); fire(W * 0.35, H * 0.18, 950); fire(W * 0.56, H * 0.3, 1250);
    return 2600;
  }
  six.quiet = o => banner('six', `<div class="fx-word">SIX!</div>${sub(o)}`, 1500);

  const STUMPS = `<svg class="fx-stumps" viewBox="0 0 120 150" aria-hidden="true">
    <g class="bail b1"><rect x="18" y="20" width="40" height="7" rx="3.5"/></g><g class="bail b2"><rect x="62" y="20" width="40" height="7" rx="3.5"/></g>
    <rect class="st s1" x="16" y="30" width="12" height="118" rx="5"/><rect class="st s2" x="54" y="30" width="12" height="118" rx="5"/><rect class="st s3" x="92" y="30" width="12" height="118" rx="5"/>
    <circle class="hitball" cx="60" cy="96" r="11"/></svg>`;
  function wicket(o) {
    const s = o.small ? 0.6 : 1;
    banner('wicket', `${STUMPS}<div class="fx-word">WICKET!</div>${sub(o)}`, 2500);
    layer.classList.add('flash-red'); setTimeout(() => layer.classList.remove('flash-red'), 700);
    if (!o.small) { document.documentElement.classList.add('fx-shake'); setTimeout(() => document.documentElement.classList.remove('fx-shake'), 450); }
    setTimeout(() => burst(cx(), cy() - 40 * s, 46 * s, WOOD, { min: 3, max: 10, g: 0.28, shape: 'chip', smin: 2, smax: 5, lift: 4 }), 330);
    return 2500;
  }
  wicket.quiet = o => banner('wicket', `<div class="fx-word">WICKET!</div>${sub(o)}`, 1500);

  const TROPHY = `<svg class="fx-trophy" viewBox="0 0 120 140" aria-hidden="true"><defs><linearGradient id="fxg" x1="0" x2="1"><stop offset="0" stop-color="#ffe27a"/><stop offset=".5" stop-color="#ffbf1f"/><stop offset="1" stop-color="#d48c00"/></linearGradient></defs>
    <path d="M30 10h60v28c0 22-14 38-30 38S30 60 30 38z" fill="url(#fxg)"/><path d="M30 18H12c0 18 8 28 20 30M90 18h18c0 18-8 28-20 30" fill="none" stroke="#ffbf1f" stroke-width="7" stroke-linecap="round"/>
    <rect x="52" y="74" width="16" height="22" fill="#e0a100"/><rect x="34" y="96" width="52" height="12" rx="3" fill="url(#fxg)"/><rect x="26" y="108" width="68" height="18" rx="4" fill="#0b3a2b"/>
    <text x="60" y="121" text-anchor="middle" font-size="10" font-weight="800" fill="#ffd34d" font-family="Bahnschrift, Arial Narrow, sans-serif">CHAMPIONS</text></svg>`;
  function win(o) {
    const colors = [o.color || '#1baf7a', '#ffd34d', '#ffffff', '#2a78d6', '#eb6834'];
    const b = banner('win', `<div class="fx-rays"></div>${TROPHY}<div class="fx-word">${esc(o.team || 'Winners')}</div><div class="fx-wintext">WIN!</div>${sub(o)}`, o.small ? 3600 : 5600);
    b.style.setProperty('--team', o.color || '#1baf7a');
    const rain = o.small ? 6 : 14;
    for (let k = 0; k < rain; k++) setTimeout(() => {
      for (let i = 0; i < (o.small ? 8 : 16); i++) add({ x: rnd(0, W), y: rnd(-40, -5), vx: rnd(-1.2, 1.2), vy: rnd(1.5, 4), g: 0.035, drag: 0.995, shape: 'confetti', color: pick(colors), size: rnd(3, 6), max: 260, vr: rnd(-0.15, 0.15) });
    }, k * 220);
    setTimeout(() => { burst(W * 0.25, H * 0.35, 60, GOLD, { g: 0.08 }); burst(W * 0.75, H * 0.35, 60, GOLD, { g: 0.08 }); }, 500);
    return o.small ? 3600 : 5600;
  }
  win.quiet = o => banner('win', `${TROPHY}<div class="fx-word">${esc(o.team || 'Winners')}</div><div class="fx-wintext">WIN!</div>${sub(o)}`, 3000);

  function milestone(o) {
    banner('milestone', `<div class="fx-word">${esc(o.title || 'Milestone!')}</div>${sub(o)}`, 2400);
    burst(cx(), cy(), 60, GOLD, { shape: 'star', min: 2, max: 8, g: 0.04, lmin: 60, lmax: 100 });
    return 2400;
  }
  milestone.quiet = o => banner('milestone', `<div class="fx-word">${esc(o.title || 'Milestone!')}</div>${sub(o)}`, 1500);

  // small burst attached to a card (home page, lists)
  function mini(el, kind) {
    if (!el) return;
    ensure();
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return;
    const label = kind === 'four' ? '4' : kind === 'six' ? '6' : kind === 'wicket' ? 'W' : kind === 'win' ? '🏆' : null;
    if (!label) return;
    const chip = document.createElement('div');
    chip.className = `fx-chip fx-${kind}`; chip.textContent = label;
    chip.style.left = r.left + r.width - 46 + 'px'; chip.style.top = r.top + 18 + 'px';
    layer.appendChild(chip); setTimeout(() => chip.remove(), 1500);
    if (!reduced()) burst(r.left + r.width - 30, r.top + 34, kind === 'six' ? 34 : 22, kind === 'wicket' ? WOOD : kind === 'six' ? PURPLE : BLUE.concat(GOLD), { min: 1, max: 5, g: 0.08, lmax: 50 });
  }

  window.CricFX = {
    four: o => play(four, o), six: o => play(six, o), wicket: o => play(wicket, o),
    win: o => play(win, o), milestone: o => play(milestone, o), mini,
    // pick the effect for a ball kind from the scoring engine
    forBall(kind, o) { if (kind === 'four') this.four(o); else if (kind === 'six') this.six(o); else if (kind === 'wicket') this.wicket(o); },
  };
})();
