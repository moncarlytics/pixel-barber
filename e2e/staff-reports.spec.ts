// e2e/staff-reports.spec.ts
// Today dashboard and Reports (Docs/superpowers/specs/2026-10-08-reports-dashboard-design.md): a
// branch manager sets the long-wait limit, sees Today with the warning, opens Reports and downloads
// the files. One shared seed; clicks use Enter; page content is in <main>.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { readFileSync } from 'node:fs';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const STAFF = 'http://localhost:3001';
const PASSWORD = 'Test-Password-123!';
const DAY = 24 * 60 * 60 * 1000;
const dateAt = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

const admin = createClient<Database>(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const suffix = String(Date.now());
const managerEmail = `srp-mgr-${suffix}@test.pixelbarber.local`;
const barberEmail = `srp-barber-${suffix}@test.pixelbarber.local`;
const visitDay = dateAt(-3);
const seed: {
  authIds: string[];
  staffIds: string[];
  customerIds: string[];
  serviceId?: string;
  branchId?: string;
  branchCode: string;
  bsId?: string;
} = { authIds: [], staffIds: [], customerIds: [], branchCode: `SR${suffix.slice(-6)}` };

async function logIn(page: Page) {
  await page.goto(`${STAFF}/login`);
  await page.getByPlaceholder('Email or phone').fill(managerEmail);
  await page.getByPlaceholder('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log In' }).press('Enter');
  await page.waitForURL(/\/tickets/, { timeout: 15000 });
}

async function openReport(page: Page): Promise<Locator> {
  await page.goto(`${STAFF}/reports`);
  const main = page.locator('main');
  await main.getByLabel('Branch', { exact: true }).selectOption(seed.branchId!);
  // exact: the summary groups' names ("Customers served", "Returning customers") contain "to".
  await main.getByLabel('Period', { exact: true }).selectOption('custom');
  await main.getByLabel('From', { exact: true }).fill(visitDay);
  await main.getByLabel('To', { exact: true }).fill(visitDay);
  await expect(main.getByRole('group', { name: 'Customers served' })).toContainText('1', {
    timeout: 15000,
  });
  return main;
}

test.describe.serial('today dashboard and reports', () => {
  test.skip(!url || !serviceRoleKey, 'Supabase env vars not set');

  test.beforeAll(async () => {
    const { data: business } = await admin.from('businesses').select('id').limit(1).single();
    const { data: service } = await admin
      .from('services')
      .insert({
        business_id: business!.id,
        name: `SRP E2E Cut ${suffix}`,
        default_duration_minutes: 30,
      })
      .select('id')
      .single();
    seed.serviceId = service!.id;
    const { data: branch } = await admin
      .from('branches')
      .insert({
        business_id: business!.id,
        name: `SRP E2E Branch ${suffix}`,
        branch_code: seed.branchCode,
        address: 'Test',
        latitude: 5.6,
        longitude: -0.18,
      })
      .select('id')
      .single();
    seed.branchId = branch!.id;
    const { data: bs } = await admin
      .from('branch_services')
      .insert({ branch_id: seed.branchId!, service_id: seed.serviceId! })
      .select('id')
      .single();
    seed.bsId = bs!.id;
    await admin
      .from('branch_service_prices')
      .insert({ branch_service_id: seed.bsId!, price_ghs: 50, effective_from: dateAt(-30) });
    const staff = async (email: string, name: string, role: 'barber' | 'branch_manager') => {
      const { data: auth } = await admin.auth.admin.createUser({
        email,
        password: PASSWORD,
        email_confirm: true,
      });
      seed.authIds.push(auth.user!.id);
      const { data: row } = await admin
        .from('staff_users')
        .insert({ auth_user_id: auth.user!.id, name, email, role, invite_status: 'accepted' })
        .select('id')
        .single();
      seed.staffIds.push(row!.id);
      return row!.id as string;
    };
    const barberStaffId = await staff(barberEmail, 'SRP E2E Barber', 'barber');
    const { data: barber } = await admin
      .from('barbers')
      .insert({ staff_user_id: barberStaffId, home_branch_id: seed.branchId!, status: 'available' })
      .select('id')
      .single();
    const managerStaffId = await staff(managerEmail, 'SRP E2E Manager', 'branch_manager');
    await admin
      .from('staff_branch_assignments')
      .insert({ staff_user_id: managerStaffId, branch_id: seed.branchId! });
    for (const i of [1, 2]) {
      const { data: customer } = await admin
        .from('customers')
        .insert({ name: `SRP Customer ${i}`, phone_e164: `+233555${suffix.slice(-5)}${i}` })
        .select('id')
        .single();
      seed.customerIds.push(customer!.id);
    }
    // A completed walk-in three days ago (wait 15, haircut 30, GHS 50) and one person waiting now
    // for 30 minutes.
    const { error: ticketsError } = await admin.from('queue_tickets').insert([
      {
        ticket_number: `PB-SRP-${suffix}-1`,
        branch_id: seed.branchId!,
        customer_id: seed.customerIds[0],
        branch_service_id: seed.bsId!,
        assigned_barber_id: barber!.id,
        state: 'completed',
        created_at: `${visitDay}T10:00:00.000Z`,
        service_started_at: `${visitDay}T10:15:00.000Z`,
        completed_at: `${visitDay}T10:45:00.000Z`,
        created_by: 'staff',
      },
      {
        ticket_number: `PB-SRP-${suffix}-2`,
        branch_id: seed.branchId!,
        customer_id: seed.customerIds[1],
        branch_service_id: seed.bsId!,
        state: 'waiting',
        created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        created_by: 'staff',
      },
    ]);
    if (ticketsError) throw ticketsError;
  });

  test.afterAll(async () => {
    const failures: string[] = [];
    const check = (label: string, res: { error: { message: string } | null }) => {
      if (res.error) failures.push(`${label}: ${res.error.message}`);
    };
    if (seed.branchId) {
      const { data: tickets } = await admin
        .from('queue_tickets')
        .select('id')
        .eq('branch_id', seed.branchId);
      const ticketIds = (tickets ?? []).map((t) => t.id);
      if (ticketIds.length) {
        check('feedback', await admin.from('feedback').delete().in('ticket_id', ticketIds));
        check(
          'notifications',
          await admin.from('notifications').delete().in('related_ticket_id', ticketIds),
        );
        check('queue_events', await admin.from('queue_events').delete().in('ticket_id', ticketIds));
      }
      check(
        'queue_tickets',
        await admin.from('queue_tickets').delete().eq('branch_id', seed.branchId),
      );
      check(
        'branch_ticket_counters',
        await admin.from('branch_ticket_counters').delete().eq('branch_id', seed.branchId),
      );
    }
    for (const id of seed.staffIds) {
      check('barbers', await admin.from('barbers').delete().eq('staff_user_id', id));
      check(
        'staff_branch_assignments',
        await admin.from('staff_branch_assignments').delete().eq('staff_user_id', id),
      );
      check('staff_users', await admin.from('staff_users').delete().eq('id', id));
    }
    for (const id of seed.authIds) await admin.auth.admin.deleteUser(id);
    for (const id of seed.customerIds) {
      check('customers', await admin.from('customers').delete().eq('id', id));
    }
    if (seed.bsId) {
      check('branch_services', await admin.from('branch_services').delete().eq('id', seed.bsId));
    }
    if (seed.branchId)
      check('branches', await admin.from('branches').delete().eq('id', seed.branchId));
    if (seed.serviceId)
      check('services', await admin.from('services').delete().eq('id', seed.serviceId));
    if (failures.length) throw new Error(`Cleanup failed:\n${failures.join('\n')}`);
  });

  test('a branch manager sets the long-wait limit and sees it on Today', async ({ page }) => {
    test.setTimeout(120_000);
    await logIn(page);
    await page.goto(`${STAFF}/settings/branch/${seed.branchId}`);
    const main = page.locator('main');
    await main.getByLabel('Long wait warning (minutes)').fill('5');
    await main.getByRole('button', { name: 'Save warning' }).press('Enter');
    await expect(main.getByText('Warning saved')).toBeVisible({ timeout: 15000 });

    await page.goto(`${STAFF}/today`);
    await main.getByLabel('Branch', { exact: true }).selectOption(seed.branchId!);
    await expect(
      main.getByText(/Waits are long: people have waited \d+ min on average \(limit 5 min\)\./),
    ).toBeVisible({ timeout: 15000 });
    await expect(main.getByRole('group', { name: 'Waiting' })).toContainText('1');
    await expect(main.getByRole('group', { name: 'Served' })).toContainText('0');
  });

  test('a branch manager opens Reports and downloads a table as CSV', async ({ page }) => {
    test.setTimeout(120_000);
    await logIn(page);
    const main = await openReport(page);
    await expect(main.getByRole('group', { name: 'Estimated takings' })).toContainText(
      'GHS 50.00 (estimated)',
    );
    const barbers = main.getByRole('region', { name: 'Barbers' });
    await expect(barbers).toContainText('SRP E2E Barber');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      barbers.getByRole('button', { name: 'Download CSV' }).press('Enter'),
    ]);
    expect(download.suggestedFilename()).toBe(`pixel-barber-barbers-${visitDay}-${visitDay}.csv`);
    const csv = readFileSync((await download.path())!, 'utf8').replace(/^﻿/, '');
    expect(csv.split('\r\n')[0]).toBe(
      'Barber,Served,Average haircut time,No-shows,Average rating,Estimated takings',
    );
    expect(csv.split('\r\n')[1]).toBe('SRP E2E Barber,1,30,0,,50');
  });
});
