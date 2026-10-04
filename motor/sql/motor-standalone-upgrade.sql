-- =====================================================================
-- Motor Takaful Quotation — database for the IFAR Portal
-- Run in the MOTOR Supabase project (olgijssakwgttfnomnwz) SQL Editor — NOT the portal.
-- Safe to re-run. Keeps every existing quotation.
--
-- The motor data stays in this project. The browser never touches the table:
-- all reads/writes go through the Edge Function "motor-gateway", which checks the
-- user's IFAR Portal login and applies the rules (IFAR = own quotations only,
-- Super Admin = everything). anon / authenticated get no access here.
--
-- Existing quotations become "Imported" quotations in the admin workspace.
-- =====================================================================

-- ---------- 1) Lock: no public access ----------
drop policy if exists motor_proposals_select on public.motor_proposals;
drop policy if exists motor_proposals_insert on public.motor_proposals;
drop policy if exists motor_proposals_update on public.motor_proposals;
drop policy if exists motor_proposals_delete on public.motor_proposals;
alter table public.motor_proposals enable row level security;   -- no policies = no access
revoke all on public.motor_proposals from anon, authenticated;
revoke all on sequence public.motor_proposal_ref_seq from anon, authenticated;

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

-- ---------- 2) Quotation columns and statuses (same as motor-quotation-update.sql) ----------
alter table public.motor_proposals add column if not exists quotation_date timestamptz;
alter table public.motor_proposals add column if not exists responded_at   timestamptz;
alter table public.motor_proposals add column if not exists coverage_start date;
alter table public.motor_proposals add column if not exists coverage_end   date;
alter table public.motor_proposals add column if not exists renewed_from   uuid;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'motor_proposals_renewed_from_fkey') then
    alter table public.motor_proposals
      add constraint motor_proposals_renewed_from_fkey foreign key (renewed_from)
      references public.motor_proposals(id) on delete set null;
  end if;
end $$;

do $$
declare r record;
begin
  -- drop any old status rule (OPEN / SUBMITTED / CLOSED)
  for r in select conname from pg_constraint
           where conrelid = 'public.motor_proposals'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) ilike '%status%'
             and pg_get_constraintdef(oid) not ilike '%QUOTED%' loop
    execute format('alter table public.motor_proposals drop constraint %I', r.conname);
  end loop;

  update public.motor_proposals set status = 'QUOTED' where status = 'OPEN';
  update public.motor_proposals
     set status = 'ACCEPTED', responded_at = coalesce(responded_at, closed_at, submitted_at, updated_at)
   where status in ('SUBMITTED', 'CLOSED');

  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.motor_proposals'::regclass and contype = 'c'
                   and pg_get_constraintdef(oid) ilike '%QUOTED%') then
    alter table public.motor_proposals
      add constraint motor_proposals_status_check check (status in ('QUOTED', 'ACCEPTED', 'DECLINED'));
  end if;
end $$;
alter table public.motor_proposals alter column status set default 'QUOTED';

update public.motor_proposals set quotation_date = coalesce(updated_at, created_at) where quotation_date is null;
update public.motor_proposals
   set coverage_start = to_date(substring(coverage_term from '^\s*(\d{1,2}/\d{1,2}/\d{4})'), 'DD/MM/YYYY')
 where coverage_start is null and coverage_term ~ '^\s*\d{1,2}/\d{1,2}/\d{4}';
update public.motor_proposals
   set coverage_end = to_date(substring(coverage_term from '(\d{1,2}/\d{1,2}/\d{4})\s*$'), 'DD/MM/YYYY')
 where coverage_end is null and coverage_term ~ '\d{1,2}/\d{1,2}/\d{4}.*\d{1,2}/\d{1,2}/\d{4}\s*$';

-- ---------- 3) Portal ownership ----------
-- created_by now holds the IFAR Portal user id (users live in the portal project, so no foreign key).
alter table public.motor_proposals alter column created_by drop default;
alter table public.motor_proposals drop constraint if exists motor_proposals_created_by_fkey;

-- Existing rows get workspace 'ADMIN' and imported = true; new rows default to 'IFAR' / false.
do $$ begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'motor_proposals' and column_name = 'workspace') then
    alter table public.motor_proposals add column workspace text not null default 'ADMIN'
      check (workspace in ('IFAR', 'ADMIN'));
    alter table public.motor_proposals alter column workspace set default 'IFAR';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'motor_proposals' and column_name = 'imported') then
    alter table public.motor_proposals add column imported boolean not null default true;
    alter table public.motor_proposals alter column imported set default false;
  end if;
end $$;

alter table public.motor_proposals add column if not exists created_by_name  text;
alter table public.motor_proposals add column if not exists created_by_email text;
alter table public.motor_proposals add column if not exists updated_by       uuid;
alter table public.motor_proposals add column if not exists updated_by_email text;
-- Kept by trigger so the original shows "Renewal quoted" even when someone else renewed it
alter table public.motor_proposals add column if not exists renewal_id  uuid;
alter table public.motor_proposals add column if not exists renewal_ref text;

create index if not exists motor_proposals_created_by_idx   on public.motor_proposals (created_by);
create index if not exists motor_proposals_workspace_idx    on public.motor_proposals (workspace);
create index if not exists motor_proposals_coverage_end_idx on public.motor_proposals (coverage_end);
create index if not exists motor_proposals_renewed_from_idx on public.motor_proposals (renewed_from);

-- One renewal per quotation (only added when existing data allows it)
do $$ begin
  if not exists (select 1 from public.motor_proposals where renewed_from is not null
                 group by renewed_from having count(*) > 1) then
    create unique index if not exists motor_proposals_renewed_from_uidx
      on public.motor_proposals (renewed_from) where renewed_from is not null;
  end if;
end $$;

-- ---------- 4) Renewal link trigger ----------
create or replace function public.motor_proposals_renewal_link()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and new.renewed_from is not null then
    update public.motor_proposals
       set renewal_id = new.id, renewal_ref = new.reference_no
     where id = new.renewed_from;
  elsif tg_op = 'DELETE' then
    update public.motor_proposals
       set renewal_id = null, renewal_ref = null
     where renewal_id = old.id;
  end if;
  return null;
end;
$$;
revoke all on function public.motor_proposals_renewal_link() from public, anon, authenticated;

drop trigger if exists motor_proposals_renewal_link on public.motor_proposals;
create trigger motor_proposals_renewal_link
after insert or delete on public.motor_proposals
for each row execute function public.motor_proposals_renewal_link();

-- Backfill links for existing renewals (earliest renewal wins)
update public.motor_proposals p
   set renewal_id = c.id, renewal_ref = c.reference_no
  from (select distinct on (renewed_from) id, reference_no, renewed_from
          from public.motor_proposals
         where renewed_from is not null
         order by renewed_from, created_at) c
 where c.renewed_from = p.id and p.renewal_id is distinct from c.id;

-- ---------- 5) Refresh the API and check ----------
notify pgrst, 'reload schema';

select workspace, imported, status, count(*)
  from public.motor_proposals group by 1, 2, 3 order by 1, 2, 3;
-- Must return no rows (no public access):
select grantee, privilege_type from information_schema.role_table_grants
 where table_schema = 'public' and table_name = 'motor_proposals' and grantee in ('anon', 'authenticated');
