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

function scheduleRelances() {
  setTimeout(() => checkRelancesEssai().catch(() => {}), 3 * 60 * 1000);
  setInterval(() => checkRelancesEssai().catch(() => {}), 60 * 60 * 1000);
}

module.exports = { scheduleRelances, checkRelancesEssai };
