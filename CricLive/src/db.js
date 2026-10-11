// =====================================================================
//  Database layer - one small API that works with SQLite OR MySQL.
//  Which one is used is decided by DB_CLIENT in the .env file.
//
//    db.all(sql, params)  -> array of rows
//    db.get(sql, params)  -> first row or undefined
//    db.run(sql, params)  -> { lastId, changes }
//    db.tx(async q => {}) -> runs the function inside a transaction
// =====================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CLIENT = (process.env.DB_CLIENT || 'sqlite').trim().toLowerCase();

let base = null;          // the API object bound to the main connection
let sqlite = null;        // node:sqlite DatabaseSync (when sqlite)
let pool = null;          // mysql2 pool (when mysql)
let queue = Promise.resolve(); // serialises write transactions

function clean(params) {
  return (params || []).map(v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
}

function wrapMysql(conn) {
  return {
    async all(sql, p) { const [rows] = await conn.query(sql, clean(p)); return rows; },
    async get(sql, p) { const [rows] = await conn.query(sql, clean(p)); return rows[0]; },
    async run(sql, p) { const [r] = await conn.query(sql, clean(p)); return { lastId: r.insertId, changes: r.affectedRows }; },
  };
}

function wrapSqlite(d) {
  const cache = new Map();
  const prep = sql => { let s = cache.get(sql); if (!s) { s = d.prepare(sql); cache.set(sql, s); } return s; };
  return {
    async all(sql, p) { return prep(sql).all(...clean(p)); },
    async get(sql, p) { return prep(sql).get(...clean(p)); },
    async run(sql, p) { const r = prep(sql).run(...clean(p)); return { lastId: Number(r.lastInsertRowid), changes: Number(r.changes) }; },
  };
}

function splitStatements(sql) {
  return sql
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    .split(';').map(s => s.trim()).filter(Boolean);
}

async function connect() {
  if (base) return base;
  if (CLIENT === 'mysql') {
    let mysql;
    try { mysql = require('mysql2/promise'); }
    catch (e) {
      console.error('\n[DB] DB_CLIENT=mysql but the "mysql2" package is not installed.\n     Run:  npm install mysql2   then start again.\n');
      process.exit(1);
    }
    const cfg = {
      host: process.env.MYSQL_HOST || 'localhost',
      port: Number(process.env.MYSQL_PORT || 3306),
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || '',
    };
    const dbName = process.env.MYSQL_DATABASE || 'criclive';
    const tmp = await mysql.createConnection(cfg);
    await tmp.query('CREATE DATABASE IF NOT EXISTS `' + dbName.replace(/`/g, '') + '` CHARACTER SET utf8mb4');
    await tmp.end();
    pool = mysql.createPool({ ...cfg, database: dbName, connectionLimit: 10, dateStrings: true, decimalNumbers: true });
    base = wrapMysql(pool);
    console.log(`[DB] Connected to MySQL database "${dbName}" on ${cfg.host}:${cfg.port}`);
  } else {
    let DatabaseSync;
    try { ({ DatabaseSync } = require('node:sqlite')); }
    catch (e) {
      console.error('\n[DB] Your Node.js version (' + process.version + ') has no built-in SQLite.\n     Install Node.js 22.13 LTS or newer from https://nodejs.org  (or set DB_CLIENT=mysql in .env)\n');
      process.exit(1);
    }
    const file = path.resolve(ROOT, process.env.SQLITE_FILE || './database/criclive.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    sqlite = new DatabaseSync(file);
    sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    base = wrapSqlite(sqlite);
    console.log(`[DB] Using SQLite database file: ${file}`);
  }
  await ensureSchema();
  return base;
}

async function ensureSchema() {
  const file = path.join(ROOT, 'database', CLIENT === 'mysql' ? 'schema.mysql.sql' : 'schema.sqlite.sql');
  const sql = fs.readFileSync(file, 'utf8');
  if (CLIENT === 'mysql') {
    for (const stmt of splitStatements(sql)) {
      try { await pool.query(stmt); }
      catch (e) { if (e.errno !== 1061) throw e; } // 1061 = index already exists
    }
  } else {
    sqlite.exec(sql);
  }
  await migrate();
}

// upgrade a database created by an older CricLive version (adds new columns)
async function migrate() {
  let cols;
  if (CLIENT === 'mysql') cols = (await pool.query("SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admins'"))[0];
  else cols = sqlite.prepare('PRAGMA table_info(admins)').all();
  if (!cols.some(c => c.name === 'email')) {
    const q = 'ALTER TABLE admins ADD COLUMN email VARCHAR(100)';
    if (CLIENT === 'mysql') await pool.query(q); else sqlite.exec(q);
    console.log('[DB] Upgraded: added admins.email (staff one-time codes are sent there)');
  }
}

async function dropAll() {
  const tables = ['feedback', 'otp_codes', 'audit_log', 'notifications', 'follows', 'player_stats', 'bowling_scores', 'batting_scores', 'balls', 'innings', 'match_players',
    'matches', 'tournament_teams', 'tournaments', 'players', 'teams', 'sessions', 'admins'];
  if (CLIENT === 'mysql') {
    await pool.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of tables) await pool.query('DROP TABLE IF EXISTS `' + t + '`');
    await pool.query('SET FOREIGN_KEY_CHECKS = 1');
  } else {
    sqlite.exec('PRAGMA foreign_keys = OFF');
    for (const t of tables) sqlite.exec('DROP TABLE IF EXISTS ' + t);
    sqlite.exec('PRAGMA foreign_keys = ON');
  }
  await ensureSchema();
}

// Run fn(q) in a transaction. Transactions are queued one after another so
// two scorers clicking at the same moment can never corrupt a score.
function tx(fn) {
  const job = async () => {
    if (CLIENT === 'mysql') {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const r = await fn(wrapMysql(conn));
        await conn.commit();
        return r;
      } catch (e) { await conn.rollback(); throw e; }
      finally { conn.release(); }
    }
    sqlite.exec('BEGIN IMMEDIATE');
    try { const r = await fn(base); sqlite.exec('COMMIT'); return r; }
    catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  };
  const p = queue.then(job, job);
  queue = p.catch(() => {});
  return p;
}

async function close() {
  if (pool) await pool.end();
  if (sqlite) sqlite.close();
  base = null;
}

module.exports = {
  CLIENT, connect, tx, dropAll, close,
  all: (s, p) => base.all(s, p),
  get: (s, p) => base.get(s, p),
  run: (s, p) => base.run(s, p),
};
