// e2e/appointment-early-check-in.spec.ts
// Part 3 customer journey: a walk-in sees a real wait estimate before and after joining a busy
// barber's line; an appointment customer taps "I've arrived" with a free barber and lands on their
// ticket, called. Brings its own branch (open all day), a 30-minute service and two barbers.
// Clicks use Enter and are scoped to <main> (Next.js dev mode's Dev Tools badge).
import { test, expect, type BrowserContext } from '@playwright/test';
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PASSWORD = 'Test-Password-123!';
const DAY = 24 * 60 * 60 * 1000;

async function signInAs(context: BrowserContext, baseURL: string | undefined, phone: string) {
  const { data } = await createClient<Database>(url, anonKey).auth.signInWithPassword({
    phone,
    password: PASSWORD,
  });
  const projectRef = new URL(url).hostname.split('.')[0];
  const cookieValue =
    'base64-' +
    Buffer.from(JSON.stringify(data.session), 'utf-8')
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
}

test('wait estimates for a walk-in; "I\'ve arrived" starts an appointment early', async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  test.skip(!url || !serviceRoleKey, 'Supabase env vars not set');
  test.setTimeout(150_000);
  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const suffix = String(Date.now());
  // 0554… : distinct from the phone ranges other test files use.
  const walkerPhone = `+233554${suffix.slice(-5)}1`;
  const arriverPhone = `+233554${suffix.slice(-5)}2`;
  const sitterPhone = `+233554${suffix.slice(-5)}3`;
  const serviceName = `Early E2E Cut ${suffix}`;

  let service: { id: string } | null = null;
  let branch: { id: string } | null = null;
  let bs: { id: string } | null = null;
  const barbers: { authId: string; staffId: string; barberId: string }[] = [];
  const authIds: string[] = [];
  const customerIds: string[] = [];
  let arriverContext: BrowserContext | null = null;

  async function makeBarber(name: string) {
    const email = `early-e2e-${barbers.length}-${suffix}@test.pixelbarber.local`;
    const { data: auth } = await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    const { data: staff } = await admin
      .from('staff_users')
      .insert({
        auth_user_id: auth.user!.id,
        name,
        email,
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
    barbers.push({ authId: auth.user!.id, staffId: staff!.id, barberId: barber!.id });
    await admin.from('barber_skills').insert({ barber_id: barber!.id, service_id: service!.id });
    await admin.from('barber_schedule').delete().eq('barber_id', barber!.id);
    await admin.from('barber_schedule').insert(
      [0, 1].map((i) => ({
        barber_id: barber!.id,
        work_date: new Date(Date.now() + i * DAY).toISOString().slice(0, 10),
        branch_id: branch!.id,
        shift_start: '00:00:00',
        shift_end: '23:59:59',
      })),
    );
    return barber!.id as string;
  }

  async function makeCustomer(name: string, phone: string, withLogin: boolean) {
    let authUserId: string | null = null;
    if (withLogin) {
      const { data: auth } = await admin.auth.admin.createUser({
        phone,
        password: PASSWORD,
        phone_confirm: true,
      });
      authUserId = auth.user!.id;
      authIds.push(authUserId);
    }
    const { data: customer } = await admin
      .from('customers')
      .insert({ auth_user_id: authUserId, name, phone_e164: phone, avatar_key: 'avatar-1' })
      .select('id')
      .single();
    customerIds.push(customer!.id);
    return customer!.id as string;
  }

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
          name: `Early E2E Branch ${suffix}`,
          branch_code: `EE${suffix.slice(-6)}`,
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
    const busyBarber = await makeBarber('Early E2E Busy');
    const freeBarber = await makeBarber('Early E2E Free');
    await makeCustomer('Early E2E Walker', walkerPhone, true);
    const arriver = await makeCustomer('Early E2E Arriver', arriverPhone, true);
    const sitter = await makeCustomer('Early E2E Sitter', sitterPhone, false);

    // Someone is already called to the busy barber's chair.
    await admin.from('queue_tickets').insert({
      ticket_number: `PB-EE-${suffix}`,
      branch_id: branch!.id,
      customer_id: sitter,
      branch_service_id: bs!.id,
      assigned_barber_id: busyBarber,
      state: 'called',
      position: 1,
      created_by: 'staff',
    });

    // --- 1. Walk-in: estimate before joining, then on the ticket ---
    const main = page.locator('main');
    await signInAs(context, baseURL, walkerPhone);
    await page.goto(`/book?branch=${branch!.id}`);
    await main.getByRole('button', { name: new RegExp(serviceName) }).press('Enter');
    await main.getByRole('button', { name: 'Early E2E Busy' }).press('Enter');
    await expect(main.getByText('Estimated wait: 24–36 min')).toBeVisible({ timeout: 15000 });
    await main.getByRole('button', { name: 'Join Now' }).press('Enter');
    await expect(page).toHaveURL(/\/tickets\/[0-9a-f-]{36}$/, { timeout: 15000 });
    await expect(main.getByText('Estimated wait: 24–36 min')).toBeVisible({ timeout: 70000 });

    // --- 2. Appointment customer arrives 20 minutes early; their barber is free ---
    const start = new Date(Date.now() + 20 * 60_000);
    const { data: appointment } = await admin
      .from('appointments')
      .insert({
        customer_id: arriver,
        branch_id: branch!.id,
        branch_service_id: bs!.id,
        preferred_barber_id: freeBarber,
        scheduled_start: start.toISOString(),
        scheduled_end: new Date(start.getTime() + 30 * 60_000).toISOString(),
        status: 'scheduled',
        created_by: 'customer',
      })
      .select('id')
      .single();
    arriverContext = await browser.newContext();
    await signInAs(arriverContext, baseURL, arriverPhone);
    const arriverPage = await arriverContext.newPage();
    await arriverPage.goto(`${baseURL ?? 'http://localhost:3000'}/appointments/${appointment!.id}`);
    const arriverMain = arriverPage.locator('main');
    await arriverMain.getByRole('button', { name: "I've arrived" }).press('Enter');
    await expect(arriverPage).toHaveURL(/\/tickets\/[0-9a-f-]{36}$/, { timeout: 15000 });
    await expect(arriverMain.getByText('Your turn — head to the barber now!')).toBeVisible({
      timeout: 15000,
    });
    const { data: converted } = await admin
      .from('appointments')
      .select('status')
      .eq('id', appointment!.id)
      .single();
    expect(converted!.status).toBe('converted');
  } finally {
    await arriverContext?.close();
    // FK-safe cleanup scoped to this test's rows; every failure is collected and thrown at the end.
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
      const { data: appts } = await admin
        .from('appointments')
        .select('id')
        .eq('branch_id', branch.id);
      const apptIds = (appts ?? []).map((a) => a.id);
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
      check('queue_tickets', await admin.from('queue_tickets').delete().eq('branch_id', branch.id));
      check('appointments', await admin.from('appointments').delete().eq('branch_id', branch.id));
      check(
        'branch_ticket_counters',
        await admin.from('branch_ticket_counters').delete().eq('branch_id', branch.id),
      );
    }
    for (const b of barbers) {
      check(
        'barber_schedule',
        await admin.from('barber_schedule').delete().eq('barber_id', b.barberId),
      );
      check(
        'barber_skills',
        await admin.from('barber_skills').delete().eq('barber_id', b.barberId),
      );
      check('staff_users', await admin.from('staff_users').delete().eq('id', b.staffId));
      await admin.auth.admin.deleteUser(b.authId);
    }
    if (customerIds.length) {
      check('customers', await admin.from('customers').delete().in('id', customerIds));
    }
    for (const id of authIds) await admin.auth.admin.deleteUser(id);
    if (bs) check('branch_services', await admin.from('branch_services').delete().eq('id', bs.id));
    if (branch) {
      check('branch_hours', await admin.from('branch_hours').delete().eq('branch_id', branch.id));
      check('branches', await admin.from('branches').delete().eq('id', branch.id));
    }
    if (service) check('services', await admin.from('services').delete().eq('id', service.id));
    if (failures.length) throw new Error(`Cleanup failed:\n${failures.join('\n')}`);
  }
});
