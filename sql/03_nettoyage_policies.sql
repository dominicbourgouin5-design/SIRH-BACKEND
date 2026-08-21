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
--  SIRH — SUPPRESSION DES POLICIES VESTIGIALES
-- ----------------------------------------------------------------------------
--  Constat du 21/08/2026, après exécution du script 01.
--
--  Six policies subsistent sur paie, employees et pointages. Elles visent le
--  rôle "public", donc la clé anon publiée dans le frontend. Aucune n'est
--  exploitable aujourd'hui, mais deux d'entre elles sont dangereuses par
--  construction.
--
--  --- Les vestiges (inoffensifs mais trompeurs) ---
--
--  Quatre policies reposent sur auth.uid() et auth.jwt() : l'authentification
--  native de Supabase. Or l'application ne s'en sert pas — elle a son propre
--  JWT signé par le backend et sa table app_users. auth.uid() vaut donc
--  toujours NULL, et ces policies ne s'évaluent jamais à vrai. Elles donnent
--  l'illusion d'une protection qui n'a jamais fonctionné.
--
--  --- Les deux mines ---
--
--    paie      : employee_id IN (SELECT employees.id FROM employees)
--    pointages : employee_id IN (SELECT employees.id FROM employees)
--
--  Ces deux-là ne comportent AUCUNE condition d'authentification. Elles
--  signifient « tu vois cette ligne si tu vois l'employé correspondant ».
--  Elles ne sont sûres que parce que employees est verrouillée par ailleurs.
--  Le jour où une policy de lecture large est ajoutée sur employees, les
--  bulletins de paie et l'historique de pointage suivent automatiquement.
--
--  --- La cible ---
--
--  Le backend utilise une clé sb_secret_ (équivalent service_role) qui
--  contourne le RLS : il n'a besoin d'aucune policy pour fonctionner. Le seul
--  accès direct du navigateur est le canal temps réel du chat, sur la table
--  messages, qui n'est pas concernée ici.
--
--  La configuration correcte est donc : RLS actif, zéro policy. Tout ce qui
--  n'est pas explicitement autorisé est refusé.
-- ============================================================================


-- ============================================================================
-- ÉTAPE 1 — SUPPRESSION
-- ============================================================================

DROP POLICY IF EXISTS "Accès paie restreint"                   ON public.paie;
DROP POLICY IF EXISTS "Accès restreint à la paie"              ON public.paie;
DROP POLICY IF EXISTS "Les RH voient tout"                     ON public.employees;
DROP POLICY IF EXISTS "Les employés voient leur propre profil" ON public.employees;
DROP POLICY IF EXISTS "Accès pointages"                        ON public.pointages;
DROP POLICY IF EXISTS "Accès restreint aux pointages"          ON public.pointages;


-- ============================================================================
-- ÉTAPE 2 — VÉRIFICATION
-- ============================================================================
-- Doit renvoyer 0 ligne. Toute ligne restante est une policy encore ouverte
-- à la clé publique.

SELECT tablename, policyname, cmd, roles
  FROM pg_policies
 WHERE schemaname = 'public'
   AND 'public' = ANY (roles);


-- ============================================================================
-- ÉTAPE 3 — CONTRÔLE FINAL DU VERROUILLAGE
-- ============================================================================
-- Chaque table doit afficher rls_active = true.
-- Une table à false serait intégralement lisible avec la clé publique.

SELECT c.relname                AS table_name,
       c.relrowsecurity         AS rls_active,
       COALESCE(p.nb, 0)        AS nb_policies
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
 ORDER BY c.relrowsecurity ASC, c.relname;
