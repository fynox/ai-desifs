const db = require('../config/db');

// Tarifs Claude par million de tokens (USD)
const PRICES = {
  'claude-sonnet-4-6': { input: 3, output: 15 },
};
const DEFAULT_PRICE = { input: 3, output: 15 };

/**
 * Logge la consommation d'un appel API Claude pour le suivi des coûts par compte.
 * @param {number} userId
 * @param {string} type - 'analyse' | 'analyse_email' | 'relance' | 'devis' | 'import_catalogue'
 * @param {string} model
 * @param {object} usage - data.usage de la réponse Anthropic ({input_tokens, output_tokens})
 * @param {boolean} ownKey - true si l'appel a utilisé la clé perso du client (coût pas pour nous)
 */
function logUsage(userId, type, model, usage, ownKey = false) {
  try {
    if (!usage) return;
    const inTok = usage.input_tokens || 0;
    const outTok = usage.output_tokens || 0;
    const p = PRICES[model] || DEFAULT_PRICE;
    const cost = (inTok * p.input + outTok * p.output) / 1e6;
    db.prepare(
      'INSERT INTO usage_log (user_id, type, model, input_tokens, output_tokens, cost_usd, own_key) VALUES (?,?,?,?,?,?,?)'
    ).run(userId, type, model, inTok, outTok, cost, ownKey ? 1 : 0);
  } catch (e) {
    console.error('logUsage error:', e.message);
  }
}

/**
 * Logge un coût API fixe (ex: Replicate pour l'upscale — pas de tokens).
 */
function logCost(userId, type, model, costUsd) {
  try {
    db.prepare(
      'INSERT INTO usage_log (user_id, type, model, input_tokens, output_tokens, cost_usd, own_key) VALUES (?,?,?,0,0,?,0)'
    ).run(userId, type, model, costUsd);
  } catch (e) {
    console.error('logCost error:', e.message);
  }
}

module.exports = { logUsage, logCost };
