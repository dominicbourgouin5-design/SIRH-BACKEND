// ============================================================
// POLITIQUE DES MÉTHODES HTTP
// ------------------------------------------------------------
// Le code historique déclare 83 routes en `router.all`, ce qui
// permet de déclencher une écriture ou une suppression avec un
// simple GET (lien, préchargement navigateur, balise <img>...).
// Cette table est la source de vérité : elle est dérivée des
// appels réellement effectués par le frontend.
// ============================================================

// --- Lectures : GET uniquement ---
const READ_ONLY = [
  "/read", "/read-archives", "/read-leaves", "/read-candidates",
  "/read-payroll", "/read-payroll-full", "/read-config", "/read-config-salaries",
  "/read-flash", "/read-report", "/read-logs", "/read-labels", "/read-modules",
  "/read-settings", "/read-messages", "/read-daily-reports", "/read-visit-reports",
  "/list-departments", "/list-roles", "/list-products", "/list-prescripteurs",
  "/list-templates", "/list-zones", "/list-schedules", "/list-mobile-locations",
  "/list-payroll-rules", "/list-backups", "/backup-tables", "/check-backups",
  "/leads", "/stages", "/crm-fields", "/list-pending-locations",
  "/get-clock-status", "/get-boss-summary", "/get-dashboard-stats",
  "/get-global-audit", "/get-live-positions", "/get-performance-report",
  "/live-attendance", "/attendance-status", "/check-closing-time",
  "/compute-automated-payroll", "/dashboard-widgets", "/dashboard-prefs",
  "/dashboard-stats", "/export-attendance", "/export-payroll",
  "/tutorials", "/tutorials/should-show", "/badge", "/export-folder",
];

// --- Écritures : POST uniquement ---
const WRITE_ONLY = [
  "/login", "/verify-2fa", "/request-password-reset", "/reset-password",
  "/write", "/emp-update", "/delete-employee", "/bulk-upload-docs",
  "/bulk-assign-manager",
  "/leave", "/leave-action",
  "/candidate-action", "/ingest-candidate",
  "/clock", "/submit-daily-report", "/delete-daily-report", "/delete-visit-report",
  "/add-schedule", "/update-schedule", "/delete-schedule",
  "/add-mobile-location", "/update-mobile-location", "/delete-mobile-location",
  "/propose-mobile-location", "/validate-mobile-location",
  "/add-zone", "/delete-zone", "/import-zones", "/import-locations",
  "/save-product", "/delete-product",
  "/add-prescripteur", "/update-prescripteur", "/delete-prescripteur",
  "/import-prescripteurs",
  "/process-payroll", "/process-payroll-advanced", "/calculate-payroll-dynamic",
  "/mark-payroll-read", "/update-config-salaries", "/save-payroll-rule",
  "/save-lead", "/delete-lead", "/add-interaction", "/save-crm-field",
  "/save-stage", "/send-email", "/upload-lead-file",
  "/upload-template", "/delete-template", "/contract-upload",
  "/send-message", "/write-flash",
  "/subscribe-push", "/run-archiving-job",
  "/run-backup", "/backup-table", "/send-monthly-report",
  "/tutorials/start", "/tutorials/next", "/tutorials/reset", "/tutorials/complete",
];

// --- Exceptions héritées ---
// Ces trois routes lisent leurs paramètres dans req.query et modifient
// pourtant des données. Les migrer en POST demande de toucher aussi le
// frontend ; elles restent donc tolérées en GET, mais sont listées ici
// pour rester visibles tant que la migration n'est pas faite.
// /check-returns clôture les retours de congé : elle écrit en base tout en
// étant déclenchée en GET par le frontend. Même catégorie que les trois
// autres, à migrer en POST des deux côtés à la même occasion.
const LEGACY_GET_WRITES = ["/update", "/gatekeeper", "/contract-gen", "/check-returns"];

const policy = new Map();
for (const p of READ_ONLY) policy.set(p, ["GET", "HEAD"]);
for (const p of WRITE_ONLY) policy.set(p, ["POST"]);
for (const p of LEGACY_GET_WRITES) policy.set(p, ["GET", "HEAD", "POST"]);

// Routes non listées : on autorise GET et POST, jamais PUT/DELETE/PATCH.
const DEFAULT_METHODS = ["GET", "HEAD", "POST"];

function normalize(path) {
  // "/export-folder/12" -> "/export-folder"
  const clean = path.split("?")[0].replace(/\/+$/, "") || "/";
  if (policy.has(clean)) return clean;
  const firstSegment = "/" + clean.split("/").filter(Boolean)[0];
  return policy.has(firstSegment) ? firstSegment : clean;
}

function enforceMethodPolicy(req, res, next) {
  if (req.method === "OPTIONS") return next();

  const allowed = policy.get(normalize(req.path)) || DEFAULT_METHODS;

  if (!allowed.includes(req.method)) {
    console.warn(`⛔ Méthode ${req.method} refusée sur ${req.path}`);
    res.set("Allow", allowed.join(", "));
    return res.status(405).json({
      status: "error",
      error: `La méthode ${req.method} n'est pas autorisée sur cette route.`,
    });
  }

  return next();
}

module.exports = { enforceMethodPolicy, READ_ONLY, WRITE_ONLY, LEGACY_GET_WRITES, policy };
