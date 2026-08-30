const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  'https://xuevxjlxksbcttbdhjjn.supabase.co',
  'sb_secret_0bbND8yHeNARbf59kyBH_g_eFWXU_lO'
);

async function main() {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: 'sawmiyakumar8@gmail.com',
    password: '123456',
  });

  if (error) {
    console.error('Login failed:', error.message);
    return;
  }

  console.log('Access token:\n', data.session.access_token);
}

main();