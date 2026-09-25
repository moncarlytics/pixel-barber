# Design: Queue SMS Notifications — "You're next"

**Date:** 2026-09-25
**Status:** Approved in brainstorming, awaiting written-spec review
**Origin:** The queue already records customer notifications (`notifications` rows for
`ticket_created`, `your_turn`, `ticket_released`), but nothing ever sends them. A customer waiting
away from the shop has no way to be told when to come back except watching the ticket screen. This
is the first real delivery slice (the implementation plan's Phase 7 "stub sender → real sender" work,
SMS only).

## Goal

Text a customer through Arkesel when they become **next in line**, reliably, once per ticket, without
ever texting real people from test data.

## Decisions

1. **Channel: SMS only** (Arkesel, already configured). Push is out of scope for this slice.
2. **One trigger: "You're next"** — the moment a ticket becomes second in line (the existing
   `almost_turn` state). The other recorded notifications (`ticket_created`, `your_turn`,
   `ticket_released`) keep being recorded exactly as today but are **not** texted.
3. **Approach A: a background sender every 30 seconds** (a `pg_cron` job calling a new
   `send-notifications` Edge Function), chosen over sending the instant a notification is recorded
   (which still needs a retry sweep) or sending from inside the queue logic (which would put network
   calls in the middle of queue updates).
4. **Live sending is off unless explicitly switched on** (`SMS_NOTIFICATIONS_LIVE=true`), because
   automated tests share this Supabase project and create customers with made-up Ghana numbers that
   may belong to real people.

## Section 1 — Creating the "you're next" notification

- `recalculate_positions` (latest definition: `20260923090000_final_review_fixes.sql`) already moves
  the position-2 ticket to `almost_turn`. At that moment it now also inserts a notification:
  `recipient_type = 'customer'`, `recipient_id = ticket.customer_id`, `channel = 'sms'`,
  `notification_type = 'youre_next'`, `related_ticket_id = ticket.id`, `payload = '{}'`.
- **Once per ticket:** a unique partial index on `notifications (related_ticket_id) where
  notification_type = 'youre_next'`, and the insert uses `on conflict do nothing`, so a ticket that
  drops back and becomes next again never produces a second text.
- `notifications` gains two server-only columns for the sender: `dispatch_claimed_at timestamptz`
  (null = unclaimed) and `dispatch_attempts smallint not null default 0`.
- Existing inserts for `ticket_created`, `your_turn` and `ticket_released` are unchanged; their rows
  stay `pending` (no channel handles them yet — a later push slice can).
- `recalculate_positions`' behaviour is otherwise unchanged (same promotion, positions, reentrancy
  guard, `your_turn` insert).

## Section 2 — The sender and its schedule

### Claiming work: `claim_sms_notifications(p_types text[], p_limit int)`

`SECURITY DEFINER`, `set search_path = public, pg_temp`, **service_role only** (revoke from `public,
anon, authenticated`). Atomically claims up to `p_limit` rows where `channel = 'sms'`,
`status = 'pending'`, `notification_type = any(p_types)`, and (`dispatch_claimed_at is null` or
`dispatch_claimed_at < now() - interval '5 minutes'`), ordered by `created_at`, using
`for update skip locked`; sets `dispatch_claimed_at = now()` and increments `dispatch_attempts`.
Returns, per claimed row: `notification_id, notification_type, created_at, dispatch_attempts,
customer_id, phone_e164, sms_backup_enabled, ticket_id, ticket_state, ticket_number, branch_name`.
Overlapping runs never claim the same row; a row stuck in a crashed run is reclaimable after
5 minutes.

### The function: `send-notifications`

- **Not callable from the apps:** it requires `Authorization: Bearer <service role key>` (compared to
  `SUPABASE_SERVICE_ROLE_KEY`); anything else → 401. Called only by the cron job and by tests.
- **Enabled types:** a constant `SMS_NOTIFICATION_TYPES = ['youre_next']` passed as `p_types` —
  enabling another notification type later is a one-line change.
- Each run claims up to **50** rows, then decides each one, in this order:
  1. ticket state is not `waiting`/`almost_turn` (already called, served, cancelled, or the ticket is
     gone) → `failed`, `failed_reason = 'stale'`;
  2. created more than **10 minutes** ago → `failed`, `'expired'` (switching live sending on can
     never blast a backlog);
  3. customer has `sms_backup_enabled = false` → `failed`, `'opted_out'`;
  4. no `phone_e164` → `failed`, `'no_phone'`;
  5. live sending off (`SMS_NOTIFICATIONS_LIVE` not `true`) → `failed`, `'sms_disabled'`;
  6. otherwise send through Arkesel.
- **Message:** `Pixel Barber: You're next at {branch}! Please head over now. Ticket {number}: {link}`
  where `{link} = {CUSTOMER_APP_URL}/tickets/{ticket_id}`.
- **Outcome:** delivered → `status = 'sent'`, `sent_at = now()`, clear the claim. Provider error →
  if `dispatch_attempts < 3`, clear the claim (stays `pending`, retried next run); otherwise
  `failed`, `'provider_error'`. Provider errors are logged.
- Response: a summary `{ claimed, sent, skipped: { reason: count }, retried }` (no phone numbers).
- Pure logic (the decision rules, message building, the Arkesel call with an injectable `fetch`)
  lives in a shared module so it's unit-testable; reuses the Arkesel success check already copied into
  `_shared/staff-invite-core.ts`.

### The schedule

A `pg_cron` job, `send-notifications`, every **30 seconds**, calls the function with `pg_net`
(`net.http_post`). The function URL and the service role key are read from **Supabase Vault**
(`vault.decrypted_secrets`, secrets named `project_url` and `notifications_dispatch_key`), never
written in a migration. The controller creates the two Vault secrets once at deploy time.

### Settings (function secrets)

`CUSTOMER_APP_URL` (the customer app's origin; `http://localhost:3000` until the app has a real
address), `SMS_NOTIFICATIONS_LIVE` (unset/`false` by default; `true` only when the Owner wants real
texts), and the existing `ARKESEL_API_KEY` / `ARKESEL_SENDER_ID`.

## Section 3 — Safety, errors, testing, out of scope

### Safety

- Live sending only with `SMS_NOTIFICATIONS_LIVE=true`; tests and everyday development leave it off,
  so every would-be text is recorded as `failed: sms_disabled`.
- The 10-minute age limit means turning live sending on never texts old notifications.
- Nothing in the queue waits on SMS: the queue only inserts a row; sending happens later, elsewhere.

### Errors

Every skipped or failed notification records a plain `failed_reason`: `stale`, `expired`,
`opted_out`, `no_phone`, `sms_disabled`, `provider_error` (after 3 attempts). Provider failures are
logged. A failure never blocks other rows in the same run.

### Testing

- **DB (`tests/db/`):** a ticket reaching position 2 records exactly one `youre_next` notification,
  and still exactly one after moving back and forth; `claim_sms_notifications` never returns the same
  row to two overlapping claims and is refused for client roles.
- **Unit (`tests/unit/`):** message text and link; the decision rules for every reason; the Arkesel
  call with a stubbed `fetch` (success, provider error, network error).
- **Function (deployed, live sending off):** notifications in each situation end with the right
  reason — `stale`, `expired`, `opted_out`, `no_phone`, and `sms_disabled` for the ones that would
  have been sent; the function returns 401 without the service role key.
- **Manual (once, by the user):** set `SMS_NOTIFICATIONS_LIVE=true`, join a queue with your own phone
  number, become second in line, receive the text; then decide whether live sending stays on.

### Out of scope

This is a first subset of PRD §20. Not included (follow-ups):

- Push notifications (the PRD's primary channel).
- The other triggers: "it's your turn", "ticket released", "joined" confirmation, and the rest of
  PRD §20's list (wait-change alerts, reassignment, service completed, feedback request).
- Time-based "10 / 5 minutes before your turn" alerts (need server-side wait estimates) — "you're
  next" is the position-based stand-in for now.
- Arkesel delivery receipts (`delivered` status).
- Staff notifications.
