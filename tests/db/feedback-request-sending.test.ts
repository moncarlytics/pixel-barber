// tests/db/feedback-request-sending.test.ts
// @vitest-environment node
// send-notifications decides feedback_request rows (deployed, live SMS off): a request for an
// unrated visit takes the SMS path (customers here have no push devices) and ends
// not_allowlisted/sms_disabled; one whose visit was rated first ends stale.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  createAppointmentFixture,
  type AppointmentFixture,
} from './fixtures/appointments';
import { callFunction } from './fixtures/staff-invite';

let f: AppointmentFixture;
const serviceRoleKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function completedTicket(customerIdx: number) {
  const { data: t, error } = await f.admin
    .from('queue_tickets')
    .insert({
      ticket_number: `PB-FR-${f.suffix}-${customerIdx}`,
      branch_id: f.branchId,
      customer_id: f.customers[customerIdx].customerId,
      branch_service_id: f.branchServiceId,
      assigned_barber_id: customerIdx === 0 ? f.barberA.barberId : f.barberB.barberId,
      state: 'in_service',
      created_by: 'customer',
    })
    .select('id')
    .single();
  if (error) throw error;
  const { error: doneError } = await f.admin
    .from('queue_tickets')
    .update({ state: 'completed', completed_at: new Date().toISOString() })
    .eq('id', t.id);
  if (doneError) throw doneError;
  return t.id as string;
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

describe('send-notifications with feedback requests', () => {
  it('sends an unrated request down the SMS path and skips a rated one as stale', async () => {
    const unrated = await completedTicket(0);
    const rated = await completedTicket(1);
    const { error } = await f.customers[1].client.rpc('submit_feedback', {
      p_ticket_id: rated,
      p_overall: 5,
    });
    if (error) throw error;

    const deadline = Date.now() + 60_000;
    let rows: { related_ticket_id: string; status: string; failed_reason: string | null }[] = [];
    while (Date.now() < deadline) {
      await callFunction('send-notifications', {}, serviceRoleKey());
      const { data } = await f.admin
        .from('notifications')
        .select('related_ticket_id, status, failed_reason')
        .eq('notification_type', 'feedback_request')
        .in('related_ticket_id', [unrated, rated]);
      rows = data ?? [];
      if (rows.length === 2 && rows.every((r) => r.status !== 'pending')) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const byTicket = (id: string) => rows.find((r) => r.related_ticket_id === id)!;
    expect(byTicket(unrated).status).toBe('failed');
    expect(['not_allowlisted', 'sms_disabled']).toContain(byTicket(unrated).failed_reason);
    expect(byTicket(rated)).toMatchObject({ status: 'failed', failed_reason: 'stale' });
  }, 90000);
});
