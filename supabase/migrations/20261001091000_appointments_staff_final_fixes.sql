-- Appointments part 2 final-review fixes: check-in only on the day of the appointment, a
-- rescheduled appointment returns to 'scheduled' (must be checked in again), and a no-show
-- attempt before the start time reports 'not_started'.

create or replace function staff_check_in_appointment(p_appointment_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_appt appointments%rowtype;
begin
  v_appt := staff_lock_appointment(p_appointment_id);
  if v_appt.status <> 'scheduled' then
    raise exception 'too_late';
  end if;
  if (v_appt.scheduled_start at time zone 'UTC')::date <> (now() at time zone 'UTC')::date then
    raise exception 'not_today';
  end if;
  update appointments
    set status = 'checked_in', checked_in_at = now(), version = version + 1
    where id = p_appointment_id;
end;
$$;

revoke execute on function staff_check_in_appointment(uuid) from public, anon;
grant execute on function staff_check_in_appointment(uuid) to authenticated;

create or replace function staff_reschedule_appointment(p_appointment_id uuid, p_slot_start timestamptz)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_branch_id uuid;
  v_customer_id uuid;
  v_appt appointments%rowtype;
  v_duration int;
  v_problem text;
begin
  select branch_id, customer_id into v_branch_id, v_customer_id
  from appointments where id = p_appointment_id;
  if v_branch_id is null then
    raise exception 'not_found';
  end if;
  if not (has_capability('edit_tickets') and in_branch_scope(v_branch_id)) then
    raise exception 'not_allowed';
  end if;
  -- Same lock order as booking (branch, then customer).
  perform pg_advisory_xact_lock(hashtextextended('appointments:branch:' || v_branch_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('appointments:customer:' || v_customer_id::text, 0));

  v_appt := staff_lock_appointment(p_appointment_id);
  v_problem := appointment_slot_problem(
    v_appt.branch_service_id, v_appt.preferred_barber_id, p_slot_start, v_appt.customer_id,
    v_appt.id, interval '0'
  );
  if v_problem is not null then
    raise exception '%', v_problem;
  end if;
  select coalesce(bs.duration_minutes_override, s.default_duration_minutes) into v_duration
  from branch_services bs join services s on s.id = bs.service_id
  where bs.id = v_appt.branch_service_id;
  update appointments
    set scheduled_start = p_slot_start,
        scheduled_end = p_slot_start + make_interval(mins => v_duration),
        status = 'scheduled',
        checked_in_at = null,
        version = version + 1
    where id = p_appointment_id;
end;
$$;

revoke execute on function staff_reschedule_appointment(uuid, timestamptz) from public, anon;
grant execute on function staff_reschedule_appointment(uuid, timestamptz) to authenticated;

create or replace function staff_mark_appointment_no_show(p_appointment_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_appt appointments%rowtype;
begin
  v_appt := staff_lock_appointment(p_appointment_id);
  if v_appt.scheduled_start > now() then
    raise exception 'not_started';
  end if;
  update appointments set status = 'no_show', version = version + 1 where id = p_appointment_id;
end;
$$;

revoke execute on function staff_mark_appointment_no_show(uuid) from public, anon;
grant execute on function staff_mark_appointment_no_show(uuid) to authenticated;
