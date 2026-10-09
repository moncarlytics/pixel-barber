// e2e/staff-roles.spec.ts
// Light screen check per staff role: which capability-gated links the staff home shows and which
// pages answer "You don't have access to this page.". One shared seed; clicks use Enter; page
// content is in <main>.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { test, expect, type Locator, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const STAFF = 'http://localhost:3001';
const PASSWORD = 'Test-Password-123!';
const NO_ACCESS = "You don't have access to this page.";

const admin = createClient<Database>(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const suffix = String(Date.now());
type Role = 'receptionist' | 'branch_manager' | 'analyst' | 'barber';
const email = (role: string) => `srl-${role}-${suffix}@test.pixelbarber.local`;
const seed: {
  authIds: string[];
  staffIds: string[];
  serviceId?: string;
  branchId?: string;
} = { authIds: [], staffIds: [] };

async function logIn(page: Page, role: string) {
  await page.goto(`${STAFF}/login`);
  await page.getByPlaceholder('Email or phone').fill(email(role));
  await page.getByPlaceholder('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log In' }).press('Enter');
  // Barbers land on /queue/today; everyone else on /tickets.
  await page.waitForURL(/\/(tickets|queue\/today)/, { timeout: 15000 });
}

const link = (main: Locator, name: string) => main.getByRole('link', { name, exact: true });

// The home page fetches each capability after it renders, so wait for the requests to settle
// before asserting that a link is absent.
async function openHome(page: Page): Promise<Locator> {
  await page.goto(`${STAFF}/`);
  const main = page.locator('main');
  await expect(link(main, 'Appointments')).toBeVisible({ timeout: 15000 });
  await page.waitForLoadState('networkidle');
  return main;
}

async function expectNoAccess(page: Page, path: string) {
  await page.goto(`${STAFF}${path}`);
  await expect(page.locator('main').getByText(NO_ACCESS)).toBeVisible({ timeout: 15000 });
}

test.describe.serial('staff roles: home links and no-access pages', () => {
  test.skip(!url || !serviceRoleKey, 'Supabase env vars not set');

  test.beforeAll(async () => {
    const { data: business } = await admin.from('businesses').select('id').limit(1).single();
    const { data: service } = await admin
      .from('services')
      .insert({
        business_id: business!.id,
        name: `SRL E2E Cut ${suffix}`,
        default_duration_minutes: 30,
      })
      .select('id')
      .single();
    seed.serviceId = service!.id;
    const { data: branch } = await admin
      .from('branches')
      .insert({
        business_id: business!.id,
        name: `SRL E2E Branch ${suffix}`,
        branch_code: `SL${suffix.slice(-6)}`,
        address: 'Test',
        latitude: 5.6,
        longitude: -0.18,
      })
      .select('id')
      .single();
    seed.branchId = branch!.id;
    const staff = async (role: Role, name: string) => {
      const { data: auth } = await admin.auth.admin.createUser({
        email: email(role),
        password: PASSWORD,
        email_confirm: true,
      });
      seed.authIds.push(auth.user!.id);
      const { data: row } = await admin
        .from('staff_users')
        .insert({
          auth_user_id: auth.user!.id,
          name,
          email: email(role),
          role,
          invite_status: 'accepted',
        })
        .select('id')
        .single();
      seed.staffIds.push(row!.id);
      return row!.id as string;
    };
    for (const role of ['receptionist', 'branch_manager', 'analyst'] as const) {
      const id = await staff(role, `SRL E2E ${role}`);
      await admin
        .from('staff_branch_assignments')
        .insert({ staff_user_id: id, branch_id: seed.branchId! });
    }
    const barberId = await staff('barber', 'SRL E2E barber');
    await admin
      .from('barbers')
      .insert({ staff_user_id: barberId, home_branch_id: seed.branchId!, status: 'available' });
  });

  test.afterAll(async () => {
    const failures: string[] = [];
    const check = (label: string, res: { error: { message: string } | null }) => {
      if (res.error) failures.push(`${label}: ${res.error.message}`);
    };
    for (const id of seed.staffIds) {
      check('barbers', await admin.from('barbers').delete().eq('staff_user_id', id));
      check(
        'staff_branch_assignments',
        await admin.from('staff_branch_assignments').delete().eq('staff_user_id', id),
      );
      check('staff_users', await admin.from('staff_users').delete().eq('id', id));
    }
    for (const id of seed.authIds) await admin.auth.admin.deleteUser(id);
    if (seed.branchId)
      check('branches', await admin.from('branches').delete().eq('id', seed.branchId));
    if (seed.serviceId)
      check('services', await admin.from('services').delete().eq('id', seed.serviceId));
    if (failures.length) throw new Error(`Cleanup failed:\n${failures.join('\n')}`);
  });

  test('receptionist sees Today and Customers, not Reports or Feedback', async ({ page }) => {
    test.setTimeout(120_000);
    await logIn(page, 'receptionist');
    const main = await openHome(page);
    await expect(link(main, 'Today')).toBeVisible();
    await expect(link(main, 'Customers')).toBeVisible();
    await expect(link(main, 'Reports')).toHaveCount(0);
    await expect(link(main, 'Feedback')).toHaveCount(0);
    await expectNoAccess(page, '/reports');
  });

  for (const role of ['branch_manager', 'analyst'] as const) {
    test(`${role} sees every gated link but not Staff & Roles`, async ({ page }) => {
      test.setTimeout(120_000);
      await logIn(page, role);
      const main = await openHome(page);
      for (const name of ['Today', 'Reports', 'Customers', 'Feedback']) {
        await expect(link(main, name)).toBeVisible();
      }
      await expectNoAccess(page, '/settings/staff');
    });
  }

  test('barber sees none of the gated links and is turned away from them', async ({ page }) => {
    test.setTimeout(120_000);
    await logIn(page, 'barber');
    const main = await openHome(page);
    for (const name of ['Today', 'Reports', 'Customers', 'Feedback']) {
      await expect(link(main, name)).toHaveCount(0);
    }
    await expectNoAccess(page, '/customers');
    await expectNoAccess(page, '/reports');
  });
});
