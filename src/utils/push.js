const db = require('../config/db');
const { getSetting, setSetting } = require('./appSettings');

// Notifications push natives (téléphone/PC, même app fermée).
// Les clés VAPID sont générées UNE FOIS au premier démarrage et conservées en base :
// aucune configuration manuelle nécessaire.
let webpush = null;
try { webpush = require('web-push'); } catch { console.error('web-push non installé'); }

db.exec(`CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT UNIQUE NOT NULL,
  sub_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
)`);

function ensureVapid() {
  if (!webpush) return null;
  let pub = getSetting('VAPID_PUBLIC'), priv = getSetting('VAPID_PRIVATE');
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey; priv = keys.privateKey;
    setSetting('VAPID_PUBLIC', pub);
    setSetting('VAPID_PRIVATE', priv);
    console.log('Clés VAPID générées (notifications push activées)');
  }
  webpush.setVapidDetails('mailto:' + ((process.env.ADMIN_EMAILS || 'contact@ai-dhesif.fr').split(',')[0].trim()), pub, priv);
  return pub;
}

function publicKey() { return ensureVapid(); }

function saveSub(userId, sub) {
  if (!sub || !sub.endpoint) throw new Error('Abonnement invalide.');
  db.prepare('INSERT INTO push_subs (user_id, endpoint, sub_json) VALUES (?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, sub_json=excluded.sub_json')
    .run(userId, sub.endpoint, JSON.stringify(sub));
}
function removeSub(endpoint) {
  db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(String(endpoint || ''));
}

// Envoi (silencieusement ignoré si rien n'est configuré) ; les abonnements morts sont purgés
function pushTo(userId, titre, corps, url) {
  if (!webpush) return;
  const subs = db.prepare('SELECT endpoint, sub_json FROM push_subs WHERE user_id = ?').all(userId);
  if (!subs.length) return;
  ensureVapid();
  const payload = JSON.stringify({ titre, corps, url: url || '/app' });
  for (const s of subs) {
    webpush.sendNotification(JSON.parse(s.sub_json), payload).catch(err => {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) removeSub(s.endpoint);
    });
  }
}

module.exports = { publicKey, saveSub, removeSub, pushTo };
