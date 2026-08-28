const test = require("node:test");
const assert = require("node:assert");

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || "test-key";

const { isValidPhone } = require("../validation");

test("les numéros béninois actuels à 10 chiffres sont acceptés", () => {
  // Depuis le 30/11/2024, tous les numéros commencent par 01 et font
  // 10 chiffres. L'ancienne expression les rejetait, ce qui bloquait la
  // saisie des coordonnées Mobile Money.
  assert.strictEqual(isValidPhone("0197123456"), true);
  assert.strictEqual(isValidPhone("01 97 12 34 56"), true);
  assert.strictEqual(isValidPhone("+229 01 97 12 34 56"), true);
  assert.strictEqual(isValidPhone("00229 01 97 12 34 56"), true);
  assert.strictEqual(isValidPhone("229-0197-123456"), true);
});

test("l'ancien format à 8 chiffres reste accepté pour les fiches historiques", () => {
  assert.strictEqual(isValidPhone("97123456"), true);
  assert.strictEqual(isValidPhone("097123456"), true);
  assert.strictEqual(isValidPhone("+22997123456"), true);
});

test("un numéro absent reste valide : le champ est facultatif", () => {
  assert.strictEqual(isValidPhone(""), true);
  assert.strictEqual(isValidPhone(null), true);
  assert.strictEqual(isValidPhone(undefined), true);
});

test("les saisies manifestement fausses sont refusées", () => {
  assert.strictEqual(isValidPhone("123"), false);
  assert.strictEqual(isValidPhone("pas un numero"), false);
  assert.strictEqual(isValidPhone("019712345678"), false); // trop long
});
