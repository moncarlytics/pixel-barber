// tests/db/feedback-staff.test.ts
// @vitest-environment node
// Staff side of feedback (spec Section 2): the unseen-low count for owners/branch managers in
// scope, mark seen (capability, scope, idempotent), the branch list and 30-day summary
// (view_branch_reports + scope), and refusals for receptionists and out-of-scope managers.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  cleanupStaffLogin,
  createAppointmentFixture,
  createStaffLogin,
  type AppointmentFixture,
} from './fixtures/appointments';

let f: AppointmentFixture;
let manager: Awaited<ReturnType<typeof createStaffLogin>>;
let reception: Awaited<ReturnType<typeof createStaffLogin>>;
let otherManager: Awaited<ReturnType<typeof createStaffLogin>>;
const ids: Record<string, string> = {};

async function feedbackRow(customerIdx: number, overall: number, comment: string) {
  const { data: t, error } = await f.admin
    .from('queue_tickets')
    .insert({
      ticket_number: `PB-FS-${f.suffix}-${customerIdx}`,
      branch_id: f.branchId,
      customer_id: f.customers[customerIdx].customerId,
      branch_service_id: f.branchServiceId,
      assigned_barber_id: f.barberA.barberId,
      state: 'completed',
      completed_at: new Date().toISOString(),
      created_by: 'customer',
    })
    .select('id')
    .single();
  if (error) throw error;
  const { data: fb, error: fbError } = await f.admin
    .from('feedback')
    .insert({
      ticket_id: t.id,
      customer_id: f.customers[customerIdx].customerId,
      branch_id: f.branchId,
      barber_id: f.barberA.barberId,
      overall_rating: overall,
      comment,
    })
    .select('id')
    .single();
  if (fbError) throw fbError;
  return fb.id as string;
}

beforeAll(async () => {
  f = await createAppointmentFixture();
  manager = await createStaffLogin(f, 'mgr', 'branch_manager', f.branchId);
  reception = await createStaffLogin(f, 'rec', 'receptionist', f.branchId);
  otherManager = await createStaffLogin(f, 'oth', 'branch_manager', f.closedBranchId);
  ids.low = await feedbackRow(0, 1, 'Waited too long');
  ids.alsoLow = await feedbackRow(1, 2, 'Rushed');
  ids.good = await feedbackRow(2, 5, 'Perfect');
}, 90000);

afterAll(async () => {
  // seen_by_staff_id references staff_users; clear it so the manager can be deleted.
  await f.admin.from('feedback').update({ seen_by_staff_id: null }).eq('branch_id', f.branchId);
  await cleanupStaffLogin(f, manager);
  await cleanupStaffLogin(f, reception);
  await cleanupStaffLogin(f, otherManager);
  await cleanupAppointmentFixture(f);
}, 90000);

describe('list_unseen_low_feedback_count', () => {
  it('counts unseen low ratings for managers in scope only', async () => {
    expect((await manager.client.rpc('list_unseen_low_feedback_count')).data).toBe(2);
    expect((await reception.client.rpc('list_unseen_low_feedback_count')).data).toBe(0);
    expect((await otherManager.client.rpc('list_unseen_low_feedback_count')).data).toBe(0);
  });
});

describe('mark_feedback_seen', () => {
  it('refuses receptionists and managers of other branches', async () => {
    expect(
      (await reception.client.rpc('mark_feedback_seen', { p_feedback_id: ids.low })).error?.message,
    ).toBe('not_allowed');
    expect(
      (await otherManager.client.rpc('mark_feedback_seen', { p_feedback_id: ids.low })).error
        ?.message,
    ).toBe('not_allowed');
  });

  it('records who saw it once, and the count drops', async () => {
    expect(
      (await manager.client.rpc('mark_feedback_seen', { p_feedback_id: ids.low })).error,
    ).toBeNull();
    const { data: first } = await f.admin
      .from('feedback')
      .select('seen_at, seen_by_staff_id')
      .eq('id', ids.low)
      .single();
    expect(first!.seen_by_staff_id).toBe(manager.staffUserId);
    expect(first!.seen_at).not.toBeNull();
    await manager.client.rpc('mark_feedback_seen', { p_feedback_id: ids.low });
    const { data: second } = await f.admin
      .from('feedback')
      .select('seen_at')
      .eq('id', ids.low)
      .single();
    expect(second!.seen_at).toBe(first!.seen_at);
    expect((await manager.client.rpc('list_unseen_low_feedback_count')).data).toBe(1);
  });
});

describe('list_branch_feedback and branch_feedback_summary', () => {
  it('lists the branch newest first with names and seen details', async () => {
    const { data, error } = await manager.client.rpc('list_branch_feedback', {
      p_branch_id: f.branchId,
    });
    expect(error).toBeNull();
    expect(data!.map((r) => r.comment)).toEqual(['Perfect', 'Rushed', 'Waited too long']);
    expect(data![2]).toMatchObject({
      customer_first_name: 'Appt',
      barber_name: 'Appt Barber a',
      service_name: `Appt Service ${f.suffix}`,
      overall_rating: 1,
      seen_by_name: manager.name,
    });
    expect(data![1].seen_at).toBeNull();
  });

  it('summarises the last 30 days', async () => {
    const { data, error } = await manager.client.rpc('branch_feedback_summary', {
      p_branch_id: f.branchId,
    });
    expect(error).toBeNull();
    expect(data![0].rating_count).toBe(3);
    expect(Number(data![0].average_rating)).toBeCloseTo(8 / 3, 2);
  });

  it('refuses receptionists and out-of-scope managers', async () => {
    expect(
      (await reception.client.rpc('list_branch_feedback', { p_branch_id: f.branchId })).error
        ?.message,
    ).toBe('not_allowed');
    expect(
      (await otherManager.client.rpc('branch_feedback_summary', { p_branch_id: f.branchId })).error
        ?.message,
    ).toBe('not_allowed');
  });
});
