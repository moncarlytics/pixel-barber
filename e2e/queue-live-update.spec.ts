// e2e/queue-live-update.spec.ts
// A customer joins, a staff user marks them arrived (simulating "completed ahead of them" for a
// queue of one -- the simplest deterministic version of "someone ahead of them is served" that
// doesn't require seeding a second, unrelated ticket just to advance position by one), and the
// customer's own Ticket Tracking Screen updates without a page refresh, per Realtime already
// wired in Task 6.
import { test, expect } from '@playwright/test';
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

test('customer Ticket Tracking Screen updates live when staff changes ticket state', async ({
  page,
  context,
  baseURL,
}) => {
  test.skip(!url || !serviceRoleKey, 'Supabase env vars not set');
  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const suffix = Date.now();
  const phone = `+233${String(suffix).slice(-9)}`;
  const password = 'Test-Password-123!';
  const { data: userData } = await admin.auth.admin.createUser({
    phone,
    password,
    phone_confirm: true,
  });
  const authUserId = userData!.user.id;
  const { data: customer } = await admin
    .from('customers')
    .insert({ auth_user_id: authUserId, name: 'Live Update E2E Customer', phone_e164: phone })
    .select()
    .single();

  const { data: branch } = await admin.from('branches').select('id').limit(1).single();
  const { data: bs } = await admin
    .from('branch_services')
    .select('id')
    .eq('branch_id', branch!.id)
    .limit(1)
    .single();
  const { data: ticketNumber } = await admin.rpc('next_ticket_number', { p_branch_id: branch!.id });
  const { data: ticket } = await admin
    .from('queue_tickets')
    .insert({
      ticket_number: ticketNumber,
      branch_id: branch!.id,
      customer_id: customer!.id,
      branch_service_id: bs!.id,
      state: 'waiting',
      created_by: 'staff',
    })
    .select()
    .single();

  try {
    const { data: sessionData } = await createClient<Database>(
      url,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    ).auth.signInWithPassword({ phone, password });
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

    await page.goto(`/tickets/${ticket!.id}`);
    await expect(page.getByText(ticket!.ticket_number)).toBeVisible({ timeout: 15000 });

    // Staff-side change, via the service-role client (standing in for a staff session's own
    // update -- what matters for this test is that the CUSTOMER's page reacts, not re-testing the
    // staff RLS path Task 7's own manual verification already covers).
    await admin
      .from('queue_tickets')
      .update({ state: 'confirmed', version: ticket!.version + 1 })
      .eq('id', ticket!.id);

    await expect(page.getByText(/being served/i)).toBeVisible({ timeout: 10000 });
  } finally {
    await admin.from('queue_events').delete().eq('ticket_id', ticket!.id);
    await admin.from('notifications').delete().eq('recipient_id', customer!.id);
    await admin.from('queue_tickets').delete().eq('id', ticket!.id);
    await admin.from('customers').delete().eq('id', customer!.id);
    await admin.auth.admin.deleteUser(authUserId);
  }
});
