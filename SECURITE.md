# P0 Sécurité — ce qui a changé

Correctifs appliqués sur les bloqueurs qui empêchaient toute mise en production.
Aucun changement fonctionnel visible pour l'utilisateur : à comportement égal,
les failles sont fermées.

---

## 1. Mots de passe : du texte clair au hachage bcrypt

**Avant** : `routes/auth.js` comparait `user.password !== password`. Les mots de
passe étaient stockés en clair dans `app_users.password`. Une fuite de la base,
ou n'importe quel accès en lecture, livrait tous les comptes.

**Après** : nouveau module `password.js` (bcrypt, coût 12).

La migration est **transparente et progressive** — aucun utilisateur n'est
déconnecté ni obligé de changer de mot de passe :

1. à la connexion, si la valeur en base est un hash bcrypt → comparaison bcrypt ;
2. si c'est encore du texte clair → comparaison à temps constant, puis le mot de
   passe est **immédiatement ré-enregistré haché** (log `🔐 Mot de passe migré`) ;
3. au bout d'un cycle de connexions, plus aucun compte n'est en clair.

Pour suivre l'avancement de la migration :

```sql
SELECT
  COUNT(*) FILTER (WHERE password LIKE '$2%') AS haches,
  COUNT(*) FILTER (WHERE password NOT LIKE '$2%') AS encore_en_clair
FROM app_users;
```

Les comptes créés (`/write`, `/candidate-action`) sont hachés dès l'insertion.
Le mot de passe temporaire est toujours envoyé en clair **par email** au
destinataire, comme avant — c'est la base qui ne le connaît plus.

Au passage : `Math.random()` ne sert plus à générer de secret (mots de passe
temporaires et codes OTP utilisent désormais `crypto`).

## 2. Identifiants dans l'URL

`/login` était appelé en **GET** avec `?u=...&p=...` : le mot de passe se
retrouvait dans les logs Render, l'historique du navigateur et l'en-tête
`Referer`. La route est désormais **POST uniquement**, corps JSON.

Même correction pour le jeton de session : `?token=...` n'est plus accepté ni
envoyé (routes `/badge` et `/contract-gen`). Seul l'en-tête `Authorization`
fait foi.

## 3. Contournement d'authentification

`server.js` testait `req.path.includes(path)` sur la liste des routes publiques.
N'importe quelle route contenant `/login`, `/health` ou `/ping` en sous-chaîne
passait donc **sans jeton**. Remplacé par une comparaison stricte sur un `Set`.

## 4. Écritures déclenchables en GET

83 des 107 routes étaient déclarées en `router.all` : une suppression pouvait
être déclenchée par un simple GET (lien, préchargement, balise `<img>`).

Nouveau fichier `routePolicy.js` : une table unique associe chaque endpoint à
ses méthodes autorisées, appliquée globalement dans `server.js` (réponse 405
sinon). La table a été construite à partir des appels réels du frontend, et la
compatibilité des 87 appels a été vérifiée avant livraison.

Trois exceptions restent tolérées en GET et sont listées dans
`LEGACY_GET_WRITES` : `/update`, `/gatekeeper`, `/contract-gen`. Elles lisent
leurs paramètres dans `req.query` tout en modifiant des données ; les migrer
demande de toucher aussi le frontend.

## 5. Badge / gatekeeper : la clé partagée

`/gatekeeper` distinguait le « terminal interne » du « scan public » avec la
constante `SCAN_KEY = "SIGD_SECURE_2025"`, écrite en dur dans le backend **et
dans `js/core/config.js`**, donc lisible par tout visiteur du site. Quiconque
avait un identifiant de badge obtenait nom, poste, téléphone, adresse et statut.

Le scan interne exige désormais un **jeton de session valide** portant
`can_scan_badges` ou `can_see_employees`. La clé a été supprimée des deux côtés.
Le scan public (badge perdu) reste ouvert, sans changement.

## 6. Divers

- Les codes 2FA ne sont plus écrits dans les logs, la comparaison se fait à
  temps constant, la tolérance de 5 minutes après expiration est supprimée, et
  un code expiré est détruit en base.
- L'email d'alerte de sécurité n'est plus codé en dur sur une adresse Gmail
  personnelle : il utilise `ALERT_EMAIL` (déjà présent dans l'environnement).
  L'expéditeur est paramétrable via `MAIL_FROM_EMAIL` / `MAIL_FROM_NAME`
  (valeur actuelle conservée par défaut si les variables sont absentes).
- **Frontend** : à la déconnexion, `CacheStorage` et `sessionStorage` sont
  purgés. `secureFetch` met en cache toutes les réponses GET — fiches employés,
  paie, congés — qui restaient lisibles par l'utilisateur suivant sur un poste
  partagé.

---

## Déploiement

1. **Dépendance** — `bcryptjs` a été ajouté à `package.json`. Sur Render,
   `npm install` s'en charge au build. En local :

   ```bash
   npm install
   ```

2. **Base de données** — exécuter `sql/01_securite_rls.sql` dans
   Supabase > SQL Editor. Commencer par l'étape 0 (diagnostic) et lire le
   résultat avant d'appliquer les étapes 2 et 3.

3. **Ordre de mise en ligne** — déployer le backend **avant** le frontend :
   l'ancien frontend appelle `/login` en GET, qui répond maintenant 405.
   La fenêtre entre les deux déploiements doit être courte.

4. **Vérification post-déploiement** :

   ```bash
   curl -i "https://<backend>/api/login?u=test@test.com&p=test"     # attendu : 405
   curl -i "https://<backend>/api/read"                             # attendu : 401
   ```

---

## Reste à traiter (non couvert par ce lot)

- `app_users.reset_code` sert **à la fois** au code 2FA et au code de
  réinitialisation. Un code de réinitialisation intercepté ouvre donc une
  session complète sans mot de passe. Correctif : ajouter une colonne
  `reset_purpose` et la vérifier dans `/verify-2fa` et `/reset-password`.
- Aucune limite sur le nombre d'essais de code 2FA par compte (seul le
  rate-limit par IP existe).
- Les trois routes de `LEGACY_GET_WRITES` (voir §4).
- Le jeton JWT est stocké en `localStorage`, donc lisible par tout script de la
  page. Un cookie `httpOnly` serait préférable, mais impose de revoir le
  fonctionnement du frontend et le CORS.
