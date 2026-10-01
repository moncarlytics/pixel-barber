// tests/db/appointment-staff-manage.test.ts
// @vitest-environment node
// Staff reschedule / cancel / check-in / no-show, the branch day list and single read (scope-checked),
// and the barber's own "today" list.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  cleanupStaffLogin,
  createAppointmentFixture,
  createStaffLogin,
  dateAt,
  slotAt,
  type AppointmentFixture,
} from './fixtures/appointments';

let f: AppointmentFixture;
let reception: Awaited<ReturnType<typeof createStaffLogin>>;
let otherManager: Awaited<ReturnType<typeof createStaffLogin>>;
let apptId: string;

async function staffBook(customerIdx: number, barberId: string | null, slot: string) {
  const { data, error } = await reception.client.rpc('staff_book_appointment', {
    p_branch_service_id: f.branchServiceId,
    p_barber_id: barberId,
    p_slot_start: slot,
    p_customer_name: 'x',
    p_customer_phone: f.customers[customerIdx].phone,
  });
  if (error) throw error;
  return data!;
}

async function insertScheduled(customerIdx: number, barberId: string | null, start: Date) {
  const { data, error } = await f.admin
    .from('appointments')
    .insert({
      customer_id: f.customers[customerIdx].customerId,
      branch_id: f.branchId,
      branch_service_id: f.branchServiceId,
      preferred_barber_id: barberId,
      scheduled_start: start.toISOString(),
      scheduled_end: new Date(start.getTime() + 30 * 60_000).toISOString(),
      status: 'scheduled',
      created_by: 'customer',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

async function pastAppointment(customerIdx: number, barberId: string | null) {
  // Started 5 minutes ago, still 'scheduled' (e.g. waiting for a barber) — inserted directly.
  return insertScheduled(customerIdx, barberId, new Date(Date.now() - 5 * 60_000));
}

beforeAll(async () => {
  f = await createAppointmentFixture();
  reception = await createStaffLogin(f, 'rec', 'receptionist', f.branchId);
  otherManager = await createStaffLogin(f, 'mgr', 'branch_manager', f.closedBranchId);
  apptId = await staffBook(0, f.barberA.barberId, slotAt(2, '10:00'));
}, 90000);

afterAll(async () => {
  await f.admin.from('appointments').delete().in('branch_id', [f.branchId, f.closedBranchId]);
  await cleanupStaffLogin(f, reception);
  await cleanupStaffLogin(f, otherManager);
  await cleanupAppointmentFixture(f);
}, 90000);

describe('reading', () => {
  it('lists the day for in-scope staff with names, and refuses out-of-scope staff', async () => {
    const { data, error } = await reception.client.rpc('list_branch_appointments', {
      p_branch_id: f.branchId,
      p_date: dateAt(2),
    });
    expect(error).toBeNull();
    const row = (data ?? []).find((r) => r.id === apptId);
    expect(row).toMatchObject({
      customer_name: 'Appt Customer 0',
      customer_phone: f.customers[0].phone,
      barber_name: 'Appt Barber a',
      created_by: 'staff',
      created_by_staff_name: reception.name,
      status: 'scheduled',
    });
    const other = await otherManager.client.rpc('list_branch_appointments', {
      p_branch_id: f.branchId,
      p_date: dateAt(2),
    });
    expect(other.error?.message).toBe('not_allowed');
    const single = await reception.client.rpc('get_branch_appointment', {
      p_appointment_id: apptId,
    });
    expect(single.data?.[0]?.id).toBe(apptId);
    const singleOther = await otherManager.client.rpc('get_branch_appointment', {
      p_appointment_id: apptId,
    });
    expect(singleOther.error?.message).toBe('not_allowed');
  });
});

describe('actions', () => {
  it('checks in, then reschedules a checked-in appointment', async () => {
    expect(
      (await reception.client.rpc('staff_check_in_appointment', { p_appointment_id: apptId }))
        .error,
    ).toBeNull();
    const { data: after } = await f.admin
      .from('appointments')
      .select('*')
      .eq('id', apptId)
      .single();
    expect(after).toMatchObject({ status: 'checked_in' });
    expect(after!.checked_in_at).not.toBeNull();
    const again = await reception.client.rpc('staff_check_in_appointment', {
      p_appointment_id: apptId,
    });
    expect(again.error?.message).toBe('too_late');

    const moved = await reception.client.rpc('staff_reschedule_appointment', {
      p_appointment_id: apptId,
      p_slot_start: slotAt(2, '14:00'),
    });
    expect(moved.error).toBeNull();
    const { data: row } = await f.admin.from('appointments').select('*').eq('id', apptId).single();
    expect(new Date(row!.scheduled_start).toISOString()).toBe(slotAt(2, '14:00'));
    expect(row!.status).toBe('checked_in');
  });

  it('refuses no-show before the start, allows it after', async () => {
    const barberIds = [f.barberA.barberId, f.barberB.barberId];
    // A live cron converts past-due scheduled appointments when a barber is eligible; keep both
    // barbers offline so the past appointment stays 'scheduled' during the test.
    await f.admin.from('barbers').update({ status: 'offline' }).in('id', barberIds);
    try {
      const early = await reception.client.rpc('staff_mark_appointment_no_show', {
        p_appointment_id: apptId,
      });
      expect(early.error?.message).toBe('too_late');
      const pastId = await pastAppointment(1, null);
      expect(
        (await reception.client.rpc('staff_mark_appointment_no_show', { p_appointment_id: pastId }))
          .error,
      ).toBeNull();
      const { data } = await f.admin
        .from('appointments')
        .select('status')
        .eq('id', pastId)
        .single();
      expect(data!.status).toBe('no_show');
    } finally {
      await f.admin.from('barbers').update({ status: 'available' }).in('id', barberIds);
    }
  });

  it('cancels any time before conversion, but never with branch_closed', async () => {
    const forbidden = await reception.client.rpc('staff_cancel_appointment', {
      p_appointment_id: apptId,
      p_reason: 'branch_closed',
    });
    expect(forbidden.error?.message).toBe('not_allowed');
    expect(
      (
        await reception.client.rpc('staff_cancel_appointment', {
          p_appointment_id: apptId,
          p_reason: 'cant_make_it',
        })
      ).error,
    ).toBeNull();
    const { data } = await f.admin.from('appointments').select('*').eq('id', apptId).single();
    expect(data).toMatchObject({ status: 'cancelled', cancel_reason: 'cant_make_it' });
  });

  it('refuses actions on a converted appointment and from out-of-scope staff', async () => {
    const id = await staffBook(2, null, slotAt(3, '10:00'));
    const outOfScope = await otherManager.client.rpc('staff_cancel_appointment', {
      p_appointment_id: id,
      p_reason: 'other',
    });
    expect(outOfScope.error?.message).toBe('not_allowed');
    await f.admin.from('appointments').update({ status: 'converted' }).eq('id', id);
    const converted = await reception.client.rpc('staff_cancel_appointment', {
      p_appointment_id: id,
      p_reason: 'other',
    });
    expect(converted.error?.message).toBe('already_converted');
  });
});

describe('list_my_appointments_today', () => {
  it("returns only the calling barber's appointments today, with first names", async (ctx) => {
    // Next 30-minute grid slot at least 60 minutes out, and it must still end on today's UTC date
    // (so it is in today's list). Being in the future, the cron will not convert it mid-test.
    const slotMs = 30 * 60_000;
    const start = new Date(Math.ceil((Date.now() + 60 * 60_000) / slotMs) * slotMs);
    const end = new Date(start.getTime() + slotMs - 1);
    const today = new Date().toISOString().slice(0, 10);
    if (start.toISOString().slice(0, 10) !== today || end.toISOString().slice(0, 10) !== today) {
      ctx.skip();
      return;
    }
    const todayId = await insertScheduled(3, f.barberA.barberId, start);
    const { data, error } = await f.barberClient.rpc('list_my_appointments_today');
    expect(error).toBeNull();
    const row = (data ?? []).find((r) => r.id === todayId);
    expect(row).toMatchObject({ customer_first_name: 'Appt' });
    expect((data ?? []).every((r) => r.id !== apptId)).toBe(true);
    const fromCustomer = await f.customers[0].client.rpc('list_my_appointments_today');
    expect(fromCustomer.data ?? []).toEqual([]);
  });
});
