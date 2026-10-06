// Motor quotation data access — portal database table "motor_quotations".
// Who may see or change what is enforced by the database (row level security and
// triggers in motor/sql/motor-setup.sql): an IFAR reaches only their own quotations,
// a Super Admin reaches every quotation. Reference number and owner are set by the database.
const MOTOR_TABLE = 'motor_quotations';

// Columns written from the form on create / save
const MOTOR_SAVE_FIELDS = ['ifar_name', 'ifar_phone', 'owner_name', 'owner_id_no', 'vehicle_reg_no', 'vehicle_type', 'vehicle_model',
  'engine_capacity', 'usage_type', 'vehicle_address', 'prospect_email', 'prospect_phone', 'ncd', 'coverage_term',
  'coverage_start', 'coverage_end', 'quotes', 'selected_quote'];

function motorRecord(input) {
  const out = {};
  MOTOR_SAVE_FIELDS.forEach(k => {
    const v = input?.[k];
    if (k === 'quotes') out[k] = Array.isArray(v) ? v : [];
    else if (k === 'selected_quote') out[k] = v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    else if (k === 'coverage_start' || k === 'coverage_end') out[k] = /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null;
    else out[k] = v == null || String(v).trim() === '' ? null : String(v).trim();
  });
  return out;
}

async function motorAuditEntry(action) {
  const { data } = await supabaseClient.auth.getUser();
  return { action, timestamp: new Date().toISOString(), by: data?.user?.email || '' };
}

const MOTOR_NOT_FOUND = 'Quotation not found. It may have been deleted, or it belongs to another account.';

// Returns { data, error } like supabase-js
async function motorApi(action, payload = {}) {
  try {
    const db = supabaseClient;
    const fail = message => ({ data: null, error: { message } });
    const dbError = error => fail(error.code === '23505' && /renewed_from/.test(error.message || '')
      ? 'A renewal quotation already exists for this quotation.'
      : (error.message || 'Database error.'));
    const loadRow = async id => {
      const q = await db.from(MOTOR_TABLE).select('*').eq('id', id).maybeSingle();
      if (q.error) return { error: q.error };
      if (!q.data) return { missing: true };
      return { row: q.data };
    };
    // Changes the row only while it still has one of the expected statuses
    const updateIf = async (row, statuses, changes, conflictMsg) => {
      const q = await db.from(MOTOR_TABLE).update(changes).eq('id', row.id).in('status', statuses).select('*');
      if (q.error) return dbError(q.error);
      if (!q.data?.length) return fail(conflictMsg);
      return { data: q.data[0], error: null };
    };
    const withRow = async fn => {
      const r = await loadRow(payload.id);
      if (r.error) return dbError(r.error);
      if (r.missing) return fail(MOTOR_NOT_FOUND);
      return fn(r.row);
    };
    const appended = async (row, text) => [...(Array.isArray(row.audit_log) ? row.audit_log : []), await motorAuditEntry(text)];

    switch (action) {
      case 'list': {
        let q = db.from(MOTOR_TABLE).select('*').order('created_at', { ascending: false });
        // IFAR page: own quotations only (also when an admin opens the IFAR page)
        if (payload.scope !== 'ADMIN') {
          const { data } = await db.auth.getUser();
          q = q.eq('workspace', 'IFAR').eq('created_by', data?.user?.id || '');
        }
        const r = await q;
        return r.error ? dbError(r.error) : { data: r.data || [], error: null };
      }

      case 'get':
        return withRow(row => ({ data: row, error: null }));

      case 'create': {
        let renewedFrom = null;
        if (payload.renewed_from) {
          const p = await loadRow(payload.renewed_from);
          if (p.error) return dbError(p.error);
          if (p.missing) return fail(MOTOR_NOT_FOUND);
          if (p.row.renewal_id) return fail(`A renewal quotation (${p.row.renewal_ref}) already exists for ${p.row.reference_no}.`);
          renewedFrom = p.row.id;
        }
        const insert = {
          ...motorRecord(payload.record),
          workspace: payload.scope === 'ADMIN' ? 'ADMIN' : 'IFAR',
          status: 'QUOTED',
          quotation_date: new Date().toISOString(),
          renewed_from: renewedFrom,
          audit_log: [await motorAuditEntry(renewedFrom ? 'Renewal quotation created' : 'Quotation created')]
        };
        const r = await db.from(MOTOR_TABLE).insert(insert).select('*').single();
        return r.error ? dbError(r.error) : { data: r.data, error: null };
      }

      case 'update':
        return withRow(async row => updateIf(row, ['QUOTED'],
          { ...motorRecord(payload.record), quotation_date: new Date().toISOString(), audit_log: await appended(row, 'Quotation saved') },
          'This quotation was accepted, declined or deleted in the meantime, so it was not changed.'));

      case 'respond': {
        const status = payload.status === 'ACCEPTED' ? 'ACCEPTED' : payload.status === 'DECLINED' ? 'DECLINED' : '';
        if (!status) return fail('Status must be ACCEPTED or DECLINED.');
        return withRow(async row => updateIf(row, ['QUOTED'],
          { status, responded_at: new Date().toISOString(), audit_log: await appended(row, `Marked as ${status === 'ACCEPTED' ? 'Accepted' : 'Declined'}`) },
          'This quotation was already updated. The list has been refreshed.'));
      }

      case 'undo':
        return withRow(async row => updateIf(row, ['ACCEPTED', 'DECLINED'],
          { status: 'QUOTED', responded_at: null, audit_log: await appended(row, 'Response undone') },
          'This quotation is already awaiting a response.'));

      case 'delete':
        return withRow(async row => {
          const r = await db.from(MOTOR_TABLE).delete().eq('id', row.id).eq('status', 'QUOTED').select('id');
          if (r.error) return dbError(r.error);
          if (!r.data?.length) return fail('Unable to delete. The quotation may have been accepted or declined.');
          return { data: { id: row.id }, error: null };
        });

      default:
        return fail('Unknown action.');
    }
  } catch (err) {
    console.error(err);
    return { data: null, error: { message: 'Unable to reach the database. Check your connection.' } };
  }
}
