// ============================================================
// index.js - Point d'entree principal de l'application
// ============================================================
// Ce fichier orchestre tous les modules :
// 1. Charge la configuration
// 2. Initialise la base de donnees
// 3. Connecte le client Telegram (votre compte)
// 4. Resout les IDs de TOUS les groupes cibles
// 5. Demarre le bot de rapports
// 6. Programme les rapports automatiques
// 7. Ecoute les signaux sur TOUS les groupes simultanément
//
// SECURITE : Ce script ne fait que LIRE les messages.
// Aucun message n'est jamais envoye depuis votre compte personnel.
// ============================================================

const config = require('../config/config');
const telegramClient = require('./telegram-client');
const signalParser = require('./signal-parser');
const database = require('./database');
const reporter = require('./reporter');
const portfolio = require('./portfolio-simulator');
const logger = require('./logger');

/**
 * Fonction principale - Demarre toute l'application.
 */
async function main() {
  logger.info('=== Crypto Signals Tracker - Demarrage ===');

  // ---- Etape 1 : Initialiser la base de donnees ----
  logger.info('[1/6] Initialisation de la base de donnees...');
  database.init(config.database.path);

  // ---- Etape 2 : Configurer le portefeuille virtuel ----
  logger.info('[2/6] Configuration du portefeuille virtuel...');
  portfolio.configure(config.portfolio);

  // ---- Etape 3 : Connexion au compte Telegram (MTProto) ----
  logger.info('[3/6] Connexion a Telegram (votre compte)...');
  await telegramClient.connect(config.telegram);

  // ---- Etape 4 : Resoudre les IDs de tous les groupes cibles ----
  logger.info(`[4/6] Resolution de ${config.targets.length} groupe(s) cible(s)...`);
  const resolvedGroups = [];

  for (const group of config.targets) {
    if (group.id) {
      // ID deja connu depuis .env
      resolvedGroups.push({ id: group.id, name: group.name });
      logger.info(`  Groupe "${group.name}" -> ID ${group.id} (depuis .env)`);
    } else {
      // Rechercher le groupe par son nom
      const foundId = await telegramClient.findGroup(group.name);
      if (foundId) {
        resolvedGroups.push({ id: foundId, name: group.name });
        logger.info(`  Groupe "${group.name}" -> ID ${foundId} (auto-detecte)`);
      } else {
        logger.error(`  Groupe "${group.name}" introuvable ! Ignore.`);
      }
    }
  }

  if (resolvedGroups.length === 0) {
    logger.error('Aucun groupe cible resolu. Verifiez TARGET_GROUPS et TARGET_GROUP_IDS dans config/.env');
    process.exit(1);
  }

  logger.info(`${resolvedGroups.length}/${config.targets.length} groupe(s) resolu(s)`);

  // ---- Etape 5 : Demarrer le bot de rapports ----
  logger.info('[5/6] Demarrage du bot de rapports...');
  await reporter.init(config.bot);
  reporter.scheduleReports(config.reports);

  // ---- Etape 6 : Ecouter les messages de TOUS les groupes ----
  logger.info('[6/6] Demarrage de l\'ecoute multi-groupes...');
  await telegramClient.listenToGroups(resolvedGroups, handleMessage);

  // Notification de demarrage reussi
  const groupList = resolvedGroups.map(g => `• "${g.name}" (ID: ${g.id})`).join('\n');
  await reporter.sendReport(
    '🟢 *Crypto Signals Tracker demarre !*\n\n' +
    `Groupes surveilles (${resolvedGroups.length}) :\n` +
    groupList + '\n\n' +
    '🔧 _Diagnostic actif : les messages sont logues._\n' +
    'En attente de signaux...'
  );

  logger.info('=== Application demarree avec succes ! ===');
  logger.info(`Ecoute de ${resolvedGroups.length} groupes... (Ctrl+C pour arreter)`);

  // Log diagnostic toutes les 30 minutes pour confirmer que l'app tourne
  setInterval(() => {
    const counters = telegramClient.getMessageCounters();
    const dbCount = database.countSignals();
    logger.info(`[HEARTBEAT] Uptime: ${Math.round(process.uptime() / 60)} min | Messages: total=${counters.total} cibles=${counters.matched} parses=${counters.parsed} | DB: ${dbCount.total} signaux (${dbCount.open} ouverts)`);
  }, 30 * 60 * 1000).unref();
}

/**
 * Traite chaque message recu d'un groupe cible.
 * Parse le message et l'enregistre dans la base de donnees.
 * @param {Object} message - Message Telegram { id, text, date, sourceGroup }
 */
async function handleMessage(message) {
  try {
    // Parser le message pour identifier son type
    const parsed = signalParser.parseMessage(message);

    // Si le message n'est pas reconnu, on l'ignore
    if (!parsed) return;

    // Propager le nom du groupe source sur tous les types de messages
    parsed.sourceGroup = message.sourceGroup;

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
        // Trade annule manuellement
        database.insertCancellation(parsed);
        break;

      case 'stop_loss':
        // Stop loss touche
        database.insertStopLoss(parsed);
        await reporter.notifyStopLoss(parsed);
        break;

      case 'entry_zone':
        // Entree en zone de prix
        database.insertEntryZone(parsed);
        break;

      default:
        logger.debug(`Type de message non gere : ${parsed.type}`);
    }
  } catch (err) {
    logger.error(`Erreur traitement message ${message.id} : ${err.message}`);
    logger.error(err.stack);
  }
}

// ============================================================
// GESTION DE L'ARRET PROPRE
// ============================================================

// Intercepter les signaux d'arret (Ctrl+C, kill, etc.)
async function shutdown(signal) {
  logger.info(`Signal d'arret recu (${signal}). Fermeture propre...`);

  try {
    // Notifier l'arret
    await reporter.sendReport('🔴 *Crypto Signals Tracker arrete.*');
  } catch (err) {
    // Ignorer les erreurs de notification lors de l'arret
  }

  // Fermer les connexions
  await telegramClient.disconnect();
  await reporter.stop();
  database.close();

  logger.info('Application fermee proprement.');
  process.exit(0);
}

// Ecouter les signaux d'arret
process.on('SIGINT', () => shutdown('SIGINT'));   // Ctrl+C
process.on('SIGTERM', () => shutdown('SIGTERM')); // kill

// Attraper les erreurs non gerees
process.on('uncaughtException', (err) => {
  logger.error(`Erreur non geree : ${err.message}`);
  logger.error(err.stack);
  // Ne pas quitter - PM2 va redemarrer automatiquement si necessaire
});

process.on('unhandledRejection', (reason) => {
  logger.error(`Promesse rejetee non geree : ${reason}`);
});

// ---- LANCEMENT ----
main().catch((err) => {
  logger.error(`Erreur fatale au demarrage : ${err.message}`);
  logger.error(err.stack);
  process.exit(1);
});
