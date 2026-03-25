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

// 2. CRÉER OU MODIFIER UN LEAD (Version Finale SaaS Premium avec Audit Log)
router.post("/save-lead", async (req, res) => {
    if (!checkPerm(req, "can_manage_crm")) return res.status(403).json({ error: "Accès refusé" });

    // On récupère agent_name envoyé par le front pour l'historique
    const { id, nom_client, status, assigned_to, agent_name, ...dynamicData } = req.body;

    try {
        let result;

        if (id) {
            // --- MODE MISE À JOUR (UPDATE) ---
            const { data: currentLead, error: fetchErr } = await supabase
                .from("crm_leads")
                .select("*")
                .eq("id", id)
                .single();

            if (fetchErr || !currentLead) return res.status(404).json({ error: "Lead introuvable" });

            // 1. Préparation du payload de base
            const payload = {
                nom_client: nom_client || currentLead.nom_client,
                status: status || currentLead.status,
                assigned_to: assigned_to !== undefined ? assigned_to : currentLead.assigned_to,
                data: { ...(currentLead.data || {}), ...dynamicData },
                updated_at: new Date()
            };

            // 2. 💥 LOGIQUE D'AUDIT : Si le statut a changé, on l'écrit dans l'historique
            if (status && status !== currentLead.status) {
                let history = currentLead.history || [];
                history.push({
                    date: new Date().toISOString(),
                    type: "NOTE",
                    content: `🔄 Statut modifié : ${currentLead.status} ➜ ${status}`,
                    author: agent_name || "Système"
                });
                payload.history = history;
            }

            result = await supabase.from("crm_leads").update(payload).eq("id", id);
        } else {
            // --- MODE CRÉATION (INSERT) ---
            const payload = {
                nom_client,
                status: status || 'Nouveau',
                assigned_to: assigned_to || null,
                data: dynamicData,
                history: [{
                    date: new Date().toISOString(),
                    type: "NOTE",
                    content: "🆕 Création du prospect dans le CRM",
                    author: agent_name || "Système"
                }],
                updated_at: new Date()
            };

            result = await supabase.from("crm_leads").insert([payload]);
        }

        if (result.error) throw result.error;
        return res.json({ status: "success" });

    } catch (err) {
        console.error("❌ Erreur save-lead:", err.message);
        return res.status(500).json({ error: err.message });
    }
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
        return res.status(403).json({ error: "Accès refusé." });
    }

    const { label, key_name, field_type, options } = req.body;

    // Si c'est un sélecteur, on s'assure que les options sont bien un tableau propre
    let finalOptions = null;
    if (field_type === 'select' && options) {
        finalOptions = Array.isArray(options) ? options : options.split(',').map(o => o.trim());
    }

    const { error } = await supabase.from("crm_fields").insert([{
        label,
        key_name: key_name.toLowerCase().replace(/\s+/g, '_'),
        field_type,
        options: finalOptions // 💥 Sauvegarde du tableau JSON
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



// UPLOAD DE FICHIER POUR UN LEAD CRM
router.post("/upload-lead-file", async (req, res) => {
    try {
        const { lead_id, agent_name } = req.body;
        const file = req.files[0]; // Multer récupère le fichier
        
        if (!file) return res.status(400).json({ error: "Aucun fichier reçu" });

        // 1. Envoi vers Supabase Storage
        const fileName = `crm/${lead_id}/${Date.now()}_${file.originalname.replace(/\s/g, '_')}`;
        const { data: upData, error: upErr } = await supabase.storage
            .from("documents")
            .upload(fileName, file.buffer, { contentType: file.mimetype });

        if (upErr) throw upErr;

        const { data: publicUrl } = supabase.storage.from("documents").getPublicUrl(fileName);

        // 2. Mise à jour de la colonne "data" du Lead pour inclure le fichier
        const { data: lead } = await supabase.from("crm_leads").select("data, history").eq("id", lead_id).single();
        
        let currentData = lead.data || {};
        if (!currentData.files) currentData.files = [];
        
        const fileObj = {
            name: file.originalname,
            url: publicUrl.publicUrl,
            date: new Date().toISOString(),
            size: (file.size / 1024).toFixed(1) + ' KB'
        };
        currentData.files.push(fileObj);

        // 3. On ajoute aussi une trace dans l'historique
        let history = lead.history || [];
        history.push({
            date: new Date().toISOString(),
            type: "NOTE",
            content: `📁 Fichier ajouté : ${file.originalname}`,
            author: agent_name
        });

        await supabase.from("crm_leads").update({ data: currentData, history: history }).eq("id", lead_id);

        return res.json({ status: "success", file: fileObj });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});


// 7. LIRE LES ÉTAPES (COLONNES) DU KANBAN
router.all("/stages", async (req, res) => {
    const { data, error } = await supabase
        .from("crm_stages")
        .select("*")
        .order("order_index", { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
});

// 8. CRÉER/MODIFIER UNE ÉTAPE (Admin)
router.post("/save-stage", async (req, res) => {
    if (!checkPerm(req, "can_manage_config")) return res.status(403).json({ error: "Interdit" });
    
    const { id, label, color, order_index } = req.body;
    const payload = { label, color, order_index };

    let result;
    if (id) result = await supabase.from("crm_stages").update(payload).eq("id", id);
    else result = await supabase.from("crm_stages").insert([payload]);

    if (result.error) return res.status(500).json({ error: result.error.message });
    return res.json({ status: "success" });
});

module.exports = router;
