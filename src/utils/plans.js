// Plans d'abonnement AI-dhésif et correspondance avec les prix Stripe
const PLAN_INFO = {
  free:  { label: 'Free',  monthly: 0,  annual: null },
  smart: { label: 'Smart', monthly: 12, annual: null }, // prix annuel pas encore choisi
  pro:   { label: 'Pro',   monthly: 20, annual: 192 },
  ultra: { label: 'Ultra', monthly: 49, annual: null }, // prix annuel pas encore choisi
};

// Mappe un price ID Stripe vers [plan, période].
// Variables Railway à créer : STRIPE_PRICE_SMART, STRIPE_PRICE_SMART_ANNUAL,
// STRIPE_PRICE_PRO, STRIPE_PRICE_PRO_ANNUAL, STRIPE_PRICE_ULTRA, STRIPE_PRICE_ULTRA_ANNUAL.
// Les anciens STRIPE_PRICE_ID / STRIPE_PRICE_ID_ANNUAL (abonnement unique actuel) comptent comme Pro.
function planFromPriceId(priceId) {
  if (!priceId) return ['pro', 'monthly'];
  const map = {};
  const add = (env, plan, period) => { if (process.env[env]) map[process.env[env]] = [plan, period]; };
  add('STRIPE_PRICE_SMART', 'smart', 'monthly');
  add('STRIPE_PRICE_SMART_ANNUAL', 'smart', 'annual');
  add('STRIPE_PRICE_PRO', 'pro', 'monthly');
  add('STRIPE_PRICE_PRO_ANNUAL', 'pro', 'annual');
  add('STRIPE_PRICE_ULTRA', 'ultra', 'monthly');
  add('STRIPE_PRICE_ULTRA_ANNUAL', 'ultra', 'annual');
  add('STRIPE_PRICE_ID', 'pro', 'monthly');
  add('STRIPE_PRICE_ID_ANNUAL', 'pro', 'annual');
  return map[priceId] || ['pro', 'monthly'];
}

// Revenu mensuel équivalent en € (annuel ramené au mois)
function monthlyRevenueEur(plan, period) {
  const p = PLAN_INFO[plan];
  if (!p) return 0;
  if (period === 'annual' && p.annual) return p.annual / 12;
  return p.monthly;
}

module.exports = { PLAN_INFO, planFromPriceId, monthlyRevenueEur };
