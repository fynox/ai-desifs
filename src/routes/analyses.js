const express = require('express');
const fetch = require('node-fetch');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function pdfFirstPage(buffer) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-'));
  const pdfPath = path.join(tmp, 'input.pdf');
  const outPrefix = path.join(tmp, 'page');
  fs.writeFileSync(pdfPath, buffer);
  return new Promise(resolve => {
    execFile('pdftoppm', ['-png', '-r', '120', '-l', '1', pdfPath, outPrefix], err => {
      if (err) { fs.rmSync(tmp, { recursive: true, force: true }); resolve(null); return; }
      const files = fs.readdirSync(tmp).filter(f => f.endsWith('.png')).sort();
      const result = files.length ? fs.readFileSync(path.join(tmp, files[0])).toString('base64') : null;
      fs.rmSync(tmp, { recursive: true, force: true });
      resolve(result);
    });
  });
}

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM analyses WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json(rows.map(r => {
    const isPending = r.status === 'pending';
    return {
      ...r,
      result: isPending ? null : JSON.parse(r.result_json),
      lu: Boolean(r.lu),
      visuel_b64: r.visuel_b64 || null,
      visuel_type: r.visuel_type || null,
      _pending: isPending,
    };
  }));
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

// Génère un mail de relance au client pour demander les infos manquantes
router.post('/:id/relance', async (req, res) => {
  const item = db.prepare('SELECT * FROM analyses WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Analyse introuvable.' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const apiKey = user.api_key || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'Clé API Anthropic non configurée.' });

  let result = {};
  try { result = JSON.parse(item.result_json || '{}'); } catch {}

  // Extraire l'email du client depuis le contenu du mail ("De : ...")
  const emailMatch = (item.mail_content || '').match(/De\s*:\s*[^<\n]*<?([\w.+-]+@[\w.-]+\.\w{2,})>?/i)
    || (item.mail_content || '').match(/([\w.+-]+@[\w.-]+\.\w{2,})/);
  const clientEmail = emailMatch ? emailMatch[1] : '';

  const prompt = `Tu es un imprimeur professionnel (signalétique / adhésifs). Un client a envoyé cette demande :

---
${(item.mail_content || '').slice(0, 3000)}
---

Analyse réalisée en interne :
Résumé : ${result.resume || 'N/A'}
${result.attention ? `Point d'attention : ${result.attention}` : ''}

${req.body?.ton === 'familier'
    ? `Rédige un mail de réponse chaleureux et décontracté en français pour demander au client les informations manquantes nécessaires pour finaliser le devis/la recommandation (ex: dimensions exactes, surface de pose, intérieur/extérieur, durée souhaitée, quantité, fichier visuel, échéance...). C'est un client de longue date : tutoiement autorisé, ton amical et direct, mais reste pro sur le fond. Ne demande QUE ce qui manque réellement dans sa demande. Sois concis (5-10 lignes max), termine par une formule sympa SANS signature nominative (l'expéditeur signera lui-même).`
    : `Rédige un mail de réponse courtois et professionnel en français pour demander au client les informations manquantes nécessaires pour finaliser le devis/la recommandation (ex: dimensions exactes, surface de pose, intérieur/extérieur, durée souhaitée, quantité, fichier visuel, échéance...). Ne demande QUE ce qui manque réellement dans sa demande. Sois concis (5-10 lignes max), tutoiement interdit, termine par une formule de politesse SANS signature nominative (le client signera lui-même).`}

Réponds UNIQUEMENT en JSON valide : {"objet":"...","corps":"..."}`;

  let claudeRes;
  try {
    claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch {
    return res.status(502).json({ error: 'Impossible de joindre l\'API Anthropic.' });
  }

  const data = await claudeRes.json();
  if (!claudeRes.ok) return res.status(502).json({ error: data?.error?.message || `Erreur Anthropic ${claudeRes.status}` });

  const raw = data.content?.map(i => i.text || '').join('') || '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return res.status(502).json({ error: 'Réponse IA invalide — réessayez.' });

  let mail;
  try { mail = JSON.parse(jsonMatch[0]); } catch { return res.status(502).json({ error: 'JSON invalide dans la réponse IA.' }); }
  if (!mail.objet || !mail.corps) return res.status(502).json({ error: 'Réponse incomplète — réessayez.' });

  res.json({ to: clientEmail, objet: mail.objet, corps: mail.corps });
});

// Génère un devis automatique approximatif basé sur le stock (prix m², encre)
router.post('/:id/devis', async (req, res) => {
  const item = db.prepare('SELECT * FROM analyses WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Analyse introuvable.' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const apiKey = user.api_key || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'Clé API Anthropic non configurée.' });

  let result = {};
  try { result = JSON.parse(item.result_json || '{}'); } catch {}

  const stockDispo = db.prepare('SELECT * FROM stock WHERE user_id = ? AND dispo = 1').all(req.user.id);
  const encres = stockDispo.filter(i => i.cat === 'encre');
  const adhesifs = stockDispo.filter(i => i.cat !== 'encre');

  // Adhésifs recommandés en priorité, sinon tout le stock avec prix
  const nomsReco = (result.adhesifs || []).map(a => a.nom);
  const stockLines = adhesifs.map(i => {
    const largeurs = JSON.parse(i.largeurs || '[]');
    return `• ${i.nom} (${i.cat})${nomsReco.includes(i.nom) ? ' [RECOMMANDÉ PAR L\'ANALYSE]' : ''} | prix: ${i.prix_m2 != null ? i.prix_m2 + ' €/m²' : 'NON RENSEIGNÉ'}${largeurs.length ? ' | laizes: ' + largeurs.join(', ') + ' cm' : ''}`;
  }).join('\n');
  const encreLines = encres.length
    ? encres.map(i => `• ${i.nom} | prix: ${i.prix_m2 != null ? i.prix_m2 + ' €/m² imprimé' : 'NON RENSEIGNÉ'}${i.note ? ' | ' + i.note : ''}`).join('\n')
    : 'Aucune encre renseignée — utilise une estimation standard de 0,80 €/m² imprimé et signale-le dans les hypothèses.';

  const prompt = `Tu es un imprimeur professionnel (signalétique / adhésifs grand format). Établis un DEVIS APPROXIMATIF pour cette demande client :

---
${(item.mail_content || '').slice(0, 3000)}
---

Analyse interne : ${result.resume || 'N/A'}
Adhésif(s) recommandé(s) : ${nomsReco.join(', ') || 'N/A'}

STOCK ADHÉSIFS (prix au m² HT) :
${stockLines || 'Aucun'}

ENCRES D'IMPRESSION (coût au m² imprimé) :
${encreLines}

RÈGLES :
- Utilise en priorité les adhésifs recommandés par l'analyse et leurs prix réels du stock.
- Calcule la surface à partir des dimensions du mail. Si dimensions absentes, fais une hypothèse raisonnable et signale-la.
- Tiens compte des laizes (largeurs de rouleau) pour estimer le nombre de lés et les chutes.
- Ajoute le coût d'encre si le support est imprimé.
- Ajoute une ligne main d'œuvre/découpe raisonnable (~35-50 €/h selon complexité) et indique l'hypothèse.
- Si un prix manque dans le stock, fais une estimation marché et signale-le dans les hypothèses.
- Tous les montants en € HT.

Réponds UNIQUEMENT en JSON valide :
{"lignes":[{"designation":"...","details":"surface, nb lés, etc.","quantite":"...","prix_unitaire":"...","total":0}],"total_ht":0,"marge_conseillee":"ex: x2 à x2.5 pour le prix de vente","hypotheses":["..."]}`;

  let claudeRes;
  try {
    claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch {
    return res.status(502).json({ error: 'Impossible de joindre l\'API Anthropic.' });
  }

  const data = await claudeRes.json();
  if (!claudeRes.ok) return res.status(502).json({ error: data?.error?.message || `Erreur Anthropic ${claudeRes.status}` });

  const raw = data.content?.map(i => i.text || '').join('') || '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return res.status(502).json({ error: 'Réponse IA invalide — réessayez.' });

  let devis;
  try { devis = JSON.parse(jsonMatch[0]); } catch { return res.status(502).json({ error: 'JSON invalide dans la réponse IA.' }); }
  if (!devis.lignes) return res.status(502).json({ error: 'Réponse incomplète — réessayez.' });

  res.json(devis);
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
  const apiKey = user.api_key || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'Clé API Anthropic non configurée.' });

  const stockDispo = db.prepare('SELECT * FROM stock WHERE user_id = ? AND dispo = 1').all(req.user.id);
  if (!stockDispo.length) return res.status(400).json({ error: 'Aucun adhésif en stock disponible.' });

  const CAT_LABELS = { imprimable:'Imprimable', liner:'Liner', dao:'Couleur DAO', transfert:'Papier transfert', covering:'Covering voiture', vitre:'Vitre / Solaire', panneau:'Panneau' };
  const stockDesc = Object.keys(CAT_LABELS).map(cat => {
    const items = stockDispo.filter(i => i.cat === cat);
    if (!items.length) return '';
    return `--- ${CAT_LABELS[cat]} ---\n` + items.map(i => {
      const res = JSON.parse(i.resistances || '[]');
      const app = JSON.parse(i.applications || '[]');
      return `• ${i.nom} | ${i.finition} | ${i.adherence} | ${i.env} | ${i.duree}${res.length ? ' | ' + res.join(', ') : ''}${app.length ? ' | ' + app.join(', ') : ''}${i.note ? ' | ' + i.note : ''}`;
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

Réponds UNIQUEMENT en JSON valide :
{"titre":"3-4 mots max ex: Logo vitrine extérieur","resume":"...","adhesifs":[{"nom":"nom exact du stock","raison":"...","priorite":"principal ou alternatif"}],"specs":{"finition":"...","duree":"...","pose":"...","retrait":"..."},"preparation":["..."],"attention":"... ou null"}`;

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
        'x-api-key': apiKey,
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

  // Stocker le visuel
  let visuel_b64 = null, visuel_type = null;
  if (file_base64 && file_type) {
    if (file_type.startsWith('image/')) {
      visuel_b64 = file_base64; visuel_type = file_type;
    } else if (file_type === 'application/pdf') {
      const buf = Buffer.from(file_base64, 'base64');
      visuel_b64 = await pdfFirstPage(buf); visuel_type = visuel_b64 ? 'image/png' : null;
    }
  }

  const inserted = db.prepare(
    'INSERT INTO analyses (user_id, mail_content, consignes, result_json, source, visuel_b64, visuel_type) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(req.user.id, mail_content.slice(0, 5000), consignes, JSON.stringify(result), 'manual', visuel_b64, visuel_type);

  const analyse = db.prepare('SELECT * FROM analyses WHERE id = ?').get(inserted.lastInsertRowid);
  res.json({ ...analyse, result, lu: false });
});

module.exports = router;
