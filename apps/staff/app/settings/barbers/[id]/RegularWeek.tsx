// apps/staff/app/settings/barbers/[id]/RegularWeek.tsx
// A barber's regular week. Saving writes barber_weekly_hours; database triggers then refill the
// next 28 dated days (hand-edited days and days off are left alone).
'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { ManageableBranch } from '../scope';

// Monday first. 0 = Sunday, the same convention as branch_hours.day_of_week.
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

interface DayRow {
  dayOfWeek: number;
  working: boolean;
  branchId: string;
  start: string;
  end: string;
}

export default function RegularWeek({
  barberId,
  homeBranchId,
  branches,
  onSaved,
}: {
  barberId: string;
  homeBranchId: string;
  branches: ManageableBranch[];
  onSaved: () => void;
}) {
  const t = useTranslations('BarberDetail');
  const supabase = createBrowserSupabaseClient();
  const [rows, setRows] = useState<DayRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from('barber_weekly_hours')
      .select('*')
      .eq('barber_id', barberId)
      .then(({ data, error: loadError }) => {
        if (cancelled) return;
        if (loadError) {
          setError(t('loadFailed'));
          return;
        }
        const byDay = new Map((data ?? []).map((r) => [r.day_of_week, r]));
        setRows(
          DAY_ORDER.map((dayOfWeek) => {
            const r = byDay.get(dayOfWeek);
            return r
              ? {
                  dayOfWeek,
                  working: true,
                  branchId: r.branch_id,
                  start: r.shift_start.slice(0, 5),
                  end: r.shift_end.slice(0, 5),
                }
              : { dayOfWeek, working: false, branchId: homeBranchId, start: '09:00', end: '18:00' };
          }),
        );
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barberId, homeBranchId]);

  function update(index: number, patch: Partial<DayRow>) {
    setSaved(false);
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  async function handleSave() {
    setError(null);
    setSaved(false);
    const working = rows.filter((r) => r.working);
    // 'HH:MM' strings compare correctly as text.
    if (working.some((r) => r.end <= r.start)) {
      setError(t('endBeforeStart'));
      return;
    }
    setSaving(true);
    const offDays = rows.filter((r) => !r.working).map((r) => r.dayOfWeek);
    if (offDays.length > 0) {
      const { error: deleteError } = await supabase
        .from('barber_weekly_hours')
        .delete()
        .eq('barber_id', barberId)
        .in('day_of_week', offDays);
      if (deleteError) {
        setError(t('saveFailed'));
        setSaving(false);
        return;
      }
    }
    if (working.length > 0) {
      const { error: upsertError } = await supabase.from('barber_weekly_hours').upsert(
        working.map((r) => ({
          barber_id: barberId,
          day_of_week: r.dayOfWeek,
          branch_id: r.branchId,
          shift_start: r.start,
          shift_end: r.end,
        })),
        { onConflict: 'barber_id,day_of_week' },
      );
      if (upsertError) {
        setError(t('saveFailed'));
        setSaving(false);
        return;
      }
    }
    setSaving(false);
    setSaved(true);
    onSaved();
  }

  return (
    <section>
      <h2>{t('regularWeekTitle')}</h2>
      {error && <p role="alert">{error}</p>}
      {saved && <p role="status">{t('weekSaved')}</p>}
      <table>
        <thead>
          <tr>
            <th />
            <th>{t('working')}</th>
            <th>{t('branch')}</th>
            <th>{t('start')}</th>
            <th>{t('end')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.dayOfWeek}>
              <td>{t(`day${r.dayOfWeek}`)}</td>
              <td>
                <input
                  type="checkbox"
                  aria-label={`${t(`day${r.dayOfWeek}`)} ${t('working')}`}
                  checked={r.working}
                  onChange={(e) => update(i, { working: e.target.checked })}
                />
              </td>
              <td>
                <select
                  aria-label={`${t(`day${r.dayOfWeek}`)} ${t('branch')}`}
                  value={r.branchId}
                  disabled={!r.working}
                  onChange={(e) => update(i, { branchId: e.target.value })}
                >
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  type="time"
                  aria-label={`${t(`day${r.dayOfWeek}`)} ${t('start')}`}
                  value={r.start}
                  disabled={!r.working}
                  onChange={(e) => update(i, { start: e.target.value })}
                />
              </td>
              <td>
                <input
                  type="time"
                  aria-label={`${t(`day${r.dayOfWeek}`)} ${t('end')}`}
                  value={r.end}
                  disabled={!r.working}
                  onChange={(e) => update(i, { end: e.target.value })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={handleSave} disabled={saving || rows.length === 0}>
        {t('saveWeek')}
      </button>
    </section>
  );
}
