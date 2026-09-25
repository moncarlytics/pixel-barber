// e2e/staff-invitation-journey.spec.ts
// The Owner invites a barber on Staff & Roles; the invitee opens the link, sets a password, and
// lands on Today's Queue; the Owner then sees the barber as Active. The invite uses a .local
// address (never delivered), and the test sets a KNOWN token with the service-role-only helper,
// since the real token only exists in the (skipped) email.
//
// Selector correction against the real rendered markup: apps/staff/app/login/page.tsx's
// identifier input uses placeholder text from Login.identifierPlaceholder ("Email or phone"), not
// "Email" -- the task brief's draft used getByPlaceholder('Email'), which doesn't match anything
// on the page. Everything else in the brief (labels/buttons in
// apps/staff/app/settings/staff/page.tsx + InviteStaffForm.tsx, and Role:/Branch:/Choose a
// password/Confirm password/Set password and sign in on apps/staff/app/invite/[token]/page.tsx)
// matches the current markup and apps/staff/messages/en.json verbatim.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const STAFF_BASE_URL = 'http://localhost:3001';
const PASSWORD = 'Test-Password-123!';
const BARBER_PASSWORD = 'Barber-Pass-123!';

test.describe('staff invitation journey', () => {
  test.skip(!url || !serviceRoleKey, 'Supabase env vars not set');

  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const suffix = `${Date.now()}`;
  const ownerEmail = `sij-owner-${suffix}@test.pixelbarber.local`;
  const barberEmail = `sij-barber-${suffix}@test.pixelbarber.local`;
  const barberName = `SIJ Barber ${suffix}`;
  const token = `sij-token-${suffix}`;

  let branchId: string;
  let branchName: string;
  let ownerAuthUserId: string;
  let ownerStaffUserId: string;
  let barberStaffUserId: string | undefined;
  let barberAuthUserId: string | undefined;

  test.beforeAll(async () => {
    const { data: business } = await admin.from('businesses').select('id').limit(1).single();
    branchName = `SIJ Branch ${suffix}`;
    const { data: branch } = await admin
      .from('branches')
      .insert({
        business_id: business!.id,
        name: branchName,
        branch_code: `SIJ${suffix.slice(-6)}`,
        address: 'Test',
        latitude: 5.6,
        longitude: -0.18,
      })
      .select('id')
      .single();
    branchId = branch!.id;

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
        name: `SIJ Owner ${suffix}`,
        email: ownerEmail,
        role: 'owner',
        invite_status: 'accepted',
      })
      .select('id')
      .single();
    ownerStaffUserId = ownerRow!.id;
  }, 60000);

  test.afterAll(async () => {
    // The barber's staff row goes first: it references the Owner (invited_by_staff_id) and its
    // barbers row cascades from it; each auth user goes after its staff row (on delete restrict).
    if (barberStaffUserId) await admin.from('staff_users').delete().eq('id', barberStaffUserId);
    if (barberAuthUserId) await admin.auth.admin.deleteUser(barberAuthUserId);
    await admin.from('staff_users').delete().eq('id', ownerStaffUserId);
    await admin.auth.admin.deleteUser(ownerAuthUserId);
    await admin.from('branches').delete().eq('id', branchId);
  }, 60000);

  test("owner invites a barber, who accepts and lands on Today's Queue", async ({ browser }) => {
    test.setTimeout(180_000);

    // --- Owner signs in and sends the invite ---
    const ownerContext = await browser.newContext();
    const ownerPage = await ownerContext.newPage();
    await ownerPage.goto(`${STAFF_BASE_URL}/login`);
    await ownerPage.getByPlaceholder('Email or phone').fill(ownerEmail);
    await ownerPage.getByPlaceholder('Password').fill(PASSWORD);
    await ownerPage.getByRole('button', { name: 'Log In' }).press('Enter');
    await ownerPage.waitForURL(/\/tickets/, { timeout: 15000 });

    await ownerPage.goto(`${STAFF_BASE_URL}/settings/staff`);
    const main = ownerPage.locator('main');
    // Scoped to <main> and using Enter: Next.js dev mode's Dev Tools badge intercepts clicks.
    await main.getByRole('button', { name: '+ Invite staff' }).press('Enter');
    await main.getByLabel('Name', { exact: true }).fill(barberName);
    await main.getByLabel('Role').selectOption('barber');
    // The Branch <select>'s wrapping <label> picks up its own <option> text nodes in its computed
    // accessible name once branches load from Supabase (the Role <select> already does this with
    // its five static options, so "Branch" is a substring of its name via "Branch Manager") --
    // getByLabel('Branch') is ambiguous once both have loaded. Select it positionally instead:
    // Name's <input>, then Role's <select>, then Branch's <select> (rendered since role 'barber'
    // needs one).
    const branchSelect = main.locator('form select').nth(1);
    await expect(branchSelect.locator('option', { hasText: branchName })).toHaveCount(1, {
      timeout: 10000,
    });
    await branchSelect.selectOption({ label: branchName });
    await main.getByLabel('Email', { exact: true }).check();
    await main.getByLabel('Email address').fill(barberEmail);
    await main.getByRole('button', { name: 'Send invite' }).press('Enter');
    await expect(main.getByText('Invite created but not delivered', { exact: false })).toBeVisible({
      timeout: 15000,
    });
    const pendingRow = main.getByRole('row', { name: new RegExp(barberName) });
    await expect(pendingRow.getByText('Invite pending')).toBeVisible();

    // --- Give the invite a known token (the real one only exists in the skipped email) ---
    const { data: barberRow } = await admin
      .from('staff_users')
      .select('id, auth_user_id')
      .eq('email', barberEmail)
      .single();
    barberStaffUserId = barberRow!.id;
    barberAuthUserId = barberRow!.auth_user_id;
    const { error: tokenError } = await admin.rpc(
      'test_set_staff_invite_token' as never,
      {
        p_staff_user_id: barberStaffUserId,
        p_token: token,
        p_expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      } as never,
    );
    expect(tokenError).toBeNull();

    // --- The invitee accepts ---
    const inviteeContext = await browser.newContext();
    const inviteePage = await inviteeContext.newPage();
    await inviteePage.goto(`${STAFF_BASE_URL}/invite/${token}`);
    const inviteeMain = inviteePage.locator('main');
    await expect(inviteeMain.getByText('Role: Barber')).toBeVisible({ timeout: 15000 });
    await expect(inviteeMain.getByText(`Branch: ${branchName}`)).toBeVisible();
    await inviteeMain.getByLabel('Choose a password').fill(BARBER_PASSWORD);
    await inviteeMain.getByLabel('Confirm password').fill(BARBER_PASSWORD);
    await inviteeMain.getByRole('button', { name: 'Set password and sign in' }).press('Enter');
    await inviteePage.waitForURL(/\/queue\/today/, { timeout: 20000 });
    await inviteeContext.close();

    // --- The Owner now sees the barber as Active ---
    await ownerPage.reload();
    const activeRow = ownerPage.locator('main').getByRole('row', { name: new RegExp(barberName) });
    await expect(activeRow.getByText('Active')).toBeVisible({ timeout: 15000 });
    await ownerContext.close();
  });
});
