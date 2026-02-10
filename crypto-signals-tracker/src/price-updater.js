// ============================================================
// price-updater.js - Mise a jour des prix en temps reel
// ============================================================
// Met a jour les prix actuels et le P&L latent de toutes
// les positions ouvertes toutes les 60 secondes via l'API Binance.
// ============================================================

const database = require('./database');
const binanceClient = require('./binance-client');
const logger = require('./logger');

const SAFETY_MARGIN_GAINS = 0.85;
const SAFETY_MARGIN_LOSSES = 1.15;
const UPDATE_INTERVAL = 60000; // 60 secondes

let timer = null;
let isRunning = false;

/**
 * Demarre le price updater (mise a jour toutes les 60s).
 */
function start() {
  if (isRunning) return;
  isRunning = true;
  logger.info('[PRICE-UPDATER] Demarre (mise a jour toutes les 60s)');
  // Premier update immediat
  update();
  // Puis toutes les 60s
  timer = setInterval(update, UPDATE_INTERVAL);
  timer.unref(); // Ne pas bloquer l'arret du process
}

/**
 * Arrete le price updater.
 */
function stop() {
  isRunning = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  logger.info('[PRICE-UPDATER] Arrete');
}

/**
 * Met a jour les prix de toutes les positions ouvertes.
 */
async function update() {
  if (!binanceClient.isReady()) return;

  try {
    const openTrades = database.getOpenTrades();

    if (openTrades.length === 0) {
      return;
    }

    logger.debug(`[PRICE-UPDATER] Mise a jour de ${openTrades.length} position(s)`);

    for (const trade of openTrades) {
      try {
        const symbol = binanceClient.normalizeSymbol(trade.pair);
        const currentPrice = await binanceClient.getCurrentPrice(symbol);

        if (!currentPrice) {
          logger.warn(`[PRICE-UPDATER] Prix non disponible pour ${symbol}`);
          continue;
        }

        // Calculer P&L latent sur la position restante
        const remainingSize = trade.position_remaining_size || trade.position_size_initial || 0;
        if (remainingSize <= 0) continue;

        const entryPrice = trade.entry_price_real;
        if (!entryPrice) {
          // Pas de prix d'entree reel, juste stocker le prix actuel
          database.updateSignalCurrentPrice(trade.id, {
            currentPrice,
            profitLatent: trade.profit_latent || 0,
            pnlTotal: trade.pnl_total || 0,
          });
          continue;
        }

        // Calculer le profit % basé sur le prix reel
        let profitPercent;
        if (trade.direction === 'LONG') {
          profitPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
        } else {
          profitPercent = ((entryPrice - currentPrice) / entryPrice) * 100;
        }

        const leverage = trade.leverage || 1;
        const profitWithLeverage = profitPercent * leverage;

        // Appliquer marge de securite
        const safeProfit = profitWithLeverage >= 0
          ? profitWithLeverage * SAFETY_MARGIN_GAINS
          : profitWithLeverage * SAFETY_MARGIN_LOSSES;

        // Calculer le P&L latent en $
        const profitLatent = remainingSize * (safeProfit / 100);
        const profitRealizedTotal = trade.profit_realized_total || 0;
        const pnlTotal = profitRealizedTotal + profitLatent;

        database.updateSignalCurrentPrice(trade.id, {
          currentPrice,
          profitLatent,
          pnlTotal,
        });

        logger.debug(`[PRICE-UPDATER] ${trade.pair}: $${currentPrice} | Latent: ${profitLatent >= 0 ? '+' : ''}${profitLatent.toFixed(2)}$ | Total: ${pnlTotal >= 0 ? '+' : ''}${pnlTotal.toFixed(2)}$`);
      } catch (err) {
        logger.error(`[PRICE-UPDATER] Erreur ${trade.pair}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[PRICE-UPDATER] Erreur globale: ${err.message}`);
  }
}

/**
 * Retourne le timestamp de la derniere mise a jour.
 * @returns {boolean} true si le updater tourne
 */
function isActive() {
  return isRunning;
}

module.exports = {
  start,
  stop,
  update,
  isActive,
};
