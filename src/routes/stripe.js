const express = require('express');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { STRIPE_PRICE_IDS } = require('../utils/plans');

const router = express.Router();
router.use(requireAuth);

function getStripe() {
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

router.post('/checkout', async (req, res) => {
  try {
    const stripe = getStripe();
    const { period = 'monthly', plan = '' } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email });
      customerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, user.id);
    }

    // Multi-plans : price IDs centralisés dans utils/plans.js.
    // Si la période annuelle n'a pas encore de prix (Smart/Ultra), on retombe sur le mensuel.
    let priceId;
    const prices = STRIPE_PRICE_IDS[plan];
    if (prices) {
      priceId = period === 'annual' ? (prices.annual || prices.monthly) : prices.monthly;
    }
    if (!priceId) {
      // Sans plan précisé : abonnement historique (compté comme Pro)
      priceId = period === 'annual'
        ? (process.env.STRIPE_PRICE_ID_ANNUAL || STRIPE_PRICE_IDS.pro.annual || process.env.STRIPE_PRICE_ID)
        : process.env.STRIPE_PRICE_ID;
    }

    const appUrl = process.env.APP_URL || 'http://localhost:3000';
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

router.post('/portal', async (req, res) => {
  try {
    const stripe = getStripe();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user.stripe_customer_id) return res.status(400).json({ error: 'Aucun abonnement trouvé.' });

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: (process.env.APP_URL || 'http://localhost:3000') + '/app',
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error('Stripe portal error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
