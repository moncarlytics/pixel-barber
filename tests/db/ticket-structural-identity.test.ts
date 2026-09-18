// tests/db/ticket-structural-identity.test.ts
// @vitest-environment node
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// PRD 12.1: "All three [entry methods] produce the same kind of ticket, tracked identically from
// that point on." Columns that legitimately differ by entry method (created_by/created_by_staff_id,
// customer_id itself) are excluded from the equality check; everything else must match shape.
const IGNORED_KEYS = new Set([
  'id',
  'ticket_number',
  'customer_id',
  'created_by',
  'created_by_staff_id',
  'created_at',
  'updated_at',
  'version',
]);

describe('ticket structural identity across entry methods', () => {
  let branchId: string;
  let branchServiceId: string;
  let selfServiceCustomerId: string;
  let selfServiceAuthUserId: string;
  let walkInCustomerId: string;
  let selfServiceTicketId: string;
  let walkInTicketId: string;
  let staffAccessToken: string;
  let selfServiceAccessToken: string;
  let staffAuthUserId: string;
  let staffUserId: string;

  beforeAll(async () => {
    const suffix = Date.now();
    const { data: branch } = await admin.from('branches').select('id').limit(1).single();
    branchId = branch!.id;
    const { data: bs } = await admin
      .from('branch_services')
      .select('id')
      .eq('branch_id', branchId)
      .limit(1)
      .single();
    branchServiceId = bs!.id;

    const selfPhone = `+233${String(suffix).slice(-9)}`;
    const { data: selfUser } = await admin.auth.admin.createUser({
      phone: selfPhone,
      password: 'Test-Password-123!',
      phone_confirm: true,
    });
    selfServiceAuthUserId = selfUser!.user.id;
    const { data: selfCustomer } = await admin
      .from('customers')
      .insert({
        auth_user_id: selfServiceAuthUserId,
        name: 'Self Service Test',
        phone_e164: selfPhone,
      })
      .select()
      .single();
    selfServiceCustomerId = selfCustomer!.id;
    const anon = createClient<Database>(url, anonKey);
    const { data: selfSession } = await anon.auth.signInWithPassword({
      phone: selfPhone,
      password: 'Test-Password-123!',
    });
    selfServiceAccessToken = selfSession.session!.access_token;

    // A real staff session with edit_tickets to call /tickets/walk-in -- reuse an existing seeded
    // Owner/Manager account if this repo's staging already has one from Phase 1's seed data;
    // otherwise create a throwaway staff user with role granting edit_tickets and clean it up below.
    const staffEmail = `walkin-test-${suffix}@example.com`;
    const { data: staffAuthUser } = await admin.auth.admin.createUser({
      email: staffEmail,
      password: 'Test-Password-123!',
      email_confirm: true,
    });
    staffAuthUserId = staffAuthUser!.user.id;
    const { data: staffRow } = await admin
      .from('staff_users')
      .insert({
        auth_user_id: staffAuthUser!.user.id,
        name: 'Walkin Test Staff',
        email: staffEmail,
        role: 'receptionist',
        invite_status: 'accepted',
      })
      .select()
      .single();
    staffUserId = staffRow!.id;
    await admin
      .from('staff_branch_assignments')
      .insert({ staff_user_id: staffRow!.id, branch_id: branchId });
    const { data: staffSession } = await anon.auth.signInWithPassword({
      email: staffEmail,
      password: 'Test-Password-123!',
    });
    staffAccessToken = staffSession.session!.access_token;

    const selfResponse = await fetch(`${url}/functions/v1/tickets-join`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${selfServiceAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ branch_id: branchId, branch_service_id: branchServiceId }),
    }).then((r) => r.json());
    selfServiceTicketId = selfResponse.ticket.id;

    const walkInResponse = await fetch(`${url}/functions/v1/tickets-walk-in`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${staffAccessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        branch_id: branchId,
        branch_service_id: branchServiceId,
        name: 'Walk-in Test Customer',
        phone_e164: `+233${String(suffix + 1).slice(-9)}`,
      }),
    }).then((r) => r.json());
    walkInTicketId = walkInResponse.ticket.id;
    walkInCustomerId = walkInResponse.ticket.customer_id;
  }, 30000);

  afterAll(async () => {
    await admin
      .from('queue_events')
      .delete()
      .in('ticket_id', [selfServiceTicketId, walkInTicketId]);
    await admin
      .from('notifications')
      .delete()
      .in('recipient_id', [selfServiceCustomerId, walkInCustomerId]);
    await admin.from('queue_tickets').delete().in('id', [selfServiceTicketId, walkInTicketId]);
    await admin.from('customers').delete().in('id', [selfServiceCustomerId, walkInCustomerId]);
    await admin.auth.admin.deleteUser(selfServiceAuthUserId);
    await admin.from('staff_branch_assignments').delete().eq('staff_user_id', staffUserId);
    await admin.from('staff_users').delete().eq('id', staffUserId);
    await admin.auth.admin.deleteUser(staffAuthUserId);
  }, 30000);

  it('produces identical ticket shape for a walk-in and a self-service ticket, except entry-method-specific fields', async () => {
    const { data: selfTicket } = await admin
      .from('queue_tickets')
      .select('*')
      .eq('id', selfServiceTicketId)
      .single();
    const { data: walkInTicket } = await admin
      .from('queue_tickets')
      .select('*')
      .eq('id', walkInTicketId)
      .single();

    const selfKeys = Object.keys(selfTicket!)
      .filter((k) => !IGNORED_KEYS.has(k))
      .sort();
    const walkInKeys = Object.keys(walkInTicket!)
      .filter((k) => !IGNORED_KEYS.has(k))
      .sort();
    expect(selfKeys).toEqual(walkInKeys);

    for (const key of selfKeys) {
      expect((walkInTicket as any)[key]).toEqual((selfTicket as any)[key]);
    }

    expect(selfTicket!.created_by).toBe('customer');
    expect(walkInTicket!.created_by).toBe('staff');
  });
});
