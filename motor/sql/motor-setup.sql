-- =====================================================================
-- TSI Wealth IFAR Portal — Motor Takaful Quotation module
-- Run in the PORTAL Supabase project (xslqmzwgprvwlqsheeug) SQL Editor,
-- AFTER setup-super-admin.sql (needs public.is_super_admin()).
-- Safe to re-run. Does not delete any quotation.
--
-- Access rules
--   IFAR        : reads / creates / changes only their own quotations (workspace 'IFAR').
--   Super Admin : reads and fully manages every quotation — all IFAR quotations
--                 automatically, plus the admin workspace (admin's own + imported).
--   anon        : no access.
-- =====================================================================

create extension if not exists pgcrypto;

-- Helpers that must not be callable through the API live in "private"
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- ---------- Global, atomic reference numbering (MTVP-2026-00001) ----------
create sequence if not exists public.motor_quotation_ref_seq;
revoke all on sequence public.motor_quotation_ref_seq from public, anon, authenticated;

create or replace function private.motor_next_ref()
returns text
language sql
volatile
security definer
set search_path = public
as $$
  select 'MTVP-' || to_char(now() at time zone 'Asia/Kuala_Lumpur', 'YYYY') || '-' ||
         lpad(nextval('public.motor_quotation_ref_seq')::text, 5, '0');
$$;
revoke all on function private.motor_next_ref() from public;
grant execute on function private.motor_next_ref() to authenticated;

-- ---------- Table ----------
create table if not exists public.motor_quotations (
  id                  uuid primary key default gen_random_uuid(),
  reference_no        text not null unique,

  -- 'IFAR' = created by an IFAR in the motor module, 'ADMIN' = admin workspace
  workspace           text not null default 'IFAR' check (workspace in ('IFAR', 'ADMIN')),
  created_by          uuid references auth.users(id) on delete set null,
  created_by_name     text,
  created_by_email    text,
  imported            boolean not null default false,
  legacy_id           uuid unique,          -- id in the old standalone table
  legacy_renewed_from uuid,                 -- renewed_from in the old standalone table

  -- IFAR (as printed on the quotation)
  ifar_name           text not null,
  ifar_phone          text not null,

  -- Prospect / vehicle
  owner_name          text not null,
  owner_id_no         text not null,
  vehicle_reg_no      text not null,
  vehicle_type        text not null,
  vehicle_model       text not null,
  engine_capacity     text,
  usage_type          text not null,
  vehicle_address     text,
  prospect_email      text,
  prospect_phone      text,
  ncd                 text,
  coverage_term       text,
  coverage_start      date,
  coverage_end        date,

  -- [{operator, sum_covered, windscreen_covered, road_tax, admin_fee, note,
  --   options:[{code, name, takaful_price, road_tax, admin_fee}]}]
  quotes              jsonb not null default '[]'::jsonb,
  selected_quote      jsonb,

  status              text not null default 'QUOTED' check (status in ('QUOTED', 'ACCEPTED', 'DECLINED')),
  quotation_date      timestamptz,
  responded_at        timestamptz,

  -- Renewal chain. renewal_id / renewal_ref are kept by triggers so the
  -- original row shows "Renewal quoted" even when someone else renewed it.
  renewed_from        uuid references public.motor_quotations(id) on delete set null,
  renewal_id          uuid,
  renewal_ref         text,

  audit_log           jsonb not null default '[]'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  updated_by          uuid,
  updated_by_email    text
);

create index if not exists motor_quotations_created_by_idx   on public.motor_quotations (created_by);
create index if not exists motor_quotations_workspace_idx    on public.motor_quotations (workspace);
create index if not exists motor_quotations_status_idx       on public.motor_quotations (status);
create index if not exists motor_quotations_coverage_end_idx on public.motor_quotations (coverage_end);
-- One renewal per quotation
create unique index if not exists motor_quotations_renewed_from_uidx
  on public.motor_quotations (renewed_from) where renewed_from is not null;

-- ---------- Triggers ----------
-- Browser users run as 'anon' / 'authenticated'. Anything else (SQL Editor,
-- migration function, foreign-key actions, security-definer triggers) is trusted.

create or replace function public.motor_quotations_before_insert()
returns trigger
language plpgsql
set search_path = public, private
as $$
declare
  v_email text := auth.jwt() ->> 'email';
begin
  if current_user not in ('anon', 'authenticated') then
    if new.reference_no is null then new.reference_no := private.motor_next_ref(); end if;
    return new;
  end if;

  if auth.uid() is null then
    raise exception 'Please log in to create a quotation.';
  end if;

  new.reference_no        := private.motor_next_ref();   -- never chosen by the browser
  new.created_by          := auth.uid();
  new.created_by_email    := v_email;
  new.created_by_name     := coalesce(nullif(trim(auth.jwt() -> 'user_metadata' ->> 'full_name'), ''),
                                      split_part(coalesce(v_email, ''), '@', 1));
  new.imported            := false;
  new.legacy_id           := null;
  new.legacy_renewed_from := null;
  new.renewal_id          := null;
  new.renewal_ref         := null;
  new.created_at          := now();
  new.updated_at          := now();
  new.updated_by          := auth.uid();
  new.updated_by_email    := v_email;

  -- A renewal may only point at a quotation the user can see
  if new.renewed_from is not null
     and not exists (select 1 from public.motor_quotations m where m.id = new.renewed_from) then
    raise exception 'The original quotation for this renewal was not found.';
  end if;

  return new;
end;
$$;

create or replace function public.motor_quotations_before_update()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_skip constant text[] := array['renewal_id', 'renewal_ref', 'renewed_from',
                                  'updated_at', 'updated_by', 'updated_by_email'];
begin
  if current_user not in ('anon', 'authenticated') then
    -- system change (renewal link, migration): keep "last updated" as it was
    if (to_jsonb(new) - v_skip) = (to_jsonb(old) - v_skip) then
      new.updated_at := old.updated_at;
      new.updated_by := old.updated_by;
      new.updated_by_email := old.updated_by_email;
    end if;
    return new;
  end if;

  if new.id                  is distinct from old.id
  or new.reference_no        is distinct from old.reference_no
  or new.workspace           is distinct from old.workspace
  or new.created_by          is distinct from old.created_by
  or new.created_by_name     is distinct from old.created_by_name
  or new.created_by_email    is distinct from old.created_by_email
  or new.imported            is distinct from old.imported
  or new.legacy_id           is distinct from old.legacy_id
  or new.legacy_renewed_from is distinct from old.legacy_renewed_from
  or new.renewed_from        is distinct from old.renewed_from
  or new.renewal_id          is distinct from old.renewal_id
  or new.renewal_ref         is distinct from old.renewal_ref
  or new.created_at          is distinct from old.created_at then
    raise exception 'Reference number, owner and renewal links cannot be changed.';
  end if;

  new.updated_at       := now();
  new.updated_by       := auth.uid();
  new.updated_by_email := auth.jwt() ->> 'email';
  return new;
end;
$$;

-- Keeps renewal_id / renewal_ref on the original quotation
create or replace function public.motor_quotations_renewal_link()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and new.renewed_from is not null then
    update public.motor_quotations
       set renewal_id = new.id, renewal_ref = new.reference_no
     where id = new.renewed_from;
  elsif tg_op = 'DELETE' then
    update public.motor_quotations
       set renewal_id = null, renewal_ref = null
     where renewal_id = old.id;
  end if;
  return null;
end;
$$;
revoke all on function public.motor_quotations_renewal_link() from public, anon, authenticated;

drop trigger if exists motor_quotations_before_insert on public.motor_quotations;
create trigger motor_quotations_before_insert
before insert on public.motor_quotations
for each row execute function public.motor_quotations_before_insert();

drop trigger if exists motor_quotations_before_update on public.motor_quotations;
create trigger motor_quotations_before_update
before update on public.motor_quotations
for each row execute function public.motor_quotations_before_update();

drop trigger if exists motor_quotations_renewal_link on public.motor_quotations;
create trigger motor_quotations_renewal_link
after insert or delete on public.motor_quotations
for each row execute function public.motor_quotations_renewal_link();

-- ---------- Row level security ----------
alter table public.motor_quotations enable row level security;

revoke all on public.motor_quotations from anon;
grant select, insert, update, delete on public.motor_quotations to authenticated;

drop policy if exists motor_quotations_select on public.motor_quotations;
create policy motor_quotations_select on public.motor_quotations
  for select to authenticated
  using ((workspace = 'IFAR' and created_by = auth.uid()) or public.is_super_admin());

drop policy if exists motor_quotations_insert on public.motor_quotations;
create policy motor_quotations_insert on public.motor_quotations
  for insert to authenticated
  with check ((workspace = 'IFAR' and created_by = auth.uid())
              or (workspace = 'ADMIN' and public.is_super_admin()));

drop policy if exists motor_quotations_update on public.motor_quotations;
create policy motor_quotations_update on public.motor_quotations
  for update to authenticated
  using ((workspace = 'IFAR' and created_by = auth.uid()) or public.is_super_admin())
  with check ((workspace = 'IFAR' and created_by = auth.uid()) or public.is_super_admin());

-- Only quotations still awaiting a response can be deleted
drop policy if exists motor_quotations_delete on public.motor_quotations;
create policy motor_quotations_delete on public.motor_quotations
  for delete to authenticated
  using (status = 'QUOTED'
         and ((workspace = 'IFAR' and created_by = auth.uid()) or public.is_super_admin()));

-- ---------- Migration from the standalone module ----------
-- Every imported row goes to the ADMIN workspace and keeps its old reference number.
-- Idempotent: rows already imported (same legacy id or reference number) are skipped,
-- so it can be run in chunks. Only callable from the SQL Editor.
create or replace function public.motor_import_legacy(p_rows jsonb)
returns table (imported_rows integer, skipped_rows integer, total_imported bigint)
language plpgsql
security definer
set search_path = public, private
as $$
declare
  r        jsonb;
  v_status text;
  v_term   text;
  v_id     uuid;
  v_ok     integer := 0;
  v_skip   integer := 0;
  v_max    bigint;
  v_last   bigint;
  v_called boolean;
begin
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Paste the JSON array produced by the export query.';
  end if;

  for r in select value from jsonb_array_elements(p_rows) loop
    v_status := upper(coalesce(r ->> 'status', 'QUOTED'));
    v_status := case when v_status in ('ACCEPTED', 'SUBMITTED', 'CLOSED') then 'ACCEPTED'
                     when v_status = 'DECLINED' then 'DECLINED'
                     else 'QUOTED' end;
    v_term := r ->> 'coverage_term';
    v_id := null;

    insert into public.motor_quotations (
      reference_no, workspace, created_by, created_by_name, imported, legacy_id, legacy_renewed_from,
      ifar_name, ifar_phone, owner_name, owner_id_no, vehicle_reg_no, vehicle_type, vehicle_model,
      engine_capacity, usage_type, vehicle_address, prospect_email, prospect_phone, ncd, coverage_term,
      coverage_start, coverage_end, quotes, selected_quote, status, quotation_date, responded_at,
      audit_log, created_at, updated_at
    ) values (
      r ->> 'reference_no', 'ADMIN', null, 'Imported (standalone)', true,
      (r ->> 'id')::uuid, nullif(r ->> 'renewed_from', '')::uuid,
      coalesce(r ->> 'ifar_name', ''), coalesce(r ->> 'ifar_phone', ''),
      coalesce(r ->> 'owner_name', ''), coalesce(r ->> 'owner_id_no', ''),
      coalesce(r ->> 'vehicle_reg_no', ''), coalesce(r ->> 'vehicle_type', ''),
      coalesce(r ->> 'vehicle_model', ''), r ->> 'engine_capacity', coalesce(r ->> 'usage_type', ''),
      r ->> 'vehicle_address', r ->> 'prospect_email', r ->> 'prospect_phone', r ->> 'ncd', v_term,
      coalesce(nullif(r ->> 'coverage_start', '')::date,
               case when v_term ~ '^\s*\d{1,2}/\d{1,2}/\d{4}'
                    then to_date(substring(v_term from '^\s*(\d{1,2}/\d{1,2}/\d{4})'), 'DD/MM/YYYY') end),
      coalesce(nullif(r ->> 'coverage_end', '')::date,
               case when v_term ~ '\d{1,2}/\d{1,2}/\d{4}.*\d{1,2}/\d{1,2}/\d{4}\s*$'
                    then to_date(substring(v_term from '(\d{1,2}/\d{1,2}/\d{4})\s*$'), 'DD/MM/YYYY') end),
      coalesce(r -> 'quotes', '[]'::jsonb),
      case when jsonb_typeof(r -> 'selected_quote') = 'object' then r -> 'selected_quote' end,
      v_status,
      coalesce(nullif(r ->> 'quotation_date', '')::timestamptz, nullif(r ->> 'updated_at', '')::timestamptz,
               nullif(r ->> 'created_at', '')::timestamptz, now()),
      case when v_status = 'QUOTED' then null
           else coalesce(nullif(r ->> 'responded_at', '')::timestamptz, nullif(r ->> 'closed_at', '')::timestamptz,
                         nullif(r ->> 'submitted_at', '')::timestamptz, nullif(r ->> 'updated_at', '')::timestamptz) end,
      (case when jsonb_typeof(r -> 'audit_log') = 'array' then r -> 'audit_log' else '[]'::jsonb end)
        || jsonb_build_array(jsonb_build_object('action', 'Imported from the standalone module', 'timestamp', now())),
      coalesce(nullif(r ->> 'created_at', '')::timestamptz, now()),
      coalesce(nullif(r ->> 'updated_at', '')::timestamptz, now())
    )
    on conflict do nothing
    returning id into v_id;

    if v_id is null then v_skip := v_skip + 1; else v_ok := v_ok + 1; end if;
  end loop;

  -- Re-link renewals (works across chunks); one renewal per original
  with links as (
    select distinct on (p.id) c.id as child_id, p.id as parent_id
    from public.motor_quotations c
    join public.motor_quotations p on p.legacy_id = c.legacy_renewed_from
    where c.imported and c.renewed_from is null
      and not exists (select 1 from public.motor_quotations x where x.renewed_from = p.id)
    order by p.id, c.created_at
  )
  update public.motor_quotations c set renewed_from = l.parent_id
  from links l where c.id = l.child_id;

  update public.motor_quotations p
     set renewal_id = c.id, renewal_ref = c.reference_no
    from public.motor_quotations c
   where c.renewed_from = p.id and p.renewal_id is distinct from c.id;

  -- New numbers continue after the highest imported number
  select max((regexp_match(reference_no, '(\d+)$'))[1]::bigint) into v_max from public.motor_quotations;
  select last_value, is_called into v_last, v_called from public.motor_quotation_ref_seq;
  if v_max is not null and v_max > (case when v_called then v_last else 0 end) then
    perform setval('public.motor_quotation_ref_seq', v_max, true);
  end if;

  return query select v_ok, v_skip, (select count(*) from public.motor_quotations where imported);
end;
$$;
revoke all on function public.motor_import_legacy(jsonb) from public, anon, authenticated;

-- Refresh the Supabase API
notify pgrst, 'reload schema';
