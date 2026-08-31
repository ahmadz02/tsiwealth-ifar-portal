import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const publishableMap = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}')
    const publishableKey = publishableMap.default || Deno.env.get('SUPABASE_ANON_KEY')
    if (!publishableKey) return json({ error: 'Supabase publishable key is unavailable' }, 500)

    const supabase = createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    })

    const { data: userData, error: userError } = await supabase.auth.getUser()
    if (userError || !userData.user) return json({ error: 'Invalid adviser session' }, 401)

    const payload = await req.json().catch(() => ({}))
    const confirmationId = String(payload.confirmationId || '')
    if (!confirmationId) return json({ error: 'confirmationId is required' }, 400)

    const { data: confirmation, error: confirmationError } = await supabase
      .from('confirmation_requests')
      .select('id, reference_no, participant_name, participant_email, adviser_name, public_token, status')
      .eq('id', confirmationId)
      .single()

    if (confirmationError || !confirmation) return json({ error: 'Confirmation not found' }, 404)
    if (confirmation.status !== 'AWAITING_CLIENT') {
      return json({ error: 'This confirmation is no longer awaiting the client.' }, 409)
    }

    const resendApiKey = Deno.env.get('RESEND_API_KEY')
    const emailFrom = Deno.env.get('EMAIL_FROM')
    const appBaseUrl = Deno.env.get('APP_BASE_URL')
    const emailReplyTo = Deno.env.get('EMAIL_REPLY_TO')

    if (!resendApiKey || !emailFrom || !appBaseUrl) {
      return json({ error: 'Email service is not configured. Set RESEND_API_KEY, EMAIL_FROM and APP_BASE_URL.' }, 500)
    }

    const clientUrl = `${appBaseUrl.replace(/\/$/, '')}/confirmation.html?token=${confirmation.public_token}`
    const subject = `Takaful Confirmation Required - ${confirmation.reference_no}`

    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#1f2937;max-width:640px;margin:auto">
        <h2 style="color:#212F6E">TSI Wealth Planners</h2>
        <p>Dear ${escapeHtml(confirmation.participant_name)},</p>
        <p>Please review and confirm your Takaful product selection using the secure confirmation link below.</p>
        <p style="margin:28px 0">
          <a href="${clientUrl}" style="background:#212F6E;color:white;text-decoration:none;padding:12px 18px;border-radius:8px;display:inline-block">Review &amp; Sign Confirmation</a>
        </p>
        <p style="font-size:13px;color:#6b7280">Reference: ${escapeHtml(confirmation.reference_no)}</p>
        <p>Thank you,<br><strong>${escapeHtml(confirmation.adviser_name)}</strong><br>TSI Wealth Planners</p>
      </div>`

    const resendBody: Record<string, unknown> = {
      from: emailFrom,
      to: [confirmation.participant_email],
      subject,
      html,
    }
    if (emailReplyTo) resendBody.reply_to = emailReplyTo

    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(resendBody),
    })

    const emailResult = await emailResponse.json().catch(() => ({}))
    if (!emailResponse.ok) {
      console.error('Resend error:', emailResult)
      return json({ error: emailResult?.message || 'Email provider rejected the request' }, 502)
    }

    const { error: auditError } = await supabase.from('confirmation_audit_events').insert({
      confirmation_id: confirmation.id,
      adviser_id: userData.user.id,
      event_type: 'EMAIL_SENT',
      actor_type: 'ADVISER',
      actor_label: confirmation.adviser_name,
      metadata: {
        reference_no: confirmation.reference_no,
        recipient: confirmation.participant_email,
        provider: 'resend',
        provider_message_id: emailResult?.id || null,
      },
    })

    if (auditError) console.error('Audit insert failed:', auditError)

    return json({
      success: true,
      messageId: emailResult?.id || null,
      recipient: confirmation.participant_email,
    })
  } catch (error) {
    console.error(error)
    return json({ error: error instanceof Error ? error.message : 'Unexpected server error' }, 500)
  }
})

function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[ch] || ch))
}
