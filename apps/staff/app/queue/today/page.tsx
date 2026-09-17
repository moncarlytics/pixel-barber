// apps/staff/app/queue/today/page.tsx
// Phase 5 Task 5: the barber-facing Today's Queue screen -- the first real exercise of the
// PIN-login identity chain (Phase 5 Tasks 2-4) and the RLS/grant hardening from this phase's
// Task 1. "Next Customer" and "Current Customer" are plain PostgREST reads through
// `tickets_barber_own_queue_select` (this task's own preflight-finding migration,
// 20260917090500_barbers_own_queue_select.sql -- the pre-existing policy of the same name only
// covered UPDATE, so a barber's SELECT on their own assigned tickets was silently blocked before
// this migration existed).
'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient, updateTicketWithVersion } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';

type Ticket = Database['public']['Tables']['queue_tickets']['Row'];
type Barber = Database['public']['Tables']['barbers']['Row'];
type Branch = Database['public']['Tables']['branches']['Row'];
type BarberStatus = Database['public']['Enums']['barber_status'];

const NEXT_CUSTOMER_STATES = ['waiting', 'almost_turn'] as const;

export default function TodaysQueuePage() {
  const t = useTranslations('TodaysQueue');
  const supabase = createBrowserSupabaseClient();

  const [myBarber, setMyBarber] = useState<Barber | null>(null);
  const [branch, setBranch] = useState<Branch | null>(null);
  const [identityResolved, setIdentityResolved] = useState(false);
  const [nextTicket, setNextTicket] = useState<Ticket | null>(null);
  const [currentTicket, setCurrentTicket] = useState<Ticket | null>(null);
  const [notPresentTicketId, setNotPresentTicketId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Identity resolution mirrors the exact chain Phase 4's tickets-join/tickets-walk-in Edge
  // Functions use (auth.getUser() -> staff_users by auth_user_id -> barbers by staff_user_id),
  // just run client-side with the browser client since this is a page, not an Edge Function.
  useEffect(() => {
    let cancelled = false;

    async function resolveIdentity() {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user || cancelled) return;

      const { data: staffUser } = await supabase
        .from('staff_users')
        .select('id')
        .eq('auth_user_id', userData.user.id)
        .maybeSingle();
      if (!staffUser || cancelled) return;

      const { data: barberRow } = await supabase
        .from('barbers')
        .select('*')
        .eq('staff_user_id', staffUser.id)
        .maybeSingle();
      if (cancelled) return;
      setMyBarber(barberRow ?? null);

      if (barberRow) {
        const { data: branchRow } = await supabase
          .from('branches')
          .select('*')
          .eq('id', barberRow.home_branch_id)
          .maybeSingle();
        if (!cancelled) setBranch(branchRow ?? null);
      }

      if (!cancelled) setIdentityResolved(true);
    }

    resolveIdentity();

    return () => {
      cancelled = true;
    };
  }, []);

  async function refetchQueue(barberId: string) {
    const [{ data: next }, { data: current }] = await Promise.all([
      supabase
        .from('queue_tickets')
        .select('*')
        .eq('assigned_barber_id', barberId)
        .in('state', NEXT_CUSTOMER_STATES)
        .order('position', { ascending: true, nullsFirst: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('queue_tickets')
        .select('*')
        .eq('assigned_barber_id', barberId)
        .eq('state', 'in_service')
        .maybeSingle(),
    ]);
    setNextTicket(next ?? null);
    setCurrentTicket(current ?? null);
  }

  // Realtime pattern mirrors Phase 4's Live Queue (apps/staff/app/tickets/page.tsx) and Ticket
  // Tracking Screen (apps/customer/app/tickets/[id]/page.tsx): channel + postgres_changes + a
  // refetch callback, cleaned up on unmount.
  useEffect(() => {
    if (!myBarber) return;
    const barberId = myBarber.id;
    let cancelled = false;

    const channel = supabase
      .channel(`barber-queue-${barberId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'queue_tickets',
          filter: `assigned_barber_id=eq.${barberId}`,
        },
        () => {
          if (!cancelled) refetchQueue(barberId);
        },
      )
      .subscribe();

    refetchQueue(barberId);

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [myBarber?.id]);

  async function handleAcknowledge(ticket: Ticket) {
    if (!myBarber) return;
    setError(null);
    const now = new Date().toISOString();
    const result = await updateTicketWithVersion(supabase, ticket.id, ticket.version, {
      state: 'in_service',
      called_at: now,
      confirmed_at: now,
      service_started_at: now,
    });
    if (!result.success) {
      if (result.reason === 'conflict') {
        await refetchQueue(myBarber.id);
        setError(t('conflictMessage'));
      } else {
        setError(t('actionFailed'));
      }
      return;
    }
    // service_sessions_barber_own (for all, own barber_id) already permits this insert.
    const { error: sessionError } = await supabase.from('service_sessions').insert({
      ticket_id: ticket.id,
      barber_id: myBarber.id,
      started_at: now,
    });
    if (sessionError) setError(t('actionFailed'));
    await refetchQueue(myBarber.id);
  }

  // Not Present: Task 6 owns the confirmation UI (a proper modal component). Until it exists, this
  // opens a minimal inline confirm affordance (below, gated on notPresentTicketId) as a stopgap.
  // The transition logic itself -- fetching no_show_grace_minutes and the updateTicketWithVersion
  // call -- is the real, final logic and is NOT a stopgap: Task 6 should call confirmNotPresent (or
  // inline its body) from its modal's onConfirm handler rather than rewriting it.
  function requestNotPresent(ticket: Ticket) {
    setNotPresentTicketId(ticket.id);
  }

  function cancelNotPresent() {
    setNotPresentTicketId(null);
  }

  async function confirmNotPresent(ticket: Ticket) {
    if (!myBarber) return;
    setError(null);
    setNotPresentTicketId(null);
    const graceMinutes = branch?.no_show_grace_minutes ?? 2;
    const expiresAt = new Date(Date.now() + graceMinutes * 60_000).toISOString();
    const result = await updateTicketWithVersion(supabase, ticket.id, ticket.version, {
      state: 'grace_period',
      grace_period_expires_at: expiresAt,
    });
    if (!result.success) {
      if (result.reason === 'conflict') {
        await refetchQueue(myBarber.id);
        setError(t('conflictMessage'));
      } else {
        setError(t('actionFailed'));
      }
      return;
    }
    await refetchQueue(myBarber.id);
  }

  async function handleSkip(ticket: Ticket) {
    if (!myBarber) return;
    setError(null);
    // No state change here, per this plan's ruling -- the security-definer repositioning trigger
    // (Task 1) reorders the queue off of skipped_at alone.
    const result = await updateTicketWithVersion(supabase, ticket.id, ticket.version, {
      skipped_at: new Date().toISOString(),
    });
    if (!result.success) {
      if (result.reason === 'conflict') {
        await refetchQueue(myBarber.id);
        setError(t('conflictMessage'));
      } else {
        setError(t('actionFailed'));
      }
      return;
    }
    await refetchQueue(myBarber.id);
  }

  async function handleMarkComplete(ticket: Ticket) {
    if (!myBarber) return;
    setError(null);
    const now = new Date().toISOString();
    const result = await updateTicketWithVersion(supabase, ticket.id, ticket.version, {
      state: 'completed',
      completed_at: now,
    });
    if (!result.success) {
      if (result.reason === 'conflict') {
        await refetchQueue(myBarber.id);
        setError(t('conflictMessage'));
      } else {
        setError(t('actionFailed'));
      }
      return;
    }
    const { error: sessionError } = await supabase
      .from('service_sessions')
      .update({ ended_at: now })
      .eq('ticket_id', ticket.id);
    if (sessionError) setError(t('actionFailed'));
    await refetchQueue(myBarber.id);
  }

  async function handleStatusChange(status: BarberStatus) {
    if (!myBarber) return;
    setError(null);
    // barbers_self_update (Phase 1) already covers any status value on the barber's own row.
    // 'end_of_shift' is Task 7's job to wire meaningfully -- this just writes the value.
    const { data, error: statusError } = await supabase
      .from('barbers')
      .update({ status })
      .eq('id', myBarber.id)
      .select()
      .maybeSingle();
    if (statusError) {
      setError(t('actionFailed'));
      return;
    }
    if (data) setMyBarber(data);
  }

  return (
    <main>
      <h1>{t('title')}</h1>
      {error && <p role="alert">{error}</p>}
      {identityResolved && !myBarber && <p role="alert">{t('noBarberProfile')}</p>}

      {myBarber && (
        <section>
          <h2>{t('statusTitle')}</h2>
          <p>{t('currentStatusLabel', { status: myBarber.status })}</p>
          <button type="button" onClick={() => handleStatusChange('available')}>
            {t('statusAvailable')}
          </button>
          <button type="button" onClick={() => handleStatusChange('on_break')}>
            {t('statusBreak')}
          </button>
          <button type="button" onClick={() => handleStatusChange('end_of_shift')}>
            {t('statusEndShift')}
          </button>
        </section>
      )}

      <section>
        <h2>{t('currentCustomerTitle')}</h2>
        {currentTicket ? (
          <div>
            <p>{t('ticketNumberLabel', { number: currentTicket.ticket_number })}</p>
            <p>{t('customerLabel', { id: currentTicket.customer_id })}</p>
            <p>{t('serviceLabel', { id: currentTicket.branch_service_id })}</p>
            <button type="button" onClick={() => handleMarkComplete(currentTicket)}>
              {t('markCompleteAction')}
            </button>
          </div>
        ) : (
          <p>{t('noCurrentCustomer')}</p>
        )}
      </section>

      <section>
        <h2>{t('nextCustomerTitle')}</h2>
        {nextTicket ? (
          <div>
            <p>{t('ticketNumberLabel', { number: nextTicket.ticket_number })}</p>
            <p>{t('customerLabel', { id: nextTicket.customer_id })}</p>
            <p>{t('serviceLabel', { id: nextTicket.branch_service_id })}</p>
            <button type="button" onClick={() => handleAcknowledge(nextTicket)}>
              {t('acknowledgeAction')}
            </button>
            <button type="button" onClick={() => requestNotPresent(nextTicket)}>
              {t('notPresentAction')}
            </button>
            <button type="button" onClick={() => handleSkip(nextTicket)}>
              {t('skipAction')}
            </button>

            {notPresentTicketId === nextTicket.id && (
              // TODO: Task 6 replaces this inline confirm block with its real confirmation modal
              // component. confirmNotPresent() above holds the actual grace-period transition logic
              // and should be preserved/reused as-is -- only this confirmation UI is a stopgap.
              <div role="alertdialog" aria-label={t('notPresentConfirmTitle')}>
                <p>{t('notPresentConfirmPrompt')}</p>
                <button type="button" onClick={() => confirmNotPresent(nextTicket)}>
                  {t('confirmButton')}
                </button>
                <button type="button" onClick={cancelNotPresent}>
                  {t('cancelButton')}
                </button>
              </div>
            )}
          </div>
        ) : (
          <p>{t('noNextCustomer')}</p>
        )}
      </section>
    </main>
  );
}
