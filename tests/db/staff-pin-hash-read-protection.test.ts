// tests/db/staff-pin-hash-read-protection.test.ts
// @vitest-environment node
// staff_users.pin_hash is a bcrypt hash of a 4-6 digit PIN -- brute-forceable offline in seconds,
// so no client session may ever read it. staff_users_branch_scoped_read lets any staff member at a
// branch read their colleagues' rows, and staff_users_self_read lets everyone read their own; the
// row policies are fine, but the column must be withheld by the grant itself. Non-secret columns
// must stay readable, and PIN login (verify_barber_pin, security definer) is unaffected -- that is
// covered by pin-login.test.ts.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

type Client = SupabaseClient<Database>;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PASSWORD = 'Test-Password-123!';
const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

let branchId: string;
const staff: Record<
  'manager' | 'receptionist',
  { authUserId: string; staffUserId: string; client: Client }
> = {} as never;

async function createStaff(
  label: 'manager' | 'receptionist',
  role: 'branch_manager' | 'receptionist',
) {
  const email = `pinread-${label}-${suffix}@test.pixelbarber.local`;
  const { data: authUser, error: authError } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (authError) throw authError;
  const { data: row, error } = await admin
    .from('staff_users')
    .insert({
      auth_user_id: authUser!.user.id,
      name: `Pin Read Test ${label} ${suffix}`,
      email,
      role,
      invite_status: 'accepted',
    })
    .select('id')
    .single();
  if (error) throw error;
  const { error: sbaError } = await admin
    .from('staff_branch_assignments')
    .insert({ staff_user_id: row!.id, branch_id: branchId });
  if (sbaError) throw sbaError;
  const client = createClient<Database>(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({
    email,
    password: PASSWORD,
  });
  if (signInError) throw signInError;
  staff[label] = { authUserId: authUser!.user.id, staffUserId: row!.id, client };
}

beforeAll(async () => {
  const { data: business } = await admin.from('businesses').select('id').limit(1).single();
  const { data: branch, error } = await admin
    .from('branches')
    .insert({
      business_id: business!.id,
      name: `Pin Read Test Branch ${suffix}`,
      branch_code: `PR${suffix.slice(-7)}`,
      address: 'Test',
      latitude: 5.6,
      longitude: -0.18,
    })
    .select('id')
    .single();
  if (error) throw error;
  branchId = branch!.id;
  await createStaff('manager', 'branch_manager');
  await createStaff('receptionist', 'receptionist');
  const { error: pinError } = await admin.rpc('test_set_staff_pin_hash', {
    p_staff_user_id: staff.receptionist.staffUserId,
    p_pin: '4321',
  });
  if (pinError) throw pinError;
}, 60000);

afterAll(async () => {
  const ids = Object.values(staff).map((s) => s.staffUserId);
  await admin.from('staff_branch_assignments').delete().in('staff_user_id', ids);
  await admin.from('staff_users').delete().in('id', ids);
  for (const s of Object.values(staff)) await admin.auth.admin.deleteUser(s.authUserId);
  await admin.from('branches').delete().eq('id', branchId);
}, 60000);

describe('staff_users.pin_hash read protection', () => {
  it("refuses a branch manager reading a colleague's pin_hash", async () => {
    const { data, error } = await staff.manager.client
      .from('staff_users')
      .select('pin_hash')
      .eq('id', staff.receptionist.staffUserId);
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });

  it('refuses a staff member reading their own pin_hash', async () => {
    const { data, error } = await staff.receptionist.client
      .from('staff_users')
      .select('pin_hash')
      .eq('id', staff.receptionist.staffUserId);
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });

  it("still lets a branch manager read a colleague's non-secret columns", async () => {
    const { data, error } = await staff.manager.client
      .from('staff_users')
      .select('id, name, role, is_active')
      .eq('id', staff.receptionist.staffUserId)
      .single();
    expect(error).toBeNull();
    expect(data?.role).toBe('receptionist');
  });
});
