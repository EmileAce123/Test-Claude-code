#!/usr/bin/env node
// ============================================================
// test-trading-engine.js - Test du Trading Engine
// ============================================================
// Verifie la configuration et la connexion au trading engine.
// Teste en mode actuel (simulation, testnet, ou live).
//
// Usage : node src/scripts/test-trading-engine.js
// ============================================================

const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '..', 'config', '.env') });

const database = require('../database');
const tradingEngine = require('../trading-engine');

const DB_PATH = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, '..', '..', 'database', 'signals.db'));

async function test() {
  console.log('=== Test Trading Engine ===\n');

  // Init DB (necessaire pour validateTrade)
  database.init(DB_PATH);

  // Init trading engine
  tradingEngine.init();

  const status = tradingEngine.getStatus();
  console.log('Configuration :');
  console.log(`  Mode           : ${status.mode}`);
  console.log(`  Auto-trading   : ${status.enabled ? 'ACTIVE' : 'DESACTIVE'}`);
  console.log(`  Initialise     : ${status.initialized}`);
  console.log(`  Max position   : ${status.maxPositionPercent}%`);
  console.log(`  Max trades/jour: ${status.maxDailyTrades}`);
  console.log(`  Perte max/jour : ${status.maxDailyLossPercent}%`);
  console.log(`  Kill switch    : ${status.killSwitchEnabled ? 'ACTIVE' : 'DESACTIVE'}`);
  console.log('');

  if (status.mode === 'simulation') {
    console.log('Mode SIMULATION - pas de connexion Binance necessaire.');
    console.log('Pour tester en testnet, configurez TRADING_MODE=testnet dans config/.env');
    console.log('\nVariables requises pour le testnet :');
    console.log(`  BINANCE_TESTNET_API_KEY    : ${process.env.BINANCE_TESTNET_API_KEY ? 'CONFIGURE' : 'MANQUANT'}`);
    console.log(`  BINANCE_TESTNET_API_SECRET : ${process.env.BINANCE_TESTNET_API_SECRET ? 'CONFIGURE' : 'MANQUANT'}`);
    console.log(`  ENABLE_AUTO_TRADING        : ${process.env.ENABLE_AUTO_TRADING || 'false'}`);
    database.close();
    return;
  }

  // Test connexion Binance Futures
  console.log('Test connexion Binance Futures...');
  const connected = await tradingEngine.testConnection();
  if (!connected) {
    console.error('ECHEC de la connexion. Verifiez vos cles API.');
    database.close();
    return;
  }
  console.log('Connexion OK\n');

  // Test balance
  console.log('Test balance...');
  try {
    const balance = await tradingEngine.getAccountBalance();
    console.log(`Balance disponible : ${balance.toFixed(2)} USDT\n`);
  } catch (err) {
    console.error(`Erreur balance : ${err.message}\n`);
  }

  // Test account info
  console.log('Test infos compte...');
  try {
    const info = await tradingEngine.getAccountInfo();
    console.log(`  Total balance  : ${info.totalBalance.toFixed(2)} USDT`);
    console.log(`  Available      : ${info.availableBalance.toFixed(2)} USDT`);
    console.log(`  Unrealized PnL : ${info.unrealizedPnl.toFixed(2)} USDT`);
    console.log(`  Margin balance : ${info.marginBalance.toFixed(2)} USDT\n`);
  } catch (err) {
    console.error(`Erreur account info : ${err.message}\n`);
  }

  // Test sync positions
  console.log('Test positions ouvertes...');
  try {
    const positions = await tradingEngine.syncPositions();
    console.log(`  ${positions.length} position(s) ouverte(s)`);
    for (const p of positions) {
      console.log(`  ${p.symbol} ${p.side} X${p.leverage} | Qty: ${p.quantity} | Entry: ${p.entryPrice} | Mark: ${p.currentPrice} | PnL: ${p.unrealizedPnl.toFixed(2)}$`);
    }
    console.log('');
  } catch (err) {
    console.error(`Erreur sync positions : ${err.message}\n`);
  }

  // Test DB functions
  console.log('Test fonctions BDD...');
  const todayTrades = database.countTodayTrades();
  const todayPnl = database.getTodayPnl();
  console.log(`  Trades aujourd'hui : ${todayTrades}`);
  console.log(`  PnL aujourd'hui    : ${todayPnl.toFixed(2)}$\n`);

  // Test validation (sans signal reel)
  console.log('Test validation trade (mock)...');
  try {
    const balance = await tradingEngine.getAccountBalance();
    const validation = await tradingEngine.validateTrade({
      pair: 'TEST/USDT',
      direction: 'LONG',
      leverage: 10,
    }, balance);
    console.log(`  Valide : ${validation.valid}`);
    if (!validation.valid) {
      console.log(`  Raisons : ${validation.reasons.join(', ')}`);
    }
    console.log('');
  } catch (err) {
    console.error(`Erreur validation : ${err.message}\n`);
  }

  console.log('=== Tests termines ===');
  database.close();
}

test().catch(err => {
  console.error('Erreur fatale :', err);
  process.exit(1);
});
