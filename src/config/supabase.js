const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAdminKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAdminKey) {
  console.warn('Supabase URL or Admin Key is missing. Check your .env file.');
}

const supabaseAdmin = createClient(supabaseUrl || 'http://localhost', supabaseAdminKey || 'dummy');
const supabaseAnon = createClient(supabaseUrl || 'http://localhost', supabaseAnonKey || 'dummy');

module.exports = { supabaseAdmin, supabaseAnon };
