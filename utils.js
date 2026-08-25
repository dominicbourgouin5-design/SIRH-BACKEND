const axios = require("axios");
const supabase = require("./supabaseClient");
const webpush = require('web-push');
const Jimp = require('jimp');
const { getCache, setCache, clearCache } = require('./memoryCache');

// ============================================================
// FONCTIONS DE DATE
// ============================================================

// Fonction pour calculer la date de fin (Date début + nombre de jours)
const getEndDate = (startDate, days) => {
  if (!startDate || !days) return null;
  const date = new Date(startDate);
  date.setDate(date.getDate() + parseInt(days));
  return date.toISOString().split("T")[0];
};

// ============================================================
// FONCTIONS DE SÉCURITÉ ET PERMISSIONS
// ============================================================

async function isTargetAuthorized(requester, targetId) {
  // 1. Si le demandeur est ADMIN ou RH, il a tous les droits
  if (requester.permissions?.can_see_employees) return true;

  // 2. Si c'est l'utilisateur lui-même qui agit sur son propre compte
  if (String(requester.emp_id) === String(targetId)) return true;

  // 3. Sinon, on vérifie dans la base de données
  const { data: target } = await supabase
    .from("employees")
    .select("id, hierarchy_path, departement")
    .eq("id", targetId)
    .maybeSingle();

  if (!target) return false;

  // A. Est-ce que la cible est dans ma lignée descendante ?
  const isUnderMe = target.hierarchy_path?.startsWith(
    requester.hierarchy_path + "/",
  );

  // B. Est-ce que la cible est dans mon Scope (Département) ?
  const isInMyScope = requester.management_scope?.includes(target.departement);

  return isUnderMe || isInMyScope;
}

// Fonction pour vérifier une permission spécifique
function checkPerm(req, permissionName) {
  return (
    req.user &&
    req.user.permissions &&
    req.user.permissions[permissionName] === true
  );
}

// ============================================================
// CALCUL AUTO-CLÔTURE
// ============================================================

function calculateAutoClose(startMs, isSecurity) {
  const startDate = new Date(startMs);
  if (isSecurity) {
    // Pour la sécurité/nuit : Forfait de 12 heures de garde
    return startMs + (12 * 60 * 60 * 1000);
  } else {
    // Pour bureau/mobile : Clôture à 18h00 le jour même
    const eighteenHour = new Date(startDate);
    eighteenHour.setHours(18, 0, 0, 0);
    
    // Si l'entrée était déjà après 18h, on accorde 1h symbolique, sinon 18h
    return (startDate.getTime() >= eighteenHour.getTime()) 
      ? startDate.getTime() + (60 * 60 * 1000) 
      : eighteenHour.getTime();
  }
}

// ============================================================
// UTILITAIRES GPS
// ============================================================

// Fonction utilitaire pour calculer la distance (Formule de Haversine)
function getDistanceInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Rayon de la terre en mètres
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ============================================================
// AXES DE CONFIGURATION EMPLOYÉ
// ------------------------------------------------------------
// Sélectionne, parmi des lieux candidats, le plus proche dont la distance
// reste dans SON PROPRE rayon configuré. Remplace l'ancienne boucle qui
// écrasait le rayon (1500m forcé pour les bureaux, 100m forcé pour un lieu
// mobile détecté depuis un téléphone) et s'arrêtait au premier lieu trouvé
// au lieu du plus proche.
// ============================================================

function findNearestLocation(userLat, userLon, candidates) {
  let best = null;
  let bestDist = Infinity;
  for (const loc of candidates) {
    const dist = getDistanceInMeters(userLat, userLon, loc.lat, loc.lon);
    const effectiveRadius = (loc.radius !== null && loc.radius !== undefined) ? loc.radius : 100;
    if (dist <= effectiveRadius && dist < bestDist) {
      bestDist = dist;
      best = loc;
    }
  }
  return best;
}

// Dérive les quatre axes (secteur, perimetre_lieux, contenu_pointage, rythme)
// depuis l'ancien employee_type, pour les points d'insertion qui ne les
// reçoivent pas explicitement. Doit rester synchronisé avec le backfill de
// sql/05_axes_configuration_employe.sql.
function deriveAxesFromEmployeeType(employeeType) {
  if (employeeType === 'MOBILE') {
    return { secteur: 'SANTE', perimetre_lieux: 'CATALOGUE_OUVERT', contenu_pointage: 'COMPLET', rythme: 'STANDARD' };
  }
  if (employeeType === 'FIXED' || employeeType === 'SECURITY') {
    return { secteur: 'SECURITE', perimetre_lieux: 'SITES_ASSIGNES', contenu_pointage: 'MINIMAL', rythme: 'GARDE' };
  }
  return { secteur: 'GENERAL', perimetre_lieux: 'UN_LIEU', contenu_pointage: 'MINIMAL', rythme: 'STANDARD' };
}

// ============================================================
// DÉROGATIONS DE PERMISSION PERSONNALISÉES
// ------------------------------------------------------------
// Ces permissions gardent un rayon d'action trop large pour être
// personnalisables employé par employé : configuration système,
// suppression irréversible, accès aux logs de sécurité, gestion des lieux
// mobiles / plannings de tout le monde. Elles restent exclusivement liées
// au rôle, vérifiées par checkPerm (synchrone, jamais checkPermAsync).
// ============================================================

const LOCKED_PERMISSIONS = new Set([
  "can_manage_config",
  "can_delete_employees",
  "can_see_audit",
  "can_manage_mobile_locations",
  "can_manage_schedules",
]);

// Lit les dérogations ACTIVE d'un employé, cache-first (clé
// `perm_overrides:<id>`). Le résultat "aucune dérogation" est mis en cache
// sous forme d'objet aux tableaux vides plutôt que `null`, pour que
// getCache() renvoyant `null` signifie sans ambiguïté "cache manquant",
// jamais "l'employé n'a aucune dérogation".
async function getActiveOverridesForEmployee(empId) {
  const cacheKey = `perm_overrides:${empId}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const { data, error } = await supabase
    .from("permission_overrides")
    .select("permission_name, mode")
    .eq("employee_id", empId)
    .eq("status", "ACTIVE");

  if (error) {
    console.error("Erreur lecture permission_overrides:", error.message);
    return { add: [], remove: [] };
  }

  const result = {
    add: (data || []).filter((o) => o.mode === "ADD").map((o) => o.permission_name),
    remove: (data || []).filter((o) => o.mode === "REMOVE").map((o) => o.permission_name),
  };

  // TTL court (2 min) s'il y a une dérogation réelle à faire respecter au
  // plus près de son expiration, TTL plus long (10 min) sinon : un octroi
  // est un acte rare et volontaire, pas besoin de retaper la base à chaque
  // requête d'un employé qui n'en a jamais eu.
  const ttl = (result.add.length > 0 || result.remove.length > 0) ? 120 : 600;
  setCache(cacheKey, result, ttl);
  return result;
}

function invalidateOverridesCache(empId) {
  clearCache(`perm_overrides:${empId}`);
}

// Variante asynchrone de checkPerm : à utiliser uniquement sur les routes
// où une dérogation individuelle a un sens (congés, remplacements, fiche
// employé) — pas systématiquement, les verrous LOCKED_PERMISSIONS n'ont de
// toute façon jamais de dérogation possible, donc checkPerm() synchrone y
// suffit.
async function checkPermAsync(req, permissionName) {
  const base = checkPerm(req, permissionName);
  const empId = req.user?.emp_id;
  if (!empId || LOCKED_PERMISSIONS.has(permissionName)) return base;

  const overrides = await getActiveOverridesForEmployee(empId);
  if (overrides.remove.includes(permissionName)) return false; // retrait prioritaire
  if (overrides.add.includes(permissionName)) return true;
  return base;
}

// ============================================================
// ENVOI D'EMAILS (BREVO)
// ============================================================

// Envoi d'email simple (HTML uniquement)
async function sendEmailAPI(toEmail, subject, htmlContent) {
  try {
    await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      {
        sender: {
          name: process.env.MAIL_FROM_NAME || "SIRH SECURE",
          email: process.env.MAIL_FROM_EMAIL || "nevillebouchard98@gmail.com",
        },
        to: [{ email: toEmail }],
        subject: subject,
        htmlContent: htmlContent,
      },
      {
        headers: {
          "api-key": (process.env.BREVO_API_KEY || "").trim(),
          "Content-Type": "application/json",
        },
      },
    );
    console.log(`✅ Mail envoyé avec succès à ${toEmail}`);
    return true;
  } catch (error) {
    console.error(
      "❌ Échec envoi API Brevo:",
      error.response ? error.response.data : error.message,
    );
    return false;
  }
}

// Envoi d'email avec pièces jointes (pour rapports Excel)
async function sendEmailWithAttachment(toEmail, subject, htmlContent, attachments = []) {
  try {
    const payload = {
      sender: { name: "SIRH SECURE", email: "nevillebouchard98@gmail.com" },
      to: [{ email: toEmail }],
      subject: subject,
      htmlContent: htmlContent,
    };
    
    // Ajouter les pièces jointes si présentes
    if (attachments && attachments.length > 0) {
      payload.attachment = attachments;
    }
    
    await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      payload,
      {
        headers: {
          "api-key": (process.env.BREVO_API_KEY || "").trim(),
          "Content-Type": "application/json",
        },
      },
    );
    console.log(`✅ Email avec ${attachments.length} pièce(s) jointe(s) envoyé à ${toEmail}`);
    return true;
  } catch (error) {
    console.error(
      "❌ Échec envoi email avec pièce jointe:",
      error.response ? error.response.data : error.message,
    );
    return false;
  }
}

// ============================================================
// MODULES
// ============================================================

// Fonction pour vérifier si un module est actif
async function isModuleActive(moduleKey) {
  const { data } = await supabase
    .from("company_modules")
    .select("is_active")
    .eq("module_key", moduleKey)
    .single();
  return data ? data.is_active : false;
}

// ============================================================
// NOTIFICATIONS PUSH
// ============================================================

/**
 * Envoie une notification Push à un utilisateur spécifique
 */
async function sendPushNotification(userId, title, body, url = '/') {
  // 1. Récupérer tous les abonnements (téléphones/PC) de cet utilisateur
  const { data: subs, error } = await supabase
    .from('push_subscriptions')
    .select('*')
    .eq('user_id', userId);

  if (error || !subs || subs.length === 0) return;

  // 2. Créer le message
  const payload = JSON.stringify({ title, body, url });

  // 3. Envoyer à chaque appareil enregistré
  const tasks = subs.map(sub => {
    const pushConfig = {
      endpoint: sub.endpoint,
      keys: { auth: sub.auth, p256dh: sub.p256dh }
    };

    return webpush.sendNotification(pushConfig, payload).catch(err => {
      // Si le token n'est plus valide (app désinstallée), on nettoie la base
      if (err.statusCode === 410 || err.statusCode === 404) {
        return supabase.from('push_subscriptions').delete().eq('id', sub.id);
      }
      console.error("Erreur d'envoi Push :", err);
    });
  });

  await Promise.all(tasks);
}

// ============================================================
// WATERMARK (AJOUT DE FILIGRANE SUR LES PHOTOS)
// ============================================================

async function addWatermark(buffer, gps, nomAgent) {
  try {
    // 1. Charger l'image
    const image = await Jimp.read(buffer);
    
    // 2. Préparer les textes (sécurité si données vides)
    const name = (nomAgent || "Agent Inconnu").toUpperCase();
    const coords = (gps && gps !== "0,0") ? `GPS: ${gps}` : "GPS NON DISPONIBLE";
    const date = new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Porto-Novo' });
    
    const watermarkText = `SIRH SECURE | ${name} | ${coords} | ${date}`;

    // 3. Définir la taille du bandeau en fonction de l'image (5% de la hauteur)
    const imgW = image.bitmap.width;
    const imgH = image.bitmap.height;
    const bannerH = Math.max(40, Math.round(imgH * 0.05)); 

    // 4. Créer le bandeau de fond (Noir élégant, 70% opacité)
    const banner = new Jimp(imgW, bannerH, '#000000b3');

    // 5. Charger la police (S'adapte : petite si image étroite, normale sinon)
    const font = (imgW < 600) ? Jimp.FONT_SANS_12_WHITE : Jimp.FONT_SANS_16_WHITE;
    const loadedFont = await Jimp.loadFont(font);

    // 6. Fusionner le tout
    // On place le bandeau tout en bas
    image.composite(banner, 0, imgH - bannerH);
    
    // On écrit le texte centré verticalement dans le bandeau
    image.print(
      loadedFont,
      20, // Marge gauche
      imgH - (bannerH / 2) - 8, // Centrage vertical approximatif
      watermarkText
    );

    // 7. Retourner l'image traitée en JPEG (qualité 80% pour économiser du stockage)
    return await image.quality(80).getBufferAsync(Jimp.MIME_JPEG);

  } catch (error) {
    console.error("❌ Echec Watermark, renvoi image brute :", error.message);
    return buffer; // En cas de bug, on ne bloque pas l'agent, on envoie l'image sans texte
  }
}

// ============================================================
// ============================================================
// PAGINATION COMPLÈTE
// ============================================================

/**
 * Récupère TOUTES les lignes d'une requête Supabase, page par page.
 *
 * PostgREST plafonne chaque réponse à 1000 lignes, sans erreur ni
 * avertissement : une agrégation sur un mois entier de pointages était donc
 * silencieusement tronquée dès que le volume dépassait ce seuil, et les
 * totaux d'heures s'en trouvaient faux.
 *
 * `buildQuery` doit être une fonction qui construit la requête à neuf à
 * chaque appel : un query builder Supabase ne peut pas être rejoué après
 * avoir été attendu. La requête doit comporter un `.order()` stable, sans
 * quoi la pagination peut renvoyer deux fois la même ligne.
 *
 *   const lignes = await fetchAllRows(() =>
 *     supabase.from('pointages').select('*').gte('heure', debut).order('heure')
 *   );
 */
async function fetchAllRows(buildQuery, options = {}) {
  const pageSize = options.pageSize || 1000;
  const maxRows = options.maxRows || 50000;
  const resultats = [];

  for (let debut = 0; debut < maxRows; debut += pageSize) {
    const { data, error } = await buildQuery().range(debut, debut + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;

    resultats.push(...data);
    if (data.length < pageSize) break;
  }

  if (resultats.length >= maxRows) {
    console.warn(`⚠️ fetchAllRows a atteint le plafond de ${maxRows} lignes : résultat possiblement incomplet.`);
  }

  return resultats;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  fetchAllRows,
  getEndDate,
  isTargetAuthorized,
  checkPerm,
  getDistanceInMeters,
  findNearestLocation,
  deriveAxesFromEmployeeType,
  LOCKED_PERMISSIONS,
  checkPermAsync,
  getActiveOverridesForEmployee,
  invalidateOverridesCache,
  sendEmailAPI,
  sendEmailWithAttachment,
  isModuleActive,
  sendPushNotification,
  calculateAutoClose,
  addWatermark
};
