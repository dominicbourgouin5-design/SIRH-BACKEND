-- ============================================================================
--  SIRH — SÉPARATION DES CODES 2FA ET RÉINITIALISATION
-- ----------------------------------------------------------------------------
--  Problème
--  --------
--  La colonne app_users.reset_code sert aux DEUX usages :
--
--    • /login          génère un code de double authentification (ADMIN / RH)
--    • /request-password-reset génère un code de réinitialisation
--
--  Or /verify-2fa accepte n'importe quel code présent dans cette colonne et
--  délivre en échange un jeton de session complet. Conséquence : un code
--  demandé via le formulaire « mot de passe oublié » — qui, lui, ne réclame
--  aucun mot de passe — ouvre une session admin s'il est intercepté.
--
--  Correctif
--  ---------
--  On étiquette chaque code avec sa finalité, et chaque flux n'accepte que
--  la sienne.
--
--  Cette migration est SANS RISQUE : la colonne est ajoutée avec une valeur
--  par défaut nulle, et le code backend fonctionne aussi bien avant qu'après
--  son application (il traite l'absence de colonne comme un cas hérité).
--
--  À exécuter dans Supabase > SQL Editor.
-- ============================================================================

ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS reset_purpose text;

COMMENT ON COLUMN public.app_users.reset_purpose IS
  'Finalité du code stocké dans reset_code : MFA (double authentification à la connexion) ou RESET (réinitialisation de mot de passe). NULL = code créé avant la séparation.';

-- Les codes déjà en circulation n'ont pas d'étiquette : on les invalide
-- plutôt que de deviner leur finalité. Les utilisateurs concernés n'auront
-- qu'à relancer leur connexion ou leur demande de réinitialisation.
UPDATE public.app_users
   SET reset_code = NULL,
       reset_expires = NULL
 WHERE reset_code IS NOT NULL;


-- ============================================================================
-- VÉRIFICATION
-- ============================================================================
-- Doit renvoyer une ligne décrivant la colonne reset_purpose.

SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name   = 'app_users'
   AND column_name  = 'reset_purpose';
