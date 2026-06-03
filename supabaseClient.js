require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

// Désactiver Realtime pour éviter l'erreur WebSocket sur Node 18
const supabase = createClient(supabaseUrl, supabaseKey, {
  realtime: { publish: false, subscribe: false },
  db: { schema: 'public' },
  auth: { persistSession: false }
});

module.exports = supabase;
