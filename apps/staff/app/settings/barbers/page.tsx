// apps/staff/app/settings/barbers/page.tsx
// Minimal slice of App Flow 8.9 -- only what's needed to unblock PIN set/rotate this phase. The
// full Barbers Management screen (skill matrix, schedule, floating branch assignment, add/edit
// Barber Detail) is real, un-owned scope flagged to the user separately, not built here.
'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';

type Barber = Database['public']['Tables']['barbers']['Row'];

export default function BarbersManagementPage() {
  const t = useTranslations('BarbersManagement');
  const supabase = createBrowserSupabaseClient();
  const [barbers, setBarbers] = useState<Barber[]>([]);
  const [pinInputs, setPinInputs] = useState<Record<string, string>>({});
  const [statusByBarber, setStatusByBarber] = useState<Record<string, string>>({});

  useEffect(() => {
    supabase
      .from('barbers')
      .select('*')
      .then(({ data }) => setBarbers(data ?? []));
  }, []);

  async function handleSetPin(barber: Barber) {
    const pin = pinInputs[barber.id];
    if (!pin) return;
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/barber-pin-set`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ barber_staff_user_id: barber.staff_user_id, pin }),
      },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setStatusByBarber((s) => ({ ...s, [barber.id]: body.error ?? t('pinSetFailed') }));
      return;
    }
    setStatusByBarber((s) => ({ ...s, [barber.id]: t('pinSetSuccess') }));
    setPinInputs((p) => ({ ...p, [barber.id]: '' }));
  }

  return (
    <main>
      <h1>{t('title')}</h1>
      <ul>
        {barbers.map((barber) => (
          <li key={barber.id}>
            {barber.id} — {barber.status}
            {statusByBarber[barber.id] && <span role="status"> {statusByBarber[barber.id]}</span>}
            <input
              placeholder={t('pinPlaceholder')}
              value={pinInputs[barber.id] ?? ''}
              onChange={(e) => setPinInputs((p) => ({ ...p, [barber.id]: e.target.value }))}
              maxLength={6}
            />
            <button type="button" onClick={() => handleSetPin(barber)}>
              {t('setPinButton')}
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
