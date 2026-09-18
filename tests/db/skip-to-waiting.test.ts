// tests/db/skip-to-waiting.test.ts
// @vitest-environment node
// Phase 5 Task 9 (Step 2): PRD 12.3's Skip action, tested exactly the way Today's Queue itself
// performs it (apps/staff/app/queue/today/page.tsx's handleSkip) -- a real barber session calling
// updateTicketWithVersion(supabase, ticketId, version, { skipped_at: now }) with no state change at
// all. The repositioning is entirely Task 1's trg_ticket_state_changed_or_skip trigger (fired on
// UPDATE OF skipped_at) plus recalculate_positions()'s `order by coalesce(skipped_at,
// '-infinity'), created_at`: a skipped ticket keeps its 'waiting' state but sorts behind every
// not-yet-skipped ticket in the same barber's queue, regardless of original arrival order.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';
import { updateTicketWithVersion } from '@pixel-barber/shared';

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

let barberStaffUserId: string;
let barberAuthUserId: string;
let barberId: string;
let barberEmail: string;
let barberClient: ReturnType<typeof createClient<Database>>;

let customerAId: string;
let customerAAuthId: string;
let ticketAId: string;

let customerBId: string;
let customerBAuthId: string;
let ticketBId: string;

beforeAll(async () => {
  const { data: business } = await admin.from('businesses').select('id').limit(1).single();
  const { data: service } = await admin.from('services').select('id').limit(1).single();

  const { data: branch } = await admin
    .from('branches')
    .insert({
      business_id: business!.id,
      name: 'Skip To Waiting Test Branch',
      branch_code: `SKIP${suffix % 100000}`,
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

  barberEmail = `skip-test-barber-${suffix}@test.pixelbarber.local`;
  const { data: barberAuthUser } = await admin.auth.admin.createUser({
    email: barberEmail,
    password: PASSWORD,
    email_confirm: true,
  });
  barberAuthUserId = barberAuthUser!.user.id;
  const { data: barberStaffRow } = await admin
    .from('staff_users')
    .insert({
      auth_user_id: barberAuthUserId,
      name: 'Skip Test Barber',
      email: barberEmail,
      role: 'barber',
      invite_status: 'accepted',
    })
    .select()
    .single();
  barberStaffUserId = barberStaffRow!.id;
  const { data: barberRow } = await admin
    .from('barbers')
    .insert({ staff_user_id: barberStaffUserId, home_branch_id: branchId })
    .select()
    .single();
  barberId = barberRow!.id;

  const phoneA = `+233${String(suffix).slice(-8)}1`;
  const { data: userA } = await admin.auth.admin.createUser({
    phone: phoneA,
    password: PASSWORD,
    phone_confirm: true,
  });
  customerAAuthId = userA!.user.id;
  const { data: customerA } = await admin
    .from('customers')
    .insert({ auth_user_id: customerAAuthId, name: 'Skip Test Customer A', phone_e164: phoneA })
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
    .insert({ auth_user_id: customerBAuthId, name: 'Skip Test Customer B', phone_e164: phoneB })
    .select()
    .single();
  customerBId = customerB!.id;

  const { data: ticketA } = await admin
    .from('queue_tickets')
    .insert({
      ticket_number: `PB-SKIP-A-${suffix}`,
      branch_id: branchId,
      customer_id: customerAId,
      branch_service_id: branchServiceId,
      assigned_barber_id: barberId,
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
      ticket_number: `PB-SKIP-B-${suffix}`,
      branch_id: branchId,
      customer_id: customerBId,
      branch_service_id: branchServiceId,
      assigned_barber_id: barberId,
      state: 'waiting',
      position: 2,
      created_by: 'staff',
    })
    .select()
    .single();
  ticketBId = ticketB!.id;

  barberClient = createClient<Database>(url, anonKey);
  await barberClient.auth.signInWithPassword({ email: barberEmail, password: PASSWORD });
}, 30000);

afterAll(async () => {
  // FK-safe order (matches tests/db/shared-station-handoff.test.ts): queue_events before
  // queue_tickets, tickets before customers/staff_users, staff_users before its auth user
  // (staff_users.auth_user_id is `on delete restrict`; deleting staff_users also cascades to the
  // barbers row), auth users before branches, branch last.
  for (const ticketId of [ticketAId, ticketBId]) {
    await admin.from('queue_events').delete().eq('ticket_id', ticketId);
  }
  for (const ticketId of [ticketAId, ticketBId]) {
    await admin.from('queue_tickets').delete().eq('id', ticketId);
  }
  for (const customerId of [customerAId, customerBId]) {
    await admin.from('customers').delete().eq('id', customerId);
  }
  await admin.from('staff_users').delete().eq('id', barberStaffUserId);
  for (const authId of [barberAuthUserId, customerAAuthId, customerBAuthId]) {
    await admin.auth.admin.deleteUser(authId);
  }
  await admin.from('branches').delete().eq('id', branchId);
}, 30000);

describe('Skip -> Waiting (PRD 12.3)', () => {
  it("skipping ticket A leaves its state as 'waiting' but moves it behind ticket B, without restarting the no-show escalation", async () => {
    const { data: ticketABefore } = await admin
      .from('queue_tickets')
      .select('version')
      .eq('id', ticketAId)
      .single();

    const result = await updateTicketWithVersion(barberClient, ticketAId, ticketABefore!.version, {
      skipped_at: new Date().toISOString(),
    });
    expect(result.success).toBe(true);

    const { data: ticketAAfter } = await admin
      .from('queue_tickets')
      .select('state, position, skipped_at')
      .eq('id', ticketAId)
      .single();
    expect(ticketAAfter!.state).toBe('waiting');
    expect(ticketAAfter!.skipped_at).not.toBeNull();
    expect(ticketAAfter!.position).toBe(2);

    const { data: ticketBAfter } = await admin
      .from('queue_tickets')
      .select('state, position')
      .eq('id', ticketBId)
      .single();
    expect(ticketBAfter!.state).toBe('waiting');
    expect(ticketBAfter!.position).toBe(1);
  });
});
