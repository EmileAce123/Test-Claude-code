// ============================================================
// trading-engine.js - Moteur de trading automatique Binance
// ============================================================
// Gere les ordres reels sur Binance Futures.
// 3 modes : simulation (virtuel), testnet, live
//
// TESTNET : Obligatoire avant live (3-7 jours minimum)
// LIVE    : Trading reel avec argent reel
//
// Securites :
// - Max trades/jour configurable
// - Perte max quotidienne → arret auto
// - Kill switch (ferme tout d'urgence)
// - Validation avant chaque trade
// ============================================================

const Binance = require('binance-api-node').default;
const database = require('./database');
const logger = require('./logger');

// Constantes
const PYRAMID_CONFIG = {
  1: 35,
  2: 22.5,
  3: 17.5,
  4: 10,
  5: 15,
};

class TradingEngine {
  constructor() {
    this.client = null;
    this.mode = 'simulation';
    this.enabled = false;
    this.initialized = false;
    this.maxPositionPercent = 5;
    this.maxDailyTrades = 20;
    this.maxDailyLossPercent = 10;
    this.killSwitchEnabled = false;
    this.killSwitchActive = false; // true = tout ferme, plus de trades
    this.alertCallback = null; // fonction pour envoyer alertes Telegram
    this.symbolInfoCache = {}; // cache des infos de symboles Binance
  }

  /**
   * Initialise le trading engine selon le mode configure.
   * Doit etre appele apres le chargement de .env.
   */
  init() {
    this.mode = process.env.TRADING_MODE || 'simulation';
    this.enabled = process.env.ENABLE_AUTO_TRADING === 'true';
    this.maxPositionPercent = parseFloat(process.env.MAX_POSITION_PERCENT || '5');
    this.maxDailyTrades = parseInt(process.env.MAX_DAILY_TRADES || '20', 10);
    this.maxDailyLossPercent = parseFloat(process.env.MAX_DAILY_LOSS_PERCENT || '10');
    this.killSwitchEnabled = process.env.ENABLE_KILL_SWITCH === 'true';

    if (this.mode === 'testnet') {
      const apiKey = process.env.BINANCE_TESTNET_API_KEY;
      const apiSecret = process.env.BINANCE_TESTNET_API_SECRET;

      if (!apiKey || !apiSecret) {
        logger.error('[TRADING] Mode testnet mais cles API testnet manquantes');
        this.mode = 'simulation';
        return;
      }

      this.client = Binance({
        apiKey,
        apiSecret,
        httpBase: 'https://testnet.binancefuture.com',
        wsBase: 'wss://stream.binancefuture.com',
        httpFutures: 'https://testnet.binancefuture.com',
        getTime: () => Date.now(),
      });

      this.initialized = true;
      logger.info('='.repeat(50));
      logger.info('[TRADING] Mode TESTNET active');
      logger.info(`[TRADING] Auto-trading: ${this.enabled ? 'ACTIVE' : 'DESACTIVE'}`);
      logger.info(`[TRADING] Max position: ${this.maxPositionPercent}% du capital`);
      logger.info(`[TRADING] Max trades/jour: ${this.maxDailyTrades}`);
      logger.info(`[TRADING] Perte max/jour: ${this.maxDailyLossPercent}%`);
      logger.info(`[TRADING] Kill switch: ${this.killSwitchEnabled ? 'ACTIVE' : 'DESACTIVE'}`);
      logger.info('='.repeat(50));

    } else if (this.mode === 'live') {
      const apiKey = process.env.BINANCE_API_KEY;
      const apiSecret = process.env.BINANCE_API_SECRET;

      if (!apiKey || !apiSecret) {
        logger.error('[TRADING] Mode live mais cles API manquantes');
        this.mode = 'simulation';
        return;
      }

      this.client = Binance({
        apiKey,
        apiSecret,
        getTime: () => Date.now(),
      });

      this.initialized = true;
      logger.warn('='.repeat(50));
      logger.warn('[TRADING] MODE LIVE ACTIVE - ARGENT REEL');
      logger.warn(`[TRADING] Auto-trading: ${this.enabled ? 'ACTIVE' : 'DESACTIVE'}`);
      logger.warn(`[TRADING] Max position: ${this.maxPositionPercent}% du capital`);
      logger.warn('='.repeat(50));

    } else {
      logger.info('[TRADING] Mode SIMULATION (pas de trades reels)');
    }
  }

  /**
   * Enregistre un callback pour envoyer des alertes Telegram.
   * @param {Function} callback - async function(message)
   */
  setAlertCallback(callback) {
    this.alertCallback = callback;
  }

  /**
   * Envoie une alerte Telegram via le callback enregistre.
   * @param {string} message - Message a envoyer
   */
  async sendAlert(message) {
    if (this.alertCallback) {
      try {
        await this.alertCallback(message);
      } catch (err) {
        logger.error(`[TRADING] Erreur envoi alerte: ${err.message}`);
      }
    }
  }

  /**
   * Teste la connexion au compte Binance Futures.
   * @returns {boolean} true si connecte
   */
  async testConnection() {
    if (!this.initialized || !this.client) return false;

    try {
      if (this.mode === 'testnet') {
        await this.client.futuresPing();
      } else {
        await this.client.futuresPing();
      }
      logger.info(`[TRADING] Connexion Binance Futures OK (${this.mode})`);
      return true;
    } catch (err) {
      logger.error(`[TRADING] Connexion Binance Futures echouee: ${err.message}`);
      return false;
    }
  }

  /**
   * Recupere le solde USDT disponible sur le compte Futures.
   * @returns {number} Solde disponible en USDT
   */
  async getAccountBalance() {
    if (!this.initialized || !this.client) {
      throw new Error('Trading engine non initialise');
    }

    try {
      const account = await this.client.futuresAccountBalance();
      const usdt = account.find(a => a.asset === 'USDT');
      if (!usdt) {
        throw new Error('Aucun solde USDT trouve');
      }
      const balance = parseFloat(usdt.availableBalance);
      logger.info(`[TRADING] Balance Binance: ${balance.toFixed(2)} USDT`);
      return balance;
    } catch (err) {
      logger.error(`[TRADING] Erreur balance: ${err.message}`);
      throw err;
    }
  }

  /**
   * Recupere les infos du compte Futures (balance, positions, etc.).
   * @returns {Object} Infos du compte
   */
  async getAccountInfo() {
    if (!this.initialized || !this.client) {
      throw new Error('Trading engine non initialise');
    }

    try {
      const account = await this.client.futuresAccountInfo();
      return {
        totalBalance: parseFloat(account.totalWalletBalance),
        availableBalance: parseFloat(account.availableBalance),
        unrealizedPnl: parseFloat(account.totalUnrealizedProfit),
        marginBalance: parseFloat(account.totalMarginBalance),
      };
    } catch (err) {
      logger.error(`[TRADING] Erreur account info: ${err.message}`);
      throw err;
    }
  }

  /**
   * Recupere les infos d'un symbole Binance Futures (avec cache).
   * @param {string} symbol - Ex: "BTCUSDT"
   * @returns {Object} { quantityPrecision, pricePrecision, minQty, maxQty, stepSize, tickSize, maxLeverage }
   */
  async getSymbolInfo(symbol) {
    if (this.symbolInfoCache[symbol]) {
      logger.debug(`[TRADING] symbolInfo ${symbol} depuis cache`);
      return this.symbolInfoCache[symbol];
    }

    const exchangeInfo = await this.client.futuresExchangeInfo();
    const symbolInfo = exchangeInfo.symbols.find(s => s.symbol === symbol);

    if (!symbolInfo) {
      throw new Error(`Symbole ${symbol} non trouve sur Binance Futures`);
    }

    const lotSize = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
    const priceFilter = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');

    const info = {
      symbol,
      quantityPrecision: symbolInfo.quantityPrecision,
      pricePrecision: symbolInfo.pricePrecision,
      minQty: parseFloat(lotSize?.minQty || '0'),
      maxQty: parseFloat(lotSize?.maxQty || '999999'),
      stepSize: parseFloat(lotSize?.stepSize || '0'),
      tickSize: parseFloat(priceFilter?.tickSize || '0'),
    };

    // Cacher pour les appels suivants
    this.symbolInfoCache[symbol] = info;
    logger.info(`[TRADING] symbolInfo ${symbol}: qtyPrec=${info.quantityPrecision}, pricePrec=${info.pricePrecision}, minQty=${info.minQty}, stepSize=${info.stepSize}, tickSize=${info.tickSize}`);

    return info;
  }

  /**
   * Arrondit un nombre selon la precision Binance (arrondi vers le bas).
   * @param {number} value - Valeur brute
   * @param {number} precision - Nombre de decimales
   * @returns {number}
   */
  roundToPrecision(value, precision) {
    const multiplier = Math.pow(10, precision);
    return Math.floor(value * multiplier) / multiplier;
  }

  /**
   * Arrondit un prix au tickSize Binance le plus proche (arrondi vers le bas).
   * Le prix doit etre un multiple exact du tickSize.
   * @param {number} price - Prix brut
   * @param {number} tickSize - Increment minimum de prix
   * @param {number} pricePrecision - Nombre de decimales pour le prix
   * @returns {number}
   */
  roundToTickSize(price, tickSize, pricePrecision) {
    if (tickSize > 0) {
      price = Math.round(price / tickSize) * tickSize;
    }
    // Arrondir a la precision pour eviter les erreurs de virgule flottante
    const multiplier = Math.pow(10, pricePrecision);
    return Math.round(price * multiplier) / multiplier;
  }

  /**
   * Valide qu'un trade peut etre execute (securites).
   * @param {Object} signal - Signal parse
   * @param {number} balance - Balance disponible
   * @returns {{ valid: boolean, reasons: string[] }}
   */
  async validateTrade(signal, balance) {
    logger.info(`[TRADING] validateTrade() pour ${signal.pair} ${signal.direction} (balance=${balance.toFixed(2)}$)`);
    const reasons = [];

    // Kill switch actif
    if (this.killSwitchActive) {
      reasons.push('Kill switch actif');
    }
    logger.debug(`[TRADING]   Kill switch: ${this.killSwitchActive ? 'ACTIF (bloque)' : 'OK'}`);

    // Balance suffisante
    const positionSize = balance * (this.maxPositionPercent / 100);
    if (positionSize < 5) {
      reasons.push(`Balance insuffisante (position=${positionSize.toFixed(2)}$ < 5$)`);
    }
    logger.debug(`[TRADING]   Balance: position=${positionSize.toFixed(2)}$ (${this.maxPositionPercent}% de ${balance.toFixed(2)}$) -> ${positionSize >= 5 ? 'OK' : 'INSUFFISANT'}`);

    // Nombre de trades quotidiens
    const todayCount = database.countTodayTrades();
    if (todayCount >= this.maxDailyTrades) {
      reasons.push(`Limite quotidienne atteinte (${todayCount}/${this.maxDailyTrades})`);
    }
    logger.debug(`[TRADING]   Trades aujourd'hui: ${todayCount}/${this.maxDailyTrades} -> ${todayCount < this.maxDailyTrades ? 'OK' : 'LIMITE'}`);

    // Perte quotidienne max
    const todayPnl = database.getTodayPnl();
    const maxLoss = balance * (this.maxDailyLossPercent / 100);
    if (todayPnl < -maxLoss) {
      reasons.push(`Perte max quotidienne atteinte (${todayPnl.toFixed(2)}$ > -${maxLoss.toFixed(2)}$)`);
    }
    logger.debug(`[TRADING]   PnL aujourd'hui: ${todayPnl.toFixed(2)}$ (max perte: -${maxLoss.toFixed(2)}$) -> ${todayPnl >= -maxLoss ? 'OK' : 'PERTE MAX'}`);


    // Pas de doublon : verifier les positions REELLES sur Binance (pas la BDD)
    try {
      const symbol = signal.pair.replace('/', '');
      const positions = await this.client.futuresPositionRisk({ symbol });
      const openPos = positions.find(p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0);
      if (openPos) {
        const qty = Math.abs(parseFloat(openPos.positionAmt));
        reasons.push(`Position Binance deja ouverte sur ${symbol} (qty=${qty})`);
      }
      logger.debug(`[TRADING] Check doublon Binance ${symbol}: ${openPos ? 'POSITION EXISTANTE' : 'pas de position'}`);
    } catch (err) {
      logger.warn(`[TRADING] Impossible de verifier positions Binance pour doublon: ${err.message}`);
      // En cas d'erreur, on ne bloque PAS le trade (fail-open pour le doublon uniquement)
    }

    if (reasons.length > 0) {
      logger.warn(`[TRADING] Trade refuse: ${reasons.join(', ')}`);
    }

    return { valid: reasons.length === 0, reasons };
  }

  /**
   * Ouvre une position avec un ordre LIMIT dans la zone d'entree.
   * @param {Object} signal - Signal parse (pair, direction, leverage, entryPriceMin, entryPriceMax, targets, stopLoss)
   * @param {number} signalId - ID du signal en BDD
   * @returns {Object|null} Ordre Binance ou null
   */
  async openPosition(signal, signalId) {
    logger.info(`[TRADING] === openPosition() appele pour ${signal.pair} ${signal.direction} (signalId=${signalId}) ===`);

    if (!this.enabled || !this.initialized || !this.client) {
      logger.info(`[TRADING] Trade ignore (mode=${this.mode}, enabled=${this.enabled}, initialized=${this.initialized})`);
      return null;
    }

    try {
      // 1. Verifier capital disponible
      logger.info(`[TRADING] Etape 1: Verification du capital...`);
      const balance = await this.getAccountBalance();
      logger.info(`[TRADING] Balance disponible: ${balance.toFixed(2)} USDT`);

      // 2. Valider le trade (verification Binance, pas BDD)
      logger.info(`[TRADING] Etape 2: Validation du trade...`);
      const validation = await this.validateTrade(signal, balance);
      if (!validation.valid) {
        logger.warn(`[TRADING] Trade REFUSE pour ${signal.pair}: ${validation.reasons.join(', ')}`);
        await this.sendAlert(
          `[TRADING] Trade refuse: ${signal.pair} ${signal.direction}\n` +
          `Raisons: ${validation.reasons.join(', ')}`
        );
        return null;
      }
      logger.info(`[TRADING] Validation OK pour ${signal.pair}`);

      const positionSize = balance * (this.maxPositionPercent / 100);
      const symbol = signal.pair.replace('/', '');
      let leverage = signal.leverage || 10;

      // 3. Recuperer les infos du symbole (precision, leverage max, etc.)
      logger.info(`[TRADING] Etape 3: Recuperation des infos symbole ${symbol}...`);
      const symbolInfo = await this.getSymbolInfo(symbol);

      // 4. Prix d'entree = milieu de zone
      const entryPrice = (signal.entryPriceMin + signal.entryPriceMax) / 2;

      // 5. Definir le leverage sur Binance (avec auto-ajustement)
      logger.info(`[TRADING] Etape 5: Configuration leverage ${leverage}x sur ${symbol}...`);
      try {
        await this.client.futuresLeverage({
          symbol,
          leverage,
        });
        logger.info(`[TRADING] Leverage ${symbol} = ${leverage}x`);
      } catch (err) {
        // Si le leverage demande n'est pas supporte, essayer des valeurs plus basses
        logger.warn(`[TRADING] Leverage ${leverage}x refuse pour ${symbol}: ${err.message}`);
        const fallbackLeverages = [20, 10, 5, 3, 2, 1];
        let leverageSet = false;
        for (const fallback of fallbackLeverages) {
          if (fallback >= leverage) continue; // Skip ceux >= au leverage refuse
          try {
            await this.client.futuresLeverage({ symbol, leverage: fallback });
            leverage = fallback;
            logger.info(`[TRADING] Leverage ajuste a ${leverage}x pour ${symbol}`);
            leverageSet = true;
            break;
          } catch (e) {
            logger.debug(`[TRADING] Leverage ${fallback}x aussi refuse pour ${symbol}`);
          }
        }
        if (!leverageSet) {
          logger.error(`[TRADING] Impossible de configurer le leverage pour ${symbol}`);
          throw new Error(`Aucun leverage valide pour ${symbol}`);
        }
      }

      // 6. Calculer quantite avec la bonne precision
      const notional = positionSize * leverage;
      let quantity = notional / entryPrice;

      // Arrondir selon stepSize si disponible
      if (symbolInfo.stepSize > 0) {
        quantity = Math.floor(quantity / symbolInfo.stepSize) * symbolInfo.stepSize;
      }
      // Arrondir selon la precision
      quantity = this.roundToPrecision(quantity, symbolInfo.quantityPrecision);
      const roundedPrice = this.roundToTickSize(entryPrice, symbolInfo.tickSize, symbolInfo.pricePrecision);

      logger.info(`[TRADING] Etape 6: Calcul -> position=${positionSize.toFixed(2)}$, leverage=${leverage}x, notional=${notional.toFixed(2)}$`);
      logger.info(`[TRADING]   Prix: brut=${entryPrice} -> arrondi=${roundedPrice} (precision=${symbolInfo.pricePrecision}, tickSize=${symbolInfo.tickSize})`);
      logger.info(`[TRADING]   Quantite: brute=${notional / entryPrice} -> arrondie=${quantity} (precision=${symbolInfo.quantityPrecision}, stepSize=${symbolInfo.stepSize})`);

      // Verifier min/max qty
      if (quantity < symbolInfo.minQty) {
        throw new Error(`Quantite ${quantity} < minimum ${symbolInfo.minQty} pour ${symbol}`);
      }
      if (quantity > symbolInfo.maxQty) {
        throw new Error(`Quantite ${quantity} > maximum ${symbolInfo.maxQty} pour ${symbol}`);
      }
      if (quantity <= 0) {
        throw new Error(`Quantite calculee = 0 pour ${symbol} (position trop petite)`);
      }

      // 7. Passer l'ordre LIMIT
      logger.info(`[TRADING] Etape 7: Passage de l'ordre LIMIT...`);
      const side = signal.direction === 'LONG' ? 'BUY' : 'SELL';

      const order = await this.client.futuresOrder({
        symbol,
        side,
        type: 'LIMIT',
        quantity: quantity.toString(),
        price: roundedPrice.toString(),
        timeInForce: 'GTC',
      });

      logger.info(`[TRADING] ORDRE OUVERT: ${symbol} ${side} X${leverage}`);
      logger.info(`[TRADING]   Quantite: ${quantity} | Prix: ${roundedPrice}`);
      logger.info(`[TRADING]   Order ID: ${order.orderId}`);
      logger.info(`[TRADING]   Position: ${positionSize.toFixed(2)}$ (${this.maxPositionPercent}% de ${balance.toFixed(2)}$)`);

      // 8. Stocker l'order ID en BDD
      database.updateSignalBinanceOrder(signalId, {
        binanceOrderId: order.orderId.toString(),
        entryPriceReal: entryPrice,
      });

      // 9. Alerte Telegram
      await this.sendAlert(
        `ORDRE OUVERT\n` +
        `${signal.pair} ${signal.direction} X${leverage}\n` +
        `Entree: ${roundedPrice}$\n` +
        `Quantite: ${quantity}\n` +
        `Position: ${positionSize.toFixed(2)}$ (${this.maxPositionPercent}% capital)\n` +
        `Balance restante: ${(balance - positionSize).toFixed(2)}$\n` +
        `Mode: ${this.mode.toUpperCase()}`
      );

      return order;

    } catch (err) {
      logger.error(`[TRADING] Erreur ouverture ${signal.pair}: ${err.message}`);
      await this.sendAlert(
        `ERREUR OUVERTURE\n` +
        `${signal.pair} ${signal.direction}\n` +
        `Erreur: ${err.message}`
      );
      return null;
    }
  }

  /**
   * Place les ordres Take-Profit pyramidaux apres remplissage.
   * @param {Object} signal - Signal avec targets (prix)
   * @param {number} signalId - ID du signal en BDD
   */
  async placeTakeProfitOrders(signal, signalId) {
    if (!this.initialized || !this.client) return;

    try {
      const symbol = signal.pair.replace('/', '');
      const targets = typeof signal.targets === 'string'
        ? JSON.parse(signal.targets)
        : signal.targets;

      // Recuperer les infos du symbole pour la precision
      const symbolInfo = await this.getSymbolInfo(symbol);

      // Recuperer la position ouverte
      const positions = await this.client.futuresPositionRisk({ symbol });
      const pos = positions.find(p => p.symbol === symbol);
      const posQty = Math.abs(parseFloat(pos?.positionAmt || '0'));

      if (posQty === 0) {
        logger.warn(`[TRADING] Aucune position ouverte sur ${symbol}, TPs non places`);
        return;
      }

      const tpSide = signal.direction === 'LONG' ? 'SELL' : 'BUY';
      const tpOrders = [];

      for (let i = 0; i < Math.min(targets.length, 5); i++) {
        const targetNum = i + 1;
        const targetPrice = targets[i];
        const percentToClose = PYRAMID_CONFIG[targetNum] || 15;
        let qtyToClose = posQty * (percentToClose / 100);

        // Arrondir selon stepSize et precision
        if (symbolInfo.stepSize > 0) {
          qtyToClose = Math.floor(qtyToClose / symbolInfo.stepSize) * symbolInfo.stepSize;
        }
        qtyToClose = this.roundToPrecision(qtyToClose, symbolInfo.quantityPrecision);
        const roundedPrice = this.roundToTickSize(targetPrice, symbolInfo.tickSize, symbolInfo.pricePrecision);

        logger.info(`[TRADING] TP${targetNum}: prix brut=${targetPrice} -> tickSize=${roundedPrice} (tickSize=${symbolInfo.tickSize})`);

        if (qtyToClose < symbolInfo.minQty) {
          logger.warn(`[TRADING] TP${targetNum} quantite ${qtyToClose} < min ${symbolInfo.minQty}, skip`);
          continue;
        }

        try {
          const tpOrder = await this.client.futuresOrder({
            symbol,
            side: tpSide,
            type: 'LIMIT',
            quantity: qtyToClose.toString(),
            price: roundedPrice.toString(),
            timeInForce: 'GTC',
            reduceOnly: 'true',
          });

          tpOrders.push(tpOrder);
          logger.info(`[TRADING] TP${targetNum} place: ${percentToClose}% (${qtyToClose}) a ${roundedPrice}`);
        } catch (err) {
          logger.error(`[TRADING] Erreur TP${targetNum} ${symbol}: ${err.message}`);
        }
      }

      logger.info(`[TRADING] ${tpOrders.length}/${Math.min(targets.length, 5)} Take-Profits places sur ${symbol}`);

      // Placer le Stop Loss
      if (signal.stopLoss && signal.stopLoss > 0) {
        try {
          const slSide = signal.direction === 'LONG' ? 'SELL' : 'BUY';
          const roundedSLPrice = this.roundToTickSize(signal.stopLoss, symbolInfo.tickSize, symbolInfo.pricePrecision);

          await this.client.futuresOrder({
            symbol,
            side: slSide,
            type: 'STOP_MARKET',
            stopPrice: roundedSLPrice.toString(),
            closePosition: 'true',
          });

          logger.info(`[TRADING] Stop Loss place a ${roundedSLPrice}`);
        } catch (err) {
          logger.error(`[TRADING] Erreur SL ${symbol}: ${err.message}`);
        }
      }

    } catch (err) {
      logger.error(`[TRADING] Erreur placement TPs: ${err.message}`);
    }
  }

  /**
   * Place un Stop Loss pour une position ouverte.
   * @param {string} symbol - Ex: "BTCUSDT"
   * @param {string} direction - "LONG" ou "SHORT"
   * @param {number} stopPrice - Prix du stop loss
   */
  async placeStopLoss(symbol, direction, stopPrice) {
    if (!this.initialized || !this.client) return;

    try {
      const symbolInfo = await this.getSymbolInfo(symbol);
      const slSide = direction === 'LONG' ? 'SELL' : 'BUY';
      const roundedPrice = this.roundToTickSize(stopPrice, symbolInfo.tickSize, symbolInfo.pricePrecision);

      await this.client.futuresOrder({
        symbol,
        side: slSide,
        type: 'STOP_MARKET',
        stopPrice: roundedPrice.toString(),
        closePosition: 'true',
      });

      logger.info(`[TRADING] SL place sur ${symbol}: ${roundedPrice}`);
    } catch (err) {
      logger.error(`[TRADING] Erreur SL ${symbol}: ${err.message}`);
    }
  }

  /**
   * Ferme une position (stop loss ou fermeture manuelle).
   * @param {Object} signal - Signal de la BDD
   * @param {string} reason - 'stop_loss' | 'manual' | 'kill_switch'
   * @returns {Object|null} Ordre de fermeture
   */
  async closePosition(signal, reason = 'manual') {
    if (!this.initialized || !this.client) return null;

    try {
      const symbol = signal.pair.replace('/', '');

      // Annuler tous les ordres en attente
      try {
        await this.client.futuresCancelAllOpenOrders({ symbol });
        logger.info(`[TRADING] Ordres en attente annules sur ${symbol}`);
      } catch (err) {
        logger.debug(`[TRADING] Pas d'ordres a annuler sur ${symbol}: ${err.message}`);
      }

      // Recuperer la position
      const positions = await this.client.futuresPositionRisk({ symbol });
      const pos = positions.find(p => p.symbol === symbol);
      const posQty = Math.abs(parseFloat(pos?.positionAmt || '0'));

      if (posQty === 0) {
        logger.warn(`[TRADING] Aucune position a fermer sur ${symbol}`);
        return null;
      }

      const symbolInfo = await this.getSymbolInfo(symbol);
      const closeSide = signal.direction === 'LONG' ? 'SELL' : 'BUY';
      let closeQty = posQty;
      if (symbolInfo.stepSize > 0) {
        closeQty = Math.floor(closeQty / symbolInfo.stepSize) * symbolInfo.stepSize;
      }
      closeQty = this.roundToPrecision(closeQty, symbolInfo.quantityPrecision);

      const closeOrder = await this.client.futuresOrder({
        symbol,
        side: closeSide,
        type: 'MARKET',
        quantity: closeQty.toString(),
        reduceOnly: 'true',
      });

      const pnl = parseFloat(pos.unRealizedProfit || '0');

      const reasonText = reason === 'stop_loss' ? 'STOP LOSS'
        : reason === 'kill_switch' ? 'KILL SWITCH'
        : 'FERMETURE MANUELLE';

      logger.info(`[TRADING] ${reasonText}: ${symbol} ferme (qty=${closeQty})`);
      logger.info(`[TRADING]   P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}$`);

      await this.sendAlert(
        `${reasonText}\n` +
        `${signal.pair} ${signal.direction} X${signal.leverage}\n` +
        `100% ferme\n` +
        `P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}$`
      );

      return closeOrder;

    } catch (err) {
      logger.error(`[TRADING] Erreur fermeture ${signal.pair}: ${err.message}`);
      return null;
    }
  }

  /**
   * Synchronise les positions ouvertes depuis Binance Futures.
   * @returns {Array} Liste des positions ouvertes
   */
  async syncPositions() {
    if (!this.initialized || !this.client) return [];

    try {
      const positions = await this.client.futuresPositionRisk();
      const openPositions = positions.filter(p =>
        Math.abs(parseFloat(p.positionAmt)) > 0
      );

      logger.debug(`[TRADING] ${openPositions.length} position(s) ouverte(s) sur Binance`);

      return openPositions.map(p => ({
        symbol: p.symbol,
        side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
        quantity: Math.abs(parseFloat(p.positionAmt)),
        entryPrice: parseFloat(p.entryPrice),
        currentPrice: parseFloat(p.markPrice),
        leverage: parseInt(p.leverage, 10),
        unrealizedPnl: parseFloat(p.unRealizedProfit),
        liquidationPrice: parseFloat(p.liquidationPrice),
        marginType: p.marginType,
      }));

    } catch (err) {
      logger.error(`[TRADING] Erreur sync positions: ${err.message}`);
      return [];
    }
  }

  /**
   * Kill switch : ferme TOUTES les positions d'urgence.
   * @returns {{ closed: number, errors: number }}
   */
  async emergencyCloseAll() {
    if (!this.initialized || !this.client) {
      logger.warn('[TRADING] Kill switch: engine non initialise');
      return { closed: 0, errors: 0 };
    }

    logger.error('[TRADING] KILL SWITCH ACTIVE - FERMETURE DE TOUTES LES POSITIONS');
    this.killSwitchActive = true;

    let closed = 0;
    let errors = 0;

    try {
      const positions = await this.syncPositions();

      for (const pos of positions) {
        try {
          // Annuler tous les ordres en attente
          await this.client.futuresCancelAllOpenOrders({ symbol: pos.symbol });

          // Fermer la position en MARKET
          const closeSide = pos.side === 'LONG' ? 'SELL' : 'BUY';
          let closeQty = pos.quantity;
          try {
            const symInfo = await this.getSymbolInfo(pos.symbol);
            if (symInfo.stepSize > 0) {
              closeQty = Math.floor(closeQty / symInfo.stepSize) * symInfo.stepSize;
            }
            closeQty = this.roundToPrecision(closeQty, symInfo.quantityPrecision);
          } catch (e) {
            // Fallback: garder la quantite brute
            logger.warn(`[TRADING] KILL: Impossible de recuperer precision ${pos.symbol}, utilisation quantite brute`);
          }

          await this.client.futuresOrder({
            symbol: pos.symbol,
            side: closeSide,
            type: 'MARKET',
            quantity: closeQty.toString(),
            reduceOnly: 'true',
          });

          logger.info(`[TRADING] KILL: ${pos.symbol} ferme (P&L: ${pos.unrealizedPnl.toFixed(2)}$)`);
          closed++;
        } catch (err) {
          logger.error(`[TRADING] KILL erreur ${pos.symbol}: ${err.message}`);
          errors++;
        }
      }

      await this.sendAlert(
        `KILL SWITCH ACTIVE\n` +
        `${closed} position(s) fermee(s)\n` +
        `${errors} erreur(s)\n` +
        `Verifiez votre compte Binance`
      );

    } catch (err) {
      logger.error(`[TRADING] Erreur kill switch: ${err.message}`);
    }

    return { closed, errors };
  }

  /**
   * Verifie si un ordre a ete rempli.
   * @param {string} symbol - Ex: "BTCUSDT"
   * @param {string} orderId - ID de l'ordre Binance
   * @returns {boolean} true si rempli
   */
  async isOrderFilled(symbol, orderId) {
    if (!this.initialized || !this.client) return false;

    try {
      const order = await this.client.futuresGetOrder({ symbol, orderId });
      return order.status === 'FILLED';
    } catch (err) {
      logger.error(`[TRADING] Erreur check ordre ${orderId}: ${err.message}`);
      return false;
    }
  }

  // formatQuantity et formatPrice ont ete remplaces par getSymbolInfo() + roundToPrecision()
  // qui utilisent les donnees reelles de precision depuis Binance API

  /**
   * Retourne l'etat actuel du trading engine.
   * @returns {Object}
   */
  getStatus() {
    return {
      mode: this.mode,
      enabled: this.enabled,
      initialized: this.initialized,
      killSwitchActive: this.killSwitchActive,
      killSwitchEnabled: this.killSwitchEnabled,
      maxPositionPercent: this.maxPositionPercent,
      maxDailyTrades: this.maxDailyTrades,
      maxDailyLossPercent: this.maxDailyLossPercent,
    };
  }

  /**
   * Reactive le trading apres un kill switch.
   */
  resetKillSwitch() {
    this.killSwitchActive = false;
    logger.info('[TRADING] Kill switch desactive');
  }

  /**
   * Verifie si le trading engine est actif (pas simulation).
   * @returns {boolean}
   */
  isActive() {
    return this.initialized && this.enabled && this.mode !== 'simulation';
  }
}

module.exports = new TradingEngine();
