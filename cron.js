const cron = require('node-cron');
const supabase = require('./supabaseClient');
const pLimit = require('p-limit');
const limit = pLimit(5);
const { sendEmailAPI, sendPushNotification, invalidateOverridesCache } = require('./utils');
const { runMonitoring } = require('./monitoring');
const { runFullBackup } = require('./backup');
const notificationService = require('./notificationService');
const { sendMonthlyReport } = require('./reportingService');


const startCronJobs = () => {
    // ============================================================
    // 1. VÉRIFICATION DES SHIFTS (toutes les heures)
    // ============================================================
    cron.schedule('0 * * * *', async () => {
        console.log("⏰ [CRON] Vérification Intelligente des Shifts en cours...");
        const nowMs = Date.now();
        const today = new Date().toISOString().split('T')[0];

        try {
            const { data: enPoste } = await supabase
                .from('employees')
                .select('id, nom, rythme')
                .eq('statut', 'En Poste');

            if (!enPoste || enPoste.length === 0) {
                console.log("📡 [CRON] Aucun employé en poste.");
                return;
            }

            console.log(`📡 [CRON] ${enPoste.length} employé(s) en poste détecté(s)`);

            const ids = enPoste.map(e => e.id);
            const { data: lastPointages } = await supabase
                .from('pointages')
                .select('employee_id, heure')
                .in('employee_id', ids)
                .eq('action', 'CLOCK_IN')
                .gte('heure', `${today}T00:00:00`)
                .order('heure', { ascending: false });

            const tasks = enPoste.map(emp => limit(async () => {
                const sonPointage = lastPointages?.find(p => p.employee_id === emp.id);
                
                if (!sonPointage) {
                    console.log(`⚠️ ${emp.nom} est "En Poste" sans pointage. Correction...`);
                    await supabase.from('employees').update({ statut: 'Actif' }).eq('id', emp.id);
                    await supabase.from('logs').insert([{
                        agent: "Robot SIRH",
                        action: "CORRECTION STATUT",
                        details: `${emp.nom} était bloqué en "En Poste" sans pointage valide.`
                    }]);
                    return;
                }

                const inTime = new Date(sonPointage.heure).getTime();
                const shiftDurationHours = (nowMs - inTime) / (1000 * 60 * 60);

                if (shiftDurationHours > 24) {
                    console.log(`⚠️ ${emp.nom} shift impossible (${shiftDurationHours.toFixed(1)}h) - Correction`);
                    await supabase.from('employees').update({ statut: 'Actif' }).eq('id', emp.id);
                    return;
                }

                const { data: existingOut } = await supabase
                    .from('pointages')
                    .select('id')
                    .eq('employee_id', emp.id)
                    .eq('is_final_out', true)
                    .gte('heure', `${today}T00:00:00`)
                    .maybeSingle();

                if (existingOut) {
                    console.log(`✅ ${emp.nom} - Journée déjà clôturée.`);
                    return;
                }

                let maxDuration = 14;
                let logicCloseAddHours = 9;
                let warnDuration = 12;

                if (emp.rythme === 'GARDE') {
                    maxDuration = 17;
                    logicCloseAddHours = 12;
                    warnDuration = 15;
                }

                console.log(`📊 ${emp.nom} - Shift: ${shiftDurationHours.toFixed(1)}h / Max: ${maxDuration}h`);

                if (shiftDurationHours >= warnDuration && shiftDurationHours < maxDuration) {
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
                } else if (shiftDurationHours >= maxDuration) {
                    console.log(`🚨 ${emp.nom} - Dépassement (${shiftDurationHours.toFixed(1)}h/${maxDuration}h). Auto-clôture...`);
                    
                    const logicalEndTime = new Date(inTime + (logicCloseAddHours * 60 * 60 * 1000));

                    await supabase.from('pointages').insert([{
                        employee_id: emp.id,
                        action: 'CLOCK_OUT',
                        heure: logicalEndTime.toISOString(),
                        is_final_out: true,
                        zone_detectee: "AUTO_CLOSURE",
                        statut: "Oubli - Ajusté Auto"
                    }]);

                    await supabase.from('employees').update({ statut: 'Actif' }).eq('id', emp.id);
                    
                    await supabase.from('logs').insert([{
                        agent: "Robot SIRH",
                        action: "PROTECTION PAIE",
                        details: `Clôture auto de ${emp.nom} après ${shiftDurationHours.toFixed(1)}h. Shift ramené à ${logicCloseAddHours}h.`
                    }]);

                    console.log(`✅ Auto-clôture appliquée pour : ${emp.nom}`);
                }
            }));

            await Promise.all(tasks);
            console.log("✅ [CRON] Cycle terminé.");

        } catch (err) { 
            console.error("❌ Erreur critique Cron :", err); 
        }
    });

    // ============================================================
    // 2. ROBOT CONTRATS (tous les jours à 8h)
    // ============================================================
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
                        <p>Votre contrat arrive à échéance le <b>${new Date(emp.date_fin_contrat).toLocaleDateString('fr-FR')}</b> (dans ${daysLeft} jours).</p>
                        <p style="color: #64748b; font-size: 14px;">Le RH et votre responsable ont été informés.</p>
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
                        const pushBody = `${emp.nom} (${emp.poste}) arrive en fin de contrat dans ${daysLeft} jours.`;
                        await sendPushNotification(manager.user_associated_id, pushTitle, pushBody, "/#employees");
                    }
                }
            }
            console.log(`✅ [ROBOT CONTRATS] ${emps.length} alertes envoyées.`);
        } catch (err) {
            console.error("❌ [ROBOT CONTRATS] Erreur :", err.message);
        }
    });

    // ============================================================
    // 3. MONITORING (toutes les 5 minutes)
    // ============================================================
    cron.schedule('*/5 * * * *', async () => {
        console.log("📊 [MONITORING] Vérification périodique...");
        await runMonitoring();
    });

    // ============================================================
    // 3bis. EXPIRATION DES DÉROGATIONS DE PERMISSION (toutes les 5 minutes)
    // ------------------------------------------------------------
    // Une dérogation temporaire (permission_overrides.expires_at) doit
    // s'arrêter proche de l'heure prévue, pas seulement à la prochaine
    // connexion de la personne (contrairement aux permissions de rôle,
    // embarquées dans le JWT). Ce job fait la coupure : il marque EXPIRED,
    // invalide le cache local (le middleware le relira depuis la base au
    // prochain appel), journalise et notifie le titulaire ET celui qui
    // avait accordé l'accès.
    // ============================================================
    cron.schedule('*/5 * * * *', async () => {
        try {
            const nowIso = new Date().toISOString();
            const { data: expired } = await supabase
                .from('permission_overrides')
                .select('id, employee_id, permission_name, mode, granted_by, employees:employee_id(nom, email, user_associated_id)')
                .eq('status', 'ACTIVE')
                .not('expires_at', 'is', null)
                .lte('expires_at', nowIso);

            if (!expired || expired.length === 0) return;

            console.log(`🔑 [CRON] ${expired.length} dérogation(s) de permission expirée(s)`);

            for (const ov of expired) {
                await supabase.from('permission_overrides')
                    .update({ status: 'EXPIRED', notified_expiry_at: nowIso })
                    .eq('id', ov.id);

                invalidateOverridesCache(ov.employee_id);

                const emp = ov.employees;
                await supabase.from('logs').insert([{
                    agent: "Robot SIRH",
                    action: "EXPIRATION DEROGATION",
                    details: `Dérogation ${ov.mode} "${ov.permission_name}" expirée pour ${emp?.nom || ov.employee_id}.`
                }]);

                if (emp?.user_associated_id) {
                    await sendPushNotification(emp.user_associated_id,
                        "🔒 Accès expiré",
                        `Votre accès temporaire "${ov.permission_name}" a expiré.`, "/#my-profile");
                }
                if (emp?.email) {
                    await sendEmailAPI(emp.email, "Expiration d'un accès temporaire SIRH",
                        `<p>Votre accès temporaire <strong>${ov.permission_name}</strong> a expiré.</p>`);
                }

                if (ov.granted_by) {
                    const { data: granter } = await supabase.from('employees')
                        .select('user_associated_id, email').eq('id', ov.granted_by).single();
                    if (granter?.user_associated_id) {
                        await sendPushNotification(granter.user_associated_id,
                            "🔒 Accès accordé expiré",
                            `L'accès "${ov.permission_name}" que vous aviez accordé à ${emp?.nom || 'un employé'} a expiré.`, "/#employees");
                    }
                    if (granter?.email) {
                        await sendEmailAPI(granter.email, "Expiration d'un accès que vous aviez accordé",
                            `<p>L'accès temporaire <strong>${ov.permission_name}</strong> accordé à <strong>${emp?.nom || ov.employee_id}</strong> a expiré.</p>`);
                    }
                }
            }
        } catch (err) {
            console.error("❌ [CRON DÉROGATIONS] Erreur :", err.message);
        }
    });

    // ============================================================
    // 4. BACKUP QUOTIDIEN (à 2h)
    // ============================================================
    cron.schedule('0 2 * * *', async () => {
        console.log("💾 [BACKUP] Backup automatique quotidien...");
        await runFullBackup();
    });

    // ============================================================
    // 5. BACKUP HEBDOMADAIRE (lundi à 3h)
    // ============================================================
    cron.schedule('0 3 * * 1', async () => {
        console.log("📀 [BACKUP] Backup hebdomadaire complet...");
        await runFullBackup();
    });

    // ============================================================
    // 6. RAPPEL POINTAGE MATIN (9h, du lundi au vendredi)
    // ============================================================
    cron.schedule('0 9 * * 1-5', async () => {
        console.log("🔔 [NOTIF] Envoi des rappels de pointage matin...");
        await notificationService.sendMorningReminder();
    });

    // ============================================================
    // 7. RAPPEL POINTAGE SOIR (18h, du lundi au vendredi)
    // ============================================================
    cron.schedule('0 18 * * 1-5', async () => {
        console.log("🔔 [NOTIF] Envoi des rappels de pointage soir...");
        await notificationService.sendEveningReminder();
    });

    // ============================================================
    // 8. ALERTE MÉTÉO (6h, tous les jours)
    // ============================================================
    cron.schedule('0 6 * * *', async () => {
        console.log("🌤️ [NOTIF] Vérification météo...");
        await notificationService.sendWeatherAlert();
    });
};

// Envoi du rapport mensuel le dernier jour du mois à 8h
cron.schedule('0 8 28-31 * *', async () => {
    const now = new Date();
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    if (now.getDate() === lastDay) {
        console.log("📧 [REPORT] Envoi du rapport mensuel...");
        await sendMonthlyReport();
    }
});

module.exports = startCronJobs;
