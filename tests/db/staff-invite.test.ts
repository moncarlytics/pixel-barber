// tests/db/staff-invite.test.ts
// @vitest-environment node
// staff-invite Edge Function (deployed): Owner-only; creates the login, a pending staff_users row
// with a hashed 7-day token, and the barber row or branch assignment per role; refuses duplicate
// contacts; never delivers to .local test addresses.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  callFunction,
  cleanupStaffInviteFixture,
  createStaffInviteFixture,
  trackStaff,
  type StaffInviteFixture,
} from './fixtures/staff-invite';

let f: StaffInviteFixture;

beforeAll(async () => {
  f = await createStaffInviteFixture();
}, 60000);

afterAll(async () => {
  await cleanupStaffInviteFixture(f);
}, 60000);

function inviteEmail(label: string) {
  return `si-invite-${label}-${f.suffix}@test.pixelbarber.local`;
}

async function invite(body: Record<string, unknown>, token = f.owner.accessToken) {
  const result = await callFunction('staff-invite', body, token);
  if (result.status === 201) trackStaff(f, result.body.staff_user_id as string);
  return result;
}

describe('staff-invite', () => {
  it('refuses callers who are not the Owner', async () => {
    const body = {
      name: 'X',
      role: 'barber',
      branch_id: f.branchId,
      email: inviteEmail('refused'),
    };
    expect((await invite(body, f.manager.accessToken)).status).toBe(403);
    expect((await invite(body, f.customer.accessToken)).status).toBe(403);
    expect((await callFunction('staff-invite', body)).status).toBe(401);
  });

  it('invites a barber by email: pending row, hashed 7-day token, barber row, no assignment', async () => {
    const email = inviteEmail('barber');
    const result = await invite({
      name: 'Kofi Barber',
      role: 'barber',
      branch_id: f.branchId,
      email,
    });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      channel: 'email',
      delivered: false,
      reason: 'undeliverable_test_address',
    });
    const staffUserId = result.body.staff_user_id as string;

    const { data: row } = await f.admin
      .from('staff_users')
      .select(
        'email, role, invite_status, invited_by_staff_id, invite_token_hash, invite_expires_at, is_active',
      )
      .eq('id', staffUserId)
      .single();
    expect(row).toMatchObject({
      email,
      role: 'barber',
      invite_status: 'pending',
      invited_by_staff_id: f.owner.staffUserId,
      is_active: true,
    });
    expect(row!.invite_token_hash).toMatch(/^[0-9a-f]{64}$/);
    const expiresInDays = (new Date(row!.invite_expires_at!).getTime() - Date.now()) / 86_400_000;
    expect(expiresInDays).toBeGreaterThan(6.99);
    expect(expiresInDays).toBeLessThan(7.01);

    const { data: barber } = await f.admin
      .from('barbers')
      .select('home_branch_id, status')
      .eq('staff_user_id', staffUserId)
      .single();
    expect(barber).toEqual({ home_branch_id: f.branchId, status: 'offline' });
    const { data: assignments } = await f.admin
      .from('staff_branch_assignments')
      .select('branch_id')
      .eq('staff_user_id', staffUserId);
    expect(assignments ?? []).toHaveLength(0);
  });

  it('gives a receptionist one branch assignment and an analyst none', async () => {
    const receptionist = await invite({
      name: 'Ama Front',
      role: 'receptionist',
      branch_id: f.branchId,
      email: inviteEmail('receptionist'),
    });
    expect(receptionist.status).toBe(201);
    const { data: recAssignments } = await f.admin
      .from('staff_branch_assignments')
      .select('branch_id')
      .eq('staff_user_id', receptionist.body.staff_user_id as string);
    expect(recAssignments).toEqual([{ branch_id: f.branchId }]);

    const analyst = await invite({
      name: 'Esi Numbers',
      role: 'analyst',
      branch_id: f.branchId,
      email: inviteEmail('analyst'),
    });
    expect(analyst.status).toBe(201);
    const { data: anaAssignments } = await f.admin
      .from('staff_branch_assignments')
      .select('branch_id')
      .eq('staff_user_id', analyst.body.staff_user_id as string);
    expect(anaAssignments ?? []).toHaveLength(0);
  });

  it('rejects invalid requests with 400', async () => {
    expect(
      (await invite({ name: 'No Branch', role: 'barber', email: inviteEmail('nobranch') })).status,
    ).toBe(400);
    expect(
      (
        await invite({
          name: 'Bad Branch',
          role: 'barber',
          branch_id: '00000000-0000-0000-0000-000000000000',
          email: inviteEmail('badbranch'),
        })
      ).status,
    ).toBe(400);
    expect((await invite({ name: 'Bad Phone', role: 'analyst', phone: '123' })).status).toBe(400);
  });

  it('refuses a contact already used by a staff account or any login', async () => {
    const email = inviteEmail('dupe');
    const first = await invite({ name: 'First', role: 'analyst', email });
    expect(first.status).toBe(201);
    const second = await invite({ name: 'Second', role: 'analyst', email });
    expect(second.status).toBe(409);

    // A login with no staff_users row (e.g. some other account) also blocks the contact.
    const bareEmail = inviteEmail('bare');
    const { data: bare } = await f.admin.auth.admin.createUser({
      email: bareEmail,
      email_confirm: true,
    });
    f.createdAuthUserIds.push(bare!.user.id);
    expect((await invite({ name: 'Bare', role: 'analyst', email: bareEmail })).status).toBe(409);
  });
});
