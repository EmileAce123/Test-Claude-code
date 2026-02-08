require('dotenv').config();
const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

// --- Configuration ---
const PORT = parseInt(process.env.DASHBOARD_PORT, 10) || 3000;
const DB_PATH = process.env.DB_PATH || './data/arbitrage.db';
const AUTH_USER = process.env.DASHBOARD_USER || 'admin';
const AUTH_PASS = process.env.DASHBOARD_PASS || 'arbitrage2024';

// --- Database (read-only) ---
const db = new Database(DB_PATH, { readonly: true });
db.pragma('journal_mode = WAL');

// --- Express app ---
const app = express();

// Basic auth middleware
app.use((req, res, next) => {
  // Allow health check without auth
  if (req.path === '/health') return next();

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Arbitrage Dashboard"');
    return res.status(401).send('Authentication required');
  }

  const credentials = Buffer.from(auth.split(' ')[1], 'base64').toString();
  const [user, pass] = credentials.split(':');

  if (user === AUTH_USER && pass === AUTH_PASS) {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Arbitrage Dashboard"');
  res.status(401).send('Invalid credentials');
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// --- API Routes ---

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// GET /api/stats - Today's summary stats
app.get('/api/stats', (_req, res) => {
  const today = db.prepare(`
    SELECT
      COUNT(*) as total,
      ROUND(AVG(net_profit_percent), 4) as avg_profit,
      ROUND(MAX(net_profit_percent), 4) as max_profit,
      ROUND(MIN(net_profit_percent), 4) as min_profit
    FROM opportunities
    WHERE created_at >= datetime('now', 'start of day')
  `).get();

  const byType = db.prepare(`
    SELECT type, COUNT(*) as count
    FROM opportunities
    WHERE created_at >= datetime('now', 'start of day')
    GROUP BY type
  `).all();

  const above2 = db.prepare(`
    SELECT COUNT(*) as count
    FROM opportunities
    WHERE created_at >= datetime('now', 'start of day')
      AND net_profit_percent >= 2.0
  `).get();

  const allTime = db.prepare(`SELECT COUNT(*) as count FROM opportunities`).get();

  res.json({
    today: {
      total: today.total,
      avgProfit: today.avg_profit || 0,
      maxProfit: today.max_profit || 0,
      minProfit: today.min_profit || 0,
      above2Percent: above2.count,
    },
    byType,
    allTimeTotal: allTime.count,
  });
});

// GET /api/opportunities - Last 24h opportunities
app.get('/api/opportunities', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const offset = parseInt(req.query.offset, 10) || 0;
  const minProfit = parseFloat(req.query.min_profit) || -Infinity;
  const type = req.query.type || null;

  let query = `
    SELECT * FROM opportunities
    WHERE created_at >= datetime('now', '-1 day')
      AND net_profit_percent >= ?
  `;
  const params = [minProfit];

  if (type) {
    query += ' AND type = ?';
    params.push(type);
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = db.prepare(query).all(...params);

  const total = db.prepare(`
    SELECT COUNT(*) as count FROM opportunities
    WHERE created_at >= datetime('now', '-1 day')
      AND net_profit_percent >= ?
      ${type ? 'AND type = ?' : ''}
  `).get(...(type ? [minProfit, type] : [minProfit]));

  res.json({ data: rows, total: total.count, limit, offset });
});

// GET /api/chart/timeline - Opportunities count per hour over 7 days
app.get('/api/chart/timeline', (_req, res) => {
  const rows = db.prepare(`
    SELECT
      strftime('%Y-%m-%d %H:00', created_at) as hour,
      COUNT(*) as count,
      ROUND(AVG(net_profit_percent), 4) as avg_profit
    FROM opportunities
    WHERE created_at >= datetime('now', '-7 days')
    GROUP BY hour
    ORDER BY hour ASC
  `).all();

  res.json(rows);
});

// GET /api/chart/exchanges - Profit stats by exchange
app.get('/api/chart/exchanges', (_req, res) => {
  // Simple arbitrage: group by buy_exchange and sell_exchange
  const simple = db.prepare(`
    SELECT
      buy_exchange as exchange,
      'buy' as side,
      COUNT(*) as count,
      ROUND(AVG(net_profit_percent), 4) as avg_profit,
      ROUND(MAX(net_profit_percent), 4) as max_profit
    FROM opportunities
    WHERE type = 'simple' AND buy_exchange IS NOT NULL
    GROUP BY buy_exchange
    UNION ALL
    SELECT
      sell_exchange as exchange,
      'sell' as side,
      COUNT(*) as count,
      ROUND(AVG(net_profit_percent), 4) as avg_profit,
      ROUND(MAX(net_profit_percent), 4) as max_profit
    FROM opportunities
    WHERE type = 'simple' AND sell_exchange IS NOT NULL
    GROUP BY sell_exchange
  `).all();

  // Triangular: group by exchange
  const triangular = db.prepare(`
    SELECT
      exchange,
      COUNT(*) as count,
      ROUND(AVG(net_profit_percent), 4) as avg_profit,
      ROUND(MAX(net_profit_percent), 4) as max_profit
    FROM opportunities
    WHERE type = 'triangular' AND exchange IS NOT NULL
    GROUP BY exchange
  `).all();

  // Aggregate best profits per exchange
  const bestByExchange = db.prepare(`
    SELECT
      COALESCE(buy_exchange, exchange) as exchange,
      ROUND(MAX(net_profit_percent), 4) as max_profit,
      COUNT(*) as total_opps
    FROM opportunities
    WHERE COALESCE(buy_exchange, exchange) IS NOT NULL
    GROUP BY COALESCE(buy_exchange, exchange)
    ORDER BY max_profit DESC
  `).all();

  res.json({ simple, triangular, bestByExchange });
});

// GET /api/scans - Last N scan timestamps (approximated from data gaps)
app.get('/api/scans', (_req, res) => {
  const rows = db.prepare(`
    SELECT
      created_at as timestamp,
      COUNT(*) as opportunities_found,
      ROUND(MAX(net_profit_percent), 4) as best_profit,
      GROUP_CONCAT(DISTINCT type) as types
    FROM opportunities
    WHERE created_at >= datetime('now', '-1 hour')
    GROUP BY strftime('%Y-%m-%d %H:%M', created_at)
    ORDER BY timestamp DESC
    LIMIT 10
  `).all();

  res.json(rows);
});

// GET /api/top - Top opportunities all time
app.get('/api/top', (_req, res) => {
  const rows = db.prepare(`
    SELECT * FROM opportunities
    ORDER BY net_profit_percent DESC
    LIMIT 10
  `).all();

  res.json(rows);
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`Dashboard running on http://localhost:${PORT}`);
  console.log(`Auth: ${AUTH_USER} / ${'*'.repeat(AUTH_PASS.length)}`);
  console.log(`Database: ${DB_PATH} (read-only)`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});
