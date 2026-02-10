// ============================================================
// database.js - Gestion de la base de données SQLite
// ============================================================
// Ce module crée et gère la base de données locale qui stocke
// tous les signaux de trading et leurs confirmations.
// Utilise better-sqlite3 pour des requêtes synchrones et rapides.
// ============================================================

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

// Variable qui stocke l'instance de la base de données
let db = null;

/**
 * Initialise la base de données SQLite.
 * Crée le fichier et les tables si elles n'existent pas.
 * @param {string} dbPath - Chemin vers le fichier de base de données
 */
function init(dbPath) {
  // Créer le dossier parent si nécessaire
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    logger.info(`Dossier de base de données créé : ${dir}`);
  }

  // Ouvrir ou créer la base de données
  db = new Database(dbPath);
  logger.info(`Base de données ouverte : ${dbPath}`);

  // Activer le mode WAL pour de meilleures performances
  // (Write-Ahead Logging = écritures plus rapides)
  db.pragma('journal_mode = WAL');

  // Créer les tables si elles n'existent pas encore
  createTables();

  // Appliquer les migrations (ajout de colonnes portfolio)
  runMigrations();

  logger.info('Base de données initialisée avec succès');
}

/**
 * Crée les tables nécessaires dans la base de données.
 * Cette fonction est idempotente (peut être appelée plusieurs fois sans problème).
 */
function createTables() {
  // ---- Table des signaux de trading ----
  // Stocke chaque signal reçu avec toutes ses informations
  db.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- Identifiant unique du message Telegram
      telegram_message_id INTEGER NOT NULL,
      -- Paire de trading (ex: POL/USDT)
      pair TEXT NOT NULL,
      -- Direction du trade : SHORT ou LONG
      direction TEXT NOT NULL,
      -- Prix d'entrée minimum
      entry_price_min REAL NOT NULL,
      -- Prix d'entrée maximum
      entry_price_max REAL NOT NULL,
      -- Effet de levier (ex: 25 pour X25)
      leverage INTEGER NOT NULL,
      -- Prix du stop loss
      stop_loss REAL NOT NULL,
      -- Émetteur du signal (ex: @CryptoKlondike)
      emitter TEXT,
      -- Prix des 5 targets (stockés en JSON pour flexibilité)
      targets TEXT NOT NULL,
      -- Statut du trade : open, tp_hit, sl_hit, cancelled
      status TEXT DEFAULT 'open',
      -- Numéro du dernier target atteint (0 = aucun)
      last_target_hit INTEGER DEFAULT 0,
      -- Profit final en pourcentage (rempli quand le trade se ferme)
      final_profit_pct REAL,
      -- Date/heure de réception du signal
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      -- Date/heure de la dernière mise à jour
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      -- Contrainte : pas de doublon de message Telegram
      UNIQUE(telegram_message_id)
    )
  `);

  // ---- Table des confirmations (targets atteints) ----
  // Stocke chaque confirmation de target reçue
  db.exec(`
    CREATE TABLE IF NOT EXISTS confirmations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- Référence vers le signal parent
      signal_id INTEGER,
      -- Identifiant du message Telegram de confirmation
      telegram_message_id INTEGER NOT NULL,
      -- Paire de trading (pour matching)
      pair TEXT NOT NULL,
      -- Numéro du target atteint (1 à 5)
      target_number INTEGER NOT NULL,
      -- Pourcentage de profit affiché
      profit_pct REAL NOT NULL,
      -- Durée écoulée depuis l'entrée (texte brut)
      period TEXT,
      -- Date/heure de réception de la confirmation
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      -- Lien vers la table signals
      FOREIGN KEY (signal_id) REFERENCES signals(id),
      -- Pas de doublon
      UNIQUE(telegram_message_id)
    )
  `);

  // ---- Table des annulations ----
  // Stocke les messages d'annulation manuelle
  db.exec(`
    CREATE TABLE IF NOT EXISTS cancellations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- Identifiant du message Telegram
      telegram_message_id INTEGER NOT NULL,
      -- Paire de trading
      pair TEXT NOT NULL,
      -- Date/heure de l'annulation
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(telegram_message_id)
    )
  `);

  // ---- Table des stop loss touchés ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS stop_losses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- Référence vers le signal parent
      signal_id INTEGER,
      -- Identifiant du message Telegram
      telegram_message_id INTEGER NOT NULL,
      -- Paire de trading
      pair TEXT NOT NULL,
      -- Pourcentage de perte
      loss_pct REAL,
      -- Durée écoulée
      period TEXT,
      -- Date/heure
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (signal_id) REFERENCES signals(id),
      UNIQUE(telegram_message_id)
    )
  `);

  // ---- Table pour l'état de l'entrée en zone ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS entry_zones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_message_id INTEGER NOT NULL,
      pair TEXT NOT NULL,
      period TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(telegram_message_id)
    )
  `);

  // ---- Table des executions pyramidales (multi-TP) ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS trade_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id INTEGER NOT NULL,
      target_number INTEGER NOT NULL,
      target_price REAL,
      position_closed_percent REAL,
      position_closed_size REAL,
      profit_realized REAL,
      profit_realized_percent REAL,
      executed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (signal_id) REFERENCES signals(id)
    )
  `);

  logger.info('Tables de la base de données vérifiées/créées');
}

/**
 * Applique les migrations pour ajouter les colonnes du portefeuille virtuel.
 * Utilise une approche "IF NOT EXISTS" implicite via try/catch car
 * SQLite ne supporte pas ALTER TABLE ADD COLUMN IF NOT EXISTS.
 */
function runMigrations() {
  const columnsToAdd = [
    { table: 'signals', column: 'source_group_name', type: 'TEXT' },
    { table: 'signals', column: 'virtual_portfolio_before', type: 'REAL' },
    { table: 'signals', column: 'virtual_portfolio_after', type: 'REAL' },
    { table: 'signals', column: 'position_size', type: 'REAL' },
    { table: 'signals', column: 'trading_fees_total', type: 'REAL' },
    { table: 'signals', column: 'net_profit_loss', type: 'REAL' },
    // Colonne pour le profit conservateur (Telegram × marge de securite)
    // entry_price_used et exit_price : colonnes legacy, plus utilisees
    { table: 'signals', column: 'entry_price_used', type: 'REAL' },
    { table: 'signals', column: 'exit_price', type: 'REAL' },
    { table: 'signals', column: 'profit_calculated', type: 'REAL' },
    // Colonnes pour les prix reels Binance (Phase 1 : lecture seule)
    { table: 'signals', column: 'entry_price_real', type: 'REAL' },
    { table: 'signals', column: 'exit_price_real', type: 'REAL' },
    { table: 'signals', column: 'profit_real', type: 'REAL' },
    { table: 'signals', column: 'atr_value', type: 'REAL' },
    // Colonnes pour prix temps reel
    { table: 'signals', column: 'current_price', type: 'REAL' },
    { table: 'signals', column: 'last_price_update', type: 'DATETIME' },
    // Colonnes pour type d'execution
    { table: 'trade_executions', column: 'execution_type', type: "TEXT DEFAULT 'auto'" },
    // Colonnes pour la strategie pyramidale multi-TP
    { table: 'signals', column: 'position_size_initial', type: 'REAL' },
    { table: 'signals', column: 'position_remaining_percent', type: 'REAL DEFAULT 100' },
    { table: 'signals', column: 'position_remaining_size', type: 'REAL' },
    { table: 'signals', column: 'profit_realized_total', type: 'REAL DEFAULT 0' },
    { table: 'signals', column: 'profit_latent', type: 'REAL' },
    { table: 'signals', column: 'pnl_total', type: 'REAL' },
  ];

  for (const { table, column, type } of columnsToAdd) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      logger.info(`Migration : colonne ${column} ajoutée à ${table}`);
    } catch (err) {
      // La colonne existe déjà -> ignorer silencieusement
      if (!err.message.includes('duplicate column')) {
        logger.error(`Migration erreur ${column} : ${err.message}`);
      }
    }
  }

  // Migration des anciens statuts vers les nouveaux
  // tp_hit / all_tp_hit → closed, sl_hit → stopped
  try {
    const oldStatusCount = db.prepare(
      "SELECT COUNT(*) as count FROM signals WHERE status IN ('tp_hit', 'all_tp_hit', 'sl_hit')"
    ).get().count;
    if (oldStatusCount > 0) {
      db.prepare("UPDATE signals SET status = 'closed' WHERE status IN ('tp_hit', 'all_tp_hit')").run();
      db.prepare("UPDATE signals SET status = 'stopped' WHERE status = 'sl_hit'").run();
      logger.info(`Migration : ${oldStatusCount} statuts migres (tp_hit/all_tp_hit → closed, sl_hit → stopped)`);
    }
  } catch (err) {
    logger.error(`Migration statuts erreur : ${err.message}`);
  }
}

// ============================================================
// DONNEES BINANCE (prix reels)
// ============================================================

/**
 * Met a jour les prix reels Binance d'un signal.
 * @param {number} signalId - ID du signal
 * @param {Object} data - { entryPriceReal, exitPriceReal, profitReal, atrValue }
 */
function updateSignalBinancePrices(signalId, data) {
  const fields = [];
  const params = { signalId };

  if (data.entryPriceReal !== undefined) {
    fields.push('entry_price_real = @entryPriceReal');
    params.entryPriceReal = data.entryPriceReal;
  }
  if (data.exitPriceReal !== undefined) {
    fields.push('exit_price_real = @exitPriceReal');
    params.exitPriceReal = data.exitPriceReal;
  }
  if (data.profitReal !== undefined) {
    fields.push('profit_real = @profitReal');
    params.profitReal = data.profitReal;
  }
  if (data.atrValue !== undefined) {
    fields.push('atr_value = @atrValue');
    params.atrValue = data.atrValue;
  }

  if (fields.length > 0) {
    db.prepare(`UPDATE signals SET ${fields.join(', ')} WHERE id = @signalId`).run(params);
  }
}

// ============================================================
// STRATEGIE PYRAMIDALE - FONCTIONS DATA
// ============================================================

/**
 * Initialise les colonnes pyramidales d'un signal.
 * @param {number} signalId - ID du signal
 * @param {number} positionSizeInitial - Taille de position initiale en $
 */
function initSignalPosition(signalId, positionSizeInitial) {
  db.prepare(`
    UPDATE signals SET
      position_size_initial = @positionSizeInitial,
      position_remaining_percent = 100,
      position_remaining_size = @positionSizeInitial,
      profit_realized_total = 0,
      profit_latent = 0,
      pnl_total = 0
    WHERE id = @signalId
  `).run({ signalId, positionSizeInitial });
}

/**
 * Insere une execution pyramidale (fermeture partielle a un TP ou SL).
 * @param {Object} data - Donnees de l'execution
 * @returns {Object} Resultat de l'insertion
 */
function insertTradeExecution(data) {
  return db.prepare(`
    INSERT INTO trade_executions
      (signal_id, target_number, target_price, position_closed_percent,
       position_closed_size, profit_realized, profit_realized_percent, execution_type)
    VALUES (@signalId, @targetNumber, @targetPrice, @positionClosedPercent,
            @positionClosedSize, @profitRealized, @profitRealizedPercent, @executionType)
  `).run({
    signalId: data.signalId,
    targetNumber: data.targetNumber,
    targetPrice: data.targetPrice || null,
    positionClosedPercent: data.positionClosedPercent,
    positionClosedSize: data.positionClosedSize,
    profitRealized: data.profitRealized,
    profitRealizedPercent: data.profitRealizedPercent,
    executionType: data.executionType || 'auto',
  });
}

/**
 * Recupere toutes les executions d'un signal.
 * @param {number} signalId - ID du signal
 * @returns {Array} Liste des executions
 */
function getTradeExecutions(signalId) {
  return db.prepare(
    'SELECT * FROM trade_executions WHERE signal_id = ? ORDER BY target_number ASC'
  ).all(signalId);
}

/**
 * Met a jour l'etat pyramidal d'un signal.
 * @param {number} signalId - ID du signal
 * @param {Object} data - Donnees a mettre a jour
 */
function updateSignalPyramidState(signalId, data) {
  db.prepare(`
    UPDATE signals SET
      position_remaining_percent = @positionRemainingPercent,
      position_remaining_size = @positionRemainingSize,
      profit_realized_total = @profitRealizedTotal,
      profit_latent = @profitLatent,
      pnl_total = @pnlTotal,
      status = @status,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = @signalId
  `).run({
    signalId,
    positionRemainingPercent: data.positionRemainingPercent,
    positionRemainingSize: data.positionRemainingSize,
    profitRealizedTotal: data.profitRealizedTotal,
    profitLatent: data.profitLatent ?? 0,
    pnlTotal: data.pnlTotal,
    status: data.status,
  });
}

/**
 * Recupere les positions actives (partiellement fermees).
 * @returns {Array} Signaux avec status='partial'
 */
function getActivePositions() {
  return db.prepare(
    "SELECT * FROM signals WHERE status IN ('open', 'partial') AND position_size_initial > 0 ORDER BY created_at DESC"
  ).all();
}

/**
 * Recupere l'exposition totale (somme des positions restantes).
 * @returns {number} Exposition en dollars
 */
function getOpenExposure() {
  const result = db.prepare(
    "SELECT COALESCE(SUM(position_remaining_size), 0) as exposure FROM signals WHERE status IN ('open', 'partial')"
  ).get();
  return result.exposure;
}

/**
 * Recupere tous les signaux dans l'ordre chronologique (pour recalcul).
 * @returns {Array} Signaux tries par created_at ASC
 */
function getAllSignalsChronological() {
  return db.prepare(
    'SELECT * FROM signals ORDER BY created_at ASC'
  ).all();
}

/**
 * Supprime toutes les executions pyramidales (pour recalcul).
 */
function deleteAllTradeExecutions() {
  db.prepare('DELETE FROM trade_executions').run();
  logger.info('Toutes les executions pyramidales supprimees');
}

/**
 * Recupere les stop losses d'un signal.
 * @param {number} signalId - ID du signal
 * @returns {Array} Liste des stop losses
 */
function getStopLosses(signalId) {
  return db.prepare(
    'SELECT * FROM stop_losses WHERE signal_id = ? ORDER BY created_at ASC'
  ).all(signalId);
}

/**
 * Recupere tous les trades ouverts (open ou partial) pour mise a jour des prix.
 * @returns {Array} Signaux avec position ouverte
 */
function getOpenTrades() {
  return db.prepare(
    "SELECT * FROM signals WHERE status IN ('open', 'partial') AND position_size_initial > 0 ORDER BY created_at DESC"
  ).all();
}

/**
 * Met a jour le prix actuel et le P&L latent d'un signal.
 * @param {number} signalId - ID du signal
 * @param {Object} data - { currentPrice, profitLatent, pnlTotal }
 */
function updateSignalCurrentPrice(signalId, data) {
  db.prepare(`
    UPDATE signals SET
      current_price = @currentPrice,
      profit_latent = @profitLatent,
      pnl_total = @pnlTotal,
      last_price_update = CURRENT_TIMESTAMP
    WHERE id = @signalId
  `).run({
    signalId,
    currentPrice: data.currentPrice,
    profitLatent: data.profitLatent,
    pnlTotal: data.pnlTotal,
  });
}

// ============================================================
// OPÉRATIONS D'ÉCRITURE
// ============================================================

/**
 * Insère un nouveau signal de trading dans la base de données.
 * Vérifie d'abord les doublons : même pair + direction + leverage dans les 5 dernières minutes.
 * @param {Object} signal - Les données du signal parsé
 * @returns {Object} Le signal inséré avec son ID, ou null si doublon
 */
function insertSignal(signal) {
  // Vérifier les doublons (même pair + direction + leverage dans les 5 dernières minutes)
  const duplicate = db.prepare(`
    SELECT id FROM signals
    WHERE pair = @pair
      AND direction = @direction
      AND leverage = @leverage
      AND datetime(created_at) > datetime('now', '-5 minutes')
    LIMIT 1
  `).get({
    pair: signal.pair,
    direction: signal.direction,
    leverage: signal.leverage,
  });

  if (duplicate) {
    logger.info(`Signal doublon ignoré : ${signal.pair} ${signal.direction} X${signal.leverage} (signal #${duplicate.id} existe déjà)`);
    return null;
  }

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO signals
      (telegram_message_id, pair, direction, entry_price_min, entry_price_max,
       leverage, stop_loss, emitter, targets, status, source_group_name)
    VALUES
      (@telegramMessageId, @pair, @direction, @entryPriceMin, @entryPriceMax,
       @leverage, @stopLoss, @emitter, @targets, 'open', @sourceGroupName)
  `);

  const result = stmt.run({
    telegramMessageId: signal.telegramMessageId,
    pair: signal.pair,
    direction: signal.direction,
    entryPriceMin: signal.entryPriceMin,
    entryPriceMax: signal.entryPriceMax,
    leverage: signal.leverage,
    stopLoss: signal.stopLoss,
    emitter: signal.emitter || null,
    targets: JSON.stringify(signal.targets),
    sourceGroupName: signal.sourceGroup || null,
  });

  if (result.changes > 0) {
    logger.info(`Signal inséré : ${signal.pair} ${signal.direction} (ID: ${result.lastInsertRowid})`);
    return { id: result.lastInsertRowid, ...signal };
  }

  // Le signal existait déjà (doublon de message Telegram ID)
  logger.warn(`Signal ignoré (doublon telegram_message_id) : message Telegram ${signal.telegramMessageId}`);
  return null;
}

/**
 * Insère une confirmation de target atteint.
 * Met aussi à jour le signal parent.
 * @param {Object} confirmation - Les données de la confirmation parsée
 * @returns {Object|null} La confirmation insérée ou null si doublon
 */
function insertConfirmation(confirmation) {
  // Trouver le signal parent (le plus récent pour cette paire, encore ouvert/partiel)
  const signal = db.prepare(`
    SELECT id FROM signals
    WHERE pair = @pair AND status IN ('open', 'partial')
    ORDER BY created_at DESC
    LIMIT 1
  `).get({ pair: confirmation.pair });

  const signalId = signal ? signal.id : null;

  // Insérer la confirmation
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO confirmations
      (signal_id, telegram_message_id, pair, target_number, profit_pct, period)
    VALUES
      (@signalId, @telegramMessageId, @pair, @targetNumber, @profitPct, @period)
  `);

  const result = stmt.run({
    signalId,
    telegramMessageId: confirmation.telegramMessageId,
    pair: confirmation.pair,
    targetNumber: confirmation.targetNumber,
    profitPct: confirmation.profitPct,
    period: confirmation.period || null,
  });

  if (result.changes > 0) {
    // Mettre à jour le signal parent si trouvé
    // Note : status et profit pyramidal geres par portfolio-simulator
    if (signalId) {
      db.prepare(`
        UPDATE signals
        SET last_target_hit = MAX(last_target_hit, @targetNumber),
            final_profit_pct = @profitPct,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = @signalId
      `).run({
        targetNumber: confirmation.targetNumber,
        profitPct: confirmation.profitPct,
        signalId,
      });

      logger.info(`Signal ${signalId} : TP${confirmation.targetNumber} = ${confirmation.profitPct}%`);
    }

    logger.info(`Confirmation insérée : ${confirmation.pair} TP${confirmation.targetNumber} +${confirmation.profitPct}%`);
    return { id: result.lastInsertRowid, signalId, ...confirmation };
  }

  logger.warn(`Confirmation ignorée (doublon) : message Telegram ${confirmation.telegramMessageId}`);
  return null;
}

/**
 * Enregistre une annulation de trade.
 * @param {Object} cancellation - Données de l'annulation
 */
function insertCancellation(cancellation) {
  // Insérer dans la table des annulations
  db.prepare(`
    INSERT OR IGNORE INTO cancellations (telegram_message_id, pair)
    VALUES (@telegramMessageId, @pair)
  `).run({
    telegramMessageId: cancellation.telegramMessageId,
    pair: cancellation.pair,
  });

  // Mettre à jour le signal parent
  const signal = db.prepare(`
    SELECT id FROM signals
    WHERE pair = @pair AND status = 'open'
    ORDER BY created_at DESC
    LIMIT 1
  `).get({ pair: cancellation.pair });

  if (signal) {
    db.prepare(`
      UPDATE signals
      SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `).run({ id: signal.id });
    logger.info(`Signal ${signal.id} annulé : ${cancellation.pair}`);
  }
}

/**
 * Enregistre un stop loss touché.
 * @param {Object} slData - Données du stop loss
 */
function insertStopLoss(slData) {
  const signal = db.prepare(`
    SELECT id FROM signals
    WHERE pair = @pair AND status IN ('open', 'partial')
    ORDER BY created_at DESC
    LIMIT 1
  `).get({ pair: slData.pair });

  const signalId = signal ? signal.id : null;

  db.prepare(`
    INSERT OR IGNORE INTO stop_losses (signal_id, telegram_message_id, pair, loss_pct, period)
    VALUES (@signalId, @telegramMessageId, @pair, @lossPct, @period)
  `).run({
    signalId,
    telegramMessageId: slData.telegramMessageId,
    pair: slData.pair,
    lossPct: slData.lossPct || null,
    period: slData.period || null,
  });

  // Note : status et calcul de perte geres par portfolio-simulator (pyramide)
  if (signalId) {
    db.prepare(`
      UPDATE signals
      SET final_profit_pct = @lossPct,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `).run({ lossPct: slData.lossPct ? -Math.abs(slData.lossPct) : null, id: signalId });

    logger.info(`Stop loss enregistré pour signal ${signalId} : ${slData.pair} (perte: ${slData.lossPct || '?'}%)`);
  }
}

/**
 * Enregistre une entrée en zone de prix.
 * @param {Object} entryZone - Données de l'entrée en zone
 */
function insertEntryZone(entryZone) {
  db.prepare(`
    INSERT OR IGNORE INTO entry_zones (telegram_message_id, pair, period)
    VALUES (@telegramMessageId, @pair, @period)
  `).run({
    telegramMessageId: entryZone.telegramMessageId,
    pair: entryZone.pair,
    period: entryZone.period || null,
  });
  logger.info(`Entrée en zone enregistrée : ${entryZone.pair}`);
}

/**
 * Met à jour les colonnes de portefeuille virtuel d'un signal.
 * @param {number} signalId - ID du signal
 * @param {Object} data - Données du portefeuille
 */
function updateSignalPortfolio(signalId, data) {
  db.prepare(`
    UPDATE signals
    SET virtual_portfolio_before = @virtualPortfolioBefore,
        virtual_portfolio_after = @virtualPortfolioAfter,
        position_size = @positionSize,
        trading_fees_total = @tradingFeesTotal,
        net_profit_loss = @netProfitLoss
    WHERE id = @signalId
  `).run({
    virtualPortfolioBefore: data.virtualPortfolioBefore,
    virtualPortfolioAfter: data.virtualPortfolioAfter,
    positionSize: data.positionSize,
    tradingFeesTotal: data.tradingFeesTotal,
    netProfitLoss: data.netProfitLoss,
    signalId,
  });
}

/**
 * Réinitialise les colonnes de portefeuille et les donnees pyramidales.
 */
function resetPortfolioData() {
  // Reset colonnes portfolio classiques
  db.prepare(`
    UPDATE signals
    SET virtual_portfolio_before = NULL,
        virtual_portfolio_after = NULL,
        position_size = NULL,
        trading_fees_total = NULL,
        net_profit_loss = NULL,
        profit_calculated = NULL,
        position_size_initial = NULL,
        position_remaining_percent = 100,
        position_remaining_size = NULL,
        profit_realized_total = 0,
        profit_latent = NULL,
        pnl_total = NULL
  `).run();

  // Remettre les signaux non-annules en statut 'open' pour recalcul
  db.prepare(`
    UPDATE signals SET status = 'open'
    WHERE status IN ('partial', 'closed', 'stopped', 'manual_close', 'tp_hit', 'all_tp_hit', 'sl_hit')
  `).run();

  // Supprimer toutes les executions pyramidales
  db.prepare('DELETE FROM trade_executions').run();

  logger.info('Données de portefeuille et pyramide réinitialisées');
}

// ============================================================
// OPÉRATIONS DE LECTURE
// ============================================================

/**
 * Récupère un signal par son ID.
 * @param {number} id - ID du signal
 * @returns {Object|null} Le signal ou null
 */
function getSignalById(id) {
  return db.prepare('SELECT * FROM signals WHERE id = ?').get(id) || null;
}

/**
 * Récupère le capital actuel du portefeuille (dernier virtual_portfolio_after enregistré).
 * @param {number} fallback - Capital par défaut si aucun trade n'a encore été calculé
 * @returns {number} Capital actuel
 */
function getLastPortfolioCapital(fallback) {
  const row = db.prepare(`
    SELECT virtual_portfolio_after
    FROM signals
    WHERE virtual_portfolio_after IS NOT NULL
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
  `).get();
  return row ? row.virtual_portfolio_after : fallback;
}

/**
 * Récupère tous les signaux avec un filtre optionnel par statut.
 * @param {string} [status] - Filtre par statut (open, tp_hit, sl_hit, cancelled)
 * @returns {Array} Liste des signaux
 */
function getSignals(status) {
  if (status) {
    return db.prepare('SELECT * FROM signals WHERE status = ? ORDER BY created_at DESC').all(status);
  }
  return db.prepare('SELECT * FROM signals ORDER BY created_at DESC').all();
}

/**
 * Récupère les signaux créés après une certaine date.
 * @param {string} since - Date ISO (ex: '2024-01-01')
 * @returns {Array} Liste des signaux
 */
function getSignalsSince(since) {
  return db.prepare('SELECT * FROM signals WHERE created_at >= ? ORDER BY created_at DESC').all(since);
}

/**
 * Récupère les confirmations d'un signal spécifique.
 * @param {number} signalId - ID du signal
 * @returns {Array} Liste des confirmations
 */
function getConfirmations(signalId) {
  return db.prepare('SELECT * FROM confirmations WHERE signal_id = ? ORDER BY target_number ASC').all(signalId);
}

/**
 * Récupère tous les signaux terminés (avec un résultat final).
 * @returns {Array} Liste des signaux terminés
 */
function getClosedSignals() {
  return db.prepare(`
    SELECT * FROM signals
    WHERE status IN ('closed', 'stopped', 'partial', 'manual_close', 'tp_hit', 'all_tp_hit', 'sl_hit')
    ORDER BY created_at DESC
  `).all();
}

/**
 * Récupère les signaux terminés depuis une certaine date.
 * @param {string} since - Date ISO
 * @returns {Array} Liste des signaux terminés
 */
function getClosedSignalsSince(since) {
  return db.prepare(`
    SELECT * FROM signals
    WHERE status IN ('closed', 'stopped', 'partial', 'manual_close', 'tp_hit', 'all_tp_hit', 'sl_hit')
      AND created_at >= ?
    ORDER BY created_at DESC
  `).all(since);
}

/**
 * Compte le nombre total de signaux.
 * @returns {Object} Statistiques de comptage
 */
function countSignals() {
  const total = db.prepare('SELECT COUNT(*) as count FROM signals').get().count;
  const open = db.prepare("SELECT COUNT(*) as count FROM signals WHERE status IN ('open', 'partial')").get().count;
  const won = db.prepare("SELECT COUNT(*) as count FROM signals WHERE status IN ('closed', 'tp_hit', 'all_tp_hit')").get().count;
  const lost = db.prepare("SELECT COUNT(*) as count FROM signals WHERE status IN ('stopped', 'sl_hit')").get().count;
  const cancelled = db.prepare("SELECT COUNT(*) as count FROM signals WHERE status = 'cancelled'").get().count;

  return { total, open, won, lost, cancelled };
}

/**
 * Recupere la liste des groupes sources distincts.
 * @returns {Array<string>} Liste des noms de groupes
 */
function getGroups() {
  return db.prepare(
    "SELECT DISTINCT source_group_name FROM signals WHERE source_group_name IS NOT NULL ORDER BY source_group_name"
  ).all().map(r => r.source_group_name);
}

/**
 * Ferme proprement la connexion à la base de données.
 */
function close() {
  if (db) {
    db.close();
    logger.info('Base de données fermée proprement');
  }
}

module.exports = {
  init,
  insertSignal,
  insertConfirmation,
  insertCancellation,
  insertStopLoss,
  insertEntryZone,
  getSignalById,
  getLastPortfolioCapital,
  getSignals,
  getSignalsSince,
  getConfirmations,
  getClosedSignals,
  getClosedSignalsSince,
  countSignals,
  updateSignalPortfolio,
  updateSignalBinancePrices,
  resetPortfolioData,
  getGroups,
  close,
  // Fonctions pyramidales
  initSignalPosition,
  insertTradeExecution,
  getTradeExecutions,
  updateSignalPyramidState,
  getActivePositions,
  getOpenExposure,
  getAllSignalsChronological,
  deleteAllTradeExecutions,
  getStopLosses,
  getOpenTrades,
  updateSignalCurrentPrice,
};
