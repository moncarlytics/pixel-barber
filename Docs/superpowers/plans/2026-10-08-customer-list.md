# Customer List and Message Customer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff find their branches' customers by name or phone, open a customer's visits, reliability, feedback, preferences and messages, and send a short service message delivered push-first (SMS backup once live).

**Architecture:** One internal SQL helper (`customer_scope_stats`) computes every customer's numbers and group for a set of branches; three `SECURITY DEFINER` functions (`list_customers`, `customer_detail`, `send_customer_message`) check capabilities and scope and use it. A sent message is a `staff_message` notification that the existing `send-notifications` sender delivers (claim + pure cores learn the type). The staff app gets a list page and a customer page.

**Tech Stack:** Supabase Postgres (plpgsql), Deno Edge Function (send-notifications), Next.js 16 client components, next-intl, Vitest, Playwright.

**Spec:** `Docs/superpowers/specs/2026-10-08-customer-list-design.md`

## Global Constraints

- Capabilities: new `view_customers` (owner, branch_manager, receptionist, analyst) for the list and detail; existing `message_customers` (owner, branch_manager, receptionist) for sending and for unmasked phones; barbers have neither. Every requested branch must pass `in_branch_scope`.
- Scope: a customer is visible when they have a ticket or appointment at one of the requested branches and `is_anonymized` is false; all numbers, groups and history count only those branches. `late_cancellations` is the customer's total (`customers.late_cancellation_count`).
- Phone: full local format `0244123456` for `message_customers` holders, else `024•••3456` (first three + `•••` + last four of the local number). Local number = `0` + digits after `+233`.
- Groups, checked in order: `new` (no completed visit), `lapsed` (last completed visit more than 90 days ago), `at_risk` (3+ no-shows, or `late_cancellation_count` ≥ 3), `frequent` (3+ completed visits in the last 90 days), `returning` (else).
- Search: 3+ digits → phone digits contain them (leading `0` → `233`); otherwise name contains the text, case-insensitive.
- List: ordered by last visit (most recent first, no visit last), then name; 50 per page; `{ rows, has_more }`.
- Message: text trimmed, 1–140 characters; at most 5 `staff_message` notifications per customer per branch per Ghana day; notification `notification_type = 'staff_message'`, channel `sms`, `payload = { text, branch_id, branch_name, sent_by_staff_id }`.
- Delivery: never stale (unless the text is missing), 10-minute expiry; push title `Pixel Barber · {branch}`, body the text, tap URL `/`, urgency normal; SMS `Pixel Barber ({branch}): {text}`.
- Error strings (exact): `not_allowed`, `not_found`, `invalid_group`, `empty_message`, `message_too_long`, `daily_limit`.
- Staff copy (exact): `Customers`; `Search by name or phone`; `All groups`, `New`, `Returning`, `Frequent`, `Lapsed`, `At risk`; `Show more`; `You don't have access to this page.`; `Couldn't load customers.`; `No customers match.`; `We couldn't find this customer.`; `Couldn't load this customer.`; `Confirmation call before appointments: Yes|No`; `App notifications: On|Off`; `SMS backup: On|Off`; `Promotions: Allowed|Not allowed`; `For service messages about a visit, not promotions.`; `{n} characters left`; `Send`; `Message queued.`; `Write a message first.`; `Messages can be up to 140 characters.`; `This customer has had 5 messages from this branch today.`; `Couldn't send. Please try again.`; delivery `Sending` / `Delivered` / `Not delivered` with `No app notifications or SMS available` / `Expired` / `Failed`.
- Every new SQL function: `security definer`, `set search_path = public, pg_temp`, explicit revoke/grant (`authenticated` only for callable ones; helpers revoked from everyone). Already-applied migrations are never edited. `packages/shared/src/database.types.ts` is hand-maintained and must match the SQL.
- **Implementer subagents cannot push migrations, deploy functions, set secrets or run SQL against a live project.** The controller pushes (`set -a && source supabase/.secrets/send-sms.env && set +a && npx supabase db push`) and deploys. Report "ready for push" / "ready for deploy".
- Live SMS stays off on staging; SMS-path rows end `not_allowlisted`/`sms_disabled`.
- React lint (errors): no synchronous `setState` in effect bodies; no `Date.now()` / argument-less `new Date()` in render or `useMemo`; guard async results. The repo has `noUncheckedIndexedAccess` on (indexed access may need `!` or `??`); run root `npm run typecheck`.
- E2E: `.press('Enter')`, locators scoped to `page.locator('main')`; phone range `+233209…`; FK-safe cleanup that throws. Do NOT kill node processes; the Playwright config starts/reuses dev servers.
- After editing any file containing `—`, `–`, `·` or `•`, `grep -n $'\xef\xbf\xbd' <file>` must print nothing.
- Do not stage `apps/*/next-env.d.ts`, `graphify-out/`, `playwright-report/`, `test-results/`, `supabase/.secrets/`, untracked `Docs/superpowers/plans/2026-09-1*`. No AI-attribution lines in commits. Commit on main.
- Environment: lint per file (`cd apps/staff && npx eslint "<file>"`); pure unit tests from the repo root with `npx vitest run <path> --environment=node`; DB tests `npx vitest run tests/db/<file>` (staging; on a login rate-limit failure wait a minute and re-run).

## Rulings made while planning

1. **One stats helper.** `customer_scope_stats(p_branch_ids)` (internal, not callable by clients) computes visits, last visit, no-shows, cancellations, 90-day visits, average rating given and group for every visible customer, so the list, the detail and the send check can't disagree.
2. **No `group_reason` field.** `customer_detail` returns `group` plus `stats`, which already hold every fact behind a group; the page builds the reason sentence (`Frequent: 4 visits in the last 90 days`) from them.
3. **`customer_detail` also returns `branch_ids`** — the requested branches where the customer is visible — so the message form's branch picker only offers branches the send will accept.
4. **Customer page branch context** comes from `?branch=<id|all>` (the list links carry it), read with `useSearchParams` inside a `Suspense` boundary like `appointments/new`.
5. **`opted_out` and `no_phone` also map to `No app notifications or SMS available`** — they mean the same thing to staff.
6. **Pagination is tested by offset** (rows after the first three); seeding 51 customers to see `has_more: true` isn't worth the staging load — the `has_more` arithmetic is a one-line `count > 50`.
7. **Staff messages are cleaned up by recipient** in tests (they have no ticket, so the fixture's ticket-based notification cleanup misses them).

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20261008100000_customer_list.sql` | capability, `staff_phone`, `customer_scope_stats`, `check_customer_access`, `list_customers`, `customer_detail`, `send_customer_message` |
| `supabase/migrations/20261008100100_staff_message_claim.sql` | `claim_sms_notifications` + `message_text`, payload branch name |
| `tests/db/customer-list.test.ts`, `tests/db/staff-message-sending.test.ts` | DB tests |
| `packages/shared/src/database.types.ts` | new functions |
| `supabase/functions/_shared/notification-sms-core.ts`, `notification-push-core.ts`, `supabase/functions/send-notifications/index.ts` | `staff_message` rules, texts, wiring |
| `tests/unit/notification-sms-core.test.ts`, `tests/unit/notification-push-core.test.ts` | unit tests |
| `apps/staff/app/customers/customerTypes.ts`, `customerLabels.ts` (+ test) | shapes and label mapping |
| `apps/staff/app/customers/page.tsx` | list page |
| `apps/staff/app/customers/[id]/page.tsx`, `apps/staff/app/customers/[id]/MessageForm.tsx` | customer page and message form |
| `apps/staff/app/page.tsx`, `apps/staff/messages/en.json` | home link, copy |
| `e2e/staff-customers.spec.ts` | journey |

---

### Task 1: Customer list, detail and send functions

**Files:**
- Create: `supabase/migrations/20261008100000_customer_list.sql`
- Create: `tests/db/customer-list.test.ts`
- Modify: `packages/shared/src/database.types.ts`

**Interfaces:**
- Consumes: `has_capability`, `in_branch_scope`, `auth_staff_id()`; fixture `createAppointmentFixture`, `createStaffLogin(f, label, 'branch_manager' | 'receptionist' | 'analyst', string | string[])`, `cleanupStaffLogin`, `cleanupAppointmentFixture`, `dateAt`.
- Produces (SQL):
  - `list_customers(p_branch_ids uuid[], p_search text, p_group text, p_offset integer) returns jsonb` → `{ rows: [{ id, name, phone, last_visit_at, visits, no_shows, avg_rating_given, group }], has_more }`.
  - `customer_detail(p_customer_id uuid, p_branch_ids uuid[]) returns jsonb` → `{ customer: { id, name, phone, email, requires_confirmation_call, push_enabled, sms_backup_enabled, marketing_allowed }, stats: { visits, last_visit_at, appointments, no_shows, cancellations, late_cancellations, avg_rating_given, visits_last_90_days }, group, branch_ids: uuid[], visits: [{ ticket_id, created_at, branch_name, service_name, barber_name, state, cancel_reason }], feedback: [{ created_at, branch_name, barber_name, overall_rating, comment }], messages: [{ id, created_at, branch_name, sent_by_name, text, status, failed_reason }] }`.
  - `send_customer_message(p_customer_id uuid, p_branch_id uuid, p_text text) returns uuid`.

- [ ] **Step 1: Write the failing tests**

Create `tests/db/customer-list.test.ts`:
```typescript
// tests/db/customer-list.test.ts
// @vitest-environment node
// Customer list (Docs/superpowers/specs/2026-10-08-customer-list-design.md): list_customers scope,
// numbers, groups, search, paging and phone masking; customer_detail sections and access;
// send_customer_message rules and the queued staff_message.
//
// Seed (Main branch unless noted; days ago):
//   cust0: completed 1, 10, 20 (rated 4 and 5) + Closed completed 5   → Main: frequent; both: 4 visits
//          marketing consent granted
//   cust1: completed 120 + Closed completed 5                          → Main: lapsed; both: returning
//   cust2: no-shows 30, 31, 32 + completed 2                           → at_risk
//   cust3: only an appointment in 2 days                                → new
//   walk-in (no app account): completed 3                               → returning
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
type J = Record<string, any>;

let f: AppointmentFixture;
let manager: Awaited<ReturnType<typeof createStaffLogin>>;
let reception: Awaited<ReturnType<typeof createStaffLogin>>;
let analyst: Awaited<ReturnType<typeof createStaffLogin>>;
let otherManager: Awaited<ReturnType<typeof createStaffLogin>>;
let walkInId: string;
const at = (daysAgo: number, hhmm = '10:00') => `${dateAt(-daysAgo)}T${hhmm}:00.000Z`;
const local = (e164: string) => `0${e164.slice(4)}`;
const masked = (e164: string) => `${local(e164).slice(0, 3)}•••${local(e164).slice(-4)}`;
const cust = (i: number) => f.customers[i]!;

let n = 0;
async function ticket(fields: Omit<TicketInsert, 'ticket_number' | 'created_by'>) {
  n += 1;
  const { data, error } = await f.admin
    .from('queue_tickets')
    .insert({ ticket_number: `PB-CL-${f.suffix}-${n}`, created_by: 'customer', ...fields })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

const main = () => ({ branch_id: f.branchId, branch_service_id: f.branchServiceId });
const closed = () => ({ branch_id: f.closedBranchId, branch_service_id: f.closedBranchServiceId });
const done = (daysAgo: number) => ({
  state: 'completed' as const,
  assigned_barber_id: f.barberA.barberId,
  created_at: at(daysAgo, '10:00'),
  service_started_at: at(daysAgo, '10:10'),
  completed_at: at(daysAgo, '10:40'),
});

async function list(
  client: typeof manager.client,
  ids: string[],
  search: string | null = null,
  group: string | null = null,
  offset = 0,
) {
  return client.rpc('list_customers', {
    p_branch_ids: ids,
    p_search: search,
    p_group: group,
    p_offset: offset,
  });
}

beforeAll(async () => {
  f = await createAppointmentFixture();
  manager = await createStaffLogin(f, 'clm', 'branch_manager', f.branchId);
  reception = await createStaffLogin(f, 'clr', 'receptionist', f.branchId);
  analyst = await createStaffLogin(f, 'cla', 'analyst', [f.branchId, f.closedBranchId]);
  otherManager = await createStaffLogin(f, 'clo', 'branch_manager', f.closedBranchId);

  const r1 = await ticket({ ...main(), customer_id: cust(0).customerId, ...done(1) });
  const r2 = await ticket({ ...main(), customer_id: cust(0).customerId, ...done(10) });
  await ticket({ ...main(), customer_id: cust(0).customerId, ...done(20) });
  await ticket({ ...closed(), customer_id: cust(0).customerId, ...done(5) });
  for (const [ticketId, rating] of [[r1, 4], [r2, 5]] as const) {
    const { error } = await f.admin.from('feedback').insert({
      ticket_id: ticketId,
      customer_id: cust(0).customerId,
      branch_id: f.branchId,
      barber_id: f.barberA.barberId,
      overall_rating: rating,
      comment: rating === 4 ? 'Good cut' : 'Great cut',
    });
    if (error) throw error;
  }
  const { error: consentError } = await f.admin.from('consents').insert({
    customer_id: cust(0).customerId,
    consent_type: 'marketing',
    granted: true,
    source: 'test',
  });
  if (consentError) throw consentError;

  await ticket({ ...main(), customer_id: cust(1).customerId, ...done(120) });
  await ticket({ ...closed(), customer_id: cust(1).customerId, ...done(5) });

  for (const d of [30, 31, 32]) {
    await ticket({
      ...main(),
      customer_id: cust(2).customerId,
      state: 'no_show',
      created_at: at(d),
      no_show_at: at(d, '10:20'),
    });
  }
  await ticket({ ...main(), customer_id: cust(2).customerId, ...done(2) });

  const { error: apptError } = await f.admin.from('appointments').insert({
    customer_id: cust(3).customerId,
    branch_id: f.branchId,
    branch_service_id: f.branchServiceId,
    scheduled_start: `${dateAt(2)}T10:00:00.000Z`,
    scheduled_end: `${dateAt(2)}T10:30:00.000Z`,
    status: 'scheduled',
    created_by: 'customer',
  });
  if (apptError) throw apptError;

  const { data: walkIn, error: walkInError } = await f.admin
    .from('customers')
    .insert({ name: `CL Walk-in ${f.suffix}`, phone_e164: `+233558${f.suffix.slice(-5)}9` })
    .select('id')
    .single();
  if (walkInError) throw walkInError;
  walkInId = walkIn.id;
  await ticket({ ...main(), customer_id: walkInId, ...done(3) });
}, 120000);

afterAll(async () => {
  const ids = [...f.customers.map((c) => c.customerId), walkInId].filter(Boolean);
  const { error: msgError } = await f.admin
    .from('notifications')
    .delete()
    .eq('notification_type', 'staff_message')
    .in('recipient_id', ids);
  if (msgError) throw msgError;
  const { error: consentError } = await f.admin.from('consents').delete().in('customer_id', ids);
  if (consentError) throw consentError;
  for (const login of [manager, reception, analyst, otherManager]) await cleanupStaffLogin(f, login);
  await cleanupAppointmentFixture(f);
  if (walkInId) {
    const { error } = await f.admin.from('customers').delete().eq('id', walkInId);
    if (error) throw error;
  }
}, 90000);

describe('list_customers', () => {
  it('lists the branch customers newest visit first with in-branch numbers and groups', async () => {
    const { data, error } = await list(manager.client, [f.branchId]);
    expect(error).toBeNull();
    const r = data as J;
    expect(r.has_more).toBe(false);
    expect(r.rows.map((x: J) => x.id)).toEqual([
      cust(0).customerId,
      cust(2).customerId,
      walkInId,
      cust(1).customerId,
      cust(3).customerId,
    ]);
    expect(r.rows[0]).toMatchObject({
      name: 'Appt Customer 0',
      phone: local(cust(0).phone),
      visits: 3,
      no_shows: 0,
      avg_rating_given: 4.5,
      group: 'frequent',
    });
    expect(r.rows.map((x: J) => x.group)).toEqual(['frequent', 'at_risk', 'returning', 'lapsed', 'new']);
    expect(r.rows[1]).toMatchObject({ visits: 1, no_shows: 3 });
    expect(r.rows[4]).toMatchObject({ visits: 0, last_visit_at: null, avg_rating_given: null });
  });

  it('counts both branches for an analyst and masks phones', async () => {
    const { data, error } = await list(analyst.client, [f.branchId, f.closedBranchId]);
    expect(error).toBeNull();
    const rows = (data as J).rows as J[];
    const c0 = rows.find((x) => x.id === cust(0).customerId)!;
    const c1 = rows.find((x) => x.id === cust(1).customerId)!;
    expect(c0).toMatchObject({ visits: 4, phone: masked(cust(0).phone) });
    expect(c1).toMatchObject({ visits: 2, group: 'returning' });
  });

  it('searches by name and by phone with or without the leading 0', async () => {
    const byName = (await list(manager.client, [f.branchId], 'customer 2')).data as J;
    expect(byName.rows.map((x: J) => x.id)).toEqual([cust(2).customerId]);
    const byLocal = (await list(manager.client, [f.branchId], local(cust(0).phone))).data as J;
    expect(byLocal.rows.map((x: J) => x.id)).toEqual([cust(0).customerId]);
    const byDigits = (await list(manager.client, [f.branchId], local(cust(0).phone).slice(1))).data as J;
    expect(byDigits.rows.map((x: J) => x.id)).toEqual([cust(0).customerId]);
  });

  it('filters by group and pages by offset', async () => {
    const lapsed = (await list(manager.client, [f.branchId], null, 'lapsed')).data as J;
    expect(lapsed.rows.map((x: J) => x.id)).toEqual([cust(1).customerId]);
    const page = (await list(manager.client, [f.branchId], null, null, 3)).data as J;
    expect(page.rows.map((x: J) => x.id)).toEqual([cust(1).customerId, cust(3).customerId]);
    expect(page.has_more).toBe(false);
    expect((await list(manager.client, [f.branchId], null, 'bogus')).error?.message).toBe('invalid_group');
  });

  it('refuses barbers, empty branch lists and branches outside scope', async () => {
    expect((await list(f.barberClient, [f.branchId])).error?.message).toBe('not_allowed');
    expect((await list(manager.client, [])).error?.message).toBe('not_allowed');
    expect((await list(manager.client, [f.closedBranchId])).error?.message).toBe('not_allowed');
  });
});

describe('customer_detail', () => {
  it('shows a customer with in-branch history, feedback and settings', async () => {
    const { data, error } = await manager.client.rpc('customer_detail', {
      p_customer_id: cust(0).customerId,
      p_branch_ids: [f.branchId],
    });
    expect(error).toBeNull();
    const d = data as J;
    expect(d.customer).toMatchObject({
      name: 'Appt Customer 0',
      phone: local(cust(0).phone),
      requires_confirmation_call: false,
      marketing_allowed: true,
    });
    expect(d.stats).toMatchObject({
      visits: 3,
      appointments: 0,
      no_shows: 0,
      cancellations: 0,
      late_cancellations: 0,
      avg_rating_given: 4.5,
      visits_last_90_days: 3,
    });
    expect(d.group).toBe('frequent');
    expect(d.branch_ids).toEqual([f.branchId]);
    expect(d.visits).toHaveLength(3);
    expect(d.visits[0]).toMatchObject({
      branch_name: `Appt Main ${f.suffix}`,
      service_name: `Appt Service ${f.suffix}`,
      barber_name: 'Appt Barber a',
      state: 'completed',
    });
    // Newest first: the 'Great cut' row was inserted after 'Good cut'.
    expect(d.feedback.map((x: J) => x.comment)).toEqual(['Great cut', 'Good cut']);
    expect(d.messages).toEqual([]);
  });

  it('masks the phone for analysts and counts every requested branch', async () => {
    const { data } = await analyst.client.rpc('customer_detail', {
      p_customer_id: cust(0).customerId,
      p_branch_ids: [f.branchId, f.closedBranchId],
    });
    const d = data as J;
    expect(d.customer.phone).toBe(masked(cust(0).phone));
    expect(d.stats.visits).toBe(4);
    expect([...d.branch_ids].sort()).toEqual([f.branchId, f.closedBranchId].sort());
  });

  it('refuses out-of-scope callers and hides customers not seen at the branch', async () => {
    const outOfScope = await otherManager.client.rpc('customer_detail', {
      p_customer_id: cust(0).customerId,
      p_branch_ids: [f.branchId],
    });
    expect(outOfScope.error?.message).toBe('not_allowed');
    const notSeen = await otherManager.client.rpc('customer_detail', {
      p_customer_id: cust(3).customerId,
      p_branch_ids: [f.closedBranchId],
    });
    expect(notSeen.error?.message).toBe('not_found');
    const barber = await f.barberClient.rpc('customer_detail', {
      p_customer_id: cust(0).customerId,
      p_branch_ids: [f.branchId],
    });
    expect(barber.error?.message).toBe('not_allowed');
  });
});

describe('send_customer_message', () => {
  const send = (
    client: typeof manager.client,
    text: string,
    branch = f.branchId,
    customer = cust(0).customerId,
  ) =>
    client.rpc('send_customer_message', {
      p_customer_id: customer,
      p_branch_id: branch,
      p_text: text,
    });

  it('checks the text, the caller and the branch', async () => {
    expect((await send(reception.client, '   ')).error?.message).toBe('empty_message');
    expect((await send(reception.client, 'x'.repeat(141))).error?.message).toBe('message_too_long');
    expect((await send(analyst.client, 'Hello')).error?.message).toBe('not_allowed');
    expect((await send(reception.client, 'Hello', f.closedBranchId)).error?.message).toBe('not_allowed');
    expect(
      (await send(otherManager.client, 'Hello', f.closedBranchId, cust(3).customerId)).error?.message,
    ).toBe('not_found');
  });

  it('queues a staff_message and stops at 5 per branch per day', async () => {
    const { data: id, error } = await send(
      reception.client,
      '  Your barber is running 15 minutes late.  ',
    );
    expect(error).toBeNull();
    const { data: row } = await f.admin
      .from('notifications')
      .select('recipient_type, recipient_id, notification_type, payload')
      .eq('id', id as string)
      .single();
    expect(row).toMatchObject({
      recipient_type: 'customer',
      recipient_id: cust(0).customerId,
      notification_type: 'staff_message',
      payload: {
        text: 'Your barber is running 15 minutes late.',
        branch_id: f.branchId,
        branch_name: `Appt Main ${f.suffix}`,
        sent_by_staff_id: reception.staffUserId,
      },
    });
    for (let i = 2; i <= 5; i++) expect((await send(reception.client, `Note ${i}`)).error).toBeNull();
    expect((await send(reception.client, 'One too many')).error?.message).toBe('daily_limit');

    const { data } = await manager.client.rpc('customer_detail', {
      p_customer_id: cust(0).customerId,
      p_branch_ids: [f.branchId],
    });
    const messages = (data as J).messages as J[];
    expect(messages).toHaveLength(5);
    expect(messages[4]).toMatchObject({
      text: 'Your barber is running 15 minutes late.',
      sent_by_name: reception.name,
      branch_name: `Appt Main ${f.suffix}`,
    });
  });
});
```
(The queued row's `channel`/`status` are not asserted: once Task 2 is deployed, the live 30-second sender may already have delivered or failed it; the payload is what this task owns.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/db/customer-list.test.ts`
Expected: FAIL (`list_customers` not found).

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261008100000_customer_list.sql`:
```sql
-- Customer list (Docs/superpowers/specs/2026-10-08-customer-list-design.md): staff see the
-- customers of their branches with in-branch numbers and groups, open one customer's history, and
-- send a short service message (a staff_message notification delivered by send-notifications).

insert into capabilities (key, description) values
  ('view_customers', 'View the customer list')
on conflict do nothing;

insert into role_capabilities (role, capability) values
  ('owner', 'view_customers'),
  ('branch_manager', 'view_customers'),
  ('receptionist', 'view_customers'),
  ('analyst', 'view_customers')
on conflict do nothing;

-- 0244123456 for staff who message customers; 024•••3456 for everyone else.
create or replace function staff_phone(p_e164 text, p_full boolean)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_e164 is null then null
    when p_full then l
    else left(l, 3) || '•••' || right(l, 4)
  end
  from (select case when p_e164 like '+233%' then '0' || substr(p_e164, 5) else p_e164 end as l) x;
$$;

revoke execute on function staff_phone(text, boolean) from public, anon, authenticated;

-- Every visible customer (a ticket or appointment at one of p_branch_ids, not anonymized) with
-- numbers counted at those branches only, and the group they fall in. Internal: callers check
-- access first.
create or replace function customer_scope_stats(p_branch_ids uuid[])
returns table (
  customer_id uuid,
  visits integer,
  last_visit_at timestamptz,
  no_shows integer,
  cancellations integer,
  visits_last_90_days integer,
  avg_rating_given numeric,
  customer_group text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with visible as (
    select qt.customer_id from queue_tickets qt where qt.branch_id = any(p_branch_ids)
    union
    select a.customer_id from appointments a where a.branch_id = any(p_branch_ids)
  ),
  t as (
    select
      qt.customer_id,
      count(*) filter (where qt.state = 'completed') as visits,
      max(coalesce(qt.completed_at, qt.updated_at)) filter (where qt.state = 'completed') as last_visit_at,
      count(*) filter (where qt.state = 'no_show') as no_shows,
      count(*) filter (where qt.state = 'cancelled') as cancellations,
      count(*) filter (where qt.state = 'completed'
                         and coalesce(qt.completed_at, qt.updated_at) > now() - interval '90 days') as v90
    from queue_tickets qt
    where qt.branch_id = any(p_branch_ids)
    group by qt.customer_id
  ),
  fb as (
    select f.customer_id, round(avg(f.overall_rating), 2) as avg_rating
    from feedback f
    where f.branch_id = any(p_branch_ids)
    group by f.customer_id
  )
  select
    c.id,
    coalesce(t.visits, 0)::int,
    t.last_visit_at,
    coalesce(t.no_shows, 0)::int,
    coalesce(t.cancellations, 0)::int,
    coalesce(t.v90, 0)::int,
    fb.avg_rating,
    case
      when coalesce(t.visits, 0) = 0 then 'new'
      when t.last_visit_at < now() - interval '90 days' then 'lapsed'
      when coalesce(t.no_shows, 0) >= 3 or c.late_cancellation_count >= 3 then 'at_risk'
      when coalesce(t.v90, 0) >= 3 then 'frequent'
      else 'returning'
    end
  from (select distinct v.customer_id from visible v) v
  join customers c on c.id = v.customer_id and not c.is_anonymized
  left join t on t.customer_id = c.id
  left join fb on fb.customer_id = c.id;
$$;

revoke execute on function customer_scope_stats(uuid[]) from public, anon, authenticated;

-- Shared access check: view_customers, a non-empty branch list, every branch in scope. Returns the
-- de-duplicated branch ids.
create or replace function check_customer_access(p_branch_ids uuid[])
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[] := array(select distinct b from unnest(p_branch_ids) as b where b is not null);
  v_branch uuid;
begin
  if cardinality(v_ids) = 0 or not has_capability('view_customers') then
    raise exception 'not_allowed';
  end if;
  foreach v_branch in array v_ids loop
    if not in_branch_scope(v_branch) then
      raise exception 'not_allowed';
    end if;
  end loop;
  return v_ids;
end;
$$;

revoke execute on function check_customer_access(uuid[]) from public, anon, authenticated;

create or replace function list_customers(
  p_branch_ids uuid[],
  p_search text,
  p_group text,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_digits text;
  v_full boolean := has_capability('message_customers');
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_result jsonb;
begin
  v_ids := check_customer_access(p_branch_ids);
  if p_group is not null and p_group not in ('new', 'returning', 'frequent', 'lapsed', 'at_risk') then
    raise exception 'invalid_group';
  end if;
  v_digits := regexp_replace(coalesce(v_search, ''), '\D', '', 'g');
  if length(v_digits) >= 3 then
    if left(v_digits, 1) = '0' then
      v_digits := '233' || substr(v_digits, 2);
    end if;
  else
    v_digits := null;
  end if;

  with matched as (
    select s.*, c.name, c.phone_e164
    from customer_scope_stats(v_ids) s
    join customers c on c.id = s.customer_id
    where (p_group is null or s.customer_group = p_group)
      and (
        v_search is null
        or (v_digits is not null
            and regexp_replace(coalesce(c.phone_e164, ''), '\D', '', 'g') like '%' || v_digits || '%')
        or (v_digits is null and c.name ilike '%' || v_search || '%')
      )
  ),
  ranked as (
    select m.*, row_number() over (order by m.last_visit_at desc nulls last, m.name, m.customer_id) as rn
    from matched m
  ),
  page as (
    select * from ranked where rn > v_offset and rn <= v_offset + 51
  )
  select jsonb_build_object(
    'rows', coalesce(jsonb_agg(jsonb_build_object(
      'id', p.customer_id,
      'name', p.name,
      'phone', staff_phone(p.phone_e164, v_full),
      'last_visit_at', p.last_visit_at,
      'visits', p.visits,
      'no_shows', p.no_shows,
      'avg_rating_given', p.avg_rating_given,
      'group', p.customer_group
    ) order by p.rn) filter (where p.rn <= v_offset + 50), '[]'::jsonb),
    'has_more', count(*) > 50
  )
  into v_result
  from page p;

  return v_result;
end;
$$;

revoke execute on function list_customers(uuid[], text, text, integer) from public, anon;
grant execute on function list_customers(uuid[], text, text, integer) to authenticated;

create or replace function customer_detail(p_customer_id uuid, p_branch_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
  v_full boolean := has_capability('message_customers');
  v_stats record;
  v_c customers%rowtype;
  v_marketing boolean;
begin
  v_ids := check_customer_access(p_branch_ids);
  select * into v_stats from customer_scope_stats(v_ids) s where s.customer_id = p_customer_id;
  if not found then
    raise exception 'not_found';
  end if;
  select * into v_c from customers where id = p_customer_id;
  select granted into v_marketing
  from consents
  where customer_id = p_customer_id and consent_type = 'marketing'
  order by created_at desc
  limit 1;

  return jsonb_build_object(
    'customer', jsonb_build_object(
      'id', v_c.id,
      'name', v_c.name,
      'phone', staff_phone(v_c.phone_e164, v_full),
      'email', v_c.email,
      'requires_confirmation_call', v_c.requires_confirmation_call,
      'push_enabled', v_c.push_enabled,
      'sms_backup_enabled', v_c.sms_backup_enabled,
      'marketing_allowed', coalesce(v_marketing, false)
    ),
    'stats', jsonb_build_object(
      'visits', v_stats.visits,
      'last_visit_at', v_stats.last_visit_at,
      'appointments', (
        select count(*) from appointments a
        where a.customer_id = p_customer_id and a.branch_id = any(v_ids)
      ),
      'no_shows', v_stats.no_shows,
      'cancellations', v_stats.cancellations,
      'late_cancellations', v_c.late_cancellation_count,
      'avg_rating_given', v_stats.avg_rating_given,
      'visits_last_90_days', v_stats.visits_last_90_days
    ),
    'group', v_stats.customer_group,
    'branch_ids', (
      select coalesce(jsonb_agg(b order by b), '[]'::jsonb)
      from unnest(v_ids) as b
      where exists (select 1 from queue_tickets qt where qt.customer_id = p_customer_id and qt.branch_id = b)
         or exists (select 1 from appointments a where a.customer_id = p_customer_id and a.branch_id = b)
    ),
    'visits', (
      select coalesce(jsonb_agg(q.x order by q.at desc), '[]'::jsonb)
      from (
        select t.created_at as at, jsonb_build_object(
          'ticket_id', t.id,
          'created_at', t.created_at,
          'branch_name', b.name,
          'service_name', s.name,
          'barber_name', su.name,
          'state', t.state,
          'cancel_reason', t.cancel_reason
        ) as x
        from queue_tickets t
        join branches b on b.id = t.branch_id
        join branch_services bs on bs.id = t.branch_service_id
        join services s on s.id = bs.service_id
        left join barbers br on br.id = t.assigned_barber_id
        left join staff_users su on su.id = br.staff_user_id
        where t.customer_id = p_customer_id and t.branch_id = any(v_ids)
        order by t.created_at desc
        limit 50
      ) q
    ),
    'feedback', (
      select coalesce(jsonb_agg(q.x order by q.at desc), '[]'::jsonb)
      from (
        select f.created_at as at, jsonb_build_object(
          'created_at', f.created_at,
          'branch_name', b.name,
          'barber_name', su.name,
          'overall_rating', f.overall_rating,
          'comment', f.comment
        ) as x
        from feedback f
        join branches b on b.id = f.branch_id
        left join barbers br on br.id = f.barber_id
        left join staff_users su on su.id = br.staff_user_id
        where f.customer_id = p_customer_id and f.branch_id = any(v_ids)
        order by f.created_at desc
        limit 20
      ) q
    ),
    'messages', (
      select coalesce(jsonb_agg(q.x order by q.at desc), '[]'::jsonb)
      from (
        select n.created_at as at, jsonb_build_object(
          'id', n.id,
          'created_at', n.created_at,
          'branch_name', n.payload->>'branch_name',
          'sent_by_name', su.name,
          'text', n.payload->>'text',
          'status', n.status,
          'failed_reason', n.failed_reason
        ) as x
        from notifications n
        left join staff_users su on su.id = (n.payload->>'sent_by_staff_id')::uuid
        where n.recipient_type = 'customer'
          and n.recipient_id = p_customer_id
          and n.notification_type = 'staff_message'
          and (n.payload->>'branch_id')::uuid = any(v_ids)
        order by n.created_at desc
        limit 20
      ) q
    )
  );
end;
$$;

revoke execute on function customer_detail(uuid, uuid[]) from public, anon;
grant execute on function customer_detail(uuid, uuid[]) to authenticated;

create or replace function send_customer_message(p_customer_id uuid, p_branch_id uuid, p_text text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_text text := btrim(coalesce(p_text, ''));
  v_day_start timestamptz :=
    ((now() at time zone 'Africa/Accra')::date)::timestamp at time zone 'Africa/Accra';
  v_branch_name text;
  v_id uuid;
begin
  if p_branch_id is null
     or not (has_capability('message_customers') and in_branch_scope(p_branch_id)) then
    raise exception 'not_allowed';
  end if;
  if not exists (
    select 1 from customer_scope_stats(array[p_branch_id]) s where s.customer_id = p_customer_id
  ) then
    raise exception 'not_found';
  end if;
  if v_text = '' then
    raise exception 'empty_message';
  end if;
  if char_length(v_text) > 140 then
    raise exception 'message_too_long';
  end if;
  if (
    select count(*) from notifications n
    where n.recipient_type = 'customer'
      and n.recipient_id = p_customer_id
      and n.notification_type = 'staff_message'
      and n.payload->>'branch_id' = p_branch_id::text
      and n.created_at >= v_day_start
  ) >= 5 then
    raise exception 'daily_limit';
  end if;
  select name into v_branch_name from branches where id = p_branch_id;
  insert into notifications (recipient_type, recipient_id, channel, notification_type, payload)
  values (
    'customer',
    p_customer_id,
    'sms',
    'staff_message',
    jsonb_build_object(
      'text', v_text,
      'branch_id', p_branch_id,
      'branch_name', v_branch_name,
      'sent_by_staff_id', auth_staff_id()
    )
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function send_customer_message(uuid, uuid, text) from public, anon;
grant execute on function send_customer_message(uuid, uuid, text) to authenticated;
```

- [ ] **Step 4: Update the database types**

In `packages/shared/src/database.types.ts` `Functions` (true alphabetical order):
```typescript
      customer_detail: {
        Args: { p_customer_id: string; p_branch_ids: string[] };
        Returns: Json;
      };
      list_customers: {
        Args: {
          p_branch_ids: string[];
          p_search: string | null;
          p_group: string | null;
          p_offset?: number;
        };
        Returns: Json;
      };
      send_customer_message: {
        Args: { p_customer_id: string; p_branch_id: string; p_text: string };
        Returns: string;
      };
```
(The helpers `staff_phone`, `customer_scope_stats` and `check_customer_access` are not callable by clients, so they get no types.)
Run: `npm run typecheck` — Expected: no errors.

- [ ] **Step 5: Commit and hand over for the push**

```bash
git add supabase/migrations/20261008100000_customer_list.sql tests/db/customer-list.test.ts packages/shared/src/database.types.ts
git commit -m "feat: customer list, customer detail and send-message functions"
```
Report "ready for push". After the push: `npx vitest run tests/db/customer-list.test.ts` — Expected: PASS. If a value differs after the push, fix the SQL in a new migration file (the pushed one is never edited).

---

### Task 2: Delivering staff messages

**Files:**
- Create: `supabase/migrations/20261008100100_staff_message_claim.sql`
- Modify: `supabase/functions/_shared/notification-sms-core.ts`
- Modify: `supabase/functions/_shared/notification-push-core.ts`
- Modify: `supabase/functions/send-notifications/index.ts`
- Modify: `tests/unit/notification-sms-core.test.ts`, `tests/unit/notification-push-core.test.ts`
- Create: `tests/db/staff-message-sending.test.ts`

**Interfaces:**
- Consumes: Task 1's `send_customer_message`; existing `claim_sms_notifications(p_types text[], p_limit int)` (latest definition in `supabase/migrations/20261007100200_feedback_request_claim.sql`); `callFunction` from `tests/db/fixtures/staff-invite.ts`.
- Produces: claim column `message_text text`; `branch_name` falls back to `payload->>'branch_name'`; `ClaimedNotification.message_text?: string | null`; `SMS_NOTIFICATION_TYPES` includes `'staff_message'`; `buildNotificationSms('staff_message', { branchName, ticketNumber, link, text })`; `buildPushPayload('staff_message', n)`.

- [ ] **Step 1: Write the failing unit tests**

In `tests/unit/notification-sms-core.test.ts` add (reuse the file's existing `row()` helper; add `buildNotificationSms`, `precheckNotification`, `SMS_NOTIFICATION_TYPES` and the `ClaimedNotification` type to its imports if missing):
```typescript
describe('staff_message', () => {
  const message = (overrides: Partial<ClaimedNotification> = {}) =>
    row({
      notification_type: 'staff_message',
      ticket_id: null,
      ticket_state: null,
      ticket_number: null,
      branch_name: 'Osu Branch',
      message_text: 'Your barber is running 15 minutes late.',
      created_at: '2026-10-08T12:00:00Z',
      ...overrides,
    });

  it('is claimed by the sender', () => {
    expect(SMS_NOTIFICATION_TYPES).toContain('staff_message');
  });

  it('is never stale while it has text, and expires like the rest', () => {
    expect(precheckNotification(message(), new Date('2026-10-08T12:05:00Z'))).toEqual({
      action: 'continue',
    });
    expect(
      precheckNotification(message({ message_text: null }), new Date('2026-10-08T12:05:00Z')),
    ).toEqual({ action: 'skip', reason: 'stale' });
    expect(precheckNotification(message(), new Date('2026-10-08T12:11:00Z'))).toEqual({
      action: 'skip',
      reason: 'expired',
    });
  });

  it('texts the branch and the message', () => {
    expect(
      buildNotificationSms('staff_message', {
        branchName: 'Osu Branch',
        ticketNumber: '',
        link: '',
        text: 'Your barber is running 15 minutes late.',
      }),
    ).toBe('Pixel Barber (Osu Branch): Your barber is running 15 minutes late.');
  });
});
```

In `tests/unit/notification-push-core.test.ts` add:
```typescript
describe('staff_message push', () => {
  it('shows the branch in the title and the message as the body, opening the app', () => {
    const n = row({
      notification_type: 'staff_message',
      ticket_id: null,
      ticket_state: null,
      ticket_number: null,
      branch_name: 'Osu Branch',
      message_text: 'Your barber is running 15 minutes late.',
    });
    expect(buildPushPayload('staff_message', n)).toEqual({
      title: 'Pixel Barber · Osu Branch',
      body: 'Your barber is running 15 minutes late.',
      url: '/',
      tag: 'n1',
    });
    expect(pushUrgency('staff_message')).toBe('normal');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/unit/notification-sms-core.test.ts tests/unit/notification-push-core.test.ts --environment=node`
Expected: FAIL (`staff_message` not handled).

- [ ] **Step 3: Teach the cores the new type**

In `supabase/functions/_shared/notification-sms-core.ts`:
- Add `'staff_message'` as the last entry of `SMS_NOTIFICATION_TYPES`.
- Add to `ClaimedNotification`, after `ticket_has_feedback`:
```typescript
  /** staff_message only: the text a staff member wrote (payload->>'text'). */
  message_text?: string | null;
```
- At the top of `isStale`, before the reminder check:
```typescript
  // A staff message stands alone (no ticket or appointment); only a missing text makes it unusable.
  if (n.notification_type === 'staff_message') return !n.message_text;
```
- `buildNotificationSms`'s input type becomes `{ branchName: string; ticketNumber: string; link: string; slot?: string; text?: string }` and its switch gains:
```typescript
    case 'staff_message':
      return `Pixel Barber (${input.branchName}): ${input.text ?? ''}`;
```

In `supabase/functions/_shared/notification-push-core.ts`, `buildPushPayload`'s switch gains:
```typescript
    case 'staff_message':
      return {
        title: `Pixel Barber · ${branch}`,
        tag: n.notification_id,
        url: '/',
        body: n.message_text ?? '',
      };
```
(`pushUrgency` already returns `'normal'` for every type except `youre_next` / `your_turn`.)

In `supabase/functions/send-notifications/index.ts`, the `buildNotificationSms(type, { ... })` call gains `text: n.message_text ?? undefined,`.

Run: `npx vitest run tests/unit --environment=node` — Expected: PASS (all unit tests, including the existing sender tests; if an existing test pins the exact `SMS_NOTIFICATION_TYPES` list, add `'staff_message'` to its expectation).

- [ ] **Step 4: Return the message text from the claim**

Create `supabase/migrations/20261008100100_staff_message_claim.sql`:
```sql
-- Customer list: claim_sms_notifications also returns a staff_message's text, and takes the branch
-- name from the payload when the row has no ticket or appointment. Return columns change, so it is
-- dropped and recreated; otherwise identical to 20261007100200_feedback_request_claim.sql.

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
  push_subscriptions jsonb,
  ticket_has_feedback boolean,
  message_text text
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
         coalesce(b.name, ab.name, c.payload->>'branch_name'),
         a.id, a.status, a.scheduled_start, c.payload->>'slot',
         cu.push_enabled,
         coalesce(
           (select jsonb_agg(
                     jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh_key, 'auth', s.auth_key)
                     order by s.last_seen_at desc)
            from (select endpoint, p256dh_key, auth_key, last_seen_at
                  from push_subscriptions ps
                  where ps.customer_id = c.recipient_id
                  order by ps.last_seen_at desc
                  limit 10) s),
           '[]'::jsonb)
         , exists (select 1 from feedback fb where fb.ticket_id = c.related_ticket_id)
         , case when c.notification_type = 'staff_message' then c.payload->>'text' end
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

- [ ] **Step 5: Write the deployed-sender test**

Create `tests/db/staff-message-sending.test.ts`:
```typescript
// tests/db/staff-message-sending.test.ts
// @vitest-environment node
// send-notifications delivers staff_message rows (deployed, live SMS off): a message to a customer
// with no push devices takes the SMS path and ends not_allowlisted/sms_disabled (not stale).
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  cleanupStaffLogin,
  createAppointmentFixture,
  createStaffLogin,
  type AppointmentFixture,
} from './fixtures/appointments';
import { callFunction } from './fixtures/staff-invite';

let f: AppointmentFixture;
let reception: Awaited<ReturnType<typeof createStaffLogin>>;
const serviceRoleKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY!;

beforeAll(async () => {
  f = await createAppointmentFixture();
  reception = await createStaffLogin(f, 'smr', 'receptionist', f.branchId);
  const customer = f.customers[0]!;
  await f.admin.from('customers').update({ sms_backup_enabled: true }).eq('id', customer.customerId);
  const { error } = await f.admin.from('queue_tickets').insert({
    ticket_number: `PB-SM-${f.suffix}`,
    branch_id: f.branchId,
    customer_id: customer.customerId,
    branch_service_id: f.branchServiceId,
    state: 'completed',
    completed_at: new Date().toISOString(),
    created_by: 'customer',
  });
  if (error) throw error;
}, 90000);

afterAll(async () => {
  const { error } = await f.admin
    .from('notifications')
    .delete()
    .eq('notification_type', 'staff_message')
    .in(
      'recipient_id',
      f.customers.map((c) => c.customerId),
    );
  if (error) throw error;
  await cleanupStaffLogin(f, reception);
  await cleanupAppointmentFixture(f);
}, 90000);

describe('send-notifications with staff messages', () => {
  it('sends a staff message down the SMS path instead of skipping it', async () => {
    const { data: id, error } = await reception.client.rpc('send_customer_message', {
      p_customer_id: f.customers[0]!.customerId,
      p_branch_id: f.branchId,
      p_text: 'Your barber is running 15 minutes late.',
    });
    if (error) throw error;

    const deadline = Date.now() + 60_000;
    let row: { status: string; failed_reason: string | null } | null = null;
    while (Date.now() < deadline) {
      await callFunction('send-notifications', {}, serviceRoleKey());
      const { data } = await f.admin
        .from('notifications')
        .select('status, failed_reason')
        .eq('id', id as string)
        .single();
      row = data;
      if (row && row.status !== 'pending') break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(row?.status).toBe('failed');
    expect(['not_allowlisted', 'sms_disabled']).toContain(row?.failed_reason);
  }, 90000);
});
```

- [ ] **Step 6: Verify, commit and hand over**

- `npx vitest run tests/unit --environment=node` — PASS.
- `npm run typecheck` — no errors.
- `npx vitest run tests/db/staff-message-sending.test.ts` — Expected now: FAIL (the deployed sender doesn't claim `staff_message` yet, so the row stays `pending`). That is the RED for the deploy.
- `grep -n $'\xef\xbf\xbd'` on the edited files — nothing.

```bash
git add supabase/migrations/20261008100100_staff_message_claim.sql supabase/functions/_shared/notification-sms-core.ts supabase/functions/_shared/notification-push-core.ts supabase/functions/send-notifications/index.ts tests/unit/notification-sms-core.test.ts tests/unit/notification-push-core.test.ts tests/db/staff-message-sending.test.ts
git commit -m "feat: send-notifications delivers staff messages"
```
Report "ready for push and deploy". The controller pushes the migration, deploys `send-notifications`, then runs `npx vitest run tests/db/staff-message-sending.test.ts tests/db/feedback-request-sending.test.ts tests/db/push-sending.test.ts` — Expected: PASS.

---

### Task 3: Staff customer pages

**Files:**
- Create: `apps/staff/app/customers/customerTypes.ts`
- Create: `apps/staff/app/customers/customerLabels.ts`, `apps/staff/app/customers/customerLabels.test.ts`
- Create: `apps/staff/app/customers/page.tsx`
- Create: `apps/staff/app/customers/[id]/page.tsx`, `apps/staff/app/customers/[id]/MessageForm.tsx`
- Modify: `apps/staff/app/page.tsx`
- Modify: `apps/staff/messages/en.json`
- Create: `e2e/staff-customers.spec.ts`

**Interfaces:**
- Consumes: Task 1's `list_customers`, `customer_detail`, `send_customer_message` (shapes above); `loadManageableBranches` / `ManageableBranch` (`{ id, name, branch_code }`) from `apps/staff/app/settings/barbers/scope.ts`; `formatDay` and `formatRating` from `apps/staff/app/reports/format.ts`; `Metric` from `apps/staff/app/reports/Metric.tsx`.
- Produces: `customerLabels.ts` exports `deliveryLabel(status: string, failedReason: string | null): { key: 'sending' | 'delivered' | 'notDelivered'; reasonKey: 'reasonNoChannel' | 'reasonExpired' | 'reasonFailed' | null }`, `groupReason(group: CustomerGroup, stats: CustomerStats): { key: string; values: Record<string, string | number> }`, `visitOutcome(state: string, cancelReason: string | null): { key: string; reasonKey: string | null }`, `sendErrorKey(code: string | undefined): string`.

- [ ] **Step 1: Write the failing label tests**

Create `apps/staff/app/customers/customerLabels.test.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import { deliveryLabel, groupReason, sendErrorKey, visitOutcome } from './customerLabels';
import type { CustomerStats } from './customerTypes';

const stats: CustomerStats = {
  visits: 6,
  last_visit_at: '2026-06-01T10:40:00Z',
  appointments: 1,
  no_shows: 3,
  cancellations: 1,
  late_cancellations: 2,
  avg_rating_given: 4.5,
  visits_last_90_days: 4,
};

describe('deliveryLabel', () => {
  it('maps notification states to what staff see', () => {
    expect(deliveryLabel('pending', null)).toEqual({ key: 'sending', reasonKey: null });
    for (const s of ['sent', 'delivered', 'fallback_sent']) {
      expect(deliveryLabel(s, null)).toEqual({ key: 'delivered', reasonKey: null });
    }
    for (const r of ['sms_disabled', 'not_allowlisted', 'opted_out', 'no_phone']) {
      expect(deliveryLabel('failed', r)).toEqual({ key: 'notDelivered', reasonKey: 'reasonNoChannel' });
    }
    expect(deliveryLabel('failed', 'expired')).toEqual({
      key: 'notDelivered',
      reasonKey: 'reasonExpired',
    });
    expect(deliveryLabel('failed', 'provider_error')).toEqual({
      key: 'notDelivered',
      reasonKey: 'reasonFailed',
    });
  });
});

describe('groupReason', () => {
  it('states the fact behind each group', () => {
    expect(groupReason('new', stats)).toEqual({ key: 'reasonNew', values: {} });
    expect(groupReason('lapsed', stats)).toEqual({ key: 'reasonLapsed', values: { date: 'Mon 1 Jun' } });
    expect(groupReason('at_risk', stats)).toEqual({
      key: 'reasonAtRisk',
      values: { noShows: 3, late: 2 },
    });
    expect(groupReason('frequent', stats)).toEqual({ key: 'reasonFrequent', values: { count: 4 } });
    expect(groupReason('returning', stats)).toEqual({ key: 'reasonReturning', values: { count: 6 } });
  });
});

describe('visitOutcome', () => {
  it('names served, no-show, cancelled and live visits', () => {
    expect(visitOutcome('completed', null)).toEqual({ key: 'served', reasonKey: null });
    expect(visitOutcome('no_show', null)).toEqual({ key: 'noShow', reasonKey: null });
    expect(visitOutcome('cancelled', 'wait_too_long')).toEqual({
      key: 'cancelled',
      reasonKey: 'reasons.wait_too_long',
    });
    expect(visitOutcome('cancelled', null)).toEqual({ key: 'cancelledNoReason', reasonKey: null });
    expect(visitOutcome('in_service', null)).toEqual({ key: 'inService', reasonKey: null });
    expect(visitOutcome('waiting', null)).toEqual({ key: 'inQueue', reasonKey: null });
  });
});

describe('sendErrorKey', () => {
  it('maps send errors to copy keys', () => {
    expect(sendErrorKey('empty_message')).toBe('emptyMessage');
    expect(sendErrorKey('message_too_long')).toBe('tooLong');
    expect(sendErrorKey('daily_limit')).toBe('dailyLimit');
    expect(sendErrorKey('not_allowed')).toBe('sendFailed');
    expect(sendErrorKey(undefined)).toBe('sendFailed');
  });
});
```
(2026-06-01 is a Monday; `formatDay` returns `Mon 1 Jun`.)

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/staff/app/customers --environment=node`
Expected: FAIL (cannot find `./customerLabels`).

- [ ] **Step 3: Write the types and labels**

Create `apps/staff/app/customers/customerTypes.ts`:
```typescript
// Shapes of list_customers() and customer_detail()
// (supabase/migrations/20261008100000_customer_list.sql).
export type CustomerGroup = 'new' | 'returning' | 'frequent' | 'lapsed' | 'at_risk';

export interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
  last_visit_at: string | null;
  visits: number;
  no_shows: number;
  avg_rating_given: number | null;
  group: CustomerGroup;
}

export interface CustomerList {
  rows: CustomerRow[];
  has_more: boolean;
}

export interface CustomerStats {
  visits: number;
  last_visit_at: string | null;
  appointments: number;
  no_shows: number;
  cancellations: number;
  late_cancellations: number;
  avg_rating_given: number | null;
  visits_last_90_days: number;
}

export interface CustomerDetail {
  customer: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    requires_confirmation_call: boolean;
    push_enabled: boolean;
    sms_backup_enabled: boolean;
    marketing_allowed: boolean;
  };
  stats: CustomerStats;
  group: CustomerGroup;
  branch_ids: string[];
  visits: {
    ticket_id: string;
    created_at: string;
    branch_name: string;
    service_name: string;
    barber_name: string | null;
    state: string;
    cancel_reason: string | null;
  }[];
  feedback: {
    created_at: string;
    branch_name: string;
    barber_name: string | null;
    overall_rating: number;
    comment: string | null;
  }[];
  messages: {
    id: string;
    created_at: string;
    branch_name: string | null;
    sent_by_name: string | null;
    text: string | null;
    status: string;
    failed_reason: string | null;
  }[];
}
```

Create `apps/staff/app/customers/customerLabels.ts`:
```typescript
// Copy-key mapping for the customer pages (Docs/superpowers/specs/2026-10-08-customer-list-design.md).
import { formatDay } from '../reports/format';
import type { CustomerGroup, CustomerStats } from './customerTypes';

const NO_CHANNEL = new Set(['sms_disabled', 'not_allowlisted', 'opted_out', 'no_phone']);

export function deliveryLabel(
  status: string,
  failedReason: string | null,
): {
  key: 'sending' | 'delivered' | 'notDelivered';
  reasonKey: 'reasonNoChannel' | 'reasonExpired' | 'reasonFailed' | null;
} {
  if (status === 'pending') return { key: 'sending', reasonKey: null };
  if (status === 'sent' || status === 'delivered' || status === 'fallback_sent') {
    return { key: 'delivered', reasonKey: null };
  }
  if (failedReason && NO_CHANNEL.has(failedReason)) {
    return { key: 'notDelivered', reasonKey: 'reasonNoChannel' };
  }
  if (failedReason === 'expired') return { key: 'notDelivered', reasonKey: 'reasonExpired' };
  return { key: 'notDelivered', reasonKey: 'reasonFailed' };
}

export function groupReason(
  group: CustomerGroup,
  stats: CustomerStats,
): { key: string; values: Record<string, string | number> } {
  switch (group) {
    case 'new':
      return { key: 'reasonNew', values: {} };
    case 'lapsed':
      return {
        key: 'reasonLapsed',
        values: { date: stats.last_visit_at ? formatDay(stats.last_visit_at) : '' },
      };
    case 'at_risk':
      return {
        key: 'reasonAtRisk',
        values: { noShows: stats.no_shows, late: stats.late_cancellations },
      };
    case 'frequent':
      return { key: 'reasonFrequent', values: { count: stats.visits_last_90_days } };
    case 'returning':
      return { key: 'reasonReturning', values: { count: stats.visits } };
  }
}

export function visitOutcome(
  state: string,
  cancelReason: string | null,
): { key: string; reasonKey: string | null } {
  if (state === 'completed') return { key: 'served', reasonKey: null };
  if (state === 'no_show') return { key: 'noShow', reasonKey: null };
  if (state === 'cancelled') {
    return cancelReason
      ? { key: 'cancelled', reasonKey: `reasons.${cancelReason}` }
      : { key: 'cancelledNoReason', reasonKey: null };
  }
  if (state === 'in_service') return { key: 'inService', reasonKey: null };
  return { key: 'inQueue', reasonKey: null };
}

export function sendErrorKey(code: string | undefined): string {
  switch (code) {
    case 'empty_message':
      return 'emptyMessage';
    case 'message_too_long':
      return 'tooLong';
    case 'daily_limit':
      return 'dailyLimit';
    default:
      return 'sendFailed';
  }
}
```

Run: `npx vitest run apps/staff/app/customers --environment=node` — Expected: PASS.

- [ ] **Step 4: Add the copy**

In `apps/staff/messages/en.json`: `Home` gains `"customersLink": "Customers"`; new namespace after `Reports`:
```json
  "Customers": {
    "title": "Customers",
    "branch": "Branch",
    "allBranches": "All branches",
    "search": "Search by name or phone",
    "group": "Group",
    "groups": {
      "all": "All groups",
      "new": "New",
      "returning": "Returning",
      "frequent": "Frequent",
      "lapsed": "Lapsed",
      "at_risk": "At risk"
    },
    "legend": "New: no visit yet. Lapsed: last visit over 90 days ago. At risk: 3 or more no-shows or late cancellations. Frequent: 3 or more visits in the last 90 days. Returning: everyone else.",
    "columns": {
      "name": "Name",
      "phone": "Phone",
      "lastVisit": "Last visit",
      "visits": "Visits",
      "noShows": "No-shows",
      "avgRating": "Average rating given",
      "group": "Group"
    },
    "showMore": "Show more",
    "noAccess": "You don't have access to this page.",
    "noBranches": "You don't manage any branches.",
    "loadFailed": "Couldn't load customers.",
    "empty": "No customers match.",
    "back": "Back to customers",
    "notFound": "We couldn't find this customer.",
    "detailLoadFailed": "Couldn't load this customer.",
    "contactTitle": "Contact",
    "phoneLabel": "Phone: {phone}",
    "emailLabel": "Email: {email}",
    "numbersTitle": "Numbers",
    "lastVisitLabel": "Last visit",
    "appointments": "Appointments",
    "cancellations": "Cancellations",
    "lateCancellations": "Late cancellations",
    "confirmationCall": "Confirmation call before appointments: {answer}",
    "yes": "Yes",
    "no": "No",
    "settingsTitle": "Settings",
    "appNotifications": "App notifications: {state}",
    "smsBackup": "SMS backup: {state}",
    "promotions": "Promotions: {state}",
    "on": "On",
    "off": "Off",
    "allowed": "Allowed",
    "notAllowed": "Not allowed",
    "reasonNew": "New: no visit yet",
    "reasonLapsed": "Lapsed: last visit {date}",
    "reasonAtRisk": "At risk: {noShows} no-shows, {late} late cancellations",
    "reasonFrequent": "Frequent: {count} visits in the last 90 days",
    "reasonReturning": "Returning: {count} visits",
    "historyTitle": "Visit history",
    "noVisits": "No visits yet.",
    "served": "Served",
    "noShow": "No-show",
    "cancelled": "Cancelled ({reason})",
    "cancelledNoReason": "Cancelled",
    "inService": "In service",
    "inQueue": "In the queue",
    "reasons": {
      "wait_too_long": "Wait too long",
      "cant_make_it": "Can't make it",
      "changed_plans": "Changed plans",
      "found_another_barber": "Found another barber",
      "emergency": "Emergency",
      "other": "Other"
    },
    "feedbackTitle": "Feedback",
    "noFeedback": "No feedback yet.",
    "stars": "{count, plural, one {# star} other {# stars}}",
    "messagesTitle": "Messages",
    "noMessages": "No messages yet.",
    "sentBy": "Sent by {name}",
    "sending": "Sending",
    "delivered": "Delivered",
    "notDelivered": "Not delivered",
    "reasonNoChannel": "No app notifications or SMS available",
    "reasonExpired": "Expired",
    "reasonFailed": "Failed",
    "messageTitle": "Message customer",
    "messageBranch": "Send from",
    "messageLabel": "Message",
    "charsLeft": "{count} characters left",
    "serviceNote": "For service messages about a visit, not promotions.",
    "send": "Send",
    "queued": "Message queued.",
    "emptyMessage": "Write a message first.",
    "tooLong": "Messages can be up to 140 characters.",
    "dailyLimit": "This customer has had 5 messages from this branch today.",
    "sendFailed": "Couldn't send. Please try again."
  }
```

- [ ] **Step 5: Write the list page**

Create `apps/staff/app/customers/page.tsx`:
```tsx
'use client';

// Customer list (Docs/superpowers/specs/2026-10-08-customer-list-design.md, Section 1): branch,
// search and group filters; 50 customers at a time with in-branch numbers and groups.
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import { loadManageableBranches, type ManageableBranch } from '../settings/barbers/scope';
import { formatDay, formatRating } from '../reports/format';
import type { CustomerGroup, CustomerList, CustomerRow } from './customerTypes';

const ALL = 'all';
const GROUPS: CustomerGroup[] = ['new', 'returning', 'frequent', 'lapsed', 'at_risk'];
const COLUMNS = ['name', 'phone', 'lastVisit', 'visits', 'noShows', 'avgRating', 'group'] as const;
const SEARCH_DELAY_MS = 400;

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Loaded =
  | { key: string; kind: 'ok'; rows: CustomerRow[]; hasMore: boolean }
  | { key: string; kind: 'error' };

export default function CustomersPage() {
  const t = useTranslations('Customers') as unknown as Translate;
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [canView, setCanView] = useState<boolean | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [branches, setBranches] = useState<ManageableBranch[]>([]);
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  const [branchesFailed, setBranchesFailed] = useState(false);
  const [selection, setSelection] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [moreFailed, setMoreFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    supabase.rpc('has_capability', { cap: 'view_customers' }).then(({ data }) => {
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
    supabase.rpc('auth_role').then(({ data }) => {
      if (!cancelled) setIsOwner(data === 'owner');
    });
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  // Search applies when typing pauses (or on Enter, below).
  useEffect(() => {
    const id = window.setTimeout(() => setSearch(searchText.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [searchText]);

  const ids = useMemo(
    () => (selection === ALL ? branches.map((b) => b.id) : selection ? [selection] : []),
    [selection, branches],
  );
  const requestKey = `${selection}:${search}:${group}`;

  useEffect(() => {
    if (ids.length === 0) return;
    let cancelled = false;
    const key = requestKey;
    supabase
      .rpc('list_customers', {
        p_branch_ids: ids,
        p_search: search || null,
        p_group: group || null,
        p_offset: 0,
      })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setLoaded({ key, kind: 'error' });
          return;
        }
        const list = data as unknown as CustomerList;
        setLoaded({ key, kind: 'ok', rows: list.rows, hasMore: list.has_more });
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, ids, search, group, requestKey]);

  const current = loaded && loaded.key === requestKey ? loaded : null;

  async function showMore() {
    if (current?.kind !== 'ok') return;
    setMoreFailed(false);
    const key = requestKey;
    const { data, error } = await supabase.rpc('list_customers', {
      p_branch_ids: ids,
      p_search: search || null,
      p_group: group || null,
      p_offset: current.rows.length,
    });
    if (error) {
      setMoreFailed(true);
      return;
    }
    const list = data as unknown as CustomerList;
    setLoaded((prev) =>
      prev && prev.key === key && prev.kind === 'ok'
        ? { ...prev, rows: [...prev.rows, ...list.rows], hasMore: list.has_more }
        : prev,
    );
  }

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
          <label htmlFor="customers-branch">{t('branch')}</label>
          <select
            id="customers-branch"
            value={selection ?? ''}
            onChange={(e) => setSelection(e.target.value)}
          >
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
            {isOwner && branches.length > 1 && <option value={ALL}>{t('allBranches')}</option>}
          </select>
          <label htmlFor="customers-search">{t('search')}</label>
          <input
            id="customers-search"
            type="search"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setSearch(searchText.trim());
            }}
          />
          <label htmlFor="customers-group">{t('group')}</label>
          <select id="customers-group" value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">{t('groups.all')}</option>
            {GROUPS.map((g) => (
              <option key={g} value={g}>
                {t(`groups.${g}`)}
              </option>
            ))}
          </select>
          <p>{t('legend')}</p>
        </div>
      )}
      {current?.kind === 'error' && <p role="alert">{t('loadFailed')}</p>}
      {current?.kind === 'ok' &&
        (current.rows.length === 0 ? (
          <p>{t('empty')}</p>
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th key={c} scope="col">
                      {t(`columns.${c}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {current.rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/customers/${r.id}?branch=${selection}`}>{r.name}</Link>
                    </td>
                    <td>{r.phone ?? '—'}</td>
                    <td>{r.last_visit_at ? formatDay(r.last_visit_at) : '—'}</td>
                    <td>{r.visits}</td>
                    <td>{r.no_shows}</td>
                    <td>{formatRating(r.avg_rating_given)}</td>
                    <td>{t(`groups.${r.group}`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {current.hasMore && (
              <button type="button" onClick={showMore}>
                {t('showMore')}
              </button>
            )}
            {moreFailed && <p role="alert">{t('loadFailed')}</p>}
          </>
        ))}
    </main>
  );
}
```

- [ ] **Step 6: Write the customer page and message form**

Create `apps/staff/app/customers/[id]/MessageForm.tsx`:
```tsx
'use client';

// Message customer (spec Section 2): branch, up to 140 characters, a service-only note.
import { useState } from 'react';
import type { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { ManageableBranch } from '../../settings/barbers/scope';
import { sendErrorKey } from '../customerLabels';

const MAX_LENGTH = 140;

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Supabase = ReturnType<typeof createBrowserSupabaseClient>;

export function MessageForm({
  supabase,
  customerId,
  branches,
  t,
  onSent,
}: {
  supabase: Supabase;
  customerId: string;
  branches: ManageableBranch[];
  t: Translate;
  onSent: () => void;
}) {
  const [branchId, setBranchId] = useState(branches[0]?.id ?? '');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setQueued(false);
    if (text.trim() === '') {
      setError(t('emptyMessage'));
      return;
    }
    setSending(true);
    const { error: rpcError } = await supabase.rpc('send_customer_message', {
      p_customer_id: customerId,
      p_branch_id: branchId,
      p_text: text,
    });
    setSending(false);
    if (rpcError) {
      setError(t(sendErrorKey(rpcError.message)));
      return;
    }
    setText('');
    setQueued(true);
    onSent();
  }

  return (
    <section aria-labelledby="customer-message">
      <h2 id="customer-message">{t('messageTitle')}</h2>
      <form onSubmit={send} noValidate>
        {branches.length > 1 && (
          <>
            <label htmlFor="message-branch">{t('messageBranch')}</label>
            <select
              id="message-branch"
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </>
        )}
        <label htmlFor="message-text">{t('messageLabel')}</label>
        <textarea
          id="message-text"
          maxLength={MAX_LENGTH}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <p>{t('charsLeft', { count: MAX_LENGTH - text.length })}</p>
        <p>{t('serviceNote')}</p>
        <button type="submit" disabled={sending}>
          {t('send')}
        </button>
        {error && <p role="alert">{error}</p>}
        {queued && <p>{t('queued')}</p>}
      </form>
    </section>
  );
}
```

Create `apps/staff/app/customers/[id]/page.tsx`:
```tsx
'use client';

// Customer page (Docs/superpowers/specs/2026-10-08-customer-list-design.md, Section 2): contact,
// group and reason, in-branch numbers, settings, visits, feedback, messages, and Message customer.
import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import { loadManageableBranches, type ManageableBranch } from '../../settings/barbers/scope';
import { formatDay, formatRating } from '../../reports/format';
import { Metric } from '../../reports/Metric';
import { deliveryLabel, groupReason, visitOutcome } from '../customerLabels';
import type { CustomerDetail } from '../customerTypes';
import { MessageForm } from './MessageForm';

const ALL = 'all';

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Supabase = ReturnType<typeof createBrowserSupabaseClient>;
type Loaded =
  | { scope: string; kind: 'ok'; detail: CustomerDetail }
  | { scope: string; kind: 'notFound' | 'error' };

function CustomerPageInner() {
  const t = useTranslations('Customers') as unknown as Translate;
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const { id } = useParams<{ id: string }>();
  const branchParam = useSearchParams().get('branch');
  const [canView, setCanView] = useState<boolean | null>(null);
  const [canMessage, setCanMessage] = useState(false);
  const [branches, setBranches] = useState<ManageableBranch[] | null>(null);
  const [branchesFailed, setBranchesFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let cancelled = false;
    supabase.rpc('has_capability', { cap: 'view_customers' }).then(({ data }) => {
      if (cancelled) return;
      setCanView(data === true);
      if (data !== true) return;
      loadManageableBranches(supabase)
        .then((list) => {
          if (!cancelled) setBranches(list);
        })
        .catch(() => {
          if (!cancelled) setBranchesFailed(true);
        });
    });
    supabase.rpc('has_capability', { cap: 'message_customers' }).then(({ data }) => {
      if (!cancelled) setCanMessage(data === true);
    });
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const ids = useMemo(() => {
    if (!branches) return [];
    if (branchParam && branchParam !== ALL && branches.some((b) => b.id === branchParam)) {
      return [branchParam];
    }
    return branches.map((b) => b.id);
  }, [branches, branchParam]);
  // The detail is keyed by customer + branches only, so a refresh after sending keeps the previous
  // detail on screen until the new one arrives.
  const scope = `${id}:${ids.join(',')}`;

  useEffect(() => {
    if (ids.length === 0) return;
    let cancelled = false;
    const key = scope;
    supabase
      .rpc('customer_detail', { p_customer_id: id, p_branch_ids: ids })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setLoaded({ scope: key, kind: error.message === 'not_found' ? 'notFound' : 'error' });
          return;
        }
        setLoaded({ scope: key, kind: 'ok', detail: data as unknown as CustomerDetail });
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, id, ids, scope, reloadKey]);

  const current = loaded && loaded.scope === scope ? loaded : null;

  return (
    <main>
      <Link href="/customers">{t('back')}</Link>
      {canView === false && <p>{t('noAccess')}</p>}
      {branchesFailed && <p role="alert">{t('detailLoadFailed')}</p>}
      {current?.kind === 'notFound' && <p>{t('notFound')}</p>}
      {current?.kind === 'error' && <p role="alert">{t('detailLoadFailed')}</p>}
      {current?.kind === 'ok' && (
        <CustomerView
          detail={current.detail}
          t={t}
          messageBranches={
            canMessage && branches
              ? branches.filter((b) => current.detail.branch_ids.includes(b.id))
              : []
          }
          supabase={supabase}
          onSent={() => setReloadKey((k) => k + 1)}
        />
      )}
    </main>
  );
}

function CustomerView({
  detail: d,
  t,
  messageBranches,
  supabase,
  onSent,
}: {
  detail: CustomerDetail;
  t: Translate;
  messageBranches: ManageableBranch[];
  supabase: Supabase;
  onSent: () => void;
}) {
  const reason = groupReason(d.group, d.stats);
  const onOff = (v: boolean) => t(v ? 'on' : 'off');
  return (
    <>
      <h1>{d.customer.name}</h1>
      <section aria-labelledby="customer-contact">
        <h2 id="customer-contact">{t('contactTitle')}</h2>
        {d.customer.phone && <p>{t('phoneLabel', { phone: d.customer.phone })}</p>}
        {d.customer.email && <p>{t('emailLabel', { email: d.customer.email })}</p>}
        <p>{t(reason.key, reason.values)}</p>
        <p>
          {t('confirmationCall', {
            answer: t(d.customer.requires_confirmation_call ? 'yes' : 'no'),
          })}
        </p>
      </section>
      <section aria-labelledby="customer-numbers">
        <h2 id="customer-numbers">{t('numbersTitle')}</h2>
        <Metric label={t('columns.visits')} value={d.stats.visits} />
        <Metric
          label={t('lastVisitLabel')}
          value={d.stats.last_visit_at ? formatDay(d.stats.last_visit_at) : '—'}
        />
        <Metric label={t('appointments')} value={d.stats.appointments} />
        <Metric label={t('columns.noShows')} value={d.stats.no_shows} />
        <Metric label={t('cancellations')} value={d.stats.cancellations} />
        <Metric label={t('lateCancellations')} value={d.stats.late_cancellations} />
        <Metric label={t('columns.avgRating')} value={formatRating(d.stats.avg_rating_given)} />
      </section>
      <section aria-labelledby="customer-settings">
        <h2 id="customer-settings">{t('settingsTitle')}</h2>
        <p>{t('appNotifications', { state: onOff(d.customer.push_enabled) })}</p>
        <p>{t('smsBackup', { state: onOff(d.customer.sms_backup_enabled) })}</p>
        <p>
          {t('promotions', { state: t(d.customer.marketing_allowed ? 'allowed' : 'notAllowed') })}
        </p>
      </section>
      {messageBranches.length > 0 && (
        <MessageForm
          supabase={supabase}
          customerId={d.customer.id}
          branches={messageBranches}
          t={t}
          onSent={onSent}
        />
      )}
      <section aria-labelledby="customer-history">
        <h2 id="customer-history">{t('historyTitle')}</h2>
        {d.visits.length === 0 ? (
          <p>{t('noVisits')}</p>
        ) : (
          <ul>
            {d.visits.map((v) => {
              const o = visitOutcome(v.state, v.cancel_reason);
              const outcome = o.reasonKey ? t(o.key, { reason: t(o.reasonKey) }) : t(o.key);
              return (
                <li key={v.ticket_id}>
                  {[
                    formatDay(v.created_at),
                    v.branch_name,
                    v.service_name,
                    v.barber_name ?? '—',
                    outcome,
                  ].join(' · ')}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section aria-labelledby="customer-feedback">
        <h2 id="customer-feedback">{t('feedbackTitle')}</h2>
        {d.feedback.length === 0 ? (
          <p>{t('noFeedback')}</p>
        ) : (
          <ul>
            {d.feedback.map((fb) => (
              <li key={`${fb.created_at}-${fb.branch_name}`}>
                {[
                  formatDay(fb.created_at),
                  fb.branch_name,
                  fb.barber_name ?? '—',
                  t('stars', { count: fb.overall_rating }),
                ].join(' · ')}
                {fb.comment && <p>{fb.comment}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="customer-messages">
        <h2 id="customer-messages">{t('messagesTitle')}</h2>
        {d.messages.length === 0 ? (
          <p>{t('noMessages')}</p>
        ) : (
          <ul>
            {d.messages.map((m) => {
              const label = deliveryLabel(m.status, m.failed_reason);
              return (
                <li key={m.id}>
                  <p>
                    {[
                      formatDay(m.created_at),
                      m.branch_name ?? '—',
                      t('sentBy', { name: m.sent_by_name ?? '—' }),
                    ].join(' · ')}
                  </p>
                  <p>{m.text}</p>
                  <p>
                    {t(label.key)}
                    {label.reasonKey ? ` · ${t(label.reasonKey)}` : ''}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

export default function CustomerPage() {
  return (
    <Suspense fallback={null}>
      <CustomerPageInner />
    </Suspense>
  );
}
```

- [ ] **Step 7: Link the list from the staff home page**

In `apps/staff/app/page.tsx`: add `const [canViewCustomers, setCanViewCustomers] = useState(false);`, in the effect
```tsx
    supabase
      .rpc('has_capability', { cap: 'view_customers' })
      .then(({ data }) => setCanViewCustomers(data === true));
```
and, after the Reports link:
```tsx
      {canViewCustomers && <Link href="/customers">{t('customersLink')}</Link>}
```

- [ ] **Step 8: Write the e2e journey**

Create `e2e/staff-customers.spec.ts`:
```typescript
// e2e/staff-customers.spec.ts
// Customer list (Docs/superpowers/specs/2026-10-08-customer-list-design.md): a receptionist finds a
// customer by phone, opens their page, sees the visit, sends a message and sees its delivery label.
// Clicks use Enter; page content is in <main>.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const STAFF = 'http://localhost:3001';
const PASSWORD = 'Test-Password-123!';

test('a receptionist finds a customer by phone and messages them', async ({ page }) => {
  test.skip(!url || !serviceRoleKey, 'Supabase env vars not set');
  test.setTimeout(120_000);
  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const suffix = String(Date.now());
  const receptionEmail = `scu-rec-${suffix}@test.pixelbarber.local`;
  const phone = `+233209${suffix.slice(-6)}`;
  const localPhone = `0${phone.slice(4)}`;
  const customerName = `Esi Mensah ${suffix}`;
  const created: { authIds: string[]; staffIds: string[] } = { authIds: [], staffIds: [] };
  let service: { id: string } | null = null;
  let branch: { id: string } | null = null;
  let bs: { id: string } | null = null;
  let customerId: string | null = null;

  try {
    const { data: business } = await admin.from('businesses').select('id').limit(1).single();
    service = (
      await admin
        .from('services')
        .insert({
          business_id: business!.id,
          name: `SCU E2E Cut ${suffix}`,
          default_duration_minutes: 30,
        })
        .select('id')
        .single()
    ).data;
    branch = (
      await admin
        .from('branches')
        .insert({
          business_id: business!.id,
          name: `SCU E2E Branch ${suffix}`,
          branch_code: `SC${suffix.slice(-6)}`,
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
      email: receptionEmail,
      password: PASSWORD,
      email_confirm: true,
    });
    created.authIds.push(auth.user!.id);
    const { data: staffRow } = await admin
      .from('staff_users')
      .insert({
        auth_user_id: auth.user!.id,
        name: 'SCU E2E Reception',
        email: receptionEmail,
        role: 'receptionist',
        invite_status: 'accepted',
      })
      .select('id')
      .single();
    created.staffIds.push(staffRow!.id);
    await admin
      .from('staff_branch_assignments')
      .insert({ staff_user_id: staffRow!.id, branch_id: branch!.id });
    customerId = (
      await admin
        .from('customers')
        .insert({ name: customerName, phone_e164: phone })
        .select('id')
        .single()
    ).data!.id;
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const { error: ticketError } = await admin.from('queue_tickets').insert({
      ticket_number: `PB-SCU-${suffix}`,
      branch_id: branch!.id,
      customer_id: customerId!,
      branch_service_id: bs!.id,
      state: 'completed',
      created_at: twoDaysAgo,
      completed_at: twoDaysAgo,
      created_by: 'staff',
    });
    if (ticketError) throw ticketError;

    await page.goto(`${STAFF}/login`);
    await page.getByPlaceholder('Email or phone').fill(receptionEmail);
    await page.getByPlaceholder('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Log In' }).press('Enter');
    await page.waitForURL(/\/tickets/, { timeout: 15000 });

    await page.goto(`${STAFF}/customers`);
    const main = page.locator('main');
    await main.getByLabel('Branch', { exact: true }).selectOption(branch!.id);
    await main.getByLabel('Search by name or phone').fill(localPhone);
    const link = main.getByRole('link', { name: customerName });
    await expect(link).toBeVisible({ timeout: 15000 });
    await expect(main.getByRole('cell', { name: localPhone })).toBeVisible();
    await link.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/customers/${customerId}`), { timeout: 15000 });

    await expect(main.getByRole('region', { name: 'Visit history' })).toContainText(
      `SCU E2E Cut ${suffix}`,
      { timeout: 15000 },
    );
    await main.getByLabel('Message', { exact: true }).fill('Your barber is running 10 minutes late.');
    await main.getByRole('button', { name: 'Send' }).press('Enter');
    await expect(main.getByText('Message queued.')).toBeVisible({ timeout: 15000 });
    const messages = main.getByRole('region', { name: 'Messages' });
    await expect(messages).toContainText('Your barber is running 10 minutes late.', {
      timeout: 15000,
    });
    await expect(messages).toContainText(/Sending|Delivered|Not delivered/);
  } finally {
    const failures: string[] = [];
    const check = (label: string, res: { error: { message: string } | null }) => {
      if (res.error) failures.push(`${label}: ${res.error.message}`);
    };
    if (customerId) {
      check('staff messages', await admin.from('notifications').delete().eq('recipient_id', customerId));
    }
    if (branch) {
      const { data: tickets } = await admin
        .from('queue_tickets')
        .select('id')
        .eq('branch_id', branch.id);
      const ticketIds = (tickets ?? []).map((t) => t.id);
      if (ticketIds.length) {
        check('feedback', await admin.from('feedback').delete().in('ticket_id', ticketIds));
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
    for (const id of created.staffIds) {
      check(
        'staff_branch_assignments',
        await admin.from('staff_branch_assignments').delete().eq('staff_user_id', id),
      );
      check('staff_users', await admin.from('staff_users').delete().eq('id', id));
    }
    for (const id of created.authIds) await admin.auth.admin.deleteUser(id);
    if (customerId) check('customers', await admin.from('customers').delete().eq('id', customerId));
    if (bs) check('branch_services', await admin.from('branch_services').delete().eq('id', bs.id));
    if (branch) check('branches', await admin.from('branches').delete().eq('id', branch.id));
    if (service) check('services', await admin.from('services').delete().eq('id', service.id));
    if (failures.length) throw new Error(`Cleanup failed:\n${failures.join('\n')}`);
  }
});
```

- [ ] **Step 9: Verify**

- `npx vitest run apps/staff/app/customers --environment=node` — PASS.
- `npm run typecheck` — no errors.
- `cd apps/staff && npx eslint "app/customers/page.tsx" "app/customers/[id]/page.tsx" "app/customers/[id]/MessageForm.tsx" "app/customers/customerLabels.ts" "app/customers/customerTypes.ts" "app/page.tsx"` — clean.
- `npx playwright test e2e/staff-customers.spec.ts --reporter=line --workers=1` — PASS (staging login rate limits: wait a minute and re-run once).
- `grep -n $'\xef\xbf\xbd'` on every edited file — nothing.

- [ ] **Step 10: Commit**

```bash
git add apps/staff/app/customers apps/staff/app/page.tsx apps/staff/messages/en.json e2e/staff-customers.spec.ts
git commit -m "feat: staff customer list and customer page with Message customer"
```

---

## After all tasks (controller)

- Full suite (DB in paced pairs, unit, app, e2e).
- Promotion (after the user's OK): migrations `20261008100000`–`20261008100100` to production (dry run first), then push to GitHub (Vercel deploys the staff app), then deploy `send-notifications` to production — so the sender only starts delivering staff messages once the pages that create them are live.
