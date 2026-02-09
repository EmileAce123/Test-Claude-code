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

// Map des groupes cibles : chatId -> groupName
// Stocke PLUSIEURS formats d'ID pour chaque groupe (Bot API et MTProto)
let targetGroupsMap = new Map();

// Callback appele quand un nouveau message arrive
let onMessageCallback = null;

// Compteurs de diagnostic pour le monitoring
let messageCounters = {
  total: 0,         // Total de messages recus par le handler
  matched: 0,       // Messages d'un groupe cible
  parsed: 0,        // Messages avec du texte (envoyes au callback)
  unmatched: 0,     // Messages d'autres chats
  errors: 0,        // Erreurs de traitement
  lastMessageAt: null, // Timestamp du dernier message recu
};

/**
 * Convertit un ID de groupe Telegram en tous les formats possibles.
 * Telegram utilise differents formats d'ID selon le contexte :
 * - Bot API (supergroup/channel) : -100XXXXXXXXXX
 * - MTProto (channelId)          : XXXXXXXXXX (sans le prefixe -100)
 * - MTProto (chatId pour group)  : XXXXXXXXXX (valeur brute)
 *
 * @param {number|string} id - ID du groupe dans n'importe quel format
 * @returns {number[]} Tableau de tous les formats d'ID possibles
 */
function getAllPossibleIds(id) {
  const absId = Math.abs(Number(id));
  const ids = new Set([absId]);

  // Si c'est un ID Bot API de supergroup/channel (-100XXXXXXXXXX)
  // -> ajouter l'ID MTProto (sans le prefixe 100)
  if (absId > 1000000000000) {
    const mtprotoId = absId - 1000000000000;
    ids.add(mtprotoId);
  }

  // Si c'est un ID MTProto court
  // -> ajouter le format Bot API (avec prefixe 100)
  if (absId < 1000000000000 && absId > 0) {
    const botApiId = absId + 1000000000000;
    ids.add(botApiId);
  }

  return [...ids];
}

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
 *
 * IMPORTANT : Gere la conversion d'ID entre les formats Bot API et MTProto.
 * Bot API utilise -100XXXXXXXXXX pour les supergroups/channels.
 * MTProto (GramJS) utilise XXXXXXXXXX sans prefixe dans peerId.channelId.
 *
 * @param {Array<{id: number, name: string}>} groups - Tableau des groupes a ecouter
 * @param {Function} callback - Fonction appelee pour chaque nouveau message
 */
async function listenToGroups(groups, callback) {
  // Construire la map chatId -> groupName avec TOUS les formats d'ID possibles
  targetGroupsMap = new Map();
  for (const group of groups) {
    const possibleIds = getAllPossibleIds(group.id);
    for (const pid of possibleIds) {
      targetGroupsMap.set(pid, group.name);
    }
    logger.info(`Groupe enregistre : "${group.name}" (ID config: ${group.id}, IDs possibles: [${possibleIds.join(', ')}])`);
  }

  onMessageCallback = callback;

  // Reset des compteurs
  messageCounters = {
    total: 0, matched: 0, parsed: 0, unmatched: 0, errors: 0, lastMessageAt: null,
  };

  // Log periodique des compteurs (toutes les 5 minutes)
  const diagnosticInterval = setInterval(() => {
    if (messageCounters.total > 0) {
      logger.info(`[DIAGNOSTIC] Messages recus: ${messageCounters.total} | Groupes cibles: ${messageCounters.matched} | Parses: ${messageCounters.parsed} | Autres chats: ${messageCounters.unmatched} | Erreurs: ${messageCounters.errors} | Dernier: ${messageCounters.lastMessageAt || 'jamais'}`);
    } else {
      logger.info(`[DIAGNOSTIC] Aucun message recu depuis le demarrage. Verifiez la connexion et les groupes.`);
    }
  }, 5 * 60 * 1000);
  diagnosticInterval.unref(); // Ne pas empecher l'arret du process

  // Ajouter un gestionnaire d'evenements pour les nouveaux messages
  client.addEventHandler(async (event) => {
    try {
      const message = event.message;

      // FILTRE DE SECURITE : ignorer si ce n'est pas un message valide
      if (!message) return;

      messageCounters.total += 1;
      messageCounters.lastMessageAt = new Date().toISOString();

      // ---- Extraction de l'ID du chat source ----
      // GramJS peut fournir l'ID de plusieurs facons selon le type de chat
      let chatId = null;
      let peerType = 'unknown';

      if (message.peerId) {
        if (message.peerId.channelId) {
          // Supergroup ou channel -> channelId est l'ID MTProto (sans -100)
          chatId = Number(message.peerId.channelId);
          peerType = 'channel';
        } else if (message.peerId.chatId) {
          // Groupe regulier
          chatId = Number(message.peerId.chatId);
          peerType = 'chat';
        } else if (message.peerId.userId) {
          // Message prive -> ignorer
          peerType = 'user';
          return;
        }
      }

      // Fallback: essayer message.chatId (disponible dans certaines versions de GramJS)
      if (!chatId && message.chatId) {
        chatId = Math.abs(Number(message.chatId));
        peerType = 'chatId-fallback';
      }

      if (!chatId) {
        // Log les premiers messages sans chatId pour comprendre la structure
        if (messageCounters.total <= 10) {
          logger.warn(`[DIAGNOSTIC] Message #${messageCounters.total} sans chatId extractible. peerId: ${JSON.stringify(message.peerId)}`);
        }
        return;
      }

      const chatIdAbs = Math.abs(chatId);

      // Verifier que c'est bien un des groupes cibles
      const groupName = targetGroupsMap.get(chatIdAbs);

      if (!groupName) {
        messageCounters.unmatched += 1;
        // Log les 20 premiers messages non-cibles pour aider au debug
        if (messageCounters.unmatched <= 20) {
          const textPreview = (message.text || message.message || '').substring(0, 50);
          logger.info(`[DIAGNOSTIC] Message d'un chat NON cible | type: ${peerType} | chatId: ${chatIdAbs} | apercu: "${textPreview}..."`);
        }
        return;
      }

      messageCounters.matched += 1;

      // Le message vient d'un groupe cible -> le traiter
      const text = message.text || message.message || '';
      if (!text.trim()) return; // Ignorer les messages vides (photos, etc.)

      messageCounters.parsed += 1;

      // Log TOUJOURS les messages des groupes cibles au niveau INFO
      logger.info(`[MESSAGE] "${groupName}" (chatId: ${chatIdAbs}) : ${text.substring(0, 150)}${text.length > 150 ? '...' : ''}`);

      // Appeler le callback avec les donnees du message + le nom du groupe source
      await callback({
        id: message.id,
        text: text,
        date: message.date ? new Date(message.date * 1000) : new Date(),
        sourceGroup: groupName,
      });
    } catch (err) {
      messageCounters.errors += 1;
      logger.error(`Erreur traitement message : ${err.message}`);
      logger.error(err.stack);
    }
  }, new NewMessage({}));

  const groupNames = groups.map(g => `"${g.name}"`).join(', ');
  logger.info(`Ecoute active sur ${groups.length} groupes : ${groupNames}`);
  logger.info(`IDs enregistres dans la map : [${[...targetGroupsMap.keys()].join(', ')}]`);
}

/**
 * Retourne les compteurs de diagnostic.
 * @returns {Object} Compteurs de messages
 */
function getMessageCounters() {
  return { ...messageCounters };
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
  getMessageCounters,
  disconnect,
  isConnected,
};
