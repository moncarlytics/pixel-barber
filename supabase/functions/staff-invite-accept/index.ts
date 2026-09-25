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

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
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
      const { data: branch } = await admin
        .from('branches')
        .select('name')
        .eq('id', branchId)
        .single();
      branchName = branch?.name ?? null;
    }
    return json(200, {
      valid: true,
      name: invite.name,
      role: invite.role,
      branch_name: branchName,
    });
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

  const { error: passwordError } = await admin.auth.admin.updateUserById(invite.auth_user_id, {
    password,
  });
  if (passwordError) {
    console.error(
      'staff-invite-accept: setting the password failed, reverting the claim',
      passwordError,
    );
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

  return json(200, {
    login: invite.email ? { email: invite.email } : { phone: invite.phone_e164 },
  });
});
