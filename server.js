require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

// Init DB (creates tables if needed)
require('./src/config/db');

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());

// Rediriger l'URL technique Railway vers le domaine officiel (sauf webhooks Stripe/SendGrid,
// qui peuvent être configurés sur l'URL Railway et ne suivent pas les redirections)
// Activer en définissant CANONICAL_HOST dans Railway (ex: ai-dhesif.fr) UNE FOIS le domaine connecté à Railway.
const CANONICAL_HOST = process.env.CANONICAL_HOST || null;
app.use((req, res, next) => {
  const host = req.headers.host || '';
  if (CANONICAL_HOST && host.includes('railway.app') && !req.path.startsWith('/webhooks') && !req.path.startsWith('/api/webhook')) {
    return res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
  }
  next();
});

// Stripe webhook needs raw body — must be before json middleware
app.use('/webhooks/stripe', require('./src/routes/webhook'));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
app.use('/api/', limiter);

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.use('/api/auth/', authLimiter);

// Routes API
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/stock', require('./src/routes/stock'));
app.use('/api/analyses', require('./src/routes/analyses'));
app.use('/api/stripe', require('./src/routes/stripe'));
app.use('/api/admin', require('./src/routes/admin'));
app.use('/api/bugs', require('./src/routes/bugs'));

// SendGrid inbound (pas rate limité)
app.use('/webhooks', require('./src/routes/webhook'));

// Frontend
app.use(express.static(path.join(__dirname, 'public')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('/pricing', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pricing.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AI-désifs démarré sur le port ${PORT}`));
