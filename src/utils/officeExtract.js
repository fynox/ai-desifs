const AdmZip = require('adm-zip');

// Extraction du contenu d'un brief client .pptx ou .docx (ce sont des archives zip) :
// - le TEXTE des diapos/du document (specs, quantités, matières...) → lisible par l'IA
// - les IMAGES embarquées (rendus 3D, maquettes, visuels) → analysables et stockées
function extractOffice(buffer, filename = '') {
  const out = { texts: '', images: [] };
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    const isPptx = entries.some(e => e.entryName.startsWith('ppt/'));

    // --- Textes ---
    const parts = [];
    for (const e of entries) {
      if (isPptx && /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName)) {
        const xml = e.getData().toString('utf8');
        const txts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => m[1]).filter(t => t.trim());
        const n = Number(e.entryName.match(/slide(\d+)/)[1]);
        if (txts.length) parts.push({ n, t: `Diapo ${n} : ${txts.join(' | ')}` });
      }
      if (!isPptx && e.entryName === 'word/document.xml') {
        const xml = e.getData().toString('utf8');
        const joined = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]).join(' ').replace(/\s+/g, ' ').trim();
        if (joined) parts.push({ n: 0, t: joined.slice(0, 3000) });
      }
    }
    out.texts = parts.sort((a, b) => a.n - b.n).map(p => p.t).join('\n').slice(0, 4000);

    // --- Images embarquées (les plus grosses d'abord ; on écarte puces et pictos < 8 Ko) ---
    const media = entries
      .filter(e => /^(ppt|word)\/media\/[^/]+\.(png|jpe?g|gif|webp)$/i.test(e.entryName))
      .map(e => ({ name: e.entryName.split('/').pop(), data: e.getData() }))
      .filter(m => m.data && m.data.length > 8 * 1024)
      .sort((a, b) => b.data.length - a.data.length)
      .slice(0, 5);
    for (const m of media) {
      const ext = m.name.split('.').pop().toLowerCase();
      const type = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      out.images.push({ mimetype: type, buffer: m.data, originalname: `${(filename || 'brief').replace(/\.(pptx|docx)$/i, '')} — ${m.name}` });
    }
  } catch (e) { console.error('Office extract error:', e.message); }
  return out;
}

const OFFICE_RE = /officedocument\.(presentationml\.presentation|wordprocessingml\.document)/;
function isOfficeFile(f) {
  return OFFICE_RE.test(f.mimetype || '') || /\.(pptx|docx)$/i.test(f.originalname || '');
}

module.exports = { extractOffice, isOfficeFile };
