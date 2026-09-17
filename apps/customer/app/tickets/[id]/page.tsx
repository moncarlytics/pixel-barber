'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  createBrowserSupabaseClient,
  AVATAR_LIBRARY,
  updateTicketWithVersion,
} from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';

type Ticket = Database['public']['Tables']['queue_tickets']['Row'];
type Customer = Database['public']['Tables']['customers']['Row'];

const CANCEL_REASONS = [
  'wait_too_long',
  'cant_make_it',
  'changed_plans',
  'found_another_barber',
  'emergency',
  'other',
] as const;

export default function TicketTrackingPage() {
  const t = useTranslations('TicketTracking');
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const supabase = createBrowserSupabaseClient();

  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [showCancelSheet, setShowCancelSheet] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const { data } = await supabase
        .from('queue_tickets')
        .select('*')
        .eq('id', params.id)
        .single();
      if (!cancelled) setTicket(data ?? null);
    }
    load();

    supabase.auth.getUser().then(async ({ data: userData }) => {
      if (!userData.user || cancelled) return;
      const { data: customerRow } = await supabase
        .from('customers')
        .select('*')
        .eq('auth_user_id', userData.user.id)
        .single();
      if (!cancelled) setCustomer(customerRow ?? null);
    });

    // Realtime: this screen's whole reason for existing is updating without a manual refresh
    // (App Flow 7.6) -- position/wait estimate/status all live on the same row.
    const channel = supabase
      .channel(`ticket-${params.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'queue_tickets', filter: `id=eq.${params.id}` },
        (payload) => {
          if (!cancelled) setTicket(payload.new as Ticket);
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [params.id]);

  async function handleCancel(reason: (typeof CANCEL_REASONS)[number]) {
    if (!ticket) return;
    setError(null);
    const result = await updateTicketWithVersion(supabase, ticket.id, ticket.version, {
      state: 'cancelled',
      cancel_reason: reason,
      cancelled_at: new Date().toISOString(),
    });
    if (!result.success) {
      if (result.reason === 'conflict') {
        // PRD 34: the loser of a race sees the current state, not a silent overwrite or a raw error.
        const { data: latest } = await supabase
          .from('queue_tickets')
          .select('*')
          .eq('id', ticket.id)
          .single();
        setTicket(latest ?? ticket);
        setError(t('conflictMessage'));
      } else {
        setError(t('actionFailed'));
      }
      setShowCancelSheet(false);
      return;
    }
    setTicket(result.ticket as Ticket);
    setShowCancelSheet(false);
  }

  if (!ticket) return null;

  const avatar = customer ? AVATAR_LIBRARY.find((a) => a.key === customer.avatar_key) : null;
  const isReleased = ticket.state === 'no_show' || ticket.state === 'cancelled';
  const isCompleted = ticket.state === 'completed';
  const isActive = !isReleased && !isCompleted;

  return (
    <main>
      {error && <p role="alert">{error}</p>}
      <h1>{ticket.ticket_number}</h1>

      {/* PRD 18: the avatar/animation visualizes state already shown in text below -- never the
          other way around. A reduced-motion media query (globals.css) disables the CSS transition
          on .queue-avatar-track without hiding the position text it's layered over. */}
      <div className="queue-avatar-track" aria-hidden="true">
        {avatar && (
          <span style={{ marginLeft: `${Math.max(0, 100 - (ticket.position ?? 0) * 10)}%` }}>
            {avatar.emoji}
          </span>
        )}
      </div>

      {isActive && (
        <>
          <p>{t('positionLabel', { position: ticket.position ?? '—' })}</p>
          <p>
            {t('aheadLabel', {
              count: ticket.position !== null ? Math.max(0, ticket.position - 1) : '—',
            })}
          </p>
          {ticket.estimated_wait_low_min !== null && ticket.estimated_wait_high_min !== null && (
            <p>
              {t('waitEstimateLabel', {
                low: ticket.estimated_wait_low_min,
                high: ticket.estimated_wait_high_min,
              })}
            </p>
          )}
          <p>
            {ticket.state === 'almost_turn'
              ? t('stateAlmostTurn')
              : ticket.state === 'called' ||
                  ticket.state === 'confirmed' ||
                  ticket.state === 'in_service'
                ? t('stateCalled')
                : t('stateWaiting')}
          </p>
          <button type="button" onClick={() => setShowCancelSheet(true)}>
            {t('cancelButton')}
          </button>
        </>
      )}

      {isReleased && (
        <>
          <p>
            {t('stateReleased')} {ticket.state === 'no_show' ? t('releasedReason') : ''}
          </p>
          <button type="button" onClick={() => router.push(`/book?branch=${ticket.branch_id}`)}>
            {t('rejoin')}
          </button>
        </>
      )}

      {isCompleted && <p>{t('stateCompleted')}</p>}

      {showCancelSheet && (
        <div role="dialog" aria-label={t('cancelSheetTitle')}>
          <h2>{t('cancelSheetTitle')}</h2>
          {/* Six explicit t() calls instead of a dynamic `t(`reason${...}`)` lookup -- the
              template-literal key construction is flagged by task-6-brief.md as optional and is
              swapped for literal keys here since it fails noUncheckedIndexedAccess/next-intl's
              static analysis in this repo's toolchain. */}
          <ul>
            <li>
              <button type="button" onClick={() => handleCancel('wait_too_long')}>
                {t('reasonWaitTooLong')}
              </button>
            </li>
            <li>
              <button type="button" onClick={() => handleCancel('cant_make_it')}>
                {t('reasonCantMakeIt')}
              </button>
            </li>
            <li>
              <button type="button" onClick={() => handleCancel('changed_plans')}>
                {t('reasonChangedPlans')}
              </button>
            </li>
            <li>
              <button type="button" onClick={() => handleCancel('found_another_barber')}>
                {t('reasonFoundAnotherBarber')}
              </button>
            </li>
            <li>
              <button type="button" onClick={() => handleCancel('emergency')}>
                {t('reasonEmergency')}
              </button>
            </li>
            <li>
              <button type="button" onClick={() => handleCancel('other')}>
                {t('reasonOther')}
              </button>
            </li>
          </ul>
          <button type="button" onClick={() => setShowCancelSheet(false)}>
            {t('backButton')}
          </button>
        </div>
      )}
    </main>
  );
}
