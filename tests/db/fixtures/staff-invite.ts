// tests/db/fixtures/staff-invite.ts
// Shared fixture for the staff invitation tests: one branch (with one branch_service), a signed-in
// Owner, a signed-in Branch Manager at that branch, and a signed-in phone customer. Plus helpers to
// create staff rows in any invite state, set a known invite token, and call Edge Functions.
// Not a test file itself (vitest only collects *.test.ts).
import { createHash } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

export type Client = SupabaseClient<Database>;
type StaffRole = Database['public']['Enums']['staff_role'];

export const PASSWORD = 'Test-Password-123!';

export interface SignedInStaff {
  authUserId: string;
  staffUserId: string;
  email: string;
  client: Client;
  accessToken: string;
}

export interface StaffAccount {
  authUserId: string;
  staffUserId: string;
  email: string;
  barberId: string | null;
}

export interface StaffInviteFixture {
  admin: Client;
  suffix: string;
  branchId: string;
  branchName: string;
  serviceId: string;
  branchServiceId: string;
  owner: SignedInStaff;
  manager: SignedInStaff;
  customer: { authUserId: string; customerId: string; client: Client; accessToken: string };
  /** staff_users ids created by tests (directly or via staff-invite); removed in cleanup. */
  createdStaffIds: string[];
  /** bare auth users (no staff_users row) created by tests; removed in cleanup. */
  createdAuthUserIds: string[];
}

function env() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export async function signIn(
  credentials: { email: string } | { phone: string },
  password = PASSWORD,
): Promise<{ client: Client; accessToken: string }> {
  const { url, anonKey } = env();
  const client = createClient<Database>(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await client.auth.signInWithPassword({
    ...credentials,
    password,
  } as never);
  if (error) throw error;
  return { client, accessToken: data.session!.access_token };
}

export async function callFunction(
  name: string,
  body: unknown,
  accessToken?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { url } = env();
  const response = await fetch(`${url}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body: parsed };
}

async function createSignedInStaff(
  admin: Client,
  label: string,
  role: StaffRole,
  suffix: string,
  branchId: string | null,
): Promise<SignedInStaff> {
  const email = `si-${label}-${suffix}@test.pixelbarber.local`;
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
      name: `SI Test ${label} ${suffix}`,
      email,
      role,
      invite_status: 'accepted',
    })
    .select('id')
    .single();
  if (error) throw error;
  if (branchId) {
    const { error: sbaError } = await admin
      .from('staff_branch_assignments')
      .insert({ staff_user_id: row!.id, branch_id: branchId });
    if (sbaError) throw sbaError;
  }
  const { client, accessToken } = await signIn({ email });
  return { authUserId: authUser!.user.id, staffUserId: row!.id, email, client, accessToken };
}

export async function createStaffInviteFixture(): Promise<StaffInviteFixture> {
  const { url, serviceRoleKey } = env();
  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

  const { data: business } = await admin.from('businesses').select('id').limit(1).single();
  const { data: service } = await admin.from('services').select('id').limit(1).single();
  const branchName = `SI Test Branch ${suffix}`;
  const { data: branch, error: branchError } = await admin
    .from('branches')
    .insert({
      business_id: business!.id,
      name: branchName,
      branch_code: `SI${suffix.slice(-7)}`,
      address: 'Test',
      latitude: 5.6,
      longitude: -0.18,
    })
    .select('id')
    .single();
  if (branchError) throw branchError;
  const { data: branchService, error: bsError } = await admin
    .from('branch_services')
    .insert({ branch_id: branch!.id, service_id: service!.id })
    .select('id')
    .single();
  if (bsError) throw bsError;

  const owner = await createSignedInStaff(admin, 'owner', 'owner', suffix, null);
  const manager = await createSignedInStaff(admin, 'manager', 'branch_manager', suffix, branch!.id);

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
      name: `SI Test Customer ${suffix}`,
      phone_e164: phone,
    })
    .select('id')
    .single();
  if (customerError) throw customerError;
  const customerSession = await signIn({ phone });

  return {
    admin,
    suffix,
    branchId: branch!.id,
    branchName,
    serviceId: service!.id,
    branchServiceId: branchService!.id,
    owner,
    manager,
    customer: {
      authUserId: customerAuth!.user.id,
      customerId: customer!.id,
      client: customerSession.client,
      accessToken: customerSession.accessToken,
    },
    createdStaffIds: [],
    createdAuthUserIds: [],
  };
}

export function trackStaff(f: StaffInviteFixture, staffUserId: string) {
  f.createdStaffIds.push(staffUserId);
}

/**
 * Creates a staff account in a given invite/account state, invited by the fixture's Owner.
 * 'accepted' accounts get PASSWORD so they can sign in; others get no password.
 * Barbers get a barbers row at `branchId` (default: the fixture branch); branch_manager/receptionist
 * get a branch assignment when `branchId` is given.
 */
export async function createStaffAccount(
  f: StaffInviteFixture,
  opts: {
    label: string;
    role: StaffRole;
    inviteStatus: 'pending' | 'accepted' | 'revoked';
    isActive?: boolean;
    branchId?: string | null;
  },
): Promise<StaffAccount> {
  const email = `si-${opts.label}-${f.suffix}@test.pixelbarber.local`;
  const { data: authUser, error: authError } = await f.admin.auth.admin.createUser({
    email,
    email_confirm: true,
    ...(opts.inviteStatus === 'accepted' ? { password: PASSWORD } : {}),
  });
  if (authError) throw authError;
  const { data: row, error } = await f.admin
    .from('staff_users')
    .insert({
      auth_user_id: authUser!.user.id,
      name: `SI Test ${opts.label} ${f.suffix}`,
      email,
      role: opts.role,
      invite_status: opts.inviteStatus,
      is_active: opts.isActive ?? true,
      invited_by_staff_id: f.owner.staffUserId,
      invited_at: new Date().toISOString(),
      invite_accepted_at: opts.inviteStatus === 'accepted' ? new Date().toISOString() : null,
    })
    .select('id')
    .single();
  if (error) throw error;
  trackStaff(f, row!.id);

  let barberId: string | null = null;
  if (opts.role === 'barber') {
    const { data: barber, error: barberError } = await f.admin
      .from('barbers')
      .insert({
        staff_user_id: row!.id,
        home_branch_id: opts.branchId ?? f.branchId,
        status: 'offline',
      })
      .select('id')
      .single();
    if (barberError) throw barberError;
    barberId = barber!.id;
  } else if (opts.branchId) {
    const { error: sbaError } = await f.admin
      .from('staff_branch_assignments')
      .insert({ staff_user_id: row!.id, branch_id: opts.branchId });
    if (sbaError) throw sbaError;
  }
  return { authUserId: authUser!.user.id, staffUserId: row!.id, email, barberId };
}

export async function setInviteToken(
  f: StaffInviteFixture,
  staffUserId: string,
  token: string,
  expiresAt: string,
) {
  const { error } = await f.admin.rpc(
    'test_set_staff_invite_token' as never,
    {
      p_staff_user_id: staffUserId,
      p_token: token,
      p_expires_at: expiresAt,
    } as never,
  );
  if (error) throw error;
}

export async function cleanupStaffInviteFixture(f: StaffInviteFixture) {
  const { admin } = f;
  // FK-safe: schedules/skills cascade from barbers, which cascade from staff_users, as do
  // staff_branch_assignments. staff_users.auth_user_id is `on delete restrict`, so each staff row
  // goes before its auth user. Invited rows reference the Owner (invited_by_staff_id), so they go
  // before the Owner.
  if (f.createdStaffIds.length > 0) {
    const { data: rows } = await admin
      .from('staff_users')
      .select('id, auth_user_id')
      .in('id', f.createdStaffIds);
    await admin.from('staff_users').delete().in('id', f.createdStaffIds);
    for (const r of rows ?? []) await admin.auth.admin.deleteUser(r.auth_user_id);
  }
  for (const authId of f.createdAuthUserIds) await admin.auth.admin.deleteUser(authId);
  await admin.from('staff_users').delete().in('id', [f.manager.staffUserId, f.owner.staffUserId]);
  await admin.auth.admin.deleteUser(f.manager.authUserId);
  await admin.auth.admin.deleteUser(f.owner.authUserId);
  await admin.from('customers').delete().eq('id', f.customer.customerId);
  await admin.auth.admin.deleteUser(f.customer.authUserId);
  await admin.from('branches').delete().eq('id', f.branchId);
}
