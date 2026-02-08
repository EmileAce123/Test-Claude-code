// ============================================================
// routes.js - Endpoints API du dashboard
// ============================================================
// Tous les endpoints sont en LECTURE SEULE.
// Aucune écriture dans la base de données.
//
// GET /api/stats              → Statistiques globales
// GET /api/trades             → Liste des trades (avec filtres)
// GET /api/chart-data         → Données pour les graphiques
// GET /api/pairs              → Liste des paires disponibles
// GET /api/export-csv         → Export CSV des trades
// GET /api/health             → Statut du système
// GET /api/portfolio          → Etat du portefeuille virtuel
// GET /api/portfolio-history  → Historique du portefeuille
// GET /api/portfolio/best-worst → Meilleurs et pires trades en $
// ============================================================

const express = require('express');
const database = require('../database');
const statsCalculator = require('../stats-calculator');
const portfolio = require('../portfolio-simulator');
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
//   ?from=2024-01-01
//   ?to=2024-12-31
//   ?page=1&limit=50
router.get('/trades', (req, res) => {
  try {
    const { status, pair, from, to, page = 1, limit = 50 } = req.query;

    // Récupérer tous les signaux
    let signals = database.getSignals(status || undefined);

    // Filtre par paire
    if (pair) {
      const pairUpper = pair.toUpperCase();
      signals = signals.filter(s => s.pair === pairUpper);
    }

    // Filtre par date de début
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

// ---- GET /api/export-csv ----
// Exporte tous les trades en CSV
router.get('/export-csv', (req, res) => {
  try {
    const signals = database.getSignals();

    // En-tête CSV
    const header = 'Date,Paire,Direction,Entrée Min,Entrée Max,Leverage,Stop Loss,Targets Atteints,Profit %,Statut\n';

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
        s.status,
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
    try {
      // Vérifier via le fichier de log s'il y a eu de l'activité récente
      const logPath = path.join(__dirname, '..', '..', 'logs', 'app.log');
      if (fs.existsSync(logPath)) {
        const stat = fs.statSync(logPath);
        // Actif si le fichier de log a été modifié dans les 5 dernières minutes
        trackerActive = (Date.now() - stat.mtimeMs) < 5 * 60 * 1000;
      }
    } catch (e) {
      // Ignorer l'erreur
    }

    res.json({
      status: 'ok',
      database: 'connected',
      signals: count.total,
      trackerActive,
      uptime: process.uptime(),
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ---- GET /api/portfolio ----
// Retourne l'etat actuel du portefeuille virtuel
router.get('/portfolio', (req, res) => {
  try {
    const snap = portfolio.getPortfolioSnapshot();
    res.json(snap);
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

module.exports = router;
