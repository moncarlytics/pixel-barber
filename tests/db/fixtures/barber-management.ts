// tests/db/fixtures/barber-management.ts
// Shared fixture for the Barbers Management schedule/skills tests: two branches, a Branch Manager
// scoped to each, one barber at branch A (active, 'available'), and one phone-auth customer, each
// with a signed-in client. Not a test file itself (vitest only collects *.test.ts).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

export type Client = SupabaseClient<Database>;

export const PASSWORD = 'Test-Password-123!';

export interface StaffLogin {
  authUserId: string;
  staffUserId: string;
  email: string;
  client: Client;
}

export interface BarberManagementFixture {
  admin: Client;
  suffix: string;
  serviceId: string;
  otherServiceId: string;
  branchAId: string;
  branchBId: string;
  branchServiceAId: string;
  managerA: StaffLogin;
  managerB: StaffLogin;
  barber: StaffLogin & { barberId: string; name: string };
  customer: { authUserId: string; customerId: string; client: Client };
}

function env() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  };
}

async function signedInClient(email: string): Promise<Client> {
  const { url, anonKey } = env();
  const client = createClient<Database>(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return client;
}

async function createStaff(
  admin: Client,
  label: string,
  role: 'branch_manager' | 'barber',
  suffix: string,
  assignBranchId: string | null,
): Promise<StaffLogin & { name: string }> {
  const email = `bm-${label}-${suffix}@test.pixelbarber.local`;
  const name = `BM Test ${label} ${suffix}`;
  const { data: authUser, error: authError } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (authError) throw authError;
  const { data: staffRow, error: staffError } = await admin
    .from('staff_users')
    .insert({ auth_user_id: authUser!.user.id, name, email, role, invite_status: 'accepted' })
    .select()
    .single();
  if (staffError) throw staffError;
  if (assignBranchId) {
    const { error: sbaError } = await admin
      .from('staff_branch_assignments')
      .insert({ staff_user_id: staffRow!.id, branch_id: assignBranchId });
    if (sbaError) throw sbaError;
  }
  return {
    authUserId: authUser!.user.id,
    staffUserId: staffRow!.id,
    email,
    name,
    client: await signedInClient(email),
  };
}

export async function createBarberManagementFixture(): Promise<BarberManagementFixture> {
  const { url, anonKey, serviceRoleKey } = env();
  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

  const { data: business } = await admin.from('businesses').select('id').limit(1).single();
  const { data: services } = await admin.from('services').select('id').limit(2);
  const serviceId = services![0].id;
  const otherServiceId = services![1].id;

  const makeBranch = async (label: string) => {
    const { data, error } = await admin
      .from('branches')
      .insert({
        business_id: business!.id,
        name: `BM Test Branch ${label} ${suffix}`,
        branch_code: `BM${label}${suffix.slice(-6)}`,
        address: 'Test',
        latitude: 5.6,
        longitude: -0.18,
      })
      .select()
      .single();
    if (error) throw error;
    return data!.id as string;
  };
  const branchAId = await makeBranch('A');
  const branchBId = await makeBranch('B');

  const { data: bsA, error: bsError } = await admin
    .from('branch_services')
    .insert({ branch_id: branchAId, service_id: serviceId })
    .select()
    .single();
  if (bsError) throw bsError;

  const managerA = await createStaff(admin, 'mgrA', 'branch_manager', suffix, branchAId);
  const managerB = await createStaff(admin, 'mgrB', 'branch_manager', suffix, branchBId);
  const barberStaff = await createStaff(admin, 'barber', 'barber', suffix, null);
  const { data: barberRow, error: barberError } = await admin
    .from('barbers')
    .insert({
      staff_user_id: barberStaff.staffUserId,
      home_branch_id: branchAId,
      status: 'available',
    })
    .select()
    .single();
  if (barberError) throw barberError;

  const phone = `+233${suffix.slice(-9)}`;
  const { data: customerAuth, error: customerAuthError } = await admin.auth.admin.createUser({
    phone,
    password: PASSWORD,
    phone_confirm: true,
  });
  if (customerAuthError) throw customerAuthError;
  const { data: customer, error: customerError } = await admin
    .from('customers')
    .insert({
      auth_user_id: customerAuth!.user.id,
      name: `BM Test Customer ${suffix}`,
      phone_e164: phone,
    })
    .select()
    .single();
  if (customerError) throw customerError;
  const customerClient = createClient<Database>(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: customerSignInError } = await customerClient.auth.signInWithPassword({
    phone,
    password: PASSWORD,
  });
  if (customerSignInError) throw customerSignInError;

  return {
    admin,
    suffix,
    serviceId,
    otherServiceId,
    branchAId,
    branchBId,
    branchServiceAId: bsA!.id,
    managerA,
    managerB,
    barber: { ...barberStaff, barberId: barberRow!.id },
    customer: {
      authUserId: customerAuth!.user.id,
      customerId: customer!.id,
      client: customerClient,
    },
  };
}

export async function cleanupBarberManagementFixture(f: BarberManagementFixture) {
  const { admin } = f;
  // FK-safe: dated/pattern/skill rows first (all cascade from barbers anyway, but explicit is
  // cheap), then staff_branch_assignments, then staff_users (cascades the barbers row), then auth
  // users (staff_users.auth_user_id is `on delete restrict`), then the customer, then branches
  // (branch_services cascade). These tests create no tickets, so no ticket cleanup.
  await admin.from('barber_days_off').delete().eq('barber_id', f.barber.barberId);
  await admin.from('barber_weekly_hours').delete().eq('barber_id', f.barber.barberId);
  await admin.from('barber_schedule').delete().eq('barber_id', f.barber.barberId);
  await admin.from('barber_skills').delete().eq('barber_id', f.barber.barberId);
  await admin
    .from('staff_branch_assignments')
    .delete()
    .in('staff_user_id', [f.managerA.staffUserId, f.managerB.staffUserId]);
  await admin
    .from('staff_users')
    .delete()
    .in('id', [f.managerA.staffUserId, f.managerB.staffUserId, f.barber.staffUserId]);
  for (const authId of [f.managerA.authUserId, f.managerB.authUserId, f.barber.authUserId]) {
    await admin.auth.admin.deleteUser(authId);
  }
  await admin.from('customers').delete().eq('id', f.customer.customerId);
  await admin.auth.admin.deleteUser(f.customer.authUserId);
  await admin.from('branches').delete().in('id', [f.branchAId, f.branchBId]);
}
