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
