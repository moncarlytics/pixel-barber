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

type Step = 'service' | 'barber' | 'review';

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
        }),
      },
    );
    setSubmitting(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? t('joinFailed'));
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
              <button
                type="button"
                onClick={() => {
                  setSelectedBarberId(null);
                  setStep('review');
                }}
              >
                {t('anyAvailable')}
              </button>
            </li>
            {barbers.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedBarberId(b.id);
                    setStep('review');
                  }}
                >
                  {b.id}
                </button>
              </li>
            ))}
          </ul>
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
