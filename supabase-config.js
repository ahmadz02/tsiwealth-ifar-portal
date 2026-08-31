const SUPABASE_URL = 'https://xslqmzwgprvwlqsheeug.supabase.co';

const SUPABASE_PUBLISHABLE_KEY =
  'sb_publishable_iw0nPeqspEl2fFKh4JpqRg_Adp_3ZYD';

const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  }
);