const Binance = require('./binance');
const Coinbase = require('./coinbase');
const Kraken = require('./kraken');
const Bybit = require('./bybit');

function createExchanges() {
  return [new Binance(), new Coinbase(), new Kraken(), new Bybit()];
}

module.exports = { createExchanges, Binance, Coinbase, Kraken, Bybit };
