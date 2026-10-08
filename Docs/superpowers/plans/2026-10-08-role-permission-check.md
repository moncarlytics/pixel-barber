# Role and Permission Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One declarative permission matrix, exercised for every role against every public table and callable function on staging, with a coverage guard; the clear gaps it confirms are fixed; judgment calls are recorded for the user.

**Architecture:** `tests/db/rbac/` holds a shared fixture (two branches, one login per role), the matrix (intended access per role, with an explicit `currently` override and `gap` id wherever today's behaviour differs), and three runners (table reads, table writes, functions) plus a coverage test. Runners assert `currently ?? expect`, so the suite is green while every known gap is listed by id; a gap snapshot test fails if a gap appears or disappears without the matrix saying so. Fix migrations then delete the overrides.

**Tech Stack:** Supabase Postgres RLS + security definer functions, supabase-js, Vitest, Playwright.

**Spec:** `Docs/superpowers/specs/2026-10-08-role-permission-check-design.md`

## Global Constraints

- Roles under test (exact keys): `anon`, `customer`, `barber`, `receptionist`, `manager`, `analyst`, `owner`, `otherManager`. Branch A = the fixture's Main branch; branch B = its Closed branch. `manager`, `receptionist`, `analyst` and `barber` belong to A; `otherManager` to B; `owner` sees both; `customer` is customer 0 (visits A).
- Read scopes (exact): `none` | `own` | `branch` | `all`. `branch` means the role's own branch rows only (A for A roles, B for `otherManager`); `all` means A and B (and own) rows.
- Write expectations (exact): `deny` | `own` | `branch` | `all`.
- Function outcomes (exact): `allow` (returns without error) | `deny` (errors) | `empty` (no error, but returns no rows / `0` / `null` / `[]`) | `internal` (not meaningfully callable; not exercised).
- Every matrix entry carries `why` (one line: PRD row or capability). Where today's behaviour differs from the intended `expect`, the entry also carries `currently` (today's behaviour) and `gap` (a stable id, e.g. `G-consents-scope`). Runners assert `currently ?? expect`.
- Judgment calls are recorded with `currently` and `gap` ids starting `J-` and `why: 'pending user decision'`; clear gaps use ids starting `G-`.
- Never weaken an `expect` to make a test pass. If observed behaviour differs from a planned `expect` or `currently`, set `currently` to what you observed, give it a new gap id, and list it in your report.
- Every fix is a new migration (applied migrations are never edited); every new SQL function is `security definer`, `set search_path = public, pg_temp`, with explicit revoke/grant.
- **Implementer subagents cannot push migrations, deploy functions or run SQL against a live project.** Tests run against staging (read/write through supabase-js only). The controller pushes migrations (`set -a && source supabase/.secrets/send-sms.env && set +a && npx supabase db push`). Report "ready for push".
- Test cleanup throws on failure, deletes in FK-safe order, and removes every row it created (including staff_message notifications by recipient). Customers come from the existing fixture only (`+233558…`).
- The repo has `noUncheckedIndexedAccess` on; run root `npm run typecheck`. DB tests: `npx vitest run tests/db/rbac` (staging; on a login rate-limit failure wait a minute and re-run).
- Do NOT kill node processes. Never read supabase/.secrets/*. Do not stage `apps/*/next-env.d.ts`, `graphify-out/`, `playwright-report/`, `test-results/`, `supabase/.secrets/`, untracked `Docs/superpowers/plans/2026-09-1*`. No AI-attribution lines in commits. Commit on main.
- After editing any file containing `—`, `–`, `·` or `•`, `grep -n $'\xef\xbf\xbd' <file>` must print nothing.

## Rulings made while planning

1. **Gap overrides keep the suite green.** Entries record intended access (`expect`) and today's (`currently`); a snapshot test pins the exact set of open gap ids, so a new leak or an unannounced fix fails the build.
2. **Known clear gaps (from reading the live policies) start pre-marked:** `G-consents-scope` (staff read every customer's consents business-wide), `G-ticket-delete` (`edit_tickets` holders can DELETE tickets), `G-session-delete` (barbers/staff can DELETE service sessions), `G-barbers-insert-delete` (`manage_barber_schedules` holders can INSERT/DELETE barber rows — creating/removing barbers is staff management, owner only).
3. **Known judgment calls start pre-marked:** `J-staff-users-read` (colleague staff rows readable by branch staff), `J-staff-assignments-read`, `J-services-catalog-write` (branch managers write the business-wide `services` catalog), `J-anon-barbers-read` (anyone can read barber rows), `J-link-customer-anon` (`link_or_create_customer` executable by anon), `J-link-customer-staff` (whether a staff login can call it).
4. **Functions that hide data instead of erroring** (e.g. `list_unseen_low_feedback_count` returns 0 for non-escalation roles) use the `empty` outcome; that is not a gap.
5. **Public availability functions** (`list_bookable_barbers`, `list_appointment_slots`, `preview_wait_estimate`, `find_eligible_barber`) are intended `allow` for every authenticated role — they expose scheduling, not personal data.
6. **Mutating functions** get a fresh target row per allowed call (the args builder may create rows with the admin client), so call order can't change outcomes.
7. **The function coverage guard needs a catalogue helper** (`rbac_callable_functions`, service role only), added in Task 3 as its own migration.

## File Structure

| File | Responsibility |
|---|---|
| `tests/db/rbac/types.ts` | matrix types, `OPEN_GAPS` |
| `tests/db/rbac/fixture.ts` | two branches, one login per role, fixture rows per table, cleanup |
| `tests/db/rbac/tables.ts` | table read and write matrix |
| `tests/db/rbac/functions.ts` | function matrix (args builders + outcomes) |
| `tests/db/rbac/reads.test.ts`, `writes.test.ts`, `functions.test.ts`, `coverage.test.ts` | runners and guards |
| `supabase/migrations/20261008115900_rbac_callable_functions.sql` | catalogue helper for the coverage guard |
| `supabase/migrations/20261008120000_rbac_clear_gaps.sql` | fixes for the confirmed clear gaps |
| `e2e/staff-roles.spec.ts` | light screen check per staff role |

---

### Task 1: Fixture, matrix types, table reads and the table coverage guard

**Files:**
- Create: `tests/db/rbac/types.ts`, `tests/db/rbac/fixture.ts`, `tests/db/rbac/tables.ts`, `tests/db/rbac/reads.test.ts`, `tests/db/rbac/coverage.test.ts`

**Interfaces:**
- Consumes: `tests/db/fixtures/appointments.ts` (`createAppointmentFixture`, `createStaffLogin(f, label, 'branch_manager' | 'receptionist' | 'analyst', branchIds)`, `cleanupStaffLogin`, `cleanupAppointmentFixture`, `dateAt`, `PASSWORD`, `Client`).
- Produces: `RbacFixture`, `createRbacFixture()`, `cleanupRbacFixture(f)`, `ROLES`, `TABLES: TableEntry[]`, and the types in `types.ts` used by Tasks 2–3.

- [ ] **Step 1: Write the types**

Create `tests/db/rbac/types.ts`:
```typescript
// tests/db/rbac/types.ts
// The permission matrix's vocabulary (Docs/superpowers/specs/2026-10-08-role-permission-check-design.md).
export const ROLES = [
  'anon',
  'customer',
  'barber',
  'receptionist',
  'manager',
  'analyst',
  'owner',
  'otherManager',
] as const;
export type Role = (typeof ROLES)[number];

export type ReadScope = 'none' | 'own' | 'branch' | 'all';
export type WriteScope = 'deny' | 'own' | 'branch' | 'all';
export type Outcome = 'allow' | 'deny' | 'empty' | 'internal';

/** One expectation: intended access, today's access when it differs, and why. */
export interface Expect<T> {
  expect: T;
  currently?: T;
  /** Stable id: G-… for clear gaps (to fix), J-… for judgment calls (pending the user). */
  gap?: string;
  why: string;
}

export type PerRole<T> = Record<Role, Expect<T>>;

/** Fixture row ids for one table: rows at branch A, at branch B, and the row(s) "own" means. */
export interface RowSet {
  a: string[];
  b: string[];
  /** Rows owned by the customer or barber login (subset of a or b). */
  own: string[];
}

export interface TableEntry {
  table: string;
  /** Column holding the row identity used in RowSet (usually 'id'). */
  key: string;
  read: PerRole<ReadScope>;
}

/** The value a runner asserts. */
export const effective = <T>(e: Expect<T>): T => e.currently ?? e.expect;
```

- [ ] **Step 2: Write the fixture**

Create `tests/db/rbac/fixture.ts`. It builds on `createAppointmentFixture()` (branch A = `branchId`, branch B = `closedBranchId`, barbers A and B both based at A, customers 0–3, `barberClient` signed in as barber A) and adds:
- an owner login (staff_users role `owner`, `invite_status: 'accepted'`, no branch assignment) — create it with the admin client like `createSignedInStaff` in `tests/db/fixtures/staff-invite.ts` and sign in with `PASSWORD`;
- `manager`, `receptionist`, `analyst` at A and `otherManager` at B via `createStaffLogin`;
- a barber C based at B (staff_users role `barber`, barbers row `home_branch_id = closedBranchId`, skilled for `serviceId`, one `barber_schedule` row for today at B);
- an anonymous client (`createClient<Database>(url, anonKey)` with no sign-in);
- fixture rows, recording ids in `rows[table]: RowSet`:
  - `queue_tickets`: tA (customer 0, A, barber A, completed), tB (customer 1, B, barber C, completed); own = [tA] (it is both the customer's and barber A's own).
  - `appointments`: aA (customer 0, A, scheduled 2 days ahead), aB (customer 1, B); own = [aA].
  - `feedback`: on tA (customer 0) and tB (customer 1); own = [the tA feedback].
  - `queue_events`: one per ticket (admin insert, `event_type: 'rbac_probe'`, `actor_type: 'system'`); own = [tA's event].
  - `notifications`: one `staff_message` per customer (customer 0 with payload branch A; customer 1 with branch B); own = [customer 0's].
  - `service_sessions`: one per ticket with the ticket's barber (read the table's required columns in `supabase/migrations/20260911210800_service_sessions.sql`); own = [tA's session].
  - `barber_schedule`: barber A's row for today (from the base fixture) and barber C's row; own = [barber A's].
  - `barber_weekly_hours`, `barber_days_off`: one row each for barber A (at A) and barber C (at B); own = barber A's.
  - `barber_service_stats`: one row each for barber A and barber C (admin insert; read required columns from the migrations); own = [].
  - `barber_skills`: key `barber_id`; a = [barber A], b = [barber C]; own = [barber A] (only used where a scope says `own`).
  - `consents`: one `marketing` row each for customer 0 and customer 1; own = [customer 0's].
  - `push_subscriptions`: one each for customer 0 and customer 1 (distinct `https://push.example/rbac-…` endpoints); own = [customer 0's].
  - `customers`: key `id`; a = [customer 0], b = [customer 1]; own = [customer 0].
  - `audit_log`: one row (admin insert, `actor_type: 'system'`, `action: 'rbac_probe'`, `entity_type: 'branch'`, `entity_id: branch A`, `result: 'success'`); a = [that row], b = [], own = [].
  - Public catalogue tables: `branches` (a = [A], b = [B]), `branch_hours` (the branch's hour rows), `branch_closures` (add one closure per branch 30 days ahead), `branch_services` (each branch's service row), `branch_service_prices` (add one price per branch service), `services` (a = [fixture service], b = []), `businesses` (a = [the business id], b = []), `capabilities` (key `key`, a = ['view_customers']), `role_capabilities` (key `capability`, a = ['view_customers']).
  - `staff_users`: a = [manager, receptionist, analyst, barber A staff ids], b = [otherManager, barber C staff ids], own = [].
  - `staff_branch_assignments`: key `staff_user_id`; a = [manager, receptionist, analyst], b = [otherManager], own = [].
  - `branch_ticket_counters`: key `branch_id`; whatever rows exist for A/B after the ticket inserts (admin select), else empty sets.
  - Views: `branch_status_view` key `branch_id` (a = [A], b = [B]); `current_branch_service_price` key `branch_service_id` (each branch's service); `customer_segments` key `customer_id` (a = [customer 0], b = [customer 1], own = [customer 0]).

Exports:
```typescript
export interface RbacFixture {
  base: AppointmentFixture;
  admin: Client;
  clients: Record<Role, Client>;
  staffIds: Partial<Record<Role, string>>;
  barberC: { barberId: string; staffUserId: string; authUserId: string };
  rows: Record<string, RowSet>;
}
export async function createRbacFixture(): Promise<RbacFixture>;
export async function cleanupRbacFixture(f: RbacFixture): Promise<void>;
```
`clients.barber` is `base.barberClient`; `clients.customer` is customer 0's client. `cleanupRbacFixture` deletes, in FK-safe order and throwing on any error: staff_message notifications by recipient, push_subscriptions, consents, the audit_log probe row, service_sessions, queue_events, feedback, barber_service_stats, barber C's barber_days_off/weekly_hours/schedule/skills, barber A's added days_off/weekly_hours rows, barber C's barbers + staff_users + auth user, the owner (staff_users + auth user), then `cleanupStaffLogin` for the four logins, then `cleanupAppointmentFixture(f.base)` (which removes tickets, appointments, branches, services, customers). Add branch closures and prices to the deletions before `cleanupAppointmentFixture` if that function doesn't already remove them.

- [ ] **Step 3: Write the table read matrix**

Create `tests/db/rbac/tables.ts` exporting `TABLES: TableEntry[]`, using small helpers:
```typescript
import { ROLES, type Expect, type PerRole, type ReadScope, type Role, type TableEntry } from './types';

const e = <T>(expect: T, why: string, extra: Partial<Expect<T>> = {}): Expect<T> => ({ expect, why, ...extra });
const everyone = (scope: ReadScope, why: string): PerRole<ReadScope> =>
  Object.fromEntries(ROLES.map((r) => [r, e(scope, why)])) as PerRole<ReadScope>;
const byRole = (
  scopes: [ReadScope, ReadScope, ReadScope, ReadScope, ReadScope, ReadScope, ReadScope, ReadScope],
  why: string,
): PerRole<ReadScope> => Object.fromEntries(ROLES.map((r, i) => [r, e(scopes[i]!, why)])) as PerRole<ReadScope>;
```
Intended read scopes (`expect`), roles in the order anon, customer, barber, receptionist, manager, analyst, owner, otherManager:

| table (key) | anon | customer | barber | receptionist | manager | analyst | owner | otherManager | why |
|---|---|---|---|---|---|---|---|---|---|
| appointments (id) | none | own | none | branch | branch | none | all | branch | edit_tickets staff see their branch; customers their own |
| audit_log (id) | none | none | none | none | none | all | all | none | view_audit_log (owner, analyst) |
| barber_days_off (id) | none | none | own | none | branch | none | all | branch | manage_barber_schedules; barber own |
| barber_schedule (id) | none | none | own | none | branch | none | all | branch | manage_barber_schedules; barber own |
| barber_service_stats (id) | none | none | none | none | branch | branch | all | branch | view_branch_reports |
| barber_skills (barber_id) | all | all | all | all | all | all | all | all | public (booking) |
| barber_weekly_hours (id) | none | none | own | none | branch | none | all | branch | manage_barber_schedules; barber own |
| barbers (id) | all | all | all | all | all | all | all | all | public (booking); anon entry flagged `J-anon-barbers-read` |
| branch_closures, branch_hours, branch_service_prices, branch_services, branches, businesses, capabilities, role_capabilities, services | all | all | all | all | all | all | all | all | public catalogue |
| branch_ticket_counters (branch_id) | none | none | none | none | none | none | none | none | internal counter |
| consents (id) | none | own | none | none | branch | none | all | branch | broadcast_messages for own-branch customers; analysts read promotions via customer_detail |
| customers (id) | none | own | none | none | none | none | none | none | staff read customers only through functions |
| feedback (id) | none | own | none | none | branch | branch | all | branch | view_branch_reports |
| notifications (id) | none | own | none | none | none | none | none | none | recipients only (fixture rows are customer-recipient) |
| push_subscriptions (id) | none | own | none | none | none | none | none | none | customer's own devices |
| queue_events (id) | none | own | none | none | branch | branch | all | branch | view_branch_reports; customer own |
| queue_tickets (id) | none | own | own | branch | branch | none | all | branch | edit_tickets; barber own queue; customer own |
| service_sessions (id) | none | none | own | branch | branch | none | all | branch | edit_tickets; barber own |
| staff_branch_assignments (staff_user_id) | none | none | branch | branch | branch | branch | all | branch | `J-staff-assignments-read` |
| staff_users (id) | none | none | branch | branch | branch | branch | all | branch | `J-staff-users-read` |
| branch_status_view (branch_id), current_branch_service_price (branch_service_id) | all | all | all | all | all | all | all | all | public |
| customer_segments (customer_id) | none | own | none | none | none | none | none | none | security invoker over customers |

Pre-marked overrides (`currently` + `gap`):
- `consents`: manager `currently: 'all'`, analyst `currently: 'all'`, otherManager `currently: 'all'`, each `gap: 'G-consents-scope'`.
- `staff_users` and `staff_branch_assignments`: every role's entry gets `gap: 'J-staff-users-read'` / `'J-staff-assignments-read'` and `why: 'pending user decision'`; set `currently` to whatever you observe where it differs from the table above.
- `barbers` anon: `gap: 'J-anon-barbers-read'`, `why: 'pending user decision'` (expect stays `all`).

- [ ] **Step 4: Write the read runner**

Create `tests/db/rbac/reads.test.ts`:
```typescript
// tests/db/rbac/reads.test.ts
// @vitest-environment node
// Every role reads every public table/view; the rows that come back must match the matrix.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TABLES } from './tables';
import { ROLES, effective, type ReadScope, type Role, type RowSet } from './types';
import { cleanupRbacFixture, createRbacFixture, type RbacFixture } from './fixture';

let f: RbacFixture;
beforeAll(async () => {
  f = await createRbacFixture();
}, 180000);
afterAll(async () => {
  await cleanupRbacFixture(f);
}, 180000);

function expectedRows(scope: ReadScope, role: Role, rows: RowSet): string[] {
  const branchRows = role === 'otherManager' ? rows.b : rows.a;
  const set =
    scope === 'none'
      ? []
      : scope === 'own'
        ? rows.own
        : scope === 'branch'
          ? branchRows
          : [...rows.a, ...rows.b];
  return [...new Set(set)].sort();
}

describe.each(TABLES)('$table', (entry) => {
  it.each(ROLES)('%s', async (role) => {
    const rows = f.rows[entry.table];
    if (!rows) throw new Error(`fixture has no rows for ${entry.table}`);
    const ids = [...new Set([...rows.a, ...rows.b, ...rows.own])];
    const { data, error } = await f.clients[role]
      .from(entry.table as never)
      .select(entry.key)
      .in(entry.key, ids);
    const seen = error
      ? []
      : [...new Set((data ?? []).map((r) => String((r as Record<string, unknown>)[entry.key])))].sort();
    const scope = effective(entry.read[role]);
    expect(seen, `${entry.table} as ${role}${error ? ` (error: ${error.message})` : ''}`).toEqual(
      expectedRows(scope, role, rows),
    );
  });
});
```
(A permission error on select counts as "no rows"; note in the report any table that errors instead of returning [].)

- [ ] **Step 5: Write the table coverage guard**

Create `tests/db/rbac/coverage.test.ts` (Task 3 adds the function guard and gap snapshot):
```typescript
// tests/db/rbac/coverage.test.ts
// @vitest-environment node
// Every public table and view is in the matrix, and the matrix names nothing that no longer exists.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { describe, expect, it } from 'vitest';
import { TABLES } from './tables';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

describe('coverage', () => {
  it('classifies every public table and view', async () => {
    const res = await fetch(`${url}/rest/v1/`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    const spec = (await res.json()) as { definitions?: Record<string, unknown> };
    const exposed = Object.keys(spec.definitions ?? {}).sort();
    const classified = TABLES.map((t) => t.table).sort();
    expect(exposed.filter((t) => !classified.includes(t)), 'tables/views missing from the matrix').toEqual([]);
    expect(classified.filter((t) => !exposed.includes(t)), 'matrix entries that no longer exist').toEqual([]);
  });
});
```
(The PostgREST OpenAPI document lists every exposed table and view under `definitions`. If this project's PostgREST version names that key differently, adapt to it and note it in the report.)

- [ ] **Step 6: Run, align `currently` with reality, verify, commit**

- `npx vitest run tests/db/rbac/reads.test.ts tests/db/rbac/coverage.test.ts`
- For each failing case: first confirm the fixture rows are right (fix the fixture if not). If the fixture is right and the database differs from `effective(...)`, set `currently` to the observed scope with a gap id — `G-…` if it matches a clear rule (reading outside branch scope, or a role reading what PRD section 32 forbids), otherwise `J-…` with `why: 'pending user decision'`. Never change `expect` to pass.
- Re-run until green; `npm run typecheck`; `grep -n $'\xef\xbf\xbd'` on new files.
- Commit:
```bash
git add tests/db/rbac
git commit -m "test: role permission matrix — fixture, table reads and coverage"
```
Report every gap id with what it exposes and to whom (including new ones).

---

### Task 2: Table writes

**Files:**
- Modify: `tests/db/rbac/tables.ts`, `tests/db/rbac/fixture.ts` (probe helpers)
- Create: `tests/db/rbac/writes.test.ts`

**Interfaces:**
- Consumes: Task 1's fixture, types, `TABLES`.
- Produces in `tables.ts`:
```typescript
export interface WriteProbe {
  /** A row to insert at branch 'a' or 'b' (for customer/barber 'own' probes, 'a' is their own). */
  insert?: (f: RbacFixture, at: 'a' | 'b') => Promise<Record<string, unknown>>;
  /** Creates (with admin) a throwaway row at 'a' or 'b'; returns its key value, a harmless column and a new value. */
  target: (f: RbacFixture, at: 'a' | 'b') => Promise<{ key: string; column: string; value: unknown }>;
}
export interface WriteEntry {
  table: string;
  key: string;
  probe: WriteProbe;
  insert: PerRole<WriteScope>;
  update: PerRole<WriteScope>;
  delete: PerRole<WriteScope>;
}
export const WRITES: WriteEntry[];
```

- [ ] **Step 1: Write the write matrix**

Add a `WriteEntry` for every base table in `TABLES` (not the views). A write is **allowed** when: insert → no error; update → the admin client then sees `column = value`; delete → the admin client no longer finds the row. Scope rules: `deny` → refused at A and B; `branch` → allowed at the role's branch (A, or B for otherManager), refused at the other; `all` → allowed at both; `own` → allowed only on the customer's/barber's own row (probe `'a'`), refused on `'b'`.

Intended (`expect`) writes — any role not named is `deny` for that operation:

| table | insert | update | delete | why |
|---|---|---|---|---|
| appointments | — | — | — | only through booking functions |
| audit_log, queue_events, notifications, feedback, barber_service_stats, branch_ticket_counters, capabilities, role_capabilities | — | — | — | server-side only |
| barber_days_off, barber_weekly_hours, barber_schedule, barber_skills | manager, otherManager: branch; owner: all | same | same | manage_barber_schedules |
| barbers | owner: all | manager, otherManager, receptionist: branch; barber: own; owner: all | owner: all | creating/removing a barber is staff management |
| branch_closures, branch_hours | manager, otherManager: branch; owner: all | same | same | edit_hours |
| branch_services, branch_service_prices | manager, otherManager: branch; owner: all | same | same | edit_pricing |
| branches, businesses | owner: all | owner: all | owner: all | manage_branches / owner |
| services | owner: all | owner: all | owner: all | business-wide catalogue (`J-services-catalog-write`) |
| consents | customer: own | — | — | customers record their own choices |
| customers | receptionist, manager, otherManager, owner: all (walk-in registration is not branch-scoped) | customer: own | — | register_walkins; self update |
| push_subscriptions | — (saved through a function) | — | customer: own | own devices |
| queue_tickets | customer: own; receptionist, manager, otherManager: branch; owner: all | customer: own (probe sets `state: 'cancelled'`); barber: own; receptionist, manager, otherManager: branch; owner: all | — | edit_tickets; no deletes |
| service_sessions | barber: own; receptionist, manager, otherManager: branch; owner: all | same | — | edit_tickets; barber own; no deletes |
| staff_users, staff_branch_assignments | — | — (probe another user's row) | — | staff management runs server-side |

Pre-marked overrides:
- `queue_tickets` delete: receptionist, manager, otherManager `currently: 'branch'`; owner `currently: 'all'`; `gap: 'G-ticket-delete'`.
- `service_sessions` delete: barber `currently: 'own'`; receptionist, manager, otherManager `currently: 'branch'`; owner `currently: 'all'`; `gap: 'G-session-delete'`.
- `barbers` insert and delete: manager, otherManager `currently: 'branch'`; `gap: 'G-barbers-insert-delete'`.
- `services` insert/update/delete: manager, otherManager `currently: 'all'`; `gap: 'J-services-catalog-write'`; `why: 'pending user decision'`.

Probe builders: each `target` creates its own throwaway row with the admin client (so an allowed delete or update never touches shared fixture rows) and returns a harmless column/value (e.g. `barber_days_off` reason, `branch_closures.reason`, `queue_tickets.state` → `'cancelled'`, a `service_sessions` end/notes column, `branch_services.is_active` → `false`, `services.name` → new text, `customers.name`, `barbers.status`). For `own` probes, `target(f, 'a')` must create a row owned by the customer (customer 0) or barber (barber A). Track every created row and delete it in cleanup that throws on failure.

- [ ] **Step 2: Write the runner**

Create `tests/db/rbac/writes.test.ts`: share the fixture like `reads.test.ts`; `describe.each(WRITES)` × `it.each(ROLES)`; inside, for each op in `['insert', 'update', 'delete']` and each `at` in `['a', 'b']`, attempt the write with `f.clients[role]`, decide allowed/refused as defined above, and `expect(allowed, \`${table} ${op} as ${role} at ${at}\`).toBe(<scope rule for effective(entry[op][role])>)`. Skip `insert` when the entry has no `insert` builder (expect must then be `deny` for every role; assert that a plain insert of a minimal row is refused).

- [ ] **Step 3: Run, align, verify, commit**

Same procedure as Task 1 Step 6 with `npx vitest run tests/db/rbac/writes.test.ts`. Commit:
```bash
git add tests/db/rbac
git commit -m "test: role permission matrix — table writes"
```
Report every gap id with what it allows and to whom.

---

### Task 3: Functions, function coverage and the gap snapshot

**Files:**
- Create: `tests/db/rbac/functions.ts`, `tests/db/rbac/functions.test.ts`, `supabase/migrations/20261008115900_rbac_callable_functions.sql`
- Modify: `tests/db/rbac/coverage.test.ts`, `tests/db/rbac/types.ts` (`OPEN_GAPS`)

**Interfaces:**
- Consumes: Tasks 1–2 fixture, types, `TABLES`, `WRITES`.
- Produces:
```typescript
export interface FunctionEntry {
  name: string;
  /** Arguments for this role's call; may create fresh rows with f.admin for mutating functions. */
  args: (f: RbacFixture, role: Role) => Promise<Record<string, unknown>>;
  outcome: PerRole<Outcome>;
}
export const FUNCTIONS: FunctionEntry[];
// in types.ts
export const OPEN_GAPS: string[]; // sorted
```

- [ ] **Step 1: Write the catalogue helper**

Create `supabase/migrations/20261008115900_rbac_callable_functions.sql`:
```sql
-- Test support for the role/permission coverage guard: the public functions clients can call
-- (EXECUTE granted to authenticated or anon). Service role only.
create or replace function rbac_callable_functions()
returns table (name text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select distinct p.proname::text
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
    and p.proname <> 'rbac_callable_functions'
    and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
         or has_function_privilege('anon', p.oid, 'EXECUTE'))
  order by 1;
$$;

revoke execute on function rbac_callable_functions() from public, anon, authenticated;
grant execute on function rbac_callable_functions() to service_role;
```
Commit it on its own (`test: catalogue helper for the permission coverage guard`) and report "ready for push"; continue with Step 2 while waiting, and run tests only after the controller confirms the push.

- [ ] **Step 2: Write the function matrix**

One `FunctionEntry` per function returned by `rbac_callable_functions` (today: the list in `Docs/superpowers/specs/2026-10-08-role-permission-check-design.md` "Current state", ~50 names). Arguments target branch A / customer 0 / barber A / the fixture service unless noted, so `otherManager` exercises cross-branch refusal. Intended outcomes — any role not named is `deny`:

| function | allow | empty | why |
|---|---|---|---|
| auth_branch_ids, auth_role, auth_staff_id, has_capability, in_branch_scope, current_customer_id | every role incl. anon | — | session helpers (return the caller's own facts) |
| bump_ticket_version, check_notification_recipient, set_updated_at, trg_barber_current_ticket, trg_refill_barber_schedule | — | — | `internal` for every role (trigger functions) |
| book_appointment, check_in_my_appointment, cancel_appointment, reschedule_appointment, submit_feedback, list_my_feedback, save_push_subscription, remove_push_subscription | customer | — | customer self-service (fresh appointment/ticket per allowed call) |
| link_or_create_customer | customer | — | onboarding link; anon entry `J-link-customer-anon`, staff entries `J-link-customer-staff` (record observed) |
| list_bookable_barbers | every role incl. anon | — | public booking |
| list_appointment_slots, preview_wait_estimate, find_eligible_barber | every authenticated role | — | public availability |
| branch_today | receptionist, manager, analyst, owner | — | view_branch_dashboard |
| branch_report, branch_feedback_summary, list_branch_feedback | manager, analyst, owner | — | view_branch_reports |
| list_customers, customer_detail | receptionist, manager, analyst, owner | — | view_customers |
| send_customer_message | receptionist, manager, owner | — | message_customers |
| list_branch_appointments, get_branch_appointment, staff_list_appointment_slots, staff_book_appointment, staff_cancel_appointment, staff_check_in_appointment, staff_reschedule_appointment, staff_mark_appointment_no_show | receptionist, manager, owner | — | edit_tickets (fresh appointment per mutating call) |
| list_manageable_barbers, reset_barber_schedule_day, set_barber_weekly_hours | manager, owner | — | manage_barber_schedules |
| mark_feedback_seen | manager, owner | — | handle_escalations |
| set_long_wait_warning | manager, owner | — | edit_hours |
| list_staff_accounts | owner | — | manage_staff |
| list_unseen_low_feedback_count | manager, owner | every other authenticated role | returns 0 without handle_escalations |
| list_my_appointments_today | barber | every other authenticated role | the barber's own day |

Every non-internal function must have at least one `allow` role (proving its arguments are valid). Record observed behaviour as `currently` + gap id wherever it differs, as in Task 1 (time-dependent functions such as `staff_check_in_appointment` or `staff_mark_appointment_no_show` may need an appointment whose timing makes the allowed call legal — build it in `args`).

- [ ] **Step 3: Write the runner**

`tests/db/rbac/functions.test.ts`: share the fixture; `describe.each(FUNCTIONS)` × `it.each(ROLES)`; skip roles whose outcome is `internal`. Build args, call `f.clients[role].rpc(name as never, args as never)`, classify: error → `deny`; no error and data is `null`, `0`, `[]`, or an object with no keys → `empty`; otherwise `allow`. `expect(actual, \`${name} as ${role}${error ? \` (${error.message})\` : ''}\`).toBe(effective(entry.outcome[role]))`.

- [ ] **Step 4: Extend the coverage guard and add the gap snapshot**

In `tests/db/rbac/coverage.test.ts` add (importing `createClient`, `FUNCTIONS`, `WRITES`, `OPEN_GAPS`):
```typescript
const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  it('classifies every callable function', async () => {
    const { data, error } = await admin.rpc('rbac_callable_functions' as never);
    expect(error).toBeNull();
    const callable = ((data ?? []) as { name: string }[]).map((r) => r.name).sort();
    const classified = FUNCTIONS.map((fn) => fn.name).sort();
    expect(callable.filter((n) => !classified.includes(n)), 'functions missing from the matrix').toEqual([]);
    expect(classified.filter((n) => !callable.includes(n)), 'matrix entries that no longer exist').toEqual([]);
  });

  it('pins the open gaps', () => {
    const gaps = new Set<string>();
    const collect = (x: { gap?: string }) => {
      if (x.gap) gaps.add(x.gap);
    };
    for (const t of TABLES) Object.values(t.read).forEach(collect);
    for (const w of WRITES) for (const op of ['insert', 'update', 'delete'] as const) Object.values(w[op]).forEach(collect);
    for (const fn of FUNCTIONS) Object.values(fn.outcome).forEach(collect);
    expect([...gaps].sort()).toEqual(OPEN_GAPS);
  });
```
and export `OPEN_GAPS` (sorted) from `types.ts` listing every gap id now in the matrix.

- [ ] **Step 5: Run, align, verify, commit**

After the controller confirms the helper is pushed: `npx vitest run tests/db/rbac`. Same `currently`/gap procedure. `npm run typecheck`. Commit:
```bash
git add tests/db/rbac
git commit -m "test: role permission matrix — functions, coverage and gap snapshot"
```
Report the final `OPEN_GAPS`, each with what it exposes and to whom.

---

### Task 4: Fix the confirmed clear gaps

**Files:**
- Create: `supabase/migrations/20261008120000_rbac_clear_gaps.sql`
- Modify: `tests/db/rbac/tables.ts`, `tests/db/rbac/functions.ts`, `tests/db/rbac/types.ts`

**Interfaces:**
- Consumes: the `G-…` gaps confirmed in Tasks 1–3 — the controller's dispatch names exactly which ones to fix. `J-…` gaps are never changed here.

- [ ] **Step 1: Flip the matrix first (RED)**

For each `G-…` gap the dispatch names: delete its `currently` and `gap` fields (the entry now asserts `expect`) and remove the id from `OPEN_GAPS`. Run `npx vitest run tests/db/rbac` — the flipped cases must FAIL.

- [ ] **Step 2: Write the migration**

Before writing the barbers section, grep `apps/` for client-side `from('barbers')` with `.insert(` or `.delete(`, and `supabase/functions/` for barber writes made with a user's session; if any staff screen inserts or deletes barbers with a manager's session, stop and report instead of writing that section.

Create `supabase/migrations/20261008120000_rbac_clear_gaps.sql` with one section per named gap. For the four pre-marked gaps:
```sql
-- Role/permission check (Docs/superpowers/specs/2026-10-08-role-permission-check-design.md): fixes
-- for the clear gaps the matrix confirmed.

-- G-consents-scope: staff read consents only for customers of their branches, and only with
-- broadcast_messages (owner, branch_manager). Analysts see "Promotions" through customer_detail.
create or replace function customer_in_my_branches(p_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from queue_tickets t where t.customer_id = p_customer_id and in_branch_scope(t.branch_id))
      or exists (select 1 from appointments a where a.customer_id = p_customer_id and in_branch_scope(a.branch_id));
$$;
revoke execute on function customer_in_my_branches(uuid) from public, anon;
grant execute on function customer_in_my_branches(uuid) to authenticated;

drop policy if exists consents_staff_read on consents;
create policy consents_staff_read on consents for select
  using (has_capability('broadcast_messages') and customer_in_my_branches(customer_id));

-- G-ticket-delete: staff keep select/insert/update on their branch's tickets; no deletes.
drop policy if exists tickets_staff_branch_scope on queue_tickets;
create policy tickets_staff_branch_select on queue_tickets for select
  using (in_branch_scope(branch_id) and has_capability('edit_tickets'));
create policy tickets_staff_branch_insert on queue_tickets for insert
  with check (in_branch_scope(branch_id) and has_capability('edit_tickets'));
create policy tickets_staff_branch_update on queue_tickets for update
  using (in_branch_scope(branch_id) and has_capability('edit_tickets'))
  with check (in_branch_scope(branch_id) and has_capability('edit_tickets'));

-- G-session-delete: barbers and staff keep select/insert/update on service sessions; no deletes.
drop policy if exists service_sessions_barber_own on service_sessions;
drop policy if exists service_sessions_staff_branch_scope on service_sessions;
create policy service_sessions_barber_own_select on service_sessions for select
  using (barber_id = (select b.id from barbers b where b.staff_user_id = auth_staff_id()));
create policy service_sessions_barber_own_insert on service_sessions for insert
  with check (barber_id = (select b.id from barbers b where b.staff_user_id = auth_staff_id()));
create policy service_sessions_barber_own_update on service_sessions for update
  using (barber_id = (select b.id from barbers b where b.staff_user_id = auth_staff_id()))
  with check (barber_id = (select b.id from barbers b where b.staff_user_id = auth_staff_id()));
create policy service_sessions_staff_select on service_sessions for select
  using (has_capability('edit_tickets')
         and in_branch_scope((select t.branch_id from queue_tickets t where t.id = service_sessions.ticket_id)));
create policy service_sessions_staff_insert on service_sessions for insert
  with check (has_capability('edit_tickets')
              and in_branch_scope((select t.branch_id from queue_tickets t where t.id = service_sessions.ticket_id)));
create policy service_sessions_staff_update on service_sessions for update
  using (has_capability('edit_tickets')
         and in_branch_scope((select t.branch_id from queue_tickets t where t.id = service_sessions.ticket_id)))
  with check (has_capability('edit_tickets')
              and in_branch_scope((select t.branch_id from queue_tickets t where t.id = service_sessions.ticket_id)));

-- G-barbers-insert-delete: managers keep updating their branch's barbers; creating or removing a
-- barber row is staff management (owner, manage_staff).
drop policy if exists barbers_staff_write on barbers;
create policy barbers_staff_update on barbers for update
  using (has_capability('manage_barber_schedules') and in_branch_scope(home_branch_id))
  with check (has_capability('manage_barber_schedules') and in_branch_scope(home_branch_id));
create policy barbers_owner_insert on barbers for insert
  with check (has_capability('manage_staff'));
create policy barbers_owner_delete on barbers for delete
  using (has_capability('manage_staff'));
```
For any further `G-…` gap the dispatch names, add the smallest policy/grant change that makes its `expect` true, in the same file, under a comment naming the gap id.

- [ ] **Step 3: Hand over, then verify**

Commit (`fix: close confirmed role/permission gaps`) and report "ready for push". After the controller pushes: `npx vitest run tests/db/rbac` — all green; plus `npx vitest run tests/db/rls-policies.test.ts tests/db/customer-list.test.ts tests/db/feedback-staff.test.ts tests/db/barber-schedule-permissions.test.ts tests/db/shared-station-handoff.test.ts tests/db/ticket-concurrent-edit.test.ts` — all green. Append results to the report.

---

### Task 5: Light screen check per staff role

**Files:**
- Create: `e2e/staff-roles.spec.ts`

**Interfaces:**
- Consumes: the staff home page (`apps/staff/app/page.tsx`) — `Today` (view_branch_dashboard), `Reports` (view_branch_reports), `Customers` (view_customers), `Feedback` (view_branch_reports) are capability-gated; the settings and Appointments links are shown to everyone. Pages showing `You don't have access to this page.`: `/today`, `/reports`, `/customers`; `/settings/staff` shows its own `StaffRoles.noAccess` copy (`You don't have access to this page.`).

- [ ] **Step 1: Write the journey**

One `test.describe.serial` with a shared seed (one branch, one service; staff logins for receptionist, branch_manager, analyst, barber created with the admin client like `e2e/staff-reports.spec.ts`; emails `srl-<role>-<suffix>@test.pixelbarber.local`; the barber also gets a `barbers` row at the branch). One test per role logs in (`waitForURL(/\/tickets/)`) and, scoped to `page.locator('main')`:
- receptionist: home shows links `Today` and `Customers`; no `Reports`, no `Feedback`; `/reports` shows `You don't have access to this page.`
- branch_manager: home shows `Today`, `Reports`, `Customers`, `Feedback`; `/settings/staff` shows `You don't have access to this page.`
- analyst: home shows `Today`, `Reports`, `Customers`, `Feedback`; `/settings/staff` shows `You don't have access to this page.`
- barber: home shows none of `Today`, `Reports`, `Customers`, `Feedback`; `/customers` and `/reports` each show `You don't have access to this page.`
Use `.press('Enter')`, `getByRole('link', { name: 'Today', exact: true })` style locators, and an `afterAll` cleanup that throws.

- [ ] **Step 2: Verify and commit**

`npx playwright test e2e/staff-roles.spec.ts --reporter=line --workers=1` — PASS. If a role sees a link or page it shouldn't, do not change the expectation: report it as a finding. Commit:
```bash
git add e2e/staff-roles.spec.ts
git commit -m "test: staff home links and no-access pages per role"
```

---

## After all tasks (controller)

- Report to the user: gaps fixed (with migrations), the `J-…` judgment calls with a recommendation each, and the full-suite result.
- Promotion after the user's OK: `20261008115900` (test helper) and `20261008120000` to production (dry run first), then push to GitHub. No Edge Function or app deploy unless a fix touched app code.
