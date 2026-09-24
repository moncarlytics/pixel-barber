// tests/db/barber-schedule-permissions.test.ts
// @vitest-environment node
// Barbers Management permissions: pattern/day-off/dated-row/skill writes are scoped to the
// barber's home branch (never a client-supplied column), barbers read only their own rows,
// customers read nothing, and barber names are exposed only via list_manageable_barbers().
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupBarberManagementFixture,
  createBarberManagementFixture,
  type BarberManagementFixture,
} from './fixtures/barber-management';

let f: BarberManagementFixture;

beforeAll(async () => {
  f = await createBarberManagementFixture();
}, 60000);

afterAll(async () => {
  await cleanupBarberManagementFixture(f);
}, 60000);

describe('barber schedule permissions', () => {
  it("lets branch A's manager write the barber's weekly pattern", async () => {
    const { error } = await f.managerA.client.from('barber_weekly_hours').insert({
      barber_id: f.barber.barberId,
      day_of_week: 1,
      branch_id: f.branchAId,
      shift_start: '09:00',
      shift_end: '17:00',
    });
    expect(error).toBeNull();
  });

  it("refuses branch B's manager, even when naming branch B on the row", async () => {
    const { error } = await f.managerB.client.from('barber_weekly_hours').insert({
      barber_id: f.barber.barberId,
      day_of_week: 2,
      branch_id: f.branchBId,
      shift_start: '09:00',
      shift_end: '17:00',
    });
    expect(error).not.toBeNull();
  });

  it("refuses branch A's manager scheduling the barber at a branch outside their scope", async () => {
    const { error } = await f.managerA.client.from('barber_weekly_hours').insert({
      barber_id: f.barber.barberId,
      day_of_week: 3,
      branch_id: f.branchBId,
      shift_start: '09:00',
      shift_end: '17:00',
    });
    expect(error).not.toBeNull();
  });

  it('rejects an end time before the start time', async () => {
    const { error } = await f.managerA.client.from('barber_weekly_hours').insert({
      barber_id: f.barber.barberId,
      day_of_week: 4,
      branch_id: f.branchAId,
      shift_start: '17:00',
      shift_end: '09:00',
    });
    expect(error).not.toBeNull();
  });

  it('scopes days off to the barber home branch', async () => {
    const { error: aError } = await f.managerA.client
      .from('barber_days_off')
      .insert({ barber_id: f.barber.barberId, off_date: '2099-01-05' });
    expect(aError).toBeNull();
    const { error: bError } = await f.managerB.client
      .from('barber_days_off')
      .insert({ barber_id: f.barber.barberId, off_date: '2099-01-06' });
    expect(bError).not.toBeNull();
    await f.admin.from('barber_days_off').delete().eq('barber_id', f.barber.barberId);
  });

  it("lets branch A's manager hand-edit a dated row and refuses branch B's", async () => {
    const { error: aError } = await f.managerA.client.from('barber_schedule').upsert(
      {
        barber_id: f.barber.barberId,
        work_date: '2099-01-07',
        branch_id: f.branchAId,
        shift_start: '10:00',
        shift_end: '15:00',
        is_manual: true,
      },
      { onConflict: 'barber_id,work_date' },
    );
    expect(aError).toBeNull();
    const { error: bError } = await f.managerB.client.from('barber_schedule').insert({
      barber_id: f.barber.barberId,
      work_date: '2099-01-08',
      branch_id: f.branchAId,
      shift_start: '10:00',
      shift_end: '15:00',
      is_manual: true,
    });
    expect(bError).not.toBeNull();
  });

  it("lets branch A's manager set skills and refuses branch B's", async () => {
    const { error: aError } = await f.managerA.client
      .from('barber_skills')
      .insert({ barber_id: f.barber.barberId, service_id: f.serviceId });
    expect(aError).toBeNull();
    const { error: bError } = await f.managerB.client
      .from('barber_skills')
      .insert({ barber_id: f.barber.barberId, service_id: f.otherServiceId });
    expect(bError).not.toBeNull();
  });

  it('lets the barber read their own pattern and the customer read none', async () => {
    const { data: barberRows, error: barberError } = await f.barber.client
      .from('barber_weekly_hours')
      .select('day_of_week')
      .eq('barber_id', f.barber.barberId);
    expect(barberError).toBeNull();
    expect(barberRows!.length).toBeGreaterThan(0);

    const { data: customerRows } = await f.customer.client
      .from('barber_weekly_hours')
      .select('day_of_week')
      .eq('barber_id', f.barber.barberId);
    expect(customerRows ?? []).toHaveLength(0);
  });

  it('exposes barber names only to managers in scope, via list_manageable_barbers', async () => {
    const { data: aRows, error: aError } = await f.managerA.client.rpc('list_manageable_barbers');
    expect(aError).toBeNull();
    const mine = (aRows ?? []).find((r) => r.barber_id === f.barber.barberId);
    expect(mine?.name).toBe(f.barber.name);
    expect(mine?.home_branch_id).toBe(f.branchAId);

    const { data: bRows } = await f.managerB.client.rpc('list_manageable_barbers');
    expect((bRows ?? []).some((r) => r.barber_id === f.barber.barberId)).toBe(false);

    const { data: customerRows } = await f.customer.client.rpc('list_manageable_barbers');
    expect(customerRows ?? []).toHaveLength(0);
  });
});
