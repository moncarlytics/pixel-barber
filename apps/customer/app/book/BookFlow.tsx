'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';

type Barber = Database['public']['Tables']['barbers']['Row'];

interface ServiceOption {
  branchServiceId: string;
  serviceName: string;
  priceGhs: number | null;
}

type Step = 'service' | 'barber' | 'availability' | 'review';

export default function BookFlow() {
  const t = useTranslations('Book');
  const router = useRouter();
  const searchParams = useSearchParams();
  const branchId = searchParams.get('branch');
  const supabase = createBrowserSupabaseClient();

  const [step, setStep] = useState<Step>('service');
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [barbers, setBarbers] = useState<Barber[]>([]);
  const [selectedServiceId, setSelectedServiceId] = useState('');
  const [selectedBarberId, setSelectedBarberId] = useState<string | null>(null); // null = any available
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [acceptFallback, setAcceptFallback] = useState(false);

  useEffect(() => {
    if (!branchId) return;
    async function load() {
      const { data: bsRows } = await supabase
        .from('branch_services')
        .select('id, service_id, services(name)')
        .eq('branch_id', branchId!);
      const branchServiceIds = (bsRows ?? []).map((bs) => bs.id);
      const { data: priceRows } = await supabase
        .from('current_branch_service_price')
        .select('branch_service_id, price_ghs')
        .in('branch_service_id', branchServiceIds.length > 0 ? branchServiceIds : ['']);
      const priceByBranchService = new Map(
        (priceRows ?? []).map((p) => [p.branch_service_id, p.price_ghs]),
      );
      setServices(
        (bsRows ?? []).map((bs) => ({
          branchServiceId: bs.id,
          serviceName: (bs.services as unknown as { name: string } | null)?.name ?? '',
          priceGhs: priceByBranchService.get(bs.id) ?? null,
        })),
      );

      const { data: barberRows } = await supabase
        .from('barbers')
        .select('*')
        .eq('home_branch_id', branchId!);
      setBarbers(barberRows ?? []);
    }
    load();
  }, [branchId]);

  async function handleSelectBarber(barberId: string | null) {
    setError(null);
    if (barberId === null) {
      setSelectedBarberId(null);
      setAcceptFallback(false);
      setStep('review');
      return;
    }
    const { data, error: rpcError } = await supabase.rpc('find_eligible_barber', {
      p_branch_id: branchId!,
      p_branch_service_id: selectedServiceId,
      p_preferred_barber_id: barberId,
    });
    if (rpcError) {
      // Do not silently fall back on a transient failure; the customer stays on this step and can retry.
      setError(t('joinFailed'));
      return;
    }
    setSelectedBarberId(barberId);
    setAcceptFallback(false);
    const result = data?.[0];
    if (result?.preferred_eligible) {
      setStep('review');
      return;
    }
    if (result?.preferred_scheduled_today) {
      setStep('availability');
      return;
    }
    // Not scheduled today at all -- no prompt, straight to the fallback barber (spec decision 2).
    setAcceptFallback(true);
    setStep('review');
  }

  async function handleConfirmJoin() {
    if (!branchId || !selectedServiceId) return;
    setSubmitting(true);
    setError(null);
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      setError(t('notSignedIn'));
      setSubmitting(false);
      return;
    }
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/tickets-join`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          branch_id: branchId,
          branch_service_id: selectedServiceId,
          preferred_barber_id: selectedBarberId,
          accept_fallback: acceptFallback,
        }),
      },
    );
    setSubmitting(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(
        body.error === 'NO_BARBER_AVAILABLE'
          ? t('noBarberAvailable')
          : (body.error ?? t('joinFailed')),
      );
      return;
    }
    const { ticket } = await response.json();
    router.push(`/tickets/${ticket.id}`);
  }

  if (!branchId) return null;

  return (
    <main>
      <h1>{t('title')}</h1>
      {error && <p role="alert">{error}</p>}

      {step === 'service' && (
        <div>
          <h2>{t('serviceStepTitle')}</h2>
          <ul>
            {services.map((s) => (
              <li key={s.branchServiceId}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedServiceId(s.branchServiceId);
                    setStep('barber');
                  }}
                >
                  {s.serviceName}
                  {s.priceGhs !== null && ` ${t('priceLabel', { price: s.priceGhs.toFixed(2) })}`}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {step === 'barber' && (
        <div>
          <h2>{t('barberStepTitle')}</h2>
          <ul>
            <li>
              <button type="button" onClick={() => handleSelectBarber(null)}>
                {t('anyAvailable')}
              </button>
            </li>
            {barbers.map((b) => (
              <li key={b.id}>
                <button type="button" onClick={() => handleSelectBarber(b.id)}>
                  {b.id}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {step === 'availability' && (
        <div>
          <h2>{t('availabilityStepTitle')}</h2>
          <p>{t('preferredBusyMessage')}</p>
          <button
            type="button"
            onClick={() => {
              setAcceptFallback(false);
              setStep('review');
            }}
          >
            {t('waitForPreferred')}
          </button>
          <button
            type="button"
            onClick={() => {
              setAcceptFallback(true);
              setStep('review');
            }}
          >
            {t('takeNextAvailable')}
          </button>
        </div>
      )}

      {step === 'review' && (
        <div>
          <h2>{t('reviewTitle')}</h2>
          <p>{services.find((s) => s.branchServiceId === selectedServiceId)?.serviceName}</p>
          <p>{selectedBarberId ? selectedBarberId : t('anyAvailable')}</p>
          <button type="button" disabled={submitting} onClick={handleConfirmJoin}>
            {t('confirmJoin')}
          </button>
        </div>
      )}
    </main>
  );
}
