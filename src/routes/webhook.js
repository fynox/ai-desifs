const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const db = require('../config/db');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fieldSize: 10 * 1024 * 1024, fileSize: 20 * 1024 * 1024 } });

async function pdfToImages(buffer) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-'));
  const pdfPath = path.join(tmp, 'input.pdf');
  const outPrefix = path.join(tmp, 'page');
  fs.writeFileSync(pdfPath, buffer);
  return new Promise((resolve) => {
    execFile('pdftoppm', ['-png', '-r', '150', '-l', '3', pdfPath, outPrefix], (err) => {
      if (err) { fs.rmSync(tmp, { recursive: true, force: true }); resolve([]); return; }
      const images = fs.readdirSync(tmp)
        .filter(f => f.endsWith('.png'))
        .sort()
        .map(f => ({ mimetype: 'image/png', data: fs.readFileSync(path.join(tmp, f)).toString('base64') }));
      fs.rmSync(tmp, { recursive: true, force: true });
      resolve(images);
    });
  });
}

// SendGrid Inbound Parse — réception de mails entrants
router.post('/sendgrid/inbound', upload.any(), async (req, res) => {
  res.sendStatus(200); // répondre vite à SendGrid

  try {
    const to = req.body.to || '';
    const from = req.body.from || '';
    const subject = req.body.subject || '';
    // Send Raw ON → contenu dans req.body.email (MIME brut), sinon dans text/html
    let text = req.body.text || req.body.html || '';
    if (!text && req.body.email) {
      // Extraire la partie texte du MIME brut
      const raw = req.body.email;
      const plainMatch = raw.match(/Content-Type: text\/plain[^\n]*\n(?:[^\n]*\n)*?\n([\s\S]*?)(?=--|\n--)/i);
      const htmlMatch = raw.match(/Content-Type: text\/html[^\n]*\n(?:[^\n]*\n)*?\n([\s\S]*?)(?=--|\n--)/i);
      text = (plainMatch?.[1] || htmlMatch?.[1] || '').replace(/<[^>]+>/g, ' ').trim();
      if (!text) text = raw.slice(0, 3000); // fallback : envoyer le brut tronqué
    }

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

    const systemPrompt = `Tu es un expert en impression numérique et adhésifs vinyl pour une entreprise de signalétique et d'impression grand format.

DÉFINITIONS IMPORTANTES — respecte-les strictement :
- "Imprimable" : adhésif vinyl blanc ou transparent destiné à être imprimé directement (lettrage, décoration, signalétique). C'est la base sur laquelle on imprime.
- "Liner" : film transparent (PVC, polyester, PP) servant UNIQUEMENT à protéger ou contreplaquer un visuel déjà imprimé. Un liner ne s'imprime PAS. Il se pose PAR-DESSUS l'imprimé pour le protéger ou lui donner une finition. Ne recommande un liner QUE si le client demande explicitement une protection/lamination d'un visuel existant.
- "Couleur DAO" : vinyl uni coloré (non imprimable) pour découpe et lettrage.

Ne confonds JAMAIS ces catégories. Si le client veut imprimer un visuel, recommande un "Imprimable". Si il veut protéger un visuel déjà imprimé, recommande un "Liner". Si il veut du vinyl de couleur découpé, recommande un "Couleur DAO".

STOCK DISPONIBLE :
${stockDesc}

Réponds UNIQUEMENT en JSON valide :
{"resume":"...","adhesifs":[{"nom":"nom exact du stock","raison":"...","priorite":"principal ou alternatif"}],"specs":{"finition":"...","duree":"...","pose":"...","retrait":"..."},"preparation":["..."],"attention":"... ou null"}`;

    const mailContent = `De : ${from}\nObjet : ${subject}\n\n${text}`.slice(0, 5000);

    // Pièces jointes : images directes + PDFs convertis en PNG
    const userContent = [{ type: 'text', text: mailContent }];
    const files = req.files || [];
    const imageFiles = files.filter(f => f.mimetype && f.mimetype.startsWith('image/'));
    const pdfFiles = files.filter(f => f.mimetype === 'application/pdf' || f.originalname?.endsWith('.pdf'));

    for (const img of imageFiles.slice(0, 3)) {
      userContent.push({ type: 'image', source: { type: 'base64', media_type: img.mimetype, data: img.buffer.toString('base64') } });
    }
    for (const pdf of pdfFiles.slice(0, 2)) {
      const pages = await pdfToImages(pdf.buffer);
      for (const p of pages.slice(0, 3)) {
        userContent.push({ type: 'image', source: { type: 'base64', media_type: p.mimetype, data: p.data } });
      }
    }

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
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
