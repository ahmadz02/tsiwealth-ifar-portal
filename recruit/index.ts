import { createClient } from 'npm:@supabase/supabase-js@2'

// Edge function: ifar-application-email
// Modes
//   Authenticated (IFAR owner or Super Admin):
//     invite            - email the application link to the candidate
//     return_notice     - email the candidate that corrections are needed (IFAR or AD return)
//     send_to_ad        - email the final PDF (attachment, or secure link if large) to AD
//   Token based (candidate, no login):
//     candidate_submitted - notify the recruiting IFAR that the form was submitted
//     upload_url          - issue a signed upload URL for one document
//     delete_file         - remove one uploaded document

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const BUCKET = 'ifar-application-files'
const EDITABLE = ['INVITED', 'OPENED', 'DRAFT', 'RETURNED']
const DOC_TYPES = ['nric', 'certificates', 'prof_cert', 'payment_proof']
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'application/pdf']
const ATTACH_LIMIT_BYTES = 10 * 1024 * 1024
const FLAG_LABELS: Record<string, string> = {
  particulars: 'Applicant particulars',
  family: 'Family details',
  employment_education: 'Employment history & education',
  bank_references: 'Bank account & references',
  doc_nric: 'NRIC copy (checklist item 2)',
  doc_payment: 'Proof of payment (Step 6)',
  doc_certificates: 'Certificates (checklist item 3)',
  doc_prof: 'ShRFP / IFP certificate (checklist item 6)',
  signature: 'Declaration & signature',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function esc(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c] || c)
}

function safeName(value: unknown, fallback = 'file') {
  const cleaned = String(value || fallback).replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-')
  return cleaned.slice(-80) || fallback
}

function toBase64(bytes: Uint8Array) {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

function fmtDate(v: string | null | undefined) {
  if (!v) return '-'
  return new Date(v).toLocaleDateString('en-MY', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kuala_Lumpur',
  })
}

function shell(heading: string, inner: string) {
  return `
  <div style="font-family:Arial,sans-serif;line-height:1.6;color:#1f2937;max-width:640px;margin:auto">
    <h2 style="color:#212F6E;margin-bottom:4px">TSI Wealth Planners</h2>
    <h3 style="margin-top:0;color:#374151">${esc(heading)}</h3>
    ${inner}
    <p style="margin-top:28px">Thank you,<br><strong>TSI Wealth Planners Sdn Bhd</strong></p>
  </div>`
}

function button(url: string, text: string) {
  return `<p style="margin:26px 0"><a href="${url}" style="background:#212F6E;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;display:inline-block">${esc(text)}</a></p>`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!serviceRoleKey) return json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not configured.' }, 500)

    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
    const payload = await req.json().catch(() => ({}))
    const mode = String(payload.mode || '')

    const resendApiKey = Deno.env.get('RESEND_API_KEY')
    const emailFrom = Deno.env.get('EMAIL_FROM')
    const emailReplyTo = Deno.env.get('EMAIL_REPLY_TO')

    // Base URL of the /recruit folder. Falls back to APP_BASE_URL with /coo -> /recruit.
    const recruitBase = (() => {
      const explicit = Deno.env.get('RECRUIT_APP_BASE_URL')
      if (explicit) return explicit.replace(/\/$/, '')
      const app = (Deno.env.get('APP_BASE_URL') || '').replace(/\/$/, '')
      return app.replace(/\/coo$/, '') + '/recruit'
    })()
    const applyUrl = (token: string) => `${recruitBase}/apply.html?token=${token}`

    async function audit(appId: string, type: string, actorType: string, label: string, metadata: Record<string, unknown> = {}) {
      const { error } = await admin.from('ifar_application_audit_events').insert({
        application_id: appId, event_type: type, actor_type: actorType, actor_label: label, metadata,
      })
      if (error) console.error('Audit insert failed:', error)
    }

    async function sendEmail(opts: {
      to: string[]; cc?: string[]; subject: string; html: string;
      attachment?: { filename: string; content: string }
    }) {
      if (!resendApiKey || !emailFrom) {
        return { ok: false, error: 'Email service is not configured. Check RESEND_API_KEY and EMAIL_FROM.' }
      }
      const body: Record<string, unknown> = { from: emailFrom, to: opts.to, subject: opts.subject, html: opts.html }
      if (opts.cc && opts.cc.length) body.cc = opts.cc
      if (emailReplyTo) body.reply_to = emailReplyTo
      if (opts.attachment) body.attachments = [opts.attachment]
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const result = await res.json().catch(() => ({}))
      if (!res.ok) {
        console.error('Resend error:', result)
        return { ok: false, error: result?.message || 'The email provider rejected the request.' }
      }
      return { ok: true, id: result?.id || null }
    }

    async function loadApp(filter: { id?: string; token?: string }) {
      let q = admin.from('ifar_applications').select('*')
      if (filter.id) q = q.eq('id', filter.id)
      if (filter.token) q = q.eq('public_token', filter.token)
      const { data, error } = await q.single()
      if (error || !data) return null
      return data
    }

    // ======================================================
    // Token based modes (candidate, no login)
    // ======================================================
    if (['candidate_submitted', 'upload_url', 'delete_file'].includes(mode)) {
      const token = String(payload.token || '')
      if (!token) return json({ error: 'token is required.' }, 400)
      const app = await loadApp({ token })
      if (!app) return json({ error: 'This link is not valid.' }, 404)

      if (mode === 'upload_url' || mode === 'delete_file') {
        if (!EDITABLE.includes(app.status)) return json({ error: 'This application can no longer be edited.' }, 409)
        if (new Date(app.expires_at) < new Date()) return json({ error: 'This link has expired.' }, 410)
      }

      if (mode === 'upload_url') {
        const docType = String(payload.docType || '')
        const contentType = String(payload.contentType || '')
        if (!DOC_TYPES.includes(docType)) return json({ error: 'Unknown document type.' }, 400)
        if (!ALLOWED_TYPES.includes(contentType)) return json({ error: 'Only JPG, PNG or PDF files are allowed.' }, 400)
        const path = `${app.id}/${docType}/${crypto.randomUUID()}-${safeName(payload.filename)}`
        const { data, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(path)
        if (error || !data) {
          console.error('Signed upload URL failed:', error)
          return json({ error: 'Unable to prepare the upload.' }, 500)
        }
        return json({ success: true, path, uploadToken: data.token })
      }

      if (mode === 'delete_file') {
        const path = String(payload.path || '')
        if (!path.startsWith(`${app.id}/`) || path.includes('..') || path.startsWith(`${app.id}/final/`)) {
          return json({ error: 'Invalid file path.' }, 400)
        }
        const { error } = await admin.storage.from(BUCKET).remove([path])
        if (error) {
          console.error('File delete failed:', error)
          return json({ error: 'Unable to remove the file.' }, 500)
        }
        return json({ success: true })
      }

      // candidate_submitted -> notify the recruiting IFAR (once per submission)
      if (app.status !== 'SUBMITTED') return json({ error: 'The application is not in submitted state.' }, 409)
      const { data: prior } = await admin
        .from('ifar_application_audit_events')
        .select('id, occurred_at, metadata')
        .eq('application_id', app.id)
        .eq('event_type', 'EMAIL_SENT')
        .gte('occurred_at', app.submitted_at)
      if ((prior || []).some((e) => e.metadata?.purpose === 'RECRUITER_SUBMITTED_NOTICE')) {
        return json({ success: true, duplicate: true })
      }
      if (!app.recruiter_email) return json({ error: 'The recruiting IFAR has no email on file.' }, 422)

      const name = app.form_data?.name || app.candidate_name || app.candidate_email
      const result = await sendEmail({
        to: [app.recruiter_email],
        subject: `IFAR Application Submitted - ${app.reference_no}`,
        html: shell('Application submitted for your review', `
          <p>Dear ${esc(app.recruiter_name || 'IFAR')},</p>
          <p><strong>${esc(name)}</strong> has completed and submitted the Islamic Financial Adviser Representative application.</p>
          <p><strong>Reference:</strong> ${esc(app.reference_no)}</p>
          <p>Please log in to the IFAR Portal to review the application, then send it to AD or return it for correction.</p>
          ${button(`${recruitBase}/index.html`, 'Open IFAR Registration')}`),
      })
      if (!result.ok) return json({ error: result.error }, 502)
      await audit(app.id, 'EMAIL_SENT', 'SYSTEM', 'System', {
        purpose: 'RECRUITER_SUBMITTED_NOTICE', recipient: app.recruiter_email, provider_message_id: result.id,
      })
      return json({ success: true, recipient: app.recruiter_email })
    }

    // ======================================================
    // Authenticated modes
    // ======================================================
    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Authentication required.' }, 401)

    const publishableKeys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}')
    const publishableKey = publishableKeys.default || Deno.env.get('SUPABASE_ANON_KEY')
    if (!publishableKey) return json({ error: 'Supabase publishable key is unavailable.' }, 500)

    const userClient = createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    })
    const { data: userData, error: userError } = await userClient.auth.getUser()
    if (userError || !userData.user) return json({ error: 'Invalid session.' }, 401)
    const user = userData.user

    const applicationId = String(payload.applicationId || '')
    if (!applicationId) return json({ error: 'applicationId is required.' }, 400)
    const app = await loadApp({ id: applicationId })
    if (!app) return json({ error: 'Application not found.' }, 404)

    const isOwner = app.recruiter_id === user.id
    let isAdmin = false
    if (!isOwner) {
      const { data: adminFlag } = await userClient.rpc('is_super_admin')
      isAdmin = adminFlag === true
    }
    if (!isOwner && !isAdmin) return json({ error: 'Application not found.' }, 404)

    // ---------- invite ----------
    if (mode === 'invite') {
      if (!isOwner) return json({ error: 'Only the inviting IFAR can send the link.' }, 403)
      if (!EDITABLE.includes(app.status)) return json({ error: 'This application is no longer open.' }, 409)
      if (new Date(app.expires_at) < new Date()) return json({ error: 'The link has expired. Extend it first.' }, 410)

      const result = await sendEmail({
        to: [app.candidate_email],
        subject: 'Your Islamic Financial Adviser Representative Application - TSI Wealth Planners',
        html: shell('Islamic Financial Adviser Representative Application', `
          <p>Dear ${esc(app.candidate_name || 'Applicant')},</p>
          <p>${esc(app.recruiter_name || 'Your recruiter')} has invited you to complete your online application to become an Islamic Financial Adviser Representative (IFAR) with TSI Wealth Planners Sdn Bhd.</p>
          ${app.note ? `<p style="background:#f3f4f6;padding:10px 14px;border-radius:8px"><em>${esc(app.note)}</em></p>` : ''}
          <p>Please have the following ready to upload (JPG, PNG or PDF):</p>
          <ul>
            <li>NRIC - front and back (colour)</li>
            <li>Certified true copy of your academic and/or professional certificates</li>
            <li>Professional Qualification Certificate (ShRFP / IFP)</li>
          </ul>
          <p>You can save your progress and return to the same link at any time.</p>
          ${button(applyUrl(app.public_token), 'Start / Continue Application')}
          <p style="font-size:13px;color:#6b7280">This link is personal to you and is valid until <strong>${esc(fmtDate(app.expires_at))}</strong>.<br>Reference: ${esc(app.reference_no)}</p>`),
      })
      if (!result.ok) return json({ error: result.error }, 502)
      await audit(app.id, 'EMAIL_SENT', 'IFAR', app.recruiter_name || 'IFAR', {
        purpose: 'CANDIDATE_INVITE', recipient: app.candidate_email, provider_message_id: result.id,
      })
      return json({ success: true, recipient: app.candidate_email, mode })
    }

    // ---------- return_notice ----------
    if (mode === 'return_notice') {
      if (app.status !== 'RETURNED') return json({ error: 'This application is not marked as returned.' }, 409)
      const byAd = isAdmin && !isOwner
      const flags = (app.return_flags || []).map((f: string) => FLAG_LABELS[f] || f)
      const cc = byAd && app.recruiter_email ? [app.recruiter_email] : []
      const result = await sendEmail({
        to: [app.candidate_email],
        cc,
        subject: `Action Required: Corrections to your IFAR Application - ${app.reference_no}`,
        html: shell('Corrections required', `
          <p>Dear ${esc(app.form_data?.name || app.candidate_name || 'Applicant')},</p>
          <p>Your application has been returned by ${byAd ? 'the Agency Director (AD)' : esc(app.recruiter_name || 'your recruiter')} for correction.</p>
          <p style="background:#fff7ed;border:1px solid #fed7aa;padding:10px 14px;border-radius:8px"><strong>Reason:</strong><br>${esc(app.return_reason || '-').replace(/\n/g, '<br>')}</p>
          ${flags.length ? `<p><strong>Please review:</strong></p><ul>${flags.map((f: string) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
          <p>Your previous answers are saved. Open the same link to update them and submit again.</p>
          ${button(applyUrl(app.public_token), 'Open Application')}
          <p style="font-size:13px;color:#6b7280">The link is valid until <strong>${esc(fmtDate(app.expires_at))}</strong>.<br>Reference: ${esc(app.reference_no)}</p>`),
      })
      if (!result.ok) return json({ error: result.error }, 502)
      await audit(app.id, 'EMAIL_SENT', byAd ? 'AD' : 'IFAR', byAd ? 'AD' : (app.recruiter_name || 'IFAR'), {
        purpose: 'CANDIDATE_RETURN', recipient: app.candidate_email, cc, provider_message_id: result.id,
      })
      return json({ success: true, recipient: app.candidate_email, mode })
    }

    // ---------- milestone_notice (AD only): interim letter issued / sent to BNM ----------
    if (mode === 'milestone_notice') {
      const { data: adFlag } = await userClient.rpc('is_super_admin')
      if (adFlag !== true) return json({ error: 'Only the AD can send this notice.' }, 403)
      const ms = String(payload.milestone || '')
      if (!['interim', 'bnm'].includes(ms)) return json({ error: 'Unknown milestone.' }, 400)
      const when = ms === 'interim' ? app.interim_letter_at : app.bnm_sent_at
      if (!when) return json({ error: 'This milestone has not been recorded yet.' }, 409)
      const remark = (ms === 'interim' ? app.interim_letter_remark : app.bnm_remark) || ''
      if (!app.recruiter_email) return json({ error: 'The inviting IFAR has no email on file.' }, 422)
      const applicant = app.form_data?.name || app.candidate_name || app.candidate_email
      const remarkHtml = remark
        ? `<p style="background:#f3f4f6;border:1px solid #e5e7eb;padding:10px 14px;border-radius:8px"><strong>Remark:</strong><br>${esc(remark).replace(/\n/g, '<br>')}</p>` : ''
      let to: string[]; let cc: string[] = []; let subject: string; let html: string
      if (ms === 'interim') {
        to = [app.recruiter_email]
        subject = `Interim Letter Issued - ${applicant} (${app.reference_no})`
        html = shell('Interim Letter Issued', `
          <p>Dear ${esc(app.recruiter_name || 'IFAR')},</p>
          <p>The Interim Letter for the IFAR application of <strong>${esc(applicant)}</strong> has been issued by the Agency Director (AD) on <strong>${esc(fmtDate(when))}</strong>.</p>
          ${remarkHtml}
          <p style="font-size:13px;color:#6b7280">Reference: ${esc(app.reference_no)}</p>`)
      } else {
        to = [app.candidate_email]
        cc = [app.recruiter_email]
        subject = `Application Sent to BNM - ${app.reference_no}`
        html = shell('Application Sent to BNM', `
          <p>Dear ${esc(applicant)},</p>
          <p>Your Islamic Financial Adviser Representative (IFAR) application has been submitted to Bank Negara Malaysia (BNM) on <strong>${esc(fmtDate(when))}</strong>.</p>
          <p>Your recruiting IFAR, ${esc(app.recruiter_name || '-')}, is copied on this email.</p>
          ${remarkHtml}
          <p style="font-size:13px;color:#6b7280">Reference: ${esc(app.reference_no)}</p>`)
      }
      const result = await sendEmail({ to, cc, subject, html })
      if (!result.ok) return json({ error: result.error, recorded: true }, 502)
      await admin.from('ifar_applications')
        .update(ms === 'interim' ? { interim_email_at: new Date().toISOString() } : { bnm_email_at: new Date().toISOString() })
        .eq('id', app.id)
      await audit(app.id, 'EMAIL_SENT', 'AD', 'AD', {
        purpose: ms === 'interim' ? 'INTERIM_LETTER_NOTICE' : 'SENT_TO_BNM_NOTICE', recipient: to, cc, provider_message_id: result.id,
      })
      return json({ success: true, recipients: [...to, ...cc], mode })
    }

    // ---------- send_to_ad ----------
    if (mode === 'send_to_ad') {
      if (!['SENT_TO_AD', 'CLOSED'].includes(app.status)) return json({ error: 'The application has not been sent to AD.' }, 409)
      if (!app.pdf_path) return json({ error: 'The application PDF is missing.' }, 409)
      const adEmail = Deno.env.get('AD_EMAIL')
      if (!adEmail) return json({ error: 'AD_EMAIL has not been configured.' }, 500)

      const { data: blob, error: dlError } = await admin.storage.from(BUCKET).download(app.pdf_path)
      if (dlError || !blob) {
        console.error('PDF download failed:', dlError)
        return json({ error: 'Unable to read the application PDF.' }, 500)
      }
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const filename = safeName(app.pdf_path.split('/').pop() || `IFAR-Application-${app.reference_no}.pdf`)
        .replace(/^\d+-/, '')
      let attachment: { filename: string; content: string } | undefined
      let linkHtml = '<p>The application PDF is attached.</p>'
      if (bytes.length <= ATTACH_LIMIT_BYTES) {
        attachment = { filename, content: toBase64(bytes) }
      } else {
        const { data: signed, error: signError } = await admin.storage.from(BUCKET).createSignedUrl(app.pdf_path, 60 * 60 * 24 * 7)
        if (signError || !signed) return json({ error: 'Unable to create a secure download link.' }, 500)
        linkHtml = `<p>The PDF is too large to attach. Download it using the secure link below (valid for 7 days), or from the Super Admin portal.</p>${button(signed.signedUrl, 'Download Application PDF')}`
      }

      const name = app.form_data?.name || app.candidate_name || app.candidate_email
      const result = await sendEmail({
        to: [adEmail],
        subject: `IFAR Application for Review - ${app.reference_no}`,
        html: shell('IFAR application received', `
          <p>Dear AD,</p>
          <p>An IFAR application has been reviewed by the recruiting IFAR and sent to you.</p>
          <p><strong>Reference:</strong> ${esc(app.reference_no)}<br>
             <strong>Applicant:</strong> ${esc(name)}<br>
             <strong>Recruited by:</strong> ${esc(app.recruiter_name || '-')}</p>
          ${linkHtml}`),
        attachment,
      })
      if (!result.ok) return json({ error: result.error }, 502)
      await audit(app.id, 'EMAIL_SENT', isOwner ? 'IFAR' : 'AD', isOwner ? (app.recruiter_name || 'IFAR') : 'AD', {
        purpose: 'AD_APPLICATION_PDF', recipient: adEmail, as_attachment: !!attachment, provider_message_id: result.id,
      })
      return json({ success: true, recipient: adEmail, attached: !!attachment, mode })
    }

    return json({ error: 'Unsupported mode.' }, 400)
  } catch (error) {
    console.error(error)
    return json({ error: error instanceof Error ? error.message : 'Unexpected server error.' }, 500)
  }
})
