# Stock & Commandes — gestion de stock du restaurant

Application web (PC + téléphone) pour :

- **saisir ton stock** à date (inventaire) pour les références suivies ;
- obtenir des **suggestions automatiques** : quelle quantité commander, chez quel fournisseur, **quel jour** ;
- voir la **consommation réelle** sur n'importe quelle période (7 j, mois dernier, dates libres…) pour affiner tes commandes.

Hébergement gratuit sur **GitHub Pages**, données privées dans un **classeur Excel sur ton OneDrive** (`OneDrive/Applications/<nom de l'app>/Stock MLW.xlsx`), mis à jour à chaque saisie. Le code est public, tes données ne le sont pas.

Le classeur contient les onglets Synthèse (recalculée), Inventaires, Réceptions, Commandes, Références, Fournisseurs et Réglages. Tu peux le consulter ou le corriger dans Excel : l'app relit le fichier à chaque ouverture. Évite seulement de le garder ouvert en modification pendant que tu saisis dans l'app.

---

## Installation (≈ 20 min, une seule fois)

### 1. Mettre l'app sur GitHub

1. Crée un compte gratuit sur https://github.com (si tu n'en as pas).
2. **New repository** → nom : `stock` → **Public** → *Create repository*.
3. Clique sur **uploading an existing file**, glisse **tout le contenu** du dossier dézippé (y compris le dossier `vendor`) → *Commit changes*.
4. **Settings → Pages** → *Source : Deploy from a branch* → branche `main`, dossier `/ (root)` → *Save*.
5. Après 1–2 min, l'app est en ligne sur : `https://<ton-pseudo>.github.io/stock/`

À ce stade elle fonctionne déjà en **mode local** (données dans le navigateur uniquement). Tu peux tester avec *Réglages → Charger des données d'exemple*.

### 2. Autoriser l'app à écrire dans ton OneDrive (inscription Microsoft)

1. Va sur https://entra.microsoft.com (ou https://portal.azure.com) et connecte-toi avec ton compte Microsoft (celui de ton OneDrive).
   - Si le portail te demande de créer un compte/annuaire Azure gratuit, accepte : l'inscription d'application est gratuite.
2. **Applications → Inscriptions d'applications → Nouvelle inscription**
   - Nom : `Stock Restaurant`
   - Types de comptes : **Comptes Microsoft personnels uniquement** (hotmail/outlook)
     *(si ton OneDrive est un OneDrive Entreprise / Microsoft 365, choisis « comptes de n'importe quel annuaire et comptes personnels » et mets `authority: 'common'` à l'étape 3)*
   - URI de redirection : plateforme **Application monopage (SPA)** → `https://<ton-pseudo>.github.io/stock/` (avec le `/` final)
   - *S'inscrire*
3. Sur la page de l'application, copie l'**ID d'application (client)**.
4. (Facultatif) **Autorisations d'API → Ajouter → Microsoft Graph → Autorisations déléguées** : `Files.ReadWrite.AppFolder` et `User.Read`. Sinon elles seront demandées à la 1ère connexion.

### 3. Brancher l'app à OneDrive

1. Sur GitHub, ouvre `config.js` → icône crayon ✏️.
2. Colle l'ID : `clientId: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',` → *Commit changes*.
3. Attends 1 min, recharge l'app, clique **Se connecter à OneDrive** et accepte l'accès.
   L'app n'a accès qu'à **son propre dossier** OneDrive (`Applications/Stock Restaurant`), pas au reste de tes fichiers.

### 4. Sur le téléphone

Ouvre l'adresse dans Safari/Chrome → **Partager / ⋮ → Ajouter à l'écran d'accueil**. L'app s'ouvre comme une application.

---

## Utilisation

**Mise en place**
1. **Fournisseurs** : nom, type de commande (*jours fixes* ou *quand nécessaire*), jours où tu peux commander (ex. lundi + jeudi), délai de livraison en jours. Un même fournisseur avec deux rythmes (ex. Cook'oon sauces le lundi + surgelés quand nécessaire) = deux fiches fournisseur.
2. **Références** : nom, unité (kg, L, pièce, carton…), fournisseur, colisage (la commande est arrondie au colis), stock de sécurité en jours (optionnel), commande minimum (optionnel).
3. **Réglages** : jours de fermeture du restaurant (ils ne consomment rien).

**Routine**
- **Inventaire** (ex. 2 fois par semaine, la veille des jours de commande) : stock réel **en fin de journée**. Il faut **2 inventaires** minimum pour calculer une consommation.
- **Commandes** : l'app te dit, par fournisseur, quand commander et combien. Ajuste les quantités si besoin → **Valider cette commande**.
- **Réceptions** : à la livraison, *Réceptionner* (tu peux corriger les quantités livrées). Les achats hors commande (ex. Metro en dépannage) se saisissent dans *Réception hors commande*.
- **Consommation** : choisis une période → conso totale, moyenne par jour d'ouverture et par semaine, export CSV pour Excel.

**Le calcul**
- Conso entre deux inventaires = stock début + réceptions − stock fin, répartie sur les jours d'ouverture.
- Conso journalière = moyenne sur les 28 derniers jours (modifiable dans Réglages), ou valeur manuelle sur la référence.
- Quantité suggérée = conso/jour × (jours d'ouverture entre cette livraison et la suivante + jours de sécurité) − stock estimé la veille de la livraison − commandes déjà en cours, **arrondie au colis supérieur**.
- Alerte **Rupture** si le stock estimé tombe à zéro avant la prochaine livraison possible.
- **Recalage par les inventaires** : quand une référence a des recettes, la conso théorique (ventes Zelty × recettes) est multipliée par l'écart réel constaté entre tes inventaires (ex. « ×1,15 inv. » = 15 % de plus que prévu : pertes, portions…).
- **Fournisseur « quand nécessaire »** (ex. surgelés) : le stock théorique part du dernier inventaire et baisse chaque jour selon les ventes. L'app conseille le **dernier jour de commande** possible pour être livré avant que la première référence du fournisseur passe sous son seuil de sécurité (stock minimum ou jours de sécurité), et calcule une commande groupée qui couvre la *couverture visée* (14 j par défaut). Chaque nouvel inventaire recale la projection.

**Sauvegarde** : le classeur Excel sur OneDrive est la sauvegarde (OneDrive garde l'historique des versions). *Réglages → Télécharger le fichier Excel* en fait une copie.

**Première mise en route** : connecte-toi à OneDrive dans l'app, puis *Réglages → Importer* le fichier `Stock MLW.xlsx` fourni (historique depuis août). L'app crée alors le classeur dans ton OneDrive.

---

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html`, `style.css`, `app.js` | Interface |
| `engine.js` | Calculs (consommation, stock estimé, suggestions) |
| `store.js` | Cache local + synchronisation OneDrive (Microsoft Graph) |
| `xlsxio.js` | Lecture / écriture du classeur Excel |
| `vendor/xlsx.full.min.js` | Bibliothèque SheetJS (lecture/écriture Excel) |
| `config.js` | **À modifier** : ID d'application Microsoft |
| `vendor/msal-browser.min.js` | Bibliothèque officielle Microsoft de connexion (MSAL 3.27) |
