const cron = require('node-cron');
const supabase = require('./supabaseClient');
const pLimit = require('p-limit');
const limit = pLimit(5);
const { sendEmailAPI, sendPushNotification } = require('./utils');
const { runMonitoring } = require('./monitoring');


const startCronJobs = () => {
    // Le CRON tourne TOUTES LES HEURES (minute 0)
    cron.schedule('0 * * * *', async () => {
        console.log("⏰ [CRON] Vérification Intelligente des Shifts en cours...");
        const nowMs = Date.now();
        const today = new Date().toISOString().split('T')[0];

        try {
            // 1. On récupère tous les employés "En Poste"
            const { data: enPoste } = await supabase
                .from('employees')
                .select('id, nom, employee_type')
                .eq('statut', 'En Poste');

            if (!enPoste || enPoste.length === 0) {
                console.log("📡 [CRON] Aucun employé en poste.");
                return;
            }

            console.log(`📡 [CRON] ${enPoste.length} employé(s) en poste détecté(s)`);

            // 2. On récupère UNIQUEMENT le pointage d'ENTRÉE d'aujourd'hui
            const ids = enPoste.map(e => e.id);
            const { data: lastPointages } = await supabase
                .from('pointages')
                .select('employee_id, heure')
                .in('employee_id', ids)
                .eq('action', 'CLOCK_IN')
                .gte('heure', `${today}T00:00:00`)  // 🔥 CRUCIAL : seulement aujourd'hui
                .order('heure', { ascending: false });

            const tasks = enPoste.map(emp => limit(async () => {
                // 🔥 Trouver le pointage d'entrée d'aujourd'hui
                const sonPointage = lastPointages?.find(p => p.employee_id === emp.id);
                
                if (!sonPointage) {
                    console.log(`⚠️ ${emp.nom} est "En Poste" mais sans pointage d'entrée aujourd'hui. Correction automatique...`);
                    // Auto-correction : repasser le statut à "Actif"
                    await supabase.from('employees').update({ statut: 'Actif' }).eq('id', emp.id);
                    await supabase.from('logs').insert([{
                        agent: "Robot SIRH",
                        action: "CORRECTION STATUT",
                        details: `${emp.nom} était bloqué en "En Poste" sans pointage valide. Statut remis à "Actif".`
                    }]);
                    return;
                }

                const inTime = new Date(sonPointage.heure).getTime();
                const shiftDurationHours = (nowMs - inTime) / (1000 * 60 * 60);

                // 🔥 Vérification de cohérence : si plus de 24h, c'est une erreur
                if (shiftDurationHours > 24) {
                    console.log(`⚠️ ${emp.nom} a un shift de ${shiftDurationHours.toFixed(1)}h (>24h) - Correction forcée`);
                    await supabase.from('employees').update({ statut: 'Actif' }).eq('id', emp.id);
                    await supabase.from('logs').insert([{
                        agent: "Robot SIRH",
                        action: "CORRECTION STATUT",
                        details: `${emp.nom} avait un shift impossible de ${shiftDurationHours.toFixed(1)}h. Statut remis à "Actif".`
                    }]);
                    return;
                }

                // Vérifier si la journée est déjà clôturée (sécurité)
                const { data: existingOut } = await supabase
                    .from('pointages')
                    .select('id')
                    .eq('employee_id', emp.id)
                    .eq('is_final_out', true)
                    .gte('heure', `${today}T00:00:00`)
                    .maybeSingle();

                if (existingOut) {
                    console.log(`✅ ${emp.nom} - Journée déjà clôturée, ignoré.`);
                    return;
                }

                // --- ⚙️ CONFIGURATION DES RÈGLES PAR MÉTIER ---
                let maxDuration = 14;       // Limite max avant clôture auto
                let logicCloseAddHours = 9; // On ramène sa journée à 9h de travail sur sa paie
                let warnDuration = 12;      // Heure du Smart Ping (Alerte)

                if (emp.employee_type === 'FIXED' || emp.employee_type === 'SECURITY') {
                    maxDuration = 17;       // Les gardes peuvent faire 16h sans problème
                    logicCloseAddHours = 12;// Si on le ferme auto, on lui paie 12h max
                    warnDuration = 15;
                }

                console.log(`📊 ${emp.nom} - Shift: ${shiftDurationHours.toFixed(1)}h / Max: ${maxDuration}h`);

                // --- 🔔 SOLUTION : SMART PING (Alerte avant punition) ---
                if (shiftDurationHours >= warnDuration && shiftDurationHours < maxDuration) {
                    // On vérifie si on n'a pas déjà envoyé d'alerte récemment
                    const { data: recentAlert } = await supabase
                        .from('flash_messages')
                        .select('id')
                        .eq('sender', 'Robot SIRH')
                        .like('message', `%${emp.nom}%`)
                        .gte('created_at', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
                        .maybeSingle();

                    if (!recentAlert) {
                        await supabase.from('flash_messages').insert([{
                            message: `⚠️ ALERTE POINTAGE : ${emp.nom}, vous êtes en poste depuis plus de ${Math.floor(shiftDurationHours)} heures. Avez-vous oublié de pointer votre sortie ?`,
                            type: 'Urgent',
                            sender: 'Robot SIRH',
                            date_expiration: new Date(nowMs + (2 * 60 * 60 * 1000)).toISOString()
                        }]);
                        console.log(`🔔 Smart Ping envoyé à ${emp.nom}`);
                    }
                }

                // --- 🤖 AUTO-CLÔTURE INTELLIGENTE ---
                else if (shiftDurationHours >= maxDuration) {
                    
                    console.log(`🚨 ${emp.nom} - Dépassement du temps maximum (${shiftDurationHours.toFixed(1)}h/${maxDuration}h). Auto-clôture...`);
                    
                    // L'IA du système : On ne clôture pas à l'heure du CRON (sinon on paie 14h),
                    // on rétro-clôture à Heure d'Entrée + X heures logiques !
                    const logicalEndTime = new Date(inTime + (logicCloseAddHours * 60 * 60 * 1000));

                    // A. Enregistrement de la sortie rétroactive
                    await supabase.from('pointages').insert([{
                        employee_id: emp.id,
                        action: 'CLOCK_OUT',
                        heure: logicalEndTime.toISOString(),
                        is_final_out: true,
                        zone_detectee: "AUTO_CLOSURE",
                        statut: "Oubli - Ajusté Auto"
                    }]);

                    // B. Libération de l'agent
                    await supabase.from('employees').update({ statut: 'Actif' }).eq('id', emp.id);
                    
                    // C. Log de sécurité pour le RH
                    await supabase.from('logs').insert([{
                        agent: "Robot SIRH",
                        action: "PROTECTION PAIE",
                        details: `Clôture auto de ${emp.nom} après ${shiftDurationHours.toFixed(1)}h d'oubli. Shift ramené à ${logicCloseAddHours}h.`
                    }]);

                    console.log(`✅ Auto-clôture intelligente appliquée pour : ${emp.nom}`);
                }
            }));

            await Promise.all(tasks);
            console.log("✅ [CRON] Cycle terminé.");

        } catch (err) { 
            console.error("❌ Erreur critique Cron :", err); 
        }
    });
};

// Tâche quotidienne à 08:00 pour les contrats
cron.schedule('0 8 * * *', async () => {
    console.log("🤖 [ROBOT CONTRATS] Scan des échéances en cours...");

    try {
        const today = new Date();
        const in30Days = new Date(new Date().setDate(today.getDate() + 30)).toISOString().split('T')[0];
        const in7Days = new Date(new Date().setDate(today.getDate() + 7)).toISOString().split('T')[0];

        const { data: emps, error } = await supabase
            .from('employees')
            .select('id, nom, email, poste, date_fin_contrat, manager_id, user_associated_id')
            .in('date_fin_contrat', [in30Days, in7Days])
            .not('statut', 'ilike', '%Sortie%');

        if (error) throw error;

        if (!emps || emps.length === 0) {
            console.log("📡 [ROBOT CONTRATS] Aucune échéance à signaler.");
            return;
        }

        console.log(`📡 [ROBOT CONTRATS] ${emps.length} contrat(s) arrivant à échéance.`);

        for (const emp of emps) {
            const daysLeft = (emp.date_fin_contrat === in30Days) ? 30 : 7;

            const emailHtml = `
            <div style="font-family: sans-serif; color: #1e293b; max-width: 500px; margin: auto; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden;">
                <div style="background-color: #0f172a; padding: 25px; text-align: center;">
                    <img src="https://cdn-icons-png.flaticon.com/512/9752/9752284.png" style="width: 50px;">
                </div>
                <div style="padding: 30px;">
                    <h2 style="color: #0f172a;">Suivi de votre contrat</h2>
                    <p>Bonjour <b>${emp.nom}</b>,</p>
                    <p>Ce message automatique vous informe que votre contrat actuel arrive à échéance le <b>${new Date(emp.date_fin_contrat).toLocaleDateString('fr-FR')}</b> (dans ${daysLeft} jours).</p>
                    <p style="color: #64748b; font-size: 14px;">Le département RH et votre responsable ont été informés pour préparer la suite de votre collaboration.</p>
                </div>
            </div>`;
            
            await sendEmailAPI(emp.email, "Information relative à votre contrat", emailHtml);

            if (emp.manager_id) {
                const { data: manager } = await supabase
                    .from('employees')
                    .select('user_associated_id')
                    .eq('id', emp.manager_id)
                    .single();

                if (manager && manager.user_associated_id) {
                    const pushTitle = daysLeft === 30 ? "📋 Échéance Contrat" : "⚠️ URGENCE CONTRAT";
                    const pushBody = `${emp.nom} (${emp.poste}) arrive en fin de contrat dans ${daysLeft} jours. Veuillez statuer sur le renouvellement.`;
                    
                    await sendPushNotification(manager.user_associated_id, pushTitle, pushBody, "/#employees");
                }
            }
        }
        console.log(`✅ [ROBOT CONTRATS] Scan terminé. ${emps.length} alertes envoyées.`);
    } catch (err) {
        console.error("❌ [ROBOT CONTRATS] Erreur :", err.message);
    }
});


// Tâche de monitoring toutes les 5 minutes
cron.schedule('*/5 * * * *', async () => {
    console.log("📊 [MONITORING] Vérification périodique...");
    await runMonitoring();
});

module.exports = startCronJobs;
