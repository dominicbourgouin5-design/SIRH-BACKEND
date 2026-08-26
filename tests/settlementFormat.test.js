const test = require("node:test");
const assert = require("node:assert");

const {
  validateTemplateConfig,
  validateImportConfig,
  appliquerColonne,
  construireLignesExport,
  nommerFichierExport,
  extraireReference,
  rapprocherLigneRetour,
} = require("../settlementFormat");

// ============================================================
// VALIDATION DES GABARITS
// ------------------------------------------------------------
// Le gabarit est du JSONB : la base ne peut rien vérifier. Ces contrôles
// sont la seule intégrité qui existe.
// ============================================================

test("un gabarit correct est accepté", () => {
  const res = validateTemplateConfig({
    format: "CSV",
    colonnes: [
      { entete: "MSISDN", source: "momo_numero", format: "MSISDN_229", obligatoire: true },
      { entete: "MONTANT", source: "montant", format: "ENTIER" },
      { entete: "MOTIF", source: "reference" },
    ],
  });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.erreurs, []);
});

test("une source inconnue est refusée", () => {
  // Sans ce contrôle, une faute de frappe produirait une colonne vide dans
  // le fichier envoyé à la banque.
  const res = validateTemplateConfig({
    colonnes: [{ entete: "IBAN", source: "iban_du_salarie" }],
  });
  assert.strictEqual(res.ok, false);
  assert.match(res.erreurs.join(" "), /inconnue/);
});

test("un format inconnu est refusé", () => {
  const res = validateTemplateConfig({
    colonnes: [{ entete: "MONTANT", source: "montant", format: "EN_LETTRES" }],
  });
  assert.strictEqual(res.ok, false);
  assert.match(res.erreurs.join(" "), /format/);
});

test("une colonne constante sans valeur est refusée", () => {
  const res = validateTemplateConfig({
    colonnes: [{ entete: "DEVISE", source: "constante" }],
  });
  assert.strictEqual(res.ok, false);
  assert.match(res.erreurs.join(" "), /valeur/);
});

test("des en-têtes en double sont refusés", () => {
  const res = validateTemplateConfig({
    colonnes: [
      { entete: "MONTANT", source: "montant" },
      { entete: "montant", source: "salaire_net" },
    ],
  });
  assert.strictEqual(res.ok, false);
  assert.match(res.erreurs.join(" "), /double/);
});

test("un gabarit sans colonne est refusé", () => {
  assert.strictEqual(validateTemplateConfig({ colonnes: [] }).ok, false);
  assert.strictEqual(validateTemplateConfig({}).ok, false);
  assert.strictEqual(validateTemplateConfig(null).ok, false);
});

test("un en-tête vide est refusé", () => {
  const res = validateTemplateConfig({
    colonnes: [{ entete: "   ", source: "montant" }],
  });
  assert.strictEqual(res.ok, false);
});

test("les messages d'erreur sont en français", () => {
  const res = validateTemplateConfig({ colonnes: [{ entete: "X", source: "nimporte_quoi" }] });
  assert.match(res.erreurs[0], /[àâéèêëîïôùûç]|Colonne|inconnue/i);
});

// ============================================================
// VALIDATION DE LA CONFIG D'IMPORT
// ============================================================

test("une config d'import sans colonne de référence est refusée", () => {
  // Sans référence, aucun rapprochement fiable n'est possible.
  const res = validateImportConfig({ colonne_statut: "statut", valeurs_succes: ["ok"] });
  assert.strictEqual(res.ok, false);
  assert.match(res.erreurs.join(" "), /référence/i);
});

test("une colonne de statut sans valeurs de succès est refusée", () => {
  const res = validateImportConfig({ colonne_reference: "motif", colonne_statut: "statut" });
  assert.strictEqual(res.ok, false);
  assert.match(res.erreurs.join(" "), /payé/i);
});

test("le contrôle du montant exige une colonne de montant", () => {
  const res = validateImportConfig({ colonne_reference: "motif", controle_montant: true });
  assert.strictEqual(res.ok, false);
  assert.match(res.erreurs.join(" "), /montant/i);
});

// ============================================================
// APPLICATION DU GABARIT
// ============================================================

const LIGNE = {
  reference: "SIRH-202608-000042",
  montant: 125000,
  matricule: "EMP-001",
  nom: "Dupont Awa",
  titulaire: "Dupont Awa",
  momo_numero: "0197123456",
  iban: "BJ66 BJ06 1010 0100 1443 9000 0769",
  banque_nom: "Banque Atlantique",
};

test("chaque format produit la valeur attendue", () => {
  assert.strictEqual(appliquerColonne(LIGNE, { source: "montant", format: "ENTIER" }), "125000");
  assert.strictEqual(appliquerColonne(LIGNE, { source: "montant", format: "DECIMAL2" }), "125000.00");
  assert.strictEqual(appliquerColonne(LIGNE, { source: "nom", format: "MAJUSCULES" }), "DUPONT AWA");
  assert.strictEqual(appliquerColonne(LIGNE, { source: "momo_numero", format: "MSISDN_229" }), "2290197123456");
  assert.strictEqual(appliquerColonne(LIGNE, { source: "momo_numero", format: "MSISDN_LOCAL" }), "0197123456");
  assert.strictEqual(
    appliquerColonne(LIGNE, { source: "iban", format: "IBAN_COMPACT" }),
    "BJ66BJ0610100100144390000769",
  );
  assert.strictEqual(appliquerColonne(LIGNE, { source: "reference", format: "BRUT" }), "SIRH-202608-000042");
});

test("une colonne constante substitue les variables de contexte", () => {
  const cellule = appliquerColonne(
    LIGNE,
    { source: "constante", valeur: "Salaire {mois} {annee}" },
    { mois: "Août", annee: 2026 },
  );
  assert.strictEqual(cellule, "Salaire Août 2026");
});

test("une donnée absente donne une cellule vide, jamais 'undefined'", () => {
  assert.strictEqual(appliquerColonne(LIGNE, { source: "bic", format: "BRUT" }), "");
  assert.strictEqual(appliquerColonne({}, { source: "montant", format: "ENTIER" }), "");
});

test("l'ordre des colonnes du gabarit est respecté à la lettre", () => {
  const res = construireLignesExport(
    [LIGNE],
    {
      colonnes: [
        { entete: "MOTIF", source: "reference" },
        { entete: "MSISDN", source: "momo_numero", format: "MSISDN_229" },
        { entete: "MONTANT", source: "montant", format: "ENTIER" },
      ],
    },
    {},
  );
  assert.deepStrictEqual(res.entetes, ["MOTIF", "MSISDN", "MONTANT"]);
  assert.deepStrictEqual(res.lignes[0], ["SIRH-202608-000042", "2290197123456", "125000"]);
});

test("une ligne dont une colonne obligatoire est vide est EXCLUE du fichier", () => {
  // Un IBAN manquant doit être vu par le comptable, pas produire une case
  // vide que la banque rejettera — ou pire, acceptera.
  const sansIban = { ...LIGNE, iban: null };
  const res = construireLignesExport(
    [LIGNE, sansIban],
    {
      colonnes: [
        { entete: "IBAN", source: "iban", format: "IBAN_COMPACT", obligatoire: true },
        { entete: "MONTANT", source: "montant", format: "ENTIER" },
      ],
    },
    {},
  );

  assert.strictEqual(res.lignes.length, 1, "la ligne incomplète ne doit pas être exportée");
  assert.strictEqual(res.erreurs.length, 1);
  assert.deepStrictEqual(res.erreurs[0].colonnes_manquantes, ["IBAN"]);
  assert.match(res.erreurs[0].motif, /manquantes/i);
});

test("nommerFichierExport assainit accents, espaces et séparateurs", () => {
  assert.strictEqual(
    nommerFichierExport("Règlement {mois}/{annee}", { mois: "Août", annee: 2026 }),
    "reglement_aout_2026",
  );
  assert.strictEqual(nommerFichierExport("a\\b c", {}), "a_b_c");
});

// ============================================================
// EXTRACTION DE LA RÉFÉRENCE
// ============================================================

test("la référence est retrouvée même noyée dans un libellé", () => {
  // Les opérateurs renvoient rarement la référence nue.
  assert.strictEqual(extraireReference("SIRH-202608-000042"), "SIRH-202608-000042");
  assert.strictEqual(
    extraireReference("Paiement SIRH-202608-000042 salaire aout"),
    "SIRH-202608-000042",
  );
  assert.strictEqual(extraireReference("  sirh-202608-000042  "), "SIRH-202608-000042");
});

test("une cellule sans référence donne null", () => {
  assert.strictEqual(extraireReference("Salaire aout"), null);
  assert.strictEqual(extraireReference(""), null);
  assert.strictEqual(extraireReference(null), null);
});

test("le mode EXACT n'extrait pas d'un libellé plus large", () => {
  assert.strictEqual(
    extraireReference("Paiement SIRH-202608-000042 salaire", "EXACT"),
    null,
  );
  assert.strictEqual(extraireReference("SIRH-202608-000042", "EXACT"), "SIRH-202608-000042");
});

// ============================================================
// RAPPROCHEMENT — LA PARTIE LA PLUS SENSIBLE
// ============================================================

const INDEX = {
  "SIRH-202608-000042": { id: 1, montant: 125000, statut: "EXPORTE" },
  "SIRH-202608-000043": { id: 2, montant: 90000, statut: "EXPORTE" },
  "SIRH-202608-000099": { id: 9, montant: 50000, statut: "PAYE" },
};

const CFG_IMPORT = {
  colonne_reference: "motif",
  colonne_statut: "statut",
  colonne_transaction: "transaction id",
  colonne_date: "date",
  colonne_montant: "montant",
  valeurs_succes: ["successful", "success", "succès", "ok", "00"],
  valeurs_echec: ["failed", "échec", "rejected"],
};

test("un succès est constaté avec son identifiant de transaction", () => {
  const res = rapprocherLigneRetour(
    {
      motif: "SIRH-202608-000042",
      statut: "SUCCESSFUL",
      "transaction id": "MTN-778899",
      date: "2026-08-28",
    },
    CFG_IMPORT,
    INDEX,
  );
  assert.strictEqual(res.statut, "PAYE");
  assert.strictEqual(res.ligne_id, 1);
  assert.strictEqual(res.transaction_id, "MTN-778899");
  assert.match(res.date_reglement, /^2026-08-28/);
});

test("le statut est comparé sans tenir compte de la casse ni des accents", () => {
  for (const valeur of ["successful", "SUCCESSFUL", " Succès ", "succes", "OK"]) {
    const res = rapprocherLigneRetour(
      { motif: "SIRH-202608-000042", statut: valeur },
      CFG_IMPORT,
      INDEX,
    );
    assert.strictEqual(res.statut, "PAYE", `« ${valeur} » aurait dû être un succès`);
  }
});

test("un échec est constaté avec son motif", () => {
  const res = rapprocherLigneRetour(
    { motif: "SIRH-202608-000043", statut: "FAILED" },
    CFG_IMPORT,
    INDEX,
  );
  assert.strictEqual(res.statut, "ECHOUE");
  assert.strictEqual(res.ligne_id, 2);
  assert.match(res.motif_echec, /FAILED/);
});

test("UN STATUT INCONNU NE VAUT JAMAIS PAYÉ", () => {
  // La règle la plus importante du fichier. Constater à tort un paiement qui
  // n'a pas eu lieu laisserait un salarié impayé pendant que le système
  // affirmerait le contraire.
  const res = rapprocherLigneRetour(
    { motif: "SIRH-202608-000042", statut: "PENDING" },
    CFG_IMPORT,
    INDEX,
  );
  assert.strictEqual(res.statut, "NON_RECONNUE");
  assert.match(res.motif, /non reconnu/i);
});

test("une référence absente du lot n'écrit rien", () => {
  const res = rapprocherLigneRetour(
    { motif: "SIRH-202608-999999", statut: "SUCCESSFUL" },
    CFG_IMPORT,
    INDEX,
  );
  assert.strictEqual(res.statut, "NON_RECONNUE");
  assert.strictEqual(res.ligne_id, undefined);
});

test("une ligne sans référence lisible est signalée, pas devinée", () => {
  const res = rapprocherLigneRetour(
    { motif: "Salaire du mois", statut: "SUCCESSFUL" },
    CFG_IMPORT,
    INDEX,
  );
  assert.strictEqual(res.statut, "NON_RECONNUE");
  assert.strictEqual(res.reference, null);
});

test("réimporter le même fichier ne double rien", () => {
  // Idempotence : une ligne déjà payée est reconnue comme telle.
  const res = rapprocherLigneRetour(
    { motif: "SIRH-202608-000099", statut: "SUCCESSFUL" },
    CFG_IMPORT,
    INDEX,
  );
  assert.strictEqual(res.statut, "DEJA_TRAITEE");
  assert.strictEqual(res.ligne_id, 9);
});

test("un montant divergent bloque le constat, même si la plateforme annonce un succès", () => {
  const res = rapprocherLigneRetour(
    { motif: "SIRH-202608-000042", statut: "SUCCESSFUL", montant: "100000" },
    { ...CFG_IMPORT, controle_montant: true },
    INDEX,
  );
  assert.strictEqual(res.statut, "MONTANT_DIVERGENT");
  assert.match(res.motif, /100000/);
  assert.match(res.motif, /125000/);
});

test("un montant identique passe le contrôle", () => {
  const res = rapprocherLigneRetour(
    { motif: "SIRH-202608-000042", statut: "SUCCESSFUL", montant: "125 000" },
    { ...CFG_IMPORT, controle_montant: true },
    INDEX,
  );
  assert.strictEqual(res.statut, "PAYE");
});

test("sans colonne de statut, la présence dans le fichier vaut constat", () => {
  // Cas des retours qui ne listent que les paiements réussis.
  const res = rapprocherLigneRetour(
    { motif: "SIRH-202608-000042" },
    { colonne_reference: "motif" },
    INDEX,
  );
  assert.strictEqual(res.statut, "PAYE");
});

test("les en-têtes du fichier sont retrouvés quelle que soit leur casse", () => {
  const res = rapprocherLigneRetour(
    { MOTIF: "SIRH-202608-000042", Statut: "successful" },
    CFG_IMPORT,
    INDEX,
  );
  assert.strictEqual(res.statut, "PAYE");
});
