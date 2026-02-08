// ============================================================
// recalculate-portfolio.js - Recalcul complet du portefeuille
// ============================================================
// Recalcule l'historique complet du portefeuille virtuel
// a partir de tous les trades existants dans la BDD.
//
// Usage : npm run recalculate-portfolio
// ============================================================

const config = require('../../config/config');
const database = require('../database');
const portfolio = require('../portfolio-simulator');

console.log('=== Recalcul du portefeuille virtuel ===\n');

// Initialiser la BDD
database.init(config.database.path);

// Configurer le simulateur
portfolio.configure(config.portfolio);

// Recalculer tout
const result = portfolio.recalculateAll();

console.log('--- Resultat ---');
console.log(`Capital initial : ${result.initial.toFixed(2)}$`);
console.log(`Capital actuel  : ${result.current.toFixed(2)}$`);
console.log(`Gain net        : ${result.totalGain >= 0 ? '+' : ''}${result.totalGain.toFixed(2)}$`);
console.log(`ROI             : ${result.roi >= 0 ? '+' : ''}${result.roi}%`);
console.log(`Frais cumules   : ${result.totalFees.toFixed(2)}$`);
console.log(`Trades          : ${result.totalTrades} (${result.winCount}W / ${result.lossCount}L)`);
console.log(`Win Rate        : ${result.winRate}%`);
console.log(`Pertes consec.  : max ${result.maxConsecutiveLosses}`);

console.log('\n--- Historique ---');
for (const h of result.history) {
  if (h.trade) {
    const sign = h.profitNet >= 0 ? '+' : '';
    console.log(`  ${h.date} | ${h.trade} | ${sign}${h.profitNet.toFixed(2)}$ (frais: ${h.fees.toFixed(2)}$) → ${h.capital.toFixed(2)}$`);
  }
}

console.log('\n=== Recalcul termine ===');

// Fermer la BDD
database.close();
