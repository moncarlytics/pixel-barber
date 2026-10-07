'use client';

// After-visit rating (Docs/superpowers/specs/2026-10-07-after-visit-feedback-design.md): overall
// stars required, optional comment and five optional detail rows. Shown for completed tickets
// within 7 days; a ticket that already has feedback shows the thank-you state.
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import { feedbackErrorKey } from '../feedbackErrors';

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DETAILS = [
  { key: 'serviceQuality', param: 'p_service_quality' },
  { key: 'barberProfessionalism', param: 'p_barber_professionalism' },
  { key: 'waitingExperience', param: 'p_waiting_experience' },
  { key: 'cleanliness', param: 'p_cleanliness' },
  { key: 'value', param: 'p_value' },
] as const;
type DetailParam = (typeof DETAILS)[number]['param'];
type View = 'loading' | 'form' | 'thanks' | 'closed' | 'hidden';

function StarRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (n: number) => void;
}) {
  const t = useTranslations('Feedback');
  return (
    <div role="group" aria-label={label}>
      <span>{label}</span>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          aria-pressed={value !== null && n <= value}
          aria-label={t('stars', { count: n })}
          onClick={() => onChange(n)}
        >
          {value !== null && n <= value ? '★' : '☆'}
        </button>
      ))}
    </div>
  );
}

export default function FeedbackForm({
  ticketId,
  completedAt,
}: {
  ticketId: string;
  completedAt: string | null;
}) {
  const t = useTranslations('Feedback');
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [view, setView] = useState<View>('loading');
  const [overall, setOverall] = useState<number | null>(null);
  const [details, setDetails] = useState<Partial<Record<DetailParam, number>>>({});
  const [showDetails, setShowDetails] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [thanksStars, setThanksStars] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from('feedback')
      .select('overall_rating')
      .eq('ticket_id', ticketId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        if (data) {
          setThanksStars(data.overall_rating);
          setView('thanks');
          return;
        }
        const open = completedAt === null || Date.parse(completedAt) > Date.now() - WINDOW_MS;
        setView(open ? 'form' : 'hidden');
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, ticketId, completedAt]);

  async function send() {
    if (overall === null) return;
    setBusy(true);
    setFailed(false);
    try {
      const { error } = await supabase.rpc('submit_feedback', {
        p_ticket_id: ticketId,
        p_overall: overall,
        ...details,
        p_comment: comment,
      });
      if (!error) {
        setThanksStars(overall);
        setView('thanks');
        return;
      }
      const key = feedbackErrorKey(error.message);
      if (key === 'thanks') setView('thanks');
      else if (key === 'closed') setView('closed');
      else setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (view === 'loading' || view === 'hidden') return null;
  if (view === 'closed') return <p>{t('closed')}</p>;
  if (view === 'thanks') {
    return (
      <p>
        {t('thanks')}
        {thanksStars !== null && ` ${'★'.repeat(thanksStars)}`}
      </p>
    );
  }
  return (
    <section aria-label={t('title')}>
      <h2>{t('title')}</h2>
      <StarRow label={t('title')} value={overall} onChange={setOverall} />
      {!showDetails && (
        <button type="button" onClick={() => setShowDetails(true)}>
          {t('tellUsMore')}
        </button>
      )}
      {showDetails &&
        DETAILS.map((d) => (
          <StarRow
            key={d.key}
            label={t(d.key)}
            value={details[d.param] ?? null}
            onChange={(n) => setDetails((prev) => ({ ...prev, [d.param]: n }))}
          />
        ))}
      <textarea
        maxLength={1000}
        placeholder={t('commentPlaceholder')}
        aria-label={t('commentPlaceholder')}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
      {failed && <p role="alert">{t('failed')}</p>}
      <button type="button" disabled={overall === null || busy} onClick={send}>
        {t('send')}
      </button>
    </section>
  );
}
