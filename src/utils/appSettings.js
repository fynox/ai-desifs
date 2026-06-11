const db = require('../config/db');

// Réglages globaux de l'application (clés API…), stockés en base par l'admin.
// La valeur en base prime, la variable d'environnement Railway sert de secours.
function getSetting(key) {
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    if (row && row.value) return row.value;
  } catch {}
  return process.env[key] || null;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

module.exports = { getSetting, setSetting };
