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
  if (!baseUrl)
    return json(500, { error: 'Invites are not configured (STAFF_APP_URL is missing)' });

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
    const { data: branch } = await admin
      .from('branches')
      .select('id')
      .eq('id', branchId)
      .maybeSingle();
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
  const delivery = await sendInvite(
    phone ? { phone } : { email: email! },
    message,
    deliveryConfigFromEnv(),
  );
  return json(201, { staff_user_id: staffUserId, channel: phone ? 'sms' : 'email', ...delivery });
});
