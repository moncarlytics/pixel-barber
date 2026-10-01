'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';
import SlotPicker, { formatSlotDate, formatSlotTime } from '../SlotPicker';
import { appointmentErrorKey } from '../appointmentErrors';
import { sessionEndedLoginPath } from '../../login/nextPath';

type Appointment = Database['public']['Tables']['appointments']['Row'];
type CancelReason = Database['public']['Enums']['cancel_reason'];

// Customer-selectable reasons (branch_closed is system-only). Labels reuse TicketTracking's.
const REASONS: { value: CancelReason; labelKey: string }[] = [
  { value: 'wait_too_long', labelKey: 'reasonWaitTooLong' },
  { value: 'cant_make_it', labelKey: 'reasonCantMakeIt' },
  { value: 'changed_plans', labelKey: 'reasonChangedPlans' },
  { value: 'found_another_barber', labelKey: 'reasonFoundAnotherBarber' },
  { value: 'emergency', labelKey: 'reasonEmergency' },
  { value: 'other', labelKey: 'reasonOther' },
];
const CHANGE_CUTOFF_MS = 60 * 60 * 1000;

interface Loaded {
  appointment: Appointment;
  serviceName: string;
  priceGhs: number | null;
  changeable: boolean;
}

export default function AppointmentDetailPage() {
  const t = useTranslations('Appointments');
  const tt = useTranslations('TicketTracking');
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [mode, setMode] = useState<'view' | 'reschedule' | 'cancel'>('view');
  const [newSlot, setNewSlot] = useState<string | null>(null);
  const [slotRefresh, setSlotRefresh] = useState(0);
  const [reason, setReason] = useState<CancelReason | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) {
        router.push(sessionEndedLoginPath(`/appointments/${params.id}`));
        return;
      }
      const { data: appointment } = await supabase
        .from('appointments')
        .select('*')
        .eq('id', params.id)
        .maybeSingle();
      if (cancelled || !appointment) return;
      const [{ data: bs }, { data: price }] = await Promise.all([
        supabase
          .from('branch_services')
          .select('services(name)')
          .eq('id', appointment.branch_service_id)
          .maybeSingle(),
        supabase
          .from('current_branch_service_price')
          .select('price_ghs')
          .eq('branch_service_id', appointment.branch_service_id)
          .maybeSingle(),
      ]);
      if (cancelled) return;
      setLoaded({
        appointment,
        serviceName: (bs?.services as unknown as { name: string } | null)?.name ?? '',
        priceGhs: price?.price_ghs ?? null,
        // Computed here (not in render) to keep render pure.
        changeable:
          appointment.status === 'scheduled' &&
          new Date(appointment.scheduled_start).getTime() - Date.now() > CHANGE_CUTOFF_MS,
      });
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [supabase, params.id, router, reloadKey]);

  if (!loaded) return null;
  const { appointment, serviceName, priceGhs, changeable } = loaded;

  async function handleReschedule() {
    if (!newSlot) return;
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc('reschedule_appointment', {
      p_appointment_id: appointment.id,
      p_slot_start: newSlot,
    });
    setBusy(false);
    if (rpcError) {
      const key = appointmentErrorKey(rpcError.message);
      setError(t(key));
      if (key === 'slotTaken') {
        setNewSlot(null);
        setSlotRefresh((n) => n + 1);
      }
      return;
    }
    setMode('view');
    setNewSlot(null);
    setReloadKey((n) => n + 1);
  }

  async function handleCancel() {
    if (!reason) return;
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc('cancel_appointment', {
      p_appointment_id: appointment.id,
      p_reason: reason,
    });
    setBusy(false);
    if (rpcError) {
      setError(t(appointmentErrorKey(rpcError.message)));
      return;
    }
    setMode('view');
    setReloadKey((n) => n + 1);
  }

  return (
    <main>
      <h1>{searchParams.get('booked') ? t('bookedTitle') : t('detailTitle')}</h1>
      {error && <p role="alert">{error}</p>}
      <p>{t('dateLabel', { date: formatSlotDate(appointment.scheduled_start) })}</p>
      <p>{t('timeLabel', { time: formatSlotTime(appointment.scheduled_start) })}</p>
      <p>{t('serviceLabel', { service: serviceName })}</p>
      {priceGhs !== null && <p>{t('priceLabel', { price: priceGhs.toFixed(2) })}</p>}
      <p>{appointment.preferred_barber_id ? t('chosenBarber') : t('anyBarber')}</p>
      <p>{t('statusLabel', { status: appointment.status })}</p>

      {mode === 'view' &&
        (changeable ? (
          <div>
            <button type="button" onClick={() => setMode('reschedule')}>
              {t('reschedule')}
            </button>
            <button type="button" onClick={() => setMode('cancel')}>
              {t('cancel')}
            </button>
          </div>
        ) : (
          appointment.status === 'scheduled' && <p>{t('tooLateOnline')}</p>
        ))}

      {mode === 'reschedule' && (
        <div>
          <SlotPicker
            branchServiceId={appointment.branch_service_id}
            barberId={appointment.preferred_barber_id}
            refreshKey={slotRefresh}
            onPick={(slot) => {
              setError(null);
              setNewSlot(slot);
            }}
          />
          {newSlot && (
            <p>
              {formatSlotDate(newSlot)} {formatSlotTime(newSlot)}
            </p>
          )}
          <button type="button" disabled={!newSlot || busy} onClick={handleReschedule}>
            {t('confirmReschedule')}
          </button>
          <button type="button" onClick={() => setMode('view')}>
            {t('back')}
          </button>
        </div>
      )}

      {mode === 'cancel' && (
        <fieldset>
          <legend>{t('cancelTitle')}</legend>
          {REASONS.map((r) => (
            <label key={r.value}>
              <input
                type="radio"
                name="reason"
                value={r.value}
                checked={reason === r.value}
                onChange={() => setReason(r.value)}
              />
              {tt(r.labelKey)}
            </label>
          ))}
          <button type="button" disabled={!reason || busy} onClick={handleCancel}>
            {t('confirmCancel')}
          </button>
          <button type="button" onClick={() => setMode('view')}>
            {t('back')}
          </button>
        </fieldset>
      )}

      <Link href="/tickets">{t('viewUpcoming')}</Link>
    </main>
  );
}
