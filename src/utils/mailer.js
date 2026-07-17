const sgMail = require('@sendgrid/mail');
const { getSetting } = require('./appSettings');

const APP_URL = process.env.APP_URL || 'https://ai-dhesif.fr';

// L'envoi de mails (reset de mot de passe, notifications de mission, sauvegardes)
// nécessite une clé API SendGrid avec la permission "Mail Send" + l'authentification
// du domaine ai-dhesif.fr côté SendGrid (enregistrements DNS sur Cloudflare).
function mailReady() {
  return Boolean(getSetting('SENDGRID_API_KEY'));
}

async function sendMail({ to, subject, html, text, attachments, replyTo, fromName }) {
  const key = getSetting('SENDGRID_API_KEY');
  if (!key) throw new Error('Envoi de mails non configuré (clé SendGrid manquante — panel admin).');
  sgMail.setApiKey(key);
  const from = getSetting('MAIL_FROM') || 'AI-dhésif <notifications@ai-dhesif.fr>';
  const msg = {
    to,
    // fromName : afficher le nom de l'entreprise de l'utilisateur (l'adresse reste celle du domaine authentifié)
    from: fromName ? { email: String(from).match(/<([^>]+)>/)?.[1] || from, name: fromName } : from,
    subject,
    text: text || (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    html: html || `<p>${text || ''}</p>`,
  };
  if (replyTo) msg.replyTo = replyTo;
  if (attachments && attachments.length) msg.attachments = attachments;
  await sgMail.send(msg);
}

// Gabarit commun : mêmes couleurs que le site (fond sombre, accent vert)
function mailTemplate({ titre, corps, boutonTexte, boutonUrl }) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#0d0e0c;">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px;font-family:Arial,Helvetica,sans-serif;">
    <div style="background:#161814;border:1px solid #2a2d26;border-radius:16px;padding:32px 28px;">
      <div style="font-size:20px;font-weight:900;color:#c8f04a;margin-bottom:4px;">AI-dhésif</div>
      <h1 style="font-size:19px;color:#f2f4ee;margin:18px 0 12px;">${titre}</h1>
      <div style="font-size:14px;line-height:1.7;color:#b9beb0;">${corps}</div>
      ${boutonUrl ? `<div style="margin-top:24px;"><a href="${boutonUrl}" style="display:inline-block;background:#c8f04a;color:#111210;font-weight:700;font-size:14px;padding:12px 26px;border-radius:10px;text-decoration:none;">${boutonTexte || 'Ouvrir'}</a></div>` : ''}
    </div>
    <p style="font-size:11px;color:#6b7062;text-align:center;margin-top:16px;">AI-dhésif — l'assistant IA des pros de l'adhésif<br>${APP_URL}</p>
  </div>
</body></html>`;
}

module.exports = { sendMail, mailTemplate, mailReady, APP_URL };
