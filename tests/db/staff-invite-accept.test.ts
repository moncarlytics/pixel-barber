// tests/db/staff-invite-accept.test.ts
// @vitest-environment node
// staff-invite-accept Edge Function (deployed, public): preview shows who the invite is for, or one
// generic "not valid" answer; accept sets the password, activates the account, and the link can't
// be used twice.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  callFunction,
  cleanupStaffInviteFixture,
  createStaffAccount,
  createStaffInviteFixture,
  daysFromNow,
  setInviteToken,
  signIn,
  type StaffAccount,
  type StaffInviteFixture,
} from './fixtures/staff-invite';

let f: StaffInviteFixture;
let receptionist: StaffAccount;
let analyst: StaffAccount;
let expired: StaffAccount;
let revoked: StaffAccount;
const token = (label: string) => `tok-accept-${label}-${f.suffix}`;
const NEW_PASSWORD = 'Brand-New-Pass-9';

beforeAll(async () => {
  f = await createStaffInviteFixture();
  receptionist = await createStaffAccount(f, {
    label: 'arec',
    role: 'receptionist',
    inviteStatus: 'pending',
    branchId: f.branchId,
  });
  await setInviteToken(f, receptionist.staffUserId, token('rec'), daysFromNow(7));
  analyst = await createStaffAccount(f, {
    label: 'aana',
    role: 'analyst',
    inviteStatus: 'pending',
  });
  await setInviteToken(f, analyst.staffUserId, token('ana'), daysFromNow(7));
  expired = await createStaffAccount(f, {
    label: 'aexp',
    role: 'analyst',
    inviteStatus: 'pending',
  });
  await setInviteToken(f, expired.staffUserId, token('exp'), daysFromNow(-1));
  revoked = await createStaffAccount(f, {
    label: 'arev',
    role: 'analyst',
    inviteStatus: 'revoked',
  });
  await setInviteToken(f, revoked.staffUserId, token('rev'), daysFromNow(7));
}, 60000);

afterAll(async () => {
  await cleanupStaffInviteFixture(f);
}, 60000);

const accept = (body: Record<string, unknown>) => callFunction('staff-invite-accept', body);

describe('staff-invite-accept preview', () => {
  it('shows name, role and branch for a valid invite', async () => {
    const r = await accept({ token: token('rec'), mode: 'preview' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      valid: true,
      name: `SI Test arec ${f.suffix}`,
      role: 'receptionist',
      branch_name: f.branchName,
    });
  });

  it('shows no branch for a business-wide role', async () => {
    const r = await accept({ token: token('ana'), mode: 'preview' });
    expect(r.body).toMatchObject({ valid: true, role: 'analyst', branch_name: null });
  });

  it('gives one generic answer for unknown, expired and revoked links', async () => {
    for (const t of ['no-such-token', token('exp'), token('rev')]) {
      const r = await accept({ token: t, mode: 'preview' });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ valid: false });
    }
  });

  it('rejects a request without a token or mode', async () => {
    expect((await accept({ mode: 'preview' })).status).toBe(400);
    expect((await accept({ token: token('rec') })).status).toBe(400);
  });
});

describe('staff-invite-accept accept', () => {
  it('refuses a short password', async () => {
    const r = await accept({ token: token('rec'), mode: 'accept', password: 'short' });
    expect(r.status).toBe(400);
  });

  it('sets the password, activates the account, and refuses a second use', async () => {
    const r = await accept({ token: token('rec'), mode: 'accept', password: NEW_PASSWORD });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ login: { email: receptionist.email } });

    const { data: row } = await f.admin
      .from('staff_users')
      .select('invite_status, invite_accepted_at, invite_token_hash, invite_expires_at')
      .eq('id', receptionist.staffUserId)
      .single();
    expect(row!.invite_status).toBe('accepted');
    expect(row!.invite_accepted_at).not.toBeNull();
    expect(row!.invite_token_hash).toBeNull();
    expect(row!.invite_expires_at).toBeNull();

    await expect(signIn({ email: receptionist.email }, NEW_PASSWORD)).resolves.toBeTruthy();

    const again = await accept({ token: token('rec'), mode: 'accept', password: NEW_PASSWORD });
    expect(again.status).toBe(410);
    expect(again.body).toEqual({ valid: false });
  });

  it('refuses to accept an expired link', async () => {
    const r = await accept({ token: token('exp'), mode: 'accept', password: NEW_PASSWORD });
    expect(r.status).toBe(410);
  });
});
