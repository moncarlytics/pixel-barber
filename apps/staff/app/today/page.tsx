'use client';

// Today dashboard (Docs/superpowers/specs/2026-10-08-reports-dashboard-design.md, Section 1):
// branch picker, long-wait banner, right-now and so-far-today numbers, today's ratings for report
// viewers; refreshes every 30 seconds.
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import { loadManageableBranches, type ManageableBranch } from '../settings/barbers/scope';
import { formatMinutes, formatRating, formatTime } from '../reports/format';
import { Metric } from '../reports/Metric';
import type { TodayData } from './todayTypes';

const REFRESH_MS = 30_000;

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Loaded = { key: string; kind: 'ok'; data: TodayData } | { key: string; kind: 'error' };

export default function TodayPage() {
  const t = useTranslations('Today');
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [canView, setCanView] = useState<boolean | null>(null);
  const [branches, setBranches] = useState<ManageableBranch[]>([]);
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  const [branchesFailed, setBranchesFailed] = useState(false);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let cancelled = false;
    supabase.rpc('has_capability', { cap: 'view_branch_dashboard' }).then(({ data }) => {
      if (cancelled) return;
      setCanView(data === true);
      if (data !== true) return;
      loadManageableBranches(supabase)
        .then((list) => {
          if (cancelled) return;
          setBranches(list);
          setBranchesLoaded(true);
          setBranchId((prev) => prev ?? list[0]?.id ?? null);
        })
        .catch(() => {
          if (!cancelled) setBranchesFailed(true);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!branchId) return;
    let cancelled = false;
    const key = branchId;
    supabase.rpc('branch_today', { p_branch_id: branchId }).then(({ data, error }) => {
      if (cancelled) return;
      setLoaded(
        error ? { key, kind: 'error' } : { key, kind: 'ok', data: data as unknown as TodayData },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [supabase, branchId, tick]);

  // Keyed by branch only, so a 30-second refresh keeps showing the previous numbers until the
  // new ones arrive.
  const current = loaded && loaded.key === branchId ? loaded : null;

  return (
    <main>
      <h1>{t('title')}</h1>
      {canView === false && <p>{t('noAccess')}</p>}
      {canView === true && branchesFailed && <p role="alert">{t('loadFailed')}</p>}
      {canView === true && !branchesFailed && branchesLoaded && branches.length === 0 && (
        <p>{t('noBranches')}</p>
      )}
      {branches.length > 0 && (
        <div>
          <label htmlFor="today-branch">{t('branch')}</label>
          <select
            id="today-branch"
            value={branchId ?? ''}
            onChange={(e) => setBranchId(e.target.value)}
          >
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {current?.kind === 'error' && <p role="alert">{t('loadFailed')}</p>}
      {current?.kind === 'ok' && <TodayView data={current.data} t={t as unknown as Translate} />}
    </main>
  );
}

function TodayView({ data: d, t }: { data: TodayData; t: Translate }) {
  return (
    <>
      {d.long_wait.alert && (
        <p
          role="alert"
          style={{ background: '#B91C1C', color: '#FFFFFF', padding: '0.5rem', borderRadius: 4 }}
        >
          {t('longWait', {
            minutes: d.long_wait.current_avg_wait_min ?? 0,
            limit: d.long_wait.threshold_min,
          })}
        </p>
      )}
      <section aria-labelledby="today-now">
        <h2 id="today-now">{t('nowTitle')}</h2>
        <Metric label={t('waiting')} value={d.now.waiting} />
        <Metric label={t('called')} value={d.now.called} />
        <Metric label={t('inService')} value={d.now.in_service} />
        <Metric label={t('appointmentsToCome')} value={d.now.appointments_to_come} />
        <Metric label={t('barbersAvailable')} value={d.now.barbers_available} />
        <Metric label={t('barbersBusy')} value={d.now.barbers_busy} />
      </section>
      <section aria-labelledby="today-so-far">
        <h2 id="today-so-far">{t('todayTitle')}</h2>
        <Metric label={t('served')} value={d.today.served} />
        <Metric label={t('walkIns')} value={d.today.walk_ins} />
        <Metric label={t('appointments')} value={d.today.appointments} />
        <Metric label={t('noShows')} value={d.today.no_shows} />
        <Metric label={t('cancellations')} value={d.today.cancellations} />
        <Metric label={t('avgWait')} value={formatMinutes(d.today.avg_wait_min)} />
        <Metric label={t('avgService')} value={formatMinutes(d.today.avg_service_min)} />
      </section>
      {d.ratings && (
        <section aria-labelledby="today-ratings">
          <h2 id="today-ratings">{t('ratingsTitle')}</h2>
          <p>
            {d.ratings.count === 0
              ? t('ratingsNone')
              : t('ratings', { count: d.ratings.count, average: formatRating(d.ratings.average) })}
          </p>
        </section>
      )}
      <p>{t('updated', { time: formatTime(d.updated_at) })}</p>
    </>
  );
}
