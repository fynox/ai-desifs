const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const db = require('../config/db');

const router = express.Router();
const upload = multer();

// SendGrid Inbound Parse — réception de mails entrants
router.post('/sendgrid/inbound', upload.any(), async (req, res) => {
  res.sendStatus(200); // répondre vite à SendGrid

  try {
    const to = req.body.to || '';
    const from = req.body.from || '';
    const subject = req.body.subject || '';
    const text = req.body.text || req.body.html || '';

    // Extraire l'adresse inbound complète dans le champ "to"
    const toMatch = to.match(/([^\s<,]+@[^\s>,]+)/);
    if (!toMatch) return;
    const inboundAddr = toMatch[1].toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE inbound_email = ?').get(inboundAddr);
    if (!user) return;
    if (user.subscription_status !== 'active') return;
    const apiKey = user.api_key || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return;

    const stockDispo = db.prepare('SELECT * FROM stock WHERE user_id = ? AND dispo = 1').all(user.id);
    if (!stockDispo.length) return;

    const stockDesc = ['imprimable', 'liner', 'dao'].map(cat => {
      const items = stockDispo.filter(i => i.cat === cat);
      if (!items.length) return '';
      const label = cat === 'imprimable' ? 'Imprimable' : cat === 'liner' ? 'Liner' : 'Couleur DAO';
      return `--- ${label} ---\n` + items.map(i => {
        const res2 = JSON.parse(i.resistances || '[]');
        const app = JSON.parse(i.applications || '[]');
        return `• ${i.nom} | ${i.finition} | ${i.adherence} | ${i.env} | ${i.duree}${res2.length ? ' | ' + res2.join(', ') : ''}${app.length ? ' | ' + app.join(', ') : ''}${i.note ? ' | ' + i.note : ''}`;
      }).join('\n');
    }).filter(Boolean).join('\n\n');

    const systemPrompt = `Tu es un expert en impression numérique et adhésifs vinyl pour une entreprise de signalétique.
Tu reçois une demande client transmise par mail et recommandes UNIQUEMENT parmi le stock disponible ci-dessous.

STOCK :
${stockDesc}

Réponds UNIQUEMENT en JSON valide :
{"resume":"...","adhesifs":[{"nom":"nom exact du stock","raison":"...","priorite":"principal ou alternatif"}],"specs":{"finition":"...","duree":"...","pose":"...","retrait":"..."},"preparation":["..."],"attention":"... ou null"}`;

    const mailContent = `De : ${from}\nObjet : ${subject}\n\n${text}`.slice(0, 5000);

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: mailContent }],
      }),
    });

    if (!claudeRes.ok) return;
    const data = await claudeRes.json();
    const raw = data.content?.map(i => i.text || '').join('') || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    let result;
    try { result = JSON.parse(jsonMatch[0]); } catch { return; }
    if (!result.adhesifs || !result.specs) return;

    db.prepare(
      'INSERT INTO analyses (user_id, mail_content, consignes, result_json, source) VALUES (?, ?, ?, ?, ?)'
    ).run(user.id, mailContent, '', JSON.stringify(result), 'email');
  } catch (e) {
    console.error('Webhook inbound error:', e);
  }
});

// Stripe webhook
router.post('/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.created') {
    const sub = event.data.object;
    db.prepare('UPDATE users SET subscription_status = ? WHERE stripe_customer_id = ?').run(sub.status, sub.customer);
  }
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    db.prepare('UPDATE users SET subscription_status = ? WHERE stripe_customer_id = ?').run('inactive', sub.customer);
  }

  res.json({ received: true });
});

module.exports = router;
