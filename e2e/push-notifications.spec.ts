// e2e/push-notifications.spec.ts
// Web push, customer side: the ticket page offers "Turn on" when this device isn't set up; turning
// it on saves the device; the Profile switch removes and re-adds it; Log out removes it.
// Headless Chromium can't reach a real push service, so an init script fakes the browser's
// PushManager (state in localStorage) — this checks the app's own logic; real delivery is the
// documented manual phone check. Clicks use Enter and are scoped to <main>.
import { test, expect, type BrowserContext } from '@playwright/test';
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PASSWORD = 'Test-Password-123!';

async function signInAs(context: BrowserContext, baseURL: string | undefined, phone: string) {
  const { data } = await createClient<Database>(url, anonKey).auth.signInWithPassword({
    phone,
    password: PASSWORD,
  });
  const projectRef = new URL(url).hostname.split('.')[0];
  const cookieValue =
    'base64-' +
    Buffer.from(JSON.stringify(data.session), 'utf-8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  await context.addCookies([
    {
      name: `sb-${projectRef}-auth-token`,
      value: cookieValue,
      url: baseURL ?? 'http://localhost:3000',
    },
  ]);
}

/** Replaces the browser push service with a fake whose subscription lives in localStorage. */
async function fakePushService(context: BrowserContext, suffix: string) {
  await context.addInitScript((tag: string) => {
    const KEY = 'fake-push-endpoint';
    const make = (endpoint: string) => ({
      endpoint,
      toJSON() {
        return {
          endpoint,
          keys: {
            p256dh:
              'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
            auth: 'tBHItJI5svbpez7KI4CCXg',
          },
        };
      },
      async unsubscribe() {
        localStorage.removeItem(KEY);
        return true;
      },
    });
    // Headless Chromium reports Notification.permission as 'denied' even after grantPermissions.
    Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
    Notification.requestPermission = async () => 'granted';
    PushManager.prototype.getSubscription = async function () {
      const endpoint = localStorage.getItem(KEY);
      return (endpoint ? make(endpoint) : null) as unknown as PushSubscription;
    };
    PushManager.prototype.subscribe = async function () {
      const endpoint = `https://push.example.test/e2e/${tag}/${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(KEY, endpoint);
      return make(endpoint) as unknown as PushSubscription;
    };
  }, suffix);
}

test('turn on from the ticket page, switch off and on in Profile, log out removes the device', async ({
  page,
  context,
  baseURL,
}) => {
  test.skip(!url || !serviceRoleKey, 'Supabase env vars not set');
  test.setTimeout(120_000);
  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const suffix = String(Date.now());
  // 0553… : distinct from the phone ranges other test files use.
  const phone = `+233553${suffix.slice(-6)}`;

  let service: { id: string } | null = null;
  let branch: { id: string } | null = null;
  let bs: { id: string } | null = null;
  let authUserId: string | null = null;
  let customerId: string | null = null;

  const devices = async () => {
    const { data } = await admin
      .from('push_subscriptions')
      .select('endpoint')
      .eq('customer_id', customerId!);
    return (data ?? []).map((d) => d.endpoint);
  };

  try {
    const { data: business } = await admin.from('businesses').select('id').limit(1).single();
    service = (
      await admin
        .from('services')
        .insert({
          business_id: business!.id,
          name: `Push E2E Cut ${suffix}`,
          default_duration_minutes: 30,
        })
        .select('id')
        .single()
    ).data;
    branch = (
      await admin
        .from('branches')
        .insert({
          business_id: business!.id,
          name: `Push E2E Branch ${suffix}`,
          branch_code: `PU${suffix.slice(-6)}`,
          address: 'Test',
          latitude: 5.6,
          longitude: -0.18,
        })
        .select('id')
        .single()
    ).data;
    bs = (
      await admin
        .from('branch_services')
        .insert({ branch_id: branch!.id, service_id: service!.id })
        .select('id')
        .single()
    ).data;
    const { data: auth } = await admin.auth.admin.createUser({
      phone,
      password: PASSWORD,
      phone_confirm: true,
    });
    authUserId = auth.user!.id;
    customerId = (
      await admin
        .from('customers')
        .insert({
          auth_user_id: authUserId,
          name: 'Push E2E Customer',
          phone_e164: phone,
          avatar_key: 'avatar-1',
        })
        .select('id')
        .single()
    ).data!.id;
    const { data: ticket } = await admin
      .from('queue_tickets')
      .insert({
        ticket_number: `PB-PU-${suffix}`,
        branch_id: branch!.id,
        customer_id: customerId!,
        branch_service_id: bs!.id,
        state: 'waiting',
        created_by: 'customer',
      })
      .select('id')
      .single();

    await context.grantPermissions(['notifications']);
    await fakePushService(context, suffix);
    await signInAs(context, baseURL, phone);
    const main = page.locator('main');

    // --- 1. Ticket page offers Turn on; turning on saves this device ---
    await page.goto(`/tickets/${ticket!.id}`);
    await expect(main.getByText("Get a notification when it's your turn.")).toBeVisible({
      timeout: 15000,
    });
    await main.getByRole('button', { name: 'Turn on' }).press('Enter');
    await expect(main.getByText("Get a notification when it's your turn.")).toHaveCount(0, {
      timeout: 15000,
    });
    await expect.poll(devices, { timeout: 15000 }).toHaveLength(1);

    // --- 2. Profile switch off removes it, on adds it back ---
    await page.goto('/profile');
    const pushSwitch = main.getByLabel('Push notifications');
    await expect(pushSwitch).toBeChecked({ timeout: 15000 });
    // The switch only flips once the push call finishes, so click and then wait (uncheck() would not).
    await pushSwitch.click();
    await expect(pushSwitch).not.toBeChecked({ timeout: 15000 });
    await expect.poll(devices, { timeout: 15000 }).toHaveLength(0);
    await pushSwitch.click();
    await expect(pushSwitch).toBeChecked({ timeout: 15000 });
    await expect.poll(devices, { timeout: 15000 }).toHaveLength(1);

    // --- 3. Log out removes this device ---
    await main.getByRole('button', { name: 'Log Out' }).press('Enter');
    await expect.poll(devices, { timeout: 15000 }).toHaveLength(0);
  } finally {
    const failures: string[] = [];
    const check = (label: string, res: { error: { message: string } | null }) => {
      if (res.error) failures.push(`${label}: ${res.error.message}`);
    };
    if (customerId) {
      check(
        'push_subscriptions',
        await admin.from('push_subscriptions').delete().eq('customer_id', customerId),
      );
    }
    if (branch) {
      const { data: tickets } = await admin
        .from('queue_tickets')
        .select('id')
        .eq('branch_id', branch.id);
      const ticketIds = (tickets ?? []).map((t) => t.id);
      if (ticketIds.length) {
        check('queue_events', await admin.from('queue_events').delete().in('ticket_id', ticketIds));
        check(
          'notifications',
          await admin.from('notifications').delete().in('related_ticket_id', ticketIds),
        );
      }
      check('queue_tickets', await admin.from('queue_tickets').delete().eq('branch_id', branch.id));
      check(
        'branch_ticket_counters',
        await admin.from('branch_ticket_counters').delete().eq('branch_id', branch.id),
      );
    }
    if (customerId) check('customers', await admin.from('customers').delete().eq('id', customerId));
    if (authUserId) await admin.auth.admin.deleteUser(authUserId);
    if (bs) check('branch_services', await admin.from('branch_services').delete().eq('id', bs.id));
    if (branch) check('branches', await admin.from('branches').delete().eq('id', branch.id));
    if (service) check('services', await admin.from('services').delete().eq('id', service.id));
    if (failures.length) throw new Error(`Cleanup failed:\n${failures.join('\n')}`);
  }
});
