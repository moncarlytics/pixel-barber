-- Appointments part 3, Section 1 (Docs/superpowers/specs/2026-10-02-appointments-reminders-checkin-wait-design.md):
-- reminder texts are queued as notifications (sent by send-notifications), and the every-minute
-- appointments job becomes one tick: convert due appointments, queue reminders, refresh estimates.

-- One reminder of each type per appointment slot; a rescheduled appointment gets fresh ones.
create unique index notifications_one_reminder_per_slot
  on notifications (related_appointment_id, notification_type, (payload->>'slot'))
  where notification_type in ('appointment_reminder_day', 'appointment_reminder_hour');

create index if not exists idx_notifications_appointment on notifications (related_appointment_id);

-- p_now is the clock (a parameter so tests can run any time of day). Returns rows queued.
create or replace function enqueue_appointment_reminders(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_day integer;
  v_hour integer;
begin
  -- Evening before: 18:00-21:00 on the day before the slot's date, for appointments that already
  -- existed at 18:00.
  with candidates as (
    select a.id, a.customer_id, a.scheduled_start, a.created_at,
           (((a.scheduled_start at time zone 'UTC')::date - 1) + time '18:00') at time zone 'UTC' as evening
    from appointments a
    where a.status in ('scheduled', 'checked_in')
      and a.scheduled_start > p_now
      and a.scheduled_start <= p_now + interval '31 hours'
  )
  insert into notifications (recipient_type, recipient_id, channel, notification_type, related_appointment_id, payload)
  select 'customer', c.customer_id, 'sms', 'appointment_reminder_day', c.id,
         jsonb_build_object('slot', c.scheduled_start)
  from candidates c
  where p_now >= c.evening
    and p_now < c.evening + interval '3 hours'
    and c.created_at <= c.evening
  on conflict (related_appointment_id, notification_type, (payload->>'slot'))
    where notification_type in ('appointment_reminder_day', 'appointment_reminder_hour')
    do nothing;
  get diagnostics v_day = row_count;

  -- One hour before, for appointments booked at least an hour ahead.
  insert into notifications (recipient_type, recipient_id, channel, notification_type, related_appointment_id, payload)
  select 'customer', a.customer_id, 'sms', 'appointment_reminder_hour', a.id,
         jsonb_build_object('slot', a.scheduled_start)
  from appointments a
  where a.status in ('scheduled', 'checked_in')
    and p_now >= a.scheduled_start - interval '1 hour'
    and p_now < a.scheduled_start
    and a.created_at <= a.scheduled_start - interval '1 hour'
  on conflict (related_appointment_id, notification_type, (payload->>'slot'))
    where notification_type in ('appointment_reminder_day', 'appointment_reminder_hour')
    do nothing;
  get diagnostics v_hour = row_count;

  return v_day + v_hour;
end;
$$;

revoke execute on function enqueue_appointment_reminders(timestamptz) from public, anon, authenticated;
grant execute on function enqueue_appointment_reminders(timestamptz) to service_role;

-- The every-minute appointments job. Each step is isolated: one failing step logs a warning and
-- the others still run.
create or replace function appointments_minute_tick()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    perform activate_due_appointments();
  exception when others then
    raise warning 'appointments_minute_tick: activate_due_appointments failed: %', sqlerrm;
  end;
  begin
    perform enqueue_appointment_reminders();
  exception when others then
    raise warning 'appointments_minute_tick: enqueue_appointment_reminders failed: %', sqlerrm;
  end;
  begin
    perform refresh_all_wait_estimates();
  exception when others then
    raise warning 'appointments_minute_tick: refresh_all_wait_estimates failed: %', sqlerrm;
  end;
end;
$$;

revoke execute on function appointments_minute_tick() from public, anon, authenticated;
grant execute on function appointments_minute_tick() to service_role;

-- Same job name: cron.schedule replaces the existing schedule's command.
select cron.schedule('activate-due-appointments', '* * * * *', 'select appointments_minute_tick()');
