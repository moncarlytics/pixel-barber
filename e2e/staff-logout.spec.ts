// e2e/staff-logout.spec.ts
// A signed-in Owner sees "Log out" at the top of staff pages; clicking it ends the session and lands
// on the staff login page, where the button no longer shows. Clicks use Enter (Next.js dev mode's
// Dev Tools badge intercepts pointer clicks).
import { config } from 'dotenv';
config({ path: '.env.local' });
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const STAFF_BASE_URL = 'http://localhost:3001';
const PASSWORD = 'Test-Password-123!';

test.describe('staff logout', () => {
  test.skip(!url || !serviceRoleKey, 'Supabase env vars not set');

  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const ownerEmail = `slo-owner-${Date.now()}@test.pixelbarber.local`;
  let ownerAuthUserId: string;
  let ownerStaffUserId: string;

  test.beforeAll(async () => {
    const { data: ownerAuth } = await admin.auth.admin.createUser({
      email: ownerEmail,
      password: PASSWORD,
      email_confirm: true,
    });
    ownerAuthUserId = ownerAuth!.user.id;
    const { data: ownerRow } = await admin
      .from('staff_users')
      .insert({
        auth_user_id: ownerAuthUserId,
        name: 'SLO Owner',
        email: ownerEmail,
        role: 'owner',
        invite_status: 'accepted',
      })
      .select('id')
      .single();
    ownerStaffUserId = ownerRow!.id;
  }, 60000);

  test.afterAll(async () => {
    await admin.from('staff_users').delete().eq('id', ownerStaffUserId);
    await admin.auth.admin.deleteUser(ownerAuthUserId);
  }, 60000);

  test('owner logs out from a staff page and lands on the login page', async ({ page }) => {
    test.setTimeout(90_000);

    await page.goto(`${STAFF_BASE_URL}/login`);
    // Not signed in yet: no Log out button on the login page.
    await expect(page.getByRole('button', { name: 'Log out' })).toHaveCount(0);
    await page.getByPlaceholder('Email or phone').fill(ownerEmail);
    await page.getByPlaceholder('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Log In' }).press('Enter');
    await page.waitForURL(/\/tickets/, { timeout: 15000 });

    await page.goto(`${STAFF_BASE_URL}/settings/staff`);
    const logOut = page.getByRole('button', { name: 'Log out' });
    await expect(logOut).toBeVisible({ timeout: 10000 });
    await logOut.press('Enter');

    await page.waitForURL(/\/login$/, { timeout: 15000 });
    await expect(page.getByRole('button', { name: 'Log out' })).toHaveCount(0);

    // The session is really gone: the home page offers "Log in" again.
    await page.goto(`${STAFF_BASE_URL}/`);
    await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('button', { name: 'Log out' })).toHaveCount(0);
  });
});
