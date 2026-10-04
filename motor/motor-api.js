// Motor quotations live in their own Supabase project. The browser never reads that
// table directly: every call goes to the "motor-gateway" Edge Function, which checks
// the IFAR Portal login (supabaseClient from ../supabase-config.js) and applies the rules.
const MOTOR_PROJECT_URL = 'https://olgijssakwgttfnomnwz.supabase.co';
const MOTOR_PUBLISHABLE_KEY = 'sb_publishable_xMblASeeRQt-UTFxsi9vNw_p4hWUjUP';
const MOTOR_GATEWAY_URL = `${MOTOR_PROJECT_URL}/functions/v1/motor-gateway`;

// Returns { data, error } like supabase-js
async function motorApi(action, payload = {}) {
  try {
    const { data } = await supabaseClient.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) return { data: null, error: { message: 'Your login has expired. Please log in again.', status: 401 } };
    const res = await fetch(MOTOR_GATEWAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: MOTOR_PUBLISHABLE_KEY, 'x-portal-token': token },
      body: JSON.stringify({ action, ...payload })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) return { data: null, error: { message: json.error || `Request failed (${res.status}).`, status: res.status } };
    return { data: json.data, error: null };
  } catch (err) {
    console.error(err);
    return { data: null, error: { message: 'Unable to reach the motor quotation service. Check your connection.', status: 0 } };
  }
}
