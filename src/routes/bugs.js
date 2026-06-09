const express = require('express');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.post('/', (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message requis.' });
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id);
  db.prepare('INSERT INTO bug_reports (user_id, email, message) VALUES (?, ?, ?)').run(
    req.user.id, user?.email || '', message.trim().slice(0, 2000)
  );
  res.json({ ok: true });
});

module.exports = router;
