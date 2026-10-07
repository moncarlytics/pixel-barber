# Design: Web Push Notifications (Customers)

**Date:** 2026-10-07
**Status:** Approved in brainstorming, awaiting written-spec review
**Origin:** Implementation plan Phase 7 (Real Integrations), the Web Push part. PRD 20 (notification
triggers; push first, SMS as fallback for time-critical messages), 34 (delivery failure and fallback).
Builds on the queue SMS pipeline (`Docs/superpowers/specs/2026-09-25-queue-sms-notifications-design.md`)
and appointment reminders (`Docs/superpowers/specs/2026-10-02-appointments-reminders-checkin-wait-design.md`).

## Goal

Customers who switch notifications on get the queue and appointment messages as push notifications
on every phone or computer they set up, even with the app closed; a text goes out only when push
can't reach them. Push needs no outside account or approval, so it works now, while the SMS sender ID
is pending.

## Current state

- Onboarding and Profile have a "Push notifications" switch that only calls
  `Notification.requestPermission()`; nothing is registered or saved.
- The customer app has no service worker and no web app manifest.
- The database already has `push_subscriptions (customer_id, endpoint unique, p256dh_key, auth_key,
  user_agent, created_at, last_seen_at)` with a customer-own RLS policy, and
  `customers.push_enabled` / `customers.sms_backup_enabled`.
- `send-notifications` (every 30 s) claims pending `channel = 'sms'` notifications of five types
  (`youre_next`, `your_turn`, `ticket_released`, `appointment_reminder_day`,
  `appointment_reminder_hour`), decides each (stale → expired → opted out → no phone → allowlist →
  live switch) and texts via Arkesel. Live SMS is off until the sender ID is approved.

## Decisions

1. **Push first, SMS only if push can't deliver.** If the customer has push on and at least one saved
   device, send push to all of them; any device accepting it counts as delivered and no text is sent.
   No device, push off, or every device failing → the existing SMS path and rules.
2. **Turning it on:** the existing switches work for real, plus a banner on the ticket and appointment
   screens when this device isn't set up (with an Add-to-Home-Screen hint on iPhone).
3. **Approach: extend `send-notifications`.** One pipeline keeps the staleness/expiry rules in one
   place. Push uses the standard Web Push protocol with VAPID keys — no third-party push service.

## Section 1 — Customer side

### Turning on and off

- **Switch (Onboarding notifications step, Profile):** on → request permission; if granted, register
  the service worker, subscribe (`pushManager.subscribe` with the VAPID public key,
  `userVisibleOnly: true`) and save the subscription; also set `customers.push_enabled = true`.
  Off → unsubscribe this device, remove its saved subscription, set `push_enabled = false`. Permission
  denied or subscribe failure → switch stays off and the existing "Push notifications are off — you'll
  still get SMS updates" line shows.
- **Banner (ticket page `/tickets/[id]` and appointment page `/appointments/[id]`):** shown when the
  browser supports push (`serviceWorker` + `PushManager` + `Notification`), permission is not
  `denied`, and this device has no active subscription. Text: "Get a notification when it's your
  turn." with a **Turn on** button doing the same as the switch.
  - iPhone/iPad not running from the Home Screen (`navigator.standalone !== true`, where Safari
    exposes no `PushManager`): the banner instead says "To get notifications on iPhone, tap Share,
    then Add to Home Screen."
  - Hidden on unsupported browsers (other than that iPhone case) and when permission is denied.
- **Several devices per customer** are supported; each saved subscription receives the push.
- **Log out** (Profile) removes this device's subscription before signing out, so a shared device
  stops receiving the previous customer's notifications.

### Saving subscriptions

- `save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text) returns void`
  (`authenticated`; caller must be a customer, else `not_a_customer`): upserts by `endpoint`; an
  endpoint previously saved for another customer moves to the caller (latest sign-in on a device
  wins); refreshes `last_seen_at`.
- `remove_push_subscription(p_endpoint text) returns void` (`authenticated`): deletes the caller's row
  for that endpoint (no error if absent).
- Both `security definer`, `set search_path = public, pg_temp`, revoked from `public, anon`.

### App files

- **Service worker** `apps/customer/public/sw.js`, registered at scope `/`:
  - `push` event: `showNotification(payload.title, { body, data: { url }, icon, badge, tag })` where
    `tag` is the notification id (a retried push doesn't stack duplicates).
  - `notificationclick`: close it, then focus an open app window and navigate it to `data.url`, or
    open a new window at `data.url`.
- **Web app manifest** (Next.js `app/manifest.ts`): name and short name "Pixel Barber", `start_url`
  "/", `display` "standalone", theme/background colours from the design system, icons 192×192 and
  512×512 PNG; plus an `apple-touch-icon` (180×180) in the root layout metadata. Icons are a simple
  generated mark (brand colour with "PB"), replaceable later.
- **VAPID public key**: a constant in the customer app (it is public by design).

### What the customer sees

- Title: **Pixel Barber**. Body: the SMS wording for that type, without the link:
  - `youre_next`: "You're next at {branch}! Please head over now. Ticket {number}."
  - `your_turn`: "It's your turn at {branch}! Please go to your barber now. Ticket {number}."
  - `ticket_released`: "Your ticket {number} at {branch} was released because you weren't available
    in time. Tap to rejoin."
  - `appointment_reminder_day`: "Reminder, your appointment at {branch} is tomorrow at {time}."
  - `appointment_reminder_hour`: "Your appointment at {branch} is today at {time}, in about an hour."
  - `{time}` is the 12-hour UTC (Ghana) format already used by the SMS reminders, e.g. `2:30 PM`.
- Tap target (`url`, a path on the customer app): ticket types → `/tickets/{ticket_id}`; reminder
  types → `/appointments/{appointment_id}`.

## Section 2 — Sending and recording

### Per claimed notification (`send-notifications`)

1. Existing checks first: **stale** → skip; **expired** (older than 10 minutes) → skip. Unchanged.
2. **Push attempt** when `customers.push_enabled` is true and the customer has at least one
   `push_subscriptions` row: send the payload to every subscription (TTL 600 s; `urgency: high` for
   `youre_next`/`your_turn`, `normal` otherwise).
   - Any subscription accepted (2xx) → record the row as `channel = 'push'`, `status = 'sent'`,
     `sent_at = now()`. No SMS.
   - A subscription answering 404 or 410 (gone) is deleted.
   - Other failures are logged; they don't delete the subscription.
3. **SMS fallback** when there was no push attempt, or every subscription failed: run the existing SMS
   decision and send (opted out / no phone / allowlist / live switch / Arkesel), unchanged. A text sent
   after a failed push attempt is recorded with `status = 'fallback_sent'`; a text sent with no push
   attempt keeps `status = 'sent'`. Skips record their reason as today. Retry behaviour after an
   Arkesel provider error is unchanged.
4. The "customer app URL must be configured" guard applies only to the SMS send (push uses paths).

### Data

- `claim_sms_notifications` additionally returns the customer's `push_enabled boolean` and
  `push_subscriptions jsonb` (an array of `{endpoint, p256dh, auth}`, empty when none), so the sender
  has everything from the one claim call. Rows are still created with `channel = 'sms'` by the database (unchanged triggers and
  functions); `channel` becomes `'push'` only when push delivered.
- Pure decision and wording rules live beside the SMS rules in `supabase/functions/_shared/` (no Deno
  APIs), unit-tested with Vitest.

### Keys

- One VAPID key pair for staging and production. Private key, public key and contact subject stored as
  Supabase secrets on both projects (`VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` = a
  `mailto:` contact); the public key is also committed as the app constant. Nothing to configure in
  Vercel.
- Library: `npm:web-push` in the Deno function, or a Deno-native Web Push library if it doesn't run on
  Supabase Edge (the plan verifies).

## Error handling

- Push library or network errors never fail the run; they count as a failed push attempt and fall
  through to SMS.
- The service worker shows a generic "Pixel Barber" notification if the payload is unreadable.
- Subscribe failures in the app leave the switch off with the existing explanatory line.

## Testing

- **Unit (Vitest):** push wording and tap URL per type; the push-or-SMS decision (push on + devices →
  push; none / off → SMS path; all failed → SMS recorded `fallback_sent`).
- **DB (staging):** `save_push_subscription` / `remove_push_subscription` (ownership, moving an
  endpoint between customers, not-a-customer refusal).
- **Sender (staging, deployed):** with stand-in push endpoints (one answering 201, one answering 410):
  push-accepted rows end `channel = 'push'`, `status = 'sent'`; the 410 subscription is deleted; a
  customer with no subscription takes the SMS path as today.
- **E2E (Playwright, Chromium with notification permission granted):** the Profile switch saves a
  subscription row; the ticket-page banner shows when the device isn't subscribed and hides after
  Turn on.
- **Manual:** a documented tap-through for the user to confirm a real notification on their phone
  (Android, and iPhone via Add to Home Screen) after promotion.

## Out of scope

Configurable "10 and 5 minutes before your turn" pushes (`push_lead_minutes_*`); location-based
"leave now" prompts (with Maps); staff notifications; delivery/read receipts beyond the push service
accepting the message; rich notifications (images, action buttons).

## Amendments (implementation)

- The VAPID secrets are `VAPID_KEYS_JSON` (a JWK key pair, as the `jsr:@negrel/webpush` library needs)
  and `VAPID_SUBJECT` = `https://pixel-barber-customer.vercel.app` (an https subject, valid under
  RFC 8292).
- The sender pushes only to https endpoints.
- At most the 10 most recently seen devices per customer get the push.
- Each push times out after 8 seconds and falls back to SMS.
- Customers can only read and delete their own subscription rows directly; saving goes through
  `save_push_subscription`.
