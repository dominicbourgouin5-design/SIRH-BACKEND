// reportingService.js
// Service de reporting avancé

const supabase = require('./supabaseClient');
const { sendEmailWithAttachment, fetchAllRows } = require('./utils');
const ExcelJS = require('exceljs');

// ============================================================
// 1. GÉNÉRATION DE RAPPORTS EXCEL
// ============================================================

// Générer un rapport Excel des présences
async function generateAttendanceReport(month, year) {
    // Borne haute exclusive = premier jour du mois suivant.
    // L'ancien code comparait à une date sans heure ("2026-08-31"), ce que
    // Postgres interprète comme 00:00:00 : tous les pointages du dernier jour
    // du mois étaient exclus du rapport.
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const moisSuivant = month === 12 ? 1 : month + 1;
    const anneeSuivante = month === 12 ? year + 1 : year;
    const endDate = `${anneeSuivante}-${String(moisSuivant).padStart(2, '0')}-01`;

    // Récupérer les données
    const { data: employees } = await supabase
        .from('employees')
        .select('id, nom, matricule, poste, departement');

    // Pagination complète : un mois de pointages dépasse vite les 1000 lignes
    // renvoyées au maximum par PostgREST, ce qui faussait les totaux d'heures.
    const pointages = await fetchAllRows(() =>
        supabase
            .from('pointages')
            .select('employee_id, heure, action')
            .gte('heure', startDate)
            .lt('heure', endDate)
            .order('heure', { ascending: true })
    );

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Présences');
    
    // En-têtes
    worksheet.columns = [
        { header: 'Matricule', key: 'matricule', width: 15 },
        { header: 'Nom', key: 'nom', width: 25 },
        { header: 'Poste', key: 'poste', width: 20 },
        { header: 'Département', key: 'departement', width: 20 },
        { header: 'Jours Présents', key: 'jours_presents', width: 15 },
        { header: 'Heures Totales', key: 'heures', width: 15 },
        { header: 'Retards', key: 'retards', width: 10 },
    ];
    
    // Style de l'en-tête
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF0F172A' }
    };
    worksheet.getRow(1).font = { color: { argb: 'FFFFFFFF' } };
    
    // Remplir les données
    for (const emp of employees) {
        const empPointages = pointages.filter(p => p.employee_id === emp.id);
        const joursUniques = new Set();
        let retards = 0;
        
        empPointages.forEach(p => {
            const date = new Date(p.heure).toISOString().split('T')[0];
            joursUniques.add(date);
            const heure = new Date(p.heure).getHours();
            if (p.action === 'CLOCK_IN' && heure > 9) retards++;
        });
        
        worksheet.addRow({
            matricule: emp.matricule,
            nom: emp.nom,
            poste: emp.poste,
            departement: emp.departement,
            jours_presents: joursUniques.size,
            heures: (joursUniques.size * 8).toFixed(1),
            retards: retards
        });
    }
    
    return workbook;
}

// Générer un rapport Excel des salaires
async function generatePayrollReport(month, year) {
    // Une ligne par employé et par mois : au-delà de 1000 collaborateurs, la
    // réponse serait tronquée sans pagination et le rapport incomplet.
    const paie = await fetchAllRows(() =>
        supabase
            .from('paie')
            .select('*, employees(nom, matricule, poste)')
            .eq('mois', month)
            .eq('annee', year)
            .order('id', { ascending: true })
    );

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Salaires');
    
    worksheet.columns = [
        { header: 'Matricule', key: 'matricule', width: 15 },
        { header: 'Nom', key: 'nom', width: 25 },
        { header: 'Poste', key: 'poste', width: 20 },
        { header: 'Salaire Base', key: 'salaire_base', width: 15 },
        { header: 'Primes', key: 'primes', width: 12 },
        { header: 'Retenues', key: 'retenues', width: 12 },
        { header: 'Net à Payer', key: 'net', width: 15 },
    ];
    
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF0F172A' }
    };
    worksheet.getRow(1).font = { color: { argb: 'FFFFFFFF' } };
    
    for (const p of paie) {
        worksheet.addRow({
            matricule: p.employees?.matricule || 'N/A',
            nom: p.employees?.nom || 'Inconnu',
            poste: p.employees?.poste || '---',
            salaire_base: p.salaire_base,
            primes: p.primes,
            retenues: p.retenues,
            net: p.salaire_net
        });
    }
    
    // Ajouter une ligne de total
    const totalNet = paie.reduce((sum, p) => sum + (p.salaire_net || 0), 0);
    worksheet.addRow({
        nom: 'TOTAL GÉNÉRAL',
        net: totalNet
    });
    
    return workbook;
}

// ============================================================
// 2. ENVOI AUTOMATIQUE DE RAPPORTS PAR EMAIL (AVEC PIÈCES JOINTES)
// ============================================================

// Envoyer le rapport mensuel à la fin du mois
async function sendMonthlyReport() {
    const now = new Date();
    const lastMonth = now.getMonth(); // Mois précédent
    const year = now.getFullYear();
    const monthNames = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
    const monthName = monthNames[lastMonth - 1];
    
    if (lastMonth === 0) {
        console.log("📧 [REPORT] Mois de janvier, pas de rapport précédent");
        return;
    }
    
    console.log(`📧 [REPORT] Envoi du rapport mensuel ${monthName} ${year}...`);
    
    try {
        // Générer les rapports
        const attendanceWorkbook = await generateAttendanceReport(lastMonth, year);
        const payrollWorkbook = await generatePayrollReport(monthName, year);
        
        // Convertir en buffers
        const attendanceBuffer = await attendanceWorkbook.xlsx.writeBuffer();
        const payrollBuffer = await payrollWorkbook.xlsx.writeBuffer();
        
        // Convertir buffers en base64 pour Brevo
        const attendanceBase64 = attendanceBuffer.toString('base64');
        const payrollBase64 = payrollBuffer.toString('base64');
        
        // Pièces jointes
        const attachments = [
            {
                name: `Presences_${monthName}_${year}.xlsx`,
                content: attendanceBase64
            },
            {
                name: `Salaires_${monthName}_${year}.xlsx`,
                content: payrollBase64
            }
        ];
        
        // Récupérer les destinataires (RH + Admins)
        const { data: admins } = await supabase
            .from('employees')
            .select('email, nom')
            .in('role', ['ADMIN', 'RH']);
        
        if (!admins || admins.length === 0) {
            console.log("📧 [REPORT] Aucun destinataire trouvé (ADMIN ou RH)");
            return;
        }
        
        // Créer le HTML de l'email
        const emailHtml = `
        <div style="font-family: 'Segoe UI', sans-serif; max-width: 600px; margin: auto; background: #ffffff; border-radius: 16px; overflow: hidden;">
            <div style="background: #0f172a; padding: 30px; text-align: center;">
                <img src="https://cdn-icons-png.flaticon.com/512/9752/9752284.png" style="width: 60px;">
                <h1 style="color: white; margin: 10px 0 0 0;">Rapport Mensuel</h1>
                <p style="color: #94a3b8;">${monthName} ${year}</p>
            </div>
            <div style="padding: 30px;">
                <p>Bonjour,</p>
                <p>Veuillez trouver ci-joints les rapports mensuels du <strong>${monthName} ${year}</strong>.</p>
                
                <div style="background: #f1f5f9; padding: 15px; border-radius: 12px; margin: 20px 0;">
                    <h3 style="margin: 0 0 10px 0;">📊 Contenu des rapports</h3>
                    <ul style="margin: 0; padding-left: 20px;">
                        <li>📋 <strong>Presences_${monthName}_${year}.xlsx</strong> - Présences et absences</li>
                        <li>💰 <strong>Salaires_${monthName}_${year}.xlsx</strong> - Récapitulatif des salaires</li>
                    </ul>
                </div>
                
                <p style="color: #64748b; font-size: 12px;">Ce rapport est généré automatiquement par SIRH SECURE.</p>
            </div>
            <div style="background: #f8fafc; padding: 20px; text-align: center; font-size: 11px; color: #94a3b8;">
                SIRH SECURE - Système de Gestion RH
            </div>
        </div>`;
        
        // Envoyer les emails avec pièces jointes
        let sentCount = 0;
        for (const admin of admins) {
            if (admin.email) {
                const success = await sendEmailWithAttachment(
                    admin.email, 
                    `📊 Rapport Mensuel ${monthName} ${year}`, 
                    emailHtml, 
                    attachments
                );
                if (success) {
                    sentCount++;
                    console.log(`📧 Rapport envoyé à ${admin.email} (${admin.nom})`);
                }
            }
        }
        
        console.log(`✅ [REPORT] ${sentCount} rapports envoyés sur ${admins.length} destinataires`);
        return { sent: sentCount, total: admins.length };
        
    } catch (error) {
        console.error("❌ [REPORT] Erreur:", error.message);
        return { error: error.message };
    }
}

// ============================================================
// 3. DASHBOARD PERSONNALISABLE
// ============================================================

// Récupérer les widgets du dashboard pour un rôle
async function getDashboardWidgets(role) {
    const { data, error } = await supabase
        .from('dashboard_widgets')
        .select('*')
        .eq('role', role)
        .order('order_index', { ascending: true });
    
    if (error || !data || data.length === 0) return getDefaultWidgets(role);
    return data;
}

// Widgets par défaut selon le rôle
function getDefaultWidgets(role) {
    const commonWidgets = [
        { id: 'stats', title: 'Statistiques', type: 'stats', visible: true },
        { id: 'chart', title: 'Graphiques', type: 'chart', visible: true },
    ];
    
    const roleWidgets = {
        'ADMIN': [
            ...commonWidgets,
            { id: 'alerts', title: 'Alertes', type: 'alerts', visible: true },
            { id: 'backup', title: 'Backups', type: 'backup', visible: true },
        ],
        'RH': [
            ...commonWidgets,
            { id: 'leaves', title: 'Congés', type: 'leaves', visible: true },
            { id: 'contracts', title: 'Contrats', type: 'contracts', visible: true },
        ],
        'MANAGER': [
            ...commonWidgets,
            { id: 'team', title: 'Mon Équipe', type: 'team', visible: true },
            { id: 'attendance', title: 'Présences', type: 'attendance', visible: true },
        ],
        'EMPLOYEE': [
            { id: 'my_stats', title: 'Mes Statistiques', type: 'my_stats', visible: true },
            { id: 'my_leaves', title: 'Mes Congés', type: 'my_leaves', visible: true },
            { id: 'my_payroll', title: 'Mes Paies', type: 'my_payroll', visible: true },
        ]
    };
    
    return roleWidgets[role] || roleWidgets['EMPLOYEE'];
}

// Sauvegarder les préférences du dashboard
async function saveDashboardPreferences(userId, widgets) {
    const { error } = await supabase
        .from('user_dashboard_prefs')
        .upsert({
            user_id: userId,
            widgets: widgets,
            updated_at: new Date().toISOString()
        });
    
    if (error) throw error;
    return true;
}

// Récupérer les préférences du dashboard d'un utilisateur
async function getUserDashboardPrefs(userId) {
    const { data, error } = await supabase
        .from('user_dashboard_prefs')
        .select('widgets')
        .eq('user_id', userId)
        .single();
    
    if (error || !data) return null;
    return data.widgets;
}

// ============================================================
// 4. STATISTIQUES AVANCÉES
// ============================================================

// Statistiques pour le dashboard
async function getDashboardStats(role, userId = null) {
    const stats = {
        employees: { total: 0, actifs: 0, absents: 0 },
        attendance: { present: 0, late: 0, absent: 0 },
        leaves: { pending: 0, approved: 0, total: 0 },
        payroll: { totalNet: 0, averageSalary: 0 },
        contracts: { expiringSoon: 0, expired: 0 }
    };
    
    const today = new Date().toISOString().split('T')[0];
    const in30Days = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    // Employés
    const { count: totalEmps } = await supabase
        .from('employees')
        .select('*', { count: 'exact', head: true });
    stats.employees.total = totalEmps;
    
    const { count: actifs } = await supabase
        .from('employees')
        .select('*', { count: 'exact', head: true })
        .eq('statut', 'Actif');
    stats.employees.actifs = actifs;
    
    // Congés en attente
    const { count: pendingLeaves } = await supabase
        .from('conges')
        .select('*', { count: 'exact', head: true })
        .eq('statut', 'En attente');
    stats.leaves.pending = pendingLeaves;
    
    // Contrats expirant
    const { count: expiring } = await supabase
        .from('employees')
        .select('*', { count: 'exact', head: true })
        .lte('date_fin_contrat', in30Days)
        .gt('date_fin_contrat', today);
    stats.contracts.expiringSoon = expiring;
    
    return stats;
}

module.exports = {
    generateAttendanceReport,
    generatePayrollReport,
    sendMonthlyReport,
    getDashboardWidgets,
    saveDashboardPreferences,
    getUserDashboardPrefs,
    getDashboardStats
};
