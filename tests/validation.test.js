const test = require("node:test");
const assert = require("node:assert");
const { isValidPerimetreLieux, isValidContenuPointage, isValidRythme } = require("../validation");

test("rejette tout ce qui n'est pas dans le vocabulaire fermé", () => {
  assert.strictEqual(isValidPerimetreLieux("CATALOGUE_OUVERT"), true);
  assert.strictEqual(isValidPerimetreLieux("catalogue_ouvert"), false); // casse
  assert.strictEqual(isValidPerimetreLieux(""), false);
  assert.strictEqual(isValidContenuPointage("COMPLET"), true);
  assert.strictEqual(isValidContenuPointage("PARTIEL"), false);
  assert.strictEqual(isValidRythme("GARDE"), true);
  assert.strictEqual(isValidRythme("URGENCE"), false);
});
