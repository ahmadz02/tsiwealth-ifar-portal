let ADMIN_USER = null;

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
}

function showAdminToast(message, error = false) {
  const box = document.getElementById('admin-toast');
  if (!box) return;
  box.textContent = message;
  box.className = `fixed right-5 bottom-5 z-50 px-4 py-3 rounded-xl shadow-xl text-sm text-white ${error ? 'bg-rose-600' : 'bg-slate-900'}`;
  setTimeout(() => box.classList.add('hidden'), 4000);
}

async function requireSuperAdmin() {
  const { data, error } = await supabaseClient.auth.getUser();
  if (error || !data?.user) {
    window.location.replace('../login.html');
    return null;
  }
  const check = await supabaseClient.rpc('is_super_admin');
  if (check.error || check.data !== true) {
    window.location.replace('../index.html');
    return null;
  }
  ADMIN_USER = data.user;
  const email = document.getElementById('admin-email');
  if (email) email.textContent = ADMIN_USER.email || '';
  return ADMIN_USER;
}

async function adminLogout() {
  await supabaseClient.auth.signOut();
  window.location.replace('../login.html');
}

function adminDate(value) {
  return value ? new Date(value).toLocaleString('en-MY', { dateStyle:'medium', timeStyle:'short' }) : '—';
}

function adminMoney(value) {
  return new Intl.NumberFormat('en-MY', { style:'currency', currency:'MYR' }).format(Number(value) || 0);
}

