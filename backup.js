// backup.js
// Sauvegarde automatique des données critiques

const supabase = require('./supabaseClient');
const fs = require('fs');
const path = require('path');

// Tables à sauvegarder
const BACKUP_TABLES = [
    'employees',
    'pointages', 
    'conges',
    'paie',
    'logs',
    'visit_reports',
    'crm_leads'
];

// Dossier de sauvegarde (utilise /tmp sur Render car espace limité)
const BACKUP_DIR = process.env.BACKUP_DIR || '/tmp/sirh_backups';

// Créer le dossier s'il n'existe pas
function ensureBackupDir() {
    if (!fs.existsSync(BACKUP_DIR)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        console.log(`📁 Dossier de backup créé: ${BACKUP_DIR}`);
    }
}

// Sauvegarde une table
async function backupTable(tableName) {
    console.log(`💾 Backup de la table ${tableName}...`);
    
    try {
        const { data, error, count } = await supabase
            .from(tableName)
            .select('*', { count: 'exact' })
            .limit(50000); // Limite de sécurité
            
        if (error) throw error;
        
        const backupData = {
            table: tableName,
            timestamp: new Date().toISOString(),
            count: count || data.length,
            data: data,
            version: '1.0'
        };
        
        const fileName = `${tableName}_${Date.now()}.json`;
        const filePath = path.join(BACKUP_DIR, fileName);
        
        fs.writeFileSync(filePath, JSON.stringify(backupData, null, 2));
        
        console.log(`✅ Backup ${tableName}: ${backupData.count} lignes → ${fileName}`);
        return { success: true, count: backupData.count, file: fileName };
        
    } catch (error) {
        console.error(`❌ Erreur backup ${tableName}:`, error.message);
        return { success: false, error: error.message };
    }
}

// Sauvegarde complète
async function runFullBackup() {
    const startTime = Date.now();
    console.log("\n💾 [BACKUP] Début de la sauvegarde complète...");
    console.log(`📁 Destination: ${BACKUP_DIR}`);
    
    ensureBackupDir();
    
    const results = [];
    
    for (const table of BACKUP_TABLES) {
        const result = await backupTable(table);
        results.push({ table, ...result });
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    
    console.log(`\n✅ [BACKUP] Sauvegarde terminée en ${duration}s`);
    console.log(`   ✅ Succès: ${successCount} tables`);
    console.log(`   ❌ Échecs: ${failCount} tables`);
    
    // Nettoyer les vieux backups (garder seulement les 7 derniers jours)
    await cleanOldBackups();
    
    return { results, duration, successCount, failCount };
}

// Nettoyer les backups de plus de 7 jours
async function cleanOldBackups() {
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    let deletedCount = 0;
    
    try {
        const files = fs.readdirSync(BACKUP_DIR);
        
        for (const file of files) {
            const filePath = path.join(BACKUP_DIR, file);
            const stats = fs.statSync(filePath);
            
            if (stats.mtimeMs < sevenDaysAgo) {
                fs.unlinkSync(filePath);
                deletedCount++;
            }
        }
        
        if (deletedCount > 0) {
            console.log(`🧹 Nettoyage: ${deletedCount} anciens backups supprimés`);
        }
    } catch (error) {
        console.error("Erreur nettoyage backups:", error.message);
    }
}

// Sauvegarde d'une table spécifique (appel API)
async function backupSingleTable(tableName) {
    const validTables = BACKUP_TABLES;
    if (!validTables.includes(tableName)) {
        return { error: `Table non reconnue. Options: ${validTables.join(', ')}` };
    }
    return await backupTable(tableName);
}

// Récupérer la liste des backups disponibles
function listBackups() {
    ensureBackupDir();
    
    try {
        const files = fs.readdirSync(BACKUP_DIR);
        const backups = files.map(file => {
            const filePath = path.join(BACKUP_DIR, file);
            const stats = fs.statSync(filePath);
            return {
                name: file,
                size: (stats.size / 1024).toFixed(1) + ' KB',
                date: stats.mtime
            };
        }).sort((a, b) => b.date - a.date);
        
        return backups;
    } catch (error) {
        console.error("Erreur lecture backups:", error.message);
        return [];
    }
}

module.exports = { 
    runFullBackup, 
    backupSingleTable, 
    listBackups,
    BACKUP_TABLES
};
