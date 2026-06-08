const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH || './data/aidesifs.db';
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    api_key TEXT,
    stripe_customer_id TEXT,
    subscription_status TEXT DEFAULT 'inactive',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cat TEXT NOT NULL CHECK(cat IN ('imprimable','liner','dao')),
    nom TEXT NOT NULL,
    finition TEXT NOT NULL,
    adherence TEXT NOT NULL,
    env TEXT NOT NULL,
    duree TEXT NOT NULL,
    resistances TEXT DEFAULT '[]',
    applications TEXT DEFAULT '[]',
    note TEXT DEFAULT '',
    dispo INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mail_content TEXT,
    consignes TEXT DEFAULT '',
    result_json TEXT NOT NULL,
    source TEXT DEFAULT 'manual',
    lu INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

module.exports = db;
