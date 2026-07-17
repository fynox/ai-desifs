const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { logUsage } = require('../utils/usage');
const { getSetting } = require('../utils/appSettings');
const { checkFeature, affordJetons, consumeJetons } = require('../utils/limits');
const { JETON_COSTS } = require('../utils/plans');

const router = express.Router();
router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 150 * 1024 * 1024 } });

function parseItem(row) {
  return {
    ...row,
    resistances: JSON.parse(row.resistances || '[]'),
    applications: JSON.parse(row.applications || '[]'),
    largeurs: JSON.parse(row.largeurs || '[]'),
    couleurs: JSON.parse(row.couleurs || '[]'),
    variantes: JSON.parse(row.variantes || '[]'),
    prix_m2: row.prix_m2 || null,
    dispo: Boolean(row.dispo),
  };
}

async function pdfToImages(buffer) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-'));
  const pdfPath = path.join(tmp, 'input.pdf');
  const outPrefix = path.join(tmp, 'page');
  fs.writeFileSync(pdfPath, buffer);
  return new Promise(resolve => {
    // 72dpi suffit pour la lecture de texte, images beaucoup plus légères
    execFile('pdftoppm', ['-png', '-r', '72', pdfPath, outPrefix], err => {
      if (err) { fs.rmSync(tmp, { recursive: true, force: true }); resolve([]); return; }
      const images = fs.readdirSync(tmp).filter(f => f.endsWith('.png')).sort()
        .map(f => fs.readFileSync(path.join(tmp, f)).toString('base64'));
      fs.rmSync(tmp, { recursive: true, force: true });
      resolve(images);
    });
  });
}

const EXTRACT_PROMPT = `Analyse ces pages de catalogue d'adhésifs et extrais TOUS les produits adhésifs mentionnés.

RÈGLES STRICTES :
1. "largeurs" = tableau JSON de NOMBRES entiers en cm. Ex: [61,106,137]. JAMAIS du texte dans ce champ. Si non spécifié: [].
2. "couleurs" = tableau JSON de chaînes de couleurs. Ex: ["Blanc","Noir","Rouge","Bleu clair"]. JAMAIS du texte dans "note". Si imprimable/plastification: [].
3. "note" = UNE phrase max sur une caractéristique technique non couverte par les autres champs. "" si rien d'utile.
4. Ne mets JAMAIS les couleurs ou largeurs dans "note".
5. "variantes" = tableau JSON de paires EXACTES couleur+laize si le catalogue précise quelle couleur existe en quelle laize (ex: [{"couleur":"Rouge","largeur":152},{"couleur":"Bleu","largeur":126}]). Si le catalogue ne fait pas cette distinction (toutes les couleurs dans toutes les laizes), mets [].

Champs pour chaque produit :
- cat: "imprimable"|"plastification"|"dao"|"transfert"|"covering"|"vitre"|"panneau"
- nom: nom commercial exact
- finition: "Brillant"|"Mat"|"Satiné"|"Transparent"|"Autre"
- adherence: "Permanente"|"Repositionnable"|"Extra-forte"|"Standard"|"Amovible"
- env: "Intérieur"|"Extérieur"|"Intérieur/Extérieur"
- duree: ex "3 ans", "5-7 ans", "Non spécifiée"
- resistances: sous-ensemble de ["UV","Humidité","Chaleur","Froid","Rayures","Solvants"]
- applications: sous-ensemble de ["Vitrine","Véhicule","Mur/Cloison","Sol","Fenêtre","Signalétique"]
- largeurs: [61,106,137] — NOMBRES, pas de texte
- couleurs: ["Blanc","Noir","Rouge"] — chaînes, pas dans note
- variantes: [{"couleur":"Rouge","largeur":152}] ou [] (voir règle 5)
- note: "" ou une phrase courte

Réponds UNIQUEMENT avec un tableau JSON valide, sans markdown :
[{"cat":"dao","nom":"Exemple 631","finition":"Mat","adherence":"Permanente","env":"Extérieur","duree":"5-7 ans","resistances":["UV"],"applications":["Vitrine"],"largeurs":[61,106],"couleurs":["Blanc","Noir","Rouge"],"note":""}]`;

async function extractBatch(pages, apiKey, userId) {
  const userContent = [{ type: 'text', text: EXTRACT_PROMPT }];
  for (const img of pages) {
    userContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: img } });
  }
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 8000, messages: [{ role: 'user', content: userContent }] }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Anthropic HTTP ${resp.status}`);
  }
  const data = await resp.json();
  logUsage(userId, 'import_catalogue', 'claude-sonnet-4-6', data.usage);
  const raw = data.content?.map(i => i.text || '').join('') || '';
  console.log('Claude batch raw (first 300):', raw.slice(0, 300));

  let jsonStr = null;
  const codeBlock = raw.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  if (codeBlock) jsonStr = codeBlock[1];
  else { const m = raw.match(/\[[\s\S]*\]/); if (m) jsonStr = m[0]; }
  if (!jsonStr) return [];

  try { return JSON.parse(jsonStr); } catch { return []; }
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM stock WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json(rows.map(parseItem));
});

router.post('/', (req, res) => {
  const { cat, nom, finition, adherence, env, duree, resistances = [], applications = [], largeurs = [], couleurs = [], variantes = [], prix_m2 = null, note = '', dispo = true, quantite_m2 = null, seuil_alerte = null } = req.body;
  if (!cat || !nom || !finition || !adherence || !env || !duree) return res.status(400).json({ error: 'Champs manquants.' });
  const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v);
  const result = db.prepare(
    'INSERT INTO stock (user_id,cat,nom,finition,adherence,env,duree,resistances,applications,largeurs,couleurs,variantes,prix_m2,note,dispo,quantite_m2,seuil_alerte) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(req.user.id, cat, nom, finition, adherence, env, duree, JSON.stringify(resistances), JSON.stringify(applications), JSON.stringify(largeurs), JSON.stringify(couleurs), JSON.stringify(variantes), prix_m2, note, dispo ? 1 : 0, num(quantite_m2), num(seuil_alerte));
  const row = db.prepare('SELECT * FROM stock WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(parseItem(row));
});

router.put('/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM stock WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Référence introuvable.' });
  const { cat, nom, finition, adherence, env, duree, resistances, applications, largeurs, couleurs, variantes, prix_m2, note, dispo, quantite_m2, seuil_alerte } = req.body;
  const num = v => (v === null || v === '' || isNaN(Number(v))) ? null : Number(v);
  db.prepare(
    'UPDATE stock SET cat=?,nom=?,finition=?,adherence=?,env=?,duree=?,resistances=?,applications=?,largeurs=?,couleurs=?,variantes=?,prix_m2=?,note=?,dispo=?,quantite_m2=?,seuil_alerte=? WHERE id=?'
  ).run(
    cat ?? item.cat, nom ?? item.nom, finition ?? item.finition,
    adherence ?? item.adherence, env ?? item.env, duree ?? item.duree,
    JSON.stringify(resistances ?? JSON.parse(item.resistances)),
    JSON.stringify(applications ?? JSON.parse(item.applications)),
    JSON.stringify(largeurs ?? JSON.parse(item.largeurs || '[]')),
    JSON.stringify(couleurs ?? JSON.parse(item.couleurs || '[]')),
    JSON.stringify(variantes ?? JSON.parse(item.variantes || '[]')),
    prix_m2 !== undefined ? prix_m2 : item.prix_m2,
    note ?? item.note,
    dispo !== undefined ? (dispo ? 1 : 0) : item.dispo,
    quantite_m2 !== undefined ? num(quantite_m2) : item.quantite_m2,
    seuil_alerte !== undefined ? num(seuil_alerte) : item.seuil_alerte,
    item.id
  );
  res.json(parseItem(db.prepare('SELECT * FROM stock WHERE id = ?').get(item.id)));
});

router.delete('/:id', (req, res) => {
  const item = db.prepare('SELECT id FROM stock WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Référence introuvable.' });
  db.prepare('DELETE FROM stock WHERE id = ?').run(item.id);
  res.json({ ok: true });
});

router.patch('/:id/dispo', (req, res) => {
  const item = db.prepare('SELECT id FROM stock WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Référence introuvable.' });
  db.prepare('UPDATE stock SET dispo=? WHERE id=?').run(req.body.dispo ? 1 : 0, item.id);
  res.json({ ok: true });
});

// Import catalogue PDF
router.post('/import-catalogue', (req, res, next) => {
  upload.single('catalogue')(req, res, err => {
    if (err) return res.status(400).json({ error: 'Erreur upload : ' + err.message });
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier fourni.' });
  const apiKey = getSetting('ANTHROPIC_API_KEY');
  if (!apiKey) return res.status(500).json({ error: 'Clé API Anthropic non configurée.' });
  const impUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const ftI = checkFeature(impUser, 'import_catalogue'); if (ftI) return res.status(403).json(ftI);
  const affI = affordJetons(impUser, JETON_COSTS.import_catalogue); if (affI) return res.status(403).json(affI);

  try {
    const images = await pdfToImages(req.file.buffer);
    if (!images.length) return res.status(400).json({ error: 'Impossible de lire le PDF (pdftoppm indisponible ou PDF corrompu).' });

    // Traiter par lots de 5 pages max pour éviter les timeouts
    const BATCH = 5;
    const MAX_PAGES = 30;
    const pages = images.slice(0, MAX_PAGES);
    const batches = [];
    for (let i = 0; i < pages.length; i += BATCH) batches.push(pages.slice(i, i + BATCH));

    console.log(`Import catalogue: ${pages.length} pages, ${batches.length} lots`);

    const allProduits = [];
    for (const batch of batches) {
      const results = await extractBatch(batch, apiKey, req.user.id);
      allProduits.push(...results);
    }

    const produits = allProduits;

    const CATS = ['imprimable', 'plastification', 'dao', 'transfert', 'covering', 'vitre', 'panneau', 'encre'];
    const added = [];
    const stmt = db.prepare('INSERT INTO stock (user_id,cat,nom,finition,adherence,env,duree,resistances,applications,largeurs,couleurs,variantes,note,dispo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)');

    for (const p of produits) {
      if (!CATS.includes(p.cat) || !p.nom) continue;
      // Largeurs : convertir en strings
      const largeurs = Array.isArray(p.largeurs) ? p.largeurs.map(String) : [];
      const couleurs = Array.isArray(p.couleurs) ? p.couleurs : [];
      // Variantes : paires exactes du catalogue, sinon produit cartésien couleurs × largeurs
      let variantes = Array.isArray(p.variantes) ? p.variantes.filter(v => v && (v.couleur || v.largeur)) : [];
      if (!variantes.length) {
        if (couleurs.length && largeurs.length) couleurs.forEach(c => largeurs.forEach(l => variantes.push({ couleur: c, largeur: parseFloat(l) })));
        else if (couleurs.length) couleurs.forEach(c => variantes.push({ couleur: c, largeur: null }));
        else if (largeurs.length) largeurs.forEach(l => variantes.push({ couleur: null, largeur: parseFloat(l) }));
      }
      const result = stmt.run(
        req.user.id,
        p.cat, p.nom.slice(0, 100),
        p.finition || 'Autre',
        p.adherence || 'Standard',
        p.env || 'Intérieur/Extérieur',
        p.duree || 'Non spécifiée',
        JSON.stringify(Array.isArray(p.resistances) ? p.resistances : []),
        JSON.stringify(Array.isArray(p.applications) ? p.applications : []),
        JSON.stringify(largeurs),
        JSON.stringify(couleurs),
        JSON.stringify(variantes),
        (p.note || '').slice(0, 200)
      );
      added.push({ id: result.lastInsertRowid, ...p });
    }

    consumeJetons(impUser, JETON_COSTS.import_catalogue, 'import_catalogue');
    res.json({ ok: true, count: added.length, produits: added });
  } catch (e) {
    console.error('Import catalogue error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
