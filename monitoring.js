// monitoring.js
// Système de surveillance et d'alertes

const os = require('os');
const supabase = require('./supabaseClient');

// Configuration des seuils d'alerte
const ALERT_CONFIG = {
    highCpuUsage: 80,        // Pourcentage
    highMemoryUsage: 85,     // Pourcentage
    slowRequestTime: 5000,   // Millisecondes
    consecutiveErrors: 5     // Nombre d'erreurs consécutives
};

let errorCounter = 0;
let lastAlertTime = {};

// Fonction pour envoyer une alerte par email
async function sendAlert(type, message, details = {}) {
    const now = Date.now();
    const lastAlert = lastAlertTime[type] || 0;
    
    // Ne pas envoyer plus d'une alerte par type toutes les 30 minutes
    if (now - lastAlert < 30 * 60 * 1000) {
        console.log(`⏸️ Alerte ${type} ignorée (trop fréquente)`);
        return;
    }
    
    lastAlertTime[type] = now;
    
    console.error(`🚨 ALERTE [${type}]: ${message}`, details);
    
    // Enregistrer dans les logs
    await supabase.from('logs').insert([{
        agent: "Monitoring",
        action: `ALERTE_${type.toUpperCase()}`,
        details: `${message} - ${JSON.stringify(details)}`
    }]);
    
    // Optionnel: Envoyer un email
    try {
        const { sendEmailAPI } = require('./utils');
        await sendEmailAPI(
            process.env.ALERT_EMAIL || 'admin@entreprise.com',
            `🚨 ALERTE SIRH - ${type}`,
            `<h2>${type}</h2><p>${message}</p><pre>${JSON.stringify(details, null, 2)}</pre>`
        );
    } catch (e) {
        console.error("Erreur envoi email alerte:", e.message);
    }
}

// Vérification des ressources système
async function checkSystemResources() {
    const cpuUsage = os.loadavg()[0] / os.cpus().length * 100;
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memoryUsage = (1 - freeMem / totalMem) * 100;
    
    if (cpuUsage > ALERT_CONFIG.highCpuUsage) {
        await sendAlert('CPU_HIGH', `Utilisation CPU: ${cpuUsage.toFixed(1)}%`, { cpuUsage });
    }
    
    if (memoryUsage > ALERT_CONFIG.highMemoryUsage) {
        await sendAlert('MEMORY_HIGH', `Utilisation Mémoire: ${memoryUsage.toFixed(1)}%`, { memoryUsage });
    }
    
    return { cpuUsage, memoryUsage };
}

// Middleware pour mesurer le temps de réponse
function responseTimeMiddleware(req, res, next) {
    const start = Date.now();
    
    res.on('finish', () => {
        const duration = Date.now() - start;
        
        if (duration > ALERT_CONFIG.slowRequestTime) {
            sendAlert('SLOW_REQUEST', `Requête lente: ${duration}ms`, {
                method: req.method,
                url: req.url,
                duration: duration
            });
        }
    });
    
    next();
}

// Middleware pour compter les erreurs consécutives
function errorCountingMiddleware(err, req, res, next) {
    errorCounter++;
    
    if (errorCounter >= ALERT_CONFIG.consecutiveErrors) {
        sendAlert('CONSECUTIVE_ERRORS', `${errorCounter} erreurs consécutives`, {
            lastError: err.message,
            endpoint: req.url
        });
        errorCounter = 0;
    }
    
    next(err);
}

// Vérification de la connexion à Supabase
async function checkSupabaseConnection() {
    try {
        const start = Date.now();
        const { data, error } = await supabase.from('employees').select('id', { count: 'exact', head: true });
        const duration = Date.now() - start;
        
        if (error) {
            await sendAlert('SUPABASE_ERROR', `Erreur Supabase: ${error.message}`, { error });
            return false;
        }
        
        console.log(`✅ Supabase connecté (${duration}ms)`);
        return true;
    } catch (e) {
        await sendAlert('SUPABASE_ERROR', `Impossible de contacter Supabase: ${e.message}`);
        return false;
    }
}

// Vérification du stockage (espace disque)
async function checkDiskSpace() {
    try {
        const { data: files } = await supabase.storage.from('documents').list();
        const totalSize = files?.reduce((sum, f) => sum + (f.metadata?.size || 0), 0) || 0;
        const sizeInMB = (totalSize / 1024 / 1024).toFixed(1);
        
        console.log(`💾 Stockage utilisé: ${sizeInMB} MB`);
        
        if (totalSize > 1024 * 1024 * 1024) { // 1GB
            await sendAlert('STORAGE_HIGH', `Stockage élevé: ${sizeInMB} MB`, { sizeInMB });
        }
    } catch (e) {
        console.warn("Impossible de vérifier l'espace disque:", e.message);
    }
}

// Dashboard de santé (route API)
async function getHealthStatus() {
    const { cpuUsage, memoryUsage } = await checkSystemResources();
    const supabaseOk = await checkSupabaseConnection();
    
    return {
        status: supabaseOk ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        system: {
            cpu: cpuUsage.toFixed(1),
            memory: memoryUsage.toFixed(1),
            platform: os.platform()
        },
        supabase: supabaseOk ? 'connected' : 'disconnected',
        version: process.env.npm_package_version || '1.0.0'
    };
}

// Tâche planifiée de monitoring (à appeler toutes les 5 minutes)
async function runMonitoring() {
    console.log("🔍 [MONITORING] Scan des ressources...");
    
    await checkSystemResources();
    await checkSupabaseConnection();
    await checkDiskSpace();
    
    console.log("✅ [MONITORING] Scan terminé");
}

module.exports = {
    sendAlert,
    checkSystemResources,
    responseTimeMiddleware,
    errorCountingMiddleware,
    checkSupabaseConnection,
    getHealthStatus,
    runMonitoring
};
