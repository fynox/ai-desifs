const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function makeToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

router.post('/signup', async (req, res) => {
  const { email, password, api_key } = req.body;
  if (!email || !password || !api_key) return res.status(400).json({ error: 'Tous les champs sont obligatoires.' });
  if (password.length < 8) return res.status(400).json({ error: 'Mot de passe trop court (8 caractères minimum).' });
  if (!api_key.startsWith('sk-ant-')) return res.status(400).json({ error: 'Clé API invalide.' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });

  const hash = await bcrypt.hash(password, 12);
  const localPart = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20);
  const suffix = Math.random().toString(36).slice(2, 6);
  const inbound_email = `${localPart}-${suffix}@ai-dhesif.fr`;
  const result = db.prepare('INSERT INTO users (email, password_hash, api_key, subscription_status, inbound_email) VALUES (?, ?, ?, ?, ?)').run(email.toLowerCase(), hash, api_key, 'trial', inbound_email);
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

  res.json({ token: makeToken(user), email: user.email, subscription_status: user.subscription_status, trial_analyses_used: user.trial_analyses_used, inbound_email: user.inbound_email });
});

router.put('/profile', requireAuth, async (req, res) => {
  const { current_password, new_password, api_key } = req.body;
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

  if (api_key) {
    if (!api_key.startsWith('sk-ant-')) return res.status(400).json({ error: 'Clé API invalide.' });
    db.prepare('UPDATE users SET api_key = ? WHERE id = ?').run(api_key, user.id);
    changed = true;
  }

  if (!changed) return res.status(400).json({ error: 'Aucune modification détectée.' });
  res.json({ ok: true });
});

module.exports = router;
