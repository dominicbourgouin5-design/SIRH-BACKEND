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
--  SIRH — PERMISSION `can_validate_locations`
-- ----------------------------------------------------------------------------
--  Protège /validate-mobile-location et /list-pending-locations
--  (routes/mobile.js, phase 1). Accordée à ADMIN et RH, les mêmes rôles
--  "responsable" que /get-live-positions et /get-global-audit.
-- ============================================================================

ALTER TABLE public.role_permissions
  ADD COLUMN IF NOT EXISTS can_validate_locations BOOLEAN NOT NULL DEFAULT false;

UPDATE public.role_permissions
   SET can_validate_locations = true
 WHERE role_name IN ('ADMIN', 'RH');

-- ============================================================================
--  Vérification manuelle après application
-- ----------------------------------------------------------------------------
--  Doit montrer TRUE pour ADMIN et RH, FALSE (ou vide) pour les autres rôles.
-- ============================================================================

SELECT role_name, can_validate_locations
  FROM public.role_permissions
 ORDER BY role_name;
