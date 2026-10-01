// e2e/customer-forgot-password.spec.ts
// Customer password reset by texted code. No SMS is ever sent: the browser's two Supabase Auth
// calls that involve the code -- POST /auth/v1/otp (send it) and POST /auth/v1/verify (check it) --
// are intercepted and answered by the test. A successful "verify" is answered with a REAL session
// for the account (obtained here by a password sign-in), so everything after it -- the customer
// check, the password change, the redirect -- runs against Supabase for real.
// Clicks use Enter (Next.js dev mode's Dev Tools badge intercepts pointer clicks).
import { config } from 'dotenv';
config({ path: '.env.local' });
import { test, expect, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CUSTOMER_BASE_URL = 'http://localhost:3000';
const OLD_PASSWORD = 'Old-Password-123!';
const NEW_PASSWORD = 'New-Password-456!';

test.describe('customer forgot password', () => {
  test.skip(!url || !serviceRoleKey || !anonKey, 'Supabase env vars not set');

  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const suffix = String(Date.now());
  // 057… / 027…: distinct from customer-login.spec.ts's 050… / 020… (both files load at once).
  const customerLocal = `057${suffix.slice(-7)}`;
  const staffLocal = `027${suffix.slice(-7)}`;
  const toE164 = (local: string) => `+233${local.slice(1)}`;

  let customerAuthId: string;
  let customerId: string;
  let staffAuthId: string;
  let staffUserId: string;

  /** A real session for a phone + password account, shaped like Supabase's /verify response. */
  async function realSession(phone: string, password: string) {
    const client = createClient<Database>(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await client.auth.signInWithPassword({ phone, password });
    if (error || !data.session) throw error ?? new Error('no session');
    return data.session;
  }

  /** Answers the "send code" call with success and records what the page asked for. */
  async function stubSendCode(page: Page) {
    const requests: Record<string, unknown>[] = [];
    await page.route('**/auth/v1/otp*', async (route) => {
      requests.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    return requests;
  }

  async function requestCode(page: Page, local: string) {
    await page.goto(`${CUSTOMER_BASE_URL}/login`);
    await page.getByRole('link', { name: 'Forgot password?' }).press('Enter');
    await page.waitForURL(/\/forgot-password/, { timeout: 15000 });
    await page.getByPlaceholder('0244123456').fill(local);
    await page.getByRole('button', { name: 'Send Code' }).press('Enter');
    await expect(page.getByPlaceholder('6-digit code')).toBeVisible({ timeout: 15000 });
  }

  test.beforeAll(async () => {
    const { data: customerAuth, error: customerAuthError } = await admin.auth.admin.createUser({
      phone: toE164(customerLocal),
      password: OLD_PASSWORD,
      phone_confirm: true,
    });
    if (customerAuthError) throw customerAuthError;
    customerAuthId = customerAuth!.user.id;
    const { data: customer } = await admin
      .from('customers')
      .insert({
        auth_user_id: customerAuthId,
        name: 'Reset E2E Customer',
        phone_e164: toE164(customerLocal),
        avatar_key: 'avatar-1',
      })
      .select('id')
      .single();
    customerId = customer!.id;

    const { data: staffAuth, error: staffAuthError } = await admin.auth.admin.createUser({
      phone: toE164(staffLocal),
      password: OLD_PASSWORD,
      phone_confirm: true,
    });
    if (staffAuthError) throw staffAuthError;
    staffAuthId = staffAuth!.user.id;
    const { data: staffRow } = await admin
      .from('staff_users')
      .insert({
        auth_user_id: staffAuthId,
        name: 'Reset E2E Staff',
        phone_e164: toE164(staffLocal),
        role: 'analyst',
        invite_status: 'accepted',
      })
      .select('id')
      .single();
    staffUserId = staffRow!.id;
  }, 60000);

  test.afterAll(async () => {
    await admin.from('customers').delete().eq('id', customerId);
    await admin.auth.admin.deleteUser(customerAuthId);
    await admin.from('staff_users').delete().eq('id', staffUserId);
    await admin.auth.admin.deleteUser(staffAuthId);
  }, 60000);

  test('asks for a code without ever creating an account, and rejects a wrong code', async ({
    page,
  }) => {
    const sendRequests = await stubSendCode(page);
    await page.route('**/auth/v1/verify*', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'otp_expired', msg: 'Token has expired or is invalid' }),
      }),
    );

    await requestCode(page, customerLocal);
    expect(sendRequests).toHaveLength(1);
    expect(sendRequests[0]).toMatchObject({ phone: toE164(customerLocal), create_user: false });

    await page.getByPlaceholder('6-digit code').fill('000000');
    await page.getByRole('button', { name: 'Verify' }).press('Enter');
    await expect(page.locator('main').getByRole('alert')).toHaveText(
      'That code is incorrect or has expired.',
      { timeout: 15000 },
    );
  });

  test('a customer resets their password and the new one works', async ({ page }) => {
    test.setTimeout(90_000);
    await stubSendCode(page);
    const session = await realSession(toE164(customerLocal), OLD_PASSWORD);
    await page.route('**/auth/v1/verify*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(session),
      }),
    );

    await requestCode(page, customerLocal);
    await page.getByPlaceholder('6-digit code').fill('123456');
    await page.getByRole('button', { name: 'Verify' }).press('Enter');
    await page.getByPlaceholder('New password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Save new password' }).press('Enter');
    await page.waitForURL(`${CUSTOMER_BASE_URL}/`, { timeout: 15000 });

    // The new password signs in; the old one no longer does.
    await expect(realSession(toE164(customerLocal), NEW_PASSWORD)).resolves.toBeTruthy();
    await expect(realSession(toE164(customerLocal), OLD_PASSWORD)).rejects.toBeTruthy();
  });

  test('a staff-only number is refused and its password is never changed', async ({ page }) => {
    test.setTimeout(90_000);
    await stubSendCode(page);
    const session = await realSession(toE164(staffLocal), OLD_PASSWORD);
    await page.route('**/auth/v1/verify*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(session),
      }),
    );

    await requestCode(page, staffLocal);
    await page.getByPlaceholder('6-digit code').fill('123456');
    await page.getByRole('button', { name: 'Verify' }).press('Enter');
    await expect(page.locator('main').getByRole('alert')).toHaveText(
      'No customer account for this number.',
      { timeout: 15000 },
    );
    await expect(page.getByPlaceholder('New password')).toHaveCount(0);
    // The staff login still works with its original password.
    await expect(realSession(toE164(staffLocal), OLD_PASSWORD)).resolves.toBeTruthy();
  });
});
