// ============================================================
// manual-stats.js - Affichage des statistiques dans le terminal
// ============================================================
// Ce script affiche les statistiques directement dans la console.
// Utile pour vérifier rapidement les performances sans Telegram.
//
// Utilisation : node src/manual-stats.js
// ============================================================

const path = require('path');
const dotenv = require('dotenv');

// Charger la config
dotenv.config({ path: path.join(__dirname, '..', 'config', '.env') });

const database = require('./database');
const statsCalculator = require('./stats-calculator');

// Initialiser la base de données
const dbPath = process.env.DATABASE_PATH
  || path.join(__dirname, '..', 'database', 'signals.db');
database.init(dbPath);

// Calculer les statistiques
const globalStats = statsCalculator.calculateGlobalStats();

console.log('');
console.log('================================================');
console.log('  STATISTIQUES GLOBALES - Crypto Signals Tracker');
console.log('================================================');
console.log('');

const { counts } = globalStats;
console.log(`Signaux totaux reçus  : ${counts.total}`);
console.log(`  En cours            : ${counts.open}`);
console.log(`  Gagnants (TP hit)   : ${counts.won}`);
console.log(`  Perdants (SL hit)   : ${counts.lost}`);
console.log(`  Annulés             : ${counts.cancelled}`);
console.log('');

if (globalStats.totalTrades > 0) {
  console.log(`Trades terminés       : ${globalStats.totalTrades}`);
  console.log(`Win Rate              : ${globalStats.winRate}%`);
  console.log(`Profit moyen/trade    : ${globalStats.avgProfit > 0 ? '+' : ''}${globalStats.avgProfit}%`);
  console.log(`Profit total cumulé   : ${globalStats.totalProfit > 0 ? '+' : ''}${globalStats.totalProfit}%`);
  console.log(`Drawdown maximum      : ${globalStats.maxDrawdown}%`);
  console.log('');

  if (globalStats.bestTrade) {
    console.log(`Meilleur trade : ${globalStats.bestTrade.pair} ${globalStats.bestTrade.direction} → +${globalStats.bestTrade.profit}%`);
  }
  if (globalStats.worstTrade) {
    console.log(`Pire trade     : ${globalStats.worstTrade.pair} ${globalStats.worstTrade.direction} → ${globalStats.worstTrade.profit}%`);
  }

  // Derniers trades
  console.log('');
  console.log('--- 10 derniers trades ---');
  const last10 = globalStats.trades.slice(0, 10);
  for (const trade of last10) {
    const icon = trade.profit >= 0 ? '✅' : '❌';
    console.log(`${icon} ${trade.pair} ${trade.direction} → ${trade.profit > 0 ? '+' : ''}${trade.profit}% (${trade.date})`);
  }
} else {
  console.log('Aucun trade terminé pour le moment.');
}

console.log('');
console.log('================================================');

// Fermer la base de données
database.close();
