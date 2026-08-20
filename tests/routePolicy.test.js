const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const {
  enforceMethodPolicy,
  READ_ONLY,
  WRITE_ONLY,
  LEGACY_GET_WRITES,
} = require("../routePolicy");

// Simule un passage dans le middleware et retourne le code HTTP obtenu.
function appeler(method, url) {
  const req = { method, path: url };
  let statut = 200;
  const res = {
    set() { return res; },
    status(code) { statut = code; return res; },
    json() { return res; },
  };
  let passe = false;
  enforceMethodPolicy(req, res, () => { passe = true; });
  return passe ? 200 : statut;
}

test("les identifiants ne peuvent plus transiter en GET", () => {
  assert.strictEqual(appeler("GET", "/login"), 405);
  assert.strictEqual(appeler("POST", "/login"), 200);
});

test("une suppression ne se déclenche pas par un simple GET", () => {
  for (const route of ["/delete-employee", "/delete-lead", "/delete-product", "/write"]) {
    assert.strictEqual(appeler("GET", route), 405, `${route} doit refuser GET`);
  }
});

test("PUT et DELETE sont refusés partout, y compris sur les routes inconnues", () => {
  for (const method of ["PUT", "DELETE", "PATCH"]) {
    assert.strictEqual(appeler(method, "/write"), 405);
    assert.strictEqual(appeler(method, "/route-inexistante"), 405);
  }
});

test("les lectures restent accessibles en GET", () => {
  for (const route of ["/read", "/read-leaves", "/list-products", "/badge"]) {
    assert.strictEqual(appeler("GET", route), 200, `${route} doit accepter GET`);
  }
});

test("les routes à segments sont reconnues", () => {
  assert.strictEqual(appeler("POST", "/tutorials/start"), 200);
  assert.strictEqual(appeler("GET", "/tutorials/start"), 405);
  assert.strictEqual(appeler("GET", "/export-folder/42"), 200);
});

test("OPTIONS passe toujours, sinon le préflight CORS casserait", () => {
  assert.strictEqual(appeler("OPTIONS", "/write"), 200);
});

test("une route non déclarée n'autorise que GET et POST", () => {
  assert.strictEqual(appeler("GET", "/toute-nouvelle-route"), 200);
  assert.strictEqual(appeler("POST", "/toute-nouvelle-route"), 200);
});

test("aucune route n'est classée à la fois en lecture et en écriture", () => {
  const doublons = READ_ONLY.filter((r) => WRITE_ONLY.includes(r));
  assert.deepStrictEqual(doublons, [], `classées deux fois : ${doublons.join(", ")}`);
});

// ------------------------------------------------------------------
// Garde-fou : une route déclarée en écriture doit réellement écrire,
// et une route déclarée en lecture ne doit rien modifier. Sans ce test,
// une erreur de classement passe inaperçue jusqu'en production.
// ------------------------------------------------------------------
function corpsDesRoutes() {
  const corps = {};
  const dossier = path.join(__dirname, "..", "routes");
  for (const fichier of fs.readdirSync(dossier)) {
    const source = fs.readFileSync(path.join(dossier, fichier), "utf8");
    const regex = /router\.(get|post|put|delete|all)\(\s*["']([^"']+)["']/g;
    const marques = [];
    let m;
    while ((m = regex.exec(source))) marques.push({ route: m[2], index: m.index });
    marques.forEach((marque, i) => {
      const fin = i + 1 < marques.length ? marques[i + 1].index : source.length;
      corps[marque.route] = (corps[marque.route] || "") + source.slice(marque.index, fin);
    });
  }
  return corps;
}

test("une route déclarée en lecture seule ne modifie pas la base", () => {
  const corps = corpsDesRoutes();
  const fautives = READ_ONLY.filter(
    (route) => corps[route] && /\.(insert|update|upsert|delete)\(/.test(corps[route])
  );
  assert.deepStrictEqual(
    fautives,
    [],
    `ces routes écrivent alors qu'elles sont classées en lecture : ${fautives.join(", ")}`
  );
});

test("les écritures déclenchées en GET restent limitées à la liste connue", () => {
  assert.deepStrictEqual(
    [...LEGACY_GET_WRITES].sort(),
    ["/check-returns", "/contract-gen", "/gatekeeper", "/update"],
    "toute nouvelle entrée doit être un choix conscient, pas un oubli"
  );
});
