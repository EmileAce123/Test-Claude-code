// ============================================================
// telegram-client.js - Connexion Telegram via API MTProto
// ============================================================
// Ce module se connecte a Telegram avec votre compte personnel
// en utilisant l'API MTProto (le meme protocole que l'app officielle).
// Il ecoute PLUSIEURS groupes cibles et ignore tout le reste.
//
// SECURITE :
// - Lecture seule : aucun message n'est envoye depuis votre compte
// - Filtrage strict : seuls les messages des groupes cibles sont traites
// - Session sauvegardee localement (pas de re-connexion a chaque fois)
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

// Map des groupes cibles : chatId (abs) -> groupName
// Permet de savoir de quel groupe vient chaque message
let targetGroupsMap = new Map();

// Callback appele quand un nouveau message arrive
let onMessageCallback = null;

/**
 * Charge la session sauvegardee (si elle existe).
 * Cela evite de redemander le code SMS a chaque demarrage.
 * @param {string} sessionPath - Chemin du fichier de session
 * @returns {string} La chaine de session (vide si premiere connexion)
 */
function loadSession(sessionPath) {
  try {
    if (fs.existsSync(sessionPath)) {
      const sessionData = fs.readFileSync(sessionPath, 'utf-8');
      logger.info('Session Telegram existante chargee');
      return sessionData.trim();
    }
  } catch (err) {
    logger.warn(`Impossible de charger la session : ${err.message}`);
  }
  // Premiere connexion : session vide
  return '';
}

/**
 * Sauvegarde la session apres connexion reussie.
 * @param {string} sessionPath - Chemin du fichier de session
 * @param {string} sessionString - Donnees de session a sauvegarder
 */
function saveSession(sessionPath, sessionString) {
  try {
    fs.writeFileSync(sessionPath, sessionString, 'utf-8');
    // Restreindre les permissions : lisible uniquement par le proprietaire
    fs.chmodSync(sessionPath, 0o600);
    logger.info('Session Telegram sauvegardee (permissions 600)');
  } catch (err) {
    logger.error(`Erreur sauvegarde session : ${err.message}`);
  }
}

/**
 * Se connecte a Telegram avec les identifiants fournis.
 * Lors de la premiere connexion, demandera le code SMS.
 * @param {Object} config - Configuration Telegram (apiId, apiHash, phone, sessionPath)
 */
async function connect(config) {
  const { apiId, apiHash, phone, sessionPath } = config;

  // Charger la session existante ou creer une nouvelle
  const sessionString = loadSession(sessionPath);
  const session = new StringSession(sessionString);

  // Creer le client Telegram
  client = new TelegramClient(session, apiId, apiHash, {
    // Nom qui apparait dans les sessions actives sur Telegram
    connectionRetries: 5,
    deviceModel: 'Signals Tracker',
    systemVersion: 'Node.js',
    appVersion: '1.0.0',
  });

  logger.info('Connexion a Telegram en cours...');

  // Se connecter (demandera le code SMS si premiere fois)
  await client.start({
    phoneNumber: async () => phone,
    // Demander le code SMS dans le terminal
    phoneCode: async () => {
      logger.info('Un code de verification a ete envoye sur Telegram');
      return await input.text('Entrez le code recu sur Telegram : ');
    },
    // Demander le mot de passe 2FA si active
    password: async () => {
      return await input.text('Entrez votre mot de passe 2FA : ');
    },
    // En cas d'erreur de connexion
    onError: (err) => {
      logger.error(`Erreur de connexion Telegram : ${err.message}`);
    },
  });

  // Sauvegarder la session pour les prochains demarrages
  const newSession = client.session.save();
  saveSession(sessionPath, newSession);

  logger.info('Connecte a Telegram avec succes !');

  // Verifier que la connexion est bien etablie
  const me = await client.getMe();
  logger.info(`Connecte en tant que : ${me.firstName} ${me.lastName || ''} (@${me.username || 'N/A'})`);
}

/**
 * Recherche un groupe par son nom et retourne son ID.
 * @param {string} groupName - Nom du groupe a chercher
 * @returns {number|null} L'ID du groupe ou null si non trouve
 */
async function findGroup(groupName) {
  logger.info(`Recherche du groupe : "${groupName}"...`);

  // Recuperer la liste des dialogues (conversations)
  const dialogs = await client.getDialogs({ limit: 100 });

  for (const dialog of dialogs) {
    const title = dialog.title || '';
    // Comparaison insensible a la casse
    if (title.toLowerCase().includes(groupName.toLowerCase())) {
      const groupId = dialog.id;
      logger.info(`Groupe trouve ! "${title}" (ID: ${groupId})`);
      return groupId;
    }
  }

  // Si le groupe n'est pas trouve, afficher la liste des groupes disponibles
  logger.error(`Groupe "${groupName}" non trouve. Groupes disponibles :`);
  for (const dialog of dialogs) {
    if (dialog.isGroup || dialog.isChannel) {
      logger.info(`  - "${dialog.title}" (ID: ${dialog.id})`);
    }
  }

  return null;
}

/**
 * Configure l'ecoute des nouveaux messages sur PLUSIEURS groupes cibles.
 * SECURITE : Filtre strict - seuls les messages des groupes cibles sont traites.
 * @param {Array<{id: number, name: string}>} groups - Tableau des groupes a ecouter
 * @param {Function} callback - Fonction appelee pour chaque nouveau message
 */
async function listenToGroups(groups, callback) {
  // Construire la map chatId -> groupName
  targetGroupsMap = new Map();
  for (const group of groups) {
    const absId = Math.abs(Number(group.id));
    targetGroupsMap.set(absId, group.name);
    logger.info(`Groupe enregistre : "${group.name}" (ID: ${group.id}, absID: ${absId})`);
  }

  onMessageCallback = callback;

  // Ajouter un gestionnaire d'evenements pour les nouveaux messages
  client.addEventHandler(async (event) => {
    try {
      const message = event.message;

      // FILTRE DE SECURITE : ignorer si ce n'est pas un groupe cible
      if (!message || !message.peerId) return;

      // Recuperer l'ID du chat source
      const chatId = message.peerId.channelId
        ? Number(message.peerId.channelId)
        : message.peerId.chatId
          ? Number(message.peerId.chatId)
          : null;

      if (!chatId) return;

      // Verifier que c'est bien un des groupes cibles
      const chatIdAbs = Math.abs(chatId);
      const groupName = targetGroupsMap.get(chatIdAbs);

      if (!groupName) {
        // Message d'un autre chat -> on l'ignore silencieusement
        return;
      }

      // Le message vient d'un groupe cible -> le traiter
      const text = message.text || message.message || '';
      if (!text.trim()) return; // Ignorer les messages vides (photos, etc.)

      logger.debug(`Message recu de "${groupName}" : ${text.substring(0, 100)}...`);

      // Appeler le callback avec les donnees du message + le nom du groupe source
      await callback({
        id: message.id,
        text: text,
        date: message.date ? new Date(message.date * 1000) : new Date(),
        sourceGroup: groupName,
      });
    } catch (err) {
      logger.error(`Erreur traitement message : ${err.message}`);
    }
  }, new NewMessage({}));

  const groupNames = groups.map(g => `"${g.name}"`).join(', ');
  logger.info(`Ecoute active sur ${groups.length} groupes : ${groupNames}`);
}

/**
 * Retourne le nom du groupe associe a un chatId.
 * @param {number} chatId - ID du chat
 * @returns {string|null} Nom du groupe ou null
 */
function getGroupName(chatId) {
  return targetGroupsMap.get(Math.abs(Number(chatId))) || null;
}

/**
 * Deconnecte proprement le client Telegram.
 */
async function disconnect() {
  if (client) {
    await client.disconnect();
    logger.info('Deconnecte de Telegram');
  }
}

/**
 * Verifie si le client est connecte.
 * @returns {boolean}
 */
function isConnected() {
  return client && client.connected;
}

module.exports = {
  connect,
  findGroup,
  listenToGroups,
  getGroupName,
  disconnect,
  isConnected,
};
