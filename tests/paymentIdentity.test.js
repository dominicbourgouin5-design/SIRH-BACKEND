const test = require("node:test");
const assert = require("node:assert");

// settlementFormat.js n'a aucun require : pas besoin des variables
// d'environnement factices dont ont besoin les tests de utils.js.
const {
  PREFIXES_OPERATEURS,
  OPERATEURS,
  normaliserNumeroBenin,
  estNumeroBeninValide,
  suggestOperateur,
  formaterMsisdn229,
  normaliserIban,
  estIbanBjValide,
  moisVersNumero,
} = require("../settlementFormat");

// ============================================================
// OPÉRATEURS
// ============================================================

test("aucun préfixe n'est attribué à deux opérateurs à la fois", () => {
  // Protège contre une faute de frappe dans la table : un préfixe partagé
  // enverrait des paiements chez le mauvais opérateur.
  const vus = new Map();
  for (const operateur of OPERATEURS) {
    for (const prefixe of PREFIXES_OPERATEURS[operateur]) {
      assert.strictEqual(
        vus.has(prefixe),
        false,
        `Le préfixe ${prefixe} est attribué à la fois à ${vus.get(prefixe)} et à ${operateur}`,
      );
      vus.set(prefixe, operateur);
    }
  }
});

test("tous les préfixes sont au format 01XX", () => {
  for (const operateur of OPERATEURS) {
    for (const prefixe of PREFIXES_OPERATEURS[operateur]) {
      assert.match(prefixe, /^01\d{2}$/, `Préfixe mal formé : ${prefixe} (${operateur})`);
    }
  }
});

test("suggestOperateur reconnaît chaque opérateur", () => {
  assert.strictEqual(suggestOperateur("0197123456"), "MTN");
  assert.strictEqual(suggestOperateur("0155123456"), "MOOV");
  assert.strictEqual(suggestOperateur("0121123456"), "CELTIIS");
});

test("un préfixe inconnu ne donne AUCUN opérateur, jamais un par défaut", () => {
  // 0177 n'est attribué à personne : renvoyer un opérateur au hasard ferait
  // partir le paiement au mauvais endroit sans que personne ne le voie.
  assert.strictEqual(suggestOperateur("0177123456"), null);
});

// ============================================================
// NUMÉROS BÉNINOIS
// ============================================================

test("normaliserNumeroBenin absorbe toutes les écritures courantes", () => {
  const attendu = "0197123456";
  assert.strictEqual(normaliserNumeroBenin("0197123456"), attendu);
  assert.strictEqual(normaliserNumeroBenin("01 97 12 34 56"), attendu);
  assert.strictEqual(normaliserNumeroBenin("+229 01 97 12 34 56"), attendu);
  assert.strictEqual(normaliserNumeroBenin("0022901971234 56".replace(" ", "")), attendu);
  assert.strictEqual(normaliserNumeroBenin("229-0197-123456"), attendu);
});

test("l'ancien format à 8 chiffres est refusé", () => {
  // Le plan de numérotation est passé à 10 chiffres le 30/11/2024.
  // L'accepter silencieusement produirait un fichier rejeté par l'opérateur.
  assert.strictEqual(normaliserNumeroBenin("97123456"), null);
  assert.strictEqual(estNumeroBeninValide("97123456"), false);
});

test("un numéro qui ne commence pas par 01 est refusé", () => {
  assert.strictEqual(normaliserNumeroBenin("0297123456"), null);
});

test("une saisie non numérique est refusée sans planter", () => {
  assert.strictEqual(normaliserNumeroBenin("pas un numero"), null);
  assert.strictEqual(normaliserNumeroBenin(""), null);
  assert.strictEqual(normaliserNumeroBenin(null), null);
  assert.strictEqual(normaliserNumeroBenin(undefined), null);
});

test("formaterMsisdn229 conserve le 0 du préfixe 01 — il n'est PAS un chiffre d'accès", () => {
  // Au Bénin, contrairement à la France, le 0 de « 01 » fait partie du
  // numéro et ne se retire pas à l'international. Le supprimer produirait
  // 229197123456, qui n'aboutit nulle part : tous les paiements mobile
  // money seraient rejetés.
  assert.strictEqual(formaterMsisdn229("0197123456"), "2290197123456");
  assert.strictEqual(formaterMsisdn229("+229 01 97 12 34 56"), "2290197123456");
  assert.strictEqual(formaterMsisdn229("97123456"), null);
});

test("le MSISDN fait toujours 13 chiffres", () => {
  // 229 + 10 chiffres. Un résultat à 12 chiffres signalerait le retour du
  // bug du 0 supprimé.
  assert.strictEqual(formaterMsisdn229("0197123456").length, 13);
  assert.strictEqual(formaterMsisdn229("0155123456").length, 13);
});

// ============================================================
// IBAN
// ============================================================

test("un IBAN béninois valide est accepté", () => {
  // Exemple de la documentation IBAN pour le Bénin.
  const res = estIbanBjValide("BJ66BJ0610100100144390000769");
  assert.strictEqual(res.valide, true);
  assert.strictEqual(res.avertissement, undefined);
});

test("les espaces de saisie sont absorbés", () => {
  assert.strictEqual(
    normaliserIban("BJ66 BJ06 1010 0100 1443 9000 0769"),
    "BJ66BJ0610100100144390000769",
  );
});

test("une longueur incorrecte est refusée nettement", () => {
  const res = estIbanBjValide("BJ66BJ061010010014439000076");
  assert.strictEqual(res.valide, false);
  assert.match(res.raison, /28 caractères/);
});

test("un IBAN d'un autre pays est refusé", () => {
  const res = estIbanBjValide("FR7630006000011234567890189");
  assert.strictEqual(res.valide, false);
  assert.match(res.raison, /BJ/);
});

test("une clé de contrôle fausse avertit sans bloquer", () => {
  // Choix délibéré : des RIB béninois en circulation échouent au mod-97.
  // Bloquer le comptable coûterait plus cher que de l'avertir.
  const res = estIbanBjValide("BJ99BJ0610100100144390000769");
  assert.strictEqual(res.valide, true);
  assert.strictEqual(res.avertissement, true);
});

test("un IBAN vide est refusé", () => {
  assert.strictEqual(estIbanBjValide("").valide, false);
  assert.strictEqual(estIbanBjValide(null).valide, false);
});

// ============================================================
// MOIS
// ============================================================

test("moisVersNumero gère les 12 mois, avec et sans accent, toutes casses", () => {
  assert.strictEqual(moisVersNumero("Janvier"), 1);
  assert.strictEqual(moisVersNumero("Août"), 8);
  assert.strictEqual(moisVersNumero("Aout"), 8);
  assert.strictEqual(moisVersNumero("AOUT"), 8);
  assert.strictEqual(moisVersNumero("  août  "), 8);
  assert.strictEqual(moisVersNumero("Février"), 2);
  assert.strictEqual(moisVersNumero("fevrier"), 2);
  assert.strictEqual(moisVersNumero("Décembre"), 12);
});

test("un mois inconnu donne null", () => {
  assert.strictEqual(moisVersNumero("Smarch"), null);
  assert.strictEqual(moisVersNumero(""), null);
  assert.strictEqual(moisVersNumero(null), null);
});
