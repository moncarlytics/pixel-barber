'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';

interface Row {
  id: string;
  scheduled_start: string;
  customer_first_name: string;
  status: string;
}

/** The signed-in barber's appointments for today (still booked or checked in). */
export default function TodaysAppointments() {
  const t = useTranslations('TodaysQueue');
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    let cancelled = false;
    supabase.rpc('list_my_appointments_today').then(({ data, error }) => {
      if (cancelled || error) return;
      setRows((data ?? []) as Row[]);
    });
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  if (rows.length === 0) return null;

  return (
    <section aria-labelledby="todays-appointments-heading">
      <h2 id="todays-appointments-heading">{t('appointmentsTitle')}</h2>
      <ul>
        {rows.map((r) => (
          <li key={r.id}>
            {t(r.status === 'checked_in' ? 'appointmentCheckedIn' : 'appointmentRow', {
              time: new Date(r.scheduled_start).toISOString().slice(11, 16),
              name: r.customer_first_name,
            })}
          </li>
        ))}
      </ul>
    </section>
  );
}
