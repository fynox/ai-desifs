// Produit une copie RÉDUITE d'un visuel UNIQUEMENT pour l'API Claude (limite 8000 px/côté).
// L'original n'est jamais modifié : il est stocké tel quel pour garder la pleine qualité à l'export.
// Renvoie { b64, type }. Si l'image est déjà sous la limite, l'original est renvoyé inchangé.
const MAX_DIM = 7500;

async function shrinkForApi(buffer, mime) {
  try {
    const sharp = require('sharp');
    const meta = await sharp(buffer, { failOn: 'none' }).metadata();
    const maxSide = Math.max(meta.width || 0, meta.height || 0);
    if (maxSide <= MAX_DIM) {
      return { b64: buffer.toString('base64'), type: mime }; // déjà OK, on n'altère rien
    }
    // Trop grande pour Claude → copie réduite (JPEG) juste pour l'analyse
    const out = await sharp(buffer, { failOn: 'none' })
      .resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
    return { b64: out.toString('base64'), type: 'image/jpeg' };
  } catch (e) {
    console.error('shrinkForApi error:', e.message);
    return { b64: buffer.toString('base64'), type: mime };
  }
}

module.exports = { shrinkForApi };
