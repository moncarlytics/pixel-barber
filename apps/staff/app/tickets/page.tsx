'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient, updateTicketWithVersion } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';
import AddWalkInModal from './AddWalkInModal';

type Ticket = Database['public']['Tables']['queue_tickets']['Row'];
type Barber = Database['public']['Tables']['barbers']['Row'];
type Branch = Database['public']['Tables']['branches']['Row'];

export default function StaffTicketsPage() {
  const t = useTranslations('LiveQueue');
  const supabase = createBrowserSupabaseClient();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selectedBranchId, setSelectedBranchId] = useState('');
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [barbers, setBarbers] = useState<Barber[]>([]);
  const [showWalkInModal, setShowWalkInModal] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from('branches')
      .select('*')
      .order('name')
      .then(({ data }) => {
        setBranches(data ?? []);
        setSelectedBranchId((current) => current || data?.[0]?.id || '');
      });
  }, []);

  useEffect(() => {
    if (!selectedBranchId) return;
    let cancelled = false;

    function refresh() {
      supabase
        .from('queue_tickets')
        .select('*')
        .eq('branch_id', selectedBranchId)
        .not('state', 'in', '(completed,cancelled,no_show)')
        .order('position', { ascending: true, nullsFirst: false })
        .then(({ data }) => {
          if (!cancelled) setTickets(data ?? []);
        });
      supabase
        .from('barbers')
        .select('*')
        .eq('home_branch_id', selectedBranchId)
        .then(({ data }) => {
          if (!cancelled) setBarbers(data ?? []);
        });
    }

    const channel = supabase
      .channel(`branch-tickets-${selectedBranchId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'queue_tickets',
          filter: `branch_id=eq.${selectedBranchId}`,
        },
        refresh,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'barbers',
          filter: `home_branch_id=eq.${selectedBranchId}`,
        },
        refresh,
      )
      .subscribe();

    refresh();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [selectedBranchId]);

  async function handleCancel(ticket: Ticket) {
    setError(null);
    const result = await updateTicketWithVersion(supabase, ticket.id, ticket.version, {
      state: 'cancelled',
      cancel_reason: 'other',
      cancelled_at: new Date().toISOString(),
    });
    if (!result.success)
      setError(result.reason === 'conflict' ? t('conflictMessage') : t('actionFailed'));
  }

  async function handleMarkArrived(ticket: Ticket) {
    setError(null);
    const result = await updateTicketWithVersion(supabase, ticket.id, ticket.version, {
      state: 'confirmed',
      confirmed_at: new Date().toISOString(),
    });
    if (!result.success)
      setError(result.reason === 'conflict' ? t('conflictMessage') : t('actionFailed'));
  }

  async function handleBarberStatus(
    barber: Barber,
    status: Database['public']['Enums']['barber_status'],
  ) {
    setError(null);
    const { error: statusError } = await supabase
      .from('barbers')
      .update({ status })
      .eq('id', barber.id);
    if (statusError) setError(t('actionFailed'));
  }

  return (
    <main>
      <h1>{t('branchLabel')}</h1>
      {error && <p role="alert">{error}</p>}
      <select value={selectedBranchId} onChange={(e) => setSelectedBranchId(e.target.value)}>
        {branches.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
      <button type="button" onClick={() => setShowWalkInModal(true)}>
        {t('addWalkIn')}
      </button>

      <table>
        <thead>
          <tr>
            <th>{t('positionHeader')}</th>
            <th>{t('customerHeader')}</th>
            <th>{t('serviceHeader')}</th>
            <th>{t('barberHeader')}</th>
            <th>{t('waitHeader')}</th>
            <th>{t('statusHeader')}</th>
            <th>{t('actionsHeader')}</th>
          </tr>
        </thead>
        <tbody>
          {tickets.map((ticket) => (
            <tr
              key={ticket.id}
              style={ticket.state === 'grace_period' ? { background: '#fee' } : undefined}
            >
              <td>{ticket.position ?? '—'}</td>
              <td>{ticket.customer_id}</td>
              <td>{ticket.branch_service_id}</td>
              <td>{ticket.assigned_barber_id ?? '—'}</td>
              <td>
                {ticket.estimated_wait_low_min !== null
                  ? `${ticket.estimated_wait_low_min}–${ticket.estimated_wait_high_min} min`
                  : '—'}
              </td>
              <td>{ticket.state === 'grace_period' ? t('gracePeriodAlert') : ticket.state}</td>
              <td>
                <button type="button" onClick={() => handleMarkArrived(ticket)}>
                  {t('markArrivedAction')}
                </button>
                <button type="button" onClick={() => handleCancel(ticket)}>
                  {t('cancelAction')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>{t('barberBoardTitle')}</h2>
      <ul>
        {barbers.map((barber) => (
          <li key={barber.id}>
            {barber.id} — {barber.status}
            <button type="button" onClick={() => handleBarberStatus(barber, 'available')}>
              {t('statusAvailable')}
            </button>
            <button type="button" onClick={() => handleBarberStatus(barber, 'on_break')}>
              {t('statusBreak')}
            </button>
            <button type="button" onClick={() => handleBarberStatus(barber, 'offline')}>
              {t('statusOffline')}
            </button>
          </li>
        ))}
      </ul>

      {showWalkInModal && (
        <AddWalkInModal branchId={selectedBranchId} onClose={() => setShowWalkInModal(false)} />
      )}
    </main>
  );
}
