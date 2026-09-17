// tests/db/pin-login.test.ts
// @vitest-environment node
// Since Task 3 (which builds the real PIN-setting UI/Edge Function) hasn't landed data yet when
// this task is implemented, this test sets a bcrypt pin_hash directly via SQL (test_set_staff_pin_hash,
// a service_role-only helper added alongside verify_barber_pin -- see
// supabase/migrations/20260917090200_verify_barber_pin.sql -- that runs
// `crypt(p_pin, gen_salt('bf'))` server-side) to isolate pin-login's own logic from Task 3's.
// Covers: correct PIN + correct branch (via home_branch_id) succeeds and returns real, usable
// tokens; correct PIN + correct branch (via staff_branch_assignments, not home_branch_id) succeeds;
// correct PIN + WRONG branch fails; wrong PIN fails; a non-barber staff_user's PIN is never
// matched, since the function filters on role='barber'.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const suffix = Date.now();

const HOME_PIN = '1234';
const ASSIGNED_PIN = '5678';
const WRONG_PIN = '0000';
const RECEPTIONIST_PIN = '4321';

let businessId: string;
let branchHomeId: string;
let branchAssignedId: string;
const createdBranchIds: string[] = [];
const createdStaffUserIds: string[] = [];
const createdAuthUserIds: string[] = [];

let barberHomeStaffUserId: string;
let barberHomeAuthUserId: string;
let barberHomeEmail: string;

let barberAssignedStaffUserId: string;
let barberAssignedAuthUserId: string;

async function createBranch(label: string) {
  const { data: branch, error } = await admin
    .from('branches')
    .insert({
      business_id: businessId,
      name: `Pin Login Test Branch ${label}`,
      branch_code: `PL${label}${suffix % 100000}`,
      address: 'Test',
      latitude: 5.6,
      longitude: -0.18,
    })
    .select()
    .single();
  if (error) throw error;
  createdBranchIds.push(branch!.id);
  return branch!.id as string;
}

async function createStaffUser(opts: {
  label: string;
  role: 'barber' | 'receptionist';
  homeBranchId?: string;
}) {
  const email = `pin-login-test-${opts.label}-${suffix}@test.pixelbarber.local`;
  const { data: authUser, error: authError } = await admin.auth.admin.createUser({
    email,
    password: 'Test-Password-123!',
    email_confirm: true,
  });
  if (authError) throw authError;
  createdAuthUserIds.push(authUser!.user.id);

  const { data: staffRow, error: staffError } = await admin
    .from('staff_users')
    .insert({
      auth_user_id: authUser!.user.id,
      name: `Pin Login Test ${opts.label}`,
      email,
      role: opts.role,
      invite_status: 'accepted',
    })
    .select()
    .single();
  if (staffError) throw staffError;
  createdStaffUserIds.push(staffRow!.id);

  if (opts.role === 'barber') {
    const { error: barberError } = await admin
      .from('barbers')
      .insert({ staff_user_id: staffRow!.id, home_branch_id: opts.homeBranchId! });
    if (barberError) throw barberError;
  }

  return { staffUserId: staffRow!.id as string, authUserId: authUser!.user.id, email };
}

async function setPin(staffUserId: string, pin: string) {
  const { error } = await admin.rpc('test_set_staff_pin_hash', {
    p_staff_user_id: staffUserId,
    p_pin: pin,
  });
  if (error) throw error;
}

async function callPinLogin(branchId: string, pin: string) {
  const response = await fetch(`${url}/functions/v1/pin-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch_id: branchId, pin }),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

beforeAll(async () => {
  const { data: business } = await admin.from('businesses').select('id').limit(1).single();
  businessId = business!.id;

  branchHomeId = await createBranch('Home');
  branchAssignedId = await createBranch('Assigned');

  const barberHome = await createStaffUser({
    label: 'barber-home',
    role: 'barber',
    homeBranchId: branchHomeId,
  });
  barberHomeStaffUserId = barberHome.staffUserId;
  barberHomeAuthUserId = barberHome.authUserId;
  barberHomeEmail = barberHome.email;
  await setPin(barberHomeStaffUserId, HOME_PIN);

  // home_branch_id deliberately differs from branchAssignedId -- this barber can only reach
  // branchAssignedId through the staff_branch_assignments path, never home_branch_id.
  const barberAssigned = await createStaffUser({
    label: 'barber-assigned',
    role: 'barber',
    homeBranchId: branchHomeId,
  });
  barberAssignedStaffUserId = barberAssigned.staffUserId;
  barberAssignedAuthUserId = barberAssigned.authUserId;
  await setPin(barberAssignedStaffUserId, ASSIGNED_PIN);
  const { error: assignmentError } = await admin
    .from('staff_branch_assignments')
    .insert({ staff_user_id: barberAssignedStaffUserId, branch_id: branchAssignedId });
  if (assignmentError) throw assignmentError;

  // A non-barber (receptionist) staff_user with a pin_hash and a branch assignment -- exists purely
  // to prove verify_barber_pin's role='barber' filter (and its join to barbers) keeps a
  // non-barber's PIN from ever authenticating through this flow.
  const receptionist = await createStaffUser({ label: 'receptionist', role: 'receptionist' });
  await setPin(receptionist.staffUserId, RECEPTIONIST_PIN);
  const { error: receptionistAssignmentError } = await admin
    .from('staff_branch_assignments')
    .insert({ staff_user_id: receptionist.staffUserId, branch_id: branchHomeId });
  if (receptionistAssignmentError) throw receptionistAssignmentError;
}, 30000);

afterAll(async () => {
  await admin.from('staff_branch_assignments').delete().in('staff_user_id', createdStaffUserIds);
  // staff_users.id -> barbers.staff_user_id cascades, so deleting staff_users removes the barbers
  // rows too; staff_users.auth_user_id is `on delete restrict`, so the staff_users row must go
  // before its auth.users row.
  for (const staffUserId of createdStaffUserIds) {
    await admin.from('staff_users').delete().eq('id', staffUserId);
  }
  for (const authUserId of createdAuthUserIds) {
    await admin.auth.admin.deleteUser(authUserId);
  }
  for (const branchId of createdBranchIds) {
    await admin.from('branches').delete().eq('id', branchId);
  }
}, 30000);

describe('pin-login Edge Function', () => {
  it('succeeds with correct PIN + correct branch via home_branch_id, returning usable tokens', async () => {
    const { status, body } = await callPinLogin(branchHomeId, HOME_PIN);
    expect(status).toBe(200);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');

    // Prove the access_token is a REAL session for the correct barber, not a stub -- decode it
    // through auth.getUser() exactly as backend-schema 3.3 requires.
    const asBarber = createClient<Database>(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    const { data: userData, error: userError } = await asBarber.auth.getUser(body.access_token);
    expect(userError).toBeNull();
    expect(userData.user?.id).toBe(barberHomeAuthUserId);
    expect(userData.user?.email).toBe(barberHomeEmail);
  });

  it('succeeds with correct PIN + correct branch via staff_branch_assignments, not home_branch_id', async () => {
    const { status, body } = await callPinLogin(branchAssignedId, ASSIGNED_PIN);
    expect(status).toBe(200);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
  });

  it('fails with correct PIN but WRONG branch', async () => {
    // barberHome's PIN is valid, but barberHome has no relationship to branchAssignedId.
    const { status, body } = await callPinLogin(branchAssignedId, HOME_PIN);
    expect(status).toBe(401);
    expect(body.access_token).toBeUndefined();
  });

  it('fails with a wrong PIN', async () => {
    const { status, body } = await callPinLogin(branchHomeId, WRONG_PIN);
    expect(status).toBe(401);
    expect(body.access_token).toBeUndefined();
  });

  it('never matches a non-barber staff_user PIN, even with a matching branch assignment', async () => {
    const { status, body } = await callPinLogin(branchHomeId, RECEPTIONIST_PIN);
    expect(status).toBe(401);
    expect(body.access_token).toBeUndefined();
  });
});
