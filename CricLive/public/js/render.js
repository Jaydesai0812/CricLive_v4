// =====================================================================
//  Scoreboard / scorecard renderers (used by match page AND admin console)
// =====================================================================
const ballChip = b => `<span class="bb ${b.kind}">${esc(b.label)}</span>`;

function renderScoreboard(s) {
  const t1 = s.team1, t2 = s.team2;
  const innFor = id => s.innings.filter(i => i.batting_team.id === id);
  const line = t => {
    const inn = innFor(t.id)[0];
    const batting = inn && inn.status === 'in_progress' && s.status === 'live';
    let score = '<span class="ov">Yet to bat</span>';
    if (inn && (inn.legal_balls > 0 || inn.runs > 0 || inn.status === 'completed')) score = `<span class="big">${inn.runs}/${inn.wickets}</span><span class="ov">(${inn.overs} ov)</span>`;
    return `<div class="team-line ${batting ? 'batting' : ''}">${teamLogo(t)}<span class="nm">${esc(t.name)}</span>${score}</div>`;
  };
  const cur = s.innings.find(i => i.innings_no === s.current && i.status === 'in_progress');
  let rates = '';
  if (cur && s.status === 'live') {
    rates = `<span>CRR: <b>${cur.crr}</b></span>`;
    if (cur.target) rates += `<span>Target: <b>${cur.target}</b></span><span>RRR: <b>${cur.rrr ?? '-'}</b></span>`;
    if (cur.partnership) rates += `<span>Partnership: <b>${cur.partnership.runs} (${cur.partnership.balls})</b></span>`;
  }
  const stBadge = s.status === 'live' ? '<span class="badge live">Live</span>' : s.status === 'completed' ? '<span class="badge done">Result</span>' : '<span class="badge">Upcoming</span>';
  return `<div class="scoreboard" id="scoreboard">
    <div class="meta">${stBadge}<span>${esc(s.tournament_name || 'Friendly match')}</span><span>&middot; ${s.overs} overs</span>
      ${s.venue ? `<span>&middot; ${esc(s.venue)}</span>` : ''}<span>&middot; ${fmtDate(s.match_date)}</span></div>
    <div class="teams">${line(t1)}${line(t2)}</div>
    <div class="status">${esc(s.status_text)}</div>
    ${rates ? `<div class="rates">${rates}</div>` : ''}
  </div>`;
}

function renderCrease(s) {
  const cur = s.innings.find(i => i.innings_no === s.current && i.status === 'in_progress');
  if (!cur) return '';
  const bats = cur.batting.filter(b => b.dismissal === 'batting').sort((a, b) => (b.on_strike ? 1 : 0) - (a.on_strike ? 1 : 0));
  const bowler = cur.bowling.find(b => b.bowling);
  const batRows = bats.length ? bats.map(b => `<tr><td><a href="/player.html?id=${b.id}" class="${b.on_strike ? 'strike' : ''}">${esc(b.name)}</a></td>
      <td class="num"><b>${b.runs}</b></td><td class="num">${b.balls}</td><td class="num">${b.fours}</td><td class="num">${b.sixes}</td><td class="num">${b.sr}</td></tr>`).join('')
    : '<tr><td colspan="6" class="muted">Waiting for batsmen...</td></tr>';
  const bowlRow = bowler ? `<tr><td><a href="/player.html?id=${bowler.id}">${esc(bowler.name)}</a></td><td class="num">${bowler.overs}</td><td class="num">${bowler.maidens}</td>
      <td class="num">${bowler.runs}</td><td class="num"><b>${bowler.wickets}</b></td><td class="num">${bowler.econ}</td></tr>` : '<tr><td colspan="6" class="muted">New over - waiting for bowler...</td></tr>';
  return `<div class="table-wrap"><table class="crease">
      <tr><th>Batter</th><th class="num">R</th><th class="num">B</th><th class="num">4s</th><th class="num">6s</th><th class="num">SR</th></tr>${batRows}
      <tr><th>Bowler</th><th class="num">O</th><th class="num">M</th><th class="num">R</th><th class="num">W</th><th class="num">Econ</th></tr>${bowlRow}
    </table></div>
    <div style="margin-top:12px"><div class="small muted" style="margin-bottom:6px">This over</div>
    <div class="over-balls">${cur.this_over.length ? cur.this_over.map(ballChip).join('') : '<span class="muted small">-</span>'}</div></div>`;
}

function renderCommentary(s, prevSeq = 0) {
  if (!s.commentary.length) return '<div class="empty">No balls bowled yet.</div>';
  let lastInn = null;
  return `<ul class="commentary">${s.commentary.map(c => {
    const inn = s.innings.find(i => i.innings_no === c.innings_no);
    const head = c.innings_no !== lastInn && inn ? `<li class="innings-head" style="border:none">${teamDot(inn.batting_team)}${esc(inn.batting_team.name)} - ${c.innings_no === 1 ? '1st' : '2nd'} innings</li>` : '';
    lastInn = c.innings_no;
    return `${head}<li class="${c.seq > prevSeq && prevSeq ? 'new' : ''}">
      <span class="ov">${c.over}</span>${ballChip(c)}<span class="txt">${esc(c.text)}</span></li>`;
  }).join('')}</ul>`;
}

function renderScorecard(s) {
  if (!s.innings.length) return '<div class="empty">Scorecard will appear when the match starts.</div>';
  return s.innings.map(i => {
    const bat = i.batting.map(b => `<tr><td><a href="/player.html?id=${b.id}">${esc(b.name)}</a><div class="dismissal">${esc(b.dismissal)}</div></td>
        <td class="num"><b>${b.runs}</b></td><td class="num">${b.balls}</td><td class="num">${b.fours}</td><td class="num">${b.sixes}</td><td class="num">${b.sr}</td></tr>`).join('');
    const e = i.extras;
    const bowl = i.bowling.map(b => `<tr><td><a href="/player.html?id=${b.id}">${esc(b.name)}</a></td><td class="num">${b.overs}</td><td class="num">${b.maidens}</td>
        <td class="num">${b.runs}</td><td class="num"><b>${b.wickets}</b></td><td class="num">${b.econ}</td><td class="num">${b.wides}</td><td class="num">${b.noballs}</td></tr>`).join('');
    const fow = i.fall_of_wickets.map(f => `${f.runs}-${f.wicket} (${esc(f.player)}, ${f.over} ov)`).join(', ');
    return `<div class="innings-head"><span>${teamDot(i.batting_team)}${esc(i.batting_team.name)} - ${i.innings_no === 1 ? '1st' : '2nd'} innings</span>
        <span class="num">${i.runs}/${i.wickets} (${i.overs} ov)</span></div>
      <div class="table-wrap"><table>
        <tr><th>Batter</th><th class="num">R</th><th class="num">B</th><th class="num">4s</th><th class="num">6s</th><th class="num">SR</th></tr>
        ${bat || '<tr><td colspan="6" class="muted">Yet to bat</td></tr>'}
        <tr><td>Extras <span class="dismissal">(b ${e.byes}, lb ${e.legbyes}, w ${e.wides}, nb ${e.noballs})</span></td><td class="num"><b>${e.total}</b></td><td colspan="4"></td></tr>
        <tr><td><b>Total</b></td><td class="num"><b>${i.runs}/${i.wickets}</b></td><td colspan="4" class="muted">(${i.overs} overs, RR ${i.crr})</td></tr>
      </table></div>
      ${i.yet_to_bat.length ? `<p class="small"><b>Yet to bat:</b> ${i.yet_to_bat.map(p => esc(p.name)).join(', ')}</p>` : ''}
      ${fow ? `<p class="small"><b>Fall of wickets:</b> ${fow}</p>` : ''}
      <div class="table-wrap"><table>
        <tr><th>Bowler</th><th class="num">O</th><th class="num">M</th><th class="num">R</th><th class="num">W</th><th class="num">Econ</th><th class="num">WD</th><th class="num">NB</th></tr>
        ${bowl || '<tr><td colspan="8" class="muted">-</td></tr>'}
      </table></div>`;
  }).join('');
}

function renderSquads(s) {
  const side = t => {
    const list = (s.xi[t.id] && s.xi[t.id].length) ? s.xi[t.id] : (s.squads[t.id] || []);
    const title = (s.xi[t.id] && s.xi[t.id].length) ? 'Playing XI' : 'Squad';
    return `<div class="card"><h3>${teamDot(t)}${esc(t.name)} <span class="muted small">${title}</span></h3>
      ${list.map(p => `<div class="leader-row"><a href="/player.html?id=${p.id}">${esc(p.name)}</a><span class="muted small">${esc(p.role || '')}</span></div>`).join('') || '<div class="muted">No players</div>'}</div>`;
  };
  return `<div class="grid grid-2">${side(s.team1)}${side(s.team2)}</div>`;
}

// celebrations (FOUR / SIX / WICKET / WIN) now live in fx.js
function popEvent() {}
