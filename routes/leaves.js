const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const { checkPerm, sendEmailAPI, sendPushNotification } = require("../utils"); 

// ============================================================
// 6. MODULE DES CONGÉS
// ============================================================

// A. Demande de congé par l'employé
router.all("/leave", async (req, res) => {
  // Helper de nettoyage
  const getVal = (val) => Array.isArray(val) ? val[0] : val;

  const b = req.body;
  const empId = getVal(b.employee_id);
  const type = getVal(b.type);
  const dateDebut = getVal(b.date_debut);
  const dateFin = getVal(b.date_fin);
  const motif = getVal(b.motif);
  const nom = getVal(b.nom);

  console.log(`📥 RECU CONGÉ - ID: ${empId}, Nom: ${nom}, Type: ${type}`);

  if (!empId || empId === "undefined") {
    console.error("❌ Erreur : employee_id est manquant", b);
    return res.status(400).json({ error: "Identifiant employé manquant." });
  }

  let justifUrl = null;

  try {
    const justifFile = (req.files && Array.isArray(req.files)) 
      ? req.files.find((f) => f.fieldname === "justificatif") 
      : null;

    if (justifFile) {
      const safeName = `${Date.now()}_${justifFile.originalname.replace(/[^a-z0-9.]/gi, '_')}`;
      
      const { error: upErr } = await supabase.storage
        .from("documents")
        .upload(safeName, justifFile.buffer, {
          contentType: justifFile.mimetype,
          upsert: true
        });
      
      if (upErr) throw upErr;

      const { data: publicUrlData } = supabase.storage
        .from("documents")
        .getPublicUrl(safeName);
      
      justifUrl = publicUrlData.publicUrl;
      console.log("📎 Fichier uploadé :", justifUrl);
    }

    const { error: dbErr } = await supabase.from("conges").insert([
      {
        employee_id: empId,
        type: type,
        date_debut: dateDebut,
        date_fin: dateFin,
        motif: motif,
        employees_nom: nom,
        justificatif_url: justifUrl,
        statut: "En attente",
      },
    ]);

    if (dbErr) throw dbErr;

    console.log("✅ Congé enregistré avec succès.");
    return res.json({ status: "success" });

  } catch (err) {
    console.error("💥 Erreur demande congé :", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// B. LECTURE DES CONGÉS
// ============================================================
router.all("/read-leaves", async (req, res) => {
  let query = supabase
    .from("conges")
    .select("*, employees(solde_conges)")
    .order("created_at", { ascending: false });

  if (req.user.permissions && req.user.permissions.can_see_employees) {
    // RH voit tout
  } else {
    query = query.eq("employee_id", req.user.emp_id);
  }

  const { data, error } = await query;
  if (error) throw error;

  const mapped = data.map((l) => ({
    id: l.id,
    record_id: l.id,
    employee_id: l.employee_id,
    Employees_nom: l.employees_nom || "Inconnu",
    Statut: l.statut,
    Type: l.type || "Congé",
    "Date Début": l.date_debut,
    "Date Fin": l.date_fin,
    motif: l.motif,
    justificatif_link: l.justificatif_url,
    solde_actuel: l.employees
      ? Array.isArray(l.employees)
        ? l.employees[0].solde_conges
        : l.employees.solde_conges
      : 0,
  }));
  
  return res.json(mapped);
});

// ============================================================
// C. ACTION SUR UN CONGÉ (VALIDATION AVEC PUSH + EMAIL)
// ============================================================
router.all("/leave-action", async (req, res) => {
  if (!req.user.permissions || !req.user.permissions.can_see_employees) {
    return res.status(403).json({ error: "Accès refusé à la gestion des congés" });
  }

  const { id, decision, agent } = req.body;
  console.log(`⚖️ Décision RH : ${decision} pour le congé ID ${id}`);

  // 1. Récupérer les détails
  const { data: conge, error: congeErr } = await supabase
    .from("conges")
    .select("*, employees(*)")
    .eq("id", id)
    .single();

  if (congeErr || !conge) return res.status(404).json({ error: "Congé introuvable" });

  if (conge.statut === decision) {
    return res.json({ status: "success", message: "Déjà traité" });
  }

  const employe = Array.isArray(conge.employees) ? conge.employees[0] : conge.employees;
  if (!employe) return res.status(404).json({ error: "Employé lié introuvable" });

  const typeConge = conge.type;

  // 2. Calcul des jours ouvrés
  const debut = new Date(conge.date_debut);
  const fin = new Date(conge.date_fin);
  let nbJours = 0;
  let loopDate = new Date(debut);

  while (loopDate <= fin) {
    const dayOfWeek = loopDate.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) { nbJours++; }
    loopDate.setDate(loopDate.getDate() + 1);
  }

  // 3. Mise à jour du statut
  const { error: updateErr } = await supabase
    .from("conges")
    .update({ statut: decision })
    .eq("id", id);

  if (updateErr) throw updateErr;

  // 4. Mise à jour de l'employé
  if (decision === "Validé") {
    let updates = { statut: "Congé" };
    if (typeConge === "Congé Payé" || typeConge === "Maladie") {
      const soldeActuel = parseFloat(employe.solde_conges) || 0;
      updates.solde_conges = soldeActuel - nbJours;
    }
    await supabase.from("employees").update(updates).eq("id", employe.id);
  } else if (decision === "Refusé") {
    await supabase.from("employees").update({ statut: "Actif" }).eq("id", employe.id);
  }

  // 5. Notification PUSH (déjà existante)
  if (employe.user_associated_id) {
    const pushTitle = decision === "Validé" ? "✅ Congé Approuvé !" : "❌ Mise à jour Congé";
    const pushBody = decision === "Validé" 
      ? `Bonne nouvelle ${employe.nom}, votre demande pour ${typeConge} (${nbJours}j) a été validée.`
      : `Désolé ${employe.nom}, votre demande pour ${typeConge} n'a pas été acceptée.`;
    
    sendPushNotification(employe.user_associated_id, pushTitle, pushBody, "/#my-profile");
  }

  // 6. Email
  if (employe.email) {
    const statusColor = decision === "Validé" ? "#10b981" : "#ef4444";
    const statusIcon = decision === "Validé" ? "https://cdn-icons-png.flaticon.com/128/179/179365.png" : "https://cdn-icons-png.flaticon.com/128/1828/1828843.png";
    const emailSubject = `${decision === "Validé" ? "✅ Approbation" : "❌ Mise à jour"} de votre demande de congé - SIRH SECURE`;

    const emailHtml = `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1e293b; max-width: 600px; margin: auto; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
        <div style="background-color: #0f172a; padding: 30px; text-align: center;">
            <img src="https://cdn-icons-png.flaticon.com/512/9752/9752284.png" style="width: 60px; height: 60px; margin-bottom: 10px;">
            <h1 style="color: #ffffff; margin: 0; font-size: 18px; letter-spacing: 2px; text-transform: uppercase;">SIRH SECURE</h1>
        </div>
        <div style="padding: 40px; background-color: #ffffff;">
            <div style="text-align: center; margin-bottom: 30px;">
                <img src="${statusIcon}" style="width: 48px; height: 48px; margin-bottom: 15px;">
                <h2 style="color: ${statusColor}; margin: 0; font-size: 22px;">Demande ${decision}</h2>
                <p style="color: #64748b; margin-top: 5px;">Référence : #CONG-${id.toString().substring(0,5)}</p>
            </div>
            <p style="font-size: 16px; line-height: 1.6;">Bonjour <strong>${employe.nom}</strong>,</p>
            <p style="font-size: 15px; line-height: 1.6; color: #475569;">Votre demande de <strong>${typeConge}</strong> a été traitée par le service RH.</p>
            <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin: 30px 0; border-left: 5px solid ${statusColor};">
                <table style="width: 100%; border-collapse: collapse;">
                    <tr><td style="padding: 5px 0; color: #64748b;">Période</td><td style="padding: 5px 0; font-weight: bold; text-align: right;">Du ${new Date(conge.date_debut).toLocaleDateString('fr-FR')} au ${new Date(conge.date_fin).toLocaleDateString('fr-FR')}</td></tr>
                    <tr><td style="padding: 5px 0; color: #64748b;">Durée</td><td style="padding: 5px 0; font-weight: bold; text-align: right;">${nbJours} jours ouvrés</td></tr>
                    <tr><td style="padding: 15px 0 5px 0; color: #64748b;">Statut Final</td><td style="padding: 15px 0 5px 0; font-weight: 900; text-align: right; color: ${statusColor};">${decision.toUpperCase()}</td></tr>
                </table>
            </div>
            <p style="font-size: 14px; color: #64748b; text-align: center;">Consultez votre nouveau solde sur votre espace personnel.</p>
            <div style="text-align: center; margin-top: 20px;">
                <a href="https://sirh.cataria-systems.com" style="background-color: #0f172a; color: #ffffff; padding: 12px 25px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 14px;">Accéder à mon compte</a>
            </div>
        </div>
        <div style="background-color: #f1f5f9; padding: 20px; text-align: center; font-size: 11px; color: #94a3b8;">
            Message automatique. Agent traitant : ${agent || "Service RH"}
        </div>
    </div>`;

    try {
      await sendEmailAPI(employe.email, emailSubject, emailHtml);
    } catch (mErr) {
      console.error("❌ Erreur envoi mail:", mErr.message);
    }
  }

  // 7. Log d'audit
  await supabase.from("logs").insert([{
    agent: agent || "Système",
    action: "DÉCISION_CONGÉ",
    details: `${decision} pour ${employe.nom} (${nbJours}j ouvrés)`
  }]);

  return res.json({ status: "success", message: `Demande ${decision.toLowerCase()} (${nbJours}j déduits)` });
});

// ============================================================
// D. VÉRIFICATION DES RETOURS DE CONGÉ
// ============================================================
router.all("/check-returns", async (req, res) => {
  if (!req.user.permissions || !req.user.permissions.can_send_announcements) {
    return res.status(403).json({ error: "Accès refusé au robot de surveillance" });
  }

  const now = new Date();
  const todayStr = now.toISOString().split("T")[0];
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];

  const { data: retoursAttendus } = await supabase
    .from("conges")
    .select("employee_id, employees_nom, date_fin")
    .eq("statut", "Validé")
    .eq("date_fin", yesterdayStr);

  if (retoursAttendus && retoursAttendus.length > 0) {
    const alertes = [];
    for (const retour of retoursAttendus) {
      const { data: pointageToday } = await supabase
        .from("pointages")
        .select("id")
        .eq("employee_id", retour.employee_id)
        .gte("heure", `${todayStr}T00:00:00`)
        .limit(1);

      if (!pointageToday || pointageToday.length === 0) {
        const { data: exist } = await supabase
          .from("flash_messages")
          .select("id")
          .ilike("message", `%${retour.employees_nom}%`)
          .gte("created_at", `${todayStr}T00:00:00`);

        if (!exist || exist.length === 0) {
          await supabase.from("flash_messages").insert([
            {
              message: `ALERTE RETOUR : ${retour.employees_nom} absent au poste après congés.`,
              type: "Urgent",
              sender: "Robot SIRH",
              date_expiration: new Date(now.getTime() + 7200000).toISOString(),
            },
          ]);
        }
        alertes.push({ message: `Alerte générée pour ${retour.employees_nom}` });
      }
    }
    return res.json({ status: "checked", alerts: alertes });
  }
  return res.json({ status: "success", message: "Rien à signaler" });
});

module.exports = router;
