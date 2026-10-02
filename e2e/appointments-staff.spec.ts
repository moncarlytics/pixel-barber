// e2e/appointments-staff.spec.ts
// A receptionist books for a customer, checks in, sees it on the calendar, books a second one and
// reschedules + cancels it; then a barber sees their own appointment on Today's Queue.
// Brings its own branch (open all day), a 30-minute service, a barber and a receptionist.
// Clicks use Enter and are scoped to <main> (Next.js dev mode's Dev Tools badge).
import { test, expect, type Page } from '@playwright/test';
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const STAFF = 'http://localhost:3001';
const PASSWORD = 'Test-Password-123!';
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

async function staffLogin(page: Page, email: string) {
  await page.goto(`${STAFF}/login`);
  await page.getByPlaceholder('Email or phone').fill(email);
  await page.getByPlaceholder('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log In' }).press('Enter');
}

test('receptionist books, checks in, reschedules and cancels; barber sees today list', async ({
  page,
  browser,
}) => {
  test.skip(!url || !serviceRoleKey, 'Supabase env vars not set');
  test.setTimeout(180_000);
  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const suffix = String(Date.now());
  const phone = `0557${suffix.slice(-6)}`;
  const phoneE164 = `+233557${suffix.slice(-6)}`;
  const todayPhoneE164 = `+233558${suffix.slice(-6)}`;
  const barberEmail = `sa-barber-${suffix}@test.pixelbarber.local`;
  const recepEmail = `sa-recep-${suffix}@test.pixelbarber.local`;
  const tomorrow = new Date(Date.now() + DAY).toISOString().slice(0, 10);
  const serviceName = `Staff E2E Cut ${suffix}`;

  const { data: business } = await admin.from('businesses').select('id').limit(1).single();
  const { data: service } = await admin
    .from('services')
    .insert({ business_id: business!.id, name: serviceName, default_duration_minutes: 30 })
    .select('id')
    .single();
  const { data: branch } = await admin
    .from('branches')
    .insert({
      business_id: business!.id,
      name: `Staff E2E Branch ${suffix}`,
      branch_code: `SA${suffix.slice(-6)}`,
      address: 'Test',
      latitude: 5.6,
      longitude: -0.18,
    })
    .select('id')
    .single();
  await admin.from('branch_hours').insert(
    [0, 1, 2, 3, 4, 5, 6].map((day_of_week) => ({
      branch_id: branch!.id,
      day_of_week,
      opens_at: '00:00:00',
      closes_at: '23:59:59',
      is_closed: false,
    })),
  );
  const { data: bs } = await admin
    .from('branch_services')
    .insert({ branch_id: branch!.id, service_id: service!.id })
    .select('id')
    .single();
  const { data: barberAuth } = await admin.auth.admin.createUser({
    email: barberEmail,
    password: PASSWORD,
    email_confirm: true,
  });
  const { data: barberStaff } = await admin
    .from('staff_users')
    .insert({
      auth_user_id: barberAuth!.user.id,
      name: 'Staff E2E Barber',
      email: barberEmail,
      role: 'barber',
      invite_status: 'accepted',
    })
    .select('id')
    .single();
  const { data: barber } = await admin
    .from('barbers')
    .insert({ staff_user_id: barberStaff!.id, home_branch_id: branch!.id, status: 'available' })
    .select('id')
    .single();
  await admin.from('barber_skills').insert({ barber_id: barber!.id, service_id: service!.id });
  await admin.from('barber_schedule').delete().eq('barber_id', barber!.id);
  await admin.from('barber_schedule').insert(
    [0, 1, 2].map((i) => ({
      barber_id: barber!.id,
      work_date: new Date(Date.now() + i * DAY).toISOString().slice(0, 10),
      branch_id: branch!.id,
      shift_start: '00:00:00',
      shift_end: '23:59:59',
    })),
  );
  const { data: recepAuth } = await admin.auth.admin.createUser({
    email: recepEmail,
    password: PASSWORD,
    email_confirm: true,
  });
  const { data: recepStaff } = await admin
    .from('staff_users')
    .insert({
      auth_user_id: recepAuth!.user.id,
      name: 'Staff E2E Receptionist',
      email: recepEmail,
      role: 'receptionist',
      invite_status: 'accepted',
    })
    .select('id')
    .single();
  await admin
    .from('staff_branch_assignments')
    .insert({ staff_user_id: recepStaff!.id, branch_id: branch!.id });

  const customerIds: string[] = [];
  let barberContext: Awaited<ReturnType<typeof browser.newContext>> | null = null;

  try {
    const main = page.locator('main');
    const labelFor = (day: string) =>
      new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
      });
    const tomorrowLabel = labelFor(tomorrow);

    async function bookFor(customerName: string, customerPhone: string, time: string) {
      await main.getByRole('link', { name: 'Book for a customer' }).press('Enter');
      await page.getByPlaceholder('Customer name').fill(customerName);
      if (customerPhone) await page.getByPlaceholder('Phone (optional)').fill(customerPhone);
      await main.getByRole('button', { name: 'Continue' }).press('Enter');
      await main.getByRole('button', { name: serviceName }).press('Enter');
      await main.getByRole('button', { name: 'Staff E2E Barber' }).press('Enter');
      await main.getByRole('button', { name: tomorrowLabel }).press('Enter');
      await main.getByRole('button', { name: time }).press('Enter');
      await main.getByRole('button', { name: 'Book appointment' }).press('Enter');
      await expect(page).toHaveURL(/\/appointments\/[0-9a-f-]{36}$/, { timeout: 15000 });
      await expect(main.getByText('Status: Booked')).toBeVisible({ timeout: 15000 });
    }

    // --- 1. Receptionist logs in and opens the calendar ---
    await staffLogin(page, recepEmail);
    await page.waitForURL(/\/tickets/, { timeout: 15000 });
    await page.goto(`${STAFF}/appointments`);
    await main.getByLabel('Branch', { exact: true }).selectOption(branch!.id);

    // --- 2. Book for a customer: tomorrow 10:00 ---
    await bookFor('Staff E2E Walker', phone, '10:00');

    // --- 3. Check in ---
    await main.getByRole('button', { name: 'Check in' }).press('Enter');
    await expect(main.getByText('Status: Checked in')).toBeVisible({ timeout: 15000 });

    // --- 4. Calendar shows it tomorrow ---
    await page.goto(`${STAFF}/appointments`);
    await main.getByLabel('Branch', { exact: true }).selectOption(branch!.id);
    await main.getByRole('button', { name: 'Next day' }).press('Enter');
    await expect(main.getByRole('link', { name: /10:00 — Staff E2E Walker/ })).toBeVisible({
      timeout: 15000,
    });

    // --- 5. Second booking, reschedule, cancel ---
    await bookFor('Staff E2E Second', '', '11:00');
    await main.getByRole('button', { name: 'Reschedule' }).press('Enter');
    await main.getByRole('button', { name: tomorrowLabel }).press('Enter');
    await main.getByRole('button', { name: '12:00' }).press('Enter');
    await main.getByRole('button', { name: 'Move to this time' }).press('Enter');
    await expect(main.getByText('Time: 12:00')).toBeVisible({ timeout: 15000 });
    await main.getByRole('button', { name: 'Cancel appointment' }).press('Enter');
    await main.getByLabel("Can't make it").check();
    await main.getByRole('button', { name: 'Confirm cancellation' }).press('Enter');
    await expect(main.getByText('Status: Cancelled')).toBeVisible({ timeout: 15000 });

    // --- 6. Barber sees an appointment for later today ---
    const nextHour = new Date(Math.ceil((Date.now() + 60_000) / HOUR) * HOUR);
    if (nextHour.toISOString().slice(0, 10) !== new Date().toISOString().slice(0, 10)) {
      test.info().annotations.push({
        type: 'skipped-step',
        description: 'Step 6 skipped: next full hour crosses UTC midnight',
      });
    } else {
      const { data: todayCustomer } = await admin
        .from('customers')
        .insert({ name: 'Todayguy Staffe2e', phone_e164: todayPhoneE164 })
        .select('id')
        .single();
      customerIds.push(todayCustomer!.id);
      const { error: insertError } = await admin.from('appointments').insert({
        branch_id: branch!.id,
        branch_service_id: bs!.id,
        customer_id: todayCustomer!.id,
        preferred_barber_id: barber!.id,
        scheduled_start: nextHour.toISOString(),
        scheduled_end: new Date(nextHour.getTime() + 30 * 60_000).toISOString(),
        status: 'scheduled',
        created_by: 'staff',
        created_by_staff_id: recepStaff!.id,
      });
      expect(insertError).toBeNull();

      barberContext = await browser.newContext();
      const barberPage = await barberContext.newPage();
      await staffLogin(barberPage, barberEmail);
      await barberPage.waitForURL(/\/queue\/today/, { timeout: 15000 });
      await barberPage.goto(`${STAFF}/queue/today`);
      await expect(
        barberPage
          .locator('main')
          .getByRole('region', { name: "Today's appointments" })
          .getByText(/Todayguy/),
      ).toBeVisible({ timeout: 20000 });
    }

    // --- 7. DB asserts ---
    const { data: customers } = await admin
      .from('customers')
      .select('id, name')
      .in('name', ['Staff E2E Walker', 'Staff E2E Second']);
    for (const c of customers ?? []) customerIds.push(c.id);
    const byName = (n: string) => customers!.find((c) => c.name === n)!.id;
    const { data: first } = await admin
      .from('appointments')
      .select('status, created_by')
      .eq('customer_id', byName('Staff E2E Walker'))
      .single();
    expect(first).toMatchObject({ status: 'checked_in', created_by: 'staff' });
    const { data: second } = await admin
      .from('appointments')
      .select('status, cancel_reason')
      .eq('customer_id', byName('Staff E2E Second'))
      .single();
    expect(second).toMatchObject({ status: 'cancelled', cancel_reason: 'cant_make_it' });
  } finally {
    await barberContext?.close();
    const { data: leftover } = await admin
      .from('customers')
      .select('id')
      .in('name', ['Staff E2E Walker', 'Staff E2E Second', 'Todayguy Staffe2e']);
    const ids = [...new Set([...customerIds, ...(leftover ?? []).map((c) => c.id)])];
    await admin.from('appointments').delete().eq('branch_id', branch!.id);
    if (ids.length) await admin.from('customers').delete().in('id', ids);
    await admin.from('customers').delete().eq('phone_e164', phoneE164);
    await admin.from('barber_schedule').delete().eq('barber_id', barber!.id);
    await admin.from('barber_skills').delete().eq('barber_id', barber!.id);
    await admin.from('staff_branch_assignments').delete().eq('staff_user_id', recepStaff!.id);
    await admin.from('staff_users').delete().eq('id', recepStaff!.id);
    await admin.from('staff_users').delete().eq('id', barberStaff!.id);
    await admin.auth.admin.deleteUser(recepAuth!.user.id);
    await admin.auth.admin.deleteUser(barberAuth!.user.id);
    await admin.from('branch_services').delete().eq('id', bs!.id);
    await admin.from('branch_hours').delete().eq('branch_id', branch!.id);
    await admin.from('branches').delete().eq('id', branch!.id);
    await admin.from('services').delete().eq('id', service!.id);
  }
});
