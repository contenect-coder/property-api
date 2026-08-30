require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.property_app_secret_key
);

async function main() {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: process.env.TEST_USER_EMAIL,
    password: process.env.TEST_USER_PASSWORD,
  });

  if (error) {
    console.error('Login failed:', error.message);
    return;
  }

  console.log('Access token:\n', data.session.access_token);
}

main();