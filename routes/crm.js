const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const { checkPerm } = require("../utils");

// 1. LIRE LES LEADS (Avec filtre de recherche dynamique)
router.all("/leads", async (req, res) => {
    if (!checkPerm(req, "can_see_crm")) return res.status(403).json({ error: "Accès refusé" });
    
    // On récupère tout, trié par date de modif
    const { data, error } = await supabase
        .from("crm_leads")
        .select("*")
        .order("updated_at", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
});

// 2. CRÉER OU MODIFIER UN LEAD (Moteur dynamique)
router.post("/save-lead", async (req, res) => {
    if (!checkPerm(req, "can_manage_crm")) return res.status(403).json({ error: "Accès refusé" });

    const { id, nom_client, status, assigned_to, ...dynamicData } = req.body;

    const payload = {
        nom_client,
        status,
        assigned_to,
        data: dynamicData, // Tout le reste tombe dans le JSONB dynamiquement
        updated_at: new Date()
    };

    let result;
    if (id) {
        result = await supabase.from("crm_leads").update(payload).eq("id", id);
    } else {
        result = await supabase.from("crm_leads").insert([payload]);
    }

    if (result.error) return res.status(500).json({ error: result.error.message });
    return res.json({ status: "success" });
});

// 3. AJOUTER UNE INTERACTION (Appel, Email, Notes...)
router.post("/add-interaction", async (req, res) => {
    const { lead_id, type, content, agent_name } = req.body;

    // Récupérer l'historique actuel
    const { data: lead } = await supabase.from("crm_leads").select("history").eq("id", lead_id).single();
    
    let history = lead.history || [];
    history.push({
        date: new Date().toISOString(),
        type: type, // "APPEL", "EMAIL", "NOTE"
        content: content,
        author: agent_name
    });

    const { error } = await supabase.from("crm_leads").update({ history: history }).eq("id", lead_id);
    
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ status: "success" });
});

// 4. SUPPRIMER UN LEAD (Passage en mode archivé ou suppression réelle)
router.post("/delete-lead", async (req, res) => {
    if (!checkPerm(req, "can_manage_crm")) return res.status(403).json({ error: "Accès refusé" });
    
    const { id } = req.body;
    const { error } = await supabase.from("crm_leads").delete().eq("id", id);
    
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ status: "success" });
});



// ============================================================
// GESTION DES CHAMPS DYNAMIQUES (LE NO-CODE BUILDER)
// ============================================================

// 5. LIRE LA CONFIGURATION DES CHAMPS
router.all("/crm-fields", async (req, res) => {
    const { data, error } = await supabase
        .from("crm_fields")
        .select("*")
        .order("created_at", { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
});

// 6. CRÉER UN NOUVEAU CHAMP (Admin uniquement)
router.post("/save-crm-field", async (req, res) => {
    if (!checkPerm(req, "can_manage_config")) {
        return res.status(403).json({ error: "Accès refusé. Seul un Admin peut modifier la structure." });
    }

    const { label, key_name, field_type } = req.body;

    const { error } = await supabase.from("crm_fields").insert([{
        label,
        key_name: key_name.toLowerCase().replace(/\s+/g, '_'), // Nettoie la clé pour le JSON
        field_type
    }]);

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ status: "success" });
});



// 5. ENVOYER UN EMAIL DIRECTEMENT DEPUIS LE CRM
router.post("/send-email", async (req, res) => {
    if (!checkPerm(req, "can_manage_crm")) return res.status(403).json({ error: "Accès refusé" });

    const { lead_id, to_email, subject, content, agent_name } = req.body;

    if (!to_email || !subject || !content) {
        return res.status(400).json({ error: "Veuillez remplir l'email, le sujet et le message." });
    }

    // 1. Envoi du mail via Brevo (Sendinblue)
    const htmlContent = `
        <div style="font-family: sans-serif; color: #1e293b; line-height: 1.6;">
            ${content.replace(/\n/g, '<br>')}
            <br><br><hr style="border:0; border-top:1px solid #e2e8f0;">
            <p style="font-size:11px; color:#64748b;">Envoyé par <b>${agent_name}</b> via SIRH SECURE</p>
        </div>
    `;
    
    // On utilise ta fonction utilitaire (déjà existante pour la 2FA)
    const { sendEmailAPI } = require("../utils");
    const mailSent = await sendEmailAPI(to_email, subject, htmlContent);

    if (!mailSent) return res.status(500).json({ error: "Erreur lors de la communication avec le serveur d'envoi." });

    // 2. Si le mail est parti, on l'ajoute à l'historique du client (Traçabilité absolue)
    const { data: lead } = await supabase.from("crm_leads").select("history").eq("id", lead_id).single();
    
    let history = lead.history ||[];
    history.push({
        date: new Date().toISOString(),
        type: "EMAIL",
        content: `📧 Sujet : ${subject}\n${content}`,
        author: agent_name
    });

    await supabase.from("crm_leads").update({ history: history }).eq("id", lead_id);
    
    return res.json({ status: "success" });
});

module.exports = router;
