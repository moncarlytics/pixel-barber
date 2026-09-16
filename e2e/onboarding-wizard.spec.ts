// e2e/onboarding-wizard.spec.ts
import { test, expect } from '@playwright/test';
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

test('completing the avatar/notifications/welcome steps records a transactional consent row', async ({
  page,
  context,
  baseURL,
}) => {
  test.skip(!url || !serviceRoleKey, 'Supabase env vars not set');

  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const suffix = Date.now();
  const phone = `+233${String(suffix).slice(-9)}`;
  const password = 'Test-Password-123!';

  const { data: userData } = await admin.auth.admin.createUser({
    phone,
    password,
    phone_confirm: true,
  });
  const authUserId = userData!.user.id;

  // Step 0's session-resumption logic reads the linked customers row's avatar_key -- this test
  // seeds a session directly (skipping the phone/OTP/password steps), so it must also create the
  // customers row directly, the same way link_or_create_customer would have. Left with avatar_key
  // unset (its default/null) so the resumption check has something real to detect.
  const { data: customerRow } = await admin
    .from('customers')
    .insert({ auth_user_id: authUserId, name: 'Onboarding E2E Customer', phone_e164: phone })
    .select('id')
    .single();
  let customerId = customerRow!.id;

  const anon = createClient<Database>(url, anonKey);
  const { data: sessionData } = await anon.auth.signInWithPassword({ phone, password });

  try {
    // Seed a browser session directly rather than driving the phone/OTP/password steps again --
    // those are Phase 1 territory, already covered by that phase's own manual/automated checks.
    // @supabase/ssr's createBrowserClient always manages sessions via cookies, never localStorage
    // -- verified against the installed @supabase/ssr/auth-js source during a prior attempt at
    // this task. Cookie name is project-ref-scoped; value is the full Session object, base64url-
    // encoded with a "base64-" prefix.
    const projectRef = new URL(url).hostname.split('.')[0];
    const cookieName = `sb-${projectRef}-auth-token`;
    const cookieValue =
      'base64-' +
      Buffer.from(JSON.stringify(sessionData.session), 'utf-8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    await context.addCookies([
      { name: cookieName, value: cookieValue, url: baseURL ?? 'http://localhost:3000' },
    ]);

    await page.goto('/onboard');
    // With Step 0's session-resumption logic in place, an existing session plus a customers row
    // with avatar_key still null should land directly on the avatar step -- if a name-verification
    // step 1 form still renders, this test's own setup is wrong and should be fixed here, not
    // worked around by skipping assertions below.

    await expect(page.getByRole('heading', { name: 'Choose Your Avatar' })).toBeVisible({
      timeout: 15000,
    });
    // The avatar picker uses native <button> elements with an explicit role="radio" (the
    // correct ARIA radiogroup pattern, per the accessibility fix in commit 54ffe5c) -- an
    // explicit ARIA role overrides the implicit "button" role in the accessibility tree, so
    // this must be queried as a radio, not a button.
    await page.getByRole('radio', { name: /Barber Pole/i }).click();
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: 'Notification Preferences' })).toBeVisible();
    await page.getByRole('button', { name: 'Finish Setup' }).click();

    await expect(page.getByRole('heading', { name: "You're All Set!" })).toBeVisible();

    const { data: consentRow } = await admin
      .from('consents')
      .select('granted')
      .eq('customer_id', customerId)
      .eq('consent_type', 'transactional')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    expect(consentRow?.granted).toBe(true);
  } finally {
    if (customerId) {
      await admin.from('consents').delete().eq('customer_id', customerId);
      await admin.from('customers').delete().eq('id', customerId);
    }
    await admin.auth.admin.deleteUser(authUserId);
  }
});

test('a session-less visitor lands on the phone-entry step promptly', async ({ page }) => {
  // Every visitor to /onboard now renders null until Step 0's on-mount session-resumption
  // check (in OnboardWizard.tsx) resolves -- including normal first-time visitors who have no
  // session at all. This test doesn't seed any cookies/session (Playwright gives each test a
  // fresh, isolated browser context by default), so `supabase.auth.getUser()` should
  // short-circuit quickly for a session-less client and resumeCheckComplete should flip to
  // true fast, landing on the default 'phone' step. A tight timeout is intentional here: this
  // test's job is to catch a regression (an accidental delay or stuck-loading state), not to
  // tolerate slowness the way the resuming-user test above does.
  await page.goto('/onboard');

  await expect(page.getByRole('heading', { name: 'Sign Up' })).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole('button', { name: 'Send Code' })).toBeVisible({ timeout: 5000 });
  await expect(page.getByPlaceholder('0244123456')).toBeVisible();
});
