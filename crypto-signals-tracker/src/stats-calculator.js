// ============================================================
// stats-calculator.js - Calculs de rentabilité et statistiques
// ============================================================
// Ce module calcule toutes les métriques de performance :
// - Win rate (% de trades gagnants)
// - Profit moyen par trade
// - Rentabilité globale cumulée
// - Meilleur et pire trade
// - Drawdown maximum
// ============================================================

const database = require('./database');
const logger = require('./logger');

/**
 * Calcule les statistiques globales sur tous les trades terminés.
 * @returns {Object} Statistiques complètes
 */
function calculateGlobalStats() {
  // Récupérer tous les signaux terminés (gagnants et perdants)
  const closedSignals = database.getClosedSignals();
  const counts = database.countSignals();

  // S'il n'y a aucun trade terminé, retourner des valeurs par défaut
  if (closedSignals.length === 0) {
    return {
      counts,
      winRate: 0,
      avgProfit: 0,
      totalProfit: 0,
      bestTrade: null,
      worstTrade: null,
      maxDrawdown: 0,
      trades: [],
      totalTrades: 0,
    };
  }

  // Séparer les trades gagnants et perdants
  const wins = closedSignals.filter(s => ['tp_hit', 'all_tp_hit', 'closed', 'partial'].includes(s.status));
  const losses = closedSignals.filter(s => ['sl_hit', 'stopped'].includes(s.status));

  // ---- Win Rate ----
  // Pourcentage de trades gagnants sur le total des trades terminés
  const totalTrades = wins.length + losses.length;
  const winRate = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0;

  // ---- Calcul des profits de chaque trade ----
  // Pour chaque trade, on calcule le profit au premier target atteint
  // ou la perte au stop loss
  const tradeProfits = closedSignals.map(signal => {
    const profit = calculateTradeProfit(signal);
    return {
      pair: signal.pair,
      direction: signal.direction,
      leverage: signal.leverage,
      status: signal.status,
      profit: profit,
      date: signal.created_at,
    };
  });

  // ---- Profit moyen par trade ----
  const totalProfit = tradeProfits.reduce((sum, t) => sum + t.profit, 0);
  const avgProfit = totalTrades > 0 ? totalProfit / totalTrades : 0;

  // ---- Meilleur et pire trade ----
  const bestTrade = tradeProfits.reduce((best, t) =>
    t.profit > (best?.profit ?? -Infinity) ? t : best, null
  );
  const worstTrade = tradeProfits.reduce((worst, t) =>
    t.profit < (worst?.profit ?? Infinity) ? t : worst, null
  );

  // ---- Drawdown maximum ----
  // Le drawdown max est la plus grande chute depuis un pic de capital
  const maxDrawdown = calculateMaxDrawdown(tradeProfits);

  const stats = {
    counts,
    winRate: Math.round(winRate * 100) / 100,
    avgProfit: Math.round(avgProfit * 100) / 100,
    totalProfit: Math.round(totalProfit * 100) / 100,
    bestTrade,
    worstTrade,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    trades: tradeProfits,
    totalTrades,
  };

  logger.info(`Stats calculées : ${totalTrades} trades, WR=${stats.winRate}%, Profit total=${stats.totalProfit}%`);
  return stats;
}

/**
 * Calcule les statistiques pour une période donnée.
 * @param {string} since - Date de début (format ISO : '2024-01-01')
 * @returns {Object} Statistiques de la période
 */
function calculateStatsSince(since) {
  const closedSignals = database.getClosedSignalsSince(since);
  const allSignals = database.getSignalsSince(since);

  if (closedSignals.length === 0) {
    return {
      period: since,
      totalSignals: allSignals.length,
      closedTrades: 0,
      winRate: 0,
      avgProfit: 0,
      totalProfit: 0,
      bestTrade: null,
      worstTrade: null,
    };
  }

  const wins = closedSignals.filter(s => ['tp_hit', 'all_tp_hit', 'closed', 'partial'].includes(s.status));
  const losses = closedSignals.filter(s => ['sl_hit', 'stopped'].includes(s.status));
  const totalTrades = wins.length + losses.length;
  const winRate = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0;

  const tradeProfits = closedSignals.map(signal => ({
    pair: signal.pair,
    direction: signal.direction,
    profit: calculateTradeProfit(signal),
    status: signal.status,
    date: signal.created_at,
  }));

  const totalProfit = tradeProfits.reduce((sum, t) => sum + t.profit, 0);
  const avgProfit = totalTrades > 0 ? totalProfit / totalTrades : 0;

  const bestTrade = tradeProfits.reduce((best, t) =>
    t.profit > (best?.profit ?? -Infinity) ? t : best, null
  );
  const worstTrade = tradeProfits.reduce((worst, t) =>
    t.profit < (worst?.profit ?? Infinity) ? t : worst, null
  );

  return {
    period: since,
    totalSignals: allSignals.length,
    closedTrades: totalTrades,
    winRate: Math.round(winRate * 100) / 100,
    avgProfit: Math.round(avgProfit * 100) / 100,
    totalProfit: Math.round(totalProfit * 100) / 100,
    bestTrade,
    worstTrade,
  };
}

/**
 * Calcule le profit d'un trade individuel.
 *
 * Logique :
 * - Si le trade a touché au moins un target : le profit est celui du premier
 *   target atteint (enregistré dans final_profit_pct)
 * - Si le trade a touché le stop loss : la perte est calculée avec le leverage
 * - Les profits sont exprimés en pourcentage du capital investi
 *
 * @param {Object} signal - Signal de la base de données
 * @returns {number} Profit en pourcentage (négatif = perte)
 */
function calculateTradeProfit(signal) {
  // Si un profit final est enregistré (target ou SL), l'utiliser directement
  if (signal.final_profit_pct !== null && signal.final_profit_pct !== undefined) {
    return signal.final_profit_pct;
  }

  // Sinon, calculer à partir des prix
  // Prix moyen d'entrée
  const entryPrice = (signal.entry_price_min + signal.entry_price_max) / 2;

  if (['sl_hit', 'stopped'].includes(signal.status)) {
    // Stop loss touché -> calculer la perte avec le leverage
    const priceDiff = signal.direction === 'SHORT'
      ? signal.stop_loss - entryPrice  // SHORT : perte si le prix monte
      : entryPrice - signal.stop_loss; // LONG : perte si le prix baisse
    const lossPct = (priceDiff / entryPrice) * 100 * signal.leverage;
    return -Math.abs(lossPct);
  }

  if (['tp_hit', 'all_tp_hit', 'closed', 'partial'].includes(signal.status)) {
    // Target atteint -> calculer le profit du premier target
    const targets = JSON.parse(signal.targets);
    if (targets.length > 0) {
      const firstTarget = targets[0];
      const priceDiff = signal.direction === 'SHORT'
        ? entryPrice - firstTarget  // SHORT : profit si le prix baisse
        : firstTarget - entryPrice; // LONG : profit si le prix monte
      const profitPct = (priceDiff / entryPrice) * 100 * signal.leverage;
      return Math.round(profitPct * 100) / 100;
    }
  }

  return 0;
}

/**
 * Calcule le drawdown maximum.
 * Le drawdown est la chute maximale du capital depuis un pic.
 *
 * Exemple : si le capital monte à +50% puis redescend à +20%,
 * le drawdown est de 30%.
 *
 * @param {Array} tradeProfits - Liste des profits par trade (chronologique)
 * @returns {number} Drawdown maximum en pourcentage
 */
function calculateMaxDrawdown(tradeProfits) {
  if (tradeProfits.length === 0) return 0;

  // Trier par date (du plus ancien au plus récent)
  const sorted = [...tradeProfits].sort((a, b) =>
    new Date(a.date) - new Date(b.date)
  );

  let cumulativeProfit = 0; // Profit cumulé actuel
  let peak = 0;             // Plus haut profit cumulé atteint
  let maxDrawdown = 0;      // Plus grand drawdown observé

  for (const trade of sorted) {
    cumulativeProfit += trade.profit;

    // Mettre à jour le pic si on est au-dessus
    if (cumulativeProfit > peak) {
      peak = cumulativeProfit;
    }

    // Calculer le drawdown actuel (écart entre le pic et la valeur actuelle)
    const drawdown = peak - cumulativeProfit;

    // Mettre à jour le drawdown maximum
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  return maxDrawdown;
}

module.exports = {
  calculateGlobalStats,
  calculateStatsSince,
};
