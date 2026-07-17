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
    cat TEXT NOT NULL CHECK(cat IN ('imprimable','plastification','dao','transfert','covering','vitre','panneau','encre')),
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

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    type TEXT NOT NULL,
    model TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    own_key INTEGER DEFAULT 0,
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
  'ALTER TABLE users ADD COLUMN plan TEXT DEFAULT \'free\'',
  'ALTER TABLE users ADD COLUMN plan_period TEXT DEFAULT \'monthly\'',
  'ALTER TABLE users ADD COLUMN plan_override INTEGER DEFAULT 0',
  'ALTER TABLE analyses ADD COLUMN devis_json TEXT',
  'ALTER TABLE users ADD COLUMN settings TEXT DEFAULT \'{}\'',
  'ALTER TABLE analyses ADD COLUMN visuel_orig_b64 TEXT',
  'ALTER TABLE analyses ADD COLUMN visuel_orig_type TEXT',
  'ALTER TABLE analyses ADD COLUMN visuel_hd_b64 TEXT',
  'ALTER TABLE analyses ADD COLUMN visuel_hd_type TEXT',
  'ALTER TABLE analyses ADD COLUMN visuels_json TEXT',
  'ALTER TABLE analyses ADD COLUMN error_msg TEXT',
  'ALTER TABLE users ADD COLUMN jetons INTEGER DEFAULT 0',     // portefeuille de jetons achetés (cumulables)
  'ALTER TABLE users ADD COLUMN bonus_go INTEGER DEFAULT 0',   // Go de stockage achetés en plus (par tranche de 2)
  'ALTER TABLE usage_log ADD COLUMN jetons INTEGER DEFAULT 0', // jetons consommés depuis l\'allocation mensuelle du forfait
  'ALTER TABLE users ADD COLUMN devis_pref TEXT DEFAULT \'\'',  // apprentissage des prix : JSON {ratio, n} (prix perso / prix proposé)
  'ALTER TABLE users ADD COLUMN devis_infos TEXT DEFAULT \'\'', // infos émetteur mémorisées pour le PDF de devis (JSON)
  // Comptes employés (plan Entreprise) : rattachés à l'employeur, avec un rôle métier
  'ALTER TABLE users ADD COLUMN parent_user_id INTEGER',        // id de l'employeur (null = compte principal)
  'ALTER TABLE users ADD COLUMN role TEXT DEFAULT \'owner\'',   // owner | preparateur | poseur
  // Affectation d'une analyse en mission (préparation / pose)
  'ALTER TABLE analyses ADD COLUMN assigned_prep_id INTEGER',   // employé chargé de la préparation
  'ALTER TABLE analyses ADD COLUMN assigned_pose_id INTEGER',   // employé chargé de la pose
  'ALTER TABLE analyses ADD COLUMN job_date TEXT',              // date d intervention
  'ALTER TABLE analyses ADD COLUMN job_lieu TEXT',              // lieu de pose
  'ALTER TABLE analyses ADD COLUMN job_status TEXT',            // a_preparer | pret_a_poser | termine
  'ALTER TABLE analyses ADD COLUMN job_photos_json TEXT',       // photos du résultat posé (jointes par le poseur)
  'ALTER TABLE analyses ADD COLUMN assigned_design_id INTEGER', // employé designer (création du visuel)
  'ALTER TABLE analyses ADD COLUMN assigned_secr_id INTEGER',   // employé secrétariat (devis / retours client)
  'ALTER TABLE analyses ADD COLUMN prep_note TEXT',             // note du préparateur pour le poseur (précisions sur les lés, etc.)
  // Réinitialisation de mot de passe par mail
  'ALTER TABLE users ADD COLUMN reset_token TEXT',
  'ALTER TABLE users ADD COLUMN reset_expires TEXT',
  // Suivi commercial des devis
  'ALTER TABLE analyses ADD COLUMN devis_status TEXT',          // envoye | accepte | refuse (null = pas encore envoyé)
  'ALTER TABLE analyses ADD COLUMN devis_sent_at TEXT',         // date d envoi du devis au client
  'ALTER TABLE analyses ADD COLUMN client_email TEXT',          // adresse mail du client (fiche client)
  // Alerte stock bas
  'ALTER TABLE stock ADD COLUMN quantite_m2 REAL',              // quantité restante estimée (m² ou ml, au choix de l utilisateur)
  'ALTER TABLE stock ADD COLUMN seuil_alerte REAL',             // en dessous → alerte stock bas
];
for (const sql of migrations) {
  try { db.exec(sql); } catch {}
}

// Adresse inbound sur le domaine racine @ai-dhesif.fr : on annule l'ancienne bascule vers @mail.ai-dhesif.fr
db.prepare(`UPDATE users SET inbound_email = REPLACE(inbound_email, '@mail.ai-dhesif.fr', '@ai-dhesif.fr') WHERE inbound_email LIKE '%@mail.ai-dhesif.fr'`).run();

// Fiches clients : renseigner client_email sur les analyses existantes reçues par mail.
// Mail transféré → l'expéditeur d'origine est dans le corps ("De :/From: ... <adresse>") ;
// sinon → l'adresse de la 1re ligne ("De : ..."), sauf si c'est l'utilisateur lui-même.
try {
  const rows = db.prepare(`
    SELECT a.id, a.mail_content, u.email AS user_email
    FROM analyses a JOIN users u ON u.id = a.user_id
    WHERE a.client_email IS NULL AND a.mail_content LIKE 'De :%'
  `).all();
  const upd = db.prepare('UPDATE analyses SET client_email = ? WHERE id = ?');
  for (const r of rows) {
    const txt = r.mail_content || '';
    const body = txt.split('\n').slice(1).join('\n');
    const fwd = body.match(/(?:De|From)\s*:\s*[^\n<]*<([\w.+-]+@[\w-]+\.[\w.-]+)>/i) || body.match(/(?:De|From)\s*:\s*([\w.+-]+@[\w-]+\.[\w.-]+)/i);
    let email = fwd ? fwd[1].toLowerCase() : null;
    if (!email) {
      const first = (txt.split('\n')[0] || '').match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
      if (first && first[0].toLowerCase() !== (r.user_email || '').toLowerCase()) email = first[0].toLowerCase();
    }
    if (email) upd.run(email, r.id);
  }
} catch {}

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

// Migration : renommer la catégorie 'liner' en 'plastification' (clé + données)
try {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='stock'`).get();
  if (row && row.sql && !row.sql.includes("'plastification'")) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE stock_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        cat TEXT NOT NULL CHECK(cat IN ('imprimable','plastification','dao','transfert','covering','vitre','panneau','encre')),
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
      INSERT INTO stock_new SELECT id,user_id,
        CASE WHEN cat='liner' THEN 'plastification' ELSE cat END,
        nom,finition,adherence,env,duree,resistances,applications,largeurs,couleurs,variantes,prix_m2,note,dispo,created_at FROM stock;
      DROP TABLE stock;
      ALTER TABLE stock_new RENAME TO stock;
    `);
    db.pragma('foreign_keys = ON');
    console.log('Migration stock: liner → plastification');
  }
} catch (e) {
  console.error('Migration plastification error:', e.message);
}

module.exports = db;
