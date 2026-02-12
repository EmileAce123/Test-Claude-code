const BaseExchange = require('./base');

class Binance extends BaseExchange {
  constructor() {
    super('binance', 'https://api.binance.com');
  }

  _toSymbol(pair) {
    // 'BTC/USDT' -> 'BTCUSDT'
    return pair.replace('/', '');
  }

  _toPair(symbol) {
    // Reverse mapping is complex; we rely on allTickers mapping instead
    return symbol;
  }

  async fetchTicker(pair) {
    try {
      const { data } = await this.client.get('/api/v3/ticker/bookTicker', {
        params: { symbol: this._toSymbol(pair) },
      });
      return {
        bid: parseFloat(data.bidPrice),
        ask: parseFloat(data.askPrice),
      };
    } catch (err) {
      console.error(`[binance] Error fetching ${pair}:`, err.message);
      return null;
    }
  }

  async fetchAllTickers() {
    try {
      const { data } = await this.client.get('/api/v3/ticker/bookTicker');
      const map = new Map();
      for (const t of data) {
        map.set(t.symbol, {
          bid: parseFloat(t.bidPrice),
          ask: parseFloat(t.askPrice),
        });
      }
      return map;
    } catch (err) {
      console.error('[binance] Error fetching all tickers:', err.message);
      return new Map();
    }
  }

  async fetchTickers(pairs) {
    // Use bulk endpoint then filter
    const all = await this.fetchAllTickers();
    const results = new Map();
    for (const pair of pairs) {
      const sym = this._toSymbol(pair);
      if (all.has(sym)) {
        results.set(pair, all.get(sym));
      }
    }
    return results;
  }
}

module.exports = Binance;
