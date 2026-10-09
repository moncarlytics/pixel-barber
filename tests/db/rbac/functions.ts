// tests/db/rbac/functions.ts
// Intended access per role for every function a client can call (the public functions with EXECUTE
// for authenticated or anon). `expect` is the intent; `currently` (with a gap id) records where the
// database differs today. Arguments aim at branch A / customer 0 / barber A / the fixture service, so
// `otherManager` (a manager of branch B) exercises the cross-branch refusal.
import { dateAt } from '../fixtures/appointments';
import { deleteAppointmentsByIds } from '../fixtures/appointments';
import {
  createRow,
  customerOf,
  deleteTicketDeep,
  hex,
  loose,
  probeBarber,
  runStack,
  ticketRow,
  track,
  type RbacFixture,
} from './fixture';
import { ROLES, type Expect, type Outcome, type PerRole, type Role } from './types';

export interface FunctionEntry {
  name: string;
  /** Arguments for this role's call; may create fresh rows with f.admin for mutating functions. */
  args: (f: RbacFixture, role: Role) => Promise<Record<string, unknown>>;
  outcome: PerRole<Outcome>;
  /** The function returns void: a call that raises nothing is a success, not an empty result. */
  void?: boolean;
  /** For void functions that silently do nothing for the wrong caller: whether the call took effect. */
  applied?: (f: RbacFixture, args: Record<string, unknown>) => Promise<boolean>;
}

// ---------------------------------------------------------------------------------------------
// Fresh rows. Each args builder first removes what the previous call of the same function made, so
// every call (allowed or not) starts from a clean, valid state; the test's afterAll drains the rest.
// ---------------------------------------------------------------------------------------------

type Undo = () => Promise<void>;
const scratch = new Map<string, Undo[]>();

/** Removes the rows made for `name` (every function when omitted); the first failure is thrown. */
export async function drainScratch(name?: string): Promise<void> {
  let first: unknown;
  for (const key of name ? [name] : [...scratch.keys()]) {
    const stack = scratch.get(key);
    if (!stack) continue;
    try {
      await runStack(stack);
    } catch (e) {
      first ??= e;
    }
  }
  if (first) throw first instanceof Error ? first : new Error(String(first));
}

interface Ctx {
  f: RbacFixture;
  role: Role;
  /** Registers cleanup of a row made for this call. */
  later: (undo: Undo) => void;
}

type Build = (c: Ctx) => Promise<Record<string, unknown>>;

const MIN = 60_000;
const branchA = (f: RbacFixture) => f.base.branchId;
const unwrap = <T>(r: { data: T | null; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  if (r.data === null) throw new Error(`${what}: no data`);
  return r.data;
};

/** A Wednesday inside the booking window: the weekly-hours days the fixture's barbers work. Day 2 is
 * skipped (customers 0 and 1 already have a fixture appointment then). */
function wednesday(): string {
  for (let i = 1; i <= 14; i++) {
    const d = dateAt(i);
    if (i !== 2 && new Date(`${d}T00:00:00.000Z`).getUTCDay() === 3) return d;
  }
  throw new Error('no usable Wednesday in the booking window');
}
const slot = (hhmm: string) => `${wednesday()}T${hhmm}:00.000Z`;

/** `minutes` from now, but never past 23:50 UTC, so the appointment stays "today". */
function laterToday(minutes: number): Date {
  const now = Date.now();
  const limit = new Date(`${dateAt(0)}T23:50:00.000Z`).getTime();
  return new Date(Math.min(now + minutes * MIN, Math.max(limit, now + MIN)));
}

async function removeAppointments(f: RbacFixture, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = loose(f);
  const tickets = await db.from('queue_tickets').select('id').in('appointment_id', ids);
  if (tickets.error) throw new Error(`undo appointment tickets: ${tickets.error.message}`);
  for (const t of tickets.data ?? []) await deleteTicketDeep(f, (t as { id: string }).id);
  await deleteAppointmentsByIds(f.admin, ids);
}

/** Removes every appointment booked at branch A for exactly this slot (made by the function under test). */
async function removeAppointmentsAt(f: RbacFixture, startIso: string): Promise<void> {
  const r = await loose(f)
    .from('appointments')
    .select('id')
    .eq('branch_id', branchA(f))
    .eq('scheduled_start', startIso);
  if (r.error) throw new Error(`undo bookings: ${r.error.message}`);
  await removeAppointments(
    f,
    (r.data ?? []).map((x: { id: string }) => x.id),
  );
}

async function insertAppointment(
  c: Ctx,
  customerId: string,
  start: Date,
  barberId: string | null,
): Promise<string> {
  const r = await loose(c.f)
    .from('appointments')
    .insert({
      customer_id: customerId,
      branch_id: branchA(c.f),
      branch_service_id: c.f.base.branchServiceId,
      preferred_barber_id: barberId,
      scheduled_start: start.toISOString(),
      scheduled_end: new Date(start.getTime() + 30 * MIN).toISOString(),
      status: 'scheduled',
      created_by: 'staff',
    })
    .select('id')
    .single();
  const id = unwrap(r, 'appointment').id as string;
  c.later(() => removeAppointments(c.f, [id]));
  return id;
}

/** A completed ticket at branch A (customer 0) with a feedback row of the given rating. */
async function insertFeedback(
  f: RbacFixture,
  rating: number,
  register: (undo: Undo) => void,
): Promise<string> {
  const row = ticketRow(f, 'a');
  await createRow(f, 'queue_tickets', row, 'feedback ticket');
  register(() => deleteTicketDeep(f, row.id));
  const r = await loose(f)
    .from('feedback')
    .insert({
      ticket_id: row.id,
      customer_id: customerOf(f, 'a').customerId,
      branch_id: branchA(f),
      barber_id: f.base.barberA.barberId,
      overall_rating: rating,
    })
    .select('id')
    .single();
  return unwrap(r, 'feedback').id as string;
}

/** Things built once per fixture and kept until the test's final cleanup. */
const shared = new WeakMap<
  RbacFixture,
  { lowFeedback?: Promise<string>; barber?: Promise<string> }
>();
const sharedOf = (f: RbacFixture) => {
  let s = shared.get(f);
  if (!s) shared.set(f, (s = {}));
  return s;
};
/** One unseen 1-star rating at branch A, for list_unseen_low_feedback_count. */
const lowFeedback = (f: RbacFixture) =>
  (sharedOf(f).lowFeedback ??= insertFeedback(f, 1, (undo) => track(f, undo)));
/** One throwaway barber at branch A, for the schedule functions (the fixture barbers stay untouched). */
const scheduleBarber = (f: RbacFixture) =>
  (sharedOf(f).barber ??= probeBarber(f, branchA(f)).then((b) => b.barberId));

// ---------------------------------------------------------------------------------------------
// Matrix helpers.
// ---------------------------------------------------------------------------------------------

const e = (
  expect: Outcome,
  why: string,
  extra: Partial<Expect<Outcome>> = {},
): Expect<Outcome> => ({
  expect,
  why,
  ...extra,
});

const ALL: readonly Role[] = ROLES;
const AUTHENTICATED: readonly Role[] = ROLES.filter((r) => r !== 'anon');
const STAFF: readonly Role[] = [
  'barber',
  'receptionist',
  'manager',
  'analyst',
  'owner',
  'otherManager',
];
const STAFF_EDIT: readonly Role[] = ['receptionist', 'manager', 'owner'];
const DASHBOARD: readonly Role[] = ['receptionist', 'manager', 'analyst', 'owner'];
const REPORTS: readonly Role[] = ['manager', 'analyst', 'owner'];
const MANAGE: readonly Role[] = ['manager', 'owner'];

interface Spec {
  allow: readonly Role[];
  /** Roles that are let in but get nothing back. */
  empty?: readonly Role[];
  /** The rule, in one line (PRD row or capability). */
  why: string;
  emptyWhy?: string;
  /** Per-role replacements (e.g. `currently` and a gap id). */
  patch?: Partial<Record<Role, Partial<Expect<Outcome>>>>;
}

function outcomes(spec: Spec): PerRole<Outcome> {
  const out = {} as PerRole<Outcome>;
  for (const r of ROLES) {
    const o: Outcome = spec.allow.includes(r)
      ? 'allow'
      : spec.empty?.includes(r)
        ? 'empty'
        : 'deny';
    out[r] = e(o, o === 'empty' ? (spec.emptyWhy ?? spec.why) : spec.why, spec.patch?.[r]);
  }
  return out;
}

const internal = (why: string): PerRole<Outcome> =>
  Object.fromEntries(ROLES.map((r) => [r, e('internal', why)])) as PerRole<Outcome>;

function entry(
  name: string,
  build: Build | null,
  outcome: PerRole<Outcome>,
  extra: Pick<FunctionEntry, 'void' | 'applied'> = {},
): FunctionEntry {
  return {
    name,
    outcome,
    ...extra,
    args: async (f, role) => {
      await drainScratch(name);
      if (!build) return {};
      return build({
        f,
        role,
        later: (undo) => {
          const stack = scratch.get(name) ?? [];
          stack.push(undo);
          scratch.set(name, stack);
        },
      });
    },
  };
}

const TRIGGER = 'trigger or helper function, not meaningfully callable';

export const FUNCTIONS: FunctionEntry[] = [
  // ---- session helpers: return the caller's own facts ----
  entry(
    'auth_branch_ids',
    null,
    outcomes({
      allow: ['receptionist', 'manager', 'analyst', 'otherManager'],
      empty: ['anon', 'customer', 'barber', 'owner'],
      why: "session helper: the caller's own branches",
      emptyWhy: 'session helper: this role carries no branch assignment, so the list is empty',
    }),
  ),
  entry('auth_role', null, outcomes({ allow: ALL, why: "session helper: the caller's own role" })),
  entry(
    'auth_staff_id',
    null,
    outcomes({
      allow: STAFF,
      empty: ['anon', 'customer'],
      why: "session helper: the caller's own staff id",
      emptyWhy: 'session helper: not a staff member, so there is no staff id',
    }),
  ),
  entry(
    'current_customer_id',
    null,
    outcomes({
      allow: ['customer'],
      empty: ROLES.filter((r) => r !== 'customer'),
      why: "session helper: the caller's own customer id",
      emptyWhy: 'session helper: not a customer, so there is no customer id',
    }),
  ),
  entry(
    'has_capability',
    async () => ({ cap: 'view_customers' }),
    outcomes({ allow: ALL, why: "session helper: answers for the caller's own role" }),
  ),
  entry(
    'in_branch_scope',
    async ({ f }) => ({ target_branch: branchA(f) }),
    outcomes({ allow: ALL, why: "session helper: answers for the caller's own branches" }),
  ),

  // ---- internal ----
  entry('bump_ticket_version', null, internal(TRIGGER)),
  entry('check_notification_recipient', null, internal(TRIGGER)),
  entry('set_updated_at', null, internal(TRIGGER)),
  entry('trg_barber_current_ticket', null, internal(TRIGGER)),
  entry('trg_refill_barber_schedule', null, internal(TRIGGER)),

  // ---- public booking ----
  entry(
    'list_bookable_barbers',
    async ({ f }) => ({ p_branch_id: branchA(f) }),
    outcomes({ allow: ALL, why: 'public booking: barbers a customer can pick' }),
  ),
  entry(
    'list_appointment_slots',
    async ({ f }) => ({
      p_branch_service_id: f.base.branchServiceId,
      p_barber_id: f.base.barberA.barberId,
      p_date: wednesday(),
    }),
    outcomes({ allow: AUTHENTICATED, why: 'public availability for signed-in users' }),
  ),
  entry(
    'preview_wait_estimate',
    async ({ f }) => ({
      p_branch_service_id: f.base.branchServiceId,
      p_barber_id: f.base.barberA.barberId,
    }),
    outcomes({ allow: AUTHENTICATED, why: 'public availability for signed-in users' }),
  ),
  entry(
    'find_eligible_barber',
    async ({ f }) => ({
      p_branch_id: branchA(f),
      p_branch_service_id: f.base.branchServiceId,
      p_preferred_barber_id: f.base.barberA.barberId,
    }),
    outcomes({ allow: AUTHENTICATED, why: 'public availability for signed-in users' }),
  ),
  entry(
    'link_or_create_customer',
    async () => ({ p_name: 'RBAC Probe' }),
    outcomes({
      allow: ['customer'],
      why: 'customer onboarding link',
      patch: {
        anon: {
          gap: 'J-link-customer-anon',
          why: 'pending user decision: anon holds EXECUTE; the call is refused inside the function (authentication required), so nothing is exposed',
        },
      },
    }),
  ),

  // ---- customer self-service ----
  entry(
    'book_appointment',
    async ({ f, later }) => {
      const start = slot('09:00');
      later(() => removeAppointmentsAt(f, start));
      return {
        p_branch_service_id: f.base.branchServiceId,
        p_barber_id: f.base.barberA.barberId,
        p_slot_start: start,
      };
    },
    outcomes({ allow: ['customer'], why: 'customer self-service booking' }),
  ),
  entry(
    'check_in_my_appointment',
    async (c) => ({
      p_appointment_id: await insertAppointment(
        c,
        customerOf(c.f, 'a').customerId,
        laterToday(20),
        null,
      ),
    }),
    outcomes({ allow: ['customer'], why: 'customer self-service check-in' }),
  ),
  entry(
    'cancel_appointment',
    async (c) => ({
      p_appointment_id: await insertAppointment(
        c,
        customerOf(c.f, 'a').customerId,
        new Date(slot('11:00')),
        c.f.base.barberA.barberId,
      ),
      p_reason: 'changed_plans',
    }),
    outcomes({ allow: ['customer'], why: 'customer self-service cancel' }),
    { void: true },
  ),
  entry(
    'reschedule_appointment',
    async (c) => ({
      p_appointment_id: await insertAppointment(
        c,
        customerOf(c.f, 'a').customerId,
        new Date(slot('14:00')),
        c.f.base.barberA.barberId,
      ),
      p_slot_start: slot('15:00'),
    }),
    outcomes({ allow: ['customer'], why: 'customer self-service reschedule' }),
    { void: true },
  ),
  entry(
    'submit_feedback',
    async (c) => {
      const row = ticketRow(c.f, 'a');
      await createRow(c.f, 'queue_tickets', row, 'feedback ticket');
      c.later(() => deleteTicketDeep(c.f, row.id));
      return { p_ticket_id: row.id, p_overall: 5 };
    },
    outcomes({ allow: ['customer'], why: 'customer self-service feedback' }),
  ),
  entry(
    'list_my_feedback',
    null,
    outcomes({
      allow: ['customer'],
      empty: AUTHENTICATED.filter((r) => r !== 'customer'),
      why: "customer self-service: the caller's own feedback",
      emptyWhy: "returns only the caller's own customer feedback, so non-customers get none",
    }),
  ),
  entry(
    'save_push_subscription',
    async ({ f, later }) => {
      const endpoint = `https://push.example/rbac-fn-save-${hex(12)}`;
      later(async () => {
        const r = await loose(f).from('push_subscriptions').delete().eq('endpoint', endpoint);
        if (r.error) throw new Error(`undo push subscription: ${r.error.message}`);
      });
      return {
        p_endpoint: endpoint,
        p_p256dh: 'rbac-key',
        p_auth: 'rbac-auth',
        p_user_agent: 'rbac',
      };
    },
    outcomes({ allow: ['customer'], why: 'customer self-service push subscription' }),
    { void: true },
  ),
  entry(
    'remove_push_subscription',
    async ({ f, later }) => {
      const endpoint = `https://push.example/rbac-fn-remove-${hex(12)}`;
      const r = await loose(f)
        .from('push_subscriptions')
        .insert({
          customer_id: customerOf(f, 'a').customerId,
          endpoint,
          p256dh_key: 'rbac-key',
          auth_key: 'rbac-auth',
        });
      if (r.error) throw new Error(`push subscription: ${r.error.message}`);
      later(async () => {
        const d = await loose(f).from('push_subscriptions').delete().eq('endpoint', endpoint);
        if (d.error) throw new Error(`undo push subscription: ${d.error.message}`);
      });
      return { p_endpoint: endpoint };
    },
    outcomes({
      allow: ['customer'],
      empty: AUTHENTICATED.filter((r) => r !== 'customer'),
      why: 'customer self-service push subscription',
      emptyWhy:
        "removes only the caller's own customer subscription; for anyone else it does nothing",
    }),
    {
      void: true,
      applied: async (f, args) => {
        const r = await loose(f)
          .from('push_subscriptions')
          .select('id', { count: 'exact', head: true })
          .eq('endpoint', args.p_endpoint as string);
        if (r.error) throw new Error(`push subscription check: ${r.error.message}`);
        return (r.count ?? 0) === 0;
      },
    },
  ),
  entry(
    'list_my_appointments_today',
    async (c) => {
      await insertAppointment(
        c,
        customerOf(c.f, 'a').customerId,
        laterToday(45),
        c.f.base.barberA.barberId,
      );
      return {};
    },
    outcomes({
      allow: ['barber'],
      empty: AUTHENTICATED.filter((r) => r !== 'barber'),
      why: "the barber's own day",
      emptyWhy: "lists only the signed-in barber's own appointments, so other roles get none",
    }),
  ),

  // ---- staff: dashboard, reports, customers ----
  entry(
    'branch_today',
    async ({ f }) => ({ p_branch_id: branchA(f) }),
    outcomes({ allow: DASHBOARD, why: 'view_branch_dashboard at the branch' }),
  ),
  entry(
    'branch_report',
    async ({ f }) => ({ p_branch_ids: [branchA(f)], p_from: dateAt(-7), p_to: dateAt(0) }),
    outcomes({ allow: REPORTS, why: 'view_branch_reports at the branch' }),
  ),
  entry(
    'branch_feedback_summary',
    async ({ f }) => ({ p_branch_id: branchA(f) }),
    outcomes({ allow: REPORTS, why: 'view_branch_reports at the branch' }),
  ),
  entry(
    'list_branch_feedback',
    async ({ f }) => ({ p_branch_id: branchA(f) }),
    outcomes({ allow: REPORTS, why: 'view_branch_reports at the branch' }),
  ),
  entry(
    'list_customers',
    async ({ f }) => ({ p_branch_ids: [branchA(f)], p_search: null, p_group: null, p_offset: 0 }),
    outcomes({ allow: DASHBOARD, why: 'view_customers at the branch' }),
  ),
  entry(
    'customer_detail',
    async ({ f }) => ({
      p_customer_id: customerOf(f, 'a').customerId,
      p_branch_ids: [branchA(f)],
    }),
    outcomes({ allow: DASHBOARD, why: 'view_customers at the branch' }),
  ),
  entry(
    'send_customer_message',
    async ({ f, later }) => {
      later(async () => {
        const r = await loose(f)
          .from('notifications')
          .delete()
          .eq('recipient_id', customerOf(f, 'a').customerId)
          .eq('notification_type', 'staff_message')
          .eq('payload->>text', 'RBAC function probe');
        if (r.error) throw new Error(`undo staff message: ${r.error.message}`);
      });
      return {
        p_customer_id: customerOf(f, 'a').customerId,
        p_branch_id: branchA(f),
        p_text: 'RBAC function probe',
      };
    },
    outcomes({ allow: STAFF_EDIT, why: 'message_customers at the branch' }),
  ),
  entry(
    'mark_feedback_seen',
    async (c) => ({ p_feedback_id: await insertFeedback(c.f, 5, c.later) }),
    outcomes({ allow: MANAGE, why: 'handle_escalations at the branch' }),
    { void: true },
  ),
  entry(
    'list_unseen_low_feedback_count',
    async ({ f }) => {
      await lowFeedback(f);
      return {};
    },
    outcomes({
      allow: MANAGE,
      empty: AUTHENTICATED.filter((r) => !MANAGE.includes(r)),
      why: 'handle_escalations at the branch',
      emptyWhy: 'counts 0 without handle_escalations or when the branch has no unseen low ratings',
    }),
  ),
  entry(
    'set_long_wait_warning',
    async ({ f }) => ({ p_branch_id: branchA(f), p_minutes: 20 }),
    outcomes({ allow: MANAGE, why: 'edit_hours at the branch' }),
    { void: true },
  ),

  // ---- staff: appointments ----
  entry(
    'list_branch_appointments',
    async ({ f }) => ({ p_branch_id: branchA(f), p_date: dateAt(2) }),
    outcomes({ allow: STAFF_EDIT, why: 'edit_tickets at the branch' }),
  ),
  entry(
    'get_branch_appointment',
    async ({ f }) => ({ p_appointment_id: f.rows.appointments!.a[0]! }),
    outcomes({ allow: STAFF_EDIT, why: 'edit_tickets at the branch' }),
  ),
  entry(
    'staff_list_appointment_slots',
    async ({ f }) => ({
      p_branch_service_id: f.base.branchServiceId,
      p_barber_id: f.base.barberA.barberId,
      p_date: wednesday(),
    }),
    outcomes({ allow: STAFF_EDIT, why: 'edit_tickets at the branch' }),
  ),
  entry(
    'staff_book_appointment',
    async ({ f, later }) => {
      const start = slot('09:00');
      later(() => removeAppointmentsAt(f, start));
      return {
        p_branch_service_id: f.base.branchServiceId,
        p_barber_id: f.base.barberA.barberId,
        p_slot_start: start,
        p_customer_name: 'RBAC Probe',
        p_customer_phone: f.base.customers[3]!.phone,
      };
    },
    outcomes({ allow: STAFF_EDIT, why: 'edit_tickets at the branch' }),
  ),
  entry(
    'staff_cancel_appointment',
    async (c) => ({
      p_appointment_id: await insertAppointment(
        c,
        c.f.base.customers[3]!.customerId,
        new Date(slot('11:00')),
        c.f.base.barberA.barberId,
      ),
      p_reason: 'changed_plans',
    }),
    outcomes({ allow: STAFF_EDIT, why: 'edit_tickets at the branch' }),
    { void: true },
  ),
  entry(
    'staff_check_in_appointment',
    async (c) => ({
      p_appointment_id: await insertAppointment(
        c,
        c.f.base.customers[3]!.customerId,
        laterToday(20),
        null,
      ),
    }),
    outcomes({ allow: STAFF_EDIT, why: 'edit_tickets at the branch' }),
  ),
  entry(
    'staff_reschedule_appointment',
    async (c) => ({
      p_appointment_id: await insertAppointment(
        c,
        c.f.base.customers[3]!.customerId,
        new Date(slot('14:00')),
        c.f.base.barberA.barberId,
      ),
      p_slot_start: slot('15:00'),
    }),
    outcomes({ allow: STAFF_EDIT, why: 'edit_tickets at the branch' }),
    { void: true },
  ),
  entry(
    'staff_mark_appointment_no_show',
    async (c) => ({
      p_appointment_id: await insertAppointment(
        c,
        c.f.base.customers[3]!.customerId,
        new Date(Date.now() - 10 * MIN),
        null,
      ),
    }),
    outcomes({ allow: STAFF_EDIT, why: 'edit_tickets at the branch' }),
    { void: true },
  ),

  // ---- staff: barbers and accounts ----
  entry(
    'list_manageable_barbers',
    null,
    outcomes({
      allow: [...MANAGE, 'otherManager'],
      empty: ['receptionist', 'analyst', 'barber', 'customer'],
      why: "manage_barber_schedules: the barbers at the caller's own branches",
      emptyWhy: 'lists barbers only for manage_barber_schedules, so other roles get none',
    }),
  ),
  entry(
    'reset_barber_schedule_day',
    async ({ f }) => ({ p_barber_id: await scheduleBarber(f), p_date: dateAt(5) }),
    outcomes({ allow: MANAGE, why: "manage_barber_schedules at the barber's branch" }),
    { void: true },
  ),
  entry(
    'set_barber_weekly_hours',
    async ({ f }) => ({
      p_barber_id: await scheduleBarber(f),
      p_days: [
        {
          day_of_week: 5,
          working: true,
          branch_id: branchA(f),
          shift_start: '09:00',
          shift_end: '17:00',
        },
      ],
    }),
    outcomes({ allow: MANAGE, why: "manage_barber_schedules at the barber's branch" }),
    { void: true },
  ),
  entry(
    'list_staff_accounts',
    null,
    outcomes({
      allow: ['owner'],
      empty: AUTHENTICATED.filter((r) => r !== 'owner'),
      why: 'manage_staff',
      emptyWhy: 'lists accounts only for manage_staff, so other roles get none',
    }),
  ),
];
