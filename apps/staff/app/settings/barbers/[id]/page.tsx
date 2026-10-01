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
import UpcomingDays from './UpcomingDays';

type ManageableBarber =
  Database['public']['Functions']['list_manageable_barbers']['Returns'][number];

interface LoadResult {
  forId: string;
  loadError: boolean;
  barber: ManageableBarber | null;
  branches: ManageableBranch[];
}

export default function BarberDetailPage() {
  const t = useTranslations('BarberDetail');
  const params = useParams<{ id: string }>();
  const supabase = createBrowserSupabaseClient();
  // Each load result remembers which barber id it was for, so switching to another barber shows
  // nothing (not the previous barber) until that barber's own result arrives -- derived during
  // render instead of resetting state synchronously inside the effect.
  const [result, setResult] = useState<LoadResult | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const forId = params.id;
    Promise.all([supabase.rpc('list_manageable_barbers'), loadManageableBranches(supabase)])
      .then(([{ data, error }, manageable]) => {
        if (cancelled) return;
        if (error) {
          setResult({ forId, loadError: true, barber: null, branches: [] });
          return;
        }
        setResult({
          forId,
          loadError: false,
          barber: (data ?? []).find((b) => b.barber_id === forId) ?? null,
          branches: manageable,
        });
      })
      .catch(() => {
        if (!cancelled) setResult({ forId, loadError: true, barber: null, branches: [] });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  if (!result || result.forId !== params.id) return null;
  const { loadError, barber, branches } = result;
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
      <UpcomingDays
        barberId={barber.barber_id}
        homeBranchId={barber.home_branch_id}
        branches={branches}
        refreshKey={refreshKey}
      />
      <SkillsEditor barberId={barber.barber_id} homeBranchId={barber.home_branch_id} />
    </main>
  );
}
