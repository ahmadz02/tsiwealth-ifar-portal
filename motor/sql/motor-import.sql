-- =====================================================================
-- STEP 3 — run in the PORTAL project (xslqmzwgprvwlqsheeug) SQL Editor,
-- after motor-setup.sql. Copy this whole file into a new SQL Editor tab.
--
-- 1. Select the word PASTE_THE_JSON_HERE below (only that word) and paste the
--    rows_json value copied in step 2 over it. Leave both $json$ markers in place.
-- 2. Click Run.
--
-- Result: imported_rows (copied now), skipped_rows (already copied before),
-- total_imported (all copied rows). Running it again never creates duplicates.
-- =====================================================================

select * from public.motor_import_legacy($json$
PASTE_THE_JSON_HERE
$json$::jsonb);

-- STEP 4 — check: total_imported above should equal the count from step 2a.
-- select workspace, imported, status, count(*) from public.motor_quotations group by 1, 2, 3 order by 1, 2, 3;
