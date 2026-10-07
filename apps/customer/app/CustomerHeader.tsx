'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import { disablePush } from './push/pushClient';

// Pages someone uses before they have a customer session (or mid sign-up): no menu there.
const SIGNED_OUT_PATHS = ['/login', '/onboard', '/forgot-password'];

/** Top-of-page menu (Branches, My Tickets, Profile, Log out), shown only while signed in. */
export function CustomerHeader() {
  const t = useTranslations('Nav');
  const router = useRouter();
  const pathname = usePathname();
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSignedIn(data.session !== null));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setSignedIn(session !== null);
    });
    return () => data.subscription.unsubscribe();
  }, [supabase]);

  const onSignedOutPage = SIGNED_OUT_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
  if (!signedIn || onSignedOutPage) return null;

  async function handleLogOut() {
    // Stop this device's notifications first, so a shared phone doesn't keep getting them.
    await disablePush(supabase);
    await supabase.auth.signOut();
    router.push('/');
  }

  return (
    <header>
      <nav>
        <Link href="/">{t('branches')}</Link>
        <Link href="/tickets">{t('tickets')}</Link>
        <Link href="/profile">{t('profile')}</Link>
        <button type="button" onClick={handleLogOut}>
          {t('logOut')}
        </button>
      </nav>
    </header>
  );
}
