import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  })
}

function escapeHtml(value: unknown) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
      })[character] || character,
  )
}

function safeFilename(value: unknown) {
  const cleaned = String(value || 'confirmation.pdf')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')

  return cleaned.toLowerCase().endsWith('.pdf')
    ? cleaned
    : `${cleaned}.pdf`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, 405)
  }

  try {
    const authHeader = req.headers.get('Authorization') || ''

    if (!authHeader.startsWith('Bearer ')) {
      return json({ error: 'Authentication required.' }, 401)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!

    const publishableKeys = JSON.parse(
      Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}',
    )

    const publishableKey =
      publishableKeys.default ||
      Deno.env.get('SUPABASE_ANON_KEY')

    if (!publishableKey) {
      return json(
        { error: 'Supabase publishable key is unavailable.' },
        500,
      )
    }

    const supabase = createClient(
      supabaseUrl,
      publishableKey,
      {
        global: {
          headers: {
            Authorization: authHeader,
          },
        },
        auth: {
          persistSession: false,
        },
      },
    )

    const { data: userData, error: userError } =
      await supabase.auth.getUser()

    if (userError || !userData.user) {
      return json({ error: 'Invalid adviser session.' }, 401)
    }

    const payload = await req.json().catch(() => ({}))

    const confirmationId = String(
      payload.confirmationId || '',
    )

    const mode = String(payload.mode || 'client_link')

    if (!confirmationId) {
      return json(
        { error: 'confirmationId is required.' },
        400,
      )
    }

    const { data: confirmation, error: confirmationError } =
      await supabase
        .from('confirmation_requests')
        .select(`
          id,
          adviser_id,
          reference_no,
          participant_name,
          participant_email,
          certificate_no,
          adviser_name,
          public_token,
          status
        `)
        .eq('id', confirmationId)
        .eq('adviser_id', userData.user.id)
        .single()

    if (confirmationError || !confirmation) {
      console.error('Confirmation query:', confirmationError)

      return json(
        { error: 'Confirmation record not found.' },
        404,
      )
    }

    const resendApiKey = Deno.env.get('RESEND_API_KEY')
    const emailFrom = Deno.env.get('EMAIL_FROM')
    const emailReplyTo = Deno.env.get('EMAIL_REPLY_TO')

    if (!resendApiKey || !emailFrom) {
      return json(
        {
          error:
            'Email service is not configured. Check RESEND_API_KEY and EMAIL_FROM.',
        },
        500,
      )
    }

    let recipient = ''
    let subject = ''
    let html = ''
    let attachment:
      | {
          filename: string
          content: string
        }
      | undefined

    let auditPurpose: string | null = null

    // -------------------------------------------------------
    // MODE 1: Send confirmation link to participant
    // -------------------------------------------------------

    if (mode === 'client_link') {
      if (confirmation.status !== 'AWAITING_CLIENT') {
        return json(
          {
            error:
              'This confirmation is no longer awaiting the client.',
          },
          409,
        )
      }

      const appBaseUrl = Deno.env.get('APP_BASE_URL')

      if (!appBaseUrl) {
        return json(
          {
            error:
              'APP_BASE_URL has not been configured.',
          },
          500,
        )
      }

      recipient = confirmation.participant_email

      const clientUrl =
        `${appBaseUrl.replace(/\/$/, '')}` +
        `/confirmation.html?token=${confirmation.public_token}`

      subject =
        `Takaful Confirmation Required - ` +
        confirmation.reference_no

      html = `
        <div style="
          font-family:Arial,sans-serif;
          line-height:1.6;
          color:#1f2937;
          max-width:640px;
          margin:auto
        ">
          <h2 style="color:#212F6E">
            TSI Wealth Planners
          </h2>

          <p>
            Dear ${escapeHtml(confirmation.participant_name)},
          </p>

          <p>
            Please review and confirm your Takaful product
            selection using the secure link below.
          </p>

          <p style="margin:28px 0">
            <a
              href="${clientUrl}"
              style="
                background:#212F6E;
                color:white;
                text-decoration:none;
                padding:12px 18px;
                border-radius:8px;
                display:inline-block
              "
            >
              Review and Sign Confirmation
            </a>
          </p>

          <p style="font-size:13px;color:#6b7280">
            Reference:
            ${escapeHtml(confirmation.reference_no)}
          </p>

          <p>
            Thank you,<br>
            <strong>
              ${escapeHtml(confirmation.adviser_name)}
            </strong><br>
            TSI Wealth Planners
          </p>
        </div>
      `
    }

    // -------------------------------------------------------
    // MODE 2: Send final closed PDF to AD
    // -------------------------------------------------------

    else if (mode === 'ad_closed_pdf') {
      if (confirmation.status !== 'CLOSED') {
        return json(
          {
            error:
              'Only a closed confirmation can be sent to AD.',
          },
          409,
        )
      }

      const adEmail = Deno.env.get('AD_EMAIL')

      if (!adEmail) {
        return json(
          {
            error: 'AD_EMAIL has not been configured.',
          },
          500,
        )
      }

      const pdfBase64 = String(payload.pdfBase64 || '')
      const filename = safeFilename(
        payload.filename ||
          `Final-Takaful-Confirmation-${confirmation.reference_no}.pdf`,
      )

      if (!pdfBase64) {
        return json(
          { error: 'The final PDF is missing.' },
          400,
        )
      }

      if (!/^[a-zA-Z0-9+/=\r\n]+$/.test(pdfBase64)) {
        return json(
          { error: 'The final PDF encoding is invalid.' },
          400,
        )
      }

      if (pdfBase64.length > 20_000_000) {
        return json(
          { error: 'The final PDF is too large to email.' },
          413,
        )
      }

      recipient = adEmail

      subject =
        `Closed Takaful Confirmation - ` +
        confirmation.reference_no

      html = `
        <div style="
          font-family:Arial,sans-serif;
          line-height:1.6;
          color:#1f2937;
          max-width:640px;
          margin:auto
        ">
          <h2 style="color:#212F6E">
            Closed Takaful Confirmation
          </h2>

          <p>Dear AD,</p>

          <p>
            A final closed Takaful confirmation has been
            submitted.
          </p>

          <p>
            <strong>Reference:</strong>
            ${escapeHtml(confirmation.reference_no)}
          </p>

          <p>
            <strong>Participant:</strong>
            ${escapeHtml(confirmation.participant_name)}
          </p>

          <p>
            <strong>Certificate Number:</strong>
            ${escapeHtml(confirmation.certificate_no)}
          </p>

          <p>
            <strong>Adviser:</strong>
            ${escapeHtml(confirmation.adviser_name)}
          </p>

          <p>
            The final closed PDF is attached.
          </p>

          <p>
            Thank you,<br>
            TSI Wealth Planners
          </p>
        </div>
      `

      attachment = {
        filename,
        content: pdfBase64.replace(/\s/g, ''),
      }

      auditPurpose = 'AD_CLOSED_PDF'
    } else {
      return json(
        { error: 'Unsupported email mode.' },
        400,
      )
    }

    const resendBody: Record<string, unknown> = {
      from: emailFrom,
      to: [recipient],
      subject,
      html,
    }

    if (emailReplyTo) {
      resendBody.reply_to = emailReplyTo
    }

    if (attachment) {
      resendBody.attachments = [attachment]
    }

    const emailResponse = await fetch(
      'https://api.resend.com/emails',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(resendBody),
      },
    )

    const emailResult =
      await emailResponse.json().catch(() => ({}))

    if (!emailResponse.ok) {
      console.error('Resend error:', emailResult)

      return json(
        {
          error:
            emailResult?.message ||
            'The email provider rejected the request.',
        },
        502,
      )
    }

    const metadata: Record<string, unknown> = {
      reference_no: confirmation.reference_no,
      recipient,
      provider: 'resend',
      provider_message_id: emailResult?.id || null,
    }

    if (auditPurpose) {
      metadata.purpose = auditPurpose
    }

    const { error: auditError } = await supabase
      .from('confirmation_audit_events')
      .insert({
        confirmation_id: confirmation.id,
        adviser_id: userData.user.id,
        event_type: 'EMAIL_SENT',
        actor_type: 'ADVISER',
        actor_label: confirmation.adviser_name,
        metadata,
      })

    if (auditError) {
      console.error('Audit insert failed:', auditError)
    }

    return json({
      success: true,
      recipient,
      messageId: emailResult?.id || null,
      mode,
    })
  } catch (error) {
    console.error(error)

    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Unexpected server error.',
      },
      500,
    )
  }
})