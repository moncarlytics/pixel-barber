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
    if (target.invite_status !== 'pending')
      return json(409, { error: 'Only a pending invite can be resent' });
    const baseUrl = staffAppUrl();
    if (!baseUrl)
      return json(500, { error: 'Invites are not configured (STAFF_APP_URL is missing)' });
    const token = generateInviteToken();
    const { data, error } = await admin
      .from('staff_users')
      .update({
        invite_token_hash: await hashInviteToken(token),
        invite_expires_at: inviteExpiry().toISOString(),
      })
      .eq('id', target.id)
      .eq('invite_status', 'pending')
      .select('id');
    if (error) return json(500, { error: 'Could not resend the invite' });
    if (!data || data.length === 0)
      return json(409, { error: 'Only a pending invite can be resent' });
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
    if (target.invite_status !== 'pending')
      return json(409, { error: 'Only a pending invite can be revoked' });
    const { error: banError } = await setBan(BANNED);
    if (banError) return json(500, { error: 'Could not revoke the invite' });
    const { data, error } = await admin
      .from('staff_users')
      .update({ invite_status: 'revoked', invite_token_hash: null, invite_expires_at: null })
      .eq('id', target.id)
      .eq('invite_status', 'pending')
      .select('id');
    if (error) {
      const { error: compensationError } = await setBan(UNBANNED);
      if (compensationError) {
        console.error('staff-manage: COMPENSATION FAILED', {
          action: 'revoke',
          staffUserId: target.id,
          authUserId: target.auth_user_id,
          error: compensationError,
        });
      }
      return json(500, { error: 'Could not revoke the invite' });
    }
    if (!data || data.length === 0) {
      const { data: reread } = await admin
        .from('staff_users')
        .select('invite_status, is_active')
        .eq('id', target.id)
        .maybeSingle();
      if (reread?.invite_status === 'revoked') {
        return json(409, { error: 'Only a pending invite can be revoked' });
      }
      const { error: compensationError } = await setBan(UNBANNED);
      if (compensationError) {
        console.error('staff-manage: COMPENSATION FAILED', {
          action: 'revoke',
          staffUserId: target.id,
          authUserId: target.auth_user_id,
          error: compensationError,
        });
      }
      return json(409, { error: 'Only a pending invite can be revoked' });
    }
    return json(200, { ok: true });
  }

  if (action === 'deactivate') {
    if (target.id === callerStaffId)
      return json(409, { error: "You can't deactivate your own account" });
    if (target.invite_status !== 'accepted' || !target.is_active) {
      return json(409, { error: 'Only an active account can be deactivated' });
    }
    const { error: banError } = await setBan(BANNED);
    if (banError) return json(500, { error: 'Could not deactivate the account' });
    const { data, error } = await admin
      .from('staff_users')
      .update({ is_active: false })
      .eq('id', target.id)
      .eq('invite_status', 'accepted')
      .eq('is_active', true)
      .select('id');
    if (error) {
      const { error: compensationError } = await setBan(UNBANNED);
      if (compensationError) {
        console.error('staff-manage: COMPENSATION FAILED', {
          action: 'deactivate',
          staffUserId: target.id,
          authUserId: target.auth_user_id,
          error: compensationError,
        });
      }
      return json(500, { error: 'Could not deactivate the account' });
    }
    if (!data || data.length === 0) {
      const { data: reread } = await admin
        .from('staff_users')
        .select('invite_status, is_active')
        .eq('id', target.id)
        .maybeSingle();
      if (reread?.invite_status === 'accepted' && reread?.is_active === false) {
        return json(409, { error: 'Only an active account can be deactivated' });
      }
      const { error: compensationError } = await setBan(UNBANNED);
      if (compensationError) {
        console.error('staff-manage: COMPENSATION FAILED', {
          action: 'deactivate',
          staffUserId: target.id,
          authUserId: target.auth_user_id,
          error: compensationError,
        });
      }
      return json(409, { error: 'Only an active account can be deactivated' });
    }
    return json(200, { ok: true });
  }

  // reactivate
  if (target.invite_status !== 'accepted' || target.is_active) {
    return json(409, { error: 'Only a deactivated account can be reactivated' });
  }
  const { data, error } = await admin
    .from('staff_users')
    .update({ is_active: true })
    .eq('id', target.id)
    .eq('invite_status', 'accepted')
    .eq('is_active', false)
    .select('id');
  if (error) return json(500, { error: 'Could not reactivate the account' });
  if (!data || data.length === 0)
    return json(409, { error: 'Only a deactivated account can be reactivated' });

  const { error: unbanError } = await setBan(UNBANNED);
  if (unbanError) {
    const { error: revertError } = await admin
      .from('staff_users')
      .update({ is_active: false })
      .eq('id', target.id);
    if (revertError) {
      console.error('staff-manage: COMPENSATION FAILED', {
        action: 'reactivate',
        staffUserId: target.id,
        authUserId: target.auth_user_id,
        error: revertError,
      });
    }
    return json(500, { error: 'Could not reactivate the account' });
  }
  return json(200, { ok: true });
});
