// tests/db/rbac/fixture.ts
// Shared fixture for the role-and-permission check: builds on the appointment fixture (branch A =
// Main, branch B = Closed; barbers A and B at A; customers 0-3) and adds an Owner, a Manager /
// Receptionist / Analyst at A, an "other" Manager at B, a barber C at B, an anonymous client, and one
// row per probed table at each branch. Not a test file itself (vitest only collects *.test.ts).
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';
import {
  PASSWORD,
  cleanupAppointmentFixture,
  cleanupStaffLogin,
  createAppointmentFixture,
  createStaffLogin,
  dateAt,
  type AppointmentFixture,
  type Client,
} from '../fixtures/appointments';
import { ROLES, type Role, type RowSet } from './types';

export { ROLES };

export interface RbacFixture {
  base: AppointmentFixture;
  admin: Client;
  clients: Record<Role, Client>;
  staffIds: Partial<Record<Role, string>>;
  barberC: { barberId: string; staffUserId: string; authUserId: string };
  rows: Record<string, RowSet>;
  /** Internal: what cleanup must remove beyond the base fixture. */
  owner: { authUserId: string; staffUserId: string };
  logins: { authUserId: string; staffUserId: string }[];
  customerIds: string[];
  created: {
    tickets: string[];
    sessions: string[];
    events: string[];
    feedback: string[];
    pushEndpoints: string[];
    consents: string[];
    audit: string[];
    weeklyHours: string[];
    prices: string[];
    closures: string[];
  };
}

const must = <T>(
  r: { data: T; error: { message: string } | null },
  what: string,
): NonNullable<T> => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  if (r.data === null || r.data === undefined) throw new Error(`${what}: no data`);
  return r.data;
};
const check = (r: { error: { message: string } | null }, what: string) => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
};

async function signIn(email: string): Promise<Client> {
  const client = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return client;
}

export async function createRbacFixture(): Promise<RbacFixture> {
  const base = await createAppointmentFixture();
  const { admin, suffix, branchId: A, closedBranchId: B, serviceId } = base;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  // Owner: no branch assignment (modelled on createSignedInStaff in staff-invite.ts).
  const ownerEmail = `rbac-owner-${suffix}@test.pixelbarber.local`;
  const ownerAuth = await admin.auth.admin.createUser({
    email: ownerEmail,
    password: PASSWORD,
    email_confirm: true,
  });
  check(ownerAuth, 'owner auth');
  const ownerRow = must(
    await admin
      .from('staff_users')
      .insert({
        auth_user_id: ownerAuth.data.user!.id,
        name: `RBAC Owner ${suffix}`,
        email: ownerEmail,
        role: 'owner',
        invite_status: 'accepted',
      })
      .select('id')
      .single(),
    'owner staff_users',
  );
  const owner = { authUserId: ownerAuth.data.user!.id, staffUserId: ownerRow.id };
  const ownerClient = await signIn(ownerEmail);

  const manager = await createStaffLogin(base, 'rbac-manager', 'branch_manager', A);
  const receptionist = await createStaffLogin(base, 'rbac-reception', 'receptionist', A);
  const analyst = await createStaffLogin(base, 'rbac-analyst', 'analyst', A);
  const otherManager = await createStaffLogin(base, 'rbac-other', 'branch_manager', B);
  const logins = [manager, receptionist, analyst, otherManager];

  // Barber C at branch B.
  const cEmail = `rbac-barber-c-${suffix}@test.pixelbarber.local`;
  const cAuth = await admin.auth.admin.createUser({
    email: cEmail,
    password: PASSWORD,
    email_confirm: true,
  });
  check(cAuth, 'barber C auth');
  const cStaff = must(
    await admin
      .from('staff_users')
      .insert({
        auth_user_id: cAuth.data.user!.id,
        name: 'RBAC Barber C',
        email: cEmail,
        role: 'barber',
        invite_status: 'accepted',
      })
      .select('id')
      .single(),
    'barber C staff_users',
  );
  const cBarber = must(
    await admin
      .from('barbers')
      .insert({ staff_user_id: cStaff.id, home_branch_id: B, status: 'available' })
      .select('id')
      .single(),
    'barber C barbers',
  );
  check(
    await admin.from('barber_skills').insert({ barber_id: cBarber.id, service_id: serviceId }),
    'barber C skill',
  );
  const barberC = { barberId: cBarber.id, staffUserId: cStaff.id, authUserId: cAuth.data.user!.id };
  const barberA = base.barberA;
  const cust0 = base.customers[0]!;
  const cust1 = base.customers[1]!;

  // Tickets (completed, one per branch).
  const ticket = async (
    n: string,
    branch: string,
    customerId: string,
    bsId: string,
    barberId: string,
  ) =>
    must(
      await admin
        .from('queue_tickets')
        .insert({
          ticket_number: `PB-RBAC-${n}-${suffix}`,
          branch_id: branch,
          customer_id: customerId,
          branch_service_id: bsId,
          assigned_barber_id: barberId,
          state: 'completed',
          created_by: 'staff',
          completed_at: new Date().toISOString(),
        })
        .select('id')
        .single(),
      `ticket ${n}`,
    ).id;
  const tA = await ticket('A', A, cust0.customerId, base.branchServiceId, barberA.barberId);
  const tB = await ticket('B', B, cust1.customerId, base.closedBranchServiceId, barberC.barberId);

  // Appointments.
  const appt = async (branch: string, customerId: string, bsId: string, day: number) =>
    must(
      await admin
        .from('appointments')
        .insert({
          customer_id: customerId,
          branch_id: branch,
          branch_service_id: bsId,
          scheduled_start: `${dateAt(day)}T10:00:00.000Z`,
          scheduled_end: `${dateAt(day)}T10:30:00.000Z`,
          created_by: 'staff',
        })
        .select('id')
        .single(),
      'appointment',
    ).id;
  const aA = await appt(A, cust0.customerId, base.branchServiceId, 2);
  const aB = await appt(B, cust1.customerId, base.closedBranchServiceId, 2);

  // Feedback.
  const fb = async (ticketId: string, customerId: string, branch: string, barberId: string) =>
    must(
      await admin
        .from('feedback')
        .insert({
          ticket_id: ticketId,
          customer_id: customerId,
          branch_id: branch,
          barber_id: barberId,
          overall_rating: 5,
        })
        .select('id')
        .single(),
      'feedback',
    ).id;
  const fA = await fb(tA, cust0.customerId, A, barberA.barberId);
  const fB = await fb(tB, cust1.customerId, B, barberC.barberId);

  // Queue events.
  const ev = async (ticketId: string) =>
    must(
      await admin
        .from('queue_events')
        .insert({ ticket_id: ticketId, event_type: 'rbac_probe', actor_type: 'system' })
        .select('id')
        .single(),
      'queue_event',
    ).id;
  const eA = await ev(tA);
  const eB = await ev(tB);

  // staff_message notifications (customer recipients).
  const note = async (customerId: string, branch: string) =>
    must(
      await admin
        .from('notifications')
        .insert({
          recipient_type: 'customer',
          recipient_id: customerId,
          channel: 'sms',
          notification_type: 'staff_message',
          payload: { text: 'rbac probe', branch_id: branch },
          status: 'sent',
        })
        .select('id')
        .single(),
      'notification',
    ).id;
  const nA = await note(cust0.customerId, A);
  const nB = await note(cust1.customerId, B);

  // Service sessions (ended_at left null so no stats rollup trigger fires).
  const session = async (ticketId: string, barberId: string) =>
    must(
      await admin
        .from('service_sessions')
        .insert({ ticket_id: ticketId, barber_id: barberId, started_at: new Date().toISOString() })
        .select('id')
        .single(),
      'service_session',
    ).id;
  const sA = await session(tA, barberA.barberId);
  const sB = await session(tB, barberC.barberId);

  // Weekly hours and days off.
  const wh = async (barberId: string, branch: string) =>
    must(
      await admin
        .from('barber_weekly_hours')
        .insert({
          barber_id: barberId,
          day_of_week: 3,
          branch_id: branch,
          shift_start: '09:00:00',
          shift_end: '17:00:00',
        })
        .select('id')
        .single(),
      'weekly hours',
    ).id;
  const whA = await wh(barberA.barberId, A);
  const whC = await wh(barberC.barberId, B);
  const offDate = dateAt(40);
  check(
    await admin.from('barber_days_off').insert([
      { barber_id: barberA.barberId, off_date: offDate },
      { barber_id: barberC.barberId, off_date: offDate },
    ]),
    'days off',
  );

  // The weekly-hours / days-off triggers refill barber_schedule (replacing non-manual rows), so the
  // schedule rows probed are created last and marked manual, which the refill never overwrites.
  const manualRow = async (barberId: string, branch: string) => {
    await admin
      .from('barber_schedule')
      .delete()
      .eq('barber_id', barberId)
      .eq('work_date', dateAt(0));
    return must(
      await admin
        .from('barber_schedule')
        .insert({
          barber_id: barberId,
          work_date: dateAt(0),
          branch_id: branch,
          shift_start: '00:00:00',
          shift_end: '23:59:59',
          is_manual: true,
        })
        .select('id')
        .single(),
      'schedule row',
    );
  };
  await admin.from('barber_schedule').delete().eq('barber_id', barberC.barberId);
  const aSchedule = await manualRow(barberA.barberId, A);
  const cSchedule = await manualRow(barberC.barberId, B);

  // Barber service stats (admin insert).
  check(
    await admin.from('barber_service_stats').insert([
      {
        barber_id: barberA.barberId,
        service_id: serviceId,
        completed_count: 1,
        avg_duration_seconds: 600,
      },
      {
        barber_id: barberC.barberId,
        service_id: serviceId,
        completed_count: 1,
        avg_duration_seconds: 600,
      },
    ]),
    'barber_service_stats',
  );

  // Consents and push subscriptions.
  const consent = async (customerId: string) =>
    must(
      await admin
        .from('consents')
        .insert({
          customer_id: customerId,
          consent_type: 'marketing',
          granted: true,
          source: 'rbac_probe',
        })
        .select('id')
        .single(),
      'consent',
    ).id;
  const cnA = await consent(cust0.customerId);
  const cnB = await consent(cust1.customerId);
  const push = async (customerId: string, label: string) => {
    const endpoint = `https://push.example/rbac-${label}-${suffix}`;
    const id = must(
      await admin
        .from('push_subscriptions')
        .insert({
          customer_id: customerId,
          endpoint,
          p256dh_key: 'rbac-key',
          auth_key: 'rbac-auth',
        })
        .select('id')
        .single(),
      'push_subscription',
    ).id;
    return { id, endpoint };
  };
  const pA = await push(cust0.customerId, 'a');
  const pB = await push(cust1.customerId, 'b');

  // Audit log probe.
  const audit = must(
    await admin
      .from('audit_log')
      .insert({
        actor_type: 'system',
        action: 'rbac_probe',
        entity_type: 'branch',
        entity_id: A,
        result: 'success',
      })
      .select('id')
      .single(),
    'audit_log',
  ).id;

  // Catalogue extras: closures and prices.
  const closure = async (branch: string) =>
    must(
      await admin
        .from('branch_closures')
        .insert({ branch_id: branch, closure_date: dateAt(30), reason: 'rbac probe' })
        .select('id')
        .single(),
      'closure',
    ).id;
  const clA = await closure(A);
  const clB = await closure(B);
  const price = async (bsId: string) =>
    must(
      await admin
        .from('branch_service_prices')
        .insert({ branch_service_id: bsId, price_ghs: 50, effective_from: dateAt(0) })
        .select('id')
        .single(),
      'price',
    ).id;
  const prA = await price(base.branchServiceId);
  const prB = await price(base.closedBranchServiceId);

  // Catalogue reads.
  const hoursOf = async (branch: string) =>
    must(
      await admin.from('branch_hours').select('id').eq('branch_id', branch),
      'branch_hours ids',
    ).map((r) => r.id);
  const hoursA = await hoursOf(A);
  const hoursB = await hoursOf(B);
  const business = must(await admin.from('businesses').select('id').limit(1).single(), 'business');
  const counters = must(
    await admin.from('branch_ticket_counters').select('branch_id').in('branch_id', [A, B]),
    'counters',
  );

  const rows: Record<string, RowSet> = {
    queue_tickets: { a: [tA], b: [tB], own: [tA] },
    appointments: { a: [aA], b: [aB], own: [aA] },
    feedback: { a: [fA], b: [fB], own: [fA] },
    queue_events: { a: [eA], b: [eB], own: [eA] },
    notifications: { a: [nA], b: [nB], own: [nA] },
    service_sessions: { a: [sA], b: [sB], own: [sA] },
    barber_schedule: { a: [aSchedule.id], b: [cSchedule.id], own: [aSchedule.id] },
    barber_weekly_hours: { a: [whA], b: [whC], own: [whA] },
    // Composite-key tables (no id column): keyed by barber_id, one row each.
    barber_days_off: { a: [barberA.barberId], b: [barberC.barberId], own: [barberA.barberId] },
    barber_service_stats: { a: [barberA.barberId], b: [barberC.barberId], own: [] },
    barber_skills: { a: [barberA.barberId], b: [barberC.barberId], own: [barberA.barberId] },
    barbers: {
      a: [barberA.barberId, base.barberB.barberId],
      b: [barberC.barberId],
      own: [barberA.barberId],
    },
    consents: { a: [cnA], b: [cnB], own: [cnA] },
    push_subscriptions: { a: [pA.id], b: [pB.id], own: [pA.id] },
    customers: { a: [cust0.customerId], b: [cust1.customerId], own: [cust0.customerId] },
    audit_log: { a: [audit], b: [], own: [] },
    branches: { a: [A], b: [B], own: [] },
    branch_hours: { a: hoursA, b: hoursB, own: [] },
    branch_closures: { a: [clA], b: [clB], own: [] },
    branch_services: { a: [base.branchServiceId], b: [base.closedBranchServiceId], own: [] },
    branch_service_prices: { a: [prA], b: [prB], own: [] },
    services: { a: [serviceId], b: [], own: [] },
    businesses: { a: [business.id], b: [], own: [] },
    capabilities: { a: ['view_customers'], b: [], own: [] },
    role_capabilities: { a: ['view_customers'], b: [], own: [] },
    // Barber staff rows are deliberately not probed here: barbers have no staff_branch_assignments row,
    // so staff_users_branch_scoped_read never shows them to branch staff (recorded in the task report).
    staff_users: {
      a: [manager.staffUserId, receptionist.staffUserId, analyst.staffUserId],
      b: [otherManager.staffUserId],
      own: [],
    },
    staff_branch_assignments: {
      a: [manager.staffUserId, receptionist.staffUserId, analyst.staffUserId],
      b: [otherManager.staffUserId],
      own: [],
    },
    branch_ticket_counters: {
      a: counters.filter((c) => c.branch_id === A).map((c) => c.branch_id),
      b: counters.filter((c) => c.branch_id === B).map((c) => c.branch_id),
      own: [],
    },
    branch_status_view: { a: [A], b: [B], own: [] },
    current_branch_service_price: {
      a: [base.branchServiceId],
      b: [base.closedBranchServiceId],
      own: [],
    },
    customer_segments: { a: [cust0.customerId], b: [cust1.customerId], own: [cust0.customerId] },
  };

  const clients: Record<Role, Client> = {
    anon: createClient<Database>(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    }),
    customer: cust0.client,
    barber: base.barberClient,
    receptionist: receptionist.client,
    manager: manager.client,
    analyst: analyst.client,
    owner: ownerClient,
    otherManager: otherManager.client,
  };

  return {
    base,
    admin,
    clients,
    staffIds: {
      owner: owner.staffUserId,
      manager: manager.staffUserId,
      receptionist: receptionist.staffUserId,
      analyst: analyst.staffUserId,
      otherManager: otherManager.staffUserId,
      barber: barberA.staffUserId,
    },
    barberC,
    rows,
    owner,
    logins,
    customerIds: [cust0.customerId, cust1.customerId],
    created: {
      tickets: [tA, tB],
      sessions: [sA, sB],
      events: [eA, eB],
      feedback: [fA, fB],
      pushEndpoints: [pA.endpoint, pB.endpoint],
      consents: [cnA, cnB],
      audit: [audit],
      weeklyHours: [whA, whC],
      prices: [prA, prB],
      closures: [clA, clB],
    },
  };
}

export async function cleanupRbacFixture(f: RbacFixture): Promise<void> {
  const { admin, base, created } = f;
  const run = async (what: string, p: PromiseLike<{ error: { message: string } | null }>) => {
    const r = await p;
    if (r.error) throw new Error(`cleanup ${what}: ${r.error.message}`);
  };
  const barberIds = [base.barberA.barberId, f.barberC.barberId];
  await run(
    'staff_message notifications',
    admin.from('notifications').delete().in('recipient_id', f.customerIds),
  );
  await run(
    'push_subscriptions',
    admin.from('push_subscriptions').delete().in('endpoint', created.pushEndpoints),
  );
  await run('consents', admin.from('consents').delete().in('id', created.consents));
  await run('audit_log', admin.from('audit_log').delete().in('id', created.audit));
  await run('service_sessions', admin.from('service_sessions').delete().in('id', created.sessions));
  await run('queue_events', admin.from('queue_events').delete().in('id', created.events));
  await run('feedback', admin.from('feedback').delete().in('id', created.feedback));
  // Barber C's ticket references barber C (restrict), so tickets go before the barber.
  await run('queue_tickets', admin.from('queue_tickets').delete().in('id', created.tickets));
  await run(
    'barber_service_stats',
    admin.from('barber_service_stats').delete().in('barber_id', barberIds),
  );
  await run('barber_days_off', admin.from('barber_days_off').delete().in('barber_id', barberIds));
  await run(
    'barber_weekly_hours',
    admin.from('barber_weekly_hours').delete().in('id', created.weeklyHours),
  );
  await run(
    'barber C schedule',
    admin.from('barber_schedule').delete().eq('barber_id', f.barberC.barberId),
  );
  await run(
    'barber C skills',
    admin.from('barber_skills').delete().eq('barber_id', f.barberC.barberId),
  );
  await run('barber C barbers', admin.from('barbers').delete().eq('id', f.barberC.barberId));
  await run(
    'barber C staff_users',
    admin.from('staff_users').delete().eq('id', f.barberC.staffUserId),
  );
  const delC = await admin.auth.admin.deleteUser(f.barberC.authUserId);
  if (delC.error) throw new Error(`cleanup barber C auth: ${delC.error.message}`);
  await run('owner staff_users', admin.from('staff_users').delete().eq('id', f.owner.staffUserId));
  const delO = await admin.auth.admin.deleteUser(f.owner.authUserId);
  if (delO.error) throw new Error(`cleanup owner auth: ${delO.error.message}`);
  await run(
    'branch_service_prices',
    admin.from('branch_service_prices').delete().in('id', created.prices),
  );
  await run('branch_closures', admin.from('branch_closures').delete().in('id', created.closures));
  for (const login of f.logins) await cleanupStaffLogin(base, login);
  await cleanupAppointmentFixture(base);
}
