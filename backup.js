// backup.js
// Sauvegarde automatique des données critiques dans Supabase Storage

const supabase = require('./supabaseClient');

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

// Bucket Supabase pour les backups
const BACKUP_BUCKET = 'backups';

// Créer le bucket s'il n'existe pas
async function ensureBackupBucket() {
    try {
        const { data: buckets, error: listError } = await supabase.storage.listBuckets();
        if (listError) throw listError;
        
        const bucketExists = buckets.some(b => b.name === BACKUP_BUCKET);
        if (!bucketExists) {
            const { error: createError } = await supabase.storage.createBucket(BACKUP_BUCKET, {
                public: false,
                allowedMimeTypes: ['application/json'],
                fileSizeLimit: 10485760 // 10MB
            });
            if (createError) throw createError;
            console.log(`📦 Bucket '${BACKUP_BUCKET}' créé avec succès`);
        }
    } catch (error) {
        console.error("Erreur création bucket:", error.message);
    }
}

// Sauvegarde une table dans Supabase Storage
async function backupTable(tableName) {
    console.log(`💾 Backup de la table ${tableName}...`);
    
    try {
        const { data, error, count } = await supabase
            .from(tableName)
            .select('*', { count: 'exact' })
            .limit(50000);
            
        if (error) throw error;
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupData = {
            table: tableName,
            timestamp: new Date().toISOString(),
            count: count || data.length,
            data: data,
            version: '1.0'
        };
        
        const fileName = `${tableName}_${timestamp}.json`;
        const fileContent = JSON.stringify(backupData, null, 2);
        
        // Upload vers Supabase Storage
        const { error: uploadError } = await supabase.storage
            .from(BACKUP_BUCKET)
            .upload(fileName, Buffer.from(fileContent), {
                contentType: 'application/json',
                upsert: true
            });
            
        if (uploadError) throw uploadError;
        
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
    console.log(`📦 Destination: Supabase Storage (${BACKUP_BUCKET})`);
    
    await ensureBackupBucket();
    
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
    
    // Nettoyer les vieux backups (garder les 7 plus récents)
    await cleanOldBackups();
    
    return { results, duration, successCount, failCount };
}

// Nettoyer les vieux backups (garder seulement les 7 plus récents par table)
async function cleanOldBackups() {
    try {
        const { data: files, error } = await supabase.storage
            .from(BACKUP_BUCKET)
            .list();
            
        if (error) throw error;
        
        if (!files || files.length === 0) return;
        
        // Grouper par table
        const filesByTable = {};
        files.forEach(file => {
            const tableName = file.name.split('_')[0];
            if (!filesByTable[tableName]) filesByTable[tableName] = [];
            filesByTable[tableName].push(file);
        });
        
        // Pour chaque table, garder seulement les 7 plus récents
        for (const table in filesByTable) {
            const sorted = filesByTable[table].sort((a, b) => 
                new Date(b.created_at) - new Date(a.created_at)
            );
            
            const toDelete = sorted.slice(7);
            for (const file of toDelete) {
                await supabase.storage.from(BACKUP_BUCKET).remove([file.name]);
                console.log(`🧹 Ancien backup supprimé: ${file.name}`);
            }
        }
    } catch (error) {
        console.error("Erreur nettoyage backups:", error.message);
    }
}

// Sauvegarde d'une table spécifique
async function backupSingleTable(tableName) {
    const validTables = BACKUP_TABLES;
    if (!validTables.includes(tableName)) {
        return { error: `Table non reconnue. Options: ${validTables.join(', ')}` };
    }
    return await backupTable(tableName);
}

// Récupérer la liste des backups disponibles
async function listBackups() {
    try {
        const { data: files, error } = await supabase.storage
            .from(BACKUP_BUCKET)
            .list();
            
        if (error) throw error;
        
        if (!files || files.length === 0) return [];
        
        const backups = files.map(file => {
            const fileSize = (file.metadata?.size || 0) / 1024;
            return {
                name: file.name,
                size: fileSize.toFixed(1) + ' KB',
                date: file.created_at,
                table: file.name.split('_')[0]
            };
        }).sort((a, b) => new Date(b.date) - new Date(a.date));
        
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
