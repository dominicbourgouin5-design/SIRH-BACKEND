// notificationService.js
// Service centralisé pour les notifications

const supabase = require('./supabaseClient');
const { sendPushNotification } = require('./utils');

// Types de notifications
const NOTIFICATION_TYPES = {
    REMINDER_CHECK_IN: 'REMINDER_CHECK_IN',
    REMINDER_CHECK_OUT: 'REMINDER_CHECK_OUT',
    WEATHER_ALERT: 'WEATHER_ALERT',
    LEAVE_APPROVED: 'LEAVE_APPROVED',
    LEAVE_REJECTED: 'LEAVE_REJECTED',
    PAYSLIP_READY: 'PAYSLIP_READY',
    CONTRACT_EXPIRING: 'CONTRACT_EXPIRING',
    NEW_MESSAGE: 'NEW_MESSAGE'
};

// Envoyer une notification à un utilisateur
async function notifyUser(userId, title, body, type, data = {}) {
    try {
        await sendPushNotification(userId, title, body, '/#my-profile');
        
        // Enregistrer dans la table notifications (optionnel)
        await supabase.from('notifications').insert([{
            user_id: userId,
            type: type,
            title: title,
            body: body,
            data: data,
            is_read: false
        }]);
        
        console.log(`📱 Notification envoyée à ${userId}: ${title}`);
        return true;
    } catch (error) {
        console.error(`Erreur envoi notification à ${userId}:`, error.message);
        return false;
    }
}

// Envoyer à tous les employés d'un certain type
async function notifyAllByType(employeeType, title, body, type, data = {}) {
    try {
        const { data: employees, error } = await supabase
            .from('employees')
            .select('user_associated_id')
            .eq('employee_type', employeeType)
            .eq('statut', 'Actif');
            
        if (error) throw error;
        
        let sentCount = 0;
        for (const emp of employees) {
            if (emp.user_associated_id) {
                await notifyUser(emp.user_associated_id, title, body, type, data);
                sentCount++;
            }
        }
        
        console.log(`📱 Notification de type ${type} envoyée à ${sentCount} employés`);
        return sentCount;
    } catch (error) {
        console.error('Erreur notification groupe:', error.message);
        return 0;
    }
}

// Envoyer à tous les utilisateurs sauf un
async function notifyAllExcept(userIdToExclude, title, body, type, data = {}) {
    try {
        const { data: users, error } = await supabase
            .from('app_users')
            .select('id');
            
        if (error) throw error;
        
        let sentCount = 0;
        for (const user of users) {
            if (user.id !== userIdToExclude) {
                await notifyUser(user.id, title, body, type, data);
                sentCount++;
            }
        }
        
        return sentCount;
    } catch (error) {
        console.error('Erreur notification groupe:', error.message);
        return 0;
    }
}

// Rappel de pointage du matin
async function sendMorningReminder() {
    const hour = new Date().getHours();
    let message = "";
    
    if (hour < 10) {
        message = "Bonjour ! N'oubliez pas de pointer votre arrivée. 🌅";
    } else if (hour < 14) {
        message = "Petit rappel : votre pointage d'arrivée est toujours en attente. ⏰";
    } else {
        message = "Dernier rappel : pensez à pointer votre arrivée. ⚠️";
    }
    
    await notifyAllByType('OFFICE', '📌 Rappel Pointage', message, NOTIFICATION_TYPES.REMINDER_CHECK_IN);
    await notifyAllByType('MOBILE', '📍 Rappel Visite', "Pensez à démarrer votre première visite de la journée.", NOTIFICATION_TYPES.REMINDER_CHECK_IN);
}

// Rappel de pointage du soir
async function sendEveningReminder() {
    await notifyAllByType('OFFICE', '🏁 Fin de journée', "N'oubliez pas de pointer votre sortie avant de partir. Bonne soirée !", NOTIFICATION_TYPES.REMINDER_CHECK_OUT);
    await notifyAllByType('MOBILE', '📋 Bilan journalier', "Pensez à soumettre votre bilan de la journée.", NOTIFICATION_TYPES.REMINDER_CHECK_OUT);
}

// Alerte météo (simulation - à connecter à une API météo réelle)
async function sendWeatherAlert() {
    // Simulation : à remplacer par appel API météo
    const mockWeather = {
        condition: 'pluie',
        temperature: 25,
        alert: 'Risque d\'orages cet après-midi'
    };
    
    if (mockWeather.condition === 'pluie' || mockWeather.condition === 'orage') {
        await notifyAllByType('MOBILE', 
            '🌧️ Alerte Météo', 
            `${mockWeather.alert}. Prévoyez un parapluie et soyez prudents sur la route.`,
            NOTIFICATION_TYPES.WEATHER_ALERT,
            { weather: mockWeather }
        );
    }
}

// Notification pour validation de congé
async function notifyLeaveDecision(employeeId, employeeName, decision, days, type) {
    const userAssociated = await getUserAssociatedId(employeeId);
    if (!userAssociated) return;
    
    if (decision === 'Validé') {
        await notifyUser(userAssociated, 
            '✅ Congé Approuvé', 
            `Votre demande de ${type} (${days} jours) a été approuvée.`,
            NOTIFICATION_TYPES.LEAVE_APPROVED,
            { days, type }
        );
    } else {
        await notifyUser(userAssociated,
            '❌ Congé Refusé',
            `Votre demande de ${type} a été refusée. Contactez les RH pour plus d'informations.`,
            NOTIFICATION_TYPES.LEAVE_REJECTED,
            { type }
        );
    }
}

// Helper pour récupérer l'ID utilisateur associé
async function getUserAssociatedId(employeeId) {
    const { data: emp, error } = await supabase
        .from('employees')
        .select('user_associated_id')
        .eq('id', employeeId)
        .single();
    
    if (error || !emp) return null;
    return emp.user_associated_id;
}

module.exports = {
    NOTIFICATION_TYPES,
    notifyUser,
    notifyAllByType,
    notifyAllExcept,
    sendMorningReminder,
    sendEveningReminder,
    sendWeatherAlert,
    notifyLeaveDecision
};
