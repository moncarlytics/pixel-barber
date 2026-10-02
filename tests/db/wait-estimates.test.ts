// tests/db/wait-estimates.test.ts
// @vitest-environment node
// Real wait estimates (part 3, Section 3) on barber B's line (no break): set durations widen ±20%,
// appointments due before a ticket's turn add their time ("any barber" ones shared across the
// skilled barbers on shift), the in-service remainder, historical durations, the Join Now preview,
// recalculate_positions refreshing, and estimate-only updates leaving `version` alone.
// The 30-minute service has no history unless a test inserts barber_service_stats.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  createAppointmentFixture,
  deleteBranchAppointments,
  type AppointmentFixture,
} from './fixtures/appointments';

let f: AppointmentFixture;
const barberB = () => f.barberB.barberId;

async function resetQueue() {
  const { data: tickets } = await f.admin
    .from('queue_tickets')
    .select('id')
    .eq('branch_id', f.branchId);
  const ids = (tickets ?? []).map((t) => t.id);
  if (ids.length > 0) {
    await f.admin.from('service_sessions').delete().in('ticket_id', ids);
    await f.admin.from('queue_events').delete().in('ticket_id', ids);
    await f.admin.from('notifications').delete().in('related_ticket_id', ids);
    await f.admin.from('queue_tickets').delete().in('id', ids);
  }
  await deleteBranchAppointments(f.admin, [f.branchId]);
  await f.admin.from('barber_service_stats').delete().eq('barber_id', barberB());
}

async function seedTicket(
  customerIdx: number,
  state: 'called' | 'almost_turn' | 'waiting' | 'in_service',
  position: number | null,
) {
  const { data, error } = await f.admin
    .from('queue_tickets')
    .insert({
      ticket_number: `PB-WE-${f.suffix}-${customerIdx}`,
      branch_id: f.branchId,
      customer_id: f.customers[customerIdx].customerId,
      branch_service_id: f.branchServiceId,
      assigned_barber_id: barberB(),
      state,
      position,
      created_by: 'customer',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

/** c0 called (position 1), c1 almost_turn (2), c2 waiting (3), all on barber B. */
async function seedLine() {
  await seedTicket(0, 'called', 1);
  const t1 = await seedTicket(1, 'almost_turn', 2);
  const t2 = await seedTicket(2, 'waiting', 3);
  return { t1, t2 };
}

async function appointmentIn(minutes: number, barberId: string | null) {
  const start = new Date(Date.now() + minutes * 60_000);
  const { error } = await f.admin.from('appointments').insert({
    customer_id: f.customers[3].customerId,
    branch_id: f.branchId,
    branch_service_id: f.branchServiceId,
    preferred_barber_id: barberId,
    scheduled_start: start.toISOString(),
    scheduled_end: new Date(start.getTime() + 30 * 60_000).toISOString(),
    status: 'scheduled',
    created_by: 'customer',
  });
  if (error) throw error;
}

async function refresh() {
  const { error } = await f.admin.rpc('refresh_wait_estimates', {
    p_branch_id: f.branchId,
    p_barber_id: barberB(),
  });
  if (error) throw error;
}

async function estimate(id: string) {
  const { data, error } = await f.admin
    .from('queue_tickets')
    .select('estimated_wait_low_min, estimated_wait_high_min, version')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

beforeAll(async () => {
  f = await createAppointmentFixture();
}, 90000);

beforeEach(async () => {
  await resetQueue();
});

afterAll(async () => {
  await resetQueue();
  await cleanupAppointmentFixture(f);
}, 90000);

describe('refresh_wait_estimates', () => {
  it('adds up the line with set durations widened ±20%', async () => {
    const { t1, t2 } = await seedLine();
    await refresh();
    expect(await estimate(t1)).toMatchObject({
      estimated_wait_low_min: 24,
      estimated_wait_high_min: 36,
    });
    expect(await estimate(t2)).toMatchObject({
      estimated_wait_low_min: 48,
      estimated_wait_high_min: 72,
    });
  });

  it("counts an appointment due before a ticket's turn, but not one due after", async () => {
    const { t1, t2 } = await seedLine();
    await appointmentIn(45, barberB());
    await refresh();
    // t1's turn is 30 min away (before the appointment); t2's is 60 min away (after it).
    expect(await estimate(t1)).toMatchObject({
      estimated_wait_low_min: 24,
      estimated_wait_high_min: 36,
    });
    expect(await estimate(t2)).toMatchObject({
      estimated_wait_low_min: 72,
      estimated_wait_high_min: 108,
    });
  });

  it('ignores an appointment due after everyone in line', async () => {
    const { t2 } = await seedLine();
    await appointmentIn(180, barberB());
    await refresh();
    expect(await estimate(t2)).toMatchObject({
      estimated_wait_low_min: 48,
      estimated_wait_high_min: 72,
    });
  });

  it('shares an "any barber" appointment across the skilled barbers on shift', async () => {
    const { t2 } = await seedLine();
    await appointmentIn(45, null);
    await refresh();
    // Barbers A and B are both on shift: 30 / 2 = 15 extra minutes → T = 75.
    expect(await estimate(t2)).toMatchObject({
      estimated_wait_low_min: 60,
      estimated_wait_high_min: 90,
    });
  });

  it('starts from what is left of the haircut in progress', async () => {
    const serving = await seedTicket(0, 'in_service', null);
    const { error } = await f.admin.from('service_sessions').insert({
      ticket_id: serving,
      barber_id: barberB(),
      started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    if (error) throw error;
    const t1 = await seedTicket(1, 'waiting', 1);
    await refresh();
    // 30 − 10 = 20 minutes left → 16–24.
    expect(await estimate(t1)).toMatchObject({
      estimated_wait_low_min: 16,
      estimated_wait_high_min: 24,
    });
  });

  it("uses the barber's own average once they have 5 completed services, exactly", async () => {
    const { error } = await f.admin.from('barber_service_stats').insert({
      barber_id: barberB(),
      service_id: f.serviceId,
      completed_count: 5,
      avg_duration_seconds: 1200,
    });
    if (error) throw error;
    const { t1, t2 } = await seedLine();
    await refresh();
    expect(await estimate(t1)).toMatchObject({
      estimated_wait_low_min: 20,
      estimated_wait_high_min: 20,
    });
    expect(await estimate(t2)).toMatchObject({
      estimated_wait_low_min: 40,
      estimated_wait_high_min: 40,
    });
  });

  it('does not bump the ticket version when only the estimate changes', async () => {
    const { t2 } = await seedLine();
    await refresh();
    const before = await estimate(t2);
    await appointmentIn(45, barberB());
    await refresh();
    const after = await estimate(t2);
    expect(after.estimated_wait_low_min).toBe(72);
    expect(after.version).toBe(before.version);
  });

  it('is refreshed by recalculate_positions', async () => {
    const { t1 } = await seedLine();
    const { error } = await f.admin.rpc('recalculate_positions', {
      p_branch_id: f.branchId,
      p_barber_id: barberB(),
    });
    if (error) throw error;
    expect(await estimate(t1)).toMatchObject({
      estimated_wait_low_min: 24,
      estimated_wait_high_min: 36,
    });
  });
});

describe('preview_wait_estimate', () => {
  it("gives a newcomer's wait at the end of the chosen barber's line", async () => {
    await seedLine();
    await appointmentIn(45, barberB());
    const { data, error } = await f.customers[3].client.rpc('preview_wait_estimate', {
      p_branch_service_id: f.branchServiceId,
      p_barber_id: barberB(),
    });
    expect(error).toBeNull();
    // 30 (called) + 30 + 30 (line) + 30 (appointment due at 45 min) = 120 → 96–144.
    expect(data).toEqual([{ low_min: 96, high_min: 144 }]);
  });

  it('uses the next available barber when none is chosen', async () => {
    await seedLine();
    const { data, error } = await f.customers[3].client.rpc('preview_wait_estimate', {
      p_branch_service_id: f.branchServiceId,
      p_barber_id: null,
    });
    expect(error).toBeNull();
    // Barber A has nobody in line.
    expect(data).toEqual([{ low_min: 0, high_min: 0 }]);
  });
});
