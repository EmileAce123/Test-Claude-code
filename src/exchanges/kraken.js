const BaseExchange = require('./base');

// Kraken uses non-standard pair names
const PAIR_MAP = {
  'BTC/USDT': 'XBTUSDT',
  'ETH/USDT': 'ETHUSDT',
  'SOL/USDT': 'SOLUSDT',
  'XRP/USDT': 'XRPUSDT',
  'ADA/USDT': 'ADAUSDT',
  'DOGE/USDT': 'DOGEUSDT',
  'AVAX/USDT': 'AVAXUSDT',
  'DOT/USDT': 'DOTUSDT',
  'MATIC/USDT': 'MATICUSDT',
  'LINK/USDT': 'LINKUSDT',
  'ETH/BTC': 'ETHXBT',
  'SOL/BTC': 'SOLXBT',
  'XRP/BTC': 'XRPXBT',
  'SOL/ETH': 'SOLETH',
};

const REVERSE_MAP = Object.fromEntries(
  Object.entries(PAIR_MAP).map(([k, v]) => [v, k])
);

class Kraken extends BaseExchange {
  constructor() {
    super('kraken', 'https://api.kraken.com');
  }

  _toKrakenPair(pair) {
    return PAIR_MAP[pair] || pair.replace('/', '');
  }

  async fetchTicker(pair) {
    try {
      const krakenPair = this._toKrakenPair(pair);
      const { data } = await this.client.get('/0/public/Ticker', {
        params: { pair: krakenPair },
      });
      if (data.error && data.error.length > 0) {
        console.error(`[kraken] API error for ${pair}:`, data.error);
        return null;
      }
      const key = Object.keys(data.result)[0];
      const ticker = data.result[key];
      return {
        bid: parseFloat(ticker.b[0]),
        ask: parseFloat(ticker.a[0]),
      };
    } catch (err) {
      console.error(`[kraken] Error fetching ${pair}:`, err.message);
      return null;
    }
  }

  async fetchAllTickers() {
    try {
      const krakenPairs = Object.values(PAIR_MAP).join(',');
      const { data } = await this.client.get('/0/public/Ticker', {
        params: { pair: krakenPairs },
      });
      if (data.error && data.error.length > 0) {
        console.error('[kraken] API error:', data.error);
        return new Map();
      }
      const map = new Map();
      for (const [key, ticker] of Object.entries(data.result)) {
        // Try to reverse-map the key
        const normalized = REVERSE_MAP[key];
        if (normalized) {
          map.set(normalized, {
            bid: parseFloat(ticker.b[0]),
            ask: parseFloat(ticker.a[0]),
          });
        }
      }
      return map;
    } catch (err) {
      console.error('[kraken] Error fetching all tickers:', err.message);
      return new Map();
    }
  }
}

module.exports = Kraken;
