// ============================================================
// reset-portfolio.js - Reinitialise les donnees du portefeuille
// ============================================================
// Remet a zero toutes les colonnes de portefeuille virtuel
// dans la base de donnees (virtual_portfolio_before/after,
// position_size, trading_fees_total, net_profit_loss).
//
// Les signaux et trades ne sont PAS supprimes.
//
// Usage : npm run reset-portfolio
// ============================================================

const config = require('../../config/config');
const database = require('../database');

console.log('=== Reinitialisation du portefeuille virtuel ===\n');
console.log('ATTENTION : Cette operation va remettre a zero toutes les');
console.log('donnees de portefeuille dans la base de donnees.');
console.log('Les signaux et trades ne sont PAS supprimes.\n');

// Initialiser la BDD
database.init(config.database.path);

// Reinitialiser
database.resetPortfolioData();

console.log('Colonnes de portefeuille remises a NULL.');
console.log('\nPour recalculer le portefeuille :');
console.log('  npm run recalculate-portfolio\n');

console.log('=== Reinitialisation terminee ===');

// Fermer la BDD
database.close();
