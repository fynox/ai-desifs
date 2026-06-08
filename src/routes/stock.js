const express = require('express');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function parseItem(row) {
  return {
    ...row,
    resistances: JSON.parse(row.resistances || '[]'),
    applications: JSON.parse(row.applications || '[]'),
    dispo: Boolean(row.dispo),
  };
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

module.exports = router;
