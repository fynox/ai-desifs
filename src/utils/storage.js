const db = require('../config/db');

// Quotas de stockage des visuels par plan (en octets)
const STORAGE_QUOTAS = {
  free: 200e6,   // 200 Mo
  trial: 200e6,
  smart: 500e6,  // 500 Mo
  pro: 2e9,      // 2 Go
  ultra: 5e9,    // 5 Go
};

// Espace occupé par les visuels d'un utilisateur (octets réels ≈ longueur base64 × 3/4)
function getStorage(userId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(
      COALESCE(LENGTH(visuel_b64),0) + COALESCE(LENGTH(visuel_orig_b64),0) + COALESCE(LENGTH(visuel_hd_b64),0)
    ),0) as b64len
    FROM analyses WHERE user_id = ?
  `).get(userId);
  const user = db.prepare('SELECT plan, subscription_status FROM users WHERE id = ?').get(userId) || {};
  const plan = user.subscription_status === 'active' ? (user.plan || 'pro') : (user.subscription_status === 'trial' ? 'trial' : 'free');
  const quota = STORAGE_QUOTAS[plan] || STORAGE_QUOTAS.free;
  return { used: Math.round(row.b64len * 0.75), quota, plan };
}

function isStorageFull(userId) {
  const s = getStorage(userId);
  return s.used >= s.quota;
}

module.exports = { getStorage, isStorageFull, STORAGE_QUOTAS };
