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
--  SIRH — SUPPRESSION DES POLICIES RÉSIDUELLES
-- ----------------------------------------------------------------------------
--  Constat du 21/08/2026, après les scripts 01 et 03.
--
--  État atteint : 34 tables sur 34 en RLS actif, plus aucune policy visant le
--  rôle "public". La fuite sur prescripteurs est fermée, vérifiée de
--  l'extérieur avec la clé anon.
--
--  Restent 13 policies sur 9 tables, qui visent un autre rôle — en pratique
--  "authenticated" :
--
--    employees 3 · paie 2 · messages 2 · app_users 1 · conges 1
--    contract_templates 1 · mobile_locations 1 · products 1 · zones 1
--
--  --- Pourquoi elles posent problème ---
--
--  L'inscription Supabase Auth est OUVERTE sur ce projet :
--
--      GET /auth/v1/settings  ->  disable_signup: false
--
--  N'importe qui peut donc créer un compte avec la clé anon publiée dans
--  js/core/config.js, confirmer sa propre adresse email, et obtenir un jeton
--  portant le rôle "authenticated". Toute policy accordant des droits à ce
--  rôle devient alors exploitable par un inconnu.
--
--  Or l'application n'utilise pas Supabase Auth : elle signe ses propres JWT
--  et gère ses comptes dans app_users. Ces policies n'ont jamais servi à
--  l'application — elles n'ouvrent une porte que pour un attaquant.
--
--  --- Deux mesures, à appliquer toutes les deux ---
--
--    1. Ce script supprime les policies résiduelles.
--    2. Désactiver l'inscription dans le dashboard :
--       Authentication > Sign In / Providers > Email > Allow new users to
--       sign up  ->  désactivé.
--
--  La seconde ferme la porte, la première retire ce qu'il y avait derrière.
--  Aucune des deux ne suffit seule : une policy peut être recréée par
--  inadvertance, et l'inscription peut être réactivée.
--
--  --- Effet sur l'application : aucun ---
--
--  Le backend utilise une clé sb_secret_ qui contourne le RLS. Le seul accès
--  direct du navigateur est le canal temps réel du chat sur la table
--  messages — mais il se connecte avec la clé anon, à qui ces policies
--  n'accordaient déjà rien. Mesuré : messages renvoie 0 ligne à la clé anon.
-- ============================================================================


-- ============================================================================
-- ÉTAPE 0 — INVENTAIRE AVANT SUPPRESSION
-- ============================================================================
-- À lire avant d'exécuter la suite. Conserve le résultat : c'est la seule
-- trace de ce qui existait.

SELECT tablename, policyname, cmd, roles, qual
  FROM pg_policies
 WHERE schemaname = 'public'
 ORDER BY tablename, policyname;


-- ============================================================================
-- ÉTAPE 1 — SUPPRESSION DE TOUTES LES POLICIES RESTANTES
-- ============================================================================
-- Cible : RLS actif partout, aucune policy. Tout ce qui n'est pas
-- explicitement autorisé est refusé, et seule la clé de service passe.

DO $$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname
      FROM pg_policies
     WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I;', p.policyname, p.schemaname, p.tablename);
    RAISE NOTICE 'Policy supprimée : % sur %', p.policyname, p.tablename;
  END LOOP;
END $$;


-- ============================================================================
-- ÉTAPE 2 — CONTRÔLE FINAL
-- ============================================================================
-- Doit renvoyer 34 lignes, toutes en rls_active = true et nb_policies = 0.

SELECT c.relname         AS table_name,
       c.relrowsecurity  AS rls_active,
       COALESCE(p.nb, 0) AS nb_policies
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN (
    SELECT tablename, COUNT(*) AS nb
      FROM pg_policies
     WHERE schemaname = 'public'
     GROUP BY tablename
  ) p ON p.tablename = c.relname
 WHERE n.nspname = 'public'
   AND c.relkind  = 'r'
 ORDER BY c.relrowsecurity ASC, nb_policies DESC, c.relname;
