-- Appointments staff side: activate_due_appointments also converts 'checked_in' appointments.
-- The resulting ticket (new or existing) is already marked present: checked_in_at carries the
-- appointment's check-in time and check_in_method is 'staff'. The branch active-appointments index
-- now covers 'checked_in'.

create or replace function activate_due_appointments() returns integer
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

      -- Branch closed today: cancel, no ticket.
      if exists (select 1 from branch_closures c where c.branch_id = v_appt.branch_id and c.closure_date = v_today)
         or exists (select 1 from branches b where b.id = v_appt.branch_id and b.is_temporarily_closed) then
        update appointments
          set status = 'cancelled', cancel_reason = 'branch_closed', cancelled_at = now(),
              version = version + 1
          where id = v_appt.id;
        continue;
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
        if v_rows = 1 then
          if v_appt.status = 'checked_in' then
            update queue_tickets
              set checked_in_at = coalesce(checked_in_at, v_appt.checked_in_at),
                  check_in_method = coalesce(check_in_method, 'staff')
              where id = v_existing.id;
          end if;
          insert into queue_events (ticket_id, event_type, actor_type, after_state)
            values (v_existing.id, 'appointment_attached', 'system',
                    jsonb_build_object('appointment_id', v_appt.id));
          update appointments set status = 'converted', version = version + 1 where id = v_appt.id;
          if v_existing.assigned_barber_id is not null then
            perform recalculate_positions(v_appt.branch_id, v_existing.assigned_barber_id);
          end if;
          v_count := v_count + 1;
        end if;
        -- v_rows = 0: the ticket already carries another appointment; stay 'scheduled' and retry
        -- (expiry cancels it after its slot).
        continue;
      end if;

      -- Barber: the preferred one if find_eligible_barber says they can take the customer now;
      -- otherwise its fallback. Nobody eligible: stay 'scheduled', the next run retries.
      select * into v_elig
      from find_eligible_barber(v_appt.branch_id, v_appt.branch_service_id, v_appt.preferred_barber_id);
      if v_appt.preferred_barber_id is not null and v_elig.preferred_eligible then
        v_barber := v_appt.preferred_barber_id;
      else
        v_barber := v_elig.fallback_barber_id;
      end if;
      if v_barber is null then
        continue;
      end if;

      insert into queue_tickets (
        ticket_number, branch_id, customer_id, branch_service_id, preferred_barber_id,
        assigned_barber_id, is_pooled, appointment_id, state, created_by,
        checked_in_at, check_in_method
      ) values (
        next_ticket_number(v_appt.branch_id), v_appt.branch_id, v_appt.customer_id,
        v_appt.branch_service_id, v_appt.preferred_barber_id,
        v_barber, false, v_appt.id, 'waiting', 'appointment_conversion',
        case when v_appt.status = 'checked_in' then v_appt.checked_in_at end,
        case when v_appt.status = 'checked_in' then 'staff'::check_in_method end
      )
      returning id into v_ticket_id;

      insert into queue_events (ticket_id, event_type, actor_type, after_state)
        values (v_ticket_id, 'created', 'system',
                jsonb_build_object('state', 'waiting', 'appointment_id', v_appt.id));

      update appointments set status = 'converted', version = version + 1 where id = v_appt.id;

      perform recalculate_positions(v_appt.branch_id, v_barber);
      v_count := v_count + 1;
    exception when others then
      raise warning 'activate_due_appointments: appointment % failed: %', v_appt.id, sqlerrm;
    end;
  end loop;
  return v_count;
end;
$$;

revoke execute on function activate_due_appointments() from public, anon, authenticated;
grant execute on function activate_due_appointments() to service_role;

drop index if exists idx_appointments_branch_active_start;
create index idx_appointments_branch_active_start on appointments (branch_id, scheduled_start)
  where status in ('scheduled', 'checked_in', 'converted');
