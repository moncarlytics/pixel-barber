// tests/db/customer-list.test.ts
// @vitest-environment node
// Customer list (Docs/superpowers/specs/2026-10-08-customer-list-design.md): list_customers scope,
// numbers, groups, search, paging and phone masking; customer_detail sections and access;
// send_customer_message rules and the queued staff_message.
//
// Seed (Main branch unless noted; days ago):
//   cust0: completed 1, 10, 20 (rated 4 and 5) + Closed completed 5   → Main: frequent; both: 4 visits
//          marketing consent granted
//   cust1: completed 120 + Closed completed 5                          → Main: lapsed; both: returning
//   cust2: no-shows 30, 31, 32 + completed 2                           → at_risk
//   cust3: only an appointment in 2 days                                → new
//   walk-in (no app account): completed 3                               → returning
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
type J = Record<string, any>;

let f: AppointmentFixture;
let manager: Awaited<ReturnType<typeof createStaffLogin>>;
let reception: Awaited<ReturnType<typeof createStaffLogin>>;
let analyst: Awaited<ReturnType<typeof createStaffLogin>>;
let otherManager: Awaited<ReturnType<typeof createStaffLogin>>;
let walkInId: string;
const at = (daysAgo: number, hhmm = '10:00') => `${dateAt(-daysAgo)}T${hhmm}:00.000Z`;
const local = (e164: string) => `0${e164.slice(4)}`;
const masked = (e164: string) => `${local(e164).slice(0, 3)}•••${local(e164).slice(-4)}`;
const cust = (i: number) => f.customers[i]!;

let n = 0;
async function ticket(fields: Omit<TicketInsert, 'ticket_number' | 'created_by'>) {
  n += 1;
  const { data, error } = await f.admin
    .from('queue_tickets')
    .insert({ ticket_number: `PB-CL-${f.suffix}-${n}`, created_by: 'customer', ...fields })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

const main = () => ({ branch_id: f.branchId, branch_service_id: f.branchServiceId });
const closed = () => ({ branch_id: f.closedBranchId, branch_service_id: f.closedBranchServiceId });
const done = (daysAgo: number) => ({
  state: 'completed' as const,
  assigned_barber_id: f.barberA.barberId,
  created_at: at(daysAgo, '10:00'),
  service_started_at: at(daysAgo, '10:10'),
  completed_at: at(daysAgo, '10:40'),
});

async function list(
  client: typeof manager.client,
  ids: string[],
  search: string | null = null,
  group: string | null = null,
  offset = 0,
) {
  return client.rpc('list_customers', {
    p_branch_ids: ids,
    p_search: search,
    p_group: group,
    p_offset: offset,
  });
}

beforeAll(async () => {
  f = await createAppointmentFixture();
  manager = await createStaffLogin(f, 'clm', 'branch_manager', f.branchId);
  reception = await createStaffLogin(f, 'clr', 'receptionist', f.branchId);
  analyst = await createStaffLogin(f, 'cla', 'analyst', [f.branchId, f.closedBranchId]);
  otherManager = await createStaffLogin(f, 'clo', 'branch_manager', f.closedBranchId);

  const r1 = await ticket({ ...main(), customer_id: cust(0).customerId, ...done(1) });
  const r2 = await ticket({ ...main(), customer_id: cust(0).customerId, ...done(10) });
  await ticket({ ...main(), customer_id: cust(0).customerId, ...done(20) });
  await ticket({ ...closed(), customer_id: cust(0).customerId, ...done(5) });
  for (const [ticketId, rating] of [
    [r1, 4],
    [r2, 5],
  ] as const) {
    const { error } = await f.admin.from('feedback').insert({
      ticket_id: ticketId,
      customer_id: cust(0).customerId,
      branch_id: f.branchId,
      barber_id: f.barberA.barberId,
      overall_rating: rating,
      comment: rating === 4 ? 'Good cut' : 'Great cut',
    });
    if (error) throw error;
  }
  const { error: consentError } = await f.admin.from('consents').insert({
    customer_id: cust(0).customerId,
    consent_type: 'marketing',
    granted: true,
    source: 'test',
  });
  if (consentError) throw consentError;

  await ticket({ ...main(), customer_id: cust(1).customerId, ...done(120) });
  await ticket({ ...closed(), customer_id: cust(1).customerId, ...done(5) });

  for (const d of [30, 31, 32]) {
    await ticket({
      ...main(),
      customer_id: cust(2).customerId,
      state: 'no_show',
      created_at: at(d),
      no_show_at: at(d, '10:20'),
    });
  }
  await ticket({ ...main(), customer_id: cust(2).customerId, ...done(2) });

  const { error: apptError } = await f.admin.from('appointments').insert({
    customer_id: cust(3).customerId,
    branch_id: f.branchId,
    branch_service_id: f.branchServiceId,
    scheduled_start: `${dateAt(2)}T10:00:00.000Z`,
    scheduled_end: `${dateAt(2)}T10:30:00.000Z`,
    status: 'scheduled',
    created_by: 'customer',
  });
  if (apptError) throw apptError;

  const { data: walkIn, error: walkInError } = await f.admin
    .from('customers')
    .insert({ name: `CL Walk-in ${f.suffix}`, phone_e164: `+233558${f.suffix.slice(-5)}9` })
    .select('id')
    .single();
  if (walkInError) throw walkInError;
  walkInId = walkIn.id;
  await ticket({ ...main(), customer_id: walkInId, ...done(3) });
}, 120000);

afterAll(async () => {
  const ids = [...f.customers.map((c) => c.customerId), walkInId].filter(Boolean);
  const { error: msgError } = await f.admin
    .from('notifications')
    .delete()
    .eq('notification_type', 'staff_message')
    .in('recipient_id', ids);
  if (msgError) throw msgError;
  const { error: consentError } = await f.admin.from('consents').delete().in('customer_id', ids);
  if (consentError) throw consentError;
  for (const login of [manager, reception, analyst, otherManager])
    await cleanupStaffLogin(f, login);
  await cleanupAppointmentFixture(f);
  if (walkInId) {
    const { error } = await f.admin.from('customers').delete().eq('id', walkInId);
    if (error) throw error;
  }
}, 90000);

describe('list_customers', () => {
  it('lists the branch customers newest visit first with in-branch numbers and groups', async () => {
    const { data, error } = await list(manager.client, [f.branchId]);
    expect(error).toBeNull();
    const r = data as J;
    expect(r.has_more).toBe(false);
    expect(r.rows.map((x: J) => x.id)).toEqual([
      cust(0).customerId,
      cust(2).customerId,
      walkInId,
      cust(1).customerId,
      cust(3).customerId,
    ]);
    expect(r.rows[0]).toMatchObject({
      name: 'Appt Customer 0',
      phone: local(cust(0).phone),
      visits: 3,
      no_shows: 0,
      avg_rating_given: 4.5,
      group: 'frequent',
    });
    expect(r.rows.map((x: J) => x.group)).toEqual([
      'frequent',
      'at_risk',
      'returning',
      'lapsed',
      'new',
    ]);
    expect(r.rows[1]).toMatchObject({ visits: 1, no_shows: 3 });
    expect(r.rows[4]).toMatchObject({ visits: 0, last_visit_at: null, avg_rating_given: null });
  });

  it('counts both branches for an analyst and masks phones', async () => {
    const { data, error } = await list(analyst.client, [f.branchId, f.closedBranchId]);
    expect(error).toBeNull();
    const rows = (data as J).rows as J[];
    const c0 = rows.find((x) => x.id === cust(0).customerId)!;
    const c1 = rows.find((x) => x.id === cust(1).customerId)!;
    expect(c0).toMatchObject({ visits: 4, phone: masked(cust(0).phone) });
    expect(c1).toMatchObject({ visits: 2, group: 'returning' });
  });

  it('searches by name and by phone with or without the leading 0', async () => {
    const byName = (await list(manager.client, [f.branchId], 'customer 2')).data as J;
    expect(byName.rows.map((x: J) => x.id)).toEqual([cust(2).customerId]);
    const byLocal = (await list(manager.client, [f.branchId], local(cust(0).phone))).data as J;
    expect(byLocal.rows.map((x: J) => x.id)).toEqual([cust(0).customerId]);
    const byDigits = (await list(manager.client, [f.branchId], local(cust(0).phone).slice(1)))
      .data as J;
    expect(byDigits.rows.map((x: J) => x.id)).toEqual([cust(0).customerId]);
  });

  it('filters by group and pages by offset', async () => {
    const lapsed = (await list(manager.client, [f.branchId], null, 'lapsed')).data as J;
    expect(lapsed.rows.map((x: J) => x.id)).toEqual([cust(1).customerId]);
    const page = (await list(manager.client, [f.branchId], null, null, 3)).data as J;
    expect(page.rows.map((x: J) => x.id)).toEqual([cust(1).customerId, cust(3).customerId]);
    expect(page.has_more).toBe(false);
    expect((await list(manager.client, [f.branchId], null, 'bogus')).error?.message).toBe(
      'invalid_group',
    );
  });

  it('refuses barbers, empty branch lists and branches outside scope', async () => {
    expect((await list(f.barberClient, [f.branchId])).error?.message).toBe('not_allowed');
    expect((await list(manager.client, [])).error?.message).toBe('not_allowed');
    expect((await list(manager.client, [f.closedBranchId])).error?.message).toBe('not_allowed');
  });
});

describe('customer_detail', () => {
  it('shows a customer with in-branch history, feedback and settings', async () => {
    const { data, error } = await manager.client.rpc('customer_detail', {
      p_customer_id: cust(0).customerId,
      p_branch_ids: [f.branchId],
    });
    expect(error).toBeNull();
    const d = data as J;
    expect(d.customer).toMatchObject({
      name: 'Appt Customer 0',
      phone: local(cust(0).phone),
      requires_confirmation_call: false,
      marketing_allowed: true,
    });
    expect(d.stats).toMatchObject({
      visits: 3,
      appointments: 0,
      no_shows: 0,
      cancellations: 0,
      late_cancellations: 0,
      avg_rating_given: 4.5,
      visits_last_90_days: 3,
    });
    expect(d.group).toBe('frequent');
    expect(d.branch_ids).toEqual([f.branchId]);
    expect(d.visits).toHaveLength(3);
    expect(d.visits[0]).toMatchObject({
      branch_name: `Appt Main ${f.suffix}`,
      service_name: `Appt Service ${f.suffix}`,
      barber_name: 'Appt Barber a',
      state: 'completed',
    });
    // Newest first: the 'Great cut' row was inserted after 'Good cut'.
    expect(d.feedback.map((x: J) => x.comment)).toEqual(['Great cut', 'Good cut']);
    expect(d.messages).toEqual([]);
  });

  it('masks the phone for analysts and counts every requested branch', async () => {
    const { data } = await analyst.client.rpc('customer_detail', {
      p_customer_id: cust(0).customerId,
      p_branch_ids: [f.branchId, f.closedBranchId],
    });
    const d = data as J;
    expect(d.customer.phone).toBe(masked(cust(0).phone));
    expect(d.stats.visits).toBe(4);
    expect([...d.branch_ids].sort()).toEqual([f.branchId, f.closedBranchId].sort());
  });

  it('refuses out-of-scope callers and hides customers not seen at the branch', async () => {
    const outOfScope = await otherManager.client.rpc('customer_detail', {
      p_customer_id: cust(0).customerId,
      p_branch_ids: [f.branchId],
    });
    expect(outOfScope.error?.message).toBe('not_allowed');
    const notSeen = await otherManager.client.rpc('customer_detail', {
      p_customer_id: cust(3).customerId,
      p_branch_ids: [f.closedBranchId],
    });
    expect(notSeen.error?.message).toBe('not_found');
    const barber = await f.barberClient.rpc('customer_detail', {
      p_customer_id: cust(0).customerId,
      p_branch_ids: [f.branchId],
    });
    expect(barber.error?.message).toBe('not_allowed');
  });
});

describe('send_customer_message', () => {
  const send = (
    client: typeof manager.client,
    text: string,
    branch = f.branchId,
    customer = cust(0).customerId,
  ) =>
    client.rpc('send_customer_message', {
      p_customer_id: customer,
      p_branch_id: branch,
      p_text: text,
    });

  it('checks the text, the caller and the branch', async () => {
    expect((await send(reception.client, '   ')).error?.message).toBe('empty_message');
    expect((await send(reception.client, 'x'.repeat(141))).error?.message).toBe('message_too_long');
    expect((await send(analyst.client, 'Hello')).error?.message).toBe('not_allowed');
    expect((await send(reception.client, 'Hello', f.closedBranchId)).error?.message).toBe(
      'not_allowed',
    );
    expect(
      (await send(otherManager.client, 'Hello', f.closedBranchId, cust(3).customerId)).error
        ?.message,
    ).toBe('not_found');
  });

  it('queues a staff_message and stops at 5 per branch per day', async () => {
    const { data: id, error } = await send(
      reception.client,
      '  Your barber is running 15 minutes late.  ',
    );
    expect(error).toBeNull();
    const { data: row } = await f.admin
      .from('notifications')
      .select('recipient_type, recipient_id, notification_type, payload')
      .eq('id', id as string)
      .single();
    expect(row).toMatchObject({
      recipient_type: 'customer',
      recipient_id: cust(0).customerId,
      notification_type: 'staff_message',
      payload: {
        text: 'Your barber is running 15 minutes late.',
        branch_id: f.branchId,
        branch_name: `Appt Main ${f.suffix}`,
        sent_by_staff_id: reception.staffUserId,
      },
    });
    for (let i = 2; i <= 5; i++)
      expect((await send(reception.client, `Note ${i}`)).error).toBeNull();
    expect((await send(reception.client, 'One too many')).error?.message).toBe('daily_limit');

    const { data } = await manager.client.rpc('customer_detail', {
      p_customer_id: cust(0).customerId,
      p_branch_ids: [f.branchId],
    });
    const messages = (data as J).messages as J[];
    expect(messages).toHaveLength(5);
    expect(messages[4]).toMatchObject({
      text: 'Your barber is running 15 minutes late.',
      sent_by_name: reception.name,
      branch_name: `Appt Main ${f.suffix}`,
    });
  });
});
