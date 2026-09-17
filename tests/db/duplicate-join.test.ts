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
    .select('id')
    .eq('branch_id', branchId)
    .limit(1)
    .single();
  branchServiceId = bs!.id;

  const anon = createClient<Database>(url, anonKey);
  const { data: sessionData } = await anon.auth.signInWithPassword({ phone, password });
  accessToken = sessionData.session!.access_token;
});

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
});

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
