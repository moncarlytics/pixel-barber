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
    const ticket1 = await makeCustomerAndTicket('1', 1);
    const ticket2 = await makeCustomerAndTicket('2', 2);
    const ticket3 = await makeCustomerAndTicket('3', 3);

    const { error } = await admin.rpc('recalculate_positions', {
      p_branch_id: branchId,
      p_barber_id: barberId,
    });
    expect(error).toBeNull();

    const { data: rows } = await admin
      .from('queue_tickets')
      .select('id, state')
      .in('id', [ticket1, ticket2, ticket3]);
    const stateById = Object.fromEntries(rows!.map((r) => [r.id, r.state]));
    expect(stateById[ticket1]).toBe('called');
    expect(stateById[ticket2]).toBe('almost_turn');
    expect(stateById[ticket3]).toBe('waiting');

    const { data: notifications } = await admin
      .from('notifications')
      .select('id')
      .eq('related_ticket_id', ticket1)
      .eq('notification_type', 'your_turn');
    expect(notifications).toHaveLength(1);
  });

  it('does not re-notify on a second call once a ticket is already called', async () => {
    const ticket = ticketIds[0]; // already 'called' from the previous test
    const { error } = await admin.rpc('recalculate_positions', {
      p_branch_id: branchId,
      p_barber_id: barberId,
    });
    expect(error).toBeNull();

    const { data: notifications } = await admin
      .from('notifications')
      .select('id')
      .eq('related_ticket_id', ticket)
      .eq('notification_type', 'your_turn');
    expect(notifications).toHaveLength(1); // still exactly one, not two
  });
});
