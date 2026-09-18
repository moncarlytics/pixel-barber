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
  let barberId: string;
  let barberStaffUserId: string;
  let barberAuthUserId: string;

  beforeAll(async () => {
    const suffix = Date.now();

    // Task 2: ticket creation now requires a real eligible barber (find_eligible_barber). Rather
    // than adding a barber fixture onto the real shared "first branch" (which would race against
    // any other concurrently-running test's own barber fixture there under CI's parallel file
    // execution -- find_eligible_barber's fallback picks the least-busy eligible barber across
    // the whole branch, so this test's "same barber for both tickets" assertion below could flip
    // to a false failure), this test gets its own dedicated branch, exactly like
    // tests/db/find-eligible-barber.test.ts and tests/db/ticket-creation-barber-assignment.test.ts
    // already do.
    const { data: business } = await admin.from('businesses').select('id').limit(1).single();
    const { data: service } = await admin.from('services').select('id').limit(1).single();
    const { data: branch } = await admin
      .from('branches')
      .insert({
        business_id: business!.id,
        name: 'Ticket Structural Identity Test Branch',
        branch_code: `TSID${suffix % 100000}`,
        address: 'Test',
        latitude: 5.6,
        longitude: -0.18,
      })
      .select()
      .single();
    branchId = branch!.id;
    const { data: bs } = await admin
      .from('branch_services')
      .insert({ branch_id: branchId, service_id: service!.id })
      .select()
      .single();
    branchServiceId = bs!.id;

    const barberEmail = `structid-barber-${suffix}@test.pixelbarber.local`;
    const { data: barberAuth } = await admin.auth.admin.createUser({
      email: barberEmail,
      password: 'Test-Password-123!',
      email_confirm: true,
    });
    barberAuthUserId = barberAuth!.user.id;
    const { data: barberStaff } = await admin
      .from('staff_users')
      .insert({
        auth_user_id: barberAuthUserId,
        name: 'Structural Identity Test Barber',
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
    await admin.from('barber_skills').insert({ barber_id: barberId, service_id: service!.id });
    await admin.from('barber_schedule').insert({
      barber_id: barberId,
      work_date: new Date().toISOString().slice(0, 10),
      branch_id: branchId,
      shift_start: '00:00:00',
      shift_end: '23:59:59',
    });

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
    await admin.from('barber_schedule').delete().eq('barber_id', barberId);
    await admin.from('barber_skills').delete().eq('barber_id', barberId);
    await admin.from('barbers').delete().eq('id', barberId);
    await admin.from('staff_users').delete().eq('id', barberStaffUserId);
    await admin.auth.admin.deleteUser(barberAuthUserId);
    // tickets-join/tickets-walk-in both call next_ticket_number, which upserts a
    // branch_ticket_counters row with no cascade back to branches -- must go before the branch
    // delete below, or it fails with a foreign-key violation.
    await admin.from('branch_ticket_counters').delete().eq('branch_id', branchId);
    await admin.from('branches').delete().eq('id', branchId);
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
