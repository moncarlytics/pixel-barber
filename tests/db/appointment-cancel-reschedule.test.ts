// tests/db/appointment-cancel-reschedule.test.ts
// @vitest-environment node
// cancel_appointment / reschedule_appointment: own appointments only, only while scheduled and more
// than an hour away; reschedule re-checks every slot rule and frees the old slot only on success.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  createAppointmentFixture,
  dateAt,
  slotAt,
  type AppointmentFixture,
} from './fixtures/appointments';

let f: AppointmentFixture;
let apptId: string;
let soonApptId: string;

beforeAll(async () => {
  f = await createAppointmentFixture();
  const { data, error } = await f.customers[0].client.rpc('book_appointment', {
    p_branch_service_id: f.branchServiceId,
    p_barber_id: f.barberA.barberId,
    p_slot_start: slotAt(2, '10:00'),
  });
  if (error) throw error;
  apptId = data!;
  // Customer 1 holds A at 11:00 on day 2.
  const { error: e2 } = await f.customers[1].client.rpc('book_appointment', {
    p_branch_service_id: f.branchServiceId,
    p_barber_id: f.barberA.barberId,
    p_slot_start: slotAt(2, '11:00'),
  });
  if (e2) throw e2;
  // An appointment starting in 30 minutes (inserted directly: booking refuses it).
  const start = new Date(Date.now() + 30 * 60 * 1000);
  const { data: soon, error: e3 } = await f.admin
    .from('appointments')
    .insert({
      customer_id: f.customers[2].customerId,
      branch_id: f.branchId,
      branch_service_id: f.branchServiceId,
      preferred_barber_id: f.barberB.barberId,
      scheduled_start: start.toISOString(),
      scheduled_end: new Date(start.getTime() + 30 * 60 * 1000).toISOString(),
      status: 'scheduled',
      created_by: 'customer',
    })
    .select('id')
    .single();
  if (e3) throw e3;
  soonApptId = soon.id;
}, 90000);

afterAll(async () => {
  await cleanupAppointmentFixture(f);
}, 90000);

describe('reschedule_appointment', () => {
  it('refuses a slot someone else holds and leaves the appointment unchanged', async () => {
    const { error } = await f.customers[0].client.rpc('reschedule_appointment', {
      p_appointment_id: apptId,
      p_slot_start: slotAt(2, '11:00'),
    });
    expect(error?.message).toBe('slot_taken');
    const { data } = await f.admin
      .from('appointments')
      .select('scheduled_start')
      .eq('id', apptId)
      .single();
    expect(new Date(data!.scheduled_start).toISOString()).toBe(slotAt(2, '10:00'));
  });

  it('moves to a free slot (even on the same day) and frees the old one', async () => {
    const { error } = await f.customers[0].client.rpc('reschedule_appointment', {
      p_appointment_id: apptId,
      p_slot_start: slotAt(2, '14:00'),
    });
    expect(error).toBeNull();
    const { data } = await f.admin.from('appointments').select('*').eq('id', apptId).single();
    expect(new Date(data!.scheduled_start).toISOString()).toBe(slotAt(2, '14:00'));
    expect(new Date(data!.scheduled_end).toISOString()).toBe(slotAt(2, '14:30'));
    expect(data!.version).toBe(1);
    const { data: free } = await f.customers[3].client.rpc('list_appointment_slots', {
      p_branch_service_id: f.branchServiceId,
      p_barber_id: f.barberA.barberId,
      p_date: dateAt(2),
    });
    expect((free ?? []).map((s) => new Date(s).toISOString())).toContain(slotAt(2, '10:00'));
  });

  it("refuses someone else's appointment and one less than an hour away", async () => {
    const other = await f.customers[1].client.rpc('reschedule_appointment', {
      p_appointment_id: apptId,
      p_slot_start: slotAt(3, '10:00'),
    });
    expect(other.error?.message).toBe('not_found');
    const late = await f.customers[2].client.rpc('reschedule_appointment', {
      p_appointment_id: soonApptId,
      p_slot_start: slotAt(3, '10:00'),
    });
    expect(late.error?.message).toBe('too_late');
  });
});

describe('cancel_appointment', () => {
  it('refuses within an hour of the start', async () => {
    const { error } = await f.customers[2].client.rpc('cancel_appointment', {
      p_appointment_id: soonApptId,
      p_reason: 'cant_make_it',
    });
    expect(error?.message).toBe('too_late');
  });

  it("refuses someone else's appointment", async () => {
    const { error } = await f.customers[1].client.rpc('cancel_appointment', {
      p_appointment_id: apptId,
      p_reason: 'other',
    });
    expect(error?.message).toBe('not_found');
  });

  it('cancels with the reason and cannot be cancelled twice', async () => {
    const { error } = await f.customers[0].client.rpc('cancel_appointment', {
      p_appointment_id: apptId,
      p_reason: 'changed_plans',
    });
    expect(error).toBeNull();
    const { data } = await f.admin.from('appointments').select('*').eq('id', apptId).single();
    expect(data).toMatchObject({ status: 'cancelled', cancel_reason: 'changed_plans' });
    expect(data!.cancelled_at).not.toBeNull();
    const again = await f.customers[0].client.rpc('cancel_appointment', {
      p_appointment_id: apptId,
      p_reason: 'other',
    });
    expect(again.error?.message).toBe('too_late');
  });
});
