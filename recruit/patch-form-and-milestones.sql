-- Run once in the Supabase SQL editor.
-- 1) Candidate submit check: single NRIC upload + proof of payment required.
-- 2) AD milestones: Interim Letter Issued, Sent to BNM.

create or replace function public.submit_ifar_application(
  p_token text, p_form_data jsonb, p_files jsonb, p_signature text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a ifar_applications%rowtype; k text; resub boolean;
begin
  select * into a from ifar_applications where public_token = p_token for update;
  if not found then raise exception 'This link is not valid.'; end if;
  if a.status not in ('INVITED','OPENED','DRAFT','RETURNED') then
    raise exception 'This application has already been submitted.';
  end if;
  if a.expires_at < now() then raise exception 'This link has expired.'; end if;

  foreach k in array array['name','nric','mobile','nationality','race','religion','marital','corrAddress','occupation','email'] loop
    if coalesce(trim(p_form_data->>k),'') = '' then raise exception 'Incomplete application: % is required.', k; end if;
  end loop;
  if coalesce(trim(p_form_data#>>'{nok,name}'),'') = '' then raise exception 'Incomplete application: next of kin is required.'; end if;
  if coalesce(trim(p_form_data#>>'{bank,accountNo}'),'') = '' then raise exception 'Incomplete application: bank account is required.'; end if;
  if jsonb_array_length(coalesce(p_form_data->'employment','[]'::jsonb)) < 1 then raise exception 'Incomplete application: employment history is required.'; end if;
  if jsonb_array_length(coalesce(p_form_data->'education','[]'::jsonb)) < 1 then raise exception 'Incomplete application: education background is required.'; end if;
  foreach k in array array['nric','certificates','prof_cert','payment_proof'] loop
    if jsonb_array_length(coalesce(p_files->k,'[]'::jsonb)) < 1 then raise exception 'Incomplete application: document % is missing.', k; end if;
  end loop;
  if coalesce(p_signature,'') = '' then raise exception 'Incomplete application: signature is required.'; end if;
  if exists (
    select 1 from jsonb_each(coalesce(p_files,'{}'::jsonb)) e, jsonb_array_elements(e.value) f
    where (f->>'path') is null or (f->>'path') not like a.id::text || '/%'
  ) then raise exception 'Invalid file reference.'; end if;

  resub := a.status = 'RETURNED';
  update ifar_applications set
    form_data = p_form_data, files = p_files, applicant_signature = p_signature,
    status = 'SUBMITTED', submitted_at = now(), last_saved_at = now(), updated_at = now(),
    return_reason = null, return_flags = '{}'
  where id = a.id;
  perform _ifar_audit(a.id, case when resub then 'CANDIDATE_RESUBMITTED' else 'CANDIDATE_SUBMITTED' end,
    'CANDIDATE', coalesce(nullif(p_form_data->>'name',''), a.candidate_email));
  return jsonb_build_object('ok', true);
end $$;

-- ---------- AD milestones: interim letter issued / sent to BNM -----------
-- Each can be recorded once per application. Interim letter first, then BNM.
alter table public.ifar_applications
  add column if not exists interim_letter_at timestamptz,
  add column if not exists interim_letter_remark text,
  add column if not exists interim_email_at timestamptz,
  add column if not exists bnm_sent_at timestamptz,
  add column if not exists bnm_remark text,
  add column if not exists bnm_email_at timestamptz;

create or replace function public.admin_mark_ifar_milestone(p_id uuid, p_milestone text, p_remark text)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare a ifar_applications%rowtype; ts timestamptz := now(); rmk text := nullif(trim(coalesce(p_remark,'')),'');
begin
  if not public.is_super_admin() then raise exception 'Not authorised.'; end if;
  if p_milestone not in ('interim','bnm') then raise exception 'Unknown milestone.'; end if;
  select * into a from ifar_applications where id = p_id for update;
  if not found then raise exception 'Application not found.'; end if;
  if a.status = 'RETURNED' then raise exception 'The application has been returned to the candidate.'; end if;
  if not (a.status in ('SENT_TO_AD','CLOSED') or (a.status = 'SUBMITTED' and a.recruiter_id = auth.uid())) then
    raise exception 'The application has not been submitted to AD yet.';
  end if;
  if p_milestone = 'interim' then
    if a.interim_letter_at is not null then raise exception 'The interim letter has already been recorded.'; end if;
    update ifar_applications set interim_letter_at = ts, interim_letter_remark = rmk, updated_at = now() where id = a.id;
    perform _ifar_audit(a.id, 'INTERIM_LETTER', 'AD', 'AD', jsonb_build_object('remark', rmk));
  else
    if a.interim_letter_at is null then raise exception 'Record the interim letter first.'; end if;
    if a.bnm_sent_at is not null then raise exception 'Already recorded as sent to BNM.'; end if;
    update ifar_applications set bnm_sent_at = ts, bnm_remark = rmk, updated_at = now() where id = a.id;
    perform _ifar_audit(a.id, 'SENT_TO_BNM', 'AD', 'AD', jsonb_build_object('remark', rmk));
  end if;
  return ts;
end $$;
grant execute on function public.admin_mark_ifar_milestone(uuid,text,text) to authenticated;
