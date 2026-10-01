# Appointments Part 2 — Staff Side Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owners, Branch Managers and Receptionists see, book, check in, reschedule, cancel and mark no-show appointments for their branches; barbers see their own appointments for today.

**Architecture:** New `SECURITY DEFINER` staff functions reuse part 1's rule-checker through a new 6-argument variant with a lead-time parameter (customers 1 hour, staff zero). Staff lose direct write access to `appointments`. Conversion learns the `checked_in` status. The staff app gets an Appointments calendar, a staff detail page and a book-for-customer page; Today's Queue gets a read-only list.

**Tech Stack:** Supabase Postgres (plpgsql), Next.js 16 client components, next-intl, supabase-js, Vitest (DB tests against staging), Playwright.

**Spec:** `Docs/superpowers/specs/2026-10-01-appointments-staff-side-design.md`

## Global Constraints

- Staff authority = `has_capability('edit_tickets') and in_branch_scope(<appointment's branch>)` (owner, branch_manager, receptionist; owners in scope everywhere). Anything else → error `not_allowed`.
- Staff limits: slot start `>= now()` (no 1-hour minimum); 14-day horizon, one active appointment per customer per day, branch hours/closures, barber shift/break/skill, no double-booking and "any barber" capacity all still apply. Customer limits unchanged (1 hour).
- `checked_in` counts as active everywhere `scheduled` does (one-per-day, overlaps, capacity, conversion).
- Error strings (exact): `slot_taken`, `already_booked_that_day`, `branch_closed`, `too_soon`, `too_far_ahead`, `service_unavailable`, `not_found`, `too_late`, `not_allowed`, `already_converted`, `invalid_phone`.
- Times are UTC (Ghana = UTC+0); display HH:MM in UTC.
- Every new function: `security definer`, `set search_path = public, pg_temp`; `revoke execute ... from public, anon` (+ `authenticated` for internal ones); grant to `authenticated` for staff/barber functions.
- Already-applied migrations are never edited. `packages/shared/src/database.types.ts` is hand-maintained and must match the SQL.
- Tests run against live staging (`.env.local`); heavy `beforeAll`/`afterAll` get explicit timeouts (`90000`); FK-safe cleanup. Staff JWT claims (role, branch_ids) come from the access-token hook at sign-in, so create branch assignments BEFORE signing a staff client in.
- **Implementer subagents cannot push migrations, deploy, set secrets or run SQL against a live project.** After an implementer commits a migration, the controller pushes it to staging (`set -a && source supabase/.secrets/send-sms.env && set +a && npx supabase db push`); DB tests fail until then — report "ready for push".
- React lint: no synchronous `setState` in effect bodies (`react-hooks/set-state-in-effect`); no `Date.now()`/`new Date()` inside render or `useMemo` (`react-hooks/purity`) — use a lazy `useState` initializer or compute inside effects/handlers.
- E2E: `.press('Enter')`, locators scoped to `page.locator('main')` (Next.js Dev Tools badge; route announcer is `role="alert"`).
- Do not stage `apps/*/next-env.d.ts`, `graphify-out/`, `playwright-report/`, `test-results/`, `supabase/.secrets/`, untracked `Docs/superpowers/plans/2026-09-1*`. No AI-attribution lines in commits.

## Rulings made while planning

1. **A single-appointment read function** `get_branch_appointment(p_appointment_id)` is added alongside the spec's `list_branch_appointments`, sharing one internal row builder, so the staff detail page has a scope-checked source (the spec lists only the day list).
2. **Phone normalisation happens in the app** (`normalizeGhanaPhone`, as walk-ins do); `staff_book_appointment` validates the result is `+233` followed by 9 digits (else `invalid_phone`) and serialises creating the same new customer with an advisory lock on the phone.
3. **Staff SlotPicker is a staff-app copy** (the customer one lives in `apps/customer`), calling `staff_list_appointment_slots`.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20261001090700_appointments_staff_booking.sql` | `checked_in_at` column, 6-arg rule-checker + 5-arg wrapper, `staff_list_appointment_slots`, `staff_book_appointment`, staff select-only policy |
| `supabase/migrations/20261001090800_appointments_staff_manage.sql` | reschedule / cancel / check-in / no-show; `appointment_staff_rows` (internal), `list_branch_appointments`, `get_branch_appointment`, `list_my_appointments_today` |
| `supabase/migrations/20261001090900_appointments_checked_in_conversion.sql` | `activate_due_appointments` handles `checked_in`; active-appointments index includes it |
| `tests/db/fixtures/appointments.ts` | + `createStaffLogin` / `cleanupStaffLogin` |
| `tests/db/appointment-staff-booking.test.ts` | Task 1 |
| `tests/db/appointment-staff-manage.test.ts` | Task 2 |
| `tests/db/appointment-conversion.test.ts` | + checked-in conversion case (Task 3) |
| `packages/shared/src/database.types.ts` | New column + functions |
| `apps/customer/app/tickets/page.tsx`, `apps/customer/app/appointments/[id]/page.tsx`, `apps/customer/messages/en.json` | Customer: Upcoming includes `checked_in`; readable status labels (Task 3) |
| `apps/staff/app/appointments/staffAppointmentErrors.ts` (+ `.test.ts`) | Error string → message key |
| `apps/staff/app/appointments/StaffSlotPicker.tsx` | Date & Time picker on `staff_list_appointment_slots` |
| `apps/staff/app/appointments/page.tsx` | Calendar (day view) |
| `apps/staff/app/appointments/[id]/page.tsx` | Staff detail + actions |
| `apps/staff/app/appointments/new/page.tsx` | Book for a customer |
| `apps/staff/app/queue/today/TodaysAppointments.tsx` + `page.tsx` | Barber read-only list |
| `apps/staff/app/page.tsx`, `apps/staff/messages/en.json` | Home link, `StaffAppointments` messages |
| `e2e/appointments-staff.spec.ts` | Receptionist + barber journey |

---

### Task 1: Rule-checker staff mode, staff slots and staff booking

**Files:**
- Create: `supabase/migrations/20261001090700_appointments_staff_booking.sql`
- Modify: `tests/db/fixtures/appointments.ts` (add `createStaffLogin`, `cleanupStaffLogin`)
- Create: `tests/db/appointment-staff-booking.test.ts`
- Modify: `packages/shared/src/database.types.ts`

**Interfaces:**
- Produces (SQL): `appointment_slot_problem(uuid, uuid, timestamptz, uuid, uuid, interval) returns text` (internal); the existing 5-arg version now wraps it with `interval '1 hour'`; `staff_list_appointment_slots(p_branch_service_id uuid, p_barber_id uuid, p_date date, p_customer_id uuid default null, p_ignore_appointment_id uuid default null) returns setof timestamptz`; `staff_book_appointment(p_branch_service_id uuid, p_barber_id uuid, p_slot_start timestamptz, p_customer_name text, p_customer_phone text) returns uuid`; column `appointments.checked_in_at timestamptz`.
- Produces (TS fixture): `createStaffLogin(f, label, role: 'branch_manager' | 'receptionist', branchId) → { authUserId, staffUserId, name, client }` and `cleanupStaffLogin(f, login)`.

- [ ] **Step 1: Add the staff-login helpers to the fixture**

Append to `tests/db/fixtures/appointments.ts`:
```typescript
/** A signed-in branch_manager/receptionist assigned to `branchId` (assignment made before sign-in,
 * so the JWT carries it). */
export async function createStaffLogin(
  f: AppointmentFixture,
  label: string,
  role: 'branch_manager' | 'receptionist',
  branchId: string,
): Promise<{ authUserId: string; staffUserId: string; name: string; client: Client }> {
  const email = `appt-staff-${label}-${f.suffix}@test.pixelbarber.local`;
  const name = `Appt Staff ${label}`;
  const { data: auth, error: authError } = await f.admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (authError) throw authError;
  const { data: staff, error: staffError } = await f.admin
    .from('staff_users')
    .insert({ auth_user_id: auth.user.id, name, email, role, invite_status: 'accepted' })
    .select('id')
    .single();
  if (staffError) throw staffError;
  const { error: assignError } = await f.admin
    .from('staff_branch_assignments')
    .insert({ staff_user_id: staff.id, branch_id: branchId });
  if (assignError) throw assignError;
  return { authUserId: auth.user.id, staffUserId: staff.id, name, client: await signIn({ email }) };
}

/** Call after the test's appointments are deleted and BEFORE cleanupAppointmentFixture
 * (assignments reference the fixture's branches). */
export async function cleanupStaffLogin(
  f: AppointmentFixture,
  login: { authUserId: string; staffUserId: string },
) {
  await f.admin.from('staff_branch_assignments').delete().eq('staff_user_id', login.staffUserId);
  await f.admin.from('staff_users').delete().eq('id', login.staffUserId);
  await f.admin.auth.admin.deleteUser(login.authUserId);
}
```

- [ ] **Step 2: Write the failing test**

`tests/db/appointment-staff-booking.test.ts`:
```typescript
// tests/db/appointment-staff-booking.test.ts
// @vitest-environment node
// staff_list_appointment_slots / staff_book_appointment: staff limits (no 1-hour minimum), find-or-
// create customer by phone, branch scope, and that staff can no longer write appointments directly.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  cleanupStaffLogin,
  createAppointmentFixture,
  createStaffLogin,
  dateAt,
  slotAt,
  type AppointmentFixture,
} from './fixtures/appointments';

let f: AppointmentFixture;
let reception: Awaited<ReturnType<typeof createStaffLogin>>;
let otherManager: Awaited<ReturnType<typeof createStaffLogin>>;
const createdCustomerIds: string[] = [];

/** The next 30-minute grid slot that is still in the future (0–30 minutes away). */
function nextGridSlot(): string {
  return new Date(Math.ceil((Date.now() + 60_000) / 1_800_000) * 1_800_000).toISOString();
}

beforeAll(async () => {
  f = await createAppointmentFixture();
  reception = await createStaffLogin(f, 'rec', 'receptionist', f.branchId);
  otherManager = await createStaffLogin(f, 'mgr', 'branch_manager', f.closedBranchId);
}, 90000);

afterAll(async () => {
  await f.admin.from('appointments').delete().in('branch_id', [f.branchId, f.closedBranchId]);
  await cleanupStaffLogin(f, reception);
  await cleanupStaffLogin(f, otherManager);
  if (createdCustomerIds.length > 0) {
    await f.admin.from('customers').delete().in('id', createdCustomerIds);
  }
  await cleanupAppointmentFixture(f);
}, 90000);

describe('staff_list_appointment_slots', () => {
  it('offers slots inside the hour that customers cannot book', async (ctx) => {
    const soon = nextGridSlot();
    const day = soon.slice(0, 10);
    // Barber B has no break, so the only reason a customer can't take this slot is the 1-hour rule.
    if (day !== dateAt(0)) ctx.skip(); // crossed UTC midnight
    const { data: staffSlots, error } = await reception.client.rpc('staff_list_appointment_slots', {
      p_branch_service_id: f.branchServiceId,
      p_barber_id: f.barberB.barberId,
      p_date: day,
    });
    expect(error).toBeNull();
    expect((staffSlots ?? []).map((s) => new Date(s).toISOString())).toContain(soon);
    const { data: customerSlots } = await f.customers[0].client.rpc('list_appointment_slots', {
      p_branch_service_id: f.branchServiceId,
      p_barber_id: f.barberB.barberId,
      p_date: day,
    });
    expect((customerSlots ?? []).map((s) => new Date(s).toISOString())).not.toContain(soon);
  });

  it('refuses a manager of another branch', async () => {
    const { error } = await otherManager.client.rpc('staff_list_appointment_slots', {
      p_branch_service_id: f.branchServiceId,
      p_barber_id: null,
      p_date: dateAt(2),
    });
    expect(error?.message).toBe('not_allowed');
  });
});

describe('staff_book_appointment', () => {
  it('books for an existing customer found by phone, recorded as staff-created', async () => {
    const { data: id, error } = await reception.client.rpc('staff_book_appointment', {
      p_branch_service_id: f.branchServiceId,
      p_barber_id: f.barberA.barberId,
      p_slot_start: slotAt(2, '10:00'),
      p_customer_name: 'Ignored For Existing',
      p_customer_phone: f.customers[0].phone,
    });
    expect(error).toBeNull();
    const { data: row } = await f.admin.from('appointments').select('*').eq('id', id!).single();
    expect(row).toMatchObject({
      customer_id: f.customers[0].customerId,
      created_by: 'staff',
      created_by_staff_id: reception.staffUserId,
      status: 'scheduled',
    });
  });

  it('creates a new customer for an unknown phone, and one with no phone', async () => {
    const phone = `+233559${f.suffix.slice(-6)}`;
    const { data: id, error } = await reception.client.rpc('staff_book_appointment', {
      p_branch_service_id: f.branchServiceId,
      p_barber_id: null,
      p_slot_start: slotAt(2, '11:00'),
      p_customer_name: 'Phone-in Customer',
      p_customer_phone: phone,
    });
    expect(error).toBeNull();
    const { data: row } = await f.admin
      .from('appointments')
      .select('customer_id, customers(name, phone_e164)')
      .eq('id', id!)
      .single();
    createdCustomerIds.push(row!.customer_id);
    expect(row!.customers).toMatchObject({ name: 'Phone-in Customer', phone_e164: phone });

    const { data: id2, error: e2 } = await reception.client.rpc('staff_book_appointment', {
      p_branch_service_id: f.branchServiceId,
      p_barber_id: null,
      p_slot_start: slotAt(2, '11:30'),
      p_customer_name: 'No Phone Customer',
      p_customer_phone: null,
    });
    expect(e2).toBeNull();
    const { data: row2 } = await f.admin
      .from('appointments')
      .select('customer_id, customers(phone_e164)')
      .eq('id', id2!)
      .single();
    createdCustomerIds.push(row2!.customer_id);
    expect(row2!.customers).toMatchObject({ phone_e164: null });
  });

  it('still refuses double-booking, a second same-day booking and a bad phone', async () => {
    const taken = await reception.client.rpc('staff_book_appointment', {
      p_branch_service_id: f.branchServiceId,
      p_barber_id: f.barberA.barberId,
      p_slot_start: slotAt(2, '10:00'),
      p_customer_name: 'Someone',
      p_customer_phone: f.customers[1].phone,
    });
    expect(taken.error?.message).toBe('slot_taken');
    const sameDay = await reception.client.rpc('staff_book_appointment', {
      p_branch_service_id: f.branchServiceId,
      p_barber_id: f.barberB.barberId,
      p_slot_start: slotAt(2, '15:00'),
      p_customer_name: 'x',
      p_customer_phone: f.customers[0].phone,
    });
    expect(sameDay.error?.message).toBe('already_booked_that_day');
    const badPhone = await reception.client.rpc('staff_book_appointment', {
      p_branch_service_id: f.branchServiceId,
      p_barber_id: null,
      p_slot_start: slotAt(3, '10:00'),
      p_customer_name: 'x',
      p_customer_phone: '0244',
    });
    expect(badPhone.error?.message).toBe('invalid_phone');
  });

  it('refuses a slot that has already started, and callers without authority', async () => {
    const past = new Date(Math.floor(Date.now() / 1_800_000) * 1_800_000).toISOString();
    const started = await reception.client.rpc('staff_book_appointment', {
      p_branch_service_id: f.branchServiceId,
      p_barber_id: null,
      p_slot_start: past,
      p_customer_name: 'x',
      p_customer_phone: f.customers[2].phone,
    });
    expect(started.error?.message).toBe('too_soon');
    for (const client of [otherManager.client, f.barberClient, f.customers[3].client]) {
      const { error } = await client.rpc('staff_book_appointment', {
        p_branch_service_id: f.branchServiceId,
        p_barber_id: null,
        p_slot_start: slotAt(4, '10:00'),
        p_customer_name: 'x',
        p_customer_phone: f.customers[3].phone,
      });
      expect(error?.message).toBe('not_allowed');
    }
  });
});

describe('direct writes', () => {
  it('staff can read but no longer insert or update appointments directly', async () => {
    const { data: visible } = await reception.client
      .from('appointments')
      .select('id')
      .eq('branch_id', f.branchId);
    expect((visible ?? []).length).toBeGreaterThan(0);
    const { error: insertError } = await reception.client.from('appointments').insert({
      customer_id: f.customers[2].customerId,
      branch_id: f.branchId,
      branch_service_id: f.branchServiceId,
      scheduled_start: slotAt(5, '10:00'),
      scheduled_end: slotAt(5, '10:30'),
      created_by: 'staff',
    });
    expect(insertError).not.toBeNull();
    const { data: updated } = await reception.client
      .from('appointments')
      .update({ status: 'cancelled' })
      .eq('id', visible![0].id)
      .select();
    expect(updated ?? []).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run tests/db/appointment-staff-booking.test.ts`
Expected: FAIL — `staff_list_appointment_slots` / `staff_book_appointment` don't exist.

- [ ] **Step 4: Write the migration**

`supabase/migrations/20261001090700_appointments_staff_booking.sql`:
```sql
-- Appointments part 2 (Docs/superpowers/specs/2026-10-01-appointments-staff-side-design.md):
-- staff booking with looser limits, the checked_in_at column, and staff read-only table access.

alter table appointments add column if not exists checked_in_at timestamptz;

-- The rule-checker with a minimum lead time: customers 1 hour (5-arg wrapper below), staff zero.
-- 'checked_in' counts as active everywhere 'scheduled' does. Otherwise identical to 20261001090120.
create or replace function appointment_slot_problem(
  p_branch_service_id uuid,
  p_barber_id uuid,
  p_slot_start timestamptz,
  p_customer_id uuid,
  p_ignore_appointment_id uuid,
  p_min_lead interval
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

  if p_slot_start < now() + p_min_lead then
    return 'too_soon';
  end if;
  if v_date > (now() at time zone 'UTC')::date + 14 then
    return 'too_far_ahead';
  end if;
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
      and a.status in ('scheduled', 'checked_in')
      and (a.scheduled_start at time zone 'UTC')::date = v_date
      and a.id is distinct from p_ignore_appointment_id
  ) then
    return 'already_booked_that_day';
  end if;

  with overlapping as (
    select a.preferred_barber_id
    from appointments a
    where a.branch_id = v_branch_id
      and a.status in ('scheduled', 'checked_in', 'converted')
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
         count(*) filter (where skilled),
         (select count(*) from overlapping where preferred_barber_id is null)
    into v_suitable_free, v_pool, v_any
  from working;

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

revoke execute on function appointment_slot_problem(uuid, uuid, timestamptz, uuid, uuid, interval)
  from public, anon, authenticated;

-- Part 1 callers (customer listing, booking, rescheduling) keep the 1-hour minimum.
create or replace function appointment_slot_problem(
  p_branch_service_id uuid,
  p_barber_id uuid,
  p_slot_start timestamptz,
  p_customer_id uuid,
  p_ignore_appointment_id uuid
) returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select appointment_slot_problem(
    p_branch_service_id, p_barber_id, p_slot_start, p_customer_id, p_ignore_appointment_id,
    interval '1 hour'
  );
$$;

revoke execute on function appointment_slot_problem(uuid, uuid, timestamptz, uuid, uuid)
  from public, anon, authenticated;

create or replace function staff_list_appointment_slots(
  p_branch_service_id uuid,
  p_barber_id uuid,
  p_date date,
  p_customer_id uuid default null,
  p_ignore_appointment_id uuid default null
) returns setof timestamptz
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_branch_id uuid;
begin
  select branch_id into v_branch_id from branch_services where id = p_branch_service_id;
  if v_branch_id is null or not (has_capability('edit_tickets') and in_branch_scope(v_branch_id)) then
    raise exception 'not_allowed';
  end if;
  return query
    select slot
    from generate_series(
      p_date::timestamp at time zone 'UTC',
      (p_date::timestamp + interval '23 hours 30 minutes') at time zone 'UTC',
      interval '30 minutes'
    ) as slot
    where appointment_slot_problem(
      p_branch_service_id, p_barber_id, slot, p_customer_id, p_ignore_appointment_id, interval '0'
    ) is null
    order by slot;
end;
$$;

revoke execute on function staff_list_appointment_slots(uuid, uuid, date, uuid, uuid) from public, anon;
grant execute on function staff_list_appointment_slots(uuid, uuid, date, uuid, uuid) to authenticated;

create or replace function staff_book_appointment(
  p_branch_service_id uuid,
  p_barber_id uuid,
  p_slot_start timestamptz,
  p_customer_name text,
  p_customer_phone text
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_branch_id uuid;
  v_duration int;
  v_customer_id uuid;
  v_problem text;
  v_id uuid;
begin
  select bs.branch_id, coalesce(bs.duration_minutes_override, s.default_duration_minutes)
    into v_branch_id, v_duration
  from branch_services bs join services s on s.id = bs.service_id
  where bs.id = p_branch_service_id;
  if v_branch_id is null or not (has_capability('edit_tickets') and in_branch_scope(v_branch_id)) then
    raise exception 'not_allowed';
  end if;
  if p_customer_phone is not null and p_customer_phone !~ '^\+233[0-9]{9}$' then
    raise exception 'invalid_phone';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('appointments:branch:' || v_branch_id::text, 0));

  -- Find or create the customer (by phone; no phone = always a new customer), like walk-ins.
  if p_customer_phone is not null then
    perform pg_advisory_xact_lock(hashtextextended('customers:phone:' || p_customer_phone, 0));
    select id into v_customer_id from customers where phone_e164 = p_customer_phone;
  end if;
  if v_customer_id is null then
    insert into customers (name, phone_e164)
      values (coalesce(nullif(trim(p_customer_name), ''), 'Customer'), p_customer_phone)
      returning id into v_customer_id;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('appointments:customer:' || v_customer_id::text, 0));

  v_problem := appointment_slot_problem(
    p_branch_service_id, p_barber_id, p_slot_start, v_customer_id, null, interval '0'
  );
  if v_problem is not null then
    raise exception '%', v_problem;
  end if;

  insert into appointments (
    customer_id, branch_id, branch_service_id, preferred_barber_id,
    scheduled_start, scheduled_end, status, created_by, created_by_staff_id
  ) values (
    v_customer_id, v_branch_id, p_branch_service_id, p_barber_id,
    p_slot_start, p_slot_start + make_interval(mins => v_duration), 'scheduled', 'staff',
    auth_staff_id()
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function staff_book_appointment(uuid, uuid, timestamptz, text, text) from public, anon;
grant execute on function staff_book_appointment(uuid, uuid, timestamptz, text, text) to authenticated;

-- Staff read appointments directly but write only through the staff functions.
drop policy if exists appointments_staff_branch_scope on appointments;
create policy appointments_staff_select on appointments for select
  using (in_branch_scope(branch_id) and has_capability('edit_tickets'));
```
(Lock order — branch, then customer — matches `book_appointment`; the phone lock only serialises creating the same new customer. If the slot check then fails, the whole transaction rolls back, including a newly created customer.)

- [ ] **Step 5: Add the types**

In `packages/shared/src/database.types.ts`:
- `appointments` `Row`: add `checked_in_at: string | null;`; `Insert`/`Update`: `checked_in_at?: string | null;`.
- `Functions` (alphabetical):
```typescript
      staff_book_appointment: {
        Args: {
          p_branch_service_id: string;
          p_barber_id: string | null;
          p_slot_start: string;
          p_customer_name: string;
          p_customer_phone: string | null;
        };
        Returns: string;
      };
      staff_list_appointment_slots: {
        Args: {
          p_branch_service_id: string;
          p_barber_id: string | null;
          p_date: string;
          p_customer_id?: string | null;
          p_ignore_appointment_id?: string | null;
        };
        Returns: string[];
      };
```

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck` — Expected: PASS.
```bash
git add supabase/migrations/20261001090700_appointments_staff_booking.sql tests/db/fixtures/appointments.ts tests/db/appointment-staff-booking.test.ts packages/shared/src/database.types.ts
git commit -m "feat: staff appointment booking with looser limits"
```
Report "ready for push".

- [ ] **Step 7 (controller): push to staging, run the new test and part 1's**

```bash
set -a && source supabase/.secrets/send-sms.env && set +a && npx supabase db push
npx vitest run tests/db/appointment-staff-booking.test.ts tests/db/appointment-booking.test.ts tests/db/appointment-cancel-reschedule.test.ts
```
Expected: PASS (part 1 tests prove the wrapper keeps customer behaviour).

---

### Task 2: Staff management actions and read functions

**Files:**
- Create: `supabase/migrations/20261001090800_appointments_staff_manage.sql`
- Create: `tests/db/appointment-staff-manage.test.ts`
- Modify: `packages/shared/src/database.types.ts`

**Interfaces:**
- Consumes: Task 1's 6-arg `appointment_slot_problem`, `createStaffLogin`/`cleanupStaffLogin`, `staff_book_appointment`.
- Produces (SQL): `staff_reschedule_appointment(p_appointment_id uuid, p_slot_start timestamptz) returns void`; `staff_cancel_appointment(p_appointment_id uuid, p_reason cancel_reason) returns void`; `staff_check_in_appointment(p_appointment_id uuid) returns void`; `staff_mark_appointment_no_show(p_appointment_id uuid) returns void`; `list_branch_appointments(p_branch_id uuid, p_date date)` and `get_branch_appointment(p_appointment_id uuid)` returning the staff row type; `list_my_appointments_today()` returning `(id uuid, scheduled_start timestamptz, customer_first_name text, status appointment_status)`.
- Staff row type: `id uuid, branch_id uuid, branch_name text, branch_service_id uuid, service_name text, price_ghs numeric, scheduled_start timestamptz, scheduled_end timestamptz, status appointment_status, customer_id uuid, customer_name text, customer_phone text, preferred_barber_id uuid, barber_name text, created_by ticket_created_by, created_by_staff_name text, checked_in_at timestamptz, ticket_id uuid`.

- [ ] **Step 1: Write the failing test**

`tests/db/appointment-staff-manage.test.ts`:
```typescript
// tests/db/appointment-staff-manage.test.ts
// @vitest-environment node
// Staff reschedule / cancel / check-in / no-show, the branch day list and single read (scope-checked),
// and the barber's own "today" list.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  cleanupStaffLogin,
  createAppointmentFixture,
  createStaffLogin,
  dateAt,
  slotAt,
  type AppointmentFixture,
} from './fixtures/appointments';

let f: AppointmentFixture;
let reception: Awaited<ReturnType<typeof createStaffLogin>>;
let otherManager: Awaited<ReturnType<typeof createStaffLogin>>;
let apptId: string;

async function staffBook(customerIdx: number, barberId: string | null, slot: string) {
  const { data, error } = await reception.client.rpc('staff_book_appointment', {
    p_branch_service_id: f.branchServiceId,
    p_barber_id: barberId,
    p_slot_start: slot,
    p_customer_name: 'x',
    p_customer_phone: f.customers[customerIdx].phone,
  });
  if (error) throw error;
  return data!;
}

async function pastAppointment(customerIdx: number, barberId: string | null) {
  // Started 5 minutes ago, still 'scheduled' (e.g. waiting for a barber) — inserted directly.
  const start = new Date(Date.now() - 5 * 60_000);
  const { data, error } = await f.admin
    .from('appointments')
    .insert({
      customer_id: f.customers[customerIdx].customerId,
      branch_id: f.branchId,
      branch_service_id: f.branchServiceId,
      preferred_barber_id: barberId,
      scheduled_start: start.toISOString(),
      scheduled_end: new Date(start.getTime() + 30 * 60_000).toISOString(),
      status: 'scheduled',
      created_by: 'customer',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

beforeAll(async () => {
  f = await createAppointmentFixture();
  reception = await createStaffLogin(f, 'rec', 'receptionist', f.branchId);
  otherManager = await createStaffLogin(f, 'mgr', 'branch_manager', f.closedBranchId);
  apptId = await staffBook(0, f.barberA.barberId, slotAt(2, '10:00'));
}, 90000);

afterAll(async () => {
  await f.admin.from('appointments').delete().in('branch_id', [f.branchId, f.closedBranchId]);
  await cleanupStaffLogin(f, reception);
  await cleanupStaffLogin(f, otherManager);
  await cleanupAppointmentFixture(f);
}, 90000);

describe('reading', () => {
  it('lists the day for in-scope staff with names, and refuses out-of-scope staff', async () => {
    const { data, error } = await reception.client.rpc('list_branch_appointments', {
      p_branch_id: f.branchId,
      p_date: dateAt(2),
    });
    expect(error).toBeNull();
    const row = (data ?? []).find((r) => r.id === apptId);
    expect(row).toMatchObject({
      customer_name: 'Appt Customer 0',
      customer_phone: f.customers[0].phone,
      barber_name: 'Appt Barber a',
      created_by: 'staff',
      created_by_staff_name: reception.name,
      status: 'scheduled',
    });
    const other = await otherManager.client.rpc('list_branch_appointments', {
      p_branch_id: f.branchId,
      p_date: dateAt(2),
    });
    expect(other.error?.message).toBe('not_allowed');
    const single = await reception.client.rpc('get_branch_appointment', { p_appointment_id: apptId });
    expect(single.data?.[0]?.id).toBe(apptId);
    const singleOther = await otherManager.client.rpc('get_branch_appointment', {
      p_appointment_id: apptId,
    });
    expect(singleOther.error?.message).toBe('not_allowed');
  });
});

describe('actions', () => {
  it('checks in, then reschedules a checked-in appointment', async () => {
    expect(
      (await reception.client.rpc('staff_check_in_appointment', { p_appointment_id: apptId })).error,
    ).toBeNull();
    const { data: after } = await f.admin.from('appointments').select('*').eq('id', apptId).single();
    expect(after).toMatchObject({ status: 'checked_in' });
    expect(after!.checked_in_at).not.toBeNull();
    const again = await reception.client.rpc('staff_check_in_appointment', { p_appointment_id: apptId });
    expect(again.error?.message).toBe('too_late');

    const moved = await reception.client.rpc('staff_reschedule_appointment', {
      p_appointment_id: apptId,
      p_slot_start: slotAt(2, '14:00'),
    });
    expect(moved.error).toBeNull();
    const { data: row } = await f.admin.from('appointments').select('*').eq('id', apptId).single();
    expect(new Date(row!.scheduled_start).toISOString()).toBe(slotAt(2, '14:00'));
    expect(row!.status).toBe('checked_in');
  });

  it('refuses no-show before the start, allows it after', async () => {
    const early = await reception.client.rpc('staff_mark_appointment_no_show', {
      p_appointment_id: apptId,
    });
    expect(early.error?.message).toBe('too_late');
    const pastId = await pastAppointment(1, null);
    expect(
      (await reception.client.rpc('staff_mark_appointment_no_show', { p_appointment_id: pastId }))
        .error,
    ).toBeNull();
    const { data } = await f.admin.from('appointments').select('status').eq('id', pastId).single();
    expect(data!.status).toBe('no_show');
  });

  it('cancels any time before conversion, but never with branch_closed', async () => {
    const forbidden = await reception.client.rpc('staff_cancel_appointment', {
      p_appointment_id: apptId,
      p_reason: 'branch_closed',
    });
    expect(forbidden.error?.message).toBe('not_allowed');
    expect(
      (
        await reception.client.rpc('staff_cancel_appointment', {
          p_appointment_id: apptId,
          p_reason: 'cant_make_it',
        })
      ).error,
    ).toBeNull();
    const { data } = await f.admin.from('appointments').select('*').eq('id', apptId).single();
    expect(data).toMatchObject({ status: 'cancelled', cancel_reason: 'cant_make_it' });
  });

  it('refuses actions on a converted appointment and from out-of-scope staff', async () => {
    const id = await staffBook(2, null, slotAt(3, '10:00'));
    const outOfScope = await otherManager.client.rpc('staff_cancel_appointment', {
      p_appointment_id: id,
      p_reason: 'other',
    });
    expect(outOfScope.error?.message).toBe('not_allowed');
    await f.admin.from('appointments').update({ status: 'converted' }).eq('id', id);
    const converted = await reception.client.rpc('staff_cancel_appointment', {
      p_appointment_id: id,
      p_reason: 'other',
    });
    expect(converted.error?.message).toBe('already_converted');
  });
});

describe('list_my_appointments_today', () => {
  it("returns only the calling barber's appointments today, with first names", async () => {
    const todayId = await pastAppointment(3, f.barberA.barberId);
    const { data, error } = await f.barberClient.rpc('list_my_appointments_today');
    expect(error).toBeNull();
    const row = (data ?? []).find((r) => r.id === todayId);
    expect(row).toMatchObject({ customer_first_name: 'Appt' });
    expect((data ?? []).every((r) => r.id !== apptId)).toBe(true);
    const fromCustomer = await f.customers[0].client.rpc('list_my_appointments_today');
    expect(fromCustomer.data ?? []).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/db/appointment-staff-manage.test.ts`
Expected: FAIL — functions don't exist.

- [ ] **Step 3: Write the migration**

`supabase/migrations/20261001090800_appointments_staff_manage.sql`:
```sql
-- Appointments part 2: staff actions (reschedule, cancel, check-in, no-show) and reads (branch day
-- list, single appointment, barber's own today list). Every action re-checks capability + scope.

-- Locks and loads an appointment the caller may manage; raises not_found / not_allowed /
-- already_converted / too_late as appropriate. Internal only.
create or replace function staff_lock_appointment(p_appointment_id uuid)
returns appointments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_appt appointments%rowtype;
begin
  select * into v_appt from appointments where id = p_appointment_id for update;
  if not found then
    raise exception 'not_found';
  end if;
  if not (has_capability('edit_tickets') and in_branch_scope(v_appt.branch_id)) then
    raise exception 'not_allowed';
  end if;
  if v_appt.status = 'converted' then
    raise exception 'already_converted';
  end if;
  if v_appt.status not in ('scheduled', 'checked_in') then
    raise exception 'too_late';
  end if;
  return v_appt;
end;
$$;

revoke execute on function staff_lock_appointment(uuid) from public, anon, authenticated;

create or replace function staff_reschedule_appointment(p_appointment_id uuid, p_slot_start timestamptz)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_branch_id uuid;
  v_customer_id uuid;
  v_appt appointments%rowtype;
  v_duration int;
  v_problem text;
begin
  select branch_id, customer_id into v_branch_id, v_customer_id
  from appointments where id = p_appointment_id;
  if v_branch_id is null then
    raise exception 'not_found';
  end if;
  if not (has_capability('edit_tickets') and in_branch_scope(v_branch_id)) then
    raise exception 'not_allowed';
  end if;
  -- Same lock order as booking (branch, then customer).
  perform pg_advisory_xact_lock(hashtextextended('appointments:branch:' || v_branch_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('appointments:customer:' || v_customer_id::text, 0));

  v_appt := staff_lock_appointment(p_appointment_id);
  v_problem := appointment_slot_problem(
    v_appt.branch_service_id, v_appt.preferred_barber_id, p_slot_start, v_appt.customer_id,
    v_appt.id, interval '0'
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

revoke execute on function staff_reschedule_appointment(uuid, timestamptz) from public, anon;
grant execute on function staff_reschedule_appointment(uuid, timestamptz) to authenticated;

create or replace function staff_cancel_appointment(p_appointment_id uuid, p_reason cancel_reason)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_reason = 'branch_closed' then
    raise exception 'not_allowed';
  end if;
  perform staff_lock_appointment(p_appointment_id);
  update appointments
    set status = 'cancelled', cancel_reason = p_reason, cancelled_at = now(), version = version + 1
    where id = p_appointment_id;
end;
$$;

revoke execute on function staff_cancel_appointment(uuid, cancel_reason) from public, anon;
grant execute on function staff_cancel_appointment(uuid, cancel_reason) to authenticated;

create or replace function staff_check_in_appointment(p_appointment_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_appt appointments%rowtype;
begin
  v_appt := staff_lock_appointment(p_appointment_id);
  if v_appt.status <> 'scheduled' then
    raise exception 'too_late';
  end if;
  update appointments
    set status = 'checked_in', checked_in_at = now(), version = version + 1
    where id = p_appointment_id;
end;
$$;

revoke execute on function staff_check_in_appointment(uuid) from public, anon;
grant execute on function staff_check_in_appointment(uuid) to authenticated;

create or replace function staff_mark_appointment_no_show(p_appointment_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_appt appointments%rowtype;
begin
  v_appt := staff_lock_appointment(p_appointment_id);
  if v_appt.scheduled_start > now() then
    raise exception 'too_late';
  end if;
  update appointments set status = 'no_show', version = version + 1 where id = p_appointment_id;
end;
$$;

revoke execute on function staff_mark_appointment_no_show(uuid) from public, anon;
grant execute on function staff_mark_appointment_no_show(uuid) to authenticated;

-- One row builder for the day list and the single read. Internal only (callers check scope).
create or replace function appointment_staff_rows(p_branch_id uuid, p_date date, p_appointment_id uuid)
returns table (
  id uuid, branch_id uuid, branch_name text, branch_service_id uuid, service_name text,
  price_ghs numeric, scheduled_start timestamptz, scheduled_end timestamptz,
  status appointment_status, customer_id uuid, customer_name text, customer_phone text,
  preferred_barber_id uuid, barber_name text, created_by ticket_created_by,
  created_by_staff_name text, checked_in_at timestamptz, ticket_id uuid
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.id, a.branch_id, br.name, a.branch_service_id, s.name, p.price_ghs,
         a.scheduled_start, a.scheduled_end, a.status, a.customer_id, c.name, c.phone_e164,
         a.preferred_barber_id, bsu.name, a.created_by, csu.name, a.checked_in_at,
         (select qt.id from queue_tickets qt where qt.appointment_id = a.id
          order by qt.created_at desc limit 1)
  from appointments a
  join branches br on br.id = a.branch_id
  join branch_services bs on bs.id = a.branch_service_id
  join services s on s.id = bs.service_id
  join customers c on c.id = a.customer_id
  left join current_branch_service_price p on p.branch_service_id = a.branch_service_id
  left join barbers b on b.id = a.preferred_barber_id
  left join staff_users bsu on bsu.id = b.staff_user_id
  left join staff_users csu on csu.id = a.created_by_staff_id
  where (p_appointment_id is not null and a.id = p_appointment_id)
     or (p_appointment_id is null and a.branch_id = p_branch_id
         and (a.scheduled_start at time zone 'UTC')::date = p_date)
  order by a.scheduled_start;
$$;

revoke execute on function appointment_staff_rows(uuid, date, uuid) from public, anon, authenticated;

create or replace function list_branch_appointments(p_branch_id uuid, p_date date)
returns table (
  id uuid, branch_id uuid, branch_name text, branch_service_id uuid, service_name text,
  price_ghs numeric, scheduled_start timestamptz, scheduled_end timestamptz,
  status appointment_status, customer_id uuid, customer_name text, customer_phone text,
  preferred_barber_id uuid, barber_name text, created_by ticket_created_by,
  created_by_staff_name text, checked_in_at timestamptz, ticket_id uuid
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not (has_capability('edit_tickets') and in_branch_scope(p_branch_id)) then
    raise exception 'not_allowed';
  end if;
  return query select * from appointment_staff_rows(p_branch_id, p_date, null);
end;
$$;

revoke execute on function list_branch_appointments(uuid, date) from public, anon;
grant execute on function list_branch_appointments(uuid, date) to authenticated;

create or replace function get_branch_appointment(p_appointment_id uuid)
returns table (
  id uuid, branch_id uuid, branch_name text, branch_service_id uuid, service_name text,
  price_ghs numeric, scheduled_start timestamptz, scheduled_end timestamptz,
  status appointment_status, customer_id uuid, customer_name text, customer_phone text,
  preferred_barber_id uuid, barber_name text, created_by ticket_created_by,
  created_by_staff_name text, checked_in_at timestamptz, ticket_id uuid
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_branch_id uuid;
begin
  select a.branch_id into v_branch_id from appointments a where a.id = p_appointment_id;
  if v_branch_id is null then
    return;
  end if;
  if not (has_capability('edit_tickets') and in_branch_scope(v_branch_id)) then
    raise exception 'not_allowed';
  end if;
  return query select * from appointment_staff_rows(null, null, p_appointment_id);
end;
$$;

revoke execute on function get_branch_appointment(uuid) from public, anon;
grant execute on function get_branch_appointment(uuid) to authenticated;

-- A barber's own appointments today (scheduled / checked in), first names only.
create or replace function list_my_appointments_today()
returns table (id uuid, scheduled_start timestamptz, customer_first_name text, status appointment_status)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.id, a.scheduled_start, split_part(trim(c.name), ' ', 1), a.status
  from appointments a
  join barbers b on b.id = a.preferred_barber_id
  join customers c on c.id = a.customer_id
  where b.staff_user_id = auth_staff_id()
    and a.status in ('scheduled', 'checked_in')
    and (a.scheduled_start at time zone 'UTC')::date = (now() at time zone 'UTC')::date
  order by a.scheduled_start;
$$;

revoke execute on function list_my_appointments_today() from public, anon;
grant execute on function list_my_appointments_today() to authenticated;
```

- [ ] **Step 4: Add the types**

In `packages/shared/src/database.types.ts` `Functions` (alphabetical):
```typescript
      get_branch_appointment: {
        Args: { p_appointment_id: string };
        Returns: {
          id: string;
          branch_id: string;
          branch_name: string;
          branch_service_id: string;
          service_name: string;
          price_ghs: number | null;
          scheduled_start: string;
          scheduled_end: string;
          status: Database['public']['Enums']['appointment_status'];
          customer_id: string;
          customer_name: string;
          customer_phone: string | null;
          preferred_barber_id: string | null;
          barber_name: string | null;
          created_by: Database['public']['Enums']['ticket_created_by'];
          created_by_staff_name: string | null;
          checked_in_at: string | null;
          ticket_id: string | null;
        }[];
      };
      list_branch_appointments: {
        Args: { p_branch_id: string; p_date: string };
        Returns: Database['public']['Functions']['get_branch_appointment']['Returns'];
      };
      list_my_appointments_today: {
        Args: never;
        Returns: {
          id: string;
          scheduled_start: string;
          customer_first_name: string;
          status: Database['public']['Enums']['appointment_status'];
        }[];
      };
      staff_cancel_appointment: {
        Args: {
          p_appointment_id: string;
          p_reason: Database['public']['Enums']['cancel_reason'];
        };
        Returns: undefined;
      };
      staff_check_in_appointment: { Args: { p_appointment_id: string }; Returns: undefined };
      staff_mark_appointment_no_show: { Args: { p_appointment_id: string }; Returns: undefined };
      staff_reschedule_appointment: {
        Args: { p_appointment_id: string; p_slot_start: string };
        Returns: undefined;
      };
```
(If the self-reference in `list_branch_appointments` makes typecheck fail, repeat the object literal.)

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` — Expected: PASS.
```bash
git add supabase/migrations/20261001090800_appointments_staff_manage.sql tests/db/appointment-staff-manage.test.ts packages/shared/src/database.types.ts
git commit -m "feat: staff appointment actions and branch appointment lists"
```
Report "ready for push".

- [ ] **Step 6 (controller): push to staging and run**

```bash
set -a && source supabase/.secrets/send-sms.env && set +a && npx supabase db push
npx vitest run tests/db/appointment-staff-manage.test.ts tests/db/appointment-staff-booking.test.ts
```
Expected: PASS.

---

### Task 3: Checked-in conversion and customer display

**Files:**
- Create: `supabase/migrations/20261001090900_appointments_checked_in_conversion.sql`
- Modify: `tests/db/appointment-conversion.test.ts` (one new case)
- Modify: `apps/customer/app/tickets/page.tsx`, `apps/customer/app/appointments/[id]/page.tsx`, `apps/customer/messages/en.json`, `e2e/appointment-booking.spec.ts`

**Interfaces:**
- Consumes: `appointments.checked_in_at` (Task 1).
- Produces: `activate_due_appointments()` converting `scheduled` and `checked_in`; tickets from checked-in appointments carry `checked_in_at` and `check_in_method = 'staff'`.

- [ ] **Step 1: Add the failing conversion test**

In `tests/db/appointment-conversion.test.ts`, add as the LAST test inside `describe('activate_due_appointments')`:
```typescript
  it('converts a checked-in appointment into a ticket already marked present', async () => {
    const customerIdx = 1;
    await f.admin
      .from('queue_tickets')
      .update({ state: 'completed' })
      .eq('customer_id', f.customers[customerIdx].customerId)
      .not('state', 'in', '(completed,cancelled,no_show)');
    const checkedInAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const id = await dueAppointment(customerIdx, f.barberA.barberId);
    await f.admin
      .from('appointments')
      .update({ status: 'checked_in', checked_in_at: checkedInAt })
      .eq('id', id);
    await activate();
    const [ticket] = await ticketsFor(id);
    expect(ticket).toBeDefined();
    expect(ticket.check_in_method).toBe('staff');
    expect(new Date(ticket.checked_in_at!).toISOString()).toBe(checkedInAt);
    const { data } = await f.admin.from('appointments').select('status').eq('id', id).single();
    expect(data!.status).toBe('converted');
  });
```
(Uses the file's existing `dueAppointment`, `activate`, `ticketsFor`; if barber A is not eligible at that point in the file's sequence, restore barber statuses first — check the earlier tests' state changes.)

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/db/appointment-conversion.test.ts` — Expected: the new test FAILS (no ticket).

- [ ] **Step 3: Write the migration**

`supabase/migrations/20261001090900_appointments_checked_in_conversion.sql`: header comment, then `create or replace function activate_due_appointments()` identical to `20261001090500_appointment_final_fixes.sql`'s version except:
- the loop's query: `where status in ('scheduled', 'checked_in') and scheduled_start <= now()`;
- in the existing-ticket path, inside `if v_rows = 1 then`, first run:
  ```sql
  if v_appt.status = 'checked_in' then
    update queue_tickets
      set checked_in_at = coalesce(checked_in_at, v_appt.checked_in_at),
          check_in_method = coalesce(check_in_method, 'staff')
      where id = v_existing.id;
  end if;
  ```
- the ticket insert adds columns `checked_in_at, check_in_method` with values `case when v_appt.status = 'checked_in' then v_appt.checked_in_at end, case when v_appt.status = 'checked_in' then 'staff'::check_in_method end`.

Re-state `revoke execute on function activate_due_appointments() from public, anon, authenticated; grant execute on function activate_due_appointments() to service_role;`. Then:
```sql
drop index if exists idx_appointments_branch_active_start;
create index idx_appointments_branch_active_start on appointments (branch_id, scheduled_start)
  where status in ('scheduled', 'checked_in', 'converted');
```

- [ ] **Step 4: Customer display**

- `apps/customer/app/tickets/page.tsx`: Upcoming query `.in('status', ['scheduled', 'checked_in'])` instead of `.eq('status', 'scheduled')`.
- `apps/customer/messages/en.json` → `Appointments`, add:
```json
    "statuses": {
      "scheduled": "Booked",
      "checked_in": "Checked in",
      "converted": "In the queue",
      "completed": "Done",
      "cancelled": "Cancelled",
      "no_show": "No-show"
    },
```
- `apps/customer/app/appointments/[id]/page.tsx`: render `t('statusLabel', { status: t(`statuses.${appointment.status}`) })`. Customer actions stay limited to `scheduled`.
- `e2e/appointment-booking.spec.ts`: `'Status: cancelled'` → `'Status: Cancelled'`.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck`, `(cd apps/customer && npx eslint app/tickets app/appointments)` — no errors.
```bash
git add supabase/migrations/20261001090900_appointments_checked_in_conversion.sql tests/db/appointment-conversion.test.ts apps/customer/app/tickets/page.tsx "apps/customer/app/appointments/[id]/page.tsx" apps/customer/messages/en.json e2e/appointment-booking.spec.ts
git commit -m "feat: checked-in appointments convert into tickets marked present"
```
Report "ready for push".

- [ ] **Step 6 (controller): push, run DB + customer e2e**

```bash
set -a && source supabase/.secrets/send-sms.env && set +a && npx supabase db push
npx vitest run tests/db/appointment-conversion.test.ts
```
Then (dev servers running) `npx playwright test e2e/appointment-booking.spec.ts --reporter=line`. Expected: PASS.

---

### Task 4: Staff calendar and staff appointment detail

**Files:**
- Create: `apps/staff/app/appointments/staffAppointmentErrors.ts`, `apps/staff/app/appointments/staffAppointmentErrors.test.ts`
- Create: `apps/staff/app/appointments/StaffSlotPicker.tsx`
- Create: `apps/staff/app/appointments/page.tsx`
- Create: `apps/staff/app/appointments/[id]/page.tsx`
- Modify: `apps/staff/app/page.tsx` (home link), `apps/staff/messages/en.json` (`StaffAppointments` namespace, `Home.appointmentsLink`)

**Interfaces:**
- Consumes: `list_branch_appointments`, `get_branch_appointment`, `staff_list_appointment_slots`, `staff_reschedule_appointment`, `staff_cancel_appointment`, `staff_check_in_appointment`, `staff_mark_appointment_no_show`, `list_bookable_barbers` (`display_name`), `loadManageableBranches` (`apps/staff/app/settings/barbers/scope.ts`).
- Produces: `staffAppointmentErrorKey(message: string | undefined): StaffAppointmentErrorKey`; default-export `StaffSlotPicker` with props `{ branchServiceId: string; barberId: string | null; customerId?: string | null; ignoreAppointmentId?: string | null; onPick: (slot: string) => void; refreshKey?: number }`; named `formatSlotTime(iso)`, `formatSlotDate(isoOrDate)`; routes `/appointments`, `/appointments/[id]`; link target `/appointments/new?branch=<id>` (Task 5).

- [ ] **Step 1: Failing unit test for the error mapper**

`apps/staff/app/appointments/staffAppointmentErrors.test.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import { staffAppointmentErrorKey } from './staffAppointmentErrors';

describe('staffAppointmentErrorKey', () => {
  it.each([
    ['slot_taken', 'slotTaken'],
    ['already_booked_that_day', 'alreadyBookedThatDay'],
    ['branch_closed', 'branchClosed'],
    ['too_soon', 'tooSoon'],
    ['too_far_ahead', 'tooFarAhead'],
    ['too_late', 'tooLate'],
    ['not_allowed', 'notAllowed'],
    ['already_converted', 'alreadyConverted'],
    ['invalid_phone', 'invalidPhone'],
    ['not_found', 'notFound'],
  ])('maps %s', (code, key) => {
    expect(staffAppointmentErrorKey(code)).toBe(key);
  });

  it('falls back to generic, including for prototype names', () => {
    expect(staffAppointmentErrorKey('boom')).toBe('generic');
    expect(staffAppointmentErrorKey(undefined)).toBe('generic');
    expect(staffAppointmentErrorKey('constructor')).toBe('generic');
  });
});
```
Run: `npx vitest run apps/staff/app/appointments/staffAppointmentErrors.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 2: The mapper**

`apps/staff/app/appointments/staffAppointmentErrors.ts`:
```typescript
/** Message keys (in `StaffAppointments.errors`) for the staff appointment functions' errors. */
export type StaffAppointmentErrorKey =
  | 'slotTaken'
  | 'alreadyBookedThatDay'
  | 'branchClosed'
  | 'tooSoon'
  | 'tooFarAhead'
  | 'tooLate'
  | 'notAllowed'
  | 'alreadyConverted'
  | 'invalidPhone'
  | 'notFound'
  | 'generic';

const KEYS = new Map<string, StaffAppointmentErrorKey>([
  ['slot_taken', 'slotTaken'],
  ['already_booked_that_day', 'alreadyBookedThatDay'],
  ['branch_closed', 'branchClosed'],
  ['too_soon', 'tooSoon'],
  ['too_far_ahead', 'tooFarAhead'],
  ['too_late', 'tooLate'],
  ['not_allowed', 'notAllowed'],
  ['already_converted', 'alreadyConverted'],
  ['invalid_phone', 'invalidPhone'],
  ['not_found', 'notFound'],
]);

export function staffAppointmentErrorKey(message: string | undefined): StaffAppointmentErrorKey {
  return (message && KEYS.get(message)) || 'generic';
}
```
Run the test — Expected: PASS.

- [ ] **Step 3: Messages**

Add to `apps/staff/messages/en.json` a top-level `"StaffAppointments"` section:
```json
  "StaffAppointments": {
    "title": "Appointments",
    "branch": "Branch",
    "barberFilter": "Barber",
    "allBarbers": "All barbers",
    "anyBarber": "Any barber",
    "previousDay": "Previous day",
    "today": "Today",
    "nextDay": "Next day",
    "bookForCustomer": "Book for a customer",
    "empty": "No appointments on this day.",
    "loadFailed": "Couldn't load appointments.",
    "statuses": {
      "scheduled": "Booked",
      "checked_in": "Checked in",
      "converted": "In the queue",
      "completed": "Done",
      "cancelled": "Cancelled",
      "no_show": "No-show"
    },
    "detailTitle": "Appointment",
    "dateLabel": "Date: {date}",
    "timeLabel": "Time: {time}",
    "branchLabel": "Branch: {branch}",
    "serviceLabel": "Service: {service}",
    "priceLabel": "Price: GHS {price}",
    "barberLabel": "Barber: {barber}",
    "customerLabel": "Customer: {name}",
    "phoneLabel": "Phone: {phone}",
    "noPhone": "Phone: none",
    "statusLabel": "Status: {status}",
    "bookedByCustomer": "Booked by the customer",
    "bookedByStaff": "Booked by {name}",
    "checkIn": "Check in",
    "reschedule": "Reschedule",
    "confirmReschedule": "Move to this time",
    "cancel": "Cancel appointment",
    "cancelTitle": "Why is it being cancelled?",
    "confirmCancel": "Confirm cancellation",
    "markNoShow": "Mark no-show",
    "back": "Back",
    "inQueue": "Now in the queue.",
    "openLiveQueue": "Open the Live Queue",
    "backToCalendar": "Back to appointments",
    "notFound": "We couldn't find this appointment.",
    "pickDate": "Pick a day",
    "loadingSlots": "Loading times…",
    "noSlots": "No open times on this day.",
    "reasons": {
      "wait_too_long": "Wait too long",
      "cant_make_it": "Can't make it",
      "changed_plans": "Changed plans",
      "found_another_barber": "Found another barber",
      "emergency": "Emergency",
      "other": "Other"
    },
    "errors": {
      "slotTaken": "That time was just taken — please pick another.",
      "alreadyBookedThatDay": "This customer already has an appointment that day.",
      "branchClosed": "This branch is closed then.",
      "tooSoon": "That time has already started.",
      "tooFarAhead": "That's too far ahead (up to 14 days).",
      "tooLate": "This appointment can no longer be changed.",
      "notAllowed": "You can't manage appointments for this branch.",
      "alreadyConverted": "This appointment is already in the queue.",
      "invalidPhone": "Enter a valid 10-digit Ghana phone number.",
      "notFound": "We couldn't find this appointment.",
      "generic": "Something went wrong — please try again."
    }
  },
```
Add to `"Home"`: `"appointmentsLink": "Appointments"`; in `apps/staff/app/page.tsx` add `<Link href="/appointments">{t('appointmentsLink')}</Link>` after the Staff & Roles link.

- [ ] **Step 4: StaffSlotPicker**

`apps/staff/app/appointments/StaffSlotPicker.tsx` — same structure as `apps/customer/app/appointments/SlotPicker.tsx` (read it and mirror it: `formatSlotTime`/`formatSlotDate`, a lazy-`useState` list of 15 dates, the `requestKey` stale-response guard, loading/empty/error states), but:
- translations from `useTranslations('StaffAppointments')` keys `pickDate`, `loadingSlots`, `noSlots`, `errors.generic`;
- calls `supabase.rpc('staff_list_appointment_slots', { p_branch_service_id: branchServiceId, p_barber_id: barberId, p_date: date, p_customer_id: customerId ?? null, p_ignore_appointment_id: ignoreAppointmentId ?? null })` (include customerId/ignoreAppointmentId in the effect deps);
- props as in Interfaces.

- [ ] **Step 5: Calendar page**

`apps/staff/app/appointments/page.tsx` (`'use client'`):
- State: `branches` (`loadManageableBranches`), `branchId` (first branch once loaded), `day` (`YYYY-MM-DD`, lazy `useState(() => new Date().toISOString().slice(0, 10))`), `barbers` (`list_bookable_barbers` for the branch), `barberFilter` (`'all' | 'any' | <barber id>`), rows result tagged with its request key, `loadError`.
- Load rows with `supabase.rpc('list_branch_appointments', { p_branch_id: branchId, p_date: day })` in an effect keyed on `[branchId, day]`; set results inside the promise callback only.
- Day buttons Previous day / Today / Next day compute the new date in the click handler with `Date.UTC` arithmetic (±1 day; Today = current UTC date).
- Filter: `all` → all; `any` → `preferred_barber_id === null`; otherwise matching `preferred_barber_id`.
- Markup inside `<main>`: `<h1>{t('title')}</h1>`; branch `<select aria-label={t('branch')}>`; the three day buttons and the shown date (`formatSlotDate(day)`); barber `<select aria-label={t('barberFilter')}>` (All barbers / Any barber / each `display_name`); `<Link href={`/appointments/new?branch=${branchId}`}>{t('bookForCustomer')}</Link>`; then `<p>{t('empty')}</p>` or a `<ul>` of rows, each `<li><Link href={`/appointments/${row.id}`}>{`${formatSlotTime(row.scheduled_start)} — ${row.customer_name} — ${row.service_name} — ${row.barber_name ?? t('anyBarber')} — ${t(`statuses.${row.status}`)}`}</Link></li>`; `loadError` → `<p role="alert">{t('loadFailed')}</p>`.

- [ ] **Step 6: Staff detail page**

`apps/staff/app/appointments/[id]/page.tsx` (`'use client'`):
- Load `supabase.rpc('get_branch_appointment', { p_appointment_id: params.id })` in an effect keyed on `[params.id, reloadKey]`; empty → not-found view (`t('notFound')` + back link); error → `t(`errors.${staffAppointmentErrorKey(error.message)}`)`. When the row arrives (inside the effect callback), also store `startsInFuture = Date.parse(row.scheduled_start) > Date.now()` (react-hooks/purity).
- Show: `dateLabel`, `timeLabel`, `branchLabel`, `serviceLabel`, `priceLabel` (if price), `barberLabel` (`barber_name` or `anyBarber`), `customerLabel`, `phoneLabel`/`noPhone`, `statusLabel` (`statuses.<status>`), and `bookedByCustomer` or `bookedByStaff` (`created_by_staff_name`).
- `status === 'converted'` → `<p>{t('inQueue')}</p>` + `<Link href="/tickets">{t('openLiveQueue')}</Link>`, no actions.
- `status` `scheduled`/`checked_in` → buttons: **Check in** (only `scheduled`) → `staff_check_in_appointment`; **Reschedule** → `<StaffSlotPicker branchServiceId={row.branch_service_id} barberId={row.preferred_barber_id} customerId={row.customer_id} ignoreAppointmentId={row.id} …/>` then **Move to this time** → `staff_reschedule_appointment`; **Cancel appointment** → `<fieldset><legend>{t('cancelTitle')}</legend>` with six radio labels from `reasons` then **Confirm cancellation** → `staff_cancel_appointment`; **Mark no-show** (only when `!startsInFuture`) → `staff_mark_appointment_no_show`. Back buttons reset mode, reason and error. Success → bump `reloadKey`, back to view mode. Errors in `<p role="alert">` via the mapper; `slot_taken` also bumps the picker's `refreshKey`.
- Always `<Link href="/appointments">{t('backToCalendar')}</Link>`.

- [ ] **Step 7: Lint, typecheck, commit**

Run: `npm run typecheck`, `(cd apps/staff && npx eslint app/appointments app/page.tsx)` — no errors; unit test passes.
```bash
git add apps/staff/app/appointments apps/staff/app/page.tsx apps/staff/messages/en.json
git commit -m "feat: staff appointments calendar and appointment detail actions"
```

---

### Task 5: Book for a customer, barber's Today's appointments, and the e2e

**Files:**
- Create: `apps/staff/app/appointments/new/page.tsx`
- Create: `apps/staff/app/queue/today/TodaysAppointments.tsx`
- Modify: `apps/staff/app/queue/today/page.tsx` (render `<TodaysAppointments />` immediately before the closing `</main>`)
- Modify: `apps/staff/messages/en.json`
- Create: `e2e/appointments-staff.spec.ts`

**Interfaces:**
- Consumes: `staff_book_appointment`, `StaffSlotPicker`/`formatSlotDate`/`formatSlotTime`, `staffAppointmentErrorKey`, `list_my_appointments_today`, `list_bookable_barbers`, `normalizeGhanaPhone` (`@pixel-barber/shared`), Task 4 messages.
- Produces: route `/appointments/new?branch=<id>`; the barber list on `/queue/today`.

- [ ] **Step 1: Messages**

Add to `StaffAppointments`:
```json
    "newTitle": "Book for a customer",
    "customerName": "Customer name",
    "customerPhone": "Phone (optional)",
    "continue": "Continue",
    "service": "Service",
    "changeTime": "Change time",
    "confirmBook": "Book appointment",
    "reviewTitle": "Review"
```
Add to `TodaysQueue`:
```json
    "appointmentsTitle": "Today's appointments",
    "appointmentRow": "{time} — {name}",
    "appointmentCheckedIn": "{time} — {name} (checked in)"
```

- [ ] **Step 2: Book-for-a-customer page**

`apps/staff/app/appointments/new/page.tsx` (`'use client'`; wrap the body in `<Suspense fallback={null}>` because it reads `useSearchParams`, like `apps/customer/app/onboard/page.tsx`):
- Steps `customer` → `service` → `barber` → `datetime` → `review`; `<h1>{t('newTitle')}</h1>`.
- **customer:** inputs with placeholders `customerName` (required) and `customerPhone` (optional); **Continue** normalises a non-empty phone with `normalizeGhanaPhone` (null → `errors.invalidPhone`), stores the normalised phone or null.
- **service:** one button per active branch service (`branch_services` `id, services(name)`, `branch_id = branch`, `is_active = true`).
- **barber:** "Any barber" (`anyBarber`) + one button per `list_bookable_barbers` row labelled `display_name`.
- **datetime:** `<StaffSlotPicker branchServiceId barberId refreshKey onPick={(slot) => { setSlot(slot); setStep('review'); }} />`.
- **review:** `reviewTitle`, service name, barber name or any, `formatSlotDate(slot) formatSlotTime(slot)`, customer name/phone; **Change time** (→ datetime, clears error); **Book appointment** → `staff_book_appointment({ p_branch_service_id, p_barber_id, p_slot_start: slot, p_customer_name: name, p_customer_phone: phone })`; success → `router.push(`/appointments/${id}`)`; error → mapped message; `slot_taken` → back to datetime and bump `refreshKey`.
- No `branch` param → `<p role="alert">{t('errors.notAllowed')}</p>` + back-to-calendar link.

- [ ] **Step 3: Barber Today's appointments**

`apps/staff/app/queue/today/TodaysAppointments.tsx` (`'use client'`): load `supabase.rpc('list_my_appointments_today')` in an effect (setState in the promise callback); render nothing when empty or on error; otherwise:
```tsx
<section aria-labelledby="todays-appointments-heading">
  <h2 id="todays-appointments-heading">{t('appointmentsTitle')}</h2>
  <ul>
    {rows.map((r) => (
      <li key={r.id}>
        {t(r.status === 'checked_in' ? 'appointmentCheckedIn' : 'appointmentRow', {
          time: new Date(r.scheduled_start).toISOString().slice(11, 16),
          name: r.customer_first_name,
        })}
      </li>
    ))}
  </ul>
</section>
```
with `t = useTranslations('TodaysQueue')`. Import it in `apps/staff/app/queue/today/page.tsx` and render `<TodaysAppointments />` immediately before `</main>`.

- [ ] **Step 4: The e2e test**

`e2e/appointments-staff.spec.ts` — seeds its own data with the service-role client (patterns: `e2e/appointment-booking.spec.ts`, `e2e/staff-logout.spec.ts`): a branch open all day (7 `branch_hours` rows 00:00–23:59:59); a 30-minute service + `branch_services`; a barber (auth email/password, `staff_users` barber accepted with name `Staff E2E Barber`, `barbers` available at the branch, skill, `barber_schedule` all day for today and the next 2 days — delete auto-filled rows first); a receptionist (auth email/password, `staff_users` receptionist accepted, `staff_branch_assignments` for the branch). Steps (`main = page.locator('main')`, Enter presses):
1. Receptionist logs in at `http://localhost:3001/login` (placeholders `Email or phone`, `Password`; button `Log In`; waits for `/tickets`), opens `/appointments`, selects the branch in the `Branch` select, presses **Book for a customer**.
2. Fills `Customer name` = `Staff E2E Walker`, `Phone (optional)` = a unique `0557` + 6-digit number, **Continue**; picks the service by name; picks `Staff E2E Barber`; presses tomorrow's date button (en-GB `weekday: 'short', day: 'numeric', month: 'short'`, UTC) and `10:00`; **Book appointment**; expects URL `/appointments/<uuid>` and `Status: Booked`.
3. **Check in** → expects `Status: Checked in`.
4. Opens `/appointments`, selects the branch, **Next day**, expects a link containing `10:00 — Staff E2E Walker`.
5. Books a second appointment (`Staff E2E Second`, empty phone, tomorrow 11:00); on its detail: **Reschedule** → tomorrow → `12:00` → **Move to this time** → expects `Time: 12:00`; **Cancel appointment** → label `Can't make it` → **Confirm cancellation** → expects `Status: Cancelled`.
6. Inserts (service role) a `scheduled` appointment for today at the next full UTC hour naming the barber (skip this step via `test.info().annotations` when that hour crosses UTC midnight); logs in as the barber in a fresh browser context, opens `http://localhost:3001/queue/today`, expects the `Today's appointments` region to contain the customer's first name.
7. DB asserts (service role): first appointment `checked_in` with `created_by = 'staff'`; second `cancelled` with `cancel_reason = 'cant_make_it'`.
`finally`: delete the test's appointments and created customers (by name/phone), schedule, skills, `staff_branch_assignments`, `staff_users` (cascades barbers), auth users, `branch_services`, `branch_hours`, branch, service.

Start both dev servers in the background first, then run `npx playwright test e2e/appointments-staff.spec.ts --reporter=line`. Expected: RED before Steps 2–3 exist, GREEN after.

- [ ] **Step 5: Regression e2e, lint, typecheck, commit**

Run: `npx playwright test e2e/appointments-staff.spec.ts e2e/staff-logout.spec.ts e2e/no-show-cross-surface-journey.spec.ts --reporter=line --workers=1`, `npm run typecheck`, `(cd apps/staff && npx eslint app/appointments app/queue/today)` — all pass / no errors.
```bash
git add apps/staff/app/appointments/new apps/staff/app/queue/today/TodaysAppointments.tsx apps/staff/app/queue/today/page.tsx apps/staff/messages/en.json e2e/appointments-staff.spec.ts
git commit -m "feat: staff book-for-customer and barber's today's appointments"
```

---

## After all tasks (controller)

1. Full `npx vitest run` on staging (re-run any file that fails only on `Request rate limit reached`), then the e2e suite with both dev servers up.
2. Ask the user before promoting: apply migrations 20261001090700–090900 to production (dry run first), THEN push to GitHub (the apps call the new functions).
