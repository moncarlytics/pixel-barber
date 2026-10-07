// supabase/functions/_shared/notification-push-core.ts
// Pure push rules for the send-notifications sender
// (Docs/superpowers/specs/2026-10-07-web-push-notifications-design.md). No Deno APIs, so Vitest
// can import it.
import {
  formatReminderTime,
  type ClaimedNotification,
  type PushTarget,
  type SmsNotificationType,
} from './notification-sms-core.ts';

/** A push the customer hasn't received within 10 minutes is no longer useful. */
export const PUSH_TTL_SECONDS = 600;

/** One push (including loading the VAPID keys) gets this long; past it the device counts as failed
 * and the SMS fallback takes over, so a hung push service can't stall a run. */
export const PUSH_TIMEOUT_MS = 8_000;

/** What the service worker shows: title, body, the app path a tap opens, and a de-dupe tag. */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

/** Saved devices we will push to: https endpoints only (the sender never trusts the endpoint
 * scheme). Others are ignored. */
export function pushTargets(n: ClaimedNotification): PushTarget[] {
  if (!Array.isArray(n.push_subscriptions)) return [];
  return n.push_subscriptions.filter(
    (t) => typeof t.endpoint === 'string' && t.endpoint.startsWith('https://'),
  );
}

/** Push is tried only when the customer has it switched on and at least one usable saved device. */
export function shouldAttemptPush(n: ClaimedNotification): boolean {
  return n.push_enabled === true && pushTargets(n).length > 0;
}

export function pushUrgency(type: SmsNotificationType): 'high' | 'normal' {
  return type === 'youre_next' || type === 'your_turn' ? 'high' : 'normal';
}

export function buildPushPayload(type: SmsNotificationType, n: ClaimedNotification): PushPayload {
  const branch = n.branch_name ?? 'Pixel Barber';
  const ticket = n.ticket_number ?? '';
  const ticketUrl = `/tickets/${n.ticket_id}`;
  const appointmentUrl = `/appointments/${n.appointment_id}`;
  const base = { title: 'Pixel Barber', tag: n.notification_id };
  switch (type) {
    case 'youre_next':
      return {
        ...base,
        url: ticketUrl,
        body: `You're next at ${branch}! Please head over now. Ticket ${ticket}.`,
      };
    case 'your_turn':
      return {
        ...base,
        url: ticketUrl,
        body: `It's your turn at ${branch}! Please go to your barber now. Ticket ${ticket}.`,
      };
    case 'ticket_released':
      return {
        ...base,
        url: ticketUrl,
        body: `Your ticket ${ticket} at ${branch} was released because you weren't available in time. Tap to rejoin.`,
      };
    case 'appointment_reminder_day':
      return {
        ...base,
        url: appointmentUrl,
        body: `Reminder, your appointment at ${branch} is tomorrow at ${formatReminderTime(n.appointment_slot ?? '')}.`,
      };
    case 'appointment_reminder_hour':
      return {
        ...base,
        url: appointmentUrl,
        body: `Your appointment at ${branch} is today at ${formatReminderTime(n.appointment_slot ?? '')}, in about an hour.`,
      };
  }
}

export type PushOutcome = 'ok' | 'gone' | 'failed';

/** Any device accepting the push means the customer was notified (no SMS). */
export function pushDelivered(results: ReadonlyArray<PushOutcome>): boolean {
  return results.includes('ok');
}

/** Status for a sent SMS: 'fallback_sent' when push was tried first and every device failed. */
export function smsSentStatus(pushAttempted: boolean): 'sent' | 'fallback_sent' {
  return pushAttempted ? 'fallback_sent' : 'sent';
}

/** Endpoints the push service reported gone (404/410), to delete. */
export function goneEndpoints(
  targets: ReadonlyArray<PushTarget>,
  results: ReadonlyArray<PushOutcome>,
): string[] {
  return targets.filter((_, i) => results[i] === 'gone').map((t) => t.endpoint);
}
