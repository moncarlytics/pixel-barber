'use client';

import { useEffect, useState } from 'react';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';

type Ticket = Database['public']['Tables']['queue_tickets']['Row'];

export default function TicketsPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const supabase = createBrowserSupabaseClient();

  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;

    async function load() {
      const { data } = await supabase.from('queue_tickets').select('*');
      setTickets(data ?? []);

      channel = supabase
        .channel('my-tickets')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'queue_tickets' }, () => {
          supabase
            .from('queue_tickets')
            .select('*')
            .then(({ data: refreshed }) => setTickets(refreshed ?? []));
        })
        .subscribe();
    }
    load();

    return () => {
      if (channel) supabase.removeChannel(channel);
    };
  }, []);

  return (
    <main>
      <h1>My Tickets</h1>
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
