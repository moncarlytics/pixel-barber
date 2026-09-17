// tests/db/queue-position-recalc-cross-actor.test.ts
// @vitest-environment node
// Verifies the Task 1 fix: a CUSTOMER-driven ticket cancellation correctly recalculates the
// position of OTHER customers' tickets in the same queue, not just the cancelling customer's own
// row. Before the fix, recalculate_positions()/trg_ticket_state_changed() ran without SECURITY
// DEFINER, so the internal bulk UPDATE executed under the cancelling customer's own RLS -- whose
// tickets_customer_cancel policy only ever lets them touch their own ticket row. Ticket B (owned by
// a different customer) would silently keep its stale position forever.
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

const PASSWORD = 'Test-Password-123!';
const suffix = Date.now();

let branchId: string;
let branchServiceId: string;

let customerAAuthId: string;
let customerAId: string;
let customerAClient: ReturnType<typeof createClient<Database>>;
let ticketAId: string;

let customerBAuthId: string;
let customerBId: string;
let ticketBId: string;

beforeAll(async () => {
  const { data: business } = await admin.from('businesses').select('id').limit(1).single();
  const { data: service } = await admin.from('services').select('id').limit(1).single();

  const { data: branch } = await admin
    .from('branches')
    .insert({
      business_id: business!.id,
      name: 'Recalc Cross-Actor Test Branch',
      branch_code: `RECALC${suffix % 100000}`,
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

  const phoneA = `+233${String(suffix).slice(-8)}1`;
  const { data: userA } = await admin.auth.admin.createUser({
    phone: phoneA,
    password: PASSWORD,
    phone_confirm: true,
  });
  customerAAuthId = userA!.user.id;
  const { data: customerA } = await admin
    .from('customers')
    .insert({ auth_user_id: customerAAuthId, name: 'Recalc Test Customer A', phone_e164: phoneA })
    .select()
    .single();
  customerAId = customerA!.id;

  const phoneB = `+233${String(suffix).slice(-8)}2`;
  const { data: userB } = await admin.auth.admin.createUser({
    phone: phoneB,
    password: PASSWORD,
    phone_confirm: true,
  });
  customerBAuthId = userB!.user.id;
  const { data: customerB } = await admin
    .from('customers')
    .insert({ auth_user_id: customerBAuthId, name: 'Recalc Test Customer B', phone_e164: phoneB })
    .select()
    .single();
  customerBId = customerB!.id;

  const { data: ticketA } = await admin
    .from('queue_tickets')
    .insert({
      ticket_number: `PB-RECALC-A-${suffix}`,
      branch_id: branchId,
      customer_id: customerAId,
      branch_service_id: branchServiceId,
      state: 'waiting',
      position: 1,
      created_by: 'staff',
    })
    .select()
    .single();
  ticketAId = ticketA!.id;

  const { data: ticketB } = await admin
    .from('queue_tickets')
    .insert({
      ticket_number: `PB-RECALC-B-${suffix}`,
      branch_id: branchId,
      customer_id: customerBId,
      branch_service_id: branchServiceId,
      state: 'waiting',
      position: 2,
      created_by: 'staff',
    })
    .select()
    .single();
  ticketBId = ticketB!.id;

  customerAClient = createClient<Database>(url, anonKey);
  await customerAClient.auth.signInWithPassword({ phone: phoneA, password: PASSWORD });
}, 30000);

afterAll(async () => {
  // FK-safe order (matches tests/db/ticket-concurrent-edit.test.ts and rls-policies.test.ts):
  // queue_events before queue_tickets, tickets before customers/branches, auth users last, branch
  // last of all (branch_services/branch_service_prices cascade from it).
  for (const ticketId of [ticketAId, ticketBId]) {
    await admin.from('queue_events').delete().eq('ticket_id', ticketId);
  }
  for (const ticketId of [ticketAId, ticketBId]) {
    await admin.from('queue_tickets').delete().eq('id', ticketId);
  }
  for (const customerId of [customerAId, customerBId]) {
    await admin.from('customers').delete().eq('id', customerId);
  }
  for (const authId of [customerAAuthId, customerBAuthId]) {
    await admin.auth.admin.deleteUser(authId);
  }
  await admin.from('branches').delete().eq('id', branchId);
}, 30000);

describe('cross-actor queue position recalculation', () => {
  it("customer A cancelling their own ticket recalculates customer B's ticket position", async () => {
    const { error } = await customerAClient
      .from('queue_tickets')
      .update({
        state: 'cancelled',
        cancel_reason: 'changed_plans',
        cancelled_at: new Date().toISOString(),
      })
      .eq('id', ticketAId);
    expect(error).toBeNull();

    const { data: ticketBRow } = await admin
      .from('queue_tickets')
      .select('position, state')
      .eq('id', ticketBId)
      .single();

    expect(ticketBRow!.state).toBe('waiting');
    expect(ticketBRow!.position).toBe(1);
  });
});
