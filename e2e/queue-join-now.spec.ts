// e2e/queue-join-now.spec.ts
// Exercises the actual browser -> Edge Function path for /tickets/join (the reason the CORS fix
// in commit dfaeb7b exists) end to end: a real customer session, in a real browser, clicking
// through the Book flow's service/barber/review steps and hitting Join Now for real.
//
// The test brings its own branch (open all day), one service, and one available, skilled barber
// scheduled today -- relying on whatever branch already exists made it fail with "No barbers
// available" whenever no real barber happened to be on duty.
import { test, expect } from '@playwright/test';
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PASSWORD = 'Test-Password-123!';

test('customer can join the queue end to end through the Book flow UI', async ({
  page,
  context,
  baseURL,
}) => {
  test.skip(!url || !serviceRoleKey, 'Supabase env vars not set');
  test.setTimeout(90_000);
  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const suffix = String(Date.now());
  // 059…: distinct from the phone ranges other e2e files derive from the same clock.
  const phone = `+23359${suffix.slice(-7)}`;
  const barberEmail = `qjn-barber-${suffix}@test.pixelbarber.local`;
  const today = new Date().toISOString().slice(0, 10);

  const { data: business } = await admin.from('businesses').select('id').limit(1).single();
  const { data: service } = await admin.from('services').select('id').limit(1).single();
  const { data: branch, error: branchError } = await admin
    .from('branches')
    .insert({
      business_id: business!.id,
      name: `Join Now Branch ${suffix}`,
      branch_code: `QJN${suffix.slice(-5)}`,
      address: 'Test',
      latitude: 5.6,
      longitude: -0.18,
    })
    .select('id')
    .single();
  if (branchError) throw branchError;
  // tickets-join refuses a closed branch; open this one all day, every day.
  await admin.from('branch_hours').insert(
    [0, 1, 2, 3, 4, 5, 6].map((day_of_week) => ({
      branch_id: branch!.id,
      day_of_week,
      opens_at: '00:00:00',
      closes_at: '23:59:59',
      is_closed: false,
    })),
  );
  const { data: branchService } = await admin
    .from('branch_services')
    .insert({ branch_id: branch!.id, service_id: service!.id })
    .select('id')
    .single();

  const { data: barberAuth, error: barberAuthError } = await admin.auth.admin.createUser({
    email: barberEmail,
    password: PASSWORD,
    email_confirm: true,
  });
  if (barberAuthError) throw barberAuthError;
  const { data: barberStaff } = await admin
    .from('staff_users')
    .insert({
      auth_user_id: barberAuth!.user.id,
      name: 'Join Now Barber',
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
  await admin.from('barber_schedule').insert({
    barber_id: barber!.id,
    work_date: today,
    branch_id: branch!.id,
    shift_start: '00:00:00',
    shift_end: '23:59:59',
  });

  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    phone,
    password: PASSWORD,
    phone_confirm: true,
  });
  if (userError) throw userError;
  const authUserId = userData!.user.id;
  const { data: customer } = await admin
    .from('customers')
    .insert({ auth_user_id: authUserId, name: 'Join Now E2E Customer', phone_e164: phone })
    .select()
    .single();

  let createdTicketId: string | null = null;

  try {
    const { data: sessionData } = await createClient<Database>(
      url,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    ).auth.signInWithPassword({ phone, password: PASSWORD });
    const projectRef = new URL(url).hostname.split('.')[0];
    const cookieName = `sb-${projectRef}-auth-token`;
    const cookieValue =
      'base64-' +
      Buffer.from(JSON.stringify(sessionData.session), 'utf-8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    await context.addCookies([
      { name: cookieName, value: cookieValue, url: baseURL ?? 'http://localhost:3000' },
    ]);

    await page.goto(`/book?branch=${branch!.id}`);
    // Scoped to <main> and pressed with Enter: Next.js dev mode's Dev Tools badge is itself a
    // button (so getByRole('button').first() could pick it) and intercepts pointer clicks.
    const main = page.locator('main');
    await main.getByRole('listitem').getByRole('button').first().press('Enter'); // the branch's only service (the Join Now/Schedule toggle buttons are not list items)
    await main.getByRole('button', { name: /any available/i }).press('Enter');
    await main.getByRole('button', { name: /join now/i }).press('Enter');

    await expect(page).toHaveURL(/\/tickets\/[0-9a-f-]+/, { timeout: 15000 });
    const match = page.url().match(/\/tickets\/([0-9a-f-]+)/);
    createdTicketId = match ? match[1] : null;
    expect(createdTicketId).not.toBeNull();

    const { data: ticket } = await admin
      .from('queue_tickets')
      .select('*')
      .eq('id', createdTicketId!)
      .single();
    expect(ticket!.customer_id).toBe(customer!.id);
    expect(ticket!.branch_id).toBe(branch!.id);
  } finally {
    if (createdTicketId) {
      await admin.from('queue_events').delete().eq('ticket_id', createdTicketId);
      await admin.from('notifications').delete().eq('related_ticket_id', createdTicketId);
      await admin.from('queue_tickets').delete().eq('id', createdTicketId);
    }
    await admin.from('customers').delete().eq('id', customer!.id);
    await admin.auth.admin.deleteUser(authUserId);
    await admin.from('barber_schedule').delete().eq('barber_id', barber!.id);
    await admin.from('barber_skills').delete().eq('barber_id', barber!.id);
    // Deleting the staff row cascades to its barbers row; the auth user goes after it.
    await admin.from('staff_users').delete().eq('id', barberStaff!.id);
    await admin.auth.admin.deleteUser(barberAuth!.user.id);
    // next_ticket_number upserts branch_ticket_counters, which has no cascade back to branches.
    await admin.from('branch_ticket_counters').delete().eq('branch_id', branch!.id);
    await admin.from('branch_services').delete().eq('id', branchService!.id);
    await admin.from('branch_hours').delete().eq('branch_id', branch!.id);
    await admin.from('branches').delete().eq('id', branch!.id);
  }
});
