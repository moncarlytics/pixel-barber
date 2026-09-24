// apps/staff/app/settings/barbers/page.tsx
// Barbers Management list (App Flow 8.9): barbers the signed-in Owner/Branch Manager may manage,
// with name, status and home branch, the existing PIN set/rotate control, and a link to each
// barber's schedule & skills screen.
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';

type ManageableBarber =
  Database['public']['Functions']['list_manageable_barbers']['Returns'][number];

export default function BarbersManagementPage() {
  const t = useTranslations('BarbersManagement');
  const supabase = createBrowserSupabaseClient();
  const [barbers, setBarbers] = useState<ManageableBarber[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [pinInputs, setPinInputs] = useState<Record<string, string>>({});
  const [statusByBarber, setStatusByBarber] = useState<Record<string, string>>({});

  useEffect(() => {
    supabase.rpc('list_manageable_barbers').then(({ data, error }) => {
      if (error) setLoadError(true);
      setBarbers(data ?? []);
      setLoaded(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSetPin(barber: ManageableBarber) {
    const pin = pinInputs[barber.barber_id];
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
      setStatusByBarber((s) => ({ ...s, [barber.barber_id]: body.error ?? t('pinSetFailed') }));
      return;
    }
    setStatusByBarber((s) => ({ ...s, [barber.barber_id]: t('pinSetSuccess') }));
    setPinInputs((p) => ({ ...p, [barber.barber_id]: '' }));
  }

  return (
    <main>
      <h1>{t('title')}</h1>
      {loadError && <p role="alert">{t('loadFailed')}</p>}
      {loaded && !loadError && barbers.length === 0 && <p>{t('noBarbers')}</p>}
      <ul>
        {barbers.map((barber) => (
          <li key={barber.barber_id}>
            <strong>{barber.name}</strong>
            <span> {t('statusLabel', { status: barber.status })}</span>
            <span> {t('homeBranchLabel', { branch: barber.home_branch_name })}</span>
            <Link href={`/settings/barbers/${barber.barber_id}`}> {t('manageSchedule')}</Link>
            {statusByBarber[barber.barber_id] && (
              <span role="status"> {statusByBarber[barber.barber_id]}</span>
            )}
            <input
              placeholder={t('pinPlaceholder')}
              value={pinInputs[barber.barber_id] ?? ''}
              onChange={(e) => setPinInputs((p) => ({ ...p, [barber.barber_id]: e.target.value }))}
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
