-- Appointments part 3, final fixes. Replaces functions from 20261002090000_wait_estimates.sql and
-- 20261002090300_appointment_early_check_in.sql (same signatures, grants unchanged).

-- A barber is free for early check-in only if, beyond today's rules: their staff account is active
-- (as find_eligible_barber requires), and no other appointment for them at the branch is booked to
-- start before this appointment's expected service would end (a customer booked sooner is not
-- pushed back).
create or replace function free_barber_for_appointment(p_appointment_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select b.id
  from appointments a
  join branch_services bs on bs.id = a.branch_service_id
  join barbers b on (a.preferred_barber_id is null or b.id = a.preferred_barber_id)
  join staff_users su on su.id = b.staff_user_id and su.is_active and su.invite_status = 'accepted'
  join barber_skills sk on sk.barber_id = b.id and sk.service_id = bs.service_id
  join barber_schedule sch on sch.barber_id = b.id
    and sch.work_date = (now() at time zone 'UTC')::date
    and sch.branch_id = a.branch_id
    and (now() at time zone 'UTC')::time between sch.shift_start and sch.shift_end
  where a.id = p_appointment_id
    and b.status = 'available'
    and not exists (
      select 1 from queue_tickets qt
      where qt.assigned_barber_id = b.id
        and qt.branch_id = a.branch_id
        and qt.state in ('waiting', 'almost_turn', 'called', 'confirmed', 'in_service', 'grace_period')
    )
    and not exists (
      select 1 from appointments o
      where o.id <> a.id
        and o.branch_id = a.branch_id
        and o.status in ('scheduled', 'checked_in')
        and o.preferred_barber_id = b.id
        and o.scheduled_start < now()
          + make_interval(mins => (select d.minutes from expected_duration_min(b.id, a.branch_service_id) d))
    )
  order by b.id
  limit 1;
$$;

revoke execute on function free_barber_for_appointment(uuid) from public, anon, authenticated;

-- Staff Check in: as before, plus 'branch_closed' on a closed-branch day (instead of a free barber
-- making convert_appointment cancel the appointment silently).
create or replace function staff_check_in_appointment(p_appointment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_appt appointments%rowtype;
  v_barber uuid;
  v_today date := (now() at time zone 'UTC')::date;
begin
  v_appt := staff_lock_appointment(p_appointment_id);
  if v_appt.status <> 'scheduled' then
    raise exception 'too_late';
  end if;
  if (v_appt.scheduled_start at time zone 'UTC')::date <> v_today then
    raise exception 'not_today';
  end if;
  if exists (select 1 from branch_closures c where c.branch_id = v_appt.branch_id and c.closure_date = v_today)
     or exists (select 1 from branches b where b.id = v_appt.branch_id and b.is_temporarily_closed) then
    raise exception 'branch_closed';
  end if;
  update appointments
    set status = 'checked_in', checked_in_at = now(), check_in_method = 'staff',
        version = version + 1
    where id = p_appointment_id;

  v_barber := free_barber_for_appointment(p_appointment_id);
  if v_barber is null then
    return null;
  end if;
  return convert_appointment(p_appointment_id, v_barber);
end;
$$;

revoke execute on function staff_check_in_appointment(uuid) from public, anon;
grant execute on function staff_check_in_appointment(uuid) to authenticated;

-- One failing barber line must not skip the rest.
create or replace function refresh_all_wait_estimates()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
begin
  for r in
    select distinct branch_id, assigned_barber_id
    from queue_tickets
    where state in ('waiting', 'almost_turn') and assigned_barber_id is not null
  loop
    begin
      perform refresh_wait_estimates(r.branch_id, r.assigned_barber_id);
    exception when others then
      raise warning 'refresh_all_wait_estimates: barber % at branch % failed: %',
        r.assigned_barber_id, r.branch_id, sqlerrm;
    end;
  end loop;
end;
$$;

revoke execute on function refresh_all_wait_estimates() from public, anon, authenticated;
grant execute on function refresh_all_wait_estimates() to service_role;

-- The clearing update in refresh_wait_estimates otherwise scans the barber's whole history.
create index if not exists idx_queue_tickets_estimated_barber
  on queue_tickets (assigned_barber_id) where estimated_wait_low_min is not null;
