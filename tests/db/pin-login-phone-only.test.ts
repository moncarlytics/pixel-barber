// tests/db/pin-login-phone-only.test.ts
// @vitest-environment node
// An SMS-invited barber has a phone login with no real email. pin-login mints sessions through an
// email magiclink, so phone invites also give the login a hidden, undeliverable internal email
// (staff-<uuid>@staff.pixelbarber.invalid) and pin-login reads the email from the auth user rather
// than staff_users.email. This builds such a barber exactly the way staff-invite does (a real
// phone invite can't be sent from a test: it would text a real number) and logs in by PIN.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PASSWORD,
  callFunction,
  cleanupStaffInviteFixture,
  createStaffInviteFixture,
  trackStaff,
  type StaffInviteFixture,
} from './fixtures/staff-invite';

let f: StaffInviteFixture;
let staffUserId: string;
const PIN = '7391';

beforeAll(async () => {
  f = await createStaffInviteFixture();
  const phone = `+23320${f.suffix.slice(-7)}`;
  const { data: authUser, error: authError } = await f.admin.auth.admin.createUser({
    phone,
    phone_confirm: true,
    email: `staff-${randomUUID()}@staff.pixelbarber.invalid`,
    email_confirm: true,
    password: PASSWORD,
  });
  if (authError) throw authError;
  const { data: row, error } = await f.admin
    .from('staff_users')
    .insert({
      auth_user_id: authUser!.user.id,
      name: `SI Test phonebarber ${f.suffix}`,
      phone_e164: phone,
      role: 'barber',
      invite_status: 'accepted',
      invited_by_staff_id: f.owner.staffUserId,
    })
    .select('id')
    .single();
  if (error) throw error;
  staffUserId = row!.id;
  trackStaff(f, staffUserId);
  const { error: barberError } = await f.admin
    .from('barbers')
    .insert({ staff_user_id: staffUserId, home_branch_id: f.branchId, status: 'offline' });
  if (barberError) throw barberError;
  const { error: pinError } = await f.admin.rpc(
    'test_set_staff_pin_hash' as never,
    {
      p_staff_user_id: staffUserId,
      p_pin: PIN,
    } as never,
  );
  if (pinError) throw pinError;
}, 60000);

afterAll(async () => {
  await cleanupStaffInviteFixture(f);
}, 60000);

describe('pin-login for a phone-only barber', () => {
  it('mints a real session from the PIN', async () => {
    const result = await callFunction('pin-login', { branch_id: f.branchId, pin: PIN });
    expect(result.status).toBe(200);
    expect(typeof result.body.access_token).toBe('string');
    expect(typeof result.body.refresh_token).toBe('string');
  }, 30000);

  it('keeps the hidden email out of the staff record the Owner sees', async () => {
    const { data } = await f.owner.client.rpc('list_staff_accounts');
    const mine = (data ?? []).find((r) => r.staff_user_id === staffUserId);
    expect(mine?.email).toBeNull();
    expect(mine?.phone_e164).toMatch(/^\+23320\d{7}$/);
  });
});
