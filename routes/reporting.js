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

// Générer rapport des présences (Excel)
router.get('/export-attendance', async (req, res) => {
    if (!checkPerm(req, 'can_see_employees')) {
        return res.status(403).json({ error: "Accès refusé" });
    }
    
    const { month, year } = req.query;
    const workbook = await generateAttendanceReport(parseInt(month), parseInt(year));
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=presences_${month}_${year}.xlsx`);
    
    await workbook.xlsx.write(res);
    res.end();
});

// Générer rapport des salaires (Excel)
router.get('/export-payroll', async (req, res) => {
    if (!checkPerm(req, 'can_see_payroll')) {
        return res.status(403).json({ error: "Accès refusé" });
    }
    
    const { month, year } = req.query;
    const workbook = await generatePayrollReport(month, parseInt(year));
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=salaires_${month}_${year}.xlsx`);
    
    await workbook.xlsx.write(res);
    res.end();
});

// Envoyer rapport mensuel (manuel)
router.post('/send-monthly-report', async (req, res) => {
    if (!checkPerm(req, 'can_send_announcements')) {
        return res.status(403).json({ error: "Accès refusé" });
    }
    
    await sendMonthlyReport();
    res.json({ status: "success", message: "Rapport mensuel envoyé" });
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
