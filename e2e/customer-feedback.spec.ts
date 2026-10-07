// e2e/customer-feedback.spec.ts
// After-visit feedback, customer side: a completed visit shows "How was your visit?"; the customer
// rates it (overall + one detail + comment), sees the thank-you state, and finds it in Profile.
// Clicks use Enter and are scoped to <main>.
import { test, expect } from '@playwright/test';
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PASSWORD = 'Test-Password-123!';

test('customer rates a completed visit and sees it in Profile', async ({
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
  // 0552… : distinct from the phone ranges other test files use.
  const phone = `+233552${suffix.slice(-6)}`;
  const barberEmail = `fb-e2e-${suffix}@test.pixelbarber.local`;

  let service: { id: string } | null = null;
  let branch: { id: string } | null = null;
  let bs: { id: string } | null = null;
  let barberAuthId: string | null = null;
  let barberStaffId: string | null = null;
  let barberId: string | null = null;
  let customerAuthId: string | null = null;
  let customerId: string | null = null;

  try {
    const { data: business } = await admin.from('businesses').select('id').limit(1).single();
    service = (
      await admin
        .from('services')
        .insert({
          business_id: business!.id,
          name: `FB E2E Cut ${suffix}`,
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
          name: `FB E2E Branch ${suffix}`,
          branch_code: `FB${suffix.slice(-6)}`,
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
    const { data: barberAuth } = await admin.auth.admin.createUser({
      email: barberEmail,
      password: PASSWORD,
      email_confirm: true,
    });
    barberAuthId = barberAuth.user!.id;
    barberStaffId = (
      await admin
        .from('staff_users')
        .insert({
          auth_user_id: barberAuthId,
          name: 'FB E2E Barber',
          email: barberEmail,
          role: 'barber',
          invite_status: 'accepted',
        })
        .select('id')
        .single()
    ).data!.id;
    barberId = (
      await admin
        .from('barbers')
        .insert({ staff_user_id: barberStaffId, home_branch_id: branch!.id, status: 'available' })
        .select('id')
        .single()
    ).data!.id;
    const { data: customerAuth } = await admin.auth.admin.createUser({
      phone,
      password: PASSWORD,
      phone_confirm: true,
    });
    customerAuthId = customerAuth.user!.id;
    customerId = (
      await admin
        .from('customers')
        .insert({
          auth_user_id: customerAuthId,
          name: 'FB E2E Customer',
          phone_e164: phone,
          avatar_key: 'avatar-1',
        })
        .select('id')
        .single()
    ).data!.id;
    const { data: ticket } = await admin
      .from('queue_tickets')
      .insert({
        ticket_number: `PB-FBE-${suffix}`,
        branch_id: branch!.id,
        customer_id: customerId!,
        branch_service_id: bs!.id,
        assigned_barber_id: barberId!,
        state: 'completed',
        completed_at: new Date().toISOString(),
        created_by: 'customer',
      })
      .select('id')
      .single();

    const { data: session } = await createClient<Database>(url, anonKey).auth.signInWithPassword({
      phone,
      password: PASSWORD,
    });
    const projectRef = new URL(url).hostname.split('.')[0];
    const cookieValue =
      'base64-' +
      Buffer.from(JSON.stringify(session.session), 'utf-8')
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
    await page.goto(`/tickets/${ticket!.id}`);
    const overall = main.getByRole('group', { name: 'How was your visit?' });
    await expect(overall).toBeVisible({ timeout: 15000 });
    await overall.getByRole('button', { name: '4 stars' }).press('Enter');
    await main.getByRole('button', { name: 'Tell us more' }).press('Enter');
    await main
      .getByRole('group', { name: 'Cleanliness' })
      .getByRole('button', { name: '5 stars' })
      .press('Enter');
    await main
      .getByLabel("Anything you'd like to add? (optional)")
      .fill('Sharp fade, quick service');
    await main.getByRole('button', { name: 'Send' }).press('Enter');
    await expect(main.getByText('Thanks for your feedback!')).toBeVisible({ timeout: 15000 });

    const { data: saved } = await admin
      .from('feedback')
      .select('overall_rating, cleanliness_rating, comment, barber_id')
      .eq('ticket_id', ticket!.id)
      .single();
    expect(saved).toMatchObject({
      overall_rating: 4,
      cleanliness_rating: 5,
      comment: 'Sharp fade, quick service',
      barber_id: barberId,
    });

    await page.goto('/profile');
    await expect(main.getByText('Sharp fade, quick service')).toBeVisible({ timeout: 15000 });
    await expect(main.getByText(/FB E2E Branch .* · FB E2E Barber · 4 stars/)).toBeVisible();
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
    if (customerId) check('customers', await admin.from('customers').delete().eq('id', customerId));
    if (customerAuthId) await admin.auth.admin.deleteUser(customerAuthId);
    if (barberStaffId)
      check('staff_users', await admin.from('staff_users').delete().eq('id', barberStaffId));
    if (barberAuthId) await admin.auth.admin.deleteUser(barberAuthId);
    if (bs) check('branch_services', await admin.from('branch_services').delete().eq('id', bs.id));
    if (branch) check('branches', await admin.from('branches').delete().eq('id', branch.id));
    if (service) check('services', await admin.from('services').delete().eq('id', service.id));
    if (failures.length) throw new Error(`Cleanup failed:\n${failures.join('\n')}`);
  }
});
