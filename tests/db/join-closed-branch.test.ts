// tests/db/join-closed-branch.test.ts
// @vitest-environment node
// Customers must not be able to self-service join a queue while their branch is closed
// (branch_status_view status 'closed' or 'temporarily_closed'). Staff walk-ins are exempt --
// they're physically in the shop and can judge for themselves. Sets is_temporarily_closed = true
// on a dedicated branch so the branch is deterministically closed regardless of time of day.
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
      name: 'Join Closed Branch Test Branch',
      branch_code: `JCB${suffix % 100000}`,
      address: 'Test',
      latitude: 5.6,
      longitude: -0.18,
    })
    .select()
    .single();
  branchId = branch!.id;

  // Deterministically closed regardless of time of day / branch_hours configuration.
  await admin.from('branches').update({ is_temporarily_closed: true }).eq('id', branchId);

  const { data: bs } = await admin
    .from('branch_services')
    .insert({ branch_id: branchId, service_id: serviceId })
    .select()
    .single();
  branchServiceId = bs!.id;

  const barberEmail = `jcb-barber-${suffix}@test.pixelbarber.local`;
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
      name: 'JCB Test Barber',
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

  const managerEmail = `jcb-manager-${suffix}@test.pixelbarber.local`;
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
      name: 'JCB Test Manager',
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
    .insert({
      auth_user_id: customerAuthUserId,
      name: 'JCB Test Customer',
      phone_e164: customerPhone,
    })
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
  // delete below, or it fails with a foreign-key violation.
  await admin.from('branch_ticket_counters').delete().eq('branch_id', branchId);
  await admin.from('branches').delete().eq('id', branchId);
}, 30000);

describe('joining a closed branch', () => {
  it('tickets-join is refused with BRANCH_CLOSED and creates no ticket', async () => {
    const { status, body } = await callFunction('tickets-join', customerAccessToken, {
      branch_id: branchId,
      branch_service_id: branchServiceId,
      preferred_barber_id: null,
    });
    expect(status).toBe(409);
    expect(body.error).toBe('BRANCH_CLOSED');

    const { data: tickets } = await admin
      .from('queue_tickets')
      .select('id')
      .eq('customer_id', customerId)
      .eq('branch_id', branchId)
      .not('state', 'in', '(completed,cancelled,no_show)');
    expect(tickets ?? []).toHaveLength(0);
  });

  it('tickets-walk-in is exempt and still assigns a real barber on the same closed branch', async () => {
    const { status, body } = await callFunction('tickets-walk-in', managerAccessToken, {
      branch_id: branchId,
      branch_service_id: branchServiceId,
      preferred_barber_id: null,
      name: 'JCB Walk-in Customer',
      phone_e164: null,
    });
    expect(status).toBe(200);
    createdTicketIds.push(body.ticket.id);
    createdCustomerIds.push(body.ticket.customer_id);
    expect(body.ticket.assigned_barber_id).not.toBeNull();
  });
});
