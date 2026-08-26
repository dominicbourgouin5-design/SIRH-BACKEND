// ============================================================================
//  settlementFormat.js — le cœur pur du cycle de règlement
// ----------------------------------------------------------------------------
//  AUCUN require volontairement : ce module ne dépend ni de Supabase, ni du
//  réseau, ni d'Express. C'est ce qui le rend testable directement par
//  `node --test`, sans les variables d'environnement factices dont ont besoin
//  les tests de utils.js.
//
//  Il porte trois responsabilités, toutes critiques :
//    1. L'IDENTITÉ DE PAIEMENT : valider et normaliser un numéro mobile
//       béninois ou un IBAN, suggérer un opérateur.
//    2. LE GABARIT : appliquer une configuration de colonnes définie par le
//       comptable pour produire un fichier d'export. Le format est une
//       DONNÉE, jamais une branche `if (mode === 'VIREMENT')`.
//    3. LE RAPPROCHEMENT : relire un fichier de retour et décider, ligne à
//       ligne, si un règlement est constaté.
//
//  Miroir frontend partiel : js/core/payment.js dans le dépôt
//  SIRH-SECURE-V_1-FRONTEND (partie « identité de paiement » uniquement).
//  Toute correction de préfixe ou de règle de validation doit être reportée
//  là-bas — deux dépôts déployés séparément, CJS ici, ESM là-bas.
// ============================================================================


// ============================================================
// MOIS — paie.mois est stocké en TEXTE FRANÇAIS ACCENTUÉ
// ------------------------------------------------------------
// Ne jamais comparer "Aout" === "Août" directement : les deux circulent.
// ============================================================

const MOIS_FR = [
  "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
  "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre",
];

// Retire les accents et met en minuscules, pour comparer des libellés saisis
// à la main ou provenant d'un fichier externe.
function sansAccents(v) {
  if (v === null || v === undefined) return "";
  return String(v)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

// "Août", "aout", "AOUT", "  Août " → 8. Renvoie null si non reconnu.
function moisVersNumero(mois) {
  const cible = sansAccents(mois);
  if (!cible) return null;
  const index = MOIS_FR.findIndex((m) => sansAccents(m) === cible);
  return index === -1 ? null : index + 1;
}


// ============================================================
// OPÉRATEURS MOBILE MONEY — BÉNIN
// ------------------------------------------------------------
// Préfixes attribués par l'ARCEP. Depuis le 30/11/2024, les numéros
// béninois font 10 chiffres et commencent tous par 01.
//
// ⚠️ LA PORTABILITÉ DES NUMÉROS EXISTE AU BÉNIN. Ces préfixes servent
// UNIQUEMENT à pré-suggérer l'opérateur au moment de la saisie. L'opérateur
// réellement utilisé pour un paiement doit TOUJOURS venir du dossier de
// l'employé (employees.momo_operateur), jamais d'une déduction. Un numéro
// porté chez un autre opérateur enverrait le fichier au mauvais endroit.
// ============================================================

const PREFIXES_OPERATEURS = {
  MTN: [
    "0142", "0146", "0150", "0151", "0152", "0153", "0154", "0156", "0157",
    "0159", "0161", "0162", "0166", "0167", "0169", "0190", "0191", "0196",
    "0197",
  ],
  MOOV: [
    "0145", "0155", "0158", "0160", "0163", "0164", "0165", "0168", "0194",
    "0195", "0198", "0199",
  ],
  CELTIIS: [
    "0120", "0121", "0122", "0123", "0124", "0128", "0129", "0140", "0141",
    "0143", "0144", "0147", "0148", "0149", "0192", "0193",
  ],
};

const OPERATEURS = Object.keys(PREFIXES_OPERATEURS);

// Nettoie un numéro béninois vers sa forme canonique locale : 01XXXXXXXX.
// Absorbe les espaces, points, tirets, +229, 00229 et 229.
// Renvoie null si le résultat n'est pas un numéro à 10 chiffres commençant
// par 01 — y compris pour l'ancien format à 8 chiffres, volontairement
// refusé : il n'est plus valide depuis le 30/11/2024 et l'accepter
// silencieusement produirait un fichier de paiement rejeté par l'opérateur.
function normaliserNumeroBenin(valeur) {
  if (valeur === null || valeur === undefined) return null;

  let n = String(valeur).replace(/[\s.\-()]/g, "");
  if (n.startsWith("+")) n = n.slice(1);
  if (n.startsWith("00229")) n = n.slice(5);
  else if (n.startsWith("229")) n = n.slice(3);

  if (!/^\d+$/.test(n)) return null;
  if (n.length !== 10) return null;
  if (!n.startsWith("01")) return null;

  return n;
}

// Vrai si le numéro est exploitable pour un paiement mobile money.
function estNumeroBeninValide(valeur) {
  return normaliserNumeroBenin(valeur) !== null;
}

// Suggestion d'opérateur d'après le préfixe. SUGGESTION, PAS DÉCISION :
// renvoie null si le préfixe est inconnu plutôt qu'un opérateur par défaut,
// pour qu'un préfixe nouvellement attribué ne parte pas chez le mauvais
// opérateur sans que personne ne s'en aperçoive.
function suggestOperateur(valeur) {
  const n = normaliserNumeroBenin(valeur);
  if (!n) return null;
  const prefixe = n.slice(0, 4);
  for (const operateur of OPERATEURS) {
    if (PREFIXES_OPERATEURS[operateur].includes(prefixe)) return operateur;
  }
  return null;
}

// Format international sans le +, attendu par les plateformes de paiement
// de masse : 0197123456 → 2290197123456
//
// ⚠️ LE 0 DE « 01 » NE SE RETIRE PAS. Contrairement à la France ou au
// Royaume-Uni, où le 0 initial est un chiffre d'accès au réseau qu'on
// supprime à l'international, le « 01 » béninois fait partie intégrante du
// numéro depuis le 30/11/2024. Appliquer la convention française produirait
// un numéro à 12 chiffres qui n'aboutit nulle part, et tous les paiements
// mobile money seraient rejetés.
function formaterMsisdn229(valeur) {
  const n = normaliserNumeroBenin(valeur);
  if (!n) return null;
  return "229" + n;
}


// ============================================================
// IBAN — BÉNIN
// ------------------------------------------------------------
// 28 caractères : BJ + 2 clés de contrôle + banque(5) + guichet(5)
// + compte(12) + clé RIB(2).
// ============================================================

function normaliserIban(valeur) {
  if (valeur === null || valeur === undefined) return null;
  const v = String(valeur).replace(/[\s.\-]/g, "").toUpperCase();
  return v || null;
}

// Contrôle mod-97 de la norme ISO 13616 : on déplace les 4 premiers
// caractères à la fin, on convertit les lettres (A=10 … Z=35), le reste de
// la division par 97 doit valoir 1.
function _mod97(ibanCompact) {
  const reorganise = ibanCompact.slice(4) + ibanCompact.slice(0, 4);
  let reste = 0;
  for (const c of reorganise) {
    let valeurChiffre;
    if (c >= "0" && c <= "9") valeurChiffre = c;
    else if (c >= "A" && c <= "Z") valeurChiffre = String(c.charCodeAt(0) - 55);
    else return null; // caractère hors norme
    for (const d of valeurChiffre) {
      reste = (reste * 10 + Number(d)) % 97;
    }
  }
  return reste;
}

// Renvoie { valide, raison, avertissement }.
//
// Choix délibéré : un mod-97 faux donne { valide: true, avertissement: true }
// et non un refus. Des RIB béninois réellement en circulation échouent au
// contrôle, et bloquer la saisie du comptable serait plus coûteux que de
// l'avertir. En revanche une longueur ou un pays incorrects sont refusés
// nettement : ce sont des erreurs de saisie, pas des cas limites.
function estIbanBjValide(valeur) {
  const iban = normaliserIban(valeur);
  if (!iban) return { valide: false, raison: "IBAN vide." };

  if (!/^[A-Z]{2}[0-9A-Z]+$/.test(iban)) {
    return { valide: false, raison: "L'IBAN contient des caractères non autorisés." };
  }
  if (!iban.startsWith("BJ")) {
    return { valide: false, raison: "Un IBAN béninois commence par BJ." };
  }
  if (iban.length !== 28) {
    return {
      valide: false,
      raison: `Un IBAN béninois fait 28 caractères (${iban.length} saisis).`,
    };
  }

  const reste = _mod97(iban);
  if (reste !== 1) {
    return {
      valide: true,
      avertissement: true,
      raison: "La clé de contrôle de l'IBAN semble incorrecte. Vérifiez la saisie.",
    };
  }

  return { valide: true };
}


// ============================================================
// GABARITS D'EXPORT — LE FORMAT EST UNE DONNÉE
// ============================================================

// Données qu'une colonne d'export peut aller chercher sur une ligne de
// règlement. Liste blanche : une source hors de cette liste est refusée à
// l'enregistrement du gabarit, ce qui évite qu'une faute de frappe produise
// silencieusement une colonne vide dans le fichier envoyé à la banque.
const SOURCES_AUTORISEES = [
  "reference", "montant", "devise", "mode_paiement",
  "matricule", "nom", "titulaire",
  "iban", "banque_nom", "banque_code", "banque_guichet", "bic",
  "momo_numero", "momo_operateur",
  "mois", "annee", "libelle_lot",
  "constante",
];

const FORMATS_AUTORISES = [
  "BRUT", "ENTIER", "DECIMAL2", "MAJUSCULES",
  "MSISDN_229", "MSISDN_LOCAL",
  "IBAN_COMPACT", "IBAN_ESPACE",
  "DATE_FR",
];

// Vérifie qu'un gabarit est exploitable. Remplace l'intégrité que la base ne
// peut pas assurer sur du JSONB — appelée à chaque écriture d'un gabarit.
// Renvoie { ok, erreurs: [messages en français] }.
function validateTemplateConfig(config) {
  const erreurs = [];

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { ok: false, erreurs: ["La configuration doit être un objet."] };
  }

  const colonnes = config.colonnes;
  if (!Array.isArray(colonnes) || colonnes.length === 0) {
    erreurs.push("Le gabarit doit comporter au moins une colonne.");
    return { ok: false, erreurs };
  }

  const entetesVus = new Set();

  colonnes.forEach((col, i) => {
    const rang = i + 1;

    if (!col || typeof col !== "object") {
      erreurs.push(`Colonne ${rang} : définition invalide.`);
      return;
    }

    const entete = typeof col.entete === "string" ? col.entete.trim() : "";
    if (!entete) {
      erreurs.push(`Colonne ${rang} : l'en-tête est obligatoire.`);
    } else if (entetesVus.has(entete.toLowerCase())) {
      erreurs.push(`Colonne ${rang} : l'en-tête « ${entete} » est en double.`);
    } else {
      entetesVus.add(entete.toLowerCase());
    }

    if (!SOURCES_AUTORISEES.includes(col.source)) {
      erreurs.push(
        `Colonne ${rang} : la source « ${col.source} » est inconnue.`,
      );
    }

    if (col.source === "constante") {
      const v = col.valeur;
      if (v === undefined || v === null || String(v).trim() === "") {
        erreurs.push(`Colonne ${rang} : une colonne constante doit avoir une valeur.`);
      }
    }

    if (col.format !== undefined && !FORMATS_AUTORISES.includes(col.format)) {
      erreurs.push(`Colonne ${rang} : le format « ${col.format} » est inconnu.`);
    }
  });

  if (config.format !== undefined && !["CSV", "XLSX"].includes(config.format)) {
    erreurs.push("Le format de fichier doit être CSV ou XLSX.");
  }

  return { ok: erreurs.length === 0, erreurs };
}

// Vérifie une configuration d'import (le fichier de retour).
function validateImportConfig(config) {
  const erreurs = [];

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { ok: false, erreurs: ["La configuration doit être un objet."] };
  }

  if (!config.colonne_reference || String(config.colonne_reference).trim() === "") {
    erreurs.push(
      "La colonne contenant la référence est obligatoire : c'est elle qui permet de rapprocher le paiement.",
    );
  }

  if (config.colonne_statut && String(config.colonne_statut).trim() !== "") {
    const succes = config.valeurs_succes;
    if (!Array.isArray(succes) || succes.length === 0) {
      erreurs.push(
        "Une colonne de statut est indiquée : précisez au moins une valeur signifiant « payé ».",
      );
    }
  }

  if (config.controle_montant && !config.colonne_montant) {
    erreurs.push(
      "Le contrôle du montant est activé mais aucune colonne de montant n'est indiquée.",
    );
  }

  return { ok: erreurs.length === 0, erreurs };
}

// Met une valeur au format demandé par le gabarit.
function _formater(valeur, format) {
  if (valeur === null || valeur === undefined) return "";

  switch (format) {
    case "ENTIER": {
      const n = Number(valeur);
      return Number.isFinite(n) ? String(Math.trunc(n)) : "";
    }
    case "DECIMAL2": {
      const n = Number(valeur);
      return Number.isFinite(n) ? n.toFixed(2) : "";
    }
    case "MAJUSCULES":
      return String(valeur).toUpperCase();
    case "MSISDN_229":
      return formaterMsisdn229(valeur) || "";
    case "MSISDN_LOCAL":
      return normaliserNumeroBenin(valeur) || "";
    case "IBAN_COMPACT":
      return normaliserIban(valeur) || "";
    case "IBAN_ESPACE": {
      const iban = normaliserIban(valeur);
      return iban ? iban.replace(/(.{4})/g, "$1 ").trim() : "";
    }
    case "DATE_FR": {
      const d = valeur instanceof Date ? valeur : new Date(valeur);
      if (Number.isNaN(d.getTime())) return "";
      const jj = String(d.getDate()).padStart(2, "0");
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      return `${jj}/${mm}/${d.getFullYear()}`;
    }
    case "BRUT":
    default:
      return String(valeur);
  }
}

// Substitue {mois}, {annee}, {lot} dans une valeur constante ou un nom de
// fichier.
function _substituer(modele, contexte) {
  const ctx = contexte || {};
  return String(modele).replace(/\{(\w+)\}/g, (tout, cle) => {
    const v = ctx[cle];
    return v === undefined || v === null ? tout : String(v);
  });
}

// Applique UNE colonne du gabarit à UNE ligne de règlement.
// C'est le pivot testable de tout l'export.
function appliquerColonne(ligne, colonne, contexte) {
  if (!colonne || typeof colonne !== "object") return "";

  if (colonne.source === "constante") {
    return _substituer(colonne.valeur ?? "", contexte);
  }

  const source = colonne.source;
  let brut;

  if (source === "mois" || source === "annee" || source === "libelle_lot") {
    brut = (contexte || {})[source];
  } else {
    brut = (ligne || {})[source];
  }

  return _formater(brut, colonne.format);
}

// Construit le tableau complet d'un export.
//
// Une ligne dont une colonne marquée `obligatoire` ressort vide N'EST PAS
// exportée : elle remonte dans `erreurs`. Un IBAN manquant doit être vu par
// le comptable, pas produire une case vide dans le fichier de la banque —
// qui la rejetterait, ou pire, l'accepterait.
function construireLignesExport(lignes, exportConfig, contexte) {
  const cfg = exportConfig || {};
  const colonnes = Array.isArray(cfg.colonnes) ? cfg.colonnes : [];

  const entetes = colonnes.map((c) => (c && c.entete ? String(c.entete) : ""));
  const resultat = [];
  const erreurs = [];

  (lignes || []).forEach((ligne) => {
    const cellules = [];
    const manquantes = [];

    colonnes.forEach((col) => {
      const cellule = appliquerColonne(ligne, col, contexte);
      if (col && col.obligatoire && String(cellule).trim() === "") {
        manquantes.push(col.entete || col.source);
      }
      cellules.push(cellule);
    });

    if (manquantes.length > 0) {
      erreurs.push({
        reference: ligne ? ligne.reference : null,
        matricule: ligne ? ligne.matricule : null,
        nom: ligne ? ligne.nom : null,
        colonnes_manquantes: manquantes,
        motif: `Données de paiement manquantes : ${manquantes.join(", ")}.`,
      });
      return; // ligne exclue du fichier
    }

    resultat.push(cellules);
  });

  return { entetes, lignes: resultat, erreurs };
}

// Nom de fichier assaini : ni séparateur de chemin, ni espace, ni accent.
function nommerFichierExport(modele, contexte) {
  const base = _substituer(modele || "export", contexte);
  return sansAccents(base)
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "") || "export";
}


// ============================================================
// RAPPROCHEMENT DU FICHIER DE RETOUR
// ============================================================

const MOTIF_REFERENCE = /SIRH-\d{6}-\d{6}/i;

// Retrouve notre référence dans une cellule du fichier de retour.
//
// Les opérateurs ne renvoient presque jamais la référence nue : le libellé
// ressemble plutôt à « Paiement SIRH-202608-000042 salaire aout ». On la
// cherche donc dans la chaîne. Le mode EXACT désactive cette recherche pour
// les plateformes qui restituent la référence telle quelle.
function extraireReference(valeur, mode) {
  if (valeur === null || valeur === undefined) return null;
  const v = String(valeur).trim();
  if (!v) return null;

  if (mode === "EXACT") {
    const candidat = v.toUpperCase();
    return MOTIF_REFERENCE.test(candidat) && candidat.length === 18 ? candidat : null;
  }

  const trouve = v.match(MOTIF_REFERENCE);
  return trouve ? trouve[0].toUpperCase() : null;
}

// Récupère une cellule quel que soit l'habillage de son en-tête.
// Le frontend minuscule et trime déjà les en-têtes (CSVManager), mais un
// fichier peut arriver par une autre voie.
function _cellule(row, nomColonne) {
  if (!row || !nomColonne) return undefined;
  const cible = sansAccents(nomColonne);
  for (const cle of Object.keys(row)) {
    if (sansAccents(cle) === cible) return row[cle];
  }
  return undefined;
}

// Décide du sort d'UNE ligne du fichier de retour. Fonction pure : elle ne
// touche pas la base, elle rend un verdict que l'appelant applique.
//
// RÈGLE LA PLUS IMPORTANTE DU FICHIER : un statut qui ne figure ni dans les
// valeurs de succès ni dans celles d'échec donne NON_RECONNUE, jamais PAYE.
// Constater à tort un paiement qui n'a pas eu lieu est la pire erreur
// possible ici — un salarié ne serait jamais payé et le système affirmerait
// le contraire.
function rapprocherLigneRetour(row, importConfig, indexParReference) {
  const cfg = importConfig || {};
  const index = indexParReference || {};

  const brutRef = _cellule(row, cfg.colonne_reference);
  const reference = extraireReference(brutRef, cfg.mode_reference);

  if (!reference) {
    return { statut: "NON_RECONNUE", reference: null, motif: "Aucune référence lisible sur cette ligne." };
  }

  const ligne = index[reference];
  if (!ligne) {
    return {
      statut: "NON_RECONNUE",
      reference,
      motif: "Cette référence n'appartient pas au lot en cours.",
    };
  }

  if (ligne.statut === "PAYE") {
    return { statut: "DEJA_TRAITEE", reference, ligne_id: ligne.id };
  }

  const transaction_id = cfg.colonne_transaction
    ? _cellule(row, cfg.colonne_transaction)
    : undefined;

  const brutDate = cfg.colonne_date ? _cellule(row, cfg.colonne_date) : undefined;
  let date_reglement = null;
  if (brutDate) {
    const d = new Date(brutDate);
    if (!Number.isNaN(d.getTime())) date_reglement = d.toISOString();
  }

  // Contrôle du montant avant le statut : un montant divergent est suspect
  // même si la plateforme annonce un succès.
  if (cfg.controle_montant && cfg.colonne_montant) {
    const brutMontant = _cellule(row, cfg.colonne_montant);
    const montant = Number(String(brutMontant ?? "").replace(/[\s,]/g, ""));
    if (Number.isFinite(montant) && Number(ligne.montant) !== montant) {
      return {
        statut: "MONTANT_DIVERGENT",
        reference,
        ligne_id: ligne.id,
        motif: `Montant du retour (${montant}) différent du montant attendu (${ligne.montant}).`,
      };
    }
  }

  // Sans colonne de statut, la seule présence de la ligne dans le fichier
  // vaut constat — c'est le cas des retours qui ne listent que les réussites.
  if (!cfg.colonne_statut) {
    return { statut: "PAYE", reference, ligne_id: ligne.id, transaction_id, date_reglement };
  }

  const brutStatut = sansAccents(_cellule(row, cfg.colonne_statut));
  const succes = (cfg.valeurs_succes || []).map(sansAccents);
  const echecs = (cfg.valeurs_echec || []).map(sansAccents);

  if (succes.includes(brutStatut)) {
    return { statut: "PAYE", reference, ligne_id: ligne.id, transaction_id, date_reglement };
  }

  if (echecs.includes(brutStatut)) {
    const motifColonne = cfg.colonne_motif ? _cellule(row, cfg.colonne_motif) : null;
    return {
      statut: "ECHOUE",
      reference,
      ligne_id: ligne.id,
      transaction_id,
      date_reglement,
      motif_echec: motifColonne ? String(motifColonne) : `Statut « ${_cellule(row, cfg.colonne_statut)} » signalé en échec.`,
    };
  }

  return {
    statut: "NON_RECONNUE",
    reference,
    ligne_id: ligne.id,
    motif: `Statut « ${_cellule(row, cfg.colonne_statut)} » non reconnu : ni succès ni échec déclaré.`,
  };
}


module.exports = {
  // Mois
  MOIS_FR,
  sansAccents,
  moisVersNumero,
  // Identité de paiement
  PREFIXES_OPERATEURS,
  OPERATEURS,
  normaliserNumeroBenin,
  estNumeroBeninValide,
  suggestOperateur,
  formaterMsisdn229,
  normaliserIban,
  estIbanBjValide,
  // Gabarits
  SOURCES_AUTORISEES,
  FORMATS_AUTORISES,
  validateTemplateConfig,
  validateImportConfig,
  appliquerColonne,
  construireLignesExport,
  nommerFichierExport,
  // Rapprochement
  extraireReference,
  rapprocherLigneRetour,
};
