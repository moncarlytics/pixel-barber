// tests/db/appointment-reminder-sending.test.ts
// @vitest-environment node
// send-notifications (deployed, live sending OFF, allowlist set on this shared project) decides
// reminder rows: a current reminder ends 'not_allowlisted'/'sms_disabled' (never sent); one for a
// cancelled appointment or an old slot ends 'stale'. The live 30-second cron may process the rows
// too -- the outcome is identical, so the test polls until none are pending.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  createAppointmentFixture,
  slotAt,
  type AppointmentFixture,
} from './fixtures/appointments';
import { callFunction } from './fixtures/staff-invite';

let f: AppointmentFixture;
const serviceRoleKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function insertAppt(customerIdx: number, start: string) {
  const { data, error } = await f.admin
    .from('appointments')
    .insert({
      customer_id: f.customers[customerIdx].customerId,
      branch_id: f.branchId,
      branch_service_id: f.branchServiceId,
      preferred_barber_id: f.barberB.barberId,
      scheduled_start: start,
      scheduled_end: new Date(Date.parse(start) + 30 * 60_000).toISOString(),
      status: 'scheduled',
      created_by: 'customer',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

async function insertReminder(appointmentId: string, customerIdx: number, slot: string) {
  const { data, error } = await f.admin
    .from('notifications')
    .insert({
      recipient_type: 'customer',
      recipient_id: f.customers[customerIdx].customerId,
      channel: 'sms',
      notification_type: 'appointment_reminder_hour',
      related_appointment_id: appointmentId,
      payload: { slot },
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

beforeAll(async () => {
  f = await createAppointmentFixture();
  await f.admin
    .from('customers')
    .update({ sms_backup_enabled: true })
    .in(
      'id',
      f.customers.map((c) => c.customerId),
    );
}, 90000);

afterAll(async () => {
  await cleanupAppointmentFixture(f);
}, 90000);

describe('send-notifications with reminders', () => {
  it('decides current, cancelled and moved reminders', async () => {
    const currentSlot = slotAt(2, '10:00');
    const current = await insertAppt(0, currentSlot);
    const cancelled = await insertAppt(1, slotAt(2, '11:00'));
    const movedFrom = slotAt(2, '12:00');
    const moved = await insertAppt(2, movedFrom);

    const ids = {
      current: await insertReminder(current, 0, currentSlot),
      cancelled: await insertReminder(cancelled, 1, slotAt(2, '11:00')),
      moved: await insertReminder(moved, 2, movedFrom),
    };
    await f.admin
      .from('appointments')
      .update({
        status: 'cancelled',
        cancel_reason: 'other',
        cancelled_at: new Date().toISOString(),
      })
      .eq('id', cancelled);
    await f.admin
      .from('appointments')
      .update({ scheduled_start: slotAt(2, '13:00'), scheduled_end: slotAt(2, '13:30') })
      .eq('id', moved);

    const deadline = Date.now() + 60_000;
    let rows: { id: string; status: string; failed_reason: string | null }[] = [];
    while (Date.now() < deadline) {
      await callFunction('send-notifications', {}, serviceRoleKey());
      const { data } = await f.admin
        .from('notifications')
        .select('id, status, failed_reason')
        .in('id', Object.values(ids));
      rows = data ?? [];
      if (rows.length === 3 && rows.every((r) => r.status !== 'pending')) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const byId = (id: string) => rows.find((r) => r.id === id)!;
    expect(rows.every((r) => r.status === 'failed')).toBe(true);
    expect(['not_allowlisted', 'sms_disabled']).toContain(byId(ids.current).failed_reason);
    expect(byId(ids.cancelled).failed_reason).toBe('stale');
    expect(byId(ids.moved).failed_reason).toBe('stale');
  }, 90000);
});
