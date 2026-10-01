'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';

// Pages someone reaches before they have a staff session: no Log out button there.
const SIGNED_OUT_PATHS = ['/login', '/invite'];

/** Top-of-page bar with a Log out button, shown only while someone is signed in. */
export function StaffHeader() {
  const t = useTranslations('Header');
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
    await supabase.auth.signOut();
    router.push('/login');
  }

  return (
    <header>
      <button type="button" onClick={handleLogOut}>
        {t('logOut')}
      </button>
    </header>
  );
}
