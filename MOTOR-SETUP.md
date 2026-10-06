# Motor Takaful Quotation — Setup

Motor quotations live in the **portal database**, next to claims and confirmations.
The old motor project keeps its data as a locked backup. Nothing there is deleted.

| Project | ID | Role |
|---|---|---|
| IFAR Portal | `xslqmzwgprvwlqsheeug` | The one database (`motor_quotations`) |
| Motor (old) | `olgijssakwgttfnomnwz` | Locked backup of `motor_proposals` — copied once, then left alone |

## 1. Create the module in the portal database

Portal project → SQL Editor → run `motor/sql/motor-setup.sql`
(after `setup-super-admin.sql`, which provides `is_super_admin()`). Expected: "Success. No rows returned".

## 2. Export from the motor project

Motor project → SQL Editor → run `motor/sql/motor-export.sql`.

- 2a gives the number of quotations. Write it down.
- 2b gives one `rows_json` cell. Open it, click inside, **Ctrl+A**, **Ctrl+C**.
  The last line must be `]` (otherwise the copy was cut off — use the chunked query in the same file).

## 3. Import into the portal

Portal project → new SQL Editor tab → paste the whole of `motor/sql/motor-import.sql`.
Select only the word `PASTE_THE_JSON_HERE`, paste (**Ctrl+V**) over it, keep both `$json$` markers, click **Run**.

It returns `imported_rows`, `skipped_rows` (already copied) and `total_imported`.
Running it again never creates duplicates.

## 4. Check

`total_imported` must equal the count from step 2a.

What is copied: every quotation with its reference number, IFAR and prospect details, quotes, selected option,
status, response date, coverage dates, renewal links and history. Old quotations go to the admin workspace
(badge "Imported"). New reference numbers continue after the highest old number.
Not copied: payment-slip files from the first standalone version — they stay in the motor project's storage.

## 5. Deploy the website files

New: `motor/index.html`, `motor/motor-quotation.html`, `motor/motor-dashboard.js`, `motor/motor-api.js`,
`motor/motor-assets.js`, `admin/admin-motor.html`.
Changed: `index.html` (Motor tile), `admin/admin-dashboard.html` (Motor card).

`motor/sql` is for Supabase, not the website (harmless if deployed).
Do **not** deploy the old `motor-takaful/` folder. Delete it or move it out of the portal folder.

## 6. Tidy up the motor project (after checking step 4)

- Edge Functions → `motor-gateway` → delete it, and delete the secrets `PORTAL_SUPABASE_URL` and `PORTAL_PUBLISHABLE_KEY`.
- Keep the `motor_proposals` table as the backup. It is already closed to the public
  (if in doubt, run `motor/sql/standalone-lock.sql` there again — it is safe to repeat).

## How access works

- **IFAR**: sees and manages only their own quotations.
- **Super Admin** (`admin/admin-motor.html`): sees every IFAR quotation automatically, plus admin and imported quotations,
  and can edit, accept, decline, undo and delete them. The IFAR sees those changes.
  Every change is written to the quotation's history with the user's email.
- Enforced by the database (row level security + triggers), not by the page.
- Reference numbers (`MTVP-YYYY-NNNNN`) come from one database sequence; the browser cannot set them.
- Delete is allowed only while a quotation is awaiting a response.
- New quotations prefill IFAR name and phone from the user's login profile (`full_name`, `phone`), when present.

## Test

1. IFAR A creates a quotation, saves it, downloads the PDF (`Quotation_<ref>_<vehicle>_<yyyymmdd>.pdf`).
2. IFAR B logs in and does not see IFAR A's quotation.
3. Super Admin opens Motor Quotations: sees IFAR A's quotation (badge "IFAR · name") and the old quotations (badge "Imported").
4. Super Admin marks IFAR A's quotation Accepted; IFAR A refreshes and sees Accepted.
5. Super Admin creates their own quotation (badge "Admin"); IFARs do not see it.
6. A quotation expiring within 60 days shows "Create quotation"; after saving the renewal, the original shows "Renewal quoted".
