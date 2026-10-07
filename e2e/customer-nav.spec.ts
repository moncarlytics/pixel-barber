// e2e/customer-nav.spec.ts
// The customer app's top menu: hidden when signed out (and on the login page), shown on every page
// once signed in with Branches / My Tickets / Profile links, and Log out ends the session.
// Clicks use Enter (Next.js dev mode's Dev Tools badge intercepts pointer clicks).
import { test, expect } from '@playwright/test';
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PASSWORD = 'Test-Password-123!';

test('signed-in customers get a menu on every page, and Log out ends the session', async ({
  page,
  context,
  baseURL,
}) => {
  test.skip(!url || !serviceRoleKey, 'Supabase env vars not set');
  test.setTimeout(90_000);
  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  // 0551… : distinct from the phone ranges other test files use.
  const phone = `+233551${String(Date.now()).slice(-6)}`;
  let authUserId: string | null = null;
  let customerId: string | null = null;
  const nav = page.getByRole('navigation');

  try {
    // Signed out: no menu.
    await page.goto('/login');
    await expect(nav.getByRole('link', { name: 'Profile' })).toHaveCount(0);

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
          name: 'Nav E2E Customer',
          phone_e164: phone,
          avatar_key: 'avatar-1',
        })
        .select('id')
        .single()
    ).data!.id;

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

    // Signed in: the menu is on the home page and takes you to each section.
    await page.goto('/');
    await expect(nav.getByRole('link', { name: 'Branches' })).toBeVisible({ timeout: 15000 });
    await expect(nav.getByRole('link', { name: 'My Tickets' })).toBeVisible();
    await nav.getByRole('link', { name: 'Profile' }).press('Enter');
    await expect(page).toHaveURL(/\/profile$/, { timeout: 15000 });
    await nav.getByRole('link', { name: 'My Tickets' }).press('Enter');
    await expect(page).toHaveURL(/\/tickets$/, { timeout: 15000 });
    await nav.getByRole('link', { name: 'Branches' }).press('Enter');
    await expect(page).toHaveURL(/\/$/, { timeout: 15000 });

    // Log out: back home, menu gone, and the session really ended.
    await nav.getByRole('button', { name: 'Log out' }).press('Enter');
    await expect(nav.getByRole('link', { name: 'Profile' })).toHaveCount(0, { timeout: 15000 });
    await page.goto('/profile');
    await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
  } finally {
    const failures: string[] = [];
    if (customerId) {
      const { error } = await admin.from('customers').delete().eq('id', customerId);
      if (error) failures.push(`customers: ${error.message}`);
    }
    if (authUserId) {
      const { error } = await admin.auth.admin.deleteUser(authUserId);
      if (error) failures.push(`auth user: ${error.message}`);
    }
    if (failures.length) throw new Error(`Cleanup failed:\n${failures.join('\n')}`);
  }
});
