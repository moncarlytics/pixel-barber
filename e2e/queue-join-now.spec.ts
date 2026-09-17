// e2e/queue-join-now.spec.ts
// Exercises the actual browser -> Edge Function path for /tickets/join (the reason the CORS fix
// in commit dfaeb7b exists) end to end: a real customer session, in a real browser, clicking
// through the Book flow's service/barber/review steps and hitting Join Now for real.
import { test, expect } from '@playwright/test';
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

test('customer can join the queue end to end through the Book flow UI', async ({
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
    .insert({ auth_user_id: authUserId, name: 'Join Now E2E Customer', phone_e164: phone })
    .select()
    .single();
  // Pick a branch that actually has at least one branch_services row (the Book flow's "first
  // service" click below depends on it) rather than assuming the first branch in the table
  // qualifies -- mirrors the beforeAll pattern in tests/db/ticket-structural-identity.test.ts,
  // which derives its branch the same fail-loud way.
  const { data: bs } = await admin.from('branch_services').select('branch_id').limit(1).single();
  const branch = { id: bs!.branch_id };

  let createdTicketId: string | null = null;

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

    await page.goto(`/book?branch=${branch!.id}`);
    await page.getByRole('button').first().click(); // first service in the list
    await page.getByRole('button', { name: /any available/i }).click();
    await page.getByRole('button', { name: /join now/i }).click();

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
      await admin.from('notifications').delete().eq('recipient_id', customer!.id);
      await admin.from('queue_tickets').delete().eq('id', createdTicketId);
    }
    await admin.from('customers').delete().eq('id', customer!.id);
    await admin.auth.admin.deleteUser(authUserId);
  }
});
