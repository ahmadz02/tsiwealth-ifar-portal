# Phase 4 Setup

## 1. Database migration
Run the complete contents of `setup-phase4.sql` in Supabase SQL Editor.

Expected result: `Success. No rows returned`.

## 2. Create the Edge Function
Create a Supabase Edge Function named:

`send-confirmation-email`

Paste the contents of:

`supabase/functions/send-confirmation-email/index.ts`

into the function, then deploy it.

## 3. Configure Edge Function secrets
Set these secrets in Supabase for the Edge Function:

- `RESEND_API_KEY` = your Resend API key
- `EMAIL_FROM` = verified sender, e.g. `TSI Wealth Planners <confirmation@yourdomain.com>`
- `APP_BASE_URL` = your deployed app base URL, e.g. `https://your-project.vercel.app`
- `EMAIL_REPLY_TO` = optional reply-to email

Do not put `RESEND_API_KEY` in `supabase-config.js`, `login.html`, `index.html`, or GitHub.

## 4. Deploy web files
Deploy these together:

- `login.html`
- `index.html`
- `confirmation.html`
- `supabase-config.js`

## 5. Test
1. Adviser logs in.
2. Create a new confirmation.
3. Click `Send Link to ...`.
4. Confirm the participant receives the email.
5. Open the secure link in a private/incognito window.
6. Client signs and submits.
7. Adviser refreshes dashboard and countersigns.
8. Open the completed record and confirm the audit trail includes Created, Email Sent, Client Viewed, Client Signed, Adviser Signed, and Closed.

## Security behavior added
- Email provider secret stays server-side in an Edge Function.
- Client access remains token based and does not expose the confirmation table publicly.
- Audit events are append-only for normal browser users.
- Closed confirmations cannot be updated by normal adviser requests.
- Deletion is limited to confirmations still in `AWAITING_CLIENT` state.
