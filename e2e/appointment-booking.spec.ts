// e2e/appointment-booking.spec.ts
// A customer books through Book → Schedule, sees it under Upcoming, reschedules it, and cancels it.
// Brings its own branch (open all day), a 30-minute service and a barber scheduled for 3 days.
// Clicks use Enter and are scoped to <main> (Next.js dev mode's Dev Tools badge).
import { test, expect } from '@playwright/test';
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PASSWORD = 'Test-Password-123!';
const DAY = 24 * 60 * 60 * 1000;

test('customer books, reschedules and cancels an appointment', async ({
  page,
  context,
  baseURL,
}) => {
  test.skip(!url || !serviceRoleKey, 'Supabase env vars not set');
  test.setTimeout(120_000);
  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const suffix = String(Date.now());
  // 0556… : distinct from the phone ranges other test files use.
  const phone = `+233556${suffix.slice(-6)}`;
  const barberEmail = `appt-e2e-${suffix}@test.pixelbarber.local`;
  const tomorrow = new Date(Date.now() + DAY).toISOString().slice(0, 10);
  const serviceName = `Appt E2E Cut ${suffix}`;

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
      name: `Appt E2E Branch ${suffix}`,
      branch_code: `AE${suffix.slice(-6)}`,
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
  const { data: staff } = await admin
    .from('staff_users')
    .insert({
      auth_user_id: barberAuth!.user.id,
      name: 'Appt E2E Barber',
      email: barberEmail,
      role: 'barber',
      invite_status: 'accepted',
    })
    .select('id')
    .single();
  const { data: barber } = await admin
    .from('barbers')
    .insert({ staff_user_id: staff!.id, home_branch_id: branch!.id, status: 'available' })
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
  const { data: customerAuth } = await admin.auth.admin.createUser({
    phone,
    password: PASSWORD,
    phone_confirm: true,
  });
  const { data: customer } = await admin
    .from('customers')
    .insert({
      auth_user_id: customerAuth!.user.id,
      name: 'Appt E2E Customer',
      phone_e164: phone,
      avatar_key: 'avatar-1',
    })
    .select('id')
    .single();

  try {
    const { data: sessionData } = await createClient<Database>(
      url,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    ).auth.signInWithPassword({ phone, password: PASSWORD });
    const projectRef = new URL(url).hostname.split('.')[0];
    const cookieValue =
      'base64-' +
      Buffer.from(JSON.stringify(sessionData.session), 'utf-8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    await context.addCookies([
      {
        name: `sb-${projectRef}-auth-token`,
        value: cookieValue,
        url: baseURL ?? 'http://localhost:3000',
      },
    ]);

    const main = page.locator('main');
    const labelFor = (day: string) =>
      new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
      });
    const tomorrowLabel = labelFor(tomorrow);

    // --- Book 10:00 tomorrow ---
    await page.goto(`/book?branch=${branch!.id}`);
    await main.getByRole('button', { name: 'Schedule' }).press('Enter');
    await main.getByRole('button', { name: new RegExp(serviceName) }).press('Enter');
    await main.getByRole('button', { name: barber!.id }).press('Enter');
    await main.getByRole('button', { name: tomorrowLabel }).press('Enter');
    await main.getByRole('button', { name: '10:00' }).press('Enter');
    await main.getByRole('button', { name: 'Book Appointment' }).press('Enter');
    await expect(page).toHaveURL(/\/appointments\/[0-9a-f-]+\?booked=1/, { timeout: 15000 });
    await expect(main.getByRole('heading', { name: 'Your appointment is booked' })).toBeVisible();
    await expect(main.getByText('Time: 10:00')).toBeVisible();

    // --- Upcoming lists it ---
    await page.goto('/tickets');
    const upcoming = main.getByRole('region', { name: 'Upcoming' });
    const escapedLabel = tomorrowLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const entry = upcoming.getByRole('link', { name: new RegExp(`^${escapedLabel} 10:00`) });
    await expect(entry).toBeVisible({ timeout: 15000 });
    await entry.press('Enter');
    await expect(page).toHaveURL(/\/appointments\/[0-9a-f-]+$/, { timeout: 15000 });

    // --- Reschedule to 11:00 the same day ---
    await main.getByRole('button', { name: 'Reschedule' }).press('Enter');
    await main.getByRole('button', { name: tomorrowLabel }).press('Enter');
    await main.getByRole('button', { name: '11:00' }).press('Enter');
    await main.getByRole('button', { name: 'Move to this time' }).press('Enter');
    await expect(main.getByText('Time: 11:00')).toBeVisible({ timeout: 15000 });

    // --- Cancel ---
    await main.getByRole('button', { name: 'Cancel appointment' }).press('Enter');
    await main.getByLabel("Can't make it").check();
    await main.getByRole('button', { name: 'Confirm cancellation' }).press('Enter');
    await expect(main.getByText('Status: cancelled')).toBeVisible({ timeout: 15000 });

    const { data: rows } = await admin
      .from('appointments')
      .select('status, cancel_reason, scheduled_start')
      .eq('customer_id', customer!.id);
    expect(rows).toHaveLength(1);
    expect(rows![0]).toMatchObject({ status: 'cancelled', cancel_reason: 'cant_make_it' });
    expect(new Date(rows![0].scheduled_start).toISOString()).toBe(`${tomorrow}T11:00:00.000Z`);

    await page.goto('/tickets');
    await expect(
      main.getByRole('region', { name: 'Upcoming' }).getByText('No upcoming appointments.'),
    ).toBeVisible({ timeout: 15000 });
  } finally {
    await admin.from('appointments').delete().eq('customer_id', customer!.id);
    await admin.from('customers').delete().eq('id', customer!.id);
    await admin.auth.admin.deleteUser(customerAuth!.user.id);
    await admin.from('barber_schedule').delete().eq('barber_id', barber!.id);
    await admin.from('barber_skills').delete().eq('barber_id', barber!.id);
    await admin.from('staff_users').delete().eq('id', staff!.id);
    await admin.auth.admin.deleteUser(barberAuth!.user.id);
    await admin.from('branch_services').delete().eq('id', bs!.id);
    await admin.from('branch_hours').delete().eq('branch_id', branch!.id);
    await admin.from('branches').delete().eq('id', branch!.id);
    await admin.from('services').delete().eq('id', service!.id);
  }
});
