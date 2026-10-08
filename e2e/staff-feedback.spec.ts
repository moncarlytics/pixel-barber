// e2e/staff-feedback.spec.ts
// After-visit feedback, staff side: a branch manager sees the low-rating banner, opens Feedback,
// marks the rating seen, and the banner disappears. Clicks use Enter; page content is in <main>,
// the banner is in the header.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const STAFF = 'http://localhost:3001';
const PASSWORD = 'Test-Password-123!';

test('branch manager sees a low rating, marks it seen, and the banner clears', async ({ page }) => {
  test.skip(!url || !serviceRoleKey, 'Supabase env vars not set');
  test.setTimeout(120_000);
  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const suffix = String(Date.now());
  const managerEmail = `sfb-mgr-${suffix}@test.pixelbarber.local`;
  const barberEmail = `sfb-barber-${suffix}@test.pixelbarber.local`;
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
          name: `SFB E2E Cut ${suffix}`,
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
          name: `SFB E2E Branch ${suffix}`,
          branch_code: `SF${suffix.slice(-6)}`,
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
    const staff = async (email: string, name: string, role: 'barber' | 'branch_manager') => {
      const { data: auth } = await admin.auth.admin.createUser({
        email,
        password: PASSWORD,
        email_confirm: true,
      });
      created.authIds.push(auth.user!.id);
      const { data: row } = await admin
        .from('staff_users')
        .insert({ auth_user_id: auth.user!.id, name, email, role, invite_status: 'accepted' })
        .select('id')
        .single();
      created.staffIds.push(row!.id);
      return row!.id as string;
    };
    const barberStaffId = await staff(barberEmail, 'SFB E2E Barber', 'barber');
    const { data: barber } = await admin
      .from('barbers')
      .insert({ staff_user_id: barberStaffId, home_branch_id: branch!.id, status: 'available' })
      .select('id')
      .single();
    const managerStaffId = await staff(managerEmail, 'SFB E2E Manager', 'branch_manager');
    await admin
      .from('staff_branch_assignments')
      .insert({ staff_user_id: managerStaffId, branch_id: branch!.id });
    // A staff-created customer (no app account) rated through admin for this test.
    customerId = (
      await admin
        .from('customers')
        .insert({ name: 'Kofi Rater', phone_e164: `+233550${suffix.slice(-6)}` })
        .select('id')
        .single()
    ).data!.id;
    const { data: ticket } = await admin
      .from('queue_tickets')
      .insert({
        ticket_number: `PB-SFB-${suffix}`,
        branch_id: branch!.id,
        customer_id: customerId!,
        branch_service_id: bs!.id,
        assigned_barber_id: barber!.id,
        state: 'completed',
        completed_at: new Date().toISOString(),
        created_by: 'staff',
      })
      .select('id')
      .single();
    await admin.from('feedback').insert({
      ticket_id: ticket!.id,
      customer_id: customerId!,
      branch_id: branch!.id,
      barber_id: barber!.id,
      overall_rating: 1,
      comment: 'Waited 40 minutes past my turn',
    });

    await page.goto(`${STAFF}/login`);
    await page.getByPlaceholder('Email or phone').fill(managerEmail);
    await page.getByPlaceholder('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Log In' }).press('Enter');
    await page.waitForURL(/\/tickets/, { timeout: 15000 });

    const banner = page.getByRole('link', { name: /1 new low rating — View/ });
    await expect(banner).toBeVisible({ timeout: 15000 });
    await banner.press('Enter');
    await expect(page).toHaveURL(/\/feedback$/, { timeout: 15000 });
    const main = page.locator('main');
    await main.getByLabel('Branch', { exact: true }).selectOption(branch!.id);
    await expect(main.getByText('Waited 40 minutes past my turn')).toBeVisible({ timeout: 15000 });
    await expect(main.getByText('Last 30 days: 1.00 average from 1 ratings')).toBeVisible();
    await main.getByRole('button', { name: 'Mark as seen' }).press('Enter');
    await expect(main.getByText(/Seen by SFB E2E Manager on/)).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('link', { name: /new low rating/ })).toHaveCount(0, {
      timeout: 15000,
    });
  } finally {
    const failures: string[] = [];
    const check = (label: string, res: { error: { message: string } | null }) => {
      if (res.error) failures.push(`${label}: ${res.error.message}`);
    };
    if (branch) {
      const { data: tickets } = await admin
        .from('queue_tickets')
        .select('id')
        .eq('branch_id', branch.id);
      const ticketIds = (tickets ?? []).map((t) => t.id);
      if (ticketIds.length) {
        check('feedback', await admin.from('feedback').delete().in('ticket_id', ticketIds));
        check(
          'notifications',
          await admin.from('notifications').delete().in('related_ticket_id', ticketIds),
        );
        check('queue_events', await admin.from('queue_events').delete().in('ticket_id', ticketIds));
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
