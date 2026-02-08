// ============================================================
// ecosystem.config.js - Configuration PM2
// ============================================================
// PM2 est un gestionnaire de processus Node.js qui permet
// de faire tourner l'application 24/7 avec redémarrage auto.
//
// Commandes utiles :
//   pm2 start ecosystem.config.js   → Démarrer
//   pm2 status                      → Voir le statut
//   pm2 logs crypto-tracker         → Voir les logs
//   pm2 restart crypto-tracker      → Redémarrer
//   pm2 stop crypto-tracker         → Arrêter
//   pm2 delete crypto-tracker       → Supprimer
// ============================================================

module.exports = {
  apps: [
    {
      // Nom de l'application dans PM2
      name: 'crypto-tracker',

      // Script à exécuter
      script: 'src/index.js',

      // Dossier de travail
      cwd: __dirname,

      // Redémarrer automatiquement en cas de crash
      autorestart: true,

      // Attendre 5 secondes avant de redémarrer après un crash
      restart_delay: 5000,

      // Nombre maximum de redémarrages consécutifs (évite les boucles infinies)
      max_restarts: 10,

      // Observer les changements de fichiers (désactivé en production)
      watch: false,

      // Limite mémoire (redémarrage si dépassé)
      max_memory_restart: '200M',

      // Variables d'environnement
      env: {
        NODE_ENV: 'production',
      },

      // Fichiers de logs PM2
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',

      // Format des logs avec timestamp
      time: true,

      // Fusionner les logs d'erreur et de sortie standard
      merge_logs: true,
    },
  ],
};
