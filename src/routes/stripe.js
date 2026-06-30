const express = require('express');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { STRIPE_PRICE_IDS, JETON_PACKS, jetonPackPriceId } = require('../utils/plans');

const router = express.Router();
router.use(requireAuth);

function getStripe() {
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

router.post('/checkout', async (req, res) => {
  try {
    const stripe = getStripe();
    const { plan = '', period = 'monthly' } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email });
      customerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, user.id);
    }

    // Forfaits mensuels ou annuels (price IDs dans utils/plans.js / variables Railway)
    const prices = STRIPE_PRICE_IDS[plan] || {};
    let priceId = period === 'annual' ? prices.annual : prices.monthly;
    if (!priceId) priceId = prices.monthly || process.env.STRIPE_PRICE_ID; // repli mensuel si l'annuel n'est pas configuré
    if (!priceId) return res.status(400).json({ error: 'Forfait non configuré côté Stripe (price ID manquant).' });

    // URL de retour : on prend l'origine réelle de la requête (le domaine sur lequel l'utilisateur navigue),
    // avec APP_URL en secours. Évite les redirections cassées si APP_URL est absent ou en http.
    let appUrl = req.headers.origin || process.env.APP_URL || 'https://ai-dhesif.fr';
    if (appUrl.startsWith('http://') && !appUrl.includes('localhost')) appUrl = appUrl.replace('http://', 'https://');
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${appUrl}/app?subscribed=1`,
      cancel_url: `${appUrl}/pricing?cancelled=1`,
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error('Stripe checkout error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Achat ponctuel d'un pack de jetons
router.post('/checkout-jetons', async (req, res) => {
  try {
    const stripe = getStripe();
    const jetons = Number(req.body.jetons);
    const pack = JETON_PACKS.find(p => p.jetons === jetons);
    if (!pack) return res.status(400).json({ error: 'Pack de jetons invalide.' });
    const priceId = jetonPackPriceId(jetons);
    if (!priceId) return res.status(400).json({ error: `Pack ${jetons} jetons non configuré côté Stripe (price ID manquant).` });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email });
      customerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, user.id);
    }

    let appUrl = req.headers.origin || process.env.APP_URL || 'https://ai-dhesif.fr';
    if (appUrl.startsWith('http://') && !appUrl.includes('localhost')) appUrl = appUrl.replace('http://', 'https://');
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      // métadonnées lues par le webhook pour créditer les jetons
      metadata: { user_id: String(user.id), jetons: String(jetons) },
      payment_intent_data: { metadata: { user_id: String(user.id), jetons: String(jetons) } },
      success_url: `${appUrl}/app?jetons=1`,
      cancel_url: `${appUrl}/app?jetons_cancel=1`,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('Stripe checkout-jetons error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/portal', async (req, res) => {
  try {
    const stripe = getStripe();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user.stripe_customer_id) return res.status(400).json({ error: 'Aucun abonnement trouvé.' });

    let appUrl = req.headers.origin || process.env.APP_URL || 'https://ai-dhesif.fr';
    if (appUrl.startsWith('http://') && !appUrl.includes('localhost')) appUrl = appUrl.replace('http://', 'https://');
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: appUrl + '/app',
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error('Stripe portal error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
