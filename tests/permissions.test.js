const test = require("node:test");
const assert = require("node:assert");

// Même contournement que location.test.js : utils.js importe
// supabaseClient.js, qui lève une exception à la construction sans
// SUPABASE_URL/SUPABASE_KEY. Ces valeurs factices ne servent qu'à
// satisfaire la construction du client — mergeOverridesIntoPermissions est
// une fonction pure, aucune requête n'est jamais émise.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || "test-key";

const { LOCKED_PERMISSIONS, mergeOverridesIntoPermissions } = require("../utils");

test("la liste des permissions verrouillées est exactement celle validée avec le client", () => {
  assert.deepStrictEqual(
    [...LOCKED_PERMISSIONS].sort(),
    [
      "can_delete_employees",
      "can_manage_config",
      "can_manage_mobile_locations",
      "can_manage_schedules",
      "can_see_audit",
    ].sort(),
  );
});

test("une dérogation ADD accorde une permission absente du rôle", () => {
  const merged = mergeOverridesIntoPermissions(
    { can_see_employees: false },
    { add: ["can_see_employees"], remove: [] },
  );
  assert.strictEqual(merged.can_see_employees, true);
});

test("une dérogation REMOVE retire une permission donnée par le rôle", () => {
  const merged = mergeOverridesIntoPermissions(
    { can_see_payroll: true },
    { add: [], remove: ["can_see_payroll"] },
  );
  assert.strictEqual(merged.can_see_payroll, false);
});

test("un retrait l'emporte sur un ajout portant sur la même permission", () => {
  const merged = mergeOverridesIntoPermissions(
    { can_see_employees: false },
    { add: ["can_see_employees"], remove: ["can_see_employees"] },
  );
  assert.strictEqual(merged.can_see_employees, false);
});

test("une permission verrouillée ne peut jamais être modifiée par une dérogation", () => {
  for (const locked of LOCKED_PERMISSIONS) {
    const ajoutee = mergeOverridesIntoPermissions({ [locked]: false }, { add: [locked], remove: [] });
    assert.strictEqual(ajoutee[locked], false, `${locked} n'aurait pas dû pouvoir être accordée`);

    const retiree = mergeOverridesIntoPermissions({ [locked]: true }, { add: [], remove: [locked] });
    assert.strictEqual(retiree[locked], true, `${locked} n'aurait pas dû pouvoir être retirée`);
  }
});

test("sans dérogation, les permissions du rôle passent inchangées", () => {
  const base = { can_clock: true, can_see_payroll: false };
  assert.deepStrictEqual(mergeOverridesIntoPermissions(base, { add: [], remove: [] }), base);
  assert.deepStrictEqual(mergeOverridesIntoPermissions(base, null), base);
});

test("ne mute jamais l'objet de permissions d'origine", () => {
  const base = { can_see_employees: false };
  mergeOverridesIntoPermissions(base, { add: ["can_see_employees"], remove: [] });
  assert.strictEqual(base.can_see_employees, false);
});
