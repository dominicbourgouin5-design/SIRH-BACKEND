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

// Générer rapport des présences (Excel) - accessible à ADMIN et RH
router.get('/export-attendance', async (req, res) => {
    const userRole = req.user?.role;
    if (userRole !== 'ADMIN' && userRole !== 'RH') {
        return res.status(403).json({ error: "Accès refusé. Réservé aux administrateurs." });
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

// Générer rapport des salaires (Excel) - accessible à ADMIN et RH (paie)
router.get('/export-payroll', async (req, res) => {
    const userRole = req.user?.role;
    if (userRole !== 'ADMIN' && userRole !== 'RH') {
        return res.status(403).json({ error: "Accès refusé. Réservé aux administrateurs." });
    }
    
    // Vérifier la permission spécifique pour la paie
    if (!checkPerm(req, 'can_see_payroll') && userRole !== 'ADMIN') {
        return res.status(403).json({ error: "Accès refusé. Permission paie requise." });
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

// Envoyer rapport mensuel - accessible à ADMIN
router.post('/send-monthly-report', async (req, res) => {
    const userRole = req.user?.role;
    if (userRole !== 'ADMIN') {
        return res.status(403).json({ error: "Accès refusé. Réservé aux administrateurs." });
    }
    
    try {
        await sendMonthlyReport();
        res.json({ status: "success", message: "Rapport mensuel envoyé" });
    } catch (error) {
        console.error("Erreur envoi rapport:", error);
        res.status(500).json({ error: "Erreur lors de l'envoi du rapport" });
    }
});

// Récupérer les widgets du dashboard - accessible à tous
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

// Statistiques du dashboard - accessible à tous
router.get('/dashboard-stats', async (req, res) => {
    const stats = await getDashboardStats(req.user?.role, req.user?.emp_id);
    res.json(stats);
});

module.exports = router;
