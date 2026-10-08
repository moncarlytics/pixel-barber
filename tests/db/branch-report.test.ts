// tests/db/branch-report.test.ts
// @vitest-environment node
// Reports (Docs/superpowers/specs/2026-10-08-reports-dashboard-design.md, Section 2): every section
// of branch_report against a seeded three-day range with known answers, the all-branches
// comparison, empty ranges, range limits and access.
//
// Seed (Main branch unless noted; D1..D3 = 10, 9, 8 days ago; prices: Service 50 then 60 from D2;
// Beard 40, promo 30 on D3 only):
//   T0  D-20 cust0 Service  completed                          (before the range: cust0 returns)
//   T1  D1 10:00 cust0 Service  barber A walk-in  wait 20 cut 30  50  rated 4
//   T2  D1 10:30 cust1 Beard    barber B walk-in  wait 30 cut 20  40  rated 2
//   T3  D2 14:00 cust2 Service  barber A appointment wait 10 cut 30  60
//   T4  D2 14:15 cust3 Service  barber B no-show
//   T5  D3 10:05 cust0 Beard    barber A cancelled wait_too_long
//   T6  D3 10:45 cust1 Service  barber A cancelled cant_make_it
//   T7  D3 15:00 cust2 Beard    no barber cancelled (no reason -> other)
//   T8  D3 15:30 cust3 Beard    barber B walk-in  wait 10 cut 20  30 (promo)  rated 5
//   T9  D-7  cust1 Service completed                           (after the range: excluded)
//   T10 D2 12:00 cust0 Closed branch, barber A, wait 5 cut 30, no price
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Report = Record<string, any>;

let f: AppointmentFixture;
let manager: Awaited<ReturnType<typeof createStaffLogin>>;
let reception: Awaited<ReturnType<typeof createStaffLogin>>;
let analyst: Awaited<ReturnType<typeof createStaffLogin>>;
let beardServiceId: string;
let beardBs: string;
const D1 = dateAt(-10);
const D2 = dateAt(-9);
const D3 = dateAt(-8);
const at = (day: string, hhmm: string) => `${day}T${hhmm}:00.000Z`;

async function ticket(label: string, fields: Omit<TicketInsert, 'ticket_number' | 'created_by'>) {
  const { data, error } = await f.admin
    .from('queue_tickets')
    .insert({ ticket_number: `PB-RP-${f.suffix}-${label}`, created_by: 'customer', ...fields })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

async function rate(ticketId: string, customerIdx: number, barberId: string, overall: number) {
  const { error } = await f.admin.from('feedback').insert({
    ticket_id: ticketId,
    customer_id: f.customers[customerIdx].customerId,
    branch_id: f.branchId,
    barber_id: barberId,
    overall_rating: overall,
  });
  if (error) throw error;
}

async function report(client: typeof manager.client, ids: string[], from: string, to: string) {
  return client.rpc('branch_report', { p_branch_ids: ids, p_from: from, p_to: to });
}

beforeAll(async () => {
  f = await createAppointmentFixture();
  manager = await createStaffLogin(f, 'rpm', 'branch_manager', f.branchId);
  reception = await createStaffLogin(f, 'rpr', 'receptionist', f.branchId);
  analyst = await createStaffLogin(f, 'rpa', 'analyst', [f.branchId, f.closedBranchId]);

  const { data: business } = await f.admin.from('businesses').select('id').limit(1).single();
  const { data: beard, error: beardError } = await f.admin
    .from('services')
    .insert({
      business_id: business!.id,
      name: `Appt Beard ${f.suffix}`,
      default_duration_minutes: 20,
    })
    .select('id')
    .single();
  if (beardError) throw beardError;
  beardServiceId = beard.id;
  const { data: bs2, error: bs2Error } = await f.admin
    .from('branch_services')
    .insert({ branch_id: f.branchId, service_id: beard.id })
    .select('id')
    .single();
  if (bs2Error) throw bs2Error;
  beardBs = bs2.id;
  const { error: priceError } = await f.admin.from('branch_service_prices').insert([
    {
      branch_service_id: f.branchServiceId,
      price_ghs: 50,
      is_promo: false,
      effective_from: dateAt(-30),
    },
    { branch_service_id: f.branchServiceId, price_ghs: 60, is_promo: false, effective_from: D2 },
    { branch_service_id: beardBs, price_ghs: 40, is_promo: false, effective_from: dateAt(-30) },
    {
      branch_service_id: beardBs,
      price_ghs: 30,
      is_promo: true,
      effective_from: D3,
      effective_until: D3,
    },
  ]);
  if (priceError) throw priceError;
  const { data: appt, error: apptError } = await f.admin
    .from('appointments')
    .insert({
      customer_id: f.customers[2].customerId,
      branch_id: f.branchId,
      branch_service_id: f.branchServiceId,
      scheduled_start: at(D2, '14:00'),
      scheduled_end: at(D2, '14:30'),
      status: 'converted',
      created_by: 'customer',
    })
    .select('id')
    .single();
  if (apptError) throw apptError;

  const main = { branch_id: f.branchId };
  const svc = { branch_service_id: f.branchServiceId };
  const brd = { branch_service_id: beardBs };
  const A = f.barberA.barberId;
  const B = f.barberB.barberId;
  const c = (i: number) => f.customers[i].customerId;
  const done = (day: string, created: string, started: string, completed: string) => ({
    state: 'completed' as const,
    created_at: at(day, created),
    service_started_at: at(day, started),
    completed_at: at(day, completed),
  });

  await ticket('t0', {
    ...main,
    ...svc,
    customer_id: c(0),
    assigned_barber_id: A,
    ...done(dateAt(-20), '10:00', '10:10', '10:40'),
  });
  const t1 = await ticket('t1', {
    ...main,
    ...svc,
    customer_id: c(0),
    assigned_barber_id: A,
    ...done(D1, '10:00', '10:20', '10:50'),
  });
  const t2 = await ticket('t2', {
    ...main,
    ...brd,
    customer_id: c(1),
    assigned_barber_id: B,
    ...done(D1, '10:30', '11:00', '11:20'),
  });
  await ticket('t3', {
    ...main,
    ...svc,
    customer_id: c(2),
    assigned_barber_id: A,
    appointment_id: appt.id,
    ...done(D2, '14:00', '14:10', '14:40'),
  });
  await ticket('t4', {
    ...main,
    ...svc,
    customer_id: c(3),
    assigned_barber_id: B,
    state: 'no_show',
    created_at: at(D2, '14:15'),
    no_show_at: at(D2, '14:30'),
  });
  await ticket('t5', {
    ...main,
    ...brd,
    customer_id: c(0),
    assigned_barber_id: A,
    state: 'cancelled',
    created_at: at(D3, '10:05'),
    cancelled_at: at(D3, '10:10'),
    cancel_reason: 'wait_too_long',
  });
  await ticket('t6', {
    ...main,
    ...svc,
    customer_id: c(1),
    assigned_barber_id: A,
    state: 'cancelled',
    created_at: at(D3, '10:45'),
    cancelled_at: at(D3, '10:50'),
    cancel_reason: 'cant_make_it',
  });
  await ticket('t7', {
    ...main,
    ...brd,
    customer_id: c(2),
    state: 'cancelled',
    created_at: at(D3, '15:00'),
    cancelled_at: at(D3, '15:05'),
  });
  const t8 = await ticket('t8', {
    ...main,
    ...brd,
    customer_id: c(3),
    assigned_barber_id: B,
    ...done(D3, '15:30', '15:40', '16:00'),
  });
  await ticket('t9', {
    ...main,
    ...svc,
    customer_id: c(1),
    assigned_barber_id: A,
    ...done(dateAt(-7), '10:00', '10:10', '10:40'),
  });
  await ticket('t10', {
    branch_id: f.closedBranchId,
    branch_service_id: f.closedBranchServiceId,
    customer_id: c(0),
    assigned_barber_id: A,
    ...done(D2, '12:00', '12:05', '12:35'),
  });
  await rate(t1, 0, A, 4);
  await rate(t2, 1, B, 2);
  await rate(t8, 3, B, 5);
}, 120000);

afterAll(async () => {
  await cleanupStaffLogin(f, manager);
  await cleanupStaffLogin(f, reception);
  await cleanupStaffLogin(f, analyst);
  await cleanupAppointmentFixture(f);
  const { error } = await f.admin.from('services').delete().eq('id', beardServiceId);
  if (error) throw error;
}, 90000);

describe('branch_report for one branch', () => {
  let r: Report;
  beforeAll(async () => {
    const { data, error } = await report(manager.client, [f.branchId], D1, D3);
    if (error) throw error;
    r = data as Report;
  });

  it('summarises the range', () => {
    expect(r.summary).toEqual({
      served: 4,
      walk_ins: 3,
      appointments: 1,
      no_shows: 1,
      no_show_rate: 20,
      cancellations: 3,
      cancellation_rate: 37.5,
      avg_wait_min: 18,
      median_wait_min: 15,
      avg_service_min: 25,
      rating_count: 3,
      rating_average: 3.67,
      est_takings_ghs: 180,
      returning_rate: 25,
    });
  });

  it('lists every day', () => {
    expect(r.daily).toEqual([
      {
        date: D1,
        served: 2,
        walk_ins: 2,
        appointments: 0,
        no_shows: 0,
        cancellations: 0,
        avg_wait_min: 25,
        avg_service_min: 25,
        rating_average: 3,
        est_takings_ghs: 90,
      },
      {
        date: D2,
        served: 1,
        walk_ins: 0,
        appointments: 1,
        no_shows: 1,
        cancellations: 0,
        avg_wait_min: 10,
        avg_service_min: 30,
        rating_average: null,
        est_takings_ghs: 60,
      },
      {
        date: D3,
        served: 1,
        walk_ins: 1,
        appointments: 0,
        no_shows: 0,
        cancellations: 3,
        avg_wait_min: 10,
        avg_service_min: 20,
        rating_average: 5,
        est_takings_ghs: 30,
      },
    ]);
  });

  it('shows the busiest hours', () => {
    expect(r.hours).toEqual([
      { hour: 10, avg_joined_per_day: 1.3, avg_wait_min: 25 },
      { hour: 14, avg_joined_per_day: 0.7, avg_wait_min: 10 },
      { hour: 15, avg_joined_per_day: 0.7, avg_wait_min: 10 },
    ]);
  });

  it('breaks down barbers, services and cancellation reasons', () => {
    expect(r.barbers).toEqual([
      {
        barber_id: f.barberA.barberId,
        name: 'Appt Barber a',
        served: 2,
        avg_service_min: 30,
        no_shows: 0,
        rating_average: 4,
        est_takings_ghs: 110,
      },
      {
        barber_id: f.barberB.barberId,
        name: 'Appt Barber b',
        served: 2,
        avg_service_min: 20,
        no_shows: 1,
        rating_average: 3.5,
        est_takings_ghs: 70,
      },
    ]);
    expect(r.services).toEqual([
      {
        name: `Appt Beard ${f.suffix}`,
        served: 2,
        share: 50,
        avg_service_min: 20,
        listed_duration_min: 20,
        est_takings_ghs: 70,
      },
      {
        name: `Appt Service ${f.suffix}`,
        served: 2,
        share: 50,
        avg_service_min: 30,
        listed_duration_min: 30,
        est_takings_ghs: 110,
      },
    ]);
    expect(r.cancel_reasons).toEqual([
      { reason: 'cant_make_it', count: 1 },
      { reason: 'other', count: 1 },
      { reason: 'wait_too_long', count: 1 },
    ]);
    expect(r.branches).toBeNull();
  });

  it('returns zeros and empty lists for a range without visits', async () => {
    const { data, error } = await report(manager.client, [f.branchId], dateAt(-60), dateAt(-58));
    expect(error).toBeNull();
    const e = data as Report;
    expect(e.summary).toMatchObject({
      served: 0,
      cancellations: 0,
      est_takings_ghs: 0,
      avg_wait_min: null,
      rating_average: null,
      no_show_rate: null,
      returning_rate: null,
    });
    expect(e.daily).toHaveLength(3);
    expect(e.daily[0]).toMatchObject({ served: 0, est_takings_ghs: 0, avg_wait_min: null });
    expect(e.hours).toEqual([]);
    expect(e.barbers).toEqual([]);
    expect(e.services).toEqual([]);
    expect(e.cancel_reasons).toEqual([]);
  });
});

describe('branch_report across branches', () => {
  it('compares branches for an analyst', async () => {
    const { data, error } = await report(analyst.client, [f.branchId, f.closedBranchId], D1, D3);
    expect(error).toBeNull();
    const r = data as Report;
    expect(r.summary).toMatchObject({ served: 5, est_takings_ghs: 180, avg_wait_min: 15 });
    expect(r.branches).toHaveLength(2);
    expect(r.branches[0]).toEqual({
      branch_id: f.closedBranchId,
      name: `Appt Closed ${f.suffix}`,
      served: 1,
      walk_ins: 1,
      appointments: 0,
      no_shows: 0,
      no_show_rate: 0,
      cancellations: 0,
      cancellation_rate: 0,
      avg_wait_min: 5,
      median_wait_min: 5,
      avg_service_min: 30,
      rating_count: 0,
      rating_average: null,
      est_takings_ghs: 0,
      returning_rate: 100,
    });
    expect(r.branches[1]).toMatchObject({
      branch_id: f.branchId,
      name: `Appt Main ${f.suffix}`,
      served: 4,
      est_takings_ghs: 180,
    });
  });
});

describe('branch_report rules', () => {
  it('refuses people without report access or outside their branches', async () => {
    const refused = [
      await report(reception.client, [f.branchId], D1, D3),
      await report(f.barberClient, [f.branchId], D1, D3),
      await report(manager.client, [f.closedBranchId], D1, D3),
      await report(manager.client, [f.branchId, f.closedBranchId], D1, D3),
      await report(manager.client, [], D1, D3),
    ];
    for (const { error } of refused) expect(error?.message).toBe('not_allowed');
  });

  it('accepts up to 92 days and refuses longer or backwards ranges', async () => {
    expect((await report(manager.client, [f.branchId], dateAt(-99), dateAt(-8))).error).toBeNull();
    expect(
      (await report(manager.client, [f.branchId], dateAt(-100), dateAt(-8))).error?.message,
    ).toBe('invalid_range');
    expect((await report(manager.client, [f.branchId], D3, D1)).error?.message).toBe(
      'invalid_range',
    );
  });
});
