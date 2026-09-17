// @vitest-environment node
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';
import { updateTicketWithVersion } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const suffix = Date.now();
let customerId: string;
let authUserId: string;
let branchId: string;
let branchServiceId: string;
let ticketId: string;

beforeAll(async () => {
  const phone = `+233${String(suffix).slice(-9)}`;
  const { data: user } = await admin.auth.admin.createUser({
    phone,
    password: 'Test-Password-123!',
    phone_confirm: true,
  });
  authUserId = user!.user.id;
  const { data: customer } = await admin
    .from('customers')
    .insert({ auth_user_id: authUserId, name: 'Concurrency Test Customer', phone_e164: phone })
    .select()
    .single();
  customerId = customer!.id;

  const { data: branch } = await admin.from('branches').select('id').limit(1).single();
  branchId = branch!.id;
  const { data: bs } = await admin
    .from('branch_services')
    .select('id')
    .eq('branch_id', branchId)
    .limit(1)
    .single();
  branchServiceId = bs!.id;

  const { data: ticketNumber } = await admin.rpc('next_ticket_number', { p_branch_id: branchId });
  const { data: ticket } = await admin
    .from('queue_tickets')
    .insert({
      ticket_number: ticketNumber,
      branch_id: branchId,
      customer_id: customerId,
      branch_service_id: branchServiceId,
      state: 'waiting',
      created_by: 'staff',
    })
    .select()
    .single();
  ticketId = ticket!.id;
});

afterAll(async () => {
  await admin.from('queue_events').delete().eq('ticket_id', ticketId);
  await admin.from('queue_tickets').delete().eq('id', ticketId);
  await admin.from('customers').delete().eq('id', customerId);
  await admin.auth.admin.deleteUser(authUserId);
});

describe('concurrent ticket edits', () => {
  it('rejects the second of two updates against the same starting version', async () => {
    const { data: startRow } = await admin
      .from('queue_tickets')
      .select('version')
      .eq('id', ticketId)
      .single();
    const startVersion = startRow!.version;

    const [first, second] = await Promise.all([
      updateTicketWithVersion(admin, ticketId, startVersion, { position: 1 }),
      updateTicketWithVersion(admin, ticketId, startVersion, { position: 2 }),
    ]);

    const outcomes = [first.success, second.success];
    expect(outcomes.filter((s) => s).length).toBe(1);
    expect(outcomes.filter((s) => !s).length).toBe(1);

    const { data: finalRow } = await admin
      .from('queue_tickets')
      .select('version')
      .eq('id', ticketId)
      .single();
    expect(finalRow!.version).toBe(startVersion + 1);
  });
});
