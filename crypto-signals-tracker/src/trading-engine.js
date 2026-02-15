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
// - Max positions simultanees configurable
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
    this.maxOpenPositions = 20;
    this.maxDailyLossPercent = 10;
    this.killSwitchEnabled = false;
    this.killSwitchActive = false; // true = tout ferme, plus de trades
    this.alertCallback = null; // fonction pour envoyer alertes Telegram
    this.symbolInfoCache = {}; // cache des infos de symboles Binance
    this.tpMonitors = new Map(); // signalId -> { intervalId, tpOrders, processedTPs }
  }

  /**
   * Initialise le trading engine selon le mode configure.
   * Doit etre appele apres le chargement de .env.
   */
  init() {
    this.mode = process.env.TRADING_MODE || 'simulation';
    this.enabled = process.env.ENABLE_AUTO_TRADING === 'true';
    this.maxPositionPercent = parseFloat(process.env.MAX_POSITION_PERCENT || '5');
    this.maxOpenPositions = parseInt(process.env.MAX_OPEN_POSITIONS || '20', 10);
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
      logger.info(`[TRADING] Max positions simultanees: ${this.maxOpenPositions}`);
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
   * Recupere le prix actuel d'un symbole via Binance Futures.
   * @param {string} symbol - Ex: "BTCUSDT"
   * @returns {number} Prix actuel
   */
  async getCurrentPrice(symbol) {
    if (!this.initialized || !this.client) {
      throw new Error('Trading engine non initialise');
    }

    const ticker = await this.client.futuresPrices({ symbol });
    const price = parseFloat(ticker[symbol]);
    if (!price || isNaN(price)) {
      throw new Error(`Prix non disponible pour ${symbol}`);
    }
    return price;
  }

  /**
   * Analyse la position du prix actuel par rapport a la zone d'entree.
   * Determine le type d'ordre optimal a passer.
   *
   * LONG:
   *   - Prix < entryMin (sous la zone) → MARKET (prix favorable)
   *   - Prix entre entryMin et midZone → LIMIT_CURRENT (bonne moitie)
   *   - Prix entre midZone et entryMax → LIMIT_MID (moitie haute, limit au milieu)
   *   - Prix > entryMax → SKIP (prix a depasse la zone)
   *
   * SHORT:
   *   - Prix > entryMax (au-dessus de la zone) → MARKET (prix favorable)
   *   - Prix entre midZone et entryMax → LIMIT_CURRENT (bonne moitie)
   *   - Prix entre entryMin et midZone → LIMIT_MID (moitie basse, limit au milieu)
   *   - Prix < entryMin → SKIP (prix a depasse la zone)
   *
   * @param {number} currentPrice - Prix actuel du marche
   * @param {number} entryMin - Borne inferieure de la zone d'entree
   * @param {number} entryMax - Borne superieure de la zone d'entree
   * @param {string} direction - "LONG" ou "SHORT"
   * @returns {{ action: string, reason: string, limitPrice: number|null }}
   */
  analyzePricePosition(currentPrice, entryMin, entryMax, direction) {
    const midZone = (entryMin + entryMax) / 2;

    if (direction === 'LONG') {
      if (currentPrice < entryMin) {
        return {
          action: 'MARKET',
          reason: `Prix ${currentPrice} sous la zone (< ${entryMin}) - favorable`,
          limitPrice: null,
        };
      }
      if (currentPrice >= entryMin && currentPrice <= midZone) {
        return {
          action: 'LIMIT_CURRENT',
          reason: `Prix ${currentPrice} dans la bonne moitie [${entryMin}-${midZone}]`,
          limitPrice: currentPrice,
        };
      }
      if (currentPrice > midZone && currentPrice <= entryMax) {
        return {
          action: 'LIMIT_MID',
          reason: `Prix ${currentPrice} dans moitie haute [${midZone}-${entryMax}], limit au milieu`,
          limitPrice: midZone,
        };
      }
      // currentPrice > entryMax
      return {
        action: 'SKIP',
        reason: `Prix ${currentPrice} au-dessus de la zone (> ${entryMax}) - rate`,
        limitPrice: null,
      };
    }

    // SHORT
    if (currentPrice > entryMax) {
      return {
        action: 'MARKET',
        reason: `Prix ${currentPrice} au-dessus de la zone (> ${entryMax}) - favorable`,
        limitPrice: null,
      };
    }
    if (currentPrice <= entryMax && currentPrice >= midZone) {
      return {
        action: 'LIMIT_CURRENT',
        reason: `Prix ${currentPrice} dans la bonne moitie [${midZone}-${entryMax}]`,
        limitPrice: currentPrice,
      };
    }
    if (currentPrice < midZone && currentPrice >= entryMin) {
      return {
        action: 'LIMIT_MID',
        reason: `Prix ${currentPrice} dans moitie basse [${entryMin}-${midZone}], limit au milieu`,
        limitPrice: midZone,
      };
    }
    // currentPrice < entryMin
    return {
      action: 'SKIP',
      reason: `Prix ${currentPrice} sous la zone (< ${entryMin}) - rate`,
      limitPrice: null,
    };
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

    // Max positions simultanees - verifier BINANCE ET BDD (prendre le max)
    let openCount = 0;
    try {
      const openBinance = await this.syncPositions();
      const openDb = database.countOpenPositions();
      openCount = Math.max(openBinance.length, openDb);
      logger.info(`[TRADING]   Positions: Binance=${openBinance.length} | DB=${openDb} | Max=${this.maxOpenPositions}`);

      if (openCount >= this.maxOpenPositions) {
        reasons.push(`Limite positions atteinte (${openCount}/${this.maxOpenPositions})`);
        logger.warn(`[TRADING]   LIMITE ATTEINTE: ${openCount}/${this.maxOpenPositions}`);
      }
    } catch (err) {
      // Fallback: verifier au moins la BDD
      try {
        const openDb = database.countOpenPositions();
        openCount = openDb;
        if (openDb >= this.maxOpenPositions) {
          reasons.push(`Limite positions atteinte (DB=${openDb}/${this.maxOpenPositions})`);
        }
        logger.info(`[TRADING]   Positions (DB uniquement): ${openDb}/${this.maxOpenPositions}`);
      } catch (e) {
        logger.warn(`[TRADING]   Impossible de verifier positions ouvertes: ${err.message}`);
      }
    }

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

      // Alerte specifique si limite de positions atteinte
      if (openCount >= this.maxOpenPositions) {
        await this.sendAlert(
          `LIMITE POSITIONS ATTEINTE\n` +
          `${openCount}/${this.maxOpenPositions} positions ouvertes\n` +
          `Signal ${signal.pair} ${signal.direction} ignore\n` +
          `Fermez des positions avant d'en ouvrir`
        );
      }
    }

    return { valid: reasons.length === 0, reasons };
  }

  /**
   * Ouvre une position en analysant le prix actuel par rapport a la zone d'entree.
   * Choisit automatiquement MARKET, LIMIT ou SKIP selon la position du prix.
   * Mesure le temps de reaction (ms) entre reception du signal et passage de l'ordre.
   *
   * @param {Object} signal - Signal parse (pair, direction, leverage, entryPriceMin, entryPriceMax, targets, stopLoss)
   * @param {number} signalId - ID du signal en BDD
   * @param {number} [signalReceivedAt] - Timestamp ms de reception du signal (Date.now())
   * @returns {Object|null} Ordre Binance ou null
   */
  async openPosition(signal, signalId, signalReceivedAt) {
    const startTime = signalReceivedAt || Date.now();
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

      // 4. Recuperer le prix actuel et analyser la position
      logger.info(`[TRADING] Etape 4: Analyse du prix actuel...`);
      const currentPrice = await this.getCurrentPrice(symbol);
      const analysis = this.analyzePricePosition(
        currentPrice, signal.entryPriceMin, signal.entryPriceMax, signal.direction
      );
      logger.info(`[TRADING] Prix actuel ${symbol}: ${currentPrice} | Action: ${analysis.action} | ${analysis.reason}`);

      // Stocker le prix au moment du signal
      database.updateSignalReactionInfo(signalId, { priceAtSignal: currentPrice });

      // SKIP : prix hors zone, on ne trade pas
      if (analysis.action === 'SKIP') {
        logger.warn(`[TRADING] SKIP ${signal.pair}: ${analysis.reason}`);
        const reactionTimeMs = Date.now() - startTime;
        database.updateSignalReactionInfo(signalId, {
          reactionTimeMs,
          orderType: 'SKIP',
        });
        await this.sendAlert(
          `SIGNAL IGNORE (prix hors zone)\n` +
          `${signal.pair} ${signal.direction}\n` +
          `${analysis.reason}\n` +
          `Temps de reaction: ${reactionTimeMs}ms`
        );
        return null;
      }

      // Determiner le prix d'entree selon l'analyse
      let entryPrice;
      let orderType;
      if (analysis.action === 'MARKET') {
        entryPrice = currentPrice;
        orderType = 'MARKET';
      } else if (analysis.action === 'LIMIT_CURRENT') {
        entryPrice = currentPrice;
        orderType = 'LIMIT';
      } else {
        // LIMIT_MID
        entryPrice = analysis.limitPrice;
        orderType = 'LIMIT';
      }

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
          if (fallback >= leverage) continue;
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
      logger.info(`[TRADING]   Type d'ordre: ${orderType} (${analysis.action})`);
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

      // 7. Passer l'ordre
      logger.info(`[TRADING] Etape 7: Passage de l'ordre ${orderType}...`);
      const side = signal.direction === 'LONG' ? 'BUY' : 'SELL';

      let orderParams;
      if (orderType === 'MARKET') {
        orderParams = {
          symbol,
          side,
          type: 'MARKET',
          quantity: quantity.toString(),
        };
      } else {
        orderParams = {
          symbol,
          side,
          type: 'LIMIT',
          quantity: quantity.toString(),
          price: roundedPrice.toString(),
          timeInForce: 'GTC',
        };
      }

      const order = await this.client.futuresOrder(orderParams);

      // 8. Mesurer le temps de reaction
      const reactionTimeMs = Date.now() - startTime;

      logger.info(`[TRADING] ORDRE OUVERT: ${symbol} ${side} ${orderType} X${leverage}`);
      logger.info(`[TRADING]   Quantite: ${quantity} | Prix: ${roundedPrice}`);
      logger.info(`[TRADING]   Order ID: ${order.orderId}`);
      logger.info(`[TRADING]   Position: ${positionSize.toFixed(2)}$ (${this.maxPositionPercent}% de ${balance.toFixed(2)}$)`);
      logger.info(`[TRADING]   Temps de reaction: ${reactionTimeMs}ms`);

      // 9. Stocker l'order ID et les infos de reaction en BDD
      database.updateSignalBinanceOrder(signalId, {
        binanceOrderId: order.orderId.toString(),
        entryPriceReal: entryPrice,
      });
      database.updateSignalReactionInfo(signalId, {
        reactionTimeMs,
        orderType: `${orderType}_${analysis.action}`,
      });

      // 10. Alertes Telegram
      let alertMsg =
        `POSITION OUVERTE\n` +
        `${signal.pair} ${signal.direction} X${leverage}\n` +
        `Prix entree: ${roundedPrice}$ (${orderType})\n` +
        `Taille: ${positionSize.toFixed(2)}$\n` +
        `Order ID: ${order.orderId}\n` +
        `Reaction: ${reactionTimeMs}ms`;

      // Alerte latence
      if (reactionTimeMs > 10000) {
        alertMsg += `\n\nLATENCE CRITIQUE: ${(reactionTimeMs / 1000).toFixed(1)}s`;
      } else if (reactionTimeMs > 5000) {
        alertMsg += `\n\nLatence elevee: ${(reactionTimeMs / 1000).toFixed(1)}s`;
      }

      await this.sendAlert(alertMsg);

      return order;

    } catch (err) {
      const reactionTimeMs = Date.now() - startTime;
      logger.error(`[TRADING] Erreur ouverture ${signal.pair}: ${err.message} (apres ${reactionTimeMs}ms)`);
      database.updateSignalReactionInfo(signalId, {
        reactionTimeMs,
        orderType: 'ERROR',
      });
      await this.sendAlert(
        `ERREUR OUVERTURE\n` +
        `${signal.pair} ${signal.direction}\n` +
        `Erreur: ${err.message}\n` +
        `Reaction: ${reactionTimeMs}ms`
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

      // PAS de Stop Loss initial - gere par trailing stop apres TP1
      logger.info(`[TRADING] Pas de SL initial - sera gere apres TP1 (trailing strategy)`);

      // Stocker les TP order IDs en BDD et demarrer le monitoring
      if (tpOrders.length > 0) {
        const tpOrderInfo = tpOrders.map((o, idx) => ({
          orderId: o.orderId,
          targetNum: idx + 1,
          targetPrice: targets[idx],
        }));

        database.updateTrailingInfo(signalId, {
          tpOrderIds: JSON.stringify(tpOrderInfo),
        });

        this.monitorTakeProfit(signalId, tpOrderInfo);
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

    // Desactiver le trailing stop si actif
    if (signal.id) {
      database.updateTrailingInfo(signal.id, {
        trailingActive: 0,
      });
      // Nettoyer le monitoring
      const monitorId = this.tpMonitors.get(signal.id);
      if (monitorId) {
        clearInterval(monitorId);
        this.tpMonitors.delete(signal.id);
      }
    }

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
        : reason === 'group_stop_loss' ? 'STOP LOSS (Signal groupe)'
        : reason === 'trailing_stop' ? 'TRAILING STOP'
        : reason === 'kill_switch' ? 'KILL SWITCH'
        : 'FERMETURE MANUELLE';

      logger.info(`[TRADING] ${reasonText}: ${symbol} ferme (qty=${closeQty})`);
      logger.info(`[TRADING]   P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}$`);

      const pnlSign = pnl >= 0 ? '+' : '';
      const emoji = reason === 'stop_loss' ? 'STOP LOSS'
        : reason === 'group_stop_loss' ? 'STOP LOSS (Signal groupe)'
        : reason === 'trailing_stop' ? 'TRAILING STOP'
        : reason === 'kill_switch' ? 'KILL SWITCH'
        : 'FERMETURE MANUELLE';
      await this.sendAlert(
        `${emoji}\n` +
        `${signal.pair} ${signal.direction} X${signal.leverage}\n` +
        `100% ferme\n` +
        `${pnl >= 0 ? 'Profit' : 'Perte'}: ${pnlSign}${pnl.toFixed(2)}$`
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
   * Met a jour la BDD et envoie une alerte detaillee.
   * @returns {{ closed: number, errors: number, dbUpdated: number }}
   */
  async emergencyCloseAll() {
    if (!this.initialized || !this.client) {
      logger.warn('[TRADING] Kill switch: engine non initialise');
      return { closed: 0, errors: 0, dbUpdated: 0 };
    }

    logger.error('==================================================');
    logger.error('[TRADING] KILL SWITCH ACTIVE - FERMETURE DE TOUTES LES POSITIONS');
    logger.error('==================================================');
    this.killSwitchActive = true;

    let closed = 0;
    let errors = 0;
    const errorDetails = [];

    try {
      // 1. Recuperer toutes les positions Binance
      const positions = await this.syncPositions();
      logger.error(`[TRADING] KILL: ${positions.length} position(s) a fermer sur Binance`);

      // 2. Fermer chaque position
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
          errorDetails.push(`${pos.symbol}: ${err.message}`);
          errors++;
        }
      }

      // 3. CRITIQUE : Mettre a jour TOUS les trades en base
      const dbResult = database.bulkCloseOpenSignals('killed');
      logger.error(`[TRADING] KILL: Base de donnees: ${dbResult.changes} trades marques "killed"`);

      // 4. Arreter tous les TP monitors
      for (const [signalId, intervalId] of this.tpMonitors) {
        clearInterval(intervalId);
      }
      this.tpMonitors.clear();
      logger.info(`[TRADING] KILL: Tous les TP monitors arretes`);

      // 5. Verification finale
      let remainingBinance = 0;
      try {
        const remaining = await this.syncPositions();
        remainingBinance = remaining.length;
      } catch (e) { /* ignore */ }

      const remainingDb = database.countOpenPositions();

      // 6. Alerte detaillee
      let alertMsg = `KILL SWITCH EXECUTE\n\n` +
        `Binance:\n` +
        `  Fermees: ${closed}/${positions.length}\n` +
        `  Restantes: ${remainingBinance}\n\n` +
        `Base de donnees:\n` +
        `  Mises a jour: ${dbResult.changes} trades\n` +
        `  Restantes: ${remainingDb}`;

      if (errorDetails.length > 0) {
        alertMsg += `\n\nErreurs (${errorDetails.length}):\n` +
          errorDetails.slice(0, 5).join('\n');
      }

      if (remainingBinance > 0 || remainingDb > 0) {
        alertMsg += `\n\nATTENTION: Verifiez manuellement Binance!`;
      }

      await this.sendAlert(alertMsg);

      logger.error('==================================================');
      logger.error(`[TRADING] KILL SWITCH TERMINE`);
      logger.error(`  ${closed} positions fermees sur Binance`);
      logger.error(`  ${dbResult.changes} trades mis a jour en DB`);
      logger.error('==================================================');

      return { closed, errors, dbUpdated: dbResult.changes };

    } catch (err) {
      logger.error(`[TRADING] ERREUR CRITIQUE KILL SWITCH: ${err.message}`);

      // Tenter quand meme la mise a jour DB
      try {
        const dbResult = database.bulkCloseOpenSignals('killed');
        logger.error(`[TRADING] DB mise a jour en fallback: ${dbResult.changes} trades`);
      } catch (e) {
        logger.error(`[TRADING] IMPOSSIBLE de mettre a jour la DB: ${e.message}`);
      }

      await this.sendAlert(
        `ERREUR KILL SWITCH\n` +
        `${err.message}\n` +
        `VERIFIEZ MANUELLEMENT BINANCE IMMEDIATEMENT`
      );

      return { closed, errors, dbUpdated: 0 };
    }
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

  // ============================================================
  // TRAILING STOP - MONITORING DES TPs
  // ============================================================

  /**
   * Demarre le monitoring des ordres TP pour un signal.
   * Verifie toutes les 15s si un TP a ete rempli.
   * @param {number} signalId - ID du signal en BDD
   * @param {Array} tpOrders - [{ orderId, targetNum, targetPrice }]
   */
  monitorTakeProfit(signalId, tpOrders) {
    const processedTPs = new Set();

    const intervalId = setInterval(async () => {
      try {
        const signal = database.getSignalById(signalId);
        if (!signal || ['closed', 'stopped', 'cancelled', 'manual_close'].includes(signal.status)) {
          clearInterval(intervalId);
          this.tpMonitors.delete(signalId);
          logger.info(`[TP-MONITOR] Monitoring arrete pour signal #${signalId} (status=${signal?.status})`);
          return;
        }

        const symbol = signal.pair.replace('/', '');

        for (const tp of tpOrders) {
          if (processedTPs.has(tp.targetNum)) continue;

          try {
            const order = await this.client.futuresGetOrder({
              symbol,
              orderId: tp.orderId,
            });

            if (order.status === 'FILLED') {
              processedTPs.add(tp.targetNum);
              const fillPrice = parseFloat(order.avgPrice || order.price);
              logger.info(`[TP-MONITOR] TP${tp.targetNum} REMPLI pour ${signal.pair} a ${fillPrice}`);
              await this.handleTPFilled(signalId, tp.targetNum, fillPrice);
            }
          } catch (err) {
            logger.debug(`[TP-MONITOR] Erreur check TP${tp.targetNum}: ${err.message}`);
          }
        }

        // Verifier si la position est fermee
        const positions = await this.client.futuresPositionRisk({ symbol });
        const pos = positions.find(p => p.symbol === symbol);
        const posQty = Math.abs(parseFloat(pos?.positionAmt || '0'));

        if (posQty === 0) {
          clearInterval(intervalId);
          this.tpMonitors.delete(signalId);
          logger.info(`[TP-MONITOR] Position fermee pour ${symbol}, monitoring arrete`);
        }
      } catch (err) {
        logger.error(`[TP-MONITOR] Erreur monitoring signal #${signalId}: ${err.message}`);
      }
    }, 15000);

    this.tpMonitors.set(signalId, intervalId);
    logger.info(`[TP-MONITOR] Monitoring demarre pour signal #${signalId} (${tpOrders.length} TPs)`);
  }

  /**
   * Traite un TP rempli selon la strategie pyramidale avec trailing.
   * TP1 → SL au TP1 - 0.5% (break-even)
   * TP2 → Trailing stop -1.5%
   * TP3 → Trailing reserre -1%
   * TP4+ → Trailing tres serre -0.75%
   *
   * @param {number} signalId - ID du signal
   * @param {number} tpNum - Numero du TP (1-5)
   * @param {number} exitPrice - Prix de remplissage
   */
  async handleTPFilled(signalId, tpNum, exitPrice) {
    const signal = database.getSignalById(signalId);
    if (!signal) return;

    const percentClosed = PYRAMID_CONFIG[tpNum] || 15;

    // Calculer le profit pour ce TP
    const entryPrice = signal.entry_price_real || signal.entry_price_min;
    let profitPercent;
    if (signal.direction === 'LONG') {
      profitPercent = ((exitPrice - entryPrice) / entryPrice) * 100;
    } else {
      profitPercent = ((entryPrice - exitPrice) / entryPrice) * 100;
    }
    const profitDollar = (signal.position_size_initial || 0) * (percentClosed / 100) * (profitPercent * signal.leverage / 100);

    // Enregistrer l'execution pyramidale
    database.insertTradeExecution({
      signalId,
      targetNumber: tpNum,
      targetPrice: exitPrice,
      positionClosedPercent: percentClosed,
      positionClosedSize: (signal.position_size_initial || 0) * (percentClosed / 100),
      profitRealized: profitDollar,
      profitRealizedPercent: profitPercent * signal.leverage,
      executionType: 'tp_auto',
    });

    // Mettre a jour l'etat pyramidal
    const currentRemaining = signal.position_remaining_percent || 100;
    const newRemaining = currentRemaining - percentClosed;
    const newRealizedTotal = (signal.profit_realized_total || 0) + profitDollar;

    database.updateSignalPyramidState(signalId, {
      positionRemainingPercent: newRemaining,
      positionRemainingSize: (signal.position_size_initial || 0) * (newRemaining / 100),
      profitRealizedTotal: newRealizedTotal,
      profitLatent: 0,
      pnlTotal: newRealizedTotal,
      status: newRemaining <= 0 ? 'closed' : 'partial',
    });

    // Mettre a jour last_target_hit
    try {
      const db = require('./database');
      // Use raw update since there's no dedicated function for this
    } catch (e) { /* ignore */ }

    // STRATEGIE TRAILING SELON TP
    if (tpNum === 1) {
      // TP1 → SL au TP1 - 0.5% (break-even garanti)
      const slPrice = signal.direction === 'SHORT'
        ? exitPrice * 1.005
        : exitPrice * 0.995;

      database.updateTrailingInfo(signalId, {
        currentSlPrice: slPrice,
        slType: 'break_even',
      });

      // Placer le STOP_MARKET sur Binance
      await this.cancelAndPlaceNewSL(signal, slPrice);

      logger.info(`[TP-STRATEGY] TP1 ${signal.pair}: SL break-even a ${slPrice.toFixed(6)}`);

      await this.sendAlert(
        `TP1 ATTEINT\n` +
        `${signal.pair} ${signal.direction} X${signal.leverage}\n` +
        `${percentClosed}% ferme a ${exitPrice.toFixed(6)}$\n` +
        `Profit realise: +${profitDollar.toFixed(2)}$\n` +
        `SL deplace au break-even: ${slPrice.toFixed(6)}$\n` +
        `Reste: ${newRemaining.toFixed(1)}%`
      );

    } else if (tpNum === 2) {
      // TP2 → Activer trailing -1.5%
      const currentPrice = exitPrice;

      database.updateTrailingInfo(signalId, {
        trailingActive: 1,
        trailingDistancePercent: 1.5,
        slType: 'trailing',
        highestPriceReached: signal.direction === 'LONG' ? currentPrice : undefined,
        lowestPriceReached: signal.direction === 'SHORT' ? currentPrice : undefined,
      });

      // Calculer le SL trailing initial
      const trailingSL = signal.direction === 'LONG'
        ? currentPrice * (1 - 1.5 / 100)
        : currentPrice * (1 + 1.5 / 100);

      database.updateTrailingInfo(signalId, {
        currentSlPrice: trailingSL,
      });

      // Placer le STOP_MARKET initial du trailing
      await this.cancelAndPlaceNewSL(signal, trailingSL);

      logger.info(`[TP-STRATEGY] TP2 ${signal.pair}: trailing -1.5% active`);

      await this.sendAlert(
        `TP2 ATTEINT\n` +
        `${signal.pair} ${signal.direction} X${signal.leverage}\n` +
        `${percentClosed}% ferme a ${exitPrice.toFixed(6)}$\n` +
        `Profit realise: +${profitDollar.toFixed(2)}$\n` +
        `Trailing stop active: -1.5%\n` +
        `Reste: ${newRemaining.toFixed(1)}%`
      );

    } else if (tpNum === 3) {
      // TP3 → Resserrer trailing -1%
      database.updateTrailingInfo(signalId, {
        trailingDistancePercent: 1.0,
      });

      logger.info(`[TP-STRATEGY] TP3 ${signal.pair}: trailing resserre a -1%`);

      await this.sendAlert(
        `TP3 ATTEINT\n` +
        `${signal.pair} ${signal.direction} X${signal.leverage}\n` +
        `${percentClosed}% ferme a ${exitPrice.toFixed(6)}$\n` +
        `Profit realise: +${profitDollar.toFixed(2)}$\n` +
        `Trailing resserre: -1%\n` +
        `Reste: ${newRemaining.toFixed(1)}%`
      );

    } else if (tpNum >= 4) {
      // TP4+ → Trailing tres serre -0.75%
      database.updateTrailingInfo(signalId, {
        trailingDistancePercent: 0.75,
      });

      logger.info(`[TP-STRATEGY] TP${tpNum} ${signal.pair}: trailing tres serre -0.75%`);

      await this.sendAlert(
        `TP${tpNum} ATTEINT\n` +
        `${signal.pair} ${signal.direction} X${signal.leverage}\n` +
        `${percentClosed}% ferme a ${exitPrice.toFixed(6)}$\n` +
        `Profit realise: +${profitDollar.toFixed(2)}$\n` +
        `Trailing tres serre: -0.75%\n` +
        `Reste: ${newRemaining.toFixed(1)}%`
      );
    }
  }

  /**
   * Annule tous les ordres existants et place un nouveau STOP_MARKET.
   * @param {Object} signal - Signal de la BDD
   * @param {number} newPrice - Prix du nouveau stop loss
   */
  async cancelAndPlaceNewSL(signal, newPrice) {
    if (!this.initialized || !this.client) return;

    try {
      const symbol = signal.pair.replace('/', '');
      const symbolInfo = await this.getSymbolInfo(symbol);
      const roundedPrice = this.roundToTickSize(newPrice, symbolInfo.tickSize, symbolInfo.pricePrecision);

      // Annuler SEULEMENT les ordres STOP_MARKET (pas les TP LIMIT)
      try {
        const openOrders = await this.client.futuresOpenOrders({ symbol });
        for (const order of openOrders) {
          if (order.type === 'STOP_MARKET' || order.type === 'STOP') {
            await this.client.futuresCancelOrder({
              symbol,
              orderId: order.orderId,
            });
            logger.debug(`[TRADING] Ancien SL annule: ${order.orderId}`);
          }
        }
      } catch (err) {
        logger.debug(`[TRADING] Pas de SL a annuler sur ${symbol}`);
      }

      // Verifier qu'il reste une position
      const positions = await this.client.futuresPositionRisk({ symbol });
      const pos = positions.find(p => p.symbol === symbol);
      const posQty = Math.abs(parseFloat(pos?.positionAmt || '0'));

      if (posQty > 0) {
        const slSide = signal.direction === 'LONG' ? 'SELL' : 'BUY';

        await this.client.futuresOrder({
          symbol,
          side: slSide,
          type: 'STOP_MARKET',
          stopPrice: roundedPrice.toString(),
          closePosition: 'true',
        });

        logger.info(`[TRADING] Nouveau SL place: ${symbol} @ ${roundedPrice}`);
      }
    } catch (err) {
      logger.error(`[TRADING] Erreur placement SL ${signal.pair}: ${err.message}`);
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
      maxOpenPositions: this.maxOpenPositions,
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
