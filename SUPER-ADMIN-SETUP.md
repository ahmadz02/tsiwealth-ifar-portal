# Super Admin Deployment

## 1. Set the authorised email

Open `setup-super-admin.sql` and replace:

```sql
'replace-with-admin-email@example.com'
```

with the lowercase email used by the Super Admin's Supabase Auth account. Add additional emails to the same SQL array when required.

## 2. Run the database migration

Run the complete `setup-super-admin.sql` file in the Supabase SQL Editor after the existing project SQL has been installed.

## 3. Deploy the Edge Function

Deploy:

```text
coo/supabase/functions/admin-portal-action/index.ts
```

Function name:

```text
admin-portal-action
```

It uses the same secrets as the existing email functions:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` or `SUPABASE_PUBLISHABLE_KEYS`
- `SUPABASE_SERVICE_ROLE_KEY`
- `RESEND_API_KEY`
- `EMAIL_FROM`
- `EMAIL_REPLY_TO` (optional)
- `APP_BASE_URL`

`APP_BASE_URL` should be the deployed portal origin without a trailing slash, for example `https://portal.example.com`.

## 4. Deploy the website files

Deploy the full project so that the new `admin` directory and the modified login, portal, claim dashboard and claim form files are included.

## 5. Test

1. Sign in using the configured Super Admin email.
2. Confirm redirection to `admin/admin-dashboard.html`.
3. Receive a submitted claim and confirm the IFAR gets an email.
4. Return a submitted or received claim with a reason.
5. Sign in as the IFAR, reopen the returned claim, amend it and resubmit it.
6. Send a reminder for `AWAITING_CLIENT` and verify the client link.
7. Send a reminder for `AWAITING_ADVISER` and verify the IFAR link.
8. Confirm a normal IFAR cannot open any admin page or retrieve all-user records.
