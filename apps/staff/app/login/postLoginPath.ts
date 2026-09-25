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
