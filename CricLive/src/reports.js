// =====================================================================
//  Downloads: CSV files and stand-alone match / player reports.
//
//  A report is ONE .html file with its charts drawn in (SVG) - it opens
//  offline in any browser, animates on screen, and prints / saves as PDF.
//  Each report ends with data-based tips on what to improve.
// =====================================================================
const db = require('./db');
const state = require('./state');
const analytics = require('./analytics');
const { overs, rate, sr } = require('./util');

const COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'];
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = d => (d ? new Date(String(d).replace(' ', 'T')).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }) : '');
const pct = (a, b) => (b ? Math.round((a * 100) / b) : 0);
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const fullName = p => `${p.first_name} ${p.last_name}`;

// ------------------------------------------------------------ CSV
// cells that start with = + - @ are prefixed so a spreadsheet never runs them as formulas
function csvCell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return String(v);
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const toCsv = rows => '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

async function names(ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  const rows = await db.all(`SELECT id, first_name, last_name FROM players WHERE id IN (${list.map(() => '?').join(',')})`, list);
  return new Map(rows.map(r => [r.id, fullName(r)]));
}

async function matchMeta(id) {
  return db.get(`SELECT m.*, a.name AS t1, b.name AS t2, a.short_name AS s1, b.short_name AS s2, t.name AS tournament
    FROM matches m JOIN teams a ON a.id = m.team1_id JOIN teams b ON b.id = m.team2_id LEFT JOIN tournaments t ON t.id = m.tournament_id WHERE m.id = ?`, [id]);
}

async function matchBallsCsv(id) {
  const m = await matchMeta(id);
  if (!m) return null;
  const balls = await db.all(`SELECT b.*, i.innings_no, i.batting_team_id FROM balls b JOIN innings i ON i.id = b.innings_id WHERE b.match_id = ? ORDER BY b.seq`, [id]);
  const nm = await names(balls.flatMap(b => [b.batsman_id, b.non_striker_id, b.bowler_id, b.player_out_id, b.fielder_id]));
  const team = t => (t === m.team1_id ? m.t1 : m.t2);
  const score = {};
  const rows = [['Innings', 'Batting team', 'Over', 'Ball', 'Bowler', 'Batter', 'Non-striker', 'Bat runs', 'Extra type', 'Extra runs',
    'Total runs', 'Legal ball', 'Wicket', 'Player out', 'Fielder', 'Score after ball', 'Commentary']];
  for (const b of balls) {
    const s = (score[b.innings_no] = score[b.innings_no] || { r: 0, w: 0 });
    s.r += b.total_runs; s.w += b.is_wicket;
    rows.push([b.innings_no, team(b.batting_team_id), b.over_no + 1, b.ball_in_over, nm.get(b.bowler_id) || '', nm.get(b.batsman_id) || '', nm.get(b.non_striker_id) || '',
      b.runs_bat, { wd: 'wide', nb: 'no-ball', b: 'bye', lb: 'leg-bye' }[b.extra_type] || '', b.extra_runs, b.total_runs, b.is_legal ? 'yes' : 'no',
      b.wicket_type ? b.wicket_type.replace('_', ' ') : '', nm.get(b.player_out_id) || '', nm.get(b.fielder_id) || '', `${s.r}/${s.w}`, b.commentary || '']);
  }
  return { filename: `criclive-match-${id}-${slug(m.s1 + '-v-' + m.s2)}-ball-by-ball.csv`, body: toCsv(rows) };
}

async function matchScorecardCsv(id) {
  const s = await state.matchState(id);
  if (!s) return null;
  const rows = [['Match', `${s.team1.name} v ${s.team2.name}`], ['Date', s.match_date], ['Venue', s.venue || ''], ['Result', s.result_text || s.status_text], []];
  for (const i of s.innings) {
    rows.push([`${i.batting_team.name} - innings ${i.innings_no}`, `${i.runs}/${i.wickets}`, `${i.overs} overs`]);
    rows.push(['Batter', 'How out', 'Runs', 'Balls', '4s', '6s', 'Strike rate']);
    for (const b of i.batting) rows.push([b.name, b.dismissal, b.runs, b.balls, b.fours, b.sixes, Number(b.sr)]);
    rows.push(['Extras', `b ${i.extras.byes}, lb ${i.extras.legbyes}, w ${i.extras.wides}, nb ${i.extras.noballs}`, i.extras.total]);
    rows.push(['Bowler', 'Overs', 'Maidens', 'Runs', 'Wickets', 'Economy', 'Wides', 'No-balls']);
    for (const b of i.bowling) rows.push([b.name, b.overs, b.maidens, b.runs, b.wickets, Number(b.econ), b.wides, b.noballs]);
    rows.push([]);
  }
  return { filename: `criclive-match-${id}-${slug(s.team1.short_name + '-v-' + s.team2.short_name)}-scorecard.csv`, body: toCsv(rows) };
}

async function playerInnings(pid) {
  const bat = await db.all(`SELECT bs.*, m.match_date, m.team1_id, m.team2_id, m.overs AS match_overs, t.name AS tournament
      FROM batting_scores bs JOIN matches m ON m.id = bs.match_id LEFT JOIN tournaments t ON t.id = m.tournament_id WHERE bs.player_id = ? ORDER BY m.match_date, m.id`, [pid]);
  const bowl = await db.all(`SELECT bw.*, m.match_date, m.team1_id, m.team2_id, t.name AS tournament
      FROM bowling_scores bw JOIN matches m ON m.id = bw.match_id LEFT JOIN tournaments t ON t.id = m.tournament_id WHERE bw.player_id = ? AND bw.legal_balls > 0 ORDER BY m.match_date, m.id`, [pid]);
  const teams = new Map((await db.all('SELECT id, name FROM teams')).map(t => [t.id, t.name]));
  const opp = r => teams.get(r.team1_id === r.team_id ? r.team2_id : r.team1_id) || '';
  return { bat, bowl, opp };
}

async function playerCsv(pid) {
  const p = await db.get('SELECT * FROM players WHERE id = ?', [pid]);
  if (!p) return null;
  const { bat, bowl, opp } = await playerInnings(pid);
  const byMatch = new Map();
  for (const r of bat) byMatch.set(r.match_id, { d: r.match_date, opp: opp(r), t: r.tournament, bat: r });
  for (const r of bowl) { const x = byMatch.get(r.match_id) || { d: r.match_date, opp: opp(r), t: r.tournament }; x.bowl = r; byMatch.set(r.match_id, x); }
  const rows = [['Date', 'Opponent', 'Competition', 'Match id', 'Runs', 'Balls', '4s', '6s', 'Strike rate', 'Out?', 'How out',
    'Overs bowled', 'Runs conceded', 'Wickets', 'Maidens', 'Economy', 'Dots bowled', 'Wides', 'No-balls']];
  for (const [mid, x] of [...byMatch].sort((a, b) => String(a[1].d).localeCompare(String(b[1].d)))) {
    const b = x.bat, w = x.bowl;
    rows.push([String(x.d).slice(0, 10), x.opp, x.t || 'Friendly', mid,
      b ? b.runs : '', b ? b.balls : '', b ? b.fours : '', b ? b.sixes : '', b ? Number(sr(b.runs, b.balls)) : '', b ? (b.is_out ? 'out' : 'not out') : '', b && b.is_out ? (b.wicket_type || '').replace('_', ' ') : '',
      w ? overs(w.legal_balls) : '', w ? w.runs : '', w ? w.wickets : '', w ? w.maidens : '', w ? Number(rate(w.runs, w.legal_balls)) : '', w ? w.dots : '', w ? w.wides : '', w ? w.noballs : '']);
  }
  return { filename: `criclive-${slug(fullName(p))}-matches.csv`, body: toCsv(rows) };
}

// ------------------------------------------------------------ SVG charts (server side)
function scale(max) {
  if (!(max > 0)) return { max: 1, step: 1 };
  const raw = max / 4, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(x => x * mag).find(x => x >= raw);
  return { max: Math.ceil(max / step) * step, step };
}
function frame(title, sub, legend, svg) {
  return `<figure class="chart"><figcaption><b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</figcaption>
    ${legend && legend.length > 1 ? `<div class="legend">${legend.map((l, i) => `<span><i style="background:${COLORS[i % 4]}"></i>${esc(l)}</span>`).join('')}</div>` : ''}${svg}</figure>`;
}
function axes(W, H, pad, sc) {
  let g = '';
  for (let v = 0; v <= sc.max + 1e-9; v += sc.step) {
    const y = pad.t + (H - pad.t - pad.b) * (1 - v / sc.max);
    g += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}" class="${v ? 'grid' : 'base'}"/><text x="${pad.l - 6}" y="${y + 4}" class="ax" text-anchor="end">${Math.round(v * 100) / 100}</text>`;
  }
  return g;
}
function xlab(labels, x0, band, y, W) {
  const every = Math.max(1, Math.ceil(labels.length / Math.floor(W / 46)));
  return labels.map((l, i) => (i % every ? '' : `<text x="${x0 + band * i + band / 2}" y="${y}" class="ax" text-anchor="middle">${esc(l)}</text>`)).join('');
}
function columns({ title, sub, labels, series, height = 230, yTitle }) {
  if (!labels.length || series.every(s => s.values.every(v => !v))) return frame(title, sub, null, '<div class="none">No data yet</div>');
  const W = 680, H = height, pad = { t: 16, r: 8, b: 26, l: 38 };
  const sc = scale(Math.max(...series.flatMap(s => s.values)));
  const plotH = H - pad.t - pad.b, band = (W - pad.l - pad.r) / labels.length;
  const bw = Math.min(22, (band * 0.76) / series.length);
  let bars = '';
  labels.forEach((l, i) => series.forEach((s, j) => {
    const v = s.values[i] || 0, h = (v / sc.max) * plotH;
    if (h <= 0) return;
    const x = pad.l + band * i + (band - bw * series.length) / 2 + j * bw, y = pad.t + plotH - h;
    const muted = s.muted && s.muted[i] ? ' opacity=".45"' : '';
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 1.5).toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${s.color || COLORS[j % 4]}"${muted} class="grow" style="animation-delay:${(i * 25 + j * 60)}ms"><title>${esc(l)} - ${esc(s.name)}: ${v}</title></rect>`;
  }));
  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${axes(W, H, pad, sc)}${bars}${xlab(labels, pad.l, band, H - 7, W)}${yTitle ? `<text x="${pad.l}" y="10" class="ax">${esc(yTitle)}</text>` : ''}</svg>`;
  return frame(title, sub, series.map(s => s.name), svg);
}
function lines({ title, sub, labels, series, height = 230, yTitle, markers }) {
  if (!labels.length || series.every(s => s.values.every(v => v == null))) return frame(title, sub, null, '<div class="none">No data yet</div>');
  const W = 680, H = height, pad = { t: 16, r: 14, b: 26, l: 38 };
  const sc = scale(Math.max(...series.flatMap(s => s.values.filter(v => v != null)), 0));
  const plotH = H - pad.t - pad.b, plotW = W - pad.l - pad.r, n = labels.length;
  const X = i => pad.l + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW), Y = v => pad.t + plotH - (v / sc.max) * plotH;
  let g = '';
  series.forEach((s, j) => {
    const pts = s.values.map((v, i) => (v == null ? null : [X(i), Y(v)])).filter(Boolean);
    if (pts.length > 1) g += `<path d="M${pts.map(p => p.map(x => x.toFixed(1)).join(',')).join('L')}" fill="none" stroke="${COLORS[j % 4]}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" pathLength="1" class="draw" style="animation-delay:${j * 200}ms"/>`;
    s.values.forEach((v, i) => { if (v != null && (markers ? markers(j, i) : i === s.values.length - 1)) g += `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="4" fill="${COLORS[j % 4]}" stroke="#fff" stroke-width="1.5" class="pop"><title>${esc(labels[i])}: ${v}</title></circle>`; });
  });
  const every = Math.max(1, Math.ceil(n / Math.floor(plotW / 46)));
  const xl = labels.map((l, i) => (i % every && i !== n - 1 ? '' : `<text x="${X(i)}" y="${H - 7}" class="ax" text-anchor="middle">${esc(l)}</text>`)).join('');
  return frame(title, sub, series.map(s => s.name), `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${axes(W, H, pad, sc)}${g}${xl}${yTitle ? `<text x="${pad.l}" y="10" class="ax">${esc(yTitle)}</text>` : ''}</svg>`);
}
function hbars({ title, sub, data, color = 0, unit = '' }) {
  if (!data.length || data.every(d => !d.value)) return frame(title, sub, null, '<div class="none">No data yet</div>');
  const W = 680, row = 28, H = data.length * row + 8, lab = 220, max = Math.max(...data.map(d => d.value)) || 1;
  const g = data.map((d, i) => {
    const w = (d.value / max) * (W - lab - 60), y = 4 + i * row;
    return `<text x="${lab - 8}" y="${y + 18}" class="lab" text-anchor="end">${esc(String(d.label).slice(0, 34))}</text>
      <rect x="${lab}" y="${y + 6}" width="${Math.max(0, w).toFixed(1)}" height="16" rx="3" fill="${COLORS[color % 4]}" class="growx" style="animation-delay:${i * 50}ms"><title>${esc(d.label)}: ${d.value}${unit}</title></rect>
      <text x="${lab + w + 6}" y="${y + 18}" class="val">${d.value}${unit}</text>`;
  }).join('');
  return frame(title, sub, null, `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${g}</svg>`);
}

// ------------------------------------------------------------ report page shell
function page(title, body) {
  return `<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>
:root{--ink:#14211a;--muted:#5b6a61;--line:#dfe6e1;--bg:#f4f7f5;--card:#fff;--brand:#0c3b2c;--gold:#e8a900;--red:#c8102e}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 "Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:24px 18px 60px}
header.top{background:linear-gradient(135deg,#0a2f22,#14593f);color:#fff;border-radius:18px;padding:26px 26px 22px;position:relative;overflow:hidden}
header.top:after{content:"";position:absolute;right:-50px;top:-50px;width:220px;height:220px;border-radius:50%;border:30px solid rgba(255,255,255,.06)}
.brand{font-weight:800;font-size:1.15rem;letter-spacing:.3px}.brand b{color:var(--gold)}
h1{font-size:1.9rem;margin:10px 0 4px;line-height:1.15}h2{font-size:1.25rem;margin:34px 0 12px}h3{margin:0 0 8px;font-size:1rem}
.meta{opacity:.85;font-size:.92rem}.result{display:inline-block;margin-top:12px;background:rgba(255,255,255,.12);padding:6px 12px;border-radius:99px;font-weight:700;color:#ffe08a}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}.tile .v{font-size:1.5rem;font-weight:800;font-variant-numeric:tabular-nums}.tile .k{font-size:.8rem;color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:14px}
.card,figure.chart{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin:0}
figcaption b{display:block}figcaption span{color:var(--muted);font-size:.85rem}
.legend{display:flex;gap:14px;font-size:.82rem;color:var(--muted);margin:6px 0}.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px}
svg{width:100%;height:auto;display:block;overflow:visible;margin-top:6px}.ax{font-size:11px;fill:var(--muted)}.lab{font-size:12px;fill:var(--ink)}.val{font-size:11px;font-weight:700;fill:var(--ink)}
.grid line,.grid{}line.grid{stroke:#e7ece9}line.base{stroke:#9aa7a0}.none{color:var(--muted);padding:30px;text-align:center}
table{width:100%;border-collapse:collapse;font-size:.9rem}th,td{padding:7px 8px;border-bottom:1px solid var(--line);text-align:left}th{color:var(--muted);font-size:.78rem}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.inn{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:6px 14px 12px;margin-bottom:14px;overflow-x:auto}
.tips{list-style:none;padding:0;margin:0;display:grid;gap:10px}.tips li{background:var(--card);border:1px solid var(--line);border-left:5px solid var(--gold);border-radius:12px;padding:12px 14px}
.tips li.good{border-left-color:#1baf7a}.tips li.work{border-left-color:#eb6834}.tips b{display:block}
.actions{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}.actions button{font:inherit;font-weight:700;border:0;border-radius:10px;padding:9px 16px;cursor:pointer;background:#fff;color:var(--brand)}
footer{color:var(--muted);font-size:.8rem;text-align:center;margin-top:40px}
.grow{transform-box:fill-box;transform-origin:bottom;animation:grow .7s cubic-bezier(.2,.8,.2,1) both}.growx{transform-box:fill-box;transform-origin:left;animation:growx .7s cubic-bezier(.2,.8,.2,1) both}
.draw{stroke-dasharray:1;stroke-dashoffset:1;animation:draw 1.4s ease-out forwards}.pop{animation:pop .4s 1.2s both}
@keyframes grow{from{transform:scaleY(0)}}@keyframes growx{from{transform:scaleX(0)}}@keyframes draw{to{stroke-dashoffset:0}}@keyframes pop{from{opacity:0;transform:scale(0)}}
@media (prefers-reduced-motion:reduce){.grow,.growx,.draw,.pop{animation:none;stroke-dashoffset:0}}
@media (max-width:560px){.grid{grid-template-columns:1fr}h1{font-size:1.5rem}}
@media print{body{background:#fff}.actions{display:none}.card,figure.chart,.inn,.tile,.tips li{break-inside:avoid}.grow,.growx,.draw,.pop{animation:none;stroke-dashoffset:0}header.top{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body><div class="wrap">${body}
<footer>Made with CricLive on ${new Date().toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' })}. Every number comes from the ball-by-ball record.</footer></div></body></html>`;
}
const actions = '<div class="actions"><button onclick="window.print()">Print or save as PDF</button></div>';

// ------------------------------------------------------------ match report
function phaseRates(balls, total) {
  const out = { Powerplay: { r: 0, b: 0 }, 'Middle overs': { r: 0, b: 0 }, 'Death overs': { r: 0, b: 0 } };
  for (const b of balls) { const p = out[analytics.phaseOf(b.over_no, total)]; p.r += b.total_runs; if (b.is_legal) p.b++; }
  return out;
}

async function matchReport(id) {
  const s = await state.matchState(id);
  if (!s) return null;
  const c = await analytics.matchCharts(id);
  const allBalls = await db.all('SELECT b.*, i.innings_no FROM balls b JOIN innings i ON i.id = b.innings_id WHERE b.match_id = ? ORDER BY b.seq', [id]);
  const inn = s.innings;
  const labels = [...Array(s.overs)].map((_, i) => String(i + 1));
  const short = i => i.batting_team.short_name;

  // headline numbers
  const allBat = inn.flatMap(i => i.batting.map(b => ({ ...b, team: i.batting_team.name })));
  const allBowl = inn.flatMap(i => i.bowling.map(b => ({ ...b, team: i.bowling_team.name })));
  const top = allBat.slice().sort((a, b) => b.runs - a.runs || a.balls - b.balls)[0];
  const best = allBowl.slice().sort((a, b) => b.wickets - a.wickets || a.runs - b.runs)[0];
  const parts = c.innings.flatMap(i => i.partnerships.map(p => ({ ...p, team: i.team.short_name }))).sort((a, b) => b.runs - a.runs)[0];

  const perInn = inn.map(i => {
    const bs = allBalls.filter(b => b.innings_no === i.innings_no);
    const legal = bs.filter(b => b.is_legal);
    const dots = legal.filter(b => b.total_runs === 0).length;
    const fours = bs.filter(b => b.runs_bat === 4).length, sixes = bs.filter(b => b.runs_bat === 6).length;
    return { i, bs, legal: legal.length, dots, fours, sixes, boundaryRuns: fours * 4 + sixes * 6, phases: phaseRates(bs, s.overs) };
  });

  const tiles = [
    top ? [`${top.runs} (${top.balls})`, `Top score: ${top.name}`] : null,
    best ? [`${best.wickets}/${best.runs}`, `Best bowling: ${best.name}`] : null,
    parts ? [String(parts.runs), `Best partnership (${parts.team})`] : null,
    ...perInn.map(x => [`${pct(x.dots, x.legal)}%`, `Dot balls faced by ${short(x.i)}`]),
    ...perInn.map(x => [`${x.fours} / ${x.sixes}`, `4s / 6s by ${short(x.i)}`]),
  ].filter(Boolean);

  // tips for both teams, from the data
  const tips = [];
  for (const x of perInn) {
    const t = x.i.batting_team.name, ph = x.phases;
    const rr = k => (ph[k].b ? (ph[k].r * 6) / ph[k].b : null);
    const pp = rr('Powerplay'), mid = rr('Middle overs'), death = rr('Death overs');
    if (mid != null && pp != null && mid < pp - 1.5) tips.push(['work', `${t}: the middle overs slowed down`, `Run rate fell from ${pp.toFixed(1)} in the powerplay to ${mid.toFixed(1)} in the middle overs. Practise rotating the strike with singles into the gaps.`]);
    if (x.legal && pct(x.dots, x.legal) >= 45) tips.push(['work', `${t}: too many dot balls`, `${pct(x.dots, x.legal)}% of legal balls faced were dots. Aim to keep it under 40% by working the ball for ones and twos.`]);
    if (death != null && death >= 9) tips.push(['good', `${t}: strong finish`, `Scored at ${death.toFixed(1)} an over at the death. Keep the same finishers for close games.`]);
    const e = x.i.extras;
    if (e.total >= 10) tips.push(['work', `${x.i.bowling_team.name}: extras gave away ${e.total} runs`, `${e.wides} wides and ${e.noballs} no-balls. Work on line and the front-foot landing in the nets.`]);
  }
  const ballsOf = o => { const [a, x] = String(o).split('.'); return Number(a) * 6 + Number(x || 0); };
  for (const b of allBowl) if (ballsOf(b.overs) >= 12 && Number(b.econ) <= 5) tips.push(['good', `${b.name} kept it tight`, `Economy ${b.econ} from ${b.overs} overs for ${b.team}.`]);
  if (!tips.length) tips.push(['', 'Not enough balls yet', 'Tips appear once the match has more data.']);

  const body = `<header class="top"><div class="brand">Cric<b>Live</b> match report</div>
    <h1>${esc(s.team1.name)} v ${esc(s.team2.name)}</h1>
    <div class="meta">${esc(s.tournament_name || 'Friendly match')}, ${s.overs} overs a side${s.venue ? ` at ${esc(s.venue)}` : ''}. ${esc(fmtDate(s.match_date))}</div>
    <div class="result">${esc(s.result_text || s.status_text)}</div>${actions}</header>
  <h2>Scores</h2><div class="tiles">${inn.map(i => `<div class="tile"><div class="v">${i.runs}/${i.wickets}</div><div class="k">${esc(i.batting_team.name)} (${i.overs} ov, RR ${i.crr})</div></div>`).join('')}</div>
  <h2>Key numbers</h2><div class="tiles">${tiles.map(([v, k]) => `<div class="tile"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`).join('')}</div>
  <h2>How the match went</h2><div class="grid">
    ${columns({ title: 'Runs in each over (Manhattan)', sub: 'Both teams over by over', labels, series: c.innings.map(i => ({ name: i.team.short_name, values: labels.map((_, o) => { const p = i.per_over.find(x => x.over === o + 1); return p ? p.runs : 0; }) })) })}
    ${lines({ title: 'Worm: running total', sub: 'Dots show overs where wickets fell', labels, series: c.innings.map(i => ({ name: i.team.short_name, values: labels.map((_, o) => { const w = i.worm.find(x => x.over === o + 1); return w ? w.runs : null; }) })),
      markers: (j, o) => { const w = c.innings[j].worm.find(x => x.over === o + 1); return !!(w && w.wickets); } })}
    ${columns({ title: 'Run rate by phase', sub: 'Runs per over in each part of the innings', labels: ['Powerplay', 'Middle overs', 'Death overs'],
      series: perInn.map(x => ({ name: short(x.i), values: ['Powerplay', 'Middle overs', 'Death overs'].map(k => (x.phases[k].b ? Math.round((x.phases[k].r * 60) / x.phases[k].b) / 10 : 0)) })) })}
    ${columns({ title: 'How the runs were scored', sub: 'Singles, twos, threes, fours and sixes', labels: ['1s', '2s', '3s', '4s', '6s', 'Extras'],
      series: perInn.map(x => ({ name: short(x.i), values: [1, 2, 3, 4, 6].map(r => x.bs.filter(b => b.runs_bat === r).length * r).concat(x.i.extras.total) })) })}
    ${c.innings.map((i, j) => hbars({ title: `Partnerships: ${i.team.name}`, data: i.partnerships.map(p => ({ label: `${p.wicket}. ${p.label}`, value: p.runs })), color: j })).join('')}
  </div>
  <h2>What to work on</h2><ul class="tips">${tips.map(([k, t, d]) => `<li class="${k}"><b>${esc(t)}</b>${esc(d)}</li>`).join('')}</ul>
  <h2>Full scorecard</h2>${inn.map(i => `<div class="inn"><h3 style="margin-top:10px">${esc(i.batting_team.name)}: ${i.runs}/${i.wickets} (${i.overs} ov)</h3>
    <table><tr><th>Batter</th><th></th><th class="n">R</th><th class="n">B</th><th class="n">4s</th><th class="n">6s</th><th class="n">SR</th></tr>
    ${i.batting.map(b => `<tr><td>${esc(b.name)}</td><td style="color:var(--muted)">${esc(b.dismissal)}</td><td class="n"><b>${b.runs}</b></td><td class="n">${b.balls}</td><td class="n">${b.fours}</td><td class="n">${b.sixes}</td><td class="n">${b.sr}</td></tr>`).join('')}
    <tr><td>Extras</td><td style="color:var(--muted)">b ${i.extras.byes}, lb ${i.extras.legbyes}, w ${i.extras.wides}, nb ${i.extras.noballs}</td><td class="n">${i.extras.total}</td><td colspan="4"></td></tr></table>
    <table style="margin-top:8px"><tr><th>Bowler</th><th class="n">O</th><th class="n">M</th><th class="n">R</th><th class="n">W</th><th class="n">Econ</th></tr>
    ${i.bowling.map(b => `<tr><td>${esc(b.name)}</td><td class="n">${b.overs}</td><td class="n">${b.maidens}</td><td class="n">${b.runs}</td><td class="n"><b>${b.wickets}</b></td><td class="n">${b.econ}</td></tr>`).join('')}</table></div>`).join('')}`;
  return { filename: `criclive-match-${id}-${slug(s.team1.short_name + '-v-' + s.team2.short_name)}-report.html`, body: page(`${s.team1.name} v ${s.team2.name} - CricLive match report`, body) };
}

// ------------------------------------------------------------ player report
async function playerReport(pid) {
  const p = await state.playerProfile(pid);
  if (!p) return null;
  const ch = await analytics.playerCharts(pid);
  const { bat, bowl } = await playerInnings(pid);
  const faced = await db.all(`SELECT b.over_no, b.runs_bat, b.extra_type, b.is_legal, m.overs FROM balls b JOIN matches m ON m.id = b.match_id
      WHERE b.batsman_id = ? AND (b.extra_type IS NULL OR b.extra_type <> 'wd')`, [pid]);
  const bowled = await db.all(`SELECT b.over_no, b.total_runs, b.extra_type, b.is_legal, b.is_wicket, b.wicket_type, m.overs FROM balls b JOIN matches m ON m.id = b.match_id WHERE b.bowler_id = ?`, [pid]);
  const B = p.batting, W = p.bowling;

  const phases = ['Powerplay', 'Middle overs', 'Death overs'];
  const batPh = Object.fromEntries(phases.map(k => [k, { r: 0, b: 0 }]));
  for (const f of faced) { const x = batPh[analytics.phaseOf(f.over_no, f.overs)]; x.r += f.runs_bat; x.b++; }
  const bowlPh = Object.fromEntries(phases.map(k => [k, { r: 0, b: 0 }]));
  for (const f of bowled) { const x = bowlPh[analytics.phaseOf(f.over_no, f.overs)]; x.r += f.total_runs; if (f.is_legal) x.b++; }
  const dots = faced.filter(f => f.runs_bat === 0).length, boundaries = faced.filter(f => f.runs_bat >= 4).length;

  const tips = [];
  if (bat.length) {
    const dotPct = pct(dots, faced.length);
    if (dotPct >= 45) tips.push(['work', 'Turn dot balls into singles', `${dotPct}% of the balls you faced were dots. Good club batters keep this near 35-40%. Practise soft-hands pushes into the gaps.`]);
    else tips.push(['good', 'Good strike rotation', `Only ${dotPct}% dot balls - you keep the scoreboard moving.`]);
    const starts = bat.filter(r => r.runs >= 20 && r.runs < 50).length;
    if (starts >= 2) tips.push(['work', 'Convert your starts', `You passed 20 ${starts} times without reaching 50. After 20, take fewer risks and bat deeper.`]);
    const outs = {};
    for (const r of bat) if (r.is_out) outs[r.wicket_type] = (outs[r.wicket_type] || 0) + 1;
    const [how, n] = Object.entries(outs).sort((a, b) => b[1] - a[1])[0] || [];
    const total = Object.values(outs).reduce((a, b) => a + b, 0);
    const advice = { caught: 'Keep the ball along the ground early in your innings and pick your moment to go aerial.', bowled: 'Tighten your defence: play straight and watch the ball onto the bat.', lbw: 'Get your front foot across and play with the bat ahead of the pad.', run_out: 'Call early and clearly, and run the first run hard.', stumped: 'Against spin, use your feet only when you are sure of reaching the pitch of the ball.', caught_bowled: 'Watch for slower balls and play later, under your eyes.' };
    if (how && n >= 2) tips.push(['work', `Most common dismissal: ${how.replace('_', ' ')} (${n} of ${total})`, advice[how] || 'Review these dismissals on video.']);
    const sr1 = k => (batPh[k].b ? (batPh[k].r * 100) / batPh[k].b : null);
    const ppSr = sr1('Powerplay'), midSr = sr1('Middle overs'), deSr = sr1('Death overs');
    if (midSr != null && ppSr != null && midSr < ppSr - 25) tips.push(['work', 'Middle overs slow-down', `Your strike rate drops from ${ppSr.toFixed(0)} in the powerplay to ${midSr.toFixed(0)} in the middle overs. Target the gaps square of the wicket against spin.`]);
    if (deSr != null && deSr >= 150) tips.push(['good', 'Dangerous finisher', `Strike rate ${deSr.toFixed(0)} in the death overs.`]);
    if (pct(boundaries, faced.length) < 8 && faced.length >= 60) tips.push(['work', 'Find more boundaries', `Only ${pct(boundaries, faced.length)}% of your balls went for four or six. Work on power-hitting drills.`]);
  }
  if (bowl.length) {
    const legal = bowled.filter(b => b.is_legal).length;
    const wides = bowled.filter(b => b.extra_type === 'wd').length, nbs = bowled.filter(b => b.extra_type === 'nb').length;
    if (legal && (wides + nbs) / (legal / 6) >= 1) tips.push(['work', 'Cut out wides and no-balls', `${wides} wides and ${nbs} no-balls in ${overs(legal)} overs - about ${((wides + nbs) / (legal / 6)).toFixed(1)} an over. Bowl target practice to a marker.`]);
    const econ = Number(W.economy);
    if (econ && econ <= 6) tips.push(['good', 'Economical bowler', `Economy ${W.economy}. Captains can trust you with pressure overs.`]);
    else if (econ >= 8.5) tips.push(['work', 'Tighten your line', `Economy ${W.economy}. Bowl to your field and vary pace rather than length.`]);
    const de = bowlPh['Death overs'];
    if (de.b >= 12 && (de.r * 6) / de.b >= 10) tips.push(['work', 'Death bowling', `${((de.r * 6) / de.b).toFixed(1)} runs an over at the death. Practise yorkers and slower balls.`]);
  }
  if (ch.segment) tips.unshift(['', `AI player type: ${ch.segment.name}`, ch.segment.recommendation || ch.segment.description || '']);
  if (!tips.length) tips.push(['', 'Play a few matches first', 'Tips appear once you have batted or bowled in some matches.']);

  const inLabels = ch.innings.map(i => i.label);
  const body = `<header class="top"><div class="brand">Cric<b>Live</b> player report</div>
    <h1>${esc(p.name)}${p.jersey_no ? ` #${p.jersey_no}` : ''}</h1>
    <div class="meta">${esc(p.role || '')}${p.team ? `, ${esc(p.team.name)}` : ''}${p.batting_style ? `. ${esc(p.batting_style)}` : ''}${p.bowling_style ? `, ${esc(p.bowling_style)}` : ''}</div>
    ${ch.segment ? `<div class="result">AI player type: ${esc(ch.segment.name)}</div>` : ''}${actions}</header>
  <h2>Batting</h2><div class="tiles">${[['Matches', B.matches], ['Runs', B.runs], ['Average', B.average], ['Strike rate', B.strike_rate], ['Highest', B.highest], ['50s / 100s', `${B.fifties} / ${B.hundreds}`], ['4s / 6s', `${B.fours} / ${B.sixes}`], ['Dot balls', `${pct(dots, faced.length)}%`]].map(([k, v]) => `<div class="tile"><div class="v">${esc(v)}</div><div class="k">${k}</div></div>`).join('')}</div>
  <h2>Bowling and fielding</h2><div class="tiles">${[['Overs', W.overs], ['Wickets', W.wickets], ['Best', W.best], ['Economy', W.economy], ['Average', W.average], ['Catches', p.fielding.catches], ['Run outs', p.fielding.run_outs]].map(([k, v]) => `<div class="tile"><div class="v">${esc(v)}</div><div class="k">${k}</div></div>`).join('')}</div>
  <h2>Charts</h2><div class="grid">
    ${columns({ title: 'Runs in each innings', sub: 'Pale bars = not out', labels: ch.innings.map(i => String(i.n)), series: [{ name: 'Runs', values: ch.innings.map(i => i.runs), muted: ch.innings.map(i => i.not_out) }] })}
    ${lines({ title: 'Career runs', sub: 'Total after each innings', labels: ch.innings.map(i => String(i.n)), series: [{ name: 'Runs', values: ch.innings.map(i => i.cumulative) }] })}
    ${lines({ title: 'Strike rate in each innings', sub: 'Runs per 100 balls', labels: ch.innings.map(i => String(i.n)), series: [{ name: 'Strike rate', values: ch.innings.map(i => (i.balls ? Math.round((i.runs * 1000) / i.balls) / 10 : null)) }], markers: () => true })}
    ${columns({ title: 'Scoring shots', sub: 'Balls faced by result', labels: ch.scoring.map(x => x.label), series: [{ name: 'Balls', values: ch.scoring.map(x => x.value) }] })}
    ${columns({ title: 'Batting strike rate by phase', sub: 'Powerplay, middle and death overs', labels: phases, series: [{ name: 'Strike rate', values: phases.map(k => (batPh[k].b ? Math.round((batPh[k].r * 1000) / batPh[k].b) / 10 : 0)) }] })}
    ${hbars({ title: 'How you got out', data: ch.dismissals, color: 1 })}
    ${ch.bowling.length ? columns({ title: 'Wickets per match', labels: ch.bowling.map((_, i) => String(i + 1)), series: [{ name: 'Wickets', values: ch.bowling.map(b => b.wickets), color: COLORS[2] }] }) : ''}
    ${ch.bowling.length ? lines({ title: 'Economy per match', sub: 'Runs per over (lower is better)', labels: ch.bowling.map((_, i) => String(i + 1)), series: [{ name: 'Economy', values: ch.bowling.map(b => b.economy) }], markers: () => true }) : ''}
    ${ch.bowling.length ? columns({ title: 'Economy by phase', sub: 'Runs per over you conceded', labels: phases, series: [{ name: 'Economy', values: phases.map(k => (bowlPh[k].b ? Math.round((bowlPh[k].r * 60) / bowlPh[k].b) / 10 : 0)), color: COLORS[3] }] }) : ''}
  </div>
  <h2>Your improvement plan</h2><ul class="tips">${tips.map(([k, t, d]) => `<li class="${k}"><b>${esc(t)}</b>${esc(d)}</li>`).join('')}</ul>
  <h2>Every innings</h2><div class="inn"><table><tr><th>#</th><th>Match</th><th class="n">Runs</th><th class="n">Balls</th><th class="n">SR</th><th></th></tr>
    ${ch.innings.map((i, k) => `<tr><td>${i.n}</td><td>${esc(inLabels[k])}</td><td class="n"><b>${i.runs}${i.not_out ? '*' : ''}</b></td><td class="n">${i.balls}</td><td class="n">${sr(i.runs, i.balls)}</td><td></td></tr>`).join('') || '<tr><td colspan="6">No innings yet</td></tr>'}</table></div>`;
  return { filename: `criclive-${slug(p.name)}-report.html`, body: page(`${p.name} - CricLive player report`, body) };
}

module.exports = { matchBallsCsv, matchScorecardCsv, matchReport, playerCsv, playerReport, csvCell };
