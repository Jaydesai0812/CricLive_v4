// =====================================================================
//  Live updates with Server-Sent Events (built into every browser).
//  Every open page keeps one connection to /api/live. When the scorer
//  records a ball, the new scoreboard is pushed to ALL viewers instantly.
// =====================================================================
const clients = new Set();

function subscribe(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const client = { res, match: req.query.match ? Number(req.query.match) : null };
  clients.add(client);
  req.on('close', () => clients.delete(client));
}

function send(c, event, data) {
  try { c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { clients.delete(c); }
}

// full scoreboard to viewers of that match + summary card to everyone
function publishMatch(state, summary) {
  for (const c of clients) {
    if (c.match === state.id) send(c, 'match', state);
    send(c, 'summary', summary);
  }
}

// tell every page which players' career stats just changed
function publishStats(playerIds) {
  if (!playerIds || !playerIds.length) return;
  for (const c of clients) send(c, 'stats', { players: playerIds });
}

// match alerts (wicket, fifty, result ...) to every open page
function publishAlert(alert) {
  for (const c of clients) send(c, 'alert', alert);
}

setInterval(() => { for (const c of clients) { try { c.res.write(': ping\n\n'); } catch { clients.delete(c); } } }, 25000).unref();

module.exports = { subscribe, publishMatch, publishStats, publishAlert, count: () => clients.size };
