# Web Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Customers who switch notifications on get queue and appointment messages as web push notifications on every device they set up; SMS goes out only when push can't deliver.

**Architecture:** Two database functions save/remove a device's push subscription, and `claim_sms_notifications` hands the sender each customer's push flag and subscriptions. `send-notifications` tries push first (Deno-native `jsr:@negrel/webpush`, VAPID keys from Supabase secrets) and falls back to the unchanged SMS path. The customer app gets a service worker, a web app manifest with generated icons, a small push client module, working switches, and a "Turn on" banner.

**Tech Stack:** Supabase Postgres (plpgsql), Deno Edge Function, `jsr:@negrel/webpush@0.5.0`, Next.js 16 (client components, route handlers, `next/og` ImageResponse), next-intl, Vitest, Playwright.

**Spec:** `Docs/superpowers/specs/2026-10-07-web-push-notifications-design.md`

## Global Constraints

- Push first, SMS only if push can't deliver: push on + at least one saved device → push to all; any device accepting (2xx) → recorded `channel = 'push'`, `status = 'sent'`, no SMS. No device / push off / all failed → existing SMS decision unchanged; a text after a failed push attempt is `status = 'fallback_sent'`, otherwise `'sent'`.
- Subscriptions answering 404 or 410 are deleted; other push failures are logged only.
- Push TTL 600 seconds; urgency `high` for `youre_next` and `your_turn`, `normal` otherwise.
- Notification title `Pixel Barber`; bodies (exact):
  - `youre_next`: `You're next at {branch}! Please head over now. Ticket {number}.`
  - `your_turn`: `It's your turn at {branch}! Please go to your barber now. Ticket {number}.`
  - `ticket_released`: `Your ticket {number} at {branch} was released because you weren't available in time. Tap to rejoin.`
  - `appointment_reminder_day`: `Reminder, your appointment at {branch} is tomorrow at {time}.`
  - `appointment_reminder_hour`: `Your appointment at {branch} is today at {time}, in about an hour.`
  - `{time}` = existing `formatReminderTime` (12-hour UTC, e.g. `2:30 PM`).
- Tap URL: ticket types → `/tickets/{ticket_id}`; reminder types → `/appointments/{appointment_id}`. Notification `tag` = notification id.
- Banner copy (exact): `Get a notification when it's your turn.` / button `Turn on` / iPhone `To get notifications on iPhone, tap Share, then Add to Home Screen.` / failure line `Push notifications are off — you'll still get SMS updates.`
- VAPID public key (application server key, public by design): `BLBpLpZTjxKRXlHl9nW5ALiiAYCRBd57cMlkombDxmf-4lzUn_2jAJSSIesWhZGmeZsv7jB5lt2i2iLxSl_YVGY`. The private JWK pair lives in git-ignored `supabase/.secrets/vapid.json` and as the Supabase secret `VAPID_KEYS_JSON`; `VAPID_SUBJECT` = `https://pixel-barber-customer.vercel.app`. Never print or commit the private key.
- Brand colours: primary green `#146F3B`, accent gold `#F5A623`, white `#FFFFFF`.
- Every new SQL function: `security definer`, `set search_path = public, pg_temp`, explicit revoke/grant. Already-applied migrations are never edited. `packages/shared/src/database.types.ts` is hand-maintained and must match the SQL.
- Live SMS stays off on staging (`SMS_NOTIFICATIONS_LIVE` unset; allowlist set) — SMS-path rows end `not_allowlisted`/`sms_disabled`, never `sent`.
- **Implementer subagents cannot push migrations, deploy functions, set secrets or run SQL against a live project.** The controller pushes migrations (`set -a && source supabase/.secrets/send-sms.env && set +a && npx supabase db push`), sets secrets and deploys. Report "ready for push" / "ready for deploy".
- React lint (errors): no synchronous `setState` in effect bodies (`react-hooks/set-state-in-effect`; use `queueMicrotask` or async callbacks); no `Date.now()`/`new Date()` in render or `useMemo`; tag async results / guard with a `cancelled` flag.
- E2E: `.press('Enter')`, locators scoped to `page.locator('main')`; each spec uses its own phone range; FK-safe cleanup that throws on failure.
- After editing any file containing `—` or `–`, `grep -n $'\xef\xbf\xbd' <file>` must print nothing.
- Do not stage `apps/*/next-env.d.ts`, `graphify-out/`, `playwright-report/`, `test-results/`, `supabase/.secrets/`, untracked `Docs/superpowers/plans/2026-09-1*`. No AI-attribution lines in commits. Commit on main.
- Environment notes: repo-level ESLint can't run; lint per file inside the app (`cd apps/customer && npx eslint "<file>"`). Pure unit tests may need `--environment=node` (jsdom workers can time out here).

## Rulings made while planning

1. **Push rules live in a new `supabase/functions/_shared/notification-push-core.ts`** (pure, Vitest-tested) that imports types/helpers from `notification-sms-core.ts`; the Deno-only sending wrapper is `supabase/functions/_shared/web-push.ts`.
2. **`precheckNotification` (stale/expired) is split out of `decideNotification`** so push can run between the precheck and the SMS-only checks; `decideNotification` keeps its behaviour by calling it first.
3. **Missing VAPID secrets = no push attempt** (straight to SMS, `status = 'sent'`), not a failed attempt.
4. **`save_push_subscription` also sets `customers.push_enabled = true`** so the banner's Turn on works without a Profile save; it rejects non-`https://` endpoints (`invalid_subscription`) so a customer can't make the sender POST to arbitrary URLs.
5. **Icons are generated at request time** by a Next.js route handler (`/icons/{size}`, `next/og` ImageResponse) — no binary files committed.
6. **The sender integration test uses public stand-in endpoints** `https://httpbin.org/status/201` and `https://httpbin.org/status/410` with real P-256 subscriber keys generated in the test (the library encrypts to them). This is an external dependency; if httpbin is down the test fails loudly.
7. **The e2e fakes the browser push service** with an init script overriding `PushManager.prototype.subscribe/getSubscription` (state kept in `localStorage`), because headless Chromium can't reach a real push service. It verifies the app's own logic (saving, removing, banner) — real delivery is the documented manual check.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20261007090000_web_push.sql` | `save_push_subscription`, `remove_push_subscription`, `claim_sms_notifications` + `push_enabled`/`push_subscriptions` |
| `tests/db/push-subscriptions.test.ts` | Task 1 |
| `supabase/functions/_shared/notification-sms-core.ts` | + `PushTarget`, claimed push fields, `precheckNotification` |
| `supabase/functions/_shared/notification-push-core.ts` | push payload, urgency, TTL, `shouldAttemptPush` |
| `supabase/functions/_shared/web-push.ts` | Deno wrapper around `jsr:@negrel/webpush` → `'ok' | 'gone' | 'failed'` |
| `supabase/functions/send-notifications/index.ts` | push-first flow |
| `tests/unit/notification-push-core.test.ts`, `tests/unit/notification-sms-core.test.ts` | Task 2 unit tests |
| `tests/db/push-sending.test.ts` | Task 2 sender test (deployed function) |
| `apps/customer/app/push/vapidPublicKey.ts` | public key constant |
| `apps/customer/app/push/pushClient.ts` (+ `pushClient.test.ts`) | support detection, enable/disable, current subscription |
| `apps/customer/public/sw.js` | service worker (push + click) |
| `apps/customer/app/manifest.ts`, `apps/customer/app/icons/[size]/route.tsx`, `apps/customer/app/layout.tsx` | installable app + icons |
| `apps/customer/app/profile/page.tsx`, `apps/customer/app/onboard/OnboardWizard.tsx` | switches + logout |
| `apps/customer/app/push/PushBanner.tsx` | Turn on banner |
| `apps/customer/app/tickets/[id]/page.tsx`, `apps/customer/app/appointments/[id]/page.tsx` | render the banner |
| `apps/customer/messages/en.json` | `Push` namespace |
| `e2e/push-notifications.spec.ts` | banner + switch + logout journey |
| `Docs/ops/production-setup.md` | VAPID secrets + manual phone check |

---

### Task 1: Saving subscriptions and claiming push details

**Files:**
- Create: `supabase/migrations/20261007090000_web_push.sql`
- Create: `tests/db/push-subscriptions.test.ts`
- Modify: `packages/shared/src/database.types.ts`

**Interfaces:**
- Produces (SQL): `save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text) returns void` (authenticated; errors `not_a_customer`, `invalid_subscription`); `remove_push_subscription(p_endpoint text) returns void` (authenticated); `claim_sms_notifications(text[], int)` returns its current columns plus `push_enabled boolean` and `push_subscriptions jsonb` (array of `{endpoint, p256dh, auth}`, `[]` when none).

- [ ] **Step 1: Write the failing tests**

Create `tests/db/push-subscriptions.test.ts`:
```typescript
// tests/db/push-subscriptions.test.ts
// @vitest-environment node
// save_push_subscription / remove_push_subscription (web push spec, Section 1): a customer saves
// this device's subscription (and push turns on), the same endpoint moves to whoever signs in on
// the device last, removal only touches the caller's own row, staff and bad endpoints are refused.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  createAppointmentFixture,
  type AppointmentFixture,
} from './fixtures/appointments';

let f: AppointmentFixture;
const endpoint = () => `https://push.example.test/db-test/${f.suffix}`;

async function rowFor(e: string) {
  const { data, error } = await f.admin
    .from('push_subscriptions')
    .select('customer_id, p256dh_key, auth_key, user_agent')
    .eq('endpoint', e)
    .maybeSingle();
  if (error) throw error;
  return data;
}

beforeAll(async () => {
  f = await createAppointmentFixture();
}, 90000);

afterAll(async () => {
  await f.admin.from('push_subscriptions').delete().like('endpoint', `%/db-test/${f.suffix}%`);
  await cleanupAppointmentFixture(f);
}, 90000);

describe('save_push_subscription', () => {
  it('saves this device for the customer and turns push on', async () => {
    await f.admin
      .from('customers')
      .update({ push_enabled: false })
      .eq('id', f.customers[0].customerId);
    const { error } = await f.customers[0].client.rpc('save_push_subscription', {
      p_endpoint: endpoint(),
      p_p256dh: 'p256-a',
      p_auth: 'auth-a',
      p_user_agent: 'test-agent',
    });
    expect(error).toBeNull();
    expect(await rowFor(endpoint())).toEqual({
      customer_id: f.customers[0].customerId,
      p256dh_key: 'p256-a',
      auth_key: 'auth-a',
      user_agent: 'test-agent',
    });
    const { data } = await f.admin
      .from('customers')
      .select('push_enabled')
      .eq('id', f.customers[0].customerId)
      .single();
    expect(data!.push_enabled).toBe(true);
  });

  it('moves the endpoint to whoever saves it last, with the new keys', async () => {
    const { error } = await f.customers[1].client.rpc('save_push_subscription', {
      p_endpoint: endpoint(),
      p_p256dh: 'p256-b',
      p_auth: 'auth-b',
      p_user_agent: 'test-agent-2',
    });
    expect(error).toBeNull();
    expect(await rowFor(endpoint())).toMatchObject({
      customer_id: f.customers[1].customerId,
      p256dh_key: 'p256-b',
      auth_key: 'auth-b',
    });
  });

  it('refuses staff and endpoints that are not https', async () => {
    const staff = await f.barberClient.rpc('save_push_subscription', {
      p_endpoint: `${endpoint()}/staff`,
      p_p256dh: 'p',
      p_auth: 'a',
      p_user_agent: 'x',
    });
    expect(staff.error?.message).toBe('not_a_customer');
    const insecure = await f.customers[0].client.rpc('save_push_subscription', {
      p_endpoint: 'http://push.example.test/insecure',
      p_p256dh: 'p',
      p_auth: 'a',
      p_user_agent: 'x',
    });
    expect(insecure.error?.message).toBe('invalid_subscription');
    const empty = await f.customers[0].client.rpc('save_push_subscription', {
      p_endpoint: `${endpoint()}/empty`,
      p_p256dh: '',
      p_auth: 'a',
      p_user_agent: 'x',
    });
    expect(empty.error?.message).toBe('invalid_subscription');
  });
});

describe('remove_push_subscription', () => {
  it("only removes the caller's own row, without error when it isn't theirs", async () => {
    const notMine = await f.customers[0].client.rpc('remove_push_subscription', {
      p_endpoint: endpoint(),
    });
    expect(notMine.error).toBeNull();
    expect(await rowFor(endpoint())).not.toBeNull();
    const mine = await f.customers[1].client.rpc('remove_push_subscription', {
      p_endpoint: endpoint(),
    });
    expect(mine.error).toBeNull();
    expect(await rowFor(endpoint())).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/db/push-subscriptions.test.ts`
Expected: FAIL (`save_push_subscription` not found).

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261007090000_web_push.sql`:
```sql
-- Web push notifications (Docs/superpowers/specs/2026-10-07-web-push-notifications-design.md):
-- customers save/remove each device's push subscription, and claim_sms_notifications hands the
-- sender each customer's push flag and subscriptions so it can try push before SMS.

-- Saves this device's subscription for the calling customer. An endpoint already saved for someone
-- else moves to the caller (the latest sign-in on a device wins). Saving also turns push on.
-- Only https endpoints are accepted, so the sender never posts to arbitrary URLs.
create or replace function save_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_user_agent text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer_id uuid;
begin
  select id into v_customer_id from customers where auth_user_id = auth.uid();
  if v_customer_id is null then
    raise exception 'not_a_customer';
  end if;
  if coalesce(p_endpoint, '') not like 'https://%'
     or coalesce(p_p256dh, '') = ''
     or coalesce(p_auth, '') = '' then
    raise exception 'invalid_subscription';
  end if;

  insert into push_subscriptions (customer_id, endpoint, p256dh_key, auth_key, user_agent, last_seen_at)
  values (v_customer_id, p_endpoint, p_p256dh, p_auth, p_user_agent, now())
  on conflict (endpoint) do update
    set customer_id = excluded.customer_id,
        p256dh_key = excluded.p256dh_key,
        auth_key = excluded.auth_key,
        user_agent = excluded.user_agent,
        last_seen_at = now();

  update customers set push_enabled = true where id = v_customer_id and not push_enabled;
end;
$$;

revoke execute on function save_push_subscription(text, text, text, text) from public, anon;
grant execute on function save_push_subscription(text, text, text, text) to authenticated;

-- Removes the calling customer's subscription for this endpoint (no error when absent or not theirs).
create or replace function remove_push_subscription(p_endpoint text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from push_subscriptions
  where endpoint = p_endpoint
    and customer_id = (select id from customers where auth_user_id = auth.uid());
end;
$$;

revoke execute on function remove_push_subscription(text) from public, anon;
grant execute on function remove_push_subscription(text) to authenticated;

-- claim_sms_notifications: identical to 20261002090200_claim_reminder_notifications.sql's definition
-- except it also returns the customer's push flag and subscriptions. Its return columns change, so
-- it is dropped and recreated.
drop function claim_sms_notifications(text[], int);

create function claim_sms_notifications(p_types text[], p_limit int)
returns table (
  notification_id uuid,
  notification_type text,
  created_at timestamptz,
  dispatch_attempts smallint,
  customer_id uuid,
  phone_e164 text,
  sms_backup_enabled boolean,
  ticket_id uuid,
  ticket_state ticket_state,
  ticket_number text,
  branch_name text,
  appointment_id uuid,
  appointment_status appointment_status,
  appointment_slot timestamptz,
  payload_slot text,
  push_enabled boolean,
  push_subscriptions jsonb
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with claimed as (
    update notifications n
    set dispatch_claimed_at = now(),
        dispatch_attempts = n.dispatch_attempts + 1
    where n.id in (
      select id from notifications
      where channel = 'sms'
        and status = 'pending'
        and notification_type = any(p_types)
        and (dispatch_claimed_at is null or dispatch_claimed_at < now() - interval '10 minutes')
      order by created_at
      limit p_limit
      for update skip locked
    )
    returning n.id, n.notification_type, n.created_at, n.dispatch_attempts, n.recipient_id,
              n.related_ticket_id, n.related_appointment_id, n.payload
  )
  select c.id, c.notification_type, c.created_at, c.dispatch_attempts, c.recipient_id,
         cu.phone_e164, cu.sms_backup_enabled, t.id, t.state, t.ticket_number,
         coalesce(b.name, ab.name),
         a.id, a.status, a.scheduled_start, c.payload->>'slot',
         cu.push_enabled,
         coalesce(
           (select jsonb_agg(
                     jsonb_build_object('endpoint', ps.endpoint, 'p256dh', ps.p256dh_key, 'auth', ps.auth_key)
                     order by ps.created_at)
            from push_subscriptions ps
            where ps.customer_id = c.recipient_id),
           '[]'::jsonb)
  from claimed c
  left join customers cu on cu.id = c.recipient_id
  left join queue_tickets t on t.id = c.related_ticket_id
  left join branches b on b.id = t.branch_id
  left join appointments a on a.id = c.related_appointment_id
  left join branches ab on ab.id = a.branch_id;
$$;

revoke execute on function claim_sms_notifications(text[], int) from public, anon, authenticated;
grant execute on function claim_sms_notifications(text[], int) to service_role;
```

- [ ] **Step 4: Update the database types**

In `packages/shared/src/database.types.ts` `Functions`:
- add to `claim_sms_notifications.Returns` (after `payload_slot`):
```typescript
          push_enabled: boolean | null;
          push_subscriptions: Json;
```
- add (alphabetical):
```typescript
      remove_push_subscription: { Args: { p_endpoint: string }; Returns: undefined };
      save_push_subscription: {
        Args: { p_endpoint: string; p_p256dh: string; p_auth: string; p_user_agent: string };
        Returns: undefined;
      };
```
Confirm `push_subscriptions` already has a `Tables` entry (it should, from Phase 1); if missing, add `Row`/`Insert`/`Update` matching the table in `supabase/migrations/20260911210900_notifications_and_push.sql`.
Run: `npm run typecheck` — Expected: no errors.

- [ ] **Step 5: Commit and hand over for the push**

```bash
git add supabase/migrations/20261007090000_web_push.sql tests/db/push-subscriptions.test.ts packages/shared/src/database.types.ts
git commit -m "feat: save push subscriptions and claim push details for the sender"
```
Report "ready for push". After the push: `npx vitest run tests/db/push-subscriptions.test.ts tests/db/send-notifications.test.ts tests/db/appointment-reminder-sending.test.ts` — Expected: PASS.

---

### Task 2: Push first in send-notifications

**Files:**
- Modify: `supabase/functions/_shared/notification-sms-core.ts`
- Create: `supabase/functions/_shared/notification-push-core.ts`
- Create: `supabase/functions/_shared/web-push.ts`
- Modify: `supabase/functions/send-notifications/index.ts`
- Modify: `tests/unit/notification-sms-core.test.ts`
- Create: `tests/unit/notification-push-core.test.ts`
- Create: `tests/db/push-sending.test.ts`

**Interfaces:**
- Consumes: claim columns `push_enabled`, `push_subscriptions` (Task 1).
- Produces (TS): in `notification-sms-core.ts` — `export interface PushTarget { endpoint: string; p256dh: string; auth: string }`, `ClaimedNotification.push_enabled?: boolean | null`, `ClaimedNotification.push_subscriptions?: PushTarget[] | null`, `precheckNotification(n, now): { action: 'skip'; reason: 'stale' | 'expired' } | { action: 'continue' }`. In `notification-push-core.ts` — `PUSH_TTL_SECONDS = 600`, `interface PushPayload { title: string; body: string; url: string; tag: string }`, `shouldAttemptPush(n): boolean`, `pushUrgency(type): 'high' | 'normal'`, `buildPushPayload(type, n): PushPayload`. In `web-push.ts` — `loadPushConfig(): PushConfig | null`, `sendWebPush(config, target, payload, { ttl, urgency }): Promise<'ok' | 'gone' | 'failed'>`.

- [ ] **Step 1: Write the failing unit tests**

Create `tests/unit/notification-push-core.test.ts`:
```typescript
// tests/unit/notification-push-core.test.ts
// @vitest-environment node
// Pure push rules for send-notifications (web push spec, Section 2): when to try push, the wording
// and tap target per type, urgency.
import { describe, expect, it } from 'vitest';
import {
  PUSH_TTL_SECONDS,
  buildPushPayload,
  pushUrgency,
  shouldAttemptPush,
} from '../../supabase/functions/_shared/notification-push-core';
import type { ClaimedNotification } from '../../supabase/functions/_shared/notification-sms-core';

function row(overrides: Partial<ClaimedNotification> = {}): ClaimedNotification {
  return {
    notification_id: 'n1',
    notification_type: 'youre_next',
    created_at: '2026-10-07T12:00:00Z',
    dispatch_attempts: 1,
    customer_id: 'c1',
    phone_e164: '+233244123456',
    sms_backup_enabled: true,
    ticket_id: 't1',
    ticket_state: 'almost_turn',
    ticket_number: 'A12',
    branch_name: 'Osu Branch',
    push_enabled: true,
    push_subscriptions: [{ endpoint: 'https://push.example/1', p256dh: 'p', auth: 'a' }],
    ...overrides,
  };
}

describe('shouldAttemptPush', () => {
  it('tries push when it is on and a device is saved', () => {
    expect(shouldAttemptPush(row())).toBe(true);
  });
  it.each([
    ['push switched off', row({ push_enabled: false })],
    ['no devices', row({ push_subscriptions: [] })],
    ['devices unknown', row({ push_subscriptions: null })],
    ['flag unknown', row({ push_enabled: null })],
  ])('does not try push when %s', (_label, n) => {
    expect(shouldAttemptPush(n)).toBe(false);
  });
});

describe('buildPushPayload', () => {
  it.each([
    ['youre_next', "You're next at Osu Branch! Please head over now. Ticket A12.", '/tickets/t1'],
    [
      'your_turn',
      "It's your turn at Osu Branch! Please go to your barber now. Ticket A12.",
      '/tickets/t1',
    ],
    [
      'ticket_released',
      "Your ticket A12 at Osu Branch was released because you weren't available in time. Tap to rejoin.",
      '/tickets/t1',
    ],
  ] as const)('%s', (type, body, url) => {
    expect(buildPushPayload(type, row({ notification_type: type }))).toEqual({
      title: 'Pixel Barber',
      body,
      url,
      tag: 'n1',
    });
  });

  it.each([
    ['appointment_reminder_day', 'Reminder, your appointment at Osu Branch is tomorrow at 2:30 PM.'],
    [
      'appointment_reminder_hour',
      'Your appointment at Osu Branch is today at 2:30 PM, in about an hour.',
    ],
  ] as const)('%s', (type, body) => {
    const n = row({
      notification_type: type,
      ticket_id: null,
      ticket_state: null,
      ticket_number: null,
      appointment_id: 'a1',
      appointment_status: 'scheduled',
      appointment_slot: '2026-10-08T14:30:00+00:00',
      payload_slot: '2026-10-08T14:30:00+00:00',
    });
    expect(buildPushPayload(type, n)).toEqual({
      title: 'Pixel Barber',
      body,
      url: '/appointments/a1',
      tag: 'n1',
    });
  });

  it('falls back to a generic branch name', () => {
    expect(buildPushPayload('youre_next', row({ branch_name: null })).body).toBe(
      "You're next at Pixel Barber! Please head over now. Ticket A12.",
    );
  });
});

describe('pushUrgency and TTL', () => {
  it('is high for the time-critical messages, normal otherwise', () => {
    expect(pushUrgency('youre_next')).toBe('high');
    expect(pushUrgency('your_turn')).toBe('high');
    expect(pushUrgency('ticket_released')).toBe('normal');
    expect(pushUrgency('appointment_reminder_day')).toBe('normal');
    expect(pushUrgency('appointment_reminder_hour')).toBe('normal');
  });
  it('expires after 10 minutes', () => {
    expect(PUSH_TTL_SECONDS).toBe(600);
  });
});
```

In `tests/unit/notification-sms-core.test.ts`, add `precheckNotification` to the import list and append:
```typescript
describe('precheckNotification', () => {
  it('continues for a fresh, current notification', () => {
    expect(precheckNotification(row(), NOW)).toEqual({ action: 'continue' });
  });
  it('skips stale before expired', () => {
    expect(
      precheckNotification(row({ ticket_state: 'called', created_at: '2026-09-25T11:00:00Z' }), NOW),
    ).toEqual({ action: 'skip', reason: 'stale' });
  });
  it('skips expired', () => {
    expect(precheckNotification(row({ created_at: '2026-09-25T11:49:59Z' }), NOW)).toEqual({
      action: 'skip',
      reason: 'expired',
    });
  });
  it('does not look at SMS settings', () => {
    expect(
      precheckNotification(row({ sms_backup_enabled: false, phone_e164: null }), NOW),
    ).toEqual({ action: 'continue' });
  });
});
```

- [ ] **Step 2: Run the unit tests to verify they fail**

Run: `npx vitest run tests/unit/notification-push-core.test.ts tests/unit/notification-sms-core.test.ts --environment=node`
Expected: FAIL (module `notification-push-core` not found; `precheckNotification` not exported).

- [ ] **Step 3: Add the shared types and precheck to `notification-sms-core.ts`**

Above `/** One row returned by claim_sms_notifications. */` add:
```typescript
/** One saved device to push to (from claim_sms_notifications' push_subscriptions). */
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}
```
Add to `ClaimedNotification` (after `payload_slot`):
```typescript
  /** The customer's push switch and saved devices (empty array when none). */
  push_enabled?: boolean | null;
  push_subscriptions?: PushTarget[] | null;
```
Above `decideNotification` add:
```typescript
/** The checks that apply whatever the channel: a stale or expired notification is never sent. */
export function precheckNotification(
  n: ClaimedNotification,
  now: Date,
): { action: 'skip'; reason: 'stale' | 'expired' } | { action: 'continue' } {
  if (isStale(n)) return { action: 'skip', reason: 'stale' };
  const ageMs = now.getTime() - new Date(n.created_at).getTime();
  if (ageMs > MAX_NOTIFICATION_AGE_MINUTES * 60 * 1000) return { action: 'skip', reason: 'expired' };
  return { action: 'continue' };
}
```
In `decideNotification`, replace
```typescript
  if (isStale(n)) return { action: 'skip', reason: 'stale' };
  const ageMs = now.getTime() - new Date(n.created_at).getTime();
  if (ageMs > MAX_NOTIFICATION_AGE_MINUTES * 60 * 1000)
    return { action: 'skip', reason: 'expired' };
```
with
```typescript
  const pre = precheckNotification(n, now);
  if (pre.action === 'skip') return pre;
```

- [ ] **Step 4: Create the push rules**

Create `supabase/functions/_shared/notification-push-core.ts`:
```typescript
// supabase/functions/_shared/notification-push-core.ts
// Pure push rules for the send-notifications sender
// (Docs/superpowers/specs/2026-10-07-web-push-notifications-design.md). No Deno APIs, so Vitest
// can import it.
import {
  formatReminderTime,
  type ClaimedNotification,
  type SmsNotificationType,
} from './notification-sms-core.ts';

/** A push the customer hasn't received within 10 minutes is no longer useful. */
export const PUSH_TTL_SECONDS = 600;

/** What the service worker shows: title, body, the app path a tap opens, and a de-dupe tag. */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

/** Push is tried only when the customer has it switched on and at least one saved device. */
export function shouldAttemptPush(n: ClaimedNotification): boolean {
  return (
    n.push_enabled === true && Array.isArray(n.push_subscriptions) && n.push_subscriptions.length > 0
  );
}

export function pushUrgency(type: SmsNotificationType): 'high' | 'normal' {
  return type === 'youre_next' || type === 'your_turn' ? 'high' : 'normal';
}

export function buildPushPayload(type: SmsNotificationType, n: ClaimedNotification): PushPayload {
  const branch = n.branch_name ?? 'Pixel Barber';
  const ticket = n.ticket_number ?? '';
  const ticketUrl = `/tickets/${n.ticket_id}`;
  const appointmentUrl = `/appointments/${n.appointment_id}`;
  const base = { title: 'Pixel Barber', tag: n.notification_id };
  switch (type) {
    case 'youre_next':
      return {
        ...base,
        url: ticketUrl,
        body: `You're next at ${branch}! Please head over now. Ticket ${ticket}.`,
      };
    case 'your_turn':
      return {
        ...base,
        url: ticketUrl,
        body: `It's your turn at ${branch}! Please go to your barber now. Ticket ${ticket}.`,
      };
    case 'ticket_released':
      return {
        ...base,
        url: ticketUrl,
        body: `Your ticket ${ticket} at ${branch} was released because you weren't available in time. Tap to rejoin.`,
      };
    case 'appointment_reminder_day':
      return {
        ...base,
        url: appointmentUrl,
        body: `Reminder, your appointment at ${branch} is tomorrow at ${formatReminderTime(n.appointment_slot ?? '')}.`,
      };
    case 'appointment_reminder_hour':
      return {
        ...base,
        url: appointmentUrl,
        body: `Your appointment at ${branch} is today at ${formatReminderTime(n.appointment_slot ?? '')}, in about an hour.`,
      };
  }
}
```

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `npx vitest run tests/unit/notification-push-core.test.ts tests/unit/notification-sms-core.test.ts --environment=node`
Expected: PASS.

- [ ] **Step 6: Create the Deno push wrapper**

Create `supabase/functions/_shared/web-push.ts`:
```typescript
// supabase/functions/_shared/web-push.ts
// Sends one Web Push message (RFC 8291/8292) with VAPID, via the Deno-native jsr:@negrel/webpush.
// Deno-only (jsr import), so it is exercised by the deployed-function test, not Vitest.
import * as webpush from 'jsr:@negrel/webpush@0.5.0';
import type { PushTarget } from './notification-sms-core.ts';
import type { PushPayload } from './notification-push-core.ts';

export interface PushConfig {
  /** JSON of { publicKey: JsonWebKey, privateKey: JsonWebKey } (secret VAPID_KEYS_JSON). */
  keysJson: string;
  /** VAPID contact: an https URL or mailto: (secret VAPID_SUBJECT). */
  subject: string;
}

export type PushResult = 'ok' | 'gone' | 'failed';

/** Reads the VAPID secrets; null when either is missing (push is then not attempted). */
export function loadPushConfig(): PushConfig | null {
  const keysJson = Deno.env.get('VAPID_KEYS_JSON');
  const subject = Deno.env.get('VAPID_SUBJECT');
  return keysJson && subject ? { keysJson, subject } : null;
}

let serverPromise: Promise<webpush.ApplicationServer> | null = null;

function applicationServer(config: PushConfig): Promise<webpush.ApplicationServer> {
  if (!serverPromise) {
    serverPromise = (async () => {
      const vapidKeys = await webpush.importVapidKeys(JSON.parse(config.keysJson), {
        extractable: false,
      });
      return webpush.ApplicationServer.new({ contactInformation: config.subject, vapidKeys });
    })();
    // A failed import must not be cached forever.
    serverPromise.catch(() => {
      serverPromise = null;
    });
  }
  return serverPromise;
}

/** 'gone' = the push service says this subscription no longer exists (404/410): delete it. */
export async function sendWebPush(
  config: PushConfig,
  target: PushTarget,
  payload: PushPayload,
  options: { ttl: number; urgency: 'high' | 'normal' },
): Promise<PushResult> {
  try {
    const server = await applicationServer(config);
    const subscriber = server.subscribe({
      endpoint: target.endpoint,
      keys: { p256dh: target.p256dh, auth: target.auth },
    });
    await subscriber.pushTextMessage(JSON.stringify(payload), {
      ttl: options.ttl,
      urgency: options.urgency === 'high' ? webpush.Urgency.High : webpush.Urgency.Normal,
    });
    return 'ok';
  } catch (error) {
    if (error instanceof webpush.PushMessageError) {
      const status = error.response.status;
      if (status === 404 || status === 410) return 'gone';
      console.error('send-notifications: push rejected', { status, endpoint: target.endpoint });
    } else {
      console.error('send-notifications: push error', { error: String(error) });
    }
    return 'failed';
  }
}
```

- [ ] **Step 7: Put push first in the sender**

In `supabase/functions/send-notifications/index.ts`:
- Change the header comment's first line to: `Queue and appointment-reminder sender: web push first, SMS as fallback (Docs/superpowers/specs/2026-09-25-queue-sms-notifications-design.md; reminders: Docs/superpowers/specs/2026-10-02-appointments-reminders-checkin-wait-design.md; push: Docs/superpowers/specs/2026-10-07-web-push-notifications-design.md).`
- Add imports:
```typescript
import {
  PUSH_TTL_SECONDS,
  buildPushPayload,
  pushUrgency,
  shouldAttemptPush,
} from '../_shared/notification-push-core.ts';
import { loadPushConfig, sendWebPush } from '../_shared/web-push.ts';
```
  and add `precheckNotification` to the existing `notification-sms-core.ts` import list.
- After `const arkesel = { ... };` add `const pushConfig = loadPushConfig();`
- In `summary`, add `pushed: 0,` after `claimed: rows.length,`.
- Replace the loop body from `const decision = decideNotification(n, new Date(), live, allowlist);` up to (not including) `if (result === 'sent') {` with:
```typescript
    const now = new Date();
    const pre = precheckNotification(n, now);
    if (pre.action === 'skip') {
      await fail(n.notification_id, pre.reason);
      summary.skipped[pre.reason] = (summary.skipped[pre.reason] ?? 0) + 1;
      continue;
    }
    // precheckNotification already rejected types outside SMS_NOTIFICATION_TYPES as stale.
    const type = n.notification_type as SmsNotificationType;

    // Push first: every saved device; any device accepting it means delivered (no SMS).
    let pushAttempted = false;
    if (pushConfig && shouldAttemptPush(n)) {
      pushAttempted = true;
      const payload = buildPushPayload(type, n);
      const targets = n.push_subscriptions ?? [];
      const results = await Promise.all(
        targets.map((target) =>
          sendWebPush(pushConfig, target, payload, {
            ttl: PUSH_TTL_SECONDS,
            urgency: pushUrgency(type),
          }),
        ),
      );
      const gone = targets.filter((_, i) => results[i] === 'gone').map((t) => t.endpoint);
      if (gone.length > 0) {
        const { error: goneError } = await admin
          .from('push_subscriptions')
          .delete()
          .in('endpoint', gone);
        if (goneError)
          console.error('send-notifications: could not delete gone subscriptions', goneError);
      }
      if (results.includes('ok')) {
        const { error: pushedError } = await admin
          .from('notifications')
          .update({
            channel: 'push',
            status: 'sent',
            sent_at: new Date().toISOString(),
            failed_reason: null,
            dispatch_claimed_at: null,
          })
          .eq('id', n.notification_id);
        if (pushedError)
          console.error('send-notifications: could not record push', {
            id: n.notification_id,
            pushedError,
          });
        summary.pushed++;
        continue;
      }
    }

    // SMS: no push attempt, or every device failed.
    const decision = decideNotification(n, now, live, allowlist);
    if (decision.action === 'skip') {
      await fail(n.notification_id, decision.reason);
      summary.skipped[decision.reason] = (summary.skipped[decision.reason] ?? 0) + 1;
      continue;
    }
    // decision.action === 'send' only when live sending is on (decideNotification), so this is the
    // live-only "no localhost link" guard as well as the plain missing-URL guard.
    if (!customerAppUrl || (live && !isUsableCustomerAppUrl(customerAppUrl))) {
      await fail(n.notification_id, 'not_configured');
      summary.failed++;
      continue;
    }

    const message = buildNotificationSms(type, {
      branchName: n.branch_name ?? 'Pixel Barber',
      ticketNumber: n.ticket_number ?? '',
      link: n.ticket_id ? ticketLink(customerAppUrl, n.ticket_id) : '',
      slot: n.appointment_slot ?? undefined,
    });
    const result = await sendArkeselSms(n.phone_e164!, message, arkesel);
```
- In the `if (result === 'sent') {` branch, change `status: 'sent',` to `status: pushAttempted ? 'fallback_sent' : 'sent',`.
Read the whole loop afterwards: the remaining provider-error branches must be unchanged, and nothing may still reference a `decision` from before the push block.

- [ ] **Step 8: Write the sender test (runs against the deployed function)**

Create `tests/db/push-sending.test.ts`:
```typescript
// tests/db/push-sending.test.ts
// @vitest-environment node
// send-notifications push-first (web push spec, Section 2), against the deployed function on
// staging: a customer whose saved device accepts the push gets it by push (channel 'push', status
// 'sent') and a device the push service calls gone (410) is deleted; a customer with no device, or
// whose only device is gone, takes the SMS path (live SMS is off here, so it ends not_allowlisted or
// sms_disabled). Stand-in push endpoints: httpbin.org/status/201 and /status/410 (public, external).
// Subscriber keys are real P-256 keys so the library can encrypt to them.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { webcrypto } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  createAppointmentFixture,
  type AppointmentFixture,
} from './fixtures/appointments';
import { callFunction } from './fixtures/staff-invite';

let f: AppointmentFixture;
const serviceRoleKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ACCEPTS = 'https://httpbin.org/status/201';
const GONE = 'https://httpbin.org/status/410';

async function subscriberKeys() {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const raw = Buffer.from(await webcrypto.subtle.exportKey('raw', pair.publicKey));
  return {
    p256dh: raw.toString('base64url'),
    auth: Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
  };
}

async function addDevice(customerIdx: number, endpoint: string) {
  const keys = await subscriberKeys();
  const { error } = await f.admin.from('push_subscriptions').insert({
    customer_id: f.customers[customerIdx].customerId,
    // A query string keeps each test endpoint unique (endpoint is unique) while httpbin ignores it.
    endpoint: `${endpoint}?t=${f.suffix}-${customerIdx}`,
    p256dh_key: keys.p256dh,
    auth_key: keys.auth,
  });
  if (error) throw error;
}

/** An 'almost_turn' ticket for the customer with a pending youre_next notification. */
async function youreNext(customerIdx: number) {
  const { data: ticket, error } = await f.admin
    .from('queue_tickets')
    .insert({
      ticket_number: `PB-PS-${f.suffix}-${customerIdx}`,
      branch_id: f.branchId,
      customer_id: f.customers[customerIdx].customerId,
      branch_service_id: f.branchServiceId,
      assigned_barber_id: f.barberB.barberId,
      state: 'almost_turn',
      position: 2,
      created_by: 'customer',
    })
    .select('id')
    .single();
  if (error) throw error;
  const { data: n, error: nError } = await f.admin
    .from('notifications')
    .insert({
      recipient_type: 'customer',
      recipient_id: f.customers[customerIdx].customerId,
      channel: 'sms',
      notification_type: 'youre_next',
      related_ticket_id: ticket.id,
      payload: {},
    })
    .select('id')
    .single();
  if (nError) throw nError;
  return n.id as string;
}

beforeAll(async () => {
  f = await createAppointmentFixture();
  await f.admin
    .from('customers')
    .update({ push_enabled: true, sms_backup_enabled: true })
    .in(
      'id',
      f.customers.map((c) => c.customerId),
    );
}, 90000);

afterAll(async () => {
  await f.admin
    .from('push_subscriptions')
    .delete()
    .in(
      'customer_id',
      f.customers.map((c) => c.customerId),
    );
  await cleanupAppointmentFixture(f);
}, 90000);

describe('send-notifications push first', () => {
  it('pushes when a device accepts, deletes gone devices, and falls back to SMS otherwise', async () => {
    await addDevice(0, ACCEPTS);
    await addDevice(0, GONE);
    await addDevice(2, GONE);
    const ids = {
      pushed: await youreNext(0),
      noDevice: await youreNext(1),
      allGone: await youreNext(2),
    };

    const deadline = Date.now() + 75_000;
    let rows: { id: string; channel: string; status: string; failed_reason: string | null }[] = [];
    while (Date.now() < deadline) {
      await callFunction('send-notifications', {}, serviceRoleKey());
      const { data } = await f.admin
        .from('notifications')
        .select('id, channel, status, failed_reason')
        .in('id', Object.values(ids));
      rows = data ?? [];
      if (rows.length === 3 && rows.every((r) => r.status !== 'pending')) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const byId = (id: string) => rows.find((r) => r.id === id)!;
    expect(byId(ids.pushed)).toMatchObject({ channel: 'push', status: 'sent', failed_reason: null });
    for (const id of [ids.noDevice, ids.allGone]) {
      expect(byId(id).channel).toBe('sms');
      expect(byId(id).status).toBe('failed');
      expect(['not_allowlisted', 'sms_disabled']).toContain(byId(id).failed_reason);
    }

    const { data: left } = await f.admin
      .from('push_subscriptions')
      .select('customer_id, endpoint')
      .in(
        'customer_id',
        f.customers.map((c) => c.customerId),
      );
    expect(left).toEqual([
      { customer_id: f.customers[0].customerId, endpoint: `${ACCEPTS}?t=${f.suffix}-0` },
    ]);
  }, 120000);
});
```

- [ ] **Step 9: Typecheck, commit and hand over**

Run: `npm run typecheck` (Expected: no errors) and the unit tests again.
```bash
git add supabase/functions/_shared/notification-sms-core.ts supabase/functions/_shared/notification-push-core.ts supabase/functions/_shared/web-push.ts supabase/functions/send-notifications/index.ts tests/unit/notification-sms-core.test.ts tests/unit/notification-push-core.test.ts tests/db/push-sending.test.ts
git commit -m "feat: send-notifications tries web push before SMS"
```
Report "ready for deploy". The controller sets the staging secrets (`VAPID_KEYS_JSON` from `supabase/.secrets/vapid.json`, `VAPID_SUBJECT`) and deploys `send-notifications`, then runs `npx vitest run tests/db/push-sending.test.ts tests/db/send-notifications.test.ts tests/db/appointment-reminder-sending.test.ts` — Expected: PASS.

---

### Task 3: Customer app — service worker, install files, push client, working switches

**Files:**
- Create: `apps/customer/app/push/vapidPublicKey.ts`
- Create: `apps/customer/app/push/pushClient.ts`, `apps/customer/app/push/pushClient.test.ts`
- Create: `apps/customer/public/sw.js`
- Create: `apps/customer/app/manifest.ts`, `apps/customer/app/icons/[size]/route.tsx`
- Modify: `apps/customer/app/layout.tsx`
- Modify: `apps/customer/app/profile/page.tsx`, `apps/customer/app/onboard/OnboardWizard.tsx`
- Modify: `apps/customer/messages/en.json`

**Interfaces:**
- Consumes: `save_push_subscription`, `remove_push_subscription` (Task 1).
- Produces (TS, `apps/customer/app/push/pushClient.ts`): `type PushSupport = 'supported' | 'ios-install-needed' | 'unsupported'`; `detectPushSupport(env: PushEnv): PushSupport`; `browserPushEnv(): PushEnv`; `urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer>`; `currentPushSubscription(): Promise<PushSubscription | null>`; `type EnableResult = 'enabled' | 'denied' | 'unsupported' | 'failed'`; `enablePush(supabase): Promise<EnableResult>`; `disablePush(supabase): Promise<void>`. Messages namespace `Push` (`bannerText`, `turnOn`, `iosHint`, `off`).

- [ ] **Step 1: Write the failing unit test**

Create `apps/customer/app/push/pushClient.test.ts`:
```typescript
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { detectPushSupport, urlBase64ToUint8Array } from './pushClient';

const base = {
  userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130',
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  standalone: false,
};

describe('detectPushSupport', () => {
  it('is supported when the browser has service workers, push and notifications', () => {
    expect(detectPushSupport(base)).toBe('supported');
  });
  it('asks iPhone users to add to the Home Screen first', () => {
    expect(
      detectPushSupport({
        ...base,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1',
        hasPushManager: false,
        hasNotification: false,
      }),
    ).toBe('ios-install-needed');
  });
  it('is supported on an iPhone running from the Home Screen', () => {
    expect(
      detectPushSupport({
        ...base,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1',
        standalone: true,
      }),
    ).toBe('supported');
  });
  it('is unsupported elsewhere without push', () => {
    expect(detectPushSupport({ ...base, hasPushManager: false })).toBe('unsupported');
  });
});

describe('urlBase64ToUint8Array', () => {
  it('decodes base64url to bytes', () => {
    expect(Array.from(urlBase64ToUint8Array('AQID_-8'))).toEqual([1, 2, 3, 255, 239]);
  });
  it('decodes the 65-byte VAPID public key', () => {
    const bytes = urlBase64ToUint8Array(
      'BLBpLpZTjxKRXlHl9nW5ALiiAYCRBd57cMlkombDxmf-4lzUn_2jAJSSIesWhZGmeZsv7jB5lt2i2iLxSl_YVGY',
    );
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(4);
  });
});
```
Run: `npx vitest run apps/customer/app/push/pushClient.test.ts --environment=node` — Expected: FAIL (module not found).

- [ ] **Step 2: Create the key constant and the push client**

Create `apps/customer/app/push/vapidPublicKey.ts`:
```typescript
// The VAPID application server key: the public half of the key pair send-notifications signs pushes
// with (private half: Supabase secret VAPID_KEYS_JSON). Public by design.
export const VAPID_PUBLIC_KEY =
  'BLBpLpZTjxKRXlHl9nW5ALiiAYCRBd57cMlkombDxmf-4lzUn_2jAJSSIesWhZGmeZsv7jB5lt2i2iLxSl_YVGY';
```

Create `apps/customer/app/push/pushClient.ts`:
```typescript
// Web push on this device (Docs/superpowers/specs/2026-10-07-web-push-notifications-design.md):
// detect support, subscribe and save the subscription, unsubscribe and remove it.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';
import { VAPID_PUBLIC_KEY } from './vapidPublicKey';

export type PushSupport = 'supported' | 'ios-install-needed' | 'unsupported';

export interface PushEnv {
  userAgent: string;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  /** Running as an installed (Home Screen) app. */
  standalone: boolean;
}

export function detectPushSupport(env: PushEnv): PushSupport {
  if (env.hasServiceWorker && env.hasPushManager && env.hasNotification) return 'supported';
  // iPhone/iPad Safari only exposes push to apps added to the Home Screen.
  if (/iPhone|iPad|iPod/.test(env.userAgent) && !env.standalone) return 'ios-install-needed';
  return 'unsupported';
}

export function browserPushEnv(): PushEnv {
  return {
    userAgent: navigator.userAgent,
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPushManager: 'PushManager' in window,
    hasNotification: 'Notification' in window,
    standalone:
      (navigator as Navigator & { standalone?: boolean }).standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches,
  };
}

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** This device's active push subscription, if any. */
export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration('/');
  return registration ? registration.pushManager.getSubscription() : null;
}

export type EnableResult = 'enabled' | 'denied' | 'unsupported' | 'failed';

/** Asks permission, registers the service worker, subscribes and saves the subscription. */
export async function enablePush(supabase: SupabaseClient<Database>): Promise<EnableResult> {
  if (detectPushSupport(browserPushEnv()) !== 'supported') return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    const registration = await navigator.serviceWorker.ready;
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      }));
    const json = subscription.toJSON();
    const { error } = await supabase.rpc('save_push_subscription', {
      p_endpoint: subscription.endpoint,
      p_p256dh: json.keys?.p256dh ?? '',
      p_auth: json.keys?.auth ?? '',
      p_user_agent: navigator.userAgent,
    });
    return error ? 'failed' : 'enabled';
  } catch {
    return 'failed';
  }
}

/** Removes this device's saved subscription and unsubscribes it (quietly does nothing if none). */
export async function disablePush(supabase: SupabaseClient<Database>): Promise<void> {
  const subscription = await currentPushSubscription().catch(() => null);
  if (!subscription) return;
  await supabase.rpc('remove_push_subscription', { p_endpoint: subscription.endpoint });
  await subscription.unsubscribe().catch(() => false);
}
```
Run the unit test again — Expected: PASS. If `@supabase/supabase-js` isn't resolvable from `apps/customer`, type the parameter as `ReturnType<typeof createBrowserSupabaseClient>` (imported from `@pixel-barber/shared`) instead.

- [ ] **Step 3: Add the service worker**

Create `apps/customer/public/sw.js`:
```javascript
// Pixel Barber service worker: shows push notifications and opens the right screen on tap
// (Docs/superpowers/specs/2026-10-07-web-push-notifications-design.md).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Pixel Barber', {
      body: data.body || '',
      tag: data.tag,
      icon: '/icons/192',
      badge: '/icons/192',
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.url) || '/';
  const url = new URL(path, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if ('navigate' in client) {
          await client.focus();
          await client.navigate(url);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
```

- [ ] **Step 4: Make the app installable**

Create `apps/customer/app/icons/[size]/route.tsx`:
```tsx
// App icons generated on request (no binary files in the repo): brand green with "PB" in gold.
import { ImageResponse } from 'next/og';

const SIZES = new Set([180, 192, 512]);

export async function GET(_request: Request, { params }: { params: Promise<{ size: string }> }) {
  const size = Number((await params).size);
  if (!SIZES.has(size)) return new Response('Not found', { status: 404 });
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#146F3B',
          color: '#F5A623',
          fontSize: size * 0.42,
          fontWeight: 700,
        }}
      >
        PB
      </div>
    ),
    { width: size, height: size },
  );
}
```

Create `apps/customer/app/manifest.ts`:
```typescript
import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Pixel Barber',
    short_name: 'Pixel Barber',
    description: 'Join a queue or book an appointment at Pixel Barber.',
    start_url: '/',
    display: 'standalone',
    background_color: '#FFFFFF',
    theme_color: '#146F3B',
    icons: [
      { src: '/icons/192', sizes: '192x192', type: 'image/png' },
      { src: '/icons/512', sizes: '512x512', type: 'image/png' },
    ],
  };
}
```

In `apps/customer/app/layout.tsx`, extend `metadata`:
```typescript
export const metadata: Metadata = {
  title: 'Pixel Barber',
  description: 'Join a queue or book an appointment at Pixel Barber.',
  icons: { apple: '/icons/180' },
  appleWebApp: { capable: true, title: 'Pixel Barber', statusBarStyle: 'default' },
};
```
Verify with the customer dev server running: `curl -s -o /dev/null -w '%{http_code} %{content_type}' http://localhost:3000/icons/192` → `200 image/png`; `curl -s http://localhost:3000/manifest.webmanifest` shows the manifest; `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/sw.js` → `200`.

- [ ] **Step 5: Add the messages**

In `apps/customer/messages/en.json` add a top-level namespace (after `TicketTracking`):
```json
  "Push": {
    "bannerText": "Get a notification when it's your turn.",
    "turnOn": "Turn on",
    "iosHint": "To get notifications on iPhone, tap Share, then Add to Home Screen.",
    "off": "Push notifications are off — you'll still get SMS updates."
  }
```

- [ ] **Step 6: Make the Profile switch and Log out work**

In `apps/customer/app/profile/page.tsx`:
- Import `import { enablePush, disablePush } from '../push/pushClient';`, and add `const tp = useTranslations('Push');` plus `const [pushOff, setPushOff] = useState(false);`.
- Replace the push checkbox `onChange` with:
```tsx
            onChange={async (e) => {
              const checked = e.target.checked;
              if (checked) {
                const result = await enablePush(supabase);
                setCustomer({ ...customer, push_enabled: result === 'enabled' });
                setPushOff(result !== 'enabled');
              } else {
                await disablePush(supabase);
                setCustomer({ ...customer, push_enabled: false });
                setPushOff(false);
              }
            }}
```
  and directly after that `</label>` add `{pushOff && <p>{tp('off')}</p>}`.
- In `handleLogout`, call `await disablePush(supabase);` before `await supabase.auth.signOut();`.
(The `push_enabled` column is still persisted by the existing Save button; `save_push_subscription` also turns it on.)

- [ ] **Step 7: Make the Onboarding switch work**

In `apps/customer/app/onboard/OnboardWizard.tsx`, import `enablePush, disablePush` from `'../push/pushClient'` and replace the push checkbox `onChange` with:
```tsx
              onChange={async (e) => {
                if (e.target.checked) {
                  setPushEnabled((await enablePush(supabase)) === 'enabled');
                } else {
                  await disablePush(supabase);
                  setPushEnabled(false);
                }
              }}
```
(The existing `{!pushEnabled && <p>{t('pushPermissionDenied')}</p>}` line stays.) Use the wizard's existing Supabase client variable; if it isn't named `supabase`, use its name.

- [ ] **Step 8: Typecheck, lint, commit**

Run: `npm run typecheck`; `cd apps/customer && npx eslint app/push/pushClient.ts "app/icons/[size]/route.tsx" app/manifest.ts app/layout.tsx app/profile/page.tsx app/onboard/OnboardWizard.tsx` — Expected: no errors. `grep -n $'\xef\xbf\xbd' apps/customer/messages/en.json` — no output.
```bash
git add apps/customer/app/push apps/customer/public/sw.js apps/customer/app/manifest.ts "apps/customer/app/icons/[size]/route.tsx" apps/customer/app/layout.tsx apps/customer/app/profile/page.tsx apps/customer/app/onboard/OnboardWizard.tsx apps/customer/messages/en.json
git commit -m "feat: customer app service worker, install files and working push switches"
```

---

### Task 4: Turn-on banner, e2e, and the runbook

**Files:**
- Create: `apps/customer/app/push/PushBanner.tsx`
- Modify: `apps/customer/app/tickets/[id]/page.tsx`, `apps/customer/app/appointments/[id]/page.tsx`
- Create: `e2e/push-notifications.spec.ts`
- Modify: `Docs/ops/production-setup.md`

**Interfaces:**
- Consumes: `detectPushSupport`, `browserPushEnv`, `currentPushSubscription`, `enablePush` (Task 3); messages `Push.*` (Task 3); `save/remove_push_subscription` (Task 1).
- Produces: `<PushBanner />` (default export, no props).

- [ ] **Step 1: Write the failing e2e**

First pick an unused phone range: `grep -rn "+233553" e2e tests` must print nothing (else use the first free `+23355N`).

Create `e2e/push-notifications.spec.ts`:
```typescript
// e2e/push-notifications.spec.ts
// Web push, customer side: the ticket page offers "Turn on" when this device isn't set up; turning
// it on saves the device; the Profile switch removes and re-adds it; Log out removes it.
// Headless Chromium can't reach a real push service, so an init script fakes the browser's
// PushManager (state in localStorage) — this checks the app's own logic; real delivery is the
// documented manual phone check. Clicks use Enter and are scoped to <main>.
import { test, expect, type BrowserContext } from '@playwright/test';
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PASSWORD = 'Test-Password-123!';

async function signInAs(context: BrowserContext, baseURL: string | undefined, phone: string) {
  const { data } = await createClient<Database>(url, anonKey).auth.signInWithPassword({
    phone,
    password: PASSWORD,
  });
  const projectRef = new URL(url).hostname.split('.')[0];
  const cookieValue =
    'base64-' +
    Buffer.from(JSON.stringify(data.session), 'utf-8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  await context.addCookies([
    { name: `sb-${projectRef}-auth-token`, value: cookieValue, url: baseURL ?? 'http://localhost:3000' },
  ]);
}

/** Replaces the browser push service with a fake whose subscription lives in localStorage. */
async function fakePushService(context: BrowserContext, suffix: string) {
  await context.addInitScript((tag: string) => {
    const KEY = 'fake-push-endpoint';
    const make = (endpoint: string) => ({
      endpoint,
      toJSON() {
        return {
          endpoint,
          keys: {
            p256dh:
              'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
            auth: 'tBHItJI5svbpez7KI4CCXg',
          },
        };
      },
      async unsubscribe() {
        localStorage.removeItem(KEY);
        return true;
      },
    });
    PushManager.prototype.getSubscription = async function () {
      const endpoint = localStorage.getItem(KEY);
      return (endpoint ? make(endpoint) : null) as unknown as PushSubscription;
    };
    PushManager.prototype.subscribe = async function () {
      const endpoint = `https://push.example.test/e2e/${tag}/${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(KEY, endpoint);
      return make(endpoint) as unknown as PushSubscription;
    };
  }, suffix);
}

test('turn on from the ticket page, switch off and on in Profile, log out removes the device', async ({
  page,
  context,
  baseURL,
}) => {
  test.skip(!url || !serviceRoleKey, 'Supabase env vars not set');
  test.setTimeout(120_000);
  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const suffix = String(Date.now());
  // 0553… : distinct from the phone ranges other test files use.
  const phone = `+233553${suffix.slice(-6)}`;

  let service: { id: string } | null = null;
  let branch: { id: string } | null = null;
  let bs: { id: string } | null = null;
  let authUserId: string | null = null;
  let customerId: string | null = null;

  const devices = async () => {
    const { data } = await admin
      .from('push_subscriptions')
      .select('endpoint')
      .eq('customer_id', customerId!);
    return (data ?? []).map((d) => d.endpoint);
  };

  try {
    const { data: business } = await admin.from('businesses').select('id').limit(1).single();
    service = (
      await admin
        .from('services')
        .insert({ business_id: business!.id, name: `Push E2E Cut ${suffix}`, default_duration_minutes: 30 })
        .select('id')
        .single()
    ).data;
    branch = (
      await admin
        .from('branches')
        .insert({
          business_id: business!.id,
          name: `Push E2E Branch ${suffix}`,
          branch_code: `PU${suffix.slice(-6)}`,
          address: 'Test',
          latitude: 5.6,
          longitude: -0.18,
        })
        .select('id')
        .single()
    ).data;
    bs = (
      await admin
        .from('branch_services')
        .insert({ branch_id: branch!.id, service_id: service!.id })
        .select('id')
        .single()
    ).data;
    const { data: auth } = await admin.auth.admin.createUser({
      phone,
      password: PASSWORD,
      phone_confirm: true,
    });
    authUserId = auth.user!.id;
    customerId = (
      await admin
        .from('customers')
        .insert({
          auth_user_id: authUserId,
          name: 'Push E2E Customer',
          phone_e164: phone,
          avatar_key: 'avatar-1',
        })
        .select('id')
        .single()
    ).data!.id;
    const { data: ticket } = await admin
      .from('queue_tickets')
      .insert({
        ticket_number: `PB-PU-${suffix}`,
        branch_id: branch!.id,
        customer_id: customerId!,
        branch_service_id: bs!.id,
        state: 'waiting',
        created_by: 'customer',
      })
      .select('id')
      .single();

    await context.grantPermissions(['notifications']);
    await fakePushService(context, suffix);
    await signInAs(context, baseURL, phone);
    const main = page.locator('main');

    // --- 1. Ticket page offers Turn on; turning on saves this device ---
    await page.goto(`/tickets/${ticket!.id}`);
    await expect(main.getByText("Get a notification when it's your turn.")).toBeVisible({
      timeout: 15000,
    });
    await main.getByRole('button', { name: 'Turn on' }).press('Enter');
    await expect(main.getByText("Get a notification when it's your turn.")).toHaveCount(0, {
      timeout: 15000,
    });
    await expect.poll(devices, { timeout: 15000 }).toHaveLength(1);

    // --- 2. Profile switch off removes it, on adds it back ---
    await page.goto('/profile');
    const pushSwitch = main.getByLabel('Push notifications');
    await expect(pushSwitch).toBeChecked({ timeout: 15000 });
    await pushSwitch.uncheck();
    await expect.poll(devices, { timeout: 15000 }).toHaveLength(0);
    await pushSwitch.check();
    await expect.poll(devices, { timeout: 15000 }).toHaveLength(1);

    // --- 3. Log out removes this device ---
    await main.getByRole('button', { name: 'Log Out' }).press('Enter');
    await expect.poll(devices, { timeout: 15000 }).toHaveLength(0);
  } finally {
    const failures: string[] = [];
    const check = (label: string, res: { error: { message: string } | null }) => {
      if (res.error) failures.push(`${label}: ${res.error.message}`);
    };
    if (customerId) {
      check(
        'push_subscriptions',
        await admin.from('push_subscriptions').delete().eq('customer_id', customerId),
      );
    }
    if (branch) {
      const { data: tickets } = await admin.from('queue_tickets').select('id').eq('branch_id', branch.id);
      const ticketIds = (tickets ?? []).map((t) => t.id);
      if (ticketIds.length) {
        check('queue_events', await admin.from('queue_events').delete().in('ticket_id', ticketIds));
        check(
          'notifications',
          await admin.from('notifications').delete().in('related_ticket_id', ticketIds),
        );
      }
      check('queue_tickets', await admin.from('queue_tickets').delete().eq('branch_id', branch.id));
      check(
        'branch_ticket_counters',
        await admin.from('branch_ticket_counters').delete().eq('branch_id', branch.id),
      );
    }
    if (customerId) check('customers', await admin.from('customers').delete().eq('id', customerId));
    if (authUserId) await admin.auth.admin.deleteUser(authUserId);
    if (bs) check('branch_services', await admin.from('branch_services').delete().eq('id', bs.id));
    if (branch) check('branches', await admin.from('branches').delete().eq('id', branch.id));
    if (service) check('services', await admin.from('services').delete().eq('id', service.id));
    if (failures.length) throw new Error(`Cleanup failed:\n${failures.join('\n')}`);
  }
});
```
Run (both dev servers running): `npx playwright test e2e/push-notifications.spec.ts --reporter=line --workers=1` — Expected: FAIL at the banner text (no banner yet). If the Profile push checkbox's accessible name is not exactly "Push notifications" (it comes from `Profile.enablePush`), use that label instead.

- [ ] **Step 2: Create the banner**

Create `apps/customer/app/push/PushBanner.tsx`:
```tsx
'use client';

// "Turn on notifications" offer for this device (web push spec, Section 1): shown when the browser
// supports push, permission isn't denied and this device has no subscription yet; on an iPhone
// outside the Home Screen it shows the Add-to-Home-Screen hint instead.
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import { browserPushEnv, currentPushSubscription, detectPushSupport, enablePush } from './pushClient';

type BannerState = 'hidden' | 'offer' | 'ios' | 'off';

export default function PushBanner() {
  const t = useTranslations('Push');
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [state, setState] = useState<BannerState>('hidden');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const support = detectPushSupport(browserPushEnv());
    if (support === 'ios-install-needed') {
      queueMicrotask(() => {
        if (!cancelled) setState('ios');
      });
    } else if (support === 'supported' && Notification.permission !== 'denied') {
      currentPushSubscription()
        .then((subscription) => {
          if (!cancelled && !subscription) setState('offer');
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, []);

  async function turnOn() {
    setBusy(true);
    const result = await enablePush(supabase);
    setBusy(false);
    setState(result === 'enabled' || result === 'denied' ? 'hidden' : 'off');
  }

  if (state === 'hidden') return null;
  if (state === 'ios') return <p>{t('iosHint')}</p>;
  if (state === 'off') return <p>{t('off')}</p>;
  return (
    <div>
      <p>{t('bannerText')}</p>
      <button type="button" disabled={busy} onClick={turnOn}>
        {t('turnOn')}
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Show it on the ticket and appointment pages**

- `apps/customer/app/tickets/[id]/page.tsx`: `import PushBanner from '../../push/PushBanner';` and render `{isActive && <PushBanner />}` directly after `<h1>{ticket.ticket_number}</h1>`.
- `apps/customer/app/appointments/[id]/page.tsx`: `import PushBanner from '../../push/PushBanner';` and render `{(appointment.status === 'scheduled' || appointment.status === 'checked_in') && <PushBanner />}` directly after the `<h1>` line.

- [ ] **Step 4: Run the e2e to verify it passes**

`npx playwright test e2e/push-notifications.spec.ts e2e/appointment-early-check-in.spec.ts e2e/customer-login.spec.ts --reporter=line --workers=1` — Expected: PASS. Lint the banner and both pages (`cd apps/customer && npx eslint app/push/PushBanner.tsx "app/tickets/[id]/page.tsx" "app/appointments/[id]/page.tsx"`), typecheck.

- [ ] **Step 5: Document the secrets and the manual phone check**

In `Docs/ops/production-setup.md`:
- In section 1, after the secrets-file variable lists, add:
```markdown
Supabase secrets set directly on both projects (not in the env files): `VAPID_KEYS_JSON` (the JSON
in git-ignored `supabase/.secrets/vapid.json`) and `VAPID_SUBJECT`
(`https://pixel-barber-customer.vercel.app`):
`npx supabase secrets set VAPID_KEYS_JSON="$(cat supabase/.secrets/vapid.json)" VAPID_SUBJECT=https://pixel-barber-customer.vercel.app --project-ref <ref>`.
The public half is in `apps/customer/app/push/vapidPublicKey.ts`; replacing the key pair invalidates
every saved device.
```
- Add a new section before "If production is paused" (renumber the following sections if they are numbered):
```markdown
## Manual push check (after promoting push)

1. On an Android phone (Chrome) open https://pixel-barber-customer.vercel.app and log in. On an
   iPhone: open it in Safari, tap Share → Add to Home Screen, then open Pixel Barber from the Home
   Screen and log in.
2. Profile → switch on **Push notifications** → allow notifications when the phone asks.
3. Put a ticket for that customer second in line (join the queue behind someone, or ask staff).
4. Lock the phone. A "You're next at …" notification should arrive within about a minute; tapping
   it opens the ticket.
5. If nothing arrives: Profile → switch off and on again; check
   `select channel, status, failed_reason from notifications order by created_at desc limit 5;` —
   `channel = 'push', status = 'sent'` means the push service accepted it.
```

- [ ] **Step 6: Commit**

```bash
git add apps/customer/app/push/PushBanner.tsx "apps/customer/app/tickets/[id]/page.tsx" "apps/customer/app/appointments/[id]/page.tsx" e2e/push-notifications.spec.ts Docs/ops/production-setup.md
git commit -m "feat: turn-on banner for push notifications, e2e and runbook"
```

---

## After all tasks (controller)

1. Full vitest (re-run rate-limited files in small batches with pauses) and the e2e set: `push-notifications`, `appointment-early-check-in`, `customer-login`, `queue-join-now`, `appointments-staff`.
2. Final whole-branch review, one fix wave, scoped re-review.
3. **Ask the user before promoting:** production migration 20261007090000 (dry run first) → set `VAPID_KEYS_JSON` and `VAPID_SUBJECT` secrets on production → deploy `send-notifications` → push to GitHub. Then walk the user through the manual phone check.
