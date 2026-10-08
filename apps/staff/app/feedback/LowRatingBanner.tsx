'use client';

// Red "new low rating" banner for owners/branch managers (list_unseen_low_feedback_count returns 0
// for everyone else). Refreshes on load, every 60 s, and when the Feedback page marks one seen.
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';

export const FEEDBACK_SEEN_EVENT = 'pixelbarber:feedback-seen';

export function LowRatingBanner() {
  const t = useTranslations('Feedback');
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      supabase.rpc('list_unseen_low_feedback_count').then(({ data, error }) => {
        if (!cancelled && !error) setCount(data ?? 0);
      });
    };
    load();
    const timer = setInterval(load, 60_000);
    window.addEventListener(FEEDBACK_SEEN_EVENT, load);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener(FEEDBACK_SEEN_EVENT, load);
    };
  }, [supabase]);

  if (count === 0) return null;
  return (
    <Link
      href="/feedback"
      style={{ background: '#B91C1C', color: '#FFFFFF', padding: '0.25rem 0.5rem' }}
    >
      {t('banner', { count })}
    </Link>
  );
}
