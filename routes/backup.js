// routes/backup.js
const express = require('express');
const router = express.Router();
const { runFullBackup, backupSingleTable, listBackups, BACKUP_TABLES } = require('../backup');
const { checkPerm } = require('../utils');

// Lancer un backup manuel (Admin uniquement)
router.post('/run-backup', async (req, res) => {
    if (!checkPerm(req, 'can_manage_config')) {
        return res.status(403).json({ error: "Accès refusé" });
    }
    
    const result = await runFullBackup();
    res.json(result);
});

// Lancer le backup d'une table spécifique
router.post('/backup-table', async (req, res) => {
    if (!checkPerm(req, 'can_manage_config')) {
        return res.status(403).json({ error: "Accès refusé" });
    }
    
    const { tableName } = req.body;
    if (!tableName) {
        return res.status(400).json({ error: "Nom de table requis" });
    }
    
    const result = await backupSingleTable(tableName);
    res.json(result);
});

// Lister les backups disponibles
router.get('/list-backups', async (req, res) => {
    if (!checkPerm(req, 'can_manage_config')) {
        return res.status(403).json({ error: "Accès refusé" });
    }
    
    const backups = listBackups();
    res.json({ backups, count: backups.length });
});

// Informations sur les tables disponibles
router.get('/backup-tables', async (req, res) => {
    if (!checkPerm(req, 'can_manage_config')) {
        return res.status(403).json({ error: "Accès refusé" });
    }
    
    res.json({ tables: BACKUP_TABLES });
});

module.exports = router;
