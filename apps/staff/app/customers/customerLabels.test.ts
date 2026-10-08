import { describe, expect, it } from 'vitest';
import { deliveryLabel, groupReason, sendErrorKey, visitOutcome } from './customerLabels';
import type { CustomerStats } from './customerTypes';

const stats: CustomerStats = {
  visits: 6,
  last_visit_at: '2026-06-01T10:40:00Z',
  appointments: 1,
  no_shows: 3,
  cancellations: 1,
  late_cancellations: 2,
  avg_rating_given: 4.5,
  visits_last_90_days: 4,
};

describe('deliveryLabel', () => {
  it('maps notification states to what staff see', () => {
    expect(deliveryLabel('pending', null)).toEqual({ key: 'sending', reasonKey: null });
    for (const s of ['sent', 'delivered', 'fallback_sent']) {
      expect(deliveryLabel(s, null)).toEqual({ key: 'delivered', reasonKey: null });
    }
    for (const r of ['sms_disabled', 'not_allowlisted', 'opted_out', 'no_phone']) {
      expect(deliveryLabel('failed', r)).toEqual({
        key: 'notDelivered',
        reasonKey: 'reasonNoChannel',
      });
    }
    expect(deliveryLabel('failed', 'expired')).toEqual({
      key: 'notDelivered',
      reasonKey: 'reasonExpired',
    });
    expect(deliveryLabel('failed', 'provider_error')).toEqual({
      key: 'notDelivered',
      reasonKey: 'reasonFailed',
    });
  });
});

describe('groupReason', () => {
  it('states the fact behind each group', () => {
    expect(groupReason('new', stats)).toEqual({ key: 'reasonNew', values: {} });
    expect(groupReason('lapsed', stats)).toEqual({
      key: 'reasonLapsed',
      values: { date: 'Mon 1 Jun' },
    });
    expect(groupReason('at_risk', stats)).toEqual({
      key: 'reasonAtRisk',
      values: { noShows: 3, late: 2 },
    });
    expect(groupReason('frequent', stats)).toEqual({ key: 'reasonFrequent', values: { count: 4 } });
    expect(groupReason('returning', stats)).toEqual({
      key: 'reasonReturning',
      values: { count: 6 },
    });
  });
});

describe('visitOutcome', () => {
  it('names served, no-show, cancelled and live visits', () => {
    expect(visitOutcome('completed', null)).toEqual({ key: 'served', reasonKey: null });
    expect(visitOutcome('no_show', null)).toEqual({ key: 'noShow', reasonKey: null });
    expect(visitOutcome('cancelled', 'wait_too_long')).toEqual({
      key: 'cancelled',
      reasonKey: 'reasons.wait_too_long',
    });
    expect(visitOutcome('cancelled', null)).toEqual({ key: 'cancelledNoReason', reasonKey: null });
    expect(visitOutcome('in_service', null)).toEqual({ key: 'inService', reasonKey: null });
    expect(visitOutcome('waiting', null)).toEqual({ key: 'inQueue', reasonKey: null });
  });
});

describe('sendErrorKey', () => {
  it('maps send errors to copy keys', () => {
    expect(sendErrorKey('empty_message')).toBe('emptyMessage');
    expect(sendErrorKey('message_too_long')).toBe('tooLong');
    expect(sendErrorKey('daily_limit')).toBe('dailyLimit');
    expect(sendErrorKey('not_allowed')).toBe('sendFailed');
    expect(sendErrorKey(undefined)).toBe('sendFailed');
  });
});
