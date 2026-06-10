const express = require('express');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.post('/', (req, res) => {
  const { message, images = [] } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message requis.' });
  // Max 3 images, dataURL image/* uniquement, ~2 Mo chacune
  const safeImages = (Array.isArray(images) ? images : [])
    .filter(i => typeof i === 'string' && i.startsWith('data:image/') && i.length < 2.8 * 1024 * 1024)
    .slice(0, 3);
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id);
  try {
    db.prepare('INSERT INTO bug_reports (user_id, email, message, images) VALUES (?, ?, ?, ?)').run(
      req.user.id, user?.email || '', message.trim().slice(0, 2000), JSON.stringify(safeImages)
    );
  } catch {
    // colonne images pas encore migrée
    db.prepare('INSERT INTO bug_reports (user_id, email, message) VALUES (?, ?, ?)').run(
      req.user.id, user?.email || '', message.trim().slice(0, 2000)
    );
  }
  res.json({ ok: true });
});

module.exports = router;
