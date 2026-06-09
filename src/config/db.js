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

// Migrations — safe to run multiple times
const migrations = [
  'ALTER TABLE users ADD COLUMN trial_analyses_used INTEGER DEFAULT 0',
  'ALTER TABLE users ADD COLUMN inbound_email TEXT',
  'ALTER TABLE analyses ADD COLUMN visuel_b64 TEXT',
  'ALTER TABLE analyses ADD COLUMN visuel_type TEXT',
];
for (const sql of migrations) {
  try { db.exec(sql); } catch {}
}

// Migrate inbound_email from @ai-dhesif.fr to @mail.ai-dhesif.fr
db.prepare(`UPDATE users SET inbound_email = REPLACE(inbound_email, '@ai-dhesif.fr', '@mail.ai-dhesif.fr') WHERE inbound_email LIKE '%@ai-dhesif.fr'`).run();

// Migration stock : remplacer la table pour élargir les catégories autorisées
try {
  const cols = db.prepare(`PRAGMA table_info(stock)`).all().map(c => c.name);
  // Vérifier si la contrainte est encore restrictive en testant un INSERT fictif
  db.prepare(`BEGIN`).run();
  try {
    db.prepare(`INSERT INTO stock (user_id,cat,nom,finition,adherence,env,duree) VALUES (0,'vitre','_test_','Brillant','Standard','Intérieur','1 an')`).run();
    db.prepare(`DELETE FROM stock WHERE nom='_test_'`).run();
    db.prepare(`COMMIT`).run();
  } catch {
    db.prepare(`ROLLBACK`).run();
    // La contrainte bloque les nouvelles catégories → recréer la table
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE stock_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        cat TEXT NOT NULL CHECK(cat IN ('imprimable','liner','dao','transfert','covering','vitre','panneau')),
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
      INSERT INTO stock_new SELECT * FROM stock;
      DROP TABLE stock;
      ALTER TABLE stock_new RENAME TO stock;
      PRAGMA foreign_keys = ON;
    `);
    console.log('Migration stock: nouvelles catégories activées');
  }
} catch (e) {
  console.error('Migration stock error:', e.message);
}

module.exports = db;
