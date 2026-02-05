const config = require('../config');

/**
 * Detect simple (cross-exchange) arbitrage opportunities.
 *
 * For each pair, compare the best ask (buy) on one exchange
 * against the best bid (sell) on another exchange.
 *
 * @param {Map<string, Map<string, {bid: number, ask: number}>>} tickersByExchange
 *   Map of exchangeName -> Map of pair -> { bid, ask }
 * @returns {Array} list of opportunities
 */
function detectSimpleArbitrage(tickersByExchange) {
  const opportunities = [];
  const exchangeNames = [...tickersByExchange.keys()];

  // Collect all pairs across exchanges
  const allPairs = new Set();
  for (const tickers of tickersByExchange.values()) {
    for (const pair of tickers.keys()) {
      allPairs.add(pair);
    }
  }

  for (const pair of allPairs) {
    // Gather prices from all exchanges that have this pair
    const prices = [];
    for (const exName of exchangeNames) {
      const tickers = tickersByExchange.get(exName);
      if (tickers.has(pair)) {
        const { bid, ask } = tickers.get(pair);
        if (bid > 0 && ask > 0) {
          prices.push({ exchange: exName, bid, ask });
        }
      }
    }

    // Compare every pair of exchanges
    for (let i = 0; i < prices.length; i++) {
      for (let j = 0; j < prices.length; j++) {
        if (i === j) continue;

        const buyExchange = prices[i];   // Buy here (lowest ask)
        const sellExchange = prices[j];   // Sell here (highest bid)

        if (sellExchange.bid <= buyExchange.ask) continue;

        const buyFee = config.fees[buyExchange.exchange] / 100;
        const sellFee = config.fees[sellExchange.exchange] / 100;

        // Net profit: sell price * (1 - sellFee) - buy price * (1 + buyFee)
        const buyTotal = buyExchange.ask * (1 + buyFee);
        const sellTotal = sellExchange.bid * (1 - sellFee);
        const profitPercent = ((sellTotal - buyTotal) / buyTotal) * 100;

        if (profitPercent > 0) {
          opportunities.push({
            type: 'simple',
            pair,
            buyExchange: buyExchange.exchange,
            sellExchange: sellExchange.exchange,
            buyPrice: buyExchange.ask,
            sellPrice: sellExchange.bid,
            buyFeePercent: config.fees[buyExchange.exchange],
            sellFeePercent: config.fees[sellExchange.exchange],
            grossProfitPercent: ((sellExchange.bid - buyExchange.ask) / buyExchange.ask) * 100,
            netProfitPercent: profitPercent,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }
  }

  // Sort by net profit descending
  opportunities.sort((a, b) => b.netProfitPercent - a.netProfitPercent);
  return opportunities;
}

module.exports = { detectSimpleArbitrage };
