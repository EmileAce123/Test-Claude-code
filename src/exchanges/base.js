const axios = require('axios');

class BaseExchange {
  constructor(name, baseUrl) {
    this.name = name;
    this.baseUrl = baseUrl;
    this.client = axios.create({
      baseURL: baseUrl,
      timeout: 10000,
    });
  }

  /**
   * Fetch ticker price for a normalized pair like 'BTC/USDT'.
   * Must return { bid, ask } or null on failure.
   */
  async fetchTicker(/* pair */) {
    throw new Error(`fetchTicker not implemented for ${this.name}`);
  }

  /**
   * Fetch all tickers at once (used for triangular arbitrage).
   * Returns Map<normalizedPair, { bid, ask }>
   */
  async fetchAllTickers() {
    throw new Error(`fetchAllTickers not implemented for ${this.name}`);
  }

  /**
   * Fetch tickers for a list of pairs. Default: call fetchTicker in parallel.
   */
  async fetchTickers(pairs) {
    const results = new Map();
    const settled = await Promise.allSettled(
      pairs.map(async (pair) => {
        const ticker = await this.fetchTicker(pair);
        if (ticker) results.set(pair, ticker);
      })
    );
    for (const r of settled) {
      if (r.status === 'rejected') {
        console.error(`[${this.name}] ticker fetch error:`, r.reason.message);
      }
    }
    return results;
  }
}

module.exports = BaseExchange;
