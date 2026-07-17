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
    // Send Raw ON → tout est dans req.body.email (MIME brut) : on le parse proprement (texte + pièces jointes).
    // Send Raw OFF → texte dans text/html et pièces jointes dans req.files. On gère les DEUX cas.
    let text = req.body.text || '';
    let rawAttachments = [];
    if (req.body.email) {
      try {
        const { simpleParser } = require('mailparser');
        const parsed = await simpleParser(req.body.email);
        if (!text) text = (parsed.text || (parsed.html || '').replace(/<[^>]+>/g, ' ')).trim();
        rawAttachments = (parsed.attachments || [])
          .filter(a => a.content && a.content.length)
          .map(a => ({ mimetype: a.contentType || 'application/octet-stream', buffer: a.content, originalname: a.filename || 'piece-jointe' }));
      } catch (e) { console.error('MIME parse error:', e.message); }
    }
    if (!text) text = (req.body.html || '').replace(/<[^>]+>/g, ' ').trim();

    // Extraire l'adresse inbound complète dans le champ "to".
    // Le champ "to" peut contenir plusieurs adresses (destinataires en copie) → on les teste toutes.
    const candidates = [];
    for (const m of String(to).matchAll(/([^\s<,;]+@[^\s>,;]+)/g)) {
      const addr = m[1].toLowerCase();
      candidates.push(addr);
      // Tolérance : SendGrid reçoit sur le sous-domaine "mail." mais l'adresse stockée est sur le domaine racine (et vice-versa)
      if (addr.includes('@mail.')) candidates.push(addr.replace('@mail.', '@'));
      else candidates.push(addr.replace('@', '@mail.'));
    }
    if (!candidates.length) return;
    let user = null;
    for (const addr of [...new Set(candidates)]) {
      user = db.prepare('SELECT * FROM users WHERE inbound_email = ?').get(addr);
      if (user) break;
    }
    if (!user) return; // adresse inconnue : impossible de rattacher à un compte

    const { hasMailInbound, affordAnalyse, analyseOverQuota, consumeJetons } = require('../utils/limits');
    const { JETON_COSTS } = require('../utils/plans');

    const mailContent = `De : ${from}\nObjet : ${subject}\n\n${text}`.slice(0, 5000);

    // Déduplication : SendGrid peut livrer le même mail deux fois → on ignore si une analyse
    // identique (même contenu) existe déjà depuis moins de 10 minutes
    const dup = db.prepare(
      "SELECT id FROM analyses WHERE user_id = ? AND mail_content = ? AND created_at >= datetime('now','-10 minutes')"
    ).get(user.id, mailContent);
    if (dup) return;

    // On crée TOUT DE SUITE une analyse visible (pending) : ainsi, même si le mail est refusé
    // (plan, stock, quota…), l'utilisateur VOIT que le mail est bien arrivé + la raison du refus.
    try {
      const pendingRow = db.prepare(
        'INSERT INTO analyses (user_id, mail_content, consignes, result_json, source, status) VALUES (?,?,?,?,?,?)'
      ).run(user.id, mailContent, '', '{}', 'email', 'pending');
      pendingId = pendingRow.lastInsertRowid;
    } catch { /* colonne status pas encore migrée, on continue sans pending */ }

    // Notification temps réel : le mail est arrivé, l'analyse démarre
    const { emitToOwnerTeam } = require('../utils/events');
    if (pendingId) emitToOwnerTeam(user.id, 'mail_recu', { analyse_id: pendingId });

    // Marque l'analyse en échec avec un message clair (visible dans l'historique)
    const failItem = (msg) => {
      if (pendingId) {
        db.prepare("UPDATE analyses SET status='failed', error_msg=? WHERE id=?").run(msg, pendingId);
        emitToOwnerTeam(user.id, 'analyse_done', { analyse_id: pendingId, failed: true });
      }
    };

    // Garde-fous — désormais VISIBLES (l'analyse apparaît en échec avec la raison au lieu de disparaître)
    if (user.subscription_status !== 'active') { failItem('Abonnement inactif — réactive ton forfait pour recevoir les analyses par mail.'); return; }
    if (!hasMailInbound(user)) { failItem('Adresse mail dédiée réservée aux forfaits Pro et supérieurs.'); return; }
    const apiKey = getSetting('ANTHROPIC_API_KEY');
    if (!apiKey) { failItem('Service momentanément indisponible (clé API non configurée côté admin).'); return; }
    const stockDispo = db.prepare('SELECT * FROM stock WHERE user_id = ? AND dispo = 1').all(user.id);
    if (!stockDispo.length) { failItem('Aucun adhésif en stock disponible — ajoute des références dans ton stock avant d\'analyser.'); return; }
    if (affordAnalyse(user)) { failItem('Quota d\'analyses atteint ce mois-ci et solde de jetons insuffisant.'); return; }
    const mailOverQuota = analyseOverQuota(user);

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
- "Plastification" : film transparent de lamination applique PAR-DESSUS un visuel deja imprime pour le proteger. Ne s'imprime PAS et ne se pose PAS seul (jamais sur mur/sol/vitre directement). C'est un AJOUT OPTIONNEL, pas systematique : recommande-le EN PLUS de l'adhesif imprimable UNIQUEMENT si le visuel a besoin de protection (exterieur, sol, fort passage, manipulation, anti-UV, longue duree). Precise qu'il ajoute une epaisseur et modifie le rendu (effet brillant, mat ou satine selon le film choisi). Si la protection n'est pas necessaire, ne le recommande pas.
- "Couleur DAO" : vinyl uni coloré non imprimable, pour découpe et lettrage.
- "Transfert" : papier ou film transfert pour flocage, sérigraphie ou thermocollant.
- "Covering" : film covering/wrapping pour véhicules, repositionnable, haute résistance.
- "Vitre" : adhésif vitrine transparent, givré, micro-perforé (vision-screen), film solaire ou occultant pour fenêtres.
- "Panneau" : support rigide (dibond, alu, PVC expansé, bois) pour contrecoller ou encadrer un visuel.

Ne confonds JAMAIS ces categories.

REGLE DE RECOMMANDATION : mets EN AVANT UN SEUL adhesif 'principal' (le mieux adapte a ce cas precis). N'ajoute un 2e adhesif 'alternatif' QUE s'il apporte un vrai compromis different (ex: moins cher, autre finition utile) — JAMAIS deux references quasi identiques en concurrence. Le principal doit etre clairement LE choix recommande.
DISTINCTION IMPORTANTE : une PLASTIFICATION (film de protection a poser PAR-DESSUS l'adhesif imprime) n'est JAMAIS une 'alternative' — c'est un AJOUT. Si une plastification est necessaire, mets-la avec "priorite":"complement" (jamais 'alternatif'). 'alternatif' = un AUTRE adhesif qui REMPLACE le principal. 'complement' = un produit qui s'AJOUTE au principal (plastification, lamination).
MANQUE EN STOCK : si le produit LE PLUS ADAPTE a la demande (adhesif ou plastification) n'existe PAS dans le stock ci-dessus, recommande quand meme le meilleur produit DISPONIBLE en principal, ET renseigne le champ "manque_stock" avec un conseil d'achat court et concret (type de produit ideal, finition, caracteristiques — ex: 'Pour cette pose au sol, l'ideal serait un adhesif sol antiderapant certifie R10 avec plastification mate, absent de ton stock actuel.'). Si le stock contient deja le produit ideal, mets "manque_stock" a null — n'invente JAMAIS un manque.

REGLE ABSOLUE D'IMPRESSION : pour TOUTE impression d'un visuel (logo, photo, fond de couleur, affiche, decor mural...), recommande UNIQUEMENT un adhesif de categorie "Imprimable" (vinyl BLANC imprimable). La couleur du visuel n'a AUCUNE importance : un fond bleu, rouge ou noir s'imprime sur du vinyl BLANC. N'utilise JAMAIS un vinyl de couleur ("Couleur DAO") pour reproduire un visuel imprime. La categorie "Couleur DAO" sert EXCLUSIVEMENT a decouper du lettrage ou des formes en vinyl uni, et UNIQUEMENT si le client demande explicitement de la decoupe/du lettrage adhesif (pas d'impression).

STOCK DISPONIBLE :
${stockDesc}

MONTAGE : largeur_cm et hauteur_cm = dimensions EXPLICITEMENT données par le client dans le mail, converties en cm. Ne devine JAMAIS une dimension a partir de l'image (tu n'en vois qu'une copie reduite) : si le client ne donne que la hauteur, mets largeur_cm a null (et inversement). Si le client dit 'echelle 1', 'taille reelle' ou 'scale 1' SANS chiffres, mets largeur_cm ET hauteur_cm a null : l'imprimeur saisira la taille reelle lui-meme. quantite = nombre d'exemplaires IDENTIQUES demandes par le client (ex: '500 stickers', 'tirage de 200' -> 500 ou 200). Mets 1 si un seul exemplaire est demande. laize_cm = la laize la plus adaptée EN CENTIMÈTRES (ex: 152 pour un rouleau de 1520 mm, jamais de valeur en mm) parmi celles de l'adhésif recommandé dans le stock (null si non renseignées). nb_les et sens_les : null si une dimension manque. Si tu reperes des reperes/traits de decoupe (petits traits noirs ou croix dans les angles du fichier), ajoute IMPERATIVEMENT une etape dans "preparation" : 'Reperes de decoupe presents dans les angles du fichier — decouper en les suivant (ne pas les rogner).'. debord_mm = marge de debord de pose autour du visuel : mets 0 si le client dit 'pas de bords tournants', 'echelle 1', 'taille reelle', ou si des reperes de decoupe sont presents (la coupe suit le fichier) ; sinon mets null (marge par defaut de l'utilisateur). Ne parle JAMAIS de nombre de les, de laize ou de raccords dans "preparation" ou "attention" : un plan de lés visuel est déjà affiché automatiquement à l'utilisateur.

MULTI-FICHIERS (plusieurs fichiers joints) : détermine si les fichiers forment UN SEUL grand visuel à ASSEMBLER côte à côte (raccord/juxtaposition — indices : même hauteur, mention 'panoramique/fresque/mur continu', fichiers nommés 'partie 1/2/3' ou 'gauche/centre/droite', bords qui se raccordent) OU s'ils sont des visuels SÉPARÉS et indépendants (indices : tailles différentes, sujets différents, 'plusieurs panneaux/affiches'). Renseigne le champ "assemblage" : "assemble" (un seul visuel à coller côte à côte), "separe" (impressions indépendantes), ou "inconnu". IMPORTANT : NE SUPPOSE JAMAIS l'assemblage par défaut. Si le mail ne le dit pas explicitement, OU si les fichiers ont des tailles différentes, mets "inconnu" et n'affirme PAS dans le résumé que ce sont des lés d'un même visuel. Dans ce cas ajoute dans "attention" : 'À confirmer avec le client : les fichiers sont-ils à assembler côte à côte (un seul visuel) ou à imprimer séparément ?'. Si assemblage vaut "separe" ou "inconnu", NE cumule PAS les largeurs et NE parle PAS de "lé 1/2/3" d'un visuel unique.

SÉPARE BIEN les deux listes d'étapes : "preparation" = étapes d'ATELIER avant la pose (fichier, vectorisation, impression, découpe, échenillage, tape de transfert...) destinées au préparateur. "pose" = conseils d'APPLICATION SUR SITE destinés au poseur UNIQUEMENT (nettoyage/préparation de la surface, pose humide ou à sec, température minimale, marouflage, sens de pose, raccords, si l'adhésif est repositionnable (coller-décoller possible) ou à pose définitive en 1 fois, retrait du transfert...). Ne mets JAMAIS d'étape d'atelier dans "pose".

Réponds UNIQUEMENT en JSON valide :
{"titre":"3-4 mots max ex: Logo vitrine extérieur","resume":"...","adhesifs":[{"nom":"nom exact du stock","raison":"...","priorite":"principal ou alternatif ou complement"}],"manque_stock":"conseil d achat si le produit ideal manque au stock, sinon null","specs":{"finition":"...","duree":"...","pose":"...","retrait":"..."},"preparation":["..."],"pose":["..."],"attention":"... ou null","montage":{"largeur_cm":300,"hauteur_cm":120,"laize_cm":137,"nb_les":3,"sens_les":"vertical ou horizontal","debord_mm":0,"quantite":1,"assemblage":"assemble|separe|inconnu"}}`;

    // Pièces jointes : celles détachées par SendGrid (req.files) + celles extraites du MIME brut (Send Raw)
    const files = [...(req.files || []), ...rawAttachments];
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
    if (mailOverQuota) consumeJetons(user, JETON_COSTS.analyse_extra, 'analyse_extra');

    // Stocker tous les visuels (sauf si le quota de stockage est plein)
    let visuel_b64 = null, visuel_type = null, visuelsToStore = [];
    const storageFull = (() => { try { return require('../utils/storage').isStorageFull(user.id); } catch { return false; } })();
    if (!storageFull && allVisuels.length) {
      visuel_b64 = allVisuels[0].b64; visuel_type = allVisuels[0].type;
      visuelsToStore = allVisuels;
    }
    const visuelsJson = visuelsToStore.length > 1 ? JSON.stringify(visuelsToStore) : null;

    // Fiche client : adresse du client final. Mail transféré → l'expéditeur d'origine est dans le corps
    // ("De :/From: ... <adresse>") ; mail direct → le champ from (sauf si c'est l'utilisateur lui-même).
    let clientEmail = null;
    try {
      const fwd = text.match(/(?:De|From)\s*:\s*[^\n<]*<([\w.+-]+@[\w-]+\.[\w.-]+)>/i) || text.match(/(?:De|From)\s*:\s*([\w.+-]+@[\w-]+\.[\w.-]+)/i);
      if (fwd) clientEmail = fwd[1].toLowerCase();
      else {
        const m = String(from).match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
        if (m && m[0].toLowerCase() !== user.email.toLowerCase()) clientEmail = m[0].toLowerCase();
      }
    } catch {}

    if (pendingId) {
      db.prepare(
        "UPDATE analyses SET result_json=?, status='done', error_msg=NULL, visuel_b64=?, visuel_type=?, visuels_json=?, mail_content=?, client_email=? WHERE id=?"
      ).run(JSON.stringify(result), visuel_b64, visuel_type, visuelsJson, mailContent, clientEmail, pendingId);
    } else {
      db.prepare(
        'INSERT INTO analyses (user_id, mail_content, consignes, result_json, source, visuel_b64, visuel_type, visuels_json, client_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(user.id, mailContent, '', JSON.stringify(result), 'email', visuel_b64, visuel_type, visuelsJson, clientEmail);
    }
    emitToOwnerTeam(user.id, 'analyse_done', { analyse_id: pendingId || null });
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
  // Achat ponctuel d'un pack de jetons → créditer le portefeuille
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    if (s.mode === 'payment' && s.payment_status === 'paid' && s.metadata && s.metadata.jetons) {
      const uid = Number(s.metadata.user_id), jetons = Number(s.metadata.jetons);
      if (uid && jetons > 0) {
        try { db.prepare('UPDATE users SET jetons = COALESCE(jetons,0) + ? WHERE id = ?').run(jetons, uid); }
        catch (e) { console.error('Crédit jetons error:', e.message); }
      }
    }
  }

  res.json({ received: true });
});

module.exports = router;
