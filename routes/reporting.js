// routes/reporting.js
const express = require('express');
const router = express.Router();
const { 
    generateAttendanceReport, 
    generatePayrollReport,
    sendMonthlyReport,
    getDashboardWidgets,
    saveDashboardPreferences,
    getUserDashboardPrefs,
    getDashboardStats
} = require('../reportingService');
const { checkPerm } = require('../utils');

// Ces trois routes étaient gardées par un test de rôle en dur
// (`role === 'ADMIN' || role === 'RH'`), ce qui les plaçait hors du système
// de permissions : un COMPTABLE ne pouvait pas exporter la paie, et aucune
// dérogation individuelle ne pouvait le lui accorder, puisque les
// dérogations agissent sur req.user.permissions et non sur req.user.role.
// Elles passent donc par des permissions nommées, comme le reste de l'API.

// Générer rapport des présences (Excel)
router.get('/export-attendance', async (req, res) => {
    if (!checkPerm(req, "can_export_attendance")) {
        return res.status(403).json({ error: "Accès refusé à l'export des présences." });
    }

    try {
        const { month, year } = req.query;
        const workbook = await generateAttendanceReport(parseInt(month), parseInt(year));
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=presences_${month}_${year}.xlsx`);
        
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error("Erreur export attendance:", error);
        res.status(500).json({ error: "Erreur lors de la génération du rapport" });
    }
});

// Générer rapport des salaires (Excel)
router.get('/export-payroll', async (req, res) => {
    if (!checkPerm(req, "can_export_payroll")) {
        return res.status(403).json({ error: "Accès refusé à l'export de la paie." });
    }

    try {
        const { month, year } = req.query;
        const workbook = await generatePayrollReport(month, parseInt(year));
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=salaires_${month}_${year}.xlsx`);
        
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error("Erreur export payroll:", error);
        res.status(500).json({ error: "Erreur lors de la génération du rapport" });
    }
});

// Envoyer rapport mensuel
router.post('/send-monthly-report', async (req, res) => {
    if (!checkPerm(req, "can_send_reports")) {
        return res.status(403).json({ error: "Accès refusé à l'envoi des rapports." });
    }

    try {
        await sendMonthlyReport();
        res.json({ status: "success", message: "Rapport mensuel envoyé" });
    } catch (error) {
        console.error("Erreur envoi rapport:", error);
        res.status(500).json({ error: "Erreur lors de l'envoi du rapport" });
    }
});

// Récupérer les widgets du dashboard
router.get('/dashboard-widgets', async (req, res) => {
    const role = req.user?.role || 'EMPLOYEE';
    const widgets = await getDashboardWidgets(role);
    res.json(widgets);
});

// Sauvegarder les préférences du dashboard
router.post('/dashboard-prefs', async (req, res) => {
    const { widgets } = req.body;
    await saveDashboardPreferences(req.user.id, widgets);
    res.json({ status: "success" });
});

// Récupérer les préférences du dashboard
router.get('/dashboard-prefs', async (req, res) => {
    const prefs = await getUserDashboardPrefs(req.user.id);
    res.json(prefs || []);
});

// Statistiques du dashboard
router.get('/dashboard-stats', async (req, res) => {
    const stats = await getDashboardStats(req.user?.role, req.user?.emp_id);
    res.json(stats);
});

module.exports = router;
