// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { detectPushSupport, urlBase64ToUint8Array } from './pushClient';

const base = {
  userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130',
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  standalone: false,
  maxTouchPoints: 0,
};

describe('detectPushSupport', () => {
  it('is supported when the browser has service workers, push and notifications', () => {
    expect(detectPushSupport(base)).toBe('supported');
  });
  it('asks iPhone users to add to the Home Screen first', () => {
    expect(
      detectPushSupport({
        ...base,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1',
        hasPushManager: false,
        hasNotification: false,
      }),
    ).toBe('ios-install-needed');
  });
  it('is supported on an iPhone running from the Home Screen', () => {
    expect(
      detectPushSupport({
        ...base,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1',
        standalone: true,
      }),
    ).toBe('supported');
  });
  it('treats iPadOS Safari (Macintosh UA with touch) like an iPad', () => {
    expect(
      detectPushSupport({
        ...base,
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
        hasPushManager: false,
        hasNotification: false,
        maxTouchPoints: 5,
      }),
    ).toBe('ios-install-needed');
  });
  it('does not treat a real Mac as an iPad', () => {
    expect(
      detectPushSupport({
        ...base,
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
        hasPushManager: false,
        maxTouchPoints: 0,
      }),
    ).toBe('unsupported');
  });
  it('is unsupported elsewhere without push', () => {
    expect(detectPushSupport({ ...base, hasPushManager: false })).toBe('unsupported');
  });
});

describe('urlBase64ToUint8Array', () => {
  it('decodes base64url to bytes', () => {
    expect(Array.from(urlBase64ToUint8Array('AQID_-8'))).toEqual([1, 2, 3, 255, 239]);
  });
  it('decodes the 65-byte VAPID public key', () => {
    const bytes = urlBase64ToUint8Array(
      'BLBpLpZTjxKRXlHl9nW5ALiiAYCRBd57cMlkombDxmf-4lzUn_2jAJSSIesWhZGmeZsv7jB5lt2i2iLxSl_YVGY',
    );
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(4);
  });
});
