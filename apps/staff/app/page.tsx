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

  const [canViewReports, setCanViewReports] = useState(false);
  const [canViewDashboard, setCanViewDashboard] = useState(false);
  const [canViewCustomers, setCanViewCustomers] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSignedIn(data.session !== null));
    supabase
      .rpc('has_capability', { cap: 'view_branch_reports' })
      .then(({ data }) => setCanViewReports(data === true));
    supabase
      .rpc('has_capability', { cap: 'view_branch_dashboard' })
      .then(({ data }) => setCanViewDashboard(data === true));
    supabase
      .rpc('has_capability', { cap: 'view_customers' })
      .then(({ data }) => setCanViewCustomers(data === true));
  }, [supabase]);

  return (
    <main>
      <h1>{t('title')}</h1>
      {signedIn === false && <Link href="/login">{t('logIn')}</Link>}
      {canViewDashboard && <Link href="/today">{t('todayLink')}</Link>}
      {canViewReports && <Link href="/reports">{t('reportsLink')}</Link>}
      {canViewCustomers && <Link href="/customers">{t('customersLink')}</Link>}
      <Link href="/settings/branch">Branch Settings</Link>
      <Link href="/settings/services">Services & Pricing</Link>
      <Link href="/settings/barbers">{t('barbersLink')}</Link>
      <Link href="/settings/staff">{t('staffLink')}</Link>
      <Link href="/appointments">{t('appointmentsLink')}</Link>
      {canViewReports && <Link href="/feedback">{t('feedbackLink')}</Link>}
    </main>
  );
}
