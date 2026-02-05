const BaseExchange = require('./base');

class Coinbase extends BaseExchange {
  constructor() {
    super('coinbase', 'https://api.exchange.coinbase.com');
  }

  _toProductId(pair) {
    // 'BTC/USDT' -> 'BTC-USDT'
    return pair.replace('/', '-');
  }

  async fetchTicker(pair) {
    try {
      const productId = this._toProductId(pair);
      const { data } = await this.client.get(`/products/${productId}/ticker`);
      return {
        bid: parseFloat(data.bid),
        ask: parseFloat(data.ask),
      };
    } catch (err) {
      console.error(`[coinbase] Error fetching ${pair}:`, err.message);
      return null;
    }
  }

  async fetchAllTickers() {
    // Coinbase doesn't have a single bulk ticker endpoint with bid/ask,
    // so we fetch individual tickers for known pairs
    return new Map();
  }
}

module.exports = Coinbase;
