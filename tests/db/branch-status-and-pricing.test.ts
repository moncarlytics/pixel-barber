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
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * Today's branch hours around "now", matching how branch_status_view reads them: the database's
 * now() is UTC, so the weekday and times are UTC too (a local-clock getDay() picks the wrong day near
 * midnight in any other timezone). Branch hours can't cross midnight, so the window is clamped to the
 * current UTC day -- otherwise a late-evening run produced e.g. 23:10 -> 02:10, which the view
 * (correctly) reports as closed.
 */
function hoursAroundNow(beforeMs: number, afterMs: number) {
  const now = new Date();
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayEnd = dayStart + 24 * HOUR - 1000; // 23:59:59
  const hhmmss = (ms: number) => new Date(ms).toISOString().slice(11, 19);
  return {
    dayOfWeek: now.getUTCDay(),
    opensAt: hhmmss(Math.max(now.getTime() - beforeMs, dayStart)),
    closesAt: hhmmss(Math.min(now.getTime() + afterMs, dayEnd)),
    minutesLeftToday: (dayEnd - now.getTime()) / MINUTE,
  };
}

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
  it("reports open when now falls inside today's hours", async (ctx) => {
    const { dayOfWeek, opensAt, closesAt, minutesLeftToday } = hoursAroundNow(HOUR, 2 * HOUR);
    // 'open' needs closing time at least 30 minutes away within the same UTC day.
    if (minutesLeftToday < 35) ctx.skip();
    await admin.from('branch_hours').upsert(
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

  it('reports closing_soon within 30 minutes of close', async (ctx) => {
    const { dayOfWeek, opensAt, closesAt, minutesLeftToday } = hoursAroundNow(
      2 * HOUR,
      10 * MINUTE,
    );
    // Closing 10 minutes from now must still fall within the same UTC day.
    if (minutesLeftToday < 12) ctx.skip();
    await admin.from('branch_hours').upsert(
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

  it('reports closed on a day marked is_closed, even during what would otherwise be open hours', async () => {
    const { dayOfWeek, opensAt, closesAt } = hoursAroundNow(HOUR, 2 * HOUR);
    await admin.from('branch_hours').upsert(
      {
        branch_id: branchId,
        day_of_week: dayOfWeek,
        opens_at: opensAt,
        closes_at: closesAt,
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
    const { dayOfWeek, opensAt, closesAt } = hoursAroundNow(HOUR, 2 * HOUR);
    await admin.from('branch_hours').upsert(
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
    await admin.from('branch_service_prices').insert({
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
