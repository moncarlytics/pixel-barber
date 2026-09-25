// tests/db/staff-manage.test.ts
// @vitest-environment node
// staff-manage Edge Function (deployed): Owner-only resend/revoke of pending invites and
// deactivate/reactivate of accepted accounts, with state checks and no self-deactivation.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  callFunction,
  cleanupStaffInviteFixture,
  createStaffAccount,
  createStaffInviteFixture,
  daysFromNow,
  hashToken,
  setInviteToken,
  signIn,
  trackStaff,
  type StaffAccount,
  type StaffInviteFixture,
} from './fixtures/staff-invite';

let f: StaffInviteFixture;
let pending: StaffAccount;
let toRevoke: StaffAccount;
let active: StaffAccount;
const knownToken = () => `tok-manage-${f.suffix}`;

beforeAll(async () => {
  f = await createStaffInviteFixture();
  pending = await createStaffAccount(f, {
    label: 'mpending',
    role: 'receptionist',
    inviteStatus: 'pending',
    branchId: f.branchId,
  });
  await setInviteToken(f, pending.staffUserId, knownToken(), daysFromNow(1));
  toRevoke = await createStaffAccount(f, {
    label: 'mrevoke',
    role: 'analyst',
    inviteStatus: 'pending',
  });
  await setInviteToken(f, toRevoke.staffUserId, `tok-revoke-${f.suffix}`, daysFromNow(7));
  active = await createStaffAccount(f, {
    label: 'mactive',
    role: 'barber',
    inviteStatus: 'accepted',
  });
}, 60000);

afterAll(async () => {
  await cleanupStaffInviteFixture(f);
}, 60000);

function manage(action: string, staffUserId: string, token = f.owner.accessToken) {
  return callFunction('staff-manage', { action, staff_user_id: staffUserId }, token);
}

async function readInvite(staffUserId: string) {
  const { data } = await f.admin
    .from('staff_users')
    .select('invite_status, invite_token_hash, invite_expires_at, is_active')
    .eq('id', staffUserId)
    .single();
  return data!;
}

describe('staff-manage', () => {
  it('refuses a Branch Manager', async () => {
    expect((await manage('revoke', pending.staffUserId, f.manager.accessToken)).status).toBe(403);
  });

  it('rejects an unknown action and an unknown staff user', async () => {
    expect((await manage('promote', pending.staffUserId)).status).toBe(400);
    expect((await manage('revoke', '00000000-0000-0000-0000-000000000000')).status).toBe(404);
  });

  it('resends a pending invite with a new token and a fresh 7-day expiry', async () => {
    const result = await manage('resend', pending.staffUserId);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ delivered: false, reason: 'undeliverable_test_address' });
    const row = await readInvite(pending.staffUserId);
    expect(row.invite_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.invite_token_hash).not.toBe(hashToken(knownToken()));
    const expiresInDays = (new Date(row.invite_expires_at!).getTime() - Date.now()) / 86_400_000;
    expect(expiresInDays).toBeGreaterThan(6.99);
  });

  it('refuses to resend or revoke an accepted account', async () => {
    expect((await manage('resend', active.staffUserId)).status).toBe(409);
    expect((await manage('revoke', active.staffUserId)).status).toBe(409);
  });

  it('revokes a pending invite by hard-deleting the never-accepted account, and only once', async () => {
    expect((await manage('revoke', toRevoke.staffUserId)).status).toBe(200);

    const { data: staffRow } = await f.admin
      .from('staff_users')
      .select('id')
      .eq('id', toRevoke.staffUserId)
      .maybeSingle();
    expect(staffRow).toBeNull();

    const { data: authUserData, error: authUserError } = await f.admin.auth.admin.getUserById(
      toRevoke.authUserId,
    );
    expect(authUserData?.user ?? null).toBeNull();
    expect(authUserError).not.toBeNull();

    // The row is gone, so a second revoke of the same id can't find it -- 404, not 409.
    expect((await manage('revoke', toRevoke.staffUserId)).status).toBe(404);
  }, 30000);

  it('lets the same email be invited again after its pending invite was revoked', async () => {
    const result = await callFunction(
      'staff-invite',
      { name: 'SI Test Re-Invited', role: 'analyst', email: toRevoke.email },
      f.owner.accessToken,
    );
    expect(result.status).toBe(201);
    trackStaff(f, result.body.staff_user_id as string);
  });

  it('deactivates an account so it cannot sign in, takes its barber offline, and reactivates it', async () => {
    // Starts 'available' (not the fixture's default 'offline') so the post-deactivate check below
    // actually proves staff-manage reset it, rather than it having never changed.
    await f.admin
      .from('barbers')
      .update({ status: 'available' })
      .eq('staff_user_id', active.staffUserId);

    expect((await manage('deactivate', active.staffUserId)).status).toBe(200);
    expect((await readInvite(active.staffUserId)).is_active).toBe(false);
    await expect(signIn({ email: active.email })).rejects.toBeTruthy();
    expect((await manage('deactivate', active.staffUserId)).status).toBe(409);

    const { data: barberRow } = await f.admin
      .from('barbers')
      .select('status')
      .eq('staff_user_id', active.staffUserId)
      .single();
    expect(barberRow!.status).toBe('offline');

    expect((await manage('reactivate', active.staffUserId)).status).toBe(200);
    expect((await readInvite(active.staffUserId)).is_active).toBe(true);
    await expect(signIn({ email: active.email })).resolves.toBeTruthy();
    expect((await manage('reactivate', active.staffUserId)).status).toBe(409);
  }, 30000);

  it('refuses the Owner deactivating their own account', async () => {
    expect((await manage('deactivate', f.owner.staffUserId)).status).toBe(409);
  });
});
