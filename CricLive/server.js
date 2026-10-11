// =====================================================================
//  CricLive v4 - live cricket scoring website
//  Start with:   npm start      then open  http://localhost:3000
// =====================================================================
const http = require('http');
const path = require('path');
const fs = require('fs');

// load settings from .env (built into Node 21.7+)
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
// replace the example secret with a long random one the first time (used to hash sign-in codes)
if (!process.env.SESSION_SECRET || /change-this/.test(process.env.SESSION_SECRET)) {
  process.env.SESSION_SECRET = require('crypto').randomBytes(32).toString('hex');
  try {
    const txt = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
    fs.writeFileSync(envFile, /^SESSION_SECRET=.*$/m.test(txt) ? txt.replace(/^SESSION_SECRET=.*$/m, 'SESSION_SECRET=' + process.env.SESSION_SECRET) : txt + '\nSESSION_SECRET=' + process.env.SESSION_SECRET + '\n');
  } catch { /* read-only folder: keep the random secret for this run */ }
}

const db = require('./src/db');
const { createApp } = require('./src/http');
const routes = require('./src/routes');

async function main() {
  await db.connect();

  // first run: put demo data in an empty database so the site is not blank
  const admins = await db.get('SELECT COUNT(*) AS n FROM admins');
  if (Number(admins.n) === 0) {
    console.log('[DB] Empty database - loading demo data (teams, players, matches)...');
    await require('./src/seed').seed({ demo: true, keepConnection: true });
  }

  // a database from the older London version still has the old demo clubs
  if (await db.get("SELECT id FROM teams WHERE name = 'Camden Kestrels'")) {
    console.log('\n  [!] This database still has the OLD demo data (London clubs).');
    console.log('      To load the new demo data: stop the server, delete database/criclive.db, start again.\n');
  }
  const { DEMO } = require('./src/seed');
  const mailer = require('./src/mailer');
  const PORT = Number(process.env.PORT || 3000);
  const server = http.createServer(createApp(routes, path.join(__dirname, 'public')));
  server.listen(PORT, () => {
    console.log('');
    console.log('  CricLive is running!');
    console.log(`  Website (viewers) : http://localhost:${PORT}`);
    console.log(`  Admin / scoring   : http://localhost:${PORT}/admin`);
    console.log(`  Demo logins       : admin / ${DEMO.admin}   scorer / ${DEMO.scorer}`);
    console.log(`                      oliver.brown@criclive.test / ${DEMO.player}`);
    console.log(mailer.devMode()
      ? '  Sign-in codes     : development mode - codes are shown on screen and printed here\n                      (add SMTP_... settings to .env to e-mail them for real)'
      : `  Sign-in codes     : e-mailed through ${process.env.SMTP_HOST}`);
    console.log('');
  });
  server.on('error', e => {
    if (e.code === 'EADDRINUSE') console.error(`\nPort ${PORT} is already in use. Change PORT in .env or close the other program.\n`);
    else console.error(e);
    process.exit(1);
  });
}

main().catch(e => {
  console.error('\nCould not start CricLive:\n ', e.message);
  if (db.CLIENT === 'mysql') console.error('  Check MYSQL_HOST / MYSQL_USER / MYSQL_PASSWORD in .env and that MySQL is running (XAMPP: start MySQL).');
  process.exit(1);
});
