// supabase/functions/_shared/notification-sms-core.ts
// Pure rules for the send-notifications sender
// (Docs/superpowers/specs/2026-09-25-queue-sms-notifications-design.md). No Deno APIs, so Vitest
// can import it.

/** Notification types the sender texts. Enabling another type later is a one-line change. */
export const SMS_NOTIFICATION_TYPES = ['youre_next'] as const;
export const DISPATCH_BATCH_SIZE = 50;
export const MAX_DISPATCH_ATTEMPTS = 3;
export const MAX_NOTIFICATION_AGE_MINUTES = 10;

export type SkipReason = 'stale' | 'expired' | 'opted_out' | 'no_phone' | 'sms_disabled';

/** One row returned by claim_sms_notifications. */
export interface ClaimedNotification {
  notification_id: string;
  notification_type: string;
  created_at: string;
  dispatch_attempts: number;
  customer_id: string;
  phone_e164: string | null;
  sms_backup_enabled: boolean | null;
  ticket_id: string | null;
  ticket_state: string | null;
  ticket_number: string | null;
  branch_name: string | null;
}

const SENDABLE_TICKET_STATES = new Set(['waiting', 'almost_turn']);

/** Decides one claimed notification, checking stale → expired → opted_out → no_phone → live. */
export function decideNotification(
  n: ClaimedNotification,
  now: Date,
  live: boolean,
): { action: 'send' } | { action: 'skip'; reason: SkipReason } {
  if (!n.ticket_id || !n.ticket_state || !SENDABLE_TICKET_STATES.has(n.ticket_state)) {
    return { action: 'skip', reason: 'stale' };
  }
  const ageMs = now.getTime() - new Date(n.created_at).getTime();
  if (ageMs > MAX_NOTIFICATION_AGE_MINUTES * 60 * 1000)
    return { action: 'skip', reason: 'expired' };
  if (n.sms_backup_enabled === false) return { action: 'skip', reason: 'opted_out' };
  if (!n.phone_e164) return { action: 'skip', reason: 'no_phone' };
  if (!live) return { action: 'skip', reason: 'sms_disabled' };
  return { action: 'send' };
}

export function ticketLink(baseUrl: string, ticketId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/tickets/${ticketId}`;
}

export function buildYoureNextSms(input: {
  branchName: string;
  ticketNumber: string;
  link: string;
}): string {
  return `Pixel Barber: You're next at ${input.branchName}! Please head over now. Ticket ${input.ticketNumber}: ${input.link}`;
}

/** After a provider error on a row that has now been attempted `attemptsSoFar` times. */
export function afterProviderError(attemptsSoFar: number): 'retry' | 'fail' {
  return attemptsSoFar < MAX_DISPATCH_ATTEMPTS ? 'retry' : 'fail';
}
