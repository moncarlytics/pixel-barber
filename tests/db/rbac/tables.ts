// tests/db/rbac/tables.ts
// Intended read access per role for every public table and view. `expect` is the intent; `currently`
// (with a gap id) records where the database differs today.
import {
  ROLES,
  type Expect,
  type PerRole,
  type ReadScope,
  type Role,
  type TableEntry,
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
    read: patch(
      byRole(
        ['none', 'own', 'none', 'none', 'branch', 'none', 'all', 'branch'],
        'broadcast_messages for own-branch customers; analysts read promotions via customer_detail',
      ),
      ['manager', 'analyst', 'otherManager'],
      { currently: 'all', gap: 'G-consents-scope' },
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
