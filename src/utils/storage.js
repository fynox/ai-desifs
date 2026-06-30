const db = require('../config/db');
const { PLAN_INFO } = require('./plans');

const GO = 1e9;
const TRIAL_QUOTA = 200e6; // 200 Mo en essai gratuit

// Espace occupé par les visuels d'un utilisateur (octets réels ≈ longueur base64 × 3/4)
function getStorage(userId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(
      COALESCE(LENGTH(visuel_b64),0) + COALESCE(LENGTH(visuel_orig_b64),0) + COALESCE(LENGTH(visuel_hd_b64),0) + COALESCE(LENGTH(visuels_json),0)
    ),0) as b64len
    FROM analyses WHERE user_id = ?
  `).get(userId);
  const user = db.prepare('SELECT plan, subscription_status, bonus_go FROM users WHERE id = ?').get(userId) || {};
  let quota, plan;
  if (user.subscription_status === 'active' && PLAN_INFO[user.plan]) {
    plan = user.plan;
    quota = (PLAN_INFO[plan].go + (user.bonus_go || 0)) * GO;
  } else if (user.subscription_status === 'trial') {
    plan = 'trial'; quota = TRIAL_QUOTA + (user.bonus_go || 0) * GO;
  } else {
    plan = 'free'; quota = TRIAL_QUOTA;
  }
  return { used: Math.round(row.b64len * 0.75), quota, plan, bonus_go: user.bonus_go || 0 };
}

function isStorageFull(userId) {
  const s = getStorage(userId);
  return s.used >= s.quota;
}

module.exports = { getStorage, isStorageFull };
