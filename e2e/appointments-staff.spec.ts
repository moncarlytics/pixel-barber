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
  const today = new Date().toISOString().slice(0, 10);
  const serviceName = `Staff E2E Cut ${suffix}`;
  // The next full UTC hour: the check-in step needs an appointment for today at a future slot.
  const nextHour = new Date(Math.ceil((Date.now() + 60_000) / HOUR) * HOUR);
  const todayWorks = nextHour.toISOString().slice(0, 10) === today;
  const walkerDay = todayWorks ? today : tomorrow;
  const walkerTime = todayWorks ? nextHour.toISOString().slice(11, 16) : '10:00';

  let service: { id: string } | null = null;
  let branch: { id: string } | null = null;
  let bs: { id: string } | null = null;
  let barber: { id: string } | null = null;
  let barberStaff: { id: string } | null = null;
  let recepStaff: { id: string } | null = null;
  let barberAuth: { user: { id: string } } | null = null;
  let recepAuth: { user: { id: string } } | null = null;
  const customerIds: string[] = [];
  let barberContext: Awaited<ReturnType<typeof browser.newContext>> | null = null;

  try {
    const { data: business } = await admin.from('businesses').select('id').limit(1).single();
    service = (
      await admin
        .from('services')
        .insert({ business_id: business!.id, name: serviceName, default_duration_minutes: 30 })
        .select('id')
        .single()
    ).data;
    branch = (
      await admin
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
        .single()
    ).data;
    await admin.from('branch_hours').insert(
      [0, 1, 2, 3, 4, 5, 6].map((day_of_week) => ({
        branch_id: branch!.id,
        day_of_week,
        opens_at: '00:00:00',
        closes_at: '23:59:59',
        is_closed: false,
      })),
    );
    bs = (
      await admin
        .from('branch_services')
        .insert({ branch_id: branch!.id, service_id: service!.id })
        .select('id')
        .single()
    ).data;
    barberAuth = (
      await admin.auth.admin.createUser({
        email: barberEmail,
        password: PASSWORD,
        email_confirm: true,
      })
    ).data as { user: { id: string } };
    barberStaff = (
      await admin
        .from('staff_users')
        .insert({
          auth_user_id: barberAuth!.user.id,
          name: 'Staff E2E Barber',
          email: barberEmail,
          role: 'barber',
          invite_status: 'accepted',
        })
        .select('id')
        .single()
    ).data;
    barber = (
      await admin
        .from('barbers')
        .insert({ staff_user_id: barberStaff!.id, home_branch_id: branch!.id, status: 'available' })
        .select('id')
        .single()
    ).data;
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
    recepAuth = (
      await admin.auth.admin.createUser({
        email: recepEmail,
        password: PASSWORD,
        email_confirm: true,
      })
    ).data as { user: { id: string } };
    recepStaff = (
      await admin
        .from('staff_users')
        .insert({
          auth_user_id: recepAuth!.user.id,
          name: 'Staff E2E Receptionist',
          email: recepEmail,
          role: 'receptionist',
          invite_status: 'accepted',
        })
        .select('id')
        .single()
    ).data;
    await admin
      .from('staff_branch_assignments')
      .insert({ staff_user_id: recepStaff!.id, branch_id: branch!.id });

    const main = page.locator('main');
    const labelFor = (day: string) =>
      new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
      });
    const tomorrowLabel = labelFor(tomorrow);
    const walkerLabel = labelFor(walkerDay);

    async function bookFor(
      customerName: string,
      customerPhone: string,
      time: string,
      dayLabel: string,
    ) {
      await main.getByRole('link', { name: 'Book for a customer' }).press('Enter');
      await page.getByPlaceholder('Customer name').fill(customerName);
      if (customerPhone) await page.getByPlaceholder('Phone (optional)').fill(customerPhone);
      await main.getByRole('button', { name: 'Continue' }).press('Enter');
      await main.getByRole('button', { name: serviceName }).press('Enter');
      await main.getByRole('button', { name: 'Staff E2E Barber' }).press('Enter');
      await main.getByRole('button', { name: dayLabel }).press('Enter');
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

    // --- 2. Book for a customer: today at the next full hour (tomorrow 10:00 if that crosses midnight) ---
    if (!todayWorks) {
      test.info().annotations.push({
        type: 'skipped-step',
        description: 'Check-in skipped: next full hour crosses UTC midnight',
      });
    }
    await bookFor('Staff E2E Walker', phone, walkerTime, walkerLabel);

    // --- 3. Check in (only offered on the day of the appointment) ---
    if (todayWorks) {
      await main.getByRole('button', { name: 'Check in' }).press('Enter');
      await expect(main.getByText('Status: Checked in')).toBeVisible({ timeout: 15000 });
    } else {
      await expect(main.getByRole('button', { name: 'Check in' })).toHaveCount(0);
    }

    // --- 4. Calendar shows it ---
    await page.goto(`${STAFF}/appointments`);
    await main.getByLabel('Branch', { exact: true }).selectOption(branch!.id);
    if (!todayWorks) await main.getByRole('button', { name: 'Next day' }).press('Enter');
    await expect(
      main.getByRole('link', { name: new RegExp(`${walkerTime} � Staff E2E Walker`) }),
    ).toBeVisible({ timeout: 15000 });

    // --- 5. Second booking, reschedule, cancel ---
    await bookFor('Staff E2E Second', '', '11:00', tomorrowLabel);
    await main.getByRole('button', { name: 'Reschedule' }).press('Enter');
    await main.getByRole('button', { name: tomorrowLabel }).press('Enter');
    await main.getByRole('button', { name: '12:00' }).press('Enter');
    await main.getByRole('button', { name: 'Move to this time' }).press('Enter');
    await expect(main.getByText('Time: 12:00')).toBeVisible({ timeout: 15000 });
    await main.getByRole('button', { name: 'Cancel appointment' }).press('Enter');
    await main.getByLabel("Can't make it").check();
    await main.getByRole('button', { name: 'Confirm cancellation' }).press('Enter');
    await expect(main.getByText('Status: Cancelled')).toBeVisible({ timeout: 15000 });

    // --- 6. Barber sees an appointment for later today (half an hour after the Walker slot) ---
    const laterToday = new Date(nextHour.getTime() + 30 * 60_000);
    if (!todayWorks || laterToday.toISOString().slice(0, 10) !== today) {
      test.info().annotations.push({
        type: 'skipped-step',
        description: 'Step 6 skipped: the later-today slot crosses UTC midnight',
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
        scheduled_start: laterToday.toISOString(),
        scheduled_end: new Date(laterToday.getTime() + 30 * 60_000).toISOString(),
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
    expect(first).toMatchObject({
      status: todayWorks ? 'checked_in' : 'scheduled',
      created_by: 'staff',
    });
    const { data: second } = await admin
      .from('appointments')
      .select('status, cancel_reason')
      .eq('customer_id', byName('Staff E2E Second'))
      .single();
    expect(second).toMatchObject({ status: 'cancelled', cancel_reason: 'cant_make_it' });
  } finally {
    await barberContext?.close();
    // FK-safe cleanup scoped to this test's rows; every failure is collected and thrown at the end.
    const failures: string[] = [];
    const check = (label: string, res: { error: { message: string } | null }) => {
      if (res.error) failures.push(`${label}: ${res.error.message}`);
    };
    // Setup may have failed part-way, so every step is guarded by what actually got created.
    let ticketIds: string[] = [];
    let apptIds: string[] = [];
    if (branch) {
      const { data: tickets } = await admin
        .from('queue_tickets')
        .select('id')
        .eq('branch_id', branch.id);
      ticketIds = (tickets ?? []).map((r) => r.id);
      const { data: appts } = await admin
        .from('appointments')
        .select('id')
        .eq('branch_id', branch.id);
      apptIds = (appts ?? []).map((r) => r.id);
    }
    const { data: leftover } = await admin
      .from('customers')
      .select('id')
      .in('name', ['Staff E2E Walker', 'Staff E2E Second', 'Todayguy Staffe2e']);
    const ids = [...new Set([...customerIds, ...(leftover ?? []).map((c) => c.id)])];

    if (ticketIds.length) {
      check('queue_events', await admin.from('queue_events').delete().in('ticket_id', ticketIds));
      check(
        'notifications(ticket)',
        await admin.from('notifications').delete().in('related_ticket_id', ticketIds),
      );
    }
    if (apptIds.length) {
      check(
        'notifications(appointment)',
        await admin.from('notifications').delete().in('related_appointment_id', apptIds),
      );
    }
    if (branch) {
      check('queue_tickets', await admin.from('queue_tickets').delete().eq('branch_id', branch.id));
      check('appointments', await admin.from('appointments').delete().eq('branch_id', branch.id));
      check(
        'branch_ticket_counters',
        await admin.from('branch_ticket_counters').delete().eq('branch_id', branch.id),
      );
    }
    if (barber) {
      check(
        'barber_schedule',
        await admin.from('barber_schedule').delete().eq('barber_id', barber.id),
      );
      check('barber_skills', await admin.from('barber_skills').delete().eq('barber_id', barber.id));
    }
    if (recepStaff) {
      check(
        'staff_branch_assignments',
        await admin.from('staff_branch_assignments').delete().eq('staff_user_id', recepStaff.id),
      );
      check('staff_users(recep)', await admin.from('staff_users').delete().eq('id', recepStaff.id));
    }
    if (barberStaff) {
      check(
        'staff_users(barber)',
        await admin.from('staff_users').delete().eq('id', barberStaff.id),
      );
    }
    if (recepAuth) check('auth(recep)', await admin.auth.admin.deleteUser(recepAuth.user.id));
    if (barberAuth) check('auth(barber)', await admin.auth.admin.deleteUser(barberAuth.user.id));
    if (ids.length) check('customers', await admin.from('customers').delete().in('id', ids));
    check('customers(phone)', await admin.from('customers').delete().eq('phone_e164', phoneE164));
    if (bs) check('branch_services', await admin.from('branch_services').delete().eq('id', bs.id));
    if (branch) {
      check('branch_hours', await admin.from('branch_hours').delete().eq('branch_id', branch.id));
      check('branches', await admin.from('branches').delete().eq('id', branch.id));
    }
    if (service) check('services', await admin.from('services').delete().eq('id', service.id));
    if (failures.length) throw new Error(`e2e cleanup failed:\n${failures.join('\n')}`);
  }
});
