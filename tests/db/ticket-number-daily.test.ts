// tests/db/ticket-number-daily.test.ts
// @vitest-environment node
// Ticket numbers (PB-<branch code>-<n>) restart at 1 every Ghana day, so they must be unique per
// branch per day, not across all time: a branch's second day of business must be able to issue
// PB-<code>-1 again, while the same number twice on one day is still refused.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  createAppointmentFixture,
  dateAt,
  type AppointmentFixture,
} from './fixtures/appointments';

let f: AppointmentFixture;
let branchCode: string;

const ticket = (customerIdx: number, ticketNumber: string, createdAt: string) =>
  f.admin.from('queue_tickets').insert({
    ticket_number: ticketNumber,
    branch_id: f.branchId,
    customer_id: f.customers[customerIdx]!.customerId,
    branch_service_id: f.branchServiceId,
    state: 'completed',
    created_at: createdAt,
    completed_at: createdAt,
    created_by: 'staff',
  });

beforeAll(async () => {
  f = await createAppointmentFixture();
  const { data, error } = await f.admin
    .from('branches')
    .select('branch_code')
    .eq('id', f.branchId)
    .single();
  if (error) throw error;
  branchCode = data.branch_code;
}, 90000);

afterAll(async () => {
  await cleanupAppointmentFixture(f);
}, 90000);

describe('ticket numbers restart every day', () => {
  it("issues yesterday's first number again on a branch's second day", async () => {
    // Yesterday: the branch's first ticket, and the counter the generator left behind.
    const first = `PB-${branchCode}-1`;
    const { error: yesterdayError } = await ticket(0, first, `${dateAt(-1)}T10:00:00.000Z`);
    expect(yesterdayError).toBeNull();
    const { error: counterError } = await f.admin
      .from('branch_ticket_counters')
      .insert({ branch_id: f.branchId, ticket_date: dateAt(-1), last_seq: 1 });
    expect(counterError).toBeNull();

    // Today: the generator starts again at 1 and the ticket must be accepted.
    const { data: next, error: nextError } = await f.admin.rpc('next_ticket_number', {
      p_branch_id: f.branchId,
    });
    expect(nextError).toBeNull();
    expect(next).toBe(first);
    const { error: todayError } = await ticket(1, next as string, new Date().toISOString());
    expect(todayError).toBeNull();
  });

  it('still refuses the same number twice on the same day at the same branch', async () => {
    const number = `PB-${branchCode}-900`;
    const now = new Date().toISOString();
    expect((await ticket(2, number, now)).error).toBeNull();
    const { error } = await ticket(3, number, now);
    expect(error?.code).toBe('23505');
  });

  it('records the Ghana date the ticket was created', async () => {
    const number = `PB-${branchCode}-901`;
    const { error } = await ticket(2, number, `${dateAt(-3)}T23:30:00.000Z`);
    expect(error).toBeNull();
    const { data } = await f.admin
      .from('queue_tickets')
      .select('ticket_date')
      .eq('branch_id', f.branchId)
      .eq('ticket_number', number)
      .single();
    expect(data?.ticket_date).toBe(dateAt(-3));
  });
});
