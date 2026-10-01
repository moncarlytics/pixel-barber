-- Appointments part 1: customer cancel and reschedule, own appointments only, while scheduled and
-- more than an hour before the start.

create or replace function cancel_appointment(p_appointment_id uuid, p_reason cancel_reason)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer_id uuid;
  v_appt appointments%rowtype;
begin
  select id into v_customer_id from customers where auth_user_id = auth.uid();
  select * into v_appt from appointments
    where id = p_appointment_id and customer_id = v_customer_id
    for update;
  if not found then
    raise exception 'not_found';
  end if;
  if v_appt.status <> 'scheduled' or v_appt.scheduled_start <= now() + interval '1 hour' then
    raise exception 'too_late';
  end if;
  update appointments
    set status = 'cancelled', cancel_reason = p_reason, cancelled_at = now(), version = version + 1
    where id = p_appointment_id;
end;
$$;

revoke execute on function cancel_appointment(uuid, cancel_reason) from public, anon;
grant execute on function cancel_appointment(uuid, cancel_reason) to authenticated;

create or replace function reschedule_appointment(p_appointment_id uuid, p_slot_start timestamptz)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer_id uuid;
  v_branch_id uuid;
  v_appt appointments%rowtype;
  v_duration int;
  v_problem text;
begin
  select id into v_customer_id from customers where auth_user_id = auth.uid();
  select branch_id into v_branch_id from appointments
    where id = p_appointment_id and customer_id = v_customer_id;
  if v_branch_id is null then
    raise exception 'not_found';
  end if;

  -- Same lock order as book_appointment (branch, then customer) so the two can't deadlock.
  perform pg_advisory_xact_lock(hashtextextended('appointments:branch:' || v_branch_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('appointments:customer:' || v_customer_id::text, 0));

  select * into v_appt from appointments where id = p_appointment_id for update;
  if v_appt.status <> 'scheduled' or v_appt.scheduled_start <= now() + interval '1 hour' then
    raise exception 'too_late';
  end if;

  v_problem := appointment_slot_problem(
    v_appt.branch_service_id, v_appt.preferred_barber_id, p_slot_start, v_customer_id, v_appt.id
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
        version = version + 1
    where id = p_appointment_id;
end;
$$;

revoke execute on function reschedule_appointment(uuid, timestamptz) from public, anon;
grant execute on function reschedule_appointment(uuid, timestamptz) to authenticated;
