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

  // Message non reconnu -> log au niveau INFO pour le diagnostic
  // Detecter si ca ressemble a un signal mais n'a pas ete parse
  const looksLikeSignal = /#/.test(text) || /signal/i.test(text) || /target/i.test(text)
    || /stop.?loss/i.test(text) || /take.?profit/i.test(text) || /entry/i.test(text)
    || /LONG/i.test(text) || /SHORT/i.test(text) || /leverage/i.test(text);

  if (looksLikeSignal) {
    // Ca ressemble a un signal mais on n'a pas pu le parser -> log complet
    logger.warn(`[PARSER] Message potentiel NON PARSE (contient des mots-cles) : "${text.substring(0, 300)}"`);
  } else {
    logger.debug(`Message non reconnu (ignoré) : ${text.substring(0, 80)}...`);
  }

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
  // Vérifier que c'est un signal
  // Formats connus : "#SIGNAL", "SIGNAL", ou message contenant la structure d'un signal Cornix
  const isSignalTag = text.includes('#SIGNAL') || text.includes('# SIGNAL');
  const isCornixSignal = /(?:SHORT|LONG)/i.test(text) && /(?:entry|price|between)/i.test(text) && /(?:target|take.?profit)/i.test(text);

  if (!isSignalTag && !isCornixSignal) return null;

  try {
    // Extraire la paire de trading (ex: POL/USDT, BTC/USDT)
    // Formats : #SIGNAL (POL/USDT), #SIGNAL POL/USDT, ou #POL/USDT, ou juste POL/USDT dans le contexte
    let pair = null;
    const pairPatterns = [
      /#SIGNAL\s*\(?([A-Z0-9]+\/[A-Z0-9]+)\)?/i,     // #SIGNAL (POL/USDT) ou #SIGNAL POL/USDT
      /#([A-Z0-9]+\/[A-Z0-9]+)/i,                      // #POL/USDT
      /\b([A-Z0-9]{2,10}\/USDT)\b/i,                   // POL/USDT (paire avec USDT)
      /\b([A-Z0-9]{2,10}\/BUSD)\b/i,                   // POL/BUSD
      /\b([A-Z0-9]{2,10}\/BTC)\b/i,                    // ETH/BTC
      /\b([A-Z0-9]{2,10}USDT)\b/,                      // POLUSDT (sans slash) -> on ajoutera le /
    ];
    for (const pattern of pairPatterns) {
      const match = text.match(pattern);
      if (match) {
        pair = match[1].toUpperCase();
        // Si la paire n'a pas de slash (POLUSDT), en ajouter un
        if (!pair.includes('/') && pair.endsWith('USDT')) {
          pair = pair.replace('USDT', '/USDT');
        } else if (!pair.includes('/') && pair.endsWith('BUSD')) {
          pair = pair.replace('BUSD', '/BUSD');
        }
        break;
      }
    }
    if (!pair) {
      logger.warn(`[PARSER] Signal detecte mais paire non trouvee : ${text.substring(0, 200)}`);
      return null;
    }

    // Extraire l'émetteur (ex: @CryptoKlondike)
    const emitterMatch = text.match(/@([A-Za-z0-9_]+)/);
    const emitter = emitterMatch ? `@${emitterMatch[1]}` : null;

    // Extraire la direction (SHORT ou LONG)
    // Formats : "Open SHORT", "SHORT", "Direction: Short", "Sell", "Buy"
    let direction = null;
    const directionPatterns = [
      /Open\s+(SHORT|LONG)/i,
      /Direction\s*:\s*(SHORT|LONG)/i,
      /\b(SHORT|LONG)\b/i,
      /\b(SELL|BUY)\b/i,
    ];
    for (const pattern of directionPatterns) {
      const match = text.match(pattern);
      if (match) {
        const val = match[1].toUpperCase();
        direction = (val === 'SELL') ? 'SHORT' : (val === 'BUY') ? 'LONG' : val;
        break;
      }
    }
    if (!direction) {
      logger.warn(`[PARSER] Signal ${pair} : direction non trouvee dans : ${text.substring(0, 200)}`);
      return null;
    }

    // Extraire les prix d'entrée min et max
    // Formats : "between $0.0989 - $0.1", "Entry: 0.0989 - 0.1", "Entry Zone: $0.0989 - $0.1"
    let entryPriceMin = null;
    let entryPriceMax = null;
    const pricePatterns = [
      /(?:price|entry)\s*(?:between|zone|:)?\s*\$?([\d.]+)\s*[-–]\s*\$?([\d.]+)/i,
      /(?:entry|entre|prix)\s*[:=]?\s*\$?([\d.]+)\s*[-–]\s*\$?([\d.]+)/i,
      /\$?([\d.]+)\s*[-–]\s*\$?([\d.]+)\s*(?:entry|entre)/i,
    ];
    for (const pattern of pricePatterns) {
      const match = text.match(pattern);
      if (match) {
        entryPriceMin = parseFloat(match[1]);
        entryPriceMax = parseFloat(match[2]);
        break;
      }
    }
    // Fallback: si on n'a qu'un seul prix d'entree
    if (!entryPriceMin) {
      const singlePriceMatch = text.match(/(?:price|entry|entre)\s*(?:at|:)?\s*\$?([\d.]+)/i);
      if (singlePriceMatch) {
        entryPriceMin = parseFloat(singlePriceMatch[1]);
        entryPriceMax = entryPriceMin;
      }
    }
    if (!entryPriceMin) {
      logger.warn(`[PARSER] Signal ${pair} : prix d'entree non trouves dans : ${text.substring(0, 200)}`);
      return null;
    }

    // Extraire le leverage (formats: X25, x25, 25x, leverage 25, leverage X25, lev 25)
    let leverage = 1;
    const leveragePatterns = [
      /X(\d+)\s+leverage/i,       // X25 leverage
      /leverage\s+X?(\d+)/i,      // leverage 25, leverage X25
      /(\d+)[xX]\s+leverage/i,    // 25x leverage
      /with\s+X(\d+)/i,           // with X25
      /lev\w*\s*[:=]?\s*(\d+)/i,  // lev: 25, leverage=25
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
      logger.warn(`[PARSER] Signal ${pair} : leverage non trouve, defaut X1 (spot)`);
    }

    // Extraire les targets (prix de clôture)
    // Formats multiples pour les targets
    const targets = [];

    // Format 1 : "Close the order at the price $0.09811"
    const closeMatches = text.matchAll(/Close\s+(?:the\s+)?order\s+at\s+(?:the\s+)?price\s+\$?([\d.]+)/gi);
    for (const match of closeMatches) {
      targets.push(parseFloat(match[1]));
    }

    // Format 2 : "Target 1 : $0.09811" ou "TP1 : $0.09811"
    if (targets.length === 0) {
      const tpMatches = text.matchAll(/(?:target|tp|take.?profit)\s*(\d+)\s*[:=\-]?\s*\$?([\d.]+)/gi);
      for (const match of tpMatches) {
        targets.push(parseFloat(match[2]));
      }
    }

    // Format 3 : lignes numérotées avec emojis : "1️⃣ $0.09811" ou "1. $0.09811"
    if (targets.length === 0) {
      const numberedMatches = text.matchAll(/(?:\d+[.️⃣)]\s*)\$?([\d.]+)/g);
      for (const match of numberedMatches) {
        const price = parseFloat(match[1]);
        // Filtrer les prix qui ne ressemblent pas a des targets
        if (price > 0 && price !== entryPriceMin && price !== entryPriceMax) {
          targets.push(price);
        }
      }
    }

    if (targets.length === 0) {
      logger.warn(`[PARSER] Signal ${pair} : aucun target trouve dans : ${text.substring(0, 300)}`);
      return null;
    }

    // Extraire le stop loss
    // Formats : "STOP LOSS: $0.10327", "SL: $0.10327", "Stop: 0.10327"
    let stopLoss = null;
    const slPatterns = [
      /STOP\s*LOSS\s*[:=]?\s*\$?([\d.]+)/i,
      /\bSL\s*[:=]?\s*\$?([\d.]+)/i,
      /Stop\s*[:=]?\s*\$?([\d.]+)/i,
    ];
    for (const pattern of slPatterns) {
      const match = text.match(pattern);
      if (match) {
        stopLoss = parseFloat(match[1]);
        break;
      }
    }
    if (!stopLoss) {
      logger.warn(`[PARSER] Signal ${pair} : stop loss non trouve dans : ${text.substring(0, 200)}`);
      return null;
    }

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

    logger.info(`[PARSER] Signal parse : ${pair} ${direction} | Entree: $${entryPriceMin}-$${entryPriceMax} | Leverage: X${leverage} | ${targets.length} targets | SL: $${stopLoss}`);
    return signal;
  } catch (err) {
    logger.error(`[PARSER] Erreur parsing signal : ${err.message}`);
    logger.error(err.stack);
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
  // Formats: "#POL/USDT Take-Profit target 1 ✅", "#POLUSDT TP target 1", "Take-Profit target 1 #POL/USDT"
  let pair = null;
  let targetNumber = null;

  const tpPatterns = [
    /#([A-Z0-9]+\/[A-Z0-9]+)\s+Take-?Profit\s+target\s+(\d+)/i,
    /#([A-Z0-9]+\/[A-Z0-9]+)\s+TP\s+(?:target\s+)?(\d+)/i,
    /Take-?Profit\s+target\s+(\d+).*?#([A-Z0-9]+\/[A-Z0-9]+)/i,
    /#([A-Z0-9]+USDT)\s+Take-?Profit\s+target\s+(\d+)/i,
    /#([A-Z0-9]+USDT)\s+TP\s+(?:target\s+)?(\d+)/i,
  ];

  for (const pattern of tpPatterns) {
    const match = text.match(pattern);
    if (match) {
      // Handle reversed capture groups (pattern 3)
      if (pattern === tpPatterns[2]) {
        targetNumber = parseInt(match[1], 10);
        pair = match[2].toUpperCase();
      } else {
        pair = match[1].toUpperCase();
        targetNumber = parseInt(match[2], 10);
      }
      break;
    }
  }

  if (!pair || !targetNumber) return null;

  // Ajouter le slash si absent (POLUSDT -> POL/USDT)
  if (!pair.includes('/') && pair.endsWith('USDT')) {
    pair = pair.replace('USDT', '/USDT');
  }

  try {
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

    logger.info(`[PARSER] Confirmation parsee : ${pair} TP${targetNumber} +${profitPct}% (${period || 'N/A'})`);
    return confirmation;
  } catch (err) {
    logger.error(`[PARSER] Erreur parsing confirmation : ${err.message}`);
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
