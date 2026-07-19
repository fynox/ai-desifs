const express = require('express');
const db = require('../config/db');

// Routes PUBLIQUES (sans compte) : la page devis que le client final ouvre via son lien /d/:token.
// Aucune donnée sensible du compte n'est exposée — uniquement ce qui figure sur un devis papier.
const router = express.Router();

function findByToken(token) {
  if (!/^[a-f0-9]{24,64}$/.test(String(token || ''))) return null;
  return db.prepare('SELECT * FROM analyses WHERE devis_public_token = ?').get(token);
}

// Total d'une ligne : prix perso du patron s'il existe, sinon prix conseillé
const montantLigne = l => (l.perso != null ? Number(l.perso) || 0 : Number(l.total) || 0);

// GET /api/public/devis/:token — contenu du devis + état du suivi
router.get('/devis/:token', (req, res) => {
  const item = findByToken(req.params.token);
  if (!item) return res.status(404).json({ error: 'Ce lien de devis n\'existe pas ou a été désactivé.' });

  let devis = null;
  try { devis = JSON.parse(item.devis_json || 'null'); } catch {}
  if (!devis || !Array.isArray(devis.lignes)) return res.status(404).json({ error: 'Devis introuvable.' });

  const owner = db.prepare('SELECT email, devis_infos, settings FROM users WHERE id = ?').get(item.user_id);
  let infos = {}; try { infos = JSON.parse(owner.devis_infos || '{}'); } catch {}
  let settings = {}; try { settings = JSON.parse(owner.settings || '{}'); } catch {}

  // Première ouverture par le client → "Vu" + le suivi passe à Envoyé s'il ne l'était pas
  if (!item.devis_vu_at) {
    db.prepare("UPDATE analyses SET devis_vu_at = datetime('now'), devis_status = CASE WHEN devis_status IS NULL THEN 'envoye' ELSE devis_status END, devis_sent_at = COALESCE(devis_sent_at, datetime('now')) WHERE id = ?").run(item.id);
    try { require('../utils/events').emitToOwnerTeam(item.user_id, 'devis_vu', { analyse_id: item.id }); } catch {}
  }

  let titre = 'Devis';
  try { titre = JSON.parse(item.result_json || '{}').titre || titre; } catch {}

  const tvaPct = Number(settings.tva_pct);
  res.json({
    titre,
    entreprise: {
      nom: infos.em_nom || owner.email,
      adr: infos.em_adr || null, cp: infos.em_cp || null,
      tel: infos.em_tel || null, mail: infos.em_mail || owner.email,
      siret: infos.em_siret || null,
    },
    lignes: devis.lignes.map(l => ({
      designation: l.designation, details: l.details || null, quantite: l.quantite || null,
      montant: Math.round(montantLigne(l) * 100) / 100,
      option: Boolean(l.option),
      option_choisie: Boolean(l.option_choisie),
    })),
    tva_pct: isFinite(tvaPct) && tvaPct > 0 ? tvaPct : 0,
    validite_jours: Number(settings.devis_validite_jours) >= 1 ? Math.round(Number(settings.devis_validite_jours)) : 30,
    date: (item.devis_sent_at || item.created_at || '').slice(0, 10),
    statut: item.devis_status || 'envoye',
    commentaire: item.devis_client_commentaire || null,
    signe: Boolean(item.devis_signature_b64),
    // Suivi de commande (après acceptation) — états volontairement grossiers
    suivi: item.devis_status === 'accepte' ? {
      etape: item.job_status === 'termine' ? 'pose'
        : (item.job_status === 'pret_a_poser' ? 'prete'
          : (item.job_status ? 'production' : 'acceptee')),
      date_pose: item.job_date || null,
    } : null,
  });
});

// POST /api/public/devis/:token/reponse — le client accepte (avec signature) ou refuse
router.post('/devis/:token/reponse', (req, res) => {
  const item = findByToken(req.params.token);
  if (!item) return res.status(404).json({ error: 'Lien invalide.' });
  if (item.devis_status === 'accepte' || item.devis_status === 'refuse') {
    return res.status(409).json({ error: 'Une réponse a déjà été enregistrée pour ce devis. Contactez l\'entreprise pour la modifier.' });
  }

  const action = req.body.action;
  if (!['accepte', 'refuse'].includes(action)) return res.status(400).json({ error: 'Action invalide.' });
  const commentaire = String(req.body.commentaire || '').trim().slice(0, 1500) || null;

  if (action === 'accepte') {
    const sig = req.body.signature_b64;
    if (!sig || typeof sig !== 'string' || !sig.startsWith('data:image/') || sig.length > 300000) {
      return res.status(400).json({ error: 'La signature est obligatoire pour accepter le devis.' });
    }
    // Options cochées par le client → mémorisées sur les lignes du devis
    try {
      const devis = JSON.parse(item.devis_json || 'null');
      const choisies = Array.isArray(req.body.options) ? req.body.options.map(Number) : [];
      if (devis && Array.isArray(devis.lignes)) {
        devis.lignes.forEach((l, i) => { if (l.option) l.option_choisie = choisies.includes(i); });
        db.prepare('UPDATE analyses SET devis_json = ? WHERE id = ?').run(JSON.stringify(devis), item.id);
      }
    } catch {}
    db.prepare("UPDATE analyses SET devis_status='accepte', devis_signature_b64=?, devis_client_commentaire=? WHERE id=?").run(sig, commentaire, item.id);
  } else {
    db.prepare("UPDATE analyses SET devis_status='refuse', devis_client_commentaire=? WHERE id=?").run(commentaire, item.id);
  }

  try { db.prepare('INSERT INTO activity_log (analyse_id, user_id, action) VALUES (?,?,?)').run(item.id, null, action === 'accepte' ? 'Le client a accepté et signé le devis en ligne' : 'Le client a refusé le devis en ligne'); } catch {}

  // Prévenir le patron : temps réel + push + mail
  try { require('../utils/events').emitToOwnerTeam(item.user_id, 'devis_reponse', { analyse_id: item.id, action }); } catch {}
  try {
    let t = 'Devis'; try { t = JSON.parse(item.result_json || '{}').titre || t; } catch {}
    require('../utils/push').pushTo(item.user_id, action === 'accepte' ? '🎉 Devis accepté !' : '❌ Devis refusé', t);
  } catch {}
  (async () => {
    try {
      const { sendMail, mailTemplate, mailReady, APP_URL } = require('../utils/mailer');
      if (!mailReady()) return;
      const owner = db.prepare('SELECT email FROM users WHERE id = ?').get(item.user_id);
      let titre = 'Devis'; try { titre = JSON.parse(item.result_json || '{}').titre || titre; } catch {}
      await sendMail({
        to: owner.email,
        subject: action === 'accepte' ? `✅ Devis accepté : ${titre}` : `❌ Devis refusé : ${titre}`,
        html: mailTemplate({
          titre: action === 'accepte' ? 'Ton client a accepté le devis 🎉' : 'Ton client a refusé le devis',
          corps: `<b>${titre}</b>${item.client_email ? '<br>Client : ' + item.client_email : ''}` +
            (commentaire ? `<br><br>Commentaire du client :<br><i>« ${commentaire} »</i>` : '') +
            (action === 'accepte' ? '<br><br>La signature électronique est enregistrée sur le dossier. Tu peux lancer la production.' : ''),
          boutonTexte: 'Ouvrir le dossier',
          boutonUrl: APP_URL + '/app',
        }),
      });
    } catch (e) { console.error('Mail réponse devis error:', e.message); }
  })();

  res.json({ ok: true, statut: action });
});

module.exports = router;
