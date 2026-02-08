// ============================================================
// portfolio-stats.js - Affiche les stats du portefeuille
// ============================================================
// Affiche un resume detaille du portefeuille virtuel
// dans le terminal (sans Telegram).
//
// Usage : npm run portfolio-stats
// ============================================================

const config = require('../../config/config');
const database = require('../database');
const portfolio = require('../portfolio-simulator');

// Initialiser la BDD
database.init(config.database.path);

// Configurer le simulateur
portfolio.configure(config.portfolio);

// Obtenir le snapshot
const snap = portfolio.getPortfolioSnapshot();
const bestWorst = portfolio.getBestWorstTrades();
const alerts = portfolio.checkAlerts();

console.log('');
console.log('╔══════════════════════════════════════════════╗');
console.log('║        PORTEFEUILLE VIRTUEL - RESUME         ║');
console.log('╚══════════════════════════════════════════════╝');
console.log('');

// Capital
console.log('  Capital initial :', snap.initial.toFixed(2) + '$');
console.log('  Capital actuel  :', snap.current.toFixed(2) + '$');
console.log('  Gain net        :', (snap.totalGain >= 0 ? '+' : '') + snap.totalGain.toFixed(2) + '$');
console.log('  ROI             :', (snap.roi >= 0 ? '+' : '') + snap.roi + '%');
console.log('  Frais cumules   :', snap.totalFees.toFixed(2) + '$');
console.log('');

// Trades
console.log('  ─── Trades ───');
console.log('  Total     :', snap.totalTrades);
console.log('  Gagnants  :', snap.winCount);
console.log('  Perdants  :', snap.lossCount);
console.log('  Win Rate  :', snap.winRate + '%');
console.log('  Pertes max consecutives :', snap.maxConsecutiveLosses);
console.log('');

// Top 5 meilleurs trades
if (bestWorst.best.length > 0) {
  console.log('  ─── Top 5 meilleurs trades ($) ───');
  for (const t of bestWorst.best) {
    console.log(`    ${t.pair} : +${t.profitNet.toFixed(2)}$ (position: ${t.positionSize.toFixed(2)}$)`);
  }
  console.log('');
}

// Top 5 pires trades
if (bestWorst.worst.length > 0) {
  console.log('  ─── Top 5 pires trades ($) ───');
  for (const t of bestWorst.worst) {
    console.log(`    ${t.pair} : ${t.profitNet.toFixed(2)}$ (position: ${t.positionSize.toFixed(2)}$)`);
  }
  console.log('');
}

// Alertes
if (alerts.length > 0) {
  console.log('  ─── Alertes ───');
  for (const alert of alerts) {
    console.log('  ⚠️', alert.replace(/\*/g, '').replace(/\n/g, ' '));
  }
  console.log('');
}

// Historique complet
const tradesHistory = snap.history.filter(h => h.trade !== null);
if (tradesHistory.length > 0) {
  console.log('  ─── Historique complet ───');
  console.log('  ' + '-'.repeat(80));
  console.log('  Date                  | Trade                    | P&L Net     | Capital');
  console.log('  ' + '-'.repeat(80));
  for (const h of tradesHistory) {
    const date = (h.date || '').substring(0, 19).padEnd(22);
    const trade = (h.trade || '').padEnd(24);
    const pnl = ((h.profitNet >= 0 ? '+' : '') + h.profitNet.toFixed(2) + '$').padStart(11);
    const cap = h.capital.toFixed(2) + '$';
    console.log(`  ${date} | ${trade} | ${pnl} | ${cap}`);
  }
  console.log('  ' + '-'.repeat(80));
}

console.log('');

// Fermer la BDD
database.close();
