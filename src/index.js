const config = require('./config');
const { createExchanges } = require('./exchanges');
const { detectSimpleArbitrage, detectTriangularArbitrage } = require('./arbitrage');
const TelegramService = require('./services/telegram');
const ArbitrageDB = require('./db/database');

const exchanges = createExchanges();
const telegram = new TelegramService();
const db = new ArbitrageDB();

let scanCount = 0;
let totalOpportunities = 0;
let totalAlertsSent = 0;

async function scan() {
  const start = Date.now();
  scanCount++;

  console.log(`\n--- Scan #${scanCount} @ ${new Date().toISOString()} ---`);

  // 1. Fetch tickers from all exchanges in parallel
  const tickersByExchange = new Map();
  const results = await Promise.allSettled(
    exchanges.map(async (ex) => {
      const tickers = await ex.fetchTickers(config.pairs);
      return { name: ex.name, tickers };
    })
  );

  for (const r of results) {
    if (r.status === 'fulfilled') {
      tickersByExchange.set(r.value.name, r.value.tickers);
      console.log(`  [${r.value.name}] ${r.value.tickers.size} pairs fetched`);
    } else {
      console.error('  Exchange fetch failed:', r.reason.message);
    }
  }

  // 2. Also fetch all tickers for triangular arbitrage (need cross-pairs like ETH/BTC)
  const allTickersByExchange = new Map();
  const triExchanges = [...new Set(config.triangularPairs.map((t) => t.exchange))];
  const triPairs = [
    ...new Set(config.triangularPairs.flatMap((t) => t.legs)),
  ];

  const triResults = await Promise.allSettled(
    exchanges
      .filter((ex) => triExchanges.includes(ex.name))
      .map(async (ex) => {
        // Fetch all needed pairs including cross-pairs
        const tickers = await ex.fetchTickers(triPairs);
        // Merge with existing tickers
        const merged = new Map([
          ...(tickersByExchange.get(ex.name) || new Map()),
          ...tickers,
        ]);
        return { name: ex.name, tickers: merged };
      })
  );

  for (const r of triResults) {
    if (r.status === 'fulfilled') {
      allTickersByExchange.set(r.value.name, r.value.tickers);
    }
  }

  // 3. Detect opportunities
  const simpleOpps = detectSimpleArbitrage(tickersByExchange);
  const triangularOpps = detectTriangularArbitrage(allTickersByExchange);
  const allOpps = [...simpleOpps, ...triangularOpps];

  console.log(`  Found: ${simpleOpps.length} simple, ${triangularOpps.length} triangular`);

  // 4. Log top opportunities
  const top = allOpps.slice(0, 5);
  for (const opp of top) {
    if (opp.type === 'simple') {
      console.log(
        `  [SIMPLE] ${opp.pair}: buy@${opp.buyExchange} ${opp.buyPrice} -> sell@${opp.sellExchange} ${opp.sellPrice} | net: ${opp.netProfitPercent.toFixed(3)}%`
      );
    } else {
      const path = opp.legs.map((l) => `${l.action} ${l.pair}`).join(' -> ');
      console.log(
        `  [TRI] ${opp.exchange} ${opp.direction}: ${path} | net: ${opp.netProfitPercent.toFixed(3)}%`
      );
    }
  }

  // 5. Store in database
  if (allOpps.length > 0) {
    db.insertOpportunities(allOpps);
    totalOpportunities += allOpps.length;
  }

  // 6. Send Telegram alerts for opportunities above threshold
  const alertsSent = await telegram.sendAlerts(allOpps, config.arbitrage.minProfitPercent);
  totalAlertsSent += alertsSent;
  if (alertsSent > 0) {
    console.log(`  Sent ${alertsSent} Telegram alert(s) (threshold: ${config.arbitrage.minProfitPercent}%)`);
  }

  // 7. Purge old data (run every 100 scans)
  if (scanCount % 100 === 0) {
    db.purgeOld();
    const stats = db.getStats();
    console.log(`  [DB Stats] Total: ${stats.total}, Last 24h: ${stats.last24h}`);
  }

  const duration = Date.now() - start;
  console.log(`  Scan completed in ${duration}ms`);
}

async function main() {
  console.log('=== Crypto Arbitrage Bot ===');
  console.log(`Exchanges: ${exchanges.map((e) => e.name).join(', ')}`);
  console.log(`Pairs: ${config.pairs.join(', ')}`);
  console.log(`Scan interval: ${config.arbitrage.scanIntervalSeconds}s`);
  console.log(`Min profit alert: ${config.arbitrage.minProfitPercent}%`);
  console.log(`Telegram alerts: ${telegram.enabled ? 'enabled' : 'disabled'}`);
  console.log(`Database: ${config.db.path} (retention: ${config.db.retentionDays} days)`);
  console.log('');

  // Send startup notification
  await telegram.sendMessage(
    `🤖 *Arbitrage Bot démarré*\n` +
    `Exchanges: ${exchanges.map((e) => e.name).join(', ')}\n` +
    `Paires: ${config.pairs.length}\n` +
    `Intervalle: ${config.arbitrage.scanIntervalSeconds}s\n` +
    `Seuil alerte: ${config.arbitrage.minProfitPercent}%`
  );

  // Run first scan immediately
  await scan();

  // Schedule recurring scans
  const intervalMs = config.arbitrage.scanIntervalSeconds * 1000;
  setInterval(async () => {
    try {
      await scan();
    } catch (err) {
      console.error('Scan error:', err);
    }
  }, intervalMs);

  console.log(`\nBot running. Next scan in ${config.arbitrage.scanIntervalSeconds}s...`);
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down...');
  db.close();
  process.exit(0);
});

main().catch((err) => {
  console.error('Fatal error:', err);
  db.close();
  process.exit(1);
});
