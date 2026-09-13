'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';

type Ticket = Database['public']['Tables']['queue_tickets']['Row'];

export default function TicketsPage() {
  const t = useTranslations('Tickets');
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const supabase = createBrowserSupabaseClient();

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

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  return (
    <main>
      <h1>{t('title')}</h1>
      <Link href="/profile">Profile</Link>
      <ul>
        {tickets.map((t) => (
          <li key={t.id}>
            {t.ticket_number} — {t.state}
          </li>
        ))}
      </ul>
    </main>
  );
}
