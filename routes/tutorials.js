const express = require('express');
const router = express.Router();
const { 
    getAvailableTutorials,
    startTutorial,
    nextStep,
    resetTutorial,
    completeTutorial,
    shouldShowTutorial
} = require('../tutorialService');

// Middleware pour s'assurer que l'utilisateur est authentifié
router.use((req, res, next) => {
    if (!req.user || !req.user.id) {
        return res.status(401).json({ error: "Non authentifié" });
    }
    next();
});

// GET /api/tutorials - Récupérer tous les tutoriels disponibles
router.get('/tutorials', async (req, res) => {
    try {
        const role = req.user?.role || 'EMPLOYEE';
        const tutorials = await getAvailableTutorials(role, req.user.id);
        res.json(tutorials);
    } catch (error) {
        console.error("Erreur GET /tutorials:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// POST /api/tutorials/start - Démarrer un tutoriel
router.post('/tutorials/start', async (req, res) => {
    try {
        const { tutorialId } = req.body;
        if (!tutorialId) {
            return res.status(400).json({ error: "tutorialId requis" });
        }
        const progress = await startTutorial(req.user.id, tutorialId);
        res.json(progress);
    } catch (error) {
        console.error("Erreur POST /tutorials/start:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// POST /api/tutorials/next - Passer à l'étape suivante
router.post('/tutorials/next', async (req, res) => {
    try {
        const { tutorialId, currentStep, completedStep } = req.body;
        if (!tutorialId) {
            return res.status(400).json({ error: "tutorialId requis" });
        }
        const progress = await nextStep(req.user.id, tutorialId, currentStep, completedStep);
        res.json(progress);
    } catch (error) {
        console.error("Erreur POST /tutorials/next:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// POST /api/tutorials/reset - Réinitialiser un tutoriel
router.post('/tutorials/reset', async (req, res) => {
    try {
        const { tutorialId } = req.body;
        if (!tutorialId) {
            return res.status(400).json({ error: "tutorialId requis" });
        }
        const progress = await resetTutorial(req.user.id, tutorialId);
        res.json(progress || { status: "reset", tutorialId });
    } catch (error) {
        console.error("Erreur POST /tutorials/reset:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// POST /api/tutorials/complete - Marquer un tutoriel comme terminé
router.post('/tutorials/complete', async (req, res) => {
    try {
        const { tutorialId } = req.body;
        if (!tutorialId) {
            return res.status(400).json({ error: "tutorialId requis" });
        }
        const progress = await completeTutorial(req.user.id, tutorialId);
        res.json(progress);
    } catch (error) {
        console.error("Erreur POST /tutorials/complete:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// GET /api/tutorials/should-show - Vérifier si afficher le tutoriel de bienvenue
router.get('/tutorials/should-show', async (req, res) => {
    try {
        const show = await shouldShowTutorial(req.user.id, req.user?.role);
        res.json({ show });
    } catch (error) {
        console.error("Erreur GET /tutorials/should-show:", error.message);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
