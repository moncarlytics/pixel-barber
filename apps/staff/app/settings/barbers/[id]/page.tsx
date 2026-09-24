// apps/staff/app/settings/barbers/[id]/page.tsx
// Barber detail (App Flow 8.9): regular week, the next 4 weeks, and skills. The barber is looked
// up through list_manageable_barbers(), so a barber the caller can't manage simply isn't found.
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';
import { loadManageableBranches, type ManageableBranch } from '../scope';
import RegularWeek from './RegularWeek';
import SkillsEditor from './SkillsEditor';

type ManageableBarber =
  Database['public']['Functions']['list_manageable_barbers']['Returns'][number];

export default function BarberDetailPage() {
  const t = useTranslations('BarberDetail');
  const params = useParams<{ id: string }>();
  const supabase = createBrowserSupabaseClient();
  const [barber, setBarber] = useState<ManageableBarber | null>(null);
  const [branches, setBranches] = useState<ManageableBranch[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([supabase.rpc('list_manageable_barbers'), loadManageableBranches(supabase)])
      .then(([{ data, error }, manageable]) => {
        if (cancelled) return;
        if (error) {
          setLoadError(true);
          setLoaded(true);
          return;
        }
        setBarber((data ?? []).find((b) => b.barber_id === params.id) ?? null);
        setBranches(manageable);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError(true);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  if (!loaded) return null;
  if (loadError) {
    return (
      <main>
        <p role="alert">{t('loadFailed')}</p>
        <Link href="/settings/barbers">{t('backToList')}</Link>
      </main>
    );
  }
  if (!barber) {
    return (
      <main>
        <p role="alert">{t('notFound')}</p>
        <Link href="/settings/barbers">{t('backToList')}</Link>
      </main>
    );
  }

  // refreshKey is consumed by UpcomingDays in Task 5; referenced here so lint doesn't flag it.
  void refreshKey;

  return (
    <main>
      <Link href="/settings/barbers">{t('backToList')}</Link>
      <h1>{barber.name}</h1>
      <p>{t('homeBranch', { branch: barber.home_branch_name })}</p>
      <RegularWeek
        barberId={barber.barber_id}
        homeBranchId={barber.home_branch_id}
        branches={branches}
        onSaved={() => setRefreshKey((k) => k + 1)}
      />
      <SkillsEditor barberId={barber.barber_id} homeBranchId={barber.home_branch_id} />
    </main>
  );
}
