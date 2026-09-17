// tests/db/shared-station-handoff.test.ts
// @vitest-environment node
// Phase 5 Task 7 regression: proves the shared-station "End Shift" handoff (Task 7's sign-out +
// redirect wired onto Task 5's status-toggle handler in apps/staff/app/queue/today/page.tsx)
// actually clears the prior barber's queue view for whoever logs in next on the same physical
// station. Today's Queue keeps no client-side cache of its own -- its reads are always keyed off
// the CURRENT session's resolved barber id (refetchQueue) -- so a real sign-out followed by a real
// re-login genuinely cannot leak a stale view, and this is testable at the DB level rather than
// requiring a full Playwright browser test:
//   (a) barber A's End Shift sign-out tears their session down server-side, and
//   (b) barber B, using a genuinely separate/fresh client (never barber A's), reads through
//       Today's Queue's exact assigned_barber_id filter and sees ONLY their own ticket.
//
// One documented Supabase platform nuance this test does NOT assert, and cannot correctly assert:
// per Supabase's own sign-out docs, a revoked session's raw ACCESS TOKEN (the JWT string itself)
// remains cryptographically valid until its own `exp` claim, because JWT verification is
// stateless -- signOut only guarantees the REFRESH TOKEN is destroyed immediately and the client's
// own session state is cleared. That's a generic bearer-token-lifetime property of every Supabase
// Auth session, not something this feature could change, and it never actually bites here: nothing
// in this app caches or replays a raw JWT string outside its owning Supabase client instance, so
// there is no code path where barber A's stale token could resurface on the shared station after
// sign-out. This test instead asserts the two things that ARE immediate and server-verifiable:
// the old refresh token is rejected, and the signed-out client instance itself has no session left
// to hand to the next barber. See task-7-report.md for the full reasoning.
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

const PASSWORD = 'Test-Password-123!';
const suffix = Date.now();

let branchId: string;
let branchServiceId: string;

let barberAStaffUserId: string;
let barberAAuthUserId: string;
let barberAId: string;
let barberAEmail: string;
let ticketAId: string;
let customerAId: string;
let customerAAuthId: string;

let barberBStaffUserId: string;
let barberBAuthUserId: string;
let barberBId: string;
let barberBEmail: string;
let ticketBId: string;
let customerBId: string;
let customerBAuthId: string;

async function createBarber(label: string) {
  const email = `shared-station-test-${label}-${suffix}@test.pixelbarber.local`;
  const { data: authUser, error: authError } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (authError) throw authError;

  const { data: staffRow, error: staffError } = await admin
    .from('staff_users')
    .insert({
      auth_user_id: authUser!.user.id,
      name: `Shared Station Test Barber ${label}`,
      email,
      role: 'barber',
      invite_status: 'accepted',
    })
    .select()
    .single();
  if (staffError) throw staffError;

  const { data: barberRow, error: barberError } = await admin
    .from('barbers')
    .insert({ staff_user_id: staffRow!.id, home_branch_id: branchId })
    .select()
    .single();
  if (barberError) throw barberError;

  return {
    authUserId: authUser!.user.id as string,
    staffUserId: staffRow!.id as string,
    barberId: barberRow!.id as string,
    email,
  };
}

async function createCustomer(label: string) {
  const phone = `+233${String(suffix).slice(-8)}${label}`;
  const { data: authUser, error: authError } = await admin.auth.admin.createUser({
    phone,
    password: PASSWORD,
    phone_confirm: true,
  });
  if (authError) throw authError;
  const { data: customer, error: customerError } = await admin
    .from('customers')
    .insert({
      auth_user_id: authUser!.user.id,
      name: `Shared Station Test Customer ${label}`,
      phone_e164: phone,
    })
    .select()
    .single();
  if (customerError) throw customerError;
  return { authUserId: authUser!.user.id as string, customerId: customer!.id as string };
}

async function createTicket(opts: { label: string; customerId: string; barberId: string }) {
  const { data: ticket, error } = await admin
    .from('queue_tickets')
    .insert({
      ticket_number: `PB-HANDOFF-${opts.label}-${suffix}`,
      branch_id: branchId,
      customer_id: opts.customerId,
      branch_service_id: branchServiceId,
      assigned_barber_id: opts.barberId,
      state: 'waiting',
      position: 1,
      created_by: 'staff',
    })
    .select()
    .single();
  if (error) throw error;
  return ticket!.id as string;
}

beforeAll(async () => {
  const { data: business } = await admin.from('businesses').select('id').limit(1).single();
  const { data: service } = await admin.from('services').select('id').limit(1).single();

  const { data: branch } = await admin
    .from('branches')
    .insert({
      business_id: business!.id,
      name: 'Shared Station Handoff Test Branch',
      branch_code: `SSH${suffix % 100000}`,
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

  const barberA = await createBarber('A');
  barberAStaffUserId = barberA.staffUserId;
  barberAAuthUserId = barberA.authUserId;
  barberAId = barberA.barberId;
  barberAEmail = barberA.email;

  const barberB = await createBarber('B');
  barberBStaffUserId = barberB.staffUserId;
  barberBAuthUserId = barberB.authUserId;
  barberBId = barberB.barberId;
  barberBEmail = barberB.email;

  const customerA = await createCustomer('1');
  customerAId = customerA.customerId;
  customerAAuthId = customerA.authUserId;

  const customerB = await createCustomer('2');
  customerBId = customerB.customerId;
  customerBAuthId = customerB.authUserId;

  ticketAId = await createTicket({ label: 'A', customerId: customerAId, barberId: barberAId });
  ticketBId = await createTicket({ label: 'B', customerId: customerBId, barberId: barberBId });
}, 30000);

afterAll(async () => {
  // FK-safe order (matches tests/db/queue-position-recalc-cross-actor.test.ts and
  // tests/db/pin-login.test.ts): queue_events before queue_tickets, tickets before
  // customers/staff_users, staff_users before their auth users (staff_users.auth_user_id is
  // `on delete restrict`, so the staff_users row must go before its auth.users row -- deleting
  // staff_users also cascades to the barbers rows), auth users before branches, branches last.
  for (const ticketId of [ticketAId, ticketBId]) {
    await admin.from('queue_events').delete().eq('ticket_id', ticketId);
  }
  for (const ticketId of [ticketAId, ticketBId]) {
    await admin.from('queue_tickets').delete().eq('id', ticketId);
  }
  for (const customerId of [customerAId, customerBId]) {
    await admin.from('customers').delete().eq('id', customerId);
  }
  for (const staffUserId of [barberAStaffUserId, barberBStaffUserId]) {
    await admin.from('staff_users').delete().eq('id', staffUserId);
  }
  for (const authId of [barberAAuthUserId, barberBAuthUserId, customerAAuthId, customerBAuthId]) {
    await admin.auth.admin.deleteUser(authId);
  }
  await admin.from('branches').delete().eq('id', branchId);
}, 30000);

describe('shared-station End Shift handoff', () => {
  it("barber A's End Shift sign-out tears down their session: the refresh token is revoked and the signed-out client instance loses its session", async () => {
    const barberAClient = createClient<Database>(url, anonKey);
    const { data: signInData, error: signInError } = await barberAClient.auth.signInWithPassword({
      email: barberAEmail,
      password: PASSWORD,
    });
    expect(signInError).toBeNull();
    const oldRefreshToken = signInData!.session!.refresh_token;

    // The exact handler shape Task 7 wires onto Task 5's status toggle: write status, then sign
    // out. barbers_self_update (Phase 1) already covers this write on the barber's own row.
    const { error: statusError } = await barberAClient
      .from('barbers')
      .update({ status: 'end_of_shift' })
      .eq('id', barberAId);
    expect(statusError).toBeNull();

    const { error: signOutError } = await barberAClient.auth.signOut();
    expect(signOutError).toBeNull();

    // 1. The signed-out client instance itself no longer carries a session -- this is what
    // actually matters for the shared station: the browser/client just used has nothing left to
    // hand to whoever uses the station next.
    const { data: sessionAfterSignOut } = await barberAClient.auth.getSession();
    expect(sessionAfterSignOut.session).toBeNull();

    // 2. The old REFRESH TOKEN backing that session is revoked server-side. Using a totally
    // separate, fresh client (never barberAClient) to attempt the refresh proves this is real
    // server-side revocation, not just barberAClient's own local state being cleared.
    const freshClient = createClient<Database>(url, anonKey);
    const { data: refreshData, error: refreshError } = await freshClient.auth.refreshSession({
      refresh_token: oldRefreshToken,
    });
    expect(refreshError).not.toBeNull();
    expect(refreshData.session).toBeNull();

    // 3. Confirm the status write actually landed -- this was a real end-of-shift, not a no-op.
    const { data: barberRow } = await admin
      .from('barbers')
      .select('status')
      .eq('id', barberAId)
      .single();
    expect(barberRow!.status).toBe('end_of_shift');
  });

  it("barber B, on a genuinely fresh/separate client, sees only their own ticket via Today's Queue's exact filter -- never barber A's", async () => {
    // A brand-new client instance, unrelated to barberAClient above -- this stands in for a fresh
    // page load / station takeover after barber A's sign-out, not a reused client with a swapped
    // session.
    const barberBClient = createClient<Database>(url, anonKey);
    const { error: signInError } = await barberBClient.auth.signInWithPassword({
      email: barberBEmail,
      password: PASSWORD,
    });
    expect(signInError).toBeNull();

    // Exact filter shape Today's Queue's own refetchQueue() uses for its "Next Customer" query
    // (apps/staff/app/queue/today/page.tsx): .eq('assigned_barber_id', <own barber id>).in('state', [...]).
    const { data: myTickets, error: myTicketsError } = await barberBClient
      .from('queue_tickets')
      .select('*')
      .eq('assigned_barber_id', barberBId)
      .in('state', ['waiting', 'almost_turn']);
    expect(myTicketsError).toBeNull();
    expect(myTickets).toHaveLength(1);
    expect(myTickets![0].id).toBe(ticketBId);

    // Stronger check: even with NO assigned_barber_id filter at all, RLS itself
    // (tickets_barber_own_queue_select) never lets barber B see barber A's ticket -- proving there
    // is no session/data bleed-through at the database layer, not merely an app-level filter that
    // happens to be doing the work.
    const { data: allVisibleTickets, error: allVisibleError } = await barberBClient
      .from('queue_tickets')
      .select('id');
    expect(allVisibleError).toBeNull();
    expect(allVisibleTickets!.map((t) => t.id)).toEqual([ticketBId]);
  });
});
