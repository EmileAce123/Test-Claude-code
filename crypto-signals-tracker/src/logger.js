// ============================================================
// logger.js - Système de journalisation (logging)
// ============================================================
// Utilise Winston pour écrire les logs dans un fichier
// et aussi dans la console. Utile pour le debug.
// ============================================================

const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Créer le dossier de logs s'il n'existe pas
const logDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Chemin du fichier de log
const logPath = path.join(logDir, 'app.log');

// Format personnalisé pour les logs : [date] [niveau] message
const customFormat = winston.format.printf(({ level, message, timestamp }) => {
  return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
});

// Créer le logger Winston
const logger = winston.createLogger({
  // Niveau minimum des logs (debug = tout afficher, info = normal)
  level: process.env.LOG_LEVEL || 'info',

  // Format des logs
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    customFormat
  ),

  // Destinations des logs
  transports: [
    // Écrire dans le fichier (rotation automatique à 5 Mo)
    new winston.transports.File({
      filename: logPath,
      maxsize: 5 * 1024 * 1024, // 5 Mo maximum par fichier
      maxFiles: 3, // Garder 3 fichiers d'historique
    }),

    // Afficher dans la console (pour le debug)
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        customFormat
      ),
    }),
  ],
});

module.exports = logger;
