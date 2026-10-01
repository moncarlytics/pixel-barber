// tests/db/send-notifications.test.ts
// @vitest-environment node
// send-notifications (deployed, live sending OFF on this shared project): every pending 'youre_next'
// notification ends with the right reason, and nothing is ever texted. The live 30-second cron job
// may process these rows too -- the outcome is identical, so the test polls until none are pending.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  callFunction,
  cleanupStaffInviteFixture,
  createStaffInviteFixture,
  type StaffInviteFixture,
} from './fixtures/staff-invite';

type Reason = 'stale' | 'expired' | 'opted_out' | 'no_phone' | 'sms_disabled';
// 'stale_waiting' is a second case proving the "only almost_turn is sendable" rule: a ticket back in
// 'waiting' is stale even with a fresh notification. It is a distinct case label from the reason it
// expects ('stale'), unlike every other label here, so its expected reason is looked up separately.
// The your_turn / ticket_released cases prove those types are claimed and decided by their own
// sendable states (called/grace_period and no_show) rather than youre_next's.
type CaseLabel =
  | Reason
  | 'stale_waiting'
  | 'turn_disabled'
  | 'turn_stale'
  | 'released_disabled'
  | 'released_stale';

let f: StaffInviteFixture;
const customerIds: string[] = [];
const ticketIds: string[] = [];
const notificationIds: Partial<Record<CaseLabel, string>> = {};
const expectedReason: Record<CaseLabel, Reason> = {
  stale: 'stale',
  expired: 'expired',
  opted_out: 'opted_out',
  no_phone: 'no_phone',
  sms_disabled: 'sms_disabled',
  stale_waiting: 'stale',
  turn_disabled: 'sms_disabled',
  turn_stale: 'stale',
  released_disabled: 'sms_disabled',
  released_stale: 'stale',
};
const serviceRoleKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY!;
const anonKey = () => process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

async function makeCase(
  label: CaseLabel,
  opts: {
    // Only 'almost_turn' is sendable; 'waiting' proves the stale_waiting case; 'called' proves the
    // plain stale case.
    ticketState?: 'waiting' | 'almost_turn' | 'called' | 'completed' | 'no_show';
    type?: 'youre_next' | 'your_turn' | 'ticket_released';
    smsBackup?: boolean;
    phone?: string | null;
    ageMinutes?: number;
  },
) {
  const { data: customer, error: customerError } = await f.admin
    .from('customers')
    .insert({
      name: `SN Customer ${label} ${f.suffix}`,
      phone_e164:
        opts.phone === undefined ? `+23356${f.suffix.slice(-6)}${customerIds.length}` : opts.phone,
      sms_backup_enabled: opts.smsBackup ?? true,
    })
    .select('id')
    .single();
  if (customerError) throw customerError;
  customerIds.push(customer!.id);
  const { data: ticket, error: ticketError } = await f.admin
    .from('queue_tickets')
    .insert({
      ticket_number: `PB-SN-${label}-${f.suffix}`,
      branch_id: f.branchId,
      customer_id: customer!.id,
      branch_service_id: f.branchServiceId,
      state: opts.ticketState ?? 'almost_turn',
      created_by: 'staff',
    })
    .select('id')
    .single();
  if (ticketError) throw ticketError;
  ticketIds.push(ticket!.id);
  const { data: notification, error } = await f.admin
    .from('notifications')
    .insert({
      recipient_type: 'customer',
      recipient_id: customer!.id,
      channel: 'sms',
      notification_type: opts.type ?? 'youre_next',
      related_ticket_id: ticket!.id,
      created_at: new Date(Date.now() - (opts.ageMinutes ?? 0) * 60_000).toISOString(),
    })
    .select('id')
    .single();
  if (error) throw error;
  notificationIds[label] = notification!.id;
}

beforeAll(async () => {
  f = await createStaffInviteFixture();
  await makeCase('stale', { ticketState: 'called' });
  await makeCase('expired', { ageMinutes: 11 });
  await makeCase('opted_out', { smsBackup: false });
  await makeCase('no_phone', { phone: null });
  await makeCase('sms_disabled', {});
  await makeCase('stale_waiting', { ticketState: 'waiting' });
  await makeCase('turn_disabled', { type: 'your_turn', ticketState: 'called' });
  await makeCase('turn_stale', { type: 'your_turn', ticketState: 'completed' });
  await makeCase('released_disabled', { type: 'ticket_released', ticketState: 'no_show' });
  await makeCase('released_stale', { type: 'ticket_released', ticketState: 'waiting' });
}, 60000);

afterAll(async () => {
  await f.admin.from('notifications').delete().in('related_ticket_id', ticketIds);
  await f.admin.from('queue_tickets').delete().in('id', ticketIds);
  await f.admin.from('customers').delete().in('id', customerIds);
  await cleanupStaffInviteFixture(f);
}, 60000);

describe('send-notifications', () => {
  it('refuses callers without the service role key', async () => {
    expect((await callFunction('send-notifications', {})).status).toBe(401);
    expect((await callFunction('send-notifications', {}, anonKey())).status).toBe(401);
  });

  it('records the right reason for every notification and sends nothing while live sending is off', async () => {
    const ids = Object.values(notificationIds) as string[];
    let rows: {
      id: string;
      status: string;
      failed_reason: string | null;
      sent_at: string | null;
    }[] = [];
    for (let i = 0; i < 12; i++) {
      const result = await callFunction('send-notifications', {}, serviceRoleKey());
      expect(result.status).toBe(200);
      expect(JSON.stringify(result.body)).not.toMatch(/\+233/);
      const { data } = await f.admin
        .from('notifications')
        .select('id, status, failed_reason, sent_at')
        .in('id', ids);
      rows = data ?? [];
      if (rows.length === ids.length && rows.every((r) => r.status !== 'pending')) break;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const [label, id] of Object.entries(notificationIds)) {
      const expected = expectedReason[label as CaseLabel];
      const row = byId.get(id!);
      expect(row).toMatchObject({ status: 'failed', sent_at: null });
      // A row that would have been texted is 'sms_disabled' -- or 'not_allowlisted' when this
      // project has an SMS_NOTIFICATIONS_ALLOWLIST set for a manual live test (that check runs
      // first). Either way nothing was sent.
      if (expected === 'sms_disabled') {
        expect(['sms_disabled', 'not_allowlisted']).toContain(row!.failed_reason);
      } else {
        expect(row!.failed_reason).toBe(expected);
      }
    }
  }, 60000);
});
