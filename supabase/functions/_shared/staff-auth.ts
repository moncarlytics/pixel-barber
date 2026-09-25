// supabase/functions/_shared/staff-auth.ts
// Owner-only gate for staff-invite and staff-manage: the caller's JWT must belong to a staff user
// holding manage_staff (checked through the database AS the caller, like barber-pin-set), and the
// service-role client is only created after that check passes.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { json } from './http.ts';

export async function authorizeManageStaff(
  req: Request,
): Promise<
  { ok: true; admin: SupabaseClient; callerStaffId: string } | { ok: false; response: Response }
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
  if (!caller)
    return { ok: false, response: json(403, { error: 'Only the Owner can manage staff' }) };

  return { ok: true, admin, callerStaffId: caller.id as string };
}
