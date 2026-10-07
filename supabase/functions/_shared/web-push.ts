// supabase/functions/_shared/web-push.ts
// Sends one Web Push message (RFC 8291/8292) with VAPID, via the Deno-native jsr:@negrel/webpush.
// Deno-only (jsr import), so it is exercised by the deployed-function test, not Vitest.
import * as webpush from 'jsr:@negrel/webpush@0.5.0';
import type { PushTarget } from './notification-sms-core.ts';
import type { PushPayload } from './notification-push-core.ts';

export interface PushConfig {
  /** JSON of { publicKey: JsonWebKey, privateKey: JsonWebKey } (secret VAPID_KEYS_JSON). */
  keysJson: string;
  /** VAPID contact: an https URL or mailto: (secret VAPID_SUBJECT). */
  subject: string;
}

export type PushResult = 'ok' | 'gone' | 'failed';

/** Reads the VAPID secrets; null when either is missing (push is then not attempted). */
export function loadPushConfig(): PushConfig | null {
  const keysJson = Deno.env.get('VAPID_KEYS_JSON');
  const subject = Deno.env.get('VAPID_SUBJECT');
  return keysJson && subject ? { keysJson, subject } : null;
}

let serverPromise: Promise<webpush.ApplicationServer> | null = null;

function applicationServer(config: PushConfig): Promise<webpush.ApplicationServer> {
  if (!serverPromise) {
    serverPromise = (async () => {
      const vapidKeys = await webpush.importVapidKeys(JSON.parse(config.keysJson), {
        extractable: false,
      });
      return webpush.ApplicationServer.new({ contactInformation: config.subject, vapidKeys });
    })();
    // A failed import must not be cached forever.
    serverPromise.catch(() => {
      serverPromise = null;
    });
  }
  return serverPromise;
}

/** 'gone' = the push service says this subscription no longer exists (404/410): delete it. */
export async function sendWebPush(
  config: PushConfig,
  target: PushTarget,
  payload: PushPayload,
  options: { ttl: number; urgency: 'high' | 'normal' },
): Promise<PushResult> {
  try {
    const server = await applicationServer(config);
    const subscriber = server.subscribe({
      endpoint: target.endpoint,
      keys: { p256dh: target.p256dh, auth: target.auth },
    });
    await subscriber.pushTextMessage(JSON.stringify(payload), {
      ttl: options.ttl,
      urgency: options.urgency === 'high' ? webpush.Urgency.High : webpush.Urgency.Normal,
    });
    return 'ok';
  } catch (error) {
    if (error instanceof webpush.PushMessageError) {
      const status = error.response.status;
      if (status === 404 || status === 410) return 'gone';
      console.error('send-notifications: push rejected', { status, endpoint: target.endpoint });
    } else {
      console.error('send-notifications: push error', { error: String(error) });
    }
    return 'failed';
  }
}
