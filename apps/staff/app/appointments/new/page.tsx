'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient, normalizeGhanaPhone } from '@pixel-barber/shared';
import StaffSlotPicker, { formatSlotDate, formatSlotTime } from '../StaffSlotPicker';
import { staffAppointmentErrorKey } from '../staffAppointmentErrors';

type Step = 'customer' | 'service' | 'barber' | 'datetime' | 'review';

interface ServiceOption {
  id: string;
  name: string;
}
interface BarberOption {
  id: string;
  display_name: string;
}

function NewAppointmentForm() {
  const t = useTranslations('StaffAppointments');
  const router = useRouter();
  const branch = useSearchParams().get('branch');
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [step, setStep] = useState<Step>('customer');
  const [name, setName] = useState('');
  const [phoneInput, setPhoneInput] = useState('');
  const [phone, setPhone] = useState<string | null>(null);
  const [services, setServices] = useState<ServiceOption[] | null>(null);
  const [servicesFailed, setServicesFailed] = useState(false);
  const [barbers, setBarbers] = useState<BarberOption[]>([]);
  const [service, setService] = useState<ServiceOption | null>(null);
  const [barber, setBarber] = useState<BarberOption | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!branch) return;
    let cancelled = false;
    supabase
      .from('branch_services')
      .select('id, services(name)')
      .eq('branch_id', branch)
      .eq('is_active', true)
      .then(({ data, error: loadError }) => {
        if (cancelled) return;
        if (loadError) {
          setServicesFailed(true);
          return;
        }
        setServices(
          (data ?? []).map((r) => {
            const svc = r.services as { name: string } | { name: string }[] | null;
            const svcName = Array.isArray(svc) ? svc[0]?.name : svc?.name;
            return { id: r.id, name: svcName ?? '' };
          }),
        );
      });
    supabase.rpc('list_bookable_barbers', { p_branch_id: branch }).then(({ data }) => {
      if (cancelled) return;
      setBarbers((data ?? []).map((b) => ({ id: b.id, display_name: b.display_name })));
    });
    return () => {
      cancelled = true;
    };
  }, [supabase, branch]);

  if (!branch) {
    return (
      <main>
        <h1>{t('newTitle')}</h1>
        <p role="alert">{t('errors.notAllowed')}</p>
        <Link href="/appointments">{t('backToCalendar')}</Link>
      </main>
    );
  }

  function submitCustomer() {
    setError(undefined);
    const trimmed = phoneInput.trim();
    if (trimmed) {
      const normalised = normalizeGhanaPhone(trimmed);
      if (!normalised) {
        setError('invalid_phone');
        return;
      }
      setPhone(normalised);
    } else {
      setPhone(null);
    }
    setStep('service');
  }

  async function book() {
    if (!service || !slot) return;
    setBusy(true);
    setError(undefined);
    const { data, error: rpcError } = await supabase.rpc('staff_book_appointment', {
      p_branch_service_id: service.id,
      p_barber_id: barber?.id ?? null,
      p_slot_start: slot,
      p_customer_name: name.trim(),
      p_customer_phone: phone,
    });
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      if (rpcError.message === 'slot_taken') {
        setSlot(null);
        setStep('datetime');
        setRefreshKey((k) => k + 1);
      }
      return;
    }
    router.push(`/appointments/${data}`);
  }

  return (
    <main>
      <h1>{t('newTitle')}</h1>

      {step === 'customer' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitCustomer();
          }}
        >
          <input
            type="text"
            placeholder={t('customerName')}
            aria-label={t('customerName')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <input
            type="tel"
            placeholder={t('customerPhone')}
            aria-label={t('customerPhone')}
            value={phoneInput}
            onChange={(e) => setPhoneInput(e.target.value)}
          />
          <button type="submit" disabled={!name.trim()}>
            {t('continue')}
          </button>
        </form>
      )}

      {step === 'service' && (
        <div>
          <p>{t('service')}</p>
          {servicesFailed && <p role="alert">{t('errors.generic')}</p>}
          {services && services.length === 0 && <p>{t('noServices')}</p>}
          <ul>
            {(services ?? []).map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => {
                    setService(s);
                    setStep('barber');
                  }}
                >
                  {s.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {step === 'barber' && (
        <ul>
          <li>
            <button
              type="button"
              onClick={() => {
                setBarber(null);
                setStep('datetime');
              }}
            >
              {t('anyBarber')}
            </button>
          </li>
          {barbers.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => {
                  setBarber(b);
                  setStep('datetime');
                }}
              >
                {b.display_name}
              </button>
            </li>
          ))}
        </ul>
      )}

      {step === 'datetime' && service && (
        <StaffSlotPicker
          branchServiceId={service.id}
          barberId={barber?.id ?? null}
          refreshKey={refreshKey}
          onPick={(picked) => {
            setSlot(picked);
            setStep('review');
          }}
        />
      )}

      {step === 'review' && slot && (
        <div>
          <h2>{t('reviewTitle')}</h2>
          <p>{t('serviceLabel', { service: service?.name ?? '' })}</p>
          <p>{t('barberLabel', { barber: barber?.display_name ?? t('anyBarber') })}</p>
          <p>{`${formatSlotDate(slot)} ${formatSlotTime(slot)}`}</p>
          <p>{t('customerLabel', { name })}</p>
          {phone && <p>{t('existingCustomerNote')}</p>}
          <p>{phone ? t('phoneLabel', { phone }) : t('noPhone')}</p>
          <button
            type="button"
            onClick={() => {
              setError(undefined);
              setStep('datetime');
            }}
          >
            {t('changeTime')}
          </button>
          <button type="button" disabled={busy} onClick={book}>
            {t('confirmBook')}
          </button>
        </div>
      )}

      {error !== undefined && <p role="alert">{t(`errors.${staffAppointmentErrorKey(error)}`)}</p>}
      <Link href="/appointments">{t('backToCalendar')}</Link>
    </main>
  );
}

export default function NewStaffAppointmentPage() {
  return (
    <Suspense fallback={null}>
      <NewAppointmentForm />
    </Suspense>
  );
}
