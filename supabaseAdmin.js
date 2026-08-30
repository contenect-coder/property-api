const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.property_app_secret_key;

if (!SUPABASE_URL || !property_app_secret_key) {
  throw new Error("Missing SUPABASE_URL or property_app_secret_key in environment");
}

const supabaseAdmin = createClient(SUPABASE_URL,property_app_secret_key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

module.exports = { supabaseAdmin };