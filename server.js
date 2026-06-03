require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const rateLimit = require('express-rate-limit');

// --- IMPORTS DES MODULES ---
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
const startCronJobs = require("./cron");

const app = express();

// ============================================================
// 🔥 CONFIGURATION TRUST PROXY (POUR RENDER)
// ============================================================
// Render utilise un proxy, il faut dire à Express de faire confiance
app.set('trust proxy', 1);

// ============================================================
// 🔥 RATE LIMITING - Protection contre les attaques par force brute
// ============================================================

// Configuration de base pour les limiteurs (désactive la validation du proxy)
const limiterConfig = {
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false }  // 🔥 ESSENTIEL POUR RENDER
};

// Limiteur général pour toutes les API (max 100 requêtes par 15 minutes)
const globalLimiter = rateLimit({
    ...limiterConfig,
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: "Trop de requêtes. Veuillez réessayer plus tard." }
});

// Limiteur plus strict pour les routes sensibles (login, 2FA)
const authLimiter = rateLimit({
    ...limiterConfig,
    windowMs: 15 * 60 * 1000,
    max: 10,
    skipSuccessfulRequests: true,
    message: { error: "Trop de tentatives de connexion. Compte bloqué 15 minutes." }
});

// Limiteur pour les opérations d'écriture (création, modification)
const writeLimiter = rateLimit({
    ...limiterConfig,
    windowMs: 60 * 60 * 1000,
    max: 50,
    message: { error: "Trop d'opérations d'écriture. Veuillez ralentir." }
});

// Limiteur pour les téléchargements de fichiers
const uploadLimiter = rateLimit({
    ...limiterConfig,
    windowMs: 60 * 60 * 1000,
    max: 30,
    message: { error: "Trop d'uploads. Veuillez réessayer plus tard." }
});

// --- CONFIGURATION MULTER (Uploads en mémoire pour plus de rapidité) ---
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

// --- CONFIGURATION CORS SÉCURISÉE ---
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

// Middleware JSON et URL encodé
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));

// ============================================================
// 🔥 APPLICATION DES LIMITEURS AUX ROUTES
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
app.use("/api/upload-", uploadLimiter);
app.use("/api/bulk-upload-docs", uploadLimiter);
app.use("/api/contract-upload", uploadLimiter);

console.log("🛡️ Rate limiting activé :");
console.log("   - Global: 100 req/15min");
console.log("   - Auth: 10 req/15min");
console.log("   - Write: 50 req/heure");
console.log("   - Upload: 30 req/heure");

// ============================================================
// SECURITE JWT
// ============================================================

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("❌ ERREUR CRITIQUE : JWT_SECRET n'est pas configuré.");
  process.exit(1);
}

const authenticateToken = (req, res, next) => {
  const publicPaths = [
    "/login",
    "/verify-2fa", 
    "/gatekeeper",
    "/ingest-candidate",
    "/request-password-reset",
    "/reset-password",
  ];

  const isPublic = publicPaths.some((path) => req.path.includes(path));
  if (isPublic) return next();

  const authHeader = req.headers["authorization"];
  let token = authHeader && authHeader.split(" ")[1];
  if (!token && req.query.token) token = req.query.token;

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
// ROUTES
// ============================================================

app.use("/api", authenticateToken);
app.use("/api", upload.any());
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
app.use("/api", crmRoutes);

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
  -----------------------------------
  `);
});
