// tests/db/appointment-early-check-in.test.ts
// @vitest-environment node
// Early check-in (part 3, Section 2): the customer's "I've arrived" (from 30 minutes before) and
// staff Check in start the appointment at once when the barber is free, otherwise mark it checked
// in; an existing ticket takes the appointment; the check-in method reaches the ticket, including
// at slot-time conversion. Appointments are inserted directly (customers can't book < 1 hour out).
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  cleanupStaffLogin,
  createAppointmentFixture,
  createStaffLogin,
  deleteBranchAppointments,
  type AppointmentFixture,
} from './fixtures/appointments';

const MIN = 60_000;
let f: AppointmentFixture;
let reception: Awaited<ReturnType<typeof createStaffLogin>>;

async function reset() {
  const { data: tickets } = await f.admin
    .from('queue_tickets')
    .select('id')
    .eq('branch_id', f.branchId);
  const ids = (tickets ?? []).map((t) => t.id);
  if (ids.length > 0) {
    await f.admin.from('queue_events').delete().in('ticket_id', ids);
    await f.admin.from('notifications').delete().in('related_ticket_id', ids);
    await f.admin.from('queue_tickets').delete().in('id', ids);
  }
  await deleteBranchAppointments(f.admin, [f.branchId]);
  await f.admin.from('branches').update({ is_temporarily_closed: false }).eq('id', f.branchId);
}

async function appt(customerIdx: number, barberId: string | null, minutesFromNow: number) {
  const start = new Date(Date.now() + minutesFromNow * MIN);
  const { data, error } = await f.admin
    .from('appointments')
    .insert({
      customer_id: f.customers[customerIdx].customerId,
      branch_id: f.branchId,
      branch_service_id: f.branchServiceId,
      preferred_barber_id: barberId,
      scheduled_start: start.toISOString(),
      scheduled_end: new Date(start.getTime() + 30 * MIN).toISOString(),
      status: 'scheduled',
      created_by: 'customer',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

/** Puts a waiting ticket on a barber's line, so they are not free. */
async function busy(customerIdx: number, barberId: string) {
  const { data, error } = await f.admin
    .from('queue_tickets')
    .insert({
      ticket_number: `PB-EC-${f.suffix}-${customerIdx}`,
      branch_id: f.branchId,
      customer_id: f.customers[customerIdx].customerId,
      branch_service_id: f.branchServiceId,
      assigned_barber_id: barberId,
      state: 'waiting',
      created_by: 'customer',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

async function appointmentRow(id: string) {
  const { data, error } = await f.admin.from('appointments').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

async function ticketForAppointment(id: string) {
  const { data, error } = await f.admin
    .from('queue_tickets')
    .select('*')
    .eq('appointment_id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Moves the appointment's slot to a minute ago and runs the slot-time conversion. */
async function reachSlot(id: string) {
  const start = new Date(Date.now() - MIN);
  await f.admin
    .from('appointments')
    .update({
      scheduled_start: start.toISOString(),
      scheduled_end: new Date(start.getTime() + 30 * MIN).toISOString(),
    })
    .eq('id', id);
  const { error } = await f.admin.rpc('activate_due_appointments');
  if (error) throw error;
}

const slotCrossesMidnight = (minutes: number) =>
  new Date(Date.now() + minutes * MIN).toISOString().slice(0, 10) !==
  new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  f = await createAppointmentFixture();
  reception = await createStaffLogin(f, 'rec', 'receptionist', f.branchId);
}, 90000);

beforeEach(async () => {
  await reset();
});

afterAll(async () => {
  await reset();
  await cleanupStaffLogin(f, reception);
  await cleanupAppointmentFixture(f);
}, 90000);

describe('check_in_my_appointment', () => {
  it('refuses before the 30-minute window', async () => {
    const id = await appt(0, f.barberB.barberId, 120);
    const { error } = await f.customers[0].client.rpc('check_in_my_appointment', {
      p_appointment_id: id,
    });
    expect(error?.message).toBe('too_early');
  });

  it("refuses someone else's appointment", async () => {
    const id = await appt(0, f.barberB.barberId, 20);
    const { error } = await f.customers[1].client.rpc('check_in_my_appointment', {
      p_appointment_id: id,
    });
    expect(error?.message).toBe('not_found');
  });

  it('refuses when the branch is closed today', async () => {
    const id = await appt(0, f.barberB.barberId, 20);
    await f.admin.from('branches').update({ is_temporarily_closed: true }).eq('id', f.branchId);
    const { error } = await f.customers[0].client.rpc('check_in_my_appointment', {
      p_appointment_id: id,
    });
    expect(error?.message).toBe('branch_closed');
  });

  it('starts the appointment now when the barber is free', async () => {
    const id = await appt(0, f.barberB.barberId, 20);
    const { data: ticketId, error } = await f.customers[0].client.rpc('check_in_my_appointment', {
      p_appointment_id: id,
    });
    expect(error).toBeNull();
    expect(ticketId).toBeTruthy();
    const ticket = await ticketForAppointment(id);
    expect(ticket).toMatchObject({
      id: ticketId,
      assigned_barber_id: f.barberB.barberId,
      state: 'called',
      check_in_method: 'app_tap',
    });
    expect(ticket!.checked_in_at).not.toBeNull();
    expect(await appointmentRow(id)).toMatchObject({
      status: 'converted',
      check_in_method: 'app_tap',
    });
    const again = await f.customers[0].client.rpc('check_in_my_appointment', {
      p_appointment_id: id,
    });
    expect(again.error?.message).toBe('too_late');
  });

  it('marks it checked in when the barber is busy, and the method reaches the ticket at the slot', async () => {
    await busy(1, f.barberB.barberId);
    const id = await appt(0, f.barberB.barberId, 25);
    const { data: ticketId, error } = await f.customers[0].client.rpc('check_in_my_appointment', {
      p_appointment_id: id,
    });
    expect(error).toBeNull();
    expect(ticketId).toBeNull();
    const row = await appointmentRow(id);
    expect(row).toMatchObject({ status: 'checked_in', check_in_method: 'app_tap' });
    expect(row.checked_in_at).not.toBeNull();
    expect(await ticketForAppointment(id)).toBeNull();

    await reachSlot(id);
    const ticket = await ticketForAppointment(id);
    expect(ticket).toMatchObject({ check_in_method: 'app_tap' });
    expect(ticket!.checked_in_at).not.toBeNull();
  });

  it('gives an "any barber" appointment to a free skilled barber', async () => {
    await busy(1, f.barberB.barberId);
    const id = await appt(0, null, 20);
    const { data: ticketId } = await f.customers[0].client.rpc('check_in_my_appointment', {
      p_appointment_id: id,
    });
    expect(ticketId).toBeTruthy();
    expect(await ticketForAppointment(id)).toMatchObject({
      assigned_barber_id: f.barberA.barberId,
    });
  });

  it("attaches to the customer's existing ticket at the branch", async () => {
    const existing = await busy(0, f.barberA.barberId);
    const id = await appt(0, f.barberB.barberId, 20);
    const { data: ticketId, error } = await f.customers[0].client.rpc('check_in_my_appointment', {
      p_appointment_id: id,
    });
    expect(error).toBeNull();
    expect(ticketId).toBe(existing);
    expect(await ticketForAppointment(id)).toMatchObject({
      id: existing,
      check_in_method: 'app_tap',
    });
    expect((await appointmentRow(id)).status).toBe('converted');
  });
});

describe('staff_check_in_appointment', () => {
  it('starts the appointment now when the barber is free', async (ctx) => {
    if (slotCrossesMidnight(20)) {
      ctx.skip();
      return;
    }
    const id = await appt(0, f.barberB.barberId, 20);
    const { data: ticketId, error } = await reception.client.rpc('staff_check_in_appointment', {
      p_appointment_id: id,
    });
    expect(error).toBeNull();
    expect(ticketId).toBeTruthy();
    expect(await ticketForAppointment(id)).toMatchObject({
      id: ticketId,
      check_in_method: 'staff',
    });
  });

  it('marks it checked in when the barber is busy; the ticket records staff at the slot', async (ctx) => {
    if (slotCrossesMidnight(20)) {
      ctx.skip();
      return;
    }
    await busy(1, f.barberB.barberId);
    const id = await appt(0, f.barberB.barberId, 20);
    const { data: ticketId, error } = await reception.client.rpc('staff_check_in_appointment', {
      p_appointment_id: id,
    });
    expect(error).toBeNull();
    expect(ticketId).toBeNull();
    expect(await appointmentRow(id)).toMatchObject({
      status: 'checked_in',
      check_in_method: 'staff',
    });
    await reachSlot(id);
    expect(await ticketForAppointment(id)).toMatchObject({ check_in_method: 'staff' });
  });
});
