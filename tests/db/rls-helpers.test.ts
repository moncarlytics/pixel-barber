// tests/db/rls-helpers.test.ts
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

let branchId: string;
let managerAuthUserId: string;
let managerClient: ReturnType<typeof createClient<Database>>;
let customerAuthUserId: string;
let customerClient: ReturnType<typeof createClient<Database>>;

const MANAGER_EMAIL = `rls-helpers-manager-${Date.now()}@test.pixelbarber.local`;
const CUSTOMER_PHONE = `+233${Math.floor(200000000 + Math.random() * 99999999)}`;
const PASSWORD = 'Test-Password-123!';

beforeAll(async () => {
  const { data: business } = await admin.from('businesses').select('id').limit(1).single();

  const { data: branch, error: branchError } = await admin
    .from('branches')
    .insert({
      business_id: business!.id,
      name: 'RLS Helper Test Branch',
      branch_code: `RLSH${Date.now() % 100000}`,
      address: 'Test',
      latitude: 5.6,
      longitude: -0.18,
    })
    .select()
    .single();
  if (branchError) throw branchError;
  branchId = branch.id;

  const { data: managerUser, error: managerError } = await admin.auth.admin.createUser({
    email: MANAGER_EMAIL,
    password: PASSWORD,
    email_confirm: true,
  });
  if (managerError) throw managerError;
  managerAuthUserId = managerUser.user.id;

  const { data: managerStaff, error: managerStaffError } = await admin
    .from('staff_users')
    .insert({
      auth_user_id: managerAuthUserId,
      name: 'RLS Test Manager',
      email: MANAGER_EMAIL,
      role: 'branch_manager',
      invite_status: 'accepted',
    })
    .select()
    .single();
  if (managerStaffError) throw managerStaffError;

  await admin
    .from('staff_branch_assignments')
    .insert({ staff_user_id: managerStaff.id, branch_id: branchId });

  const { data: customerUser, error: customerError } = await admin.auth.admin.createUser({
    phone: CUSTOMER_PHONE,
    password: PASSWORD,
    phone_confirm: true,
  });
  if (customerError) throw customerError;
  customerAuthUserId = customerUser.user.id;

  await admin.from('customers').insert({
    auth_user_id: customerAuthUserId,
    name: 'RLS Test Customer',
    phone_e164: CUSTOMER_PHONE,
  });

  managerClient = createClient<Database>(url, anonKey);
  await managerClient.auth.signInWithPassword({ email: MANAGER_EMAIL, password: PASSWORD });

  customerClient = createClient<Database>(url, anonKey);
  await customerClient.auth.signInWithPassword({ phone: CUSTOMER_PHONE, password: PASSWORD });
});

afterAll(async () => {
  // staff_users.auth_user_id is `on delete restrict` (backend-schema section 2) — the
  // auth.users row cannot be deleted while its staff_users row still references it, so
  // staff_users must be deleted first. customers.auth_user_id is `on delete set null`, so
  // deleting that auth user is safe on its own, but the orphaned customers row is cleaned up
  // explicitly too rather than left behind.
  await admin.from('staff_users').delete().eq('auth_user_id', managerAuthUserId);
  await admin.from('customers').delete().eq('auth_user_id', customerAuthUserId);
  await admin.auth.admin.deleteUser(managerAuthUserId);
  await admin.auth.admin.deleteUser(customerAuthUserId);
  await admin.from('branches').delete().eq('id', branchId);
});

describe('auth_role()', () => {
  it('returns branch_manager for the manager session', async () => {
    const { data } = await managerClient.rpc('auth_role');
    expect(data).toBe('branch_manager');
  });

  it('returns customer for the customer session', async () => {
    const { data } = await customerClient.rpc('auth_role');
    expect(data).toBe('customer');
  });
});

describe('has_capability()', () => {
  it('does not throw and returns true for a capability the manager role holds', async () => {
    const { data, error } = await managerClient.rpc('has_capability', { cap: 'edit_pricing' });
    expect(error).toBeNull();
    expect(data).toBe(true);
  });

  it('does not throw and returns false for a customer session (the bug this fixes)', async () => {
    const { data, error } = await customerClient.rpc('has_capability', { cap: 'edit_pricing' });
    expect(error).toBeNull();
    expect(data).toBe(false);
  });
});

describe('in_branch_scope()', () => {
  it('returns true for the manager on their assigned branch', async () => {
    const { data } = await managerClient.rpc('in_branch_scope', { target_branch: branchId });
    expect(data).toBe(true);
  });

  it('returns false for the manager on a branch they are not assigned to', async () => {
    const { data: otherBranch } = await admin
      .from('branches')
      .select('id')
      .neq('id', branchId)
      .limit(1)
      .single();
    const { data } = await managerClient.rpc('in_branch_scope', {
      target_branch: otherBranch!.id,
    });
    expect(data).toBe(false);
  });
});
