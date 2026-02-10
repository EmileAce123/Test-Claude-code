// ============================================================
// portfolio-simulator.js - Simulation de portefeuille pyramidal
// ============================================================
// Strategie pyramidale multi-TP :
//   TP1 = fermer 35% de la position
//   TP2 = fermer 22.5%
//   TP3 = fermer 17.5%
//   TP4 = fermer 10%
//   TP5+ = fermer les 15% restants
//
// Marge de securite -15% sur les gains, +15% sur les pertes.
// Le capital ne peut jamais etre negatif.
// ============================================================

const database = require('./database');
const logger = require('./logger');

// ---- Configuration ----
let config = {
  startCapital: 200,
  maxPositionPct: 10,
  tradingFeePct: 0.5,
};

// ---- Constantes ----
const SAFETY_MARGIN_GAINS = 0.85;   // -15% sur les gains
const SAFETY_MARGIN_LOSSES = 1.15;  // +15% sur les pertes

// Configuration pyramidale : % de la position INITIALE a fermer a chaque TP
const PYRAMID_CONFIG = {
  1: 35,    // TP1 = 35%
  2: 22.5,  // TP2 = 22.5%
  3: 17.5,  // TP3 = 17.5%
  4: 10,    // TP4 = 10%
  5: 15,    // TP5+ = 15% (reste)
};

/**
 * Initialise la configuration du simulateur.
 * @param {Object} cfg - { startCapital, maxPositionPct, tradingFeePct }
 */
function configure(cfg) {
  if (cfg.startCapital) config.startCapital = cfg.startCapital;
  if (cfg.maxPositionPct) config.maxPositionPct = cfg.maxPositionPct;
  if (cfg.tradingFeePct) config.tradingFeePct = cfg.tradingFeePct;
  logger.info(`Portfolio configuré : capital=${config.startCapital}$, position=${config.maxPositionPct}%, frais=${config.tradingFeePct}%`);
}

/**
 * Calcule les frais de transaction.
 * @param {number} amount - Montant de base
 * @returns {number} Frais en dollars
 */
function calculateFee(amount) {
  return Math.abs(amount) * (config.tradingFeePct / 100);
}

// ============================================================
// INITIALISATION DE POSITION
// ============================================================

/**
 * Initialise une position pyramidale pour un nouveau signal.
 * Calcule position_size_initial en fonction du capital disponible.
 *
 * @param {number} signalId - ID du signal insere
 * @returns {number} Taille de position initiale en $
 */
function initPosition(signalId) {
  const currentCapital = database.getLastPortfolioCapital(config.startCapital);
  const exposure = database.getOpenExposure();
  const availableCapital = Math.max(0, currentCapital - exposure);

  const positionSizeInitial = Math.max(0, availableCapital * (config.maxPositionPct / 100));

  if (positionSizeInitial < 0.01) {
    logger.warn(`[PYRAMID] Capital disponible insuffisant (${availableCapital.toFixed(2)}$) pour signal #${signalId}`);
    return 0;
  }

  database.initSignalPosition(signalId, positionSizeInitial);

  logger.info(`[PYRAMID] Signal #${signalId} : position=${positionSizeInitial.toFixed(2)}$ | capital=${currentCapital.toFixed(2)}$ | exposure=${exposure.toFixed(2)}$ | disponible=${availableCapital.toFixed(2)}$`);
  return positionSizeInitial;
}

// ============================================================
// EXECUTION PYRAMIDALE - TAKE PROFIT
// ============================================================

/**
 * Execute une fermeture partielle pyramidale lors d'un TP.
 *
 * @param {number} signalId - ID du signal
 * @param {number} targetNumber - Numero du target (1-5+)
 * @param {number} telegramProfitPct - Profit % rapporte par Telegram (inclut leverage)
 * @returns {Object|null} Details de l'execution ou null si erreur
 */
function executePyramidTP(signalId, targetNumber, telegramProfitPct) {
  const signal = database.getSignalById(signalId);
  if (!signal) {
    logger.warn(`[PYRAMID] Signal #${signalId} non trouve`);
    return null;
  }

  // Verifier que la position est initialisee
  if (!signal.position_size_initial || signal.position_size_initial <= 0) {
    logger.warn(`[PYRAMID] Signal #${signalId} : position non initialisee`);
    return null;
  }

  // Determiner le % a fermer selon la pyramide
  const percentToClose = PYRAMID_CONFIG[targetNumber] || 15;

  // Si le restant est insuffisant, fermer tout ce qui reste
  const actualPercentToClose = Math.min(percentToClose, signal.position_remaining_percent || 100);
  if (actualPercentToClose <= 0) {
    logger.info(`[PYRAMID] Signal #${signalId} : position deja entierement fermee`);
    return null;
  }

  // Taille de la portion a fermer (% de la position INITIALE)
  const sizeToClose = signal.position_size_initial * (actualPercentToClose / 100);

  // Appliquer marge de securite sur le profit Telegram
  const safeProfitPct = telegramProfitPct * SAFETY_MARGIN_GAINS;

  // Calcul profit $ sur cette portion
  const feeEntry = calculateFee(sizeToClose);
  const profitBrut = sizeToClose * (safeProfitPct / 100);
  const feeExit = calculateFee(sizeToClose + profitBrut);
  const profitNet = profitBrut - feeEntry - feeExit;

  // Enregistrer l'execution
  database.insertTradeExecution({
    signalId,
    targetNumber,
    targetPrice: null, // sera mis a jour par Binance si disponible
    positionClosedPercent: actualPercentToClose,
    positionClosedSize: sizeToClose,
    profitRealized: profitNet,
    profitRealizedPercent: safeProfitPct,
  });

  // Calculer nouveaux totaux
  const newRemainingPercent = Math.max(0, (signal.position_remaining_percent || 100) - actualPercentToClose);
  const newRemainingSize = signal.position_size_initial * (newRemainingPercent / 100);
  const newProfitRealizedTotal = (signal.profit_realized_total || 0) + profitNet;

  // P&L latent sur position restante (estimation au meme profit %)
  let profitLatent = 0;
  if (newRemainingSize > 0) {
    const latentProfitBrut = newRemainingSize * (safeProfitPct / 100);
    profitLatent = latentProfitBrut - calculateFee(newRemainingSize) - calculateFee(newRemainingSize + latentProfitBrut);
  }

  const pnlTotal = newProfitRealizedTotal + profitLatent;
  const newStatus = newRemainingPercent <= 0 ? 'closed' : 'partial';

  // Mettre a jour le signal
  database.updateSignalPyramidState(signalId, {
    positionRemainingPercent: newRemainingPercent,
    positionRemainingSize: newRemainingSize,
    profitRealizedTotal: newProfitRealizedTotal,
    profitLatent,
    pnlTotal,
    status: newStatus,
  });

  // Mettre a jour le capital du portefeuille
  const capitalBefore = database.getLastPortfolioCapital(config.startCapital);
  const capitalAfter = capitalBefore + profitNet;
  database.updateSignalPortfolio(signalId, {
    virtualPortfolioBefore: capitalBefore,
    virtualPortfolioAfter: capitalAfter,
    positionSize: signal.position_size_initial,
    tradingFeesTotal: feeEntry + feeExit,
    netProfitLoss: profitNet,
  });

  logger.info(`[PYRAMID] TP${targetNumber} signal #${signalId} ${signal.pair} : ferme ${actualPercentToClose}% (${sizeToClose.toFixed(2)}$) | profit=${profitNet >= 0 ? '+' : ''}${profitNet.toFixed(2)}$ | restant=${newRemainingPercent}% | capital=${capitalAfter.toFixed(2)}$`);

  return {
    signalId,
    targetNumber,
    percentClosed: actualPercentToClose,
    sizeClosed: sizeToClose,
    profitPctSafe: safeProfitPct,
    profitNet,
    remainingPercent: newRemainingPercent,
    remainingSize: newRemainingSize,
    profitRealizedTotal: newProfitRealizedTotal,
    profitLatent,
    pnlTotal,
    status: newStatus,
    capitalAfter,
  };
}

// ============================================================
// EXECUTION PYRAMIDALE - STOP LOSS
// ============================================================

/**
 * Execute la fermeture stop loss (100% de la position restante).
 *
 * @param {number} signalId - ID du signal
 * @param {number|null} telegramLossPct - Perte % rapportee par Telegram (positif = perte)
 * @returns {Object|null} Details de l'execution ou null si erreur
 */
function executePyramidSL(signalId, telegramLossPct) {
  const signal = database.getSignalById(signalId);
  if (!signal) {
    logger.warn(`[PYRAMID] SL Signal #${signalId} non trouve`);
    return null;
  }

  if (!signal.position_size_initial || signal.position_size_initial <= 0) {
    logger.warn(`[PYRAMID] SL Signal #${signalId} : position non initialisee`);
    return null;
  }

  const remainingPercent = signal.position_remaining_percent || 100;
  const remainingSize = signal.position_remaining_size || signal.position_size_initial;

  if (remainingPercent <= 0 || remainingSize <= 0) {
    logger.info(`[PYRAMID] SL Signal #${signalId} : position deja fermee`);
    return null;
  }

  // Calculer la perte
  // telegramLossPct est le % de perte (inclut leverage), positif = perte
  let lossPct = telegramLossPct ? Math.abs(telegramLossPct) : 100;
  lossPct = Math.min(lossPct, 100); // capper a 100%

  // Amplifier la perte avec marge de securite
  const safeLossPct = lossPct * SAFETY_MARGIN_LOSSES;
  const cappedLossPct = Math.min(safeLossPct, 100); // ne pas depasser 100%

  // Calcul perte $ sur la position restante
  const feeEntry = calculateFee(remainingSize);
  const lossAmount = remainingSize * (cappedLossPct / 100);
  const lossNet = lossAmount + feeEntry;

  // Enregistrer l'execution (target_number = 0 pour SL)
  database.insertTradeExecution({
    signalId,
    targetNumber: 0,
    targetPrice: null,
    positionClosedPercent: remainingPercent,
    positionClosedSize: remainingSize,
    profitRealized: -lossNet,
    profitRealizedPercent: -cappedLossPct,
  });

  // Calculer nouveaux totaux
  const newProfitRealizedTotal = (signal.profit_realized_total || 0) - lossNet;
  const pnlTotal = newProfitRealizedTotal; // plus de latent

  database.updateSignalPyramidState(signalId, {
    positionRemainingPercent: 0,
    positionRemainingSize: 0,
    profitRealizedTotal: newProfitRealizedTotal,
    profitLatent: 0,
    pnlTotal,
    status: 'stopped',
  });

  // Mettre a jour le capital
  const capitalBefore = database.getLastPortfolioCapital(config.startCapital);
  const capitalAfter = Math.max(0, capitalBefore - lossNet);
  database.updateSignalPortfolio(signalId, {
    virtualPortfolioBefore: capitalBefore,
    virtualPortfolioAfter: capitalAfter,
    positionSize: signal.position_size_initial,
    tradingFeesTotal: feeEntry,
    netProfitLoss: -lossNet,
  });

  logger.info(`[PYRAMID] SL signal #${signalId} ${signal.pair} : ferme ${remainingPercent}% restant (${remainingSize.toFixed(2)}$) | perte=-${lossNet.toFixed(2)}$ (${cappedLossPct.toFixed(1)}%) | P&L total=${pnlTotal.toFixed(2)}$ | capital=${capitalAfter.toFixed(2)}$`);

  return {
    signalId,
    percentClosed: remainingPercent,
    sizeClosed: remainingSize,
    lossPctSafe: cappedLossPct,
    lossNet,
    profitRealizedTotal: newProfitRealizedTotal,
    pnlTotal,
    capitalAfter,
  };
}

// ============================================================
// RECALCUL COMPLET
// ============================================================

/**
 * Recalcule l'historique complet du portefeuille avec strategie pyramidale.
 * Parcourt tous les signaux et leurs evenements (confirmations + SL)
 * dans l'ordre chronologique.
 *
 * @returns {Object} { history, current, initial, totalGain, totalFees, roi, ... }
 */
function recalculateAll() {
  logger.info('[PYRAMID] Recalcul complet...');

  const allSignals = database.getAllSignalsChronological();
  const history = [];
  let capital = config.startCapital;
  let totalFees = 0;
  let winCount = 0;
  let lossCount = 0;
  let consecutiveLosses = 0;
  let maxConsecutiveLosses = 0;
  const positions = new Map(); // signalId -> position state

  // Point de depart
  history.push({
    date: allSignals.length > 0 ? allSignals[0].created_at : new Date().toISOString(),
    capital: config.startCapital,
    trade: null,
    pair: null,
    profitNet: 0,
    fees: 0,
    positionSize: 0,
  });

  // Collecter tous les evenements (open, tp, sl) et les trier chronologiquement
  const events = [];

  for (const signal of allSignals) {
    if (signal.status === 'cancelled') continue;

    // Evenement d'ouverture
    events.push({
      type: 'open',
      time: signal.created_at,
      signalId: signal.id,
      signal,
    });

    // Confirmations (TP)
    const confirmations = database.getConfirmations(signal.id);
    for (const conf of confirmations) {
      events.push({
        type: 'tp',
        time: conf.created_at,
        signalId: signal.id,
        signal,
        targetNumber: conf.target_number,
        profitPct: conf.profit_pct,
      });
    }

    // Stop losses
    const slRows = getStopLossesForSignal(signal.id);
    for (const sl of slRows) {
      events.push({
        type: 'sl',
        time: sl.created_at,
        signalId: signal.id,
        signal,
        lossPct: sl.loss_pct,
      });
    }
  }

  // Trier par date
  events.sort((a, b) => new Date(a.time) - new Date(b.time));

  // Traiter chaque evenement
  for (const event of events) {
    const sig = event.signal;

    switch (event.type) {
      case 'open': {
        const exposure = Array.from(positions.values())
          .reduce((sum, p) => sum + p.remainingSize, 0);
        const available = Math.max(0, capital - exposure);
        const posSize = Math.max(0, available * (config.maxPositionPct / 100));

        positions.set(event.signalId, {
          positionSizeInitial: posSize,
          remainingPercent: 100,
          remainingSize: posSize,
          profitRealizedTotal: 0,
        });

        // Stocker dans la BDD
        if (posSize > 0) {
          database.initSignalPosition(event.signalId, posSize);
        }
        break;
      }

      case 'tp': {
        const pos = positions.get(event.signalId);
        if (!pos || pos.remainingPercent <= 0 || pos.positionSizeInitial <= 0) break;

        const percentToClose = PYRAMID_CONFIG[event.targetNumber] || 15;
        const actualPercent = Math.min(percentToClose, pos.remainingPercent);
        if (actualPercent <= 0) break;

        const sizeToClose = pos.positionSizeInitial * (actualPercent / 100);
        const safeProfitPct = event.profitPct * SAFETY_MARGIN_GAINS;

        const feeEntry = calculateFee(sizeToClose);
        const profitBrut = sizeToClose * (safeProfitPct / 100);
        const feeExit = calculateFee(sizeToClose + profitBrut);
        const profitNet = profitBrut - feeEntry - feeExit;
        const fees = feeEntry + feeExit;

        // Mettre a jour la position
        pos.remainingPercent = Math.max(0, pos.remainingPercent - actualPercent);
        pos.remainingSize = pos.positionSizeInitial * (pos.remainingPercent / 100);
        pos.profitRealizedTotal += profitNet;

        capital += profitNet;
        totalFees += fees;
        winCount++;
        consecutiveLosses = 0;

        // Enregistrer l'execution
        database.insertTradeExecution({
          signalId: event.signalId,
          targetNumber: event.targetNumber,
          targetPrice: null,
          positionClosedPercent: actualPercent,
          positionClosedSize: sizeToClose,
          profitRealized: profitNet,
          profitRealizedPercent: safeProfitPct,
        });

        // Determiner le statut
        const newStatus = pos.remainingPercent <= 0 ? 'closed' : 'partial';

        // Mettre a jour la BDD
        database.updateSignalPyramidState(event.signalId, {
          positionRemainingPercent: pos.remainingPercent,
          positionRemainingSize: pos.remainingSize,
          profitRealizedTotal: pos.profitRealizedTotal,
          profitLatent: 0,
          pnlTotal: pos.profitRealizedTotal,
          status: newStatus,
        });

        database.updateSignalPortfolio(event.signalId, {
          virtualPortfolioBefore: capital - profitNet,
          virtualPortfolioAfter: capital,
          positionSize: pos.positionSizeInitial,
          tradingFeesTotal: fees,
          netProfitLoss: profitNet,
        });

        history.push({
          date: event.time,
          capital: Math.round(capital * 100) / 100,
          trade: `${sig.pair} ${sig.direction} X${sig.leverage} TP${event.targetNumber} (${actualPercent}%)`,
          pair: sig.pair,
          profitNet: Math.round(profitNet * 100) / 100,
          fees: Math.round(fees * 100) / 100,
          positionSize: Math.round(sizeToClose * 100) / 100,
        });
        break;
      }

      case 'sl': {
        const pos = positions.get(event.signalId);
        if (!pos || pos.remainingPercent <= 0 || pos.positionSizeInitial <= 0) break;

        const remainingSize = pos.remainingSize;
        let lossPct = event.lossPct ? Math.abs(event.lossPct) : 100;
        lossPct = Math.min(lossPct, 100);
        const safeLossPct = Math.min(lossPct * SAFETY_MARGIN_LOSSES, 100);

        const feeEntry = calculateFee(remainingSize);
        const lossAmount = remainingSize * (safeLossPct / 100);
        const lossNet = lossAmount + feeEntry;
        const fees = feeEntry;

        pos.profitRealizedTotal -= lossNet;
        pos.remainingPercent = 0;
        pos.remainingSize = 0;

        capital = Math.max(0, capital - lossNet);
        totalFees += fees;
        lossCount++;
        consecutiveLosses++;
        if (consecutiveLosses > maxConsecutiveLosses) {
          maxConsecutiveLosses = consecutiveLosses;
        }

        database.insertTradeExecution({
          signalId: event.signalId,
          targetNumber: 0,
          targetPrice: null,
          positionClosedPercent: pos.remainingPercent || (positions.get(event.signalId) ? 100 : 0),
          positionClosedSize: remainingSize,
          profitRealized: -lossNet,
          profitRealizedPercent: -safeLossPct,
        });

        database.updateSignalPyramidState(event.signalId, {
          positionRemainingPercent: 0,
          positionRemainingSize: 0,
          profitRealizedTotal: pos.profitRealizedTotal,
          profitLatent: 0,
          pnlTotal: pos.profitRealizedTotal,
          status: 'stopped',
        });

        database.updateSignalPortfolio(event.signalId, {
          virtualPortfolioBefore: capital + lossNet,
          virtualPortfolioAfter: capital,
          positionSize: pos.positionSizeInitial,
          tradingFeesTotal: fees,
          netProfitLoss: -lossNet,
        });

        history.push({
          date: event.time,
          capital: Math.round(capital * 100) / 100,
          trade: `${sig.pair} ${sig.direction} X${sig.leverage} SL`,
          pair: sig.pair,
          profitNet: Math.round(-lossNet * 100) / 100,
          fees: Math.round(fees * 100) / 100,
          positionSize: Math.round(remainingSize * 100) / 100,
        });
        break;
      }
    }
  }

  const roi = config.startCapital > 0
    ? ((capital - config.startCapital) / config.startCapital) * 100
    : 0;

  // Calculer l'exposition actuelle
  const totalExposure = Array.from(positions.values())
    .reduce((sum, p) => sum + p.remainingSize, 0);

  const result = {
    history,
    current: Math.round(capital * 100) / 100,
    initial: config.startCapital,
    totalGain: Math.round((capital - config.startCapital) * 100) / 100,
    totalFees: Math.round(totalFees * 100) / 100,
    roi: Math.round(roi * 100) / 100,
    winCount,
    lossCount,
    winRate: (winCount + lossCount) > 0
      ? Math.round((winCount / (winCount + lossCount)) * 10000) / 100
      : 0,
    totalTrades: winCount + lossCount,
    consecutiveLosses,
    maxConsecutiveLosses,
    exposure: Math.round(totalExposure * 100) / 100,
  };

  logger.info(`[PYRAMID] Recalcul termine : ${result.totalTrades} executions | Capital: ${result.current}$ | ROI: ${result.roi}% | Exposure: ${result.exposure}$`);
  return result;
}

/**
 * Recupere les stop losses pour un signal donné.
 * @param {number} signalId
 * @returns {Array}
 */
function getStopLossesForSignal(signalId) {
  return database.getStopLosses(signalId);
}

/**
 * Retourne un snapshot complet de l'etat actuel du portefeuille.
 * @returns {Object}
 */
function getPortfolioSnapshot() {
  return recalculateAll();
}

/**
 * Retourne les top 5 meilleurs et pires trades en $ net.
 * @returns {Object} { best: [...], worst: [...] }
 */
function getBestWorstTrades() {
  const snapshot = recalculateAll();
  const tradesOnly = snapshot.history.filter(h => h.trade !== null);

  const sorted = [...tradesOnly].sort((a, b) => b.profitNet - a.profitNet);

  return {
    best: sorted.slice(0, 5),
    worst: sorted.slice(-5).reverse(),
  };
}

/**
 * Verifie les alertes a envoyer.
 * @returns {Array<string>} Messages d'alerte
 */
function checkAlerts() {
  const snapshot = recalculateAll();
  const alerts = [];

  if (snapshot.current < 20 && snapshot.current > 0) {
    alerts.push(`Capital insuffisant ! Capital actuel : ${snapshot.current.toFixed(2)}$`);
  }

  if (snapshot.consecutiveLosses >= 3) {
    alerts.push(`${snapshot.consecutiveLosses} pertes consecutives ! Capital : ${snapshot.current.toFixed(2)}$`);
  }

  return alerts;
}

module.exports = {
  configure,
  calculateFee,
  initPosition,
  executePyramidTP,
  executePyramidSL,
  recalculateAll,
  getPortfolioSnapshot,
  getBestWorstTrades,
  checkAlerts,
  PYRAMID_CONFIG,
  SAFETY_MARGIN_GAINS,
  SAFETY_MARGIN_LOSSES,
};
