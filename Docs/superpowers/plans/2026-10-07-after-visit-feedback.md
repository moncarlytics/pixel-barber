# After-Visit Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Customers rate each completed visit (stars, optional comment and details), see their history in Profile, and owners/branch managers see low ratings through a staff banner and a Feedback page.

**Architecture:** `SECURITY DEFINER` functions own every rule (submit, list, count, mark seen); a trigger on ticket completion queues a `feedback_request` notification that the existing sender delivers (push first, SMS fallback). The customer ticket page gets a rating form, Profile lists history, and the staff app gets a header banner plus a Feedback page.

**Tech Stack:** Supabase Postgres (plpgsql), Deno Edge Function (send-notifications), Next.js 16 client components, next-intl, Vitest, Playwright.

**Spec:** `Docs/superpowers/specs/2026-10-07-after-visit-feedback-design.md`

## Global Constraints

- Ratings: `overall_rating` 1–5 required; `service_quality_rating`, `barber_professionalism_rating`, `waiting_experience_rating`, `cleanliness_rating`, `value_rating` optional 1–5; comment trimmed, empty → null, max 1000 characters.
- One feedback per ticket; only the ticket's own customer; ticket `completed`; within 7 days of `completed_at` (fallback `updated_at`).
- Error strings (exact): `not_found`, `not_completed`, `too_late`, `already_submitted`, `invalid_rating`, `invalid_comment`, `not_allowed`.
- "Low" = `overall_rating <= 2`. Banner/mark-seen: `handle_escalations` (owner, branch_manager) + `in_branch_scope`. Feedback page/list: `view_branch_reports` (owner, branch_manager, analyst) + `in_branch_scope`.
- Request notification: `notification_type = 'feedback_request'`, channel `sms`, recipient the customer, `related_ticket_id`, queued once per ticket on the transition into `completed`, only for customers with `auth_user_id`. Push body `How was your cut at {branch}? Tap to rate.` (title `Pixel Barber`, tap URL `/tickets/{ticket_id}`, urgency normal); SMS `Pixel Barber: How was your cut at {branch}? Rate your visit: {link}`. Stale when feedback exists for the ticket or the ticket isn't `completed`.
- Customer copy (exact): heading `How was your visit?`; star buttons `1 star` … `5 stars`; `Tell us more`; detail rows `Service quality`, `Barber professionalism`, `Waiting experience`, `Cleanliness`, `Value for money`; comment placeholder `Anything you'd like to add? (optional)`; button `Send`; `Thanks for your feedback!`; errors `Feedback for this visit has closed.` / `Couldn't send your feedback. Please try again.`; Profile empty `No feedback submitted yet.` (existing).
- Staff copy (exact): banner `1 new low rating — View` / `{count} new low ratings — View`; page title `Feedback`; `Mark as seen`; `Seen by {name} on {date}`; summary `Last 30 days: {average} average from {count} ratings` (and `Last 30 days: no ratings yet`); empty `No feedback yet for this branch.`; `Couldn't load feedback.`; home link `Feedback`.
- Times are UTC (Ghana). Dates shown like `Tue 7 Oct` (`en-GB`, weekday short, day numeric, month short, UTC).
- Every new SQL function: `security definer`, `set search_path = public, pg_temp`, explicit revoke/grant (`authenticated` only for callable ones). Already-applied migrations are never edited. `packages/shared/src/database.types.ts` is hand-maintained and must match the SQL.
- Live SMS stays off on staging; SMS-path rows end `not_allowlisted`/`sms_disabled`.
- **Implementer subagents cannot push migrations, deploy functions, set secrets or run SQL against a live project.** The controller pushes (`set -a && source supabase/.secrets/send-sms.env && set +a && npx supabase db push`) and deploys. Report "ready for push" / "ready for deploy".
- React lint (errors): no synchronous `setState` in effect bodies; no `Date.now()`/`new Date()` in render or `useMemo`; guard async results.
- E2E: `.press('Enter')`, locators scoped to `page.locator('main')` (headers live outside main); own phone range; FK-safe cleanup that throws (delete `feedback` before tickets). Do NOT kill node processes; leave dev servers running.
- After editing any file containing `—` or `–`, `grep -n $'\xef\xbf\xbd' <file>` must print nothing.
- Do not stage `apps/*/next-env.d.ts`, `graphify-out/`, `playwright-report/`, `test-results/`, `supabase/.secrets/`, untracked `Docs/superpowers/plans/2026-09-1*`. No AI-attribution lines in commits. Commit on main.
- Environment: lint per file (`cd apps/<app> && npx eslint "<file>"`); pure unit tests with `--environment=node`.

## Rulings made while planning

1. **`list_my_feedback()`** is added for Profile (customers can't read staff names directly).
2. **`branch_feedback_summary(p_branch_id)`** is a separate function so the 30-day summary isn't limited by the list's 100 rows.
3. **The claim function gains `ticket_has_feedback boolean`** (drop and recreate, like earlier changes) so the sender can skip a request that's already been answered.
4. **The Feedback page tells the banner to refresh** via a `pixelbarber:feedback-seen` window event after Mark as seen, so the banner clears without waiting for its 60-second poll.
5. **Star rows are `role="group"`s named after their question** (`How was your visit?`, `Service quality`, …), each with five buttons `1 star` … `5 stars`, so screen readers and tests can address them.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20261007100000_feedback_submit.sql` | drop direct insert policy, `submit_feedback`, `list_my_feedback`, completion trigger queuing `feedback_request` |
| `supabase/migrations/20261007100100_feedback_staff.sql` | `seen_at`/`seen_by_staff_id`, `list_unseen_low_feedback_count`, `mark_feedback_seen`, `list_branch_feedback`, `branch_feedback_summary` |
| `supabase/migrations/20261007100200_feedback_request_claim.sql` | `claim_sms_notifications` + `ticket_has_feedback` |
| `tests/db/fixtures/appointments.ts` | cleanup deletes feedback first |
| `tests/db/feedback-submit.test.ts`, `tests/db/feedback-staff.test.ts`, `tests/db/feedback-request-sending.test.ts` | DB tests |
| `supabase/functions/_shared/notification-sms-core.ts`, `notification-push-core.ts`, tests in `tests/unit/` | `feedback_request` rules and texts |
| `apps/customer/app/tickets/[id]/FeedbackForm.tsx`, `apps/customer/app/tickets/feedbackErrors.ts` (+ test), ticket page, Profile, `apps/customer/messages/en.json` | customer UI |
| `apps/staff/app/feedback/page.tsx`, `apps/staff/app/feedback/LowRatingBanner.tsx`, `apps/staff/app/StaffHeader.tsx`, `apps/staff/app/page.tsx`, `apps/staff/messages/en.json` | staff UI |
| `e2e/customer-feedback.spec.ts`, `e2e/staff-feedback.spec.ts` | journeys |

---

### Task 1: Submitting feedback and queuing the request

**Files:**
- Create: `supabase/migrations/20261007100000_feedback_submit.sql`
- Modify: `tests/db/fixtures/appointments.ts`
- Create: `tests/db/feedback-submit.test.ts`
- Modify: `packages/shared/src/database.types.ts`

**Interfaces:**
- Produces (SQL): `submit_feedback(p_ticket_id uuid, p_overall smallint, p_service_quality smallint default null, p_barber_professionalism smallint default null, p_waiting_experience smallint default null, p_cleanliness smallint default null, p_value smallint default null, p_comment text default null) returns uuid`; `list_my_feedback() returns table (id uuid, ticket_id uuid, created_at timestamptz, branch_name text, barber_name text, overall_rating smallint, comment text)`; trigger `after_ticket_completed_feedback_request` inserting `feedback_request` notifications; partial unique index `notifications_one_feedback_request_per_ticket`.

- [ ] **Step 1: Make the fixture cleanup delete feedback first**

In `tests/db/fixtures/appointments.ts` `cleanupAppointmentFixture`, inside `if (ticketIds.length > 0) {`, add as the first line:
```typescript
    await admin.from('feedback').delete().in('ticket_id', ticketIds);
```

- [ ] **Step 2: Write the failing tests**

Create `tests/db/feedback-submit.test.ts`:
```typescript
// tests/db/feedback-submit.test.ts
// @vitest-environment node
// After-visit feedback (spec Section 1): submit_feedback's rules (own completed ticket, 7 days, once,
// rating/comment validation, branch and barber taken from the ticket), the direct insert closed,
// list_my_feedback, and the feedback_request notification queued once on completion for app
// customers only.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  createAppointmentFixture,
  type AppointmentFixture,
} from './fixtures/appointments';

let f: AppointmentFixture;
const DAY = 24 * 60 * 60 * 1000;
let walkInId: string | null = null;

/** A ticket for the customer, assigned to barber B, in the given state. */
async function ticket(
  customerId: string,
  state: 'in_service' | 'completed' | 'waiting',
  completedAt?: string,
) {
  const { data, error } = await f.admin
    .from('queue_tickets')
    .insert({
      ticket_number: `PB-FB-${f.suffix}-${Math.random().toString(36).slice(2, 7)}`,
      branch_id: f.branchId,
      customer_id: customerId,
      branch_service_id: f.branchServiceId,
      assigned_barber_id: f.barberB.barberId,
      state,
      completed_at: completedAt ?? (state === 'completed' ? new Date().toISOString() : null),
      created_by: 'customer',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

async function feedbackRequests(ticketId: string) {
  const { data, error } = await f.admin
    .from('notifications')
    .select('id, recipient_id, channel, status')
    .eq('related_ticket_id', ticketId)
    .eq('notification_type', 'feedback_request');
  if (error) throw error;
  return data ?? [];
}

const submit = (customerIdx: number, args: Record<string, unknown>) =>
  f.customers[customerIdx].client.rpc('submit_feedback', args as never);

beforeAll(async () => {
  f = await createAppointmentFixture();
}, 90000);

afterAll(async () => {
  if (walkInId) {
    const { data: t } = await f.admin.from('queue_tickets').select('id').eq('customer_id', walkInId);
    const ids = (t ?? []).map((r) => r.id);
    if (ids.length) {
      await f.admin.from('notifications').delete().in('related_ticket_id', ids);
      await f.admin.from('queue_events').delete().in('ticket_id', ids);
      await f.admin.from('queue_tickets').delete().in('id', ids);
    }
    await f.admin.from('customers').delete().eq('id', walkInId);
  }
  await cleanupAppointmentFixture(f);
}, 90000);

describe('submit_feedback', () => {
  it('saves a rating for your own completed visit, with branch and barber from the ticket', async () => {
    const t = await ticket(f.customers[0].customerId, 'completed');
    const { data: id, error } = await submit(0, {
      p_ticket_id: t,
      p_overall: 4,
      p_cleanliness: 5,
      p_comment: '  Great fade  ',
    });
    expect(error).toBeNull();
    const { data } = await f.admin.from('feedback').select('*').eq('id', id as string).single();
    expect(data).toMatchObject({
      ticket_id: t,
      customer_id: f.customers[0].customerId,
      branch_id: f.branchId,
      barber_id: f.barberB.barberId,
      overall_rating: 4,
      cleanliness_rating: 5,
      service_quality_rating: null,
      comment: 'Great fade',
    });
    const again = await submit(0, { p_ticket_id: t, p_overall: 5 });
    expect(again.error?.message).toBe('already_submitted');
  });

  it("refuses someone else's ticket, unfinished visits and old visits", async () => {
    const other = await ticket(f.customers[1].customerId, 'completed');
    expect((await submit(0, { p_ticket_id: other, p_overall: 3 })).error?.message).toBe('not_found');
    const unfinished = await ticket(f.customers[2].customerId, 'in_service');
    expect((await submit(2, { p_ticket_id: unfinished, p_overall: 3 })).error?.message).toBe(
      'not_completed',
    );
    await f.admin
      .from('queue_tickets')
      .update({ state: 'completed', completed_at: new Date(Date.now() - 8 * DAY).toISOString() })
      .eq('id', unfinished);
    expect((await submit(2, { p_ticket_id: unfinished, p_overall: 3 })).error?.message).toBe(
      'too_late',
    );
  });

  it('validates ratings and the comment', async () => {
    const t = await ticket(f.customers[3].customerId, 'completed');
    expect((await submit(3, { p_ticket_id: t, p_overall: 0 })).error?.message).toBe('invalid_rating');
    expect((await submit(3, { p_ticket_id: t, p_overall: 3, p_value: 6 })).error?.message).toBe(
      'invalid_rating',
    );
    expect(
      (await submit(3, { p_ticket_id: t, p_overall: 3, p_comment: 'x'.repeat(1001) })).error
        ?.message,
    ).toBe('invalid_comment');
    const ok = await submit(3, { p_ticket_id: t, p_overall: 2, p_comment: '   ' });
    expect(ok.error).toBeNull();
    const { data } = await f.admin.from('feedback').select('comment').eq('ticket_id', t).single();
    expect(data!.comment).toBeNull();
  });

  it('cannot be bypassed with a direct insert', async () => {
    const t = await ticket(f.customers[1].customerId, 'completed');
    const { error } = await f.customers[1].client.from('feedback').insert({
      ticket_id: t,
      customer_id: f.customers[1].customerId,
      branch_id: f.branchId,
      barber_id: f.barberB.barberId,
      overall_rating: 5,
    });
    expect(error).not.toBeNull();
  });
});

describe('list_my_feedback', () => {
  it("lists only the caller's feedback with branch and barber names", async () => {
    const { data, error } = await f.customers[0].client.rpc('list_my_feedback');
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({
      branch_name: `Appt Main ${f.suffix}`,
      barber_name: 'Appt Barber b',
      overall_rating: 4,
      comment: 'Great fade',
    });
  });
});

describe('feedback request on completion', () => {
  it("queues one request when an app customer's ticket is completed", async () => {
    const t = await ticket(f.customers[2].customerId, 'in_service');
    expect(await feedbackRequests(t)).toHaveLength(0);
    await f.admin
      .from('queue_tickets')
      .update({ state: 'completed', completed_at: new Date().toISOString() })
      .eq('id', t);
    const rows = await feedbackRequests(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipient_id: f.customers[2].customerId, channel: 'sms' });
    // Re-saving a completed ticket doesn't queue another.
    await f.admin.from('queue_tickets').update({ state: 'completed' }).eq('id', t);
    expect(await feedbackRequests(t)).toHaveLength(1);
  });

  it('queues nothing for a walk-in without an app account', async () => {
    const { data: walkIn, error } = await f.admin
      .from('customers')
      .insert({ name: `FB Walk-in ${f.suffix}`, phone_e164: `+233558${f.suffix.slice(-5)}9` })
      .select('id')
      .single();
    if (error) throw error;
    walkInId = walkIn.id;
    const t = await ticket(walkIn.id, 'in_service');
    await f.admin.from('queue_tickets').update({ state: 'completed' }).eq('id', t);
    expect(await feedbackRequests(t)).toHaveLength(0);
  });
});
```
Note: branch names in the fixture are `Appt Main ${suffix}` and barbers `Appt Barber a`/`Appt Barber b` (see `tests/db/fixtures/appointments.ts`). One active ticket per customer per branch is enforced, but `completed` tickets don't count, so several completed tickets per customer are fine; only one `in_service` ticket per barber is allowed — the tests complete each `in_service` ticket before creating the next.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/db/feedback-submit.test.ts`
Expected: FAIL (`submit_feedback` not found).

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/20261007100000_feedback_submit.sql`:
```sql
-- After-visit feedback, customer side (Docs/superpowers/specs/2026-10-07-after-visit-feedback-design.md):
-- customers submit through submit_feedback only, list their own with list_my_feedback, and completing
-- a ticket queues one 'feedback_request' notification for app customers.

-- Direct inserts would bypass the 7-day window, validation and derived branch/barber.
drop policy if exists feedback_customer_submit on feedback;

create or replace function submit_feedback(
  p_ticket_id uuid,
  p_overall smallint,
  p_service_quality smallint default null,
  p_barber_professionalism smallint default null,
  p_waiting_experience smallint default null,
  p_cleanliness smallint default null,
  p_value smallint default null,
  p_comment text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer_id uuid := current_customer_id();
  v_ticket queue_tickets%rowtype;
  v_comment text;
  v_id uuid;
begin
  select * into v_ticket from queue_tickets
  where id = p_ticket_id and customer_id = v_customer_id;
  if v_customer_id is null or not found then
    raise exception 'not_found';
  end if;
  if v_ticket.state <> 'completed' or v_ticket.assigned_barber_id is null then
    raise exception 'not_completed';
  end if;
  if coalesce(v_ticket.completed_at, v_ticket.updated_at) < now() - interval '7 days' then
    raise exception 'too_late';
  end if;
  if exists (select 1 from feedback where ticket_id = p_ticket_id) then
    raise exception 'already_submitted';
  end if;
  if p_overall is null or p_overall not between 1 and 5
     or (p_service_quality is not null and p_service_quality not between 1 and 5)
     or (p_barber_professionalism is not null and p_barber_professionalism not between 1 and 5)
     or (p_waiting_experience is not null and p_waiting_experience not between 1 and 5)
     or (p_cleanliness is not null and p_cleanliness not between 1 and 5)
     or (p_value is not null and p_value not between 1 and 5) then
    raise exception 'invalid_rating';
  end if;
  v_comment := nullif(btrim(coalesce(p_comment, '')), '');
  if v_comment is not null and char_length(v_comment) > 1000 then
    raise exception 'invalid_comment';
  end if;

  begin
    insert into feedback (
      ticket_id, customer_id, branch_id, barber_id, overall_rating, service_quality_rating,
      barber_professionalism_rating, waiting_experience_rating, cleanliness_rating, value_rating,
      comment
    ) values (
      p_ticket_id, v_customer_id, v_ticket.branch_id, v_ticket.assigned_barber_id, p_overall,
      p_service_quality, p_barber_professionalism, p_waiting_experience, p_cleanliness, p_value,
      v_comment
    )
    returning id into v_id;
  exception when unique_violation then
    -- Two submits racing: the second loses on feedback.ticket_id's unique constraint.
    raise exception 'already_submitted';
  end;
  return v_id;
end;
$$;

revoke execute on function submit_feedback(uuid, smallint, smallint, smallint, smallint, smallint, smallint, text) from public, anon;
grant execute on function submit_feedback(uuid, smallint, smallint, smallint, smallint, smallint, smallint, text) to authenticated;

-- The caller's own feedback for Profile, with names customers can't read directly.
create or replace function list_my_feedback()
returns table (
  id uuid,
  ticket_id uuid,
  created_at timestamptz,
  branch_name text,
  barber_name text,
  overall_rating smallint,
  comment text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select f.id, f.ticket_id, f.created_at, b.name, su.name, f.overall_rating, f.comment
  from feedback f
  join branches b on b.id = f.branch_id
  join barbers br on br.id = f.barber_id
  join staff_users su on su.id = br.staff_user_id
  where f.customer_id = current_customer_id()
  order by f.created_at desc;
$$;

revoke execute on function list_my_feedback() from public, anon;
grant execute on function list_my_feedback() to authenticated;

-- One feedback request per ticket.
create unique index if not exists notifications_one_feedback_request_per_ticket
  on notifications (related_ticket_id) where notification_type = 'feedback_request';

-- Completing a ticket queues the request (app customers only). Never blocks the completion.
create or replace function trg_queue_feedback_request() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.state = 'completed' and old.state is distinct from 'completed'
     and exists (select 1 from customers c where c.id = new.customer_id and c.auth_user_id is not null) then
    begin
      insert into notifications (recipient_type, recipient_id, channel, notification_type, related_ticket_id, payload)
      values ('customer', new.customer_id, 'sms', 'feedback_request', new.id, '{}'::jsonb)
      on conflict (related_ticket_id) where notification_type = 'feedback_request' do nothing;
    exception when others then
      raise warning 'feedback request for ticket % not queued: %', new.id, sqlerrm;
    end;
  end if;
  return new;
end;
$$;

revoke execute on function trg_queue_feedback_request() from public, anon, authenticated;

drop trigger if exists after_ticket_completed_feedback_request on queue_tickets;
create trigger after_ticket_completed_feedback_request
  after update of state on queue_tickets
  for each row execute function trg_queue_feedback_request();
```

- [ ] **Step 5: Update the database types**

In `packages/shared/src/database.types.ts` `Functions` add (alphabetical):
```typescript
      list_my_feedback: {
        Args: never;
        Returns: {
          id: string;
          ticket_id: string;
          created_at: string;
          branch_name: string;
          barber_name: string;
          overall_rating: number;
          comment: string | null;
        }[];
      };
      submit_feedback: {
        Args: {
          p_ticket_id: string;
          p_overall: number;
          p_service_quality?: number | null;
          p_barber_professionalism?: number | null;
          p_waiting_experience?: number | null;
          p_cleanliness?: number | null;
          p_value?: number | null;
          p_comment?: string | null;
        };
        Returns: string;
      };
```
Run: `npm run typecheck` — Expected: no errors.

- [ ] **Step 6: Commit and hand over for the push**

```bash
git add supabase/migrations/20261007100000_feedback_submit.sql tests/db/fixtures/appointments.ts tests/db/feedback-submit.test.ts packages/shared/src/database.types.ts
git commit -m "feat: customers submit after-visit feedback; completion queues a feedback request"
```
Report "ready for push". After the push: `npx vitest run tests/db/feedback-submit.test.ts tests/db/appointment-conversion.test.ts` — Expected: PASS.

---

### Task 2: Staff feedback functions

**Files:**
- Create: `supabase/migrations/20261007100100_feedback_staff.sql`
- Create: `tests/db/feedback-staff.test.ts`
- Modify: `packages/shared/src/database.types.ts`

**Interfaces:**
- Consumes: `feedback` rows (Task 1 or direct admin inserts); fixture `createStaffLogin` / `cleanupStaffLogin`.
- Produces (SQL): columns `feedback.seen_at timestamptz`, `feedback.seen_by_staff_id uuid`; `list_unseen_low_feedback_count() returns integer`; `mark_feedback_seen(p_feedback_id uuid) returns void`; `list_branch_feedback(p_branch_id uuid) returns table (id uuid, created_at timestamptz, customer_first_name text, barber_name text, service_name text, overall_rating smallint, service_quality_rating smallint, barber_professionalism_rating smallint, waiting_experience_rating smallint, cleanliness_rating smallint, value_rating smallint, comment text, seen_at timestamptz, seen_by_name text)`; `branch_feedback_summary(p_branch_id uuid) returns table (average_rating numeric, rating_count integer)`.

- [ ] **Step 1: Write the failing tests**

Create `tests/db/feedback-staff.test.ts`:
```typescript
// tests/db/feedback-staff.test.ts
// @vitest-environment node
// Staff side of feedback (spec Section 2): the unseen-low count for owners/branch managers in
// scope, mark seen (capability, scope, idempotent), the branch list and 30-day summary
// (view_branch_reports + scope), and refusals for receptionists and out-of-scope managers.
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

let f: AppointmentFixture;
let manager: Awaited<ReturnType<typeof createStaffLogin>>;
let reception: Awaited<ReturnType<typeof createStaffLogin>>;
let otherManager: Awaited<ReturnType<typeof createStaffLogin>>;
const ids: Record<string, string> = {};

async function feedbackRow(customerIdx: number, overall: number, comment: string) {
  const { data: t, error } = await f.admin
    .from('queue_tickets')
    .insert({
      ticket_number: `PB-FS-${f.suffix}-${customerIdx}`,
      branch_id: f.branchId,
      customer_id: f.customers[customerIdx].customerId,
      branch_service_id: f.branchServiceId,
      assigned_barber_id: f.barberA.barberId,
      state: 'completed',
      completed_at: new Date().toISOString(),
      created_by: 'customer',
    })
    .select('id')
    .single();
  if (error) throw error;
  const { data: fb, error: fbError } = await f.admin
    .from('feedback')
    .insert({
      ticket_id: t.id,
      customer_id: f.customers[customerIdx].customerId,
      branch_id: f.branchId,
      barber_id: f.barberA.barberId,
      overall_rating: overall,
      comment,
    })
    .select('id')
    .single();
  if (fbError) throw fbError;
  return fb.id as string;
}

beforeAll(async () => {
  f = await createAppointmentFixture();
  manager = await createStaffLogin(f, 'mgr', 'branch_manager', f.branchId);
  reception = await createStaffLogin(f, 'rec', 'receptionist', f.branchId);
  otherManager = await createStaffLogin(f, 'oth', 'branch_manager', f.closedBranchId);
  ids.low = await feedbackRow(0, 1, 'Waited too long');
  ids.alsoLow = await feedbackRow(1, 2, 'Rushed');
  ids.good = await feedbackRow(2, 5, 'Perfect');
}, 90000);

afterAll(async () => {
  await cleanupStaffLogin(f, manager);
  await cleanupStaffLogin(f, reception);
  await cleanupStaffLogin(f, otherManager);
  await cleanupAppointmentFixture(f);
}, 90000);

describe('list_unseen_low_feedback_count', () => {
  it('counts unseen low ratings for managers in scope only', async () => {
    expect((await manager.client.rpc('list_unseen_low_feedback_count')).data).toBe(2);
    expect((await reception.client.rpc('list_unseen_low_feedback_count')).data).toBe(0);
    expect((await otherManager.client.rpc('list_unseen_low_feedback_count')).data).toBe(0);
  });
});

describe('mark_feedback_seen', () => {
  it('refuses receptionists and managers of other branches', async () => {
    expect(
      (await reception.client.rpc('mark_feedback_seen', { p_feedback_id: ids.low })).error?.message,
    ).toBe('not_allowed');
    expect(
      (await otherManager.client.rpc('mark_feedback_seen', { p_feedback_id: ids.low })).error
        ?.message,
    ).toBe('not_allowed');
  });

  it('records who saw it once, and the count drops', async () => {
    expect(
      (await manager.client.rpc('mark_feedback_seen', { p_feedback_id: ids.low })).error,
    ).toBeNull();
    const { data: first } = await f.admin
      .from('feedback')
      .select('seen_at, seen_by_staff_id')
      .eq('id', ids.low)
      .single();
    expect(first!.seen_by_staff_id).toBe(manager.staffUserId);
    expect(first!.seen_at).not.toBeNull();
    await manager.client.rpc('mark_feedback_seen', { p_feedback_id: ids.low });
    const { data: second } = await f.admin
      .from('feedback')
      .select('seen_at')
      .eq('id', ids.low)
      .single();
    expect(second!.seen_at).toBe(first!.seen_at);
    expect((await manager.client.rpc('list_unseen_low_feedback_count')).data).toBe(1);
  });
});

describe('list_branch_feedback and branch_feedback_summary', () => {
  it('lists the branch newest first with names and seen details', async () => {
    const { data, error } = await manager.client.rpc('list_branch_feedback', {
      p_branch_id: f.branchId,
    });
    expect(error).toBeNull();
    expect(data!.map((r) => r.comment)).toEqual(['Perfect', 'Rushed', 'Waited too long']);
    expect(data![2]).toMatchObject({
      customer_first_name: 'Appt',
      barber_name: 'Appt Barber a',
      service_name: `Appt Service ${f.suffix}`,
      overall_rating: 1,
      seen_by_name: manager.name,
    });
    expect(data![1].seen_at).toBeNull();
  });

  it('summarises the last 30 days', async () => {
    const { data, error } = await manager.client.rpc('branch_feedback_summary', {
      p_branch_id: f.branchId,
    });
    expect(error).toBeNull();
    expect(data![0].rating_count).toBe(3);
    expect(Number(data![0].average_rating)).toBeCloseTo(8 / 3, 2);
  });

  it('refuses receptionists and out-of-scope managers', async () => {
    expect(
      (await reception.client.rpc('list_branch_feedback', { p_branch_id: f.branchId })).error
        ?.message,
    ).toBe('not_allowed');
    expect(
      (await otherManager.client.rpc('branch_feedback_summary', { p_branch_id: f.branchId })).error
        ?.message,
    ).toBe('not_allowed');
  });
});
```
(Fixture customers are named `Appt Customer {i}`, so their first name is `Appt`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/db/feedback-staff.test.ts`
Expected: FAIL (`list_unseen_low_feedback_count` not found).

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261007100100_feedback_staff.sql`:
```sql
-- After-visit feedback, staff side (Docs/superpowers/specs/2026-10-07-after-visit-feedback-design.md):
-- low ratings (1-2 stars) alert owners/branch managers until marked seen; a branch list and 30-day
-- summary for staff who can view branch reports.

alter table feedback
  add column if not exists seen_at timestamptz,
  add column if not exists seen_by_staff_id uuid references staff_users(id);

create index if not exists idx_feedback_branch_created on feedback (branch_id, created_at desc);

create or replace function list_unseen_low_feedback_count()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when has_capability('handle_escalations') then
    (select count(*)::int from feedback f
     where f.overall_rating <= 2 and f.seen_at is null and in_branch_scope(f.branch_id))
  else 0 end;
$$;

revoke execute on function list_unseen_low_feedback_count() from public, anon;
grant execute on function list_unseen_low_feedback_count() to authenticated;

create or replace function mark_feedback_seen(p_feedback_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_branch uuid;
begin
  select branch_id into v_branch from feedback where id = p_feedback_id;
  if v_branch is null then
    raise exception 'not_found';
  end if;
  if not (has_capability('handle_escalations') and in_branch_scope(v_branch)) then
    raise exception 'not_allowed';
  end if;
  -- First viewer wins: an already-seen rating keeps its original values.
  update feedback
    set seen_at = now(), seen_by_staff_id = auth_staff_id()
    where id = p_feedback_id and seen_at is null;
end;
$$;

revoke execute on function mark_feedback_seen(uuid) from public, anon;
grant execute on function mark_feedback_seen(uuid) to authenticated;

create or replace function list_branch_feedback(p_branch_id uuid)
returns table (
  id uuid,
  created_at timestamptz,
  customer_first_name text,
  barber_name text,
  service_name text,
  overall_rating smallint,
  service_quality_rating smallint,
  barber_professionalism_rating smallint,
  waiting_experience_rating smallint,
  cleanliness_rating smallint,
  value_rating smallint,
  comment text,
  seen_at timestamptz,
  seen_by_name text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not (has_capability('view_branch_reports') and in_branch_scope(p_branch_id)) then
    raise exception 'not_allowed';
  end if;
  return query
    select f.id, f.created_at, split_part(trim(c.name), ' ', 1), su.name, s.name,
           f.overall_rating, f.service_quality_rating, f.barber_professionalism_rating,
           f.waiting_experience_rating, f.cleanliness_rating, f.value_rating, f.comment,
           f.seen_at, seen.name
    from feedback f
    join customers c on c.id = f.customer_id
    join barbers br on br.id = f.barber_id
    join staff_users su on su.id = br.staff_user_id
    join queue_tickets t on t.id = f.ticket_id
    join branch_services bs on bs.id = t.branch_service_id
    join services s on s.id = bs.service_id
    left join staff_users seen on seen.id = f.seen_by_staff_id
    where f.branch_id = p_branch_id
    order by f.created_at desc
    limit 100;
end;
$$;

revoke execute on function list_branch_feedback(uuid) from public, anon;
grant execute on function list_branch_feedback(uuid) to authenticated;

create or replace function branch_feedback_summary(p_branch_id uuid)
returns table (average_rating numeric, rating_count integer)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not (has_capability('view_branch_reports') and in_branch_scope(p_branch_id)) then
    raise exception 'not_allowed';
  end if;
  return query
    select round(avg(f.overall_rating)::numeric, 2), count(*)::int
    from feedback f
    where f.branch_id = p_branch_id and f.created_at > now() - interval '30 days';
end;
$$;

revoke execute on function branch_feedback_summary(uuid) from public, anon;
grant execute on function branch_feedback_summary(uuid) to authenticated;
```

- [ ] **Step 4: Update the database types**

In `packages/shared/src/database.types.ts`: add `seen_at: string | null; seen_by_staff_id: string | null;` to the `feedback` `Row` and optional versions to `Insert`/`Update`; add to `Functions` (alphabetical):
```typescript
      branch_feedback_summary: {
        Args: { p_branch_id: string };
        Returns: { average_rating: number | null; rating_count: number }[];
      };
      list_branch_feedback: {
        Args: { p_branch_id: string };
        Returns: {
          id: string;
          created_at: string;
          customer_first_name: string;
          barber_name: string;
          service_name: string;
          overall_rating: number;
          service_quality_rating: number | null;
          barber_professionalism_rating: number | null;
          waiting_experience_rating: number | null;
          cleanliness_rating: number | null;
          value_rating: number | null;
          comment: string | null;
          seen_at: string | null;
          seen_by_name: string | null;
        }[];
      };
      list_unseen_low_feedback_count: { Args: never; Returns: number };
      mark_feedback_seen: { Args: { p_feedback_id: string }; Returns: undefined };
```
Run: `npm run typecheck` — Expected: no errors.

- [ ] **Step 5: Commit and hand over for the push**

```bash
git add supabase/migrations/20261007100100_feedback_staff.sql tests/db/feedback-staff.test.ts packages/shared/src/database.types.ts
git commit -m "feat: staff feedback list, summary, low-rating count and mark seen"
```
Report "ready for push". After the push: `npx vitest run tests/db/feedback-staff.test.ts` — Expected: PASS.

---

### Task 3: Sending the feedback request

**Files:**
- Create: `supabase/migrations/20261007100200_feedback_request_claim.sql`
- Modify: `supabase/functions/_shared/notification-sms-core.ts`, `supabase/functions/_shared/notification-push-core.ts`
- Modify: `tests/unit/notification-sms-core.test.ts`, `tests/unit/notification-push-core.test.ts`
- Create: `tests/db/feedback-request-sending.test.ts`
- Modify: `packages/shared/src/database.types.ts`

**Interfaces:**
- Consumes: `feedback_request` rows (Task 1); `submit_feedback` (Task 1).
- Produces: `claim_sms_notifications` also returns `ticket_has_feedback boolean`; `SMS_NOTIFICATION_TYPES` includes `'feedback_request'`; `ClaimedNotification.ticket_has_feedback?: boolean | null`.

- [ ] **Step 1: Write the failing unit tests**

In `tests/unit/notification-sms-core.test.ts` append:
```typescript
describe('feedback_request', () => {
  const request = (overrides: Partial<ClaimedNotification> = {}) =>
    row({
      notification_type: 'feedback_request',
      ticket_state: 'completed',
      ticket_has_feedback: false,
      ...overrides,
    });

  it('sends for a completed visit not yet rated', () => {
    expect(decideNotification(request(), NOW, true)).toEqual({ action: 'send' });
  });
  it('is stale once rated or if the ticket is no longer completed', () => {
    expect(decideNotification(request({ ticket_has_feedback: true }), NOW, true)).toEqual({
      action: 'skip',
      reason: 'stale',
    });
    expect(decideNotification(request({ ticket_state: 'cancelled' }), NOW, true)).toEqual({
      action: 'skip',
      reason: 'stale',
    });
  });
  it('is claimable and has the SMS text', () => {
    expect(SMS_NOTIFICATION_TYPES).toContain('feedback_request');
    expect(
      buildNotificationSms('feedback_request', {
        branchName: 'Osu Branch',
        ticketNumber: 'A12',
        link: 'https://app.example/tickets/t1',
      }),
    ).toBe(
      'Pixel Barber: How was your cut at Osu Branch? Rate your visit: https://app.example/tickets/t1',
    );
  });
});
```
If an existing assertion pins `SMS_NOTIFICATION_TYPES` to exactly five types, append `'feedback_request'` at the end of that list.

In `tests/unit/notification-push-core.test.ts` append:
```typescript
describe('feedback_request push', () => {
  it('asks how the cut was and opens the ticket', () => {
    expect(
      buildPushPayload(
        'feedback_request',
        row({ notification_type: 'feedback_request', ticket_state: 'completed' }),
      ),
    ).toEqual({
      title: 'Pixel Barber',
      body: 'How was your cut at Osu Branch? Tap to rate.',
      url: '/tickets/t1',
      tag: 'n1',
    });
    expect(pushUrgency('feedback_request')).toBe('normal');
  });
});
```
Run: `npx vitest run tests/unit/notification-sms-core.test.ts tests/unit/notification-push-core.test.ts --environment=node` — Expected: FAIL.

- [ ] **Step 2: Implement the core changes**

In `supabase/functions/_shared/notification-sms-core.ts`:
- In `SENDABLE_TICKET_STATES` add `feedback_request: new Set(['completed']),` with the comment `// The visit is done and not yet rated.`
- Append `'feedback_request'` to `SMS_NOTIFICATION_TYPES` (after `'appointment_reminder_hour'`).
- Add to `ClaimedNotification` (after `push_subscriptions`): `/** feedback_request only: whether the visit has already been rated. */ ticket_has_feedback?: boolean | null;`
- In `isStale`, before the final `return`, add: `if (n.notification_type === 'feedback_request' && n.ticket_has_feedback === true) return true;`
- In `buildNotificationSms` add:
```typescript
    case 'feedback_request':
      return `Pixel Barber: How was your cut at ${input.branchName}? Rate your visit: ${input.link}`;
```
In `supabase/functions/_shared/notification-push-core.ts` `buildPushPayload` add:
```typescript
    case 'feedback_request':
      return { ...base, url: ticketUrl, body: `How was your cut at ${branch}? Tap to rate.` };
```
Re-run the unit tests — Expected: PASS.

- [ ] **Step 3: Write the claim migration**

Create `supabase/migrations/20261007100200_feedback_request_claim.sql`. Start with the header comment `-- After-visit feedback: claim_sms_notifications also says whether the ticket has been rated, so a feedback_request that's already answered is skipped. Return columns change, so it is dropped and recreated; otherwise identical to 20261007090100_web_push_hardening.sql.` Then `drop function claim_sms_notifications(text[], int);` and the `create function claim_sms_notifications(...)` copied exactly from `supabase/migrations/20261007090100_web_push_hardening.sql`, with two additions: `ticket_has_feedback boolean` as the last column of `returns table (...)`, and as the last select expression (after the `push_subscriptions` coalesce):
```sql
         , exists (select 1 from feedback fb where fb.ticket_id = c.related_ticket_id)
```
Keep the same revoke/grant (`revoke ... from public, anon, authenticated; grant ... to service_role;`).

- [ ] **Step 4: Update the database types**

Add `ticket_has_feedback: boolean | null;` to `claim_sms_notifications.Returns` (after `push_subscriptions`). Run `npm run typecheck` — Expected: no errors.

- [ ] **Step 5: Write the deployed sender test**

Create `tests/db/feedback-request-sending.test.ts`:
```typescript
// tests/db/feedback-request-sending.test.ts
// @vitest-environment node
// send-notifications decides feedback_request rows (deployed, live SMS off): a request for an
// unrated visit takes the SMS path (customers here have no push devices) and ends
// not_allowlisted/sms_disabled; one whose visit was rated first ends stale.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  createAppointmentFixture,
  type AppointmentFixture,
} from './fixtures/appointments';
import { callFunction } from './fixtures/staff-invite';

let f: AppointmentFixture;
const serviceRoleKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function completedTicket(customerIdx: number) {
  const { data: t, error } = await f.admin
    .from('queue_tickets')
    .insert({
      ticket_number: `PB-FR-${f.suffix}-${customerIdx}`,
      branch_id: f.branchId,
      customer_id: f.customers[customerIdx].customerId,
      branch_service_id: f.branchServiceId,
      assigned_barber_id: customerIdx === 0 ? f.barberA.barberId : f.barberB.barberId,
      state: 'in_service',
      created_by: 'customer',
    })
    .select('id')
    .single();
  if (error) throw error;
  const { error: doneError } = await f.admin
    .from('queue_tickets')
    .update({ state: 'completed', completed_at: new Date().toISOString() })
    .eq('id', t.id);
  if (doneError) throw doneError;
  return t.id as string;
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

describe('send-notifications with feedback requests', () => {
  it('sends an unrated request down the SMS path and skips a rated one as stale', async () => {
    const unrated = await completedTicket(0);
    const rated = await completedTicket(1);
    const { error } = await f.customers[1].client.rpc('submit_feedback', {
      p_ticket_id: rated,
      p_overall: 5,
    });
    if (error) throw error;

    const deadline = Date.now() + 60_000;
    let rows: { related_ticket_id: string; status: string; failed_reason: string | null }[] = [];
    while (Date.now() < deadline) {
      await callFunction('send-notifications', {}, serviceRoleKey());
      const { data } = await f.admin
        .from('notifications')
        .select('related_ticket_id, status, failed_reason')
        .eq('notification_type', 'feedback_request')
        .in('related_ticket_id', [unrated, rated]);
      rows = data ?? [];
      if (rows.length === 2 && rows.every((r) => r.status !== 'pending')) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const byTicket = (id: string) => rows.find((r) => r.related_ticket_id === id)!;
    expect(byTicket(unrated).status).toBe('failed');
    expect(['not_allowlisted', 'sms_disabled']).toContain(byTicket(unrated).failed_reason);
    expect(byTicket(rated)).toMatchObject({ status: 'failed', failed_reason: 'stale' });
  }, 90000);
});
```
(The two tickets use different barbers because a barber can have only one `in_service` ticket at a time.)

- [ ] **Step 6: Commit and hand over**

```bash
git add supabase/migrations/20261007100200_feedback_request_claim.sql supabase/functions/_shared/notification-sms-core.ts supabase/functions/_shared/notification-push-core.ts tests/unit/notification-sms-core.test.ts tests/unit/notification-push-core.test.ts tests/db/feedback-request-sending.test.ts packages/shared/src/database.types.ts
git commit -m "feat: send the after-visit feedback request through send-notifications"
```
Report "ready for push and deploy". After both: `npx vitest run tests/db/feedback-request-sending.test.ts tests/db/push-sending.test.ts tests/db/send-notifications.test.ts` and the unit tests — Expected: PASS.

---

### Task 4: Customer screens — rating form and Profile history

**Files:**
- Create: `apps/customer/app/tickets/feedbackErrors.ts`, `apps/customer/app/tickets/feedbackErrors.test.ts`
- Create: `apps/customer/app/tickets/[id]/FeedbackForm.tsx`
- Modify: `apps/customer/app/tickets/[id]/page.tsx`
- Modify: `apps/customer/app/profile/page.tsx`
- Modify: `apps/customer/messages/en.json`
- Create: `e2e/customer-feedback.spec.ts`

**Interfaces:**
- Consumes: `submit_feedback`, `list_my_feedback` (Task 1); customers can `select` their own `feedback` rows (existing RLS policy `feedback_customer_own`).
- Produces: `feedbackErrorKey(message: string | undefined): 'closed' | 'thanks' | 'generic'`; `<FeedbackForm ticketId={string} completedAt={string | null} />`.

- [ ] **Step 1: Write the failing mapper test**

Create `apps/customer/app/tickets/feedbackErrors.test.ts`:
```typescript
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { feedbackErrorKey } from './feedbackErrors';

describe('feedbackErrorKey', () => {
  it.each([
    ['too_late', 'closed'],
    ['already_submitted', 'thanks'],
    ['invalid_rating', 'generic'],
    ['Failed to fetch', 'generic'],
    [undefined, 'generic'],
  ] as const)('maps %s to %s', (code, key) => {
    expect(feedbackErrorKey(code)).toBe(key);
  });
});
```
Run: `npx vitest run apps/customer/app/tickets/feedbackErrors.test.ts --environment=node` — Expected: FAIL (module not found).

- [ ] **Step 2: Create the mapper**

Create `apps/customer/app/tickets/feedbackErrors.ts`:
```typescript
/** What the rating form shows for a submit_feedback error: closed window, already rated (show the
 * thank-you state), or a generic retry message. */
export function feedbackErrorKey(message: string | undefined): 'closed' | 'thanks' | 'generic' {
  if (message === 'too_late') return 'closed';
  if (message === 'already_submitted') return 'thanks';
  return 'generic';
}
```
Re-run the test — Expected: PASS.

- [ ] **Step 3: Add the messages**

In `apps/customer/messages/en.json` add a top-level namespace:
```json
  "Feedback": {
    "title": "How was your visit?",
    "stars": "{count, plural, one {# star} other {# stars}}",
    "tellUsMore": "Tell us more",
    "serviceQuality": "Service quality",
    "barberProfessionalism": "Barber professionalism",
    "waitingExperience": "Waiting experience",
    "cleanliness": "Cleanliness",
    "value": "Value for money",
    "commentPlaceholder": "Anything you'd like to add? (optional)",
    "send": "Send",
    "thanks": "Thanks for your feedback!",
    "closed": "Feedback for this visit has closed.",
    "failed": "Couldn't send your feedback. Please try again."
  }
```
and to `Profile` add `"feedbackItem": "{date} · {branch} · {barber} · {stars, plural, one {# star} other {# stars}}"`.

- [ ] **Step 4: Create the form**

Create `apps/customer/app/tickets/[id]/FeedbackForm.tsx`:
```tsx
'use client';

// After-visit rating (Docs/superpowers/specs/2026-10-07-after-visit-feedback-design.md): overall
// stars required, optional comment and five optional detail rows. Shown for completed tickets
// within 7 days; a ticket that already has feedback shows the thank-you state.
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import { feedbackErrorKey } from '../feedbackErrors';

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DETAILS = [
  { key: 'serviceQuality', param: 'p_service_quality' },
  { key: 'barberProfessionalism', param: 'p_barber_professionalism' },
  { key: 'waitingExperience', param: 'p_waiting_experience' },
  { key: 'cleanliness', param: 'p_cleanliness' },
  { key: 'value', param: 'p_value' },
] as const;
type DetailParam = (typeof DETAILS)[number]['param'];
type View = 'loading' | 'form' | 'thanks' | 'closed' | 'hidden';

function StarRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (n: number) => void;
}) {
  const t = useTranslations('Feedback');
  return (
    <div role="group" aria-label={label}>
      <span>{label}</span>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          aria-pressed={value !== null && n <= value}
          aria-label={t('stars', { count: n })}
          onClick={() => onChange(n)}
        >
          {value !== null && n <= value ? '★' : '☆'}
        </button>
      ))}
    </div>
  );
}

export default function FeedbackForm({
  ticketId,
  completedAt,
}: {
  ticketId: string;
  completedAt: string | null;
}) {
  const t = useTranslations('Feedback');
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [view, setView] = useState<View>('loading');
  const [overall, setOverall] = useState<number | null>(null);
  const [details, setDetails] = useState<Partial<Record<DetailParam, number>>>({});
  const [showDetails, setShowDetails] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [thanksStars, setThanksStars] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from('feedback')
      .select('overall_rating')
      .eq('ticket_id', ticketId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        if (data) {
          setThanksStars(data.overall_rating);
          setView('thanks');
          return;
        }
        const open = completedAt === null || Date.parse(completedAt) > Date.now() - WINDOW_MS;
        setView(open ? 'form' : 'hidden');
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, ticketId, completedAt]);

  async function send() {
    if (overall === null) return;
    setBusy(true);
    setFailed(false);
    try {
      const { error } = await supabase.rpc('submit_feedback', {
        p_ticket_id: ticketId,
        p_overall: overall,
        ...details,
        p_comment: comment,
      });
      if (!error) {
        setThanksStars(overall);
        setView('thanks');
        return;
      }
      const key = feedbackErrorKey(error.message);
      if (key === 'thanks') setView('thanks');
      else if (key === 'closed') setView('closed');
      else setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (view === 'loading' || view === 'hidden') return null;
  if (view === 'closed') return <p>{t('closed')}</p>;
  if (view === 'thanks') {
    return (
      <p>
        {t('thanks')}
        {thanksStars !== null && ` ${'★'.repeat(thanksStars)}`}
      </p>
    );
  }
  return (
    <section aria-label={t('title')}>
      <h2>{t('title')}</h2>
      <StarRow label={t('title')} value={overall} onChange={setOverall} />
      {!showDetails && (
        <button type="button" onClick={() => setShowDetails(true)}>
          {t('tellUsMore')}
        </button>
      )}
      {showDetails &&
        DETAILS.map((d) => (
          <StarRow
            key={d.key}
            label={t(d.key)}
            value={details[d.param] ?? null}
            onChange={(n) => setDetails((prev) => ({ ...prev, [d.param]: n }))}
          />
        ))}
      <textarea
        maxLength={1000}
        placeholder={t('commentPlaceholder')}
        aria-label={t('commentPlaceholder')}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
      {failed && <p role="alert">{t('failed')}</p>}
      <button type="button" disabled={overall === null || busy} onClick={send}>
        {t('send')}
      </button>
    </section>
  );
}
```
The `setView` calls in the effect run inside the async `.then` callback (not synchronously in the effect body), and `Date.now()` is in the effect, not in render — both satisfy the lint rules.

- [ ] **Step 5: Show it on the ticket page**

In `apps/customer/app/tickets/[id]/page.tsx`: `import FeedbackForm from './FeedbackForm';` and replace `{isCompleted && <p>{t('stateCompleted')}</p>}` with:
```tsx
      {isCompleted && (
        <>
          <p>{t('stateCompleted')}</p>
          <FeedbackForm ticketId={ticket.id} completedAt={ticket.completed_at} />
        </>
      )}
```

- [ ] **Step 6: List feedback in Profile**

In `apps/customer/app/profile/page.tsx`:
- Add state:
```typescript
  const [feedback, setFeedback] = useState<
    {
      id: string;
      created_at: string;
      branch_name: string;
      barber_name: string;
      overall_rating: number;
      comment: string | null;
    }[]
  >([]);
```
- In `load()`, after `setCustomer(customerRow ?? null);`, add:
```typescript
    const { data: feedbackRows } = await supabase.rpc('list_my_feedback');
    setFeedback(feedbackRows ?? []);
```
- Replace `<p>{t('noFeedback')}</p>` (under the `feedbackHistoryTitle` heading) with:
```tsx
      {feedback.length === 0 ? (
        <p>{t('noFeedback')}</p>
      ) : (
        <ul>
          {feedback.map((fb) => (
            <li key={fb.id}>
              <p>
                {t('feedbackItem', {
                  date: new Date(fb.created_at).toLocaleDateString('en-GB', {
                    weekday: 'short',
                    day: 'numeric',
                    month: 'short',
                    timeZone: 'UTC',
                  }),
                  branch: fb.branch_name,
                  barber: fb.barber_name,
                  stars: fb.overall_rating,
                })}
              </p>
              {fb.comment && <p>{fb.comment}</p>}
            </li>
          ))}
        </ul>
      )}
```
(`new Date(fb.created_at)` formats a stored value, not the current time — allowed by the purity rule.)

- [ ] **Step 7: Write the e2e**

First check an unused phone range: `grep -rn "+233552" e2e tests` must print nothing (else pick the first free `+23355N` and update the constant).

Create `e2e/customer-feedback.spec.ts`:
```typescript
// e2e/customer-feedback.spec.ts
// After-visit feedback, customer side: a completed visit shows "How was your visit?"; the customer
// rates it (overall + one detail + comment), sees the thank-you state, and finds it in Profile.
// Clicks use Enter and are scoped to <main>.
import { test, expect } from '@playwright/test';
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PASSWORD = 'Test-Password-123!';

test('customer rates a completed visit and sees it in Profile', async ({
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
  // 0552… : distinct from the phone ranges other test files use.
  const phone = `+233552${suffix.slice(-6)}`;
  const barberEmail = `fb-e2e-${suffix}@test.pixelbarber.local`;

  let service: { id: string } | null = null;
  let branch: { id: string } | null = null;
  let bs: { id: string } | null = null;
  let barberAuthId: string | null = null;
  let barberStaffId: string | null = null;
  let barberId: string | null = null;
  let customerAuthId: string | null = null;
  let customerId: string | null = null;

  try {
    const { data: business } = await admin.from('businesses').select('id').limit(1).single();
    service = (
      await admin
        .from('services')
        .insert({
          business_id: business!.id,
          name: `FB E2E Cut ${suffix}`,
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
          name: `FB E2E Branch ${suffix}`,
          branch_code: `FB${suffix.slice(-6)}`,
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
    const { data: barberAuth } = await admin.auth.admin.createUser({
      email: barberEmail,
      password: PASSWORD,
      email_confirm: true,
    });
    barberAuthId = barberAuth.user!.id;
    barberStaffId = (
      await admin
        .from('staff_users')
        .insert({
          auth_user_id: barberAuthId,
          name: 'FB E2E Barber',
          email: barberEmail,
          role: 'barber',
          invite_status: 'accepted',
        })
        .select('id')
        .single()
    ).data!.id;
    barberId = (
      await admin
        .from('barbers')
        .insert({ staff_user_id: barberStaffId, home_branch_id: branch!.id, status: 'available' })
        .select('id')
        .single()
    ).data!.id;
    const { data: customerAuth } = await admin.auth.admin.createUser({
      phone,
      password: PASSWORD,
      phone_confirm: true,
    });
    customerAuthId = customerAuth.user!.id;
    customerId = (
      await admin
        .from('customers')
        .insert({
          auth_user_id: customerAuthId,
          name: 'FB E2E Customer',
          phone_e164: phone,
          avatar_key: 'avatar-1',
        })
        .select('id')
        .single()
    ).data!.id;
    const { data: ticket } = await admin
      .from('queue_tickets')
      .insert({
        ticket_number: `PB-FBE-${suffix}`,
        branch_id: branch!.id,
        customer_id: customerId!,
        branch_service_id: bs!.id,
        assigned_barber_id: barberId!,
        state: 'completed',
        completed_at: new Date().toISOString(),
        created_by: 'customer',
      })
      .select('id')
      .single();

    const { data: session } = await createClient<Database>(url, anonKey).auth.signInWithPassword({
      phone,
      password: PASSWORD,
    });
    const projectRef = new URL(url).hostname.split('.')[0];
    const cookieValue =
      'base64-' +
      Buffer.from(JSON.stringify(session.session), 'utf-8')
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
    await page.goto(`/tickets/${ticket!.id}`);
    const overall = main.getByRole('group', { name: 'How was your visit?' });
    await expect(overall).toBeVisible({ timeout: 15000 });
    await overall.getByRole('button', { name: '4 stars' }).press('Enter');
    await main.getByRole('button', { name: 'Tell us more' }).press('Enter');
    await main
      .getByRole('group', { name: 'Cleanliness' })
      .getByRole('button', { name: '5 stars' })
      .press('Enter');
    await main
      .getByLabel("Anything you'd like to add? (optional)")
      .fill('Sharp fade, quick service');
    await main.getByRole('button', { name: 'Send' }).press('Enter');
    await expect(main.getByText('Thanks for your feedback!')).toBeVisible({ timeout: 15000 });

    const { data: saved } = await admin
      .from('feedback')
      .select('overall_rating, cleanliness_rating, comment, barber_id')
      .eq('ticket_id', ticket!.id)
      .single();
    expect(saved).toMatchObject({
      overall_rating: 4,
      cleanliness_rating: 5,
      comment: 'Sharp fade, quick service',
      barber_id: barberId,
    });

    await page.goto('/profile');
    await expect(main.getByText('Sharp fade, quick service')).toBeVisible({ timeout: 15000 });
    await expect(main.getByText(/FB E2E Branch .* · FB E2E Barber · 4 stars/)).toBeVisible();
  } finally {
    const failures: string[] = [];
    const check = (label: string, res: { error: { message: string } | null }) => {
      if (res.error) failures.push(`${label}: ${res.error.message}`);
    };
    if (branch) {
      const { data: tickets } = await admin
        .from('queue_tickets')
        .select('id')
        .eq('branch_id', branch.id);
      const ticketIds = (tickets ?? []).map((t) => t.id);
      if (ticketIds.length) {
        check('feedback', await admin.from('feedback').delete().in('ticket_id', ticketIds));
        check(
          'notifications',
          await admin.from('notifications').delete().in('related_ticket_id', ticketIds),
        );
        check('queue_events', await admin.from('queue_events').delete().in('ticket_id', ticketIds));
      }
      check('queue_tickets', await admin.from('queue_tickets').delete().eq('branch_id', branch.id));
      check(
        'branch_ticket_counters',
        await admin.from('branch_ticket_counters').delete().eq('branch_id', branch.id),
      );
    }
    if (customerId) check('customers', await admin.from('customers').delete().eq('id', customerId));
    if (customerAuthId) await admin.auth.admin.deleteUser(customerAuthId);
    if (barberStaffId)
      check('staff_users', await admin.from('staff_users').delete().eq('id', barberStaffId));
    if (barberAuthId) await admin.auth.admin.deleteUser(barberAuthId);
    if (bs) check('branch_services', await admin.from('branch_services').delete().eq('id', bs.id));
    if (branch) check('branches', await admin.from('branches').delete().eq('id', branch.id));
    if (service) check('services', await admin.from('services').delete().eq('id', service.id));
    if (failures.length) throw new Error(`Cleanup failed:\n${failures.join('\n')}`);
  }
});
```
(`barbers` rows go with `staff_users` via `on delete cascade`.)

- [ ] **Step 8: Run, lint, commit**

Both dev servers running: `npx playwright test e2e/customer-feedback.spec.ts e2e/customer-nav.spec.ts e2e/push-notifications.spec.ts --reporter=line --workers=1` — Expected: PASS. Typecheck; `cd apps/customer && npx eslint "app/tickets/[id]/FeedbackForm.tsx" "app/tickets/[id]/page.tsx" app/tickets/feedbackErrors.ts app/profile/page.tsx`; U+FFFD grep on `en.json` and the form.
```bash
git add apps/customer/app/tickets/feedbackErrors.ts apps/customer/app/tickets/feedbackErrors.test.ts "apps/customer/app/tickets/[id]/FeedbackForm.tsx" "apps/customer/app/tickets/[id]/page.tsx" apps/customer/app/profile/page.tsx apps/customer/messages/en.json e2e/customer-feedback.spec.ts
git commit -m "feat: customer rates a completed visit and sees feedback history"
```

---

### Task 5: Staff screens — low-rating banner and Feedback page

**Files:**
- Create: `apps/staff/app/feedback/LowRatingBanner.tsx`, `apps/staff/app/feedback/page.tsx`
- Modify: `apps/staff/app/StaffHeader.tsx`, `apps/staff/app/page.tsx`, `apps/staff/messages/en.json`
- Create: `e2e/staff-feedback.spec.ts`

**Interfaces:**
- Consumes: `list_unseen_low_feedback_count`, `mark_feedback_seen`, `list_branch_feedback`, `branch_feedback_summary` (Task 2); `loadManageableBranches` / `ManageableBranch` from `apps/staff/app/settings/barbers/scope.ts`; `has_capability(cap)` RPC.
- Produces: window event `pixelbarber:feedback-seen` (dispatched after Mark as seen; the banner refreshes on it); export `FEEDBACK_SEEN_EVENT`.

- [ ] **Step 1: Write the failing e2e**

Create `e2e/staff-feedback.spec.ts`:
```typescript
// e2e/staff-feedback.spec.ts
// After-visit feedback, staff side: a branch manager sees the low-rating banner, opens Feedback,
// marks the rating seen, and the banner disappears. Clicks use Enter; page content is in <main>,
// the banner is in the header.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const STAFF = 'http://localhost:3001';
const PASSWORD = 'Test-Password-123!';

test('branch manager sees a low rating, marks it seen, and the banner clears', async ({ page }) => {
  test.skip(!url || !serviceRoleKey, 'Supabase env vars not set');
  test.setTimeout(120_000);
  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const suffix = String(Date.now());
  const managerEmail = `sfb-mgr-${suffix}@test.pixelbarber.local`;
  const barberEmail = `sfb-barber-${suffix}@test.pixelbarber.local`;
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
          name: `SFB E2E Cut ${suffix}`,
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
          name: `SFB E2E Branch ${suffix}`,
          branch_code: `SF${suffix.slice(-6)}`,
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
    const staff = async (email: string, name: string, role: 'barber' | 'branch_manager') => {
      const { data: auth } = await admin.auth.admin.createUser({
        email,
        password: PASSWORD,
        email_confirm: true,
      });
      created.authIds.push(auth.user!.id);
      const { data: row } = await admin
        .from('staff_users')
        .insert({ auth_user_id: auth.user!.id, name, email, role, invite_status: 'accepted' })
        .select('id')
        .single();
      created.staffIds.push(row!.id);
      return row!.id as string;
    };
    const barberStaffId = await staff(barberEmail, 'SFB E2E Barber', 'barber');
    const { data: barber } = await admin
      .from('barbers')
      .insert({ staff_user_id: barberStaffId, home_branch_id: branch!.id, status: 'available' })
      .select('id')
      .single();
    const managerStaffId = await staff(managerEmail, 'SFB E2E Manager', 'branch_manager');
    await admin
      .from('staff_branch_assignments')
      .insert({ staff_user_id: managerStaffId, branch_id: branch!.id });
    // A staff-created customer (no app account) rated through admin for this test.
    customerId = (
      await admin
        .from('customers')
        .insert({ name: 'Kofi Rater', phone_e164: `+233550${suffix.slice(-6)}` })
        .select('id')
        .single()
    ).data!.id;
    const { data: ticket } = await admin
      .from('queue_tickets')
      .insert({
        ticket_number: `PB-SFB-${suffix}`,
        branch_id: branch!.id,
        customer_id: customerId!,
        branch_service_id: bs!.id,
        assigned_barber_id: barber!.id,
        state: 'completed',
        completed_at: new Date().toISOString(),
        created_by: 'staff',
      })
      .select('id')
      .single();
    await admin.from('feedback').insert({
      ticket_id: ticket!.id,
      customer_id: customerId!,
      branch_id: branch!.id,
      barber_id: barber!.id,
      overall_rating: 1,
      comment: 'Waited 40 minutes past my turn',
    });

    await page.goto(`${STAFF}/login`);
    await page.getByPlaceholder('Email or phone').fill(managerEmail);
    await page.getByPlaceholder('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Log In' }).press('Enter');
    await page.waitForURL(/\/tickets/, { timeout: 15000 });

    const banner = page.getByRole('link', { name: /1 new low rating — View/ });
    await expect(banner).toBeVisible({ timeout: 15000 });
    await banner.press('Enter');
    await expect(page).toHaveURL(/\/feedback$/, { timeout: 15000 });
    const main = page.locator('main');
    await main.getByLabel('Branch', { exact: true }).selectOption(branch!.id);
    await expect(main.getByText('Waited 40 minutes past my turn')).toBeVisible({ timeout: 15000 });
    await expect(main.getByText('Last 30 days: 1.00 average from 1 ratings')).toBeVisible();
    await main.getByRole('button', { name: 'Mark as seen' }).press('Enter');
    await expect(main.getByText(/Seen by SFB E2E Manager on/)).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('link', { name: /new low rating/ })).toHaveCount(0, {
      timeout: 15000,
    });
  } finally {
    const failures: string[] = [];
    const check = (label: string, res: { error: { message: string } | null }) => {
      if (res.error) failures.push(`${label}: ${res.error.message}`);
    };
    if (branch) {
      const { data: tickets } = await admin
        .from('queue_tickets')
        .select('id')
        .eq('branch_id', branch.id);
      const ticketIds = (tickets ?? []).map((t) => t.id);
      if (ticketIds.length) {
        check('feedback', await admin.from('feedback').delete().in('ticket_id', ticketIds));
        check(
          'notifications',
          await admin.from('notifications').delete().in('related_ticket_id', ticketIds),
        );
        check('queue_events', await admin.from('queue_events').delete().in('ticket_id', ticketIds));
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
Check the staff login redirect and selectors against `e2e/staff-logout.spec.ts` (same login form; branch managers land on `/tickets`). Check `+233550` is unused (`grep -rn "+233550" e2e tests`). Run with both dev servers: `npx playwright test e2e/staff-feedback.spec.ts --reporter=line --workers=1` — Expected: FAIL (no banner).

- [ ] **Step 2: Add the messages**

In `apps/staff/messages/en.json`: add to `Home` `"feedbackLink": "Feedback"`, and a namespace:
```json
  "Feedback": {
    "title": "Feedback",
    "banner": "{count, plural, one {# new low rating} other {# new low ratings}} — View",
    "branch": "Branch",
    "summary": "Last 30 days: {average} average from {count} ratings",
    "summaryNone": "Last 30 days: no ratings yet",
    "empty": "No feedback yet for this branch.",
    "loadFailed": "Couldn't load feedback.",
    "noBranches": "You don't manage any branches.",
    "markSeen": "Mark as seen",
    "seenBy": "Seen by {name} on {date}",
    "stars": "{count, plural, one {# star} other {# stars}}",
    "details": "Service {service} · Professionalism {professionalism} · Waiting {waiting} · Cleanliness {cleanliness} · Value {value}",
    "line": "{date} · {customer} · {barber} · {service}"
  }
```

- [ ] **Step 3: Create the banner and put it in the header**

Create `apps/staff/app/feedback/LowRatingBanner.tsx`:
```tsx
'use client';

// Red "new low rating" banner for owners/branch managers (list_unseen_low_feedback_count returns 0
// for everyone else). Refreshes on load, every 60 s, and when the Feedback page marks one seen.
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';

export const FEEDBACK_SEEN_EVENT = 'pixelbarber:feedback-seen';

export function LowRatingBanner() {
  const t = useTranslations('Feedback');
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      supabase.rpc('list_unseen_low_feedback_count').then(({ data, error }) => {
        if (!cancelled && !error) setCount(data ?? 0);
      });
    };
    load();
    const timer = setInterval(load, 60_000);
    window.addEventListener(FEEDBACK_SEEN_EVENT, load);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener(FEEDBACK_SEEN_EVENT, load);
    };
  }, [supabase]);

  if (count === 0) return null;
  return (
    <Link
      href="/feedback"
      style={{ background: '#B91C1C', color: '#FFFFFF', padding: '0.25rem 0.5rem' }}
    >
      {t('banner', { count })}
    </Link>
  );
}
```
In `apps/staff/app/StaffHeader.tsx`: `import { LowRatingBanner } from './feedback/LowRatingBanner';` and render `<LowRatingBanner />` inside `<header>` before the Log out button.

- [ ] **Step 4: Create the Feedback page**

Create `apps/staff/app/feedback/page.tsx`:
```tsx
'use client';

// Staff Feedback page (Docs/superpowers/specs/2026-10-07-after-visit-feedback-design.md): branch
// picker, 30-day summary, latest ratings with low ones highlighted and Mark as seen for
// owners/branch managers.
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';
import { loadManageableBranches, type ManageableBranch } from '../settings/barbers/scope';
import { FEEDBACK_SEEN_EVENT } from './LowRatingBanner';

type Row = Database['public']['Functions']['list_branch_feedback']['Returns'][number];
type Loaded =
  | { key: string; kind: 'ok'; rows: Row[]; average: number | null; count: number }
  | { key: string; kind: 'error' };

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });

export default function FeedbackPage() {
  const t = useTranslations('Feedback');
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [branches, setBranches] = useState<ManageableBranch[]>([]);
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [canEscalate, setCanEscalate] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const requestKey = `${branchId}:${reloadKey}`;

  useEffect(() => {
    let cancelled = false;
    loadManageableBranches(supabase)
      .then((list) => {
        if (cancelled) return;
        setBranches(list);
        setBranchesLoaded(true);
        setBranchId((prev) => prev ?? list[0]?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setBranchesLoaded(true);
      });
    supabase.rpc('has_capability', { cap: 'handle_escalations' }).then(({ data }) => {
      if (!cancelled) setCanEscalate(data === true);
    });
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  useEffect(() => {
    if (!branchId) return;
    let cancelled = false;
    Promise.all([
      supabase.rpc('list_branch_feedback', { p_branch_id: branchId }),
      supabase.rpc('branch_feedback_summary', { p_branch_id: branchId }),
    ]).then(([list, summary]) => {
      if (cancelled) return;
      if (list.error || summary.error) {
        setLoaded({ key: requestKey, kind: 'error' });
        return;
      }
      const s = summary.data?.[0];
      setLoaded({
        key: requestKey,
        kind: 'ok',
        rows: list.data ?? [],
        average: s?.average_rating ?? null,
        count: s?.rating_count ?? 0,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [supabase, branchId, requestKey]);

  async function markSeen(id: string) {
    const { error } = await supabase.rpc('mark_feedback_seen', { p_feedback_id: id });
    if (!error) window.dispatchEvent(new Event(FEEDBACK_SEEN_EVENT));
    setReloadKey((k) => k + 1);
  }

  const current = loaded && loaded.key === requestKey ? loaded : null;

  return (
    <main>
      <h1>{t('title')}</h1>
      {branchesLoaded && branches.length === 0 && <p>{t('noBranches')}</p>}
      {branches.length > 0 && (
        <label>
          {t('branch')}
          <select value={branchId ?? ''} onChange={(e) => setBranchId(e.target.value)}>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {current?.kind === 'error' && <p role="alert">{t('loadFailed')}</p>}
      {current?.kind === 'ok' && (
        <>
          <p>
            {current.count === 0
              ? t('summaryNone')
              : t('summary', {
                  average: Number(current.average).toFixed(2),
                  count: current.count,
                })}
          </p>
          {current.rows.length === 0 ? (
            <p>{t('empty')}</p>
          ) : (
            <ul>
              {current.rows.map((r) => {
                const low = r.overall_rating <= 2;
                const hasDetails = [
                  r.service_quality_rating,
                  r.barber_professionalism_rating,
                  r.waiting_experience_rating,
                  r.cleanliness_rating,
                  r.value_rating,
                ].some((v) => v !== null);
                return (
                  <li
                    key={r.id}
                    style={
                      low ? { borderLeft: '4px solid #B91C1C', paddingLeft: '0.5rem' } : undefined
                    }
                  >
                    <p>
                      {t('line', {
                        date: formatDate(r.created_at),
                        customer: r.customer_first_name,
                        barber: r.barber_name,
                        service: r.service_name,
                      })}
                    </p>
                    <p>{t('stars', { count: r.overall_rating })}</p>
                    {hasDetails && (
                      <p>
                        {t('details', {
                          service: r.service_quality_rating ?? '—',
                          professionalism: r.barber_professionalism_rating ?? '—',
                          waiting: r.waiting_experience_rating ?? '—',
                          cleanliness: r.cleanliness_rating ?? '—',
                          value: r.value_rating ?? '—',
                        })}
                      </p>
                    )}
                    {r.comment && <p>{r.comment}</p>}
                    {low && r.seen_at && (
                      <p>
                        {t('seenBy', { name: r.seen_by_name ?? '—', date: formatDate(r.seen_at) })}
                      </p>
                    )}
                    {low && !r.seen_at && canEscalate && (
                      <button type="button" onClick={() => markSeen(r.id)}>
                        {t('markSeen')}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
```
The `<label>` wrapping the select gives it the accessible name `Branch` (`getByLabel('Branch', { exact: true })`). The `setBranchId` / `setLoaded` calls happen inside async callbacks.

- [ ] **Step 5: Link it from the staff home page**

In `apps/staff/app/page.tsx`: add `const [canViewReports, setCanViewReports] = useState(false);`; in the existing effect add
```typescript
    supabase
      .rpc('has_capability', { cap: 'view_branch_reports' })
      .then(({ data }) => setCanViewReports(data === true));
```
and after the Appointments link render `{canViewReports && <Link href="/feedback">{t('feedbackLink')}</Link>}`.

- [ ] **Step 6: Run, lint, commit**

`npx playwright test e2e/staff-feedback.spec.ts e2e/staff-logout.spec.ts e2e/appointments-staff.spec.ts --reporter=line --workers=1` — Expected: PASS. Typecheck; `cd apps/staff && npx eslint app/feedback/page.tsx app/feedback/LowRatingBanner.tsx app/StaffHeader.tsx app/page.tsx`; U+FFFD grep on `en.json` and the new files.
```bash
git add apps/staff/app/feedback apps/staff/app/StaffHeader.tsx apps/staff/app/page.tsx apps/staff/messages/en.json e2e/staff-feedback.spec.ts
git commit -m "feat: staff low-rating banner and Feedback page"
```

---

## After all tasks (controller)

1. Full vitest (paced re-runs of rate-limited files) and e2e: `customer-feedback`, `staff-feedback`, `customer-nav`, `push-notifications`, `appointments-staff`, `staff-logout`, `queue-join-now`.
2. Final whole-branch review, one fix wave, scoped re-review.
3. **Ask the user before promoting:** production migrations 20261007100000–100200 (dry run first) → deploy `send-notifications` → push to GitHub.
