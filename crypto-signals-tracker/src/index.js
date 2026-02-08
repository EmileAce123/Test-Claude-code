// ============================================================
// index.js - Point d'entrée principal de l'application
// ============================================================
// Ce fichier orchestre tous les modules :
// 1. Charge la configuration
// 2. Initialise la base de données
// 3. Connecte le client Telegram (votre compte)
// 4. Démarre le bot de rapports
// 5. Programme les rapports automatiques
// 6. Écoute les signaux sur le groupe cible
//
// SÉCURITÉ : Ce script ne fait que LIRE les messages.
// Aucun message n'est jamais envoyé depuis votre compte personnel.
// ============================================================

const config = require('../config/config');
const telegramClient = require('./telegram-client');
const signalParser = require('./signal-parser');
const database = require('./database');
const reporter = require('./reporter');
const logger = require('./logger');

/**
 * Fonction principale - Démarre toute l'application.
 */
async function main() {
  logger.info('=== Crypto Signals Tracker - Démarrage ===');

  // ---- Étape 1 : Initialiser la base de données ----
  logger.info('[1/5] Initialisation de la base de données...');
  database.init(config.database.path);

  // ---- Étape 2 : Connexion au compte Telegram (MTProto) ----
  logger.info('[2/5] Connexion à Telegram (votre compte)...');
  await telegramClient.connect(config.telegram);

  // ---- Étape 3 : Trouver le groupe cible ----
  logger.info('[3/5] Recherche du groupe cible...');
  let groupId = config.target.groupId;
  if (!groupId) {
    // Rechercher le groupe par son nom
    groupId = await telegramClient.findGroup(config.target.groupName);
    if (!groupId) {
      logger.error(`Impossible de trouver le groupe "${config.target.groupName}".`);
      logger.error('Vérifiez que vous êtes bien membre du groupe.');
      logger.error('Vous pouvez aussi définir TARGET_GROUP_ID manuellement dans config/.env');
      process.exit(1);
    }
    logger.info(`Groupe trouvé ! Ajoutez TARGET_GROUP_ID=${groupId} dans config/.env pour accélérer les prochains démarrages.`);
  }

  // ---- Étape 4 : Démarrer le bot de rapports ----
  logger.info('[4/5] Démarrage du bot de rapports...');
  await reporter.init(config.bot);
  reporter.scheduleReports(config.reports);

  // ---- Étape 5 : Écouter les messages du groupe ----
  logger.info('[5/5] Démarrage de l\'écoute des signaux...');
  await telegramClient.listenToGroup(groupId, handleMessage);

  // Notification de démarrage réussi
  await reporter.sendReport(
    '🟢 *Crypto Signals Tracker démarré !*\n\n' +
    `Groupe surveillé : "${config.target.groupName}"\n` +
    'En attente de signaux...'
  );

  logger.info('=== Application démarrée avec succès ! ===');
  logger.info('En attente de signaux... (Ctrl+C pour arrêter)');
}

/**
 * Traite chaque message reçu du groupe cible.
 * Parse le message et l'enregistre dans la base de données.
 * @param {Object} message - Message Telegram { id, text, date }
 */
async function handleMessage(message) {
  try {
    // Parser le message pour identifier son type
    const parsed = signalParser.parseMessage(message);

    // Si le message n'est pas reconnu, on l'ignore
    if (!parsed) return;

    // Traiter selon le type de message
    switch (parsed.type) {
      case 'signal':
        // Nouveau signal de trading
        const insertedSignal = database.insertSignal(parsed);
        if (insertedSignal) {
          // Notifier via le bot
          await reporter.notifyNewSignal(parsed);
        }
        break;

      case 'confirmation':
        // Target atteint
        const insertedConfirmation = database.insertConfirmation(parsed);
        if (insertedConfirmation) {
          await reporter.notifyConfirmation(parsed);
        }
        break;

      case 'cancellation':
        // Trade annulé manuellement
        database.insertCancellation(parsed);
        break;

      case 'stop_loss':
        // Stop loss touché
        database.insertStopLoss(parsed);
        await reporter.notifyStopLoss(parsed);
        break;

      case 'entry_zone':
        // Entrée en zone de prix
        database.insertEntryZone(parsed);
        break;

      default:
        logger.debug(`Type de message non géré : ${parsed.type}`);
    }
  } catch (err) {
    logger.error(`Erreur traitement message ${message.id} : ${err.message}`);
    logger.error(err.stack);
  }
}

// ============================================================
// GESTION DE L'ARRÊT PROPRE
// ============================================================

// Intercepter les signaux d'arrêt (Ctrl+C, kill, etc.)
async function shutdown(signal) {
  logger.info(`Signal d'arrêt reçu (${signal}). Fermeture propre...`);

  try {
    // Notifier l'arrêt
    await reporter.sendReport('🔴 *Crypto Signals Tracker arrêté.*');
  } catch (err) {
    // Ignorer les erreurs de notification lors de l'arrêt
  }

  // Fermer les connexions
  await telegramClient.disconnect();
  await reporter.stop();
  database.close();

  logger.info('Application fermée proprement.');
  process.exit(0);
}

// Écouter les signaux d'arrêt
process.on('SIGINT', () => shutdown('SIGINT'));   // Ctrl+C
process.on('SIGTERM', () => shutdown('SIGTERM')); // kill

// Attraper les erreurs non gérées
process.on('uncaughtException', (err) => {
  logger.error(`Erreur non gérée : ${err.message}`);
  logger.error(err.stack);
  // Ne pas quitter - PM2 va redémarrer automatiquement si nécessaire
});

process.on('unhandledRejection', (reason) => {
  logger.error(`Promesse rejetée non gérée : ${reason}`);
});

// ---- LANCEMENT ----
main().catch((err) => {
  logger.error(`Erreur fatale au démarrage : ${err.message}`);
  logger.error(err.stack);
  process.exit(1);
});
