// ============================================================
// telegram-client.js - Connexion Telegram via API MTProto
// ============================================================
// Ce module se connecte à Telegram avec votre compte personnel
// en utilisant l'API MTProto (le même protocole que l'app officielle).
// Il écoute UNIQUEMENT le groupe cible et ignore tout le reste.
//
// SÉCURITÉ :
// - Lecture seule : aucun message n'est envoyé depuis votre compte
// - Filtrage strict : seuls les messages du groupe cible sont traités
// - Session sauvegardée localement (pas de re-connexion à chaque fois)
// ============================================================

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { Api } = require('telegram');
const input = require('input');
const fs = require('fs');
const logger = require('./logger');

// Variable qui stocke le client Telegram
let client = null;

// ID du groupe cible (détecté automatiquement)
let targetGroupId = null;

// Callback appelé quand un nouveau message arrive
let onMessageCallback = null;

/**
 * Charge la session sauvegardée (si elle existe).
 * Cela évite de redemander le code SMS à chaque démarrage.
 * @param {string} sessionPath - Chemin du fichier de session
 * @returns {string} La chaîne de session (vide si première connexion)
 */
function loadSession(sessionPath) {
  try {
    if (fs.existsSync(sessionPath)) {
      const sessionData = fs.readFileSync(sessionPath, 'utf-8');
      logger.info('Session Telegram existante chargée');
      return sessionData.trim();
    }
  } catch (err) {
    logger.warn(`Impossible de charger la session : ${err.message}`);
  }
  // Première connexion : session vide
  return '';
}

/**
 * Sauvegarde la session après connexion réussie.
 * @param {string} sessionPath - Chemin du fichier de session
 * @param {string} sessionString - Données de session à sauvegarder
 */
function saveSession(sessionPath, sessionString) {
  try {
    fs.writeFileSync(sessionPath, sessionString, 'utf-8');
    // Restreindre les permissions : lisible uniquement par le propriétaire
    fs.chmodSync(sessionPath, 0o600);
    logger.info('Session Telegram sauvegardée (permissions 600)');
  } catch (err) {
    logger.error(`Erreur sauvegarde session : ${err.message}`);
  }
}

/**
 * Se connecte à Telegram avec les identifiants fournis.
 * Lors de la première connexion, demandera le code SMS.
 * @param {Object} config - Configuration Telegram (apiId, apiHash, phone, sessionPath)
 */
async function connect(config) {
  const { apiId, apiHash, phone, sessionPath } = config;

  // Charger la session existante ou créer une nouvelle
  const sessionString = loadSession(sessionPath);
  const session = new StringSession(sessionString);

  // Créer le client Telegram
  client = new TelegramClient(session, apiId, apiHash, {
    // Nom qui apparaît dans les sessions actives sur Telegram
    connectionRetries: 5,
    deviceModel: 'Signals Tracker',
    systemVersion: 'Node.js',
    appVersion: '1.0.0',
  });

  logger.info('Connexion à Telegram en cours...');

  // Se connecter (demandera le code SMS si première fois)
  await client.start({
    phoneNumber: async () => phone,
    // Demander le code SMS dans le terminal
    phoneCode: async () => {
      logger.info('Un code de vérification a été envoyé sur Telegram');
      return await input.text('Entrez le code reçu sur Telegram : ');
    },
    // Demander le mot de passe 2FA si activé
    password: async () => {
      return await input.text('Entrez votre mot de passe 2FA : ');
    },
    // En cas d'erreur de connexion
    onError: (err) => {
      logger.error(`Erreur de connexion Telegram : ${err.message}`);
    },
  });

  // Sauvegarder la session pour les prochains démarrages
  const newSession = client.session.save();
  saveSession(sessionPath, newSession);

  logger.info('Connecté à Telegram avec succès !');

  // Vérifier que la connexion est bien établie
  const me = await client.getMe();
  logger.info(`Connecté en tant que : ${me.firstName} ${me.lastName || ''} (@${me.username || 'N/A'})`);
}

/**
 * Recherche le groupe cible par son nom et retourne son ID.
 * @param {string} groupName - Nom du groupe à chercher
 * @returns {number|null} L'ID du groupe ou null si non trouvé
 */
async function findGroup(groupName) {
  logger.info(`Recherche du groupe : "${groupName}"...`);

  // Récupérer la liste des dialogues (conversations)
  const dialogs = await client.getDialogs({ limit: 100 });

  for (const dialog of dialogs) {
    const title = dialog.title || '';
    // Comparaison insensible à la casse
    if (title.toLowerCase().includes(groupName.toLowerCase())) {
      targetGroupId = dialog.id;
      logger.info(`Groupe trouvé ! "${title}" (ID: ${targetGroupId})`);
      return targetGroupId;
    }
  }

  // Si le groupe n'est pas trouvé, afficher la liste des groupes disponibles
  logger.error(`Groupe "${groupName}" non trouvé. Groupes disponibles :`);
  for (const dialog of dialogs) {
    if (dialog.isGroup || dialog.isChannel) {
      logger.info(`  - "${dialog.title}" (ID: ${dialog.id})`);
    }
  }

  return null;
}

/**
 * Configure l'écoute des nouveaux messages sur le groupe cible.
 * SÉCURITÉ : Filtre strict - seuls les messages du groupe cible sont traités.
 * @param {number} groupId - ID du groupe à écouter
 * @param {Function} callback - Fonction appelée pour chaque nouveau message
 */
async function listenToGroup(groupId, callback) {
  targetGroupId = groupId;
  onMessageCallback = callback;

  // Ajouter un gestionnaire d'événements pour les nouveaux messages
  client.addEventHandler(async (event) => {
    try {
      const message = event.message;

      // FILTRE DE SÉCURITÉ : ignorer si ce n'est pas le groupe cible
      if (!message || !message.peerId) return;

      // Récupérer l'ID du chat source
      const chatId = message.peerId.channelId
        ? Number(message.peerId.channelId)
        : message.peerId.chatId
          ? Number(message.peerId.chatId)
          : null;

      // Vérifier que c'est bien le groupe cible
      // On compare en valeur absolue car les IDs de canaux peuvent être négatifs
      if (!chatId) return;

      const targetIdAbs = Math.abs(Number(targetGroupId));
      const chatIdAbs = Math.abs(chatId);

      if (chatIdAbs !== targetIdAbs) {
        // Message d'un autre chat -> on l'ignore silencieusement
        return;
      }

      // Le message vient du bon groupe -> le traiter
      const text = message.text || message.message || '';
      if (!text.trim()) return; // Ignorer les messages vides (photos, etc.)

      logger.debug(`Message reçu du groupe cible : ${text.substring(0, 100)}...`);

      // Appeler le callback avec les données du message
      await callback({
        id: message.id,
        text: text,
        date: message.date ? new Date(message.date * 1000) : new Date(),
      });
    } catch (err) {
      logger.error(`Erreur traitement message : ${err.message}`);
    }
  }, new NewMessage({}));

  logger.info(`Écoute active sur le groupe (ID: ${groupId}). En attente de signaux...`);
}

/**
 * Déconnecte proprement le client Telegram.
 */
async function disconnect() {
  if (client) {
    await client.disconnect();
    logger.info('Déconnecté de Telegram');
  }
}

/**
 * Vérifie si le client est connecté.
 * @returns {boolean}
 */
function isConnected() {
  return client && client.connected;
}

module.exports = {
  connect,
  findGroup,
  listenToGroup,
  disconnect,
  isConnected,
};
