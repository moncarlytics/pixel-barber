# Appointments Part 1 — Customer Booking and Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Customers book, view, reschedule and cancel appointments; at the start time each appointment automatically becomes a queue ticket that is served next.

**Architecture:** All booking rules live in `SECURITY DEFINER` Postgres functions sharing one rule-checker (`appointment_slot_problem`), so listing, booking and rescheduling can never disagree and two customers can never take the same slot (advisory locks). A rewritten `activate-due-appointments` cron function converts due appointments into tickets; `recalculate_positions` gains an "appointments next" ordering rule; a trigger keeps the appointment status in step with its ticket. The customer app gets a Schedule path in the Book flow, an Upcoming list and an Appointment Detail page.

**Tech Stack:** Supabase Postgres (plpgsql, pg_cron), Next.js 16 client components, next-intl, supabase-js, Vitest (DB tests against staging), Playwright.

**Spec:** `Docs/superpowers/specs/2026-10-01-appointments-customer-booking-design.md`

## Global Constraints

- Booking rules: 30-minute slot grid; slot start at least **1 hour** from now; slot date at most **14 days** after today (UTC); cancel/reschedule only while `status = 'scheduled'` and more than **1 hour** before the start; one `scheduled` appointment per customer per calendar day.
- Times are UTC (Ghana is UTC+0, no DST); compare `branch_hours` / `barber_schedule` times against `(ts at time zone 'UTC')::time`.
- Error strings raised by the functions (the app matches on them exactly): `slot_taken`, `already_booked_that_day`, `branch_closed`, `too_soon`, `too_far_ahead`, `not_a_customer`, `service_unavailable`, `too_late`, `not_found`.
- Every new function: `security definer`, `set search_path = public, pg_temp`; `revoke execute ... from public, anon` (and from `authenticated` for internal ones); explicit grants.
- Queue order in `recalculate_positions`: called ticket → un-skipped appointment tickets by `scheduled_start` → existing order (`coalesce(skipped_at, '-infinity')`, `created_at`).
- Conversion happens when `scheduled_start <= now()` (not earlier).
- Already-applied migrations are never edited. `packages/shared/src/database.types.ts` is hand-maintained and must match the SQL.
- Tests run against the live staging project (`.env.local`). Any `beforeAll`/`afterAll` doing more than 1–2 DB operations gets an explicit timeout (`90000` for the appointment fixture). Cleanup is FK-safe.
- **Implementer subagents cannot push migrations, deploy, set secrets or run SQL against a live project.** After an implementer commits a migration, the controller pushes it to **staging only**: `set -a && source supabase/.secrets/send-sms.env && set +a && npx supabase db push`. DB tests are expected to fail until that push; the implementer reports "ready for push" and the controller runs the tests after pushing.
- Next.js dev mode: e2e clicks use `.press('Enter')` and locators scoped to `page.locator('main')` (the Dev Tools badge intercepts clicks and is itself a button; Next's route announcer is also `role="alert"`).
- Do not stage `apps/*/next-env.d.ts`, `graphify-out/`, `playwright-report/`, `test-results/`, `supabase/.secrets/`, or untracked `Docs/superpowers/plans/2026-09-1*` files. No AI-attribution lines in commits.

## Rulings on spec gaps (made while planning)

1. **"Any barber" conversions are assigned, not pooled.** Nothing in the app ever picks up a pooled (unassigned) ticket, so conversion assigns a barber exactly the way joining the queue does (`find_eligible_barber`'s fallback). Only if no barber is eligible at all does the ticket stay pooled (`is_pooled = true`, unassigned) for staff to handle. Recorded in the spec's Amendments (Task 3).
2. **A customer who already has an active ticket at that branch** (the unique index `one_active_ticket_per_customer_branch` allows only one) gets no second ticket: their existing ticket takes the appointment (`appointment_id` set, so it gains priority) and the appointment becomes `converted`.
3. **Skipped appointment tickets lose priority.** Priority applies only while `skipped_at is null`; otherwise Skip would put the ticket straight back at position 1 and re-call it forever.
4. **"Any barber" capacity** is counted per branch: a slot can take another "any barber" booking while the barbers working then (scheduled, active, not on break, not named on an overlapping appointment) outnumber the overlapping "any barber" bookings; a named booking must leave enough of them for the existing "any barber" bookings.
5. **A cancelled appointment ticket** (customer cancels the converted ticket) marks the appointment `cancelled` with the ticket's reason.
6. Barber names: customers can't read `staff_users`, and the Book flow already shows barbers without names. Upcoming/Detail show "your chosen barber" or "any available".

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20261001090000_cancel_reason_branch_closed.sql` | New enum value (own file: an enum value can't be used in the transaction that adds it) |
| `supabase/migrations/20261001090100_appointment_booking.sql` | `appointment_slot_problem`, `list_appointment_slots`, `book_appointment`; drop customer write policies |
| `supabase/migrations/20261001090200_appointment_cancel_reschedule.sql` | `cancel_appointment`, `reschedule_appointment` |
| `supabase/migrations/20261001090300_appointment_conversion.sql` | `activate_due_appointments`, cron job, `recalculate_positions` ordering, status-sync trigger |
| `tests/db/fixtures/appointments.ts` | Shared fixture: branch open all day, a 30-minute service, two barbers scheduled for 16 days, four signed-in customers |
| `tests/db/appointment-booking.test.ts` | Slot listing and booking rules |
| `tests/db/appointment-cancel-reschedule.test.ts` | Cancel and reschedule rules |
| `tests/db/appointment-conversion.test.ts` | Conversion, priority, status sync |
| `packages/shared/src/database.types.ts` | Hand-maintained types for the new functions and enum value |
| `apps/customer/app/appointments/appointmentErrors.ts` (+ `.test.ts`) | Maps function error strings to message keys |
| `apps/customer/app/appointments/SlotPicker.tsx` | Date & Time step (15 dates, open slots) — used by Book and by Reschedule |
| `apps/customer/app/book/BookFlow.tsx` | Join Now / Schedule toggle and the Schedule path |
| `apps/customer/app/appointments/[id]/page.tsx` | Appointment Detail (+ booked confirmation, cancel, reschedule) |
| `apps/customer/app/tickets/page.tsx` | Upcoming section |
| `apps/customer/messages/en.json` | `Appointments` messages, Book toggle labels |
| `e2e/appointment-booking.spec.ts` | Book → Upcoming → reschedule → cancel |

---

### Task 1: Slot engine and booking

**Files:**
- Create: `supabase/migrations/20261001090000_cancel_reason_branch_closed.sql`
- Create: `supabase/migrations/20261001090100_appointment_booking.sql`
- Create: `tests/db/fixtures/appointments.ts`
- Create: `tests/db/appointment-booking.test.ts`
- Modify: `packages/shared/src/database.types.ts` (Functions map, `cancel_reason` enum)

**Interfaces:**
- Produces (SQL): `appointment_slot_problem(p_branch_service_id uuid, p_barber_id uuid, p_slot_start timestamptz, p_customer_id uuid, p_ignore_appointment_id uuid) returns text` (internal; `null` = open); `list_appointment_slots(p_branch_service_id uuid, p_barber_id uuid, p_date date) returns setof timestamptz`; `book_appointment(p_branch_service_id uuid, p_barber_id uuid, p_slot_start timestamptz) returns uuid`.
- Produces (TS fixture): `createAppointmentFixture(): Promise<AppointmentFixture>`, `cleanupAppointmentFixture(f)`, `slotAt(dayOffset: number, hhmm: string): string`, `dateAt(dayOffset: number): string`.

- [ ] **Step 1: Write the enum migration**

`supabase/migrations/20261001090000_cancel_reason_branch_closed.sql`:
```sql
-- Appointments part 1: an appointment whose branch is closed at its start time is cancelled with
-- this reason by activate_due_appointments (20261001090300). Its own migration: a new enum value
-- can't be used inside the transaction that adds it.
alter type cancel_reason add value if not exists 'branch_closed';
```

- [ ] **Step 2: Write the fixture**

`tests/db/fixtures/appointments.ts`:
```typescript
// tests/db/fixtures/appointments.ts
// Shared fixture for the appointment tests: one branch open 00:00-23:59:59 every day, a 30-minute
// service offered there, two barbers (A, B) skilled for it and scheduled at the branch all day for
// today + the next 15 days (A has a 12:00-13:00 break every day), a second branch (for
// branch-closure cases), four phone customers and one barber login, each with a signed-in client.
// Not a test file itself (vitest only collects *.test.ts).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

export type Client = SupabaseClient<Database>;
export const PASSWORD = 'Test-Password-123!';
const DAY = 24 * 60 * 60 * 1000;

export interface AppointmentFixture {
  admin: Client;
  suffix: string;
  serviceId: string;
  branchId: string;
  branchServiceId: string;
  closedBranchId: string;
  closedBranchServiceId: string;
  barberA: { barberId: string; staffUserId: string; authUserId: string };
  barberB: { barberId: string; staffUserId: string; authUserId: string };
  barberClient: Client;
  customers: { customerId: string; authUserId: string; phone: string; client: Client }[];
}

function env() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  };
}

/** UTC calendar date `dayOffset` days from today, as YYYY-MM-DD. */
export function dateAt(dayOffset: number): string {
  return new Date(Date.now() + dayOffset * DAY).toISOString().slice(0, 10);
}

/** ISO timestamp for HH:MM UTC on the day `dayOffset` days from today. */
export function slotAt(dayOffset: number, hhmm: string): string {
  return new Date(`${dateAt(dayOffset)}T${hhmm}:00.000Z`).toISOString();
}

async function signIn(creds: { email: string } | { phone: string }): Promise<Client> {
  const { url, anonKey } = env();
  const client = createClient<Database>(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ ...creds, password: PASSWORD });
  if (error) throw error;
  return client;
}

async function createBranch(admin: Client, businessId: string, label: string, suffix: string) {
  const { data, error } = await admin
    .from('branches')
    .insert({
      business_id: businessId,
      name: `Appt ${label} ${suffix}`,
      branch_code: `AP${label[0]}${suffix.slice(-5)}`,
      address: 'Test',
      latitude: 5.6,
      longitude: -0.18,
    })
    .select('id')
    .single();
  if (error) throw error;
  const { error: hoursError } = await admin.from('branch_hours').insert(
    [0, 1, 2, 3, 4, 5, 6].map((day_of_week) => ({
      branch_id: data.id,
      day_of_week,
      opens_at: '00:00:00',
      closes_at: '23:59:59',
      is_closed: false,
    })),
  );
  if (hoursError) throw hoursError;
  return data.id as string;
}

async function createBarber(
  admin: Client,
  label: string,
  suffix: string,
  branchId: string,
  serviceId: string,
  withBreak: boolean,
) {
  const email = `appt-barber-${label}-${suffix}@test.pixelbarber.local`;
  const { data: auth, error: authError } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (authError) throw authError;
  const { data: staff, error: staffError } = await admin
    .from('staff_users')
    .insert({
      auth_user_id: auth.user.id,
      name: `Appt Barber ${label}`,
      email,
      role: 'barber',
      invite_status: 'accepted',
    })
    .select('id')
    .single();
  if (staffError) throw staffError;
  const { data: barber, error: barberError } = await admin
    .from('barbers')
    .insert({ staff_user_id: staff.id, home_branch_id: branchId, status: 'available' })
    .select('id')
    .single();
  if (barberError) throw barberError;
  await admin.from('barber_skills').insert({ barber_id: barber.id, service_id: serviceId });
  // Replace any rows the schedule auto-fill may have created, then schedule all day for 16 days.
  await admin.from('barber_schedule').delete().eq('barber_id', barber.id);
  const { error: scheduleError } = await admin.from('barber_schedule').insert(
    Array.from({ length: 16 }, (_, i) => ({
      barber_id: barber.id,
      work_date: dateAt(i),
      branch_id: branchId,
      shift_start: '00:00:00',
      shift_end: '23:59:59',
      break_start: withBreak ? '12:00:00' : null,
      break_end: withBreak ? '13:00:00' : null,
    })),
  );
  if (scheduleError) throw scheduleError;
  return { barberId: barber.id, staffUserId: staff.id, authUserId: auth.user.id, email };
}

export async function createAppointmentFixture(): Promise<AppointmentFixture> {
  const { url, serviceRoleKey } = env();
  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const suffix = String(Date.now());
  const { data: business } = await admin.from('businesses').select('id').limit(1).single();

  const { data: service, error: serviceError } = await admin
    .from('services')
    .insert({ business_id: business!.id, name: `Appt Service ${suffix}`, default_duration_minutes: 30 })
    .select('id')
    .single();
  if (serviceError) throw serviceError;

  const branchId = await createBranch(admin, business!.id, 'Main', suffix);
  const closedBranchId = await createBranch(admin, business!.id, 'Closed', suffix);
  const { data: bs } = await admin
    .from('branch_services')
    .insert({ branch_id: branchId, service_id: service.id })
    .select('id')
    .single();
  const { data: closedBs } = await admin
    .from('branch_services')
    .insert({ branch_id: closedBranchId, service_id: service.id })
    .select('id')
    .single();

  const a = await createBarber(admin, 'a', suffix, branchId, service.id, true);
  const b = await createBarber(admin, 'b', suffix, branchId, service.id, false);
  const barberClient = await signIn({ email: a.email });

  const customers: AppointmentFixture['customers'] = [];
  for (let i = 0; i < 4; i++) {
    // 0558… : distinct from the phone ranges other test files use.
    const phone = `+233558${suffix.slice(-5)}${i}`;
    const { data: auth, error } = await admin.auth.admin.createUser({
      phone,
      password: PASSWORD,
      phone_confirm: true,
    });
    if (error) throw error;
    const { data: customer, error: customerError } = await admin
      .from('customers')
      .insert({ auth_user_id: auth.user.id, name: `Appt Customer ${i}`, phone_e164: phone })
      .select('id')
      .single();
    if (customerError) throw customerError;
    customers.push({
      customerId: customer.id,
      authUserId: auth.user.id,
      phone,
      client: await signIn({ phone }),
    });
  }

  return {
    admin,
    suffix,
    serviceId: service.id,
    branchId,
    branchServiceId: bs!.id,
    closedBranchId,
    closedBranchServiceId: closedBs!.id,
    barberA: { barberId: a.barberId, staffUserId: a.staffUserId, authUserId: a.authUserId },
    barberB: { barberId: b.barberId, staffUserId: b.staffUserId, authUserId: b.authUserId },
    barberClient,
    customers,
  };
}

export async function cleanupAppointmentFixture(f: AppointmentFixture) {
  const { admin } = f;
  const branchIds = [f.branchId, f.closedBranchId];
  const { data: tickets } = await admin.from('queue_tickets').select('id').in('branch_id', branchIds);
  const ticketIds = (tickets ?? []).map((t) => t.id);
  if (ticketIds.length > 0) {
    await admin.from('queue_events').delete().in('ticket_id', ticketIds);
    await admin.from('notifications').delete().in('related_ticket_id', ticketIds);
    await admin.from('queue_tickets').delete().in('id', ticketIds);
  }
  await admin.from('appointments').delete().in('branch_id', branchIds);
  for (const c of f.customers) {
    await admin.from('customers').delete().eq('id', c.customerId);
    await admin.auth.admin.deleteUser(c.authUserId);
  }
  for (const barber of [f.barberA, f.barberB]) {
    await admin.from('barber_schedule').delete().eq('barber_id', barber.barberId);
    await admin.from('barber_skills').delete().eq('barber_id', barber.barberId);
    await admin.from('staff_users').delete().eq('id', barber.staffUserId);
    await admin.auth.admin.deleteUser(barber.authUserId);
  }
  await admin.from('branch_ticket_counters').delete().in('branch_id', branchIds);
  await admin.from('branch_services').delete().in('branch_id', branchIds);
  await admin.from('branch_closures').delete().in('branch_id', branchIds);
  await admin.from('branch_hours').delete().in('branch_id', branchIds);
  await admin.from('branches').delete().in('id', branchIds);
  await admin.from('services').delete().eq('id', f.serviceId);
}
```

- [ ] **Step 3: Write the failing booking test**

`tests/db/appointment-booking.test.ts`:
```typescript
// tests/db/appointment-booking.test.ts
// @vitest-environment node
// list_appointment_slots / book_appointment: every slot rule, "any barber" capacity, double-booking
// refusal, and that customers can only write appointments through the functions.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  createAppointmentFixture,
  dateAt,
  slotAt,
  type AppointmentFixture,
  type Client,
} from './fixtures/appointments';

let f: AppointmentFixture;

async function slots(client: Client, barberId: string | null, dayOffset: number) {
  const { data, error } = await client.rpc('list_appointment_slots', {
    p_branch_service_id: f.branchServiceId,
    p_barber_id: barberId,
    p_date: dateAt(dayOffset),
  });
  if (error) throw error;
  return (data ?? []).map((s) => new Date(s).toISOString());
}

async function book(client: Client, barberId: string | null, slot: string, bsId?: string) {
  return client.rpc('book_appointment', {
    p_branch_service_id: bsId ?? f.branchServiceId,
    p_barber_id: barberId,
    p_slot_start: slot,
  });
}

beforeAll(async () => {
  f = await createAppointmentFixture();
}, 90000);

afterAll(async () => {
  await cleanupAppointmentFixture(f);
}, 90000);

describe('list_appointment_slots', () => {
  it('lists 30-minute slots inside the shift and skips the barber break', async () => {
    const forA = await slots(f.customers[0].client, f.barberA.barberId, 2);
    expect(forA).toContain(slotAt(2, '10:00'));
    expect(forA).toContain(slotAt(2, '10:30'));
    expect(forA).not.toContain(slotAt(2, '12:00'));
    expect(forA).not.toContain(slotAt(2, '12:30'));
    // B has no break, so "any barber" still offers 12:00.
    expect(await slots(f.customers[0].client, null, 2)).toContain(slotAt(2, '12:00'));
  });

  it('offers nothing beyond 14 days ahead', async () => {
    expect(await slots(f.customers[0].client, f.barberA.barberId, 15)).toEqual([]);
  });
});

describe('book_appointment', () => {
  it('refuses a slot less than an hour away and one more than 14 days ahead', async () => {
    const soon = new Date(Math.ceil(Date.now() / 1_800_000) * 1_800_000).toISOString();
    expect((await book(f.customers[0].client, f.barberA.barberId, soon)).error?.message).toBe(
      'too_soon',
    );
    expect(
      (await book(f.customers[0].client, f.barberA.barberId, slotAt(15, '10:00'))).error?.message,
    ).toBe('too_far_ahead');
  });

  it('books a free slot once and refuses the same barber slot to anyone else', async () => {
    const { data: id, error } = await book(
      f.customers[0].client,
      f.barberA.barberId,
      slotAt(2, '10:00'),
    );
    expect(error).toBeNull();
    const { data: row } = await f.admin.from('appointments').select('*').eq('id', id!).single();
    expect(row).toMatchObject({
      customer_id: f.customers[0].customerId,
      branch_id: f.branchId,
      preferred_barber_id: f.barberA.barberId,
      status: 'scheduled',
      created_by: 'customer',
    });
    expect(new Date(row!.scheduled_end).getTime() - new Date(row!.scheduled_start).getTime()).toBe(
      30 * 60 * 1000,
    );

    expect(
      (await book(f.customers[1].client, f.barberA.barberId, slotAt(2, '10:00'))).error?.message,
    ).toBe('slot_taken');
    expect(await slots(f.customers[1].client, f.barberA.barberId, 2)).not.toContain(
      slotAt(2, '10:00'),
    );
    // B is still free at 10:00.
    expect(await slots(f.customers[1].client, null, 2)).toContain(slotAt(2, '10:00'));
  });

  it('allows one appointment per customer per day', async () => {
    expect(
      (await book(f.customers[0].client, f.barberB.barberId, slotAt(2, '15:00'))).error?.message,
    ).toBe('already_booked_that_day');
  });

  it('caps "any barber" bookings at the number of free barbers', async () => {
    const at = slotAt(3, '14:00');
    expect((await book(f.customers[1].client, null, at)).error).toBeNull();
    expect((await book(f.customers[2].client, null, at)).error).toBeNull();
    expect((await book(f.customers[3].client, null, at)).error?.message).toBe('slot_taken');
    // A named booking may not squeeze out the two "any barber" bookings either.
    expect((await book(f.customers[0].client, f.barberA.barberId, at)).error?.message).toBe(
      'slot_taken',
    );
    expect(await slots(f.customers[3].client, null, 3)).not.toContain(at);
  });

  it('refuses a day the branch is closed', async () => {
    await f.admin
      .from('branch_closures')
      .insert({ branch_id: f.closedBranchId, closure_date: dateAt(4) });
    const { error } = await book(
      f.customers[3].client,
      null,
      slotAt(4, '10:00'),
      f.closedBranchServiceId,
    );
    expect(error?.message).toBe('branch_closed');
  });

  it('refuses callers who are not customers', async () => {
    expect(
      (await book(f.barberClient, f.barberA.barberId, slotAt(5, '10:00'))).error?.message,
    ).toBe('not_a_customer');
  });
});

describe('direct writes', () => {
  it('customers cannot insert or update appointments directly', async () => {
    const c = f.customers[3];
    const { error: insertError } = await c.client.from('appointments').insert({
      customer_id: c.customerId,
      branch_id: f.branchId,
      branch_service_id: f.branchServiceId,
      scheduled_start: slotAt(6, '10:00'),
      scheduled_end: slotAt(6, '10:30'),
      created_by: 'customer',
    });
    expect(insertError).not.toBeNull();

    const { data: mine } = await f.admin
      .from('appointments')
      .select('id')
      .eq('customer_id', f.customers[1].customerId)
      .limit(1)
      .single();
    const { data: updated } = await f.customers[1].client
      .from('appointments')
      .update({ scheduled_start: slotAt(6, '09:00') })
      .eq('id', mine!.id)
      .select();
    expect(updated ?? []).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Run it to confirm it fails**

Run: `npx vitest run tests/db/appointment-booking.test.ts`
Expected: FAIL — `list_appointment_slots` / `book_appointment` don't exist yet.

- [ ] **Step 5: Write the booking migration**

`supabase/migrations/20261001090100_appointment_booking.sql`:
```sql
-- Appointments part 1 (Docs/superpowers/specs/2026-10-01-appointments-customer-booking-design.md):
-- one rule-checker shared by slot listing, booking and rescheduling, so they can never disagree.

-- Returns null when the slot is open, otherwise the error string the app shows. Internal only.
create or replace function appointment_slot_problem(
  p_branch_service_id uuid,
  p_barber_id uuid,
  p_slot_start timestamptz,
  p_customer_id uuid,
  p_ignore_appointment_id uuid
) returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_branch_id uuid;
  v_service_id uuid;
  v_active boolean;
  v_duration int;
  v_end timestamptz;
  v_date date;
  v_start_t time;
  v_end_t time;
  v_suitable_free int;
  v_pool int;
  v_any int;
begin
  select bs.branch_id, bs.service_id, bs.is_active,
         coalesce(bs.duration_minutes_override, s.default_duration_minutes)
    into v_branch_id, v_service_id, v_active, v_duration
  from branch_services bs
  join services s on s.id = bs.service_id
  where bs.id = p_branch_service_id;
  if v_branch_id is null or not v_active then
    return 'service_unavailable';
  end if;

  v_end := p_slot_start + make_interval(mins => v_duration);
  v_date := (p_slot_start at time zone 'UTC')::date;
  v_start_t := (p_slot_start at time zone 'UTC')::time;
  v_end_t := (v_end at time zone 'UTC')::time;

  if p_slot_start < now() + interval '1 hour' then
    return 'too_soon';
  end if;
  if v_date > (now() at time zone 'UTC')::date + 14 then
    return 'too_far_ahead';
  end if;
  -- Off the 30-minute grid, or running past midnight: never a real slot.
  if extract(epoch from p_slot_start)::bigint % 1800 <> 0
     or (v_end at time zone 'UTC')::date <> v_date then
    return 'slot_taken';
  end if;

  if not exists (
       select 1 from branch_hours h
       where h.branch_id = v_branch_id
         and h.day_of_week = extract(dow from v_date)
         and not h.is_closed
         and h.opens_at <= v_start_t
         and h.closes_at >= v_end_t
     )
     or exists (
       select 1 from branch_closures c where c.branch_id = v_branch_id and c.closure_date = v_date
     )
     or (
       v_date = (now() at time zone 'UTC')::date
       and exists (select 1 from branches b where b.id = v_branch_id and b.is_temporarily_closed)
     ) then
    return 'branch_closed';
  end if;

  if p_customer_id is not null and exists (
    select 1 from appointments a
    where a.customer_id = p_customer_id
      and a.status = 'scheduled'
      and (a.scheduled_start at time zone 'UTC')::date = v_date
      and a.id is distinct from p_ignore_appointment_id
  ) then
    return 'already_booked_that_day';
  end if;

  -- Barbers working at this branch through the whole slot (any skill), excluding any barber named
  -- on an overlapping active appointment. "Suitable" ones are also skilled for this service (and,
  -- for a named booking, are the named barber).
  with overlapping as (
    select a.preferred_barber_id
    from appointments a
    where a.branch_id = v_branch_id
      and a.status in ('scheduled', 'converted')
      and a.scheduled_start < v_end
      and a.scheduled_end > p_slot_start
      and a.id is distinct from p_ignore_appointment_id
  ),
  working as (
    select b.id,
           exists (
             select 1 from barber_skills sk where sk.barber_id = b.id and sk.service_id = v_service_id
           ) as skilled
    from barbers b
    join staff_users su on su.id = b.staff_user_id
    join barber_schedule sch on sch.barber_id = b.id
    where su.is_active
      and su.invite_status = 'accepted'
      and sch.work_date = v_date
      and sch.branch_id = v_branch_id
      and sch.shift_start <= v_start_t
      and sch.shift_end >= v_end_t
      and not (
        sch.break_start is not null and sch.break_end is not null
        and sch.break_start < v_end_t and sch.break_end > v_start_t
      )
      and b.id not in (
        select o.preferred_barber_id from overlapping o where o.preferred_barber_id is not null
      )
  )
  select count(*) filter (where skilled and (p_barber_id is null or id = p_barber_id)),
         count(*)
    into v_suitable_free, v_pool
  from working;
  select count(*) into v_any from overlapping where preferred_barber_id is null;

  if v_suitable_free = 0 then
    return 'slot_taken';
  end if;
  if p_barber_id is null and v_pool <= v_any then
    return 'slot_taken';
  end if;
  if p_barber_id is not null and v_pool - 1 < v_any then
    return 'slot_taken';
  end if;
  return null;
end;
$$;

revoke execute on function appointment_slot_problem(uuid, uuid, timestamptz, uuid, uuid)
  from public, anon, authenticated;

create or replace function list_appointment_slots(
  p_branch_service_id uuid,
  p_barber_id uuid,
  p_date date
) returns setof timestamptz
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer_id uuid;
begin
  select id into v_customer_id from customers where auth_user_id = auth.uid();
  return query
    select slot
    from generate_series(
      p_date::timestamp at time zone 'UTC',
      (p_date::timestamp + interval '23 hours 30 minutes') at time zone 'UTC',
      interval '30 minutes'
    ) as slot
    where appointment_slot_problem(p_branch_service_id, p_barber_id, slot, v_customer_id, null) is null
    order by slot;
end;
$$;

revoke execute on function list_appointment_slots(uuid, uuid, date) from public, anon;
grant execute on function list_appointment_slots(uuid, uuid, date) to authenticated;

create or replace function book_appointment(
  p_branch_service_id uuid,
  p_barber_id uuid,
  p_slot_start timestamptz
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer_id uuid;
  v_branch_id uuid;
  v_duration int;
  v_problem text;
  v_id uuid;
begin
  select id into v_customer_id from customers where auth_user_id = auth.uid();
  if v_customer_id is null then
    raise exception 'not_a_customer';
  end if;
  select bs.branch_id, coalesce(bs.duration_minutes_override, s.default_duration_minutes)
    into v_branch_id, v_duration
  from branch_services bs join services s on s.id = bs.service_id
  where bs.id = p_branch_service_id;
  if v_branch_id is null then
    raise exception 'service_unavailable';
  end if;

  -- Serialize bookings per branch (slot capacity) and per customer (one per day across branches).
  perform pg_advisory_xact_lock(hashtextextended('appointments:branch:' || v_branch_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('appointments:customer:' || v_customer_id::text, 0));

  v_problem := appointment_slot_problem(p_branch_service_id, p_barber_id, p_slot_start, v_customer_id, null);
  if v_problem is not null then
    raise exception '%', v_problem;
  end if;

  insert into appointments (
    customer_id, branch_id, branch_service_id, preferred_barber_id,
    scheduled_start, scheduled_end, status, created_by
  ) values (
    v_customer_id, v_branch_id, p_branch_service_id, p_barber_id,
    p_slot_start, p_slot_start + make_interval(mins => v_duration), 'scheduled', 'customer'
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function book_appointment(uuid, uuid, timestamptz) from public, anon;
grant execute on function book_appointment(uuid, uuid, timestamptz) to authenticated;

-- Customers now write appointments only through the functions above (and cancel/reschedule).
drop policy if exists appointments_customer_create on appointments;
drop policy if exists appointments_customer_update_own on appointments;
```

- [ ] **Step 6: Add the types**

In `packages/shared/src/database.types.ts`:

(a) `Enums` → `cancel_reason`: add `| 'branch_closed'` after `| 'other'`.

(b) In the `Functions` map, alphabetically (`book_appointment` after `auth_staff_id`; `list_appointment_slots` before `list_bookable_barbers`):
```typescript
      book_appointment: {
        Args: { p_branch_service_id: string; p_barber_id: string | null; p_slot_start: string };
        Returns: string;
      };
```
```typescript
      list_appointment_slots: {
        Args: { p_branch_service_id: string; p_barber_id: string | null; p_date: string };
        Returns: string[];
      };
```
(`appointment_slot_problem` is not granted to clients — no type entry.)

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck` — Expected: PASS.
```bash
git add supabase/migrations/20261001090000_cancel_reason_branch_closed.sql supabase/migrations/20261001090100_appointment_booking.sql tests/db/fixtures/appointments.ts tests/db/appointment-booking.test.ts packages/shared/src/database.types.ts
git commit -m "feat: appointment slot engine and booking function"
```
Report "ready for push".

- [ ] **Step 8 (controller): push to staging, then run the test**

```bash
set -a && source supabase/.secrets/send-sms.env && set +a && npx supabase db push
npx vitest run tests/db/appointment-booking.test.ts
```
Expected: all PASS.

---

### Task 2: Cancel and reschedule

**Files:**
- Create: `supabase/migrations/20261001090200_appointment_cancel_reschedule.sql`
- Create: `tests/db/appointment-cancel-reschedule.test.ts`
- Modify: `packages/shared/src/database.types.ts`

**Interfaces:**
- Consumes: `appointment_slot_problem(...)` (Task 1); fixture `createAppointmentFixture`, `slotAt`, `dateAt` (Task 1).
- Produces: `cancel_appointment(p_appointment_id uuid, p_reason cancel_reason) returns void`; `reschedule_appointment(p_appointment_id uuid, p_slot_start timestamptz) returns void`.

- [ ] **Step 1: Write the failing test**

`tests/db/appointment-cancel-reschedule.test.ts`:
```typescript
// tests/db/appointment-cancel-reschedule.test.ts
// @vitest-environment node
// cancel_appointment / reschedule_appointment: own appointments only, only while scheduled and more
// than an hour away; reschedule re-checks every slot rule and frees the old slot only on success.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  createAppointmentFixture,
  dateAt,
  slotAt,
  type AppointmentFixture,
} from './fixtures/appointments';

let f: AppointmentFixture;
let apptId: string;
let soonApptId: string;

beforeAll(async () => {
  f = await createAppointmentFixture();
  const { data, error } = await f.customers[0].client.rpc('book_appointment', {
    p_branch_service_id: f.branchServiceId,
    p_barber_id: f.barberA.barberId,
    p_slot_start: slotAt(2, '10:00'),
  });
  if (error) throw error;
  apptId = data!;
  // Customer 1 holds A at 11:00 on day 2.
  const { error: e2 } = await f.customers[1].client.rpc('book_appointment', {
    p_branch_service_id: f.branchServiceId,
    p_barber_id: f.barberA.barberId,
    p_slot_start: slotAt(2, '11:00'),
  });
  if (e2) throw e2;
  // An appointment starting in 30 minutes (inserted directly: booking refuses it).
  const start = new Date(Date.now() + 30 * 60 * 1000);
  const { data: soon, error: e3 } = await f.admin
    .from('appointments')
    .insert({
      customer_id: f.customers[2].customerId,
      branch_id: f.branchId,
      branch_service_id: f.branchServiceId,
      preferred_barber_id: f.barberB.barberId,
      scheduled_start: start.toISOString(),
      scheduled_end: new Date(start.getTime() + 30 * 60 * 1000).toISOString(),
      status: 'scheduled',
      created_by: 'customer',
    })
    .select('id')
    .single();
  if (e3) throw e3;
  soonApptId = soon.id;
}, 90000);

afterAll(async () => {
  await cleanupAppointmentFixture(f);
}, 90000);

describe('reschedule_appointment', () => {
  it('refuses a slot someone else holds and leaves the appointment unchanged', async () => {
    const { error } = await f.customers[0].client.rpc('reschedule_appointment', {
      p_appointment_id: apptId,
      p_slot_start: slotAt(2, '11:00'),
    });
    expect(error?.message).toBe('slot_taken');
    const { data } = await f.admin
      .from('appointments')
      .select('scheduled_start')
      .eq('id', apptId)
      .single();
    expect(new Date(data!.scheduled_start).toISOString()).toBe(slotAt(2, '10:00'));
  });

  it('moves to a free slot (even on the same day) and frees the old one', async () => {
    const { error } = await f.customers[0].client.rpc('reschedule_appointment', {
      p_appointment_id: apptId,
      p_slot_start: slotAt(2, '14:00'),
    });
    expect(error).toBeNull();
    const { data } = await f.admin.from('appointments').select('*').eq('id', apptId).single();
    expect(new Date(data!.scheduled_start).toISOString()).toBe(slotAt(2, '14:00'));
    expect(new Date(data!.scheduled_end).toISOString()).toBe(slotAt(2, '14:30'));
    expect(data!.version).toBe(1);
    const { data: free } = await f.customers[3].client.rpc('list_appointment_slots', {
      p_branch_service_id: f.branchServiceId,
      p_barber_id: f.barberA.barberId,
      p_date: dateAt(2),
    });
    expect((free ?? []).map((s) => new Date(s).toISOString())).toContain(slotAt(2, '10:00'));
  });

  it("refuses someone else's appointment and one less than an hour away", async () => {
    const other = await f.customers[1].client.rpc('reschedule_appointment', {
      p_appointment_id: apptId,
      p_slot_start: slotAt(3, '10:00'),
    });
    expect(other.error?.message).toBe('not_found');
    const late = await f.customers[2].client.rpc('reschedule_appointment', {
      p_appointment_id: soonApptId,
      p_slot_start: slotAt(3, '10:00'),
    });
    expect(late.error?.message).toBe('too_late');
  });
});

describe('cancel_appointment', () => {
  it('refuses within an hour of the start', async () => {
    const { error } = await f.customers[2].client.rpc('cancel_appointment', {
      p_appointment_id: soonApptId,
      p_reason: 'cant_make_it',
    });
    expect(error?.message).toBe('too_late');
  });

  it("refuses someone else's appointment", async () => {
    const { error } = await f.customers[1].client.rpc('cancel_appointment', {
      p_appointment_id: apptId,
      p_reason: 'other',
    });
    expect(error?.message).toBe('not_found');
  });

  it('cancels with the reason and cannot be cancelled twice', async () => {
    const { error } = await f.customers[0].client.rpc('cancel_appointment', {
      p_appointment_id: apptId,
      p_reason: 'changed_plans',
    });
    expect(error).toBeNull();
    const { data } = await f.admin.from('appointments').select('*').eq('id', apptId).single();
    expect(data).toMatchObject({ status: 'cancelled', cancel_reason: 'changed_plans' });
    expect(data!.cancelled_at).not.toBeNull();
    const again = await f.customers[0].client.rpc('cancel_appointment', {
      p_appointment_id: apptId,
      p_reason: 'other',
    });
    expect(again.error?.message).toBe('too_late');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/db/appointment-cancel-reschedule.test.ts`
Expected: FAIL — functions don't exist yet.

- [ ] **Step 3: Write the migration**

`supabase/migrations/20261001090200_appointment_cancel_reschedule.sql`:
```sql
-- Appointments part 1: customer cancel and reschedule, own appointments only, while scheduled and
-- more than an hour before the start.

create or replace function cancel_appointment(p_appointment_id uuid, p_reason cancel_reason)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer_id uuid;
  v_appt appointments%rowtype;
begin
  select id into v_customer_id from customers where auth_user_id = auth.uid();
  select * into v_appt from appointments
    where id = p_appointment_id and customer_id = v_customer_id
    for update;
  if not found then
    raise exception 'not_found';
  end if;
  if v_appt.status <> 'scheduled' or v_appt.scheduled_start <= now() + interval '1 hour' then
    raise exception 'too_late';
  end if;
  update appointments
    set status = 'cancelled', cancel_reason = p_reason, cancelled_at = now(), version = version + 1
    where id = p_appointment_id;
end;
$$;

revoke execute on function cancel_appointment(uuid, cancel_reason) from public, anon;
grant execute on function cancel_appointment(uuid, cancel_reason) to authenticated;

create or replace function reschedule_appointment(p_appointment_id uuid, p_slot_start timestamptz)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer_id uuid;
  v_branch_id uuid;
  v_appt appointments%rowtype;
  v_duration int;
  v_problem text;
begin
  select id into v_customer_id from customers where auth_user_id = auth.uid();
  select branch_id into v_branch_id from appointments
    where id = p_appointment_id and customer_id = v_customer_id;
  if v_branch_id is null then
    raise exception 'not_found';
  end if;

  -- Same lock order as book_appointment (branch, then customer) so the two can't deadlock.
  perform pg_advisory_xact_lock(hashtextextended('appointments:branch:' || v_branch_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('appointments:customer:' || v_customer_id::text, 0));

  select * into v_appt from appointments where id = p_appointment_id for update;
  if v_appt.status <> 'scheduled' or v_appt.scheduled_start <= now() + interval '1 hour' then
    raise exception 'too_late';
  end if;

  v_problem := appointment_slot_problem(
    v_appt.branch_service_id, v_appt.preferred_barber_id, p_slot_start, v_customer_id, v_appt.id
  );
  if v_problem is not null then
    raise exception '%', v_problem;
  end if;

  select coalesce(bs.duration_minutes_override, s.default_duration_minutes) into v_duration
  from branch_services bs join services s on s.id = bs.service_id
  where bs.id = v_appt.branch_service_id;

  update appointments
    set scheduled_start = p_slot_start,
        scheduled_end = p_slot_start + make_interval(mins => v_duration),
        version = version + 1
    where id = p_appointment_id;
end;
$$;

revoke execute on function reschedule_appointment(uuid, timestamptz) from public, anon;
grant execute on function reschedule_appointment(uuid, timestamptz) to authenticated;
```

- [ ] **Step 4: Add the types**

In the `Functions` map of `packages/shared/src/database.types.ts`, alphabetically (`cancel_appointment` after `book_appointment`; `reschedule_appointment` in its sorted place):
```typescript
      cancel_appointment: {
        Args: {
          p_appointment_id: string;
          p_reason: Database['public']['Enums']['cancel_reason'];
        };
        Returns: undefined;
      };
```
```typescript
      reschedule_appointment: {
        Args: { p_appointment_id: string; p_slot_start: string };
        Returns: undefined;
      };
```

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` — Expected: PASS.
```bash
git add supabase/migrations/20261001090200_appointment_cancel_reschedule.sql tests/db/appointment-cancel-reschedule.test.ts packages/shared/src/database.types.ts
git commit -m "feat: customer cancel and reschedule appointment functions"
```
Report "ready for push".

- [ ] **Step 6 (controller): push to staging, then run the tests**

```bash
set -a && source supabase/.secrets/send-sms.env && set +a && npx supabase db push
npx vitest run tests/db/appointment-cancel-reschedule.test.ts tests/db/appointment-booking.test.ts
```
Expected: PASS.

---

### Task 3: Conversion, priority and status sync

**Files:**
- Create: `supabase/migrations/20261001090300_appointment_conversion.sql`
- Create: `tests/db/appointment-conversion.test.ts`
- Modify: `packages/shared/src/database.types.ts`
- Modify: `Docs/superpowers/specs/2026-10-01-appointments-customer-booking-design.md` (append Amendments)

**Interfaces:**
- Consumes: fixture (Task 1); `find_eligible_barber(p_branch_id uuid, p_branch_service_id uuid, p_preferred_barber_id uuid)` returning `(preferred_eligible boolean, preferred_scheduled_today boolean, fallback_barber_id uuid)`; `next_ticket_number(p_branch_id uuid) returns text`.
- Produces: `activate_due_appointments() returns integer` (service role / cron); trigger `after_ticket_state_sync_appointment` on `queue_tickets`; the new `recalculate_positions` ordering.

- [ ] **Step 1: Write the failing test**

`tests/db/appointment-conversion.test.ts`:
```typescript
// tests/db/appointment-conversion.test.ts
// @vitest-environment node
// activate_due_appointments: a due appointment becomes a ticket served next (behind the called
// ticket, ahead of waiting walk-ins), a branch-closed one is cancelled, an existing active ticket
// takes the appointment instead of a second ticket, an offline preferred barber is replaced, and the
// appointment status follows its ticket (no_show / completed / cancelled). The live cron job may
// run the function concurrently -- the outcome is identical, so the tests read final state.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  createAppointmentFixture,
  type AppointmentFixture,
} from './fixtures/appointments';

let f: AppointmentFixture;

async function walkIn(customerIdx: number, barberId: string) {
  const { data: number } = await f.admin.rpc('next_ticket_number', { p_branch_id: f.branchId });
  const { data, error } = await f.admin
    .from('queue_tickets')
    .insert({
      ticket_number: number!,
      branch_id: f.branchId,
      customer_id: f.customers[customerIdx].customerId,
      branch_service_id: f.branchServiceId,
      assigned_barber_id: barberId,
      state: 'waiting',
      created_by: 'staff',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

async function dueAppointment(
  customerIdx: number,
  barberId: string | null,
  where: { branchId: string; branchServiceId: string } = {
    branchId: f.branchId,
    branchServiceId: f.branchServiceId,
  },
) {
  const start = new Date(Date.now() - 60 * 1000);
  const { data, error } = await f.admin
    .from('appointments')
    .insert({
      customer_id: f.customers[customerIdx].customerId,
      branch_id: where.branchId,
      branch_service_id: where.branchServiceId,
      preferred_barber_id: barberId,
      scheduled_start: start.toISOString(),
      scheduled_end: new Date(start.getTime() + 30 * 60 * 1000).toISOString(),
      status: 'scheduled',
      created_by: 'customer',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

async function activate() {
  const { error } = await f.admin.rpc('activate_due_appointments');
  if (error) throw error;
}

async function ticketsFor(appointmentId: string) {
  const { data } = await f.admin.from('queue_tickets').select('*').eq('appointment_id', appointmentId);
  return data ?? [];
}

beforeAll(async () => {
  f = await createAppointmentFixture();
}, 90000);

afterAll(async () => {
  await cleanupAppointmentFixture(f);
}, 90000);

describe('activate_due_appointments', () => {
  let apptId: string;
  let calledId: string;
  let waitingId: string;

  it('converts a due appointment into the next ticket, behind the called one', async () => {
    calledId = await walkIn(0, f.barberA.barberId);
    waitingId = await walkIn(1, f.barberA.barberId);
    await f.admin.rpc('recalculate_positions', {
      p_branch_id: f.branchId,
      p_barber_id: f.barberA.barberId,
    });

    apptId = await dueAppointment(2, f.barberA.barberId);
    await activate();

    const [ticket] = await ticketsFor(apptId);
    expect(ticket).toMatchObject({
      assigned_barber_id: f.barberA.barberId,
      created_by: 'appointment_conversion',
      position: 2,
      state: 'almost_turn',
    });
    const { data: others } = await f.admin
      .from('queue_tickets')
      .select('id, position, state')
      .in('id', [calledId, waitingId]);
    const byId = new Map((others ?? []).map((t) => [t.id, t]));
    expect(byId.get(calledId)).toMatchObject({ position: 1, state: 'called' });
    expect(byId.get(waitingId)).toMatchObject({ position: 3, state: 'waiting' });

    const { data: appt } = await f.admin
      .from('appointments')
      .select('status')
      .eq('id', apptId)
      .single();
    expect(appt!.status).toBe('converted');
    const { data: events } = await f.admin
      .from('queue_events')
      .select('event_type, actor_type')
      .eq('ticket_id', ticket.id);
    expect(events).toContainEqual({ event_type: 'created', actor_type: 'system' });
  });

  it('a skipped appointment ticket loses its priority', async () => {
    const [ticket] = await ticketsFor(apptId);
    await f.admin
      .from('queue_tickets')
      .update({ skipped_at: new Date().toISOString() })
      .eq('id', ticket.id);
    const { data } = await f.admin
      .from('queue_tickets')
      .select('id, position')
      .in('id', [ticket.id, waitingId]);
    const byId = new Map((data ?? []).map((t) => [t.id, t.position]));
    expect(byId.get(waitingId)!).toBeLessThan(byId.get(ticket.id)!);
  });

  it('marks the appointment no_show when its ticket becomes no_show', async () => {
    const [ticket] = await ticketsFor(apptId);
    await f.admin.from('queue_tickets').update({ state: 'no_show' }).eq('id', ticket.id);
    const { data } = await f.admin.from('appointments').select('status').eq('id', apptId).single();
    expect(data!.status).toBe('no_show');
  });

  it('marks the appointment completed when its ticket completes', async () => {
    const id = await dueAppointment(3, f.barberB.barberId);
    await activate();
    const [ticket] = await ticketsFor(id);
    expect(ticket.assigned_barber_id).toBe(f.barberB.barberId);
    await f.admin.from('queue_tickets').update({ state: 'completed' }).eq('id', ticket.id);
    const { data } = await f.admin.from('appointments').select('status').eq('id', id).single();
    expect(data!.status).toBe('completed');
  });

  it('gives an existing active ticket the appointment instead of creating a second one', async () => {
    // Customer 1 still has the waiting walk-in from the first case.
    const id = await dueAppointment(1, f.barberA.barberId);
    await activate();
    const tickets = await ticketsFor(id);
    expect(tickets).toHaveLength(1);
    expect(tickets[0].id).toBe(waitingId);
    const { data } = await f.admin.from('appointments').select('status').eq('id', id).single();
    expect(data!.status).toBe('converted');
  });

  it('reassigns when the preferred barber is offline', async () => {
    await f.admin.from('queue_tickets').update({ state: 'completed' }).eq('id', calledId);
    await f.admin.from('barbers').update({ status: 'offline' }).eq('id', f.barberB.barberId);
    const id = await dueAppointment(0, f.barberB.barberId);
    await activate();
    const [ticket] = await ticketsFor(id);
    expect(ticket.assigned_barber_id).toBe(f.barberA.barberId);
    await f.admin.from('barbers').update({ status: 'available' }).eq('id', f.barberB.barberId);
  });

  it('cancels an appointment whose branch is closed today', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await f.admin
      .from('branch_closures')
      .insert({ branch_id: f.closedBranchId, closure_date: today });
    const id = await dueAppointment(2, null, {
      branchId: f.closedBranchId,
      branchServiceId: f.closedBranchServiceId,
    });
    await activate();
    expect(await ticketsFor(id)).toHaveLength(0);
    const { data } = await f.admin.from('appointments').select('*').eq('id', id).single();
    expect(data).toMatchObject({ status: 'cancelled', cancel_reason: 'branch_closed' });
  });

  it('cancels the appointment when the customer cancels its ticket', async () => {
    const id = await dueAppointment(3, null);
    await activate();
    const [ticket] = await ticketsFor(id);
    await f.admin
      .from('queue_tickets')
      .update({ state: 'cancelled', cancel_reason: 'emergency' })
      .eq('id', ticket.id);
    const { data } = await f.admin.from('appointments').select('*').eq('id', id).single();
    expect(data).toMatchObject({ status: 'cancelled', cancel_reason: 'emergency' });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/db/appointment-conversion.test.ts`
Expected: FAIL — `activate_due_appointments` doesn't exist yet.

- [ ] **Step 3: Write the migration**

`supabase/migrations/20261001090300_appointment_conversion.sql`:
```sql
-- Appointments part 1: due appointments become queue tickets that are served next, and the
-- appointment's status follows its ticket. Replaces the Phase 1 placeholder cron job body.

-- Called ticket first, then un-skipped appointment tickets by their slot time, then the existing
-- order. Identical to 20260925130000_youre_next_notifications.sql's definition otherwise.
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
  end if;

  perform set_config('pixelbarber.recalc_in_progress', 'false', true);
end;
$$;

create or replace function activate_due_appointments() returns integer
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
  v_today date := (now() at time zone 'UTC')::date;
  v_count integer := 0;
begin
  for v_appt in
    select * from appointments
    where status = 'scheduled' and scheduled_start <= now()
    order by scheduled_start
    for update skip locked
  loop
    -- Branch closed today: cancel, no ticket.
    if exists (select 1 from branch_closures c where c.branch_id = v_appt.branch_id and c.closure_date = v_today)
       or exists (select 1 from branches b where b.id = v_appt.branch_id and b.is_temporarily_closed) then
      update appointments
        set status = 'cancelled', cancel_reason = 'branch_closed', cancelled_at = now(),
            version = version + 1
        where id = v_appt.id;
      continue;
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
      update appointments set status = 'converted', version = version + 1 where id = v_appt.id;
      if v_existing.assigned_barber_id is not null then
        perform recalculate_positions(v_appt.branch_id, v_existing.assigned_barber_id);
      end if;
      v_count := v_count + 1;
      continue;
    end if;

    -- Barber: the preferred one while their account is active/accepted and they aren't offline;
    -- otherwise whoever joining the queue would get (find_eligible_barber's fallback). Pooled only
    -- if nobody is eligible at all.
    v_barber := null;
    if v_appt.preferred_barber_id is not null and exists (
      select 1 from barbers b join staff_users su on su.id = b.staff_user_id
      where b.id = v_appt.preferred_barber_id
        and su.is_active and su.invite_status = 'accepted'
        and b.status <> 'offline'
    ) then
      v_barber := v_appt.preferred_barber_id;
    else
      select * into v_elig
      from find_eligible_barber(v_appt.branch_id, v_appt.branch_service_id, null);
      v_barber := v_elig.fallback_barber_id;
    end if;

    insert into queue_tickets (
      ticket_number, branch_id, customer_id, branch_service_id, preferred_barber_id,
      assigned_barber_id, is_pooled, appointment_id, state, created_by
    ) values (
      next_ticket_number(v_appt.branch_id), v_appt.branch_id, v_appt.customer_id,
      v_appt.branch_service_id, v_appt.preferred_barber_id,
      v_barber, v_barber is null, v_appt.id, 'waiting', 'appointment_conversion'
    )
    returning id into v_ticket_id;

    insert into queue_events (ticket_id, event_type, actor_type, after_state)
      values (v_ticket_id, 'created', 'system',
              jsonb_build_object('state', 'waiting', 'appointment_id', v_appt.id));

    update appointments set status = 'converted', version = version + 1 where id = v_appt.id;

    if v_barber is not null then
      perform recalculate_positions(v_appt.branch_id, v_barber);
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke execute on function activate_due_appointments() from public, anon, authenticated;
grant execute on function activate_due_appointments() to service_role;

-- Same job name: cron.schedule replaces the Phase 1 placeholder (which converted 5 minutes early
-- and wrote no queue_events row).
select cron.schedule('activate-due-appointments', '* * * * *', 'select activate_due_appointments()');

-- The appointment follows its ticket's terminal states.
create or replace function trg_sync_appointment_status() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.appointment_id is not null and new.state is distinct from old.state then
    if new.state = 'no_show' then
      update appointments set status = 'no_show', version = version + 1
        where id = new.appointment_id and status = 'converted';
    elsif new.state = 'completed' then
      update appointments set status = 'completed', version = version + 1
        where id = new.appointment_id and status = 'converted';
    elsif new.state = 'cancelled' then
      update appointments
        set status = 'cancelled', cancel_reason = coalesce(new.cancel_reason, 'other'),
            cancelled_at = now(), version = version + 1
        where id = new.appointment_id and status = 'converted';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function trg_sync_appointment_status() from public, anon, authenticated;

drop trigger if exists after_ticket_state_sync_appointment on queue_tickets;
create trigger after_ticket_state_sync_appointment after update of state on queue_tickets
  for each row execute function trg_sync_appointment_status();
```

- [ ] **Step 4: Add the type**

In the `Functions` map of `packages/shared/src/database.types.ts`, first entry alphabetically (before `auth_branch_ids`):
```typescript
      activate_due_appointments: { Args: never; Returns: number };
```

- [ ] **Step 5: Record the rulings in the spec**

Append to `Docs/superpowers/specs/2026-10-01-appointments-customer-booking-design.md`:
```markdown

## Amendments (planning)

- **"Any barber" conversions are assigned, not pooled.** Nothing in the app picks up a pooled
  ticket, so conversion uses `find_eligible_barber`'s fallback exactly like joining the queue; the
  ticket is pooled (unassigned) only if no barber is eligible at all.
- **An existing active ticket takes the appointment.** A customer can hold only one active ticket per
  branch, so if they already have one, it gets the `appointment_id` (and the priority) and no second
  ticket is created.
- **Skipped appointment tickets lose priority** (`skipped_at is not null`), otherwise Skip would
  re-call them immediately.
- **"Any barber" capacity** is counted per branch across the barbers working then (any skill), as
  implemented in `appointment_slot_problem`.
- **A cancelled appointment ticket cancels its appointment** with the ticket's reason.
- Upcoming/Detail show "your chosen barber" / "any available": customers can't read staff names.
```

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck` — Expected: PASS.
```bash
git add supabase/migrations/20261001090300_appointment_conversion.sql tests/db/appointment-conversion.test.ts packages/shared/src/database.types.ts Docs/superpowers/specs/2026-10-01-appointments-customer-booking-design.md
git commit -m "feat: convert due appointments into priority queue tickets"
```
Report "ready for push".

- [ ] **Step 7 (controller): push to staging, then run the queue tests**

```bash
set -a && source supabase/.secrets/send-sms.env && set +a && npx supabase db push
npx vitest run tests/db/appointment-conversion.test.ts tests/db/recalculate-positions-promotion.test.ts tests/db/skip-to-waiting.test.ts tests/db/youre-next-notifications.test.ts tests/db/queue-position-recalc-cross-actor.test.ts
```
Expected: PASS (the last four prove the old ordering is unchanged for tickets without appointments).

---

### Task 4: Book flow — Schedule path

**Files:**
- Create: `apps/customer/app/appointments/appointmentErrors.ts`
- Create: `apps/customer/app/appointments/appointmentErrors.test.ts`
- Create: `apps/customer/app/appointments/SlotPicker.tsx`
- Modify: `apps/customer/app/book/BookFlow.tsx`
- Modify: `apps/customer/messages/en.json`

**Interfaces:**
- Consumes: RPCs `list_appointment_slots`, `book_appointment` (Task 1).
- Produces: `appointmentErrorKey(message: string | undefined): AppointmentErrorKey`; default-export `SlotPicker` component with props `{ branchServiceId: string; barberId: string | null; onPick: (slotStart: string) => void; refreshKey?: number }`; named exports `formatSlotTime(iso: string): string` (HH:MM UTC) and `formatSlotDate(isoOrDate: string): string` (e.g. "Thu 2 Oct") from `SlotPicker.tsx`. Detail route `/appointments/[id]?booked=1` (Task 5 builds the page).

- [ ] **Step 1: Write the failing unit test**

`apps/customer/app/appointments/appointmentErrors.test.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import { appointmentErrorKey } from './appointmentErrors';

describe('appointmentErrorKey', () => {
  it.each([
    ['slot_taken', 'slotTaken'],
    ['already_booked_that_day', 'alreadyBookedThatDay'],
    ['branch_closed', 'branchClosed'],
    ['too_soon', 'tooSoon'],
    ['too_far_ahead', 'tooFarAhead'],
    ['too_late', 'tooLate'],
    ['not_a_customer', 'notACustomer'],
  ])('maps %s', (code, key) => {
    expect(appointmentErrorKey(code)).toBe(key);
  });

  it('falls back to a generic message for anything else', () => {
    expect(appointmentErrorKey('Failed to fetch')).toBe('generic');
    expect(appointmentErrorKey(undefined)).toBe('generic');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run apps/customer/app/appointments/appointmentErrors.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the error mapper**

`apps/customer/app/appointments/appointmentErrors.ts`:
```typescript
/** Message keys (in the `Appointments` namespace) for the appointment functions' error strings. */
export type AppointmentErrorKey =
  | 'slotTaken'
  | 'alreadyBookedThatDay'
  | 'branchClosed'
  | 'tooSoon'
  | 'tooFarAhead'
  | 'tooLate'
  | 'notACustomer'
  | 'generic';

const KEYS: Record<string, AppointmentErrorKey> = {
  slot_taken: 'slotTaken',
  already_booked_that_day: 'alreadyBookedThatDay',
  branch_closed: 'branchClosed',
  too_soon: 'tooSoon',
  too_far_ahead: 'tooFarAhead',
  too_late: 'tooLate',
  not_a_customer: 'notACustomer',
};

export function appointmentErrorKey(message: string | undefined): AppointmentErrorKey {
  return (message && KEYS[message]) || 'generic';
}
```

- [ ] **Step 4: Run the unit test**

Run: `npx vitest run apps/customer/app/appointments/appointmentErrors.test.ts` — Expected: PASS.

- [ ] **Step 5: Add the messages**

In `apps/customer/messages/en.json`, add to `"Book"`:
```json
    "modeJoinNow": "Join Now",
    "modeSchedule": "Schedule",
    "dateTimeStepTitle": "Date & Time",
    "scheduleReviewTitle": "Review & Book",
    "confirmBook": "Book Appointment",
```
and a new top-level `"Appointments"` section:
```json
  "Appointments": {
    "pickDate": "Pick a day",
    "noSlots": "No open times on this day.",
    "loadingSlots": "Loading times…",
    "slotTaken": "That time was just taken — please pick another.",
    "alreadyBookedThatDay": "You already have an appointment that day.",
    "branchClosed": "This branch is closed then.",
    "tooSoon": "Please pick a time at least an hour from now.",
    "tooFarAhead": "You can book up to 14 days ahead.",
    "tooLate": "Too late to change this appointment.",
    "notACustomer": "Only customer accounts can book appointments.",
    "generic": "Something went wrong — please try again.",
    "bookedTitle": "Your appointment is booked",
    "detailTitle": "Appointment",
    "dateLabel": "Date: {date}",
    "timeLabel": "Time: {time}",
    "serviceLabel": "Service: {service}",
    "priceLabel": "Price: GHS {price}",
    "chosenBarber": "Barber: your chosen barber",
    "anyBarber": "Barber: any available",
    "statusLabel": "Status: {status}",
    "reschedule": "Reschedule",
    "confirmReschedule": "Move to this time",
    "cancel": "Cancel appointment",
    "cancelTitle": "Why are you cancelling?",
    "confirmCancel": "Confirm cancellation",
    "back": "Back",
    "tooLateOnline": "Too late to change online — please contact the branch.",
    "upcomingTitle": "Upcoming",
    "noUpcoming": "No upcoming appointments.",
    "bookOne": "Book an appointment",
    "viewUpcoming": "View my appointments"
  },
```
(Do not re-add `Book.notSignedIn`; it was removed when customer login was built.)

- [ ] **Step 6: Write the slot picker**

`apps/customer/app/appointments/SlotPicker.tsx`:
```tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';

const DAY = 24 * 60 * 60 * 1000;
const BOOKING_DAYS = 15; // today + 14

/** HH:MM in UTC (Ghana time). */
export function formatSlotTime(iso: string): string {
  return new Date(iso).toISOString().slice(11, 16);
}

/** e.g. "Thu 2 Oct", in UTC (Ghana time). Accepts YYYY-MM-DD or an ISO timestamp. */
export function formatSlotDate(isoOrDate: string): string {
  const d = new Date(isoOrDate.length === 10 ? `${isoOrDate}T00:00:00Z` : isoOrDate);
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

interface Props {
  branchServiceId: string;
  barberId: string | null;
  onPick: (slotStart: string) => void;
  /** Bump to reload the open times (e.g. after "That time was just taken"). */
  refreshKey?: number;
}

/** Date & Time step: today + the next 14 days, then the open 30-minute slots on the chosen day. */
export default function SlotPicker({ branchServiceId, barberId, onPick, refreshKey = 0 }: Props) {
  const t = useTranslations('Appointments');
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const dates = useMemo(
    () =>
      Array.from({ length: BOOKING_DAYS }, (_, i) =>
        new Date(Date.now() + i * DAY).toISOString().slice(0, 10),
      ),
    [],
  );
  const [date, setDate] = useState<string | null>(null);
  // Each result remembers the request it answers, so a stale response never shows.
  const [result, setResult] = useState<{ key: string; slots: string[]; failed: boolean } | null>(
    null,
  );
  const requestKey = date ? `${date}:${refreshKey}` : null;

  useEffect(() => {
    if (!date || !requestKey) return;
    let cancelled = false;
    supabase
      .rpc('list_appointment_slots', {
        p_branch_service_id: branchServiceId,
        p_barber_id: barberId,
        p_date: date,
      })
      .then(({ data, error }) => {
        if (cancelled) return;
        setResult({ key: requestKey, slots: data ?? [], failed: !!error });
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, branchServiceId, barberId, date, requestKey]);

  const current = result && result.key === requestKey ? result : null;

  return (
    <div>
      <p>{t('pickDate')}</p>
      <ul>
        {dates.map((d) => (
          <li key={d}>
            <button type="button" aria-pressed={d === date} onClick={() => setDate(d)}>
              {formatSlotDate(d)}
            </button>
          </li>
        ))}
      </ul>
      {date && !current && <p>{t('loadingSlots')}</p>}
      {current?.failed && <p role="alert">{t('generic')}</p>}
      {current && !current.failed && current.slots.length === 0 && <p>{t('noSlots')}</p>}
      {current && !current.failed && current.slots.length > 0 && (
        <ul>
          {current.slots.map((slot) => (
            <li key={slot}>
              <button type="button" onClick={() => onPick(slot)}>
                {formatSlotTime(slot)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Add the Schedule path to `BookFlow.tsx`**

Apply these edits to `apps/customer/app/book/BookFlow.tsx`:

(a) Imports — add after the `sessionEndedLoginPath` import:
```tsx
import SlotPicker, { formatSlotDate, formatSlotTime } from '../appointments/SlotPicker';
import { appointmentErrorKey } from '../appointments/appointmentErrors';
```
(b) Replace `type Step = 'service' | 'barber' | 'availability' | 'review';` with:
```tsx
type Step = 'service' | 'barber' | 'availability' | 'review' | 'datetime' | 'scheduleReview';
type Mode = 'now' | 'schedule';
```
(c) After `const t = useTranslations('Book');` add `const ta = useTranslations('Appointments');`; after the `acceptFallback` state add:
```tsx
  const [mode, setMode] = useState<Mode>('now');
  const [slotStart, setSlotStart] = useState<string | null>(null);
  const [slotRefresh, setSlotRefresh] = useState(0);
```
(d) At the top of `handleSelectBarber`, right after `setError(null);`, add:
```tsx
    if (mode === 'schedule') {
      // A booking picks its own time; today's availability check doesn't apply.
      setSelectedBarberId(barberId);
      setStep('datetime');
      return;
    }
```
(e) Add this function after `handleConfirmJoin`:
```tsx
  async function handleConfirmBook() {
    if (!branchId || !selectedServiceId || !slotStart) return;
    setSubmitting(true);
    setError(null);
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      router.push(sessionEndedLoginPath(`/book?branch=${branchId}`));
      return;
    }
    const { data: appointmentId, error: bookError } = await supabase.rpc('book_appointment', {
      p_branch_service_id: selectedServiceId,
      p_barber_id: selectedBarberId,
      p_slot_start: slotStart,
    });
    setSubmitting(false);
    if (bookError || !appointmentId) {
      const key = appointmentErrorKey(bookError?.message);
      setError(ta(key));
      if (key === 'slotTaken') {
        setSlotStart(null);
        setSlotRefresh((n) => n + 1);
        setStep('datetime');
      }
      return;
    }
    router.push(`/appointments/${appointmentId}?booked=1`);
  }
```
(f) In the JSX, directly after `{error && <p role="alert">{error}</p>}`, add the toggle (shown only on the first step, so the shared steps stay consistent):
```tsx
      {step === 'service' && (
        <div role="group">
          <button type="button" aria-pressed={mode === 'now'} onClick={() => setMode('now')}>
            {t('modeJoinNow')}
          </button>
          <button
            type="button"
            aria-pressed={mode === 'schedule'}
            onClick={() => setMode('schedule')}
          >
            {t('modeSchedule')}
          </button>
        </div>
      )}
```
(g) After the `review` block (before `</main>`), add:
```tsx
      {step === 'datetime' && (
        <div>
          <h2>{t('dateTimeStepTitle')}</h2>
          <SlotPicker
            branchServiceId={selectedServiceId}
            barberId={selectedBarberId}
            refreshKey={slotRefresh}
            onPick={(slot) => {
              setError(null);
              setSlotStart(slot);
              setStep('scheduleReview');
            }}
          />
        </div>
      )}

      {step === 'scheduleReview' && slotStart && (
        <div>
          <h2>{t('scheduleReviewTitle')}</h2>
          <p>{services.find((s) => s.branchServiceId === selectedServiceId)?.serviceName}</p>
          <p>{selectedBarberId ? selectedBarberId : t('anyAvailable')}</p>
          <p>
            {formatSlotDate(slotStart)} {formatSlotTime(slotStart)}
          </p>
          <button type="button" disabled={submitting} onClick={handleConfirmBook}>
            {t('confirmBook')}
          </button>
        </div>
      )}
```
(The Join Now path — `availability`, `review`, `handleConfirmJoin` — is unchanged.)

- [ ] **Step 8: Lint, typecheck, commit**

Run: `npm run typecheck` and `(cd apps/customer && npx eslint app/book app/appointments)` — Expected: no errors.
```bash
git add apps/customer/app/appointments/appointmentErrors.ts apps/customer/app/appointments/appointmentErrors.test.ts apps/customer/app/appointments/SlotPicker.tsx apps/customer/app/book/BookFlow.tsx apps/customer/messages/en.json
git commit -m "feat: Schedule path in the Book flow with a date and time picker"
```

---

### Task 5: Upcoming, Appointment Detail, and the end-to-end test

**Files:**
- Create: `apps/customer/app/appointments/[id]/page.tsx`
- Modify: `apps/customer/app/tickets/page.tsx`
- Create: `e2e/appointment-booking.spec.ts`

**Interfaces:**
- Consumes: `SlotPicker`, `formatSlotDate`, `formatSlotTime`, `appointmentErrorKey` (Task 4); RPCs `cancel_appointment`, `reschedule_appointment` (Task 2); `Appointments` messages (Task 4); `TicketTracking.reason*` messages (existing); `sessionEndedLoginPath` (`apps/customer/app/login/nextPath.ts`).
- Produces: routes `/appointments/[id]` (with a `?booked=1` confirmation heading) and the Upcoming section on `/tickets` (`<section aria-labelledby>` named "Upcoming").

- [ ] **Step 1: Write the failing end-to-end test**

`e2e/appointment-booking.spec.ts`:
```typescript
// e2e/appointment-booking.spec.ts
// A customer books through Book → Schedule, sees it under Upcoming, reschedules it, and cancels it.
// Brings its own branch (open all day), a 30-minute service and a barber scheduled for 3 days.
// Clicks use Enter and are scoped to <main> (Next.js dev mode's Dev Tools badge).
import { test, expect } from '@playwright/test';
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PASSWORD = 'Test-Password-123!';
const DAY = 24 * 60 * 60 * 1000;

test('customer books, reschedules and cancels an appointment', async ({
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
  // 0556… : distinct from the phone ranges other test files use.
  const phone = `+233556${suffix.slice(-6)}`;
  const barberEmail = `appt-e2e-${suffix}@test.pixelbarber.local`;
  const tomorrow = new Date(Date.now() + DAY).toISOString().slice(0, 10);
  const serviceName = `Appt E2E Cut ${suffix}`;

  const { data: business } = await admin.from('businesses').select('id').limit(1).single();
  const { data: service } = await admin
    .from('services')
    .insert({ business_id: business!.id, name: serviceName, default_duration_minutes: 30 })
    .select('id')
    .single();
  const { data: branch } = await admin
    .from('branches')
    .insert({
      business_id: business!.id,
      name: `Appt E2E Branch ${suffix}`,
      branch_code: `AE${suffix.slice(-6)}`,
      address: 'Test',
      latitude: 5.6,
      longitude: -0.18,
    })
    .select('id')
    .single();
  await admin.from('branch_hours').insert(
    [0, 1, 2, 3, 4, 5, 6].map((day_of_week) => ({
      branch_id: branch!.id,
      day_of_week,
      opens_at: '00:00:00',
      closes_at: '23:59:59',
      is_closed: false,
    })),
  );
  const { data: bs } = await admin
    .from('branch_services')
    .insert({ branch_id: branch!.id, service_id: service!.id })
    .select('id')
    .single();
  const { data: barberAuth } = await admin.auth.admin.createUser({
    email: barberEmail,
    password: PASSWORD,
    email_confirm: true,
  });
  const { data: staff } = await admin
    .from('staff_users')
    .insert({
      auth_user_id: barberAuth!.user.id,
      name: 'Appt E2E Barber',
      email: barberEmail,
      role: 'barber',
      invite_status: 'accepted',
    })
    .select('id')
    .single();
  const { data: barber } = await admin
    .from('barbers')
    .insert({ staff_user_id: staff!.id, home_branch_id: branch!.id, status: 'available' })
    .select('id')
    .single();
  await admin.from('barber_skills').insert({ barber_id: barber!.id, service_id: service!.id });
  await admin.from('barber_schedule').delete().eq('barber_id', barber!.id);
  await admin.from('barber_schedule').insert(
    [0, 1, 2].map((i) => ({
      barber_id: barber!.id,
      work_date: new Date(Date.now() + i * DAY).toISOString().slice(0, 10),
      branch_id: branch!.id,
      shift_start: '00:00:00',
      shift_end: '23:59:59',
    })),
  );
  const { data: customerAuth } = await admin.auth.admin.createUser({
    phone,
    password: PASSWORD,
    phone_confirm: true,
  });
  const { data: customer } = await admin
    .from('customers')
    .insert({
      auth_user_id: customerAuth!.user.id,
      name: 'Appt E2E Customer',
      phone_e164: phone,
      avatar_key: 'avatar-1',
    })
    .select('id')
    .single();

  try {
    const { data: sessionData } = await createClient<Database>(
      url,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    ).auth.signInWithPassword({ phone, password: PASSWORD });
    const projectRef = new URL(url).hostname.split('.')[0];
    const cookieValue =
      'base64-' +
      Buffer.from(JSON.stringify(sessionData.session), 'utf-8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    await context.addCookies([
      {
        name: `sb-${projectRef}-auth-token`,
        value: cookieValue,
        url: baseURL ?? 'http://localhost:3000',
      },
    ]);

    const main = page.locator('main');
    const tomorrowLabel = new Date(`${tomorrow}T00:00:00Z`).toLocaleDateString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });

    // --- Book 10:00 tomorrow ---
    await page.goto(`/book?branch=${branch!.id}`);
    await main.getByRole('button', { name: 'Schedule' }).press('Enter');
    await main.getByRole('button', { name: new RegExp(serviceName) }).press('Enter');
    await main.getByRole('button', { name: barber!.id }).press('Enter');
    await main.getByRole('button', { name: tomorrowLabel }).press('Enter');
    await main.getByRole('button', { name: '10:00' }).press('Enter');
    await main.getByRole('button', { name: 'Book Appointment' }).press('Enter');
    await expect(page).toHaveURL(/\/appointments\/[0-9a-f-]+\?booked=1/, { timeout: 15000 });
    await expect(main.getByRole('heading', { name: 'Your appointment is booked' })).toBeVisible();
    await expect(main.getByText('Time: 10:00')).toBeVisible();

    // --- Upcoming lists it ---
    await page.goto('/tickets');
    const upcoming = main.getByRole('region', { name: 'Upcoming' });
    const entry = upcoming.getByRole('link', { name: `${tomorrowLabel} 10:00` });
    await expect(entry).toBeVisible({ timeout: 15000 });
    await entry.press('Enter');
    await expect(page).toHaveURL(/\/appointments\/[0-9a-f-]+$/, { timeout: 15000 });

    // --- Reschedule to 11:00 ---
    await main.getByRole('button', { name: 'Reschedule' }).press('Enter');
    await main.getByRole('button', { name: tomorrowLabel }).press('Enter');
    await main.getByRole('button', { name: '11:00' }).press('Enter');
    await main.getByRole('button', { name: 'Move to this time' }).press('Enter');
    await expect(main.getByText('Time: 11:00')).toBeVisible({ timeout: 15000 });

    // --- Cancel ---
    await main.getByRole('button', { name: 'Cancel appointment' }).press('Enter');
    await main.getByLabel("Can't make it").check();
    await main.getByRole('button', { name: 'Confirm cancellation' }).press('Enter');
    await expect(main.getByText('Status: cancelled')).toBeVisible({ timeout: 15000 });

    const { data: rows } = await admin
      .from('appointments')
      .select('status, cancel_reason, scheduled_start')
      .eq('customer_id', customer!.id);
    expect(rows).toHaveLength(1);
    expect(rows![0]).toMatchObject({ status: 'cancelled', cancel_reason: 'cant_make_it' });
    expect(new Date(rows![0].scheduled_start).toISOString()).toBe(`${tomorrow}T11:00:00.000Z`);

    await page.goto('/tickets');
    await expect(
      main.getByRole('region', { name: 'Upcoming' }).getByText('No upcoming appointments.'),
    ).toBeVisible({ timeout: 15000 });
  } finally {
    await admin.from('appointments').delete().eq('customer_id', customer!.id);
    await admin.from('customers').delete().eq('id', customer!.id);
    await admin.auth.admin.deleteUser(customerAuth!.user.id);
    await admin.from('barber_schedule').delete().eq('barber_id', barber!.id);
    await admin.from('barber_skills').delete().eq('barber_id', barber!.id);
    await admin.from('staff_users').delete().eq('id', staff!.id);
    await admin.auth.admin.deleteUser(barberAuth!.user.id);
    await admin.from('branch_services').delete().eq('id', bs!.id);
    await admin.from('branch_hours').delete().eq('branch_id', branch!.id);
    await admin.from('branches').delete().eq('id', branch!.id);
    await admin.from('services').delete().eq('id', service!.id);
  }
});
```

- [ ] **Step 2: Run it to confirm it fails**

Start both dev servers first in the background (Playwright's own 60-second start sometimes times out): `npm run dev --workspace=@pixel-barber/customer -- --port 3000` and `npm run dev --workspace=@pixel-barber/staff -- --port 3001`. Then:
Run: `npx playwright test e2e/appointment-booking.spec.ts --reporter=line`
Expected: FAIL at the `/appointments/...` step (the page doesn't exist yet).

- [ ] **Step 3: Write the Appointment Detail page**

`apps/customer/app/appointments/[id]/page.tsx`:
```tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';
import SlotPicker, { formatSlotDate, formatSlotTime } from '../SlotPicker';
import { appointmentErrorKey } from '../appointmentErrors';
import { sessionEndedLoginPath } from '../../login/nextPath';

type Appointment = Database['public']['Tables']['appointments']['Row'];
type CancelReason = Database['public']['Enums']['cancel_reason'];

// Customer-selectable reasons (branch_closed is system-only). Labels reuse TicketTracking's.
const REASONS: { value: CancelReason; labelKey: string }[] = [
  { value: 'wait_too_long', labelKey: 'reasonWaitTooLong' },
  { value: 'cant_make_it', labelKey: 'reasonCantMakeIt' },
  { value: 'changed_plans', labelKey: 'reasonChangedPlans' },
  { value: 'found_another_barber', labelKey: 'reasonFoundAnotherBarber' },
  { value: 'emergency', labelKey: 'reasonEmergency' },
  { value: 'other', labelKey: 'reasonOther' },
];
const CHANGE_CUTOFF_MS = 60 * 60 * 1000;

interface Loaded {
  appointment: Appointment;
  serviceName: string;
  priceGhs: number | null;
}

export default function AppointmentDetailPage() {
  const t = useTranslations('Appointments');
  const tt = useTranslations('TicketTracking');
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [mode, setMode] = useState<'view' | 'reschedule' | 'cancel'>('view');
  const [newSlot, setNewSlot] = useState<string | null>(null);
  const [slotRefresh, setSlotRefresh] = useState(0);
  const [reason, setReason] = useState<CancelReason | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) {
        router.push(sessionEndedLoginPath(`/appointments/${params.id}`));
        return;
      }
      const { data: appointment } = await supabase
        .from('appointments')
        .select('*')
        .eq('id', params.id)
        .maybeSingle();
      if (cancelled || !appointment) return;
      const [{ data: bs }, { data: price }] = await Promise.all([
        supabase
          .from('branch_services')
          .select('services(name)')
          .eq('id', appointment.branch_service_id)
          .maybeSingle(),
        supabase
          .from('current_branch_service_price')
          .select('price_ghs')
          .eq('branch_service_id', appointment.branch_service_id)
          .maybeSingle(),
      ]);
      if (cancelled) return;
      setLoaded({
        appointment,
        serviceName: (bs?.services as unknown as { name: string } | null)?.name ?? '',
        priceGhs: price?.price_ghs ?? null,
      });
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [supabase, params.id, router, reloadKey]);

  if (!loaded) return null;
  const { appointment, serviceName, priceGhs } = loaded;
  const changeable =
    appointment.status === 'scheduled' &&
    new Date(appointment.scheduled_start).getTime() - Date.now() > CHANGE_CUTOFF_MS;

  async function handleReschedule() {
    if (!newSlot) return;
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc('reschedule_appointment', {
      p_appointment_id: appointment.id,
      p_slot_start: newSlot,
    });
    setBusy(false);
    if (rpcError) {
      const key = appointmentErrorKey(rpcError.message);
      setError(t(key));
      if (key === 'slotTaken') {
        setNewSlot(null);
        setSlotRefresh((n) => n + 1);
      }
      return;
    }
    setMode('view');
    setNewSlot(null);
    setReloadKey((n) => n + 1);
  }

  async function handleCancel() {
    if (!reason) return;
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc('cancel_appointment', {
      p_appointment_id: appointment.id,
      p_reason: reason,
    });
    setBusy(false);
    if (rpcError) {
      setError(t(appointmentErrorKey(rpcError.message)));
      return;
    }
    setMode('view');
    setReloadKey((n) => n + 1);
  }

  return (
    <main>
      <h1>{searchParams.get('booked') ? t('bookedTitle') : t('detailTitle')}</h1>
      {error && <p role="alert">{error}</p>}
      <p>{t('dateLabel', { date: formatSlotDate(appointment.scheduled_start) })}</p>
      <p>{t('timeLabel', { time: formatSlotTime(appointment.scheduled_start) })}</p>
      <p>{t('serviceLabel', { service: serviceName })}</p>
      {priceGhs !== null && <p>{t('priceLabel', { price: priceGhs.toFixed(2) })}</p>}
      <p>{appointment.preferred_barber_id ? t('chosenBarber') : t('anyBarber')}</p>
      <p>{t('statusLabel', { status: appointment.status })}</p>

      {mode === 'view' &&
        (changeable ? (
          <div>
            <button type="button" onClick={() => setMode('reschedule')}>
              {t('reschedule')}
            </button>
            <button type="button" onClick={() => setMode('cancel')}>
              {t('cancel')}
            </button>
          </div>
        ) : (
          appointment.status === 'scheduled' && <p>{t('tooLateOnline')}</p>
        ))}

      {mode === 'reschedule' && (
        <div>
          <SlotPicker
            branchServiceId={appointment.branch_service_id}
            barberId={appointment.preferred_barber_id}
            refreshKey={slotRefresh}
            onPick={(slot) => {
              setError(null);
              setNewSlot(slot);
            }}
          />
          {newSlot && (
            <p>
              {formatSlotDate(newSlot)} {formatSlotTime(newSlot)}
            </p>
          )}
          <button type="button" disabled={!newSlot || busy} onClick={handleReschedule}>
            {t('confirmReschedule')}
          </button>
          <button type="button" onClick={() => setMode('view')}>
            {t('back')}
          </button>
        </div>
      )}

      {mode === 'cancel' && (
        <fieldset>
          <legend>{t('cancelTitle')}</legend>
          {REASONS.map((r) => (
            <label key={r.value}>
              <input
                type="radio"
                name="reason"
                value={r.value}
                checked={reason === r.value}
                onChange={() => setReason(r.value)}
              />
              {tt(r.labelKey)}
            </label>
          ))}
          <button type="button" disabled={!reason || busy} onClick={handleCancel}>
            {t('confirmCancel')}
          </button>
          <button type="button" onClick={() => setMode('view')}>
            {t('back')}
          </button>
        </fieldset>
      )}

      <Link href="/tickets">{t('viewUpcoming')}</Link>
    </main>
  );
}
```

- [ ] **Step 4: Add the Upcoming section to `/tickets`**

Replace `apps/customer/app/tickets/page.tsx` with:
```tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';
import { formatSlotDate, formatSlotTime } from '../appointments/SlotPicker';

type Ticket = Database['public']['Tables']['queue_tickets']['Row'];
type Appointment = Database['public']['Tables']['appointments']['Row'];

export default function TicketsPage() {
  const t = useTranslations('Tickets');
  const ta = useTranslations('Appointments');
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [upcoming, setUpcoming] = useState<Appointment[] | null>(null);
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);

  useEffect(() => {
    const channel = supabase
      .channel('my-tickets')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'queue_tickets' }, () => {
        supabase
          .from('queue_tickets')
          .select('*')
          .then(({ data: refreshed }) => setTickets(refreshed ?? []));
      })
      .subscribe();

    supabase
      .from('queue_tickets')
      .select('*')
      .then(({ data }) => setTickets(data ?? []));
    // RLS limits appointments to the signed-in customer's own.
    supabase
      .from('appointments')
      .select('*')
      .eq('status', 'scheduled')
      .gte('scheduled_start', new Date().toISOString())
      .order('scheduled_start')
      .then(({ data }) => setUpcoming(data ?? []));

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase]);

  return (
    <main>
      <h1>{t('title')}</h1>
      <Link href="/profile">Profile</Link>
      <ul>
        {tickets.map((ticket) => (
          <li key={ticket.id}>
            <Link href={`/tickets/${ticket.id}`}>
              {ticket.ticket_number} — {ticket.state}
            </Link>
          </li>
        ))}
      </ul>

      <section aria-labelledby="upcoming-heading">
        <h2 id="upcoming-heading">{ta('upcomingTitle')}</h2>
        {upcoming && upcoming.length === 0 && (
          <div>
            <p>{ta('noUpcoming')}</p>
            <Link href="/">{ta('bookOne')}</Link>
          </div>
        )}
        {upcoming && upcoming.length > 0 && (
          <ul>
            {upcoming.map((a) => (
              <li key={a.id}>
                <Link href={`/appointments/${a.id}`}>
                  {formatSlotDate(a.scheduled_start)} {formatSlotTime(a.scheduled_start)}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
```
(The "Book an appointment" link goes to branch discovery, where a branch's Book Appointment link starts the flow.)

- [ ] **Step 5: Run the e2e test plus the neighbouring customer journeys**

Run: `npx playwright test e2e/appointment-booking.spec.ts e2e/queue-join-now.spec.ts e2e/customer-login.spec.ts --reporter=line --workers=1`
Expected: PASS (queue-join-now proves the Join Now path is unchanged).

- [ ] **Step 6: Lint, typecheck, commit**

Run: `npm run typecheck` and `(cd apps/customer && npx eslint app/appointments app/tickets)` — Expected: no errors.
```bash
git add "apps/customer/app/appointments/[id]/page.tsx" apps/customer/app/tickets/page.tsx e2e/appointment-booking.spec.ts
git commit -m "feat: Upcoming appointments and Appointment Detail with reschedule and cancel"
```

---

## After all tasks (controller)

1. Full suite on staging: `npx vitest run` (re-run any `packages/shared` file whose worker fails to start), then all e2e with both dev servers running.
2. Ask the user before pushing to `origin/main`; on approval, push, then promote to production per `Docs/ops/production-setup.md` §3 (`db push --project-ref yegnbwrmdlhicpzbnldl --dry-run`, then for real; no function deploys are needed).
