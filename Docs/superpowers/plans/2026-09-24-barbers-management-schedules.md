# Barbers Management — Schedules & Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an Owner or Branch Manager set each barber's regular week, change single days, and
set their skills, so barber assignment and Today's Queue work with real data instead of fixtures.

**Architecture:** A stored weekly pattern (`barber_weekly_hours`) is materialized by a
`SECURITY DEFINER` fill function into the existing dated `barber_schedule` rows, over a rolling
28-day window, triggered on pattern/day-off changes and nightly by `pg_cron`. Because the dated
rows stay the only thing `find_eligible_barber` reads, the barber-assignment logic is untouched.
The staff app gets an upgraded Barbers list and a new Barber detail screen.

**Tech Stack:** PostgreSQL/PL-pgSQL + RLS (Supabase), `pg_cron`, Next.js/React (staff app),
`next-intl`, Vitest (`tests/db/`), Playwright (`e2e/`).

**Spec:** `Docs/superpowers/specs/2026-09-24-barbers-management-schedules-design.md`

## Corrections to the spec, found while writing this plan

1. **Barber names can't come from `staff_users` directly.** The spec says staff can read
   `staff_users.name`. They can't for barbers: `staff_users_branch_scoped_read` only exposes staff
   who have a `staff_branch_assignments` row, and barbers are linked by `barbers.home_branch_id`
   instead. Widening that policy is **not** safe: `staff_users.pin_hash` has no column-level read
   protection, so any widening also exposes barbers' PIN hashes (a 4–6 digit PIN's bcrypt hash is
   brute-forceable offline in seconds). Instead, Task 1 adds a narrow `SECURITY DEFINER` function
   `list_manageable_barbers()` returning only id, name, status and home branch for barbers the
   caller may manage. (The existing policy's `pin_hash` exposure predates this plan and is out of
   scope — flagged to the user separately.)
2. **The nightly refill must skip barbers who have no pattern.** As specified, fill rule 4 ("pattern
   says day off → delete non-manual rows") would, on the nightly run, delete the dated rows of
   every barber with no pattern at all — every existing test fixture barber and any row created
   before this feature. So: the no-argument (nightly) call only processes barbers that have at
   least one `barber_weekly_hours` row; an explicit `p_barber_id` (trigger/reset path) always
   processes that barber, so removing a barber's whole week still clears their future days.
3. **A pattern could escape the manager's branch scope.** `barber_weekly_hours` is scoped by the
   barber's home branch, but its rows name a `branch_id` where the barber works. Since the fill
   function writes `barber_schedule` as definer, a manager could otherwise schedule a barber at a
   branch outside their own scope through the pattern. The write check therefore also requires
   `in_branch_scope(branch_id)`.
4. **"Warn about queued tickets" applies to today only.** Tickets are same-day (appointments are a
   later phase), so a future date can't have queued tickets. The warning is shown only when marking
   **today** off.

## Global Constraints

- Every new/modified `SECURITY DEFINER` function uses `set search_path = public, pg_temp`.
- `fill_barber_schedule` is callable by no client role: `revoke execute ... from public, anon,
  authenticated; grant execute ... to service_role`.
- `find_eligible_barber` and every existing reader of `barber_schedule` must not change.
- RLS on `barber_weekly_hours` and `barber_days_off` is scoped by the **barber's home branch**
  (`in_branch_scope((select home_branch_id from barbers where id = barber_id))`), never by a
  client-supplied column.
- Rolling window: `current_date` through `current_date + 27` (28 days). Dates before
  `current_date` are never modified.
- Every new staff-facing string goes through `next-intl` (`t('key')`) with keys in
  `apps/staff/messages/en.json`. No hardcoded literals in JSX.
- Any `beforeAll`/`afterAll` hook doing more than 1–2 DB operations gets an explicit `30000` ms
  timeout (60000 for fixtures that create many users).
- Test cleanup is FK-safe and deletes only what the test created.
- Already-applied migrations are never edited; every schema change is a new migration.
- Migrations are pushed with `npx supabase db push` — **implementer subagents cannot push or
  deploy** (sandbox); the controller pushes after the implementer commits. Tests that need the
  migration live are run GREEN by the controller after pushing.

---

### Task 1: Schema, permissions, and the barber-list function

**Files:**
- Create: `supabase/migrations/20260924090000_barber_weekly_hours_and_days_off.sql`
- Create: `tests/db/fixtures/barber-management.ts`
- Create: `tests/db/barber-schedule-permissions.test.ts`
- Modify: `packages/shared/src/database.types.ts`

**Interfaces:**
- Produces: tables `barber_weekly_hours(id, barber_id, day_of_week, branch_id, shift_start,
  shift_end)` with `unique (barber_id, day_of_week)`; `barber_days_off(barber_id, off_date)` with
  `primary key (barber_id, off_date)`; column `barber_schedule.is_manual boolean not null default
  false`; function `list_manageable_barbers()` returning rows `{ barber_id, staff_user_id, name,
  status, home_branch_id, home_branch_name }`, granted to `authenticated`.
- Produces: test fixture module `tests/db/fixtures/barber-management.ts` exporting
  `createBarberManagementFixture()` and `cleanupBarberManagementFixture(f)` (used by Task 2).

- [ ] **Step 1: Write the shared test fixture**

Create `tests/db/fixtures/barber-management.ts`. It must read `process.env` inside functions (not at
module top level) — test files load `.env.local` via `config()` at runtime, after ES imports are
hoisted.

```typescript
// tests/db/fixtures/barber-management.ts
// Shared fixture for the Barbers Management schedule/skills tests: two branches, a Branch Manager
// scoped to each, one barber at branch A (active, 'available'), and one phone-auth customer, each
// with a signed-in client. Not a test file itself (vitest only collects *.test.ts).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

export type Client = SupabaseClient<Database>;

export const PASSWORD = 'Test-Password-123!';

export interface StaffLogin {
  authUserId: string;
  staffUserId: string;
  email: string;
  client: Client;
}

export interface BarberManagementFixture {
  admin: Client;
  suffix: string;
  serviceId: string;
  otherServiceId: string;
  branchAId: string;
  branchBId: string;
  branchServiceAId: string;
  managerA: StaffLogin;
  managerB: StaffLogin;
  barber: StaffLogin & { barberId: string; name: string };
  customer: { authUserId: string; customerId: string; client: Client };
}

function env() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  };
}

async function signedInClient(email: string): Promise<Client> {
  const { url, anonKey } = env();
  const client = createClient<Database>(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return client;
}

async function createStaff(
  admin: Client,
  label: string,
  role: 'branch_manager' | 'barber',
  suffix: string,
  assignBranchId: string | null,
): Promise<StaffLogin & { name: string }> {
  const email = `bm-${label}-${suffix}@test.pixelbarber.local`;
  const name = `BM Test ${label} ${suffix}`;
  const { data: authUser, error: authError } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (authError) throw authError;
  const { data: staffRow, error: staffError } = await admin
    .from('staff_users')
    .insert({ auth_user_id: authUser!.user.id, name, email, role, invite_status: 'accepted' })
    .select()
    .single();
  if (staffError) throw staffError;
  if (assignBranchId) {
    const { error: sbaError } = await admin
      .from('staff_branch_assignments')
      .insert({ staff_user_id: staffRow!.id, branch_id: assignBranchId });
    if (sbaError) throw sbaError;
  }
  return {
    authUserId: authUser!.user.id,
    staffUserId: staffRow!.id,
    email,
    name,
    client: await signedInClient(email),
  };
}

export async function createBarberManagementFixture(): Promise<BarberManagementFixture> {
  const { url, anonKey, serviceRoleKey } = env();
  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

  const { data: business } = await admin.from('businesses').select('id').limit(1).single();
  const { data: services } = await admin.from('services').select('id').limit(2);
  const serviceId = services![0].id;
  const otherServiceId = services![1].id;

  const makeBranch = async (label: string) => {
    const { data, error } = await admin
      .from('branches')
      .insert({
        business_id: business!.id,
        name: `BM Test Branch ${label} ${suffix}`,
        branch_code: `BM${label}${suffix.slice(-6)}`,
        address: 'Test',
        latitude: 5.6,
        longitude: -0.18,
      })
      .select()
      .single();
    if (error) throw error;
    return data!.id as string;
  };
  const branchAId = await makeBranch('A');
  const branchBId = await makeBranch('B');

  const { data: bsA, error: bsError } = await admin
    .from('branch_services')
    .insert({ branch_id: branchAId, service_id: serviceId })
    .select()
    .single();
  if (bsError) throw bsError;

  const managerA = await createStaff(admin, 'mgrA', 'branch_manager', suffix, branchAId);
  const managerB = await createStaff(admin, 'mgrB', 'branch_manager', suffix, branchBId);
  const barberStaff = await createStaff(admin, 'barber', 'barber', suffix, null);
  const { data: barberRow, error: barberError } = await admin
    .from('barbers')
    .insert({ staff_user_id: barberStaff.staffUserId, home_branch_id: branchAId, status: 'available' })
    .select()
    .single();
  if (barberError) throw barberError;

  const phone = `+233${suffix.slice(-9)}`;
  const { data: customerAuth, error: customerAuthError } = await admin.auth.admin.createUser({
    phone,
    password: PASSWORD,
    phone_confirm: true,
  });
  if (customerAuthError) throw customerAuthError;
  const { data: customer, error: customerError } = await admin
    .from('customers')
    .insert({ auth_user_id: customerAuth!.user.id, name: `BM Test Customer ${suffix}`, phone_e164: phone })
    .select()
    .single();
  if (customerError) throw customerError;
  const customerClient = createClient<Database>(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: customerSignInError } = await customerClient.auth.signInWithPassword({
    phone,
    password: PASSWORD,
  });
  if (customerSignInError) throw customerSignInError;

  return {
    admin,
    suffix,
    serviceId,
    otherServiceId,
    branchAId,
    branchBId,
    branchServiceAId: bsA!.id,
    managerA,
    managerB,
    barber: { ...barberStaff, barberId: barberRow!.id },
    customer: { authUserId: customerAuth!.user.id, customerId: customer!.id, client: customerClient },
  };
}

export async function cleanupBarberManagementFixture(f: BarberManagementFixture) {
  const { admin } = f;
  // FK-safe: dated/pattern/skill rows first (all cascade from barbers anyway, but explicit is
  // cheap), then staff_branch_assignments, then staff_users (cascades the barbers row), then auth
  // users (staff_users.auth_user_id is `on delete restrict`), then the customer, then branches
  // (branch_services cascade). These tests create no tickets, so no ticket cleanup.
  await admin.from('barber_days_off').delete().eq('barber_id', f.barber.barberId);
  await admin.from('barber_weekly_hours').delete().eq('barber_id', f.barber.barberId);
  await admin.from('barber_schedule').delete().eq('barber_id', f.barber.barberId);
  await admin.from('barber_skills').delete().eq('barber_id', f.barber.barberId);
  await admin
    .from('staff_branch_assignments')
    .delete()
    .in('staff_user_id', [f.managerA.staffUserId, f.managerB.staffUserId]);
  await admin
    .from('staff_users')
    .delete()
    .in('id', [f.managerA.staffUserId, f.managerB.staffUserId, f.barber.staffUserId]);
  for (const authId of [f.managerA.authUserId, f.managerB.authUserId, f.barber.authUserId]) {
    await admin.auth.admin.deleteUser(authId);
  }
  await admin.from('customers').delete().eq('id', f.customer.customerId);
  await admin.auth.admin.deleteUser(f.customer.authUserId);
  await admin.from('branches').delete().in('id', [f.branchAId, f.branchBId]);
}
```

- [ ] **Step 2: Write the failing permissions test**

Create `tests/db/barber-schedule-permissions.test.ts`:

```typescript
// tests/db/barber-schedule-permissions.test.ts
// @vitest-environment node
// Barbers Management permissions: pattern/day-off/dated-row/skill writes are scoped to the
// barber's home branch (never a client-supplied column), barbers read only their own rows,
// customers read nothing, and barber names are exposed only via list_manageable_barbers().
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupBarberManagementFixture,
  createBarberManagementFixture,
  type BarberManagementFixture,
} from './fixtures/barber-management';

let f: BarberManagementFixture;

beforeAll(async () => {
  f = await createBarberManagementFixture();
}, 60000);

afterAll(async () => {
  await cleanupBarberManagementFixture(f);
}, 60000);

describe('barber schedule permissions', () => {
  it("lets branch A's manager write the barber's weekly pattern", async () => {
    const { error } = await f.managerA.client.from('barber_weekly_hours').insert({
      barber_id: f.barber.barberId,
      day_of_week: 1,
      branch_id: f.branchAId,
      shift_start: '09:00',
      shift_end: '17:00',
    });
    expect(error).toBeNull();
  });

  it("refuses branch B's manager, even when naming branch B on the row", async () => {
    const { error } = await f.managerB.client.from('barber_weekly_hours').insert({
      barber_id: f.barber.barberId,
      day_of_week: 2,
      branch_id: f.branchBId,
      shift_start: '09:00',
      shift_end: '17:00',
    });
    expect(error).not.toBeNull();
  });

  it("refuses branch A's manager scheduling the barber at a branch outside their scope", async () => {
    const { error } = await f.managerA.client.from('barber_weekly_hours').insert({
      barber_id: f.barber.barberId,
      day_of_week: 3,
      branch_id: f.branchBId,
      shift_start: '09:00',
      shift_end: '17:00',
    });
    expect(error).not.toBeNull();
  });

  it('rejects an end time before the start time', async () => {
    const { error } = await f.managerA.client.from('barber_weekly_hours').insert({
      barber_id: f.barber.barberId,
      day_of_week: 4,
      branch_id: f.branchAId,
      shift_start: '17:00',
      shift_end: '09:00',
    });
    expect(error).not.toBeNull();
  });

  it('scopes days off to the barber home branch', async () => {
    const { error: aError } = await f.managerA.client
      .from('barber_days_off')
      .insert({ barber_id: f.barber.barberId, off_date: '2099-01-05' });
    expect(aError).toBeNull();
    const { error: bError } = await f.managerB.client
      .from('barber_days_off')
      .insert({ barber_id: f.barber.barberId, off_date: '2099-01-06' });
    expect(bError).not.toBeNull();
    await f.admin.from('barber_days_off').delete().eq('barber_id', f.barber.barberId);
  });

  it("lets branch A's manager hand-edit a dated row and refuses branch B's", async () => {
    const { error: aError } = await f.managerA.client.from('barber_schedule').upsert(
      {
        barber_id: f.barber.barberId,
        work_date: '2099-01-07',
        branch_id: f.branchAId,
        shift_start: '10:00',
        shift_end: '15:00',
        is_manual: true,
      },
      { onConflict: 'barber_id,work_date' },
    );
    expect(aError).toBeNull();
    const { error: bError } = await f.managerB.client.from('barber_schedule').insert({
      barber_id: f.barber.barberId,
      work_date: '2099-01-08',
      branch_id: f.branchAId,
      shift_start: '10:00',
      shift_end: '15:00',
      is_manual: true,
    });
    expect(bError).not.toBeNull();
  });

  it("lets branch A's manager set skills and refuses branch B's", async () => {
    const { error: aError } = await f.managerA.client
      .from('barber_skills')
      .insert({ barber_id: f.barber.barberId, service_id: f.serviceId });
    expect(aError).toBeNull();
    const { error: bError } = await f.managerB.client
      .from('barber_skills')
      .insert({ barber_id: f.barber.barberId, service_id: f.otherServiceId });
    expect(bError).not.toBeNull();
  });

  it('lets the barber read their own pattern and the customer read none', async () => {
    const { data: barberRows, error: barberError } = await f.barber.client
      .from('barber_weekly_hours')
      .select('day_of_week')
      .eq('barber_id', f.barber.barberId);
    expect(barberError).toBeNull();
    expect(barberRows!.length).toBeGreaterThan(0);

    const { data: customerRows } = await f.customer.client
      .from('barber_weekly_hours')
      .select('day_of_week')
      .eq('barber_id', f.barber.barberId);
    expect(customerRows ?? []).toHaveLength(0);
  });

  it('exposes barber names only to managers in scope, via list_manageable_barbers', async () => {
    const { data: aRows, error: aError } = await f.managerA.client.rpc('list_manageable_barbers');
    expect(aError).toBeNull();
    const mine = (aRows ?? []).find((r) => r.barber_id === f.barber.barberId);
    expect(mine?.name).toBe(f.barber.name);
    expect(mine?.home_branch_id).toBe(f.branchAId);

    const { data: bRows } = await f.managerB.client.rpc('list_manageable_barbers');
    expect((bRows ?? []).some((r) => r.barber_id === f.barber.barberId)).toBe(false);

    const { data: customerRows } = await f.customer.client.rpc('list_manageable_barbers');
    expect(customerRows ?? []).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm run test -- tests/db/barber-schedule-permissions.test.ts`
Expected: FAIL — `barber_weekly_hours` / `barber_days_off` / `is_manual` / `list_manageable_barbers`
don't exist yet.

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/20260924090000_barber_weekly_hours_and_days_off.sql`:

```sql
-- Barbers Management (Docs/superpowers/specs/2026-09-24-barbers-management-schedules-design.md).
-- A barber's regular week (barber_weekly_hours) and one-off days off (barber_days_off). Both are
-- materialized into the existing dated barber_schedule rows by fill_barber_schedule (next
-- migration), so find_eligible_barber keeps reading exactly what it reads today.

create table barber_weekly_hours (
  id           uuid primary key default gen_random_uuid(),
  barber_id    uuid not null references barbers(id) on delete cascade,
  day_of_week  smallint not null check (day_of_week between 0 and 6),
  branch_id    uuid not null references branches(id),
  shift_start  time not null,
  shift_end    time not null,
  check (shift_end > shift_start),
  unique (barber_id, day_of_week)
);

create table barber_days_off (
  barber_id  uuid not null references barbers(id) on delete cascade,
  off_date   date not null,
  primary key (barber_id, off_date)
);

-- true for rows a manager edited by hand; the refill never overwrites these.
alter table barber_schedule add column is_manual boolean not null default false;

-- RLS: scoped by the BARBER's home branch (same as barber_skills_staff_write), never by a
-- client-supplied column. The pattern's write check additionally requires the named work branch
-- to be in scope: fill_barber_schedule writes barber_schedule as definer, so without this a
-- manager could schedule a barber at a branch outside their own scope via the pattern.
alter table barber_weekly_hours enable row level security;
create policy barber_weekly_hours_staff_scoped on barber_weekly_hours for all
  using (
    has_capability('manage_barber_schedules')
    and in_branch_scope((select home_branch_id from barbers where id = barber_id))
  )
  with check (
    has_capability('manage_barber_schedules')
    and in_branch_scope((select home_branch_id from barbers where id = barber_id))
    and in_branch_scope(branch_id)
  );
create policy barber_weekly_hours_barber_own_read on barber_weekly_hours for select
  using (barber_id = (select id from barbers where staff_user_id = auth_staff_id()));

alter table barber_days_off enable row level security;
create policy barber_days_off_staff_scoped on barber_days_off for all
  using (
    has_capability('manage_barber_schedules')
    and in_branch_scope((select home_branch_id from barbers where id = barber_id))
  )
  with check (
    has_capability('manage_barber_schedules')
    and in_branch_scope((select home_branch_id from barbers where id = barber_id))
  );
create policy barber_days_off_barber_own_read on barber_days_off for select
  using (barber_id = (select id from barbers where staff_user_id = auth_staff_id()));

-- Barber names for the management screens. staff_users can't be widened for this: it has no
-- column-level read protection on pin_hash, so any broader select policy would also expose
-- barbers' PIN hashes. This returns only what the screens need, only for barbers the caller may
-- manage (Owner: all; Branch Manager: their branches' home barbers).
create or replace function list_manageable_barbers()
returns table (
  barber_id uuid,
  staff_user_id uuid,
  name text,
  status barber_status,
  home_branch_id uuid,
  home_branch_name text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select b.id, b.staff_user_id, su.name, b.status, b.home_branch_id, br.name
  from barbers b
  join staff_users su on su.id = b.staff_user_id
  join branches br on br.id = b.home_branch_id
  where has_capability('manage_barber_schedules')
    and in_branch_scope(b.home_branch_id)
  order by su.name;
$$;

revoke execute on function list_manageable_barbers() from public, anon;
grant execute on function list_manageable_barbers() to authenticated, service_role;
```

- [ ] **Step 5: Add the types**

Modify `packages/shared/src/database.types.ts`:

(a) In `barber_schedule`'s `Row`, add `is_manual: boolean;`; in its `Insert` and `Update`, add
`is_manual?: boolean;` (alphabetical field order, matching the surrounding entries).

(b) Add these two table entries to the `Tables` map, alphabetically (`barber_days_off` before
`barber_schedule`; `barber_weekly_hours` after `barber_skills`):

```typescript
      barber_days_off: {
        Row: { barber_id: string; off_date: string };
        Insert: { barber_id: string; off_date: string };
        Update: { barber_id?: string; off_date?: string };
        Relationships: [];
      };
```

```typescript
      barber_weekly_hours: {
        Row: {
          barber_id: string;
          branch_id: string;
          day_of_week: number;
          id: string;
          shift_end: string;
          shift_start: string;
        };
        Insert: {
          barber_id: string;
          branch_id: string;
          day_of_week: number;
          id?: string;
          shift_end: string;
          shift_start: string;
        };
        Update: {
          barber_id?: string;
          branch_id?: string;
          day_of_week?: number;
          id?: string;
          shift_end?: string;
          shift_start?: string;
        };
        Relationships: [];
      };
```

(c) Add to the `Functions` map, alphabetically (after `link_or_create_customer`):

```typescript
      list_manageable_barbers: {
        Args: never;
        Returns: {
          barber_id: string;
          staff_user_id: string;
          name: string;
          status: Database['public']['Enums']['barber_status'];
          home_branch_id: string;
          home_branch_name: string;
        }[];
      };
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260924090000_barber_weekly_hours_and_days_off.sql tests/db/fixtures/barber-management.ts tests/db/barber-schedule-permissions.test.ts packages/shared/src/database.types.ts
git commit -m "feat: add barber weekly hours, days off, and scoped barber listing"
```

- [ ] **Step 8 (controller): push and verify GREEN**

Controller runs `npx supabase db push`, then
`npm run test -- tests/db/barber-schedule-permissions.test.ts` — Expected: PASS, 9/9.

---

### Task 2: The fill function, triggers, day reset, and nightly job

**Files:**
- Create: `supabase/migrations/20260924090100_fill_barber_schedule.sql`
- Create: `tests/db/barber-schedule-fill.test.ts`
- Modify: `packages/shared/src/database.types.ts`

**Interfaces:**
- Consumes: Task 1's tables, `is_manual` column, and `tests/db/fixtures/barber-management.ts`.
- Produces: `fill_barber_schedule(p_barber_id uuid default null)` (service_role only);
  `reset_barber_schedule_day(p_barber_id uuid, p_date date)` (granted to `authenticated`, raises on
  out-of-scope barber, past date, or date beyond the window); triggers refilling on
  `barber_weekly_hours` and `barber_days_off` changes; `pg_cron` job `fill-barber-schedules`.

- [ ] **Step 1: Write the failing test**

Create `tests/db/barber-schedule-fill.test.ts`:

```typescript
// tests/db/barber-schedule-fill.test.ts
// @vitest-environment node
// fill_barber_schedule materializes a barber's weekly pattern into dated barber_schedule rows
// for today..today+27, protecting hand-edited days, honouring days off, never touching the past,
// and staying idempotent. The last test proves the production unblocker end to end.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupBarberManagementFixture,
  createBarberManagementFixture,
  type BarberManagementFixture,
} from './fixtures/barber-management';

let f: BarberManagementFixture;

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

// A date string's weekday, independent of the machine's timezone (0 = Sunday, like day_of_week).
function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function resetBarber() {
  await f.admin.from('barber_days_off').delete().eq('barber_id', f.barber.barberId);
  await f.admin.from('barber_weekly_hours').delete().eq('barber_id', f.barber.barberId);
  await f.admin.from('barber_schedule').delete().eq('barber_id', f.barber.barberId);
  await f.admin.from('barber_skills').delete().eq('barber_id', f.barber.barberId);
  await f.admin.from('staff_users').update({ is_active: true }).eq('id', f.barber.staffUserId);
}

async function setPattern(days: number[], start = '09:00', end = '17:00') {
  const { error } = await f.admin.from('barber_weekly_hours').insert(
    days.map((day_of_week) => ({
      barber_id: f.barber.barberId,
      day_of_week,
      branch_id: f.branchAId,
      shift_start: start,
      shift_end: end,
    })),
  );
  if (error) throw error;
}

async function rows() {
  const { data, error } = await f.admin
    .from('barber_schedule')
    .select('id, work_date, branch_id, shift_start, shift_end, is_manual')
    .eq('barber_id', f.barber.barberId)
    .order('work_date');
  if (error) throw error;
  return data!;
}

beforeAll(async () => {
  f = await createBarberManagementFixture();
}, 60000);

afterAll(async () => {
  await cleanupBarberManagementFixture(f);
}, 60000);

beforeEach(async () => {
  await resetBarber();
}, 30000);

describe('fill_barber_schedule', () => {
  it('fills exactly 28 consecutive days from a full-week pattern', async () => {
    await setPattern(ALL_DAYS);
    const r = await rows();
    expect(r).toHaveLength(28);
    expect(new Set(r.map((x) => x.work_date)).size).toBe(28);
    expect(r[27].work_date).toBe(addDays(r[0].work_date, 27));
    for (const x of r) {
      expect(x.is_manual).toBe(false);
      expect(x.branch_id).toBe(f.branchAId);
      expect(x.shift_start).toBe('09:00:00');
      expect(x.shift_end).toBe('17:00:00');
    }
  });

  it('leaves pattern days off empty (28 days = exactly 4 of each weekday)', async () => {
    await setPattern([1, 2, 3, 4, 5, 6]);
    const r = await rows();
    expect(r).toHaveLength(24);
    expect(r.some((x) => weekday(x.work_date) === 0)).toBe(false);
  });

  it('protects a hand-edited day when the pattern changes', async () => {
    await setPattern(ALL_DAYS);
    const target = (await rows())[2];
    await f.admin
      .from('barber_schedule')
      .update({ is_manual: true, shift_start: '12:00' })
      .eq('id', target.id);
    await f.admin
      .from('barber_weekly_hours')
      .update({ shift_start: '10:00' })
      .eq('barber_id', f.barber.barberId);
    const r = await rows();
    const edited = r.find((x) => x.work_date === target.work_date)!;
    expect(edited.is_manual).toBe(true);
    expect(edited.shift_start).toBe('12:00:00');
    for (const x of r.filter((x) => x.work_date !== target.work_date)) {
      expect(x.shift_start).toBe('10:00:00');
    }
  });

  it('removes a day off from the schedule and restores it when the day off is deleted', async () => {
    await setPattern(ALL_DAYS);
    const day = (await rows())[5].work_date;
    await f.admin.from('barber_days_off').insert({ barber_id: f.barber.barberId, off_date: day });
    expect((await rows()).some((x) => x.work_date === day)).toBe(false);
    await f.admin
      .from('barber_days_off')
      .delete()
      .eq('barber_id', f.barber.barberId)
      .eq('off_date', day);
    const restored = (await rows()).find((x) => x.work_date === day);
    expect(restored?.shift_start).toBe('09:00:00');
    expect(restored?.is_manual).toBe(false);
  });

  it('lets a day off override a hand-edited day', async () => {
    await setPattern(ALL_DAYS);
    const target = (await rows())[3];
    await f.admin.from('barber_schedule').update({ is_manual: true }).eq('id', target.id);
    await f.admin
      .from('barber_days_off')
      .insert({ barber_id: f.barber.barberId, off_date: target.work_date });
    expect((await rows()).some((x) => x.work_date === target.work_date)).toBe(false);
  });

  it('never touches days before today', async () => {
    await setPattern(ALL_DAYS);
    const today = (await rows())[0].work_date;
    const yesterday = addDays(today, -1);
    await f.admin.from('barber_schedule').insert({
      barber_id: f.barber.barberId,
      work_date: yesterday,
      branch_id: f.branchAId,
      shift_start: '08:00',
      shift_end: '12:00',
    });
    await f.admin
      .from('barber_weekly_hours')
      .update({ shift_start: '10:00' })
      .eq('barber_id', f.barber.barberId);
    const past = (await rows()).find((x) => x.work_date === yesterday);
    expect(past?.shift_start).toBe('08:00:00');
  });

  it('is idempotent', async () => {
    await setPattern(ALL_DAYS);
    const before = await rows();
    const { error } = await f.admin.rpc('fill_barber_schedule', { p_barber_id: f.barber.barberId });
    expect(error).toBeNull();
    expect(await rows()).toEqual(before);
  });

  it('skips inactive staff', async () => {
    await setPattern(ALL_DAYS);
    await f.admin.from('staff_users').update({ is_active: false }).eq('id', f.barber.staffUserId);
    await f.admin.from('barber_schedule').delete().eq('barber_id', f.barber.barberId);
    await f.admin.rpc('fill_barber_schedule', { p_barber_id: f.barber.barberId });
    expect(await rows()).toHaveLength(0);
  });

  it('nightly run leaves barbers who have no pattern alone', async () => {
    // No pattern at all; a directly inserted row (like every pre-existing fixture) must survive a
    // no-argument (nightly-style) run.
    const today = new Date().toISOString().slice(0, 10);
    await f.admin.from('barber_schedule').insert({
      barber_id: f.barber.barberId,
      work_date: today,
      branch_id: f.branchAId,
      shift_start: '09:00',
      shift_end: '17:00',
    });
    const { error } = await f.admin.rpc('fill_barber_schedule');
    expect(error).toBeNull();
    expect((await rows()).some((x) => x.work_date === today)).toBe(true);
  });

  it('refuses every client role executing fill_barber_schedule directly', async () => {
    const { error } = await f.managerA.client.rpc('fill_barber_schedule', {
      p_barber_id: f.barber.barberId,
    });
    expect(error).not.toBeNull();
  });
});

describe('reset_barber_schedule_day', () => {
  it('restores a hand-edited day to the pattern', async () => {
    await setPattern(ALL_DAYS);
    const target = (await rows())[4];
    await f.admin
      .from('barber_schedule')
      .update({ is_manual: true, shift_start: '12:00' })
      .eq('id', target.id);
    const { error } = await f.managerA.client.rpc('reset_barber_schedule_day', {
      p_barber_id: f.barber.barberId,
      p_date: target.work_date,
    });
    expect(error).toBeNull();
    const restored = (await rows()).find((x) => x.work_date === target.work_date)!;
    expect(restored.is_manual).toBe(false);
    expect(restored.shift_start).toBe('09:00:00');
  });

  it('clears a day off and restores the pattern day', async () => {
    await setPattern(ALL_DAYS);
    const day = (await rows())[6].work_date;
    await f.admin.from('barber_days_off').insert({ barber_id: f.barber.barberId, off_date: day });
    const { error } = await f.managerA.client.rpc('reset_barber_schedule_day', {
      p_barber_id: f.barber.barberId,
      p_date: day,
    });
    expect(error).toBeNull();
    expect((await rows()).some((x) => x.work_date === day)).toBe(true);
    const { data: offRows } = await f.admin
      .from('barber_days_off')
      .select('off_date')
      .eq('barber_id', f.barber.barberId);
    expect(offRows ?? []).toHaveLength(0);
  });

  it('refuses a manager outside the barber home branch', async () => {
    await setPattern(ALL_DAYS);
    const day = (await rows())[1].work_date;
    const { error } = await f.managerB.client.rpc('reset_barber_schedule_day', {
      p_barber_id: f.barber.barberId,
      p_date: day,
    });
    expect(error).not.toBeNull();
  });

  it('refuses a past date', async () => {
    await setPattern(ALL_DAYS);
    const yesterday = addDays((await rows())[0].work_date, -1);
    const { error } = await f.managerA.client.rpc('reset_barber_schedule_day', {
      p_barber_id: f.barber.barberId,
      p_date: yesterday,
    });
    expect(error).not.toBeNull();
  });
});

describe('production unblocker', () => {
  it('a pattern and skill set by a real manager session make the barber assignable', async () => {
    const { error: patternError } = await f.managerA.client.from('barber_weekly_hours').insert(
      ALL_DAYS.map((day_of_week) => ({
        barber_id: f.barber.barberId,
        day_of_week,
        branch_id: f.branchAId,
        shift_start: '00:00',
        shift_end: '23:59:59',
      })),
    );
    expect(patternError).toBeNull();
    const { error: skillError } = await f.managerA.client
      .from('barber_skills')
      .insert({ barber_id: f.barber.barberId, service_id: f.serviceId });
    expect(skillError).toBeNull();

    const { data, error } = await f.admin.rpc('find_eligible_barber', {
      p_branch_id: f.branchAId,
      p_branch_service_id: f.branchServiceAId,
      p_preferred_barber_id: f.barber.barberId,
    });
    expect(error).toBeNull();
    expect(data![0].preferred_eligible).toBe(true);
    expect(data![0].fallback_barber_id).toBe(f.barber.barberId);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- tests/db/barber-schedule-fill.test.ts`
Expected: FAIL — no dated rows are produced (the fill function and triggers don't exist yet).

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260924090100_fill_barber_schedule.sql`:

```sql
-- Barbers Management: materialize barber_weekly_hours into dated barber_schedule rows for
-- current_date .. current_date + 27. find_eligible_barber is untouched -- it keeps reading the
-- dated rows exactly as before.
--
-- Rules, per barber, per date in the window:
--   1. date is a day off            -> delete any row for that date (hand-edited or not)
--   2. row exists and is_manual      -> leave it
--   3. pattern has that weekday      -> upsert the row from the pattern (is_manual = false)
--   4. pattern says day off          -> delete any non-manual row for that date
-- Dates before current_date are never touched.
--
-- The no-argument (nightly) call only processes barbers who have a pattern, so barbers with no
-- pattern -- every pre-existing fixture, and any row created before this feature -- keep their
-- dated rows. An explicit p_barber_id (trigger/reset) always processes that barber, so removing a
-- barber's whole week still clears their future days.
create or replace function fill_barber_schedule(p_barber_id uuid default null) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_barber_id uuid;
  v_date date;
  v_pattern record;
begin
  for v_barber_id in
    select b.id
    from barbers b
    join staff_users su on su.id = b.staff_user_id
    where su.is_active
      and (
        (p_barber_id is not null and b.id = p_barber_id)
        or (
          p_barber_id is null
          and exists (select 1 from barber_weekly_hours w where w.barber_id = b.id)
        )
      )
  loop
    for v_date in
      select d::date from generate_series(current_date, current_date + 27, interval '1 day') as d
    loop
      if exists (
        select 1 from barber_days_off where barber_id = v_barber_id and off_date = v_date
      ) then
        delete from barber_schedule where barber_id = v_barber_id and work_date = v_date;
      elsif exists (
        select 1 from barber_schedule
        where barber_id = v_barber_id and work_date = v_date and is_manual
      ) then
        null;
      else
        select * into v_pattern
        from barber_weekly_hours
        where barber_id = v_barber_id and day_of_week = extract(dow from v_date)::smallint;

        if found then
          insert into barber_schedule (barber_id, work_date, branch_id, shift_start, shift_end, is_manual)
          values (v_barber_id, v_date, v_pattern.branch_id, v_pattern.shift_start, v_pattern.shift_end, false)
          on conflict (barber_id, work_date) do update
            set branch_id = excluded.branch_id,
                shift_start = excluded.shift_start,
                shift_end = excluded.shift_end
            where barber_schedule.is_manual = false
              and (barber_schedule.branch_id, barber_schedule.shift_start, barber_schedule.shift_end)
                  is distinct from (excluded.branch_id, excluded.shift_start, excluded.shift_end);
        else
          delete from barber_schedule
          where barber_id = v_barber_id and work_date = v_date and not is_manual;
        end if;
      end if;
    end loop;
  end loop;
end;
$$;

revoke execute on function fill_barber_schedule(uuid) from public, anon, authenticated;
grant execute on function fill_barber_schedule(uuid) to service_role;

-- Refill a barber whenever their pattern or days off change. SECURITY DEFINER because the
-- invoking manager has no EXECUTE on fill_barber_schedule. Branches on TG_OP rather than reading
-- NEW in a DELETE (NEW is null there).
create or replace function trg_refill_barber_schedule() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    perform fill_barber_schedule(old.barber_id);
  else
    perform fill_barber_schedule(new.barber_id);
    if tg_op = 'UPDATE' and old.barber_id is distinct from new.barber_id then
      perform fill_barber_schedule(old.barber_id);
    end if;
  end if;
  return null;
end;
$$;

create trigger after_barber_weekly_hours_change
  after insert or update or delete on barber_weekly_hours
  for each row execute function trg_refill_barber_schedule();

create trigger after_barber_days_off_change
  after insert or delete on barber_days_off
  for each row execute function trg_refill_barber_schedule();

-- The one client-callable way to restore a single date to the pattern. Checks the caller may
-- manage this barber (same capability + home-branch scope as the tables' RLS), refuses dates
-- outside the window, then clears that date's day off and dated row and refills.
create or replace function reset_barber_schedule_day(p_barber_id uuid, p_date date) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_home_branch_id uuid;
begin
  select home_branch_id into v_home_branch_id from barbers where id = p_barber_id;
  if v_home_branch_id is null then
    raise exception 'Barber not found' using errcode = 'P0002';
  end if;
  if not (has_capability('manage_barber_schedules') and in_branch_scope(v_home_branch_id)) then
    raise exception 'Not allowed to manage this barber' using errcode = '42501';
  end if;
  if p_date < current_date or p_date > current_date + 27 then
    raise exception 'Date is outside the schedulable window' using errcode = '22023';
  end if;

  delete from barber_days_off where barber_id = p_barber_id and off_date = p_date;
  delete from barber_schedule where barber_id = p_barber_id and work_date = p_date;
  perform fill_barber_schedule(p_barber_id);
end;
$$;

revoke execute on function reset_barber_schedule_day(uuid, date) from public, anon;
grant execute on function reset_barber_schedule_day(uuid, date) to authenticated, service_role;

-- Nightly: extend every patterned barber's window by one day (and repair anything missed).
select cron.schedule(
  'fill-barber-schedules',
  '5 0 * * *',
  $$ select fill_barber_schedule(); $$
);
```

- [ ] **Step 4: Add the types**

Modify `packages/shared/src/database.types.ts` — add to the `Functions` map, alphabetically
(`fill_barber_schedule` before `find_eligible_barber`; `reset_barber_schedule_day` after
`recalculate_positions`):

```typescript
      fill_barber_schedule: {
        Args: { p_barber_id?: string | null };
        Returns: undefined;
      };
```

```typescript
      reset_barber_schedule_day: {
        Args: { p_barber_id: string; p_date: string };
        Returns: undefined;
      };
```

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` — Expected: PASS.

```bash
git add supabase/migrations/20260924090100_fill_barber_schedule.sql tests/db/barber-schedule-fill.test.ts packages/shared/src/database.types.ts
git commit -m "feat: materialize barber weekly patterns into dated schedules"
```

- [ ] **Step 6 (controller): push and verify GREEN**

Controller runs `npx supabase db push`, then
`npm run test -- tests/db/barber-schedule-fill.test.ts tests/db/barber-schedule-permissions.test.ts`
— Expected: PASS. Then the full suite `npm run test -- --no-file-parallelism` — Expected: all
files pass (the nightly-skip rule protects every existing fixture's directly inserted rows).

---

### Task 3: Barbers list shows names and links to the detail screen

**Files:**
- Create: `apps/staff/app/settings/barbers/scope.ts`
- Modify: `apps/staff/app/settings/barbers/page.tsx`
- Modify: `apps/staff/messages/en.json`

**Interfaces:**
- Consumes: `list_manageable_barbers()` (Task 1).
- Produces: `loadManageableBranches(supabase)` in `scope.ts`, returning
  `Promise<ManageableBranch[]>` where `ManageableBranch = { id: string; name: string }` (used by
  Tasks 4–5); the list links to `/settings/barbers/<barber_id>`.

- [ ] **Step 1: Add translation keys**

In `apps/staff/messages/en.json`'s `"BarbersManagement"` block, add after `"pinSetFailed"`:

```json
    "homeBranchLabel": "Home branch: {branch}",
    "statusLabel": "Status: {status}",
    "manageSchedule": "Schedule & skills",
    "noBarbers": "No barbers at your branches yet.",
    "loadFailed": "Couldn't load barbers."
```

- [ ] **Step 2: Create the scope helper**

Create `apps/staff/app/settings/barbers/scope.ts`:

```typescript
// Branches the signed-in staff member may manage: all for an Owner, otherwise the branch ids in
// their JWT. Mirrors in_branch_scope() so pickers only offer branches a save would be allowed on.
import { createBrowserSupabaseClient } from '@pixel-barber/shared';

type Supabase = ReturnType<typeof createBrowserSupabaseClient>;

export interface ManageableBranch {
  id: string;
  name: string;
}

export async function loadManageableBranches(supabase: Supabase): Promise<ManageableBranch[]> {
  const [{ data: role }, { data: branchIds }, { data: branches }] = await Promise.all([
    supabase.rpc('auth_role'),
    supabase.rpc('auth_branch_ids'),
    supabase.from('branches').select('id, name').order('name'),
  ]);
  const all = (branches ?? []) as ManageableBranch[];
  if (role === 'owner') return all;
  const allowed = new Set(branchIds ?? []);
  return all.filter((b) => allowed.has(b.id));
}
```

- [ ] **Step 3: Rewrite the list page**

Replace `apps/staff/app/settings/barbers/page.tsx` with (the PIN control's behaviour is kept
exactly; it now keys on `barber_id`/`staff_user_id` from the function's rows):

```tsx
// apps/staff/app/settings/barbers/page.tsx
// Barbers Management list (App Flow 8.9): barbers the signed-in Owner/Branch Manager may manage,
// with name, status and home branch, the existing PIN set/rotate control, and a link to each
// barber's schedule & skills screen.
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';

type ManageableBarber =
  Database['public']['Functions']['list_manageable_barbers']['Returns'][number];

export default function BarbersManagementPage() {
  const t = useTranslations('BarbersManagement');
  const supabase = createBrowserSupabaseClient();
  const [barbers, setBarbers] = useState<ManageableBarber[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [pinInputs, setPinInputs] = useState<Record<string, string>>({});
  const [statusByBarber, setStatusByBarber] = useState<Record<string, string>>({});

  useEffect(() => {
    supabase.rpc('list_manageable_barbers').then(({ data, error }) => {
      if (error) setLoadError(true);
      setBarbers(data ?? []);
      setLoaded(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSetPin(barber: ManageableBarber) {
    const pin = pinInputs[barber.barber_id];
    if (!pin) return;
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/barber-pin-set`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ barber_staff_user_id: barber.staff_user_id, pin }),
      },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setStatusByBarber((s) => ({ ...s, [barber.barber_id]: body.error ?? t('pinSetFailed') }));
      return;
    }
    setStatusByBarber((s) => ({ ...s, [barber.barber_id]: t('pinSetSuccess') }));
    setPinInputs((p) => ({ ...p, [barber.barber_id]: '' }));
  }

  return (
    <main>
      <h1>{t('title')}</h1>
      {loadError && <p role="alert">{t('loadFailed')}</p>}
      {loaded && !loadError && barbers.length === 0 && <p>{t('noBarbers')}</p>}
      <ul>
        {barbers.map((barber) => (
          <li key={barber.barber_id}>
            <strong>{barber.name}</strong>
            <span> {t('statusLabel', { status: barber.status })}</span>
            <span> {t('homeBranchLabel', { branch: barber.home_branch_name })}</span>
            <Link href={`/settings/barbers/${barber.barber_id}`}> {t('manageSchedule')}</Link>
            {statusByBarber[barber.barber_id] && (
              <span role="status"> {statusByBarber[barber.barber_id]}</span>
            )}
            <input
              placeholder={t('pinPlaceholder')}
              value={pinInputs[barber.barber_id] ?? ''}
              onChange={(e) =>
                setPinInputs((p) => ({ ...p, [barber.barber_id]: e.target.value }))
              }
              maxLength={6}
            />
            <button type="button" onClick={() => handleSetPin(barber)}>
              {t('setPinButton')}
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck` and `cd apps/staff && npx next build` — Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add apps/staff/app/settings/barbers/scope.ts apps/staff/app/settings/barbers/page.tsx apps/staff/messages/en.json
git commit -m "feat: show barber names on Barbers Management and link to schedule screen"
```

---

### Task 4: Barber detail screen — regular week and skills

**Files:**
- Create: `apps/staff/app/settings/barbers/[id]/page.tsx`
- Create: `apps/staff/app/settings/barbers/[id]/RegularWeek.tsx`
- Create: `apps/staff/app/settings/barbers/[id]/SkillsEditor.tsx`
- Modify: `apps/staff/messages/en.json`

**Interfaces:**
- Consumes: `list_manageable_barbers()` (Task 1); `loadManageableBranches` and
  `ManageableBranch` from `../scope` (Task 3); `barber_weekly_hours` (Task 1) with the refill
  triggers (Task 2).
- Produces: page state `refreshKey: number`, incremented after a regular-week save, which Task 5's
  `UpcomingDays` component consumes as a prop to reload.

- [ ] **Step 1: Add translation keys**

Add a new top-level `"BarberDetail"` block to `apps/staff/messages/en.json` (after
`"BarbersManagement"`):

```json
  "BarberDetail": {
    "notFound": "Barber not found, or you can't manage this barber.",
    "backToList": "Back to barbers",
    "homeBranch": "Home branch: {branch}",
    "regularWeekTitle": "Regular week",
    "working": "Working",
    "branch": "Branch",
    "start": "Start",
    "end": "End",
    "saveWeek": "Save regular week",
    "weekSaved": "Regular week saved. The next 4 weeks have been updated.",
    "endBeforeStart": "End time must be after start time.",
    "saveFailed": "Couldn't save. Please try again.",
    "loadFailed": "Couldn't load this barber's schedule.",
    "skillsTitle": "Skills",
    "saveSkills": "Save skills",
    "skillsSaved": "Skills saved.",
    "noSkillsWarning": "No skills ticked — this barber will never be assigned customers.",
    "noServices": "This branch has no services yet.",
    "day0": "Sunday",
    "day1": "Monday",
    "day2": "Tuesday",
    "day3": "Wednesday",
    "day4": "Thursday",
    "day5": "Friday",
    "day6": "Saturday"
  },
```

- [ ] **Step 2: Create `RegularWeek.tsx`**

```tsx
// apps/staff/app/settings/barbers/[id]/RegularWeek.tsx
// A barber's regular week. Saving writes barber_weekly_hours; database triggers then refill the
// next 28 dated days (hand-edited days and days off are left alone).
'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { ManageableBranch } from '../scope';

// Monday first. 0 = Sunday, the same convention as branch_hours.day_of_week.
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

interface DayRow {
  dayOfWeek: number;
  working: boolean;
  branchId: string;
  start: string;
  end: string;
}

export default function RegularWeek({
  barberId,
  homeBranchId,
  branches,
  onSaved,
}: {
  barberId: string;
  homeBranchId: string;
  branches: ManageableBranch[];
  onSaved: () => void;
}) {
  const t = useTranslations('BarberDetail');
  const supabase = createBrowserSupabaseClient();
  const [rows, setRows] = useState<DayRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from('barber_weekly_hours')
      .select('*')
      .eq('barber_id', barberId)
      .then(({ data, error: loadError }) => {
        if (cancelled) return;
        if (loadError) {
          setError(t('loadFailed'));
          return;
        }
        const byDay = new Map((data ?? []).map((r) => [r.day_of_week, r]));
        setRows(
          DAY_ORDER.map((dayOfWeek) => {
            const r = byDay.get(dayOfWeek);
            return r
              ? {
                  dayOfWeek,
                  working: true,
                  branchId: r.branch_id,
                  start: r.shift_start.slice(0, 5),
                  end: r.shift_end.slice(0, 5),
                }
              : { dayOfWeek, working: false, branchId: homeBranchId, start: '09:00', end: '18:00' };
          }),
        );
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barberId, homeBranchId]);

  function update(index: number, patch: Partial<DayRow>) {
    setSaved(false);
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  async function handleSave() {
    setError(null);
    setSaved(false);
    const working = rows.filter((r) => r.working);
    // 'HH:MM' strings compare correctly as text.
    if (working.some((r) => r.end <= r.start)) {
      setError(t('endBeforeStart'));
      return;
    }
    setSaving(true);
    const offDays = rows.filter((r) => !r.working).map((r) => r.dayOfWeek);
    if (offDays.length > 0) {
      const { error: deleteError } = await supabase
        .from('barber_weekly_hours')
        .delete()
        .eq('barber_id', barberId)
        .in('day_of_week', offDays);
      if (deleteError) {
        setError(t('saveFailed'));
        setSaving(false);
        return;
      }
    }
    if (working.length > 0) {
      const { error: upsertError } = await supabase.from('barber_weekly_hours').upsert(
        working.map((r) => ({
          barber_id: barberId,
          day_of_week: r.dayOfWeek,
          branch_id: r.branchId,
          shift_start: r.start,
          shift_end: r.end,
        })),
        { onConflict: 'barber_id,day_of_week' },
      );
      if (upsertError) {
        setError(t('saveFailed'));
        setSaving(false);
        return;
      }
    }
    setSaving(false);
    setSaved(true);
    onSaved();
  }

  return (
    <section>
      <h2>{t('regularWeekTitle')}</h2>
      {error && <p role="alert">{error}</p>}
      {saved && <p role="status">{t('weekSaved')}</p>}
      <table>
        <thead>
          <tr>
            <th />
            <th>{t('working')}</th>
            <th>{t('branch')}</th>
            <th>{t('start')}</th>
            <th>{t('end')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.dayOfWeek}>
              <td>{t(`day${r.dayOfWeek}`)}</td>
              <td>
                <input
                  type="checkbox"
                  aria-label={`${t(`day${r.dayOfWeek}`)} ${t('working')}`}
                  checked={r.working}
                  onChange={(e) => update(i, { working: e.target.checked })}
                />
              </td>
              <td>
                <select
                  aria-label={`${t(`day${r.dayOfWeek}`)} ${t('branch')}`}
                  value={r.branchId}
                  disabled={!r.working}
                  onChange={(e) => update(i, { branchId: e.target.value })}
                >
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  type="time"
                  aria-label={`${t(`day${r.dayOfWeek}`)} ${t('start')}`}
                  value={r.start}
                  disabled={!r.working}
                  onChange={(e) => update(i, { start: e.target.value })}
                />
              </td>
              <td>
                <input
                  type="time"
                  aria-label={`${t(`day${r.dayOfWeek}`)} ${t('end')}`}
                  value={r.end}
                  disabled={!r.working}
                  onChange={(e) => update(i, { end: e.target.value })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={handleSave} disabled={saving || rows.length === 0}>
        {t('saveWeek')}
      </button>
    </section>
  );
}
```

- [ ] **Step 3: Create `SkillsEditor.tsx`**

```tsx
// apps/staff/app/settings/barbers/[id]/SkillsEditor.tsx
// Which of the home branch's services this barber can perform (barber_skills). A barber with no
// skills is never assigned customers, so the screen warns when none are ticked.
'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';

interface ServiceOption {
  serviceId: string;
  name: string;
}

export default function SkillsEditor({
  barberId,
  homeBranchId,
}: {
  barberId: string;
  homeBranchId: string;
}) {
  const t = useTranslations('BarberDetail');
  const supabase = createBrowserSupabaseClient();
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [persisted, setPersisted] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      supabase
        .from('branch_services')
        .select('service_id, services(name)')
        .eq('branch_id', homeBranchId),
      supabase.from('barber_skills').select('service_id').eq('barber_id', barberId),
    ]).then(([{ data: bsRows, error: bsError }, { data: skillRows, error: skillError }]) => {
      if (cancelled) return;
      if (bsError || skillError) {
        setError(t('loadFailed'));
        return;
      }
      setServices(
        (bsRows ?? []).map((bs) => ({
          serviceId: bs.service_id,
          name: (bs.services as unknown as { name: string } | null)?.name ?? '',
        })),
      );
      const current = new Set((skillRows ?? []).map((s) => s.service_id));
      setSelected(new Set(current));
      setPersisted(current);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barberId, homeBranchId]);

  function toggle(serviceId: string, checked: boolean) {
    setSavedMessage(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(serviceId);
      else next.delete(serviceId);
      return next;
    });
  }

  async function handleSave() {
    setError(null);
    setSavedMessage(false);
    const added = [...selected].filter((id) => !persisted.has(id));
    const removed = [...persisted].filter((id) => !selected.has(id));
    if (added.length > 0) {
      const { error: insertError } = await supabase
        .from('barber_skills')
        .insert(added.map((service_id) => ({ barber_id: barberId, service_id })));
      if (insertError) {
        setError(t('saveFailed'));
        return;
      }
    }
    if (removed.length > 0) {
      const { error: deleteError } = await supabase
        .from('barber_skills')
        .delete()
        .eq('barber_id', barberId)
        .in('service_id', removed);
      if (deleteError) {
        setError(t('saveFailed'));
        return;
      }
    }
    setPersisted(new Set(selected));
    setSavedMessage(true);
  }

  return (
    <section>
      <h2>{t('skillsTitle')}</h2>
      {error && <p role="alert">{error}</p>}
      {savedMessage && <p role="status">{t('skillsSaved')}</p>}
      {loaded && services.length === 0 && <p>{t('noServices')}</p>}
      {loaded && services.length > 0 && selected.size === 0 && (
        <p role="alert">{t('noSkillsWarning')}</p>
      )}
      <ul>
        {services.map((s) => (
          <li key={s.serviceId}>
            <label>
              <input
                type="checkbox"
                checked={selected.has(s.serviceId)}
                onChange={(e) => toggle(s.serviceId, e.target.checked)}
              />
              {s.name}
            </label>
          </li>
        ))}
      </ul>
      <button type="button" onClick={handleSave} disabled={!loaded}>
        {t('saveSkills')}
      </button>
    </section>
  );
}
```

- [ ] **Step 4: Create the detail page**

```tsx
// apps/staff/app/settings/barbers/[id]/page.tsx
// Barber detail (App Flow 8.9): regular week, the next 4 weeks, and skills. The barber is looked
// up through list_manageable_barbers(), so a barber the caller can't manage simply isn't found.
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';
import { loadManageableBranches, type ManageableBranch } from '../scope';
import RegularWeek from './RegularWeek';
import SkillsEditor from './SkillsEditor';

type ManageableBarber =
  Database['public']['Functions']['list_manageable_barbers']['Returns'][number];

export default function BarberDetailPage() {
  const t = useTranslations('BarberDetail');
  const params = useParams<{ id: string }>();
  const supabase = createBrowserSupabaseClient();
  const [barber, setBarber] = useState<ManageableBarber | null>(null);
  const [branches, setBranches] = useState<ManageableBranch[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([supabase.rpc('list_manageable_barbers'), loadManageableBranches(supabase)]).then(
      ([{ data }, manageable]) => {
        if (cancelled) return;
        setBarber((data ?? []).find((b) => b.barber_id === params.id) ?? null);
        setBranches(manageable);
        setLoaded(true);
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  if (!loaded) return null;
  if (!barber) {
    return (
      <main>
        <p role="alert">{t('notFound')}</p>
        <Link href="/settings/barbers">{t('backToList')}</Link>
      </main>
    );
  }

  // refreshKey is consumed by UpcomingDays in Task 5; referenced here so lint doesn't flag it.
  void refreshKey;

  return (
    <main>
      <Link href="/settings/barbers">{t('backToList')}</Link>
      <h1>{barber.name}</h1>
      <p>{t('homeBranch', { branch: barber.home_branch_name })}</p>
      <RegularWeek
        barberId={barber.barber_id}
        homeBranchId={barber.home_branch_id}
        branches={branches}
        onSaved={() => setRefreshKey((k) => k + 1)}
      />
      <SkillsEditor barberId={barber.barber_id} homeBranchId={barber.home_branch_id} />
    </main>
  );
}
```

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck` and `cd apps/staff && npx next build` — Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add "apps/staff/app/settings/barbers/[id]" apps/staff/messages/en.json
git commit -m "feat: add barber detail screen with regular week and skills"
```

---

### Task 5: Barber detail screen — the next 4 weeks

**Files:**
- Create: `apps/staff/app/settings/barbers/[id]/UpcomingDays.tsx`
- Modify: `apps/staff/app/settings/barbers/[id]/page.tsx`
- Modify: `apps/staff/messages/en.json`

**Interfaces:**
- Consumes: `refreshKey` from the page (Task 4); `ManageableBranch` (Task 3); `barber_schedule`
  with `is_manual` and `barber_days_off` (Task 1); `reset_barber_schedule_day` (Task 2).

- [ ] **Step 1: Add translation keys**

In `"BarberDetail"`, add:

```json
    "upcomingTitle": "Next 4 weeks",
    "dayOff": "Day off",
    "notWorking": "Not working",
    "changedByHand": "Changed by hand",
    "otherBranch": "Another branch",
    "editDay": "Change hours",
    "saveDay": "Save day",
    "cancel": "Cancel",
    "markDayOff": "Mark day off",
    "resetDay": "Reset to regular week",
    "dayOffTicketsWarning": "This barber has {count} customer(s) in their queue today. Marking today off won't move them to another barber. Continue?"
```

- [ ] **Step 2: Create `UpcomingDays.tsx`**

```tsx
// apps/staff/app/settings/barbers/[id]/UpcomingDays.tsx
// What each of the next 28 days will actually be for this barber, with per-day changes: edit
// hours/branch (a hand-edited row the refill never overwrites), mark a day off, or reset the day
// back to the regular week.
'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';
import type { ManageableBranch } from '../scope';

type ScheduleRow = Database['public']['Tables']['barber_schedule']['Row'];

const ACTIVE_STATES = ['waiting', 'almost_turn', 'called', 'confirmed', 'in_service'] as const;
const WINDOW_DAYS = 28;

function upcomingDates(): string[] {
  const now = new Date();
  return Array.from({ length: WINDOW_DAYS }, (_, i) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + i))
      .toISOString()
      .slice(0, 10),
  );
}

interface EditState {
  date: string;
  branchId: string;
  start: string;
  end: string;
}

export default function UpcomingDays({
  barberId,
  homeBranchId,
  branches,
  refreshKey,
}: {
  barberId: string;
  homeBranchId: string;
  branches: ManageableBranch[];
  refreshKey: number;
}) {
  const t = useTranslations('BarberDetail');
  const supabase = createBrowserSupabaseClient();
  const [dates] = useState(upcomingDates);
  const [rowsByDate, setRowsByDate] = useState<Map<string, ScheduleRow>>(new Map());
  const [daysOff, setDaysOff] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<EditState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const first = dates[0];
    const last = dates[dates.length - 1];
    Promise.all([
      supabase
        .from('barber_schedule')
        .select('*')
        .eq('barber_id', barberId)
        .gte('work_date', first)
        .lte('work_date', last),
      supabase
        .from('barber_days_off')
        .select('off_date')
        .eq('barber_id', barberId)
        .gte('off_date', first)
        .lte('off_date', last),
    ]).then(([{ data: schedule, error: scheduleError }, { data: off, error: offError }]) => {
      if (cancelled) return;
      if (scheduleError || offError) {
        setError(t('loadFailed'));
        return;
      }
      setRowsByDate(new Map((schedule ?? []).map((r) => [r.work_date, r])));
      setDaysOff(new Set((off ?? []).map((o) => o.off_date)));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barberId, refreshKey, reloadTick]);

  const reload = () => setReloadTick((n) => n + 1);
  const branchName = (id: string) => branches.find((b) => b.id === id)?.name ?? t('otherBranch');

  function startEdit(date: string) {
    const row = rowsByDate.get(date);
    setError(null);
    setEditing({
      date,
      branchId: row?.branch_id ?? homeBranchId,
      start: row?.shift_start.slice(0, 5) ?? '09:00',
      end: row?.shift_end.slice(0, 5) ?? '18:00',
    });
  }

  async function saveEdit() {
    if (!editing) return;
    setError(null);
    if (editing.end <= editing.start) {
      setError(t('endBeforeStart'));
      return;
    }
    const { error: upsertError } = await supabase.from('barber_schedule').upsert(
      {
        barber_id: barberId,
        work_date: editing.date,
        branch_id: editing.branchId,
        shift_start: editing.start,
        shift_end: editing.end,
        is_manual: true,
      },
      { onConflict: 'barber_id,work_date' },
    );
    if (upsertError) {
      setError(t('saveFailed'));
      return;
    }
    setEditing(null);
    reload();
  }

  async function markDayOff(date: string) {
    setError(null);
    // Tickets are same-day, so only today can have customers queued for this barber.
    if (date === dates[0]) {
      const { count } = await supabase
        .from('queue_tickets')
        .select('id', { count: 'exact', head: true })
        .eq('assigned_barber_id', barberId)
        .in('state', ACTIVE_STATES);
      if ((count ?? 0) > 0 && !window.confirm(t('dayOffTicketsWarning', { count: count ?? 0 }))) {
        return;
      }
    }
    const { error: insertError } = await supabase
      .from('barber_days_off')
      .insert({ barber_id: barberId, off_date: date });
    if (insertError) {
      setError(t('saveFailed'));
      return;
    }
    reload();
  }

  async function resetDay(date: string) {
    setError(null);
    const { error: resetError } = await supabase.rpc('reset_barber_schedule_day', {
      p_barber_id: barberId,
      p_date: date,
    });
    if (resetError) {
      setError(t('saveFailed'));
      return;
    }
    reload();
  }

  return (
    <section>
      <h2>{t('upcomingTitle')}</h2>
      {error && <p role="alert">{error}</p>}
      <ul>
        {dates.map((date) => {
          const row = rowsByDate.get(date);
          const off = daysOff.has(date);
          const weekdayKey = `day${new Date(`${date}T00:00:00Z`).getUTCDay()}`;
          return (
            <li key={date}>
              <span>
                {t(weekdayKey)} {date}:{' '}
              </span>
              {off ? (
                <span>{t('dayOff')}</span>
              ) : row ? (
                <span>
                  {row.shift_start.slice(0, 5)}–{row.shift_end.slice(0, 5)} ({branchName(row.branch_id)})
                  {row.is_manual && <em> {t('changedByHand')}</em>}
                </span>
              ) : (
                <span>{t('notWorking')}</span>
              )}

              {editing?.date === date ? (
                <span>
                  <select
                    aria-label={t('branch')}
                    value={editing.branchId}
                    onChange={(e) => setEditing({ ...editing, branchId: e.target.value })}
                  >
                    {branches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="time"
                    aria-label={t('start')}
                    value={editing.start}
                    onChange={(e) => setEditing({ ...editing, start: e.target.value })}
                  />
                  <input
                    type="time"
                    aria-label={t('end')}
                    value={editing.end}
                    onChange={(e) => setEditing({ ...editing, end: e.target.value })}
                  />
                  <button type="button" onClick={saveEdit}>
                    {t('saveDay')}
                  </button>
                  <button type="button" onClick={() => setEditing(null)}>
                    {t('cancel')}
                  </button>
                </span>
              ) : (
                <span>
                  {!off && (
                    <button type="button" onClick={() => startEdit(date)}>
                      {t('editDay')}
                    </button>
                  )}
                  {!off && (
                    <button type="button" onClick={() => markDayOff(date)}>
                      {t('markDayOff')}
                    </button>
                  )}
                  {(off || row?.is_manual) && (
                    <button type="button" onClick={() => resetDay(date)}>
                      {t('resetDay')}
                    </button>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
```

- [ ] **Step 3: Wire it into the page**

In `apps/staff/app/settings/barbers/[id]/page.tsx`: add `import UpcomingDays from './UpcomingDays';`,
delete the `void refreshKey;` line and its comment, and render between `<RegularWeek ... />` and
`<SkillsEditor ... />`:

```tsx
      <UpcomingDays
        barberId={barber.barber_id}
        homeBranchId={barber.home_branch_id}
        branches={branches}
        refreshKey={refreshKey}
      />
```

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck` and `cd apps/staff && npx next build` — Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add "apps/staff/app/settings/barbers/[id]" apps/staff/messages/en.json
git commit -m "feat: add next-4-weeks day editing to the barber detail screen"
```

---

### Task 6: End-to-end — a manager's schedule makes a customer's join land on that barber

**Files:**
- Create: `e2e/barbers-management-journey.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5, running in the real staff (`http://localhost:3001`) and
  customer (`http://localhost:3000`) apps.

- [ ] **Step 1: Write the e2e test**

Create `e2e/barbers-management-journey.spec.ts`:

```typescript
// e2e/barbers-management-journey.spec.ts
// A Branch Manager sets a barber's regular week and skills on screen; a customer then joins that
// branch and the ticket is assigned to that barber. The barber starts with NO schedule and NO
// skills, so the join can only succeed through what the manager did in the UI.
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const STAFF_BASE_URL = 'http://localhost:3001';
const CUSTOMER_BASE_URL = 'http://localhost:3000';
const PASSWORD = 'Test-Password-123!';

// Same cookie-seeding convention as e2e/barber-assignment-journey.spec.ts.
async function seedCookie(
  context: import('@playwright/test').BrowserContext,
  baseUrl: string,
  session: unknown,
) {
  const projectRef = new URL(url).hostname.split('.')[0];
  const cookieName = `sb-${projectRef}-auth-token`;
  const cookieValue =
    'base64-' +
    Buffer.from(JSON.stringify(session), 'utf-8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  await context.addCookies([{ name: cookieName, value: cookieValue, url: baseUrl }]);
}

test.describe('barbers management journey', () => {
  test.skip(!url || !serviceRoleKey, 'Supabase env vars not set');

  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const suffix = `${Date.now()}`;

  let branchId: string;
  let managerAuthUserId: string;
  let managerStaffUserId: string;
  let managerEmail: string;
  let barberAuthUserId: string;
  let barberStaffUserId: string;
  let barberId: string;
  let barberName: string;
  let customerAuthUserId: string;
  let customerId: string;
  let customerPhone: string;
  let ticketId: string | undefined;

  test.beforeAll(async () => {
    const { data: business } = await admin.from('businesses').select('id').limit(1).single();
    const { data: service } = await admin.from('services').select('id').limit(1).single();

    const { data: branch } = await admin
      .from('branches')
      .insert({
        business_id: business!.id,
        name: `BMJ Branch ${suffix}`,
        branch_code: `BMJ${suffix.slice(-6)}`,
        address: 'Test',
        latitude: 5.6,
        longitude: -0.18,
      })
      .select()
      .single();
    branchId = branch!.id;
    // Open all day every day: tickets-join refuses customer joins to a closed branch.
    await admin.from('branch_hours').insert(
      [0, 1, 2, 3, 4, 5, 6].map((day_of_week) => ({
        branch_id: branchId,
        day_of_week,
        opens_at: '00:00:00',
        closes_at: '23:59:59',
        is_closed: false,
      })),
    );
    await admin.from('branch_services').insert({ branch_id: branchId, service_id: service!.id });

    managerEmail = `bmj-mgr-${suffix}@test.pixelbarber.local`;
    const { data: mgrAuth } = await admin.auth.admin.createUser({
      email: managerEmail,
      password: PASSWORD,
      email_confirm: true,
    });
    managerAuthUserId = mgrAuth!.user.id;
    const { data: mgrStaff } = await admin
      .from('staff_users')
      .insert({
        auth_user_id: managerAuthUserId,
        name: `BMJ Manager ${suffix}`,
        email: managerEmail,
        role: 'branch_manager',
        invite_status: 'accepted',
      })
      .select()
      .single();
    managerStaffUserId = mgrStaff!.id;
    await admin
      .from('staff_branch_assignments')
      .insert({ staff_user_id: managerStaffUserId, branch_id: branchId });

    const barberEmail = `bmj-barber-${suffix}@test.pixelbarber.local`;
    barberName = `BMJ Barber ${suffix}`;
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
        name: barberName,
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

    customerPhone = `+233${suffix.slice(-9)}`;
    const { data: customerAuth } = await admin.auth.admin.createUser({
      phone: customerPhone,
      password: PASSWORD,
      phone_confirm: true,
    });
    customerAuthUserId = customerAuth!.user.id;
    const { data: customer } = await admin
      .from('customers')
      .insert({ auth_user_id: customerAuthUserId, name: `BMJ Customer ${suffix}`, phone_e164: customerPhone })
      .select()
      .single();
    customerId = customer!.id;
  }, 60000);

  test.afterAll(async () => {
    if (ticketId) {
      await admin.from('queue_events').delete().eq('ticket_id', ticketId);
      await admin.from('notifications').delete().eq('related_ticket_id', ticketId);
      await admin.from('queue_tickets').delete().eq('id', ticketId);
    }
    await admin.from('customers').delete().eq('id', customerId);
    await admin.from('barber_days_off').delete().eq('barber_id', barberId);
    await admin.from('barber_weekly_hours').delete().eq('barber_id', barberId);
    await admin.from('barber_schedule').delete().eq('barber_id', barberId);
    await admin.from('barber_skills').delete().eq('barber_id', barberId);
    await admin.from('staff_branch_assignments').delete().eq('staff_user_id', managerStaffUserId);
    await admin.from('staff_users').delete().in('id', [managerStaffUserId, barberStaffUserId]);
    for (const authId of [managerAuthUserId, barberAuthUserId, customerAuthUserId]) {
      await admin.auth.admin.deleteUser(authId);
    }
    // next_ticket_number upserts branch_ticket_counters, which has no cascade to branches.
    await admin.from('branch_ticket_counters').delete().eq('branch_id', branchId);
    await admin.from('branches').delete().eq('id', branchId);
  }, 60000);

  test('manager schedules a barber on screen, then a customer is assigned to them', async ({
    browser,
  }) => {
    test.setTimeout(180_000);

    // --- Manager sets the barber's regular week and skills ---
    const staffContext = await browser.newContext();
    const staffPage = await staffContext.newPage();
    await staffPage.goto(`${STAFF_BASE_URL}/login`);
    await staffPage.getByPlaceholder('Email').fill(managerEmail);
    await staffPage.getByPlaceholder('Password').fill(PASSWORD);
    await staffPage.getByRole('button', { name: 'Log In' }).press('Enter');
    await staffPage.waitForURL(/\/tickets/, { timeout: 15000 });

    await staffPage.goto(`${STAFF_BASE_URL}/settings/barbers/${barberId}`);
    await expect(staffPage.getByRole('heading', { name: barberName })).toBeVisible({ timeout: 15000 });

    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) {
      await staffPage.getByLabel(`${day} Working`).check();
      await staffPage.getByLabel(`${day} Start`).fill('00:00');
      await staffPage.getByLabel(`${day} End`).fill('23:59');
    }
    await staffPage.getByRole('button', { name: 'Save regular week' }).press('Enter');
    await expect(staffPage.getByText('Regular week saved.', { exact: false })).toBeVisible({
      timeout: 15000,
    });

    const skills = staffPage.locator('section', {
      has: staffPage.getByRole('heading', { name: 'Skills' }),
    });
    await skills.getByRole('checkbox').first().check();
    await skills.getByRole('button', { name: 'Save skills' }).press('Enter');
    await expect(staffPage.getByText('Skills saved.')).toBeVisible({ timeout: 15000 });
    await staffContext.close();

    // The UI's saves really produced a dated row for today.
    const today = new Date().toISOString().slice(0, 10);
    const { data: todayRow } = await admin
      .from('barber_schedule')
      .select('work_date')
      .eq('barber_id', barberId)
      .eq('work_date', today)
      .maybeSingle();
    expect(todayRow).not.toBeNull();

    // --- Customer joins with "Any available" ---
    const customerContext = await browser.newContext();
    const { data: customerSession } = await createClient<Database>(url, anonKey).auth.signInWithPassword({
      phone: customerPhone,
      password: PASSWORD,
    });
    await seedCookie(customerContext, CUSTOMER_BASE_URL, customerSession.session);
    const customerPage = await customerContext.newPage();
    await customerPage.goto(`${CUSTOMER_BASE_URL}/book?branch=${branchId}`);
    // Scoped to <main> and using Enter: Next.js dev mode's Dev Tools badge sits outside <main>
    // and intercepts pointer clicks (see e2e/barber-assignment-journey.spec.ts).
    await customerPage.locator('main').getByRole('button').first().press('Enter');
    await customerPage.getByRole('button', { name: 'Any available' }).press('Enter');
    await customerPage.getByRole('button', { name: 'Join Now' }).press('Enter');
    await customerPage.waitForURL(/\/tickets\//, { timeout: 15000 });

    const { data: ticket } = await admin
      .from('queue_tickets')
      .select('id, assigned_barber_id')
      .eq('customer_id', customerId)
      .not('state', 'in', '(completed,cancelled,no_show)')
      .single();
    ticketId = ticket!.id;
    expect(ticket!.assigned_barber_id).toBe(barberId);
    await customerContext.close();
  });
});
```

Note for the implementer: verify against the real `apps/staff/app/login/page.tsx` that a
`branch_manager` lands on `/tickets` after login (barbers go to `/queue/today`). If a selector
doesn't match the rendered markup, correct the selector against the real page — never loosen the
final `assigned_barber_id` assertion.

- [ ] **Step 2: Run it**

Run: `npx playwright test e2e/barbers-management-journey.spec.ts`
Expected: PASS (requires Tasks 1–2 migrations pushed by the controller).

- [ ] **Step 3: Run the full e2e suite**

Run: `npm run test:e2e`
Expected: no new failures beyond the known pre-existing `e2e/queue-join-now.spec.ts` failure.

- [ ] **Step 4: Commit**

```bash
git add e2e/barbers-management-journey.spec.ts
git commit -m "test: manager-set schedule makes a customer join land on that barber"
```

---

## Self-Review

**Spec coverage:**
- Decisions 1–2 (weekly pattern, materialized, assignment untouched) → Tasks 1–2.
- Decision 3 (28-day window, nightly + on change) → Task 2 (fill function, triggers, cron).
- Decision 4 (hand-edited protected, past untouched) → Task 2, tested.
- Decision 5 (skills tick-list) → Task 4 `SkillsEditor`.
- Decision 6 (permissions) → Task 1 RLS + `list_manageable_barbers`; Task 2
  `reset_barber_schedule_day` checks; tested including the "name your own branch" attack and the
  out-of-scope work branch.
- Screens: list (Task 3), detail regular week + skills (Task 4), next 4 weeks (Task 5).
- Error handling: end-before-start (DB check Task 1, UI Tasks 4–5), day off beats manual (Task 2
  test), today's-tickets warning (Task 5), visible save errors (Tasks 3–5), inactive staff (Task 2).
- Testing: fill rules and permissions (Tasks 1–2), production unblocker (Task 2), e2e (Task 6).
- Spec corrections 1–4 → Tasks 1, 2, 1, 5 respectively.

**Placeholder scan:** none — every code step contains its code.

**Type consistency:** `list_manageable_barbers` row fields (`barber_id`, `staff_user_id`, `name`,
`status`, `home_branch_id`, `home_branch_name`) are identical in the SQL, the types, and their uses
(Tasks 3–4). `ManageableBranch { id, name }` is defined once (Task 3) and imported in Tasks 4–5.
`reset_barber_schedule_day(p_barber_id, p_date)` matches between SQL, types and the Task 5 call.
`refreshKey` is produced in Task 4 and consumed in Task 5.
