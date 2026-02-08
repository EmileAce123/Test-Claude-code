# Crypto Signals Tracker

Bot automatique qui capture les signaux de trading crypto depuis un groupe Telegram privé et analyse leur performance.

## Fonctionnalités

- Connexion à Telegram via votre compte personnel (API MTProto)
- Lecture seule : aucun message n'est envoyé depuis votre compte
- Détection automatique des signaux de trading (#SIGNAL)
- Suivi des confirmations (Take-Profit targets)
- Détection des stop loss et annulations
- Calculs de rentabilité globale (win rate, profit cumulé, drawdown)
- Rapports automatiques quotidiens et hebdomadaires
- Commandes à la demande (/stats, /today, /week, /open, /portfolio)
- **Portefeuille virtuel** : simulation avec capital, frais et leverage
  - Capital initial configurable (defaut: 200$)
  - Position sizing (10% du capital par trade)
  - Frais de transaction (0.5% entree + sortie)
  - Stop loss = liquidation de la position
  - Recalcul retroactif de tout l'historique
- **Dashboard web** accessible depuis internet (dark mode, responsive)
  - Vue d'ensemble avec KPI (profit, win rate, drawdown)
  - Section portefeuille virtuel (capital, ROI, gain, frais, graphique)
  - Graphiques interactifs (courbe de profit, performance par paire, par jour)
  - Historique des trades avec filtres et tri
  - Export CSV
  - Authentification par login/password
  - Rafraichissement automatique toutes les 30s

## Architecture

```
crypto-signals-tracker/
├── config/
│   ├── .env.example      ← Template de configuration
│   ├── .env              ← Vos identifiants (JAMAIS commité)
│   └── config.js         ← Chargement de la configuration
├── src/
│   ├── index.js           ← Point d'entrée principal
│   ├── telegram-client.js ← Connexion MTProto (votre compte)
│   ├── signal-parser.js   ← Parsing des messages de signaux
│   ├── database.js        ← Gestion base de données SQLite
│   ├── stats-calculator.js← Calculs de rentabilité
│   ├── reporter.js           ← Bot Telegram pour les rapports
│   ├── portfolio-simulator.js← Simulation portefeuille virtuel
│   ├── logger.js             ← Système de logs
│   ├── setup.js              ← Assistant de configuration
│   ├── manual-stats.js       ← Stats dans le terminal
│   ├── scripts/
│   │   ├── recalculate-portfolio.js ← Recalcul complet
│   │   ├── reset-portfolio.js       ← Reinitialisation
│   │   └── portfolio-stats.js       ← Stats dans le terminal
│   └── dashboard/
│       ├── server.js      ← Serveur Express (port 3001)
│       ├── routes.js      ← Endpoints API (lecture seule)
│       ├── auth.js        ← Authentification (login/password)
│       └── public/
│           ├── index.html ← Dashboard principal
│           ├── login.html ← Page de connexion
│           ├── style.css  ← Styles dark mode
│           └── app.js     ← Logique frontend + Chart.js
├── database/
│   └── signals.db         ← Base de données (créée automatiquement)
├── logs/
│   └── app.log            ← Fichier de logs
├── ecosystem.config.js    ← Configuration PM2
├── package.json
├── .gitignore
└── README.md
```

## Prérequis

- **Node.js v20.x** ou supérieur
- **npm** (installé avec Node.js)
- **PM2** (pour le fonctionnement 24/7) : `npm install -g pm2`
- Un compte Telegram (le vôtre)
- Être membre du groupe "CryptoMau BTC Scalp Signals"

## Installation pas à pas

### Étape 1 : Cloner le projet

```bash
git clone <url-du-repo>
cd crypto-signals-tracker
```

### Étape 2 : Installer les dépendances

```bash
npm install
```

### Étape 3 : Obtenir les identifiants Telegram

#### A) API ID et API Hash (pour votre compte)

1. Allez sur [https://my.telegram.org/apps](https://my.telegram.org/apps)
2. Connectez-vous avec votre numéro de téléphone
3. Cliquez sur **"API development tools"**
4. Remplissez le formulaire :
   - **App title** : Ce que vous voulez (ex: "Mon App")
   - **Short name** : Ce que vous voulez (ex: "monapp")
   - **Platform** : Desktop
5. Cliquez sur **"Create application"**
6. Notez votre **api_id** (un nombre) et **api_hash** (une chaîne)

> **IMPORTANT** : Ces identifiants sont personnels. Ne les partagez JAMAIS.

#### B) Bot Token (pour les rapports)

1. Ouvrez Telegram et cherchez **@BotFather**
2. Envoyez la commande `/newbot`
3. Choisissez un nom pour votre bot (ex: "Mon Tracker")
4. Choisissez un username (ex: `mon_tracker_bot`)
5. BotFather vous donnera un **token** (format: `123456789:ABCdef...`)
6. Notez ce token

#### C) Votre User ID

1. Ouvrez Telegram et cherchez **@userinfobot**
2. Envoyez `/start`
3. Le bot vous répondra avec votre **ID** (un nombre)
4. Notez cet ID

### Étape 4 : Configurer le projet

```bash
cp config/.env.example config/.env
```

Ouvrez `config/.env` avec un éditeur de texte et remplissez :

```
TELEGRAM_API_ID=12345678          ← Votre api_id
TELEGRAM_API_HASH=abcdef123456    ← Votre api_hash
TELEGRAM_PHONE=+33612345678       ← Votre numéro de téléphone
BOT_TOKEN=123456789:ABCdef...     ← Le token de votre bot
ADMIN_USER_ID=987654321           ← Votre user ID
```

### Étape 5 : Lancer la configuration initiale

```bash
npm run setup
```

Ce script va :
1. Vérifier votre fichier `.env`
2. Se connecter à Telegram (vous recevrez un code de vérification)
3. Chercher le groupe "CryptoMau BTC Scalp Signals"
4. Afficher l'ID du groupe à ajouter dans `.env`

### Étape 6 : Démarrer le tracker

```bash
# En mode normal (pour tester)
npm start

# En mode 24/7 avec PM2
pm2 start ecosystem.config.js

# Sauvegarder la config PM2 pour redémarrage auto au reboot
pm2 save
pm2 startup
```

## Commandes du bot

Une fois le tracker lancé, envoyez ces commandes à votre bot sur Telegram :

| Commande | Description |
|----------|-------------|
| `/start`     | Message de bienvenue |
| `/stats`     | Statistiques globales (tous les trades) |
| `/portfolio` | Portefeuille virtuel (capital, ROI, historique) |
| `/today`     | Résumé de la journée en cours |
| `/week`      | Résumé des 7 derniers jours |
| `/open`      | Liste des trades en cours |
| `/help`      | Aide |

## Rapports automatiques

- **Portfolio** : chaque jour à 21h59
- **Quotidien** : chaque jour à 23h00 (inclut le resume du portefeuille)
- **Hebdomadaire** : chaque dimanche à 23h00 (inclut le resume du portefeuille)

Les horaires sont configurables dans `config/.env`.

## Commandes PM2 utiles

```bash
pm2 status                    # Voir le statut
pm2 logs crypto-tracker       # Voir les logs en direct
pm2 restart crypto-tracker    # Redémarrer
pm2 stop crypto-tracker       # Arrêter
pm2 delete crypto-tracker     # Supprimer
```

## Dashboard Web

### Configuration

Ajoutez ces variables dans `config/.env` :

```
DASHBOARD_PORT=3001
DASHBOARD_USER=admin
DASHBOARD_PASSWORD=votre_mot_de_passe_ici
```

### Lancement

```bash
# En mode test
npm run dashboard

# En mode 24/7 avec PM2 (lance tracker + dashboard)
pm2 start ecosystem.config.js
```

Le dashboard est accessible sur `http://IP_DE_VOTRE_VPS:3001`.

### Fonctionnalites

- **KPI** : profit cumule, win rate, total trades, meilleur/pire trade, drawdown
- **Graphiques** : courbe de profit dans le temps, performance par paire, par jour de la semaine, distribution des profits
- **Tableau des trades** : filtrable par statut, paire, date. Triable par colonne
- **Export CSV** : telechargement de tous les trades au format CSV
- **Indicateur** : affiche si le bot Telegram est actif ou non
- **Rafraichissement** : les donnees se mettent a jour automatiquement toutes les 30 secondes

### Securite du dashboard

- Authentification par login/password (definis dans `.env`)
- Sessions cote serveur (cookie httpOnly, pas accessible par JavaScript)
- Protection anti-bruteforce : 5 tentatives max, blocage 15 minutes
- Comparaison des mots de passe en temps constant (anti timing-attack)
- Aucune ecriture dans la base de donnees (lecture seule)

### Reverse proxy nginx (optionnel)

Pour utiliser un nom de domaine avec HTTPS :

```nginx
server {
    listen 443 ssl;
    server_name tracker.votre-domaine.com;

    ssl_certificate /etc/letsencrypt/live/tracker.votre-domaine.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tracker.votre-domaine.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Pour obtenir un certificat SSL gratuit : `sudo certbot --nginx -d tracker.votre-domaine.com`

### Commandes PM2 pour le dashboard

```bash
pm2 logs crypto-dashboard     # Voir les logs du dashboard
pm2 restart crypto-dashboard  # Redemarrer le dashboard
pm2 stop crypto-dashboard     # Arreter le dashboard
```

## Portefeuille virtuel

Le portefeuille virtuel simule l'evolution d'un capital en appliquant chaque trade avec des conditions realistes.

### Configuration

Ajoutez ces variables dans `config/.env` :

```
VIRTUAL_PORTFOLIO_START=200        # Capital initial en $
MAX_POSITION_SIZE_PERCENT=10       # Taille max par position (% du capital)
TRADING_FEE_PERCENT=0.5            # Frais de transaction (%)
PORTFOLIO_REPORT_TIME=21:59        # Heure du rapport portfolio
```

### Logique de calcul

- **Position sizing** : chaque trade utilise max 10% du capital disponible
- **Take Profit** : profit = position x leverage x (profitPct / 100), frais deduits
- **Stop Loss** : liquidation = perte totale de la position de base + frais d'entree
- **Frais** : 0.5% sur le montant de base a l'entree, 0.5% sur la valeur finale a la sortie
- **Capital minimum** : le capital ne descend jamais en dessous de 0$

### Scripts utilitaires

```bash
# Recalculer tout l'historique du portefeuille
npm run recalculate-portfolio

# Reinitialiser les donnees de portefeuille (sans supprimer les trades)
npm run reset-portfolio

# Afficher les stats du portefeuille dans le terminal
npm run portfolio-stats
```

### Dashboard

La section portefeuille dans le dashboard affiche :
- Capital actuel, ROI, gain net, frais cumules
- Win Rate et pertes consecutives max
- Graphique d'evolution du capital dans le temps
- Colonne P&L Net ($) dans le tableau des trades

### API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/portfolio` | Etat complet du portefeuille |
| `GET /api/portfolio-history` | Historique pour le graphique |
| `GET /api/portfolio/best-worst` | Top 5 meilleurs et pires trades ($) |

## Statistiques dans le terminal

Pour afficher les stats directement dans le terminal (sans Telegram) :

```bash
npm run stats
```

## Sécurité

### Ce que fait le code

- Se connecte à Telegram avec votre compte (lecture seule)
- Lit UNIQUEMENT les messages du groupe configuré
- Stocke les données localement dans SQLite
- Envoie des rapports via un bot Telegram séparé
- Expose un dashboard web protege par login/password

### Ce que le code ne fait PAS

- N'envoie AUCUN message depuis votre compte personnel
- Ne lit PAS vos messages privés, groupes ou contacts
- N'accède PAS à vos fichiers ou photos
- Ne communique avec AUCUN serveur externe
- Ne stocke PAS vos identifiants en clair (sauf dans `.env`)

### Checklist de vérification

1. **Fichier `.env`** : permissions 600 (`chmod 600 config/.env`)
2. **Session Telegram** : permissions 600 (`chmod 600 session.json`)
3. **`.gitignore`** : vérifie que `.env` et `session.json` sont listés
4. **Dépendances** : vérifiez avec `npm audit`
5. **Logs** : vérifiez régulièrement `logs/app.log`

### Vérifier les sessions actives

1. Ouvrez Telegram
2. Allez dans Paramètres > Appareils
3. Vous verrez "Signals Tracker" dans la liste
4. Vous pouvez révoquer cette session à tout moment

## Dépannage

### "Groupe non trouvé"
- Vérifiez que vous êtes bien membre du groupe
- Vérifiez le nom exact dans `config/.env`
- Lancez `npm run setup` pour voir la liste de vos groupes

### "Code de vérification demandé à chaque fois"
- Vérifiez que `session.json` existe et a les bonnes permissions
- Supprimez `session.json` et reconnectez-vous

### "Le bot ne répond pas"
- Vérifiez le `BOT_TOKEN` dans `config/.env`
- Assurez-vous d'avoir envoyé `/start` au bot
- Vérifiez que `ADMIN_USER_ID` est correct

### "Le tracker crash au bout d'un moment"
- Vérifiez les logs : `pm2 logs crypto-tracker`
- Augmentez la mémoire : modifiez `max_memory_restart` dans `ecosystem.config.js`
- Vérifiez votre connexion internet

### "Les signaux ne sont pas détectés"
- Vérifiez les logs pour les messages "non reconnus"
- Le format des signaux a peut-être changé
- Contactez le développeur pour adapter le parser

## Format des signaux supportés

### Signal initial
```
#SIGNAL (POL/USDT) @CryptoKlondike
🔑 Open SHORT at price between $0.0989 - $0.1 with X25 leverage.
🍒 Targets:
1️⃣ Close the order at the price $0.09811
2️⃣ Close the order at the price $0.09771
3️⃣ Close the order at the price $0.09684
4️⃣ Close the order at the price $0.09584
5️⃣ Close the order at the price $0.09434
❗ STOP LOSS: $0.10327
```

### Confirmation de target
```
#POL/USDT Take-Profit target 1 ✅
Profit: 20.2224% 📈
Period: 14 Minutes ⏰
```

### Annulation
```
#SOL/USDT Manually Cancelled
```

### Entrée en zone
```
#POL/USDT Entered entry zone ✅
Period: 4 Minutes ⏰
```

## Licence

ISC
