// tests/db/staff-message-sending.test.ts
// @vitest-environment node
// send-notifications delivers staff_message rows (deployed, live SMS off): a message to a customer
// with no push devices takes the SMS path and ends not_allowlisted/sms_disabled (not stale).
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
import { callFunction } from './fixtures/staff-invite';

let f: AppointmentFixture;
let reception: Awaited<ReturnType<typeof createStaffLogin>>;
const serviceRoleKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY!;

beforeAll(async () => {
  f = await createAppointmentFixture();
  reception = await createStaffLogin(f, 'smr', 'receptionist', f.branchId);
  const customer = f.customers[0]!;
  await f.admin
    .from('customers')
    .update({ sms_backup_enabled: true })
    .eq('id', customer.customerId);
  const { error } = await f.admin.from('queue_tickets').insert({
    ticket_number: `PB-SM-${f.suffix}`,
    branch_id: f.branchId,
    customer_id: customer.customerId,
    branch_service_id: f.branchServiceId,
    state: 'completed',
    completed_at: new Date().toISOString(),
    created_by: 'customer',
  });
  if (error) throw error;
}, 90000);

afterAll(async () => {
  const { error } = await f.admin
    .from('notifications')
    .delete()
    .eq('notification_type', 'staff_message')
    .in(
      'recipient_id',
      f.customers.map((c) => c.customerId),
    );
  if (error) throw error;
  await cleanupStaffLogin(f, reception);
  await cleanupAppointmentFixture(f);
}, 90000);

describe('send-notifications with staff messages', () => {
  it('sends a staff message down the SMS path instead of skipping it', async () => {
    const { data: id, error } = await reception.client.rpc('send_customer_message', {
      p_customer_id: f.customers[0]!.customerId,
      p_branch_id: f.branchId,
      p_text: 'Your barber is running 15 minutes late.',
    });
    if (error) throw error;

    const deadline = Date.now() + 60_000;
    let row: { status: string; failed_reason: string | null } | null = null;
    while (Date.now() < deadline) {
      await callFunction('send-notifications', {}, serviceRoleKey());
      const { data } = await f.admin
        .from('notifications')
        .select('status, failed_reason')
        .eq('id', id as string)
        .single();
      row = data;
      if (row && row.status !== 'pending') break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(row?.status).toBe('failed');
    expect(['not_allowlisted', 'sms_disabled']).toContain(row?.failed_reason);
  }, 90000);
});
