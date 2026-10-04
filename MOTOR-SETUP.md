# Motor Takaful Quotation — Setup

There are two Supabase projects:

| Project | ID | Role |
|---|---|---|
| Old standalone | `olgijssakwgttfnomnwz` | Old `motor_proposals` table, to be locked and exported |
| IFAR Portal | `xslqmzwgprvwlqsheeug` | The one database from now on (`motor_quotations`) |

## 1. Lock the old standalone table (urgent)

In the **old standalone** project's SQL Editor, run `motor/sql/standalone-lock.sql`.
The three check queries at the end must return no rows. The old standalone pages stop working; the data stays.

## 2. Create the module in the portal database

In the **portal** project's SQL Editor, run `motor/sql/motor-setup.sql`
(after `setup-super-admin.sql`, which provides `is_super_admin()`).

## 3. Migrate the old quotations

All old quotations go to the **admin workspace** (badge "Imported"), keep their reference numbers,
and new numbers continue after the highest old number.

1. Old standalone project: run `motor/sql/standalone-export.sql` step 2 and copy the single `rows_json` value.
   For many rows, use the chunked query in step 3 instead.
2. Portal project:

   ```sql
   select * from public.motor_import_legacy($json$PASTE_THE_JSON_HERE$json$::jsonb);
   ```

   It returns rows imported, rows skipped (already imported) and the total imported.
   Running it again is safe, so a chunk can be repeated.
3. Check: `select count(*) from public.motor_quotations where imported;` matches the old count.

## 4. Deploy the website files

New: `motor/index.html`, `motor/motor-quotation.html`, `motor/motor-dashboard.js`, `motor/motor-assets.js`, `admin/admin-motor.html`.
Changed: `index.html` (Motor tile), `admin/admin-dashboard.html` (Motor card).

Do **not** deploy the old `motor-takaful/` folder. Delete it or move it out of the portal folder once the migration is done.

## How access works

- **IFAR**: sees and manages only their own quotations.
- **Super Admin** (`admin/admin-motor.html`): sees every IFAR quotation automatically, plus admin and imported quotations,
  and can edit, accept, decline, undo and delete them. The IFAR sees those changes in their own dashboard.
  Every change is written to the quotation's audit log with the user's email.
- Reference numbers (`MTVP-YYYY-NNNNN`) come from one database sequence and cannot be set from the browser.
- Delete is allowed only while a quotation is awaiting a response.
- New quotations prefill IFAR name and phone from the user's login profile (`full_name`, `phone`), when present.

## Test

1. IFAR A creates a quotation, saves it, downloads the PDF (`Quotation_<ref>_<vehicle>_<yyyymmdd>.pdf`).
2. IFAR B logs in and does not see IFAR A's quotation.
3. Super Admin opens Motor Quotations: sees IFAR A's quotation (badge "IFAR · name") and the imported rows.
4. Super Admin marks IFAR A's quotation Accepted; IFAR A refreshes and sees Accepted.
5. Super Admin creates their own quotation (badge "Admin"); IFARs do not see it.
6. A quotation expiring within 60 days shows "Create quotation"; after saving the renewal, the original shows "Renewal quoted".
