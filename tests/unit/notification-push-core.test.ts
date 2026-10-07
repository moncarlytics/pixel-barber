// tests/unit/notification-push-core.test.ts
// @vitest-environment node
// Pure push rules for send-notifications (web push spec, Section 2): when to try push, the wording
// and tap target per type, urgency.
import { describe, expect, it } from 'vitest';
import {
  PUSH_TIMEOUT_MS,
  PUSH_TTL_SECONDS,
  buildPushPayload,
  goneEndpoints,
  pushDelivered,
  pushTargets,
  pushUrgency,
  shouldAttemptPush,
  smsSentStatus,
} from '../../supabase/functions/_shared/notification-push-core';
import type { ClaimedNotification } from '../../supabase/functions/_shared/notification-sms-core';

function row(overrides: Partial<ClaimedNotification> = {}): ClaimedNotification {
  return {
    notification_id: 'n1',
    notification_type: 'youre_next',
    created_at: '2026-10-07T12:00:00Z',
    dispatch_attempts: 1,
    customer_id: 'c1',
    phone_e164: '+233244123456',
    sms_backup_enabled: true,
    ticket_id: 't1',
    ticket_state: 'almost_turn',
    ticket_number: 'A12',
    branch_name: 'Osu Branch',
    push_enabled: true,
    push_subscriptions: [{ endpoint: 'https://push.example/1', p256dh: 'p', auth: 'a' }],
    ...overrides,
  };
}

describe('shouldAttemptPush', () => {
  it('tries push when it is on and a device is saved', () => {
    expect(shouldAttemptPush(row())).toBe(true);
  });
  it.each([
    ['push switched off', row({ push_enabled: false })],
    ['no devices', row({ push_subscriptions: [] })],
    ['devices unknown', row({ push_subscriptions: null })],
    ['flag unknown', row({ push_enabled: null })],
  ])('does not try push when %s', (_label, n) => {
    expect(shouldAttemptPush(n)).toBe(false);
  });
});

describe('https-only push targets', () => {
  const https = { endpoint: 'https://push.example/1', p256dh: 'p', auth: 'a' };
  const http = { endpoint: 'http://push.example/2', p256dh: 'p', auth: 'a' };
  it('does not try push when every saved endpoint is not https', () => {
    expect(shouldAttemptPush(row({ push_subscriptions: [http] }))).toBe(false);
  });
  it('returns only the https endpoints', () => {
    expect(pushTargets(row({ push_subscriptions: [http, https] }))).toEqual([https]);
  });
  it('returns an empty list when there are no devices', () => {
    expect(pushTargets(row({ push_subscriptions: null }))).toEqual([]);
  });
});

describe('buildPushPayload', () => {
  it.each([
    ['youre_next', "You're next at Osu Branch! Please head over now. Ticket A12.", '/tickets/t1'],
    [
      'your_turn',
      "It's your turn at Osu Branch! Please go to your barber now. Ticket A12.",
      '/tickets/t1',
    ],
    [
      'ticket_released',
      "Your ticket A12 at Osu Branch was released because you weren't available in time. Tap to rejoin.",
      '/tickets/t1',
    ],
  ] as const)('%s', (type, body, url) => {
    expect(buildPushPayload(type, row({ notification_type: type }))).toEqual({
      title: 'Pixel Barber',
      body,
      url,
      tag: 'n1',
    });
  });

  it.each([
    [
      'appointment_reminder_day',
      'Reminder, your appointment at Osu Branch is tomorrow at 2:30 PM.',
    ],
    [
      'appointment_reminder_hour',
      'Your appointment at Osu Branch is today at 2:30 PM, in about an hour.',
    ],
  ] as const)('%s', (type, body) => {
    const n = row({
      notification_type: type,
      ticket_id: null,
      ticket_state: null,
      ticket_number: null,
      appointment_id: 'a1',
      appointment_status: 'scheduled',
      appointment_slot: '2026-10-08T14:30:00+00:00',
      payload_slot: '2026-10-08T14:30:00+00:00',
    });
    expect(buildPushPayload(type, n)).toEqual({
      title: 'Pixel Barber',
      body,
      url: '/appointments/a1',
      tag: 'n1',
    });
  });

  it('falls back to a generic branch name', () => {
    expect(buildPushPayload('youre_next', row({ branch_name: null })).body).toBe(
      "You're next at Pixel Barber! Please head over now. Ticket A12.",
    );
  });
});

describe('pushUrgency and TTL', () => {
  it('is high for the time-critical messages, normal otherwise', () => {
    expect(pushUrgency('youre_next')).toBe('high');
    expect(pushUrgency('your_turn')).toBe('high');
    expect(pushUrgency('ticket_released')).toBe('normal');
    expect(pushUrgency('appointment_reminder_day')).toBe('normal');
    expect(pushUrgency('appointment_reminder_hour')).toBe('normal');
  });
  it('expires after 10 minutes', () => {
    expect(PUSH_TTL_SECONDS).toBe(600);
  });
});

describe('push result decisions', () => {
  it('times out a push after 8 seconds', () => {
    expect(PUSH_TIMEOUT_MS).toBe(8000);
  });
  it('is not delivered when every device failed, so SMS goes out as fallback_sent', () => {
    expect(pushDelivered(['failed', 'failed'])).toBe(false);
    expect(pushDelivered(['gone', 'failed'])).toBe(false);
    expect(pushDelivered([])).toBe(false);
    expect(smsSentStatus(true)).toBe('fallback_sent');
  });
  it('is delivered when any device accepted the push', () => {
    expect(pushDelivered(['failed', 'ok'])).toBe(true);
  });
  it('records a plain sent when no push was attempted', () => {
    expect(smsSentStatus(false)).toBe('sent');
  });
  it('lists only gone endpoints', () => {
    const targets = [
      { endpoint: 'https://a', p256dh: 'p', auth: 'a' },
      { endpoint: 'https://b', p256dh: 'p', auth: 'a' },
      { endpoint: 'https://c', p256dh: 'p', auth: 'a' },
    ];
    expect(goneEndpoints(targets, ['gone', 'ok', 'failed'])).toEqual(['https://a']);
  });
});
