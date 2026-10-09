// tests/db/rbac/tables.ts
// Intended read access per role for every public table and view. `expect` is the intent; `currently`
// (with a gap id) records where the database differs today.
import { dateAt } from '../fixtures/appointments';
import {
  barberOf,
  barberRow,
  branchServiceRow,
  branchOf,
  customerOf,
  createRow,
  farDate,
  freeHoursSlot,
  hex,
  otherBranch,
  probeAuthUser,
  probeBarber,
  probeBranchService,
  probeRow,
  probeService,
  probeStaff,
  probeTicket,
  serviceOf,
  serviceRow,
  staffUserRow,
  ticketRow,
  trackAppointment,
  trackBarber,
  trackBranch,
  trackBranchService,
  trackDelete,
  trackTicket,
  uid,
  type At,
  type RbacFixture,
} from './fixture';
import {
  ROLES,
  type Expect,
  type PerRole,
  type ReadScope,
  type Role,
  type TableEntry,
  type WriteScope,
} from './types';

type Scopes = [
  ReadScope,
  ReadScope,
  ReadScope,
  ReadScope,
  ReadScope,
  ReadScope,
  ReadScope,
  ReadScope,
];

const e = <T>(expect: T, why: string, extra: Partial<Expect<T>> = {}): Expect<T> => ({
  expect,
  why,
  ...extra,
});
const everyone = (scope: ReadScope, why: string): PerRole<ReadScope> =>
  Object.fromEntries(ROLES.map((r) => [r, e(scope, why)])) as PerRole<ReadScope>;
const byRole = (scopes: Scopes, why: string): PerRole<ReadScope> =>
  Object.fromEntries(ROLES.map((r, i) => [r, e(scopes[i]!, why)])) as PerRole<ReadScope>;

/** Overrides entries of a per-role row: merges `extra` into the named roles' entries. */
const patch = (
  row: PerRole<ReadScope>,
  roles: Role[],
  extra: Partial<Expect<ReadScope>>,
): PerRole<ReadScope> => {
  const out = { ...row };
  for (const r of roles) out[r] = { ...row[r], ...extra };
  return out;
};

const PUBLIC = 'public catalogue';
const pub = (table: string, key = 'id'): TableEntry => ({
  table,
  key,
  read: everyone('all', PUBLIC),
});

// Role order: anon, customer, barber, receptionist, manager, analyst, owner, otherManager.
const STAFF_USERS = byRole(
  ['none', 'none', 'branch', 'branch', 'branch', 'branch', 'all', 'branch'],
  'pending user decision',
);
const STAFF_ASSIGNMENTS = byRole(
  ['none', 'none', 'branch', 'branch', 'branch', 'branch', 'all', 'branch'],
  'pending user decision',
);

export const TABLES: TableEntry[] = [
  {
    table: 'appointments',
    key: 'id',
    read: byRole(
      ['none', 'own', 'none', 'branch', 'branch', 'none', 'all', 'branch'],
      'edit_tickets staff see their branch; customers their own',
    ),
  },
  {
    table: 'audit_log',
    key: 'id',
    read: byRole(
      ['none', 'none', 'none', 'none', 'none', 'all', 'all', 'none'],
      'view_audit_log (owner, analyst)',
    ),
  },
  {
    table: 'barber_days_off',
    key: 'barber_id', // composite primary key (barber_id, off_date): no id column
    read: byRole(
      ['none', 'none', 'own', 'none', 'branch', 'none', 'all', 'branch'],
      'manage_barber_schedules; barber own',
    ),
  },
  {
    table: 'barber_schedule',
    key: 'id',
    read: byRole(
      ['none', 'none', 'own', 'none', 'branch', 'none', 'all', 'branch'],
      'manage_barber_schedules; barber own',
    ),
  },
  {
    table: 'barber_service_stats',
    key: 'barber_id', // composite primary key (barber_id, service_id): no id column
    read: byRole(
      ['none', 'none', 'none', 'none', 'branch', 'branch', 'all', 'branch'],
      'view_branch_reports',
    ),
  },
  { table: 'barber_skills', key: 'barber_id', read: everyone('all', 'public (booking)') },
  {
    table: 'barber_weekly_hours',
    key: 'id',
    read: byRole(
      ['none', 'none', 'own', 'none', 'branch', 'none', 'all', 'branch'],
      'manage_barber_schedules; barber own',
    ),
  },
  {
    table: 'barbers',
    key: 'id',
    read: patch(everyone('all', 'public (booking)'), ['anon'], {
      gap: 'J-anon-barbers-read',
      why: 'pending user decision',
    }),
  },
  pub('branch_closures'),
  pub('branch_hours'),
  pub('branch_service_prices'),
  pub('branch_services'),
  pub('branches'),
  pub('businesses'),
  pub('capabilities', 'key'),
  pub('role_capabilities', 'capability'),
  pub('services'),
  { table: 'branch_ticket_counters', key: 'branch_id', read: everyone('none', 'internal counter') },
  {
    table: 'consents',
    key: 'id',
    read: byRole(
      ['none', 'own', 'none', 'none', 'branch', 'none', 'all', 'branch'],
      'broadcast_messages for own-branch customers; analysts read promotions via customer_detail',
    ),
  },
  {
    table: 'customers',
    key: 'id',
    read: byRole(
      ['none', 'own', 'none', 'none', 'none', 'none', 'none', 'none'],
      'staff read customers only through functions',
    ),
  },
  {
    table: 'feedback',
    key: 'id',
    read: byRole(
      ['none', 'own', 'none', 'none', 'branch', 'branch', 'all', 'branch'],
      'view_branch_reports',
    ),
  },
  {
    table: 'notifications',
    key: 'id',
    read: byRole(
      ['none', 'own', 'none', 'none', 'none', 'none', 'none', 'none'],
      'recipients only (fixture rows are customer-recipient)',
    ),
  },
  {
    table: 'push_subscriptions',
    key: 'id',
    read: byRole(
      ['none', 'own', 'none', 'none', 'none', 'none', 'none', 'none'],
      "customer's own devices",
    ),
  },
  {
    table: 'queue_events',
    key: 'id',
    read: patch(
      byRole(
        ['none', 'own', 'none', 'none', 'branch', 'branch', 'all', 'branch'],
        'view_branch_reports; customer own',
      ),
      ['analyst'],
      // The policy looks the branch up in queue_tickets, which analysts cannot read, so it never matches.
      { currently: 'none', gap: 'G-queue-events-analyst' },
    ),
  },
  {
    table: 'queue_tickets',
    key: 'id',
    read: byRole(
      ['none', 'own', 'own', 'branch', 'branch', 'none', 'all', 'branch'],
      'edit_tickets; barber own queue; customer own',
    ),
  },
  {
    table: 'service_sessions',
    key: 'id',
    read: byRole(
      ['none', 'none', 'own', 'branch', 'branch', 'none', 'all', 'branch'],
      'edit_tickets; barber own',
    ),
  },
  {
    table: 'staff_branch_assignments',
    key: 'staff_user_id',
    read: Object.fromEntries(
      ROLES.map((r) => [
        r,
        {
          ...STAFF_ASSIGNMENTS[r],
          gap: 'J-staff-assignments-read',
          // Barbers have no branch assignment, so they see no assignment rows.
          ...(r === 'barber' ? { currently: 'none' as const } : {}),
        },
      ]),
    ) as PerRole<ReadScope>,
  },
  {
    table: 'staff_users',
    key: 'id',
    read: Object.fromEntries(
      ROLES.map((r) => [
        r,
        {
          ...STAFF_USERS[r],
          gap: 'J-staff-users-read',
          // Barbers have no branch assignment, so they see no colleagues (only their own row, which is
          // not in the probe set).
          ...(r === 'barber' ? { currently: 'none' as const } : {}),
        },
      ]),
    ) as PerRole<ReadScope>,
  },
  {
    // The barbers' own staff_users rows, probed separately from the branch staff above.
    table: 'staff_users',
    rowsKey: 'staff_users_barbers',
    key: 'id',
    read: Object.fromEntries(
      ROLES.map((r) => [
        r,
        {
          ...STAFF_USERS[r],
          gap: 'J-staff-users-barbers',
          // Barbers have no staff_branch_assignments row, so branch staff never see their staff rows.
          ...(['receptionist', 'manager', 'analyst', 'otherManager'].includes(r)
            ? { currently: 'none' as const }
            : {}),
        },
      ]),
    ) as PerRole<ReadScope>,
  },
  { table: 'branch_status_view', key: 'branch_id', read: everyone('all', PUBLIC) },
  {
    table: 'current_branch_service_price',
    key: 'branch_service_id',
    read: everyone('all', PUBLIC),
  },
  {
    table: 'customer_segments',
    key: 'customer_id',
    read: byRole(
      ['none', 'own', 'none', 'none', 'none', 'none', 'none', 'none'],
      'security invoker over customers',
    ),
  },
];

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

export interface WriteTarget {
  /** Value of the table's `key` column identifying the probe row. */
  key: string;
  /** A harmless column to change, and the new value (the admin client must then see it). */
  column: string;
  value: unknown;
  /** Composite match when `key` alone does not identify one row (tables without an id column). */
  match?: Record<string, unknown>;
}

export interface WriteProbe {
  /** A row to insert at branch 'a' or 'b' (for customer/barber 'own' probes, 'a' is their own). Any
   * prerequisite rows are created with the admin client and registered for removal. */
  insert: (f: RbacFixture, at: 'a' | 'b') => Promise<Record<string, unknown>>;
  /** Creates (with admin) a throwaway row at 'a' or 'b'. For 'own' scopes 'a' is owned by the login
   * (a few such rows are the shared fixture rows themselves: the runner restores the changed
   * column afterwards). */
  target: (f: RbacFixture, at: 'a' | 'b') => Promise<WriteTarget>;
  /** A throwaway row to delete when `target` is a shared fixture row. */
  deleteTarget?: (f: RbacFixture, at: 'a' | 'b') => Promise<WriteTarget>;
  /** Error codes that mean "row security let the write through, a constraint then stopped it". */
  passCodes?: string[];
  /** Errors (besides 42501) that are a deliberate refusal (code and message part must both match), e.g. a trigger that raises because the
   * caller cannot see the row it checks. */
  refuseErrors?: { code: string; message: string }[];
  /** Probe rows of different operations conflict, so a cached row of another operation is torn down
   * before this one is used. */
  exclusive?: boolean;
  /** Required whenever a cell's effective scope is `own`: the same operation on a branch-A row that
   * somebody ELSE owns (another customer, another barber), which must be refused. Without it a
   * policy widened to "anything at my branch" would still pass every `own` cell. */
  other?: {
    insert?: (f: RbacFixture) => Promise<Record<string, unknown>>;
    target?: (f: RbacFixture) => Promise<WriteTarget>;
    deleteTarget?: (f: RbacFixture) => Promise<WriteTarget>;
  };
}

export interface WriteEntry {
  table: string;
  /** Name shown in test output when a table has more than one entry. */
  label?: string;
  /** Only the insert operation is exercised (update and delete are covered by the main entry). */
  insertOnly?: boolean;
  /** Only the update operation is exercised (insert and delete are covered by the main entry). */
  updateOnly?: boolean;
  key: string;
  probe: WriteProbe;
  insert: PerRole<WriteScope>;
  update: PerRole<WriteScope>;
  delete: PerRole<WriteScope>;
}

const w = (spec: Partial<Record<Role, WriteScope>>, why: string): PerRole<WriteScope> =>
  Object.fromEntries(
    ROLES.map((r) => [r, e<WriteScope>(spec[r] ?? 'deny', why)]),
  ) as PerRole<WriteScope>;

const patchW = (
  row: PerRole<WriteScope>,
  roles: Role[],
  extra: Partial<Expect<WriteScope>>,
): PerRole<WriteScope> => {
  const out = { ...row };
  for (const r of roles) out[r] = { ...row[r], ...extra };
  return out;
};

const NOBODY = (why: string) => w({}, why);
const SERVER = 'server-side only';
/** manager and otherManager within their branch, owner everywhere. */
const MANAGERS: Partial<Record<Role, WriteScope>> = {
  manager: 'branch',
  otherManager: 'branch',
  owner: 'all',
};
const OWNER_ONLY: Partial<Record<Role, WriteScope>> = { owner: 'all' };
const STAFF_BRANCH: Partial<Record<Role, WriteScope>> = {
  receptionist: 'branch',
  manager: 'branch',
  otherManager: 'branch',
  owner: 'all',
};
const MANAGERS_ROLES: Role[] = ['manager', 'otherManager'];

const row = <T extends Record<string, unknown>>(f: RbacFixture, table: string, r: T): T => {
  trackDelete(f, table, 'id' in r ? { id: r.id } : r);
  return r;
};

/** A random far-future half hour, so cached probe rows never overlap each other. */
const apptTimes = () => {
  const day = farDate();
  return { scheduled_start: `${day}T10:00:00.000Z`, scheduled_end: `${day}T10:30:00.000Z` };
};

const apptRow = (f: RbacFixture, at: At) => ({
  id: uid(),
  customer_id: customerOf(f, at).customerId,
  branch_id: branchOf(f, at),
  branch_service_id: serviceOf(f, at),
  ...apptTimes(),
  created_by: 'staff',
});

const noteRow = (f: RbacFixture, at: At) => ({
  id: uid(),
  recipient_type: 'customer',
  recipient_id: customerOf(f, at).customerId,
  channel: 'sms',
  notification_type: 'staff_message',
  payload: { text: 'rbac write probe', branch_id: branchOf(f, at) },
  status: 'sent',
});

const consentRow = (f: RbacFixture, at: At) => ({
  id: uid(),
  customer_id: customerOf(f, at).customerId,
  consent_type: 'transactional',
  granted: true,
  source: 'rbac_probe',
});

const pushRow = (f: RbacFixture, at: At) => ({
  id: uid(),
  customer_id: customerOf(f, at).customerId,
  endpoint: `https://push.example/rbac-w-${hex(12)}`,
  p256dh_key: 'rbac-key',
  auth_key: 'rbac-auth',
});

const closureRow = (f: RbacFixture, at: At) => ({
  id: uid(),
  branch_id: branchOf(f, at),
  closure_date: farDate(),
  reason: 'rbac write probe',
});

const hoursRow = (f: RbacFixture, at: At) => ({
  id: uid(),
  branch_id: branchOf(f, at),
  day_of_week: 6,
  opens_at: '00:00:00',
  closes_at: '23:59:59',
  is_closed: false,
});

const scheduleRow = (f: RbacFixture, at: At) => ({
  id: uid(),
  barber_id: barberOf(f, at),
  work_date: farDate(),
  branch_id: branchOf(f, at),
  shift_start: '09:00:00',
  shift_end: '17:00:00',
  is_manual: true,
});

/** `day` differs between the insert row and the target rows, which may exist at the same time. */
const weeklyRow = (f: RbacFixture, at: At, day: number) => ({
  id: uid(),
  barber_id: barberOf(f, at),
  branch_id: branchOf(f, at),
  day_of_week: day,
  shift_start: '09:00:00',
  shift_end: '17:00:00',
});

const customerRow = () => ({
  id: uid(),
  name: 'RBAC Walk-in',
  phone_e164: `+233558${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`,
});

const branchRow = (f: RbacFixture) => ({
  id: uid(),
  business_id: f.rows.businesses!.a[0]!,
  name: `RBAC Probe Branch ${hex()}`,
  branch_code: `RW${hex(6)}`.toUpperCase(),
  address: 'Test',
  latitude: 5.6,
  longitude: -0.18,
});

const auditRow = (f: RbacFixture, at: At) => ({
  id: uid(),
  actor_type: 'system',
  action: 'rbac_write_probe',
  entity_type: 'branch',
  entity_id: branchOf(f, at),
  result: 'success',
});

const feedbackRow = (f: RbacFixture, at: At, ticketId: string) => ({
  id: uid(),
  ticket_id: ticketId,
  customer_id: customerOf(f, at).customerId,
  branch_id: branchOf(f, at),
  barber_id: barberOf(f, at),
  overall_rating: 5,
});

const eventRow = (ticketId: string) => ({
  id: uid(),
  ticket_id: ticketId,
  event_type: 'rbac_write_probe',
  actor_type: 'system',
});

const priceRow = (branchServiceId: string) => ({
  id: uid(),
  branch_service_id: branchServiceId,
  price_ghs: 10,
  effective_from: dateAt(0),
});

const sessionRow = (f: RbacFixture, at: At, ticketId: string) => ({
  id: uid(),
  ticket_id: ticketId,
  barber_id: barberOf(f, at),
  started_at: new Date().toISOString(),
});

/** What a customer joining the queue sends: waiting, created by the customer, no barber yet. */
const WAITING = {
  state: 'waiting',
  created_by: 'customer',
  assigned_barber_id: null,
  completed_at: null,
};

const TICKET_INSERT = patchW(w(STAFF_BRANCH, 'edit_tickets'), ['customer'], {
  expect: 'deny',
  why: 'customers join via tickets-join (service role); no direct insert',
});

/** A branch-A ticket that belongs to another customer and another barber (an `own` write must fail). */
const otherTicket = async (f: RbacFixture, over: Record<string, unknown> = {}) => {
  const { barberId } = await probeBarber(f, branchOf(f, 'a'));
  return probeTicket(f, 'a', {
    customer_id: customerOf(f, 'b').customerId,
    assigned_barber_id: barberId,
    ...over,
  });
};

/** A capability row made by the admin client. */
async function probeCapability(f: RbacFixture): Promise<string> {
  const key = `rbac_probe_${hex()}`;
  await createRow(f, 'capabilities', { key, description: 'rbac write probe' }, 'probe capability');
  trackDelete(f, 'capabilities', { key });
  trackDelete(f, 'role_capabilities', { capability: key });
  return key;
}

/** Two different far-future dates. */
const twoDates = () => {
  const d1 = farDate();
  let d2 = farDate();
  while (d2 === d1) d2 = farDate();
  return [d1, d2] as const;
};

export const WRITES: WriteEntry[] = [
  {
    table: 'appointments',
    key: 'id',
    probe: {
      insert: async (f, at) => {
        const r = apptRow(f, at);
        trackAppointment(f, r.id);
        return r;
      },
      target: async (f, at) => {
        const r = apptRow(f, at);
        await createRow(f, 'appointments', r, 'probe appointment');
        trackAppointment(f, r.id);
        return { key: r.id, column: 'created_by_staff_id', value: f.staffIds.manager! };
      },
    },
    insert: NOBODY('only through booking functions'),
    update: NOBODY('only through booking functions'),
    delete: NOBODY('only through booking functions'),
  },
  {
    table: 'audit_log',
    key: 'id',
    probe: {
      insert: async (f, at) => row(f, 'audit_log', auditRow(f, at)),
      target: async (f, at) => {
        const r = await probeRow(f, 'audit_log', auditRow(f, at));
        return { key: r.id as string, column: 'result', value: 'failure' };
      },
    },
    insert: NOBODY(SERVER),
    update: NOBODY(SERVER),
    delete: NOBODY(SERVER),
  },
  {
    table: 'barber_days_off',
    key: 'barber_id', // composite primary key (barber_id, off_date)
    probe: {
      insert: async (f, at) => {
        const r = { barber_id: barberOf(f, at), off_date: farDate() };
        trackDelete(f, 'barber_days_off', r);
        return r;
      },
      target: async (f, at) => {
        const [d1, d2] = twoDates();
        const barber = barberOf(f, at);
        await createRow(f, 'barber_days_off', { barber_id: barber, off_date: d1 }, 'probe day off');
        trackDelete(f, 'barber_days_off', { barber_id: barber, off_date: d1 });
        trackDelete(f, 'barber_days_off', { barber_id: barber, off_date: d2 });
        return {
          key: barber,
          column: 'off_date',
          value: d2,
          match: { barber_id: barber, off_date: d1 },
        };
      },
    },
    insert: w(MANAGERS, 'manage_barber_schedules'),
    update: w(MANAGERS, 'manage_barber_schedules'),
    delete: w(MANAGERS, 'manage_barber_schedules'),
  },
  {
    table: 'barber_schedule',
    key: 'id',
    probe: {
      insert: async (f, at) => row(f, 'barber_schedule', scheduleRow(f, at)),
      target: async (f, at) => {
        const r = await probeRow(f, 'barber_schedule', scheduleRow(f, at));
        return { key: r.id as string, column: 'shift_end', value: '20:00:00' };
      },
    },
    insert: w(MANAGERS, 'manage_barber_schedules'),
    update: w(MANAGERS, 'manage_barber_schedules'),
    delete: w(MANAGERS, 'manage_barber_schedules'),
  },
  {
    table: 'barber_service_stats',
    key: 'barber_id', // composite primary key (barber_id, service_id)
    probe: {
      insert: async (f, at) => {
        const service_id = await probeService(f);
        const r = {
          barber_id: barberOf(f, at),
          service_id,
          completed_count: 1,
          avg_duration_seconds: 600,
        };
        trackDelete(f, 'barber_service_stats', { barber_id: r.barber_id, service_id });
        return r;
      },
      target: async (f, at) => {
        const service_id = await probeService(f);
        const barber_id = barberOf(f, at);
        await createRow(
          f,
          'barber_service_stats',
          { barber_id, service_id, completed_count: 1, avg_duration_seconds: 600 },
          'probe stats',
        );
        trackDelete(f, 'barber_service_stats', { barber_id, service_id });
        return {
          key: barber_id,
          column: 'completed_count',
          value: 2,
          match: { barber_id, service_id },
        };
      },
    },
    insert: NOBODY(SERVER),
    update: NOBODY(SERVER),
    delete: NOBODY(SERVER),
  },
  {
    table: 'barber_skills',
    key: 'barber_id', // composite primary key (barber_id, service_id)
    probe: {
      insert: async (f, at) => {
        const service_id = await probeService(f);
        const r = { barber_id: barberOf(f, at), service_id };
        trackDelete(f, 'barber_skills', r);
        return r;
      },
      target: async (f, at) => {
        const s1 = await probeService(f);
        const s2 = await probeService(f);
        const barber_id = barberOf(f, at);
        await createRow(f, 'barber_skills', { barber_id, service_id: s1 }, 'probe skill');
        trackDelete(f, 'barber_skills', { barber_id, service_id: s1 });
        trackDelete(f, 'barber_skills', { barber_id, service_id: s2 });
        return {
          key: barber_id,
          column: 'service_id',
          value: s2,
          match: { barber_id, service_id: s1 },
        };
      },
    },
    insert: w(MANAGERS, 'manage_barber_schedules'),
    update: w(MANAGERS, 'manage_barber_schedules'),
    delete: w(MANAGERS, 'manage_barber_schedules'),
  },
  {
    table: 'barber_weekly_hours',
    key: 'id',
    probe: {
      insert: async (f, at) => row(f, 'barber_weekly_hours', weeklyRow(f, at, 5)),
      target: async (f, at) => {
        const r = await probeRow(f, 'barber_weekly_hours', weeklyRow(f, at, 6));
        return { key: r.id as string, column: 'shift_end', value: '18:00:00' };
      },
      deleteTarget: async (f, at) => {
        const r = await probeRow(f, 'barber_weekly_hours', weeklyRow(f, at, 4));
        return { key: r.id as string, column: 'shift_end', value: '18:00:00' };
      },
    },
    insert: w(MANAGERS, 'manage_barber_schedules'),
    update: w(MANAGERS, 'manage_barber_schedules'),
    delete: w(MANAGERS, 'manage_barber_schedules'),
  },
  {
    table: 'barbers',
    key: 'id',
    probe: {
      insert: async (f, at) => {
        const { staffId } = await probeStaff(f, 'barber');
        const id = uid();
        trackBarber(f, id);
        return barberRow(id, staffId, branchOf(f, at));
      },
      // The barber login's own row is the shared fixture row; the runner restores the status.
      target: async (f, at) => ({ key: barberOf(f, at), column: 'status', value: 'on_break' }),
      deleteTarget: async (f, at) => {
        const { barberId } = await probeBarber(f, branchOf(f, at));
        return { key: barberId, column: 'status', value: 'on_break' };
      },
      other: {
        target: async (f) => {
          const { barberId } = await probeBarber(f, branchOf(f, 'a'));
          return { key: barberId, column: 'status', value: 'on_break' };
        },
      },
    },
    insert: w(OWNER_ONLY, 'creating a barber is staff management'),
    update: w(
      { ...STAFF_BRANCH, barber: 'own' },
      'staff manage their branch barbers; a barber their own status',
    ),
    delete: w(OWNER_ONLY, 'removing a barber is staff management'),
  },
  {
    table: 'branch_closures',
    key: 'id',
    probe: {
      insert: async (f, at) => row(f, 'branch_closures', closureRow(f, at)),
      target: async (f, at) => {
        const r = await probeRow(f, 'branch_closures', closureRow(f, at));
        return { key: r.id as string, column: 'reason', value: 'rbac changed' };
      },
    },
    insert: w(MANAGERS, 'edit_hours'),
    update: w(MANAGERS, 'edit_hours'),
    delete: w(MANAGERS, 'edit_hours'),
  },
  {
    table: 'branch_hours',
    key: 'id',
    probe: {
      // Every probe takes the same Saturday slot of the branch, so they cannot coexist.
      exclusive: true,
      insert: async (f, at) => {
        await freeHoursSlot(f, branchOf(f, at));
        return row(f, 'branch_hours', hoursRow(f, at));
      },
      target: async (f, at) => {
        await freeHoursSlot(f, branchOf(f, at));
        const r = await probeRow(f, 'branch_hours', hoursRow(f, at));
        return { key: r.id as string, column: 'is_closed', value: true };
      },
    },
    insert: w(MANAGERS, 'edit_hours'),
    update: w(MANAGERS, 'edit_hours'),
    delete: w(MANAGERS, 'edit_hours'),
  },
  {
    table: 'branch_service_prices',
    key: 'id',
    probe: {
      insert: async (f, at) => {
        const bs = await probeBranchService(f, at);
        return row(f, 'branch_service_prices', priceRow(bs));
      },
      target: async (f, at) => {
        const bs = await probeBranchService(f, at);
        const r = await probeRow(f, 'branch_service_prices', priceRow(bs));
        return { key: r.id as string, column: 'price_ghs', value: 99 };
      },
    },
    insert: w(MANAGERS, 'edit_pricing'),
    update: w(MANAGERS, 'edit_pricing'),
    delete: w(MANAGERS, 'edit_pricing'),
  },
  {
    table: 'branch_services',
    key: 'id',
    probe: {
      insert: async (f, at) => {
        const service_id = await probeService(f);
        const r = branchServiceRow(f, at, service_id);
        trackBranchService(f, r.id);
        return r;
      },
      target: async (f, at) => {
        const id = await probeBranchService(f, at);
        return { key: id, column: 'is_active', value: false };
      },
    },
    insert: w(MANAGERS, 'edit_pricing'),
    update: w(MANAGERS, 'edit_pricing'),
    delete: w(MANAGERS, 'edit_pricing'),
  },
  {
    table: 'branch_ticket_counters',
    key: 'branch_id', // composite primary key (branch_id, ticket_date)
    probe: {
      insert: async (f, at) => {
        const r = { branch_id: branchOf(f, at), ticket_date: farDate(), last_seq: 1 };
        trackDelete(f, 'branch_ticket_counters', {
          branch_id: r.branch_id,
          ticket_date: r.ticket_date,
        });
        return r;
      },
      target: async (f, at) => {
        const branch_id = branchOf(f, at);
        const ticket_date = farDate();
        await createRow(
          f,
          'branch_ticket_counters',
          { branch_id, ticket_date, last_seq: 1 },
          'probe counter',
        );
        trackDelete(f, 'branch_ticket_counters', { branch_id, ticket_date });
        return { key: branch_id, column: 'last_seq', value: 2, match: { branch_id, ticket_date } };
      },
    },
    insert: NOBODY(SERVER),
    update: NOBODY(SERVER),
    delete: NOBODY(SERVER),
  },
  {
    table: 'branches',
    key: 'id',
    probe: {
      insert: async (f) => {
        const r = branchRow(f);
        trackBranch(f, r.id);
        return r;
      },
      // The fixture branch itself; the runner restores the address.
      target: async (f, at) => ({ key: branchOf(f, at), column: 'address', value: 'RBAC changed' }),
      deleteTarget: async (f) => {
        const r = branchRow(f);
        await createRow(f, 'branches', r, 'probe branch');
        trackBranch(f, r.id);
        return { key: r.id, column: 'address', value: 'RBAC changed' };
      },
    },
    insert: w(OWNER_ONLY, 'manage_branches'),
    update: w(OWNER_ONLY, 'manage_branches'),
    delete: w(OWNER_ONLY, 'manage_branches'),
  },
  {
    table: 'businesses',
    key: 'id',
    probe: {
      // Only one business may exist (one_business_only), so a throwaway cannot be created: the
      // insert and delete probes target rules that pass row security and are then stopped by the
      // unique index / the foreign keys from branches and services (passCodes), and update changes
      // the real row's name and the runner restores it.
      insert: async (f) =>
        row(f, 'businesses', { id: uid(), name: `RBAC Probe Business ${hex()}` }),
      target: async (f) => ({
        key: f.rows.businesses!.a[0]!,
        column: 'name',
        value: `RBAC Renamed ${hex()}`,
      }),
      passCodes: ['23505', '23503'],
    },
    insert: w(OWNER_ONLY, 'owner'),
    update: w(OWNER_ONLY, 'owner'),
    delete: w(OWNER_ONLY, 'owner'),
  },
  {
    table: 'capabilities',
    key: 'key',
    probe: {
      insert: async (f) => {
        const key = `rbac_probe_${hex()}`;
        trackDelete(f, 'capabilities', { key });
        return { key, description: 'rbac write probe' };
      },
      target: async (f) => {
        const key = await probeCapability(f);
        return { key, column: 'description', value: 'rbac changed' };
      },
    },
    insert: NOBODY(SERVER),
    update: NOBODY(SERVER),
    delete: NOBODY(SERVER),
  },
  {
    table: 'consents',
    key: 'id',
    probe: {
      insert: async (f, at) => row(f, 'consents', consentRow(f, at)),
      target: async (f, at) => {
        const r = await probeRow(f, 'consents', consentRow(f, at));
        return { key: r.id as string, column: 'granted', value: false };
      },
      other: {
        insert: async (f) => row(f, 'consents', consentRow(f, 'b')),
        target: async (f) => {
          const r = await probeRow(f, 'consents', consentRow(f, 'b'));
          return { key: r.id as string, column: 'granted', value: false };
        },
      },
    },
    insert: w({ customer: 'own' }, 'customers record their own choices'),
    update: NOBODY('consent changes are recorded by inserting'),
    delete: NOBODY('consent history is kept'),
  },
  {
    table: 'customers',
    key: 'id',
    probe: {
      insert: async (f) => row(f, 'customers', customerRow()),
      // The customer login's own row (customer 0 / customer 1 are shared fixture rows; the runner
      // restores the name afterwards).
      target: async (f, at) => ({
        key: customerOf(f, at).customerId,
        column: 'name',
        value: 'RBAC Renamed',
      }),
      deleteTarget: async (f) => {
        const r = await probeRow(f, 'customers', customerRow());
        return { key: r.id as string, column: 'name', value: 'RBAC Renamed' };
      },
      other: {
        // Customer 1 is another customer's shared fixture row; the runner restores the name.
        target: async (f) => ({
          key: customerOf(f, 'b').customerId,
          column: 'name',
          value: 'RBAC Renamed',
        }),
      },
    },
    insert: w(
      { receptionist: 'all', manager: 'all', otherManager: 'all', owner: 'all' },
      'register_walkins (walk-in registration is not branch-scoped)',
    ),
    update: w({ customer: 'own' }, 'a customer edits their own profile'),
    delete: NOBODY('customers are anonymised, not deleted'),
  },
  {
    table: 'feedback',
    key: 'id',
    probe: {
      insert: async (f, at) => {
        const ticket_id = await probeTicket(f, at);
        return row(f, 'feedback', feedbackRow(f, at, ticket_id));
      },
      target: async (f, at) => {
        const ticket_id = await probeTicket(f, at);
        const r = await probeRow(f, 'feedback', feedbackRow(f, at, ticket_id));
        return { key: r.id as string, column: 'comment', value: 'rbac changed' };
      },
    },
    insert: NOBODY(SERVER),
    update: NOBODY(SERVER),
    delete: NOBODY(SERVER),
  },
  {
    table: 'notifications',
    key: 'id',
    probe: {
      // A trigger checks the recipient exists in customers, as the caller: staff and other customers
      // cannot see that row, so it raises P0001 "recipient_id ... does not exist in customers".
      refuseErrors: [{ code: 'P0001', message: 'does not exist in customers' }],
      insert: async (f, at) => row(f, 'notifications', noteRow(f, at)),
      target: async (f, at) => {
        const r = await probeRow(f, 'notifications', noteRow(f, at));
        return { key: r.id as string, column: 'failed_reason', value: 'rbac changed' };
      },
    },
    insert: NOBODY(SERVER),
    update: NOBODY(SERVER),
    delete: NOBODY(SERVER),
  },
  {
    table: 'push_subscriptions',
    key: 'id',
    probe: {
      insert: async (f, at) => row(f, 'push_subscriptions', pushRow(f, at)),
      target: async (f, at) => {
        const r = await probeRow(f, 'push_subscriptions', pushRow(f, at));
        return { key: r.id as string, column: 'user_agent', value: 'rbac-agent' };
      },
      other: {
        target: async (f) => {
          const r = await probeRow(f, 'push_subscriptions', pushRow(f, 'b'));
          return { key: r.id as string, column: 'user_agent', value: 'rbac-agent' };
        },
      },
    },
    insert: NOBODY('saved through a function'),
    update: NOBODY('saved through a function'),
    delete: w({ customer: 'own' }, "customer's own devices"),
  },
  {
    table: 'queue_events',
    key: 'id',
    probe: {
      insert: async (f, at) => {
        const ticket_id = await probeTicket(f, at);
        return row(f, 'queue_events', eventRow(ticket_id));
      },
      target: async (f, at) => {
        const ticket_id = await probeTicket(f, at);
        const r = await probeRow(f, 'queue_events', eventRow(ticket_id));
        return { key: r.id as string, column: 'event_type', value: 'rbac_changed' };
      },
    },
    insert: NOBODY(SERVER),
    update: NOBODY(SERVER),
    delete: NOBODY(SERVER),
  },
  {
    table: 'queue_tickets',
    key: 'id',
    probe: {
      // A waiting ticket and the update target are both "active" for the same customer and branch,
      // which the database allows only once, so these probes cannot coexist.
      exclusive: true,
      insert: async (f, at) => {
        const r = ticketRow(f, at, WAITING);
        trackTicket(f, r.id);
        return r;
      },
      target: async (f, at) => {
        // Keeps its assigned barber, so a barber's own-queue update can be probed.
        const id = await probeTicket(f, at, { state: 'waiting', completed_at: null });
        return { key: id, column: 'state', value: 'cancelled' };
      },
      deleteTarget: async (f, at) => {
        const id = await probeTicket(f, at);
        return { key: id, column: 'state', value: 'cancelled' };
      },
      other: {
        target: async (f) => {
          const id = await otherTicket(f, { state: 'waiting', completed_at: null });
          return { key: id, column: 'state', value: 'cancelled' };
        },
      },
    },
    insert: TICKET_INSERT,
    update: w(
      { customer: 'own', barber: 'own', ...STAFF_BRANCH },
      'edit_tickets; customer cancels their own; barber their own queue',
    ),
    delete: NOBODY('tickets are never deleted'),
  },
  {
    // A customer inserting a ticket that is already completed, staff-created and assigned: not a real
    // queue join, so the intended access is deny.
    table: 'queue_tickets',
    label: 'queue_tickets_forged',
    key: 'id',
    insertOnly: true,
    probe: {
      insert: async (f, at) => {
        const r = ticketRow(f, at);
        trackTicket(f, r.id);
        return r;
      },
      target: async (f, at) => {
        const id = await probeTicket(f, at);
        return { key: id, column: 'state', value: 'cancelled' };
      },
    },
    insert: patchW(TICKET_INSERT, ['customer'], {
      expect: 'deny',
      why: 'a customer can only join the queue (waiting, created by the customer), not write a finished ticket',
    }),
    update: NOBODY('covered by queue_tickets'),
    delete: NOBODY('covered by queue_tickets'),
  },
  {
    // A customer cancelling their own ticket after it was finished (completed, completed_at left
    // empty so only the old-state limit can stop it). The customer app only cancels live tickets.
    table: 'queue_tickets',
    label: 'queue_tickets_cancel_finished',
    key: 'id',
    updateOnly: true,
    probe: {
      insert: async () => {
        throw new Error('update-only probe');
      },
      target: async (f, at) => {
        const id = await probeTicket(f, at, { state: 'completed', completed_at: null });
        return { key: id, column: 'state', value: 'cancelled' };
      },
      other: {
        target: async (f) => {
          const id = await otherTicket(f, { state: 'completed', completed_at: null });
          return { key: id, column: 'state', value: 'cancelled' };
        },
      },
    },
    insert: NOBODY('covered by queue_tickets'),
    update: patchW(
      w({ barber: 'own', ...STAFF_BRANCH }, 'edit_tickets; a barber their own queue'),
      ['customer'],
      {
        expect: 'deny',
        why: 'a customer can cancel only a live ticket, not rewrite a finished one',
      },
    ),
    delete: NOBODY('covered by queue_tickets'),
  },
  {
    table: 'role_capabilities',
    key: 'capability',
    probe: {
      insert: async (f) => {
        const capability = await probeCapability(f);
        return { role: 'receptionist', capability };
      },
      target: async (f) => {
        const capability = await probeCapability(f);
        await createRow(
          f,
          'role_capabilities',
          { role: 'receptionist', capability },
          'probe role cap',
        );
        return {
          key: capability,
          column: 'role',
          value: 'analyst',
          match: { role: 'receptionist', capability },
        };
      },
    },
    insert: NOBODY(SERVER),
    update: NOBODY(SERVER),
    delete: NOBODY(SERVER),
  },
  {
    table: 'service_sessions',
    key: 'id',
    probe: {
      insert: async (f, at) => {
        const ticket = await probeTicket(f, at);
        return row(f, 'service_sessions', sessionRow(f, at, ticket));
      },
      target: async (f, at) => {
        const ticket = await probeTicket(f, at);
        const r = await probeRow(f, 'service_sessions', sessionRow(f, at, ticket));
        // started_at, not ended_at: ending a session rolls into barber_service_stats.
        return { key: r.id as string, column: 'started_at', value: '2026-01-01T00:00:00Z' };
      },
      other: {
        // A session of another barber at branch A.
        insert: async (f) => {
          const ticket = await probeTicket(f, 'a');
          const { barberId } = await probeBarber(f, branchOf(f, 'a'));
          return row(f, 'service_sessions', { ...sessionRow(f, 'a', ticket), barber_id: barberId });
        },
        target: async (f) => {
          const ticket = await probeTicket(f, 'a');
          const { barberId } = await probeBarber(f, branchOf(f, 'a'));
          const r = await probeRow(f, 'service_sessions', {
            ...sessionRow(f, 'a', ticket),
            barber_id: barberId,
          });
          return { key: r.id as string, column: 'started_at', value: '2026-01-01T00:00:00Z' };
        },
      },
    },
    insert: w({ barber: 'own', ...STAFF_BRANCH }, 'edit_tickets; a barber their own sessions'),
    update: w({ barber: 'own', ...STAFF_BRANCH }, 'edit_tickets; a barber their own sessions'),
    delete: NOBODY('sessions are never deleted'),
  },
  {
    table: 'services',
    key: 'id',
    probe: {
      insert: async (f) => row(f, 'services', serviceRow(f)),
      target: async (f) => {
        const r = await probeRow(f, 'services', serviceRow(f));
        return { key: r.id as string, column: 'name', value: `RBAC Renamed ${hex()}` };
      },
    },
    insert: patchW(w(OWNER_ONLY, 'business-wide catalogue'), MANAGERS_ROLES, {
      currently: 'all',
      gap: 'J-services-catalog-write',
      why: 'pending user decision',
    }),
    update: patchW(w(OWNER_ONLY, 'business-wide catalogue'), MANAGERS_ROLES, {
      currently: 'all',
      gap: 'J-services-catalog-write',
      why: 'pending user decision',
    }),
    delete: patchW(w(OWNER_ONLY, 'business-wide catalogue'), MANAGERS_ROLES, {
      currently: 'all',
      gap: 'J-services-catalog-write',
      why: 'pending user decision',
    }),
  },
  {
    table: 'staff_branch_assignments',
    key: 'staff_user_id', // composite primary key (staff_user_id, branch_id)
    probe: {
      insert: async (f, at) => {
        const { staffId } = await probeStaff(f, 'receptionist');
        const r = { staff_user_id: staffId, branch_id: branchOf(f, at) };
        trackDelete(f, 'staff_branch_assignments', r);
        return r;
      },
      target: async (f, at) => {
        const { staffId } = await probeStaff(f, 'receptionist', branchOf(f, at));
        return {
          key: staffId,
          column: 'branch_id',
          value: otherBranch(f, at),
          match: { staff_user_id: staffId, branch_id: branchOf(f, at) },
        };
      },
    },
    insert: NOBODY('staff management runs server-side'),
    update: NOBODY('staff management runs server-side'),
    delete: NOBODY('staff management runs server-side'),
  },
  {
    table: 'staff_users',
    key: 'id',
    probe: {
      insert: async (f) => {
        const { authId, email } = await probeAuthUser(f);
        return row(f, 'staff_users', staffUserRow(authId, email, 'receptionist'));
      },
      target: async (f, at) => {
        const { staffId } = await probeStaff(f, 'receptionist', branchOf(f, at));
        return { key: staffId, column: 'name', value: 'RBAC Renamed' };
      },
    },
    insert: NOBODY('staff management runs server-side'),
    update: NOBODY('staff management runs server-side'),
    delete: NOBODY('staff management runs server-side'),
  },
];
