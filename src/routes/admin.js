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

// Analyses récentes
router.get('/analyses', (req, res) => {
  const analyses = db.prepare(`
    SELECT a.id, a.source, a.lu, a.created_at, u.email,
      json_extract(a.result_json, '$.recommandations[0].nom') as premier_produit
    FROM analyses a
    JOIN users u ON u.id=a.user_id
    ORDER BY a.created_at DESC
    LIMIT 50
  `).all();
  res.json(analyses);
});

module.exports = router;
