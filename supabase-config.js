const SUPABASE_URL = 'https://gtumqglezpgppfxqzwvi.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_3YkAyb5TeyNWKvdBsS23yQ_ggTfqkgN';

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
