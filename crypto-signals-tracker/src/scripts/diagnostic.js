#!/usr/bin/env node
// ============================================================
// diagnostic.js - Script de diagnostic pour tester la connexion
// ============================================================
// Usage : node src/scripts/diagnostic.js
//
// Ce script :
// 1. Se connecte a Telegram via MTProto
// 2. Liste TOUS les groupes/channels disponibles
// 3. Compare avec les groupes cibles configures
// 4. Ecoute les messages pendant 60 secondes et affiche tout
// 5. Aide a identifier les problemes de connexion ou d'IDs
// ============================================================

const config = require('../../config/config');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const fs = require('fs');

// Couleurs pour la console
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';

function log(color, prefix, msg) {
  console.log(`${color}[${prefix}]${RESET} ${msg}`);
}

async function main() {
  log(BLUE, 'DIAGNOSTIC', '=== Crypto Signals Tracker - Diagnostic ===');
  log(BLUE, 'DIAGNOSTIC', '');

  // ---- 1. Verifier la configuration ----
  log(BLUE, 'CONFIG', 'Configuration chargee :');
  log(BLUE, 'CONFIG', `  API ID : ${config.telegram.apiId}`);
  log(BLUE, 'CONFIG', `  Phone : ${config.telegram.phone}`);
  log(BLUE, 'CONFIG', `  Session path : ${config.telegram.sessionPath}`);
  log(BLUE, 'CONFIG', `  Groupes cibles (${config.targets.length}) :`);
  for (const t of config.targets) {
    const absId = t.id ? Math.abs(t.id) : 'N/A';
    const mtprotoId = t.id && absId > 1000000000000 ? absId - 1000000000000 : absId;
    log(BLUE, 'CONFIG', `    - "${t.name}" | ID config: ${t.id} | abs: ${absId} | MTProto: ${mtprotoId}`);
  }
  console.log('');

  // ---- 2. Se connecter a Telegram ----
  log(YELLOW, 'CONNECT', 'Chargement de la session...');
  let sessionString = '';
  try {
    if (fs.existsSync(config.telegram.sessionPath)) {
      sessionString = fs.readFileSync(config.telegram.sessionPath, 'utf-8').trim();
      log(GREEN, 'CONNECT', 'Session trouvee');
    } else {
      log(RED, 'CONNECT', 'Aucune session trouvee ! Lancez d\'abord l\'application principale.');
      process.exit(1);
    }
  } catch (err) {
    log(RED, 'CONNECT', `Erreur lecture session : ${err.message}`);
    process.exit(1);
  }

  const session = new StringSession(sessionString);
  const client = new TelegramClient(session, config.telegram.apiId, config.telegram.apiHash, {
    connectionRetries: 5,
    deviceModel: 'Diagnostic Tool',
    systemVersion: 'Node.js',
    appVersion: '1.0.0',
  });

  log(YELLOW, 'CONNECT', 'Connexion a Telegram...');
  await client.connect();
  const me = await client.getMe();
  log(GREEN, 'CONNECT', `Connecte en tant que : ${me.firstName} ${me.lastName || ''} (@${me.username || 'N/A'})`);
  console.log('');

  // ---- 3. Lister les dialogues ----
  log(BLUE, 'DIALOGUES', 'Recuperation des dialogues (groupes, channels)...');
  const dialogs = await client.getDialogs({ limit: 200 });

  const groups = [];
  const channels = [];
  const others = [];

  for (const dialog of dialogs) {
    const title = dialog.title || dialog.name || '(sans titre)';
    const id = dialog.id;
    const entity = dialog.entity;

    let type = 'autre';
    let entityId = null;

    if (entity) {
      if (entity.className === 'Channel') {
        entityId = entity.id;
        if (entity.megagroup) {
          type = 'supergroup';
          groups.push({ title, dialogId: id, entityId, type });
        } else {
          type = 'channel';
          channels.push({ title, dialogId: id, entityId, type });
        }
      } else if (entity.className === 'Chat') {
        type = 'group';
        entityId = entity.id;
        groups.push({ title, dialogId: id, entityId, type });
      } else {
        others.push({ title, dialogId: id, type: entity.className });
      }
    }
  }

  log(GREEN, 'DIALOGUES', `Trouve : ${groups.length} groupes, ${channels.length} channels, ${others.length} autres`);
  console.log('');

  // ---- 4. Afficher les groupes et channels ----
  log(BLUE, 'GROUPES', '--- Groupes et supergroups ---');
  for (const g of groups) {
    const isTarget = config.targets.some(t => {
      if (!t.id) return false;
      const absId = Math.abs(t.id);
      const mtprotoId = absId > 1000000000000 ? absId - 1000000000000 : absId;
      return Number(g.entityId) === mtprotoId || Number(g.entityId) === absId
        || Number(g.dialogId) === t.id || Math.abs(Number(g.dialogId)) === absId;
    });
    const marker = isTarget ? `${GREEN}[CIBLE]${RESET}` : '';
    log(BLUE, 'GROUPES', `  ${marker} "${g.title}" | dialogId: ${g.dialogId} | entityId: ${g.entityId} | type: ${g.type}`);
  }
  console.log('');

  log(BLUE, 'CHANNELS', '--- Channels ---');
  for (const c of channels) {
    const isTarget = config.targets.some(t => {
      if (!t.id) return false;
      const absId = Math.abs(t.id);
      const mtprotoId = absId > 1000000000000 ? absId - 1000000000000 : absId;
      return Number(c.entityId) === mtprotoId || Number(c.entityId) === absId
        || Number(c.dialogId) === t.id || Math.abs(Number(c.dialogId)) === absId;
    });
    const marker = isTarget ? `${GREEN}[CIBLE]${RESET}` : '';
    log(BLUE, 'CHANNELS', `  ${marker} "${c.title}" | dialogId: ${c.dialogId} | entityId: ${c.entityId} | type: ${c.type}`);
  }
  console.log('');

  // ---- 5. Verifier les groupes cibles ----
  log(YELLOW, 'VERIFICATION', '--- Verification des groupes cibles ---');
  for (const target of config.targets) {
    const absId = target.id ? Math.abs(target.id) : null;
    const mtprotoId = absId && absId > 1000000000000 ? absId - 1000000000000 : absId;

    const found = [...groups, ...channels].find(g => {
      return Number(g.entityId) === mtprotoId || Number(g.entityId) === absId
        || Number(g.dialogId) === target.id || Math.abs(Number(g.dialogId)) === absId;
    });

    if (found) {
      log(GREEN, 'OK', `"${target.name}" -> TROUVE : "${found.title}" (entityId: ${found.entityId}, dialogId: ${found.dialogId})`);
    } else {
      log(RED, 'ERREUR', `"${target.name}" (ID: ${target.id}) -> NON TROUVE dans les dialogues !`);
      log(RED, 'ERREUR', `  Verifiez que le compte est bien membre de ce groupe.`);
    }
  }
  console.log('');

  // ---- 6. Ecouter les messages pendant 60 secondes ----
  log(YELLOW, 'ECOUTE', '--- Ecoute des messages pendant 60 secondes ---');
  log(YELLOW, 'ECOUTE', 'Tous les messages seront affiches (pas seulement les groupes cibles).');
  log(YELLOW, 'ECOUTE', 'Envoyez un message dans un groupe cible pour tester.');
  console.log('');

  let msgCount = 0;

  client.addEventHandler(async (event) => {
    try {
      const message = event.message;
      if (!message) return;

      msgCount += 1;
      const peerId = message.peerId || {};
      const channelId = peerId.channelId ? Number(peerId.channelId) : null;
      const chatId = peerId.chatId ? Number(peerId.chatId) : null;
      const userId = peerId.userId ? Number(peerId.userId) : null;
      const text = (message.text || message.message || '').substring(0, 100);

      // Verifier si c'est un groupe cible
      const resolvedId = channelId || chatId;
      let isTarget = false;
      if (resolvedId) {
        for (const target of config.targets) {
          const absId = target.id ? Math.abs(target.id) : null;
          const mtprotoId = absId && absId > 1000000000000 ? absId - 1000000000000 : absId;
          if (resolvedId === mtprotoId || resolvedId === absId) {
            isTarget = true;
            break;
          }
        }
      }

      const color = isTarget ? GREEN : YELLOW;
      const marker = isTarget ? '[CIBLE]' : '[AUTRE]';
      log(color, `MSG #${msgCount} ${marker}`, `channelId: ${channelId} | chatId: ${chatId} | userId: ${userId} | className: ${peerId.className}`);
      if (text) {
        log(color, `MSG #${msgCount}`, `  Texte: "${text}${text.length >= 100 ? '...' : ''}"`);
      }
    } catch (err) {
      log(RED, 'ERREUR', `Erreur message : ${err.message}`);
    }
  }, new NewMessage({}));

  // Attendre 60 secondes
  await new Promise(resolve => setTimeout(resolve, 60000));

  log(BLUE, 'RESULTAT', `${msgCount} message(s) recu(s) pendant la periode d'ecoute.`);
  if (msgCount === 0) {
    log(RED, 'RESULTAT', 'Aucun message recu ! Possible causes :');
    log(RED, 'RESULTAT', '  1. Aucune activite dans les groupes pendant le test');
    log(RED, 'RESULTAT', '  2. Le compte n\'est pas membre des groupes');
    log(RED, 'RESULTAT', '  3. Probleme de session/connexion');
  }

  await client.disconnect();
  log(BLUE, 'DIAGNOSTIC', '=== Diagnostic termine ===');
  process.exit(0);
}

main().catch(err => {
  log(RED, 'FATAL', `Erreur : ${err.message}`);
  log(RED, 'FATAL', err.stack);
  process.exit(1);
});
