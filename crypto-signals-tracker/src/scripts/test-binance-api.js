// ============================================================
// test-binance-api.js - Test de connexion a l'API Binance
// ============================================================
// Usage : node src/scripts/test-binance-api.js
//         npm run test-binance
// ============================================================

// Charger la config (y compris .env)
require('../../config/config');
const binanceClient = require('../binance-client');

async function test() {
  console.log('=== Test Binance API ===\n');

  // Initialiser le client
  binanceClient.init();

  if (!binanceClient.isReady()) {
    console.error('Client non initialise. Verifiez BINANCE_API_KEY et BINANCE_API_SECRET dans config/.env');
    process.exit(1);
  }

  // Test connexion
  console.log('--- Test connexion ---');
  const connected = await binanceClient.testConnection();
  if (!connected) {
    console.error('Connexion echouee !');
    process.exit(1);
  }
  console.log('Connexion OK\n');

  // Test prix
  console.log('--- Prix actuels ---');
  const pairs = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  for (const pair of pairs) {
    const price = await binanceClient.getCurrentPrice(pair);
    console.log(`  ${pair}: $${price || 'ERREUR'}`);
  }

  // Test normalisation
  console.log('\n--- Normalisation symboles ---');
  const testPairs = ['G/USDT', 'BTC/USDT', 'HANA/USDT', 'SOL/USDT'];
  for (const pair of testPairs) {
    console.log(`  ${pair} -> ${binanceClient.normalizeSymbol(pair)}`);
  }

  // Test bougies + ATR
  console.log('\n--- ATR (15min, 14 periodes) ---');
  const candles = await binanceClient.getCandles('BTCUSDT', '15m', 15);
  if (candles) {
    const atr = binanceClient.calculateATR(candles);
    console.log(`  BTC/USDT ATR(14): ${atr ? atr.toFixed(2) : 'ERREUR'}`);
    console.log(`  Bougies recues: ${candles.length}`);
  } else {
    console.log('  Erreur recuperation bougies');
  }

  // Test avec une paire du signal Binance
  console.log('\n--- Test paire signal ---');
  const signalPair = 'G/USDT';
  const symbol = binanceClient.normalizeSymbol(signalPair);
  const realPrice = await binanceClient.getCurrentPrice(symbol);
  if (realPrice) {
    console.log(`  ${signalPair} prix reel: $${realPrice}`);

    // Simuler un calcul de profit
    const entryPrice = realPrice;
    const exitPrice = realPrice * 1.05; // +5% simule
    const leverage = 10;
    const spotProfit = ((exitPrice - entryPrice) / entryPrice) * 100;
    const leveragedProfit = spotProfit * leverage;
    console.log(`  Simulation LONG X${leverage}:`);
    console.log(`    Entry: $${entryPrice}`);
    console.log(`    Exit (+5%): $${exitPrice.toFixed(8)}`);
    console.log(`    Spot profit: +${spotProfit.toFixed(2)}%`);
    console.log(`    Leveraged: +${leveragedProfit.toFixed(2)}%`);
  } else {
    console.log(`  ${signalPair} (${symbol}) - paire introuvable sur Binance (normal si deliste)`);
  }

  console.log('\n=== Test termine ===');
}

test().catch(err => {
  console.error('Erreur:', err.message);
  process.exit(1);
});
