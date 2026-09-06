import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type':'application/json' } })
const safe = (v: unknown) => String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c] || c))

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return reply({ error:'Method not allowed.' }, 405)
  try {
    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) return reply({ error:'Authentication required.' }, 401)
    const url = Deno.env.get('SUPABASE_URL')!
    const anon = Deno.env.get('SUPABASE_ANON_KEY') || JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}').default
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const resendKey = Deno.env.get('RESEND_API_KEY'), emailFrom = Deno.env.get('EMAIL_FROM'), replyTo = Deno.env.get('EMAIL_REPLY_TO')
    if (!anon || !service || !resendKey || !emailFrom) return reply({ error:'Function secrets are incomplete.' }, 500)
    const userClient = createClient(url, anon, { global:{ headers:{ Authorization:authHeader } }, auth:{ persistSession:false } })
    const userResult = await userClient.auth.getUser()
    if (userResult.error || !userResult.data.user) return reply({ error:'Invalid session.' }, 401)
    const admin = userResult.data.user
    const adminCheck = await userClient.rpc('is_super_admin')
    if (adminCheck.error || adminCheck.data !== true) return reply({ error:'Super Admin access required.' }, 403)
    const db = createClient(url, service, { auth:{ persistSession:false } })
    const body = await req.json().catch(() => ({})), mode = String(body.mode || '')
    let recipient='', subject='', html='', event:Record<string,unknown>|null=null

    if (mode === 'claim_receive' || mode === 'claim_return') {
      const claimId = String(body.claimId || ''), reason = String(body.reason || '').trim()
      if (!claimId) return reply({ error:'claimId is required.' }, 400)
      if (mode === 'claim_return' && !reason) return reply({ error:'A return reason is required.' }, 400)
      const q = await db.from('claim_records').select('*').eq('id', claimId).single()
      if (q.error || !q.data) return reply({ error:'Claim not found.' }, 404)
      const claim = q.data
      if (mode === 'claim_receive' && claim.status !== 'SENT_TO_CLAIM_DEPT') return reply({ error:'Only a submitted claim can be received.' }, 409)
      if (mode === 'claim_return' && !['SENT_TO_CLAIM_DEPT','RECEIVED'].includes(claim.status)) return reply({ error:'This claim cannot be returned in its current status.' }, 409)
      const adviserResult = await db.auth.admin.getUserById(claim.adviser_id)
      recipient = adviserResult.data.user?.email || ''
      if (!recipient) return reply({ error:'The IFAR email could not be found.' }, 409)
      const name = claim.applicant_name || adviserResult.data.user?.user_metadata?.full_name || 'IFAR'
      if (mode === 'claim_receive') {
        subject = `Claim Received and Under Processing - ${claim.claim_ref}`
        html = `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#1f2937"><h2 style="color:#212F6E">Claim Received</h2><p>Dear ${safe(name)},</p><p>We confirm that your claim submission <strong>${safe(claim.claim_ref)}</strong> has been received by the Claim Department and is currently being processed.</p><p>We will contact you if further information or amendments are required.</p><p>Thank you,<br><strong>TSI Wealth Planners Claim Department</strong></p></div>`
      } else {
        subject = `Claim Returned for Amendment - ${claim.claim_ref}`
        html = `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#1f2937"><h2 style="color:#212F6E">Claim Returned</h2><p>Dear ${safe(name)},</p><p>Your claim <strong>${safe(claim.claim_ref)}</strong> has been returned for amendment.</p><p><strong>Reason:</strong></p><div style="background:#fff1f2;border-left:4px solid #e11d48;padding:12px">${safe(reason)}</div><p>Please sign in to the IFAR Portal, amend the claim and resubmit it.</p><p>Thank you,<br><strong>TSI Wealth Planners Claim Department</strong></p></div>`
      }
      event = { type:'claim', claim, reason }
    } else if (mode === 'confirmation_reminder') {
      const confirmationId = String(body.confirmationId || '')
      const q = await db.from('confirmation_requests').select('*').eq('id', confirmationId).single()
      if (q.error || !q.data) return reply({ error:'Confirmation not found.' }, 404)
      const c = q.data, app = (Deno.env.get('APP_BASE_URL') || '').replace(/\/$/, '')
      if (c.status === 'AWAITING_CLIENT') {
        recipient=c.participant_email; subject=`Reminder: Takaful Confirmation Required - ${c.reference_no}`
        html=`<div style="font-family:Arial,sans-serif;line-height:1.6;color:#1f2937"><h2 style="color:#212F6E">Takaful Confirmation Reminder</h2><p>Dear ${safe(c.participant_name)},</p><p>This is a reminder to review and sign your Takaful option confirmation.</p><p><a href="${app}/coo/confirmation.html?token=${c.public_token}" style="background:#212F6E;color:white;padding:12px 18px;border-radius:8px;text-decoration:none">Review and Sign Confirmation</a></p><p>Reference: ${safe(c.reference_no)}</p></div>`
        event={ type:'reminder', confirmation:c, recipientType:'CLIENT' }
      } else if (c.status === 'AWAITING_ADVISER') {
        const adviserResult=await db.auth.admin.getUserById(c.adviser_id);recipient=adviserResult.data.user?.email||'';subject=`Reminder: IFAR Signature Required - ${c.reference_no}`
        html=`<div style="font-family:Arial,sans-serif;line-height:1.6;color:#1f2937"><h2 style="color:#212F6E">IFAR Signature Reminder</h2><p>Dear ${safe(c.adviser_name)},</p><p>The client has completed confirmation <strong>${safe(c.reference_no)}</strong>. Please sign in and complete the IFAR signature.</p><p><a href="${app}/coo/takaful-coo-new.html" style="background:#212F6E;color:white;padding:12px 18px;border-radius:8px;text-decoration:none">Open Option Confirmation</a></p></div>`
        event={ type:'reminder', confirmation:c, recipientType:'IFAR' }
      } else return reply({ error:'Completed confirmations do not require a reminder.' }, 409)
      if (!recipient) return reply({ error:'Reminder recipient email is unavailable.' }, 409)
    } else return reply({ error:'Unsupported action.' }, 400)

    const emailPayload:Record<string,unknown>={from:emailFrom,to:[recipient],subject,html};if(replyTo)emailPayload.reply_to=replyTo
    const sent=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${resendKey}`,'Content-Type':'application/json'},body:JSON.stringify(emailPayload)})
    const sentData=await sent.json().catch(()=>({}))
    if(!sent.ok) return reply({error:sentData?.message||'Email provider rejected the request.'},502)
    const now=new Date().toISOString()
    if(event?.type==='claim'){
      const claim=event.claim as Record<string,unknown>, receiving=mode==='claim_receive'
      const update=await db.from('claim_records').update({status:receiving?'RECEIVED':'RETURNED',received_at:receiving?now:claim.received_at,returned_at:receiving?null:now,return_reason:receiving?null:event.reason,admin_action_by:admin.id,admin_action_email:admin.email,updated_at:now}).eq('id',claim.id)
      if(update.error) return reply({error:'Email sent, but claim status update failed.'},500)
      await db.from('claim_admin_events').insert({claim_id:claim.id,adviser_id:claim.adviser_id,admin_id:admin.id,admin_email:admin.email,action:receiving?'RECEIVED':'RETURNED',reason:receiving?null:event.reason,recipient_email:recipient,provider_message_id:sentData?.id||null})
    } else if(event?.type==='reminder'){
      const c=event.confirmation as Record<string,unknown>;await db.from('confirmation_reminder_events').insert({confirmation_id:c.id,adviser_id:c.adviser_id,admin_id:admin.id,admin_email:admin.email,recipient_type:event.recipientType,recipient_email:recipient,provider_message_id:sentData?.id||null})
    }
    return reply({success:true,recipient,messageId:sentData?.id||null})
  } catch (e) { console.error(e); return reply({ error:e instanceof Error?e.message:'Unexpected server error.' },500) }
})
