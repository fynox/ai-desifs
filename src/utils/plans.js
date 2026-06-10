// Plans d'abonnement AI-dhésif et correspondance avec les prix Stripe
const PLAN_INFO = {
  free:  { label: 'Free',  monthly: 0,  annual: null },
  smart: { label: 'Smart', monthly: 12, annual: null }, // prix annuel pas encore choisi
  pro:   { label: 'Pro',   monthly: 20, annual: 192 },
  ultra: { label: 'Ultra', monthly: 49, annual: null }, // prix annuel pas encore choisi
};

// Price IDs Stripe par plan/période (une variable Railway du même nom prend le dessus si définie).
// Smart annuel et Ultra annuel : prix pas encore choisis → null (la facturation annuelle retombe sur le mensuel).
const STRIPE_PRICE_IDS = {
  smart: {
    monthly: process.env.STRIPE_PRICE_SMART || 'price_1TgEuAP9wUBWfeABU1iDvWWe',
    annual: process.env.STRIPE_PRICE_SMART_ANNUAL || null,
  },
  pro: {
    monthly: process.env.STRIPE_PRICE_PRO || process.env.STRIPE_PRICE_ID || null,
    annual: process.env.STRIPE_PRICE_PRO_ANNUAL || 'price_1TgEvsP9wUBWfeABanrl7Y5H',
  },
  ultra: {
    monthly: process.env.STRIPE_PRICE_ULTRA || 'price_1TgEuvP9wUBWfeABn2pU14C3',
    annual: process.env.STRIPE_PRICE_ULTRA_ANNUAL || null,
  },
};

// Mappe un price ID Stripe vers [plan, période].
// L'ancien STRIPE_PRICE_ID_ANNUAL (abonnement unique historique) compte comme Pro.
function planFromPriceId(priceId) {
  if (!priceId) return ['pro', 'monthly'];
  const map = {};
  for (const [plan, prices] of Object.entries(STRIPE_PRICE_IDS)) {
    if (prices.monthly) map[prices.monthly] = [plan, 'monthly'];
    if (prices.annual) map[prices.annual] = [plan, 'annual'];
  }
  if (process.env.STRIPE_PRICE_ID_ANNUAL) map[process.env.STRIPE_PRICE_ID_ANNUAL] = ['pro', 'annual'];
  return map[priceId] || ['pro', 'monthly'];
}

// Revenu mensuel équivalent en € (annuel ramené au mois)
function monthlyRevenueEur(plan, period) {
  const p = PLAN_INFO[plan];
  if (!p) return 0;
  if (period === 'annual' && p.annual) return p.annual / 12;
  return p.monthly;
}

module.exports = { PLAN_INFO, STRIPE_PRICE_IDS, planFromPriceId, monthlyRevenueEur };
