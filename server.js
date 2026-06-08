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

// SendGrid inbound (pas rate limité)
app.use('/webhooks', require('./src/routes/webhook'));

// Frontend
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AI-désifs démarré sur le port ${PORT}`));
