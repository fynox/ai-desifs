const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { planKey, checkFeature, affordJetons, consumeJetons, getJetonState } = require('../utils/limits');
const { PLAN_INFO, JETON_COSTS } = require('../utils/plans');

const router = express.Router();
router.use(requireAuth);

const ROLES = ['preparateur', 'poseur', 'secretariat', 'designer'];
// Un employé peut cumuler plusieurs rôles ("preparateur,poseur"). Valide et normalise la liste.
function normRoles(input) {
  const parts = String(input || '').split(',').map(s => s.trim()).filter(Boolean);
  const valid = [...new Set(parts.filter(p => ROLES.includes(p)))];
  return valid.length ? valid.join(',') : null;
}

// L'utilisateur est-il un employeur avec le multi-utilisateurs (plan Entreprise) ?
function requireOwner(req, res, next) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || user.parent_user_id) return res.status(403).json({ error: 'Réservé au compte principal (employeur).' });
  const ft = checkFeature(user, 'multi_user');
  if (ft) return res.status(403).json(ft);
  req.owner = user;
  next();
}

// Collègues (accessible aux employés) : pour choisir à qui transférer une mission
router.get('/coworkers', (req, res) => {
  const me = db.prepare('SELECT id, parent_user_id FROM users WHERE id = ?').get(req.user.id);
  const ownerId = me.parent_user_id || me.id;
  const rows = db.prepare('SELECT id, email, role FROM users WHERE parent_user_id = ? AND id != ? ORDER BY email').all(ownerId, req.user.id);
  res.json({ coworkers: rows });
});

// Places disponibles = celles du forfait + celles achetées en supplément (30 jetons/mois chacune)
function maxUsers(owner) {
  const base = PLAN_INFO[planKey(owner)] ? PLAN_INFO[planKey(owner)].users : 1;
  return base + Math.max(0, owner.extra_users || 0);
}

// Liste des employés du compte
router.get('/', requireOwner, (req, res) => {
  const rows = db.prepare('SELECT id, email, role, created_at, subscription_status FROM users WHERE parent_user_id = ? ORDER BY created_at').all(req.owner.id);
  const base = PLAN_INFO[planKey(req.owner)] ? PLAN_INFO[planKey(req.owner)].users : 1;
  res.json({
    employes: rows,
    max_users: maxUsers(req.owner),
    base_users: base,
    extra_users: req.owner.extra_users || 0,
    extra_cost: JETON_COSTS.extra_user,
    used: rows.length + 1, // +1 = le compte employeur lui-même
  });
});

// Ajouter une place employé supplémentaire : 30 jetons prélevés maintenant, puis chaque mois
router.post('/places', requireOwner, (req, res) => {
  const cost = JETON_COSTS.extra_user;
  const aff = affordJetons(req.owner, cost);
  if (aff) return res.status(403).json(aff);
  consumeJetons(req.owner, cost, 'extra_user');
  const { moisCourant } = require('../utils/recurrents');
  db.prepare('UPDATE users SET extra_users = COALESCE(extra_users,0) + 1, storage_billed_month = ? WHERE id = ?').run(moisCourant(), req.owner.id);
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(req.owner.id);
  res.json({ ok: true, extra_users: fresh.extra_users, max_users: maxUsers(fresh), jetons: getJetonState(fresh) });
});

// Retirer une place supplémentaire (impossible si elle est occupée)
router.delete('/places', requireOwner, (req, res) => {
  if (!(req.owner.extra_users > 0)) return res.status(400).json({ error: 'Aucune place supplémentaire active.' });
  const count = db.prepare('SELECT COUNT(*) as c FROM users WHERE parent_user_id = ?').get(req.owner.id).c;
  const apres = maxUsers({ ...req.owner, extra_users: req.owner.extra_users - 1 });
  if (count + 1 > apres) {
    return res.status(400).json({ error: 'Supprime d\'abord un compte employé : cette place est occupée.' });
  }
  db.prepare('UPDATE users SET extra_users = MAX(0, COALESCE(extra_users,0) - 1) WHERE id = ?').run(req.owner.id);
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(req.owner.id);
  res.json({ ok: true, extra_users: fresh.extra_users, max_users: maxUsers(fresh), jetons: getJetonState(fresh) });
});

// Créer un compte employé
router.post('/', requireOwner, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = normRoles(req.body.role);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'Email invalide.' });
  if (password.length < 8) return res.status(400).json({ error: 'Mot de passe : 8 caractères minimum.' });
  if (!role) return res.status(400).json({ error: 'Choisis au moins un rôle (préparateur, poseur, secrétariat, designer).' });

  const max = maxUsers(req.owner);
  const count = db.prepare('SELECT COUNT(*) as c FROM users WHERE parent_user_id = ?').get(req.owner.id).c;
  if (count + 1 >= max) {
    return res.status(403).json({
      error: `Limite atteinte : ${max} utilisateurs (toi inclus). Ajoute une place supplémentaire pour ${JETON_COSTS.extra_user} jetons/mois depuis « 👥 Mon équipe ».`,
      places_pleines: true,
    });
  }

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
  if (req.body.role !== undefined) {
    const role = normRoles(req.body.role);
    if (!role) return res.status(400).json({ error: 'Choisis au moins un rôle.' });
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, emp.id);
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
