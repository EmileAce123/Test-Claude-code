// ============================================================
// portfolio-simulator.js - Simulation de portefeuille virtuel
// ============================================================
// Simule un portefeuille de trading virtuel qui part d'un capital
// initial et applique chaque trade avec :
// - Position sizing (% du capital disponible)
// - Leverage reel extrait du signal
// - Frais de transaction (entree + sortie)
// - Stop loss = liquidation de la position
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
 * Logique :
 * - Si TP hit : profit = position × leverage × (profitPct / 100)
 * - Si SL hit : perte = 100% de la position de base (liquidation)
 * - Frais appliques sur la position de base a l'entree et sur la valeur finale a la sortie
 *
 * @param {Object} signal - Signal depuis la BDD
 * @param {number} currentCapital - Capital avant ce trade
 * @returns {Object} { positionSize, feesEntry, feesExit, feesTotal, profitBrut, profitNet, capitalAfter, isWin }
 */
function calculateTradeImpact(signal, currentCapital) {
  // Taille de position (plafonnee a maxPositionPct du capital)
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

  const leverage = signal.leverage || 1;

  if (signal.status === 'sl_hit') {
    // ---- STOP LOSS = LIQUIDATION ----
    // Perte totale de la position de base + frais d'entree
    const lossTotal = positionSize + feesEntry;
    const capitalAfter = Math.max(0, currentCapital - lossTotal);

    logger.info(`[PORTFOLIO] SL ${signal.pair} : position=${positionSize.toFixed(2)}$ X${leverage} | perte=-${lossTotal.toFixed(2)}$ | capital=${capitalAfter.toFixed(2)}$`);

    return {
      positionSize,
      feesEntry,
      feesExit: 0,
      feesTotal: feesEntry,
      profitBrut: -positionSize,
      profitNet: -lossTotal,
      capitalAfter,
      isWin: false,
      skipped: false,
    };
  }

  if (['tp_hit', 'all_tp_hit'].includes(signal.status)) {
    // ---- TAKE PROFIT ----
    // Utiliser le profit du premier target (final_profit_pct)
    let profitPct = 0;
    if (signal.final_profit_pct !== null && signal.final_profit_pct !== undefined) {
      profitPct = Math.abs(signal.final_profit_pct);
    } else {
      // Calculer a partir des prix si pas de profit enregistre
      const entryPrice = (signal.entry_price_min + signal.entry_price_max) / 2;
      const targets = JSON.parse(signal.targets);
      if (targets.length > 0) {
        const firstTarget = targets[0];
        const priceDiff = signal.direction === 'SHORT'
          ? entryPrice - firstTarget
          : firstTarget - entryPrice;
        profitPct = Math.abs((priceDiff / entryPrice) * 100);
      }
    }

    // Profit brut = position × leverage × (profitPct / 100)
    const profitBrut = positionSize * leverage * (profitPct / 100);

    // Valeur finale de la position
    const valeurFinale = positionSize + profitBrut;

    // Frais de sortie (sur la valeur finale)
    const feesExit = calculateFee(valeurFinale);

    // Profit net = profit brut - frais entree - frais sortie
    const profitNet = profitBrut - feesEntry - feesExit;

    const capitalAfter = currentCapital + profitNet;

    logger.info(`[PORTFOLIO] TP ${signal.pair} : position=${positionSize.toFixed(2)}$ X${leverage} | +${profitPct.toFixed(2)}% | profit net=+${profitNet.toFixed(2)}$ | capital=${capitalAfter.toFixed(2)}$`);

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
  recalculateAll,
  getPortfolioSnapshot,
  getBestWorstTrades,
  checkAlerts,
};
