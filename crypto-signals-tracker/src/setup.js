// ============================================================
// setup.js - Script de configuration initiale
// ============================================================
// Ce script vous aide à configurer l'application pour la
// première fois. Il :
// 1. Vérifie que config/.env existe
// 2. Teste la connexion Telegram
// 3. Trouve le groupe cible et affiche son ID
// 4. Vérifie le bot de rapports
//
// Utilisation : node src/setup.js
// ============================================================

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');

// Chemin vers le fichier .env
const envPath = path.join(__dirname, '..', 'config', '.env');
const envExamplePath = path.join(__dirname, '..', 'config', '.env.example');

async function setup() {
  console.log('');
  console.log('================================================');
  console.log('  CRYPTO SIGNALS TRACKER - Configuration initiale');
  console.log('================================================');
  console.log('');

  // ---- Étape 1 : Vérifier le fichier .env ----
  console.log('[1/4] Vérification du fichier de configuration...');
  if (!fs.existsSync(envPath)) {
    console.log('');
    console.log('Le fichier config/.env n\'existe pas encore.');
    console.log('Copie du fichier .env.example...');
    fs.copyFileSync(envExamplePath, envPath);
    // Restreindre les permissions
    fs.chmodSync(envPath, 0o600);
    console.log('');
    console.log('IMPORTANT : Ouvrez le fichier config/.env et remplissez :');
    console.log('  - TELEGRAM_API_ID');
    console.log('  - TELEGRAM_API_HASH');
    console.log('  - TELEGRAM_PHONE');
    console.log('  - BOT_TOKEN');
    console.log('  - ADMIN_USER_ID');
    console.log('');
    console.log('Pour obtenir api_id et api_hash :');
    console.log('  1. Allez sur https://my.telegram.org/apps');
    console.log('  2. Connectez-vous avec votre numéro');
    console.log('  3. Cliquez sur "API development tools"');
    console.log('  4. Créez une application (mettez ce que vous voulez)');
    console.log('  5. Copiez api_id et api_hash');
    console.log('');
    console.log('Pour le bot token :');
    console.log('  1. Ouvrez Telegram et cherchez @BotFather');
    console.log('  2. Envoyez /newbot');
    console.log('  3. Suivez les instructions');
    console.log('  4. Copiez le token');
    console.log('');
    console.log('Pour votre admin user ID :');
    console.log('  1. Ouvrez Telegram et cherchez @userinfobot');
    console.log('  2. Envoyez /start');
    console.log('  3. Copiez votre ID');
    console.log('');
    console.log('Ensuite, relancez : node src/setup.js');
    process.exit(0);
  }

  // Charger les variables d'environnement
  dotenv.config({ path: envPath });
  console.log('  Fichier config/.env trouvé.');

  // Vérifier les variables requises
  const apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
  const apiHash = process.env.TELEGRAM_API_HASH;
  const phone = process.env.TELEGRAM_PHONE;

  if (!apiId || !apiHash || apiHash.includes('votre_')) {
    console.log('');
    console.log('ERREUR : Les variables TELEGRAM_API_ID et TELEGRAM_API_HASH ne sont pas remplies.');
    console.log('Ouvrez config/.env et remplissez-les.');
    process.exit(1);
  }

  console.log('  Variables de configuration OK.');
  console.log('');

  // ---- Étape 2 : Tester la connexion Telegram ----
  console.log('[2/4] Test de connexion à Telegram...');
  console.log('  (Vous recevrez peut-être un code de vérification)');
  console.log('');

  const sessionPath = path.join(__dirname, '..', 'session.json');
  let sessionString = '';
  if (fs.existsSync(sessionPath)) {
    sessionString = fs.readFileSync(sessionPath, 'utf-8').trim();
    console.log('  Session existante trouvée.');
  }

  const client = new TelegramClient(
    new StringSession(sessionString),
    apiId,
    apiHash,
    { connectionRetries: 5 }
  );

  await client.start({
    phoneNumber: async () => phone,
    phoneCode: async () => {
      return await input.text('  Entrez le code reçu sur Telegram : ');
    },
    password: async () => {
      return await input.text('  Entrez votre mot de passe 2FA : ');
    },
    onError: (err) => {
      console.error(`  ERREUR : ${err.message}`);
    },
  });

  // Sauvegarder la session
  const newSession = client.session.save();
  fs.writeFileSync(sessionPath, newSession, 'utf-8');
  fs.chmodSync(sessionPath, 0o600);
  console.log('  Session sauvegardée.');

  const me = await client.getMe();
  console.log(`  Connecté en tant que : ${me.firstName} ${me.lastName || ''}`);
  console.log('');

  // ---- Étape 3 : Trouver le groupe cible ----
  console.log('[3/4] Recherche du groupe cible...');
  const targetName = process.env.TARGET_GROUP_NAME || 'CryptoMau BTC Scalp Signals';
  console.log(`  Recherche de : "${targetName}"`);
  console.log('');

  const dialogs = await client.getDialogs({ limit: 100 });
  let found = false;

  for (const dialog of dialogs) {
    const title = dialog.title || '';
    if (title.toLowerCase().includes(targetName.toLowerCase())) {
      console.log(`  TROUVÉ ! "${title}"`);
      console.log(`  ID du groupe : ${dialog.id}`);
      console.log('');
      console.log(`  Ajoutez cette ligne dans config/.env :`);
      console.log(`  TARGET_GROUP_ID=${dialog.id}`);
      found = true;
      break;
    }
  }

  if (!found) {
    console.log(`  Groupe "${targetName}" non trouvé.`);
    console.log('');
    console.log('  Vos groupes/canaux disponibles :');
    for (const dialog of dialogs) {
      if (dialog.isGroup || dialog.isChannel) {
        console.log(`    - "${dialog.title}" (ID: ${dialog.id})`);
      }
    }
    console.log('');
    console.log('  Définissez TARGET_GROUP_NAME dans config/.env avec le nom exact.');
  }

  console.log('');

  // ---- Étape 4 : Vérifier le bot de rapports ----
  console.log('[4/4] Vérification du bot de rapports...');
  const botToken = process.env.BOT_TOKEN;
  if (botToken && !botToken.includes('ABC')) {
    console.log('  Token de bot configuré.');
    console.log(`  Admin ID : ${process.env.ADMIN_USER_ID}`);
    console.log('');
    console.log('  Pour tester le bot :');
    console.log('  1. Cherchez votre bot sur Telegram (par son nom)');
    console.log('  2. Envoyez /start');
    console.log('  3. Si le bot répond, tout est OK !');
  } else {
    console.log('  Bot token non configuré. Remplissez BOT_TOKEN dans config/.env.');
  }

  // Déconnecter
  await client.disconnect();

  console.log('');
  console.log('================================================');
  console.log('  Configuration terminée !');
  console.log('');
  console.log('  Pour lancer le tracker :');
  console.log('    node src/index.js');
  console.log('');
  console.log('  Pour lancer avec PM2 (24/7) :');
  console.log('    pm2 start src/index.js --name crypto-tracker');
  console.log('================================================');
  console.log('');

  process.exit(0);
}

setup().catch((err) => {
  console.error('Erreur pendant le setup :', err.message);
  process.exit(1);
});
