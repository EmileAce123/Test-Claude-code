// ============================================================
// routes.js - Endpoints API du dashboard
// ============================================================
//
// GET  /api/stats              → Statistiques globales
// GET  /api/trades             → Liste des trades (avec filtres)
// GET  /api/trades/active      → Positions ouvertes
// GET  /api/trades/:id/executions → Executions d'un trade
// POST /api/trades/:id/close   → Fermeture manuelle
// GET  /api/chart-data         → Données pour les graphiques
// GET  /api/pairs              → Liste des paires disponibles
// GET  /api/groups             → Liste des groupes sources
// GET  /api/export-csv         → Export CSV des trades
// GET  /api/health             → Statut du système
// GET  /api/portfolio          → Etat du portefeuille virtuel
// GET  /api/portfolio/exposure  → Exposition actuelle
// GET  /api/prices/current     → Prix actuels des positions
// ============================================================

const express = require('express');
const database = require('../database');
const statsCalculator = require('../stats-calculator');
const portfolio = require('../portfolio-simulator');
const binanceClient = require('../binance-client');
const priceUpdater = require('../price-updater');
const tradingEngine = require('../trading-engine');
const logger = require('../logger');
const fs = require('fs');
const path = require('path');

const router = express.Router();

// ---- GET /api/stats ----
// Retourne les statistiques globales
router.get('/stats', (req, res) => {
  try {
    const stats = statsCalculator.calculateGlobalStats();
    res.json(stats);
  } catch (err) {
    logger.error(`Erreur API /stats : ${err.message}`);
    res.status(500).json({ error: 'Erreur calcul des statistiques' });
  }
});

// ---- GET /api/trades ----
// Retourne la liste des trades avec filtres optionnels
// Query params :
//   ?status=open|tp_hit|sl_hit|cancelled
//   ?pair=POL/USDT
//   ?group=CryptoMau BTC Scalp Signals
//   ?from=2024-01-01
//   ?to=2024-12-31
//   ?page=1&limit=50
router.get('/trades', (req, res) => {
  try {
    const { status, pair, group, from, to, page = 1, limit = 50 } = req.query;

    // Recuperer tous les signaux
    let signals = database.getSignals(status || undefined);

    // Filtre par groupe source
    if (group) {
      signals = signals.filter(s => s.source_group_name === group);
    }

    // Filtre par paire
    if (pair) {
      const pairUpper = pair.toUpperCase();
      signals = signals.filter(s => s.pair === pairUpper);
    }

    // Filtre par date de debut
    if (from) {
      signals = signals.filter(s => s.created_at >= from);
    }

    // Filtre par date de fin
    if (to) {
      signals = signals.filter(s => s.created_at <= to + ' 23:59:59');
    }

    // Pagination
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const total = signals.length;
    const totalPages = Math.ceil(total / limitNum);
    const offset = (pageNum - 1) * limitNum;
    const paginated = signals.slice(offset, offset + limitNum);

    // Parser les targets JSON pour chaque signal
    const formatted = paginated.map(s => ({
      ...s,
      targets: JSON.parse(s.targets),
    }));

    res.json({
      trades: formatted,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages,
      },
    });
  } catch (err) {
    logger.error(`Erreur API /trades : ${err.message}`);
    res.status(500).json({ error: 'Erreur récupération des trades' });
  }
});

// ---- GET /api/chart-data ----
// Retourne les données formatées pour les graphiques Chart.js
router.get('/chart-data', (req, res) => {
  try {
    const stats = statsCalculator.calculateGlobalStats();

    // ---- 1. Courbe de profit cumulé dans le temps ----
    const sortedTrades = [...stats.trades].sort((a, b) =>
      new Date(a.date) - new Date(b.date)
    );
    let cumulative = 0;
    const profitOverTime = sortedTrades.map(t => {
      cumulative += t.profit;
      return {
        date: t.date,
        profit: Math.round(cumulative * 100) / 100,
        pair: t.pair,
      };
    });

    // ---- 2. Performance par paire ----
    const pairStats = {};
    for (const trade of stats.trades) {
      if (!pairStats[trade.pair]) {
        pairStats[trade.pair] = { wins: 0, losses: 0, totalProfit: 0, count: 0 };
      }
      const ps = pairStats[trade.pair];
      ps.count += 1;
      ps.totalProfit += trade.profit;
      if (trade.profit >= 0) ps.wins += 1;
      else ps.losses += 1;
    }
    const byPair = Object.entries(pairStats).map(([pair, data]) => ({
      pair,
      trades: data.count,
      wins: data.wins,
      losses: data.losses,
      winRate: data.count > 0 ? Math.round((data.wins / data.count) * 10000) / 100 : 0,
      totalProfit: Math.round(data.totalProfit * 100) / 100,
      avgProfit: data.count > 0 ? Math.round((data.totalProfit / data.count) * 100) / 100 : 0,
    }));

    // ---- 3. Performance par jour de la semaine ----
    const dayNames = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
    const byDay = [0, 1, 2, 3, 4, 5, 6].map(d => ({
      day: dayNames[d],
      trades: 0, wins: 0, losses: 0, totalProfit: 0,
    }));
    for (const trade of stats.trades) {
      const dayIndex = new Date(trade.date).getDay();
      byDay[dayIndex].trades += 1;
      byDay[dayIndex].totalProfit += trade.profit;
      if (trade.profit >= 0) byDay[dayIndex].wins += 1;
      else byDay[dayIndex].losses += 1;
    }
    byDay.forEach(d => {
      d.totalProfit = Math.round(d.totalProfit * 100) / 100;
      d.winRate = d.trades > 0 ? Math.round((d.wins / d.trades) * 10000) / 100 : 0;
    });

    // ---- 4. Distribution des profits ----
    const profitDistribution = { bins: [], counts: [] };
    if (stats.trades.length > 0) {
      const profits = stats.trades.map(t => t.profit);
      const min = Math.floor(Math.min(...profits) / 10) * 10;
      const max = Math.ceil(Math.max(...profits) / 10) * 10;
      const step = Math.max(5, Math.round((max - min) / 10));
      for (let i = min; i <= max; i += step) {
        const binLabel = `${i} à ${i + step}%`;
        const count = profits.filter(p => p >= i && p < i + step).length;
        profitDistribution.bins.push(binLabel);
        profitDistribution.counts.push(count);
      }
    }

    res.json({
      profitOverTime,
      byPair,
      byDay,
      profitDistribution,
    });
  } catch (err) {
    logger.error(`Erreur API /chart-data : ${err.message}`);
    res.status(500).json({ error: 'Erreur calcul des données graphiques' });
  }
});

// ---- GET /api/pairs ----
// Retourne la liste des paires distinctes
router.get('/pairs', (req, res) => {
  try {
    const signals = database.getSignals();
    const pairs = [...new Set(signals.map(s => s.pair))].sort();
    res.json(pairs);
  } catch (err) {
    logger.error(`Erreur API /pairs : ${err.message}`);
    res.status(500).json({ error: 'Erreur récupération des paires' });
  }
});

// ---- GET /api/groups ----
// Retourne la liste des groupes sources distincts
router.get('/groups', (req, res) => {
  try {
    const groups = database.getGroups();
    res.json(groups);
  } catch (err) {
    logger.error(`Erreur API /groups : ${err.message}`);
    res.status(500).json({ error: 'Erreur recuperation des groupes' });
  }
});

// ---- GET /api/export-csv ----
// Exporte tous les trades en CSV
router.get('/export-csv', (req, res) => {
  try {
    const signals = database.getSignals();

    // En-tete CSV
    const header = 'Date,Paire,Direction,Entree Min,Entree Max,Leverage,Stop Loss,Targets Atteints,Profit %,P&L Net $,Statut,Groupe Source\n';

    // Lignes CSV
    const rows = signals.map(s => {
      const targets = JSON.parse(s.targets);
      return [
        s.created_at,
        s.pair,
        s.direction,
        s.entry_price_min,
        s.entry_price_max,
        s.leverage,
        s.stop_loss,
        s.last_target_hit + '/' + targets.length,
        s.final_profit_pct || 0,
        s.net_profit_loss || 0,
        s.status,
        '"' + (s.source_group_name || '') + '"',
      ].join(',');
    }).join('\n');

    const csv = header + rows;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=trades_export.csv');
    res.send(csv);

    logger.info('Export CSV effectué');
  } catch (err) {
    logger.error(`Erreur API /export-csv : ${err.message}`);
    res.status(500).json({ error: 'Erreur export CSV' });
  }
});

// ---- GET /api/health ----
// Vérifie si le système fonctionne
router.get('/health', (req, res) => {
  try {
    // Vérifier que la base de données répond
    const count = database.countSignals();

    // Vérifier si le fichier PID du tracker existe (indicateur PM2)
    let trackerActive = false;
    let lastLogLine = null;
    try {
      // Vérifier via le fichier de log s'il y a eu de l'activité récente
      const logPath = path.join(__dirname, '..', '..', 'logs', 'app.log');
      if (fs.existsSync(logPath)) {
        const stat = fs.statSync(logPath);
        // Actif si le fichier de log a été modifié dans les 5 dernières minutes
        trackerActive = (Date.now() - stat.mtimeMs) < 5 * 60 * 1000;

        // Lire les dernieres lignes du log pour le diagnostic
        try {
          const logContent = fs.readFileSync(logPath, 'utf-8');
          const lines = logContent.trim().split('\n');
          lastLogLine = lines.slice(-5).join('\n');
        } catch (e) {
          // Ignorer
        }
      }
    } catch (e) {
      // Ignorer l'erreur
    }

    res.json({
      status: 'ok',
      database: 'connected',
      signals: count,
      trackerActive,
      uptime: process.uptime(),
      lastLogLine,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ---- GET /api/portfolio ----
// Retourne l'etat actuel du portefeuille (virtuel ou reel selon le mode)
router.get('/portfolio', async (req, res) => {
  try {
    if (tradingEngine.isActive()) {
      // Mode trading reel : retourner donnees Binance
      const info = await tradingEngine.getAccountInfo();
      const positions = await tradingEngine.syncPositions();
      res.json({
        mode: tradingEngine.mode,
        source: 'binance',
        current: info.totalBalance,
        available: info.availableBalance,
        unrealizedPnl: info.unrealizedPnl,
        marginBalance: info.marginBalance,
        openPositions: positions.length,
        positions: positions.map(p => ({
          symbol: p.symbol,
          side: p.side,
          leverage: p.leverage,
          entryPrice: p.entryPrice,
          currentPrice: p.currentPrice,
          unrealizedPnl: p.unrealizedPnl,
          liquidationPrice: p.liquidationPrice,
        })),
      });
    } else {
      // Mode simulation : portefeuille virtuel
      const snap = portfolio.getPortfolioSnapshot();
      snap.mode = 'simulation';
      snap.source = 'virtual';
      res.json(snap);
    }
  } catch (err) {
    logger.error(`Erreur API /portfolio : ${err.message}`);
    res.status(500).json({ error: 'Erreur calcul du portefeuille' });
  }
});

// ---- GET /api/portfolio-history ----
// Retourne l'historique du portefeuille pour le graphique
router.get('/portfolio-history', (req, res) => {
  try {
    const snap = portfolio.getPortfolioSnapshot();
    // Retourner l'historique avec les points de capital
    res.json({
      history: snap.history,
      initial: snap.initial,
      current: snap.current,
      roi: snap.roi,
    });
  } catch (err) {
    logger.error(`Erreur API /portfolio-history : ${err.message}`);
    res.status(500).json({ error: 'Erreur historique du portefeuille' });
  }
});

// ---- GET /api/portfolio/best-worst ----
// Retourne les 5 meilleurs et 5 pires trades en $ net
router.get('/portfolio/best-worst', (req, res) => {
  try {
    const result = portfolio.getBestWorstTrades();
    res.json(result);
  } catch (err) {
    logger.error(`Erreur API /portfolio/best-worst : ${err.message}`);
    res.status(500).json({ error: 'Erreur best/worst trades' });
  }
});

// ---- GET /api/trades/active ----
// Retourne les trades avec positions partiellement ouvertes
router.get('/trades/active', (req, res) => {
  try {
    const activePositions = database.getActivePositions();
    const formatted = activePositions.map(s => {
      const executions = database.getTradeExecutions(s.id);
      const targetsHit = [...new Set(executions.filter(e => e.target_number > 0 && e.target_number !== 999).map(e => `TP${e.target_number}`))];
      return {
        ...s,
        targets: JSON.parse(s.targets),
        executions,
        targetsHitList: targetsHit,
        positionClosedPercent: 100 - (s.position_remaining_percent || 100),
      };
    });
    res.json(formatted);
  } catch (err) {
    logger.error(`Erreur API /trades/active : ${err.message}`);
    res.status(500).json({ error: 'Erreur recuperation positions actives' });
  }
});

// ---- GET /api/trades/:id/executions ----
// Retourne les executions pyramidales d'un trade
router.get('/trades/:id/executions', (req, res) => {
  try {
    const signalId = parseInt(req.params.id, 10);
    if (isNaN(signalId)) {
      return res.status(400).json({ error: 'ID invalide' });
    }

    const signal = database.getSignalById(signalId);
    if (!signal) {
      return res.status(404).json({ error: 'Signal non trouve' });
    }

    const executions = database.getTradeExecutions(signalId);

    res.json({
      signal: {
        ...signal,
        targets: JSON.parse(signal.targets),
      },
      executions,
    });
  } catch (err) {
    logger.error(`Erreur API /trades/:id/executions : ${err.message}`);
    res.status(500).json({ error: 'Erreur recuperation executions' });
  }
});

// ---- GET /api/portfolio/exposure ----
// Retourne l'exposition actuelle
router.get('/portfolio/exposure', async (req, res) => {
  try {
    if (tradingEngine.isActive()) {
      // Mode trading reel
      const positions = await tradingEngine.syncPositions();
      const totalExposure = positions.reduce((sum, p) => sum + (p.quantity * p.entryPrice / p.leverage), 0);
      const totalPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);

      res.json({
        mode: tradingEngine.mode,
        exposure: Math.round(totalExposure * 100) / 100,
        activeCount: positions.length,
        profitLatent: Math.round(totalPnl * 100) / 100,
        positions: positions.map(p => ({
          symbol: p.symbol,
          pair: p.symbol.replace('USDT', '/USDT'),
          direction: p.side,
          leverage: p.leverage,
          entryPrice: p.entryPrice,
          currentPrice: p.currentPrice,
          unrealizedPnl: p.unrealizedPnl,
          liquidationPrice: p.liquidationPrice,
        })),
      });
    } else {
      // Mode simulation
      const activePositions = database.getActivePositions();
      const exposure = database.getOpenExposure();
      const snap = portfolio.getPortfolioSnapshot();

      res.json({
        mode: 'simulation',
        exposure: Math.round(exposure * 100) / 100,
        activeCount: activePositions.length,
        capitalBase: snap.current,
        profitRealized: activePositions.reduce((sum, s) => sum + (s.profit_realized_total || 0), 0),
        profitLatent: activePositions.reduce((sum, s) => sum + (s.profit_latent || 0), 0),
        positions: activePositions.map(s => ({
          id: s.id,
          pair: s.pair,
          direction: s.direction,
          leverage: s.leverage,
          positionInitial: s.position_size_initial,
          remainingPercent: s.position_remaining_percent,
          remainingSize: s.position_remaining_size,
          profitRealized: s.profit_realized_total,
          profitLatent: s.profit_latent,
          pnlTotal: s.pnl_total,
        })),
      });
    }
  } catch (err) {
    logger.error(`Erreur API /portfolio/exposure : ${err.message}`);
    res.status(500).json({ error: 'Erreur calcul exposition' });
  }
});

// ---- POST /api/trades/:id/close ----
// Ferme manuellement tout ou partie d'une position
// Body: { percent: 50 } (optionnel, defaut = tout le restant)
router.post('/trades/:id/close', async (req, res) => {
  try {
    const signalId = parseInt(req.params.id, 10);
    if (isNaN(signalId)) {
      return res.status(400).json({ error: 'ID invalide' });
    }

    const signal = database.getSignalById(signalId);
    if (!signal) {
      return res.status(404).json({ error: 'Trade non trouve' });
    }

    if (!['open', 'partial'].includes(signal.status)) {
      return res.status(400).json({ error: 'Trade deja ferme (status: ' + signal.status + ')' });
    }

    if (!signal.position_size_initial || signal.position_size_initial <= 0) {
      return res.status(400).json({ error: 'Position non initialisee' });
    }

    const percentToClose = req.body.percent || signal.position_remaining_percent || 100;

    // Recuperer le prix actuel depuis Binance
    let currentPrice = signal.current_price;
    if (binanceClient.isReady()) {
      const symbol = binanceClient.normalizeSymbol(signal.pair);
      const livePrice = await binanceClient.getCurrentPrice(symbol);
      if (livePrice) currentPrice = livePrice;
    }

    if (!currentPrice && !signal.entry_price_real) {
      return res.status(400).json({ error: 'Prix non disponible (Binance non connecte et pas de prix en cache)' });
    }

    if (tradingEngine.isActive()) {
      // Mode trading reel : fermer sur Binance
      const closeResult = await tradingEngine.closePosition(signal, 'manual');
      logger.info(`[API] Fermeture manuelle Binance signal #${signalId} ${signal.pair}`);
      res.json({
        success: true,
        mode: tradingEngine.mode,
        message: `Position ${signal.pair} fermee sur Binance`,
        closeResult,
      });
    } else {
      // Mode simulation : fermeture virtuelle
      const result = portfolio.executeManualClose(signalId, percentToClose, currentPrice);

      if (!result) {
        return res.status(500).json({ error: 'Erreur execution de la fermeture' });
      }

      logger.info(`[API] Fermeture manuelle signal #${signalId} ${signal.pair} : ${percentToClose}% → profit=${result.profitNet >= 0 ? '+' : ''}${result.profitNet.toFixed(2)}$`);

      res.json({
        success: true,
        profit: result.profitNet,
        profitPct: result.profitPctSafe,
        remaining: result.remainingPercent,
        status: result.status,
        capitalAfter: result.capitalAfter,
      });
    }
  } catch (err) {
    logger.error(`Erreur API POST /trades/:id/close : ${err.message}`);
    res.status(500).json({ error: 'Erreur fermeture manuelle' });
  }
});

// ---- GET /api/prices/current ----
// Retourne les prix actuels de toutes les positions ouvertes
router.get('/prices/current', (req, res) => {
  try {
    const openTrades = database.getOpenTrades();
    const prices = openTrades.map(t => ({
      id: t.id,
      pair: t.pair,
      direction: t.direction,
      leverage: t.leverage,
      entryPrice: t.entry_price_real,
      currentPrice: t.current_price,
      lastPriceUpdate: t.last_price_update,
      profitLatent: t.profit_latent,
      pnlTotal: t.pnl_total,
    }));

    res.json({
      prices,
      priceUpdaterActive: priceUpdater.isActive(),
      count: openTrades.length,
    });
  } catch (err) {
    logger.error(`Erreur API /prices/current : ${err.message}`);
    res.status(500).json({ error: 'Erreur recuperation des prix' });
  }
});

// ---- GET /api/trading/status ----
// Retourne l'etat du trading engine
router.get('/trading/status', (req, res) => {
  try {
    const status = tradingEngine.getStatus();
    res.json(status);
  } catch (err) {
    logger.error(`Erreur API /trading/status : ${err.message}`);
    res.status(500).json({ error: 'Erreur status trading' });
  }
});

// ---- GET /api/binance/balance ----
// Retourne le solde reel Binance Futures
router.get('/binance/balance', async (req, res) => {
  try {
    if (!tradingEngine.isActive()) {
      // En mode simulation, retourner le capital virtuel
      const snap = portfolio.getPortfolioSnapshot();
      return res.json({
        balance: snap.current,
        mode: tradingEngine.mode || 'simulation',
        source: 'simulation',
      });
    }

    const balance = await tradingEngine.getAccountBalance();
    const info = await tradingEngine.getAccountInfo();

    res.json({
      balance: info.availableBalance,
      totalBalance: info.totalBalance,
      unrealizedPnl: info.unrealizedPnl,
      marginBalance: info.marginBalance,
      mode: tradingEngine.mode,
      source: 'binance',
    });
  } catch (err) {
    logger.error(`Erreur API /binance/balance : ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---- GET /api/binance/positions ----
// Retourne les positions ouvertes reelles depuis Binance
router.get('/binance/positions', async (req, res) => {
  try {
    if (!tradingEngine.isActive()) {
      // En mode simulation, retourner les positions de la BDD
      const activePositions = database.getActivePositions();
      return res.json({
        positions: activePositions.map(s => ({
          id: s.id,
          pair: s.pair,
          direction: s.direction,
          leverage: s.leverage,
          entryPrice: s.entry_price_real,
          currentPrice: s.current_price,
          positionSize: s.position_size_initial,
          pnlLatent: s.profit_latent,
          liquidationPrice: null,
          status: s.status,
        })),
        mode: 'simulation',
        source: 'database',
      });
    }

    const positions = await tradingEngine.syncPositions();

    res.json({
      positions: positions.map(p => ({
        symbol: p.symbol,
        pair: p.symbol.replace('USDT', '/USDT'),
        direction: p.side,
        leverage: p.leverage,
        entryPrice: p.entryPrice,
        currentPrice: p.currentPrice,
        quantity: p.quantity,
        positionSize: p.quantity * p.entryPrice / p.leverage,
        pnlLatent: p.unrealizedPnl,
        liquidationPrice: p.liquidationPrice,
        marginType: p.marginType,
      })),
      mode: tradingEngine.mode,
      source: 'binance',
    });
  } catch (err) {
    logger.error(`Erreur API /binance/positions : ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---- POST /api/emergency/close-all ----
// Kill switch : ferme toutes les positions d'urgence
router.post('/emergency/close-all', async (req, res) => {
  try {
    if (!tradingEngine.killSwitchEnabled) {
      return res.status(403).json({ error: 'Kill switch desactive dans la config' });
    }

    if (!tradingEngine.isActive()) {
      return res.status(400).json({ error: 'Trading engine non actif (mode simulation)' });
    }

    logger.error('[API] KILL SWITCH ACTIVE DEPUIS LE DASHBOARD');
    const result = await tradingEngine.emergencyCloseAll();

    res.json({
      success: true,
      message: `${result.closed} position(s) fermee(s), ${result.errors} erreur(s)`,
      ...result,
    });
  } catch (err) {
    logger.error(`Erreur API /emergency/close-all : ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---- GET /api/reaction-time ----
// Retourne les statistiques de temps de reaction
// Query params : ?date=2024-01-15 (defaut: aujourd'hui)
router.get('/reaction-time', (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const stats = database.getReactionTimeStats(date);
    res.json({ date, ...stats });
  } catch (err) {
    logger.error(`Erreur API /reaction-time : ${err.message}`);
    res.status(500).json({ error: 'Erreur stats temps de reaction' });
  }
});

// ---- POST /api/trading/kill-switch/reset ----
// Desactive le kill switch pour reprendre le trading
router.post('/trading/kill-switch/reset', (req, res) => {
  try {
    tradingEngine.resetKillSwitch();
    res.json({ success: true, message: 'Kill switch desactive' });
  } catch (err) {
    logger.error(`Erreur API /trading/kill-switch/reset : ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
