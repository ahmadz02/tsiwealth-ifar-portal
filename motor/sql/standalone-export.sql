-- =====================================================================
-- Run in the OLD STANDALONE Supabase project (olgijssakwgttfnomnwz).
-- Produces one JSON array of all quotations for motor_import_legacy() in the portal.
-- =====================================================================

-- 1) How many rows are there?
select count(*) from public.motor_proposals;

-- 2) Export everything (fine for a few hundred rows). Copy the single cell value.
select jsonb_agg(to_jsonb(m) order by m.created_at) as rows_json
from public.motor_proposals m;

-- 3) If the cell is too large to copy, export in chunks of 200 instead
--    (change OFFSET to 0, 200, 400, ... and import each chunk).
-- select jsonb_agg(to_jsonb(m) order by m.created_at) as rows_json
-- from (select * from public.motor_proposals order by created_at limit 200 offset 0) m;
