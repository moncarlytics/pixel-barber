// tests/db/push-sending.test.ts
// @vitest-environment node
// send-notifications push-first (web push spec, Section 2), against the deployed function on
// staging: a customer whose saved device accepts the push gets it by push (channel 'push', status
// 'sent') and a device the push service calls gone (410) is deleted; a customer with no device, or
// whose only device is gone, takes the SMS path (live SMS is off here, so it ends not_allowlisted or
// sms_disabled). Stand-in push endpoints: httpbin.org/status/201 and /status/410 (public, external).
// Subscriber keys are real P-256 keys so the library can encrypt to them.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { webcrypto } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  createAppointmentFixture,
  type AppointmentFixture,
} from './fixtures/appointments';
import { callFunction } from './fixtures/staff-invite';

let f: AppointmentFixture;
const serviceRoleKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ACCEPTS = 'https://httpbin.org/status/201';
const GONE = 'https://httpbin.org/status/410';

async function subscriberKeys() {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const raw = Buffer.from(await webcrypto.subtle.exportKey('raw', pair.publicKey));
  return {
    p256dh: raw.toString('base64url'),
    auth: Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
  };
}

async function addDevice(customerIdx: number, endpoint: string) {
  const keys = await subscriberKeys();
  const { error } = await f.admin.from('push_subscriptions').insert({
    customer_id: f.customers[customerIdx].customerId,
    // A query string keeps each test endpoint unique (endpoint is unique) while httpbin ignores it.
    endpoint: `${endpoint}?t=${f.suffix}-${customerIdx}`,
    p256dh_key: keys.p256dh,
    auth_key: keys.auth,
  });
  if (error) throw error;
}

/** An 'almost_turn' ticket for the customer with a pending youre_next notification. */
async function youreNext(customerIdx: number) {
  const { data: ticket, error } = await f.admin
    .from('queue_tickets')
    .insert({
      ticket_number: `PB-PS-${f.suffix}-${customerIdx}`,
      branch_id: f.branchId,
      customer_id: f.customers[customerIdx].customerId,
      branch_service_id: f.branchServiceId,
      assigned_barber_id: f.barberB.barberId,
      state: 'almost_turn',
      position: 2,
      created_by: 'customer',
    })
    .select('id')
    .single();
  if (error) throw error;
  const { data: n, error: nError } = await f.admin
    .from('notifications')
    .insert({
      recipient_type: 'customer',
      recipient_id: f.customers[customerIdx].customerId,
      channel: 'sms',
      notification_type: 'youre_next',
      related_ticket_id: ticket.id,
      payload: {},
    })
    .select('id')
    .single();
  if (nError) throw nError;
  return n.id as string;
}

beforeAll(async () => {
  f = await createAppointmentFixture();
  await f.admin
    .from('customers')
    .update({ push_enabled: true, sms_backup_enabled: true })
    .in(
      'id',
      f.customers.map((c) => c.customerId),
    );
}, 90000);

afterAll(async () => {
  await f.admin
    .from('push_subscriptions')
    .delete()
    .in(
      'customer_id',
      f.customers.map((c) => c.customerId),
    );
  await cleanupAppointmentFixture(f);
}, 90000);

describe('send-notifications push first', () => {
  it('pushes when a device accepts, deletes gone devices, and falls back to SMS otherwise', async () => {
    await addDevice(0, ACCEPTS);
    await addDevice(0, GONE);
    await addDevice(2, GONE);
    const ids = {
      pushed: await youreNext(0),
      noDevice: await youreNext(1),
      allGone: await youreNext(2),
    };

    const deadline = Date.now() + 75_000;
    let rows: { id: string; channel: string; status: string; failed_reason: string | null }[] = [];
    while (Date.now() < deadline) {
      await callFunction('send-notifications', {}, serviceRoleKey());
      const { data } = await f.admin
        .from('notifications')
        .select('id, channel, status, failed_reason')
        .in('id', Object.values(ids));
      rows = data ?? [];
      if (rows.length === 3 && rows.every((r) => r.status !== 'pending')) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const byId = (id: string) => rows.find((r) => r.id === id)!;
    expect(byId(ids.pushed)).toMatchObject({
      channel: 'push',
      status: 'sent',
      failed_reason: null,
    });
    for (const id of [ids.noDevice, ids.allGone]) {
      expect(byId(id).channel).toBe('sms');
      expect(byId(id).status).toBe('failed');
      expect(['not_allowlisted', 'sms_disabled']).toContain(byId(id).failed_reason);
    }

    const { data: left } = await f.admin
      .from('push_subscriptions')
      .select('customer_id, endpoint')
      .in(
        'customer_id',
        f.customers.map((c) => c.customerId),
      );
    expect(left).toEqual([
      { customer_id: f.customers[0].customerId, endpoint: `${ACCEPTS}?t=${f.suffix}-0` },
    ]);
  }, 120000);
});
