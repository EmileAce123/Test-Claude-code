require('dotenv').config();

module.exports = {
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },
  arbitrage: {
    minProfitPercent: parseFloat(process.env.MIN_PROFIT_PERCENT) || 2.0,
    scanIntervalSeconds: parseInt(process.env.SCAN_INTERVAL_SECONDS, 10) || 60,
  },
  db: {
    path: process.env.DB_PATH || './data/arbitrage.db',
    retentionDays: parseInt(process.env.DB_RETENTION_DAYS, 10) || 30,
  },
  // Trading fees per exchange (taker fees for market orders)
  fees: {
    binance: 0.1,    // 0.1%
    coinbase: 0.6,    // 0.6% (taker)
    kraken: 0.26,     // 0.26% (taker)
    bybit: 0.1,       // 0.1%
  },
  // Common trading pairs to monitor
  pairs: [
    'BTC/USDT',
    'ETH/USDT',
    'SOL/USDT',
    'XRP/USDT',
    'ADA/USDT',
    'DOGE/USDT',
    'AVAX/USDT',
    'DOT/USDT',
    'MATIC/USDT',
    'LINK/USDT',
  ],
  // Triangular arbitrage base assets
  triangularBases: ['USDT'],
  triangularPairs: [
    // Each entry: [pair1, pair2, pair3] forming a triangle
    // e.g., USDT -> BTC -> ETH -> USDT
    { exchange: 'binance', legs: ['BTC/USDT', 'ETH/BTC', 'ETH/USDT'] },
    { exchange: 'binance', legs: ['BTC/USDT', 'SOL/BTC', 'SOL/USDT'] },
    { exchange: 'binance', legs: ['BTC/USDT', 'XRP/BTC', 'XRP/USDT'] },
    { exchange: 'binance', legs: ['ETH/USDT', 'SOL/ETH', 'SOL/USDT'] },
    { exchange: 'bybit', legs: ['BTC/USDT', 'ETH/BTC', 'ETH/USDT'] },
    { exchange: 'bybit', legs: ['BTC/USDT', 'SOL/BTC', 'SOL/USDT'] },
    { exchange: 'bybit', legs: ['BTC/USDT', 'XRP/BTC', 'XRP/USDT'] },
    { exchange: 'kraken', legs: ['BTC/USDT', 'ETH/BTC', 'ETH/USDT'] },
  ],
};
