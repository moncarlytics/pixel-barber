// tests/db/staff-login-gate.test.ts
// @vitest-environment node
// Final-review fix wave (Docs/superpowers/plans/2026-09-25-staff-invitation/final-fix-brief.md):
//
// C1: custom_access_token_hook must refuse sign-in/refresh (Supabase's documented hook error
// shape) for ANY staff_users row that is not accepted+active -- a pending invitee's auth user
// never gets a password through the real invite flow, but if one were set directly (or the
// account is later deactivated), the account must still be unable to sign in as staff.
// I3: list_bookable_barbers (the RPC the customer/staff barber pickers now call instead of
// selecting from `barbers` directly) must only return accepted, active barbers at the branch.
// I4: find_eligible_barber and verify_barber_pin must skip a pending barber exactly as they
// already skip a deactivated one.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupStaffInviteFixture,
  createStaffAccount,
  createStaffInviteFixture,
  PASSWORD,
  signIn,
  type StaffInviteFixture,
} from './fixtures/staff-invite';

let f: StaffInviteFixture;

beforeAll(async () => {
  f = await createStaffInviteFixture();
}, 60000);

afterAll(async () => {
  await cleanupStaffInviteFixture(f);
}, 60000);

describe('custom_access_token_hook login gate', () => {
  it('refuses a pending invite even when its auth user has a password set directly', async () => {
    const pending = await createStaffAccount(f, {
      label: 'gate-pending',
      role: 'receptionist',
      inviteStatus: 'pending',
    });
    const { error: updateError } = await f.admin.auth.admin.updateUserById(pending.authUserId, {
      password: PASSWORD,
    });
    expect(updateError).toBeNull();
    await expect(signIn({ email: pending.email })).rejects.toBeTruthy();
  }, 30000);

  it('refuses an accepted account once it is deactivated, even with the correct password', async () => {
    const deactivated = await createStaffAccount(f, {
      label: 'gate-deactivated',
      role: 'receptionist',
      inviteStatus: 'accepted',
      isActive: false,
    });
    await expect(signIn({ email: deactivated.email })).rejects.toBeTruthy();
  });

  it('signs in an accepted, active account (control)', async () => {
    const active = await createStaffAccount(f, {
      label: 'gate-active',
      role: 'receptionist',
      inviteStatus: 'accepted',
    });
    await expect(signIn({ email: active.email })).resolves.toBeTruthy();
  });
});

describe('list_bookable_barbers', () => {
  it('lists an accepted, active barber but not a pending or deactivated one at the same branch', async () => {
    const listedActive = await createStaffAccount(f, {
      label: 'listed-active',
      role: 'barber',
      inviteStatus: 'accepted',
    });
    const listedPending = await createStaffAccount(f, {
      label: 'listed-pending',
      role: 'barber',
      inviteStatus: 'pending',
    });
    const listedDeactivated = await createStaffAccount(f, {
      label: 'listed-deactivated',
      role: 'barber',
      inviteStatus: 'accepted',
      isActive: false,
    });

    const { data, error } = await f.admin.rpc('list_bookable_barbers', {
      p_branch_id: f.branchId,
    });
    expect(error).toBeNull();
    const ids = (data ?? []).map((b) => b.id);
    expect(ids).toContain(listedActive.barberId);
    expect(ids).not.toContain(listedPending.barberId);
    expect(ids).not.toContain(listedDeactivated.barberId);
  }, 30000);
});

describe('find_eligible_barber skips a pending barber', () => {
  it('is neither preferred-eligible nor the fallback while the invite is pending', async () => {
    const pendingBarber = await createStaffAccount(f, {
      label: 'eligible-pending',
      role: 'barber',
      inviteStatus: 'pending',
    });
    const today = new Date().toISOString().slice(0, 10);
    await f.admin.from('barbers').update({ status: 'available' }).eq('id', pendingBarber.barberId!);
    await f.admin
      .from('barber_skills')
      .insert({ barber_id: pendingBarber.barberId!, service_id: f.serviceId });
    await f.admin.from('barber_schedule').insert({
      barber_id: pendingBarber.barberId!,
      work_date: today,
      branch_id: f.branchId,
      shift_start: '00:00',
      shift_end: '23:59:59',
    });

    const { data, error } = await f.admin.rpc('find_eligible_barber', {
      p_branch_id: f.branchId,
      p_branch_service_id: f.branchServiceId,
      p_preferred_barber_id: pendingBarber.barberId!,
    });
    expect(error).toBeNull();
    expect(data![0].preferred_eligible).toBe(false);
    expect(data![0].preferred_scheduled_today).toBe(false);
    expect(data![0].fallback_barber_id).toBeNull();
  }, 30000);
});

describe('verify_barber_pin skips a pending barber', () => {
  it('does not authenticate a pending barber even with the correct PIN', async () => {
    const pendingBarber = await createStaffAccount(f, {
      label: 'pin-pending',
      role: 'barber',
      inviteStatus: 'pending',
    });
    const pin = '9319';
    const { error: setPinError } = await f.admin.rpc('test_set_staff_pin_hash', {
      p_staff_user_id: pendingBarber.staffUserId,
      p_pin: pin,
    });
    expect(setPinError).toBeNull();

    const { data, error } = await f.admin.rpc('verify_barber_pin', {
      p_branch_id: f.branchId,
      p_pin: pin,
    });
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  }, 30000);
});
