// ============================================================
// binance-client.js - Client Binance API (lecture seule)
// ============================================================
// Recupere les prix en temps reel et les donnees de marche
// depuis l'API Binance pour calculer les profits reels.
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
    logger.info('[BINANCE] Client initialise (mode READ-ONLY)');
  }

  /**
   * Recupere le prix actuel d'une paire.
   * @param {string} symbol - Ex: "BTCUSDT", "ETHUSDT"
   * @returns {number|null} Prix actuel ou null si erreur
   */
  async getCurrentPrice(symbol) {
    if (!this.initialized || !this.client) return null;

    try {
      const ticker = await this.client.prices({ symbol });
      const price = parseFloat(ticker[symbol]);
      if (isNaN(price)) {
        logger.warn(`[BINANCE] Prix invalide pour ${symbol}`);
        return null;
      }
      logger.info(`[BINANCE] Prix ${symbol}: ${price}`);
      return price;
    } catch (error) {
      logger.error(`[BINANCE] Erreur prix ${symbol}: ${error.message}`);
      return null;
    }
  }

  /**
   * Recupere les bougies (klines) pour calculer l'ATR.
   * @param {string} symbol - Ex: "BTCUSDT"
   * @param {string} interval - Ex: "15m", "1h"
   * @param {number} limit - Nombre de bougies (15 pour ATR 14)
   * @returns {Array|null} Bougies ou null si erreur
   */
  async getCandles(symbol, interval = '15m', limit = 15) {
    if (!this.initialized || !this.client) return null;

    try {
      const candles = await this.client.candles({ symbol, interval, limit });
      return candles.map(c => ({
        time: c.closeTime,
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
        volume: parseFloat(c.volume),
      }));
    } catch (error) {
      logger.error(`[BINANCE] Erreur bougies ${symbol}: ${error.message}`);
      return null;
    }
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
   * Teste la connexion a l'API Binance.
   * @returns {boolean} true si connecte
   */
  async testConnection() {
    if (!this.initialized || !this.client) {
      logger.warn('[BINANCE] Client non initialise');
      return false;
    }

    try {
      await this.client.ping();
      logger.info('[BINANCE] Connexion API OK');
      return true;
    } catch (error) {
      logger.error(`[BINANCE] Erreur connexion: ${error.message}`);
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
