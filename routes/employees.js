const express = require("express");
const archiver = require('archiver');
const axios = require('axios');
const router = express.Router();
const supabase = require("../supabaseClient");
const { checkPerm, getEndDate, sendEmailAPI, deriveAxesFromEmployeeType } = require("../utils");
const { getCache, setCache, clearCache } = require('../memoryCache');
const { isValidEmail, isValidPhone, isValidDate, isValidAmount, isValidEmployeeType, isValidPerimetreLieux, isValidContenuPointage, isValidRythme, sanitizeString } = require('../validation');
const {
  normaliserNumeroBenin,
  normaliserIban,
  estIbanBjValide,
} = require("../settlementFormat");

// ============================================================
// COORDONNÉES DE PAIEMENT
// ------------------------------------------------------------
// Le frontend valide déjà à la saisie, mais il n'est pas une garantie : un
// appel direct à l'API contournerait tout. On revalide donc ici, et on
// normalise avant écriture pour que la base ne contienne qu'une seule forme
// de chaque valeur (numéro en 01XXXXXXXX, IBAN sans espaces).
//
// Renvoie { champs, erreurs }. `champs` ne contient que ce qui a été fourni,
// pour rester compatible avec une mise à jour partielle.
//
// ⚠️ Ne jamais journaliser le contenu de `champs` : il porte des IBAN.
// ============================================================
const CHAMPS_PAIEMENT = [
  "mode_paiement_defaut", "iban", "banque_nom", "banque_code",
  "banque_guichet", "bic", "momo_numero", "momo_operateur", "titulaire_compte",
];

function extraireCoordonneesPaiement(source, options = {}) {
  const champs = {};
  const erreurs = [];
  const present = (cle) => source[cle] !== undefined;

  if (present("mode_paiement_defaut")) {
    const mode = source.mode_paiement_defaut;
    if (!["VIREMENT", "MOBILE_MONEY", "ESPECES", "CHEQUE"].includes(mode)) {
      erreurs.push("Mode de paiement invalide.");
    } else {
      champs.mode_paiement_defaut = mode;
    }
  }

  if (present("iban")) {
    const brut = String(source.iban || "").trim();
    if (!brut) {
      champs.iban = null;
    } else {
      const compact = normaliserIban(brut);
      const verif = estIbanBjValide(compact);
      // Un mod-97 douteux passe en avertissement côté saisie : on ne bloque
      // que les erreurs franches (longueur, pays, caractères).
      if (!verif.valide) erreurs.push(verif.raison);
      else champs.iban = compact;
    }
  }

  if (present("momo_numero")) {
    const brut = String(source.momo_numero || "").trim();
    if (!brut) {
      champs.momo_numero = null;
    } else {
      const normalise = normaliserNumeroBenin(brut);
      if (!normalise) {
        erreurs.push("Numéro Mobile Money invalide : 10 chiffres commençant par 01.");
      } else {
        champs.momo_numero = normalise;
      }
    }
  }

  if (present("momo_operateur")) {
    const op = String(source.momo_operateur || "").trim();
    if (!op) champs.momo_operateur = null;
    else if (!["MTN", "MOOV", "CELTIIS"].includes(op)) erreurs.push("Opérateur Mobile Money invalide.");
    else champs.momo_operateur = op;
  }

  for (const cle of ["banque_nom", "banque_code", "banque_guichet", "bic", "titulaire_compte"]) {
    if (present(cle)) {
      const v = String(source[cle] || "").trim();
      champs[cle] = v ? sanitizeString(v) : null;
    }
  }

  // Un paiement mobile money sans opérateur est inexploitable : le fichier
  // partirait chez le mauvais opérateur, ou nulle part.
  const modeCible = champs.mode_paiement_defaut || options.modeExistant;
  if (modeCible === "MOBILE_MONEY" && champs.momo_numero && champs.momo_operateur === null) {
    erreurs.push("Précisez l'opérateur du numéro Mobile Money.");
  }

  return { champs, erreurs };
}
const { hashPassword, generateTempPassword } = require("../password");

// ============================================================
// 1. CRÉATION PROFIL (WRITE)
// ============================================================
router.all("/write", async (req, res) => {
  // Vider le cache quand on crée un employé
  await clearCache('read_*');
  
  if (!checkPerm(req, "can_create_profiles")) {
    return res.status(403).json({ error: "Accès refusé à la création de profils" });
  }

  // NETTOYAGE DES DOUBLONS
  if (Array.isArray(req.body.contract_template_id)) {
    req.body.contract_template_id = req.body.contract_template_id[0];
  }

  const body = req.body;
  
  // VALIDATION DES DONNÉES
  if (!body.nom || body.nom.length < 2) {
    return res.status(400).json({ error: "Le nom est requis (minimum 2 caractères)" });
  }
  
  if (!body.email || !isValidEmail(body.email)) {
    return res.status(400).json({ error: "Email invalide" });
  }
  
  if (body.telephone && !isValidPhone(body.telephone)) {
    return res.status(400).json({ error: "Numéro de téléphone invalide" });
  }
  
  if (!body.date || !isValidDate(body.date)) {
    return res.status(400).json({ error: "Date d'embauche invalide" });
  }
  
  if (body.salaire_fixe && !isValidAmount(body.salaire_fixe)) {
    return res.status(400).json({ error: "Salaire invalide" });
  }
  
  if (body.employee_type && !isValidEmployeeType(body.employee_type)) {
    return res.status(400).json({ error: "Type d'employé invalide" });
  }

  if (body.perimetre_lieux && !isValidPerimetreLieux(body.perimetre_lieux)) {
    return res.status(400).json({ error: "Périmètre de lieux invalide" });
  }
  if (body.contenu_pointage && !isValidContenuPointage(body.contenu_pointage)) {
    return res.status(400).json({ error: "Contenu de pointage invalide" });
  }
  if (body.rythme && !isValidRythme(body.rythme)) {
    return res.status(400).json({ error: "Rythme invalide" });
  }

  console.log("📥 Création profil pour :", sanitizeString(body.nom));

  let uploadedDocs = {
    photo_url: null,
    id_card_url: null,
    cv_url: null,
    diploma_url: null,
    attestation_url: null,
  };

  // Gestion des fichiers
  if (req.files && req.files.length > 0) {
    for (const file of req.files) {
      const fileExt = file.originalname.split(".").pop();
      const fileName = `DOC_${file.fieldname.toUpperCase()}_${body.nom.replace(/\s/g, "_")}_${Date.now()}.${fileExt}`;
      const { error } = await supabase.storage
        .from("documents")
        .upload(fileName, file.buffer, { contentType: file.mimetype });
      if (!error) {
        const { data } = supabase.storage.from("documents").getPublicUrl(fileName);
        if (file.fieldname === "photo") uploadedDocs.photo_url = data.publicUrl;
        if (file.fieldname === "id_card") uploadedDocs.id_card_url = data.publicUrl;
        if (file.fieldname === "cv") uploadedDocs.cv_url = data.publicUrl;
        if (file.fieldname === "diploma") uploadedDocs.diploma_url = data.publicUrl;
        if (file.fieldname === "attestation") uploadedDocs.attestation_url = data.publicUrl;
      }
    }
  }

  // Mot de passe temporaire cryptographiquement sûr : Math.random()
  // est prédictible et ne doit jamais servir à générer un secret.
  const generatedPassword = generateTempPassword();

  // Création dans app_users
  const { data: newUser, error: uErr } = await supabase
    .from("app_users")
    .insert([{ email: body.email, password: await hashPassword(generatedPassword), nom_complet: body.nom }])
    .select()
    .single();

  if (uErr) {
    console.error("Erreur app_users:", uErr.message);
    return res.json({ error: "Email déjà utilisé ou erreur base de données" });
  }

  // Génération du matricule
  const { data: nextMatricule, error: seqErr } = await supabase.rpc("get_next_formatted_matricule");
  if (seqErr) throw new Error("Erreur de génération de matricule");
  
  const daysLimit = body.limit || "365";
  const axisDefaults = deriveAxesFromEmployeeType(body.employee_type || "OFFICE");

  const verifPaiement = extraireCoordonneesPaiement(body);
  if (verifPaiement.erreurs.length > 0) {
    return res.status(400).json({ error: verifPaiement.erreurs.join(" ") });
  }
  const coordonneesPaiement = verifPaiement.champs;

  // Insertion dans employees
  const { data: newEmp, error: empErr } = await supabase
    .from("employees")
    .insert([
      {
        user_associated_id: newUser.id,
        matricule: nextMatricule,
        nom: sanitizeString(body.nom),
        email: body.email,
        telephone: body.telephone,
        adresse: sanitizeString(body.adresse),
        poste: sanitizeString(body.poste),
        departement: body.dept,
        role: body.role || "EMPLOYEE",
        employee_type: body.employee_type || "OFFICE",
        secteur: sanitizeString(body.secteur) || axisDefaults.secteur,
        perimetre_lieux: body.perimetre_lieux || axisDefaults.perimetre_lieux,
        contenu_pointage: body.contenu_pointage || axisDefaults.contenu_pointage,
        rythme: body.rythme || axisDefaults.rythme,
        ...coordonneesPaiement,
        statut: "Actif",
        date_embauche: body.date,
        date_fin_contrat: getEndDate(body.date, daysLimit),
        type_contrat: body.limit === "365" ? "CDI" : body.limit === "180" ? "CDD" : "Essai",
        solde_conges: 25,
        photo_url: uploadedDocs.photo_url,
        id_card_url: uploadedDocs.id_card_url,
        cv_url: uploadedDocs.cv_url,
        diploma_url: uploadedDocs.diploma_url,
        attestation_url: uploadedDocs.attestation_url,
        manager_id: body.manager_id === "" ? null : body.manager_id,
        management_scope: body.scope ? JSON.parse(body.scope) : [],
        civilite: body.civilite,
        salaire_brut_fixe: parseFloat(body.salaire_fixe) || 0,
        indemnite_transport: parseFloat(body.indemnite_transport) || 0,
        indemnite_logement: parseFloat(body.indemnite_logement) || 0,
        temps_travail: body.temps_travail,
        duree_essai: body.duree_essai,
        lieu_signature: body.lieu_signature,
        contract_template_id: body.contract_template_id && body.contract_template_id !== "" ? body.contract_template_id : null,
        lieu_naissance: sanitizeString(body.lieu_naissance),
        nationalite: sanitizeString(body.nationalite),
      },
    ])
    .select()
    .single();

  if (empErr) {
    console.error("Erreur employees:", empErr.message);
    throw empErr;
  }

  // Calcul du hierarchy_path
  let path = String(newEmp.id);
  if (body.manager_id && body.manager_id !== "") {
    const { data: manager } = await supabase
      .from("employees")
      .select("hierarchy_path")
      .eq("id", body.manager_id)
      .single();
    if (manager && manager.hierarchy_path) {
      path = `${manager.hierarchy_path}/${newEmp.id}`;
    }
  }
  await supabase.from("employees").update({ hierarchy_path: path }).eq("id", newEmp.id);

  // Envoi de l'email de bienvenue
  const emailSujet = `Bienvenue chez SIRH SECURE - Vos accès`;
  const emailHtml = `
  <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #1e293b; max-width: 600px; margin: auto; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden;">
      <div style="background-color: #0f172a; padding: 30px; text-align: center;">
          <img src="https://cdn-icons-png.flaticon.com/512/9752/9752284.png" style="width: 70px; height: 70px;">
          <h1 style="color: #ffffff; margin: 10px 0 0 0; font-size: 20px; letter-spacing: 2px; text-transform: uppercase;">SIRH SECURE</h1>
      </div>
      <div style="padding: 40px; line-height: 1.6;">
          <h2 style="color: #0f172a; margin-top: 0;">Félicitations ${sanitizeString(body.nom)} !</h2>
          <p>Votre profil collaborateur a été créé avec succès dans notre système de gestion.</p>
          <p>Vous pouvez désormais accéder à votre portail sécurisé pour gérer vos pointages, vos congés et consulter vos documents RH.</p>
          
          <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 25px; margin: 30px 0;">
              <p style="margin-top: 0; font-weight: bold; color: #64748b; font-size: 12px; text-transform: uppercase;">Vos identifiants d'accès</p>
              <p style="margin: 10px 0;">🔗 <b>Lien :</b> <a href="https://sirh.cataria-systems.com" style="color: #2563eb; text-decoration: none;">Accéder au Portail</a></p>
              <p style="margin: 10px 0;">👤 <b>Identifiant :</b> <span style="font-family: monospace;">${body.email}</span></p>
              <p style="margin: 10px 0;">🔑 <b>Mot de passe :</b> <span style="font-family: monospace; background: #e2e8f0; padding: 2px 6px; border-radius: 4px;">${generatedPassword}</span></p>
          </div>

          <p style="font-size: 14px; color: #64748b;"><i>Note : Par mesure de sécurité, nous vous conseillons de modifier votre mot de passe dès votre première connexion.</i></p>
      </div>
      <div style="background-color: #f1f5f9; padding: 20px; text-align: center; font-size: 11px; color: #94a3b8;">
          &copy; 2026 SIRH SECURE - Système de Gestion RH Intégré
      </div>
  </div>`;

  await sendEmailAPI(body.email, emailSujet, emailHtml);

  return res.json({ status: "success" });
});

// ============================================================
// 2. LECTURE DES EMPLOYÉS (READ) AVEC CACHE
// ============================================================
router.all("/read", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  const search = req.query.search || "";
  const status = req.query.status || "all";
  const type = req.query.type || "all";
  const dept = req.query.dept || "all";
  const targetId = req.query.target_id || "";
  const roleFilter = req.query.role || "all";

  // Créer une clé de cache unique
  const cacheKey = `read_${page}_${limit}_${search}_${status}_${type}_${dept}_${roleFilter}_${targetId}`;
  
  // Essayer de lire depuis le cache
  const cachedData = await getCache(cacheKey);
  if (cachedData) {
    console.log(`📦 Cache hit: ${cacheKey}`);
    return res.json(cachedData);
  }

  try {
    const currentUserId = req.user.emp_id;

    const { data: requester } = await supabase
      .from("employees")
      .select("hierarchy_path, management_scope")
      .eq("id", currentUserId)
      .single();

    if (targetId) {
      if (!checkPerm(req, "can_see_employees")) {
        if (String(targetId) === String(currentUserId)) {
          // Accès autorisé à soi-même
        } else {
          let idorQuery = supabase.from("employees").select("id").eq("id", targetId);
          let idorConditions = [];

          if (requester && requester.hierarchy_path) {
            idorConditions.push(`hierarchy_path.ilike.${requester.hierarchy_path}/%`);
          }

          if (requester && requester.management_scope?.length > 0) {
            const scopeList = `(${requester.management_scope.map((s) => `"${s}"`).join(",")})`;
            idorConditions.push(`departement.in.${scopeList}`);
          }

          if (idorConditions.length > 0) {
            const { data: checkAccess } = await idorQuery.or(idorConditions.join(",")).maybeSingle();
            if (!checkAccess) {
              return res.status(403).json({ error: "Accès refusé : Profil hors périmètre." });
            }
          } else {
            return res.status(403).json({ error: "Accès refusé : Aucun périmètre défini." });
          }
        }
      }
    }

    let columns = "id, nom, matricule, poste, departement, statut, role, photo_url, employee_type, secteur, perimetre_lieux, contenu_pointage, rythme, date_embauche, type_contrat, solde_conges, hierarchy_path, management_scope, manager_id, date_naissance, email, telephone, adresse, contract_status, contrat_pdf_url, cv_url, id_card_url, diploma_url, attestation_url, lm_url";
    
    if (checkPerm(req, "can_see_payroll")) {
      columns += ", salaire_brut_fixe, indemnite_transport, indemnite_logement";
    }

    // Les coordonnées bancaires ne sortent que pour qui a le droit de les
    // voir : sans ça, la liste des employés exposerait tous les IBAN.
    if (checkPerm(req, "can_see_payment_details")) {
      columns += ", mode_paiement_defaut, iban, banque_nom, banque_code, banque_guichet, bic, momo_numero, momo_operateur, titulaire_compte, coord_paiement_maj_at";
    }

    let query = supabase.from("employees").select(columns, { count: "exact" });

    if (checkPerm(req, "can_see_employees")) {
      // Voit tout
    } else if (req.user.role === "MANAGER" && requester) {
      let conditions = [];
      const myPath = requester.hierarchy_path;
      conditions.push(`hierarchy_path.eq.${myPath}`);
      conditions.push(`hierarchy_path.ilike.${myPath}/%`);

      if (requester.management_scope?.length > 0) {
        const scopeList = `(${requester.management_scope.map((s) => `"${s}"`).join(",")})`;
        conditions.push(`departement.in.${scopeList}`);
      }
      query = query.or(conditions.join(","));
    } else {
      query = query.eq("id", currentUserId);
    }

    if (targetId) query = query.eq("id", targetId);
    if (search) query = query.or(`nom.ilike.%${search}%,matricule.ilike.%${search}%`);
    if (status !== "all") {
      if (status === "Actif") {
        query = query.in("statut", ["Actif", "En Poste"]);
      } else {
        query = query.eq("statut", status);
      }
    }
    if (type !== "all") query = query.eq("employee_type", type);
    if (dept !== "all") query = query.eq("departement", dept);
    if (roleFilter !== "all") query = query.eq("role", roleFilter);

    const { data, error, count } = await query
      .order("nom", { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    
    const result = {
      data,
      meta: { total: count, page: page, last_page: Math.ceil(count / limit) },
    };
    
    // Sauvegarder en cache (60 secondes)
    await setCache(cacheKey, result, 60);
    
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 3. MISE À JOUR PROFIL (EMP-UPDATE)
// ============================================================
router.all("/emp-update", async (req, res) => {
  const { id, email, phone, address, dob, doc_type } = req.body;

  // Récupérer l'agent correctement
  const agentName = req.user?.nom || req.body.agent || "Employé";
  const agentRole = req.user?.role || req.body.agent_role || "EMPLOYEE";

  const requesterId = String(req.user?.emp_id || req.body.emp_id);
  const targetId = String(id);
  const isOwner = requesterId === targetId;
  const isRH = req.user?.permissions?.can_see_employees === true;

  console.log(`📝 Update ID ${targetId} (Type: ${doc_type}) par ${agentName} (Rôle: ${agentRole})`);

  if (!isOwner && !isRH) {
    console.error(`🚫 Accès refusé: ${agentName} tente de modifier ${targetId}`);
    return res.status(403).json({ error: "Interdit : Vous ne pouvez modifier que votre profil." });
  }

  const allowedForEmployee = ["text_update", "id_card", "photo"];

  if (!isRH && !allowedForEmployee.includes(doc_type)) {
    console.error("🚫 Bloqué : L'employé tente de modifier un document RH");
    return res.status(403).json({ error: "Modification interdite. Ce document est géré par les RH." });
  }

  let updates = {};

  if (email) {
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Email invalide" });
    }
    updates.email = email;
  }
  if (phone) {
    if (!isValidPhone(phone)) {
      return res.status(400).json({ error: "Téléphone invalide" });
    }
    updates.telephone = phone;
  }
  if (address) updates.adresse = sanitizeString(address);
  if (dob) {
    if (!isValidDate(dob)) {
      return res.status(400).json({ error: "Date de naissance invalide" });
    }
    updates.date_naissance = dob;
  }

  if (req.files && req.files.length > 0) {
    const file = req.files[0];
    if (file) {
      const fileExt = file.originalname.split(".").pop();
      const fileName = `UPDATE_${doc_type.toUpperCase()}_ID${targetId}_${Date.now()}.${fileExt}`;
      const { error: storageErr } = await supabase.storage
        .from("documents")
        .upload(fileName, file.buffer, { contentType: file.mimetype });

      if (storageErr) throw storageErr;

      const { data } = supabase.storage.from("documents").getPublicUrl(fileName);

      if (doc_type === "text_update" || doc_type === "photo") updates.photo_url = data.publicUrl;
      else if (doc_type === "id_card") updates.id_card_url = data.publicUrl;
      else if (doc_type === "cv") updates.cv_url = data.publicUrl;
      else if (doc_type === "contrat") updates.contrat_pdf_url = data.publicUrl;
      else if (doc_type === "diploma") updates.diploma_url = data.publicUrl;
      else if (doc_type === "attestation") updates.attestation_url = data.publicUrl;
      
      if (doc_type !== "text_update") {
          await supabase.from("employee_archives").insert([{
              employee_id: targetId,
              doc_type: doc_type,
              file_url: data.publicUrl,
              agent: agentName
          }]);
          console.log(`🗄️ Document archivé : ${doc_type} pour ID ${targetId} par ${agentName}`);
      }
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.json({ status: "success", message: "Aucune modification détectée" });
  }

  const { error } = await supabase.from("employees").update(updates).eq("id", targetId);

  if (error) {
    console.error("❌ Erreur Supabase Update:", error.message);
    throw error;
  }

  return res.json({ status: "success" });
});

// ============================================================
// 4. LIRE L'HISTORIQUE D'UN DOCUMENT
// ============================================================
router.all("/read-archives", async (req, res) => {
  const { employee_id, doc_type } = req.query;
  if (!checkPerm(req, "can_view_employee_files") && req.user.emp_id !== employee_id) {
    return res.status(403).json({ error: "Accès refusé" });
  }
  
  const { data, error } = await supabase
    .from("employee_archives")
    .select("*")
    .eq("employee_id", employee_id)
    .eq("doc_type", doc_type)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

// ============================================================
// 5. MISE À JOUR ADMINISTRATIVE (UPDATE)
// ============================================================
router.all("/update", async (req, res) => {
  // Vider le cache quand on modifie un employé
  await clearCache('read_*');
  
  if (!checkPerm(req, "can_see_employees")) {
    return res.status(403).json({ error: "Accès refusé à l'administration des profils" });
  }

  const q = req.query;
  const id = q.id;
  const agent = q.agent;

  console.log(`🛠️ Mise à jour partielle pour ID ${id} par ${agent}`);

  let updates = {};

  if (q.statut) updates.statut = q.statut;
  if (q.role) updates.role = q.role;
  if (q.dept) updates.departement = q.dept;
  if (q.employee_type) {
    if (!isValidEmployeeType(q.employee_type)) {
      return res.status(400).json({ error: "Type d'employé invalide" });
    }
    updates.employee_type = q.employee_type;
  }
  // Axes en delta pur : changer employee_type sur un employé existant ne doit
  // pas écraser silencieusement des axes déjà personnalisés indépendamment.
  if (q.secteur) updates.secteur = sanitizeString(q.secteur);
  if (q.perimetre_lieux) {
    if (!isValidPerimetreLieux(q.perimetre_lieux)) {
      return res.status(400).json({ error: "Périmètre de lieux invalide" });
    }
    updates.perimetre_lieux = q.perimetre_lieux;
  }
  if (q.contenu_pointage) {
    if (!isValidContenuPointage(q.contenu_pointage)) {
      return res.status(400).json({ error: "Contenu de pointage invalide" });
    }
    updates.contenu_pointage = q.contenu_pointage;
  }
  if (q.rythme) {
    if (!isValidRythme(q.rythme)) {
      return res.status(400).json({ error: "Rythme invalide" });
    }
    updates.rythme = q.rythme;
  }

  // Coordonnées de paiement. Deux garde-fous :
  //   - il faut le droit de les voir pour les modifier ;
  //   - elles sont GELÉES tant qu'un lot de règlement est ouvert pour ce
  //     salarié, pour qu'on ne puisse pas détourner un virement en changeant
  //     le numéro la veille du paiement.
  const champsPaiementFournis = CHAMPS_PAIEMENT.some((c) => q[c] !== undefined);
  if (champsPaiementFournis) {
    if (!checkPerm(req, "can_see_payment_details")) {
      return res.status(403).json({ error: "Accès refusé aux coordonnées de paiement." });
    }

    const { data: ligneVivante } = await supabase
      .from("reglement_lignes")
      .select("id, reference")
      .eq("employee_id", id)
      .in("statut", ["A_PAYER", "EXPORTE"])
      .limit(1)
      .maybeSingle();

    if (ligneVivante) {
      return res.status(409).json({
        error: "Coordonnées gelées : un règlement est en cours pour ce salarié. Clôturez-le avant de les modifier.",
      });
    }

    const { data: existant } = await supabase
      .from("employees")
      .select("mode_paiement_defaut")
      .eq("id", id)
      .maybeSingle();

    const verifPaiement = extraireCoordonneesPaiement(q, {
      modeExistant: existant?.mode_paiement_defaut,
    });
    if (verifPaiement.erreurs.length > 0) {
      return res.status(400).json({ error: verifPaiement.erreurs.join(" ") });
    }

    Object.assign(updates, verifPaiement.champs);
    updates.coord_paiement_maj_at = new Date().toISOString();
    updates.coord_paiement_maj_par = req.user.emp_id;
  }

  if (q.poste) updates.poste = sanitizeString(q.poste);

  if (q.manager_id !== undefined) {
    updates.manager_id = q.manager_id === "null" || q.manager_id === "" ? null : q.manager_id;
  }
  if (q.scope) {
    try {
      updates.management_scope = JSON.parse(q.scope);
    } catch (e) {
      console.error("Erreur parse scope");
    }
  }

  if (q.recalculate_contract === "true") {
    if (!isValidDate(q.start_date)) {
      return res.status(400).json({ error: "Date de début invalide" });
    }
    updates.date_embauche = q.start_date;
    updates.type_contrat = q.limit === "365" ? "CDI" : q.limit === "180" ? "CDD" : "Essai";
    if (typeof getEndDate === "function") {
      updates.date_fin_contrat = getEndDate(q.start_date, q.limit);
    }
  }

  if (q.salaire_brut_fixe !== undefined) {
    if (!isValidAmount(q.salaire_brut_fixe)) {
      return res.status(400).json({ error: "Salaire invalide" });
    }
    updates.salaire_brut_fixe = parseFloat(q.salaire_brut_fixe) || 0;
  }
  if (q.indemnite_transport !== undefined) updates.indemnite_transport = parseFloat(q.indemnite_transport) || 0;
  if (q.indemnite_logement !== undefined) updates.indemnite_logement = parseFloat(q.indemnite_logement) || 0;

  if (q.force_init === "true") {
    updates.solde_conges = 25;
    updates.contract_status = "Non signé";
  }

  const { error } = await supabase.from("employees").update(updates).eq("id", id);

  if (error) {
    console.error("❌ Erreur Supabase Update:", error.message);
    throw error;
  }

  await supabase.from("logs").insert([{
    agent: agent,
    action: "MODIF_ADMIN_PROFIL",
    details: `Champs modifiés pour l'ID ${id} : ${Object.keys(updates).join(", ")}`,
  }]);

  return res.json({ status: "success", message: "Mise à jour effectuée." });
});

// ============================================================
// 6. SUPPRIMER UN EMPLOYÉ
// ============================================================
router.all("/delete-employee", async (req, res) => {
  // Vider le cache quand on supprime un employé
  await clearCache('read_*');
  
  if (!checkPerm(req, "can_delete_employees")) {
    return res.status(403).json({ error: "Accès refusé : Seul l'administrateur peut supprimer un profil." });
  }

  const { id, agent } = req.body;

  try {
    const { data: emp, error: fetchErr } = await supabase
      .from("employees")
      .select("user_associated_id, nom")
      .eq("id", id)
      .single();

    if (fetchErr || !emp) throw new Error("Employé introuvable.");

    const { error: delEmpErr } = await supabase.from("employees").delete().eq("id", id);
    if (delEmpErr) throw delEmpErr;

    if (emp.user_associated_id) {
      await supabase.from("app_users").delete().eq("id", emp.user_associated_id);
    }

    await supabase.from("logs").insert([{
      agent: agent,
      action: "SUPPRESSION_EMPLOYE",
      details: `Suppression définitive de ${emp.nom} (ID: ${id})`,
    }]);

    return res.json({ status: "success" });
  } catch (err) {
    console.error("Erreur suppression:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 7. UPLOAD MASSIF (SCAN D'ARCHIVES)
// ============================================================
router.all("/bulk-upload-docs", async (req, res) => {
  if (!checkPerm(req, "can_see_employees")) {
    return res.status(403).json({ error: "Accès refusé à la gestion documentaire." });
  }

  const empId = req.body.employee_id;
  const agent = req.body.agent || "RH";

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "Aucun fichier reçu." });
  }

  let updates = {};
  let archivesToInsert = [];

  try {
    for (const file of req.files) {
      const docType = file.fieldname;
      const fileExt = file.originalname.split('.').pop();
      const fileName = `ARCHIVE_${docType.toUpperCase()}_ID${empId}_${Date.now()}.${fileExt}`;

      const { error: storageErr } = await supabase.storage
        .from("documents")
        .upload(fileName, file.buffer, { contentType: file.mimetype });

      if (storageErr) {
        console.error(`Erreur upload ${docType}:`, storageErr.message);
        continue;
      }

      const { data } = supabase.storage.from("documents").getPublicUrl(fileName);
      const fileUrl = data.publicUrl;

      updates[`${docType}_url`] = fileUrl;
      if (docType === 'contrat') updates.contrat_pdf_url = fileUrl;

      archivesToInsert.push({
        employee_id: empId,
        doc_type: docType,
        file_url: fileUrl,
        agent: agent
      });
    }

    if (Object.keys(updates).length > 0) {
      await supabase.from("employees").update(updates).eq("id", empId);
    }
    
    if (archivesToInsert.length > 0) {
      await supabase.from("employee_archives").insert(archivesToInsert);
    }

    return res.json({ status: "success", count: archivesToInsert.length });
  } catch (err) {
    console.error("Erreur Bulk Upload:", err.message);
    return res.status(500).json({ error: "Erreur lors de la numérisation massive." });
  }
});

// ============================================================
// 8. EXPORTER TOUT LE DOSSIER EN ZIP
// ============================================================
router.get("/export-folder/:id", async (req, res) => {
  if (!checkPerm(req, "can_view_employee_files") && !checkPerm(req, "can_see_employees")) {
    return res.status(403).json({ error: "Accès refusé" });
  }

  const empId = req.params.id;

  try {
    const [empRes, archivesRes, paieRes, congesRes] = await Promise.all([
      supabase.from("employees").select("*").eq("id", empId).single(),
      supabase.from("employee_archives").select("*").eq("employee_id", empId),
      supabase.from("paie").select("*").eq("employee_id", empId),
      supabase.from("conges").select("*").eq("employee_id", empId),
    ]);

    const emp = empRes.data;
    if (!emp) return res.status(404).json({ error: "Employé introuvable" });

    const cleanName = emp.nom.replace(/[^a-zA-Z0-9]/g, "_");
    const zipFilename = `Dossier_RH_${emp.matricule}_${cleanName}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename=${zipFilename}`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    const addFileToZip = async (url, folderName, customFilename) => {
      if (!url || url === "null" || url.length < 5) return;
      try {
        const response = await axios.get(url, { responseType: 'stream' });
        const ext = url.split('.').pop().split('?')[0] || 'pdf';
        archive.append(response.data, { name: `${folderName}/${customFilename}.${ext}` });
      } catch (e) { console.warn(`Fichier absent: ${customFilename}`); }
    };

    await addFileToZip(emp.photo_url, "0_Identite_et_Photo", "Photo_Profil");

    const dirAdmin = "1_Dossier_Administratif";
    await addFileToZip(emp.contrat_pdf_url, dirAdmin, "Contrat_Actuel");
    await addFileToZip(emp.id_card_url, dirAdmin, "Piece_Identite");
    await addFileToZip(emp.cv_url, dirAdmin, "CV");
    await addFileToZip(emp.diploma_url, dirAdmin, "Diplome");
    await addFileToZip(emp.attestation_url, dirAdmin, "Attestation");

    if (archivesRes.data) {
      for (const arc of archivesRes.data) {
        const date = arc.created_at.split('T')[0];
        await addFileToZip(arc.file_url, "2_Historique_Documents", `${arc.doc_type}_${date}`);
      }
    }

    if (paieRes.data) {
      for (const p of paieRes.data) {
        await addFileToZip(p.fiche_pdf_url, "3_Bulletins_Paie", `Bulletin_${p.annee}_${p.mois}`);
      }
    }

    if (congesRes.data) {
      let recap = `RAPPORT DES CONGÉS - ${emp.nom}\nMatricule: ${emp.matricule}\n\n`;
      for (const c of congesRes.data) {
        recap += `Type: ${c.type} | Date: ${c.date_debut} au ${c.date_fin} | Statut: ${c.statut}\n`;
        recap += `Motif: ${c.motif}\n------------------\n`;
        if (c.justificatif_url) await addFileToZip(c.justificatif_url, "4_Conges_Justificatifs", `Justificatif_${c.date_debut}`);
      }
      archive.append(recap, { name: "4_Conges_Justificatifs/Recapitulatif_Absences.txt" });
    }

    await archive.finalize();

  } catch (err) {
    console.error("Erreur Export ZIP:", err);
    res.status(500).json({ error: "Erreur lors de la création du ZIP." });
  }
});

module.exports = router;
