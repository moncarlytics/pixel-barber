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
  // The last-loaded (= last-saved) state. Save diffs against this and only sends what changed;
  // a failed save reloads from the DB and resets both `rows` and `baseline` to it, so the form
  // never shows unsaved edits as if they'd been saved.
  const [baseline, setBaseline] = useState<DayRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  function toDayRows(
    data: { day_of_week: number; branch_id: string; shift_start: string; shift_end: string }[],
  ) {
    const byDay = new Map(data.map((r) => [r.day_of_week, r]));
    return DAY_ORDER.map((dayOfWeek) => {
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
    });
  }

  async function load() {
    const { data, error: loadError } = await supabase
      .from('barber_weekly_hours')
      .select('*')
      .eq('barber_id', barberId);
    if (loadError) {
      setError(t('loadFailed'));
      return;
    }
    const loaded = toDayRows(data ?? []);
    setRows(loaded);
    setBaseline(loaded);
  }

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
        const loaded = toDayRows(data ?? []);
        setRows(loaded);
        setBaseline(loaded);
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
    const baselineByDay = new Map(baseline.map((r) => [r.dayOfWeek, r]));
    const changed = rows.filter((r) => {
      const b = baselineByDay.get(r.dayOfWeek);
      if (!b || r.working !== b.working) return true;
      return r.working && (r.branchId !== b.branchId || r.start !== b.start || r.end !== b.end);
    });
    if (changed.length === 0) {
      setSaved(true);
      return;
    }
    setSaving(true);
    const { error: saveError } = await supabase.rpc('set_barber_weekly_hours', {
      p_barber_id: barberId,
      p_days: changed.map((r) => ({
        day_of_week: r.dayOfWeek,
        working: r.working,
        branch_id: r.working ? r.branchId : null,
        shift_start: r.working ? r.start : null,
        shift_end: r.working ? r.end : null,
      })),
    });
    setSaving(false);
    if (saveError) {
      setError(t('saveFailed'));
      await load();
      return;
    }
    setBaseline(rows);
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
                  {!branches.some((b) => b.id === r.branchId) && (
                    <option value={r.branchId} disabled>
                      {t('otherBranch')}
                    </option>
                  )}
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
