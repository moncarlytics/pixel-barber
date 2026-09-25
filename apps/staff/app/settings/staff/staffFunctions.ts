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

export function deliveryReasonKey(
  reason: unknown,
): 'emailNotConfigured' | 'smsNotConfigured' | null {
  if (reason === 'email_not_configured') return 'emailNotConfigured';
  if (reason === 'sms_not_configured') return 'smsNotConfigured';
  return null;
}

export function errorText(body: Record<string, unknown>, status: number): string {
  return typeof body.error === 'string' ? body.error : String(status);
}
