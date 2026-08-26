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

-- Ce script dépend en plus de `paie` et de `role_permissions`, qui ne font
-- pas partie du garde-fou standard.
DO $$
BEGIN
  IF to_regclass('public.paie') IS NULL THEN
    RAISE EXCEPTION 'Table paie introuvable : ce script en depend. Aucune modification appliquee.';
  END IF;
  IF to_regclass('public.role_permissions') IS NULL THEN
    RAISE EXCEPTION 'Table role_permissions introuvable : ce script en depend. Aucune modification appliquee.';
  END IF;
END $$;


-- ============================================================================
--  SIRH — CYCLE DE RÈGLEMENT DE LA PAIE
-- ----------------------------------------------------------------------------
--  L'application ne verse pas l'argent : elle CONSTATE le versement.
--
--    1. La paie calcule les nets                -> table `paie` (existante)
--    2. Le comptable ouvre un LOT               -> `reglements`
--       Chaque salarie devient une LIGNE        -> `reglement_lignes`
--       chacune portant une REFERENCE UNIQUE.
--    3. L'export applique le GABARIT            -> `payment_templates`
--       que le comptable a defini lui-meme : les colonnes changent d'une
--       entreprise a l'autre, et d'un mode de paiement a l'autre.
--    4. Le paiement se fait DEHORS. Le fichier de retour est reimporte et
--       rapproche SUR LA REFERENCE (jamais sur le matricule ni le numero,
--       qui sont ambigus ou modifiables).
--    5. Le salarie ACCUSE RECEPTION par signature -> signature_url.
--
--  Le MODE DE PAIEMENT vit sur l'EMPLOYE, pas sur le lot : un meme mois
--  melange des salaries payes par mobile money et d'autres par virement.
-- ============================================================================


-- ============================================================================
--  1. COORDONNÉES DE PAIEMENT SUR employees
-- ----------------------------------------------------------------------------
--  Ces champs sont affiches CONDITIONNELLEMENT dans le formulaire dossier,
--  selon mode_paiement_defaut. Un employe paye en especes n'a ni IBAN ni MoMo.
--
--  momo_operateur EST STOCKE EXPLICITEMENT : la portabilite des numeros
--  existe au Benin, l'operateur NE PEUT PAS etre deduit du prefixe de facon
--  fiable. Le prefixe ne sert qu'a PRE-SUGGERER a la saisie, jamais a decider.
--
--  Defaut ESPECES volontaire : aucune coordonnee n'existe aujourd'hui en
--  base, pretendre "virement" produirait des fichiers d'export troues. Le
--  comptable renseigne ensuite en masse via le schema pre-rempli.
-- ============================================================================

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS mode_paiement_defaut text NOT NULL DEFAULT 'ESPECES',

  -- Virement bancaire (IBAN Benin : BJ + 2 cles + banque 5 + guichet 5
  -- + compte 12 + cle RIB 2 = 28 caracteres)
  ADD COLUMN IF NOT EXISTS banque_nom      text,
  ADD COLUMN IF NOT EXISTS banque_code     text,
  ADD COLUMN IF NOT EXISTS banque_guichet  text,
  ADD COLUMN IF NOT EXISTS iban            text,
  ADD COLUMN IF NOT EXISTS bic             text,

  -- Mobile money (numero benin : 10 chiffres, prefixe 01, depuis le 30/11/2024)
  ADD COLUMN IF NOT EXISTS momo_numero     text,
  ADD COLUMN IF NOT EXISTS momo_operateur  text,

  -- Commun. Le titulaire du compte peut differer de l'employe (compte du
  -- conjoint, mandataire) : c'est frequent, et c'est ce que la banque ou
  -- l'operateur controle a la reception.
  ADD COLUMN IF NOT EXISTS titulaire_compte       text,
  ADD COLUMN IF NOT EXISTS coord_paiement_maj_at  timestamptz,
  ADD COLUMN IF NOT EXISTS coord_paiement_maj_par uuid;

-- Contraintes posees separement : ADD CONSTRAINT ne supporte pas IF NOT
-- EXISTS, on teste donc la presence avant.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_mode_paiement_check') THEN
    ALTER TABLE public.employees
      ADD CONSTRAINT employees_mode_paiement_check
      CHECK (mode_paiement_defaut IN ('VIREMENT','MOBILE_MONEY','ESPECES','CHEQUE'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_momo_operateur_check') THEN
    ALTER TABLE public.employees
      ADD CONSTRAINT employees_momo_operateur_check
      CHECK (momo_operateur IS NULL OR momo_operateur IN ('MTN','MOOV','CELTIIS'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_coord_maj_par_fkey') THEN
    ALTER TABLE public.employees
      ADD CONSTRAINT employees_coord_maj_par_fkey
      FOREIGN KEY (coord_paiement_maj_par) REFERENCES public.employees(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON COLUMN public.employees.momo_operateur IS
  'Saisi explicitement. La portabilite des numeros interdit de le deduire du prefixe.';
COMMENT ON COLUMN public.employees.titulaire_compte IS
  'Nom du titulaire reel du compte, qui peut differer du nom de l employe.';


-- ============================================================================
--  2. GABARITS DE COLONNES — LE FORMAT EST UNE DONNÉE, PAS DU CODE
-- ----------------------------------------------------------------------------
--  « chacun a sa plateforme en fait, il faut une partie ou le comptable
--    definit au depart avant l'import car c'est d'une entreprise a une autre »
--
--  export_config / import_config sont en JSONB volontairement :
--    - la config est toujours lue et ecrite EN ENTIER, jamais requetee au
--      champ pres ;
--    - l'ordre des colonnes d'export est un tableau ordonne ;
--    - import_config n'est pas colonnaire (pointeurs de colonnes + listes
--      de valeurs).
--
--  CONTREPARTIE ASSUMEE : aucune integrite cote base. Elle est portee par
--  validateTemplateConfig() dans settlementFormat.js, fonction pure testee,
--  appelee a chaque ecriture. NE JAMAIS ecrire dans cette table sans passer
--  par /save-payment-template.
--
--  Forme attendue de export_config :
--    { "format": "CSV"|"XLSX", "delimiteur": ";", "encodage": "UTF8_BOM",
--      "nom_fichier": "MTN_{mois}_{annee}",
--      "colonnes": [ { "entete": "MSISDN", "source": "momo_numero",
--                      "format": "MSISDN_229", "obligatoire": true },
--                    { "entete": "MOTIF", "source": "reference" } ] }
--
--  Forme attendue de import_config (entetes MINUSCULES ET TRIMES : le
--  frontend applique transformHeader: h => h.trim().toLowerCase()) :
--    { "colonne_reference": "motif", "colonne_statut": "statut",
--      "colonne_transaction": "transaction id", "colonne_date": "date",
--      "colonne_montant": "montant",
--      "valeurs_succes": ["successful","success","00"],
--      "valeurs_echec": ["failed","rejected"],
--      "controle_montant": true }
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.payment_templates (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code          text NOT NULL UNIQUE,
  libelle       text NOT NULL,
  mode_paiement text NOT NULL
                  CHECK (mode_paiement IN ('VIREMENT','MOBILE_MONEY','ESPECES','CHEQUE')),
  operateur     text CHECK (operateur IS NULL OR operateur IN ('MTN','MOOV','CELTIIS')),
  devise        text NOT NULL DEFAULT 'XOF',
  actif         boolean NOT NULL DEFAULT true,
  export_config jsonb NOT NULL DEFAULT '{}'::jsonb
                  CHECK (jsonb_typeof(export_config) = 'object'),
  import_config jsonb NOT NULL DEFAULT '{}'::jsonb
                  CHECK (jsonb_typeof(import_config) = 'object'),
  cree_par      uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_templates_actif
  ON public.payment_templates (mode_paiement) WHERE actif = true;

ALTER TABLE public.payment_templates ENABLE ROW LEVEL SECURITY;


-- ============================================================================
--  3. SÉQUENCES DE RÉFÉRENCES
-- ----------------------------------------------------------------------------
--  La reference est generee PAR LA BASE, via un DEFAULT adosse a une
--  sequence : c'est le seul mecanisme sans collision si deux comptables
--  ouvrent un lot au meme instant. Le backend insere SANS reference, puis
--  relit les lignes avec .select() pour recuperer les valeurs produites.
--
--  Format : SIRH-AAAAMM-NNNNNN  (18 caracteres ASCII, sans espace ni accent)
--  Choisi pour tenir dans le champ « motif de paiement » de MTN Paiement
--  Multiple et dans un libelle de virement bancaire.
--
--  A VERIFIER AVANT MISE EN PRODUCTION : la longueur maximale reellement
--  acceptee par l'operateur. Si le motif est tronque a moins de 18
--  caracteres, le rapprochement casse et il faut raccourcir ce format.
-- ============================================================================

CREATE SEQUENCE IF NOT EXISTS public.reglement_reference_seq;

CREATE OR REPLACE FUNCTION public.generer_reference_reglement()
RETURNS text
LANGUAGE sql
VOLATILE
AS $$
  SELECT 'SIRH-' || to_char(now(), 'YYYYMM') || '-'
      || lpad(nextval('public.reglement_reference_seq')::text, 6, '0');
$$;

CREATE SEQUENCE IF NOT EXISTS public.recu_paiement_seq;

CREATE OR REPLACE FUNCTION public.generer_numero_recu()
RETURNS text
LANGUAGE sql
VOLATILE
AS $$
  SELECT 'REC-' || to_char(now(), 'YYYY') || '-'
      || lpad(nextval('public.recu_paiement_seq')::text, 6, '0');
$$;


-- ============================================================================
--  4. LOTS DE RÈGLEMENT
-- ----------------------------------------------------------------------------
--  UN LOT PAR PERIODE, TOUS MODES CONFONDUS. Le lot ne porte pas de mode :
--  c'est chaque LIGNE qui porte le sien, herite du dossier de l'employe.
--  Un lot d'aout contient donc les salaries MoMo et les salaries virement
--  ensemble, ce qui garde un total mensuel unique.
--
--  statut :
--    BROUILLON : lot ouvert, lignes modifiables, rien n'est sorti.
--    EXPORTE   : au moins un fichier a ete telecharge.
--    PARTIEL   : une partie des lignes est PAYE ou ECHOUE.
--    SOLDE     : plus aucune ligne A_PAYER ni EXPORTE.
--    ANNULE    : lot abandonne.
--  On ne supprime jamais un lot : c'est une piece comptable.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.reglements (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  libelle           text NOT NULL,
  mois              text NOT NULL,       -- meme convention que paie.mois : "Aout"
  annee             integer NOT NULL,
  statut            text NOT NULL DEFAULT 'BROUILLON'
                      CHECK (statut IN ('BROUILLON','EXPORTE','PARTIEL','SOLDE','ANNULE')),
  devise            text NOT NULL DEFAULT 'XOF',
  nb_lignes         integer NOT NULL DEFAULT 0,
  total_montant     bigint  NOT NULL DEFAULT 0,
  piece_justificative_url text,          -- avis de debit, recu operateur, PV de caisse
  notes             text,
  cree_par          uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  exporte_at        timestamptz,
  cloture_at        timestamptz,
  annule_par        uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  annule_at         timestamptz,
  motif_annulation  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reglements_periode
  ON public.reglements (annee, mois);

ALTER TABLE public.reglements ENABLE ROW LEVEL SECURITY;


-- ============================================================================
--  5. LIGNES DE RÈGLEMENT — LA PIÈCE DE PREUVE
-- ----------------------------------------------------------------------------
--  Les colonnes snapshot_* figent la coordonnee AU MOMENT DE L'EXPORT.
--  L'IBAN d'un employe peut changer le mois suivant ; la preuve doit montrer
--  ce qui a REELLEMENT servi, pas ce qui est dans la fiche aujourd'hui.
--  Ne JAMAIS afficher employees.iban dans un ecran de preuve : afficher
--  snapshot_iban.
--
--  statut :
--    A_PAYER  : ligne creee, pas encore sortie.
--    EXPORTE  : figuree dans un fichier telecharge. Snapshot fige.
--    PAYE     : constatee payee (fichier de retour, ou constat manuel).
--    ECHOUE   : le retour indique un echec. Rejouable dans un nouveau lot.
--    ANNULE   : retiree du lot.
--
--  Le type de paie_id est detecte dynamiquement : selon les bases, `paie.id`
--  peut etre un bigint identity ou un uuid. Poser un type en dur ferait
--  echouer la contrainte de cle etrangere (erreur deja rencontree avec
--  employees.id, qui est un uuid).
-- ============================================================================

DO $$
DECLARE type_paie_id text;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod)
    INTO type_paie_id
    FROM pg_attribute a
   WHERE a.attrelid = 'public.paie'::regclass
     AND a.attname  = 'id'
     AND a.attnum > 0 AND NOT a.attisdropped;

  IF type_paie_id IS NULL THEN
    RAISE EXCEPTION 'Colonne paie.id introuvable : impossible de creer reglement_lignes.';
  END IF;

  EXECUTE format($f$
    CREATE TABLE IF NOT EXISTS public.reglement_lignes (
      id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      reglement_id      bigint NOT NULL REFERENCES public.reglements(id) ON DELETE CASCADE,
      paie_id           %s NOT NULL REFERENCES public.paie(id) ON DELETE RESTRICT,
      employee_id       uuid NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,

      reference         text NOT NULL UNIQUE DEFAULT public.generer_reference_reglement(),
      montant           bigint NOT NULL CHECK (montant >= 0),
      devise            text NOT NULL DEFAULT 'XOF',

      mode_paiement     text NOT NULL
                          CHECK (mode_paiement IN ('VIREMENT','MOBILE_MONEY','ESPECES','CHEQUE')),
      template_id       bigint REFERENCES public.payment_templates(id) ON DELETE SET NULL,

      -- --- SNAPSHOT FIGE A L'EXPORT ---
      snapshot_matricule      text,
      snapshot_nom            text,
      snapshot_titulaire      text,
      snapshot_iban           text,
      snapshot_banque_nom     text,
      snapshot_banque_code    text,
      snapshot_bic            text,
      snapshot_momo_numero    text,
      snapshot_momo_operateur text,
      snapshot_at             timestamptz,
      snapshot_brut           jsonb,

      statut            text NOT NULL DEFAULT 'A_PAYER'
                          CHECK (statut IN ('A_PAYER','EXPORTE','PAYE','ECHOUE','ANNULE')),
      exporte_at        timestamptz,

      -- --- CONSTAT DU REGLEMENT ---
      transaction_id_operateur text,
      date_reglement    timestamptz,
      constate_par      uuid REFERENCES public.employees(id) ON DELETE SET NULL,
      constate_mode     text CHECK (constate_mode IS NULL
                          OR constate_mode IN ('IMPORT_RETOUR','CONSTAT_MANUEL')),
      motif_echec       text,
      ligne_retour_brute jsonb,
      piece_justificative_url text,

      -- --- ACCUSE DE RECEPTION PAR LE SALARIE ---
      signature_url     text,
      signature_at      timestamptz,
      signature_ip      text,
      recu_numero       text UNIQUE,
      recu_pdf_url      text,

      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now()
    )$f$, type_paie_id);
END $$;

-- Un bulletin ne peut figurer que dans UN SEUL reglement vivant : c'est le
-- garde-fou contre le double paiement. Une ligne ANNULEE ou ECHOUEE libere
-- le bulletin, qui peut alors etre repris dans un nouveau lot.
CREATE UNIQUE INDEX IF NOT EXISTS ux_reglement_lignes_paie_vivante
  ON public.reglement_lignes (paie_id)
  WHERE statut IN ('A_PAYER','EXPORTE','PAYE');

CREATE INDEX IF NOT EXISTS idx_reglement_lignes_lot
  ON public.reglement_lignes (reglement_id);
CREATE INDEX IF NOT EXISTS idx_reglement_lignes_employe
  ON public.reglement_lignes (employee_id);
CREATE INDEX IF NOT EXISTS idx_reglement_lignes_reference
  ON public.reglement_lignes (reference);
-- Sert au gel des coordonnees : existe-t-il une ligne vivante pour cet employe ?
CREATE INDEX IF NOT EXISTS idx_reglement_lignes_gel
  ON public.reglement_lignes (employee_id)
  WHERE statut IN ('A_PAYER','EXPORTE');
CREATE INDEX IF NOT EXISTS idx_reglement_lignes_a_signer
  ON public.reglement_lignes (employee_id)
  WHERE statut = 'PAYE' AND signature_at IS NULL;

ALTER TABLE public.reglement_lignes ENABLE ROW LEVEL SECURITY;


-- ============================================================================
--  6. JOURNAL DES IMPORTS DE RETOUR
-- ----------------------------------------------------------------------------
--  Chaque fichier de retour importe laisse une trace : qui, quand, quel
--  fichier, combien de lignes rapprochees / ignorees / en echec. C'est la
--  piece qui explique POURQUOI une ligne est passee a PAYE.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.reglement_imports (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reglement_id     bigint NOT NULL REFERENCES public.reglements(id) ON DELETE CASCADE,
  template_id      bigint REFERENCES public.payment_templates(id) ON DELETE SET NULL,
  nom_fichier      text,
  nb_lignes_lues   integer NOT NULL DEFAULT 0,
  nb_rapprochees   integer NOT NULL DEFAULT 0,
  nb_echecs        integer NOT NULL DEFAULT 0,
  nb_non_reconnues integer NOT NULL DEFAULT 0,
  rapport          jsonb,
  importe_par      uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reglement_imports_lot
  ON public.reglement_imports (reglement_id);

ALTER TABLE public.reglement_imports ENABLE ROW LEVEL SECURITY;


-- ============================================================================
--  7. NOUVELLES PERMISSIONS
-- ----------------------------------------------------------------------------
--  Toutes NOMMEES : elles deviennent automatiquement delegables au cas par
--  cas via permission_overrides (middleware applyPermissionOverrides).
--  C'est exactement ce qu'un controle par nom de role en dur — celui de
--  routes/reporting.js — rendait impossible.
-- ============================================================================

ALTER TABLE public.role_permissions
  ADD COLUMN IF NOT EXISTS can_manage_settlements       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_manage_payment_templates BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_cancel_settlements       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_see_payment_details      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_export_payroll           BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_export_attendance        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_send_reports             BOOLEAN NOT NULL DEFAULT false;

UPDATE public.role_permissions SET can_manage_settlements = true
 WHERE role_name IN ('ADMIN','COMPTABLE');
UPDATE public.role_permissions SET can_manage_payment_templates = true
 WHERE role_name IN ('ADMIN','COMPTABLE');
UPDATE public.role_permissions SET can_cancel_settlements = true
 WHERE role_name IN ('ADMIN');
UPDATE public.role_permissions SET can_see_payment_details = true
 WHERE role_name IN ('ADMIN','RH','COMPTABLE');
UPDATE public.role_permissions SET can_export_payroll = true
 WHERE role_name IN ('ADMIN','RH','COMPTABLE');
UPDATE public.role_permissions SET can_export_attendance = true
 WHERE role_name IN ('ADMIN','RH');
UPDATE public.role_permissions SET can_send_reports = true
 WHERE role_name IN ('ADMIN');


-- ============================================================================
--  8. GABARITS PAR DÉFAUT
-- ----------------------------------------------------------------------------
--  Volontairement generiques : ce sont des DONNEES de depart, pas une
--  reference. Le comptable les ajuste dans l'ecran de configuration une fois
--  qu'il a le vrai gabarit de son operateur ou de sa banque.
--
--  Les entetes d'IMPORT sont en MINUSCULES : CSVManager.parseAndValidate
--  applique transformHeader: h => h.trim().toLowerCase().
-- ============================================================================

INSERT INTO public.payment_templates (code, libelle, mode_paiement, operateur, export_config, import_config)
VALUES
(
  'MOMO_GENERIQUE', 'Mobile Money — gabarit générique', 'MOBILE_MONEY', NULL,
  '{
     "format": "CSV",
     "delimiteur": ";",
     "encodage": "UTF8_BOM",
     "nom_fichier": "MOMO_{mois}_{annee}",
     "colonnes": [
       {"entete": "MSISDN",     "source": "momo_numero", "format": "MSISDN_229", "obligatoire": true},
       {"entete": "MONTANT",    "source": "montant",     "format": "ENTIER",     "obligatoire": true},
       {"entete": "MOTIF",      "source": "reference",   "format": "BRUT",       "obligatoire": true},
       {"entete": "BENEFICIAIRE", "source": "titulaire", "format": "MAJUSCULES"},
       {"entete": "MATRICULE",  "source": "matricule",   "format": "BRUT"}
     ]
   }'::jsonb,
  '{
     "colonne_reference": "motif",
     "colonne_statut": "statut",
     "colonne_transaction": "transaction id",
     "colonne_date": "date",
     "colonne_montant": "montant",
     "valeurs_succes": ["successful","success","succes","réussi","reussi","ok","00"],
     "valeurs_echec": ["failed","failure","echec","échec","rejected","rejete","rejeté"],
     "controle_montant": true
   }'::jsonb
),
(
  'VIREMENT_GENERIQUE', 'Virement bancaire — gabarit générique', 'VIREMENT', NULL,
  '{
     "format": "CSV",
     "delimiteur": ";",
     "encodage": "UTF8_BOM",
     "nom_fichier": "VIREMENT_{mois}_{annee}",
     "colonnes": [
       {"entete": "IBAN",        "source": "iban",        "format": "IBAN_COMPACT", "obligatoire": true},
       {"entete": "BENEFICIAIRE","source": "titulaire",   "format": "MAJUSCULES",   "obligatoire": true},
       {"entete": "BANQUE",      "source": "banque_nom",  "format": "BRUT"},
       {"entete": "BIC",         "source": "bic",         "format": "BRUT"},
       {"entete": "MONTANT",     "source": "montant",     "format": "ENTIER",       "obligatoire": true},
       {"entete": "DEVISE",      "source": "constante",   "valeur": "XOF"},
       {"entete": "LIBELLE",     "source": "reference",   "format": "BRUT",         "obligatoire": true}
     ]
   }'::jsonb,
  '{
     "colonne_reference": "libelle",
     "colonne_statut": "statut",
     "colonne_transaction": "reference bancaire",
     "colonne_date": "date execution",
     "colonne_montant": "montant",
     "valeurs_succes": ["execute","exécuté","execute","paid","ok"],
     "valeurs_echec": ["rejete","rejeté","rejected","impaye","impayé"],
     "controle_montant": true
   }'::jsonb
)
ON CONFLICT (code) DO NOTHING;


-- ============================================================================
--  9. VÉRIFICATION APRÈS APPLICATION (à lancer manuellement)
-- ----------------------------------------------------------------------------
--  Les quatre premieres requetes doivent renvoyer des lignes ; la derniere
--  doit renvoyer 0 ligne.
-- ============================================================================

-- Les quatre tables existent ?
SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'public'
   AND table_name IN ('payment_templates','reglements','reglement_lignes','reglement_imports')
 ORDER BY table_name;

-- Les permissions sont bien posees ?
SELECT role_name, can_manage_settlements, can_export_payroll, can_see_payment_details
  FROM public.role_permissions ORDER BY role_name;

-- Les deux gabarits par defaut sont la ?
SELECT code, libelle, mode_paiement, actif FROM public.payment_templates ORDER BY code;

-- La generation de reference fonctionne ? (consomme un numero, c'est normal)
SELECT public.generer_reference_reglement() AS exemple_reference,
       public.generer_numero_recu()         AS exemple_recu;

-- Aucun employe avec un mode de paiement hors vocabulaire ? (doit etre vide)
SELECT id, nom, mode_paiement_defaut FROM public.employees
 WHERE mode_paiement_defaut NOT IN ('VIREMENT','MOBILE_MONEY','ESPECES','CHEQUE');
