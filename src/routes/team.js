const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { planKey, checkFeature } = require('../utils/limits');
const { PLAN_INFO } = require('../utils/plans');

const router = express.Router();
router.use(requireAuth);

const ROLES = ['preparateur', 'poseur'];

// L'utilisateur est-il un employeur avec le multi-utilisateurs (plan Entreprise) ?
function requireOwner(req, res, next) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || user.parent_user_id) return res.status(403).json({ error: 'Réservé au compte principal (employeur).' });
  const ft = checkFeature(user, 'multi_user');
  if (ft) return res.status(403).json(ft);
  req.owner = user;
  next();
}

// Liste des employés du compte
router.get('/', requireOwner, (req, res) => {
  const rows = db.prepare('SELECT id, email, role, created_at FROM users WHERE parent_user_id = ? ORDER BY created_at').all(req.owner.id);
  const max = PLAN_INFO[planKey(req.owner)] ? PLAN_INFO[planKey(req.owner)].users : 1;
  res.json({ employes: rows, max_users: max, used: rows.length + 1 }); // +1 = le compte employeur lui-même
});

// Créer un compte employé
router.post('/', requireOwner, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = String(req.body.role || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'Email invalide.' });
  if (password.length < 8) return res.status(400).json({ error: 'Mot de passe : 8 caractères minimum.' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Rôle invalide (preparateur ou poseur).' });

  const max = PLAN_INFO[planKey(req.owner)] ? PLAN_INFO[planKey(req.owner)].users : 1;
  const count = db.prepare('SELECT COUNT(*) as c FROM users WHERE parent_user_id = ?').get(req.owner.id).c;
  if (count + 1 >= max) return res.status(403).json({ error: `Limite atteinte : ${max} utilisateurs (toi inclus) sur ton forfait.` });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });

  const hash = await bcrypt.hash(password, 12);
  // Employé : pas d'essai, pas d'adresse inbound — il hérite du plan de l'employeur via parent_user_id
  const r = db.prepare("INSERT INTO users (email, password_hash, subscription_status, parent_user_id, role) VALUES (?,?,?,?,?)")
    .run(email, hash, 'active', req.owner.id, role);
  const emp = db.prepare('SELECT id, email, role, created_at FROM users WHERE id = ?').get(r.lastInsertRowid);
  res.json(emp);
});

// Modifier le rôle / mot de passe d'un employé
router.patch('/:id', requireOwner, async (req, res) => {
  const emp = db.prepare('SELECT * FROM users WHERE id = ? AND parent_user_id = ?').get(req.params.id, req.owner.id);
  if (!emp) return res.status(404).json({ error: 'Employé introuvable.' });
  if (req.body.role && ROLES.includes(req.body.role)) {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(req.body.role, emp.id);
  }
  if (req.body.password) {
    if (String(req.body.password).length < 8) return res.status(400).json({ error: 'Mot de passe : 8 caractères minimum.' });
    const hash = await bcrypt.hash(String(req.body.password), 12);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, emp.id);
  }
  res.json({ ok: true });
});

// Supprimer un compte employé (ses affectations sont détachées)
router.delete('/:id', requireOwner, (req, res) => {
  const emp = db.prepare('SELECT id FROM users WHERE id = ? AND parent_user_id = ?').get(req.params.id, req.owner.id);
  if (!emp) return res.status(404).json({ error: 'Employé introuvable.' });
  db.prepare('UPDATE analyses SET assigned_prep_id = NULL WHERE assigned_prep_id = ?').run(emp.id);
  db.prepare('UPDATE analyses SET assigned_pose_id = NULL WHERE assigned_pose_id = ?').run(emp.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(emp.id);
  res.json({ ok: true });
});

module.exports = router;
