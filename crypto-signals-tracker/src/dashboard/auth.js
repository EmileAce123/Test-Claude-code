// ============================================================
// auth.js - Middleware d'authentification pour le dashboard
// ============================================================
// Protège toutes les pages et API du dashboard avec un
// login/password défini dans config/.env.
// Utilise des sessions côté serveur (express-session).
// ============================================================

const crypto = require('crypto');
const logger = require('../logger');

// Nombre de tentatives max avant blocage temporaire (anti-bruteforce)
const MAX_ATTEMPTS = 5;
// Durée du blocage en millisecondes (15 minutes)
const LOCK_DURATION = 15 * 60 * 1000;

// Stockage des tentatives par IP
const loginAttempts = new Map();

/**
 * Vérifie si une IP est temporairement bloquée.
 * @param {string} ip - Adresse IP du client
 * @returns {boolean} true si l'IP est bloquée
 */
function isLocked(ip) {
  const record = loginAttempts.get(ip);
  if (!record) return false;
  if (record.attempts >= MAX_ATTEMPTS) {
    // Vérifier si le blocage est encore actif
    if (Date.now() - record.lastAttempt < LOCK_DURATION) {
      return true;
    }
    // Blocage expiré, réinitialiser
    loginAttempts.delete(ip);
    return false;
  }
  return false;
}

/**
 * Enregistre une tentative de connexion échouée.
 * @param {string} ip - Adresse IP du client
 */
function recordFailedAttempt(ip) {
  const record = loginAttempts.get(ip) || { attempts: 0, lastAttempt: 0 };
  record.attempts += 1;
  record.lastAttempt = Date.now();
  loginAttempts.set(ip, record);
}

/**
 * Réinitialise les tentatives après un login réussi.
 * @param {string} ip - Adresse IP du client
 */
function resetAttempts(ip) {
  loginAttempts.delete(ip);
}

/**
 * Compare deux chaînes en temps constant (anti timing-attack).
 * @param {string} a - Première chaîne
 * @param {string} b - Deuxième chaîne
 * @returns {boolean} true si identiques
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Middleware qui vérifie l'authentification.
 * Redirige vers /login si non connecté.
 */
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  // Si c'est un appel API, retourner 401
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Non authentifié' });
  }
  // Sinon, rediriger vers la page de login
  return res.redirect('/login');
}

/**
 * Gère la tentative de connexion (POST /api/login).
 * @param {string} validUser - Login attendu (depuis .env)
 * @param {string} validPassword - Mot de passe attendu (depuis .env)
 */
function handleLogin(validUser, validPassword) {
  return (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;

    // Vérifier si l'IP est bloquée
    if (isLocked(ip)) {
      logger.warn(`Tentative de login bloquée (trop de tentatives) : ${ip}`);
      return res.status(429).json({
        error: 'Trop de tentatives. Réessayez dans 15 minutes.',
      });
    }

    const { username, password } = req.body;

    // Valider les entrées
    if (!username || !password) {
      return res.status(400).json({ error: 'Login et mot de passe requis.' });
    }

    // Vérifier les identifiants (comparaison en temps constant)
    const userOk = safeCompare(username, validUser);
    const passOk = safeCompare(password, validPassword);

    if (userOk && passOk) {
      // Connexion réussie
      req.session.authenticated = true;
      resetAttempts(ip);
      logger.info(`Login réussi depuis ${ip}`);
      return res.json({ success: true });
    }

    // Connexion échouée
    recordFailedAttempt(ip);
    const record = loginAttempts.get(ip);
    const remaining = MAX_ATTEMPTS - (record ? record.attempts : 0);
    logger.warn(`Login échoué depuis ${ip} (${remaining} tentatives restantes)`);
    return res.status(401).json({
      error: `Identifiants incorrects. ${remaining > 0 ? remaining + ' tentatives restantes.' : 'Compte temporairement bloqué.'}`,
    });
  };
}

/**
 * Gère la déconnexion (POST /api/logout).
 */
function handleLogout(req, res) {
  req.session.destroy((err) => {
    if (err) {
      logger.error(`Erreur déconnexion : ${err.message}`);
    }
    res.json({ success: true });
  });
}

module.exports = {
  requireAuth,
  handleLogin,
  handleLogout,
};
