// tests/db/today-dashboard.test.ts
// @vitest-environment node
// Today dashboard (Docs/superpowers/specs/2026-10-08-reports-dashboard-design.md, Section 1):
// branch_today's right-now and so-far-today counts, ratings only for report viewers, the long-wait
// warning, access (view_branch_dashboard + branch scope) and set_long_wait_warning.
// The "appointment still to come" is booked for 23:30 UTC today; running this file after ~23:15 UTC
// may see it already activated by the every-minute appointment job.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@pixel-barber/shared';
import {
  cleanupAppointmentFixture,
  cleanupStaffLogin,
  createAppointmentFixture,
  createStaffLogin,
  dateAt,
  type AppointmentFixture,
} from './fixtures/appointments';

type TicketInsert = Database['public']['Tables']['queue_tickets']['Insert'];
type Today = {
  now: Record<string, number>;
  today: Record<string, number | null>;
  ratings: { count: number; average: number | null } | null;
  long_wait: { threshold_min: number; current_avg_wait_min: number | null; alert: boolean };
  updated_at: string;
};

let f: AppointmentFixture;
let manager: Awaited<ReturnType<typeof createStaffLogin>>;
let reception: Awaited<ReturnType<typeof createStaffLogin>>;
let otherManager: Awaited<ReturnType<typeof createStaffLogin>>;
const MIN = 60_000;

const minutesAgo = (n: number) => new Date(Date.now() - n * MIN).toISOString();
/** HH:MM UTC today (may be later than now; the "so far today" counts only look at the date). */
const todayAt = (hhmm: string) => `${dateAt(0)}T${hhmm}:00.000Z`;

async function ticket(
  label: string,
  customerIdx: number,
  fields: Omit<
    TicketInsert,
    'ticket_number' | 'branch_id' | 'customer_id' | 'branch_service_id' | 'created_by'
  >,
) {
  const { data, error } = await f.admin
    .from('queue_tickets')
    .insert({
      ticket_number: `PB-TD-${f.suffix}-${label}`,
      branch_id: f.branchId,
      customer_id: f.customers[customerIdx].customerId,
      branch_service_id: f.branchServiceId,
      created_by: 'customer',
      ...fields,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

async function today(client = manager.client) {
  const { data, error } = await client.rpc('branch_today', { p_branch_id: f.branchId });
  if (error) throw error;
  return data as unknown as Today;
}

beforeAll(async () => {
  f = await createAppointmentFixture();
  manager = await createStaffLogin(f, 'tdm', 'branch_manager', f.branchId);
  reception = await createStaffLogin(f, 'tdr', 'receptionist', f.branchId);
  otherManager = await createStaffLogin(f, 'tdo', 'branch_manager', f.closedBranchId);

  // Right now: one waiting (30 min), one called (40 min), one in service.
  await ticket('w', 0, { state: 'waiting', created_at: minutesAgo(30) });
  await ticket('c', 1, { state: 'called', created_at: minutesAgo(40), called_at: minutesAgo(2) });
  await ticket('s', 2, {
    state: 'in_service',
    assigned_barber_id: f.barberA.barberId,
    created_at: minutesAgo(60),
    service_started_at: minutesAgo(10),
  });
  // So far today: a walk-in (wait 20, haircut 30), an appointment ticket (wait 10, haircut 30),
  // a no-show and a cancellation.
  const walkIn = await ticket('d1', 3, {
    state: 'completed',
    assigned_barber_id: f.barberB.barberId,
    created_at: todayAt('00:00'),
    service_started_at: todayAt('00:20'),
    completed_at: todayAt('00:50'),
  });
  const { data: converted, error: apptError } = await f.admin
    .from('appointments')
    .insert({
      customer_id: f.customers[3].customerId,
      branch_id: f.branchId,
      branch_service_id: f.branchServiceId,
      scheduled_start: todayAt('01:00'),
      scheduled_end: todayAt('01:30'),
      status: 'converted',
      created_by: 'customer',
    })
    .select('id')
    .single();
  if (apptError) throw apptError;
  await ticket('d2', 3, {
    state: 'completed',
    appointment_id: converted.id,
    assigned_barber_id: f.barberB.barberId,
    created_at: todayAt('01:00'),
    service_started_at: todayAt('01:10'),
    completed_at: todayAt('01:40'),
  });
  await ticket('d3', 3, {
    state: 'no_show',
    created_at: todayAt('02:00'),
    no_show_at: todayAt('02:15'),
  });
  await ticket('d4', 3, {
    state: 'cancelled',
    created_at: todayAt('02:30'),
    cancelled_at: todayAt('02:35'),
    cancel_reason: 'changed_plans',
  });
  const { error: fbError } = await f.admin.from('feedback').insert({
    ticket_id: walkIn,
    customer_id: f.customers[3].customerId,
    branch_id: f.branchId,
    barber_id: f.barberB.barberId,
    overall_rating: 3,
  });
  if (fbError) throw fbError;
  // Still to come today.
  const { error: laterError } = await f.admin.from('appointments').insert({
    customer_id: f.customers[0].customerId,
    branch_id: f.branchId,
    branch_service_id: f.branchServiceId,
    scheduled_start: todayAt('23:30'),
    scheduled_end: todayAt('23:59'),
    status: 'scheduled',
    created_by: 'customer',
  });
  if (laterError) throw laterError;
  // Barber A available (fixture default), barber B busy.
  const { error: busyError } = await f.admin
    .from('barbers')
    .update({ status: 'busy' })
    .eq('id', f.barberB.barberId);
  if (busyError) throw busyError;
}, 120000);

afterAll(async () => {
  await cleanupStaffLogin(f, manager);
  await cleanupStaffLogin(f, reception);
  await cleanupStaffLogin(f, otherManager);
  await cleanupAppointmentFixture(f);
}, 90000);

describe('branch_today', () => {
  it('counts right now, so far today and ratings for a branch manager', async () => {
    const d = await today();
    expect(d.now).toEqual({
      waiting: 1,
      called: 1,
      in_service: 1,
      appointments_to_come: 1,
      barbers_available: 1,
      barbers_busy: 1,
    });
    expect(d.today).toEqual({
      served: 2,
      walk_ins: 1,
      appointments: 1,
      no_shows: 1,
      cancellations: 1,
      avg_wait_min: 15,
      avg_service_min: 30,
    });
    expect(d.ratings).toEqual({ count: 1, average: 3 });
    expect(typeof d.updated_at).toBe('string');
  });

  it('warns when the people waiting have waited longer than the branch setting', async () => {
    const d = await today();
    expect(d.long_wait.threshold_min).toBe(20);
    expect(d.long_wait.current_avg_wait_min).toBeGreaterThanOrEqual(35);
    expect(d.long_wait.current_avg_wait_min).toBeLessThanOrEqual(36);
    expect(d.long_wait.alert).toBe(true);
  });

  it('gives receptionists the dashboard without ratings', async () => {
    const d = await today(reception.client);
    expect(d.now.waiting).toBe(1);
    expect(d.ratings).toBeNull();
  });

  it('refuses barbers and managers of other branches', async () => {
    for (const client of [f.barberClient, otherManager.client]) {
      const { error } = await client.rpc('branch_today', { p_branch_id: f.branchId });
      expect(error?.message).toBe('not_allowed');
    }
  });
});

describe('set_long_wait_warning', () => {
  it('refuses receptionists and out-of-range values', async () => {
    expect(
      (
        await reception.client.rpc('set_long_wait_warning', {
          p_branch_id: f.branchId,
          p_minutes: 30,
        })
      ).error?.message,
    ).toBe('not_allowed');
    for (const minutes of [4, 181]) {
      const { error } = await manager.client.rpc('set_long_wait_warning', {
        p_branch_id: f.branchId,
        p_minutes: minutes,
      });
      expect(error?.message).toBe('invalid_minutes');
    }
  });

  it('lets a branch manager raise the limit, which clears the warning', async () => {
    const { error } = await manager.client.rpc('set_long_wait_warning', {
      p_branch_id: f.branchId,
      p_minutes: 60,
    });
    expect(error).toBeNull();
    const { data: row } = await f.admin
      .from('branches')
      .select('long_wait_warning_minutes')
      .eq('id', f.branchId)
      .single();
    expect(row!.long_wait_warning_minutes).toBe(60);
    const d = await today();
    expect(d.long_wait).toMatchObject({ threshold_min: 60, alert: false });
  });
});
