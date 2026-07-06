const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { planFromPriceId } = require('../utils/plans');

const router = express.Router();

function makeToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

router.post('/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Tous les champs sont obligatoires.' });
  if (password.length < 8) return res.status(400).json({ error: 'Mot de passe trop court (8 caractères minimum).' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });

  const hash = await bcrypt.hash(password, 12);
  // Adresse inbound : même préfixe que l'email, avec suffixe si déjà pris
  // Domaine configurable (INBOUND_DOMAIN) ; par défaut le domaine racine ai-dhesif.fr
  const INBOUND_DOMAIN = process.env.INBOUND_DOMAIN || 'ai-dhesif.fr';
  const baseLocal = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
  let inbound_email = `${baseLocal}@${INBOUND_DOMAIN}`;
  const taken = db.prepare('SELECT id FROM users WHERE inbound_email = ?').get(inbound_email);
  if (taken) {
    const suffix = Math.random().toString(36).slice(2, 5);
    inbound_email = `${baseLocal}${suffix}@${INBOUND_DOMAIN}`;
  }
  const result = db.prepare('INSERT INTO users (email, password_hash, subscription_status, inbound_email) VALUES (?, ?, ?, ?)').run(email.toLowerCase(), hash, 'trial', inbound_email);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  res.json({ token: makeToken(user), email: user.email, subscription_status: user.subscription_status, trial_analyses_used: user.trial_analyses_used, inbound_email: user.inbound_email });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Champs manquants.' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Aucun compte avec cet email.' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Mot de passe incorrect.' });

  // Employé : statut effectif hérité de l'employeur (compte actif tant que l'abonnement Entreprise l'est)
  res.json({ token: makeToken(user), email: user.email, subscription_status: user.subscription_status, plan: user.plan || 'free', plan_period: user.plan_period || 'monthly', trial_analyses_used: user.trial_analyses_used, inbound_email: user.inbound_email, settings: user.settings || '{}', role: user.role || 'owner', is_employe: Boolean(user.parent_user_id) });
});

router.get('/profile', requireAuth, async (req, res) => {
  let user = db.prepare('SELECT id, email, subscription_status, plan, plan_period, plan_override, trial_analyses_used, inbound_email, stripe_customer_id, settings FROM users WHERE id = ?').get(req.user.id);

  // Synchro directe avec Stripe (filet de sécurité si le webhook n'est pas passé).
  // Désactivée si l'admin a forcé un plan manuellement (plan_override).
  if (!user.plan_override && user.stripe_customer_id && process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      const subs = await stripe.subscriptions.list({ customer: user.stripe_customer_id, status: 'active', limit: 1 });
      if (subs.data.length) {
        const sub = subs.data[0];
        const [plan, period] = planFromPriceId(sub.items?.data?.[0]?.price?.id);
        if (user.subscription_status !== 'active' || user.plan !== plan || user.plan_period !== period) {
          db.prepare('UPDATE users SET subscription_status=?, plan=?, plan_period=? WHERE id=?').run('active', plan, period, user.id);
          user = { ...user, subscription_status: 'active', plan, plan_period: period };
        }
      } else if (user.subscription_status === 'active') {
        // Plus d'abonnement actif côté Stripe → repasser en inactif/free
        db.prepare('UPDATE users SET subscription_status=?, plan=? WHERE id=?').run('inactive', 'free', user.id);
        user = { ...user, subscription_status: 'inactive', plan: 'free' };
      }
    } catch (e) {
      console.error('Stripe sync profile error:', e.message);
    }
  }

  // État jetons + stockage + infos du forfait
  const full = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  let jetons = null, storage = null, planInfo = null;
  try {
    jetons = require('../utils/limits').getJetonState(full);
    storage = require('../utils/storage').getStorage(req.user.id);
    const { PLAN_INFO } = require('../utils/plans');
    planInfo = PLAN_INFO[jetons.plan] || null;
  } catch (e) { console.error('profile extras error:', e.message); }

  const { id, stripe_customer_id, ...pub } = user;
  res.json({ ...pub, jetons, storage, plan_info: planInfo, role: full.role || 'owner', is_employe: Boolean(full.parent_user_id) });
});

router.put('/profile', requireAuth, async (req, res) => {
  const { current_password, new_password, settings } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  let changed = false;

  if (current_password || new_password) {
    if (!current_password) return res.status(400).json({ error: 'Entrez votre mot de passe actuel.' });
    const ok = await bcrypt.compare(current_password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Mot de passe actuel incorrect.' });
    if (!new_password || new_password.length < 8) return res.status(400).json({ error: 'Nouveau mot de passe trop court (8 min).' });
    const hash = await bcrypt.hash(new_password, 12);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
    changed = true;
  }

  if (settings && typeof settings === 'object') {
    db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify(settings).slice(0, 2000), user.id);
    changed = true;
  }

  if (!changed) return res.status(400).json({ error: 'Aucune modification détectée.' });
  res.json({ ok: true });
});

module.exports = router;
