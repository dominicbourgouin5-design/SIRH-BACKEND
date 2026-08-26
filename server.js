require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const rateLimit = require('express-rate-limit');
const compression = require('compression');

// --- IMPORTS DES MODULES ---
const reportingRoutes = require('./routes/reporting');
const tutorialRoutes = require('./routes/tutorials');
const backupRoutes = require('./routes/backup');
const { responseTimeMiddleware, getHealthStatus } = require('./monitoring');
const { enforceMethodPolicy } = require('./routePolicy');
const { applyPermissionOverrides } = require('./utils');
const crmRoutes = require("./routes/crm");
const authRoutes = require("./routes/auth");
const employeeRoutes = require("./routes/employees");
const payrollRoutes = require("./routes/payroll");
const leavesRoutes = require("./routes/leaves");
const contractsRoutes = require("./routes/contracts");
const recruitmentRoutes = require("./routes/recruitment");
const mobileRoutes = require("./routes/mobile");
const catalogRoutes = require("./routes/catalog");
const chatRoutes = require("./routes/chat");
const systemRoutes = require("./routes/system");
const permissionsRoutes = require("./routes/permissions");
const startCronJobs = require("./cron");

const app = express();

// ============================================================
// CONFIGURATION TRUST PROXY
// ============================================================
app.set('trust proxy', 1);

// ============================================================
// RATE LIMITING
// ============================================================

const limiterConfig = {
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false }
};

const globalLimiter = rateLimit({
    ...limiterConfig,
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: "Trop de requêtes. Veuillez réessayer plus tard." }
});

const authLimiter = rateLimit({
    ...limiterConfig,
    windowMs: 15 * 60 * 1000,
    max: 10,
    skipSuccessfulRequests: true,
    message: { error: "Trop de tentatives de connexion. Compte bloqué 15 minutes." }
});

const writeLimiter = rateLimit({
    ...limiterConfig,
    windowMs: 60 * 60 * 1000,
    max: 50,
    message: { error: "Trop d'opérations d'écriture. Veuillez ralentir." }
});

// Routes publiques sans authentification : le badge scanné et le formulaire
// de candidature. Leur identifiant étant énumérable, une limite stricte évite
// qu'on itère dessus pour aspirer l'annuaire ou inonder les boîtes mail.
const publicLimiter = rateLimit({
    ...limiterConfig,
    windowMs: 60 * 60 * 1000,
    max: 30,
    message: { error: "Trop de requêtes. Veuillez réessayer plus tard." }
});

const uploadLimiter = rateLimit({
    ...limiterConfig,
    windowMs: 60 * 60 * 1000,
    max: 30,
    message: { error: "Trop d'uploads. Veuillez réessayer plus tard." }
});

// --- CONFIGURATION MULTER ---
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp"
    ];
    if (allowedMimeTypes.includes(file.mimetype) || file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error(`Format ${file.mimetype} refusé.`));
    }
  },
});

// --- CONFIGURATION CORS ---
const allowedOrigins = [
    'https://sirh.cataria-systems.com',
    'http://sirh.cataria-systems.com', 
    'https://dominicbourgouin5-design.github.io',
    'http://dominicbourgouin5-design.github.io'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.log("CORS Bloqué pour origine :", origin);
            callback(new Error('Non autorisé par CORS'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

// Middlewares
app.use(compression());
app.use(responseTimeMiddleware);
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));

// ============================================================
// APPLICATION DES LIMITEURS AUX ROUTES
// ============================================================

app.use("/api", globalLimiter);
app.use("/api/login", authLimiter);
app.use("/api/verify-2fa", authLimiter);
app.use("/api/request-password-reset", authLimiter);
app.use("/api/reset-password", authLimiter);
app.use("/api/write", writeLimiter);
app.use("/api/update", writeLimiter);
app.use("/api/delete-employee", writeLimiter);
app.use("/api/delete-product", writeLimiter);
app.use("/api/save-product", writeLimiter);
app.use("/api/save-lead", writeLimiter);
app.use("/api/add-prescripteur", writeLimiter);
app.use("/api/update-prescripteur", writeLimiter);
app.use("/api/import-", writeLimiter);
app.use("/api/gatekeeper", publicLimiter);
app.use("/api/ingest-candidate", publicLimiter);
app.use("/api/upload-", uploadLimiter);
app.use("/api/bulk-upload-docs", uploadLimiter);
app.use("/api/contract-upload", uploadLimiter);

console.log("🛡️ Rate limiting activé :");
console.log("   - Global: 100 req/15min");
console.log("   - Auth: 10 req/15min");
console.log("   - Write: 50 req/heure");
console.log("   - Upload: 30 req/heure");
console.log("   - Public (badge, candidature): 30 req/heure");

// ============================================================
// POLITIQUE DES MÉTHODES HTTP
// Empêche qu'une écriture ou une suppression soit déclenchée
// par un simple GET (voir routePolicy.js).
// ============================================================
app.use("/api", enforceMethodPolicy);
console.log("🚦 Contrôle des méthodes HTTP activé.");

// ============================================================
// ROUTES PUBLIQUES (SANS AUTHENTIFICATION)
// ============================================================
app.get('/api/health', async (req, res) => {
    try {
        const status = await getHealthStatus();
        res.json(status);
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.get('/api/ping', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================================
// SECURITE JWT
// ============================================================

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("❌ ERREUR CRITIQUE : JWT_SECRET n'est pas configuré.");
  process.exit(1);
}

// Comparaison stricte : un `includes` laissait passer sans token toute
// route dont le chemin contenait l'une de ces chaînes en sous-chaîne
// (ex. /read-login-history aurait été considérée comme publique).
const PUBLIC_PATHS = new Set([
  "/login",
  "/verify-2fa",
  "/gatekeeper",
  "/ingest-candidate",
  "/request-password-reset",
  "/reset-password",
  "/health",
  "/ping"
]);

const authenticateToken = (req, res, next) => {
  const cleanPath = req.path.replace(/\/+$/, "") || "/";
  if (PUBLIC_PATHS.has(cleanPath)) return next();

  // Le token transite uniquement par l'en-tête Authorization.
  // En query string il se retrouverait dans les logs du proxy,
  // l'historique du navigateur et l'en-tête Referer.
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Token de sécurité manquant" });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: "Session expirée ou invalide" });
    req.user = {
      ...decoded,
      permissions: decoded.permissions || {},
    };
    next();
  });
};

// ============================================================
// ROUTES PRINCIPALES (TOUTES PROTÉGÉES PAR JWT)
// ============================================================

app.use("/api", authenticateToken);
// Fusionne les dérogations individuelles dans req.user.permissions dès la
// sortie du JWT : à partir d'ici, tout `checkPerm` du code en tient compte.
app.use("/api", applyPermissionOverrides);
app.use("/api", upload.any());

// Routes API
app.use("/api", authRoutes);
app.use("/api", employeeRoutes);
app.use("/api", payrollRoutes);
app.use("/api", leavesRoutes);
app.use("/api", contractsRoutes);
app.use("/api", recruitmentRoutes);
app.use("/api", mobileRoutes);
app.use("/api", catalogRoutes);
app.use("/api", chatRoutes);
app.use("/api", systemRoutes);
app.use("/api", permissionsRoutes);
app.use("/api", crmRoutes);
app.use("/api", backupRoutes);
app.use("/api", reportingRoutes);
app.use("/api", tutorialRoutes);  // ← Tutoriel APRÈS authenticateToken

// ============================================================
// ROUTE DEBUG (optionnelle)
// ============================================================
app.get('/api/debug-role', authenticateToken, (req, res) => {
    res.json({ 
        role: req.user?.role,
        permissions: req.user?.permissions,
        user: req.user 
    });
});

// ============================================================
// GESTIONNAIRE D'ERREURS GLOBAL
// ============================================================

app.use((err, req, res, next) => {
  console.error("🚨 ERREUR SERVEUR :", err.message);
  
  if (err.status === 429) {
    return res.status(429).json({
      status: "error",
      error: "Trop de requêtes. Veuillez réessayer dans quelques minutes."
    });
  }
  
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        status: "error",
        error: "Le fichier est trop volumineux. Maximum 10MB."
      });
    }
    return res.status(400).json({
      status: "error",
      error: err.message
    });
  }
  
  res.status(err.status || 500).json({
    status: "error",
    error: err.message || "Une erreur interne est survenue."
  });
});

// ============================================================
// DEMARRAGE DU SERVEUR ET CRON
// ============================================================

startCronJobs();
console.log("⏱️ Tâches planifiées (CRON) initialisées.");

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`
  🚀  SERVEUR SIRH-SECURE OPÉRATIONNEL
  -----------------------------------
  🌍  Port : ${PORT}
  🔐  JWT Secret : Configuré ✅
  🛡️  Rate Limiting : Activé ✅
  🏢  Trust Proxy : Configuré ✅
  💚  Health Check : /api/health ✅
  💾  Backup : Activé ✅
  -----------------------------------
  `);
});
