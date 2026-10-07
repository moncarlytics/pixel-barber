// tests/db/push-subscriptions.test.ts
// @vitest-environment node
// save_push_subscription / remove_push_subscription (web push spec, Section 1): a customer saves
// this device's subscription (and push turns on), the same endpoint moves to whoever signs in on
// the device last, removal only touches the caller's own row, staff and bad endpoints are refused.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  createAppointmentFixture,
  type AppointmentFixture,
} from './fixtures/appointments';

let f: AppointmentFixture;
const endpoint = () => `https://push.example.test/db-test/${f.suffix}`;

async function rowFor(e: string) {
  const { data, error } = await f.admin
    .from('push_subscriptions')
    .select('customer_id, p256dh_key, auth_key, user_agent')
    .eq('endpoint', e)
    .maybeSingle();
  if (error) throw error;
  return data;
}

beforeAll(async () => {
  f = await createAppointmentFixture();
}, 90000);

afterAll(async () => {
  await f.admin.from('push_subscriptions').delete().like('endpoint', `%/db-test/${f.suffix}%`);
  await cleanupAppointmentFixture(f);
}, 90000);

describe('save_push_subscription', () => {
  it('saves this device for the customer and turns push on', async () => {
    await f.admin
      .from('customers')
      .update({ push_enabled: false })
      .eq('id', f.customers[0].customerId);
    const { error } = await f.customers[0].client.rpc('save_push_subscription', {
      p_endpoint: endpoint(),
      p_p256dh: 'p256-a',
      p_auth: 'auth-a',
      p_user_agent: 'test-agent',
    });
    expect(error).toBeNull();
    expect(await rowFor(endpoint())).toEqual({
      customer_id: f.customers[0].customerId,
      p256dh_key: 'p256-a',
      auth_key: 'auth-a',
      user_agent: 'test-agent',
    });
    const { data } = await f.admin
      .from('customers')
      .select('push_enabled')
      .eq('id', f.customers[0].customerId)
      .single();
    expect(data!.push_enabled).toBe(true);
  });

  it('moves the endpoint to whoever saves it last, with the new keys', async () => {
    const { error } = await f.customers[1].client.rpc('save_push_subscription', {
      p_endpoint: endpoint(),
      p_p256dh: 'p256-b',
      p_auth: 'auth-b',
      p_user_agent: 'test-agent-2',
    });
    expect(error).toBeNull();
    expect(await rowFor(endpoint())).toMatchObject({
      customer_id: f.customers[1].customerId,
      p256dh_key: 'p256-b',
      auth_key: 'auth-b',
    });
  });

  it('refuses staff and endpoints that are not https', async () => {
    const staff = await f.barberClient.rpc('save_push_subscription', {
      p_endpoint: `${endpoint()}/staff`,
      p_p256dh: 'p',
      p_auth: 'a',
      p_user_agent: 'x',
    });
    expect(staff.error?.message).toBe('not_a_customer');
    const insecure = await f.customers[0].client.rpc('save_push_subscription', {
      p_endpoint: 'http://push.example.test/insecure',
      p_p256dh: 'p',
      p_auth: 'a',
      p_user_agent: 'x',
    });
    expect(insecure.error?.message).toBe('invalid_subscription');
    const empty = await f.customers[0].client.rpc('save_push_subscription', {
      p_endpoint: `${endpoint()}/empty`,
      p_p256dh: '',
      p_auth: 'a',
      p_user_agent: 'x',
    });
    expect(empty.error?.message).toBe('invalid_subscription');
  });
});

describe('remove_push_subscription', () => {
  it("only removes the caller's own row, without error when it isn't theirs", async () => {
    const notMine = await f.customers[0].client.rpc('remove_push_subscription', {
      p_endpoint: endpoint(),
    });
    expect(notMine.error).toBeNull();
    expect(await rowFor(endpoint())).not.toBeNull();
    const mine = await f.customers[1].client.rpc('remove_push_subscription', {
      p_endpoint: endpoint(),
    });
    expect(mine.error).toBeNull();
    expect(await rowFor(endpoint())).toBeNull();
  });
});

describe('direct table access', () => {
  const own = () => `${endpoint()}/own`;

  it('refuses direct inserts and updates but allows reading and deleting own rows', async () => {
    const client = f.customers[0].client;
    const insert = await client.from('push_subscriptions').insert({
      customer_id: f.customers[0].customerId,
      endpoint: `${own()}/direct`,
      p256dh_key: 'p',
      auth_key: 'a',
    });
    expect(insert.error).not.toBeNull();
    expect(await rowFor(`${own()}/direct`)).toBeNull();

    const saved = await client.rpc('save_push_subscription', {
      p_endpoint: own(),
      p_p256dh: 'p256-own',
      p_auth: 'auth-own',
      p_user_agent: 'x',
    });
    expect(saved.error).toBeNull();

    const update = await client
      .from('push_subscriptions')
      .update({ p256dh_key: 'tampered' })
      .eq('endpoint', own())
      .select();
    expect(update.data ?? []).toHaveLength(0);
    expect((await rowFor(own()))!.p256dh_key).toBe('p256-own');

    const read = await client.from('push_subscriptions').select('endpoint').eq('endpoint', own());
    expect(read.data).toEqual([{ endpoint: own() }]);
    const otherRead = await f.customers[1].client
      .from('push_subscriptions')
      .select('endpoint')
      .eq('endpoint', own());
    expect(otherRead.data).toEqual([]);

    const del = await client.from('push_subscriptions').delete().eq('endpoint', own()).select();
    expect(del.error).toBeNull();
    expect(del.data).toHaveLength(1);
    expect(await rowFor(own())).toBeNull();
  });

  it('still saves and removes through the functions', async () => {
    const client = f.customers[0].client;
    const saved = await client.rpc('save_push_subscription', {
      p_endpoint: `${own()}/rpc`,
      p_p256dh: 'p',
      p_auth: 'a',
      p_user_agent: 'x',
    });
    expect(saved.error).toBeNull();
    expect(await rowFor(`${own()}/rpc`)).not.toBeNull();
    const removed = await client.rpc('remove_push_subscription', { p_endpoint: `${own()}/rpc` });
    expect(removed.error).toBeNull();
    expect(await rowFor(`${own()}/rpc`)).toBeNull();
  });
});
