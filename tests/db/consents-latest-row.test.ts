// tests/db/consents-latest-row.test.ts
// @vitest-environment node
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
let customerAuthId: string;
let customerId: string;

beforeAll(async () => {
  const phone = `+233${String(suffix).slice(-9)}`;
  const { data: user } = await admin.auth.admin.createUser({
    phone,
    password: 'Test-Password-123!',
    phone_confirm: true,
  });
  customerAuthId = user!.user.id;

  const { data: customer } = await admin
    .from('customers')
    .insert({ auth_user_id: customerAuthId, name: 'Consent Test Customer', phone_e164: phone })
    .select()
    .single();
  customerId = customer!.id;
});

afterAll(async () => {
  await admin.from('consents').delete().eq('customer_id', customerId);
  await admin.from('customers').delete().eq('id', customerId);
  await admin.auth.admin.deleteUser(customerAuthId);
});

describe('consents "latest row wins"', () => {
  it('reads the only row when just one exists', async () => {
    await admin.from('consents').insert({
      customer_id: customerId,
      consent_type: 'marketing',
      granted: true,
      source: 'test',
    });

    const { data } = await admin
      .from('consents')
      .select('granted')
      .eq('customer_id', customerId)
      .eq('consent_type', 'marketing')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    expect(data?.granted).toBe(true);
  });

  it('reads the newest row after multiple toggles, not the first or a stale one', async () => {
    await admin.from('consents').insert({
      customer_id: customerId,
      consent_type: 'marketing',
      granted: false,
      source: 'test',
    });
    await admin.from('consents').insert({
      customer_id: customerId,
      consent_type: 'marketing',
      granted: true,
      source: 'test',
    });
    await admin.from('consents').insert({
      customer_id: customerId,
      consent_type: 'marketing',
      granted: false,
      source: 'test',
    });

    const { data } = await admin
      .from('consents')
      .select('granted')
      .eq('customer_id', customerId)
      .eq('consent_type', 'marketing')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    expect(data?.granted).toBe(false);

    const { count } = await admin
      .from('consents')
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', customerId)
      .eq('consent_type', 'marketing');
    expect(count).toBe(4);
  });

  it('keeps transactional and marketing consent independent for the same customer', async () => {
    await admin.from('consents').insert({
      customer_id: customerId,
      consent_type: 'transactional',
      granted: true,
      source: 'test',
    });

    const { data: transactional } = await admin
      .from('consents')
      .select('granted')
      .eq('customer_id', customerId)
      .eq('consent_type', 'transactional')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    const { data: marketing } = await admin
      .from('consents')
      .select('granted')
      .eq('customer_id', customerId)
      .eq('consent_type', 'marketing')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    expect(transactional?.granted).toBe(true);
    expect(marketing?.granted).toBe(false);
  });
});
