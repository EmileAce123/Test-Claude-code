// ============================================================
// config.js - Configuration centralisée de l'application
// ============================================================
// Ce fichier charge les variables d'environnement depuis .env
// et les expose de manière structurée au reste de l'application.
// ============================================================

// Charger les variables d'environnement depuis config/.env
const path = require('path');
const dotenv = require('dotenv');

// Chemin vers le fichier .env dans le dossier config
dotenv.config({ path: path.join(__dirname, '.env') });

// Vérifier que les variables essentielles sont définies
const required = ['TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'TELEGRAM_PHONE', 'BOT_TOKEN', 'ADMIN_USER_ID'];
for (const key of required) {
  if (!process.env[key] || process.env[key].includes('votre_') || process.env[key].includes('ici')) {
    // Ne pas bloquer si c'est juste le setup initial
    if (process.argv[1] && !process.argv[1].includes('setup')) {
      console.error(`[ERREUR] Variable d'environnement manquante ou non configurée : ${key}`);
      console.error('Veuillez copier config/.env.example vers config/.env et remplir les valeurs.');
      process.exit(1);
    }
  }
}

// Export de la configuration
module.exports = {
  // Identifiants API Telegram (compte utilisateur)
  telegram: {
    apiId: parseInt(process.env.TELEGRAM_API_ID, 10),
    apiHash: process.env.TELEGRAM_API_HASH,
    phone: process.env.TELEGRAM_PHONE,
    // Chemin du fichier de session (pour ne pas redemander le code SMS)
    sessionPath: path.join(__dirname, '..', 'session.json'),
  },

  // Configuration du bot Telegram (pour envoyer les rapports)
  bot: {
    token: process.env.BOT_TOKEN,
    adminUserId: parseInt(process.env.ADMIN_USER_ID, 10),
  },

  // Groupes cibles a surveiller (multi-groupes)
  targets: (() => {
    const names = (process.env.TARGET_GROUPS || 'CryptoMau BTC Scalp Signals').split(',').map(s => s.trim());
    const ids = (process.env.TARGET_GROUP_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    const groups = names.map((name, i) => ({
      name,
      id: ids[i] ? parseInt(ids[i], 10) : null,
    }));
    return groups;
  })(),

  // Base de données
  database: {
    path: path.resolve(process.env.DATABASE_PATH || path.join(__dirname, '..', 'database', 'signals.db')),
  },

  // Logs
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    path: path.resolve(process.env.LOG_PATH || path.join(__dirname, '..', 'logs', 'app.log')),
  },

  // Rapports automatiques
  reports: {
    dailyTime: process.env.DAILY_REPORT_TIME || '23:00',
    weeklyDay: parseInt(process.env.WEEKLY_REPORT_DAY || '0', 10),
    weeklyTime: process.env.WEEKLY_REPORT_TIME || '23:00',
    portfolioTime: process.env.PORTFOLIO_REPORT_TIME || '21:59',
  },

  // Binance API (lecture seule)
  binance: {
    apiKey: process.env.BINANCE_API_KEY || '',
    apiSecret: process.env.BINANCE_API_SECRET || '',
  },

  // Portefeuille virtuel
  portfolio: {
    startCapital: parseFloat(process.env.VIRTUAL_PORTFOLIO_START || '200'),
    maxPositionPct: parseFloat(process.env.MAX_POSITION_SIZE_PERCENT || '10'),
    tradingFeePct: parseFloat(process.env.TRADING_FEE_PERCENT || '0.5'),
  },

  // Trading automatique
  trading: {
    mode: process.env.TRADING_MODE || 'simulation',
    enabled: process.env.ENABLE_AUTO_TRADING === 'true',
    maxPositionPercent: parseFloat(process.env.MAX_POSITION_PERCENT || '5'),
    maxOpenPositions: parseInt(process.env.MAX_OPEN_POSITIONS || '20', 10),
    maxDailyLossPercent: parseFloat(process.env.MAX_DAILY_LOSS_PERCENT || '10'),
    killSwitchEnabled: process.env.ENABLE_KILL_SWITCH === 'true',
    testnet: {
      apiKey: process.env.BINANCE_TESTNET_API_KEY || '',
      apiSecret: process.env.BINANCE_TESTNET_API_SECRET || '',
    },
  },
};
