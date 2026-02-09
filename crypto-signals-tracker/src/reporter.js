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
// - Portfolio à 21h59 : etat du portefeuille virtuel
// - Quotidien à 23h00 : résumé du jour
// - Hebdomadaire dimanche 23h00 : stats complètes
// - Sur demande : commande /stats, /portfolio
// ============================================================

const { Bot } = require('grammy');
const cron = require('node-cron');
const stats = require('./stats-calculator');
const portfolio = require('./portfolio-simulator');
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
      '/portfolio - Portefeuille virtuel\n' +
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

  // ---- Commande /portfolio ----
  // Etat du portefeuille virtuel a la demande
  bot.command('portfolio', async (ctx) => {
    if (ctx.from.id !== adminUserId) return;
    try {
      const snap = portfolio.getPortfolioSnapshot();
      const msg = formatPortfolioReport(snap);
      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error(`Erreur commande /portfolio : ${err.message}`);
      await ctx.reply('Erreur lors du calcul du portefeuille.');
    }
  });

  // ---- Commande /diagnostic ----
  // Affiche l'etat du systeme et les compteurs de messages
  bot.command('diagnostic', async (ctx) => {
    if (ctx.from.id !== adminUserId) return;
    try {
      const telegramClient = require('./telegram-client');
      const database = require('./database');

      const counters = telegramClient.getMessageCounters();
      const dbCount = database.countSignals();
      const uptime = process.uptime();
      const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

      let msg = '🔧 *DIAGNOSTIC SYSTEME*\n';
      msg += '━━━━━━━━━━━━━━━━━━━━━━\n\n';

      msg += `⏱ *Uptime :* ${uptimeStr}\n`;
      msg += `🔌 *Telegram connecte :* ${telegramClient.isConnected() ? 'Oui ✅' : 'Non ❌'}\n\n`;

      msg += '📨 *Messages recus :*\n';
      msg += `  ├ Total : ${counters.total}\n`;
      msg += `  ├ Groupes cibles : ${counters.matched}\n`;
      msg += `  ├ Parses (texte) : ${counters.parsed}\n`;
      msg += `  ├ Autres chats : ${counters.unmatched}\n`;
      msg += `  └ Erreurs : ${counters.errors}\n\n`;

      msg += '💾 *Base de donnees :*\n';
      msg += `  ├ Total signaux : ${dbCount.total}\n`;
      msg += `  ├ Ouverts : ${dbCount.open}\n`;
      msg += `  ├ Gagnes : ${dbCount.won}\n`;
      msg += `  ├ Perdus : ${dbCount.lost}\n`;
      msg += `  └ Annules : ${dbCount.cancelled}\n\n`;

      if (counters.lastMessageAt) {
        msg += `📅 Dernier message : ${counters.lastMessageAt}\n`;
      } else {
        msg += `⚠️ _Aucun message recu depuis le demarrage_\n`;
      }

      if (counters.total === 0) {
        msg += '\n🔴 *ATTENTION :* Aucun message recu !\n';
        msg += 'Verifiez :\n';
        msg += '1. La session MTProto est valide\n';
        msg += '2. Le compte est membre des groupes\n';
        msg += '3. Les IDs de groupes sont corrects\n';
      } else if (counters.matched === 0 && counters.total > 0) {
        msg += '\n🟡 *ATTENTION :* Messages recus mais aucun des groupes cibles !\n';
        msg += 'Les IDs des groupes ne correspondent peut-etre pas.\n';
        msg += 'Verifiez TARGET\\_GROUP\\_IDS dans .env\n';
      }

      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error(`Erreur commande /diagnostic : ${err.message}`);
      await ctx.reply(`Erreur diagnostic : ${err.message}`);
    }
  });

  // ---- Commande /help ----
  bot.command('help', async (ctx) => {
    if (ctx.from.id !== adminUserId) return;
    await ctx.reply(
      '📖 *Aide - Crypto Signals Tracker*\n\n' +
      '/stats - Statistiques globales (tous les trades)\n' +
      '/portfolio - Portefeuille virtuel\n' +
      '/today - Résumé de la journée en cours\n' +
      '/week - Résumé des 7 derniers jours\n' +
      '/open - Liste des trades en cours\n' +
      '/diagnostic - Etat du systeme et diagnostic\n' +
      '/help - Ce message d\'aide\n\n' +
      'Les rapports automatiques sont envoyés :\n' +
      '• Chaque jour à 21h59 (portfolio)\n' +
      '• Chaque jour à 23h00 (résumé)\n' +
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
 * @param {Object} reportConfig - Configuration { dailyTime, weeklyDay, weeklyTime, portfolioTime }
 */
function scheduleReports(reportConfig) {
  const [dailyHour, dailyMinute] = reportConfig.dailyTime.split(':');
  const [weeklyHour, weeklyMinute] = reportConfig.weeklyTime.split(':');
  const [portfolioHour, portfolioMinute] = (reportConfig.portfolioTime || '21:59').split(':');

  // ---- Rapport portfolio à 21:59 ----
  // Etat du portefeuille virtuel chaque jour
  cron.schedule(`${portfolioMinute} ${portfolioHour} * * *`, async () => {
    logger.info('Envoi du rapport portfolio automatique...');
    try {
      const snap = portfolio.getPortfolioSnapshot();
      const message = formatPortfolioReport(snap);
      await sendReport(message);

      // Envoyer les alertes si necessaire
      const alerts = portfolio.checkAlerts();
      for (const alert of alerts) {
        await sendReport(alert);
      }
    } catch (err) {
      logger.error(`Erreur rapport portfolio : ${err.message}`);
    }
  });
  logger.info(`Rapport portfolio programmé à ${reportConfig.portfolioTime || '21:59'}`);

  // ---- Rapport quotidien ----
  // Planifié chaque jour à l'heure configurée
  cron.schedule(`${dailyMinute} ${dailyHour} * * *`, async () => {
    logger.info('Envoi du rapport quotidien automatique...');
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const periodStats = stats.calculateStatsSince(today.toISOString());
      const snap = portfolio.getPortfolioSnapshot();
      const message = formatDailyReport(periodStats, snap);
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
      const snap = portfolio.getPortfolioSnapshot();
      const message = formatWeeklyReport(periodStats, globalStats, snap);
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
  msg += `📋 *Signaux recus :* ${counts.total}\n`;
  msg += `  ├ En cours : ${counts.open}\n`;
  msg += `  ├ Gagnants : ${counts.won}\n`;
  msg += `  ├ Perdants : ${counts.lost}\n`;
  msg += `  └ Annules : ${counts.cancelled}\n`;

  // Breakdown par groupe si disponible
  try {
    const database = require('./database');
    const groups = database.getGroups();
    if (groups.length > 1) {
      const allSignals = database.getSignals();
      const groupCounts = {};
      for (const s of allSignals) {
        const g = s.source_group_name || 'Inconnu';
        groupCounts[g] = (groupCounts[g] || 0) + 1;
      }
      msg += '  📡 ';
      msg += Object.entries(groupCounts).map(([g, c]) => {
        // Nom court du groupe
        const short = g.replace('CryptoMau ', '').replace(' Trading Signals', '').replace(' Signals', '');
        return `${c} ${short}`;
      }).join(', ');
      msg += '\n';
    }
  } catch (err) {
    // Ignorer les erreurs de comptage par groupe
  }
  msg += '\n';

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
 * Formate le rapport quotidien avec resume du portefeuille.
 * @param {Object} periodStats - Stats de la journée
 * @param {Object} [snap] - Snapshot du portefeuille (optionnel)
 * @returns {string} Message formaté
 */
function formatDailyReport(periodStats, snap) {
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

  // Ajouter le resume du portefeuille si disponible
  if (snap) {
    msg += '\n━━━━━━━━━━━━━━━━━━━━━━\n';
    msg += '💼 *Portefeuille :*\n';
    msg += `  Capital : ${snap.current.toFixed(2)}$\n`;
    msg += `  ROI : ${snap.roi > 0 ? '+' : ''}${snap.roi}%\n`;
    msg += `  Gain : ${snap.totalGain > 0 ? '+' : ''}${snap.totalGain.toFixed(2)}$\n`;
  }

  return msg;
}

/**
 * Formate le rapport hebdomadaire avec resume du portefeuille.
 * @param {Object} periodStats - Stats de la semaine
 * @param {Object} [globalStats] - Stats globales (optionnel)
 * @param {Object} [snap] - Snapshot du portefeuille (optionnel)
 * @returns {string} Message formaté
 */
function formatWeeklyReport(periodStats, globalStats, snap) {
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

  // Ajouter le resume du portefeuille si disponible
  if (snap) {
    msg += '\n━━━━━━━━━━━━━━━━━━━━━━\n';
    msg += '💼 *Portefeuille virtuel :*\n';
    msg += `  Capital : ${snap.current.toFixed(2)}$\n`;
    msg += `  ROI : ${snap.roi > 0 ? '+' : ''}${snap.roi}%\n`;
    msg += `  Gain : ${snap.totalGain > 0 ? '+' : ''}${snap.totalGain.toFixed(2)}$\n`;
    msg += `  Frais total : ${snap.totalFees.toFixed(2)}$\n`;
  }

  return msg;
}

/**
 * Formate le rapport du portefeuille virtuel.
 * @param {Object} snap - Snapshot du portefeuille
 * @returns {string} Message formaté
 */
function formatPortfolioReport(snap) {
  let msg = '💼 *PORTEFEUILLE VIRTUEL*\n';
  msg += '━━━━━━━━━━━━━━━━━━━━━━\n\n';

  msg += `💰 *Capital actuel :* ${snap.current.toFixed(2)}$\n`;
  msg += `🏦 *Capital initial :* ${snap.initial.toFixed(2)}$\n\n`;

  // Performance
  const roiSign = snap.roi >= 0 ? '+' : '';
  const gainSign = snap.totalGain >= 0 ? '+' : '';
  msg += `📈 *ROI :* ${roiSign}${snap.roi}%\n`;
  msg += `💵 *Gain net :* ${gainSign}${snap.totalGain.toFixed(2)}$\n`;
  msg += `💸 *Frais cumules :* ${snap.totalFees.toFixed(2)}$\n\n`;

  // Trades
  msg += `📊 *Trades :* ${snap.totalTrades}\n`;
  msg += `  ├ Gagnants : ${snap.winCount}\n`;
  msg += `  ├ Perdants : ${snap.lossCount}\n`;
  msg += `  └ Win Rate : ${snap.winRate}%\n\n`;

  // Pertes consecutives
  if (snap.maxConsecutiveLosses > 0) {
    msg += `⚠️ Pertes consecutives max : ${snap.maxConsecutiveLosses}\n`;
  }

  // Derniers trades (5 derniers)
  const recentTrades = snap.history.filter(h => h.trade !== null).slice(-5);
  if (recentTrades.length > 0) {
    msg += '\n📋 *Derniers trades :*\n';
    for (const t of recentTrades) {
      const sign = t.profitNet >= 0 ? '+' : '';
      msg += `  • ${t.pair} : ${sign}${t.profitNet.toFixed(2)}$ → ${t.capital.toFixed(2)}$\n`;
    }
  }

  return msg;
}

/**
 * Envoie une notification immédiate pour un nouveau signal.
 * @param {Object} signal - Signal parsé
 */
async function notifyNewSignal(signal) {
  let msg = `🔔 *Nouveau signal detecte !*\n\n`;
  msg += `*${signal.pair}* ${signal.direction} X${signal.leverage}\n`;
  msg += `Entree : $${signal.entryPriceMin} - $${signal.entryPriceMax}\n`;
  msg += `Stop Loss : $${signal.stopLoss}\n`;
  msg += `Targets : ${signal.targets.length}\n`;
  if (signal.sourceGroup) {
    msg += `📡 Groupe : ${signal.sourceGroup}\n`;
  }
  if (signal.emitter) {
    msg += `Source : ${signal.emitter}`;
  }
  await sendReport(msg);
}

/**
 * Envoie une notification pour un target atteint avec impact portfolio.
 * @param {Object} confirmation - Confirmation parsée
 */
async function notifyConfirmation(confirmation) {
  let msg = `✅ *Target atteint !*\n\n`;
  msg += `*${confirmation.pair}* - TP${confirmation.targetNumber}\n`;
  msg += `Profit : +${confirmation.profitPct}%\n`;
  if (confirmation.period) {
    msg += `Duree : ${confirmation.period}\n`;
  }
  if (confirmation.sourceGroup) {
    msg += `📡 ${confirmation.sourceGroup}\n`;
  }

  // Ajouter l'impact sur le portefeuille
  try {
    const snap = portfolio.getPortfolioSnapshot();
    msg += `\n💼 Capital : ${snap.current.toFixed(2)}$ (ROI: ${snap.roi > 0 ? '+' : ''}${snap.roi}%)`;
  } catch (err) {
    logger.error(`Erreur calcul portfolio pour notification : ${err.message}`);
  }

  await sendReport(msg);
}

/**
 * Envoie une notification pour un stop loss avec impact portfolio.
 * @param {Object} slData - Données du stop loss
 */
async function notifyStopLoss(slData) {
  let msg = `❌ *Stop Loss touche !*\n\n`;
  msg += `*${slData.pair}*\n`;
  if (slData.lossPct) {
    msg += `Perte : -${slData.lossPct}%\n`;
  }
  if (slData.period) {
    msg += `Duree : ${slData.period}\n`;
  }
  if (slData.sourceGroup) {
    msg += `📡 ${slData.sourceGroup}\n`;
  }

  // Ajouter l'impact sur le portefeuille
  try {
    const snap = portfolio.getPortfolioSnapshot();
    msg += `\n💼 Capital : ${snap.current.toFixed(2)}$ (ROI: ${snap.roi > 0 ? '+' : ''}${snap.roi}%)`;
  } catch (err) {
    logger.error(`Erreur calcul portfolio pour notification : ${err.message}`);
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
