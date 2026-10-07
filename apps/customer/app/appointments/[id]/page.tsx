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
import PushBanner from '../../push/PushBanner';

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
const ARRIVE_WINDOW_MS = 30 * 60 * 1000;
const MAX_ARRIVE_TIMER_MS = 12 * 60 * 60 * 1000;

interface Loaded {
  appointment: Appointment;
  serviceName: string;
  branchName: string;
  barberName: string | null;
  priceGhs: number | null;
  changeable: boolean;
  canArrive: boolean;
}

export default function AppointmentDetailPage() {
  const t = useTranslations('Appointments');
  const tt = useTranslations('TicketTracking');
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [notFound, setNotFound] = useState(false);
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
      if (cancelled) return;
      if (!appointment) {
        setNotFound(true);
        return;
      }
      const [{ data: bs }, { data: price }, { data: branch }, { data: barbers }] =
        await Promise.all([
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
          supabase.from('branches').select('name').eq('id', appointment.branch_id).maybeSingle(),
          supabase.rpc('list_bookable_barbers', { p_branch_id: appointment.branch_id }),
        ]);
      if (cancelled) return;
      setLoaded({
        appointment,
        serviceName: (bs?.services as unknown as { name: string } | null)?.name ?? '',
        branchName: branch?.name ?? '',
        // A chosen barber who has since left the branch is no longer listed: fall back to generic text.
        barberName:
          (barbers ?? []).find((b) => b.id === appointment.preferred_barber_id)?.display_name ??
          null,
        priceGhs: price?.price_ghs ?? null,
        // Computed here (not in render) to keep render pure.
        changeable:
          appointment.status === 'scheduled' &&
          new Date(appointment.scheduled_start).getTime() - Date.now() > CHANGE_CUTOFF_MS,
        canArrive:
          appointment.status === 'scheduled' &&
          Date.now() >= new Date(appointment.scheduled_start).getTime() - ARRIVE_WINDOW_MS,
      });
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [supabase, params.id, router, reloadKey]);

  // The "I've arrived" button only shows when the page was loaded inside the window, so when the
  // window opens later, reload at its start (skipped when it is more than 12 hours away).
  const arriveWindowStart =
    loaded && loaded.appointment.status === 'scheduled' && !loaded.canArrive
      ? new Date(loaded.appointment.scheduled_start).getTime() - ARRIVE_WINDOW_MS
      : null;
  useEffect(() => {
    if (arriveWindowStart === null) return;
    const delay = arriveWindowStart - Date.now();
    if (delay <= 0 || delay > MAX_ARRIVE_TIMER_MS) return;
    const timer = setTimeout(() => setReloadKey((n) => n + 1), delay);
    return () => clearTimeout(timer);
  }, [arriveWindowStart, reloadKey]);

  if (!loaded) {
    return notFound ? (
      <main>
        <p>{t('notFound')}</p>
        <Link href="/tickets">{t('viewUpcoming')}</Link>
      </main>
    ) : null;
  }
  const { appointment, serviceName, branchName, barberName, priceGhs, changeable, canArrive } =
    loaded;

  function goBack() {
    setMode('view');
    setReason(null);
    setError(null);
  }

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

  async function handleArrive() {
    setBusy(true);
    setError(null);
    const { data: ticketId, error: rpcError } = await supabase.rpc('check_in_my_appointment', {
      p_appointment_id: appointment.id,
    });
    setBusy(false);
    if (rpcError) {
      setError(t(appointmentErrorKey(rpcError.message)));
      setReloadKey((n) => n + 1);
      return;
    }
    if (ticketId) {
      router.push(`/tickets/${ticketId}`);
      return;
    }
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
      {(appointment.status === 'scheduled' || appointment.status === 'checked_in') && (
        <PushBanner />
      )}
      {error && <p role="alert">{error}</p>}
      <p>{t('dateLabel', { date: formatSlotDate(appointment.scheduled_start) })}</p>
      <p>{t('timeLabel', { time: formatSlotTime(appointment.scheduled_start) })}</p>
      <p>{t('branchLabel', { branch: branchName })}</p>
      <p>{t('serviceLabel', { service: serviceName })}</p>
      {priceGhs !== null && <p>{t('priceLabel', { price: priceGhs.toFixed(2) })}</p>}
      <p>
        {barberName
          ? t('barberLabel', { barber: barberName })
          : appointment.preferred_barber_id
            ? t('chosenBarber')
            : t('anyBarber')}
      </p>
      <p>{t('statusLabel', { status: t(`statuses.${appointment.status}`) })}</p>
      {appointment.status === 'checked_in' && (
        <p>{t('checkedInWait', { time: formatSlotTime(appointment.scheduled_start) })}</p>
      )}
      {mode === 'view' && canArrive && (
        <button type="button" disabled={busy} onClick={handleArrive}>
          {t('arrived')}
        </button>
      )}

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
          <p>{t('tooLateOnline')}</p>
        ))}

      {mode === 'reschedule' && (
        <div>
          <SlotPicker
            branchServiceId={appointment.branch_service_id}
            barberId={appointment.preferred_barber_id}
            refreshKey={slotRefresh}
            ignoreAppointmentId={appointment.id}
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
          <button type="button" onClick={goBack}>
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
          <button type="button" onClick={goBack}>
            {t('back')}
          </button>
        </fieldset>
      )}

      <Link href="/tickets">{t('viewUpcoming')}</Link>
    </main>
  );
}
