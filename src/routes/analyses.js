const express = require('express');
const fetch = require('node-fetch');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM analyses WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json(rows.map(r => ({ ...r, result: JSON.parse(r.result_json), lu: Boolean(r.lu) })));
});

router.put('/:id/lu', (req, res) => {
  db.prepare('UPDATE analyses SET lu = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const item = db.prepare('SELECT id FROM analyses WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Analyse introuvable.' });
  db.prepare('DELETE FROM analyses WHERE id = ?').run(item.id);
  res.json({ ok: true });
});

router.post('/analyse', async (req, res) => {
  const { mail_content, consignes = '', file_base64, file_type } = req.body;
  if (!mail_content) return res.status(400).json({ error: 'Le contenu du mail est requis.' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const TRIAL_LIMIT = 5;
  if (user.subscription_status === 'inactive') {
    return res.status(403).json({ error: 'subscription_required' });
  }
  if (user.subscription_status === 'trial' && user.trial_analyses_used >= TRIAL_LIMIT) {
    return res.status(403).json({ error: 'trial_expired', used: user.trial_analyses_used, limit: TRIAL_LIMIT });
  }
  if (!user?.api_key) return res.status(400).json({ error: 'Clé API Anthropic manquante. Configurez-la dans votre profil.' });

  const stockDispo = db.prepare('SELECT * FROM stock WHERE user_id = ? AND dispo = 1').all(req.user.id);
  if (!stockDispo.length) return res.status(400).json({ error: 'Aucun adhésif en stock disponible.' });

  const stockDesc = ['imprimable', 'liner', 'dao'].map(cat => {
    const items = stockDispo.filter(i => i.cat === cat);
    if (!items.length) return '';
    const label = cat === 'imprimable' ? 'Imprimable' : cat === 'liner' ? 'Liner' : 'Couleur DAO';
    return `--- ${label} ---\n` + items.map(i => {
      const res = JSON.parse(i.resistances || '[]');
      const app = JSON.parse(i.applications || '[]');
      return `• ${i.nom} | ${i.finition} | ${i.adherence} | ${i.env} | ${i.duree}${res.length ? ' | ' + res.join(', ') : ''}${app.length ? ' | ' + app.join(', ') : ''}${i.note ? ' | ' + i.note : ''}`;
    }).join('\n');
  }).filter(Boolean).join('\n\n');

  const systemPrompt = `Tu es un expert en impression numérique et adhésifs vinyl pour une entreprise de signalétique.
Tu reçois une demande client et recommandes UNIQUEMENT parmi le stock disponible ci-dessous.

STOCK :
${stockDesc}

Réponds UNIQUEMENT en JSON valide :
{"resume":"...","adhesifs":[{"nom":"nom exact du stock","raison":"...","priorite":"principal ou alternatif"}],"specs":{"finition":"...","duree":"...","pose":"...","retrait":"..."},"preparation":["..."],"attention":"... ou null"}`;

  const userContent = [{ type: 'text', text: `Mail client :\n${mail_content}${consignes ? `\n\nConsignes : ${consignes}` : ''}` }];
  if (file_base64 && file_type && file_type.startsWith('image/')) {
    userContent.push({ type: 'image', source: { type: 'base64', media_type: file_type, data: file_base64 } });
  }

  let claudeRes;
  try {
    claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': user.api_key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      }),
    });
  } catch (e) {
    return res.status(502).json({ error: 'Impossible de joindre l\'API Anthropic.' });
  }

  const data = await claudeRes.json();
  if (!claudeRes.ok) return res.status(502).json({ error: data?.error?.message || `Erreur Anthropic ${claudeRes.status}` });

  const raw = data.content?.map(i => i.text || '').join('') || '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return res.status(502).json({ error: 'Réponse IA invalide — réessayez.' });

  let result;
  try { result = JSON.parse(jsonMatch[0]); } catch { return res.status(502).json({ error: 'JSON invalide dans la réponse IA.' }); }
  if (!result.adhesifs || !result.specs) return res.status(502).json({ error: 'Structure de réponse incomplète.' });

  if (user.subscription_status === 'trial') {
    db.prepare('UPDATE users SET trial_analyses_used = trial_analyses_used + 1 WHERE id = ?').run(user.id);
  }

  const inserted = db.prepare(
    'INSERT INTO analyses (user_id, mail_content, consignes, result_json, source) VALUES (?, ?, ?, ?, ?)'
  ).run(req.user.id, mail_content.slice(0, 5000), consignes, JSON.stringify(result), 'manual');

  const analyse = db.prepare('SELECT * FROM analyses WHERE id = ?').get(inserted.lastInsertRowid);
  res.json({ ...analyse, result, lu: false });
});

module.exports = router;
