const jwt = require('jsonwebtoken');
const db = require('../config/db');

// Connexions SSE ouvertes, par utilisateur (un utilisateur peut avoir plusieurs onglets)
const clients = new Map(); // userId -> Set<res>

// GET /api/events?token=JWT — EventSource ne peut pas envoyer d'en-tête Authorization
function sseHandler(req, res) {
  let user;
  try { user = jwt.verify(req.query.token || '', process.env.JWT_SECRET); }
  catch { return res.status(401).end(); }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');

  const uid = Number(user.id);
  if (!clients.has(uid)) clients.set(uid, new Set());
  clients.get(uid).add(res);

  // Ping périodique pour maintenir la connexion à travers les proxies
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    const set = clients.get(uid);
    if (set) { set.delete(res); if (!set.size) clients.delete(uid); }
  });
}

function emitTo(userId, type, data) {
  const set = clients.get(Number(userId));
  if (!set || !set.size) return;
  const msg = `event: notif\ndata: ${JSON.stringify({ type, ...(data || {}) })}\n\n`;
  for (const res of set) { try { res.write(msg); } catch {} }
}

// Notifier le patron + ses employés secrétariat (vision globale des analyses)
function emitToOwnerTeam(ownerId, type, data) {
  emitTo(ownerId, type, data);
  try {
    const secr = db.prepare("SELECT id FROM users WHERE parent_user_id = ? AND role LIKE '%secretariat%'").all(ownerId);
    for (const s of secr) emitTo(s.id, type, data);
  } catch {}
}

module.exports = { sseHandler, emitTo, emitToOwnerTeam };
