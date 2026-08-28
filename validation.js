// validation.js
// Validation des données entrantes pour éviter les injections SQL et les données corrompues

// Valide un email
function isValidEmail(email) {
    if (!email) return false;
    const emailRegex = /^[^\s@]+@([^\s@.,]+\.)+[^\s@.,]{2,}$/;
    return emailRegex.test(email);
}

// Valide un ID UUID (format Supabase)
function isValidUUID(id) {
    if (!id) return false;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(id);
}

// Nettoie une chaîne (anti-XSS)
function sanitizeString(str) {
    if (!str) return "";
    if (typeof str !== 'string') return String(str);
    return str
        .replace(/[&<>]/g, (match) => {
            if (match === '&') return '&amp;';
            if (match === '<') return '&lt;';
            if (match === '>') return '&gt;';
            return match;
        })
        .trim();
}

// Valide un numéro de téléphone Bénin (avec ou sans espaces ni séparateurs).
//
// Depuis le 30/11/2024, le plan de numérotation béninois est passé à
// 10 chiffres avec le préfixe 01 : « 97 12 34 56 » s'écrit désormais
// « 01 97 12 34 56 ». L'ancienne expression n'acceptait que 8 chiffres et
// rejetait donc tous les numéros actuels, ce qui bloquait la saisie des
// coordonnées Mobile Money.
//
// Les deux formats sont acceptés : le nouveau pour les saisies courantes,
// l'ancien pour ne pas invalider les fiches créées avant la réforme.
function isValidPhone(phone) {
    if (!phone) return true; // Optionnel

    let cleaned = String(phone).replace(/[\s.\-()]/g, '');
    if (cleaned.startsWith('+229')) cleaned = cleaned.slice(4);
    else if (cleaned.startsWith('00229')) cleaned = cleaned.slice(5);
    else if (cleaned.startsWith('229')) cleaned = cleaned.slice(3);

    // Format actuel : 10 chiffres commençant par 01
    if (/^01[0-9]{8}$/.test(cleaned)) return true;

    // Format historique : 8 chiffres, éventuellement précédés d'un 0
    return /^0?[0-9]{8}$/.test(cleaned);
}

// Valide une date (format YYYY-MM-DD)
function isValidDate(dateStr) {
    if (!dateStr) return false;
    const regex = /^\d{4}-\d{2}-\d{2}$/;
    if (!regex.test(dateStr)) return false;
    const date = new Date(dateStr);
    return !isNaN(date.getTime());
}

// Valide un montant (salaire, prime, etc.)
function isValidAmount(amount) {
    const num = parseFloat(amount);
    return !isNaN(num) && num >= 0 && num <= 100000000; // Max 100 millions
}

// Valide un statut employé
function isValidStatus(status) {
    const validStatuses = ['Actif', 'En Poste', 'Congé', 'Sortie', 'Vacances'];
    return validStatuses.includes(status);
}

// Valide un type d'employé
function isValidEmployeeType(type) {
    const validTypes = ['OFFICE', 'MOBILE', 'FIXED', 'SECURITY'];
    return validTypes.includes(type);
}

// Valide les trois axes de configuration qui pilotent du comportement métier
// (secteur reste volontairement libre, pas de validateur dédié)
function isValidPerimetreLieux(v) {
    return ['UN_LIEU', 'SITES_ASSIGNES', 'CATALOGUE_OUVERT'].includes(v);
}
function isValidContenuPointage(v) {
    return ['MINIMAL', 'COMPLET'].includes(v);
}
function isValidRythme(v) {
    return ['STANDARD', 'GARDE'].includes(v);
}

// Middleware de validation pour les requêtes
function validateRequest(schema) {
    return (req, res, next) => {
        const errors = [];
        
        // Valider les paramètres de requête
        if (schema.query) {
            Object.keys(schema.query).forEach(key => {
                const value = req.query[key];
                const validator = schema.query[key];
                if (value && !validator(value)) {
                    errors.push(`Paramètre '${key}' invalide`);
                }
            });
        }
        
        // Valider le body
        if (schema.body) {
            Object.keys(schema.body).forEach(key => {
                const value = req.body[key];
                const validator = schema.body[key];
                if (value && !validator(value)) {
                    errors.push(`Champ '${key}' invalide`);
                }
            });
        }
        
        if (errors.length > 0) {
            return res.status(400).json({ error: errors.join(', ') });
        }
        
        next();
    };
}

module.exports = {
    isValidEmail,
    isValidUUID,
    sanitizeString,
    isValidPhone,
    isValidDate,
    isValidAmount,
    isValidStatus,
    isValidEmployeeType,
    isValidPerimetreLieux,
    isValidContenuPointage,
    isValidRythme,
    validateRequest
};
