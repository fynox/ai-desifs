const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const db = require('../config/db');
const { logUsage } = require('../utils/usage');
const { planFromPriceId } = require('../utils/plans');
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

    const mailContent = `De : ${from}\nObjet : ${subject}\n\n${text}`.slice(0, 5000);

    // Insérer une analyse "pending" visible immédiatement (optionnel — ne bloque pas si colonne absente)
    let pendingId = null;
    try {
      const pendingRow = db.prepare(
        'INSERT INTO analyses (user_id, mail_content, consignes, result_json, source, status) VALUES (?,?,?,?,?,?)'
      ).run(user.id, mailContent, '', '{}', 'email', 'pending');
      pendingId = pendingRow.lastInsertRowid;
    } catch { /* colonne status pas encore migrée, on continue sans pending */ }

    const CAT_LABELS = { imprimable:'Imprimable', liner:'Liner', dao:'Couleur DAO', transfert:'Papier transfert', covering:'Covering voiture', vitre:'Vitre / Solaire', panneau:'Panneau' };
    const stockDesc = Object.keys(CAT_LABELS).map(cat => {
      const items = stockDispo.filter(i => i.cat === cat);
      if (!items.length) return '';
      return `--- ${CAT_LABELS[cat]} ---\n` + items.map(i => {
        const res2 = JSON.parse(i.resistances || '[]');
        const app = JSON.parse(i.applications || '[]');
        const lar = JSON.parse(i.largeurs || '[]');
        const vars = JSON.parse(i.variantes || '[]');
        const varTxt = vars.length
          ? ' | variantes disponibles (UNIQUEMENT ces combinaisons couleur/laize): ' + vars.map(v => `${v.couleur || 'standard'}${v.largeur ? ' en ' + v.largeur + ' cm' : ''}`).join(', ')
          : (lar.length ? ' | laizes: ' + lar.join(', ') + ' cm' : '');
        return `• ${i.nom} | ${i.finition} | ${i.adherence} | ${i.env} | ${i.duree}${varTxt}${res2.length ? ' | ' + res2.join(', ') : ''}${app.length ? ' | ' + app.join(', ') : ''}${i.note ? ' | ' + i.note : ''}`;
      }).join('\n');
    }).filter(Boolean).join('\n\n');

    const systemPrompt = `Tu es un expert en impression numérique et adhésifs vinyl pour une entreprise de signalétique et d'impression grand format.

DÉFINITIONS IMPORTANTES — respecte-les strictement :
- "Imprimable" : adhésif vinyl blanc ou transparent destiné à être imprimé directement (impression numérique, décoration, signalétique).
- "Liner" : film transparent servant UNIQUEMENT à protéger/contreplaquer un visuel déjà imprimé. Ne s'imprime PAS. Recommande-le UNIQUEMENT si le client demande explicitement une protection/lamination.
- "Couleur DAO" : vinyl uni coloré non imprimable, pour découpe et lettrage.
- "Transfert" : papier ou film transfert pour flocage, sérigraphie ou thermocollant.
- "Covering" : film covering/wrapping pour véhicules, repositionnable, haute résistance.
- "Vitre" : adhésif vitrine transparent, givré, micro-perforé (vision-screen), film solaire ou occultant pour fenêtres.
- "Panneau" : support rigide (dibond, alu, PVC expansé, bois) pour contrecoller ou encadrer un visuel.

Ne confonds JAMAIS ces catégories.

STOCK DISPONIBLE :
${stockDesc}

MONTAGE : largeur_cm et hauteur_cm = dimensions EXPLICITEMENT données par le client dans le mail, converties en cm. Ne devine JAMAIS une dimension : si le client ne donne que la hauteur, mets largeur_cm à null (et inversement). laize_cm = la laize la plus adaptée parmi celles de l'adhésif recommandé dans le stock (null si non renseignées). nb_les et sens_les : null si une dimension manque. Ne parle JAMAIS de nombre de lés, de laize ou de raccords dans "preparation" ou "attention" : un plan de lés visuel est déjà affiché automatiquement à l'utilisateur.

Réponds UNIQUEMENT en JSON valide :
{"titre":"3-4 mots max ex: Logo vitrine extérieur","resume":"...","adhesifs":[{"nom":"nom exact du stock","raison":"...","priorite":"principal ou alternatif"}],"specs":{"finition":"...","duree":"...","pose":"...","retrait":"..."},"preparation":["..."],"attention":"... ou null","montage":{"largeur_cm":300,"hauteur_cm":120,"laize_cm":137,"nb_les":3,"sens_les":"vertical ou horizontal"}}`;

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
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    if (!claudeRes.ok) { if (pendingId) db.prepare('DELETE FROM analyses WHERE id=?').run(pendingId); return; }
    const data = await claudeRes.json();
    logUsage(user.id, 'analyse_email', 'claude-sonnet-4-6', data.usage, Boolean(user.api_key));
    const raw = data.content?.map(i => i.text || '').join('') || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { if (pendingId) db.prepare('DELETE FROM analyses WHERE id=?').run(pendingId); return; }

    let result;
    try { result = JSON.parse(jsonMatch[0]); } catch { if (pendingId) db.prepare('DELETE FROM analyses WHERE id=?').run(pendingId); return; }
    if (!result.adhesifs || !result.specs) { if (pendingId) db.prepare('DELETE FROM analyses WHERE id=?').run(pendingId); return; }

    // Stocker la première image/page PDF comme aperçu visuel
    let visuel_b64 = null, visuel_type = null;
    if (imageFiles.length) {
      visuel_b64 = imageFiles[0].buffer.toString('base64'); visuel_type = imageFiles[0].mimetype;
    } else if (pdfFiles.length) {
      const pages = await pdfToImages(pdfFiles[0].buffer);
      if (pages.length) { visuel_b64 = pages[0].data; visuel_type = 'image/png'; }
    }

    if (pendingId) {
      // Mettre à jour l'analyse pending avec le vrai résultat
      db.prepare(
        'UPDATE analyses SET result_json=?, status=?, visuel_b64=?, visuel_type=?, mail_content=? WHERE id=?'
      ).run(JSON.stringify(result), 'done', visuel_b64, visuel_type, mailContent, pendingId);
    } else {
      // Fallback : INSERT direct sans pending
      db.prepare(
        'INSERT INTO analyses (user_id, mail_content, consignes, result_json, source, visuel_b64, visuel_type) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(user.id, mailContent, '', JSON.stringify(result), 'email', visuel_b64, visuel_type);
    }
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
    const priceId = sub.items?.data?.[0]?.price?.id;
    const [plan, period] = planFromPriceId(priceId);
    // plan_override = plan forcé manuellement par l'admin, on ne touche pas au plan dans ce cas
    db.prepare('UPDATE users SET subscription_status = ?, plan = CASE WHEN plan_override=1 THEN plan ELSE ? END, plan_period = ? WHERE stripe_customer_id = ?')
      .run(sub.status, sub.status === 'active' ? plan : 'free', period, sub.customer);
  }
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    db.prepare('UPDATE users SET subscription_status = ?, plan = CASE WHEN plan_override=1 THEN plan ELSE ? END WHERE stripe_customer_id = ?').run('inactive', 'free', sub.customer);
  }

  res.json({ received: true });
});

module.exports = router;
