# Queue SMS Notifications ("You're next") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Text a customer through Arkesel when they become next in line — once per ticket, reliably,
and never to real people from test data.

**Architecture:** `recalculate_positions` records a `youre_next` notification (once per ticket, via a
unique partial index) when a ticket reaches position 2. A `pg_cron` job calls a new
`send-notifications` Edge Function every 30 seconds; it claims pending rows through a
service-role-only SQL function, applies pure decision rules (stale / expired / opted out / no phone /
live-sending off), sends via a shared Arkesel helper, and records `sent` or `failed` with a reason.

**Tech Stack:** PostgreSQL/PL-pgSQL (Supabase), `pg_cron` + `pg_net` + Supabase Vault, Supabase Edge
Functions (Deno, `@supabase/supabase-js`), Arkesel SMS API, Vitest (`tests/db/`, `tests/unit/`).

**Spec:** `Docs/superpowers/specs/2026-09-25-queue-sms-notifications-design.md`

## Corrections to the spec, found while writing this plan

1. **An extra reason, `not_configured`.** The spec's reasons don't cover a missing `CUSTOMER_APP_URL`
   or missing Arkesel secrets. Those are recorded as `failed: not_configured` (checked only for rows
   that would otherwise be sent) instead of retrying forever.
2. **The Arkesel call is shared, not copied again.** `isArkeselSuccess` and the SMS send move into
   `supabase/functions/_shared/arkesel.ts`, used by both the staff invite core and the new sender.
   `staff-invite-core.ts` re-exports `isArkeselSuccess` and its `sendInvite` behaviour is unchanged
   (its unit tests prove it); `staff-invite` and `staff-manage` are redeployed with the new import.
3. **The claim test uses a unique, made-up notification type** so the live 30-second cron job (which
   only claims `youre_next`) can never race it.
4. **Final-review hardening.** See the spec's "Amendments (implementation)" section for the
   DB-verified caller check, the 10-minute reclaim window, the allowlist, `unknown_outcome`, the
   `almost_turn`-only sendable rule, the localhost-when-live guard, and the per-run deadline.

## Global Constraints

- Every new/modified `SECURITY DEFINER` function uses `set search_path = public, pg_temp`.
- `claim_sms_notifications` is callable only by `service_role` (`revoke ... from public, anon,
  authenticated; grant ... to service_role`).
- `recalculate_positions`' existing behaviour must not change except for the new `youre_next` insert.
- Only one `youre_next` notification per ticket, ever.
- Texts are sent only when `SMS_NOTIFICATIONS_LIVE=true`; otherwise would-be texts are recorded
  `failed: sms_disabled`. Notifications older than **10 minutes** are never sent (`expired`).
- Decision order: `stale` → `expired` → `opted_out` → `no_phone` → `sms_disabled` → send.
- Batch size **50**; retry a provider error until **3** attempts, then `failed: provider_error`;
  a claim older than **5 minutes** is reclaimable.
- Message: `Pixel Barber: You're next at {branch}! Please head over now. Ticket {number}: {link}`,
  `{link} = {CUSTOMER_APP_URL}/tickets/{ticket_id}`.
- `send-notifications` accepts only `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`; anything else
  → 401. Its response never contains phone numbers.
- Any `beforeAll`/`afterAll` doing more than 1–2 DB operations gets an explicit timeout (60000 for
  the staff-invite fixture). Test cleanup FK-safe (notifications → tickets → customers → fixture).
- Already-applied migrations are never edited; `packages/shared/src/database.types.ts` is
  hand-maintained and must match the SQL.
- **Implementer subagents cannot push migrations, deploy functions, set secrets, or run SQL against
  the live project.** The controller does, after the implementer commits:
  - migrations: `set -a && source supabase/.secrets/send-sms.env && set +a && npx supabase db push`
  - functions: same env prefix, `npx supabase functions deploy <name>`
  - secrets: `npx supabase secrets set CUSTOMER_APP_URL=http://localhost:3000` (leave
    `SMS_NOTIFICATIONS_LIVE` unset)
  - Vault (Task 3 only): write a temp SQL file in the scratchpad with
    `select vault.create_secret('https://bfkokxcdgvrnevtpeycw.supabase.co', 'project_url');` and
    `select vault.create_secret('<SUPABASE_SERVICE_ROLE_KEY from .env.local>', 'notifications_dispatch_key');`,
    run `npx supabase db query --linked -f <file>`, then delete the file.
- Never add `Co-Authored-By` or any AI-attribution line to commits. Don't stage
  `apps/*/next-env.d.ts`, `graphify-out/`, `playwright-report/`, `test-results/`, or untracked
  `Docs/superpowers/plans/2026-09-1*` files.

---

### Task 1: Record "you're next" once per ticket, and the claim function

**Files:**
- Create: `supabase/migrations/20260925130000_youre_next_notifications.sql`
- Create: `tests/db/youre-next-notifications.test.ts`
- Modify: `packages/shared/src/database.types.ts`

**Interfaces:**
- Consumes: `tests/db/fixtures/staff-invite.ts` (`createStaffInviteFixture`, `cleanupStaffInviteFixture`,
  `createStaffAccount` — barber accounts get `barberId` at the fixture branch).
- Produces: columns `notifications.dispatch_claimed_at timestamptz null`,
  `notifications.dispatch_attempts smallint not null default 0`; unique index
  `notifications_one_youre_next_per_ticket`; `recalculate_positions` inserting `youre_next`;
  `claim_sms_notifications(p_types text[], p_limit int)` returning rows
  `{ notification_id, notification_type, created_at, dispatch_attempts, customer_id, phone_e164,
  sms_backup_enabled, ticket_id, ticket_state, ticket_number, branch_name }` (service_role only).

- [ ] **Step 1: Write the failing test**

Create `tests/db/youre-next-notifications.test.ts`:

```typescript
// tests/db/youre-next-notifications.test.ts
// @vitest-environment node
// Becoming second in line records exactly one 'youre_next' SMS notification per ticket, even if the
// ticket drops back and becomes next again; claim_sms_notifications hands each pending row to only
// one caller and is refused for client roles. (Status isn't asserted for youre_next rows: the live
// 30-second sender may already have processed them.)
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupStaffInviteFixture,
  createStaffAccount,
  createStaffInviteFixture,
  type StaffAccount,
  type StaffInviteFixture,
} from './fixtures/staff-invite';

let f: StaffInviteFixture;
let barber: StaffAccount;
const customerIds: string[] = [];
const ticketIds: string[] = [];
const tickets: Record<'a' | 'b' | 'c', string> = {} as never;
const claimType = () => `test_claim_${f.suffix}`;

async function makeTicket(label: 'a' | 'b' | 'c', createdAt: string) {
  const digit = { a: '1', b: '2', c: '3' }[label];
  const { data: customer, error: customerError } = await f.admin
    .from('customers')
    .insert({ name: `YN Customer ${label} ${f.suffix}`, phone_e164: `+23355${f.suffix.slice(-6)}${digit}` })
    .select('id')
    .single();
  if (customerError) throw customerError;
  customerIds.push(customer!.id);
  const { data: ticket, error } = await f.admin
    .from('queue_tickets')
    .insert({
      ticket_number: `PB-YN-${label}-${f.suffix}`,
      branch_id: f.branchId,
      customer_id: customer!.id,
      branch_service_id: f.branchServiceId,
      assigned_barber_id: barber.barberId,
      state: 'waiting',
      created_by: 'staff',
      created_at: createdAt,
    })
    .select('id')
    .single();
  if (error) throw error;
  ticketIds.push(ticket!.id);
  return ticket!.id as string;
}

async function recalc() {
  const { error } = await f.admin.rpc('recalculate_positions', {
    p_branch_id: f.branchId,
    p_barber_id: barber.barberId!,
  });
  if (error) throw error;
}

async function youreNextFor(ticketId: string) {
  const { data } = await f.admin
    .from('notifications')
    .select('id, recipient_type, recipient_id, channel, notification_type')
    .eq('related_ticket_id', ticketId)
    .eq('notification_type', 'youre_next');
  return data ?? [];
}

beforeAll(async () => {
  f = await createStaffInviteFixture();
  barber = await createStaffAccount(f, { label: 'ynbarber', role: 'barber', inviteStatus: 'accepted' });
  const base = Date.now() - 60_000;
  tickets.a = await makeTicket('a', new Date(base).toISOString());
  tickets.b = await makeTicket('b', new Date(base + 1000).toISOString());
  tickets.c = await makeTicket('c', new Date(base + 2000).toISOString());
}, 60000);

afterAll(async () => {
  await f.admin.from('notifications').delete().in('related_ticket_id', ticketIds);
  await f.admin.from('queue_events').delete().in('ticket_id', ticketIds);
  await f.admin.from('queue_tickets').delete().in('id', ticketIds);
  await f.admin.from('customers').delete().in('id', customerIds);
  await cleanupStaffInviteFixture(f);
}, 60000);

describe("recording 'youre_next'", () => {
  it('records one youre_next for the ticket that becomes second in line, and none for the others', async () => {
    await recalc();
    const { data: b } = await f.admin.from('queue_tickets').select('state').eq('id', tickets.b).single();
    expect(b!.state).toBe('almost_turn');

    const forB = await youreNextFor(tickets.b);
    expect(forB).toHaveLength(1);
    expect(forB[0]).toMatchObject({ recipient_type: 'customer', channel: 'sms' });
    expect(await youreNextFor(tickets.a)).toHaveLength(0);
    expect(await youreNextFor(tickets.c)).toHaveLength(0);
  }, 30000);

  it('never records a second youre_next when a ticket drops back and becomes next again', async () => {
    // Skipping B sends it to the back: C becomes next.
    await f.admin.from('queue_tickets').update({ skipped_at: new Date().toISOString() }).eq('id', tickets.b);
    await recalc();
    const { data: c } = await f.admin.from('queue_tickets').select('state').eq('id', tickets.c).single();
    expect(c!.state).toBe('almost_turn');
    expect(await youreNextFor(tickets.c)).toHaveLength(1);

    // Un-skipping B makes it next again.
    await f.admin.from('queue_tickets').update({ skipped_at: null }).eq('id', tickets.b);
    await recalc();
    const { data: b } = await f.admin.from('queue_tickets').select('state').eq('id', tickets.b).single();
    expect(b!.state).toBe('almost_turn');
    expect(await youreNextFor(tickets.b)).toHaveLength(1);
  }, 30000);
});

describe('claim_sms_notifications', () => {
  it('gives each pending row to exactly one of two overlapping claims, with its ticket and branch details', async () => {
    const rows = [tickets.a, tickets.b, tickets.c].map((ticketId, i) => ({
      recipient_type: 'customer' as const,
      recipient_id: customerIds[i],
      channel: 'sms' as const,
      notification_type: claimType(),
      related_ticket_id: ticketId,
    }));
    const { data: inserted, error } = await f.admin.from('notifications').insert(rows).select('id');
    expect(error).toBeNull();
    const insertedIds = new Set(inserted!.map((r) => r.id));

    const claim = () =>
      f.admin.rpc('claim_sms_notifications', { p_types: [claimType()], p_limit: 50 });
    const [first, second] = await Promise.all([claim(), claim()]);
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    const firstIds = (first.data ?? []).map((r) => r.notification_id);
    const secondIds = (second.data ?? []).map((r) => r.notification_id);
    expect(firstIds.filter((id) => secondIds.includes(id))).toHaveLength(0);
    expect(new Set([...firstIds, ...secondIds])).toEqual(insertedIds);

    const sample = [...(first.data ?? []), ...(second.data ?? [])][0];
    expect(sample.branch_name).toBe(f.branchName);
    expect(sample.phone_e164).toMatch(/^\+23355/);
    expect(sample.ticket_number).toMatch(/^PB-YN-/);
    expect(sample.dispatch_attempts).toBe(1);
    expect(sample.sms_backup_enabled).toBe(true);

    // Freshly claimed rows are not handed out again.
    const { data: again } = await claim();
    expect(again ?? []).toHaveLength(0);
  }, 30000);

  it('is refused for client roles', async () => {
    const { error } = await f.owner.client.rpc('claim_sms_notifications', {
      p_types: [claimType()],
      p_limit: 50,
    });
    expect(error).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- tests/db/youre-next-notifications.test.ts`
Expected: FAIL — no `youre_next` rows are recorded and `claim_sms_notifications` doesn't exist.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260925130000_youre_next_notifications.sql`:

```sql
-- Queue SMS notifications (Docs/superpowers/specs/2026-09-25-queue-sms-notifications-design.md).
-- recalculate_positions records a 'youre_next' notification once per ticket when it becomes second
-- in line; claim_sms_notifications hands pending SMS rows to the send-notifications sender.

alter table notifications
  add column dispatch_claimed_at timestamptz,
  add column dispatch_attempts smallint not null default 0;

-- One "you're next" per ticket, ever -- a ticket that drops back and becomes next again is never
-- texted twice.
create unique index notifications_one_youre_next_per_ticket
  on notifications (related_ticket_id) where notification_type = 'youre_next';

-- recalculate_positions: identical to 20260923090000_final_review_fixes.sql except the new
-- 'youre_next' insert when a ticket moves into 'almost_turn'. create or replace keeps its grants.
create or replace function recalculate_positions(p_branch_id uuid, p_barber_id uuid) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reentrant boolean;
  v_ticket record;
  v_new_state ticket_state;
begin
  v_reentrant := coalesce(current_setting('pixelbarber.recalc_in_progress', true), 'false') = 'true';
  if v_reentrant then
    return;
  end if;
  perform set_config('pixelbarber.recalc_in_progress', 'true', true);

  with ranked as (
    select id, row_number() over (
      order by coalesce(skipped_at, '-infinity'::timestamptz), created_at
    ) as rn
    from queue_tickets
    where branch_id = p_branch_id
      and (
        (
          state in ('waiting','almost_turn')
          and (p_barber_id is null or assigned_barber_id = p_barber_id or (assigned_barber_id is null and is_pooled))
        )
        or (state = 'called' and p_barber_id is not null and assigned_barber_id = p_barber_id)
      )
  )
  update queue_tickets qt set position = ranked.rn
  from ranked
  where qt.id = ranked.id
    and qt.position is distinct from ranked.rn;

  if p_barber_id is not null then
    for v_ticket in
      select id, customer_id, state, position
      from queue_tickets
      where branch_id = p_branch_id
        and assigned_barber_id = p_barber_id
        and state in ('waiting','almost_turn','called')
        and position is not null
    loop
      v_new_state := case
        when v_ticket.position = 1 then 'called'
        when v_ticket.position = 2 then 'almost_turn'
        else 'waiting'
      end;
      if v_new_state is distinct from v_ticket.state then
        update queue_tickets
          set state = v_new_state,
              called_at = case when v_new_state = 'called' then now() else called_at end
          where id = v_ticket.id;
        if v_new_state = 'called' then
          insert into notifications (recipient_type, recipient_id, channel, notification_type, related_ticket_id, payload)
            values ('customer', v_ticket.customer_id, 'sms', 'your_turn', v_ticket.id, '{}'::jsonb);
        elsif v_new_state = 'almost_turn' then
          insert into notifications (recipient_type, recipient_id, channel, notification_type, related_ticket_id, payload)
            values ('customer', v_ticket.customer_id, 'sms', 'youre_next', v_ticket.id, '{}'::jsonb)
            on conflict (related_ticket_id) where notification_type = 'youre_next' do nothing;
        end if;
      end if;
    end loop;
  end if;

  perform set_config('pixelbarber.recalc_in_progress', 'false', true);
end;
$$;

-- The send-notifications sender's work queue: atomically claims pending SMS rows of the given types
-- (skip locked, so overlapping runs never share a row; a claim older than 5 minutes -- a crashed run
-- -- is reclaimable) and returns what the sender needs to decide and send.
create or replace function claim_sms_notifications(p_types text[], p_limit int)
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
  branch_name text
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
        and (dispatch_claimed_at is null or dispatch_claimed_at < now() - interval '5 minutes')
      order by created_at
      limit p_limit
      for update skip locked
    )
    returning n.id, n.notification_type, n.created_at, n.dispatch_attempts, n.recipient_id,
              n.related_ticket_id
  )
  select c.id, c.notification_type, c.created_at, c.dispatch_attempts, c.recipient_id,
         cu.phone_e164, cu.sms_backup_enabled, t.id, t.state, t.ticket_number, b.name
  from claimed c
  left join customers cu on cu.id = c.recipient_id
  left join queue_tickets t on t.id = c.related_ticket_id
  left join branches b on b.id = t.branch_id;
$$;

revoke execute on function claim_sms_notifications(text[], int) from public, anon, authenticated;
grant execute on function claim_sms_notifications(text[], int) to service_role;
```

- [ ] **Step 4: Add the types**

Modify `packages/shared/src/database.types.ts`:

(a) In `notifications`' `Row`, add (alphabetical among existing keys):
```typescript
          dispatch_attempts: number;
          dispatch_claimed_at: string | null;
```
In its `Insert` and `Update`, add `dispatch_attempts?: number;` and `dispatch_claimed_at?: string | null;`.

(b) In the `Functions` map, placed alphabetically (it sorts after `auth_staff_id` and before
`custom_access_token_hook`):
```typescript
      claim_sms_notifications: {
        Args: { p_types: string[]; p_limit: number };
        Returns: {
          notification_id: string;
          notification_type: string;
          created_at: string;
          dispatch_attempts: number;
          customer_id: string;
          phone_e164: string | null;
          sms_backup_enabled: boolean | null;
          ticket_id: string | null;
          ticket_state: Database['public']['Enums']['ticket_state'] | null;
          ticket_number: string | null;
          branch_name: string | null;
        }[];
      };
```

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` — Expected: PASS.

```bash
git add supabase/migrations/20260925130000_youre_next_notifications.sql tests/db/youre-next-notifications.test.ts packages/shared/src/database.types.ts
git commit -m "feat: record a one-per-ticket 'you're next' notification and add the SMS claim function"
```

- [ ] **Step 6 (controller): push and verify GREEN**

Controller pushes the migration, then runs
`npx vitest run tests/db/youre-next-notifications.test.ts tests/db/recalculate-positions-promotion.test.ts tests/db/skip-to-waiting.test.ts`
— Expected: PASS (the last two prove `recalculate_positions` still behaves as before).

---

### Task 2: Shared Arkesel helper and the pure notification rules

**Files:**
- Create: `supabase/functions/_shared/arkesel.ts`
- Create: `supabase/functions/_shared/notification-sms-core.ts`
- Modify: `supabase/functions/_shared/staff-invite-core.ts` (use the shared Arkesel helper)
- Create: `tests/unit/notification-sms-core.test.ts`

**Interfaces:**
- Produces (`_shared/arkesel.ts`): `interface ArkeselConfig { apiKey?: string; senderId?: string }`,
  `isArkeselSuccess(httpOk: boolean, rawBody: string): boolean`,
  `sendArkeselSms(phone: string, message: string, config: ArkeselConfig, fetchImpl?: typeof fetch): Promise<'sent' | 'not_configured' | 'provider_error'>` (never throws).
- Produces (`_shared/notification-sms-core.ts`): `SMS_NOTIFICATION_TYPES = ['youre_next']`,
  `DISPATCH_BATCH_SIZE = 50`, `MAX_DISPATCH_ATTEMPTS = 3`, `MAX_NOTIFICATION_AGE_MINUTES = 10`,
  `type SkipReason = 'stale' | 'expired' | 'opted_out' | 'no_phone' | 'sms_disabled'`,
  `interface ClaimedNotification` (the claim row shape from Task 1),
  `decideNotification(n: ClaimedNotification, now: Date, live: boolean): { action: 'send' } | { action: 'skip'; reason: SkipReason }`,
  `ticketLink(baseUrl: string, ticketId: string): string`,
  `buildYoureNextSms(input: { branchName: string; ticketNumber: string; link: string }): string`,
  `afterProviderError(attemptsSoFar: number): 'retry' | 'fail'`.
- `staff-invite-core.ts` keeps exporting `isArkeselSuccess` (re-export) and `sendInvite` with
  identical results.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/notification-sms-core.test.ts`:

```typescript
// tests/unit/notification-sms-core.test.ts
// @vitest-environment node
// Pure rules behind the send-notifications sender, and the shared Arkesel SMS helper.
import { describe, expect, it, vi } from 'vitest';
import { sendArkeselSms } from '../../supabase/functions/_shared/arkesel';
import {
  afterProviderError,
  buildYoureNextSms,
  decideNotification,
  ticketLink,
  type ClaimedNotification,
} from '../../supabase/functions/_shared/notification-sms-core';

const NOW = new Date('2026-09-25T12:00:00Z');

function row(overrides: Partial<ClaimedNotification> = {}): ClaimedNotification {
  return {
    notification_id: 'n1',
    notification_type: 'youre_next',
    created_at: '2026-09-25T11:58:00Z',
    dispatch_attempts: 1,
    customer_id: 'c1',
    phone_e164: '+233244123456',
    sms_backup_enabled: true,
    ticket_id: 't1',
    ticket_state: 'almost_turn',
    ticket_number: 'A12',
    branch_name: 'Osu Branch',
    ...overrides,
  };
}

describe('decideNotification', () => {
  it('sends a fresh, reachable notification when live sending is on', () => {
    expect(decideNotification(row(), NOW, true)).toEqual({ action: 'send' });
  });

  it.each([
    ['stale when the ticket was already called', row({ ticket_state: 'called' }), 'stale'],
    ['stale when the ticket is gone', row({ ticket_state: null, ticket_id: null }), 'stale'],
    ['expired when older than 10 minutes', row({ created_at: '2026-09-25T11:49:59Z' }), 'expired'],
    ['opted_out when SMS is switched off', row({ sms_backup_enabled: false }), 'opted_out'],
    ['no_phone when there is no number', row({ phone_e164: null }), 'no_phone'],
  ])('%s', (_label, n, reason) => {
    expect(decideNotification(n, NOW, true)).toEqual({ action: 'skip', reason });
  });

  it('records sms_disabled for a sendable row when live sending is off', () => {
    expect(decideNotification(row(), NOW, false)).toEqual({ action: 'skip', reason: 'sms_disabled' });
  });

  it('checks in order: stale before expired before opted_out before no_phone before live', () => {
    const everythingWrong = row({
      ticket_state: 'completed',
      created_at: '2026-09-25T10:00:00Z',
      sms_backup_enabled: false,
      phone_e164: null,
    });
    expect(decideNotification(everythingWrong, NOW, false)).toEqual({ action: 'skip', reason: 'stale' });
    expect(
      decideNotification(row({ created_at: '2026-09-25T10:00:00Z', phone_e164: null }), NOW, false),
    ).toEqual({ action: 'skip', reason: 'expired' });
    expect(
      decideNotification(row({ sms_backup_enabled: false, phone_e164: null }), NOW, false),
    ).toEqual({ action: 'skip', reason: 'opted_out' });
    expect(decideNotification(row({ phone_e164: null }), NOW, false)).toEqual({
      action: 'skip',
      reason: 'no_phone',
    });
  });

  it("treats 'waiting' as still sendable", () => {
    expect(decideNotification(row({ ticket_state: 'waiting' }), NOW, true)).toEqual({ action: 'send' });
  });
});

describe('message building', () => {
  it('builds the ticket link without a doubled slash', () => {
    expect(ticketLink('https://app.example.com/', 't1')).toBe('https://app.example.com/tickets/t1');
    expect(ticketLink('http://localhost:3000', 't1')).toBe('http://localhost:3000/tickets/t1');
  });

  it("builds the 'you're next' text", () => {
    expect(
      buildYoureNextSms({ branchName: 'Osu Branch', ticketNumber: 'A12', link: 'http://x/tickets/t1' }),
    ).toBe("Pixel Barber: You're next at Osu Branch! Please head over now. Ticket A12: http://x/tickets/t1");
  });
});

describe('afterProviderError', () => {
  it('retries until the third attempt, then fails', () => {
    expect(afterProviderError(1)).toBe('retry');
    expect(afterProviderError(2)).toBe('retry');
    expect(afterProviderError(3)).toBe('fail');
  });
});

describe('sendArkeselSms', () => {
  const config = { apiKey: 'ak', senderId: 'PixelBarbr' };
  const stub = (status: number, body: string) => vi.fn(async () => new Response(body, { status }));

  it('sends through Arkesel', async () => {
    const fetchImpl = stub(200, '{"status":"success"}');
    expect(await sendArkeselSms('+233244123456', 'hello', config, fetchImpl)).toBe('sent');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://sms.arkesel.com/api/v2/sms/send');
    expect((init.headers as Record<string, string>)['api-key']).toBe('ak');
    expect(JSON.parse(init.body as string)).toEqual({
      sender: 'PixelBarbr',
      message: 'hello',
      recipients: ['+233244123456'],
    });
  });

  it('reports not_configured without secrets', async () => {
    expect(
      await sendArkeselSms('+233244123456', 'x', { apiKey: undefined, senderId: 'S' }, stub(200, '{}')),
    ).toBe('not_configured');
  });

  it('reports provider_error on a failure body, an HTTP error, or a thrown call', async () => {
    expect(await sendArkeselSms('+233244123456', 'x', config, stub(200, '{"status":"error"}'))).toBe(
      'provider_error',
    );
    expect(await sendArkeselSms('+233244123456', 'x', config, stub(500, 'boom'))).toBe('provider_error');
    const throwing = vi.fn(async () => {
      throw new Error('network');
    });
    expect(await sendArkeselSms('+233244123456', 'x', config, throwing)).toBe('provider_error');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- tests/unit/notification-sms-core.test.ts`
Expected: FAIL — the two modules don't exist.

- [ ] **Step 3: Create the shared Arkesel helper**

Create `supabase/functions/_shared/arkesel.ts`:

```typescript
// supabase/functions/_shared/arkesel.ts
// The one Arkesel SMS call used by staff invites and queue notifications. No Deno APIs and no
// imports, so Vitest can import it. (send-sms, the auth OTP hook, keeps its own copy of
// isArkeselSuccess because its module calls Deno.serve on import.)

export interface ArkeselConfig {
  apiKey?: string;
  senderId?: string;
}

// Arkesel's confirmed v2 success shape is { status: "success", data: {...} }: a non-2xx is always a
// failure, and a 2xx body that explicitly says status !== "success" is also a failure; anything else
// 2xx is treated as success.
export function isArkeselSuccess(httpOk: boolean, rawBody: string): boolean {
  if (!httpOk) return false;
  try {
    const parsed = JSON.parse(rawBody) as { status?: string };
    if (parsed.status === undefined) return true;
    return parsed.status === 'success';
  } catch {
    return true;
  }
}

/** Sends one SMS. Never throws. */
export async function sendArkeselSms(
  phone: string,
  message: string,
  config: ArkeselConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<'sent' | 'not_configured' | 'provider_error'> {
  if (!config.apiKey || !config.senderId) return 'not_configured';
  try {
    const response = await fetchImpl('https://sms.arkesel.com/api/v2/sms/send', {
      method: 'POST',
      headers: { 'api-key': config.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: config.senderId, message, recipients: [phone] }),
      signal: AbortSignal.timeout(10_000),
    });
    const rawBody = await response.text();
    return isArkeselSuccess(response.ok, rawBody) ? 'sent' : 'provider_error';
  } catch {
    return 'provider_error';
  }
}
```

- [ ] **Step 4: Point the staff invite core at the shared helper**

In `supabase/functions/_shared/staff-invite-core.ts`:
- Update the header comment: it now imports only `./arkesel.ts` (still no Deno APIs).
- Add at the top: `import { isArkeselSuccess, sendArkeselSms } from './arkesel.ts';` and
  `export { isArkeselSuccess };` — then delete the local `isArkeselSuccess` function and its comment.
- In `sendInvite`, replace the whole SMS branch (from the `arkeselApiKey`/`arkeselSenderId` check
  through the `isArkeselSuccess(...)` return) with:

```typescript
    const smsResult = await sendArkeselSms(
      target.phone,
      message.sms,
      { apiKey: config.arkeselApiKey, senderId: config.arkeselSenderId },
      fetchImpl,
    );
    if (smsResult === 'sent') return { delivered: true };
    return {
      delivered: false,
      reason: smsResult === 'not_configured' ? 'sms_not_configured' : 'provider_error',
    };
```
Leave the email branch and everything else unchanged.

- [ ] **Step 5: Create the notification rules module**

Create `supabase/functions/_shared/notification-sms-core.ts`:

```typescript
// supabase/functions/_shared/notification-sms-core.ts
// Pure rules for the send-notifications sender
// (Docs/superpowers/specs/2026-09-25-queue-sms-notifications-design.md). No Deno APIs, so Vitest
// can import it.

/** Notification types the sender texts. Enabling another type later is a one-line change. */
export const SMS_NOTIFICATION_TYPES = ['youre_next'] as const;
export const DISPATCH_BATCH_SIZE = 50;
export const MAX_DISPATCH_ATTEMPTS = 3;
export const MAX_NOTIFICATION_AGE_MINUTES = 10;

export type SkipReason = 'stale' | 'expired' | 'opted_out' | 'no_phone' | 'sms_disabled';

/** One row returned by claim_sms_notifications. */
export interface ClaimedNotification {
  notification_id: string;
  notification_type: string;
  created_at: string;
  dispatch_attempts: number;
  customer_id: string;
  phone_e164: string | null;
  sms_backup_enabled: boolean | null;
  ticket_id: string | null;
  ticket_state: string | null;
  ticket_number: string | null;
  branch_name: string | null;
}

const SENDABLE_TICKET_STATES = new Set(['waiting', 'almost_turn']);

/** Decides one claimed notification, checking stale → expired → opted_out → no_phone → live. */
export function decideNotification(
  n: ClaimedNotification,
  now: Date,
  live: boolean,
): { action: 'send' } | { action: 'skip'; reason: SkipReason } {
  if (!n.ticket_id || !n.ticket_state || !SENDABLE_TICKET_STATES.has(n.ticket_state)) {
    return { action: 'skip', reason: 'stale' };
  }
  const ageMs = now.getTime() - new Date(n.created_at).getTime();
  if (ageMs > MAX_NOTIFICATION_AGE_MINUTES * 60 * 1000) return { action: 'skip', reason: 'expired' };
  if (n.sms_backup_enabled === false) return { action: 'skip', reason: 'opted_out' };
  if (!n.phone_e164) return { action: 'skip', reason: 'no_phone' };
  if (!live) return { action: 'skip', reason: 'sms_disabled' };
  return { action: 'send' };
}

export function ticketLink(baseUrl: string, ticketId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/tickets/${ticketId}`;
}

export function buildYoureNextSms(input: { branchName: string; ticketNumber: string; link: string }): string {
  return `Pixel Barber: You're next at ${input.branchName}! Please head over now. Ticket ${input.ticketNumber}: ${input.link}`;
}

/** After a provider error on a row that has now been attempted `attemptsSoFar` times. */
export function afterProviderError(attemptsSoFar: number): 'retry' | 'fail' {
  return attemptsSoFar < MAX_DISPATCH_ATTEMPTS ? 'retry' : 'fail';
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test -- tests/unit/notification-sms-core.test.ts tests/unit/staff-invite-core.test.ts`
Expected: PASS (the second file proves `sendInvite` behaves exactly as before).

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck` — Expected: PASS.

```bash
git add supabase/functions/_shared/arkesel.ts supabase/functions/_shared/notification-sms-core.ts supabase/functions/_shared/staff-invite-core.ts tests/unit/notification-sms-core.test.ts
git commit -m "feat: add shared Arkesel helper and pure 'you're next' SMS rules"
```

---

### Task 3: The `send-notifications` function and its 30-second schedule

**Files:**
- Create: `supabase/functions/send-notifications/index.ts`
- Create: `supabase/functions/send-notifications/deno.json`
- Create: `supabase/migrations/20260925140000_send_notifications_cron.sql`
- Create: `tests/db/send-notifications.test.ts`

**Interfaces:**
- Consumes: Task 1 `claim_sms_notifications` and columns; Task 2 `sendArkeselSms` (`_shared/arkesel.ts`)
  and everything in `_shared/notification-sms-core.ts`; existing `_shared/http.ts` (`json`) and
  `_shared/cors.ts`.
- Produces (HTTP): `POST /functions/v1/send-notifications` with
  `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>` → 200
  `{ claimed, sent, retried, failed, skipped: { [reason]: count } }`; otherwise 401/405/500.

- [ ] **Step 1: Write the failing test**

Create `tests/db/send-notifications.test.ts`:

```typescript
// tests/db/send-notifications.test.ts
// @vitest-environment node
// send-notifications (deployed, live sending OFF on this shared project): every pending 'youre_next'
// notification ends with the right reason, and nothing is ever texted. The live 30-second cron job
// may process these rows too -- the outcome is identical, so the test polls until none are pending.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  callFunction,
  cleanupStaffInviteFixture,
  createStaffInviteFixture,
  type StaffInviteFixture,
} from './fixtures/staff-invite';

type Reason = 'stale' | 'expired' | 'opted_out' | 'no_phone' | 'sms_disabled';

let f: StaffInviteFixture;
const customerIds: string[] = [];
const ticketIds: string[] = [];
const notificationIds: Partial<Record<Reason, string>> = {};
const serviceRoleKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY!;
const anonKey = () => process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

async function makeCase(
  label: Reason,
  opts: { ticketState?: 'waiting' | 'called'; smsBackup?: boolean; phone?: string | null; ageMinutes?: number },
) {
  const { data: customer, error: customerError } = await f.admin
    .from('customers')
    .insert({
      name: `SN Customer ${label} ${f.suffix}`,
      phone_e164: opts.phone === undefined ? `+23356${f.suffix.slice(-6)}${customerIds.length}` : opts.phone,
      sms_backup_enabled: opts.smsBackup ?? true,
    })
    .select('id')
    .single();
  if (customerError) throw customerError;
  customerIds.push(customer!.id);
  const { data: ticket, error: ticketError } = await f.admin
    .from('queue_tickets')
    .insert({
      ticket_number: `PB-SN-${label}-${f.suffix}`,
      branch_id: f.branchId,
      customer_id: customer!.id,
      branch_service_id: f.branchServiceId,
      state: opts.ticketState ?? 'waiting',
      created_by: 'staff',
    })
    .select('id')
    .single();
  if (ticketError) throw ticketError;
  ticketIds.push(ticket!.id);
  const { data: notification, error } = await f.admin
    .from('notifications')
    .insert({
      recipient_type: 'customer',
      recipient_id: customer!.id,
      channel: 'sms',
      notification_type: 'youre_next',
      related_ticket_id: ticket!.id,
      created_at: new Date(Date.now() - (opts.ageMinutes ?? 0) * 60_000).toISOString(),
    })
    .select('id')
    .single();
  if (error) throw error;
  notificationIds[label] = notification!.id;
}

beforeAll(async () => {
  f = await createStaffInviteFixture();
  await makeCase('stale', { ticketState: 'called' });
  await makeCase('expired', { ageMinutes: 11 });
  await makeCase('opted_out', { smsBackup: false });
  await makeCase('no_phone', { phone: null });
  await makeCase('sms_disabled', {});
}, 60000);

afterAll(async () => {
  await f.admin.from('notifications').delete().in('related_ticket_id', ticketIds);
  await f.admin.from('queue_tickets').delete().in('id', ticketIds);
  await f.admin.from('customers').delete().in('id', customerIds);
  await cleanupStaffInviteFixture(f);
}, 60000);

describe('send-notifications', () => {
  it('refuses callers without the service role key', async () => {
    expect((await callFunction('send-notifications', {})).status).toBe(401);
    expect((await callFunction('send-notifications', {}, anonKey())).status).toBe(401);
  });

  it('records the right reason for every notification and sends nothing while live sending is off', async () => {
    const ids = Object.values(notificationIds) as string[];
    let rows: { id: string; status: string; failed_reason: string | null; sent_at: string | null }[] = [];
    for (let i = 0; i < 12; i++) {
      const result = await callFunction('send-notifications', {}, serviceRoleKey());
      expect(result.status).toBe(200);
      expect(JSON.stringify(result.body)).not.toMatch(/\+233/);
      const { data } = await f.admin
        .from('notifications')
        .select('id, status, failed_reason, sent_at')
        .in('id', ids);
      rows = data ?? [];
      if (rows.length === ids.length && rows.every((r) => r.status !== 'pending')) break;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const [reason, id] of Object.entries(notificationIds)) {
      expect(byId.get(id!)).toMatchObject({ status: 'failed', failed_reason: reason, sent_at: null });
    }
  }, 60000);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- tests/db/send-notifications.test.ts`
Expected: FAIL — the function isn't deployed (404s).

- [ ] **Step 3: Write the function**

Create `supabase/functions/send-notifications/deno.json`:

```json
{
  "imports": {
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2.116.0"
  }
}
```

Create `supabase/functions/send-notifications/index.ts`:

```typescript
// supabase/functions/send-notifications/index.ts
// Queue SMS sender (Docs/superpowers/specs/2026-09-25-queue-sms-notifications-design.md). Called
// every 30 seconds by the send-notifications pg_cron job (and by tests) with the service role key;
// never by the apps. Claims pending SMS notifications, decides each (stale / expired / opted out /
// no phone / live sending off), texts the rest through Arkesel, and records sent or failed.
// Texts go out ONLY when SMS_NOTIFICATIONS_LIVE=true -- this project is shared with automated tests
// whose made-up Ghana numbers may belong to real people.
import { createClient } from '@supabase/supabase-js';
import { corsHeaders } from '../_shared/cors.ts';
import { json } from '../_shared/http.ts';
import { sendArkeselSms } from '../_shared/arkesel.ts';
import {
  DISPATCH_BATCH_SIZE,
  SMS_NOTIFICATION_TYPES,
  afterProviderError,
  buildYoureNextSms,
  decideNotification,
  ticketLink,
  type ClaimedNotification,
} from '../_shared/notification-sms-core.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  if (req.headers.get('Authorization') !== `Bearer ${serviceRoleKey}`) {
    return json(401, { error: 'Unauthorized' });
  }

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, serviceRoleKey);
  const live = Deno.env.get('SMS_NOTIFICATIONS_LIVE') === 'true';
  const customerAppUrl = Deno.env.get('CUSTOMER_APP_URL') ?? '';
  const arkesel = {
    apiKey: Deno.env.get('ARKESEL_API_KEY') ?? undefined,
    senderId: Deno.env.get('ARKESEL_SENDER_ID') ?? undefined,
  };

  const { data, error } = await admin.rpc('claim_sms_notifications', {
    p_types: [...SMS_NOTIFICATION_TYPES],
    p_limit: DISPATCH_BATCH_SIZE,
  });
  if (error) {
    console.error('send-notifications: claim failed', error);
    return json(500, { error: 'Could not claim notifications' });
  }
  const rows = (data ?? []) as ClaimedNotification[];
  const summary = {
    claimed: rows.length,
    sent: 0,
    retried: 0,
    failed: 0,
    skipped: {} as Record<string, number>,
  };

  const fail = async (id: string, reason: string) => {
    const { error: updateError } = await admin
      .from('notifications')
      .update({ status: 'failed', failed_reason: reason, dispatch_claimed_at: null })
      .eq('id', id);
    if (updateError) console.error('send-notifications: could not record failure', { id, reason, updateError });
  };

  for (const n of rows) {
    const decision = decideNotification(n, new Date(), live);
    if (decision.action === 'skip') {
      await fail(n.notification_id, decision.reason);
      summary.skipped[decision.reason] = (summary.skipped[decision.reason] ?? 0) + 1;
      continue;
    }
    if (!customerAppUrl) {
      await fail(n.notification_id, 'not_configured');
      summary.failed++;
      continue;
    }

    const message = buildYoureNextSms({
      branchName: n.branch_name ?? 'Pixel Barber',
      ticketNumber: n.ticket_number ?? '',
      link: ticketLink(customerAppUrl, n.ticket_id!),
    });
    const result = await sendArkeselSms(n.phone_e164!, message, arkesel);

    if (result === 'sent') {
      const { error: updateError } = await admin
        .from('notifications')
        .update({ status: 'sent', sent_at: new Date().toISOString(), failed_reason: null, dispatch_claimed_at: null })
        .eq('id', n.notification_id);
      if (updateError) console.error('send-notifications: could not record send', { id: n.notification_id, updateError });
      summary.sent++;
    } else if (result === 'not_configured') {
      await fail(n.notification_id, 'not_configured');
      summary.failed++;
    } else if (afterProviderError(n.dispatch_attempts) === 'retry') {
      console.error('send-notifications: provider error, will retry', {
        id: n.notification_id,
        attempts: n.dispatch_attempts,
      });
      const { error: releaseError } = await admin
        .from('notifications')
        .update({ dispatch_claimed_at: null })
        .eq('id', n.notification_id);
      if (releaseError) console.error('send-notifications: could not release claim', { id: n.notification_id, releaseError });
      summary.retried++;
    } else {
      console.error('send-notifications: provider error, giving up', { id: n.notification_id });
      await fail(n.notification_id, 'provider_error');
      summary.failed++;
    }
  }

  return json(200, summary);
});
```

- [ ] **Step 4: Write the schedule migration**

Create `supabase/migrations/20260925140000_send_notifications_cron.sql`:

```sql
-- Queue SMS notifications: call the send-notifications Edge Function every 30 seconds. The function
-- URL and the service role key come from Supabase Vault (secrets 'project_url' and
-- 'notifications_dispatch_key', created once at deploy time -- never written in a migration). Until
-- both exist the call simply fails and is retried on the next tick; nothing else depends on it.
select cron.schedule(
  'send-notifications',
  '30 seconds',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/send-notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'notifications_dispatch_key')
    ),
    body := '{}'::jsonb
  );
  $$
);
```

- [ ] **Step 5: Commit**

Run `npm run typecheck` — Expected: PASS (if `deno` is installed, also
`deno check supabase/functions/send-notifications/index.ts`).

```bash
git add supabase/functions/send-notifications supabase/migrations/20260925140000_send_notifications_cron.sql tests/db/send-notifications.test.ts
git commit -m "feat: add send-notifications SMS sender and its 30-second schedule"
```

- [ ] **Step 6 (controller): configure, deploy, verify GREEN**

1. `npx supabase secrets set CUSTOMER_APP_URL=http://localhost:3000` (do NOT set `SMS_NOTIFICATIONS_LIVE`).
2. Deploy `send-notifications`, and redeploy `staff-invite` and `staff-manage` (they now import
   `_shared/arkesel.ts` through the invite core).
3. Create the two Vault secrets (Global Constraints) and push the cron migration.
4. Run `npx vitest run tests/db/send-notifications.test.ts tests/db/youre-next-notifications.test.ts tests/db/staff-invite.test.ts tests/db/staff-manage.test.ts` — Expected: PASS.
5. Confirm the cron job reaches the function: via `npx supabase db query --linked`, run
   `select status_code from net._http_response order by created desc limit 3` a minute after the push —
   expect 200s.

---

## Self-Review

**Spec coverage:**
- Section 1 (record `youre_next` once per ticket; new columns; other notifications unchanged;
  `recalculate_positions` otherwise unchanged) → Task 1 (+ regression tests in Step 6).
- Section 2 claim function → Task 1; sender (auth, enabled types, batch 50, decision order, message,
  outcomes, retries, summary without phones) → Tasks 2–3; schedule + Vault → Task 3; settings → Task 3
  controller step.
- Section 3 safety (live switch, 10-minute limit, queue never waits on SMS) → Tasks 2–3; errors →
  Tasks 2–3; testing (DB, unit, function, manual) → Tasks 1–3 + the manual live test left to the user.
- Corrections 1–3 → Tasks 3, 2, 1.

**Placeholder scan:** none — every code step has its code; the only runtime values (Vault secrets,
`CUSTOMER_APP_URL`) are set by the controller per Global Constraints.

**Type consistency:** the claim row fields match between the SQL `returns table`, the
`database.types.ts` entry, `ClaimedNotification`, and the function. Reasons (`stale`, `expired`,
`opted_out`, `no_phone`, `sms_disabled`, plus `not_configured` and `provider_error`) match between
`decideNotification`, the function, and both test files. `sendArkeselSms`'s result union
(`sent | not_configured | provider_error`) is handled identically by `sendInvite` and the function.
