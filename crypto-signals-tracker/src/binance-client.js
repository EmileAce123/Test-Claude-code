// ============================================================
// binance-client.js - Client Binance API (lecture seule)
// ============================================================
// Recupere les prix en temps reel et les donnees de marche
// depuis l'API Binance pour calculer les profits reels.
//
// IMPORTANT : Les signaux sont des contrats FUTURES.
// On utilise l'API Futures en priorite, avec fallback sur Spot
// pour les paires qui ne sont pas listees en Futures.
//
// PHASE 1 : Lecture seule (pas de trading)
// PHASE 2 (future) : Auto-trading avec strategie pyramidale
//
// SECURITE : API en READ-ONLY, IP whitelisting recommande
// ============================================================

const Binance = require('binance-api-node').default;
const logger = require('./logger');

class BinanceClient {
  constructor() {
    this.client = null;
    this.initialized = false;
  }

  /**
   * Initialise le client Binance avec les cles API.
   * Appele une seule fois au demarrage de l'application.
   */
  init() {
    const apiKey = process.env.BINANCE_API_KEY;
    const apiSecret = process.env.BINANCE_API_SECRET;

    if (!apiKey || !apiSecret) {
      logger.warn('[BINANCE] Cles API manquantes - fonctionnement en mode fallback (sans prix reels)');
      this.initialized = false;
      return;
    }

    this.client = Binance({
      apiKey,
      apiSecret,
      getTime: () => Date.now(),
    });

    this.initialized = true;
    logger.info('[BINANCE] Client initialise (mode READ-ONLY, Futures + Spot)');
  }

  /**
   * Recupere le prix actuel d'une paire.
   * Essaie d'abord l'API Futures, puis fallback sur Spot.
   * @param {string} symbol - Ex: "BTCUSDT", "ETHUSDT"
   * @returns {number|null} Prix actuel ou null si erreur
   */
  async getCurrentPrice(symbol) {
    if (!this.initialized || !this.client) return null;

    // 1. Essayer Futures d'abord (les signaux sont des contrats futures)
    try {
      const ticker = await this.client.futuresPrices({ symbol });
      const price = parseFloat(ticker[symbol]);
      if (!isNaN(price) && price > 0) {
        logger.debug(`[BINANCE] Prix Futures ${symbol}: ${price}`);
        return price;
      }
    } catch (error) {
      logger.debug(`[BINANCE] Futures indisponible pour ${symbol}: ${error.message}`);
    }

    // 2. Fallback sur Spot
    try {
      const ticker = await this.client.prices({ symbol });
      const price = parseFloat(ticker[symbol]);
      if (!isNaN(price) && price > 0) {
        logger.debug(`[BINANCE] Prix Spot (fallback) ${symbol}: ${price}`);
        return price;
      }
    } catch (error) {
      logger.debug(`[BINANCE] Spot aussi indisponible pour ${symbol}: ${error.message}`);
    }

    logger.warn(`[BINANCE] Prix non disponible pour ${symbol} (ni Futures ni Spot)`);
    return null;
  }

  /**
   * Recupere les bougies (klines) pour calculer l'ATR.
   * Essaie d'abord l'API Futures, puis fallback sur Spot.
   * @param {string} symbol - Ex: "BTCUSDT"
   * @param {string} interval - Ex: "15m", "1h"
   * @param {number} limit - Nombre de bougies (15 pour ATR 14)
   * @returns {Array|null} Bougies ou null si erreur
   */
  async getCandles(symbol, interval = '15m', limit = 15) {
    if (!this.initialized || !this.client) return null;

    const mapCandles = (candles) => candles.map(c => ({
      time: c.closeTime,
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
      volume: parseFloat(c.volume),
    }));

    // 1. Essayer Futures d'abord
    try {
      const candles = await this.client.futuresCandles({ symbol, interval, limit });
      if (candles && candles.length > 0) {
        logger.debug(`[BINANCE] Bougies Futures ${symbol}: ${candles.length} recues`);
        return mapCandles(candles);
      }
    } catch (error) {
      logger.debug(`[BINANCE] Bougies Futures indisponible pour ${symbol}: ${error.message}`);
    }

    // 2. Fallback sur Spot
    try {
      const candles = await this.client.candles({ symbol, interval, limit });
      if (candles && candles.length > 0) {
        logger.debug(`[BINANCE] Bougies Spot (fallback) ${symbol}: ${candles.length} recues`);
        return mapCandles(candles);
      }
    } catch (error) {
      logger.debug(`[BINANCE] Bougies Spot aussi indisponible pour ${symbol}: ${error.message}`);
    }

    logger.warn(`[BINANCE] Bougies non disponibles pour ${symbol} (ni Futures ni Spot)`);
    return null;
  }

  /**
   * Calcule l'ATR (Average True Range) sur 14 periodes.
   * @param {Array} candles - Bougies depuis getCandles()
   * @returns {number|null} ATR ou null si donnees insuffisantes
   */
  calculateATR(candles) {
    if (!candles || candles.length < 2) return null;

    const trueRanges = [];
    for (let i = 1; i < candles.length; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevClose = candles[i - 1].close;

      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trueRanges.push(tr);
    }

    const period = Math.min(trueRanges.length, 14);
    const atr = trueRanges.slice(-period).reduce((a, b) => a + b, 0) / period;
    return atr;
  }

  /**
   * Normalise le symbole : G/USDT -> GUSDT, BTC/USDT -> BTCUSDT
   * @param {string} pair - Paire avec slash
   * @returns {string} Symbole sans slash
   */
  normalizeSymbol(pair) {
    return pair.replace('/', '').toUpperCase();
  }

  /**
   * Teste la connexion a l'API Binance (Futures puis Spot).
   * @returns {boolean} true si connecte
   */
  async testConnection() {
    if (!this.initialized || !this.client) {
      logger.warn('[BINANCE] Client non initialise');
      return false;
    }

    // Tester Futures d'abord
    try {
      await this.client.futuresPing();
      logger.info('[BINANCE] Connexion API Futures OK');
      return true;
    } catch (error) {
      logger.warn(`[BINANCE] Futures ping echoue: ${error.message}`);
    }

    // Fallback: tester Spot
    try {
      await this.client.ping();
      logger.info('[BINANCE] Connexion API Spot OK (Futures indisponible)');
      return true;
    } catch (error) {
      logger.error(`[BINANCE] Erreur connexion (Futures et Spot): ${error.message}`);
      return false;
    }
  }

  /**
   * Verifie si le client est pret a etre utilise.
   * @returns {boolean}
   */
  isReady() {
    return this.initialized && this.client !== null;
  }
}

module.exports = new BinanceClient();
