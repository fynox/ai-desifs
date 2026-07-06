const express = require('express');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { monthlyRevenueEur, PLAN_INFO } = require('../utils/plans');
const { getSetting, setSetting } = require('../utils/appSettings');

const USD_TO_EUR = 0.93; // taux fixe pour convertir les coûts API (facturés en USD) en €

const router = express.Router();

function requireAdmin(req, res, next) {
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase());
  if (!admins.includes(req.user.email.toLowerCase())) {
    return res.status(403).json({ error: 'Accès refusé.' });
  }
  next();
}

router.use(requireAuth, requireAdmin);

// Stats globales
router.get('/stats', (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const activeUsers = db.prepare("SELECT COUNT(*) as c FROM users WHERE subscription_status='active'").get().c;
  const trialUsers = db.prepare("SELECT COUNT(*) as c FROM users WHERE subscription_status='trial'").get().c;
  const inactiveUsers = db.prepare("SELECT COUNT(*) as c FROM users WHERE subscription_status='inactive'").get().c;
  const totalAnalyses = db.prepare('SELECT COUNT(*) as c FROM analyses').get().c;
  const todayAnalyses = db.prepare("SELECT COUNT(*) as c FROM analyses WHERE date(created_at)=date('now')").get().c;
  const totalStock = db.prepare('SELECT COUNT(*) as c FROM stock').get().c;

  res.json({ totalUsers, activeUsers, trialUsers, inactiveUsers, totalAnalyses, todayAnalyses, totalStock });
});

// Liste des utilisateurs
router.get('/users', (req, res) => {
  const { getJetonState } = require('../utils/limits');
  // Les comptes employés sont regroupés juste sous leur employeur
  const users = db.prepare(`
    SELECT u.id, u.email, u.subscription_status, u.plan, u.plan_period, u.plan_override, u.jetons, u.bonus_go, u.trial_analyses_used, u.inbound_email, u.stripe_customer_id, u.created_at,
      u.parent_user_id, u.role,
      (SELECT COUNT(*) FROM analyses WHERE user_id=u.id) as analyses_count,
      (SELECT COUNT(*) FROM stock WHERE user_id=u.id) as stock_count
    FROM users u
    ORDER BY COALESCE(u.parent_user_id, u.id), (u.parent_user_id IS NOT NULL), u.created_at DESC
  `).all();
  // Ajoute l'état jetons (alloc forfait restante + achetés)
  for (const u of users) {
    try { const st = getJetonState(u); u.jetons_total = st.total; u.jetons_plan = st.planRestant; u.jetons_allotment = st.allotment; } catch {}
  }
  res.json(users);
});

// Modifier le statut d'un utilisateur
router.patch('/users/:id', (req, res) => {
  const { subscription_status } = req.body;
  const valid = ['trial', 'active', 'inactive'];
  if (!valid.includes(subscription_status)) return res.status(400).json({ error: 'Statut invalide.' });
  db.prepare('UPDATE users SET subscription_status=? WHERE id=?').run(subscription_status, req.params.id);
  res.json({ ok: true });
});

// Changer manuellement le plan d'un utilisateur ('auto' = re-laisser Stripe décider)
router.patch('/users/:id/plan', (req, res) => {
  const { plan, period } = req.body;
  if (plan === 'auto') {
    db.prepare('UPDATE users SET plan_override=0 WHERE id=?').run(req.params.id);
    return res.json({ ok: true, mode: 'auto' });
  }
  const valid = ['free', 'smart', 'pro', 'ultra', 'entreprise'];
  if (!valid.includes(plan)) return res.status(400).json({ error: 'Plan invalide.' });
  const validPeriod = ['monthly', 'annual'].includes(period) ? period : 'monthly';
  // Forcer un plan payant active aussi le compte (sinon l'app affichait "free" malgré l'override)
  const status = plan === 'free' ? 'inactive' : 'active';
  db.prepare('UPDATE users SET plan=?, plan_period=?, plan_override=1, subscription_status=? WHERE id=?').run(plan, validPeriod, status, req.params.id);
  res.json({ ok: true, mode: 'override' });
});

// Modifier le portefeuille de jetons achetés d'un utilisateur (admin)
router.patch('/users/:id/jetons', (req, res) => {
  const { getJetonState } = require('../utils/limits');
  const u0 = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u0) return res.status(404).json({ error: 'Utilisateur introuvable.' });

  let wallet;
  if (req.body.total != null) {
    // L'admin fixe le TOTAL dispo voulu. On calcule le portefeuille acheté correspondant :
    // total = max(0, planRestant + wallet)  =>  wallet = total - planRestant (peut être négatif).
    const desired = Math.round(Number(req.body.total));
    if (isNaN(desired)) return res.status(400).json({ error: 'Valeur invalide.' });
    const st = getJetonState(u0);
    wallet = desired - st.planRestant;
  } else {
    // Compat : fixe directement le portefeuille acheté (peut être négatif).
    wallet = Math.round(Number(req.body.jetons));
    if (isNaN(wallet)) return res.status(400).json({ error: 'Valeur invalide.' });
  }

  db.prepare('UPDATE users SET jetons=? WHERE id=?').run(wallet, req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  res.json({ ok: true, jetons: wallet, state: getJetonState(u) });
});

// Reset essais gratuits
router.patch('/users/:id/reset-trial', (req, res) => {
  db.prepare('UPDATE users SET trial_analyses_used=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Supprimer un utilisateur
router.delete('/users/:id', (req, res) => {
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Analyses récentes (50 dernières)
router.get('/analyses', (req, res) => {
  const analyses = db.prepare(`
    SELECT a.id, a.source, a.lu, a.created_at, a.mail_content, a.result_json, u.email, u.id as user_id,
      json_extract(a.result_json, '$.adhesifs[0].nom') as premier_produit,
      json_extract(a.result_json, '$.resume') as resume
    FROM analyses a
    JOIN users u ON u.id=a.user_id
    ORDER BY a.created_at DESC
    LIMIT 50
  `).all();
  res.json(analyses);
});

// Analyses d'un utilisateur spécifique
router.get('/users/:id/analyses', (req, res) => {
  const analyses = db.prepare(`
    SELECT a.id, a.source, a.lu, a.created_at, a.mail_content, a.result_json,
      json_extract(a.result_json, '$.adhesifs[0].nom') as premier_produit,
      json_extract(a.result_json, '$.resume') as resume
    FROM analyses a
    WHERE a.user_id = ?
    ORDER BY a.created_at DESC
  `).all(req.params.id);
  res.json(analyses);
});

// Coûts API par utilisateur (tracking interne des tokens Claude)
router.get('/usage', (req, res) => {
  const parUser = db.prepare(`
    SELECT u.id as user_id, u.email, u.plan, u.plan_period, u.subscription_status,
      COUNT(l.id) as appels,
      SUM(l.input_tokens) as input_tokens,
      SUM(l.output_tokens) as output_tokens,
      SUM(CASE WHEN l.own_key=0 THEN l.cost_usd ELSE 0 END) as cost_usd,
      SUM(CASE WHEN l.own_key=1 THEN l.cost_usd ELSE 0 END) as cost_own_key_usd,
      SUM(CASE WHEN l.created_at >= datetime('now','start of month') AND l.own_key=0 THEN l.cost_usd ELSE 0 END) as cost_mois_usd
    FROM usage_log l
    LEFT JOIN users u ON u.id = l.user_id
    GROUP BY l.user_id
    ORDER BY cost_usd DESC
  `).all();

  const parType = db.prepare(`
    SELECT type, COUNT(*) as appels, SUM(cost_usd) as cost_usd
    FROM usage_log WHERE own_key=0
    GROUP BY type ORDER BY cost_usd DESC
  `).all();

  const totaux = db.prepare(`
    SELECT
      SUM(CASE WHEN own_key=0 THEN cost_usd ELSE 0 END) as total_usd,
      SUM(CASE WHEN own_key=0 AND created_at >= datetime('now','start of month') THEN cost_usd ELSE 0 END) as mois_usd,
      SUM(CASE WHEN own_key=0 AND date(created_at)=date('now') THEN cost_usd ELSE 0 END) as jour_usd
    FROM usage_log
  `).get();

  // Gains : revenu mensuel de l'abonnement − coûts API du mois (en €)
  const enriched = parUser.map(u => {
    const active = u.subscription_status === 'active';
    const revenue = active ? monthlyRevenueEur(u.plan || 'free', u.plan_period || 'monthly') : 0;
    const costMoisEur = (Number(u.cost_mois_usd) || 0) * USD_TO_EUR;
    return {
      ...u,
      plan: active ? (u.plan || 'free') : 'free',
      revenue_eur: revenue,
      gain_mois_eur: revenue - costMoisEur,
    };
  });

  // Comptes abonnés sans aucune conso (pour qu'ils apparaissent quand même dans les gains)
  const dejaListe = new Set(enriched.map(u => u.user_id));
  const abonnesSansConso = db.prepare(`
    SELECT id as user_id, email, plan, plan_period, subscription_status FROM users
    WHERE subscription_status = 'active'
  `).all().filter(u => !dejaListe.has(u.user_id)).map(u => ({
    ...u, appels: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, cost_own_key_usd: 0, cost_mois_usd: 0,
    revenue_eur: monthlyRevenueEur(u.plan || 'free', u.plan_period || 'monthly'),
    gain_mois_eur: monthlyRevenueEur(u.plan || 'free', u.plan_period || 'monthly'),
  }));

  res.json({ parUser: [...enriched, ...abonnesSansConso], parType, totaux, usd_to_eur: USD_TO_EUR, plans: PLAN_INFO });
});

// Historique mensuel des gains d'un utilisateur (abonnement − coûts API)
router.get('/users/:id/gains', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });

  const active = user.subscription_status === 'active';
  const revenue = active ? monthlyRevenueEur(user.plan || 'free', user.plan_period || 'monthly') : 0;

  const couts = db.prepare(`
    SELECT strftime('%Y-%m', created_at) as mois,
      SUM(CASE WHEN own_key=0 THEN cost_usd ELSE 0 END) as cost_usd,
      COUNT(*) as appels
    FROM usage_log WHERE user_id = ?
    GROUP BY mois ORDER BY mois DESC LIMIT 24
  `).all(user.id);

  // Inclure le mois courant même sans conso
  const moisCourant = new Date().toISOString().slice(0, 7);
  if (!couts.find(c => c.mois === moisCourant)) couts.unshift({ mois: moisCourant, cost_usd: 0, appels: 0 });

  res.json({
    email: user.email,
    plan: active ? (user.plan || 'free') : 'free',
    plan_period: user.plan_period || 'monthly',
    revenue_eur: revenue,
    historique: couts.map(c => ({
      mois: c.mois,
      appels: c.appels,
      cost_usd: c.cost_usd || 0,
      cost_eur: (c.cost_usd || 0) * USD_TO_EUR,
      revenue_eur: revenue,
      gain_eur: revenue - (c.cost_usd || 0) * USD_TO_EUR,
    })),
  });
});

// Détail mensuel d'un utilisateur
router.get('/users/:id/usage', (req, res) => {
  const rows = db.prepare(`
    SELECT strftime('%Y-%m', created_at) as mois, type, COUNT(*) as appels,
      SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens, SUM(cost_usd) as cost_usd
    FROM usage_log WHERE user_id = ?
    GROUP BY mois, type ORDER BY mois DESC
  `).all(req.params.id);
  res.json(rows);
});

// Clés API globales (Claude / Replicate) — la valeur en base prime sur les variables Railway
const API_KEY_NAMES = ['ANTHROPIC_API_KEY', 'REPLICATE_API_TOKEN'];

router.get('/apikeys', (req, res) => {
  const out = {};
  for (const name of API_KEY_NAMES) {
    const v = getSetting(name);
    out[name] = v ? `••••${v.slice(-6)}` : null; // jamais la clé complète vers le front
  }
  res.json(out);
});

router.put('/apikeys', (req, res) => {
  const updated = [];
  for (const name of API_KEY_NAMES) {
    const v = req.body[name];
    if (typeof v === 'string' && v.trim() && !v.includes('•')) {
      setSetting(name, v.trim());
      updated.push(name);
    }
  }
  if (!updated.length) return res.status(400).json({ error: 'Aucune clé fournie.' });
  res.json({ ok: true, updated });
});

router.get('/bugs', (req, res) => {
  const bugs = db.prepare('SELECT * FROM bug_reports ORDER BY created_at DESC LIMIT 200').all();
  res.json(bugs);
});

router.patch('/bugs/:id/status', (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE bug_reports SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ ok: true });
});

module.exports = router;
