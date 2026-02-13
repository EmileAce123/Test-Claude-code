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
      const leverage = signal.leverage || 10;

      // 3. Prix d'entree = milieu de zone
      const entryPrice = (signal.entryPriceMin + signal.entryPriceMax) / 2;

      // 4. Quantite selon leverage
      const notional = positionSize * leverage;
      const quantity = notional / entryPrice;

      logger.info(`[TRADING] Etape 3-4: Calcul position -> taille=${positionSize.toFixed(2)}$, entry=${entryPrice}, qty=${quantity}, notional=${notional.toFixed(2)}$`);

      // 5. Definir le leverage sur Binance
      logger.info(`[TRADING] Etape 5: Configuration leverage ${leverage}x sur ${symbol}...`);
      try {
        await this.client.futuresLeverage({
          symbol,
          leverage,
        });
        logger.info(`[TRADING] Leverage ${symbol} = ${leverage}x`);
      } catch (err) {
        logger.warn(`[TRADING] Erreur leverage ${symbol}: ${err.message}`);
      }

      // 6. Passer l'ordre LIMIT
      logger.info(`[TRADING] Etape 6: Passage de l'ordre LIMIT...`);
      const side = signal.direction === 'LONG' ? 'BUY' : 'SELL';

      // Formater quantite et prix selon les regles Binance
      const formattedQty = this.formatQuantity(quantity, symbol);
      const formattedPrice = this.formatPrice(entryPrice, symbol);

      const order = await this.client.futuresOrder({
        symbol,
        side,
        type: 'LIMIT',
        quantity: formattedQty,
        price: formattedPrice,
        timeInForce: 'GTC',
      });

      logger.info(`[TRADING] ORDRE OUVERT: ${symbol} ${side} X${leverage}`);
      logger.info(`[TRADING]   Quantite: ${formattedQty} | Prix: ${formattedPrice}`);
      logger.info(`[TRADING]   Order ID: ${order.orderId}`);
      logger.info(`[TRADING]   Position: ${positionSize.toFixed(2)}$ (${this.maxPositionPercent}% de ${balance.toFixed(2)}$)`);

      // 7. Stocker l'order ID en BDD
      database.updateSignalBinanceOrder(signalId, {
        binanceOrderId: order.orderId.toString(),
        entryPriceReal: entryPrice,
      });

      // 8. Alerte Telegram
      await this.sendAlert(
        `ORDRE OUVERT\n` +
        `${signal.pair} ${signal.direction} X${leverage}\n` +
        `Entree: ${formattedPrice}$\n` +
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
        const qtyToClose = posQty * (percentToClose / 100);

        const formattedQty = this.formatQuantity(qtyToClose, symbol);
        const formattedPrice = this.formatPrice(targetPrice, symbol);

        try {
          const tpOrder = await this.client.futuresOrder({
            symbol,
            side: tpSide,
            type: 'LIMIT',
            quantity: formattedQty,
            price: formattedPrice,
            timeInForce: 'GTC',
            reduceOnly: 'true',
          });

          tpOrders.push(tpOrder);
          logger.info(`[TRADING] TP${targetNum} place: ${percentToClose}% (${formattedQty}) a ${formattedPrice}`);
        } catch (err) {
          logger.error(`[TRADING] Erreur TP${targetNum} ${symbol}: ${err.message}`);
        }
      }

      logger.info(`[TRADING] ${tpOrders.length}/${Math.min(targets.length, 5)} Take-Profits places sur ${symbol}`);

      // Placer le Stop Loss
      if (signal.stopLoss && signal.stopLoss > 0) {
        try {
          const slSide = signal.direction === 'LONG' ? 'SELL' : 'BUY';
          const formattedSLPrice = this.formatPrice(signal.stopLoss, symbol);

          await this.client.futuresOrder({
            symbol,
            side: slSide,
            type: 'STOP_MARKET',
            stopPrice: formattedSLPrice,
            closePosition: 'true',
          });

          logger.info(`[TRADING] Stop Loss place a ${formattedSLPrice}`);
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
      const slSide = direction === 'LONG' ? 'SELL' : 'BUY';
      const formattedPrice = this.formatPrice(stopPrice, symbol);

      await this.client.futuresOrder({
        symbol,
        side: slSide,
        type: 'STOP_MARKET',
        stopPrice: formattedPrice,
        closePosition: 'true',
      });

      logger.info(`[TRADING] SL place sur ${symbol}: ${formattedPrice}`);
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

      const closeSide = signal.direction === 'LONG' ? 'SELL' : 'BUY';
      const formattedQty = this.formatQuantity(posQty, symbol);

      const closeOrder = await this.client.futuresOrder({
        symbol,
        side: closeSide,
        type: 'MARKET',
        quantity: formattedQty,
        reduceOnly: 'true',
      });

      const pnl = parseFloat(pos.unRealizedProfit || '0');

      const reasonText = reason === 'stop_loss' ? 'STOP LOSS'
        : reason === 'kill_switch' ? 'KILL SWITCH'
        : 'FERMETURE MANUELLE';

      logger.info(`[TRADING] ${reasonText}: ${symbol} ferme (qty=${formattedQty})`);
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
          const formattedQty = this.formatQuantity(pos.quantity, pos.symbol);

          await this.client.futuresOrder({
            symbol: pos.symbol,
            side: closeSide,
            type: 'MARKET',
            quantity: formattedQty,
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

  /**
   * Formate une quantite selon les regles de precision Binance.
   * @param {number} qty - Quantite brute
   * @param {string} symbol - Symbole (pour adapter la precision)
   * @returns {string} Quantite formatee
   */
  formatQuantity(qty, symbol) {
    // Pour la plupart des paires Futures, 3 decimales suffisent
    // Les paires BTC ont besoin de plus de precision
    if (symbol.startsWith('BTC')) {
      return qty.toFixed(3);
    }
    if (qty >= 1) {
      return qty.toFixed(1);
    }
    return qty.toFixed(0) === '0' ? qty.toPrecision(3) : qty.toFixed(2);
  }

  /**
   * Formate un prix selon les regles de precision Binance.
   * @param {number} price - Prix brut
   * @param {string} symbol - Symbole
   * @returns {string} Prix formate
   */
  formatPrice(price, symbol) {
    if (price >= 10000) return price.toFixed(1);
    if (price >= 100) return price.toFixed(2);
    if (price >= 1) return price.toFixed(4);
    if (price >= 0.01) return price.toFixed(6);
    return price.toFixed(8);
  }

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
