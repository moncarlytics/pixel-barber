// tests/db/grace-period-expiry-cron.test.ts
// @vitest-environment node
// Phase 5 Task 9 (Step 1): permanent regression coverage for the real, deployed
// expire_no_show_grace_periods() function (Task 8,
// supabase/migrations/20260917090600_expire_no_show_grace_periods_real.sql), calling it exactly as
// the controller's own (deleted) verification test did via admin.rpc(). Proves the whole chain in
// one shot: a lapsed grace-period ticket becomes no_show, the resulting queue_events/notifications
// rows this migration's "real" version added actually get written, and Task 1's
// trg_ticket_state_changed_or_skip trigger (fired by the cron's own plain UPDATE) repositions the
// rest of the queue -- a second, still-waiting ticket in the same branch moves up to position 1.
//
// Two separate customers back the two tickets: one_active_ticket_per_customer_branch (a unique
// index on (customer_id, branch_id) for any non-terminal state) forbids giving the same customer
// two simultaneously-active tickets in one branch.
//
// Both tickets are left unassigned (assigned_barber_id null, is_pooled false, the default): per
// recalculate_positions()'s own WHERE clause, `p_barber_id is null` short-circuits the whole OR to
// true, so passing a null barber id (exactly what trg_ticket_state_changed_or_skip passes when a
// ticket has no assigned_barber_id) recalculates every waiting/almost_turn ticket in the branch --
// no barber fixture is needed to exercise this.
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

let expiringCustomerId: string;
let expiringCustomerAuthId: string;
let expiringTicketId: string;

let waitingCustomerId: string;
let waitingCustomerAuthId: string;
let waitingTicketId: string;

beforeAll(async () => {
  const { data: business } = await admin.from('businesses').select('id').limit(1).single();
  const { data: service } = await admin.from('services').select('id').limit(1).single();

  const { data: branch } = await admin
    .from('branches')
    .insert({
      business_id: business!.id,
      name: 'Grace Period Expiry Cron Test Branch',
      branch_code: `GPEC${suffix % 100000}`,
      address: 'Test',
      latitude: 5.6,
      longitude: -0.18,
    })
    .select()
    .single();
  branchId = branch!.id;

  const { data: branchService } = await admin
    .from('branch_services')
    .insert({ branch_id: branchId, service_id: service!.id })
    .select()
    .single();
  branchServiceId = branchService!.id;

  const expiringPhone = `+233${String(suffix).slice(-8)}1`;
  const { data: expiringUser } = await admin.auth.admin.createUser({
    phone: expiringPhone,
    password: 'Test-Password-123!',
    phone_confirm: true,
  });
  expiringCustomerAuthId = expiringUser!.user.id;
  const { data: expiringCustomer } = await admin
    .from('customers')
    .insert({
      auth_user_id: expiringCustomerAuthId,
      name: 'Grace Expiry Test Customer',
      phone_e164: expiringPhone,
    })
    .select()
    .single();
  expiringCustomerId = expiringCustomer!.id;

  const waitingPhone = `+233${String(suffix).slice(-8)}2`;
  const { data: waitingUser } = await admin.auth.admin.createUser({
    phone: waitingPhone,
    password: 'Test-Password-123!',
    phone_confirm: true,
  });
  waitingCustomerAuthId = waitingUser!.user.id;
  const { data: waitingCustomer } = await admin
    .from('customers')
    .insert({
      auth_user_id: waitingCustomerAuthId,
      name: 'Grace Expiry Test Waiting Customer',
      phone_e164: waitingPhone,
    })
    .select()
    .single();
  waitingCustomerId = waitingCustomer!.id;

  // The ticket about to expire: already in grace_period, with grace_period_expires_at safely in
  // the past -- deterministic in CI, no real-time wait required.
  const { data: expiringTicket } = await admin
    .from('queue_tickets')
    .insert({
      ticket_number: `PB-GPEC-EXPIRE-${suffix}`,
      branch_id: branchId,
      customer_id: expiringCustomerId,
      branch_service_id: branchServiceId,
      state: 'grace_period',
      grace_period_expires_at: new Date(Date.now() - 60_000).toISOString(),
      position: 1,
      created_by: 'staff',
    })
    .select()
    .single();
  expiringTicketId = expiringTicket!.id;

  const { data: waitingTicket } = await admin
    .from('queue_tickets')
    .insert({
      ticket_number: `PB-GPEC-WAIT-${suffix}`,
      branch_id: branchId,
      customer_id: waitingCustomerId,
      branch_service_id: branchServiceId,
      state: 'waiting',
      position: 2,
      created_by: 'staff',
    })
    .select()
    .single();
  waitingTicketId = waitingTicket!.id;
}, 30000);

afterAll(async () => {
  // FK-safe order (matches tests/db/queue-position-recalc-cross-actor.test.ts): queue_events and
  // notifications before queue_tickets (both reference ticket_id/related_ticket_id with the default
  // restrictive FK), tickets before customers, auth users before branches, branch last.
  for (const ticketId of [expiringTicketId, waitingTicketId]) {
    await admin.from('queue_events').delete().eq('ticket_id', ticketId);
  }
  await admin.from('notifications').delete().eq('related_ticket_id', expiringTicketId);
  for (const ticketId of [expiringTicketId, waitingTicketId]) {
    await admin.from('queue_tickets').delete().eq('id', ticketId);
  }
  for (const customerId of [expiringCustomerId, waitingCustomerId]) {
    await admin.from('customers').delete().eq('id', customerId);
  }
  for (const authId of [expiringCustomerAuthId, waitingCustomerAuthId]) {
    await admin.auth.admin.deleteUser(authId);
  }
  await admin.from('branches').delete().eq('id', branchId);
}, 30000);

describe('expire_no_show_grace_periods() cron job', () => {
  it('expires a lapsed grace-period ticket to no_show, writes queue_events/notifications, and repositions the rest of the queue', async () => {
    const { error: rpcError } = await admin.rpc('expire_no_show_grace_periods');
    expect(rpcError).toBeNull();

    const { data: expiredTicket } = await admin
      .from('queue_tickets')
      .select('state, no_show_at')
      .eq('id', expiringTicketId)
      .single();
    expect(expiredTicket!.state).toBe('no_show');
    expect(expiredTicket!.no_show_at).not.toBeNull();

    const { data: events } = await admin
      .from('queue_events')
      .select('*')
      .eq('ticket_id', expiringTicketId)
      .eq('event_type', 'no_show');
    expect(events).toHaveLength(1);
    expect(events![0].actor_type).toBe('system');

    const { data: notifs } = await admin
      .from('notifications')
      .select('*')
      .eq('related_ticket_id', expiringTicketId)
      .eq('notification_type', 'ticket_released');
    expect(notifs).toHaveLength(1);
    expect(notifs![0].recipient_id).toBe(expiringCustomerId);
    expect(notifs![0].recipient_type).toBe('customer');

    const { data: waitingTicketRow } = await admin
      .from('queue_tickets')
      .select('state, position')
      .eq('id', waitingTicketId)
      .single();
    expect(waitingTicketRow!.state).toBe('waiting');
    expect(waitingTicketRow!.position).toBe(1);
  });
});
