# Today Dashboard and Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Branch staff see a live Today dashboard with a long-wait warning; owners, branch managers and analysts open Reports for any date range (one branch or all branches) and download each report as CSV, Excel or PDF.

**Architecture:** Two `SECURITY DEFINER` functions compute every number (`branch_today`, `branch_report`) from `queue_tickets`, `feedback`, `branch_service_prices` and `appointments`, checking capabilities and branch scope. The staff app only displays what they return. One pure builder (`buildReportTables`) turns a report into tables that feed the page, CSV, Excel and PDF alike; Excel (`write-excel-file`) and PDF (`jspdf` + `jspdf-autotable`) libraries load only when the download is clicked.

**Tech Stack:** Supabase Postgres (plpgsql), Next.js 16 client components, next-intl, write-excel-file 4.1.1, jspdf 4.2.1, jspdf-autotable 5.0.8, Vitest, Playwright.

**Spec:** `Docs/superpowers/specs/2026-10-08-reports-dashboard-design.md`

## Global Constraints

- "Today" and every report date are Ghana dates (`Africa/Accra`, UTC+0). A ticket belongs to the date of `created_at` in `Africa/Accra`.
- Capabilities: new `view_branch_dashboard` (owner, branch_manager, receptionist, analyst) for Today; `view_branch_reports` (owner, branch_manager, analyst) for Reports and for Today's ratings; `view_business_reports` (owner, analyst) for more than one branch; `edit_hours` (owner, branch_manager) for the long-wait setting. Every function also checks `in_branch_scope` for each branch.
- Error strings (exact): `not_allowed`, `invalid_range`, `invalid_minutes`, `not_found`.
- Long-wait setting: `branches.long_wait_warning_minutes smallint not null default 20`, check `between 5 and 180`. Alert when the average `now() - created_at` of tickets currently waiting or called is greater than the setting.
- Report range: `p_from <= p_to` and `p_to - p_from <= 91` (at most 92 days).
- Definitions: served = `completed`; wait = `service_started_at - created_at`; haircut time = `completed_at - service_started_at`; no-show rate = no_shows / (served + no_shows); cancellation rate = cancellations / all tickets; estimated takings = price in effect on the visit date (promo first, then latest `effective_from`; no price → 0); returning = served customers with a completed ticket created before the range. Minutes are whole numbers, money 2 decimals, percentages 1 decimal, null where there is no data.
- Staff copy (exact): Today banner `Waits are long: people have waited {minutes} min on average (limit {limit} min).`; `Couldn't load the dashboard.`; `You don't have access to this page.`; `Couldn't load the report.`; `Pick a range of up to 92 days.`; `No visits in this period.`; `Download CSV`; `Download Excel`; `Download PDF`; `Couldn't create the file. Please try again.`; `Long wait warning (minutes)`; `Enter a number from 5 to 180.`; summary money `GHS 1,250.00 (estimated)`; table money `GHS 1,250.00`; minutes `18 min`; empty `—`.
- File names: CSV `pixel-barber-{table}-{from}-{to}.csv`; Excel/PDF `pixel-barber-report-{branch}-{from}-{to}.xlsx|.pdf` where `{branch}` is the branch code or `all`.
- Excel sheets in order: `Summary`, `Day by day`, `Busiest hours`, `Barbers`, `Services`, `Cancellation reasons`, `Branch comparison` (all branches only). PDF: A4 portrait, title `Pixel Barber report`, then `{branch name} · {from} to {to}`, then `Generated {date time}`; takings column header `Estimated takings (GHS)`.
- Every new SQL function: `security definer`, `set search_path = public, pg_temp`, explicit revoke/grant (`authenticated` only). Already-applied migrations are never edited. `packages/shared/src/database.types.ts` is hand-maintained and must match the SQL.
- **Implementer subagents cannot push migrations, deploy functions, set secrets or run SQL against a live project.** The controller pushes (`set -a && source supabase/.secrets/send-sms.env && set +a && npx supabase db push`). Report "ready for push".
- React lint (errors): no synchronous `setState` in effect bodies; no `Date.now()` / argument-less `new Date()` in render or `useMemo` (lazy `useState(() => …)` initializers and event handlers are fine); guard async results (`cancelled` flag, request keys).
- E2E: `.press('Enter')`, locators scoped to `page.locator('main')` (headers live outside main); phone range `+233555…`; FK-safe cleanup that throws. Do NOT kill node processes; leave dev servers running (customer 3000, staff 3001).
- After editing any file containing `—`, `–` or `·`, `grep -n $'\xef\xbf\xbd' <file>` must print nothing.
- Do not stage `apps/*/next-env.d.ts`, `graphify-out/`, `playwright-report/`, `test-results/`, `supabase/.secrets/`, untracked `Docs/superpowers/plans/2026-09-1*`. No AI-attribution lines in commits. Commit on main.
- Environment: lint per file (`cd apps/staff && npx eslint "<file>"`); pure unit tests from the repo root with `npx vitest run <path> --environment=node`; DB tests `npx vitest run tests/db/<file>` (staging; if a login rate limit fails a run, wait a minute and re-run).

## Rulings made while planning

1. **The long-wait setting is saved through `set_long_wait_warning(p_branch_id, p_minutes)`** (`edit_hours` + scope). The `branches` RLS policy only lets `manage_branches` (owner) update rows, so a direct update would shut branch managers out, contrary to the spec.
2. **The DB fixture's `createStaffLogin` accepts `'analyst'` and an array of branches**, so the multi-branch report can be tested with a real analyst login.
3. **Today's barber counts skip inactive staff accounts** (`staff_users.is_active`).
4. **Branch comparison lists every requested branch**, with zeros for a branch that had no visits; duplicate branch ids are ignored; cancellation reasons with equal counts are ordered by reason.
5. **One builder, four outputs:** `buildReportTables` produces the headers, raw values and display values once; the page, CSV, Excel and PDF all use it, so the columns can't drift apart.
6. **CSV files start with a UTF-8 byte-order mark** so Excel shows apostrophes and dashes correctly.
7. **`ManageableBranch` gains `branch_code`** (loaded in `loadManageableBranches`) for the Excel/PDF file names.
8. **Index `queue_tickets (customer_id, created_at)`** keeps the returning-customer lookup fast.
9. **Reports reload automatically** when the branch or dates change (no "Show" button). "No visits in this period." shows when the range had no tickets at all (`hours` is empty).
10. **Display details:** Busiest hours show `10:00`; Day by day shows dates like `Mon 28 Sep` (exports keep ISO dates); Today's ratings with no ratings show `No ratings yet`; the long-wait form on Branch Settings has its own `Save warning` button and `Warning saved` message.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20261008090000_today_dashboard.sql` | capability + grants, `branches.long_wait_warning_minutes`, `set_long_wait_warning`, `branch_today`, index `(branch_id, created_at)` |
| `supabase/migrations/20261008090100_branch_report.sql` | `branch_report`, index `(customer_id, created_at)` |
| `tests/db/fixtures/appointments.ts` | `createStaffLogin` accepts analyst and several branches |
| `tests/db/today-dashboard.test.ts`, `tests/db/branch-report.test.ts` | DB tests |
| `packages/shared/src/database.types.ts` | new column and functions |
| `apps/staff/app/reports/format.ts` (+ test) | minute, money, percent, rating, hour, day formatting |
| `apps/staff/app/reports/Metric.tsx` | one labelled number (Today and Reports summary) |
| `apps/staff/app/today/todayTypes.ts`, `apps/staff/app/today/page.tsx` | Today page |
| `apps/staff/app/settings/branch/[id]/page.tsx` | long-wait field |
| `apps/staff/app/page.tsx` | Today / Reports links |
| `apps/staff/app/reports/reportTypes.ts`, `presets.ts` (+ test), `csv.ts` (+ test), `reportTables.ts` (+ test), `download.ts`, `__fixtures__/sampleReport.ts`, `page.tsx` | Reports page and CSV |
| `apps/staff/app/reports/exportContent.ts` (+ test), `exportFiles.ts` | Excel and PDF |
| `apps/staff/app/settings/barbers/scope.ts` | `branch_code` on `ManageableBranch` |
| `apps/staff/messages/en.json` | `Today`, `Reports`, `Home`, `BranchSettings` copy |
| `apps/staff/package.json` | Excel/PDF dependencies |
| `e2e/staff-reports.spec.ts` | Today, Reports + CSV, Excel + PDF journeys |

---

### Task 1: Today dashboard functions

**Files:**
- Create: `supabase/migrations/20261008090000_today_dashboard.sql`
- Create: `tests/db/today-dashboard.test.ts`
- Modify: `tests/db/fixtures/appointments.ts` (`createStaffLogin`)
- Modify: `packages/shared/src/database.types.ts`

**Interfaces:**
- Consumes: `has_capability(cap text)`, `in_branch_scope(uuid)`; fixture `createAppointmentFixture`, `createStaffLogin`, `cleanupStaffLogin`, `dateAt`.
- Produces (SQL): capability `view_branch_dashboard`; column `branches.long_wait_warning_minutes smallint`; `set_long_wait_warning(p_branch_id uuid, p_minutes integer) returns void`; `branch_today(p_branch_id uuid) returns jsonb` shaped
  `{ now: { waiting, called, in_service, appointments_to_come, barbers_available, barbers_busy }, today: { served, walk_ins, appointments, no_shows, cancellations, avg_wait_min, avg_service_min }, ratings: { count, average } | null, long_wait: { threshold_min, current_avg_wait_min, alert }, updated_at }`.
- Produces (fixture): `createStaffLogin(f, label, role: 'branch_manager' | 'receptionist' | 'analyst', branchId: string | string[])`.

- [ ] **Step 1: Let the fixture create analysts with several branches**

In `tests/db/fixtures/appointments.ts`, replace the `createStaffLogin` signature and its assignment insert:
```typescript
/** A signed-in branch_manager/receptionist/analyst assigned to `branchId` (one or several; the
 * assignments are made before sign-in, so the JWT carries them). */
export async function createStaffLogin(
  f: AppointmentFixture,
  label: string,
  role: 'branch_manager' | 'receptionist' | 'analyst',
  branchId: string | string[],
): Promise<{ authUserId: string; staffUserId: string; name: string; client: Client }> {
```
and
```typescript
  const branchIds = Array.isArray(branchId) ? branchId : [branchId];
  const { error: assignError } = await f.admin
    .from('staff_branch_assignments')
    .insert(branchIds.map((id) => ({ staff_user_id: staff.id, branch_id: id })));
  if (assignError) throw assignError;
```
(keep everything else in the function as it is).

- [ ] **Step 2: Write the failing tests**

Create `tests/db/today-dashboard.test.ts`:
```typescript
// tests/db/today-dashboard.test.ts
// @vitest-environment node
// Today dashboard (Docs/superpowers/specs/2026-10-08-reports-dashboard-design.md, Section 1):
// branch_today's right-now and so-far-today counts, ratings only for report viewers, the long-wait
// warning, access (view_branch_dashboard + branch scope) and set_long_wait_warning.
// The "appointment still to come" is booked for 23:30 UTC today; running this file after ~23:15 UTC
// may see it already activated by the every-minute appointment job.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@pixel-barber/shared';
import {
  cleanupAppointmentFixture,
  cleanupStaffLogin,
  createAppointmentFixture,
  createStaffLogin,
  dateAt,
  type AppointmentFixture,
} from './fixtures/appointments';

type TicketInsert = Database['public']['Tables']['queue_tickets']['Insert'];
type Today = {
  now: Record<string, number>;
  today: Record<string, number | null>;
  ratings: { count: number; average: number | null } | null;
  long_wait: { threshold_min: number; current_avg_wait_min: number | null; alert: boolean };
  updated_at: string;
};

let f: AppointmentFixture;
let manager: Awaited<ReturnType<typeof createStaffLogin>>;
let reception: Awaited<ReturnType<typeof createStaffLogin>>;
let otherManager: Awaited<ReturnType<typeof createStaffLogin>>;
const MIN = 60_000;

const minutesAgo = (n: number) => new Date(Date.now() - n * MIN).toISOString();
/** HH:MM UTC today (may be later than now; the "so far today" counts only look at the date). */
const todayAt = (hhmm: string) => `${dateAt(0)}T${hhmm}:00.000Z`;

async function ticket(
  label: string,
  customerIdx: number,
  fields: Omit<TicketInsert, 'ticket_number' | 'branch_id' | 'customer_id' | 'branch_service_id' | 'created_by'>,
) {
  const { data, error } = await f.admin
    .from('queue_tickets')
    .insert({
      ticket_number: `PB-TD-${f.suffix}-${label}`,
      branch_id: f.branchId,
      customer_id: f.customers[customerIdx].customerId,
      branch_service_id: f.branchServiceId,
      created_by: 'customer',
      ...fields,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

async function today(client = manager.client) {
  const { data, error } = await client.rpc('branch_today', { p_branch_id: f.branchId });
  if (error) throw error;
  return data as unknown as Today;
}

beforeAll(async () => {
  f = await createAppointmentFixture();
  manager = await createStaffLogin(f, 'tdm', 'branch_manager', f.branchId);
  reception = await createStaffLogin(f, 'tdr', 'receptionist', f.branchId);
  otherManager = await createStaffLogin(f, 'tdo', 'branch_manager', f.closedBranchId);

  // Right now: one waiting (30 min), one called (40 min), one in service.
  await ticket('w', 0, { state: 'waiting', created_at: minutesAgo(30) });
  await ticket('c', 1, { state: 'called', created_at: minutesAgo(40), called_at: minutesAgo(2) });
  await ticket('s', 2, {
    state: 'in_service',
    assigned_barber_id: f.barberA.barberId,
    created_at: minutesAgo(60),
    service_started_at: minutesAgo(10),
  });
  // So far today: a walk-in (wait 20, haircut 30), an appointment ticket (wait 10, haircut 30),
  // a no-show and a cancellation.
  const walkIn = await ticket('d1', 3, {
    state: 'completed',
    assigned_barber_id: f.barberB.barberId,
    created_at: todayAt('00:00'),
    service_started_at: todayAt('00:20'),
    completed_at: todayAt('00:50'),
  });
  const { data: converted, error: apptError } = await f.admin
    .from('appointments')
    .insert({
      customer_id: f.customers[3].customerId,
      branch_id: f.branchId,
      branch_service_id: f.branchServiceId,
      scheduled_start: todayAt('01:00'),
      scheduled_end: todayAt('01:30'),
      status: 'converted',
      created_by: 'customer',
    })
    .select('id')
    .single();
  if (apptError) throw apptError;
  await ticket('d2', 3, {
    state: 'completed',
    appointment_id: converted.id,
    assigned_barber_id: f.barberB.barberId,
    created_at: todayAt('01:00'),
    service_started_at: todayAt('01:10'),
    completed_at: todayAt('01:40'),
  });
  await ticket('d3', 3, { state: 'no_show', created_at: todayAt('02:00'), no_show_at: todayAt('02:15') });
  await ticket('d4', 3, {
    state: 'cancelled',
    created_at: todayAt('02:30'),
    cancelled_at: todayAt('02:35'),
    cancel_reason: 'changed_plans',
  });
  const { error: fbError } = await f.admin.from('feedback').insert({
    ticket_id: walkIn,
    customer_id: f.customers[3].customerId,
    branch_id: f.branchId,
    barber_id: f.barberB.barberId,
    overall_rating: 3,
  });
  if (fbError) throw fbError;
  // Still to come today.
  const { error: laterError } = await f.admin.from('appointments').insert({
    customer_id: f.customers[0].customerId,
    branch_id: f.branchId,
    branch_service_id: f.branchServiceId,
    scheduled_start: todayAt('23:30'),
    scheduled_end: todayAt('23:59'),
    status: 'scheduled',
    created_by: 'customer',
  });
  if (laterError) throw laterError;
  // Barber A available (fixture default), barber B busy.
  const { error: busyError } = await f.admin
    .from('barbers')
    .update({ status: 'busy' })
    .eq('id', f.barberB.barberId);
  if (busyError) throw busyError;
}, 120000);

afterAll(async () => {
  await cleanupStaffLogin(f, manager);
  await cleanupStaffLogin(f, reception);
  await cleanupStaffLogin(f, otherManager);
  await cleanupAppointmentFixture(f);
}, 90000);

describe('branch_today', () => {
  it('counts right now, so far today and ratings for a branch manager', async () => {
    const d = await today();
    expect(d.now).toEqual({
      waiting: 1,
      called: 1,
      in_service: 1,
      appointments_to_come: 1,
      barbers_available: 1,
      barbers_busy: 1,
    });
    expect(d.today).toEqual({
      served: 2,
      walk_ins: 1,
      appointments: 1,
      no_shows: 1,
      cancellations: 1,
      avg_wait_min: 15,
      avg_service_min: 30,
    });
    expect(d.ratings).toEqual({ count: 1, average: 3 });
    expect(typeof d.updated_at).toBe('string');
  });

  it('warns when the people waiting have waited longer than the branch setting', async () => {
    const d = await today();
    expect(d.long_wait.threshold_min).toBe(20);
    expect(d.long_wait.current_avg_wait_min).toBeGreaterThanOrEqual(35);
    expect(d.long_wait.current_avg_wait_min).toBeLessThanOrEqual(36);
    expect(d.long_wait.alert).toBe(true);
  });

  it('gives receptionists the dashboard without ratings', async () => {
    const d = await today(reception.client);
    expect(d.now.waiting).toBe(1);
    expect(d.ratings).toBeNull();
  });

  it('refuses barbers and managers of other branches', async () => {
    for (const client of [f.barberClient, otherManager.client]) {
      const { error } = await client.rpc('branch_today', { p_branch_id: f.branchId });
      expect(error?.message).toBe('not_allowed');
    }
  });
});

describe('set_long_wait_warning', () => {
  it('refuses receptionists and out-of-range values', async () => {
    expect(
      (
        await reception.client.rpc('set_long_wait_warning', {
          p_branch_id: f.branchId,
          p_minutes: 30,
        })
      ).error?.message,
    ).toBe('not_allowed');
    for (const minutes of [4, 181]) {
      const { error } = await manager.client.rpc('set_long_wait_warning', {
        p_branch_id: f.branchId,
        p_minutes: minutes,
      });
      expect(error?.message).toBe('invalid_minutes');
    }
  });

  it('lets a branch manager raise the limit, which clears the warning', async () => {
    const { error } = await manager.client.rpc('set_long_wait_warning', {
      p_branch_id: f.branchId,
      p_minutes: 60,
    });
    expect(error).toBeNull();
    const { data: row } = await f.admin
      .from('branches')
      .select('long_wait_warning_minutes')
      .eq('id', f.branchId)
      .single();
    expect(row!.long_wait_warning_minutes).toBe(60);
    const d = await today();
    expect(d.long_wait).toMatchObject({ threshold_min: 60, alert: false });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/db/today-dashboard.test.ts`
Expected: FAIL (`branch_today` not found / `long_wait_warning_minutes` unknown).

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/20261008090000_today_dashboard.sql`:
```sql
-- Today dashboard (Docs/superpowers/specs/2026-10-08-reports-dashboard-design.md, Section 1): a
-- per-branch snapshot of right now and so far today (Ghana date), today's ratings for report
-- viewers, and a long-wait warning with a per-branch limit.

insert into capabilities (key, description) values
  ('view_branch_dashboard', 'View the branch Today dashboard')
on conflict do nothing;

insert into role_capabilities (role, capability) values
  ('owner', 'view_branch_dashboard'),
  ('branch_manager', 'view_branch_dashboard'),
  ('receptionist', 'view_branch_dashboard'),
  ('analyst', 'view_branch_dashboard')
on conflict do nothing;

alter table branches
  add column if not exists long_wait_warning_minutes smallint not null default 20
    constraint branches_long_wait_warning_minutes_range
      check (long_wait_warning_minutes between 5 and 180);

create index if not exists idx_queue_tickets_branch_created on queue_tickets (branch_id, created_at);

-- branches' RLS only lets manage_branches (owner) update rows; the long-wait limit belongs with
-- the other day-to-day settings branch managers may change (edit_hours).
create or replace function set_long_wait_warning(p_branch_id uuid, p_minutes integer)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not (has_capability('edit_hours') and in_branch_scope(p_branch_id)) then
    raise exception 'not_allowed';
  end if;
  if p_minutes is null or p_minutes < 5 or p_minutes > 180 then
    raise exception 'invalid_minutes';
  end if;
  update branches set long_wait_warning_minutes = p_minutes where id = p_branch_id;
  if not found then
    raise exception 'not_found';
  end if;
end;
$$;

revoke execute on function set_long_wait_warning(uuid, integer) from public, anon;
grant execute on function set_long_wait_warning(uuid, integer) to authenticated;

create or replace function branch_today(p_branch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := (now() at time zone 'Africa/Accra')::date;
  v_start timestamptz := v_today::timestamp at time zone 'Africa/Accra';
  v_end timestamptz := (v_today + 1)::timestamp at time zone 'Africa/Accra';
  v_threshold smallint;
  v_now jsonb;
  v_current integer;
  v_day jsonb;
  v_ratings jsonb := null;
begin
  if not (has_capability('view_branch_dashboard') and in_branch_scope(p_branch_id)) then
    raise exception 'not_allowed';
  end if;
  select long_wait_warning_minutes into v_threshold from branches where id = p_branch_id;
  if v_threshold is null then
    raise exception 'not_found';
  end if;

  select
    jsonb_build_object(
      'waiting', count(*) filter (where t.state in ('created', 'waiting', 'almost_turn')),
      'called', count(*) filter (where t.state in ('called', 'confirmed', 'grace_period')),
      'in_service', count(*) filter (where t.state = 'in_service')
    ),
    round(avg(extract(epoch from now() - t.created_at) / 60) filter (
      where t.state in ('created', 'waiting', 'almost_turn', 'called', 'confirmed', 'grace_period')
    ))::int
  into v_now, v_current
  from queue_tickets t
  where t.branch_id = p_branch_id and t.state not in ('completed', 'no_show', 'cancelled');

  v_now := v_now || jsonb_build_object(
    'appointments_to_come', (
      select count(*) from appointments a
      where a.branch_id = p_branch_id
        and a.status in ('scheduled', 'checked_in')
        and a.scheduled_start >= v_start and a.scheduled_start < v_end
    ),
    'barbers_available', (
      select count(*) from barbers b join staff_users su on su.id = b.staff_user_id
      where b.home_branch_id = p_branch_id and su.is_active and b.status = 'available'
    ),
    'barbers_busy', (
      select count(*) from barbers b join staff_users su on su.id = b.staff_user_id
      where b.home_branch_id = p_branch_id and su.is_active and b.status = 'busy'
    )
  );

  select jsonb_build_object(
    'served', count(*) filter (where t.state = 'completed'),
    'walk_ins', count(*) filter (where t.state = 'completed' and t.appointment_id is null),
    'appointments', count(*) filter (where t.state = 'completed' and t.appointment_id is not null),
    'no_shows', count(*) filter (where t.state = 'no_show'),
    'cancellations', count(*) filter (where t.state = 'cancelled'),
    'avg_wait_min', round(avg(extract(epoch from t.service_started_at - t.created_at) / 60) filter (
      where t.state = 'completed' and t.service_started_at is not null
    ))::int,
    'avg_service_min', round(avg(extract(epoch from t.completed_at - t.service_started_at) / 60) filter (
      where t.state = 'completed' and t.service_started_at is not null and t.completed_at is not null
    ))::int
  )
  into v_day
  from queue_tickets t
  where t.branch_id = p_branch_id and t.created_at >= v_start and t.created_at < v_end;

  if has_capability('view_branch_reports') then
    select jsonb_build_object('count', count(f.id), 'average', round(avg(f.overall_rating), 2))
    into v_ratings
    from feedback f
    join queue_tickets t on t.id = f.ticket_id
    where t.branch_id = p_branch_id and t.created_at >= v_start and t.created_at < v_end;
  end if;

  return jsonb_build_object(
    'now', v_now,
    'today', v_day,
    'ratings', v_ratings,
    'long_wait', jsonb_build_object(
      'threshold_min', v_threshold,
      'current_avg_wait_min', v_current,
      'alert', coalesce(v_current > v_threshold, false)
    ),
    'updated_at', now()
  );
end;
$$;

revoke execute on function branch_today(uuid) from public, anon;
grant execute on function branch_today(uuid) to authenticated;
```

- [ ] **Step 5: Update the database types**

In `packages/shared/src/database.types.ts`:
- `branches` `Row`: add `long_wait_warning_minutes: number;` (alphabetical, after `latitude`); `Insert` and `Update`: `long_wait_warning_minutes?: number;`.
- `Functions` (alphabetical):
```typescript
      branch_today: { Args: { p_branch_id: string }; Returns: Json };
      set_long_wait_warning: {
        Args: { p_branch_id: string; p_minutes: number };
        Returns: undefined;
      };
```
Run: `npm run typecheck` — Expected: no errors.

- [ ] **Step 6: Commit and hand over for the push**

```bash
git add supabase/migrations/20261008090000_today_dashboard.sql tests/db/today-dashboard.test.ts tests/db/fixtures/appointments.ts packages/shared/src/database.types.ts
git commit -m "feat: today dashboard function and per-branch long-wait setting"
```
Report "ready for push". After the push: `npx vitest run tests/db/today-dashboard.test.ts` — Expected: PASS.

---

### Task 2: Report function

**Files:**
- Create: `supabase/migrations/20261008090100_branch_report.sql`
- Create: `tests/db/branch-report.test.ts`
- Modify: `packages/shared/src/database.types.ts`

**Interfaces:**
- Consumes: Task 1's fixture `createStaffLogin(..., 'analyst', [ids])`; `has_capability`, `in_branch_scope`.
- Produces (SQL): `branch_report(p_branch_ids uuid[], p_from date, p_to date) returns jsonb` shaped
  `{ summary: Summary, daily: Daily[], hours: Hour[], barbers: Barber[], services: Service[], cancel_reasons: Reason[], branches: (Summary & { branch_id, name })[] | null }` where
  - `Summary = { served, walk_ins, appointments, no_shows, no_show_rate, cancellations, cancellation_rate, avg_wait_min, median_wait_min, avg_service_min, rating_count, rating_average, est_takings_ghs, returning_rate }`
  - `Daily = { date, served, walk_ins, appointments, no_shows, cancellations, avg_wait_min, avg_service_min, rating_average, est_takings_ghs }` (every date in the range, ascending)
  - `Hour = { hour, avg_joined_per_day, avg_wait_min }` (hours with any ticket, ascending)
  - `Barber = { barber_id, name, served, avg_service_min, no_shows, rating_average, est_takings_ghs }` (served desc, name)
  - `Service = { name, served, share, avg_service_min, listed_duration_min, est_takings_ghs }` (served desc, name)
  - `Reason = { reason, count }` (count desc, reason; null reason counted as `other`)

- [ ] **Step 1: Write the failing tests**

Create `tests/db/branch-report.test.ts`:
```typescript
// tests/db/branch-report.test.ts
// @vitest-environment node
// Reports (Docs/superpowers/specs/2026-10-08-reports-dashboard-design.md, Section 2): every section
// of branch_report against a seeded three-day range with known answers, the all-branches
// comparison, empty ranges, range limits and access.
//
// Seed (Main branch unless noted; D1..D3 = 10, 9, 8 days ago; prices: Service 50 then 60 from D2;
// Beard 40, promo 30 on D3 only):
//   T0  D-20 cust0 Service  completed                          (before the range: cust0 returns)
//   T1  D1 10:00 cust0 Service  barber A walk-in  wait 20 cut 30  50  rated 4
//   T2  D1 10:30 cust1 Beard    barber B walk-in  wait 30 cut 20  40  rated 2
//   T3  D2 14:00 cust2 Service  barber A appointment wait 10 cut 30  60
//   T4  D2 14:15 cust3 Service  barber B no-show
//   T5  D3 10:05 cust0 Beard    barber A cancelled wait_too_long
//   T6  D3 10:45 cust1 Service  barber A cancelled cant_make_it
//   T7  D3 15:00 cust2 Beard    no barber cancelled (no reason -> other)
//   T8  D3 15:30 cust3 Beard    barber B walk-in  wait 10 cut 20  30 (promo)  rated 5
//   T9  D-7  cust1 Service completed                           (after the range: excluded)
//   T10 D2 12:00 cust0 Closed branch, barber A, wait 5 cut 30, no price
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@pixel-barber/shared';
import {
  cleanupAppointmentFixture,
  cleanupStaffLogin,
  createAppointmentFixture,
  createStaffLogin,
  dateAt,
  type AppointmentFixture,
} from './fixtures/appointments';

type TicketInsert = Database['public']['Tables']['queue_tickets']['Insert'];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Report = Record<string, any>;

let f: AppointmentFixture;
let manager: Awaited<ReturnType<typeof createStaffLogin>>;
let reception: Awaited<ReturnType<typeof createStaffLogin>>;
let analyst: Awaited<ReturnType<typeof createStaffLogin>>;
let beardServiceId: string;
let beardBs: string;
const D1 = dateAt(-10);
const D2 = dateAt(-9);
const D3 = dateAt(-8);
const at = (day: string, hhmm: string) => `${day}T${hhmm}:00.000Z`;

async function ticket(label: string, fields: Omit<TicketInsert, 'ticket_number' | 'created_by'>) {
  const { data, error } = await f.admin
    .from('queue_tickets')
    .insert({ ticket_number: `PB-RP-${f.suffix}-${label}`, created_by: 'customer', ...fields })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

async function rate(ticketId: string, customerIdx: number, barberId: string, overall: number) {
  const { error } = await f.admin.from('feedback').insert({
    ticket_id: ticketId,
    customer_id: f.customers[customerIdx].customerId,
    branch_id: f.branchId,
    barber_id: barberId,
    overall_rating: overall,
  });
  if (error) throw error;
}

async function report(client: typeof manager.client, ids: string[], from: string, to: string) {
  return client.rpc('branch_report', { p_branch_ids: ids, p_from: from, p_to: to });
}

beforeAll(async () => {
  f = await createAppointmentFixture();
  manager = await createStaffLogin(f, 'rpm', 'branch_manager', f.branchId);
  reception = await createStaffLogin(f, 'rpr', 'receptionist', f.branchId);
  analyst = await createStaffLogin(f, 'rpa', 'analyst', [f.branchId, f.closedBranchId]);

  const { data: business } = await f.admin.from('businesses').select('id').limit(1).single();
  const { data: beard, error: beardError } = await f.admin
    .from('services')
    .insert({ business_id: business!.id, name: `Appt Beard ${f.suffix}`, default_duration_minutes: 20 })
    .select('id')
    .single();
  if (beardError) throw beardError;
  beardServiceId = beard.id;
  const { data: bs2, error: bs2Error } = await f.admin
    .from('branch_services')
    .insert({ branch_id: f.branchId, service_id: beard.id })
    .select('id')
    .single();
  if (bs2Error) throw bs2Error;
  beardBs = bs2.id;
  const { error: priceError } = await f.admin.from('branch_service_prices').insert([
    { branch_service_id: f.branchServiceId, price_ghs: 50, effective_from: dateAt(-30) },
    { branch_service_id: f.branchServiceId, price_ghs: 60, effective_from: D2 },
    { branch_service_id: beardBs, price_ghs: 40, effective_from: dateAt(-30) },
    { branch_service_id: beardBs, price_ghs: 30, is_promo: true, effective_from: D3, effective_until: D3 },
  ]);
  if (priceError) throw priceError;
  const { data: appt, error: apptError } = await f.admin
    .from('appointments')
    .insert({
      customer_id: f.customers[2].customerId,
      branch_id: f.branchId,
      branch_service_id: f.branchServiceId,
      scheduled_start: at(D2, '14:00'),
      scheduled_end: at(D2, '14:30'),
      status: 'converted',
      created_by: 'customer',
    })
    .select('id')
    .single();
  if (apptError) throw apptError;

  const main = { branch_id: f.branchId };
  const svc = { branch_service_id: f.branchServiceId };
  const brd = { branch_service_id: beardBs };
  const A = f.barberA.barberId;
  const B = f.barberB.barberId;
  const c = (i: number) => f.customers[i].customerId;
  const done = (day: string, created: string, started: string, completed: string) => ({
    state: 'completed' as const,
    created_at: at(day, created),
    service_started_at: at(day, started),
    completed_at: at(day, completed),
  });

  await ticket('t0', { ...main, ...svc, customer_id: c(0), assigned_barber_id: A, ...done(dateAt(-20), '10:00', '10:10', '10:40') });
  const t1 = await ticket('t1', { ...main, ...svc, customer_id: c(0), assigned_barber_id: A, ...done(D1, '10:00', '10:20', '10:50') });
  const t2 = await ticket('t2', { ...main, ...brd, customer_id: c(1), assigned_barber_id: B, ...done(D1, '10:30', '11:00', '11:20') });
  await ticket('t3', { ...main, ...svc, customer_id: c(2), assigned_barber_id: A, appointment_id: appt.id, ...done(D2, '14:00', '14:10', '14:40') });
  await ticket('t4', { ...main, ...svc, customer_id: c(3), assigned_barber_id: B, state: 'no_show', created_at: at(D2, '14:15'), no_show_at: at(D2, '14:30') });
  await ticket('t5', { ...main, ...brd, customer_id: c(0), assigned_barber_id: A, state: 'cancelled', created_at: at(D3, '10:05'), cancelled_at: at(D3, '10:10'), cancel_reason: 'wait_too_long' });
  await ticket('t6', { ...main, ...svc, customer_id: c(1), assigned_barber_id: A, state: 'cancelled', created_at: at(D3, '10:45'), cancelled_at: at(D3, '10:50'), cancel_reason: 'cant_make_it' });
  await ticket('t7', { ...main, ...brd, customer_id: c(2), state: 'cancelled', created_at: at(D3, '15:00'), cancelled_at: at(D3, '15:05') });
  const t8 = await ticket('t8', { ...main, ...brd, customer_id: c(3), assigned_barber_id: B, ...done(D3, '15:30', '15:40', '16:00') });
  await ticket('t9', { ...main, ...svc, customer_id: c(1), assigned_barber_id: A, ...done(dateAt(-7), '10:00', '10:10', '10:40') });
  await ticket('t10', { branch_id: f.closedBranchId, branch_service_id: f.closedBranchServiceId, customer_id: c(0), assigned_barber_id: A, ...done(D2, '12:00', '12:05', '12:35') });
  await rate(t1, 0, A, 4);
  await rate(t2, 1, B, 2);
  await rate(t8, 3, B, 5);
}, 120000);

afterAll(async () => {
  await cleanupStaffLogin(f, manager);
  await cleanupStaffLogin(f, reception);
  await cleanupStaffLogin(f, analyst);
  await cleanupAppointmentFixture(f);
  const { error } = await f.admin.from('services').delete().eq('id', beardServiceId);
  if (error) throw error;
}, 90000);

describe('branch_report for one branch', () => {
  let r: Report;
  beforeAll(async () => {
    const { data, error } = await report(manager.client, [f.branchId], D1, D3);
    if (error) throw error;
    r = data as Report;
  });

  it('summarises the range', () => {
    expect(r.summary).toEqual({
      served: 4,
      walk_ins: 3,
      appointments: 1,
      no_shows: 1,
      no_show_rate: 20,
      cancellations: 3,
      cancellation_rate: 37.5,
      avg_wait_min: 18,
      median_wait_min: 15,
      avg_service_min: 25,
      rating_count: 3,
      rating_average: 3.67,
      est_takings_ghs: 180,
      returning_rate: 25,
    });
  });

  it('lists every day', () => {
    expect(r.daily).toEqual([
      { date: D1, served: 2, walk_ins: 2, appointments: 0, no_shows: 0, cancellations: 0, avg_wait_min: 25, avg_service_min: 25, rating_average: 3, est_takings_ghs: 90 },
      { date: D2, served: 1, walk_ins: 0, appointments: 1, no_shows: 1, cancellations: 0, avg_wait_min: 10, avg_service_min: 30, rating_average: null, est_takings_ghs: 60 },
      { date: D3, served: 1, walk_ins: 1, appointments: 0, no_shows: 0, cancellations: 3, avg_wait_min: 10, avg_service_min: 20, rating_average: 5, est_takings_ghs: 30 },
    ]);
  });

  it('shows the busiest hours', () => {
    expect(r.hours).toEqual([
      { hour: 10, avg_joined_per_day: 1.3, avg_wait_min: 25 },
      { hour: 14, avg_joined_per_day: 0.7, avg_wait_min: 10 },
      { hour: 15, avg_joined_per_day: 0.7, avg_wait_min: 10 },
    ]);
  });

  it('breaks down barbers, services and cancellation reasons', () => {
    expect(r.barbers).toEqual([
      { barber_id: f.barberA.barberId, name: 'Appt Barber a', served: 2, avg_service_min: 30, no_shows: 0, rating_average: 4, est_takings_ghs: 110 },
      { barber_id: f.barberB.barberId, name: 'Appt Barber b', served: 2, avg_service_min: 20, no_shows: 1, rating_average: 3.5, est_takings_ghs: 70 },
    ]);
    expect(r.services).toEqual([
      { name: `Appt Beard ${f.suffix}`, served: 2, share: 50, avg_service_min: 20, listed_duration_min: 20, est_takings_ghs: 70 },
      { name: `Appt Service ${f.suffix}`, served: 2, share: 50, avg_service_min: 30, listed_duration_min: 30, est_takings_ghs: 110 },
    ]);
    expect(r.cancel_reasons).toEqual([
      { reason: 'cant_make_it', count: 1 },
      { reason: 'other', count: 1 },
      { reason: 'wait_too_long', count: 1 },
    ]);
    expect(r.branches).toBeNull();
  });

  it('returns zeros and empty lists for a range without visits', async () => {
    const { data, error } = await report(manager.client, [f.branchId], dateAt(-60), dateAt(-58));
    expect(error).toBeNull();
    const e = data as Report;
    expect(e.summary).toMatchObject({ served: 0, cancellations: 0, est_takings_ghs: 0, avg_wait_min: null, rating_average: null, no_show_rate: null, returning_rate: null });
    expect(e.daily).toHaveLength(3);
    expect(e.daily[0]).toMatchObject({ served: 0, est_takings_ghs: 0, avg_wait_min: null });
    expect(e.hours).toEqual([]);
    expect(e.barbers).toEqual([]);
    expect(e.services).toEqual([]);
    expect(e.cancel_reasons).toEqual([]);
  });
});

describe('branch_report across branches', () => {
  it('compares branches for an analyst', async () => {
    const { data, error } = await report(analyst.client, [f.branchId, f.closedBranchId], D1, D3);
    expect(error).toBeNull();
    const r = data as Report;
    expect(r.summary).toMatchObject({ served: 5, est_takings_ghs: 180, avg_wait_min: 15 });
    expect(r.branches).toHaveLength(2);
    expect(r.branches[0]).toEqual({
      branch_id: f.closedBranchId,
      name: `Appt Closed ${f.suffix}`,
      served: 1,
      walk_ins: 1,
      appointments: 0,
      no_shows: 0,
      no_show_rate: 0,
      cancellations: 0,
      cancellation_rate: 0,
      avg_wait_min: 5,
      median_wait_min: 5,
      avg_service_min: 30,
      rating_count: 0,
      rating_average: null,
      est_takings_ghs: 0,
      returning_rate: 100,
    });
    expect(r.branches[1]).toMatchObject({ branch_id: f.branchId, name: `Appt Main ${f.suffix}`, served: 4, est_takings_ghs: 180 });
  });
});

describe('branch_report rules', () => {
  it('refuses people without report access or outside their branches', async () => {
    const refused = [
      await report(reception.client, [f.branchId], D1, D3),
      await report(f.barberClient, [f.branchId], D1, D3),
      await report(manager.client, [f.closedBranchId], D1, D3),
      await report(manager.client, [f.branchId, f.closedBranchId], D1, D3),
      await report(manager.client, [], D1, D3),
    ];
    for (const { error } of refused) expect(error?.message).toBe('not_allowed');
  });

  it('accepts up to 92 days and refuses longer or backwards ranges', async () => {
    expect((await report(manager.client, [f.branchId], dateAt(-99), dateAt(-8))).error).toBeNull();
    expect((await report(manager.client, [f.branchId], dateAt(-100), dateAt(-8))).error?.message).toBe('invalid_range');
    expect((await report(manager.client, [f.branchId], D3, D1)).error?.message).toBe('invalid_range');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/db/branch-report.test.ts`
Expected: FAIL (`branch_report` not found).

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261008090100_branch_report.sql`:
```sql
-- Reports (Docs/superpowers/specs/2026-10-08-reports-dashboard-design.md, Section 2): one call
-- returns every report section for a Ghana-date range over one branch, or several branches for
-- business-wide viewers. A ticket belongs to the Africa/Accra date it joined the queue.

create index if not exists idx_queue_tickets_customer_created on queue_tickets (customer_id, created_at);

create or replace function branch_report(p_branch_ids uuid[], p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_branch uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_days integer;
  v_result jsonb;
begin
  p_branch_ids := array(select distinct b from unnest(p_branch_ids) as b where b is not null);
  if cardinality(p_branch_ids) = 0 or not has_capability('view_branch_reports') then
    raise exception 'not_allowed';
  end if;
  foreach v_branch in array p_branch_ids loop
    if not in_branch_scope(v_branch) then
      raise exception 'not_allowed';
    end if;
  end loop;
  if cardinality(p_branch_ids) > 1 and not has_capability('view_business_reports') then
    raise exception 'not_allowed';
  end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 91 then
    raise exception 'invalid_range';
  end if;

  v_start := p_from::timestamp at time zone 'Africa/Accra';
  v_end := (p_to + 1)::timestamp at time zone 'Africa/Accra';
  v_days := p_to - p_from + 1;

  with tix as (
    select
      t.id,
      t.branch_id,
      t.customer_id,
      t.state,
      t.appointment_id,
      t.assigned_barber_id,
      t.branch_service_id,
      t.cancel_reason,
      (t.created_at at time zone 'Africa/Accra')::date as visit_date,
      extract(hour from t.created_at at time zone 'Africa/Accra')::int as visit_hour,
      t.state = 'completed' as served,
      case when t.state = 'completed' and t.service_started_at is not null
        then extract(epoch from t.service_started_at - t.created_at) / 60 end as wait_min,
      case when t.state = 'completed' and t.service_started_at is not null
            and t.completed_at is not null
        then extract(epoch from t.completed_at - t.service_started_at) / 60 end as service_min,
      case when t.state = 'completed' then coalesce((
        select p.price_ghs
        from branch_service_prices p
        where p.branch_service_id = t.branch_service_id
          and p.effective_from <= (t.created_at at time zone 'Africa/Accra')::date
          and (p.effective_until is null
               or p.effective_until >= (t.created_at at time zone 'Africa/Accra')::date)
        order by p.is_promo desc, p.effective_from desc
        limit 1
      ), 0) else 0 end as takings,
      f.overall_rating,
      t.state = 'completed' and exists (
        select 1 from queue_tickets prev
        where prev.customer_id = t.customer_id
          and prev.state = 'completed'
          and prev.created_at < v_start
      ) as is_returning
    from queue_tickets t
    left join feedback f on f.ticket_id = t.id
    where t.branch_id = any(p_branch_ids) and t.created_at >= v_start and t.created_at < v_end
  ),
  summaries as (
    -- One row for the whole selection (is_total) plus one per requested branch; the left join
    -- keeps branches without visits, so every aggregate counts x.id rather than rows.
    select
      rb.branch_id,
      grouping(rb.branch_id) = 1 as is_total,
      jsonb_build_object(
        'served', count(x.id) filter (where x.served),
        'walk_ins', count(x.id) filter (where x.served and x.appointment_id is null),
        'appointments', count(x.id) filter (where x.served and x.appointment_id is not null),
        'no_shows', count(x.id) filter (where x.state = 'no_show'),
        'no_show_rate', round(100.0 * count(x.id) filter (where x.state = 'no_show')
          / nullif(count(x.id) filter (where x.served or x.state = 'no_show'), 0), 1),
        'cancellations', count(x.id) filter (where x.state = 'cancelled'),
        'cancellation_rate', round(100.0 * count(x.id) filter (where x.state = 'cancelled')
          / nullif(count(x.id), 0), 1),
        'avg_wait_min', round(avg(x.wait_min))::int,
        'median_wait_min', round((percentile_cont(0.5) within group (order by x.wait_min))::numeric)::int,
        'avg_service_min', round(avg(x.service_min))::int,
        'rating_count', count(x.overall_rating),
        'rating_average', round(avg(x.overall_rating), 2),
        'est_takings_ghs', coalesce(round(sum(x.takings), 2), 0),
        'returning_rate', round(100.0 * count(distinct x.customer_id) filter (where x.is_returning)
          / nullif(count(distinct x.customer_id) filter (where x.served), 0), 1)
      ) as data
    from unnest(p_branch_ids) as rb(branch_id)
    left join tix x on x.branch_id = rb.branch_id
    group by grouping sets ((), (rb.branch_id))
  ),
  daily as (
    select
      d.day::date as day,
      count(x.id) filter (where x.served) as served,
      count(x.id) filter (where x.served and x.appointment_id is null) as walk_ins,
      count(x.id) filter (where x.served and x.appointment_id is not null) as appointments,
      count(x.id) filter (where x.state = 'no_show') as no_shows,
      count(x.id) filter (where x.state = 'cancelled') as cancellations,
      round(avg(x.wait_min))::int as avg_wait_min,
      round(avg(x.service_min))::int as avg_service_min,
      round(avg(x.overall_rating), 2) as rating_average,
      coalesce(round(sum(x.takings), 2), 0) as est_takings_ghs
    from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') as d(day)
    left join tix x on x.visit_date = d.day::date
    group by d.day
  ),
  hours as (
    select
      x.visit_hour as hour,
      round(count(*)::numeric / v_days, 1) as avg_joined_per_day,
      round(avg(x.wait_min))::int as avg_wait_min
    from tix x
    group by x.visit_hour
  ),
  barber_rows as (
    select
      b.id as barber_id,
      su.name,
      count(*) filter (where x.served) as served,
      round(avg(x.service_min))::int as avg_service_min,
      count(*) filter (where x.state = 'no_show') as no_shows,
      round(avg(x.overall_rating), 2) as rating_average,
      coalesce(round(sum(x.takings), 2), 0) as est_takings_ghs
    from tix x
    join barbers b on b.id = x.assigned_barber_id
    join staff_users su on su.id = b.staff_user_id
    group by b.id, su.name
  ),
  service_rows as (
    select
      s.name,
      count(*) filter (where x.served) as served,
      round(avg(x.service_min))::int as avg_service_min,
      max(coalesce(bs.duration_minutes_override, s.default_duration_minutes)) as listed_duration_min,
      coalesce(round(sum(x.takings), 2), 0) as est_takings_ghs
    from tix x
    join branch_services bs on bs.id = x.branch_service_id
    join services s on s.id = bs.service_id
    group by s.id, s.name
  ),
  reason_rows as (
    select coalesce(x.cancel_reason::text, 'other') as reason, count(*) as n
    from tix x
    where x.state = 'cancelled'
    group by 1
  )
  select jsonb_build_object(
    'summary', (select s.data from summaries s where s.is_total),
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'date', d.day,
        'served', d.served,
        'walk_ins', d.walk_ins,
        'appointments', d.appointments,
        'no_shows', d.no_shows,
        'cancellations', d.cancellations,
        'avg_wait_min', d.avg_wait_min,
        'avg_service_min', d.avg_service_min,
        'rating_average', d.rating_average,
        'est_takings_ghs', d.est_takings_ghs
      ) order by d.day), '[]'::jsonb)
      from daily d
    ),
    'hours', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'hour', h.hour,
        'avg_joined_per_day', h.avg_joined_per_day,
        'avg_wait_min', h.avg_wait_min
      ) order by h.hour), '[]'::jsonb)
      from hours h
    ),
    'barbers', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'barber_id', br.barber_id,
        'name', br.name,
        'served', br.served,
        'avg_service_min', br.avg_service_min,
        'no_shows', br.no_shows,
        'rating_average', br.rating_average,
        'est_takings_ghs', br.est_takings_ghs
      ) order by br.served desc, br.name), '[]'::jsonb)
      from barber_rows br
    ),
    'services', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'name', sv.name,
        'served', sv.served,
        'share', sv.share,
        'avg_service_min', sv.avg_service_min,
        'listed_duration_min', sv.listed_duration_min,
        'est_takings_ghs', sv.est_takings_ghs
      ) order by sv.served desc, sv.name), '[]'::jsonb)
      from (
        select service_rows.*,
          round(100.0 * served / nullif(sum(served) over (), 0), 1) as share
        from service_rows
      ) sv
    ),
    'cancel_reasons', (
      select coalesce(jsonb_agg(jsonb_build_object('reason', rr.reason, 'count', rr.n)
        order by rr.n desc, rr.reason), '[]'::jsonb)
      from reason_rows rr
    ),
    'branches', case when cardinality(p_branch_ids) > 1 then (
      select coalesce(jsonb_agg(
        s.data || jsonb_build_object('branch_id', s.branch_id, 'name', b.name)
        order by b.name), '[]'::jsonb)
      from summaries s
      join branches b on b.id = s.branch_id
      where not s.is_total
    ) end
  )
  into v_result;

  return v_result;
end;
$$;

revoke execute on function branch_report(uuid[], date, date) from public, anon;
grant execute on function branch_report(uuid[], date, date) to authenticated;
```

- [ ] **Step 4: Update the database types**

In `packages/shared/src/database.types.ts` `Functions` (alphabetical):
```typescript
      branch_report: {
        Args: { p_branch_ids: string[]; p_from: string; p_to: string };
        Returns: Json;
      };
```
Run: `npm run typecheck` — Expected: no errors.

- [ ] **Step 5: Commit and hand over for the push**

```bash
git add supabase/migrations/20261008090100_branch_report.sql tests/db/branch-report.test.ts packages/shared/src/database.types.ts
git commit -m "feat: branch report function for date ranges and branch comparison"
```
Report "ready for push". After the push: `npx vitest run tests/db/branch-report.test.ts` — Expected: PASS. If a value differs after the push, fix the SQL in a new migration file (the pushed one is never edited).

---

### Task 3: Today page, long-wait setting and home links

**Files:**
- Create: `apps/staff/app/reports/format.ts`, `apps/staff/app/reports/format.test.ts`
- Create: `apps/staff/app/reports/Metric.tsx`
- Create: `apps/staff/app/today/todayTypes.ts`, `apps/staff/app/today/page.tsx`
- Modify: `apps/staff/app/settings/branch/[id]/page.tsx`
- Modify: `apps/staff/app/page.tsx`
- Modify: `apps/staff/messages/en.json`
- Create: `e2e/staff-reports.spec.ts`

**Interfaces:**
- Consumes: Task 1's `branch_today` (shape above), `set_long_wait_warning`; `loadManageableBranches` from `apps/staff/app/settings/barbers/scope.ts`.
- Produces: `format.ts` exports `EMPTY = '—'`, `formatMinutes(v: number | null | undefined): string`, `formatMoney(v)`, `formatPercent(v)`, `formatRating(v)`, `formatCount(v)`, `formatHour(h: number): string`, `formatDay(iso: string): string`, `formatTime(iso: string): string`; `Metric({ label, value }: { label: string; value: string | number })` rendering `role="group"` named by `label`; `e2e/staff-reports.spec.ts` with a `test.describe.serial` block, shared seed (`beforeAll`/`afterAll`), `seed`, `visitDay` and helper `logIn(page)` that later tasks add tests to.

- [ ] **Step 1: Write the failing formatting tests**

Create `apps/staff/app/reports/format.test.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import {
  EMPTY,
  formatCount,
  formatDay,
  formatHour,
  formatMinutes,
  formatMoney,
  formatPercent,
  formatRating,
  formatTime,
} from './format';

describe('report formatting', () => {
  it('formats minutes, money, percentages and ratings, with a dash for missing values', () => {
    expect(formatMinutes(18)).toBe('18 min');
    expect(formatMinutes(null)).toBe(EMPTY);
    expect(formatMoney(1250)).toBe('GHS 1,250.00');
    expect(formatMoney(0)).toBe('GHS 0.00');
    expect(formatMoney(undefined)).toBe(EMPTY);
    expect(formatPercent(37.5)).toBe('37.5%');
    expect(formatPercent(20)).toBe('20.0%');
    expect(formatPercent(null)).toBe(EMPTY);
    expect(formatRating(3.5)).toBe('3.50');
    expect(formatRating(null)).toBe(EMPTY);
    expect(formatCount(0)).toBe('0');
    expect(formatCount(null)).toBe(EMPTY);
  });

  it('formats hours, days and times in Ghana time', () => {
    expect(formatHour(9)).toBe('09:00');
    expect(formatHour(15)).toBe('15:00');
    expect(formatDay('2026-09-28')).toBe('Mon 28 Sep');
    expect(formatTime('2026-10-08T10:42:00Z')).toBe('10:42');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/staff/app/reports/format.test.ts --environment=node`
Expected: FAIL (cannot find `./format`).

- [ ] **Step 3: Write the formatting helpers and the Metric component**

Create `apps/staff/app/reports/format.ts`:
```typescript
// Display formatting shared by the Today dashboard, Reports page and PDF export
// (Docs/superpowers/specs/2026-10-08-reports-dashboard-design.md). Ghana time is UTC.
export const EMPTY = '—';

type Num = number | null | undefined;

export const formatMinutes = (v: Num) => (v == null ? EMPTY : `${v} min`);

export const formatMoney = (v: Num) =>
  v == null
    ? EMPTY
    : `GHS ${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const formatPercent = (v: Num) => (v == null ? EMPTY : `${Number(v).toFixed(1)}%`);

export const formatRating = (v: Num) => (v == null ? EMPTY : Number(v).toFixed(2));

export const formatCount = (v: Num) => (v == null ? EMPTY : String(v));

export const formatHour = (h: number) => `${String(h).padStart(2, '0')}:00`;

export const formatDay = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T00:00:00Z`)
    .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    .replace(',', '');

export const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
```

Create `apps/staff/app/reports/Metric.tsx`:
```tsx
// One labelled number, announced as a group named after its label (screen readers and tests).
export function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div role="group" aria-label={label} style={{ display: 'inline-block', margin: '0 1rem 0.5rem 0' }}>
      <div>{label}</div>
      <strong style={{ fontSize: '1.5rem' }}>{value}</strong>
    </div>
  );
}
```

Run: `npx vitest run apps/staff/app/reports/format.test.ts --environment=node` — Expected: PASS.

- [ ] **Step 4: Add the copy**

In `apps/staff/messages/en.json`:
- `Home`: add `"todayLink": "Today"` and `"reportsLink": "Reports"`.
- `BranchSettings`: add `"longWait": "Long wait warning (minutes)"`, `"longWaitInvalid": "Enter a number from 5 to 180."`, `"saveLongWait": "Save warning"`, `"longWaitSaved": "Warning saved"`.
- New namespace after `Feedback`:
```json
  "Today": {
    "title": "Today",
    "branch": "Branch",
    "noAccess": "You don't have access to this page.",
    "loadFailed": "Couldn't load the dashboard.",
    "noBranches": "You don't manage any branches.",
    "longWait": "Waits are long: people have waited {minutes} min on average (limit {limit} min).",
    "nowTitle": "Right now",
    "waiting": "Waiting",
    "called": "Called",
    "inService": "In service",
    "appointmentsToCome": "Appointments still to come",
    "barbersAvailable": "Barbers available",
    "barbersBusy": "Barbers busy",
    "todayTitle": "So far today",
    "served": "Served",
    "walkIns": "Walk-ins",
    "appointments": "Appointments",
    "noShows": "No-shows",
    "cancellations": "Cancellations",
    "avgWait": "Average wait",
    "avgService": "Average haircut time",
    "ratingsTitle": "Ratings today",
    "ratings": "{count, plural, one {# rating} other {# ratings}} · {average} average",
    "ratingsNone": "No ratings yet",
    "updated": "Updated {time}"
  }
```

- [ ] **Step 5: Write the Today page**

Create `apps/staff/app/today/todayTypes.ts`:
```typescript
// Shape of branch_today() (supabase/migrations/20261008090000_today_dashboard.sql).
export interface TodayData {
  now: {
    waiting: number;
    called: number;
    in_service: number;
    appointments_to_come: number;
    barbers_available: number;
    barbers_busy: number;
  };
  today: {
    served: number;
    walk_ins: number;
    appointments: number;
    no_shows: number;
    cancellations: number;
    avg_wait_min: number | null;
    avg_service_min: number | null;
  };
  ratings: { count: number; average: number | null } | null;
  long_wait: { threshold_min: number; current_avg_wait_min: number | null; alert: boolean };
  updated_at: string;
}
```

Create `apps/staff/app/today/page.tsx`:
```tsx
'use client';

// Today dashboard (Docs/superpowers/specs/2026-10-08-reports-dashboard-design.md, Section 1):
// branch picker, long-wait banner, right-now and so-far-today numbers, today's ratings for report
// viewers; refreshes every 30 seconds.
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import { loadManageableBranches, type ManageableBranch } from '../settings/barbers/scope';
import { formatMinutes, formatRating, formatTime } from '../reports/format';
import { Metric } from '../reports/Metric';
import type { TodayData } from './todayTypes';

const REFRESH_MS = 30_000;

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Loaded = { key: string; kind: 'ok'; data: TodayData } | { key: string; kind: 'error' };

export default function TodayPage() {
  const t = useTranslations('Today');
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [canView, setCanView] = useState<boolean | null>(null);
  const [branches, setBranches] = useState<ManageableBranch[]>([]);
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  const [branchesFailed, setBranchesFailed] = useState(false);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let cancelled = false;
    supabase.rpc('has_capability', { cap: 'view_branch_dashboard' }).then(({ data }) => {
      if (cancelled) return;
      setCanView(data === true);
      if (data !== true) return;
      loadManageableBranches(supabase)
        .then((list) => {
          if (cancelled) return;
          setBranches(list);
          setBranchesLoaded(true);
          setBranchId((prev) => prev ?? list[0]?.id ?? null);
        })
        .catch(() => {
          if (!cancelled) setBranchesFailed(true);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!branchId) return;
    let cancelled = false;
    const key = branchId;
    supabase.rpc('branch_today', { p_branch_id: branchId }).then(({ data, error }) => {
      if (cancelled) return;
      setLoaded(
        error ? { key, kind: 'error' } : { key, kind: 'ok', data: data as unknown as TodayData },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [supabase, branchId, tick]);

  // Keyed by branch only, so a 30-second refresh keeps showing the previous numbers until the
  // new ones arrive.
  const current = loaded && loaded.key === branchId ? loaded : null;

  return (
    <main>
      <h1>{t('title')}</h1>
      {canView === false && <p>{t('noAccess')}</p>}
      {canView === true && branchesFailed && <p role="alert">{t('loadFailed')}</p>}
      {canView === true && !branchesFailed && branchesLoaded && branches.length === 0 && (
        <p>{t('noBranches')}</p>
      )}
      {branches.length > 0 && (
        <div>
          <label htmlFor="today-branch">{t('branch')}</label>
          <select
            id="today-branch"
            value={branchId ?? ''}
            onChange={(e) => setBranchId(e.target.value)}
          >
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {current?.kind === 'error' && <p role="alert">{t('loadFailed')}</p>}
      {current?.kind === 'ok' && <TodayView data={current.data} t={t as unknown as Translate} />}
    </main>
  );
}

function TodayView({ data: d, t }: { data: TodayData; t: Translate }) {
  return (
    <>
      {d.long_wait.alert && (
        <p
          role="alert"
          style={{ background: '#B91C1C', color: '#FFFFFF', padding: '0.5rem', borderRadius: 4 }}
        >
          {t('longWait', {
            minutes: d.long_wait.current_avg_wait_min ?? 0,
            limit: d.long_wait.threshold_min,
          })}
        </p>
      )}
      <section aria-labelledby="today-now">
        <h2 id="today-now">{t('nowTitle')}</h2>
        <Metric label={t('waiting')} value={d.now.waiting} />
        <Metric label={t('called')} value={d.now.called} />
        <Metric label={t('inService')} value={d.now.in_service} />
        <Metric label={t('appointmentsToCome')} value={d.now.appointments_to_come} />
        <Metric label={t('barbersAvailable')} value={d.now.barbers_available} />
        <Metric label={t('barbersBusy')} value={d.now.barbers_busy} />
      </section>
      <section aria-labelledby="today-so-far">
        <h2 id="today-so-far">{t('todayTitle')}</h2>
        <Metric label={t('served')} value={d.today.served} />
        <Metric label={t('walkIns')} value={d.today.walk_ins} />
        <Metric label={t('appointments')} value={d.today.appointments} />
        <Metric label={t('noShows')} value={d.today.no_shows} />
        <Metric label={t('cancellations')} value={d.today.cancellations} />
        <Metric label={t('avgWait')} value={formatMinutes(d.today.avg_wait_min)} />
        <Metric label={t('avgService')} value={formatMinutes(d.today.avg_service_min)} />
      </section>
      {d.ratings && (
        <section aria-labelledby="today-ratings">
          <h2 id="today-ratings">{t('ratingsTitle')}</h2>
          <p>
            {d.ratings.count === 0
              ? t('ratingsNone')
              : t('ratings', { count: d.ratings.count, average: formatRating(d.ratings.average) })}
          </p>
        </section>
      )}
      <p>{t('updated', { time: formatTime(d.updated_at) })}</p>
    </>
  );
}
```

- [ ] **Step 6: Add the long-wait field to Branch Settings**

In `apps/staff/app/settings/branch/[id]/page.tsx`:
- New state: `const [longWait, setLongWait] = useState('20');`, `const [longWaitError, setLongWaitError] = useState<string | null>(null);`, `const [longWaitSaved, setLongWaitSaved] = useState(false);`.
- In `load()`, after `setBranch(branchRow ?? null);` add `if (branchRow) setLongWait(String(branchRow.long_wait_warning_minutes));`.
- New handler:
```tsx
  async function handleSaveLongWait(e: React.FormEvent) {
    e.preventDefault();
    setLongWaitError(null);
    setLongWaitSaved(false);
    const minutes = Number(longWait);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 180) {
      setLongWaitError(t('longWaitInvalid'));
      return;
    }
    const { error: rpcError } = await supabase.rpc('set_long_wait_warning', {
      p_branch_id: params.id,
      p_minutes: minutes,
    });
    if (rpcError) {
      setLongWaitError(rpcError.message === 'invalid_minutes' ? t('longWaitInvalid') : rpcError.message);
      return;
    }
    setLongWaitSaved(true);
  }
```
- Between the branch form and `<h2>{t('hoursTitle')}</h2>`:
```tsx
      <form onSubmit={handleSaveLongWait}>
        <label htmlFor="long-wait">{t('longWait')}</label>
        <input
          id="long-wait"
          type="number"
          min={5}
          max={180}
          value={longWait}
          onChange={(e) => setLongWait(e.target.value)}
        />
        <button type="submit">{t('saveLongWait')}</button>
        {longWaitError && <p role="alert">{longWaitError}</p>}
        {longWaitSaved && <p>{t('longWaitSaved')}</p>}
      </form>
```

- [ ] **Step 7: Link Today and Reports from the staff home page**

In `apps/staff/app/page.tsx`: add `const [canViewDashboard, setCanViewDashboard] = useState(false);`, and in the effect
```tsx
    supabase
      .rpc('has_capability', { cap: 'view_branch_dashboard' })
      .then(({ data }) => setCanViewDashboard(data === true));
```
and in the links, before Branch Settings:
```tsx
      {canViewDashboard && <Link href="/today">{t('todayLink')}</Link>}
      {canViewReports && <Link href="/reports">{t('reportsLink')}</Link>}
```

- [ ] **Step 8: Write the e2e journey (Today)**

Create `e2e/staff-reports.spec.ts`:
```typescript
// e2e/staff-reports.spec.ts
// Today dashboard and Reports (Docs/superpowers/specs/2026-10-08-reports-dashboard-design.md): a
// branch manager sets the long-wait limit, sees Today with the warning, opens Reports and downloads
// the files. One shared seed; clicks use Enter; page content is in <main>.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { test, expect, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const STAFF = 'http://localhost:3001';
const PASSWORD = 'Test-Password-123!';
const DAY = 24 * 60 * 60 * 1000;
const dateAt = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

const admin = createClient<Database>(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const suffix = String(Date.now());
const managerEmail = `srp-mgr-${suffix}@test.pixelbarber.local`;
const barberEmail = `srp-barber-${suffix}@test.pixelbarber.local`;
const visitDay = dateAt(-3);
const seed: {
  authIds: string[];
  staffIds: string[];
  customerIds: string[];
  serviceId?: string;
  branchId?: string;
  branchCode: string;
  bsId?: string;
} = { authIds: [], staffIds: [], customerIds: [], branchCode: `SR${suffix.slice(-6)}` };

async function logIn(page: Page) {
  await page.goto(`${STAFF}/login`);
  await page.getByPlaceholder('Email or phone').fill(managerEmail);
  await page.getByPlaceholder('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log In' }).press('Enter');
  await page.waitForURL(/\/tickets/, { timeout: 15000 });
}

test.describe.serial('today dashboard and reports', () => {
  test.skip(!url || !serviceRoleKey, 'Supabase env vars not set');

  test.beforeAll(async () => {
    const { data: business } = await admin.from('businesses').select('id').limit(1).single();
    const { data: service } = await admin
      .from('services')
      .insert({ business_id: business!.id, name: `SRP E2E Cut ${suffix}`, default_duration_minutes: 30 })
      .select('id')
      .single();
    seed.serviceId = service!.id;
    const { data: branch } = await admin
      .from('branches')
      .insert({
        business_id: business!.id,
        name: `SRP E2E Branch ${suffix}`,
        branch_code: seed.branchCode,
        address: 'Test',
        latitude: 5.6,
        longitude: -0.18,
      })
      .select('id')
      .single();
    seed.branchId = branch!.id;
    const { data: bs } = await admin
      .from('branch_services')
      .insert({ branch_id: seed.branchId!, service_id: seed.serviceId! })
      .select('id')
      .single();
    seed.bsId = bs!.id;
    await admin
      .from('branch_service_prices')
      .insert({ branch_service_id: seed.bsId!, price_ghs: 50, effective_from: dateAt(-30) });
    const staff = async (email: string, name: string, role: 'barber' | 'branch_manager') => {
      const { data: auth } = await admin.auth.admin.createUser({
        email,
        password: PASSWORD,
        email_confirm: true,
      });
      seed.authIds.push(auth.user!.id);
      const { data: row } = await admin
        .from('staff_users')
        .insert({ auth_user_id: auth.user!.id, name, email, role, invite_status: 'accepted' })
        .select('id')
        .single();
      seed.staffIds.push(row!.id);
      return row!.id as string;
    };
    const barberStaffId = await staff(barberEmail, 'SRP E2E Barber', 'barber');
    const { data: barber } = await admin
      .from('barbers')
      .insert({ staff_user_id: barberStaffId, home_branch_id: seed.branchId!, status: 'available' })
      .select('id')
      .single();
    const managerStaffId = await staff(managerEmail, 'SRP E2E Manager', 'branch_manager');
    await admin
      .from('staff_branch_assignments')
      .insert({ staff_user_id: managerStaffId, branch_id: seed.branchId! });
    for (const i of [1, 2]) {
      const { data: customer } = await admin
        .from('customers')
        .insert({ name: `SRP Customer ${i}`, phone_e164: `+233555${suffix.slice(-5)}${i}` })
        .select('id')
        .single();
      seed.customerIds.push(customer!.id);
    }
    // A completed walk-in three days ago (wait 15, haircut 30, GHS 50) and one person waiting now
    // for 30 minutes.
    const { error: ticketsError } = await admin.from('queue_tickets').insert([
      {
        ticket_number: `PB-SRP-${suffix}-1`,
        branch_id: seed.branchId!,
        customer_id: seed.customerIds[0],
        branch_service_id: seed.bsId!,
        assigned_barber_id: barber!.id,
        state: 'completed',
        created_at: `${visitDay}T10:00:00.000Z`,
        service_started_at: `${visitDay}T10:15:00.000Z`,
        completed_at: `${visitDay}T10:45:00.000Z`,
        created_by: 'staff',
      },
      {
        ticket_number: `PB-SRP-${suffix}-2`,
        branch_id: seed.branchId!,
        customer_id: seed.customerIds[1],
        branch_service_id: seed.bsId!,
        state: 'waiting',
        created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        created_by: 'staff',
      },
    ]);
    if (ticketsError) throw ticketsError;
  });

  test.afterAll(async () => {
    const failures: string[] = [];
    const check = (label: string, res: { error: { message: string } | null }) => {
      if (res.error) failures.push(`${label}: ${res.error.message}`);
    };
    if (seed.branchId) {
      const { data: tickets } = await admin
        .from('queue_tickets')
        .select('id')
        .eq('branch_id', seed.branchId);
      const ticketIds = (tickets ?? []).map((t) => t.id);
      if (ticketIds.length) {
        check('feedback', await admin.from('feedback').delete().in('ticket_id', ticketIds));
        check(
          'notifications',
          await admin.from('notifications').delete().in('related_ticket_id', ticketIds),
        );
        check('queue_events', await admin.from('queue_events').delete().in('ticket_id', ticketIds));
      }
      check('queue_tickets', await admin.from('queue_tickets').delete().eq('branch_id', seed.branchId));
      check(
        'branch_ticket_counters',
        await admin.from('branch_ticket_counters').delete().eq('branch_id', seed.branchId),
      );
    }
    for (const id of seed.staffIds) {
      check('barbers', await admin.from('barbers').delete().eq('staff_user_id', id));
      check(
        'staff_branch_assignments',
        await admin.from('staff_branch_assignments').delete().eq('staff_user_id', id),
      );
      check('staff_users', await admin.from('staff_users').delete().eq('id', id));
    }
    for (const id of seed.authIds) await admin.auth.admin.deleteUser(id);
    for (const id of seed.customerIds) {
      check('customers', await admin.from('customers').delete().eq('id', id));
    }
    if (seed.bsId) {
      check('branch_services', await admin.from('branch_services').delete().eq('id', seed.bsId));
    }
    if (seed.branchId) check('branches', await admin.from('branches').delete().eq('id', seed.branchId));
    if (seed.serviceId) check('services', await admin.from('services').delete().eq('id', seed.serviceId));
    if (failures.length) throw new Error(`Cleanup failed:\n${failures.join('\n')}`);
  });

  test('a branch manager sets the long-wait limit and sees it on Today', async ({ page }) => {
    test.setTimeout(120_000);
    await logIn(page);
    await page.goto(`${STAFF}/settings/branch/${seed.branchId}`);
    const main = page.locator('main');
    await main.getByLabel('Long wait warning (minutes)').fill('5');
    await main.getByRole('button', { name: 'Save warning' }).press('Enter');
    await expect(main.getByText('Warning saved')).toBeVisible({ timeout: 15000 });

    await page.goto(`${STAFF}/today`);
    await main.getByLabel('Branch', { exact: true }).selectOption(seed.branchId!);
    await expect(
      main.getByText(/Waits are long: people have waited \d+ min on average \(limit 5 min\)\./),
    ).toBeVisible({ timeout: 15000 });
    await expect(main.getByRole('group', { name: 'Waiting' })).toContainText('1');
    await expect(main.getByRole('group', { name: 'Served' })).toContainText('0');
  });
});
```
(Cleanup deletes the `barbers` row before `staff_users`; the tickets referencing it are already gone by then.)

- [ ] **Step 9: Verify**

- `npx vitest run apps/staff/app/reports/format.test.ts --environment=node` — PASS.
- `npm run typecheck` — no errors.
- `cd apps/staff && npx eslint "app/today/page.tsx" "app/today/todayTypes.ts" "app/reports/format.ts" "app/reports/Metric.tsx" "app/page.tsx" "app/settings/branch/[id]/page.tsx"` — clean.
- Dev servers on 3000/3001 are probably running; otherwise start them in the background. `npx playwright test e2e/staff-reports.spec.ts --reporter=line --workers=1` — PASS.
- `grep -n $'\xef\xbf\xbd'` on every edited file — nothing.

- [ ] **Step 10: Commit**

```bash
git add apps/staff/app/reports/format.ts apps/staff/app/reports/format.test.ts apps/staff/app/reports/Metric.tsx apps/staff/app/today "apps/staff/app/settings/branch/[id]/page.tsx" apps/staff/app/page.tsx apps/staff/messages/en.json e2e/staff-reports.spec.ts
git commit -m "feat: staff Today dashboard with long-wait warning and setting"
```

---

### Task 4: Reports page and CSV downloads

**Files:**
- Create: `apps/staff/app/reports/reportTypes.ts`
- Create: `apps/staff/app/reports/presets.ts`, `apps/staff/app/reports/presets.test.ts`
- Create: `apps/staff/app/reports/csv.ts`, `apps/staff/app/reports/csv.test.ts`
- Create: `apps/staff/app/reports/__fixtures__/sampleReport.ts`
- Create: `apps/staff/app/reports/reportTables.ts`, `apps/staff/app/reports/reportTables.test.ts`
- Create: `apps/staff/app/reports/download.ts`
- Create: `apps/staff/app/reports/page.tsx`
- Modify: `apps/staff/messages/en.json`
- Modify: `e2e/staff-reports.spec.ts`

**Interfaces:**
- Consumes: Task 2's `branch_report` (shape above); Task 3's `format.ts`, `Metric`, and `e2e/staff-reports.spec.ts` (`seed`, `logIn`, `visitDay`).
- Produces:
  - `reportTypes.ts`: `ReportSummary`, `DailyRow`, `HourRow`, `BarberRow`, `ServiceRow`, `ReasonRow`, `BranchRow`, `BranchReport`.
  - `presets.ts`: `type Preset = 'last7' | 'last30' | 'thisMonth' | 'lastMonth' | 'custom'`; `presetRange(preset: Exclude<Preset, 'custom'>, today: string): { from: string; to: string }`.
  - `csv.ts`: `toCsv(headers: string[], rows: (string | number | null)[][]): string`.
  - `reportTables.ts`: `type Cell = string | number | null`; `type Label = (key: string, values?: Record<string, string | number>) => string`; `interface SummaryItem { key: string; label: string; raw: Cell; display: string }`; `interface ReportTable { key: 'daily' | 'hours' | 'barbers' | 'services' | 'reasons' | 'branches'; fileKey: string; title: string; headers: string[]; raw: Cell[][]; display: string[][]; takingsColumn: number | null; shade: number[] | null }`; `buildSummaryItems(summary: ReportSummary, label: Label): SummaryItem[]`; `buildReportTables(report: BranchReport, label: Label): ReportTable[]`.
  - `download.ts`: `downloadBlob(blob: Blob, fileName: string): void`.
  - `__fixtures__/sampleReport.ts`: `sampleReport: BranchReport` (one branch) and `sampleAllBranches: BranchReport` (with `branches`).
  - e2e helper `openReport(page): Promise<Locator>` (the `main` locator after the custom range has loaded).

- [ ] **Step 1: Write the failing unit tests**

Create `apps/staff/app/reports/presets.test.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import { presetRange } from './presets';

describe('presetRange', () => {
  it('counts today in the last 7 and 30 days', () => {
    expect(presetRange('last7', '2026-10-08')).toEqual({ from: '2026-10-02', to: '2026-10-08' });
    expect(presetRange('last30', '2026-10-08')).toEqual({ from: '2026-09-09', to: '2026-10-08' });
  });

  it('covers this month so far and the whole of last month', () => {
    expect(presetRange('thisMonth', '2026-10-08')).toEqual({ from: '2026-10-01', to: '2026-10-08' });
    expect(presetRange('lastMonth', '2026-10-08')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(presetRange('lastMonth', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });
});
```

Create `apps/staff/app/reports/csv.test.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';

describe('toCsv', () => {
  it('writes a header row and rows, leaving missing values empty', () => {
    expect(toCsv(['Barber', 'Served', 'Average rating'], [['Kofi', 2, null], ['Ama', 0, 4.5]])).toBe(
      'Barber,Served,Average rating\r\nKofi,2,\r\nAma,0,4.5\r\n',
    );
  });

  it('quotes values with commas, quotes or line breaks', () => {
    expect(toCsv(['Reason'], [["Can't make it, sorry"], ['He said "no"'], ['two\nlines']])).toBe(
      'Reason\r\n"Can\'t make it, sorry"\r\n"He said ""no"""\r\n"two\nlines"\r\n',
    );
  });
});
```

Create `apps/staff/app/reports/__fixtures__/sampleReport.ts`:
```typescript
// A small report (two days, one barber, one service) for the table and export builder tests.
import type { BranchReport, ReportSummary } from '../reportTypes';

const summary: ReportSummary = {
  served: 3,
  walk_ins: 2,
  appointments: 1,
  no_shows: 1,
  no_show_rate: 25,
  cancellations: 1,
  cancellation_rate: 20,
  avg_wait_min: 18,
  median_wait_min: 15,
  avg_service_min: 25,
  rating_count: 2,
  rating_average: 3.5,
  est_takings_ghs: 1250,
  returning_rate: 33.3,
};

export const sampleReport: BranchReport = {
  summary,
  daily: [
    { date: '2026-09-28', served: 2, walk_ins: 2, appointments: 0, no_shows: 1, cancellations: 0, avg_wait_min: 25, avg_service_min: 25, rating_average: 3.5, est_takings_ghs: 900 },
    { date: '2026-09-29', served: 1, walk_ins: 0, appointments: 1, no_shows: 0, cancellations: 1, avg_wait_min: null, avg_service_min: null, rating_average: null, est_takings_ghs: 350 },
  ],
  hours: [
    { hour: 10, avg_joined_per_day: 2, avg_wait_min: 25 },
    { hour: 14, avg_joined_per_day: 1, avg_wait_min: null },
  ],
  barbers: [
    { barber_id: 'b1', name: 'Kofi', served: 3, avg_service_min: 25, no_shows: 1, rating_average: 3.5, est_takings_ghs: 1250 },
  ],
  services: [
    { name: 'Haircut', served: 3, share: 100, avg_service_min: 25, listed_duration_min: 30, est_takings_ghs: 1250 },
  ],
  cancel_reasons: [{ reason: 'cant_make_it', count: 1 }],
  branches: null,
};

export const sampleAllBranches: BranchReport = {
  ...sampleReport,
  branches: [
    { ...summary, branch_id: 'br1', name: 'Osu' },
    { ...summary, branch_id: 'br2', name: 'Tema', served: 0, est_takings_ghs: 0, avg_wait_min: null },
  ],
};
```

Create `apps/staff/app/reports/reportTables.test.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import { buildReportTables, buildSummaryItems, type Label } from './reportTables';
import { sampleAllBranches, sampleReport } from './__fixtures__/sampleReport';

// Labels come back as their keys so the tests can see which copy each cell uses.
const label: Label = (key) => key;

describe('buildSummaryItems', () => {
  it('lists every summary number with raw and display values', () => {
    const items = buildSummaryItems(sampleReport.summary, label);
    expect(items.map((i) => i.key)).toEqual([
      'served', 'walk_ins', 'appointments', 'no_shows', 'no_show_rate', 'cancellations',
      'cancellation_rate', 'avg_wait_min', 'median_wait_min', 'avg_service_min', 'rating_count',
      'rating_average', 'est_takings_ghs', 'returning_rate',
    ]);
    expect(items[0]).toEqual({ key: 'served', label: 'summary.served', raw: 3, display: '3' });
    expect(items.find((i) => i.key === 'avg_wait_min')).toMatchObject({ raw: 18, display: '18 min' });
    expect(items.find((i) => i.key === 'est_takings_ghs')).toMatchObject({
      raw: 1250,
      display: 'GHS 1,250.00 summary.estimatedSuffix',
    });
    expect(items.find((i) => i.key === 'no_show_rate')).toMatchObject({ raw: 25, display: '25.0%' });
  });
});

describe('buildReportTables', () => {
  it('builds the five tables for one branch in page order', () => {
    const tables = buildReportTables(sampleReport, label);
    expect(tables.map((t) => [t.key, t.fileKey, t.title])).toEqual([
      ['daily', 'daily', 'tables.daily'],
      ['hours', 'hours', 'tables.hours'],
      ['barbers', 'barbers', 'tables.barbers'],
      ['services', 'services', 'tables.services'],
      ['reasons', 'cancellation-reasons', 'tables.reasons'],
    ]);
  });

  it('keeps raw values for exports and formatted values for the page', () => {
    const [daily, hours, barbers, services, reasons] = buildReportTables(sampleReport, label);
    expect(daily.headers).toEqual([
      'columns.date', 'columns.served', 'columns.walkIns', 'columns.appointments',
      'columns.noShows', 'columns.cancellations', 'columns.avgWait', 'columns.avgService',
      'columns.ratingAverage', 'columns.takings',
    ]);
    expect(daily.raw[1]).toEqual(['2026-09-29', 1, 0, 1, 0, 1, null, null, null, 350]);
    expect(daily.display[1]).toEqual(['Tue 29 Sep', '1', '0', '1', '0', '1', '—', '—', '—', 'GHS 350.00']);
    expect(daily.takingsColumn).toBe(9);
    expect(hours.raw).toEqual([[10, 2, 25], [14, 1, null]]);
    expect(hours.display[0]).toEqual(['10:00', '2.0', '25 min']);
    expect(hours.shade).toEqual([1, 0.5]);
    expect(barbers.raw[0]).toEqual(['Kofi', 3, 25, 1, 3.5, 1250]);
    expect(barbers.display[0]).toEqual(['Kofi', '3', '25 min', '1', '3.50', 'GHS 1,250.00']);
    expect(services.headers).toEqual([
      'columns.service', 'columns.served', 'columns.share', 'columns.avgService',
      'columns.listedDuration', 'columns.takings',
    ]);
    expect(services.display[0]).toEqual(['Haircut', '3', '100.0%', '25 min', '30 min', 'GHS 1,250.00']);
    expect(reasons.raw[0]).toEqual(['reasons.cant_make_it', 1]);
    expect(reasons.takingsColumn).toBeNull();
  });

  it('adds the branch comparison when several branches are shown', () => {
    const tables = buildReportTables(sampleAllBranches, label);
    const branches = tables[tables.length - 1];
    expect(branches.key).toBe('branches');
    expect(branches.fileKey).toBe('branches');
    expect(branches.headers[0]).toBe('columns.branch');
    expect(branches.headers).toHaveLength(15);
    expect(branches.raw[1][0]).toBe('Tema');
    expect(branches.display[1][8]).toBe('—');
  });
});
```
(Branch comparison columns: 0 Branch, 1 Served, 2 Walk-ins, 3 Appointments, 4 No-shows, 5 No-show rate, 6 Cancellations, 7 Cancellation rate, 8 Average wait, …; Tema's average wait is null, so display index 8 is `—`.)

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/staff/app/reports --environment=node`
Expected: FAIL (cannot find `./presets`, `./csv`, `./reportTables`, `../reportTypes`).

- [ ] **Step 3: Write the types, presets, CSV and table builders**

Create `apps/staff/app/reports/reportTypes.ts`:
```typescript
// Shape of branch_report() (supabase/migrations/20261008090100_branch_report.sql).
export interface ReportSummary {
  served: number;
  walk_ins: number;
  appointments: number;
  no_shows: number;
  no_show_rate: number | null;
  cancellations: number;
  cancellation_rate: number | null;
  avg_wait_min: number | null;
  median_wait_min: number | null;
  avg_service_min: number | null;
  rating_count: number;
  rating_average: number | null;
  est_takings_ghs: number;
  returning_rate: number | null;
}

export interface DailyRow {
  date: string;
  served: number;
  walk_ins: number;
  appointments: number;
  no_shows: number;
  cancellations: number;
  avg_wait_min: number | null;
  avg_service_min: number | null;
  rating_average: number | null;
  est_takings_ghs: number;
}

export interface HourRow {
  hour: number;
  avg_joined_per_day: number;
  avg_wait_min: number | null;
}

export interface BarberRow {
  barber_id: string;
  name: string;
  served: number;
  avg_service_min: number | null;
  no_shows: number;
  rating_average: number | null;
  est_takings_ghs: number;
}

export interface ServiceRow {
  name: string;
  served: number;
  share: number | null;
  avg_service_min: number | null;
  listed_duration_min: number;
  est_takings_ghs: number;
}

export interface ReasonRow {
  reason: string;
  count: number;
}

export interface BranchRow extends ReportSummary {
  branch_id: string;
  name: string;
}

export interface BranchReport {
  summary: ReportSummary;
  daily: DailyRow[];
  hours: HourRow[];
  barbers: BarberRow[];
  services: ServiceRow[];
  cancel_reasons: ReasonRow[];
  branches: BranchRow[] | null;
}
```

Create `apps/staff/app/reports/presets.ts`:
```typescript
// Report date presets (Ghana dates, YYYY-MM-DD). "Last 7 days" includes today.
export type Preset = 'last7' | 'last30' | 'thisMonth' | 'lastMonth' | 'custom';

const DAY_MS = 24 * 60 * 60 * 1000;

function shift(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}

export function presetRange(
  preset: Exclude<Preset, 'custom'>,
  today: string,
): { from: string; to: string } {
  const firstOfMonth = `${today.slice(0, 7)}-01`;
  switch (preset) {
    case 'last7':
      return { from: shift(today, -6), to: today };
    case 'last30':
      return { from: shift(today, -29), to: today };
    case 'thisMonth':
      return { from: firstOfMonth, to: today };
    case 'lastMonth': {
      const lastOfPrevious = shift(firstOfMonth, -1);
      return { from: `${lastOfPrevious.slice(0, 7)}-01`, to: lastOfPrevious };
    }
  }
}
```

Create `apps/staff/app/reports/csv.ts`:
```typescript
// CSV text for one report table: header row, then rows; null becomes an empty cell; values with
// commas, quotes or line breaks are quoted.
export function toCsv(headers: string[], rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => {
    if (v === null) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
```

Create `apps/staff/app/reports/reportTables.ts`:
```typescript
// One description of every report table (headers, raw values, display values) used by the Reports
// page, CSV, Excel and PDF, so all four always show the same columns
// (Docs/superpowers/specs/2026-10-08-reports-dashboard-design.md, Section 2).
import type { BranchReport, ReportSummary } from './reportTypes';
import {
  formatCount,
  formatDay,
  formatHour,
  formatMinutes,
  formatMoney,
  formatPercent,
  formatRating,
} from './format';

export type Cell = string | number | null;
export type Label = (key: string, values?: Record<string, string | number>) => string;

export interface SummaryItem {
  key: string;
  label: string;
  raw: Cell;
  display: string;
}

export interface ReportTable {
  key: 'daily' | 'hours' | 'barbers' | 'services' | 'reasons' | 'branches';
  /** Used in CSV file names: pixel-barber-{fileKey}-{from}-{to}.csv */
  fileKey: string;
  title: string;
  headers: string[];
  raw: Cell[][];
  display: string[][];
  /** Index of the Estimated takings column (the PDF adds "(GHS)" to its header). */
  takingsColumn: number | null;
  /** 0–1 per row for Busiest hours shading; null elsewhere. */
  shade: number[] | null;
}

interface Column<R> {
  label: string;
  raw: (r: R) => Cell;
  display: (r: R) => string;
  takings?: boolean;
}

function makeTable<R>(
  key: ReportTable['key'],
  fileKey: string,
  title: string,
  rows: R[],
  columns: Column<R>[],
  shade: number[] | null = null,
): ReportTable {
  const takings = columns.findIndex((c) => c.takings);
  return {
    key,
    fileKey,
    title,
    headers: columns.map((c) => c.label),
    raw: rows.map((r) => columns.map((c) => c.raw(r))),
    display: rows.map((r) => columns.map((c) => c.display(r))),
    takingsColumn: takings === -1 ? null : takings,
    shade,
  };
}

type Num = number | null;
const count = <R>(label: string, get: (r: R) => Num): Column<R> => ({
  label,
  raw: get,
  display: (r) => formatCount(get(r)),
});
const minutes = <R>(label: string, get: (r: R) => Num): Column<R> => ({
  label,
  raw: get,
  display: (r) => formatMinutes(get(r)),
});
const percent = <R>(label: string, get: (r: R) => Num): Column<R> => ({
  label,
  raw: get,
  display: (r) => formatPercent(get(r)),
});
const rating = <R>(label: string, get: (r: R) => Num): Column<R> => ({
  label,
  raw: get,
  display: (r) => formatRating(get(r)),
});
const money = <R>(label: string, get: (r: R) => Num): Column<R> => ({
  label,
  raw: get,
  display: (r) => formatMoney(get(r)),
  takings: true,
});
const text = <R>(label: string, get: (r: R) => string): Column<R> => ({
  label,
  raw: get,
  display: get,
});

function summaryColumns<R extends ReportSummary>(label: Label): Column<R>[] {
  return [
    count(label('columns.served'), (r) => r.served),
    count(label('columns.walkIns'), (r) => r.walk_ins),
    count(label('columns.appointments'), (r) => r.appointments),
    count(label('columns.noShows'), (r) => r.no_shows),
    percent(label('columns.noShowRate'), (r) => r.no_show_rate),
    count(label('columns.cancellations'), (r) => r.cancellations),
    percent(label('columns.cancellationRate'), (r) => r.cancellation_rate),
    minutes(label('columns.avgWait'), (r) => r.avg_wait_min),
    minutes(label('columns.medianWait'), (r) => r.median_wait_min),
    minutes(label('columns.avgService'), (r) => r.avg_service_min),
    count(label('columns.ratingCount'), (r) => r.rating_count),
    rating(label('columns.ratingAverage'), (r) => r.rating_average),
    money(label('columns.takings'), (r) => r.est_takings_ghs),
    percent(label('columns.returning'), (r) => r.returning_rate),
  ];
}

export function buildSummaryItems(s: ReportSummary, label: Label): SummaryItem[] {
  const item = (key: keyof ReportSummary, labelKey: string, display: string): SummaryItem => ({
    key,
    label: label(`summary.${labelKey}`),
    raw: s[key],
    display,
  });
  return [
    item('served', 'served', formatCount(s.served)),
    item('walk_ins', 'walkIns', formatCount(s.walk_ins)),
    item('appointments', 'appointments', formatCount(s.appointments)),
    item('no_shows', 'noShows', formatCount(s.no_shows)),
    item('no_show_rate', 'noShowRate', formatPercent(s.no_show_rate)),
    item('cancellations', 'cancellations', formatCount(s.cancellations)),
    item('cancellation_rate', 'cancellationRate', formatPercent(s.cancellation_rate)),
    item('avg_wait_min', 'avgWait', formatMinutes(s.avg_wait_min)),
    item('median_wait_min', 'medianWait', formatMinutes(s.median_wait_min)),
    item('avg_service_min', 'avgService', formatMinutes(s.avg_service_min)),
    item('rating_count', 'ratingCount', formatCount(s.rating_count)),
    item('rating_average', 'ratingAverage', formatRating(s.rating_average)),
    item(
      'est_takings_ghs',
      'takings',
      `${formatMoney(s.est_takings_ghs)} ${label('summary.estimatedSuffix')}`,
    ),
    item('returning_rate', 'returning', formatPercent(s.returning_rate)),
  ];
}

export function buildReportTables(report: BranchReport, label: Label): ReportTable[] {
  const maxJoined = Math.max(0, ...report.hours.map((h) => h.avg_joined_per_day));
  const tables: ReportTable[] = [
    makeTable('daily', 'daily', label('tables.daily'), report.daily, [
      { label: label('columns.date'), raw: (r) => r.date, display: (r) => formatDay(r.date) },
      count(label('columns.served'), (r) => r.served),
      count(label('columns.walkIns'), (r) => r.walk_ins),
      count(label('columns.appointments'), (r) => r.appointments),
      count(label('columns.noShows'), (r) => r.no_shows),
      count(label('columns.cancellations'), (r) => r.cancellations),
      minutes(label('columns.avgWait'), (r) => r.avg_wait_min),
      minutes(label('columns.avgService'), (r) => r.avg_service_min),
      rating(label('columns.ratingAverage'), (r) => r.rating_average),
      money(label('columns.takings'), (r) => r.est_takings_ghs),
    ]),
    makeTable(
      'hours',
      'hours',
      label('tables.hours'),
      report.hours,
      [
        { label: label('columns.hour'), raw: (r) => r.hour, display: (r) => formatHour(r.hour) },
        {
          label: label('columns.joinedPerDay'),
          raw: (r) => r.avg_joined_per_day,
          display: (r) => Number(r.avg_joined_per_day).toFixed(1),
        },
        minutes(label('columns.avgWait'), (r) => r.avg_wait_min),
      ],
      report.hours.map((h) => (maxJoined > 0 ? h.avg_joined_per_day / maxJoined : 0)),
    ),
    makeTable('barbers', 'barbers', label('tables.barbers'), report.barbers, [
      text(label('columns.barber'), (r) => r.name),
      count(label('columns.served'), (r) => r.served),
      minutes(label('columns.avgService'), (r) => r.avg_service_min),
      count(label('columns.noShows'), (r) => r.no_shows),
      rating(label('columns.ratingAverage'), (r) => r.rating_average),
      money(label('columns.takings'), (r) => r.est_takings_ghs),
    ]),
    makeTable('services', 'services', label('tables.services'), report.services, [
      text(label('columns.service'), (r) => r.name),
      count(label('columns.served'), (r) => r.served),
      percent(label('columns.share'), (r) => r.share),
      minutes(label('columns.avgService'), (r) => r.avg_service_min),
      minutes(label('columns.listedDuration'), (r) => r.listed_duration_min),
      money(label('columns.takings'), (r) => r.est_takings_ghs),
    ]),
    makeTable('reasons', 'cancellation-reasons', label('tables.reasons'), report.cancel_reasons, [
      text(label('columns.reason'), (r) => label(`reasons.${r.reason}`)),
      count(label('columns.count'), (r) => r.count),
    ]),
  ];
  if (report.branches) {
    tables.push(
      makeTable('branches', 'branches', label('tables.branches'), report.branches, [
        text(label('columns.branch'), (r) => r.name),
        ...summaryColumns(label),
      ]),
    );
  }
  return tables;
}
```

Run: `npx vitest run apps/staff/app/reports --environment=node` — Expected: PASS (format, presets, csv, reportTables).

- [ ] **Step 4: Write the download helper**

Create `apps/staff/app/reports/download.ts`:
```typescript
// Hands a generated file to the browser as a download.
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
```

- [ ] **Step 5: Add the copy**

In `apps/staff/messages/en.json`, new namespace after `Today`:
```json
  "Reports": {
    "title": "Reports",
    "branch": "Branch",
    "allBranches": "All branches",
    "period": "Period",
    "presets": {
      "last7": "Last 7 days",
      "last30": "Last 30 days",
      "thisMonth": "This month",
      "lastMonth": "Last month",
      "custom": "Custom"
    },
    "from": "From",
    "to": "To",
    "noAccess": "You don't have access to this page.",
    "noBranches": "You don't manage any branches.",
    "loadFailed": "Couldn't load the report.",
    "invalidRange": "Pick a range of up to 92 days.",
    "empty": "No visits in this period.",
    "downloadCsv": "Download CSV",
    "downloadExcel": "Download Excel",
    "downloadPdf": "Download PDF",
    "exportFailed": "Couldn't create the file. Please try again.",
    "summary": {
      "title": "Summary",
      "served": "Customers served",
      "walkIns": "Walk-ins",
      "appointments": "Appointments",
      "noShows": "No-shows",
      "noShowRate": "No-show rate",
      "cancellations": "Cancellations",
      "cancellationRate": "Cancellation rate",
      "avgWait": "Average wait",
      "medianWait": "Median wait",
      "avgService": "Average haircut time",
      "ratingCount": "Ratings",
      "ratingAverage": "Average rating",
      "takings": "Estimated takings",
      "returning": "Returning customers",
      "estimatedSuffix": "(estimated)"
    },
    "tables": {
      "summary": "Summary",
      "daily": "Day by day",
      "hours": "Busiest hours",
      "barbers": "Barbers",
      "services": "Services",
      "reasons": "Cancellation reasons",
      "branches": "Branch comparison"
    },
    "columns": {
      "date": "Date",
      "hour": "Hour",
      "barber": "Barber",
      "service": "Service",
      "reason": "Reason",
      "branch": "Branch",
      "served": "Served",
      "walkIns": "Walk-ins",
      "appointments": "Appointments",
      "noShows": "No-shows",
      "noShowRate": "No-show rate",
      "cancellations": "Cancellations",
      "cancellationRate": "Cancellation rate",
      "avgWait": "Average wait",
      "medianWait": "Median wait",
      "avgService": "Average haircut time",
      "ratingCount": "Ratings",
      "ratingAverage": "Average rating",
      "takings": "Estimated takings",
      "takingsPdf": "Estimated takings (GHS)",
      "returning": "Returning customers",
      "joinedPerDay": "Customers joining per day",
      "share": "Share",
      "listedDuration": "Listed duration",
      "count": "Count"
    },
    "reasons": {
      "wait_too_long": "Wait too long",
      "cant_make_it": "Can't make it",
      "changed_plans": "Changed plans",
      "found_another_barber": "Found another barber",
      "emergency": "Emergency",
      "other": "Other"
    },
    "export": {
      "branch": "Branch",
      "from": "From",
      "to": "To",
      "generated": "Generated",
      "pdfTitle": "Pixel Barber report",
      "pdfPeriod": "{branch} · {from} to {to}",
      "generatedAt": "Generated {time}",
      "metric": "Metric",
      "value": "Value"
    }
  }
```

- [ ] **Step 6: Write the Reports page**

Create `apps/staff/app/reports/page.tsx`:
```tsx
'use client';

// Reports (Docs/superpowers/specs/2026-10-08-reports-dashboard-design.md, Section 2): branch (or
// all branches) and period filters, summary cards and the report tables, each with a CSV download.
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import { loadManageableBranches, type ManageableBranch } from '../settings/barbers/scope';
import { Metric } from './Metric';
import { presetRange, type Preset } from './presets';
import { toCsv } from './csv';
import { downloadBlob } from './download';
import { buildReportTables, buildSummaryItems, type Label, type ReportTable } from './reportTables';
import type { BranchReport } from './reportTypes';

const ALL = 'all';
const PRESETS: Preset[] = ['last7', 'last30', 'thisMonth', 'lastMonth', 'custom'];
const ghanaToday = () => new Date().toISOString().slice(0, 10);

type Loaded =
  | { key: string; kind: 'ok'; report: BranchReport; from: string; to: string }
  | { key: string; kind: 'invalid' | 'error' };

export default function ReportsPage() {
  const t = useTranslations('Reports');
  const label = t as unknown as Label;
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [canView, setCanView] = useState<boolean | null>(null);
  const [canAll, setCanAll] = useState(false);
  const [branches, setBranches] = useState<ManageableBranch[]>([]);
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  const [branchesFailed, setBranchesFailed] = useState(false);
  const [selection, setSelection] = useState<string | null>(null);
  const [preset, setPreset] = useState<Preset>('last7');
  const [range, setRange] = useState(() => presetRange('last7', ghanaToday()));
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let cancelled = false;
    supabase.rpc('has_capability', { cap: 'view_branch_reports' }).then(({ data }) => {
      if (cancelled) return;
      setCanView(data === true);
      if (data !== true) return;
      loadManageableBranches(supabase)
        .then((list) => {
          if (cancelled) return;
          setBranches(list);
          setBranchesLoaded(true);
          setSelection((prev) => prev ?? list[0]?.id ?? null);
        })
        .catch(() => {
          if (!cancelled) setBranchesFailed(true);
        });
    });
    supabase.rpc('has_capability', { cap: 'view_business_reports' }).then(({ data }) => {
      if (!cancelled) setCanAll(data === true);
    });
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const requestKey = `${selection}:${range.from}:${range.to}`;

  useEffect(() => {
    if (!selection) return;
    const ids = selection === ALL ? branches.map((b) => b.id) : [selection];
    if (ids.length === 0) return;
    let cancelled = false;
    const key = requestKey;
    const { from, to } = range;
    supabase
      .rpc('branch_report', { p_branch_ids: ids, p_from: from, p_to: to })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setLoaded({ key, kind: error.message === 'invalid_range' ? 'invalid' : 'error' });
          return;
        }
        setLoaded({ key, kind: 'ok', report: data as unknown as BranchReport, from, to });
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, selection, branches, range, requestKey]);

  function choosePreset(next: Preset) {
    setPreset(next);
    if (next !== 'custom') setRange(presetRange(next, ghanaToday()));
  }

  const current = loaded && loaded.key === requestKey ? loaded : null;

  return (
    <main>
      <h1>{t('title')}</h1>
      {canView === false && <p>{t('noAccess')}</p>}
      {canView === true && branchesFailed && <p role="alert">{t('loadFailed')}</p>}
      {canView === true && !branchesFailed && branchesLoaded && branches.length === 0 && (
        <p>{t('noBranches')}</p>
      )}
      {branches.length > 0 && (
        <div>
          <label htmlFor="report-branch">{t('branch')}</label>
          <select
            id="report-branch"
            value={selection ?? ''}
            onChange={(e) => setSelection(e.target.value)}
          >
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
            {canAll && branches.length > 1 && <option value={ALL}>{t('allBranches')}</option>}
          </select>
          <label htmlFor="report-period">{t('period')}</label>
          <select
            id="report-period"
            value={preset}
            onChange={(e) => choosePreset(e.target.value as Preset)}
          >
            {PRESETS.map((p) => (
              <option key={p} value={p}>
                {label(`presets.${p}`)}
              </option>
            ))}
          </select>
          {preset === 'custom' && (
            <>
              <label htmlFor="report-from">{t('from')}</label>
              <input
                id="report-from"
                type="date"
                value={range.from}
                onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
              />
              <label htmlFor="report-to">{t('to')}</label>
              <input
                id="report-to"
                type="date"
                value={range.to}
                onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
              />
            </>
          )}
        </div>
      )}
      {current?.kind === 'invalid' && <p role="alert">{t('invalidRange')}</p>}
      {current?.kind === 'error' && <p role="alert">{t('loadFailed')}</p>}
      {current?.kind === 'ok' &&
        (current.report.hours.length === 0 ? (
          <p>{t('empty')}</p>
        ) : (
          <ReportView report={current.report} from={current.from} to={current.to} label={label} />
        ))}
    </main>
  );
}

function ReportView({
  report,
  from,
  to,
  label,
}: {
  report: BranchReport;
  from: string;
  to: string;
  label: Label;
}) {
  const items = buildSummaryItems(report.summary, label);
  const tables = buildReportTables(report, label);
  return (
    <>
      <section aria-labelledby="report-summary">
        <h2 id="report-summary">{label('summary.title')}</h2>
        {items.map((i) => (
          <Metric key={i.key} label={i.label} value={i.display} />
        ))}
      </section>
      {tables.map((table) => (
        <TableSection key={table.key} table={table} from={from} to={to} label={label} />
      ))}
    </>
  );
}

function TableSection({
  table,
  from,
  to,
  label,
}: {
  table: ReportTable;
  from: string;
  to: string;
  label: Label;
}) {
  const headingId = `report-${table.key}`;
  function downloadCsv() {
    const csv = '﻿' + toCsv(table.headers, table.raw);
    downloadBlob(
      new Blob([csv], { type: 'text/csv;charset=utf-8' }),
      `pixel-barber-${table.fileKey}-${from}-${to}.csv`,
    );
  }
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId}>{table.title}</h2>
      <table>
        <thead>
          <tr>
            {table.headers.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.display.map((row, i) => (
            <tr
              key={i}
              style={
                table.shade
                  ? { background: `rgba(29, 78, 216, ${(0.08 + 0.32 * table.shade[i]).toFixed(2)})` }
                  : undefined
              }
            >
              {row.map((v, j) => (
                <td key={j}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={downloadCsv}>
        {label('downloadCsv')}
      </button>
    </section>
  );
}
```
(`'﻿'` is written as the escape sequence, not the character.)

- [ ] **Step 7: Extend the e2e journey (Reports + CSV)**

In `e2e/staff-reports.spec.ts`: add `import { readFileSync } from 'node:fs';` to the imports, change the Playwright import to `import { test, expect, type Locator, type Page } from '@playwright/test';`, add a helper after `logIn`:
```typescript
async function openReport(page: Page): Promise<Locator> {
  await page.goto(`${STAFF}/reports`);
  const main = page.locator('main');
  await main.getByLabel('Branch', { exact: true }).selectOption(seed.branchId!);
  // exact: the summary groups' names ("Customers served", "Returning customers") contain "to".
  await main.getByLabel('Period', { exact: true }).selectOption('custom');
  await main.getByLabel('From', { exact: true }).fill(visitDay);
  await main.getByLabel('To', { exact: true }).fill(visitDay);
  await expect(main.getByRole('group', { name: 'Customers served' })).toContainText('1', {
    timeout: 15000,
  });
  return main;
}
```
and a second test inside the `describe.serial` block:
```typescript
  test('a branch manager opens Reports and downloads a table as CSV', async ({ page }) => {
    test.setTimeout(120_000);
    await logIn(page);
    const main = await openReport(page);
    await expect(main.getByRole('group', { name: 'Estimated takings' })).toContainText(
      'GHS 50.00 (estimated)',
    );
    const barbers = main.getByRole('region', { name: 'Barbers' });
    await expect(barbers).toContainText('SRP E2E Barber');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      barbers.getByRole('button', { name: 'Download CSV' }).press('Enter'),
    ]);
    expect(download.suggestedFilename()).toBe(`pixel-barber-barbers-${visitDay}-${visitDay}.csv`);
    const csv = readFileSync((await download.path())!, 'utf8').replace(/^﻿/, '');
    expect(csv.split('\r\n')[0]).toBe(
      'Barber,Served,Average haircut time,No-shows,Average rating,Estimated takings',
    );
    expect(csv.split('\r\n')[1]).toBe('SRP E2E Barber,1,30,0,,50');
  });
```

- [ ] **Step 8: Verify**

- `npx vitest run apps/staff/app/reports --environment=node` — PASS.
- `npm run typecheck` — no errors.
- `cd apps/staff && npx eslint "app/reports/page.tsx" "app/reports/reportTables.ts" "app/reports/presets.ts" "app/reports/csv.ts" "app/reports/download.ts" "app/reports/reportTypes.ts" "app/reports/__fixtures__/sampleReport.ts"` — clean.
- `npx playwright test e2e/staff-reports.spec.ts --reporter=line --workers=1` — 2 passed.
- `grep -n $'\xef\xbf\xbd'` on every edited file — nothing.

- [ ] **Step 9: Commit**

```bash
git add apps/staff/app/reports apps/staff/messages/en.json e2e/staff-reports.spec.ts
git commit -m "feat: staff Reports page with date ranges, branch comparison and CSV downloads"
```

---

### Task 5: Excel and PDF downloads

**Files:**
- Modify: `apps/staff/package.json`, `package-lock.json` (via npm)
- Create: `apps/staff/app/reports/exportContent.ts`, `apps/staff/app/reports/exportContent.test.ts`
- Create: `apps/staff/app/reports/exportFiles.ts`
- Modify: `apps/staff/app/reports/page.tsx`
- Modify: `apps/staff/app/settings/barbers/scope.ts`
- Modify: `e2e/staff-reports.spec.ts`

**Interfaces:**
- Consumes: Task 4's `buildSummaryItems`, `buildReportTables`, `Label`, `Cell`, `BranchReport`, `downloadBlob`, e2e `openReport(page)`; `sampleReport`, `sampleAllBranches`.
- Produces:
  - `exportContent.ts`: `interface ExportInput { report: BranchReport; label: Label; branchName: string; from: string; to: string; generatedAt: string }`; `interface XCell { value: string | number; fontWeight?: 'bold' }`; `interface Sheet { sheet: string; data: (XCell | null)[][] }`; `buildWorkbookSheets(input: ExportInput): Sheet[]`; `interface PdfSection { heading: string; head: string[]; body: string[][] }`; `interface PdfContent { title: string; period: string; generated: string; sections: PdfSection[] }`; `buildPdfContent(input: ExportInput): PdfContent`.
  - `exportFiles.ts`: `reportFileName(branchCode: string, from: string, to: string, ext: 'xlsx' | 'pdf'): string`; `downloadExcel(sheets: Sheet[], fileName: string): Promise<void>`; `downloadPdf(content: PdfContent, fileName: string): Promise<void>`.
  - `ManageableBranch` gains `branch_code: string`.

- [ ] **Step 1: Add the libraries**

Run from the repo root:
```bash
npm install write-excel-file@4.1.1 jspdf@4.2.1 jspdf-autotable@5.0.8 --save-exact -w @pixel-barber/staff
```
Expected: `apps/staff/package.json` lists the three exact versions under `dependencies`. Check the browser entry and multi-sheet typing: read `node_modules/write-excel-file/browser/index.d.ts` (or the package's `exports` map); the call used below is `writeXlsxFile(sheets: { data, sheet }[]).toBlob()`. If the installed typings name it differently, adapt `exportFiles.ts` to them and note it in your report.

- [ ] **Step 2: Write the failing builder tests**

Create `apps/staff/app/reports/exportContent.test.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import { buildPdfContent, buildWorkbookSheets, type ExportInput } from './exportContent';
import type { Label } from './reportTables';
import { sampleAllBranches, sampleReport } from './__fixtures__/sampleReport';

const label: Label = (key, values) => (values ? `${key} ${JSON.stringify(values)}` : key);
const input: ExportInput = {
  report: sampleReport,
  label,
  branchName: 'Osu',
  from: '2026-09-28',
  to: '2026-09-29',
  generatedAt: '8 Oct 2026, 10:42',
};

describe('buildWorkbookSheets', () => {
  it('starts with a Summary sheet, then one sheet per table', () => {
    const sheets = buildWorkbookSheets(input);
    expect(sheets.map((s) => s.sheet)).toEqual([
      'tables.summary', 'tables.daily', 'tables.hours', 'tables.barbers', 'tables.services',
      'tables.reasons',
    ]);
    expect(buildWorkbookSheets({ ...input, report: sampleAllBranches }).map((s) => s.sheet)).toContain(
      'tables.branches',
    );
  });

  it('heads the Summary sheet with the branch and range, then the numbers', () => {
    const [summary] = buildWorkbookSheets(input);
    expect(summary.data.slice(0, 4)).toEqual([
      [{ value: 'export.branch', fontWeight: 'bold' }, { value: 'Osu' }],
      [{ value: 'export.from', fontWeight: 'bold' }, { value: '2026-09-28' }],
      [{ value: 'export.to', fontWeight: 'bold' }, { value: '2026-09-29' }],
      [{ value: 'export.generated', fontWeight: 'bold' }, { value: '8 Oct 2026, 10:42' }],
    ]);
    expect(summary.data[5]).toEqual([{ value: 'summary.served' }, { value: 3 }]);
  });

  it('gives each table sheet a bold header row and numeric cells', () => {
    const daily = buildWorkbookSheets(input)[1];
    expect(daily.data[0][0]).toEqual({ value: 'columns.date', fontWeight: 'bold' });
    expect(daily.data[2]).toEqual([
      { value: '2026-09-29' }, { value: 1 }, { value: 0 }, { value: 1 }, { value: 0 }, { value: 1 },
      null, null, null, { value: 350 },
    ]);
  });
});

describe('buildPdfContent', () => {
  it('has the title lines, a summary table and every report table with formatted values', () => {
    const pdf = buildPdfContent(input);
    expect(pdf.title).toBe('export.pdfTitle');
    expect(pdf.period).toBe('export.pdfPeriod {"branch":"Osu","from":"2026-09-28","to":"2026-09-29"}');
    expect(pdf.generated).toBe('export.generatedAt {"time":"8 Oct 2026, 10:42"}');
    expect(pdf.sections.map((s) => s.heading)).toEqual([
      'tables.summary', 'tables.daily', 'tables.hours', 'tables.barbers', 'tables.services',
      'tables.reasons',
    ]);
    expect(pdf.sections[0].head).toEqual(['export.metric', 'export.value']);
    expect(pdf.sections[0].body[0]).toEqual(['summary.served', '3']);
    const daily = pdf.sections[1];
    expect(daily.head[9]).toBe('columns.takingsPdf');
    expect(daily.body[1]).toEqual(['Tue 29 Sep', '1', '0', '1', '0', '1', '—', '—', '—', 'GHS 350.00']);
    expect(pdf.sections[5].head).toEqual(['columns.reason', 'columns.count']);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run apps/staff/app/reports/exportContent.test.ts --environment=node`
Expected: FAIL (cannot find `./exportContent`).

- [ ] **Step 4: Write the builders and the file wrappers**

Create `apps/staff/app/reports/exportContent.ts`:
```typescript
// Pure Excel and PDF content for a loaded report
// (Docs/superpowers/specs/2026-10-08-reports-dashboard-design.md): Excel keeps raw numbers (a sheet
// per table); the PDF shows the values as formatted on the page.
import { buildReportTables, buildSummaryItems, type Cell, type Label } from './reportTables';
import type { BranchReport } from './reportTypes';

export interface ExportInput {
  report: BranchReport;
  label: Label;
  branchName: string;
  from: string;
  to: string;
  generatedAt: string;
}

export interface XCell {
  value: string | number;
  fontWeight?: 'bold';
}

export interface Sheet {
  sheet: string;
  data: (XCell | null)[][];
}

export interface PdfSection {
  heading: string;
  head: string[];
  body: string[][];
}

export interface PdfContent {
  title: string;
  period: string;
  generated: string;
  sections: PdfSection[];
}

const cell = (v: Cell): XCell | null => (v === null ? null : { value: v });
const bold = (value: string): XCell => ({ value, fontWeight: 'bold' });

export function buildWorkbookSheets(input: ExportInput): Sheet[] {
  const { report, label } = input;
  const summary: Sheet = {
    sheet: label('tables.summary'),
    data: [
      [bold(label('export.branch')), { value: input.branchName }],
      [bold(label('export.from')), { value: input.from }],
      [bold(label('export.to')), { value: input.to }],
      [bold(label('export.generated')), { value: input.generatedAt }],
      [null, null],
      ...buildSummaryItems(report.summary, label).map((i) => [{ value: i.label }, cell(i.raw)]),
    ],
  };
  const tables = buildReportTables(report, label).map(
    (table): Sheet => ({
      sheet: table.title,
      data: [table.headers.map(bold), ...table.raw.map((row) => row.map(cell))],
    }),
  );
  return [summary, ...tables];
}

export function buildPdfContent(input: ExportInput): PdfContent {
  const { report, label } = input;
  return {
    title: label('export.pdfTitle'),
    period: label('export.pdfPeriod', { branch: input.branchName, from: input.from, to: input.to }),
    generated: label('export.generatedAt', { time: input.generatedAt }),
    sections: [
      {
        heading: label('tables.summary'),
        head: [label('export.metric'), label('export.value')],
        body: buildSummaryItems(report.summary, label).map((i) => [i.label, i.display]),
      },
      ...buildReportTables(report, label).map((table) => ({
        heading: table.title,
        head: table.headers.map((h, i) =>
          i === table.takingsColumn ? label('columns.takingsPdf') : h,
        ),
        body: table.display,
      })),
    ],
  };
}
```

Create `apps/staff/app/reports/exportFiles.ts`:
```typescript
// Turns built content into .xlsx / .pdf files. The libraries are loaded only when a download is
// clicked, so the Reports page stays light on mobile data.
import { downloadBlob } from './download';
import type { PdfContent, Sheet } from './exportContent';

export function reportFileName(branchCode: string, from: string, to: string, ext: 'xlsx' | 'pdf') {
  return `pixel-barber-report-${branchCode}-${from}-${to}.${ext}`;
}

export async function downloadExcel(sheets: Sheet[], fileName: string): Promise<void> {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  const blob = await writeXlsxFile(sheets.map((s) => ({ data: s.data, sheet: s.sheet }))).toBlob();
  downloadBlob(blob, fileName);
}

const MARGIN = 40;
const PAGE_BOTTOM = 780;

export async function downloadPdf(content: PdfContent, fileName: string): Promise<void> {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  let y = MARGIN + 10;
  doc.setFontSize(16);
  doc.text(content.title, MARGIN, y);
  y += 20;
  doc.setFontSize(10);
  doc.text(content.period, MARGIN, y);
  y += 14;
  doc.text(content.generated, MARGIN, y);
  y += 24;
  for (const section of content.sections) {
    if (y > PAGE_BOTTOM - 40) {
      doc.addPage();
      y = MARGIN + 10;
    }
    doc.setFontSize(12);
    doc.text(section.heading, MARGIN, y);
    autoTable(doc, {
      head: [section.head],
      body: section.body,
      startY: y + 8,
      showHead: 'everyPage',
      margin: { left: MARGIN, right: MARGIN },
      styles: { fontSize: section.head.length > 10 ? 6 : 8 },
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 24;
  }
  downloadBlob(doc.output('blob'), fileName);
}
```

Run: `npx vitest run apps/staff/app/reports --environment=node` — Expected: PASS.

- [ ] **Step 5: Load branch codes**

In `apps/staff/app/settings/barbers/scope.ts`: add `branch_code: string;` to `ManageableBranch` and change the branches query to `supabase.from('branches').select('id, name, branch_code').order('name')`.

- [ ] **Step 6: Add the Excel and PDF buttons to the Reports page**

In `apps/staff/app/reports/page.tsx`:
- Imports: `import { buildPdfContent, buildWorkbookSheets } from './exportContent';` and `import { downloadExcel, downloadPdf, reportFileName } from './exportFiles';`.
- In `ReportsPage`, before `return`, compute
```tsx
  const selectedBranch = branches.find((b) => b.id === selection);
  const branchName = selection === ALL ? t('allBranches') : (selectedBranch?.name ?? '');
  const branchCode = selection === ALL ? 'all' : (selectedBranch?.branch_code ?? 'branch');
```
  and render `<ReportView report={current.report} from={current.from} to={current.to} label={label} branchName={branchName} branchCode={branchCode} />`.
- In `ReportView`, accept `branchName: string; branchCode: string` in its props and add before its `return`:
```tsx
  const [exportFailed, setExportFailed] = useState(false);
  async function exportFile(kind: 'xlsx' | 'pdf') {
    setExportFailed(false);
    const generatedAt = new Date().toLocaleString('en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    });
    const input = { report, label, branchName, from, to, generatedAt };
    const fileName = reportFileName(branchCode, from, to, kind);
    try {
      if (kind === 'xlsx') await downloadExcel(buildWorkbookSheets(input), fileName);
      else await downloadPdf(buildPdfContent(input), fileName);
    } catch {
      setExportFailed(true);
    }
  }
```
  and, as the first child of its fragment:
```tsx
      <div>
        <button type="button" onClick={() => exportFile('xlsx')}>
          {label('downloadExcel')}
        </button>
        <button type="button" onClick={() => exportFile('pdf')}>
          {label('downloadPdf')}
        </button>
        {exportFailed && <p role="alert">{label('exportFailed')}</p>}
      </div>
```
  (`new Date()` here runs in a click handler, not in render.)

- [ ] **Step 7: Extend the e2e journey (Excel + PDF)**

In `e2e/staff-reports.spec.ts`, add a third test inside the `describe.serial` block:
```typescript
  test('a branch manager downloads the whole report as Excel and PDF', async ({ page }) => {
    test.setTimeout(120_000);
    await logIn(page);
    const main = await openReport(page);
    const download = async (button: string) => {
      const [file] = await Promise.all([
        page.waitForEvent('download'),
        main.getByRole('button', { name: button }).press('Enter'),
      ]);
      return { name: file.suggestedFilename(), bytes: readFileSync((await file.path())!) };
    };
    const excel = await download('Download Excel');
    expect(excel.name).toBe(`pixel-barber-report-${seed.branchCode}-${visitDay}-${visitDay}.xlsx`);
    expect(excel.bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    const pdf = await download('Download PDF');
    expect(pdf.name).toBe(`pixel-barber-report-${seed.branchCode}-${visitDay}-${visitDay}.pdf`);
    expect(pdf.bytes.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });
```

- [ ] **Step 8: Verify**

- `npx vitest run apps/staff/app/reports --environment=node` — PASS.
- `npm run typecheck` — no errors.
- `cd apps/staff && npx eslint "app/reports/page.tsx" "app/reports/exportContent.ts" "app/reports/exportFiles.ts" "app/settings/barbers/scope.ts"` — clean.
- `npx playwright test e2e/staff-reports.spec.ts e2e/staff-feedback.spec.ts e2e/appointments-staff.spec.ts --reporter=line --workers=1` — all pass (the last two use `loadManageableBranches`). If the staff dev server can't resolve a newly installed package, report BLOCKED with "staff dev server needs a restart" — do not kill node processes.
- `grep -n $'\xef\xbf\xbd'` on every edited file — nothing.

- [ ] **Step 9: Commit**

```bash
git add apps/staff/package.json package-lock.json apps/staff/app/reports apps/staff/app/settings/barbers/scope.ts e2e/staff-reports.spec.ts
git commit -m "feat: download reports as Excel and PDF"
```

---

## After all tasks (controller)

- Full suite (DB in paced pairs, unit, app, e2e).
- Promotion (after the user's OK): migrations `20261008090000`–`20261008090100` to production (dry run first), then push to GitHub (Vercel deploys both apps). No Edge Function changes.
