// tests/db/feedback-submit.test.ts
// @vitest-environment node
// After-visit feedback (spec Section 1): submit_feedback's rules (own completed ticket, 7 days, once,
// rating/comment validation, branch and barber taken from the ticket), the direct insert closed,
// list_my_feedback, and the feedback_request notification queued once on completion for app
// customers only.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { updateTicketWithVersion } from '@pixel-barber/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  createAppointmentFixture,
  type AppointmentFixture,
} from './fixtures/appointments';

let f: AppointmentFixture;
const DAY = 24 * 60 * 60 * 1000;
let walkInId: string | null = null;

/** A ticket for the customer, assigned to barber B, in the given state. */
async function ticket(
  customerId: string,
  state: 'in_service' | 'completed' | 'waiting',
  completedAt?: string,
) {
  const { data, error } = await f.admin
    .from('queue_tickets')
    .insert({
      ticket_number: `PB-FB-${f.suffix}-${Math.random().toString(36).slice(2, 7)}`,
      branch_id: f.branchId,
      customer_id: customerId,
      branch_service_id: f.branchServiceId,
      assigned_barber_id: f.barberB.barberId,
      state,
      completed_at: completedAt ?? (state === 'completed' ? new Date().toISOString() : null),
      created_by: 'customer',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

async function feedbackRequests(ticketId: string) {
  const { data, error } = await f.admin
    .from('notifications')
    .select('id, recipient_id, channel, status')
    .eq('related_ticket_id', ticketId)
    .eq('notification_type', 'feedback_request');
  if (error) throw error;
  return data ?? [];
}

const submit = (customerIdx: number, args: Record<string, unknown>) =>
  f.customers[customerIdx].client.rpc('submit_feedback', args as never);

beforeAll(async () => {
  f = await createAppointmentFixture();
}, 90000);

afterAll(async () => {
  if (walkInId) {
    const { data: t } = await f.admin
      .from('queue_tickets')
      .select('id')
      .eq('customer_id', walkInId);
    const ids = (t ?? []).map((r) => r.id);
    if (ids.length) {
      await f.admin.from('notifications').delete().in('related_ticket_id', ids);
      await f.admin.from('queue_events').delete().in('ticket_id', ids);
      await f.admin.from('queue_tickets').delete().in('id', ids);
    }
    await f.admin.from('customers').delete().eq('id', walkInId);
  }
  await cleanupAppointmentFixture(f);
}, 90000);

describe('submit_feedback', () => {
  it('saves a rating for your own completed visit, with branch and barber from the ticket', async () => {
    const t = await ticket(f.customers[0].customerId, 'completed');
    const { data: id, error } = await submit(0, {
      p_ticket_id: t,
      p_overall: 4,
      p_cleanliness: 5,
      p_comment: '  Great fade  ',
    });
    expect(error).toBeNull();
    const { data } = await f.admin
      .from('feedback')
      .select('*')
      .eq('id', id as string)
      .single();
    expect(data).toMatchObject({
      ticket_id: t,
      customer_id: f.customers[0].customerId,
      branch_id: f.branchId,
      barber_id: f.barberB.barberId,
      overall_rating: 4,
      cleanliness_rating: 5,
      service_quality_rating: null,
      comment: 'Great fade',
    });
    const again = await submit(0, { p_ticket_id: t, p_overall: 5 });
    expect(again.error?.message).toBe('already_submitted');
  });

  it("refuses someone else's ticket, unfinished visits and old visits", async () => {
    const other = await ticket(f.customers[1].customerId, 'completed');
    expect((await submit(0, { p_ticket_id: other, p_overall: 3 })).error?.message).toBe(
      'not_found',
    );
    const unfinished = await ticket(f.customers[2].customerId, 'in_service');
    expect((await submit(2, { p_ticket_id: unfinished, p_overall: 3 })).error?.message).toBe(
      'not_completed',
    );
    await f.admin
      .from('queue_tickets')
      .update({ state: 'completed', completed_at: new Date(Date.now() - 8 * DAY).toISOString() })
      .eq('id', unfinished);
    expect((await submit(2, { p_ticket_id: unfinished, p_overall: 3 })).error?.message).toBe(
      'too_late',
    );
  });

  it('validates ratings and the comment', async () => {
    const t = await ticket(f.customers[3].customerId, 'completed');
    expect((await submit(3, { p_ticket_id: t, p_overall: 0 })).error?.message).toBe(
      'invalid_rating',
    );
    expect((await submit(3, { p_ticket_id: t, p_overall: 3, p_value: 6 })).error?.message).toBe(
      'invalid_rating',
    );
    expect(
      (await submit(3, { p_ticket_id: t, p_overall: 3, p_comment: 'x'.repeat(1001) })).error
        ?.message,
    ).toBe('invalid_comment');
    const ok = await submit(3, { p_ticket_id: t, p_overall: 2, p_comment: '   ' });
    expect(ok.error).toBeNull();
    const { data } = await f.admin.from('feedback').select('comment').eq('ticket_id', t).single();
    expect(data!.comment).toBeNull();
  });

  it('cannot be bypassed with a direct insert', async () => {
    const t = await ticket(f.customers[1].customerId, 'completed');
    const { error } = await f.customers[1].client.from('feedback').insert({
      ticket_id: t,
      customer_id: f.customers[1].customerId,
      branch_id: f.branchId,
      barber_id: f.barberB.barberId,
      overall_rating: 5,
    });
    expect(error).not.toBeNull();
  });
});

describe('list_my_feedback', () => {
  it("lists only the caller's feedback with branch and barber names", async () => {
    const { data, error } = await f.customers[0].client.rpc('list_my_feedback');
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({
      branch_name: `Appt Main ${f.suffix}`,
      barber_name: 'Appt Barber b',
      overall_rating: 4,
      comment: 'Great fade',
    });
  });
});

describe('feedback request on completion', () => {
  it("queues one request when an app customer's ticket is completed", async () => {
    const t = await ticket(f.customers[2].customerId, 'in_service');
    expect(await feedbackRequests(t)).toHaveLength(0);
    await f.admin
      .from('queue_tickets')
      .update({ state: 'completed', completed_at: new Date().toISOString() })
      .eq('id', t);
    const rows = await feedbackRequests(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipient_id: f.customers[2].customerId, channel: 'sms' });
    // Re-saving a completed ticket doesn't queue another.
    await f.admin.from('queue_tickets').update({ state: 'completed' }).eq('id', t);
    expect(await feedbackRequests(t)).toHaveLength(1);
  });

  it("queues one request when the barber's own session completes the ticket", async () => {
    const { data: row, error: insErr } = await f.admin
      .from('queue_tickets')
      .insert({
        ticket_number: `PB-FB-${f.suffix}-${Math.random().toString(36).slice(2, 7)}`,
        branch_id: f.branchId,
        customer_id: f.customers[3].customerId,
        branch_service_id: f.branchServiceId,
        assigned_barber_id: f.barberA.barberId,
        state: 'in_service',
        created_by: 'customer',
      })
      .select('id, version')
      .single();
    if (insErr) throw insErr;
    const t = row.id as string;
    const res = await updateTicketWithVersion(f.barberClient as never, t, row.version as number, {
      state: 'completed',
      completed_at: new Date().toISOString(),
    });
    expect(res.success).toBe(true);
    const { data: after } = await f.admin
      .from('queue_tickets')
      .select('state')
      .eq('id', t)
      .single();
    expect(after!.state).toBe('completed');
    const rows = await feedbackRequests(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipient_id: f.customers[3].customerId });
  });

  it('queues nothing for a walk-in without an app account', async () => {
    const { data: walkIn, error } = await f.admin
      .from('customers')
      .insert({ name: `FB Walk-in ${f.suffix}`, phone_e164: `+233558${f.suffix.slice(-5)}9` })
      .select('id')
      .single();
    if (error) throw error;
    walkInId = walkIn.id;
    const t = await ticket(walkIn.id, 'in_service');
    await f.admin.from('queue_tickets').update({ state: 'completed' }).eq('id', t);
    expect(await feedbackRequests(t)).toHaveLength(0);
  });
});
