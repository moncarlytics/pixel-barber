-- Appointments part 1: due appointments become queue tickets that are served next, and the
-- appointment's status follows its ticket. Replaces the Phase 1 placeholder cron job body.

-- Called ticket first, then un-skipped appointment tickets by their slot time, then the existing
-- order. Identical to 20260925130000_youre_next_notifications.sql's definition otherwise.
create or replace function recalculate_positions(p_branch_id uuid, p_barber_id uuid) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reentrant boolean;
  v_ticket record;
  v_new_state ticket_state;
begin
  v_reentrant := coalesce(current_setting('pixelbarber.recalc_in_progress', true), 'false') = 'true';
  if v_reentrant then
    return;
  end if;
  perform set_config('pixelbarber.recalc_in_progress', 'true', true);

  with ranked as (
    select qt.id, row_number() over (
      order by
        case
          when qt.state = 'called' then 0
          when qt.appointment_id is not null and qt.skipped_at is null then 1
          else 2
        end,
        case when qt.skipped_at is null then a.scheduled_start end nulls last,
        coalesce(qt.skipped_at, '-infinity'::timestamptz),
        qt.created_at
    ) as rn
    from queue_tickets qt
    left join appointments a on a.id = qt.appointment_id
    where qt.branch_id = p_branch_id
      and (
        (
          qt.state in ('waiting','almost_turn')
          and (p_barber_id is null or qt.assigned_barber_id = p_barber_id or (qt.assigned_barber_id is null and qt.is_pooled))
        )
        or (qt.state = 'called' and p_barber_id is not null and qt.assigned_barber_id = p_barber_id)
      )
  )
  update queue_tickets qt set position = ranked.rn
  from ranked
  where qt.id = ranked.id
    and qt.position is distinct from ranked.rn;

  if p_barber_id is not null then
    for v_ticket in
      select id, customer_id, state, position
      from queue_tickets
      where branch_id = p_branch_id
        and assigned_barber_id = p_barber_id
        and state in ('waiting','almost_turn','called')
        and position is not null
    loop
      v_new_state := case
        when v_ticket.position = 1 then 'called'
        when v_ticket.position = 2 then 'almost_turn'
        else 'waiting'
      end;
      if v_new_state is distinct from v_ticket.state then
        update queue_tickets
          set state = v_new_state,
              called_at = case when v_new_state = 'called' then now() else called_at end
          where id = v_ticket.id;
        if v_new_state = 'called' then
          insert into notifications (recipient_type, recipient_id, channel, notification_type, related_ticket_id, payload)
            values ('customer', v_ticket.customer_id, 'sms', 'your_turn', v_ticket.id, '{}'::jsonb);
        elsif v_new_state = 'almost_turn' then
          insert into notifications (recipient_type, recipient_id, channel, notification_type, related_ticket_id, payload)
            values ('customer', v_ticket.customer_id, 'sms', 'youre_next', v_ticket.id, '{}'::jsonb)
            on conflict (related_ticket_id) where notification_type = 'youre_next' do nothing;
        end if;
      end if;
    end loop;
  end if;

  perform set_config('pixelbarber.recalc_in_progress', 'false', true);
end;
$$;

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
  v_today date := (now() at time zone 'UTC')::date;
  v_count integer := 0;
begin
  for v_appt in
    select * from appointments
    where status = 'scheduled' and scheduled_start <= now()
    order by scheduled_start
    for update skip locked
  loop
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
      update appointments set status = 'converted', version = version + 1 where id = v_appt.id;
      if v_existing.assigned_barber_id is not null then
        perform recalculate_positions(v_appt.branch_id, v_existing.assigned_barber_id);
      end if;
      v_count := v_count + 1;
      continue;
    end if;

    -- Barber: the preferred one while their account is active/accepted and they aren't offline;
    -- otherwise whoever joining the queue would get (find_eligible_barber's fallback). Pooled only
    -- if nobody is eligible at all.
    v_barber := null;
    if v_appt.preferred_barber_id is not null and exists (
      select 1 from barbers b join staff_users su on su.id = b.staff_user_id
      where b.id = v_appt.preferred_barber_id
        and su.is_active and su.invite_status = 'accepted'
        and b.status <> 'offline'
    ) then
      v_barber := v_appt.preferred_barber_id;
    else
      select * into v_elig
      from find_eligible_barber(v_appt.branch_id, v_appt.branch_service_id, null);
      v_barber := v_elig.fallback_barber_id;
    end if;

    insert into queue_tickets (
      ticket_number, branch_id, customer_id, branch_service_id, preferred_barber_id,
      assigned_barber_id, is_pooled, appointment_id, state, created_by
    ) values (
      next_ticket_number(v_appt.branch_id), v_appt.branch_id, v_appt.customer_id,
      v_appt.branch_service_id, v_appt.preferred_barber_id,
      v_barber, v_barber is null, v_appt.id, 'waiting', 'appointment_conversion'
    )
    returning id into v_ticket_id;

    insert into queue_events (ticket_id, event_type, actor_type, after_state)
      values (v_ticket_id, 'created', 'system',
              jsonb_build_object('state', 'waiting', 'appointment_id', v_appt.id));

    update appointments set status = 'converted', version = version + 1 where id = v_appt.id;

    if v_barber is not null then
      perform recalculate_positions(v_appt.branch_id, v_barber);
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke execute on function activate_due_appointments() from public, anon, authenticated;
grant execute on function activate_due_appointments() to service_role;

-- Same job name: cron.schedule replaces the Phase 1 placeholder (which converted 5 minutes early
-- and wrote no queue_events row).
select cron.schedule('activate-due-appointments', '* * * * *', 'select activate_due_appointments()');

-- The appointment follows its ticket's terminal states.
create or replace function trg_sync_appointment_status() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.appointment_id is not null and new.state is distinct from old.state then
    if new.state = 'no_show' then
      update appointments set status = 'no_show', version = version + 1
        where id = new.appointment_id and status = 'converted';
    elsif new.state = 'completed' then
      update appointments set status = 'completed', version = version + 1
        where id = new.appointment_id and status = 'converted';
    elsif new.state = 'cancelled' then
      update appointments
        set status = 'cancelled', cancel_reason = coalesce(new.cancel_reason, 'other'),
            cancelled_at = now(), version = version + 1
        where id = new.appointment_id and status = 'converted';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function trg_sync_appointment_status() from public, anon, authenticated;

drop trigger if exists after_ticket_state_sync_appointment on queue_tickets;
create trigger after_ticket_state_sync_appointment after update of state on queue_tickets
  for each row execute function trg_sync_appointment_status();
