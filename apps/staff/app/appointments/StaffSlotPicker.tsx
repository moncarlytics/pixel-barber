'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';

const DAY = 24 * 60 * 60 * 1000;
const BOOKING_DAYS = 15; // today + 14

/** HH:MM in UTC (Ghana time). */
export function formatSlotTime(iso: string): string {
  return new Date(iso).toISOString().slice(11, 16);
}

/** e.g. "Thu 2 Oct", in UTC (Ghana time). Accepts YYYY-MM-DD or an ISO timestamp. */
export function formatSlotDate(isoOrDate: string): string {
  const d = new Date(isoOrDate.length === 10 ? `${isoOrDate}T00:00:00Z` : isoOrDate);
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

interface Props {
  branchServiceId: string;
  barberId: string | null;
  customerId?: string | null;
  ignoreAppointmentId?: string | null;
  onPick: (slot: string) => void;
  /** Bump to reload the open times (e.g. after "That time was just taken"). */
  refreshKey?: number;
}

/** Staff date & time step: today + the next 14 days, then the open slots on the chosen day. */
export default function StaffSlotPicker({
  branchServiceId,
  barberId,
  customerId = null,
  ignoreAppointmentId = null,
  onPick,
  refreshKey = 0,
}: Props) {
  const t = useTranslations('StaffAppointments');
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [dates] = useState(() =>
    Array.from({ length: BOOKING_DAYS }, (_, i) =>
      new Date(Date.now() + i * DAY).toISOString().slice(0, 10),
    ),
  );
  const [date, setDate] = useState<string | null>(null);
  const [result, setResult] = useState<{ key: string; slots: string[]; failed: boolean } | null>(
    null,
  );
  const requestKey = date ? `${date}:${refreshKey}` : null;

  useEffect(() => {
    if (!date || !requestKey) return;
    let cancelled = false;
    supabase
      .rpc('staff_list_appointment_slots', {
        p_branch_service_id: branchServiceId,
        p_barber_id: barberId,
        p_date: date,
        p_customer_id: customerId ?? null,
        p_ignore_appointment_id: ignoreAppointmentId ?? null,
      })
      .then(({ data, error }) => {
        if (cancelled) return;
        setResult({ key: requestKey, slots: data ?? [], failed: !!error });
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, branchServiceId, barberId, date, requestKey, customerId, ignoreAppointmentId]);

  const current = result && result.key === requestKey ? result : null;

  return (
    <div>
      <p>{t('pickDate')}</p>
      <ul>
        {dates.map((d) => (
          <li key={d}>
            <button type="button" aria-pressed={d === date} onClick={() => setDate(d)}>
              {formatSlotDate(d)}
            </button>
          </li>
        ))}
      </ul>
      {date && !current && <p>{t('loadingSlots')}</p>}
      {current?.failed && <p role="alert">{t('errors.generic')}</p>}
      {current && !current.failed && current.slots.length === 0 && <p>{t('noSlots')}</p>}
      {current && !current.failed && current.slots.length > 0 && (
        <ul>
          {current.slots.map((slot) => (
            <li key={slot}>
              <button type="button" onClick={() => onPick(slot)}>
                {formatSlotTime(slot)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
