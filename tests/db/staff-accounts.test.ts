// tests/db/staff-accounts.test.ts
// @vitest-environment node
// Staff invitation schema: list_staff_accounts derives each account's status for the Owner only;
// the invite token columns are never client-readable; find_eligible_barber skips deactivated
// barbers; the test-only token helper is refused for client roles.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupStaffInviteFixture,
  createStaffAccount,
  createStaffInviteFixture,
  daysFromNow,
  setInviteToken,
  type StaffAccount,
  type StaffInviteFixture,
} from './fixtures/staff-invite';

let f: StaffInviteFixture;
let pending: StaffAccount;
let expired: StaffAccount;
let revoked: StaffAccount;
let active: StaffAccount;
let deactivated: StaffAccount;
let assignable: StaffAccount;

beforeAll(async () => {
  f = await createStaffInviteFixture();
  pending = await createStaffAccount(f, {
    label: 'pending',
    role: 'receptionist',
    inviteStatus: 'pending',
    branchId: f.branchId,
  });
  await setInviteToken(f, pending.staffUserId, `tok-pending-${f.suffix}`, daysFromNow(7));
  expired = await createStaffAccount(f, {
    label: 'expired',
    role: 'analyst',
    inviteStatus: 'pending',
  });
  await setInviteToken(f, expired.staffUserId, `tok-expired-${f.suffix}`, daysFromNow(-1));
  revoked = await createStaffAccount(f, {
    label: 'revoked',
    role: 'receptionist',
    inviteStatus: 'revoked',
    branchId: f.branchId,
  });
  active = await createStaffAccount(f, {
    label: 'active',
    role: 'barber',
    inviteStatus: 'accepted',
  });
  deactivated = await createStaffAccount(f, {
    label: 'deactivated',
    role: 'receptionist',
    inviteStatus: 'accepted',
    isActive: false,
    branchId: f.branchId,
  });
  assignable = await createStaffAccount(f, {
    label: 'assignable',
    role: 'barber',
    inviteStatus: 'accepted',
  });
}, 60000);

afterAll(async () => {
  await cleanupStaffInviteFixture(f);
}, 60000);

describe('list_staff_accounts', () => {
  it('gives the Owner every account with its derived status and branch', async () => {
    const { data, error } = await f.owner.client.rpc('list_staff_accounts');
    expect(error).toBeNull();
    const byId = new Map((data ?? []).map((r) => [r.staff_user_id, r]));
    expect(byId.get(pending.staffUserId)?.status).toBe('invite_pending');
    expect(byId.get(expired.staffUserId)?.status).toBe('invite_expired');
    expect(byId.get(revoked.staffUserId)?.status).toBe('revoked');
    expect(byId.get(active.staffUserId)?.status).toBe('active');
    expect(byId.get(deactivated.staffUserId)?.status).toBe('deactivated');

    expect(byId.get(active.staffUserId)?.branch_id).toBe(f.branchId);
    expect(byId.get(active.staffUserId)?.branch_name).toBe(f.branchName);
    expect(byId.get(pending.staffUserId)?.branch_id).toBe(f.branchId);
    expect(byId.get(expired.staffUserId)?.branch_id).toBeNull();

    expect(byId.get(f.owner.staffUserId)?.is_self).toBe(true);
    expect(byId.get(pending.staffUserId)?.is_self).toBe(false);
  });

  it('returns nothing to a Branch Manager or a customer', async () => {
    const { data: managerRows } = await f.manager.client.rpc('list_staff_accounts');
    expect(managerRows ?? []).toHaveLength(0);
    const { data: customerRows } = await f.customer.client.rpc('list_staff_accounts');
    expect(customerRows ?? []).toHaveLength(0);
  });
});

describe('invite token columns', () => {
  it('are not readable by a signed-in staff session, even on their own row', async () => {
    const { data: hashData, error: hashError } = await f.owner.client
      .from('staff_users')
      .select('invite_token_hash')
      .eq('id', f.owner.staffUserId);
    expect(hashError).not.toBeNull();
    expect(hashData).toBeNull();
    const { data: expData, error: expError } = await f.owner.client
      .from('staff_users')
      .select('invite_expires_at')
      .eq('id', f.owner.staffUserId);
    expect(expError).not.toBeNull();
    expect(expData).toBeNull();
  });

  it('refuses the test-only token helper for client roles', async () => {
    const { error } = await f.owner.client.rpc(
      'test_set_staff_invite_token' as never,
      {
        p_staff_user_id: pending.staffUserId,
        p_token: 'nope',
        p_expires_at: daysFromNow(1),
      } as never,
    );
    expect(error).not.toBeNull();
  });
});

describe('find_eligible_barber and deactivated staff', () => {
  it('stops offering a barber once their account is deactivated', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await f.admin.from('barbers').update({ status: 'available' }).eq('id', assignable.barberId!);
    await f.admin
      .from('barber_skills')
      .insert({ barber_id: assignable.barberId!, service_id: f.serviceId });
    await f.admin.from('barber_schedule').insert({
      barber_id: assignable.barberId!,
      work_date: today,
      branch_id: f.branchId,
      shift_start: '00:00',
      shift_end: '23:59:59',
    });
    const args = {
      p_branch_id: f.branchId,
      p_branch_service_id: f.branchServiceId,
      p_preferred_barber_id: assignable.barberId!,
    };

    const { data: before, error: beforeError } = await f.admin.rpc('find_eligible_barber', args);
    expect(beforeError).toBeNull();
    expect(before![0].preferred_eligible).toBe(true);
    expect(before![0].fallback_barber_id).toBe(assignable.barberId);

    await f.admin.from('staff_users').update({ is_active: false }).eq('id', assignable.staffUserId);
    const { data: after, error: afterError } = await f.admin.rpc('find_eligible_barber', args);
    expect(afterError).toBeNull();
    expect(after![0].preferred_eligible).toBe(false);
    expect(after![0].preferred_scheduled_today).toBe(false);
    expect(after![0].fallback_barber_id).toBeNull();
  });
});
