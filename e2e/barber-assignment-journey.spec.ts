// e2e/barber-assignment-journey.spec.ts
// Task 7 of the Barber Assignment & Queue Progression plan: the one test in this feature meant to
// prove the real UI built in Tasks 4-6 actually works end to end, on top of Tasks 1-3's DB-level
// machinery (find_eligible_barber, its wiring into ticket creation, and position-driven
// called/almost_turn promotion) -- a customer whose preferred barber is busy-but-scheduled-today
// sees the Book flow's wait-vs-fallback prompt, chooses "take next available," and the resulting
// ticket lands assigned_barber_id'd to the fallback barber -- verified both directly via the admin
// client AND cross-surface on the fallback barber's own real Today's Queue screen.
//
// Selectors below were verified against the REAL current rendered markup, not the plan's draft:
//   - apps/customer/app/book/BookFlow.tsx: the barber-selection step renders each barber's raw
//     `b.id` as its button text (no Barbers Management yet, a known pre-existing limitation, not
//     this task's problem to fix); the service step's buttons render the service's real name, which
//     is fixture data this test doesn't control, so the first (only, for this fixture's one
//     branch_service) button is clicked instead of matching literal text -- the same technique
//     e2e/queue-join-now.spec.ts already uses for this exact step. The availability step's copy
//     ("Barber Availability" / "Take next available" / "Wait for this barber") and the review
//     step's "Join Now" button come straight from apps/customer/messages/en.json's Book namespace.
//   - The customer browser context needs a real authenticated session for BookFlow's
//     handleConfirmJoin (it calls supabase.auth.getSession() and shows "Not signed in." otherwise)
//     -- the plan's draft never authenticated the customer context at all. This test seeds the same
//     sb-<project-ref>-auth-token cookie e2e/queue-join-now.spec.ts and
//     e2e/no-show-cross-surface-journey.spec.ts already use, rather than a UI login (the customer
//     app has no password-login page for this phone+password test account to drive).
//   - apps/staff/app/queue/today/page.tsx renders a ticket's number via
//     t('ticketNumberLabel', { number }), which apps/staff/messages/en.json defines as
//     "Ticket {number}".
//   - apps/staff/app/login/page.tsx has no <label> elements on its email/password inputs -- they're
//     identified only by placeholder text ("Email" / "Password") -- so the plan's draft
//     `getByLabel(/email/i)` would never match anything. Its submit button's real text is "Log In"
//     (apps/staff/messages/en.json's Login.logIn), not "Sign In" as the draft assumed.
import { test, expect } from '@playwright/test';
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const STAFF_BASE_URL = 'http://localhost:3001';
const PASSWORD = 'Test-Password-123!';

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

test.describe('barber assignment cross-surface journey', () => {
  test.skip(!url || !serviceRoleKey, 'Supabase env vars not set');

  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const suffix = Date.now();

  let branchId: string;
  let branchServiceId: string;
  let busyBarberId: string;
  let busyBarberStaffUserId: string;
  let busyBarberAuthUserId: string;
  let fallbackBarberId: string;
  let fallbackBarberStaffUserId: string;
  let fallbackBarberAuthUserId: string;
  let fallbackBarberEmail: string;
  let customerPhone: string;
  let customerAuthUserId: string;
  let customerId: string;
  let ticketId: string | undefined;

  test.beforeAll(async () => {
    const { data: business } = await admin.from('businesses').select('id').limit(1).single();
    const { data: service } = await admin.from('services').select('id').limit(1).single();

    const { data: branch } = await admin
      .from('branches')
      .insert({
        business_id: business!.id,
        name: 'Barber Assignment Journey Branch',
        branch_code: `BAJ${suffix % 100000}`,
        address: 'Test',
        latitude: 5.6,
        longitude: -0.18,
      })
      .select()
      .single();
    branchId = branch!.id;

    // branch_status_view treats a branch with no opening hours as closed, and tickets-join now
    // refuses customer joins to a closed branch -- open this test branch all day, every day.
    await admin.from('branch_hours').insert(
      [0, 1, 2, 3, 4, 5, 6].map((day_of_week) => ({
        branch_id: branchId,
        day_of_week,
        opens_at: '00:00:00',
        closes_at: '23:59:59',
        is_closed: false,
      })),
    );

    const { data: bs } = await admin
      .from('branch_services')
      .insert({ branch_id: branchId, service_id: service!.id })
      .select()
      .single();
    branchServiceId = bs!.id;

    const today = new Date().toISOString().slice(0, 10);

    // "Busy" barber: skilled and scheduled today, but status 'offline' -- find_eligible_barber
    // excludes 'offline' from its `eligible` CTE while still finding the schedule row, so this is
    // exactly the "ineligible but scheduled today" case that makes BookFlow show the availability
    // prompt instead of silently falling back with no prompt at all.
    const busyEmail = `baj-busy-${suffix}@test.pixelbarber.local`;
    const { data: busyAuth } = await admin.auth.admin.createUser({
      email: busyEmail,
      password: PASSWORD,
      email_confirm: true,
    });
    busyBarberAuthUserId = busyAuth!.user.id;
    const { data: busyStaff } = await admin
      .from('staff_users')
      .insert({
        auth_user_id: busyBarberAuthUserId,
        name: 'Baj Busy Barber',
        email: busyEmail,
        role: 'barber',
        invite_status: 'accepted',
      })
      .select()
      .single();
    busyBarberStaffUserId = busyStaff!.id;
    const { data: busyBarber } = await admin
      .from('barbers')
      .insert({ staff_user_id: busyBarberStaffUserId, home_branch_id: branchId, status: 'offline' })
      .select()
      .single();
    busyBarberId = busyBarber!.id;
    await admin.from('barber_skills').insert({ barber_id: busyBarberId, service_id: service!.id });
    await admin.from('barber_schedule').insert({
      barber_id: busyBarberId,
      work_date: today,
      branch_id: branchId,
      shift_start: '00:00:00',
      shift_end: '23:59:59',
    });

    // Fallback barber: eligible and available -- the only eligible barber for this branch_service,
    // so find_eligible_barber's ranked-by-active-count tie-break always picks it.
    fallbackBarberEmail = `baj-fallback-${suffix}@test.pixelbarber.local`;
    const { data: fallbackAuth } = await admin.auth.admin.createUser({
      email: fallbackBarberEmail,
      password: PASSWORD,
      email_confirm: true,
    });
    fallbackBarberAuthUserId = fallbackAuth!.user.id;
    const { data: fallbackStaff } = await admin
      .from('staff_users')
      .insert({
        auth_user_id: fallbackBarberAuthUserId,
        name: 'Baj Fallback Barber',
        email: fallbackBarberEmail,
        role: 'barber',
        invite_status: 'accepted',
      })
      .select()
      .single();
    fallbackBarberStaffUserId = fallbackStaff!.id;
    const { data: fallbackBarber } = await admin
      .from('barbers')
      .insert({
        staff_user_id: fallbackBarberStaffUserId,
        home_branch_id: branchId,
        status: 'available',
      })
      .select()
      .single();
    fallbackBarberId = fallbackBarber!.id;
    await admin
      .from('barber_skills')
      .insert({ barber_id: fallbackBarberId, service_id: service!.id });
    await admin.from('barber_schedule').insert({
      barber_id: fallbackBarberId,
      work_date: today,
      branch_id: branchId,
      shift_start: '00:00:00',
      shift_end: '23:59:59',
    });

    customerPhone = `+233${String(suffix).slice(-9)}`;
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
        name: 'Baj Test Customer',
        phone_e164: customerPhone,
      })
      .select()
      .single();
    customerId = customer!.id;
  }, 30000);

  test.afterAll(async () => {
    if (ticketId) {
      await admin.from('queue_events').delete().eq('ticket_id', ticketId);
      await admin.from('notifications').delete().eq('related_ticket_id', ticketId);
      await admin.from('queue_tickets').delete().eq('id', ticketId);
    }
    await admin.from('customers').delete().eq('id', customerId);
    await admin.from('barber_schedule').delete().in('barber_id', [busyBarberId, fallbackBarberId]);
    await admin.from('barber_skills').delete().in('barber_id', [busyBarberId, fallbackBarberId]);
    await admin
      .from('staff_users')
      .delete()
      .in('id', [busyBarberStaffUserId, fallbackBarberStaffUserId]);
    for (const authId of [busyBarberAuthUserId, fallbackBarberAuthUserId, customerAuthUserId]) {
      await admin.auth.admin.deleteUser(authId);
    }
    // The real join flow calls next_ticket_number, which upserts branch_ticket_counters -- that
    // table has no cascade back to branches, so it must be cleared before the branch itself is
    // deleted (same fix as e2e/no-show-cross-surface-journey.spec.ts and Task 2's own test).
    await admin.from('branch_ticket_counters').delete().eq('branch_id', branchId);
    await admin.from('branch_services').delete().eq('id', branchServiceId);
    await admin.from('branches').delete().eq('id', branchId);
  }, 30000);

  test('customer takes the next available barber when their preferred one is busy', async ({
    browser,
  }) => {
    test.setTimeout(120_000);

    const customerContext = await browser.newContext();
    const { data: customerSession } = await createClient<Database>(
      url,
      anonKey,
    ).auth.signInWithPassword({
      phone: customerPhone,
      password: PASSWORD,
    });
    await seedCookie(customerContext, 'http://localhost:3000', customerSession.session);
    const customerPage = await customerContext.newPage();

    try {
      await customerPage.goto(`/book?branch=${branchId}`);
      // .press('Enter') throughout this flow, not .click() -- Next.js dev mode's own floating "Dev
      // Tools" badge (unrelated to the app, only present under `next dev`) physically sits over
      // part of the page and steals real mouse-click hit-testing there (even with { force: true },
      // which skips Playwright's actionability pre-check but still dispatches a real pointer event
      // at the button's coordinates, so the overlay still receives it) -- exactly the pre-existing,
      // unrelated issue already flagged against e2e/queue-join-now.spec.ts's identical first-button
      // click in this same Book flow. Focusing the target button and pressing Enter uses the
      // browser's native "Enter activates the focused button" behavior instead of a pointer event,
      // which never hit-tests against whatever else is rendered on top -- a real interaction, not a
      // workaround that touches app code.
      //
      // First (only, for this fixture's one branch_service) service button -- its label is real
      // fixture data this test doesn't control, matching e2e/queue-join-now.spec.ts's own technique
      // for this step. Scoped to <main> (BookFlow's own root element) rather than the whole page --
      // Next.js dev mode's floating Dev Tools badge renders its own button(s) outside <main>, and an
      // unscoped getByRole('button').first() was resolving to THAT button instead of the real
      // service button, silently stranding the flow on the service step for the rest of the test
      // (found by comparing the failure's page snapshot against BookFlow.tsx's real DOM structure).
      await customerPage.locator('main').getByRole('button').first().press('Enter');
      await customerPage.getByRole('button', { name: busyBarberId }).press('Enter');

      // Ineligible-but-scheduled-today -> the availability prompt should appear.
      await expect(customerPage.getByText('Barber Availability')).toBeVisible({ timeout: 15000 });
      await customerPage.getByRole('button', { name: 'Take next available' }).press('Enter');

      await customerPage.getByRole('button', { name: 'Join Now' }).press('Enter');
      await customerPage.waitForURL(/\/tickets\//, { timeout: 15000 });

      const { data: ticket } = await admin
        .from('queue_tickets')
        .select('id, assigned_barber_id')
        .eq('customer_id', customerId)
        .not('state', 'in', '(completed,cancelled,no_show)')
        .single();
      ticketId = ticket!.id;
      expect(ticket!.assigned_barber_id).toBe(fallbackBarberId);

      // Confirm it's visible on the FALLBACK barber's own Today's Queue, not the busy one's.
      const staffContext = await browser.newContext();
      try {
        const staffPage = await staffContext.newPage();
        await staffPage.goto(`${STAFF_BASE_URL}/login`);
        await staffPage.getByPlaceholder('Email').fill(fallbackBarberEmail);
        await staffPage.getByPlaceholder('Password').fill(PASSWORD);
        await staffPage.getByRole('button', { name: 'Log In' }).press('Enter');
        await staffPage.waitForURL(/\/queue\/today/, { timeout: 15000 });

        const { data: ticketNumberRow } = await admin
          .from('queue_tickets')
          .select('ticket_number')
          .eq('id', ticket!.id)
          .single();
        await expect(staffPage.getByText(`Ticket ${ticketNumberRow!.ticket_number}`)).toBeVisible({
          timeout: 15000,
        });
      } finally {
        await staffContext.close();
      }
    } finally {
      await customerContext.close();
    }
  });
});
