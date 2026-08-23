const test = require("node:test");
const assert = require("node:assert");

// utils.js importe supabaseClient.js, qui lève une exception à la
// construction si SUPABASE_URL/SUPABASE_KEY sont absents (cas de ce test,
// exécuté sans base ni réseau). Ces valeurs factices ne servent qu'à
// satisfaire la construction du client Supabase — findNearestLocation et
// deriveAxesFromEmployeeType sont des fonctions pures, aucune requête
// n'est jamais émise.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || "test-key";

const { findNearestLocation, deriveAxesFromEmployeeType } = require("../utils");

test("retient le lieu le plus proche, pas le premier de la liste (Bug 2)", () => {
  const candidates = [
    { id: "far", name: "Loin", lat: 6.5, lon: 2.5, radius: 1000, isOffice: true },   // listé en premier
    { id: "near", name: "Proche", lat: 6.4, lon: 2.4, radius: 1000, isOffice: false },
  ];
  const result = findNearestLocation(6.4, 2.4, candidates);
  assert.strictEqual(result.id, "near");
});

test("utilise le rayon configuré de chaque lieu, jamais une valeur codée en dur (Bug 1)", () => {
  const candidates = [{ id: "z1", name: "Site étroit", lat: 6.4, lon: 2.4, radius: 10, isOffice: true }];
  // à ~55m, hors du rayon réellement configuré (10m) : ne doit PAS matcher
  // même si l'ancien code forçait 1500m pour les zones.
  const result = findNearestLocation(6.4005, 2.4, candidates);
  assert.strictEqual(result, null);
});

test("rayon manquant retombe sur 100m par défaut, sans distinction zone/mobile", () => {
  const candidates = [{ id: "m1", name: "Sans rayon", lat: 6.4, lon: 2.4, radius: null, isOffice: false }];
  assert.notStrictEqual(findNearestLocation(6.4, 2.4, candidates), null);
});

test("deriveAxesFromEmployeeType reste synchronisé avec le backfill SQL", () => {
  assert.deepStrictEqual(deriveAxesFromEmployeeType("MOBILE"),
    { secteur: "SANTE", perimetre_lieux: "CATALOGUE_OUVERT", contenu_pointage: "COMPLET", rythme: "STANDARD" });
  assert.deepStrictEqual(deriveAxesFromEmployeeType("SECURITY"), deriveAxesFromEmployeeType("FIXED"));
  assert.deepStrictEqual(deriveAxesFromEmployeeType("OFFICE"),
    { secteur: "GENERAL", perimetre_lieux: "UN_LIEU", contenu_pointage: "MINIMAL", rythme: "STANDARD" });
});
