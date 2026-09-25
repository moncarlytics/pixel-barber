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

  it("lets branch A's manager hand-edit a dated row and refuses branch B's manager naming branch B on the row", async () => {
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
    // Branch B's manager naming their OWN branch on a row for branch A's barber -- the attack
    // Finding 1 found: barber_schedule_staff_scoped used to scope only by the row's own
    // branch_id, so this insert passed even though the barber isn't B's to manage.
    const { error: bError } = await f.managerB.client.from('barber_schedule').insert({
      barber_id: f.barber.barberId,
      work_date: '2099-01-08',
      branch_id: f.branchBId,
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

describe('set_barber_weekly_hours', () => {
  // Days 1-4 are used by the tests above (direct table writes); this block uses 0, 5, 6 so it
  // never collides with rows those tests (or the barber-own-read test) depend on.
  it("lets branch A's manager save a batch in one call and the rows land", async () => {
    const { error } = await f.managerA.client.rpc('set_barber_weekly_hours', {
      p_barber_id: f.barber.barberId,
      p_days: [
        {
          day_of_week: 5,
          working: true,
          branch_id: f.branchAId,
          shift_start: '09:00',
          shift_end: '17:00',
        },
        {
          day_of_week: 6,
          working: true,
          branch_id: f.branchAId,
          shift_start: '10:00',
          shift_end: '14:00',
        },
      ],
    });
    expect(error).toBeNull();

    const { data } = await f.admin
      .from('barber_weekly_hours')
      .select('day_of_week')
      .eq('barber_id', f.barber.barberId)
      .in('day_of_week', [5, 6]);
    expect(data ?? []).toHaveLength(2);
  });

  it('rolls back the whole batch when one day names an out-of-scope branch, leaving prior rows untouched', async () => {
    const { data: before } = await f.admin
      .from('barber_weekly_hours')
      .select('day_of_week, branch_id, shift_start, shift_end')
      .eq('barber_id', f.barber.barberId)
      .eq('day_of_week', 5)
      .single();

    const { error } = await f.managerA.client.rpc('set_barber_weekly_hours', {
      p_barber_id: f.barber.barberId,
      p_days: [
        {
          day_of_week: 5,
          working: true,
          branch_id: f.branchAId,
          shift_start: '08:00',
          shift_end: '12:00',
        },
        {
          day_of_week: 0,
          working: true,
          branch_id: f.branchBId,
          shift_start: '09:00',
          shift_end: '17:00',
        },
      ],
    });
    expect(error).not.toBeNull();

    const { data: after } = await f.admin
      .from('barber_weekly_hours')
      .select('day_of_week, branch_id, shift_start, shift_end')
      .eq('barber_id', f.barber.barberId)
      .eq('day_of_week', 5)
      .single();
    expect(after).toEqual(before);

    const { data: dayZero } = await f.admin
      .from('barber_weekly_hours')
      .select('id')
      .eq('barber_id', f.barber.barberId)
      .eq('day_of_week', 0);
    expect(dayZero ?? []).toHaveLength(0);
  });

  it("refuses branch B's manager using it on branch A's barber", async () => {
    const { error } = await f.managerB.client.rpc('set_barber_weekly_hours', {
      p_barber_id: f.barber.barberId,
      p_days: [
        {
          day_of_week: 0,
          working: true,
          branch_id: f.branchAId,
          shift_start: '09:00',
          shift_end: '17:00',
        },
      ],
    });
    expect(error).not.toBeNull();

    const { data: dayZero } = await f.admin
      .from('barber_weekly_hours')
      .select('id')
      .eq('barber_id', f.barber.barberId)
      .eq('day_of_week', 0);
    expect(dayZero ?? []).toHaveLength(0);
  });
});
