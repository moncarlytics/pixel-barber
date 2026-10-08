// e2e/staff-customers.spec.ts
// Customer list (Docs/superpowers/specs/2026-10-08-customer-list-design.md): a receptionist finds a
// customer by phone, opens their page, sees the visit, sends a message and sees its delivery label.
// Clicks use Enter; page content is in <main>.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const STAFF = 'http://localhost:3001';
const PASSWORD = 'Test-Password-123!';

test('a receptionist finds a customer by phone and messages them', async ({ page }) => {
  test.skip(!url || !serviceRoleKey, 'Supabase env vars not set');
  test.setTimeout(120_000);
  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const suffix = String(Date.now());
  const receptionEmail = `scu-rec-${suffix}@test.pixelbarber.local`;
  const phone = `+233209${suffix.slice(-6)}`;
  const localPhone = `0${phone.slice(4)}`;
  const customerName = `Esi Mensah ${suffix}`;
  const created: { authIds: string[]; staffIds: string[] } = { authIds: [], staffIds: [] };
  let service: { id: string } | null = null;
  let branch: { id: string } | null = null;
  let bs: { id: string } | null = null;
  let customerId: string | null = null;

  try {
    const { data: business } = await admin.from('businesses').select('id').limit(1).single();
    service = (
      await admin
        .from('services')
        .insert({
          business_id: business!.id,
          name: `SCU E2E Cut ${suffix}`,
          default_duration_minutes: 30,
        })
        .select('id')
        .single()
    ).data;
    branch = (
      await admin
        .from('branches')
        .insert({
          business_id: business!.id,
          name: `SCU E2E Branch ${suffix}`,
          branch_code: `SC${suffix.slice(-6)}`,
          address: 'Test',
          latitude: 5.6,
          longitude: -0.18,
        })
        .select('id')
        .single()
    ).data;
    bs = (
      await admin
        .from('branch_services')
        .insert({ branch_id: branch!.id, service_id: service!.id })
        .select('id')
        .single()
    ).data;
    const { data: auth } = await admin.auth.admin.createUser({
      email: receptionEmail,
      password: PASSWORD,
      email_confirm: true,
    });
    created.authIds.push(auth.user!.id);
    const { data: staffRow } = await admin
      .from('staff_users')
      .insert({
        auth_user_id: auth.user!.id,
        name: 'SCU E2E Reception',
        email: receptionEmail,
        role: 'receptionist',
        invite_status: 'accepted',
      })
      .select('id')
      .single();
    created.staffIds.push(staffRow!.id);
    await admin
      .from('staff_branch_assignments')
      .insert({ staff_user_id: staffRow!.id, branch_id: branch!.id });
    customerId = (
      await admin
        .from('customers')
        .insert({ name: customerName, phone_e164: phone })
        .select('id')
        .single()
    ).data!.id;
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const { error: ticketError } = await admin.from('queue_tickets').insert({
      ticket_number: `PB-SCU-${suffix}`,
      branch_id: branch!.id,
      customer_id: customerId!,
      branch_service_id: bs!.id,
      state: 'completed',
      created_at: twoDaysAgo,
      completed_at: twoDaysAgo,
      created_by: 'staff',
    });
    if (ticketError) throw ticketError;

    await page.goto(`${STAFF}/login`);
    await page.getByPlaceholder('Email or phone').fill(receptionEmail);
    await page.getByPlaceholder('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Log In' }).press('Enter');
    await page.waitForURL(/\/tickets/, { timeout: 15000 });

    await page.goto(`${STAFF}/customers`);
    const main = page.locator('main');
    await main.getByLabel('Branch', { exact: true }).selectOption(branch!.id);
    await main.getByLabel('Search by name or phone').fill(localPhone);
    const link = main.getByRole('link', { name: customerName });
    await expect(link).toBeVisible({ timeout: 15000 });
    await expect(main.getByRole('cell', { name: localPhone })).toBeVisible();
    await link.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/customers/${customerId}`), { timeout: 15000 });

    await expect(main.getByRole('region', { name: 'Visit history' })).toContainText(
      `SCU E2E Cut ${suffix}`,
      { timeout: 15000 },
    );
    await main
      .getByLabel('Message', { exact: true })
      .fill('Your barber is running 10 minutes late.');
    await main.getByRole('button', { name: 'Send' }).press('Enter');
    await expect(main.getByText('Message queued.')).toBeVisible({ timeout: 15000 });
    const messages = main.getByRole('region', { name: 'Messages' });
    await expect(messages).toContainText('Your barber is running 10 minutes late.', {
      timeout: 15000,
    });
    await expect(messages).toContainText(/Sending|Delivered|Not delivered/);
  } finally {
    const failures: string[] = [];
    const check = (label: string, res: { error: { message: string } | null }) => {
      if (res.error) failures.push(`${label}: ${res.error.message}`);
    };
    if (customerId) {
      check(
        'staff messages',
        await admin.from('notifications').delete().eq('recipient_id', customerId),
      );
    }
    if (branch) {
      const { data: tickets } = await admin
        .from('queue_tickets')
        .select('id')
        .eq('branch_id', branch.id);
      const ticketIds = (tickets ?? []).map((t) => t.id);
      if (ticketIds.length) {
        check('feedback', await admin.from('feedback').delete().in('ticket_id', ticketIds));
        check('queue_events', await admin.from('queue_events').delete().in('ticket_id', ticketIds));
        check(
          'notifications',
          await admin.from('notifications').delete().in('related_ticket_id', ticketIds),
        );
      }
      check('queue_tickets', await admin.from('queue_tickets').delete().eq('branch_id', branch.id));
      check(
        'branch_ticket_counters',
        await admin.from('branch_ticket_counters').delete().eq('branch_id', branch.id),
      );
    }
    for (const id of created.staffIds) {
      check(
        'staff_branch_assignments',
        await admin.from('staff_branch_assignments').delete().eq('staff_user_id', id),
      );
      check('staff_users', await admin.from('staff_users').delete().eq('id', id));
    }
    for (const id of created.authIds) await admin.auth.admin.deleteUser(id);
    if (customerId) check('customers', await admin.from('customers').delete().eq('id', customerId));
    if (bs) check('branch_services', await admin.from('branch_services').delete().eq('id', bs.id));
    if (branch) check('branches', await admin.from('branches').delete().eq('id', branch.id));
    if (service) check('services', await admin.from('services').delete().eq('id', service.id));
    if (failures.length) throw new Error(`Cleanup failed:\n${failures.join('\n')}`);
  }
});
