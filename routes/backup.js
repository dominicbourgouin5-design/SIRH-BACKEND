// routes/backup.js
const express = require('express');
const router = express.Router();
const { runFullBackup, backupSingleTable, listBackups, BACKUP_TABLES } = require('../backup');
const { checkPerm } = require('../utils');

// Lancer un backup manuel (Admin ou RH uniquement)
router.post('/run-backup', async (req, res) => {
    // Vérifier le rôle directement
    const userRole = req.user?.role;
    if (userRole !== 'ADMIN' && userRole !== 'RH') {
        return res.status(403).json({ error: "Accès refusé. Seuls les administrateurs peuvent lancer un backup." });
    }
    
    console.log(`📀 Backup manuel lancé par ${req.user?.nom || 'Utilisateur'}`);
    const result = await runFullBackup();
    res.json(result);
});

// Lancer le backup d'une table spécifique
router.post('/backup-table', async (req, res) => {
    const userRole = req.user?.role;
    if (userRole !== 'ADMIN' && userRole !== 'RH') {
        return res.status(403).json({ error: "Accès refusé." });
    }
    
    const { tableName } = req.body;
    if (!tableName) {
        return res.status(400).json({ error: "Nom de table requis" });
    }
    
    console.log(`📀 Backup table ${tableName} lancé par ${req.user?.nom || 'Utilisateur'}`);
    const result = await backupSingleTable(tableName);
    res.json(result);
});

// Lister les backups disponibles
router.get('/list-backups', async (req, res) => {
    const userRole = req.user?.role;
    if (userRole !== 'ADMIN' && userRole !== 'RH') {
        return res.status(403).json({ error: "Accès refusé." });
    }
    
    // 🔥 CORRECTION : ajouter await ici
    const backups = await listBackups();
    res.json({ backups, count: backups.length });
});

// Informations sur les tables disponibles
router.get('/backup-tables', async (req, res) => {
    const userRole = req.user?.role;
    if (userRole !== 'ADMIN' && userRole !== 'RH') {
        return res.status(403).json({ error: "Accès refusé." });
    }
    
    res.json({ tables: BACKUP_TABLES });
});

module.exports = router;
