// tests/db/youre-next-notifications.test.ts
// @vitest-environment node
// Becoming second in line records exactly one 'youre_next' SMS notification per ticket, even if the
// ticket drops back and becomes next again; claim_sms_notifications hands each pending row to only
// one caller and is refused for client roles. (Status isn't asserted for youre_next rows: the live
// 30-second sender may already have processed them.)
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupStaffInviteFixture,
  createStaffAccount,
  createStaffInviteFixture,
  type StaffAccount,
  type StaffInviteFixture,
} from './fixtures/staff-invite';

let f: StaffInviteFixture;
let barber: StaffAccount;
const customerIds: string[] = [];
const ticketIds: string[] = [];
const tickets: Record<'a' | 'b' | 'c', string> = {} as never;
const claimType = () => `test_claim_${f.suffix}`;

async function makeTicket(label: 'a' | 'b' | 'c', createdAt: string) {
  const digit = { a: '1', b: '2', c: '3' }[label];
  const { data: customer, error: customerError } = await f.admin
    .from('customers')
    .insert({
      name: `YN Customer ${label} ${f.suffix}`,
      phone_e164: `+23355${f.suffix.slice(-6)}${digit}`,
    })
    .select('id')
    .single();
  if (customerError) throw customerError;
  customerIds.push(customer!.id);
  const { data: ticket, error } = await f.admin
    .from('queue_tickets')
    .insert({
      ticket_number: `PB-YN-${label}-${f.suffix}`,
      branch_id: f.branchId,
      customer_id: customer!.id,
      branch_service_id: f.branchServiceId,
      assigned_barber_id: barber.barberId,
      state: 'waiting',
      created_by: 'staff',
      created_at: createdAt,
    })
    .select('id')
    .single();
  if (error) throw error;
  ticketIds.push(ticket!.id);
  return ticket!.id as string;
}

async function recalc() {
  const { error } = await f.admin.rpc('recalculate_positions', {
    p_branch_id: f.branchId,
    p_barber_id: barber.barberId!,
  });
  if (error) throw error;
}

async function youreNextFor(ticketId: string) {
  const { data } = await f.admin
    .from('notifications')
    .select('id, recipient_type, recipient_id, channel, notification_type')
    .eq('related_ticket_id', ticketId)
    .eq('notification_type', 'youre_next');
  return data ?? [];
}

beforeAll(async () => {
  f = await createStaffInviteFixture();
  barber = await createStaffAccount(f, {
    label: 'ynbarber',
    role: 'barber',
    inviteStatus: 'accepted',
  });
  const base = Date.now() - 60_000;
  tickets.a = await makeTicket('a', new Date(base).toISOString());
  tickets.b = await makeTicket('b', new Date(base + 1000).toISOString());
  tickets.c = await makeTicket('c', new Date(base + 2000).toISOString());
}, 60000);

afterAll(async () => {
  await f.admin.from('notifications').delete().in('related_ticket_id', ticketIds);
  await f.admin.from('queue_events').delete().in('ticket_id', ticketIds);
  await f.admin.from('queue_tickets').delete().in('id', ticketIds);
  await f.admin.from('customers').delete().in('id', customerIds);
  await cleanupStaffInviteFixture(f);
}, 60000);

describe("recording 'youre_next'", () => {
  it('records one youre_next for the ticket that becomes second in line, and none for the others', async () => {
    await recalc();
    const { data: b } = await f.admin
      .from('queue_tickets')
      .select('state')
      .eq('id', tickets.b)
      .single();
    expect(b!.state).toBe('almost_turn');

    const forB = await youreNextFor(tickets.b);
    expect(forB).toHaveLength(1);
    expect(forB[0]).toMatchObject({ recipient_type: 'customer', channel: 'sms' });
    expect(await youreNextFor(tickets.a)).toHaveLength(0);
    expect(await youreNextFor(tickets.c)).toHaveLength(0);
  }, 30000);

  it('never records a second youre_next when a ticket drops back and becomes next again', async () => {
    // Skipping B sends it to the back: C becomes next.
    await f.admin
      .from('queue_tickets')
      .update({ skipped_at: new Date().toISOString() })
      .eq('id', tickets.b);
    await recalc();
    const { data: c } = await f.admin
      .from('queue_tickets')
      .select('state')
      .eq('id', tickets.c)
      .single();
    expect(c!.state).toBe('almost_turn');
    expect(await youreNextFor(tickets.c)).toHaveLength(1);

    // Un-skipping B makes it next again.
    await f.admin.from('queue_tickets').update({ skipped_at: null }).eq('id', tickets.b);
    await recalc();
    const { data: b } = await f.admin
      .from('queue_tickets')
      .select('state')
      .eq('id', tickets.b)
      .single();
    expect(b!.state).toBe('almost_turn');
    expect(await youreNextFor(tickets.b)).toHaveLength(1);
  }, 30000);
});

describe('claim_sms_notifications', () => {
  it('gives each pending row to exactly one of two overlapping claims, with its ticket and branch details', async () => {
    const rows = [tickets.a, tickets.b, tickets.c].map((ticketId, i) => ({
      recipient_type: 'customer' as const,
      recipient_id: customerIds[i],
      channel: 'sms' as const,
      notification_type: claimType(),
      related_ticket_id: ticketId,
    }));
    const { data: inserted, error } = await f.admin.from('notifications').insert(rows).select('id');
    expect(error).toBeNull();
    const insertedIds = new Set(inserted!.map((r) => r.id));

    const claim = () =>
      f.admin.rpc('claim_sms_notifications', { p_types: [claimType()], p_limit: 50 });
    const [first, second] = await Promise.all([claim(), claim()]);
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    const firstIds = (first.data ?? []).map((r) => r.notification_id);
    const secondIds = (second.data ?? []).map((r) => r.notification_id);
    expect(firstIds.filter((id) => secondIds.includes(id))).toHaveLength(0);
    expect(new Set([...firstIds, ...secondIds])).toEqual(insertedIds);

    const sample = [...(first.data ?? []), ...(second.data ?? [])][0];
    expect(sample.branch_name).toBe(f.branchName);
    expect(sample.phone_e164).toMatch(/^\+23355/);
    expect(sample.ticket_number).toMatch(/^PB-YN-/);
    expect(sample.dispatch_attempts).toBe(1);
    expect(sample.sms_backup_enabled).toBe(true);

    // Freshly claimed rows are not handed out again.
    const { data: again } = await claim();
    expect(again ?? []).toHaveLength(0);
  }, 30000);

  it('is refused for client roles', async () => {
    const { error } = await f.owner.client.rpc('claim_sms_notifications', {
      p_types: [claimType()],
      p_limit: 50,
    });
    expect(error).not.toBeNull();
  });
});
