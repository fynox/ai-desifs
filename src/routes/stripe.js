const express = require('express');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function getStripe() {
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

router.post('/checkout', async (req, res) => {
  const stripe = getStripe();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  let customerId = user.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: user.email });
    customerId = customer.id;
    db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, user.id);
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    success_url: `${process.env.APP_URL}/?subscribed=1`,
    cancel_url: `${process.env.APP_URL}/?cancelled=1`,
  });

  res.json({ url: session.url });
});

router.post('/portal', async (req, res) => {
  const stripe = getStripe();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user.stripe_customer_id) return res.status(400).json({ error: 'Aucun abonnement trouvé.' });

  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripe_customer_id,
    return_url: process.env.APP_URL,
  });

  res.json({ url: session.url });
});

module.exports = router;
