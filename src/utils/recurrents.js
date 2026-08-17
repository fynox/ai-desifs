const db = require('../config/db');
const { JETON_COSTS } = require('./plans');
const { getJetonState, consumeJetons } = require('./limits');

// Suppléments RÉCURRENTS payés en jetons, prélevés une fois par mois :
//  • stockage bonus (bonus_go)      → JETON_COSTS.storage_2go par tranche de 2 Go
//  • comptes employés en plus       → JETON_COSTS.extra_user par employé au-delà du forfait
// Si le solde est insuffisant, le supplément est RETIRÉ (et l'utilisateur prévenu) : jamais de dette.
function moisCourant() { return new Date().toISOString().slice(0, 7); }

function prelevementDu(user) {
  const tranches = Math.max(0, Math.round((user.bonus_go || 0) / 2));
  const extra = Math.max(0, user.extra_users || 0);
  return {
    tranches, extra,
    cout: tranches * JETON_COSTS.storage_2go + extra * JETON_COSTS.extra_user,
  };
}

function preleverUn(user) {
  const { tranches, extra, cout } = prelevementDu(user);
  if (cout <= 0) {
    if (user.storage_billed_month !== moisCourant()) {
      db.prepare('UPDATE users SET storage_billed_month = ? WHERE id = ?').run(moisCourant(), user.id);
    }
    return null;
  }
  if (user.storage_billed_month === moisCourant()) return null; // déjà prélevé ce mois-ci

  const st = getJetonState(user);
  if (st.total >= cout) {
    consumeJetons(user, cout, 'supplements_mensuels');
    db.prepare('UPDATE users SET storage_billed_month = ? WHERE id = ?').run(moisCourant(), user.id);
    return { ok: true, cout, tranches, extra };
  }

  // Solde insuffisant → on retire les suppléments (le stockage occupé n'est jamais effacé,
  // seul le quota revient à celui du forfait ; les comptes employés en trop sont désactivés).
  const empsExtra = extra > 0
    ? db.prepare('SELECT id, email FROM users WHERE parent_user_id = ? ORDER BY created_at DESC LIMIT ?').all(user.id, extra)
    : [];
  for (const e of empsExtra) db.prepare("UPDATE users SET subscription_status = 'inactive' WHERE id = ?").run(e.id);
  db.prepare('UPDATE users SET bonus_go = 0, extra_users = 0, storage_billed_month = ? WHERE id = ?').run(moisCourant(), user.id);

  try {
    require('./push').pushTo(user.id, '🪙 Suppléments désactivés', `Jetons insuffisants (${cout} nécessaires) : stockage bonus et comptes employés supplémentaires ont été retirés.`);
  } catch {}
  (async () => {
    try {
      const { sendMail, mailTemplate, mailReady, APP_URL } = require('./mailer');
      if (!mailReady()) return;
      await sendMail({
        to: user.email,
        subject: '🪙 Suppléments mensuels non renouvelés (jetons insuffisants)',
        html: mailTemplate({
          titre: 'Tes suppléments mensuels ont été retirés',
          corps: `Le renouvellement mensuel de tes suppléments nécessitait <b>${cout} jetons</b> et ton solde était insuffisant.<br><br>` +
            (tranches ? `• Stockage bonus (${tranches * 2} Go) retiré — <b>aucun fichier n'a été supprimé</b>, mais tu ne pourras plus en ajouter tant que tu dépasses le quota de ton forfait.<br>` : '') +
            (empsExtra.length ? `• ${empsExtra.length} compte(s) employé(s) désactivé(s) : ${empsExtra.map(e => e.email).join(', ')}.<br>` : '') +
            `<br>Recharge des jetons puis réactive-les depuis ton profil — tout se remet en place en un clic.`,
          boutonTexte: 'Recharger des jetons',
          boutonUrl: APP_URL + '/app',
        }),
      });
    } catch (e) { console.error('Mail suppléments:', e.message); }
  })();
  return { ok: false, cout, retire: true, employes: empsExtra.length };
}

// Prélèvement de tous les comptes concernés (vérification horaire)
function preleverTous() {
  try {
    const users = db.prepare(`
      SELECT * FROM users
      WHERE parent_user_id IS NULL
        AND (COALESCE(bonus_go,0) > 0 OR COALESCE(extra_users,0) > 0)
        AND COALESCE(storage_billed_month,'') != ?
    `).all(moisCourant());
    for (const u of users) {
      const r = preleverUn(u);
      if (r) console.log(`Suppléments mensuels ${u.email}: ${r.ok ? r.cout + ' jetons prélevés' : 'retirés (solde insuffisant)'}`);
    }
  } catch (e) { console.error('preleverTous error:', e.message); }
}

function scheduleRecurrents() {
  setTimeout(preleverTous, 5 * 60 * 1000);
  setInterval(preleverTous, 60 * 60 * 1000);
}

module.exports = { prelevementDu, preleverUn, preleverTous, scheduleRecurrents, moisCourant };
