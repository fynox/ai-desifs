const db = require('../config/db');

// Mails automatiques de suivi d'essai : J+2 et J+7 après l'inscription, tant que le compte
// n'a pas d'abonnement actif. Comptes principaux uniquement (jamais les employés).
// Fenêtres bornées pour ne jamais relancer les vieux comptes existants au premier déploiement.
async function checkRelancesEssai() {
  // Purge de la corbeille : suppression définitive après 30 jours (indépendant du mail)
  try { db.prepare("DELETE FROM analyses WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now','-30 days')").run(); } catch {}

  const { sendMail, mailTemplate, mailReady, APP_URL } = require('./mailer');
  if (!mailReady()) return;

  const j2 = db.prepare(`
    SELECT id, email FROM users
    WHERE parent_user_id IS NULL AND subscription_status != 'active'
      AND COALESCE(trial_mail_j2, 0) = 0
      AND created_at <= datetime('now', '-2 days') AND created_at > datetime('now', '-10 days')
    LIMIT 20
  `).all();
  for (const u of j2) {
    // Marqué AVANT l'envoi : en cas d'erreur on préfère un mail perdu à un doublon
    db.prepare('UPDATE users SET trial_mail_j2 = 1 WHERE id = ?').run(u.id);
    try {
      await sendMail({
        to: u.email,
        subject: 'Ton essai AI-dhésif t\'attend — 1 mail client suffit',
        html: mailTemplate({
          titre: 'Tu as testé l\'analyse automatique ?',
          corps: 'Colle un mail client dans l\'app (ou joins son fichier) : l\'IA choisit le bon adhésif dans <b>ton</b> stock, calcule le plan de lés et prépare le devis — en moins d\'une minute.<br><br>Tes analyses d\'essai gratuites t\'attendent, sans carte bancaire. Le plus simple pour commencer : ajoute 2-3 références de ton stock, puis lance ta première analyse.',
          boutonTexte: 'Lancer une analyse',
          boutonUrl: APP_URL + '/app',
        }),
      });
      console.log('Relance essai J+2 envoyée à', u.email);
    } catch (e) { console.error('Relance J+2 error:', e.message); }
  }

  const j7 = db.prepare(`
    SELECT id, email FROM users
    WHERE parent_user_id IS NULL AND subscription_status != 'active'
      AND COALESCE(trial_mail_j7, 0) = 0 AND COALESCE(trial_mail_j2, 0) = 1
      AND created_at <= datetime('now', '-7 days') AND created_at > datetime('now', '-21 days')
    LIMIT 20
  `).all();
  for (const u of j7) {
    db.prepare('UPDATE users SET trial_mail_j7 = 1 WHERE id = ?').run(u.id);
    try {
      await sendMail({
        to: u.email,
        subject: 'AI-dhésif — ce que tu gagnes avec un forfait',
        html: mailTemplate({
          titre: 'Passe à la vitesse supérieure',
          corps: 'Avec un forfait AI-dhésif :<br>• des <b>analyses chaque mois</b> + des jetons pour les devis, mails clients et améliorations HD<br>• ton <b>adresse mail dédiée</b> : tes clients (ou toi) transférez les demandes, les analyses arrivent toutes seules<br>• le <b>tableau de bord</b> : devis à relancer, planning des poses, fiches clients<br>• et pour les équipes : missions préparateur / poseur / secrétariat.<br><br>Les forfaits démarrent à petit prix, résiliables à tout moment.',
          boutonTexte: 'Voir les forfaits',
          boutonUrl: APP_URL + '/pricing',
        }),
      });
      console.log('Relance essai J+7 envoyée à', u.email);
    } catch (e) { console.error('Relance J+7 error:', e.message); }
  }
}

// Rappel de pose la veille (client + poseur) et demande d'avis Google après pose terminée
async function checkRappelsEtAvis() {
  const { sendMail, mailTemplate, mailReady } = require('./mailer');
  if (!mailReady()) return;
  const nomDe = (u) => { try { return (JSON.parse(u.devis_infos || '{}').em_nom || '').trim() || null; } catch { return null; } };

  // 1) Poses prévues DEMAIN → mail de rappel au client + push/mail au poseur
  const demain = db.prepare(`
    SELECT a.id, a.user_id, a.result_json, a.job_date, a.job_lieu, a.client_email, a.assigned_pose_id,
           u.email AS owner_email, u.devis_infos
    FROM analyses a JOIN users u ON u.id = a.user_id
    WHERE a.rappel_pose_sent = 0 AND a.deleted_at IS NULL
      AND a.job_date LIKE '____-__-__%' AND substr(a.job_date, 1, 10) = date('now', '+1 day')
      AND (a.job_status IS NULL OR a.job_status != 'termine')
    LIMIT 20
  `).all();
  for (const a of demain) {
    db.prepare('UPDATE analyses SET rappel_pose_sent = 1 WHERE id = ?').run(a.id);
    let titre = 'votre projet'; try { titre = JSON.parse(a.result_json || '{}').titre || titre; } catch {}
    const entreprise = nomDe(a) || a.owner_email;
    if (a.client_email) {
      try {
        await sendMail({
          to: a.client_email, fromName: entreprise, replyTo: a.owner_email,
          subject: `Rappel — intervention prévue demain (${titre})`,
          html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.65;color:#1a1a1a;">Bonjour,<br><br>Petit rappel : notre intervention pour « ${titre} » est prévue <b>demain</b>${a.job_lieu ? ' à l\'adresse : <b>' + a.job_lieu + '</b>' : ''}.<br><br>Merci de nous laisser l'accès à la zone de pose. En cas d'empêchement, répondez simplement à ce mail.<br><br>À demain,<br>${entreprise}</div>`,
        });
      } catch (e) { console.error('Rappel client error:', e.message); }
    }
    if (a.assigned_pose_id) {
      try { require('./push').pushTo(a.assigned_pose_id, '🚐 Pose demain', `${titre}${a.job_lieu ? ' — ' + a.job_lieu : ''}`); } catch {}
    }
  }

  // 2) Pose terminée depuis 4 h+ → demande d'avis Google (si le lien est configuré dans les réglages)
  const finis = db.prepare(`
    SELECT a.id, a.result_json, a.client_email, u.email AS owner_email, u.devis_infos, u.settings
    FROM analyses a JOIN users u ON u.id = a.user_id
    WHERE a.avis_sent = 0 AND a.deleted_at IS NULL AND a.client_email IS NOT NULL
      AND a.job_done_at IS NOT NULL AND a.job_done_at < datetime('now', '-4 hours')
    LIMIT 20
  `).all();
  for (const a of finis) {
    db.prepare('UPDATE analyses SET avis_sent = 1 WHERE id = ?').run(a.id);
    let url = null; try { url = (JSON.parse(a.settings || '{}').google_review_url || '').trim() || null; } catch {}
    if (!url || !/^https?:\/\//.test(url)) continue; // pas de lien configuré → on marque juste comme traité
    let titre = 'votre projet'; try { titre = JSON.parse(a.result_json || '{}').titre || titre; } catch {}
    const entreprise = nomDe(a) || a.owner_email;
    try {
      await sendMail({
        to: a.client_email, fromName: entreprise, replyTo: a.owner_email,
        subject: `Merci pour votre confiance — un petit avis ? ⭐`,
        html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.65;color:#1a1a1a;">Bonjour,<br><br>La pose de « ${titre} » est terminée — merci pour votre confiance !<br><br>Si le résultat vous plaît, un avis Google nous aiderait énormément (30 secondes) :<br><a href="${url}" style="display:inline-block;margin-top:10px;background:#79b52c;color:#fff;font-weight:700;padding:11px 22px;border-radius:9px;text-decoration:none;">⭐ Laisser un avis</a><br><br>Bien cordialement,<br>${entreprise}</div>`,
      });
      console.log('Demande d\'avis envoyée pour analyse', a.id);
    } catch (e) { console.error('Avis error:', e.message); }
  }
}

function scheduleRelances() {
  setTimeout(() => checkRelancesEssai().catch(() => {}), 3 * 60 * 1000);
  setInterval(() => checkRelancesEssai().catch(() => {}), 60 * 60 * 1000);
  setTimeout(() => checkRappelsEtAvis().catch(() => {}), 4 * 60 * 1000);
  setInterval(() => checkRappelsEtAvis().catch(() => {}), 60 * 60 * 1000);
}

module.exports = { scheduleRelances, checkRelancesEssai };
