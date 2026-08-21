# SIRH — Passation

Document de reprise. Il contient l'état du projet, les décisions prises, ce
qu'il ne faut pas casser, et la suite à construire. À lire en entier avant
toute modification. Complété par `CLAUDE.md` (conventions techniques).

Dernière mise à jour : 21 août 2026.

---

## 1. Le produit

### Le problème

Une entreprise qui emploie des gens sur le terrain ne sait pas ce qui s'y passe :
ni si l'agent est arrivé, ni où il est, ni ce qu'il a fait, ni combien d'heures
lui payer. Tout se gère sur WhatsApp, sur des cahiers et sur Excel. Il en résulte
des heures contestées, des absences invisibles, des salaires calculés à la main
et des dossiers du personnel éparpillés.

### Ce que l'application apporte

Elle remplace la chaîne entière : l'agent pointe avec son téléphone et sa
position, remplit son rapport ; le responsable voit en direct qui est où ; le
mois se clôt sur des heures déjà calculées, un bulletin généré et un règlement
tracé. Le même outil gère le recrutement, les contrats, les congés et
l'archivage.

**En une phrase** : transformer une activité de terrain invisible en données
exploitables, sans que le terrain ait à faire autre chose que son travail.

### La proposition commerciale

Ce n'est pas un logiciel de gardiennage ni un logiciel de force de vente
médicale. C'est **un socle unique qui prend la forme du métier du client**.
Les concurrents vendent un outil par secteur ; celui-ci s'adapte.

### Le marché

Bénin, Afrique de l'Ouest. Trois types de clients visés :

| Type | Ce qu'il fait | Objet central |
|---|---|---|
| **Employeur** | Gère son propre personnel | L'employé |
| **Cabinet RH** | Gère les RH de plusieurs sociétés clientes | L'employé, par dossier |
| **Agence de placement** | Reçoit des dossiers, place les gens | Le candidat, puis le placement |

Recherche effectuée sur les acteurs béninois (UMO, EMMAC, GECA-Prospective,
Talents Plus Afrique, TECTRA) : ils annoncent tous **recrutement, placement,
intérim, mise à disposition, portage salarial et externalisation de la paie**.
Ils ne s'arrêtent donc pas à la mise en relation.

**Conséquence structurante** : en portage et en intérim, l'employeur légal
n'est pas l'entreprise où la personne travaille. Un engagement a besoin de deux
références distinctes — **où** la personne travaille (site, géofence) et **qui**
l'emploie (bulletin, cotisations, règlement).

---

## 2. Architecture actuelle

Deux dépôts GitHub, comptes `dominicbourgouin5-design` :

- **Backend** — `SIRH-BACKEND` · Node/Express · déployé sur Render
- **Frontend** — `SIRH-SECURE-V_1-FRONTEND` · PWA JS vanilla · GitHub Pages ·
  `sirh.cataria-systems.com`

Base : Supabase, projet **SIRH-SECURE-V0** (`wdfuqsqssapcrzhjsels`),
organisation **V2SIRH**. Attention : un autre compte Supabase contient Fahra,
NanGo, ALLMIGHTY — ne jamais y exécuter les scripts du SIRH.

Volumétrie : ~8 000 lignes backend (14 routeurs, 107 endpoints),
~12 500 lignes frontend. 34 tables.

Services : Brevo (email), web-push (notifications), docxtemplater (documents).

### Ordre de déploiement — impératif

**Frontend d'abord, backend ensuite.** Le backend refuse désormais
`GET /api/login` (405). Si le backend part en premier, l'ancien frontend
encore en ligne enverra son GET et plus personne ne pourra se connecter.

---

## 3. Ce qui a été fait

### Sécurité (branches `securite/p0`, poussées, non fusionnées)

| Correctif | Détail |
|---|---|
| Mots de passe | Étaient **en clair**. Hachage bcrypt, migration transparente à la première connexion réussie |
| Identifiants en URL | `/login` était appelé en GET avec le mot de passe en query string. Passé en POST |
| Contournement d'auth | `publicPaths.some(p => req.path.includes(p))` laissait passer toute route contenant `/login` ou `/ping` en sous-chaîne. Comparaison stricte |
| Méthodes HTTP | 83 routes en `router.all` : un GET déclenchait suppressions et écritures. `routePolicy.js` déclare les méthodes autorisées par endpoint |
| Codes OTP | `reset_code` servait au 2FA **et** à la réinitialisation. Un code de réinitialisation ouvrait une session admin. Séparés par `reset_purpose` |
| Badge public | Route publique à identifiant énumérable, deux emails par scan : annuaire aspirable et personnel inondable. Limiteur 30/h et une alerte par heure et par badge |
| Clé de scan | `SCAN_KEY = "SIGD_SECURE_2025"` en dur dans le frontend public. Remplacée par une vérification de jeton |
| Cache navigateur | Réponses nominatives conservées après déconnexion. Purge ajoutée |
| Démarrage | `webpush.setVapidDetails` levait une exception au chargement et tuait l'API entière si les clés manquaient |

### Correctifs fonctionnels

**La carte temps réel n'affichait qu'un seul agent.** `/get-live-positions`
dédupliquait sur `p.employee_id`, colonne absente du `SELECT` : la valeur était
`undefined` pour toutes les lignes. La première passait, les suivantes étaient
écartées. La requête lisait par ailleurs toute la table `pointages` sans borne.

**Les rapports mensuels étaient faux.** PostgREST plafonne chaque réponse à
1 000 lignes sans erreur ni avertissement : les agrégations mensuelles étaient
tronquées au-delà d'une cinquantaine d'agents. `fetchAllRows()` dans `utils.js`
pagine désormais. Corrigé aussi : `lte('heure', '2026-08-31')` est interprété
comme le 31 à 00:00:00, ce qui excluait **tout le dernier jour du mois**.

### Tests

`npm test` — 19 tests, lanceur natif de Node, sans base ni réseau. Couvrent le
hachage et la politique HTTP. Deux sont des garde-fous durables : l'un échoue si
une route classée en lecture se met à écrire, l'autre fige la liste des
écritures encore déclenchables en GET.

### Base de données — terminé

Quatre scripts appliqués sur SIRH-SECURE-V0. **Résultat final vérifié :
34 tables, RLS actif partout, zéro policy.**

| Script | Effet |
|---|---|
| `sql/01_securite_rls.sql` | RLS sur toutes les tables. Fermait la fuite `prescripteurs` (3 lignes : nom, fonction, téléphone — lisibles publiquement) |
| `sql/02_separation_codes_otp.sql` | Colonne `reset_purpose` |
| `sql/03_nettoyage_policies.sql` | 6 policies ouvertes au rôle `public` |
| `sql/04_policies_authenticated.sql` | 13 policies accordées à `authenticated` |

Chaque script commence par un **garde-fou** qui interrompt tout si les tables du
SIRH sont absentes — protection contre une exécution sur le mauvais projet.
Ne pas le retirer, le recopier dans tout nouveau script.

**Reste à faire, non urgent** : désactiver l'inscription Supabase Auth
(Authentication → Sign In / Providers → Email → *Allow new users to sign up*).
L'application n'utilise pas Supabase Auth. Sans policy, un compte créé n'obtient
plus rien, mais la porte n'a aucune raison de rester ouverte.

---

## 4. Décisions validées avec le client

1. **Déploiement : une instance par client payant.** Pas de base mutualisée.
   Une erreur de requête ne peut pas exposer les données d'un autre client, et
   la facturation est plus simple. Le SaaS mutualisé se justifiera à
   l'inscription libre en ligne.

2. **Cloisonnement par dossier obligatoire**, car les cabinets RH gèrent
   plusieurs sociétés. Deux niveaux : `organization` (le client qui paie) et
   `company` (le dossier, porteur du secteur). Les tables métier ne portent
   qu'une clé : `company_id`. L'`organization_id` ne vit que sur la table
   `companies` — c'est ce détail qui rendra la bascule vers le SaaS mécanique.

3. **Mode agence : les deux cas selon le dossier** — certains en placement
   simple, d'autres en portage salarial avec paie et pointage.

4. **Portail candidat dès la v1** — compte, dépôt de pièces, suivi
   d'avancement, convocations.

5. **Aucune automatisation des paiements.** Les agrégateurs béninois
   (FedaPay, KkiaPay) sont conçus pour encaisser, pas pour décaisser en masse,
   et une grande part des salaires se règle en espèces. L'application
   **constate** le règlement au lieu de l'exécuter :

   - la paie calcule les nets (`/process-payroll`, existant)
   - la comptabilité ouvre un **lot de règlement** pré-rempli
   - elle renseigne mode, date, référence, et joint la pièce justificative
   - elle valide : chaque salarié reçoit son reçu numéroté
   - le salarié **accuse réception par signature** dans l'application

   Le vrai problème n'est pas d'envoyer l'argent mais de **prouver qu'il a été
   reçu** — aujourd'hui un état de paie émargé au stylo. Les pads de signature
   existent déjà (contrats, visites). Tables : `reglements` et
   `reglement_lignes`. Les champs `mode` et `référence` sont exactement ceux
   qu'un agrégateur remplirait plus tard : rien à refaire le jour venu.

---

## 5. Le modèle cible

### Trois notions au lieu d'une

| Notion | Ce que c'est | Aujourd'hui |
|---|---|---|
| **Personne** | Identité, coordonnées, documents. Une seule fois | Éclatée entre `candidatures`, `app_users`, `employees` |
| **Dossier** | Une entreprise gérée, porteuse d'un secteur | Absent |
| **Engagement** | Le lien personne ↔ dossier : candidature, placement ou emploi | Confondu avec la personne |

`/candidate-action` **recopie** aujourd'hui le candidat vers `app_users` puis
`employees` : la même personne existe deux fois, sans lien. Avec le modèle
cible, une embauche change le type de l'engagement — l'historique n'est jamais
coupé.

### Les axes de configuration

Aujourd'hui `employee_type` (`OFFICE`/`MOBILE`/`FIXED`/`SECURITY`) fait deux
métiers à la fois : il décide des règles d'heures **et** de l'interface. C'est
la racine de la rigidité — un délégué médical de nuit est inexprimable.

À séparer en quatre réglages portés par l'engagement :

| Réglage | Détermine |
|---|---|
| `secteur` | Vocabulaire, modules, champs métier, formulaires, indicateurs |
| `perimetre_lieux` | Un seul lieu, sites assignés, ou catalogue ouvert |
| `contenu_pointage` | Minimal (arrivée/fin) ou formulaire complet obligatoire |
| `rythme` | Clôture automatique, heures supplémentaires, majoration de nuit |

### Le GPS n'est pas un réglage

Il est **requis à tout pointage**, dans tous les métiers. La **marge de
tolérance est une propriété du lieu**, pas du poste : une clinique en ville n'a
pas le même rayon qu'un site industriel.

| Profil | Périmètre | Créer un lieu | Contenu du pointage |
|---|---|---|---|
| Bureau / siège | Un seul lieu | Non | Arrivée et fin, photo et note optionnelles |
| Gardien | Sites assignés | Non | Arrivée et fin, photo et note optionnelles |
| Nettoyage | Sites assignés | Non | Arrivée et fin, contrôle qualité optionnel |
| Délégué médical | Catalogue ouvert | **Oui**, à la volée | **Formulaire obligatoire** : photo, signature, champs métier |

**Lieux provisoires** : les lieux sont normalement créés par un superviseur ou
un directeur depuis la page de configuration. Un délégué découvrant une clinique
absente du catalogue doit pouvoir l'ajouter sans attendre — mais ce lieu naît
**provisoire**, et le rapport qui s'y rattache passe **en attente de validation**
par un responsable. C'est ce qui empêche un agent de se fabriquer un site à côté
de chez lui.

### Rôles et hiérarchie

Deux choses distinctes, à ne pas confondre :

- **le rôle** dit ce qu'on a le droit de faire → `role_permissions`
- **la hiérarchie** dit sur qui → `employees.hierarchy_path` et
  `management_scope`, déjà en place et corrects

Superviseur, directeur régional, directeur sont des **niveaux hiérarchiques**,
pas des rôles distincts. Les traiter comme des rôles multiplie les combinaisons
à maintenir.

**À corriger** : le 2FA se déclenche sur `userRole === "ADMIN" || userRole === "RH"`
en dur dans `routes/auth.js`. Dès que les rôles deviennent configurables, un
« Directeur » créé par un client n'aura pas de double authentification. Doit
devenir un attribut du rôle.

### Le pack Bénin

| Paramètre | Valeur 2026 |
|---|---|
| CNSS salarié | 3,6 % du brut, sans plafond |
| CNSS patronal | 15,4 % (6,4 % retraite + 9 % autres branches) |
| ITS | 0 % jusqu'à 60 000, puis 10 / 15 / 19 / 30 / 40 % par tranche |
| SMIG | 52 000 FCFA brut/mois |

Ordre : brut → CNSS salarié → base imposable → ITS par tranches → net.
Les tables `salaries_config` et `payroll_rules` (colonne `data_source`) sont
la bonne structure : le Bénin devient un **pack pays**, pas du code en dur.

---

## 6. Ce qui existe et ne doit pas être cassé

C'est la partie la plus importante de ce document. Le socle est plus avancé
qu'il n'y paraît, et une refonte naïve détruirait du travail qui fonctionne.

### Le formulaire de visite terrain

`visit_reports` est déjà riche et cohérent. Champs alimentés par `/clock` :

| Champ | Rôle |
|---|---|
| `prescripteur_id` | Contact choisi dans le catalogue, UUID validé |
| `contact_nom_libre` | **Saisie libre quand le contact n'est pas au catalogue** |
| `presented_products` | Produits présentés, colonne `text[]` |
| `outcome` | Résultat de la visite, `VU` par défaut |
| `notes` | Texte du rapport |
| `proof_url` | Photo de preuve |
| `location_id` + `location_name` | Lieu détecté par GPS |
| `duration_minutes` | Calculé entre entrée et sortie |
| `schedule_ref_id` | Rattachement au planning |
| `crm_lead_id` | Liaison CRM : écrit une trace dans `crm_leads.history` |

**Le motif « pas dans le catalogue » existe déjà**, via `contact_nom_libre`.
C'est exactement le mécanisme voulu pour les lieux provisoires : l'étendre, ne
pas l'inventer.

### La dictée vocale

`js/modules/ops.js` (~ligne 2118) utilise le Web Speech API pour remplir le
rapport à la voix. Fonctionnalité essentielle sur le terrain — taper un rapport
sur un téléphone est un frein réel. **À préserver** dans tout nouveau
générateur de formulaires.

### Les signatures

Pads de signature déjà en place : `AppState.signaturePad` (contrats) et
`AppState.visitSignPad` (visites). Réutilisables tels quels pour la décharge
électronique des règlements.

### Les champs dynamiques

`crm_fields` et `crm_fields_config` sont le **seul mécanisme réellement
extensible** du projet. C'est le modèle à généraliser à toutes les entités,
pas à remplacer.

### Autres mécanismes en place

- `app_labels` → `/read-labels` → appliqué par sélecteurs CSS
  (`.label-visit-s`) dans `js/core/utils.js`. 10 chaînes, 5 concepts.
  Fonctionne, mais impose une classe sur chaque texte : conserver pour
  l'existant, compléter par une fonction `t('visit.singular')` pour le neuf.
- `company_modules` + `isModuleActive()` : mécanisme correct mais appelé à un
  seul endroit (`routes/recruitment.js`). À généraliser en middleware.
- `hierarchy_path` et `management_scope` : hiérarchie déjà fonctionnelle,
  utilisée dans `/read-report`.
- `contract_templates` + docxtemplater : génération de documents. Même
  mécanisme à réutiliser pour les reçus.
- `employee_archives`, export du dossier complet, candidatures avec
  approbation/refus/entretien et messages personnalisés : tout cela fonctionne.

---

## 7. Défauts connus, non corrigés

### Géolocalisation — `routes/mobile.js` (~ligne 115)

```js
let effectiveRadius = loc.radius || 100;
if (loc.isOffice) effectiveRadius = 1500;
else if (isMobileDevice) effectiveRadius = 100;
```

1. **Le rayon configuré est ignoré** : écrasé à 1 500 m pour un siège, 100 m
   pour un lieu mobile sur téléphone. La valeur saisie dans la page de
   configuration ne s'applique que pour un lieu mobile pointé depuis un
   ordinateur — le cas le plus rare. **Un employé de bureau peut donc pointer
   depuis 1,5 km.** Le contrôle de présence sur site ne contrôle rien.
2. **Premier lieu trouvé, pas le plus proche** (`break` dans la boucle) :
   attribution arbitraire quand deux lieux se chevauchent.
3. **Aucune notion de lieu provisoire** : rien ne distingue un site créé par le
   directeur d'un site créé par un agent.

### Autres

- **Chat temps réel non fonctionnel.** `js/modules/chat.js` s'abonne à
  `messages` avec la clé anon, mais les policies visaient `authenticated` — et
  il n'y a plus de policy du tout. Le polling fait tout le travail depuis le
  début. À rebrancher via le backend (`/read-messages` et `/send-message`
  existent).
- **Monolithes** : `js/modules/hr.js` (3 164 lignes) et `ops.js` (2 755 lignes),
  `index.html` de 155 Ko. À scinder au fil des modifications, sans réécriture
  massive.
- **83 `router.all`** subsistent. `routePolicy.js` les neutralise, mais les
  convertir reste souhaitable.
- **Écritures déclenchées en GET** encore tolérées : `/update`, `/gatekeeper`,
  `/contract-gen`, `/check-returns` (voir `LEGACY_GET_WRITES`).
- **Onboarding** : ce qui existe est une visite guidée de l'outil. L'intégration
  d'un nouvel employé — tâches, documents à fournir, validations — reste à
  construire.

---

## 8. Le plan

| # | Phase | Durée | Dépend de |
|---|---|---|---|
| 0 | Fusionner `securite/p0` — **frontend d'abord** | 1 j | — |
| 1 | Les quatre réglages + les trois défauts de géolocalisation | 4-6 j | — |
| 2 | Cloisonnement par dossier (`company_id` sur 34 tables, filtre sur 107 endpoints, garde-fou automatique) | 8-12 j | 1 |
| 3 | Champs dynamiques généralisés (`entity_fields`, `entity_records`) | 6-8 j | 2 |
| 4 | Frontend piloté par la configuration (`/bootstrap`, registre de vues, générateur de formulaires) | 8-12 j | 3 |
| 5 | Les packs métier | 2-3 j chacun | 4 |
| 6 | Pack Bénin, règlements et reçus | 5-8 j | indépendant |
| 7 | Portail candidat | 10-15 j | 2 |
| 8 | Temps réel et onboarding | 4-6 j | 4 |

**Le raccourci à ne pas prendre** : livrer les packs avant le moteur, en
dupliquant des pages pour le premier client. Ça marche une fois. Au deuxième
client on maintient deux applications ; au troisième, plus rien.

---

## 9. Reprendre le travail

```bash
cd "C:/Users/jbill/OneDrive/Bureau/SIRH/SIRH-BACKEND-main/SIRH-BACKEND-main"
git checkout securite/p0 && git pull
npm install && npm test
```

Environnement de développement : `npm start` avec `JWT_SECRET`, `SUPABASE_URL`,
`SUPABASE_KEY` — voir `CLAUDE.md`. Il n'existe pas encore de base de test
séparée ; les scripts SQL s'exécutent à la main dans le SQL Editor.

Outils authentifiés : `gh` (compte `dominicbourgouin5-design`) et le CLI
Supabase, lié à SIRH-SECURE-V0. `supabase inspect db` fonctionne sans Docker ;
`supabase db dump` et `db diff` en ont besoin et ne sont donc pas disponibles.

Plan détaillé et illustré : artefact **Packs Métier SIRH**
<https://claude.ai/code/artifact/8055c743-0dc7-4b44-ab0c-87af3dd17c2d>
