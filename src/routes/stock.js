const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

function parseItem(row) {
  return {
    ...row,
    resistances: JSON.parse(row.resistances || '[]'),
    applications: JSON.parse(row.applications || '[]'),
    dispo: Boolean(row.dispo),
  };
}

async function pdfToImages(buffer) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-'));
  const pdfPath = path.join(tmp, 'input.pdf');
  const outPrefix = path.join(tmp, 'page');
  fs.writeFileSync(pdfPath, buffer);
  return new Promise(resolve => {
    execFile('pdftoppm', ['-png', '-r', '120', pdfPath, outPrefix], err => {
      if (err) { fs.rmSync(tmp, { recursive: true, force: true }); resolve([]); return; }
      const images = fs.readdirSync(tmp).filter(f => f.endsWith('.png')).sort()
        .map(f => fs.readFileSync(path.join(tmp, f)).toString('base64'));
      fs.rmSync(tmp, { recursive: true, force: true });
      resolve(images);
    });
  });
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM stock WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json(rows.map(parseItem));
});

router.post('/', (req, res) => {
  const { cat, nom, finition, adherence, env, duree, resistances = [], applications = [], note = '', dispo = true } = req.body;
  if (!cat || !nom || !finition || !adherence || !env || !duree) return res.status(400).json({ error: 'Champs manquants.' });
  const result = db.prepare(
    'INSERT INTO stock (user_id,cat,nom,finition,adherence,env,duree,resistances,applications,note,dispo) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run(req.user.id, cat, nom, finition, adherence, env, duree, JSON.stringify(resistances), JSON.stringify(applications), note, dispo ? 1 : 0);
  const row = db.prepare('SELECT * FROM stock WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(parseItem(row));
});

router.put('/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM stock WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Référence introuvable.' });
  const { cat, nom, finition, adherence, env, duree, resistances, applications, note, dispo } = req.body;
  db.prepare(
    'UPDATE stock SET cat=?,nom=?,finition=?,adherence=?,env=?,duree=?,resistances=?,applications=?,note=?,dispo=? WHERE id=?'
  ).run(
    cat ?? item.cat, nom ?? item.nom, finition ?? item.finition,
    adherence ?? item.adherence, env ?? item.env, duree ?? item.duree,
    JSON.stringify(resistances ?? JSON.parse(item.resistances)),
    JSON.stringify(applications ?? JSON.parse(item.applications)),
    note ?? item.note,
    dispo !== undefined ? (dispo ? 1 : 0) : item.dispo,
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
router.post('/import-catalogue', upload.single('catalogue'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier fourni.' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Clé API Anthropic non configurée.' });

  try {
    const images = await pdfToImages(req.file.buffer);
    if (!images.length) return res.status(400).json({ error: 'Impossible de lire le PDF.' });

    const userContent = [
      { type: 'text', text: `Analyse ce catalogue d'adhésifs et extrais TOUS les produits adhésifs mentionnés.
Pour chaque produit, retourne un objet JSON avec exactement ces champs :
- cat: "imprimable" (vinyle imprimable/médias d'impression), "liner" (film de protection/contre-collage transparent), ou "dao" (vinyle couleur uni/découpe)
- nom: nom commercial exact du produit
- finition: "Brillant", "Mat", "Satiné", "Transparent" ou "Autre"
- adherence: "Permanente", "Repositionnable", "Extra-forte", "Standard" ou "Amovible"
- env: "Intérieur", "Extérieur", ou "Intérieur/Extérieur"
- duree: durée de vie ex "3 ans", "5-7 ans", "Court terme (< 1 an)", "Longue durée (7 ans+)"
- resistances: tableau parmi ["UV", "Humidité", "Chaleur", "Froid", "Rayures", "Solvants"]
- applications: tableau parmi ["Vitrine", "Véhicule", "Mur/Cloison", "Sol", "Fenêtre", "Signalétique"]
- note: information supplémentaire courte ou ""

Réponds UNIQUEMENT avec un tableau JSON valide sans texte autour :
[{"cat":"...","nom":"...","finition":"...","adherence":"...","env":"...","duree":"...","resistances":[],"applications":[],"note":""}]
Extrais TOUS les produits visibles dans toutes les pages du catalogue.` }
    ];

    for (const img of images.slice(0, 20)) {
      userContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: img } });
    }

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 4000, messages: [{ role: 'user', content: userContent }] }),
    });

    const data = await claudeRes.json();
    if (!claudeRes.ok) return res.status(502).json({ error: data?.error?.message || 'Erreur Anthropic' });

    const raw = data.content?.map(i => i.text || '').join('') || '';
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return res.status(502).json({ error: 'Aucun produit trouvé dans le catalogue.' });

    let produits;
    try { produits = JSON.parse(jsonMatch[0]); } catch { return res.status(502).json({ error: 'Réponse IA invalide.' }); }

    const CATS = ['imprimable', 'liner', 'dao'];
    const added = [];
    const stmt = db.prepare('INSERT INTO stock (user_id,cat,nom,finition,adherence,env,duree,resistances,applications,note,dispo) VALUES (?,?,?,?,?,?,?,?,?,?,1)');

    for (const p of produits) {
      if (!CATS.includes(p.cat) || !p.nom) continue;
      const result = stmt.run(
        req.user.id,
        p.cat, p.nom.slice(0, 100),
        p.finition || 'Autre',
        p.adherence || 'Standard',
        p.env || 'Intérieur/Extérieur',
        p.duree || 'Non spécifiée',
        JSON.stringify(Array.isArray(p.resistances) ? p.resistances : []),
        JSON.stringify(Array.isArray(p.applications) ? p.applications : []),
        (p.note || '').slice(0, 200)
      );
      added.push({ id: result.lastInsertRowid, ...p });
    }

    res.json({ ok: true, count: added.length, produits: added });
  } catch (e) {
    console.error('Import catalogue error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
