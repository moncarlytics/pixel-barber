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
  const [acceptFallback, setAcceptFallback] = useState(false);
  const [needsAvailabilityPrompt, setNeedsAvailabilityPrompt] = useState(false);
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
      .rpc('list_bookable_barbers', { p_branch_id: branchId })
      .then(({ data }) => setBarbers((data ?? []).map((b) => ({ id: b.id }))));
  }, [branchId]);

  useEffect(() => {
    let cancelled = false;
    async function checkEligibility() {
      if (!preferredBarberId || !serviceId) {
        setAcceptFallback(false);
        setNeedsAvailabilityPrompt(false);
        return;
      }
      setError(null);
      const { data, error: rpcError } = await supabase.rpc('find_eligible_barber', {
        p_branch_id: branchId,
        p_branch_service_id: serviceId,
        p_preferred_barber_id: preferredBarberId,
      });
      if (cancelled) return;
      if (rpcError) {
        // Do not silently fall back on a transient failure; leave the prior prompt/choice state
        // alone so the manager can retry (e.g. by re-selecting the barber).
        setError(t('walkInFailed'));
        return;
      }
      setAcceptFallback(false);
      setNeedsAvailabilityPrompt(false);
      const result = data?.[0];
      if (result?.preferred_eligible) return;
      if (result?.preferred_scheduled_today) {
        setNeedsAvailabilityPrompt(true);
      } else {
        setAcceptFallback(true);
      }
    }
    checkEligibility();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId, preferredBarberId, branchId]);

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
            accept_fallback: acceptFallback,
            name,
            phone_e164: normalizedPhone,
          }),
        },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(
          body.error === 'NO_BARBER_AVAILABLE'
            ? t('walkInNoBarberAvailable')
            : (body.error ?? t('walkInFailed')),
        );
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
        {needsAvailabilityPrompt && (
          <div role="group" aria-label={t('walkInAvailabilityPrompt')}>
            <p>{t('walkInAvailabilityPrompt')}</p>
            <label>
              <input
                type="radio"
                name="walkInFallbackChoice"
                checked={!acceptFallback}
                onChange={() => setAcceptFallback(false)}
              />
              {t('walkInWaitForPreferred')}
            </label>
            <label>
              <input
                type="radio"
                name="walkInFallbackChoice"
                checked={acceptFallback}
                onChange={() => setAcceptFallback(true)}
              />
              {t('walkInTakeNextAvailable')}
            </label>
          </div>
        )}
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
