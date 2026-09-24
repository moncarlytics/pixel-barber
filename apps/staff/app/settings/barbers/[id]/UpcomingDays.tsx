// apps/staff/app/settings/barbers/[id]/UpcomingDays.tsx
// What each of the next 28 days will actually be for this barber, with per-day changes: edit
// hours/branch (a hand-edited row the refill never overwrites), mark a day off, or reset the day
// back to the regular week.
'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';
import type { ManageableBranch } from '../scope';

type ScheduleRow = Database['public']['Tables']['barber_schedule']['Row'];

const ACTIVE_STATES = [
  'created',
  'waiting',
  'almost_turn',
  'called',
  'confirmed',
  'grace_period',
  'in_service',
] as const;
const WINDOW_DAYS = 28;

function upcomingDates(): string[] {
  const now = new Date();
  return Array.from({ length: WINDOW_DAYS }, (_, i) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + i))
      .toISOString()
      .slice(0, 10),
  );
}

interface EditState {
  date: string;
  branchId: string;
  start: string;
  end: string;
}

export default function UpcomingDays({
  barberId,
  homeBranchId,
  branches,
  refreshKey,
}: {
  barberId: string;
  homeBranchId: string;
  branches: ManageableBranch[];
  refreshKey: number;
}) {
  const t = useTranslations('BarberDetail');
  const supabase = createBrowserSupabaseClient();
  const [dates] = useState(upcomingDates);
  const [rowsByDate, setRowsByDate] = useState<Map<string, ScheduleRow>>(new Map());
  const [daysOff, setDaysOff] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<EditState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const first = dates[0];
    const last = dates[dates.length - 1];
    Promise.all([
      supabase
        .from('barber_schedule')
        .select('*')
        .eq('barber_id', barberId)
        .gte('work_date', first)
        .lte('work_date', last),
      supabase
        .from('barber_days_off')
        .select('off_date')
        .eq('barber_id', barberId)
        .gte('off_date', first)
        .lte('off_date', last),
    ]).then(([{ data: schedule, error: scheduleError }, { data: off, error: offError }]) => {
      if (cancelled) return;
      if (scheduleError || offError) {
        setError(t('loadFailed'));
        return;
      }
      setRowsByDate(new Map((schedule ?? []).map((r) => [r.work_date, r])));
      setDaysOff(new Set((off ?? []).map((o) => o.off_date)));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barberId, refreshKey, reloadTick]);

  const reload = () => setReloadTick((n) => n + 1);
  const branchName = (id: string) => branches.find((b) => b.id === id)?.name ?? t('otherBranch');

  function startEdit(date: string) {
    const row = rowsByDate.get(date);
    setError(null);
    setEditing({
      date,
      branchId: row?.branch_id ?? homeBranchId,
      start: row?.shift_start.slice(0, 5) ?? '09:00',
      end: row?.shift_end.slice(0, 5) ?? '18:00',
    });
  }

  async function saveEdit() {
    if (!editing) return;
    setError(null);
    if (editing.end <= editing.start) {
      setError(t('endBeforeStart'));
      return;
    }
    const { error: upsertError } = await supabase.from('barber_schedule').upsert(
      {
        barber_id: barberId,
        work_date: editing.date,
        branch_id: editing.branchId,
        shift_start: editing.start,
        shift_end: editing.end,
        is_manual: true,
      },
      { onConflict: 'barber_id,work_date' },
    );
    if (upsertError) {
      setError(t('saveFailed'));
      return;
    }
    setEditing(null);
    reload();
  }

  async function markDayOff(date: string) {
    setError(null);
    // Tickets are same-day, so only today can have customers queued for this barber.
    if (date === dates[0]) {
      const { count, error: countError } = await supabase
        .from('queue_tickets')
        .select('id', { count: 'exact', head: true })
        .eq('assigned_barber_id', barberId)
        .in('state', [...ACTIVE_STATES]);
      if (countError) {
        setError(t('saveFailed'));
        return;
      }
      if ((count ?? 0) > 0 && !window.confirm(t('dayOffTicketsWarning', { count: count ?? 0 }))) {
        return;
      }
    }
    const { error: insertError } = await supabase
      .from('barber_days_off')
      .insert({ barber_id: barberId, off_date: date });
    if (insertError) {
      setError(t('saveFailed'));
      return;
    }
    reload();
  }

  async function resetDay(date: string) {
    setError(null);
    const { error: resetError } = await supabase.rpc('reset_barber_schedule_day', {
      p_barber_id: barberId,
      p_date: date,
    });
    if (resetError) {
      setError(t('saveFailed'));
      return;
    }
    reload();
  }

  return (
    <section>
      <h2>{t('upcomingTitle')}</h2>
      {error && <p role="alert">{error}</p>}
      <ul>
        {dates.map((date) => {
          const row = rowsByDate.get(date);
          const off = daysOff.has(date);
          const weekdayKey = `day${new Date(`${date}T00:00:00Z`).getUTCDay()}`;
          return (
            <li key={date}>
              <span>
                {t(weekdayKey)} {date}:{' '}
              </span>
              {off ? (
                <span>{t('dayOff')}</span>
              ) : row ? (
                <span>
                  {row.shift_start.slice(0, 5)}–{row.shift_end.slice(0, 5)} (
                  {branchName(row.branch_id)}){row.is_manual && <em> {t('changedByHand')}</em>}
                </span>
              ) : (
                <span>{t('notWorking')}</span>
              )}

              {editing?.date === date ? (
                <span>
                  <select
                    aria-label={t('branch')}
                    value={editing.branchId}
                    onChange={(e) => setEditing({ ...editing, branchId: e.target.value })}
                  >
                    {branches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="time"
                    aria-label={t('start')}
                    value={editing.start}
                    onChange={(e) => setEditing({ ...editing, start: e.target.value })}
                  />
                  <input
                    type="time"
                    aria-label={t('end')}
                    value={editing.end}
                    onChange={(e) => setEditing({ ...editing, end: e.target.value })}
                  />
                  <button type="button" onClick={saveEdit}>
                    {t('saveDay')}
                  </button>
                  <button type="button" onClick={() => setEditing(null)}>
                    {t('cancel')}
                  </button>
                </span>
              ) : (
                <span>
                  {!off && (
                    <button type="button" onClick={() => startEdit(date)}>
                      {t('editDay')}
                    </button>
                  )}
                  {!off && (
                    <button type="button" onClick={() => markDayOff(date)}>
                      {t('markDayOff')}
                    </button>
                  )}
                  {(off || row?.is_manual) && (
                    <button type="button" onClick={() => resetDay(date)}>
                      {t('resetDay')}
                    </button>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
