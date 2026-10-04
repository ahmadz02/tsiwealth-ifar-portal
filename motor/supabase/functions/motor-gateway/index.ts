// Motor Takaful Quotation gatekeeper.
// Deploy in the MOTOR project (olgijssakwgttfnomnwz) with "Verify JWT" turned OFF —
// the caller's token belongs to the IFAR Portal project and is checked here instead.
//
// Secrets (MOTOR project): PORTAL_SUPABASE_URL, PORTAL_PUBLISHABLE_KEY
// Provided automatically:  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Rules: an IFAR reads/changes only their own quotations (workspace 'IFAR');
// a Super Admin (portal is_super_admin()) reads/changes every quotation.
import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-portal-token',
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type':'application/json' } })

const TABLE = 'motor_proposals'
// Columns the browser may write on create / save. Everything else is set here.
const SAVE_FIELDS = ['ifar_name', 'ifar_phone', 'owner_name', 'owner_id_no', 'vehicle_reg_no', 'vehicle_type', 'vehicle_model',
  'engine_capacity', 'usage_type', 'vehicle_address', 'prospect_email', 'prospect_phone', 'ncd', 'coverage_term',
  'coverage_start', 'coverage_end', 'quotes', 'selected_quote']
const REQUIRED = ['ifar_name', 'ifar_phone', 'owner_name', 'owner_id_no', 'vehicle_reg_no', 'vehicle_type', 'vehicle_model', 'usage_type']
// Columns returned to the browser (payment-slip fields from the old link flow are left out)
const COLUMNS = ['id', 'reference_no', 'workspace', 'created_by', 'created_by_name', 'created_by_email', 'imported',
  ...SAVE_FIELDS, 'status', 'quotation_date', 'responded_at', 'renewed_from', 'renewal_id', 'renewal_ref',
  'audit_log', 'created_at', 'updated_at', 'updated_by_email'].join(',')

const isDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)

function cleanRecord(input: Record<string, unknown>) {
  const out: Record<string, unknown> = {}
  for (const k of SAVE_FIELDS) {
    const v = input?.[k]
    if (k === 'quotes') out[k] = Array.isArray(v) ? v : []
    else if (k === 'selected_quote') out[k] = v && typeof v === 'object' && !Array.isArray(v) ? v : null
    else if (k === 'coverage_start' || k === 'coverage_end') out[k] = isDate(v) ? v : null
    else out[k] = v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, 500)
  }
  const missing = REQUIRED.filter(k => !out[k])
  if (missing.length) throw new HttpError(400, `Missing: ${missing.join(', ')}.`)
  if (!(out.quotes as unknown[]).length) throw new HttpError(400, 'Select at least one Takaful operator.')
  if (JSON.stringify(out).length > 200_000) throw new HttpError(400, 'Quotation is too large.')
  return out
}

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return reply({ error:'Method not allowed.' }, 405)
  try {
    const token = req.headers.get('x-portal-token') || ''
    if (!token) return reply({ error:'Please log in to the IFAR Portal.' }, 401)
    const portalUrl = Deno.env.get('PORTAL_SUPABASE_URL'), portalKey = Deno.env.get('PORTAL_PUBLISHABLE_KEY')
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!portalUrl || !portalKey || !service) return reply({ error:'Function secrets are incomplete.' }, 500)

    // Who is calling? Asked of the IFAR Portal project.
    const portal = createClient(portalUrl, portalKey, { global:{ headers:{ Authorization:`Bearer ${token}` } }, auth:{ persistSession:false } })
    const userResult = await portal.auth.getUser(token)
    if (userResult.error || !userResult.data.user) return reply({ error:'Your login has expired. Please log in again.' }, 401)
    const user = userResult.data.user
    const adminCheck = await portal.rpc('is_super_admin')
    const isAdmin = !adminCheck.error && adminCheck.data === true
    const email = user.email || ''
    const displayName = String(user.user_metadata?.full_name || '').trim() || email.split('@')[0]

    const db = createClient(Deno.env.get('SUPABASE_URL')!, service, { auth:{ persistSession:false } })
    const body = await req.json().catch(() => ({}))
    const action = String(body.action || '')
    const scope = body.scope === 'ADMIN' ? 'ADMIN' : 'IFAR'
    if (scope === 'ADMIN' && !isAdmin) return reply({ error:'Super Admin access required.' }, 403)

    const now = new Date().toISOString()
    const audit = (row: { audit_log?: unknown }, text: string) =>
      [...(Array.isArray(row.audit_log) ? row.audit_log : []), { action:text, timestamp:now, by:email }]
    const canAccess = (row: { workspace: string, created_by: string | null }) =>
      isAdmin || (row.workspace === 'IFAR' && row.created_by === user.id)
    const loadRow = async (id: unknown) => {
      if (typeof id !== 'string' || !id) throw new HttpError(400, 'Quotation id is required.')
      const q = await db.from(TABLE).select(COLUMNS).eq('id', id).maybeSingle()
      if (q.error) throw new HttpError(500, q.error.message)
      // Someone else's quotation looks the same as a missing one
      if (!q.data || !canAccess(q.data as any)) throw new HttpError(404, 'Quotation not found. It may have been deleted, or it belongs to another account.')
      return q.data as any
    }
    // Conditional update: only applies while the row still has the expected status
    const updateIf = async (id: string, status: string[], changes: Record<string, unknown>, conflictMsg: string) => {
      const q = await db.from(TABLE).update({ ...changes, updated_at:now, updated_by:user.id, updated_by_email:email })
        .eq('id', id).in('status', status).select(COLUMNS)
      if (q.error) throw new HttpError(500, q.error.message)
      if (!q.data?.length) throw new HttpError(409, conflictMsg)
      return q.data[0]
    }

    switch (action) {
      case 'list': {
        let q = db.from(TABLE).select(COLUMNS).order('created_at', { ascending:false })
        // IFAR page: own quotations only (also when an admin opens the IFAR page)
        if (scope === 'IFAR') q = q.eq('workspace', 'IFAR').eq('created_by', user.id)
        const r = await q
        if (r.error) throw new HttpError(500, r.error.message)
        return reply({ data:r.data })
      }

      case 'get':
        return reply({ data:await loadRow(body.id) })

      case 'create': {
        const record = cleanRecord(body.record)
        let renewedFrom: string | null = null
        if (body.renewed_from) {
          const parent = await loadRow(body.renewed_from)
          if (parent.renewal_id) throw new HttpError(409, `A renewal quotation (${parent.renewal_ref}) already exists for ${parent.reference_no}.`)
          renewedFrom = parent.id
        }
        const insert = {
          ...record,
          workspace: scope,                  // reference_no comes from the database sequence
          created_by: user.id, created_by_name: displayName, created_by_email: email, imported: false,
          status: 'QUOTED', quotation_date: now, renewed_from: renewedFrom,
          audit_log: [{ action: renewedFrom ? 'Renewal quotation created' : 'Quotation created', timestamp:now, by:email }],
          created_at: now, updated_at: now, updated_by: user.id, updated_by_email: email,
        }
        const r = await db.from(TABLE).insert(insert).select(COLUMNS).single()
        if (r.error) {
          if (r.error.code === '23505' && renewedFrom) throw new HttpError(409, 'A renewal quotation already exists for this quotation.')
          throw new HttpError(500, r.error.message)
        }
        return reply({ data:r.data })
      }

      case 'update': {
        const row = await loadRow(body.id)
        const record = cleanRecord(body.record)
        const data = await updateIf(row.id, ['QUOTED'], { ...record, quotation_date:now, audit_log:audit(row, 'Quotation saved') },
          'This quotation was accepted, declined or deleted in the meantime, so it was not changed.')
        return reply({ data })
      }

      case 'respond': {
        const status = body.status === 'ACCEPTED' ? 'ACCEPTED' : body.status === 'DECLINED' ? 'DECLINED' : ''
        if (!status) throw new HttpError(400, 'Status must be ACCEPTED or DECLINED.')
        const row = await loadRow(body.id)
        const data = await updateIf(row.id, ['QUOTED'],
          { status, responded_at:now, audit_log:audit(row, `Marked as ${status === 'ACCEPTED' ? 'Accepted' : 'Declined'}`) },
          'This quotation was already updated. The list has been refreshed.')
        return reply({ data })
      }

      case 'undo': {
        const row = await loadRow(body.id)
        const data = await updateIf(row.id, ['ACCEPTED', 'DECLINED'],
          { status:'QUOTED', responded_at:null, audit_log:audit(row, 'Response undone') },
          'This quotation is already awaiting a response.')
        return reply({ data })
      }

      case 'delete': {
        const row = await loadRow(body.id)
        const r = await db.from(TABLE).delete().eq('id', row.id).eq('status', 'QUOTED').select('id')
        if (r.error) throw new HttpError(500, r.error.message)
        if (!r.data?.length) throw new HttpError(409, 'Unable to delete. The quotation may have been accepted or declined.')
        return reply({ data:{ id:row.id } })
      }

      default:
        return reply({ error:'Unknown action.' }, 400)
    }
  } catch (err) {
    if (err instanceof HttpError) return reply({ error:err.message }, err.status)
    console.error(err)
    return reply({ error:'Unexpected error.' }, 500)
  }
})
