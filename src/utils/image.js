// Normalise un visuel pour l'API Claude (max 8000 px/côté) et pour le stockage.
// Redimensionne si > 7500 px et compresse les images lourdes en JPEG.
// Renvoie { b64, type }. En cas d'absence de sharp, renvoie l'original tel quel.
const MAX_DIM = 7500;

async function normVisual(buffer, mime) {
  try {
    const sharp = require('sharp');
    const img = sharp(buffer, { failOn: 'none' });
    const meta = await img.metadata();
    const maxSide = Math.max(meta.width || 0, meta.height || 0);

    // Petit PNG net (logos) : on le garde tel quel
    if ((mime === 'image/png') && maxSide <= MAX_DIM && buffer.length < 2_500_000) {
      return { b64: buffer.toString('base64'), type: mime };
    }
    let pipeline = img;
    if (maxSide > MAX_DIM) {
      pipeline = pipeline.resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: true });
    }
    // Au-delà de ~2,5 Mo ou si redimensionné, on sort en JPEG pour alléger le stockage
    if (maxSide > MAX_DIM || buffer.length >= 2_500_000) {
      const out = await pipeline.jpeg({ quality: 88 }).toBuffer();
      return { b64: out.toString('base64'), type: 'image/jpeg' };
    }
    return { b64: buffer.toString('base64'), type: mime };
  } catch (e) {
    console.error('normVisual error:', e.message);
    return { b64: buffer.toString('base64'), type: mime };
  }
}

module.exports = { normVisual };
