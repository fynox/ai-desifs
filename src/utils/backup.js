const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const db = require('../config/db');
const { getSetting, setSetting } = require('./appSettings');

const dbPath = process.env.DB_PATH || './data/aidesifs.db';
const backupDir = path.join(path.dirname(dbPath), 'backups');
const RETENTION = 7;                    // nombre de sauvegardes conservées sur le disque
const MAIL_MAX_BYTES = 15 * 1024 * 1024; // au-delà, la pièce jointe dépasserait la limite SendGrid

function listBackups() {
  try {
    return fs.readdirSync(backupDir)
      .filter(f => /^aidesifs-[\w.-]+\.db\.gz$/.test(f))
      .map(f => {
        const st = fs.statSync(path.join(backupDir, f));
        return { name: f, size: st.size, date: st.mtime.toISOString() };
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  } catch { return []; }
}

async function runBackup(motif) {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const rawPath = path.join(backupDir, `aidesifs-${stamp}.db`);
  const gzPath = rawPath + '.gz';

  // VACUUM INTO produit une copie cohérente même pendant que l'app tourne (mode WAL)
  db.exec(`VACUUM INTO '${rawPath.replace(/'/g, "''")}'`);
  await new Promise((resolve, reject) => {
    fs.createReadStream(rawPath)
      .on('error', reject)
      .pipe(zlib.createGzip({ level: 6 }))
      .pipe(fs.createWriteStream(gzPath))
      .on('error', reject)
      .on('finish', resolve);
  });
  fs.unlinkSync(rawPath);

  // Rétention : on garde les N plus récentes
  for (const old of listBackups().slice(RETENTION)) {
    try { fs.unlinkSync(path.join(backupDir, old.name)); } catch {}
  }

  const size = fs.statSync(gzPath).size;
  let mailed = false, mailError = null;
  const dest = (process.env.BACKUP_EMAIL || (process.env.ADMIN_EMAILS || '').split(',')[0] || '').trim();
  if (dest && size <= MAIL_MAX_BYTES) {
    try {
      const { sendMail, mailTemplate } = require('./mailer');
      const sizeMo = (size / 1024 / 1024).toFixed(2);
      await sendMail({
        to: dest,
        subject: `💾 Sauvegarde AI-dhésif du ${new Date().toLocaleDateString('fr-FR')} (${sizeMo} Mo)`,
        html: mailTemplate({
          titre: 'Sauvegarde de la base de données',
          corps: `Copie ${motif === 'auto' ? 'quotidienne automatique' : 'manuelle'} de la base AI-dhésif, en pièce jointe (${sizeMo} Mo, compressée).<br><br>Pour restaurer : décompresser le fichier .gz et remplacer le fichier de base de données sur le serveur.`,
        }),
        attachments: [{
          content: fs.readFileSync(gzPath).toString('base64'),
          filename: path.basename(gzPath),
          type: 'application/gzip',
          disposition: 'attachment',
        }],
      });
      mailed = true;
    } catch (e) { mailError = e.message; }
  } else if (dest) {
    mailError = `Fichier trop volumineux pour un envoi par mail (${(size / 1024 / 1024).toFixed(1)} Mo > 15 Mo) — télécharge-le depuis le panel admin.`;
  }

  setSetting('LAST_BACKUP_AT', new Date().toISOString());
  return { file: path.basename(gzPath), size, mailed, mailError };
}

// Une sauvegarde par jour, déclenchée à la première occasion (vérification toutes les heures)
function scheduleBackups() {
  const check = async () => {
    try {
      const last = getSetting('LAST_BACKUP_AT') || '';
      if (last.slice(0, 10) === new Date().toISOString().slice(0, 10)) return;
      const r = await runBackup('auto');
      console.log(`Sauvegarde auto : ${r.file} (${(r.size / 1024 / 1024).toFixed(2)} Mo)${r.mailed ? ' — envoyée par mail' : ''}${r.mailError ? ' — mail non envoyé : ' + r.mailError : ''}`);
    } catch (e) { console.error('Sauvegarde auto en échec :', e.message); }
  };
  setTimeout(check, 60 * 1000);
  setInterval(check, 60 * 60 * 1000);
}

module.exports = { runBackup, listBackups, scheduleBackups, backupDir };
