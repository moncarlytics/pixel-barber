# Design: Staff Invitation & Account Deactivation

**Date:** 2026-09-25
**Status:** Approved in brainstorming, awaiting written-spec review
**Origin:** Sub-project 2 of 2 for making barber assignment usable by a real shop. Sub-project 1
(`2026-09-24-barbers-management-schedules-design.md`) lets managers set schedules and skills, but
no barber account can be created from the app — every staff account except the bootstrap Owner
must originate from an invite (PRD §46), and that flow doesn't exist yet.

## Goal

Let the Owner invite new staff of any role by SMS or email, let the invitee set their own password
from a link and land signed in, and let the Owner resend/revoke pending invites and
deactivate/reactivate existing accounts.

## Out of scope

- Editing an active staff member's role or branch.
- Forgot password (staff or customer).
- The Audit Log viewer (App Flow 8.12).
- Staff assigned to more than one branch — an invite assigns one branch (or none).
- Passkeys (PRD §47).
- Customer login.
- Automated SMS delivery tests (each message costs money) — the SMS path is unit-tested only.

## Decisions

1. **Delivery: SMS and email.** Phone invites are texted through Arkesel (already used by the
   `send-sms` auth hook). Email invites are sent through **Resend**, because Supabase's built-in
   mailer only sends its own auth emails and only to project team members without custom SMTP.
   Until `RESEND_API_KEY` is set, email invites fail with a clear "email sending isn't set up" error;
   SMS invites work immediately.
2. **Only the Owner invites** (the `manage_staff` capability, PRD §46.2). Branch Managers keep
   managing a barber's schedule, skills and PIN once the account exists (PRD §46.3).
3. **Scope includes deactivate/reactivate** for active accounts; role/branch editing does not.
4. **Invite links are valid for 7 days.** Resend issues a new token and expiry, killing the old link.
5. **Own invite token (approach A), not Supabase's `generateLink`.** `generateLink` is email-only
   and bound to the project-wide 1-hour `otp_expiry` shared with customer OTPs, so it can't serve
   phone invites or a 7-day window. This deliberately departs from the mechanism sketched in
   backend-schema §3.4 while keeping its shape (two service-role Edge Functions, state on
   `staff_users`, no new table).
6. **Staff login accepts phone or email.** SMS-invited staff have phone-only logins, and the staff
   login screen is email-only today.

## Data model

### Changed: `staff_users`

Two new columns (the four invite columns — `invite_status`, `invited_by_staff_id`, `invited_at`,
`invite_accepted_at` — already exist):

| column | type | notes |
|---|---|---|
| `invite_token_hash` | text, null | hex SHA-256 of the raw token; raw token exists only in the sent message |
| `invite_expires_at` | timestamptz, null | `now() + interval '7 days'` when issued |

Both are **not client-readable**: `20260925100000_protect_staff_pin_hash_reads.sql` grants client
SELECT on `staff_users` column by column, so new columns are unreadable by default. The migration
must not add them to that grant, and a test locks this in. `invite_token_hash` gets a unique
partial index (`where invite_token_hash is not null`) for the accept lookup.

### What an invite creates, per role

| role | branch field | extra rows |
|---|---|---|
| `barber` | required (home branch) | `barbers` row: `home_branch_id` = branch, `status = 'offline'`; no schedule, no skills |
| `branch_manager`, `receptionist` | required | one `staff_branch_assignments` row |
| `owner`, `analyst` | not asked (business-wide) | none |

Plus, always: an `auth.users` login with a **confirmed** email or phone and **no password** (nobody
can sign in until the invitee sets one), and a `staff_users` row with `invite_status = 'pending'`,
`invited_by_staff_id` = the Owner's `staff_users.id`, `invited_at = now()`, `is_active = true`.

### Invite and account states

`list_staff_accounts()` derives the displayed status:

| displayed status | condition |
|---|---|
| Invite pending | `invite_status = 'pending'` and `invite_expires_at >= now()` |
| Invite expired | `invite_status = 'pending'` and `invite_expires_at < now()` |
| Revoked | `invite_status = 'revoked'` |
| Active | `invite_status = 'accepted'` and `is_active` |
| Deactivated | `invite_status = 'accepted'` and not `is_active` |

The `expired` enum value stays unused — expiry is derived, so no job is needed to flip it.

### New: `list_staff_accounts()`

`SECURITY DEFINER`, `set search_path = public, pg_temp`, `stable`. Returns rows only when the caller
`has_capability('manage_staff')` (otherwise zero rows): `staff_user_id, name, role, email,
phone_e164, branch_id, branch_name, status` (the derived status above, as text), `invited_at`,
`is_self` (row is the caller). `branch_id`/`branch_name` come from `barbers.home_branch_id` for
barbers and from the single `staff_branch_assignments` row otherwise (null for owner/analyst).
Ordered by name. `revoke execute ... from public, anon; grant execute ... to authenticated,
service_role`.

### Changed: `find_eligible_barber`

Adds `staff_users.is_active` to both the eligibility check and the fallback pick (join `barbers` →
`staff_users`). No other change to its signature or logic. A deactivated barber therefore stops
being auto-assigned immediately, even though their future `barber_schedule` rows remain.
(`verify_barber_pin` already refuses inactive barbers.)

### New test helper: `test_set_staff_invite_token(p_staff_user_id uuid, p_token text, p_expires_at timestamptz)`

`SECURITY DEFINER`, service_role only (revoke from `public, anon, authenticated`) — same pattern as
`test_set_staff_pin_hash`. Sets `invite_token_hash = encode(sha256(p_token::bytea), 'hex')` and
`invite_expires_at = p_expires_at`, so tests can open a known invite link. Never granted to clients.

## Edge Functions

All three follow the existing `barber-pin-set` pattern: parse the caller's JWT into an
`asCaller` client to check capability through the database, then do privileged work with a
service-role `admin` client. CORS handled via `_shared/cors.ts`. Shared token/sending logic lives
in `supabase/functions/_shared/staff-invite.ts`:

- `generateInviteToken()` → 32 random bytes, base64url (256 bits).
- `hashInviteToken(token)` → hex SHA-256 (must equal the SQL helper's `encode(sha256(...),'hex')`).
- `inviteLink(token)` → `${STAFF_APP_URL}/invite/${token}`.
- `buildInviteSms(name, link)` / `buildInviteEmail(name, roleLabel, link)` → message text/HTML.
- `sendInvite({ phone | email, ... })` → Arkesel for phone, Resend for email. **Skips delivery for
  email addresses ending in `.local`** (reserved, never deliverable) and reports
  `delivered: false, reason: 'undeliverable_test_address'` — used by automated tests; documented in
  code. Returns `{ delivered: true }`, or `{ delivered: false, reason }` with reasons
  `email_not_configured` (no `RESEND_API_KEY`), `provider_error`, `undeliverable_test_address`.

### `staff-invite` (Owner only)

`POST { name, role, branch_id?, phone?, email? }`.

1. 401 without a JWT; 403 unless `has_capability('manage_staff')` as the caller.
2. Validate (400): non-empty name; role is a `staff_role`; exactly one of phone/email; phone
   normalized with `normalizeGhanaPhone` (null → 400); email lower-cased and basic-format checked;
   `branch_id` required and must exist for barber/branch_manager/receptionist, and must be absent
   (ignored) for owner/analyst.
3. 409 if the phone/email is already on a `staff_users` row (checked first, by query).
4. `admin.auth.admin.createUser({ email | phone, email_confirm | phone_confirm: true })` — no
   password. The admin API has no lookup by email/phone, so a login that already exists is detected
   here: `createUser`'s "already registered" error maps to 409 ("That phone number or email is
   already used by an account"). This includes a phone already registered as a **customer** login
   — a staff member who is also a customer must be invited with a different contact (staff and
   customer accounts are separate by design, App Flow 8.2).
5. Insert `staff_users` (pending, token hash, 7-day expiry, `invited_by_staff_id`), then the
   `barbers` row or `staff_branch_assignments` row per role. **If any insert fails, delete the
   `staff_users` row (cascades) and the auth user**, then return 500 — nothing half-created remains.
6. `sendInvite(...)`. Response 201 `{ staff_user_id, channel: 'sms' | 'email', delivered, reason? }`.
   A delivery failure does **not** roll back the account: it stays pending and the UI tells the
   Owner to use Resend.

### `staff-manage` (Owner only)

`POST { action, staff_user_id }`, action ∈ `resend | revoke | deactivate | reactivate`.
401/403 as above; 404 unknown staff user; 409 wrong state for the action.

| action | allowed when | effect |
|---|---|---|
| `resend` | `invite_status = 'pending'` (incl. expired) | new token + hash + 7-day expiry (old link dies); `sendInvite`; returns `{ delivered, reason? }` |
| `revoke` | `invite_status = 'pending'` | clear token/expiry, `invite_status = 'revoked'`, ban the login (`ban_duration: '876000h'`) |
| `deactivate` | `invite_status = 'accepted'` and `is_active`, and not the caller's own row | `is_active = false`, ban the login |
| `reactivate` | `invite_status = 'accepted'` and not `is_active` | `is_active = true`, unban (`ban_duration: 'none'`) |

Deactivating one's own account returns 409 ("You can't deactivate your own account"), which also
guarantees at least one active Owner remains (only an Owner can deactivate anyone). A banned login
can't sign in or refresh; an already-issued access token remains valid until it expires (Supabase
default 1 hour) — accepted limitation.

### `staff-invite-accept` (public, no JWT)

`POST { token, mode: 'preview' }` → 200 `{ valid: true, name, role, branch_name }`, or 200
`{ valid: false }` when the token hash matches no row, the row isn't `pending`, or it's expired —
one generic answer for all invalid cases.

`POST { token, mode: 'accept', password }`:
1. 400 if the password is shorter than 8 characters.
2. Re-check the token exactly as preview; invalid → 410 `{ valid: false }`.
3. `admin.auth.admin.updateUserById(auth_user_id, { password })`.
4. Update the row: `invite_status = 'accepted'`, `invite_accepted_at = now()`, clear
   `invite_token_hash` and `invite_expires_at` — with the update's `WHERE` also requiring
   `invite_status = 'pending'` and the same token hash, so two concurrent accepts can't both succeed.
5. 200 `{ login: { email } | { phone } }` — the page then signs in with that login and the chosen
   password.

### Secrets (function environment)

`STAFF_APP_URL` (e.g. the deployed staff app origin), `RESEND_API_KEY`, `INVITE_EMAIL_FROM` (a
verified Resend sender, e.g. `Pixel Barber <no-reply@yourdomain>`), and the existing
`ARKESEL_API_KEY` / `ARKESEL_SENDER_ID`. Deploying still needs `supabase/.secrets/send-sms.env`
sourced first (known `config.toml` hook-secret quirk).

## Screens (staff app)

All strings via `next-intl` in `apps/staff/messages/en.json`.

### Settings → Staff & Roles — `apps/staff/app/settings/staff/page.tsx` (new)

- Owner only: the page checks `has_capability('manage_staff')`; anyone else sees "You don't have
  access to this page."
- Table from `list_staff_accounts()`: name, role, branch, contact (email or phone), status.
- Row actions by status: Invite pending / Invite expired → **Resend**, **Revoke**; Active →
  **Deactivate** (with a confirm step; hidden on the Owner's own row); Deactivated →
  **Reactivate**; Revoked → none. Each calls `staff-manage` and then reloads the table; failures
  show the error on that row.
- **+ Invite staff** form: name, role, branch (hidden for owner/analyst; lists all branches — the
  Owner's scope is business-wide), Phone/Email choice, contact field. Results: "Invite sent by SMS
  to +233…" / "Invite sent by email to …", or "Invite created but not delivered — use Resend"
  (plus "Email sending isn't set up yet" when that's the reason), or the validation/conflict error.

### Accept invite — `apps/staff/app/invite/[token]/page.tsx` (new)

- No navigation, no login required. On load calls `staff-invite-accept` preview.
- Valid: "You've been invited to join Pixel Barber as a {role} at {branch}" (no branch clause for
  owner/analyst), password + confirm (min 8, must match), submit → accept → `signInWithPassword`
  with the returned login → route like normal login (barber → `/queue/today`, else `/tickets`).
- Invalid: "This invite is no longer valid — ask your Owner to send a new one."

### Staff login — `apps/staff/app/login/page.tsx` (changed)

One "Email or phone" field: input containing `@` → email sign-in; otherwise
`normalizeGhanaPhone` → phone sign-in (invalid → "Enter a valid email or Ghana phone number").
The placeholder still contains "Email", so existing e2e `getByPlaceholder('Email')` selectors keep
matching. Post-login routing unchanged.

## Error handling

- Every failure shows a visible, specific message; no optimistic UI.
- `staff-invite`: 400 validation, 403 not Owner, 409 contact in use, 500 creation failed (rolled
  back), 201 with `delivered: false` for delivery problems.
- `staff-manage`: 404 unknown, 409 wrong state / self-deactivation.
- Accept page: one "no longer valid" message for any invalid link; password errors inline.

## Testing

- **DB (`tests/db/`):** `list_staff_accounts` returns all staff with correct derived statuses for
  the Owner and zero rows for a Branch Manager and a customer; `invite_token_hash` and
  `invite_expires_at` are not readable by a signed-in staff session; `find_eligible_barber` skips a
  barber whose `staff_users.is_active` is false (neither eligible nor fallback);
  `test_set_staff_invite_token` is refused for client roles.
- **Edge Functions, against the deployed functions (`tests/db/`, like `pin-login.test.ts`):**
  - `staff-invite`: non-Owner → 403; invite a barber by `.local` email → pending row, `barbers` row
    with the home branch, no branch assignment, `delivered: false` /
    `undeliverable_test_address`; a receptionist → one branch assignment; an analyst → no branch;
    missing branch for a barber → 400; duplicate email → 409.
  - `staff-manage`: resend changes the token hash (old token's preview → invalid); revoke → status
    revoked and preview invalid; deactivate → `signInWithPassword` fails and
    `find_eligible_barber` skips the barber; reactivate → sign-in works again; Owner deactivating
    self → 409; resend on an active account → 409.
  - `staff-invite-accept`: preview valid (name/role/branch) and invalid (unknown, expired via the
    helper, revoked, used); accept with a short password → 400; accept → `signInWithPassword` with
    the new password succeeds; accepting the same token again → 410.
- **Unit (`vitest`, pure functions from `_shared/staff-invite.ts` where importable):** token
  length/alphabet, hash matches the SQL helper's format, SMS/email message builders.
- **e2e (Playwright):** the Owner invites a barber on the Staff & Roles screen (`.local` email); the
  test sets a known token with `test_set_staff_invite_token`; the invitee opens `/invite/<token>`,
  sets a password, lands on `/queue/today`; the Owner's table then shows the barber as Active.
