// supabase/functions/_shared/notification-sms-core.ts
// Pure rules for the send-notifications sender
// (Docs/superpowers/specs/2026-09-25-queue-sms-notifications-design.md). No Deno APIs, so Vitest
// can import it.

/**
 * Notification types the sender texts, each with the ticket states in which its text still makes
 * sense. A claimed row whose ticket has moved on (or a type not listed here) is 'stale'.
 */
const SENDABLE_TICKET_STATES: Record<string, ReadonlySet<string>> = {
  // Second in line right now. A ticket back in 'waiting' (it dropped back after a skip) is stale:
  // its one-per-ticket row was claimed for a moment that has passed.
  youre_next: new Set(['almost_turn']),
  // Called to the chair, or the arrival grace period after the call; not once service has started.
  your_turn: new Set(['called', 'grace_period']),
  // Released as a no-show and not since rejoined/changed.
  ticket_released: new Set(['no_show']),
};
export const SMS_NOTIFICATION_TYPES = ['youre_next', 'your_turn', 'ticket_released'] as const;
export type SmsNotificationType = (typeof SMS_NOTIFICATION_TYPES)[number];
export const DISPATCH_BATCH_SIZE = 50;
export const MAX_DISPATCH_ATTEMPTS = 3;
export const MAX_NOTIFICATION_AGE_MINUTES = 10;
/** A run stops claiming new work past this wall-clock budget; remaining/in-flight rows are released
 * (dispatch_claimed_at = null) and counted as `deferred` rather than left half-processed. */
export const RUN_DEADLINE_MS = 60_000;

export type SkipReason =
  'stale' | 'expired' | 'opted_out' | 'no_phone' | 'not_allowlisted' | 'sms_disabled';

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

/**
 * Decides one claimed notification, checking stale → expired → opted_out → no_phone →
 * not_allowlisted → live. `allowlist`, when a non-empty set, restricts sending to the phone numbers
 * it contains (used to test live sending against a small, known set of real numbers); `null` or an
 * empty set means no allowlist is in effect.
 */
export function decideNotification(
  n: ClaimedNotification,
  now: Date,
  live: boolean,
  allowlist?: ReadonlySet<string> | null,
): { action: 'send' } | { action: 'skip'; reason: SkipReason } {
  const sendableStates = SENDABLE_TICKET_STATES[n.notification_type];
  if (!n.ticket_id || !n.ticket_state || !sendableStates?.has(n.ticket_state)) {
    return { action: 'skip', reason: 'stale' };
  }
  const ageMs = now.getTime() - new Date(n.created_at).getTime();
  if (ageMs > MAX_NOTIFICATION_AGE_MINUTES * 60 * 1000)
    return { action: 'skip', reason: 'expired' };
  if (n.sms_backup_enabled === false) return { action: 'skip', reason: 'opted_out' };
  if (!n.phone_e164) return { action: 'skip', reason: 'no_phone' };
  if (allowlist && allowlist.size > 0 && !allowlist.has(n.phone_e164)) {
    return { action: 'skip', reason: 'not_allowlisted' };
  }
  if (!live) return { action: 'skip', reason: 'sms_disabled' };
  return { action: 'send' };
}

/** Parses SMS_NOTIFICATIONS_ALLOWLIST (comma-separated phone numbers). `null` when unset or empty. */
export function parseAllowlist(raw: string | undefined): Set<string> | null {
  if (!raw) return null;
  const numbers = raw
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n !== '');
  return numbers.length > 0 ? new Set(numbers) : null;
}

/** Whether `url` is a real, non-loopback base URL suitable for a link a customer will click. Used
 * to avoid sending live texts with a localhost/127.0.0.1 link nobody outside the dev machine can
 * open. */
export function isUsableCustomerAppUrl(url: string): boolean {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname;
    return hostname !== 'localhost' && hostname !== '127.0.0.1';
  } catch {
    return false;
  }
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

/** The text for one enabled notification type. */
export function buildNotificationSms(
  type: SmsNotificationType,
  input: { branchName: string; ticketNumber: string; link: string },
): string {
  switch (type) {
    case 'youre_next':
      return buildYoureNextSms(input);
    case 'your_turn':
      return `Pixel Barber: It's your turn at ${input.branchName}! Please go to your barber now. Ticket ${input.ticketNumber}: ${input.link}`;
    case 'ticket_released':
      return `Pixel Barber: Your ticket ${input.ticketNumber} at ${input.branchName} was released because you weren't available in time. Rejoin here: ${input.link}`;
  }
}

/** After a provider error on a row that has now been attempted `attemptsSoFar` times. */
export function afterProviderError(attemptsSoFar: number): 'retry' | 'fail' {
  return attemptsSoFar < MAX_DISPATCH_ATTEMPTS ? 'retry' : 'fail';
}
