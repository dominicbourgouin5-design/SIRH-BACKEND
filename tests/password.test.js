const test = require("node:test");
const assert = require("node:assert");
const {
  hashPassword,
  verifyPassword,
  isHashed,
  generateTempPassword,
  generateOtpCode,
  safeCompareCode,
} = require("../password");

test("un mot de passe haché n'est jamais stocké en clair", async () => {
  const hash = await hashPassword("MonMotDePasse123");
  assert.ok(isHashed(hash), "le résultat doit être un hash bcrypt");
  assert.notStrictEqual(hash, "MonMotDePasse123");
});

test("le bon mot de passe est accepté, le mauvais refusé", async () => {
  const hash = await hashPassword("MonMotDePasse123");

  const bon = await verifyPassword("MonMotDePasse123", hash);
  assert.strictEqual(bon.valid, true);
  assert.strictEqual(bon.needsUpgrade, false);

  const mauvais = await verifyPassword("autre", hash);
  assert.strictEqual(mauvais.valid, false);
});

test("un compte hérité en clair est accepté puis signalé pour migration", async () => {
  const res = await verifyPassword("ancien123", "ancien123");
  assert.strictEqual(res.valid, true);
  assert.strictEqual(res.needsUpgrade, true, "doit déclencher le re-hachage");
});

test("un compte hérité refuse quand même un mauvais mot de passe", async () => {
  const res = await verifyPassword("faux", "ancien123");
  assert.strictEqual(res.valid, false);
  assert.strictEqual(res.needsUpgrade, false);
});

test("un compte sans mot de passe ne laisse jamais passer", async () => {
  for (const stocke of [null, undefined, ""]) {
    const res = await verifyPassword("nimporte", stocke);
    assert.strictEqual(res.valid, false, `échec pour ${JSON.stringify(stocke)}`);
  }
});

test("une saisie vide ne peut pas ouvrir un compte hérité vide", async () => {
  const res = await verifyPassword("", "");
  assert.strictEqual(res.valid, false);
});

test("les mots de passe temporaires ne se répètent pas", () => {
  const tirages = new Set();
  for (let i = 0; i < 500; i++) tirages.add(generateTempPassword());
  assert.strictEqual(tirages.size, 500, "500 tirages doivent être uniques");
});

test("les codes OTP font toujours 6 chiffres", () => {
  for (let i = 0; i < 300; i++) {
    assert.match(generateOtpCode(), /^\d{6}$/);
  }
});

test("la comparaison de codes rejette les longueurs différentes et le vide", () => {
  assert.strictEqual(safeCompareCode("123456", "123456"), true);
  assert.strictEqual(safeCompareCode("123456", "654321"), false);
  assert.strictEqual(safeCompareCode("123456", "12345"), false);
  assert.strictEqual(safeCompareCode("", ""), false, "deux vides ne valident pas");
  assert.strictEqual(safeCompareCode(null, null), false);
});
