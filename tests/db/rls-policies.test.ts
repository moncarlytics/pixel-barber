// tests/db/rls-policies.test.ts
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

const PASSWORD = 'Test-Password-123!';
const suffix = Date.now();

type Fixture = {
  branchId: string;
  branchServiceId: string;
  customerAuthId: string;
  customerClient: ReturnType<typeof createClient<Database>>;
  ticketId: string;
  receptionistAuthId: string;
  receptionistClient: ReturnType<typeof createClient<Database>>;
};

let branchOne: Fixture;
let branchTwo: Fixture;
const createdCustomerAuthIds: string[] = [];
const createdStaffAuthIds: string[] = [];
const createdTicketIds: string[] = [];
const createdBranchIds: string[] = [];

async function buildBranchFixture(label: 'one' | 'two'): Promise<Fixture> {
  const { data: business } = await admin.from('businesses').select('id').limit(1).single();
  const { data: service } = await admin.from('services').select('id').limit(1).single();

  const { data: branch } = await admin
    .from('branches')
    .insert({
      business_id: business!.id,
      name: `RLS Policy Test Branch ${label}`,
      branch_code: `RLSP${label}${suffix % 100000}`,
      address: 'Test',
      latitude: 5.6,
      longitude: -0.18,
    })
    .select()
    .single();
  createdBranchIds.push(branch!.id);

  const { data: branchService } = await admin
    .from('branch_services')
    .insert({ branch_id: branch!.id, service_id: service!.id })
    .select()
    .single();

  const customerPhone = `+233${label === 'one' ? '20' : '24'}${String(suffix).slice(-7)}`;
  const { data: customerUser } = await admin.auth.admin.createUser({
    phone: customerPhone,
    password: PASSWORD,
    phone_confirm: true,
  });
  createdCustomerAuthIds.push(customerUser!.user.id);
  await admin.from('customers').insert({
    auth_user_id: customerUser!.user.id,
    name: `RLS Test Customer ${label}`,
    phone_e164: customerPhone,
  });
  const { data: customerRow } = await admin
    .from('customers')
    .select('id')
    .eq('auth_user_id', customerUser!.user.id)
    .single();

  const { data: ticket } = await admin
    .from('queue_tickets')
    .insert({
      ticket_number: `PB-TEST${label}-1`,
      branch_id: branch!.id,
      customer_id: customerRow!.id,
      branch_service_id: branchService!.id,
      created_by: 'staff',
    })
    .select()
    .single();
  createdTicketIds.push(ticket!.id);

  const receptionistEmail = `rls-policy-receptionist-${label}-${suffix}@test.pixelbarber.local`;
  const { data: receptionistUser } = await admin.auth.admin.createUser({
    email: receptionistEmail,
    password: PASSWORD,
    email_confirm: true,
  });
  createdStaffAuthIds.push(receptionistUser!.user.id);
  const { data: receptionistStaff } = await admin
    .from('staff_users')
    .insert({
      auth_user_id: receptionistUser!.user.id,
      name: `RLS Test Receptionist ${label}`,
      email: receptionistEmail,
      role: 'receptionist',
      invite_status: 'accepted',
    })
    .select()
    .single();
  await admin
    .from('staff_branch_assignments')
    .insert({ staff_user_id: receptionistStaff!.id, branch_id: branch!.id });

  const customerClient = createClient<Database>(url, anonKey);
  await customerClient.auth.signInWithPassword({ phone: customerPhone, password: PASSWORD });

  const receptionistClient = createClient<Database>(url, anonKey);
  await receptionistClient.auth.signInWithPassword({
    email: receptionistEmail,
    password: PASSWORD,
  });

  return {
    branchId: branch!.id,
    branchServiceId: branchService!.id,
    customerAuthId: customerUser!.user.id,
    customerClient,
    ticketId: ticket!.id,
    receptionistAuthId: receptionistUser!.user.id,
    receptionistClient,
  };
}

beforeAll(async () => {
  branchOne = await buildBranchFixture('one');
  branchTwo = await buildBranchFixture('two');
}, 30000);

afterAll(async () => {
  // Deletion order matters: queue_tickets.branch_id and queue_tickets.customer_id are both plain
  // `references` (default RESTRICT, no cascade) per backend-schema section 7, and
  // staff_users.auth_user_id is `on delete restrict` per section 2 — tickets must go before
  // customers/branches, and staff_users rows must go before their auth.users row.
  // branch_services/branch_service_prices and staff_branch_assignments DO cascade from branches
  // and staff_users respectively, so those don't need explicit cleanup here.
  for (const ticketId of createdTicketIds) {
    await admin.from('queue_tickets').delete().eq('id', ticketId);
  }
  for (const staffAuthId of createdStaffAuthIds) {
    await admin.from('staff_users').delete().eq('auth_user_id', staffAuthId);
  }
  for (const customerAuthId of createdCustomerAuthIds) {
    await admin.from('customers').delete().eq('auth_user_id', customerAuthId);
  }
  for (const authId of [...createdStaffAuthIds, ...createdCustomerAuthIds]) {
    await admin.auth.admin.deleteUser(authId);
  }
  for (const branchId of createdBranchIds) {
    await admin.from('branches').delete().eq('id', branchId);
  }
}, 30000);

describe('customer-to-customer isolation', () => {
  it('customer A cannot select customer B row via queue_tickets', async () => {
    const { data } = await branchOne.customerClient
      .from('queue_tickets')
      .select('*')
      .eq('id', branchTwo.ticketId);
    expect(data).toEqual([]);
  });

  it('customer A can select their own ticket', async () => {
    const { data } = await branchOne.customerClient
      .from('queue_tickets')
      .select('*')
      .eq('id', branchOne.ticketId);
    expect(data).toHaveLength(1);
  });
});

describe('branch-scoped staff isolation', () => {
  it('a receptionist scoped to branch one cannot see a branch two ticket', async () => {
    const { data } = await branchOne.receptionistClient
      .from('queue_tickets')
      .select('*')
      .eq('id', branchTwo.ticketId);
    expect(data).toEqual([]);
  });

  it('a receptionist scoped to branch one can see their own branch ticket', async () => {
    const { data } = await branchOne.receptionistClient
      .from('queue_tickets')
      .select('*')
      .eq('id', branchOne.ticketId);
    expect(data).toHaveLength(1);
  });
});
