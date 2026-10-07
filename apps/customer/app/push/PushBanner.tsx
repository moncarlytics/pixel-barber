'use client';

// "Turn on notifications" offer for this device (web push spec, Section 1): shown when the browser
// supports push, permission isn't denied and this device has no subscription saved for this customer; on an iPhone
// outside the Home Screen it shows the Add-to-Home-Screen hint instead.
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import {
  browserPushEnv,
  currentPushSubscription,
  detectPushSupport,
  enablePush,
  isThisDeviceSaved,
} from './pushClient';

type BannerState = 'hidden' | 'offer' | 'ios' | 'off';

export default function PushBanner() {
  const t = useTranslations('Push');
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [state, setState] = useState<BannerState>('hidden');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const support = detectPushSupport(browserPushEnv());
    if (support === 'ios-install-needed') {
      queueMicrotask(() => {
        if (!cancelled) setState('ios');
      });
    } else if (support === 'supported' && Notification.permission !== 'denied') {
      currentPushSubscription()
        .then(async (subscription) => {
          const saved = subscription ? await isThisDeviceSaved(supabase, subscription) : false;
          if (!cancelled && !saved) setState('offer');
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  async function turnOn() {
    setBusy(true);
    try {
      const result = await enablePush(supabase);
      setState(result === 'enabled' || result === 'denied' ? 'hidden' : 'off');
    } finally {
      setBusy(false);
    }
  }

  if (state === 'hidden') return null;
  if (state === 'ios') return <p>{t('iosHint')}</p>;
  if (state === 'off') return <p>{t('off')}</p>;
  return (
    <div>
      <p>{t('bannerText')}</p>
      <button type="button" disabled={busy} onClick={turnOn}>
        {t('turnOn')}
      </button>
    </div>
  );
}
