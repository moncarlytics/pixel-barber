// Web push on this device (Docs/superpowers/specs/2026-10-07-web-push-notifications-design.md):
// detect support, subscribe and save the subscription, unsubscribe and remove it.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';
import { VAPID_PUBLIC_KEY } from './vapidPublicKey';

export type PushSupport = 'supported' | 'ios-install-needed' | 'unsupported';

export interface PushEnv {
  userAgent: string;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  /** Running as an installed (Home Screen) app. */
  standalone: boolean;
  /** navigator.maxTouchPoints (iPadOS Safari reports a Macintosh user agent but has touch). */
  maxTouchPoints: number;
}

export function detectPushSupport(env: PushEnv): PushSupport {
  if (env.hasServiceWorker && env.hasPushManager && env.hasNotification) return 'supported';
  // iPhone/iPad Safari only exposes push to apps added to the Home Screen.
  const isIos =
    /iPhone|iPad|iPod/.test(env.userAgent) ||
    (env.userAgent.includes('Macintosh') && env.maxTouchPoints > 1);
  if (isIos && !env.standalone) return 'ios-install-needed';
  return 'unsupported';
}

export function browserPushEnv(): PushEnv {
  return {
    userAgent: navigator.userAgent,
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPushManager: 'PushManager' in window,
    hasNotification: 'Notification' in window,
    standalone:
      (navigator as Navigator & { standalone?: boolean }).standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  };
}

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** This device's active push subscription, if any. */
export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration('/');
  return registration ? registration.pushManager.getSubscription() : null;
}

export type EnableResult = 'enabled' | 'denied' | 'unsupported' | 'failed';

/** Asks permission, registers the service worker, subscribes and saves the subscription. */
export async function enablePush(supabase: SupabaseClient<Database>): Promise<EnableResult> {
  if (detectPushSupport(browserPushEnv()) !== 'supported') return 'unsupported';
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return 'denied';
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    const registration = await navigator.serviceWorker.ready;
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      }));
    const json = subscription.toJSON();
    const { error } = await supabase.rpc('save_push_subscription', {
      p_endpoint: subscription.endpoint,
      p_p256dh: json.keys?.p256dh ?? '',
      p_auth: json.keys?.auth ?? '',
      p_user_agent: navigator.userAgent,
    });
    return error ? 'failed' : 'enabled';
  } catch {
    return 'failed';
  }
}

/** Removes this device's saved subscription and unsubscribes it (quietly does nothing if none). */
export async function disablePush(supabase: SupabaseClient<Database>): Promise<void> {
  const subscription = await currentPushSubscription().catch(() => null);
  if (!subscription) return;
  await supabase.rpc('remove_push_subscription', { p_endpoint: subscription.endpoint });
  await subscription.unsubscribe().catch(() => false);
}

/** Whether this browser subscription is saved for the signed-in customer (RLS limits the select to
 * their own rows). False on error. */
export async function isThisDeviceSaved(
  supabase: SupabaseClient<Database>,
  subscription: PushSubscription,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('push_subscriptions')
    .select('endpoint')
    .eq('endpoint', subscription.endpoint)
    .limit(1);
  return !error && (data?.length ?? 0) > 0;
}
