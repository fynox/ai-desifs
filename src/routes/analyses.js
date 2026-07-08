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

// Employé : accès en lecture aux analyses de l'employeur qui lui sont affectées.
// Exception : le SECRÉTARIAT voit toutes les analyses du compte (comme le patron) — il n'est pas dans
// le parcours de production, il intervient à la demande (retour client, devis).
function employeScope(req) {
  const me = db.prepare('SELECT id, parent_user_id, role FROM users WHERE id = ?').get(req.user.id);
  if (me && me.parent_user_id) {
    return { ownerId: me.parent_user_id, empId: me.id, role: me.role, secr: hasRoleServ(me.role, 'secretariat') };
  }
  return { ownerId: req.user.id, empId: null, role: 'owner', secr: false };
}
// Une analyse est-elle accessible (propriétaire, secrétariat, ou employé affecté dessus) ?
function canAccessAnalyse(req, item) {
  if (!item) return false;
  const sc = employeScope(req);
  if (!sc.empId) return item.user_id === req.user.id;
  if (sc.secr) return item.user_id === sc.ownerId;
  return item.user_id === sc.ownerId &&
    (item.assigned_prep_id === sc.empId || item.assigned_pose_id === sc.empId ||
     item.assigned_design_id === sc.empId || item.assigned_secr_id === sc.empId);
}
// L'employé a-t-il ce rôle (rôles cumulables : "preparateur,poseur") ?
function hasRoleServ(roleStr, role) { return String(roleStr || '').split(',').includes(role); }
// Slot d'affectation correspondant à chaque étape du flux
const STAGE_SLOT = { a_creer: 'assigned_design_id', a_preparer: 'assigned_prep_id', pret_a_poser: 'assigned_pose_id', retour_client: 'assigned_secr_id' };

router.get('/', (req, res) => {
  const sc = employeScope(req);
  // Nettoyer les analyses "en cours" zombies (webhook qui a échoué sans supprimer le pending)
  db.prepare("DELETE FROM analyses WHERE user_id = ? AND status = 'pending' AND created_at < datetime('now','-15 minutes')").run(sc.ownerId);
  // Liste SANS les images (chargées à la demande via /:id/visuel) — sinon l'historique pèse des centaines de Mo
  // Employé : uniquement les missions qui lui sont affectées
  // Secrétariat = vision globale (toutes les analyses du compte) ; autres employés = seulement leurs missions
  const filtre = (sc.empId && !sc.secr) ? 'user_id = ? AND (assigned_prep_id = ? OR assigned_pose_id = ? OR assigned_design_id = ? OR assigned_secr_id = ?)' : 'user_id = ?';
  const args = (sc.empId && !sc.secr) ? [sc.ownerId, sc.empId, sc.empId, sc.empId, sc.empId] : [sc.ownerId];
  const rows = db.prepare(`
    SELECT id, mail_content, consignes, result_json, source, lu, created_at, status, error_msg, devis_json, visuel_type,
      assigned_prep_id, assigned_pose_id, assigned_design_id, assigned_secr_id, job_date, job_lieu, job_status,
      (job_photos_json IS NOT NULL) as has_job_photos,
      (visuel_b64 IS NOT NULL) as has_visuel,
      (visuel_orig_b64 IS NOT NULL AND (visuel_hd_b64 IS NULL OR LENGTH(visuel_b64) = LENGTH(visuel_hd_b64))) as has_orig,
      (visuel_hd_b64 IS NOT NULL) as has_hd,
      visuels_json,
      (COALESCE(LENGTH(visuel_b64),0) + COALESCE(LENGTH(visuel_orig_b64),0) + COALESCE(LENGTH(visuel_hd_b64),0) + COALESCE(LENGTH(visuels_json),0)) as taille_b64
    FROM analyses WHERE ${filtre} ORDER BY created_at DESC
  `).all(...args);
  res.json(rows.map(r => {
    const isPending = r.status === 'pending';
    const isFailed = r.status === 'failed';
    let nbVisuels = 1;
    if (r.visuels_json) { try { nbVisuels = JSON.parse(r.visuels_json).length; } catch {} }
    // Pour un employé : liste des étapes du flux qui lui sont affectées (sert au tri "à faire / en attente")
    const mySlots = sc.empId
      ? Object.entries(STAGE_SLOT).filter(([, slot]) => r[slot] === sc.empId).map(([stage]) => stage)
      : undefined;
    return {
      my_stages: mySlots,
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
  const item = db.prepare('SELECT user_id, assigned_prep_id, assigned_pose_id, visuel_b64, visuel_type, visuels_json FROM analyses WHERE id = ?').get(req.params.id);
  if (!canAccessAnalyse(req, item)) return res.status(404).json({ error: 'Analyse introuvable.' });
  let visuels = null;
  if (item.visuels_json) { try { visuels = JSON.parse(item.visuels_json); } catch {} }
  res.json({ visuel_b64: item.visuel_b64 || null, visuel_type: item.visuel_type || null, visuels });
});

// Affectation d'une analyse en mission (préparateur / poseur / date / lieu) — employeur uniquement
router.patch('/:id/job', (req, res) => {
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (me.parent_user_id) return res.status(403).json({ error: 'Réservé au compte principal (employeur).' });
  const ftM = checkFeature(me, 'multi_user'); if (ftM) return res.status(403).json(ftM);
  const item = db.prepare('SELECT id FROM analyses WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Analyse introuvable.' });

  const empOk = id => {
    if (id == null || id === '' || id === 0) return null;
    const e = db.prepare('SELECT id FROM users WHERE id = ? AND parent_user_id = ?').get(Number(id), req.user.id);
    return e ? e.id : null;
  };
  const design = empOk(req.body.design_id);
  const secr = empOk(req.body.secr_id);
  const prep = empOk(req.body.prep_id);
  const pose = empOk(req.body.pose_id);
  const date = (req.body.date || '').slice(0, 30) || null;
  const lieu = (req.body.lieu || '').slice(0, 200) || null;
  const statuts = ['a_creer', 'a_preparer', 'pret_a_poser', 'retour_client', 'termine'];
  // Étape par défaut : la première du flux qui a quelqu'un d'affecté
  const defaut = design ? 'a_creer' : (prep ? 'a_preparer' : (pose ? 'pret_a_poser' : (secr ? 'retour_client' : null)));
  const status = statuts.includes(req.body.status) ? req.body.status : defaut;
  db.prepare('UPDATE analyses SET assigned_design_id=?, assigned_secr_id=?, assigned_prep_id=?, assigned_pose_id=?, job_date=?, job_lieu=?, job_status=? WHERE id=?')
    .run(design, secr, prep, pose, date, lieu, status, item.id);
  res.json({ ok: true, design_id: design, secr_id: secr, prep_id: prep, pose_id: pose, date, lieu, status });
});

// Un employé (ou l'employeur) termine SON étape et transfère la mission à l'étape suivante.
// Règle : seul celui qui TIENT l'étape courante (ou le patron) peut la faire avancer.
// body : { status: nouvelle étape, to_emp_id?: employé affecté à cette étape, photos?: fin de pose }
router.patch('/:id/job-status', (req, res) => {
  const item = db.prepare('SELECT id, user_id, assigned_prep_id, assigned_pose_id, assigned_design_id, assigned_secr_id, job_status FROM analyses WHERE id = ?').get(req.params.id);
  if (!canAccessAnalyse(req, item)) return res.status(404).json({ error: 'Analyse introuvable.' });
  const statuts = ['a_creer', 'a_preparer', 'pret_a_poser', 'retour_client', 'termine'];
  const status = req.body.status;
  if (!statuts.includes(status)) return res.status(400).json({ error: 'Statut invalide.' });

  const sc = employeScope(req);
  if (sc.empId) {
    const curSlot = STAGE_SLOT[item.job_status || 'a_preparer'];
    if (!curSlot || item[curSlot] !== sc.empId) {
      return res.status(403).json({ error: 'Cette étape n\'est pas la tienne — seul l\'employé en charge de l\'étape en cours peut la terminer.' });
    }
  }

  // Transfert : la mission passe à l'étape suivante. Si le patron a attitré quelqu'un sur cette étape,
  // SEUL cet employé peut la recevoir (un employé ne peut pas re-router vers quelqu'un d'autre).
  if (status !== 'termine' && req.body.to_emp_id) {
    const target = db.prepare('SELECT id, role FROM users WHERE id = ? AND parent_user_id = ?').get(Number(req.body.to_emp_id), sc.ownerId);
    if (!target) return res.status(400).json({ error: 'Destinataire introuvable dans l\'équipe.' });
    const slot = STAGE_SLOT[status];
    if (slot) {
      if (sc.empId && item[slot] && item[slot] !== target.id) {
        return res.status(403).json({ error: 'Le patron a déjà attitré quelqu\'un à cette étape — transfert possible uniquement vers cette personne.' });
      }
      db.prepare(`UPDATE analyses SET ${slot} = ? WHERE id = ?`).run(target.id, item.id);
    }
  }

  // Photos du résultat posé (jointes à la fin de pose) — max 6, ~2 Mo chacune
  if (Array.isArray(req.body.photos) && req.body.photos.length) {
    const photos = req.body.photos
      .filter(p => typeof p === 'string' && p.startsWith('data:image/') && p.length < 2.8e6)
      .slice(0, 6);
    if (photos.length) db.prepare('UPDATE analyses SET job_photos_json=? WHERE id=?').run(JSON.stringify(photos), item.id);
  }

  db.prepare('UPDATE analyses SET job_status=? WHERE id=?').run(status, item.id);
  res.json({ ok: true, status });
});

// Photos de fin de pose (patron + employés affectés)
router.get('/:id/job-photos', (req, res) => {
  const item = db.prepare('SELECT user_id, assigned_prep_id, assigned_pose_id, job_photos_json FROM analyses WHERE id = ?').get(req.params.id);
  if (!canAccessAnalyse(req, item)) return res.status(404).json({ error: 'Analyse introuvable.' });
  let photos = [];
  try { photos = item.job_photos_json ? JSON.parse(item.job_photos_json) : []; } catch {}
  res.json({ photos });
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
// Accessible au patron et aux employés Secrétariat affectés sur l'analyse.
router.post('/:id/relance', async (req, res) => {
  const item = db.prepare('SELECT * FROM analyses WHERE id = ?').get(req.params.id);
  if (!canAccessAnalyse(req, item)) return res.status(404).json({ error: 'Analyse introuvable.' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (user.parent_user_id && !hasRoleServ(user.role, 'secretariat')) {
    return res.status(403).json({ error: 'Le mail client est réservé au patron et au secrétariat.' });
  }
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

  // Points à aborder cochés par l'utilisateur dans la fenêtre de composition
  const points = Array.isArray(req.body?.points) ? req.body.points.filter(p => typeof p === 'string' && p.trim()).slice(0, 12) : [];
  const pointsBloc = points.length
    ? `POINTS À ABORDER (imposés par l'imprimeur — traite CHACUN naturellement dans le mail, sans liste à puces sèche) :\n${points.map(p => '- ' + p).join('\n')}\n\nN'ajoute pas d'autres demandes que celles nécessaires à ces points.`
    : `Demande uniquement les informations manquantes nécessaires pour finaliser le devis/la recommandation (dimensions, surface de pose, intérieur/extérieur, durée, quantité, fichier...).`;

  const prompt = `Tu es un imprimeur professionnel (signalétique / adhésifs). Un client a envoyé cette demande :

---
${(item.mail_content || '').slice(0, 3000)}
---

Analyse réalisée en interne :
Résumé : ${result.resume || 'N/A'}
${result.attention ? `Point d'attention : ${result.attention}` : ''}

${pointsBloc}

${req.body?.ton === 'familier'
    ? `Rédige un mail de réponse chaleureux et décontracté en français, en traitant les points à aborder ci-dessus. C'est un client de longue date : tutoiement autorisé, ton amical et direct, mais reste pro sur le fond. Sois concis (5-12 lignes max), termine par une formule sympa SANS signature nominative (l'expéditeur signera lui-même).`
    : `Rédige un mail de réponse courtois et professionnel en français, en traitant les points à aborder ci-dessus. Sois concis (5-12 lignes max), vouvoiement, termine par une formule de politesse SANS signature nominative (l'expéditeur signera lui-même).`}

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
// Accessible au patron et aux employés Secrétariat affectés sur l'analyse.
router.post('/:id/devis', async (req, res) => {
  const item = db.prepare('SELECT * FROM analyses WHERE id = ?').get(req.params.id);
  if (!canAccessAnalyse(req, item)) return res.status(404).json({ error: 'Analyse introuvable.' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (user.parent_user_id && !hasRoleServ(user.role, 'secretariat')) {
    return res.status(403).json({ error: 'Le devis est réservé au patron et au secrétariat.' });
  }
  const apiKey = getSetting('ANTHROPIC_API_KEY');
  if (!apiKey) return res.status(400).json({ error: 'Clé API Anthropic non configurée.' });
  const ftD = checkFeature(user, 'devis'); if (ftD) return res.status(403).json(ftD);
  const affD = affordJetons(user, JETON_COSTS.devis); if (affD) return res.status(403).json(affD);

  let result = {};
  try { result = JSON.parse(item.result_json || '{}'); } catch {}

  // Employé secrétariat : le stock et la préférence tarifaire sont ceux du PATRON
  const compte = user.parent_user_id ? db.prepare('SELECT * FROM users WHERE id = ?').get(user.parent_user_id) : user;
  const stockDispo = db.prepare('SELECT * FROM stock WHERE user_id = ? AND dispo = 1').all(compte.id);
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
    const pref = JSON.parse(compte.devis_pref || '{}');
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
  const item = db.prepare('SELECT id, user_id, assigned_prep_id, assigned_pose_id, assigned_design_id, assigned_secr_id FROM analyses WHERE id = ?').get(req.params.id);
  if (!canAccessAnalyse(req, item)) return res.status(404).json({ error: 'Analyse introuvable.' });
  // L'apprentissage tarifaire et les infos émetteur sont TOUJOURS ceux du patron
  const compteId = employeScope(req).ownerId;
  const user = db.prepare('SELECT devis_pref FROM users WHERE id = ?').get(compteId);

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
    db.prepare('UPDATE users SET devis_pref = ? WHERE id = ?').run(JSON.stringify(pref), compteId);
  }

  if (req.body.infos && typeof req.body.infos === 'object') {
    db.prepare('UPDATE users SET devis_infos = ? WHERE id = ?').run(JSON.stringify(req.body.infos), compteId);
  }

  res.json({ ok: true });
});

// Renvoie les infos émetteur mémorisées (pré-remplissage du PDF de devis) — celles du patron
router.get('/devis-infos', (req, res) => {
  const user = db.prepare('SELECT devis_infos FROM users WHERE id = ?').get(employeScope(req).ownerId);
  let infos = {};
  try { infos = JSON.parse(user.devis_infos || '{}'); } catch {}
  res.json(infos || {});
});

// Vectorisation (bêta) : le tracé est fait côté navigateur (gratuit en calcul).
// Cet endpoint vérifie l'accès et débite les jetons au moment du téléchargement du SVG.
router.post('/:id/vectoriser', (req, res) => {
  const item = db.prepare('SELECT id, user_id, assigned_prep_id, assigned_pose_id, assigned_design_id, assigned_secr_id, visuel_b64, visuel_type FROM analyses WHERE id = ?').get(req.params.id);
  if (!canAccessAnalyse(req, item)) return res.status(404).json({ error: 'Analyse introuvable.' });
  if (!item.visuel_b64 || !(item.visuel_type || '').startsWith('image/')) {
    return res.status(400).json({ error: 'Aucun visuel image à vectoriser sur cette analyse.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (user.parent_user_id && !hasRoleServ(user.role, 'preparateur') && !hasRoleServ(user.role, 'designer')) {
    return res.status(403).json({ error: 'La vectorisation est réservée au patron, au préparateur et au designer.' });
  }
  const ftV = checkFeature(user, 'vectorisation'); if (ftV) return res.status(403).json(ftV);
  const affV = affordJetons(user, JETON_COSTS.vectorisation); if (affV) return res.status(403).json(affV);

  consumeJetons(user, JETON_COSTS.vectorisation, 'vectorisation');
  res.json({ ok: true });
});

// Upscale IA du visuel via Replicate (Real-ESRGAN x4)
// Nécessite REPLICATE_API_TOKEN dans les variables d'environnement Railway.
router.post('/:id/upscale', async (req, res) => {
  const replicateToken = getSetting('REPLICATE_API_TOKEN');
  if (!replicateToken) return res.status(503).json({ error: 'dev' }); // fonction en cours de dev tant que le compte Replicate n'est pas créé

  const item = db.prepare('SELECT * FROM analyses WHERE id = ?').get(req.params.id);
  if (!canAccessAnalyse(req, item)) return res.status(404).json({ error: 'Analyse introuvable.' });
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
  if (isStorageFull(employeScope(req).ownerId)) {
    return res.status(403).json({ error: 'storage_full' });
  }
  const upUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (upUser.parent_user_id && !hasRoleServ(upUser.role, 'preparateur') && !hasRoleServ(upUser.role, 'designer')) {
    return res.status(403).json({ error: 'L\'amélioration HD est réservée au patron, au préparateur et au designer.' });
  }
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
  const item = db.prepare('SELECT user_id, assigned_prep_id, assigned_pose_id, assigned_design_id, assigned_secr_id, visuel_orig_b64, visuel_orig_type FROM analyses WHERE id = ?').get(req.params.id);
  if (!canAccessAnalyse(req, item)) return res.status(404).json({ error: 'Analyse introuvable.' });
  if (!item.visuel_orig_b64) return res.status(400).json({ error: 'Pas d\'image d\'origine sauvegardée.' });
  res.json({ visuel_b64: item.visuel_orig_b64, visuel_type: item.visuel_orig_type });
});

// Restaurer le visuel d'origine (avant upscale)
router.post('/:id/restore-visuel', (req, res) => {
  const item = db.prepare('SELECT * FROM analyses WHERE id = ?').get(req.params.id);
  if (!canAccessAnalyse(req, item)) return res.status(404).json({ error: 'Analyse introuvable.' });
  if (!item.visuel_orig_b64) return res.status(400).json({ error: 'Pas d\'image d\'origine sauvegardée.' });
  // La version HD reste en base : on bascule simplement l'image active (réamélioration gratuite ensuite)
  db.prepare('UPDATE analyses SET visuel_b64=?, visuel_type=? WHERE id=?')
    .run(item.visuel_orig_b64, item.visuel_orig_type, item.id);
  res.json({ visuel_b64: item.visuel_orig_b64, visuel_type: item.visuel_orig_type, has_hd: Boolean(item.visuel_hd_b64) });
});

router.post('/analyse', async (req, res) => {
  let { mail_content, consignes = '', file_base64, file_type } = req.body;
  const reanalyse_id = req.body.reanalyse_id ? Number(req.body.reanalyse_id) : null;
  const assemblage_force = (req.body.assemblage_force === 'assemble' || req.body.assemblage_force === 'separe') ? req.body.assemblage_force : null;
  // Infos complémentaires obtenues au retour du client (ajoutées par la secrétaire ou le patron)
  const infos_ajout = typeof req.body.infos_ajout === 'string' ? req.body.infos_ajout.trim().slice(0, 2000) : '';
  // Relance d'une analyse existante : on repart de SON mail et de SES visuels stockés.
  // Accessible au patron et au secrétariat (qui intègre les retours client).
  let reItem = null;
  if (reanalyse_id) {
    reItem = db.prepare('SELECT * FROM analyses WHERE id = ?').get(reanalyse_id);
    if (!canAccessAnalyse(req, reItem)) return res.status(404).json({ error: 'Analyse introuvable.' });
    const me = db.prepare('SELECT parent_user_id, role FROM users WHERE id = ?').get(req.user.id);
    if (me.parent_user_id && !hasRoleServ(me.role, 'secretariat')) {
      return res.status(403).json({ error: 'La relance d\'analyse est réservée au patron et au secrétariat.' });
    }
    mail_content = reItem.mail_content || mail_content;
    if (infos_ajout) {
      mail_content = `${mail_content}\n\n[INFOS COMPLÉMENTAIRES — retour du client] :\n${infos_ajout}`;
    }
  }
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

  // Employé (secrétariat) : le stock utilisé pour l'analyse est celui du PATRON
  const stockDispo = db.prepare('SELECT * FROM stock WHERE user_id = ? AND dispo = 1').all(employeScope(req).ownerId);
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

MULTI-FICHIERS (plusieurs fichiers joints) : détermine si les fichiers forment UN SEUL grand visuel à ASSEMBLER côte à côte (raccord/juxtaposition — indices : même hauteur, mention 'panoramique/fresque/mur continu', fichiers nommés 'partie 1/2/3' ou 'gauche/centre/droite', bords qui se raccordent) OU s'ils sont des visuels SÉPARÉS et indépendants (indices : tailles différentes, sujets différents, 'plusieurs panneaux/affiches'). Renseigne le champ "assemblage" : "assemble" (un seul visuel à coller côte à côte), "separe" (impressions indépendantes), ou "inconnu". IMPORTANT : NE SUPPOSE JAMAIS l'assemblage par défaut. Si le mail ne le dit pas explicitement, OU si les fichiers ont des tailles différentes, mets "inconnu" et n'affirme PAS dans le résumé que ce sont des lés d'un même visuel. Dans ce cas ajoute dans "attention" : 'À confirmer avec le client : les fichiers sont-ils à assembler côte à côte (un seul visuel) ou à imprimer séparément ?'. Si assemblage vaut "separe" ou "inconnu", NE cumule PAS les largeurs et NE parle PAS de "lé 1/2/3" d'un visuel unique.

SÉPARE BIEN les deux listes d'étapes : "preparation" = étapes d'ATELIER avant la pose (fichier, vectorisation, impression, découpe, échenillage, tape de transfert...) destinées au préparateur. "pose" = conseils d'APPLICATION SUR SITE destinés au poseur UNIQUEMENT (nettoyage/préparation de la surface, pose humide ou à sec, température minimale, marouflage, sens de pose, raccords, si l'adhésif est repositionnable (coller-décoller possible) ou à pose définitive en 1 fois, retrait du transfert...). Ne mets JAMAIS d'étape d'atelier dans "pose".

Réponds UNIQUEMENT en JSON valide :
{"titre":"3-4 mots max ex: Logo vitrine extérieur","resume":"...","adhesifs":[{"nom":"nom exact du stock","raison":"...","priorite":"principal ou alternatif"}],"specs":{"finition":"...","duree":"...","pose":"...","retrait":"..."},"preparation":["..."],"pose":["..."],"attention":"... ou null","montage":{"largeur_cm":300,"hauteur_cm":120,"laize_cm":137,"nb_les":3,"sens_les":"vertical ou horizontal","debord_mm":0,"quantite":1,"assemblage":"assemble|separe|inconnu"}}`;

  // Consigne impérative d'assemblage lors d'une relance (le choix confirmé prime sur la déduction)
  const forceLine = assemblage_force
    ? `\n\nCONSIGNE IMPÉRATIVE DE L'IMPRIMEUR (confirmée avec le client) : les fichiers joints sont ${assemblage_force === 'assemble'
        ? 'À ASSEMBLER CÔTE À CÔTE pour former UN SEUL grand visuel continu (raccord). Traite-les comme les parties d\'un même visuel : mets "assemblage":"assemble", et tu peux cumuler les largeurs et parler de lés d\'un visuel unique.'
        : 'des VISUELS SÉPARÉS ET INDÉPENDANTS à imprimer distinctement. Ne les assemble PAS : mets "assemblage":"separe", ne cumule pas les largeurs.'}`
    : '';
  const finalSystem = systemPrompt + forceLine;

  const { shrinkForApi } = require('../utils/image');
  const userContent = [{ type: 'text', text: `Mail client :\n${mail_content}${consignes ? `\n\nConsignes : ${consignes}` : ''}` }];
  if (reItem) {
    // Relance : on réutilise les visuels déjà stockés sur l'analyse
    let storedVis = [];
    try { storedVis = reItem.visuels_json ? JSON.parse(reItem.visuels_json) : []; } catch {}
    if (!storedVis.length && reItem.visuel_b64) storedVis = [{ b64: reItem.visuel_b64, type: reItem.visuel_type }];
    for (const v of storedVis.slice(0, 6)) {
      if (!v.b64 || !(v.type || '').startsWith('image/')) continue;
      const s = await shrinkForApi(Buffer.from(v.b64, 'base64'), v.type);
      userContent.push({ type: 'image', source: { type: 'base64', media_type: s.type, data: s.b64 } });
    }
  } else if (file_base64 && file_type && file_type.startsWith('image/')) {
    // Pour l'IA : copie réduite si > 8000 px (l'original uploadé reste stocké intact)
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
        system: finalSystem,
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

  // Relance : on met à jour l'analyse existante (on garde ses visuels), pas de nouvelle ligne.
  // Si des infos client ont été ajoutées : le mail enrichi est persisté (devis/mails futurs les verront)
  // et l'ancien devis devient obsolète → effacé.
  if (reItem) {
    if (infos_ajout) {
      db.prepare('UPDATE analyses SET mail_content = ?, devis_json = NULL WHERE id = ?').run(mail_content.slice(0, 8000), reItem.id);
    }
    db.prepare("UPDATE analyses SET result_json = ?, status = 'done', error_msg = NULL WHERE id = ?").run(JSON.stringify(result), reItem.id);
    const analyse = db.prepare('SELECT * FROM analyses WHERE id = ?').get(reItem.id);
    let visuels = [];
    try { visuels = reItem.visuels_json ? JSON.parse(reItem.visuels_json) : []; } catch {}
    return res.json({ ...analyse, result, visuels, lu: false });
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
