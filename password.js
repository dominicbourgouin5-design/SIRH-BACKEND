// ============================================================
// GESTION DES MOTS DE PASSE
// ------------------------------------------------------------
// Hachage bcrypt + migration transparente des comptes existants
// qui étaient stockés en clair.
// ============================================================

const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const SALT_ROUNDS = 12;

// Un hash bcrypt commence toujours par $2a$ / $2b$ / $2y$ et fait 60 caractères.
const BCRYPT_PATTERN = /^\$2[aby]\$\d{2}\$.{53}$/;

function isHashed(stored) {
  return typeof stored === "string" && BCRYPT_PATTERN.test(stored);
}

async function hashPassword(plain) {
  if (!plain || typeof plain !== "string") {
    throw new Error("Mot de passe invalide.");
  }
  return bcrypt.hash(plain, SALT_ROUNDS);
}

/**
 * Vérifie un mot de passe face à la valeur stockée en base.
 * Retourne { valid, needsUpgrade }.
 *
 * needsUpgrade = true signifie que le compte était encore en clair
 * (héritage de l'ancienne version) et doit être re-haché immédiatement.
 * Toujours exécuter une comparaison, même si l'utilisateur est inconnu,
 * pour ne pas révéler l'existence d'un compte via le temps de réponse.
 */
async function verifyPassword(plain, stored) {
  if (typeof plain !== "string" || plain.length === 0) {
    return { valid: false, needsUpgrade: false };
  }

  if (isHashed(stored)) {
    const valid = await bcrypt.compare(plain, stored);
    return { valid, needsUpgrade: false };
  }

  // --- Compte hérité, stocké en clair ---
  if (typeof stored === "string" && stored.length > 0) {
    const a = Buffer.from(plain);
    const b = Buffer.from(stored);
    const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
    return { valid, needsUpgrade: valid };
  }

  // Pas de mot de passe en base : on brûle quand même du temps CPU.
  await bcrypt.compare(plain, "$2a$12$" + "x".repeat(53));
  return { valid: false, needsUpgrade: false };
}

/**
 * Mot de passe temporaire lisible mais imprévisible (12 caractères).
 * Remplace les Math.random() utilisés à la création des comptes.
 */
function generateTempPassword(length = 12) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

/** Code numérique à 6 chiffres cryptographiquement sûr (OTP / 2FA). */
function generateOtpCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

/** Comparaison de codes OTP à temps constant. */
function safeCompareCode(a, b) {
  const bufA = Buffer.from(String(a || ""));
  const bufB = Buffer.from(String(b || ""));
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = {
  hashPassword,
  verifyPassword,
  isHashed,
  generateTempPassword,
  generateOtpCode,
  safeCompareCode,
};
