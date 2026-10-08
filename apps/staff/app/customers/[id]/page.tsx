'use client';

// Customer page (Docs/superpowers/specs/2026-10-08-customer-list-design.md, Section 2): contact,
// group and reason, in-branch numbers, settings, visits, feedback, messages, and Message customer.
import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import { loadManageableBranches, type ManageableBranch } from '../../settings/barbers/scope';
import { formatDay, formatRating } from '../../reports/format';
import { Metric } from '../../reports/Metric';
import { deliveryLabel, groupReason, visitOutcome } from '../customerLabels';
import type { CustomerDetail } from '../customerTypes';
import { MessageForm } from './MessageForm';

const ALL = 'all';

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Supabase = ReturnType<typeof createBrowserSupabaseClient>;
type Loaded =
  | { scope: string; kind: 'ok'; detail: CustomerDetail }
  | { scope: string; kind: 'notFound' | 'error' };

function CustomerPageInner() {
  const t = useTranslations('Customers') as unknown as Translate;
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const { id } = useParams<{ id: string }>();
  const branchParam = useSearchParams().get('branch');
  const [canView, setCanView] = useState<boolean | null>(null);
  const [canMessage, setCanMessage] = useState(false);
  const [branches, setBranches] = useState<ManageableBranch[] | null>(null);
  const [branchesFailed, setBranchesFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let cancelled = false;
    supabase.rpc('has_capability', { cap: 'view_customers' }).then(({ data }) => {
      if (cancelled) return;
      setCanView(data === true);
      if (data !== true) return;
      loadManageableBranches(supabase)
        .then((list) => {
          if (!cancelled) setBranches(list);
        })
        .catch(() => {
          if (!cancelled) setBranchesFailed(true);
        });
    });
    supabase.rpc('has_capability', { cap: 'message_customers' }).then(({ data }) => {
      if (!cancelled) setCanMessage(data === true);
    });
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const ids = useMemo(() => {
    if (!branches) return [];
    if (branchParam && branchParam !== ALL && branches.some((b) => b.id === branchParam)) {
      return [branchParam];
    }
    return branches.map((b) => b.id);
  }, [branches, branchParam]);
  // The detail is keyed by customer + branches only, so a refresh after sending keeps the previous
  // detail on screen until the new one arrives.
  const scope = `${id}:${ids.join(',')}`;

  useEffect(() => {
    if (ids.length === 0) return;
    let cancelled = false;
    const key = scope;
    supabase
      .rpc('customer_detail', { p_customer_id: id, p_branch_ids: ids })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setLoaded({ scope: key, kind: error.message === 'not_found' ? 'notFound' : 'error' });
          return;
        }
        setLoaded({ scope: key, kind: 'ok', detail: data as unknown as CustomerDetail });
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, id, ids, scope, reloadKey]);

  const current = loaded && loaded.scope === scope ? loaded : null;

  return (
    <main>
      <Link href="/customers">{t('back')}</Link>
      {canView === false && <p>{t('noAccess')}</p>}
      {branchesFailed && <p role="alert">{t('detailLoadFailed')}</p>}
      {current?.kind === 'notFound' && <p>{t('notFound')}</p>}
      {current?.kind === 'error' && <p role="alert">{t('detailLoadFailed')}</p>}
      {current?.kind === 'ok' && (
        <CustomerView
          detail={current.detail}
          t={t}
          messageBranches={
            canMessage && branches
              ? branches.filter((b) => current.detail.branch_ids.includes(b.id))
              : []
          }
          supabase={supabase}
          onSent={() => setReloadKey((k) => k + 1)}
        />
      )}
    </main>
  );
}

function CustomerView({
  detail: d,
  t,
  messageBranches,
  supabase,
  onSent,
}: {
  detail: CustomerDetail;
  t: Translate;
  messageBranches: ManageableBranch[];
  supabase: Supabase;
  onSent: () => void;
}) {
  const reason = groupReason(d.group, d.stats);
  const onOff = (v: boolean) => t(v ? 'on' : 'off');
  return (
    <>
      <h1>{d.customer.name}</h1>
      <section aria-labelledby="customer-contact">
        <h2 id="customer-contact">{t('contactTitle')}</h2>
        {d.customer.phone && <p>{t('phoneLabel', { phone: d.customer.phone })}</p>}
        {d.customer.email && <p>{t('emailLabel', { email: d.customer.email })}</p>}
        <p>{t(reason.key, reason.values)}</p>
        <p>
          {t('confirmationCall', {
            answer: t(d.customer.requires_confirmation_call ? 'yes' : 'no'),
          })}
        </p>
      </section>
      <section aria-labelledby="customer-numbers">
        <h2 id="customer-numbers">{t('numbersTitle')}</h2>
        <Metric label={t('columns.visits')} value={d.stats.visits} />
        <Metric
          label={t('lastVisitLabel')}
          value={d.stats.last_visit_at ? formatDay(d.stats.last_visit_at) : '—'}
        />
        <Metric label={t('appointments')} value={d.stats.appointments} />
        <Metric label={t('columns.noShows')} value={d.stats.no_shows} />
        <Metric label={t('cancellations')} value={d.stats.cancellations} />
        <Metric label={t('lateCancellations')} value={d.stats.late_cancellations} />
        <Metric label={t('columns.avgRating')} value={formatRating(d.stats.avg_rating_given)} />
      </section>
      <section aria-labelledby="customer-settings">
        <h2 id="customer-settings">{t('settingsTitle')}</h2>
        <p>{t('appNotifications', { state: onOff(d.customer.push_enabled) })}</p>
        <p>{t('smsBackup', { state: onOff(d.customer.sms_backup_enabled) })}</p>
        <p>
          {t('promotions', { state: t(d.customer.marketing_allowed ? 'allowed' : 'notAllowed') })}
        </p>
      </section>
      {messageBranches.length > 0 && (
        <MessageForm
          supabase={supabase}
          customerId={d.customer.id}
          branches={messageBranches}
          t={t}
          onSent={onSent}
        />
      )}
      <section aria-labelledby="customer-history">
        <h2 id="customer-history">{t('historyTitle')}</h2>
        {d.visits.length === 0 ? (
          <p>{t('noVisits')}</p>
        ) : (
          <ul>
            {d.visits.map((v) => {
              const o = visitOutcome(v.state, v.cancel_reason);
              const outcome = o.reasonKey ? t(o.key, { reason: t(o.reasonKey) }) : t(o.key);
              return (
                <li key={v.ticket_id}>
                  {[
                    formatDay(v.created_at),
                    v.branch_name,
                    v.service_name,
                    v.barber_name ?? '—',
                    outcome,
                  ].join(' · ')}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section aria-labelledby="customer-feedback">
        <h2 id="customer-feedback">{t('feedbackTitle')}</h2>
        {d.feedback.length === 0 ? (
          <p>{t('noFeedback')}</p>
        ) : (
          <ul>
            {d.feedback.map((fb) => (
              <li key={`${fb.created_at}-${fb.branch_name}`}>
                {[
                  formatDay(fb.created_at),
                  fb.branch_name,
                  fb.barber_name ?? '—',
                  t('stars', { count: fb.overall_rating }),
                ].join(' · ')}
                {fb.comment && <p>{fb.comment}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="customer-messages">
        <h2 id="customer-messages">{t('messagesTitle')}</h2>
        {d.messages.length === 0 ? (
          <p>{t('noMessages')}</p>
        ) : (
          <ul>
            {d.messages.map((m) => {
              const label = deliveryLabel(m.status, m.failed_reason);
              return (
                <li key={m.id}>
                  <p>
                    {[
                      formatDay(m.created_at),
                      m.branch_name ?? '—',
                      t('sentBy', { name: m.sent_by_name ?? '—' }),
                    ].join(' · ')}
                  </p>
                  <p>{m.text}</p>
                  <p>
                    {t(label.key)}
                    {label.reasonKey ? ` · ${t(label.reasonKey)}` : ''}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

export default function CustomerPage() {
  return (
    <Suspense fallback={null}>
      <CustomerPageInner />
    </Suspense>
  );
}
