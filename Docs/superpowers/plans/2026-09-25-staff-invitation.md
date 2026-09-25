# Staff Invitation & Account Deactivation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Owner invite staff of any role by SMS or email, let invitees set their own password
from a 7-day link and land signed in, and let the Owner resend/revoke invites and
deactivate/reactivate accounts.

**Architecture:** Invite state lives on `staff_users` (two new server-only columns: a SHA-256 token
hash and an expiry). Three service-role Edge Functions — `staff-invite`, `staff-manage` (Owner only)
and `staff-invite-accept` (public) — share pure logic in `_shared/staff-invite-core.ts` (token,
hashing, validation, message building, Arkesel/Resend delivery). The staff app gets a Staff & Roles
screen, a link-only Accept Invite page, and a login field that takes email or phone.
`find_eligible_barber` learns to skip deactivated barbers.

**Tech Stack:** PostgreSQL/PL-pgSQL + RLS (Supabase), Supabase Edge Functions (Deno,
`@supabase/supabase-js`), Arkesel SMS API, Resend email API, Next.js/React (staff app), `next-intl`,
Vitest (`tests/db/`, `tests/unit/`, `apps/**`), Playwright (`e2e/`).

**Spec:** `Docs/superpowers/specs/2026-09-25-staff-invitation-design.md`

## Corrections to the spec, found while writing this plan

1. **Accept claims the invite before setting the password.** The spec sets the password (step 3)
   and then marks the row accepted with a guarded `WHERE` (step 4). With two concurrent accepts,
   both would set a password and the loser's could overwrite the winner's. So `staff-invite-accept`
   first claims the row (conditional update `pending` + same hash → `accepted`, token cleared), and
   only the request that claimed it sets the password; if setting the password fails, the claim is
   reverted to exactly its prior state.
2. **An extra delivery reason, `sms_not_configured`,** for when the Arkesel secrets are missing
   (the spec listed only `email_not_configured`, `provider_error`, `undeliverable_test_address`).
3. **Two small, deliberate copies across the Deno bundle boundary:** `normalizeGhanaPhone` (from
   `packages/shared/src/phone.ts`) and `isArkeselSuccess` (from `supabase/functions/send-sms/index.ts`)
   are copied into `_shared/staff-invite-core.ts`. Edge Function bundles can't import from
   `packages/`, and `send-sms/index.ts` calls `Deno.serve` on import. Each copy is commented with
   its source.
4. **`find_eligible_barber`'s `preferred_scheduled_today` also requires an active barber** — otherwise
   a customer could be offered "wait for this barber" for someone who's been deactivated.
5. **Accept page wording** is "You've been invited to join Pixel Barber" + "Role: {role}" +
   "Branch: {branch}" lines, rather than "as a {role}", which reads wrongly for "Owner"/"Analyst".
6. **Server error text:** 403 and 409 responses map to translated strings; 400 validation messages
   from the server are shown inside a translated template ("Couldn't send the invite: {error}").

## Global Constraints

- Every new/modified `SECURITY DEFINER` function uses `set search_path = public, pg_temp`.
- `invite_token_hash` and `invite_expires_at` must **not** be added to the column-level client
  SELECT grant on `staff_users` (from `20260925100000_protect_staff_pin_hash_reads.sql`); no client
  role may read them.
- Only the Owner (`has_capability('manage_staff')`) can invite, resend, revoke, deactivate or
  reactivate. `staff-invite-accept` is the only public function (`verify_jwt = false`).
- Invite links are valid for **7 days**; tokens are 32 random bytes, base64url; only the hex SHA-256
  hash is stored; tokens are single-use and die on accept, resend, revoke or expiry.
- Minimum password length: **8**.
- Automated tests never send real SMS or email: test invites use `@test.pixelbarber.local` addresses,
  which `sendInvite` skips (`undeliverable_test_address`).
- Every new staff-facing string goes through `next-intl` (`t('key')`) with keys in
  `apps/staff/messages/en.json`. No hardcoded literals in JSX.
- Any `beforeAll`/`afterAll` hook doing more than 1–2 DB operations gets an explicit timeout (30000;
  60000 for fixtures that create several users). Test cleanup is FK-safe and deletes only what the
  test created.
- Already-applied migrations are never edited; every schema change is a new migration.
- `packages/shared/src/database.types.ts` is hand-maintained; new entries must match the SQL exactly.
- **Implementer subagents cannot push migrations, deploy Edge Functions, or set function secrets**
  (sandbox). The controller does these after the implementer commits, and runs the tests that need
  them GREEN afterwards. Controller commands:
  - migrations: `set -a && source supabase/.secrets/send-sms.env && set +a && npx supabase db push`
  - functions: `set -a && source supabase/.secrets/send-sms.env && set +a && npx supabase functions deploy <name>`
  - secrets (ask the user for values first): `npx supabase secrets set STAFF_APP_URL=<staff app origin>`,
    and optionally `RESEND_API_KEY=<key>` and `INVITE_EMAIL_FROM="Pixel Barber <no-reply@domain>"`.
    `STAFF_APP_URL` must be set before `staff-invite`/`staff-manage` resend tests run (use the
    user-provided value; `http://localhost:3001` is acceptable for development if they have none).
- Never add `Co-Authored-By` or any AI-attribution line to commits. Don't stage
  `apps/*/next-env.d.ts`, `graphify-out/`, `playwright-report/`, `test-results/`, or untracked
  `Docs/superpowers/plans/2026-09-1*` files.

---

### Task 1: Schema, staff list function, inactive-barber skip, and test fixture

**Files:**
- Create: `supabase/migrations/20260925110000_staff_invitations.sql`
- Create: `tests/db/fixtures/staff-invite.ts`
- Create: `tests/db/staff-accounts.test.ts`
- Modify: `packages/shared/src/database.types.ts`

**Interfaces:**
- Produces: columns `staff_users.invite_token_hash text null`, `staff_users.invite_expires_at
  timestamptz null`; function `list_staff_accounts()` returning rows `{ staff_user_id, name, role,
  email, phone_e164, branch_id, branch_name, status, invited_at, is_self }` where `status` ∈
  `'invite_pending' | 'invite_expired' | 'revoked' | 'active' | 'deactivated'`; service-role-only
  `test_set_staff_invite_token(p_staff_user_id uuid, p_token text, p_expires_at timestamptz)`.
- Produces (fixture, used by Tasks 3–5): `createStaffInviteFixture()`, `cleanupStaffInviteFixture(f)`,
  `createStaffAccount(f, opts)`, `setInviteToken(f, staffUserId, token, expiresAt)`,
  `trackStaff(f, staffUserId)`, `callFunction(name, body, accessToken?)`, `hashToken(token)`,
  `daysFromNow(n)`, `signIn(credentials, password?)`, `PASSWORD`, types `StaffInviteFixture`,
  `SignedInStaff`, `StaffAccount`.

- [ ] **Step 1: Write the shared fixture**

Create `tests/db/fixtures/staff-invite.ts`. It reads `process.env` inside functions (test files load
`.env.local` via `config()` at runtime, after ES imports are hoisted).

```typescript
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
  const { data, error } = await client.auth.signInWithPassword({ ...credentials, password } as never);
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
    .insert({ auth_user_id: customerAuth!.user.id, name: `SI Test Customer ${suffix}`, phone_e164: phone })
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
      .insert({ staff_user_id: row!.id, home_branch_id: opts.branchId ?? f.branchId, status: 'offline' })
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
  const { error } = await f.admin.rpc('test_set_staff_invite_token' as never, {
    p_staff_user_id: staffUserId,
    p_token: token,
    p_expires_at: expiresAt,
  } as never);
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
```

- [ ] **Step 2: Write the failing test**

Create `tests/db/staff-accounts.test.ts`:

```typescript
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
  expired = await createStaffAccount(f, { label: 'expired', role: 'analyst', inviteStatus: 'pending' });
  await setInviteToken(f, expired.staffUserId, `tok-expired-${f.suffix}`, daysFromNow(-1));
  revoked = await createStaffAccount(f, {
    label: 'revoked',
    role: 'receptionist',
    inviteStatus: 'revoked',
    branchId: f.branchId,
  });
  active = await createStaffAccount(f, { label: 'active', role: 'barber', inviteStatus: 'accepted' });
  deactivated = await createStaffAccount(f, {
    label: 'deactivated',
    role: 'receptionist',
    inviteStatus: 'accepted',
    isActive: false,
    branchId: f.branchId,
  });
  assignable = await createStaffAccount(f, { label: 'assignable', role: 'barber', inviteStatus: 'accepted' });
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
    const { error } = await f.owner.client.rpc('test_set_staff_invite_token' as never, {
      p_staff_user_id: pending.staffUserId,
      p_token: 'nope',
      p_expires_at: daysFromNow(1),
    } as never);
    expect(error).not.toBeNull();
  });
});

describe('find_eligible_barber and deactivated staff', () => {
  it('stops offering a barber once their account is deactivated', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await f.admin.from('barbers').update({ status: 'available' }).eq('id', assignable.barberId!);
    await f.admin.from('barber_skills').insert({ barber_id: assignable.barberId!, service_id: f.serviceId });
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
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm run test -- tests/db/staff-accounts.test.ts`
Expected: FAIL — `test_set_staff_invite_token` / `list_staff_accounts` don't exist yet (the
`beforeAll` throws on the helper call).

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/20260925110000_staff_invitations.sql`:

```sql
-- Staff invitation & deactivation (Docs/superpowers/specs/2026-09-25-staff-invitation-design.md).
-- Invite state stays on staff_users (backend-schema 3.4: an invite is a stage of a staff account,
-- not a separate entity). Adds the token hash + expiry, the Owner's staff list, the inactive-barber
-- skip in find_eligible_barber, and a service-role-only test helper.

alter table staff_users
  add column invite_token_hash text,
  add column invite_expires_at timestamptz;

-- The accept lookup is by hash; one live token per row, never shared between rows.
create unique index staff_users_invite_token_hash_key
  on staff_users (invite_token_hash) where invite_token_hash is not null;

-- NOTE: deliberately NOT added to the column-level client SELECT grant on staff_users
-- (20260925100000_protect_staff_pin_hash_reads.sql). Only service-role code reads these.

-- The Owner's Staff & Roles table. SECURITY DEFINER because the table needs values clients can't
-- read (the expiry, for the derived status) and branch names from two sources (barbers' home
-- branch vs everyone else's branch assignment). Returns rows only for manage_staff (the Owner).
create or replace function list_staff_accounts()
returns table (
  staff_user_id uuid,
  name text,
  role staff_role,
  email text,
  phone_e164 text,
  branch_id uuid,
  branch_name text,
  status text,
  invited_at timestamptz,
  is_self boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    su.id,
    su.name,
    su.role,
    su.email,
    su.phone_e164,
    coalesce(b.home_branch_id, sba.branch_id),
    br.name,
    case
      when su.invite_status = 'revoked' then 'revoked'
      when su.invite_status = 'expired' then 'invite_expired'
      when su.invite_status = 'pending' and su.invite_expires_at < now() then 'invite_expired'
      when su.invite_status = 'pending' then 'invite_pending'
      when not su.is_active then 'deactivated'
      else 'active'
    end,
    su.invited_at,
    su.id = auth_staff_id()
  from staff_users su
  left join barbers b on b.staff_user_id = su.id
  left join lateral (
    select a.branch_id from staff_branch_assignments a
    where a.staff_user_id = su.id
    order by a.branch_id
    limit 1
  ) sba on true
  left join branches br on br.id = coalesce(b.home_branch_id, sba.branch_id)
  where has_capability('manage_staff')
  order by su.name;
$$;

revoke execute on function list_staff_accounts() from public, anon;
grant execute on function list_staff_accounts() to authenticated, service_role;

-- find_eligible_barber: identical to 20260923090000_final_review_fixes.sql except that a barber
-- whose staff account is deactivated (staff_users.is_active = false) is never eligible, never the
-- fallback, and never offered as "scheduled later today".
create or replace function find_eligible_barber(
  p_branch_id uuid,
  p_branch_service_id uuid,
  p_preferred_barber_id uuid default null
)
returns table (
  preferred_eligible boolean,
  preferred_scheduled_today boolean,
  fallback_barber_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_service_id uuid;
begin
  select service_id into v_service_id
  from branch_services
  where id = p_branch_service_id and branch_id = p_branch_id;

  return query
  with eligible as (
    select b.id as barber_id
    from barbers b
    join staff_users su on su.id = b.staff_user_id and su.is_active
    join barber_skills bs on bs.barber_id = b.id and bs.service_id = v_service_id
    join barber_schedule sch on sch.barber_id = b.id
      and sch.work_date = current_date
      and sch.branch_id = p_branch_id
      and now()::time between sch.shift_start and sch.shift_end
    where b.status not in ('offline', 'end_of_shift', 'temporarily_unavailable')
  ),
  ranked as (
    select
      e.barber_id,
      (
        select count(*) from queue_tickets qt
        where qt.assigned_barber_id = e.barber_id
          and qt.branch_id = p_branch_id
          and qt.state in ('waiting', 'almost_turn', 'called', 'confirmed', 'in_service')
      ) as active_count
    from eligible e
  )
  select
    exists (select 1 from eligible where barber_id = p_preferred_barber_id),
    exists (
      select 1
      from barber_schedule sch
      join barber_skills bsk on bsk.barber_id = sch.barber_id and bsk.service_id = v_service_id
      join barbers pb on pb.id = sch.barber_id
      join staff_users psu on psu.id = pb.staff_user_id and psu.is_active
      where sch.barber_id = p_preferred_barber_id
        and sch.work_date = current_date
        and sch.branch_id = p_branch_id
        and sch.shift_end > now()::time
    ),
    (select barber_id from ranked order by active_count asc, barber_id asc limit 1);
end;
$$;

revoke execute on function find_eligible_barber(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function find_eligible_barber(uuid, uuid, uuid) to authenticated, service_role;

-- Test-only: set a KNOWN invite token so automated tests can open an invite link (the real token
-- only ever exists in the sent SMS/email). Same pattern as test_set_staff_pin_hash: service_role
-- only, never granted to clients. The hash must match _shared/staff-invite-core.ts
-- hashInviteToken(): hex SHA-256 of the token's UTF-8 bytes.
create or replace function test_set_staff_invite_token(
  p_staff_user_id uuid,
  p_token text,
  p_expires_at timestamptz
) returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update staff_users
  set invite_token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex'),
      invite_expires_at = p_expires_at
  where id = p_staff_user_id;
$$;

revoke execute on function test_set_staff_invite_token(uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function test_set_staff_invite_token(uuid, text, timestamptz) to service_role;
```

- [ ] **Step 5: Add the types**

Modify `packages/shared/src/database.types.ts`:

(a) In `staff_users`' `Row`, add (alphabetical among the existing keys — after `invite_accepted_at`
and after `invite_status` respectively):
```typescript
          invite_expires_at: string | null;
```
```typescript
          invite_token_hash: string | null;
```
In its `Insert` and `Update`, add the same two keys as optional: `invite_expires_at?: string | null;`
and `invite_token_hash?: string | null;`.

(b) In the `Functions` map, after `list_manageable_barbers`:
```typescript
      list_staff_accounts: {
        Args: never;
        Returns: {
          staff_user_id: string;
          name: string;
          role: Database['public']['Enums']['staff_role'];
          email: string | null;
          phone_e164: string | null;
          branch_id: string | null;
          branch_name: string | null;
          status: string;
          invited_at: string | null;
          is_self: boolean;
        }[];
      };
```
(`test_set_staff_invite_token` is deliberately not added, matching `test_set_staff_pin_hash`.)

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck` — Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260925110000_staff_invitations.sql tests/db/fixtures/staff-invite.ts tests/db/staff-accounts.test.ts packages/shared/src/database.types.ts
git commit -m "feat: add staff invite columns, Owner staff list, and inactive-barber skip"
```

- [ ] **Step 8 (controller): push and verify GREEN**

Controller pushes the migration, then runs
`npm run test -- tests/db/staff-accounts.test.ts tests/db/find-eligible-barber.test.ts tests/db/ticket-creation-barber-assignment.test.ts`
— Expected: all PASS (the last two prove the `find_eligible_barber` change broke nothing).

---

### Task 2: Shared invite logic (pure module + unit tests)

**Files:**
- Create: `supabase/functions/_shared/staff-invite-core.ts`
- Create: `tests/unit/staff-invite-core.test.ts`

**Interfaces:**
- Produces (all exported from `_shared/staff-invite-core.ts`, used by Tasks 3–5):
  `STAFF_ROLES`, `type StaffRole`, `BRANCH_ROLES`, `ROLE_LABELS`, `INVITE_VALID_DAYS = 7`,
  `MIN_PASSWORD_LENGTH = 8`, `CONTACT_IN_USE_MESSAGE`, `inviteExpiry(now?) => Date`,
  `generateInviteToken() => string`, `hashInviteToken(token) => Promise<string>`,
  `inviteLink(baseUrl, token) => string`, `normalizeGhanaPhone(input) => string | null`,
  `normalizeEmail(input) => string | null`, `type InviteRequest`,
  `parseInviteRequest(body) => { ok: true; value: InviteRequest } | { ok: false; error: string }`,
  `type InviteMessage`, `buildInviteMessage({ name, role, link }) => InviteMessage`,
  `type InviteDeliveryConfig`, `type DeliveryResult`, `type InviteTarget`,
  `isArkeselSuccess(httpOk, rawBody) => boolean`,
  `sendInvite(target, message, config, fetchImpl?) => Promise<DeliveryResult>`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/staff-invite-core.test.ts`:

```typescript
// tests/unit/staff-invite-core.test.ts
// @vitest-environment node
// Pure logic behind the staff invite Edge Functions: token format, hashing (must match the SQL
// test helper's encode(sha256(convert_to(token,'UTF8')),'hex')), request validation, message
// building, and SMS/email delivery with a stubbed fetch.
import { describe, expect, it, vi } from 'vitest';
import {
  buildInviteMessage,
  generateInviteToken,
  hashInviteToken,
  inviteExpiry,
  inviteLink,
  normalizeGhanaPhone,
  parseInviteRequest,
  sendInvite,
  type InviteMessage,
} from '../../supabase/functions/_shared/staff-invite-core';

const MESSAGE: InviteMessage = {
  sms: 'sms text',
  emailSubject: 'subject',
  emailText: 'text',
  emailHtml: '<p>html</p>',
};

function stubFetch(status: number, body: string) {
  return vi.fn(async () => new Response(body, { status }));
}

describe('tokens', () => {
  it('generates 43-character base64url tokens that differ each time', () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('hashes as hex SHA-256 of the UTF-8 bytes', async () => {
    expect(await hashInviteToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('builds the link without a doubled slash', () => {
    expect(inviteLink('https://staff.example.com/', 'tok')).toBe('https://staff.example.com/invite/tok');
    expect(inviteLink('http://localhost:3001', 'tok')).toBe('http://localhost:3001/invite/tok');
  });

  it('expires 7 days after now', () => {
    const now = new Date('2026-09-25T10:00:00Z');
    expect(inviteExpiry(now).toISOString()).toBe('2026-10-02T10:00:00.000Z');
  });
});

describe('normalizeGhanaPhone', () => {
  it('normalizes local and international formats and rejects others', () => {
    expect(normalizeGhanaPhone('024 412 3456')).toBe('+233244123456');
    expect(normalizeGhanaPhone('+233244123456')).toBe('+233244123456');
    expect(normalizeGhanaPhone('12345')).toBeNull();
  });
});

describe('parseInviteRequest', () => {
  const base = { name: 'Kofi', role: 'barber', branch_id: 'branch-1', email: 'Kofi@Example.com' };

  it('accepts a valid barber invite and normalizes the email', () => {
    const r = parseInviteRequest(base);
    expect(r).toEqual({
      ok: true,
      value: { name: 'Kofi', role: 'barber', branchId: 'branch-1', phone: null, email: 'kofi@example.com' },
    });
  });

  it('normalizes a phone number', () => {
    const r = parseInviteRequest({ name: 'Ama', role: 'receptionist', branch_id: 'b', phone: '0244123456' });
    expect(r.ok && r.value.phone).toBe('+233244123456');
  });

  it('drops the branch for business-wide roles', () => {
    const r = parseInviteRequest({ name: 'Esi', role: 'analyst', branch_id: 'b', email: 'e@x.com' });
    expect(r.ok && r.value.branchId).toBeNull();
  });

  it.each([
    [{ ...base, name: '  ' }, 'Name is required'],
    [{ ...base, role: 'janitor' }, 'Role is not valid'],
    [{ ...base, phone: '0244123456' }, 'Provide exactly one of phone or email'],
    [{ name: 'Kofi', role: 'barber', branch_id: 'b' }, 'Provide exactly one of phone or email'],
    [{ ...base, email: 'not-an-email' }, 'Email address is not valid'],
    [{ name: 'Kofi', role: 'barber', branch_id: 'b', phone: '123' }, 'Phone number is not a valid Ghana number'],
    [{ name: 'Kofi', role: 'barber', email: 'k@x.com' }, 'A branch is required for this role'],
  ])('rejects %j', (body, error) => {
    expect(parseInviteRequest(body)).toEqual({ ok: false, error });
  });
});

describe('buildInviteMessage', () => {
  it('includes the link and role label, and escapes the name in HTML', () => {
    const m = buildInviteMessage({ name: 'Kofi <b>', role: 'branch_manager', link: 'https://x/invite/t' });
    expect(m.sms).toContain('https://x/invite/t');
    expect(m.sms).toContain('Branch Manager');
    expect(m.emailText).toContain('https://x/invite/t');
    expect(m.emailHtml).toContain('Kofi &lt;b&gt;');
    expect(m.emailHtml).not.toContain('Kofi <b>');
  });
});

describe('sendInvite', () => {
  const config = {
    arkeselApiKey: 'ak',
    arkeselSenderId: 'PixelBarbr',
    resendApiKey: 'rk',
    emailFrom: 'Pixel Barber <no-reply@x.com>',
  };

  it('skips reserved .local test addresses without calling out', async () => {
    const fetchImpl = stubFetch(200, '{}');
    const r = await sendInvite({ email: 'a@test.pixelbarber.local' }, MESSAGE, config, fetchImpl);
    expect(r).toEqual({ delivered: false, reason: 'undeliverable_test_address' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports email_not_configured without a Resend key', async () => {
    const r = await sendInvite(
      { email: 'a@x.com' },
      MESSAGE,
      { ...config, resendApiKey: undefined },
      stubFetch(200, '{}'),
    );
    expect(r).toEqual({ delivered: false, reason: 'email_not_configured' });
  });

  it('sends email through Resend', async () => {
    const fetchImpl = stubFetch(200, '{"id":"e1"}');
    const r = await sendInvite({ email: 'a@x.com' }, MESSAGE, config, fetchImpl);
    expect(r).toEqual({ delivered: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer rk');
    expect(JSON.parse(init.body as string)).toMatchObject({ to: ['a@x.com'], subject: 'subject' });
  });

  it('reports provider_error when Resend fails', async () => {
    const r = await sendInvite({ email: 'a@x.com' }, MESSAGE, config, stubFetch(500, 'boom'));
    expect(r).toEqual({ delivered: false, reason: 'provider_error' });
  });

  it('reports sms_not_configured without Arkesel secrets', async () => {
    const r = await sendInvite(
      { phone: '+233244123456' },
      MESSAGE,
      { ...config, arkeselApiKey: undefined },
      stubFetch(200, '{}'),
    );
    expect(r).toEqual({ delivered: false, reason: 'sms_not_configured' });
  });

  it('sends SMS through Arkesel', async () => {
    const fetchImpl = stubFetch(200, '{"status":"success","data":[]}');
    const r = await sendInvite({ phone: '+233244123456' }, MESSAGE, config, fetchImpl);
    expect(r).toEqual({ delivered: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://sms.arkesel.com/api/v2/sms/send');
    expect(JSON.parse(init.body as string)).toMatchObject({
      sender: 'PixelBarbr',
      message: 'sms text',
      recipients: ['+233244123456'],
    });
  });

  it('reports provider_error when Arkesel says so or the call throws', async () => {
    expect(
      await sendInvite({ phone: '+233244123456' }, MESSAGE, config, stubFetch(200, '{"status":"error"}')),
    ).toEqual({ delivered: false, reason: 'provider_error' });
    const throwing = vi.fn(async () => {
      throw new Error('network');
    });
    expect(await sendInvite({ phone: '+233244123456' }, MESSAGE, config, throwing)).toEqual({
      delivered: false,
      reason: 'provider_error',
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- tests/unit/staff-invite-core.test.ts`
Expected: FAIL — cannot resolve `../../supabase/functions/_shared/staff-invite-core`.

- [ ] **Step 3: Write the module**

Create `supabase/functions/_shared/staff-invite-core.ts`:

```typescript
// supabase/functions/_shared/staff-invite-core.ts
// Pure logic shared by the staff-invite, staff-manage and staff-invite-accept Edge Functions.
// No Deno APIs and no imports, so Vitest can import it directly
// (tests/unit/staff-invite-core.test.ts). Deno-only glue (env, clients) lives in the functions and
// in _shared/staff-auth.ts / _shared/staff-invite-env.ts.

export const STAFF_ROLES = ['owner', 'branch_manager', 'receptionist', 'barber', 'analyst'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** Roles tied to one branch: barbers (home branch) and branch_manager/receptionist (assignment). */
export const BRANCH_ROLES: readonly StaffRole[] = ['barber', 'branch_manager', 'receptionist'];

export const ROLE_LABELS: Record<StaffRole, string> = {
  owner: 'Owner',
  branch_manager: 'Branch Manager',
  receptionist: 'Receptionist',
  barber: 'Barber',
  analyst: 'Analyst',
};

export const INVITE_VALID_DAYS = 7;
export const MIN_PASSWORD_LENGTH = 8;
export const CONTACT_IN_USE_MESSAGE = 'That phone number or email is already used by an account';

export function inviteExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + INVITE_VALID_DAYS * 24 * 60 * 60 * 1000);
}

/** 32 random bytes as unpadded base64url (43 characters, 256 bits). */
export function generateInviteToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Hex SHA-256 of the token's UTF-8 bytes — the only form ever stored. */
export async function hashInviteToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function inviteLink(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/invite/${token}`;
}

// Copy of packages/shared/src/phone.ts normalizeGhanaPhone -- Edge Function bundles can't import
// from packages/. Keep the two in sync.
export function normalizeGhanaPhone(input: string): string | null {
  const digitsOnly = input.replace(/[\s-]/g, '');
  if (/^\+233\d{9}$/.test(digitsOnly)) return digitsOnly;
  if (/^0\d{9}$/.test(digitsOnly)) return `+233${digitsOnly.slice(1)}`;
  return null;
}

export function normalizeEmail(input: string): string | null {
  const email = input.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export interface InviteRequest {
  name: string;
  role: StaffRole;
  branchId: string | null;
  phone: string | null;
  email: string | null;
}

export function parseInviteRequest(
  body: unknown,
): { ok: true; value: InviteRequest } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (typeof body !== 'object' || body === null) return fail('Invalid request body');
  const b = body as Record<string, unknown>;

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return fail('Name is required');

  const role = b.role;
  if (typeof role !== 'string' || !(STAFF_ROLES as readonly string[]).includes(role)) {
    return fail('Role is not valid');
  }

  const hasPhone = typeof b.phone === 'string' && b.phone.trim() !== '';
  const hasEmail = typeof b.email === 'string' && b.email.trim() !== '';
  if (hasPhone === hasEmail) return fail('Provide exactly one of phone or email');

  let phone: string | null = null;
  let email: string | null = null;
  if (hasPhone) {
    phone = normalizeGhanaPhone(b.phone as string);
    if (!phone) return fail('Phone number is not a valid Ghana number');
  } else {
    email = normalizeEmail(b.email as string);
    if (!email) return fail('Email address is not valid');
  }

  const needsBranch = BRANCH_ROLES.includes(role as StaffRole);
  const branchId = typeof b.branch_id === 'string' && b.branch_id !== '' ? b.branch_id : null;
  if (needsBranch && !branchId) return fail('A branch is required for this role');

  return {
    ok: true,
    value: { name, role: role as StaffRole, branchId: needsBranch ? branchId : null, phone, email },
  };
}

export interface InviteMessage {
  sms: string;
  emailSubject: string;
  emailText: string;
  emailHtml: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildInviteMessage(input: { name: string; role: StaffRole; link: string }): InviteMessage {
  const roleLabel = ROLE_LABELS[input.role];
  const firstName = input.name.split(/\s+/)[0];
  const sms =
    `Hi ${firstName}, you've been invited to Pixel Barber as ${roleLabel}. ` +
    `Set your password: ${input.link} (valid ${INVITE_VALID_DAYS} days)`;
  const emailText =
    `Hi ${input.name},\n\nYou've been invited to join Pixel Barber as ${roleLabel}.\n\n` +
    `Set your password here: ${input.link}\n\nThis link is valid for ${INVITE_VALID_DAYS} days.`;
  const emailHtml =
    `<p>Hi ${escapeHtml(input.name)},</p>` +
    `<p>You've been invited to join Pixel Barber as ${escapeHtml(roleLabel)}.</p>` +
    `<p><a href="${escapeHtml(input.link)}">Set your password</a></p>` +
    `<p>This link is valid for ${INVITE_VALID_DAYS} days.</p>`;
  return { sms, emailSubject: "You're invited to Pixel Barber", emailText, emailHtml };
}

export interface InviteDeliveryConfig {
  arkeselApiKey?: string;
  arkeselSenderId?: string;
  resendApiKey?: string;
  emailFrom?: string;
}

export type DeliveryFailureReason =
  | 'undeliverable_test_address'
  | 'email_not_configured'
  | 'sms_not_configured'
  | 'provider_error';

export type DeliveryResult = { delivered: true } | { delivered: false; reason: DeliveryFailureReason };

export type InviteTarget = { phone: string } | { email: string };

// Copy of supabase/functions/send-sms/index.ts isArkeselSuccess (that module calls Deno.serve on
// import, so it can't be imported here). Arkesel's confirmed v2 success shape is
// { status: "success", data: {...} }: a non-2xx is always a failure, and a 2xx body that explicitly
// says status !== "success" is also a failure; anything else 2xx is treated as success.
export function isArkeselSuccess(httpOk: boolean, rawBody: string): boolean {
  if (!httpOk) return false;
  try {
    const parsed = JSON.parse(rawBody) as { status?: string };
    if (parsed.status === undefined) return true;
    return parsed.status === 'success';
  } catch {
    return true;
  }
}

/**
 * Sends the invite by SMS (Arkesel) or email (Resend). Never throws.
 * Email addresses ending in ".local" are reserved and never deliverable -- automated tests use
 * them, so they are skipped rather than sent (and bounced) through Resend.
 */
export async function sendInvite(
  target: InviteTarget,
  message: InviteMessage,
  config: InviteDeliveryConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryResult> {
  try {
    if ('email' in target) {
      if (target.email.endsWith('.local')) {
        return { delivered: false, reason: 'undeliverable_test_address' };
      }
      if (!config.resendApiKey || !config.emailFrom) {
        return { delivered: false, reason: 'email_not_configured' };
      }
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: config.emailFrom,
          to: [target.email],
          subject: message.emailSubject,
          text: message.emailText,
          html: message.emailHtml,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok ? { delivered: true } : { delivered: false, reason: 'provider_error' };
    }

    if (!config.arkeselApiKey || !config.arkeselSenderId) {
      return { delivered: false, reason: 'sms_not_configured' };
    }
    const response = await fetchImpl('https://sms.arkesel.com/api/v2/sms/send', {
      method: 'POST',
      headers: { 'api-key': config.arkeselApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: config.arkeselSenderId,
        message: message.sms,
        recipients: [target.phone],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const rawBody = await response.text();
    return isArkeselSuccess(response.ok, rawBody)
      ? { delivered: true }
      : { delivered: false, reason: 'provider_error' };
  } catch {
    return { delivered: false, reason: 'provider_error' };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- tests/unit/staff-invite-core.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/staff-invite-core.ts tests/unit/staff-invite-core.test.ts
git commit -m "feat: add shared staff invite token, validation and delivery logic"
```

---

### Task 3: The `staff-invite` Edge Function

**Files:**
- Create: `supabase/functions/_shared/http.ts`
- Create: `supabase/functions/_shared/staff-auth.ts`
- Create: `supabase/functions/_shared/staff-invite-env.ts`
- Create: `supabase/functions/staff-invite/index.ts`
- Create: `supabase/functions/staff-invite/deno.json`
- Create: `tests/db/staff-invite.test.ts`

**Interfaces:**
- Consumes: Task 1 columns and fixture; Task 2 `_shared/staff-invite-core.ts`.
- Produces (used by Tasks 4–5): `json(status, body) => Response` in `_shared/http.ts`;
  `authorizeManageStaff(req) => Promise<{ ok: true; admin: SupabaseClient; callerStaffId: string } | { ok: false; response: Response }>`
  in `_shared/staff-auth.ts`; `deliveryConfigFromEnv() => InviteDeliveryConfig` and
  `staffAppUrl() => string | null` in `_shared/staff-invite-env.ts`.
- Produces (HTTP): `POST /functions/v1/staff-invite` `{ name, role, branch_id?, phone?, email? }` →
  201 `{ staff_user_id, channel: 'sms' | 'email', delivered, reason? }`; 400/401/403/409/500
  `{ error }`.

- [ ] **Step 1: Write the failing test**

Create `tests/db/staff-invite.test.ts`:

```typescript
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
    const body = { name: 'X', role: 'barber', branch_id: f.branchId, email: inviteEmail('refused') };
    expect((await invite(body, f.manager.accessToken)).status).toBe(403);
    expect((await invite(body, f.customer.accessToken)).status).toBe(403);
    expect((await callFunction('staff-invite', body)).status).toBe(401);
  });

  it('invites a barber by email: pending row, hashed 7-day token, barber row, no assignment', async () => {
    const email = inviteEmail('barber');
    const result = await invite({ name: 'Kofi Barber', role: 'barber', branch_id: f.branchId, email });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      channel: 'email',
      delivered: false,
      reason: 'undeliverable_test_address',
    });
    const staffUserId = result.body.staff_user_id as string;

    const { data: row } = await f.admin
      .from('staff_users')
      .select('email, role, invite_status, invited_by_staff_id, invite_token_hash, invite_expires_at, is_active')
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
    expect((await invite({ name: 'No Branch', role: 'barber', email: inviteEmail('nobranch') })).status).toBe(400);
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
    const { data: bare } = await f.admin.auth.admin.createUser({ email: bareEmail, email_confirm: true });
    f.createdAuthUserIds.push(bare!.user.id);
    expect((await invite({ name: 'Bare', role: 'analyst', email: bareEmail })).status).toBe(409);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- tests/db/staff-invite.test.ts`
Expected: FAIL — the function isn't deployed (404 responses instead of 201/403).

- [ ] **Step 3: Write the shared Deno helpers**

Create `supabase/functions/_shared/http.ts`:

```typescript
// supabase/functions/_shared/http.ts
// JSON response helper for the staff invite functions; every response carries the CORS headers
// (browser fetches with an Authorization header are preflighted).
import { corsHeaders } from './cors.ts';

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
```

Create `supabase/functions/_shared/staff-auth.ts`:

```typescript
// supabase/functions/_shared/staff-auth.ts
// Owner-only gate for staff-invite and staff-manage: the caller's JWT must belong to a staff user
// holding manage_staff (checked through the database AS the caller, like barber-pin-set), and the
// service-role client is only created after that check passes.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { json } from './http.ts';

export async function authorizeManageStaff(
  req: Request,
): Promise<
  | { ok: true; admin: SupabaseClient; callerStaffId: string }
  | { ok: false; response: Response }
> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return { ok: false, response: json(401, { error: 'Missing Authorization' }) };

  const url = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await asCaller.auth.getUser();
  if (userError || !userData.user) {
    return { ok: false, response: json(401, { error: 'Unauthorized' }) };
  }

  const { data: canManage } = await asCaller.rpc('has_capability', { cap: 'manage_staff' });
  if (!canManage) {
    return { ok: false, response: json(403, { error: 'Only the Owner can manage staff' }) };
  }

  const admin = createClient(url, serviceRoleKey);
  const { data: caller } = await admin
    .from('staff_users')
    .select('id')
    .eq('auth_user_id', userData.user.id)
    .single();
  if (!caller) return { ok: false, response: json(403, { error: 'Only the Owner can manage staff' }) };

  return { ok: true, admin, callerStaffId: caller.id as string };
}
```

Create `supabase/functions/_shared/staff-invite-env.ts`:

```typescript
// supabase/functions/_shared/staff-invite-env.ts
// Function secrets for invite delivery. STAFF_APP_URL is required to build links; the Arkesel and
// Resend secrets are optional -- sendInvite reports *_not_configured when they're missing.
import type { InviteDeliveryConfig } from './staff-invite-core.ts';

export function deliveryConfigFromEnv(): InviteDeliveryConfig {
  return {
    arkeselApiKey: Deno.env.get('ARKESEL_API_KEY') ?? undefined,
    arkeselSenderId: Deno.env.get('ARKESEL_SENDER_ID') ?? undefined,
    resendApiKey: Deno.env.get('RESEND_API_KEY') ?? undefined,
    emailFrom: Deno.env.get('INVITE_EMAIL_FROM') ?? undefined,
  };
}

export function staffAppUrl(): string | null {
  return Deno.env.get('STAFF_APP_URL') || null;
}
```

- [ ] **Step 4: Write the function**

Create `supabase/functions/staff-invite/deno.json`:

```json
{
  "imports": {
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2.116.0"
  }
}
```

Create `supabase/functions/staff-invite/index.ts`:

```typescript
// supabase/functions/staff-invite/index.ts
// Owner-only (manage_staff): invite a new staff member of any role (PRD §46.2). Creates a login
// with no password, a pending staff_users row holding only the SHA-256 of a 7-day token, and the
// barber row or branch assignment the role needs; then texts/emails the link. A failed insert rolls
// everything back; a failed DELIVERY does not -- the invite stays pending and the Owner can Resend.
import { corsHeaders } from '../_shared/cors.ts';
import { json } from '../_shared/http.ts';
import { authorizeManageStaff } from '../_shared/staff-auth.ts';
import { deliveryConfigFromEnv, staffAppUrl } from '../_shared/staff-invite-env.ts';
import {
  CONTACT_IN_USE_MESSAGE,
  buildInviteMessage,
  generateInviteToken,
  hashInviteToken,
  inviteExpiry,
  inviteLink,
  parseInviteRequest,
  sendInvite,
} from '../_shared/staff-invite-core.ts';

function isAlreadyRegistered(error: { code?: string; message?: string }): boolean {
  return (
    error.code === 'email_exists' ||
    error.code === 'phone_exists' ||
    /already (been )?registered/i.test(error.message ?? '')
  );
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const auth = await authorizeManageStaff(req);
  if (!auth.ok) return auth.response;
  const { admin, callerStaffId } = auth;

  const baseUrl = staffAppUrl();
  if (!baseUrl) return json(500, { error: 'Invites are not configured (STAFF_APP_URL is missing)' });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }
  const parsed = parseInviteRequest(body);
  if (!parsed.ok) return json(400, { error: parsed.error });
  const { name, role, branchId, phone, email } = parsed.value;

  if (branchId) {
    const { data: branch } = await admin.from('branches').select('id').eq('id', branchId).maybeSingle();
    if (!branch) return json(400, { error: 'Branch not found' });
  }

  const contactColumn = phone ? 'phone_e164' : 'email';
  const { data: existing } = await admin
    .from('staff_users')
    .select('id')
    .eq(contactColumn, (phone ?? email)!)
    .maybeSingle();
  if (existing) return json(409, { error: CONTACT_IN_USE_MESSAGE });

  const { data: created, error: createError } = await admin.auth.admin.createUser(
    phone ? { phone, phone_confirm: true } : { email: email!, email_confirm: true },
  );
  if (createError || !created?.user) {
    if (createError && isAlreadyRegistered(createError)) {
      return json(409, { error: CONTACT_IN_USE_MESSAGE });
    }
    console.error('staff-invite: createUser failed', createError);
    return json(500, { error: 'Could not create the invite' });
  }
  const authUserId = created.user.id;

  const token = generateInviteToken();
  const tokenHash = await hashInviteToken(token);
  let staffUserId: string | null = null;
  try {
    const { data: staffRow, error: staffError } = await admin
      .from('staff_users')
      .insert({
        auth_user_id: authUserId,
        name,
        role,
        email,
        phone_e164: phone,
        invite_status: 'pending',
        invited_by_staff_id: callerStaffId,
        invited_at: new Date().toISOString(),
        invite_token_hash: tokenHash,
        invite_expires_at: inviteExpiry().toISOString(),
      })
      .select('id')
      .single();
    if (staffError) throw staffError;
    staffUserId = staffRow.id as string;

    if (role === 'barber') {
      const { error } = await admin
        .from('barbers')
        .insert({ staff_user_id: staffUserId, home_branch_id: branchId, status: 'offline' });
      if (error) throw error;
    } else if (branchId) {
      const { error } = await admin
        .from('staff_branch_assignments')
        .insert({ staff_user_id: staffUserId, branch_id: branchId });
      if (error) throw error;
    }
  } catch (err) {
    console.error('staff-invite: insert failed, rolling back', err);
    // barbers and staff_branch_assignments cascade from staff_users.
    if (staffUserId) await admin.from('staff_users').delete().eq('id', staffUserId);
    await admin.auth.admin.deleteUser(authUserId);
    return json(500, { error: 'Could not create the invite' });
  }

  const message = buildInviteMessage({ name, role, link: inviteLink(baseUrl, token) });
  const delivery = await sendInvite(phone ? { phone } : { email: email! }, message, deliveryConfigFromEnv());
  return json(201, { staff_user_id: staffUserId, channel: phone ? 'sms' : 'email', ...delivery });
});
```

- [ ] **Step 5: Typecheck what can be checked locally and commit**

Run: `npm run typecheck` — Expected: PASS (the Deno function isn't in the TS project; the shared
core is already covered by Task 2's tests). If `deno` is installed, also run
`deno check supabase/functions/staff-invite/index.ts` — Expected: no errors.

```bash
git add supabase/functions/_shared/http.ts supabase/functions/_shared/staff-auth.ts supabase/functions/_shared/staff-invite-env.ts supabase/functions/staff-invite tests/db/staff-invite.test.ts
git commit -m "feat: add staff-invite Edge Function"
```

- [ ] **Step 6 (controller): set secrets, deploy, verify GREEN**

Controller asks the user for the `STAFF_APP_URL` value (and optional Resend values), sets the
secrets, deploys `staff-invite`, then runs `npm run test -- tests/db/staff-invite.test.ts` —
Expected: PASS.

---

### Task 4: The `staff-manage` Edge Function

**Files:**
- Create: `supabase/functions/staff-manage/index.ts`
- Create: `supabase/functions/staff-manage/deno.json`
- Create: `tests/db/staff-manage.test.ts`

**Interfaces:**
- Consumes: Task 1 fixture (`createStaffAccount`, `setInviteToken`, `hashToken`, `signIn`,
  `callFunction`); Task 2 core; Task 3 `json`, `authorizeManageStaff`, `deliveryConfigFromEnv`,
  `staffAppUrl`.
- Produces (HTTP): `POST /functions/v1/staff-manage` `{ action: 'resend' | 'revoke' | 'deactivate' |
  'reactivate', staff_user_id }` → 200 (`resend`: `{ delivered, reason? }`; others `{ ok: true }`);
  400 bad action/id, 401, 403, 404 unknown staff, 409 wrong state / self-deactivation, 500.

- [ ] **Step 1: Write the failing test**

Create `tests/db/staff-manage.test.ts`:

```typescript
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
  toRevoke = await createStaffAccount(f, { label: 'mrevoke', role: 'analyst', inviteStatus: 'pending' });
  await setInviteToken(f, toRevoke.staffUserId, `tok-revoke-${f.suffix}`, daysFromNow(7));
  active = await createStaffAccount(f, { label: 'mactive', role: 'barber', inviteStatus: 'accepted' });
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

  it('revokes a pending invite, clearing its token, and only once', async () => {
    expect((await manage('revoke', toRevoke.staffUserId)).status).toBe(200);
    const row = await readInvite(toRevoke.staffUserId);
    expect(row.invite_status).toBe('revoked');
    expect(row.invite_token_hash).toBeNull();
    expect((await manage('revoke', toRevoke.staffUserId)).status).toBe(409);
  });

  it('deactivates an account so it cannot sign in, and reactivates it', async () => {
    expect((await manage('deactivate', active.staffUserId)).status).toBe(200);
    expect((await readInvite(active.staffUserId)).is_active).toBe(false);
    await expect(signIn({ email: active.email })).rejects.toBeTruthy();
    expect((await manage('deactivate', active.staffUserId)).status).toBe(409);

    expect((await manage('reactivate', active.staffUserId)).status).toBe(200);
    expect((await readInvite(active.staffUserId)).is_active).toBe(true);
    await expect(signIn({ email: active.email })).resolves.toBeTruthy();
    expect((await manage('reactivate', active.staffUserId)).status).toBe(409);
  });

  it('refuses the Owner deactivating their own account', async () => {
    expect((await manage('deactivate', f.owner.staffUserId)).status).toBe(409);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- tests/db/staff-manage.test.ts`
Expected: FAIL — `staff-manage` isn't deployed.

- [ ] **Step 3: Write the function**

Create `supabase/functions/staff-manage/deno.json`:

```json
{
  "imports": {
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2.116.0"
  }
}
```

Create `supabase/functions/staff-manage/index.ts`:

```typescript
// supabase/functions/staff-manage/index.ts
// Owner-only (manage_staff) actions on an existing staff account (App Flow 8.12):
//   resend     -- pending invite: new token + 7-day expiry (old link dies), send again
//   revoke     -- pending invite: clear the token, mark revoked, ban the login
//   deactivate -- accepted + active, never the caller's own account: is_active=false, ban
//   reactivate -- accepted + inactive: is_active=true, unban
// A ban blocks sign-in and refresh; an already-issued access token lasts until it expires (~1h).
import { corsHeaders } from '../_shared/cors.ts';
import { json } from '../_shared/http.ts';
import { authorizeManageStaff } from '../_shared/staff-auth.ts';
import { deliveryConfigFromEnv, staffAppUrl } from '../_shared/staff-invite-env.ts';
import {
  buildInviteMessage,
  generateInviteToken,
  hashInviteToken,
  inviteExpiry,
  inviteLink,
  sendInvite,
  type StaffRole,
} from '../_shared/staff-invite-core.ts';

const ACTIONS = ['resend', 'revoke', 'deactivate', 'reactivate'] as const;
type Action = (typeof ACTIONS)[number];
const BANNED = '876000h'; // ~100 years
const UNBANNED = 'none';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const auth = await authorizeManageStaff(req);
  if (!auth.ok) return auth.response;
  const { admin, callerStaffId } = auth;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }
  const action = body.action as Action;
  const staffUserId = body.staff_user_id;
  if (!ACTIONS.includes(action) || typeof staffUserId !== 'string' || staffUserId === '') {
    return json(400, { error: 'A valid action and staff_user_id are required' });
  }

  const { data: target } = await admin
    .from('staff_users')
    .select('id, auth_user_id, name, role, email, phone_e164, invite_status, is_active')
    .eq('id', staffUserId)
    .maybeSingle();
  if (!target) return json(404, { error: 'Staff member not found' });

  const setBan = (duration: string) =>
    admin.auth.admin.updateUserById(target.auth_user_id, { ban_duration: duration });

  if (action === 'resend') {
    if (target.invite_status !== 'pending') return json(409, { error: 'Only a pending invite can be resent' });
    const baseUrl = staffAppUrl();
    if (!baseUrl) return json(500, { error: 'Invites are not configured (STAFF_APP_URL is missing)' });
    const token = generateInviteToken();
    const { error } = await admin
      .from('staff_users')
      .update({
        invite_token_hash: await hashInviteToken(token),
        invite_expires_at: inviteExpiry().toISOString(),
      })
      .eq('id', target.id)
      .eq('invite_status', 'pending');
    if (error) return json(500, { error: 'Could not resend the invite' });
    const message = buildInviteMessage({
      name: target.name,
      role: target.role as StaffRole,
      link: inviteLink(baseUrl, token),
    });
    const delivery = await sendInvite(
      target.phone_e164 ? { phone: target.phone_e164 } : { email: target.email! },
      message,
      deliveryConfigFromEnv(),
    );
    return json(200, delivery);
  }

  if (action === 'revoke') {
    if (target.invite_status !== 'pending') return json(409, { error: 'Only a pending invite can be revoked' });
    const { error: banError } = await setBan(BANNED);
    if (banError) return json(500, { error: 'Could not revoke the invite' });
    const { error } = await admin
      .from('staff_users')
      .update({ invite_status: 'revoked', invite_token_hash: null, invite_expires_at: null })
      .eq('id', target.id);
    if (error) {
      await setBan(UNBANNED);
      return json(500, { error: 'Could not revoke the invite' });
    }
    return json(200, { ok: true });
  }

  if (action === 'deactivate') {
    if (target.id === callerStaffId) return json(409, { error: "You can't deactivate your own account" });
    if (target.invite_status !== 'accepted' || !target.is_active) {
      return json(409, { error: 'Only an active account can be deactivated' });
    }
    const { error: banError } = await setBan(BANNED);
    if (banError) return json(500, { error: 'Could not deactivate the account' });
    const { error } = await admin.from('staff_users').update({ is_active: false }).eq('id', target.id);
    if (error) {
      await setBan(UNBANNED);
      return json(500, { error: 'Could not deactivate the account' });
    }
    return json(200, { ok: true });
  }

  // reactivate
  if (target.invite_status !== 'accepted' || target.is_active) {
    return json(409, { error: 'Only a deactivated account can be reactivated' });
  }
  const { error: unbanError } = await setBan(UNBANNED);
  if (unbanError) return json(500, { error: 'Could not reactivate the account' });
  const { error } = await admin.from('staff_users').update({ is_active: true }).eq('id', target.id);
  if (error) {
    await setBan(BANNED);
    return json(500, { error: 'Could not reactivate the account' });
  }
  return json(200, { ok: true });
});
```

- [ ] **Step 4: Commit**

If `deno` is installed, run `deno check supabase/functions/staff-manage/index.ts` first.

```bash
git add supabase/functions/staff-manage tests/db/staff-manage.test.ts
git commit -m "feat: add staff-manage Edge Function for resend, revoke, deactivate, reactivate"
```

- [ ] **Step 5 (controller): deploy and verify GREEN**

Controller deploys `staff-manage`, then runs `npm run test -- tests/db/staff-manage.test.ts` —
Expected: PASS.

---

### Task 5: The `staff-invite-accept` Edge Function

**Files:**
- Create: `supabase/functions/staff-invite-accept/index.ts`
- Create: `supabase/functions/staff-invite-accept/deno.json`
- Modify: `supabase/config.toml` (add the function's `verify_jwt = false` block after `[functions.pin-login]`)
- Create: `tests/db/staff-invite-accept.test.ts`

**Interfaces:**
- Consumes: Task 1 fixture; Task 2 `hashInviteToken`, `MIN_PASSWORD_LENGTH`; Task 3 `json`.
- Produces (HTTP, public): `POST /functions/v1/staff-invite-accept`
  - `{ token, mode: 'preview' }` → 200 `{ valid: true, name, role, branch_name }` or 200 `{ valid: false }`
  - `{ token, mode: 'accept', password }` → 200 `{ login: { email } | { phone } }`; 400 short
    password / bad request; 410 `{ valid: false }`; 500.

- [ ] **Step 1: Write the failing test**

Create `tests/db/staff-invite-accept.test.ts`:

```typescript
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
  analyst = await createStaffAccount(f, { label: 'aana', role: 'analyst', inviteStatus: 'pending' });
  await setInviteToken(f, analyst.staffUserId, token('ana'), daysFromNow(7));
  expired = await createStaffAccount(f, { label: 'aexp', role: 'analyst', inviteStatus: 'pending' });
  await setInviteToken(f, expired.staffUserId, token('exp'), daysFromNow(-1));
  revoked = await createStaffAccount(f, { label: 'arev', role: 'analyst', inviteStatus: 'revoked' });
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- tests/db/staff-invite-accept.test.ts`
Expected: FAIL — `staff-invite-accept` isn't deployed.

- [ ] **Step 3: Write the function and its config**

Create `supabase/functions/staff-invite-accept/deno.json`:

```json
{
  "imports": {
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2.116.0"
  }
}
```

Create `supabase/functions/staff-invite-accept/index.ts`:

```typescript
// supabase/functions/staff-invite-accept/index.ts
// Public (no JWT): the Accept Staff Invite screen (App Flow 8.15) calls this with the token from
// the link. `preview` returns who the invite is for, or one generic { valid: false } for unknown,
// expired, revoked or used links. `accept` CLAIMS the invite first (a conditional update, so two
// concurrent accepts can't both win), then sets the chosen password; if that fails the claim is
// reverted. The 256-bit token is the real authentication here.
import { createClient } from '@supabase/supabase-js';
import { corsHeaders } from '../_shared/cors.ts';
import { json } from '../_shared/http.ts';
import { MIN_PASSWORD_LENGTH, hashInviteToken } from '../_shared/staff-invite-core.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }
  const token = typeof body.token === 'string' ? body.token : '';
  const mode = body.mode;
  if (!token || (mode !== 'preview' && mode !== 'accept')) {
    return json(400, { error: 'token and mode are required' });
  }

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const tokenHash = await hashInviteToken(token);

  const { data: invite } = await admin
    .from('staff_users')
    .select('id, auth_user_id, name, role, email, phone_e164, invite_status, invite_expires_at')
    .eq('invite_token_hash', tokenHash)
    .maybeSingle();
  const isValid =
    !!invite &&
    invite.invite_status === 'pending' &&
    invite.invite_expires_at !== null &&
    new Date(invite.invite_expires_at).getTime() >= Date.now();

  if (mode === 'preview') {
    if (!isValid) return json(200, { valid: false });
    const { data: barber } = await admin
      .from('barbers')
      .select('home_branch_id')
      .eq('staff_user_id', invite.id)
      .maybeSingle();
    let branchId: string | null = barber?.home_branch_id ?? null;
    if (!branchId) {
      const { data: assignment } = await admin
        .from('staff_branch_assignments')
        .select('branch_id')
        .eq('staff_user_id', invite.id)
        .order('branch_id')
        .limit(1)
        .maybeSingle();
      branchId = assignment?.branch_id ?? null;
    }
    let branchName: string | null = null;
    if (branchId) {
      const { data: branch } = await admin.from('branches').select('name').eq('id', branchId).single();
      branchName = branch?.name ?? null;
    }
    return json(200, { valid: true, name: invite.name, role: invite.role, branch_name: branchName });
  }

  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return json(400, { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }
  if (!isValid) return json(410, { valid: false });

  const { data: claimed, error: claimError } = await admin
    .from('staff_users')
    .update({
      invite_status: 'accepted',
      invite_accepted_at: new Date().toISOString(),
      invite_token_hash: null,
      invite_expires_at: null,
    })
    .eq('id', invite.id)
    .eq('invite_status', 'pending')
    .eq('invite_token_hash', tokenHash)
    .select('id');
  if (claimError) return json(500, { error: 'Could not accept the invite' });
  if (!claimed || claimed.length === 0) return json(410, { valid: false });

  const { error: passwordError } = await admin.auth.admin.updateUserById(invite.auth_user_id, { password });
  if (passwordError) {
    console.error('staff-invite-accept: setting the password failed, reverting the claim', passwordError);
    await admin
      .from('staff_users')
      .update({
        invite_status: 'pending',
        invite_accepted_at: null,
        invite_token_hash: tokenHash,
        invite_expires_at: invite.invite_expires_at,
      })
      .eq('id', invite.id);
    return json(500, { error: 'Could not accept the invite' });
  }

  return json(200, { login: invite.email ? { email: invite.email } : { phone: invite.phone_e164 } });
});
```

Modify `supabase/config.toml` — insert immediately after the `[functions.pin-login]` block
(`verify_jwt = false` line):

```toml

# Staff invitation: the invitee has no session yet when they open their invite link (App Flow
# 8.15), so the platform JWT gate is disabled for this one function. The 256-bit invite token,
# checked by hash inside the function, is the real authentication.
[functions.staff-invite-accept]
verify_jwt = false
```

- [ ] **Step 4: Commit**

If `deno` is installed, run `deno check supabase/functions/staff-invite-accept/index.ts` first.

```bash
git add supabase/functions/staff-invite-accept supabase/config.toml tests/db/staff-invite-accept.test.ts
git commit -m "feat: add public staff-invite-accept Edge Function"
```

- [ ] **Step 5 (controller): deploy and verify GREEN**

Controller deploys `staff-invite-accept` (the `config.toml` block disables the JWT gate; if the CLI
doesn't pick it up, deploy with `--no-verify-jwt`), then runs
`npm run test -- tests/db/staff-invite-accept.test.ts tests/db/staff-invite.test.ts tests/db/staff-manage.test.ts`
— Expected: PASS.

---

### Task 6: Staff login accepts email or phone

**Files:**
- Create: `apps/staff/app/login/identifier.ts`
- Create: `apps/staff/app/login/identifier.test.ts`
- Create: `apps/staff/app/login/postLoginPath.ts`
- Modify: `apps/staff/app/login/page.tsx`
- Modify: `apps/staff/messages/en.json` (`"Login"` block)

**Interfaces:**
- Produces: `parseLoginIdentifier(input: string): LoginIdentifier | null` where
  `LoginIdentifier = { email: string } | { phone: string }`; `postLoginPath(supabase, authUserId):
  Promise<'/queue/today' | '/tickets'>` (used by Task 8).

- [ ] **Step 1: Write the failing test**

Create `apps/staff/app/login/identifier.test.ts`:

```typescript
// apps/staff/app/login/identifier.test.ts
import { describe, expect, it } from 'vitest';
import { parseLoginIdentifier } from './identifier';

describe('parseLoginIdentifier', () => {
  it('treats anything with @ as an email, lower-cased', () => {
    expect(parseLoginIdentifier('  Kofi@Example.com ')).toEqual({ email: 'kofi@example.com' });
  });

  it('normalizes Ghana phone numbers', () => {
    expect(parseLoginIdentifier('024 412 3456')).toEqual({ phone: '+233244123456' });
    expect(parseLoginIdentifier('+233244123456')).toEqual({ phone: '+233244123456' });
  });

  it('rejects empty input and invalid phone numbers', () => {
    expect(parseLoginIdentifier('   ')).toBeNull();
    expect(parseLoginIdentifier('12345')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- apps/staff/app/login/identifier.test.ts`
Expected: FAIL — cannot resolve `./identifier`.

- [ ] **Step 3: Write the helpers**

Create `apps/staff/app/login/identifier.ts`:

```typescript
// apps/staff/app/login/identifier.ts
// Staff sign in with an email or a Ghana phone number (SMS-invited staff have phone-only logins).
import { normalizeGhanaPhone } from '@pixel-barber/shared';

export type LoginIdentifier = { email: string } | { phone: string };

export function parseLoginIdentifier(input: string): LoginIdentifier | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.includes('@')) return { email: trimmed.toLowerCase() };
  const phone = normalizeGhanaPhone(trimmed);
  return phone ? { phone } : null;
}
```

Create `apps/staff/app/login/postLoginPath.ts`:

```typescript
// apps/staff/app/login/postLoginPath.ts
// Where a staff member lands after signing in: barbers go to Today's Queue, everyone else to the
// tickets dashboard. Shared by the login page and the Accept Invite page.
import type { createBrowserSupabaseClient } from '@pixel-barber/shared';

type Supabase = ReturnType<typeof createBrowserSupabaseClient>;

export async function postLoginPath(
  supabase: Supabase,
  authUserId: string,
): Promise<'/queue/today' | '/tickets'> {
  const { data: staffUser } = await supabase
    .from('staff_users')
    .select('id')
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  if (staffUser) {
    const { data: barberRow } = await supabase
      .from('barbers')
      .select('id')
      .eq('staff_user_id', staffUser.id)
      .maybeSingle();
    if (barberRow) return '/queue/today';
  }
  return '/tickets';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- apps/staff/app/login/identifier.test.ts` — Expected: PASS.

- [ ] **Step 5: Update the translations and the login page**

In `apps/staff/messages/en.json`'s `"Login"` block, replace `"emailPlaceholder": "Email",` with:

```json
    "identifierPlaceholder": "Email or phone",
    "invalidIdentifier": "Enter a valid email or Ghana phone number.",
```

(First run `grep -rn "emailPlaceholder" apps/staff` — if any file other than `login/page.tsx` uses
`Login.emailPlaceholder`, keep that key as well.)

Replace `apps/staff/app/login/page.tsx` with:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import { parseLoginIdentifier } from './identifier';
import { postLoginPath } from './postLoginPath';

export default function StaffLoginPage() {
  const router = useRouter();
  const t = useTranslations('Login');
  const supabase = createBrowserSupabaseClient();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const login = parseLoginIdentifier(identifier);
    if (!login) {
      setError(t('invalidIdentifier'));
      return;
    }
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword(
      'email' in login ? { email: login.email, password } : { phone: login.phone, password },
    );
    if (signInError) {
      setError(signInError.message);
      return;
    }
    // Barbers land on Today's Queue, everyone else on /tickets (shared with Accept Invite).
    router.push(await postLoginPath(supabase, signInData.user!.id));
  }

  return (
    <main>
      <h1>{t('title')}</h1>
      {error && <p role="alert">{error}</p>}
      <form onSubmit={handleSubmit}>
        <input
          type="text"
          autoComplete="username"
          placeholder={t('identifierPlaceholder')}
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder={t('passwordPlaceholder')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button type="submit">{t('logIn')}</button>
      </form>
      <Link href="/login/pin">{t('pinLoginLink')}</Link>
    </main>
  );
}
```

(Existing e2e specs use `getByPlaceholder('Email')`, which matches "Email or phone" — Playwright's
placeholder match is a case-insensitive substring by default.)

- [ ] **Step 6: Typecheck, build, and run the login-dependent e2e**

Run: `npm run typecheck` and `cd apps/staff && npx next build` — Expected: both clean.
Run: `npx playwright test e2e/barbers-management-journey.spec.ts` — Expected: PASS (it logs a
manager in through this page). If Playwright's 60-second dev-server start times out on this
machine, start both dev servers first (`npm run dev --workspace=@pixel-barber/customer -- --port 3000`
and `npm run dev --workspace=@pixel-barber/staff -- --port 3001`); the config reuses running
servers. Stop them afterwards.

- [ ] **Step 7: Commit**

```bash
git add apps/staff/app/login apps/staff/messages/en.json
git commit -m "feat: let staff sign in with email or phone"
```

---

### Task 7: Settings → Staff & Roles screen

**Files:**
- Create: `apps/staff/app/settings/staff/staffFunctions.ts`
- Create: `apps/staff/app/settings/staff/InviteStaffForm.tsx`
- Create: `apps/staff/app/settings/staff/page.tsx`
- Modify: `apps/staff/app/page.tsx` (add a Staff & Roles link)
- Modify: `apps/staff/messages/en.json` (new `"StaffRoles"` block; `"Home"` gains `"staffLink"`)

**Interfaces:**
- Consumes: `list_staff_accounts()` and its type (Task 1); `staff-invite` (Task 3) and
  `staff-manage` (Task 4) HTTP contracts.
- Produces: `StaffRoles.role_<role>` translation keys (used by Task 8 for role labels).

- [ ] **Step 1: Add translation keys**

In `apps/staff/messages/en.json`, add `"staffLink": "Staff & Roles"` to the `"Home"` block, and add a
new top-level block after `"BarberDetail"`:

```json
  "StaffRoles": {
    "title": "Staff & Roles",
    "noAccess": "You don't have access to this page.",
    "loadFailed": "Couldn't load staff accounts.",
    "colName": "Name",
    "colRole": "Role",
    "colBranch": "Branch",
    "colContact": "Contact",
    "colStatus": "Status",
    "colActions": "Actions",
    "role_owner": "Owner",
    "role_branch_manager": "Branch Manager",
    "role_receptionist": "Receptionist",
    "role_barber": "Barber",
    "role_analyst": "Analyst",
    "status_active": "Active",
    "status_invite_pending": "Invite pending",
    "status_invite_expired": "Invite expired",
    "status_revoked": "Revoked",
    "status_deactivated": "Deactivated",
    "allBranches": "All branches",
    "resend": "Resend",
    "revoke": "Revoke",
    "deactivate": "Deactivate",
    "reactivate": "Reactivate",
    "confirmDeactivate": "Deactivate {name}? They won't be able to log in until reactivated.",
    "actionFailed": "That didn't work: {error}",
    "resent": "Invite resent.",
    "openInvite": "+ Invite staff",
    "inviteTitle": "Invite staff",
    "close": "Close",
    "nameLabel": "Name",
    "roleLabel": "Role",
    "branchLabel": "Branch",
    "contactTypeLabel": "Send invite by",
    "contactPhone": "Phone (SMS)",
    "contactEmail": "Email",
    "phoneLabel": "Phone number",
    "emailLabel": "Email address",
    "sendInvite": "Send invite",
    "sentSms": "Invite sent by SMS to {contact}.",
    "sentEmail": "Invite sent by email to {contact}.",
    "notDelivered": "Invite created but not delivered — use Resend.",
    "emailNotConfigured": "Email sending isn't set up yet.",
    "smsNotConfigured": "SMS sending isn't set up yet.",
    "contactInUse": "That phone number or email is already used by an account.",
    "inviteFailed": "Couldn't send the invite: {error}",
    "nameRequired": "Enter a name.",
    "contactRequired": "Enter a phone number or email."
  },
```

- [ ] **Step 2: Create `staffFunctions.ts`**

```typescript
// apps/staff/app/settings/staff/staffFunctions.ts
// Calls the Owner-only staff Edge Functions with the signed-in session, and maps delivery
// reasons to translation keys.
import type { createBrowserSupabaseClient } from '@pixel-barber/shared';

type Supabase = ReturnType<typeof createBrowserSupabaseClient>;

export interface FunctionResult {
  status: number;
  body: Record<string, unknown>;
}

export async function callStaffFunction(
  supabase: Supabase,
  name: 'staff-invite' | 'staff-manage',
  body: Record<string, unknown>,
): Promise<FunctionResult> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  try {
    const response = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session?.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: response.status, body: parsed };
  } catch {
    return { status: 0, body: { error: 'network' } };
  }
}

export function deliveryReasonKey(reason: unknown): 'emailNotConfigured' | 'smsNotConfigured' | null {
  if (reason === 'email_not_configured') return 'emailNotConfigured';
  if (reason === 'sms_not_configured') return 'smsNotConfigured';
  return null;
}

export function errorText(body: Record<string, unknown>, status: number): string {
  return typeof body.error === 'string' ? body.error : String(status);
}
```

- [ ] **Step 3: Create `InviteStaffForm.tsx`**

```tsx
// apps/staff/app/settings/staff/InviteStaffForm.tsx
// The Owner's "+ Invite staff" form (App Flow 8.12): name, role, branch (only for roles tied to a
// branch), and a phone number or email. Stays open after sending so the Owner sees the result.
'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import { callStaffFunction, deliveryReasonKey, errorText } from './staffFunctions';

const ROLES = ['barber', 'receptionist', 'branch_manager', 'analyst', 'owner'] as const;
type Role = (typeof ROLES)[number];
const BRANCH_ROLES = new Set<Role>(['barber', 'receptionist', 'branch_manager']);

interface Branch {
  id: string;
  name: string;
}

export default function InviteStaffForm({
  onInvited,
  onClose,
}: {
  onInvited: () => void;
  onClose: () => void;
}) {
  const t = useTranslations('StaffRoles');
  const supabase = createBrowserSupabaseClient();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('barber');
  const [branchId, setBranchId] = useState('');
  const [contactType, setContactType] = useState<'phone' | 'email'>('phone');
  const [contact, setContact] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from('branches')
      .select('id, name')
      .order('name')
      .then(({ data }) => {
        if (cancelled) return;
        setBranches(data ?? []);
        if (data && data.length > 0) setBranchId(data[0].id);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const needsBranch = BRANCH_ROLES.has(role);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    if (!name.trim()) {
      setResult({ ok: false, text: t('nameRequired') });
      return;
    }
    if (!contact.trim()) {
      setResult({ ok: false, text: t('contactRequired') });
      return;
    }
    setSending(true);
    const response = await callStaffFunction(supabase, 'staff-invite', {
      name: name.trim(),
      role,
      ...(needsBranch ? { branch_id: branchId } : {}),
      [contactType]: contact.trim(),
    });
    setSending(false);

    if (response.status === 201) {
      if (response.body.delivered === true) {
        setResult({
          ok: true,
          text: t(contactType === 'phone' ? 'sentSms' : 'sentEmail', { contact: contact.trim() }),
        });
      } else {
        const reasonKey = deliveryReasonKey(response.body.reason);
        setResult({
          ok: true,
          text: reasonKey ? `${t('notDelivered')} ${t(reasonKey)}` : t('notDelivered'),
        });
      }
      setName('');
      setContact('');
      onInvited();
      return;
    }
    if (response.status === 409) setResult({ ok: false, text: t('contactInUse') });
    else if (response.status === 403) setResult({ ok: false, text: t('noAccess') });
    else {
      setResult({ ok: false, text: t('inviteFailed', { error: errorText(response.body, response.status) }) });
    }
  }

  return (
    <section>
      <h2>{t('inviteTitle')}</h2>
      {result && <p role={result.ok ? 'status' : 'alert'}>{result.text}</p>}
      <form onSubmit={handleSubmit}>
        <label>
          {t('nameLabel')}
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          {t('roleLabel')}
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`role_${r}`)}
              </option>
            ))}
          </select>
        </label>
        {needsBranch && (
          <label>
            {t('branchLabel')}
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <fieldset>
          <legend>{t('contactTypeLabel')}</legend>
          <label>
            <input
              type="radio"
              name="contactType"
              checked={contactType === 'phone'}
              onChange={() => setContactType('phone')}
            />
            {t('contactPhone')}
          </label>
          <label>
            <input
              type="radio"
              name="contactType"
              checked={contactType === 'email'}
              onChange={() => setContactType('email')}
            />
            {t('contactEmail')}
          </label>
        </fieldset>
        <label>
          {contactType === 'phone' ? t('phoneLabel') : t('emailLabel')}
          <input
            type={contactType === 'phone' ? 'tel' : 'email'}
            value={contact}
            onChange={(e) => setContact(e.target.value)}
          />
        </label>
        <button type="submit" disabled={sending}>
          {t('sendInvite')}
        </button>
        <button type="button" onClick={onClose}>
          {t('close')}
        </button>
      </form>
    </section>
  );
}
```

- [ ] **Step 4: Create the page**

```tsx
// apps/staff/app/settings/staff/page.tsx
// Settings → Staff & Roles (App Flow 8.12, PRD §46): Owner-only list of every staff account with
// its invite/account status, per-row Resend/Revoke/Deactivate/Reactivate, and the Invite form.
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';
import InviteStaffForm from './InviteStaffForm';
import { callStaffFunction, deliveryReasonKey, errorText } from './staffFunctions';

type StaffAccount = Database['public']['Functions']['list_staff_accounts']['Returns'][number];
type ManageAction = 'resend' | 'revoke' | 'deactivate' | 'reactivate';

function actionsFor(account: StaffAccount): ManageAction[] {
  switch (account.status) {
    case 'invite_pending':
    case 'invite_expired':
      return ['resend', 'revoke'];
    case 'active':
      return account.is_self ? [] : ['deactivate'];
    case 'deactivated':
      return ['reactivate'];
    default:
      return [];
  }
}

export default function StaffRolesPage() {
  const t = useTranslations('StaffRoles');
  const supabase = createBrowserSupabaseClient();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [accounts, setAccounts] = useState<StaffAccount[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [rowMessages, setRowMessages] = useState<Record<string, string>>({});
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('list_staff_accounts');
    setLoadError(!!error);
    if (!error) setAccounts(data ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    supabase.rpc('has_capability', { cap: 'manage_staff' }).then(({ data }) => {
      if (cancelled) return;
      setAllowed(data === true);
      if (data === true) void load();
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runAction(account: StaffAccount, action: ManageAction) {
    if (action === 'deactivate' && !window.confirm(t('confirmDeactivate', { name: account.name }))) {
      return;
    }
    setBusyRow(account.staff_user_id);
    const response = await callStaffFunction(supabase, 'staff-manage', {
      action,
      staff_user_id: account.staff_user_id,
    });
    setBusyRow(null);
    let message = '';
    if (response.status !== 200) {
      message = t('actionFailed', { error: errorText(response.body, response.status) });
    } else if (action === 'resend') {
      if (response.body.delivered === true) {
        message = t('resent');
      } else {
        const reasonKey = deliveryReasonKey(response.body.reason);
        message = reasonKey ? `${t('notDelivered')} ${t(reasonKey)}` : t('notDelivered');
      }
    }
    setRowMessages((m) => ({ ...m, [account.staff_user_id]: message }));
    await load();
  }

  if (allowed === null) return null;
  if (!allowed) {
    return (
      <main>
        <p role="alert">{t('noAccess')}</p>
      </main>
    );
  }

  return (
    <main>
      <h1>{t('title')}</h1>
      {loadError && <p role="alert">{t('loadFailed')}</p>}
      {showInvite ? (
        <InviteStaffForm onInvited={() => void load()} onClose={() => setShowInvite(false)} />
      ) : (
        <button type="button" onClick={() => setShowInvite(true)}>
          {t('openInvite')}
        </button>
      )}
      <table>
        <thead>
          <tr>
            <th>{t('colName')}</th>
            <th>{t('colRole')}</th>
            <th>{t('colBranch')}</th>
            <th>{t('colContact')}</th>
            <th>{t('colStatus')}</th>
            <th>{t('colActions')}</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((account) => (
            <tr key={account.staff_user_id}>
              <td>{account.name}</td>
              <td>{t(`role_${account.role}`)}</td>
              <td>{account.branch_name ?? t('allBranches')}</td>
              <td>{account.phone_e164 ?? account.email}</td>
              <td>{t(`status_${account.status}`)}</td>
              <td>
                {actionsFor(account).map((action) => (
                  <button
                    key={action}
                    type="button"
                    disabled={busyRow === account.staff_user_id}
                    onClick={() => runAction(account, action)}
                  >
                    {t(action)}
                  </button>
                ))}
                {rowMessages[account.staff_user_id] && (
                  <span role="status"> {rowMessages[account.staff_user_id]}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
```

- [ ] **Step 5: Add the home link**

In `apps/staff/app/page.tsx`, add after the Barbers link:

```tsx
      <Link href="/settings/staff">{t('staffLink')}</Link>
```

- [ ] **Step 6: Typecheck and build**

Run: `npm run typecheck` and `cd apps/staff && npx next build` — Expected: both clean. (This
screen's behaviour is exercised end to end by Task 9.)

- [ ] **Step 7: Commit**

```bash
git add apps/staff/app/settings/staff apps/staff/app/page.tsx apps/staff/messages/en.json
git commit -m "feat: add Owner Staff & Roles screen with invite, resend, revoke, deactivate"
```

---

### Task 8: Accept Invite page

**Files:**
- Create: `apps/staff/app/invite/[token]/page.tsx`
- Modify: `apps/staff/messages/en.json` (new `"AcceptInvite"` block)

**Interfaces:**
- Consumes: `staff-invite-accept` (Task 5); `postLoginPath` (Task 6); `StaffRoles.role_<role>` keys
  (Task 7).

- [ ] **Step 1: Add translation keys**

Add a new top-level block to `apps/staff/messages/en.json` after `"StaffRoles"`:

```json
  "AcceptInvite": {
    "title": "Join Pixel Barber",
    "loading": "Checking your invite…",
    "invited": "You've been invited to join Pixel Barber.",
    "nameLine": "Name: {name}",
    "roleLine": "Role: {role}",
    "branchLine": "Branch: {branch}",
    "invalid": "This invite is no longer valid — ask your Owner to send a new one.",
    "passwordLabel": "Choose a password",
    "confirmLabel": "Confirm password",
    "submit": "Set password and sign in",
    "tooShort": "Password must be at least 8 characters.",
    "mismatch": "Passwords don't match.",
    "failed": "Something went wrong. Please try again.",
    "signInFailed": "Your password is set, but signing in failed. Please log in from the login page.",
    "goToLogin": "Go to login"
  },
```

- [ ] **Step 2: Create the page**

```tsx
// apps/staff/app/invite/[token]/page.tsx
// Accept Staff Invite (App Flow 8.15): link-only, no navigation, no login. Previews who the invite
// is for, lets the invitee choose a password, then signs them straight in. Any invalid link shows
// one plain message.
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import { postLoginPath } from '../../login/postLoginPath';

const MIN_PASSWORD_LENGTH = 8;

type Preview =
  | { state: 'loading' }
  | { state: 'invalid' }
  | { state: 'valid'; name: string; role: string; branchName: string | null };

async function callAccept(body: Record<string, unknown>) {
  try {
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/staff-invite-accept`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: response.status, body: parsed };
  } catch {
    return { status: 0, body: {} as Record<string, unknown> };
  }
}

export default function AcceptInvitePage() {
  const t = useTranslations('AcceptInvite');
  const tRoles = useTranslations('StaffRoles');
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const supabase = createBrowserSupabaseClient();
  const [preview, setPreview] = useState<Preview>({ state: 'loading' });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<'tooShort' | 'mismatch' | 'failed' | 'signInFailed' | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    callAccept({ token: params.token, mode: 'preview' }).then(({ status, body }) => {
      if (cancelled) return;
      if (status === 200 && body.valid === true) {
        setPreview({
          state: 'valid',
          name: body.name as string,
          role: body.role as string,
          branchName: (body.branch_name as string | null) ?? null,
        });
      } else {
        setPreview({ state: 'invalid' });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [params.token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError('tooShort');
      return;
    }
    if (password !== confirm) {
      setError('mismatch');
      return;
    }
    setSubmitting(true);
    const { status, body } = await callAccept({ token: params.token, mode: 'accept', password });
    if (status === 410) {
      setSubmitting(false);
      setPreview({ state: 'invalid' });
      return;
    }
    if (status === 400) {
      setSubmitting(false);
      setError('tooShort');
      return;
    }
    if (status !== 200) {
      setSubmitting(false);
      setError('failed');
      return;
    }
    const login = body.login as { email?: string; phone?: string };
    const { data, error: signInError } = await supabase.auth.signInWithPassword(
      login.email ? { email: login.email, password } : { phone: login.phone!, password },
    );
    if (signInError || !data.user) {
      setSubmitting(false);
      setError('signInFailed');
      return;
    }
    router.push(await postLoginPath(supabase, data.user.id));
  }

  if (preview.state === 'loading') {
    return (
      <main>
        <p>{t('loading')}</p>
      </main>
    );
  }
  if (preview.state === 'invalid') {
    return (
      <main>
        <h1>{t('title')}</h1>
        <p role="alert">{t('invalid')}</p>
      </main>
    );
  }

  return (
    <main>
      <h1>{t('title')}</h1>
      <p>{t('invited')}</p>
      <p>{t('nameLine', { name: preview.name })}</p>
      <p>{t('roleLine', { role: tRoles(`role_${preview.role}`) })}</p>
      {preview.branchName && <p>{t('branchLine', { branch: preview.branchName })}</p>}
      {error && (
        <p role="alert">
          {t(error)}
          {error === 'signInFailed' && (
            <>
              {' '}
              <Link href="/login">{t('goToLogin')}</Link>
            </>
          )}
        </p>
      )}
      <form onSubmit={handleSubmit}>
        <label>
          {t('passwordLabel')}
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label>
          {t('confirmLabel')}
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
        <button type="submit" disabled={submitting}>
          {t('submit')}
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck` and `cd apps/staff && npx next build` — Expected: both clean. Also
confirm `apps/staff/app/layout.tsx` doesn't redirect signed-out visitors (the page must render with
no session); if it does, report it rather than working around it.

- [ ] **Step 4: Commit**

```bash
git add "apps/staff/app/invite" apps/staff/messages/en.json
git commit -m "feat: add Accept Staff Invite page"
```

---

### Task 9: End-to-end — the Owner invites a barber who accepts and lands on Today's Queue

**Files:**
- Create: `e2e/staff-invitation-journey.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–8, running in the real staff app (`http://localhost:3001`)
  against the deployed functions.

- [ ] **Step 1: Write the e2e test**

Create `e2e/staff-invitation-journey.spec.ts`:

```typescript
// e2e/staff-invitation-journey.spec.ts
// The Owner invites a barber on Staff & Roles; the invitee opens the link, sets a password, and
// lands on Today's Queue; the Owner then sees the barber as Active. The invite uses a .local
// address (never delivered), and the test sets a KNOWN token with the service-role-only helper,
// since the real token only exists in the (skipped) email.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const STAFF_BASE_URL = 'http://localhost:3001';
const PASSWORD = 'Test-Password-123!';
const BARBER_PASSWORD = 'Barber-Pass-123!';

test.describe('staff invitation journey', () => {
  test.skip(!url || !serviceRoleKey, 'Supabase env vars not set');

  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const suffix = `${Date.now()}`;
  const ownerEmail = `sij-owner-${suffix}@test.pixelbarber.local`;
  const barberEmail = `sij-barber-${suffix}@test.pixelbarber.local`;
  const barberName = `SIJ Barber ${suffix}`;
  const token = `sij-token-${suffix}`;

  let branchId: string;
  let branchName: string;
  let ownerAuthUserId: string;
  let ownerStaffUserId: string;
  let barberStaffUserId: string | undefined;
  let barberAuthUserId: string | undefined;

  test.beforeAll(async () => {
    const { data: business } = await admin.from('businesses').select('id').limit(1).single();
    branchName = `SIJ Branch ${suffix}`;
    const { data: branch } = await admin
      .from('branches')
      .insert({
        business_id: business!.id,
        name: branchName,
        branch_code: `SIJ${suffix.slice(-6)}`,
        address: 'Test',
        latitude: 5.6,
        longitude: -0.18,
      })
      .select('id')
      .single();
    branchId = branch!.id;

    const { data: ownerAuth } = await admin.auth.admin.createUser({
      email: ownerEmail,
      password: PASSWORD,
      email_confirm: true,
    });
    ownerAuthUserId = ownerAuth!.user.id;
    const { data: ownerRow } = await admin
      .from('staff_users')
      .insert({
        auth_user_id: ownerAuthUserId,
        name: `SIJ Owner ${suffix}`,
        email: ownerEmail,
        role: 'owner',
        invite_status: 'accepted',
      })
      .select('id')
      .single();
    ownerStaffUserId = ownerRow!.id;
  }, 60000);

  test.afterAll(async () => {
    // The barber's staff row goes first: it references the Owner (invited_by_staff_id) and its
    // barbers row cascades from it; each auth user goes after its staff row (on delete restrict).
    if (barberStaffUserId) await admin.from('staff_users').delete().eq('id', barberStaffUserId);
    if (barberAuthUserId) await admin.auth.admin.deleteUser(barberAuthUserId);
    await admin.from('staff_users').delete().eq('id', ownerStaffUserId);
    await admin.auth.admin.deleteUser(ownerAuthUserId);
    await admin.from('branches').delete().eq('id', branchId);
  }, 60000);

  test("owner invites a barber, who accepts and lands on Today's Queue", async ({ browser }) => {
    test.setTimeout(180_000);

    // --- Owner signs in and sends the invite ---
    const ownerContext = await browser.newContext();
    const ownerPage = await ownerContext.newPage();
    await ownerPage.goto(`${STAFF_BASE_URL}/login`);
    await ownerPage.getByPlaceholder('Email').fill(ownerEmail);
    await ownerPage.getByPlaceholder('Password').fill(PASSWORD);
    await ownerPage.getByRole('button', { name: 'Log In' }).press('Enter');
    await ownerPage.waitForURL(/\/tickets/, { timeout: 15000 });

    await ownerPage.goto(`${STAFF_BASE_URL}/settings/staff`);
    const main = ownerPage.locator('main');
    // Scoped to <main> and using Enter: Next.js dev mode's Dev Tools badge intercepts clicks.
    await main.getByRole('button', { name: '+ Invite staff' }).press('Enter');
    await main.getByLabel('Name', { exact: true }).fill(barberName);
    await main.getByLabel('Role').selectOption('barber');
    await main.getByLabel('Branch').selectOption({ label: branchName });
    await main.getByLabel('Email', { exact: true }).check();
    await main.getByLabel('Email address').fill(barberEmail);
    await main.getByRole('button', { name: 'Send invite' }).press('Enter');
    await expect(main.getByText('Invite created but not delivered', { exact: false })).toBeVisible({
      timeout: 15000,
    });
    const pendingRow = main.getByRole('row', { name: new RegExp(barberName) });
    await expect(pendingRow.getByText('Invite pending')).toBeVisible();

    // --- Give the invite a known token (the real one only exists in the skipped email) ---
    const { data: barberRow } = await admin
      .from('staff_users')
      .select('id, auth_user_id')
      .eq('email', barberEmail)
      .single();
    barberStaffUserId = barberRow!.id;
    barberAuthUserId = barberRow!.auth_user_id;
    const { error: tokenError } = await admin.rpc('test_set_staff_invite_token' as never, {
      p_staff_user_id: barberStaffUserId,
      p_token: token,
      p_expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    } as never);
    expect(tokenError).toBeNull();

    // --- The invitee accepts ---
    const inviteeContext = await browser.newContext();
    const inviteePage = await inviteeContext.newPage();
    await inviteePage.goto(`${STAFF_BASE_URL}/invite/${token}`);
    const inviteeMain = inviteePage.locator('main');
    await expect(inviteeMain.getByText('Role: Barber')).toBeVisible({ timeout: 15000 });
    await expect(inviteeMain.getByText(`Branch: ${branchName}`)).toBeVisible();
    await inviteeMain.getByLabel('Choose a password').fill(BARBER_PASSWORD);
    await inviteeMain.getByLabel('Confirm password').fill(BARBER_PASSWORD);
    await inviteeMain.getByRole('button', { name: 'Set password and sign in' }).press('Enter');
    await inviteePage.waitForURL(/\/queue\/today/, { timeout: 20000 });
    await inviteeContext.close();

    // --- The Owner now sees the barber as Active ---
    await ownerPage.reload();
    const activeRow = ownerPage.locator('main').getByRole('row', { name: new RegExp(barberName) });
    await expect(activeRow.getByText('Active')).toBeVisible({ timeout: 15000 });
    await ownerContext.close();
  });
});
```

Note for the implementer: if a selector doesn't match the rendered markup, correct the selector
against the real page — never loosen the `/queue/today` landing check or the final "Active"
assertion.

- [ ] **Step 2: Run it**

Run: `npx playwright test e2e/staff-invitation-journey.spec.ts`
Expected: PASS (requires Tasks 1–5 pushed/deployed by the controller). If Playwright's 60-second
dev-server start times out on this machine, start both dev servers first (see Task 6 Step 6) and
stop them afterwards.

- [ ] **Step 3: Run the full e2e suite**

Run: `npm run test:e2e`
Expected: no new failures beyond the known pre-existing `e2e/queue-join-now.spec.ts` failure.

- [ ] **Step 4: Commit**

```bash
git add e2e/staff-invitation-journey.spec.ts
git commit -m "test: owner invites a barber who accepts and lands on Today's Queue"
```

---

## Self-Review

**Spec coverage:**
- Decision 1 (SMS + email; Resend; email-not-set-up message) → Task 2 `sendInvite`, Tasks 3/4
  responses, Task 7 messages.
- Decision 2 (Owner only) → Task 3 `authorizeManageStaff` (used by Tasks 3–4), Task 1
  `list_staff_accounts` gate, Task 7 page gate; tests in Tasks 1, 3, 4.
- Decision 3 (deactivate/reactivate) → Task 4; `find_eligible_barber` skip → Task 1.
- Decision 4 (7 days; resend kills old link) → Task 2 `inviteExpiry`, Task 4 resend; tests.
- Decision 5 (own token, hashed, no new table) → Tasks 1–2, 5.
- Decision 6 (phone-or-email login) → Task 6.
- Data model (columns not client-readable, unique hash index, per-role rows, derived statuses,
  `list_staff_accounts`, test helper) → Task 1 (+ Task 3 for per-role rows).
- Edge Functions (`staff-invite`, `staff-manage`, `staff-invite-accept`, rollback, 409 contact
  rules incl. customer logins, generic invalid answer, single-use) → Tasks 3–5.
- Screens (Staff & Roles, Accept Invite, login) → Tasks 6–8. Error handling → Tasks 3–8.
- Testing: DB (Task 1), functions (Tasks 3–5), unit (Tasks 2, 6), e2e (Task 9).
- Spec corrections 1–6 → Tasks 5, 2, 2, 1, 8, 7 respectively.

**Placeholder scan:** none — every code step contains its code; the only value supplied at
execution time is `STAFF_APP_URL`, which the controller asks the user for (Global Constraints).

**Type consistency:** `list_staff_accounts` row fields match between SQL, types and the Task 7 page.
`status` values (`invite_pending`, `invite_expired`, `revoked`, `active`, `deactivated`) match the
SQL `case`, the Task 1 test, `actionsFor`, and the `status_*` translation keys. Delivery reasons
(`undeliverable_test_address`, `email_not_configured`, `sms_not_configured`, `provider_error`) match
Task 2's type, Tasks 3–5 tests and `deliveryReasonKey`. `authorizeManageStaff`/`json`/
`deliveryConfigFromEnv`/`staffAppUrl` are defined in Task 3 and consumed with the same signatures in
Tasks 4–5. `postLoginPath` (Task 6) is consumed by Task 8. Fixture helpers defined in Task 1
(`createStaffAccount`, `setInviteToken`, `trackStaff`, `callFunction`, `hashToken`, `daysFromNow`,
`signIn`) are used with the same names/signatures in Tasks 3–5.
