// ============================================================
// server.js - Serveur Express pour le dashboard web
// ============================================================
// Ce serveur est INDÉPENDANT du bot Telegram principal.
// Il ouvre la base de données en lecture et expose une
// interface web pour consulter les statistiques.
//
// Lancement : node src/dashboard/server.js
// Ou via PM2 : pm2 start src/dashboard/server.js --name crypto-dashboard
// ============================================================

const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const dotenv = require('dotenv');

// Charger la configuration
dotenv.config({ path: path.join(__dirname, '..', '..', 'config', '.env') });

const database = require('../database');
const portfolio = require('../portfolio-simulator');
const binanceClient = require('../binance-client');
const priceUpdater = require('../price-updater');
const tradingEngine = require('../trading-engine');
const logger = require('../logger');
const auth = require('./auth');
const apiRoutes = require('./routes');

// ---- Configuration ----
const PORT = parseInt(process.env.DASHBOARD_PORT, 10) || 3001;
const DASH_USER = process.env.DASHBOARD_USER || 'admin';
const DASH_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const SESSION_SECRET = process.env.DASHBOARD_SECRET || crypto.randomBytes(32).toString('hex');
const DB_PATH = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, '..', '..', 'database', 'signals.db'));

// Vérifier que le mot de passe est défini
if (!DASH_PASSWORD) {
  console.error('[ERREUR] DASHBOARD_PASSWORD non défini dans config/.env');
  console.error('Ajoutez : DASHBOARD_PASSWORD=votre_mot_de_passe');
  process.exit(1);
}

// ---- Initialiser la base de données ----
database.init(DB_PATH);
logger.info(`Dashboard : base de données ouverte (${DB_PATH})`);

// ---- Configurer le portefeuille virtuel ----
portfolio.configure({
  startCapital: parseFloat(process.env.VIRTUAL_PORTFOLIO_START || '200'),
  maxPositionPct: parseFloat(process.env.MAX_POSITION_SIZE_PERCENT || '10'),
  tradingFeePct: parseFloat(process.env.TRADING_FEE_PERCENT || '0.5'),
});
logger.info('Dashboard : portefeuille virtuel configure');

// ---- Initialiser le trading engine (pour positions, balance, kill switch) ----
tradingEngine.init();
if (tradingEngine.isActive()) {
  tradingEngine.testConnection().then(ok => {
    if (ok) {
      logger.info(`Dashboard : Trading engine connecte (mode=${tradingEngine.mode})`);
    } else {
      logger.warn('Dashboard : Trading engine connexion echouee');
    }
  });
}

// ---- Initialiser le client Binance (pour prix temps reel + fermeture manuelle) ----
binanceClient.init();
if (binanceClient.isReady()) {
  binanceClient.testConnection().then(ok => {
    if (ok) {
      logger.info('Dashboard : Binance connecte - prix temps reel actifs');
      priceUpdater.start();
    } else {
      logger.warn('Dashboard : Binance connexion echouee - prix temps reel inactifs');
    }
  });
} else {
  logger.warn('Dashboard : Binance non configure (cles API manquantes) - prix temps reel inactifs');
}

// ---- Créer le serveur Express ----
const app = express();

// Parser le body des requêtes POST (pour le login)
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Configurer les sessions
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'crypto_dash_sid',
  cookie: {
    httpOnly: true,     // Pas accessible via JavaScript (anti-XSS)
    maxAge: 24 * 60 * 60 * 1000, // Expire après 24 heures
    sameSite: 'lax',    // Protection CSRF basique
  },
}));

// ---- Routes publiques (login) ----

// Page de login
app.get('/login', (req, res) => {
  // Si déjà connecté, rediriger vers le dashboard
  if (req.session && req.session.authenticated) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Endpoint de connexion
app.post('/api/login', auth.handleLogin(DASH_USER, DASH_PASSWORD));

// Endpoint de déconnexion
app.post('/api/logout', auth.handleLogout);

// ---- Toutes les autres routes nécessitent une authentification ----
app.use(auth.requireAuth);

// Fichiers statiques (CSS, JS frontend)
app.use(express.static(path.join(__dirname, 'public')));

// Routes API protégées
app.use('/api', apiRoutes);

// Page principale du dashboard (redirige vers index.html)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- Démarrer le serveur ----
app.listen(PORT, () => {
  logger.info(`Dashboard web démarré sur le port ${PORT}`);
  logger.info(`Accès : http://localhost:${PORT}`);
  const tradingMode = (process.env.TRADING_MODE || 'simulation').toUpperCase();
  console.log('');
  console.log('================================================');
  console.log(`  Dashboard accessible sur : http://localhost:${PORT}`);
  console.log(`  Login : ${DASH_USER}`);
  console.log(`  Trading : ${tradingMode}`);
  console.log('================================================');
  console.log('');
});

// Gestion de l'arrêt propre
process.on('SIGINT', () => {
  priceUpdater.stop();
  database.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
  priceUpdater.stop();
  database.close();
  process.exit(0);
});
