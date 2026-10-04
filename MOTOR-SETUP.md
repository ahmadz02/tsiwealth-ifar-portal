# Motor Takaful Quotation — Setup

The motor data **stays in its own Supabase project**. Logins stay in the portal project.

| Project | ID | Holds |
|---|---|---|
| IFAR Portal | `xslqmzwgprvwlqsheeug` | Logins, claims, confirmations, `is_super_admin()` |
| Motor | `olgijssakwgttfnomnwz` | `motor_proposals` table + `motor-gateway` Edge Function |

The browser never reads the motor table directly. Every call goes to the **motor-gateway** Edge Function,
which checks the user's IFAR Portal login and applies the rules. The table itself is closed to the public key.

Nothing needs to be run in the portal project, and no data is moved.

## 1. Update and lock the motor database

Motor project (`olgijssakwgttfnomnwz`) → SQL Editor → run `motor/sql/motor-standalone-upgrade.sql`.

- Locks the table (no public access). This includes everything in `standalone-lock.sql`.
- Adds the portal columns (owner, workspace, renewal link, updated by).
- Existing quotations stay and become **Imported** quotations, visible to the Super Admin.
- The last check query must return no rows.

The old standalone pages stop working after this step. That is intended.

## 2. Deploy the gatekeeper function (motor project)

Motor project → **Edge Functions** → **Deploy a new function** → **Via Editor**:

1. Name: `motor-gateway`
2. Paste the contents of `motor/supabase/functions/motor-gateway/index.ts` and deploy.
3. Open the function's **Details / Settings** and turn **OFF** "Enforce JWT verification" (Verify JWT).
   The login token comes from the portal project, so the function checks it itself.
   If this stays on, every call fails with 401.

Then **Edge Functions → Secrets** (motor project), add:

| Name | Value |
|---|---|
| `PORTAL_SUPABASE_URL` | `https://xslqmzwgprvwlqsheeug.supabase.co` |
| `PORTAL_PUBLISHABLE_KEY` | the portal key from `supabase-config.js` (`sb_publishable_iw0n…`) |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically.

## 3. Deploy the website files

New: `motor/index.html`, `motor/motor-quotation.html`, `motor/motor-dashboard.js`, `motor/motor-api.js`,
`motor/motor-assets.js`, `admin/admin-motor.html`.
Changed: `index.html` (Motor tile), `admin/admin-dashboard.html` (Motor card).

The `motor/sql` and `motor/supabase` folders are for Supabase, not the website (harmless if deployed).
Do **not** deploy the old `motor-takaful/` folder. Delete it or move it out of the portal folder.

## How access works

- **IFAR**: sees and manages only their own quotations.
- **Super Admin** (`admin/admin-motor.html`): sees every IFAR quotation automatically, plus admin and imported quotations,
  and can edit, accept, decline, undo and delete them. The IFAR sees those changes.
  Every change is written to the quotation's audit log with the user's email.
- Reference numbers (`MTVP-YYYY-NNNNN`) come from the motor database sequence; the browser cannot set them.
- Delete is allowed only while a quotation is awaiting a response.
- New quotations prefill IFAR name and phone from the user's login profile (`full_name`, `phone`), when present.

## Test

1. IFAR A creates a quotation, saves it, downloads the PDF (`Quotation_<ref>_<vehicle>_<yyyymmdd>.pdf`).
2. IFAR B logs in and does not see IFAR A's quotation.
3. Super Admin opens Motor Quotations: sees IFAR A's quotation (badge "IFAR · name") and the old quotations (badge "Imported").
4. Super Admin marks IFAR A's quotation Accepted; IFAR A refreshes and sees Accepted.
5. Super Admin creates their own quotation (badge "Admin"); IFARs do not see it.
6. A quotation expiring within 60 days shows "Create quotation"; after saving the renewal, the original shows "Renewal quoted".

If a page shows "Unable to reach the motor quotation service" or a 401 error, check step 2
(function name `motor-gateway`, JWT verification off, both secrets set).
