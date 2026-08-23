-- ============================================================================
--  GARDE-FOU — À NE PAS SUPPRIMER
-- ----------------------------------------------------------------------------
--  Ce script ne doit s'exécuter que sur la base du SIRH.
--  Lancé par erreur sur un autre projet Supabase, il modifierait des tables
--  qui ne lui appartiennent pas. Le bloc ci-dessous interrompt tout si les
--  tables attendues sont absentes.
--
--  Projet attendu : SIRH-SECURE-V0  (ref wdfuqsqssapcrzhjsels)
-- ============================================================================

DO $$
DECLARE manquantes text;
BEGIN
  SELECT string_agg(t, ', ')
    INTO manquantes
    FROM unnest(ARRAY['employees', 'app_users', 'pointages', 'conges']) AS t
   WHERE to_regclass('public.' || t) IS NULL;

  IF manquantes IS NOT NULL THEN
    RAISE EXCEPTION
      'Mauvaise base de donnees : les tables % sont introuvables. Ce script est destine au projet SIRH-SECURE-V0 (wdfuqsqssapcrzhjsels). Aucune modification n''a ete appliquee.',
      manquantes;
  END IF;
END $$;


-- ============================================================================
--  SIRH — PHASE 1 : AXES DE CONFIGURATION EMPLOYÉ + LIEUX PROVISOIRES
-- ----------------------------------------------------------------------------
--  Ajoute quatre colonnes de configuration sur `employees` (secteur,
--  perimetre_lieux, contenu_pointage, rythme). Elles remplacent
--  progressivement les branchements sur `employee_type` dans le code métier.
--  `employee_type` N'EST PAS supprimé : il reste l'étiquette grossière
--  historique, encore lue par l'audit global et les filtres de listes.
--
--  Ajoute une colonne `status` sur `mobile_locations` pour distinguer les
--  lieux créés normalement par un responsable (actifs immédiatement) des
--  lieux ajoutés à la volée par un agent terrain (provisoires, en attente
--  de validation). `zones` (sièges) n'a pas besoin de cette colonne : elle
--  n'est jamais alimentée par un agent terrain.
-- ============================================================================


-- ============================================================================
-- ÉTAPE 1 — EMPLOYEES : AJOUT DES QUATRE COLONNES (NULLABLES POUR L'INSTANT)
-- ============================================================================

ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS secteur TEXT;
ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS perimetre_lieux TEXT;
ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS contenu_pointage TEXT;
ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS rythme TEXT;


-- ============================================================================
-- ÉTAPE 2 — BACKFILL : DÉRIVATION DEPUIS employee_type
-- ----------------------------------------------------------------------------
--  Mapping retenu :
--    OFFICE   -> secteur GENERAL   / perimetre UN_LIEU          / contenu MINIMAL / rythme STANDARD
--    MOBILE   -> secteur SANTE     / perimetre CATALOGUE_OUVERT / contenu COMPLET / rythme STANDARD
--    FIXED    -> secteur SECURITE  / perimetre SITES_ASSIGNES   / contenu MINIMAL / rythme GARDE
--    SECURITY -> secteur SECURITE  / perimetre SITES_ASSIGNES   / contenu MINIMAL / rythme GARDE
--    (SECURITY est partout identique à FIXED dans le code actuel — même mapping)
--    NULL ou valeur inattendue -> même mapping que OFFICE (le plus restrictif,
--    donc le plus sûr par défaut)
-- ============================================================================

UPDATE public.employees
SET
  secteur = CASE
    WHEN employee_type = 'MOBILE' THEN 'SANTE'
    WHEN employee_type IN ('FIXED', 'SECURITY') THEN 'SECURITE'
    ELSE 'GENERAL'
  END,
  perimetre_lieux = CASE
    WHEN employee_type = 'MOBILE' THEN 'CATALOGUE_OUVERT'
    WHEN employee_type IN ('FIXED', 'SECURITY') THEN 'SITES_ASSIGNES'
    ELSE 'UN_LIEU'
  END,
  contenu_pointage = CASE
    WHEN employee_type = 'MOBILE' THEN 'COMPLET'
    ELSE 'MINIMAL'
  END,
  rythme = CASE
    WHEN employee_type IN ('FIXED', 'SECURITY') THEN 'GARDE'
    ELSE 'STANDARD'
  END
WHERE secteur IS NULL
   OR perimetre_lieux IS NULL
   OR contenu_pointage IS NULL
   OR rythme IS NULL;


-- ============================================================================
-- ÉTAPE 3 — VERROUILLAGE : NOT NULL + VALEURS PAR DÉFAUT POUR LES FUTURES LIGNES
-- ----------------------------------------------------------------------------
--  Le défaut correspond au mapping OFFICE : c'est le cas le plus restrictif
--  (un seul lieu, pointage minimal, rythme standard), donc le plus sûr si un
--  futur point d'insertion oublie de préciser les quatre colonnes.
-- ============================================================================

ALTER TABLE public.employees ALTER COLUMN secteur SET NOT NULL;
ALTER TABLE public.employees ALTER COLUMN perimetre_lieux SET NOT NULL;
ALTER TABLE public.employees ALTER COLUMN contenu_pointage SET NOT NULL;
ALTER TABLE public.employees ALTER COLUMN rythme SET NOT NULL;

ALTER TABLE public.employees ALTER COLUMN secteur SET DEFAULT 'GENERAL';
ALTER TABLE public.employees ALTER COLUMN perimetre_lieux SET DEFAULT 'UN_LIEU';
ALTER TABLE public.employees ALTER COLUMN contenu_pointage SET DEFAULT 'MINIMAL';
ALTER TABLE public.employees ALTER COLUMN rythme SET DEFAULT 'STANDARD';


-- ============================================================================
-- ÉTAPE 4 — CONTRAINTES DE VOCABULAIRE
-- ----------------------------------------------------------------------------
--  `secteur` reste volontairement libre (vocabulaire/étiquettes, sujet à des
--  phases futures) : pas de CHECK dessus. Les trois autres axes pilotent déjà
--  du comportement métier dès cette phase : un vocabulaire fermé évite qu'une
--  valeur mal orthographiée retombe silencieusement dans une branche par
--  défaut côté code.
-- ============================================================================

ALTER TABLE public.employees
  ADD CONSTRAINT employees_perimetre_lieux_check
  CHECK (perimetre_lieux IN ('UN_LIEU', 'SITES_ASSIGNES', 'CATALOGUE_OUVERT'));

ALTER TABLE public.employees
  ADD CONSTRAINT employees_contenu_pointage_check
  CHECK (contenu_pointage IN ('MINIMAL', 'COMPLET'));

ALTER TABLE public.employees
  ADD CONSTRAINT employees_rythme_check
  CHECK (rythme IN ('STANDARD', 'GARDE'));


-- ============================================================================
-- ÉTAPE 5 — MOBILE_LOCATIONS : STATUT DE VALIDATION
-- ----------------------------------------------------------------------------
--  Précédent de nommage : employee_schedules.status (valeur 'PENDING' déjà
--  utilisée par routes/mobile.js:531, "Statut par défaut : En attente (Gris)").
--  ACTIVE   : lieu créé normalement par un responsable (admin.js / ops.js),
--             ou lieu qui existait déjà avant cette migration.
--  PENDING  : lieu ajouté à la volée par un agent terrain (perimetre_lieux
--             CATALOGUE_OUVERT), en attente de validation par un responsable.
--             Reste utilisable pour le pointage (is_active ne change pas).
--  REJECTED : lieu provisoire rejeté par un responsable (is_active repasse
--             à false à ce moment-là, cf. routes/mobile.js).
-- ============================================================================

ALTER TABLE public.mobile_locations ADD COLUMN IF NOT EXISTS status TEXT;

UPDATE public.mobile_locations
SET status = 'ACTIVE'
WHERE status IS NULL;

ALTER TABLE public.mobile_locations ALTER COLUMN status SET NOT NULL;
ALTER TABLE public.mobile_locations ALTER COLUMN status SET DEFAULT 'ACTIVE';

ALTER TABLE public.mobile_locations
  ADD CONSTRAINT mobile_locations_status_check
  CHECK (status IN ('ACTIVE', 'PENDING', 'REJECTED'));


-- ============================================================================
-- ÉTAPE 6 — VÉRIFICATION APRÈS APPLICATION (à lancer manuellement)
-- ----------------------------------------------------------------------------
--  Les deux requêtes doivent renvoyer 0 ligne.
-- ============================================================================

SELECT id, nom, employee_type, secteur, perimetre_lieux, contenu_pointage, rythme
  FROM public.employees
 WHERE secteur IS NULL OR perimetre_lieux IS NULL OR contenu_pointage IS NULL OR rythme IS NULL
    OR perimetre_lieux NOT IN ('UN_LIEU', 'SITES_ASSIGNES', 'CATALOGUE_OUVERT')
    OR contenu_pointage NOT IN ('MINIMAL', 'COMPLET')
    OR rythme NOT IN ('STANDARD', 'GARDE');

SELECT id, name, status
  FROM public.mobile_locations
 WHERE status IS NULL OR status NOT IN ('ACTIVE', 'PENDING', 'REJECTED');
