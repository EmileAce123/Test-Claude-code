// ============================================================
// routes.js - Endpoints API du dashboard (simplifie)
// ============================================================

const express = require('express');
const database = require('../database');
const portfolio = require('../portfolio-simulator');
const binanceClient = require('../binance-client');
const tradingEngine = require('../trading-engine');
const logger = require('../logger');
const fs = require('fs');
const path = require('path');

const router = express.Router();

// ---- GET /api/stats/today ----
// Stats simplifiees pour le dashboard : trades du jour, win rate 7j, reaction time
router.get('/stats/today', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const dayStats = database.getDaySignalStats(today);
    const reactionStats = database.getReactionTimeStats(today);

    // Win rate 7 jours
    const signals = database.getSignals();
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const sevenDaysStr = sevenDaysAgo.toISOString();
    const recentClosed = signals.filter(s =>
      ['closed', 'manual_close', 'stopped'].includes(s.status) &&
      s.created_at >= sevenDaysStr
    );
    const wins = recentClosed.filter(s => (s.net_profit_loss || 0) > 0).length;
    const winRate = recentClosed.length > 0
      ? Math.round((wins / recentClosed.length) * 100)
      : 0;

    // P&L du jour depuis snapshot
    const snapshot = database.getDailySnapshot(today);

    // Compter toutes les positions ouvertes (pas juste celles du jour)
    const openPositionsCount = database.countOpenPositions();

    res.json({
      totalTrades: dayStats.total_trades,
      openPositions: openPositionsCount,
      maxPositions: tradingEngine.maxOpenPositions || 20,
      winRate,
      avgReactionTime: reactionStats.count > 0 ? `${reactionStats.avg_ms}ms` : '--',
      pnlToday: snapshot ? snapshot.pnl_vs_yesterday : 0,
    });
  } catch (err) {
    logger.error(`Erreur API /stats/today : ${err.message}`);
    res.status(500).json({ error: 'Erreur stats du jour' });
  }
});

// ---- GET /api/positions/open ----
// Positions ouvertes reelles depuis Binance (ou BDD en simulation)
router.get('/positions/open', async (req, res) => {
  try {
    if (tradingEngine.isActive()) {
      const positions = await tradingEngine.syncPositions();
      res.json(positions.map(p => ({
        symbol: p.symbol,
        side: p.side,
        leverage: p.leverage,
        entryPrice: p.entryPrice,
        currentPrice: p.currentPrice,
        pnl: p.unrealizedPnl,
        size: Math.round((p.quantity * p.entryPrice / p.leverage) * 100) / 100,
      })));
    } else {
      const activePositions = database.getActivePositions();
      res.json(activePositions.map(s => ({
        symbol: s.pair.replace('/', ''),
        side: s.direction,
        leverage: s.leverage,
        entryPrice: s.entry_price_real || ((s.entry_price_min + s.entry_price_max) / 2),
        currentPrice: s.current_price || null,
        pnl: s.profit_latent || 0,
        size: s.position_size_initial || 0,
        id: s.id,
      })));
    }
  } catch (err) {
    logger.error(`Erreur API /positions/open : ${err.message}`);
    res.status(500).json({ error: 'Erreur positions ouvertes' });
  }
});

// ---- GET /api/trades/recent ----
// 10 derniers trades fermes
router.get('/trades/recent', (req, res) => {
  try {
    const signals = database.getSignals();
    const closed = signals.filter(s =>
      ['closed', 'manual_close', 'stopped', 'liquidated'].includes(s.status)
    ).slice(0, 10);

    res.json(closed.map(s => ({
      pair: s.pair,
      direction: s.direction,
      leverage: s.leverage,
      created_at: s.created_at,
      pnl_total: s.net_profit_loss || s.pnl_total || null,
      status: s.status,
    })));
  } catch (err) {
    logger.error(`Erreur API /trades/recent : ${err.message}`);
    res.status(500).json({ error: 'Erreur trades recents' });
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
