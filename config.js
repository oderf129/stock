// ─── CONFIGURATION ──────────────────────────────────────────────
// Colle ici l'« ID d'application (client) » obtenu sur portal.azure.com
// (voir README, étape 3). Laisse vide pour utiliser l'app en mode local
// (données stockées uniquement dans ce navigateur).
window.APP_CONFIG = {
  clientId: '',
  // 'consumers' = comptes Microsoft personnels (hotmail, outlook.com…)
  // 'common'    = comptes personnels ET professionnels (Microsoft 365)
  authority: 'consumers',
  // Fichier de sauvegarde dans OneDrive > Applications > <nom de l'app>
  // (.xlsx = classeur Excel lisible et modifiable ; .json possible aussi)
  fileName: 'Stock MLW.xlsx',
};
