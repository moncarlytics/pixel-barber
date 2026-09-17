'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';

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
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [serviceId, setServiceId] = useState('');
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
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
          name,
          phone_e164: phone || null,
        }),
      },
    );
    setSubmitting(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? t('walkInFailed'));
      return;
    }
    onClose();
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
