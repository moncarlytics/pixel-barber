-- Appointments part 1 (Docs/superpowers/specs/2026-10-01-appointments-customer-booking-design.md):
-- one rule-checker shared by slot listing, booking and rescheduling, so they can never disagree.

-- Returns null when the slot is open, otherwise the error string the app shows. Internal only.
create or replace function appointment_slot_problem(
  p_branch_service_id uuid,
  p_barber_id uuid,
  p_slot_start timestamptz,
  p_customer_id uuid,
  p_ignore_appointment_id uuid
) returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_branch_id uuid;
  v_service_id uuid;
  v_active boolean;
  v_duration int;
  v_end timestamptz;
  v_date date;
  v_start_t time;
  v_end_t time;
  v_suitable_free int;
  v_pool int;
  v_any int;
begin
  select bs.branch_id, bs.service_id, bs.is_active,
         coalesce(bs.duration_minutes_override, s.default_duration_minutes)
    into v_branch_id, v_service_id, v_active, v_duration
  from branch_services bs
  join services s on s.id = bs.service_id
  where bs.id = p_branch_service_id;
  if v_branch_id is null or not v_active then
    return 'service_unavailable';
  end if;

  v_end := p_slot_start + make_interval(mins => v_duration);
  v_date := (p_slot_start at time zone 'UTC')::date;
  v_start_t := (p_slot_start at time zone 'UTC')::time;
  v_end_t := (v_end at time zone 'UTC')::time;

  if p_slot_start < now() + interval '1 hour' then
    return 'too_soon';
  end if;
  if v_date > (now() at time zone 'UTC')::date + 14 then
    return 'too_far_ahead';
  end if;
  -- Off the 30-minute grid, or running past midnight: never a real slot.
  if extract(epoch from p_slot_start)::bigint % 1800 <> 0
     or (v_end at time zone 'UTC')::date <> v_date then
    return 'slot_taken';
  end if;

  if not exists (
       select 1 from branch_hours h
       where h.branch_id = v_branch_id
         and h.day_of_week = extract(dow from v_date)
         and not h.is_closed
         and h.opens_at <= v_start_t
         and h.closes_at >= v_end_t
     )
     or exists (
       select 1 from branch_closures c where c.branch_id = v_branch_id and c.closure_date = v_date
     )
     or (
       v_date = (now() at time zone 'UTC')::date
       and exists (select 1 from branches b where b.id = v_branch_id and b.is_temporarily_closed)
     ) then
    return 'branch_closed';
  end if;

  if p_customer_id is not null and exists (
    select 1 from appointments a
    where a.customer_id = p_customer_id
      and a.status = 'scheduled'
      and (a.scheduled_start at time zone 'UTC')::date = v_date
      and a.id is distinct from p_ignore_appointment_id
  ) then
    return 'already_booked_that_day';
  end if;

  -- Barbers working at this branch through the whole slot (any skill), excluding any barber named
  -- on an overlapping active appointment. "Suitable" ones are also skilled for this service (and,
  -- for a named booking, are the named barber).
  with overlapping as (
    select a.preferred_barber_id
    from appointments a
    where a.branch_id = v_branch_id
      and a.status in ('scheduled', 'converted')
      and a.scheduled_start < v_end
      and a.scheduled_end > p_slot_start
      and a.id is distinct from p_ignore_appointment_id
  ),
  working as (
    select b.id,
           exists (
             select 1 from barber_skills sk where sk.barber_id = b.id and sk.service_id = v_service_id
           ) as skilled
    from barbers b
    join staff_users su on su.id = b.staff_user_id
    join barber_schedule sch on sch.barber_id = b.id
    where su.is_active
      and su.invite_status = 'accepted'
      and sch.work_date = v_date
      and sch.branch_id = v_branch_id
      and sch.shift_start <= v_start_t
      and sch.shift_end >= v_end_t
      and not (
        sch.break_start is not null and sch.break_end is not null
        and sch.break_start < v_end_t and sch.break_end > v_start_t
      )
      and b.id not in (
        select o.preferred_barber_id from overlapping o where o.preferred_barber_id is not null
      )
  )
  select count(*) filter (where skilled and (p_barber_id is null or id = p_barber_id)),
         count(*)
    into v_suitable_free, v_pool
  from working;
  select count(*) into v_any from overlapping where preferred_barber_id is null;

  if v_suitable_free = 0 then
    return 'slot_taken';
  end if;
  if p_barber_id is null and v_pool <= v_any then
    return 'slot_taken';
  end if;
  if p_barber_id is not null and v_pool - 1 < v_any then
    return 'slot_taken';
  end if;
  return null;
end;
$$;

revoke execute on function appointment_slot_problem(uuid, uuid, timestamptz, uuid, uuid)
  from public, anon, authenticated;

create or replace function list_appointment_slots(
  p_branch_service_id uuid,
  p_barber_id uuid,
  p_date date
) returns setof timestamptz
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer_id uuid;
begin
  select id into v_customer_id from customers where auth_user_id = auth.uid();
  return query
    select slot
    from generate_series(
      p_date::timestamp at time zone 'UTC',
      (p_date::timestamp + interval '23 hours 30 minutes') at time zone 'UTC',
      interval '30 minutes'
    ) as slot
    where appointment_slot_problem(p_branch_service_id, p_barber_id, slot, v_customer_id, null) is null
    order by slot;
end;
$$;

revoke execute on function list_appointment_slots(uuid, uuid, date) from public, anon;
grant execute on function list_appointment_slots(uuid, uuid, date) to authenticated;

create or replace function book_appointment(
  p_branch_service_id uuid,
  p_barber_id uuid,
  p_slot_start timestamptz
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer_id uuid;
  v_branch_id uuid;
  v_duration int;
  v_problem text;
  v_id uuid;
begin
  select id into v_customer_id from customers where auth_user_id = auth.uid();
  if v_customer_id is null then
    raise exception 'not_a_customer';
  end if;
  select bs.branch_id, coalesce(bs.duration_minutes_override, s.default_duration_minutes)
    into v_branch_id, v_duration
  from branch_services bs join services s on s.id = bs.service_id
  where bs.id = p_branch_service_id;
  if v_branch_id is null then
    raise exception 'service_unavailable';
  end if;

  -- Serialize bookings per branch (slot capacity) and per customer (one per day across branches).
  perform pg_advisory_xact_lock(hashtextextended('appointments:branch:' || v_branch_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('appointments:customer:' || v_customer_id::text, 0));

  v_problem := appointment_slot_problem(p_branch_service_id, p_barber_id, p_slot_start, v_customer_id, null);
  if v_problem is not null then
    raise exception '%', v_problem;
  end if;

  insert into appointments (
    customer_id, branch_id, branch_service_id, preferred_barber_id,
    scheduled_start, scheduled_end, status, created_by
  ) values (
    v_customer_id, v_branch_id, p_branch_service_id, p_barber_id,
    p_slot_start, p_slot_start + make_interval(mins => v_duration), 'scheduled', 'customer'
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function book_appointment(uuid, uuid, timestamptz) from public, anon;
grant execute on function book_appointment(uuid, uuid, timestamptz) to authenticated;

-- Customers now write appointments only through the functions above (and cancel/reschedule).
drop policy if exists appointments_customer_create on appointments;
drop policy if exists appointments_customer_update_own on appointments;
