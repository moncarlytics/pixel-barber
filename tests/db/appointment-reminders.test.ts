// tests/db/appointment-reminders.test.ts
// @vitest-environment node
// Reminder queueing (part 3, Section 1): the evening-before reminder (18:00–21:00 the day before,
// only for appointments that existed by 18:00), the 1-hour reminder (only when booked at least an
// hour ahead), nothing for cancelled appointments, one row per slot, fresh rows after a reschedule.
// The clock is passed in (p_now), so these run at any time of day.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  createAppointmentFixture,
  slotAt,
  type AppointmentFixture,
} from './fixtures/appointments';

let f: AppointmentFixture;

async function insertAppt(
  customerIdx: number,
  start: string,
  createdAt: string,
  status: 'scheduled' | 'cancelled' = 'scheduled',
) {
  const startMs = Date.parse(start);
  const { data, error } = await f.admin
    .from('appointments')
    .insert({
      customer_id: f.customers[customerIdx].customerId,
      branch_id: f.branchId,
      branch_service_id: f.branchServiceId,
      preferred_barber_id: f.barberB.barberId,
      scheduled_start: start,
      scheduled_end: new Date(startMs + 30 * 60_000).toISOString(),
      status,
      created_by: 'customer',
      created_at: createdAt,
      ...(status === 'cancelled'
        ? { cancel_reason: 'other' as const, cancelled_at: createdAt }
        : {}),
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

async function enqueue(now: string) {
  const { error } = await f.admin.rpc('enqueue_appointment_reminders', { p_now: now });
  if (error) throw error;
}

async function remindersFor(appointmentId: string) {
  const { data, error } = await f.admin
    .from('notifications')
    .select('notification_type, payload, recipient_id, recipient_type, channel, status')
    .eq('related_appointment_id', appointmentId)
    .order('created_at');
  if (error) throw error;
  return data ?? [];
}

beforeAll(async () => {
  f = await createAppointmentFixture();
}, 90000);

afterAll(async () => {
  await cleanupAppointmentFixture(f);
}, 90000);

describe('enqueue_appointment_reminders', () => {
  it('queues one evening-before reminder inside 18:00–21:00 the day before', async () => {
    const slot = slotAt(2, '10:00');
    const id = await insertAppt(0, slot, slotAt(1, '09:00'));
    await enqueue(slotAt(1, '18:30'));
    await enqueue(slotAt(1, '18:31'));
    const rows = await remindersFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      notification_type: 'appointment_reminder_day',
      recipient_type: 'customer',
      recipient_id: f.customers[0].customerId,
      channel: 'sms',
      status: 'pending',
    });
    expect(Date.parse((rows[0].payload as { slot: string }).slot)).toBe(Date.parse(slot));
  });

  it('skips the evening reminder for an appointment booked after 18:00', async () => {
    const id = await insertAppt(1, slotAt(2, '11:00'), slotAt(1, '19:00'));
    await enqueue(slotAt(1, '19:30'));
    expect(await remindersFor(id)).toHaveLength(0);
  });

  it('queues nothing outside the evening window', async () => {
    const id = await insertAppt(2, slotAt(2, '12:00'), slotAt(1, '09:00'));
    await enqueue(slotAt(1, '17:59'));
    await enqueue(slotAt(1, '21:30'));
    expect(await remindersFor(id)).toHaveLength(0);
  });

  it('queues the 1-hour reminder inside the last hour', async () => {
    const id = await insertAppt(3, slotAt(3, '10:00'), slotAt(1, '09:00'));
    await enqueue(slotAt(3, '09:30'));
    const rows = await remindersFor(id);
    expect(rows.map((r) => r.notification_type)).toEqual(['appointment_reminder_hour']);
  });

  it('skips the 1-hour reminder when booked less than an hour ahead', async () => {
    const id = await insertAppt(0, slotAt(3, '15:00'), slotAt(3, '14:20'));
    await enqueue(slotAt(3, '14:40'));
    expect(await remindersFor(id)).toHaveLength(0);
  });

  it('queues nothing for a cancelled appointment', async () => {
    const id = await insertAppt(1, slotAt(3, '16:00'), slotAt(1, '09:00'), 'cancelled');
    await enqueue(slotAt(2, '18:30'));
    await enqueue(slotAt(3, '15:30'));
    expect(await remindersFor(id)).toHaveLength(0);
  });

  it('queues fresh reminders for the new slot after a reschedule', async () => {
    const id = await insertAppt(2, slotAt(4, '10:00'), slotAt(1, '09:00'));
    await enqueue(slotAt(3, '18:30'));
    const newSlot = slotAt(5, '10:00');
    const { error } = await f.admin
      .from('appointments')
      .update({
        scheduled_start: newSlot,
        scheduled_end: new Date(Date.parse(newSlot) + 30 * 60_000).toISOString(),
      })
      .eq('id', id);
    if (error) throw error;
    await enqueue(slotAt(4, '18:30'));
    const rows = await remindersFor(id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => Date.parse((r.payload as { slot: string }).slot))).toEqual([
      Date.parse(slotAt(4, '10:00')),
      Date.parse(newSlot),
    ]);
  });
});

describe('appointments_minute_tick', () => {
  it('runs every step without error', async () => {
    const { error } = await f.admin.rpc('appointments_minute_tick');
    expect(error).toBeNull();
  });
});
