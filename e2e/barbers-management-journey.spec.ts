// e2e/barbers-management-journey.spec.ts
// Task 6 of the Barbers Management -- schedules & skills plan: proves the real UI built in Tasks
// 3-5 actually drives the DB machinery from Tasks 1-2 end to end -- a Branch Manager sets a
// barber's regular week and skills on screen (the barber starts with NO schedule and NO skills),
// then a customer joins that branch with "Any available" and the resulting ticket is assigned to
// that barber. The join can only succeed through what the manager did in the UI.
//
// Selectors verified against the real current rendered markup (not just the plan's draft):
//   - apps/staff/app/settings/barbers/[id]/page.tsx: the barber's name is the page's <h1>, unique
//     enough here since this test's suffix'd barberName never collides with other headings
//     ("Regular week" / "Next 4 weeks" / "Skills" from the three child sections).
//   - apps/staff/app/settings/barbers/[id]/RegularWeek.tsx: aria-labels are exactly
//     `${dayName} Working` / `${dayName} Branch` / `${dayName} Start` / `${dayName} End`
//     (apps/staff/messages/en.json's BarberDetail.working/branch/start/end concatenated with the
//     day name) -- e.g. "Monday Start". Its own save button is "Save regular week"
//     (BarberDetail.saveWeek) and its success text is "Regular week saved. The next 4 weeks have
//     been updated." (BarberDetail.weekSaved).
//   - apps/staff/app/settings/barbers/[id]/UpcomingDays.tsx ALSO renders a
//     `<select aria-label="Branch">` and time inputs `aria-label="Start"`/`"End"` (BarberDetail's
//     plain branch/start/end strings, no day prefix) but only while a day is being edited (no day
//     is ever put into edit mode in this test) -- getByLabel's default substring matching means a
//     pattern like "Monday Start" can never match a plain "Start" label (the pattern is longer than
//     the target), so no exact-matching workaround was actually needed for this test's flow.
//   - apps/staff/app/settings/barbers/[id]/SkillsEditor.tsx: a <section> with heading "Skills"
//     (BarberDetail.skillsTitle), one checkbox per branch_service (accessible name comes from the
//     wrapping <label> and the service's real name, which is fixture data this test doesn't
//     control -- hence `.first()`, the same technique e2e/barber-assignment-journey.spec.ts and
//     e2e/queue-join-now.spec.ts use for the analogous service-step button), save button
//     "Save skills" (BarberDetail.saveSkills), success text "Skills saved." (BarberDetail.skillsSaved).
//   - apps/staff/app/login/page.tsx: branch_manager (no barbers row for their staff_user_id) lands
//     on /tickets; a barber lands on /queue/today instead (verified in the login handler).
//   - apps/customer/app/book/BookFlow.tsx: choosing "Any available" (barberId === null) skips
//     find_eligible_barber entirely and goes straight to the review step, so no availability-prompt
//     step appears between the barber step and "Join Now" here.
import { test, expect } from '@playwright/test';
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const STAFF_BASE_URL = 'http://localhost:3001';
const CUSTOMER_BASE_URL = 'http://localhost:3000';
const PASSWORD = 'Test-Password-123!';

// Same cookie-seeding convention as e2e/barber-assignment-journey.spec.ts.
async function seedCookie(
  context: import('@playwright/test').BrowserContext,
  baseUrl: string,
  session: unknown,
) {
  const projectRef = new URL(url).hostname.split('.')[0];
  const cookieName = `sb-${projectRef}-auth-token`;
  const cookieValue =
    'base64-' +
    Buffer.from(JSON.stringify(session), 'utf-8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  await context.addCookies([{ name: cookieName, value: cookieValue, url: baseUrl }]);
}

test.describe('barbers management journey', () => {
  test.skip(!url || !serviceRoleKey, 'Supabase env vars not set');

  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const suffix = `${Date.now()}`;

  let branchId: string;
  let managerAuthUserId: string;
  let managerStaffUserId: string;
  let managerEmail: string;
  let barberAuthUserId: string;
  let barberStaffUserId: string;
  let barberId: string;
  let barberName: string;
  let customerAuthUserId: string;
  let customerId: string;
  let customerPhone: string;
  let ticketId: string | undefined;

  test.beforeAll(async () => {
    const { data: business } = await admin.from('businesses').select('id').limit(1).single();
    const { data: service } = await admin.from('services').select('id').limit(1).single();

    const { data: branch } = await admin
      .from('branches')
      .insert({
        business_id: business!.id,
        name: `BMJ Branch ${suffix}`,
        branch_code: `BMJ${suffix.slice(-6)}`,
        address: 'Test',
        latitude: 5.6,
        longitude: -0.18,
      })
      .select()
      .single();
    branchId = branch!.id;
    // Open all day every day: tickets-join refuses customer joins to a closed branch.
    await admin.from('branch_hours').insert(
      [0, 1, 2, 3, 4, 5, 6].map((day_of_week) => ({
        branch_id: branchId,
        day_of_week,
        opens_at: '00:00:00',
        closes_at: '23:59:59',
        is_closed: false,
      })),
    );
    await admin.from('branch_services').insert({ branch_id: branchId, service_id: service!.id });

    managerEmail = `bmj-mgr-${suffix}@test.pixelbarber.local`;
    const { data: mgrAuth } = await admin.auth.admin.createUser({
      email: managerEmail,
      password: PASSWORD,
      email_confirm: true,
    });
    managerAuthUserId = mgrAuth!.user.id;
    const { data: mgrStaff } = await admin
      .from('staff_users')
      .insert({
        auth_user_id: managerAuthUserId,
        name: `BMJ Manager ${suffix}`,
        email: managerEmail,
        role: 'branch_manager',
        invite_status: 'accepted',
      })
      .select()
      .single();
    managerStaffUserId = mgrStaff!.id;
    await admin
      .from('staff_branch_assignments')
      .insert({ staff_user_id: managerStaffUserId, branch_id: branchId });

    const barberEmail = `bmj-barber-${suffix}@test.pixelbarber.local`;
    barberName = `BMJ Barber ${suffix}`;
    const { data: barberAuth } = await admin.auth.admin.createUser({
      email: barberEmail,
      password: PASSWORD,
      email_confirm: true,
    });
    barberAuthUserId = barberAuth!.user.id;
    const { data: barberStaff } = await admin
      .from('staff_users')
      .insert({
        auth_user_id: barberAuthUserId,
        name: barberName,
        email: barberEmail,
        role: 'barber',
        invite_status: 'accepted',
      })
      .select()
      .single();
    barberStaffUserId = barberStaff!.id;
    const { data: barberRow } = await admin
      .from('barbers')
      .insert({ staff_user_id: barberStaffUserId, home_branch_id: branchId, status: 'available' })
      .select()
      .single();
    barberId = barberRow!.id;

    customerPhone = `+233${suffix.slice(-9)}`;
    const { data: customerAuth } = await admin.auth.admin.createUser({
      phone: customerPhone,
      password: PASSWORD,
      phone_confirm: true,
    });
    customerAuthUserId = customerAuth!.user.id;
    const { data: customer } = await admin
      .from('customers')
      .insert({
        auth_user_id: customerAuthUserId,
        name: `BMJ Customer ${suffix}`,
        phone_e164: customerPhone,
      })
      .select()
      .single();
    customerId = customer!.id;
  }, 60000);

  test.afterAll(async () => {
    if (ticketId) {
      await admin.from('queue_events').delete().eq('ticket_id', ticketId);
      await admin.from('notifications').delete().eq('related_ticket_id', ticketId);
      await admin.from('queue_tickets').delete().eq('id', ticketId);
    }
    await admin.from('customers').delete().eq('id', customerId);
    await admin.from('barber_days_off').delete().eq('barber_id', barberId);
    await admin.from('barber_weekly_hours').delete().eq('barber_id', barberId);
    await admin.from('barber_schedule').delete().eq('barber_id', barberId);
    await admin.from('barber_skills').delete().eq('barber_id', barberId);
    await admin.from('staff_branch_assignments').delete().eq('staff_user_id', managerStaffUserId);
    await admin.from('staff_users').delete().in('id', [managerStaffUserId, barberStaffUserId]);
    for (const authId of [managerAuthUserId, barberAuthUserId, customerAuthUserId]) {
      await admin.auth.admin.deleteUser(authId);
    }
    // next_ticket_number upserts branch_ticket_counters, which has no cascade to branches.
    await admin.from('branch_ticket_counters').delete().eq('branch_id', branchId);
    await admin.from('branches').delete().eq('id', branchId);
  }, 60000);

  test('manager schedules a barber on screen, then a customer is assigned to them', async ({
    browser,
  }) => {
    test.setTimeout(180_000);

    // --- Manager sets the barber's regular week and skills ---
    const staffContext = await browser.newContext();
    const staffPage = await staffContext.newPage();
    await staffPage.goto(`${STAFF_BASE_URL}/login`);
    await staffPage.getByPlaceholder('Email').fill(managerEmail);
    await staffPage.getByPlaceholder('Password').fill(PASSWORD);
    await staffPage.getByRole('button', { name: 'Log In' }).press('Enter');
    await staffPage.waitForURL(/\/tickets/, { timeout: 15000 });

    await staffPage.goto(`${STAFF_BASE_URL}/settings/barbers/${barberId}`);
    await expect(staffPage.getByRole('heading', { name: barberName })).toBeVisible({
      timeout: 15000,
    });

    for (const day of [
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
      'Sunday',
    ]) {
      await staffPage.getByLabel(`${day} Working`).check();
      await staffPage.getByLabel(`${day} Start`, { exact: true }).fill('00:00');
      await staffPage.getByLabel(`${day} End`, { exact: true }).fill('23:59');
    }
    await staffPage.getByRole('button', { name: 'Save regular week' }).press('Enter');
    await expect(staffPage.getByText('Regular week saved.', { exact: false })).toBeVisible({
      timeout: 15000,
    });

    const skills = staffPage.locator('section', {
      has: staffPage.getByRole('heading', { name: 'Skills' }),
    });
    await skills.getByRole('checkbox').first().check();
    await skills.getByRole('button', { name: 'Save skills' }).press('Enter');
    await expect(staffPage.getByText('Skills saved.')).toBeVisible({ timeout: 15000 });
    await staffContext.close();

    // The UI's saves really produced a dated row for today.
    const today = new Date().toISOString().slice(0, 10);
    const { data: todayRow } = await admin
      .from('barber_schedule')
      .select('work_date')
      .eq('barber_id', barberId)
      .eq('work_date', today)
      .maybeSingle();
    expect(todayRow).not.toBeNull();

    // --- Customer joins with "Any available" ---
    const customerContext = await browser.newContext();
    const { data: customerSession } = await createClient<Database>(
      url,
      anonKey,
    ).auth.signInWithPassword({
      phone: customerPhone,
      password: PASSWORD,
    });
    await seedCookie(customerContext, CUSTOMER_BASE_URL, customerSession.session);
    const customerPage = await customerContext.newPage();
    await customerPage.goto(`${CUSTOMER_BASE_URL}/book?branch=${branchId}`);
    // Scoped to <main> and using Enter: Next.js dev mode's Dev Tools badge sits outside <main>
    // and intercepts pointer clicks (see e2e/barber-assignment-journey.spec.ts).
    // The branch's only service (the Join Now/Schedule toggle buttons are not list items).
    await customerPage
      .locator('main')
      .getByRole('listitem')
      .getByRole('button')
      .first()
      .press('Enter');
    await customerPage.getByRole('button', { name: 'Any available' }).press('Enter');
    await customerPage.getByRole('button', { name: 'Join Now' }).press('Enter');
    await customerPage.waitForURL(/\/tickets\//, { timeout: 15000 });

    const { data: ticket } = await admin
      .from('queue_tickets')
      .select('id, assigned_barber_id')
      .eq('customer_id', customerId)
      .not('state', 'in', '(completed,cancelled,no_show)')
      .single();
    ticketId = ticket!.id;
    expect(ticket!.assigned_barber_id).toBe(barberId);
    await customerContext.close();
  });
});
