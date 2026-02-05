const config = require('../config');

/**
 * Detect triangular arbitrage within a single exchange.
 *
 * A triangular arbitrage exploits price discrepancies between three pairs
 * on the same exchange. For example: USDT -> BTC -> ETH -> USDT
 *
 * For each triangle defined in config, we check both directions:
 * - Forward:  buy A/B with B, buy C/A with A, sell C/B for B
 * - Reverse:  the opposite direction
 *
 * @param {Map<string, Map<string, {bid: number, ask: number}>>} allTickersByExchange
 *   For triangular, we need the raw symbol-keyed maps from fetchAllTickers()
 * @param {Map<string, Map<string, {bid: number, ask: number}>>} normalizedByExchange
 *   Normalized pair -> ticker for each exchange
 * @returns {Array} list of triangular opportunities
 */
function detectTriangularArbitrage(normalizedByExchange) {
  const opportunities = [];

  for (const triangle of config.triangularPairs) {
    const { exchange, legs } = triangle;
    const tickers = normalizedByExchange.get(exchange);
    if (!tickers) continue;

    const [pair1, pair2, pair3] = legs;
    const t1 = tickers.get(pair1);
    const t2 = tickers.get(pair2);
    const t3 = tickers.get(pair3);

    if (!t1 || !t2 || !t3) continue;

    const fee = config.fees[exchange] / 100;
    const feeMultiplier = 1 - fee;

    // Forward direction: USDT -> BTC -> ETH -> USDT
    // Leg 1: Buy BTC with USDT (pair1 = BTC/USDT, use ask)
    // Leg 2: Buy ETH with BTC (pair2 = ETH/BTC, use ask)
    // Leg 3: Sell ETH for USDT (pair3 = ETH/USDT, use bid)
    //
    // Start with 1 USDT:
    // After leg 1: (1 / ask1) * feeMultiplier  BTC
    // After leg 2: (btc / ask2) * feeMultiplier  ETH
    // After leg 3: (eth * bid3) * feeMultiplier  USDT
    const forward = {
      step1: (1 / t1.ask) * feeMultiplier,
      step2: null,
      step3: null,
    };
    forward.step2 = (forward.step1 / t2.ask) * feeMultiplier;
    forward.step3 = (forward.step2 * t3.bid) * feeMultiplier;
    const forwardProfit = (forward.step3 - 1) * 100;

    if (forwardProfit > 0) {
      opportunities.push({
        type: 'triangular',
        exchange,
        direction: 'forward',
        legs: [
          { pair: pair1, action: 'buy', price: t1.ask },
          { pair: pair2, action: 'buy', price: t2.ask },
          { pair: pair3, action: 'sell', price: t3.bid },
        ],
        feePerLeg: config.fees[exchange],
        totalFeesPercent: config.fees[exchange] * 3,
        netProfitPercent: forwardProfit,
        timestamp: new Date().toISOString(),
      });
    }

    // Reverse direction: USDT -> ETH -> BTC -> USDT
    // Leg 1: Buy ETH with USDT (pair3 = ETH/USDT, use ask)
    // Leg 2: Sell ETH for BTC (pair2 = ETH/BTC, use bid)
    // Leg 3: Sell BTC for USDT (pair1 = BTC/USDT, use bid)
    const reverse = {
      step1: (1 / t3.ask) * feeMultiplier,
      step2: null,
      step3: null,
    };
    reverse.step2 = (reverse.step1 * t2.bid) * feeMultiplier;
    reverse.step3 = (reverse.step2 * t1.bid) * feeMultiplier;
    const reverseProfit = (reverse.step3 - 1) * 100;

    if (reverseProfit > 0) {
      opportunities.push({
        type: 'triangular',
        exchange,
        direction: 'reverse',
        legs: [
          { pair: pair3, action: 'buy', price: t3.ask },
          { pair: pair2, action: 'sell', price: t2.bid },
          { pair: pair1, action: 'sell', price: t1.bid },
        ],
        feePerLeg: config.fees[exchange],
        totalFeesPercent: config.fees[exchange] * 3,
        netProfitPercent: reverseProfit,
        timestamp: new Date().toISOString(),
      });
    }
  }

  opportunities.sort((a, b) => b.netProfitPercent - a.netProfitPercent);
  return opportunities;
}

module.exports = { detectTriangularArbitrage };
