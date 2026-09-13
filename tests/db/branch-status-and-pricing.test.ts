// tests/db/branch-status-and-pricing.test.ts
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
let businessId: string;
let branchId: string;
let serviceId: string;
let branchServiceId: string;

beforeAll(async () => {
  const { data: business } = await admin.from('businesses').select('id').limit(1).single();
  businessId = business!.id;

  const { data: branch } = await admin
    .from('branches')
    .insert({
      business_id: businessId,
      name: `Pricing Test Branch ${suffix}`,
      branch_code: `PTB${suffix % 100000}`,
      address: 'Test',
      latitude: 5.6,
      longitude: -0.18,
    })
    .select()
    .single();
  branchId = branch!.id;

  const { data: service } = await admin
    .from('services')
    .insert({
      business_id: businessId,
      name: `Pricing Test Service ${suffix}`,
      default_duration_minutes: 30,
    })
    .select()
    .single();
  serviceId = service!.id;

  const { data: bs } = await admin
    .from('branch_services')
    .insert({ branch_id: branchId, service_id: serviceId })
    .select()
    .single();
  branchServiceId = bs!.id;
});

afterAll(async () => {
  await admin.from('branch_service_prices').delete().eq('branch_service_id', branchServiceId);
  await admin.from('branch_services').delete().eq('id', branchServiceId);
  await admin.from('services').delete().eq('id', serviceId);
  await admin.from('branch_hours').delete().eq('branch_id', branchId);
  await admin.from('branch_closures').delete().eq('branch_id', branchId);
  await admin.from('branches').delete().eq('id', branchId);
});

describe('branch_status_view', () => {
  it("reports open when now falls inside today's hours", async () => {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const opensAt = new Date(now.getTime() - 60 * 60 * 1000).toTimeString().slice(0, 8);
    const closesAt = new Date(now.getTime() + 2 * 60 * 60 * 1000).toTimeString().slice(0, 8);
    await admin
      .from('branch_hours')
      .upsert(
        {
          branch_id: branchId,
          day_of_week: dayOfWeek,
          opens_at: opensAt,
          closes_at: closesAt,
          is_closed: false,
        },
        { onConflict: 'branch_id,day_of_week' },
      );

    const { data } = await admin
      .from('branch_status_view')
      .select('status')
      .eq('branch_id', branchId)
      .single();
    expect(data?.status).toBe('open');
  });

  it('reports closing_soon within 30 minutes of close', async () => {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const opensAt = new Date(now.getTime() - 2 * 60 * 60 * 1000).toTimeString().slice(0, 8);
    const closesAt = new Date(now.getTime() + 10 * 60 * 1000).toTimeString().slice(0, 8);
    await admin
      .from('branch_hours')
      .upsert(
        {
          branch_id: branchId,
          day_of_week: dayOfWeek,
          opens_at: opensAt,
          closes_at: closesAt,
          is_closed: false,
        },
        { onConflict: 'branch_id,day_of_week' },
      );

    const { data } = await admin
      .from('branch_status_view')
      .select('status')
      .eq('branch_id', branchId)
      .single();
    expect(data?.status).toBe('closing_soon');
  });

  it('reports closed on a day marked is_closed', async () => {
    const now = new Date();
    const dayOfWeek = now.getDay();
    await admin
      .from('branch_hours')
      .upsert(
        {
          branch_id: branchId,
          day_of_week: dayOfWeek,
          opens_at: null,
          closes_at: null,
          is_closed: true,
        },
        { onConflict: 'branch_id,day_of_week' },
      );

    const { data } = await admin
      .from('branch_status_view')
      .select('status')
      .eq('branch_id', branchId)
      .single();
    expect(data?.status).toBe('closed');
  });

  it('reports temporarily_closed when the branch flag is set, overriding hours', async () => {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const opensAt = new Date(now.getTime() - 60 * 60 * 1000).toTimeString().slice(0, 8);
    const closesAt = new Date(now.getTime() + 2 * 60 * 60 * 1000).toTimeString().slice(0, 8);
    await admin
      .from('branch_hours')
      .upsert(
        {
          branch_id: branchId,
          day_of_week: dayOfWeek,
          opens_at: opensAt,
          closes_at: closesAt,
          is_closed: false,
        },
        { onConflict: 'branch_id,day_of_week' },
      );
    await admin.from('branches').update({ is_temporarily_closed: true }).eq('id', branchId);

    const { data } = await admin
      .from('branch_status_view')
      .select('status')
      .eq('branch_id', branchId)
      .single();
    expect(data?.status).toBe('temporarily_closed');

    await admin.from('branches').update({ is_temporarily_closed: false }).eq('id', branchId);
  });
});

describe('current_branch_service_price', () => {
  it('resolves to the only active price row', async () => {
    await admin
      .from('branch_service_prices')
      .insert({ branch_service_id: branchServiceId, price_ghs: 50, effective_from: '2020-01-01' });

    const { data } = await admin
      .from('current_branch_service_price')
      .select('*')
      .eq('branch_service_id', branchServiceId)
      .single();
    expect(data?.price_ghs).toBe(50);
    expect(data?.is_promo).toBe(false);
  });

  it('prefers an active promo row over a non-promo row', async () => {
    await admin
      .from('branch_service_prices')
      .insert({
        branch_service_id: branchServiceId,
        price_ghs: 35,
        is_promo: true,
        effective_from: '2020-01-01',
      });

    const { data } = await admin
      .from('current_branch_service_price')
      .select('*')
      .eq('branch_service_id', branchServiceId)
      .single();
    expect(data?.price_ghs).toBe(35);
    expect(data?.is_promo).toBe(true);
  });

  it('ignores an expired promo row', async () => {
    await admin.from('branch_service_prices').delete().eq('branch_service_id', branchServiceId);
    await admin
      .from('branch_service_prices')
      .insert({ branch_service_id: branchServiceId, price_ghs: 60, effective_from: '2020-01-01' });
    await admin.from('branch_service_prices').insert({
      branch_service_id: branchServiceId,
      price_ghs: 20,
      is_promo: true,
      effective_from: '2020-06-01',
      effective_until: '2020-06-30',
    });

    const { data } = await admin
      .from('current_branch_service_price')
      .select('*')
      .eq('branch_service_id', branchServiceId)
      .single();
    expect(data?.price_ghs).toBe(60);
    expect(data?.is_promo).toBe(false);
  });
});
