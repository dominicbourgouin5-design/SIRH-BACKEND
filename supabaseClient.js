require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Tentative d'importer ws (sera installé via package.json)
let WebSocket;
try {
  WebSocket = require('ws');
} catch (e) {
  console.log("⚠️ ws package non trouvé, WebSocket désactivé");
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

// Configuration avec ws si disponible
const options = {
  auth: { persistSession: false },
  db: { schema: 'public' }
};

if (WebSocket) {
  options.realtime = { transport: WebSocket };
} else {
  options.realtime = { enabled: false };
}

const supabase = createClient(supabaseUrl, supabaseKey, options);

module.exports = supabase;
