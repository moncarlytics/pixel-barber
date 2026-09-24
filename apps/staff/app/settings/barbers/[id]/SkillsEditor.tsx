// apps/staff/app/settings/barbers/[id]/SkillsEditor.tsx
// Which of the home branch's services this barber can perform (barber_skills). A barber with no
// skills is never assigned customers, so the screen warns when none are ticked.
'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';

interface ServiceOption {
  serviceId: string;
  name: string;
}

export default function SkillsEditor({
  barberId,
  homeBranchId,
}: {
  barberId: string;
  homeBranchId: string;
}) {
  const t = useTranslations('BarberDetail');
  const supabase = createBrowserSupabaseClient();
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [persisted, setPersisted] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      supabase
        .from('branch_services')
        .select('service_id, services(name)')
        .eq('branch_id', homeBranchId),
      supabase.from('barber_skills').select('service_id').eq('barber_id', barberId),
    ]).then(([{ data: bsRows, error: bsError }, { data: skillRows, error: skillError }]) => {
      if (cancelled) return;
      if (bsError || skillError) {
        setError(t('loadFailed'));
        return;
      }
      setServices(
        (bsRows ?? []).map((bs) => ({
          serviceId: bs.service_id,
          name: (bs.services as unknown as { name: string } | null)?.name ?? '',
        })),
      );
      const current = new Set((skillRows ?? []).map((s) => s.service_id));
      setSelected(new Set(current));
      setPersisted(current);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barberId, homeBranchId]);

  function toggle(serviceId: string, checked: boolean) {
    setSavedMessage(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(serviceId);
      else next.delete(serviceId);
      return next;
    });
  }

  async function handleSave() {
    setError(null);
    setSavedMessage(false);
    const added = [...selected].filter((id) => !persisted.has(id));
    const removed = [...persisted].filter((id) => !selected.has(id));
    if (added.length > 0) {
      const { error: insertError } = await supabase
        .from('barber_skills')
        .insert(added.map((service_id) => ({ barber_id: barberId, service_id })));
      if (insertError) {
        setError(t('saveFailed'));
        return;
      }
    }
    if (removed.length > 0) {
      const { error: deleteError } = await supabase
        .from('barber_skills')
        .delete()
        .eq('barber_id', barberId)
        .in('service_id', removed);
      if (deleteError) {
        setError(t('saveFailed'));
        return;
      }
    }
    setPersisted(new Set(selected));
    setSavedMessage(true);
  }

  return (
    <section>
      <h2>{t('skillsTitle')}</h2>
      {error && <p role="alert">{error}</p>}
      {savedMessage && <p role="status">{t('skillsSaved')}</p>}
      {loaded && services.length === 0 && <p>{t('noServices')}</p>}
      {loaded && services.length > 0 && selected.size === 0 && (
        <p role="alert">{t('noSkillsWarning')}</p>
      )}
      <ul>
        {services.map((s) => (
          <li key={s.serviceId}>
            <label>
              <input
                type="checkbox"
                checked={selected.has(s.serviceId)}
                onChange={(e) => toggle(s.serviceId, e.target.checked)}
              />
              {s.name}
            </label>
          </li>
        ))}
      </ul>
      <button type="button" onClick={handleSave} disabled={!loaded}>
        {t('saveSkills')}
      </button>
    </section>
  );
}
