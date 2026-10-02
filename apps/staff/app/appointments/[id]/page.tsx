'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import StaffSlotPicker, { formatSlotDate, formatSlotTime } from '../StaffSlotPicker';
import { staffAppointmentErrorKey } from '../staffAppointmentErrors';

const REASONS = [
  'wait_too_long',
  'cant_make_it',
  'changed_plans',
  'found_another_barber',
  'emergency',
  'other',
] as const;
type Reason = (typeof REASONS)[number];

interface Appointment {
  id: string;
  branch_name: string;
  branch_service_id: string;
  service_name: string;
  price_ghs: number | null;
  scheduled_start: string;
  status: string;
  customer_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  preferred_barber_id: string | null;
  barber_name: string | null;
  created_by_staff_name: string | null;
}

type Mode = 'view' | 'reschedule' | 'cancel';
type Loaded =
  | { key: string; kind: 'ok'; row: Appointment; startsInFuture: boolean; isToday: boolean }
  | { key: string; kind: 'empty' }
  | { key: string; kind: 'error'; message: string | undefined };

export default function StaffAppointmentPage() {
  const t = useTranslations('StaffAppointments');
  const params = useParams<{ id: string }>();
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [reloadKey, setReloadKey] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [mode, setMode] = useState<Mode>('view');
  const [pickedSlot, setPickedSlot] = useState<string | null>(null);
  const [reason, setReason] = useState<Reason | null>(null);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [startedEarlyId, setStartedEarlyId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const requestKey = `${params.id}:${reloadKey}`;

  useEffect(() => {
    let cancelled = false;
    supabase
      .rpc('get_branch_appointment', { p_appointment_id: params.id })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setLoaded({ key: requestKey, kind: 'error', message: error.message });
          return;
        }
        const row = (data ?? [])[0] as Appointment | undefined;
        if (!row) {
          setLoaded({ key: requestKey, kind: 'empty' });
          return;
        }
        setLoaded({
          key: requestKey,
          kind: 'ok',
          row,
          startsInFuture: Date.parse(row.scheduled_start) > Date.now(),
          isToday: row.scheduled_start.slice(0, 10) === new Date().toISOString().slice(0, 10),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, params.id, requestKey]);

  const current = loaded && loaded.key === requestKey ? loaded : null;

  function resetMode() {
    setMode('view');
    setPickedSlot(null);
    setReason(null);
    setActionError(undefined);
  }

  async function run(call: PromiseLike<{ error: { message: string } | null }>) {
    setBusy(true);
    setActionError(undefined);
    const { error } = await call;
    setBusy(false);
    if (error) {
      setActionError(error.message);
      if (error.message === 'slot_taken') {
        setPickedSlot(null);
        setRefreshKey((k) => k + 1);
      }
      // Re-read the appointment so a change made elsewhere (e.g. cron conversion) shows at once.
      setReloadKey((k) => k + 1);
      return;
    }
    resetMode();
    setReloadKey((k) => k + 1);
  }

  async function checkIn(id: string) {
    setBusy(true);
    setActionError(undefined);
    const { data: ticketId, error } = await supabase.rpc('staff_check_in_appointment', {
      p_appointment_id: id,
    });
    setBusy(false);
    if (error) {
      setActionError(error.message);
      setReloadKey((k) => k + 1);
      return;
    }
    if (ticketId) setStartedEarlyId(id);
    resetMode();
    setReloadKey((k) => k + 1);
  }

  const backLink = <Link href="/appointments">{t('backToCalendar')}</Link>;

  if (!current) {
    return (
      <main>
        <h1>{t('detailTitle')}</h1>
        {backLink}
      </main>
    );
  }
  if (current.kind === 'empty') {
    return (
      <main>
        <h1>{t('detailTitle')}</h1>
        <p>{t('notFound')}</p>
        {backLink}
      </main>
    );
  }
  if (current.kind === 'error') {
    return (
      <main>
        <h1>{t('detailTitle')}</h1>
        <p role="alert">{t(`errors.${staffAppointmentErrorKey(current.message)}`)}</p>
        {backLink}
      </main>
    );
  }

  const { row, startsInFuture, isToday } = current;
  const actionable = row.status === 'scheduled' || row.status === 'checked_in';

  return (
    <main>
      <h1>{t('detailTitle')}</h1>
      <p>{t('dateLabel', { date: formatSlotDate(row.scheduled_start) })}</p>
      <p>{t('timeLabel', { time: formatSlotTime(row.scheduled_start) })}</p>
      <p>{t('branchLabel', { branch: row.branch_name })}</p>
      <p>{t('serviceLabel', { service: row.service_name })}</p>
      {row.price_ghs != null && <p>{t('priceLabel', { price: row.price_ghs })}</p>}
      <p>{t('barberLabel', { barber: row.barber_name ?? t('anyBarber') })}</p>
      <p>{t('customerLabel', { name: row.customer_name })}</p>
      <p>{row.customer_phone ? t('phoneLabel', { phone: row.customer_phone }) : t('noPhone')}</p>
      <p>{t('statusLabel', { status: t(`statuses.${row.status}`) })}</p>
      <p>
        {row.created_by_staff_name
          ? t('bookedByStaff', { name: row.created_by_staff_name })
          : t('bookedByCustomer')}
      </p>

      {row.status === 'converted' && (
        <>
          <p>{startedEarlyId === row.id ? t('startedEarly') : t('inQueue')}</p>
          <Link href="/tickets">{t('openLiveQueue')}</Link>
        </>
      )}

      {actionable && mode === 'view' && (
        <div>
          {row.status === 'scheduled' && isToday && (
            <button type="button" disabled={busy} onClick={() => checkIn(row.id)}>
              {t('checkIn')}
            </button>
          )}
          <button type="button" onClick={() => setMode('reschedule')}>
            {t('reschedule')}
          </button>
          <button type="button" onClick={() => setMode('cancel')}>
            {t('cancel')}
          </button>
          {!startsInFuture && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                run(supabase.rpc('staff_mark_appointment_no_show', { p_appointment_id: row.id }))
              }
            >
              {t('markNoShow')}
            </button>
          )}
        </div>
      )}

      {actionable && mode === 'reschedule' && (
        <div>
          <StaffSlotPicker
            branchServiceId={row.branch_service_id}
            barberId={row.preferred_barber_id}
            customerId={row.customer_id}
            ignoreAppointmentId={row.id}
            onPick={setPickedSlot}
            refreshKey={refreshKey}
          />
          {pickedSlot && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                run(
                  supabase.rpc('staff_reschedule_appointment', {
                    p_appointment_id: row.id,
                    p_slot_start: pickedSlot,
                  }),
                )
              }
            >
              {t('confirmReschedule')}
            </button>
          )}
          <button type="button" onClick={resetMode}>
            {t('back')}
          </button>
        </div>
      )}

      {actionable && mode === 'cancel' && (
        <div>
          <fieldset>
            <legend>{t('cancelTitle')}</legend>
            {REASONS.map((r) => (
              <label key={r}>
                <input
                  type="radio"
                  name="reason"
                  value={r}
                  checked={reason === r}
                  onChange={() => setReason(r)}
                />
                {t(`reasons.${r}`)}
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            disabled={busy || !reason}
            onClick={() =>
              reason &&
              run(
                supabase.rpc('staff_cancel_appointment', {
                  p_appointment_id: row.id,
                  p_reason: reason,
                }),
              )
            }
          >
            {t('confirmCancel')}
          </button>
          <button type="button" onClick={resetMode}>
            {t('back')}
          </button>
        </div>
      )}

      {actionError !== undefined && (
        <p role="alert">{t(`errors.${staffAppointmentErrorKey(actionError)}`)}</p>
      )}
      {backLink}
    </main>
  );
}
