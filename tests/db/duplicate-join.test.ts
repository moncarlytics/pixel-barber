// tests/db/duplicate-join.test.ts
// @vitest-environment node
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
let authUserId: string;
let customerId: string;
let branchId: string;
let branchServiceId: string;
let accessToken: string;
let barberId: string;
let barberStaffUserId: string;
let barberAuthUserId: string;

beforeAll(async () => {
  const phone = `+233${String(suffix).slice(-9)}`;
  const password = 'Test-Password-123!';
  const { data: user } = await admin.auth.admin.createUser({
    phone,
    password,
    phone_confirm: true,
  });
  authUserId = user!.user.id;
  const { data: customer } = await admin
    .from('customers')
    .insert({ auth_user_id: authUserId, name: 'Duplicate Join Test', phone_e164: phone })
    .select()
    .single();
  customerId = customer!.id;

  const { data: branch } = await admin.from('branches').select('id').limit(1).single();
  branchId = branch!.id;
  const { data: bs } = await admin
    .from('branch_services')
    .select('id, service_id')
    .eq('branch_id', branchId)
    .limit(1)
    .single();
  branchServiceId = bs!.id;

  // Task 2: ticket creation now requires a real eligible barber (find_eligible_barber), so this
  // test's real shared branch needs one scheduled and skilled for the service being joined --
  // otherwise the join is correctly rejected with 409 NO_BARBER_AVAILABLE before ever reaching
  // the idempotency logic under test here.
  const barberEmail = `dupjoin-barber-${suffix}@test.pixelbarber.local`;
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
      name: 'Duplicate Join Test Barber',
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
  await admin.from('barber_skills').insert({ barber_id: barberId, service_id: bs!.service_id });
  await admin.from('barber_schedule').insert({
    barber_id: barberId,
    work_date: new Date().toISOString().slice(0, 10),
    branch_id: branchId,
    shift_start: '00:00:00',
    shift_end: '23:59:59',
  });

  const anon = createClient<Database>(url, anonKey);
  const { data: sessionData } = await anon.auth.signInWithPassword({ phone, password });
  accessToken = sessionData.session!.access_token;
}, 30000);

afterAll(async () => {
  await admin
    .from('queue_events')
    .delete()
    .eq(
      'ticket_id',
      (await admin.from('queue_tickets').select('id').eq('customer_id', customerId).maybeSingle())
        .data?.id ?? '',
    );
  await admin.from('notifications').delete().eq('recipient_id', customerId);
  await admin.from('queue_tickets').delete().eq('customer_id', customerId);
  await admin.from('customers').delete().eq('id', customerId);
  await admin.auth.admin.deleteUser(authUserId);
  await admin.from('barber_schedule').delete().eq('barber_id', barberId);
  await admin.from('barber_skills').delete().eq('barber_id', barberId);
  await admin.from('barbers').delete().eq('id', barberId);
  await admin.from('staff_users').delete().eq('id', barberStaffUserId);
  await admin.auth.admin.deleteUser(barberAuthUserId);
}, 30000);

describe('duplicate join idempotency (PRD 34)', () => {
  it('creates exactly one ticket when the same join request fires twice concurrently', async () => {
    const call = () =>
      fetch(`${url}/functions/v1/tickets-join`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch_id: branchId, branch_service_id: branchServiceId }),
      }).then((r) => r.json());

    const [first, second] = await Promise.all([call(), call()]);
    expect(first.ticket.id).toBe(second.ticket.id);

    const { count } = await admin
      .from('queue_tickets')
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', customerId)
      .eq('branch_id', branchId);
    expect(count).toBe(1);
  });
});
