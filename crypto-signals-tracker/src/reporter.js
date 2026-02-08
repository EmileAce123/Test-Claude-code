// ============================================================
// reporter.js - Envoi de rapports via Bot Telegram
// ============================================================
// Ce module utilise un bot Telegram SÉPARÉ pour envoyer
// des rapports de performance à votre compte.
//
// Le bot utilise l'API Bot Telegram (pas MTProto).
// C'est un bot classique créé via @BotFather.
//
// Rapports automatiques :
// - Quotidien à 23h00 : résumé du jour
// - Hebdomadaire dimanche 23h00 : stats complètes
// - Sur demande : commande /stats
// ============================================================

const { Bot } = require('grammy');
const cron = require('node-cron');
const stats = require('./stats-calculator');
const logger = require('./logger');

// Variable qui stocke l'instance du bot
let bot = null;

// ID de l'admin (vous) pour les commandes
let adminUserId = null;

/**
 * Initialise le bot Telegram pour les rapports.
 * @param {Object} config - Configuration { token, adminUserId }
 */
async function init(config) {
  adminUserId = config.adminUserId;

  // Créer le bot avec le token de @BotFather
  bot = new Bot(config.token);

  // ---- Commande /start ----
  // Réponse de bienvenue quand quelqu'un démarre le bot
  bot.command('start', async (ctx) => {
    // Vérifier que c'est bien l'admin
    if (ctx.from.id !== adminUserId) {
      await ctx.reply('Accès refusé. Ce bot est privé.');
      return;
    }
    await ctx.reply(
      '🤖 *Crypto Signals Tracker* est actif !\n\n' +
      'Commandes disponibles :\n' +
      '/stats - Statistiques globales\n' +
      '/today - Résumé du jour\n' +
      '/week - Résumé de la semaine\n' +
      '/open - Trades en cours\n' +
      '/help - Aide',
      { parse_mode: 'Markdown' }
    );
  });

  // ---- Commande /stats ----
  // Statistiques globales à la demande
  bot.command('stats', async (ctx) => {
    if (ctx.from.id !== adminUserId) return;
    try {
      const globalStats = stats.calculateGlobalStats();
      const message = formatGlobalStats(globalStats);
      await ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error(`Erreur commande /stats : ${err.message}`);
      await ctx.reply('Erreur lors du calcul des statistiques.');
    }
  });

  // ---- Commande /today ----
  // Résumé du jour
  bot.command('today', async (ctx) => {
    if (ctx.from.id !== adminUserId) return;
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const periodStats = stats.calculateStatsSince(today.toISOString());
      const message = formatDailyReport(periodStats);
      await ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error(`Erreur commande /today : ${err.message}`);
      await ctx.reply('Erreur lors du calcul des stats du jour.');
    }
  });

  // ---- Commande /week ----
  // Résumé de la semaine
  bot.command('week', async (ctx) => {
    if (ctx.from.id !== adminUserId) return;
    try {
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      const periodStats = stats.calculateStatsSince(weekAgo.toISOString());
      const message = formatWeeklyReport(periodStats);
      await ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error(`Erreur commande /week : ${err.message}`);
      await ctx.reply('Erreur lors du calcul des stats hebdomadaires.');
    }
  });

  // ---- Commande /open ----
  // Trades actuellement en cours
  bot.command('open', async (ctx) => {
    if (ctx.from.id !== adminUserId) return;
    try {
      const database = require('./database');
      const openSignals = database.getSignals('open');
      if (openSignals.length === 0) {
        await ctx.reply('Aucun trade ouvert actuellement.');
        return;
      }
      let message = '📊 *Trades ouverts :*\n\n';
      for (const s of openSignals) {
        const targets = JSON.parse(s.targets);
        message += `• *${s.pair}* ${s.direction} X${s.leverage}\n`;
        message += `  Entrée: $${s.entry_price_min} - $${s.entry_price_max}\n`;
        message += `  SL: $${s.stop_loss} | Targets: ${targets.length}\n\n`;
      }
      await ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error(`Erreur commande /open : ${err.message}`);
      await ctx.reply('Erreur lors de la récupération des trades ouverts.');
    }
  });

  // ---- Commande /help ----
  bot.command('help', async (ctx) => {
    if (ctx.from.id !== adminUserId) return;
    await ctx.reply(
      '📖 *Aide - Crypto Signals Tracker*\n\n' +
      '/stats - Statistiques globales (tous les trades)\n' +
      '/today - Résumé de la journée en cours\n' +
      '/week - Résumé des 7 derniers jours\n' +
      '/open - Liste des trades en cours\n' +
      '/help - Ce message d\'aide\n\n' +
      'Les rapports automatiques sont envoyés :\n' +
      '• Chaque jour à 23h00\n' +
      '• Chaque dimanche à 23h00',
      { parse_mode: 'Markdown' }
    );
  });

  // Démarrer le bot (en mode polling = il vérifie régulièrement les messages)
  bot.start();
  logger.info('Bot de rapports démarré');
}

/**
 * Programme les rapports automatiques avec cron.
 * @param {Object} reportConfig - Configuration { dailyTime, weeklyDay, weeklyTime }
 */
function scheduleReports(reportConfig) {
  const [dailyHour, dailyMinute] = reportConfig.dailyTime.split(':');
  const [weeklyHour, weeklyMinute] = reportConfig.weeklyTime.split(':');

  // ---- Rapport quotidien ----
  // Planifié chaque jour à l'heure configurée
  cron.schedule(`${dailyMinute} ${dailyHour} * * *`, async () => {
    logger.info('Envoi du rapport quotidien automatique...');
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const periodStats = stats.calculateStatsSince(today.toISOString());
      const message = formatDailyReport(periodStats);
      await sendReport(message);
    } catch (err) {
      logger.error(`Erreur rapport quotidien : ${err.message}`);
    }
  });
  logger.info(`Rapport quotidien programmé à ${reportConfig.dailyTime}`);

  // ---- Rapport hebdomadaire ----
  // Planifié le jour configuré (0=dimanche) à l'heure configurée
  cron.schedule(`${weeklyMinute} ${weeklyHour} * * ${reportConfig.weeklyDay}`, async () => {
    logger.info('Envoi du rapport hebdomadaire automatique...');
    try {
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      const periodStats = stats.calculateStatsSince(weekAgo.toISOString());
      const globalStats = stats.calculateGlobalStats();
      const message = formatWeeklyReport(periodStats, globalStats);
      await sendReport(message);
    } catch (err) {
      logger.error(`Erreur rapport hebdomadaire : ${err.message}`);
    }
  });
  logger.info(`Rapport hebdomadaire programmé : jour ${reportConfig.weeklyDay} à ${reportConfig.weeklyTime}`);
}

/**
 * Envoie un rapport à l'admin via le bot.
 * @param {string} message - Message formaté en Markdown
 */
async function sendReport(message) {
  if (!bot || !adminUserId) {
    logger.error('Bot non initialisé ou admin non configuré');
    return;
  }

  try {
    await bot.api.sendMessage(adminUserId, message, { parse_mode: 'Markdown' });
    logger.info('Rapport envoyé avec succès');
  } catch (err) {
    logger.error(`Erreur envoi rapport : ${err.message}`);
  }
}

// ============================================================
// FORMATAGE DES RAPPORTS
// ============================================================

/**
 * Formate les statistiques globales en message lisible.
 * @param {Object} globalStats - Statistiques calculées
 * @returns {string} Message formaté en Markdown
 */
function formatGlobalStats(globalStats) {
  const { counts, winRate, avgProfit, totalProfit, bestTrade, worstTrade, maxDrawdown, totalTrades } = globalStats;

  let msg = '📊 *STATISTIQUES GLOBALES*\n';
  msg += '━━━━━━━━━━━━━━━━━━━━━━\n\n';

  // Compteurs
  msg += `📋 *Signaux reçus :* ${counts.total}\n`;
  msg += `  ├ En cours : ${counts.open}\n`;
  msg += `  ├ Gagnants : ${counts.won}\n`;
  msg += `  ├ Perdants : ${counts.lost}\n`;
  msg += `  └ Annulés : ${counts.cancelled}\n\n`;

  // Performance
  msg += `🎯 *Performance (${totalTrades} trades terminés) :*\n`;
  msg += `  ├ Win Rate : ${winRate}%\n`;
  msg += `  ├ Profit moyen/trade : ${avgProfit > 0 ? '+' : ''}${avgProfit}%\n`;
  msg += `  ├ Profit total cumulé : ${totalProfit > 0 ? '+' : ''}${totalProfit}%\n`;
  msg += `  └ Drawdown max : ${maxDrawdown}%\n\n`;

  // Meilleur/pire trade
  if (bestTrade) {
    msg += `🏆 *Meilleur trade :* ${bestTrade.pair} ${bestTrade.direction} → +${bestTrade.profit}%\n`;
  }
  if (worstTrade) {
    msg += `💀 *Pire trade :* ${worstTrade.pair} ${worstTrade.direction} → ${worstTrade.profit}%\n`;
  }

  return msg;
}

/**
 * Formate le rapport quotidien.
 * @param {Object} periodStats - Stats de la journée
 * @returns {string} Message formaté
 */
function formatDailyReport(periodStats) {
  const today = new Date().toLocaleDateString('fr-FR', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  let msg = `📅 *RAPPORT QUOTIDIEN*\n`;
  msg += `_${today}_\n`;
  msg += '━━━━━━━━━━━━━━━━━━━━━━\n\n';

  msg += `📋 Signaux reçus aujourd'hui : ${periodStats.totalSignals}\n`;
  msg += `✅ Trades terminés : ${periodStats.closedTrades}\n\n`;

  if (periodStats.closedTrades > 0) {
    msg += `🎯 Win Rate : ${periodStats.winRate}%\n`;
    msg += `💰 Profit moyen : ${periodStats.avgProfit > 0 ? '+' : ''}${periodStats.avgProfit}%\n`;
    msg += `📈 Profit total du jour : ${periodStats.totalProfit > 0 ? '+' : ''}${periodStats.totalProfit}%\n\n`;

    if (periodStats.bestTrade) {
      msg += `🏆 Meilleur : ${periodStats.bestTrade.pair} → +${periodStats.bestTrade.profit}%\n`;
    }
    if (periodStats.worstTrade) {
      msg += `💀 Pire : ${periodStats.worstTrade.pair} → ${periodStats.worstTrade.profit}%\n`;
    }
  } else {
    msg += '_Aucun trade terminé aujourd\'hui._\n';
  }

  return msg;
}

/**
 * Formate le rapport hebdomadaire.
 * @param {Object} periodStats - Stats de la semaine
 * @param {Object} [globalStats] - Stats globales (optionnel)
 * @returns {string} Message formaté
 */
function formatWeeklyReport(periodStats, globalStats) {
  let msg = '📊 *RAPPORT HEBDOMADAIRE*\n';
  msg += '━━━━━━━━━━━━━━━━━━━━━━\n\n';

  msg += `📋 Signaux cette semaine : ${periodStats.totalSignals}\n`;
  msg += `✅ Trades terminés : ${periodStats.closedTrades}\n\n`;

  if (periodStats.closedTrades > 0) {
    msg += `🎯 Win Rate : ${periodStats.winRate}%\n`;
    msg += `💰 Profit moyen : ${periodStats.avgProfit > 0 ? '+' : ''}${periodStats.avgProfit}%\n`;
    msg += `📈 Profit semaine : ${periodStats.totalProfit > 0 ? '+' : ''}${periodStats.totalProfit}%\n\n`;

    if (periodStats.bestTrade) {
      msg += `🏆 Meilleur : ${periodStats.bestTrade.pair} → +${periodStats.bestTrade.profit}%\n`;
    }
    if (periodStats.worstTrade) {
      msg += `💀 Pire : ${periodStats.worstTrade.pair} → ${periodStats.worstTrade.profit}%\n`;
    }
  }

  // Ajouter les stats globales si disponibles
  if (globalStats) {
    msg += '\n━━━━━━━━━━━━━━━━━━━━━━\n';
    msg += '📊 *Résumé global :*\n';
    msg += `  Total trades : ${globalStats.totalTrades}\n`;
    msg += `  Win Rate global : ${globalStats.winRate}%\n`;
    msg += `  Profit cumulé : ${globalStats.totalProfit > 0 ? '+' : ''}${globalStats.totalProfit}%\n`;
  }

  return msg;
}

/**
 * Envoie une notification immédiate pour un nouveau signal.
 * @param {Object} signal - Signal parsé
 */
async function notifyNewSignal(signal) {
  let msg = `🔔 *Nouveau signal détecté !*\n\n`;
  msg += `*${signal.pair}* ${signal.direction} X${signal.leverage}\n`;
  msg += `Entrée : $${signal.entryPriceMin} - $${signal.entryPriceMax}\n`;
  msg += `Stop Loss : $${signal.stopLoss}\n`;
  msg += `Targets : ${signal.targets.length}\n`;
  if (signal.emitter) {
    msg += `Source : ${signal.emitter}`;
  }
  await sendReport(msg);
}

/**
 * Envoie une notification pour un target atteint.
 * @param {Object} confirmation - Confirmation parsée
 */
async function notifyConfirmation(confirmation) {
  let msg = `✅ *Target atteint !*\n\n`;
  msg += `*${confirmation.pair}* - TP${confirmation.targetNumber}\n`;
  msg += `Profit : +${confirmation.profitPct}%\n`;
  if (confirmation.period) {
    msg += `Durée : ${confirmation.period}`;
  }
  await sendReport(msg);
}

/**
 * Envoie une notification pour un stop loss.
 * @param {Object} slData - Données du stop loss
 */
async function notifyStopLoss(slData) {
  let msg = `❌ *Stop Loss touché !*\n\n`;
  msg += `*${slData.pair}*\n`;
  if (slData.lossPct) {
    msg += `Perte : -${slData.lossPct}%\n`;
  }
  if (slData.period) {
    msg += `Durée : ${slData.period}`;
  }
  await sendReport(msg);
}

/**
 * Arrête proprement le bot.
 */
async function stop() {
  if (bot) {
    await bot.stop();
    logger.info('Bot de rapports arrêté');
  }
}

module.exports = {
  init,
  scheduleReports,
  sendReport,
  notifyNewSignal,
  notifyConfirmation,
  notifyStopLoss,
  stop,
};
