const BaseExchange = require('./base');

class Bybit extends BaseExchange {
  constructor() {
    super('bybit', 'https://api.bybit.com');
  }

  _toSymbol(pair) {
    // 'BTC/USDT' -> 'BTCUSDT'
    return pair.replace('/', '');
  }

  async fetchTicker(pair) {
    try {
      const { data } = await this.client.get('/v5/market/tickers', {
        params: { category: 'spot', symbol: this._toSymbol(pair) },
      });
      if (data.retCode !== 0) {
        console.error(`[bybit] API error for ${pair}:`, data.retMsg);
        return null;
      }
      const t = data.result.list[0];
      return {
        bid: parseFloat(t.bid1Price),
        ask: parseFloat(t.ask1Price),
      };
    } catch (err) {
      console.error(`[bybit] Error fetching ${pair}:`, err.message);
      return null;
    }
  }

  async fetchAllTickers() {
    try {
      const { data } = await this.client.get('/v5/market/tickers', {
        params: { category: 'spot' },
      });
      if (data.retCode !== 0) {
        console.error('[bybit] API error:', data.retMsg);
        return new Map();
      }
      const map = new Map();
      for (const t of data.result.list) {
        map.set(t.symbol, {
          bid: parseFloat(t.bid1Price),
          ask: parseFloat(t.ask1Price),
        });
      }
      return map;
    } catch (err) {
      console.error('[bybit] Error fetching all tickers:', err.message);
      return new Map();
    }
  }

  async fetchTickers(pairs) {
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

module.exports = Bybit;
