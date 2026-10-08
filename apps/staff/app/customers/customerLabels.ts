// Copy-key mapping for the customer pages (Docs/superpowers/specs/2026-10-08-customer-list-design.md).
import { formatDay } from '../reports/format';
import type { CustomerGroup, CustomerStats } from './customerTypes';

const NO_CHANNEL = new Set(['sms_disabled', 'not_allowlisted', 'opted_out', 'no_phone']);

export function deliveryLabel(
  status: string,
  failedReason: string | null,
): {
  key: 'sending' | 'delivered' | 'notDelivered';
  reasonKey: 'reasonNoChannel' | 'reasonExpired' | 'reasonFailed' | null;
} {
  if (status === 'pending') return { key: 'sending', reasonKey: null };
  if (status === 'sent' || status === 'delivered' || status === 'fallback_sent') {
    return { key: 'delivered', reasonKey: null };
  }
  if (failedReason && NO_CHANNEL.has(failedReason)) {
    return { key: 'notDelivered', reasonKey: 'reasonNoChannel' };
  }
  if (failedReason === 'expired') return { key: 'notDelivered', reasonKey: 'reasonExpired' };
  return { key: 'notDelivered', reasonKey: 'reasonFailed' };
}

export function groupReason(
  group: CustomerGroup,
  stats: CustomerStats,
): { key: string; values: Record<string, string | number> } {
  switch (group) {
    case 'new':
      return { key: 'reasonNew', values: {} };
    case 'lapsed':
      return {
        key: 'reasonLapsed',
        values: { date: stats.last_visit_at ? formatDay(stats.last_visit_at) : '' },
      };
    case 'at_risk':
      return {
        key: 'reasonAtRisk',
        values: { noShows: stats.no_shows, late: stats.late_cancellations },
      };
    case 'frequent':
      return { key: 'reasonFrequent', values: { count: stats.visits_last_90_days } };
    case 'returning':
      return { key: 'reasonReturning', values: { count: stats.visits } };
  }
}

export function visitOutcome(
  state: string,
  cancelReason: string | null,
): { key: string; reasonKey: string | null } {
  if (state === 'completed') return { key: 'served', reasonKey: null };
  if (state === 'no_show') return { key: 'noShow', reasonKey: null };
  if (state === 'cancelled') {
    return cancelReason
      ? { key: 'cancelled', reasonKey: `reasons.${cancelReason}` }
      : { key: 'cancelledNoReason', reasonKey: null };
  }
  if (state === 'in_service') return { key: 'inService', reasonKey: null };
  return { key: 'inQueue', reasonKey: null };
}

export function sendErrorKey(code: string | undefined): string {
  switch (code) {
    case 'empty_message':
      return 'emptyMessage';
    case 'message_too_long':
      return 'tooLong';
    case 'daily_limit':
      return 'dailyLimit';
    default:
      return 'sendFailed';
  }
}
