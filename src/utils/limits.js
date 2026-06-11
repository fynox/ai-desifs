const db = require('../config/db');

// Limites mensuelles par plan (-1 = illimité, 0 = fonction non incluse).
// Les comptages s'appuient sur usage_log (déjà alimenté à chaque appel IA).
const PLAN_LIMITS = {
  smart: {
    analyses: 100,          // analyses IA / mois (manuelles — pas de mail dédié en Smart)
    relance: 30,            // mails de relance / mois
    devis: 30,              // devis auto / mois
    upscale: 0,             // amélioration HD non incluse
    import_catalogue: 0,    // import catalogue PDF non inclus
    mail_inbound: false,    // pas d'adresse mail dédiée
  },
  pro: {
    analyses: 300,
    relance: -1,
    devis: -1,
    upscale: 20,
    import_catalogue: 5,
    mail_inbound: true,
  },
  ultra: {
    analyses: -1,
    relance: -1,
    devis: -1,
    upscale: 100,
    import_catalogue: -1,
    mail_inbound: true,
  },
};

const PLAN_LABELS = { smart: 'Smart', pro: 'Pro', ultra: 'Ultra' };

// Plan effectif pour les limites : abonné → son plan ; essai gratuit → limites Smart
// (l'essai est déjà plafonné à 5 analyses au total par ailleurs).
function planKey(user) {
  if (user.subscription_status === 'active') return PLAN_LIMITS[user.plan] ? user.plan : 'pro';
  return 'smart';
}

function monthlyCount(userId, types) {
  const placeholders = types.map(() => '?').join(',');
  const row = db.prepare(
    `SELECT COUNT(*) as c FROM usage_log WHERE user_id = ? AND type IN (${placeholders}) AND created_at >= datetime('now','start of month')`
  ).get(userId, ...types);
  return row.c;
}

const FEATURE_TYPES = {
  analyses: ['analyse', 'analyse_email'],
  relance: ['relance'],
  devis: ['devis'],
  upscale: ['upscale'],
  import_catalogue: ['import_catalogue'],
};

const FEATURE_NAMES = {
  analyses: 'analyses IA',
  relance: 'mails de relance',
  devis: 'devis automatiques',
  upscale: 'améliorations HD',
  import_catalogue: 'imports de catalogue',
};

// Retourne null si OK, sinon { error } prêt à renvoyer en 403.
function checkLimit(user, feature) {
  const plan = planKey(user);
  const limit = PLAN_LIMITS[plan][feature];
  if (limit === -1) return null;
  const label = PLAN_LABELS[plan] || plan;
  if (limit === 0) {
    return { error: `🔒 ${FEATURE_NAMES[feature].charAt(0).toUpperCase() + FEATURE_NAMES[feature].slice(1)} : fonction non incluse dans le plan ${label}. Passez au plan supérieur pour en profiter.` };
  }
  const used = monthlyCount(user.id, FEATURE_TYPES[feature]);
  if (used >= limit) {
    return { error: `🔒 Limite mensuelle atteinte : ${used}/${limit} ${FEATURE_NAMES[feature]} ce mois-ci (plan ${label}). Passez au plan supérieur pour continuer.` };
  }
  return null;
}

// L'adresse mail dédiée (analyses automatiques par mail) est-elle incluse ?
function hasMailInbound(user) {
  return PLAN_LIMITS[planKey(user)].mail_inbound && user.subscription_status === 'active';
}

module.exports = { PLAN_LIMITS, checkLimit, hasMailInbound, planKey };
