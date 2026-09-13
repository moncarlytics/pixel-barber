'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';

type Branch = Database['public']['Tables']['branches']['Row'];
type BranchHour = Database['public']['Tables']['branch_hours']['Row'];
type BranchClosure = Database['public']['Tables']['branch_closures']['Row'];

export default function BranchEditPage() {
  const t = useTranslations('BranchSettings');
  const params = useParams<{ id: string }>();
  const supabase = createBrowserSupabaseClient();
  const [branch, setBranch] = useState<Branch | null>(null);
  const [hours, setHours] = useState<BranchHour[]>([]);
  const [closures, setClosures] = useState<BranchClosure[]>([]);
  const [newClosureDate, setNewClosureDate] = useState('');
  const [newClosureReason, setNewClosureReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function load() {
    const [{ data: branchRow }, { data: hourRows }, { data: closureRows }] = await Promise.all([
      supabase.from('branches').select('*').eq('id', params.id).single(),
      supabase.from('branch_hours').select('*').eq('branch_id', params.id),
      supabase.from('branch_closures').select('*').eq('branch_id', params.id),
    ]);
    setBranch(branchRow ?? null);

    const existingByDay = new Map((hourRows ?? []).map((h) => [h.day_of_week, h]));
    const allDays: BranchHour[] = [0, 1, 2, 3, 4, 5, 6].map(
      (day) =>
        existingByDay.get(day) ?? {
          id: '',
          branch_id: params.id,
          day_of_week: day,
          opens_at: '09:00',
          closes_at: '21:00',
          is_closed: day === 0,
        },
    );
    setHours(allDays);
    setClosures(closureRows ?? []);
  }

  useEffect(() => {
    load();
  }, [params.id]);

  async function handleSaveBranch(e: React.FormEvent) {
    e.preventDefault();
    if (!branch) return;
    setError(null);
    setSaved(false);
    const { error: updateError } = await supabase
      .from('branches')
      .update({
        name: branch.name,
        address: branch.address,
        latitude: branch.latitude,
        longitude: branch.longitude,
        phone_e164: branch.phone_e164,
        geofence_radius_m: branch.geofence_radius_m,
      })
      .eq('id', branch.id);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setSaved(true);
  }

  async function handleSaveHours(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { error: upsertError } = await supabase.from('branch_hours').upsert(
      hours.map((h) => ({
        branch_id: params.id,
        day_of_week: h.day_of_week,
        opens_at: h.is_closed ? null : h.opens_at,
        closes_at: h.is_closed ? null : h.closes_at,
        is_closed: h.is_closed,
      })),
      { onConflict: 'branch_id,day_of_week' },
    );
    if (upsertError) {
      setError(upsertError.message);
      return;
    }
    load();
  }

  async function handleAddClosure(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { error: insertError } = await supabase.from('branch_closures').insert({
      branch_id: params.id,
      closure_date: newClosureDate,
      reason: newClosureReason || null,
    });
    if (insertError) {
      setError(insertError.message);
      return;
    }
    setNewClosureDate('');
    setNewClosureReason('');
    load();
  }

  async function handleRemoveClosure(id: string) {
    setError(null);
    const { error: deleteError } = await supabase.from('branch_closures').delete().eq('id', id);
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    load();
  }

  if (!branch) return null;
  const dayLabels = t.raw('days') as Record<string, string>;

  return (
    <main>
      <h1>{branch.name}</h1>
      {error && <p role="alert">{error}</p>}
      {saved && <p>{t('saved')}</p>}

      <form onSubmit={handleSaveBranch}>
        <input
          placeholder={t('name')}
          value={branch.name}
          onChange={(e) => setBranch({ ...branch, name: e.target.value })}
        />
        <input
          placeholder={t('address')}
          value={branch.address}
          onChange={(e) => setBranch({ ...branch, address: e.target.value })}
        />
        <input
          placeholder={t('latitude')}
          value={branch.latitude}
          onChange={(e) => setBranch({ ...branch, latitude: Number(e.target.value) })}
        />
        <input
          placeholder={t('longitude')}
          value={branch.longitude}
          onChange={(e) => setBranch({ ...branch, longitude: Number(e.target.value) })}
        />
        <input
          placeholder={t('phone')}
          value={branch.phone_e164 ?? ''}
          onChange={(e) => setBranch({ ...branch, phone_e164: e.target.value })}
        />
        <input
          placeholder={t('geofenceRadius')}
          value={branch.geofence_radius_m}
          onChange={(e) => setBranch({ ...branch, geofence_radius_m: Number(e.target.value) })}
        />
        <button type="submit">{t('save')}</button>
      </form>

      <h2>{t('hoursTitle')}</h2>
      <form onSubmit={handleSaveHours}>
        {hours.map((h, i) => (
          <div key={h.day_of_week}>
            <span>{dayLabels[String(h.day_of_week)]}</span>
            <label>
              <input
                type="checkbox"
                checked={h.is_closed}
                onChange={(e) => {
                  const next = [...hours];
                  next[i] = { ...h, is_closed: e.target.checked };
                  setHours(next);
                }}
              />
              {t('closedCheckbox')}
            </label>
            {!h.is_closed && (
              <>
                <input
                  type="time"
                  value={h.opens_at ?? ''}
                  onChange={(e) => {
                    const next = [...hours];
                    next[i] = { ...h, opens_at: e.target.value };
                    setHours(next);
                  }}
                />
                <input
                  type="time"
                  value={h.closes_at ?? ''}
                  onChange={(e) => {
                    const next = [...hours];
                    next[i] = { ...h, closes_at: e.target.value };
                    setHours(next);
                  }}
                />
              </>
            )}
          </div>
        ))}
        <button type="submit">{t('save')}</button>
      </form>

      <h2>{t('closuresTitle')}</h2>
      <ul>
        {closures.map((c) => (
          <li key={c.id}>
            {c.closure_date} {c.reason && `— ${c.reason}`}
            <button onClick={() => handleRemoveClosure(c.id)}>{t('remove')}</button>
          </li>
        ))}
      </ul>
      <form onSubmit={handleAddClosure}>
        <input
          type="date"
          value={newClosureDate}
          onChange={(e) => setNewClosureDate(e.target.value)}
          required
        />
        <input
          placeholder={t('closureReason')}
          value={newClosureReason}
          onChange={(e) => setNewClosureReason(e.target.value)}
        />
        <button type="submit">{t('addClosure')}</button>
      </form>
    </main>
  );
}
