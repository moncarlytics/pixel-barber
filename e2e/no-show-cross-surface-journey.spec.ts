// e2e/no-show-cross-surface-journey.spec.ts
// Phase 5 Task 9 (Step 4): the one test in this phase meant to catch a UI-level regression the
// DB-level tests (grace-period-expiry-cron, skip-to-waiting, barber-stats-rollup) cannot -- a real
// barber, in a real browser, driving Today's Queue's Acknowledge and Not Present actions (Task 5,
// Task 6's real NotPresentModal) through the actual UI, observed cross-surface on both the staff
// Live Queue (Phase 4, Task 1's grace-period alert styling) and the customer's own Ticket Tracking
// Screen (Phase 4).
//
// Cookie-seeding mechanism copied verbatim from e2e/queue-live-update.spec.ts /
// e2e/queue-join-now.spec.ts: sign in with a real Supabase session, base64url-encode it into the
// `sb-<project-ref>-auth-token` cookie @supabase/ssr's createBrowserClient reads. Both apps share
// the same Supabase project, so the cookie NAME is identical for the barber's staff-app session and
// the customer's customer-app session -- since cookies aren't port-scoped, seeding both in the SAME
// browser context would silently overwrite one with the other. Each role therefore gets its own,
// fully separate browser context (never sharing a context across apps), exactly as the brief calls
// for with the customer's "second browser context".
//
// Two branches of Task 8's grace-period escalation are covered, each its own test (sharing only the
// one-time branch/barber setup below via beforeAll/afterAll):
//   1. "lapses": Not Present -> grace_period -> Live Queue shows the alert -> the grace period is
//      made to have already elapsed and expire_no_show_grace_periods() is invoked directly (the same
//      RPC call tests/db/grace-period-expiry-cron.test.ts exercises at the DB level) -> the
//      customer's own Ticket Tracking Screen shows the released state with a working Rejoin button.
//      Waiting out a REAL 2-minute (or longer) grace period in a browser test would make this test
//      slow and flaky for no real gain: the cron's own correctness is already fully proven at the DB
//      level by Step 1's test, so this journey only needs a grace_period ticket whose
//      grace_period_expires_at is in the past for the RPC to act on -- directly setting that column
//      via the admin client (never touched through the UI) is a targeted, honest substitute for
//      "time has passed" that still drives every UI-observable step (Not Present, the alert, the
//      released screen) for real.
//   2. "responds in time": Not Present -> grace_period -> a real front-of-house action (Live Queue's
//      Mark Arrived, which a barber's own tickets_barber_own_queue RLS policy permits on their own
//      assigned ticket exactly as it permits every other state write Today's Queue itself makes) --
//      moves the ticket to 'confirmed', a state Ticket Tracking Screen's own isReleased/isActive
//      logic treats as active, not lapsed -- observed on the customer's own screen too. No real-time
//      wait needed here at all: responding in time only requires the action to happen before the
//      (unmodified, still 2-minute-default) grace period would have elapsed, which a same-second
//      Playwright interaction always satisfies.
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

test.describe.configure({ mode: 'serial' });

test.describe('no-show cross-surface escalation journey', () => {
  test.skip(!url || !serviceRoleKey, 'Supabase env vars not set');

  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const suffix = Date.now();

  let branchId: string;
  let branchServiceId: string;
  let barberStaffUserId: string;
  let barberAuthUserId: string;
  let barberId: string;
  let barberEmail: string;

  test.beforeAll(async () => {
    const { data: business } = await admin.from('businesses').select('id').limit(1).single();
    const { data: service } = await admin.from('services').select('id').limit(1).single();

    const { data: branch } = await admin
      .from('branches')
      .insert({
        business_id: business!.id,
        name: 'No-Show Cross-Surface E2E Branch',
        branch_code: `NSXS${suffix % 100000}`,
        address: 'Test',
        latitude: 5.6,
        longitude: -0.18,
      })
      .select()
      .single();
    branchId = branch!.id;

    const { data: branchService } = await admin
      .from('branch_services')
      .insert({ branch_id: branchId, service_id: service!.id })
      .select()
      .single();
    branchServiceId = branchService!.id;

    barberEmail = `noshow-e2e-barber-${suffix}@test.pixelbarber.local`;
    const { data: barberAuthUser } = await admin.auth.admin.createUser({
      email: barberEmail,
      password: PASSWORD,
      email_confirm: true,
    });
    barberAuthUserId = barberAuthUser!.user.id;
    const { data: barberStaffRow } = await admin
      .from('staff_users')
      .insert({
        auth_user_id: barberAuthUserId,
        name: 'No-Show E2E Barber',
        email: barberEmail,
        role: 'barber',
        invite_status: 'accepted',
      })
      .select()
      .single();
    barberStaffUserId = barberStaffRow!.id;
    const { data: barberRow } = await admin
      .from('barbers')
      .insert({ staff_user_id: barberStaffUserId, home_branch_id: branchId })
      .select()
      .single();
    barberId = barberRow!.id;
  }, 30000);

  test.afterAll(async () => {
    await admin.from('staff_users').delete().eq('id', barberStaffUserId);
    await admin.auth.admin.deleteUser(barberAuthUserId);
    // next_ticket_number() (used by both tests below, matching e2e/queue-live-update.spec.ts's own
    // convention) inserts/updates a branch_ticket_counters row for this branch; that table has no
    // `on delete cascade` back to branches, so it must be cleared before the branch itself can be
    // deleted (found via a real FK violation during this task's own verification run).
    await admin.from('branch_ticket_counters').delete().eq('branch_id', branchId);
    await admin.from('branches').delete().eq('id', branchId);
  }, 30000);

  test('barber Acknowledges one ticket, marks a second Not Present, Live Queue shows the grace-period alert, and a lapsed grace period releases the ticket on the customer screen', async ({
    browser,
    baseURL,
  }) => {
    // This journey drives two full pages across two apps, two Supabase sign-ins, and a poll for a
    // trigger-driven state change -- comfortably past the framework's 30s default on a cold
    // Next.js dev server compiling each route (/queue/today, /tickets, /tickets/[id]) on first
    // visit. Matches this phase's own established practice (task-9-brief.md's own reminder,
    // already applied to tests/db's beforeAll/afterAll hooks) of giving any multi-step hook or test
    // an explicit, generous timeout rather than relying on a tight default.
    test.setTimeout(120_000);
    const customerBaseUrl = baseURL ?? 'http://localhost:3000';

    // Ticket A: no browser session of its own -- only used to exercise Acknowledge and occupy the
    // "Current Customer" slot so ticket B becomes "Next Customer".
    const { data: customerA } = await admin
      .from('customers')
      .insert({ name: 'No-Show E2E Customer A', phone_e164: `+233${String(suffix).slice(-8)}1` })
      .select()
      .single();

    const phoneB = `+233${String(suffix).slice(-8)}2`;
    const { data: customerBAuthUser } = await admin.auth.admin.createUser({
      phone: phoneB,
      password: PASSWORD,
      phone_confirm: true,
    });
    const { data: customerB } = await admin
      .from('customers')
      .insert({
        auth_user_id: customerBAuthUser!.user.id,
        name: 'No-Show E2E Customer B',
        phone_e164: phoneB,
      })
      .select()
      .single();

    const { data: ticketNumberA } = await admin.rpc('next_ticket_number', {
      p_branch_id: branchId,
    });
    const { data: ticketA } = await admin
      .from('queue_tickets')
      .insert({
        ticket_number: ticketNumberA,
        branch_id: branchId,
        customer_id: customerA!.id,
        branch_service_id: branchServiceId,
        assigned_barber_id: barberId,
        state: 'waiting',
        position: 1,
        created_by: 'staff',
      })
      .select()
      .single();

    const { data: ticketNumberB } = await admin.rpc('next_ticket_number', {
      p_branch_id: branchId,
    });
    const { data: ticketB } = await admin
      .from('queue_tickets')
      .insert({
        ticket_number: ticketNumberB,
        branch_id: branchId,
        customer_id: customerB!.id,
        branch_service_id: branchServiceId,
        assigned_barber_id: barberId,
        state: 'waiting',
        position: 2,
        created_by: 'staff',
      })
      .select()
      .single();

    const barberContext = await browser.newContext();
    let customerContext: import('@playwright/test').BrowserContext | null = null;

    try {
      const { data: barberSession } = await createClient<Database>(
        url,
        anonKey,
      ).auth.signInWithPassword({ email: barberEmail, password: PASSWORD });
      await seedCookie(barberContext, STAFF_BASE_URL, barberSession.session);
      const barberPage = await barberContext.newPage();

      await barberPage.goto(`${STAFF_BASE_URL}/queue/today`);
      await expect(barberPage.getByText(`Ticket ${ticketA!.ticket_number}`)).toBeVisible({
        timeout: 15000,
      });
      await barberPage.getByRole('button', { name: 'Acknowledge' }).click();

      // Ticket A leaves the "next" states, so ticket B becomes Next Customer.
      await expect(barberPage.getByText(`Ticket ${ticketB!.ticket_number}`)).toBeVisible({
        timeout: 15000,
      });
      await barberPage.getByRole('button', { name: 'Not Present' }).click();
      await expect(barberPage.getByRole('dialog', { name: 'Confirm Not Present' })).toBeVisible({
        timeout: 10000,
      });
      await barberPage.getByRole('button', { name: 'Confirm' }).click();

      await expect
        .poll(
          async () => {
            const { data } = await admin
              .from('queue_tickets')
              .select('state')
              .eq('id', ticketB!.id)
              .single();
            return data?.state;
          },
          { timeout: 15000 },
        )
        .toBe('grace_period');

      // Live Queue (Phase 4): the grace-period alert styling/text for ticket B.
      await barberPage.goto(`${STAFF_BASE_URL}/tickets`);
      await barberPage.locator('select').selectOption(branchId);
      const ticketBRow = barberPage.locator('tr', { has: barberPage.getByText(customerB!.id) });
      await expect(ticketBRow).toContainText('Grace period — needs attention', { timeout: 15000 });
      await expect(ticketBRow).toHaveCSS('background-color', 'rgb(255, 238, 238)');

      // Drive the "lapses" branch: make the grace period already-expired and invoke the real cron
      // function directly (matching tests/db/grace-period-expiry-cron.test.ts's own RPC call),
      // rather than waiting out a real 2-minute grace period in this browser test.
      await admin
        .from('queue_tickets')
        .update({ grace_period_expires_at: new Date(Date.now() - 60_000).toISOString() })
        .eq('id', ticketB!.id);
      const { error: rpcError } = await admin.rpc('expire_no_show_grace_periods');
      expect(rpcError).toBeNull();

      customerContext = await browser.newContext();
      const { data: customerBSession } = await createClient<Database>(
        url,
        anonKey,
      ).auth.signInWithPassword({ phone: phoneB, password: PASSWORD });
      await seedCookie(customerContext, customerBaseUrl, customerBSession.session);
      const customerPage = await customerContext.newPage();

      await customerPage.goto(`${customerBaseUrl}/tickets/${ticketB!.id}`);
      await expect(customerPage.getByText('Your ticket was released')).toBeVisible({
        timeout: 15000,
      });
      await expect(customerPage.getByText("because you weren't available in time")).toBeVisible();
      await expect(customerPage.getByRole('button', { name: 'Rejoin Queue' })).toBeVisible();
    } finally {
      await barberContext.close();
      if (customerContext) await customerContext.close();

      // Ticket A is deliberately left in 'in_service' by this test (Acknowledge is never followed
      // by Mark Complete here) -- trg_barber_current_ticket (barbers.current_ticket_id) only clears
      // that column when a ticket LEAVES in_service, so it still points at ticket A here and would
      // otherwise block deleting it (barbers_current_ticket_id_fkey). Clear it explicitly first.
      await admin.from('barbers').update({ current_ticket_id: null }).eq('id', barberId);
      await admin.from('queue_events').delete().in('ticket_id', [ticketA!.id, ticketB!.id]);
      await admin.from('notifications').delete().eq('related_ticket_id', ticketB!.id);
      await admin.from('service_sessions').delete().eq('ticket_id', ticketA!.id);
      await admin.from('queue_tickets').delete().in('id', [ticketA!.id, ticketB!.id]);
      await admin.from('customers').delete().in('id', [customerA!.id, customerB!.id]);
      await admin.auth.admin.deleteUser(customerBAuthUser!.user.id);
    }
  });

  test('a grace-period ticket Marked Arrived in time returns to an active state on the customer screen', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const customerBaseUrl = baseURL ?? 'http://localhost:3000';

    const phoneC = `+233${String(suffix).slice(-8)}3`;
    const { data: customerCAuthUser } = await admin.auth.admin.createUser({
      phone: phoneC,
      password: PASSWORD,
      phone_confirm: true,
    });
    const { data: customerC } = await admin
      .from('customers')
      .insert({
        auth_user_id: customerCAuthUser!.user.id,
        name: 'No-Show E2E Customer C',
        phone_e164: phoneC,
      })
      .select()
      .single();

    const { data: ticketNumberC } = await admin.rpc('next_ticket_number', {
      p_branch_id: branchId,
    });
    const { data: ticketC } = await admin
      .from('queue_tickets')
      .insert({
        ticket_number: ticketNumberC,
        branch_id: branchId,
        customer_id: customerC!.id,
        branch_service_id: branchServiceId,
        assigned_barber_id: barberId,
        state: 'waiting',
        position: 1,
        created_by: 'staff',
      })
      .select()
      .single();

    const barberContext = await browser.newContext();
    let customerContext: import('@playwright/test').BrowserContext | null = null;

    try {
      const { data: barberSession } = await createClient<Database>(
        url,
        anonKey,
      ).auth.signInWithPassword({ email: barberEmail, password: PASSWORD });
      await seedCookie(barberContext, STAFF_BASE_URL, barberSession.session);
      const barberPage = await barberContext.newPage();

      await barberPage.goto(`${STAFF_BASE_URL}/queue/today`);
      await expect(barberPage.getByText(`Ticket ${ticketC!.ticket_number}`)).toBeVisible({
        timeout: 15000,
      });
      await barberPage.getByRole('button', { name: 'Not Present' }).click();
      await expect(barberPage.getByRole('dialog', { name: 'Confirm Not Present' })).toBeVisible({
        timeout: 10000,
      });
      await barberPage.getByRole('button', { name: 'Confirm' }).click();

      await expect
        .poll(
          async () => {
            const { data } = await admin
              .from('queue_tickets')
              .select('state')
              .eq('id', ticketC!.id)
              .single();
            return data?.state;
          },
          { timeout: 15000 },
        )
        .toBe('grace_period');

      // Responds in time: front-of-house Mark Arrived on Live Queue, before any expiry ever runs.
      await barberPage.goto(`${STAFF_BASE_URL}/tickets`);
      await barberPage.locator('select').selectOption(branchId);
      const ticketCRow = barberPage.locator('tr', { has: barberPage.getByText(customerC!.id) });
      await expect(ticketCRow).toContainText('Grace period — needs attention', { timeout: 15000 });
      await ticketCRow.getByRole('button', { name: 'Mark Arrived' }).click();

      await expect
        .poll(
          async () => {
            const { data } = await admin
              .from('queue_tickets')
              .select('state')
              .eq('id', ticketC!.id)
              .single();
            return data?.state;
          },
          { timeout: 15000 },
        )
        .toBe('confirmed');

      customerContext = await browser.newContext();
      const { data: customerCSession } = await createClient<Database>(
        url,
        anonKey,
      ).auth.signInWithPassword({ phone: phoneC, password: PASSWORD });
      await seedCookie(customerContext, customerBaseUrl, customerCSession.session);
      const customerPage = await customerContext.newPage();

      await customerPage.goto(`${customerBaseUrl}/tickets/${ticketC!.id}`);
      await expect(customerPage.getByText("You're being served")).toBeVisible({ timeout: 15000 });
      await expect(customerPage.getByText('Your ticket was released')).toHaveCount(0);
    } finally {
      await barberContext.close();
      if (customerContext) await customerContext.close();

      await admin.from('queue_events').delete().eq('ticket_id', ticketC!.id);
      await admin.from('notifications').delete().eq('related_ticket_id', ticketC!.id);
      await admin.from('queue_tickets').delete().eq('id', ticketC!.id);
      await admin.from('customers').delete().eq('id', customerC!.id);
      await admin.auth.admin.deleteUser(customerCAuthUser!.user.id);
    }
  });
});
