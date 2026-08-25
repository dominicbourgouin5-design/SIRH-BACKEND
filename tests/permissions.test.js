const test = require("node:test");
const assert = require("node:assert");

// Même contournement que location.test.js : utils.js importe
// supabaseClient.js, qui lève une exception à la construction sans
// SUPABASE_URL/SUPABASE_KEY. Ces valeurs factices ne servent qu'à
// satisfaire la construction du client — aucune requête n'est jamais émise
// par les chemins testés ici (LOCKED_PERMISSIONS est une simple Set, et
// checkPermAsync sur une permission verrouillée retourne avant de toucher
// la base).
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || "test-key";

const { LOCKED_PERMISSIONS, checkPermAsync, checkPerm } = require("../utils");

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

test("checkPermAsync sur une permission verrouillée ne fait jamais de requête base et retombe sur checkPerm", async () => {
  const reqAllowed = { user: { emp_id: 1, permissions: { can_manage_config: true } } };
  const reqDenied = { user: { emp_id: 1, permissions: { can_manage_config: false } } };

  assert.strictEqual(await checkPermAsync(reqAllowed, "can_manage_config"), true);
  assert.strictEqual(await checkPermAsync(reqDenied, "can_manage_config"), false);

  // Cohérent avec checkPerm() synchrone sur la même entrée.
  assert.strictEqual(await checkPermAsync(reqAllowed, "can_manage_config"), checkPerm(reqAllowed, "can_manage_config"));
});

test("checkPermAsync sans employé rattaché retombe sur checkPerm sans planter", async () => {
  const req = { user: { emp_id: null, permissions: { can_see_employees: true } } };
  assert.strictEqual(await checkPermAsync(req, "can_see_employees"), true);
});
