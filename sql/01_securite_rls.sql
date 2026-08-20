-- ============================================================================
--  SIRH — VERROUILLAGE DE LA BASE (RLS)
-- ----------------------------------------------------------------------------
--  Contexte : la clé "anon" Supabase est publiée dans js/core/config.js, donc
--  lisible par n'importe quel visiteur du site. Tout ce qui est accessible à
--  cette clé est public, point. Or l'application ne s'en sert QUE pour le temps
--  réel du chat : toutes les autres données transitent par le backend, qui
--  utilise la clé de service et ignore le RLS.
--
--  Conclusion : on peut verrouiller la totalité des tables sans rien casser.
--
--  À exécuter dans Supabase > SQL Editor. Les étapes 0 et 1 sont à lire avant
--  d'appliquer les étapes 2 et 3.
-- ============================================================================


-- ============================================================================
--  MESURE RÉELLE EFFECTUÉE LE 20/08/2026 SUR LA PRODUCTION
-- ----------------------------------------------------------------------------
--  Sondage des 34 tables via l'API REST avec la clé anon publique (requêtes
--  HEAD + count, aucune donnée personnelle rapatriée). Résultat :
--
--    🔴 prescripteurs    3 lignes lisibles publiquement
--                        colonnes exposées : nom_complet, fonction, telephone
--                        => fuite de données à caractère personnel (RGPD)
--    🟠 company_modules  7 lignes lisibles publiquement
--                        configuration seule, impact faible
--    ✅ les 32 autres    0 ligne renvoyée à la clé anon
--
--  Les tables employees, app_users, logs, conges et pointages occupent
--  pourtant 48 à 96 kB sur disque et employees_pkey totalise 108 parcours
--  d'index : elles contiennent bien des données. Le fait que la clé anon n'en
--  voie aucune prouve que le RLS y est actif et fonctionne.
--
--  Le RLS est donc déjà largement en place. Ce script ferme les deux trous
--  restants et généralise la protection.
--
--  Vérifié également : le backend utilise une clé « sb_secret_ » (équivalent
--  service_role) qui contourne le RLS, et le frontend n'accède directement à
--  Supabase que pour le canal temps réel du chat (chat.js:153). Activer le RLS
--  partout ne casse donc aucun autre appel.
-- ============================================================================


-- ============================================================================
-- ÉTAPE 0 — DIAGNOSTIC : quelles tables sont actuellement sans protection ?
-- ============================================================================
-- Une table avec rowsecurity = false est intégralement lisible et modifiable
-- avec la clé anon publique. C'est la question la plus importante à trancher.

SELECT
  c.relname                                   AS table_name,
  c.relrowsecurity                            AS rls_active,
  COALESCE(p.nb, 0)                           AS nb_policies,
  CASE
    WHEN c.relrowsecurity IS FALSE            THEN '🔴 EXPOSÉE PUBLIQUEMENT'
    WHEN COALESCE(p.nb, 0) = 0                THEN '🟢 Verrouillée (RLS actif, aucune policy)'
    ELSE                                           '🟡 RLS actif — vérifier les policies'
  END                                         AS verdict
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN (
  SELECT tablename, COUNT(*) AS nb
  FROM pg_policies
  WHERE schemaname = 'public'
  GROUP BY tablename
) p ON p.tablename = c.relname
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
ORDER BY c.relrowsecurity ASC, c.relname;


-- ============================================================================
-- ÉTAPE 1 — LES DEUX FUITES CONFIRMÉES
-- ============================================================================
-- Ces policies sont ouvertes au rôle "public", donc à la clé anon publique.
--
--   daily_reports : "Tout le monde peut voir"    SELECT public USING (true)
--                   "Tout le monde peut insérer" INSERT public
--       => n'importe qui peut lire tous les rapports d'activité,
--          et en injecter de faux.
--
--   prescripteurs : "Activer l'insertion/modif pour les admins" ALL public USING (true)
--       => malgré son nom, cette policy ne vérifie rien : n'importe qui peut
--          insérer, modifier et supprimer des prescripteurs.
--
--   company_modules : "Lecture publique pour config" SELECT public USING (true)
--       => expose la liste des modules activés. Impact faible, mais inutile.

DROP POLICY IF EXISTS "Tout le monde peut voir"                        ON public.daily_reports;
DROP POLICY IF EXISTS "Tout le monde peut insérer"                     ON public.daily_reports;
DROP POLICY IF EXISTS "Activer l'insertion/modif pour les admins"      ON public.prescripteurs;
DROP POLICY IF EXISTS "Activer la lecture pour tous les utilisateurs authentifiés" ON public.prescripteurs;
DROP POLICY IF EXISTS "Lecture publique pour config"                   ON public.company_modules;


-- ============================================================================
-- ÉTAPE 2 — ACTIVER LE RLS SUR TOUTES LES TABLES
-- ============================================================================
-- Le backend utilise la clé de service : il n'est pas concerné par le RLS et
-- continuera de fonctionner exactement pareil. Cette étape ne fait que couper
-- l'accès direct par la clé anon publique.

DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t.relname);
    RAISE NOTICE 'RLS activé sur %', t.relname;
  END LOOP;
END $$;


-- ============================================================================
-- ÉTAPE 3 — LE CAS PARTICULIER DU CHAT TEMPS RÉEL
-- ============================================================================
-- Le frontend s'abonne à la table "messages" via supabaseClient.channel(),
-- avec la clé anon. Cette clé a le rôle "anon", PAS "authenticated".
-- Les policies actuelles sur "messages" ciblent {authenticated} : elles ne
-- s'appliquent donc jamais à l'abonnement du navigateur.
--
-- Deux conséquences possibles selon le résultat de l'étape 0 :
--   • si RLS était désactivé sur "messages" : la table était lisible ET
--     modifiable par n'importe qui — et le chat temps réel fonctionnait.
--     En activant le RLS (étape 2), le temps réel va s'arrêter et le chat
--     basculera sur le polling déjà présent (AppState.chatPolling).
--   • si RLS était déjà actif : le temps réel ne fonctionnait déjà pas,
--     et seul le polling faisait le travail.
--
-- Dans les deux cas la bonne cible est la même : faire passer le chat par le
-- backend (/read-messages et /send-message existent déjà) plutôt que de donner
-- un accès direct à la table depuis le navigateur.
-- Aucune policy n'est donc créée ici volontairement.


-- ============================================================================
-- ÉTAPE 4 — VÉRIFICATION APRÈS APPLICATION
-- ============================================================================
-- Doit renvoyer 0 ligne. Toute ligne restante = table encore accessible
-- avec la clé publique.

SELECT tablename, policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public'
  AND 'public' = ANY (roles)
  AND (qual IS NULL OR qual <> 'false');
