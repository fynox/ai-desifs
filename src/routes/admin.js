const express = require('express');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');

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
  const users = db.prepare(`
    SELECT u.id, u.email, u.subscription_status, u.trial_analyses_used, u.inbound_email, u.stripe_customer_id, u.created_at,
      (SELECT COUNT(*) FROM analyses WHERE user_id=u.id) as analyses_count,
      (SELECT COUNT(*) FROM stock WHERE user_id=u.id) as stock_count
    FROM users u
    ORDER BY u.created_at DESC
  `).all();
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
    SELECT u.id as user_id, u.email,
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

  res.json({ parUser, parType, totaux });
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
