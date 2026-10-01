// tests/unit/notification-sms-core.test.ts
// @vitest-environment node
// Pure rules behind the send-notifications sender, and the shared Arkesel SMS helper.
import { describe, expect, it, vi } from 'vitest';
import { sendArkeselSms } from '../../supabase/functions/_shared/arkesel';
import {
  SMS_NOTIFICATION_TYPES,
  afterProviderError,
  buildNotificationSms,
  buildYoureNextSms,
  decideNotification,
  isUsableCustomerAppUrl,
  parseAllowlist,
  ticketLink,
  type ClaimedNotification,
} from '../../supabase/functions/_shared/notification-sms-core';

const NOW = new Date('2026-09-25T12:00:00Z');

function row(overrides: Partial<ClaimedNotification> = {}): ClaimedNotification {
  return {
    notification_id: 'n1',
    notification_type: 'youre_next',
    created_at: '2026-09-25T11:58:00Z',
    dispatch_attempts: 1,
    customer_id: 'c1',
    phone_e164: '+233244123456',
    sms_backup_enabled: true,
    ticket_id: 't1',
    ticket_state: 'almost_turn',
    ticket_number: 'A12',
    branch_name: 'Osu Branch',
    ...overrides,
  };
}

describe('decideNotification', () => {
  it('sends a fresh, reachable notification when live sending is on', () => {
    expect(decideNotification(row(), NOW, true)).toEqual({ action: 'send' });
  });

  it.each([
    ['stale when the ticket was already called', row({ ticket_state: 'called' }), 'stale'],
    ['stale when the ticket is gone', row({ ticket_state: null, ticket_id: null }), 'stale'],
    ['stale when the ticket dropped back to waiting', row({ ticket_state: 'waiting' }), 'stale'],
    ['expired when older than 10 minutes', row({ created_at: '2026-09-25T11:49:59Z' }), 'expired'],
    ['opted_out when SMS is switched off', row({ sms_backup_enabled: false }), 'opted_out'],
    ['no_phone when there is no number', row({ phone_e164: null }), 'no_phone'],
  ])('%s', (_label, n, reason) => {
    expect(decideNotification(n, NOW, true)).toEqual({ action: 'skip', reason });
  });

  it('records sms_disabled for a sendable row when live sending is off', () => {
    expect(decideNotification(row(), NOW, false)).toEqual({
      action: 'skip',
      reason: 'sms_disabled',
    });
  });

  it('checks in order: stale before expired before opted_out before no_phone before live', () => {
    const everythingWrong = row({
      ticket_state: 'completed',
      created_at: '2026-09-25T10:00:00Z',
      sms_backup_enabled: false,
      phone_e164: null,
    });
    expect(decideNotification(everythingWrong, NOW, false)).toEqual({
      action: 'skip',
      reason: 'stale',
    });
    expect(
      decideNotification(row({ created_at: '2026-09-25T10:00:00Z', phone_e164: null }), NOW, false),
    ).toEqual({ action: 'skip', reason: 'expired' });
    expect(
      decideNotification(row({ sms_backup_enabled: false, phone_e164: null }), NOW, false),
    ).toEqual({ action: 'skip', reason: 'opted_out' });
    expect(decideNotification(row({ phone_e164: null }), NOW, false)).toEqual({
      action: 'skip',
      reason: 'no_phone',
    });
  });

  it('only treats almost_turn as sendable, not waiting', () => {
    expect(decideNotification(row({ ticket_state: 'waiting' }), NOW, true)).toEqual({
      action: 'skip',
      reason: 'stale',
    });
    expect(decideNotification(row({ ticket_state: 'almost_turn' }), NOW, true)).toEqual({
      action: 'send',
    });
  });
});

describe('decideNotification allowlist', () => {
  it('sends when there is no allowlist', () => {
    expect(decideNotification(row(), NOW, true, null)).toEqual({ action: 'send' });
    expect(decideNotification(row(), NOW, true, new Set())).toEqual({ action: 'send' });
  });

  it('skips not_allowlisted when the phone number is not in a non-empty allowlist', () => {
    expect(decideNotification(row(), NOW, true, new Set(['+233200000000']))).toEqual({
      action: 'skip',
      reason: 'not_allowlisted',
    });
  });

  it('sends when the phone number is in the allowlist', () => {
    expect(decideNotification(row(), NOW, true, new Set(['+233244123456']))).toEqual({
      action: 'send',
    });
  });

  it('checks no_phone before not_allowlisted before sms_disabled', () => {
    const allowlist = new Set(['+233200000000']);
    expect(decideNotification(row({ phone_e164: null }), NOW, true, allowlist)).toEqual({
      action: 'skip',
      reason: 'no_phone',
    });
    expect(decideNotification(row(), NOW, false, allowlist)).toEqual({
      action: 'skip',
      reason: 'not_allowlisted',
    });
    expect(decideNotification(row(), NOW, false, null)).toEqual({
      action: 'skip',
      reason: 'sms_disabled',
    });
  });
});

describe('parseAllowlist', () => {
  it('returns null when unset or blank', () => {
    expect(parseAllowlist(undefined)).toBeNull();
    expect(parseAllowlist('')).toBeNull();
    expect(parseAllowlist(' , , ')).toBeNull();
  });

  it('splits on commas, trims, and drops empties', () => {
    expect(parseAllowlist('+233244123456, +233200000000 ,,')).toEqual(
      new Set(['+233244123456', '+233200000000']),
    );
  });
});

describe('isUsableCustomerAppUrl', () => {
  it('rejects empty, localhost and 127.0.0.1', () => {
    expect(isUsableCustomerAppUrl('')).toBe(false);
    expect(isUsableCustomerAppUrl('http://localhost:3000')).toBe(false);
    expect(isUsableCustomerAppUrl('http://127.0.0.1:3000')).toBe(false);
  });

  it('rejects an unparseable URL', () => {
    expect(isUsableCustomerAppUrl('not a url')).toBe(false);
  });

  it('accepts a real origin', () => {
    expect(isUsableCustomerAppUrl('https://app.pixelbarber.example')).toBe(true);
  });
});

describe('message building', () => {
  it('builds the ticket link without a doubled slash', () => {
    expect(ticketLink('https://app.example.com/', 't1')).toBe('https://app.example.com/tickets/t1');
    expect(ticketLink('http://localhost:3000', 't1')).toBe('http://localhost:3000/tickets/t1');
  });

  it("builds the 'you're next' text", () => {
    expect(
      buildYoureNextSms({
        branchName: 'Osu Branch',
        ticketNumber: 'A12',
        link: 'http://x/tickets/t1',
      }),
    ).toBe(
      "Pixel Barber: You're next at Osu Branch! Please head over now. Ticket A12: http://x/tickets/t1",
    );
  });

  it('builds each enabled type through buildNotificationSms', () => {
    const input = { branchName: 'Osu Branch', ticketNumber: 'A12', link: 'http://x/tickets/t1' };
    expect(buildNotificationSms('youre_next', input)).toBe(buildYoureNextSms(input));
    expect(buildNotificationSms('your_turn', input)).toBe(
      "Pixel Barber: It's your turn at Osu Branch! Please go to your barber now. Ticket A12: http://x/tickets/t1",
    );
    expect(buildNotificationSms('ticket_released', input)).toBe(
      "Pixel Barber: Your ticket A12 at Osu Branch was released because you weren't available in time. Rejoin here: http://x/tickets/t1",
    );
  });
});

describe('your_turn and ticket_released', () => {
  it('enables all three types', () => {
    expect([...SMS_NOTIFICATION_TYPES].sort()).toEqual(
      ['ticket_released', 'your_turn', 'youre_next'].sort(),
    );
  });

  it.each([
    ['your_turn', 'called', 'send'],
    ['your_turn', 'grace_period', 'send'],
    ['your_turn', 'in_service', 'stale'],
    ['your_turn', 'cancelled', 'stale'],
    ['your_turn', 'almost_turn', 'stale'],
    ['ticket_released', 'no_show', 'send'],
    ['ticket_released', 'waiting', 'stale'],
    ['ticket_released', 'called', 'stale'],
    ['youre_next', 'called', 'stale'],
  ])('%s with the ticket in %s → %s', (type, state, expected) => {
    const decision = decideNotification(
      row({ notification_type: type, ticket_state: state }),
      NOW,
      true,
    );
    expect(decision).toEqual(
      expected === 'send' ? { action: 'send' } : { action: 'skip', reason: expected },
    );
  });

  it('treats an unknown notification type as stale, never sendable', () => {
    expect(
      decideNotification(
        row({ notification_type: 'ticket_created', ticket_state: 'waiting' }),
        NOW,
        true,
      ),
    ).toEqual({ action: 'skip', reason: 'stale' });
  });

  it('keeps the same safety rules for the new types', () => {
    const turn = row({ notification_type: 'your_turn', ticket_state: 'called' });
    expect(decideNotification({ ...turn, created_at: '2026-09-25T11:49:59Z' }, NOW, true)).toEqual({
      action: 'skip',
      reason: 'expired',
    });
    expect(decideNotification(turn, NOW, false)).toEqual({
      action: 'skip',
      reason: 'sms_disabled',
    });
    expect(decideNotification(turn, NOW, true, new Set(['+233200000000']))).toEqual({
      action: 'skip',
      reason: 'not_allowlisted',
    });
  });
});

describe('afterProviderError', () => {
  it('retries until the third attempt, then fails', () => {
    expect(afterProviderError(1)).toBe('retry');
    expect(afterProviderError(2)).toBe('retry');
    expect(afterProviderError(3)).toBe('fail');
  });
});

describe('sendArkeselSms', () => {
  const config = { apiKey: 'ak', senderId: 'PixelBarbr' };
  const stub = (status: number, body: string) => vi.fn(async () => new Response(body, { status }));

  it('sends through Arkesel', async () => {
    const fetchImpl = stub(200, '{"status":"success"}');
    expect(await sendArkeselSms('+233244123456', 'hello', config, fetchImpl)).toBe('sent');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://sms.arkesel.com/api/v2/sms/send');
    expect((init.headers as Record<string, string>)['api-key']).toBe('ak');
    expect(JSON.parse(init.body as string)).toEqual({
      sender: 'PixelBarbr',
      message: 'hello',
      recipients: ['+233244123456'],
    });
  });

  it('reports not_configured without secrets', async () => {
    expect(
      await sendArkeselSms(
        '+233244123456',
        'x',
        { apiKey: undefined, senderId: 'S' },
        stub(200, '{}'),
      ),
    ).toBe('not_configured');
  });

  it('reports provider_error on a failure body, an HTTP error, or a thrown call', async () => {
    expect(
      await sendArkeselSms('+233244123456', 'x', config, stub(200, '{"status":"error"}')),
    ).toBe('provider_error');
    expect(await sendArkeselSms('+233244123456', 'x', config, stub(500, 'boom'))).toBe(
      'provider_error',
    );
    const throwing = vi.fn(async () => {
      throw new Error('network');
    });
    expect(await sendArkeselSms('+233244123456', 'x', config, throwing)).toBe('provider_error');
  });

  it('reports unknown_outcome when the request times out, since Arkesel may already have sent it', async () => {
    const timingOut = vi.fn(async () => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    expect(await sendArkeselSms('+233244123456', 'x', config, timingOut)).toBe('unknown_outcome');

    const aborting = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError');
    });
    expect(await sendArkeselSms('+233244123456', 'x', config, aborting)).toBe('unknown_outcome');
  });
});
