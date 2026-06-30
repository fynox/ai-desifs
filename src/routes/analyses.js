const express = require('express');
const fetch = require('node-fetch');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { logUsage, logCost } = require('../utils/usage');
const { getSetting } = require('../utils/appSettings');
const { getStorage, isStorageFull } = require('../utils/storage');
const { checkFeature, affordJetons, consumeJetons, affordAnalyse, analyseOverQuota, getJetonState } = require('../utils/limits');
const { JETON_COSTS } = require('../utils/plans');
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
  // Nettoyer les analyses "en cours" zombies (webhook qui a échoué sans supprimer le pending)
  db.prepare("DELETE FROM analyses WHERE user_id = ? AND status = 'pending' AND created_at < datetime('now','-15 minutes')").run(req.user.id);
  // Liste SANS les images (chargées à la demande via /:id/visuel) — sinon l'historique pèse des centaines de Mo
  const rows = db.prepare(`
    SELECT id, mail_content, consignes, result_json, source, lu, created_at, status, error_msg, devis_json, visuel_type,
      (visuel_b64 IS NOT NULL) as has_visuel,
      (visuel_orig_b64 IS NOT NULL AND (visuel_hd_b64 IS NULL OR LENGTH(visuel_b64) = LENGTH(visuel_hd_b64))) as has_orig,
      (visuel_hd_b64 IS NOT NULL) as has_hd,
      visuels_json,
      (COALESCE(LENGTH(visuel_b64),0) + COALESCE(LENGTH(visuel_orig_b64),0) + COALESCE(LENGTH(visuel_hd_b64),0) + COALESCE(LENGTH(visuels_json),0)) as taille_b64
    FROM analyses WHERE user_id = ? ORDER BY created_at DESC
  `).all(req.user.id);
  res.json(rows.map(r => {
    const isPending = r.status === 'pending';
    const isFailed = r.status === 'failed';
    let nbVisuels = 1;
    if (r.visuels_json) { try { nbVisuels = JSON.parse(r.visuels_json).length; } catch {} }
    return {
      ...r,
      visuels_json: undefined,
      result: (isPending || isFailed) ? null : JSON.parse(r.result_json),
      lu: Boolean(r.lu),
      visuel_b64: null, // chargé à la demande
      has_visuel: Boolean(r.has_visuel),
      nb_visuels: nbVisuels,
      devis: r.devis_json ? JSON.parse(r.devis_json) : null,
      has_orig: Boolean(r.has_orig),
      has_hd: Boolean(r.has_hd),
      taille_octets: Math.round(r.taille_b64 * 0.75),
      _pending: isPending,
      _failed: isFailed,
    };
  }));
});

// Visuel(s) d'une analyse (chargé à la demande pour ne pas alourdir l'historique)
router.get('/:id/visuel', (req, res) => {
  const item = db.prepare('SELECT visuel_b64, visuel_type, visuels_json FROM analyses WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Analyse introuvable.' });
  let visuels = null;
  if (item.visuels_json) { try { visuels = JSON.parse(item.visuels_json); } catch {} }
  res.json({ visuel_b64: item.visuel_b64 || null, visuel_type: item.visuel_type || null, visuels });
});

// Espace de stockage occupé / quota du compte
router.get('/storage', (req, res) => {
  res.json(getStorage(req.user.id));
});

// État des jetons du compte
router.get('/jetons', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json(getJetonState(user));
});

// Acheter +2 Go de stockage avec des jetons
router.post('/buy-storage', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (user.subscription_status !== 'active') return res.status(403).json({ error: 'Abonnement requis pour acheter du stockage.' });
  const cost = JETON_COSTS.storage_2go;
  const aff = affordJetons(user, cost);
  if (aff) return res.status(403).json(aff);
  consumeJetons(user, cost, 'storage_2go');
  db.prepare('UPDATE users SET bonus_go = COALESCE(bonus_go,0) + 2 WHERE id = ?').run(user.id);
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.json({ ok: true, storage: getStorage(user.id), jetons: getJetonState(fresh) });
});

// Libérer de l'espace : mode = all | half_old | heaviest | hd_only
router.post('/clear', (req, res) => {
  const { mode } = req.body || {};
  let deleted = 0;
  if (mode === 'all') {
    deleted = db.prepare('DELETE FROM analyses WHERE user_id = ?').run(req.user.id).changes;
  } else if (mode === 'half_old') {
    const total = db.prepare('SELECT COUNT(*) as c FROM analyses WHERE user_id = ?').get(req.user.id).c;
    const n = Math.floor(total / 2);
    if (n > 0) {
      deleted = db.prepare(`DELETE FROM analyses WHERE id IN (
        SELECT id FROM analyses WHERE user_id = ? ORDER BY created_at ASC LIMIT ?
      )`).run(req.user.id, n).changes;
    }
  } else if (mode === 'heaviest') {
    const total = db.prepare('SELECT COUNT(*) as c FROM analyses WHERE user_id = ?').get(req.user.id).c;
    const n = Math.max(1, Math.ceil(total / 4)); // le quart le plus lourd
    deleted = db.prepare(`DELETE FROM analyses WHERE id IN (
      SELECT id FROM analyses WHERE user_id = ?
      ORDER BY (COALESCE(LENGTH(visuel_b64),0) + COALESCE(LENGTH(visuel_orig_b64),0) + COALESCE(LENGTH(visuel_hd_b64),0)) DESC
      LIMIT ?
    )`).run(req.user.id, n).changes;
  } else if (mode === 'hd_only') {
    // Supprime les versions originale + HD de réserve, garde les analyses et leur image active
    deleted = db.prepare(`UPDATE analyses SET visuel_orig_b64=NULL, visuel_orig_type=NULL, visuel_hd_b64=NULL, visuel_hd_type=NULL
      WHERE user_id = ? AND (visuel_orig_b64 IS NOT NULL OR visuel_hd_b64 IS NOT NULL)`).run(req.user.id).changes;
  } else {
    return res.status(400).json({ error: 'Mode de nettoyage invalide.' });
  }
  res.json({ ok: true, deleted, storage: getStorage(req.user.id) });
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
  const apiKey = getSetting('ANTHROPIC_API_KEY');
  if (!apiKey) return res.status(400).json({ error: 'Clé API Anthropic non configurée.' });
  const ftR = checkFeature(user, 'relance'); if (ftR) return res.status(403).json(ftR);
  const affR = affordJetons(user, JETON_COSTS.relance); if (affR) return res.status(403).json(affR);

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
  logUsage(req.user.id, 'relance', 'claude-sonnet-4-6', data.usage);

  const raw = data.content?.map(i => i.text || '').join('') || '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return res.status(502).json({ error: 'Réponse IA invalide — réessayez.' });

  let mail;
  try { mail = JSON.parse(jsonMatch[0]); } catch { return res.status(502).json({ error: 'JSON invalide dans la réponse IA.' }); }
  if (!mail.objet || !mail.corps) return res.status(502).json({ error: 'Réponse incomplète — réessayez.' });

  consumeJetons(user, JETON_COSTS.relance, 'relance');
  res.json({ to: clientEmail, objet: mail.objet, corps: mail.corps });
});

// Génère un devis automatique approximatif basé sur le stock (prix m², encre)
router.post('/:id/devis', async (req, res) => {
  const item = db.prepare('SELECT * FROM analyses WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Analyse introuvable.' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const apiKey = getSetting('ANTHROPIC_API_KEY');
  if (!apiKey) return res.status(400).json({ error: 'Clé API Anthropic non configurée.' });
  const ftD = checkFeature(user, 'devis'); if (ftD) return res.status(403).json(ftD);
  const affD = affordJetons(user, JETON_COSTS.devis); if (affD) return res.status(403).json(affD);

  let result = {};
  try { result = JSON.parse(item.result_json || '{}'); } catch {}

  const stockDispo = db.prepare('SELECT * FROM stock WHERE user_id = ? AND dispo = 1').all(req.user.id);
  const encres = stockDispo.filter(i => i.cat === 'encre');
  const adhesifs = stockDispo.filter(i => i.cat !== 'encre');

  // Adhésifs recommandés en priorité, sinon tout le stock avec prix
  const nomsReco = (result.adhesifs || []).map(a => a.nom);
  const normCm = v => { const n = Number(v); return n > 400 ? Math.round(n / 10) : n; };
  const stockLines = adhesifs.map(i => {
    const largeurs = [...JSON.parse(i.largeurs || '[]'), ...JSON.parse(i.variantes || '[]').map(v => v.largeur)].map(normCm).filter(Boolean);
    return `• ${i.nom} (${i.cat})${nomsReco.includes(i.nom) ? ' [RECOMMANDÉ PAR L\'ANALYSE]' : ''} | prix: ${i.prix_m2 != null ? i.prix_m2 + ' €/m²' : 'NON RENSEIGNÉ'}${largeurs.length ? ' | laizes: ' + [...new Set(largeurs)].join(', ') + ' cm' : ''}`;
  }).join('\n');
  const encreLines = encres.length
    ? encres.map(i => `• ${i.nom} | prix: ${i.prix_m2 != null ? i.prix_m2 + ' €/m² imprimé' : 'NON RENSEIGNÉ'}${i.note ? ' | ' + i.note : ''}`).join('\n')
    : 'Aucune encre renseignée — utilise une estimation standard de 0,80 €/m² imprimé et signale-le dans les hypothèses.';

  // Apprentissage des prix : si l'utilisateur a déjà ajusté ses prix sur de précédents devis,
  // on pousse l'IA à se rapprocher de SA tarification plutôt que du coût brut calculé.
  let devisPrefHint = '';
  try {
    const pref = JSON.parse(user.devis_pref || '{}');
    if (pref && pref.ratio && pref.n >= 1) {
      const pct = Math.round(pref.ratio * 100);
      devisPrefHint = `PRÉFÉRENCE TARIFAIRE DE L'UTILISATEUR (apprise sur ${pref.n} devis précédents) :
- Sur ses devis passés, l'utilisateur facture en moyenne ≈ ${pct}% du coût que tu calcules (ratio ${pref.ratio.toFixed(2)}x).
- Ajuste les prix_unitaire et total pour TE RAPPROCHER de cette tarification réelle, tout en restant cohérent avec les coûts. C'est SA façon de facturer, respecte-la.

`;
    }
  } catch {}

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

${devisPrefHint}RÈGLES :
- Utilise en priorité les adhésifs recommandés par l'analyse et leurs prix réels du stock.
- Calcule la surface à partir des dimensions du mail. Si dimensions absentes, fais une hypothèse raisonnable et signale-la.
- Tiens compte des laizes (largeurs de rouleau) pour estimer le nombre de lés.
- IMPORTANT : la matière se compte en laize PLEINE du rouleau, pas en surface du visuel. Les chutes (bords du lé non couverts par le visuel, marges d'impression, débord de pose) sont coupées et JETÉES, non réutilisables. Surface matière = nb de lés × laize complète du rouleau × longueur du lé (longueur du visuel + ~4 cm de débord). Détaille cette perte dans la ligne du devis.
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
        max_tokens: 3000,
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

  logUsage(req.user.id, 'devis', 'claude-sonnet-4-6', data.usage);

  let devis;
  try { devis = JSON.parse(jsonMatch[0]); } catch { return res.status(502).json({ error: 'JSON invalide dans la réponse IA.' }); }
  if (!devis.lignes) return res.status(502).json({ error: 'Réponse incomplète — réessayez.' });

  // Sauvegarder le devis pour pouvoir le rouvrir sans le regénérer
  db.prepare('UPDATE analyses SET devis_json = ? WHERE id = ?').run(JSON.stringify(devis), item.id);

  consumeJetons(user, JETON_COSTS.devis, 'devis');
  res.json(devis);
});

// Feedback sur le devis : l'utilisateur valide ses propres prix.
// On apprend le ratio (prix perso / prix proposé) pour rapprocher les prochains devis de SA tarification.
// On mémorise aussi ses infos émetteur pour le PDF. Ne consomme aucun jeton.
router.post('/:id/devis/feedback', (req, res) => {
  const item = db.prepare('SELECT id FROM analyses WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Analyse introuvable.' });
  const user = db.prepare('SELECT devis_pref FROM users WHERE id = ?').get(req.user.id);

  const lignes = Array.isArray(req.body.lignes) ? req.body.lignes : [];
  const ratios = [];
  for (const l of lignes) {
    const propose = Number(l.propose);
    const perso = Number(l.perso);
    if (propose > 0 && perso > 0) ratios.push(perso / propose);
  }

  if (ratios.length) {
    const moy = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    let pref = {};
    try { pref = JSON.parse(user.devis_pref || '{}'); } catch {}
    const n = (pref.n || 0);
    // moyenne mobile pondérée : on lisse pour ne pas réagir trop fort à un seul devis
    const newRatio = n > 0 ? (pref.ratio * n + moy) / (n + 1) : moy;
    pref = { ratio: Math.max(0.2, Math.min(10, newRatio)), n: n + 1 };
    db.prepare('UPDATE users SET devis_pref = ? WHERE id = ?').run(JSON.stringify(pref), req.user.id);
  }

  if (req.body.infos && typeof req.body.infos === 'object') {
    db.prepare('UPDATE users SET devis_infos = ? WHERE id = ?').run(JSON.stringify(req.body.infos), req.user.id);
  }

  res.json({ ok: true });
});

// Renvoie les infos émetteur mémorisées (pré-remplissage du PDF de devis)
router.get('/devis-infos', (req, res) => {
  const user = db.prepare('SELECT devis_infos FROM users WHERE id = ?').get(req.user.id);
  let infos = {};
  try { infos = JSON.parse(user.devis_infos || '{}'); } catch {}
  res.json(infos || {});
});

// Upscale IA du visuel via Replicate (Real-ESRGAN x4)
// Nécessite REPLICATE_API_TOKEN dans les variables d'environnement Railway.
router.post('/:id/upscale', async (req, res) => {
  const replicateToken = getSetting('REPLICATE_API_TOKEN');
  if (!replicateToken) return res.status(503).json({ error: 'dev' }); // fonction en cours de dev tant que le compte Replicate n'est pas créé

  const item = db.prepare('SELECT * FROM analyses WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Analyse introuvable.' });
  if (!item.visuel_b64 || !item.visuel_type || !item.visuel_type.startsWith('image/')) {
    return res.status(400).json({ error: 'Aucun visuel image sur cette analyse.' });
  }
  // Version HD déjà générée précédemment → on la réactive sans repayer Replicate
  if (item.visuel_hd_b64) {
    db.prepare('UPDATE analyses SET visuel_b64=?, visuel_type=? WHERE id=?').run(item.visuel_hd_b64, item.visuel_hd_type, item.id);
    return res.json({ visuel_b64: item.visuel_hd_b64, visuel_type: item.visuel_hd_type, has_orig: true, cached: true });
  }
  // Image déjà très lourde (probablement déjà upscalée) → inutile et trop gros pour le modèle
  if (item.visuel_b64.length > 8_000_000) {
    return res.status(400).json({ error: 'Le visuel est déjà en haute résolution — pas besoin de l\'améliorer à nouveau.' });
  }
  if (isStorageFull(req.user.id)) {
    return res.status(403).json({ error: 'storage_full' });
  }
  const upUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const ftU = checkFeature(upUser, 'upscale'); if (ftU) return res.status(403).json(ftU);
  // Réactivation d'une HD déjà générée = gratuit (pas de nouveau coût)
  const alreadyHd = Boolean(item.visuel_hd_b64);
  if (!alreadyHd) { const affU = affordJetons(upUser, JETON_COSTS.upscale); if (affU) return res.status(403).json(affU); }

  try {
    // Real-ESRGAN sur Replicate (nightmareai/real-esrgan)
    const createRes = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + replicateToken },
      body: JSON.stringify({
        version: 'f121d640bd286e1fdc67f9799164c1d5be36ff74576ee11c803ae5b665dd46aa',
        input: {
          image: `data:${item.visuel_type};base64,${item.visuel_b64}`,
          scale: 4,
          face_enhance: false,
        },
      }),
    });
    const pred = await createRes.json();
    if (!createRes.ok) return res.status(502).json({ error: pred?.detail || 'Erreur Replicate.' });

    // Polling jusqu'à la fin (max ~3 min)
    let status = pred.status, outputUrl = null, getUrl = pred.urls?.get, lastError = null;
    for (let i = 0; i < 90 && getUrl; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const poll = await fetch(getUrl, { headers: { 'Authorization': 'Bearer ' + replicateToken } });
      const p = await poll.json();
      status = p.status;
      if (status === 'succeeded') { outputUrl = Array.isArray(p.output) ? p.output[0] : p.output; break; }
      if (status === 'failed' || status === 'canceled') { lastError = p.error || null; break; }
    }
    if (!outputUrl) {
      console.error('Upscale Replicate non abouti:', status, lastError);
      return res.status(502).json({ error: lastError ? `Replicate : ${String(lastError).slice(0, 200)}` : 'L\'amélioration a échoué ou pris trop de temps — réessayez.' });
    }

    // Télécharger le résultat et remplacer le visuel
    const imgRes = await fetch(outputUrl);
    if (!imgRes.ok) return res.status(502).json({ error: 'Impossible de récupérer l\'image améliorée.' });
    let buf = Buffer.from(await imgRes.arrayBuffer());
    let newType = imgRes.headers.get('content-type') || 'image/png';
    // Recompresser en JPEG : la HD passe de ~30 Mo (PNG) à ~3 Mo sans différence visible à l'impression
    try {
      const sharp = require('sharp');
      buf = await sharp(buf).jpeg({ quality: 85 }).toBuffer();
      newType = 'image/jpeg';
    } catch (e) { console.error('sharp indisponible, HD stockée sans recompression:', e.message); }
    const newB64 = buf.toString('base64');

    // Conserver l'image d'origine (une seule fois) et la version HD pour basculer sans repayer
    if (!item.visuel_orig_b64) {
      db.prepare('UPDATE analyses SET visuel_orig_b64=?, visuel_orig_type=? WHERE id=?').run(item.visuel_b64, item.visuel_type, item.id);
    }
    db.prepare('UPDATE analyses SET visuel_b64=?, visuel_type=?, visuel_hd_b64=?, visuel_hd_type=? WHERE id=?').run(newB64, newType, newB64, newType, item.id);
    logCost(req.user.id, 'upscale', 'real-esrgan', parseFloat(process.env.REPLICATE_COST_PER_UPSCALE || '0.01'));
    consumeJetons(upUser, JETON_COSTS.upscale, 'upscale');
    res.json({ visuel_b64: newB64, visuel_type: newType, has_orig: true });
  } catch (e) {
    console.error('Upscale error:', e);
    res.status(502).json({ error: 'Erreur pendant l\'amélioration du visuel.' });
  }
});

// Récupérer le visuel d'origine (pour la comparaison avant/après)
router.get('/:id/visuel-orig', (req, res) => {
  const item = db.prepare('SELECT visuel_orig_b64, visuel_orig_type FROM analyses WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Analyse introuvable.' });
  if (!item.visuel_orig_b64) return res.status(400).json({ error: 'Pas d\'image d\'origine sauvegardée.' });
  res.json({ visuel_b64: item.visuel_orig_b64, visuel_type: item.visuel_orig_type });
});

// Restaurer le visuel d'origine (avant upscale)
router.post('/:id/restore-visuel', (req, res) => {
  const item = db.prepare('SELECT * FROM analyses WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Analyse introuvable.' });
  if (!item.visuel_orig_b64) return res.status(400).json({ error: 'Pas d\'image d\'origine sauvegardée.' });
  // La version HD reste en base : on bascule simplement l'image active (réamélioration gratuite ensuite)
  db.prepare('UPDATE analyses SET visuel_b64=?, visuel_type=? WHERE id=?')
    .run(item.visuel_orig_b64, item.visuel_orig_type, item.id);
  res.json({ visuel_b64: item.visuel_orig_b64, visuel_type: item.visuel_orig_type, has_hd: Boolean(item.visuel_hd_b64) });
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
  const apiKey = getSetting('ANTHROPIC_API_KEY');
  if (!apiKey) return res.status(400).json({ error: 'Clé API Anthropic non configurée.' });
  if (file_base64 && isStorageFull(req.user.id)) {
    return res.status(403).json({ error: 'storage_full' });
  }
  // Analyse gratuite sous le quota du forfait, sinon coûte des jetons (vérifié ici, débité après succès)
  const affA = (user.subscription_status === 'active') ? affordAnalyse(user) : null;
  if (affA) return res.status(403).json(affA);
  const analyseOver = (user.subscription_status === 'active') && analyseOverQuota(user);

  const stockDispo = db.prepare('SELECT * FROM stock WHERE user_id = ? AND dispo = 1').all(req.user.id);
  if (!stockDispo.length) return res.status(400).json({ error: 'Aucun adhésif en stock disponible.' });

  const CAT_LABELS = { imprimable:'Imprimable', plastification:'Plastification', dao:'Couleur DAO', transfert:'Papier transfert', covering:'Covering voiture', vitre:'Vitre / Solaire', panneau:'Panneau' };
  const stockDesc = Object.keys(CAT_LABELS).map(cat => {
    const items = stockDispo.filter(i => i.cat === cat);
    if (!items.length) return '';
    return `--- ${CAT_LABELS[cat]} ---\n` + items.map(i => {
      const res = JSON.parse(i.resistances || '[]');
      const app = JSON.parse(i.applications || '[]');
      // Les laizes du stock peuvent être saisies en mm (ex: 1520) → on normalise en cm
      const normCm = v => { const n = Number(v); return n > 400 ? Math.round(n / 10) : n; };
      const lar = JSON.parse(i.largeurs || '[]').map(normCm).filter(Boolean);
      const vars = JSON.parse(i.variantes || '[]');
      const varTxt = vars.length
        ? ' | variantes disponibles (UNIQUEMENT ces combinaisons couleur/laize): ' + vars.map(v => `${v.couleur || 'standard'}${v.largeur ? ' en ' + normCm(v.largeur) + ' cm' : ''}`).join(', ')
        : (lar.length ? ' | laizes: ' + lar.join(', ') + ' cm' : '');
      return `• ${i.nom} | ${i.finition} | ${i.adherence} | ${i.env} | ${i.duree}${varTxt}${res.length ? ' | ' + res.join(', ') : ''}${app.length ? ' | ' + app.join(', ') : ''}${i.note ? ' | ' + i.note : ''}`;
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

REGLE ABSOLUE D'IMPRESSION : pour TOUTE impression d'un visuel (logo, photo, fond de couleur, affiche, decor mural...), recommande UNIQUEMENT un adhesif de categorie "Imprimable" (vinyl BLANC imprimable). La couleur du visuel n'a AUCUNE importance : un fond bleu, rouge ou noir s'imprime sur du vinyl BLANC. N'utilise JAMAIS un vinyl de couleur ("Couleur DAO") pour reproduire un visuel imprime. La categorie "Couleur DAO" sert EXCLUSIVEMENT a decouper du lettrage ou des formes en vinyl uni, et UNIQUEMENT si le client demande explicitement de la decoupe/du lettrage adhesif (pas d'impression).

STOCK DISPONIBLE :
${stockDesc}

MONTAGE : largeur_cm et hauteur_cm = dimensions EXPLICITEMENT données par le client dans le mail, converties en cm. Ne devine JAMAIS une dimension a partir de l'image (tu n'en vois qu'une copie reduite) : si le client ne donne que la hauteur, mets largeur_cm a null (et inversement). Si le client dit 'echelle 1', 'taille reelle' ou 'scale 1' SANS chiffres, mets largeur_cm ET hauteur_cm a null : l'imprimeur saisira la taille reelle lui-meme. quantite = nombre d'exemplaires IDENTIQUES demandes par le client (ex: '500 stickers', 'tirage de 200' -> 500 ou 200). Mets 1 si un seul exemplaire est demande. laize_cm = la laize la plus adaptée EN CENTIMÈTRES (ex: 152 pour un rouleau de 1520 mm, jamais de valeur en mm) parmi celles de l'adhésif recommandé dans le stock (null si non renseignées). nb_les et sens_les : null si une dimension manque. Si tu reperes des reperes/traits de decoupe (petits traits noirs ou croix dans les angles du fichier), ajoute IMPERATIVEMENT une etape dans "preparation" : 'Reperes de decoupe presents dans les angles du fichier — decouper en les suivant (ne pas les rogner).'. debord_mm = marge de debord de pose autour du visuel : mets 0 si le client dit 'pas de bords tournants', 'echelle 1', 'taille reelle', ou si des reperes de decoupe sont presents (la coupe suit le fichier) ; sinon mets null (marge par defaut de l'utilisateur). Ne parle JAMAIS de nombre de les, de laize ou de raccords dans "preparation" ou "attention" : un plan de lés visuel est déjà affiché automatiquement à l'utilisateur.

Réponds UNIQUEMENT en JSON valide :
{"titre":"3-4 mots max ex: Logo vitrine extérieur","resume":"...","adhesifs":[{"nom":"nom exact du stock","raison":"...","priorite":"principal ou alternatif"}],"specs":{"finition":"...","duree":"...","pose":"...","retrait":"..."},"preparation":["..."],"attention":"... ou null","montage":{"largeur_cm":300,"hauteur_cm":120,"laize_cm":137,"nb_les":3,"sens_les":"vertical ou horizontal","debord_mm":0,"quantite":1}}`;

  const userContent = [{ type: 'text', text: `Mail client :\n${mail_content}${consignes ? `\n\nConsignes : ${consignes}` : ''}` }];
  // Pour l'IA : copie réduite si > 8000 px (l'original uploadé reste stocké intact)
  if (file_base64 && file_type && file_type.startsWith('image/')) {
    const { shrinkForApi } = require('../utils/image');
    const s = await shrinkForApi(Buffer.from(file_base64, 'base64'), file_type);
    userContent.push({ type: 'image', source: { type: 'base64', media_type: s.type, data: s.b64 } });
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
        max_tokens: 2000,
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

  logUsage(req.user.id, 'analyse', 'claude-sonnet-4-6', data.usage);

  let result;
  try { result = JSON.parse(jsonMatch[0]); } catch { return res.status(502).json({ error: 'JSON invalide dans la réponse IA.' }); }
  if (!result.adhesifs || !result.specs) return res.status(502).json({ error: 'Structure de réponse incomplète.' });

  if (analyseOver) consumeJetons(user, JETON_COSTS.analyse_extra, 'analyse_extra');
  if (user.subscription_status === 'trial') {
    db.prepare('UPDATE users SET trial_analyses_used = trial_analyses_used + 1 WHERE id = ?').run(user.id);
  }

  // Stocker le visuel ORIGINAL en pleine qualité (export fidèle)
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
