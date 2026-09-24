// tests/db/barber-schedule-fill.test.ts
// @vitest-environment node
// fill_barber_schedule materializes a barber's weekly pattern into dated barber_schedule rows
// for today..today+27, protecting hand-edited days, honouring days off, never touching the past,
// and staying idempotent. The last test proves the production unblocker end to end.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupBarberManagementFixture,
  createBarberManagementFixture,
  type BarberManagementFixture,
} from './fixtures/barber-management';

let f: BarberManagementFixture;

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

// A date string's weekday, independent of the machine's timezone (0 = Sunday, like day_of_week).
function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function resetBarber() {
  await f.admin.from('barber_days_off').delete().eq('barber_id', f.barber.barberId);
  await f.admin.from('barber_weekly_hours').delete().eq('barber_id', f.barber.barberId);
  await f.admin.from('barber_schedule').delete().eq('barber_id', f.barber.barberId);
  await f.admin.from('barber_skills').delete().eq('barber_id', f.barber.barberId);
  await f.admin.from('staff_users').update({ is_active: true }).eq('id', f.barber.staffUserId);
}

async function setPattern(days: number[], start = '09:00', end = '17:00') {
  const { error } = await f.admin.from('barber_weekly_hours').insert(
    days.map((day_of_week) => ({
      barber_id: f.barber.barberId,
      day_of_week,
      branch_id: f.branchAId,
      shift_start: start,
      shift_end: end,
    })),
  );
  if (error) throw error;
}

async function rows() {
  const { data, error } = await f.admin
    .from('barber_schedule')
    .select('id, work_date, branch_id, shift_start, shift_end, is_manual')
    .eq('barber_id', f.barber.barberId)
    .order('work_date');
  if (error) throw error;
  return data!;
}

beforeAll(async () => {
  f = await createBarberManagementFixture();
}, 60000);

afterAll(async () => {
  await cleanupBarberManagementFixture(f);
}, 60000);

beforeEach(async () => {
  await resetBarber();
}, 30000);

describe('fill_barber_schedule', () => {
  it('fills exactly 28 consecutive days from a full-week pattern', async () => {
    await setPattern(ALL_DAYS);
    const r = await rows();
    expect(r).toHaveLength(28);
    expect(new Set(r.map((x) => x.work_date)).size).toBe(28);
    expect(r[27].work_date).toBe(addDays(r[0].work_date, 27));
    for (const x of r) {
      expect(x.is_manual).toBe(false);
      expect(x.branch_id).toBe(f.branchAId);
      expect(x.shift_start).toBe('09:00:00');
      expect(x.shift_end).toBe('17:00:00');
    }
  });

  it('leaves pattern days off empty (28 days = exactly 4 of each weekday)', async () => {
    await setPattern([1, 2, 3, 4, 5, 6]);
    const r = await rows();
    expect(r).toHaveLength(24);
    expect(r.some((x) => weekday(x.work_date) === 0)).toBe(false);
  });

  it('protects a hand-edited day when the pattern changes', async () => {
    await setPattern(ALL_DAYS);
    const target = (await rows())[2];
    await f.admin
      .from('barber_schedule')
      .update({ is_manual: true, shift_start: '12:00' })
      .eq('id', target.id);
    await f.admin
      .from('barber_weekly_hours')
      .update({ shift_start: '10:00' })
      .eq('barber_id', f.barber.barberId);
    const r = await rows();
    const edited = r.find((x) => x.work_date === target.work_date)!;
    expect(edited.is_manual).toBe(true);
    expect(edited.shift_start).toBe('12:00:00');
    for (const x of r.filter((x) => x.work_date !== target.work_date)) {
      expect(x.shift_start).toBe('10:00:00');
    }
  });

  it('removes a day off from the schedule and restores it when the day off is deleted', async () => {
    await setPattern(ALL_DAYS);
    const day = (await rows())[5].work_date;
    await f.admin.from('barber_days_off').insert({ barber_id: f.barber.barberId, off_date: day });
    expect((await rows()).some((x) => x.work_date === day)).toBe(false);
    await f.admin
      .from('barber_days_off')
      .delete()
      .eq('barber_id', f.barber.barberId)
      .eq('off_date', day);
    const restored = (await rows()).find((x) => x.work_date === day);
    expect(restored?.shift_start).toBe('09:00:00');
    expect(restored?.is_manual).toBe(false);
  });

  it('lets a day off override a hand-edited day', async () => {
    await setPattern(ALL_DAYS);
    const target = (await rows())[3];
    await f.admin.from('barber_schedule').update({ is_manual: true }).eq('id', target.id);
    await f.admin
      .from('barber_days_off')
      .insert({ barber_id: f.barber.barberId, off_date: target.work_date });
    expect((await rows()).some((x) => x.work_date === target.work_date)).toBe(false);
  });

  it('never touches days before today', async () => {
    await setPattern(ALL_DAYS);
    const today = (await rows())[0].work_date;
    const yesterday = addDays(today, -1);
    await f.admin.from('barber_schedule').insert({
      barber_id: f.barber.barberId,
      work_date: yesterday,
      branch_id: f.branchAId,
      shift_start: '08:00',
      shift_end: '12:00',
    });
    await f.admin
      .from('barber_weekly_hours')
      .update({ shift_start: '10:00' })
      .eq('barber_id', f.barber.barberId);
    const past = (await rows()).find((x) => x.work_date === yesterday);
    expect(past?.shift_start).toBe('08:00:00');
  });

  it('is idempotent', async () => {
    await setPattern(ALL_DAYS);
    const before = await rows();
    const { error } = await f.admin.rpc('fill_barber_schedule', { p_barber_id: f.barber.barberId });
    expect(error).toBeNull();
    expect(await rows()).toEqual(before);
  });

  it('skips inactive staff', async () => {
    await setPattern(ALL_DAYS);
    await f.admin.from('staff_users').update({ is_active: false }).eq('id', f.barber.staffUserId);
    await f.admin.from('barber_schedule').delete().eq('barber_id', f.barber.barberId);
    await f.admin.rpc('fill_barber_schedule', { p_barber_id: f.barber.barberId });
    expect(await rows()).toHaveLength(0);
  });

  it('nightly run leaves barbers who have no pattern alone', async () => {
    // No pattern at all; a directly inserted row (like every pre-existing fixture) must survive a
    // no-argument (nightly-style) run.
    const today = new Date().toISOString().slice(0, 10);
    await f.admin.from('barber_schedule').insert({
      barber_id: f.barber.barberId,
      work_date: today,
      branch_id: f.branchAId,
      shift_start: '09:00',
      shift_end: '17:00',
    });
    const { error } = await f.admin.rpc('fill_barber_schedule');
    expect(error).toBeNull();
    expect((await rows()).some((x) => x.work_date === today)).toBe(true);
  });

  it('refuses every client role executing fill_barber_schedule directly', async () => {
    const { error } = await f.managerA.client.rpc('fill_barber_schedule', {
      p_barber_id: f.barber.barberId,
    });
    expect(error).not.toBeNull();
  });
});

describe('reset_barber_schedule_day', () => {
  it('restores a hand-edited day to the pattern', async () => {
    await setPattern(ALL_DAYS);
    const target = (await rows())[4];
    await f.admin
      .from('barber_schedule')
      .update({ is_manual: true, shift_start: '12:00' })
      .eq('id', target.id);
    const { error } = await f.managerA.client.rpc('reset_barber_schedule_day', {
      p_barber_id: f.barber.barberId,
      p_date: target.work_date,
    });
    expect(error).toBeNull();
    const restored = (await rows()).find((x) => x.work_date === target.work_date)!;
    expect(restored.is_manual).toBe(false);
    expect(restored.shift_start).toBe('09:00:00');
  });

  it('clears a day off and restores the pattern day', async () => {
    await setPattern(ALL_DAYS);
    const day = (await rows())[6].work_date;
    await f.admin.from('barber_days_off').insert({ barber_id: f.barber.barberId, off_date: day });
    const { error } = await f.managerA.client.rpc('reset_barber_schedule_day', {
      p_barber_id: f.barber.barberId,
      p_date: day,
    });
    expect(error).toBeNull();
    expect((await rows()).some((x) => x.work_date === day)).toBe(true);
    const { data: offRows } = await f.admin
      .from('barber_days_off')
      .select('off_date')
      .eq('barber_id', f.barber.barberId);
    expect(offRows ?? []).toHaveLength(0);
  });

  it('refuses a manager outside the barber home branch', async () => {
    await setPattern(ALL_DAYS);
    const day = (await rows())[1].work_date;
    const { error } = await f.managerB.client.rpc('reset_barber_schedule_day', {
      p_barber_id: f.barber.barberId,
      p_date: day,
    });
    expect(error).not.toBeNull();
  });

  it('refuses a past date', async () => {
    await setPattern(ALL_DAYS);
    const yesterday = addDays((await rows())[0].work_date, -1);
    const { error } = await f.managerA.client.rpc('reset_barber_schedule_day', {
      p_barber_id: f.barber.barberId,
      p_date: yesterday,
    });
    expect(error).not.toBeNull();
  });
});

describe('production unblocker', () => {
  it('a pattern and skill set by a real manager session make the barber assignable', async () => {
    const { error: patternError } = await f.managerA.client.from('barber_weekly_hours').insert(
      ALL_DAYS.map((day_of_week) => ({
        barber_id: f.barber.barberId,
        day_of_week,
        branch_id: f.branchAId,
        shift_start: '00:00',
        shift_end: '23:59:59',
      })),
    );
    expect(patternError).toBeNull();
    const { error: skillError } = await f.managerA.client
      .from('barber_skills')
      .insert({ barber_id: f.barber.barberId, service_id: f.serviceId });
    expect(skillError).toBeNull();

    const { data, error } = await f.admin.rpc('find_eligible_barber', {
      p_branch_id: f.branchAId,
      p_branch_service_id: f.branchServiceAId,
      p_preferred_barber_id: f.barber.barberId,
    });
    expect(error).toBeNull();
    expect(data![0].preferred_eligible).toBe(true);
    expect(data![0].fallback_barber_id).toBe(f.barber.barberId);
  });
});
