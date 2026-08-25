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
--  SIRH — DÉROGATIONS DE PERMISSION PERSONNALISÉES
-- ----------------------------------------------------------------------------
--  Permet d'accorder (ADD) ou de retirer (REMOVE) une permission à un
--  employé précis, en plus de ce que lui donne son rôle, de façon
--  permanente (expires_at NULL) ou temporaire (expires_at renseigné).
--
--  Une seule dérogation ACTIVE par (employé, permission) : accorder une
--  nouvelle dérogation sur la même paire doit d'abord révoquer l'ancienne
--  (fait côté application, pas ici) pour garder un historique complet.
--
--  status :
--    ACTIVE   : en vigueur.
--    EXPIRED  : la date de fin est passée (posé par le job cron, jamais par
--               une suppression — l'historique reste consultable).
--    REVOKED  : retirée manuellement avant son terme.
-- ============================================================================

-- employees.id est un uuid (pas un bigint) : les colonnes qui y font
-- référence doivent avoir le même type, sinon la contrainte de clé
-- étrangère échoue à la création.
CREATE TABLE IF NOT EXISTS public.permission_overrides (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id         uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  permission_name     text NOT NULL,
  mode                text NOT NULL CHECK (mode IN ('ADD','REMOVE')),
  granted_by          uuid REFERENCES public.employees(id),
  granted_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz,
  status              text NOT NULL DEFAULT 'ACTIVE'
                         CHECK (status IN ('ACTIVE','EXPIRED','REVOKED')),
  revoked_by          uuid REFERENCES public.employees(id),
  revoked_at          timestamptz,
  notified_expiry_at  timestamptz,
  reason              text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_permission_overrides_active
  ON public.permission_overrides (employee_id, permission_name)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_permission_overrides_employee
  ON public.permission_overrides (employee_id) WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_permission_overrides_expiring
  ON public.permission_overrides (expires_at) WHERE status = 'ACTIVE' AND expires_at IS NOT NULL;

-- RLS activé sans policy : cohérent avec le reste du projet (le backend
-- passe par la clé de service, aucune policy n'est donc nécessaire — en
-- ajouter une ouvrirait un accès direct depuis le navigateur).
ALTER TABLE public.permission_overrides ENABLE ROW LEVEL SECURITY;


-- ============================================================================
--  NOUVELLE PERMISSION : can_manage_employee_access
-- ----------------------------------------------------------------------------
--  Distincte de can_see_employees : voir la fiche d'un employé ne doit pas
--  suffire à pouvoir modifier ses accès. Accordée par défaut à ADMIN, RH et
--  MANAGER — à ajuster ensuite au cas par cas si besoin.
-- ============================================================================

ALTER TABLE public.role_permissions
  ADD COLUMN IF NOT EXISTS can_manage_employee_access BOOLEAN NOT NULL DEFAULT false;

UPDATE public.role_permissions
   SET can_manage_employee_access = true
 WHERE role_name IN ('ADMIN', 'RH', 'MANAGER');


-- ============================================================================
--  Vérification manuelle après application
-- ============================================================================

SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'public' AND table_name = 'permission_overrides';

SELECT role_name, can_manage_employee_access
  FROM public.role_permissions
 ORDER BY role_name;
