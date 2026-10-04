-- =====================================================================
-- Run in the OLD STANDALONE Supabase project (olgijssakwgttfnomnwz) — NOT the portal.
-- Removes all public (anon) and logged-in access to the standalone motor table,
-- its token functions and its storage bucket. Data is kept and stays readable
-- from the SQL Editor for the migration. The standalone pages stop working.
-- Safe to re-run.
-- =====================================================================
begin;

drop policy if exists motor_proposals_select on public.motor_proposals;
drop policy if exists motor_proposals_insert on public.motor_proposals;
drop policy if exists motor_proposals_update on public.motor_proposals;
drop policy if exists motor_proposals_delete on public.motor_proposals;
alter table public.motor_proposals enable row level security;   -- no policies = no access
revoke all on public.motor_proposals from anon, authenticated;

do $$ begin
  execute 'revoke all on sequence public.motor_proposal_ref_seq from anon, authenticated';
exception when undefined_table then null; end $$;

do $$ begin
  execute 'revoke all on function public.get_motor_proposal_by_token(uuid) from public, anon, authenticated';
exception when undefined_function then null; end $$;

do $$ begin
  execute 'revoke all on function public.submit_motor_proposal(uuid, text, text, numeric, text, text, text, text) from public, anon, authenticated';
exception when undefined_function then null; end $$;

do $$ begin
  execute 'revoke all on function public.motor_token_is_open(text) from public, anon, authenticated';
exception when undefined_function then null; end $$;

drop policy if exists "motor proposal uploads by open token" on storage.objects;
drop policy if exists "motor proposal files readable" on storage.objects;
drop policy if exists "motor proposal files readable by owner" on storage.objects;

commit;

-- Checks: all three should return no rows
select policyname from pg_policies where tablename = 'motor_proposals';
select grantee, privilege_type from information_schema.role_table_grants
 where table_schema = 'public' and table_name = 'motor_proposals' and grantee in ('anon', 'authenticated');
select policyname from pg_policies where schemaname = 'storage' and policyname ilike 'motor proposal%';
