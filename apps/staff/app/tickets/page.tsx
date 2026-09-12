'use client';

import { useEffect, useState } from 'react';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';

type Ticket = Database['public']['Tables']['queue_tickets']['Row'];

export default function StaffTicketsPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const supabase = createBrowserSupabaseClient();

  useEffect(() => {
    // Channel is created synchronously (not inside the async fetch below) so cleanup always has
    // a real channel to remove -- creating it only after an `await` resolves would leave a stale
    // closure if the component unmounts before that await settles, orphaning the subscription.
    const channel = supabase
      .channel('branch-tickets')
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
      <h1>Branch Tickets</h1>
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
