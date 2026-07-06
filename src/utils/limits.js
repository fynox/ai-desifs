const db = require('../config/db');
const { PLAN_INFO, JETON_COSTS, JETON_LABELS, FEATURE_MIN_PLAN, planHasFeature } = require('./plans');

const FEATURE_NAMES = {
  devis: 'devis automatique',
  relance: 'mail au client',
  upscale: 'amélioration HD',
  import_catalogue: 'import de catalogue',
  mail_inbound: 'adresse mail dédiée',
};

// Plan effectif. Abonné → son plan (s'il est valide) ; sinon 'free' (0 jeton) ; essai gratuit → 'smart'.
// Employé (parent_user_id) → hérite du plan de son employeur.
function planKey(user) {
  if (user.parent_user_id) {
    const parent = db.prepare('SELECT subscription_status, plan, parent_user_id FROM users WHERE id = ?').get(user.parent_user_id);
    if (parent && !parent.parent_user_id) return planKey(parent);
    return 'free';
  }
  if (user.subscription_status === 'active') return PLAN_INFO[user.plan] ? user.plan : 'free';
  if (user.subscription_status === 'trial') return 'smart';
  return 'free';
}

// Nombre d'analyses faites ce mois-ci
function monthlyAnalyses(userId) {
  const row = db.prepare(
    "SELECT COUNT(*) as c FROM usage_log WHERE user_id = ? AND type IN ('analyse','analyse_email') AND created_at >= datetime('now','start of month')"
  ).get(userId);
  return row.c;
}

// Jetons de l'allocation mensuelle du forfait déjà consommés ce mois
function monthlyPlanJetons(userId) {
  const row = db.prepare(
    "SELECT COALESCE(SUM(jetons),0) as j FROM usage_log WHERE user_id = ? AND created_at >= datetime('now','start of month')"
  ).get(userId);
  return row.j;
}

// État complet des jetons d'un utilisateur
function getJetonState(user) {
  const plan = planKey(user);
  const allotment = PLAN_INFO[plan] ? PLAN_INFO[plan].jetons : 0;
  const planUsed = monthlyPlanJetons(user.id);
  const planRestant = Math.max(0, allotment - planUsed);
  const achetes = user.jetons || 0;            // portefeuille acheté (cumulable, peut être négatif si l'admin a retiré des jetons)
  return { plan, allotment, planUsed, planRestant, achetes, total: Math.max(0, planRestant + achetes) };
}

// Vérifie l'accès à une fonction réservée à un plan. Retourne null si OK, sinon { error }.
function checkFeature(user, feature) {
  const plan = planKey(user);
  if (!planHasFeature(plan, feature)) {
    const min = FEATURE_MIN_PLAN[feature];
    const minLabel = PLAN_INFO[min] ? PLAN_INFO[min].label : min;
    return { error: `🔒 ${(FEATURE_NAMES[feature] || feature)} : réservé au plan ${minLabel} et supérieur. Passez à un forfait supérieur pour en profiter.` };
  }
  return null;
}

// Solde suffisant pour `cost` jetons ? Retourne null si OK, sinon { error }. Ne débite PAS.
function affordJetons(user, cost) {
  if (!cost || cost <= 0) return null;
  const st = getJetonState(user);
  if (st.total < cost) {
    return { error: `🪙 Jetons insuffisants : il te reste ${st.total} jeton${st.total > 1 ? 's' : ''} et cette action en coûte ${cost}. Recharge des jetons depuis ton profil.`, jetons_insuffisants: true, restant: st.total, cout: cost };
  }
  return null;
}

// Débite `cost` jetons (allocation mensuelle d'abord, puis portefeuille acheté). À appeler APRÈS succès.
function consumeJetons(user, cost, logType) {
  if (!cost || cost <= 0) return;
  const st = getJetonState(user);
  const fromPlan = Math.min(cost, st.planRestant);
  const fromWallet = cost - fromPlan;
  if (fromPlan > 0) {
    db.prepare("INSERT INTO usage_log (user_id, type, model, input_tokens, output_tokens, cost_usd, own_key, jetons) VALUES (?,?,?,0,0,0,0,?)")
      .run(user.id, logType || 'jetons', 'jetons', fromPlan);
  }
  if (fromWallet > 0) {
    db.prepare('UPDATE users SET jetons = jetons - ? WHERE id = ?').run(fromWallet, user.id);
  }
}

// L'analyse à venir dépasse-t-elle le quota du forfait (donc payante en jetons) ?
function analyseOverQuota(user) {
  const plan = planKey(user);
  const limit = PLAN_INFO[plan] ? PLAN_INFO[plan].analyses : 0;
  return monthlyAnalyses(user.id) >= limit;
}

// Peut-on lancer une analyse ? (gratuite sous quota, sinon jetons). Ne débite PAS.
function affordAnalyse(user) {
  if (!analyseOverQuota(user)) return null;
  const cost = JETON_COSTS.analyse_extra;
  const a = affordJetons(user, cost);
  if (a) {
    const plan = planKey(user);
    const limit = PLAN_INFO[plan] ? PLAN_INFO[plan].analyses : 0;
    return { error: `🪙 Quota de ${limit} analyses atteint ce mois-ci. Au-delà, chaque analyse coûte ${cost} jetons — solde insuffisant. Recharge des jetons ou passe au forfait supérieur.`, jetons_insuffisants: true };
  }
  return null;
}

function hasMailInbound(user) {
  return user.subscription_status === 'active' && planHasFeature(planKey(user), 'mail_inbound');
}

module.exports = { planKey, getJetonState, checkFeature, affordJetons, consumeJetons, affordAnalyse, analyseOverQuota, hasMailInbound, monthlyAnalyses };
