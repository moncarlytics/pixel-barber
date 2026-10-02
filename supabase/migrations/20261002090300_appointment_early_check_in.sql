-- Appointments part 3, Section 2 (Docs/superpowers/specs/2026-10-02-appointments-reminders-checkin-wait-design.md):
-- early check-in. The customer's "I've arrived" (from 30 minutes before) and staff Check in start
-- the appointment at once when its barber is free; otherwise it is 'checked_in' and converts at
-- its slot. Conversion moves into convert_appointment so both paths share it.

alter table appointments add column check_in_method check_in_method;

-- Converts one appointment into a ticket (or attaches it to the customer's active ticket at the
-- branch). p_barber_id, when given, is used instead of find_eligible_barber's choice. Returns the
-- ticket id, or null when it could not convert (closed branch -> cancelled; nobody eligible or the
-- existing ticket already carries an appointment -> left as is). Behaviour otherwise identical to
-- the per-appointment body of 20261001090900_appointments_checked_in_conversion.sql, except the
-- ticket's check-in method comes from the appointment ('staff' for rows checked in before the
-- column existed).
create or replace function convert_appointment(p_appointment_id uuid, p_barber_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_appt appointments%rowtype;
  v_existing record;
  v_elig record;
  v_barber uuid;
  v_ticket_id uuid;
  v_rows integer;
  v_today date := (now() at time zone 'UTC')::date;
  v_method check_in_method;
begin
  select * into v_appt from appointments where id = p_appointment_id for update;
  if not found or v_appt.status not in ('scheduled', 'checked_in') then
    return null;
  end if;
  v_method := case when v_appt.status = 'checked_in'
                   then coalesce(v_appt.check_in_method, 'staff') end;

  -- Branch closed today: cancel, no ticket.
  if exists (select 1 from branch_closures c where c.branch_id = v_appt.branch_id and c.closure_date = v_today)
     or exists (select 1 from branches b where b.id = v_appt.branch_id and b.is_temporarily_closed) then
    update appointments
      set status = 'cancelled', cancel_reason = 'branch_closed', cancelled_at = now(),
          version = version + 1
      where id = v_appt.id;
    return null;
  end if;

  -- Already has an active ticket here (one per customer per branch): that ticket takes the
  -- appointment, and with it the appointment priority.
  select id, assigned_barber_id into v_existing
  from queue_tickets
  where customer_id = v_appt.customer_id
    and branch_id = v_appt.branch_id
    and state not in ('completed','cancelled','no_show')
  limit 1;
  if found then
    update queue_tickets set appointment_id = v_appt.id
      where id = v_existing.id and appointment_id is null;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      return null;
    end if;
    if v_method is not null then
      update queue_tickets
        set checked_in_at = coalesce(checked_in_at, v_appt.checked_in_at),
            check_in_method = coalesce(check_in_method, v_method)
        where id = v_existing.id;
    end if;
    insert into queue_events (ticket_id, event_type, actor_type, after_state)
      values (v_existing.id, 'appointment_attached', 'system',
              jsonb_build_object('appointment_id', v_appt.id));
    update appointments set status = 'converted', version = version + 1 where id = v_appt.id;
    if v_existing.assigned_barber_id is not null then
      perform recalculate_positions(v_appt.branch_id, v_existing.assigned_barber_id);
    end if;
    return v_existing.id;
  end if;

  if p_barber_id is not null then
    v_barber := p_barber_id;
  else
    select * into v_elig
    from find_eligible_barber(v_appt.branch_id, v_appt.branch_service_id, v_appt.preferred_barber_id);
    if v_appt.preferred_barber_id is not null and v_elig.preferred_eligible then
      v_barber := v_appt.preferred_barber_id;
    else
      v_barber := v_elig.fallback_barber_id;
    end if;
  end if;
  if v_barber is null then
    return null;
  end if;

  insert into queue_tickets (
    ticket_number, branch_id, customer_id, branch_service_id, preferred_barber_id,
    assigned_barber_id, is_pooled, appointment_id, state, created_by,
    checked_in_at, check_in_method
  ) values (
    next_ticket_number(v_appt.branch_id), v_appt.branch_id, v_appt.customer_id,
    v_appt.branch_service_id, v_appt.preferred_barber_id,
    v_barber, false, v_appt.id, 'waiting', 'appointment_conversion',
    case when v_method is not null then v_appt.checked_in_at end,
    v_method
  )
  returning id into v_ticket_id;

  insert into queue_events (ticket_id, event_type, actor_type, after_state)
    values (v_ticket_id, 'created', 'system',
            jsonb_build_object('state', 'waiting', 'appointment_id', v_appt.id));

  update appointments set status = 'converted', version = version + 1 where id = v_appt.id;

  perform recalculate_positions(v_appt.branch_id, v_barber);
  return v_ticket_id;
end;
$$;

revoke execute on function convert_appointment(uuid, uuid) from public, anon, authenticated;

-- Slot-time conversion: expire slots already over, convert the rest.
create or replace function activate_due_appointments() returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_appt appointments%rowtype;
  v_count integer := 0;
begin
  for v_appt in
    select * from appointments
    where status in ('scheduled', 'checked_in') and scheduled_start <= now()
    order by scheduled_start
    for update skip locked
  loop
    begin
      -- Slot already over (also bounds any backlog after a cron outage): expire it.
      if v_appt.scheduled_end < now() then
        update appointments
          set status = 'cancelled', cancel_reason = 'other', cancelled_at = now(),
              version = version + 1
          where id = v_appt.id;
        continue;
      end if;
      if convert_appointment(v_appt.id) is not null then
        v_count := v_count + 1;
      end if;
    exception when others then
      raise warning 'activate_due_appointments: appointment % failed: %', v_appt.id, sqlerrm;
    end;
  end loop;
  return v_count;
end;
$$;

revoke execute on function activate_due_appointments() from public, anon, authenticated;
grant execute on function activate_due_appointments() to service_role;

-- A barber who could take this appointment right now with nobody waiting: on today's schedule at
-- the branch inside the shift, skilled, 'available', and with no active tickets there. The
-- preferred barber only, when there is one; for "any barber", the first by id. Null when none.
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
  order by b.id
  limit 1;
$$;

revoke execute on function free_barber_for_appointment(uuid) from public, anon, authenticated;

-- The customer's "I've arrived". Returns the ticket id when the appointment started now, else null.
create or replace function check_in_my_appointment(p_appointment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer_id uuid;
  v_appt appointments%rowtype;
  v_today date := (now() at time zone 'UTC')::date;
  v_barber uuid;
begin
  select id into v_customer_id from customers where auth_user_id = auth.uid();
  select * into v_appt from appointments
  where id = p_appointment_id and customer_id = v_customer_id
  for update;
  if not found then
    raise exception 'not_found';
  end if;
  if v_appt.status <> 'scheduled' then
    raise exception 'too_late';
  end if;
  if now() < v_appt.scheduled_start - interval '30 minutes' then
    raise exception 'too_early';
  end if;
  if exists (select 1 from branch_closures c where c.branch_id = v_appt.branch_id and c.closure_date = v_today)
     or exists (select 1 from branches b where b.id = v_appt.branch_id and b.is_temporarily_closed) then
    raise exception 'branch_closed';
  end if;

  update appointments
    set status = 'checked_in', checked_in_at = now(), check_in_method = 'app_tap',
        version = version + 1
    where id = p_appointment_id;

  v_barber := free_barber_for_appointment(p_appointment_id);
  if v_barber is null then
    return null;
  end if;
  return convert_appointment(p_appointment_id, v_barber);
end;
$$;

revoke execute on function check_in_my_appointment(uuid) from public, anon;
grant execute on function check_in_my_appointment(uuid) to authenticated;

-- Staff Check in: same checks as 20261001091000_appointments_staff_final_fixes.sql, now recording
-- the method and starting the appointment at once when the barber is free. Returns the ticket id
-- when it started now, else null (the return type changes, so drop and recreate).
drop function staff_check_in_appointment(uuid);

create function staff_check_in_appointment(p_appointment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_appt appointments%rowtype;
  v_barber uuid;
begin
  v_appt := staff_lock_appointment(p_appointment_id);
  if v_appt.status <> 'scheduled' then
    raise exception 'too_late';
  end if;
  if (v_appt.scheduled_start at time zone 'UTC')::date <> (now() at time zone 'UTC')::date then
    raise exception 'not_today';
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
