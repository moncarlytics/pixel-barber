'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';

export default function Home() {
  const t = useTranslations('Home');
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  // null until the session check finishes, so "Log in" doesn't flash for a signed-in user.
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSignedIn(data.session !== null));
  }, [supabase]);

  return (
    <main>
      <h1>{t('title')}</h1>
      {signedIn === false && <Link href="/login">{t('logIn')}</Link>}
      <Link href="/settings/branch">Branch Settings</Link>
      <Link href="/settings/services">Services & Pricing</Link>
      <Link href="/settings/barbers">{t('barbersLink')}</Link>
      <Link href="/settings/staff">{t('staffLink')}</Link>
    </main>
  );
}
