# SIRH — Backend

API Express qui sert de proxy sécurisé devant Supabase. Déployée sur Render.
Le frontend est un dépôt séparé : `SIRH-SECURE-V_1-FRONTEND` (PWA en JS vanilla,
hébergée sur GitHub Pages, domaine `sirh.cataria-systems.com`).

## Architecture

- `server.js` — montage des routes, CORS, rate limiting, JWT, multer.
  **Toutes** les routes sont montées sous `/api` avec un seul routeur par
  domaine métier. `upload.any()` est appliqué globalement après le JWT.
- `routes/` — 14 routeurs, ~107 endpoints.
- `supabaseClient.js` — client Supabase avec la **clé de service**, qui
  contourne le RLS. C'est pour cela que le backend doit valider lui-même
  chaque permission (`checkPerm`).
- `password.js` — hachage bcrypt et génération de secrets. À utiliser pour
  tout mot de passe ou code OTP ; ne jamais employer `Math.random()`.
- `routePolicy.js` — méthodes HTTP autorisées par endpoint.
- `memoryCache.js` — cache mémoire process. Attention : Render peut faire
  tourner plusieurs instances, ce cache n'est donc pas partagé.
- `cron.js` — tâches planifiées, démarrées depuis `server.js`.

## Conventions

- **Tout nouvel endpoint doit être ajouté dans `routePolicy.js`**, sinon il
  tombe dans le comportement par défaut (GET et POST autorisés). Une écriture
  non déclarée en `WRITE_ONLY` reste déclenchable en GET.
- Préférer `router.get` / `router.post` à `router.all`. Les 83 `router.all`
  restants sont un héritage : les convertir au fil des modifications, sans
  oublier de vérifier l'appel correspondant côté frontend.
- Chaque route protégée commence par un `checkPerm(req, "can_...")`. Les noms
  de permissions correspondent aux colonnes de la table `role_permissions`.
- Les messages d'erreur destinés à l'utilisateur sont en français.
- Ne jamais journaliser de mot de passe, de code OTP ni de jeton : les logs
  Render sont consultables.

## Pièges connus

- **Pas de cloisonnement multi-entreprise.** Aucune table n'a de `company_id`
  exploité (seules `crm_leads`, `crm_stages`, `crm_fields_config` et
  `payroll_rules` en possèdent un, inutilisé). L'application est mono-client.
- **RLS presque complet.** La clé `anon` est publiée dans le frontend. Mesure
  du 20/08/2026 : sur 34 tables, seules `prescripteurs` (3 lignes, dont nom et
  téléphone) et `company_modules` (7 lignes) répondent à cette clé. Voir
  `sql/01_securite_rls.sql` pour fermer les deux et généraliser.
- Toute agrégation sur une période doit passer par `fetchAllRows()` (`utils.js`).
  PostgREST plafonne chaque réponse à 1000 lignes sans erreur : une requête
  mensuelle directe renvoie des totaux faux dès qu'on dépasse ce volume.
- `/update`, `/gatekeeper` et `/contract-gen` lisent leurs paramètres dans
  `req.query` tout en modifiant des données (voir `LEGACY_GET_WRITES`).
- `app_users.reset_code` sert à la fois au 2FA et à la réinitialisation de mot
  de passe. Un code de réinitialisation intercepté ouvre une session complète.
- Les fichiers sont en **LF**. `core.autocrlf=input` est configuré localement ;
  ne pas le changer, sinon le dépôt entier apparaît comme modifié.

## Développement

```bash
npm install
npm start          # démarre sur PORT (4000 par défaut)
```

Variables d'environnement requises : `JWT_SECRET`, `SUPABASE_URL`,
`SUPABASE_KEY`, `BREVO_API_KEY`, `ALERT_EMAIL`, `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY`. Optionnelles : `MAIL_FROM_EMAIL`, `MAIL_FROM_NAME`,
`PORT`, `MONITORING_ENABLED`.

Il n'existe pas encore de tests automatisés.

## Déploiement

Render se déclenche sur `main`.

**Ordre impératif : déployer le frontend AVANT le backend.** Le backend refuse
désormais `GET /api/login` (405). Si le backend part en premier, le frontend
encore en ligne enverra son ancien GET et plus personne ne pourra se connecter.
Dans l'autre sens il n'y a pas de coupure : le nouveau frontend envoie un POST,
que l'ancien backend accepte déjà.
