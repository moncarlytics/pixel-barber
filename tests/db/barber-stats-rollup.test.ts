// tests/db/barber-stats-rollup.test.ts
// @vitest-environment node
// Phase 5 Task 9 (Step 3): the already-built (Phase 0/1) barber_service_stats and
// barbers.average_rating rollup triggers (trg_service_session_completed,
// trg_feedback_updates_barber_rating -- supabase/migrations/20260911211300_functions_and_triggers.sql)
// exercised for the first time against this phase's own real data shape: a ticket driven through
// Acknowledge (Task 5's exact write: state -> in_service + a service_sessions insert) then Mark
// Complete (Task 5's exact write: state -> completed + service_sessions.ended_at set), followed by a
// feedback row insert. Driven via the admin/service-role client directly -- the triggers are
// SECURITY DEFINER and fire identically regardless of which role's write reaches them, and Task 5's
// own controller smoke test already covered the real-barber-session path for the write mechanics
// themselves; what's new and worth a permanent regression test here is that the rollup triggers
// actually produce correct numbers against this phase's first real rows.
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
let serviceId: string;

let barberStaffUserId: string;
let barberAuthUserId: string;
let barberId: string;

let customerId: string;
let customerAuthId: string;
let ticketId: string;

beforeAll(async () => {
  const { data: business } = await admin.from('businesses').select('id').limit(1).single();
  const { data: service } = await admin.from('services').select('id').limit(1).single();
  serviceId = service!.id;

  const { data: branch } = await admin
    .from('branches')
    .insert({
      business_id: business!.id,
      name: 'Barber Stats Rollup Test Branch',
      branch_code: `STATS${suffix % 100000}`,
      address: 'Test',
      latitude: 5.6,
      longitude: -0.18,
    })
    .select()
    .single();
  branchId = branch!.id;

  const { data: branchService } = await admin
    .from('branch_services')
    .insert({ branch_id: branchId, service_id: serviceId })
    .select()
    .single();
  branchServiceId = branchService!.id;

  const barberEmail = `stats-test-barber-${suffix}@test.pixelbarber.local`;
  const { data: barberAuthUser } = await admin.auth.admin.createUser({
    email: barberEmail,
    password: 'Test-Password-123!',
    email_confirm: true,
  });
  barberAuthUserId = barberAuthUser!.user.id;
  const { data: barberStaffRow } = await admin
    .from('staff_users')
    .insert({
      auth_user_id: barberAuthUserId,
      name: 'Stats Test Barber',
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
  // Fresh barber, never any prior feedback/service_sessions -- average_rating starts out null and
  // barber_service_stats has no existing (barber_id, service_id) row, so this test's assertions
  // aren't diluted by any pre-existing row for this exact barber/service pair.
  expect(barberRow!.average_rating).toBeNull();

  const phone = `+233${String(suffix).slice(-9)}`;
  const { data: customerAuthUser } = await admin.auth.admin.createUser({
    phone,
    password: 'Test-Password-123!',
    phone_confirm: true,
  });
  customerAuthId = customerAuthUser!.user.id;
  const { data: customer } = await admin
    .from('customers')
    .insert({ auth_user_id: customerAuthId, name: 'Stats Test Customer', phone_e164: phone })
    .select()
    .single();
  customerId = customer!.id;

  const { data: ticket } = await admin
    .from('queue_tickets')
    .insert({
      ticket_number: `PB-STATS-${suffix}`,
      branch_id: branchId,
      customer_id: customerId,
      branch_service_id: branchServiceId,
      assigned_barber_id: barberId,
      state: 'waiting',
      position: 1,
      created_by: 'staff',
    })
    .select()
    .single();
  ticketId = ticket!.id;
}, 30000);

afterAll(async () => {
  // FK-safe order: feedback and service_sessions both reference queue_tickets(id) with the default
  // (restrictive) FK, so both must go before queue_tickets. barber_service_stats/barbers both
  // cascade from staff_users -> barbers automatically (barbers.staff_user_id and
  // barber_service_stats.barber_id are both `on delete cascade`), so no explicit delete is needed
  // for either once staff_users is removed -- but feedback.barber_id has no `on delete` clause
  // (default restrict), so feedback must be deleted before staff_users/barbers too.
  await admin.from('feedback').delete().eq('ticket_id', ticketId);
  await admin.from('service_sessions').delete().eq('ticket_id', ticketId);
  await admin.from('queue_tickets').delete().eq('id', ticketId);
  await admin.from('customers').delete().eq('id', customerId);
  await admin.from('staff_users').delete().eq('id', barberStaffUserId);
  for (const authId of [barberAuthUserId, customerAuthId]) {
    await admin.auth.admin.deleteUser(authId);
  }
  await admin.from('branches').delete().eq('id', branchId);
}, 30000);

describe('barber_service_stats / barbers.average_rating rollups', () => {
  it('a real Acknowledge -> Mark Complete -> feedback sequence rolls up correct stats and rating', async () => {
    // Acknowledge (Task 5's exact write shape): state -> in_service + a service_sessions insert.
    const startedAt = new Date(Date.now() - 600_000); // 10 minutes before "now" below
    const { error: ackError } = await admin
      .from('queue_tickets')
      .update({
        state: 'in_service',
        called_at: startedAt.toISOString(),
        confirmed_at: startedAt.toISOString(),
        service_started_at: startedAt.toISOString(),
      })
      .eq('id', ticketId);
    expect(ackError).toBeNull();

    const { error: sessionInsertError } = await admin.from('service_sessions').insert({
      ticket_id: ticketId,
      barber_id: barberId,
      started_at: startedAt.toISOString(),
    });
    expect(sessionInsertError).toBeNull();

    // Mark Complete (Task 5's exact write shape): state -> completed + service_sessions.ended_at.
    // Exactly 600 seconds after started_at, for a deterministic avg_duration_seconds assertion.
    const endedAt = new Date(startedAt.getTime() + 600_000);
    const { error: completeError } = await admin
      .from('queue_tickets')
      .update({ state: 'completed', completed_at: endedAt.toISOString() })
      .eq('id', ticketId);
    expect(completeError).toBeNull();

    const { error: sessionUpdateError } = await admin
      .from('service_sessions')
      .update({ ended_at: endedAt.toISOString() })
      .eq('ticket_id', ticketId);
    expect(sessionUpdateError).toBeNull();

    // trg_service_session_completed fires on this UPDATE (ended_at newly non-null) and should have
    // inserted/updated the (barber_id, service_id) row in barber_service_stats.
    const { data: statsRow } = await admin
      .from('barber_service_stats')
      .select('*')
      .eq('barber_id', barberId)
      .eq('service_id', serviceId)
      .single();
    expect(statsRow!.completed_count).toBe(1);
    expect(statsRow!.avg_duration_seconds).toBe(600);

    // Now the feedback row -- trg_feedback_updates_barber_rating fires on insert.
    const { error: feedbackError } = await admin.from('feedback').insert({
      ticket_id: ticketId,
      customer_id: customerId,
      branch_id: branchId,
      barber_id: barberId,
      overall_rating: 4,
    });
    expect(feedbackError).toBeNull();

    const { data: barberAfter } = await admin
      .from('barbers')
      .select('average_rating')
      .eq('id', barberId)
      .single();
    expect(Number(barberAfter!.average_rating)).toBe(4);
  });
});
