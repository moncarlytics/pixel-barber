// Cross-surface E2E test: a staff user creates a branch and links a priced
// service to it, and a customer immediately sees that branch, its price, and
// its service on the public discovery/detail pages.
//
// This test signs in as the real bootstrap Owner account from Phase 1. It
// requires two environment variables set locally (never committed):
//   PLAYWRIGHT_STAFF_EMAIL
//   PLAYWRIGHT_STAFF_PASSWORD
// If either is missing, the test is skipped rather than failed.
import { test, expect } from '@playwright/test';

const STAFF_BASE_URL = 'http://localhost:3001';
const STAFF_EMAIL = process.env.PLAYWRIGHT_STAFF_EMAIL ?? '';
const STAFF_PASSWORD = process.env.PLAYWRIGHT_STAFF_PASSWORD ?? '';

test('a branch a staff user creates is immediately visible and correct to a customer', async ({
  browser,
}) => {
  test.skip(!STAFF_EMAIL || !STAFF_PASSWORD, 'PLAYWRIGHT_STAFF_EMAIL/PASSWORD not set');

  const branchName = `E2E Test Branch ${Date.now()}`;
  const serviceName = `E2E Test Service ${Date.now()}`;
  const price = '75.00';

  const staffContext = await browser.newContext({ baseURL: STAFF_BASE_URL });
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

  const customerContext = await browser.newContext();
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

  await staffContext.close();
  await customerContext.close();
});
