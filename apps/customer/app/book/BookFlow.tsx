'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';
import { sessionEndedLoginPath } from '../login/nextPath';
import SlotPicker, { formatSlotDate, formatSlotTime } from '../appointments/SlotPicker';
import { appointmentErrorKey } from '../appointments/appointmentErrors';

type Barber = Database['public']['Functions']['list_bookable_barbers']['Returns'][number];

interface ServiceOption {
  branchServiceId: string;
  serviceName: string;
  priceGhs: number | null;
}

type Step = 'service' | 'barber' | 'availability' | 'review' | 'datetime' | 'scheduleReview';
type Mode = 'now' | 'schedule';

export default function BookFlow() {
  const t = useTranslations('Book');
  const ta = useTranslations('Appointments');
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
  const [mode, setMode] = useState<Mode>('now');
  const [slotStart, setSlotStart] = useState<string | null>(null);
  const [slotRefresh, setSlotRefresh] = useState(0);

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

      const { data: barberRows } = await supabase.rpc('list_bookable_barbers', {
        p_branch_id: branchId!,
      });
      setBarbers(barberRows ?? []);
    }
    load();
  }, [branchId]);

  async function handleSelectBarber(barberId: string | null) {
    setError(null);
    if (mode === 'schedule') {
      // A booking picks its own time; today's availability check doesn't apply.
      setSelectedBarberId(barberId);
      setStep('datetime');
      return;
    }
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
      router.push(sessionEndedLoginPath(`/book?branch=${branchId}`));
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
          : body.error === 'BRANCH_CLOSED'
            ? t('branchClosed')
            : (body.error ?? t('joinFailed')),
      );
      return;
    }
    const { ticket } = await response.json();
    router.push(`/tickets/${ticket.id}`);
  }

  async function handleConfirmBook() {
    if (!branchId || !selectedServiceId || !slotStart) return;
    setSubmitting(true);
    setError(null);
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      router.push(sessionEndedLoginPath(`/book?branch=${branchId}`));
      return;
    }
    const { data: appointmentId, error: bookError } = await supabase.rpc('book_appointment', {
      p_branch_service_id: selectedServiceId,
      p_barber_id: selectedBarberId,
      p_slot_start: slotStart,
    });
    setSubmitting(false);
    if (bookError || !appointmentId) {
      const key = appointmentErrorKey(bookError?.message);
      setError(ta(key));
      if (key === 'slotTaken') {
        setSlotStart(null);
        setSlotRefresh((n) => n + 1);
        setStep('datetime');
      }
      return;
    }
    router.push(`/appointments/${appointmentId}?booked=1`);
  }

  if (!branchId) return null;
  const selectedBarberName = selectedBarberId
    ? barbers.find((b) => b.id === selectedBarberId)?.display_name
    : undefined;

  return (
    <main>
      <h1>{t('title')}</h1>
      {error && <p role="alert">{error}</p>}

      {step === 'service' && (
        <div role="group">
          <button type="button" aria-pressed={mode === 'now'} onClick={() => setMode('now')}>
            {t('modeJoinNow')}
          </button>
          <button
            type="button"
            aria-pressed={mode === 'schedule'}
            onClick={() => setMode('schedule')}
          >
            {t('modeSchedule')}
          </button>
        </div>
      )}

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
                  {b.display_name}
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
          <p>{selectedBarberName ?? t('anyAvailable')}</p>
          <button type="button" disabled={submitting} onClick={handleConfirmJoin}>
            {t('confirmJoin')}
          </button>
        </div>
      )}

      {step === 'datetime' && (
        <div>
          <h2>{t('dateTimeStepTitle')}</h2>
          <SlotPicker
            branchServiceId={selectedServiceId}
            barberId={selectedBarberId}
            refreshKey={slotRefresh}
            onPick={(slot) => {
              setError(null);
              setSlotStart(slot);
              setStep('scheduleReview');
            }}
          />
        </div>
      )}

      {step === 'scheduleReview' && slotStart && (
        <div>
          <h2>{t('scheduleReviewTitle')}</h2>
          <p>{services.find((s) => s.branchServiceId === selectedServiceId)?.serviceName}</p>
          <p>{selectedBarberName ?? t('anyAvailable')}</p>
          <p>
            {formatSlotDate(slotStart)} {formatSlotTime(slotStart)}
          </p>
          <button type="button" disabled={submitting} onClick={handleConfirmBook}>
            {t('confirmBook')}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => {
              setError(null);
              setStep('datetime');
            }}
          >
            {t('changeTime')}
          </button>
        </div>
      )}
    </main>
  );
}
