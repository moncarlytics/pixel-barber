'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient, normalizeGhanaPhone } from '@pixel-barber/shared';

interface ServiceOption {
  branchServiceId: string;
  serviceName: string;
}

export default function AddWalkInModal({
  branchId,
  onClose,
}: {
  branchId: string;
  onClose: () => void;
}) {
  const t = useTranslations('LiveQueue');
  const supabase = createBrowserSupabaseClient();
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [barbers, setBarbers] = useState<{ id: string }[]>([]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [preferredBarberId, setPreferredBarberId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    supabase
      .from('branch_services')
      .select('id, services(name)')
      .eq('branch_id', branchId)
      .then(({ data }) => {
        setServices(
          (data ?? []).map((bs) => ({
            branchServiceId: bs.id,
            serviceName: (bs.services as unknown as { name: string } | null)?.name ?? '',
          })),
        );
      });
  }, [branchId]);

  useEffect(() => {
    supabase
      .from('barbers')
      .select('id')
      .eq('home_branch_id', branchId)
      .then(({ data }) => setBarbers(data ?? []));
  }, [branchId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    let normalizedPhone: string | null = null;
    if (phone) {
      normalizedPhone = normalizeGhanaPhone(phone);
      if (!normalizedPhone) {
        setError(t('walkInInvalidPhone'));
        return;
      }
    }

    setSubmitting(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/tickets-walk-in`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session?.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            branch_id: branchId,
            branch_service_id: serviceId,
            preferred_barber_id: preferredBarberId,
            name,
            phone_e164: normalizedPhone,
          }),
        },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.error ?? t('walkInFailed'));
        return;
      }
      onClose();
    } catch {
      setError(t('walkInFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div role="dialog" aria-label={t('walkInModalTitle')}>
      <h2>{t('walkInModalTitle')}</h2>
      {error && <p role="alert">{error}</p>}
      <form onSubmit={handleSubmit}>
        <input
          placeholder={t('walkInName')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <input
          placeholder={t('walkInPhone')}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} required>
          <option value="">{t('walkInService')}</option>
          {services.map((s) => (
            <option key={s.branchServiceId} value={s.branchServiceId}>
              {s.serviceName}
            </option>
          ))}
        </select>
        <select
          value={preferredBarberId ?? ''}
          onChange={(e) => setPreferredBarberId(e.target.value || null)}
        >
          <option value="">{t('walkInBarber')}</option>
          {barbers.map((b) => (
            <option key={b.id} value={b.id}>
              {b.id}
            </option>
          ))}
        </select>
        <button type="submit" disabled={submitting}>
          {t('walkInSubmit')}
        </button>
        <button type="button" onClick={onClose}>
          {t('cancel')}
        </button>
      </form>
    </div>
  );
}
