// e2e/customer-login.spec.ts
// Returning customers log in with phone + password (no SMS code) and land back where they were
// heading; a wrong password and a staff-only phone number are both refused with a plain message.
// Clicks use Enter (Next.js dev mode's Dev Tools badge intercepts pointer clicks).
import { config } from 'dotenv';
config({ path: '.env.local' });
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CUSTOMER_BASE_URL = 'http://localhost:3000';
const PASSWORD = 'Test-Password-123!';

test.describe('customer login', () => {
  test.skip(!url || !serviceRoleKey, 'Supabase env vars not set');

  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const suffix = String(Date.now());
  // Local-format numbers (0 + 9 digits), as a customer would type them. 050… / 020…: distinct from
  // customer-forgot-password.spec.ts's 057… / 027… (both files load at once).
  const customerLocal = `050${suffix.slice(-7)}`;
  const staffLocal = `020${suffix.slice(-7)}`;
  const toE164 = (local: string) => `+233${local.slice(1)}`;

  let customerAuthId: string;
  let customerId: string;
  let staffAuthId: string;
  let staffUserId: string;
  let branchId: string;

  test.beforeAll(async () => {
    const { data: customerAuth, error: customerAuthError } = await admin.auth.admin.createUser({
      phone: toE164(customerLocal),
      password: PASSWORD,
      phone_confirm: true,
    });
    if (customerAuthError) throw customerAuthError;
    customerAuthId = customerAuth!.user.id;
    const { data: customer } = await admin
      .from('customers')
      .insert({
        auth_user_id: customerAuthId,
        name: 'Login E2E Customer',
        phone_e164: toE164(customerLocal),
        avatar_key: 'avatar-1',
      })
      .select('id')
      .single();
    customerId = customer!.id;

    // A phone-only staff login (like an SMS-invited barber) with no customer profile.
    const { data: staffAuth, error: staffAuthError } = await admin.auth.admin.createUser({
      phone: toE164(staffLocal),
      password: PASSWORD,
      phone_confirm: true,
    });
    if (staffAuthError) throw staffAuthError;
    staffAuthId = staffAuth!.user.id;
    const { data: staffRow } = await admin
      .from('staff_users')
      .insert({
        auth_user_id: staffAuthId,
        name: 'Login E2E Staff',
        phone_e164: toE164(staffLocal),
        role: 'analyst',
        invite_status: 'accepted',
      })
      .select('id')
      .single();
    staffUserId = staffRow!.id;

    const { data: branch } = await admin.from('branches').select('id').limit(1).single();
    branchId = branch!.id;
  }, 60000);

  test.afterAll(async () => {
    await admin.from('customers').delete().eq('id', customerId);
    await admin.auth.admin.deleteUser(customerAuthId);
    await admin.from('staff_users').delete().eq('id', staffUserId);
    await admin.auth.admin.deleteUser(staffAuthId);
  }, 60000);

  test('a returning customer logs in from a branch page and goes back to it', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(`${CUSTOMER_BASE_URL}/branches/${branchId}`);
    await page.getByRole('link', { name: 'Already have an account? Log in' }).press('Enter');
    await page.waitForURL(/\/login\?/, { timeout: 15000 });

    await page.getByPlaceholder('0244123456').fill(customerLocal);
    await page.getByPlaceholder('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Log In' }).press('Enter');

    await page.waitForURL(new RegExp(`/branches/${branchId}$`), { timeout: 15000 });
    // Signed in now: Join Queue goes straight to booking instead of sign-up.
    await expect(page.getByRole('link', { name: 'Join Queue' })).toHaveAttribute(
      'href',
      `/book?branch=${branchId}`,
      { timeout: 10000 },
    );
  });

  test('a wrong password is refused with a plain message', async ({ page }) => {
    await page.goto(`${CUSTOMER_BASE_URL}/login`);
    await page.getByPlaceholder('0244123456').fill(customerLocal);
    await page.getByPlaceholder('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Log In' }).press('Enter');
    // Scoped to <main>: Next.js's route announcer is also role="alert".
    await expect(page.locator('main').getByRole('alert')).toHaveText(
      'Phone number or password is incorrect.',
      {
        timeout: 15000,
      },
    );
    await expect(page).toHaveURL(/\/login/);
  });

  test('a staff-only phone number cannot log into the customer app', async ({ page }) => {
    await page.goto(`${CUSTOMER_BASE_URL}/login`);
    await page.getByPlaceholder('0244123456').fill(staffLocal);
    await page.getByPlaceholder('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Log In' }).press('Enter');
    await expect(page.locator('main').getByRole('alert')).toHaveText(
      'No customer account for this number — create one below.',
      { timeout: 15000 },
    );
    // Signed back out: the profile page sends us to login, not into an empty profile.
    await page.goto(`${CUSTOMER_BASE_URL}/profile`);
    await page.waitForURL(/\/login\?next=%2Fprofile/, { timeout: 15000 });
    await expect(page.getByText('Your session ended — log back in to continue.')).toBeVisible();
  });
});
