-- Appointments part 2: staff actions (reschedule, cancel, check-in, no-show) and reads (branch day
-- list, single appointment, barber's own today list). Every action re-checks capability + scope.

-- Locks and loads an appointment the caller may manage; raises not_found / not_allowed /
-- already_converted / too_late as appropriate. Internal only.
create or replace function staff_lock_appointment(p_appointment_id uuid)
returns appointments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_appt appointments%rowtype;
begin
  select * into v_appt from appointments where id = p_appointment_id for update;
  if not found then
    raise exception 'not_found';
  end if;
  if not (has_capability('edit_tickets') and in_branch_scope(v_appt.branch_id)) then
    raise exception 'not_allowed';
  end if;
  if v_appt.status = 'converted' then
    raise exception 'already_converted';
  end if;
  if v_appt.status not in ('scheduled', 'checked_in') then
    raise exception 'too_late';
  end if;
  return v_appt;
end;
$$;

revoke execute on function staff_lock_appointment(uuid) from public, anon, authenticated;

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
        version = version + 1
    where id = p_appointment_id;
end;
$$;

revoke execute on function staff_reschedule_appointment(uuid, timestamptz) from public, anon;
grant execute on function staff_reschedule_appointment(uuid, timestamptz) to authenticated;

create or replace function staff_cancel_appointment(p_appointment_id uuid, p_reason cancel_reason)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_reason = 'branch_closed' then
    raise exception 'not_allowed';
  end if;
  perform staff_lock_appointment(p_appointment_id);
  update appointments
    set status = 'cancelled', cancel_reason = p_reason, cancelled_at = now(), version = version + 1
    where id = p_appointment_id;
end;
$$;

revoke execute on function staff_cancel_appointment(uuid, cancel_reason) from public, anon;
grant execute on function staff_cancel_appointment(uuid, cancel_reason) to authenticated;

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
  update appointments
    set status = 'checked_in', checked_in_at = now(), version = version + 1
    where id = p_appointment_id;
end;
$$;

revoke execute on function staff_check_in_appointment(uuid) from public, anon;
grant execute on function staff_check_in_appointment(uuid) to authenticated;

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
    raise exception 'too_late';
  end if;
  update appointments set status = 'no_show', version = version + 1 where id = p_appointment_id;
end;
$$;

revoke execute on function staff_mark_appointment_no_show(uuid) from public, anon;
grant execute on function staff_mark_appointment_no_show(uuid) to authenticated;

-- One row builder for the day list and the single read. Internal only (callers check scope).
create or replace function appointment_staff_rows(p_branch_id uuid, p_date date, p_appointment_id uuid)
returns table (
  id uuid, branch_id uuid, branch_name text, branch_service_id uuid, service_name text,
  price_ghs numeric, scheduled_start timestamptz, scheduled_end timestamptz,
  status appointment_status, customer_id uuid, customer_name text, customer_phone text,
  preferred_barber_id uuid, barber_name text, created_by ticket_created_by,
  created_by_staff_name text, checked_in_at timestamptz, ticket_id uuid
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.id, a.branch_id, br.name, a.branch_service_id, s.name, p.price_ghs,
         a.scheduled_start, a.scheduled_end, a.status, a.customer_id, c.name, c.phone_e164,
         a.preferred_barber_id, bsu.name, a.created_by, csu.name, a.checked_in_at,
         (select qt.id from queue_tickets qt where qt.appointment_id = a.id
          order by qt.created_at desc limit 1)
  from appointments a
  join branches br on br.id = a.branch_id
  join branch_services bs on bs.id = a.branch_service_id
  join services s on s.id = bs.service_id
  join customers c on c.id = a.customer_id
  left join current_branch_service_price p on p.branch_service_id = a.branch_service_id
  left join barbers b on b.id = a.preferred_barber_id
  left join staff_users bsu on bsu.id = b.staff_user_id
  left join staff_users csu on csu.id = a.created_by_staff_id
  where (p_appointment_id is not null and a.id = p_appointment_id)
     or (p_appointment_id is null and a.branch_id = p_branch_id
         and (a.scheduled_start at time zone 'UTC')::date = p_date)
  order by a.scheduled_start;
$$;

revoke execute on function appointment_staff_rows(uuid, date, uuid) from public, anon, authenticated;

create or replace function list_branch_appointments(p_branch_id uuid, p_date date)
returns table (
  id uuid, branch_id uuid, branch_name text, branch_service_id uuid, service_name text,
  price_ghs numeric, scheduled_start timestamptz, scheduled_end timestamptz,
  status appointment_status, customer_id uuid, customer_name text, customer_phone text,
  preferred_barber_id uuid, barber_name text, created_by ticket_created_by,
  created_by_staff_name text, checked_in_at timestamptz, ticket_id uuid
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not (has_capability('edit_tickets') and in_branch_scope(p_branch_id)) then
    raise exception 'not_allowed';
  end if;
  return query select * from appointment_staff_rows(p_branch_id, p_date, null);
end;
$$;

revoke execute on function list_branch_appointments(uuid, date) from public, anon;
grant execute on function list_branch_appointments(uuid, date) to authenticated;

create or replace function get_branch_appointment(p_appointment_id uuid)
returns table (
  id uuid, branch_id uuid, branch_name text, branch_service_id uuid, service_name text,
  price_ghs numeric, scheduled_start timestamptz, scheduled_end timestamptz,
  status appointment_status, customer_id uuid, customer_name text, customer_phone text,
  preferred_barber_id uuid, barber_name text, created_by ticket_created_by,
  created_by_staff_name text, checked_in_at timestamptz, ticket_id uuid
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_branch_id uuid;
begin
  select a.branch_id into v_branch_id from appointments a where a.id = p_appointment_id;
  if v_branch_id is null then
    return;
  end if;
  if not (has_capability('edit_tickets') and in_branch_scope(v_branch_id)) then
    raise exception 'not_allowed';
  end if;
  return query select * from appointment_staff_rows(null, null, p_appointment_id);
end;
$$;

revoke execute on function get_branch_appointment(uuid) from public, anon;
grant execute on function get_branch_appointment(uuid) to authenticated;

-- A barber's own appointments today (scheduled / checked in), first names only.
create or replace function list_my_appointments_today()
returns table (id uuid, scheduled_start timestamptz, customer_first_name text, status appointment_status)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.id, a.scheduled_start, split_part(trim(c.name), ' ', 1), a.status
  from appointments a
  join barbers b on b.id = a.preferred_barber_id
  join customers c on c.id = a.customer_id
  where b.staff_user_id = auth_staff_id()
    and a.status in ('scheduled', 'checked_in')
    and (a.scheduled_start at time zone 'UTC')::date = (now() at time zone 'UTC')::date
  order by a.scheduled_start;
$$;

revoke execute on function list_my_appointments_today() from public, anon;
grant execute on function list_my_appointments_today() to authenticated;
