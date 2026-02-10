// ============================================================
// portfolio-simulator.js - Simulation de portefeuille virtuel
// ============================================================
// Simule un portefeuille de trading virtuel qui part d'un capital
// initial et applique chaque trade avec :
// - Position sizing (% du capital ACTUEL)
// - Frais de transaction (entree + sortie)
// - Stop loss = liquidation de la position
//
// IMPORTANT : Le profit est calcule depuis les prix reels (entry midpoint
// et exit price), PAS depuis le profit % fourni par Telegram.
// Formule : ((exitPrice - entryPrice) / entryPrice) * 100 * leverage
// (inversee pour SHORT)
//
// Le capital ne peut jamais etre negatif.
// ============================================================

const database = require('./database');
const logger = require('./logger');

// ---- Configuration par defaut (surchargee par .env) ----
let config = {
  startCapital: 200,
  maxPositionPct: 10,
  tradingFeePct: 0.5,
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
 * Calcule la taille de position maximale.
 * @param {number} capital - Capital disponible actuel
 * @returns {number} Taille de position en dollars
 */
function calculatePositionSize(capital) {
  return Math.max(0, capital * (config.maxPositionPct / 100));
}

/**
 * Calcule les frais de transaction.
 * @param {number} amount - Montant de base (pas l'exposition leveragee)
 * @returns {number} Frais en dollars
 */
function calculateFee(amount) {
  return amount * (config.tradingFeePct / 100);
}

/**
 * Calcule l'impact d'un trade sur le portefeuille.
 *
 * Le profit est calcule depuis les prix (profit_calculated en BDD),
 * pas depuis le profit % fourni par Telegram.
 *
 * Logique :
 * - Si TP hit : profitBrut = positionSize × (profitCalculated / 100)
 * - Si SL hit : perte = positionSize × |profitCalculated| / 100 + frais (cappee a 100%)
 * - Frais : entry sur la position de base, exit sur la valeur finale
 *
 * @param {Object} signal - Signal depuis la BDD
 * @param {number} currentCapital - Capital ACTUEL avant ce trade
 * @returns {Object} { positionSize, feesEntry, feesExit, feesTotal, profitBrut, profitNet, capitalAfter, isWin }
 */
function calculateTradeImpact(signal, currentCapital) {
  // Taille de position = maxPositionPct% du capital ACTUEL
  const positionSize = calculatePositionSize(currentCapital);

  // Si capital trop faible pour ouvrir une position
  if (positionSize < 0.01) {
    logger.warn(`Capital insuffisant (${currentCapital.toFixed(2)}$) pour ouvrir une position`);
    return {
      positionSize: 0,
      feesEntry: 0,
      feesExit: 0,
      feesTotal: 0,
      profitBrut: 0,
      profitNet: 0,
      capitalAfter: currentCapital,
      isWin: false,
      skipped: true,
    };
  }

  // Frais d'entree (sur la position de base)
  const feesEntry = calculateFee(positionSize);

  if (signal.status === 'sl_hit') {
    // ---- STOP LOSS ----
    // Perte calculee depuis les prix (entry midpoint -> stop loss * leverage)
    let lossPct = 100; // Fallback : liquidation totale si pas de prix

    if (signal.profit_calculated !== null && signal.profit_calculated !== undefined) {
      // profit_calculated est negatif pour un SL -> on prend la valeur absolue
      lossPct = Math.abs(signal.profit_calculated);
    } else if (signal.stop_loss > 0) {
      // Fallback : calculer depuis les prix stockes
      const entryMid = signal.entry_price_used || (signal.entry_price_min + signal.entry_price_max) / 2;
      const spotLoss = signal.direction === 'SHORT'
        ? ((entryMid - signal.stop_loss) / entryMid) * 100
        : ((signal.stop_loss - entryMid) / entryMid) * 100;
      lossPct = Math.abs(spotLoss * (signal.leverage || 1));
    }

    // La perte ne peut pas depasser 100% de la position (pas de dette)
    lossPct = Math.min(lossPct, 100);

    const lossAmount = positionSize * (lossPct / 100);
    const lossTotal = lossAmount + feesEntry;
    const capitalAfter = Math.max(0, currentCapital - lossTotal);

    logger.info(`[PORTFOLIO] SL ${signal.pair} : position=${positionSize.toFixed(2)}$ | -${lossPct.toFixed(2)}% | perte=-${lossTotal.toFixed(2)}$ | capital=${currentCapital.toFixed(2)}$ → ${capitalAfter.toFixed(2)}$`);

    return {
      positionSize,
      feesEntry,
      feesExit: 0,
      feesTotal: feesEntry,
      profitBrut: -lossAmount,
      profitNet: -lossTotal,
      capitalAfter,
      isWin: false,
      skipped: false,
    };
  }

  if (['tp_hit', 'all_tp_hit'].includes(signal.status)) {
    // ---- TAKE PROFIT ----
    // Utiliser profit_calculated (calcule depuis les prix, pas depuis Telegram)
    let profitPct = 0;
    if (signal.profit_calculated !== null && signal.profit_calculated !== undefined) {
      profitPct = Math.abs(signal.profit_calculated);
    } else {
      // Fallback : calculer depuis les prix stockes
      const entryMid = signal.entry_price_used || (signal.entry_price_min + signal.entry_price_max) / 2;
      const targets = JSON.parse(signal.targets);
      const targetIdx = (signal.last_target_hit || 1) - 1;
      const exitPrice = targets[targetIdx] !== undefined ? targets[targetIdx] : targets[0];
      const spotProfit = signal.direction === 'SHORT'
        ? ((entryMid - exitPrice) / entryMid) * 100
        : ((exitPrice - entryMid) / entryMid) * 100;
      profitPct = Math.abs(spotProfit * (signal.leverage || 1));
    }

    // Profit brut = position × (profitPct / 100)
    // PAS de multiplication par leverage : le % inclut deja le leverage
    const profitBrut = positionSize * (profitPct / 100);

    // Valeur finale de la position
    const valeurFinale = positionSize + profitBrut;

    // Frais de sortie (sur la valeur finale)
    const feesExit = calculateFee(valeurFinale);

    // Profit net = profit brut - frais entree - frais sortie
    const profitNet = profitBrut - feesEntry - feesExit;

    const capitalAfter = currentCapital + profitNet;

    logger.info(`[PORTFOLIO] TP ${signal.pair} : position=${positionSize.toFixed(2)}$ | +${profitPct.toFixed(2)}% (leverage inclus) | profit net=+${profitNet.toFixed(2)}$ | capital=${currentCapital.toFixed(2)}$ → ${capitalAfter.toFixed(2)}$`);

    return {
      positionSize,
      feesEntry,
      feesExit,
      feesTotal: feesEntry + feesExit,
      profitBrut,
      profitNet,
      capitalAfter,
      isWin: true,
      skipped: false,
    };
  }

  // Trade annule ou en cours : pas d'impact
  return {
    positionSize: 0,
    feesEntry: 0,
    feesExit: 0,
    feesTotal: 0,
    profitBrut: 0,
    profitNet: 0,
    capitalAfter: currentCapital,
    isWin: false,
    skipped: true,
  };
}

/**
 * Traite un trade cloture (TP ou SL) et met a jour le portefeuille immediatement.
 * Utilise le capital actuel depuis la BDD (dernier virtual_portfolio_after).
 *
 * @param {number} signalId - ID du signal cloture
 * @returns {Object|null} Impact du trade ou null si non applicable
 */
function processTradeForPortfolio(signalId) {
  const signal = database.getSignalById(signalId);
  if (!signal) {
    logger.warn(`[PORTFOLIO] Signal #${signalId} non trouve`);
    return null;
  }

  // Verifier que le signal est bien cloture (TP ou SL)
  if (!['tp_hit', 'all_tp_hit', 'sl_hit'].includes(signal.status)) {
    return null;
  }

  // Verifier que ce trade n'a pas deja ete calcule
  if (signal.virtual_portfolio_after !== null) {
    logger.info(`[PORTFOLIO] Signal #${signalId} deja calcule, skip`);
    return null;
  }

  // Capital actuel = dernier virtual_portfolio_after ou capital initial
  const currentCapital = database.getLastPortfolioCapital(config.startCapital);

  const impact = calculateTradeImpact(signal, currentCapital);
  if (impact.skipped) return null;

  // Sauvegarder l'impact en BDD
  database.updateSignalPortfolio(signalId, {
    virtualPortfolioBefore: currentCapital,
    virtualPortfolioAfter: impact.capitalAfter,
    positionSize: impact.positionSize,
    tradingFeesTotal: impact.feesTotal,
    netProfitLoss: impact.profitNet,
  });

  logger.info(`[PORTFOLIO] Trade #${signalId} (${signal.pair}) : ${currentCapital.toFixed(2)}$ → ${impact.capitalAfter.toFixed(2)}$`);
  return impact;
}

/**
 * Recalcule l'historique complet du portefeuille depuis le debut.
 * Parcourt tous les trades termines dans l'ordre chronologique
 * et applique chaque trade pour obtenir l'evolution du capital.
 *
 * @returns {Object} { history, current, totalFees, winCount, lossCount }
 */
function recalculateAll() {
  logger.info('[PORTFOLIO] Recalcul complet de l\'historique...');

  // Recuperer tous les trades termines, du plus ancien au plus recent
  const closedSignals = database.getClosedSignals();
  const sorted = [...closedSignals].sort((a, b) =>
    new Date(a.updated_at || a.created_at) - new Date(b.updated_at || b.created_at)
  );

  let capital = config.startCapital;
  let totalFees = 0;
  let winCount = 0;
  let lossCount = 0;
  let consecutiveLosses = 0;
  let maxConsecutiveLosses = 0;
  const history = [];

  // Point de depart
  history.push({
    date: sorted.length > 0 ? sorted[0].created_at : new Date().toISOString(),
    capital: config.startCapital,
    trade: null,
    pair: null,
    profitNet: 0,
    fees: 0,
    positionSize: 0,
  });

  for (const signal of sorted) {
    const impact = calculateTradeImpact(signal, capital);

    if (impact.skipped) continue;

    // Mettre a jour les colonnes du signal dans la BDD
    database.updateSignalPortfolio(signal.id, {
      virtualPortfolioBefore: capital,
      virtualPortfolioAfter: impact.capitalAfter,
      positionSize: impact.positionSize,
      tradingFeesTotal: impact.feesTotal,
      netProfitLoss: impact.profitNet,
    });

    capital = impact.capitalAfter;
    totalFees += impact.feesTotal;

    if (impact.isWin) {
      winCount++;
      consecutiveLosses = 0;
    } else {
      lossCount++;
      consecutiveLosses++;
      if (consecutiveLosses > maxConsecutiveLosses) {
        maxConsecutiveLosses = consecutiveLosses;
      }
    }

    history.push({
      date: signal.updated_at || signal.created_at,
      capital: Math.round(capital * 100) / 100,
      trade: `${signal.pair} ${signal.direction} X${signal.leverage}`,
      pair: signal.pair,
      profitNet: Math.round(impact.profitNet * 100) / 100,
      fees: Math.round(impact.feesTotal * 100) / 100,
      positionSize: Math.round(impact.positionSize * 100) / 100,
    });
  }

  const roi = config.startCapital > 0
    ? ((capital - config.startCapital) / config.startCapital) * 100
    : 0;

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
  };

  logger.info(`[PORTFOLIO] Recalcul terminé : ${result.totalTrades} trades | Capital: ${result.current}$ | ROI: ${result.roi}%`);
  return result;
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
 * Verifie les alertes a envoyer (capital bas, pertes consecutives).
 * @returns {Array<string>} Messages d'alerte a envoyer
 */
function checkAlerts() {
  const snapshot = recalculateAll();
  const alerts = [];

  if (snapshot.current < 20 && snapshot.current > 0) {
    alerts.push(`⚠️ *Capital insuffisant !*\nCapital actuel : ${snapshot.current.toFixed(2)}$\nImpossible d'ouvrir de nouvelles positions.`);
  }

  if (snapshot.consecutiveLosses >= 3) {
    alerts.push(`⚠️ *${snapshot.consecutiveLosses} pertes consecutives !*\nCapital actuel : ${snapshot.current.toFixed(2)}$\nRevision de strategie recommandee.`);
  }

  return alerts;
}

module.exports = {
  configure,
  calculatePositionSize,
  calculateFee,
  calculateTradeImpact,
  processTradeForPortfolio,
  recalculateAll,
  getPortfolioSnapshot,
  getBestWorstTrades,
  checkAlerts,
};
