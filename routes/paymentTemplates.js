const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const { checkPerm } = require("../utils");
const { sanitizeString } = require("../validation");
const {
  validateTemplateConfig,
  validateImportConfig,
  construireLignesExport,
  SOURCES_AUTORISEES,
  FORMATS_AUTORISES,
} = require("../settlementFormat");

// ============================================================
// GABARITS DE COLONNES DE PAIEMENT
// ------------------------------------------------------------
// « chacun a sa plateforme en fait, il faut une partie où le comptable
//   définit au départ avant l'import car c'est d'une entreprise à une autre »
//
// Le format des fichiers d'export et d'import est une DONNÉE éditée par le
// comptable, pas du code. Ces routes sont le CRUD de cette donnée.
//
// La table stocke du JSONB : la base ne peut pas garantir la cohérence de
// la structure. C'est validateTemplateConfig()/validateImportConfig() qui
// s'en charge, systématiquement, AVANT toute écriture — d'où l'interdiction
// d'écrire dans payment_templates autrement que par ces routes.
// ============================================================

// Métadonnées nécessaires à l'écran de configuration : les listes blanches
// de sources et de formats viennent du backend, pour que le frontend n'ait
// pas à les dupliquer et à diverger silencieusement.
router.get("/payment-template-metadata", async (req, res) => {
  if (!checkPerm(req, "can_manage_payment_templates") && !checkPerm(req, "can_manage_settlements")) {
    return res.status(403).json({ error: "Accès refusé à la configuration des paiements." });
  }

  return res.json({
    sources: SOURCES_AUTORISEES,
    formats: FORMATS_AUTORISES,
    modes: ["VIREMENT", "MOBILE_MONEY", "ESPECES", "CHEQUE"],
    operateurs: ["MTN", "MOOV", "CELTIIS"],
  });
});

router.get("/list-payment-templates", async (req, res) => {
  // Le comptable qui monte un lot doit pouvoir lire la liste même s'il n'a
  // pas le droit de la modifier.
  if (!checkPerm(req, "can_manage_payment_templates") && !checkPerm(req, "can_manage_settlements")) {
    return res.status(403).json({ error: "Accès refusé à la configuration des paiements." });
  }

  const inclureInactifs = req.query.inclure_inactifs === "true";
  let query = supabase.from("payment_templates").select("*").order("libelle", { ascending: true });
  if (!inclureInactifs) query = query.eq("actif", true);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

router.post("/save-payment-template", async (req, res) => {
  if (!checkPerm(req, "can_manage_payment_templates")) {
    return res.status(403).json({ error: "Accès refusé à la configuration des paiements." });
  }

  const { id, code, libelle, mode_paiement, operateur, devise, actif } = req.body;
  const export_config = req.body.export_config || {};
  const import_config = req.body.import_config || {};

  if (!code || !libelle || !mode_paiement) {
    return res.status(400).json({ error: "Code, libellé et mode de paiement sont obligatoires." });
  }
  if (!["VIREMENT", "MOBILE_MONEY", "ESPECES", "CHEQUE"].includes(mode_paiement)) {
    return res.status(400).json({ error: "Mode de paiement invalide." });
  }
  if (operateur && !["MTN", "MOOV", "CELTIIS"].includes(operateur)) {
    return res.status(400).json({ error: "Opérateur invalide." });
  }

  // Validation métier AVANT écriture : un gabarit incohérent produirait un
  // fichier que la banque ou l'opérateur rejetterait, sans qu'on sache
  // pourquoi. Les messages remontent tels quels à l'écran de configuration.
  const verifExport = validateTemplateConfig(export_config);
  const verifImport = validateImportConfig(import_config);
  const erreurs = [...verifExport.erreurs, ...verifImport.erreurs];
  if (erreurs.length > 0) {
    return res.status(400).json({ error: "Gabarit invalide.", details: erreurs });
  }

  const payload = {
    code: sanitizeString(code).toUpperCase().replace(/\s+/g, "_"),
    libelle: sanitizeString(libelle),
    mode_paiement,
    operateur: operateur || null,
    devise: devise || "XOF",
    actif: actif === undefined ? true : !!actif,
    export_config,
    import_config,
    updated_at: new Date().toISOString(),
  };

  try {
    let data, error;

    if (id) {
      ({ data, error } = await supabase
        .from("payment_templates")
        .update(payload)
        .eq("id", id)
        .select());
    } else {
      payload.cree_par = req.user.emp_id;
      ({ data, error } = await supabase.from("payment_templates").insert([payload]).select());
    }

    if (error) {
      // Le code est UNIQUE : un doublon doit donner un message clair, pas
      // une erreur Postgres brute.
      if (error.code === "23505") {
        return res.status(400).json({ error: "Un gabarit portant ce code existe déjà." });
      }
      throw error;
    }

    await supabase.from("logs").insert([{
      agent: `Employé #${req.user.emp_id}`,
      action: id ? "MODIFICATION GABARIT PAIEMENT" : "CREATION GABARIT PAIEMENT",
      details: `Gabarit « ${payload.libelle} » (${payload.mode_paiement}).`,
    }]);

    return res.json({ status: "success", data: data[0] });
  } catch (err) {
    console.error("Erreur save-payment-template:", err.message);
    return res.status(500).json({ error: "Impossible d'enregistrer le gabarit." });
  }
});

router.post("/delete-payment-template", async (req, res) => {
  if (!checkPerm(req, "can_manage_payment_templates")) {
    return res.status(403).json({ error: "Accès refusé à la configuration des paiements." });
  }

  const { id } = req.body;
  if (!id) return res.status(400).json({ error: "Identifiant manquant." });

  // Désactivation, jamais suppression : le gabarit est référencé par des
  // lignes de règlement historiques, qui doivent rester lisibles.
  const { data, error } = await supabase
    .from("payment_templates")
    .update({ actif: false, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select();

  if (error) return res.status(500).json({ error: error.message });
  if (!data || data.length === 0) return res.status(404).json({ error: "Gabarit introuvable." });

  await supabase.from("logs").insert([{
    agent: `Employé #${req.user.emp_id}`,
    action: "DESACTIVATION GABARIT PAIEMENT",
    details: `Gabarit « ${data[0].libelle} » désactivé.`,
  }]);

  return res.json({ status: "success" });
});

// Aperçu à blanc : applique le gabarit à trois lignes fictives et renvoie le
// tableau tel qu'il sortirait. C'est ce qui rend l'écran utilisable par un
// comptable non technique — il voit le fichier avant de l'envoyer à sa
// banque, plutôt que de le découvrir après un rejet.
router.post("/preview-payment-template", async (req, res) => {
  if (!checkPerm(req, "can_manage_payment_templates")) {
    return res.status(403).json({ error: "Accès refusé à la configuration des paiements." });
  }

  const export_config = req.body.export_config || {};
  const verif = validateTemplateConfig(export_config);
  if (!verif.ok) {
    return res.status(400).json({ error: "Gabarit invalide.", details: verif.erreurs });
  }

  const exemples = [
    {
      reference: "SIRH-202608-000001",
      montant: 125000,
      devise: "XOF",
      mode_paiement: req.body.mode_paiement || "MOBILE_MONEY",
      matricule: "EMP-001",
      nom: "DOSSOU Awa",
      titulaire: "DOSSOU Awa",
      momo_numero: "0197123456",
      momo_operateur: "MTN",
      iban: "BJ66BJ0610100100144390000769",
      banque_nom: "Banque Atlantique",
      banque_code: "BJ061",
      banque_guichet: "01001",
      bic: "ATBJBJBJ",
    },
    {
      reference: "SIRH-202608-000002",
      montant: 87500,
      devise: "XOF",
      mode_paiement: req.body.mode_paiement || "MOBILE_MONEY",
      matricule: "EMP-002",
      nom: "AGBODJAN Koffi",
      titulaire: "AGBODJAN Koffi",
      momo_numero: "0155987654",
      momo_operateur: "MOOV",
      iban: "BJ66BJ0610100100144390000770",
      banque_nom: "Bank of Africa",
      banque_code: "BJ062",
      banque_guichet: "01002",
      bic: "AFRIBJBJ",
    },
    {
      // Troisième ligne volontairement incomplète : elle montre au comptable
      // ce qui se passe quand une coordonnée manque — la ligne est écartée
      // du fichier et signalée, plutôt que d'y figurer avec une case vide.
      reference: "SIRH-202608-000003",
      montant: 64000,
      devise: "XOF",
      mode_paiement: req.body.mode_paiement || "MOBILE_MONEY",
      matricule: "EMP-003",
      nom: "HOUNKPE Marie",
      titulaire: "HOUNKPE Marie",
      momo_numero: null,
      momo_operateur: null,
      iban: null,
      banque_nom: null,
    },
  ];

  const contexte = { mois: "Août", annee: 2026, libelle_lot: "Règlement Août 2026" };
  const rendu = construireLignesExport(exemples, export_config, contexte);

  return res.json({
    entetes: rendu.entetes,
    lignes: rendu.lignes,
    erreurs: rendu.erreurs,
    note: rendu.erreurs.length > 0
      ? "Les lignes signalées seraient écartées du fichier : une colonne obligatoire est vide."
      : null,
  });
});

module.exports = router;
