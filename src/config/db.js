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
    subscription_status TEXT DEFAULT 'trial',
    trial_analyses_used INTEGER DEFAULT 0,
    inbound_email TEXT UNIQUE,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cat TEXT NOT NULL CHECK(cat IN ('imprimable','liner','dao','transfert','covering','vitre','panneau','encre')),
    nom TEXT NOT NULL,
    finition TEXT NOT NULL,
    adherence TEXT NOT NULL,
    env TEXT NOT NULL,
    duree TEXT NOT NULL,
    resistances TEXT DEFAULT '[]',
    applications TEXT DEFAULT '[]',
    largeurs TEXT DEFAULT '[]',
    couleurs TEXT DEFAULT '[]',
    variantes TEXT DEFAULT '[]',
    prix_m2 REAL,
    note TEXT DEFAULT '',
    dispo INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bug_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    email TEXT,
    message TEXT NOT NULL,
    images TEXT DEFAULT '[]',
    status TEXT DEFAULT 'new',
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

// Migrations — safe to run multiple times
const migrations = [
  'ALTER TABLE users ADD COLUMN trial_analyses_used INTEGER DEFAULT 0',
  'ALTER TABLE users ADD COLUMN inbound_email TEXT',
  'ALTER TABLE analyses ADD COLUMN visuel_b64 TEXT',
  'ALTER TABLE analyses ADD COLUMN visuel_type TEXT',
  'ALTER TABLE stock ADD COLUMN largeurs TEXT DEFAULT \'[]\'',
  'ALTER TABLE stock ADD COLUMN couleurs TEXT DEFAULT \'[]\'',
  'ALTER TABLE stock ADD COLUMN prix_m2 REAL',
  'ALTER TABLE analyses ADD COLUMN status TEXT DEFAULT \'done\'',
  'ALTER TABLE bug_reports ADD COLUMN images TEXT DEFAULT \'[]\'',
  'ALTER TABLE stock ADD COLUMN variantes TEXT DEFAULT \'[]\'',
];
for (const sql of migrations) {
  try { db.exec(sql); } catch {}
}

// Migrate inbound_email from @ai-dhesif.fr to @mail.ai-dhesif.fr
db.prepare(`UPDATE users SET inbound_email = REPLACE(inbound_email, '@ai-dhesif.fr', '@mail.ai-dhesif.fr') WHERE inbound_email LIKE '%@ai-dhesif.fr'`).run();

// Migration stock : élargir les catégories si l'ancienne contrainte est encore présente
try {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='stock'`).get();
  const needsMigration = row && row.sql && !row.sql.includes("'encre'");
  if (needsMigration) {
    const hadNewCols = row.sql.includes('largeurs');
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE stock_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        cat TEXT NOT NULL CHECK(cat IN ('imprimable','liner','dao','transfert','covering','vitre','panneau','encre')),
        nom TEXT NOT NULL,
        finition TEXT NOT NULL,
        adherence TEXT NOT NULL,
        env TEXT NOT NULL,
        duree TEXT NOT NULL,
        resistances TEXT DEFAULT '[]',
        applications TEXT DEFAULT '[]',
        largeurs TEXT DEFAULT '[]',
        couleurs TEXT DEFAULT '[]',
        prix_m2 REAL,
        note TEXT DEFAULT '',
        dispo INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO stock_new SELECT id,user_id,cat,nom,finition,adherence,env,duree,resistances,applications,${hadNewCols ? 'largeurs,couleurs,prix_m2' : `'[]','[]',NULL`},note,dispo,created_at FROM stock;
      DROP TABLE stock;
      ALTER TABLE stock_new RENAME TO stock;
    `);
    db.pragma('foreign_keys = ON');
    console.log('Migration stock: catégorie encre activée');
  }
} catch (e) {
  console.error('Migration stock error:', e.message);
}

module.exports = db;
