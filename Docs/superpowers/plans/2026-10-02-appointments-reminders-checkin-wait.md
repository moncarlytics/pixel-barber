# Appointments Part 3 — Reminders, Early Check-In, Real Wait Times Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reminder texts before appointments, an "I've arrived" early check-in that starts the appointment when the barber is free, and real wait estimates on every waiting ticket (including appointments that will be served first).

**Architecture:** All rules live in `SECURITY DEFINER` Postgres functions. A shared `wait_walk` computes estimates per barber line; `recalculate_positions` and a new every-minute tick keep them fresh. The tick also queues reminder notifications, which the existing `send-notifications` Edge Function sends. Conversion moves into a reusable `convert_appointment` so check-in can start an appointment early. The customer and staff apps get small UI additions.

**Tech Stack:** Supabase Postgres (plpgsql, pg_cron), Deno Edge Function, Next.js 16 client components, next-intl, supabase-js, Vitest (DB tests against staging, unit tests), Playwright.

**Spec:** `Docs/superpowers/specs/2026-10-02-appointments-reminders-checkin-wait-design.md`

## Global Constraints

- Times are UTC (Ghana = UTC+0). App screens show `HH:MM` (existing `formatSlotTime`); reminder texts use 12-hour `2:30 PM`.
- Reminder windows (exact): day reminder `[D−1 18:00, D−1 21:00)` only if `created_at <= D−1 18:00`; hour reminder `[scheduled_start − 1h, scheduled_start)` only if `created_at <= scheduled_start − 1h`. One row per (appointment, type, slot).
- Reminder texts (exact): `Pixel Barber: Reminder, your appointment at {branch} is tomorrow at {time}.` and `Pixel Barber: Your appointment at {branch} is today at {time}, in about an hour.`
- Customer early check-in window: from `scheduled_start − 30 minutes`. Staff keep "any time on the slot's UTC day".
- "Free barber" = on today's schedule at the branch with `now()` inside the shift, skilled for the service, `status = 'available'`, and no tickets at that branch in `waiting`, `almost_turn`, `called`, `confirmed`, `in_service`, `grace_period`.
- Durations: barber's `barber_service_stats` average when `completed_count >= 5` (historical), else `coalesce(branch_services.duration_minutes_override, services.default_duration_minutes)`. Range: all historical → low = high; otherwise low = round(T × 0.8), high = round(T × 1.2).
- Error strings (exact, new): `too_early`. Reused: `not_found`, `too_late`, `branch_closed`, `not_today`, `not_allowed`, `already_converted`.
- Every new function: `security definer`, `set search_path = public, pg_temp`, explicit revoke/grant (customer/staff-callable → `authenticated`; tick/enqueue/refresh → `service_role` only; internal helpers revoked from `public, anon, authenticated`).
- Already-applied migrations are never edited. `packages/shared/src/database.types.ts` is hand-maintained and must match the SQL.
- Live SMS stays off on staging (`SMS_NOTIFICATIONS_LIVE` unset); the allowlist is set, so test texts end as `not_allowlisted`/`sms_disabled`, never `sent`.
- Tests run against live staging (`.env.local`); the live every-minute cron runs during tests (it converts due appointments, queues reminders and refreshes estimates). Heavy `beforeAll`/`afterAll` get explicit timeouts (`90000`). FK-safe cleanup: notifications pointing at appointments are deleted before the appointments.
- **Implementer subagents cannot push migrations, deploy functions, set secrets or run SQL against a live project.** After an implementer commits a migration, the controller pushes it to staging (`set -a && source supabase/.secrets/send-sms.env && set +a && npx supabase db push`); after Task 3 the controller also deploys `send-notifications` to staging. DB tests fail until then — report "ready for push" (and "ready for deploy" in Task 3).
- React lint: no synchronous `setState` in effect bodies (`react-hooks/set-state-in-effect`); no `Date.now()`/`new Date()` inside render or `useMemo` (`react-hooks/purity`) — compute inside effects/handlers. Tag async results with a request key.
- E2E: `.press('Enter')`, locators scoped to `page.locator('main')` (Next.js Dev Tools badge; the route announcer is `role="alert"`). Start both dev servers first. Each spec uses its own phone range.
- Watch for a corrupted em dash: after editing any file containing `—`, run `grep -n $'\xef\xbf\xbd' <file>` and fix any hit.
- Do not stage `apps/*/next-env.d.ts`, `graphify-out/`, `playwright-report/`, `test-results/`, `supabase/.secrets/`, untracked `Docs/superpowers/plans/2026-09-1*`. No AI-attribution lines in commits.

## Rulings made while planning

1. **Estimate-only updates don't bump `queue_tickets.version`.** `bump_ticket_version` (trigger) skips the bump when only `estimated_wait_low_min`, `estimated_wait_high_min` and `updated_at` changed. Otherwise the every-minute refresh would make customers' versioned Cancel writes conflict constantly.
2. **`enqueue_appointment_reminders(p_now timestamptz default now())`**: the clock is a parameter (service-role only), so the windows are testable at any time of day.
3. **One walk, two uses.** Internal `wait_walk(branch, barber)` returns a row per waiting ticket plus a final row with `ticket_id = null` (a newcomer at the end of the line). `refresh_wait_estimates` writes the ticket rows; `preview_wait_estimate` returns the null row.
4. **`preview_wait_estimate(p_branch_service_id, p_barber_id)` resolves "any available" itself:** a null barber means `find_eligible_barber`'s fallback. BookFlow passes `acceptFallback ? null : selectedBarberId`.
5. **Reminder slot comparison happens in TypeScript with `Date.parse`** (the payload slot is JSON text; the appointment slot is a timestamptz), so formatting differences can't make a current reminder look stale.
6. **`claim_sms_notifications` is dropped and recreated** (its return columns change); grants are reapplied.
7. **`convert_appointment` keeps `'staff'` as the fallback check-in method** for appointments checked in before the new column existed.
8. **Test cleanups route appointment deletes through fixture helpers** that first delete notifications pointing at those appointments (the live cron can queue reminders for any test appointment).
9. **The customer e2e covers the free-barber check-in and the wait estimates;** the busy-barber check-in is covered by DB tests (both paths in one browser journey would need a second branch).
10. **Existing tests that relied on staff check-in only marking "checked in"** set the fixture barbers to `busy` around the check-in, so they keep testing that path.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20261002090000_wait_estimates.sql` | version-bump exception, `expected_duration_min`, `wait_walk`, `refresh_wait_estimates`, `refresh_all_wait_estimates`, `preview_wait_estimate`, `recalculate_positions` refreshes |
| `supabase/migrations/20261002090100_appointment_reminders.sql` | reminder unique index, `enqueue_appointment_reminders`, `appointments_minute_tick`, cron re-point |
| `supabase/migrations/20261002090200_claim_reminder_notifications.sql` | `claim_sms_notifications` returns appointment columns |
| `supabase/migrations/20261002090300_appointment_early_check_in.sql` | `appointments.check_in_method`, `convert_appointment`, `activate_due_appointments` uses it, `free_barber_for_appointment`, `check_in_my_appointment`, `staff_check_in_appointment` returns uuid |
| `tests/db/fixtures/appointments.ts` | + `deleteAppointmentsByIds`, `deleteBranchAppointments`; cleanup uses them |
| `tests/db/wait-estimates.test.ts` | Task 1 |
| `tests/db/appointment-reminders.test.ts` | Task 2 |
| `tests/db/appointment-reminder-sending.test.ts` | Task 3 |
| `tests/db/appointment-early-check-in.test.ts` | Task 4 |
| `supabase/functions/_shared/notification-sms-core.ts`, `supabase/functions/send-notifications/index.ts`, `tests/unit/notification-sms-core.test.ts` | Reminder decisions and texts |
| `packages/shared/src/wait-time.ts`, `wait-time.test.ts`, `index.ts` | Removed (the SQL replaces it) |
| `packages/shared/src/database.types.ts` | New column and functions |
| `apps/customer/app/appointments/[id]/page.tsx`, `appointmentErrors.ts` (+ test), `apps/customer/messages/en.json`, `apps/customer/app/book/BookFlow.tsx` | "I've arrived"; Join Now estimate |
| `apps/staff/app/appointments/[id]/page.tsx`, `apps/staff/messages/en.json` | "Started early" after Check in |
| `e2e/appointment-early-check-in.spec.ts` | Customer journey |
| `e2e/appointments-staff.spec.ts`, `e2e/appointment-booking.spec.ts` | Updated for early start / reminder cleanup |

---

### Task 1: Real wait estimates in the database

**Files:**
- Create: `supabase/migrations/20261002090000_wait_estimates.sql`
- Modify: `tests/db/fixtures/appointments.ts`
- Modify: `tests/db/appointment-conversion.test.ts`, `tests/db/appointment-staff-booking.test.ts`, `tests/db/appointment-staff-manage.test.ts`, `e2e/appointment-booking.spec.ts` (appointment deletes)
- Create: `tests/db/wait-estimates.test.ts`
- Delete: `packages/shared/src/wait-time.ts`, `packages/shared/src/wait-time.test.ts`; Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/database.types.ts`

**Interfaces:**
- Produces (SQL): `expected_duration_min(p_barber_id uuid, p_branch_service_id uuid) returns table (minutes int, historical boolean)` (internal); `wait_walk(p_branch_id uuid, p_barber_id uuid) returns table (ticket_id uuid, low_min int, high_min int)` (internal); `refresh_wait_estimates(p_branch_id uuid, p_barber_id uuid) returns void` (service_role); `refresh_all_wait_estimates() returns void` (service_role); `preview_wait_estimate(p_branch_service_id uuid, p_barber_id uuid) returns table (low_min int, high_min int)` (authenticated). `recalculate_positions` now ends by calling `refresh_wait_estimates` when `p_barber_id` is not null.
- Produces (TS fixture): `deleteAppointmentsByIds(admin: Client, ids: string[]): Promise<void>`, `deleteBranchAppointments(admin: Client, branchIds: string[]): Promise<void>`.

- [ ] **Step 1: Add the appointment-delete helpers to the fixture**

In `tests/db/fixtures/appointments.ts`, add above `cleanupAppointmentFixture`:
```typescript
/** Deletes these appointments and the notifications pointing at them (the live cron may have
 * queued reminder texts for any appointment a test creates). Tickets must already be gone. */
export async function deleteAppointmentsByIds(admin: Client, ids: string[]) {
  if (ids.length === 0) return;
  const { error: notificationsError } = await admin
    .from('notifications')
    .delete()
    .in('related_appointment_id', ids);
  if (notificationsError) throw notificationsError;
  const { error } = await admin.from('appointments').delete().in('id', ids);
  if (error) throw error;
}

/** deleteAppointmentsByIds for every appointment at these branches. */
export async function deleteBranchAppointments(admin: Client, branchIds: string[]) {
  const { data, error } = await admin.from('appointments').select('id').in('branch_id', branchIds);
  if (error) throw error;
  await deleteAppointmentsByIds(
    admin,
    (data ?? []).map((a) => a.id),
  );
}
```
In `cleanupAppointmentFixture`, replace `await admin.from('appointments').delete().in('branch_id', branchIds);` with `await deleteBranchAppointments(admin, branchIds);`.

- [ ] **Step 2: Route every other test appointment delete through the helpers**

Run: `grep -rn "from('appointments')" tests/db e2e | grep "delete()"`
- In `tests/db/*.test.ts`: replace each `f.admin.from('appointments').delete().in('branch_id', X)` with `await deleteBranchAppointments(f.admin, X)` and each `f.admin.from('appointments').delete().eq('id', id)` with `await deleteAppointmentsByIds(f.admin, [id])`, adding the imports from `./fixtures/appointments`.
- In `e2e/appointment-booking.spec.ts` `finally`, before `await admin.from('appointments').delete().eq('customer_id', customer!.id);` add:
```typescript
    const { data: apptRows } = await admin
      .from('appointments')
      .select('id')
      .eq('customer_id', customer!.id);
    const apptIds = (apptRows ?? []).map((a) => a.id);
    if (apptIds.length) await admin.from('notifications').delete().in('related_appointment_id', apptIds);
```
(`e2e/appointments-staff.spec.ts` already deletes appointment notifications.)

- [ ] **Step 3: Write the failing wait-estimate tests**

Create `tests/db/wait-estimates.test.ts`:
```typescript
// tests/db/wait-estimates.test.ts
// @vitest-environment node
// Real wait estimates (part 3, Section 3) on barber B's line (no break): set durations widen ±20%,
// appointments due before a ticket's turn add their time ("any barber" ones shared across the
// skilled barbers on shift), the in-service remainder, historical durations, the Join Now preview,
// recalculate_positions refreshing, and estimate-only updates leaving `version` alone.
// The 30-minute service has no history unless a test inserts barber_service_stats.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  createAppointmentFixture,
  deleteBranchAppointments,
  type AppointmentFixture,
} from './fixtures/appointments';

let f: AppointmentFixture;
const barberB = () => f.barberB.barberId;

async function resetQueue() {
  const { data: tickets } = await f.admin
    .from('queue_tickets')
    .select('id')
    .eq('branch_id', f.branchId);
  const ids = (tickets ?? []).map((t) => t.id);
  if (ids.length > 0) {
    await f.admin.from('service_sessions').delete().in('ticket_id', ids);
    await f.admin.from('queue_events').delete().in('ticket_id', ids);
    await f.admin.from('notifications').delete().in('related_ticket_id', ids);
    await f.admin.from('queue_tickets').delete().in('id', ids);
  }
  await deleteBranchAppointments(f.admin, [f.branchId]);
  await f.admin.from('barber_service_stats').delete().eq('barber_id', barberB());
}

async function seedTicket(
  customerIdx: number,
  state: 'called' | 'almost_turn' | 'waiting' | 'in_service',
  position: number | null,
) {
  const { data, error } = await f.admin
    .from('queue_tickets')
    .insert({
      ticket_number: `PB-WE-${f.suffix}-${customerIdx}`,
      branch_id: f.branchId,
      customer_id: f.customers[customerIdx].customerId,
      branch_service_id: f.branchServiceId,
      assigned_barber_id: barberB(),
      state,
      position,
      created_by: 'customer',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

/** c0 called (position 1), c1 almost_turn (2), c2 waiting (3), all on barber B. */
async function seedLine() {
  await seedTicket(0, 'called', 1);
  const t1 = await seedTicket(1, 'almost_turn', 2);
  const t2 = await seedTicket(2, 'waiting', 3);
  return { t1, t2 };
}

async function appointmentIn(minutes: number, barberId: string | null) {
  const start = new Date(Date.now() + minutes * 60_000);
  const { error } = await f.admin.from('appointments').insert({
    customer_id: f.customers[3].customerId,
    branch_id: f.branchId,
    branch_service_id: f.branchServiceId,
    preferred_barber_id: barberId,
    scheduled_start: start.toISOString(),
    scheduled_end: new Date(start.getTime() + 30 * 60_000).toISOString(),
    status: 'scheduled',
    created_by: 'customer',
  });
  if (error) throw error;
}

async function refresh() {
  const { error } = await f.admin.rpc('refresh_wait_estimates', {
    p_branch_id: f.branchId,
    p_barber_id: barberB(),
  });
  if (error) throw error;
}

async function estimate(id: string) {
  const { data, error } = await f.admin
    .from('queue_tickets')
    .select('estimated_wait_low_min, estimated_wait_high_min, version')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

beforeAll(async () => {
  f = await createAppointmentFixture();
}, 90000);

beforeEach(async () => {
  await resetQueue();
});

afterAll(async () => {
  await resetQueue();
  await cleanupAppointmentFixture(f);
}, 90000);

describe('refresh_wait_estimates', () => {
  it('adds up the line with set durations widened ±20%', async () => {
    const { t1, t2 } = await seedLine();
    await refresh();
    expect(await estimate(t1)).toMatchObject({ estimated_wait_low_min: 24, estimated_wait_high_min: 36 });
    expect(await estimate(t2)).toMatchObject({ estimated_wait_low_min: 48, estimated_wait_high_min: 72 });
  });

  it("counts an appointment due before a ticket's turn, but not one due after", async () => {
    const { t1, t2 } = await seedLine();
    await appointmentIn(45, barberB());
    await refresh();
    // t1's turn is 30 min away (before the appointment); t2's is 60 min away (after it).
    expect(await estimate(t1)).toMatchObject({ estimated_wait_low_min: 24, estimated_wait_high_min: 36 });
    expect(await estimate(t2)).toMatchObject({ estimated_wait_low_min: 72, estimated_wait_high_min: 108 });
  });

  it('ignores an appointment due after everyone in line', async () => {
    const { t2 } = await seedLine();
    await appointmentIn(180, barberB());
    await refresh();
    expect(await estimate(t2)).toMatchObject({ estimated_wait_low_min: 48, estimated_wait_high_min: 72 });
  });

  it('shares an "any barber" appointment across the skilled barbers on shift', async () => {
    const { t2 } = await seedLine();
    await appointmentIn(45, null);
    await refresh();
    // Barbers A and B are both on shift: 30 / 2 = 15 extra minutes → T = 75.
    expect(await estimate(t2)).toMatchObject({ estimated_wait_low_min: 60, estimated_wait_high_min: 90 });
  });

  it('starts from what is left of the haircut in progress', async () => {
    const serving = await seedTicket(0, 'in_service', null);
    const { error } = await f.admin.from('service_sessions').insert({
      ticket_id: serving,
      barber_id: barberB(),
      started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    if (error) throw error;
    const t1 = await seedTicket(1, 'waiting', 1);
    await refresh();
    // 30 − 10 = 20 minutes left → 16–24.
    expect(await estimate(t1)).toMatchObject({ estimated_wait_low_min: 16, estimated_wait_high_min: 24 });
  });

  it("uses the barber's own average once they have 5 completed services, exactly", async () => {
    const { error } = await f.admin.from('barber_service_stats').insert({
      barber_id: barberB(),
      service_id: f.serviceId,
      completed_count: 5,
      avg_duration_seconds: 1200,
    });
    if (error) throw error;
    const { t1, t2 } = await seedLine();
    await refresh();
    expect(await estimate(t1)).toMatchObject({ estimated_wait_low_min: 20, estimated_wait_high_min: 20 });
    expect(await estimate(t2)).toMatchObject({ estimated_wait_low_min: 40, estimated_wait_high_min: 40 });
  });

  it('does not bump the ticket version when only the estimate changes', async () => {
    const { t2 } = await seedLine();
    await refresh();
    const before = await estimate(t2);
    await appointmentIn(45, barberB());
    await refresh();
    const after = await estimate(t2);
    expect(after.estimated_wait_low_min).toBe(72);
    expect(after.version).toBe(before.version);
  });

  it('is refreshed by recalculate_positions', async () => {
    const { t1 } = await seedLine();
    const { error } = await f.admin.rpc('recalculate_positions', {
      p_branch_id: f.branchId,
      p_barber_id: barberB(),
    });
    if (error) throw error;
    expect(await estimate(t1)).toMatchObject({ estimated_wait_low_min: 24, estimated_wait_high_min: 36 });
  });
});

describe('preview_wait_estimate', () => {
  it("gives a newcomer's wait at the end of the chosen barber's line", async () => {
    await seedLine();
    await appointmentIn(45, barberB());
    const { data, error } = await f.customers[3].client.rpc('preview_wait_estimate', {
      p_branch_service_id: f.branchServiceId,
      p_barber_id: barberB(),
    });
    expect(error).toBeNull();
    // 30 (called) + 30 + 30 (line) + 30 (appointment due at 45 min) = 120 → 96–144.
    expect(data).toEqual([{ low_min: 96, high_min: 144 }]);
  });

  it('uses the next available barber when none is chosen', async () => {
    await seedLine();
    const { data, error } = await f.customers[3].client.rpc('preview_wait_estimate', {
      p_branch_service_id: f.branchServiceId,
      p_barber_id: null,
    });
    expect(error).toBeNull();
    // Barber A has nobody in line.
    expect(data).toEqual([{ low_min: 0, high_min: 0 }]);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run tests/db/wait-estimates.test.ts`
Expected: FAIL (`refresh_wait_estimates` / `preview_wait_estimate` not found).

- [ ] **Step 5: Write the migration**

Create `supabase/migrations/20261002090000_wait_estimates.sql`:
```sql
-- Appointments part 3, Section 3 (Docs/superpowers/specs/2026-10-02-appointments-reminders-checkin-wait-design.md):
-- real wait estimates on waiting tickets, counting appointments that will be served first.

-- Estimate refreshes run every minute and are not a change a customer's versioned write could
-- conflict with, so an update touching only the estimate (and updated_at) keeps the version.
create or replace function bump_ticket_version() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (to_jsonb(new) - array['estimated_wait_low_min', 'estimated_wait_high_min', 'updated_at', 'version'])
     = (to_jsonb(old) - array['estimated_wait_low_min', 'estimated_wait_high_min', 'updated_at', 'version']) then
    return new;
  end if;
  new.version := old.version + 1;
  return new;
end;
$$;

-- Expected minutes for one barber doing one branch service: their own average once they have 5
-- completed services of it (historical), otherwise the service's set length.
create or replace function expected_duration_min(p_barber_id uuid, p_branch_service_id uuid)
returns table (minutes int, historical boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    case
      when st.completed_count >= 5 and st.avg_duration_seconds is not null
        then round(st.avg_duration_seconds / 60.0)::int
      else coalesce(bs.duration_minutes_override, s.default_duration_minutes)::int
    end,
    coalesce(st.completed_count >= 5 and st.avg_duration_seconds is not null, false)
  from branch_services bs
  join services s on s.id = bs.service_id
  left join barber_service_stats st on st.barber_id = p_barber_id and st.service_id = bs.service_id
  where bs.id = p_branch_service_id;
$$;

revoke execute on function expected_duration_min(uuid, uuid) from public, anon, authenticated;

-- One barber's line, in order: a row per waiting ticket with its estimate, then one row with a null
-- ticket_id -- the estimate for a newcomer joining the end of the line.
create or replace function wait_walk(p_branch_id uuid, p_barber_id uuid)
returns table (ticket_id uuid, low_min int, high_min int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_t numeric := 0;            -- minutes from now until the chair is free for the next person
  v_guess boolean := false;    -- whether any set-length (non-historical) duration was counted
  v_dur record;
  v_tk record;
  v_appt record;
  v_counted uuid[] := '{}';
  v_share bigint;
begin
  -- The chair: what is left of the haircut in progress, plus anyone already called.
  for v_tk in
    select qt.state, qt.branch_service_id, ss.started_at
    from queue_tickets qt
    left join service_sessions ss on ss.ticket_id = qt.id
    where qt.branch_id = p_branch_id
      and qt.assigned_barber_id = p_barber_id
      and qt.state in ('called', 'confirmed', 'grace_period', 'in_service')
  loop
    select * into v_dur from expected_duration_min(p_barber_id, v_tk.branch_service_id);
    if v_tk.state = 'in_service' and v_tk.started_at is not null then
      v_t := v_t + greatest(0, v_dur.minutes - extract(epoch from (now() - v_tk.started_at)) / 60.0);
    else
      v_t := v_t + v_dur.minutes;
    end if;
    v_guess := v_guess or not v_dur.historical;
  end loop;

  for v_tk in
    select w.id, w.branch_service_id
    from (
      select qt.id, qt.branch_service_id, coalesce(qt.position, 2147483646) as ord, qt.created_at
      from queue_tickets qt
      where qt.branch_id = p_branch_id
        and qt.assigned_barber_id = p_barber_id
        and qt.state in ('waiting', 'almost_turn')
      union all
      select null::uuid, null::uuid, 2147483647, null::timestamptz
    ) w
    order by w.ord, w.created_at
  loop
    -- Appointments whose slot arrives before this person's turn are served first.
    loop
      select a.id, a.branch_service_id, a.preferred_barber_id, a.scheduled_start
        into v_appt
      from appointments a
      join branch_services abs_ on abs_.id = a.branch_service_id
      where a.branch_id = p_branch_id
        and a.status in ('scheduled', 'checked_in')
        and a.scheduled_start <= now() + make_interval(secs => (v_t * 60)::double precision)
        and not (a.id = any (v_counted))
        and (
          a.preferred_barber_id = p_barber_id
          or (
            a.preferred_barber_id is null
            and exists (
              select 1 from barber_skills sk
              where sk.barber_id = p_barber_id and sk.service_id = abs_.service_id
            )
          )
        )
      order by a.scheduled_start, a.id
      limit 1;
      exit when not found;

      select * into v_dur from expected_duration_min(p_barber_id, v_appt.branch_service_id);
      if v_appt.preferred_barber_id is null then
        -- "Any barber": shared across the skilled barbers on shift at the slot time.
        select greatest(1, count(*)) into v_share
        from barber_schedule sch
        join barber_skills sk on sk.barber_id = sch.barber_id
        join branch_services bs on bs.id = v_appt.branch_service_id and bs.service_id = sk.service_id
        where sch.branch_id = p_branch_id
          and sch.work_date = (v_appt.scheduled_start at time zone 'UTC')::date
          and (v_appt.scheduled_start at time zone 'UTC')::time between sch.shift_start and sch.shift_end;
        v_t := v_t + v_dur.minutes::numeric / v_share;
      else
        v_t := v_t + v_dur.minutes;
      end if;
      v_guess := v_guess or not v_dur.historical;
      v_counted := v_counted || v_appt.id;
    end loop;

    ticket_id := v_tk.id;
    if v_guess then
      low_min := round(v_t * 0.8);
      high_min := round(v_t * 1.2);
    else
      low_min := round(v_t);
      high_min := low_min;
    end if;
    return next;

    if v_tk.id is not null then
      select * into v_dur from expected_duration_min(p_barber_id, v_tk.branch_service_id);
      v_t := v_t + v_dur.minutes;
      v_guess := v_guess or not v_dur.historical;
    end if;
  end loop;
end;
$$;

revoke execute on function wait_walk(uuid, uuid) from public, anon, authenticated;

-- Writes estimates for one barber's waiting tickets, touching only rows whose numbers changed, and
-- clears any estimate left on that barber's tickets that are no longer waiting.
create or replace function refresh_wait_estimates(p_branch_id uuid, p_barber_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update queue_tickets qt
    set estimated_wait_low_min = w.low_min,
        estimated_wait_high_min = w.high_min
  from wait_walk(p_branch_id, p_barber_id) w
  where w.ticket_id = qt.id
    and (qt.estimated_wait_low_min is distinct from w.low_min
         or qt.estimated_wait_high_min is distinct from w.high_min);

  update queue_tickets
    set estimated_wait_low_min = null,
        estimated_wait_high_min = null
  where branch_id = p_branch_id
    and assigned_barber_id = p_barber_id
    and state not in ('waiting', 'almost_turn')
    and (estimated_wait_low_min is not null or estimated_wait_high_min is not null);
end;
$$;

revoke execute on function refresh_wait_estimates(uuid, uuid) from public, anon, authenticated;
grant execute on function refresh_wait_estimates(uuid, uuid) to service_role;

-- Every barber line with someone waiting (run every minute: time passing changes estimates).
create or replace function refresh_all_wait_estimates()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
begin
  for r in
    select distinct branch_id, assigned_barber_id
    from queue_tickets
    where state in ('waiting', 'almost_turn') and assigned_barber_id is not null
  loop
    perform refresh_wait_estimates(r.branch_id, r.assigned_barber_id);
  end loop;
end;
$$;

revoke execute on function refresh_all_wait_estimates() from public, anon, authenticated;
grant execute on function refresh_all_wait_estimates() to service_role;

-- Join Now preview: the wait a newcomer would get at the end of a barber's line. A null barber
-- means the next available one (find_eligible_barber's fallback). No row when nobody can serve.
create or replace function preview_wait_estimate(p_branch_service_id uuid, p_barber_id uuid)
returns table (low_min int, high_min int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_branch uuid;
  v_barber uuid := p_barber_id;
begin
  select branch_id into v_branch from branch_services where id = p_branch_service_id;
  if v_branch is null then
    return;
  end if;
  if v_barber is null then
    select fallback_barber_id into v_barber
    from find_eligible_barber(v_branch, p_branch_service_id, null);
  end if;
  if v_barber is null then
    return;
  end if;
  return query
    select w.low_min, w.high_min from wait_walk(v_branch, v_barber) w where w.ticket_id is null;
end;
$$;

revoke execute on function preview_wait_estimate(uuid, uuid) from public, anon;
grant execute on function preview_wait_estimate(uuid, uuid) to authenticated;

-- recalculate_positions: identical to 20261001090300_appointment_conversion.sql's definition except
-- it refreshes the barber's wait estimates at the end. create or replace keeps its grants.
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
    select qt.id, row_number() over (
      order by
        case
          when qt.state = 'called' then 0
          when qt.appointment_id is not null and qt.skipped_at is null then 1
          else 2
        end,
        case when qt.skipped_at is null then a.scheduled_start end nulls last,
        coalesce(qt.skipped_at, '-infinity'::timestamptz),
        qt.created_at
    ) as rn
    from queue_tickets qt
    left join appointments a on a.id = qt.appointment_id
    where qt.branch_id = p_branch_id
      and (
        (
          qt.state in ('waiting','almost_turn')
          and (p_barber_id is null or qt.assigned_barber_id = p_barber_id or (qt.assigned_barber_id is null and qt.is_pooled))
        )
        or (qt.state = 'called' and p_barber_id is not null and qt.assigned_barber_id = p_barber_id)
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

    perform refresh_wait_estimates(p_branch_id, p_barber_id);
  end if;

  perform set_config('pixelbarber.recalc_in_progress', 'false', true);
end;
$$;
```
Before committing, diff the `recalculate_positions` body against `20261001090300_appointment_conversion.sql` lines 6–82: the only difference must be the added `perform refresh_wait_estimates(...)` line.

- [ ] **Step 6: Remove the unused TypeScript estimate**

Delete `packages/shared/src/wait-time.ts` and `packages/shared/src/wait-time.test.ts`; remove the `export { calculateWaitEstimate } from './wait-time';` line (and any `wait-time` type exports) from `packages/shared/src/index.ts`. Run `grep -rn "wait-time\|calculateWaitEstimate" apps packages tests --include=*.ts --include=*.tsx | grep -v node_modules`. Expected: no output.

- [ ] **Step 7: Update the database types**

In `packages/shared/src/database.types.ts` `Functions`, add (alphabetical with the neighbours):
```typescript
      preview_wait_estimate: {
        Args: { p_branch_service_id: string; p_barber_id: string | null };
        Returns: { low_min: number; high_min: number }[];
      };
      refresh_all_wait_estimates: { Args: never; Returns: undefined };
      refresh_wait_estimates: {
        Args: { p_branch_id: string; p_barber_id: string };
        Returns: undefined;
      };
```
Run the repo typecheck (`npm run typecheck`, or `npx tsc --noEmit` in each workspace). Expected: no errors.

- [ ] **Step 8: Commit and hand over for the push**

```bash
git add supabase/migrations/20261002090000_wait_estimates.sql tests/db/wait-estimates.test.ts tests/db/fixtures/appointments.ts tests/db/appointment-conversion.test.ts tests/db/appointment-staff-booking.test.ts tests/db/appointment-staff-manage.test.ts e2e/appointment-booking.spec.ts packages/shared/src/index.ts packages/shared/src/database.types.ts
git rm packages/shared/src/wait-time.ts packages/shared/src/wait-time.test.ts
git commit -m "feat: real wait estimates computed in the database"
```
Report "ready for push". After the controller pushes, run `npx vitest run tests/db/wait-estimates.test.ts tests/db/appointment-conversion.test.ts tests/db/recalculate-positions-promotion.test.ts` — Expected: PASS.

---

### Task 2: Reminder queueing and the every-minute tick

**Files:**
- Create: `supabase/migrations/20261002090100_appointment_reminders.sql`
- Create: `tests/db/appointment-reminders.test.ts`
- Modify: `packages/shared/src/database.types.ts`

**Interfaces:**
- Consumes: `refresh_all_wait_estimates()` (Task 1); `deleteBranchAppointments` (Task 1 fixture); `activate_due_appointments()` (existing).
- Produces (SQL): `enqueue_appointment_reminders(p_now timestamptz default now()) returns integer` (service_role); `appointments_minute_tick() returns void` (service_role); the `activate-due-appointments` cron job runs `select appointments_minute_tick()`. Reminder rows: `notifications(recipient_type 'customer', recipient_id = customer, channel 'sms', notification_type 'appointment_reminder_day' | 'appointment_reminder_hour', related_appointment_id, payload {"slot": <scheduled_start>})`.

- [ ] **Step 1: Write the failing tests**

Create `tests/db/appointment-reminders.test.ts`:
```typescript
// tests/db/appointment-reminders.test.ts
// @vitest-environment node
// Reminder queueing (part 3, Section 1): the evening-before reminder (18:00–21:00 the day before,
// only for appointments that existed by 18:00), the 1-hour reminder (only when booked at least an
// hour ahead), nothing for cancelled appointments, one row per slot, fresh rows after a reschedule.
// The clock is passed in (p_now), so these run at any time of day.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  createAppointmentFixture,
  slotAt,
  type AppointmentFixture,
} from './fixtures/appointments';

let f: AppointmentFixture;

async function insertAppt(
  customerIdx: number,
  start: string,
  createdAt: string,
  status: 'scheduled' | 'cancelled' = 'scheduled',
) {
  const startMs = Date.parse(start);
  const { data, error } = await f.admin
    .from('appointments')
    .insert({
      customer_id: f.customers[customerIdx].customerId,
      branch_id: f.branchId,
      branch_service_id: f.branchServiceId,
      preferred_barber_id: f.barberB.barberId,
      scheduled_start: start,
      scheduled_end: new Date(startMs + 30 * 60_000).toISOString(),
      status,
      created_by: 'customer',
      created_at: createdAt,
      ...(status === 'cancelled'
        ? { cancel_reason: 'other' as const, cancelled_at: createdAt }
        : {}),
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

async function enqueue(now: string) {
  const { error } = await f.admin.rpc('enqueue_appointment_reminders', { p_now: now });
  if (error) throw error;
}

async function remindersFor(appointmentId: string) {
  const { data, error } = await f.admin
    .from('notifications')
    .select('notification_type, payload, recipient_id, recipient_type, channel, status')
    .eq('related_appointment_id', appointmentId)
    .order('created_at');
  if (error) throw error;
  return data ?? [];
}

beforeAll(async () => {
  f = await createAppointmentFixture();
}, 90000);

afterAll(async () => {
  await cleanupAppointmentFixture(f);
}, 90000);

describe('enqueue_appointment_reminders', () => {
  it('queues one evening-before reminder inside 18:00–21:00 the day before', async () => {
    const slot = slotAt(2, '10:00');
    const id = await insertAppt(0, slot, slotAt(1, '09:00'));
    await enqueue(slotAt(1, '18:30'));
    await enqueue(slotAt(1, '18:31'));
    const rows = await remindersFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      notification_type: 'appointment_reminder_day',
      recipient_type: 'customer',
      recipient_id: f.customers[0].customerId,
      channel: 'sms',
      status: 'pending',
    });
    expect(Date.parse((rows[0].payload as { slot: string }).slot)).toBe(Date.parse(slot));
  });

  it('skips the evening reminder for an appointment booked after 18:00', async () => {
    const id = await insertAppt(1, slotAt(2, '11:00'), slotAt(1, '19:00'));
    await enqueue(slotAt(1, '19:30'));
    expect(await remindersFor(id)).toHaveLength(0);
  });

  it('queues nothing outside the evening window', async () => {
    const id = await insertAppt(2, slotAt(2, '12:00'), slotAt(1, '09:00'));
    await enqueue(slotAt(1, '17:59'));
    await enqueue(slotAt(1, '21:30'));
    expect(await remindersFor(id)).toHaveLength(0);
  });

  it('queues the 1-hour reminder inside the last hour', async () => {
    const id = await insertAppt(3, slotAt(3, '10:00'), slotAt(1, '09:00'));
    await enqueue(slotAt(3, '09:30'));
    const rows = await remindersFor(id);
    expect(rows.map((r) => r.notification_type)).toEqual(['appointment_reminder_hour']);
  });

  it('skips the 1-hour reminder when booked less than an hour ahead', async () => {
    const id = await insertAppt(0, slotAt(3, '15:00'), slotAt(3, '14:20'));
    await enqueue(slotAt(3, '14:40'));
    expect(await remindersFor(id)).toHaveLength(0);
  });

  it('queues nothing for a cancelled appointment', async () => {
    const id = await insertAppt(1, slotAt(3, '16:00'), slotAt(1, '09:00'), 'cancelled');
    await enqueue(slotAt(2, '18:30'));
    await enqueue(slotAt(3, '15:30'));
    expect(await remindersFor(id)).toHaveLength(0);
  });

  it('queues fresh reminders for the new slot after a reschedule', async () => {
    const id = await insertAppt(2, slotAt(4, '10:00'), slotAt(1, '09:00'));
    await enqueue(slotAt(3, '18:30'));
    const newSlot = slotAt(5, '10:00');
    const { error } = await f.admin
      .from('appointments')
      .update({
        scheduled_start: newSlot,
        scheduled_end: new Date(Date.parse(newSlot) + 30 * 60_000).toISOString(),
      })
      .eq('id', id);
    if (error) throw error;
    await enqueue(slotAt(4, '18:30'));
    const rows = await remindersFor(id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => Date.parse((r.payload as { slot: string }).slot))).toEqual([
      Date.parse(slotAt(4, '10:00')),
      Date.parse(newSlot),
    ]);
  });
});

describe('appointments_minute_tick', () => {
  it('runs every step without error', async () => {
    const { error } = await f.admin.rpc('appointments_minute_tick');
    expect(error).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/db/appointment-reminders.test.ts`
Expected: FAIL (`enqueue_appointment_reminders` not found).

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261002090100_appointment_reminders.sql`:
```sql
-- Appointments part 3, Section 1 (Docs/superpowers/specs/2026-10-02-appointments-reminders-checkin-wait-design.md):
-- reminder texts are queued as notifications (sent by send-notifications), and the every-minute
-- appointments job becomes one tick: convert due appointments, queue reminders, refresh estimates.

-- One reminder of each type per appointment slot; a rescheduled appointment gets fresh ones.
create unique index notifications_one_reminder_per_slot
  on notifications (related_appointment_id, notification_type, (payload->>'slot'))
  where notification_type in ('appointment_reminder_day', 'appointment_reminder_hour');

create index if not exists idx_notifications_appointment on notifications (related_appointment_id);

-- p_now is the clock (a parameter so tests can run any time of day). Returns rows queued.
create or replace function enqueue_appointment_reminders(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_day integer;
  v_hour integer;
begin
  -- Evening before: 18:00-21:00 on the day before the slot's date, for appointments that already
  -- existed at 18:00.
  with candidates as (
    select a.id, a.customer_id, a.scheduled_start, a.created_at,
           (((a.scheduled_start at time zone 'UTC')::date - 1) + time '18:00') at time zone 'UTC' as evening
    from appointments a
    where a.status in ('scheduled', 'checked_in')
      and a.scheduled_start > p_now
      and a.scheduled_start <= p_now + interval '31 hours'
  )
  insert into notifications (recipient_type, recipient_id, channel, notification_type, related_appointment_id, payload)
  select 'customer', c.customer_id, 'sms', 'appointment_reminder_day', c.id,
         jsonb_build_object('slot', c.scheduled_start)
  from candidates c
  where p_now >= c.evening
    and p_now < c.evening + interval '3 hours'
    and c.created_at <= c.evening
  on conflict (related_appointment_id, notification_type, (payload->>'slot'))
    where notification_type in ('appointment_reminder_day', 'appointment_reminder_hour')
    do nothing;
  get diagnostics v_day = row_count;

  -- One hour before, for appointments booked at least an hour ahead.
  insert into notifications (recipient_type, recipient_id, channel, notification_type, related_appointment_id, payload)
  select 'customer', a.customer_id, 'sms', 'appointment_reminder_hour', a.id,
         jsonb_build_object('slot', a.scheduled_start)
  from appointments a
  where a.status in ('scheduled', 'checked_in')
    and p_now >= a.scheduled_start - interval '1 hour'
    and p_now < a.scheduled_start
    and a.created_at <= a.scheduled_start - interval '1 hour'
  on conflict (related_appointment_id, notification_type, (payload->>'slot'))
    where notification_type in ('appointment_reminder_day', 'appointment_reminder_hour')
    do nothing;
  get diagnostics v_hour = row_count;

  return v_day + v_hour;
end;
$$;

revoke execute on function enqueue_appointment_reminders(timestamptz) from public, anon, authenticated;
grant execute on function enqueue_appointment_reminders(timestamptz) to service_role;

-- The every-minute appointments job. Each step is isolated: one failing step logs a warning and
-- the others still run.
create or replace function appointments_minute_tick()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    perform activate_due_appointments();
  exception when others then
    raise warning 'appointments_minute_tick: activate_due_appointments failed: %', sqlerrm;
  end;
  begin
    perform enqueue_appointment_reminders();
  exception when others then
    raise warning 'appointments_minute_tick: enqueue_appointment_reminders failed: %', sqlerrm;
  end;
  begin
    perform refresh_all_wait_estimates();
  exception when others then
    raise warning 'appointments_minute_tick: refresh_all_wait_estimates failed: %', sqlerrm;
  end;
end;
$$;

revoke execute on function appointments_minute_tick() from public, anon, authenticated;
grant execute on function appointments_minute_tick() to service_role;

-- Same job name: cron.schedule replaces the existing schedule's command.
select cron.schedule('activate-due-appointments', '* * * * *', 'select appointments_minute_tick()');
```

- [ ] **Step 4: Update the database types**

In `packages/shared/src/database.types.ts` `Functions`, add:
```typescript
      appointments_minute_tick: { Args: never; Returns: undefined };
      enqueue_appointment_reminders: { Args: { p_now?: string }; Returns: number };
```
Run the typecheck. Expected: no errors.

- [ ] **Step 5: Commit and hand over for the push**

```bash
git add supabase/migrations/20261002090100_appointment_reminders.sql tests/db/appointment-reminders.test.ts packages/shared/src/database.types.ts
git commit -m "feat: queue appointment reminder texts from an every-minute tick"
```
Report "ready for push". After the push, run `npx vitest run tests/db/appointment-reminders.test.ts` — Expected: PASS.

---

### Task 3: Sending reminder texts

**Files:**
- Create: `supabase/migrations/20261002090200_claim_reminder_notifications.sql`
- Modify: `supabase/functions/_shared/notification-sms-core.ts`
- Modify: `supabase/functions/send-notifications/index.ts`
- Modify: `tests/unit/notification-sms-core.test.ts`
- Create: `tests/db/appointment-reminder-sending.test.ts`
- Modify: `packages/shared/src/database.types.ts`

**Interfaces:**
- Consumes: reminder rows from Task 2.
- Produces (SQL): `claim_sms_notifications(p_types text[], p_limit int)` returns its existing columns plus `appointment_id uuid, appointment_status appointment_status, appointment_slot timestamptz, payload_slot text`; `branch_name` falls back to the appointment's branch.
- Produces (TS): `SMS_NOTIFICATION_TYPES` includes `'appointment_reminder_day'` and `'appointment_reminder_hour'`; `ClaimedNotification` gains optional `appointment_id`, `appointment_status`, `appointment_slot`, `payload_slot` (`string | null`); `formatReminderTime(iso: string): string`; `buildNotificationSms(type, { branchName, ticketNumber, link, slot? })`.

- [ ] **Step 1: Write the failing unit tests**

In `tests/unit/notification-sms-core.test.ts`, add `formatReminderTime` to the import list and append:
```typescript
describe('appointment reminders', () => {
  const reminder = (overrides: Partial<ClaimedNotification> = {}) =>
    row({
      notification_type: 'appointment_reminder_hour',
      ticket_id: null,
      ticket_state: null,
      ticket_number: null,
      appointment_id: 'a1',
      appointment_status: 'scheduled',
      appointment_slot: '2026-09-25T14:30:00+00:00',
      payload_slot: '2026-09-25T14:30:00+00:00',
      ...overrides,
    });

  it('sends a reminder for a still-booked appointment at the same slot', () => {
    expect(decideNotification(reminder(), NOW, true)).toEqual({ action: 'send' });
  });

  it('sends for a checked-in appointment and for the evening-before type', () => {
    expect(decideNotification(reminder({ appointment_status: 'checked_in' }), NOW, true)).toEqual({
      action: 'send',
    });
    expect(
      decideNotification(reminder({ notification_type: 'appointment_reminder_day' }), NOW, true),
    ).toEqual({ action: 'send' });
  });

  it('treats the same instant written differently as the same slot', () => {
    expect(decideNotification(reminder({ payload_slot: '2026-09-25T14:30:00Z' }), NOW, true)).toEqual(
      { action: 'send' },
    );
  });

  it.each([
    ['cancelled', reminder({ appointment_status: 'cancelled' })],
    ['converted', reminder({ appointment_status: 'converted' })],
    ['moved to another slot', reminder({ payload_slot: '2026-09-25T13:30:00+00:00' })],
    [
      'gone',
      reminder({ appointment_id: null, appointment_status: null, appointment_slot: null }),
    ],
  ])('is stale when the appointment is %s', (_label, n) => {
    expect(decideNotification(n, NOW, true)).toEqual({ action: 'skip', reason: 'stale' });
  });

  it('is claimable', () => {
    expect(SMS_NOTIFICATION_TYPES).toContain('appointment_reminder_day');
    expect(SMS_NOTIFICATION_TYPES).toContain('appointment_reminder_hour');
  });
});

describe('formatReminderTime', () => {
  it.each([
    ['2026-09-25T14:30:00Z', '2:30 PM'],
    ['2026-09-25T09:00:00Z', '9:00 AM'],
    ['2026-09-25T12:00:00Z', '12:00 PM'],
    ['2026-09-25T00:05:00Z', '12:05 AM'],
  ])('%s → %s', (iso, text) => {
    expect(formatReminderTime(iso)).toBe(text);
  });
});

describe('reminder texts', () => {
  const input = { branchName: 'Osu Branch', ticketNumber: '', link: '', slot: '2026-09-26T14:30:00Z' };
  it('evening before', () => {
    expect(buildNotificationSms('appointment_reminder_day', input)).toBe(
      'Pixel Barber: Reminder, your appointment at Osu Branch is tomorrow at 2:30 PM.',
    );
  });
  it('one hour before', () => {
    expect(buildNotificationSms('appointment_reminder_hour', input)).toBe(
      'Pixel Barber: Your appointment at Osu Branch is today at 2:30 PM, in about an hour.',
    );
  });
});
```
If an existing assertion pins `SMS_NOTIFICATION_TYPES` to exactly three types, update it to the five types in this order: `['youre_next', 'your_turn', 'ticket_released', 'appointment_reminder_day', 'appointment_reminder_hour']`.

- [ ] **Step 2: Run the unit tests to verify they fail**

Run: `npx vitest run tests/unit/notification-sms-core.test.ts`
Expected: FAIL (`formatReminderTime` is not exported; reminder rows decided `stale`).

- [ ] **Step 3: Implement the core changes**

In `supabase/functions/_shared/notification-sms-core.ts`:

Replace the `SMS_NOTIFICATION_TYPES` line with:
```typescript
/** Appointment statuses in which a reminder still makes sense. */
const SENDABLE_APPOINTMENT_STATES: ReadonlySet<string> = new Set(['scheduled', 'checked_in']);
const REMINDER_TYPES: ReadonlySet<string> = new Set([
  'appointment_reminder_day',
  'appointment_reminder_hour',
]);
export const SMS_NOTIFICATION_TYPES = [
  'youre_next',
  'your_turn',
  'ticket_released',
  'appointment_reminder_day',
  'appointment_reminder_hour',
] as const;
```
Add to `ClaimedNotification` (after `branch_name`):
```typescript
  /** Reminder rows only: the appointment, its current status and slot, and the slot the reminder
   * was queued for (payload->>'slot'). */
  appointment_id?: string | null;
  appointment_status?: string | null;
  appointment_slot?: string | null;
  payload_slot?: string | null;
```
Add above `decideNotification`:
```typescript
/** A ticket notification whose ticket has moved on, or a reminder whose appointment is no longer
 * booked or has moved to another slot. */
function isStale(n: ClaimedNotification): boolean {
  if (REMINDER_TYPES.has(n.notification_type)) {
    if (!n.appointment_id || !n.appointment_status) return true;
    if (!SENDABLE_APPOINTMENT_STATES.has(n.appointment_status)) return true;
    if (!n.appointment_slot || !n.payload_slot) return true;
    return Date.parse(n.appointment_slot) !== Date.parse(n.payload_slot);
  }
  const sendableStates = SENDABLE_TICKET_STATES[n.notification_type];
  return !n.ticket_id || !n.ticket_state || !sendableStates?.has(n.ticket_state);
}
```
In `decideNotification`, replace
```typescript
  const sendableStates = SENDABLE_TICKET_STATES[n.notification_type];
  if (!n.ticket_id || !n.ticket_state || !sendableStates?.has(n.ticket_state)) {
    return { action: 'skip', reason: 'stale' };
  }
```
with
```typescript
  if (isStale(n)) return { action: 'skip', reason: 'stale' };
```
Add above `buildNotificationSms`:
```typescript
/** "2:30 PM" for an ISO timestamp, in UTC (Ghana time). */
export function formatReminderTime(iso: string): string {
  const d = new Date(iso);
  const hours = d.getUTCHours();
  const minutes = String(d.getUTCMinutes()).padStart(2, '0');
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${minutes} ${hours < 12 ? 'AM' : 'PM'}`;
}
```
Change `buildNotificationSms`'s input type to `{ branchName: string; ticketNumber: string; link: string; slot?: string }` and add the cases:
```typescript
    case 'appointment_reminder_day':
      return `Pixel Barber: Reminder, your appointment at ${input.branchName} is tomorrow at ${formatReminderTime(input.slot ?? '')}.`;
    case 'appointment_reminder_hour':
      return `Pixel Barber: Your appointment at ${input.branchName} is today at ${formatReminderTime(input.slot ?? '')}, in about an hour.`;
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `npx vitest run tests/unit/notification-sms-core.test.ts`
Expected: PASS.

- [ ] **Step 5: Pass reminder fields through the sender**

In `supabase/functions/send-notifications/index.ts`, replace the `buildNotificationSms(...)` call with:
```typescript
    const message = buildNotificationSms(n.notification_type as SmsNotificationType, {
      branchName: n.branch_name ?? 'Pixel Barber',
      ticketNumber: n.ticket_number ?? '',
      link: n.ticket_id ? ticketLink(customerAppUrl, n.ticket_id) : '',
      slot: n.appointment_slot ?? undefined,
    });
```
and extend the header comment's first sentence to: `Queue and appointment-reminder SMS sender (Docs/superpowers/specs/2026-09-25-queue-sms-notifications-design.md; reminders: Docs/superpowers/specs/2026-10-02-appointments-reminders-checkin-wait-design.md).`

- [ ] **Step 6: Write the claim migration**

Create `supabase/migrations/20261002090200_claim_reminder_notifications.sql`:
```sql
-- Appointments part 3, Section 1: claim_sms_notifications also returns what a reminder needs (the
-- appointment, its status and slot, and the slot the reminder was queued for). Its return columns
-- change, so it is dropped and recreated; otherwise identical to
-- 20260925150000_sms_dispatch_hardening.sql's definition (10-minute reclaim window).
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
  payload_slot text
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
         a.id, a.status, a.scheduled_start, c.payload->>'slot'
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

- [ ] **Step 7: Update the database types**

In `packages/shared/src/database.types.ts`, add to `claim_sms_notifications.Returns` (after `branch_name`):
```typescript
          appointment_id: string | null;
          appointment_status: Database['public']['Enums']['appointment_status'] | null;
          appointment_slot: string | null;
          payload_slot: string | null;
```

- [ ] **Step 8: Write the end-to-end sender test**

Create `tests/db/appointment-reminder-sending.test.ts`:
```typescript
// tests/db/appointment-reminder-sending.test.ts
// @vitest-environment node
// send-notifications (deployed, live sending OFF, allowlist set on this shared project) decides
// reminder rows: a current reminder ends 'not_allowlisted'/'sms_disabled' (never sent); one for a
// cancelled appointment or an old slot ends 'stale'. The live 30-second cron may process the rows
// too -- the outcome is identical, so the test polls until none are pending.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  createAppointmentFixture,
  slotAt,
  type AppointmentFixture,
} from './fixtures/appointments';
import { callFunction } from './fixtures/staff-invite';

let f: AppointmentFixture;
const serviceRoleKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function insertAppt(customerIdx: number, start: string) {
  const { data, error } = await f.admin
    .from('appointments')
    .insert({
      customer_id: f.customers[customerIdx].customerId,
      branch_id: f.branchId,
      branch_service_id: f.branchServiceId,
      preferred_barber_id: f.barberB.barberId,
      scheduled_start: start,
      scheduled_end: new Date(Date.parse(start) + 30 * 60_000).toISOString(),
      status: 'scheduled',
      created_by: 'customer',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

async function insertReminder(appointmentId: string, customerIdx: number, slot: string) {
  const { data, error } = await f.admin
    .from('notifications')
    .insert({
      recipient_type: 'customer',
      recipient_id: f.customers[customerIdx].customerId,
      channel: 'sms',
      notification_type: 'appointment_reminder_hour',
      related_appointment_id: appointmentId,
      payload: { slot },
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

beforeAll(async () => {
  f = await createAppointmentFixture();
  await f.admin
    .from('customers')
    .update({ sms_backup_enabled: true })
    .in(
      'id',
      f.customers.map((c) => c.customerId),
    );
}, 90000);

afterAll(async () => {
  await cleanupAppointmentFixture(f);
}, 90000);

describe('send-notifications with reminders', () => {
  it('decides current, cancelled and moved reminders', async () => {
    const currentSlot = slotAt(2, '10:00');
    const current = await insertAppt(0, currentSlot);
    const cancelled = await insertAppt(1, slotAt(2, '11:00'));
    const movedFrom = slotAt(2, '12:00');
    const moved = await insertAppt(2, movedFrom);

    const ids = {
      current: await insertReminder(current, 0, currentSlot),
      cancelled: await insertReminder(cancelled, 1, slotAt(2, '11:00')),
      moved: await insertReminder(moved, 2, movedFrom),
    };
    await f.admin
      .from('appointments')
      .update({ status: 'cancelled', cancel_reason: 'other', cancelled_at: new Date().toISOString() })
      .eq('id', cancelled);
    await f.admin
      .from('appointments')
      .update({ scheduled_start: slotAt(2, '13:00'), scheduled_end: slotAt(2, '13:30') })
      .eq('id', moved);

    const deadline = Date.now() + 60_000;
    let rows: { id: string; status: string; failed_reason: string | null }[] = [];
    while (Date.now() < deadline) {
      await callFunction('send-notifications', {}, serviceRoleKey());
      const { data } = await f.admin
        .from('notifications')
        .select('id, status, failed_reason')
        .in('id', Object.values(ids));
      rows = data ?? [];
      if (rows.length === 3 && rows.every((r) => r.status !== 'pending')) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const byId = (id: string) => rows.find((r) => r.id === id)!;
    expect(rows.every((r) => r.status === 'failed')).toBe(true);
    expect(['not_allowlisted', 'sms_disabled']).toContain(byId(ids.current).failed_reason);
    expect(byId(ids.cancelled).failed_reason).toBe('stale');
    expect(byId(ids.moved).failed_reason).toBe('stale');
  }, 90000);
});
```

- [ ] **Step 9: Commit and hand over for the push and deploy**

```bash
git add supabase/migrations/20261002090200_claim_reminder_notifications.sql supabase/functions/_shared/notification-sms-core.ts supabase/functions/send-notifications/index.ts tests/unit/notification-sms-core.test.ts tests/db/appointment-reminder-sending.test.ts packages/shared/src/database.types.ts
git commit -m "feat: send appointment reminder texts through send-notifications"
```
Report "ready for push and deploy" (`send-notifications` to staging). After both, run `npx vitest run tests/db/appointment-reminder-sending.test.ts tests/db/send-notifications.test.ts tests/unit/notification-sms-core.test.ts` — Expected: PASS.

---

### Task 4: Early check-in in the database

**Files:**
- Create: `supabase/migrations/20261002090300_appointment_early_check_in.sql`
- Create: `tests/db/appointment-early-check-in.test.ts`
- Modify: `tests/db/appointment-staff-manage.test.ts` (keep the "checked in" path)
- Modify: `packages/shared/src/database.types.ts`

**Interfaces:**
- Consumes: `deleteBranchAppointments`, `createStaffLogin`, `cleanupStaffLogin` (fixture); `recalculate_positions` (Task 1 version).
- Produces (SQL): column `appointments.check_in_method check_in_method`; `convert_appointment(p_appointment_id uuid, p_barber_id uuid default null) returns uuid` (internal); `free_barber_for_appointment(p_appointment_id uuid) returns uuid` (internal); `check_in_my_appointment(p_appointment_id uuid) returns uuid` (authenticated; ticket id when started now, else null); `staff_check_in_appointment(p_appointment_id uuid) returns uuid` (authenticated; same meaning).

- [ ] **Step 1: Write the failing tests**

Create `tests/db/appointment-early-check-in.test.ts`:
```typescript
// tests/db/appointment-early-check-in.test.ts
// @vitest-environment node
// Early check-in (part 3, Section 2): the customer's "I've arrived" (from 30 minutes before) and
// staff Check in start the appointment at once when the barber is free, otherwise mark it checked
// in; an existing ticket takes the appointment; the check-in method reaches the ticket, including
// at slot-time conversion. Appointments are inserted directly (customers can't book < 1 hour out).
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  cleanupStaffLogin,
  createAppointmentFixture,
  createStaffLogin,
  deleteBranchAppointments,
  type AppointmentFixture,
} from './fixtures/appointments';

const MIN = 60_000;
let f: AppointmentFixture;
let reception: Awaited<ReturnType<typeof createStaffLogin>>;

async function reset() {
  const { data: tickets } = await f.admin
    .from('queue_tickets')
    .select('id')
    .eq('branch_id', f.branchId);
  const ids = (tickets ?? []).map((t) => t.id);
  if (ids.length > 0) {
    await f.admin.from('queue_events').delete().in('ticket_id', ids);
    await f.admin.from('notifications').delete().in('related_ticket_id', ids);
    await f.admin.from('queue_tickets').delete().in('id', ids);
  }
  await deleteBranchAppointments(f.admin, [f.branchId]);
  await f.admin.from('branches').update({ is_temporarily_closed: false }).eq('id', f.branchId);
}

async function appt(customerIdx: number, barberId: string | null, minutesFromNow: number) {
  const start = new Date(Date.now() + minutesFromNow * MIN);
  const { data, error } = await f.admin
    .from('appointments')
    .insert({
      customer_id: f.customers[customerIdx].customerId,
      branch_id: f.branchId,
      branch_service_id: f.branchServiceId,
      preferred_barber_id: barberId,
      scheduled_start: start.toISOString(),
      scheduled_end: new Date(start.getTime() + 30 * MIN).toISOString(),
      status: 'scheduled',
      created_by: 'customer',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

/** Puts a waiting ticket on a barber's line, so they are not free. */
async function busy(customerIdx: number, barberId: string) {
  const { data, error } = await f.admin
    .from('queue_tickets')
    .insert({
      ticket_number: `PB-EC-${f.suffix}-${customerIdx}`,
      branch_id: f.branchId,
      customer_id: f.customers[customerIdx].customerId,
      branch_service_id: f.branchServiceId,
      assigned_barber_id: barberId,
      state: 'waiting',
      created_by: 'customer',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

async function appointmentRow(id: string) {
  const { data, error } = await f.admin.from('appointments').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

async function ticketForAppointment(id: string) {
  const { data, error } = await f.admin
    .from('queue_tickets')
    .select('*')
    .eq('appointment_id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Moves the appointment's slot to a minute ago and runs the slot-time conversion. */
async function reachSlot(id: string) {
  const start = new Date(Date.now() - MIN);
  await f.admin
    .from('appointments')
    .update({
      scheduled_start: start.toISOString(),
      scheduled_end: new Date(start.getTime() + 30 * MIN).toISOString(),
    })
    .eq('id', id);
  const { error } = await f.admin.rpc('activate_due_appointments');
  if (error) throw error;
}

const slotCrossesMidnight = (minutes: number) =>
  new Date(Date.now() + minutes * MIN).toISOString().slice(0, 10) !==
  new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  f = await createAppointmentFixture();
  reception = await createStaffLogin(f, 'rec', 'receptionist', f.branchId);
}, 90000);

beforeEach(async () => {
  await reset();
});

afterAll(async () => {
  await reset();
  await cleanupStaffLogin(f, reception);
  await cleanupAppointmentFixture(f);
}, 90000);

describe('check_in_my_appointment', () => {
  it('refuses before the 30-minute window', async () => {
    const id = await appt(0, f.barberB.barberId, 120);
    const { error } = await f.customers[0].client.rpc('check_in_my_appointment', {
      p_appointment_id: id,
    });
    expect(error?.message).toBe('too_early');
  });

  it("refuses someone else's appointment", async () => {
    const id = await appt(0, f.barberB.barberId, 20);
    const { error } = await f.customers[1].client.rpc('check_in_my_appointment', {
      p_appointment_id: id,
    });
    expect(error?.message).toBe('not_found');
  });

  it('refuses when the branch is closed today', async () => {
    const id = await appt(0, f.barberB.barberId, 20);
    await f.admin.from('branches').update({ is_temporarily_closed: true }).eq('id', f.branchId);
    const { error } = await f.customers[0].client.rpc('check_in_my_appointment', {
      p_appointment_id: id,
    });
    expect(error?.message).toBe('branch_closed');
  });

  it('starts the appointment now when the barber is free', async () => {
    const id = await appt(0, f.barberB.barberId, 20);
    const { data: ticketId, error } = await f.customers[0].client.rpc('check_in_my_appointment', {
      p_appointment_id: id,
    });
    expect(error).toBeNull();
    expect(ticketId).toBeTruthy();
    const ticket = await ticketForAppointment(id);
    expect(ticket).toMatchObject({
      id: ticketId,
      assigned_barber_id: f.barberB.barberId,
      state: 'called',
      check_in_method: 'app_tap',
    });
    expect(ticket!.checked_in_at).not.toBeNull();
    expect(await appointmentRow(id)).toMatchObject({
      status: 'converted',
      check_in_method: 'app_tap',
    });
    const again = await f.customers[0].client.rpc('check_in_my_appointment', {
      p_appointment_id: id,
    });
    expect(again.error?.message).toBe('too_late');
  });

  it('marks it checked in when the barber is busy, and the method reaches the ticket at the slot', async () => {
    await busy(1, f.barberB.barberId);
    const id = await appt(0, f.barberB.barberId, 25);
    const { data: ticketId, error } = await f.customers[0].client.rpc('check_in_my_appointment', {
      p_appointment_id: id,
    });
    expect(error).toBeNull();
    expect(ticketId).toBeNull();
    const row = await appointmentRow(id);
    expect(row).toMatchObject({ status: 'checked_in', check_in_method: 'app_tap' });
    expect(row.checked_in_at).not.toBeNull();
    expect(await ticketForAppointment(id)).toBeNull();

    await reachSlot(id);
    const ticket = await ticketForAppointment(id);
    expect(ticket).toMatchObject({ check_in_method: 'app_tap' });
    expect(ticket!.checked_in_at).not.toBeNull();
  });

  it('gives an "any barber" appointment to a free skilled barber', async () => {
    await busy(1, f.barberB.barberId);
    const id = await appt(0, null, 20);
    const { data: ticketId } = await f.customers[0].client.rpc('check_in_my_appointment', {
      p_appointment_id: id,
    });
    expect(ticketId).toBeTruthy();
    expect(await ticketForAppointment(id)).toMatchObject({
      assigned_barber_id: f.barberA.barberId,
    });
  });

  it("attaches to the customer's existing ticket at the branch", async () => {
    const existing = await busy(0, f.barberA.barberId);
    const id = await appt(0, f.barberB.barberId, 20);
    const { data: ticketId, error } = await f.customers[0].client.rpc('check_in_my_appointment', {
      p_appointment_id: id,
    });
    expect(error).toBeNull();
    expect(ticketId).toBe(existing);
    expect(await ticketForAppointment(id)).toMatchObject({
      id: existing,
      check_in_method: 'app_tap',
    });
    expect((await appointmentRow(id)).status).toBe('converted');
  });
});

describe('staff_check_in_appointment', () => {
  it('starts the appointment now when the barber is free', async (ctx) => {
    if (slotCrossesMidnight(20)) {
      ctx.skip();
      return;
    }
    const id = await appt(0, f.barberB.barberId, 20);
    const { data: ticketId, error } = await reception.client.rpc('staff_check_in_appointment', {
      p_appointment_id: id,
    });
    expect(error).toBeNull();
    expect(ticketId).toBeTruthy();
    expect(await ticketForAppointment(id)).toMatchObject({ id: ticketId, check_in_method: 'staff' });
  });

  it('marks it checked in when the barber is busy; the ticket records staff at the slot', async (ctx) => {
    if (slotCrossesMidnight(20)) {
      ctx.skip();
      return;
    }
    await busy(1, f.barberB.barberId);
    const id = await appt(0, f.barberB.barberId, 20);
    const { data: ticketId, error } = await reception.client.rpc('staff_check_in_appointment', {
      p_appointment_id: id,
    });
    expect(error).toBeNull();
    expect(ticketId).toBeNull();
    expect(await appointmentRow(id)).toMatchObject({ status: 'checked_in', check_in_method: 'staff' });
    await reachSlot(id);
    expect(await ticketForAppointment(id)).toMatchObject({ check_in_method: 'staff' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/db/appointment-early-check-in.test.ts`
Expected: FAIL (`check_in_my_appointment` not found).

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261002090300_appointment_early_check_in.sql`:
```sql
-- Appointments part 3, Section 2 (Docs/superpowers/specs/2026-10-02-appointments-reminders-checkin-wait-design.md):
-- early check-in. The customer's "I've arrived" (from 30 minutes before) and staff Check in start
-- the appointment at once when its barber is free; otherwise it is 'checked_in' and converts at
-- its slot. Conversion moves into convert_appointment so both paths share it.

alter table appointments add column check_in_method check_in_method;

-- Converts one appointment into a ticket (or attaches it to the customer's active ticket at the
-- branch). p_barber_id, when given, is used instead of find_eligible_barber's choice. Returns the
-- ticket id, or null when it could not convert (closed branch -> cancelled; nobody eligible or the
-- existing ticket already carries an appointment -> left as is). Behaviour otherwise identical to
-- the per-appointment body of 20261001090900_appointments_checked_in_conversion.sql, except the
-- ticket's check-in method comes from the appointment ('staff' for rows checked in before the
-- column existed).
create or replace function convert_appointment(p_appointment_id uuid, p_barber_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_appt appointments%rowtype;
  v_existing record;
  v_elig record;
  v_barber uuid;
  v_ticket_id uuid;
  v_rows integer;
  v_today date := (now() at time zone 'UTC')::date;
  v_method check_in_method;
begin
  select * into v_appt from appointments where id = p_appointment_id for update;
  if not found or v_appt.status not in ('scheduled', 'checked_in') then
    return null;
  end if;
  v_method := case when v_appt.status = 'checked_in'
                   then coalesce(v_appt.check_in_method, 'staff') end;

  -- Branch closed today: cancel, no ticket.
  if exists (select 1 from branch_closures c where c.branch_id = v_appt.branch_id and c.closure_date = v_today)
     or exists (select 1 from branches b where b.id = v_appt.branch_id and b.is_temporarily_closed) then
    update appointments
      set status = 'cancelled', cancel_reason = 'branch_closed', cancelled_at = now(),
          version = version + 1
      where id = v_appt.id;
    return null;
  end if;

  -- Already has an active ticket here (one per customer per branch): that ticket takes the
  -- appointment, and with it the appointment priority.
  select id, assigned_barber_id into v_existing
  from queue_tickets
  where customer_id = v_appt.customer_id
    and branch_id = v_appt.branch_id
    and state not in ('completed','cancelled','no_show')
  limit 1;
  if found then
    update queue_tickets set appointment_id = v_appt.id
      where id = v_existing.id and appointment_id is null;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      return null;
    end if;
    if v_method is not null then
      update queue_tickets
        set checked_in_at = coalesce(checked_in_at, v_appt.checked_in_at),
            check_in_method = coalesce(check_in_method, v_method)
        where id = v_existing.id;
    end if;
    insert into queue_events (ticket_id, event_type, actor_type, after_state)
      values (v_existing.id, 'appointment_attached', 'system',
              jsonb_build_object('appointment_id', v_appt.id));
    update appointments set status = 'converted', version = version + 1 where id = v_appt.id;
    if v_existing.assigned_barber_id is not null then
      perform recalculate_positions(v_appt.branch_id, v_existing.assigned_barber_id);
    end if;
    return v_existing.id;
  end if;

  if p_barber_id is not null then
    v_barber := p_barber_id;
  else
    select * into v_elig
    from find_eligible_barber(v_appt.branch_id, v_appt.branch_service_id, v_appt.preferred_barber_id);
    if v_appt.preferred_barber_id is not null and v_elig.preferred_eligible then
      v_barber := v_appt.preferred_barber_id;
    else
      v_barber := v_elig.fallback_barber_id;
    end if;
  end if;
  if v_barber is null then
    return null;
  end if;

  insert into queue_tickets (
    ticket_number, branch_id, customer_id, branch_service_id, preferred_barber_id,
    assigned_barber_id, is_pooled, appointment_id, state, created_by,
    checked_in_at, check_in_method
  ) values (
    next_ticket_number(v_appt.branch_id), v_appt.branch_id, v_appt.customer_id,
    v_appt.branch_service_id, v_appt.preferred_barber_id,
    v_barber, false, v_appt.id, 'waiting', 'appointment_conversion',
    case when v_method is not null then v_appt.checked_in_at end,
    v_method
  )
  returning id into v_ticket_id;

  insert into queue_events (ticket_id, event_type, actor_type, after_state)
    values (v_ticket_id, 'created', 'system',
            jsonb_build_object('state', 'waiting', 'appointment_id', v_appt.id));

  update appointments set status = 'converted', version = version + 1 where id = v_appt.id;

  perform recalculate_positions(v_appt.branch_id, v_barber);
  return v_ticket_id;
end;
$$;

revoke execute on function convert_appointment(uuid, uuid) from public, anon, authenticated;

-- Slot-time conversion: expire slots already over, convert the rest.
create or replace function activate_due_appointments() returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_appt appointments%rowtype;
  v_count integer := 0;
begin
  for v_appt in
    select * from appointments
    where status in ('scheduled', 'checked_in') and scheduled_start <= now()
    order by scheduled_start
    for update skip locked
  loop
    begin
      -- Slot already over (also bounds any backlog after a cron outage): expire it.
      if v_appt.scheduled_end < now() then
        update appointments
          set status = 'cancelled', cancel_reason = 'other', cancelled_at = now(),
              version = version + 1
          where id = v_appt.id;
        continue;
      end if;
      if convert_appointment(v_appt.id) is not null then
        v_count := v_count + 1;
      end if;
    exception when others then
      raise warning 'activate_due_appointments: appointment % failed: %', v_appt.id, sqlerrm;
    end;
  end loop;
  return v_count;
end;
$$;

revoke execute on function activate_due_appointments() from public, anon, authenticated;
grant execute on function activate_due_appointments() to service_role;

-- A barber who could take this appointment right now with nobody waiting: on today's schedule at
-- the branch inside the shift, skilled, 'available', and with no active tickets there. The
-- preferred barber only, when there is one; for "any barber", the first by id. Null when none.
create or replace function free_barber_for_appointment(p_appointment_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select b.id
  from appointments a
  join branch_services bs on bs.id = a.branch_service_id
  join barbers b on (a.preferred_barber_id is null or b.id = a.preferred_barber_id)
  join barber_skills sk on sk.barber_id = b.id and sk.service_id = bs.service_id
  join barber_schedule sch on sch.barber_id = b.id
    and sch.work_date = (now() at time zone 'UTC')::date
    and sch.branch_id = a.branch_id
    and (now() at time zone 'UTC')::time between sch.shift_start and sch.shift_end
  where a.id = p_appointment_id
    and b.status = 'available'
    and not exists (
      select 1 from queue_tickets qt
      where qt.assigned_barber_id = b.id
        and qt.branch_id = a.branch_id
        and qt.state in ('waiting', 'almost_turn', 'called', 'confirmed', 'in_service', 'grace_period')
    )
  order by b.id
  limit 1;
$$;

revoke execute on function free_barber_for_appointment(uuid) from public, anon, authenticated;

-- The customer's "I've arrived". Returns the ticket id when the appointment started now, else null.
create or replace function check_in_my_appointment(p_appointment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer_id uuid;
  v_appt appointments%rowtype;
  v_today date := (now() at time zone 'UTC')::date;
  v_barber uuid;
begin
  select id into v_customer_id from customers where auth_user_id = auth.uid();
  select * into v_appt from appointments
  where id = p_appointment_id and customer_id = v_customer_id
  for update;
  if not found then
    raise exception 'not_found';
  end if;
  if v_appt.status <> 'scheduled' then
    raise exception 'too_late';
  end if;
  if now() < v_appt.scheduled_start - interval '30 minutes' then
    raise exception 'too_early';
  end if;
  if exists (select 1 from branch_closures c where c.branch_id = v_appt.branch_id and c.closure_date = v_today)
     or exists (select 1 from branches b where b.id = v_appt.branch_id and b.is_temporarily_closed) then
    raise exception 'branch_closed';
  end if;

  update appointments
    set status = 'checked_in', checked_in_at = now(), check_in_method = 'app_tap',
        version = version + 1
    where id = p_appointment_id;

  v_barber := free_barber_for_appointment(p_appointment_id);
  if v_barber is null then
    return null;
  end if;
  return convert_appointment(p_appointment_id, v_barber);
end;
$$;

revoke execute on function check_in_my_appointment(uuid) from public, anon;
grant execute on function check_in_my_appointment(uuid) to authenticated;

-- Staff Check in: same checks as 20261001091000_appointments_staff_final_fixes.sql, now recording
-- the method and starting the appointment at once when the barber is free. Returns the ticket id
-- when it started now, else null (the return type changes, so drop and recreate).
drop function staff_check_in_appointment(uuid);

create function staff_check_in_appointment(p_appointment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_appt appointments%rowtype;
  v_barber uuid;
begin
  v_appt := staff_lock_appointment(p_appointment_id);
  if v_appt.status <> 'scheduled' then
    raise exception 'too_late';
  end if;
  if (v_appt.scheduled_start at time zone 'UTC')::date <> (now() at time zone 'UTC')::date then
    raise exception 'not_today';
  end if;
  update appointments
    set status = 'checked_in', checked_in_at = now(), check_in_method = 'staff',
        version = version + 1
    where id = p_appointment_id;

  v_barber := free_barber_for_appointment(p_appointment_id);
  if v_barber is null then
    return null;
  end if;
  return convert_appointment(p_appointment_id, v_barber);
end;
$$;

revoke execute on function staff_check_in_appointment(uuid) from public, anon;
grant execute on function staff_check_in_appointment(uuid) to authenticated;
```

- [ ] **Step 4: Keep the existing staff check-in test on the "checked in" path**

In `tests/db/appointment-staff-manage.test.ts`, test `"checks in today's appointment, and rescheduling returns it to scheduled"`: right after the `ctx.skip()` guard, add
```typescript
    // Both barbers busy, so Check in only marks arrival (a free barber would start it at once).
    const barberIds = [f.barberA.barberId, f.barberB.barberId];
    await f.admin.from('barbers').update({ status: 'busy' }).in('id', barberIds);
    try {
```
and close it after the final `expect(row!.checked_in_at).toBeNull();` with
```typescript
    } finally {
      await f.admin.from('barbers').update({ status: 'available' }).in('id', barberIds);
    }
```
(re-indent the body). Also assert the method: after `expect(after!.checked_in_at).not.toBeNull();` add `expect(after!.check_in_method).toBe('staff');`.

- [ ] **Step 5: Update the database types**

In `packages/shared/src/database.types.ts`:
- `appointments` `Row`: add `check_in_method: Database['public']['Enums']['check_in_method'] | null;`; `Insert` and `Update`: add `check_in_method?: Database['public']['Enums']['check_in_method'] | null;`.
- `Functions`: add `check_in_my_appointment: { Args: { p_appointment_id: string }; Returns: string | null };` and change `staff_check_in_appointment` to `{ Args: { p_appointment_id: string }; Returns: string | null }`.
Run the typecheck. Expected: no errors (the staff detail page ignores the returned value until Task 6).

- [ ] **Step 6: Commit and hand over for the push**

```bash
git add supabase/migrations/20261002090300_appointment_early_check_in.sql tests/db/appointment-early-check-in.test.ts tests/db/appointment-staff-manage.test.ts packages/shared/src/database.types.ts
git commit -m "feat: early check-in starts appointments when the barber is free"
```
Report "ready for push". After the push, run `npx vitest run tests/db/appointment-early-check-in.test.ts tests/db/appointment-staff-manage.test.ts tests/db/appointment-conversion.test.ts` — Expected: PASS.

---

### Task 5: Customer screens — "I've arrived" and the Join Now estimate

**Files:**
- Modify: `apps/customer/app/appointments/appointmentErrors.ts`, `apps/customer/app/appointments/appointmentErrors.test.ts`
- Modify: `apps/customer/messages/en.json`
- Modify: `apps/customer/app/appointments/[id]/page.tsx`
- Modify: `apps/customer/app/book/BookFlow.tsx`
- Create: `e2e/appointment-early-check-in.spec.ts`

**Interfaces:**
- Consumes: `check_in_my_appointment` (Task 4), `preview_wait_estimate` (Task 1), ticket estimates (Task 1).
- Produces: mapper keys `tooEarly`, `notFound`; messages `Appointments.arrived`, `Appointments.tooEarly`, `Appointments.checkedInWait`, `Book.waitEstimate`, `Book.waitEstimateExact`.

- [ ] **Step 1: Write the failing mapper test cases**

In `apps/customer/app/appointments/appointmentErrors.test.ts`, add to the `it.each` table:
```typescript
    ['too_early', 'tooEarly'],
    ['not_found', 'notFound'],
```
Run: `npx vitest run apps/customer/app/appointments/appointmentErrors.test.ts` — Expected: FAIL (both map to `generic`).

- [ ] **Step 2: Extend the mapper**

In `appointmentErrors.ts`, add `| 'tooEarly' | 'notFound'` to `AppointmentErrorKey` and to `KEYS`: `too_early: 'tooEarly',` and `not_found: 'notFound',`. Re-run the test — Expected: PASS.

- [ ] **Step 3: Add the messages**

In `apps/customer/messages/en.json`, add to `Appointments`:
```json
    "arrived": "I've arrived",
    "tooEarly": "You can check in from 30 minutes before your appointment.",
    "checkedInWait": "You're checked in. We'll call you at {time}."
```
and to `Book`:
```json
    "waitEstimate": "Estimated wait: {low}–{high} min",
    "waitEstimateExact": "Estimated wait: {low} min"
```
(`Appointments.notFound` already exists.)

- [ ] **Step 4: Add "I've arrived" to the appointment page**

In `apps/customer/app/appointments/[id]/page.tsx`:
- Below `const CHANGE_CUTOFF_MS = 60 * 60 * 1000;` add `const ARRIVE_WINDOW_MS = 30 * 60 * 1000;`.
- Add `canArrive: boolean;` to `interface Loaded`.
- In `setLoaded({...})`, after `changeable: ...,` add:
```typescript
        canArrive:
          appointment.status === 'scheduled' &&
          Date.now() >= new Date(appointment.scheduled_start).getTime() - ARRIVE_WINDOW_MS,
```
- Destructure `canArrive` with the other fields.
- Add the handler next to `handleCancel`:
```typescript
  async function handleArrive() {
    setBusy(true);
    setError(null);
    const { data: ticketId, error: rpcError } = await supabase.rpc('check_in_my_appointment', {
      p_appointment_id: appointment.id,
    });
    setBusy(false);
    if (rpcError) {
      setError(t(appointmentErrorKey(rpcError.message)));
      setReloadKey((n) => n + 1);
      return;
    }
    if (ticketId) {
      router.push(`/tickets/${ticketId}`);
      return;
    }
    setReloadKey((n) => n + 1);
  }
```
- In the JSX, directly after the `statusLabel` paragraph:
```tsx
      {appointment.status === 'checked_in' && (
        <p>{t('checkedInWait', { time: formatSlotTime(appointment.scheduled_start) })}</p>
      )}
      {mode === 'view' && canArrive && (
        <button type="button" disabled={busy} onClick={handleArrive}>
          {t('arrived')}
        </button>
      )}
```

- [ ] **Step 5: Show the estimate on the Join Now review step**

In `apps/customer/app/book/BookFlow.tsx`:
- Change `import { useEffect, useState } from 'react';` to `import { useEffect, useMemo, useState } from 'react';` and `const supabase = createBrowserSupabaseClient();` to `const supabase = useMemo(() => createBrowserSupabaseClient(), []);`.
- Add state and the effect after the existing load effect:
```typescript
  const [estimate, setEstimate] = useState<{ key: string; low: number; high: number } | null>(
    null,
  );
  // The barber the new ticket would get: the chosen one, or the next available when the customer
  // picked "any" or accepted the fallback (preview_wait_estimate resolves null itself).
  const estimateBarberId = acceptFallback ? null : selectedBarberId;
  const estimateKey = `${selectedServiceId}:${estimateBarberId ?? 'any'}`;

  useEffect(() => {
    if (step !== 'review' || !selectedServiceId) return;
    let cancelled = false;
    supabase
      .rpc('preview_wait_estimate', {
        p_branch_service_id: selectedServiceId,
        p_barber_id: estimateBarberId,
      })
      .then(({ data, error: previewError }) => {
        if (cancelled || previewError) return;
        const row = data?.[0];
        if (row) setEstimate({ key: estimateKey, low: row.low_min, high: row.high_min });
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, step, selectedServiceId, estimateBarberId, estimateKey]);
```
- In the `step === 'review'` block, after `<p>{selectedBarberName ?? t('anyAvailable')}</p>`:
```tsx
          {estimate && estimate.key === estimateKey && (
            <p>
              {estimate.low === estimate.high
                ? t('waitEstimateExact', { low: estimate.low })
                : t('waitEstimate', { low: estimate.low, high: estimate.high })}
            </p>
          )}
```
Run the customer app's lint and typecheck. Expected: no errors.

- [ ] **Step 6: Write the customer e2e**

First pick a phone range no other spec uses: `grep -rn "+233554" e2e tests` must print nothing (if it does, use the first free `+23355N` and update the three phone constants below).

Create `e2e/appointment-early-check-in.spec.ts`:
```typescript
// e2e/appointment-early-check-in.spec.ts
// Part 3 customer journey: a walk-in sees a real wait estimate before and after joining a busy
// barber's line; an appointment customer taps "I've arrived" with a free barber and lands on their
// ticket, called. Brings its own branch (open all day), a 30-minute service and two barbers.
// Clicks use Enter and are scoped to <main> (Next.js dev mode's Dev Tools badge).
import { test, expect, type BrowserContext } from '@playwright/test';
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PASSWORD = 'Test-Password-123!';
const DAY = 24 * 60 * 60 * 1000;

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

test('wait estimates for a walk-in; "I\'ve arrived" starts an appointment early', async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  test.skip(!url || !serviceRoleKey, 'Supabase env vars not set');
  test.setTimeout(150_000);
  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const suffix = String(Date.now());
  // 0554… : distinct from the phone ranges other test files use.
  const walkerPhone = `+233554${suffix.slice(-5)}1`;
  const arriverPhone = `+233554${suffix.slice(-5)}2`;
  const sitterPhone = `+233554${suffix.slice(-5)}3`;
  const serviceName = `Early E2E Cut ${suffix}`;

  let service: { id: string } | null = null;
  let branch: { id: string } | null = null;
  let bs: { id: string } | null = null;
  const barbers: { authId: string; staffId: string; barberId: string }[] = [];
  const authIds: string[] = [];
  const customerIds: string[] = [];
  let arriverContext: BrowserContext | null = null;

  async function makeBarber(name: string) {
    const email = `early-e2e-${barbers.length}-${suffix}@test.pixelbarber.local`;
    const { data: auth } = await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    const { data: staff } = await admin
      .from('staff_users')
      .insert({ auth_user_id: auth.user!.id, name, email, role: 'barber', invite_status: 'accepted' })
      .select('id')
      .single();
    const { data: barber } = await admin
      .from('barbers')
      .insert({ staff_user_id: staff!.id, home_branch_id: branch!.id, status: 'available' })
      .select('id')
      .single();
    barbers.push({ authId: auth.user!.id, staffId: staff!.id, barberId: barber!.id });
    await admin.from('barber_skills').insert({ barber_id: barber!.id, service_id: service!.id });
    await admin.from('barber_schedule').delete().eq('barber_id', barber!.id);
    await admin.from('barber_schedule').insert(
      [0, 1].map((i) => ({
        barber_id: barber!.id,
        work_date: new Date(Date.now() + i * DAY).toISOString().slice(0, 10),
        branch_id: branch!.id,
        shift_start: '00:00:00',
        shift_end: '23:59:59',
      })),
    );
    return barber!.id as string;
  }

  async function makeCustomer(name: string, phone: string, withLogin: boolean) {
    let authUserId: string | null = null;
    if (withLogin) {
      const { data: auth } = await admin.auth.admin.createUser({
        phone,
        password: PASSWORD,
        phone_confirm: true,
      });
      authUserId = auth.user!.id;
      authIds.push(authUserId);
    }
    const { data: customer } = await admin
      .from('customers')
      .insert({ auth_user_id: authUserId, name, phone_e164: phone, avatar_key: 'avatar-1' })
      .select('id')
      .single();
    customerIds.push(customer!.id);
    return customer!.id as string;
  }

  try {
    const { data: business } = await admin.from('businesses').select('id').limit(1).single();
    service = (
      await admin
        .from('services')
        .insert({ business_id: business!.id, name: serviceName, default_duration_minutes: 30 })
        .select('id')
        .single()
    ).data;
    branch = (
      await admin
        .from('branches')
        .insert({
          business_id: business!.id,
          name: `Early E2E Branch ${suffix}`,
          branch_code: `EE${suffix.slice(-6)}`,
          address: 'Test',
          latitude: 5.6,
          longitude: -0.18,
        })
        .select('id')
        .single()
    ).data;
    await admin.from('branch_hours').insert(
      [0, 1, 2, 3, 4, 5, 6].map((day_of_week) => ({
        branch_id: branch!.id,
        day_of_week,
        opens_at: '00:00:00',
        closes_at: '23:59:59',
        is_closed: false,
      })),
    );
    bs = (
      await admin
        .from('branch_services')
        .insert({ branch_id: branch!.id, service_id: service!.id })
        .select('id')
        .single()
    ).data;
    const busyBarber = await makeBarber('Early E2E Busy');
    const freeBarber = await makeBarber('Early E2E Free');
    await makeCustomer('Early E2E Walker', walkerPhone, true);
    const arriver = await makeCustomer('Early E2E Arriver', arriverPhone, true);
    const sitter = await makeCustomer('Early E2E Sitter', sitterPhone, false);

    // Someone is already called to the busy barber's chair.
    await admin.from('queue_tickets').insert({
      ticket_number: `PB-EE-${suffix}`,
      branch_id: branch!.id,
      customer_id: sitter,
      branch_service_id: bs!.id,
      assigned_barber_id: busyBarber,
      state: 'called',
      position: 1,
      created_by: 'staff',
    });

    // --- 1. Walk-in: estimate before joining, then on the ticket ---
    const main = page.locator('main');
    await signInAs(context, baseURL, walkerPhone);
    await page.goto(`/book?branch=${branch!.id}`);
    await main.getByRole('button', { name: new RegExp(serviceName) }).press('Enter');
    await main.getByRole('button', { name: 'Early E2E Busy' }).press('Enter');
    await expect(main.getByText('Estimated wait: 24–36 min')).toBeVisible({ timeout: 15000 });
    await main.getByRole('button', { name: 'Join Now' }).press('Enter');
    await expect(page).toHaveURL(/\/tickets\/[0-9a-f-]{36}$/, { timeout: 15000 });
    await expect(main.getByText('Estimated wait: 24–36 min')).toBeVisible({ timeout: 70000 });

    // --- 2. Appointment customer arrives 20 minutes early; their barber is free ---
    const start = new Date(Date.now() + 20 * 60_000);
    const { data: appointment } = await admin
      .from('appointments')
      .insert({
        customer_id: arriver,
        branch_id: branch!.id,
        branch_service_id: bs!.id,
        preferred_barber_id: freeBarber,
        scheduled_start: start.toISOString(),
        scheduled_end: new Date(start.getTime() + 30 * 60_000).toISOString(),
        status: 'scheduled',
        created_by: 'customer',
      })
      .select('id')
      .single();
    arriverContext = await browser.newContext();
    await signInAs(arriverContext, baseURL, arriverPhone);
    const arriverPage = await arriverContext.newPage();
    await arriverPage.goto(`${baseURL ?? 'http://localhost:3000'}/appointments/${appointment!.id}`);
    const arriverMain = arriverPage.locator('main');
    await arriverMain.getByRole('button', { name: "I've arrived" }).press('Enter');
    await expect(arriverPage).toHaveURL(/\/tickets\/[0-9a-f-]{36}$/, { timeout: 15000 });
    await expect(arriverMain.getByText('Your turn — head to the barber now!')).toBeVisible({
      timeout: 15000,
    });
    const { data: converted } = await admin
      .from('appointments')
      .select('status')
      .eq('id', appointment!.id)
      .single();
    expect(converted!.status).toBe('converted');
  } finally {
    await arriverContext?.close();
    // FK-safe cleanup scoped to this test's rows; every failure is collected and thrown at the end.
    const failures: string[] = [];
    const check = (label: string, res: { error: { message: string } | null }) => {
      if (res.error) failures.push(`${label}: ${res.error.message}`);
    };
    if (branch) {
      const { data: tickets } = await admin.from('queue_tickets').select('id').eq('branch_id', branch.id);
      const ticketIds = (tickets ?? []).map((t) => t.id);
      const { data: appts } = await admin.from('appointments').select('id').eq('branch_id', branch.id);
      const apptIds = (appts ?? []).map((a) => a.id);
      if (ticketIds.length) {
        check('queue_events', await admin.from('queue_events').delete().in('ticket_id', ticketIds));
        check('notifications(ticket)', await admin.from('notifications').delete().in('related_ticket_id', ticketIds));
      }
      if (apptIds.length) {
        check('notifications(appointment)', await admin.from('notifications').delete().in('related_appointment_id', apptIds));
      }
      check('queue_tickets', await admin.from('queue_tickets').delete().eq('branch_id', branch.id));
      check('appointments', await admin.from('appointments').delete().eq('branch_id', branch.id));
      check('branch_ticket_counters', await admin.from('branch_ticket_counters').delete().eq('branch_id', branch.id));
    }
    for (const b of barbers) {
      check('barber_schedule', await admin.from('barber_schedule').delete().eq('barber_id', b.barberId));
      check('barber_skills', await admin.from('barber_skills').delete().eq('barber_id', b.barberId));
      check('staff_users', await admin.from('staff_users').delete().eq('id', b.staffId));
      await admin.auth.admin.deleteUser(b.authId);
    }
    if (customerIds.length) {
      check('customers', await admin.from('customers').delete().in('id', customerIds));
    }
    for (const id of authIds) await admin.auth.admin.deleteUser(id);
    if (bs) check('branch_services', await admin.from('branch_services').delete().eq('id', bs.id));
    if (branch) {
      check('branch_hours', await admin.from('branch_hours').delete().eq('branch_id', branch.id));
      check('branches', await admin.from('branches').delete().eq('id', branch.id));
    }
    if (service) check('services', await admin.from('services').delete().eq('id', service.id));
    if (failures.length) throw new Error(`Cleanup failed:\n${failures.join('\n')}`);
  }
});
```
Run `grep -n $'\xef\xbf\xbd' e2e/appointment-early-check-in.spec.ts apps/customer/messages/en.json` — Expected: no output.

- [ ] **Step 7: Run the e2e**

Start both dev servers (customer on 3000, staff on 3001), then run:
`npx playwright test e2e/appointment-early-check-in.spec.ts e2e/appointment-booking.spec.ts e2e/queue-join-now.spec.ts --reporter=line --workers=1`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add apps/customer/app/appointments/appointmentErrors.ts apps/customer/app/appointments/appointmentErrors.test.ts apps/customer/messages/en.json "apps/customer/app/appointments/[id]/page.tsx" apps/customer/app/book/BookFlow.tsx e2e/appointment-early-check-in.spec.ts
git commit -m "feat: customer I've arrived button and Join Now wait estimate"
```

---

### Task 6: Staff screen — "Started early" after Check in

**Files:**
- Modify: `apps/staff/app/appointments/[id]/page.tsx`
- Modify: `apps/staff/messages/en.json`
- Modify: `e2e/appointments-staff.spec.ts`

**Interfaces:**
- Consumes: `staff_check_in_appointment` returns `string | null` (Task 4).
- Produces: message `StaffAppointments.startedEarly`.

- [ ] **Step 1: Update the staff e2e to expect the early start (failing first)**

In `e2e/appointments-staff.spec.ts`, step 3 (`// --- 3. Check in ...`), replace the `if (todayWorks) { ... }` branch body with:
```typescript
      await main.getByRole('button', { name: 'Check in' }).press('Enter');
      // Nobody is in the barber's line, so the appointment starts at once.
      await expect(main.getByText('Started early — now in the queue.')).toBeVisible({
        timeout: 15000,
      });
      await expect(main.getByText('Status: In the queue')).toBeVisible({ timeout: 15000 });
```
and in step 7 change `status: todayWorks ? 'checked_in' : 'scheduled',` to `status: todayWorks ? 'converted' : 'scheduled',`.
Run `grep -n $'\xef\xbf\xbd' e2e/appointments-staff.spec.ts` — Expected: no output.

With both dev servers running: `npx playwright test e2e/appointments-staff.spec.ts --reporter=line --workers=1` — Expected: FAIL at "Started early" (text not present yet), unless the next full hour crosses UTC midnight (then the step is skipped).

- [ ] **Step 2: Add the message**

In `apps/staff/messages/en.json` `StaffAppointments`, add after `"inQueue"`: `"startedEarly": "Started early — now in the queue.",`

- [ ] **Step 3: Show it after Check in**

In `apps/staff/app/appointments/[id]/page.tsx`:
- Add state: `const [startedEarlyId, setStartedEarlyId] = useState<string | null>(null);`
- Add a handler after `run`:
```typescript
  async function checkIn(id: string) {
    setBusy(true);
    setActionError(undefined);
    const { data: ticketId, error } = await supabase.rpc('staff_check_in_appointment', {
      p_appointment_id: id,
    });
    setBusy(false);
    if (error) {
      setActionError(error.message);
      setReloadKey((k) => k + 1);
      return;
    }
    if (ticketId) setStartedEarlyId(id);
    resetMode();
    setReloadKey((k) => k + 1);
  }
```
- Replace the Check in button's `onClick={() => run(supabase.rpc('staff_check_in_appointment', { p_appointment_id: row.id }))}` with `onClick={() => checkIn(row.id)}`.
- In the `row.status === 'converted'` block, replace `<p>{t('inQueue')}</p>` with:
```tsx
          <p>{startedEarlyId === row.id ? t('startedEarly') : t('inQueue')}</p>
```
Run the staff app's lint and typecheck. Expected: no errors.

- [ ] **Step 4: Run the staff e2e to verify it passes**

`npx playwright test e2e/appointments-staff.spec.ts e2e/staff-logout.spec.ts --reporter=line --workers=1` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "apps/staff/app/appointments/[id]/page.tsx" apps/staff/messages/en.json e2e/appointments-staff.spec.ts
git commit -m "feat: staff detail shows when check-in started the appointment early"
```

---

## After all tasks (controller)

1. Confirm the cron command on staging: `select command from cron.job where jobname = 'activate-due-appointments';` → `select appointments_minute_tick()`; and that recent runs succeed (`cron.job_run_details`, last 3 minutes, no failures).
2. Full vitest suite; re-run rate-limited files in batches of 3.
3. E2E: `appointment-early-check-in`, `appointments-staff`, `appointment-booking`, `queue-join-now`, `no-show-cross-surface-journey`, `staff-logout`.
4. Final whole-branch review, one fix wave, scoped re-review.
5. **Ask the user before promoting:** production migrations 20261002090000–090300 (dry run first), then deploy `send-notifications` to production, then push to GitHub (the apps call the new functions).
