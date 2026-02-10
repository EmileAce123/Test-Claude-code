// ============================================================
// test-pyramid.js - Test de la strategie pyramidale multi-TP
// ============================================================
// Simule un trade complet avec donnees fictives :
//   1. Signal initial G/USDT LONG X10
//   2. TP1 atteint → Fermer 35%
//   3. TP2 atteint → Fermer 22.5%
//   4. Verifier les calculs
//   5. Afficher le resume
//
// Usage : node src/scripts/test-pyramid.js
// ============================================================

const path = require('path');
const Database = require('better-sqlite3');
const portfolio = require('../portfolio-simulator');
const database = require('../database');
const logger = require('../logger');

// ---- Configuration ----
const TEST_DB_PATH = path.join(__dirname, '..', '..', 'database', 'test-pyramid.db');
const START_CAPITAL = 200;

// Nettoyer l'ancienne DB de test si elle existe
const fs = require('fs');
if (fs.existsSync(TEST_DB_PATH)) {
  fs.unlinkSync(TEST_DB_PATH);
  console.log('Ancienne DB de test supprimee.\n');
}

// Initialiser
database.init(TEST_DB_PATH);
portfolio.configure({
  startCapital: START_CAPITAL,
  maxPositionPct: 10,
  tradingFeePct: 0.5,
});

console.log('=== TEST STRATEGIE PYRAMIDALE MULTI-TP ===\n');
console.log(`Capital initial : ${START_CAPITAL}$`);
console.log(`Position max    : 10% du capital disponible`);
console.log(`Frais trading   : 0.5%`);
console.log(`Marge securite  : gains x${portfolio.SAFETY_MARGIN_GAINS}, pertes x${portfolio.SAFETY_MARGIN_LOSSES}\n`);

console.log('Configuration pyramidale :');
for (const [tp, pct] of Object.entries(portfolio.PYRAMID_CONFIG)) {
  console.log(`  TP${tp} = ${pct}% de la position initiale`);
}
console.log('');

// ============================================================
// ETAPE 1 : Inserer un signal G/USDT LONG X10
// ============================================================
console.log('--- ETAPE 1 : Signal G/USDT LONG X10 ---');

const signalData = {
  telegramMessageId: 900001,
  pair: 'G/USDT',
  direction: 'LONG',
  entryPriceMin: 0.03400,
  entryPriceMax: 0.03600,
  leverage: 10,
  stopLoss: 0.03100,
  emitter: '@TestBot',
  targets: [0.03800, 0.04000, 0.04200, 0.04400, 0.04600],
  sourceGroup: 'Test Pyramid',
};

const insertedSignal = database.insertSignal(signalData);
if (!insertedSignal) {
  console.error('ERREUR : signal non insere');
  process.exit(1);
}
console.log(`Signal insere : ID #${insertedSignal.id}`);

// Initialiser la position pyramidale
const posSize = portfolio.initPosition(insertedSignal.id);
console.log(`Position initiale : ${posSize.toFixed(2)}$`);
console.log(`  (10% de ${START_CAPITAL}$ = ${(START_CAPITAL * 0.1).toFixed(2)}$)\n`);

// Verifier l'etat du signal
let signal = database.getSignalById(insertedSignal.id);
console.log(`Etat signal :`);
console.log(`  position_size_initial     = ${signal.position_size_initial}`);
console.log(`  position_remaining_percent = ${signal.position_remaining_percent}%`);
console.log(`  position_remaining_size    = ${signal.position_remaining_size}`);
console.log(`  status                     = ${signal.status}\n`);

// ============================================================
// ETAPE 2 : TP1 atteint (+50% avec leverage x10)
// ============================================================
console.log('--- ETAPE 2 : TP1 atteint (profit Telegram = +50%) ---');

// Inserer la confirmation
database.insertConfirmation({
  telegramMessageId: 900002,
  pair: 'G/USDT',
  targetNumber: 1,
  profitPct: 50,
  period: '2h30m',
});

// Executer la fermeture pyramidale
const tp1Result = portfolio.executePyramidTP(insertedSignal.id, 1, 50);

if (tp1Result) {
  console.log(`  % ferme        : ${tp1Result.percentClosed}%`);
  console.log(`  Taille fermee  : ${tp1Result.sizeClosed.toFixed(2)}$`);
  console.log(`  Profit Telegram: +50% → Apres marge: +${tp1Result.profitPctSafe.toFixed(2)}%`);
  console.log(`  Profit net     : ${tp1Result.profitNet >= 0 ? '+' : ''}${tp1Result.profitNet.toFixed(4)}$`);
  console.log(`  Restant        : ${tp1Result.remainingPercent}% (${tp1Result.remainingSize.toFixed(2)}$)`);
  console.log(`  Total realise  : ${tp1Result.profitRealizedTotal >= 0 ? '+' : ''}${tp1Result.profitRealizedTotal.toFixed(4)}$`);
  console.log(`  P&L latent     : ${tp1Result.profitLatent >= 0 ? '+' : ''}${tp1Result.profitLatent.toFixed(4)}$`);
  console.log(`  P&L total      : ${tp1Result.pnlTotal >= 0 ? '+' : ''}${tp1Result.pnlTotal.toFixed(4)}$`);
  console.log(`  Status         : ${tp1Result.status}`);
  console.log(`  Capital apres  : ${tp1Result.capitalAfter.toFixed(2)}$\n`);
} else {
  console.log('  ERREUR: TP1 non execute\n');
}

// ============================================================
// ETAPE 3 : TP2 atteint (+100% avec leverage x10)
// ============================================================
console.log('--- ETAPE 3 : TP2 atteint (profit Telegram = +100%) ---');

database.insertConfirmation({
  telegramMessageId: 900003,
  pair: 'G/USDT',
  targetNumber: 2,
  profitPct: 100,
  period: '5h15m',
});

const tp2Result = portfolio.executePyramidTP(insertedSignal.id, 2, 100);

if (tp2Result) {
  console.log(`  % ferme        : ${tp2Result.percentClosed}%`);
  console.log(`  Taille fermee  : ${tp2Result.sizeClosed.toFixed(2)}$`);
  console.log(`  Profit Telegram: +100% → Apres marge: +${tp2Result.profitPctSafe.toFixed(2)}%`);
  console.log(`  Profit net     : ${tp2Result.profitNet >= 0 ? '+' : ''}${tp2Result.profitNet.toFixed(4)}$`);
  console.log(`  Restant        : ${tp2Result.remainingPercent}% (${tp2Result.remainingSize.toFixed(2)}$)`);
  console.log(`  Total realise  : ${tp2Result.profitRealizedTotal >= 0 ? '+' : ''}${tp2Result.profitRealizedTotal.toFixed(4)}$`);
  console.log(`  Status         : ${tp2Result.status}`);
  console.log(`  Capital apres  : ${tp2Result.capitalAfter.toFixed(2)}$\n`);
} else {
  console.log('  ERREUR: TP2 non execute\n');
}

// ============================================================
// ETAPE 4 : Verifier les executions en BDD
// ============================================================
console.log('--- ETAPE 4 : Verification des executions ---');

const executions = database.getTradeExecutions(insertedSignal.id);
console.log(`\nExecutions enregistrees : ${executions.length}`);

for (const exec of executions) {
  const label = exec.target_number === 0 ? 'SL' : `TP${exec.target_number}`;
  console.log(`  ${label} : ferme ${exec.position_closed_percent}% (${exec.position_closed_size.toFixed(2)}$) → profit: ${exec.profit_realized >= 0 ? '+' : ''}${exec.profit_realized.toFixed(4)}$ (${exec.profit_realized_percent.toFixed(2)}%)`);
}

// Verifier l'etat final du signal
signal = database.getSignalById(insertedSignal.id);
console.log(`\nEtat signal apres TP1+TP2 :`);
console.log(`  position_size_initial      = ${signal.position_size_initial}$`);
console.log(`  position_remaining_percent = ${signal.position_remaining_percent}%`);
console.log(`  position_remaining_size    = ${signal.position_remaining_size}$`);
console.log(`  profit_realized_total      = ${signal.profit_realized_total}$`);
console.log(`  pnl_total                  = ${signal.pnl_total}$`);
console.log(`  status                     = ${signal.status}`);

// ============================================================
// ETAPE 5 : Inserer un 2eme signal et simuler un SL
// ============================================================
console.log('\n--- ETAPE 5 : 2eme signal BTC/USDT SHORT X20 + SL ---');

const signal2Data = {
  telegramMessageId: 900010,
  pair: 'BTC/USDT',
  direction: 'SHORT',
  entryPriceMin: 62000,
  entryPriceMax: 63000,
  leverage: 20,
  stopLoss: 65000,
  emitter: '@TestBot',
  targets: [60000, 58000, 56000],
  sourceGroup: 'Test Pyramid',
};

const signal2 = database.insertSignal(signal2Data);
console.log(`Signal 2 insere : ID #${signal2.id}`);

const posSize2 = portfolio.initPosition(signal2.id);
const currentCapital = database.getLastPortfolioCapital(START_CAPITAL);
const exposure = database.getOpenExposure();
console.log(`Position initiale : ${posSize2.toFixed(2)}$ (capital=${currentCapital.toFixed(2)}$, exposure=${exposure.toFixed(2)}$)`);

// Stop loss a -30%
database.insertStopLoss({
  telegramMessageId: 900011,
  pair: 'BTC/USDT',
  lossPct: 30,
  period: '1h45m',
});

const slResult = portfolio.executePyramidSL(signal2.id, 30);
if (slResult) {
  console.log(`  SL execute : ferme ${slResult.percentClosed}% (${slResult.sizeClosed.toFixed(2)}$)`);
  console.log(`  Perte nette    : -${slResult.lossNet.toFixed(4)}$`);
  console.log(`  Perte % (safe) : -${slResult.lossPctSafe.toFixed(2)}%`);
  console.log(`  P&L total      : ${slResult.pnlTotal >= 0 ? '+' : ''}${slResult.pnlTotal.toFixed(4)}$`);
  console.log(`  Capital apres  : ${slResult.capitalAfter.toFixed(2)}$\n`);
} else {
  console.log('  ERREUR: SL non execute\n');
}

// ============================================================
// ETAPE 6 : Recalcul complet
// ============================================================
console.log('--- ETAPE 6 : Recalcul complet du portefeuille ---');

// Reset et recalculer
database.resetPortfolioData();
database.deleteAllTradeExecutions();

const result = portfolio.recalculateAll();

console.log(`\n--- Resume recalcul ---`);
console.log(`Capital initial  : ${result.initial}$`);
console.log(`Capital actuel   : ${result.current}$`);
console.log(`Gain net         : ${result.totalGain >= 0 ? '+' : ''}${result.totalGain}$`);
console.log(`ROI              : ${result.roi >= 0 ? '+' : ''}${result.roi}%`);
console.log(`Frais cumules    : ${result.totalFees}$`);
console.log(`Trades           : ${result.totalTrades} (${result.winCount}W / ${result.lossCount}L)`);
console.log(`Win Rate         : ${result.winRate}%`);
console.log(`Pertes consec.   : max ${result.maxConsecutiveLosses}`);
console.log(`Exposition       : ${result.exposure}$`);

console.log('\n--- Historique ---');
for (const h of result.history) {
  if (h.trade) {
    const sign = h.profitNet >= 0 ? '+' : '';
    console.log(`  ${h.date} | ${h.trade} | ${sign}${h.profitNet.toFixed(2)}$ (frais: ${h.fees.toFixed(2)}$) → ${h.capital.toFixed(2)}$`);
  } else {
    console.log(`  ${h.date} | Debut → ${h.capital.toFixed(2)}$`);
  }
}

// ============================================================
// VERIFICATION MANUELLE DES CALCULS
// ============================================================
console.log('\n=== VERIFICATION MANUELLE ===');
console.log('\nSignal 1 : G/USDT LONG X10, position = 20$ (10% de 200$)');
console.log('  TP1 : ferme 35% = 7$');
console.log('    Profit Telegram +50% → safe +42.5%');
console.log('    Profit brut = 7 × 0.425 = 2.975$');
console.log('    Fee entree = 7 × 0.005 = 0.035$');
console.log('    Fee sortie = (7 + 2.975) × 0.005 = 0.0499$');
console.log('    Profit net = 2.975 - 0.035 - 0.0499 = 2.8901$');
console.log('  TP2 : ferme 22.5% = 4.5$');
console.log('    Profit Telegram +100% → safe +85%');
console.log('    Profit brut = 4.5 × 0.85 = 3.825$');
console.log('    Fee entree = 4.5 × 0.005 = 0.0225$');
console.log('    Fee sortie = (4.5 + 3.825) × 0.005 = 0.0416$');
console.log('    Profit net = 3.825 - 0.0225 - 0.0416 = 3.7609$');

console.log('\n=== TEST TERMINE ===');

// Nettoyer
database.close();

// Supprimer la DB de test
try {
  fs.unlinkSync(TEST_DB_PATH);
  console.log('\nDB de test nettoyee.');
} catch (e) {
  // Ignorer si le fichier n'existe pas
}
