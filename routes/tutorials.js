// routes/tutorials.js
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

// Récupérer les tutoriels disponibles
router.get('/tutorials', async (req, res) => {
    try {
        const role = req.user?.role || 'EMPLOYEE';
        const tutorials = await getAvailableTutorials(role, req.user.id);
        res.json(tutorials);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Démarrer un tutoriel
router.post('/tutorials/start', async (req, res) => {
    try {
        const { tutorialId } = req.body;
        const progress = await startTutorial(req.user.id, tutorialId);
        res.json(progress);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Passer à l'étape suivante
router.post('/tutorials/next', async (req, res) => {
    try {
        const { tutorialId, currentStep, completedStep } = req.body;
        const progress = await nextStep(req.user.id, tutorialId, currentStep, completedStep);
        res.json(progress);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Réinitialiser un tutoriel
router.post('/tutorials/reset', async (req, res) => {
    try {
        const { tutorialId } = req.body;
        const progress = await resetTutorial(req.user.id, tutorialId);
        res.json(progress);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Marquer comme terminé
router.post('/tutorials/complete', async (req, res) => {
    try {
        const { tutorialId } = req.body;
        const progress = await completeTutorial(req.user.id, tutorialId);
        res.json(progress);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Vérifier si afficher le tutoriel de bienvenue
router.get('/tutorials/should-show', async (req, res) => {
    try {
        const show = await shouldShowTutorial(req.user.id, req.user?.role);
        res.json({ show });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
