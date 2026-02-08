// ============================================================
// signal-parser.js - Parsing des messages de signaux de trading
// ============================================================
// Ce module analyse le texte des messages Telegram pour en
// extraire les données structurées des signaux de trading.
//
// Types de messages reconnus :
// 1. Nouveau signal (#SIGNAL)
// 2. Confirmation de target (Take-Profit target X)
// 3. Annulation manuelle (Manually Cancelled)
// 4. Entrée en zone (Entered entry zone)
// 5. Stop loss touché (Stop loss)
// ============================================================

const logger = require('./logger');

/**
 * Analyse un message Telegram et retourne les données structurées.
 * Détecte automatiquement le type de message.
 *
 * @param {Object} message - Message Telegram { id, text, date }
 * @returns {Object|null} Données parsées ou null si message non reconnu
 *
 * Retour possible :
 * - { type: 'signal', ... }        pour un nouveau signal
 * - { type: 'confirmation', ... }  pour un target atteint
 * - { type: 'cancellation', ... }  pour une annulation
 * - { type: 'entry_zone', ... }    pour une entrée en zone
 * - { type: 'stop_loss', ... }     pour un stop loss touché
 * - null                           pour un message non reconnu
 */
function parseMessage(message) {
  const text = message.text.trim();

  // ---- Essayer de parser chaque type de message ----

  // 1. Nouveau signal de trading
  const signal = parseSignal(text, message.id, message.date);
  if (signal) return signal;

  // 2. Confirmation de target atteint
  const confirmation = parseConfirmation(text, message.id, message.date);
  if (confirmation) return confirmation;

  // 3. Annulation manuelle
  const cancellation = parseCancellation(text, message.id, message.date);
  if (cancellation) return cancellation;

  // 4. Stop loss touché
  const stopLoss = parseStopLoss(text, message.id, message.date);
  if (stopLoss) return stopLoss;

  // 5. Entrée en zone de prix
  const entryZone = parseEntryZone(text, message.id, message.date);
  if (entryZone) return entryZone;

  // Message non reconnu -> on l'ignore
  logger.debug(`Message non reconnu (ignoré) : ${text.substring(0, 80)}...`);
  return null;
}

// ============================================================
// PARSEURS SPÉCIALISÉS
// ============================================================

/**
 * Parse un nouveau signal de trading.
 *
 * Format attendu :
 * #SIGNAL (POL/USDT) @CryptoKlondike
 * 🔑 Open SHORT at price between $0.0989 - $0.1 with X25 leverage.
 * 🍒 Targets:
 * 1️⃣ Close the order at the price $0.09811
 * ... (jusqu'à 5 targets)
 * ❗ STOP LOSS: $0.10327
 *
 * @param {string} text - Texte du message
 * @param {number} messageId - ID du message Telegram
 * @param {Date} date - Date du message
 * @returns {Object|null} Signal parsé ou null
 */
function parseSignal(text, messageId, date) {
  // Vérifier que c'est un signal (commence par #SIGNAL)
  if (!text.includes('#SIGNAL')) return null;

  try {
    // Extraire la paire de trading (ex: POL/USDT)
    const pairMatch = text.match(/#SIGNAL\s*\(([A-Z0-9]+\/[A-Z0-9]+)\)/i);
    if (!pairMatch) {
      logger.warn(`Signal détecté mais paire non trouvée : ${text.substring(0, 100)}`);
      return null;
    }
    const pair = pairMatch[1].toUpperCase();

    // Extraire l'émetteur (ex: @CryptoKlondike)
    const emitterMatch = text.match(/@([A-Za-z0-9_]+)/);
    const emitter = emitterMatch ? `@${emitterMatch[1]}` : null;

    // Extraire la direction (SHORT ou LONG)
    const directionMatch = text.match(/Open\s+(SHORT|LONG)/i);
    if (!directionMatch) {
      logger.warn(`Signal ${pair} : direction non trouvée`);
      return null;
    }
    const direction = directionMatch[1].toUpperCase();

    // Extraire les prix d'entrée min et max (ex: $0.0989 - $0.1)
    const priceMatch = text.match(/price\s+between\s+\$?([\d.]+)\s*-\s*\$?([\d.]+)/i);
    if (!priceMatch) {
      logger.warn(`Signal ${pair} : prix d'entrée non trouvés`);
      return null;
    }
    const entryPriceMin = parseFloat(priceMatch[1]);
    const entryPriceMax = parseFloat(priceMatch[2]);

    // Extraire le leverage (formats: X25, x25, 25x, leverage 25, leverage X25)
    let leverage = 1;
    const leveragePatterns = [
      /X(\d+)\s+leverage/i,       // X25 leverage
      /leverage\s+X?(\d+)/i,      // leverage 25, leverage X25
      /(\d+)[xX]\s+leverage/i,    // 25x leverage
      /with\s+X(\d+)/i,           // with X25
      /[xX](\d+)/i,               // X25 n'importe ou
      /(\d+)[xX]/i,               // 25x n'importe ou
    ];
    for (const pattern of leveragePatterns) {
      const match = text.match(pattern);
      if (match) {
        leverage = parseInt(match[1], 10);
        break;
      }
    }
    if (leverage <= 0) leverage = 1;
    if (leverage === 1) {
      logger.warn(`Signal ${pair} : leverage non trouvé, defaut X1 (spot)`);
    }

    // Extraire les targets (prix de clôture)
    // Cherche tous les prix après "Close the order at the price"
    const targetMatches = text.matchAll(/Close the order at the price\s+\$?([\d.]+)/gi);
    const targets = [];
    for (const match of targetMatches) {
      targets.push(parseFloat(match[1]));
    }

    if (targets.length === 0) {
      logger.warn(`Signal ${pair} : aucun target trouvé`);
      return null;
    }

    // Extraire le stop loss
    const slMatch = text.match(/STOP\s+LOSS:\s*\$?([\d.]+)/i);
    if (!slMatch) {
      logger.warn(`Signal ${pair} : stop loss non trouvé`);
      return null;
    }
    const stopLoss = parseFloat(slMatch[1]);

    // Construire l'objet signal complet
    const signal = {
      type: 'signal',
      telegramMessageId: messageId,
      pair,
      direction,
      entryPriceMin,
      entryPriceMax,
      leverage,
      targets,
      stopLoss,
      emitter,
      date,
    };

    logger.info(`Signal parsé : ${pair} ${direction} | Entrée: $${entryPriceMin}-$${entryPriceMax} | Leverage: X${leverage} | ${targets.length} targets | SL: $${stopLoss}`);
    return signal;
  } catch (err) {
    logger.error(`Erreur parsing signal : ${err.message}`);
    return null;
  }
}

/**
 * Parse une confirmation de target atteint.
 *
 * Format attendu :
 * #POL/USDT Take-Profit target 1 ✅
 * Profit: 20.2224% 📈
 * Period: 14 Minutes ⏰
 *
 * @param {string} text - Texte du message
 * @param {number} messageId - ID du message Telegram
 * @param {Date} date - Date du message
 * @returns {Object|null} Confirmation parsée ou null
 */
function parseConfirmation(text, messageId, date) {
  // Vérifier que c'est une confirmation de take-profit
  const tpMatch = text.match(/#([A-Z0-9]+\/[A-Z0-9]+)\s+Take-Profit\s+target\s+(\d+)/i);
  if (!tpMatch) return null;

  try {
    const pair = tpMatch[1].toUpperCase();
    const targetNumber = parseInt(tpMatch[2], 10);

    // Extraire le pourcentage de profit
    const profitMatch = text.match(/Profit:\s*([\d.]+)%/i);
    const profitPct = profitMatch ? parseFloat(profitMatch[1]) : 0;

    // Extraire la durée (période)
    const periodMatch = text.match(/Period:\s*(.+?)(?:\s*⏰|\s*$)/im);
    const period = periodMatch ? periodMatch[1].trim() : null;

    const confirmation = {
      type: 'confirmation',
      telegramMessageId: messageId,
      pair,
      targetNumber,
      profitPct,
      period,
      date,
    };

    logger.info(`Confirmation parsée : ${pair} TP${targetNumber} +${profitPct}% (${period || 'N/A'})`);
    return confirmation;
  } catch (err) {
    logger.error(`Erreur parsing confirmation : ${err.message}`);
    return null;
  }
}

/**
 * Parse un message d'annulation manuelle.
 *
 * Format attendu :
 * #SOL/USDT Manually Cancelled
 *
 * @param {string} text - Texte du message
 * @param {number} messageId - ID du message Telegram
 * @param {Date} date - Date du message
 * @returns {Object|null} Annulation parsée ou null
 */
function parseCancellation(text, messageId, date) {
  const cancelMatch = text.match(/#([A-Z0-9]+\/[A-Z0-9]+)\s+Manually\s+Cancelled/i);
  if (!cancelMatch) return null;

  const pair = cancelMatch[1].toUpperCase();

  logger.info(`Annulation parsée : ${pair}`);
  return {
    type: 'cancellation',
    telegramMessageId: messageId,
    pair,
    date,
  };
}

/**
 * Parse un message de stop loss touché.
 *
 * Format attendu :
 * #BTC/USDT Stop loss ❌
 * Loss: 25.0000%
 * Period: 2 Hours ⏰
 *
 * @param {string} text - Texte du message
 * @param {number} messageId - ID du message Telegram
 * @param {Date} date - Date du message
 * @returns {Object|null} Stop loss parsé ou null
 */
function parseStopLoss(text, messageId, date) {
  // Plusieurs formats possibles pour le stop loss
  const slMatch = text.match(/#([A-Z0-9]+\/[A-Z0-9]+)\s+(?:Stop\s*loss|Stoploss|SL\s+hit)/i);
  if (!slMatch) return null;

  const pair = slMatch[1].toUpperCase();

  // Extraire le pourcentage de perte (si présent)
  const lossMatch = text.match(/Loss:\s*([\d.]+)%/i);
  const lossPct = lossMatch ? parseFloat(lossMatch[1]) : null;

  // Extraire la durée
  const periodMatch = text.match(/Period:\s*(.+?)(?:\s*⏰|\s*$)/im);
  const period = periodMatch ? periodMatch[1].trim() : null;

  logger.info(`Stop loss parsé : ${pair} ${lossPct ? `-${lossPct}%` : ''}`);
  return {
    type: 'stop_loss',
    telegramMessageId: messageId,
    pair,
    lossPct,
    period,
    date,
  };
}

/**
 * Parse un message d'entrée en zone de prix.
 *
 * Format attendu :
 * #POL/USDT Entered entry zone ✅
 * Period: 4 Minutes ⏰
 *
 * @param {string} text - Texte du message
 * @param {number} messageId - ID du message Telegram
 * @param {Date} date - Date du message
 * @returns {Object|null} Entrée en zone parsée ou null
 */
function parseEntryZone(text, messageId, date) {
  const entryMatch = text.match(/#([A-Z0-9]+\/[A-Z0-9]+)\s+Entered\s+entry\s+zone/i);
  if (!entryMatch) return null;

  const pair = entryMatch[1].toUpperCase();

  // Extraire la durée
  const periodMatch = text.match(/Period:\s*(.+?)(?:\s*⏰|\s*$)/im);
  const period = periodMatch ? periodMatch[1].trim() : null;

  logger.info(`Entrée en zone parsée : ${pair} (${period || 'N/A'})`);
  return {
    type: 'entry_zone',
    telegramMessageId: messageId,
    pair,
    period,
    date,
  };
}

module.exports = {
  parseMessage,
};
