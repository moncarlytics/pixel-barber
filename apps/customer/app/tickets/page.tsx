'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';
import { formatSlotDate, formatSlotTime } from '../appointments/SlotPicker';

type Ticket = Database['public']['Tables']['queue_tickets']['Row'];
type Appointment = Database['public']['Tables']['appointments']['Row'];

export default function TicketsPage() {
  const t = useTranslations('Tickets');
  const ta = useTranslations('Appointments');
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [upcoming, setUpcoming] = useState<Appointment[] | null>(null);
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);

  useEffect(() => {
    const channel = supabase
      .channel('my-tickets')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'queue_tickets' }, () => {
        supabase
          .from('queue_tickets')
          .select('*')
          .then(({ data: refreshed }) => setTickets(refreshed ?? []));
      })
      .subscribe();

    supabase
      .from('queue_tickets')
      .select('*')
      .then(({ data }) => setTickets(data ?? []));
    // RLS limits appointments to the signed-in customer's own.
    supabase
      .from('appointments')
      .select('*')
      .eq('status', 'scheduled')
      .gte('scheduled_start', new Date().toISOString())
      .order('scheduled_start')
      .then(({ data }) => setUpcoming(data ?? []));

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase]);

  return (
    <main>
      <h1>{t('title')}</h1>
      <Link href="/profile">Profile</Link>
      <ul>
        {tickets.map((ticket) => (
          <li key={ticket.id}>
            <Link href={`/tickets/${ticket.id}`}>
              {ticket.ticket_number} — {ticket.state}
            </Link>
          </li>
        ))}
      </ul>

      <section aria-labelledby="upcoming-heading">
        <h2 id="upcoming-heading">{ta('upcomingTitle')}</h2>
        {upcoming && upcoming.length === 0 && (
          <div>
            <p>{ta('noUpcoming')}</p>
            <Link href="/">{ta('bookOne')}</Link>
          </div>
        )}
        {upcoming && upcoming.length > 0 && (
          <ul>
            {upcoming.map((a) => (
              <li key={a.id}>
                <Link href={`/appointments/${a.id}`}>
                  {formatSlotDate(a.scheduled_start)} {formatSlotTime(a.scheduled_start)}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
