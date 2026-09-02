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

function bytesToBase64(bytes: Uint8Array) {
  const chunkSize = 0x8000
  const chunks: string[] = []

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(
      index,
      Math.min(index + chunkSize, bytes.length),
    )

    chunks.push(
      String.fromCharCode(...chunk),
    )
  }

  return btoa(chunks.join(''))
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

    const serviceRoleKey =
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!publishableKey || !serviceRoleKey) {
      return json(
        {
          error:
            'Required Supabase function credentials are unavailable.',
        },
        500,
      )
    }

    const userClient = createClient(
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
      await userClient.auth.getUser()

    if (userError || !userData.user) {
      return json({ error: 'Invalid adviser session.' }, 401)
    }

    const payload = await req.json().catch(() => ({}))
    const claimId = String(payload.claimId || '')

    if (!claimId) {
      return json({ error: 'claimId is required.' }, 400)
    }

    const { data: claim, error: claimError } =
      await userClient
        .from('claim_records')
        .select('*')
        .eq('id', claimId)
        .eq('adviser_id', userData.user.id)
        .single()

    if (claimError || !claim) {
      console.error('Claim query:', claimError)

      return json(
        { error: 'Claim record not found.' },
        404,
      )
    }

    if (!claim.pdf_path) {
      return json(
        { error: 'The claim PDF is not available.' },
        409,
      )
    }

    if (
      !['READY', 'SENT_TO_CLAIM_DEPT'].includes(claim.status)
    ) {
      return json(
        {
          error:
            'This claim is not ready for submission.',
        },
        409,
      )
    }

    const resendApiKey = Deno.env.get('RESEND_API_KEY')
    const emailFrom = Deno.env.get('EMAIL_FROM')
    const emailReplyTo = Deno.env.get('EMAIL_REPLY_TO')
    const claimDeptEmail = Deno.env.get('CLAIM_DEPT_EMAIL')

    if (
      !resendApiKey ||
      !emailFrom ||
      !claimDeptEmail
    ) {
      return json(
        {
          error:
            'Email service is not configured. Check RESEND_API_KEY, EMAIL_FROM and CLAIM_DEPT_EMAIL.',
        },
        500,
      )
    }

    const adminClient = createClient(
      supabaseUrl,
      serviceRoleKey,
      {
        auth: {
          persistSession: false,
        },
      },
    )

    const { data: pdfBlob, error: downloadError } =
      await adminClient.storage
        .from('claim-pdfs')
        .download(claim.pdf_path)

    if (downloadError || !pdfBlob) {
      console.error('PDF download:', downloadError)

      return json(
        { error: 'Unable to retrieve the claim PDF.' },
        500,
      )
    }

    if (pdfBlob.size > 15_000_000) {
      return json(
        { error: 'The claim PDF is too large to email.' },
        413,
      )
    }

    const pdfBytes = new Uint8Array(
      await pdfBlob.arrayBuffer(),
    )

    const pdfBase64 = bytesToBase64(pdfBytes)
    const filename = `${claim.claim_ref}.pdf`

    const emailBody: Record<string, unknown> = {
      from: emailFrom,
      to: [claimDeptEmail],
      subject: `Claim Submission - ${claim.claim_ref}`,
      html: `
        <div style="
          font-family:Arial,sans-serif;
          line-height:1.6;
          color:#1f2937;
          max-width:640px;
          margin:auto
        ">
          <h2 style="color:#212F6E">
            Claim Submission
          </h2>

          <p>Dear Claim Department,</p>

          <p>
            A claim application has been submitted.
          </p>

          <p>
            <strong>Claim Reference:</strong>
            ${escapeHtml(claim.claim_ref)}
          </p>

          <p>
            <strong>Applicant:</strong>
            ${escapeHtml(claim.applicant_name)}
          </p>

          <p>
            <strong>Claim Date:</strong>
            ${escapeHtml(claim.claim_date)}
          </p>

          <p>
            <strong>Total Amount:</strong>
            RM ${Number(claim.total_amount || 0).toFixed(2)}
          </p>

          <p>
            The completed claim PDF is attached.
          </p>

          <p>
            Thank you,<br>
            TSI Wealth Planners
          </p>
        </div>
      `,
      attachments: [
        {
          filename,
          content: pdfBase64,
        },
      ],
    }

    if (emailReplyTo) {
      emailBody.reply_to = emailReplyTo
    }

    const emailResponse = await fetch(
      'https://api.resend.com/emails',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(emailBody),
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

    const now = new Date().toISOString()

    const { error: updateError } = await userClient
      .from('claim_records')
      .update({
        status: 'SENT_TO_CLAIM_DEPT',
        first_sent_at: claim.first_sent_at || now,
        last_sent_at: now,
        send_count: Number(claim.send_count || 0) + 1,
        recipient_email: claimDeptEmail,
        updated_at: now,
      })
      .eq('id', claim.id)
      .eq('adviser_id', userData.user.id)

    if (updateError) {
      console.error(
        'Email sent but record update failed:',
        updateError,
      )
    }

    return json({
      success: true,
      recipient: claimDeptEmail,
      messageId: emailResult?.id || null,
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