'use client';

// Staff Feedback page (Docs/superpowers/specs/2026-10-07-after-visit-feedback-design.md): branch
// picker, 30-day summary, latest ratings with low ones highlighted and Mark as seen for
// owners/branch managers.
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';
import { loadManageableBranches, type ManageableBranch } from '../settings/barbers/scope';
import { FEEDBACK_SEEN_EVENT } from './LowRatingBanner';

type Row = Database['public']['Functions']['list_branch_feedback']['Returns'][number];
type Loaded =
  | { key: string; kind: 'ok'; rows: Row[]; average: number | null; count: number }
  | { key: string; kind: 'error' };

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });

export default function FeedbackPage() {
  const t = useTranslations('Feedback');
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [branches, setBranches] = useState<ManageableBranch[]>([]);
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [canEscalate, setCanEscalate] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const requestKey = `${branchId}:${reloadKey}`;

  useEffect(() => {
    let cancelled = false;
    loadManageableBranches(supabase)
      .then((list) => {
        if (cancelled) return;
        setBranches(list);
        setBranchesLoaded(true);
        setBranchId((prev) => prev ?? list[0]?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setBranchesLoaded(true);
      });
    supabase.rpc('has_capability', { cap: 'handle_escalations' }).then(({ data }) => {
      if (!cancelled) setCanEscalate(data === true);
    });
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  useEffect(() => {
    if (!branchId) return;
    let cancelled = false;
    Promise.all([
      supabase.rpc('list_branch_feedback', { p_branch_id: branchId }),
      supabase.rpc('branch_feedback_summary', { p_branch_id: branchId }),
    ]).then(([list, summary]) => {
      if (cancelled) return;
      if (list.error || summary.error) {
        setLoaded({ key: requestKey, kind: 'error' });
        return;
      }
      const s = summary.data?.[0];
      setLoaded({
        key: requestKey,
        kind: 'ok',
        rows: list.data ?? [],
        average: s?.average_rating ?? null,
        count: s?.rating_count ?? 0,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [supabase, branchId, requestKey]);

  async function markSeen(id: string) {
    const { error } = await supabase.rpc('mark_feedback_seen', { p_feedback_id: id });
    if (!error) window.dispatchEvent(new Event(FEEDBACK_SEEN_EVENT));
    setReloadKey((k) => k + 1);
  }

  const current = loaded && loaded.key === requestKey ? loaded : null;

  return (
    <main>
      <h1>{t('title')}</h1>
      {branchesLoaded && branches.length === 0 && <p>{t('noBranches')}</p>}
      {branches.length > 0 && (
        <div>
          <label htmlFor="feedback-branch">{t('branch')}</label>
          <select
            id="feedback-branch"
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
      {current?.kind === 'ok' && (
        <>
          <p>
            {current.count === 0
              ? t('summaryNone')
              : t('summary', {
                  average: Number(current.average).toFixed(2),
                  count: current.count,
                })}
          </p>
          {current.rows.length === 0 ? (
            <p>{t('empty')}</p>
          ) : (
            <ul>
              {current.rows.map((r) => {
                const low = r.overall_rating <= 2;
                const hasDetails = [
                  r.service_quality_rating,
                  r.barber_professionalism_rating,
                  r.waiting_experience_rating,
                  r.cleanliness_rating,
                  r.value_rating,
                ].some((v) => v !== null);
                return (
                  <li
                    key={r.id}
                    style={
                      low ? { borderLeft: '4px solid #B91C1C', paddingLeft: '0.5rem' } : undefined
                    }
                  >
                    <p>
                      {t('line', {
                        date: formatDate(r.created_at),
                        customer: r.customer_first_name,
                        barber: r.barber_name,
                        service: r.service_name,
                      })}
                    </p>
                    <p>{t('stars', { count: r.overall_rating })}</p>
                    {hasDetails && (
                      <p>
                        {t('details', {
                          service: r.service_quality_rating ?? '—',
                          professionalism: r.barber_professionalism_rating ?? '—',
                          waiting: r.waiting_experience_rating ?? '—',
                          cleanliness: r.cleanliness_rating ?? '—',
                          value: r.value_rating ?? '—',
                        })}
                      </p>
                    )}
                    {r.comment && <p>{r.comment}</p>}
                    {low && r.seen_at && (
                      <p>
                        {t('seenBy', { name: r.seen_by_name ?? '—', date: formatDate(r.seen_at) })}
                      </p>
                    )}
                    {low && !r.seen_at && canEscalate && (
                      <button type="button" onClick={() => markSeen(r.id)}>
                        {t('markSeen')}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
