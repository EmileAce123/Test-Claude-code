// ============================================================
// recalculate-portfolio.js - Recalcul complet du portefeuille
// ============================================================
// RESET puis recalcule l'historique complet du portefeuille
// virtuel a partir de tous les trades existants dans la BDD.
//
// Usage : node src/scripts/recalculate-portfolio.js
// ============================================================

const config = require('../../config/config');
const database = require('../database');
const portfolio = require('../portfolio-simulator');

console.log('=== Recalcul du portefeuille virtuel ===\n');

// Initialiser la BDD
database.init(config.database.path);

// Configurer le simulateur
portfolio.configure(config.portfolio);

// ETAPE 1 : Effacer toutes les anciennes valeurs de portefeuille
console.log('[1/2] Reset des colonnes portfolio (efface les anciennes valeurs)...');
database.resetPortfolioData();

// ETAPE 2 : Recalculer tout depuis zero
console.log('[2/2] Recalcul complet (profit % = leverage deja inclus)...\n');
const result = portfolio.recalculateAll();

console.log('\n--- Resultat ---');
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
console.log('Redemarrez le dashboard pour voir les nouvelles valeurs :');
console.log('  pm2 restart crypto-dashboard');

// Fermer la BDD
database.close();
