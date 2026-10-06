-- =====================================================================
-- STEP 2 — run in the MOTOR project (olgijssakwgttfnomnwz) SQL Editor.
-- Read-only: nothing in this project is changed or deleted.
-- =====================================================================

-- 2a) How many quotations are there? Write this number down.
select count(*) as total_quotations from public.motor_proposals;

-- 2b) Export them all as one JSON value. Open the "rows_json" cell, Ctrl+A, Ctrl+C.
select jsonb_agg(to_jsonb(m) order by m.created_at) as rows_json
from public.motor_proposals m;

-- If the cell is too large to copy in one go, export in chunks of 200 instead
-- (change OFFSET to 0, 200, 400, ... and import each chunk with step 3):
-- select jsonb_agg(to_jsonb(m) order by m.created_at) as rows_json
-- from (select * from public.motor_proposals order by created_at limit 200 offset 0) m;
