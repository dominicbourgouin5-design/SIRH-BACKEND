const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const supabase = require("../supabaseClient");
const { sendEmailAPI } = require("../utils");
const { isValidEmail, sanitizeString } = require('../validation');

const JWT_SECRET = process.env.JWT_SECRET;

// 1. LOGIN AVEC 2FA CONDITIONNEL
router.all("/login", async (req, res) => {
  try {
    const username = (req.body.u || req.query.u || "").toLowerCase().trim();
    const password = req.body.p || req.query.p || "";

    // Validation des entrées
    if (!username || !password) {
      return res.status(400).json({ status: "error", message: "Identifiant et mot de passe requis" });
    }

    if (!isValidEmail(username)) {
      return res.status(400).json({ status: "error", message: "Format d'email invalide" });
    }

    const { data: user, error } = await supabase
      .from("app_users")
      .select("id, email, password, nom_complet, employees(id, role, statut, photo_url, employee_type)")
      .eq("email", username)
      .single();

    if (error || !user || user.password !== password) {
      return res.json({ status: "error", message: "Identifiants incorrects" });
    }

    const emp = user.employees && user.employees.length > 0 ? user.employees[0] : null;
    const userRole = emp ? (emp.role || "EMPLOYEE").toUpperCase() : "EMPLOYEE";

    // Sécurité : blocage des sorties
    if (emp && emp.statut && emp.statut.toLowerCase().includes("sortie")) {
      return res.json({ status: "revoked", message: "Accès révoqué. Contactez la direction." });
    }

    // Logique 2FA pour ADMIN & RH
    if (userRole === "ADMIN" || userRole === "RH") {
      const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
      const expires = new Date(Date.now() + 10 * 60000).toISOString();

      await supabase.from("app_users")
        .update({ reset_code: otpCode, reset_expires: expires })
        .eq("id", user.id);

      const emailHtml = `
      <div style="font-family: sans-serif; color: #1e293b; max-width: 500px; margin: auto; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden;">
          <div style="background-color: #0f172a; padding: 20px; text-align: center;">
              <img src="https://cdn-icons-png.flaticon.com/512/9752/9752284.png" style="width: 50px; height: 50px;">
              <p style="color: #ffffff; margin: 5px 0 0 0; font-size: 14px; font-weight: bold; letter-spacing: 1px;">SÉCURITÉ SIRH</p>
          </div>
          <div style="padding: 30px; text-align: center;">
              <h2 style="margin-top: 0;">Code de vérification</h2>
              <p>Bonjour <b>${sanitizeString(user.nom_complet)}</b>,</p>
              <p>Vous avez demandé la réinitialisation de votre mot de passe. Voici votre code sécurisé :</p>
              <div style="background: #f1f5f9; padding: 20px; margin: 25px 0; font-size: 32px; font-weight: 900; letter-spacing: 10px; color: #2563eb; border-radius: 12px; border: 2px dashed #cbd5e1;">
                  ${otpCode}
              </div>
              <p style="font-size: 12px; color: #94a3b8;">Ce code expirera dans 10 minutes.<br>Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>
          </div>
      </div>`;

      await sendEmailAPI(user.email, "Votre code de sécurité SIRH", emailHtml);
      return res.json({ status: "require_2fa", email: user.email });
    }

    // Pour les autres (employé simple) : génération JWT directe
    const { data: perms } = await supabase
      .from("role_permissions")
      .select("*")
      .eq("role_name", userRole)
      .single();

    const token = jwt.sign({ 
      id: user.id, 
      emp_id: emp ? emp.id : null, 
      role: userRole, 
      permissions: perms || {} 
    }, JWT_SECRET, { expiresIn: "8h" });

    return res.json({
      status: "success",
      token: token,
      id: emp ? emp.id : null,
      nom: user.nom_complet,
      role: userRole,
      employee_type: emp ? emp.employee_type : "OFFICE",
      permissions: perms || {}
    });

  } catch (err) {
    console.error("Login Crash:", err);
    return res.status(500).json({ error: "Erreur serveur interne" });
  }
});

// ============================================================
// 2. VÉRIFICATION 2FA
// ============================================================
router.post("/verify-2fa", async (req, res) => {
  try {
    const email = String(req.body.u || "").toLowerCase().trim();
    const codeSaisi = String(req.body.code || "").trim();

    console.log(`\n=================================================`);
    console.log(`[2FA] 🔐 DÉBUT DE LA VÉRIFICATION POUR : ${email}`);
    console.log(`=================================================`);

    // Validation des entrées
    if (!email || !codeSaisi) {
      console.error(`[2FA-FAIL] ❌ Raison : Email ou code manquant.`);
      return res.status(400).json({ status: "error", message: "L'email ou le code n'a pas été envoyé." });
    }

    if (!isValidEmail(email)) {
      console.error(`[2FA-FAIL] ❌ Raison : Email invalide.`);
      return res.status(400).json({ status: "error", message: "Format d'email invalide." });
    }

    // Recherche de l'utilisateur
    const { data: user, error } = await supabase
      .from("app_users")
      .select("id, email, reset_code, reset_expires, nom_complet, employees(id, role, photo_url, employee_type)")
      .eq("email", email)
      .single();

    if (error || !user) {
      console.error(`[2FA-FAIL] ❌ Utilisateur introuvable.`);
      return res.status(401).json({ status: "error", message: "Ce compte n'existe pas ou est introuvable." });
    }

    // Vérification du code
    if (!user.reset_code) {
      console.error(`[2FA-FAIL] ❌ Aucun code actif.`);
      return res.status(401).json({ status: "error", message: "Aucun code actif. Veuillez vous reconnecter." });
    }

    const codeEnBase = String(user.reset_code).trim();
    console.log(`[2FA-CHECK] Code tapé: "${codeSaisi}"`);
    console.log(`[2FA-CHECK] Code base: "${codeEnBase}"`);
    
    if (codeSaisi !== codeEnBase) {
      console.error(`[2FA-FAIL] ❌ Codes non identiques.`);
      return res.status(401).json({ status: "error", message: "Le code à 6 chiffres est incorrect." });
    }

    // Vérification temporelle
    const maintenantMS = Date.now();
    const expirationMS = new Date(user.reset_expires).getTime();
    const margeErreurMS = 5 * 60 * 1000;

    console.log(`[2FA-TIME] Serveur: ${new Date().toISOString()} (${maintenantMS})`);
    console.log(`[2FA-TIME] Expiration: ${user.reset_expires} (${expirationMS})`);
    
    if (maintenantMS > (expirationMS + margeErreurMS)) {
      const depassementMins = Math.round((maintenantMS - expirationMS) / 60000);
      console.error(`[2FA-FAIL] ⏰ Code expiré depuis ${depassementMins} minutes.`);
      return res.status(401).json({ status: "error", message: "Le temps est écoulé. Ce code a expiré." });
    }

    // Vérification du profil employé
    const emp = Array.isArray(user.employees) ? user.employees[0] : user.employees;
    if (!emp) {
      console.error(`[2FA-FAIL] ❌ Aucune fiche employé.`);
      return res.status(401).json({ status: "error", message: "Votre compte n'est relié à aucune fiche collaborateur." });
    }

    // Tout est valide
    console.log(`[2FA-SUCCESS] ✅ Génération du Token.`);
    
    const userRole = (emp.role || "EMPLOYEE").toUpperCase();
    const { data: perms } = await supabase
      .from("role_permissions")
      .select("*")
      .eq("role_name", userRole)
      .single();

    // Destruction du code en base
    await supabase
      .from("app_users")
      .update({ reset_code: null, reset_expires: null })
      .eq("id", user.id);

    const token = jwt.sign({
      id: user.id,
      emp_id: emp.id,
      role: userRole,
      permissions: perms || {}
    }, JWT_SECRET, { expiresIn: "12h" });

    return res.json({
      status: "success",
      token,
      id: emp.id,
      nom: user.nom_complet,
      role: userRole,
      employee_type: emp.employee_type || "OFFICE",
      permissions: perms || {}
    });

  } catch (err) {
    console.error(`[2FA-CRASH] 💥 Erreur fatale:`, err);
    return res.status(500).json({ status: "error", message: "Erreur interne du serveur." });
  }
});

// ============================================================
// 3. DEMANDER UN CODE (MOT DE PASSE OUBLIÉ)
// ============================================================
router.all("/request-password-reset", async (req, res) => {
  const email = req.body.email ? req.body.email.toLowerCase().trim() : "";

  // Validation
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ status: "error", message: "Email invalide." });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expires = new Date(Date.now() + 15 * 60000).toISOString();

  const { data: user, error } = await supabase
    .from("app_users")
    .update({ reset_code: code, reset_expires: expires })
    .eq("email", email)
    .select("nom_complet")
    .maybeSingle();

  if (user) {
    const html = `
    <div style="font-family: sans-serif; color: #1e293b; max-width: 500px; margin: auto; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden;">
        <div style="background-color: #0f172a; padding: 20px; text-align: center;">
            <img src="https://cdn-icons-png.flaticon.com/512/9752/9752284.png" style="width: 50px; height: 50px;">
            <p style="color: #ffffff; margin: 5px 0 0 0; font-size: 14px; font-weight: bold; letter-spacing: 1px;">SÉCURITÉ SIRH</p>
        </div>
        <div style="padding: 30px; text-align: center;">
            <h2 style="margin-top: 0;">Code de vérification</h2>
            <p>Bonjour <b>${sanitizeString(user.nom_complet)}</b>,</p>
            <p>Vous avez demandé la réinitialisation de votre mot de passe. Voici votre code sécurisé :</p>
            <div style="background: #f1f5f9; padding: 20px; margin: 25px 0; font-size: 32px; font-weight: 900; letter-spacing: 10px; color: #2563eb; border-radius: 12px; border: 2px dashed #cbd5e1;">
                ${code}
            </div>
            <p style="font-size: 12px; color: #94a3b8;">Ce code expirera dans 15 minutes.<br>Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>
        </div>
    </div>`;
    await sendEmailAPI(email, "Code de sécurité SIRH", html);
  }

  return res.json({ status: "success", message: "Procédure lancée." });
});

// ============================================================
// 4. VALIDER LE CHANGEMENT DE MOT DE PASSE
// ============================================================
router.all("/reset-password", async (req, res) => {
  const { email, code, newPassword } = req.body;
  const cleanEmail = (email || "").toLowerCase().trim();

  // Validation
  if (!cleanEmail || !isValidEmail(cleanEmail)) {
    return res.status(400).json({ error: "Email invalide." });
  }

  if (!code || code.length !== 6) {
    return res.status(400).json({ error: "Code invalide." });
  }

  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: "Le mot de passe doit contenir au moins 6 caractères." });
  }

  const { data: user, error } = await supabase
    .from("app_users")
    .select("id")
    .eq("email", cleanEmail)
    .eq("reset_code", code)
    .gt("reset_expires", new Date().toISOString())
    .maybeSingle();

  if (!user) {
    return res.status(400).json({ error: "Code invalide ou expiré." });
  }

  await supabase
    .from("app_users")
    .update({
      password: newPassword,
      reset_code: null,
      reset_expires: null,
    })
    .eq("id", user.id);

  await supabase.from("logs").insert([{
    agent: "Système",
    action: "SÉCURITÉ",
    details: `Mot de passe réinitialisé pour : ${cleanEmail}`,
  }]);

  return res.json({ status: "success" });
});

module.exports = router;
