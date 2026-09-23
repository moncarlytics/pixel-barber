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

let ticket1Id: string;
let ticket2Id: string;
let ticket3Id: string;
let customer1Id: string;
let customer2Id: string;
let customer3Id: string;

let ticket4Id: string;
let customer4Id: string;

async function makeCustomerAndTicket(
  label: string,
  position: number,
  state: 'waiting' = 'waiting',
) {
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
    ticket1Id = await makeCustomerAndTicket('1', 1);
    ticket2Id = await makeCustomerAndTicket('2', 2);
    ticket3Id = await makeCustomerAndTicket('3', 3);
    customer1Id = customerIds[customerIds.length - 3];
    customer2Id = customerIds[customerIds.length - 2];
    customer3Id = customerIds[customerIds.length - 1];

    const { error } = await admin.rpc('recalculate_positions', {
      p_branch_id: branchId,
      p_barber_id: barberId,
    });
    expect(error).toBeNull();

    const { data: rows } = await admin
      .from('queue_tickets')
      .select('id, state, called_at')
      .in('id', [ticket1Id, ticket2Id, ticket3Id]);
    const stateById = Object.fromEntries(rows!.map((r) => [r.id, r.state]));
    expect(stateById[ticket1Id]).toBe('called');
    expect(stateById[ticket2Id]).toBe('almost_turn');
    expect(stateById[ticket3Id]).toBe('waiting');

    // Final review Problem 4: a position-driven promotion to 'called' must set called_at too,
    // not just state -- previously only the manual staff Acknowledge action set it.
    const ticket1Row = rows!.find((r) => r.id === ticket1Id);
    expect(ticket1Row!.called_at).not.toBeNull();

    const { data: notifications } = await admin
      .from('notifications')
      .select('id')
      .eq('related_ticket_id', ticket1Id)
      .eq('notification_type', 'your_turn');
    expect(notifications).toHaveLength(1);
  });

  it('a second recalculation does not promote another ticket to called', async () => {
    const { error } = await admin.rpc('recalculate_positions', {
      p_branch_id: branchId,
      p_barber_id: barberId,
    });
    expect(error).toBeNull();

    const { data: rows } = await admin
      .from('queue_tickets')
      .select('id, state')
      .in('id', [ticket1Id, ticket2Id, ticket3Id]);
    const stateById = Object.fromEntries(rows!.map((r) => [r.id, r.state]));
    expect(stateById[ticket1Id]).toBe('called');
    expect(stateById[ticket2Id]).toBe('almost_turn');
    expect(stateById[ticket3Id]).toBe('waiting');

    const { data: notif1 } = await admin
      .from('notifications')
      .select('id')
      .eq('related_ticket_id', ticket1Id)
      .eq('notification_type', 'your_turn');
    expect(notif1).toHaveLength(1);

    const { data: notif2 } = await admin
      .from('notifications')
      .select('id')
      .eq('related_ticket_id', ticket2Id)
      .eq('notification_type', 'your_turn');
    expect(notif2).toHaveLength(0);

    const { data: notif3 } = await admin
      .from('notifications')
      .select('id')
      .eq('related_ticket_id', ticket3Id)
      .eq('notification_type', 'your_turn');
    expect(notif3).toHaveLength(0);

    const { data: calledTickets } = await admin
      .from('queue_tickets')
      .select('id')
      .eq('branch_id', branchId)
      .eq('assigned_barber_id', barberId)
      .eq('state', 'called');
    expect(calledTickets).toHaveLength(1);
  });

  it('a ticket joining behind a called ticket does not disturb the head of the queue', async () => {
    ticket4Id = await makeCustomerAndTicket('4', null, 'waiting');
    customer4Id = customerIds[customerIds.length - 1];

    const { error } = await admin.rpc('recalculate_positions', {
      p_branch_id: branchId,
      p_barber_id: barberId,
    });
    expect(error).toBeNull();

    const { data: ticket1After } = await admin
      .from('queue_tickets')
      .select('state, position')
      .eq('id', ticket1Id)
      .single();
    expect(ticket1After!.state).toBe('called');
    expect(ticket1After!.position).toBe(1);

    const { data: ticket4After } = await admin
      .from('queue_tickets')
      .select('state, position')
      .eq('id', ticket4Id)
      .single();
    expect(ticket4After!.state).toBe('waiting');
    expect(ticket4After!.position).toBe(4);

    const { data: calledTickets } = await admin
      .from('queue_tickets')
      .select('id')
      .eq('branch_id', branchId)
      .eq('assigned_barber_id', barberId)
      .eq('state', 'called');
    expect(calledTickets).toHaveLength(1);

    const { data: notif4 } = await admin
      .from('notifications')
      .select('id')
      .eq('related_ticket_id', ticket4Id)
      .eq('notification_type', 'your_turn');
    expect(notif4).toHaveLength(0);
  });
});
