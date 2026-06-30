// Forfaits AI-dhésif (mensuels uniquement) + système de jetons.
const PLAN_INFO = {
  smart:      { label: 'Smart',      monthly: 35,  analyses: 50,   jetons: 50,  go: 3,  users: 1 },
  pro:        { label: 'Pro',        monthly: 89,  analyses: 200,  jetons: 100, go: 5,  users: 1 },
  ultra:      { label: 'Ultra',      monthly: 199, analyses: 600,  jetons: 300, go: 10, users: 1 },
  entreprise: { label: 'Entreprise', monthly: 399, analyses: 1000, jetons: 500, go: 20, users: 5 },
};
const PLAN_RANK = { smart: 1, pro: 2, ultra: 3, entreprise: 4 };

// Coûts en jetons des actions premium
const JETON_COSTS = {
  devis: 2,
  relance: 2,            // "mail auto" (réponse/relance au client)
  upscale: 5,
  import_catalogue: 10,
  analyse_extra: 5,      // chaque analyse AU-DELÀ du quota du forfait
  storage_2go: 20,       // +2 Go de stockage
};

// Fonction réservée à un plan minimum
const FEATURE_MIN_PLAN = {
  devis: 'pro',
  relance: 'pro',
  import_catalogue: 'pro',
  upscale: 'ultra',
  mail_inbound: 'pro',
  admin_panel: 'entreprise',
  multi_user: 'entreprise',
};

// Packs de jetons (achat ponctuel via Stripe)
const JETON_PACKS = [
  { jetons: 10,   prix: 15 },
  { jetons: 30,   prix: 30 },
  { jetons: 50,   prix: 45 },
  { jetons: 100,  prix: 60 },
  { jetons: 500,  prix: 250 },
  { jetons: 1000, prix: 400 },
];

// Price IDs Stripe des abonnements (variable Railway du même nom prioritaire).
// À créer côté Stripe puis renseigner : STRIPE_PRICE_SMART, STRIPE_PRICE_PRO, STRIPE_PRICE_ULTRA, STRIPE_PRICE_ENTREPRISE.
const STRIPE_PRICE_IDS = {
  smart:      { monthly: process.env.STRIPE_PRICE_SMART || null },
  pro:        { monthly: process.env.STRIPE_PRICE_PRO || process.env.STRIPE_PRICE_ID || null },
  ultra:      { monthly: process.env.STRIPE_PRICE_ULTRA || null },
  entreprise: { monthly: process.env.STRIPE_PRICE_ENTREPRISE || null },
};

// Price IDs Stripe des packs de jetons : STRIPE_PRICE_JETON_10, _30, _50, _100, _500, _1000
function jetonPackPriceId(jetons) {
  return process.env['STRIPE_PRICE_JETON_' + jetons] || null;
}

function planFromPriceId(priceId) {
  if (!priceId) return ['pro', 'monthly'];
  const map = {};
  for (const [plan, prices] of Object.entries(STRIPE_PRICE_IDS)) {
    if (prices.monthly) map[prices.monthly] = [plan, 'monthly'];
  }
  return map[priceId] || ['pro', 'monthly'];
}

function monthlyRevenueEur(plan) {
  const p = PLAN_INFO[plan];
  return p ? p.monthly : 0;
}

// Le plan a-t-il accès à une fonction réservée ?
function planHasFeature(plan, feature) {
  const min = FEATURE_MIN_PLAN[feature];
  if (!min) return true;
  return (PLAN_RANK[plan] || 0) >= (PLAN_RANK[min] || 99);
}

module.exports = {
  PLAN_INFO, PLAN_RANK, JETON_COSTS, FEATURE_MIN_PLAN, JETON_PACKS, STRIPE_PRICE_IDS,
  planFromPriceId, monthlyRevenueEur, planHasFeature, jetonPackPriceId,
};
