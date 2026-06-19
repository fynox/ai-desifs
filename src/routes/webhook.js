const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const db = require('../config/db');
const { logUsage } = require('../utils/usage');
const { planFromPriceId } = require('../utils/plans');
const { getSetting } = require('../utils/appSettings');
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

  let pendingId = null;
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
    // Adresse mail dédiée réservée aux plans Pro et Ultra + limite mensuelle d'analyses
    const { hasMailInbound, checkLimit } = require('../utils/limits');
    if (!hasMailInbound(user)) return;
    if (checkLimit(user, 'analyses')) return;
    const apiKey = getSetting('ANTHROPIC_API_KEY');
    if (!apiKey) return;

    const stockDispo = db.prepare('SELECT * FROM stock WHERE user_id = ? AND dispo = 1').all(user.id);
    if (!stockDispo.length) return;

    const mailContent = `De : ${from}\nObjet : ${subject}\n\n${text}`.slice(0, 5000);

    // Déduplication : SendGrid peut livrer le même mail deux fois → on ignore si une analyse
    // identique (même contenu) existe déjà depuis moins de 10 minutes
    const dup = db.prepare(
      "SELECT id FROM analyses WHERE user_id = ? AND mail_content = ? AND created_at >= datetime('now','-10 minutes')"
    ).get(user.id, mailContent);
    if (dup) return;

    // Insérer une analyse "pending" visible immédiatement (optionnel — ne bloque pas si colonne absente)
    try {
      const pendingRow = db.prepare(
        'INSERT INTO analyses (user_id, mail_content, consignes, result_json, source, status) VALUES (?,?,?,?,?,?)'
      ).run(user.id, mailContent, '', '{}', 'email', 'pending');
      pendingId = pendingRow.lastInsertRowid;
    } catch { /* colonne status pas encore migrée, on continue sans pending */ }

    const CAT_LABELS = { imprimable:'Imprimable', plastification:'Plastification', dao:'Couleur DAO', transfert:'Papier transfert', covering:'Covering voiture', vitre:'Vitre / Solaire', panneau:'Panneau' };
    const stockDesc = Object.keys(CAT_LABELS).map(cat => {
      const items = stockDispo.filter(i => i.cat === cat);
      if (!items.length) return '';
      return `--- ${CAT_LABELS[cat]} ---\n` + items.map(i => {
        const res2 = JSON.parse(i.resistances || '[]');
        const app = JSON.parse(i.applications || '[]');
        // Les laizes du stock peuvent être saisies en mm (ex: 1520) → on normalise en cm
        const normCm = v => { const n = Number(v); return n > 400 ? Math.round(n / 10) : n; };
        const lar = JSON.parse(i.largeurs || '[]').map(normCm).filter(Boolean);
        const vars = JSON.parse(i.variantes || '[]');
        const varTxt = vars.length
          ? ' | variantes disponibles (UNIQUEMENT ces combinaisons couleur/laize): ' + vars.map(v => `${v.couleur || 'standard'}${v.largeur ? ' en ' + normCm(v.largeur) + ' cm' : ''}`).join(', ')
          : (lar.length ? ' | laizes: ' + lar.join(', ') + ' cm' : '');
        return `• ${i.nom} | ${i.finition} | ${i.adherence} | ${i.env} | ${i.duree}${varTxt}${res2.length ? ' | ' + res2.join(', ') : ''}${app.length ? ' | ' + app.join(', ') : ''}${i.note ? ' | ' + i.note : ''}`;
      }).join('\n');
    }).filter(Boolean).join('\n\n');

    const systemPrompt = `Tu es un expert en impression numérique et adhésifs vinyl pour une entreprise de signalétique et d'impression grand format.

DÉFINITIONS IMPORTANTES — respecte-les strictement :
- "Imprimable" : adhésif vinyl blanc ou transparent destiné à être imprimé directement (impression numérique, décoration, signalétique).
- "Plastification" : film/rouleau adhésif transparent appliqué PAR-DESSUS une impression terminée pour la protéger (laminage : anti-UV, anti-rayures, anti-humidité). Ne s'imprime PAS. Recommande-le quand le visuel imprimé a besoin d'être protégé (extérieur, sol, passage, manipulation).
- "Couleur DAO" : vinyl uni coloré non imprimable, pour découpe et lettrage.
- "Transfert" : papier ou film transfert pour flocage, sérigraphie ou thermocollant.
- "Covering" : film covering/wrapping pour véhicules, repositionnable, haute résistance.
- "Vitre" : adhésif vitrine transparent, givré, micro-perforé (vision-screen), film solaire ou occultant pour fenêtres.
- "Panneau" : support rigide (dibond, alu, PVC expansé, bois) pour contrecoller ou encadrer un visuel.

Ne confonds JAMAIS ces categories.

REGLE ABSOLUE D'IMPRESSION : pour TOUTE impression d'un visuel (logo, photo, fond de couleur, affiche, decor mural...), recommande UNIQUEMENT un adhesif de categorie "Imprimable" (vinyl BLANC imprimable). La couleur du visuel n'a AUCUNE importance : un fond bleu, rouge ou noir s'imprime sur du vinyl BLANC. N'utilise JAMAIS un vinyl de couleur ("Couleur DAO") pour reproduire un visuel imprime. La categorie "Couleur DAO" sert EXCLUSIVEMENT a decouper du lettrage ou des formes en vinyl uni, et UNIQUEMENT si le client demande explicitement de la decoupe/du lettrage adhesif (pas d'impression).

STOCK DISPONIBLE :
${stockDesc}

MONTAGE : largeur_cm et hauteur_cm = dimensions EXPLICITEMENT données par le client dans le mail, converties en cm. Ne devine JAMAIS une dimension a partir de l'image (tu n'en vois qu'une copie reduite) : si le client ne donne que la hauteur, mets largeur_cm a null (et inversement). Si le client dit 'echelle 1', 'taille reelle' ou 'scale 1' SANS chiffres, mets largeur_cm ET hauteur_cm a null : l'imprimeur saisira la taille reelle lui-meme. laize_cm = la laize la plus adaptée EN CENTIMÈTRES (ex: 152 pour un rouleau de 1520 mm, jamais de valeur en mm) parmi celles de l'adhésif recommandé dans le stock (null si non renseignées). nb_les et sens_les : null si une dimension manque. Si tu reperes des reperes/traits de decoupe (petits traits noirs ou croix dans les angles du fichier), ajoute IMPERATIVEMENT une etape dans "preparation" : 'Reperes de decoupe presents dans les angles du fichier — decouper en les suivant (ne pas les rogner).'. debord_mm = marge de debord de pose autour du visuel : mets 0 si le client dit 'pas de bords tournants', 'echelle 1', 'taille reelle', ou si des reperes de decoupe sont presents (la coupe suit le fichier) ; sinon mets null (marge par defaut de l'utilisateur). Ne parle JAMAIS de nombre de les, de laize ou de raccords dans "preparation" ou "attention" : un plan de lés visuel est déjà affiché automatiquement à l'utilisateur.

Réponds UNIQUEMENT en JSON valide :
{"titre":"3-4 mots max ex: Logo vitrine extérieur","resume":"...","adhesifs":[{"nom":"nom exact du stock","raison":"...","priorite":"principal ou alternatif"}],"specs":{"finition":"...","duree":"...","pose":"...","retrait":"..."},"preparation":["..."],"attention":"... ou null","montage":{"largeur_cm":300,"hauteur_cm":120,"laize_cm":137,"nb_les":3,"sens_les":"vertical ou horizontal","debord_mm":0}}`;

    // Échec visible : on garde l'analyse avec un message d'erreur au lieu de la supprimer
    const failItem = (msg) => {
      if (pendingId) db.prepare("UPDATE analyses SET status='failed', error_msg=? WHERE id=?").run(msg, pendingId);
    };

    // Pièces jointes : images directes + PDFs convertis en PNG
    const files = req.files || [];
    const imageFiles = files.filter(f => f.mimetype && f.mimetype.startsWith('image/'));
    const pdfFiles = files.filter(f => f.mimetype === 'application/pdf' || f.originalname?.endsWith('.pdf'));

    // Fichiers joints via lien Google Drive : Gmail insère un LIEN, pas une pièce jointe.
    if (!imageFiles.length && !pdfFiles.length) {
      const driveIds = [...new Set(
        [...`${text} ${req.body.html || ''}`.matchAll(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=download&)?id=)([\w-]{20,})/g)].map(mm => mm[1])
      )].slice(0, 6);
      for (const id of driveIds) {
        try {
          const r = await fetch(`https://drive.google.com/uc?export=download&id=${id}`, { redirect: 'follow' });
          if (!r.ok) continue;
          const ct = (r.headers.get('content-type') || '').split(';')[0].trim();
          const cd = r.headers.get('content-disposition') || '';
          const nameM = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)/i);
          const name = nameM ? decodeURIComponent(nameM[1]) : '';
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length > 20 * 1024 * 1024) continue;
          if (ct.startsWith('image/')) imageFiles.push({ mimetype: ct, buffer: buf, originalname: name });
          else if (ct === 'application/pdf') pdfFiles.push({ mimetype: ct, buffer: buf, originalname: name || 'drive.pdf' });
        } catch (e) { console.error('Drive fetch error:', e.message); }
      }
    }

    // Extrait des dimensions depuis un nom de fichier (ex: "...1170x2400mm.pdf" → {w:1170,h:2400} en mm)
    const parseDims = (nm) => {
      if (!nm) return {};
      const m = nm.match(/(\d{2,5})\s*[xX×]\s*(\d{2,5})/);
      if (!m) return {};
      const mm = v => (v > 0 && v < 400 ? v * 10 : v); // cm → mm si petit
      return { w: mm(+m[1]), h: mm(+m[2]), name: nm };
    };

    // Tous les visuels ORIGINAUX (pleine qualité, conservés pour l'export) — jusqu'à 6 — avec nom + dims
    const { shrinkForApi } = require('../utils/image');
    const visuels = [];
    for (const img of imageFiles) visuels.push({ b64: img.buffer.toString('base64'), type: img.mimetype, ...parseDims(img.originalname) });
    for (const pdf of pdfFiles) {
      const pages = await pdfToImages(pdf.buffer);
      const dims = parseDims(pdf.originalname);
      pages.forEach((p, idx) => visuels.push({ b64: p.data, type: 'image/png', ...(idx === 0 ? dims : {}) }));
    }
    const allVisuels = visuels.slice(0, 6);

    // Récap fichiers (noms + tailles) pour informer l'IA
    const filesList = allVisuels.filter(v => v.name).map((v, i) => `Fichier ${i + 1}: ${v.name}${v.w && v.h ? ` (${v.w}×${v.h} mm)` : ''}`).join('\n');

    // Pour l'IA : copie réduite si > 8000 px (l'original stocké reste intact)
    const userContent = [{ type: 'text', text: allVisuels.length > 1
      ? `${mailContent}\n\n[${allVisuels.length} fichiers joints à cette demande — analyse-les tous. Ce sont des visuels distincts à imprimer (souvent de TAILLES DIFFÉRENTES — voir les noms de fichiers).${filesList ? '\nFichiers :\n' + filesList : ''}\nListe-les dans le résumé avec leur taille si connue.]`
      : `${mailContent}${filesList ? '\n\n[Fichier joint : ' + filesList + ']' : ''}` }];
    for (const v of allVisuels) {
      const s = await shrinkForApi(Buffer.from(v.b64, 'base64'), v.type);
      userContent.push({ type: 'image', source: { type: 'base64', media_type: s.type, data: s.b64 } });
    }

    let claudeRes;
    try {
      claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2500, system: systemPrompt, messages: [{ role: 'user', content: userContent }] }),
      });
    } catch (e) { failItem('Impossible de joindre l\'API Anthropic.'); return; }

    const data = await claudeRes.json();
    if (!claudeRes.ok) { failItem(data?.error?.message || `Erreur Anthropic ${claudeRes.status}`); return; }
    logUsage(user.id, 'analyse_email', 'claude-sonnet-4-6', data.usage);
    const raw = data.content?.map(i => i.text || '').join('') || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { failItem('Réponse IA illisible — réessayez.'); return; }

    let result;
    try { result = JSON.parse(jsonMatch[0]); } catch { failItem('JSON invalide dans la réponse IA (réponse tronquée ?).'); return; }
    if (!result.adhesifs || !result.specs) { failItem('Structure de réponse incomplète.'); return; }

    // Stocker tous les visuels (sauf si le quota de stockage est plein)
    let visuel_b64 = null, visuel_type = null, visuelsToStore = [];
    const storageFull = (() => { try { return require('../utils/storage').isStorageFull(user.id); } catch { return false; } })();
    if (!storageFull && allVisuels.length) {
      visuel_b64 = allVisuels[0].b64; visuel_type = allVisuels[0].type;
      visuelsToStore = allVisuels;
    }
    const visuelsJson = visuelsToStore.length > 1 ? JSON.stringify(visuelsToStore) : null;

    if (pendingId) {
      db.prepare(
        "UPDATE analyses SET result_json=?, status='done', error_msg=NULL, visuel_b64=?, visuel_type=?, visuels_json=?, mail_content=? WHERE id=?"
      ).run(JSON.stringify(result), visuel_b64, visuel_type, visuelsJson, mailContent, pendingId);
    } else {
      db.prepare(
        'INSERT INTO analyses (user_id, mail_content, consignes, result_json, source, visuel_b64, visuel_type, visuels_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(user.id, mailContent, '', JSON.stringify(result), 'email', visuel_b64, visuel_type, visuelsJson);
    }
  } catch (e) {
    console.error('Webhook inbound error:', e);
    try { if (pendingId) db.prepare("UPDATE analyses SET status='failed', error_msg=? WHERE id=?").run('Erreur interne pendant l\'analyse.', pendingId); } catch {}
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
