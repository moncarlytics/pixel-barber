// Cross-surface E2E test: a staff user creates a branch and links a priced
// service to it, and a customer immediately sees that branch, its price, and
// its service on the public discovery/detail pages.
//
// This test signs in as the real bootstrap Owner account from Phase 1. It
// requires two environment variables set locally (never committed):
//   PLAYWRIGHT_STAFF_EMAIL
//   PLAYWRIGHT_STAFF_PASSWORD
// If either is missing, the test is skipped rather than failed.
//
// It also creates real rows (a branch, a service, a branch_services link, and
// a branch_service_prices row) directly against staging via the live UI. A
// service-role admin client is used to clean those rows up unconditionally
// (try/finally) so repeated runs don't litter staging.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

const STAFF_BASE_URL = 'http://localhost:3001';
const STAFF_EMAIL = process.env.PLAYWRIGHT_STAFF_EMAIL ?? '';
const STAFF_PASSWORD = process.env.PLAYWRIGHT_STAFF_PASSWORD ?? '';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

test('a branch a staff user creates is immediately visible and correct to a customer', async ({
  browser,
}) => {
  test.skip(!STAFF_EMAIL || !STAFF_PASSWORD, 'PLAYWRIGHT_STAFF_EMAIL/PASSWORD not set');

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const branchName = `E2E Test Branch ${Date.now()}`;
  const serviceName = `E2E Test Service ${Date.now()}`;
  const price = '75.00';

  let branchId: string | undefined;
  let serviceId: string | undefined;

  let staffContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  let customerContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;

  try {
    staffContext = await browser.newContext({ baseURL: STAFF_BASE_URL });
    const staffPage = await staffContext.newPage();

    await staffPage.goto('/login');
    await staffPage.getByPlaceholder('Email').fill(STAFF_EMAIL);
    await staffPage.getByPlaceholder('Password').fill(STAFF_PASSWORD);
    await staffPage.getByRole('button', { name: 'Log In' }).click();
    await staffPage.waitForURL('**/tickets');

    await staffPage.goto('/settings/branch');
    await staffPage.getByPlaceholder('Name').fill(branchName);
    await staffPage.getByPlaceholder('Branch code').fill(`E2E${Date.now() % 100000}`);
    await staffPage.getByPlaceholder('Address').fill('123 Test Street, Accra');
    await staffPage.getByPlaceholder('Latitude').fill('5.6');
    await staffPage.getByPlaceholder('Longitude').fill('-0.18');
    await staffPage.getByRole('button', { name: 'Create Branch' }).click();

    await staffPage.getByRole('link', { name: branchName }).click();
    await staffPage.getByRole('button', { name: 'Save' }).first().click();

    await staffPage.goto('/settings/services');
    await staffPage.getByPlaceholder('New service name').fill(serviceName);
    await staffPage.getByPlaceholder('Duration (minutes)').fill('30');
    await staffPage.getByRole('button', { name: '+ Add Service (business-wide)' }).click();

    await staffPage.getByLabel('Branch', { exact: true }).selectOption({ label: branchName });
    await staffPage.getByLabel(/existing service/i).selectOption({ label: serviceName });
    await staffPage.getByPlaceholder('Starting price (GHS)').fill(price);
    await staffPage.getByRole('button', { name: 'Link to Branch' }).click();

    customerContext = await browser.newContext();
    const customerPage = await customerContext.newPage();
    await customerPage.goto('/');
    await customerPage.getByPlaceholder('Search branches').fill(branchName);

    await expect(customerPage.getByText(branchName)).toBeVisible();
    await expect(customerPage.getByText(new RegExp(price.replace('.', '\\.')))).toBeVisible();

    await customerPage.getByRole('link', { name: 'View' }).click();
    await expect(customerPage.getByText(serviceName)).toBeVisible();
    await expect(
      customerPage.getByText(new RegExp(`GHS ${price.replace('.', '\\.')}`)),
    ).toBeVisible();
  } finally {
    if (staffContext) await staffContext.close();
    if (customerContext) await customerContext.close();

    // Look up whatever this run actually created by its unique names, no
    // matter how far the try block got before it threw (or which branch the
    // UI ended up linking the service to), so cleanup is robust to partial
    // failures and doesn't silently miss a mis-linked row.
    const { data: branchRow } = await admin
      .from('branches')
      .select('id')
      .eq('name', branchName)
      .maybeSingle();
    branchId = branchRow?.id;

    const { data: serviceRow } = await admin
      .from('services')
      .select('id')
      .eq('name', serviceName)
      .maybeSingle();
    serviceId = serviceRow?.id;

    if (serviceId) {
      const { data: branchServiceRows } = await admin
        .from('branch_services')
        .select('id')
        .eq('service_id', serviceId);

      for (const row of branchServiceRows ?? []) {
        await admin.from('branch_service_prices').delete().eq('branch_service_id', row.id);
        await admin.from('branch_services').delete().eq('id', row.id);
      }

      await admin.from('services').delete().eq('id', serviceId);
    }
    if (branchId) {
      await admin.from('branches').delete().eq('id', branchId);
    }
  }
});
