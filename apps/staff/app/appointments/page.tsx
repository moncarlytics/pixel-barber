'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import { loadManageableBranches, type ManageableBranch } from '../settings/barbers/scope';
import { formatSlotDate, formatSlotTime } from './StaffSlotPicker';

const DAY_MS = 24 * 60 * 60 * 1000;

interface Row {
  id: string;
  scheduled_start: string;
  customer_name: string;
  service_name: string;
  barber_name: string | null;
  preferred_barber_id: string | null;
  status: string;
}
interface Barber {
  id: string;
  display_name: string;
}

function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}

export default function AppointmentsCalendarPage() {
  const t = useTranslations('StaffAppointments');
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [branches, setBranches] = useState<ManageableBranch[]>([]);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [barbersResult, setBarbersResult] = useState<{ key: string; barbers: Barber[] } | null>(
    null,
  );
  const [barberFilter, setBarberFilter] = useState('all');
  const [result, setResult] = useState<{ key: string; rows: Row[]; failed: boolean } | null>(null);
  const [branchesFailed, setBranchesFailed] = useState(false);
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  const [barbersFailed, setBarbersFailed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadManageableBranches(supabase)
      .then((list) => {
        if (cancelled) return;
        setBranches(list);
        setBranchesLoaded(true);
        setBranchId((prev) => prev ?? list[0]?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setBranchesFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  useEffect(() => {
    if (!branchId) return;
    let cancelled = false;
    supabase.rpc('list_bookable_barbers', { p_branch_id: branchId }).then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setBarbersFailed(branchId);
        return;
      }
      setBarbersFailed((prev) => (prev === branchId ? null : prev));
      setBarbersResult({
        key: branchId,
        barbers: (data ?? []).map((b) => ({ id: b.id, display_name: b.display_name })),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [supabase, branchId]);

  const requestKey = branchId ? `${branchId}:${day}` : null;

  useEffect(() => {
    if (!branchId || !requestKey) return;
    let cancelled = false;
    supabase
      .rpc('list_branch_appointments', { p_branch_id: branchId, p_date: day })
      .then(({ data, error }) => {
        if (cancelled) return;
        setResult({ key: requestKey, rows: (data ?? []) as Row[], failed: !!error });
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, branchId, day, requestKey]);

  const current = result && result.key === requestKey ? result : null;
  const barbers = barbersResult && barbersResult.key === branchId ? barbersResult.barbers : [];
  const rows = (current?.rows ?? []).filter((r) =>
    barberFilter === 'all'
      ? true
      : barberFilter === 'any'
        ? r.preferred_barber_id === null
        : r.preferred_barber_id === barberFilter,
  );

  return (
    <main>
      <h1>{t('title')}</h1>
      <select
        aria-label={t('branch')}
        value={branchId ?? ''}
        onChange={(e) => {
          setBranchId(e.target.value);
          setBarberFilter('all');
        }}
      >
        {branches.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
      <div>
        <button type="button" onClick={() => setDay((d) => shiftDay(d, -1))}>
          {t('previousDay')}
        </button>
        <button type="button" onClick={() => setDay(new Date().toISOString().slice(0, 10))}>
          {t('today')}
        </button>
        <button type="button" onClick={() => setDay((d) => shiftDay(d, 1))}>
          {t('nextDay')}
        </button>
        <span>{formatSlotDate(day)}</span>
      </div>
      <select
        aria-label={t('barberFilter')}
        value={barberFilter}
        onChange={(e) => setBarberFilter(e.target.value)}
      >
        <option value="all">{t('allBarbers')}</option>
        <option value="any">{t('anyBarber')}</option>
        {barbers.map((b) => (
          <option key={b.id} value={b.id}>
            {b.display_name}
          </option>
        ))}
      </select>
      {branchId && (
        <Link href={`/appointments/new?branch=${branchId}`}>{t('bookForCustomer')}</Link>
      )}
      {branchesLoaded && branches.length === 0 && <p>{t('noBranches')}</p>}
      {(current?.failed || branchesFailed || barbersFailed === branchId) && (
        <p role="alert">{t('loadFailed')}</p>
      )}
      {current && !current.failed && rows.length === 0 && <p>{t('empty')}</p>}
      {rows.length > 0 && (
        <ul>
          {rows.map((row) => (
            <li key={row.id}>
              <Link href={`/appointments/${row.id}`}>
                {`${formatSlotTime(row.scheduled_start)} — ${row.customer_name} — ${row.service_name} — ${row.barber_name ?? t('anyBarber')} — ${t(`statuses.${row.status}`)}`}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
