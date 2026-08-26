const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const {
  checkPerm,
  LOCKED_PERMISSIONS,
  isTargetAuthorized,
  invalidateOverridesCache,
} = require("../utils");

// Permissions réellement en vigueur pour l'appelant. Le middleware
// applyPermissionOverrides a déjà fusionné ses dérogations dans
// req.user.permissions, il n'y a donc plus qu'à les renvoyer telles quelles.
// Permet au frontend de détecter un octroi ou une expiration sans attendre
// une reconnexion — voir le sondage périodique dans js/modules/ui.js.
router.get("/read-effective-permissions", async (req, res) => {
  return res.json(req.user.permissions || {});
});

// ============================================================
// RÈGLE D'AUTORITÉ COMMUNE
// ------------------------------------------------------------
// ADMIN : peut tout, sur tout le monde (y compris un autre ADMIN).
// RH : peut tout, sauf sur une cible ADMIN.
// MANAGER : limité à son équipe (hierarchy_path/management_scope, déjà
//           utilisés ailleurs dans le projet via isTargetAuthorized).
// Tout autre rôle : ne peut jamais gérer les accès d'autrui.
// ============================================================
async function canGrantTo(req, targetEmployeeId, permissionName) {
  if (LOCKED_PERMISSIONS.has(permissionName)) {
    return { ok: false, reason: "Cette permission est liée au rôle et ne peut pas être personnalisée." };
  }

  const requesterRole = req.user.role;

  if (requesterRole === "ADMIN") return { ok: true };

  const { data: target } = await supabase
    .from("employees")
    .select("id, role")
    .eq("id", targetEmployeeId)
    .maybeSingle();
  if (!target) return { ok: false, reason: "Employé introuvable." };

  if (requesterRole === "RH") {
    if (String(target.role).toUpperCase() === "ADMIN") {
      return { ok: false, reason: "Vous ne pouvez pas modifier les accès d'un administrateur." };
    }
    return { ok: true };
  }

  if (requesterRole === "MANAGER") {
    const { data: requesterEmp } = await supabase
      .from("employees")
      .select("hierarchy_path, management_scope")
      .eq("id", req.user.emp_id)
      .maybeSingle();

    const authorized = await isTargetAuthorized(
      {
        permissions: req.user.permissions,
        emp_id: req.user.emp_id,
        hierarchy_path: requesterEmp?.hierarchy_path,
        management_scope: requesterEmp?.management_scope,
      },
      targetEmployeeId,
    );
    if (!authorized) {
      return { ok: false, reason: "Cet employé n'est pas sous votre supervision." };
    }
    return { ok: true };
  }

  return { ok: false, reason: "Vous n'avez pas le droit de gérer les accès d'autrui." };
}

// Anti-escalade : on ne peut accorder (ADD) que ce qu'on possède déjà
// soi-même. Ne s'applique pas au retrait (REMOVE) — retirer un droit à
// quelqu'un ne peut pas être une escalade de privilège. ADMIN passe outre.
function canSelfGrant(req, permissionName, mode) {
  if (mode !== "ADD" || req.user.role === "ADMIN") return true;
  // req.user.permissions inclut déjà les dérogations du granteur : quelqu'un
  // qui tient un droit d'une dérogation peut donc le déléguer, ce qui est
  // cohérent avec le fait qu'il l'exerce réellement.
  return checkPerm(req, permissionName);
}

router.post("/grant-permission-override", async (req, res) => {
  if (!checkPerm(req, "can_manage_employee_access")) {
    return res.status(403).json({ error: "Accès refusé à la gestion des accès." });
  }

  const { employee_id, permission_name, mode, expires_at } = req.body;
  if (!employee_id || !permission_name || !["ADD", "REMOVE"].includes(mode)) {
    return res.status(400).json({ error: "Paramètres invalides." });
  }

  const grantCheck = await canGrantTo(req, employee_id, permission_name);
  if (!grantCheck.ok) return res.status(403).json({ error: grantCheck.reason });

  if (!canSelfGrant(req, permission_name, mode)) {
    return res.status(403).json({ error: "Vous ne pouvez pas accorder une permission que vous ne possédez pas vous-même." });
  }

  try {
    // Une seule dérogation ACTIVE par (employé, permission) : on révoque
    // l'ancienne avant d'insérer la nouvelle, jamais d'update silencieux —
    // l'historique complet reste dans la table.
    await supabase.from("permission_overrides")
      .update({ status: "REVOKED", revoked_by: req.user.emp_id, revoked_at: new Date().toISOString() })
      .eq("employee_id", employee_id)
      .eq("permission_name", permission_name)
      .eq("status", "ACTIVE");

    const { data, error } = await supabase.from("permission_overrides").insert([{
      employee_id,
      permission_name,
      mode,
      granted_by: req.user.emp_id,
      expires_at: expires_at || null,
      reason: req.body.reason || null,
    }]).select();

    if (error) throw error;

    invalidateOverridesCache(employee_id);

    await supabase.from("logs").insert([{
      agent: `Employé #${req.user.emp_id}`,
      action: "OCTROI DEROGATION",
      details: `${mode === "ADD" ? "Ajout" : "Retrait"} de "${permission_name}" pour l'employé #${employee_id}${expires_at ? ` jusqu'au ${expires_at}` : " (permanent)"}.`,
    }]);

    return res.json({ status: "success", data: data[0] });
  } catch (err) {
    console.error("Erreur grant-permission-override:", err.message);
    return res.status(500).json({ error: "Impossible d'accorder cet accès." });
  }
});

router.post("/extend-permission-override", async (req, res) => {
  if (!checkPerm(req, "can_manage_employee_access")) {
    return res.status(403).json({ error: "Accès refusé à la gestion des accès." });
  }

  const { id, new_expires_at } = req.body;
  if (!id || !new_expires_at) {
    return res.status(400).json({ error: "Paramètres invalides." });
  }

  const { data: existing } = await supabase.from("permission_overrides").select("*").eq("id", id).maybeSingle();
  if (!existing) return res.status(404).json({ error: "Dérogation introuvable." });

  const grantCheck = await canGrantTo(req, existing.employee_id, existing.permission_name);
  if (!grantCheck.ok) return res.status(403).json({ error: grantCheck.reason });

  try {
    // Fonctionne même si déjà expirée : la prolongation la réactive.
    const { data, error } = await supabase.from("permission_overrides")
      .update({ expires_at: new_expires_at, status: "ACTIVE", updated_at: new Date().toISOString() })
      .eq("id", id)
      .select();
    if (error) throw error;

    invalidateOverridesCache(existing.employee_id);

    await supabase.from("logs").insert([{
      agent: `Employé #${req.user.emp_id}`,
      action: "PROLONGATION DEROGATION",
      details: `Dérogation "${existing.permission_name}" (employé #${existing.employee_id}) prolongée jusqu'au ${new_expires_at}.`,
    }]);

    return res.json({ status: "success", data: data[0] });
  } catch (err) {
    console.error("Erreur extend-permission-override:", err.message);
    return res.status(500).json({ error: "Impossible de prolonger cet accès." });
  }
});

router.post("/convert-permission-override", async (req, res) => {
  if (!checkPerm(req, "can_manage_employee_access")) {
    return res.status(403).json({ error: "Accès refusé à la gestion des accès." });
  }

  const { id } = req.body;
  if (!id) return res.status(400).json({ error: "Paramètres invalides." });

  const { data: existing } = await supabase.from("permission_overrides").select("*").eq("id", id).maybeSingle();
  if (!existing) return res.status(404).json({ error: "Dérogation introuvable." });

  const grantCheck = await canGrantTo(req, existing.employee_id, existing.permission_name);
  if (!grantCheck.ok) return res.status(403).json({ error: grantCheck.reason });

  try {
    const { data, error } = await supabase.from("permission_overrides")
      .update({ expires_at: null, status: "ACTIVE", updated_at: new Date().toISOString() })
      .eq("id", id)
      .select();
    if (error) throw error;

    invalidateOverridesCache(existing.employee_id);

    await supabase.from("logs").insert([{
      agent: `Employé #${req.user.emp_id}`,
      action: "CONVERSION PERMANENTE",
      details: `Dérogation "${existing.permission_name}" (employé #${existing.employee_id}) rendue permanente.`,
    }]);

    return res.json({ status: "success", data: data[0] });
  } catch (err) {
    console.error("Erreur convert-permission-override:", err.message);
    return res.status(500).json({ error: "Impossible de rendre cet accès permanent." });
  }
});

router.post("/revoke-permission-override", async (req, res) => {
  if (!checkPerm(req, "can_manage_employee_access")) {
    return res.status(403).json({ error: "Accès refusé à la gestion des accès." });
  }

  const { id } = req.body;
  if (!id) return res.status(400).json({ error: "Paramètres invalides." });

  const { data: existing } = await supabase.from("permission_overrides").select("*").eq("id", id).maybeSingle();
  if (!existing) return res.status(404).json({ error: "Dérogation introuvable." });

  const grantCheck = await canGrantTo(req, existing.employee_id, existing.permission_name);
  if (!grantCheck.ok) return res.status(403).json({ error: grantCheck.reason });

  try {
    const { data, error } = await supabase.from("permission_overrides")
      .update({ status: "REVOKED", revoked_by: req.user.emp_id, revoked_at: new Date().toISOString() })
      .eq("id", id)
      .select();
    if (error) throw error;

    invalidateOverridesCache(existing.employee_id);

    await supabase.from("logs").insert([{
      agent: `Employé #${req.user.emp_id}`,
      action: "REVOCATION DEROGATION",
      details: `Dérogation "${existing.permission_name}" (employé #${existing.employee_id}) révoquée manuellement.`,
    }]);

    return res.json({ status: "success", data: data[0] });
  } catch (err) {
    console.error("Erreur revoke-permission-override:", err.message);
    return res.status(500).json({ error: "Impossible de révoquer cet accès." });
  }
});

// Permissions par défaut d'un rôle (colonnes can_xxx de role_permissions),
// utilisées côté frontend pour construire la liste de cases à cocher de la
// section "Accès personnalisés" — la base à partir de laquelle un ADD/REMOVE
// se distingue visuellement.
router.get("/read-role-permissions", async (req, res) => {
  if (!checkPerm(req, "can_manage_employee_access")) {
    return res.status(403).json({ error: "Accès refusé." });
  }

  const { role } = req.query;
  if (!role) return res.status(400).json({ error: "role manquant." });

  const { data, error } = await supabase
    .from("role_permissions")
    .select("*")
    .eq("role_name", role)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Rôle introuvable." });

  // Ne garder que les colonnes can_xxx : role_name et les éventuelles
  // colonnes techniques ne sont pas des permissions. `locked` vient de
  // LOCKED_PERMISSIONS (source unique côté backend) pour que le frontend
  // affiche ces cases en lecture seule sans dupliquer la liste.
  const permissions = {};
  Object.keys(data).forEach((key) => {
    if (key.startsWith("can_")) {
      permissions[key] = { default: data[key], locked: LOCKED_PERMISSIONS.has(key) };
    }
  });

  return res.json({ role_name: data.role_name, permissions });
});

router.get("/read-permission-overrides", async (req, res) => {
  const { employee_id } = req.query;
  if (!employee_id) return res.status(400).json({ error: "employee_id manquant." });

  // L'employé peut voir ses propres dérogations actives (transparence) ;
  // sinon il faut le droit de gérer les accès d'autrui, avec le même
  // périmètre que pour accorder (RH sauf ADMIN, MANAGER sur son équipe).
  const isSelf = String(employee_id) === String(req.user.emp_id);
  if (!isSelf) {
    if (!checkPerm(req, "can_manage_employee_access")) {
      return res.status(403).json({ error: "Accès refusé." });
    }
    const { data: target } = await supabase.from("employees").select("role").eq("id", employee_id).maybeSingle();
    if (!target) return res.status(404).json({ error: "Employé introuvable." });

    if (req.user.role === "RH" && String(target.role).toUpperCase() === "ADMIN") {
      return res.status(403).json({ error: "Vous ne pouvez pas voir les accès d'un administrateur." });
    }
    if (req.user.role === "MANAGER") {
      const { data: requesterEmp } = await supabase.from("employees")
        .select("hierarchy_path, management_scope").eq("id", req.user.emp_id).maybeSingle();
      const authorized = await isTargetAuthorized(
        { permissions: req.user.permissions, emp_id: req.user.emp_id, hierarchy_path: requesterEmp?.hierarchy_path, management_scope: requesterEmp?.management_scope },
        employee_id,
      );
      if (!authorized) return res.status(403).json({ error: "Cet employé n'est pas sous votre supervision." });
    }
    if (!["ADMIN", "RH", "MANAGER"].includes(req.user.role)) {
      return res.status(403).json({ error: "Accès refusé." });
    }
  }

  const includeHistory = req.query.include_history === "true" && ["ADMIN", "RH"].includes(req.user.role);
  let query = supabase.from("permission_overrides").select("*").eq("employee_id", employee_id);
  query = includeHistory ? query.order("created_at", { ascending: false }) : query.eq("status", "ACTIVE");

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

module.exports = router;
