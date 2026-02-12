const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('../config');

class ArbitrageDB {
  constructor() {
    const dbDir = path.dirname(config.db.path);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(config.db.path);
    this.db.pragma('journal_mode = WAL');
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS opportunities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        pair TEXT,
        exchange TEXT,
        buy_exchange TEXT,
        sell_exchange TEXT,
        direction TEXT,
        buy_price REAL,
        sell_price REAL,
        legs_json TEXT,
        gross_profit_percent REAL,
        net_profit_percent REAL,
        fees_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_opp_created_at ON opportunities(created_at);
      CREATE INDEX IF NOT EXISTS idx_opp_type ON opportunities(type);
      CREATE INDEX IF NOT EXISTS idx_opp_net_profit ON opportunities(net_profit_percent);
    `);
  }

  insertSimple(opp) {
    const stmt = this.db.prepare(`
      INSERT INTO opportunities
        (type, pair, buy_exchange, sell_exchange, buy_price, sell_price,
         gross_profit_percent, net_profit_percent, fees_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      'simple',
      opp.pair,
      opp.buyExchange,
      opp.sellExchange,
      opp.buyPrice,
      opp.sellPrice,
      opp.grossProfitPercent,
      opp.netProfitPercent,
      JSON.stringify({ buy: opp.buyFeePercent, sell: opp.sellFeePercent }),
      opp.timestamp
    );
  }

  insertTriangular(opp) {
    const stmt = this.db.prepare(`
      INSERT INTO opportunities
        (type, exchange, direction, legs_json,
         net_profit_percent, fees_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      'triangular',
      opp.exchange,
      opp.direction,
      JSON.stringify(opp.legs),
      opp.netProfitPercent,
      JSON.stringify({ perLeg: opp.feePerLeg, total: opp.totalFeesPercent }),
      opp.timestamp
    );
  }

  insertOpportunities(opportunities) {
    const insertMany = this.db.transaction((opps) => {
      for (const opp of opps) {
        if (opp.type === 'simple') {
          this.insertSimple(opp);
        } else {
          this.insertTriangular(opp);
        }
      }
    });
    insertMany(opportunities);
  }

  /**
   * Purge records older than the configured retention period.
   */
  purgeOld() {
    const stmt = this.db.prepare(`
      DELETE FROM opportunities
      WHERE created_at < datetime('now', ?)
    `);
    const result = stmt.run(`-${config.db.retentionDays} days`);
    if (result.changes > 0) {
      console.log(`[db] Purged ${result.changes} records older than ${config.db.retentionDays} days`);
    }
  }

  getStats() {
    const total = this.db.prepare('SELECT COUNT(*) as count FROM opportunities').get();
    const byType = this.db
      .prepare('SELECT type, COUNT(*) as count FROM opportunities GROUP BY type')
      .all();
    const best = this.db
      .prepare(
        'SELECT * FROM opportunities ORDER BY net_profit_percent DESC LIMIT 5'
      )
      .all();
    const last24h = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM opportunities
         WHERE created_at > datetime('now', '-1 day')`
      )
      .get();

    return { total: total.count, byType, best, last24h: last24h.count };
  }

  close() {
    this.db.close();
  }
}

module.exports = ArbitrageDB;
