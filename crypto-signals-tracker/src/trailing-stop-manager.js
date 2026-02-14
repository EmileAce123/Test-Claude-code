// ============================================================
// trailing-stop-manager.js - Gestion des trailing stops
// ============================================================
// Module autonome qui verifie toutes les 10s les positions
// avec trailing stop actif et ajuste le SL dynamiquement.
//
// Comportement :
// - LONG : suit le plus haut prix atteint, SL = highest * (1 - distance%)
// - SHORT : suit le plus bas prix atteint, SL = lowest * (1 + distance%)
// - Si le prix croise le SL trailing → fermeture MARKET immediate
// ============================================================

const database = require('./database');
const logger = require('./logger');

class TrailingStopManager {
  /**
   * @param {Object} tradingEngine - Instance du trading engine
   */
  constructor(tradingEngine) {
    this.tradingEngine = tradingEngine;
    this.updateInterval = 10000; // Verifier toutes les 10s
    this.isRunning = false;
    this.timerId = null;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info('[TRAILING] Trailing Stop Manager demarre (check toutes les 10s)');
    this._scheduleCheck();
  }

  stop() {
    this.isRunning = false;
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    logger.info('[TRAILING] Trailing Stop Manager arrete');
  }

  _scheduleCheck() {
    if (!this.isRunning) return;
    this.timerId = setTimeout(async () => {
      await this._checkTrailingStops();
      this._scheduleCheck();
    }, this.updateInterval);
  }

  async _checkTrailingStops() {
    try {
      const trades = database.getTrailingActivePositions();
      if (trades.length === 0) return;

      for (const trade of trades) {
        await this._updateTrailingStop(trade);
      }
    } catch (error) {
      logger.error(`[TRAILING] Erreur check trailing stops: ${error.message}`);
    }
  }

  async _updateTrailingStop(trade) {
    try {
      const symbol = trade.pair.replace('/', '');
      let currentPrice;
      try {
        currentPrice = await this.tradingEngine.getCurrentPrice(symbol);
      } catch (err) {
        logger.debug(`[TRAILING] Prix indisponible pour ${symbol}: ${err.message}`);
        return;
      }

      if (!currentPrice) return;

      const trailingDistance = trade.trailing_distance_percent;
      if (!trailingDistance || trailingDistance <= 0) return;

      if (trade.direction === 'SHORT') {
        await this._handleShortTrailing(trade, currentPrice, trailingDistance);
      } else {
        await this._handleLongTrailing(trade, currentPrice, trailingDistance);
      }
    } catch (error) {
      logger.error(`[TRAILING] Erreur update ${trade.pair}: ${error.message}`);
    }
  }

  async _handleLongTrailing(trade, currentPrice, trailingDistance) {
    let highestPrice = trade.highest_price_reached || currentPrice;

    // Nouveau plus haut ?
    if (currentPrice > highestPrice) {
      highestPrice = currentPrice;
      const newSL = highestPrice * (1 - trailingDistance / 100);

      logger.info(`[TRAILING] ${trade.pair} LONG: nouveau haut ${currentPrice} -> SL ${newSL.toFixed(6)}`);

      database.updateTrailingInfo(trade.id, {
        highestPriceReached: highestPrice,
        currentSlPrice: newSL,
      });

      // Mettre a jour le STOP_MARKET sur Binance
      await this._updateBinanceSL(trade, newSL);
      trade.current_sl_price = newSL;
      trade.highest_price_reached = highestPrice;
    }

    // SL touche ?
    if (trade.current_sl_price && currentPrice <= trade.current_sl_price) {
      logger.warn(`[TRAILING] ${trade.pair} LONG: SL touche! ${currentPrice} <= ${trade.current_sl_price}`);
      await this._executeTrailingClose(trade, currentPrice);
    }
  }

  async _handleShortTrailing(trade, currentPrice, trailingDistance) {
    let lowestPrice = trade.lowest_price_reached || currentPrice;

    // Nouveau plus bas ?
    if (currentPrice < lowestPrice) {
      lowestPrice = currentPrice;
      const newSL = lowestPrice * (1 + trailingDistance / 100);

      logger.info(`[TRAILING] ${trade.pair} SHORT: nouveau bas ${currentPrice} -> SL ${newSL.toFixed(6)}`);

      database.updateTrailingInfo(trade.id, {
        lowestPriceReached: lowestPrice,
        currentSlPrice: newSL,
      });

      // Mettre a jour le STOP_MARKET sur Binance
      await this._updateBinanceSL(trade, newSL);
      trade.current_sl_price = newSL;
      trade.lowest_price_reached = lowestPrice;
    }

    // SL touche ?
    if (trade.current_sl_price && currentPrice >= trade.current_sl_price) {
      logger.warn(`[TRAILING] ${trade.pair} SHORT: SL touche! ${currentPrice} >= ${trade.current_sl_price}`);
      await this._executeTrailingClose(trade, currentPrice);
    }
  }

  /**
   * Met a jour le STOP_MARKET sur Binance pour le trailing SL.
   */
  async _updateBinanceSL(trade, newPrice) {
    try {
      const symbol = trade.pair.replace('/', '');
      const symbolInfo = await this.tradingEngine.getSymbolInfo(symbol);
      const roundedPrice = this.tradingEngine.roundToTickSize(
        newPrice, symbolInfo.tickSize, symbolInfo.pricePrecision
      );

      // Annuler les anciens ordres SL
      try {
        await this.tradingEngine.client.futuresCancelAllOpenOrders({ symbol });
      } catch (err) {
        logger.debug(`[TRAILING] Pas d'ordres a annuler sur ${symbol}`);
      }

      // Verifier qu'il reste une position
      const positions = await this.tradingEngine.client.futuresPositionRisk({ symbol });
      const pos = positions.find(p => p.symbol === symbol);
      const posQty = Math.abs(parseFloat(pos?.positionAmt || '0'));

      if (posQty > 0) {
        const slSide = trade.direction === 'LONG' ? 'SELL' : 'BUY';

        await this.tradingEngine.client.futuresOrder({
          symbol,
          side: slSide,
          type: 'STOP_MARKET',
          stopPrice: roundedPrice.toString(),
          closePosition: 'true',
        });

        logger.info(`[TRAILING] STOP_MARKET place: ${symbol} @ ${roundedPrice}`);
      }
    } catch (err) {
      logger.error(`[TRAILING] Erreur update Binance SL ${trade.pair}: ${err.message}`);
    }
  }

  /**
   * Execute la fermeture quand le trailing SL est touche.
   */
  async _executeTrailingClose(trade, exitPrice) {
    logger.warn(`[TRAILING] Fermeture trailing stop: ${trade.pair} ${trade.direction}`);

    // Desactiver le trailing
    database.updateTrailingInfo(trade.id, {
      trailingActive: 0,
    });

    // Fermer la position
    await this.tradingEngine.closePosition(trade, 'trailing_stop');

    // Calculer P&L final
    const pnlRealized = trade.profit_realized_total || 0;

    await this.tradingEngine.sendAlert(
      `TRAILING STOP\n` +
      `${trade.pair} ${trade.direction} X${trade.leverage}\n` +
      `Prix sortie: ${exitPrice.toFixed(6)}$\n` +
      `P&L realise: ${pnlRealized >= 0 ? '+' : ''}${pnlRealized.toFixed(2)}$\n` +
      `Raison: Trailing stop touche`
    );
  }
}

module.exports = TrailingStopManager;
