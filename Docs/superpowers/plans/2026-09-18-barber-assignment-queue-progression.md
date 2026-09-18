# Barber Assignment & Queue Progression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `queue_tickets.assigned_barber_id` actually get set when a customer joins a queue
or staff add a walk-in, and make the dead `called`/`almost_turn` ticket states actually fire, so
Today's Queue (built in Phase 5) can show a real ticket in production.

**Architecture:** One new `SECURITY DEFINER` SQL function (`find_eligible_barber`) is the single
source of truth for "which barber does this customer get," called both as a client-side pre-check
(to decide whether to prompt the customer) and again inside the existing ticket-creation code path
at the moment of insert. A second, existing function (`recalculate_positions`) is extended to
derive `called`/`almost_turn`/`waiting` from a ticket's position and fire the matching
notification — with a reentrancy guard, since this function already calls itself indirectly
through the very trigger it's extending (see Task 3).

**Tech Stack:** PostgreSQL/PL-pgSQL (Supabase), Deno Edge Functions (TypeScript), Next.js/React
(customer and staff apps), Vitest (`tests/db/`), Playwright (`e2e/`).

**Spec:** `Docs/superpowers/specs/2026-09-18-barber-assignment-queue-progression-design.md`

## Corrections to the spec, found while writing this plan

- The spec's architecture section calls `createTicketAtomic` a function to "extend" without
  specifying its nature. It is a **plain TypeScript function** in
  `supabase/functions/_shared/create-ticket.ts`, shared by the `tickets-join` and
  `tickets-walk-in` Edge Functions — not a SQL function. Task 2 below extends it in TypeScript,
  calling the new `find_eligible_barber` SQL function via `admin.rpc(...)` from inside it. This
  doesn't change the design's substance (assignment logic still lives in exactly one SQL
  function, called from two places) — only which layer holds the calling code.
- The spec describes `find_eligible_barber`'s second parameter as `p_service_id`. The actual
  callers (BookFlow, the walk-in modal, `queue_tickets` itself) only ever have a
  `branch_service_id` on hand, not a bare `service_id` — `barber_skills.service_id` and
  `branch_services.id` are different columns. Task 1 below defines the function to take
  `p_branch_service_id` and resolve `service_id` internally via `branch_services`, so no caller
  needs an extra lookup.
- **A real correctness bug found while writing Task 3's SQL**: `recalculate_positions` is called
  by the trigger `after_ticket_state_change` (`after update of state on queue_tickets`). The
  spec's promotion logic writes `queue_tickets.state` — which means the write **re-fires the same
  trigger**, recursively re-entering `recalculate_positions` before the original call's loop
  finishes. Left unguarded, this sends duplicate `your_turn` notifications for the same
  transition. Task 3 adds a transaction-local reentrancy guard (a standard Postgres pattern via
  `set_config`/`current_setting`) to make this safe. This is new relative to the spec, which didn't
  anticipate the recursion.

## Global Constraints

- Every new or modified `SECURITY DEFINER` function uses `set search_path = public, pg_temp`
  (this repo's hardened convention since `20260911211800_security_hardening.sql`).
- Every Edge Function response path — success, validation error, and the catch-all — includes
  `corsHeaders`, matching every existing function in `supabase/functions/`.
- Every new or changed customer-facing and staff-facing string goes through `next-intl`
  (`t('key')`), with the key added to the relevant app's `messages/en.json`. No hardcoded literal
  strings in JSX.
- Any `beforeAll`/`afterAll` test hook doing more than 1-2 DB operations gets an explicit `30000`
  ms timeout — Vitest's 10s default has caused a real CI failure in this project before
  (`tests/db/ticket-structural-identity.test.ts`).
- Test cleanup in `afterAll` follows FK-safe ordering: `queue_events`/`notifications`/
  `service_sessions`/`feedback` before `queue_tickets`; `queue_tickets` before
  `customers`/`staff_users`/`barbers`; auth users after that; the branch row last of all.
- No fallback beyond what this plan specifies for "no barber eligible" — a clean refusal, never a
  silently-created unassigned ticket (spec decision 5).
- `recalculate_positions`'s existing pooled-ticket ranking
  (`assigned_barber_id is null and is_pooled`) must not be modified — out of scope per the spec.

---

### Task 1: `find_eligible_barber` SQL function

**Files:**
- Create: `supabase/migrations/20260919090000_find_eligible_barber.sql`
- Test: `tests/db/find-eligible-barber.test.ts`

**Interfaces:**
- Produces: `find_eligible_barber(p_branch_id uuid, p_branch_service_id uuid, p_preferred_barber_id uuid default null)` returning one row: `preferred_eligible boolean, preferred_scheduled_today boolean, fallback_barber_id uuid` (`fallback_barber_id` is `null` when no barber is eligible at all). Granted to `authenticated` (called directly by both customer and staff browser clients) and `service_role` (called from inside Edge Functions in Task 2).

- [ ] **Step 1: Write the failing test**

Create `tests/db/find-eligible-barber.test.ts`:

```typescript
// tests/db/find-eligible-barber.test.ts
// @vitest-environment node
// New Task 1: find_eligible_barber is the single source of truth for "which barber does this
// customer get" -- covers skill matching, the branch_schedule shift-hours window, each excluded
// barber_status value, least-busy tie-breaking, and the preferred-barber eligibility/scheduled
// distinctions the join-flow prompt depends on.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const suffix = Date.now();
const today = new Date().toISOString().slice(0, 10);

// A shift window guaranteed NOT to cover the current wall-clock time, for the "outside shift
// hours" case -- computed relative to "now" rather than hardcoded, so this test isn't flaky
// depending on what time it happens to run.
const now = new Date();
const outsideHour = (now.getHours() + 5) % 24;
const outsideStart = `${String(outsideHour).padStart(2, '0')}:00:00`;
const outsideEnd = `${String((outsideHour + 1) % 24).padStart(2, '0')}:00:00`;

let branchId: string;
let branchServiceId: string; // barbers ARE skilled for this one
let otherBranchServiceId: string; // barbers are NOT skilled for this one
let serviceId: string;
let otherServiceId: string;

interface TestBarber {
  staffUserId: string;
  authUserId: string;
  barberId: string;
}
const barbers: Record<string, TestBarber> = {};

async function makeBarber(label: string): Promise<TestBarber> {
  const email = `feb-${label}-${suffix}@test.pixelbarber.local`;
  const { data: authUser } = await admin.auth.admin.createUser({
    email,
    password: 'Test-Password-123!',
    email_confirm: true,
  });
  const { data: staffRow } = await admin
    .from('staff_users')
    .insert({
      auth_user_id: authUser!.user.id,
      name: `FEB Test Barber ${label}`,
      email,
      role: 'barber',
      invite_status: 'accepted',
    })
    .select()
    .single();
  const { data: barberRow } = await admin
    .from('barbers')
    .insert({ staff_user_id: staffRow!.id, home_branch_id: branchId, status: 'available' })
    .select()
    .single();
  return { staffUserId: staffRow!.id, authUserId: authUser!.user.id, barberId: barberRow!.id };
}

beforeAll(async () => {
  const { data: business } = await admin.from('businesses').select('id').limit(1).single();
  const { data: service } = await admin.from('services').select('id').limit(1).single();
  serviceId = service!.id;
  const { data: otherService } = await admin
    .from('services')
    .select('id')
    .neq('id', serviceId)
    .limit(1)
    .single();
  otherServiceId = otherService!.id;

  const { data: branch } = await admin
    .from('branches')
    .insert({
      business_id: business!.id,
      name: 'Find Eligible Barber Test Branch',
      branch_code: `FEB${suffix % 100000}`,
      address: 'Test',
      latitude: 5.6,
      longitude: -0.18,
    })
    .select()
    .single();
  branchId = branch!.id;

  const { data: bs } = await admin
    .from('branch_services')
    .insert({ branch_id: branchId, service_id: serviceId })
    .select()
    .single();
  branchServiceId = bs!.id;
  const { data: otherBs } = await admin
    .from('branch_services')
    .insert({ branch_id: branchId, service_id: otherServiceId })
    .select()
    .single();
  otherBranchServiceId = otherBs!.id;

  // Barber A: fully eligible -- skilled, scheduled all day today, available, no active tickets.
  barbers.a = await makeBarber('a');
  // Barber B: fully eligible too, but with 2 pre-existing active tickets (busier than A).
  barbers.b = await makeBarber('b');
  // Barber C: skilled and scheduled, but status = offline -- excluded.
  barbers.c = await makeBarber('c');
  // Barber D: skilled and scheduled, but status = on_break -- still eligible.
  barbers.d = await makeBarber('d');
  // Barber E: skilled, scheduled today, but current time falls OUTSIDE their shift hours.
  barbers.e = await makeBarber('e');
  // Barber F: skilled, but has NO schedule row for today at all.
  barbers.f = await makeBarber('f');
  // Barber G: scheduled and available, but has NO barber_skills row for this service.
  barbers.g = await makeBarber('g');

  await admin.from('barber_skills').insert([
    { barber_id: barbers.a.barberId, service_id: serviceId },
    { barber_id: barbers.b.barberId, service_id: serviceId },
    { barber_id: barbers.c.barberId, service_id: serviceId },
    { barber_id: barbers.d.barberId, service_id: serviceId },
    { barber_id: barbers.e.barberId, service_id: serviceId },
    { barber_id: barbers.f.barberId, service_id: serviceId },
    // g deliberately has no barber_skills row for `serviceId` -- only `otherServiceId`.
    { barber_id: barbers.g.barberId, service_id: otherServiceId },
  ]);

  await admin.from('barber_schedule').insert([
    {
      barber_id: barbers.a.barberId,
      work_date: today,
      branch_id: branchId,
      shift_start: '00:00:00',
      shift_end: '23:59:59',
    },
    {
      barber_id: barbers.b.barberId,
      work_date: today,
      branch_id: branchId,
      shift_start: '00:00:00',
      shift_end: '23:59:59',
    },
    {
      barber_id: barbers.c.barberId,
      work_date: today,
      branch_id: branchId,
      shift_start: '00:00:00',
      shift_end: '23:59:59',
    },
    {
      barber_id: barbers.d.barberId,
      work_date: today,
      branch_id: branchId,
      shift_start: '00:00:00',
      shift_end: '23:59:59',
    },
    {
      barber_id: barbers.e.barberId,
      work_date: today,
      branch_id: branchId,
      shift_start: outsideStart,
      shift_end: outsideEnd,
    },
    // f deliberately gets no barber_schedule row at all.
    {
      barber_id: barbers.g.barberId,
      work_date: today,
      branch_id: branchId,
      shift_start: '00:00:00',
      shift_end: '23:59:59',
    },
  ]);

  await admin
    .from('barbers')
    .update({ status: 'offline' })
    .eq('id', barbers.c.barberId);
  await admin
    .from('barbers')
    .update({ status: 'on_break' })
    .eq('id', barbers.d.barberId);

  // Give barber B two active tickets so barber A is the least-busy fallback.
  const { data: cust1 } = await admin
    .from('customers')
    .insert({ name: 'FEB Customer 1', phone_e164: `+233${String(suffix).slice(-8)}1` })
    .select()
    .single();
  const { data: cust2 } = await admin
    .from('customers')
    .insert({ name: 'FEB Customer 2', phone_e164: `+233${String(suffix).slice(-8)}2` })
    .select()
    .single();
  await admin.from('queue_tickets').insert([
    {
      ticket_number: `PB-FEB-1-${suffix}`,
      branch_id: branchId,
      customer_id: cust1!.id,
      branch_service_id: branchServiceId,
      assigned_barber_id: barbers.b.barberId,
      state: 'waiting',
      created_by: 'staff',
    },
    {
      ticket_number: `PB-FEB-2-${suffix}`,
      branch_id: branchId,
      customer_id: cust2!.id,
      branch_service_id: branchServiceId,
      assigned_barber_id: barbers.b.barberId,
      state: 'in_service',
      created_by: 'staff',
    },
  ]);
}, 30000);

afterAll(async () => {
  await admin.from('queue_tickets').delete().eq('branch_id', branchId);
  await admin.from('customers').delete().like('phone_e164', `+233${String(suffix).slice(-8)}%`);
  await admin.from('barber_schedule').delete().eq('branch_id', branchId);
  await admin.from('barber_skills').delete().in(
    'barber_id',
    Object.values(barbers).map((b) => b.barberId),
  );
  const staffUserIds = Object.values(barbers).map((b) => b.staffUserId);
  await admin.from('staff_users').delete().in('id', staffUserIds);
  for (const b of Object.values(barbers)) {
    await admin.auth.admin.deleteUser(b.authUserId);
  }
  await admin.from('branches').delete().eq('id', branchId);
}, 30000);

describe('find_eligible_barber', () => {
  it('excludes a barber with no barber_skills row for the service', async () => {
    const { data } = await admin.rpc('find_eligible_barber', {
      p_branch_id: branchId,
      p_branch_service_id: otherBranchServiceId,
      p_preferred_barber_id: barbers.g.barberId,
    });
    // g IS skilled for otherServiceId, so g itself should be eligible here -- but none of the
    // OTHER barbers (a/b/c/d/e/f) are skilled for otherServiceId, so g must be the only
    // possible fallback candidate too.
    expect(data![0].fallback_barber_id).toBe(barbers.g.barberId);
  });

  it('excludes an offline barber and still includes an on_break barber', async () => {
    const { data } = await admin.rpc('find_eligible_barber', {
      p_branch_id: branchId,
      p_branch_service_id: branchServiceId,
      p_preferred_barber_id: barbers.c.barberId, // offline
    });
    expect(data![0].preferred_eligible).toBe(false);
    expect(data![0].preferred_scheduled_today).toBe(true); // has a schedule row, just offline

    const { data: dData } = await admin.rpc('find_eligible_barber', {
      p_branch_id: branchId,
      p_branch_service_id: branchServiceId,
      p_preferred_barber_id: barbers.d.barberId, // on_break
    });
    expect(dData![0].preferred_eligible).toBe(true);
  });

  it('excludes a barber whose schedule does not cover the current time', async () => {
    const { data } = await admin.rpc('find_eligible_barber', {
      p_branch_id: branchId,
      p_branch_service_id: branchServiceId,
      p_preferred_barber_id: barbers.e.barberId,
    });
    expect(data![0].preferred_eligible).toBe(false);
    expect(data![0].preferred_scheduled_today).toBe(true);
  });

  it('reports preferred_scheduled_today = false when there is no schedule row at all', async () => {
    const { data } = await admin.rpc('find_eligible_barber', {
      p_branch_id: branchId,
      p_branch_service_id: branchServiceId,
      p_preferred_barber_id: barbers.f.barberId,
    });
    expect(data![0].preferred_eligible).toBe(false);
    expect(data![0].preferred_scheduled_today).toBe(false);
  });

  it('picks the least-busy eligible barber as the fallback', async () => {
    const { data } = await admin.rpc('find_eligible_barber', {
      p_branch_id: branchId,
      p_branch_service_id: branchServiceId,
      p_preferred_barber_id: null,
    });
    expect(data![0].fallback_barber_id).toBe(barbers.a.barberId);
  });

  it('reports preferred_eligible = true for a genuinely eligible preferred barber', async () => {
    const { data } = await admin.rpc('find_eligible_barber', {
      p_branch_id: branchId,
      p_branch_service_id: branchServiceId,
      p_preferred_barber_id: barbers.a.barberId,
    });
    expect(data![0].preferred_eligible).toBe(true);
  });

  it('returns a null fallback_barber_id when nobody is eligible', async () => {
    // Only g is skilled for otherServiceId; make g temporarily ineligible too to hit the true
    // empty-pool case.
    await admin.from('barbers').update({ status: 'offline' }).eq('id', barbers.g.barberId);
    const { data: emptyPool } = await admin.rpc('find_eligible_barber', {
      p_branch_id: branchId,
      p_branch_service_id: otherBranchServiceId,
      p_preferred_barber_id: null,
    });
    expect(emptyPool![0].fallback_barber_id).toBeNull();
    await admin.from('barbers').update({ status: 'available' }).eq('id', barbers.g.barberId);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- tests/db/find-eligible-barber.test.ts`
Expected: FAIL — `find_eligible_barber` does not exist yet (`PGRST202` / "function not found").

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260919090000_find_eligible_barber.sql`:

```sql
-- Barber Assignment & Queue Progression design (Docs/superpowers/specs/2026-09-18-barber-
-- assignment-queue-progression-design.md), decisions 3-4. Single source of truth for "which
-- barber does this customer get" -- called as a pre-check from the client (BookFlow, the walk-in
-- modal) and again inside createTicketAtomic at insert time (Task 2), so the actual assignment
-- always re-derives fresh rather than trusting the earlier pre-check's answer.
create or replace function find_eligible_barber(
  p_branch_id uuid,
  p_branch_service_id uuid,
  p_preferred_barber_id uuid default null
)
returns table (
  preferred_eligible boolean,
  preferred_scheduled_today boolean,
  fallback_barber_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_service_id uuid;
begin
  select service_id into v_service_id from branch_services where id = p_branch_service_id;

  return query
  with eligible as (
    select b.id as barber_id
    from barbers b
    join barber_skills bs on bs.barber_id = b.id and bs.service_id = v_service_id
    join barber_schedule sch on sch.barber_id = b.id
      and sch.work_date = current_date
      and sch.branch_id = p_branch_id
      and now()::time between sch.shift_start and sch.shift_end
    where b.status not in ('offline', 'end_of_shift', 'temporarily_unavailable')
  ),
  ranked as (
    select
      e.barber_id,
      (
        select count(*) from queue_tickets qt
        where qt.assigned_barber_id = e.barber_id
          and qt.branch_id = p_branch_id
          and qt.state in ('waiting', 'almost_turn', 'called', 'confirmed', 'in_service')
      ) as active_count
    from eligible e
  )
  select
    exists (select 1 from eligible where barber_id = p_preferred_barber_id),
    exists (
      select 1 from barber_schedule
      where barber_id = p_preferred_barber_id
        and work_date = current_date
        and branch_id = p_branch_id
    ),
    (select barber_id from ranked order by active_count asc, barber_id asc limit 1);
end;
$$;

grant execute on function find_eligible_barber(uuid, uuid, uuid) to authenticated;
```

- [ ] **Step 4: Push the migration**

Run: `npx supabase db push`
Expected: applies cleanly (new function only, no existing object touched).

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test -- tests/db/find-eligible-barber.test.ts`
Expected: PASS, 7/7 tests.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260919090000_find_eligible_barber.sql tests/db/find-eligible-barber.test.ts
git commit -m "feat: add find_eligible_barber, the barber-assignment decision function"
```

---

### Task 2: Wire assignment into ticket creation

**Files:**
- Modify: `supabase/functions/_shared/create-ticket.ts`
- Modify: `supabase/functions/tickets-join/index.ts`
- Modify: `supabase/functions/tickets-walk-in/index.ts`
- Test: `tests/db/ticket-creation-barber-assignment.test.ts`

**Interfaces:**
- Consumes: `find_eligible_barber(p_branch_id, p_branch_service_id, p_preferred_barber_id)` (Task 1).
- Produces: `CreateTicketParams` gains `acceptFallback: boolean`. `createTicketAtomic` now sets
  `assigned_barber_id` on every created ticket, or throws `Error('NO_BARBER_AVAILABLE')` when
  `find_eligible_barber` returns a null `fallback_barber_id` and no usable preferred barber. Both
  Edge Functions accept a new `accept_fallback` boolean field in their request body (optional,
  defaults to `false`) and map the `NO_BARBER_AVAILABLE` error to a `409` response with
  `{ error: 'NO_BARBER_AVAILABLE' }` instead of a generic `500`.

- [ ] **Step 1: Write the failing test**

Create `tests/db/ticket-creation-barber-assignment.test.ts`:

```typescript
// tests/db/ticket-creation-barber-assignment.test.ts
// @vitest-environment node
// Task 2: tickets-join and tickets-walk-in must both end with a real assigned_barber_id on the
// created ticket -- the Critical gap from Phase 5's final review. Exercises the real deployed
// functions, not the shared helper directly, since the bug this closes is specifically that
// nothing in the request path ever calls the assignment logic.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const suffix = Date.now();
const PASSWORD = 'Test-Password-123!';

let branchId: string;
let branchServiceId: string;
let serviceId: string;
let barberId: string;
let barberStaffUserId: string;
let barberAuthUserId: string;

let managerAuthUserId: string;
let managerAccessToken: string;
let managerStaffUserId: string;

let customerAuthUserId: string;
let customerAccessToken: string;
let customerId: string;

const createdTicketIds: string[] = [];
const createdCustomerIds: string[] = [];

async function callFunction(name: string, token: string, body: Record<string, unknown>) {
  const response = await fetch(`${url}/functions/v1/${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  const { data: business } = await admin.from('businesses').select('id').limit(1).single();
  const { data: service } = await admin.from('services').select('id').limit(1).single();
  serviceId = service!.id;

  const { data: branch } = await admin
    .from('branches')
    .insert({
      business_id: business!.id,
      name: 'Ticket Assignment Test Branch',
      branch_code: `TCBA${suffix % 100000}`,
      address: 'Test',
      latitude: 5.6,
      longitude: -0.18,
    })
    .select()
    .single();
  branchId = branch!.id;

  const { data: bs } = await admin
    .from('branch_services')
    .insert({ branch_id: branchId, service_id: serviceId })
    .select()
    .single();
  branchServiceId = bs!.id;

  const barberEmail = `tcba-barber-${suffix}@test.pixelbarber.local`;
  const { data: barberAuth } = await admin.auth.admin.createUser({
    email: barberEmail,
    password: PASSWORD,
    email_confirm: true,
  });
  barberAuthUserId = barberAuth!.user.id;
  const { data: barberStaff } = await admin
    .from('staff_users')
    .insert({
      auth_user_id: barberAuthUserId,
      name: 'TCBA Test Barber',
      email: barberEmail,
      role: 'barber',
      invite_status: 'accepted',
    })
    .select()
    .single();
  barberStaffUserId = barberStaff!.id;
  const { data: barberRow } = await admin
    .from('barbers')
    .insert({ staff_user_id: barberStaffUserId, home_branch_id: branchId, status: 'available' })
    .select()
    .single();
  barberId = barberRow!.id;
  await admin.from('barber_skills').insert({ barber_id: barberId, service_id: serviceId });
  await admin.from('barber_schedule').insert({
    barber_id: barberId,
    work_date: new Date().toISOString().slice(0, 10),
    branch_id: branchId,
    shift_start: '00:00:00',
    shift_end: '23:59:59',
  });

  const managerEmail = `tcba-manager-${suffix}@test.pixelbarber.local`;
  const { data: managerAuth } = await admin.auth.admin.createUser({
    email: managerEmail,
    password: PASSWORD,
    email_confirm: true,
  });
  managerAuthUserId = managerAuth!.user.id;
  const { data: managerStaff } = await admin
    .from('staff_users')
    .insert({
      auth_user_id: managerAuthUserId,
      name: 'TCBA Test Manager',
      email: managerEmail,
      role: 'branch_manager',
      invite_status: 'accepted',
    })
    .select()
    .single();
  managerStaffUserId = managerStaff!.id;
  await admin
    .from('staff_branch_assignments')
    .insert({ staff_user_id: managerStaffUserId, branch_id: branchId });
  const managerClient = createClient<Database>(url, anonKey);
  const { data: managerSession } = await managerClient.auth.signInWithPassword({
    email: managerEmail,
    password: PASSWORD,
  });
  managerAccessToken = managerSession!.session!.access_token;

  const customerPhone = `+233${String(suffix).slice(-9)}`;
  const { data: customerAuth } = await admin.auth.admin.createUser({
    phone: customerPhone,
    password: PASSWORD,
    phone_confirm: true,
  });
  customerAuthUserId = customerAuth!.user.id;
  const { data: customer } = await admin
    .from('customers')
    .insert({ auth_user_id: customerAuthUserId, name: 'TCBA Test Customer', phone_e164: customerPhone })
    .select()
    .single();
  customerId = customer!.id;
  createdCustomerIds.push(customerId);
  const customerClient = createClient<Database>(url, anonKey);
  const { data: customerSession } = await customerClient.auth.signInWithPassword({
    phone: customerPhone,
    password: PASSWORD,
  });
  customerAccessToken = customerSession!.session!.access_token;
}, 30000);

afterAll(async () => {
  await admin.from('queue_events').delete().in('ticket_id', createdTicketIds);
  await admin.from('notifications').delete().in('related_ticket_id', createdTicketIds);
  await admin.from('queue_tickets').delete().in('id', createdTicketIds);
  await admin.from('customers').delete().in('id', createdCustomerIds);
  await admin.from('barber_schedule').delete().eq('barber_id', barberId);
  await admin.from('barber_skills').delete().eq('barber_id', barberId);
  await admin.from('staff_branch_assignments').delete().eq('staff_user_id', managerStaffUserId);
  await admin.from('staff_users').delete().in('id', [barberStaffUserId, managerStaffUserId]);
  for (const authId of [barberAuthUserId, managerAuthUserId, customerAuthUserId]) {
    await admin.auth.admin.deleteUser(authId);
  }
  // tickets-join/tickets-walk-in both call next_ticket_number, which upserts a
  // branch_ticket_counters row with no cascade back to branches -- must go before the branch
  // delete below, or it fails with a foreign-key violation (the exact bug Phase 5 Task 9 found).
  await admin.from('branch_ticket_counters').delete().eq('branch_id', branchId);
  await admin.from('branches').delete().eq('id', branchId);
}, 30000);

describe('ticket creation sets a real assigned_barber_id', () => {
  it('tickets-join assigns the only eligible barber with no preference given', async () => {
    const { status, body } = await callFunction('tickets-join', customerAccessToken, {
      branch_id: branchId,
      branch_service_id: branchServiceId,
      preferred_barber_id: null,
    });
    expect(status).toBe(200);
    createdTicketIds.push(body.ticket.id);
    expect(body.ticket.assigned_barber_id).toBe(barberId);

    // Clean up immediately so the next test's idempotency check starts fresh.
    await admin
      .from('queue_tickets')
      .update({ state: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason: 'other' })
      .eq('id', body.ticket.id);
  });

  it('tickets-walk-in assigns a real barber for a staff-created ticket', async () => {
    const { status, body } = await callFunction('tickets-walk-in', managerAccessToken, {
      branch_id: branchId,
      branch_service_id: branchServiceId,
      preferred_barber_id: null,
      name: 'TCBA Walk-in Customer',
      phone_e164: null,
    });
    expect(status).toBe(200);
    createdTicketIds.push(body.ticket.id);
    createdCustomerIds.push(body.ticket.customer_id);
    expect(body.ticket.assigned_barber_id).toBe(barberId);
  });

  it('returns a clean 409 with no ticket created when nobody is eligible', async () => {
    await admin.from('barbers').update({ status: 'offline' }).eq('id', barberId);
    const { status, body } = await callFunction('tickets-join', customerAccessToken, {
      branch_id: branchId,
      branch_service_id: branchServiceId,
      preferred_barber_id: null,
    });
    expect(status).toBe(409);
    expect(body.error).toBe('NO_BARBER_AVAILABLE');

    const { data: tickets } = await admin
      .from('queue_tickets')
      .select('id')
      .eq('customer_id', customerId)
      .not('state', 'in', '(completed,cancelled,no_show)');
    expect(tickets ?? []).toHaveLength(0);
    await admin.from('barbers').update({ status: 'available' }).eq('id', barberId);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- tests/db/ticket-creation-barber-assignment.test.ts`
Expected: FAIL — `body.ticket.assigned_barber_id` is `null` (Task 1's function exists but nothing
calls it yet); the third test also fails since no rejection happens today.

- [ ] **Step 3: Extend `createTicketAtomic`**

Modify `supabase/functions/_shared/create-ticket.ts`:

```typescript
export interface CreateTicketParams {
  admin: SupabaseClient;
  branchId: string;
  customerId: string;
  branchServiceId: string;
  preferredBarberId: string | null;
  acceptFallback: boolean;
  createdBy: 'customer' | 'staff';
  createdByStaffId: string | null;
}

export async function createTicketAtomic(params: CreateTicketParams) {
  const {
    admin,
    branchId,
    customerId,
    branchServiceId,
    preferredBarberId,
    acceptFallback,
    createdBy,
    createdByStaffId,
  } = params;

  // ... existing idempotency check and next_ticket_number call are unchanged ...

  // NEW: resolve who this ticket is actually going to, re-deriving fresh rather than trusting
  // any earlier client-side pre-check (spec decision: assignment happens at join time).
  const { data: eligibility, error: eligibilityError } = await admin.rpc('find_eligible_barber', {
    p_branch_id: branchId,
    p_branch_service_id: branchServiceId,
    p_preferred_barber_id: preferredBarberId,
  });
  if (eligibilityError) throw eligibilityError;
  const result = eligibility?.[0];

  let assignedBarberId: string | null = null;
  if (preferredBarberId && result?.preferred_eligible) {
    assignedBarberId = preferredBarberId;
  } else if (preferredBarberId && result?.preferred_scheduled_today && !acceptFallback) {
    // Customer chose to wait specifically for their preferred barber.
    assignedBarberId = preferredBarberId;
  } else {
    assignedBarberId = result?.fallback_barber_id ?? null;
  }

  if (!assignedBarberId) {
    throw new Error('NO_BARBER_AVAILABLE');
  }

  const { data: ticket, error: insertError } = await admin
    .from('queue_tickets')
    .insert({
      ticket_number: ticketNumber,
      branch_id: branchId,
      customer_id: customerId,
      branch_service_id: branchServiceId,
      preferred_barber_id: preferredBarberId,
      assigned_barber_id: assignedBarberId,
      state: 'waiting',
      created_by: createdBy,
      created_by_staff_id: createdByStaffId,
    })
    .select()
    .single();
  // ... rest of the function (23505 race handling, queue_events insert, notifications insert,
  // return) is unchanged ...
}
```

- [ ] **Step 4: Thread `accept_fallback` through both Edge Functions**

Modify `supabase/functions/tickets-join/index.ts` — change the body destructure and the
`createTicketAtomic` call:

```typescript
const { branch_id, branch_service_id, preferred_barber_id, accept_fallback } = body;
// ... existing validation unchanged ...
try {
  const { ticket, wasExisting } = await createTicketAtomic({
    admin,
    branchId: branch_id,
    customerId: customer.id,
    branchServiceId: branch_service_id,
    preferredBarberId: preferred_barber_id ?? null,
    acceptFallback: accept_fallback === true,
    createdBy: 'customer',
    createdByStaffId: null,
  });
  return new Response(JSON.stringify({ ticket, wasExisting }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
} catch (err) {
  const message = (err as Error).message;
  if (message === 'NO_BARBER_AVAILABLE') {
    return new Response(JSON.stringify({ error: 'NO_BARBER_AVAILABLE' }), {
      status: 409,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ error: message }), {
    status: 500,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
```

Modify `supabase/functions/tickets-walk-in/index.ts` identically: add `accept_fallback` to the
body destructure, pass `acceptFallback: accept_fallback === true` into `createTicketAtomic`, and
apply the same `NO_BARBER_AVAILABLE` → `409` mapping in its catch block.

- [ ] **Step 5: Deploy both functions**

Run: `npx supabase functions deploy tickets-join`
Run: `npx supabase functions deploy tickets-walk-in`

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test -- tests/db/ticket-creation-barber-assignment.test.ts`
Expected: PASS, 3/3 tests.

- [ ] **Step 7: Run the full suite to check for regressions**

Run: `npm run test -- --no-file-parallelism`
Expected: all files pass, including every existing test that calls `tickets-join`/`tickets-walk-in`
or `createTicketAtomic` (e.g. `tests/db/ticket-duplicate-join.test.ts` if present) — these must
still pass since `assigned_barber_id` being newly non-null doesn't change any field they assert on.

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/_shared/create-ticket.ts supabase/functions/tickets-join/index.ts supabase/functions/tickets-walk-in/index.ts tests/db/ticket-creation-barber-assignment.test.ts
git commit -m "feat: assign a real barber when a ticket is created"
```

---

### Task 3: Position-derived state promotion + notification

**Files:**
- Create: `supabase/migrations/20260919090100_recalculate_positions_promotion.sql`
- Test: `tests/db/recalculate-positions-promotion.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1-2 directly (this task's fixtures create `queue_tickets` rows
  with `assigned_barber_id` set directly via the admin client, matching every other DB-level
  test's convention in this codebase).
- Produces: `recalculate_positions(p_branch_id, p_barber_id)` (unchanged signature) now also
  writes `state` (`called`/`almost_turn`/`waiting`) derived from `position`, and inserts a
  `notifications` row (`notification_type = 'your_turn'`) exactly once per fresh transition into
  `called`.

- [ ] **Step 1: Write the failing test**

Create `tests/db/recalculate-positions-promotion.test.ts`:

```typescript
// tests/db/recalculate-positions-promotion.test.ts
// @vitest-environment node
// Task 3: recalculate_positions must derive called/almost_turn/waiting purely from a ticket's
// position within its assigned barber's own queue, and notify exactly once per fresh transition
// into 'called' -- including when multiple tickets in the same call change state at once, which
// is exactly the case that would double-fire the notification without the reentrancy guard (see
// this plan's "Corrections to the spec" section).
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const suffix = Date.now();

let branchId: string;
let branchServiceId: string;
let barberId: string;
let barberStaffUserId: string;
let barberAuthUserId: string;

const customerIds: string[] = [];
const ticketIds: string[] = [];

async function makeCustomerAndTicket(label: string, position: number, state: 'waiting' = 'waiting') {
  const { data: customer } = await admin
    .from('customers')
    .insert({
      name: `RPP Customer ${label}`,
      phone_e164: `+233${String(suffix).slice(-7)}${label}`,
    })
    .select()
    .single();
  customerIds.push(customer!.id);
  const { data: ticket } = await admin
    .from('queue_tickets')
    .insert({
      ticket_number: `PB-RPP-${label}-${suffix}`,
      branch_id: branchId,
      customer_id: customer!.id,
      branch_service_id: branchServiceId,
      assigned_barber_id: barberId,
      state,
      position,
      created_by: 'staff',
    })
    .select()
    .single();
  ticketIds.push(ticket!.id);
  return ticket!.id;
}

beforeAll(async () => {
  const { data: business } = await admin.from('businesses').select('id').limit(1).single();
  const { data: service } = await admin.from('services').select('id').limit(1).single();

  const { data: branch } = await admin
    .from('branches')
    .insert({
      business_id: business!.id,
      name: 'Recalc Promotion Test Branch',
      branch_code: `RPP${suffix % 100000}`,
      address: 'Test',
      latitude: 5.6,
      longitude: -0.18,
    })
    .select()
    .single();
  branchId = branch!.id;

  const { data: bs } = await admin
    .from('branch_services')
    .insert({ branch_id: branchId, service_id: service!.id })
    .select()
    .single();
  branchServiceId = bs!.id;

  const barberEmail = `rpp-barber-${suffix}@test.pixelbarber.local`;
  const { data: barberAuth } = await admin.auth.admin.createUser({
    email: barberEmail,
    password: 'Test-Password-123!',
    email_confirm: true,
  });
  barberAuthUserId = barberAuth!.user.id;
  const { data: barberStaff } = await admin
    .from('staff_users')
    .insert({
      auth_user_id: barberAuthUserId,
      name: 'RPP Test Barber',
      email: barberEmail,
      role: 'barber',
      invite_status: 'accepted',
    })
    .select()
    .single();
  barberStaffUserId = barberStaff!.id;
  const { data: barberRow } = await admin
    .from('barbers')
    .insert({ staff_user_id: barberStaffUserId, home_branch_id: branchId })
    .select()
    .single();
  barberId = barberRow!.id;
}, 30000);

afterAll(async () => {
  await admin.from('notifications').delete().in('related_ticket_id', ticketIds);
  await admin.from('queue_events').delete().in('ticket_id', ticketIds);
  await admin.from('queue_tickets').delete().in('id', ticketIds);
  await admin.from('customers').delete().in('id', customerIds);
  await admin.from('staff_users').delete().eq('id', barberStaffUserId);
  await admin.auth.admin.deleteUser(barberAuthUserId);
  await admin.from('branches').delete().eq('id', branchId);
}, 30000);

describe('recalculate_positions position-derived state promotion', () => {
  it('promotes position 1 to called (with one notification) and position 2 to almost_turn, leaving 3+ waiting', async () => {
    const ticket1 = await makeCustomerAndTicket('1', 1);
    const ticket2 = await makeCustomerAndTicket('2', 2);
    const ticket3 = await makeCustomerAndTicket('3', 3);

    const { error } = await admin.rpc('recalculate_positions', {
      p_branch_id: branchId,
      p_barber_id: barberId,
    });
    expect(error).toBeNull();

    const { data: rows } = await admin
      .from('queue_tickets')
      .select('id, state')
      .in('id', [ticket1, ticket2, ticket3]);
    const stateById = Object.fromEntries(rows!.map((r) => [r.id, r.state]));
    expect(stateById[ticket1]).toBe('called');
    expect(stateById[ticket2]).toBe('almost_turn');
    expect(stateById[ticket3]).toBe('waiting');

    const { data: notifications } = await admin
      .from('notifications')
      .select('id')
      .eq('related_ticket_id', ticket1)
      .eq('notification_type', 'your_turn');
    expect(notifications).toHaveLength(1);
  });

  it('does not re-notify on a second call once a ticket is already called', async () => {
    const ticket = ticketIds[0]; // already 'called' from the previous test
    const { error } = await admin.rpc('recalculate_positions', {
      p_branch_id: branchId,
      p_barber_id: barberId,
    });
    expect(error).toBeNull();

    const { data: notifications } = await admin
      .from('notifications')
      .select('id')
      .eq('related_ticket_id', ticket)
      .eq('notification_type', 'your_turn');
    expect(notifications).toHaveLength(1); // still exactly one, not two
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- tests/db/recalculate-positions-promotion.test.ts`
Expected: FAIL — all three tickets stay `waiting`, no notification row is inserted.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260919090100_recalculate_positions_promotion.sql`:

```sql
-- Barber Assignment & Queue Progression design, decisions 6-7. Extends the existing
-- recalculate_positions (already fired by after_ticket_state_change on every state change) to
-- also derive called/almost_turn/waiting from a ticket's position and notify on first entry into
-- called.
--
-- Reentrancy guard: the state-derivation loop below writes queue_tickets.state, which re-fires
-- after_ticket_state_change (`after update of state`), which calls this same function again
-- before the original call's loop finishes. Without a guard, that recursive call would re-derive
-- and re-write the same transitions and insert a second 'your_turn' notification for the same
-- ticket. A transaction-local custom setting makes the recursive re-entry a no-op; the outermost
-- call is always the one that finishes the derivation.
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
      and state in ('waiting','almost_turn')
      and (p_barber_id is null or assigned_barber_id = p_barber_id or (assigned_barber_id is null and is_pooled))
  )
  update queue_tickets qt set position = ranked.rn
  from ranked
  where qt.id = ranked.id
    and qt.position is distinct from ranked.rn;

  if p_barber_id is not null then
    for v_ticket in
      select id, customer_id, state, position
      from queue_tickets
      where assigned_barber_id = p_barber_id
        and state in ('waiting','almost_turn','called')
    loop
      v_new_state := case
        when v_ticket.position = 1 then 'called'
        when v_ticket.position = 2 then 'almost_turn'
        else 'waiting'
      end;
      if v_new_state is distinct from v_ticket.state then
        update queue_tickets set state = v_new_state where id = v_ticket.id;
        if v_new_state = 'called' then
          insert into notifications (recipient_type, recipient_id, channel, notification_type, related_ticket_id, payload)
            values ('customer', v_ticket.customer_id, 'sms', 'your_turn', v_ticket.id, '{}'::jsonb);
        end if;
      end if;
    end loop;
  end if;

  perform set_config('pixelbarber.recalc_in_progress', 'false', true);
end;
$$;
```

- [ ] **Step 4: Push the migration**

Run: `npx supabase db push`
Expected: applies cleanly (`create or replace` on an existing function, matching this project's
established pattern for every prior `recalculate_positions` revision).

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test -- tests/db/recalculate-positions-promotion.test.ts`
Expected: PASS, 2/2 tests.

- [ ] **Step 6: Run the full suite to check for regressions**

Run: `npm run test -- --no-file-parallelism`
Expected: all files pass, including `tests/db/queue-position-recalc-cross-actor.test.ts` and
`tests/db/skip-to-waiting.test.ts` (Phase 5) — neither asserts on `state` beyond `waiting`, so the
new derivation logic must not change their existing assertions.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260919090100_recalculate_positions_promotion.sql tests/db/recalculate-positions-promotion.test.ts
git commit -m "feat: derive called/almost_turn from queue position and notify on called"
```

---

### Task 4: Customer Book flow — preferred-barber availability prompt

**Files:**
- Modify: `packages/shared/src/database.types.ts`
- Modify: `apps/customer/app/book/BookFlow.tsx`
- Modify: `apps/customer/messages/en.json`

**Interfaces:**
- Consumes: `find_eligible_barber` (Task 1), via `supabase.rpc('find_eligible_barber', {...})`
  from the browser client — the same direct-RPC pattern already used by
  `OnboardWizard.tsx`'s call to `link_or_create_customer`.
- Produces: `BookFlow.tsx`'s `handleConfirmJoin` now sends `accept_fallback` in its POST body to
  `tickets-join` (Task 2).

- [ ] **Step 1: Add the `find_eligible_barber` type entry**

Modify `packages/shared/src/database.types.ts` — insert into the `Functions` map (alphabetically,
between `custom_access_token_hook` and `has_capability`):

```typescript
      find_eligible_barber: {
        Args: {
          p_branch_id: string;
          p_branch_service_id: string;
          p_preferred_barber_id: string | null;
        };
        Returns: {
          preferred_eligible: boolean;
          preferred_scheduled_today: boolean;
          fallback_barber_id: string | null;
        }[];
      };
```

- [ ] **Step 2: Run typecheck to verify the type compiles**

Run: `npm run typecheck`
Expected: PASS (this step only adds a type; nothing calls it yet).

- [ ] **Step 3: Add the new translation keys**

Modify `apps/customer/messages/en.json`'s `"Book"` block — add these keys after `"priceLabel"`:

```json
    "availabilityStepTitle": "Barber Availability",
    "preferredBusyMessage": "This barber isn't available right now.",
    "waitForPreferred": "Wait for this barber",
    "takeNextAvailable": "Take next available",
    "noBarberAvailable": "No barbers available for this service right now."
```

- [ ] **Step 4: Add the pre-check and prompt to BookFlow.tsx**

Modify `apps/customer/app/book/BookFlow.tsx`:

```tsx
type Step = 'service' | 'barber' | 'availability' | 'review';

// ... inside the component, alongside the other useState calls ...
const [acceptFallback, setAcceptFallback] = useState(false);

// Replace the two inline onClick handlers in the 'barber' step with calls to this:
async function handleSelectBarber(barberId: string | null) {
  setSelectedBarberId(barberId);
  setAcceptFallback(false);
  if (barberId === null) {
    setStep('review');
    return;
  }
  const { data } = await supabase.rpc('find_eligible_barber', {
    p_branch_id: branchId!,
    p_branch_service_id: selectedServiceId,
    p_preferred_barber_id: barberId,
  });
  const result = data?.[0];
  if (result?.preferred_eligible) {
    setStep('review');
    return;
  }
  if (result?.preferred_scheduled_today) {
    setStep('availability');
    return;
  }
  // Not scheduled today at all -- no prompt, straight to the fallback barber (spec decision 2).
  setAcceptFallback(true);
  setStep('review');
}
```

Update the two buttons inside the `step === 'barber'` block:

```tsx
<button type="button" onClick={() => handleSelectBarber(null)}>
  {t('anyAvailable')}
</button>
```

```tsx
<button type="button" onClick={() => handleSelectBarber(b.id)}>
  {b.id}
</button>
```

Add a new render block for the `availability` step, right before the `review` step block:

```tsx
{step === 'availability' && (
  <div>
    <h2>{t('availabilityStepTitle')}</h2>
    <p>{t('preferredBusyMessage')}</p>
    <button
      type="button"
      onClick={() => {
        setAcceptFallback(false);
        setStep('review');
      }}
    >
      {t('waitForPreferred')}
    </button>
    <button
      type="button"
      onClick={() => {
        setAcceptFallback(true);
        setStep('review');
      }}
    >
      {t('takeNextAvailable')}
    </button>
  </div>
)}
```

Update the `tickets-join` request body in `handleConfirmJoin` to include the resolved choice, and
its error handling to surface the new refusal distinctly:

```tsx
body: JSON.stringify({
  branch_id: branchId,
  branch_service_id: selectedServiceId,
  preferred_barber_id: selectedBarberId,
  accept_fallback: acceptFallback,
}),
```

```tsx
if (!response.ok) {
  const body = await response.json().catch(() => ({}));
  setError(body.error === 'NO_BARBER_AVAILABLE' ? t('noBarberAvailable') : (body.error ?? t('joinFailed')));
  return;
}
```

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck`
Run: `cd apps/customer && npx next build`
Expected: both clean.

- [ ] **Step 6: Manual verification**

Run the customer app locally (`npm run dev` from `apps/customer`), and using a test branch with
one barber scheduled and one not, walk through: (a) selecting "any available" skips straight to
review; (b) selecting a barber who's currently ineligible but scheduled today shows the
availability prompt with both choices; (c) selecting a barber with no schedule row at all today
skips straight to review with no prompt. Confirm the created ticket (via the Supabase dashboard or
a `psql`/API check) has `assigned_barber_id` set correctly for each case.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/database.types.ts apps/customer/app/book/BookFlow.tsx apps/customer/messages/en.json
git commit -m "feat: prompt for wait-vs-fallback when a customer's preferred barber is busy"
```

---

### Task 5: Staff walk-in modal — same availability prompt

**Files:**
- Modify: `apps/staff/app/tickets/AddWalkInModal.tsx`
- Modify: `apps/staff/messages/en.json`

**Interfaces:**
- Consumes: `find_eligible_barber` (Task 1), `packages/shared/src/database.types.ts`'s new type
  entry (Task 4).
- Produces: `AddWalkInModal.tsx`'s submit now sends `accept_fallback` in its POST body to
  `tickets-walk-in` (Task 2).

- [ ] **Step 1: Add the new translation keys**

Modify `apps/staff/messages/en.json`'s `"LiveQueue"` block — add these keys after
`"walkInFailed"`:

```json
    "walkInAvailabilityPrompt": "This barber isn't available right now.",
    "walkInWaitForPreferred": "Wait for this barber",
    "walkInTakeNextAvailable": "Take next available",
    "walkInNoBarberAvailable": "No barbers available for this service right now."
```

- [ ] **Step 2: Add the pre-check and inline prompt to AddWalkInModal.tsx**

Modify `apps/staff/app/tickets/AddWalkInModal.tsx`:

```tsx
const [acceptFallback, setAcceptFallback] = useState(false);
const [needsAvailabilityPrompt, setNeedsAvailabilityPrompt] = useState(false);

async function handleBarberChange(rawValue: string) {
  const resolvedId = rawValue || null;
  setPreferredBarberId(resolvedId);
  setAcceptFallback(false);
  setNeedsAvailabilityPrompt(false);
  if (!resolvedId || !serviceId) return;
  const { data } = await supabase.rpc('find_eligible_barber', {
    p_branch_id: branchId,
    p_branch_service_id: serviceId,
    p_preferred_barber_id: resolvedId,
  });
  const result = data?.[0];
  if (result?.preferred_eligible) return;
  if (result?.preferred_scheduled_today) {
    setNeedsAvailabilityPrompt(true);
  } else {
    setAcceptFallback(true);
  }
}
```

Replace the barber `<select>`'s `onChange` to call this handler:

```tsx
<select
  value={preferredBarberId ?? ''}
  onChange={(e) => handleBarberChange(e.target.value)}
>
```

Add the inline prompt right after that `<select>`:

```tsx
{needsAvailabilityPrompt && (
  <div role="group" aria-label={t('walkInAvailabilityPrompt')}>
    <p>{t('walkInAvailabilityPrompt')}</p>
    <label>
      <input
        type="radio"
        name="walkInFallbackChoice"
        checked={!acceptFallback}
        onChange={() => setAcceptFallback(false)}
      />
      {t('walkInWaitForPreferred')}
    </label>
    <label>
      <input
        type="radio"
        name="walkInFallbackChoice"
        checked={acceptFallback}
        onChange={() => setAcceptFallback(true)}
      />
      {t('walkInTakeNextAvailable')}
    </label>
  </div>
)}
```

Update the `tickets-walk-in` request body and error handling in `handleSubmit`:

```tsx
body: JSON.stringify({
  branch_id: branchId,
  branch_service_id: serviceId,
  preferred_barber_id: preferredBarberId,
  accept_fallback: acceptFallback,
  name,
  phone_e164: normalizedPhone,
}),
```

```tsx
if (!response.ok) {
  const body = await response.json().catch(() => ({}));
  setError(body.error === 'NO_BARBER_AVAILABLE' ? t('walkInNoBarberAvailable') : (body.error ?? t('walkInFailed')));
  return;
}
```

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck`
Run: `cd apps/staff && npx next build`
Expected: both clean.

- [ ] **Step 4: Manual verification**

Run the staff app locally, open Live Queue's Add Walk-in modal on a test branch, and confirm the
same three cases from Task 4's Step 6 behave identically for a staff-created ticket.

- [ ] **Step 5: Commit**

```bash
git add apps/staff/app/tickets/AddWalkInModal.tsx apps/staff/messages/en.json
git commit -m "feat: mirror the wait-vs-fallback prompt in the staff walk-in modal"
```

---

### Task 6: Fix the Ticket Tracking screen's now-live `called` copy

**Files:**
- Modify: `apps/customer/app/tickets/[id]/page.tsx`
- Modify: `apps/customer/messages/en.json`

**Interfaces:** none — purely a copy/label fix, no new data or function calls.

**Context:** `called` was previously a dead state (nothing ever produced it), so grouping it under
the same "You're being served" label as `confirmed`/`in_service` was harmless. Task 3 makes
`called` a real, reachable state meaning "you're at the front of the line, come in now" — which is
materially different from "your haircut has started." Leaving the current copy as-is would tell a
customer at the front of the line something false.

- [ ] **Step 1: Add the new translation key**

Modify `apps/customer/messages/en.json`'s `"TicketTracking"` block — rename the existing
`"stateCalled"` key to `"stateBeingServed"` (same value, more accurate name now that it's
`confirmed`/`in_service`-only), and add a new key for the actual `called` state:

```json
    "stateCalledNow": "Your turn — head to the barber now!",
    "stateBeingServed": "You're being served",
```

(Remove the old `"stateCalled"` line — it's being renamed, not duplicated.)

- [ ] **Step 2: Update the state-label logic**

Modify `apps/customer/app/tickets/[id]/page.tsx` (around line 145-153):

```tsx
<p>
  {ticket.state === 'almost_turn'
    ? t('stateAlmostTurn')
    : ticket.state === 'called'
      ? t('stateCalledNow')
      : ticket.state === 'confirmed' || ticket.state === 'in_service'
        ? t('stateBeingServed')
        : t('stateWaiting')}
</p>
```

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck`
Run: `cd apps/customer && npx next build`
Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git add apps/customer/app/tickets/[id]/page.tsx apps/customer/messages/en.json
git commit -m "fix: give the now-reachable called state its own Ticket Tracking copy"
```

---

### Task 7: End-to-end cross-surface journey

**Files:**
- Create: `e2e/barber-assignment-journey.spec.ts`

**Interfaces:** consumes everything from Tasks 1-6; exercises the real running apps.

- [ ] **Step 1: Write the failing e2e test**

Create `e2e/barber-assignment-journey.spec.ts`, following the fixture/cleanup structure of
`e2e/no-show-cross-surface-journey.spec.ts` (Phase 5 Task 9) — real customer + staff browser
contexts, admin-client fixture setup, FK-safe cleanup in the same order established there
(`queue_events` → `notifications` → `service_sessions` → `feedback` → `queue_tickets` →
`branch_ticket_counters` → `branch_services` → `branches`):

```typescript
// e2e/barber-assignment-journey.spec.ts
// Full cross-surface journey for the Barber Assignment & Queue Progression feature: a customer's
// preferred barber is busy, the customer chooses "take next available," and the resulting ticket
// shows up correctly assigned on the fallback barber's own Today's Queue screen.
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const suffix = Date.now();
const PASSWORD = 'Test-Password-123!';

let branchId: string;
let branchServiceId: string;
let busyBarberId: string;
let busyBarberStaffUserId: string;
let busyBarberAuthUserId: string;
let fallbackBarberId: string;
let fallbackBarberStaffUserId: string;
let fallbackBarberAuthUserId: string;
let fallbackBarberEmail: string;
let customerPhone: string;
let customerAuthUserId: string;
let customerId: string;
let ticketId: string | undefined;

test.beforeAll(async () => {
  const { data: business } = await admin.from('businesses').select('id').limit(1).single();
  const { data: service } = await admin.from('services').select('id').limit(1).single();

  const { data: branch } = await admin
    .from('branches')
    .insert({
      business_id: business!.id,
      name: 'Barber Assignment Journey Branch',
      branch_code: `BAJ${suffix % 100000}`,
      address: 'Test',
      latitude: 5.6,
      longitude: -0.18,
    })
    .select()
    .single();
  branchId = branch!.id;

  const { data: bs } = await admin
    .from('branch_services')
    .insert({ branch_id: branchId, service_id: service!.id })
    .select()
    .single();
  branchServiceId = bs!.id;

  const today = new Date().toISOString().slice(0, 10);

  // "Busy" barber: skilled and scheduled, but marked offline -- ineligible, forces the prompt.
  const busyEmail = `baj-busy-${suffix}@test.pixelbarber.local`;
  const { data: busyAuth } = await admin.auth.admin.createUser({
    email: busyEmail,
    password: PASSWORD,
    email_confirm: true,
  });
  busyBarberAuthUserId = busyAuth!.user.id;
  const { data: busyStaff } = await admin
    .from('staff_users')
    .insert({
      auth_user_id: busyBarberAuthUserId,
      name: 'Baj Busy Barber',
      email: busyEmail,
      role: 'barber',
      invite_status: 'accepted',
    })
    .select()
    .single();
  busyBarberStaffUserId = busyStaff!.id;
  const { data: busyBarber } = await admin
    .from('barbers')
    .insert({ staff_user_id: busyBarberStaffUserId, home_branch_id: branchId, status: 'offline' })
    .select()
    .single();
  busyBarberId = busyBarber!.id;
  await admin.from('barber_skills').insert({ barber_id: busyBarberId, service_id: service!.id });
  await admin.from('barber_schedule').insert({
    barber_id: busyBarberId,
    work_date: today,
    branch_id: branchId,
    shift_start: '00:00:00',
    shift_end: '23:59:59',
  });

  // Fallback barber: eligible, available, will end up with the ticket.
  fallbackBarberEmail = `baj-fallback-${suffix}@test.pixelbarber.local`;
  const { data: fallbackAuth } = await admin.auth.admin.createUser({
    email: fallbackBarberEmail,
    password: PASSWORD,
    email_confirm: true,
  });
  fallbackBarberAuthUserId = fallbackAuth!.user.id;
  const { data: fallbackStaff } = await admin
    .from('staff_users')
    .insert({
      auth_user_id: fallbackBarberAuthUserId,
      name: 'Baj Fallback Barber',
      email: fallbackBarberEmail,
      role: 'barber',
      invite_status: 'accepted',
    })
    .select()
    .single();
  fallbackBarberStaffUserId = fallbackStaff!.id;
  const { data: fallbackBarber } = await admin
    .from('barbers')
    .insert({
      staff_user_id: fallbackBarberStaffUserId,
      home_branch_id: branchId,
      status: 'available',
    })
    .select()
    .single();
  fallbackBarberId = fallbackBarber!.id;
  await admin
    .from('barber_skills')
    .insert({ barber_id: fallbackBarberId, service_id: service!.id });
  await admin.from('barber_schedule').insert({
    barber_id: fallbackBarberId,
    work_date: today,
    branch_id: branchId,
    shift_start: '00:00:00',
    shift_end: '23:59:59',
  });

  customerPhone = `+233${String(suffix).slice(-9)}`;
  const { data: customerAuth } = await admin.auth.admin.createUser({
    phone: customerPhone,
    password: PASSWORD,
    phone_confirm: true,
  });
  customerAuthUserId = customerAuth!.user.id;
  const { data: customer } = await admin
    .from('customers')
    .insert({ auth_user_id: customerAuthUserId, name: 'Baj Test Customer', phone_e164: customerPhone })
    .select()
    .single();
  customerId = customer!.id;
});

test.afterAll(async () => {
  if (ticketId) {
    await admin.from('queue_events').delete().eq('ticket_id', ticketId);
    await admin.from('notifications').delete().eq('related_ticket_id', ticketId);
    await admin.from('queue_tickets').delete().eq('id', ticketId);
  }
  await admin.from('customers').delete().eq('id', customerId);
  await admin.from('barber_schedule').delete().in('barber_id', [busyBarberId, fallbackBarberId]);
  await admin.from('barber_skills').delete().in('barber_id', [busyBarberId, fallbackBarberId]);
  await admin
    .from('staff_users')
    .delete()
    .in('id', [busyBarberStaffUserId, fallbackBarberStaffUserId]);
  for (const authId of [busyBarberAuthUserId, fallbackBarberAuthUserId, customerAuthUserId]) {
    await admin.auth.admin.deleteUser(authId);
  }
  // The real join flow calls next_ticket_number, which upserts branch_ticket_counters -- must be
  // deleted before the branch (no cascade), same fix as Task 2's test.
  await admin.from('branch_ticket_counters').delete().eq('branch_id', branchId);
  await admin.from('branch_services').delete().eq('id', branchServiceId);
  await admin.from('branches').delete().eq('id', branchId);
});

test('customer takes the next available barber when their preferred one is busy', async ({
  browser,
}) => {
  const customerContext = await browser.newContext();
  const customerPage = await customerContext.newPage();
  await customerPage.goto(`/book?branch=${branchId}`);

  await customerPage.getByRole('button', { name: /Haircut|Service/i }).first().click();
  await customerPage.getByRole('button', { name: busyBarberId }).click();

  // Ineligible-but-scheduled-today -> the availability prompt should appear.
  await expect(customerPage.getByText('Barber Availability')).toBeVisible({ timeout: 10000 });
  await customerPage.getByRole('button', { name: 'Take next available' }).click();

  await customerPage.getByRole('button', { name: 'Join Now' }).click();
  await customerPage.waitForURL(/\/tickets\//, { timeout: 10000 });

  const { data: ticket } = await admin
    .from('queue_tickets')
    .select('id, assigned_barber_id')
    .eq('customer_id', customerId)
    .not('state', 'in', '(completed,cancelled,no_show)')
    .single();
  ticketId = ticket!.id;
  expect(ticket!.assigned_barber_id).toBe(fallbackBarberId);

  // Confirm it's visible on the FALLBACK barber's own Today's Queue, not the busy one's.
  const staffContext = await browser.newContext();
  const staffPage = await staffContext.newPage();
  await staffPage.goto('/login');
  await staffPage.getByLabel(/email/i).fill(fallbackBarberEmail);
  await staffPage.getByLabel(/password/i).fill(PASSWORD);
  await staffPage.getByRole('button', { name: /sign in/i }).click();
  await staffPage.waitForURL(/\/queue\/today/, { timeout: 10000 });

  const { data: ticketNumberRow } = await admin
    .from('queue_tickets')
    .select('ticket_number')
    .eq('id', ticket!.id)
    .single();
  await expect(staffPage.getByText(ticketNumberRow!.ticket_number)).toBeVisible({ timeout: 10000 });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx playwright test e2e/barber-assignment-journey.spec.ts`
Expected: FAIL before Tasks 1-6 are complete; once they are (this task runs last), it should pass
on the first real attempt — if it doesn't, treat any selector mismatch as a signal to re-check the
actual rendered markup in `BookFlow.tsx`/`apps/staff/app/queue/today/page.tsx` rather than loosen
the assertion.

- [ ] **Step 3: Run it against the completed feature**

Run: `npx playwright test e2e/barber-assignment-journey.spec.ts`
Expected: PASS.

- [ ] **Step 4: Run the full e2e suite to check for regressions**

Run: `npm run test:e2e`
Expected: no new failures beyond the pre-existing, unrelated `e2e/queue-join-now.spec.ts` failure
already flagged in Phase 5.

- [ ] **Step 5: Commit**

```bash
git add e2e/barber-assignment-journey.spec.ts
git commit -m "test: full customer-to-Today's-Queue journey for barber assignment"
```

---

## Self-Review

**Spec coverage:**
- Decision 1 (assignment at join time) → Task 2.
- Decision 2 (wait-vs-fallback prompt, incl. the not-scheduled-today exception) → Tasks 4-5.
- Decision 3 (least-busy fallback) → Task 1.
- Decision 4 (eligibility rule) → Task 1.
- Decision 5 (clean refusal when nobody eligible) → Task 2.
- Decision 6 (position-derived promotion) → Task 3.
- Decision 7 (notification on entering called) → Task 3.
- Out-of-scope items (`is_pooled`, Barbers Management, staff invitation, PIN rate-limiting) —
  correctly untouched by every task above.
- The now-live `called` state's UI consequence (not explicitly in the spec, found while writing
  this plan) → Task 6.

**Placeholder scan:** none found — every step has real code, not a description of code.

**Type consistency:** `acceptFallback`/`accept_fallback` naming (camelCase in TS, snake_case over
the wire, matching this codebase's existing `preferred_barber_id`/`preferredBarberId` convention)
is consistent across Tasks 2, 4, and 5. `find_eligible_barber`'s return shape
(`preferred_eligible`, `preferred_scheduled_today`, `fallback_barber_id`) is used identically in
Tasks 1, 2, 4, and 5.
